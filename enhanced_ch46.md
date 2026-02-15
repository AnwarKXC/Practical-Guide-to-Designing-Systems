# Chapter 46: Interview Mode --- Presenting This System in 45 Minutes

## You Built It. Now Sell It.

You have spent forty-five chapters building a system that handles 100,000 bookings per minute across four global regions. You understand the sharding strategy, the saga orchestration, the fencing tokens, the circuit breakers, the Kafka topology, and the double-entry ledger. You could talk about this system for hours.

But in a system design interview, you do not have hours. You have forty-five minutes. And most of those minutes are shared with an interviewer who is simultaneously evaluating your communication, your prioritization, your ability to handle ambiguity, and your technical depth. If you dump everything you know in a firehose, you fail. If you stay too shallow, you fail. If you solve the wrong problem, you fail.

This chapter teaches you how to present this system --- or any system of equivalent complexity --- in a structured, confident, and impressive forty-five-minute interview. It is not a list of things to memorize. It is a framework for how to think on your feet, how to read the interviewer's signals, and how to turn a nerve-wracking whiteboard session into a conversation between two engineers solving a problem together.

> **Analogy:** Think of a system design interview like a jazz performance. A jazz musician does not play every note they know. They listen to the band, read the audience, and play the right notes at the right time. They have practiced scales for thousands of hours --- but on stage, they improvise. Your preparation (this entire book) is the scales. This chapter teaches you how to improvise.

> **What If You Skip This?** You walk into the interview, get asked "Design a booking system," freeze for ten seconds, then start drawing boxes labeled "Service A" and "Service B" with no strategy. You spend twenty minutes on the part the interviewer does not care about. You get a "no hire" from someone who would have been impressed if you had simply structured your answer differently.

---

## 1. The 45-Minute System Design Interview Framework

Here is the blueprint. Every minute is accounted for.

```
 0:00 ──────── 5:00 ──────── 15:00 ──────────── 35:00 ──────── 45:00
  |   Phase 1   |   Phase 2   |     Phase 3      |   Phase 4   |
  | Requirements| High-Level  |    Deep Dive     |  Trade-offs |
  |  Gathering  | Architecture| (2-3 components) | & Extensions|
  |  (5 min)    |  (10 min)   |    (20 min)      |  (10 min)   |
```

The time splits are not arbitrary. They reflect how interviewers actually evaluate candidates:

- **Phase 1** tests whether you can scope a problem before solving it.
- **Phase 2** tests whether you can design a coherent architecture.
- **Phase 3** tests whether you have real depth in specific areas.
- **Phase 4** tests whether you understand engineering trade-offs and can think beyond your initial design.

Most candidates fail because they skip Phase 1, rush Phase 2, ramble through Phase 3, and never reach Phase 4. Do not be most candidates.

---

### Phase 1: Requirements Gathering (5 Minutes)

The biggest trap in system design interviews is jumping to solutions. You hear "design a booking system" and immediately start drawing databases and message queues. The interviewer watches you build a beautiful solution to the wrong problem.

Spend five minutes making sure you and the interviewer agree on what you are building. Ask these exact questions. Write the answers on the whiteboard where both of you can see them.

#### The Questions to Ask

**Question 1: "What scale are we designing for?"**

Why you ask this: Scale determines every architectural decision. A system for 100 bookings per day is a monolith with a single PostgreSQL instance. A system for 100,000 bookings per minute requires sharding, async processing, regional deployment, and distributed coordination.

Expected answer: 100,000 bookings per minute at peak.

What you write on the whiteboard: `100K bookings/min = ~1,666/sec`

**Question 2: "How many regions do we need to serve?"**

Why you ask this: Multi-region changes everything --- data replication, consistency models, conflict resolution, deployment strategy, and latency targets.

Expected answer: 4 global regions (e.g., US-East, EU-West, AP-Southeast, AP-Northeast).

What you write on the whiteboard: `4 regions, users routed to nearest`

**Question 3: "What is the consistency model?"**

Why you ask this: This is the question that separates senior candidates from everyone else. Junior candidates assume everything is strongly consistent. Senior candidates know that different parts of the system need different consistency guarantees.

Expected answer: Strong consistency for inventory (you cannot oversell a room). Eventual consistency for search (a few seconds of stale results is acceptable).

What you write on the whiteboard: `Strong: inventory | Eventual: search, notifications`

**Question 4: "What is the read-to-write ratio?"**

Why you ask this: A 20:1 read-to-write ratio means the read path handles 95% of traffic. You optimize the read path first. You scale reads and writes differently.

Expected answer: 20:1. For every booking created, there are roughly 20 search queries.

What you write on the whiteboard: `20:1 read:write -> ~33K searches/sec`

**Question 5: "Do we need financial audit trails?"**

Why you ask this: Financial systems have regulatory requirements --- audit logs, double-entry accounting, immutable records, reconciliation. This is not optional. Asking this question signals that you have built production financial systems before.

Expected answer: Yes. Double-entry accounting. Every monetary movement must have a debit and a credit that balance.

What you write on the whiteboard: `Double-entry ledger, immutable audit log`

#### What Your Whiteboard Looks Like After Phase 1

```
┌─────────────────────────────────────────────┐
│  REQUIREMENTS                               │
│                                             │
│  Scale: 100K bookings/min (1,666/sec)       │
│  Regions: 4 (US, EU, AP-SE, AP-NE)         │
│  Read:Write = 20:1 -> 33K searches/sec      │
│  Consistency: Strong (inventory),           │
│               Eventual (search)             │
│  Financial: Double-entry, audit logs        │
│  Availability: 99.95% SLO                  │
└─────────────────────────────────────────────┘
```

