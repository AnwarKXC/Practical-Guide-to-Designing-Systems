# Chapter 26: Read/Write Splitting — Two Doors, One Room

## One Database, One Connection, One Problem

In every CRUD app you have ever built, your database configuration probably looks like this:

```typescript
// The "one connection to rule them all" pattern
const db = new Pool({
  host: 'db-primary.internal',
  port: 3306,
  database: 'booking_system',
  user: 'app_user',
  password: process.env.DB_PASSWORD,
  connectionLimit: 50,
});

// Every query -- reads AND writes -- fights for the same pool
await db.query('SELECT * FROM rooms WHERE city = ?', ['Tokyo']);           // Read
await db.query('INSERT INTO bookings (...) VALUES (...)', [...]);         // Write
await db.query('SELECT * FROM bookings WHERE user_id = ?', [userId]);     // Read
await db.query('UPDATE rooms SET available = available - 1 WHERE id = ?', [roomId]); // Write
```

All four queries hit the same server. Reads and writes share the same CPU, the same disk I/O, the same connection pool, the same lock manager. At 100 requests per second, nobody notices. At 100,000 bookings per minute — 1,666 per second — your database server is doing two fundamentally different jobs at once, and doing both of them badly.

Here is why. Reads and writes have completely different workload characteristics:

| Characteristic | Read Operations | Write Operations |
|---|---|---|
| **Frequency** | 70–90% of all queries | 10–30% of all queries |
| **Lock behavior** | Shared locks (multiple reads coexist) | Exclusive locks (blocks other writes AND reads) |
| **CPU pattern** | Scanning, sorting, joining | Logging, indexing, constraint checking |
| **Disk I/O** | Sequential reads (often cached) | Random writes (must be durable) |
| **Latency tolerance** | Users expect sub-100ms | Users tolerate 200–500ms |
| **Scaling strategy** | Add more readers | Very hard to scale horizontally |
| **Failure impact** | Retry safely (idempotent) | Retry risks duplication |

The mismatch is stark. Your 70% lightweight readers are stuck behind a queue of heavyweight writers. A long-running `UPDATE` that modifies 10,000 rows holds exclusive locks that block every `SELECT` touching those same rows. Your availability search — the most common query in a booking system — stalls because someone's batch payment reconciliation is running on the same server.

> **Analogy:** Imagine a library with one desk where the librarian handles everything: checking out books, returning books, shelving new arrivals, and answering research questions. During a busy afternoon, a patron returning a stack of 20 books (a write operation) holds up the line for five minutes while the librarian processes each one. Behind that patron are 30 people who just want to ask "Do you have this book?" (read operations) — a question the librarian could answer in five seconds if the librarian were not busy shelving.
>
> The solution? Two desks. One desk handles returns and new arrivals (writes). Four other desks handle research questions (reads). The return desk has direct access to the catalog system (the primary database). The research desks have copies of the catalog (read replicas) that are updated every few seconds. Now 30 patrons get their answers without waiting for the shelving to finish.

> **What If You Skip This?** Without read/write splitting, your single database handles everything. At our scale (1,666 bookings/second with a 70/30 read-to-write ratio), the write operations that hold exclusive locks interfere with read operations that need those same rows. Connection pools fill up. P99 latency spikes. Users see "no rooms available" when rooms actually exist — the query just timed out. Adding read replicas is one of the simplest and most effective database scaling techniques, and it is exactly why every cloud provider offers "add read replica" as a one-click option.

---

## How MySQL Replication Actually Works

Before you can use read replicas effectively, you need to understand how data gets from the primary to the replicas. This is not magic. It is a well-defined pipeline involving three components: the **binary log**, the **I/O thread**, and the **SQL thread**.

### The Binary Log (binlog)

Every time the primary server processes a write (`INSERT`, `UPDATE`, `DELETE`), it records the change in a file called the **binary log** (binlog). The binlog is an append-only, ordered sequence of events. Think of it as a journal: "At 14:23:01.003, row with id=5827 was inserted into the bookings table with these values..."

MySQL supports three binlog formats:

```sql
-- Check your current binlog format
SHOW VARIABLES LIKE 'binlog_format';

-- ROW format (recommended for replication):
-- Records the actual row data that changed.
-- "Row 5827 was inserted with values (...)."
-- Pros: Deterministic. Replicas always match the primary.
-- Cons: Large binlog files for bulk operations.

-- STATEMENT format:
-- Records the SQL statement itself.
-- "INSERT INTO bookings (user_id, room_id) VALUES (42, 100)."
-- Pros: Small binlog files.
-- Cons: Non-deterministic functions (NOW(), RAND()) produce different
--        results on replicas. Dangerous.

-- MIXED format:
-- Uses STATEMENT for safe queries, ROW for non-deterministic ones.
-- A compromise, but ROW is simpler and safer.
```

For our booking system, we use **ROW-based replication**. When `100,000 bookings/minute` is on the line, determinism is not optional.

### The Replication Pipeline

Here is what happens, step by step, when you insert a booking on the primary:

```
Primary Server                               Replica Server
┌──────────────────────┐                     ┌──────────────────────┐
│                      │                     │                      │
│  1. Client sends:    │                     │                      │
│     INSERT INTO      │                     │                      │
│     bookings (...)   │                     │                      │
│                      │                     │                      │
│  2. InnoDB engine:   │                     │                      │
│     - Acquires lock  │                     │                      │
│     - Writes to      │                     │                      │
│       redo log       │                     │                      │
│     - Updates indexes│                     │                      │
│                      │                     │                      │
│  3. Writes event to  │    Network          │  4. I/O Thread:      │
│     binary log  ─────│────────────────────►│     Reads binlog     │
│     (binlog)         │    (async)          │     event from       │
│                      │                     │     primary          │
│  3a. Returns OK to   │                     │                      │
│      the client      │                     │  5. Writes event to  │
│      (write is done) │                     │     relay log        │
│                      │                     │     (local copy)     │
│                      │                     │                      │
│                      │                     │  6. SQL Thread:      │
│                      │                     │     Reads relay log  │
│                      │                     │     Applies the      │
│                      │                     │     INSERT locally   │
│                      │                     │                      │
│                      │                     │  7. Row now visible  │
│                      │                     │     on replica       │
└──────────────────────┘                     └──────────────────────┘

Timeline:
  Step 3a happens BEFORE step 7.
  The client gets "OK" before the replica has the data.
  This gap is replication lag.
```

Three critical details from this diagram:

1. **The client gets "OK" before the replica has the data.** Step 3a (returning success to the client) happens at the primary level, before the replica even starts processing. This is **asynchronous replication** — the primary does not wait for replicas to confirm.

2. **Two threads on the replica do the work.** The I/O thread pulls events from the primary's binlog over the network. The SQL thread replays those events locally. If the SQL thread falls behind (because it is busy replaying a big `ALTER TABLE`, for example), replication lag grows.

3. **The relay log is a local buffer.** The replica writes incoming events to its own relay log before applying them. This decouples "receiving the event" from "applying the event." If applying is slow, receiving can still keep up.

> **Key Term:** **Binary Log (binlog)** — An append-only log on the MySQL primary server that records every data-modifying operation. Replicas read this log to reproduce the same changes. The binlog is also used for point-in-time recovery: you can replay it to restore a database to any moment in time.

> **Key Term:** **Relay Log** — A local copy of the primary's binlog stored on each replica server. The I/O thread writes to the relay log; the SQL thread reads from it and applies changes. This two-stage pipeline prevents network latency from directly impacting replay speed.

### Semi-Synchronous Replication

Asynchronous replication has a risk: if the primary crashes after writing to its binlog but before any replica receives the event, that data is lost. For a booking system handling real money, "lost data" is unacceptable.

MySQL offers **semi-synchronous replication** as a middle ground:

```sql
-- On the primary: enable semi-sync
INSTALL PLUGIN rpl_semi_sync_master SONAME 'semisync_master.so';
SET GLOBAL rpl_semi_sync_master_enabled = 1;
SET GLOBAL rpl_semi_sync_master_timeout = 1000;  -- 1 second timeout
--                                         ^^^^
--  If no replica acknowledges within 1 second,
--  the primary falls back to async replication
--  (to avoid blocking writes indefinitely).

-- On each replica: enable semi-sync
INSTALL PLUGIN rpl_semi_sync_slave SONAME 'semisync_slave.so';
SET GLOBAL rpl_semi_sync_slave_enabled = 1;
```

With semi-sync enabled, the primary waits for **at least one replica** to confirm it received the binlog event before returning "OK" to the client. The event does not need to be *applied* on the replica — just received and written to the relay log. This guarantees that if the primary crashes, at least one replica has the data.

