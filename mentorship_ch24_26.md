# Chapter 24: Cache Strategy & Invalidation — The Hardest Problem

## You Already Cache. You Just Don't Know It Yet.

Think about the last time you built a CRUD endpoint. Something like this:

```typescript
app.get('/api/products/:id', async (req, res) => {
  const product = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  res.json(product.rows[0]);
});
```

Every time a user visits the product page, you hit the database. One user? Fine. Ten users looking at the same product in the same second? Ten identical queries. A hundred users? A hundred identical queries, all returning the exact same data that has not changed since yesterday.

You have probably written something like this before to avoid that waste:

```typescript
const cache = new Map();

app.get('/api/products/:id', async (req, res) => {
  const key = `product:${req.params.id}`;

  if (cache.has(key)) {
    return res.json(cache.get(key)); // Skip the database entirely
  }

  const product = await db.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
  cache.set(key, product.rows[0]);
  res.json(product.rows[0]);
});
```

That is caching. You already understand the core idea: if you have recently fetched something and it has not changed, do not fetch it again. Return what you already have.

But here is where things get interesting. That `Map()` lives in your Node.js process memory. Restart the server and the cache is gone. Run two instances behind a load balancer and they each have their own cache -- User A's request populates Instance 1's cache, but User B hits Instance 2 and gets a cache miss. And the biggest question of all: when the product data changes in the database, your cache still holds the old data. How long do you serve stale information? How do you know *when* to throw the cached version away?

That last question is so notoriously difficult that there is a famous quote in computer science, attributed to Phil Karlton:

> "There are only two hard things in Computer Science: cache invalidation and naming things."

It is funny because it is painfully true. In this chapter, we are going to tackle the hard thing head-on.

---

## Why Caching Is Not Optional at Scale

Let us talk numbers. Our booking system handles 1,666 bookings per second. But bookings are just the write side. For every person who books, dozens more are *searching*. They are checking hotel availability, comparing prices, browsing property details, and looking at their booking history. The read-to-write ratio in our system is roughly 70/30. That means the read path alone generates approximately **3,888 queries per second**.

A single MySQL database can handle maybe a few hundred complex queries per second before response times start degrading. At 3,888 queries per second, your database is drowning. Queries that used to return in 5 milliseconds now take 500 milliseconds because the database is spending all its time context-switching between connections, waiting on disk I/O, and fighting for lock contention.

> **Analogy:** Imagine a librarian in a small-town library. When three people ask for book recommendations at the same time, the librarian handles it gracefully. Now imagine 4,000 people walk in simultaneously, all asking the same question: "What are the best hotels in Tokyo?" The librarian could answer the first person, write the answer on a whiteboard at the entrance, and point everyone else to the whiteboard. That whiteboard is your cache. Instead of the librarian (your database) answering the same question 4,000 times, she answers it once, and the whiteboard serves everyone else.

With a well-designed cache sitting in front of the database, the vast majority of those 3,888 reads per second never touch the database at all. They get answered in **single-digit milliseconds** from Redis, which stores data in RAM. Your database goes from drowning to barely noticing the traffic.

> **Key Term:** **Cache** — A temporary storage layer (usually in-memory, like Redis) that holds copies of frequently accessed data. Reads check the cache first. If the data is there (a *cache hit*), the database is never touched. If it is not there (a *cache miss*), the database is queried and the result is stored in the cache for next time.

> **What If You Skip This?** Without caching, every search request, every availability check, every profile lookup hits the database directly. At scale, this means your p99 latency (the response time for the slowest 1% of requests) climbs from 10ms to over 500ms. Users notice. They leave. And if traffic spikes -- say, a flash sale or a holiday rush -- the database collapses entirely. You get connection pool exhaustion, timeouts, and a full outage. Caching is not a performance optimization at this scale. It is a survival requirement.

---

## The Three Caching Patterns You Need to Know

There are three fundamental caching strategies: cache-aside, write-through, and write-behind. Each answers the same question differently: "Who puts data into the cache, and when?"

### Pattern 1: Cache-Aside (Lazy Loading)

This is what you did with the `Map()` example above, formalized into a proper pattern. The application code is responsible for managing the cache:

1. Application receives a read request.
2. Application checks the cache. If the data is there, return it. Done.
3. If the data is not there (cache miss), query the database.
4. Store the database result in the cache.
5. Return the result.

```
   ┌──────────┐         ┌─────────┐         ┌──────────┐
   │  Client  │────1───►│   App   │────2───►│  Cache   │
   │          │         │ Server  │◄───────│ (Redis)  │
   │          │         │         │         └──────────┘
   │          │         │         │  cache miss
   │          │         │         │────3───►┌──────────┐
   │          │         │         │◄────────│ Database │
   │          │◄──5─────│         │────4───►│          │
   │          │         │         │         │ (MySQL)  │
   └──────────┘         └─────────┘         └──────────┘

   1: GET /api/hotels/tokyo
   2: redis.get("hotel:tokyo") → miss!
   3: SELECT * FROM hotels WHERE city = 'tokyo'
   4: redis.setex("hotel:tokyo", 300, data)
   5: Return data to client
```

This is the pattern our booking system uses. Here is the core implementation:

```typescript
interface CacheOptions {
  earlyExpiry?: boolean;       // Should we refresh before actual expiry?
  preventStampede?: boolean;   // Should we prevent thundering herd?
}

export class CacheService {
  private readonly defaultTTL = 3600; // 1 hour in seconds

  // The heart of cache-aside: check cache first, fall back to DB
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,     // The function that queries the database
    ttlSeconds: number = this.defaultTTL,
    options: CacheOptions = {}
  ): Promise<T> {
    // Step 1: Try the cache first
    const cached = await redis.get(`cache:${key}`);

    if (cached) {
      // Cache HIT -- we found the data. Parse it and return.
      const parsed = JSON.parse(cached);

      // (We will explain earlyExpiry in the stampede section below)
      if (options.earlyExpiry) {
        const ttl = await redis.ttl(`cache:${key}`);
        const expiryWindow = ttlSeconds * 0.1;  // Last 10% of the TTL
        if (ttl < expiryWindow && Math.random() < 0.1) {
          // 10% chance to refresh early -- we explain WHY soon
          this.refreshInBackground(key, fetchFn, ttlSeconds);
        }
      }

      return parsed;
    }

    // Step 2: Cache MISS -- data is not in Redis

    // If stampede prevention is on, use a distributed lock
    if (options.preventStampede) {
      return await this.fetchWithLock(key, fetchFn, ttlSeconds);
    }

    // Step 3: Standard miss -- query the database, store in cache
    const value = await fetchFn();
    await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
    //        ^^^^^^^^ SETEX = SET with EXpiry. The key auto-deletes after ttlSeconds.
    return value;
  }
}
```

Let us walk through this line by line because this is the code that sits in the hot path of every read request in the system.

The `getOrSet` method takes four arguments. The `key` is the cache key -- something like `"hotel:tokyo:2026-03-15"`. The `fetchFn` is a function that queries the database -- you pass this in, and the cache service only calls it on a miss. The `ttlSeconds` is how long the cached value should live (we will discuss choosing this value soon). And `options` controls two advanced features we will cover shortly.

