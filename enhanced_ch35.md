# Chapter 35: Capacity Planning — How Much Server Do We Need?

## The Question Nobody Asks Until It Is Too Late

You have been developing on your laptop. Your entire application runs on `localhost:3000`. Maybe you deployed to a $5 VPS on DigitalOcean or a free Railway instance, ran `npm start`, and called it production. That works for your side project with 50 users.

Now imagine you are launching a global booking platform that needs to handle **100,000 bookings per minute**. How many servers do you need? How much RAM? How many database instances? How much will it all cost?

This is **capacity planning**, and it is one of the most important skills you will develop as you move from "I can build features" to "I can build systems." It is not glamorous. It is math. But skipping it means either spending ten times what you need or watching your system collapse on launch day.

> **Key Term:** **Capacity planning** -- The process of determining what infrastructure resources (CPU, RAM, storage, network) your system needs to handle expected traffic, both at average load and at peak spikes. It is the bridge between "it works on my machine" and "it works for a million users."

---

## 35.1 Capacity Planning Methodology

Capacity planning is not guesswork. It is a repeatable engineering process with five phases. Skip any phase and you will either over-spend or under-provision.

### Phase 1: Gather Business Requirements

Before you think about servers, you need answers to five questions:

1. **What is the target throughput?** For us: 100,000 bookings per minute at peak.
2. **What is the acceptable latency?** P99 under 2 seconds for payment processing, P95 under 500ms for search.
3. **What is the availability target?** 99.99% uptime -- that is 52.6 minutes of downtime per year, total.
4. **What is the growth projection?** We expect 40% year-over-year traffic growth for the next three years.
5. **What are the compliance constraints?** GDPR requires data residency in the EU region; PCI-DSS requires isolated payment processing.

These five answers shape every infrastructure decision that follows. Without them, you are sizing servers based on vibes.

### Phase 2: Model the Traffic

Traffic is not a flat line. It has daily cycles, weekly patterns, seasonal surges, and unpredictable spikes. You need to model all of them.

```typescript
// capacity/traffic-model.ts
export interface TrafficModel {
  peak: ThroughputMetrics;
  average: ThroughputMetrics;
  growth: GrowthProjection;
  patterns: TrafficPatterns;
  geographic: GeographicDistribution;
}

interface ThroughputMetrics {
  bookingsPerSecond: number;
  bookingsPerMinute: number;
  searchQueriesPerSecond: number;
  totalRequestsPerSecond: number;
}

interface GrowthProjection {
  yearOverYearGrowthRate: number;   // 0.40 = 40%
  projectionYears: number;          // Plan for 3 years
  peakAt3Years: number;             // What peak looks like in 3 years
}

interface TrafficPatterns {
  dailyPeakHour: number;            // UTC hour of daily peak
  dailyPeakMultiplier: number;      // How much higher than daily average
  weekendMultiplier: number;        // Weekend vs weekday
  seasonalHigh: SeasonalPattern;
  seasonalLow: SeasonalPattern;
  flashSaleMultiplier: number;      // Unexpected spike ceiling
}

export const trafficModel: TrafficModel = {
  peak: {
    bookingsPerSecond: 1667,
    bookingsPerMinute: 100000,
    searchQueriesPerSecond: 3889,      // 70% of total traffic
    totalRequestsPerSecond: 5556       // bookings / 0.30
  },
  average: {
    bookingsPerSecond: 800,
    bookingsPerMinute: 48000,
    searchQueriesPerSecond: 1867,
    totalRequestsPerSecond: 2667
  },
  growth: {
    yearOverYearGrowthRate: 0.40,
    projectionYears: 3,
    // 100K * (1.40)^3 = 274,400 bookings/min at peak in 3 years
    peakAt3Years: 274400
  },
  patterns: {
    dailyPeakHour: 14,               // 2 PM UTC (morning US, evening EU)
    dailyPeakMultiplier: 2.5,        // Peak hour is 2.5x daily average
    weekendMultiplier: 0.6,          // Weekends are 60% of weekday traffic
    seasonalHigh: {
      months: [6, 7, 8, 12],
      multiplier: 1.8
    },
    seasonalLow: {
      months: [1, 2, 3, 4, 5, 9, 10, 11],
      multiplier: 0.8
    },
    flashSaleMultiplier: 5.0         // Flash sales can spike to 5x normal
  },
  geographic: {
    'us-east-1': 0.35,
    'eu-west-1': 0.30,
    'ap-southeast-1': 0.25,
    'sa-east-1': 0.10
  }
};

interface SeasonalPattern {
  months: number[];
  multiplier: number;
}
```

**Why model growth?** If you size for today's traffic, you will be re-architecting in 12 months. At 40% annual growth, our 100K/minute peak becomes 274K/minute in three years. We do not build for Year 3 on Day 1 -- that wastes money. But we design so we *can* scale to Year 3 without re-architecting. This means choosing databases that shard, message brokers that partition, and compute that auto-scales.

### Phase 3: Map Requests to Resources

This is the core of capacity planning. You take each request type and figure out exactly what resources it consumes.

### Phase 4: Calculate Infrastructure Requirements

Multiply request resource consumption by traffic volume. Add headroom for safety.

### Phase 5: Validate with Load Testing

Your math is a hypothesis. Load testing is the experiment. Never deploy to production without validating your capacity model against real (or realistic) load.

> **Analogy:** Capacity planning is like figuring out how many cashiers a grocery store needs. You count the average customers per hour, estimate how long each checkout takes, figure out how many lanes to open, and then account for the fact that Saturday at 5 PM is three times busier than Tuesday at 2 PM. Too few lanes and the queue wraps around the store. Too many and you are paying cashiers to stand idle. The math is the same for servers.

---

## 35.2 The Math: From Business Requirements to Server Counts

Before you open any cloud pricing calculator, grab a napkin (or a text editor) and do the arithmetic. Seriously. Senior engineers do this constantly. It takes two minutes and saves you from wildly wrong assumptions.

Our target: **100,000 bookings per minute** at peak.

```
100,000 bookings / 60 seconds = 1,667 bookings per second
```

That is our peak number. But systems do not run at peak all day. Our average is about half of peak:

```
Average: ~800 bookings per second
Peak:    ~1,667 bookings per second
```

Now, each booking is not just one operation. Think about what happens when someone clicks "Book Now":

| Step | Service | Duration | CPU Cost | Memory Cost |
|------|---------|----------|----------|-------------|
| 1 | API Gateway receives HTTP request | ~2 ms | Minimal | ~50 KB |
| 2 | JWT token verification | ~1 ms | ~0.5 ms CPU | ~10 KB |
| 3 | Inventory Service checks availability | ~5 ms | ~2 ms CPU | ~200 KB |
| 4 | Redis distributed lock acquired | ~2 ms | Minimal | ~1 KB |
| 5 | Payment Service charges the card | ~200 ms | ~5 ms CPU (mostly I/O wait) | ~500 KB |
| 6 | Database write (booking record) | ~5 ms | ~3 ms CPU | ~100 KB |
| 7 | Kafka event published | ~3 ms | ~1 ms CPU | ~50 KB |
| 8 | Response sent back | ~1 ms | Minimal | ~20 KB |

Each booking needs roughly **220 ms of wall-clock time** but only about **12 ms of actual CPU time**. The rest is I/O wait -- waiting for the payment gateway, the database, Redis, and Kafka to respond. This distinction matters enormously for capacity planning because Node.js handles I/O wait efficiently with its event loop. One CPU core can juggle many in-flight requests simultaneously.

### The Concurrency Calculation

At 1,667 bookings per second with 220 ms average processing time:

```
Concurrent in-flight requests = 1,667 * 0.22 = ~367

Memory for in-flight requests = 367 * ~1 MB = ~367 MB
```

But wait. Each booking also triggers downstream operations: Kafka consumers processing events, notification emails being queued, analytics being recorded. The total system-wide concurrency is roughly **3x the booking concurrency**:

```
Total system concurrency = 367 * 3 = ~1,100 concurrent operations
```

### From Concurrency to CPU Cores

Node.js is single-threaded per process. One NestJS instance uses one CPU core. But because most of our 220 ms is I/O wait (not CPU computation), each core can handle many concurrent requests.

The key metric is **CPU utilization per request**. If each request uses 12 ms of CPU across 220 ms of wall time:

```
CPU utilization ratio = 12 / 220 = 5.5%
```

This means one CPU core, at 100% utilization, could theoretically handle:

```
Theoretical max per core = 1000 ms / 12 ms = ~83 bookings/second
```

But you never run at 100% CPU. Above 70%, latency spikes due to queuing. So our practical limit:

```
Practical max per core = 83 * 0.70 = ~58 bookings/second
```

For 1,667 bookings per second:

```
CPU cores needed (booking service alone) = 1667 / 58 = ~29 cores
```

Add the search service (3,889 queries/second, ~5 ms CPU each):

```
Search CPU cores = 3889 / (1000/5 * 0.70) = 3889 / 140 = ~28 cores
```

Add other services (user service, notification, analytics, admin):

```
Other services = ~20 cores
```

**Total application CPU cores at peak: ~77 cores**

With a safety margin of 30% for unexpected spikes:

```
Total with headroom = 77 * 1.3 = ~100 cores
```

This is per region. Across 4 regions, multiply by 4 -- but not exactly 4x because traffic is unevenly distributed. The US region handles 35% while South America handles 10%.

```
us-east-1:      100 * 0.35 / 0.25 = 140 cores  (35% traffic, 25% "fair share")
eu-west-1:      100 * 0.30 / 0.25 = 120 cores
ap-southeast-1: 100 * 0.25 / 0.25 = 100 cores
sa-east-1:      100 * 0.10 / 0.25 = 40 cores
```

In practice, we round up to standard instance sizes and add overhead for the Kubernetes system itself.

> **Checkpoint:** If our booking service uses 12 ms of CPU per request and we cap utilization at 70%, how many bookings per second can one CPU core handle? Answer: (1000 / 12) * 0.70 = 58.3 bookings/second. If you can do this math, you can size any service.

---

## 35.3 CPU vs Memory vs Network vs Disk: Finding the Bottleneck

Every service has a bottleneck -- the resource that runs out first. Identifying it correctly prevents you from throwing money at the wrong resource. Here is the bottleneck analysis for each major component of our system:

### The Bottleneck Matrix

| Service | Primary Bottleneck | Secondary | Why |
|---------|-------------------|-----------|-----|
| **API Gateway** | Network bandwidth | CPU (TLS termination) | Moves lots of bytes, TLS handshakes are CPU-intensive |
| **Booking Service** | CPU | Memory | Request parsing, validation, serialization |
| **Search Service** | Memory | CPU | Large result sets cached in memory, JSON serialization |
| **Payment Service** | Network (external) | CPU | Waiting on payment gateway APIs (Stripe, Adyen) |
| **Inventory Service** | CPU | Memory | Lock contention, availability calculations |
| **Notification Service** | Network (external) | Memory | Sending emails/SMS via external APIs |
| **MySQL Primary** | Disk IOPS | CPU | Write-ahead log, index updates, fsync |
| **MySQL Replica** | Network | Disk IOPS | Replication stream, read query I/O |
| **Redis** | Memory | Network | All data in RAM; eviction starts when memory fills |
| **Kafka Brokers** | Disk throughput | Network | Sequential writes to commit log, replication |
| **Elasticsearch** | Memory | Disk IOPS | Inverted indexes in RAM, segment merges |