> **Coaching note:** Some interviewers will answer all five questions eagerly. Others will say, "You decide." If they say you decide, state your assumptions out loud and write them down. The interviewer is testing whether you can make reasonable assumptions and communicate them clearly. Do not just silently pick a number. Say: "I will assume we need to handle 100K bookings per minute at peak, with four global regions. Does that sound reasonable?"

> **Key Term:** **Requirements Anchoring** --- The practice of writing functional and non-functional requirements on the whiteboard before designing anything. It creates a shared contract between you and the interviewer, and it gives you something to point back to when justifying decisions later. "We chose sharding because of the 100K/min requirement we agreed on."

---

### Phase 2: High-Level Architecture (10 Minutes)

Now you draw the system. You have ten minutes. The goal is not to show every component --- it is to show the critical path clearly enough that the interviewer can point to a box and say, "Tell me more about that."

Follow these four steps in order. Each step takes about two to three minutes.

#### Step 1: Draw the Entry Points and Core Services (2 minutes)

Start from the left (the client) and move right. Draw:

- **Client** (web/mobile)
- **CDN / Load Balancer**
- **API Gateway** (authentication, rate limiting, routing)
- **Three core services:** Search Service, Booking Service, Inventory Service

Say out loud: "The client hits our API Gateway, which handles auth and rate limiting. All read traffic goes to the Search Service. Write traffic --- creating and modifying bookings --- goes to the Booking Service, which coordinates with the Inventory Service."

#### Step 2: Add Data Stores (3 minutes)

Now draw the data layer beneath the services:

- **MySQL (16 shards)** under Booking Service and Inventory Service
- **Elasticsearch** under Search Service
- **Redis Cluster** between the services and the databases (caching + distributed locks)
- **Kafka (15 brokers, KRaft)** as the event backbone connecting services

Say out loud: "We shard MySQL across 16 instances by booking ID hash. Elasticsearch powers search with eventual consistency. Redis serves two roles: caching for the read path and distributed locking for the write path. Kafka connects everything asynchronously."

#### Step 3: Draw Read Path vs. Write Path (3 minutes)

Use different line styles --- solid for the read path, dashed for the write path. This is the moment that makes the interviewer sit up.

Say out loud: "Let me separate the read path from the write path because they have completely different performance characteristics and consistency requirements."

Read path (solid arrows): Client -> API Gateway -> Search Service -> Redis Cache (95%+ hit rate) -> Elasticsearch (cache miss)

Write path (dashed arrows): Client -> API Gateway -> Booking Service -> Redis Lock -> Inventory Service (SELECT FOR UPDATE) -> MySQL shard -> Kafka event -> (fan out to Search Service, Payment Service, Notification Service)

#### Step 4: Add the Four Regions (2 minutes)

Draw a simplified multi-region view. Show:

- Each region has its own API Gateway, services, and Redis cluster
- One region is the primary for each shard's writes
- Kafka MirrorMaker replicates events across regions
- MySQL async replication for read replicas in other regions

Say out loud: "Each region runs a full copy of the stateless services. Writes for a given shard go to the region that owns that shard's primary. Events are replicated across regions via Kafka MirrorMaker. Read replicas in each region serve local search traffic."

#### The Final ASCII Whiteboard Diagram

```
                        ┌─── REGION: US-EAST ────────────────────────────┐
                        │                                                 │
  ┌────────┐   HTTPS    │  ┌───────────┐    ┌──────────────────────┐     │
  │ Client ├───────────>│  │ API GW    │    │ Redis Cluster        │     │
  │ (Web/  │            │  │ - Auth    │    │ - Session cache      │     │
  │ Mobile)│            │  │ - Rate    │    │ - Inventory cache    │     │
  └────────┘            │  │   Limit   │    │ - Distributed locks  │     │
                        │  └─────┬─────┘    └──────────┬───────────┘     │
                        │        │                     │                  │
                        │   ┌────┴────────────┬────────┴──────┐          │
                        │   │                 │               │          │
                        │   v                 v               v          │
                        │ ┌──────────┐ ┌───────────┐ ┌──────────────┐   │
                        │ │ Search   │ │ Booking   │ │ Inventory    │   │
                        │ │ Service  │ │ Service   │ │ Service      │   │
                        │ └────┬─────┘ └─────┬─────┘ └──────┬───────┘   │
                        │      │             │               │           │
                        │      v             │               v           │
                        │ ┌──────────┐       │        ┌─────────────┐   │
                        │ │ Elastic  │       │        │ MySQL       │   │
                        │ │ search   │       │        │ Shards 1-4  │   │
                        │ └──────────┘       │        │ (Primary)   │   │
                        │                    │        └─────────────┘   │
                        │                    v                          │
                        │            ┌───────────────┐                  │
                        │            │ Kafka Cluster  │                  │
                        │            │ (KRaft mode)   │                  │
                        │            └───────┬───────┘                  │
                        └────────────────────┼──────────────────────────┘
                                             │
                           Kafka MirrorMaker │  MySQL Async Replication
                      ┌──────────────────────┼──────────────────────┐
                      │                      │                      │
               ┌──────v──────┐       ┌───────v─────┐       ┌───────v─────┐
               │ REGION:     │       │ REGION:     │       │ REGION:     │
               │ EU-WEST     │       │ AP-SOUTH    │       │ AP-NORTH    │
               │ Shards 5-8  │       │ Shards 9-12 │       │ Shards 13-16│
               │ (Primary)   │       │ (Primary)   │       │ (Primary)   │
               └─────────────┘       └─────────────┘       └─────────────┘
```

> **Coaching note:** Start with the read path because it is 95% of traffic. If you start with the write path, you will spend your ten minutes on the complex booking saga and never show the interviewer the full picture. Read path first. Write path second. Resilience patterns third. This is the order that mirrors how real traffic flows through the system. It also mirrors how the interviewer thinks about the system --- they want to see you handle the common case before the edge cases.

---

### Phase 3: Deep Dive (20 Minutes)

