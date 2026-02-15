# PART III: DISTRIBUTED SYSTEMS PATTERNS

In a single-server application, failures are binary: the process is running or it is not. Distributed systems introduce a third, far more dangerous state -- partial failure. A payment service might have charged the customer while the inventory service never received the hold request. A lock might expire while the service holding it is stuck in a garbage collection pause. Two regions might simultaneously accept the last available room. These are not edge cases; at 100,000 bookings per minute across four global regions, they are certainties.

Part II showed the happy path. This part shows what happens when networks partition, services crash, and locks expire. The patterns in Sections 11 through 16 are the defensive infrastructure that prevents data corruption, ensures exactly-once semantics, and keeps the system consistent across continents. Each pattern addresses a specific failure mode: fencing tokens prevent stale writes after lock expiry, idempotency keys prevent duplicate processing after retries, the outbox pattern prevents lost events after crashes, sagas coordinate multi-service transactions with rollback capabilities, and CQRS separates read and write paths so neither becomes the bottleneck.

These patterns are not independent -- they compose into a layered defense. The outbox pattern (Section 14) relies on the same database transactions used by idempotent booking creation (Section 12). The saga orchestrator (Section 15) uses fencing tokens from Section 11 and publishes events through the outbox from Section 14. CQRS (Section 16) consumes the events that every other pattern produces. Understanding how these pieces interlock is as important as understanding each pattern individually.

---

## 11. Distributed Locking & Fencing Tokens

> **Learning Objectives**
> - Understand why distributed locks alone are insufficient to prevent race conditions in inventory reservations.
> - Explain how fencing tokens provide a monotonically increasing guard against stale writes after lock expiry.
> - Implement database-level fencing token enforcement using SQL `WHERE` clauses.
> - Trace through a timeline where a GC pause causes lock expiry and demonstrate how fencing tokens reject the stale write.

**Why:** Prevent race conditions in inventory reservations across multiple servers. When two booking requests arrive simultaneously for the last available room, only one should succeed. Distributed locks alone aren't sufficient -- if a lock expires while a service is still processing, two services may both think they hold the lock. Fencing tokens solve this by giving each lock acquisition a monotonically increasing number that the database uses to reject stale writes.

### 11.1 Fenced Redlock Implementation

```typescript
// ============================================
// Fenced Redlock Implementation
// ============================================

import Redlock from 'redlock';
import Redis from 'ioredis';

export class FencedRedlockService {
  private redlock: Redlock;
  private fencingCounter: Redis;

  constructor() {
    // Multiple Redis instances for quorum-based consensus
    const redisClients = [
      new Redis({ host: 'redis-lock-1.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-2.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-3.cluster.local', port: 6379 })
    ];

    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200
    });

    // Separate Redis for fencing tokens (single source of truth)
    this.fencingCounter = new Redis({
      host: 'redis-fencing.cluster.local'
    });
  }

  /**
   * Acquire lock with monotonically increasing fencing token
   */
  async acquireLockWithFencing(
    resourceKey: string,
    ttlMs: number = 10000
  ): Promise<{ lock: Redlock.Lock; fencingToken: number } | null> {

    try {
      // Step 1: Acquire distributed lock across Redis quorum
      const lock = await this.redlock.acquire([resourceKey], ttlMs);

      // Step 2: Get fencing token (atomic increment -- guaranteed monotonic)
      const fencingToken = await this.fencingCounter.incr(`fence:${resourceKey}`);

      // Step 3: Store active token with TTL matching the lock
      await this.fencingCounter.set(
        `fence:active:${resourceKey}`,
        fencingToken,
        'EX',
        Math.ceil(ttlMs / 1000)
      );

      return { lock, fencingToken };

    } catch (error) {
      // Lock acquisition failed -- resource is locked by another process
      return null;
    }
  }

  /**
   * Release lock with token verification
   */
  async releaseLock(
    resourceKey: string,
    lock: Redlock.Lock,
    fencingToken: number
  ): Promise<boolean> {

    // Verify this token is still the active one
    const currentToken = await this.fencingCounter.get(
      `fence:active:${resourceKey}`
    );

    if (currentToken && parseInt(currentToken) !== fencingToken) {
      console.warn(`Fencing token mismatch. Lock may have been superseded.`);
      return false;
    }

    await lock.release();
    return true;
  }
}
```

### 11.2 Database-Level Fencing Token Enforcement

The fencing token check happens in the database `WHERE` clause, not in application code. This means even if two services bypass distributed locking, the database itself rejects stale writes:

```sql
-- Inventory update with fencing token check
-- Only succeeds if our token is higher than the stored one
UPDATE inventory
SET available_quantity = available_quantity - ?,
    reserved_quantity = reserved_quantity + ?,
    fencing_token = ?,
    updated_at = NOW()
WHERE resource_type = ?
AND resource_id = ?
AND resource_date = ?
AND available_quantity >= ?
AND (fencing_token IS NULL OR fencing_token < ?);

-- If affectedRows === 0, either:
-- 1. Not enough inventory (available_quantity < requested)
-- 2. Stale fencing token (another process already wrote a higher token)
-- Both are safe rejections
```

### 11.3 Why Fencing Tokens, Not Just Locks

```
Timeline showing why locks alone fail:

Service A: [--- acquires lock at T=0 ---]
           [--- GC pause at T=8s ---> lock expires at T=10s ---]
           [--- resumes, writes to DB at T=12s ---] <- STALE WRITE!

Service B:              [--- acquires same lock at T=10s ---]
                        [--- writes to DB at T=11s ---]

With fencing tokens:
Service A gets token=42, Service B gets token=43

At T=11s: DB has fencing_token=43 (from Service B)
At T=12s: Service A tries to write with token=42
          WHERE fencing_token < 42 -> FALSE (43 is not < 42)
          affectedRows = 0 -> Write rejected safely
```

