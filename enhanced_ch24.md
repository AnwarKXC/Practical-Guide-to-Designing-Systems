# Chapter 24: Cache Strategy & Invalidation — The Hardest Problem

## You Already Cache. You Just Don't Know It Yet.

Think about the last time you built a CRUD endpoint. Something like this:

```typescript
app.get('/api/products/:id', async (req, res) => {
  const product = await db.query(
    'SELECT * FROM products WHERE id = $1',
    [req.params.id]
  );
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

  const product = await db.query(
    'SELECT * FROM products WHERE id = $1',
    [req.params.id]
  );
  cache.set(key, product.rows[0]);
  res.json(product.rows[0]);
});
```

That is caching. You already understand the core idea: if you have recently fetched something and it has not changed, do not fetch it again. Return what you already have.

But here is where things get interesting. That `Map()` lives in your Node.js process memory. Restart the server and the cache is gone. Run two instances behind a load balancer and they each have their own cache -- User A's request populates Instance 1's cache, but User B hits Instance 2 and gets a cache miss. And the biggest question of all: when the product data changes in the database, your cache still holds the old data. How long do you serve stale information? How do you know *when* to throw the cached version away?

That last question is so notoriously difficult that there is a famous quote in computer science, attributed to Phil Karlton:

> "There are only two hard things in Computer Science: cache invalidation and naming things."

It is funny because it is painfully true. Naming things is hard because bad names confuse every developer who reads the code afterward. Cache invalidation is hard because getting it wrong means your users see data that is minutes, hours, or even days out of date -- and they have no idea they are making decisions based on stale information. A user books a hotel room that was already sold. A customer pays a price that changed an hour ago. A dashboard shows inventory counts that are wildly incorrect. The data *looks* correct, and that is what makes it dangerous.

In this chapter, we are going to tackle the hard thing head-on. We will implement four caching patterns, three invalidation strategies, stampede prevention, multi-level caching, and a full production-grade NestJS caching module. By the end, you will not just understand caching -- you will know how to build a cache layer that handles 100,000 bookings per minute without breaking a sweat.

---

## Why Caching Is Not Optional at Scale

Let us talk numbers. Our booking system handles 1,666 bookings per second. But bookings are just the write side. For every person who books, dozens more are *searching*. They are checking hotel availability, comparing prices, browsing property details, and looking at their booking history. The read-to-write ratio in our system is roughly 70:30. That means the read path alone generates approximately **3,888 queries per second**.

A single MySQL database can handle maybe a few hundred complex queries per second before response times start degrading. At 3,888 queries per second, your database is drowning. Queries that used to return in 5 milliseconds now take 500 milliseconds because the database is spending all its time context-switching between connections, waiting on disk I/O, and fighting for lock contention.

Here is what happens to latency when you add caching versus when you do not:

```
Without Caching (all reads hit database):
─────────────────────────────────────────────
  Requests/sec:  3,888
  Avg latency:   45ms  (at low load)
  P95 latency:   220ms (under sustained load)
  P99 latency:   890ms (spikes during peak hours)
  DB CPU:        92%   (near saturation)
  DB connections: 450/500 (near pool exhaustion)

With Caching (95% cache hit rate):
─────────────────────────────────────────────
  Requests/sec:  3,888      (same traffic)
  Cache hits:    3,694/sec   (served from Redis in <1ms)
  DB queries:    194/sec     (only cache misses)
  Avg latency:   3ms         (93% reduction)
  P95 latency:   12ms        (95% reduction)
  P99 latency:   45ms        (95% reduction)
  DB CPU:        18%         (breathing room)
  DB connections: 45/500     (barely noticeable)
```

The difference is staggering. With a 95% cache hit rate, 3,694 out of every 3,888 requests never touch the database. They are answered directly from Redis, which stores data in RAM, in under a millisecond. Your database goes from drowning at 92% CPU to idling at 18%.

> **Analogy:** Imagine a librarian in a small-town library. When three people ask for book recommendations at the same time, the librarian handles it gracefully. Now imagine 4,000 people walk in simultaneously, all asking the same question: "What are the best hotels in Tokyo?" The librarian could answer the first person, write the answer on a whiteboard at the entrance, and point everyone else to the whiteboard. That whiteboard is your cache. Instead of the librarian (your database) answering the same question 4,000 times, she answers it once, and the whiteboard serves everyone else.

> **Key Term:** **Cache** -- A temporary storage layer (usually in-memory, like Redis) that holds copies of frequently accessed data. Reads check the cache first. If the data is there (a *cache hit*), the database is never touched. If it is not there (a *cache miss*), the database is queried and the result is stored in the cache for next time.

> **What If You Skip This?** Without caching, every search request, every availability check, every profile lookup hits the database directly. At scale, this means your p99 latency (the response time for the slowest 1% of requests) climbs from 10ms to over 500ms. Users notice. They leave. And if traffic spikes -- say, a flash sale or a holiday rush -- the database collapses entirely. You get connection pool exhaustion, timeouts, and a full outage. Caching is not a performance optimization at this scale. It is a survival requirement.

---

## The Four Caching Patterns You Need to Know

There are four fundamental caching strategies: cache-aside, write-through, write-behind, and read-through. Each answers the same question differently: "Who puts data into the cache, and when?"

### Pattern 1: Cache-Aside (Lazy Loading)

This is what you did with the `Map()` example above, formalized into a proper pattern. The application code is responsible for managing the cache. It is called "lazy loading" because data is only loaded into the cache when it is first requested -- not proactively.

**How it works:**

1. Application receives a read request.
2. Application checks the cache. If the data is there (cache hit), return it. Done.
3. If the data is not there (cache miss), query the database.
4. Store the database result in the cache with a TTL.
5. Return the result.

```
   ┌──────────┐         ┌─────────┐         ┌──────────┐
   │  Client  │────1───>│   App   │────2───>│  Cache   │
   │          │         │ Server  │<────────│ (Redis)  │
   │          │         │         │         └──────────┘
   │          │         │         │  cache miss
   │          │         │         │────3───>┌──────────┐
   │          │         │         │<────────│ Database │
   │          │<──5─────│         │────4───>│          │
   │          │         │         │         │ (MySQL)  │
   └──────────┘         └─────────┘         └──────────┘

   1: GET /api/hotels/tokyo
   2: redis.get("hotel:tokyo") → miss!
   3: SELECT * FROM hotels WHERE city = 'tokyo'
   4: redis.setex("hotel:tokyo", 300, data)
   5: Return data to client
```

Before we implement this in code, let us define the Prisma schema for the data we will be caching. Every raw SQL query in this chapter has a corresponding Prisma equivalent.

**Prisma Schema:**

```prisma
// prisma/schema.prisma

model Hotel {
  id           BigInt    @id @default(autoincrement())
  name         String    @db.VarChar(255)
  city         String    @db.VarChar(100)
  country      String    @db.VarChar(100)
  starRating   Int       @map("star_rating") @db.SmallInt
  description  String?   @db.Text
  amenities    Json?
  basePrice    Decimal   @map("base_price") @db.Decimal(10, 2)
  currency     String    @default("USD") @db.VarChar(3)
  isActive     Boolean   @default(true) @map("is_active")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  rooms        Room[]
  bookings     Booking[]

  @@index([city, isActive])
  @@index([country])
  @@map("hotels")
}

model Room {
  id            BigInt    @id @default(autoincrement())
  hotelId       BigInt    @map("hotel_id")
  roomType      String    @map("room_type") @db.VarChar(50)
  pricePerNight Decimal   @map("price_per_night") @db.Decimal(10, 2)
  capacity      Int       @db.SmallInt
  isAvailable   Boolean   @default(true) @map("is_available")

  hotel         Hotel     @relation(fields: [hotelId], references: [id])
  bookings      Booking[]

  @@index([hotelId, isAvailable])
  @@map("rooms")
}

model Booking {
  id         BigInt    @id @default(autoincrement())
  userId     BigInt    @map("user_id")
  hotelId    BigInt    @map("hotel_id")
  roomId     BigInt    @map("room_id")
  checkIn    DateTime  @map("check_in") @db.Date
  checkOut   DateTime  @map("check_out") @db.Date
  status     String    @default("confirmed") @db.VarChar(20)
  totalPrice Decimal   @map("total_price") @db.Decimal(10, 2)
  currency   String    @default("USD") @db.VarChar(3)
  createdAt  DateTime  @default(now()) @map("created_at")
  updatedAt  DateTime  @updatedAt @map("updated_at")
  deletedAt  DateTime? @map("deleted_at")

  user       User      @relation(fields: [userId], references: [id])
  hotel      Hotel     @relation(fields: [hotelId], references: [id])
  room       Room      @relation(fields: [roomId], references: [id])

  @@index([userId, status])
  @@index([hotelId, checkIn, checkOut])
  @@index([roomId, checkIn, checkOut])
  @@map("bookings")
}

model User {
  id        BigInt    @id @default(autoincrement())
  email     String    @unique @db.VarChar(255)
  name      String    @db.VarChar(255)
  createdAt DateTime  @default(now()) @map("created_at")

  bookings  Booking[]

  @@map("users")
}
```

Now the full cache-aside implementation with Redis. This is the code that sits in the hot path of every read request in our system:

```typescript
// src/cache/cache-aside.service.ts
import Redis from 'ioredis';

interface CacheOptions {
  earlyExpiry?: boolean;        // Should we refresh before actual expiry?
  preventStampede?: boolean;    // Should we prevent thundering herd?
  namespace?: string;           // Key namespace for organization
  version?: number;             // Cache version for schema changes
}

interface CacheEntry<T> {
  data: T;
  cachedAt: number;             // When this entry was stored (Unix ms)
  version: number;              // Schema version at time of caching
}

export class CacheAsideService {
  private readonly redis: Redis;
  private readonly defaultTTL = 3600; // 1 hour in seconds

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }

  /**
   * The heart of cache-aside: check cache first, fall back to DB.
   * This single method is called thousands of times per second.
   */
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number = this.defaultTTL,
    options: CacheOptions = {}
  ): Promise<T> {
    const fullKey = this.buildKey(key, options);

    // ─── Step 1: Try the cache first ───
    try {
      const cached = await this.redis.get(fullKey);

      if (cached) {
        const entry: CacheEntry<T> = JSON.parse(cached);

        // Version check: if the cached version is older than
        // the current version, treat it as a miss
        if (options.version && entry.version < options.version) {
          // Stale version -- fall through to database
        } else {
          // Cache HIT -- we found valid data

          // Check if we should refresh early (stampede prevention)
          if (options.earlyExpiry) {
            await this.maybeRefreshEarly(
              fullKey, fetchFn, ttlSeconds, options
            );
          }

          return entry.data;
        }
      }
    } catch (err) {
      // Redis is down -- fall through to database gracefully.
      // Caching should NEVER cause the request to fail.
      console.warn(`Cache read failed for ${fullKey}:`, err);
    }

    // ─── Step 2: Cache MISS -- data is not in Redis ───

    // If stampede prevention is on, use a distributed lock
    if (options.preventStampede) {
      return await this.fetchWithLock(fullKey, fetchFn, ttlSeconds, options);
    }

    // ─── Step 3: Standard miss -- query DB, store in cache ───
    const value = await fetchFn();
    await this.setCache(fullKey, value, ttlSeconds, options);
    return value;
  }

  /**
   * Store a value in the cache with metadata.
   */
  private async setCache<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    options: CacheOptions
  ): Promise<void> {
    const entry: CacheEntry<T> = {
      data: value,
      cachedAt: Date.now(),
      version: options.version ?? 1,
    };

    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify(entry));
      // SETEX = SET with EXpiry. The key auto-deletes after ttlSeconds.
    } catch (err) {
      // Cache write failure is not fatal -- the data was still
      // returned to the user. We just log and move on.
      console.warn(`Cache write failed for ${key}:`, err);
    }
  }

  /**
   * Build a fully qualified cache key with namespace and version.
   * Example: "cache:v2:hotels:tokyo:2026-03-15"
   */
  private buildKey(key: string, options: CacheOptions): string {
    const ns = options.namespace ?? 'default';
    const ver = options.version ?? 1;
    return `cache:v${ver}:${ns}:${key}`;
  }

  /**
   * Delete a specific cache entry or a pattern of entries.
   */
  async invalidate(pattern: string): Promise<number> {
    let deletedCount = 0;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH', `cache:*:${pattern}`,
        'COUNT', 100
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    return deletedCount;
  }
}
```

Let us walk through this line by line because this is the code that sits in the hot path of every read request in the system.

The `getOrSet` method takes four arguments. The `key` is the cache key -- something like `"hotels:tokyo:2026-03-15"`. The `fetchFn` is a function that queries the database -- you pass this in, and the cache service only calls it on a miss. The `ttlSeconds` is how long the cached value should live. And `options` controls advanced features like stampede prevention, namespacing, and versioning.

The first thing we do is check Redis. If the key exists, we parse the JSON wrapper (which includes metadata like `cachedAt` and `version`) and return the data. The database is never touched. This is where the performance win comes from.

If the key does not exist -- or if the version stored in the cache is older than the version the caller expects -- we have a cache miss. We call `fetchFn()` to query the database, store the result in Redis wrapped in our `CacheEntry` envelope, and return the result. The next request for this key will be a cache hit.

Notice the `try/catch` around the Redis call. This is critical. If Redis goes down, your application should still work -- it just runs slower because every request hits the database. Caching should **degrade gracefully**, never catastrophically. A Redis outage should cause slow responses, not error pages.

**Using it with Prisma Client:**

```typescript
// src/hotels/hotels.service.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const cache = new CacheAsideService(process.env.REDIS_URL);

// ─── Raw SQL version ───
async function getHotelsByCity_SQL(city: string) {
  return cache.getOrSet(
    `hotels:${city}`,
    async () => {
      const [rows] = await db.execute(
        `SELECT id, name, city, star_rating, base_price, currency
         FROM hotels
         WHERE city = ? AND is_active = 1
         ORDER BY star_rating DESC`,
        [city]
      );
      return rows;
    },
    300, // 5-minute TTL
    { namespace: 'search', version: 1, preventStampede: true }
  );
}

// ─── Prisma Client version (identical behavior, type-safe) ───
async function getHotelsByCity(city: string) {
  return cache.getOrSet(
    `hotels:${city}`,
    async () => {
      return prisma.hotel.findMany({
        where: { city, isActive: true },
        select: {
          id: true,
          name: true,
          city: true,
          starRating: true,
          basePrice: true,
          currency: true,
        },
        orderBy: { starRating: 'desc' },
      });
    },
    300,
    { namespace: 'search', version: 1, preventStampede: true }
  );
}
```

The Prisma version does exactly the same thing as the raw SQL version, but it is type-safe. If you rename the `starRating` field in your schema and run `prisma generate`, the TypeScript compiler catches every place that references the old name. With raw SQL, you find out at runtime.

> **Key Term:** **TTL (Time-To-Live)** -- The lifespan of a cached value in seconds. After the TTL expires, Redis automatically deletes the key. The next request will be a cache miss and will query the database again. TTL is the simplest form of cache invalidation: "just delete it after a while."

> **Checkpoint:** Look at the `CacheAsideService` above. What happens if Redis crashes while your application is running? The answer: every request becomes a cache miss and hits the database directly. The `try/catch` ensures no errors are thrown to the user. Performance degrades, but the system stays up. This is called the **cache-aside resilience property** -- the cache is a performance optimization, not a dependency.

---

### Pattern 2: Write-Through Caching

Cache-aside puts all the responsibility on the read path. But what about writes? When someone updates a hotel's base price, the cache-aside pattern does nothing -- it waits for the TTL to expire and serves stale data in the meantime. Write-through solves this by updating the cache at the exact moment the database is written to.

**How it works:**

1. Application receives a write request (INSERT, UPDATE, DELETE).
2. Application writes to the database.
3. Application immediately writes the same data to the cache.
4. Both stores now have the same data. Consistency is guaranteed at write time.

```
   ┌──────────┐         ┌─────────┐
   │  Client  │────1───>│   App   │──── 2a ──>┌──────────┐
   │          │         │ Server  │            │ Database │
   │          │         │         │<───────────│ (MySQL)  │
   │          │         │         │            └──────────┘
   │          │         │         │──── 2b ──>┌──────────┐
   │          │<──3─────│         │            │  Cache   │
   │          │         │         │<───────────│ (Redis)  │
   └──────────┘         └─────────┘            └──────────┘

   1: PUT /api/hotels/42  { basePrice: 199.99 }
   2a: UPDATE hotels SET base_price = 199.99 WHERE id = 42
   2b: redis.setex("hotel:42", 3600, updatedData)
   3: Return { success: true }
```

The trade-off is clear: writes are slightly slower (you write to two places instead of one), but reads are always consistent. There is no window of staleness.

```typescript
// src/cache/write-through.service.ts

export class WriteThroughCacheService {
  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient
  ) {}

  /**
   * Write-through: update DB and cache in the same operation.
   * The cache is ALWAYS consistent with the database.
   */
  async updateHotelPrice(
    hotelId: bigint,
    newPrice: number
  ): Promise<Hotel> {
    // ─── Step 1: Write to the database ───
    // Raw SQL version:
    //   UPDATE hotels SET base_price = ?, updated_at = NOW()
    //   WHERE id = ? AND is_active = 1

    const updatedHotel = await this.prisma.hotel.update({
      where: { id: hotelId },
      data: {
        basePrice: newPrice,
        updatedAt: new Date(),
      },
    });

    // ─── Step 2: Write to the cache immediately ───
    // The cache now holds the exact same data as the database.
    // Any subsequent reads will get the new price instantly.
    const cacheKey = `cache:v1:hotels:${hotelId}`;
    const cacheEntry = {
      data: updatedHotel,
      cachedAt: Date.now(),
      version: 1,
    };

    await this.redis.setex(
      cacheKey,
      3600, // 1 hour TTL (still need TTL as a safety net)
      JSON.stringify(cacheEntry)
    );

    // ─── Step 3: Invalidate related caches ───
    // When a hotel's price changes, the city search results
    // that include this hotel are now stale too.
    await this.invalidateRelatedCaches(updatedHotel.city);

    return updatedHotel;
  }

  /**
   * When a hotel changes, city-level search caches become stale.
   * We delete them so the next search rebuilds with fresh data.
   */
  private async invalidateRelatedCaches(city: string): Promise<void> {
    const pattern = `cache:*:search:hotels:${city}*`;
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', pattern, 'COUNT', 100
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } while (cursor !== '0');
  }
}
```

> **When to use write-through:** Use this pattern when data consistency matters more than write latency. Price updates, inventory counts, and booking confirmations are good candidates. You cannot afford to show a user a price that changed five minutes ago -- they might book at the wrong price, and that creates a customer service nightmare.

### Pattern 3: Write-Behind (Write-Back) Caching

Write-behind flips the model. Instead of writing to the database first and then updating the cache, you write to the cache first and asynchronously flush to the database later. This makes writes extremely fast -- the client gets a response as soon as the cache is updated -- but it introduces a window where the database is behind the cache.

**How it works:**

1. Application receives a write request.
2. Application writes to the cache only.
3. Application returns success to the client immediately.
4. A background worker periodically flushes dirty cache entries to the database.

```
   ┌──────────┐         ┌─────────┐         ┌──────────┐
   │  Client  │────1───>│   App   │────2───>│  Cache   │
   │          │<──3─────│ Server  │         │ (Redis)  │
   │          │         └─────────┘         └──────────┘
   └──────────┘                                  │
                                                 │ 4 (async,
                                                 │  batched)
                                                 ▼
                                            ┌──────────┐
                                            │ Database │
                                            │ (MySQL)  │
                                            └──────────┘
```