```
Semi-Synchronous Replication:

  Primary writes to binlog ──► Replica I/O thread receives event
                               Replica writes to relay log
                               Replica sends ACK to primary ──► Primary returns OK to client
                                                                  │
                         ┌────────────────────────────────────────┘
                         │
                         ▼
                  The client's INSERT is confirmed ONLY after
                  at least one replica has the binlog event.
                  Zero-data-loss guarantee (unless both crash simultaneously).
```

> **What If You Skip This?** With pure async replication, a primary crash can lose the most recent transactions — the ones that were committed on the primary but not yet shipped to any replica. In a booking system, that means confirmed bookings vanish. Semi-sync adds a few milliseconds of latency per write but guarantees durability across servers. For financial data, the trade-off is always worth it.

---

## Primary-Replica Architecture: Full Setup

Our booking system runs 16 MySQL shards. Each shard has **1 primary** and **4 read replicas**. That is 80 database servers total (16 primaries + 64 replicas). Here is the complete connection configuration:

```typescript
// config/database.config.ts

export interface ReplicaConfig {
  host: string;
  port: number;
  region: string;           // For multi-region awareness
  datacenter: string;       // For rack-aware routing
  weight: number;           // For weighted round-robin (higher = more traffic)
}

export interface ShardConfig {
  shardNumber: number;
  primary: {
    host: string;
    port: number;
    connectionLimit: number;
    region: string;
  };
  replicas: ReplicaConfig[];
  database: string;
  username: string;
  password: string;         // In production, fetched from AWS Secrets Manager
}

// Full configuration for Shard 0 (1 of 16 shards)
const shard0Config: ShardConfig = {
  shardNumber: 0,
  primary: {
    host: 'shard0-primary.db.internal',
    port: 3306,
    connectionLimit: 200,   // Smaller pool — writes are 30% of traffic
    region: 'us-east-1',
  },
  replicas: [
    {
      host: 'shard0-replica-1.db.internal',
      port: 3306,
      region: 'us-east-1',         // Same region as primary
      datacenter: 'us-east-1a',    // Different AZ for fault tolerance
      weight: 100,                 // Equal weight
    },
    {
      host: 'shard0-replica-2.db.internal',
      port: 3306,
      region: 'us-east-1',
      datacenter: 'us-east-1b',
      weight: 100,
    },
    {
      host: 'shard0-replica-3.db.internal',
      port: 3306,
      region: 'eu-west-1',         // Cross-region replica for European reads
      datacenter: 'eu-west-1a',
      weight: 80,                  // Slightly lower weight (higher latency)
    },
    {
      host: 'shard0-replica-4.db.internal',
      port: 3306,
      region: 'ap-southeast-1',    // Cross-region replica for Asian reads
      datacenter: 'ap-southeast-1a',
      weight: 80,
    },
  ],
  database: 'booking_shard_0',
  username: 'booking_app',
  password: '${SHARD_0_DB_PASSWORD}',  // Resolved from secrets manager
};

// Connection string format for each server:
// mysql://booking_app:${password}@shard0-primary.db.internal:3306/booking_shard_0
// mysql://booking_app:${password}@shard0-replica-1.db.internal:3306/booking_shard_0
// mysql://booking_app:${password}@shard0-replica-2.db.internal:3306/booking_shard_0
// ... and so on for all 4 replicas
```

The key insight in this configuration is the **weight** field on replicas. Cross-region replicas (in `eu-west-1` and `ap-southeast-1`) get a lower weight because network latency is higher. Our routing layer uses weighted round-robin: a replica with weight 100 receives roughly 25% more traffic than one with weight 80.

---

## The Database Schema

Before we build the routing layer, let us define the tables that this system operates on. Every query we route — whether to the primary or a replica — targets these tables.

### Raw SQL (CREATE TABLE)

```sql
-- Runs on ALL shards (both primary and replicas receive it through replication)
-- Only execute on the primary; replicas get it via binlog.

CREATE TABLE bookings (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    booking_ref     VARCHAR(20) NOT NULL,          -- Human-readable: "BK-20260215-A7X3"
    user_id         BIGINT UNSIGNED NOT NULL,       -- Shard key (userId % 16)
    room_id         BIGINT UNSIGNED NOT NULL,
    hotel_id        BIGINT UNSIGNED NOT NULL,
    check_in        DATE NOT NULL,
    check_out       DATE NOT NULL,
    total_price     DECIMAL(12,2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    status          ENUM('PENDING','CONFIRMED','CANCELLED','CHECKED_IN','CHECKED_OUT','NO_SHOW')
                      NOT NULL DEFAULT 'PENDING',
    guest_count     TINYINT UNSIGNED NOT NULL DEFAULT 1,
    special_requests TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    cancelled_at    TIMESTAMP NULL DEFAULT NULL,
    version         INT UNSIGNED NOT NULL DEFAULT 1,  -- Optimistic locking

    PRIMARY KEY (id),
    UNIQUE KEY uk_booking_ref (booking_ref),
    INDEX idx_user_status (user_id, status),           -- "Show me my confirmed bookings"
    INDEX idx_hotel_dates (hotel_id, check_in, check_out),  -- "Is this room available?"
    INDEX idx_created_at (created_at),                 -- Time-range queries for reporting
    INDEX idx_status_updated (status, updated_at)      -- Batch processing stale bookings
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci
  ROW_FORMAT=DYNAMIC;

-- Replication health tracking table (exists only on the application side,
-- not replicated — used to measure lag from the app's perspective)
CREATE TABLE replication_heartbeat (
    shard_id        INT UNSIGNED NOT NULL,
    primary_ts      TIMESTAMP(6) NOT NULL,     -- Microsecond precision
    replica_ts      TIMESTAMP(6) NULL,         -- Set by the monitoring agent on each replica
    PRIMARY KEY (shard_id)
) ENGINE=InnoDB;

-- Session routing table: tracks users who recently wrote,
-- so their reads route to the primary for consistency
CREATE TABLE recent_writers (
    user_id         BIGINT UNSIGNED NOT NULL,
    last_write_at   TIMESTAMP(3) NOT NULL,     -- Millisecond precision
    shard_id        INT UNSIGNED NOT NULL,
    PRIMARY KEY (user_id),
    INDEX idx_last_write (last_write_at)        -- For cleanup of expired entries
) ENGINE=MEMORY;                                -- In-memory for speed; lost on restart is OK
```

### Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema", "metrics"]
}

// We define TWO datasources conceptually, but Prisma uses one at schema level.
// The actual read/write routing happens in our application layer (shown later).
datasource db {
  provider = "mysql"
  url      = env("DATABASE_PRIMARY_URL")
  // Example: mysql://booking_app:password@shard0-primary.db.internal:3306/booking_shard_0
}

model Booking {
  id              BigInt    @id @default(autoincrement()) @db.UnsignedBigInt
  bookingRef      String    @unique @map("booking_ref") @db.VarChar(20)
  userId          BigInt    @map("user_id") @db.UnsignedBigInt
  roomId          BigInt    @map("room_id") @db.UnsignedBigInt
  hotelId         BigInt    @map("hotel_id") @db.UnsignedBigInt
  checkIn         DateTime  @map("check_in") @db.Date
  checkOut        DateTime  @map("check_out") @db.Date
  totalPrice      Decimal   @map("total_price") @db.Decimal(12, 2)
  currency        String    @default("USD") @db.Char(3)
  status          BookingStatus @default(PENDING)
  guestCount      Int       @default(1) @map("guest_count") @db.UnsignedTinyInt
  specialRequests String?   @map("special_requests") @db.Text
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  cancelledAt     DateTime? @map("cancelled_at")
  version         Int       @default(1) @db.UnsignedInt

  @@index([userId, status], map: "idx_user_status")
  @@index([hotelId, checkIn, checkOut], map: "idx_hotel_dates")
  @@index([createdAt], map: "idx_created_at")
  @@index([status, updatedAt], map: "idx_status_updated")
  @@map("bookings")
}

enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
  CHECKED_IN  @map("CHECKED_IN")
  CHECKED_OUT @map("CHECKED_OUT")
  NO_SHOW     @map("NO_SHOW")
}

model ReplicationHeartbeat {
  shardId    Int      @id @map("shard_id") @db.UnsignedInt
  primaryTs  DateTime @map("primary_ts") @db.Timestamp(6)
  replicaTs  DateTime? @map("replica_ts") @db.Timestamp(6)

  @@map("replication_heartbeat")
}

model RecentWriter {
  userId      BigInt   @id @map("user_id") @db.UnsignedBigInt
  lastWriteAt DateTime @map("last_write_at") @db.Timestamp(3)
  shardId     Int      @map("shard_id") @db.UnsignedInt

  @@index([lastWriteAt], map: "idx_last_write")
  @@map("recent_writers")
}
```

### Prisma Client: Basic CRUD

```typescript
// src/repositories/booking.repository.ts
import { PrismaClient, BookingStatus } from '@prisma/client';

