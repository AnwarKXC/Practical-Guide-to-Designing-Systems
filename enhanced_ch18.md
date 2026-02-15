# Chapter 18: Outbox Pattern — Reliable Event Publishing

## The Code That Looks Correct But Is Not

If you have been following along, you have written code like this many times by now. A user creates a booking, you save it to the database, and then you publish an event so other services know about it:

```typescript
// booking-service/src/booking.service.ts
// This is what most developers write first. It looks fine.
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  // Step 1: Save the booking to the database
  const booking = await this.prisma.booking.create({
    data: {
      userId:   dto.userId,
      roomId:   dto.roomId,
      checkIn:  dto.checkIn,
      checkOut: dto.checkOut,
      status:   'CONFIRMED',
    },
  });

  // Step 2: Tell the world about it
  await this.kafkaProducer.send({
    topic: 'booking.created',
    messages: [{
      key: booking.id,
      value: JSON.stringify(booking),
    }],
  });

  return booking;
}
```

You write to the database, then you publish to Kafka. Two steps. Both succeed most of the time. So what is the problem?

The problem is the word "then." Those two operations are independent. They are not wrapped in a single transaction. And independent operations can fail independently. There are exactly four possible outcomes, and only one of them is safe:

```
Scenario 1: Both succeed (the happy path)
  1. prisma.booking.create()   → SUCCESS
  2. kafkaProducer.send()      → SUCCESS
  Result: Database has the booking. Kafka has the event. Everything is consistent.

Scenario 2: Database succeeds, Kafka fails
  1. prisma.booking.create()   → SUCCESS
  2. kafkaProducer.send()      → FAILURE (Kafka down, network timeout, broker restart)
  Result: Database has the booking. Kafka does NOT have the event.
     The Notification Service never sends a confirmation email.
     The Search Service never updates availability.
     The booking exists, but the rest of the system does not know about it.

Scenario 3: Database fails
  1. prisma.booking.create()   → FAILURE (constraint violation, DB down)
  2. kafkaProducer.send()      → never executes
  Result: Nothing happened. The user gets an error and retries. Actually fine.

Scenario 4: Database succeeds, application crashes before Kafka call
  1. prisma.booking.create()   → SUCCESS
  2. Process crashes (OOM kill, uncaught exception, container eviction)
  3. kafkaProducer.send()      → never executes
  Result: Identical to Scenario 2. The booking is saved,
     the event is gone forever. Nobody can recover it
     because it was never persisted anywhere.
```

Scenarios 2 and 4 are the dangerous ones. Let us zoom in on what Scenario 2 looks like in a production timeline:

```
Timeline of Failure:

09:00:00.000  User clicks "Book Now"
09:00:00.035  Prisma INSERT succeeds — booking BK-99001 is saved
09:00:00.036  Application calls kafkaProducer.send()...
09:00:00.036  Kafka broker is unreachable (network blip, broker restarting)
09:00:03.036  kafkaProducer.send() throws TimeoutError after 3 seconds
09:00:03.037  Application catches the error and... what?
              The booking is already committed. You cannot un-commit it.

Result:
  - bookings table: BK-99001 exists, status = CONFIRMED
  - Kafka: no 'booking.created' event for BK-99001
  - Notification Service: sends nothing (never heard about BK-99001)
  - Search Service: still shows the room as available
  - User: sees the booking in their account, never gets a confirmation email
  - Next user: books the same room (Search thinks it is available)
    → DOUBLE BOOKING

Hours later:
  - Two guests arrive at the hotel for the same room
  - Front desk calls your support line
  - Your SRE team digs through logs for 4 hours
  - They find the missing event, manually reconcile the data
  - Your CEO asks "how do we prevent this from ever happening again?"
```

> **Analogy:** Imagine you write a check and hand it to a courier to deliver to your landlord. You record the payment in your checkbook (database write). The courier loses the check on the way (Kafka publish fails). Your checkbook says you paid rent, but your landlord never got the money. Your records and your landlord's records are now out of sync, and nobody realizes it until you get an eviction notice.

This is called the **dual-write problem**: writing to two different systems (database and Kafka) without a mechanism to guarantee both writes succeed or both fail.

> **Key Term:** **Dual-write problem** — The failure mode that occurs when an application writes to two independent systems (e.g., a database and a message broker) in sequence without a transaction spanning both. If the first write succeeds and the second fails, the systems become permanently inconsistent. No amount of try/catch logic can fix this, because once the database commits, the data is persisted regardless of what happens next.

### Why "Just Retry" Does Not Fix It

Your first instinct might be: catch the error and retry the Kafka publish. Let us see why that fails:

```typescript
// The "just retry" approach — still broken
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  const booking = await this.prisma.booking.create({
    data: { ... },
  });

  // Retry Kafka publish up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await this.kafkaProducer.send({
        topic: 'booking.created',
        messages: [{ key: booking.id, value: JSON.stringify(booking) }],
      });
      return booking; // success, exit
    } catch (error) {
      if (attempt === 3) {
        // All retries failed. Now what?
        // Option A: Log and swallow → silent data inconsistency
        // Option B: Throw → user sees error, but booking IS saved
        // Option C: Delete the booking → bookings table is modified
        //           but what if the DELETE fails too?
        // There is no good option here.
        console.error('Failed to publish event after 3 retries', error);
      }
      await this.sleep(1000 * attempt); // backoff
    }
  }
  return booking;
}
```

The retry approach has three fatal flaws:

1. **If all retries fail,** you have a saved booking with no event. You are back to Scenario 2.
2. **If the process crashes mid-retry,** the booking exists but no retry loop is running. The event is lost permanently.
3. **If you try to delete the booking on failure,** the DELETE itself can fail, leaving you in an even worse state: a booking that might or might not exist, and an event that was never sent.

> **What If You Skip This?** Every event-driven system without the outbox pattern has a ticking time bomb. It works fine 99.9% of the time. But that 0.1% means you lose events during Kafka restarts, network blips, and application crashes. Lost events mean lost emails, stale search indexes, missed payments, and phantom bookings. Over time, your services silently drift out of sync, and nobody notices until a customer complains — or two guests show up for the same hotel room.

---

## The Outbox Pattern: One Transaction, One Source of Truth

The fix is elegant: instead of writing to the database AND then to Kafka, write the event **to the database** in the same transaction as your business data. Then have a separate background process read those events from the database and publish them to Kafka.

Here is the concept, side by side:

```
WITHOUT Outbox (dangerous — the approach you know):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)         -- business data
  3. COMMIT                             -- database commit succeeds
  4. kafkaProducer.send('booking.created')  -- App crashes HERE = event LOST

WITH Outbox (safe — the pattern you will learn):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)         -- business data
  3. INSERT INTO outbox_events (...)    -- event, SAME transaction
  4. COMMIT                             -- both succeed or BOTH fail
  5. [Background publisher reads outbox_events and publishes to Kafka]
  6. [Background publisher marks event as 'published']
```

The key insight: in Step 4, the database guarantees atomicity. Either BOTH the booking AND the outbox event are saved, or NEITHER is saved. There is no window where one exists without the other. The event cannot be lost because it is stored in the same database, in the same transaction, as the business data.

The background process (Step 5) can retry as many times as needed. If Kafka is down for an hour, the events just sit in the outbox table until Kafka recovers. They are safe in the database. Nothing is lost.

> **Analogy:** Instead of handing the check directly to a courier (who might lose it), you put the check in your office's outgoing mail tray (the outbox table). The mail room (the outbox publisher) picks up checks from the tray and delivers them. If the mail room is closed today, the check sits safely in the tray until tomorrow. It will not be lost. The tray is inside your office, right next to your checkbook — both are in the same place (the database), under the same lock and key (the transaction).

> **Key Term:** **Outbox pattern** — A reliability pattern where application events are written to an "outbox" database table within the same transaction as business data, then asynchronously published to a message broker by a separate process. This eliminates the dual-write problem by reducing two writes (database + broker) to one atomic database write.

---

## The Outbox Table: Schema and Prisma Model

Before we look at the publisher, let us understand what the outbox table looks like. Every column exists for a reason:

```sql
-- migration: create_outbox_events_table.sql
CREATE TABLE outbox_events (
  id              BIGSERIAL PRIMARY KEY,
  aggregate_type  VARCHAR(100)  NOT NULL,   -- e.g., 'Booking', 'Payment', 'Inventory'
  aggregate_id    VARCHAR(100)  NOT NULL,   -- e.g., 'BK-99001', 'PAY-4420'
  event_type      VARCHAR(150)  NOT NULL,   -- e.g., 'booking.created', 'payment.charged'
  topic           VARCHAR(255)  NOT NULL,   -- Kafka topic to publish to
  partition_key   VARCHAR(255)  NOT NULL,   -- Kafka partition key (ordering)
  payload         JSON         NOT NULL,   -- the event data
  headers         JSON         DEFAULT '{}',  -- optional Kafka headers
  status          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
                  -- PENDING | PUBLISHED | FAILED | DEAD_LETTER
  retry_count     INT           NOT NULL DEFAULT 0,
  max_retries     INT           NOT NULL DEFAULT 5,
  error_message   TEXT          NULL,       -- last error, if any
  created_at      DATETIME(6)   NOT NULL DEFAULT NOW(6),
  published_at    DATETIME(6)   NULL,
  next_retry_at   DATETIME(6)   NULL,       -- for exponential backoff
  expired_at      DATETIME(6)   NULL,       -- TTL: when to auto-archive

  -- Indexes for the publisher's polling query
  CONSTRAINT chk_status CHECK (status IN ('PENDING','PUBLISHED','FAILED','DEAD_LETTER'))
);

-- The publisher queries by status + ordering. This composite index is critical.
CREATE INDEX idx_outbox_pending
  ON outbox_events (status, created_at)
  WHERE status = 'PENDING';

-- For per-aggregate ordering queries
CREATE INDEX idx_outbox_aggregate
  ON outbox_events (aggregate_type, aggregate_id, created_at);

-- For cleanup job: find old published events
CREATE INDEX idx_outbox_published_at
  ON outbox_events (published_at)
  WHERE status = 'PUBLISHED';

-- For monitoring: find stuck/failed events
CREATE INDEX idx_outbox_failed
  ON outbox_events (status, retry_count)
  WHERE status = 'FAILED';
```

Now the same thing as a Prisma schema. For every raw SQL in this chapter, we show the Prisma equivalent:

```prisma
// prisma/schema.prisma

model OutboxEvent {
  id             BigInt    @id @default(autoincrement())
  aggregateType  String    @map("aggregate_type") @db.VarChar(100)
  aggregateId    String    @map("aggregate_id") @db.VarChar(100)
  eventType      String    @map("event_type") @db.VarChar(150)
  topic          String    @db.VarChar(255)
  partitionKey   String    @map("partition_key") @db.VarChar(255)
  payload        Json      @db.JsonB
  headers        Json      @default("{}") @db.JsonB
  status         String    @default("PENDING") @db.VarChar(20)
  retryCount     Int       @default(0) @map("retry_count")
  maxRetries     Int       @default(5) @map("max_retries")
  errorMessage   String?   @map("error_message") @db.Text
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz()
  publishedAt    DateTime? @map("published_at") @db.Timestamptz()
  nextRetryAt    DateTime? @map("next_retry_at") @db.Timestamptz()
  expiredAt      DateTime? @map("expired_at") @db.Timestamptz()

  @@index([status, createdAt], name: "idx_outbox_pending")
  @@index([aggregateType, aggregateId, createdAt], name: "idx_outbox_aggregate")
  @@index([publishedAt], name: "idx_outbox_published_at")
  @@index([status, retryCount], name: "idx_outbox_failed")
  @@map("outbox_events")
}

model Booking {
  id        BigInt   @id @default(autoincrement())
  userId    BigInt   @map("user_id")
  roomId    BigInt   @map("room_id")
  checkIn   DateTime @map("check_in") @db.Date
  checkOut  DateTime @map("check_out") @db.Date
  status    String   @default("CONFIRMED") @db.VarChar(30)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz()

  @@map("bookings")
}
```

Here is how your booking code changes to use the outbox with Prisma's interactive transactions:

```typescript
// booking-service/src/booking.service.ts
// AFTER: Safe outbox pattern with Prisma
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  // Prisma's interactive transaction: both writes succeed or both fail
  const booking = await this.prisma.$transaction(async (tx) => {
    // 1. Write the business data
    const newBooking = await tx.booking.create({
      data: {
        userId:   dto.userId,
        roomId:   dto.roomId,
        checkIn:  dto.checkIn,
        checkOut: dto.checkOut,
        status:   'CONFIRMED',
      },
    });

    // 2. Write the event to the outbox — same transaction!
    await tx.outboxEvent.create({
      data: {
        aggregateType: 'Booking',
        aggregateId:   String(newBooking.id),
        eventType:     'booking.created',
        topic:         'booking-events',
        partitionKey:  String(newBooking.id),
        payload: {
          bookingId: String(newBooking.id),
          userId:    String(dto.userId),
          roomId:    String(dto.roomId),
          checkIn:   dto.checkIn.toISOString(),
          checkOut:  dto.checkOut.toISOString(),
          status:    'CONFIRMED',
          timestamp: new Date().toISOString(),
        },
      },
    });

    return newBooking;
  });

  // No kafkaProducer.send() here. The publisher handles it.
  return booking;
}
```

Notice what changed:

1. **No `kafkaProducer.send()` call.** Your application code never talks to Kafka directly. It does not import the Kafka client. It does not know Kafka exists.
2. **One transaction wraps everything.** Prisma's `$transaction` ensures the booking INSERT and the outbox INSERT are in the same `BEGIN/COMMIT` block.
3. **If the transaction fails,** neither the booking nor the event is saved. Clean failure. The user retries.
4. **If the transaction succeeds,** the event is safely parked in the outbox table, waiting for the publisher to pick it up.

> **Checkpoint:** Before reading further, answer this: if the application crashes immediately after `$transaction` commits but before any publisher runs, is the event lost? (Answer: No. The event is in the database. The publisher will find it on its next poll.)

---

## The Outbox Publisher: Polling for Events

The outbox publisher is a separate background process — often a dedicated microservice or a long-running worker thread — that continuously checks the outbox table for new events and publishes them to Kafka. Think of it as the mail room clerk who empties the outgoing tray every few minutes.

Here is the full polling-based publisher, explained section by section. We start with raw SQL for clarity, then show the Prisma equivalent.

### Raw SQL Publisher