The first thing we do is check Redis. If the key exists, we have a cache hit. We parse the JSON and return it. The database is never touched. This is where the performance win comes from.

If the key does not exist, we have a cache miss. We call `fetchFn()` to query the database, store the result in Redis with a TTL (time-to-live), and return the result. The next request for this key will be a cache hit.

> **Key Term:** **TTL (Time-To-Live)** — The lifespan of a cached value in seconds. After the TTL expires, Redis automatically deletes the key. The next request will be a cache miss and will query the database again. TTL is the simplest form of cache invalidation: "just delete it after a while."

### Pattern 2: Write-Through

With write-through, every write to the database also immediately writes to the cache. The cache is always up to date because it is populated on writes, not just on reads.

```
   ┌──────────┐         ┌─────────┐   write   ┌──────────┐
   │  Client  │────1───►│   App   │────2a────►│ Database │
   │          │         │ Server  │────2b────►│          │
   │          │◄──3─────│         │           └──────────┘
   └──────────┘         │         │────2b────►┌──────────┐
                        │         │           │  Cache   │
                        └─────────┘           └──────────┘

   1: POST /api/bookings (create booking)
   2a: INSERT INTO bookings ... (write to DB)
   2b: redis.set("booking:123", data) (write to cache simultaneously)
   3: Return confirmation
```

The advantage: the cache is never stale immediately after a write. The disadvantage: every write operation now takes longer because you are writing to two places. If the cache write fails, you have a consistency problem.

### Pattern 3: Write-Behind (Write-Back)

Write-behind flips the script. Writes go to the cache first, and the cache asynchronously flushes to the database later. This makes writes extremely fast but introduces a risk: if the cache crashes before flushing, you lose data.

```
   ┌──────────┐         ┌─────────┐   write   ┌──────────┐
   │  Client  │────1───►│   App   │────2─────►│  Cache   │
   │          │◄──3─────│ Server  │           │ (Redis)  │
   └──────────┘         └─────────┘           └─────┬────┘
                                              async │ flush
                                                    ▼
                                              ┌──────────┐
                                              │ Database │
                                              └──────────┘

   1: POST /api/bookings
   2: Write to Redis only (fast!)
   3: Return immediately
   Later: Redis flushes the write to MySQL in the background
```

This is dangerous for booking data -- if Redis crashes before the flush, the booking is lost and the customer has a confirmation for a reservation that does not exist. We do **not** use write-behind for transactional data. But it is useful for things like analytics counters and view counts where losing a few data points is acceptable.

### Which Pattern Do We Use?

| Pattern | Writes To | Reads From | Best For | Risk |
|---|---|---|---|---|
| **Cache-Aside** | DB first, then cache on read | Cache, then DB on miss | General purpose, most of our system | Stale data between write and cache refresh |
| **Write-Through** | DB + Cache simultaneously | Always cache | Data that is read immediately after writing | Slower writes, cache consistency on failure |
| **Write-Behind** | Cache first, DB later | Always cache | Analytics, counters, non-critical data | Data loss if cache crashes before flush |

Our booking system uses **cache-aside** for most operations. It is the simplest, most battle-tested pattern, and it works well when combined with the invalidation strategies we are about to discuss.

---

## TTL Strategy: Not All Data Is Created Equal

Here is a mistake people make early on: they set one TTL for everything. "Just cache everything for an hour." But think about it: flight prices change every few minutes. A country code list changes maybe once a year. Using the same TTL for both is either wasteful (refreshing country codes every hour for no reason) or dangerous (showing flight prices that are 59 minutes stale).

Our system uses a tiered TTL strategy based on how volatile the data is:

```typescript
export const cacheTTLStrategy = {
  search: {
    hotelSearch: 300,        // 5 minutes -- availability changes frequently
    flightSearch: 120,       // 2 minutes -- prices are very dynamic
    carSearch: 600           // 10 minutes -- car rental is less volatile
  },
  inventory: {
    availability: 30,        // 30 seconds -- near real-time is critical
    pricing: 300,            // 5 minutes
    hotelDetails: 3600       // 1 hour -- hotel descriptions rarely change
  },
  user: {
    profile: 1800,           // 30 minutes
    bookingHistory: 600,     // 10 minutes
    preferences: 3600        // 1 hour
  },
  static: {
    currencies: 86400,       // 24 hours -- currency list is stable
    countries: 86400,        // 24 hours
    bookingTypes: 86400      // 24 hours
  }
};
```

Notice the pattern: the more frequently data changes, the shorter the TTL. Availability uses a 30-second TTL because showing a room as available when it was booked 45 seconds ago leads to a terrible user experience -- or worse, an overbooking. Hotel descriptions (name, address, amenities) use a 1-hour TTL because they almost never change.

> **Checkpoint:** If someone asked you "what TTL should I use for my cached data?", what would you tell them? The answer is: it depends on how often the data changes and how bad it is if a user sees stale data. For booking availability, stale data means potential overbooking -- use a short TTL. For a list of country names, stale data means someone sees "Czechia" instead of its new name for an extra 24 hours -- acceptable. Match the TTL to the consequence of staleness.

---

## Cache Invalidation: Actively Deleting Stale Data

TTL is passive invalidation. You set a timer and wait for it to expire. But what happens when a booking is created *right now*? The availability cache says there are 3 rooms left, but someone just booked one. Do you wait 30 seconds (the TTL) for the cache to expire? In those 30 seconds, other users see "3 rooms available" and might try to book a room that no longer exists.

The solution is **active invalidation**: when the data changes, we immediately delete the cached version. In our system, we do this with Kafka events. When the Inventory Service reserves a room, it publishes an `inventory.reserved` event. A cache invalidation consumer listens for these events and deletes the relevant cache entries:

```typescript
// This consumer listens to Kafka and kills stale cache entries
export class CacheInvalidationConsumer {
  async start(): Promise<void> {
    // Subscribe to topics that represent data changes
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events'],
      fromBeginning: false
      // fromBeginning: false means we only care about NEW events,
      // not replaying the entire event history
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'inventory.updated':
          case 'inventory.reserved':
            // Room availability changed -- kill the availability cache
            await cacheService.invalidate(`inventory:${event.payload.resourceId}:*`);
            // Also kill search results since they include availability
            await cacheService.invalidate(`search:*`);
            break;

          case 'booking.created':
          case 'booking.cancelled':
            // A booking was created or cancelled
            await cacheService.invalidate(`booking:${event.payload.bookingId}`);
            // Also invalidate this user's booking history cache
            await cacheService.invalidate(`user:${event.payload.userId}:bookings`);
            break;

          case 'price.updated':
            // Pricing changed for a resource
            await cacheService.invalidate(`pricing:${event.payload.resourceId}:*`);
            break;
        }
      }
    });
  }
}
```

When a booking is created, two things happen in the cache: the individual booking cache entry is deleted, and the user's booking history cache is deleted. The next time anyone requests that booking or that user's history, it will be a cache miss, the database will be queried, and fresh data will be stored.