// We create TWO Prisma clients — one for writes, one for reads.
// This is the foundation of read/write splitting with Prisma.
const prismaWrite = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_PRIMARY_URL },
    //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //  Points to: shard0-primary.db.internal
  },
});

const prismaRead = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_REPLICA_URL },
    //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //  Points to: shard0-replica-1.db.internal
    //  (In practice, we rotate across replicas — shown later)
  },
});

// WRITE: Create a booking (always goes to primary)
async function createBooking(data: {
  bookingRef: string;
  userId: bigint;
  roomId: bigint;
  hotelId: bigint;
  checkIn: Date;
  checkOut: Date;
  totalPrice: number;
}) {
  return prismaWrite.booking.create({
    //     ^^^^^^^^^^^ Uses the PRIMARY client
    data: {
      bookingRef: data.bookingRef,
      userId: data.userId,
      roomId: data.roomId,
      hotelId: data.hotelId,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      totalPrice: data.totalPrice,
      currency: 'USD',
      status: BookingStatus.CONFIRMED,
    },
  });
}

// READ: Get user's bookings (goes to replica — eventual consistency is fine)
async function getUserBookings(userId: bigint) {
  return prismaRead.booking.findMany({
    //     ^^^^^^^^^^ Uses the REPLICA client
    where: { userId, status: BookingStatus.CONFIRMED },
    orderBy: { createdAt: 'desc' },
  });
}

// READ-AFTER-WRITE: Get booking just created (must go to primary)
async function getBookingAfterWrite(bookingRef: string) {
  return prismaWrite.booking.findUnique({
    //     ^^^^^^^^^^^ Uses PRIMARY — guarantees we see the row we just wrote
    where: { bookingRef },
  });
}
```

> **Key Term:** **Read/Write Splitting** — An architectural pattern where write operations (`INSERT`, `UPDATE`, `DELETE`) are directed to a primary database server, and read operations (`SELECT`) are distributed across one or more read replicas. This allows read traffic to scale horizontally by adding more replicas, while the primary focuses exclusively on writes.

> **Checkpoint:** You now understand the physical architecture: one primary, four replicas per shard, two Prisma clients. Can you explain why `getBookingAfterWrite` uses `prismaWrite` instead of `prismaRead`? If you said "because the replica might not have the data yet due to replication lag," you are correct. We will go deeper into that problem — and its solutions — in the next section.

---

## The Connection Pool: Separate Pools for Read and Write

Using two Prisma clients is a start, but production requires much more: health checks, weighted routing, lag detection, and automatic failover. Here is the full connection pool implementation.

### Raw SQL: Connection Pool Manager

```sql
-- First, let us verify the replication status from the primary's perspective.
-- This query runs on the PRIMARY and shows all connected replicas.

SHOW REPLICA STATUS\G

-- Key fields to watch:
--   Replica_IO_Running:  Yes   (I/O thread is connected and pulling binlog events)
--   Replica_SQL_Running: Yes   (SQL thread is replaying events)
--   Seconds_Behind_Source: 0   (Lag in seconds — 0 means fully caught up)
--   Last_SQL_Error:       ""   (Empty means no errors)

-- On each REPLICA, check its own view of lag:
SELECT
    @@hostname AS replica_host,
    @@server_id AS server_id,
    TIMESTAMPDIFF(MICROSECOND, ts, NOW(6)) / 1000.0 AS lag_ms
FROM replication_heartbeat
WHERE shard_id = 0;

-- This heartbeat-based approach is more accurate than Seconds_Behind_Source,
-- which only measures the delay between the relay log event timestamp
-- and the current time — it does not account for network transfer time.
```

### Prisma Client: Connection Pool with Weighted Replica Routing

```typescript
// src/database/connection-pool.ts
import { PrismaClient } from '@prisma/client';

interface ReplicaConnection {
  client: PrismaClient;
  host: string;
  weight: number;
  healthy: boolean;
  currentLagMs: number;
  region: string;
}

class ReadWriteConnectionPool {
  private primaryClient: PrismaClient;
  private replicas: ReplicaConnection[] = [];
  private readonly maxAcceptableLagMs: number;
  private readonly lagCheckIntervalMs: number;

  constructor(config: {
    primaryUrl: string;
    replicaConfigs: Array<{
      url: string;
      host: string;
      weight: number;
      region: string;
    }>;
    maxAcceptableLagMs?: number;
    lagCheckIntervalMs?: number;
  }) {
    this.maxAcceptableLagMs = config.maxAcceptableLagMs ?? 500;
    this.lagCheckIntervalMs = config.lagCheckIntervalMs ?? 2000;

    // Primary: single client, smaller pool (handles only writes + read-after-write)
    this.primaryClient = new PrismaClient({
      datasources: { db: { url: config.primaryUrl } },
      log: [{ level: 'warn', emit: 'event' }],
    });

    // Replicas: one client per replica, each with its own pool
    for (const replica of config.replicaConfigs) {
      this.replicas.push({
        client: new PrismaClient({
          datasources: { db: { url: replica.url } },
        }),
        host: replica.host,
        weight: replica.weight,
        healthy: true,
        currentLagMs: 0,
        region: replica.region,
      });
    }

    // Start periodic lag checking
    this.startLagMonitor();
  }

  /** Returns the primary client — used for all writes and read-after-write. */
  getPrimary(): PrismaClient {
    return this.primaryClient;
  }

  /**
   * Returns a healthy, low-lag replica client using weighted random selection.
   * Falls back to primary if no healthy replicas are available.
   */
  getReplica(preferredRegion?: string): PrismaClient {
    // Filter to healthy replicas under the lag threshold
    let candidates = this.replicas.filter(
      (r) => r.healthy && r.currentLagMs <= this.maxAcceptableLagMs
    );

    // Prefer same-region replicas if specified
    if (preferredRegion) {
      const regional = candidates.filter((r) => r.region === preferredRegion);
      if (regional.length > 0) {
        candidates = regional;
      }
      // If no same-region replicas, fall back to all healthy replicas
    }

    // If no healthy replicas, fall back to primary (safe but defeats the purpose)
    if (candidates.length === 0) {
      console.warn('[ReadWritePool] No healthy replicas, falling back to primary');
      return this.primaryClient;
    }

    // Weighted random selection
    const totalWeight = candidates.reduce((sum, r) => sum + r.weight, 0);
    let random = Math.random() * totalWeight;
    for (const candidate of candidates) {
      random -= candidate.weight;
      if (random <= 0) {
        return candidate.client;
      }
    }

    // Fallback (should never reach here)
    return candidates[0].client;
  }

  /**
   * Periodically checks replication lag on every replica.
   * Marks replicas as unhealthy if lag exceeds the threshold.
   */
  private startLagMonitor(): void {
    setInterval(async () => {
      for (const replica of this.replicas) {
        try {
          const result = await replica.client.$queryRaw<
            Array<{ lag_ms: number }>
          >`SELECT TIMESTAMPDIFF(MICROSECOND, primary_ts, NOW(6)) / 1000.0 AS lag_ms
            FROM replication_heartbeat
            WHERE shard_id = 0`;

          const lagMs = result[0]?.lag_ms ?? 99999;
          replica.currentLagMs = lagMs;
          replica.healthy = lagMs <= this.maxAcceptableLagMs * 2;
          //                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^
          //  We mark unhealthy at 2x the threshold.
          //  Between 1x and 2x, the replica is "healthy but deprioritized"
          //  because its weight effectively drops in the selection.
        } catch (error) {
          // Connection failed — mark as unhealthy
          replica.healthy = false;
          replica.currentLagMs = 99999;
          console.error(`[LagMonitor] Replica ${replica.host} unreachable`, error);
        }
      }
    }, this.lagCheckIntervalMs);
  }

  /** Graceful shutdown: disconnect all clients. */
  async disconnect(): Promise<void> {
    await this.primaryClient.$disconnect();
    await Promise.all(this.replicas.map((r) => r.client.$disconnect()));
  }
}

// Usage:
const pool = new ReadWriteConnectionPool({
  primaryUrl: 'mysql://booking_app:pass@shard0-primary.db.internal:3306/booking_shard_0',
  replicaConfigs: [
    { url: 'mysql://booking_app:pass@shard0-replica-1.db.internal:3306/booking_shard_0',
      host: 'shard0-replica-1', weight: 100, region: 'us-east-1' },
    { url: 'mysql://booking_app:pass@shard0-replica-2.db.internal:3306/booking_shard_0',
      host: 'shard0-replica-2', weight: 100, region: 'us-east-1' },
    { url: 'mysql://booking_app:pass@shard0-replica-3.db.internal:3306/booking_shard_0',
      host: 'shard0-replica-3', weight: 80, region: 'eu-west-1' },
    { url: 'mysql://booking_app:pass@shard0-replica-4.db.internal:3306/booking_shard_0',
      host: 'shard0-replica-4', weight: 80, region: 'ap-southeast-1' },
  ],
  maxAcceptableLagMs: 500,
  lagCheckIntervalMs: 2000,
});