This is where interviews are won or lost. The interviewer will point to something on your diagram and say, "Tell me more about that." You do not control which component they pick. You must be ready for any of them.

Here are the four most common deep-dive topics for a booking system, with exactly what to say and show for each one.

---

#### Deep Dive A: "How do you prevent double bookings?"

This is the single most likely question. If you can only prepare one deep dive, prepare this one.

Walk through the five-step sequence. Draw it on the whiteboard as you explain.

**Step 1: Idempotency key at the API Gateway**

"Every booking request includes an `Idempotency-Key` header. The API Gateway checks Redis for this key. If it exists, the request is a duplicate --- we return the original response. This prevents double-submissions from network retries or impatient users clicking twice."

**Step 2: Distributed lock with fencing token (Redis)**

"Before touching inventory, the Booking Service acquires a distributed lock in Redis for the specific room type and date range. The lock includes a fencing token --- a monotonically increasing number. This prevents a stale lock holder from making changes after a new lock holder has taken over."

```typescript
// Acquiring a distributed lock with fencing token
async function acquireInventoryLock(
  redis: RedisCluster,
  hotelId: number,
  roomTypeId: number,
  dateRange: string,
): Promise<{ lockId: string; fencingToken: number } | null> {
  const lockKey = `lock:inventory:${hotelId}:${roomTypeId}:${dateRange}`;
  const lockId = crypto.randomUUID();

  // INCR returns the new fencing token atomically
  const fencingToken = await redis.incr(`fencing:${lockKey}`);

  // SET NX with expiration --- only succeeds if lock does not exist
  const acquired = await redis.set(lockKey, lockId, 'NX', 'PX', 5000);

  if (!acquired) {
    return null; // Another process holds the lock
  }

  return { lockId, fencingToken };
}
```

**Step 3: Inventory check with SELECT FOR UPDATE**

"With the lock held, the Inventory Service reads the current availability using `SELECT FOR UPDATE`, which takes a row-level lock in MySQL. This is the strong consistency guarantee --- no two transactions can read the same inventory row simultaneously."

```typescript
// Inside a Prisma transaction on the correct shard
const inventory = await prisma.$transaction(async (tx) => {
  // SELECT FOR UPDATE: locks the row until transaction commits
  const row = await tx.$queryRaw`
    SELECT available_count, version
    FROM room_inventory
    WHERE hotel_id = ${hotelId}
      AND room_type_id = ${roomTypeId}
      AND date = ${date}
    FOR UPDATE
  `;

  if (row[0].available_count < requestedRooms) {
    throw new InsufficientInventoryError(hotelId, roomTypeId, date);
  }

  // Decrement with optimistic concurrency via version check
  const updated = await tx.$executeRaw`
    UPDATE room_inventory
    SET available_count = available_count - ${requestedRooms},
        version = version + 1,
        updated_at = NOW()
    WHERE hotel_id = ${hotelId}
      AND room_type_id = ${roomTypeId}
      AND date = ${date}
      AND version = ${row[0].version}
  `;

  if (updated === 0) {
    throw new ConcurrentModificationError();
  }

  return row[0];
});
```

**Step 4: Saga orchestration**

"The booking is not a single transaction --- it is a saga with multiple steps: lock inventory, authorize payment, create ledger entries, send confirmation. The Saga Orchestrator coordinates these steps and tracks state in its own database."

```
  Saga: CreateBooking
  ┌─────────┬────────────────────┬──────────────────────────┐
  │ Step    │ Action             │ Compensating Action       │
  ├─────────┼────────────────────┼──────────────────────────┤
  │ 1       │ Reserve inventory  │ Release inventory         │
  │ 2       │ Authorize payment  │ Void authorization        │
  │ 3       │ Create ledger      │ Reverse ledger entries    │
  │ 4       │ Confirm booking    │ Cancel booking            │
  │ 5       │ Send notification  │ Send cancellation notice  │
  └─────────┴────────────────────┴──────────────────────────┘
```

**Step 5: Compensating actions on failure**

"If any step fails, the orchestrator runs the compensating actions for all previously completed steps in reverse order. If payment authorization fails after inventory was reserved, we release the inventory. Every compensating action is idempotent --- running it twice produces the same result."

Say to the interviewer: "The key insight is defense in depth. The idempotency key prevents duplicate requests. The distributed lock prevents concurrent access. SELECT FOR UPDATE prevents database-level races. The saga prevents partial state. No single mechanism is sufficient --- you need all four layers working together."

---

#### Deep Dive B: "How do you handle failures?"

Walk through the failure handling hierarchy, from localized to systemic.

**Layer 1: Circuit Breaker**

"Each service-to-service call goes through a circuit breaker. After 5 consecutive failures or a 50% error rate in a 10-second window, the circuit opens. Subsequent calls fail immediately without hitting the downstream service. This prevents cascade failures."

```typescript
// Circuit breaker configuration for the Payment Service
@Injectable()
export class PaymentServiceClient {
  private readonly circuitBreaker: CircuitBreaker;

  constructor() {
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,          // Open after 5 failures
      successThreshold: 3,          // Close after 3 successes
      timeout: 10_000,              // Half-open after 10 seconds
      monitorInterval: 5_000,       // Check metrics every 5 seconds
      fallback: () => ({            // Fallback when circuit is open
        status: 'PAYMENT_UNAVAILABLE',
        retryAfter: 30,
      }),
    });
  }

  async authorizePayment(request: PaymentRequest): Promise<PaymentResult> {
    return this.circuitBreaker.execute(() =>
      this.httpClient.post('/api/v1/payments/authorize', request),
    );
  }
}
```

**Layer 2: Retry with Exponential Backoff and Jitter**

"When a single call fails, we retry with exponential backoff plus jitter. The backoff prevents hammering a struggling service. The jitter prevents thundering herd --- without it, all retries from all instances would fire at the same moment."

