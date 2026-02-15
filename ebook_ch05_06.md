# Chapter 5: Database Design -- Why 1 Database Isn't Enough

## 5.1 Starting Simple: One Database

Every project begins with one database. You install MySQL, create your tables, and life is good. For a small booking app handling 50 requests per second, a single MySQL instance is perfectly fine.

Here is the problem: a single MySQL instance caps out around **10,000 writes per second**. Our booking platform targets **100,000 bookings per minute** -- that is 1,666 bookings per second, each touching multiple tables (bookings, inventory, payments, events). The real write load is closer to 8,000-10,000 writes per second.

One database will buckle under that pressure. Queries slow down, locks pile up, and users see timeout errors mid-checkout. You cannot solve this by buying a bigger server forever -- eventually you hit the ceiling of what one machine can do.

> **Analogy:** Imagine a single librarian handling every request in a massive library. Returns, checkouts, questions -- one person. At 10 visitors, no problem. At 10,000 visitors, the line stretches out the door. Hiring more librarians (multiple databases) is the only answer.

## 5.2 Enter Sharding: Filing Cabinets for Data

Sharding splits your data across multiple database servers. Each server (called a **shard**) holds a slice of the total data.

> **Analogy:** Picture an office with filing cabinets sorted by last name. Cabinet 1 holds A-F, Cabinet 2 holds G-L, Cabinet 3 holds M-R, Cabinet 4 holds S-Z. When someone asks for "Smith," you go straight to Cabinet 4. No one blocks Cabinet 1 while you search Cabinet 4. That is sharding -- parallel access to partitioned data.

### How We Shard: hash(user_id) % 16

Our system uses **16 shards**. To determine which shard holds a user's data:

```
shard_number = hash(user_id) % 16
```

Example:
- `user_id = 12345` --> `hash(12345) % 16 = 7` --> route to **shard_07**
- `user_id = 98765` --> `hash(98765) % 16 = 2` --> route to **shard_02**

> **Key Term:** **Shard** -- An independent database server that holds a subset of the total data. Each shard has its own CPU, memory, and storage.

Why `user_id`? Because a user's bookings, payments, and inventory holds all live on the same shard. This means queries like "show me all my bookings" never need to talk to more than one shard.

### Shard Configuration

Each shard has **1 primary** (handles writes) and **4 read replicas** (handle read queries). That gives us:

- 16 primaries for writes (parallel write capacity)
- 64 read replicas for read-heavy operations (search, history)
- Cross-region replication for disaster recovery

> **What If You Skip This?** Without sharding, your single database becomes the bottleneck at around 5,000 concurrent bookings per minute. Users see 5-10 second checkout times, abandoned carts spike, and you lose revenue. Sharding is not optional at this scale.

## 5.3 Core Tables -- The Data Model

Every table below exists on **every shard**. A shard only contains rows for the users assigned to it. Let us walk through each table, column by column.

### 5.3.1 Bookings Table

This is the heart of the system. Every hotel reservation, flight ticket, and car rental becomes one row here.

```sql
CREATE TABLE bookings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- Who and what type
    user_id BIGINT NOT NULL,
    booking_type VARCHAR(20) NOT NULL,     -- 'hotel', 'flight', 'car'
    reference_code VARCHAR(20) NOT NULL UNIQUE,  -- 'HT-20260215-000042'

    -- Idempotency: prevents duplicate bookings if user double-clicks
    idempotency_key VARCHAR(100) NOT NULL,

    -- Pricing
    subtotal DECIMAL(12,2) NOT NULL,       -- Base price before tax
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL,   -- What the user actually pays
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Status tracking
    status ENUM('pending','confirmed','cancelled','completed','refunded')
        DEFAULT 'pending',

    -- Soft delete: we never truly delete financial records
    deleted_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,

    -- Prevent one user from creating duplicate bookings
    UNIQUE KEY uniq_user_idempotency (user_id, idempotency_key),

    -- Ensure money math is correct at the database level
    CONSTRAINT chk_amounts CHECK (
        subtotal >= 0 AND tax_amount >= 0 AND
        discount_amount >= 0 AND total_amount >= 0 AND
        total_amount = (subtotal + tax_amount - discount_amount)
    ),

    -- Indexes for common queries
    INDEX idx_user (user_id, deleted_at),
    INDEX idx_status (status, deleted_at),
    INDEX idx_type (booking_type),
    INDEX idx_created (created_at),
    INDEX idx_reference (reference_code)
) PARTITION BY HASH(user_id) PARTITIONS 16;
```