### Key Takeaways

- Distributed locks have a fundamental flaw: they can expire while the holder is still processing (due to GC pauses, network delays, or slow I/O), allowing two services to believe they hold the lock simultaneously.
- Fencing tokens are monotonically increasing numbers assigned at lock acquisition time. The database uses them in `WHERE` clauses to reject any write carrying a token lower than the one already stored.
- The safety guarantee lives in the database, not the application. Even if application-level lock checks fail, the SQL `WHERE fencing_token < ?` clause serves as the last line of defense.
- Redlock provides quorum-based consensus across multiple Redis instances, but it only solves lock *acquisition* -- fencing tokens solve the stale *write* problem after expiry.

### Review Questions

1. In the `acquireLockWithFencing` method, why is the fencing token stored in a *separate* Redis instance from the Redlock quorum nodes? What would happen if the fencing counter shared a Redis instance that went down?
2. The SQL update uses `AND (fencing_token IS NULL OR fencing_token < ?)`. Why is the `IS NULL` check necessary? Under what circumstance would the fencing token column be NULL?
3. In the timeline diagram (Section 11.3), Service A resumes after a GC pause and writes at T=12s. Suppose the system used only distributed locks (no fencing tokens) and Service A checked `lock.isValid()` before writing. Would this prevent the stale write? Why or why not?

### Hands-On Exercise

**Exercise: Simulate a Fencing Token Race Condition**

Write a test that simulates the GC-pause scenario from Section 11.3. Create two async functions representing Service A and Service B. Service A acquires a lock and fencing token, then sleeps for longer than the lock TTL (simulating a GC pause). Service B acquires the same lock after expiry and writes to a mock inventory table. When Service A wakes up and attempts its write, assert that the write is rejected (affectedRows === 0) because Service B's higher fencing token is already stored. Use an in-memory object or SQLite table as your mock database, and implement the `WHERE fencing_token < ?` check in your mock update function.

---

## 12. Idempotency & Exactly-Once Processing

> **Learning Objectives**
> - Explain why idempotency is essential in distributed systems where retries, duplicate requests, and network failures are routine.
> - Implement deterministic idempotency key generation from booking parameters so that duplicate requests produce the same key.
> - Handle race conditions where two identical requests arrive simultaneously using database duplicate-entry detection.
> - Apply idempotency at the API gateway level to cache and replay responses for repeated requests.

**Why:** Networks are unreliable. Users double-click buttons. Services retry failed requests. Without idempotency, the same booking could be created twice, the same payment charged twice, or the same inventory reserved twice. Idempotency keys ensure that repeating an operation produces the same result as doing it once.

### 12.1 Idempotent Booking Creation

```typescript
// ============================================
// Idempotent Booking Creation
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // Generate deterministic idempotency key from booking parameters
    const idempotencyKey = dto.idempotencyKey || this.generateIdempotencyKey(dto);

    // Check if booking already exists for this key
    const existingBooking = await this.findByIdempotencyKey(
      dto.userId,
      idempotencyKey
    );

    if (existingBooking) {
      // Return existing booking -- idempotent response
      return existingBooking;
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Create booking with idempotency key
      const [result] = await connection.execute(`
        INSERT INTO bookings (
          user_id, booking_type, reference_code, idempotency_key,
          subtotal, tax_amount, discount_amount, total_amount, currency,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [
        dto.userId, dto.bookingType,
        this.generateReferenceCode(dto.bookingType),
        idempotencyKey,
        dto.subtotal, dto.taxAmount, dto.discountAmount,
        dto.totalAmount, dto.currency
      ]);

      const bookingId = result.insertId;
      await this.createSubTypeRecord(connection, bookingId, dto);

      // Write event to outbox (Section 14)
      await connection.execute(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, topic, partition_key
        ) VALUES ('booking', ?, 'booking.created', ?, 'booking-events', ?)
      `, [bookingId, JSON.stringify({
        bookingId, userId: dto.userId, bookingType: dto.bookingType,
        totalAmount: dto.totalAmount, currency: dto.currency
      }), `user:${dto.userId}`]);

      await connection.commit();
      return this.getBookingById(bookingId);

    } catch (error) {
      await connection.rollback();

      // Handle race condition: another request created the booking
      if (error.code === 'ER_DUP_ENTRY') {
        return this.findByIdempotencyKey(dto.userId, idempotencyKey);
      }

      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Generate deterministic key from booking parameters.
   * Same user + same resource + same time window = same key.
   */
  private generateIdempotencyKey(dto: CreateBookingDto): string {
    const payload = {
      userId: dto.userId,
      resourceId: dto.resourceId,
      checkIn: dto.checkIn?.toISOString(),
      checkOut: dto.checkOut?.toISOString(),
      timestamp: Math.floor(Date.now() / 60000)  // Same minute
    };

    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
      .substring(0, 32);
  }
}
```

### 12.2 Idempotency at the API Gateway Level

```typescript
// Middleware to handle idempotency keys for all POST/PUT requests

export class IdempotencyMiddleware {
  async handle(req: Request, res: Response, next: NextFunction) {
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey) {
      return next(); // Let the service handle it
    }

    // Check Redis for cached response
    const cached = await redis.get(`idempotency:${idempotencyKey}`);

    if (cached) {
      const { statusCode, body } = JSON.parse(cached);
      return res.status(statusCode).json(body);
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Cache successful responses for 24 hours
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.setex(
          `idempotency:${idempotencyKey}`,
          86400,
          JSON.stringify({ statusCode: res.statusCode, body })
        );
      }
      return originalJson(body);
    };

    next();
  }
}
```