```typescript
// Retry delay calculation with jitter
function calculateRetryDelay(attempt: number): number {
  const baseDelay = 100;          // 100ms
  const maxDelay = 30_000;        // 30 seconds cap
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  const jitter = cappedDelay * Math.random(); // 0% to 100% jitter
  return cappedDelay + jitter;
}
// Attempt 0: 100-200ms
// Attempt 1: 200-400ms
// Attempt 2: 400-800ms
// Attempt 3: 800-1600ms
// Attempt 4: 1600-3200ms
```

**Layer 3: Saga Compensation**

"When a step permanently fails (not transient), the saga orchestrator triggers compensating actions. We already covered this — the key point is that compensation is eventual. We guarantee it will happen, but not instantly."

**Layer 4: Dead Letter Queue (DLQ)**

"Events that fail processing after all retries go to a dead letter topic in Kafka. An operations team monitors the DLQ dashboard. They can inspect the failed event, fix the root cause, and replay the event."

**Layer 5: Manual Reprocessing**

"For truly exceptional failures --- data corruption, third-party API changes, regulatory holds --- we have admin tooling that allows operators to manually inspect, modify, and reprocess events from the DLQ."

Show the failure cascade prevention diagram:

```
  Request arrives
       │
       v
  ┌─────────────┐    Circuit open?    ┌──────────────┐
  │ Circuit      ├───── YES ─────────>│ Return        │
  │ Breaker      │                    │ Fallback      │
  └──────┬───────┘                    └──────────────┘
         │ NO
         v
  ┌─────────────┐    Success?         ┌──────────────┐
  │ Execute      ├───── YES ─────────>│ Return        │
  │ Request      │                    │ Result        │
  └──────┬───────┘                    └──────────────┘
         │ NO (transient failure)
         v
  ┌─────────────┐    Retries left?    ┌──────────────┐
  │ Retry with   ├───── NO ──────────>│ Saga          │
  │ Backoff      │                    │ Compensation  │
  └──────┬───────┘                    └──────┬───────┘
         │ YES                               │
         v                                   v
  (back to Execute Request)          ┌──────────────┐
                                     │ Dead Letter   │
                                     │ Queue         │
                                     └──────┬───────┘
                                            │
                                            v
                                     ┌──────────────┐
                                     │ Manual        │
                                     │ Reprocessing  │
                                     └──────────────┘
```

Say to the interviewer: "The philosophy is: handle transient failures automatically, handle permanent failures through compensation, and handle unexpected failures through human inspection. Every failure has a defined path. Nothing disappears silently."

---

#### Deep Dive C: "How do you scale the database?"

This deep dive showcases your understanding of data-layer engineering --- the part most candidates wave their hands at.

**Sharding Strategy**

"We shard by `booking_id` using a consistent hash. The booking ID is a 64-bit Snowflake ID that embeds a timestamp, region ID, and sequence number. We hash the booking ID modulo 16 to determine the shard."

```typescript
// Shard routing logic
function getShardIndex(bookingId: bigint): number {
  const SHARD_COUNT = 16;
  // Use the lower bits of the booking ID for distribution
  return Number(bookingId % BigInt(SHARD_COUNT));
}

function getShardConnection(bookingId: bigint): PrismaClient {
  const shardIndex = getShardIndex(bookingId);
  return shardConnections[shardIndex]; // Pre-initialized pool
}
```

**Why 16 Shards**

"At 1,666 writes per second, each shard handles about 104 writes per second. A single MySQL instance with NVMe SSDs comfortably handles 2,000-3,000 writes per second with our schema, so 104 per shard gives us 20-30x headroom. We chose 16 because: it is a power of two (clean hash distribution), it gives enough headroom for 5 years of growth, and it maps cleanly to 4 regions (4 shards per region as primaries)."

**Read Replicas**

"Each shard has 2 read replicas — one in the same region for local reads, one in a different region for cross-region read traffic. Read replicas handle the 20:1 read-to-write ratio. The Booking Service routes reads to replicas unless the request requires strong consistency."

**Connection Pooling with ProxySQL**

"Between application pods and MySQL shards, we run ProxySQL. It pools connections (each pod gets 10 connections to ProxySQL, and ProxySQL maintains 50 connections to each MySQL instance). It also handles read/write splitting: queries tagged as read-only go to replicas automatically."

```
  ┌──────────────┐
  │  App Pod 1   ├──┐
  └──────────────┘  │
  ┌──────────────┐  │    ┌───────────┐    ┌─────────────────┐
  │  App Pod 2   ├──┼───>│ ProxySQL  ├───>│ MySQL Shard 1   │
  └──────────────┘  │    │ (pooling, │    │  - Primary (RW)  │
  ┌──────────────┐  │    │  routing) │    │  - Replica 1 (R) │
  │  App Pod 3   ├──┘    └───────────┘    │  - Replica 2 (R) │
  └──────────────┘                        └─────────────────┘
  10 conns each         50 conns total     vs. 30 direct = saved
```

**Cross-Shard Query Limitations**

"This is the trade-off I want to be explicit about. Sharding by booking ID makes booking lookups fast --- single-shard query. But 'show me all bookings for user X' requires a scatter-gather across all 16 shards, because a user's bookings live on different shards. We handle this two ways: first, we maintain a secondary index in Elasticsearch keyed by user ID. Second, for the rare admin queries that truly need SQL across shards, we have a read-only analytics replica that combines all shards through logical replication."

Say to the interviewer: "The key trade-off is access pattern optimization. We optimized for the hot path --- individual booking operations --- at the cost of making cross-shard queries harder. Every sharding strategy makes this trade-off. The question is whether you are aware of it and have mitigations."

---

#### Deep Dive D: "How do you handle multiple regions?"

**Regional Write Ownership**

