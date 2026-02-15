# Chapter 11: Inventory Management — Guarding the Last Room

This is the chapter where things get real. Up until now, most patterns we have discussed are about performance and organization — make things faster, keep code clean, separate concerns. Inventory management is different. Get this wrong, and you sell the same hotel room to two families. One of them shows up at midnight with two tired children and has no place to sleep. Your company pays for their alternative accommodation, issues a refund, and eats the reputation damage. A single viral tweet about the experience costs you more than a year of engineering salaries.

This is not hypothetical. It happens to real companies, and it happens because of a bug that takes about six lines of code to write.

> **What If You Skip This?** A double-booked hotel room costs between $200 and $2,000 in direct compensation (alternative hotel, transportation, refund, voucher). At scale, even a 0.01% double-booking rate on 100,000 bookings per minute means 10 double bookings per minute, 600 per hour, 14,400 per day. At $500 average compensation, that is $7.2 million per day in losses — not counting the customers who never come back.

---

## 11.1 The Overselling Problem: Math, Probability, and Real-World Cost

Before we look at code, let us understand the mathematics of why inventory errors become inevitable at scale.

### The Probability Window

The naive check-then-update pattern has a vulnerability window — the gap between reading the inventory count and writing the new count. Let us call this window `w` milliseconds. During `w`, any concurrent request that reads the same row will see stale data.

