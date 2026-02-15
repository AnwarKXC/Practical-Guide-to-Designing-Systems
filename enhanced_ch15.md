# Chapter 15: Distributed Locking — One at a Time, Please

## A Problem You Cannot See Until It Bites You

When you work on a single-server application, you do not think much about two pieces of code running the exact same operation at the exact same moment. Your Express app runs on one machine, and even though Node.js handles many requests concurrently (thanks to the event loop), your database transactions keep things orderly. You use `BEGIN` and `COMMIT`, maybe a `SELECT ... FOR UPDATE`, and the database makes sure two requests do not step on each other.

But in a microservices world, you are not running one server. You are running five, ten, or fifty replicas of the same service. Each replica talks to the same database, the same Redis cache, the same inventory data. And there is no shared memory, no shared process, no single event loop keeping things orderly.

This is where things get dangerous — and where this chapter earns its place in the book.

---

## Why Single-Process Locks Do Not Work Across Pods

Before we build distributed locks, let us understand exactly why your normal locking tools stop working the moment you scale horizontally. This is not academic. If you do not internalize this section, you will deploy code that works perfectly in development and fails catastrophically under load.

### The Monolith Lock: Mutex and Semaphore

In a single-process application, you have tools for managing concurrency. In Node.js, even though the event loop is single-threaded, async operations can interleave. You might use an in-memory lock to serialize access:

```typescript
// In-memory lock — works ONLY in a single process
class InMemoryLock {
  private locks = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => void> {
    // Wait for any existing lock on this key to resolve
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create a new lock (a promise that resolves when we release)
    let release: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.locks.set(key, lockPromise);

    // Return a release function
    return () => {
      this.locks.delete(key);
      release!();
    };
  }
}

// Usage in a single-process server:
const lock = new InMemoryLock();

app.post('/api/bookings', async (req, res) => {
  const release = await lock.acquire(`room:${req.body.roomId}`);
  try {
    // Only one request at a time can be in this block
    // for this specific roomId
    const available = await checkInventory(req.body.roomId);
    if (available > 0) {
      await createBooking(req.body);
    }
  } finally {
    release();
  }
});
```

This works beautifully — on one server. The `Map` lives in the process memory, so every request that enters the same Node.js process coordinates through the same lock object.

### The Moment It Breaks

Now deploy three replicas behind a load balancer. Each replica has its own `InMemoryLock` instance, its own `Map`, its own memory space. They cannot see each other's locks.

```
┌─────────────────┐
│  Load Balancer   │
└──┬─────┬─────┬──┘
   │     │     │
   ▼     ▼     ▼
┌──────┐ ┌──────┐ ┌──────┐
│Pod A │ │Pod B │ │Pod C │
│Lock: │ │Lock: │ │Lock: │
│ Map{}│ │ Map{}│ │ Map{}│
└──────┘ └──────┘ └──────┘
   │        │        │
   ▼        ▼        ▼
┌──────────────────────────┐
│     Shared Database       │
└──────────────────────────┘

Pod A's lock is INVISIBLE to Pod B and Pod C.
Three independent locks = no coordination = race conditions.
```

When Alice's request hits Pod A and Bob's request hits Pod B, each pod checks its own in-memory lock, finds it available, acquires it, and proceeds. The locks do not coordinate. Both pods read "1 room left" from the database. Both write a booking. Double booking.

> **Key Term:** **Distributed lock** — A locking mechanism that coordinates across multiple processes, servers, or pods, using an external system (such as Redis, ZooKeeper, or etcd) as the shared state that all participants can see and respect.

> **What If You Skip This?** If you deploy in-memory locks to production with multiple replicas, your locks do nothing. You will see race conditions under load, but your tests (which run against a single process) will pass. This is the worst kind of bug: one that tests cannot catch and production always does.

---

## The Race Condition: See It Before We Fix It

Let us make this concrete with our Global Booking System. Our Inventory Service is running on three pods behind a Kubernetes load balancer. A hotel in Tokyo has **one room left** for March 15. Two users, Alice and Bob, both click "Book Now" at the exact same instant.

```
Timeline — The Race Condition (NO distributed locking):

Pod A (handling Alice's request):
  T=0ms: SELECT available_quantity FROM inventory
         WHERE hotel_id = 'TOKYO-042' AND date = '2026-03-15';
         → Result: available_quantity = 1 (one room left!)

  T=1ms: Great, there's a room! Let me reserve it...

Pod B (handling Bob's request):
  T=0ms: SELECT available_quantity FROM inventory
         WHERE hotel_id = 'TOKYO-042' AND date = '2026-03-15';
         → Result: available_quantity = 1 (one room left!)

  T=1ms: Great, there's a room! Let me reserve it...

Pod A:
  T=5ms: UPDATE inventory SET available_quantity = 0
         WHERE hotel_id = 'TOKYO-042';
         → Success. Alice is booked.

Pod B:
  T=6ms: UPDATE inventory SET available_quantity = 0
         WHERE hotel_id = 'TOKYO-042';
         → "Success." Bob is booked too.

Result: TWO bookings for ONE room. Someone shows up at the hotel
        with no room available. Lawyers get involved.
```

Both pods checked the inventory at the same instant. Both saw "1 room left." Both went ahead and booked it. This is a **race condition** — two processes racing to modify the same data, with the outcome depending on who finishes first.

In a monolith with one server, you could solve this with a database-level lock (`SELECT ... FOR UPDATE`). But across multiple pods, you need something external. You need a **distributed lock**.

> **Key Term:** **Race condition** — A bug that occurs when two or more processes access shared data concurrently, and the result depends on the timing of their execution. Race conditions are intermittent — they might happen once in 10,000 requests — which makes them infuriatingly hard to reproduce and debug.

---

## The Bathroom Lock Analogy

> **Analogy:** Think of a bathroom with a lock on the door. When you go in, you turn the lock. Anyone else who tries the door sees it is locked and waits outside. When you come out, you unlock it, and the next person can enter. Only one person uses the bathroom at a time. A **distributed lock** works the same way: before modifying shared data (the bathroom), your service must acquire a lock (turn the deadbolt). If another service already holds the lock, you wait. When the first service finishes, it releases the lock, and the next service can proceed. The critical difference is that this bathroom door lock must be visible to every pod in every data center — not just the people on one floor of one building.

This is exactly what we need for our inventory problem. Before checking and updating the available room count, the service must acquire a lock on that specific resource. If another pod already holds the lock, this one waits until the lock is released.

---

## Redis SETNX: The Simplest Lock

Redis has a command called `SETNX` — "SET if Not eXists." It writes a key to Redis only if that key does not already exist. If the key already exists, it does nothing and returns `0`. This is the atomic building block of a distributed lock.

Why Redis? Because every pod can reach the same Redis instance. Unlike a `Map` in memory, a Redis key is visible to all clients connected to that Redis server. If Pod A sets a key, Pod B can see it.

```typescript
// The simplest possible distributed lock using Redis
import Redis from 'ioredis';

const redis = new Redis({ host: 'redis.cluster.local', port: 6379 });

async function acquireLock(resourceKey: string): Promise<boolean> {
  // SETNX: "Set this key ONLY if it doesn't already exist."
  // If the key doesn't exist → sets it, returns 1 (we got the lock!)
  // If the key already exists → does nothing, returns 0 (someone else has it)
  const result = await redis.setnx(`lock:${resourceKey}`, 'locked');
  return result === 1;
}

async function releaseLock(resourceKey: string): Promise<void> {
  await redis.del(`lock:${resourceKey}`);
}

// Usage:
const gotLock = await acquireLock('inventory:TOKYO-042:2026-03-15');

if (gotLock) {
  try {
    // We hold the lock. Only our pod can be in this block for this resource.
    const available = await checkInventory('TOKYO-042', '2026-03-15');
    if (available > 0) {
      await decrementInventory('TOKYO-042', '2026-03-15');
      await createBooking(userId, 'TOKYO-042', '2026-03-15');
    }
  } finally {
    // ALWAYS release the lock when done, even if an error occurred.
    await releaseLock('inventory:TOKYO-042:2026-03-15');
  }
} else {
  // Another pod holds the lock. We can retry after a short wait,
  // or tell the user to try again.
  return { error: 'Room is being booked by another user. Please try again.' };
}
```

With this lock in place, here is what happens when Alice and Bob try to book the same room:

```
Timeline — With Redis SETNX Lock:

Pod A (Alice):
  T=0ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 1 (got the lock!)
  T=1ms: SELECT available_quantity → 1
  T=5ms: UPDATE available_quantity = 0
  T=6ms: DEL lock:inventory:TOKYO-042:2026-03-15 (release lock)

Pod B (Bob):
  T=0ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 0 (lock exists!)
  T=0ms: "Room is being booked by another user. Please try again."

  (Bob retries at T=100ms):
  T=100ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 1 (got the lock!)
  T=101ms: SELECT available_quantity → 0
  T=101ms: "Sorry, no rooms available."

Result: ONE booking for ONE room. Correct behavior.
```

This is a major improvement. But this simple lock has three fatal flaws. Let us address each one.

> **Checkpoint:** Before reading on, can you think of at least two ways this naive SETNX lock can fail? Hint: what happens if the lock holder never releases? What happens if a different pod accidentally releases a lock it does not own?

---

## The Three Fatal Flaws of Naive SETNX

The simple SETNX lock we just built will work in a demo. It will even survive light production traffic. But under real-world conditions — process crashes, network partitions, high concurrency — it will fail in three specific, catastrophic ways. Every distributed-lock bug report I have ever read traces back to one of these three.

### Fatal Flaw #1: No TTL — The Immortal Lock

What happens if Pod A acquires the lock, starts processing the booking, and then crashes? The process dies. The `finally` block never runs. The `DEL` command is never sent. The lock key sits in Redis forever.

```
Timeline — The Immortal Lock:

Pod A:
  T=0ms:   SETNX lock:inventory:TOKYO-042 → 1 (got the lock!)
  T=2ms:   SELECT available_quantity → 1
  T=3ms:   *** PROCESS CRASHES (out of memory, segfault, pod eviction) ***
  T=3ms:   DEL never executes. The key remains in Redis.

Pod B (T=50ms):
  SETNX lock:inventory:TOKYO-042 → 0 (lock exists!)

Pod C (T=200ms):
  SETNX lock:inventory:TOKYO-042 → 0 (lock exists!)

Pod D (T=5 minutes later):
  SETNX lock:inventory:TOKYO-042 → 0 (STILL locked!)

Result: The room in Tokyo can NEVER be booked again.
        The lock is held by a dead process, forever.
        This is called a "deadlock" or "zombie lock."
```

This is not theoretical. Kubernetes regularly evicts pods for exceeding memory limits. Network blips kill connections. The garbage collector can pause a Node.js process long enough that a health check fails and the orchestrator kills it. Your lock holder **will** die without releasing its lock. It is a matter of when, not if.

> **Key Term:** **Deadlock** — A state where a resource is permanently locked because the process holding the lock can never release it (due to a crash, hang, or network partition). In distributed systems, deadlocks from crashed lock holders are the most common locking failure mode.

### Fatal Flaw #2: No Ownership — The Wrong Person Unlocks the Door

Look at our `releaseLock` function again:

```typescript
async function releaseLock(resourceKey: string): Promise<void> {
  await redis.del(`lock:${resourceKey}`);
}
```

It deletes the key. Any pod can call this. There is no check that the pod calling `DEL` is the same pod that called `SETNX`. This means Pod B can accidentally (or through a bug) release Pod A's lock.

```
Timeline — Lock Theft:

Pod A:
  T=0ms:   SETNX lock:room-42 → 1 (acquired)
  T=1ms:   Start processing booking...

Pod B:
  T=0ms:   SETNX lock:room-42 → 0 (denied, lock held by Pod A)
  T=50ms:  Due to a timeout/retry bug, Pod B calls DEL lock:room-42
           → Pod A's lock is RELEASED without Pod A knowing!

Pod C:
  T=51ms:  SETNX lock:room-42 → 1 (acquired — while Pod A is STILL working!)

Pod A (still running, thinks it holds the lock):
  T=60ms:  UPDATE inventory SET available_quantity = 0
           → Pod A modifies data WITHOUT holding the lock.

Pod C (also holds the lock):
  T=70ms:  UPDATE inventory SET available_quantity = 0
           → DOUBLE BOOKING.
```

> **Analogy:** Imagine the bathroom lock analogy again. You walk in, lock the door, and start using the bathroom. But the lock is a simple latch — anyone on the outside can flip it. A janitor walks by, thinks the bathroom is empty, and unlocks it. Someone else walks in while you are still inside. That is what happens without ownership: anyone can release anyone's lock.

### Fatal Flaw #3: No Retry — Immediate Rejection

Our naive implementation returns `false` immediately if the lock is held. The caller gets an error message: "Try again." But in production, the lock is typically held for only 5 to 50 milliseconds. If the caller waited just 20 ms and tried again, it would succeed. Immediately rejecting users creates a terrible experience when a short wait would work fine.

```typescript
// Current behavior — no retry, immediate failure:
const gotLock = await acquireLock('room-42');
if (!gotLock) {
  // User sees "Something went wrong, try again" — bad UX
  return { error: 'Room is being booked by another user.' };
}

// What we SHOULD do — retry with backoff:
// Try multiple times with short waits between attempts.
// Most locks are held for <50ms, so 3-5 retries over 200ms
// will succeed in the vast majority of cases.
```

> **What If You Skip This?** Without retry logic, your booking success rate drops dramatically under moderate concurrency. If 10 users try to book different rooms within the same second, contention on unrelated resources can cause cascading lock failures. Users see intermittent errors that "go away if they try again" — the hallmark of a badly implemented distributed lock.

---

## TTL-Based Locks with SET EX NX: Solving Flaw #1 and #2

Redis provides a single command that addresses both the TTL problem and the ownership problem:

```
SET key value EX seconds NX
```

This command does four things atomically (in one indivisible operation):
1. **SET** — Write a key-value pair.
2. **EX seconds** — Set an expiration time. The key auto-deletes after this many seconds.
3. **NX** — Only set if the key does Not eXist.
4. The **value** can be a unique identifier (like a UUID) that proves ownership.

```typescript
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const redis = new Redis({ host: 'redis.cluster.local', port: 6379 });

interface LockResult {
  acquired: boolean;
  lockId: string;
}

/**
 * Acquire a distributed lock with TTL and ownership.
 *
 * @param resourceKey  - The resource to lock (e.g., "inventory:TOKYO-042:2026-03-15")
 * @param ttlSeconds   - How long the lock lives before auto-expiring (safety net)
 * @param retryCount   - How many times to retry if the lock is held
 * @param retryDelayMs - How long to wait between retries
 */
async function acquireLock(
  resourceKey: string,
  ttlSeconds: number = 10,
  retryCount: number = 5,
  retryDelayMs: number = 50,
): Promise<LockResult> {
  const lockId = uuidv4(); // Unique identifier for THIS lock holder.
  const lockKey = `lock:${resourceKey}`;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    // SET key value EX ttl NX — atomic set-if-not-exists with expiration.
    // If successful, returns "OK". If key exists, returns null.
    const result = await redis.set(lockKey, lockId, 'EX', ttlSeconds, 'NX');

    if (result === 'OK') {
      return { acquired: true, lockId };
    }

    // Lock is held by someone else. Wait and retry.
    if (attempt < retryCount) {
      // Add jitter to prevent all pods retrying at the exact same moment.
      const jitter = Math.random() * retryDelayMs * 0.5;
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelayMs + jitter),
      );
    }
  }

  // All retries exhausted.
  return { acquired: false, lockId: '' };
}

/**
 * Release a lock — but ONLY if we are the owner.
 *
 * Uses a Lua script for atomicity: check-and-delete in one operation.
 * Without Lua, another process could acquire the lock between our
 * GET (to check ownership) and our DEL (to release).
 */
async function releaseLock(
  resourceKey: string,
  lockId: string,
): Promise<boolean> {
  const lockKey = `lock:${resourceKey}`;

  // Lua script: "If the value at this key matches my lockId, delete it.
  // Otherwise, do nothing."
  const luaScript = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  const result = await redis.eval(luaScript, 1, lockKey, lockId);
  return result === 1;
}
```

Let us walk through how this fixes the first two fatal flaws:

**Fix for Flaw #1 (No TTL):** The `EX 10` parameter means the lock key automatically disappears from Redis after 10 seconds. If Pod A crashes and never calls `releaseLock`, the key expires on its own. After 10 seconds, other pods can acquire the lock. No more zombie locks.

**Fix for Flaw #2 (No Ownership):** The value stored at the lock key is a UUID unique to the lock holder. When releasing, the Lua script checks: "Is the value stored at this key **my** UUID?" If yes, delete. If no, do nothing. Pod B cannot accidentally release Pod A's lock because it does not know Pod A's UUID.