### Why SCAN, Not KEYS

You might have noticed the `invalidate` method uses a wildcard pattern like `inventory:TOKYO-042:*`. That means we need to find all Redis keys matching that pattern and delete them. Redis has two ways to do this: `KEYS` and `SCAN`.

**Never use `KEYS` in production.** Here is why:

```typescript
// BAD: redis.keys() blocks the Redis server
// It scans EVERY key in the database in a single operation.
// If you have 10 million keys, Redis freezes for seconds.
// During that freeze, NOTHING else can use Redis. No cache reads.
// No distributed locks. No session lookups. Complete blackout.
const keys = await redis.keys('cache:inventory:*');  // DO NOT DO THIS

// GOOD: redis.scan() does the same work in small batches
// Each batch scans ~100 keys and returns immediately.
// Between batches, Redis can serve other requests normally.
async invalidate(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    // SCAN returns a cursor and a batch of matching keys
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH', `cache:${pattern}`,
      'COUNT', 100  // Process ~100 keys per batch
    );
    cursor = nextCursor;

    if (keys.length > 0) {
      await redis.del(...keys);  // Delete this batch
    }
  } while (cursor !== '0');  // cursor '0' means we have scanned everything
}
```

The `SCAN` command is iterative. It processes keys in small batches (roughly 100 at a time), returning a cursor that tells you where to continue. Between batches, Redis can handle other commands normally. The `KEYS` command does the entire scan in one blocking operation. In a production system with millions of keys, `KEYS` can freeze Redis for several seconds -- an eternity when your cache layer is supposed to respond in under a millisecond.

> **Key Term:** **SCAN** — A Redis command that iterates over keys incrementally, in small batches, without blocking the server. Unlike `KEYS`, which returns all matching keys at once (blocking Redis until it is done), `SCAN` is safe for production use. Always use `SCAN` when you need to find keys by pattern.

---

## Cache Stampede: The Thundering Herd

Here is a scenario that catches many teams off guard. You cache hotel search results for Tokyo with a 5-minute TTL. The cache is warm -- thousands of users are getting fast responses. Then the TTL expires. The cached data disappears from Redis. And in the next 50 milliseconds, 10,000 users all search for hotels in Tokyo.

Every single one of those 10,000 requests hits a cache miss. Every single one queries the database. At the same time. Your database, which was peacefully handling 50 queries per second, suddenly gets hit with 10,000 simultaneous identical queries. It buckles. Response times spike. Some queries time out. Users see errors.

This is called a **cache stampede** (also known as the "thundering herd" problem).

> **Key Term:** **Cache Stampede (Thundering Herd)** — A failure scenario where a cached value expires and thousands of simultaneous requests all experience a cache miss at the same instant, flooding the database with identical queries. Prevented with distributed locks (only one request refreshes the cache) and probabilistic early refresh (refreshing before the TTL actually expires).

> **Analogy:** Imagine a popular coffee shop has one entrance door. At 7:00 AM sharp, the door opens. A hundred people who have been waiting outside all try to squeeze through the door at the same instant. Nobody gets through quickly. That is a cache stampede. A smarter approach: let one person through first to check if the coffee is ready, and have everyone else wait a few seconds for that person's report.

```
   5-minute TTL expires
           │
           ▼
   ┌───────────────────────────┐
   │  10,000 simultaneous      │
   │  cache misses!             │
   │                           │
   │  Request 1 ──► Database   │
   │  Request 2 ──► Database   │
   │  Request 3 ──► Database   │
   │  ...                      │
   │  Request 10,000 ──► DB    │
   │                           │
   │  All running the SAME     │
   │  query at the SAME time   │
   └───────────────────────────┘
           │
           ▼
   Database overwhelmed. Timeouts. Errors. Chaos.
```

Our system prevents stampedes with two complementary techniques:

### Technique 1: Distributed Lock on Cache Refresh

When a cache miss occurs, only one instance acquires a lock and refreshes the cache. Everyone else waits briefly and then reads from the now-refreshed cache:

```typescript
private async fetchWithLock<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number
): Promise<T> {
  const lockKey = `cache:lock:${key}`;
  // NX = "only set if Not eXisting" -- only one caller wins this race
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  //                                              ^^^^^^ lock expires in 5 seconds
  //                                                     (safety net if the winner crashes)

  if (!acquired) {
    // Someone else is already refreshing. Wait briefly, then check the cache.
    await new Promise(resolve => setTimeout(resolve, 100)); // wait 100ms
    const cached = await redis.get(`cache:${key}`);
    if (cached) return JSON.parse(cached);  // The winner finished -- use their result
    return await fetchFn();  // Still no cache? Give up waiting, query DB directly
  }

  // We won the lock -- we are responsible for refreshing the cache
  try {
    const value = await fetchFn();          // Query the database
    await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value)); // Store result
    return value;
  } finally {
    await redis.del(lockKey);  // Release the lock so the next miss can refresh
  }
}
```

Out of 10,000 simultaneous requests, only one actually queries the database. The other 9,999 wait 100 milliseconds and then read the freshly cached result. The database sees 1 query instead of 10,000.

### Technique 2: Probabilistic Early Refresh

The lock approach reacts to a stampede after it starts. Probabilistic early refresh *prevents* the stampede from starting at all:

```typescript
// Inside the cache hit path -- the data IS in the cache
if (options.earlyExpiry) {
  const ttl = await redis.ttl(`cache:${key}`);       // How much TTL is left?
  const expiryWindow = ttlSeconds * 0.1;             // Last 10% of the TTL
  if (ttl < expiryWindow && Math.random() < 0.1) {   // 10% chance in the last 10%
    // Refresh the cache NOW, in the background, before it expires
    this.refreshInBackground(key, fetchFn, ttlSeconds);
  }
}
```

Here is the idea: when a cache entry is in the last 10% of its TTL (for a 5-minute TTL, that is the last 30 seconds), each request that hits the cache has a 10% random chance of triggering a background refresh. "Background" means the current request still returns the cached data immediately -- the user is not waiting. But behind the scenes, the cache is being refreshed with fresh data from the database.

The beauty of this approach: by the time the TTL actually expires, the cache has almost certainly already been refreshed. There is no moment where all 10,000 requests discover an empty cache simultaneously.

```typescript
private refreshInBackground<T>(
  key: string,
  fetchFn: () => Promise<T>,
  ttlSeconds: number
): void {
  // Fire and forget -- the current request does NOT wait for this
  fetchFn().then(value => {
    redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
  }).catch(err => {
    // If the background refresh fails, no big deal.
    // The existing cached data is still served until TTL actually expires.
    console.warn(`Background cache refresh failed for ${key}:`, err.message);
  });
}
```

> **Checkpoint:** Can you explain the difference between TTL-based invalidation and event-driven invalidation? When would you use each? Hint: TTL is a safety net that guarantees data is *eventually* refreshed. Event-driven invalidation is a precision tool that purges data *immediately* when it changes. In practice, you use both: events for fast invalidation, TTL as a backstop in case the event is lost or delayed.