If your system processes `R` requests per second for a specific resource (say, a popular hotel room on New Year's Eve), and each request holds its read lock for `w` milliseconds, the probability that at least two requests overlap is:

```
P(collision) = 1 - e^(-R * w / 1000)

Example:
  R = 50 requests/second for this specific room
  w = 10ms window between SELECT and UPDATE

  P(collision) = 1 - e^(-50 * 0.01)
               = 1 - e^(-0.5)
               = 1 - 0.607
               = 0.393

  39.3% chance of a race condition PER SECOND.
```

Over the course of a day, the probability of at least one double booking approaches certainty:

```
P(at least one collision in 24 hours) = 1 - (1 - 0.393)^86400
                                      ≈ 1.0 (effectively 100%)
```

> **Key Term:** **Vulnerability window** — The time gap between reading a shared resource and writing an update based on that read. Any concurrent operation that reads during this window will see stale data. The wider the window and the higher the concurrency, the more likely a collision becomes.

### The Cost Cascade

A single double booking triggers a cascade of costs that most teams underestimate:

| Cost Category | Typical Amount | Notes |
|--------------|----------------|-------|
| Alternative accommodation | $150 - $800 | Must be same or better quality, often at last-minute prices |
| Transportation to new hotel | $30 - $100 | Taxi/ride-share at midnight |
| Full refund of original booking | $100 - $500 | You earn zero revenue on this customer |
| Compensation voucher | $50 - $200 | Future discount to retain the customer |
| Customer service agent time | $25 - $50 | 30-60 minutes per incident |
| Reputation damage | Unquantifiable | One-star reviews, social media posts, word of mouth |
| **Total per incident** | **$355 - $1,650** | |

Multiply by the collision rate, and the cost of not solving this problem dwarfs any engineering investment.

> **Production War Story:** In 2019, a mid-sized online travel agency experienced a spike in double bookings during a flash sale. Their system processed 12,000 booking attempts in 3 minutes for a set of 200 discounted rooms. The naive check-then-update code produced 47 double bookings. The total cost: $38,000 in direct compensation, plus three hotels threatening to terminate their partnership agreements. The engineering fix took two developers one week. The business damage took six months to repair.

---

## 11.2 The Naive Approach: Just UPDATE the Count

Let us start with what you would naturally write. You have an `inventory` table:

```sql
CREATE TABLE inventory (
  id BIGINT PRIMARY KEY,
  resource_type VARCHAR(20),   -- 'hotel', 'flight', 'car'
  resource_id BIGINT,          -- which hotel, which flight
  resource_date DATE,          -- which night
  total_quantity SMALLINT,     -- total rooms in the hotel
  available_quantity SMALLINT, -- rooms still available
  reserved_quantity SMALLINT   -- rooms currently held/booked
);
```

And you write a booking endpoint that decrements the count:

```typescript
// The NAIVE approach — DO NOT USE IN PRODUCTION
app.post('/api/book', async (req, res) => {
  const { resourceId, resourceDate } = req.body;

  // Step 1: Check if there is availability
  const [rows] = await db.execute(
    'SELECT available_quantity FROM inventory WHERE resource_id = ? AND resource_date = ?',
    [resourceId, resourceDate]
  );

  if (rows[0].available_quantity <= 0) {
    return res.status(409).json({ error: 'No rooms available' });
  }

  // Step 2: Decrement the count
  await db.execute(
    'UPDATE inventory SET available_quantity = available_quantity - 1 WHERE resource_id = ? AND resource_date = ?',
    [resourceId, resourceDate]
  );

  return res.status(200).json({ message: 'Booked!' });
});
```

This looks correct. Check availability, then update the count. Simple CRUD. You have written code like this a hundred times.

It has a horrifying bug.

### The Race Condition: Two Users, One Room

Imagine the last room is available. Two users click "Book Now" at almost the same instant. Here is what happens, millisecond by millisecond:

```
TIME    USER A                              USER B
----    ------                              ------
0ms     SELECT available_quantity -> 1
1ms                                         SELECT available_quantity -> 1
        (User A has not written yet,        (User B reads the SAME value.
         so the database still says 1)       The room looks available.)

5ms     UPDATE SET available = 0
        (Success! Room booked.)

6ms                                         UPDATE SET available = -1
                                            (Also "succeeds"! Now available
                                             is NEGATIVE. Two bookings for
                                             one room.)

RESULT: Double booking. One family arrives to find their room occupied.
```

> **Key Term:** **Race condition** — A bug that occurs when the outcome of a program depends on the timing of events (like two requests arriving at the same moment). The code is "correct" when run sequentially but breaks when run concurrently. Race conditions are notoriously hard to catch in testing because they only appear under specific timing.

The gap between "read the count" and "update the count" — Steps 1 and 2 in our naive code — is the vulnerability window where the race condition lives. At low traffic, the window is rarely hit. At 100,000 bookings per minute, it is hit constantly.

> **Analogy:** Imagine a parking garage with one spot left. The sign at the entrance says "1 SPOT AVAILABLE." Two cars approach from different streets at the same time. Both drivers see the sign (it still says 1 because neither has parked yet), both drive in, and both try to park in the same spot. One of them is going to have a very bad day. The problem is that the sign (reading the count) and parking the car (changing the count) are separate actions, and another car can sneak in between.

---

## 11.3 Pessimistic vs. Optimistic Locking: Two Schools of Thought

There are two fundamental strategies for preventing race conditions on shared data. Each has tradeoffs, and choosing the wrong one for your workload can be as damaging as having no locking at all.

### Pessimistic Locking: "Lock First, Ask Questions Later"

Pessimistic locking assumes the worst: conflicts are likely, so we lock the resource before reading it. No other transaction can touch the locked row until we release it.

```sql
-- Pessimistic locking with SELECT ... FOR UPDATE
BEGIN;

SELECT available_quantity FROM inventory
  WHERE resource_id = 42 AND resource_date = '2026-03-15'
  FOR UPDATE;              -- Lock this row. Nobody else can read-for-write or write it.

-- ... application checks if available > 0 ...

UPDATE inventory SET available_quantity = available_quantity - 1,
                     reserved_quantity = reserved_quantity + 1
  WHERE resource_id = 42 AND resource_date = '2026-03-15';

COMMIT;                    -- Release the lock.
```

Here is the equivalent using Prisma with an interactive transaction:

```typescript
// Pessimistic locking with Prisma
async function pessimisticBook(resourceId: bigint, resourceDate: Date) {
  return await prisma.$transaction(async (tx) => {
    // Lock the row with FOR UPDATE via raw query
    // (Prisma does not natively support FOR UPDATE in findFirst)
    const [inventory] = await tx.$queryRaw<InventoryRow[]>`
      SELECT available_quantity FROM inventory
      WHERE resource_id = ${resourceId} AND resource_date = ${resourceDate}
      FOR UPDATE
    `;

    if (inventory.available_quantity <= 0) {
      throw new Error('No rooms available');
    }

    // Safe to update — we hold the exclusive lock
    await tx.inventory.update({
      where: {
        resourceId_resourceDate: {
          resource_id: resourceId,
          resource_date: resourceDate,
        },
      },
      data: {
        available_quantity: { decrement: 1 },
        reserved_quantity: { increment: 1 },
      },
    });
  }, {
    isolationLevel: 'Serializable',
    timeout: 5000, // 5 second timeout to prevent deadlocks
  });
}
```

> **Key Term:** **Pessimistic locking** — A concurrency control strategy where a transaction acquires an exclusive lock on a resource before reading or modifying it. Other transactions must wait until the lock is released. It prevents conflicts by serializing access. The tradeoff is reduced throughput under high concurrency.

**When to use pessimistic locking:**

- Low to moderate concurrency on the specific resource (fewer than ~100 concurrent requests per row)
- Short-lived transactions (under 50ms)
- The cost of a conflict is very high (double bookings, financial transactions)
- You need the simplest correct implementation

**The cost of pessimistic locking:** Every booking for the same resource on the same date must go through this lock one at a time. At high concurrency — say, 500 people trying to book the same popular hotel on New Year's Eve — they all queue up, and each one waits for the previous one to finish. Your 5ms operation now takes 500 * 5ms = 2.5 seconds for the last person in line.

### Optimistic Locking: "Try It, Apologize if It Fails"

Optimistic locking assumes the best: conflicts are rare, so we proceed without locking and check for conflicts only at write time. If a conflict is detected, we retry.

```sql
-- Optimistic locking with version column
-- Step 1: Read the current state and its version
SELECT available_quantity, version FROM inventory
  WHERE resource_id = 42 AND resource_date = '2026-03-15';
-- Returns: available_quantity = 5, version = 12

-- Step 2: Update ONLY if the version has not changed
UPDATE inventory
  SET available_quantity = available_quantity - 1,
      reserved_quantity = reserved_quantity + 1,
      version = version + 1
  WHERE resource_id = 42 AND resource_date = '2026-03-15'
  AND version = 12;       -- This fails if someone else updated first

-- Step 3: Check if the update succeeded
-- If affected_rows = 0, someone else modified the row. Retry from Step 1.
```

Here is the Prisma implementation with retry logic:

```typescript
// Optimistic locking with Prisma
async function optimisticBook(
  resourceId: bigint,
  resourceDate: Date,
  maxRetries = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Step 1: Read current state
    const inventory = await prisma.inventory.findUnique({
      where: {
        resourceId_resourceDate: {
          resource_id: resourceId,
          resource_date: resourceDate,
        },
      },
    });

    if (!inventory || inventory.available_quantity <= 0) {
      throw new Error('No rooms available');
    }

    // Step 2: Attempt update with version check
    const updated = await prisma.inventory.updateMany({
      where: {
        resource_id: resourceId,
        resource_date: resourceDate,
        version: inventory.version, // Only succeeds if version unchanged
      },
      data: {
        available_quantity: { decrement: 1 },
        reserved_quantity: { increment: 1 },
        version: { increment: 1 },
      },
    });

    // Step 3: Check if it worked
    if (updated.count > 0) {
      return; // Success
    }

    // Conflict detected — another transaction modified the row
    if (attempt === maxRetries) {
      throw new Error(
        `Optimistic lock failed after ${maxRetries} retries. High contention.`
      );
    }

    // Exponential backoff before retry
    await new Promise((resolve) =>
      setTimeout(resolve, Math.pow(2, attempt) * 10)
    );
  }
}
```

> **Key Term:** **Optimistic locking** — A concurrency control strategy where transactions proceed without holding locks, but check at write time whether the data was modified by another transaction since it was read. If a conflict is detected (the version has changed), the transaction is retried. The tradeoff is retry overhead under high contention.

**When to use optimistic locking:**

- High concurrency but low actual conflict rate (many users, but they are booking different resources)
- Longer-lived transactions where holding a lock would block too many other requests
- Read-heavy workloads where most operations do not modify the data
- Systems where retries are cheap and the user experience tolerates a brief delay

### Head-to-Head Comparison

| Factor | Pessimistic | Optimistic |
|--------|------------|------------|
| Lock acquisition | Before read | None (version check at write) |
| Throughput at low contention | Good | Excellent |
| Throughput at high contention | Degrades linearly | Degrades exponentially (retry storms) |
| Deadlock risk | Yes (two transactions lock rows in different order) | No |
| Starvation risk | Yes (long-running transactions block others) | Yes (unlucky transactions keep retrying) |
| Implementation complexity | Low | Medium (retry logic, backoff) |
| Best for inventory at 100K/min | Single hot rows | Distributed across many rows |

> **Common Mistake:** Teams often choose optimistic locking because it "sounds faster" without measuring their actual contention rate. If 200 users are fighting over the same last room, optimistic locking produces a retry storm: 199 of them fail, retry, fail again, retry again. The system does 3x the work for the same result. For hot inventory rows, pessimistic locking with short transactions is faster in practice.

### Our Choice: Pessimistic Locking with Atomic WHERE Clauses

For the Global Booking System, we use a hybrid approach: pessimistic locking via `SELECT ... FOR UPDATE` for hold operations, combined with atomic `WHERE` clauses that make the UPDATE itself conditional. This gives us the correctness of pessimistic locking without the full serialization penalty, because the actual critical section (the UPDATE) is a single atomic statement that the database executes in microseconds.

```sql
-- Our approach: atomic conditional UPDATE inside a pessimistic transaction
BEGIN;
UPDATE inventory
SET reserved_quantity = reserved_quantity + 1,
    available_quantity = available_quantity - 1,
    fencing_token = @new_token, updated_at = NOW()
WHERE resource_type = 'hotel' AND resource_id = 42 AND resource_date = '2026-03-15'
AND available_quantity >= 1
AND (fencing_token IS NULL OR fencing_token < @new_token);
-- If affected_rows = 0, either no inventory or stale token. Reject.
COMMIT;
```

The database handles the lock internally for the duration of the single UPDATE statement. We do not hold the lock across application logic, network calls, or user think time. This is the sweet spot: correctness without unnecessary serialization.

> **Why Not Pure Optimistic Locking?** At 100,000 bookings per minute, hot resources (popular hotels on peak dates) see hundreds of concurrent requests. Pure optimistic locking on these rows would produce retry storms that waste CPU, increase latency, and can cascade into timeouts. Our atomic WHERE clause approach achieves the same correctness without retries — the database resolves the conflict in a single round trip.

---

## 11.4 Fencing Tokens Deep-Dive: Why Distributed Locks Alone Are Not Enough

Most teams reach for a distributed lock (Redis, ZooKeeper, etcd) the moment they encounter a concurrency problem. "Just lock it" feels intuitive. But distributed locks have a subtle failure mode that can silently corrupt your data — even when the lock implementation is correct.

### The GC Pause Problem

Here is the scenario that breaks distributed locks:

```
TIME    SERVICE INSTANCE A            SERVICE INSTANCE B        REDIS LOCK
----    --------------------          --------------------      ----------
0ms     Acquires lock (TTL=30s)                                Locked by A
                                                                expires in 30s

...     A starts processing.
        A reads inventory: 5 available.

15s     A's JVM/Node enters a long     B tries to acquire lock. Locked by A
        garbage collection pause.       Blocked. Waits.

31s     A is STILL paused.                                      Lock EXPIRED
        (A does not know the lock                                (TTL elapsed)
         expired. It has no heartbeat
         during GC.)

32s                                     B acquires lock.         Locked by B
                                        B reads inventory: 5.
                                        B decrements: 4.
                                        B releases lock.         Unlocked

45s     A wakes up from GC pause.
        A does not know the lock
        expired. A still thinks it
        has the lock.
        A decrements based on its
        STALE read: sets available = 4.
        But B already set it to 4!
        The true value should be 3.
        ONE ROOM OVERSOLD.
```

> **Analogy:** You walk into a busy deli. There is a ticket machine at the door. You pull a ticket: number 47. The person before you has ticket 46. The rule is simple: the counter only serves ticket numbers that are higher than the last one served. If someone walks up with ticket 43 (an old ticket, maybe they went to the bathroom and came back), the counter says "sorry, we have already moved past 43." The ticket number always increases, and old tickets are always rejected.

This is not a bug in the lock. The lock worked perfectly — it expired after its TTL, and another client legitimately acquired it. The bug is that the first client did not know it lost the lock. In a distributed system, there is no reliable way to guarantee that a client with a lock will always know when the lock expires.

### The Fencing Token Solution

A fencing token is a monotonically increasing number attached to every inventory operation. The resource (the database) only accepts operations whose token is strictly higher than the last one it processed:

```
TIME    OPERATION                              FENCING TOKEN
----    ---------                              -------------
0ms     Instance A creates hold. Token = 47.   Stored: 47
200ms   Instance B creates hold. Token = 48.   Stored: 48
300ms   Delayed operation from A. Token = 47.  REJECTED (47 < 48)
        The stale write is harmless.
```

> **Key Term:** **Fencing token** — A monotonically increasing number assigned to each operation on a shared resource. The resource only accepts operations with a token higher than the last one it processed. This prevents stale or delayed operations from corrupting the current state. The name comes from "fencing off" old operations.

### Generating Fencing Tokens

The token generator must guarantee three properties: (1) monotonically increasing, (2) unique, (3) available under high concurrency. Here are two approaches:

**Approach 1: Database sequence (simple, centralized)**

```sql
-- Dedicated fencing token table
CREATE TABLE fencing_token_sequences (
  resource_key VARCHAR(100) PRIMARY KEY,  -- e.g., 'hotel:42:2026-03-15'
  current_token BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

```typescript
// Get next fencing token — atomically increment and return
async function getNextFencingToken(
  resourceType: string,
  resourceId: bigint,
  resourceDate: Date
): Promise<bigint> {
  const resourceKey = `${resourceType}:${resourceId}:${resourceDate.toISOString().split('T')[0]}`;

  const [result] = await db.execute(`
    INSERT INTO fencing_token_sequences (resource_key, current_token)
    VALUES (?, 1)
    ON DUPLICATE KEY UPDATE current_token = current_token + 1
  `, [resourceKey]);

  const [row] = await db.execute(
    'SELECT current_token FROM fencing_token_sequences WHERE resource_key = ?',
    [resourceKey]
  );

  return row[0].current_token;
}
```

Prisma equivalent:

```typescript
// Prisma: Get next fencing token
async function getNextFencingToken(resourceKey: string): Promise<bigint> {
  const result = await prisma.fencingTokenSequence.upsert({
    where: { resource_key: resourceKey },
    update: { current_token: { increment: 1 } },
    create: { resource_key: resourceKey, current_token: BigInt(1) },
  });
  return result.current_token;
}
```

**Approach 2: Redis INCR (fast, distributed)**

```typescript
// Redis-based fencing token — faster, no DB round-trip
async function getNextFencingTokenRedis(
  resourceType: string,
  resourceId: bigint,
  resourceDate: Date
): Promise<number> {
  const key = `fencing:${resourceType}:${resourceId}:${resourceDate.toISOString().split('T')[0]}`;
  // INCR is atomic in Redis. It returns the new value.
  // If the key does not exist, Redis creates it with value 0, then increments to 1.
  return await redis.incr(key);
}
```

> **Common Mistake:** Some teams use timestamps as fencing tokens. This breaks under clock skew — if Instance A's clock is 2 seconds ahead of Instance B's, then B's operations can have lower timestamps than A's even when B runs later. Use a counter, not a clock.

### The Critical Line That Enforces Fencing

This is the SQL statement that makes fencing tokens effective. Read it carefully:

```sql
UPDATE inventory
SET reserved_quantity = reserved_quantity + @quantity,
    available_quantity = available_quantity - @quantity,
    fencing_token = @new_token, updated_at = NOW()
WHERE resource_type = @type AND resource_id = @id AND resource_date = @date
AND available_quantity >= @quantity
AND (fencing_token IS NULL OR fencing_token < @new_token)
--                                          ^^^
-- This condition rejects any operation whose token is not
-- strictly greater than the currently stored token.
```

If the `UPDATE` affects zero rows, it means either there is not enough inventory (`available_quantity < requested`) or the fencing token is stale (`fencing_token >= new_token`). Either way, the operation is correctly rejected. No double booking. No silent corruption.

> **Checkpoint:** Before continuing, make sure you can answer: (1) Why can a distributed lock alone not prevent double bookings? (2) What property must a fencing token have to work correctly? (3) Why are timestamps unsafe as fencing tokens?

---

## 11.5 The Hold Pattern: Reserve First, Confirm Later

Instead of immediately decrementing inventory with a "book" call, we split the process into two phases:

1. **Create a Hold** — temporarily reserve the inventory. The hold has a time limit (TTL). If the booking is not confirmed within that window, the hold automatically expires and the inventory goes back to the pool.
2. **Confirm the Hold** — once payment succeeds, convert the hold into a permanent booking.

> **Analogy:** Think of shopping online. When you add an item to your cart, the store does not immediately charge you. Instead, it places a temporary hold on that item so nobody else can buy it while you are entering your credit card details. If you abandon your cart and walk away, the hold expires after 10 minutes, and the item goes back on the shelf. That is exactly what our hold pattern does with hotel rooms.

This pattern gives us three critical properties:

1. **No double bookings.** The hold atomically decrements the available count. Two users cannot hold the same last room.
2. **No stuck inventory.** If a user abandons the booking flow, the TTL ensures the room goes back to the pool automatically.
3. **Separation of concerns.** The Inventory Service handles holds. The Booking Service handles payment. They do not need to know each other's internals.

---

## 11.6 Inventory Hold State Machine: Full Implementation

Every hold moves through a defined set of states. There are no surprise transitions — the rules are explicit and enforced at the database level.

```
                 +--------+
                 | (none) |
                 +---+----+
                     |
                  createHold()
                     |
                 +---v----+
            +--->| active |<----+
            |    +---+----+     |
            |        |          |
       extendTTL()   |    (hold still valid)
            |        |
            +--------+----------+----------+----------+
                     |          |          |          |
                confirm()   expire()   release()   cancel()
                     |          |          |          |
              +------v--+  +---v----+  +--v-------+  +--v-------+
              |confirmed|  |expired |  |released  |  |cancelled |
              +---------+  +--------+  +----------+  +----------+
```

> **Key Term:** **State machine** — A model where an entity (like a hold) has a defined set of states and a defined set of transitions between them. A hold can go from `active` to `confirmed`, but it can never go from `expired` to `active`. The state machine makes invalid transitions impossible by design, not by accident.

### State Definitions

| State | Meaning | Entry Trigger | Inventory Effect |
|-------|---------|--------------|-----------------|
| **active** | Room is temporarily reserved | `createHold()` called | `available_quantity` decreased, `reserved_quantity` increased |
| **confirmed** | Booking is final, payment succeeded | `confirmHold()` called | Inventory stays decremented (the room is really booked) |
| **expired** | User did not complete booking in time | TTL ran out, cleanup job ran | `available_quantity` restored, `reserved_quantity` decreased |
| **released** | User or system explicitly cancelled | `releaseHold()` called | `available_quantity` restored, `reserved_quantity` decreased |
| **cancelled** | Business logic cancelled the hold | Saga compensation triggered | `available_quantity` restored, `reserved_quantity` decreased |

Notice three of the four terminal states (expired, released, cancelled) **restore inventory**. Only `confirmed` keeps the room booked. This means inventory cannot leak — every room held will eventually either become a booking or return to the pool.

### Transition Validation Matrix

Which transitions are legal? This matrix is the law:

```
FROM \ TO      | active  | confirmed | expired | released | cancelled
-------------- |---------|-----------|---------|----------|-----------
(none)         |   YES   |    no     |   no    |    no    |    no
active         |   YES*  |   YES     |  YES    |   YES    |   YES
confirmed      |    no   |    no     |   no    |    no    |    no
expired        |    no   |    no     |   no    |    no    |    no
released       |    no   |    no     |   no    |    no    |    no
cancelled      |    no   |    no     |   no    |    no    |    no

* active -> active = extending the TTL (same state, updated expiry)
```

All terminal states (confirmed, expired, released, cancelled) are absorbing — once a hold reaches one, it never changes again. This is enforced in the database:

```typescript
// State machine transition validator
const VALID_TRANSITIONS: Record<string, string[]> = {
  none: ['active'],
  active: ['active', 'confirmed', 'expired', 'released', 'cancelled'],
  confirmed: [],
  expired: [],
  released: [],
  cancelled: [],
};

function validateTransition(from: string, to: string): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidHoldStateError(
      `Invalid transition: ${from} -> ${to}. ` +
      `Allowed transitions from '${from}': [${allowed?.join(', ') || 'none'}]`
    );
  }
}
```

> **What If You Skip This?** Without a state machine, your hold statuses are just strings — and developers will set them to whatever seems right in the moment. You end up with holds stuck in "pending" forever, inventory that is held but never confirmed or released, and ghost rooms that no one can book because they are reserved by an abandoned session. The state machine prevents all of this by making invalid transitions impossible.

---

## 11.7 Hold Expiration: Background Job with Dead Letter Handling

What happens to holds that nobody confirms or releases? The user closed their browser tab, their phone died, or they just got distracted. Those holds are sitting in the `active` state, blocking inventory that nobody is going to book. We need a cleanup process — and that cleanup process itself must be bulletproof.

### The Expiration Job

The system runs a stored procedure **every 30 seconds** that finds all expired holds and restores their inventory:

```sql
DELIMITER //