### Key Takeaways

- Idempotency operates at two levels: the service level (deterministic key generation from booking parameters, database unique constraints) and the API gateway level (caching full HTTP responses keyed by an `Idempotency-Key` header).
- Deterministic key generation using a SHA-256 hash of user, resource, dates, and a one-minute time window means that even if the client does not send an idempotency key, the system can detect duplicate intent.
- The `ER_DUP_ENTRY` catch block handles the race condition where two identical requests pass the initial `findByIdempotencyKey` check simultaneously -- the database unique constraint is the final arbiter.
- The outbox event write inside the same transaction (line referencing Section 14) shows how idempotency and the outbox pattern compose: the booking and its event are created atomically, and the idempotency key prevents duplicate events.

### Review Questions

1. The `generateIdempotencyKey` method includes `Math.floor(Date.now() / 60000)` in the hash payload. What is the effect of this one-minute window? What would happen if the timestamp granularity were one second instead? What if it were removed entirely?
2. In the `IdempotencyMiddleware`, only successful responses (status 200-299) are cached. Why is it important *not* to cache error responses? Consider a scenario where a transient database error causes a 500 response -- what would happen if that response were cached for 24 hours?
3. Walk through the code path when two identical `createBooking` requests arrive within the same millisecond. Both pass the `findByIdempotencyKey` check (no existing booking found). What happens next, and how does the system ensure only one booking is created?

### Hands-On Exercise

**Exercise: Build an Idempotency Middleware**

Implement a simplified version of the `IdempotencyMiddleware` using an in-memory `Map` instead of Redis. Write an Express route `POST /bookings` that accepts an `Idempotency-Key` header. On the first request with a given key, process the booking and store the response in your map. On subsequent requests with the same key, return the cached response without processing. Write three test cases: (1) first request creates a booking and returns 201, (2) second request with the same key returns the cached 201 without creating a duplicate, and (3) a request with a different key creates a new booking. Verify that your in-memory store contains exactly two entries after all three requests.

---

## 13. Multi-Region Conflict Resolution

> **Learning Objectives**
> - Analyze the CAP theorem tradeoffs made by this system (AP over CP) and articulate why availability is prioritized for a global booking platform.
> - Trace the full lifecycle of a cross-region inventory conflict: local reservation, global event publication, conflict detection, and deterministic resolution via fencing token ordering.
> - Explain why treating a consensus timeout as success is dangerous and how post-timeout verification corrects this.
> - Describe the regional partitioning strategy that minimizes cross-region conflicts by routing reservations to a resource's "home region."

**Why:** With four active regions processing bookings independently, two users in different regions may try to book the same last room simultaneously. The system must detect and resolve these conflicts deterministically. This section describes the global event stream architecture and explains the CAP theorem tradeoffs.

### 13.1 CAP Theorem Tradeoff

This system chooses **AP (Availability + Partition tolerance)** over strict consistency:

- Each region can accept bookings independently (availability)
- Conflicts are detected and resolved asynchronously within seconds
- During a network partition between regions, bookings continue locally
- A small window (2-3 seconds) exists where double-booking is theoretically possible
- Conflicts are resolved deterministically using fencing token ordering

### 13.2 Global Event Stream Architecture

```typescript
// ============================================
// Multi-Region Inventory Synchronization
// ============================================

export class MultiRegionInventoryService {
  private readonly region = process.env.REGION;

  async reserveInventory(params: ReservationParams): Promise<ReservationResult> {

    // Step 1: Acquire local distributed lock
    const lockKey = this.getInventoryLockKey(
      params.resourceType, params.resourceId, params.resourceDate
    );
    const lockResult = await this.fencedLockService.acquireLockWithFencing(
      lockKey, 10000
    );

    if (!lockResult) {
      throw new ConflictError('Resource is locked');
    }

    const { lock, fencingToken } = lockResult;

    try {
      // Step 2: Reserve locally (with fencing token in DB WHERE clause)
      const localReservation = await this.reserveLocally(params, fencingToken);

      if (!localReservation.success) {
        return localReservation;
      }

      // Step 3: Publish to global Kafka topic (via outbox -- Section 14)
      await this.writeOutboxEvent('inventory_reservation',
        localReservation.reservationId, 'inventory.reserved', {
          reservationId: localReservation.reservationId,
          region: this.region,
          fencingToken,
          ...params,
          timestamp: Date.now()
        }
      );

      // Step 4: Wait for conflict detection window
      const consensus = await this.waitForGlobalConsensus(
        localReservation.reservationId, 2000
      );

      if (!consensus.success) {
        await this.rollbackReservation(localReservation.reservationId);

        return {
          success: false,
          reason: consensus.reason,
          conflictingRegion: consensus.conflictingRegion
        };
      }

      return localReservation;

    } finally {
      await this.fencedLockService.releaseLock(lockKey, lock, fencingToken);
    }
  }

  /**
   * Wait for global consensus with proper timeout handling.
   *
   * IMPORTANT: A timeout does NOT mean consensus was achieved.
   * It means we couldn't verify -- this is ambiguous and must be
   * treated as potentially conflicting.
   */
  private async waitForGlobalConsensus(
    reservationId: bigint,
    timeoutMs: number
  ): Promise<{
    success: boolean;
    reason?: string;
    conflictingRegion?: string;
  }> {

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        subscriber.quit();

        // Timeout is AMBIGUOUS -- not a success signal.
        // A network partition could be hiding a conflict.
        // We must verify before confirming.
        this.verifyNoConflictExists(reservationId).then((verified) => {
          if (verified) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              reason: 'timeout_ambiguous'
            });
          }
        }).catch(() => {
          resolve({
            success: false,
            reason: 'verification_failed'
          });
        });
      }, timeoutMs);

      // Listen for conflict notifications via Redis pub/sub
      const subscriber = redis.duplicate();

      subscriber.subscribe(`conflicts:${reservationId}`, (err) => {
        if (err) {
          clearTimeout(timeout);
          subscriber.quit();  // Clean up subscriber on error
          resolve({ success: false, reason: 'subscription_error' });
        }
      });

      subscriber.on('message', (channel, message) => {
        clearTimeout(timeout);
        subscriber.quit();

        const conflict = JSON.parse(message);
        resolve({
          success: false,
          reason: 'conflict_detected',
          conflictingRegion: conflict.region
        });
      });
    });
  }

  /**
   * Post-timeout verification: Check if any other region reserved
   * the same resource during our timeout window.
   */
  private async verifyNoConflictExists(reservationId: bigint): Promise<boolean> {
    const [reservation] = await db.execute(`
      SELECT resource_type, resource_id, resource_date, fencing_token
      FROM inventory_reservations WHERE id = ?
    `, [reservationId]);

    if (reservation.length === 0) return false;

    const res = reservation[0];

    // Check if inventory fencing token matches ours
    const [inventory] = await db.execute(`
      SELECT fencing_token FROM inventory
      WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
    `, [res.resource_type, res.resource_id, res.resource_date]);

    // If our fencing token is still the latest, no conflict occurred
    return inventory[0]?.fencing_token === res.fencing_token;
  }
}
```