```typescript
// src/cache/write-behind.service.ts

interface DirtyEntry {
  key: string;
  data: any;
  writtenAt: number;
  tableName: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
}

export class WriteBehindCacheService {
  private flushIntervalMs = 5000; // Flush every 5 seconds
  private dirtyQueue: string = 'cache:dirty_queue';

  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient
  ) {
    // Start the background flush worker
    this.startFlushWorker();
  }

  /**
   * Write to cache immediately, queue the DB write for later.
   * The client gets a response in ~1ms instead of ~10ms.
   */
  async updateAvailability(
    roomId: bigint,
    isAvailable: boolean
  ): Promise<void> {
    const cacheKey = `cache:v1:rooms:${roomId}`;

    // ─── Step 1: Update the cache immediately ───
    const updatedData = {
      data: { id: roomId, isAvailable, updatedAt: new Date() },
      cachedAt: Date.now(),
      version: 1,
    };
    await this.redis.setex(cacheKey, 3600, JSON.stringify(updatedData));

    // ─── Step 2: Push to the dirty queue for async DB write ───
    const dirtyEntry: DirtyEntry = {
      key: cacheKey,
      data: { roomId: roomId.toString(), isAvailable },
      writtenAt: Date.now(),
      tableName: 'rooms',
      operation: 'UPDATE',
    };
    await this.redis.rpush(this.dirtyQueue, JSON.stringify(dirtyEntry));

    // Client gets a response HERE -- DB is not written yet.
  }

  /**
   * Background worker that flushes dirty entries to the database.
   * Runs every 5 seconds, processing entries in batches.
   */
  private startFlushWorker(): void {
    setInterval(async () => {
      const batchSize = 100;
      const entries: DirtyEntry[] = [];

      // Pop up to 100 entries from the dirty queue
      for (let i = 0; i < batchSize; i++) {
        const raw = await this.redis.lpop(this.dirtyQueue);
        if (!raw) break;
        entries.push(JSON.parse(raw));
      }

      if (entries.length === 0) return;

      // Batch write to the database using a transaction
      // Raw SQL version:
      //   UPDATE rooms SET is_available = ?, updated_at = NOW()
      //   WHERE id = ?
      await this.prisma.$transaction(
        entries.map((entry) =>
          this.prisma.room.update({
            where: { id: BigInt(entry.data.roomId) },
            data: {
              isAvailable: entry.data.isAvailable,
            },
          })
        )
      );

      console.log(
        `[WriteBehind] Flushed ${entries.length} entries to database`
      );
    }, this.flushIntervalMs);
  }
}
```

> **Mentor's Warning:** Write-behind is powerful but dangerous. If your application crashes between writing to the cache and flushing to the database, you lose data. This pattern is appropriate for high-frequency, low-criticality updates like analytics counters, view counts, or room availability hints. Never use it for financial transactions, booking confirmations, or anything where data loss would cause business harm.

> **When to choose which pattern:**

```
┌────────────────────┬──────────────┬──────────────┬──────────────┐
│ Consideration      │ Cache-Aside  │Write-Through │Write-Behind  │
├────────────────────┼──────────────┼──────────────┼──────────────┤
│ Read performance   │ Fast (after  │ Fast (always │ Fast (always │
│                    │ first miss)  │ in cache)    │ in cache)    │
│ Write performance  │ No change    │ Slower (2    │ Fastest (1   │
│                    │              │ writes)      │ write)       │
│ Consistency        │ Eventually   │ Strong       │ Eventually   │
│                    │ consistent   │              │ consistent   │
│ Data loss risk     │ None         │ None         │ Yes (crash   │
│                    │              │              │ window)      │
│ Complexity         │ Low          │ Medium       │ High         │
│ Best for           │ Read-heavy   │ Price/       │ Counters,    │
│                    │ lookups      │ inventory    │ analytics    │
└────────────────────┴──────────────┴──────────────┴──────────────┘
```

---

## Cache Invalidation Strategies

This is the hard part. You have data in the cache and data in the database. At some point, the database changes. How does the cache find out? There are three strategies, each with different trade-offs.

### Strategy 1: TTL-Based Invalidation (Time-Based Expiry)

This is the simplest approach. Every cached value has a time-to-live. After the TTL expires, Redis deletes the key automatically. The next request triggers a cache miss and fetches fresh data from the database.

```typescript
// TTL-based invalidation is built into Redis.
// When you write a cache entry, you set its lifespan:

// Raw Redis command:
// SETEX hotel:42 300 '{"name":"Grand Tokyo","basePrice":199.99}'
//                ^^^
//                300 seconds = 5 minutes

// The Prisma-backed implementation:
async function cacheHotelWithTTL(hotelId: bigint): Promise<Hotel> {
  const cacheKey = `hotel:${hotelId}`;
  const ttl = chooseTTL('hotel_details'); // Returns seconds

  return cache.getOrSet(
    cacheKey,
    () => prisma.hotel.findUniqueOrThrow({
      where: { id: hotelId },
      include: { rooms: { where: { isAvailable: true } } },
    }),
    ttl,
    { namespace: 'hotels', version: 1 }
  );
}

/**
 * Different data types need different TTLs.
 * The question is: "How stale can this data be before it causes harm?"
 */
function chooseTTL(dataType: string): number {
  const ttlMap: Record<string, number> = {
    // Static data: changes rarely. Long TTL is safe.
    hotel_details:     3600,   // 1 hour
    hotel_amenities:   86400,  // 24 hours
    country_list:      604800, // 7 days

    // Semi-dynamic data: changes occasionally.
    hotel_reviews:     900,    // 15 minutes
    search_results:    300,    // 5 minutes

    // Dynamic data: changes frequently. Short TTL required.
    room_availability: 60,     // 1 minute
    room_pricing:      30,     // 30 seconds
    booking_status:    15,     // 15 seconds
  };

  return ttlMap[dataType] ?? 300; // Default: 5 minutes
}
```

TTL-based invalidation is easy to implement but imprecise. A 5-minute TTL means data can be stale for up to 5 minutes. For hotel descriptions, that is fine. For room prices during a flash sale, 5 minutes of stale data could mean thousands of bookings at the wrong price.

### Strategy 2: Event-Driven Invalidation

Instead of waiting for the TTL to expire, you actively delete cache entries when the underlying data changes. This is done by publishing an event from your write path and having a listener invalidate the appropriate cache keys.

```typescript
// src/cache/event-driven-invalidation.service.ts
import { EventEmitter2 } from '@nestjs/event-emitter';

interface CacheInvalidationEvent {
  entity: string;         // e.g., 'hotel', 'room', 'booking'
  entityId: string;       // e.g., '42'
  operation: string;      // 'update', 'delete', 'create'
  changedFields: string[];// e.g., ['basePrice', 'currency']
  timestamp: number;
}

export class EventDrivenCacheInvalidator {
  constructor(
    private readonly redis: Redis,
    private readonly eventEmitter: EventEmitter2
  ) {
    // Listen for data change events
    this.eventEmitter.on(
      'data.changed',
      (event: CacheInvalidationEvent) => this.handleDataChange(event)
    );
  }

  /**
   * When data changes in the database, determine which cache keys
   * need to be invalidated and delete them.
   */
  private async handleDataChange(
    event: CacheInvalidationEvent
  ): Promise<void> {
    const keysToInvalidate = this.resolveAffectedKeys(event);

    if (keysToInvalidate.length === 0) return;

    // Delete all affected keys in a single pipeline
    const pipeline = this.redis.pipeline();
    for (const key of keysToInvalidate) {
      pipeline.del(key);
    }
    await pipeline.exec();

    console.log(
      `[Invalidator] Cleared ${keysToInvalidate.length} keys ` +
      `for ${event.entity}:${event.entityId} ${event.operation}`
    );
  }

  /**
   * Map a data change event to the cache keys it affects.
   * This is the hardest part of event-driven invalidation:
   * you must know EXACTLY which keys depend on the changed data.
   */
  private resolveAffectedKeys(
    event: CacheInvalidationEvent
  ): string[] {
    const keys: string[] = [];
    const { entity, entityId } = event;

    switch (entity) {
      case 'hotel':
        // Direct key: the hotel itself
        keys.push(`cache:v1:hotels:${entityId}`);
        // Related keys: search results that include this hotel
        // We mark these for pattern-based deletion
        keys.push(`cache:v1:search:hotels:*`);
        break;

      case 'room':
        keys.push(`cache:v1:rooms:${entityId}`);
        // A room change also affects the parent hotel's data
        keys.push(`cache:v1:hotels:*`);
        keys.push(`cache:v1:search:availability:*`);
        break;

      case 'booking':
        keys.push(`cache:v1:bookings:${entityId}`);
        // A new booking affects room availability
        keys.push(`cache:v1:rooms:*`);
        keys.push(`cache:v1:search:availability:*`);
        break;
    }

    return keys;
  }
}

// ─── How to emit events from your write operations ───
// In your service layer, after every database write:

class HotelService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventEmitter: EventEmitter2
  ) {}

  async updateHotelPrice(
    hotelId: bigint,
    newPrice: number
  ): Promise<Hotel> {
    const hotel = await this.prisma.hotel.update({
      where: { id: hotelId },
      data: { basePrice: newPrice },
    });

    // Emit the change event -- the invalidator picks it up
    this.eventEmitter.emit('data.changed', {
      entity: 'hotel',
      entityId: hotelId.toString(),
      operation: 'update',
      changedFields: ['basePrice'],
      timestamp: Date.now(),
    } as CacheInvalidationEvent);

    return hotel;
  }
}
```

Event-driven invalidation gives you near-instant cache freshness. The moment data changes in the database, the cache is cleared, and the next read request gets fresh data. The downside is complexity: you must map every write operation to the cache keys it affects, and if you miss one, you have a stale cache with no TTL to save you. In practice, most teams use event-driven invalidation *with* a TTL safety net. The event clears the cache immediately (best case), but the TTL ensures it clears eventually even if the event fails.