CREATE PROCEDURE release_expired_holds()
BEGIN
    DECLARE v_expired_count INT DEFAULT 0;

    -- Step 1: Collect all expired holds into a temp table.
    -- FOR UPDATE locks these rows so that a concurrent confirmHold()
    -- cannot confirm a hold while we are expiring it.
    CREATE TEMPORARY TABLE IF NOT EXISTS temp_expired_holds (
        hold_id BIGINT, resource_type VARCHAR(20),
        resource_id BIGINT, resource_date DATE,
        quantity SMALLINT, fencing_token BIGINT
    );

    TRUNCATE TABLE temp_expired_holds;

    START TRANSACTION;

    INSERT INTO temp_expired_holds
    SELECT id, resource_type, resource_id, resource_date, quantity, fencing_token
    FROM inventory_holds
    WHERE status = 'active' AND expires_at < NOW()
    FOR UPDATE;

    -- Step 2: Mark all expired holds as 'expired'.
    UPDATE inventory_holds
    SET status = 'expired', released_at = NOW(), released_by = 'system_cron'
    WHERE id IN (SELECT hold_id FROM temp_expired_holds);

    SET v_expired_count = ROW_COUNT();

    -- Step 3: Restore inventory for each expired hold.
    -- The fencing token check ensures we only restore inventory
    -- if no newer operation has already modified it.
    UPDATE inventory i
    INNER JOIN temp_expired_holds h ON
        i.resource_type = h.resource_type AND
        i.resource_id = h.resource_id AND
        i.resource_date = h.resource_date
    SET i.reserved_quantity = i.reserved_quantity - h.quantity,
        i.available_quantity = i.available_quantity + h.quantity,
        i.updated_at = NOW()
    WHERE i.fencing_token <= h.fencing_token;

    -- Step 4: Record the transition for every expired hold.
    INSERT INTO inventory_hold_transitions
      (hold_id, from_status, to_status, transition_reason, transitioned_by)
    SELECT hold_id, 'active', 'expired',
           'Automatic expiry by cron job', 'system_cron'
    FROM temp_expired_holds;

    COMMIT;

    DROP TEMPORARY TABLE IF EXISTS temp_expired_holds;

    SELECT v_expired_count as expired_holds, NOW() as processed_at;