**Fix for Flaw #3 (No Retry):** The `retryCount` and `retryDelayMs` parameters implement a retry loop with jitter. Instead of immediately failing, the caller waits and retries. The jitter (randomized delay) prevents the "thundering herd" problem where all pods retry at exactly the same instant.

> **Key Term:** **Jitter** — A small random delay added to retry intervals to spread out simultaneous retry attempts. Without jitter, if 50 pods all fail to acquire a lock at T=0, they all retry at T=50ms, fail again, all retry at T=100ms, and so on. Jitter breaks this synchronized stampede.

> **Common Mistake:** Setting the TTL too short. If your lock TTL is 5 seconds but your operation takes 8 seconds (maybe the database is slow), the lock expires while you are still working. Another process acquires the lock and starts modifying the same data. Now you have two processes both thinking they hold the lock. We will solve this with the watchdog pattern later in this chapter.

---

## The Redlock Algorithm: When One Redis Is Not Enough

Our improved lock relies on a single Redis instance. If that Redis crashes, every lock in the system is lost. If it becomes unreachable due to a network partition, no new locks can be acquired and existing lock state is uncertain. For many applications, a single Redis instance is fine — Redis is remarkably stable and fast. But for systems where correctness is critical (like booking the last room or processing a financial transaction), you need more.

The **Redlock algorithm**, designed by Salvatore Sanfilippo (the creator of Redis), uses multiple independent Redis instances to create a lock that survives individual node failures. The idea is simple: instead of writing the lock to one Redis, write it to five. If you successfully write it to a majority (at least three out of five), you hold the lock. If any one or two Redis instances go down, the remaining three still have your lock.

> **Key Term:** **Redlock** — A distributed locking algorithm that acquires the same lock key on N independent Redis instances (typically 5) and considers the lock acquired only if it succeeds on a strict majority (N/2 + 1). This provides fault tolerance against individual Redis node failures.

### Redlock Step by Step

Here is the algorithm, step by step:

1. **Record the start time.** Note the current timestamp in milliseconds.

2. **Try to acquire the lock on all N Redis instances sequentially.** Use the same key, same random value (the UUID), and same TTL on each instance. Use a short timeout for each SET command (e.g., 5-10 ms) so that a down or unreachable node does not block the entire process.

3. **Calculate elapsed time.** After attempting all N instances, check how much time has passed since step 1.

4. **Determine if the lock was acquired.** The lock is acquired if and only if:
   - You succeeded on **at least N/2 + 1** instances (a majority), AND
   - The **total elapsed time** is less than the TTL. (If it took so long to acquire the locks that the first ones are about to expire, the lock is invalid.)

5. **If the lock was acquired,** the effective TTL is the original TTL minus the elapsed time. Use this remaining time as your window to do work.

6. **If the lock was NOT acquired** (failed to get a majority, or elapsed time exceeded TTL), release the lock on ALL instances — even the ones where you succeeded. You do not want partial locks sitting around.

```typescript
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

interface RedlockOptions {
  retryCount: number;
  retryDelayMs: number;
  ttlMs: number;
  driftFactor: number; // Clock drift compensation (typically 0.01)
}

interface RedlockResult {
  acquired: boolean;
  lockId: string;
  validityTimeMs: number; // How much time you have before the lock expires
}

class Redlock {
  private clients: Redis[];
  private quorum: number;

  constructor(
    clients: Redis[],
    private options: RedlockOptions = {
      retryCount: 3,
      retryDelayMs: 200,
      ttlMs: 10000,
      driftFactor: 0.01,
    },
  ) {
    if (clients.length < 3) {
      throw new Error(
        'Redlock requires at least 3 independent Redis instances.',
      );
    }
    this.clients = clients;
    // Quorum = majority. For 5 instances, quorum = 3.
    this.quorum = Math.floor(clients.length / 2) + 1;
  }

  /**
   * Attempt to acquire a lock on a single Redis instance.
   * Returns true if successful, false otherwise.
   * Uses a short per-instance timeout to avoid blocking on dead nodes.
   */
  private async acquireOnInstance(
    client: Redis,
    lockKey: string,
    lockId: string,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      // PX = milliseconds (more precise than EX which uses seconds)
      const result = await Promise.race([
        client.set(lockKey, lockId, 'PX', ttlMs, 'NX'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ]);
      return result === 'OK';
    } catch {
      // Instance is down or unreachable. That is fine — we have others.
      return false;
    }
  }

  /**
   * Release a lock on a single Redis instance (only if we own it).
   */
  private async releaseOnInstance(
    client: Redis,
    lockKey: string,
    lockId: string,
  ): Promise<void> {
    const luaScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    try {
      await client.eval(luaScript, 1, lockKey, lockId);
    } catch {
      // Instance may be down. Best-effort release.
    }
  }

  /**
   * Acquire a Redlock across all instances.
   */
  async acquire(resourceKey: string): Promise<RedlockResult> {
    const lockKey = `lock:${resourceKey}`;
    const lockId = uuidv4();
    const { ttlMs, retryCount, retryDelayMs, driftFactor } = this.options;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const startTime = Date.now();
      let successCount = 0;

      // Step 1-2: Try to acquire on ALL instances.
      for (const client of this.clients) {
        const success = await this.acquireOnInstance(
          client, lockKey, lockId, ttlMs,
        );
        if (success) successCount++;
      }

      // Step 3: Calculate elapsed time.
      const elapsedMs = Date.now() - startTime;

      // Clock drift compensation: account for slight time differences
      // between Redis instances. Typically 1% of TTL.
      const drift = Math.floor(ttlMs * driftFactor) + 2;

      // Step 4: Check quorum and remaining validity.
      const validityTimeMs = ttlMs - elapsedMs - drift;

      if (successCount >= this.quorum && validityTimeMs > 0) {
        // Step 5: Lock acquired! Return remaining validity time.
        return { acquired: true, lockId, validityTimeMs };
      }

      // Step 6: Failed. Release on ALL instances (even successful ones).
      await Promise.all(
        this.clients.map((client) =>
          this.releaseOnInstance(client, lockKey, lockId),
        ),
      );

      // Wait before retrying, with jitter.
      if (attempt < retryCount) {
        const jitter = Math.random() * retryDelayMs;
        await new Promise((r) => setTimeout(r, retryDelayMs + jitter));
      }
    }

    return { acquired: false, lockId: '', validityTimeMs: 0 };
  }

  /**
   * Release a Redlock on all instances.
   */
  async release(resourceKey: string, lockId: string): Promise<void> {
    const lockKey = `lock:${resourceKey}`;
    await Promise.all(
      this.clients.map((client) =>
        this.releaseOnInstance(client, lockKey, lockId),
      ),
    );
  }
}

// Usage:
const redisInstances = [
  new Redis({ host: 'redis-1.internal', port: 6379 }),
  new Redis({ host: 'redis-2.internal', port: 6379 }),
  new Redis({ host: 'redis-3.internal', port: 6379 }),
  new Redis({ host: 'redis-4.internal', port: 6379 }),
  new Redis({ host: 'redis-5.internal', port: 6379 }),
];

const redlock = new Redlock(redisInstances);

async function bookRoom(userId: string, roomId: string, date: string) {
  const resource = `inventory:${roomId}:${date}`;
  const lock = await redlock.acquire(resource);

  if (!lock.acquired) {
    throw new Error('Could not acquire lock. Please try again.');
  }

  try {
    // We have at most lock.validityTimeMs milliseconds to finish.
    const available = await checkInventory(roomId, date);
    if (available > 0) {
      await decrementInventory(roomId, date);
      await createBooking(userId, roomId, date);
      return { success: true };
    }
    return { success: false, reason: 'No rooms available' };
  } finally {
    await redlock.release(resource, lock.lockId);
  }
}
```

> **Analogy:** Redlock is like getting a document notarized. Instead of trusting a single notary (who might be fraudulent or absent), you present the document to five independent notaries. If at least three of them stamp and sign it, you consider the document officially notarized. If one notary is out sick and another refuses, three approvals is still a majority. The document (your lock) is valid.

> **Checkpoint:** Study the Redlock algorithm above. Why does step 4 require that the elapsed time be less than the TTL? What would happen if acquiring locks on all five instances took 9.5 seconds and your TTL was 10 seconds? (Answer: you would have only 0.5 seconds to do your work before the first locks start expiring — other processes could acquire them.)