"Each shard has a single primary in one region. Shards 1-4 are primary in US-East. Shards 5-8 in EU-West. And so on. When a user in Europe creates a booking, the API Gateway routes the write request to the region that owns the relevant shard. This means some writes have cross-region latency --- about 80-120ms for transatlantic requests."

**How We Minimize Cross-Region Writes**

"We route users geographically. A European user searching for hotels in Paris generates a booking that maps to a shard owned by EU-West. This is likely because the hotel ID (which influences the booking ID generation) is co-located with the region that hosts that hotel's inventory. About 85% of bookings land on a shard in the user's nearest region."

**Async Replication for Search**

"Elasticsearch in each region maintains a full copy of all inventory. When inventory changes in US-East, the Inventory Service publishes an event to Kafka. Kafka MirrorMaker replicates that event to the EU-West Kafka cluster. The EU-West Search Service consumes it and updates the local Elasticsearch. Replication lag is typically 200-500ms."

**Conflict Resolution with Fencing Tokens**

"If two regions attempt to modify the same inventory simultaneously --- say, a booking in US-East and another in EU-West for the same room on the same date --- the single-primary model prevents write conflicts at the database level. Only one region owns the primary for a given shard. But for event ordering across regions, we use Lamport clocks embedded in each event. Consumers process events in Lamport clock order, which gives us causal consistency."

```
  ┌──────────────┐      Kafka MirrorMaker      ┌──────────────┐
  │  US-EAST     │ ──────────────────────────>  │  EU-WEST     │
  │  Kafka       │ <──────────────────────────  │  Kafka       │
  │  Cluster     │      (bidirectional)         │  Cluster     │
  └──────┬───────┘                              └──────┬───────┘
         │                                             │
         v                                             v
  ┌──────────────┐                              ┌──────────────┐
  │ MySQL        │     Async Replication         │ MySQL        │
  │ Shards 1-4   │ ────────────────────────>    │ Shards 1-4   │
  │ (PRIMARY)    │                              │ (REPLICA)    │
  └──────────────┘                              └──────────────┘
  ┌──────────────┐                              ┌──────────────┐
  │ MySQL        │     Async Replication         │ MySQL        │
  │ Shards 5-8   │ <────────────────────────    │ Shards 5-8   │
  │ (REPLICA)    │                              │ (PRIMARY)    │
  └──────────────┘                              └──────────────┘
```

**Failover Between Regions**

"If US-East goes down entirely, we promote the US-East shard replicas in EU-West to primary. This is a manual decision --- automated cross-region failover is dangerous because it can cause split-brain if the outage is actually a network partition, not a true failure. We use a human-in-the-loop runbook with a target failover time of 5 minutes."

---

### Phase 4: Trade-offs and Extensions (10 Minutes)

This is the phase that gets you a "strong hire." Anyone can describe what they built. Senior engineers can articulate why they built it that way, what they gave up, and what they would do differently.

#### How to Discuss Trade-offs Maturely

Use this sentence structure: "We chose X over Y because Z. The cost is W, which we mitigate with V."

**Trade-off 1: Sagas over 2PC**

"We chose the saga pattern over two-phase commit because 2PC requires all participants to be available simultaneously and holds locks across services for the duration of the transaction. At 1,666 bookings per second, those locks would become a bottleneck. Sagas give us eventual consistency with compensating actions. The cost is complexity --- we have to write and test compensating actions for every step. We mitigate this with a saga orchestrator that tracks state and a comprehensive test suite for compensation paths."

**Trade-off 2: Eventual Consistency in Search**

"We accept eventual consistency in search because it lets us serve 33,000 searches per second from Elasticsearch without coordinating with the MySQL primary. A user might see a room as available for up to 500ms after it was booked. The cost is phantom availability --- a user clicks 'Book,' and the saga fails at inventory check. We mitigate this with a clear UX: 'Sorry, this room was just booked. Here are similar options.' Less than 0.1% of search results hit this case."

**Trade-off 3: Single-Primary Sharding over Multi-Primary**

"We chose single-primary per shard over multi-primary replication because multi-primary introduces write conflicts that require complex resolution logic. With financial data --- particularly double-entry accounting --- conflict resolution is a regulatory minefield. The cost is cross-region write latency for the 15% of bookings that route to a non-local shard. We mitigate this with geographic shard placement and a target of 85% local writes."

#### Extension Ideas to Propose

If time permits, offer extensions. These show forward-thinking:

- "If we needed to support flash sales (10x spike for 30 seconds), I would add a queue-based admission control system in front of the Booking Service. Overflow requests get queued rather than rejected."
- "If search latency became critical, we could add a GraphQL layer that batches and deduplicates downstream calls, reducing round trips from 3 to 1."
- "For cost optimization, we could move the analytics replica to a columnar store like ClickHouse, which is 5-10x cheaper for OLAP queries than MySQL read replicas."

---

## 2. Common Interview Traps (and How to Avoid Them)

These are the ten most common mistakes candidates make in booking system design interviews. For each one, I explain why it sounds reasonable, why it is wrong, and what to say instead.

---

**Trap 1: "Just use a distributed transaction"**

Why it sounds right: Distributed transactions (2PC) guarantee atomicity across services. That sounds like exactly what you want for a booking that involves inventory, payment, and ledger entries.

Why it is wrong: Two-phase commit requires all participants to be available and responsive during the prepare and commit phases. A single slow participant blocks the entire transaction. At 1,666 transactions per second, even 50ms of additional latency per 2PC round-trip creates a backlog that cascades into timeouts. Worse, if the coordinator crashes between prepare and commit, participants hold their locks indefinitely until the coordinator recovers.

What to say instead: "We use the saga pattern with compensating actions. Each step is a local transaction. If a step fails, we run compensating actions in reverse order. This gives us eventual consistency without cross-service locks."

---

**Trap 2: "Put everything in Redis"**