END//

DELIMITER ;

-- Schedule it to run every 30 seconds automatically.
CREATE EVENT release_expired_holds_event
ON SCHEDULE EVERY 30 SECOND
DO CALL release_expired_holds();
```

The `FOR UPDATE` in Step 1 is crucial. It prevents a timing hazard: without it, a user could confirm their hold at the exact moment the cleanup job is expiring it. The lock ensures only one of them wins. Either the user confirms in time (the cleanup job waits and then sees the hold is no longer `active`), or the cleanup job expires it first (the user's `confirmHold()` fails with "hold is not active or has expired" and they must restart the booking flow).

### The Prisma-Based Expiration Job

For teams using Prisma, here is the same logic as an application-level cron job:

```typescript
// hold-expiration.job.ts — runs every 30 seconds via node-cron or BullMQ
import { PrismaClient, HoldStatus } from '@prisma/client';

const prisma = new PrismaClient();

export async function expireHoldsJob(): Promise<number> {
  const now = new Date();

  // Use an interactive transaction for atomicity
  return await prisma.$transaction(async (tx) => {
    // Step 1: Find expired holds and lock them
    const expiredHolds = await tx.$queryRaw<Array<{
      id: bigint;
      resource_type: string;
      resource_id: bigint;
      resource_date: Date;
      quantity: number;
      fencing_token: bigint;
    }>>`
      SELECT id, resource_type, resource_id, resource_date, quantity, fencing_token
      FROM inventory_holds
      WHERE status = 'active' AND expires_at < ${now}
      FOR UPDATE
    `;

    if (expiredHolds.length === 0) return 0;

    const holdIds = expiredHolds.map((h) => h.id);

    // Step 2: Mark as expired
    await tx.inventoryHold.updateMany({
      where: { id: { in: holdIds } },
      data: {
        status: HoldStatus.EXPIRED,
        released_at: now,
        released_by: 'system_cron',
      },
    });

    // Step 3: Restore inventory for each hold
    for (const hold of expiredHolds) {
      await tx.inventory.updateMany({
        where: {
          resource_type: hold.resource_type,
          resource_id: hold.resource_id,
          resource_date: hold.resource_date,
        },
        data: {
          available_quantity: { increment: hold.quantity },
          reserved_quantity: { decrement: hold.quantity },
          updated_at: now,
        },
      });
    }

    // Step 4: Log transitions
    await tx.inventoryHoldTransition.createMany({
      data: holdIds.map((holdId) => ({
        hold_id: holdId,
        from_status: 'active',
        to_status: 'expired',
        transition_reason: 'Automatic expiry by cron job',
        transitioned_by: 'system_cron',
      })),
    });

    return expiredHolds.length;
  }, {
    timeout: 30000,  // 30 second timeout for the transaction
  });
}
```

### Dead Letter Handling: When Expiration Fails

What if the expiration job itself fails? The database might be temporarily unavailable, the transaction might time out under heavy load, or a bug might cause an uncaught exception. Those holds remain `active` past their TTL, silently blocking inventory.

We solve this with a **dead letter queue** pattern — a secondary process that catches expiration failures and retries them with increasing delay:

```typescript
// dead-letter-expiration.service.ts
import { Queue, Worker } from 'bullmq';