**Column-by-column breakdown:**

| Column | Why It Exists |
|--------|--------------|
| `id` | BIGINT because INT maxes out at ~2 billion rows. At 100k bookings/minute, you hit that in 2 weeks. |
| `idempotency_key` | If a user's browser sends the same booking request twice (network glitch, double-click), the UNIQUE constraint rejects the duplicate. |
| `DECIMAL(12,2)` | Never use FLOAT for money. FLOAT introduces rounding errors (0.1 + 0.2 = 0.30000000000000004). DECIMAL is exact. |
| `CHAR(3)` for currency | ISO 4217 currency codes are always 3 characters (USD, EUR, GBP). CHAR is faster than VARCHAR for fixed-length data. |
| `deleted_at` | "Soft delete" -- we set a timestamp instead of deleting. Financial records must be retained for audits. |
| `chk_amounts` | The database itself enforces that `total = subtotal + tax - discount`. If application code has a bug, the DB catches it. |

> **Common Mistake:** Using `FLOAT` or `DOUBLE` for currency columns will cause rounding errors in financial calculations. A booking for $19.99 might be stored as $19.9899999. Always use `DECIMAL(12,2)` for money.

### 5.3.2 Inventory Table

This tracks how many rooms/seats/cars are available on any given date.

```sql
CREATE TABLE inventory (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    resource_type ENUM('hotel_room','flight_seat','car') NOT NULL,
    resource_id BIGINT NOT NULL,       -- Which specific room/seat/car
    resource_date DATE NOT NULL,        -- Availability date

    -- Quantity tracking
    total_quantity SMALLINT NOT NULL,       -- Total units available
    available_quantity SMALLINT NOT NULL,   -- Currently bookable
    reserved_quantity SMALLINT NOT NULL DEFAULT 0,  -- Held or booked
    overbooking_limit SMALLINT DEFAULT 0,  -- How much overselling is allowed

    -- Distributed locking (covered in Chapter 11)
    fencing_token BIGINT,

    -- Pricing
    base_price DECIMAL(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Constraints
    CONSTRAINT chk_available_quantity CHECK (available_quantity >= 0),
    CONSTRAINT chk_quantity_balance CHECK (
        available_quantity + reserved_quantity
            <= total_quantity + overbooking_limit
    ),

    -- Fast lookups
    UNIQUE KEY uniq_resource_date (resource_type, resource_id, resource_date),
    INDEX idx_availability (resource_type, resource_date, available_quantity)
);
```

**The overbooking_limit column -- why it exists:**

Airlines routinely overbook flights by 5-10% because roughly 10% of passengers cancel or no-show. Hotels overbook by 1-2%. This is intentional business logic, not a bug.

The `overbooking_limit` column controls exactly how much overselling is permitted per resource per date. The `chk_quantity_balance` constraint ensures that `available + reserved` never exceeds `total + overbooking_limit`. If the hotel has 100 rooms and allows 2% overbooking, you can reserve up to 102.

> **Key Term:** **Overbooking** -- Intentionally accepting more reservations than available capacity, based on statistical cancellation rates. The `overbooking_limit` column makes this a controlled, per-resource decision rather than a system-wide accident.

### 5.3.3 Overbooking Audit Log and MySQL Trigger