Why it sounds right: Redis is fast. Sub-millisecond reads. If you cache everything in Redis, your system is fast.

Why it is wrong: Redis is not durable by default. Even with AOF persistence, you can lose the last second of writes during a crash. If your "source of truth" is Redis and it crashes, you lose bookings. Redis is also memory-bound --- storing 50 million booking records at 2KB each requires 100GB of RAM, which costs 10x more than the equivalent SSD storage in MySQL.

What to say instead: "We use Redis for two specific purposes: caching frequently accessed data (with a defined TTL and invalidation strategy) and distributed locking (with fencing tokens for correctness). MySQL is always the source of truth. If Redis dies, we lose performance, not data."

---

**Trap 3: "Use microservices from day one"**

Why it sounds right: Microservices are the industry standard for large-scale systems. Starting with them avoids a painful migration later.

Why it is wrong: Microservices add network latency, operational complexity (deployment, monitoring, debugging), and data consistency challenges. For a team of 5 engineers, microservices create more problems than they solve. The right time to split is when team size demands it --- when two teams need to deploy independently on different schedules.

What to say instead: "In production, we run these as separate services because the team is large enough to support it. But if I were building this from scratch with a small team, I would start with a modular monolith --- well-defined module boundaries in a single deployable --- and split services when team coordination cost justifies it."

---

**Trap 4: "Make everything strongly consistent"**

Why it sounds right: Strong consistency means no stale data. Users always see the truth. What is wrong with that?

Why it is wrong: Strong consistency requires coordination --- locks, leader election, synchronous replication. Every coordination point adds latency and reduces throughput. If search results must be strongly consistent, every search query must read from the MySQL primary, which cannot handle 33,000 queries per second on 16 shards.

What to say instead: "Only inventory needs strong consistency because overselling a room has financial and reputational consequences. Search can be eventually consistent because a 500ms delay in reflecting a booking is invisible to users. Notifications are fire-and-forget. We match the consistency level to the business requirement of each component."

---

**Trap 5: "Auto-scale everything"**

Why it sounds right: Kubernetes auto-scaling handles traffic spikes automatically. Just set up HPA and forget about it.

Why it is wrong: Stateless services (API Gateway, Search Service, Booking Service) auto-scale beautifully. Stateful systems (MySQL shards, Kafka brokers, Elasticsearch nodes) do not. You cannot add a 17th MySQL shard without resharding data. You cannot add a Kafka broker without rebalancing partitions, which takes hours under load. Elasticsearch node additions trigger shard rebalancing that temporarily increases latency.

What to say instead: "We auto-scale the stateless compute layer with Kubernetes HPA. For the data layer, we capacity-plan proactively: we provision 16 MySQL shards with enough headroom for 5 years of growth. Adding shards is a planned operation, not a reactive one."

---

**Trap 6: "Use Kafka for everything"**

Why it sounds right: Kafka is the event backbone. Why not route all communication through it for consistency?

Why it is wrong: Kafka is optimized for asynchronous, one-to-many event distribution. Synchronous request-response --- like "is this room available right now?" or "authorize this payment" --- should use HTTP or gRPC. Routing a synchronous request through Kafka adds latency (producer -> broker -> consumer -> broker -> reply) and complexity (correlation IDs, reply topics, timeout handling).

What to say instead: "We use Kafka for asynchronous event distribution: booking confirmations fanning out to search reindexing, notification delivery, and analytics ingestion. Synchronous queries like availability checks and payment authorizations use HTTP with circuit breakers. The rule: if the caller needs the result before proceeding, use HTTP. If it can fire-and-forget, use Kafka."

---

**Trap 7: "One big database with read replicas"**

Why it sounds right: Read replicas handle the 20:1 read-to-write ratio. Problem solved.

Why it is wrong: Read replicas help with read scaling but do nothing for write scaling. At 1,666 writes per second with our booking schema (multiple tables, indexing, constraint checks), a single MySQL primary becomes CPU-bound around 2,000-3,000 writes per second. Growth to 200K bookings per minute would require write scaling that replicas cannot provide.

What to say instead: "Read replicas handle the read load, but we also need write scaling. We shard MySQL into 16 instances so each handles roughly 104 writes per second. This gives us 20x headroom on the write path. The sharding key is booking ID, which gives us even distribution and single-shard lookups for the hot path."

---

**Trap 8: "NoSQL is faster"**

Why it sounds right: NoSQL databases like DynamoDB or Cassandra are designed for horizontal scaling. They should be faster for this workload.

Why it is wrong: The booking system is fundamentally a financial system. It needs ACID transactions for inventory management, foreign key constraints for data integrity, and SQL joins for reporting. NoSQL trades consistency guarantees for write flexibility --- exactly the wrong trade-off for a system where double-charging a customer or overselling a room has legal consequences. MySQL with proper indexing and sharding handles this workload with less operational risk.

What to say instead: "MySQL gives us ACID transactions, which are non-negotiable for financial operations. We scale it through sharding --- 16 instances, each handling well within its capacity. We use NoSQL (Elasticsearch) where its strengths apply: full-text search, filtering, and aggregation for the read path. We pick the right tool for each access pattern."

---

**Trap 9: "Just add a cache"**

Why it sounds right: Caching reduces database load and improves latency. It is a universal optimization.

Why it is wrong: Caching without an invalidation strategy is a bug factory. If you cache room availability and a booking is made, for how long does the cache show stale availability? If the cache and database disagree, which one is right? Cache stampede --- hundreds of requests hitting the database simultaneously when a cache key expires --- can take down the database faster than no caching at all.

What to say instead: "We cache search results in Redis with a 30-second TTL. On inventory changes, we publish a cache invalidation event through Kafka. The Search Service listens for these events and evicts the relevant cache keys. For cache stampede protection, we use a probabilistic early expiration algorithm: each request has a small chance of refreshing the cache before it expires, spreading the load over time instead of creating a thundering herd at expiration."