This matrix drives instance type selection:

```typescript
// capacity/instance-selection.ts
export const instanceStrategy = {
  // CPU-bound services: use compute-optimized instances
  cpuBound: {
    services: ['booking-service', 'inventory-service'],
    instanceFamily: 'c6i',           // AWS Compute Optimized
    reasoning: 'Higher clock speed, more CPU per dollar'
  },

  // Memory-bound services: use memory-optimized instances
  memoryBound: {
    services: ['search-service', 'elasticsearch'],
    instanceFamily: 'r6i',           // AWS Memory Optimized
    reasoning: 'More RAM per dollar, larger L3 cache'
  },

  // Network-bound services: use general purpose with enhanced networking
  networkBound: {
    services: ['api-gateway', 'payment-service', 'notification-service'],
    instanceFamily: 'm6i',           // AWS General Purpose
    reasoning: 'Balanced resources, enhanced networking'
  },

  // I/O-bound services: use storage-optimized instances
  ioBound: {
    services: ['mysql-primary', 'kafka-brokers'],
    instanceFamily: 'i3en',          // AWS Storage Optimized
    reasoning: 'NVMe SSD, high sequential throughput'
  }
};
```

> **Key Term:** **Bottleneck** -- The resource constraint that limits a system's throughput. Adding more of a non-bottleneck resource has zero effect on performance. If your database is IOPS-bound, adding more RAM to it will not make queries faster. You must identify the actual bottleneck and address it specifically.

### Deep Dive: Why MySQL Is IOPS-Bound

Let us trace a single booking write through the database to understand why disk I/O is the bottleneck:

1. **Write-ahead log (WAL)**: MySQL writes the change to the redo log *before* updating the actual table. This is an `fsync` -- a synchronous disk write that guarantees durability. If power cuts out mid-write, the WAL can replay the change on restart.

2. **Index updates**: A booking insert updates at least 3 indexes (primary key, user_id index, property_id index). Each index update is a B-tree modification that may require reading and writing multiple disk pages.

3. **Buffer pool flush**: Modified data pages sit in the InnoDB buffer pool (RAM) and get flushed to disk periodically. Under heavy write load, the flush rate becomes the ceiling.

Each booking write generates roughly **4-6 IOPS**. At 4,000 writes per shard per second:

```
IOPS per shard = 4000 * 5 = 20,000 IOPS
```

This is why we use `io2` storage provisioned at 64,000 IOPS -- we need headroom above the 20,000 baseline for read queries, background maintenance, and spikes.

> **What If You Skip This?** If you put a CPU-bound service on a memory-optimized instance, you are paying premium prices for RAM you do not need while being starved of the CPU cycles you do need. Or worse: if you put your database on an instance with default EBS storage (3,000 IOPS baseline), it will hit the IOPS ceiling under moderate load, queries will queue, and your entire application will slow to a crawl. Matching instance types to bottleneck types is not micro-optimization -- it is the difference between a working system and one that collapses at 30% of target load.

---

## 35.4 The Full Traffic Model

Here is the complete traffic model for our system. Every number in this model drives a decision downstream -- how many database shards, how many Redis nodes, how many Kafka brokers.

```typescript
// capacity/full-traffic-model.ts
export const trafficModel = {
  peak: {
    bookingsPerSecond: 1666,
    bookingsPerMinute: 100000,
    bookingsPerHour: 6000000,
    searchQueriesPerSecond: 3889,
    totalRequestsPerSecond: 5556
  },
  average: {
    bookingsPerSecond: 800,
    bookingsPerMinute: 48000,
    bookingsPerHour: 2880000,
    searchQueriesPerSecond: 1867,
    totalRequestsPerSecond: 2667
  },
  readWriteRatio: { reads: 0.70, writes: 0.30 },
  geographic: {
    'us-east-1': 0.35,
    'eu-west-1': 0.30,
    'ap-southeast-1': 0.25,
    'sa-east-1': 0.10
  },
  seasonal: {
    highSeason: { months: [6, 7, 8, 12], multiplier: 1.8 },
    lowSeason: { months: [1, 2, 3, 4, 5, 9, 10, 11], multiplier: 0.8 }
  },
  bookingTypes: {
    hotel: 0.45,
    flight: 0.35,
    car: 0.15,
    package: 0.05
  },
  // Growth projections
  growth: {
    year1: { multiplier: 1.0,  peakPerMinute: 100000 },
    year2: { multiplier: 1.4,  peakPerMinute: 140000 },
    year3: { multiplier: 1.96, peakPerMinute: 196000 },
    year4: { multiplier: 2.74, peakPerMinute: 274000 }
  }
};
```

Let me walk through the pieces you might not immediately understand:

**`readWriteRatio`**: For every 10 requests, 7 are reads (searching, browsing, checking availability) and 3 are writes (creating bookings, processing payments). This ratio determines how we split database capacity between primary instances (which handle writes) and read replicas (which handle reads).

**`geographic`**: Traffic is not evenly distributed. More people book from North America and Europe than from South America. We deploy servers in four AWS regions so that a user in Tokyo gets routed to `ap-southeast-1` instead of crossing the Pacific to `us-east-1`. Each region gets capacity proportional to its traffic share.

**`seasonal`**: Travel booking has seasons. Summer months (June-August) and December see 1.8x normal traffic. January through March is quieter at 0.8x. This means our peak of 100,000/minute during high season corresponds to ~44,000/minute during low season. We need auto-scaling to avoid paying for summer capacity in February.

**`growth`**: At 40% year-over-year growth, our infrastructure needs nearly triple within three years. We provision for Year 1 but architect for Year 4. The difference: provisioning means paying for servers today; architecting means designing so we *can* add servers without re-engineering.

> **Checkpoint:** If our peak is 1,667 bookings per second and the read-to-write ratio is 70/30, how many total requests per second do we need to handle at peak? Answer: 1,667 / 0.30 = ~5,556 total requests/second, of which 70% (3,889) are reads. If that calculation made sense, you are thinking about capacity correctly.

---

## 35.5 Database Capacity: IOPS, Storage Growth, and Connection Pools

The database is the beating heart of any booking system. If the application layer is under-provisioned, users see slow responses. If the database is under-provisioned, users see *errors* -- failed writes, timeouts, data inconsistencies. Getting database capacity right is not optional.

### Calculating IOPS Requirements

IOPS -- Input/Output Operations Per Second -- is the currency of database performance. Every query your application runs translates to one or more IOPS on the storage layer.

Let us trace how our booking traffic translates to IOPS:

```typescript
// capacity/database-iops.ts

/**
 * IOPS calculation for our booking platform.
 *
 * Each booking write generates multiple IOPS because the database must:
 * 1. Write to the write-ahead log (WAL/redo log) -- sequential write
 * 2. Update the primary key index (B-tree insert) -- random read + write
 * 3. Update secondary indexes (user_id, property_id, dates) -- random I/O
 * 4. Flush dirty pages from buffer pool to disk -- background writes
 */
export const iopsModel = {
  // Write operations
  booking: {
    writesPerBooking: 1,
    iopsPerWrite: 5,        // 1 WAL + 3 index updates + 1 flush
    description: 'INSERT into bookings table with 3 secondary indexes'
  },
  payment: {
    writesPerBooking: 2,    // payment_intent + payment_confirmation
    iopsPerWrite: 4,
    description: 'Two writes: authorization and capture'
  },
  inventory: {
    writesPerBooking: 1,    // UPDATE availability
    iopsPerWrite: 3,
    description: 'UPDATE with index scan and row lock'
  },
  auditLog: {
    writesPerBooking: 3,    // Multiple audit entries per booking
    iopsPerWrite: 2,
    description: 'Append-only inserts, minimal indexing'
  },

  // Read operations
  availabilityCheck: {
    readsPerBooking: 3,     // Check overlapping dates, room types, pricing
    iopsPerRead: 4,
    description: 'Range scan on date index with filter conditions'
  },
  userLookup: {
    readsPerBooking: 1,
    iopsPerRead: 2,
    description: 'Primary key lookup, usually cached in buffer pool'
  },
  searchQuery: {
    readsPerSearch: 5,
    iopsPerRead: 8,
    description: 'Multi-table JOIN with sorting and pagination'
  }
};

/**
 * Calculate total IOPS for a given throughput.
 * This is the function you run before choosing your storage tier.
 */
export function calculateTotalIOPS(bookingsPerSecond: number, searchesPerSecond: number) {
  const writeIOPS =
    bookingsPerSecond * iopsModel.booking.iopsPerWrite +
    bookingsPerSecond * iopsModel.payment.writesPerBooking * iopsModel.payment.iopsPerWrite +
    bookingsPerSecond * iopsModel.inventory.iopsPerWrite +
    bookingsPerSecond * iopsModel.auditLog.writesPerBooking * iopsModel.auditLog.iopsPerWrite;

  const readIOPS =
    bookingsPerSecond * iopsModel.availabilityCheck.readsPerBooking *
      iopsModel.availabilityCheck.iopsPerRead +
    bookingsPerSecond * iopsModel.userLookup.iopsPerRead +
    searchesPerSecond * iopsModel.searchQuery.readsPerSearch *
      iopsModel.searchQuery.iopsPerRead;

  return {
    writeIOPS,                           // Goes to primary
    readIOPS,                            // Split across replicas
    totalIOPS: writeIOPS + readIOPS,
    recommendation: writeIOPS > 50000
      ? 'Use provisioned IOPS (io2) or Aurora I/O-Optimized'
      : 'GP3 with baseline may suffice'
  };
}

// At peak: 1,667 bookings/sec, 3,889 searches/sec
// calculateTotalIOPS(1667, 3889) =>
//   writeIOPS: 1667*(5 + 2*4 + 3 + 3*2) = 1667 * 22 = 36,674
//   readIOPS: 1667*(3*4 + 2) + 3889*(5*8) = 1667*14 + 3889*40 = 23,338 + 155,560 = 178,898
//   totalIOPS: 215,572
//   recommendation: 'Use provisioned IOPS (io2) or Aurora I/O-Optimized'
```

215,000 total IOPS across the system. That is a big number but it divides across shards:

```
Total IOPS:       215,572
Database shards:  8
IOPS per shard:   ~27,000
Read replicas:    2 per shard (16 total)
Write IOPS per primary shard: 36,674 / 8 = ~4,584
Read IOPS per replica: 178,898 / 16 = ~11,181
```

Each primary shard needs ~5,000 write IOPS and each replica needs ~11,000 read IOPS. An AWS `io2` volume provisioned at 16,000 IOPS per shard gives us comfortable headroom.

### Storage Growth Calculation

Databases do not just need IOPS -- they accumulate data over time. You need to project storage growth to avoid the dreaded "disk full" alert at 3 AM.