Every overbooking event must be logged for regulatory compliance and revenue management.

```sql
CREATE TABLE overbooking_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    resource_type VARCHAR(20) NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,

    -- Snapshot at time of overbooking
    total_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL,
    overbooking_limit SMALLINT NOT NULL,
    actual_oversell SMALLINT NOT NULL,

    -- Who triggered it
    triggered_by_booking_id BIGINT,
    triggered_by_user_id BIGINT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_resource (resource_type, resource_id, resource_date),
    INDEX idx_booking (triggered_by_booking_id)
);
```

Now the trigger that populates this table automatically:

```sql
DELIMITER //

CREATE TRIGGER log_overbooking_event
AFTER UPDATE ON inventory
FOR EACH ROW
BEGIN
    -- DECLARE must be at the TOP of BEGIN, before any IF/WHILE
    DECLARE v_oversell SMALLINT;

    SET v_oversell = (NEW.reserved_quantity - OLD.reserved_quantity)
                     - NEW.overbooking_limit;

    IF v_oversell > 0 THEN
        INSERT INTO overbooking_log (
            resource_type, resource_id, resource_date,
            total_quantity, reserved_quantity, overbooking_limit,
            actual_oversell
        ) VALUES (
            NEW.resource_type, NEW.resource_id, NEW.resource_date,
            NEW.total_quantity, NEW.reserved_quantity,
            NEW.overbooking_limit, v_oversell
        );
    END IF;
END//

DELIMITER ;
```

> **Common Mistake: DECLARE After IF in MySQL Triggers**
> MySQL requires all `DECLARE` statements at the **very top** of a `BEGIN` block, before any `IF`, `WHILE`, or other logic. If you write `IF ... THEN DECLARE`, MySQL throws a syntax error. This catches many developers off guard because JavaScript and TypeScript let you declare variables anywhere. In MySQL stored programs, always put every `DECLARE` before the first executable statement.

### 5.3.4 Transactions Table

Records every payment attempt, successful or not.

```sql
CREATE TABLE transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT NOT NULL,

    transaction_type ENUM('payment','refund','chargeback') NOT NULL,
    payment_provider VARCHAR(50) NOT NULL,   -- 'stripe', 'paypal'
    payment_method ENUM('credit_card','debit_card','paypal',
                        'bank_transfer','wallet') NOT NULL,

    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,

    -- Provider's own transaction ID for reconciliation
    provider_transaction_id VARCHAR(255) UNIQUE,
    provider_status VARCHAR(50),

    status ENUM('pending','processing','completed','failed','refunded')
        DEFAULT 'pending',

    -- Tokenized card info (never store full card numbers)
    card_last_4 CHAR(4),
    card_brand VARCHAR(20),

    -- If it failed, why?
    error_code VARCHAR(50),
    error_message TEXT,

    deleted_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    CONSTRAINT chk_transaction_amount CHECK (amount > 0),

    INDEX idx_booking (booking_id),
    INDEX idx_status (status),
    INDEX idx_provider_id (provider_transaction_id)
);
```

### 5.3.5 Outbox Events Table

This table is critical for reliable messaging (explained fully in Chapter 6). Events are written here in the **same database transaction** as business data, then published to Kafka by a background process.

```sql
CREATE TABLE outbox_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    aggregate_type VARCHAR(50) NOT NULL,   -- 'booking', 'payment'
    aggregate_id BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,      -- 'booking.created'

    payload JSON NOT NULL,                 -- Event data
    topic VARCHAR(100) NOT NULL,           -- Kafka topic name
    partition_key VARCHAR(100),            -- Kafka partition key

    status ENUM('pending','published','failed') DEFAULT 'pending',
    retry_count SMALLINT DEFAULT 0,
    max_retries SMALLINT DEFAULT 5,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,

    INDEX idx_status (status, created_at),
    INDEX idx_aggregate (aggregate_type, aggregate_id)
);
```