```typescript
// outbox-publisher/src/outbox-publisher.service.ts
export class OutboxPublisherService {
  // ─── Configuration ───────────────────────────────────
  // All values can be overridden via environment variables.
  private readonly config = {
    pollIntervalMs:  parseInt(process.env.OUTBOX_POLL_INTERVAL_MS  || '100'),
    batchSize:       parseInt(process.env.OUTBOX_BATCH_SIZE        || '100'),
    maxRetries:      parseInt(process.env.OUTBOX_MAX_RETRIES       || '5'),
    shutdownTimeout: parseInt(process.env.OUTBOX_SHUTDOWN_TIMEOUT  || '10000'),
  };

  // Flag to control the polling loop
  private running = false;

  constructor(
    private readonly db: Pool,           // PostgreSQL connection pool
    private readonly kafka: KafkaProducer // pre-configured Kafka producer
  ) {}

  /**
   * Start the polling loop. This method runs until stop() is called.
   * The loop is intentionally simple: poll, publish, repeat.
   * When there are no events, it sleeps to avoid hammering the database.
   * When there ARE events, it loops immediately for high throughput.
   */
  async start(): Promise<void> {
    this.running = true;
    console.log('Outbox publisher started', this.config);

    while (this.running) {
      try {
        const published = await this.publishBatch();

        if (published === 0) {
          // No events found. Sleep before polling again.
          // This prevents the loop from hammering the database
          // with empty queries when there is nothing to do.
          await this.sleep(this.config.pollIntervalMs);
        }
        // If we DID publish events, loop immediately — there might be more.
        // This gives us high throughput during event bursts.
      } catch (error) {
        // Catch-all: if publishBatch itself throws an uncaught error
        // (e.g., database pool exhausted), log and back off.
        console.error('Outbox poll cycle failed:', error);
        await this.sleep(this.config.pollIntervalMs * 10); // longer backoff
      }
    }
  }

  /**
   * Graceful shutdown. Allows the current batch to finish.
   */
  async stop(): Promise<void> {
    this.running = false;
    console.log('Outbox publisher stopping...');
  }

  /**
   * Core method: fetch pending events, publish to Kafka, mark as published.
   * Returns the number of events published (0 if none were found).
   */
  private async publishBatch(): Promise<number> {
    const client = await this.db.connect(); // grab a connection from the pool

    try {
      await client.query('BEGIN');

      // ─── The Critical Query ─────────────────────────────
      // SELECT ... FOR UPDATE SKIP LOCKED is the key to safe,
      // concurrent outbox publishing. We explain each clause
      // in the next section.
      const { rows: events } = await client.query(`
        SELECT id, aggregate_type, aggregate_id, event_type,
               payload, topic, partition_key, headers
        FROM outbox_events
        WHERE status = 'PENDING'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW(6))
        ORDER BY id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      `, [this.config.batchSize]);

      if (events.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      // ─── Group by Kafka topic ───────────────────────────
      // A single batch might contain events for 'booking-events',
      // 'payment-events', and 'inventory-events'. We group them
      // so we make one kafka.send() call per topic (fewer round trips).
      const messagesByTopic = new Map<string, KafkaMessage[]>();

      for (const event of events) {
        if (!messagesByTopic.has(event.topic)) {
          messagesByTopic.set(event.topic, []);
        }

        const kafkaHeaders: Record<string, string> = {
          'event-type':     event.event_type,
          'aggregate-type': event.aggregate_type,
          'aggregate-id':   event.aggregate_id,
          'outbox-id':      String(event.id),
          ...(typeof event.headers === 'object' ? event.headers : {}),
        };

        messagesByTopic.get(event.topic)!.push({
          key:   event.partition_key,
          value: JSON.stringify({
            eventId:       String(event.id),
            eventType:     event.event_type,
            aggregateType: event.aggregate_type,
            aggregateId:   event.aggregate_id,
            payload:       event.payload,
            timestamp:     new Date().toISOString(),
          }),
          headers: kafkaHeaders,
        });
      }

      // ─── Publish each group ─────────────────────────────
      for (const [topic, messages] of messagesByTopic) {
        await this.kafka.send({ topic, messages });
      }

      // ─── Mark events as published ───────────────────────
      const eventIds = events.map((e: any) => e.id);
      await client.query(`
        UPDATE outbox_events
        SET status = 'PUBLISHED', published_at = NOW(6)
        WHERE id = ANY($1::bigint[])
      `, [eventIds]);

      await client.query('COMMIT');
      return events.length;

    } catch (error) {
      // If ANYTHING fails — Kafka send, database update, anything —
      // we roll back. The events remain PENDING and will be picked up
      // on the next poll iteration. Nothing is lost.
      await client.query('ROLLBACK');
      console.error('Outbox batch publish failed:', error);

      // Optionally increment retry count for the events we grabbed.
      // We do this outside the failed transaction.
      await this.markRetryFailure(events?.map((e: any) => e.id) || [], error);
      return 0;

    } finally {
      client.release();
    }
  }

  /**
   * When a batch fails, increment retry_count and set next_retry_at
   * using exponential backoff. After max_retries, mark as FAILED.
   */
  private async markRetryFailure(
    eventIds: bigint[],
    error: unknown
  ): Promise<void> {
    if (eventIds.length === 0) return;

    try {
      await this.db.query(`
        UPDATE outbox_events
        SET
          retry_count   = retry_count + 1,
          error_message = $2,
          next_retry_at = NOW(6) + (POWER(2, retry_count) || ' seconds')::interval,
          status        = CASE
                            WHEN retry_count + 1 >= max_retries THEN 'FAILED'
                            ELSE 'PENDING'
                          END
        WHERE id = ANY($1::bigint[])
          AND status = 'PENDING'
      `, [eventIds, String(error)]);
    } catch (retryError) {
      // If even the retry-count update fails (DB is truly down),
      // log and move on. The events are still PENDING and will
      // be retried on the next cycle.
      console.error('Failed to update retry count:', retryError);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Prisma Publisher

Here is the same publisher logic using Prisma Client instead of raw SQL. The key challenge is that Prisma does not natively support `FOR UPDATE SKIP LOCKED`, so we use `$queryRaw` for the locking query and Prisma Client for the update:

```typescript
// outbox-publisher/src/outbox-publisher-prisma.service.ts
import { PrismaClient, OutboxEvent } from '@prisma/client';