> **Common Mistake: Treating Timeout as Success**
> An earlier version of `waitForGlobalConsensus` resolved the timeout as `{ success: true }`, assuming that no conflict notification within 2 seconds meant consensus was achieved. This is dangerous: during a network partition, the conflict notification from another region might simply not arrive. The correct behavior is to treat timeout as ambiguous and verify by checking whether our fencing token is still the latest in the database.

### 13.3 Conflict Detection Consumer

```typescript
// ============================================
// Kafka Consumer for Cross-Region Conflict Detection
// ============================================

export class ConflictDetectionConsumer {
  private readonly region = process.env.REGION;

  async start(): Promise<void> {
    await kafka.subscribe({
      topic: 'inventory-reservations-global',
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        const sourceRegion = message.headers['source-region'].toString();

        // Skip events from our own region
        if (sourceRegion === this.region) return;

        // Check for conflicting local reservation
        const localReservation = await this.findLocalReservation(
          event.resourceType, event.resourceId, event.resourceDate
        );

        if (!localReservation) return; // No conflict

        // Conflict resolution: higher fencing token wins
        if (event.fencingToken > localReservation.fencingToken) {
          // Remote wins -- rollback local
          await this.rollbackReservation(localReservation.id);

          // Notify local process that its reservation lost
          await redis.publish(
            `conflicts:${localReservation.id}`,
            JSON.stringify({
              region: sourceRegion,
              reservationId: event.reservationId,
              fencingToken: event.fencingToken
            })
          );
        } else {
          // Local wins -- notify remote region to rollback
          await kafka.send({
            topic: 'inventory-conflicts',
            messages: [{
              value: JSON.stringify({
                winningRegion: this.region,
                winningReservationId: localReservation.id,
                losingRegion: sourceRegion,
                losingReservationId: event.reservationId
              })
            }]
          });
        }
      }
    });
  }
}
```

### 13.4 Regional Partitioning Strategy

To minimize cross-region conflicts, each resource has a "home region" where most inventory decisions are routed:

```typescript
export const inventoryPartitioningStrategy = {

  getResourceHomeRegion(resourceId: bigint): string {
    const regionIndex = Number(resourceId % 4n);
    const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'sa-east-1'];
    return regions[regionIndex];
  },

  async reserveWithRegionalRouting(params: {
    resourceId: bigint;
    userRegion: string;
  }): Promise<ReservationResult> {

    const homeRegion = this.getResourceHomeRegion(params.resourceId);

    if (params.userRegion === homeRegion) {
      // User in home region -- reserve locally
      return await inventoryService.reserveInventory(params);
    } else {
      // Forward to home region for reduced conflict probability
      return await this.forwardToHomeRegion(homeRegion, params);
    }
  }
};
```

### Key Takeaways

- The system chooses AP (Availability + Partition tolerance) over strict consistency, meaning each region can accept bookings independently even during network partitions, with conflicts resolved asynchronously within a 2-3 second window.
- Conflict resolution is deterministic: the reservation with the higher fencing token always wins. This eliminates ambiguity and ensures all regions converge to the same outcome regardless of message ordering.
- Treating a consensus timeout as success is a critical mistake. A network partition can silently prevent conflict notifications from arriving. The correct approach is to treat timeout as ambiguous and verify by checking the database for the latest fencing token.
- Regional partitioning (assigning each resource a "home region" via `resourceId % 4`) reduces conflict probability by routing most inventory decisions to a single region, falling back to cross-region coordination only when the user is not in the home region.
- The conflict detection consumer skips events from its own region (`if (sourceRegion === this.region) return`), since intra-region conflicts are already handled by the local distributed lock.

### Review Questions