// Write: always primary
await pool.getPrimary().booking.create({ data: { ... } });

// Read: routed to a healthy replica
await pool.getReplica('us-east-1').booking.findMany({ where: { userId: 42n } });
```

> **Checkpoint:** The connection pool above does three things that a naive "two Prisma clients" approach does not: (1) it checks replication lag on each replica every 2 seconds, (2) it removes unhealthy replicas from the rotation, and (3) it uses weighted random selection so cross-region replicas get proportionally less traffic. Can you think of a scenario where even this is not enough? Hint: what happens when a user creates a booking and then immediately views "my bookings"?

---

## NestJS DataSource Configuration with Read Replicas

If you are using NestJS with Prisma, you can implement read-replica routing using a custom Prisma extension or service layer. Unlike TypeORM, Prisma does not have built-in replication routing, but you can achieve the same result cleanly with a `ReplicaAwarePrismaService` that directs reads to replicas and writes to the primary.

### Prisma with Read-Replica Routing

```typescript
// src/config/prisma-replica.service.ts
import { PrismaClient } from '@prisma/client';
import { Booking } from '../entities/booking.entity';
import { ReplicationHeartbeat } from '../entities/replication-heartbeat.entity';

export const AppDataSource = new DataSource({
  type: 'mysql',
  replication: {
    master: {
      host: 'shard0-primary.db.internal',
      port: 3306,
      username: 'booking_app',
      password: process.env.DB_PRIMARY_PASSWORD,
      database: 'booking_shard_0',
    },
    slaves: [
      {
        host: 'shard0-replica-1.db.internal',
        port: 3306,
        username: 'booking_app',
        password: process.env.DB_REPLICA_PASSWORD,
        database: 'booking_shard_0',
      },
      {
        host: 'shard0-replica-2.db.internal',
        port: 3306,
        username: 'booking_app',
        password: process.env.DB_REPLICA_PASSWORD,
        database: 'booking_shard_0',
      },
      {
        host: 'shard0-replica-3.db.internal',
        port: 3306,
        username: 'booking_app',
        password: process.env.DB_REPLICA_PASSWORD,
        database: 'booking_shard_0',
      },
      {
        host: 'shard0-replica-4.db.internal',
        port: 3306,
        username: 'booking_app',
        password: process.env.DB_REPLICA_PASSWORD,
        database: 'booking_shard_0',
      },
    ],
    canRetry: true,
    removeNodeErrorCount: 5,    // Remove a node after 5 consecutive errors
    restoreNodeTimeout: 30000,  // Re-check removed nodes after 30 seconds
    selector: 'RR',             // Round-robin selection among slaves
  },
  entities: [Booking, ReplicationHeartbeat],
  synchronize: false,  // NEVER true in production
  logging: ['error', 'warn'],
  extra: {
    connectionLimit: 50,        // Per-server connection limit
    acquireTimeout: 10000,      // 10s to acquire a connection
    timeout: 60000,             // 60s query timeout
  },
});
```

### NestJS Module Registration

```typescript
// src/database/database.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ReplicaAwarePrismaService } from '../config/prisma-replica.service';

@Module({
  imports: [
    PrismaModule.forRootAsync({
      useFactory: () => AppDataSource.options,
    }),
  ],
  exports: [PrismaModule],
})
export class DatabaseModule {}
```

### NestJS Service: Controlling Read/Write Routing

```typescript
// src/booking/booking.service.ts
import { Injectable } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ReplicaAwarePrismaService } from '../config/prisma-replica.service';
import { Booking } from '../entities/booking.entity';

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a booking. The write client routes this to the primary
   * because it is a write operation (INSERT).
   */
  async createBooking(data: Partial<Booking>): Promise<Booking> {
    const booking = this.bookingRepo.create(data);
    return this.bookingRepo.save(booking);
    // Write operations always go to the primary
  }

  /**
   * Reads bookings for a user. The read client routes this to a replica
   * because .find() is a read operation (SELECT).
   */
  async getUserBookings(userId: bigint): Promise<Booking[]> {
    return this.bookingRepo.find({
      where: { userId, status: 'CONFIRMED' },
      order: { createdAt: 'DESC' },
    });
    // Read operations go to a replica (round-robin)
  }

  /**
   * Read-after-write: Force the read to use the master connection.
   * Use createQueryRunner('master') to override the default routing.
   */
  async getBookingAfterWrite(bookingRef: string): Promise<Booking | null> {
    const queryRunner = this.dataSource.createQueryRunner('master');
    //                                                     ^^^^^^^^
    //  Forces this query to run on the primary, not a replica.
    try {
      await queryRunner.connect();
      const booking = await queryRunner.manager.findOne(Booking, {
        where: { bookingRef },
      });
      return booking;
    } finally {
      await queryRunner.release();
    }
  }
}
```

> **Key Term:** **Replica-Aware Service** — In Prisma, since there is no built-in replica routing, you create a service that holds two `PrismaClient` instances: one connected to the primary and one connected to a replica. Your application code calls `prisma.read.booking.findMany()` for reads and `prisma.write.booking.create()` for writes. For read-after-write consistency, simply use the write client for the follow-up read.

> **What If You Skip This?** If you naively send all reads to a replica and all writes to the primary, the system cannot tell that your read needs to see data from a write that happened 50 milliseconds ago. Replication lag — even as low as 100ms — means your users will occasionally create a booking and then see an empty "my bookings" page. Without explicit primary routing for read-after-write scenarios, you will introduce this subtle, intermittent bug that is extremely hard to reproduce and debug.

---

## Replication Lag: The Invisible Gremlin

Replication lag is the time between a write committing on the primary and that same write becoming visible on a replica. Under normal operation, this lag is 1–10 milliseconds. Under stress, it can balloon to seconds — or even minutes.

### Measuring Lag Accurately

MySQL's built-in `Seconds_Behind_Source` metric is misleading. It measures the difference between the timestamp on the event being replayed and the current time — but if the replica has not *received* the latest events yet, it does not know what it does not know. It might report "0 seconds behind" because it has finished replaying everything in its relay log, even though the relay log is stale.

The industry-standard approach is a **heartbeat table**: the primary writes a timestamp every second, and each replica reads it.

```sql
-- On the PRIMARY: write a heartbeat every second (run by a cron job or daemon)
REPLACE INTO replication_heartbeat (shard_id, primary_ts)
VALUES (0, NOW(6));
--         ^^^^^^ Microsecond precision: "2026-02-15 14:23:01.003421"

-- On each REPLICA: measure lag by comparing the heartbeat to local time
SELECT
    shard_id,
    primary_ts,
    NOW(6) AS replica_now,
    TIMESTAMPDIFF(MICROSECOND, primary_ts, NOW(6)) / 1000.0 AS lag_ms
FROM replication_heartbeat
WHERE shard_id = 0;

-- Example output:
-- shard_id | primary_ts                  | replica_now                 | lag_ms
-- 0        | 2026-02-15 14:23:01.003421  | 2026-02-15 14:23:01.007892 | 4.471
--                                                                       ^^^^^
--                                                    4.5ms lag — healthy!

-- Another example during a lag spike:
-- shard_id | primary_ts                  | replica_now                 | lag_ms
-- 0        | 2026-02-15 14:23:01.003421  | 2026-02-15 14:23:03.891205 | 2887.784
--                                                                       ^^^^^^^^
--                                                    2.9 SECONDS lag — danger zone!
```

### Prisma Client: Heartbeat Writer and Lag Checker

```typescript
// src/database/replication-monitor.ts
import { PrismaClient } from '@prisma/client';

class ReplicationMonitor {
  private primaryClient: PrismaClient;
  private replicaClients: Map<string, PrismaClient>;
  private lagHistory: Map<string, number[]>;

  constructor(
    primaryClient: PrismaClient,
    replicaClients: Map<string, PrismaClient>,
  ) {
    this.primaryClient = primaryClient;
    this.replicaClients = replicaClients;
    this.lagHistory = new Map();
  }

  /** Write heartbeat on primary — call every 1 second. */
  async writeHeartbeat(shardId: number): Promise<void> {
    await this.primaryClient.$executeRaw`
      REPLACE INTO replication_heartbeat (shard_id, primary_ts)
      VALUES (${shardId}, NOW(6))
    `;
  }