export class OutboxPublisherPrismaService {
  private readonly config = {
    pollIntervalMs: parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '100'),
    batchSize:      parseInt(process.env.OUTBOX_BATCH_SIZE       || '100'),
  };

  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly kafka: KafkaProducer,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const count = await this.publishBatch();
      if (count === 0) await this.sleep(this.config.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async publishBatch(): Promise<number> {
    // Use Prisma interactive transaction for atomicity
    return this.prisma.$transaction(async (tx) => {
      // FOR UPDATE SKIP LOCKED requires raw SQL in Prisma
      const events = await tx.$queryRaw<OutboxEvent[]>`
        SELECT id, aggregate_type AS "aggregateType",
               aggregate_id AS "aggregateId",
               event_type AS "eventType",
               topic, partition_key AS "partitionKey",
               payload, headers
        FROM outbox_events
        WHERE status = 'PENDING'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW(6))
        ORDER BY id ASC
        LIMIT ${this.config.batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (events.length === 0) return 0;

      // Build and send Kafka messages (same grouping logic as before)
      const messagesByTopic = this.groupByTopic(events);
      for (const [topic, messages] of messagesByTopic) {
        await this.kafka.send({ topic, messages });
      }

      // Mark events as published using Prisma Client
      await tx.outboxEvent.updateMany({
        where: { id: { in: events.map(e => e.id) } },
        data:  { status: 'PUBLISHED', publishedAt: new Date() },
      });

      return events.length;
    }, {
      // Transaction options: fail fast if another instance holds the lock
      isolationLevel: 'ReadCommitted',
      timeout:        30_000, // 30 second timeout for the transaction
    });
  }

  private groupByTopic(events: OutboxEvent[]): Map<string, KafkaMessage[]> {
    const map = new Map<string, KafkaMessage[]>();
    for (const event of events) {
      if (!map.has(event.topic)) map.set(event.topic, []);
      map.get(event.topic)!.push({
        key:   event.partitionKey,
        value: JSON.stringify({
          eventId:       String(event.id),
          eventType:     event.eventType,
          aggregateType: event.aggregateType,
          aggregateId:   event.aggregateId,
          payload:       event.payload,
          timestamp:     new Date().toISOString(),
        }),
        headers: {
          'event-type':     event.eventType,
          'aggregate-type': event.aggregateType,
        },
      });
    }
    return map;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

Let us walk through the lifecycle of a single event:

```
1. Your createBooking() method saves a booking and an outbox event
   in one Prisma $transaction. Status: PENDING.

2. The OutboxPublisherService polling loop runs.
   It selects the event with FOR UPDATE SKIP LOCKED.

3. It builds a Kafka message from the event data.

4. It calls kafka.send() to publish the message.

5. If Kafka accepts the message:
   → The publisher updates the event status to PUBLISHED.
   → The transaction commits. Done.

6. If Kafka is down:
   → kafka.send() throws an error.
   → The catch block rolls back the transaction.
   → The event's status is still PENDING.
   → On the next poll (100ms later), the publisher tries again.
   → It keeps trying until Kafka comes back.

7. The event is never lost because it lives in the database —
   the same database that holds your booking data.
```

> **What If You Skip This?** Without the outbox pattern, you have exactly two choices when Kafka is down: (1) fail the booking (bad user experience — "sorry, our email system is down so you can't book a hotel") or (2) swallow the error and lose the event (silent data inconsistency that festers). The outbox pattern gives you a third option: succeed the booking, park the event safely, and publish it as soon as Kafka recovers.

---

## FOR UPDATE SKIP LOCKED: Why Those Four Words Matter

You might have glossed over the `FOR UPDATE SKIP LOCKED` clause in the polling query. Do not. It is critical for running multiple publisher instances safely.

```sql
SELECT ... FROM outbox_events
WHERE status = 'PENDING'
ORDER BY id ASC
LIMIT 100
FOR UPDATE SKIP LOCKED
```

Here is what each part does:

| Clause | What It Does | Why It Matters |
|--------|-------------|----------------|
| `FOR UPDATE` | Locks the selected rows. No other transaction can modify or re-select them with `FOR UPDATE` until this transaction commits or rolls back. | Prevents two publisher instances from grabbing the same events and sending them to Kafka twice (duplicate messages). |
| `SKIP LOCKED` | If some rows are already locked by another transaction, skip them instead of waiting. | Lets multiple publisher instances run in parallel without blocking each other. Instance B does not wait for Instance A; it grabs different events. |
| `ORDER BY id ASC` | Process events in the order they were created. | Preserves causal ordering: `booking.created` is always published before `booking.updated` for the same booking. |
| `LIMIT 100` | Only grab 100 events at a time. | Controls batch size and prevents one publisher from hogging all events. Lets multiple instances share the work. |

Here is what happens with two publisher instances running in parallel:

```
                Instance A                            Instance B
                    │                                     │
  t=0ms             │ SELECT ... LIMIT 100                │
                    │ FOR UPDATE SKIP LOCKED              │
                    │ → Locks events 1-100                │
                    │                                     │
  t=5ms             │                                     │ SELECT ... LIMIT 100
                    │                                     │ FOR UPDATE SKIP LOCKED
                    │                                     │ → Events 1-100 are locked
                    │                                     │ → SKIPS them
                    │                                     │ → Locks events 101-200
                    │                                     │
  t=50ms            │ kafka.send(events 1-100)            │ kafka.send(events 101-200)
                    │                                     │
  t=80ms            │ UPDATE status='PUBLISHED'           │ UPDATE status='PUBLISHED'
                    │ COMMIT                              │ COMMIT
                    │ → Releases locks on 1-100           │ → Releases locks on 101-200
```

Without SKIP LOCKED, Instance B would wait (block) for Instance A to finish, creating a bottleneck. Only one publisher would work at a time. With SKIP LOCKED, both publishers process different events simultaneously. Throughput doubles.

> **Analogy:** Think of checkout lanes at a grocery store. Without SKIP LOCKED, everyone waits in one line behind one cashier. With SKIP LOCKED, if a lane is occupied, you move to the next open lane. More cashiers, faster checkout, no waiting.

> **Checkpoint:** If you are running 3 publisher instances, each with a batch size of 100, and there are 250 pending events, how many events does each instance process? (Answer: Instance A gets 100, Instance B gets 100, Instance C gets 50. All 250 events are processed in one cycle.)

---

## CDC with Debezium: An Alternative to Polling

Polling the outbox table works, but it has a tension built into it: poll too frequently and you hammer the database with empty queries; poll too infrequently and events sit in the table longer than necessary, increasing end-to-end latency. There is a third approach that eliminates polling entirely: **Change Data Capture (CDC)**.

CDC works at the database level. Instead of your application asking "are there new events?" every 100 milliseconds, the database itself streams every row change to an external system. PostgreSQL writes every INSERT, UPDATE, and DELETE to its **Write-Ahead Log (WAL)** before applying them to tables. Debezium — the most popular open-source CDC connector — reads this WAL and converts each change into a Kafka message automatically.

```
Polling approach (what you built above):
  Application → INSERT into outbox_events → Publisher polls every 100ms → Kafka

CDC approach (Debezium):
  Application → INSERT into outbox_events → PostgreSQL WAL → Debezium → Kafka
  (no poll loop, no publisher service, no SKIP LOCKED)
```

> **Key Term:** **Change Data Capture (CDC)** — A technique that captures row-level changes (inserts, updates, deletes) from a database's transaction log and streams them to external systems in near real-time. Unlike polling, CDC does not query the table at all; it reads the database's internal replication stream.

### Debezium Configuration for the Outbox Table

Debezium runs as a Kafka Connect connector. You deploy it by sending a JSON configuration to the Kafka Connect REST API. Here is the configuration for our outbox table:

```json
{
  "name": "outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres-primary",
    "database.port": "5432",
    "database.user": "debezium_replication_user",
    "database.password": "${secrets:DEBEZIUM_DB_PASSWORD}",
    "database.dbname": "booking_service",
    "database.server.name": "booking",

    "table.include.list": "public.outbox_events",
    "slot.name": "debezium_outbox_slot",
    "plugin.name": "pgoutput",

    "transforms": "outbox",
    "transforms.outbox.type":
      "io.debezium.transforms.outbox.EventRouter",
    "transforms.outbox.table.fields.additional.placement":
      "event_type:header:eventType,aggregate_type:header:aggregateType",
    "transforms.outbox.route.by.field": "topic",
    "transforms.outbox.route.topic.replacement": "${routedByValue}",
    "transforms.outbox.table.field.event.key": "partition_key",
    "transforms.outbox.table.field.event.payload": "payload",
    "transforms.outbox.table.field.event.id": "id",
    "transforms.outbox.table.field.event.timestamp": "created_at",

    "tombstones.on.delete": "false",
    "key.converter": "org.apache.kafka.connect.storage.StringConverter",
    "value.converter": "org.apache.kafka.connect.json.JsonConverter",
    "value.converter.schemas.enable": "false"
  }
}
```

The Debezium `EventRouter` transform is purpose-built for the outbox pattern. It reads the `topic` column from each outbox row and routes the message to that Kafka topic. It uses `partition_key` as the Kafka message key and `payload` as the message value. The outbox row becomes the Kafka message — no publisher service needed.

### Polling vs CDC: Decision Table

| Concern | Polling | CDC (Debezium) |
|---------|---------|----------------|
| Latency | 50-500ms (poll interval) | 10-50ms (near real-time) |
| Database load | Repeated SELECT queries | Reads WAL stream (minimal load) |
| Infrastructure | No extra services | Requires Kafka Connect + Debezium |
| Complexity | Simple NestJS service | Connector config + monitoring |
| Ordering | Explicit ORDER BY id | WAL order (guaranteed) |
| Debugging | Query the table directly | Inspect Kafka Connect status API |
| Team familiarity | TypeScript — your team knows it | JVM-based connector — may be new |

> **Mentor's Advice:** Start with polling. It is simpler, it is in your language, and it works well for most traffic volumes. Move to Debezium when you need sub-100ms latency or when your outbox poll queries start showing up in your slow-query logs. Many production systems run the polling approach at thousands of events per second without issues. Do not adopt Debezium just because it sounds more sophisticated — adopt it when polling becomes a measurable bottleneck.

---

## Ordering Guarantees: Events in the Right Sequence

When a user creates a booking and then cancels it, the rest of the system must see `booking.created` before `booking.cancelled`. If these events arrive in the wrong order, a consumer might try to cancel a booking it has never seen, then receive a creation event for a booking that should already be cancelled. The result: a ghost booking that nobody can cancel.

The outbox pattern preserves ordering through three mechanisms working together:

### Mechanism 1: Sequential IDs in the Outbox Table

Every outbox event gets an auto-incrementing `BIGSERIAL` ID. Events for the same booking are always inserted in causal order because they happen in separate, sequential user requests:

```sql
-- User creates a booking at 09:00 → outbox event ID = 1001
-- User cancels the same booking at 09:05 → outbox event ID = 1042
-- The publisher's ORDER BY id ASC guarantees 1001 is published before 1042
SELECT id, event_type, aggregate_id FROM outbox_events
WHERE aggregate_type = 'Booking' AND aggregate_id = 'BK-500'
ORDER BY id ASC;

--  id  | event_type        | aggregate_id
-- -----+-------------------+--------------
-- 1001 | booking.created   | BK-500
-- 1042 | booking.cancelled | BK-500
```

The Prisma equivalent for querying events in order:

```typescript
// Query outbox events for a specific aggregate in order
const events = await prisma.outboxEvent.findMany({
  where: {
    aggregateType: 'Booking',
    aggregateId:   'BK-500',
  },
  orderBy: { id: 'asc' },
});
// events[0].eventType === 'booking.created'
// events[1].eventType === 'booking.cancelled'
```

### Mechanism 2: Kafka Partition Key

The outbox table has a `partition_key` column. For bookings, this is the booking ID. When the publisher sends messages to Kafka, it uses this as the Kafka message key. Kafka guarantees that all messages with the same key go to the same partition, and messages within a partition are strictly ordered.

```
Kafka topic: booking-events (6 partitions)

Partition 0: [BK-500:created] → [BK-500:cancelled]    ← same key, same partition, ordered
Partition 1: [BK-501:created] → [BK-501:updated]      ← same key, same partition, ordered
Partition 2: [BK-502:created]
Partition 3: (empty)
Partition 4: [BK-503:created] → [BK-503:updated] → [BK-503:cancelled]
Partition 5: (empty)
```

Events for different bookings can be on different partitions (and processed in parallel). Events for the same booking are always on the same partition (and processed in order).

### Mechanism 3: Per-Aggregate Ordering in the Publisher

If you need strict per-aggregate ordering even across publisher restarts, the publisher can process events grouped by aggregate:

```typescript
// outbox-publisher/src/ordered-publisher.service.ts
// Ensures per-aggregate ordering by publishing one aggregate at a time
private async publishBatchOrdered(): Promise<number> {
  return this.prisma.$transaction(async (tx) => {
    // Step 1: Find distinct aggregates with pending events
    const aggregates = await tx.$queryRaw<
      { aggregateType: string; aggregateId: string }[]
    >`
      SELECT DISTINCT aggregate_type AS "aggregateType",
                      aggregate_id AS "aggregateId"
      FROM outbox_events
      WHERE status = 'PENDING'
        AND (next_retry_at IS NULL OR next_retry_at <= NOW(6))
      LIMIT 50
    `;

    if (aggregates.length === 0) return 0;

    let totalPublished = 0;

    // Step 2: For each aggregate, publish events in strict order
    for (const agg of aggregates) {
      const events = await tx.$queryRaw<OutboxEvent[]>`
        SELECT id, aggregate_type AS "aggregateType",
               aggregate_id AS "aggregateId",
               event_type AS "eventType",
               topic, partition_key AS "partitionKey",
               payload, headers
        FROM outbox_events
        WHERE aggregate_type = ${agg.aggregateType}
          AND aggregate_id = ${agg.aggregateId}
          AND status = 'PENDING'
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
      `;

      if (events.length === 0) continue;

      // Publish events for this aggregate one by one, in order
      for (const event of events) {
        await this.kafka.send({
          topic: event.topic,
          messages: [{
            key:   event.partitionKey,
            value: JSON.stringify({
              eventId:       String(event.id),
              eventType:     event.eventType,
              aggregateType: event.aggregateType,
              aggregateId:   event.aggregateId,
              payload:       event.payload,
              timestamp:     new Date().toISOString(),
            }),
          }],
        });
      }

      // Mark all events for this aggregate as published
      await tx.outboxEvent.updateMany({
        where: {
          id: { in: events.map(e => e.id) },
        },
        data: {
          status:      'PUBLISHED',
          publishedAt: new Date(),
        },
      });

      totalPublished += events.length;
    }

    return totalPublished;
  }, { timeout: 60_000 });
}
```

> **Checkpoint:** Why do we publish events for one aggregate at a time instead of batching all aggregates together? (Answer: If we batch all events and the Kafka send for event #3 fails, we would have to roll back events #1 and #2 as well, even though they might be for different aggregates. Per-aggregate grouping means a failure for one booking does not block events for other bookings.)

---

## Outbox Cleanup: Archiving and Deleting Published Events

The outbox table grows every time your application writes an event. In a system that processes 1,000 bookings per hour, that is 1,000+ rows per hour added to the outbox. After a month, you have over 700,000 rows. Most of them have `status = 'PUBLISHED'` — their job is done. They are dead weight slowing down the publisher's polling queries.

You need a cleanup strategy. There are three approaches, from simplest to most robust:

### Approach 1: Simple DELETE of Old Published Events

```sql
-- Run this as a scheduled job (cron) every hour
-- Delete published events older than 7 days
DELETE FROM outbox_events
WHERE status = 'PUBLISHED'
  AND published_at < NOW(6) - INTERVAL '7 days'
LIMIT 10000;  -- delete in batches to avoid long locks
```

The Prisma equivalent:

```typescript
// outbox-cleanup/src/cleanup.service.ts
async cleanupPublishedEvents(): Promise<number> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Prisma does not support LIMIT on deleteMany,
  // so we find IDs first, then delete in batches
  const oldEvents = await this.prisma.outboxEvent.findMany({
    where: {
      status:      'PUBLISHED',
      publishedAt: { lt: sevenDaysAgo },
    },
    select: { id: true },
    take: 10_000,
  });

  if (oldEvents.length === 0) return 0;

  const result = await this.prisma.outboxEvent.deleteMany({
    where: {
      id: { in: oldEvents.map(e => e.id) },
    },
  });

  return result.count;
}
```

### Approach 2: Archive to a Separate Table, Then Delete

For audit trails and debugging, move published events to an archive table before deleting:

```sql
-- Step 1: Create the archive table (same schema, no indexes needed for writes)
CREATE TABLE outbox_events_archive (
  LIKE outbox_events INCLUDING DEFAULTS
);

-- The archive needs minimal indexes — it is queried rarely
CREATE INDEX idx_archive_aggregate
  ON outbox_events_archive (aggregate_type, aggregate_id, created_at);

-- Step 2: Archive and delete in one transaction
BEGIN;
  INSERT INTO outbox_events_archive
  SELECT * FROM outbox_events
  WHERE status = 'PUBLISHED'
    AND published_at < NOW(6) - INTERVAL '7 days'
  LIMIT 10000;

  DELETE FROM outbox_events
  WHERE status = 'PUBLISHED'
    AND published_at < NOW(6) - INTERVAL '7 days'
    AND id IN (
      SELECT id FROM outbox_events_archive
      WHERE created_at > NOW(6) - INTERVAL '1 hour'
    );
COMMIT;
```

The Prisma schema for the archive table:

```prisma
// prisma/schema.prisma
model OutboxEventArchive {
  id             BigInt    @id
  aggregateType  String    @map("aggregate_type") @db.VarChar(100)
  aggregateId    String    @map("aggregate_id") @db.VarChar(100)
  eventType      String    @map("event_type") @db.VarChar(150)
  topic          String    @db.VarChar(255)
  partitionKey   String    @map("partition_key") @db.VarChar(255)
  payload        Json      @db.JsonB
  headers        Json      @default("{}") @db.JsonB
  status         String    @db.VarChar(20)
  retryCount     Int       @map("retry_count")
  maxRetries     Int       @map("max_retries")
  errorMessage   String?   @map("error_message") @db.Text
  createdAt      DateTime  @map("created_at") @db.Timestamptz()
  publishedAt    DateTime? @map("published_at") @db.Timestamptz()
  nextRetryAt    DateTime? @map("next_retry_at") @db.Timestamptz()
  expiredAt      DateTime? @map("expired_at") @db.Timestamptz()

  @@index([aggregateType, aggregateId, createdAt], name: "idx_archive_aggregate")
  @@map("outbox_events_archive")
}
```

### Approach 3: Table Partitioning by Date

For high-volume systems, partition the outbox table by creation date. This makes cleanup instantaneous — you drop an entire partition instead of deleting individual rows:

```sql
-- Create a partitioned outbox table (run once during setup)
CREATE TABLE outbox_events (
  id              BIGSERIAL,
  aggregate_type  VARCHAR(100)  NOT NULL,
  aggregate_id    VARCHAR(100)  NOT NULL,
  event_type      VARCHAR(150)  NOT NULL,
  topic           VARCHAR(255)  NOT NULL,
  partition_key   VARCHAR(255)  NOT NULL,
  payload         JSON         NOT NULL,
  headers         JSON         DEFAULT '{}',
  status          VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  retry_count     INT           NOT NULL DEFAULT 0,
  max_retries     INT           NOT NULL DEFAULT 5,
  error_message   TEXT,
  created_at      DATETIME(6)   NOT NULL DEFAULT NOW(6),
  published_at    DATETIME(6),
  next_retry_at   DATETIME(6),
  expired_at      DATETIME(6),
  PRIMARY KEY (id, created_at)  -- partition key must be in the PK
) PARTITION BY RANGE (created_at);

-- Create partitions for each week
CREATE TABLE outbox_events_2026_w07
  PARTITION OF outbox_events
  FOR VALUES FROM ('2026-02-09') TO ('2026-02-16');

CREATE TABLE outbox_events_2026_w08
  PARTITION OF outbox_events
  FOR VALUES FROM ('2026-02-16') TO ('2026-02-23');

-- Cleanup: drop an entire week's partition instantly
-- (only after confirming all events in it are PUBLISHED)
DROP TABLE outbox_events_2026_w05;
```

> **Mentor's Advice:** Start with Approach 1 (simple DELETE). Add archiving when your team needs to debug past events. Move to partitioning when your outbox table exceeds 10 million rows or when DELETE operations start causing lock contention. Most teams never need partitioning.

---

## Full NestJS OutboxService Implementation

Now let us bring everything together into a production-ready NestJS module. This is the service your application code uses to write events to the outbox. It does not know about Kafka — it only knows about the database.

```typescript
// libs/outbox/src/outbox.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/prisma';

// Type-safe event payload interface
export interface OutboxEventInput {
  aggregateType: string;    // 'Booking', 'Payment', 'Room'
  aggregateId:   string;    // 'BK-99001', 'PAY-4420'
  eventType:     string;    // 'booking.created', 'payment.charged'
  topic:         string;    // Kafka topic name
  partitionKey?: string;    // defaults to aggregateId
  payload:       Record<string, unknown>;
  headers?:      Record<string, string>;
  maxRetries?:   number;    // defaults to 5
}

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an event to the outbox table. This method is designed to be called
   * inside a Prisma interactive transaction, so the event is committed atomically
   * with your business data.
   *
   * Usage:
   *   await prisma.$transaction(async (tx) => {
   *     const booking = await tx.booking.create({ data: { ... } });
   *     await outboxService.writeEvent(tx, {
   *       aggregateType: 'Booking',
   *       aggregateId:   String(booking.id),
   *       eventType:     'booking.created',
   *       topic:         'booking-events',
   *       payload:       { bookingId: booking.id, status: 'CONFIRMED' },
   *     });
   *   });
   */
  async writeEvent(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    input: OutboxEventInput,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateType: input.aggregateType,
        aggregateId:   input.aggregateId,
        eventType:     input.eventType,
        topic:         input.topic,
        partitionKey:  input.partitionKey ?? input.aggregateId,
        payload:       input.payload,
        headers:       input.headers ?? {},
        maxRetries:    input.maxRetries ?? 5,
      },
    });
  }

  /**
   * Write multiple events atomically. Useful when a single business operation
   * produces multiple events (e.g., booking creation triggers both
   * 'booking.created' and 'inventory.reserved').
   */
  async writeEvents(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    inputs: OutboxEventInput[],
  ): Promise<void> {
    // Prisma does not support createMany inside interactive transactions
    // with JSON fields in all adapters, so we loop:
    for (const input of inputs) {
      await this.writeEvent(tx, input);
    }
  }

  /**
   * Query the current outbox status. Useful for health checks
   * and monitoring dashboards.
   */
  async getStatus(): Promise<{
    pending:    number;
    published:  number;
    failed:     number;
    deadLetter: number;
    oldestPendingAge: number | null; // seconds
  }> {
    const counts = await this.prisma.$queryRaw<
      { status: string; count: bigint }[]
    >`
      SELECT status, COUNT(*) as count
      FROM outbox_events
      GROUP BY status
    `;

    const oldest = await this.prisma.$queryRaw<
      { age_seconds: number }[]
    >`
      SELECT EXTRACT(EPOCH FROM (NOW(6) - MIN(created_at))) as age_seconds
      FROM outbox_events
      WHERE status = 'PENDING'
    `;

    const countMap = Object.fromEntries(
      counts.map(c => [c.status, Number(c.count)])
    );

    return {
      pending:          countMap['PENDING']     ?? 0,
      published:        countMap['PUBLISHED']   ?? 0,
      failed:           countMap['FAILED']      ?? 0,
      deadLetter:       countMap['DEAD_LETTER'] ?? 0,
      oldestPendingAge: oldest[0]?.age_seconds ?? null,
    };
  }
}
```

### The NestJS Outbox Poller Module

The poller runs as a separate NestJS microservice or as a background worker within your main application. It uses `@nestjs/schedule` for the polling loop:

```typescript
// libs/outbox/src/outbox-poller.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '@app/prisma';
import { KafkaProducerService } from '@app/kafka';
import { Counter, Histogram, Gauge } from 'prom-client';