// Queue for holds that failed normal expiration
const deadLetterQueue = new Queue('hold-expiration-dlq', {
  connection: { host: 'redis', port: 6379 },
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 5000,  // 5s, 10s, 20s, 40s, 80s
    },
    removeOnComplete: 100,
    removeOnFail: 1000,
  },
});

// When the main expiration job fails, enqueue affected holds
export async function handleExpirationFailure(
  failedHoldIds: bigint[],
  error: Error
): Promise<void> {
  for (const holdId of failedHoldIds) {
    await deadLetterQueue.add('retry-expire-hold', {
      holdId: holdId.toString(),
      originalError: error.message,
      failedAt: new Date().toISOString(),
    });
  }

  // Alert the on-call team
  await alerting.send({
    severity: 'warning',
    title: `Hold expiration failed for ${failedHoldIds.length} holds`,
    description: `Error: ${error.message}. Holds enqueued to DLQ for retry.`,
    runbook: 'https://runbooks.internal/inventory/hold-expiration-failure',
  });
}

// Worker that processes the dead letter queue
const dlqWorker = new Worker('hold-expiration-dlq', async (job) => {
  const { holdId } = job.data;

  const hold = await prisma.inventoryHold.findUnique({
    where: { id: BigInt(holdId) },
  });

  if (!hold) {
    // Hold was deleted — nothing to do
    return;
  }

  if (hold.status !== 'active') {
    // Hold was already processed (confirmed, released, etc.) — nothing to do
    return;
  }

  if (hold.expires_at > new Date()) {
    // Hold is not actually expired yet — skip
    return;
  }

  // Try to expire it again
  await expireSingleHold(BigInt(holdId));
}, {
  connection: { host: 'redis', port: 6379 },
  concurrency: 5,
});

// After all retries are exhausted, the hold goes to a "stuck holds" report
dlqWorker.on('failed', async (job, error) => {
  if (job && job.attemptsMade >= 5) {
    await alerting.send({
      severity: 'critical',
      title: `Hold ${job.data.holdId} stuck after 5 retry attempts`,
      description: `This hold has been active past its TTL and could not be expired. ` +
                   `Manual intervention required. Error: ${error.message}`,
      runbook: 'https://runbooks.internal/inventory/stuck-hold-manual-fix',
    });
  }
});
```

> **Key Term:** **Dead letter queue (DLQ)** — A queue where messages (or jobs) are sent when they cannot be processed successfully after a configured number of retries. The DLQ serves as a safety net: nothing is silently lost. A separate process or a human operator can inspect the DLQ and decide how to handle the failed items.

> **Production War Story:** A fintech travel startup ran their hold expiration as a simple `setInterval()` in their Node.js process. One night, a database failover caused the connection pool to reset. The `setInterval` callback threw an unhandled exception, and Node's default behavior swallowed it — the interval kept firing, kept failing, and kept swallowing the error. By morning, 2,400 holds had expired without inventory restoration. Their hotel showed zero availability for the entire next week. The fix: replace `setInterval` with BullMQ (which has built-in retry, DLQ, and alerting), and add a monitoring query that alerts when `COUNT(*) WHERE status = 'active' AND expires_at < NOW() - INTERVAL 5 MINUTE` exceeds zero.

---

## 11.8 Overbooking Policies: Airline-Style Deliberate Overbooking

You might be surprised to learn that some overbooking is intentional. Airlines have done it for decades. The logic is statistical: a predictable percentage of passengers do not show up for their flights. If an airline has 200 seats and a 10% no-show rate, selling 220 tickets means approximately 200 people actually board. The airline fills every seat instead of flying with 20 empty ones.

### The Economics of Overbooking

Consider a 200-seat economy flight at $300 per seat:

```
WITHOUT overbooking:
  Revenue = 200 seats * $300 = $60,000
  Average no-shows: 20 passengers (10%)
  Empty seats: 20
  Lost revenue: 20 * $300 = $6,000 per flight

WITH 10% overbooking:
  Tickets sold: 220
  Revenue = 220 * $300 = $66,000
  Average actual passengers: 198 (10% no-show of 220)
  Usually fits in 200 seats. No problem.

  But 5% of the time, all 220 show up.
  Must bump 20 passengers.
  Compensation: 20 * $400 voluntary = $8,000
  Net impact on those flights: $66,000 - $8,000 = $58,000
  Still better than $54,000 from the no-overbook scenario.

  Expected annual value (1 flight/day):
  Without: 365 * $54,000 = $19.7M
  With:    365 * (0.95 * $66,000 + 0.05 * $58,000) = $24.0M
  DELTA:   $4.3M additional revenue per route per year.
```

> **Analogy:** Overbooking is like a restaurant taking 22 reservations for 20 tables, knowing from experience that about 2 parties will no-show every night. It maximizes revenue when the prediction is right. When it is wrong (all 22 show up), the restaurant has a compensation plan ready: free drinks, a voucher for next time, or a nearby partner restaurant.

### Configurable Overbooking Policies

Our system supports configurable overbooking policies per resource type and class. The policy is a **business decision**, not a technical one. The engineering team builds the system to support configurable limits. The business team decides the actual percentages:

```typescript
// overbooking-policies.ts — configurable per resource type and class
export interface OverbookingPolicy {
  maxOverbookingRate: number;   // 0.10 = allow 10% overbooking
  compensationRules: CompensationRules;
  autoAdjust: boolean;          // Adjust rate based on historical no-show data
  minHistoricalDataDays: number; // Need N days of data before enabling auto-adjust
}

export interface CompensationRules {
  voluntaryAmount?: number;    // Cash offered to volunteers
  involuntaryAmount?: number;  // Cash paid if bumped involuntarily
  upgradeFirst?: boolean;      // Try upgrading before paying cash
  alternativeProperty?: boolean; // Book at a partner property
  refundMultiplier?: number;    // 1.5 = refund 150% of booking price
}