```typescript
// capacity/storage-growth.ts
export const storageGrowthModel = {
  bookingRecord: {
    averageSizeBytes: 2048,      // ~2 KB per booking row including indexes
    description: 'Core booking data: dates, guest info, pricing, status'
  },
  paymentRecord: {
    averageSizeBytes: 1536,      // ~1.5 KB per payment
    description: 'Payment intents, charges, refund records'
  },
  auditLog: {
    averageSizeBytes: 512,       // ~0.5 KB per audit entry
    entriesPerBooking: 5,        // Created, confirmed, payment, notification, completed
    description: 'Immutable audit trail per booking lifecycle'
  },
  searchIndex: {
    averageSizeBytes: 4096,      // ~4 KB per property listing in Elasticsearch
    description: 'Denormalized property data with geo, amenities, pricing'
  },
  indexes: {
    overheadMultiplier: 1.4,     // Indexes add ~40% on top of raw data
    description: 'B-tree indexes on frequently queried columns'
  },
  walAndBinlog: {
    retentionDays: 7,
    dailySizeGB: 50,             // Write-ahead logs before rotation
    description: 'Transaction logs for point-in-time recovery'
  }
};

export function projectStorageGrowth(monthlyBookings: number, months: number) {
  const perBookingBytes =
    storageGrowthModel.bookingRecord.averageSizeBytes +
    storageGrowthModel.paymentRecord.averageSizeBytes +
    storageGrowthModel.auditLog.averageSizeBytes *
      storageGrowthModel.auditLog.entriesPerBooking;

  const rawMonthlyGB = (monthlyBookings * perBookingBytes) / (1024 ** 3);
  const withIndexes = rawMonthlyGB * storageGrowthModel.indexes.overheadMultiplier;

  const projections = [];
  let cumulative = 0;
  for (let m = 1; m <= months; m++) {
    cumulative += withIndexes;
    projections.push({
      month: m,
      monthlyDataGB: Math.round(withIndexes),
      cumulativeGB: Math.round(cumulative),
      cumulativeTB: (cumulative / 1024).toFixed(2)
    });
  }

  return projections;
}

// With 48,000 bookings/min average * 60 * 24 * 30 = ~2.07 billion bookings/month
// Per booking: 2048 + 1536 + (512 * 5) = 6,144 bytes = 6 KB
// Monthly raw data: 2.07B * 6 KB = 12.4 TB raw + 40% indexes = 17.4 TB/month
//
// That is enormous. This is why we archive old bookings to cold storage
// and keep only 90 days of hot data in the primary database.
```

> **Mentor Note:** Those numbers look terrifying. 17 TB per month? In practice, you implement a **data lifecycle policy**. Bookings older than 90 days move to an archive database (cheaper storage, lower IOPS). Bookings older than 2 years move to cold storage (S3 with Glacier). Your primary database only holds the hot 90-day window, which is roughly 52 TB -- large but manageable with sharding across 8 instances at ~6.5 TB each.

### Connection Pool Sizing

Connection pools are one of the most misunderstood aspects of database capacity planning. Too few connections and your application queues requests. Too many and the database drowns juggling context switches between thousands of connections.

```typescript
// capacity/connection-pool.ts
export const connectionPoolConfig = {
  /**
   * Rule of thumb for PostgreSQL/MySQL connection limits:
   *   max_connections = (CPU cores * 2) + effective_spindle_count
   *
   * For a 16-core database instance with SSD (treating as 1 spindle):
   *   max_connections = (16 * 2) + 1 = 33
   *
   * Yes, that is surprisingly low. Most developers set this to 200 or 500
   * and then wonder why their database is slow. More connections means more
   * context switching, more lock contention, and more memory usage.
   */
  databaseMaxConnections: 33,

  /**
   * Each NestJS instance gets a pool. The pool size per instance depends on
   * how many instances share the database.
   *
   * If 10 NestJS pods connect to one database shard:
   *   poolSizePerPod = databaseMaxConnections / podCount
   *   poolSizePerPod = 33 / 10 = 3 connections per pod
   *
   * That feels low, and it is. This is why we use ProxySQL (or ProxySQL for
   * MySQL) as a connection pooler between the application and the database.
   * ProxySQL can multiplex 500 application connections onto 33 real database
   * connections using transaction-level pooling.
   */
  poolerConfig: {
    maxClientConnections: 500,      // Application-facing limit per pooler
    defaultPoolSize: 33,            // Database-facing limit per pooler
    reservePoolSize: 5,             // Emergency overflow connections
    poolMode: 'transaction',        // Recycle connection after each transaction
    serverIdleTimeout: 600,         // Close idle backend connections after 10 min
    clientIdleTimeout: 300          // Close idle client connections after 5 min
  },

  /**
   * NestJS Prisma connection pool configuration.
   * Each pod connects to ProxySQL, NOT directly to the database.
   */
  nestjsPoolConfig: {
    type: 'mysql',
    extra: {
      connectionLimit: 10,           // 10 connections from this pod to the pooler
      waitForConnections: true,
      queueLimit: 50,                // Max requests waiting for a connection
      connectTimeout: 5000,          // 5 second connection timeout
      acquireTimeout: 10000          // 10 second wait to acquire from pool
    }
  }
};
```

> **Analogy:** Think of database connections like phone lines to a call center. The database has 33 phone lines (CPU-limited). You have 100 NestJS pods that want to call in. Without a connection pooler, each pod would need 3 dedicated phone lines, and most of those lines sit idle 95% of the time. A connection pooler is like a switchboard operator who shares the 33 lines across all callers -- when a pod finishes its transaction, the connection goes back to the pool immediately for someone else to use. The result: 100 pods share 33 connections smoothly, with each transaction getting a connection for just the milliseconds it needs.

---

## 35.6 Redis Memory Planning

Redis is our caching layer, our session store, our distributed lock manager, and our rate limiter. It is a Swiss Army knife, but it has one sharp constraint: **everything lives in memory**. When memory runs out, Redis either rejects writes or evicts existing keys. Neither is acceptable if you have not planned for it.

### Key Count and Memory Estimation

```typescript
// capacity/redis-memory.ts
export const redisMemoryModel = {
  /**
   * Category 1: Session data
   * Each logged-in user has a session stored in Redis.
   */
  sessions: {
    activeUsers: 500000,            // Concurrent active sessions
    avgKeySize: 48,                 // "session:{uuid}" = ~48 bytes
    avgValueSize: 2048,             // User profile, permissions, preferences
    ttlSeconds: 86400,              // 24-hour session expiry
    totalMemoryMB: function() {
      return (this.activeUsers * (this.avgKeySize + this.avgValueSize)) / (1024 ** 2);
    }
    // 500,000 * 2,096 bytes = ~1,000 MB = ~1 GB
  },

  /**
   * Category 2: Search result cache
   * Popular search queries are cached to avoid hitting Elasticsearch.
   */
  searchCache: {
    uniqueQueries: 2000000,         // 2M unique search combinations
    avgKeySize: 128,                // "search:{hash}" with query parameters
    avgValueSize: 8192,             // Serialized search results (top 20 results)
    ttlSeconds: 300,                // 5-minute cache (availability changes fast)
    totalMemoryMB: function() {
      return (this.uniqueQueries * (this.avgKeySize + this.avgValueSize)) / (1024 ** 2);
    }
    // 2,000,000 * 8,320 bytes = ~15,860 MB = ~15.5 GB
  },

  /**
   * Category 3: Rate limiting counters
   * Sliding window counters per user per endpoint.
   */
  rateLimiting: {
    uniqueKeys: 5000000,            // Users * endpoints
    avgKeySize: 64,                 // "ratelimit:{userId}:{endpoint}"
    avgValueSize: 64,               // Counter + timestamp in sorted set
    ttlSeconds: 60,                 // 1-minute sliding window
    totalMemoryMB: function() {
      return (this.uniqueKeys * (this.avgKeySize + this.avgValueSize)) / (1024 ** 2);
    }
    // 5,000,000 * 128 bytes = ~610 MB
  },

  /**
   * Category 4: Distributed locks
   * One lock per property-date combination being booked.
   */
  distributedLocks: {
    concurrentLocks: 5000,          // Active locks at any moment
    avgKeySize: 64,                 // "lock:property:{id}:date:{date}"
    avgValueSize: 128,              // Lock owner, expiry, metadata
    ttlSeconds: 30,                 // Lock auto-expires after 30 seconds
    totalMemoryMB: function() {
      return (this.concurrentLocks * (this.avgKeySize + this.avgValueSize)) / (1024 ** 2);
    }
    // 5,000 * 192 bytes = ~0.9 MB (negligible)
  },

  /**
   * Category 5: Inventory availability cache
   * Cached availability for properties to avoid DB hits on every search.
   */
  inventoryCache: {
    properties: 1000000,            // 1M active properties
    datesPerProperty: 90,           // 90-day availability window
    avgKeySize: 48,                 // "avail:{propertyId}:{date}"
    avgValueSize: 32,               // Available room count + price
    ttlSeconds: 60,                 // 1-minute freshness
    totalMemoryMB: function() {
      const totalKeys = this.properties * this.datesPerProperty;
      return (totalKeys * (this.avgKeySize + this.avgValueSize)) / (1024 ** 2);
    }
    // 90,000,000 * 80 bytes = ~6,866 MB = ~6.7 GB
  },

  /**
   * Redis internal overhead: pointers, hashtable buckets, SDS strings.
   * Rule of thumb: add 30% on top of raw data for Redis internal structures.
   */
  overheadMultiplier: 1.3
};

export function calculateTotalRedisMemory() {
  const sessionsGB = redisMemoryModel.sessions.totalMemoryMB() / 1024;
  const searchGB = redisMemoryModel.searchCache.totalMemoryMB() / 1024;
  const rateLimitGB = redisMemoryModel.rateLimiting.totalMemoryMB() / 1024;
  const locksGB = redisMemoryModel.distributedLocks.totalMemoryMB() / 1024;
  const inventoryGB = redisMemoryModel.inventoryCache.totalMemoryMB() / 1024;

  const rawTotal = sessionsGB + searchGB + rateLimitGB + locksGB + inventoryGB;
  const withOverhead = rawTotal * redisMemoryModel.overheadMultiplier;

  return {
    breakdown: {
      sessions: `${sessionsGB.toFixed(1)} GB`,
      searchCache: `${searchGB.toFixed(1)} GB`,
      rateLimiting: `${rateLimitGB.toFixed(1)} GB`,
      distributedLocks: `${locksGB.toFixed(3)} GB`,
      inventoryCache: `${inventoryGB.toFixed(1)} GB`
    },
    rawTotalGB: rawTotal.toFixed(1),
    withOverheadGB: withOverhead.toFixed(1),
    recommendation: withOverhead > 50
      ? 'Use Redis Cluster with multiple shards'
      : 'Single Redis instance with replica may suffice'
  };
}

// Result:
//   sessions:        1.0 GB
//   searchCache:    15.5 GB
//   rateLimiting:    0.6 GB
//   locks:           0.001 GB
//   inventoryCache:  6.7 GB
//   ---
//   Raw total:      23.8 GB
//   With overhead:  30.9 GB
//   Recommendation: "Use Redis Cluster with multiple shards"
```

### TTL Strategy and Eviction Policies

Not all Redis keys are equal. Some must *never* be evicted (distributed locks). Some *should* be evicted when memory is tight (search cache). This requires a deliberate TTL and eviction strategy.