1. The system uses an AP design where a 2-3 second double-booking window exists. Under what business conditions would this tradeoff be unacceptable? If you needed to switch to a CP design, which components would change and what availability would you sacrifice?
2. In the `ConflictDetectionConsumer`, the conflict resolution rule is "higher fencing token wins." Why is this deterministic? Could two regions ever produce the same fencing token for the same resource, and if so, how would you break the tie?
3. Read the `verifyNoConflictExists` method. It checks whether the inventory table's `fencing_token` still matches the reservation's token. Explain a scenario where this check returns `false` even though no actual double-booking occurred (a false positive). What is the consequence of a false positive versus a false negative?

### Hands-On Exercise

**Exercise: Simulate Cross-Region Conflict Detection**

Build a simplified simulation of two regions competing for the same resource. Create two instances of a `RegionSimulator` class, each with its own in-memory inventory table and a shared message bus (use an EventEmitter). Each region should: (1) reserve inventory locally with a fencing token, (2) publish the reservation to the shared bus, and (3) listen for reservations from the other region. When a conflict is detected, the lower fencing token loses and rolls back. Run the simulation 100 times with randomized timing and assert that exactly one reservation survives in every run. Log the winning region and fencing token for each run.

---

## 14. Outbox Pattern & Reliable Messaging

> **Learning Objectives**
> - Identify the dual-write problem in event-driven architectures and explain why publishing to Kafka after a database commit is unsafe.
> - Describe how the outbox pattern eliminates the dual-write problem by writing events to an outbox table within the same database transaction as business data.
> - Read and understand the polling-based outbox publisher, including its use of `FOR UPDATE SKIP LOCKED` for concurrent publisher instances.
> - Explain the cleanup and retry strategies that prevent the outbox table from growing indefinitely and recover from transient publish failures.

**Why:** The biggest reliability gap in event-driven architectures is the dual-write problem. If we commit to the database and then publish to Kafka, the application might crash between the two operations -- the database has the data but Kafka never gets the event. The Outbox Pattern solves this by writing events to an outbox table in the same database transaction as the business data, then publishing them to Kafka asynchronously.

### 14.1 How the Outbox Pattern Works

```
Without Outbox (dangerous):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)      -- DB commit succeeds
  3. COMMIT
  4. kafka.send('booking.created')   -- App crashes here = Event LOST

With Outbox (safe):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)
  3. INSERT INTO outbox_events (...)  -- Written in SAME transaction
  4. COMMIT                          -- Both succeed or both fail
  5. [Outbox Publisher reads outbox_events and publishes to Kafka]
  6. [Publisher marks event as 'published']
```

### 14.2 Outbox Publisher Service

```typescript
// ============================================
// Outbox Publisher - Polling-based CDC
// ============================================

export class OutboxPublisherService {
  private readonly pollIntervalMs = 100; // Poll every 100ms
  private readonly batchSize = 100;
  private running = false;

  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      const published = await this.publishBatch();

      if (published === 0) {
        // No events to publish -- wait before next poll
        await this.sleep(this.pollIntervalMs);
      }
      // If we published events, immediately check for more
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async publishBatch(): Promise<number> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Select pending events with row-level locking
      const [events] = await connection.execute(`
        SELECT id, aggregate_type, aggregate_id, event_type,
               payload, topic, partition_key
        FROM outbox_events
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      `, [this.batchSize]);

      if (events.length === 0) {
        await connection.rollback();
        return 0;
      }

      // Build Kafka messages grouped by topic
      const messagesByTopic = new Map<string, any[]>();

      for (const event of events) {
        if (!messagesByTopic.has(event.topic)) {
          messagesByTopic.set(event.topic, []);
        }
        messagesByTopic.get(event.topic).push({
          key: event.partition_key,
          value: JSON.stringify({
            eventId: event.id,
            eventType: event.event_type,
            aggregateType: event.aggregate_type,
            aggregateId: event.aggregate_id,
            payload: JSON.parse(event.payload),
            timestamp: new Date().toISOString()
          }),
          headers: {
            'event-type': event.event_type,
            'aggregate-type': event.aggregate_type
          }
        });
      }

      // Publish to Kafka
      for (const [topic, messages] of messagesByTopic) {
        await kafka.send({ topic, messages });
      }

      // Mark events as published
      const eventIds = events.map(e => e.id);
      await connection.execute(`
        UPDATE outbox_events
        SET status = 'published', published_at = NOW()
        WHERE id IN (${eventIds.map(() => '?').join(',')})
      `, eventIds);

      await connection.commit();
      return events.length;

    } catch (error) {
      await connection.rollback();
      console.error('Outbox publish failed:', error);
      return 0;

    } finally {
      connection.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 14.3 Outbox Cleanup Job

```sql
-- Clean up published events older than 7 days
CREATE EVENT cleanup_outbox_events
ON SCHEDULE EVERY 1 HOUR
DO
  DELETE FROM outbox_events
  WHERE status = 'published'
  AND published_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
  LIMIT 10000;

-- Retry failed events (up to max_retries)
CREATE EVENT retry_failed_outbox_events
ON SCHEDULE EVERY 1 MINUTE
DO
  UPDATE outbox_events
  SET status = 'pending',
      retry_count = retry_count + 1,
      last_retry_at = NOW()
  WHERE status = 'failed'
  AND retry_count < max_retries
  AND (last_retry_at IS NULL OR last_retry_at < DATE_SUB(NOW(), INTERVAL 1 MINUTE));