### Strategy 3: Version-Based Invalidation

Instead of deleting cache keys, you embed a version number in the key itself. When the data changes, you increment the version. Old keys become unreachable because no one will request them with the old version number.

```typescript
// src/cache/version-based-invalidation.service.ts

export class VersionBasedCacheService {
  private readonly versionKey = 'cache:versions';

  constructor(private readonly redis: Redis) {}

  /**
   * Get the current version for an entity type.
   * Stored in a Redis hash: { hotels: 3, rooms: 7, bookings: 12 }
   */
  async getCurrentVersion(entity: string): Promise<number> {
    const version = await this.redis.hget(this.versionKey, entity);
    return version ? parseInt(version, 10) : 1;
  }

  /**
   * Bump the version for an entity type.
   * All cached entries with the old version become invisible.
   */
  async bumpVersion(entity: string): Promise<number> {
    return await this.redis.hincrby(this.versionKey, entity, 1);
  }

  /**
   * Build a cache key that includes the version number.
   * Example: "cache:hotels:v3:42" -- when version bumps to 4,
   * no one will ever request "v3" again.
   */
  async buildVersionedKey(
    entity: string,
    id: string
  ): Promise<string> {
    const version = await this.getCurrentVersion(entity);
    return `cache:${entity}:v${version}:${id}`;
  }

  /**
   * Example: versioned hotel lookup
   */
  async getHotel(hotelId: bigint, prisma: PrismaClient): Promise<Hotel> {
    const key = await this.buildVersionedKey(
      'hotels', hotelId.toString()
    );
    const cached = await this.redis.get(key);

    if (cached) {
      return JSON.parse(cached);
    }

    // Raw SQL equivalent:
    //   SELECT * FROM hotels WHERE id = ?
    const hotel = await prisma.hotel.findUniqueOrThrow({
      where: { id: hotelId },
    });

    await this.redis.setex(key, 3600, JSON.stringify(hotel));
    return hotel;
  }

  /**
   * When hotel data changes, bump the version.
   * Old cache entries with the previous version will naturally expire
   * via their TTL since no new requests will reference them.
   */
  async onHotelDataChanged(): Promise<void> {
    await this.bumpVersion('hotels');
    // Old keys like "cache:hotels:v3:*" are now orphaned.
    // They will expire via TTL. No need to scan and delete.
  }
}
```

> **Trade-off summary for invalidation strategies:**

```
┌───────────────────────┬───────────┬───────────────┬──────────────┐
│ Factor                │ TTL-Based │ Event-Driven  │ Version-Based│
├───────────────────────┼───────────┼───────────────┼──────────────┤
│ Freshness             │ Minutes   │ Seconds       │ Seconds      │
│ Implementation effort │ Trivial   │ High          │ Medium       │
│ Memory overhead       │ Low       │ Low           │ Medium (old  │
│                       │           │               │ keys linger) │
│ Risk of stale data    │ High      │ Very low      │ Very low     │
│ Can miss edge cases?  │ No (TTL   │ Yes (if event │ No (version  │
│                       │ always    │ is missed)    │ is global)   │
│                       │ expires)  │               │              │
│ Best combined with    │ Nothing   │ TTL safety    │ TTL cleanup  │
│                       │ (works    │ net           │ of old keys  │
│                       │ alone)    │               │              │
└───────────────────────┴───────────┴───────────────┴──────────────┘
```

---

## The Cache Stampede Problem (Thundering Herd)

Here is a scenario that has brought down production systems at companies far larger than ours. A cache key holds the result of an expensive database query -- say, the top 500 hotels in Tokyo with real-time pricing and availability, a query that takes 800 milliseconds to compute. The cache key expires at exactly 14:00:00. At 14:00:01, 2,000 concurrent requests arrive for the same data. Every single one sees a cache miss. Every single one fires the same 800ms query against the database. The database receives 2,000 identical expensive queries simultaneously. It buckles. Response times spike. Timeouts cascade. The system goes down.

This is the **cache stampede**, also known as the **thundering herd** problem.

```
  14:00:00 - Cache key expires
  14:00:01 - 2,000 requests arrive simultaneously
         │
         ├── Request 1: cache miss → fires DB query (800ms)
         ├── Request 2: cache miss → fires DB query (800ms)
         ├── Request 3: cache miss → fires DB query (800ms)
         │   ... 1,997 more identical queries ...
         ├── Request 2000: cache miss → fires DB query (800ms)
         │
  Database: 2,000 copies of the same expensive query
            CPU spikes to 100%, connections exhausted
            ☠️  System goes down
```

There are two elegant solutions.

### Solution 1: Distributed Locking (Mutex-Based Refresh)

When a cache miss occurs, the first request acquires a lock. All other requests wait for the lock to release, then read the freshly populated cache. Only one query ever hits the database.

```typescript
// src/cache/stampede-prevention.service.ts

export class StampedePreventionService {
  private readonly lockPrefix = 'lock:cache:';
  private readonly lockTTL = 10; // Lock expires after 10 seconds

  constructor(private readonly redis: Redis) {}

  /**
   * Fetch with a distributed lock to prevent stampede.
   * Only the lock holder queries the database.
   * Everyone else waits and reads from cache.
   */
  async fetchWithLock<T>(
    cacheKey: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    const lockKey = `${this.lockPrefix}${cacheKey}`;

    // ─── Try to acquire the lock ───
    // SET lockKey "1" NX EX 10
    // NX = only set if key does Not eXist (atomic lock)
    // EX = auto-expire after 10 seconds (prevents deadlock)
    const acquired = await this.redis.set(
      lockKey, '1', 'EX', this.lockTTL, 'NX'
    );

    if (acquired === 'OK') {
      // ─── WE are the lock holder. Query the database. ───
      try {
        const data = await fetchFn();

        // Populate the cache so everyone else can read it
        const entry = {
          data,
          cachedAt: Date.now(),
          version: 1,
        };
        await this.redis.setex(
          cacheKey, ttlSeconds, JSON.stringify(entry)
        );

        return data;
      } finally {
        // Always release the lock, even if the query failed
        await this.redis.del(lockKey);
      }
    }

    // ─── We did NOT get the lock. Someone else is refreshing. ───
    // Wait for the cache to be populated, with a timeout.
    return await this.waitForCache<T>(cacheKey, 5000);
  }

  /**
   * Poll the cache until the lock holder populates it.
   * Uses exponential backoff starting at 50ms.
   */
  private async waitForCache<T>(
    cacheKey: string,
    timeoutMs: number
  ): Promise<T> {
    const startTime = Date.now();
    let delay = 50; // Start polling at 50ms intervals

    while (Date.now() - startTime < timeoutMs) {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const entry = JSON.parse(cached);
        return entry.data as T;
      }

      // Exponential backoff: 50ms, 100ms, 200ms, 400ms...
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 500); // Cap at 500ms
    }

    // Timeout -- fall through and let the caller decide
    throw new Error(
      `Cache wait timeout for ${cacheKey} after ${timeoutMs}ms`
    );
  }
}
```

### Solution 2: Probabilistic Early Expiry (PER)

Instead of all keys expiring at the exact same moment, each request has a small random chance of refreshing the cache *before* it expires. The first request that "wins" the random draw refreshes the cache in the background. By the time the TTL actually expires, the cache has already been refreshed.

This approach is elegant because it requires no locks, no coordination, and no blocking.

```typescript
// src/cache/probabilistic-early-refresh.service.ts

/**
 * Probabilistic Early Expiry: Refresh cache BEFORE TTL expires.
 *
 * Based on the paper "Optimal Probabilistic Cache Stampede Prevention"
 * The formula:  currentTime - (ttl * beta * ln(random))  > expiry
 *
 * As we get closer to expiry, the probability of refreshing increases.
 * Some request will randomly trigger a refresh before the TTL hits zero.
 */
export class ProbabilisticEarlyRefreshService {
  /**
   * beta controls how aggressively we refresh early.
   * Higher beta = earlier refresh = more safety margin.
   * 1.0 is a good default. 2.0 refreshes much earlier.
   */
  private readonly beta = 1.0;

  constructor(private readonly redis: Redis) {}

  async getWithEarlyRefresh<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    const cached = await this.redis.get(key);

    if (cached) {
      const entry = JSON.parse(cached);
      const ttlRemaining = await this.redis.ttl(key);

      // ─── Should we refresh early? ───
      // As TTL approaches 0, this becomes more likely.
      if (this.shouldRefreshEarly(ttlRemaining, ttlSeconds)) {
        // Refresh in the background -- do NOT block the response.
        this.refreshInBackground(key, fetchFn, ttlSeconds);
      }

      return entry.data as T;
    }

    // Standard cache miss
    const data = await fetchFn();
    const entry = { data, cachedAt: Date.now(), version: 1 };
    await this.redis.setex(key, ttlSeconds, JSON.stringify(entry));
    return data;
  }

  /**
   * The magic formula. Returns true if this request should
   * trigger an early refresh.
   */
  private shouldRefreshEarly(
    ttlRemaining: number,
    originalTTL: number
  ): boolean {
    // Never refresh if more than 50% of TTL remains
    if (ttlRemaining > originalTTL * 0.5) return false;

    // The PER formula:
    // gap = -beta * ln(random())
    // If gap > ttlRemaining, refresh now.
    const gap = -this.beta * Math.log(Math.random()) * originalTTL * 0.1;
    return gap > ttlRemaining;
  }

  /**
   * Refresh cache in the background.
   * The current request returns immediately with cached data.
   * The next request gets fresh data.
   */
  private async refreshInBackground<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): Promise<void> {
    try {
      const freshData = await fetchFn();
      const entry = { data: freshData, cachedAt: Date.now(), version: 1 };
      await this.redis.setex(key, ttlSeconds, JSON.stringify(entry));
    } catch (err) {
      // Background refresh failed -- not critical.
      // The existing cached data is still valid until TTL expires.
      console.warn(`Background refresh failed for ${key}:`, err);
    }
  }
}
```