```typescript
// capacity/redis-eviction.ts
export const redisEvictionStrategy = {
  /**
   * Redis maxmemory-policy determines what happens when memory is full.
   *
   * Options:
   * - noeviction:       Return errors on write (good for critical data)
   * - allkeys-lru:      Evict least-recently-used keys (good for pure cache)
   * - volatile-lru:     Evict LRU keys that HAVE a TTL set (our choice)
   * - allkeys-lfu:      Evict least-frequently-used keys
   * - volatile-ttl:     Evict keys closest to expiration
   *
   * We use volatile-lru because:
   * 1. Locks have TTLs but are short-lived and small -- they will not be evicted
   * 2. Search cache has TTLs and is the biggest memory consumer -- it will be
   *    evicted first under memory pressure (which is fine, it is a cache)
   * 3. Rate limit counters have TTLs and are small -- low eviction priority
   * 4. Session data has TTLs -- will be evicted only if truly necessary
   */
  policy: 'volatile-lru',

  /**
   * Set maxmemory to 75% of physical RAM.
   * The remaining 25% is for:
   * - Redis overhead (child processes for RDB/AOF persistence)
   * - OS page cache
   * - Copy-on-write during BGSAVE
   */
  maxmemoryPercent: 75,

  /**
   * TTL guidelines per data category:
   */
  ttlPolicy: {
    sessions:       { ttl: 86400,  reason: '24h -- users re-authenticate daily' },
    searchCache:    { ttl: 300,    reason: '5min -- availability changes frequently' },
    rateLimiting:   { ttl: 60,     reason: '1min -- sliding window resets' },
    distributedLocks: { ttl: 30,   reason: '30s -- if holder crashes, lock auto-releases' },
    inventoryCache: { ttl: 60,     reason: '1min -- balance freshness vs DB load' },
    userPreferences: { ttl: 3600,  reason: '1h -- changes infrequently' }
  }
};
```

> **What If You Skip This?** Without memory planning, you will wake up one night to an alert: "Redis OOM (Out of Memory)." Redis will start rejecting writes. Your distributed locks will fail. Bookings will double-charge customers. Your rate limiter will stop working, allowing DDoS traffic through. And your search cache will disappear, sending 100% of queries to Elasticsearch, which is not sized for that load and will also fall over. One Redis misconfiguration cascades into a full system outage.

---

## 35.7 Kafka Throughput Planning

Kafka is the nervous system of our platform. Every booking event, payment confirmation, inventory update, and notification trigger flows through Kafka. Under-provisioning Kafka means events back up, consumers fall behind, and the system loses its real-time capability.

### Partition Count Planning

Partitions are the unit of parallelism in Kafka. More partitions means more consumers can process events simultaneously. But too many partitions increase metadata overhead, leader election time, and end-to-end latency.

```typescript
// capacity/kafka-partitions.ts
export const kafkaPartitionModel = {
  /**
   * Rule of thumb for partition count:
   *   partitions = max(T/P, T/C)
   *
   * Where:
   *   T = target throughput (messages/sec)
   *   P = throughput per producer partition (~10,000 msg/sec for small messages)
   *   C = throughput per consumer partition (~5,000 msg/sec with processing)
   *
   * Consumer throughput is usually the bottleneck because consumers do actual
   * work (database writes, API calls) while producers just serialize and send.
   */
  topics: {
    'booking.events': {
      throughputPerSecond: 1667,      // One event per booking
      messageAvgBytes: 2048,          // Booking event payload
      consumerProcessingMs: 50,       // Time to process each event
      // Consumer throughput: 1000/50 = 20 msg/sec per consumer
      // Partitions needed: 1667/20 = 84 partitions
      // Round up to nearest power-of-2 friendly number: 96
      partitions: 96,
      replicationFactor: 3,
      retentionHours: 168             // 7 days
    },
    'payment.events': {
      throughputPerSecond: 1667,
      messageAvgBytes: 1536,
      consumerProcessingMs: 200,      // Payment processing is slower
      // Consumer throughput: 1000/200 = 5 msg/sec per consumer
      // Partitions needed: 1667/5 = 334 partitions
      // This is too many. Instead, use async processing with batching.
      // With batch size 10: 1667/50 = 34 partitions
      partitions: 48,                 // With batched consumers
      replicationFactor: 3,
      retentionHours: 720             // 30 days (financial data)
    },
    'inventory.updates': {
      throughputPerSecond: 2000,       // Availability changes
      messageAvgBytes: 512,
      consumerProcessingMs: 10,
      // Consumer throughput: 1000/10 = 100 msg/sec per consumer
      // Partitions needed: 2000/100 = 20
      partitions: 24,
      replicationFactor: 3,
      retentionHours: 24              // 1 day
    },
    'notification.triggers': {
      throughputPerSecond: 500,
      messageAvgBytes: 1024,
      consumerProcessingMs: 100,      // Template rendering + API call
      // Partitions needed: 500/10 = 50
      partitions: 48,
      replicationFactor: 3,
      retentionHours: 72              // 3 days
    },
    'analytics.events': {
      throughputPerSecond: 5000,       // Click tracking, page views
      messageAvgBytes: 256,
      consumerProcessingMs: 5,
      // Partitions needed: 5000/200 = 25
      partitions: 32,
      replicationFactor: 2,           // Analytics can tolerate some loss
      retentionHours: 48              // 2 days
    }
  }
};
```

### Broker Sizing and Retention Storage

```typescript
// capacity/kafka-brokers.ts
export function calculateKafkaStorage(model: typeof kafkaPartitionModel) {
  let totalBytesPerSecond = 0;
  const topicStorage: Record<string, string> = {};

  for (const [topicName, config] of Object.entries(model.topics)) {
    const bytesPerSecond = config.throughputPerSecond * config.messageAvgBytes;
    const bytesPerHour = bytesPerSecond * 3600;
    const retentionBytes = bytesPerHour * config.retentionHours;
    const withReplication = retentionBytes * config.replicationFactor;

    totalBytesPerSecond += bytesPerSecond;
    topicStorage[topicName] = `${(withReplication / (1024 ** 4)).toFixed(2)} TB`;
  }

  return {
    topicStorage,
    totalThroughputMBps: (totalBytesPerSecond / (1024 ** 2)).toFixed(1),
    totalNetworkMBps: (totalBytesPerSecond * 3 / (1024 ** 2)).toFixed(1) // 3x for replication
  };
}

// Results:
//   booking.events:       1667 * 2048 = 3.4 MB/s * 168h * 3 replicas = 6.1 TB
//   payment.events:       1667 * 1536 = 2.6 MB/s * 720h * 3 replicas = 19.3 TB
//   inventory.updates:    2000 * 512  = 1.0 MB/s * 24h * 3 replicas  = 0.3 TB
//   notification.triggers: 500 * 1024 = 0.5 MB/s * 72h * 3 replicas  = 0.4 TB
//   analytics.events:     5000 * 256  = 1.3 MB/s * 48h * 2 replicas  = 0.4 TB
//   ---
//   Total storage: ~26.5 TB across cluster
//   Total throughput: ~8.8 MB/s ingress (26.4 MB/s with replication)

export const kafkaBrokerSizing = {
  /**
   * Broker count formula:
   *   brokers = max(
   *     ceil(totalStorage / storagePerBroker),
   *     ceil(totalPartitions / partitionsPerBroker),
   *     ceil(totalThroughput / throughputPerBroker),
   *     minBrokersForReplication
   *   )
   */
  storagePerBrokerTB: 4,            // 4 TB NVMe per broker
  maxPartitionsPerBroker: 2000,     // Kafka recommendation
  maxThroughputPerBrokerMBps: 100,  // Network limit per broker

  calculate: function() {
    const totalPartitions = 96 + 48 + 24 + 48 + 32; // 248
    const totalStorageTB = 26.5;
    const totalThroughputMBps = 26.4;

    return {
      byStorage: Math.ceil(totalStorageTB / this.storagePerBrokerTB),     // 7
      byPartitions: Math.ceil(totalPartitions / this.maxPartitionsPerBroker), // 1
      byThroughput: Math.ceil(totalThroughputMBps / this.maxThroughputPerBrokerMBps), // 1
      minForReplication: 3,          // Need at least 3 for RF=3
      // Answer: max(7, 1, 1, 3) = 7 brokers
      recommended: 9                // 7 + 2 for headroom and rolling upgrades
    };
  }
};
```

### Consumer Lag Monitoring

Consumer lag is the number of messages that have been produced but not yet consumed. It is the canary in the coal mine for Kafka capacity problems.

```typescript
// capacity/kafka-consumer-lag.ts
export const consumerLagThresholds = {
  /**
   * Lag is measured in number of messages behind the latest offset.
   * We set thresholds per topic based on business criticality.
   */
  'booking.events': {
    warningLag: 1000,         // Warn if 1,000+ messages behind
    criticalLag: 10000,       // Page on-call if 10,000+ behind
    maxAcceptableLatencyMs: 5000,  // Consumer must process within 5s of production
    action: 'Scale up consumers immediately -- bookings are being delayed'
  },
  'payment.events': {
    warningLag: 100,          // Payment events are highest priority
    criticalLag: 1000,
    maxAcceptableLatencyMs: 2000,
    action: 'Payment processing delayed -- potential double-charge risk'
  },
  'inventory.updates': {
    warningLag: 5000,
    criticalLag: 50000,
    maxAcceptableLatencyMs: 10000,
    action: 'Inventory cache becoming stale -- overselling risk'
  },
  'notification.triggers': {
    warningLag: 10000,
    criticalLag: 100000,
    maxAcceptableLatencyMs: 60000,  // 1 minute is acceptable for notifications
    action: 'Notification delays -- users not receiving confirmations promptly'
  },
  'analytics.events': {
    warningLag: 100000,
    criticalLag: 1000000,
    maxAcceptableLatencyMs: 300000, // 5 minutes is fine for analytics
    action: 'Analytics pipeline behind -- dashboards showing stale data'
  }
};
```

> **Checkpoint:** If the `booking.events` topic receives 1,667 messages per second and each consumer can process 20 messages per second, how many consumer instances do you need to keep lag at zero? Answer: 1,667 / 20 = 84 consumers (rounded up). But you also need headroom for rebalancing and restarts, so deploy 96 -- matching the partition count, since you cannot have more active consumers than partitions in a consumer group.

---

## 35.8 Horizontal vs Vertical Scaling: The Decision Framework

You will hear people debate this constantly. "Just get a bigger server" versus "just add more servers." Both are tools, and choosing the wrong one at the wrong time wastes money or creates unnecessary complexity. Here is the framework for deciding.

### When to Scale Vertically (Bigger Machines)

Vertical scaling means upgrading to a larger instance -- more CPU cores, more RAM, faster disks. It is the simplest path and should be your **first response** when a service is hitting limits.

| Use Vertical Scaling When | Why |
|---------------------------|-----|
| Single-threaded bottleneck (e.g., one Node.js process maxed out) | Adding more instances does not help if the bottleneck is one process |
| Database write primary is overloaded | You cannot easily split writes across multiple primaries |
| The service holds in-memory state that is expensive to distribute | Splitting state requires re-architecture |
| You are below the ceiling of available instance sizes | A c6i.8xlarge (32 vCPU) is cheaper than managing 8x c6i.xlarge |
| Time pressure -- you need relief in minutes, not days | Resizing an instance takes minutes; re-architecting takes weeks |

**Vertical scaling limits for our platform:**