## 5.4 Understanding Indexes

> **Analogy:** An index is the **table of contents** in a textbook. Without it, finding "Chapter 12" means flipping through every single page. With it, you look up "Chapter 12 -- page 287" and jump straight there.

Database indexes work the same way. Without an index on `status`, the query `SELECT * FROM bookings WHERE status = 'pending'` must scan every row in the table (a "full table scan"). With an index, MySQL jumps directly to the matching rows.

**When to add an index:**
- Columns you filter on in WHERE clauses (`status`, `user_id`)
- Columns you join on (`booking_id` in the transactions table)
- Columns you sort by (`created_at`)

**When NOT to add an index:**
- Columns that change constantly (indexes slow down writes)
- Tables with very few rows (full scan is faster than index lookup)
- Columns with very low cardinality (a boolean column with only true/false)

Look at the bookings table indexes:

```sql
INDEX idx_user (user_id, deleted_at),    -- "Show my bookings" (excludes deleted)
INDEX idx_status (status, deleted_at),   -- "Show all pending bookings"
INDEX idx_created (created_at),          -- "Sort by newest first"
INDEX idx_reference (reference_code)     -- "Look up booking HT-20260215-000042"
```

Each index is a **composite index** (multiple columns). The order matters: `(user_id, deleted_at)` can answer queries filtering by `user_id` alone, but NOT queries filtering by `deleted_at` alone. Think of it as a phone book sorted by last name then first name -- you can find all "Smiths" easily, but finding all people named "John" requires scanning everything.

> **Checkpoint:** You have a query: `SELECT * FROM bookings WHERE status = 'confirmed' AND booking_type = 'hotel'`. Which existing index helps? Would you add a new composite index `(status, booking_type)`, or is `idx_status` sufficient? (Hint: `idx_status` includes `deleted_at`, not `booking_type`.)

---

# Chapter 6: Message Queues & Event-Driven Architecture

## 6.1 The Problem with Direct Calls

In a simple system, when Service A needs to tell Service B something happened, A calls B directly via HTTP. This works until it does not.

> **Analogy:** **Phone call vs. mail.** An HTTP call is like a phone call -- you dial, wait for the other person to pick up, talk, and hang up. If they do not answer, you are stuck waiting. Sending a message through Kafka is like dropping a letter in the mailbox -- you send it and move on with your day. The recipient reads it when they are ready.

Problems with direct HTTP calls between services:

1. **Tight coupling** -- Booking Service must know the Payment Service URL, its API contract, its error codes.
2. **Cascading failure** -- If Payment Service is down, Booking Service is also effectively down.
3. **Synchronous blocking** -- The user waits while Booking calls Payment, Payment calls Fraud, Fraud calls Notification... each adding latency.
4. **Lost messages** -- If Payment Service crashes mid-request, the booking is created but payment is never processed. No automatic retry.

## 6.2 What Is Kafka?

Apache Kafka is a **distributed event streaming platform**. Services publish events ("booking was created") and other services consume those events asynchronously.

> **Analogy:** Think of Kafka as a **conveyor belt in a factory**. One worker places items on the belt (producer). Other workers pick items off the belt at their own speed (consumers). The belt keeps moving regardless. If a worker takes a break, items accumulate on the belt and the worker catches up when they return.

### Core Concepts

> **Key Term:** **Topic** -- A named category of messages, like a labeled conveyor belt. Our system has topics like `booking-events`, `payment-events`, and `inventory-events`. Producers write to a specific topic; consumers subscribe to topics they care about.

> **Key Term:** **Partition** -- A lane within a topic for parallel processing. The `booking-events` topic has 200 partitions. Each partition is an ordered, append-only log. More partitions = more consumers reading in parallel = higher throughput.

> **Key Term:** **Consumer Group** -- A team of workers reading from partitions. If topic `booking-events` has 200 partitions and consumer group `payment-processors` has 20 members, each member reads from 10 partitions. If one member crashes, its partitions are redistributed to the remaining 19 members.