---

## Lock Renewal: The Watchdog Pattern

We mentioned a danger earlier: what if your TTL is 10 seconds but your operation takes 12 seconds? The lock expires while you are still working, and another process grabs it. You now have two processes both believing they hold the lock. This is not a theoretical problem — a slow database query, a garbage collection pause, or a network hiccup can easily push your operation past the TTL.

The solution is the **watchdog pattern**: a background timer that periodically extends the lock's TTL while your operation is still running. Think of it like pressing the "still here" button on a kiosk screen before it times out.

> **Analogy:** At some parking meters, you can add more coins to extend your time. The watchdog pattern works the same way. Instead of buying 10 minutes and hoping you finish shopping in time, you have a friend standing at the meter who drops in another coin every 8 minutes as long as you are still in the store. The meter never expires while you are actively using the spot. But if you leave the store (your process finishes or crashes), your friend stops feeding the meter, and the spot opens up naturally.

```typescript
/**
 * A lock with automatic renewal (watchdog pattern).
 *
 * The watchdog timer extends the lock TTL every renewIntervalMs,
 * keeping the lock alive as long as the operation is running.
 * When the operation completes (or crashes), the watchdog stops
 * and the lock expires naturally or is explicitly released.
 */
class WatchdogLock {
  private renewalTimer: NodeJS.Timeout | null = null;

  constructor(
    private redis: Redis,
    private lockKey: string,
    private lockId: string,
    private ttlMs: number,
    private renewIntervalMs: number,
  ) {}

  /**
   * Start the watchdog. Call this immediately after acquiring the lock.
   *
   * The watchdog runs a Lua script every renewIntervalMs that says:
   * "If I still own this lock, extend its TTL by the full ttlMs."
   *
   * If the lock was released or stolen, the script does nothing.
   */
  startWatchdog(): void {
    const renewScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    this.renewalTimer = setInterval(async () => {
      try {
        const result = await this.redis.eval(
          renewScript,
          1,
          this.lockKey,
          this.lockId,
          this.ttlMs.toString(),
        );

        if (result === 0) {
          // We no longer own the lock. Stop trying to renew.
          this.stopWatchdog();
          console.warn(
            `[WatchdogLock] Lost ownership of ${this.lockKey}. ` +
            `Stopping renewal.`,
          );
        }
      } catch (error) {
        // Redis error during renewal. Log it but keep trying.
        console.error(
          `[WatchdogLock] Failed to renew ${this.lockKey}:`, error,
        );
      }
    }, this.renewIntervalMs);
  }

  /**
   * Stop the watchdog. Call this when releasing the lock.
   */
  stopWatchdog(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = null;
    }
  }
}

// Usage with the watchdog pattern:
async function bookRoomWithWatchdog(
  redis: Redis,
  userId: string,
  roomId: string,
  date: string,
) {
  const lockKey = `lock:inventory:${roomId}:${date}`;
  const lockId = uuidv4();
  const ttlMs = 10_000;        // 10-second TTL
  const renewIntervalMs = 3_000; // Renew every 3 seconds

  // Acquire the lock.
  const result = await redis.set(lockKey, lockId, 'PX', ttlMs, 'NX');
  if (result !== 'OK') {
    throw new Error('Could not acquire lock.');
  }

  // Start the watchdog immediately.
  const watchdog = new WatchdogLock(
    redis, lockKey, lockId, ttlMs, renewIntervalMs,
  );
  watchdog.startWatchdog();

  try {
    // This operation can take as long as it needs.
    // The watchdog keeps extending the TTL every 3 seconds.
    const available = await checkInventory(roomId, date);    // Might be slow!
    if (available > 0) {
      await decrementInventory(roomId, date);                // Might be slow!
      await createBooking(userId, roomId, date);             // Might be slow!
      return { success: true };
    }
    return { success: false, reason: 'No rooms available.' };
  } finally {
    // Stop the watchdog FIRST, then release the lock.
    watchdog.stopWatchdog();

    // Release with ownership check.
    const releaseScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(releaseScript, 1, lockKey, lockId);
  }
}
```

### Choosing Renewal Interval and TTL

A good rule of thumb: set the renewal interval to **one-third of the TTL**. This gives you three chances to renew before the lock expires.

| TTL | Renewal Interval | Safety Buffer |
|-----|-------------------|---------------|
| 10 seconds | 3 seconds | 3 renewal attempts before expiry |
| 30 seconds | 10 seconds | 3 renewal attempts before expiry |
| 60 seconds | 20 seconds | 3 renewal attempts before expiry |

If a single renewal fails (transient Redis error), you still have two more attempts before the lock expires. If all three fail, something is seriously wrong with your Redis connectivity, and letting the lock expire is probably the safest outcome.

> **Common Mistake:** Setting the renewal interval equal to the TTL, or worse, greater than the TTL. If your TTL is 10 seconds and your renewal runs every 10 seconds, the lock expires at the exact moment you try to renew it. A single delayed timer tick means you lose the lock. Always leave a comfortable margin.

---

## Fencing Tokens: The Last Line of Defense

Even with TTL, ownership checks, and watchdog renewal, there is one more failure mode that can cause data corruption. It is subtle, and most tutorials ignore it entirely. But it has caused real outages at real companies, so we will cover it thoroughly.

The scenario: **a process holds a lock, gets paused (garbage collection, OS scheduling, network delay), the lock expires, another process acquires the lock and does work, then the first process wakes up and continues — not knowing it lost the lock.**

```
Timeline — The GC Pause Disaster:

Pod A:
  T=0ms:    Acquire lock (TTL = 10s). Start processing.
  T=3000ms: Watchdog renews lock. Everything fine.
  T=5000ms: *** FULL GC PAUSE BEGINS ***
            Node.js is frozen. No code runs. No watchdog.

  T=15000ms: *** GC PAUSE ENDS (10 seconds of pause!) ***
             Pod A wakes up, continues executing where it left off.
             It still has the lockId in memory. It THINKS it holds the lock.

             But the lock expired at T=10000ms (5 seconds ago).

Pod B:
  T=10500ms: Acquires the lock (Pod A's lock expired at T=10000ms).
  T=11000ms: Reads inventory, writes booking. Releases lock.

Pod A (resumed after GC):
  T=15000ms: Writes booking. *** DOUBLE BOOKING ***
             Pod A's write succeeds because it goes directly to the DB.
             The DB does not know about Redis locks.
```

The watchdog cannot help here because the entire process was frozen. The lock expired legitimately. The problem is that Pod A **continued operating after losing the lock**.

The fix is a **fencing token**: a monotonically increasing number assigned with each lock acquisition. Every write to the database must include the fencing token, and the database must reject writes with a token lower than the last one it saw.

> **Key Term:** **Fencing token** — A monotonically increasing integer assigned each time a lock is acquired. The protected resource (database, API, storage) checks this token on every write and rejects operations carrying a stale (lower) token. This prevents a process that held the lock in the past from corrupting data after losing it.

```typescript
/**
 * Acquire a lock with a fencing token.
 *
 * The fencing token is generated by Redis INCR, which is atomic and
 * guaranteed to produce a strictly increasing sequence.
 */
async function acquireLockWithFencing(
  redis: Redis,
  resourceKey: string,
  ttlMs: number,
): Promise<{ acquired: boolean; lockId: string; fencingToken: number }> {
  const lockId = uuidv4();
  const lockKey = `lock:${resourceKey}`;
  const tokenKey = `fencing-token:${resourceKey}`;

  // SET NX with TTL.
  const result = await redis.set(lockKey, lockId, 'PX', ttlMs, 'NX');

  if (result !== 'OK') {
    return { acquired: false, lockId: '', fencingToken: 0 };
  }

  // Generate a fencing token. INCR is atomic and always increases.
  const fencingToken = await redis.incr(tokenKey);

  // Store the token with the lock so we can verify later.
  await redis.set(`${lockKey}:token`, fencingToken.toString(), 'PX', ttlMs);

  return { acquired: true, lockId, fencingToken };
}

/**
 * Write to the database with fencing token protection.
 *
 * The SQL uses a WHERE clause that only allows the write if
 * our fencing token is >= the last token seen for this resource.
 * This prevents stale lock holders from corrupting data.
 */
async function updateInventoryWithFencing(
  roomId: string,
  date: string,
  newQuantity: number,
  fencingToken: number,
): Promise<boolean> {
  // Raw SQL approach:
  const result = await pool.query(
    `UPDATE inventory
     SET available_quantity = $1,
         last_fencing_token = $2,
         updated_at = NOW(6)
     WHERE hotel_id = $3
       AND date = $4
       AND last_fencing_token < $5`,
    [newQuantity, fencingToken, roomId, date, fencingToken],
  );

  // If rowCount is 0, a newer fencing token already wrote to this row.
  // Our write was stale and correctly rejected.
  return result.rowCount > 0;
}
```