```

### Key Takeaways

- The dual-write problem is the most common reliability gap in event-driven architectures: if the application crashes between committing to the database and publishing to Kafka, the event is lost permanently.
- The outbox pattern eliminates this gap by writing both the business data and the event into the same database transaction. The event is stored in an `outbox_events` table and published asynchronously by a separate polling process.
- `FOR UPDATE SKIP LOCKED` allows multiple outbox publisher instances to run concurrently without blocking each other -- each instance picks up a different batch of pending events.
- The cleanup job prevents unbounded table growth by deleting published events older than 7 days, and the retry job recovers from transient failures by resetting failed events back to `pending` with exponential backoff.

### Review Questions

1. In the `publishBatch` method, the publisher selects events, publishes to Kafka, and then marks them as published -- all within a single database transaction. What happens if the Kafka publish succeeds but the database `UPDATE` (marking as published) fails due to a connection error? Will the event be published twice? How does the consumer handle this?
2. The cleanup job uses `LIMIT 10000` when deleting old events. Why is a limit necessary for a DELETE operation? What could happen to the database if the limit were removed and millions of rows matched the WHERE clause?
3. Compare the outbox pattern with Change Data Capture (CDC) using a tool like Debezium. What are the tradeoffs? In what scenarios would you prefer CDC over the polling-based outbox publisher shown here?

### Hands-On Exercise

**Exercise: Implement a Minimal Outbox Publisher**

Using SQLite (or any embedded database) and a mock Kafka producer (a simple array that collects messages), implement the outbox pattern end-to-end. Create a `createBooking` function that inserts a booking row and an outbox event row in the same transaction. Create an `OutboxPublisher` that polls the outbox table every 500ms, reads pending events, pushes them to your mock Kafka array, and marks them as published. Write a test that: (1) creates 10 bookings, (2) starts the publisher, (3) waits 2 seconds, and (4) asserts that the mock Kafka array contains exactly 10 events and the outbox table has 10 rows with status `published`. Then simulate a crash by having the publisher throw an error after publishing but before marking as published -- verify that the events are re-published on the next poll cycle (demonstrating at-least-once delivery).

---

## 15. Saga Pattern & Distributed Transactions

> **Learning Objectives**
> - Explain why traditional ACID transactions cannot span multiple services and why the saga pattern is the standard alternative.
> - Read the saga state machine diagram and trace the compensation path when a step fails (e.g., payment fails after inventory is held).
> - Understand the orchestrator implementation: how it executes steps sequentially, persists saga state for crash recovery, and runs compensating transactions in reverse order.
> - Identify what happens when a compensation itself fails and how the dead letter queue provides a manual resolution path.

**Why:** The booking flow spans multiple services (inventory, payment, notification). Traditional ACID transactions can't span services. The Saga pattern breaks a distributed transaction into local transactions, each with a compensating action that undoes its effect if a later step fails.

### 15.1 Booking Saga State Machine

```
                    +------------------+
                    |  SAGA_STARTED    |
                    +--------+---------+
                             |
                    +--------v---------+     +-------------------+
                    | INVENTORY_HELD   |---->| INVENTORY_FAILED  |
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+     +-------------------+
                    | PAYMENT_CHARGED  |---->|  PAYMENT_FAILED   |--> Release Hold
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+     +-------------------+
                    |BOOKING_CONFIRMED |---->| BOOKING_FAILED    |--> Refund + Release
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+
                    |  SAGA_COMPLETE   |
                    +------------------+
```

### 15.2 Saga Orchestrator

```typescript
// ============================================
// Booking Saga Orchestrator
// ============================================

interface SagaStep {
  name: string;
  execute: (context: SagaContext) => Promise<void>;
  compensate: (context: SagaContext) => Promise<void>;
}

interface SagaContext {
  bookingDto: CreateBookingDto;
  holdId?: bigint;
  paymentId?: bigint;
  bookingId?: bigint;
  sagaId: string;
  currentStep: number;
  status: string;
}

export class BookingSagaOrchestrator {

  private readonly steps: SagaStep[] = [
    {
      name: 'HOLD_INVENTORY',
      execute: async (ctx) => {
        const hold = await this.inventoryService.createHold({
          resourceType: ctx.bookingDto.resourceType,
          resourceId: ctx.bookingDto.resourceId,
          resourceDate: ctx.bookingDto.date,
          quantity: ctx.bookingDto.quantity,
          userId: ctx.bookingDto.userId,
          sessionId: ctx.bookingDto.sessionId,
          ttlSeconds: 600
        });
        ctx.holdId = hold.id;
      },
      compensate: async (ctx) => {
        if (ctx.holdId) {
          await this.inventoryService.releaseHold(
            ctx.holdId, 'Saga compensation', 'saga-orchestrator'
          );
        }
      }
    },
    {
      name: 'PROCESS_PAYMENT',
      execute: async (ctx) => {
        // NOTE: At this stage the booking doesn't exist yet -- the payment
        // is authorized against the *holdId* (not a bookingId). The booking
        // record will be created in the CONFIRM_BOOKING step below.
        const payment = await this.paymentService.processPayment({
          userId: ctx.bookingDto.userId,
          amount: ctx.bookingDto.totalAmount,
          currency: ctx.bookingDto.currency,
          paymentMethod: ctx.bookingDto.paymentMethod,
          holdId: ctx.holdId  // Reference the hold, not a booking
        });
        ctx.paymentId = payment.transactionId;
      },
      compensate: async (ctx) => {
        if (ctx.paymentId) {
          await this.paymentService.refundPayment(ctx.paymentId, 'Saga rollback');
        }
      }
    },
    {
      name: 'CONFIRM_BOOKING',
      execute: async (ctx) => {
        const booking = await this.bookingService.createAndConfirmBooking(
          ctx.bookingDto, ctx.paymentId
        );
        ctx.bookingId = booking.id;
        await this.inventoryService.confirmHold(ctx.holdId, booking.id);
      },
      compensate: async (ctx) => {
        if (ctx.bookingId) {
          await this.bookingService.cancelBooking(ctx.bookingId, 'Saga rollback');
        }
      }
    }
  ];