---

## Chapter 24 Summary

| Concept | One-Sentence Summary |
|---|---|
| Cache-Aside | Application checks cache first, queries DB on miss, stores result in cache for next time. |
| Write-Through | Every DB write simultaneously writes to cache; cache is always fresh but writes are slower. |
| Write-Behind | Writes go to cache first, flush to DB later; fast but risks data loss if cache crashes. |
| TTL | Automatic expiry timer on cached data; shorter for volatile data, longer for stable data. |
| Event-Driven Invalidation | Kafka events trigger immediate cache deletion when source data changes. |
| SCAN vs. KEYS | SCAN iterates keys in safe batches; KEYS blocks Redis entirely. Never use KEYS in production. |
| Cache Stampede | Thousands of simultaneous cache misses overwhelming the database; prevented with locks and early refresh. |

---

# Chapter 25: Dead Letter Queue — Where Failed Messages Go

## The Problem: What Happens When Things Go Wrong?

In the last several chapters, you have seen Kafka at work. A booking is created, an event is published, and downstream consumers process that event -- updating search indexes, sending confirmation emails, triggering payment processing. When everything works, events flow smoothly from producer to consumer like packages on a conveyor belt.

But what happens when a consumer *cannot* process a message?

Maybe the downstream database is temporarily down. Maybe the message contains unexpected data -- a booking with a null user ID. Maybe a new code deployment introduced a bug that crashes the consumer when it encounters a specific edge case. Maybe the email provider's API is returning 503 errors.

In a simple Express app, when something goes wrong, you return a 500 error to the user and they try again. But Kafka consumers are not handling live HTTP requests. They are pulling messages off a topic and processing them in the background. If a consumer crashes while processing a message, what happens to that message?

Without a strategy, one of two bad things happens:

1. **The message is lost.** The consumer acknowledged it before processing finished, or the consumer group moves past it. A real customer's booking confirmation email is never sent. A payment is never processed. Nobody knows.

2. **The message blocks the queue.** The consumer keeps retrying the same message in an infinite loop. Every retry fails. The message behind it -- maybe a perfectly valid booking -- cannot be processed because the broken message is blocking the path. The entire pipeline backs up.

Neither outcome is acceptable. We need a third option.

> **Analogy:** Think of a post office. Most letters are deliverable -- they have a valid address, proper postage, and they reach the recipient. But some letters cannot be delivered. The address does not exist. The recipient moved. The postage is insufficient. The post office does not throw these letters in the trash, and it does not keep sending the same mail carrier to the same nonexistent address forever. Instead, undeliverable mail goes to a special department -- the **Dead Letter Office** -- where clerks inspect the letters, try to figure out what went wrong, and either fix the problem (forward to the new address) or return the letter to the sender. A Dead Letter Queue in Kafka works exactly the same way.

> **Key Term:** **Dead Letter Queue (DLQ)** — A special Kafka topic (or message queue destination) where messages that cannot be successfully processed after multiple retry attempts are sent. Messages in the DLQ are preserved for inspection, debugging, and selective reprocessing. They represent real user actions that failed and need human or automated attention.

> **What If You Skip This?** Without a DLQ, failed messages either disappear silently (data loss) or loop forever (pipeline blockage). In a booking system, a lost message might mean a customer is charged but never receives a confirmation. A blocked pipeline might mean thousands of legitimate bookings are stuck behind one bad message. DLQs are the safety net that ensures no customer action silently vanishes.

---

## The Retry Chain: Graduated Second Chances

Before a message lands in the DLQ, we give it multiple chances to succeed. But we do not retry immediately -- if the downstream service is overloaded, hammering it with instant retries makes the problem worse. Instead, we use **graduated delays**: each retry waits longer than the last.

Here is the chain:

```
  Main Topic (e.g., "booking-events")
      │
      │  processing fails
      ▼
  retry-1  ─── wait 1 second, then try again
      │
      │  still fails
      ▼
  retry-2  ─── wait 10 seconds, then try again
      │
      │  still fails
      ▼
  retry-3  ─── wait 1 minute, then try again
      │
      │  still fails
      ▼
  retry-4  ─── wait 5 minutes, then try again
      │
      │  still fails
      ▼
  retry-5  ─── wait 1 hour, then try again (FINAL attempt)
      │
      │  STILL fails
      ▼
  dlq-booking-events  ─── Dead Letter Queue (needs human attention)
```

Why these specific delays? Think about what kinds of failures happen at each timescale:

- **1 second:** Network blip, momentary connection reset. Retrying immediately might work.
- **10 seconds:** A service is restarting after a deployment. It will be back in a few seconds.
- **1 minute:** A database connection pool is exhausted. It needs time to drain.
- **5 minutes:** A downstream API is experiencing an outage. Their on-call team is probably working on it.
- **1 hour:** A serious infrastructure issue. If it is not fixed in an hour, it needs human investigation.

If the message fails all five retries, something is genuinely wrong with this specific message -- not just a transient failure. It goes to the DLQ.

> **Analogy:** Imagine you are trying to deliver a certified letter. You knock on the door -- nobody home. You come back tomorrow (retry 1). Still nobody. You leave a note and come back in three days (retry 2). Still nothing. You try one more time a week later (retry 3). After that, the letter goes back to the Dead Letter Office. You gave it an honest effort, but at some point you have to stop knocking and escalate.

---

## The Code: Moving Messages Through the Retry Chain

Let us walk through the implementation. The `RetryTopicChain` class manages the entire retry flow:

```typescript
export class RetryTopicChain {
  // Define the retry levels with their topics and delays
  private readonly retryTopics = [
    { topic: 'retry-1', delayMs: 1000 },      // 1 second
    { topic: 'retry-2', delayMs: 10000 },      // 10 seconds
    { topic: 'retry-3', delayMs: 60000 },      // 1 minute
    { topic: 'retry-4', delayMs: 300000 },     // 5 minutes
    { topic: 'retry-5', delayMs: 3600000 }     // 1 hour (final retry)
  ];

  async handleFailedMessage(
    originalTopic: string,   // Which topic this message originally came from
    message: any,            // The message that failed
    error: Error,            // What went wrong
    retryCount: number = 0   // How many retries we have already attempted
  ): Promise<void> {

    // Have we exhausted all retry attempts?
    if (retryCount >= this.retryTopics.length) {
      // Yes -- this message has failed 5 times. Send it to the DLQ.
      await this.sendToDLQ(originalTopic, message, error, retryCount);
      return;
    }

    // No -- we still have retries left. Send to the next retry topic.
    const retryConfig = this.retryTopics[retryCount];

    await kafka.send({
      topic: retryConfig.topic,
      messages: [{
        key: message.key,    // Same key as original for partition ordering
        value: JSON.stringify({
          originalTopic,                                   // Where this came from
          originalMessage: message,                        // The original payload
          retryCount: retryCount + 1,                      // Increment the counter
          error: { message: error.message, stack: error.stack }, // Why it failed
          scheduledFor: Date.now() + retryConfig.delayMs,  // When to try again
          firstFailedAt: message.firstFailedAt || new Date().toISOString()
          //             ^^^^^^^^^^^^^^^^^^^^^^^^ Track when the FIRST failure happened,
          //                                     not the latest one
        }),
        headers: {
          'retry-count': (retryCount + 1).toString(),
          'original-topic': originalTopic,
          'error-type': error.constructor.name
          //            ^^^^^^^^^^^^^^^^^ Was it a TypeError? ConnectionError?
          //                              Useful for debugging patterns of failure.
        }
      }]
    });

    // Track retry metrics for monitoring dashboards
    metrics.messageRetries.inc({
      topic: originalTopic,
      retry_level: retryCount + 1
    });
  }
}
```