  /** Check lag on a specific replica. Returns lag in milliseconds. */
  async checkLag(replicaHost: string, shardId: number): Promise<number> {
    const client = this.replicaClients.get(replicaHost);
    if (!client) throw new Error(`Unknown replica: ${replicaHost}`);

    const result = await client.$queryRaw<Array<{ lag_ms: number }>>`
      SELECT TIMESTAMPDIFF(MICROSECOND, primary_ts, NOW(6)) / 1000.0 AS lag_ms
      FROM replication_heartbeat
      WHERE shard_id = ${shardId}
    `;

    const lagMs = result[0]?.lag_ms ?? 99999;

    // Track history for P50/P99 calculations
    const history = this.lagHistory.get(replicaHost) ?? [];
    history.push(lagMs);
    if (history.length > 300) history.shift(); // Keep last 5 minutes at 1/sec
    this.lagHistory.set(replicaHost, history);

    return lagMs;
  }

  /** Get P99 lag for a replica over the last 5 minutes. */
  getP99Lag(replicaHost: string): number {
    const history = this.lagHistory.get(replicaHost) ?? [];
    if (history.length === 0) return 0;
    const sorted = [...history].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.99);
    return sorted[index];
  }
}
```

> **Analogy:** Imagine two clocks on opposite walls of a room. The clock on the left (primary) shows 2:00:00.000. The clock on the right (replica) shows 1:59:59.995. The difference — 5 milliseconds — is replication lag. Most of the time the clocks are nearly synchronized. But if someone bumps the right clock (a long-running ALTER TABLE, a network hiccup, a burst of writes), it falls behind. Your job is to constantly watch both clocks and route customers to the information desk that has the most up-to-date catalog.

---

## Read-After-Write Consistency: The Hardest Problem

Here is the scenario that breaks naive read/write splitting:

1. User creates a booking (write goes to primary).
2. Server returns "Booking confirmed!" with a redirect to `/bookings`.
3. Browser requests `/bookings` (read goes to replica).
4. Replica has not received the new booking yet (2ms replication lag).
5. User sees an empty bookings page. Panic. "Where is my booking?!"

This is the **read-after-write consistency** problem, and it is the number one reason teams abandon read/write splitting. But the problem has well-known solutions.

### Solution 1: Sticky Routing with a Time Window

After a user performs a write, route all their reads to the primary for a brief window (typically 2–5 seconds). We track this in Redis (faster than the `recent_writers` MySQL table for hot-path lookups).

```sql
-- The MySQL-based fallback (for when Redis is unavailable):
-- Record that this user just wrote
REPLACE INTO recent_writers (user_id, last_write_at, shard_id)
VALUES (42, NOW(3), 0);

-- Check if a user should read from primary
SELECT user_id, last_write_at,
       TIMESTAMPDIFF(MILLISECOND, last_write_at, NOW(3)) AS ms_since_write
FROM recent_writers
WHERE user_id = 42
  AND last_write_at > NOW(3) - INTERVAL 5 SECOND;
--                              ^^^^^^^^^^^^^^^^
--  5-second window: if the user wrote within the last 5 seconds,
--  route their reads to the primary.
--  If the row exists and ms_since_write < 5000, use primary.
--  Otherwise, safe to use replica.
```

### Prisma Client: Sticky Routing Implementation

```typescript
// src/database/read-after-write-router.ts
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

class ReadAfterWriteRouter {
  private primary: PrismaClient;
  private replicaPool: ReadWriteConnectionPool;
  private redis: Redis;
  private readonly stickyWindowMs: number;

  constructor(
    primary: PrismaClient,
    replicaPool: ReadWriteConnectionPool,
    redis: Redis,
    stickyWindowMs: number = 5000, // 5 seconds default
  ) {
    this.primary = primary;
    this.replicaPool = replicaPool;
    this.redis = redis;
    this.stickyWindowMs = stickyWindowMs;
  }

  /**
   * Call this AFTER every write operation.
   * Marks the user as a "recent writer" so subsequent reads
   * are routed to the primary.
   */
  async markRecentWrite(userId: bigint): Promise<void> {
    const key = `recent-writer:${userId}`;
    await this.redis.set(key, Date.now().toString(), 'PX', this.stickyWindowMs);
    //                                                'PX' = millisecond expiry
    //  The key auto-expires after stickyWindowMs.
    //  No cleanup needed — Redis handles it.
  }

  /**
   * Returns the correct Prisma client for a READ operation.
   * If the user recently wrote, returns the primary client.
   * Otherwise, returns a replica client.
   */
  async getReadClient(userId: bigint, region?: string): Promise<PrismaClient> {
    const key = `recent-writer:${userId}`;
    const recentWrite = await this.redis.get(key);

    if (recentWrite !== null) {
      // User wrote recently — route to primary for consistency
      return this.primary;
    }

    // No recent write — safe to read from replica
    return this.replicaPool.getReplica(region);
  }
}

// Usage in a service:
class BookingService {
  constructor(
    private router: ReadAfterWriteRouter,
    private primaryClient: PrismaClient,
  ) {}

  async createBooking(userId: bigint, data: any) {
    // Step 1: Write to primary
    const booking = await this.primaryClient.booking.create({
      data: { userId, ...data },
    });

    // Step 2: Mark user as recent writer
    await this.router.markRecentWrite(userId);

    return booking;
  }