  async executeSaga(dto: CreateBookingDto): Promise<SagaResult> {
    const context: SagaContext = {
      bookingDto: dto,
      sagaId: randomUUID(),
      currentStep: 0,
      status: 'STARTED'
    };

    // Persist saga state for recovery
    await this.saveSagaState(context);

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      context.currentStep = i;
      context.status = step.name;
      await this.saveSagaState(context);

      try {
        await step.execute(context);
      } catch (error) {
        // Step failed -- run compensating transactions in reverse
        context.status = `${step.name}_FAILED`;
        await this.saveSagaState(context);

        await this.compensate(context, i);

        return {
          success: false,
          sagaId: context.sagaId,
          failedStep: step.name,
          error: error.message
        };
      }
    }

    context.status = 'COMPLETED';
    await this.saveSagaState(context);

    return {
      success: true,
      sagaId: context.sagaId,
      bookingId: context.bookingId
    };
  }

  /**
   * Run compensating transactions in reverse order,
   * starting from the step before the one that failed.
   */
  private async compensate(context: SagaContext, failedStep: number): Promise<void> {
    for (let i = failedStep - 1; i >= 0; i--) {
      const step = this.steps[i];

      try {
        await step.compensate(context);
        context.status = `${step.name}_COMPENSATED`;
        await this.saveSagaState(context);
      } catch (compensationError) {
        // Compensation failure -- log and alert for manual intervention
        console.error(
          `Saga ${context.sagaId}: Compensation failed for step ${step.name}`,
          compensationError
        );
        context.status = `${step.name}_COMPENSATION_FAILED`;
        await this.saveSagaState(context);

        // Write to dead letter queue for manual resolution (Section 21)
        await this.writeToDLQ(context, step.name, compensationError);
      }
    }
  }

  private async saveSagaState(context: SagaContext): Promise<void> {
    await db.execute(`
      INSERT INTO saga_state (saga_id, status, context_data, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE status = ?, context_data = ?, updated_at = NOW()
    `, [
      context.sagaId, context.status, JSON.stringify(context),
      context.status, JSON.stringify(context)
    ]);
  }
}
```

### Key Takeaways

- The saga pattern replaces a single distributed ACID transaction with a sequence of local transactions, each paired with a compensating action. If step N fails, steps N-1 through 1 are compensated in reverse order.
- Saga state is persisted to the database at every step transition (`saveSagaState`). This enables crash recovery: if the orchestrator crashes mid-saga, a recovery process can read the last known state and resume compensation from where it left off.
- Compensation is not the same as rollback. A compensating action (e.g., refunding a payment) is a new forward action that semantically undoes the effect of the original step. Unlike a database rollback, it may leave audit trails, trigger notifications, and have its own failure modes.
- When compensation itself fails, the saga enters a `COMPENSATION_FAILED` state and writes to a dead letter queue for manual intervention. This is the correct approach -- retrying indefinitely could cause further damage (e.g., double-refunding).
- The payment step authorizes against the `holdId`, not a `bookingId`, because the booking record does not exist yet. This ordering (hold inventory, charge payment, create booking) ensures that money is only charged after inventory is secured.

### Review Questions

1. In the `compensate` method, the loop starts at `failedStep - 1` and iterates down to 0. Why does it start at `failedStep - 1` rather than `failedStep`? What would happen if compensation started at the failed step itself?
2. The `PROCESS_PAYMENT` step references `ctx.holdId` (set by the previous step). If the orchestrator crashes after `HOLD_INVENTORY` succeeds but before `PROCESS_PAYMENT` begins, how does the system recover? Trace through the recovery path using the persisted saga state.
3. Consider a scenario where `CONFIRM_BOOKING` fails. The compensator refunds the payment and releases the inventory hold. But what if the user sees a "booking confirmed" notification (sent by a downstream event consumer) before the compensation completes? How would you design the system to handle this user-facing inconsistency?

### Hands-On Exercise

**Exercise: Build a Mini Saga Orchestrator**

Implement a simplified saga orchestrator with three steps: (1) `reserveItem` -- decrements a counter in an in-memory store, (2) `chargePayment` -- appends a charge record to an array, and (3) `confirmOrder` -- sets an order status to "confirmed." Each step has a compensating action (increment counter, append refund record, set status to "cancelled"). Write the orchestrator so that it executes steps in order and compensates in reverse on failure. Test three scenarios: (a) all steps succeed -- verify the final state, (b) step 2 fails -- verify that step 1 is compensated and no charge record exists, (c) step 3 fails -- verify that both step 2 and step 1 are compensated (refund record exists, counter is restored). Log the saga state transitions for each scenario.

---

## 16. CQRS Pattern

> **Learning Objectives**
> - Articulate why separating read and write models is necessary at high throughput (100,000 bookings/minute) and how reads and writes have fundamentally different consistency and performance requirements.
> - Read the CQRS architecture diagram and identify the data flow from MySQL (write model) through outbox events to Elasticsearch (read model).
> - Understand how event-driven projections keep the read model eventually consistent by consuming Kafka events and updating Elasticsearch indices.
> - Compare the query patterns available in the read model (full-text search, geo-search, filtered aggregations) with what would be feasible using the write model alone.

**Why:** At 100,000 bookings/minute, reads and writes have fundamentally different characteristics. Writes need strong consistency (MySQL with fencing tokens), while reads need speed (sub-200ms search results). CQRS separates the write model (commands) from the read model (queries), allowing each to be optimized independently.

### 16.1 CQRS Architecture

```
Commands (Writes):                    Queries (Reads):
  +---------------+                    +---------------+
  |  Booking API  |                    |  Search API   |
  +-------+-------+                    +-------+-------+
          |                                    |
  +-------v-------+                    +-------v-------+
  |    MySQL      |---- Outbox ---->   | Elasticsearch |
  |   (Primary)   |     Events         | (Read Model)  |
  +---------------+                    +---------------+
          |                                    |
    Strong consistency              Sub-200ms queries
    Fencing tokens                  Geo-search
    ACID transactions               Full-text search