And the equivalent using Prisma:

```prisma
// schema.prisma — Inventory model with fencing token support
model Inventory {
  id                 String   @id @default(uuid())
  hotelId            String   @map("hotel_id")
  date               DateTime @db.Date
  totalQuantity      Int      @map("total_quantity")
  availableQuantity  Int      @map("available_quantity")
  lastFencingToken   Int      @default(0) @map("last_fencing_token")
  updatedAt          DateTime @updatedAt @map("updated_at")

  @@unique([hotelId, date])
  @@map("inventory")
}
```

```typescript
// Prisma Client — update with fencing token guard
async function updateInventoryWithFencingPrisma(
  prisma: PrismaClient,
  roomId: string,
  date: Date,
  newQuantity: number,
  fencingToken: number,
): Promise<boolean> {
  try {
    // updateMany allows compound WHERE conditions.
    // We only update if lastFencingToken < our token.
    const result = await prisma.inventory.updateMany({
      where: {
        hotelId: roomId,
        date: date,
        lastFencingToken: { lt: fencingToken }, // Only if our token is newer
      },
      data: {
        availableQuantity: newQuantity,
        lastFencingToken: fencingToken,
      },
    });

    // result.count tells us how many rows matched the WHERE clause.
    // If 0, our token was stale — a newer lock holder already wrote.
    return result.count > 0;
  } catch (error) {
    console.error('[Fencing] Update failed:', error);
    return false;
  }
}
```

> **Analogy:** A fencing token is like a version number on a shared Google Doc. Even if you go offline and come back with edits, Google Docs checks your version against the current version. If someone else edited while you were offline, your edits are flagged as conflicting — they do not silently overwrite the newer changes. The fencing token provides the same guarantee for database writes.

> **What If You Skip This?** Without fencing tokens, your distributed lock provides only "probable" mutual exclusion, not guaranteed mutual exclusion. For most applications, this is acceptable — GC pauses long enough to cause problems are rare. But for financial transactions, inventory management with legal liability, or medical systems, fencing tokens are mandatory. The question is: can your business survive an occasional double-write?

---

## Full NestJS RedisLockService Implementation

Now let us bring everything together into a production-ready NestJS service that your Global Booking System will use. This service combines TTL-based locking, ownership verification, watchdog renewal, and fencing tokens into a clean, injectable service.

```typescript
// src/common/locks/redis-lock.service.ts

import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

export interface LockOptions {
  /** TTL in milliseconds. Default: 10000 (10 seconds). */
  ttlMs?: number;
  /** Number of retry attempts. Default: 5. */
  retryCount?: number;
  /** Delay between retries in ms. Default: 50. */
  retryDelayMs?: number;
  /** Enable watchdog auto-renewal. Default: true. */
  enableWatchdog?: boolean;
  /** Enable fencing token. Default: false. */
  enableFencing?: boolean;
}

export interface AcquiredLock {
  lockId: string;
  resource: string;
  fencingToken: number | null;
  acquiredAt: Date;
}

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLockService.name);
  private readonly activeWatchdogs = new Map<string, NodeJS.Timeout>();
  private readonly DEFAULT_TTL_MS = 10_000;
  private readonly DEFAULT_RETRY_COUNT = 5;
  private readonly DEFAULT_RETRY_DELAY_MS = 50;

  // Lua script: release lock only if we own it.
  private readonly RELEASE_SCRIPT = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  // Lua script: renew TTL only if we own the lock.
  private readonly RENEW_SCRIPT = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /**
   * Acquire a distributed lock on a resource.
   *
   * @param resource - Unique identifier for the resource to lock
   *                   (e.g., "inventory:TOKYO-042:2026-03-15")
   * @param options  - Lock configuration options
   * @returns The acquired lock, or null if acquisition failed
   */
  async acquire(
    resource: string,
    options: LockOptions = {},
  ): Promise<AcquiredLock | null> {
    const {
      ttlMs = this.DEFAULT_TTL_MS,
      retryCount = this.DEFAULT_RETRY_COUNT,
      retryDelayMs = this.DEFAULT_RETRY_DELAY_MS,
      enableWatchdog = true,
      enableFencing = false,
    } = options;

    const lockId = uuidv4();
    const lockKey = `lock:${resource}`;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const result = await this.redis.set(
        lockKey, lockId, 'PX', ttlMs, 'NX',
      );

      if (result === 'OK') {
        this.logger.debug(
          `Lock acquired: ${resource} (id=${lockId}, ` +
          `attempt=${attempt + 1}/${retryCount + 1})`,
        );

        // Start watchdog if enabled.
        if (enableWatchdog) {
          this.startWatchdog(lockKey, lockId, ttlMs);
        }

        // Generate fencing token if enabled.
        let fencingToken: number | null = null;
        if (enableFencing) {
          fencingToken = await this.redis.incr(`fencing:${resource}`);
        }

        return {
          lockId,
          resource,
          fencingToken,
          acquiredAt: new Date(),
        };
      }

      // Wait before retrying (with jitter).
      if (attempt < retryCount) {
        const jitter = Math.random() * retryDelayMs * 0.5;
        await this.sleep(retryDelayMs + jitter);
      }
    }

    this.logger.warn(
      `Lock acquisition failed after ${retryCount + 1} attempts: ${resource}`,
    );
    return null;
  }

  /**
   * Release a previously acquired lock.
   *
   * @param lock - The lock object returned by acquire()
   * @returns true if the lock was successfully released, false if
   *          we no longer owned it (expired or stolen)
   */
  async release(lock: AcquiredLock): Promise<boolean> {
    const lockKey = `lock:${lock.resource}`;

    // Stop the watchdog BEFORE releasing.
    this.stopWatchdog(lockKey);

    const result = await this.redis.eval(
      this.RELEASE_SCRIPT,
      1,
      lockKey,
      lock.lockId,
    );

    const released = result === 1;

    if (released) {
      this.logger.debug(`Lock released: ${lock.resource}`);
    } else {
      this.logger.warn(
        `Lock release failed (not owner): ${lock.resource}. ` +
        `This may indicate the lock expired before release.`,
      );
    }

    return released;
  }

  /**
   * Execute a function while holding a lock.
   *
   * This is the recommended way to use distributed locks.
   * It guarantees the lock is always released, even if the
   * function throws an error.
   *
   * @param resource - The resource to lock
   * @param fn       - The function to execute while holding the lock
   * @param options  - Lock configuration options
   * @returns The return value of fn
   * @throws Error if lock cannot be acquired, or if fn throws
   */
  async withLock<T>(
    resource: string,
    fn: (lock: AcquiredLock) => Promise<T>,
    options: LockOptions = {},
  ): Promise<T> {
    const lock = await this.acquire(resource, options);

    if (!lock) {
      throw new Error(
        `Could not acquire lock on "${resource}" after ` +
        `${(options.retryCount ?? this.DEFAULT_RETRY_COUNT) + 1} attempts.`,
      );
    }

    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }

  /**
   * Start a watchdog timer that periodically renews the lock TTL.
   */
  private startWatchdog(
    lockKey: string,
    lockId: string,
    ttlMs: number,
  ): void {
    // Renew at 1/3 of the TTL.
    const renewInterval = Math.floor(ttlMs / 3);

    const timer = setInterval(async () => {
      try {
        const result = await this.redis.eval(
          this.RENEW_SCRIPT, 1, lockKey, lockId, ttlMs.toString(),
        );

        if (result === 0) {
          this.logger.warn(
            `Watchdog: lost ownership of ${lockKey}. Stopping renewal.`,
          );
          this.stopWatchdog(lockKey);
        }
      } catch (error) {
        this.logger.error(
          `Watchdog: failed to renew ${lockKey}:`, error,
        );
      }
    }, renewInterval);

    this.activeWatchdogs.set(lockKey, timer);
  }

  /**
   * Stop a watchdog timer.
   */
  private stopWatchdog(lockKey: string): void {
    const timer = this.activeWatchdogs.get(lockKey);
    if (timer) {
      clearInterval(timer);
      this.activeWatchdogs.delete(lockKey);
    }
  }

  /**
   * Clean up all active watchdogs when the module is destroyed.
   */
  onModuleDestroy(): void {
    for (const [key, timer] of this.activeWatchdogs) {
      clearInterval(timer);
      this.logger.debug(`Cleaned up watchdog for ${key}`);
    }
    this.activeWatchdogs.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

### Using the Service in a Booking Controller

```typescript
// src/bookings/bookings.service.ts