@Injectable()
export class OutboxPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPollerService.name);
  private isProcessing = false;

  // ─── Prometheus Metrics ────────────────────────────────
  private readonly publishedCounter = new Counter({
    name: 'outbox_events_published_total',
    help: 'Total outbox events published to Kafka',
    labelNames: ['topic', 'event_type'],
  });

  private readonly failedCounter = new Counter({
    name: 'outbox_events_failed_total',
    help: 'Total outbox event publish failures',
    labelNames: ['topic', 'event_type'],
  });

  private readonly lagGauge = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest pending outbox event in seconds',
  });

  private readonly batchDuration = new Histogram({
    name: 'outbox_batch_duration_seconds',
    help: 'Time to process one outbox batch',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  onModuleInit() {
    this.logger.log('Outbox poller initialized');
  }

  onModuleDestroy() {
    this.logger.log('Outbox poller shutting down');
    this.isProcessing = false;
  }

  // Poll every 100ms. The @Interval decorator from @nestjs/schedule
  // ensures this method is called repeatedly.
  @Interval(100)
  async poll(): Promise<void> {
    // Guard: if the previous batch is still processing, skip this tick.
    // This prevents overlapping batch processing within the same instance.
    if (this.isProcessing) return;
    this.isProcessing = true;

    const timer = this.batchDuration.startTimer();
    try {
      await this.publishBatch();
    } catch (error) {
      this.logger.error('Outbox poll failed', error);
    } finally {
      timer();
      this.isProcessing = false;
    }
  }

  private async publishBatch(): Promise<void> {
    const batchSize = parseInt(process.env.OUTBOX_BATCH_SIZE || '100');

    const published = await this.prisma.$transaction(async (tx) => {
      const events = await tx.$queryRaw<any[]>`
        SELECT id, aggregate_type AS "aggregateType",
               aggregate_id AS "aggregateId",
               event_type AS "eventType",
               topic, partition_key AS "partitionKey",
               payload, headers, created_at AS "createdAt"
        FROM outbox_events
        WHERE status = 'PENDING'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW(6))
        ORDER BY id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      if (events.length === 0) return 0;

      // Group by topic for efficient publishing
      const byTopic = new Map<string, any[]>();
      for (const evt of events) {
        if (!byTopic.has(evt.topic)) byTopic.set(evt.topic, []);
        byTopic.get(evt.topic)!.push(evt);
      }

      // Publish each topic group
      for (const [topic, topicEvents] of byTopic) {
        await this.kafkaProducer.send({
          topic,
          messages: topicEvents.map(evt => ({
            key:   evt.partitionKey,
            value: JSON.stringify({
              eventId:       String(evt.id),
              eventType:     evt.eventType,
              aggregateType: evt.aggregateType,
              aggregateId:   evt.aggregateId,
              payload:       evt.payload,
              timestamp:     new Date().toISOString(),
            }),
            headers: {
              'event-type':     evt.eventType,
              'aggregate-type': evt.aggregateType,
              'aggregate-id':   evt.aggregateId,
              'outbox-id':      String(evt.id),
            },
          })),
        });

        // Update metrics
        for (const evt of topicEvents) {
          this.publishedCounter.inc({
            topic,
            event_type: evt.eventType,
          });
        }
      }

      // Mark all events as PUBLISHED
      await tx.outboxEvent.updateMany({
        where: { id: { in: events.map(e => e.id) } },
        data:  { status: 'PUBLISHED', publishedAt: new Date() },
      });

      return events.length;
    }, { timeout: 30_000 });

    // Update lag metric after each batch
    if (published > 0) {
      await this.updateLagMetric();
    }
  }

  private async updateLagMetric(): Promise<void> {
    const result = await this.prisma.$queryRaw<{ age_seconds: number }[]>`
      SELECT EXTRACT(EPOCH FROM (NOW(6) - MIN(created_at))) AS age_seconds
      FROM outbox_events
      WHERE status = 'PENDING'
    `;
    this.lagGauge.set(result[0]?.age_seconds ?? 0);
  }
}
```

---

## Monitoring Outbox Lag: Alerting When Events Are Delayed

The outbox pattern guarantees events are not lost, but it does not guarantee they are delivered quickly. If your publisher crashes, if Kafka is down for an extended period, or if a database lock conflict stalls the poller, events can pile up in the outbox table. That pile-up is called **outbox lag**, and you need to monitor it.

### What to Measure

There are four critical metrics for outbox health:

```
1. Pending event count     — How many events are waiting to be published?
2. Oldest pending event age — How old is the oldest unprocessed event?
3. Publish throughput       — How many events per second are being published?
4. Failed event count       — How many events have exhausted their retries?
```

### SQL Queries for a Monitoring Dashboard

```sql
-- Metric 1: Pending event count by aggregate type
SELECT aggregate_type, COUNT(*) AS pending_count
FROM outbox_events
WHERE status = 'PENDING'
GROUP BY aggregate_type;

-- Metric 2: Oldest pending event age in seconds
SELECT EXTRACT(EPOCH FROM (NOW(6) - MIN(created_at))) AS oldest_pending_seconds
FROM outbox_events
WHERE status = 'PENDING';

-- Metric 3: Publish throughput (events published in the last minute)
SELECT COUNT(*) AS published_last_minute
FROM outbox_events
WHERE status = 'PUBLISHED'
  AND published_at > NOW(6) - INTERVAL '1 minute';

-- Metric 4: Failed events requiring manual attention
SELECT id, aggregate_type, aggregate_id, event_type,
       retry_count, error_message, created_at
FROM outbox_events
WHERE status = 'FAILED'
ORDER BY created_at ASC;
```

The Prisma Client equivalents:

```typescript
// monitoring/src/outbox-health.service.ts

// Metric 1: Pending count by aggregate type
const pendingByType = await prisma.outboxEvent.groupBy({
  by: ['aggregateType'],
  where: { status: 'PENDING' },
  _count: { id: true },
});

// Metric 2: Oldest pending age
const oldestPending = await prisma.outboxEvent.findFirst({
  where: { status: 'PENDING' },
  orderBy: { createdAt: 'asc' },
  select: { createdAt: true },
});
const oldestAgeSeconds = oldestPending
  ? (Date.now() - oldestPending.createdAt.getTime()) / 1000
  : 0;

// Metric 3: Throughput in the last minute
const oneMinuteAgo = new Date(Date.now() - 60_000);
const recentlyPublished = await prisma.outboxEvent.count({
  where: {
    status: 'PUBLISHED',
    publishedAt: { gte: oneMinuteAgo },
  },
});

// Metric 4: Failed events needing attention
const failedEvents = await prisma.outboxEvent.findMany({
  where: { status: 'FAILED' },
  orderBy: { createdAt: 'asc' },
  select: {
    id: true,
    aggregateType: true,
    aggregateId: true,
    eventType: true,
    retryCount: true,
    errorMessage: true,
    createdAt: true,
  },
});
```

### Alert Thresholds

Set up alerts in your monitoring system (Prometheus + Grafana, Datadog, or similar) for these conditions:

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Outbox lag warning | Oldest pending event > 30 seconds | Warning | Check publisher health |
| Outbox lag critical | Oldest pending event > 5 minutes | Critical | Page on-call engineer |
| Outbox backlog | Pending count > 10,000 | Warning | Scale publishers or investigate |
| Failed events | Any event with status = FAILED | Warning | Investigate error_message |
| Dead letter events | Any event with status = DEAD_LETTER | Critical | Manual intervention required |
| Publisher throughput drop | Published/minute drops below baseline by 50% | Warning | Check Kafka connectivity |

> **Mentor's Advice:** The `oldest_pending_seconds` metric is the single most important number for your outbox. If it is under 1 second, your system is healthy. If it climbs to 30 seconds, something is wrong. If it hits 5 minutes, wake someone up. This one metric tells you whether events are flowing or stuck.

---

## Exactly-Once Delivery Considerations

The outbox pattern guarantees **at-least-once delivery**: every event will be published to Kafka at least once. But can the same event be published twice? Yes. Here is how:

```
Scenario: Duplicate delivery

1. Publisher SELECT ... FOR UPDATE SKIP LOCKED → grabs event #5001
2. Publisher calls kafka.send(event #5001) → Kafka receives it, writes to partition
3. Kafka sends acknowledgment back to publisher...
4. Network hiccup: the ack is lost. Publisher never sees it.
5. Publisher's kafka.send() throws TimeoutError.
6. Publisher catches the error, rolls back the transaction.
7. Event #5001's status is still PENDING.
8. Next poll cycle: publisher grabs event #5001 again.
9. Publisher calls kafka.send(event #5001) → Kafka receives it AGAIN.
10. This time the ack arrives. Publisher marks it PUBLISHED.

Result: Event #5001 was delivered to Kafka TWICE.
```

This is inherent to any at-least-once system. The outbox pattern does not cause it — it is a fundamental property of distributed messaging. Your consumers must handle duplicates. There are two strategies:

### Strategy 1: Idempotent Consumers

Every outbox event has a unique `id` (the `BIGSERIAL` primary key). Include this ID in the Kafka message headers as `outbox-id`. Consumers track which event IDs they have already processed:

```typescript
// consumer-service/src/booking-event.consumer.ts
async handleBookingCreated(message: KafkaMessage): Promise<void> {
  const outboxId = message.headers['outbox-id'];

  // Check if we already processed this event
  const alreadyProcessed = await this.prisma.processedEvent.findUnique({
    where: { outboxId: BigInt(outboxId) },
  });

  if (alreadyProcessed) {
    this.logger.debug(`Skipping duplicate event ${outboxId}`);
    return; // idempotent: do nothing
  }

  // Process the event
  const payload = JSON.parse(message.value.toString());
  await this.prisma.$transaction(async (tx) => {
    // 1. Do the actual work
    await tx.searchIndex.upsert({
      where: { bookingId: BigInt(payload.payload.bookingId) },
      create: { bookingId: BigInt(payload.payload.bookingId), status: 'CONFIRMED' },
      update: { status: 'CONFIRMED' },
    });

    // 2. Record that we processed this event (same transaction)
    await tx.processedEvent.create({
      data: { outboxId: BigInt(outboxId), processedAt: new Date() },
    });
  });
}
```

The Prisma schema for the processed events table:

```prisma
// prisma/schema.prisma (in the consumer service)
model ProcessedEvent {
  outboxId    BigInt   @id @map("outbox_id")
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz()

  @@map("processed_events")
}
```

### Strategy 2: Naturally Idempotent Operations

Some operations are inherently idempotent — running them twice produces the same result. If your consumer's logic is naturally idempotent, you do not need the `processed_events` table:

```typescript
// These operations are naturally idempotent:
// - Upsert (INSERT ON CONFLICT UPDATE): same data, same result
await tx.searchIndex.upsert({ where: { bookingId }, create: data, update: data });

// - Setting a status: CONFIRMED → CONFIRMED is a no-op
await tx.booking.update({
  where: { id: bookingId },
  data: { status: 'CONFIRMED' }, // already CONFIRMED? No harm done.
});

// These operations are NOT naturally idempotent:
// - Incrementing a counter: balance + 100 run twice = balance + 200
await tx.account.update({ where: { id }, data: { balance: { increment: 100 } } });
// ← DANGEROUS if replayed. Use Strategy 1 for these.
```

> **Key Term:** **Idempotent consumer** — A message consumer that produces the same result regardless of how many times it processes the same message. Achieving idempotency is the consumer's responsibility, not the broker's. The outbox pattern provides unique event IDs to make idempotency checks straightforward.

---

## Production War Story: The Black Friday Booking Blackout

This is a real incident, with names and details changed.

**The Setup:** A travel booking platform ran three services: Booking Service, Notification Service, and Search Service. The Booking Service used the naive approach — save the booking, then publish to Kafka. No outbox pattern. The code had been in production for 14 months without a single problem. The team was confident.

**D-Day: Black Friday, 06:00 UTC.** Traffic spikes to 15x normal. The Kafka cluster, which had been running at 30% capacity, hits 92% CPU. At 06:14, one of three Kafka brokers restarts due to a JVM garbage collection pause. For 8 seconds, one third of Kafka partitions are unavailable.

**The Damage:**

```
06:14:00 - 06:14:08  (8 seconds of partial Kafka outage)
  - 847 bookings created successfully in PostgreSQL
  - 312 of those bookings' Kafka publish calls timed out
  - 312 'booking.created' events were NEVER published

Effect on Notification Service:
  - 312 users never received confirmation emails
  - 94 users called customer support asking "did my booking work?"
  - Support agents could not verify — their dashboard
    depended on events too

Effect on Search Service:
  - 312 hotel rooms still showed as "available"
  - 78 of those rooms were double-booked by other users
  - 78 guests arrived at their hotels to find no room
  - Total compensation paid: $47,000 in refunds and rebookings

Effect on Revenue Reconciliation:
  - Finance team's reports showed 312 fewer bookings than
    the database had
  - Took 3 engineers 2 days to manually reconcile
  - Total engineering cost: ~40 person-hours
```

**The Fix:** The team implemented the outbox pattern in a single sprint. The key changes:

1. Added the `outbox_events` table to the Booking Service database.
2. Modified `createBooking()` to write the event in the same transaction.
3. Deployed an outbox publisher service with two replicas.
4. Added the `outbox_lag_seconds` metric with a 30-second warning alert.

**Verification:** Two weeks later, a Kafka broker restarted during a routine upgrade. The outbox publisher paused for 12 seconds, then resumed. All 203 events that had accumulated during the outage were published within 2 seconds of Kafka recovering. Zero events lost. Zero customer impact. The lag alert fired at 12 seconds, but by the time the on-call engineer checked their phone, the metric was back to normal.

> **What This Story Teaches:** The outbox pattern is not a nice-to-have architectural embellishment. It is the difference between "Kafka blipped and nobody noticed" and "Kafka blipped and we spent $47,000 cleaning up the mess." The pattern is boring by design. Boring is what you want in infrastructure.

---

## Common Mistakes with the Outbox Pattern

Even after adopting the outbox, teams make predictable mistakes. Here are the ones we see most often, and how to avoid them:

### Mistake 1: Writing the Outbox Event Outside the Transaction

```typescript
// WRONG: outbox write is OUTSIDE the transaction
const booking = await this.prisma.$transaction(async (tx) => {
  return tx.booking.create({ data: { ... } });
});

// This is AFTER the transaction commits — same dual-write problem!
await this.prisma.outboxEvent.create({
  data: { aggregateType: 'Booking', ... },
});
```

**Why it fails:** If the application crashes between the transaction commit and the outbox insert, the booking exists but the event does not. You have re-created the dual-write problem.

**Fix:** Always write the outbox event inside the same `$transaction` block as your business data.

### Mistake 2: Not Using FOR UPDATE SKIP LOCKED

```typescript
// WRONG: no row locking
const events = await tx.outboxEvent.findMany({
  where: { status: 'PENDING' },
  take: 100,
  orderBy: { id: 'asc' },
});
```

**Why it fails:** If two publisher instances run this query simultaneously, they both grab the same 100 events. Both publish them to Kafka. Every event is delivered twice. With high-volume traffic, this creates a flood of duplicates.

**Fix:** Use `$queryRaw` with `FOR UPDATE SKIP LOCKED` so each publisher instance locks and processes a different set of events.

### Mistake 3: Not Monitoring the Outbox

**What happens:** The publisher crashes. Nobody notices for three days. By then, 500,000 events are backed up. When the publisher restarts, it publishes all 500,000 events at once, overwhelming downstream consumers.

**Fix:** Monitor `outbox_lag_seconds` and `pending_count`. Set alerts. The 30-second warning threshold catches problems within minutes, not days.

### Mistake 4: Never Cleaning Up Published Events

**What happens:** The outbox table grows to 50 million rows. The publisher's polling query slows from 5ms to 800ms. The partial index on `status = 'PENDING'` helps, but the table itself becomes a maintenance burden — backups take longer, VACUUM runs longer, and disk usage climbs.

**Fix:** Run a daily or hourly cleanup job that deletes or archives published events older than 7 days. See the "Outbox Cleanup" section above.

### Mistake 5: Putting Sensitive Data in the Outbox Payload

```typescript
// WRONG: PII in the outbox payload
await tx.outboxEvent.create({
  data: {
    eventType: 'booking.created',
    payload: {
      userId: user.id,
      email: user.email,           // PII
      creditCardLast4: '4242',     // payment data
      passportNumber: 'AB1234567', // highly sensitive
    },
  },
});
```

**Why it fails:** The outbox table is a long-lived store. Even after events are published, rows may sit in the table (or the archive) for days or weeks. Anyone with database access can read the raw payload. GDPR right-to-erasure requests become complicated — you have to scrub the outbox and its archives.

**Fix:** Put only identifiers in the payload, not sensitive data. Consumers can look up the full details from their own database or the source service.

### Mistake 6: Using the Outbox for Synchronous Communication

```typescript
// WRONG: waiting for the outbox event to be published
const booking = await this.prisma.$transaction(async (tx) => {
  const b = await tx.booking.create({ data: { ... } });
  await tx.outboxEvent.create({ data: { ... } });
  return b;
});

// Polling the outbox to see if the event was published
while (true) {
  const event = await this.prisma.outboxEvent.findFirst({
    where: { aggregateId: String(booking.id), status: 'PUBLISHED' },
  });
  if (event) break;
  await sleep(50);
}
// ← This defeats the entire purpose of the outbox pattern
```

**Why it fails:** The outbox is designed for asynchronous, fire-and-forget event publishing. Polling the outbox table to wait for delivery turns an async pattern into a synchronous one, adding latency and database load. If you need synchronous confirmation, use a direct API call instead.

---

## Chapter Summary

| Concept | Key Point |
|---------|-----------|
| **Dual-write problem** | Writing to a database and a message broker in sequence without a spanning transaction is unsafe — the second write can fail, leaving the systems permanently inconsistent. |
| **Outbox pattern** | Write the event to an `outbox_events` table in the same database transaction as the business data. A separate publisher reads the outbox and publishes to Kafka. The event lives in the database until delivery is confirmed. |
| **Outbox table design** | Columns include `aggregate_type`, `aggregate_id`, `event_type`, `topic`, `partition_key`, `payload`, `status`, `retry_count`, and timestamps. Partial indexes on `status = 'PENDING'` are critical for poll performance. |
| **FOR UPDATE SKIP LOCKED** | The core SQL clause that allows multiple publisher instances to process different events concurrently without duplicates and without blocking each other. |
| **Polling publisher** | A background loop that SELECTs pending events, publishes them to Kafka, and marks them as PUBLISHED. Simple, reliable, and written in your application language. |
| **CDC with Debezium** | An alternative to polling that reads the PostgreSQL WAL directly. Lower latency, no database polling load, but requires Kafka Connect infrastructure. |
| **Ordering guarantees** | Sequential outbox IDs + Kafka partition keys + per-aggregate publishing ensure events for the same aggregate arrive in causal order. |
| **Outbox cleanup** | Delete or archive published events periodically. Start with simple DELETEs, add archiving for auditing, move to table partitioning at scale. |
| **Exactly-once delivery** | The outbox provides at-least-once delivery. Consumers must be idempotent — either by tracking processed event IDs or by using naturally idempotent operations. |
| **Monitoring** | Track `outbox_lag_seconds` (age of oldest pending event), pending count, publish throughput, and failed event count. Alert at 30 seconds lag, page at 5 minutes. |
| **Key lesson** | The outbox pattern is infrastructure insurance. It costs almost nothing to implement, and it prevents the class of silent data inconsistency bugs that are hardest to detect and most expensive to fix. |

> **What Comes Next:** In Chapter 19, we will look at the other side of reliable messaging — the **Inbox Pattern** — which ensures that your consumers process incoming events exactly once, even if Kafka delivers the same message multiple times. The outbox guarantees reliable publishing; the inbox guarantees reliable consumption. Together, they form the backbone of a trustworthy event-driven architecture.