```
Service              Current Instance    Max Vertical Size    Practical Ceiling
────────────────────────────────────────────────────────────────────────────────
Booking Service      c6i.2xlarge (8c)    c6i.24xlarge (96c)   ~12x headroom
MySQL Primary        r6i.4xlarge (16c)   r6i.24xlarge (96c)   ~6x headroom
Redis                r6g.2xlarge (8c)    r6g.16xlarge (64c)   ~8x headroom
Elasticsearch        r6i.4xlarge (16c)   r6i.24xlarge (96c)   ~6x headroom
Kafka Brokers        i3en.2xlarge (8c)   i3en.24xlarge (96c)  ~12x headroom
```

### When to Scale Horizontally (More Machines)

Horizontal scaling means adding more instances running the same service behind a load balancer. It provides theoretically unlimited scale but introduces distributed system complexity.

| Use Horizontal Scaling When | Why |
|-----------------------------|-----|
| You have hit the vertical ceiling | Largest available instance is not enough |
| The workload is stateless and parallelizable | NestJS API services are perfect candidates |
| You need fault tolerance | N+1 instances survive a single instance failure |
| Traffic is spiky and auto-scaling saves money | You cannot resize a single instance fast enough |
| Read-heavy workloads | Adding read replicas is cheaper than a bigger primary |

```typescript
// capacity/scaling-decision.ts
export function scalingDecision(service: {
  name: string;
  currentUtilization: number;   // 0-100 percent
  isStateless: boolean;
  canShard: boolean;
  currentInstanceSize: string;
  maxInstanceSize: string;
  hasVerticalHeadroom: boolean;
  timeToHorizontalScale: string;  // e.g., "3 weeks" for re-architecture
}): 'vertical' | 'horizontal' | 'both' {
  // If utilization is above 70% and there is vertical headroom, scale up first
  // This buys time for the horizontal scaling work
  if (service.currentUtilization > 70 && service.hasVerticalHeadroom) {
    if (service.isStateless && service.currentUtilization > 85) {
      return 'both';   // Scale up NOW, scale out in parallel
    }
    return 'vertical'; // Scale up and plan horizontal for later
  }

  // If no vertical headroom, horizontal is the only option
  if (!service.hasVerticalHeadroom) {
    return 'horizontal';
  }

  // If stateless and easy to scale out, prefer horizontal for cost efficiency
  if (service.isStateless && service.canShard) {
    return 'horizontal';
  }

  return 'vertical';   // Default: simpler is better
}
```

> **Mentor Note:** In practice, you will often do both. You vertically scale to survive today while horizontally scaling for tomorrow. The booking service is a perfect example: when CPU hits 80%, immediately resize the pod to a larger instance class (takes 2 minutes). In parallel, increase the replica count from 10 to 15 pods (takes 5 minutes). Then later, optimize the code so each pod handles more requests per CPU-second (takes days or weeks). All three approaches work together.

### The Cost Crossover Point

There is a specific utilization level where horizontal scaling becomes cheaper than vertical. Below this point, a single large instance is more cost-effective. Above it, multiple smaller instances win.

```
Instance Type       vCPU    RAM (GB)    Cost/Hour    Cost per vCPU/Hour
────────────────────────────────────────────────────────────────────────
c6i.xlarge           4       8          $0.170       $0.0425
c6i.2xlarge          8      16          $0.340       $0.0425
c6i.4xlarge         16      32          $0.680       $0.0425
c6i.8xlarge         32      64          $1.360       $0.0425
c6i.12xlarge        48      96          $2.040       $0.0425
c6i.16xlarge        64     128          $2.720       $0.0425
c6i.24xlarge        96     192          $4.080       $0.0425
```

Notice that in the `c6i` family, cost per vCPU is linear -- no premium for larger instances. This is true for most AWS compute-optimized families. But for memory-optimized instances (`r6i`), the ratio changes at higher tiers, and you pay a premium for the largest sizes. Check the arithmetic before assuming "bigger is always proportionally more expensive."

The real cost difference comes from **operational overhead**. Running 10 small instances requires load balancing, health checking, rolling deployment configuration, and distributed tracing. Running 1 large instance requires none of that. Factor in your team's operational maturity when choosing.

---

## 35.9 Auto-Scaling Policies

Static provisioning wastes money. Our traffic varies 3x between daily peak and off-peak, and 1.8x between summer high season and winter low season. Auto-scaling adjusts capacity to match actual demand.

### CPU-Based Auto-Scaling (The Baseline)

CPU-based scaling is the simplest and most common policy. It works well for compute-bound services.

```typescript
// capacity/autoscaling-policies.ts

/**
 * Kubernetes Horizontal Pod Autoscaler (HPA) configuration
 * for each service in our booking platform.
 */
export const autoscalingPolicies = {
  bookingService: {
    minReplicas: 8,              // Never go below this (handles base traffic)
    maxReplicas: 60,             // Cost ceiling
    metrics: [
      {
        type: 'Resource',
        resource: {
          name: 'cpu',
          target: {
            type: 'Utilization',
            averageUtilization: 65   // Scale out when average CPU > 65%
          }
        }
      }
    ],
    behavior: {
      scaleUp: {
        stabilizationWindowSeconds: 60,   // Wait 60s before scaling up again
        policies: [
          {
            type: 'Percent',
            value: 50,                     // Add up to 50% more pods at once
            periodSeconds: 60
          }
        ]
      },
      scaleDown: {
        stabilizationWindowSeconds: 300,  // Wait 5 min before scaling down
        policies: [
          {
            type: 'Percent',
            value: 20,                     // Remove at most 20% of pods at once
            periodSeconds: 120
          }
        ]
      }
    }
  },

  searchService: {
    minReplicas: 10,
    maxReplicas: 80,
    metrics: [
      {
        type: 'Resource',
        resource: {
          name: 'cpu',
          target: { type: 'Utilization', averageUtilization: 60 }
        }
      },
      {
        // Custom metric: scale on request latency too
        type: 'Pods',
        pods: {
          metric: { name: 'http_request_duration_p95_ms' },
          target: {
            type: 'AverageValue',
            averageValue: '400m'           // Scale if P95 > 400ms
          }
        }
      }
    ],
    behavior: {
      scaleUp: {
        stabilizationWindowSeconds: 30,    // Search needs fast scale-up
        policies: [
          { type: 'Percent', value: 100, periodSeconds: 30 }  // Double pods if needed
        ]
      },
      scaleDown: {
        stabilizationWindowSeconds: 600,   // 10 min cooldown before scale-down
        policies: [
          { type: 'Percent', value: 10, periodSeconds: 120 }
        ]
      }
    }
  }
};
```

### Custom Metrics Auto-Scaling

CPU is a lagging indicator. By the time CPU spikes, users are already experiencing latency. Custom metrics let you scale on leading indicators -- request queue depth, Kafka consumer lag, or pending booking count.

```typescript
// capacity/custom-metrics-scaler.ts

/**
 * KEDA (Kubernetes Event Driven Autoscaling) scalers for event-driven
 * services. KEDA can scale based on Kafka consumer lag, Redis queue
 * length, or any Prometheus metric.
 */
export const kedaScalers = {
  paymentConsumer: {
    trigger: 'kafka',
    metadata: {
      bootstrapServers: 'kafka-headless:9092',
      consumerGroup: 'payment-processor',
      topic: 'payment.events',
      lagThreshold: '100',             // Scale when lag > 100 messages
      offsetResetPolicy: 'latest'
    },
    minReplicaCount: 4,
    maxReplicaCount: 48,
    cooldownPeriod: 120,
    pollingInterval: 10                // Check lag every 10 seconds
  },

  notificationConsumer: {
    trigger: 'kafka',
    metadata: {
      bootstrapServers: 'kafka-headless:9092',
      consumerGroup: 'notification-sender',
      topic: 'notification.triggers',
      lagThreshold: '500',
      offsetResetPolicy: 'latest'
    },
    minReplicaCount: 2,
    maxReplicaCount: 48,
    cooldownPeriod: 300,
    pollingInterval: 15
  },

  inventoryUpdater: {
    trigger: 'prometheus',
    metadata: {
      serverAddress: 'http://prometheus:9090',
      metricName: 'inventory_stale_cache_ratio',
      threshold: '0.15',               // Scale when >15% of cache is stale
      query: 'sum(inventory_cache_misses) / sum(inventory_cache_total)'
    },
    minReplicaCount: 4,
    maxReplicaCount: 24,
    cooldownPeriod: 60,
    pollingInterval: 10
  }
};
```

### Predictive Scaling

The best scaling policies do not react to load -- they anticipate it. If you know that traffic peaks at 2 PM UTC every weekday, you can pre-scale 30 minutes before the peak instead of scrambling to catch up.

```typescript
// capacity/predictive-scaling.ts
export const predictiveScalingSchedule = {
  /**
   * Scheduled scaling adjustments based on known traffic patterns.
   * These run via Kubernetes CronJobs that patch HPA minReplicas.
   */
  weekdaySchedule: [
    { cron: '0 6 * * 1-5',  action: 'Set booking-service minReplicas=15',
      reason: 'EU morning traffic ramp-up begins' },
    { cron: '0 12 * * 1-5', action: 'Set booking-service minReplicas=30',
      reason: 'US East + EU overlap -- approaching daily peak' },
    { cron: '0 14 * * 1-5', action: 'Set booking-service minReplicas=45',
      reason: 'Daily peak: US morning + EU afternoon' },
    { cron: '0 18 * * 1-5', action: 'Set booking-service minReplicas=25',
      reason: 'EU evening wind-down, US still active' },
    { cron: '0 22 * * 1-5', action: 'Set booking-service minReplicas=12',
      reason: 'Night mode: low traffic across all regions' },
    { cron: '0 2 * * 1-5',  action: 'Set booking-service minReplicas=8',
      reason: 'Overnight minimum -- only APAC traffic' }
  ],

  weekendSchedule: [
    { cron: '0 6 * * 0,6',  action: 'Set booking-service minReplicas=10',
      reason: 'Weekend traffic is 60% of weekday' },
    { cron: '0 14 * * 0,6', action: 'Set booking-service minReplicas=25',
      reason: 'Weekend peak is lower than weekday' },
    { cron: '0 22 * * 0,6', action: 'Set booking-service minReplicas=8',
      reason: 'Weekend evening wind-down' }
  ],

  seasonalAdjustments: [
    { date: 'June 1',   action: 'Multiply all minReplicas by 1.5',
      reason: 'High season begins -- summer travel bookings surge' },
    { date: 'Sept 1',   action: 'Reset all minReplicas to baseline',
      reason: 'High season ends -- return to normal levels' },
    { date: 'Nov 20',   action: 'Multiply all minReplicas by 2.0',
      reason: 'Holiday season: Thanksgiving through New Year' },
    { date: 'Jan 5',    action: 'Reset all minReplicas to baseline',
      reason: 'Holiday season ends' }
  ]
};
```

> **Key Term:** **Predictive scaling** -- Adjusting infrastructure capacity in advance of expected load changes, based on historical traffic patterns. Unlike reactive scaling (which responds to current metrics), predictive scaling pre-provisions resources before demand arrives, eliminating the 2-5 minute lag during which users experience degraded performance while new instances boot and warm up.

---

## 35.10 Load Testing: Validating Your Capacity Model