import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisLockService } from '../common/locks/redis-lock.service';

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lockService: RedisLockService,
  ) {}

  async createBooking(
    userId: string,
    hotelId: string,
    date: Date,
  ) {
    const resource = `inventory:${hotelId}:${date.toISOString().split('T')[0]}`;

    return this.lockService.withLock(
      resource,
      async (lock) => {
        // Step 1: Check inventory under the lock.
        const inventory = await this.prisma.inventory.findUnique({
          where: {
            hotelId_date: { hotelId, date },
          },
        });

        if (!inventory || inventory.availableQuantity <= 0) {
          throw new ConflictException('No rooms available for this date.');
        }

        // Step 2: Decrement inventory and create booking atomically.
        const [updatedInventory, booking] = await this.prisma.$transaction([
          this.prisma.inventory.update({
            where: { hotelId_date: { hotelId, date } },
            data: { availableQuantity: { decrement: 1 } },
          }),
          this.prisma.booking.create({
            data: {
              userId,
              hotelId,
              checkInDate: date,
              status: 'CONFIRMED',
              lockId: lock.lockId,
              fencingToken: lock.fencingToken,
            },
          }),
        ]);

        this.logger.log(
          `Booking created: hotel=${hotelId}, user=${userId}, ` +
          `remaining=${updatedInventory.availableQuantity}`,
        );

        return booking;
      },
      {
        ttlMs: 15_000,
        retryCount: 3,
        retryDelayMs: 100,
        enableWatchdog: true,
        enableFencing: true,
      },
    );
  }
}
```

> **Checkpoint:** Look at the `withLock` method above. Why is the `finally` block essential? What happens in production if an exception is thrown inside `fn` and there is no `finally`? (Answer: the lock is never released. Other processes wait for the TTL to expire. During that time, no one can book the same room. This causes user-visible delays and potential SLA violations.)

---

## Prisma Schema for Lock Audit Tracking

In production, you need visibility into your locks. When a double-booking incident report lands on your desk, you need to answer: who held the lock, when, for how long, and did it expire or get released cleanly? An audit trail is not optional — it is how you debug distributed systems at 3 AM.

Here is the Prisma schema for lock audit tracking:

```prisma
// schema.prisma — Lock audit models

model LockAudit {
  id            String        @id @default(uuid())
  resource      String        // e.g., "inventory:TOKYO-042:2026-03-15"
  lockId        String        @map("lock_id")
  podId         String        @map("pod_id")   // Hostname or pod identifier
  action        LockAction    // ACQUIRED, RELEASED, EXPIRED, RENEWAL_FAILED
  fencingToken  Int?          @map("fencing_token")
  ttlMs         Int           @map("ttl_ms")
  heldDurationMs Int?         @map("held_duration_ms")
  metadata      Json?         // Additional context (userId, bookingId, etc.)
  createdAt     DateTime      @default(now()) @map("created_at")

  @@index([resource, createdAt])
  @@index([lockId])
  @@index([podId, createdAt])
  @@map("lock_audits")
}

enum LockAction {
  ACQUIRED
  RELEASED
  EXPIRED
  RENEWAL_FAILED
  ACQUIRE_FAILED
  FORCE_RELEASED

  @@map("lock_action")
}

model LockMetrics {
  id                 String   @id @default(uuid())
  resource           String
  windowStart        DateTime @map("window_start")
  windowEnd          DateTime @map("window_end")
  totalAcquires      Int      @default(0) @map("total_acquires")
  totalFailures      Int      @default(0) @map("total_failures")
  totalExpirations   Int      @default(0) @map("total_expirations")
  avgHeldDurationMs  Float    @default(0) @map("avg_held_duration_ms")
  maxHeldDurationMs  Int      @default(0) @map("max_held_duration_ms")
  p99HeldDurationMs  Int      @default(0) @map("p99_held_duration_ms")
  avgRetryCount      Float    @default(0) @map("avg_retry_count")
  createdAt          DateTime @default(now()) @map("created_at")

  @@unique([resource, windowStart])
  @@map("lock_metrics")
}
```

The raw SQL migration for these tables:

```sql
-- Migration: create lock audit and metrics tables

CREATE TYPE lock_action AS ENUM (
  'ACQUIRED',
  'RELEASED',
  'EXPIRED',
  'RENEWAL_FAILED',
  'ACQUIRE_FAILED',
  'FORCE_RELEASED'
);

CREATE TABLE lock_audits (
  id                CHAR(36) PRIMARY KEY -- UUID generated by application,
  resource          TEXT NOT NULL,
  lock_id           TEXT NOT NULL,
  pod_id            TEXT NOT NULL,
  action            lock_action NOT NULL,
  fencing_token     INTEGER,
  ttl_ms            INTEGER NOT NULL,
  held_duration_ms  INTEGER,
  metadata          JSON,
  created_at        DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_lock_audits_resource_time
  ON lock_audits (resource, created_at);
CREATE INDEX idx_lock_audits_lock_id
  ON lock_audits (lock_id);
CREATE INDEX idx_lock_audits_pod_time
  ON lock_audits (pod_id, created_at);

CREATE TABLE lock_metrics (
  id                   CHAR(36) PRIMARY KEY -- UUID generated by application,
  resource             TEXT NOT NULL,
  window_start         DATETIME(6) NOT NULL,
  window_end           DATETIME(6) NOT NULL,
  total_acquires       INTEGER NOT NULL DEFAULT 0,
  total_failures       INTEGER NOT NULL DEFAULT 0,
  total_expirations    INTEGER NOT NULL DEFAULT 0,
  avg_held_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_held_duration_ms INTEGER NOT NULL DEFAULT 0,
  p99_held_duration_ms INTEGER NOT NULL DEFAULT 0,
  avg_retry_count      DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at           DATETIME(6) NOT NULL DEFAULT NOW(6),

  CONSTRAINT uq_lock_metrics_resource_window
    UNIQUE (resource, window_start)
);
```

And the Prisma Client code to record audit entries:

```typescript
// src/common/locks/lock-audit.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LockAction } from '@prisma/client';
import * as os from 'os';

@Injectable()
export class LockAuditService {
  private readonly logger = new Logger(LockAuditService.name);
  private readonly podId = process.env.HOSTNAME || os.hostname();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a lock acquisition event.
   */
  async recordAcquire(
    resource: string,
    lockId: string,
    ttlMs: number,
    fencingToken?: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.lockAudit.create({
        data: {
          resource,
          lockId,
          podId: this.podId,
          action: LockAction.ACQUIRED,
          ttlMs,
          fencingToken: fencingToken ?? null,
          metadata: metadata ?? undefined,
        },
      });
    } catch (error) {
      // Audit writes should never break the main flow.
      this.logger.error(`Failed to record lock acquire: ${error}`);
    }
  }

  /**
   * Record a lock release event with duration tracking.
   */
  async recordRelease(
    resource: string,
    lockId: string,
    ttlMs: number,
    acquiredAt: Date,
  ): Promise<void> {
    try {
      const heldDurationMs = Date.now() - acquiredAt.getTime();
      await this.prisma.lockAudit.create({
        data: {
          resource,
          lockId,
          podId: this.podId,
          action: LockAction.RELEASED,
          ttlMs,
          heldDurationMs,
        },
      });

      // Warn if the lock was held for more than 80% of the TTL.
      if (heldDurationMs > ttlMs * 0.8) {
        this.logger.warn(
          `Lock held for ${heldDurationMs}ms (TTL: ${ttlMs}ms) ` +
          `on ${resource}. Consider increasing TTL.`,
        );
      }
    } catch (error) {
      this.logger.error(`Failed to record lock release: ${error}`);
    }
  }

  /**
   * Query lock contention for a resource over a time window.
   */
  async getContention(
    resource: string,
    since: Date,
  ): Promise<{
    totalAcquires: number;
    totalFailures: number;
    avgDurationMs: number;
  }> {
    const [acquires, failures, avgDuration] = await Promise.all([
      this.prisma.lockAudit.count({
        where: {
          resource,
          action: LockAction.ACQUIRED,
          createdAt: { gte: since },
        },
      }),
      this.prisma.lockAudit.count({
        where: {
          resource,
          action: LockAction.ACQUIRE_FAILED,
          createdAt: { gte: since },
        },
      }),
      this.prisma.lockAudit.aggregate({
        where: {
          resource,
          action: LockAction.RELEASED,
          createdAt: { gte: since },
          heldDurationMs: { not: null },
        },
        _avg: { heldDurationMs: true },
      }),
    ]);

    return {
      totalAcquires: acquires,
      totalFailures: failures,
      avgDurationMs: avgDuration._avg.heldDurationMs ?? 0,
    };
  }
}
```

> **What If You Skip This?** Without lock auditing, debugging distributed lock issues is like debugging a race condition without logs. You know something went wrong (double booking, missing inventory), but you have no way to trace the sequence of lock acquisitions, releases, and expirations that led to the failure. Lock auditing turns a 12-hour debugging session into a 20-minute query.

---

## Lock Performance: Benchmarks and Tuning

Distributed locks add latency. Every lock acquisition is a network round-trip to Redis. Every release is another. The watchdog adds periodic background traffic. Here are real-world benchmarks from a system similar to our Global Booking System, measured on a 3-node Redis cluster with clients in the same data center.

### Benchmark Results

| Operation | P50 Latency | P99 Latency | P999 Latency |
|-----------|------------|------------|-------------|
| Single Redis SET NX (acquire) | 0.3 ms | 1.2 ms | 4.5 ms |
| Single Redis EVAL (release with Lua) | 0.4 ms | 1.5 ms | 5.1 ms |
| Full acquire + release cycle | 0.8 ms | 2.8 ms | 9.2 ms |
| Acquire with 1 retry | 52 ms | 105 ms | 210 ms |
| Acquire with 3 retries | 155 ms | 320 ms | 580 ms |
| Redlock acquire (5 instances) | 2.1 ms | 8.5 ms | 22 ms |
| Redlock full cycle (5 instances) | 3.8 ms | 12 ms | 35 ms |
| Watchdog renewal (single tick) | 0.3 ms | 1.1 ms | 3.8 ms |

### Tuning Guidelines

**1. Keep lock scope narrow.** Lock only the specific resource, not a broad category. Lock `inventory:TOKYO-042:2026-03-15` instead of `inventory:TOKYO-042`. The narrower the lock, the less contention.

**2. Minimize time under lock.** Do not perform slow operations (API calls, email sending, PDF generation) while holding a lock. Read data, write data, release lock — then do everything else.

```typescript
// BAD: Doing too much under the lock
await lockService.withLock(resource, async () => {
  const inventory = await checkInventory(roomId, date);
  await decrementInventory(roomId, date);
  await createBooking(userId, roomId, date);
  await sendConfirmationEmail(userId);        // SLOW — 200ms+
  await generateInvoicePDF(bookingId);        // SLOW — 500ms+
  await notifyPartnerHotel(hotelId, booking); // SLOW — external API call
});