  async getMyBookings(userId: bigint, region?: string) {
    // Step 1: Get the right client (primary if recent write, replica otherwise)
    const client = await this.router.getReadClient(userId, region);

    // Step 2: Execute the read
    return client.booking.findMany({
      where: { userId, status: 'CONFIRMED' },
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

> **Key Term:** **Read-After-Write Consistency** — A consistency guarantee that ensures a client can always read the data it just wrote. In a replicated system, this means routing the client's reads to the primary (or a fully caught-up replica) for a brief period after each write. Without this guarantee, users experience the unsettling phenomenon of "phantom data loss" — their data exists, but they cannot see it.

> **Checkpoint:** Notice that the sticky window (5 seconds) is a trade-off. Too short, and some users still see stale data during lag spikes. Too long, and you are routing too many reads to the primary, negating the benefit of replicas. In our system, 5 seconds works because our P99 replication lag is under 50ms — so 5 seconds provides a 100x safety margin. If your replication lag P99 is 2 seconds, you would need a 10-second window.

---

## ProxySQL / MySQL Router: Transparent Routing

Everything we have built so far puts the routing logic inside the application. That works, but it means every service, every microservice, every cron job needs the same routing code. An alternative is to push the routing decision into a **database proxy** — a middleware layer that sits between your application and MySQL, inspects every query, and routes it to the correct server automatically.

Two popular options exist: **ProxySQL** (open source, battle-tested) and **MySQL Router** (Oracle's official proxy). We use ProxySQL in production because of its superior query rules engine and built-in lag-aware routing.

### ProxySQL Configuration

```sql
-- ProxySQL uses its own admin interface on port 6032.
-- These commands configure read/write splitting.

-- Step 1: Define host groups
-- Host group 10 = writers (primary)
-- Host group 20 = readers (replicas)
INSERT INTO mysql_servers (hostgroup_id, hostname, port, weight, max_connections)
VALUES
  (10, 'shard0-primary.db.internal',   3306, 1000, 200),
  (20, 'shard0-replica-1.db.internal', 3306, 100,  100),
  (20, 'shard0-replica-2.db.internal', 3306, 100,  100),
  (20, 'shard0-replica-3.db.internal', 3306, 80,   100),
  (20, 'shard0-replica-4.db.internal', 3306, 80,   100);

-- Step 2: Define query rules
-- Rule 1: All SELECT queries go to host group 20 (replicas)
INSERT INTO mysql_query_rules (rule_id, active, match_pattern, destination_hostgroup, apply)
VALUES
  (100, 1, '^SELECT', 20, 1);
--          ^^^^^^^^
--  Regex: any query starting with SELECT goes to replicas.

-- Rule 2: SELECT ... FOR UPDATE goes to host group 10 (primary)
-- This is a WRITE-intent read — it acquires locks, so it must run on primary.
INSERT INTO mysql_query_rules (rule_id, active, match_pattern, destination_hostgroup, apply)
VALUES
  (50, 1, '^SELECT.*FOR UPDATE', 10, 1);
--   ^^
--  Lower rule_id = higher priority. This rule fires before the generic SELECT rule.

-- Rule 3: Everything else (INSERT, UPDATE, DELETE) goes to host group 10 (primary)
-- This is the default: if no rule matches, traffic goes to the writer group.
INSERT INTO mysql_query_rules (rule_id, active, match_pattern, destination_hostgroup, apply)
VALUES
  (200, 1, '.*', 10, 1);

-- Step 3: Configure lag-aware read routing
-- ProxySQL can automatically skip replicas that are too far behind.
UPDATE mysql_servers
SET max_replication_lag = 1
--                        ^
--  If a replica is more than 1 second behind, ProxySQL stops
--  sending it read traffic until it catches up.
WHERE hostgroup_id = 20;

-- Step 4: Load configuration into runtime and save to disk
LOAD MYSQL SERVERS TO RUNTIME;
LOAD MYSQL QUERY RULES TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
SAVE MYSQL QUERY RULES TO DISK;
```

### Prisma Client: Connecting Through ProxySQL

When using ProxySQL, your application connects to the proxy as if it were a regular MySQL server. The proxy handles all the routing transparently.

```typescript
// With ProxySQL, you only need ONE Prisma client.
// ProxySQL inspects each query and routes it to the right server.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'mysql://booking_app:password@proxysql.internal:6033/booking_shard_0',
      //                                  ^^^^^^^^^^^^^^^^^^^^^
      //  Port 6033 is ProxySQL's MySQL-compatible traffic port.
      //  The application thinks it is talking to a single MySQL server.
      //  ProxySQL routes SELECTs to replicas and writes to the primary.
    },
  },
});

// These queries are routed AUTOMATICALLY by ProxySQL:

// SELECT -> goes to a replica (host group 20)
const bookings = await prisma.booking.findMany({
  where: { userId: 42n },
});

// INSERT -> goes to the primary (host group 10)
const newBooking = await prisma.booking.create({
  data: {
    bookingRef: 'BK-20260215-A7X3',
    userId: 42n,
    roomId: 100n,
    hotelId: 5n,
    checkIn: new Date('2026-03-01'),
    checkOut: new Date('2026-03-05'),
    totalPrice: 599.99,
  },
});

// SELECT ... FOR UPDATE -> goes to the primary (rule_id 50, higher priority)
// Prisma does not generate FOR UPDATE directly, but raw queries can:
const lockedRoom = await prisma.$queryRaw`
  SELECT * FROM bookings WHERE id = 12345 FOR UPDATE
`;
```

> **Analogy:** Think of ProxySQL as a traffic cop at an intersection. Cars (queries) approach the intersection, and the cop reads their license plates (the SQL text). If the plate starts with "SEL" (a SELECT query), the cop directs the car down the "readers" lane toward one of four replica garages. If the plate starts with "INS", "UPD", or "DEL", the cop sends the car down the "writers" lane to the single primary garage. The drivers (application code) do not need to know which garage they are going to — they just drive to the intersection and let the cop decide.

> **What If You Skip This?** Without a proxy, every application, microservice, background worker, and reporting tool needs its own read/write routing logic. That is duplicated code, duplicated configuration, and duplicated bugs. ProxySQL centralizes this logic into one place. The downside is an additional network hop (typically 0.1–0.5ms) and another component to monitor and maintain. For teams with fewer than 5 services, application-level routing is simpler. For teams with 20+ services, a proxy pays for itself quickly.

---

## Monitoring Replication Lag: Prometheus Metrics

You cannot fix what you cannot see. We export replication lag metrics to Prometheus from two sources: (1) the application-level heartbeat monitor, and (2) ProxySQL's internal stats.

### Raw SQL: ProxySQL Statistics

```sql
-- ProxySQL exposes a stats schema with real-time metrics.
-- Connect to ProxySQL admin (port 6032) and query:

-- Per-server connection stats and lag
SELECT
    hostgroup,
    srv_host,
    srv_port,
    status,
    ConnUsed AS active_connections,
    ConnFree AS idle_connections,
    ConnERR AS error_count,
    Queries AS total_queries,
    Bytes_data_sent,
    Bytes_data_recv,
    Latency_us AS latency_microseconds
FROM stats_mysql_connection_pool
ORDER BY hostgroup, srv_host;

-- Example output:
-- hostgroup | srv_host                    | status  | active | idle | errors | queries  | latency_us
-- 10        | shard0-primary.db.internal  | ONLINE  | 45     | 155  | 0      | 2841923  | 312
-- 20        | shard0-replica-1.db.internal| ONLINE  | 32     | 68   | 0      | 8923451  | 198
-- 20        | shard0-replica-2.db.internal| ONLINE  | 28     | 72   | 0      | 8810234  | 210
-- 20        | shard0-replica-3.db.internal| ONLINE  | 15     | 85   | 2      | 4201893  | 1842
-- 20        | shard0-replica-4.db.internal| SHUNNED | 0      | 0    | 12     | 3988221  | 99999
--                                          ^^^^^^^
--  SHUNNED = ProxySQL removed this replica because it exceeded
--  max_replication_lag or had too many connection errors.
--  It will be re-checked after the restore timeout.

-- Query digest: top 10 most frequent queries
SELECT
    hostgroup,
    schemaname,
    digest_text,
    count_star AS execution_count,
    sum_time / count_star AS avg_time_us,
    ROUND(sum_time / 1000000, 2) AS total_time_sec
FROM stats_mysql_query_digest
ORDER BY count_star DESC
LIMIT 10;
```

### Prisma Client: Prometheus Exporter for Lag Metrics

```typescript
// src/monitoring/lag-metrics-exporter.ts
import { PrismaClient } from '@prisma/client';
import { Registry, Gauge, Histogram } from 'prom-client';

const register = new Registry();

// Gauge: current replication lag per replica (in milliseconds)
const replicationLagGauge = new Gauge({
  name: 'mysql_replication_lag_ms',
  help: 'Current replication lag in milliseconds per replica',
  labelNames: ['shard', 'replica_host', 'region'],
  registers: [register],
});

// Histogram: distribution of lag values over time
const replicationLagHistogram = new Histogram({
  name: 'mysql_replication_lag_distribution_ms',
  help: 'Distribution of replication lag measurements',
  labelNames: ['shard', 'replica_host'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  //         ^                                              ^^^^^
  //         1ms (ideal)                               5s (crisis)
  registers: [register],
});

// Gauge: number of healthy replicas per shard
const healthyReplicasGauge = new Gauge({
  name: 'mysql_healthy_replicas',
  help: 'Number of healthy (low-lag) replicas per shard',
  labelNames: ['shard'],
  registers: [register],
});

class LagMetricsExporter {
  private monitor: ReplicationMonitor;
  private replicaConfigs: Array<{
    host: string;
    region: string;
    shardId: number;
  }>;

  constructor(
    monitor: ReplicationMonitor,
    replicaConfigs: Array<{ host: string; region: string; shardId: number }>,
  ) {
    this.monitor = monitor;
    this.replicaConfigs = replicaConfigs;
  }

  /** Call every 2 seconds to update Prometheus metrics. */
  async collectMetrics(): Promise<void> {
    let healthyCount = 0;

    for (const config of this.replicaConfigs) {
      try {
        const lagMs = await this.monitor.checkLag(config.host, config.shardId);

        replicationLagGauge.set(
          { shard: config.shardId.toString(), replica_host: config.host, region: config.region },
          lagMs,
        );

        replicationLagHistogram.observe(
          { shard: config.shardId.toString(), replica_host: config.host },
          lagMs,
        );

        if (lagMs < 500) healthyCount++;
      } catch (error) {
        // Replica unreachable — set lag to a sentinel value
        replicationLagGauge.set(
          { shard: config.shardId.toString(), replica_host: config.host, region: config.region },
          -1,  // -1 signals "unreachable" in our Grafana dashboards
        );
      }
    }

    healthyReplicasGauge.set(
      { shard: this.replicaConfigs[0]?.shardId.toString() ?? '0' },
      healthyCount,
    );
  }

  /** Returns the Prometheus registry for the /metrics endpoint. */
  getRegistry(): Registry {
    return register;
  }
}

// NestJS controller to expose /metrics
import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly exporter: LagMetricsExporter) {}

  @Get()
  async getMetrics(@Res() res: Response) {
    res.set('Content-Type', this.exporter.getRegistry().contentType);
    res.send(await this.exporter.getRegistry().metrics());
  }
}
```

> **Checkpoint:** With these metrics in Prometheus, you can create Grafana alerts for: (1) any replica with lag > 500ms for more than 30 seconds, (2) fewer than 2 healthy replicas on any shard, and (3) any replica that has been SHUNNED by ProxySQL. These three alerts catch 95% of replication issues before users notice.

---

## Failover: Promoting a Replica to Primary

The primary server will eventually fail. Hardware dies, disks corrupt, networks partition. When that happens, you need to promote a replica to become the new primary — and you need to do it quickly, with minimal data loss.

### The Failover Sequence

```
Before failover:
  Primary (shard0-primary) ──► Replica-1 (in sync)
                           ──► Replica-2 (in sync)
                           ──► Replica-3 (50ms behind)
                           ──► Replica-4 (unreachable)

Primary crashes at 14:23:01.

Step 1: Detect failure (health check fails 3 times in 10 seconds)
Step 2: Choose the most up-to-date replica (Replica-1 or Replica-2)
Step 3: Stop replication on the chosen replica
Step 4: Promote it to primary (enable binary logging, accept writes)
Step 5: Point remaining replicas to the new primary
Step 6: Update DNS / ProxySQL to route writes to the new primary
Step 7: Notify the on-call engineer

After failover:
  Replica-1 (now promoted to PRIMARY) ──► Replica-2 (re-pointed)
                                      ──► Replica-3 (re-pointed, catching up)
                                      ──► Replica-4 (still unreachable)
  Old Primary (dead, pending investigation)
```

### Raw SQL: Manual Failover Steps

```sql
-- Step 2: On each candidate replica, check how current it is
-- Run on Replica-1:
SHOW REPLICA STATUS\G
-- Look at: Exec_Master_Log_Pos and Relay_Master_Log_File
-- The replica closest to the primary's last binlog position wins.

-- Step 3: On the chosen replica (Replica-1), stop replication
STOP REPLICA;
RESET REPLICA ALL;
--  RESET REPLICA ALL removes all replication configuration.
--  This server is no longer a replica — it is standalone.

-- Step 4: Enable binary logging (if not already enabled) and set read_only OFF
SET GLOBAL read_only = OFF;
SET GLOBAL super_read_only = OFF;
--  Now this server accepts writes.

-- Step 5: On Replica-2, point it to the new primary
STOP REPLICA;
CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'shard0-replica-1.db.internal',   -- The promoted replica
    SOURCE_PORT = 3306,
    SOURCE_USER = 'repl_user',
    SOURCE_PASSWORD = 'repl_password',
    SOURCE_AUTO_POSITION = 1;                        -- Use GTID-based positioning
START REPLICA;

-- Step 6: Update ProxySQL to route writes to the new primary
-- On ProxySQL admin:
UPDATE mysql_servers
SET hostgroup_id = 10    -- Move to writer group
WHERE hostname = 'shard0-replica-1.db.internal';

UPDATE mysql_servers
SET hostgroup_id = 20    -- Ensure it stays in reader group too (optional)
WHERE hostname = 'shard0-replica-1.db.internal'
  AND hostgroup_id = 20;

-- Remove the dead primary from all host groups
DELETE FROM mysql_servers
WHERE hostname = 'shard0-primary.db.internal';

LOAD MYSQL SERVERS TO RUNTIME;
SAVE MYSQL SERVERS TO DISK;
```

### Prisma Client: Automated Failover Orchestrator

```typescript
// src/database/failover-orchestrator.ts
import { PrismaClient } from '@prisma/client';

interface FailoverCandidate {
  host: string;
  client: PrismaClient;
  lagMs: number;
  executedGtidSet: string;
}

class FailoverOrchestrator {
  private monitor: ReplicationMonitor;
  private replicaClients: Map<string, PrismaClient>;

  constructor(
    monitor: ReplicationMonitor,
    replicaClients: Map<string, PrismaClient>,
  ) {
    this.monitor = monitor;
    this.replicaClients = replicaClients;
  }

  /**
   * Selects the best replica to promote.
   * Criteria: lowest lag, most transactions applied (largest GTID set).
   */
  async selectPromotionCandidate(): Promise<FailoverCandidate | null> {
    const candidates: FailoverCandidate[] = [];

    for (const [host, client] of this.replicaClients) {
      try {
        // Check current lag
        const lagMs = this.monitor.getP99Lag(host);

        // Check GTID position (how many transactions has this replica applied?)
        const gtidResult = await client.$queryRaw<
          Array<{ gtid_set: string }>
        >`SELECT @@global.gtid_executed AS gtid_set`;

        candidates.push({
          host,
          client,
          lagMs,
          executedGtidSet: gtidResult[0]?.gtid_set ?? '',
        });
      } catch {
        // Replica unreachable — skip it
        console.warn(`[Failover] Replica ${host} unreachable, skipping`);
      }
    }

    if (candidates.length === 0) return null;

    // Sort by lag (ascending) — the most up-to-date replica wins
    candidates.sort((a, b) => a.lagMs - b.lagMs);

    console.log(
      `[Failover] Best candidate: ${candidates[0].host} (lag: ${candidates[0].lagMs}ms)`,
    );

    return candidates[0];
  }

  /**
   * Executes the promotion sequence on the selected replica.
   * WARNING: This is a one-way operation. The old primary must be
   * manually investigated and either discarded or re-added as a replica.
   */
  async promoteReplica(candidate: FailoverCandidate): Promise<void> {
    const { client, host } = candidate;

    console.log(`[Failover] Promoting ${host} to primary...`);

    // Step 1: Stop replication
    await client.$executeRawUnsafe('STOP REPLICA');
    await client.$executeRawUnsafe('RESET REPLICA ALL');

    // Step 2: Disable read-only mode (allow writes)
    await client.$executeRawUnsafe('SET GLOBAL read_only = OFF');
    await client.$executeRawUnsafe('SET GLOBAL super_read_only = OFF');

    console.log(`[Failover] ${host} is now accepting writes`);

    // Step 3: Update the application's primary connection
    // In production, this would update a service discovery entry
    // (Consul, etcd, or Route 53 weighted record).
    // Here we demonstrate the concept:
    await this.updateServiceDiscovery(host);

    console.log(`[Failover] Service discovery updated. New primary: ${host}`);
  }

  private async updateServiceDiscovery(newPrimaryHost: string): Promise<void> {
    // Implementation depends on your infrastructure:
    // - AWS Route 53: Update the CNAME for shard0-primary.db.internal
    // - Consul: Register the new primary under the same service name
    // - ProxySQL: Move the server to hostgroup 10 (writer)
    // For this example, we log and rely on external automation:
    console.log(
      `[Failover] UPDATE DNS: shard0-primary.db.internal -> ${newPrimaryHost}`,
    );
  }
}
```

> **What If You Skip This?** Without automated failover, a primary crash means manual intervention. At 3 AM, the on-call engineer gets paged, SSHs into the replica, runs the promotion commands by hand, and updates ProxySQL. Total downtime: 15–45 minutes. With automated failover (using tools like Orchestrator, MHA, or our custom orchestrator above), the detection-to-promotion cycle takes 10–30 seconds. For a booking system processing 1,666 writes per second, 30 minutes of downtime means 2,999,880 lost bookings. Automation is not optional.

---

## Production War Story: The Phantom Double-Booking

It was a Friday evening in November. Our booking system was running its largest flash sale of the year — 40% off all hotels in Southeast Asia. Traffic spiked to 4x normal. Everything seemed fine until the support team started receiving a wave of complaints: customers were seeing double charges on their credit cards for the same booking.

### What Happened

The sequence of events was subtle:

1. **14:23:00** — Traffic surge began. Write volume on shard-7 tripled from 200/sec to 600/sec.
2. **14:23:15** — Replication lag on shard-7 replicas climbed from 5ms to 800ms. Our monitoring alert threshold was 1,000ms, so no alert fired.
3. **14:23:20** — A customer (User #88412) clicked "Book Now" for a deluxe room at a Bangkok hotel. The write went to the primary. Booking confirmed, ref BK-20261115-Q9R2.
4. **14:23:20.050** — The confirmation page loaded, triggering a read to check the booking status. This read went to Replica-3, which was 800ms behind. Replica-3 returned "no booking found."
5. **14:23:21** — The frontend JavaScript, receiving a "not found" response, showed an error: "Booking failed. Please try again."
6. **14:23:22** — The customer clicked "Book Now" again. A second booking was created: BK-20261115-T4M8. The same room, same dates, same customer. Charged twice.
7. **14:23:23** — Replica-3 finally received the first booking. Now both bookings existed. The room was double-booked.

### Why Our Safeguards Failed

We had three safeguards, and all three had gaps:

| Safeguard | Why It Failed |
|---|---|
| **Read-after-write routing** | Our sticky window was 2 seconds, but we were routing based on a Redis key. The Redis SET for User #88412 completed, but the confirmation page loaded from a CDN-cached API response that did not check Redis. |
| **Idempotency key** | The frontend generated a new idempotency key on each button click. The "retry" was treated as a new request. |
| **Room availability check** | The availability check ran on a replica (it was a SELECT). The replica did not have the first booking yet. It reported the room as available. |

### The Fix

We implemented three changes that Monday:

```typescript
// Fix 1: Availability checks for booking MUST go to primary
// Before (broken):
async checkAvailability(roomId: bigint, checkIn: Date, checkOut: Date) {
  return this.replicaClient.booking.findFirst({
    //        ^^^^^^^^^^^^^ WRONG — replica might be stale
    where: {
      roomId,
      status: { in: ['CONFIRMED', 'PENDING'] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
  });
}

// After (fixed):
async checkAvailability(roomId: bigint, checkIn: Date, checkOut: Date) {
  return this.primaryClient.booking.findFirst({
    //        ^^^^^^^^^^^^^^ CORRECT — always check primary for availability
    where: {
      roomId,
      status: { in: ['CONFIRMED', 'PENDING'] },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
  });
}

// Fix 2: Frontend idempotency key is generated ONCE and persisted
// The key is stored in sessionStorage and reused on retry.
// Server-side: reject duplicate idempotency keys with HTTP 409.

// Fix 3: Lower the replication lag alert threshold
// Before: alert at 1000ms
// After: alert at 200ms, page on-call at 500ms
```

```sql
-- Fix 1 in raw SQL context: availability check always on primary
-- This query MUST run on the primary, not a replica:
SELECT COUNT(*) AS conflicting_bookings
FROM bookings
WHERE room_id = 100
  AND status IN ('CONFIRMED', 'PENDING')
  AND check_in < '2026-03-05'    -- desired check_out
  AND check_out > '2026-03-01'   -- desired check_in
FOR UPDATE;
--  ^^^^^^^^^^
--  FOR UPDATE ensures this runs on the primary (ProxySQL rule)
--  AND acquires a lock to prevent concurrent bookings.
```

> **Lesson Learned:** Not all reads are created equal. A "show my past bookings" read is fine on a replica — if it is 500ms stale, the user will never notice. But an "is this room available right now?" read is a **write-intent read** — its result determines whether a write should happen. Write-intent reads must always go to the primary. The cost of routing one extra SELECT to the primary is negligible. The cost of a double-booking is a refund, an apology, and a customer who never comes back.

---

## Common Mistakes with Read/Write Splitting

Over four years of operating read/write splitting at scale, we have seen these mistakes repeatedly — both in our own code and in systems we have inherited.

### Mistake 1: Routing All Reads to Replicas

```typescript
// WRONG: Routing ALL reads to replicas, including critical ones
async isRoomAvailable(roomId: bigint, dates: DateRange): Promise<boolean> {
  const conflicts = await this.replicaClient.booking.count({
    //                         ^^^^^^^^^^^^^ Dangerous for availability checks!
    where: { roomId, status: 'CONFIRMED', ...dateOverlap(dates) },
  });
  return conflicts === 0;
}

// CORRECT: Route write-intent reads to primary
async isRoomAvailable(roomId: bigint, dates: DateRange): Promise<boolean> {
  const conflicts = await this.primaryClient.booking.count({
    //                         ^^^^^^^^^^^^^^ Safe — always sees latest state
    where: { roomId, status: 'CONFIRMED', ...dateOverlap(dates) },
  });
  return conflicts === 0;
}
```

**Why it matters:** Availability checks gate write operations. A stale read here causes double-bookings, oversold rooms, and financial loss. Rule of thumb: if the result of a read determines whether a write should happen, that read goes to the primary.

### Mistake 2: Ignoring Transactions That Mix Reads and Writes

```typescript
// WRONG: Starting a transaction on a replica, then trying to write
async confirmBooking(bookingId: bigint): Promise<void> {
  // This transaction starts on a replica because the first operation is a read
  await this.replicaClient.$transaction(async (tx) => {
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    // Now we try to write... but we are on a replica. READ-ONLY error!
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED' },
    });
  });
}

// CORRECT: Any transaction with a write must use the primary client
async confirmBooking(bookingId: bigint): Promise<void> {
  await this.primaryClient.$transaction(async (tx) => {
    //       ^^^^^^^^^^^^^^ All operations in this transaction use the primary
    const booking = await tx.booking.findUnique({ where: { id: bookingId } });
    await tx.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED' },
    });
  });
}
```

**Why it matters:** Replicas are read-only. Any transaction that includes even one write must run entirely on the primary. Prisma will throw a runtime error if you try to write on a read-only connection, but the error message ("cannot execute in a read-only transaction") is cryptic if you do not understand the routing.

### Mistake 3: Not Monitoring Replication Lag

```typescript
// WRONG: Deploying read replicas without monitoring
const prismaRead = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_REPLICA_URL } },
});
// No health checks. No lag monitoring. No failover.
// When a replica falls 30 seconds behind, nobody knows
// until users complain about seeing "old" data.

// CORRECT: Always monitor lag and act on it
// (Use the ReplicationMonitor class from earlier in this chapter)
```

**Why it matters:** Replication lag is not a hypothetical. It happens during deployments, schema migrations, traffic spikes, and disk I/O contention. Without monitoring, a lagging replica silently serves stale data. With monitoring, you can automatically pull it out of the rotation.

### Mistake 4: Using Replicas for Reporting Without Resource Isolation

```sql
-- WRONG: Running a 10-minute analytics query on the same replica
-- that serves live user traffic
SELECT
    hotel_id,
    DATE(check_in) AS date,
    COUNT(*) AS bookings,
    SUM(total_price) AS revenue
FROM bookings
WHERE check_in BETWEEN '2026-01-01' AND '2026-12-31'
GROUP BY hotel_id, DATE(check_in)
ORDER BY revenue DESC;
-- This full-table scan locks InnoDB pages, consumes all CPU,
-- and causes replication lag on this replica.

-- CORRECT: Dedicate a separate replica for analytics.
-- In our setup, Replica-4 is the "analytics replica."
-- It has a higher max_replication_lag tolerance (60 seconds)
-- and is never used for live user traffic.
```

**Why it matters:** A heavy reporting query on a user-facing replica causes CPU spikes, I/O contention, and replication lag. This makes the replica fall behind, which makes the lag monitor remove it from the rotation, which increases load on the remaining replicas, which causes them to fall behind too. This is a cascading failure. Dedicate a replica to analytics and exclude it from the user-facing pool.

### Mistake 5: Hardcoding Replica URLs

```typescript
// WRONG: Hardcoding replica endpoints
const replicaUrl = 'mysql://app:pass@10.0.1.47:3306/booking';
//                                   ^^^^^^^^^
// When this server is replaced, your application breaks.

// CORRECT: Use DNS names that can be re-pointed during failover
const replicaUrl = 'mysql://app:pass@shard0-replica-1.db.internal:3306/booking';
//                                   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
// DNS entry managed by service discovery (Consul, Route 53, etc.)
// Can be re-pointed to a new server in seconds during maintenance.
```

**Why it matters:** Servers are cattle, not pets. They fail, they get replaced, they get moved. If your connection string uses an IP address, every server replacement requires a code change and deployment. If it uses a DNS name, you update the DNS record and connections automatically follow.

---

## Chapter Summary

This chapter covered read/write splitting — the pattern of directing writes to a primary database and distributing reads across replicas to scale horizontally.

| Topic | Key Takeaway |
|---|---|
| **Why split reads from writes** | Reads (70–90% of traffic) and writes (10–30%) have different resource profiles. Separating them prevents writes from blocking reads and lets you scale reads by adding replicas. |
| **MySQL replication** | The primary writes to a binary log. Replicas pull events via an I/O thread, buffer them in a relay log, and replay them via a SQL thread. Semi-synchronous replication ensures at least one replica acknowledges each write. |
| **Replication lag** | The delay between a write on the primary and its visibility on a replica. Measure with heartbeat tables (not `Seconds_Behind_Source`). Typical: 1–10ms. Dangerous: >500ms. |
| **Read-after-write consistency** | After a user writes, route their reads to the primary for a brief window (5 seconds). Track recent writers in Redis with auto-expiring keys. |
| **Connection pooling** | Maintain separate pools for primary and replicas. Use weighted round-robin with health checks and lag-aware routing. Fall back to primary when no healthy replicas exist. |
| **NestJS / Prisma** | Prisma does not have built-in replication support, but you can create a `ReplicaAwarePrismaService` with separate read/write clients. Use the write client to force reads to the primary when read-after-write consistency is needed. |
| **ProxySQL** | A transparent database proxy that routes queries based on SQL pattern matching. Handles lag-aware routing, connection pooling, and failover without application code changes. |
| **Monitoring** | Export lag metrics to Prometheus. Alert at 200ms, page at 500ms. Track healthy replica count per shard. Monitor ProxySQL's connection pool stats. |
| **Failover** | When the primary fails, promote the most up-to-date replica. Automate the sequence: detect, select, stop replication, promote, re-point, update DNS. Target: <30 seconds. |
| **Write-intent reads** | Not all reads belong on replicas. If a read's result determines whether a write should happen (availability checks, balance checks), route it to the primary. |
| **Dedicated analytics replicas** | Isolate heavy reporting queries on a separate replica that is excluded from user-facing traffic. Prevents cascading lag across all replicas. |

> **Final Checkpoint:** You have now built a complete read/write splitting system: two Prisma clients (or a ProxySQL proxy), heartbeat-based lag monitoring, sticky routing for read-after-write consistency, weighted replica selection, Prometheus metrics, and automated failover. The next chapter covers **caching** — adding a Redis layer in front of the replicas to handle the cases where even four replicas are not enough.