> **Mentor's Note:** In practice, use both solutions together. Probabilistic early expiry handles the common case -- a popular key being refreshed smoothly before expiry. Distributed locking handles the edge case -- the key actually expires and multiple requests stampede. Belt and suspenders.

---

## Multi-Layer Caching: L1 + L2 + L3

A single cache layer is good. Three layers working together is production-grade. Think of it like CPU caches: L1 is tiny and blazing fast, L2 is bigger and still fast, L3 is huge but slower. In our architecture:

- **L1 -- In-Process Memory (Map / LRU):** Lives inside your Node.js process. Zero network latency. But it is lost on restart and not shared across instances.
- **L2 -- Redis:** Shared across all instances. Sub-millisecond network latency. Survives application restarts. But it is still a network hop away.
- **L3 -- CDN (CloudFront / Cloudflare):** Sits at the network edge, closest to the user. Perfect for static or semi-static content like hotel images, country lists, and amenity catalogs.

```
   ┌──────────┐     ┌─────────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
   │  Client  │────>│  CDN (L3)   │────>│  App     │────>│  Redis   │────>│ Database │
   │          │     │ CloudFront  │     │  Server  │     │  (L2)    │     │ (MySQL)  │
   │          │     │             │     │  + L1    │     │          │     │          │
   │          │     │ TTL: hours  │     │  Map()   │     │ TTL: min │     │ (source  │
   │          │     │             │     │  TTL: s  │     │          │     │  of truth)│
   └──────────┘     └─────────────┘     └──────────┘     └──────────┘     └──────────┘

   Hit path:  Client → CDN hit (fastest, ~5ms)
              Client → CDN miss → L1 hit (~1ms)
              Client → CDN miss → L1 miss → L2 hit (~3ms)
              Client → CDN miss → L1 miss → L2 miss → DB (~20ms)
```

```typescript
// src/cache/multi-layer-cache.service.ts
import { LRUCache } from 'lru-cache';
import Redis from 'ioredis';

interface CacheLayerConfig {
  l1MaxEntries: number;   // How many items L1 can hold
  l1TTLMs: number;        // L1 TTL in milliseconds
  l2TTLSeconds: number;   // L2 (Redis) TTL in seconds
}

export class MultiLayerCacheService {
  private readonly l1Cache: LRUCache<string, string>;
  private readonly redis: Redis;
  private readonly config: CacheLayerConfig;

  constructor(redis: Redis, config?: Partial<CacheLayerConfig>) {
    this.redis = redis;
    this.config = {
      l1MaxEntries: 10_000,      // 10k entries in process memory
      l1TTLMs: 30_000,           // 30 seconds in L1
      l2TTLSeconds: 300,         // 5 minutes in L2
      ...config,
    };

    // L1: In-process LRU cache
    // LRU = Least Recently Used. When the cache is full,
    // the entry that has not been accessed the longest is evicted.
    this.l1Cache = new LRUCache<string, string>({
      max: this.config.l1MaxEntries,
      ttl: this.config.l1TTLMs,
      updateAgeOnGet: true,       // Reset TTL on read (keep hot data)
      allowStale: false,
    });
  }

  /**
   * Multi-layer read: L1 → L2 → Database
   * Each layer that misses populates itself from the layer below.
   */
  async get<T>(
    key: string,
    fetchFn: () => Promise<T>,
    options?: { l2TTL?: number }
  ): Promise<T> {
    // ─── Layer 1: In-Process Memory (~0.01ms) ───
    const l1Value = this.l1Cache.get(key);
    if (l1Value) {
      return JSON.parse(l1Value) as T;
    }

    // ─── Layer 2: Redis (~1-3ms) ───
    try {
      const l2Value = await this.redis.get(key);
      if (l2Value) {
        // Promote to L1 for faster access next time
        this.l1Cache.set(key, l2Value);
        return JSON.parse(l2Value) as T;
      }
    } catch (err) {
      console.warn(`L2 cache read failed for ${key}:`, err);
    }

    // ─── Layer 3 (Source): Database (~10-50ms) ───
    const data = await fetchFn();
    const serialized = JSON.stringify(data);

    // Populate both L1 and L2
    this.l1Cache.set(key, serialized);
    try {
      const ttl = options?.l2TTL ?? this.config.l2TTLSeconds;
      await this.redis.setex(key, ttl, serialized);
    } catch (err) {
      console.warn(`L2 cache write failed for ${key}:`, err);
    }

    return data;
  }

  /**
   * Invalidate across ALL layers.
   * This is critical: if you only invalidate L2 but forget L1,
   * some instances will serve stale data from their process memory.
   */
  async invalidate(key: string): Promise<void> {
    // L1: Remove from this instance's memory
    this.l1Cache.delete(key);

    // L2: Remove from Redis (shared across all instances)
    await this.redis.del(key);

    // For L1 invalidation across OTHER instances, we use Redis Pub/Sub.
    // This instance publishes an invalidation message; other instances
    // subscribe and clear their own L1 caches.
    await this.redis.publish('cache:invalidate', key);
  }

  /**
   * Listen for invalidation messages from other instances.
   * Call this once during application startup.
   */
  async subscribeToInvalidations(subscriber: Redis): Promise<void> {
    await subscriber.subscribe('cache:invalidate');
    subscriber.on('message', (channel, key) => {
      if (channel === 'cache:invalidate') {
        this.l1Cache.delete(key);
      }
    });
  }

  /**
   * Get stats for monitoring and debugging.
   */
  getL1Stats(): { size: number; maxSize: number; hitRate: string } {
    return {
      size: this.l1Cache.size,
      maxSize: this.config.l1MaxEntries,
      hitRate: `${this.l1Cache.size}/${this.config.l1MaxEntries}`,
    };
  }
}
```

> **Analogy:** Think of multi-layer caching like a student taking an exam. The L1 cache is what they remember off the top of their head -- instant recall, but limited capacity. The L2 cache is their notes on the desk -- takes a moment to look up, but much more content. The L3 (database) is the textbook in their backpack -- complete and authoritative, but takes the longest to access. A well-prepared student (a well-cached system) answers most questions from memory without ever opening the textbook.

> **Key Term:** **LRU (Least Recently Used)** -- An eviction policy for caches with limited capacity. When the cache is full and a new entry needs to be added, the entry that was accessed least recently is removed. This ensures that frequently accessed data stays in cache while rarely accessed data is evicted. It is the default eviction strategy for most in-memory caches.

---

## Cache Warming on Deployment

When you deploy a new version of your application, every instance starts with empty L1 and L2 caches. The first wave of traffic after deployment hits the database directly. If your deployment happens during peak hours, this "cold cache" surge can overload the database.

Cache warming solves this by proactively loading frequently accessed data into the cache before the application starts serving traffic.

```typescript
// src/cache/cache-warmer.service.ts
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';

@Injectable()
export class CacheWarmerService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: MultiLayerCacheService,
    private readonly redis: Redis
  ) {}

  /**
   * Called automatically by NestJS when the application starts.
   * Warms the cache BEFORE the app begins accepting HTTP requests.
   */
  async onApplicationBootstrap(): Promise<void> {
    console.log('[CacheWarmer] Starting cache warm-up...');
    const startTime = Date.now();

    await Promise.all([
      this.warmTopCities(),
      this.warmPopularHotels(),
      this.warmStaticData(),
    ]);

    const elapsed = Date.now() - startTime;
    console.log(`[CacheWarmer] Warm-up complete in ${elapsed}ms`);
  }

  /**
   * Pre-load hotels for the top 20 most-searched cities.
   */
  private async warmTopCities(): Promise<void> {
    // Raw SQL version:
    //   SELECT city, COUNT(*) as search_count
    //   FROM search_logs
    //   WHERE created_at > NOW() - INTERVAL 7 DAY
    //   GROUP BY city
    //   ORDER BY search_count DESC
    //   LIMIT 20

    const topCities = await this.prisma.$queryRaw<
      { city: string; search_count: bigint }[]
    >`
      SELECT city, COUNT(*) as search_count
      FROM search_logs
      WHERE created_at > NOW() - INTERVAL 7 DAY
      GROUP BY city
      ORDER BY search_count DESC
      LIMIT 20
    `;

    for (const { city } of topCities) {
      const hotels = await this.prisma.hotel.findMany({
        where: { city, isActive: true },
        orderBy: { starRating: 'desc' },
        take: 50,
      });

      await this.cache.get(
        `cache:v1:search:hotels:${city}`,
        async () => hotels,
        { l2TTL: 600 } // 10 minutes
      );
    }

    console.log(
      `[CacheWarmer] Warmed ${topCities.length} city searches`
    );
  }

  /**
   * Pre-load the 100 most-booked hotels with full details.
   */
  private async warmPopularHotels(): Promise<void> {
    // Raw SQL version:
    //   SELECT h.id FROM hotels h
    //   JOIN bookings b ON b.hotel_id = h.id
    //   WHERE b.created_at > NOW() - INTERVAL 30 DAY
    //   GROUP BY h.id
    //   ORDER BY COUNT(*) DESC
    //   LIMIT 100

    const popularHotels = await this.prisma.hotel.findMany({
      where: {
        isActive: true,
        bookings: {
          some: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
        },
      },
      include: {
        rooms: { where: { isAvailable: true } },
      },
      orderBy: {
        bookings: { _count: 'desc' },
      },
      take: 100,
    });

    for (const hotel of popularHotels) {
      await this.cache.get(
        `cache:v1:hotels:${hotel.id}`,
        async () => hotel,
        { l2TTL: 3600 } // 1 hour
      );
    }

    console.log(
      `[CacheWarmer] Warmed ${popularHotels.length} popular hotels`
    );
  }

  /**
   * Pre-load data that almost never changes.
   */
  private async warmStaticData(): Promise<void> {
    // Country list, currency rates, amenity catalogs, etc.
    const countries = await this.prisma.$queryRaw<
      { country: string; hotel_count: bigint }[]
    >`
      SELECT country, COUNT(*) as hotel_count
      FROM hotels WHERE is_active = 1
      GROUP BY country
      ORDER BY hotel_count DESC
    `;

    await this.cache.get(
      'cache:v1:static:countries',
      async () => countries,
      { l2TTL: 86400 } // 24 hours
    );

    console.log('[CacheWarmer] Warmed static reference data');
  }
}
```