```

### 16.2 Event-Driven Read Model Projections

```typescript
// ============================================
// CQRS Read Model Projector
// ============================================

export class BookingReadModelProjector {

  async start(): Promise<void> {
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events', 'payment-events'],
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'booking.created':
            await this.projectBookingCreated(event.payload);
            break;
          case 'booking.confirmed':
            await this.projectBookingConfirmed(event.payload);
            break;
          case 'booking.cancelled':
            await this.projectBookingCancelled(event.payload);
            break;
          case 'inventory.updated':
            await this.projectInventoryUpdated(event.payload);
            break;
        }
      }
    });
  }

  private async projectBookingCreated(payload: any): Promise<void> {
    // Update Elasticsearch with denormalized booking data
    await elasticsearch.index({
      index: 'bookings',
      id: payload.bookingId.toString(),
      body: {
        bookingId: payload.bookingId,
        userId: payload.userId,
        bookingType: payload.bookingType,
        status: 'pending',
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        createdAt: payload.timestamp,
        // Denormalized: include hotel/flight details for fast queries
        resourceName: payload.resourceName,
        location: payload.location,
        dates: {
          checkIn: payload.checkIn,
          checkOut: payload.checkOut
        }
      }
    });
  }

  private async projectInventoryUpdated(payload: any): Promise<void> {
    // Update availability in search index
    await elasticsearch.update({
      index: 'hotels',
      id: payload.resourceId.toString(),
      body: {
        doc: {
          available_rooms: payload.availableQuantity,
          price_per_night: payload.basePrice,
          updated_at: new Date().toISOString()
        }
      }
    });
  }
}
```

### 16.3 Query Service

```typescript
// ============================================
// CQRS Query Service -- Reads from Elasticsearch
// ============================================

export class BookingQueryService {

  // Fast read from denormalized read model
  async getUserBookings(userId: bigint, filters: BookingFilters): Promise<BookingList> {
    const { body } = await elasticsearch.search({
      index: 'bookings',
      body: {
        query: {
          bool: {
            must: [
              { term: { userId: userId.toString() } },
              ...(filters.status ? [{ term: { status: filters.status } }] : []),
              ...(filters.bookingType ?
                [{ term: { bookingType: filters.bookingType } }] : [])
            ],
            filter: [
              ...(filters.dateFrom ? [{
                range: { 'dates.checkIn': { gte: filters.dateFrom } }
              }] : [])
            ]
          }
        },
        sort: [{ createdAt: 'desc' }],
        from: filters.offset || 0,
        size: filters.limit || 20
      }
    });

    return {
      bookings: body.hits.hits.map(hit => hit._source),
      total: body.hits.total.value
    };
  }
}
```

### Key Takeaways

- CQRS separates the write path (MySQL with ACID transactions and fencing tokens) from the read path (Elasticsearch with denormalized, search-optimized indices). This allows each side to scale independently and use the storage technology best suited to its access patterns.
- The read model is eventually consistent with the write model. Events flow from MySQL through the outbox table to Kafka, and projectors consume those events to update Elasticsearch. The propagation delay is typically sub-second but can grow during high load or consumer lag.
- Projections are denormalized: the `projectBookingCreated` method stores hotel names, locations, and dates directly in the booking document, eliminating the need for joins at query time. This is the fundamental tradeoff -- storage duplication in exchange for query speed.
- The query service constructs Elasticsearch bool queries with `must` (scored matching) and `filter` (unscored, cacheable filtering) clauses. This distinction matters for performance: filter clauses are cached by Elasticsearch and skip scoring, making them significantly faster for exact-match fields like `status` and `bookingType`.

### Review Questions

1. The `BookingReadModelProjector` subscribes to three Kafka topics (`booking-events`, `inventory-events`, `payment-events`). What happens if the projector crashes and restarts? How does Kafka's consumer group offset tracking ensure that no events are missed or double-processed? What role does idempotency (Section 12) play here?
2. In the `projectBookingCreated` method, the booking is indexed with `status: 'pending'`. When the booking is later confirmed, a separate `booking.confirmed` event updates the status. What does the user see if they query their bookings in the brief window between the `booking.created` and `booking.confirmed` projections? Is this acceptable?
3. The query uses `bool.must` for `userId` and `bool.filter` for `dateFrom`. Why is `userId` in `must` rather than `filter`? Would moving it to `filter` change the results? Would it change performance?

### Hands-On Exercise

**Exercise: Build a Read Model Projector**

Create a simple CQRS system using an in-memory write store (a Map of bookings) and an in-memory read store (a separate Map optimized for search). Implement a `createBooking` command that writes to the write store and publishes an event to an event array. Implement a `ReadModelProjector` that processes events from the array and builds a denormalized read model that supports querying by userId, status, and date range. Write a `QueryService` that searches the read model. Test the following: (1) create 5 bookings for 2 different users, (2) run the projector, (3) query bookings for user 1 -- verify only their bookings are returned, (4) query bookings with status "confirmed" -- verify filtering works, (5) create a new booking *without* running the projector and verify the query does not return it (demonstrating eventual consistency).

---