Let us trace through a concrete example. A `booking.created` event is published. The Notification Service tries to process it but the email provider (SendGrid) is returning 503 errors:

1. **First attempt:** Notification Service picks up the message from `booking-events`. It tries to call SendGrid. SendGrid returns 503. The consumer calls `handleFailedMessage('booking-events', message, error, 0)`.

2. **Retry 1:** The message is sent to the `retry-1` topic with `scheduledFor: now + 1000ms`. A retry consumer picks it up after 1 second and tries again. SendGrid is still down. `handleFailedMessage` is called with `retryCount: 1`.

3. **Retry 2:** The message goes to `retry-2`. The consumer waits 10 seconds and tries again. Still failing. `retryCount: 2`.

4. **Retry 3:** Wait 1 minute. Try again. `retryCount: 3`. This time, SendGrid is back! The email is sent. The message is successfully processed. The retry chain stops here.

But if SendGrid stayed down through all five retries, the message eventually reaches the DLQ:

```typescript
private async sendToDLQ(
  originalTopic: string,
  message: any,
  error: Error,
  retryCount: number
): Promise<void> {
  // Send to a DLQ topic named after the original topic
  // e.g., "booking-events" -> "dlq-booking-events"
  await kafka.send({
    topic: `dlq-${originalTopic}`,
    messages: [{
      key: message.key,
      value: JSON.stringify({
        originalTopic,                           // Where this came from
        originalMessage: message,                // The full original message
        totalRetries: retryCount,                // How many times we tried
        error: { message: error.message, stack: error.stack }, // Last error
        firstFailedAt: message.firstFailedAt,    // When the saga of failure began
        sentToDLQAt: new Date().toISOString()    // When we gave up
      })
    }]
  });

  // Increment the DLQ counter for alerting
  metrics.dlqMessages.inc({ topic: originalTopic });

  // Log loudly -- DLQ messages need attention
  console.error(`Message sent to DLQ for topic ${originalTopic}`, {
    error: error.message,
    retries: retryCount
  });
}
```

Notice several things about this code:

- The DLQ topic is named `dlq-{originalTopic}`. This keeps DLQ messages organized by their source. You can inspect the `dlq-booking-events` topic to see only failed booking messages, separate from failed payment or notification messages.
- We preserve the **entire original message**. When someone investigates later, they need to see exactly what the message contained, not a summary.
- We track `firstFailedAt` and `sentToDLQAt`. This tells investigators how long the message was in the retry chain before giving up. If `firstFailedAt` is 8:00 AM and `sentToDLQAt` is 9:06 AM, the message spent about an hour in retries (1s + 10s + 60s + 300s + 3600s).
- We increment a metric counter. Your monitoring dashboard should have an alert: "If the DLQ counter exceeds 10 messages in 5 minutes, page the on-call engineer."

---

## Inspecting and Replaying DLQ Messages

Messages in the DLQ are not garbage. They represent real user actions -- real bookings, real payments, real notifications -- that failed. Once the root cause is fixed (the downstream service is back, the data bug is patched, the code is corrected), you want to **replay** those messages so the original action completes.

Here is the DLQ consumer that supports inspection and replay:

```typescript
interface DLQMessage {
  originalTopic: string;
  originalMessage: any;
  totalRetries: number;
  error: { message: string; stack?: string };
  firstFailedAt: string;
  sentToDLQAt: string;
}

export class DLQConsumer {
  // Read messages from the DLQ for inspection
  async inspectDLQ(topic: string, limit: number = 100): Promise<DLQMessage[]> {
    // Create a unique consumer group so we don't interfere with real consumers
    const consumer = kafka.consumer({ groupId: `dlq-inspector-${Date.now()}` });
    //                                         ^^^^^^^^^^^^^^^^^^^^^^^^ unique each time
    //                                         so multiple inspections don't conflict
    await consumer.connect();
    await consumer.subscribe({ topic: `dlq-${topic}`, fromBeginning: true });
    //                                                  ^^^^^^^^^^^^^^^^
    //                                                  Read ALL messages in the DLQ,
    //                                                  not just new ones

    const messages: DLQMessage[] = [];

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (messages.length >= limit) return;  // Stop after 'limit' messages
        messages.push(JSON.parse(message.value.toString()));
      }
    });

    // Give it a moment to consume available messages
    await new Promise(resolve => setTimeout(resolve, 2000));
    await consumer.disconnect();

    return messages;
  }

  // Replay a single message back to its original topic
  async replayMessage(dlqMessage: DLQMessage): Promise<void> {
    await kafka.send({
      topic: dlqMessage.originalTopic,  // Send it back where it came from
      messages: [{
        key: dlqMessage.originalMessage.key,
        value: JSON.stringify(dlqMessage.originalMessage),
        headers: {
          'replayed-from-dlq': 'true',          // Flag so consumers know this is a replay
          'original-error': dlqMessage.error.message  // Context about why it failed before
        }
      }]
    });
  }

  // Replay ALL messages from a DLQ topic (use after fixing the root cause)
  async replayAll(topic: string): Promise<{ replayed: number; failed: number }> {
    const messages = await this.inspectDLQ(topic, 1000);
    let replayed = 0, failed = 0;

    for (const msg of messages) {
      try {
        await this.replayMessage(msg);
        replayed++;
      } catch (error) {
        failed++;
      }
    }

    return { replayed, failed };
  }
}
```

Here is a real-world scenario for how this plays out:

1. **Monday, 8:00 AM:** SendGrid has an outage. Confirmation emails stop sending. Messages pile up in the retry chain.
2. **Monday, 9:06 AM:** Messages that have exhausted all five retries start arriving in `dlq-booking-events`.
3. **Monday, 9:15 AM:** Your monitoring alert fires: "DLQ counter for booking-events exceeded 10 in 5 minutes."
4. **Monday, 9:20 AM:** The on-call engineer investigates. They use `inspectDLQ('booking-events')` and see 47 messages, all with the error "SendGrid API returned 503."
5. **Monday, 10:00 AM:** SendGrid announces the outage is resolved.
6. **Monday, 10:05 AM:** The engineer calls `replayAll('booking-events')`. Result: `{ replayed: 47, failed: 0 }`. All 47 confirmation emails are sent.
7. **Monday, 10:06 AM:** 47 customers receive their booking confirmations, about two hours late but not lost.

Without the DLQ, those 47 customers would never have received their confirmations. With the DLQ, the messages were preserved, the root cause was identified, and the messages were replayed once the problem was fixed.

