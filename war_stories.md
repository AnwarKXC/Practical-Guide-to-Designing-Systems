# War Stories: When the Global Booking System Broke

These are real failure scenarios drawn from operating a distributed booking platform at scale -- 100K bookings per minute spread across 16 MySQL shards, 4 geographic regions, Redis caching and locking layers, Kafka event streaming, and Elasticsearch-powered search. Names are changed, but the bugs, the timelines, and the cold sweat are all authentic.

Read these not as cautionary tales that could never happen to you. Read them as inevitabilities you can prepare for.

---

## War Story 1: "We Double-Booked 2,147 Rooms"

**Chapter 15 -- Distributed Locking**

### The Setup

It was the Wednesday before Black Friday, November 22nd. The marketing team had been promoting our flash sale for two weeks: 40% off premium hotel rooms in 12 major cities, inventory limited to 15,000 rooms, doors open at midnight UTC.

We had load-tested at 3x expected traffic. We had added two extra API pods per region. We had pre-warmed our Redis caches. The on-call engineer, Priya, had her laptop open and her coffee fresh.

At 00:00:00 UTC, traffic spiked from our baseline 38K bookings/min to 112K bookings/min. The system held. Dashboards were green. The team was in Slack congratulating each other.

At 00:04:17 UTC, the first double-booking was written to shard-07.

Nobody noticed for twelve minutes.

### The Timeline

**00:00:00** -- Flash sale begins. Traffic spikes to 112K bookings/min across all 4 regions. All systems nominal.

**00:02:30** -- P99 latency on the booking service climbs from 180ms to 620ms. Expected under load. No alerts fire because the threshold is 800ms.

**00:04:17** -- First double-booking occurs. Room ID `htl_91847_rm_304` is booked by two different users, 1.3 seconds apart. Both transactions succeed. Both users receive confirmation emails.

**00:04:17 to 00:16:42** -- Double-bookings continue at a rate of approximately 3 per second. They are concentrated on popular properties -- the ones where multiple users are racing for the same room at the same time.

**00:12:00** -- The inventory service logs a warning: "Negative availability count for property htl_91847." The warning is logged but does not trigger a page because negative availability was classified as a P3 issue during the alert tuning session two months earlier. Someone had argued it was "cosmetic."

**00:16:42** -- Priya notices an anomaly in the Grafana dashboard. The "unique bookings" count and the "total bookings" count are diverging. She checks the booking table for duplicates.

**00:17:01** -- Priya in Slack: "We have a problem. I'm seeing duplicate room assignments. Checking scope now."

**00:18:30** -- She runs the duplicate detection query. The number comes back: 2,147 rooms booked by two guests each. Her exact words in Slack: "2,147 double-booked rooms. This is not a drill."

**00:19:00** -- Incident declared. SEV-1. All hands.

**00:22:00** -- Flash sale paused. Booking endpoint returns 503 for all flash sale inventory.

### The Root Cause

The booking service used a Redis distributed lock to prevent concurrent booking of the same room. The implementation looked like this:

```typescript
// BROKEN: The lock implementation that cost us 2,147 double-bookings

import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class BookingLockService {
  constructor(private readonly redis: Redis) {}

  async acquireLock(roomId: string): Promise<boolean> {
    // SET NX with a 30-second TTL
    const result = await this.redis.set(
      `lock:room:${roomId}`,
      'locked',
      'EX',
      30,  // 30-second TTL
      'NX'
    );
    return result === 'OK';
  }

  async releaseLock(roomId: string): Promise<void> {
    await this.redis.del(`lock:room:${roomId}`);
  }
}

@Injectable()
export class BookingService {
  constructor(
    private readonly lockService: BookingLockService,
    private readonly prisma: PrismaClient,
  ) {}

  async bookRoom(roomId: string, userId: string): Promise<Booking> {
    const acquired = await this.lockService.acquireLock(roomId);
    if (!acquired) {
      throw new ConflictException('Room is currently being booked by another user.');
    }

    try {
      // Check availability
      const room = await this.prisma.room.findUnique({
        where: { id: roomId },
      });

      if (!room || room.status !== 'AVAILABLE') {
        throw new ConflictException('Room is no longer available.');
      }

      // Create booking -- involves multiple writes across shards,
      // payment pre-authorization, and inventory update.
      // Under normal load: ~200ms
      // Under Black Friday flash sale load: 28-35 seconds
      const booking = await this.prisma.$transaction(async (tx) => {
        await tx.room.update({
          where: { id: roomId },
          data: { status: 'BOOKED' },
        });

        const newBooking = await tx.booking.create({
          data: {
            roomId,
            userId,
            status: 'CONFIRMED',
            // ... other fields
          },
        });

        // Payment pre-auth (external call inside transaction -- another mistake)
        await this.paymentService.preAuthorize(userId, room.price);

        return newBooking;
      });

      return booking;
    } finally {
      await this.lockService.releaseLock(roomId);
    }
  }
}
```

There are two fatal problems here.

**Problem 1: The lock TTL was 30 seconds, but the transaction took 35 seconds under load.** Under normal conditions, the booking transaction completed in about 200ms. Plenty of headroom. But under Black Friday load, MySQL shard latency increased, the payment pre-authorization call slowed down, and the total transaction time stretched to 28-35 seconds. The lock expired at 30 seconds. A second request acquired the now-available lock. Both transactions completed. Both bookings were confirmed.

**Problem 2: The lock value was a static string.** The value was just `'locked'`. There was no way to verify, at the time of writing, that the lock was still held by the original requester. There was no fencing token. The second writer had no way to know it was operating on stale authority.

### The Fix

The fix had two parts: fencing tokens and lock validation at write time.