> **Key Term:** **Offset** -- A bookmark tracking how far a consumer has read. "I have processed up to message #47 in partition 3." If the consumer restarts, it resumes from offset 47 instead of re-reading from the beginning.

### Our Kafka Setup

```yaml
Brokers: 15 nodes (8 vCPUs, 32 GB RAM each)
Mode: KRaft (no ZooKeeper)
Topics:
  booking-events:     200 partitions, 3x replication, 30-day retention
  payment-events:     100 partitions, 3x replication, 90-day retention
  inventory-events:   150 partitions, 3x replication, 7-day retention
  notification-events: 80 partitions, 3x replication, 3-day retention
```

## 6.3 KRaft Mode: No More ZooKeeper

Historically, Kafka relied on a separate system called ZooKeeper to manage cluster metadata (which brokers are alive, who leads which partition). Starting with Kafka 3.3, **KRaft mode** replaces ZooKeeper entirely.

```typescript
// KRaft controller configuration
const kraftConfig = {
  mode: 'KRaft',
  controllerNodes: 3,  // Dedicated controller nodes
  config: {
    'process.roles': 'controller',
    'controller.quorum.voters':
      '1@controller-1:9093,2@controller-2:9093,3@controller-3:9093',
  },
};
```

Why this matters to you:
- **Simpler deployment** -- No separate ZooKeeper cluster to install, monitor, and maintain.
- **Faster metadata ops** -- Partition leadership changes happen in milliseconds, not seconds.
- **Lower cost** -- Eliminates 3-5 ZooKeeper servers (~$1,500/month saved).

> **Common Mistake: Using ZooKeeper with Kafka 3.3+**
> An earlier version of this architecture ran a 5-node ZooKeeper ensemble alongside Kafka. Since Kafka 3.3+ (production-ready in 3.5+), ZooKeeper is deprecated. KRaft mode is faster, cheaper, and simpler. Always use KRaft for new deployments.

## 6.4 Producer and Consumer Code

### Publishing an Event (Producer)

```typescript
import { Kafka, Partitioners } from 'kafkajs';

// Create Kafka client
const kafka = new Kafka({
  clientId: 'booking-service',
  brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'],
});

const producer = kafka.producer({
  createPartitioner: Partitioners.DefaultPartitioner,
  idempotent: true,  // Prevents duplicate messages on retry
});

// Publish a booking event
async function publishBookingCreated(booking: Booking): Promise<void> {
  await producer.send({
    topic: 'booking-events',
    messages: [{
      // Key determines which partition receives this message.
      // Same user_id always goes to the same partition = ordering guarantee.
      key: String(booking.userId),
      value: JSON.stringify({
        eventType: 'booking.created',
        bookingId: booking.id,
        userId: booking.userId,
        totalAmount: booking.totalAmount,
        currency: booking.currency,
        timestamp: new Date().toISOString(),
      }),
      headers: {
        'event-type': 'booking.created',
        'source-service': 'booking-service',
      },
    }],
  });
}
```

**Key detail:** Setting `idempotent: true` tells Kafka to deduplicate messages. If the producer retries a send (network blip), Kafka detects the duplicate and discards it.

### Consuming Events (Consumer)

```typescript
const consumer = kafka.consumer({
  groupId: 'payment-processors',  // Consumer group name
});

async function startConsumer(): Promise<void> {
  await consumer.connect();
  await consumer.subscribe({
    topic: 'booking-events',
    fromBeginning: false,  // Start from latest offset, not the beginning
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());

      console.log(
        `Processing ${event.eventType} from partition ${partition}, ` +
        `offset ${message.offset}`
      );

      if (event.eventType === 'booking.created') {
        // Trigger payment processing for this booking
        await processPayment(event.bookingId, event.totalAmount);
      }

      // Kafka auto-commits the offset after successful processing.
      // If this consumer crashes before finishing, another consumer
      // in the group picks up from the last committed offset.
    },
  });
}
```