> **Checkpoint:** Walk through the lifecycle of a failed message in your head. It starts in the main topic. A consumer tries to process it. It fails. It goes to retry-1 (1-second delay). Fails again. retry-2 (10 seconds). retry-3 (1 minute). retry-4 (5 minutes). retry-5 (1 hour). Still fails. Finally, it lands in `dlq-{topic}`. An engineer inspects it, fixes the root cause, and replays it. Can you describe each step without looking? If so, you understand the entire DLQ flow.

---

## Chapter 25 Summary

| Concept | One-Sentence Summary |
|---|---|
| Dead Letter Queue | A special topic where messages that fail processing after all retries are preserved for investigation and replay. |
| Retry Chain | Graduated retry levels with increasing delays (1s, 10s, 1m, 5m, 1h) before sending to DLQ. |
| Graduated Delays | Each retry waits longer than the last, giving transient failures time to resolve without hammering the downstream. |
| Message Preservation | DLQ messages include the original payload, all error details, retry count, and timestamps for full forensic analysis. |
| Replay | Once the root cause is fixed, DLQ messages can be sent back to their original topic for reprocessing. |
| Monitoring | DLQ counters and alerts ensure the operations team is notified when messages start failing at scale. |

---

# Chapter 26: Read/Write Splitting — Two Doors, One Room

## One Database, One Connection, One Problem

In every CRUD app you have built, you probably have a single database connection configuration:

```typescript
const db = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'my_app',
  user: 'app_user',
  password: 'secret',
  max: 20,  // 20 connections in the pool
});

// Every query -- reads AND writes -- goes through this one pool
const users = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
const booking = await db.query('INSERT INTO bookings (...) VALUES (...)', [...]);
const history = await db.query('SELECT * FROM bookings WHERE user_id = $1', [userId]);
const update = await db.query('UPDATE users SET name = $1 WHERE id = $2', [name, userId]);
```

All four queries hit the same database server. Reads and writes share the same connection pool, the same CPU, the same disk I/O. At low traffic, this is perfectly fine. At 1,666 bookings per second with a 70/30 read/write ratio, it is a bottleneck.

Here is why: writes are expensive. An `INSERT` or `UPDATE` must acquire locks, write to the transaction log (the WAL in PostgreSQL, the binary log in MySQL), update indexes, and ensure durability. While a write is happening, it can block reads on the same rows. And reads are the majority of the traffic -- searches, availability checks, booking history lookups, profile views. You are forcing the lightweight majority (reads) to compete with the heavyweight minority (writes) for the same resources.

> **Analogy:** Imagine a library with one desk where the librarian handles everything: checking out books, returning books, shelving new arrivals, and answering research questions. During a busy afternoon, a patron returning a stack of 20 books (a write operation) holds up the line for five minutes while the librarian processes each one. Behind that patron are 30 people who just want to ask "Do you have this book?" (read operations) -- a question the librarian could answer in five seconds if they were not busy shelving.
>
> The solution? Two desks. One desk handles returns and new arrivals (writes). Four other desks handle research questions (reads). The return desk has direct access to the catalog system (the primary database). The research desks have copies of the catalog (read replicas) that are updated every few seconds. Now 30 patrons get their answers without waiting for the shelving to finish.

---

## The Architecture: One Primary, Multiple Replicas

Read/write splitting separates your database into two roles:

- **Primary (master):** Handles all write operations (`INSERT`, `UPDATE`, `DELETE`). There is exactly one primary. It is the single source of truth.
- **Replicas (read replicas):** Handle read operations (`SELECT`). There can be many replicas. Each replica is a copy of the primary, kept in sync through **replication**.

In our booking system, each of the 16 MySQL shards has **1 primary and 4 read replicas**:

```
   Shard 0
   ┌────────────────────────────────────────────┐
   │                                            │
   │  ┌──────────┐     replication              │
   │  │ PRIMARY  │─────────────────┐            │
   │  │ (writes) │──────────┐     │            │
   │  └──────────┘     │    │     │            │
   │                   ▼    ▼     ▼     ▼      │
   │              ┌────┐ ┌────┐ ┌────┐ ┌────┐  │
   │              │ R1 │ │ R2 │ │ R3 │ │ R4 │  │
   │              │read│ │read│ │read│ │read│  │
   │              └────┘ └────┘ └────┘ └────┘  │
   │                                            │
   └────────────────────────────────────────────┘

   Writes:  ──► PRIMARY only
   Reads:   ──► R1, R2, R3, R4 (round-robin)

   Total per shard:
   - Write capacity: 1 server (focused, no read contention)
   - Read capacity:  4 servers (scaled horizontally)
```

> **Key Term:** **Read Replica** — A copy of the primary database that receives changes through replication. Replicas can handle `SELECT` queries but cannot process writes. Adding replicas scales read capacity linearly: 4 replicas handle roughly 4x the read traffic of a single server.

> **Key Term:** **Replication** — The process of automatically copying data changes from the primary database to its replicas. In MySQL, the primary writes changes to a binary log, and replicas read that log and apply the same changes to their own data. This happens continuously, usually with a delay of under one second.

> **What If You Skip This?** Without read/write splitting, your single database server handles everything. At our traffic levels, the write operations (which hold locks) interfere with read operations (which need those same rows). Response times degrade. Connection pools fill up. You cannot scale reads independently of writes. Adding read replicas is one of the simplest and most effective ways to scale a database-backed application, and it is exactly why cloud providers offer "add read replica" as a one-click option.

---

## The Code: Routing Queries Automatically

The application should not require developers to manually decide "this query goes to the primary, this one goes to a replica." That would be error-prone and tedious. Instead, we build a routing layer that inspects the SQL and makes the decision automatically:

```typescript
interface QueryOptions {
  requirePrimary?: boolean;   // Force this query to the primary
  maxLagSeconds?: number;     // Max acceptable replication lag
}

interface ShardConfig {
  shardNumber: number;
  primaryHost: string;
  replicaHosts: string[];
  primaryPoolSize?: number;
  replicaPoolSize?: number;
}

export class ReadWriteSplitter {
  private primaryPool: ConnectionPool;
  private replicaPools: ConnectionPool[];
  private currentReplicaIndex = 0;  // For round-robin distribution

  constructor(shardConfig: ShardConfig) {
    // One connection pool for the primary -- smaller because it only handles writes
    this.primaryPool = createPool({
      host: shardConfig.primaryHost,
      port: 3306,
      connectionLimit: shardConfig.primaryPoolSize || 200
      //                                              ^^^
      //  Fewer connections because writes are a smaller percentage of traffic
    });

    // One connection pool PER replica -- larger because reads are the majority
    this.replicaPools = shardConfig.replicaHosts.map(host =>
      createPool({
        host,
        port: 3306,
        connectionLimit: shardConfig.replicaPoolSize || 500
        //                                              ^^^
        //  More connections per replica since they handle the bulk of the traffic
      })
    );
  }
```