```typescript
// FIXED: Distributed lock with fencing tokens

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class BookingLockService {
  constructor(private readonly redis: Redis) {}

  /**
   * Acquires a lock and returns a fencing token.
   * The fencing token is a monotonically increasing value that the caller
   * must pass to the database write. The database rejects writes with
   * a fencing token lower than the last accepted token for that resource.
   */
  async acquireLock(roomId: string): Promise<{ acquired: boolean; fenceToken: string | null }> {
    const fenceToken = await this.redis.incr('global:fence:counter');
    const lockValue = JSON.stringify({
      fenceToken: fenceToken.toString(),
      ownerId: randomUUID(),
      acquiredAt: Date.now(),
    });

    const result = await this.redis.set(
      `lock:room:${roomId}`,
      lockValue,
      'EX',
      120,  // Increased TTL to 120 seconds
      'NX'
    );

    if (result === 'OK') {
      return { acquired: true, fenceToken: fenceToken.toString() };
    }

    return { acquired: false, fenceToken: null };
  }

  /**
   * Releases the lock ONLY if the caller still owns it.
   * Uses a Lua script for atomicity.
   */
  async releaseLock(roomId: string, expectedOwnerId: string): Promise<void> {
    const luaScript = `
      local lockValue = redis.call('GET', KEYS[1])
      if lockValue then
        local parsed = cjson.decode(lockValue)
        if parsed.ownerId == ARGV[1] then
          redis.call('DEL', KEYS[1])
          return 1
        end
      end
      return 0
    `;
    await this.redis.eval(luaScript, 1, `lock:room:${roomId}`, expectedOwnerId);
  }
}

@Injectable()
export class BookingService {
  constructor(
    private readonly lockService: BookingLockService,
    private readonly prisma: PrismaClient,
  ) {}

  async bookRoom(roomId: string, userId: string): Promise<Booking> {
    const { acquired, fenceToken } = await this.lockService.acquireLock(roomId);
    if (!acquired || !fenceToken) {
      throw new ConflictException('Room is currently being booked by another user.');
    }

    try {
      // The fencing token is passed into the transaction.
      // The database layer rejects writes where the fencing token
      // is not strictly greater than the last accepted token for this room.
      const booking = await this.prisma.$transaction(async (tx) => {
        // Atomic check-and-set with fencing token validation
        const updateResult = await tx.$executeRaw`
          UPDATE rooms
          SET status = 'BOOKED',
              last_fence_token = ${fenceToken}
          WHERE id = ${roomId}
            AND status = 'AVAILABLE'
            AND (last_fence_token IS NULL OR last_fence_token < ${fenceToken})
        `;

        if (updateResult === 0) {
          // Either room is not available, or a higher fencing token
          // has already been accepted. This request is stale.
          throw new ConflictException(
            'Booking rejected: room unavailable or fencing token is stale.'
          );
        }

        const newBooking = await tx.booking.create({
          data: {
            roomId,
            userId,
            fenceToken,
            status: 'CONFIRMED',
          },
        });

        return newBooking;
      });

      // Payment pre-auth moved OUTSIDE the database transaction
      await this.paymentService.preAuthorize(userId, booking.totalPrice);

      return booking;
    } finally {
      await this.lockService.releaseLock(roomId, fenceToken);
    }
  }
}
```

The critical insight: even if the lock expires and a second request acquires it, the second request will get a *higher* fencing token. When the first request (with the lower fencing token) finally tries to write, the database rejects it because a higher token has already been accepted. When the second request tries to write, the database also rejects it if the first request already wrote with a lower token -- because the room status is no longer `AVAILABLE`.

The lock becomes an optimization (preventing wasted work), not a safety mechanism. The fencing token at the database level is the actual safety mechanism.

### The Rollback

We had 2,147 double-bookings to unwind. The second booking (by timestamp) was the one we needed to cancel and refund.

```sql
-- Identify all double-booked rooms and cancel the LATER booking
WITH double_booked AS (
  SELECT
    room_id,
    id AS booking_id,
    user_id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY room_id
      ORDER BY created_at ASC
    ) AS booking_order
  FROM bookings
  WHERE room_id IN (
    SELECT room_id
    FROM bookings
    WHERE status = 'CONFIRMED'
      AND created_at BETWEEN '2025-11-22 00:00:00' AND '2025-11-22 01:00:00'
    GROUP BY room_id
    HAVING COUNT(*) > 1
  )
  AND status = 'CONFIRMED'
)
UPDATE bookings
SET status = 'CANCELLED_DOUBLE_BOOK',
    cancelled_at = NOW(),
    cancellation_reason = 'SEV1-20251122: Double-booking due to lock TTL expiry'
WHERE id IN (
  SELECT booking_id FROM double_booked WHERE booking_order > 1
);
```

Every affected user received a personal apology email, a full refund, and a 25% credit toward a future booking. The total cost of the incident, including refunds, credits, and engineering time, was $184,000.

### The Lesson

A distributed lock without a fencing token is a suggestion, not a guarantee. Under normal load, you will never notice the difference. Under extreme load -- the exact moment when you most need the guarantee -- the suggestion fails silently.

The TTL exists to prevent deadlocks. It does not exist to protect your data. The fencing token protects your data.

---

## War Story 2: "Kafka Lag Caused Ghost Bookings"

**Chapter 18 -- Outbox Pattern**

### The Setup

It was a Tuesday in March. Not a holiday. Not a flash sale. Just an ordinary day with ordinary traffic -- 74K bookings/min, well within capacity. Which is what made this incident so insidious. It did not announce itself. It crept.

At 14:32 UTC, one of the 12 booking-service pods in the `us-east` region hit an out-of-memory condition and was killed by the Kubernetes OOM killer. The pod restarted automatically in 8 seconds. Kubernetes health checks went green. Nobody was paged.

But in that 8-second window, approximately 247 bookings were written to MySQL and committed -- but the corresponding Kafka events were never published. The bookings existed in the database. The users saw a "Booking Confirmed" page. But the downstream services -- payment processing, email notification, inventory confirmation, partner sync -- never received the events.

These were ghost bookings. Alive in the database, invisible to the rest of the system.

### The Timeline

**14:32:11 UTC** -- Pod `booking-svc-us-east-07` is OOM-killed. It was processing 38 concurrent booking requests. Of those, 19 had already committed their database transactions but had not yet published the Kafka event.