> **Checkpoint:** Notice that the cache warmer runs *before* the application starts accepting HTTP requests. In NestJS, `OnApplicationBootstrap` fires during the bootstrap sequence. If you combine this with a Kubernetes readiness probe, the load balancer will not send traffic to the new instance until cache warming is complete. This eliminates the cold-cache problem entirely.

---

## Consistent Hashing for Distributed Cache

When your Redis cluster has multiple shards, you need to decide which shard holds which keys. Naive modular hashing (`hash(key) % numShards`) breaks catastrophically when you add or remove shards -- almost every key maps to a different shard, causing a mass cache miss event.

Consistent hashing solves this by mapping both keys and shards to points on a circular hash ring. A key is stored on the first shard encountered when moving clockwise around the ring. When a shard is added or removed, only keys between the new shard and its neighbor are remapped -- roughly `1/n` of total keys instead of nearly all of them.

```
  Naive Hashing: Add one shard → ~80% of keys remap → mass cache miss
  Consistent Hashing: Add one shard → ~(1/n) of keys remap → minimal impact

  Hash Ring Visualization:
                    0°
                    │
            Shard A ●───────────● Shard B
           /                           \
          /     Keys in this arc        \
         /      go to Shard B            \
        │                                 │
  270° ─┤                                 ├─ 90°
        │                                 │
         \                               /
          \     Keys in this arc        /
           \    go to Shard C          /
            Shard D ●───────────● Shard C
                    │
                   180°

  Adding Shard E between A and B:
  Only keys in arc A→E remap. Everything else stays put.
```

```typescript
// src/cache/consistent-hash-ring.ts
import { createHash } from 'crypto';

interface HashRingNode {
  name: string;            // e.g., "redis-shard-1"
  host: string;
  port: number;
}

export class ConsistentHashRing {
  private ring: Map<number, HashRingNode> = new Map();
  private sortedHashes: number[] = [];

  /**
   * Virtual nodes: each physical shard gets multiple positions
   * on the ring. This ensures even key distribution.
   * Without virtual nodes, shards can end up with wildly
   * uneven load depending on where their hash falls.
   */
  private readonly virtualNodes = 150;

  /**
   * Add a shard to the hash ring.
   * Called when a new Redis instance joins the cluster.
   */
  addNode(node: HashRingNode): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${node.name}:vnode:${i}`;
      const hash = this.hashKey(virtualKey);
      this.ring.set(hash, node);
      this.sortedHashes.push(hash);
    }
    this.sortedHashes.sort((a, b) => a - b);
  }

  /**
   * Remove a shard from the ring.
   * Called when a Redis instance is decommissioned.
   * Only keys that were on this shard need to be re-fetched.
   */
  removeNode(nodeName: string): void {
    const hashesToRemove: number[] = [];

    for (const [hash, node] of this.ring.entries()) {
      if (node.name === nodeName) {
        hashesToRemove.push(hash);
      }
    }

    for (const hash of hashesToRemove) {
      this.ring.delete(hash);
    }

    this.sortedHashes = this.sortedHashes.filter(
      (h) => !hashesToRemove.includes(h)
    );
  }

  /**
   * Find which shard should hold a given cache key.
   * Walk clockwise around the ring until you hit a shard.
   */
  getNode(key: string): HashRingNode {
    if (this.ring.size === 0) {
      throw new Error('Hash ring is empty -- no shards available');
    }

    const hash = this.hashKey(key);

    // Binary search for the first shard position >= hash
    let low = 0;
    let high = this.sortedHashes.length - 1;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sortedHashes[mid] < hash) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    // If we wrapped around the ring, use the first shard
    const shardHash = this.sortedHashes[low] ?? this.sortedHashes[0];
    return this.ring.get(shardHash)!;
  }

  /**
   * Hash a key to a 32-bit integer position on the ring.
   */
  private hashKey(key: string): number {
    const hash = createHash('md5').update(key).digest();
    return hash.readUInt32BE(0);
  }
}
```

> **Key Term:** **Consistent Hashing** -- A technique for distributing keys across a dynamic set of servers such that adding or removing a server only requires remapping approximately `K/n` keys (where K is the total number of keys and n is the number of servers). Without consistent hashing, adding a server remaps nearly all keys, causing a massive cache miss storm.

---

## Full NestJS CacheModule Implementation

Now let us pull everything together into a production-grade NestJS module with decorators. This is the layer that your application developers interact with -- they should not need to think about Redis, TTLs, or stampede prevention. They just add a decorator and the caching happens automatically.

```typescript
// src/cache/cache.module.ts
import { Module, Global } from '@nestjs/common';
import { CacheInterceptor } from './cache.interceptor';
import { CacheService } from './cache.service';
import { CacheWarmerService } from './cache-warmer.service';
import { CacheMetricsService } from './cache-metrics.service';

@Global()
@Module({
  providers: [
    CacheService,
    CacheInterceptor,
    CacheWarmerService,
    CacheMetricsService,
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        return new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 3,
          retryStrategy: (times) => Math.min(times * 50, 2000),
          enableReadyCheck: true,
        });
      },
    },
  ],
  exports: [CacheService, 'REDIS_CLIENT'],
})
export class CacheModule {}
```

```typescript
// src/cache/cacheable.decorator.ts
import { SetMetadata } from '@nestjs/common';

/**
 * Decorator interface: configure caching for a controller method.
 * Usage: @Cacheable({ ttl: 300, namespace: 'hotels' })
 */
export interface CacheableOptions {
  ttl?: number;              // Time-to-live in seconds
  namespace?: string;        // Key namespace
  version?: number;          // Cache version
  keyGenerator?: (...args: any[]) => string; // Custom key builder
  preventStampede?: boolean; // Enable mutex-based refresh
  earlyRefresh?: boolean;    // Enable probabilistic early refresh
}

export const CACHEABLE_KEY = 'cache:options';

export function Cacheable(options: CacheableOptions = {}) {
  return SetMetadata(CACHEABLE_KEY, {
    ttl: options.ttl ?? 300,
    namespace: options.namespace ?? 'default',
    version: options.version ?? 1,
    preventStampede: options.preventStampede ?? false,
    earlyRefresh: options.earlyRefresh ?? false,
    keyGenerator: options.keyGenerator,
  });
}

/**
 * Decorator to mark a method as cache-invalidating.
 * When this method runs, the specified cache patterns are cleared.
 */
export const INVALIDATE_KEY = 'cache:invalidate';

export function InvalidateCache(patterns: string[]) {
  return SetMetadata(INVALIDATE_KEY, patterns);
}
```

```typescript
// src/cache/cache.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext,
  CallHandler, Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, of, from } from 'rxjs';
import { tap, switchMap } from 'rxjs/operators';
import { CACHEABLE_KEY, INVALIDATE_KEY, CacheableOptions } from './cacheable.decorator';
import { CacheService } from './cache.service';

@Injectable()
export class CacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cacheService: CacheService
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Observable<any> {
    // Check for @Cacheable decorator
    const cacheOptions = this.reflector.get<CacheableOptions>(
      CACHEABLE_KEY,
      context.getHandler()
    );

    // Check for @InvalidateCache decorator
    const invalidatePatterns = this.reflector.get<string[]>(
      INVALIDATE_KEY,
      context.getHandler()
    );

    // ─── Cache-read path ───
    if (cacheOptions) {
      const request = context.switchToHttp().getRequest();
      const cacheKey = this.buildCacheKey(
        request, cacheOptions, context
      );

      return from(
        this.cacheService.getOrSet(
          cacheKey,
          () => next.handle().toPromise(),
          cacheOptions.ttl,
          {
            namespace: cacheOptions.namespace,
            version: cacheOptions.version,
            preventStampede: cacheOptions.preventStampede,
            earlyExpiry: cacheOptions.earlyRefresh,
          }
        )
      );
    }

    // ─── Cache-invalidation path ───
    if (invalidatePatterns) {
      return next.handle().pipe(
        tap(async () => {
          for (const pattern of invalidatePatterns) {
            await this.cacheService.invalidate(pattern);
          }
        })
      );
    }

    // No caching decorator -- pass through unchanged
    return next.handle();
  }

  /**
   * Build a cache key from the request.
   * Uses the URL + query params + custom key generator if provided.
   */
  private buildCacheKey(
    request: any,
    options: CacheableOptions,
    context: ExecutionContext
  ): string {
    if (options.keyGenerator) {
      const args = context.getArgs();
      return options.keyGenerator(...args);
    }

    // Default: use URL path + sorted query params
    const path = request.url.split('?')[0];
    const params = new URLSearchParams(request.query);
    params.sort();
    return `${options.namespace}:${path}:${params.toString()}`;
  }
}
```

```typescript
// ─── Using the decorators in a controller ───
// src/hotels/hotels.controller.ts
import { Controller, Get, Put, Param, Body, Query } from '@nestjs/common';
import { Cacheable, InvalidateCache } from '../cache/cacheable.decorator';

@Controller('hotels')
export class HotelsController {
  constructor(private readonly hotelsService: HotelsService) {}

  /**
   * GET /hotels?city=tokyo&stars=5
   * Cached for 5 minutes. Stampede protection enabled.
   */
  @Get()
  @Cacheable({
    ttl: 300,
    namespace: 'search',
    preventStampede: true,
    earlyRefresh: true,
  })
  async searchHotels(
    @Query('city') city: string,
    @Query('stars') stars?: number
  ) {
    return this.hotelsService.search(city, stars);
  }