This constructor sets up the connection pools. Notice the asymmetry: 200 connections for the primary (which handles the 30% write traffic) and 500 connections *per replica* (which collectively handle the 70% read traffic). Four replicas with 500 connections each means 2,000 total read connections across the shard -- versus 200 write connections. The pool sizes mirror the read/write ratio.

Now the routing logic:

```typescript
  async query(sql: string, params: any[], options: QueryOptions = {}): Promise<any> {
    // Step 1: Is this a write operation?
    const isWrite = this.isWriteQuery(sql);

    if (isWrite || options.requirePrimary) {
      // Writes ALWAYS go to primary. No exceptions.
      // requirePrimary is for reads that MUST see the latest data.
      return this.primaryPool.execute(sql, params);
    }

    // Step 2: It is a read. Find a healthy replica.
    const replica = await this.getHealthyReplica(options.maxLagSeconds || 5);

    if (!replica) {
      // ALL replicas are lagging or unreachable.
      // Fall back to the primary rather than serving stale data.
      console.warn('All replicas lagging, falling back to primary for read');
      return this.primaryPool.execute(sql, params);
    }

    // Step 3: Execute the read on the healthy replica
    return replica.execute(sql, params);
  }

  private isWriteQuery(sql: string): boolean {
    // Check if the SQL starts with a write keyword
    const writePatterns = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)/i;
    return writePatterns.test(sql);
    //     ^^^^^^^^^^^^^^^^^^ Regex checks the first word of the SQL.
    //                        If it starts with INSERT, UPDATE, DELETE, etc. -> write.
    //                        If it starts with SELECT -> read.
  }
```

The `isWriteQuery` method is straightforward: it looks at the first word of the SQL statement. If it starts with `INSERT`, `UPDATE`, `DELETE`, or any other data-modifying keyword, it routes to the primary. Everything else goes to a replica.

The `requirePrimary` option exists for a critical edge case: **read-after-write consistency**. Imagine a user just created a booking. Your code immediately queries their booking history to show the confirmation page. If that read goes to a replica, and the replica has not received the write yet (because of replication lag), the user sees their booking history *without* the booking they just made. They panic. "Where is my booking? Did it go through?"

```typescript
  // Dedicated method for reads that MUST see the latest data
  async queryAfterWrite(sql: string, params: any[]): Promise<any> {
    return this.query(sql, params, { requirePrimary: true });
  }
```

Use `queryAfterWrite` any time you need to read data that was just written. For example:

```typescript
// User just created a booking
await splitter.query(
  'INSERT INTO bookings (user_id, hotel_id, status) VALUES (?, ?, ?)',
  [userId, hotelId, 'CONFIRMED']
);

// Immediately show them the confirmation -- MUST read from primary
const booking = await splitter.queryAfterWrite(
  'SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  [userId]
);
// This guarantees the user sees the booking they just created
```

---

## Replication Lag: The Tricky Part

Here is the fundamental tension of read/write splitting: replicas are not instantaneously in sync with the primary. When the primary processes an `INSERT`, there is a small delay before that change appears on the replicas. This delay is called **replication lag**.

```
   Time 0ms:   Primary processes INSERT INTO bookings
   Time 1ms:   Primary writes to binary log
   Time 5ms:   Replica 1 reads binary log, applies change
   Time 8ms:   Replica 2 reads binary log, applies change
   Time 12ms:  Replica 3 reads binary log, applies change
   Time 50ms:  Replica 4 reads binary log, applies change (slower network)

   During these 5-50ms, a SELECT on a replica returns STALE data.
   It will NOT include the row that was just inserted on the primary.
```

Under normal conditions, replication lag is measured in milliseconds -- barely noticeable. But when the primary is under heavy write load, or the network between primary and replica is congested, or a replica falls behind during a maintenance window, lag can grow to seconds or even minutes.

Our system detects replication lag and automatically avoids lagging replicas:

```typescript
  private async getHealthyReplica(maxLagSeconds: number): Promise<ConnectionPool | null> {
    // Round-robin through replicas, skipping unhealthy ones
    for (let i = 0; i < this.replicaPools.length; i++) {
      // Start from where we left off last time (round-robin)
      const index = (this.currentReplicaIndex + i) % this.replicaPools.length;
      const pool = this.replicaPools[index];

      try {
        // Ask MySQL how far behind this replica is
        const [rows] = await pool.execute('SHOW SLAVE STATUS');
        const lag = rows[0]?.Seconds_Behind_Master;
        //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
        //  This MySQL command returns the replication lag in seconds.
        //  If lag is 0, the replica is perfectly in sync.
        //  If lag is 3, the replica is 3 seconds behind the primary.
        //  If lag is null, replication is broken entirely.

        if (lag !== null && lag <= maxLagSeconds) {
          // This replica is healthy! Use it.
          this.currentReplicaIndex = (index + 1) % this.replicaPools.length;
          //   ^^^^^^^^^^^^^^^^^^^^^ Advance the round-robin pointer
          //                         so the next read goes to a different replica
          return pool;
        }
        // This replica is lagging too much. Try the next one.
      } catch (error) {
        // Replica is unreachable (crashed, network issue). Skip it.
        continue;
      }
    }

    // None of the replicas are healthy.
    return null;
    // The caller will fall back to the primary.
  }
```

Let us trace through this. We have four replicas. The default `maxLagSeconds` is 5 (we tolerate up to 5 seconds of lag).

- **Replica 1:** `SHOW SLAVE STATUS` reports `Seconds_Behind_Master: 0`. Healthy. Use this one.
- If Replica 1 had 8 seconds of lag, we skip it and check Replica 2.
- If Replica 2 is unreachable (connection refused), we catch the error and try Replica 3.
- If ALL four replicas are lagging or unreachable, we return `null`, and the `query` method falls back to the primary.

This fallback is critical. It is better to put extra load on the primary than to serve data that is minutes stale. A user seeing "3 rooms available" when the actual number is 0 (because the replica is 2 minutes behind) leads to overbooking.

> **Key Term:** **Replication Lag** — The delay between when a write is committed on the primary database and when that same write appears on a read replica. Under normal conditions, this is milliseconds. Under load or network issues, it can grow to seconds or minutes. Applications must account for lag or risk serving stale data.

> **Checkpoint:** Why can't we send writes to a replica? Because replicas are copies of the primary. They receive data through replication, not through direct writes. If you sent an `INSERT` to a replica, it would either reject it (read-only mode) or create data that exists only on that replica and never propagates to the primary or other replicas. The primary is the single source of truth for writes. Can you explain, in your own words, why a user might not see their newly created booking if the read goes to a lagging replica?

---

## The Shard Router: Tying It All Together

In Chapter 7 (Database Design & Sharding), we mentioned that our system shards data across 16 MySQL instances. The shard router sits *above* the read/write splitter and answers a different question: "Which shard holds this user's data?"