**14:32:19 UTC** -- Pod restarts. Health checks pass. Traffic resumes. No alert fires.

**14:32:19 to 16:45:00 UTC** -- The system operates normally. The 19 ghost bookings (plus approximately 228 more from similar micro-crashes over the previous two weeks that nobody investigated) sit in the database, silently rotting.

**16:45:00 UTC** -- A customer calls support: "I booked a room three hours ago. I got the confirmation page. But I never got a confirmation email, and my credit card hasn't been charged."

**16:52:00 UTC** -- Support agent checks the booking table. The booking exists. Status: CONFIRMED. Checks the payment service. No record. Checks the notification service. No record. Checks the inventory service. The room is still showing as available.

**16:55:00 UTC** -- Support escalates to engineering. "The booking exists in the database but nowhere else."

**17:10:00 UTC** -- Engineer Marcus runs a reconciliation query. He finds 247 bookings that exist in the `bookings` table but have no corresponding record in the `booking_events` topic in Kafka. His message in Slack: "We have 247 ghost bookings. DB says confirmed, but nothing downstream knows they exist."

**17:15:00 UTC** -- SEV-2 declared.

**17:30:00 UTC** -- Root cause identified. The booking service was performing the database write and the Kafka publish as two separate, non-atomic operations. If the process died between them, the event was lost forever.

### The Broken Code

```typescript
// BROKEN: Database write and Kafka publish as separate operations.
// If the process dies between them, the event is lost forever.

import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { KafkaProducer } from './kafka.producer';

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly kafkaProducer: KafkaProducer,
  ) {}

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    // Step 1: Write to database
    const booking = await this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { id: dto.roomId } });
      if (!room || room.status !== 'AVAILABLE') {
        throw new ConflictException('Room not available');
      }

      await tx.room.update({
        where: { id: dto.roomId },
        data: { status: 'BOOKED' },
      });

      return tx.booking.create({
        data: {
          roomId: dto.roomId,
          userId: dto.userId,
          checkIn: dto.checkIn,
          checkOut: dto.checkOut,
          status: 'CONFIRMED',
          totalPrice: dto.totalPrice,
        },
      });
    });

    // --- THE DANGER ZONE ---
    // If the process dies HERE -- after the DB commit but before the Kafka
    // publish -- the booking exists in the database but no downstream
    // service will ever know about it. No payment. No email. No inventory
    // lock. A ghost booking.

    // Step 2: Publish event to Kafka (separate operation, not transactional)
    await this.kafkaProducer.send({
      topic: 'booking.events',
      messages: [
        {
          key: booking.id,
          value: JSON.stringify({
            eventType: 'BOOKING_CONFIRMED',
            bookingId: booking.id,
            roomId: booking.roomId,
            userId: booking.userId,
            totalPrice: booking.totalPrice,
            timestamp: new Date().toISOString(),
          }),
        },
      ],
    });

    return booking;
  }
}
```

The developer who wrote this code knew about the risk. There was even a comment in the original code: `// TODO: consider outbox pattern`. That TODO was 14 months old.

### The Fix: Transactional Outbox Pattern

The fix eliminates the two-phase problem entirely. Instead of writing to the database and then publishing to Kafka, we write the event *to the database* in the same transaction as the booking. A separate process (the outbox relay) reads uncommitted events from the database and publishes them to Kafka.

```typescript
// FIXED: Transactional Outbox Pattern
// The event is written to the database in the same transaction as the booking.
// A separate relay process publishes events from the outbox table to Kafka.

import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

// The Prisma schema includes a new table:
//
// model OutboxEvent {
//   id            String   @id @default(uuid())
//   aggregateType String
//   aggregateId   String
//   eventType     String
//   payload       Json
//   createdAt     DateTime @default(now())
//   publishedAt   DateTime?
//   @@index([publishedAt, createdAt])
// }

@Injectable()
export class BookingService {
  constructor(private readonly prisma: PrismaClient) {}

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    // SINGLE transaction: booking + outbox event
    const booking = await this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { id: dto.roomId } });
      if (!room || room.status !== 'AVAILABLE') {
        throw new ConflictException('Room not available');
      }

      await tx.room.update({
        where: { id: dto.roomId },
        data: { status: 'BOOKED' },
      });

      const newBooking = await tx.booking.create({
        data: {
          roomId: dto.roomId,
          userId: dto.userId,
          checkIn: dto.checkIn,
          checkOut: dto.checkOut,
          status: 'CONFIRMED',
          totalPrice: dto.totalPrice,
        },
      });

      // Write the event to the outbox table IN THE SAME TRANSACTION.
      // If the transaction rolls back, the event is also rolled back.
      // If the transaction commits, the event is guaranteed to exist.
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'Booking',
          aggregateId: newBooking.id,
          eventType: 'BOOKING_CONFIRMED',
          payload: {
            bookingId: newBooking.id,
            roomId: newBooking.roomId,
            userId: newBooking.userId,
            totalPrice: newBooking.totalPrice,
            checkIn: dto.checkIn.toISOString(),
            checkOut: dto.checkOut.toISOString(),
          },
        },
      });

      return newBooking;
    });

    return booking;
  }
}

/**
 * The Outbox Relay runs as a separate process (or a scheduled job within the service).
 * It polls the outbox table for unpublished events and publishes them to Kafka.
 * After successful publish, it marks the event as published.
 *
 * This is the ONLY component that talks to Kafka for booking events.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly kafkaProducer: KafkaProducer,
  ) {}

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.log('Outbox relay started.');

    while (this.isRunning) {
      try {
        await this.publishPendingEvents();
      } catch (err) {
        this.logger.error('Outbox relay error:', err);
      }

      // Poll every 100ms. Under high load, consider using
      // PostgreSQL LISTEN/NOTIFY or MySQL binlog tailing (Debezium)
      // for lower latency.
      await this.sleep(100);
    }
  }

  private async publishPendingEvents(): Promise<void> {
    // Fetch batch of unpublished events, oldest first
    const events = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    for (const event of events) {
      try {
        await this.kafkaProducer.send({
          topic: `${event.aggregateType.toLowerCase()}.events`,
          messages: [
            {
              key: event.aggregateId,
              value: JSON.stringify({
                eventId: event.id,
                eventType: event.eventType,
                aggregateId: event.aggregateId,
                payload: event.payload,
                timestamp: event.createdAt.toISOString(),
              }),
            },
          ],
        });

        // Mark as published
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { publishedAt: new Date() },
        });
      } catch (err) {
        // If Kafka publish fails, the event stays in the outbox
        // and will be retried on the next polling cycle.
        // Downstream consumers MUST be idempotent because
        // the relay guarantees at-least-once delivery.
        this.logger.error(`Failed to publish event ${event.id}:`, err);
        break; // Preserve ordering -- do not skip ahead
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### The Recovery Script

For the 247 ghost bookings that already existed, we wrote a recovery script that re-emitted the missing events:

```typescript
// Recovery script: find ghost bookings and inject their events into the outbox