All the math in the world is a hypothesis until you test it. Load testing is how you validate that your capacity model matches reality. It is also how you discover bottlenecks you did not predict.

### k6 Load Test: Complete Booking Flow

k6 is a modern load testing tool written in Go. It uses JavaScript for test scripts, making it natural for Node.js developers. Here is a complete booking flow simulation:

```javascript
// load-tests/booking-flow.k6.js
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics to track business KPIs alongside technical metrics
const bookingSuccessRate = new Rate('booking_success_rate');
const bookingDuration = new Trend('booking_e2e_duration');
const paymentErrors = new Counter('payment_errors');
const searchLatency = new Trend('search_p95_latency');

// Test configuration: ramp up to peak traffic over 10 minutes,
// hold for 20 minutes, then ramp down.
export const options = {
  stages: [
    { duration: '2m',  target: 100 },    // Warm-up: 100 virtual users
    { duration: '3m',  target: 500 },    // Ramp to moderate load
    { duration: '5m',  target: 1667 },   // Ramp to peak (1667 bookings/sec)
    { duration: '20m', target: 1667 },   // Sustained peak load
    { duration: '5m',  target: 500 },    // Ramp down to moderate
    { duration: '2m',  target: 0 },      // Cool down
  ],
  thresholds: {
    // Business SLA thresholds -- test FAILS if these are violated
    'booking_success_rate':     ['rate>0.995'],    // 99.5% success rate
    'booking_e2e_duration':     ['p(95)<2000'],     // P95 under 2 seconds
    'search_p95_latency':       ['p(95)<500'],      // P95 search under 500ms
    'http_req_failed':          ['rate<0.01'],       // Less than 1% HTTP errors
    'http_req_duration':        ['p(99)<3000'],      // P99 under 3 seconds
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://api.staging.bookingplatform.com';

export default function () {
  const userId = `loadtest-user-${__VU}-${__ITER}`;
  let authToken;

  // Step 1: Authenticate
  group('Authentication', () => {
    const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
      email: `${userId}@loadtest.internal`,
      password: 'loadtest-password-hash',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    check(loginRes, {
      'login successful': (r) => r.status === 200,
      'token received': (r) => r.json('accessToken') !== undefined,
    });

    authToken = loginRes.json('accessToken');
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };

  // Step 2: Search for availability
  group('Search availability', () => {
    const checkIn = randomFutureDate(7, 90);
    const checkOut = addDays(checkIn, randomInt(1, 7));
    const city = randomCity();

    const searchRes = http.get(
      `${BASE_URL}/search?city=${city}&checkIn=${checkIn}&checkOut=${checkOut}&guests=2`,
      { headers }
    );

    check(searchRes, {
      'search returns results': (r) => r.status === 200,
      'search has properties': (r) => r.json('results.length') > 0,
    });

    searchLatency.add(searchRes.timings.duration);
  });

  sleep(randomFloat(0.5, 2.0));  // Think time: user browses results

  // Step 3: Create a booking
  group('Create booking', () => {
    const startTime = Date.now();
    const propertyId = randomPropertyId();
    const checkIn = randomFutureDate(7, 90);
    const checkOut = addDays(checkIn, randomInt(1, 7));

    const bookingRes = http.post(`${BASE_URL}/bookings`, JSON.stringify({
      propertyId,
      checkIn,
      checkOut,
      guests: 2,
      roomType: 'standard',
      paymentMethod: 'tok_visa_loadtest',
    }), { headers });

    const success = bookingRes.status === 201;
    bookingSuccessRate.add(success);

    if (!success) {
      if (bookingRes.status >= 500) {
        paymentErrors.add(1);
      }
    }

    check(bookingRes, {
      'booking created': (r) => r.status === 201,
      'booking has ID': (r) => r.json('bookingId') !== undefined,
      'booking under 2s': (r) => r.timings.duration < 2000,
    });

    bookingDuration.add(Date.now() - startTime);
  });

  sleep(randomFloat(1.0, 3.0));  // Think time before next iteration
}

// Helper functions
function randomFutureDate(minDays, maxDays) {
  const offset = randomInt(minDays, maxDays);
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
  return Math.random() * (max - min) + min;
}

function randomCity() {
  const cities = ['new-york', 'london', 'paris', 'tokyo', 'sydney',
                  'berlin', 'dubai', 'singapore', 'toronto', 'barcelona'];
  return cities[randomInt(0, cities.length - 1)];
}

function randomPropertyId() {
  return `prop-${randomInt(1, 1000000)}`;
}
```

### Running the Load Test

```bash
# Run against staging environment
k6 run \
  --env BASE_URL=https://api.staging.bookingplatform.com \
  --out influxdb=http://influxdb:8086/k6 \
  load-tests/booking-flow.k6.js

# Run with higher concurrency for stress testing
k6 run \
  --env BASE_URL=https://api.staging.bookingplatform.com \
  --vus 2000 \
  --duration 30m \
  --out influxdb=http://influxdb:8086/k6 \
  load-tests/booking-flow.k6.js
```

### Interpreting Load Test Results

After a load test run, you will see output like this:

```
     ✓ booking_success_rate...: 99.72%  ✓ 58321  ✗ 163
     ✓ booking_e2e_duration...: avg=847ms  p(90)=1423ms  p(95)=1812ms  p(99)=2891ms
     ✓ search_p95_latency....: avg=198ms  p(90)=387ms   p(95)=456ms   p(99)=723ms
     ✓ http_req_duration......: avg=423ms  p(90)=980ms   p(95)=1356ms  p(99)=2456ms
     ✗ http_req_failed........: 0.28% -- PASSED (threshold: < 1%)
       iterations.............: 58484  163.5/s

     THRESHOLDS:
     ✓ booking_success_rate  : rate > 0.995 → 99.72% PASS
     ✓ booking_e2e_duration  : p95 < 2000   → 1812ms PASS
     ✓ search_p95_latency   : p95 < 500    → 456ms  PASS (barely)
     ✓ http_req_failed      : rate < 0.01  → 0.28%  PASS
     ✓ http_req_duration    : p99 < 3000   → 2456ms PASS
```

Read it like a report card. Every threshold either passes or fails. If `search_p95_latency` barely passes at 456ms (threshold 500ms), that is a warning: you are close to the edge and have no headroom. Investigate what happens at 1.5x the target load before you launch.

> **Analogy:** Load testing is like a dress rehearsal for a theater production. You run through the entire show with full lights, full sound, full cast -- not just one scene at a time. You discover that the lighting rig overheats during Act 3, that the scene change in Act 2 takes 45 seconds too long, and that the sound system clips when five actors speak simultaneously. You would never skip the dress rehearsal and hope opening night goes well. Load testing is your dress rehearsal.

---

## 35.11 Capacity Planning Spreadsheet Template

Every senior engineer I have worked with keeps some version of this spreadsheet. It is the single document that connects business requirements to infrastructure costs. Here is the template:

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    CAPACITY PLANNING WORKSHEET                               ║
║                    Global Booking Platform v2.0                              ║
║                    Last Updated: 2026-02-15                                  ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  SECTION 1: BUSINESS REQUIREMENTS                                            ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Target throughput (peak):       100,000 bookings/minute                     ║
║  Latency SLA (search P95):       500 ms                                      ║
║  Latency SLA (booking P99):      2,000 ms                                    ║
║  Availability target:            99.99%                                      ║
║  Growth rate (YoY):              40%                                         ║
║  Planning horizon:               3 years                                     ║
║  Data residency:                 EU (GDPR), PCI-DSS isolation               ║
║                                                                              ║
║  SECTION 2: TRAFFIC MODEL                                                    ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Peak bookings/sec:              1,667                                       ║
║  Peak searches/sec:              3,889                                       ║
║  Peak total reqs/sec:            5,556                                       ║
║  Average reqs/sec:               2,667                                       ║
║  Daily peak multiplier:          2.5x                                        ║
║  Seasonal high multiplier:       1.8x                                        ║
║  Flash sale multiplier:          5.0x                                        ║
║                                                                              ║
║  SECTION 3: COMPUTE (per region, primary region shown)                       ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Service              Instances  Type         vCPU  RAM    Cost/hr   Mo.Cost  ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  API Gateway           8         m6i.xlarge    4    16 GB  $0.192   $1,106   ║
║  Booking Service      15         c6i.2xlarge   8    16 GB  $0.340   $3,672   ║
║  Search Service       12         r6i.2xlarge   8    64 GB  $0.504   $4,355   ║
║  Payment Service       8         m6i.xlarge    4    16 GB  $0.192   $1,106   ║
║  Inventory Service    10         c6i.xlarge    4     8 GB  $0.170   $1,224   ║
║  Notification Service  6         m6i.large     2     8 GB  $0.096   $  415   ║
║  Analytics Service     4         m6i.large     2     8 GB  $0.096   $  277   ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  Subtotal Compute:                            248   960 GB          $12,155  ║
║                                                                              ║
║  SECTION 4: DATA STORES (per region)                                         ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Component             Instances  Type          Storage   IOPS     Mo.Cost   ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  MySQL Primary          3         r6i.4xlarge   2 TB io2  16K ea   $6,480   ║
║  MySQL Replicas          6         r6i.2xlarge   2 TB gp3  3K ea    $5,184   ║
║  Redis Cluster           6         r6g.2xlarge   --        --       $3,110   ║
║  Elasticsearch           6         r6i.4xlarge   1 TB gp3  3K ea    $5,832   ║
║  Kafka Brokers           9         i3en.2xlarge  5 TB NVMe --       $5,832   ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  Subtotal Data Stores:                                             $26,438  ║
║                                                                              ║
║  SECTION 5: NETWORKING & SUPPORTING                                          ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Load Balancer (ALB):              $800/month                                ║
║  NAT Gateway:                      $500/month                                ║
║  Data transfer (inter-AZ):         $2,000/month                              ║
║  Data transfer (internet):         $3,000/month                              ║
║  CloudWatch/Monitoring:            $500/month                                ║
║  Secrets Manager + KMS:            $200/month                                ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  Subtotal Networking:              $7,000/month                              ║
║                                                                              ║
║  SECTION 6: TOTAL COST SUMMARY                                              ║
║  ──────────────────────────────────────────────────────────────────────────── ║
║  Per-region monthly cost:          $45,593                                   ║
║  All 4 regions (adjusted):         $145,898                                  ║
║  Reserved Instance discount (1yr): -30%  →  $102,129                        ║
║  Savings Plan discount (3yr):      -45%  →  $80,244                         ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  FINAL ESTIMATED COST:             $80,000 - $102,000/month                 ║
║  Annual cost:                      $960,000 - $1,224,000                    ║
║                                                                              ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

> **Mentor Note:** This spreadsheet is a living document. Update it every quarter as actual traffic data replaces projections. Review it before every major feature launch. Share it with your finance team so they can budget accurately. The worst thing for engineering credibility is surprising the CFO with a cloud bill that is 3x the estimate.

---

## 35.12 Growth Projections: 10x Planning Without 10x Cost

The worst capacity planning mistake is building for today. The second worst is building for 10x on Day 1. The sweet spot is **designing for 10x but provisioning for 1x**. Here is how.

### The Design-vs-Provision Distinction