```
   ┌──────────────────────────────────────────────────────────┐
   │                     Shard Router                         │
   │                                                          │
   │   userId = 12345                                         │
   │   shardNumber = 12345 % 16 = 9                          │
   │   ──► Route to Shard 9                                  │
   │                                                          │
   │   ┌────────────────────────────────────────────────────┐ │
   │   │              Shard 9                               │ │
   │   │   ┌─────────┐                                     │ │
   │   │   │ Primary │──► Handles writes                   │ │
   │   │   └─────────┘                                     │ │
   │   │   ┌──┐ ┌──┐ ┌──┐ ┌──┐                            │ │
   │   │   │R1│ │R2│ │R3│ │R4│──► Handle reads             │ │
   │   │   └──┘ └──┘ └──┘ └──┘                            │ │
   │   └────────────────────────────────────────────────────┘ │
   └──────────────────────────────────────────────────────────┘

   Two-level routing:
   1. Shard Router  → picks the right shard (based on user ID)
   2. ReadWriteSplitter → picks primary vs. replica (based on query type)
```

The implementation:

```typescript
export class ShardRouter {
  private shards: Map<number, ReadWriteSplitter> = new Map();

  constructor(shardConfigs: ShardConfig[]) {
    // Create a ReadWriteSplitter for each shard
    for (const config of shardConfigs) {
      this.shards.set(config.shardNumber, new ReadWriteSplitter(config));
    }
  }

  // Determine which shard holds a user's data
  getShardForUser(userId: bigint): ReadWriteSplitter {
    const shardNumber = Number(userId % 16n);
    //                         ^^^^^^^^^^^^ Modulo 16 maps any user ID to a shard 0-15
    //                                      User 1 → shard 1, User 16 → shard 0,
    //                                      User 17 → shard 1, etc.
    const shard = this.shards.get(shardNumber);
    if (!shard) throw new Error(`Shard ${shardNumber} not configured`);
    return shard;
  }

  // Query for a specific user -- routes to the correct shard automatically
  async queryForUser(
    userId: bigint,
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<any> {
    const shard = this.getShardForUser(userId);
    return shard.query(sql, params, options);
    //     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ The ReadWriteSplitter inside this shard
    //                                     handles primary vs. replica routing
  }
}
```

A developer using the system does not need to think about shards or replicas. They just call `queryForUser`:

```typescript
// The developer writes this:
const bookings = await shardRouter.queryForUser(
  userId,
  'SELECT * FROM bookings WHERE user_id = ? AND status = ?',
  [userId, 'CONFIRMED']
);

// Behind the scenes:
// 1. ShardRouter computes: userId % 16 = shard 7
// 2. ShardRouter gets the ReadWriteSplitter for shard 7
// 3. ReadWriteSplitter sees this is a SELECT → routes to a read replica
// 4. ReadWriteSplitter checks Replica 1's lag → 0 seconds, healthy
// 5. Query executes on shard 7, replica 1
// 6. Results returned to the developer
```

### Cross-Shard Queries

Sometimes you need data from all shards -- for example, an admin dashboard that shows total bookings across the entire system. The shard router supports scatter-gather queries for this:

```typescript
  // Query ALL shards and collect results (for admin/reporting queries)
  async queryAllShards(
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<Map<number, any>> {
    const results = new Map<number, any>();

    // Run the query on all 16 shards IN PARALLEL
    await Promise.all(
      Array.from(this.shards.entries()).map(async ([shardNum, splitter]) => {
        const result = await splitter.query(sql, params, options);
        results.set(shardNum, result);
      })
    );
    //  ^^^^^^^^^^ Promise.all executes all 16 queries simultaneously.
    //             Total time = slowest shard, not sum of all shards.

    return results;
    // Caller gets a Map: { 0: [...rows], 1: [...rows], ..., 15: [...rows] }
    // They can merge, aggregate, or process per-shard results as needed.
  }
```

This is called a **scatter-gather** pattern: scatter the query to all shards (in parallel), and gather the results. It is fine for admin dashboards and reports, but you would never use it for user-facing requests -- querying 16 shards for a single user's booking would be absurdly wasteful when you can compute the shard number with a single modulo operation.

> **Key Term:** **Scatter-Gather** — A query pattern where a request is sent to all shards in parallel, and the results are combined. Useful for aggregate queries (e.g., "total bookings across all shards") but expensive compared to directed queries that target a single shard.

---

## Putting It All Together

Let us follow a complete request to see how sharding, read/write splitting, and replication lag detection work together.

**Scenario:** User #54321 searches for their booking history.

```
1. Request arrives: GET /api/users/54321/bookings

2. ShardRouter.getShardForUser(54321n)
   → 54321 % 16 = 1
   → Route to Shard 1

3. ReadWriteSplitter.query("SELECT * FROM bookings WHERE user_id = ?", [54321])
   → isWriteQuery("SELECT ...") = false → this is a READ

4. getHealthyReplica(maxLag: 5 seconds)
   → Check Replica 1: Seconds_Behind_Master = 0 → HEALTHY
   → Return Replica 1

5. Execute query on Shard 1, Replica 1
   → Results: [{ id: 'BK-101', hotel: 'Tokyo', status: 'CONFIRMED' }, ...]

6. Return results to user
```

**Scenario:** User #54321 creates a new booking, then views it immediately.

```
1. POST /api/bookings { userId: 54321, hotelId: 'TOKYO-042', ... }

2. ShardRouter.queryForUser(54321n, "INSERT INTO bookings ...", [...])
   → Shard 1, Primary (because INSERT is a write)
   → Booking created successfully

3. GET /api/bookings/BK-999  (user refreshes the page)

4. ShardRouter.queryForUser(54321n, "SELECT * FROM bookings WHERE id = ?", ['BK-999'])
   → But wait -- the code uses queryAfterWrite() because this is a read-after-write
   → Routes to Shard 1, PRIMARY (not a replica)
   → The booking is there, guaranteed

   If we had sent this to a replica, and the replica was 200ms behind,
   the user would see "Booking not found" -- terrifying after just paying.
```

---

## Chapter 26 Summary

| Concept | One-Sentence Summary |
|---|---|
| Read/Write Splitting | Writes go to the primary database; reads go to replicas, distributing load across multiple servers. |
| Primary (Master) | The single database server that handles all write operations and is the source of truth. |
| Read Replica | A copy of the primary that handles read queries, kept in sync through replication. |
| Replication Lag | The delay between a write on the primary and its appearance on a replica; usually milliseconds, but can grow under load. |
| Lag Detection | Checking `SHOW SLAVE STATUS` before routing reads to a replica; lagging replicas are skipped automatically. |
| Read-After-Write | Using `requirePrimary: true` for reads that must see data that was just written, avoiding stale replica reads. |
| Shard Router | A layer above read/write splitting that routes queries to the correct shard based on user ID. |
| Scatter-Gather | Querying all shards in parallel for aggregate queries like admin reports. |

> **Checkpoint:** You now understand three layers of database routing in our system. First, the **Shard Router** determines which of the 16 shards holds a user's data (using `userId % 16`). Second, the **ReadWriteSplitter** within that shard routes writes to the primary and reads to a healthy replica. Third, **replication lag detection** ensures we never serve data from a replica that is too far behind. Can you trace a write request and a subsequent read request through all three layers? If you can, you have a solid understanding of how production databases handle traffic at scale.