async function recoverGhostBookings(prisma: PrismaClient): Promise<void> {
  // Find bookings that have no corresponding outbox event
  const ghostBookings = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT b.id
    FROM bookings b
    LEFT JOIN outbox_events oe
      ON oe.aggregate_id = b.id
      AND oe.aggregate_type = 'Booking'
      AND oe.event_type = 'BOOKING_CONFIRMED'
    WHERE b.status = 'CONFIRMED'
      AND b.created_at > NOW() - INTERVAL 30 DAY
      AND oe.id IS NULL
  `;

  console.log(`Found ${ghostBookings.length} ghost bookings.`);

  for (const ghost of ghostBookings) {
    const booking = await prisma.booking.findUnique({
      where: { id: ghost.id },
      include: { room: true },
    });

    if (!booking) continue;

    await prisma.outboxEvent.create({
      data: {
        id: randomUUID(),
        aggregateType: 'Booking',
        aggregateId: booking.id,
        eventType: 'BOOKING_CONFIRMED',
        payload: {
          bookingId: booking.id,
          roomId: booking.roomId,
          userId: booking.userId,
          totalPrice: booking.totalPrice,
          recoveredAt: new Date().toISOString(),
          isRecovery: true,  // Flag so downstream services can handle specially
        },
      },
    });
  }

  console.log(`Injected ${ghostBookings.length} recovery events into outbox.`);
}
```

### The Lesson

If you write to a database and then publish to a message broker as two separate operations, you *will* lose events. Not "might." Will. The only question is how long it takes and how many you lose before you notice.

The outbox pattern is not optional for systems that need reliable event delivery. It is the cost of doing business in a distributed system. The 14-month-old TODO comment cost us 247 angry customers and a weekend of incident recovery.

---

## War Story 3: "The Redis Eviction Catastrophe"

**Chapter 24 -- Cache Strategy**

### The Setup

Our Redis deployment was a single logical cluster serving two very different workloads. On one hand, it stored search result caches -- hotel listings, room availability, price calculations. These were high-volume, tolerant of staleness, and expendable. If a cache entry disappeared, the system would just re-query MySQL and Elasticsearch.

On the other hand, the same Redis cluster stored inventory lock keys. These were low-volume, safety-critical, and absolutely not expendable. If a lock key disappeared mid-transaction, two users could book the same room simultaneously.

Both workloads lived in the same Redis instance, under the same `maxmemory` limit, governed by the same eviction policy.

This is the architectural equivalent of storing fireworks and gasoline in the same shed.

### The Timeline

**Saturday, June 14th, 08:00 UTC** -- Summer travel booking season. Traffic has been climbing steadily for three weeks. Today's volume: 97K bookings/min, approaching our 100K/min design target.

**08:14 UTC** -- Redis memory usage crosses 90% of `maxmemory` (set at 32GB). This has happened before during traffic spikes. The `allkeys-lru` eviction policy kicks in and starts evicting the least recently used keys. Under normal circumstances, this is fine -- it evicts old search cache entries, and the system re-fetches on cache miss.

**08:17 UTC** -- Redis memory usage hits 100% of `maxmemory`. Eviction rate accelerates. Redis is now evicting keys as fast as new ones are written. The eviction policy does not distinguish between a search cache key and a lock key. Both are "just keys."

**08:17:30 UTC** -- The first inventory lock key is evicted. It was a lock for room `htl_44291_rm_712`, acquired 4 seconds earlier by a booking transaction that was still in progress. The lock disappears. A second request for the same room acquires a new lock. Both bookings succeed.

**08:17:30 to 08:19:00 UTC** -- Lock key evictions accelerate. In these 90 seconds, 312 lock keys are evicted by Redis LRU policy. Each eviction creates a window for double-booking.

**08:18:00 UTC** -- Simultaneously, the search cache goes cold. Thousands of search cache entries are evicted in the same sweep. Users hitting the search API trigger cache misses. All 16 MySQL shards and the Elasticsearch cluster are suddenly hit with uncached query traffic. This is a thundering herd.

**08:18:15 UTC** -- MySQL shard connection pools saturate. Query latency spikes from 12ms to 3,400ms. This slows down booking transactions, which means lock keys are held longer, which means more lock keys are in Redis at any given time, which means more lock keys are eligible for eviction.

**08:18:30 UTC** -- Booking throughput collapses from 97K/min to 8K/min. The feedback loop is now fully engaged: evictions cause cache misses, cache misses cause slow queries, slow queries cause longer lock holds, longer lock holds cause more evictions.

**08:19:00 UTC** -- PagerDuty fires. Every on-call engineer in every timezone is paged simultaneously. The booking error rate is 91%.

**08:22:00 UTC** -- Incident commander makes the call: "Kill all non-essential traffic. Search goes to maintenance mode. Booking-only."

**08:25:00 UTC** -- Search API returns cached static results. MySQL load drops. Booking throughput recovers to 45K/min.

**08:40:00 UTC** -- Full recovery. But 312 lock-related double-bookings and an estimated $47,000 in duplicate refunds.

### The Root Cause

One Redis instance serving two fundamentally incompatible workloads:

| Workload | Volume | Expendable? | Eviction-safe? |
|---|---|---|---|
| Search cache | High (millions of keys) | Yes | Yes |
| Inventory locks | Low (thousands of keys) | No | No |

The `allkeys-lru` eviction policy treats all keys equally. When memory pressure hits, it evicts whatever was least recently used -- and lock keys that were set 5-10 seconds ago are less recently used than search cache keys that were read milliseconds ago.

### The Fix: Separated Redis Instances

```typescript
// FIXED: Dual Redis client architecture.
// Cache and locks live in separate Redis instances with different configurations.

import { Injectable, Module } from '@nestjs/common';
import Redis from 'ioredis';

// Redis configuration for CACHE (search results, price lookups, etc.)
// - allkeys-lru eviction: safe to evict any key at any time
// - Large maxmemory: holds as much as possible
// - No persistence: pure cache, can be rebuilt from source
const cacheRedisConfig = {
  host: process.env.REDIS_CACHE_HOST,
  port: 6379,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // maxmemory: 48gb (set in redis.conf)
  // maxmemory-policy: allkeys-lru (set in redis.conf)
  // save: "" (persistence disabled in redis.conf)
};

// Redis configuration for LOCKS (inventory locks, rate limiters, etc.)
// - noeviction policy: NEVER evict keys. Return errors on OOM instead.
// - Small maxmemory: locks are small and few
// - AOF persistence: locks survive restarts
const lockRedisConfig = {
  host: process.env.REDIS_LOCK_HOST,
  port: 6379,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // maxmemory: 4gb (set in redis.conf)
  // maxmemory-policy: noeviction (set in redis.conf)
  // appendonly: yes (AOF persistence enabled in redis.conf)
};

// Named tokens for dependency injection
export const REDIS_CACHE = Symbol('REDIS_CACHE');
export const REDIS_LOCK = Symbol('REDIS_LOCK');

@Module({
  providers: [
    {
      provide: REDIS_CACHE,
      useFactory: () => {
        const client = new Redis(cacheRedisConfig);
        client.on('error', (err) => {
          console.error('[Redis Cache] Connection error:', err.message);
        });
        return client;
      },
    },
    {
      provide: REDIS_LOCK,
      useFactory: () => {
        const client = new Redis(lockRedisConfig);
        client.on('error', (err) => {
          // Lock Redis errors are critical -- page immediately
          console.error('[Redis Lock] CRITICAL connection error:', err.message);
        });
        return client;
      },
    },
  ],
  exports: [REDIS_CACHE, REDIS_LOCK],
})
export class RedisModule {}

// Services explicitly declare which Redis they need

@Injectable()
export class SearchCacheService {
  constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

  async getCachedResults(queryHash: string): Promise<SearchResult[] | null> {
    const cached = await this.redis.get(`search:${queryHash}`);
    return cached ? JSON.parse(cached) : null;
  }

  async setCachedResults(
    queryHash: string,
    results: SearchResult[],
    ttlSeconds: number = 300
  ): Promise<void> {
    // If Redis is full, this write will fail silently (key will be evicted
    // to make room, or the SET will trigger LRU eviction of another key).
    // This is fine. Cache misses are expected and handled.
    await this.redis.set(
      `search:${queryHash}`,
      JSON.stringify(results),
      'EX',
      ttlSeconds
    );
  }
}

@Injectable()
export class InventoryLockService {
  constructor(@Inject(REDIS_LOCK) private readonly redis: Redis) {}

  async acquireLock(
    roomId: string,
    fenceToken: string,
    ttlSeconds: number = 120
  ): Promise<boolean> {
    try {
      const result = await this.redis.set(
        `lock:inventory:${roomId}`,
        JSON.stringify({ fenceToken, acquiredAt: Date.now() }),
        'EX',
        ttlSeconds,
        'NX'
      );
      return result === 'OK';
    } catch (err) {
      // With noeviction policy, if Redis is truly out of memory,
      // the SET command returns an OOM error. We catch it and treat
      // it as a lock acquisition failure -- which is SAFE. The booking
      // will fail with "temporarily unavailable" rather than silently
      // proceeding without a lock.
      if (err.message?.includes('OOM')) {
        console.error(
          'CRITICAL: Lock Redis is out of memory. Cannot acquire locks. ' +
          'Increase maxmemory or investigate key leaks.'
        );
        return false;
      }
      throw err;
    }
  }
}
```

We also added monitoring to catch the problem before it escalated:

```typescript
// Monitoring: Alert before Redis memory becomes critical

@Injectable()
export class RedisHealthMonitor {
  private readonly logger = new Logger(RedisHealthMonitor.name);

  constructor(
    @Inject(REDIS_CACHE) private readonly cacheRedis: Redis,
    @Inject(REDIS_LOCK) private readonly lockRedis: Redis,
    private readonly alertService: AlertService,
  ) {}

  // Runs every 10 seconds
  @Cron('*/10 * * * * *')
  async checkMemoryUsage(): Promise<void> {
    // Check lock Redis -- critical
    const lockInfo = await this.lockRedis.info('memory');
    const lockUsedMemory = this.parseUsedMemory(lockInfo);
    const lockMaxMemory = this.parseMaxMemory(lockInfo);
    const lockUsagePercent = (lockUsedMemory / lockMaxMemory) * 100;

    if (lockUsagePercent > 70) {
      this.alertService.page({
        severity: 'P1',
        title: 'Lock Redis memory above 70%',
        detail: `Lock Redis is at ${lockUsagePercent.toFixed(1)}% memory. ` +
                `Used: ${(lockUsedMemory / 1e9).toFixed(2)}GB / ` +
                `Max: ${(lockMaxMemory / 1e9).toFixed(2)}GB. ` +
                `Investigate immediately -- noeviction policy means OOM ` +
                `errors will block all lock acquisitions.`,
      });
    }

    // Check cache Redis -- informational
    const cacheInfo = await this.cacheRedis.info('memory');
    const cacheUsedMemory = this.parseUsedMemory(cacheInfo);
    const cacheMaxMemory = this.parseMaxMemory(cacheInfo);
    const cacheUsagePercent = (cacheUsedMemory / cacheMaxMemory) * 100;

    if (cacheUsagePercent > 90) {
      this.logger.warn(
        `Cache Redis at ${cacheUsagePercent.toFixed(1)}% memory. ` +
        `Eviction rate may increase. Consider scaling.`
      );
    }
  }

  private parseUsedMemory(info: string): number {
    const match = info.match(/used_memory:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private parseMaxMemory(info: string): number {
    const match = info.match(/maxmemory:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}
```

### Redis Configuration Side-by-Side

```
# redis-cache.conf                    # redis-lock.conf
maxmemory 48gb                        maxmemory 4gb
maxmemory-policy allkeys-lru          maxmemory-policy noeviction
save ""                               appendonly yes
                                      appendfsync everysec
```

### The Lesson

Redis is not one tool. It is several tools that happen to share a binary. A cache and a lock store have fundamentally different requirements for eviction, persistence, and failure modes. Running them in the same instance is not a cost optimization -- it is a time bomb.

The rule we implemented after this incident: **If the disappearance of a key causes data corruption, that key does not belong in a cache-configured Redis.** Put it in a separate instance with `noeviction`, monitor it aggressively, and treat OOM as a critical page rather than a silent eviction.

The 32GB we "saved" by using a single Redis instance cost us $47,000 in refunds and an architectural rework under pressure. The two separate instances cost an additional $180/month.

---

## War Story 4: "Clock Skew Ate Our Fencing Tokens"

**Chapter 17 -- Multi-Region Conflict Resolution**

### The Setup

Our global booking system operates in four regions: `us-east` (Virginia), `eu-west` (London), `ap-northeast` (Tokyo), and `ap-southeast` (Singapore). Under normal operation, each region handles bookings for its local market. But when a user in Tokyo books a hotel in London, or when inventory is shared across regions, we need cross-region conflict resolution.

The original design used physical timestamps for ordering. When two regions processed conflicting writes to the same resource, the conflict resolution service compared timestamps and chose the "latest" write as the winner, under the assumption that a later timestamp meant a later intent.

This assumption requires one thing: that clocks across all regions agree on what time it is.

On Thursday, April 3rd, they stopped agreeing.

### The Timeline

**Wednesday, April 2nd, 22:00 UTC** -- Infrastructure team deploys a new batch of 24 servers in the `ap-northeast` (Tokyo) region. Standard AMI, standard bootstrap script. The servers pass all health checks and are added to the load balancer rotation.

**Wednesday, April 2nd, 22:00 to Thursday, April 3rd, 06:00 UTC** -- The new Tokyo servers process bookings without issue. Cross-region conflicts are rare at this hour because European traffic is low.

**Thursday, April 3rd, 06:00 UTC** -- European business hours begin. London and Tokyo traffic overlaps. Cross-region bookings involving shared inventory begin flowing through the conflict resolution service.

**06:12 UTC** -- First incorrect conflict resolution. A user in London modifies a booking at 06:12:00.000 UTC (real time). A user in Tokyo modifies the same booking at 06:12:00.200 UTC (real time -- 200ms later). London's write should lose; Tokyo's write, being later, should win.

But the Tokyo server's clock reads 06:11:59.860 UTC -- 340ms behind real time. The conflict resolution service sees London's timestamp (06:12:00.000) as *later* than Tokyo's timestamp (06:11:59.860) and chooses London's write as the winner.

The wrong write wins.

**06:12 to 09:45 UTC** -- The conflict resolution service continues making incorrect decisions on approximately 18% of cross-region conflicts involving the new Tokyo servers. The error rate depends on how close together the conflicting writes are -- if they are more than 340ms apart, the clock skew does not matter. If they are closer, it does.

**09:45 UTC** -- A hotel partner reports that a guest's room upgrade was "reversed." The guest had upgraded from a standard room to a suite (processed in Tokyo). Minutes later, the system showed the guest back in the standard room. The partner had checked three times. The upgrade kept disappearing.

**10:00 UTC** -- Engineer Kenji investigates. He finds the conflict resolution log for the booking. The Tokyo write (the upgrade) has a timestamp of 09:44:12.640. The London write (an unrelated metadata update that triggered a sync) has a timestamp of 09:44:12.800. The system chose London's write because 09:44:12.800 > 09:44:12.640. But Kenji checks the application logs on the Tokyo server and sees a discrepancy: the application received the upgrade request at 09:44:12.980 by the London server's clock.

**10:15 UTC** -- Kenji runs `ntpstat` on the new Tokyo servers.

```
unsynchronised
  time correct to within 847 ms
  polling server every 1024 s
```

Unsynchronised. The NTP daemon on the new server batch was configured to poll every 1024 seconds (17 minutes) and had drifted 340ms from the NTP reference. The AMI's NTP configuration had a typo: `minpoll 10` instead of `minpoll 4`, resulting in an initial poll interval of 1024 seconds instead of 16 seconds.

**10:20 UTC** -- SEV-2 declared. NTP configuration is fixed and forced sync is triggered across all Tokyo servers. But the damage is done: an unknown number of cross-region conflicts have been resolved incorrectly over the past 12 hours.

**10:45 UTC** -- Audit reveals 1,247 cross-region conflict resolutions during the affected window. Of those, an estimated 224 (18%) may have chosen the wrong winner.

### The Broken Code

```typescript
// BROKEN: Physical timestamp-based conflict resolution.
// Assumes clocks across all regions are perfectly synchronized.

interface ConflictingWrite {
  regionId: string;
  bookingId: string;
  payload: Record<string, unknown>;
  timestamp: number; // Date.now() from the originating server
}

@Injectable()
export class ConflictResolutionService {
  /**
   * Given two conflicting writes to the same booking from different regions,
   * choose the winner based on physical timestamp ordering.
   *
   * THE ASSUMPTION: Date.now() on server A and Date.now() on server B
   * return values that are comparable -- i.e., if event A truly happened
   * before event B, then timestamp_A < timestamp_B.
   *
   * THIS ASSUMPTION IS WRONG when clocks drift.
   */
  resolveConflict(
    writeA: ConflictingWrite,
    writeB: ConflictingWrite,
  ): ConflictingWrite {
    // Last-writer-wins based on physical timestamp
    if (writeA.timestamp >= writeB.timestamp) {
      return writeA;
    }
    return writeB;
  }
}

@Injectable()
export class CrossRegionSyncService {
  constructor(
    private readonly conflictResolver: ConflictResolutionService,
    private readonly prisma: PrismaClient,
  ) {}

  async handleIncomingSync(remoteWrite: ConflictingWrite): Promise<void> {
    const localBooking = await this.prisma.booking.findUnique({
      where: { id: remoteWrite.bookingId },
    });

    if (!localBooking) {
      // No conflict -- apply the remote write
      await this.applyWrite(remoteWrite);
      return;
    }

    const localWrite: ConflictingWrite = {
      regionId: process.env.REGION_ID!,
      bookingId: localBooking.id,
      payload: localBooking as unknown as Record<string, unknown>,
      timestamp: localBooking.updatedAt.getTime(), // Physical timestamp
    };

    const winner = this.conflictResolver.resolveConflict(localWrite, remoteWrite);

    if (winner.regionId !== process.env.REGION_ID) {
      await this.applyWrite(remoteWrite);
    }
    // If local wins, do nothing -- local state is already correct
  }
}
```

### The Fix: Lamport Clocks (Logical Timestamps)

Lamport clocks eliminate dependence on physical clocks for ordering. Each region maintains a logical counter. Every event increments the counter. When a region receives an event from another region, it updates its counter to `max(local, remote) + 1`. This guarantees that if event A causally precedes event B, then `lamport(A) < lamport(B)`.

```typescript
// FIXED: Lamport clock-based conflict resolution.
// No dependency on physical clock synchronization.

/**
 * Lamport Clock implementation.
 *
 * Rules:
 * 1. Before each local event, increment the counter.
 * 2. When sending a message, include the current counter value.
 * 3. When receiving a message, set counter = max(local, received) + 1.
 *
 * Guarantee: If event A causally precedes event B, lamport(A) < lamport(B).
 * Note: The converse is NOT guaranteed (concurrent events may have any ordering).
 * For concurrent events, we use region ID as a tiebreaker.
 */
@Injectable()
export class LamportClock {
  private counter: bigint = 0n;
  private readonly regionId: string;
  private readonly logger = new Logger(LamportClock.name);

  constructor() {
    this.regionId = process.env.REGION_ID || 'unknown';
  }

  /**
   * Increment and return the new timestamp for a local event.
   */
  tick(): LamportTimestamp {
    this.counter += 1n;
    return {
      counter: this.counter.toString(),
      regionId: this.regionId,
      // Physical time is included ONLY for human-readable logging.
      // It is NEVER used for ordering decisions.
      wallClock: new Date().toISOString(),
    };
  }

  /**
   * Merge with a remote timestamp and increment.
   * Called when receiving an event from another region.
   */
  merge(remoteTimestamp: LamportTimestamp): LamportTimestamp {
    const remoteCounter = BigInt(remoteTimestamp.counter);
    this.counter = (this.counter > remoteCounter ? this.counter : remoteCounter) + 1n;

    this.logger.debug(
      `Merged with remote clock from ${remoteTimestamp.regionId}. ` +
      `Remote: ${remoteTimestamp.counter}, New local: ${this.counter.toString()}`
    );

    return {
      counter: this.counter.toString(),
      regionId: this.regionId,
      wallClock: new Date().toISOString(),
    };
  }

  /**
   * Get the current counter value without incrementing.
   */
  current(): string {
    return this.counter.toString();
  }
}

interface LamportTimestamp {
  counter: string;    // String representation of bigint for serialization
  regionId: string;   // Tiebreaker for concurrent events
  wallClock: string;  // Human-readable only -- NEVER used for ordering
}

/**
 * Compare two Lamport timestamps.
 * Returns negative if a < b, positive if a > b, zero if equal.
 *
 * Tiebreaker: if counters are equal (concurrent events), use region ID
 * lexicographic ordering as a deterministic but arbitrary tiebreaker.
 */
function compareLamportTimestamps(
  a: LamportTimestamp,
  b: LamportTimestamp,
): number {
  const counterA = BigInt(a.counter);
  const counterB = BigInt(b.counter);

  if (counterA !== counterB) {
    return counterA < counterB ? -1 : 1;
  }

  // Concurrent events -- tiebreak on region ID for determinism.
  // The choice of "winner" for concurrent events is arbitrary but
  // must be consistent across all nodes.
  return a.regionId.localeCompare(b.regionId);
}

@Injectable()
export class ConflictResolutionService {
  /**
   * Resolve conflicts using Lamport timestamps instead of physical time.
   */
  resolveConflict(
    writeA: ConflictingWrite,
    writeB: ConflictingWrite,
  ): ConflictingWrite {
    const comparison = compareLamportTimestamps(
      writeA.lamportTimestamp,
      writeB.lamportTimestamp,
    );

    // Last-writer-wins based on Lamport ordering
    if (comparison >= 0) {
      return writeA;
    }
    return writeB;
  }
}

// Updated data structures

interface ConflictingWrite {
  regionId: string;
  bookingId: string;
  payload: Record<string, unknown>;
  lamportTimestamp: LamportTimestamp; // Replaced physical timestamp
}

@Injectable()
export class CrossRegionSyncService {
  constructor(
    private readonly conflictResolver: ConflictResolutionService,
    private readonly lamportClock: LamportClock,
    private readonly prisma: PrismaClient,
  ) {}

  async handleIncomingSync(remoteWrite: ConflictingWrite): Promise<void> {
    // CRITICAL: Merge clocks on every incoming message.
    // This ensures our local clock is always at least as high as any
    // remote clock we have seen.
    const mergedTimestamp = this.lamportClock.merge(remoteWrite.lamportTimestamp);

    const localBooking = await this.prisma.booking.findUnique({
      where: { id: remoteWrite.bookingId },
    });

    if (!localBooking) {
      await this.applyWrite(remoteWrite, mergedTimestamp);
      return;
    }

    // Retrieve the Lamport timestamp stored with the local booking
    const localTimestamp: LamportTimestamp = {
      counter: localBooking.lamportCounter,
      regionId: localBooking.lastWriteRegion,
      wallClock: localBooking.updatedAt.toISOString(),
    };

    const localWrite: ConflictingWrite = {
      regionId: process.env.REGION_ID!,
      bookingId: localBooking.id,
      payload: localBooking as unknown as Record<string, unknown>,
      lamportTimestamp: localTimestamp,
    };

    const winner = this.conflictResolver.resolveConflict(localWrite, remoteWrite);

    if (winner.regionId !== process.env.REGION_ID) {
      await this.applyWrite(remoteWrite, mergedTimestamp);
    }
  }

  private async applyWrite(
    write: ConflictingWrite,
    currentTimestamp: LamportTimestamp,
  ): Promise<void> {
    await this.prisma.booking.update({
      where: { id: write.bookingId },
      data: {
        ...write.payload,
        lamportCounter: write.lamportTimestamp.counter,
        lastWriteRegion: write.regionId,
        updatedAt: new Date(), // Physical time for logging only
      },
    });
  }
}

// The booking schema now stores the Lamport counter:
//
// model Booking {
//   id               String   @id
//   // ... other fields ...
//   lamportCounter   String   @default("0")
//   lastWriteRegion  String   @default("unknown")
//   updatedAt        DateTime @updatedAt
// }
```

### The BookingService Integration

Every booking operation now goes through the Lamport clock:

```typescript
@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly lamportClock: LamportClock,
    private readonly outboxService: OutboxService,
  ) {}

  async updateBooking(
    bookingId: string,
    updates: UpdateBookingDto,
  ): Promise<Booking> {
    // Tick the clock for this local event
    const timestamp = this.lamportClock.tick();

    const booking = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: {
          ...updates,
          lamportCounter: timestamp.counter,
          lastWriteRegion: timestamp.regionId,
        },
      });

      // Outbox event includes the Lamport timestamp
      await tx.outboxEvent.create({
        data: {
          id: randomUUID(),
          aggregateType: 'Booking',
          aggregateId: bookingId,
          eventType: 'BOOKING_UPDATED',
          payload: {
            bookingId,
            updates,
            lamportTimestamp: timestamp,
          },
        },
      });

      return updated;
    });

    return booking;
  }
}
```

### The Audit and Recovery

Recovering from 12 hours of potentially incorrect conflict resolutions was painful. We could not simply re-run the conflict resolution because the original writes were interleaved with subsequent writes from users who had seen the (potentially wrong) state.

The engineering team spent three days on the audit:

1. **Identify affected conflicts.** We queried the conflict resolution log for all resolutions during the 12-hour window that involved the affected Tokyo servers.

2. **Replay with correct ordering.** For each affected conflict, we retrieved the application-layer request logs from both regions, which included the receiving server's wall clock time. We re-resolved each conflict using the application logs as the source of truth.

3. **Manual review for cascading effects.** For each conflict where the replay produced a different winner than the original resolution, an engineer manually reviewed the booking's subsequent history to determine whether the incorrect resolution had cascading effects (e.g., a user modified the incorrectly resolved booking, creating downstream state that depended on the wrong winner).

Of the 224 potentially affected resolutions, 31 had produced definitively wrong outcomes. Of those, 8 had cascading effects that required manual intervention with the affected customers.

### The Lesson

Physical clocks lie. They lie in boring, predictable ways (NTP drift) and in exciting, unpredictable ways (VM live migration, leap seconds, daylight saving transitions). Any system that uses physical timestamps for correctness-critical ordering is one NTP misconfiguration away from silently corrupting data.

Lamport clocks are not complicated. The implementation above is about 40 lines of logic. The cost is one additional field on each record and one additional comparison operation on each conflict resolution. The benefit is that your ordering decisions are correct regardless of what any server's clock says.

Physical time has exactly one valid use in a distributed system: human-readable logging. For everything else, use logical time.

The NTP typo -- `minpoll 10` instead of `minpoll 4` -- was a single character. It took three engineers three days to clean up the consequences. That is the exchange rate between a typo in a configuration file and engineering hours: 1 character for 72 person-hours.

---

## Summary: Patterns Across All Four Incidents

Looking at these four incidents together, recurring themes emerge:

1. **The bug is never in the happy path.** Every one of these systems worked perfectly under normal conditions. The failures appeared only under load, under failure, or under misconfiguration. Test your failure modes, not just your success path.

2. **"It works on my machine" scales to "It works in one region."** Distributed systems fail at the boundaries between components, between regions, between assumptions. If you have not tested the boundary, you have not tested the system.

3. **Monitoring thresholds are part of your architecture.** Negative inventory counts were classified as P3. Redis memory warnings did not page anyone. The alerts existed but their thresholds were wrong, which is the same as the alerts not existing.

4. **The fix is always simpler than the incident.** Fencing tokens: 15 lines of code. Outbox pattern: one extra table. Separate Redis instances: one extra container. Lamport clocks: 40 lines. The cost of implementing these patterns proactively is measured in hours. The cost of implementing them reactively is measured in days, dollars, and customer trust.

Build the guard rails before you need them. You will not have time to build them during the incident.