// GOOD: Minimal work under the lock
const booking = await lockService.withLock(resource, async () => {
  const inventory = await checkInventory(roomId, date);
  if (inventory <= 0) throw new ConflictException('No rooms');
  await decrementInventory(roomId, date);
  return createBooking(userId, roomId, date);
});

// These happen AFTER the lock is released:
await sendConfirmationEmail(userId);
await generateInvoicePDF(booking.id);
await notifyPartnerHotel(hotelId, booking);
```

**3. Use pipeline for Redlock.** When acquiring Redlock across multiple instances, you can send SET commands in parallel (using `Promise.allSettled`) instead of sequentially. This reduces total acquisition time from `N * latency` to roughly `1 * latency`.

**4. Monitor lock contention ratios.** If more than 5% of lock acquisition attempts require retries, you likely have a hot resource. Consider sharding the resource or redesigning the data model to reduce contention.

> **Key Term:** **Lock contention** — The frequency at which multiple processes compete for the same lock simultaneously. High contention means many processes are trying to lock the same resource at the same time, leading to retries, increased latency, and reduced throughput. Contention above 10% is a red flag that your lock granularity is too coarse.

---

## What Happens When Redis Fails: Fallback Strategies

Redis is remarkably reliable, but it is not invincible. Network partitions, memory exhaustion, misconfigurations, and cloud provider outages can all take Redis offline. When that happens, your distributed locks stop working. What should your system do?

### Strategy 1: Fail Closed (Reject All Operations)

The safest approach: if you cannot acquire a lock, reject the operation. No lock means no guarantee of mutual exclusion, so do not proceed.

```typescript
async function bookRoomFailClosed(
  lockService: RedisLockService,
  userId: string,
  hotelId: string,
  date: Date,
): Promise<BookingResult> {
  try {
    return await lockService.withLock(
      `inventory:${hotelId}:${date.toISOString().split('T')[0]}`,
      async () => {
        // Normal booking logic...
        return processBooking(userId, hotelId, date);
      },
    );
  } catch (error) {
    if (error.message.includes('Could not acquire lock')) {
      // Redis may be down, or extreme contention.
      // Return a user-friendly error, do NOT proceed without a lock.
      return {
        success: false,
        reason: 'Booking system is temporarily unavailable. ' +
                'Please try again in a few moments.',
        retryAfterMs: 5000,
      };
    }
    throw error;
  }
}
```

**When to use:** Financial transactions, inventory with legal liability, medical records. Any situation where a double-write is worse than a temporary outage.

### Strategy 2: Fall Back to Database Locks

If Redis is unavailable, use the database itself for locking. PostgreSQL's `SELECT ... FOR UPDATE` provides row-level locking. It is slower than Redis (10x to 50x more latency), but it works without any external dependency.

```typescript
// Fallback: PostgreSQL advisory lock when Redis is unavailable
async function bookRoomWithFallback(
  lockService: RedisLockService,
  prisma: PrismaService,
  userId: string,
  hotelId: string,
  date: Date,
): Promise<BookingResult> {
  // Try Redis lock first.
  try {
    return await lockService.withLock(
      `inventory:${hotelId}:${date.toISOString().split('T')[0]}`,
      async () => processBooking(userId, hotelId, date),
      { retryCount: 1, retryDelayMs: 20 }, // Fewer retries — fail fast to fallback
    );
  } catch (redisError) {
    console.warn(
      `Redis lock unavailable, falling back to DB lock: ${redisError.message}`,
    );
  }

  // Fallback: Use PostgreSQL advisory lock.
  // pg_advisory_xact_lock takes an integer key and locks it
  // for the duration of the transaction.
  return prisma.$transaction(async (tx) => {
    // Generate a stable integer from the resource key.
    // Using a hash ensures consistent lock IDs across pods.
    const lockKey = hashStringToInt(`inventory:${hotelId}:${date}`);

    // This blocks until the lock is available (or the transaction times out).
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    // Now we hold a database-level lock. Process the booking.
    const inventory = await tx.inventory.findUnique({
      where: { hotelId_date: { hotelId, date } },
    });

    if (!inventory || inventory.availableQuantity <= 0) {
      throw new ConflictException('No rooms available.');
    }

    const [updated, booking] = await Promise.all([
      tx.inventory.update({
        where: { hotelId_date: { hotelId, date } },
        data: { availableQuantity: { decrement: 1 } },
      }),
      tx.booking.create({
        data: { userId, hotelId, checkInDate: date, status: 'CONFIRMED' },
      }),
    ]);

    return booking;
  }, { timeout: 10_000 }); // Transaction timeout acts as the lock TTL.
}

/**
 * Convert a string to a stable 32-bit integer for use as a
 * PostgreSQL advisory lock key.
 */