```typescript
// capacity/growth-strategy.ts

/**
 * PROVISION means paying for infrastructure today.
 * DESIGN means making architectural choices that allow scaling later.
 *
 * You should DESIGN for 10x on Day 1 and PROVISION for 1x.
 * Then provision incrementally as traffic grows.
 */
export const growthStrategy = {
  designDecisions: {
    /**
     * These choices cost nothing today but enable 10x scale later.
     * Make these decisions on Day 1.
     */
    database: 'Use sharded MySQL from the start, even if you only use 1 shard',
    cache: 'Use Redis Cluster mode, even if you only use 1 node',
    messaging: 'Use Kafka with partitioned topics, even at low throughput',
    compute: 'Deploy on Kubernetes with HPA, even if minReplicas=2',
    storage: 'Use object storage (S3) for media, never local disk',
    ids: 'Use UUIDs or Snowflake IDs, never auto-increment across shards',
    sessions: 'Store sessions in Redis, never in-process memory',
    config: 'Use environment variables and feature flags, never hardcoded config'
  },

  provisioningSchedule: {
    /**
     * Provision infrastructure just ahead of need. Each milestone
     * triggers the next provisioning step.
     */
    milestones: [
      {
        trigger: 'Traffic exceeds 50% of current capacity',
        action: 'Begin provisioning next tier',
        leadTime: '2 weeks',
        reason: 'Provisioning takes time; start before you hit the wall'
      },
      {
        trigger: 'Database shard exceeds 500 GB',
        action: 'Split into 2 shards',
        leadTime: '1 month',
        reason: 'Shard splitting requires data migration and testing'
      },
      {
        trigger: 'Redis memory exceeds 60% of maxmemory',
        action: 'Add cluster node and rebalance slots',
        leadTime: '1 week',
        reason: 'Redis rebalancing is online but should be done during low traffic'
      },
      {
        trigger: 'Kafka consumer lag sustained above warning for 1 hour',
        action: 'Add partitions and consumer instances',
        leadTime: '1 day',
        reason: 'Adding partitions is fast; adding consumers is instant'
      },
      {
        trigger: 'P95 latency exceeds 80% of SLA for 3 consecutive days',
        action: 'Scale out the bottleneck service',
        leadTime: 'Immediate (auto-scaling) or 1 day (manual review)',
        reason: 'Sustained latency degradation means capacity is insufficient'
      }
    ]
  }
};
```

### The Cost Curve: Why 10x Traffic Does Not Mean 10x Cost

This is the insight that separates junior engineers from senior ones. Infrastructure cost scales **sublinearly** with traffic for well-architected systems. Here is why:

```
Traffic       Compute Cost    Data Store Cost    Total Cost    Cost per Booking
────────────────────────────────────────────────────────────────────────────────
1x (today)    $12,000/mo      $26,000/mo         $45,000/mo   $0.0045
2x            $20,000/mo      $35,000/mo         $65,000/mo   $0.0033  (-27%)
5x            $45,000/mo      $60,000/mo         $120,000/mo  $0.0024  (-47%)
10x           $80,000/mo      $100,000/mo        $200,000/mo  $0.0020  (-56%)
```

**Why does cost per booking decrease?** Three reasons:

1. **Fixed costs amortize.** Kubernetes control plane, load balancers, monitoring, NAT gateways -- these cost the same whether you serve 1,000 or 100,000 requests per second. At higher traffic, the fixed cost per booking shrinks.

2. **Utilization improves.** At 1x traffic, your auto-scaling keeps instances at 40-60% average utilization to handle spikes. At 10x, the spikes are proportionally smaller (law of large numbers), and average utilization can safely run at 65-75%.

3. **Volume discounts kick in.** Reserved Instances, Savings Plans, and committed-use discounts get deeper at higher spend levels. Enterprise agreements with cloud providers include custom discounts above certain spending thresholds.

> **Checkpoint:** If your system costs $45,000/month at 1x traffic and handles 100,000 bookings per minute, what is the cost per booking? Answer: $45,000 / (100,000 * 60 * 24 * 30) = $0.000010 per booking, or about one-thousandth of a cent. At this unit economics level, infrastructure cost is negligible compared to payment processing fees (~2.9%) or customer acquisition cost. This perspective helps you argue for adequate infrastructure investment.

---

## 35.13 NestJS Performance Tuning

Before you throw more hardware at the problem, make sure your application is not wasting the hardware it already has. NestJS runs on Node.js, and Node.js has specific performance characteristics that reward certain patterns and punish others.

### Connection Pooling Best Practices

```typescript
// performance/prisma-pool.config.ts

/**
 * Prisma connection pool configuration optimized for high throughput.
 *
 * Key insight: the pool size should match your database connection
 * budget per pod, NOT the number of concurrent requests. If your
 * ProxySQL allows 10 connections per pod, set the pool to 10.
 *
 * Prisma manages connection pooling via the DATABASE_URL query parameters.
 */

// In your .env or environment configuration:
// DATABASE_URL="mysql://user:password@proxysql-host:6033/booking_db?connection_limit=10&connect_timeout=5&pool_timeout=10"

// In prisma/schema.prisma:
// datasource db {
//   provider = "mysql"
//   url      = env("DATABASE_URL")
// }

// For programmatic control in NestJS, wrap PrismaClient with pool settings:
import { PrismaClient } from '@prisma/client';

export function createOptimizedPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL,   // Points to ProxySQL, not DB directly
      },
    },
    log: process.env.NODE_ENV === 'production'
      ? [{ emit: 'event', level: 'error' }]
      : [{ emit: 'stdout', level: 'query' },
         { emit: 'stdout', level: 'error' },
         { emit: 'stdout', level: 'warn' }],
  });
}
```

### Async Optimization Patterns

```typescript
// performance/async-optimization.service.ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class BookingOptimizedService {
  private readonly logger = new Logger(BookingOptimizedService.name);

  /**
   * ANTI-PATTERN: Sequential async calls.
   * Each await blocks until the previous resolves.
   * Total time: sum of all individual call durations.
   */
  async createBookingSlow(dto: CreateBookingDto) {
    const user = await this.userService.findById(dto.userId);          // 10ms
    const property = await this.propertyService.findById(dto.propertyId); // 15ms
    const availability = await this.inventoryService.check(dto);        // 20ms
    const pricing = await this.pricingService.calculate(dto);           // 25ms
    // Total: 70ms -- each call waits for the previous one
    // But these four calls are INDEPENDENT. None needs the result of another.
  }

  /**
   * OPTIMIZED: Parallel async calls with Promise.all.
   * All independent calls run simultaneously.
   * Total time: max of individual call durations (not sum).
   */
  async createBookingFast(dto: CreateBookingDto) {
    const [user, property, availability, pricing] = await Promise.all([
      this.userService.findById(dto.userId),               // 10ms ─┐
      this.propertyService.findById(dto.propertyId),       // 15ms ─┤ All run
      this.inventoryService.check(dto),                    // 20ms ─┤ in parallel
      this.pricingService.calculate(dto),                  // 25ms ─┘
    ]);
    // Total: 25ms (the slowest call) -- 2.8x faster than sequential

    // Now do the sequential part that actually depends on the results
    if (!availability.isAvailable) {
      throw new ConflictException('Property not available for selected dates');
    }

    const booking = await this.bookingRepository.save({
      user,
      property,
      pricing,
      status: 'pending',
    });

    // Fire-and-forget for non-critical operations
    // Do NOT await these -- they are not part of the user-facing response
    this.eventEmitter.emit('booking.created', booking);    // Kafka publish
    this.analyticsService.track('booking_created', booking); // Analytics

    return booking;
  }

  /**
   * ADVANCED: Promise.allSettled for operations where partial failure is OK.
   * Unlike Promise.all (which rejects if ANY promise rejects), allSettled
   * waits for ALL promises and reports individual results.
   */
  async enrichBookingDetails(bookingId: string) {
    const results = await Promise.allSettled([
      this.weatherService.getForecast(bookingId),         // Nice to have
      this.reviewService.getPropertyReviews(bookingId),   // Nice to have
      this.recommendationService.getSuggestions(bookingId), // Nice to have
    ]);

    // Process results -- some may have failed, and that is OK
    const enrichments: Record<string, any> = {};
    const labels = ['weather', 'reviews', 'recommendations'];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        enrichments[labels[index]] = result.value;
      } else {
        this.logger.warn(`Failed to fetch ${labels[index]}: ${result.reason}`);
        enrichments[labels[index]] = null;  // Graceful degradation
      }
    });

    return enrichments;
  }
}
```

### Event Loop Health Monitoring

```typescript
// performance/event-loop-monitor.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';

/**
 * The Node.js event loop is the heart of your application.
 * If it blocks, EVERY request in that process stalls.
 *
 * This monitor measures event loop lag -- the delay between when
 * a timer is scheduled and when it actually fires. Healthy lag
 * is under 10ms. Above 50ms, users notice. Above 200ms, you have
 * a serious problem.
 */
@Injectable()
export class EventLoopMonitor implements OnModuleInit {
  private lagHistogram: Histogram;
  private blockCounter: Counter;

  onModuleInit() {
    this.lagHistogram = new Histogram({
      name: 'nodejs_event_loop_lag_ms',
      help: 'Event loop lag in milliseconds',
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    });

    this.blockCounter = new Counter({
      name: 'nodejs_event_loop_blocks_total',
      help: 'Number of times event loop was blocked > 50ms',
    });

    // Measure event loop lag every 100ms
    this.startMonitoring();
  }

  private startMonitoring() {
    let lastCheck = process.hrtime.bigint();

    setInterval(() => {
      const now = process.hrtime.bigint();
      const expectedInterval = 100_000_000n; // 100ms in nanoseconds
      const actualInterval = now - lastCheck;
      const lag = Number(actualInterval - expectedInterval) / 1_000_000; // to ms

      if (lag > 0) {
        this.lagHistogram.observe(lag);
      }

      if (lag > 50) {
        this.blockCounter.inc();
        // Something blocked the event loop for >50ms -- investigate!
        // Common causes: synchronous file I/O, JSON.parse of huge objects,
        // crypto operations, regex backtracking, or large array operations
      }

      lastCheck = now;
    }, 100);
  }
}
```

> **What If You Skip This?** Without async optimization, a booking request that could complete in 25ms takes 70ms -- nearly 3x worse. Multiply that by 1,667 requests per second and you need 3x more servers to achieve the same throughput. At $12,000/month in compute, that is $24,000/month wasted because of sequential awaits. Code optimization is the cheapest form of scaling.

---

## 35.14 Production War Story: The Black Friday Meltdown

*Based on a real incident. Names and specifics changed.*

### The Setup

The year was 2023. TravelFast (not their real name) was a mid-size online travel agency. They had done their capacity planning -- or so they thought. They sized their infrastructure for 2x their normal peak, which itself was based on the previous year's Black Friday traffic. They figured 2x headroom was conservative enough.

Their stack: NestJS microservices on Kubernetes, MySQL with 4 shards, Redis cluster, Kafka for event streaming. Everything ran on AWS. Their normal peak was 8,000 bookings per minute. They provisioned for 16,000.

### The Timeline

**Friday, November 24, 8:00 AM EST** -- Marketing launches their "Biggest Travel Sale Ever" campaign. Emails go to 12 million subscribers. Social media ads go live across Facebook, Instagram, and Google. There is a countdown timer on the homepage.