## 6.5 The Event-Driven Booking Flow

Here is how a booking flows through the system using events instead of direct HTTP calls:

```
User clicks "Book Now"
        |
        v
  [Booking Service]
        |
        |  1. BEGIN TRANSACTION
        |  2. INSERT INTO bookings (...)
        |  3. INSERT INTO outbox_events (...)   <-- same transaction
        |  4. COMMIT
        |
        v
  [Outbox Publisher]  -- background process, polls every 100ms
        |
        |  5. SELECT FROM outbox_events WHERE status = 'pending'
        |  6. Publish to Kafka topic 'booking-events'
        |  7. UPDATE outbox_events SET status = 'published'
        |
        v
  [Kafka: booking-events topic]
        |
        +--------+------------------+
        |        |                  |
        v        v                  v
  [Payment]  [Notification]   [Analytics]
   Service     Service          Service
```

Notice step 3: the outbox event is written **in the same database transaction** as the booking itself. If the transaction fails, neither the booking nor the event is saved. If it succeeds, both are saved atomically.

## 6.6 The Outbox Pattern: Why Not Publish Directly?

You might ask: "Why not just call `kafka.send()` right after the database commit?"

```
-- WITHOUT Outbox (dangerous) --
1. BEGIN TRANSACTION
2. INSERT INTO bookings (...)
3. COMMIT                          -- Success!
4. await kafka.send(...)           -- App crashes HERE. Event LOST forever.

-- WITH Outbox (safe) --
1. BEGIN TRANSACTION
2. INSERT INTO bookings (...)
3. INSERT INTO outbox_events (...) -- Same transaction as step 2
4. COMMIT                          -- Both saved, or neither saved
5. [Background publisher sends to Kafka later]
```

Without the outbox, if your application crashes between step 3 and step 4, the booking exists in the database but no event is ever published. The Payment Service never knows about it. The user is never charged. The hotel thinks the room is booked but no money arrives.

The Outbox Pattern eliminates this gap. The background publisher (step 5) polls for unpublished events and retries until Kafka confirms receipt. Even if the publisher crashes, it picks up where it left off on restart because unpublished events remain in the `outbox_events` table.

We will build the complete Outbox Publisher in Chapter 18.

> **Checkpoint:** Why don't we just call PaymentService via HTTP after creating a booking?
>
> Think about it: What happens if PaymentService is down for 30 seconds? The user's booking request hangs for 30 seconds (terrible UX), or times out and the booking is created but never paid for (data inconsistency). With Kafka, the `booking.created` event sits in the topic until PaymentService recovers. The user gets an immediate "Booking received" response, and payment processes asynchronously. The system is **resilient** to downstream failures.

## 6.7 Key Takeaways

| Concept | One-Line Summary |
|---------|-----------------|
| **Topic** | A named stream of events (`booking-events`). |
| **Partition** | A parallel lane within a topic. More partitions = more throughput. |
| **Consumer Group** | A team of readers that split partition work among themselves. |
| **Offset** | A bookmark so consumers resume where they left off. |
| **KRaft** | Kafka's built-in consensus (replaces ZooKeeper since Kafka 3.3+). |
| **Outbox Pattern** | Write events to a DB table in the same transaction as business data. Publish to Kafka asynchronously. |
| **Idempotent Producer** | `idempotent: true` prevents duplicate events on retry. |

> **What If You Skip This?** Without event-driven architecture, every service calls every other service directly. One slow service slows down the entire chain. One crashed service brings down everything that depends on it. At 100,000 bookings per minute, this cascade turns a minor outage into a platform-wide failure. Kafka decouples your services so they fail independently and recover gracefully.

---

*Next up -- Chapter 7: Caching with Redis Cluster, where we put a speed layer in front of the database to handle read-heavy search queries without melting our MySQL shards.*