export const overbookingPolicies: Record<string, Record<string, OverbookingPolicy>> = {
  flight: {
    economy: {
      maxOverbookingRate: 0.10,
      compensationRules: {
        voluntaryAmount: 400,
        involuntaryAmount: 800,
        upgradeFirst: true,     // Try to move bumped pax to business class
      },
      autoAdjust: true,
      minHistoricalDataDays: 90,
    },
    business: {
      maxOverbookingRate: 0.05,
      compensationRules: {
        voluntaryAmount: 800,
        involuntaryAmount: 1600,
        upgradeFirst: true,     // Upgrade to first class if available
      },
      autoAdjust: true,
      minHistoricalDataDays: 90,
    },
    first: {
      maxOverbookingRate: 0.00,  // ZERO overbooking for first class
      compensationRules: {},
      autoAdjust: false,
      minHistoricalDataDays: 0,
    },
  },
  hotel: {
    standard: {
      maxOverbookingRate: 0.02,
      compensationRules: {
        upgradeFirst: true,          // Upgrade within the hotel
        alternativeProperty: true,   // Book at a partner hotel
        refundMultiplier: 1.5,       // Pay 1.5x the room rate as compensation
      },
      autoAdjust: true,
      minHistoricalDataDays: 180,    // Hotels need more data (seasonal patterns)
    },
    premium: {
      maxOverbookingRate: 0.00,      // No overbooking for premium/suite rooms
      compensationRules: {},
      autoAdjust: false,
      minHistoricalDataDays: 0,
    },
  },
  car: {
    standard: {
      maxOverbookingRate: 0.00,
      compensationRules: {
        upgradeFirst: true,          // Upgrade from compact to midsize
        refundMultiplier: 2.0,       // Pay 2x the daily rate
      },
      autoAdjust: false,
      minHistoricalDataDays: 0,
    },
  },
};
```

### Calculating Effective Capacity

The overbooking policy adjusts the effective capacity used in availability checks:

```typescript
// Calculate how many units can be sold for a given resource
function getEffectiveCapacity(
  totalQuantity: number,
  resourceType: string,
  resourceClass: string
): number {
  const policy = overbookingPolicies[resourceType]?.[resourceClass];
  if (!policy) return totalQuantity;

  const overbookingRate = policy.maxOverbookingRate;
  return Math.floor(totalQuantity * (1 + overbookingRate));
  // 200 seats * 1.10 = 220 effective capacity
}
```

Prisma schema for storing overbooking configuration:

```prisma
model OverbookingPolicy {
  id              Int      @id @default(autoincrement())
  resource_type   String   @db.VarChar(20)
  resource_class  String   @db.VarChar(30)
  max_rate        Decimal  @db.Decimal(4, 3)  // e.g., 0.100 = 10%
  voluntary_comp  Decimal? @db.Decimal(10, 2)
  involuntary_comp Decimal? @db.Decimal(10, 2)
  upgrade_first   Boolean  @default(false)
  alt_property    Boolean  @default(false)
  refund_multiplier Decimal? @db.Decimal(3, 1)
  auto_adjust     Boolean  @default(false)
  is_active       Boolean  @default(true)
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  @@unique([resource_type, resource_class])
  @@map("overbooking_policies")
}
```

The `available_quantity` check in `createHold()` uses effective capacity rather than the raw total. This is a one-line change in the business logic — the entire hold/confirm/release mechanism works identically whether overbooking is enabled or not.

> **Common Mistake:** Teams sometimes apply overbooking at the hold creation stage, allowing more holds than physical capacity. This is wrong. Overbooking should be applied at the **confirmed booking** level. You should never allow more active holds than physical capacity — holds represent real users actively in the booking flow. Overbooking accounts for the statistical likelihood that some confirmed bookings will result in no-shows.

> **Why Not Unlimited Overbooking?** In 2017, United Airlines forcibly removed a passenger from an overbooked flight. The incident went viral, the stock dropped $1.4 billion in market value, and the CEO had to publicly apologize. Overbooking is a precise statistical tool. The moment you treat it as "just sell more," you cross from optimization into liability. Our system enforces hard caps per resource class and requires explicit business approval to change them.

---

## 11.9 Full Database Schema: CREATE TABLE + Prisma

Every table the Inventory module depends on, with indexes, constraints, and comments explaining each column.

### SQL: Complete CREATE TABLE Statements

```sql
-- ============================================
-- INVENTORY TABLES — Complete Schema
-- ============================================