**8:30 AM** -- Traffic starts climbing. 5,000 requests per second. Normal. Auto-scaling adds pods. Everything is green.

**9:00 AM** -- Traffic hits 12,000 requests per second. Still under their 16,000 ceiling. But something is off. Payment Service latency is climbing: P95 goes from 400ms to 1,200ms. The on-call engineer checks Stripe's status page. Stripe is fine.

**9:15 AM** -- Payment Service P95 hits 3,000ms. Booking success rate drops from 99.5% to 87%. The engineer discovers the problem: **MySQL connection pool exhaustion**. Each Payment Service pod has 20 database connections. With 3,000ms payment calls, those connections are held open waiting for Stripe responses. At 12,000 req/s, the connection pool drains in seconds.

**9:20 AM** -- The engineer increases the connection pool to 50 per pod. This makes things *worse*. Now MySQL shard 2 is drowning under 200 connections (10 pods * 50 connections = 500, divided across 4 shards = 125 per shard). The shard's CPU hits 100%. Queries queue. Replication lag on the read replicas goes to 30 seconds.

**9:30 AM** -- With replication lag at 30 seconds, the Search Service is showing stale availability data. Users search, see rooms available, click "Book Now," and get an error because the room was actually booked 30 seconds ago. Customer complaints flood in.

**9:45 AM** -- The team tries to scale up MySQL by failover to a larger instance. The failover takes 4 minutes. During those 4 minutes, all writes to shard 2 fail. Kafka fills with failed payment events. The dead letter queue grows to 15,000 messages.

**10:00 AM** -- MySQL is back on a larger instance. Connection pool is reduced to 10 per pod. But now Kafka consumer lag on `payment.events` is 45,000 messages. Payment confirmations are backed up. Customers who successfully booked are not receiving confirmation emails. They try booking again, creating duplicates.

**10:15 AM** -- The team discovers duplicate bookings. They spin up an emergency deduplication job. But some duplicates already charged the customer's credit card twice. The refund process begins.

**10:30 AM** -- Traffic peaks at 25,000 requests per second -- 3x their provisioned capacity, not the 2x they planned for. The auto-scaler tries to add pods, but the Kubernetes nodes are at capacity. New node provisioning takes 4 minutes. During that window, the API Gateway starts returning 503 errors.

**11:00 AM** -- New nodes are online. Traffic is stabilizing. But the damage is done: 2,300 duplicate charges, 45 minutes of degraded service, and a cascade of angry tweets.

### The Postmortem: What Went Wrong

| Root Cause | What They Should Have Done |
|------------|---------------------------|
| Connection pools were too large, drowning the database | Use a connection pooler (ProxySQL) between app and DB |
| Payment calls held DB connections during external API calls | Separate external API calls from database transactions |
| No circuit breaker on payment gateway | Implement circuit breaker that fails fast when Stripe is slow |
| MySQL shard 2 was on an undersized instance | All shards should be the same size; the hot shard should have been identified |
| Auto-scaler could not provision nodes fast enough | Use Karpenter or over-provision warm nodes for burst capacity |
| No deduplication mechanism | Implement idempotency keys on the booking API |
| Capacity model assumed 2x was enough | Use 5x peak for flash sale events and validate with load testing |
| No load testing at 3x+ capacity | Run seasonal load tests that simulate Black Friday specifically |

### The Lesson

Their capacity model was not wrong -- it was **incomplete**. They sized for 2x of normal peak but did not account for the compounding effect: marketing email + social ads + countdown timer + flash sale pricing all hitting simultaneously. The real multiplier was not 2x. It was 3.1x.

They also failed to model the *cascade*. One bottleneck (connection pool) caused a second (database overload), which caused a third (replication lag), which caused a fourth (stale data), which caused a fifth (duplicate bookings). Each failure domain amplified the next.

> **Mentor Note:** Every production incident teaches you something your capacity model missed. After this incident, TravelFast rebuilt their model with these additions: (1) connection pool modeling as a first-class resource, (2) circuit breaker failure modes, (3) 5x multiplier for marketing-driven spikes, and (4) quarterly load tests at 3x peak. They never had another Black Friday incident. The cost of preventing this incident would have been approximately $5,000 in additional infrastructure and 2 weeks of engineering time. The cost of the incident was $180,000 in refunds, $50,000 in customer credits, and immeasurable brand damage.

---

## 35.15 Common Mistakes in Capacity Planning

These are the mistakes I see again and again, from startups to Fortune 500 companies. Each one has cost real teams real money.

### Mistake 1: Planning for Average, Not Peak

**What happens:** You size for 2,667 requests per second (the average) instead of 5,556 (the peak). At 2 PM when traffic doubles, your system falls over.

**The fix:** Always size for peak. Use auto-scaling to avoid paying for peak capacity during off-peak hours. Your baseline (minReplicas) should handle average traffic. Your maximum should handle 1.5x peak.

### Mistake 2: Ignoring the Cascade Effect

**What happens:** You size each component independently. The database can handle 20,000 IOPS. Redis can handle 100,000 operations per second. But when the database is slow, Redis gets hammered with retries, which overloads Redis, which makes everything slower, which generates more retries.

**The fix:** Model your system as a graph, not as independent components. Test failure modes: "What happens when the database is 3x slower than normal?" Run chaos engineering experiments in staging.

### Mistake 3: Forgetting About Connection Limits

**What happens:** You add more application pods to handle more traffic. Each pod opens 10 database connections. At 50 pods, that is 500 connections to the database. MySQL starts thrashing between connections and query latency doubles.

**The fix:** Use connection poolers (ProxySQL, ProxySQL). Set a hard limit on total database connections. Monitor connection usage as a first-class metric.

### Mistake 4: Not Accounting for Serialization Overhead

**What happens:** Your benchmark shows the database can handle 10,000 queries per second. But in production, each query result must be serialized to JSON, which consumes CPU on the application server. The actual throughput is 6,000 queries per second because JSON serialization takes 40% of your CPU budget.

**The fix:** Include serialization and deserialization in your per-request CPU calculation. For large payloads, consider binary formats (Protocol Buffers, MessagePack) or streaming JSON parsers.

### Mistake 5: Linear Growth Assumptions

**What happens:** Traffic grew 20% last year, so you plan for 20% growth this year. But the marketing team is launching in 3 new countries, adding a mobile app, and running their first Super Bowl ad. Actual growth is 200%.

**The fix:** Get growth projections from the business team, not from last year's data. Ask about planned marketing campaigns, new market launches, and partnership announcements. Add a buffer for organic growth acceleration.

### Mistake 6: Skipping Load Testing

**What happens:** Your capacity model says you can handle 5,000 requests per second. You deploy and discover at 3,000 requests per second that a poorly-indexed database query causes a table scan under concurrent load. Your theoretical capacity was never achievable.

**The fix:** Always load test. Test at 1x, 2x, and 3x your target capacity. Fix every bottleneck you find at each level before declaring the system ready.

### Mistake 7: Over-Provisioning Out of Fear

**What happens:** After a bad outage, the team triples everything "just to be safe." The cloud bill goes from $80,000 to $240,000 per month. Average CPU utilization is 15%. The CFO starts asking questions.

**The fix:** Use auto-scaling with well-tuned policies. Monitor actual utilization. Right-size quarterly. The goal is 60-70% average utilization at normal traffic, with auto-scaling to handle peaks.

### Mistake 8: Ignoring Cold Start and Warm-Up Time

**What happens:** Auto-scaling adds 10 new pods when traffic spikes. Each pod takes 30 seconds to start, 15 seconds to load configuration, and 20 seconds to warm up its JIT compiler and connection pools. For 65 seconds, those pods are not handling real traffic. Meanwhile, the existing pods are overwhelmed.

**The fix:** Optimize pod startup time. Use readiness probes that only mark a pod as ready after warmup. Over-provision slightly so auto-scaling has time to react. Consider predictive scaling for known traffic patterns.

> **Analogy:** Capacity planning mistakes are like building a chain. Each link (database, cache, API, message broker) has a strength rating. The chain breaks at its weakest link. You can have a database capable of 100,000 IOPS and an API capable of 50,000 requests per second, but if your connection pool only supports 100 concurrent connections, the chain breaks at 100 concurrent requests. Capacity planning is the discipline of ensuring every link is strong enough -- and knowing exactly which link will break first under extreme load.

---

## 35.16 Chapter Summary

This chapter covered the complete capacity planning process for a production-grade booking platform. Here is the reference table:

| Topic | Key Number | Why It Matters |
|-------|-----------|----------------|
| **Target throughput** | 100,000 bookings/min (1,667/sec) | Drives every sizing decision |
| **CPU per booking** | 12 ms of CPU time in 220 ms wall time | Node.js I/O efficiency means few CPU cycles per request |
| **Cores at peak** | ~100 cores (with 30% headroom) | Application compute for the primary region |
| **Database IOPS** | 215,572 total across system | Split across 8 shards = ~27K per shard |
| **Storage growth** | ~17 TB/month raw (with 90-day hot window) | Requires data lifecycle policy and archival |
| **Connection pool** | 33 connections per database instance | Use a pooler to multiplex application connections |
| **Redis memory** | 31 GB with overhead | Sessions + search cache + rate limiting + locks + inventory |
| **Redis eviction** | volatile-lru policy | Evicts cached data first, protects locks and sessions |
| **Kafka partitions** | 248 total across 5 topics | Sized by consumer processing speed, not producer speed |
| **Kafka brokers** | 9 (7 for storage + 2 for headroom) | Storage-bound at 26.5 TB retention |
| **Scaling strategy** | Vertical first, horizontal for growth | Simpler operations while vertical headroom exists |
| **Auto-scaling** | CPU 65% target, custom metrics for latency | Scale down slowly (5 min cooldown), scale up fast (30-60s) |
| **Predictive scaling** | Pre-scale 30 min before daily peak | Eliminate cold-start lag during traffic ramp |
| **Load testing** | k6 with business SLA thresholds | Validate capacity model before production deployment |
| **Cost estimate** | $80K-$102K/month (4 regions, reserved) | ~$0.001 per booking at scale |
| **Growth curve** | 40% YoY for 3 years = 2.74x | Design for 10x, provision for 1x |
| **NestJS optimization** | Promise.all for parallel async calls | 2.8x latency improvement for independent operations |
| **Event loop health** | Lag under 10ms = healthy | Above 50ms = debug immediately |

### The One-Sentence Summary

Capacity planning is the discipline of converting business requirements into infrastructure math, validating that math with load testing, and automating the gap between minimum cost and maximum resilience.

### What Comes Next

In Chapter 36, we will build on this capacity model and design our **cost optimization strategy** -- how to achieve the same throughput at lower cost using spot instances, reserved capacity, caching hierarchies, and architectural optimizations that reduce resource consumption per request.

---

> **Final Mentor Note:** Capacity planning is never "done." It is a living process that evolves every quarter as traffic patterns change, new features launch, and infrastructure costs shift. The best teams treat their capacity model as code -- version-controlled, peer-reviewed, and tested regularly. Build this discipline early in your career, and you will always be the engineer who can answer the question: "Can our system handle it?" That question comes up more often than you think, and the person who can answer it with numbers instead of opinions is the person who earns the trust of the entire organization.