---

**Trap 10: "99.99% availability is easy"**

Why it sounds right: Kubernetes restarts failed pods. Load balancers route around unhealthy instances. Modern infrastructure is reliable.

Why it is wrong: 99.99% availability means at most 4.3 minutes of downtime per month --- total, across all incidents. A single bad deployment that takes 5 minutes to roll back blows the entire budget. A database failover that takes 30 seconds happens in production more often than you think. Getting to 99.99% requires redundancy at every layer, automated failover, canary deployments, and an incident response process measured in seconds, not minutes.

What to say instead: "Our SLO is 99.95% --- about 22 minutes of downtime per month. We manage this through error budgets: when we have consumed 80% of the budget, we freeze feature deployments and focus on reliability. Getting to 99.99% would require multi-region active-active with automated failover, which we consciously decided against because automated cross-region failover risks split-brain scenarios that are worse than 4 minutes of planned downtime."

---

## 3. The 5-Minute Elevator Pitch

There are moments when you do not have 45 minutes. You are in an elevator with a hiring manager. You are at a conference and someone asks what you work on. You get the dreaded, "Tell me about your most complex project" as the first question in a phone screen.

Here is the pitch. Practice it until you can deliver it in five minutes without looking at notes. Every sentence is load-bearing -- it communicates a decision, a number, or a trade-off.

---

"We built a global booking platform that handles 100,000 bookings per minute across four geographic regions.

On the read path, we serve roughly 33,000 search queries per second. Elasticsearch powers the search, backed by a Redis cache with a 95% hit rate. A cache miss goes to Elasticsearch, which returns results in under 50ms. The read path is eventually consistent with a maximum lag of 500ms from the write path.

On the write path, a booking request goes through a saga orchestrator that coordinates five steps: inventory reservation using Redis distributed locks with fencing tokens, payment authorization via a third-party gateway with circuit breaker protection, financial ledger entries using double-entry accounting in MySQL, booking record creation, and asynchronous notification. Each step has a compensating action for rollback.

We shard MySQL across 16 instances, 4 per region. Each region owns the primaries for its local shards. Cross-region reads use async replicas. We chose sharding over a single large instance because we needed write scaling --- read replicas only solve half the problem.

Kafka with 15 brokers in KRaft mode handles async event processing: search reindexing, notification fanout, analytics ingestion, and cross-region event replication via MirrorMaker.

Everything runs on Kubernetes with auto-scaling for stateless services. Stateful services are capacity-planned with 20x headroom.

The biggest engineering challenge was preventing double-bookings across regions. A room in Tokyo could be booked simultaneously by a user in New York and a user in London. We solved this with single-primary shard ownership (only one region can write to a given shard), fencing tokens on distributed locks (preventing stale lock holders from making changes), and Lamport clocks for cross-region event ordering. The result: zero double-bookings in production across 3 billion processed booking requests."

---

> **Coaching note:** Notice the structure. It follows read-path, write-path, data layer, infrastructure, biggest challenge. This is the same structure as Phase 2 of the interview framework, compressed. If the listener wants to go deeper, they will ask. The pitch gives them exactly enough context to ask informed follow-up questions.

---

## 4. Questions YOU Should Ask the Interviewer

The last five minutes of an interview often go to "Do you have any questions for us?" Most candidates ask about team size, tech stack, or work-life balance. Those are fine, but they do not demonstrate technical depth.

Ask questions that show you think like a senior engineer. Here are six, with the reasoning behind each.

---

**Question 1: "What is your current error budget burn rate?"**

Why this impresses: It shows you understand SRE practices, SLOs, and the concept that reliability is a finite resource to be managed, not a binary state. Most candidates have never heard the term "error budget burn rate."

What you learn: Whether the team has operational maturity. If they look confused, the team does not practice SRE. If they answer precisely ("we are at 40% burn this month"), the team takes reliability seriously.

**Question 2: "How do you handle schema evolution for your event contracts?"**

Why this impresses: It shows you understand that microservices communication is an API surface that requires versioning, backward compatibility, and governance. This is a topic most candidates never consider.

What you learn: Whether the team has solved the event contract problem (schema registry, compatibility checks) or whether they are still manually coordinating event changes across teams.

**Question 3: "What is your strategy for cross-shard queries?"**

Why this impresses: It shows you understand the fundamental trade-off of sharding. Single-shard queries are fast; cross-shard queries are painful. Every sharded system has to solve this.

What you learn: Whether the team has thought beyond basic sharding. Look for answers involving secondary indexes, materialized views, CQRS patterns, or analytics replicas.

**Question 4: "How do you test failure scenarios in staging?"**

Why this impresses: It shows you care about resilience validation, not just feature testing. Chaos engineering, fault injection, and game days are hallmarks of mature engineering teams.

What you learn: Whether the team proactively tests failures or reactively discovers them in production. A team that runs regular game days is a team that learns before incidents, not during them.

**Question 5: "What is your p99 latency target for the critical path?"**

Why this impresses: Asking about p99 (not average, not p50) shows you understand tail latency. The worst 1% of requests often determines user experience, especially for booking systems where a slow checkout means abandoned carts.

What you learn: Whether the team measures and targets tail latency. If their answer is "we track average response time," they have a latency problem they do not know about yet.

**Question 6: "How large is your on-call rotation, and what is the average time-to-acknowledge for a page?"**

Why this impresses: On-call health is a proxy for engineering culture. A team with a 3-person rotation and 30-minute response times is burned out. A team with an 8-person rotation and 2-minute response times has invested in operational excellence.

What you learn: Whether joining this team means carrying a healthy pager or an overwhelming one. This is a practical question disguised as a technical one.

---

## 5. Chapter Summary Table