-- 1. Core inventory table: one row per resource per date
CREATE TABLE inventory (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  resource_type       VARCHAR(20) NOT NULL,       -- 'hotel', 'flight', 'car'
  resource_id         BIGINT NOT NULL,             -- FK to the specific resource
  resource_date       DATE NOT NULL,               -- which date this inventory covers
  resource_class      VARCHAR(30) DEFAULT 'standard', -- 'economy', 'business', 'premium'
  total_quantity      SMALLINT NOT NULL,            -- physical capacity (never changes)
  available_quantity  SMALLINT NOT NULL,            -- units available for new holds
  reserved_quantity   SMALLINT NOT NULL DEFAULT 0,  -- units currently held or booked
  confirmed_quantity  SMALLINT NOT NULL DEFAULT 0,  -- units with confirmed bookings
  fencing_token       BIGINT DEFAULT NULL,          -- monotonically increasing operation token
  version             INT NOT NULL DEFAULT 0,       -- optimistic locking version
  region              VARCHAR(10) DEFAULT 'us-east-1', -- deployment region
  is_active           BOOLEAN DEFAULT TRUE,         -- soft-delete flag
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Composite unique: one inventory record per resource per date
  UNIQUE KEY uk_resource_date (resource_type, resource_id, resource_date),

  -- Query patterns
  INDEX idx_available (resource_type, resource_date, available_quantity),
  INDEX idx_resource_lookup (resource_id, resource_date),
  INDEX idx_fencing (resource_type, resource_id, resource_date, fencing_token),

  -- Constraints
  CONSTRAINT chk_available CHECK (available_quantity >= 0 OR available_quantity >= -5),
  -- Note: available_quantity can go slightly negative with overbooking.
  -- The -5 floor prevents catastrophic overbooking bugs.
  CONSTRAINT chk_reserved CHECK (reserved_quantity >= 0),
  CONSTRAINT chk_balance CHECK (
    available_quantity + reserved_quantity + confirmed_quantity <= total_quantity * 1.15
  )
  -- Balance check: total of all buckets should not exceed 115% of physical capacity
  -- (15% buffer allows for overbooking + temporary accounting drift)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Inventory holds: temporary reservations
CREATE TABLE inventory_holds (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  hold_uuid         CHAR(36) NOT NULL UNIQUE,       -- UUID v4 for external reference
  resource_type     VARCHAR(20) NOT NULL,
  resource_id       BIGINT NOT NULL,
  resource_date     DATE NOT NULL,
  quantity          SMALLINT NOT NULL DEFAULT 1,
  user_id           BIGINT NOT NULL,
  session_id        VARCHAR(64) NOT NULL,            -- browser session for idempotency
  booking_id        BIGINT DEFAULT NULL,             -- set when confirmed
  fencing_token     BIGINT NOT NULL,
  region            VARCHAR(10) DEFAULT 'us-east-1',
  status            ENUM('active','confirmed','expired','released','cancelled')
                    NOT NULL DEFAULT 'active',
  hold_reason       VARCHAR(50) DEFAULT 'user_booking', -- 'user_booking', 'admin_block', 'maintenance'
  expires_at        TIMESTAMP NOT NULL,
  confirmed_at      TIMESTAMP NULL,
  released_at       TIMESTAMP NULL,
  released_by       VARCHAR(100) NULL,               -- 'user:123', 'saga:456', 'system_cron'
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- Idempotency: one active hold per user per resource per date
  UNIQUE KEY uk_user_active_hold (
    user_id, session_id, resource_type, resource_id, resource_date, status
  ),

  -- Finding expired holds (cleanup job)
  INDEX idx_expired (status, expires_at),

  -- Lookup by booking
  INDEX idx_booking (booking_id),

  -- Timeline queries
  INDEX idx_resource_timeline (resource_type, resource_id, resource_date, created_at),

  -- Foreign keys
  INDEX idx_user (user_id),
  INDEX idx_fencing_token (fencing_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Transition audit log
CREATE TABLE inventory_hold_transitions (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  hold_id             BIGINT NOT NULL,
  from_status         VARCHAR(20) NOT NULL,
  to_status           VARCHAR(20) NOT NULL,
  transition_reason   VARCHAR(255),
  transitioned_by     VARCHAR(100) NOT NULL,         -- 'user:123', 'system_cron', 'saga:456'
  metadata            JSON DEFAULT NULL,             -- extra context (error messages, etc.)
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_hold (hold_id),
  INDEX idx_created (created_at),
  FOREIGN KEY (hold_id) REFERENCES inventory_holds(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Fencing token sequences
CREATE TABLE fencing_token_sequences (
  resource_key    VARCHAR(100) PRIMARY KEY,
  current_token   BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Overbooking policies (database-driven configuration)
CREATE TABLE overbooking_policies (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  resource_type     VARCHAR(20) NOT NULL,
  resource_class    VARCHAR(30) NOT NULL,
  max_rate          DECIMAL(4,3) NOT NULL DEFAULT 0.000,
  voluntary_comp    DECIMAL(10,2) DEFAULT NULL,
  involuntary_comp  DECIMAL(10,2) DEFAULT NULL,
  upgrade_first     BOOLEAN DEFAULT FALSE,
  alt_property      BOOLEAN DEFAULT FALSE,
  refund_multiplier DECIMAL(3,1) DEFAULT NULL,
  auto_adjust       BOOLEAN DEFAULT FALSE,
  is_active         BOOLEAN DEFAULT TRUE,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uk_type_class (resource_type, resource_class)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Inventory reconciliation log
CREATE TABLE inventory_reconciliation_log (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  resource_type       VARCHAR(20) NOT NULL,
  resource_id         BIGINT NOT NULL,
  resource_date       DATE NOT NULL,
  expected_available  SMALLINT NOT NULL,
  actual_available    SMALLINT NOT NULL,
  drift_amount        SMALLINT NOT NULL,             -- actual - expected
  corrected           BOOLEAN DEFAULT FALSE,
  corrected_at        TIMESTAMP NULL,
  corrected_by        VARCHAR(100) NULL,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_drift (drift_amount),
  INDEX idx_resource (resource_type, resource_id, resource_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Prisma Schema: Complete Model Definitions

```prisma
// schema.prisma — Inventory module models

enum HoldStatus {
  active
  confirmed
  expired
  released
  cancelled
}

model Inventory {
  id                  BigInt    @id @default(autoincrement())
  resource_type       String    @db.VarChar(20)
  resource_id         BigInt
  resource_date       DateTime  @db.Date
  resource_class      String    @default("standard") @db.VarChar(30)
  total_quantity      Int       @db.SmallInt
  available_quantity  Int       @db.SmallInt
  reserved_quantity   Int       @default(0) @db.SmallInt
  confirmed_quantity  Int       @default(0) @db.SmallInt
  fencing_token       BigInt?
  version             Int       @default(0)
  region              String    @default("us-east-1") @db.VarChar(10)
  is_active           Boolean   @default(true)
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt

  @@unique([resource_type, resource_id, resource_date], name: "uk_resource_date")
  @@index([resource_type, resource_date, available_quantity], name: "idx_available")
  @@index([resource_id, resource_date], name: "idx_resource_lookup")
  @@map("inventory")
}

model InventoryHold {
  id              BigInt      @id @default(autoincrement())
  hold_uuid       String      @unique @db.Char(36)
  resource_type   String      @db.VarChar(20)
  resource_id     BigInt
  resource_date   DateTime    @db.Date
  quantity        Int         @default(1) @db.SmallInt
  user_id         BigInt
  session_id      String      @db.VarChar(64)
  booking_id      BigInt?
  fencing_token   BigInt
  region          String      @default("us-east-1") @db.VarChar(10)
  status          HoldStatus  @default(active)
  hold_reason     String      @default("user_booking") @db.VarChar(50)
  expires_at      DateTime
  confirmed_at    DateTime?
  released_at     DateTime?
  released_by     String?     @db.VarChar(100)
  created_at      DateTime    @default(now())
  updated_at      DateTime    @updatedAt

  transitions     InventoryHoldTransition[]

  @@index([status, expires_at], name: "idx_expired")
  @@index([booking_id], name: "idx_booking")
  @@index([user_id], name: "idx_user")
  @@index([resource_type, resource_id, resource_date, created_at], name: "idx_resource_timeline")
  @@map("inventory_holds")
}

model InventoryHoldTransition {
  id                  BigInt    @id @default(autoincrement())
  hold_id             BigInt
  from_status         String    @db.VarChar(20)
  to_status           String    @db.VarChar(20)
  transition_reason   String?   @db.VarChar(255)
  transitioned_by     String    @db.VarChar(100)
  metadata            Json?
  created_at          DateTime  @default(now())

  hold                InventoryHold @relation(fields: [hold_id], references: [id], onDelete: Cascade)

  @@index([hold_id], name: "idx_hold")
  @@index([created_at], name: "idx_created")
  @@map("inventory_hold_transitions")
}

model FencingTokenSequence {
  resource_key   String   @id @db.VarChar(100)
  current_token  BigInt   @default(0)
  updated_at     DateTime @updatedAt

  @@map("fencing_token_sequences")
}

model InventoryReconciliationLog {
  id                  BigInt    @id @default(autoincrement())
  resource_type       String    @db.VarChar(20)
  resource_id         BigInt
  resource_date       DateTime  @db.Date
  expected_available  Int       @db.SmallInt
  actual_available    Int       @db.SmallInt
  drift_amount        Int       @db.SmallInt
  corrected           Boolean   @default(false)
  corrected_at        DateTime?
  corrected_by        String?   @db.VarChar(100)
  created_at          DateTime  @default(now())

  @@index([drift_amount], name: "idx_drift")
  @@index([resource_type, resource_id, resource_date], name: "idx_resource")
  @@map("inventory_reconciliation_log")
}
```

---

## 11.10 Redis-Based Distributed Lock with the Redlock Algorithm

While we rely on database-level locking for the critical inventory UPDATE, there are operations outside the database that need coordination — such as preventing two instances of the expiration job from running simultaneously, or coordinating multi-step workflows that span services.

For these, we use the **Redlock algorithm**, a distributed locking algorithm designed by Salvatore Sanfilippo (the creator of Redis).

> **Key Term:** **Redlock** — A distributed locking algorithm that acquires locks across N independent Redis instances (typically 5). A lock is considered acquired only if the client obtains it from a majority (N/2 + 1) of the instances within a validity time. This tolerates the failure of up to N/2 - 1 Redis nodes without losing the lock's safety guarantee.

### Why Not a Simple Redis SETNX?

A single-node Redis lock (`SET key value NX EX 30`) works for many cases but fails if the Redis instance crashes. After a restart, the lock is gone, and two clients can acquire it simultaneously. Redlock addresses this by requiring a majority quorum across independent instances.

### Full Redlock Implementation

```typescript
// redlock.service.ts
import Redis from 'ioredis';
import { randomUUID } from 'crypto';

interface RedlockConfig {
  retryCount: number;      // How many times to retry acquiring
  retryDelay: number;      // Base delay between retries (ms)
  retryJitter: number;     // Random jitter added to retry delay (ms)
  driftFactor: number;     // Clock drift factor (0.01 = 1%)
}

interface Lock {
  resource: string;        // The resource being locked
  value: string;           // Unique lock identifier
  expiry: number;          // When this lock expires (timestamp ms)
}

export class RedlockService {
  private clients: Redis[];
  private quorum: number;
  private config: RedlockConfig;

  constructor(redisNodes: Array<{ host: string; port: number }>, config?: Partial<RedlockConfig>) {
    this.clients = redisNodes.map((node) => new Redis(node));
    this.quorum = Math.floor(this.clients.length / 2) + 1;
    this.config = {
      retryCount: 3,
      retryDelay: 200,
      retryJitter: 100,
      driftFactor: 0.01,
      ...config,
    };
  }

  /**
   * Acquire a distributed lock across all Redis instances.
   * Returns a Lock object if successful, null if not.
   */
  async acquire(resource: string, ttlMs: number): Promise<Lock | null> {
    const value = randomUUID(); // Unique identifier for this lock holder

    for (let attempt = 0; attempt < this.config.retryCount; attempt++) {
      const startTime = Date.now();
      let acquiredCount = 0;

      // Try to acquire on all instances in parallel
      const results = await Promise.allSettled(
        this.clients.map((client) => this.tryAcquire(client, resource, value, ttlMs))
      );

      acquiredCount = results.filter(
        (r) => r.status === 'fulfilled' && r.value === true
      ).length;

      // Calculate how much time acquiring took
      const elapsedMs = Date.now() - startTime;
      const drift = Math.floor(ttlMs * this.config.driftFactor) + 2;
      const remainingTtl = ttlMs - elapsedMs - drift;

      // Success: majority acquired AND remaining TTL is positive
      if (acquiredCount >= this.quorum && remainingTtl > 0) {
        return {
          resource,
          value,
          expiry: Date.now() + remainingTtl,
        };
      }

      // Failed: release any locks we did acquire
      await this.releaseAll(resource, value);

      // Wait before retrying (with jitter to prevent thundering herd)
      const delay = this.config.retryDelay +
        Math.floor(Math.random() * this.config.retryJitter);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    return null; // Could not acquire lock after all retries
  }

  /**
   * Release a distributed lock across all Redis instances.
   */
  async release(lock: Lock): Promise<void> {
    await this.releaseAll(lock.resource, lock.value);
  }

  /**
   * Execute a function while holding a distributed lock.
   * Automatically acquires and releases the lock.
   */
  async withLock<T>(
    resource: string,
    ttlMs: number,
    fn: () => Promise<T>
  ): Promise<T> {
    const lock = await this.acquire(resource, ttlMs);
    if (!lock) {
      throw new Error(`Could not acquire lock on resource: ${resource}`);
    }
    try {
      return await fn();
    } finally {
      await this.release(lock);
    }
  }

  // --- Private helpers ---

  private async tryAcquire(
    client: Redis,
    resource: string,
    value: string,
    ttlMs: number
  ): Promise<boolean> {
    try {
      const result = await client.set(
        `lock:${resource}`, value, 'PX', ttlMs, 'NX'
      );
      return result === 'OK';
    } catch {
      return false; // Redis node is down — treat as not acquired
    }
  }

  private async releaseAll(resource: string, value: string): Promise<void> {
    // Use a Lua script to atomically check-and-delete.
    // This prevents releasing a lock that was acquired by someone else
    // after our lock expired.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    await Promise.allSettled(
      this.clients.map((client) =>
        client.eval(script, 1, `lock:${resource}`, value)
      )
    );
  }
}
```

### Using Redlock for the Expiration Job

```typescript
// Ensure only one instance runs the expiration job at a time
const redlock = new RedlockService([
  { host: 'redis-1', port: 6379 },
  { host: 'redis-2', port: 6379 },
  { host: 'redis-3', port: 6379 },
  { host: 'redis-4', port: 6379 },
  { host: 'redis-5', port: 6379 },
]);

// In the cron job scheduler:
async function runExpirationWithLock(): Promise<void> {
  try {
    await redlock.withLock(
      'inventory:hold-expiration-job',
      25000,  // Lock for 25 seconds (job runs every 30 seconds)
      async () => {
        const expired = await expireHoldsJob();
        console.log(`Expired ${expired} holds`);
      }
    );
  } catch (error) {
    // Another instance is already running the job — skip this cycle
    if (error.message.includes('Could not acquire lock')) {
      return; // This is normal, not an error
    }
    throw error;
  }
}
```

> **Common Mistake:** Teams often set the Redlock TTL equal to the job interval. If the job takes longer than expected, the lock expires while the job is still running, and a second instance starts. Set the TTL slightly less than the interval (25s for a 30s interval) and add monitoring for jobs that approach the TTL limit.

---

## 11.11 Race Condition Scenarios with Timeline Diagrams

Understanding race conditions requires seeing the precise interleaving of operations. Here are three scenarios our system must handle correctly.

### Scenario 1: Two Users, Last Room (Handled by Atomic UPDATE)

```
TIME     USER A (Tokyo)                  USER B (London)               INVENTORY
-----    -------------------------       -------------------------     ---------
         available=1, reserved=0                                       [1, 0]

T+0ms    API: POST /hold                 API: POST /hold
T+2ms    getNextFencingToken() -> 47     getNextFencingToken() -> 48
T+5ms    UPDATE inventory                                              lock acquired
         SET available=0, reserved=1
         WHERE available >= 1
         AND fencing_token < 47
         -> affectedRows = 1 (SUCCESS)                                 [0, 1]
T+6ms    INSERT hold (active)
T+8ms    COMMIT, release lock
T+9ms                                    UPDATE inventory              lock acquired
                                         SET available=-1, reserved=2
                                         WHERE available >= 1
                                         AND fencing_token < 48
                                         -> affectedRows = 0 (FAIL!)
                                         (available is 0, not >= 1)
T+10ms                                   ROLLBACK
                                         Return 409: "No rooms available"

RESULT: Correct. User A gets the room. User B is told the room is unavailable.
```

### Scenario 2: Confirm vs. Expire Race (Handled by FOR UPDATE)

```
TIME     USER (confirming)              CRON JOB (expiring)           HOLD STATUS
-----    -------------------------      -------------------------     -----------
         Hold #99: active, expires at T+600s                          active

T+599s   User clicks "Pay"
T+600s   confirmHold(99) starts         expireHoldsJob() starts
T+601s   UPDATE holds                   SELECT holds WHERE expired
         SET status='confirmed'         FOR UPDATE
         WHERE id=99                    -> Lock acquired on hold #99
         AND status='active'            -> Hold #99 is returned
         AND expires_at > NOW()
         -> BLOCKED (row is locked      UPDATE hold #99
            by cron's FOR UPDATE)       SET status='expired'          expired
                                        Restore inventory
T+605s                                  COMMIT, release lock

T+606s   UPDATE resumes (lock released)
         WHERE id=99 AND status='active'
         -> affectedRows = 0 (FAIL!)
         (status is now 'expired', not 'active')
         Throw: "Hold is not active or has expired"

RESULT: Correct. The cron job won the race. User must start over.
        Inventory was properly restored. No double-count.
```

### Scenario 3: Double-Click Creates Only One Hold (Idempotency)

```
TIME     USER (double-clicked)                                        HOLDS
-----    ------------------------------------------                   -----
T+0ms    POST /hold {userId:5, sessionId:'abc', room:42, date:3/15}
T+1ms    BEGIN TRANSACTION
         SELECT FROM holds WHERE userId=5, sessionId='abc',
                                 room=42, date=3/15, status='active'
         -> 0 rows (no existing hold)                                 []
T+5ms    UPDATE inventory (decrement)
         INSERT hold #200 (active)                                    [#200]
         COMMIT

T+50ms   POST /hold {userId:5, sessionId:'abc', room:42, date:3/15}  <- duplicate!
T+51ms   BEGIN TRANSACTION
         SELECT FROM holds WHERE userId=5, sessionId='abc',
                                 room=42, date=3/15, status='active'
         -> 1 row (hold #200 exists!)                                 [#200]
T+52ms   UPDATE hold #200 SET expires_at = (new TTL)                  [#200]*
         COMMIT
         Return existing hold #200 with extended TTL.

RESULT: Correct. Only one hold created. Inventory decremented once.
        Second request silently extends the TTL.
```

> **Checkpoint:** Look at Scenario 2 again. What would happen if the cron job did NOT use `FOR UPDATE`? Trace through the timeline and identify exactly where the double-count would occur.