  /**
   * GET /hotels/:id
   * Cached for 1 hour with version-based invalidation.
   */
  @Get(':id')
  @Cacheable({
    ttl: 3600,
    namespace: 'hotels',
    version: 2,
    keyGenerator: (req) => `hotels:detail:${req.params.id}`,
  })
  async getHotel(@Param('id') id: string) {
    return this.hotelsService.findById(BigInt(id));
  }

  /**
   * PUT /hotels/:id/price
   * After updating, invalidate all caches that might contain
   * this hotel's data.
   */
  @Put(':id/price')
  @InvalidateCache([
    'search:*',         // All search results
    'hotels:detail:*',  // All hotel detail pages
  ])
  async updatePrice(
    @Param('id') id: string,
    @Body('price') price: number
  ) {
    return this.hotelsService.updatePrice(BigInt(id), price);
  }
}
```

> **Mentor's Note:** The beauty of this decorator-based approach is separation of concerns. The controller author writes business logic. The `@Cacheable` decorator handles caching transparently. If you need to change cache TTLs, add stampede prevention, or switch from Redis to Memcached, you change one interceptor -- not every controller in the application.

---

## Prisma Schema for Cache Invalidation Events

When cache invalidation events are mission-critical (they are in a booking system), you need an audit trail. This table records every invalidation event so you can debug stale data incidents and understand cache behavior in production.

**Raw SQL:**

```sql
CREATE TABLE cache_invalidation_events (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_type      VARCHAR(50) NOT NULL,
    entity_type     VARCHAR(50) NOT NULL,
    entity_id       VARCHAR(100) NOT NULL,
    cache_keys_cleared TEXT NOT NULL,
    keys_count      INT NOT NULL DEFAULT 0,
    triggered_by    VARCHAR(100) NOT NULL,
    reason          VARCHAR(255),
    processing_time_ms INT,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_entity (entity_type, entity_id),
    INDEX idx_created (created_at),
    INDEX idx_type_created (event_type, created_at)
) ENGINE=InnoDB;

-- Example query: find all invalidations for a hotel in the last hour
SELECT event_type, cache_keys_cleared, keys_count,
       triggered_by, reason, processing_time_ms
FROM cache_invalidation_events
WHERE entity_type = 'hotel'
  AND entity_id = '42'
  AND created_at > NOW() - INTERVAL 1 HOUR
ORDER BY created_at DESC;
```

**Prisma Schema:**

```prisma
// prisma/schema.prisma

model CacheInvalidationEvent {
  id               BigInt   @id @default(autoincrement())
  eventType        String   @map("event_type") @db.VarChar(50)
  entityType       String   @map("entity_type") @db.VarChar(50)
  entityId         String   @map("entity_id") @db.VarChar(100)
  cacheKeysCleared String   @map("cache_keys_cleared") @db.Text
  keysCount        Int      @default(0) @map("keys_count")
  triggeredBy      String   @map("triggered_by") @db.VarChar(100)
  reason           String?  @db.VarChar(255)
  processingTimeMs Int?     @map("processing_time_ms")
  createdAt        DateTime @default(now()) @map("created_at")

  @@index([entityType, entityId])
  @@index([createdAt])
  @@index([eventType, createdAt])
  @@map("cache_invalidation_events")
}
```

**Prisma Client usage -- logging invalidation events:**

```typescript
// src/cache/cache-invalidation-logger.service.ts

export class CacheInvalidationLogger {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Log every cache invalidation for debugging and auditing.
   * When a customer reports seeing a stale price, you can look up
   * exactly when that hotel's cache was last invalidated and by whom.
   */
  async logInvalidation(
    event: CacheInvalidationEvent,
    clearedKeys: string[],
    processingTimeMs: number
  ): Promise<void> {
    // Raw SQL equivalent:
    //   INSERT INTO cache_invalidation_events
    //     (event_type, entity_type, entity_id, cache_keys_cleared,
    //      keys_count, triggered_by, reason, processing_time_ms)
    //   VALUES (?, ?, ?, ?, ?, ?, ?, ?)

    await this.prisma.cacheInvalidationEvent.create({
      data: {
        eventType: event.operation,
        entityType: event.entity,
        entityId: event.entityId,
        cacheKeysCleared: JSON.stringify(clearedKeys),
        keysCount: clearedKeys.length,
        triggeredBy: `service:${event.entity}Service`,
        reason: `${event.operation} on fields: ${event.changedFields.join(', ')}`,
        processingTimeMs: processingTimeMs,
      },
    });
  }