function hashStringToInt(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
```

**When to use:** Systems that can tolerate higher latency during Redis outages but cannot tolerate double-writes. The database fallback keeps the system running, albeit slower.

### Strategy 3: Fail Open (Proceed Without Lock)

The riskiest approach: if you cannot acquire a lock, proceed anyway and rely on other safeguards (database constraints, idempotency checks) to catch conflicts.

```typescript
// DANGEROUS: Only use this if you have strong database-level safeguards
async function bookRoomFailOpen(
  lockService: RedisLockService,
  prisma: PrismaService,
  userId: string,
  hotelId: string,
  date: Date,
): Promise<BookingResult> {
  let hasLock = false;

  try {
    // Try to get a lock, but don't fail if we can't.
    const lock = await lockService.acquire(
      `inventory:${hotelId}:${date.toISOString().split('T')[0]}`,
      { retryCount: 0 }, // No retries — just try once
    );
    hasLock = lock !== null;

    // Proceed with or without the lock.
    // The database constraint is our safety net.
    return await prisma.$transaction(async (tx) => {
      const result = await tx.$queryRaw<{ available_quantity: number }[]>`
        UPDATE inventory
        SET available_quantity = available_quantity - 1
        WHERE hotel_id = ${hotelId}
          AND date = ${date}
          AND available_quantity > 0
        RETURNING available_quantity
      `;

      if (result.length === 0) {
        throw new ConflictException('No rooms available.');
      }

      return tx.booking.create({
        data: { userId, hotelId, checkInDate: date, status: 'CONFIRMED' },
      });
    });
  } finally {
    if (hasLock) {
      await lockService.release({
        lockId: '', resource: '', fencingToken: null, acquiredAt: new Date(),
      });
    }
  }
}
```

**When to use:** Low-stakes operations where the database has strong constraints (CHECK, UNIQUE, triggers) that prevent invalid states. The lock is an optimization (reduces retries), not a correctness requirement.

> **Common Mistake:** Choosing "fail open" as the default because it seems like the most resilient option. Fail open means you are trusting your database constraints to catch every race condition. If you have a missing constraint, a wrong data type, or a logic bug in a trigger, fail-open lets the corruption through. Fail closed is almost always the correct default. Move to database fallback only after benchmarking, and use fail-open only for genuinely low-risk operations.

---

## Production War Story: The Black Friday Lock Storm

> **Production War Story:** A travel booking platform (similar to our Global Booking System) ran a "Black Friday" flash sale: 100 premium hotel rooms at 70% off, released at exactly midnight. They had 15,000 concurrent users hitting "Book Now" within the first 3 seconds.
>
> Their distributed lock was well-implemented — TTL, ownership, retries, the works. But they made one mistake: the lock key was `lock:flash-sale` instead of `lock:flash-sale:room:{roomId}`. All 15,000 requests competed for a single lock. One at a time. Each lock was held for about 40ms (database read + write). That is 15,000 x 40ms = 600 seconds = 10 minutes to process all requests, serial.
>
> The retry queue exploded. Redis memory spiked as 15,000 clients polled for the lock every 50ms. The Redis instance hit its max-memory limit and started evicting keys — including lock keys that were actively held. This caused phantom lock releases, double acquisitions, and ultimately 23 double-bookings on premium rooms.
>
> **The fix was two lines of code:** change the lock key from `lock:flash-sale` to `lock:flash-sale:room:${roomId}`. Now, instead of 15,000 users fighting for 1 lock, you have at most 150 users per room fighting for 100 independent locks. Lock contention dropped from 15,000:1 to 150:1. Processing time dropped from 10 minutes to under 2 seconds.
>
> **The lesson:** Lock granularity is the single most impactful tuning parameter for distributed locks. A lock that is too coarse serializes operations that could safely run in parallel. Always lock the narrowest possible resource.

---

## Common Mistakes with Distributed Locks

Here are the most frequent mistakes engineers make with distributed locks, collected from production incidents, code reviews, and post-mortems.

> **Common Mistake: #1 — Forgetting to release in error paths.** You acquire the lock, start processing, hit an unexpected exception, and the catch block does not release the lock. The lock sits until TTL expiry. Always use `try/finally` or the `withLock` pattern. Never rely on the happy path reaching your release call.

> **Common Mistake: #2 — Using Redis Cluster for locking.** Redis Cluster uses hash slots and automatic failover. During a failover, a lock key can be lost (the new primary may not have replicated it yet). If you need high-availability locks, use Redlock with independent Redis instances, not Redis Cluster replicas. Cluster replication is asynchronous — a lock written to the primary may not reach the replica before failover.

> **Common Mistake: #3 — Locking on user-provided input without sanitization.** If your lock key includes user input (like a hotel name), a malicious or buggy client can send empty strings, extremely long strings, or strings with special characters that corrupt your key space. Always validate and normalize lock keys.

```typescript
// BAD: Lock key from raw user input
const lockKey = `lock:${req.body.hotelName}`; // Could be "", or 10MB of garbage

// GOOD: Validated, normalized lock key
function buildLockKey(hotelId: string): string {
  if (!hotelId || hotelId.length > 64 || !/^[a-zA-Z0-9-]+$/.test(hotelId)) {
    throw new BadRequestException('Invalid hotel ID format.');
  }
  return `lock:inventory:${hotelId}`;
}
```

> **Common Mistake: #4 — No monitoring or alerting on lock failures.** You deploy distributed locks, they work fine for months, and then one day your Redis hits a connection limit. Lock acquisitions start failing silently. Users see "try again later" errors but no one on the team notices because there are no alerts. Always monitor: lock acquisition failure rate, average hold duration, and retry count.

> **Common Mistake: #5 — Holding locks across await boundaries you do not control.** If your locked section calls an external API or a third-party library that does something unexpected (like making HTTP calls or spawning child processes), you may hold the lock for seconds or minutes. Only call code you fully understand and control within a locked section.

> **Common Mistake: #6 — Not testing under contention.** Your lock works perfectly in a test where one request at a time arrives. It fails under 50 concurrent requests because of a subtle race in your retry logic. Always load-test your locking code with concurrency levels that match your production traffic.

```typescript
// Load test your locking with Artillery or a simple script:
async function stressTestLock(concurrency: number, iterations: number) {
  const results = { success: 0, failed: 0, errors: 0 };

  const workers = Array.from({ length: concurrency }, async () => {
    for (let i = 0; i < iterations; i++) {
      try {
        await lockService.withLock('stress-test-resource', async () => {
          // Simulate work
          await new Promise((r) => setTimeout(r, 10));
        });
        results.success++;
      } catch {
        results.failed++;
      }
    }
  });

  await Promise.all(workers);
  console.table(results);
}

// Run: 50 concurrent workers, 100 iterations each = 5,000 lock cycles
await stressTestLock(50, 100);
```

---

## Chapter Summary

| Concept | What It Does | When to Use |
|---------|-------------|-------------|
| **In-memory lock** | Serializes access within a single process using a `Map` or mutex | Single-server monolith only. Never in multi-pod deployments. |
| **SETNX (naive)** | Sets a Redis key if it does not exist. Basic distributed lock primitive. | Learning and prototyping. Do not use in production without TTL and ownership. |
| **SET EX NX** | Atomic set-if-not-exists with TTL expiration. Solves deadlock from crashed processes. | Standard production distributed lock for single-Redis deployments. |
| **Ownership (UUID value)** | Stores a unique ID in the lock value. Release checks ownership via Lua script. | Always. Every production lock must verify ownership before release. |
| **Retry with jitter** | Retries lock acquisition with randomized delays to spread out competing requests. | Always. Without retry, most lock failures under load are unnecessary rejections. |
| **Redlock** | Acquires the same lock on N independent Redis instances. Requires quorum majority. | When a single Redis failure is unacceptable. Financial or safety-critical systems. |
| **Watchdog / auto-renewal** | Background timer extends lock TTL periodically while the operation is running. | When operations may take longer than the TTL (variable-duration work). |
| **Fencing token** | Monotonically increasing integer validated by the database on every write. | When even a rare stale-lock write is unacceptable (financial, medical, legal). |
| **Lock audit trail** | Database records of every lock acquire, release, and expiration event. | Always in production. Essential for debugging distributed lock incidents. |
| **Database fallback** | Uses `pg_advisory_xact_lock` when Redis is unavailable. Slower but functional. | Systems that must remain operational during Redis outages. |
| **Fail closed** | Rejects operations when locks cannot be acquired. | Default strategy. Prioritizes correctness over availability. |
| **Fail open** | Proceeds without a lock, relying on DB constraints. | Low-stakes operations with strong database-level safeguards. |

> **Checkpoint:** Before moving to the next chapter, verify you can answer these questions: (1) Why does the Lua script for lock release need to be atomic? (2) What is the quorum formula for Redlock? (3) When should you choose fail-closed vs. database fallback vs. fail-open? (4) Why does lock granularity matter more than lock implementation for performance?

In the next chapter, we will build on distributed locks to implement **distributed transactions** — coordinating multi-step operations across multiple microservices using the Saga pattern. The locks we built here become the foundation for ensuring each step in a saga executes exclusively, without interference from concurrent sagas operating on the same resources.