The table below maps common interview topics to the chapters in this book where each concept is covered in full detail. Use it to identify your weak areas and revisit the relevant chapters before your interview.

| Interview Topic | Key Concepts | Book Chapters |
|---|---|---|
| Requirements gathering | Functional vs. non-functional requirements, SLOs, capacity estimation | Ch 1-2 (Vision & Requirements), Ch 32 (SLOs & SLIs) |
| High-level architecture | Service decomposition, API Gateway, read/write path separation | Ch 5-6 (Architecture), Ch 8 (API Gateway) |
| Database sharding | Shard key selection, consistent hashing, cross-shard queries, ProxySQL | Ch 10 (MySQL Deep Dive), Ch 35 (Capacity Planning) |
| Caching strategy | Redis Cluster, TTL, invalidation, cache stampede, cache-aside pattern | Ch 13 (Redis Deep Dive), Ch 14 (Caching Strategies) |
| Message queues | Kafka architecture, KRaft, partitioning, consumer groups, exactly-once | Ch 11-12 (Kafka Essentials & Advanced) |
| Preventing double bookings | Distributed locks, fencing tokens, SELECT FOR UPDATE, idempotency keys | Ch 15 (Distributed Locking), Ch 9 (Booking Flow) |
| Saga pattern | Orchestration vs. choreography, compensating actions, state tracking | Ch 19 (Saga Pattern), Ch 18 (Outbox Pattern) |
| Failure handling | Circuit breaker, bulkhead, retry, DLQ, graceful degradation | Ch 21 (Circuit Breaker & Bulkhead), Ch 33 (Incident Response) |
| Multi-region deployment | Regional routing, async replication, MirrorMaker, conflict resolution | Ch 28-29 (Multi-Region), Ch 36 (Deployment) |
| Search at scale | Elasticsearch indexing, query optimization, relevance tuning | Ch 16 (Elasticsearch), Ch 17 (Search Optimization) |
| Financial systems | Double-entry accounting, ledger design, audit trails, reconciliation | Ch 20 (Financial Ledger), Ch 24 (Compliance) |
| Observability | Distributed tracing, metrics, alerting, dashboards, log aggregation | Ch 30-31 (Monitoring & Observability) |
| Testing strategy | Testing pyramid, contract tests, load tests, chaos engineering | Ch 42 (Testing Strategy) |
| API design | REST conventions, versioning, pagination, error codes, OpenAPI | Ch 7 (API Design), Ch 40 (API Documentation) |
| Event contracts | Schema registry, backward/forward compatibility, Avro/Protobuf | Ch 43 (Schema Registry & Event Contracts) |
| Kubernetes & deployment | HPA, rolling updates, canary, blue-green, resource limits | Ch 36-37 (Deployment & Kubernetes) |
| Security | Authentication, authorization, encryption, rate limiting, OWASP | Ch 23 (Security), Ch 8 (API Gateway) |
| Cost optimization | Reserved instances, spot instances, storage tiering, right-sizing | Ch 38 (Cost Optimization) |
| Trade-off articulation | CAP theorem, consistency vs. availability, complexity budgets | Ch 3-4 (Foundations), Ch 39 (Architecture Decisions) |
| Career & communication | Explaining technical decisions, writing design docs, mentoring | Ch 45 (Career Growth), This chapter |

---

## What You Should Do Right Now

Do not wait until the night before your interview to practice this framework. Here is a structured preparation plan.

**Week 1: Internalize the structure.** Set a 45-minute timer and present this system to a wall, a pet, or a rubber duck. Record yourself. Watch the recording. You will cringe at how many filler words you use and how often you lose the thread. That is normal. Do it again.

**Week 2: Practice the deep dives.** Have a friend (or a second rubber duck) randomly pick one of the four deep-dive topics. Present it in 7 minutes. Then switch to a different one. The goal is to be comfortable starting any deep dive on demand, without mental preparation time.

**Week 3: Practice trade-off articulation.** For every design decision in this book, practice saying: "We chose X over Y because Z. The cost is W. We mitigate it with V." If you cannot fill in all five variables for a decision, go back and reread the relevant chapter.

**Week 4: Mock interviews.** Find a partner and alternate roles. When you are the interviewer, your job is to interrupt, ask "why?", and poke holes. When you are the candidate, your job is to stay calm, structured, and honest when you do not know something.

> **Coaching note:** Saying "I do not know" in an interview is not a failure. Saying "I do not know, but here is how I would figure it out" is a signal of intellectual honesty and engineering maturity. Interviewers hire people they want to work with on hard problems. They do not hire people who pretend to know everything. If you are unsure about something, say so, then reason through it out loud. The reasoning is more impressive than the answer.

---

## Key Takeaways

1. **Structure beats brilliance.** A well-structured average answer scores higher than a brilliant but disorganized one. Follow the four-phase framework: Requirements (5 min), Architecture (10 min), Deep Dive (20 min), Trade-offs (10 min).

2. **Start with the read path.** It is 95% of traffic. It is simpler. It shows the interviewer you prioritize what matters. Layer the write path on top.

3. **Separate what you chose from why you chose it.** Describing architecture is junior. Explaining trade-offs is senior. "We chose X over Y because Z" is the sentence pattern of a staff engineer.

4. **Prepare four deep dives, not one.** You cannot predict which component the interviewer will probe. Being deep in one area and shallow in others is worse than being solid in four areas.

5. **Ask questions that demonstrate depth.** Error budget burn rates, schema evolution, cross-shard strategies, failure testing, p99 latency targets. These questions tell the interviewer you have operated systems at scale, not just designed them.

6. **Practice out loud.** System design is a verbal skill. Reading this chapter is not practice. Speaking for 45 minutes to a timer is practice. There is no shortcut.

---

*Next chapter: Chapter 47 --- Building Your Portfolio: Turning This System Into a Career-Defining Project.*