  /**
   * Query recent invalidations for debugging stale data issues.
   */
  async getRecentInvalidations(
    entityType: string,
    entityId: string,
    hoursBack: number = 1
  ) {
    // Raw SQL equivalent:
    //   SELECT * FROM cache_invalidation_events
    //   WHERE entity_type = ? AND entity_id = ?
    //     AND created_at > NOW() - INTERVAL ? HOUR
    //   ORDER BY created_at DESC

    return this.prisma.cacheInvalidationEvent.findMany({
      where: {
        entityType,
        entityId,
        createdAt: {
          gte: new Date(Date.now() - hoursBack * 60 * 60 * 1000),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

---

## Monitoring Cache Hit Rates: Prometheus Metrics

You cannot improve what you do not measure. Cache hit rate is the single most important metric for your caching layer. If it drops below 90%, something is wrong -- your TTLs are too short, your key generation is too specific, or your invalidation is too aggressive.

```typescript
// src/cache/cache-metrics.service.ts
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, register } from 'prom-client';

@Injectable()
export class CacheMetricsService {
  // ─── Counters: total operations ───
  private readonly cacheHits = new Counter({
    name: 'cache_hits_total',
    help: 'Total number of cache hits',
    labelNames: ['namespace', 'layer'] as const,
  });

  private readonly cacheMisses = new Counter({
    name: 'cache_misses_total',
    help: 'Total number of cache misses',
    labelNames: ['namespace', 'layer'] as const,
  });

  private readonly cacheInvalidations = new Counter({
    name: 'cache_invalidations_total',
    help: 'Total number of cache invalidations',
    labelNames: ['namespace', 'reason'] as const,
  });

  private readonly cacheErrors = new Counter({
    name: 'cache_errors_total',
    help: 'Total number of cache operation errors',
    labelNames: ['operation', 'error_type'] as const,
  });

  // ─── Histograms: operation latency ───
  private readonly cacheLatency = new Histogram({
    name: 'cache_operation_duration_seconds',
    help: 'Cache operation latency in seconds',
    labelNames: ['operation', 'result'] as const,
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1],
  });

  // ─── Gauges: current state ───
  private readonly cacheSize = new Gauge({
    name: 'cache_l1_entries_current',
    help: 'Current number of entries in L1 cache',
  });

  private readonly cacheHitRate = new Gauge({
    name: 'cache_hit_rate_percent',
    help: 'Current cache hit rate as a percentage',
    labelNames: ['namespace'] as const,
  });

  // ─── Internal counters for hit rate calculation ───
  private hitCounts: Map<string, number> = new Map();
  private totalCounts: Map<string, number> = new Map();

  /**
   * Record a cache hit. Call this from CacheAsideService.getOrSet.
   */
  recordHit(namespace: string, layer: 'l1' | 'l2'): void {
    this.cacheHits.inc({ namespace, layer });
    this.hitCounts.set(
      namespace,
      (this.hitCounts.get(namespace) ?? 0) + 1
    );
    this.totalCounts.set(
      namespace,
      (this.totalCounts.get(namespace) ?? 0) + 1
    );
    this.updateHitRate(namespace);
  }

  /**
   * Record a cache miss.
   */
  recordMiss(namespace: string, layer: 'l1' | 'l2'): void {
    this.cacheMisses.inc({ namespace, layer });
    this.totalCounts.set(
      namespace,
      (this.totalCounts.get(namespace) ?? 0) + 1
    );
    this.updateHitRate(namespace);
  }

  /**
   * Record operation latency.
   */
  recordLatency(
    operation: 'get' | 'set' | 'invalidate',
    result: 'hit' | 'miss' | 'error',
    durationSeconds: number
  ): void {
    this.cacheLatency.observe({ operation, result }, durationSeconds);
  }

  /**
   * Record an invalidation event.
   */
  recordInvalidation(
    namespace: string,
    reason: 'ttl' | 'event' | 'version' | 'manual'
  ): void {
    this.cacheInvalidations.inc({ namespace, reason });
  }

  /**
   * Update the hit rate gauge for Grafana dashboards.
   */
  private updateHitRate(namespace: string): void {
    const hits = this.hitCounts.get(namespace) ?? 0;
    const total = this.totalCounts.get(namespace) ?? 0;
    const rate = total > 0 ? (hits / total) * 100 : 0;
    this.cacheHitRate.set({ namespace }, rate);
  }

  /**
   * Expose a /metrics endpoint for Prometheus scraping.
   * Typical Grafana alert: cache_hit_rate_percent < 85 for 5m
   */
  async getMetrics(): Promise<string> {
    return register.metrics();
  }
}
```

```
Example Prometheus queries for your Grafana dashboard:

# Overall cache hit rate (should be > 90%)
cache_hit_rate_percent{namespace="search"}

# Cache latency p99 (should be < 10ms for L2)
histogram_quantile(0.99, cache_operation_duration_seconds_bucket{operation="get"})

# Invalidation rate (sudden spikes indicate problems)
rate(cache_invalidations_total[5m])

# Error rate (should be near zero)
rate(cache_errors_total[5m])

# Alert rule: cache hit rate drops below 85%
ALERT CacheHitRateLow
  IF cache_hit_rate_percent < 85
  FOR 5m
  LABELS { severity = "warning" }
  ANNOTATIONS {
    summary = "Cache hit rate is {{ $value }}%",
    description = "Cache hit rate for {{ $labels.namespace }} has been below 85% for 5 minutes. Check for TTL misconfiguration or excessive invalidation."
  }
```

> **Checkpoint:** In our production system, we set alerts at three thresholds. Below 95% is a warning -- investigate soon. Below 90% is critical -- someone should investigate now. Below 80% means something is fundamentally broken and the database is under heavy load. Every percentage point of hit rate matters: going from 95% to 90% doubles the number of database queries.

---

## Production War Story: The Stale Price Incident

This one cost a team real money.

A hotel partner updated their room prices at 2:00 PM on a Friday afternoon. They dropped the price of their deluxe suite from $450/night to $280/night for a weekend promotion. The price update went through the admin API, which correctly updated the database. But the admin API did not emit a cache invalidation event for the search results cache.

The hotel detail page? Updated immediately -- it used write-through caching. But the search results for "luxury hotels in Tokyo" still showed $450 because the search cache had a 10-minute TTL.

Users saw $450 on the search page, clicked through, and saw $280 on the detail page. Some users thought the detail page price was an error and did not book. Others booked at $280 and the partner was happy -- but they had expected the lower price to appear in search results immediately to drive more traffic.

Here is the timeline:

```
14:00:00  Partner updates price: $450 → $280
14:00:01  Database: $280 ✓
14:00:01  Hotel detail cache: $280 ✓ (write-through)
14:00:01  Search results cache: still $450 ✗ (TTL has 8 min left)
14:00:02  User searches "Tokyo luxury" → sees $450
14:03:00  User searches "Tokyo luxury" → sees $450
14:07:00  User searches "Tokyo luxury" → sees $450
14:08:00  Search cache TTL expires → next search shows $280
```

For 8 minutes, every user who searched for hotels in Tokyo saw the wrong price. During peak hours, that is thousands of impressions showing incorrect data.

**The fix involved three changes:**

1. The hotel update endpoint now emits an invalidation event that clears ALL related caches, not just the detail cache.
2. Search result caches include a dependency map -- when hotel #42 changes, every search result that contains hotel #42 is invalidated.
3. Prices specifically use a 30-second TTL instead of 10 minutes, with event-driven invalidation as the primary mechanism and TTL as the safety net.

```typescript
// The fix: comprehensive cache invalidation on price change
async updateHotelPrice(hotelId: bigint, newPrice: number) {
  const hotel = await this.prisma.hotel.update({
    where: { id: hotelId },
    data: { basePrice: newPrice },
  });

  // Before the fix: only invalidated the hotel detail cache
  // await this.cache.invalidate(`hotels:detail:${hotelId}`);

  // After the fix: invalidate EVERYTHING that references this hotel
  await Promise.all([
    this.cache.invalidate(`hotels:detail:${hotelId}`),
    this.cache.invalidate(`search:*:${hotel.city}:*`),
    this.cache.invalidate(`availability:*:${hotelId}:*`),
    this.cache.invalidate(`pricing:*:${hotelId}:*`),
  ]);

  // Log it for the audit trail
  await this.invalidationLogger.logInvalidation(
    {
      entity: 'hotel',
      entityId: hotelId.toString(),
      operation: 'price_update',
      changedFields: ['basePrice'],
      timestamp: Date.now(),
    },
    ['detail', 'search', 'availability', 'pricing'],
    Date.now() - startTime
  );
}
```

> **Lesson learned:** Cache invalidation bugs are insidious because the system *appears* to work. The API returns 200. The database has correct data. The hotel detail page shows the right price. Everything looks fine until you realize that thousands of users are seeing a different number on a different page -- and nobody is monitoring for it. Always invalidate broadly, and always have TTL as a safety net.

---

## Common Mistakes

**Mistake 1: Caching Without a TTL**

```typescript
// WRONG: no TTL -- this key lives forever
await redis.set(`hotel:${id}`, JSON.stringify(hotel));

// RIGHT: always set a TTL, even if it is long
await redis.setex(`hotel:${id}`, 86400, JSON.stringify(hotel));
// 86400 seconds = 24 hours. Even "static" data should expire eventually.
```

If the key has no TTL and your invalidation logic has a bug, you serve stale data forever. TTL is your safety net. Every key must have one.

**Mistake 2: N+1 Cache Calls**

```typescript
// WRONG: fetching each hotel individually inside a loop
const hotels = await getHotelIdsForCity('tokyo');
for (const id of hotels) {
  const hotel = await cache.get(`hotel:${id}`); // 50 Redis round-trips!
  results.push(hotel);
}

// RIGHT: use Redis MGET to fetch all keys in a single round-trip
const keys = hotels.map(id => `hotel:${id}`);
const results = await redis.mget(...keys);
// 1 Redis round-trip instead of 50
```

Each Redis round-trip takes 1-3ms. Fifty of them in a loop turns a 3ms operation into a 150ms operation.

**Mistake 3: Forgetting to Invalidate Related Caches**

When a hotel's price changes, you invalidate the hotel detail cache. But what about the search results cache that lists this hotel? The user's "recently viewed" cache that shows the old price? The comparison page that shows prices side-by-side? Every cache key that contains derived data from the changed entity must be invalidated. This is why dependency mapping matters.

**Mistake 4: Using the Same TTL for Everything**

```typescript
// WRONG: one TTL for all data types
const CACHE_TTL = 300; // 5 minutes for EVERYTHING

// RIGHT: TTL should match how often the data changes
const TTL_HOTEL_DETAILS = 3600;   // 1 hour  -- changes rarely
const TTL_ROOM_PRICING  = 30;     // 30 sec  -- changes often
const TTL_BOOKING_STATUS = 15;    // 15 sec  -- changes per transaction
```

Static data with a short TTL wastes Redis operations on unnecessary refreshes. Dynamic data with a long TTL serves stale information. Match the TTL to the data's volatility.

**Mistake 5: Not Handling Redis Failures Gracefully**

```typescript
// WRONG: let Redis errors crash the request
const data = await redis.get(key); // If Redis is down, this throws

// RIGHT: degrade gracefully to database
let data;
try {
  data = await redis.get(key);
} catch (err) {
  console.warn('Redis unavailable, falling back to DB');
  // Fall through to database query
}
```

Redis is a performance optimization, not a dependency. If it goes down, your application should still work -- just slower.

**Mistake 6: Storing Enormous Objects in Cache**

```typescript
// WRONG: caching the entire hotel with all relations
const hotel = await prisma.hotel.findUnique({
  where: { id: hotelId },
  include: {
    rooms: true,           // 200 rooms
    bookings: true,        // 50,000 bookings
    reviews: true,         // 10,000 reviews
    photos: true,          // 500 photos
  },
});
await redis.setex(key, 3600, JSON.stringify(hotel));
// This single key is 5MB. Redis is an in-memory store.

// RIGHT: cache only what the client needs
const hotel = await prisma.hotel.findUnique({
  where: { id: hotelId },
  select: {
    id: true, name: true, city: true,
    starRating: true, basePrice: true,
  },
});
await redis.setex(key, 3600, JSON.stringify(hotel));
// This key is 200 bytes. 25,000x smaller.
```

Redis stores everything in RAM. Storing 5MB per hotel key means 100 hotels consume 500MB. Select only the fields the consumer needs and cache the minimal representation.

---

## Chapter Summary

```
┌─────────────────────────────────┬─────────────────────────────────────────┐
│ Concept                         │ Key Takeaway                            │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Cache-Aside (Lazy Loading)      │ App checks cache → miss → query DB →   │
│                                 │ store in cache. Simple, resilient.      │
│                                 │ Best for read-heavy workloads.          │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Write-Through                   │ Write to DB and cache simultaneously.   │
│                                 │ Strong consistency, slower writes.      │
│                                 │ Best for prices and inventory.          │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Write-Behind (Write-Back)       │ Write to cache first, flush to DB      │
│                                 │ asynchronously. Fastest writes, risk    │
│                                 │ of data loss. Best for counters.        │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ TTL-Based Invalidation          │ Simplest strategy. Keys auto-expire.   │
│                                 │ Data can be stale for up to TTL.       │
│                                 │ Always use as a safety net.            │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Event-Driven Invalidation       │ Emit events on write → clear cache.   │
│                                 │ Near-instant freshness. Complex to     │
│                                 │ implement correctly. Pair with TTL.    │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Version-Based Invalidation      │ Embed version in key. Bump version on  │
│                                 │ change. Old keys become unreachable.   │
│                                 │ No scanning needed.                    │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Cache Stampede Prevention       │ Distributed lock: only one request     │
│                                 │ queries DB on miss. PER: random early  │
│                                 │ refresh before TTL expires.            │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Multi-Layer (L1 + L2 + L3)     │ L1 (process memory): ~0.01ms.         │
│                                 │ L2 (Redis): ~1-3ms.                   │
│                                 │ L3 (CDN): closest to user.            │
│                                 │ Invalidate ALL layers together.        │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Cache Warming                   │ Pre-load popular data on deploy.       │
│                                 │ Prevents cold-cache database surge.    │
│                                 │ Use with Kubernetes readiness probes.  │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Consistent Hashing              │ Distribute keys across shards with     │
│                                 │ minimal remapping when shards change.  │
│                                 │ Use virtual nodes for even spread.     │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ Monitoring                      │ Track hit rate (target >95%), latency, │
│                                 │ invalidation rate, and error rate.     │
│                                 │ Alert when hit rate drops below 85%.   │
├─────────────────────────────────┼─────────────────────────────────────────┤
│ The Golden Rule                 │ Cache is a performance optimization,   │
│                                 │ NOT a dependency. If Redis goes down,  │
│                                 │ the app must still work. Degrade       │
│                                 │ gracefully, never catastrophically.    │
└─────────────────────────────────┴─────────────────────────────────────────┘
```

> **What is next:** In Chapter 25, we explore **Dead Letter Queues** — where failed messages go when they cannot be processed. You will learn how to catch, inspect, and replay messages that your consumers could not handle, turning silent data loss into a recoverable workflow.
