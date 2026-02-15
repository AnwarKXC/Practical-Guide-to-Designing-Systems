# Chapter 22: Rate Limiting — Protecting Your Castle Gates

## Why Rate Limiting Matters

You have deployed your booking API. It works. Users can search for hotels, create bookings, and check their reservations. You have authentication, authorization, and input validation in place. You feel safe.

You are not safe.

Here is what happens when your API is publicly accessible with no rate limits:

- **A competitor builds a scraping bot** that hits your search endpoint 10,000 times per minute, extracting every hotel price in every city. Your database connection pool is exhausted. Search latency quadruples for real users. Your infrastructure bill spikes.
- **A buggy mobile app has a retry loop with no backoff.** Every time a request fails, it retries instantly, forever. One user's broken phone generates more traffic than your next 1,000 users combined. Your error logging system fills up. Your on-call engineer gets paged at 3 AM.
- **An angry user writes a script** that submits booking requests in a tight loop, trying to overwhelm your system. They create 500 phantom bookings in 30 seconds, locking inventory for real customers.
- **A denial-of-service attack** sends a flood of requests from a botnet. Your Kubernetes pods auto-scale to 200 replicas. Your cloud bill hits $47,000 in a single afternoon.
- **A well-meaning partner integration** has a misconfigured batch job that re-syncs all 50,000 of their properties every 5 minutes instead of every 24 hours. They do not realize it until you tell them.

Rate limiting addresses three categories of risk:

### Abuse Prevention

Malicious actors — scrapers, credential stuffers, denial-of-service attackers — actively try to harm your system. Rate limiting is your first line of defense. It does not replace a WAF (Web Application Firewall) or DDoS mitigation service, but it catches the low-hanging fruit: automated scripts, poorly disguised bots, and brute-force attacks that would otherwise sail through to your application layer.

### Fair Usage

Even without malice, some clients consume a disproportionate share of your resources. A single travel agency running parallel search queries can starve out hundreds of casual users. Rate limiting enforces fairness: no single client gets to monopolize the system's capacity, regardless of their intentions.

### Cost Protection

In a cloud-native architecture, traffic spikes translate directly into money. Auto-scaling protects availability, but it does not protect your budget. Rate limiting acts as a **cost ceiling** — it caps the maximum resource consumption per client, preventing runaway compute and database costs from a single source of traffic.

> **Key Term:** **Rate Limiting** — Controlling the number of requests a client can make to your API within a given time window. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests) and tells the client when they can try again.

You may have seen `express-rate-limit` — the popular middleware that counts requests per IP address and returns a 429 status code when the limit is exceeded. That works for a single Express server. But in our booking system, we have multiple instances of each service running behind a load balancer. If User A sends 100 requests and those requests get distributed across 5 server instances, each instance only sees 20 requests. The per-instance counter never trips.

Distributed rate limiting solves this by storing the counters in a shared location — Redis — so all instances see the same count. This chapter builds that distributed rate limiter from scratch, covers five algorithms, integrates with NestJS and Kong, and handles production edge cases that tutorials skip.

> **Analogy:** Rate limiting is the toll booth on a highway. Without it, every car enters at full speed and the highway jams to a standstill. The toll booth does not care whether each driver is a daily commuter, a tourist, or someone trying to cause a traffic jam. It enforces a throughput limit that keeps traffic flowing for everyone.

---

## The Five Algorithms

There are five main approaches to counting requests against a limit. Each has tradeoffs in precision, memory usage, burst handling, and implementation complexity. Understanding all five will let you pick the right one for each situation in your system.

### Algorithm 1: Fixed Window

The simplest algorithm. Divide time into fixed intervals (say, one-minute windows). Count requests in the current window. If the count exceeds the limit, reject.

```
Window 1 (12:00:00 - 12:00:59)    Window 2 (12:01:00 - 12:01:59)
|==========================|      |==========================|
  45 requests (limit: 100)          12 requests (limit: 100)
  Status: OK                        Status: OK
```

Here is the full Redis implementation:

```typescript
// rate-limiting/algorithms/fixed-window.ts

import Redis from 'ioredis';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  resetAt: number; // Unix timestamp when window resets
}

export class FixedWindowRateLimiter {
  private readonly redis: Redis;

  // Lua script executes atomically inside Redis — no race conditions
  private readonly luaScript = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    -- Calculate the current window start
    local window_start = math.floor(now / window) * window
    local window_key = key .. ':' .. window_start

    -- Increment the counter for this window
    local current = redis.call('INCR', window_key)

    -- Set expiry on first request in this window
    if current == 1 then
      redis.call('EXPIRE', window_key, window + 1)
    end

    local reset_at = window_start + window

    if current > limit then
      local retry_after = reset_at - now
      return {0, 0, retry_after, reset_at}
    else
      return {1, limit - current, 0, reset_at}
    end
  `;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkRateLimit(params: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.redis.eval(
      this.luaScript,
      1,
      params.key,
      params.maxRequests,
      params.windowSeconds,
      now
    ) as [number, number, number, number];

    const [allowed, remaining, retryAfter, resetAt] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      retryAfter: retryAfter > 0 ? retryAfter : undefined,
      limit: params.maxRequests,
      resetAt,
    };
  }
}
```

**The problem with fixed windows: boundary bursts.** A client can send 100 requests at 12:00:59 (end of window 1) and another 100 requests at 12:01:00 (start of window 2). They have sent 200 requests in 2 seconds, but each window only counts 100. They never hit the limit.

```
        Window 1               Window 2
|========================|========================|
                   100 reqs  100 reqs
                   ^  12:00:59   ^ 12:01:00
                   |--- 200 requests in 2 seconds! ---|
```

Fixed window is easy to implement and uses minimal memory (one counter per key per window). It is good enough for internal APIs, admin dashboards, and any situation where approximate enforcement is acceptable.

> **What If You Skip This?** If you use a fixed-window algorithm on a public-facing API that serves price-sensitive data, scrapers will learn the boundary timing and exploit it. We have seen competitors schedule their scraping bots to fire at window boundaries, effectively doubling the data they extract per window.

### Algorithm 2: Sliding Window Log

The sliding window log eliminates the boundary burst problem entirely. Instead of hard window boundaries, it stores the **timestamp of every request** in a sorted set and counts all requests within the last N seconds from the current moment.

```
                          NOW (12:01:30)
                           |
  |========================|
  12:00:30           sliding window (60 seconds)
  Count ALL requests in this range — no boundary tricks
```

A request at 12:00:59 and a request at 12:01:00 are both within the same 60-second sliding window. The count is always accurate.

```typescript
// rate-limiting/algorithms/sliding-window-log.ts

import Redis from 'ioredis';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  windowSeconds: number;
}

export class SlidingWindowLogRateLimiter {
  private readonly redis: Redis;

  /**
   * Lua script that atomically:
   * 1. Removes expired entries from the sorted set
   * 2. Counts remaining entries
   * 3. If under limit, adds the new request
   * 4. Returns allowed/denied with metadata
   */
  private readonly luaScript = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local request_id = ARGV[4]
    local window_start = now - window

    -- Step 1: Remove all entries older than the window
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Step 2: Count how many requests are in the current window
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Step 3a: Under limit — add this request
      redis.call('ZADD', key, now, request_id)
      redis.call('EXPIRE', key, window + 1)
      return {1, limit - count - 1, 0}
    else
      -- Step 3b: Over limit — calculate when the oldest entry expires
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local retry_after = 0
      if oldest and #oldest >= 2 then
        retry_after = window - (now - tonumber(oldest[2]))
        if retry_after < 0 then retry_after = 0 end
      end
      return {0, 0, retry_after}
    end
  `;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkRateLimit(params: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<RateLimitResult> {
    const now = Date.now() / 1000;
    // Unique ID prevents collisions when multiple requests arrive
    // at the same millisecond
    const requestId = `${now}:${Math.random().toString(36).slice(2, 10)}`;

    const result = await this.redis.eval(
      this.luaScript,
      1,
      params.key,
      params.windowSeconds,
      params.maxRequests,
      now,
      requestId
    ) as [number, number, number];

    const [allowed, remaining, retryAfter] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      retryAfter: retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
      limit: params.maxRequests,
      windowSeconds: params.windowSeconds,
    };
  }
}
```

If you have used Redis only as a simple key-value cache before, this might be your first encounter with sorted sets and Lua scripts. Here is what each Redis command does:

- **`ZREMRANGEBYSCORE key -inf window_start`** — Remove all members from the sorted set whose score (timestamp) is before the start of our window. This cleans out expired entries.
- **`ZCARD key`** — Count how many members remain. This is our request count for the current window.
- **`ZADD key score member`** — Add a new member (the current request) with the current timestamp as its score.
- **`EXPIRE key window`** — Set a TTL on the entire key so Redis cleans it up automatically if the client stops sending requests.

Why a Lua script instead of multiple Redis commands from TypeScript? Because Lua scripts execute **atomically** inside Redis. Between the `ZREMRANGEBYSCORE` (removing old entries) and the `ZADD` (adding the new one), no other client can sneak in a request. Without atomicity, two requests arriving at the exact same millisecond could both pass the count check and both be admitted, exceeding the limit.

> **Analogy:** Imagine a bouncer at a club who keeps a list of everyone who entered in the last hour. When you walk up, the bouncer crosses off everyone who entered more than an hour ago, counts the remaining names, and lets you in only if the club is not at capacity. The bouncer's clipboard is the Redis sorted set. The one-hour window slides forward with every new arrival.

**The tradeoff:** The sliding window log stores one entry per request. If your limit is 10,000 requests per minute, the sorted set holds up to 10,000 members per key. For high-volume APIs, this memory usage adds up. The next algorithm addresses that.

---

### Algorithm 3: Token Bucket

The token bucket is the most widely used rate limiting algorithm in production systems. It provides a natural way to handle **burst traffic** while enforcing an average rate. Think of it this way: you have a bucket that holds a fixed number of tokens. Tokens are added at a constant rate. Each request consumes one token. If the bucket is empty, the request is denied. If the bucket is full, new tokens are discarded.

```
Bucket capacity: 10 tokens
Refill rate: 2 tokens/second

Time 0:     [##########]  10 tokens — bucket starts full
Time 0.5:   [########--]  burst: 2 requests consumed 2 tokens, 1 added
Time 1.0:   [######----]  2 more requests, 2 tokens added => 8 - 2 + 2 = 8?
                           No: tokens cap at bucket size

Let's trace it properly:

T=0.0s  Tokens: 10   Request? No     → Tokens: 10
T=0.1s  Tokens: 10   Request? Yes x5 → Tokens: 5  (burst of 5 allowed!)
T=0.6s  Tokens: 6    Request? Yes x3 → Tokens: 3  (1 token refilled + consumed 3)
T=1.1s  Tokens: 4    Request? Yes x4 → Tokens: 0  (1 token refilled + consumed 4)
T=1.2s  Tokens: 0.2  Request? Yes    → DENIED (not enough tokens)
T=2.0s  Tokens: 1.8  Request? Yes    → Tokens: 0.8 (allowed, had enough)
```

The key insight is that the bucket **accumulates tokens during idle periods**, allowing controlled bursts. A client that has been quiet for 5 seconds builds up tokens and can legitimately burst. A client that is hammering the API drains the bucket and gets throttled. This matches real-world usage patterns perfectly — humans browse in bursts, not at constant rates.

Here is the full Redis implementation:

```typescript
// rate-limiting/algorithms/token-bucket.ts

import Redis from 'ioredis';

interface TokenBucketResult {
  allowed: boolean;
  remaining: number;       // Tokens remaining after this request
  retryAfter?: number;     // Seconds until a token is available
  limit: number;           // Bucket capacity
  resetAt: number;         // When the bucket will be completely refilled
}

export class TokenBucketRateLimiter {
  private readonly redis: Redis;

  /**
   * Lua script that atomically:
   * 1. Reads the current token count and last refill timestamp
   * 2. Calculates how many tokens to add based on elapsed time
   * 3. Caps tokens at bucket capacity
   * 4. If tokens >= 1, consumes one token and allows the request
   * 5. If tokens < 1, denies and calculates retry delay
   *
   * KEYS[1] = rate limit key
   * ARGV[1] = bucket capacity (max tokens)
   * ARGV[2] = refill rate (tokens per second)
   * ARGV[3] = current timestamp (seconds, with decimals)
   * ARGV[4] = TTL for the key (seconds)
   */
  private readonly luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])

    -- Read current state
    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1])
    local last_refill = tonumber(bucket[2])

    -- Initialize on first request
    if tokens == nil then
      tokens = capacity
      last_refill = now
    end

    -- Calculate tokens to add based on elapsed time
    local elapsed = math.max(0, now - last_refill)
    local new_tokens = elapsed * refill_rate
    tokens = math.min(capacity, tokens + new_tokens)
    last_refill = now

    local allowed = 0
    local remaining = 0
    local retry_after = 0

    if tokens >= 1 then
      -- Consume one token
      tokens = tokens - 1
      allowed = 1
      remaining = math.floor(tokens)
    else
      -- Not enough tokens — calculate wait time
      retry_after = (1 - tokens) / refill_rate
      remaining = 0
    end

    -- Save state back to Redis
    redis.call('HMSET', key, 'tokens', tostring(tokens), 'last_refill', tostring(last_refill))
    redis.call('EXPIRE', key, ttl)

    -- Calculate when bucket will be full again
    local tokens_needed = capacity - tokens
    local reset_at = now + (tokens_needed / refill_rate)

    return {allowed, remaining, math.ceil(retry_after * 1000), math.ceil(reset_at)}
  `;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkRateLimit(params: {
    key: string;
    capacity: number;       // Maximum burst size
    refillRate: number;     // Tokens added per second
  }): Promise<TokenBucketResult> {
    const now = Date.now() / 1000;
    const ttl = Math.ceil(params.capacity / params.refillRate) + 60;

    const result = await this.redis.eval(
      this.luaScript,
      1,
      params.key,
      params.capacity,
      params.refillRate,
      now,
      ttl
    ) as [number, number, number, number];

    const [allowed, remaining, retryAfterMs, resetAt] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      retryAfter: retryAfterMs > 0 ? retryAfterMs / 1000 : undefined,
      limit: params.capacity,
      resetAt,
    };
  }
}
```

Notice the use of `HMSET` and `HMGET` — the token bucket stores two fields per key: the current token count and the last refill timestamp. This is far more memory-efficient than the sliding window log. Regardless of your rate limit (100 requests per minute or 100,000 requests per minute), each key uses exactly two fields.

> **Why Token Bucket for Booking APIs?** In a booking system, user behavior is inherently bursty. A travel agent might search for 10 destinations rapidly, pause to review results, then search 10 more. The token bucket naturally accommodates this: the bucket refills during the pause, and the next burst is allowed. A fixed window algorithm would penalize the agent during the first burst, even though their average rate is well within limits.

---

### Algorithm 4: Sliding Window Counter

The sliding window counter is a **hybrid** of the fixed window and the sliding window log. It gives you the accuracy of a sliding window with the memory efficiency of a fixed window. The idea is simple: keep counters for the current window and the previous window, then calculate a **weighted count** based on how far into the current window you are.

```
Previous Window (12:00 - 12:01)    Current Window (12:01 - 12:02)
        84 requests                     16 requests

Current time: 12:01:15 (25% into current window)

Weighted count = (previous × overlap%) + current
               = (84 × 75%) + 16
               = 63 + 16
               = 79

If limit is 100 → 79 < 100 → ALLOWED
```

The overlap percentage is the portion of the previous window that falls within our sliding window. If we are 25% into the current fixed window, then 75% of our sliding window overlaps with the previous fixed window.

```typescript
// rate-limiting/algorithms/sliding-window-counter.ts

import Redis from 'ioredis';

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  resetAt: number;
}

export class SlidingWindowCounterRateLimiter {
  private readonly redis: Redis;

  /**
   * Lua script:
   * 1. Determine current and previous window keys
   * 2. Get counts for both windows
   * 3. Calculate weighted count based on position in current window
   * 4. If under limit, increment current window counter
   */
  private readonly luaScript = `
    local key_prefix = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    -- Determine window boundaries
    local current_window = math.floor(now / window) * window
    local previous_window = current_window - window

    local current_key = key_prefix .. ':' .. current_window
    local previous_key = key_prefix .. ':' .. previous_window

    -- Get counts
    local current_count = tonumber(redis.call('GET', current_key) or '0') or 0
    local previous_count = tonumber(redis.call('GET', previous_key) or '0') or 0

    -- Calculate how far we are into the current window (0.0 to 1.0)
    local elapsed_in_window = (now - current_window) / window
    -- The previous window's weight is the portion that overlaps
    local previous_weight = 1.0 - elapsed_in_window

    -- Weighted count
    local weighted_count = math.floor(previous_count * previous_weight) + current_count

    if weighted_count >= limit then
      -- Calculate when enough previous-window requests will expire
      local retry_after = window - (now - current_window)
      return {0, 0, math.ceil(retry_after), current_window + window}
    end

    -- Allowed — increment current window
    redis.call('INCR', current_key)
    redis.call('EXPIRE', current_key, window * 2 + 1)

    local remaining = limit - weighted_count - 1
    return {1, remaining, 0, current_window + window}
  `;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkRateLimit(params: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);

    const result = await this.redis.eval(
      this.luaScript,
      1,
      params.key,
      params.maxRequests,
      params.windowSeconds,
      now
    ) as [number, number, number, number];

    const [allowed, remaining, retryAfter, resetAt] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      retryAfter: retryAfter > 0 ? retryAfter : undefined,
      limit: params.maxRequests,
      resetAt,
    };
  }
}
```

The sliding window counter uses only **two counters per key** (current window + previous window), making it as memory-efficient as the fixed window. Yet it provides much better accuracy at window boundaries because it weights the previous window's count by its overlap. Cloudflare uses a variant of this algorithm for their rate limiting product.

> **When Students Ask:** "Why not always use the sliding window log since it is the most accurate?" Memory. At 10,000 requests per minute across 100,000 unique API keys, the sliding window log stores 1 billion entries in Redis. The sliding window counter stores 200,000 counters. That is a 5,000x reduction in memory. Accuracy matters, but so does your Redis bill.

---

### Algorithm 5: Leaky Bucket

The leaky bucket smooths out burst traffic completely. Imagine a bucket with a small hole at the bottom. Requests pour in from the top and drip out from the bottom at a constant rate. If the bucket overflows, new requests are rejected.

```
Requests pour in (variable rate)
        ↓↓↓↓↓
   ┌──────────────┐
   │  ◉ ◉ ◉ ◉ ◉  │  ← Queue (bucket)
   │  ◉ ◉ ◉       │     Capacity: 10
   │  ◉ ◉          │
   └──────┬───────┘
          ↓
   Processed at fixed rate (1 req/sec)
```

The leaky bucket is essentially a **FIFO queue** with a fixed processing rate. Unlike the token bucket, which allows bursts up to the bucket capacity, the leaky bucket enforces a strict constant output rate. This is ideal when your downstream service has a hard processing limit.

```typescript
// rate-limiting/algorithms/leaky-bucket.ts

import Redis from 'ioredis';

interface LeakyBucketResult {
  allowed: boolean;
  queuePosition?: number;  // Position in the queue (if queued)
  retryAfter?: number;
  limit: number;
}

export class LeakyBucketRateLimiter {
  private readonly redis: Redis;

  /**
   * Simplified leaky bucket using a counter approach:
   * - Track the "water level" (number of pending requests)
   * - Leak at a constant rate
   * - Reject if the bucket would overflow
   */
  private readonly luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local leak_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])

    local bucket = redis.call('HMGET', key, 'water', 'last_leak')
    local water = tonumber(bucket[1]) or 0
    local last_leak = tonumber(bucket[2]) or now

    -- Leak water based on elapsed time
    local elapsed = math.max(0, now - last_leak)
    local leaked = elapsed * leak_rate
    water = math.max(0, water - leaked)

    if water < capacity then
      -- Room in the bucket
      water = water + 1
      redis.call('HMSET', key, 'water', tostring(water), 'last_leak', tostring(now))
      redis.call('EXPIRE', key, math.ceil(capacity / leak_rate) + 60)
      return {1, math.floor(water), 0}
    else
      -- Bucket is full
      local retry_after = (water - capacity + 1) / leak_rate
      redis.call('HSET', key, 'last_leak', tostring(now))
      return {0, math.floor(water), math.ceil(retry_after * 1000)}
    end
  `;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkRateLimit(params: {
    key: string;
    capacity: number;
    leakRate: number;  // Requests processed per second
  }): Promise<LeakyBucketResult> {
    const now = Date.now() / 1000;

    const result = await this.redis.eval(
      this.luaScript,
      1,
      params.key,
      params.capacity,
      params.leakRate,
      now
    ) as [number, number, number];

    const [allowed, queuePosition, retryAfterMs] = result;

    return {
      allowed: allowed === 1,
      queuePosition: allowed === 1 ? queuePosition : undefined,
      retryAfter: retryAfterMs > 0 ? retryAfterMs / 1000 : undefined,
      limit: params.capacity,
    };
  }
}
```

> **Token Bucket vs Leaky Bucket — The Critical Difference:** Token bucket says "you can send up to N requests right now if you have saved up tokens." Leaky bucket says "requests will be processed at exactly this rate, no exceptions." Use the token bucket when you want to allow bursts. Use the leaky bucket when you need smooth, predictable throughput — for example, when forwarding requests to a payment gateway that will reject you if you exceed their rate.

---

## Algorithm Comparison

Before choosing an algorithm, study this comparison table:

| Criteria | Fixed Window | Sliding Window Log | Sliding Window Counter | Token Bucket | Leaky Bucket |
|---|---|---|---|---|---|
| **Accuracy** | Low (boundary bursts) | Exact | High (approximate) | High | Exact (smooth output) |
| **Memory per key** | 1 counter | 1 entry per request | 2 counters | 2 fields | 2 fields |
| **Memory at 10K RPM** | 8 bytes | ~400 KB | 16 bytes | 16 bytes | 16 bytes |
| **Burst handling** | Allows 2x at boundary | No bursts beyond limit | Minimal boundary error | Controlled bursts | No bursts (smoothed) |
| **Implementation** | Simple | Moderate | Moderate | Moderate | Moderate |
| **Best for** | Internal APIs, admin | Low-volume, high-accuracy | General purpose | Public APIs | Payment gateways |
| **Used by** | Basic apps | — | Cloudflare | AWS, Google Cloud | Nginx, Shopify |
| **Redis commands** | INCR, EXPIRE | ZADD, ZREMRANGEBYSCORE, ZCARD | GET, INCR, EXPIRE | HMGET, HMSET | HMGET, HMSET |

> **Mentor's Recommendation:** For our booking system, use the **token bucket** for public-facing search and booking APIs (allows natural usage bursts), the **sliding window counter** for partner API integrations (good accuracy, low memory), and the **leaky bucket** for outbound calls to payment processors (smooth, predictable throughput).

---

## Per-User, Per-IP, and Per-API-Key Rate Limiting

A single rate limiting key is not enough. Different dimensions of identification serve different purposes:

- **Per-IP** catches unauthenticated abuse — scrapers, bots, brute-force login attempts. It is your first layer of defense because you always have an IP address, even before authentication.
- **Per-User** prevents authenticated users from exceeding their plan limits. A user who logs in from multiple devices should share a single rate limit pool.
- **Per-API-Key** rate limits partner integrations. Each partner gets an API key with contractual rate limits tied to their subscription tier.

Here is a rate limiter that combines all three dimensions:

```typescript
// rate-limiting/multi-dimension-limiter.ts

import { TokenBucketRateLimiter } from './algorithms/token-bucket';
import Redis from 'ioredis';

interface RateLimitDimension {
  key: string;
  capacity: number;
  refillRate: number;
  label: string;  // For error messages: "IP", "user", "API key"
}

interface MultiDimensionResult {
  allowed: boolean;
  deniedBy?: string;           // Which dimension blocked it
  retryAfter?: number;
  headers: Record<string, string>;
}

export class MultiDimensionRateLimiter {
  private readonly limiter: TokenBucketRateLimiter;

  constructor(redis: Redis) {
    this.limiter = new TokenBucketRateLimiter(redis);
  }

  /**
   * Check rate limits across multiple dimensions.
   * ALL dimensions must pass for the request to be allowed.
   * Returns the most restrictive result.
   */
  async check(dimensions: RateLimitDimension[]): Promise<MultiDimensionResult> {
    // Check all dimensions in parallel
    const results = await Promise.all(
      dimensions.map(async (dim) => ({
        dim,
        result: await this.limiter.checkRateLimit({
          key: dim.key,
          capacity: dim.capacity,
          refillRate: dim.refillRate,
        }),
      }))
    );

    // Find the most restrictive result
    const denied = results.find((r) => !r.result.allowed);
    if (denied) {
      return {
        allowed: false,
        deniedBy: denied.dim.label,
        retryAfter: denied.result.retryAfter,
        headers: this.buildHeaders(denied.result, denied.dim),
      };
    }

    // All passed — return the dimension with the lowest remaining count
    const mostRestrictive = results.reduce((min, r) =>
      r.result.remaining < min.result.remaining ? r : min
    );

    return {
      allowed: true,
      headers: this.buildHeaders(mostRestrictive.result, mostRestrictive.dim),
    };
  }

  private buildHeaders(
    result: { limit: number; remaining: number; resetAt: number; retryAfter?: number },
    dim: RateLimitDimension
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'X-RateLimit-Limit': result.limit.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': result.resetAt.toString(),
      'X-RateLimit-Policy': `${dim.capacity};w=${Math.ceil(dim.capacity / dim.refillRate)}`,
    };

    if (result.retryAfter) {
      headers['Retry-After'] = Math.ceil(result.retryAfter).toString();
    }

    return headers;
  }
}
```

Usage in a request handler:

```typescript
// Example: applying multi-dimension rate limiting in middleware

async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const dimensions: RateLimitDimension[] = [];

  // Layer 1: Always rate limit by IP
  dimensions.push({
    key: `rl:ip:${req.ip}`,
    capacity: 200,        // 200 requests burst
    refillRate: 10,        // 10 requests/second sustained
    label: 'IP address',
  });

  // Layer 2: If authenticated, rate limit by user ID
  if (req.user?.id) {
    dimensions.push({
      key: `rl:user:${req.user.id}`,
      capacity: 100,
      refillRate: 5,
      label: 'user account',
    });
  }

  // Layer 3: If using an API key, rate limit by key
  if (req.headers['x-api-key']) {
    const apiKey = req.headers['x-api-key'] as string;
    dimensions.push({
      key: `rl:apikey:${apiKey}`,
      capacity: 1000,
      refillRate: 50,
      label: 'API key',
    });
  }

  const limiter = new MultiDimensionRateLimiter(redis);
  const result = await limiter.check(dimensions);

  // Always set rate limit headers — even on allowed requests
  Object.entries(result.headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (!result.allowed) {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded for ${result.deniedBy}. Please retry after ${result.retryAfter} seconds.`,
      retryAfter: result.retryAfter,
    });
  }

  next();
}
```

> **Why Check All Dimensions in Parallel?** Each dimension check is a Redis call. If you check them sequentially, you add latency equal to the sum of all round trips. Checking in parallel means latency equals only the slowest round trip. With three dimensions, this typically saves 2-4 milliseconds per request — which matters at thousands of requests per second.

---

## Rate Limit Headers

Every response from your API should include rate limit headers, even when the request is allowed. This lets well-behaved clients self-throttle before they hit the limit. Here are the standard headers:

| Header | Description | Example |
|---|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the window | `100` |
| `X-RateLimit-Remaining` | Requests remaining in the current window | `67` |
| `X-RateLimit-Reset` | Unix timestamp when the window resets | `1708012800` |
| `Retry-After` | Seconds to wait before retrying (only on 429) | `30` |
| `X-RateLimit-Policy` | Human-readable policy description | `100;w=60` (100 per 60s) |

The `Retry-After` header is the most important one. Without it, clients have to guess when they can retry. Most will retry immediately — which is the worst possible behavior because it creates a thundering herd when the window resets. With `Retry-After`, well-behaved clients add jitter to their retry and spread the load.

```typescript
// rate-limiting/headers.ts

/**
 * Standard rate limit response for HTTP 429
 */
export function buildRateLimitResponse(result: {
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}) {
  const headers = {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': Math.max(0, result.remaining).toString(),
    'X-RateLimit-Reset': result.resetAt.toString(),
  };

  const body: Record<string, unknown> = {
    statusCode: 429,
    error: 'Too Many Requests',
    message: 'You have exceeded the rate limit. Please slow down.',
  };

  if (result.retryAfter !== undefined) {
    headers['Retry-After'] = Math.ceil(result.retryAfter).toString();
    body.retryAfter = Math.ceil(result.retryAfter);
    body.message = `Rate limit exceeded. Please retry after ${Math.ceil(result.retryAfter)} seconds.`;
  }

  return { headers, body, statusCode: 429 };
}
```

> **What If You Skip This?** If you return 429 without a `Retry-After` header, client SDKs and integrations will implement their own retry logic. Some will retry every 100ms. Some will retry every second. Some will retry at exactly the same time as each other. You will see a sawtooth traffic pattern where requests spike, get rate limited, back off briefly, then spike again. The `Retry-After` header with jitter guidance breaks this cycle.

---

## NestJS Rate Limiting with @nestjs/throttler

NestJS provides the `@nestjs/throttler` package for built-in rate limiting. For simple use cases, it works out of the box. For our booking system, we need to extend it with Redis-backed storage and custom guards.

### Basic Setup

```typescript
// app.module.ts

import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'short',
          ttl: 1000,      // 1 second window
          limit: 10,       // 10 requests per second
        },
        {
          name: 'medium',
          ttl: 60000,      // 1 minute window
          limit: 100,      // 100 requests per minute
        },
        {
          name: 'long',
          ttl: 3600000,    // 1 hour window
          limit: 1000,     // 1000 requests per hour
        },
      ],
      // Use Redis for distributed rate limiting
      storage: new ThrottlerStorageRedisService({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      }),
    }),
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
```

### Custom Guard with Per-User Logic

The default `ThrottlerGuard` uses IP addresses. In our booking system, we need smarter key generation:

```typescript
// guards/booking-throttler.guard.ts

import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Request } from 'express';

@Injectable()
export class BookingThrottlerGuard extends ThrottlerGuard {
  /**
   * Generate a unique tracking key for rate limiting.
   * Priority: API key > authenticated user > IP address
   */
  protected async getTracker(req: Request): Promise<string> {
    // Partner API key gets its own pool
    const apiKey = req.headers['x-api-key'] as string;
    if (apiKey) {
      return `api:${apiKey}`;
    }

    // Authenticated user — same limit regardless of device
    const user = (req as any).user;
    if (user?.id) {
      return `user:${user.id}`;
    }

    // Fall back to IP address for unauthenticated requests
    // Handle proxied requests by checking X-Forwarded-For
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded
      ? (Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]).trim()
      : req.ip;

    return `ip:${ip}`;
  }

  /**
   * Custom error response with standard rate limit headers
   */
  protected throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: any,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse();
    response.header('Retry-After', Math.ceil(throttlerLimitDetail.timeToExpire / 1000));
    response.header('X-RateLimit-Limit', throttlerLimitDetail.limit);
    response.header('X-RateLimit-Remaining', '0');

    throw new ThrottlerException(
      `Rate limit exceeded. Try again in ${Math.ceil(throttlerLimitDetail.timeToExpire / 1000)} seconds.`
    );
  }
}
```

### Endpoint-Specific Rate Limits

Some endpoints need different limits. The search endpoint can handle high traffic, but the booking creation endpoint should be tighter:

```typescript
// controllers/booking.controller.ts

import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { BookingThrottlerGuard } from '../guards/booking-throttler.guard';

@Controller('bookings')
@UseGuards(BookingThrottlerGuard)
export class BookingController {
  // Uses default limits from ThrottlerModule config
  @Get('search')
  async search(@Body() searchDto: SearchDto) {
    return this.bookingService.search(searchDto);
  }

  // Tighter limits for booking creation — prevents inventory lock abuse
  @Post()
  @Throttle({
    short: { ttl: 1000, limit: 2 },     // 2 per second
    medium: { ttl: 60000, limit: 10 },   // 10 per minute
    long: { ttl: 3600000, limit: 50 },   // 50 per hour
  })
  async createBooking(@Body() bookingDto: CreateBookingDto) {
    return this.bookingService.create(bookingDto);
  }

  // Health check — exempt from rate limiting entirely
  @Get('health')
  @SkipThrottle()
  async healthCheck() {
    return { status: 'ok' };
  }

  // Admin endpoints — separate rate limit for admin users
  @Get('admin/reports')
  @Throttle({ short: { ttl: 1000, limit: 50 }, medium: { ttl: 60000, limit: 500 } })
  async getReports() {
    return this.bookingService.generateReports();
  }
}
```

> **When Students Ask:** "Should I apply rate limits to health check endpoints?" No. Health checks are called by your load balancer, Kubernetes liveness probes, and monitoring systems. Rate limiting them would cause your infrastructure to think your service is down. Always use `@SkipThrottle()` on health endpoints.

---

## API Gateway Rate Limiting

For production deployments, you should implement rate limiting at the API gateway level — before requests even reach your NestJS application. This protects your application servers from even having to process rejected requests.

### Kong Gateway Configuration

```yaml
# kong/rate-limiting.yml

# Global rate limiting plugin — applies to all routes
plugins:
  - name: rate-limiting
    config:
      second: 50            # 50 requests per second per consumer
      minute: 1000           # 1000 requests per minute per consumer
      hour: 10000            # 10000 requests per hour per consumer
      policy: redis          # Use Redis for distributed counting
      redis_host: redis-master.default.svc.cluster.local
      redis_port: 6379
      redis_database: 1      # Separate DB from application cache
      redis_timeout: 50      # 50ms timeout — fail open if Redis is slow
      limit_by: consumer     # Rate limit by authenticated consumer
      fault_tolerant: true   # If Redis is unreachable, allow requests
      hide_client_headers: false  # Send X-RateLimit headers to clients

# Route-specific overrides for the search endpoint
routes:
  - name: hotel-search
    paths:
      - /api/v1/search
    plugins:
      - name: rate-limiting
        config:
          second: 20
          minute: 500
          policy: redis
          redis_host: redis-master.default.svc.cluster.local
          limit_by: ip        # Rate limit by IP for search (may be unauthenticated)

  # Tight limits on booking creation
  - name: booking-create
    paths:
      - /api/v1/bookings
    methods:
      - POST
    plugins:
      - name: rate-limiting
        config:
          second: 5
          minute: 30
          hour: 200
          policy: redis
          redis_host: redis-master.default.svc.cluster.local
          limit_by: consumer
```

### Nginx Rate Limiting Configuration

If you use Nginx as your reverse proxy instead of Kong:

```nginx
# nginx/rate-limiting.conf

# Define rate limit zones in the http block
http {
    # Zone: per-IP general rate limiting
    # 10m = 10 megabytes of shared memory (~160,000 unique IPs)
    # rate=10r/s = 10 requests per second per IP
    limit_req_zone $binary_remote_addr zone=per_ip:10m rate=10r/s;

    # Zone: per-API-key rate limiting
    # $http_x_api_key extracts the X-API-Key header
    limit_req_zone $http_x_api_key zone=per_api_key:10m rate=50r/s;

    # Zone: stricter limit for booking creation
    limit_req_zone $binary_remote_addr zone=booking_create:5m rate=2r/s;

    # Custom 429 error page with JSON response
    error_page 429 = @rate_limited;

    server {
        listen 80;

        # Default: apply per-IP rate limiting to all locations
        # burst=20 allows 20 excess requests to be queued
        # nodelay processes queued requests immediately
        limit_req zone=per_ip burst=20 nodelay;

        # Standard rate limit headers
        add_header X-RateLimit-Limit 10 always;

        location /api/v1/search {
            limit_req zone=per_ip burst=30 nodelay;
            limit_req zone=per_api_key burst=100 nodelay;
            proxy_pass http://booking-service:3000;
        }

        location /api/v1/bookings {
            # POST requests get stricter limits
            limit_req zone=booking_create burst=5 nodelay;
            limit_req zone=per_api_key burst=50 nodelay;
            proxy_pass http://booking-service:3000;
        }

        location @rate_limited {
            default_type application/json;
            return 429 '{"error":"Too Many Requests","message":"Rate limit exceeded. Please retry later.","retryAfter":1}';
        }
    }
}
```

> **Gateway vs Application Rate Limiting — Do Both.** Gateway rate limiting (Kong/Nginx) rejects abusive traffic before it reaches your application, protecting your NestJS processes from wasting CPU cycles on requests that will be denied. Application rate limiting (NestJS throttler) handles business-logic-specific limits, like "users on the free plan can only create 5 bookings per day." These are complementary layers, not alternatives.

---

## Tiered Rate Limits: Free vs Premium vs Enterprise

In a real booking platform, not every client gets the same limits. Your pricing tiers should map directly to rate limit configurations. Free users get enough to evaluate the product. Premium users get production-grade limits. Enterprise clients get custom limits negotiated in their contract.

Here is how we model tiered rate limits. First, the raw SQL schema:

```sql
-- Rate limit configuration table
-- Each row defines a rate limit policy for a specific tier + endpoint combination

CREATE TABLE rate_limit_config (
    id              CHAR(36) PRIMARY KEY -- UUID generated by application,
    tier            VARCHAR(20) NOT NULL CHECK (tier IN ('free', 'premium', 'enterprise')),
    endpoint_pattern VARCHAR(255) NOT NULL,         -- e.g., '/api/v1/search', '/api/v1/bookings'
    http_method      VARCHAR(10) DEFAULT '*',        -- '*' = all methods, 'POST', 'GET', etc.
    algorithm        VARCHAR(30) NOT NULL DEFAULT 'token_bucket',
    max_requests     INTEGER NOT NULL,               -- Bucket capacity or window limit
    window_seconds   INTEGER NOT NULL,               -- Window duration
    burst_capacity   INTEGER,                        -- For token bucket: max burst
    refill_rate      REAL,                           -- For token bucket: tokens per second
    description      TEXT,
    is_active        BOOLEAN NOT NULL DEFAULT true,
    created_at       DATETIME(6) NOT NULL DEFAULT NOW(6),
    updated_at       DATETIME(6) NOT NULL DEFAULT NOW(6),

    UNIQUE (tier, endpoint_pattern, http_method)
);

-- Rate limit events table
-- Records every rate limit violation for analytics and abuse detection

CREATE TABLE rate_limit_events (
    id              CHAR(36) PRIMARY KEY -- UUID generated by application,
    client_identifier VARCHAR(255) NOT NULL,         -- IP, user ID, or API key
    identifier_type   VARCHAR(20) NOT NULL CHECK (identifier_type IN ('ip', 'user', 'api_key')),
    endpoint         VARCHAR(255) NOT NULL,
    http_method      VARCHAR(10) NOT NULL,
    tier             VARCHAR(20) NOT NULL,
    violated_limit   INTEGER NOT NULL,               -- What was the limit
    actual_count     INTEGER NOT NULL,               -- How many requests were made
    action_taken     VARCHAR(20) NOT NULL DEFAULT 'rejected',  -- 'rejected', 'throttled', 'warned'
    client_ip        INET NOT NULL,
    user_agent       TEXT,
    created_at       DATETIME(6) NOT NULL DEFAULT NOW(6)
);

-- Index for querying violations by client
CREATE INDEX idx_rate_limit_events_client
    ON rate_limit_events (client_identifier, created_at DESC);

-- Index for abuse detection: find IPs with the most violations
CREATE INDEX idx_rate_limit_events_ip_time
    ON rate_limit_events (client_ip, created_at DESC);

-- Index for dashboard: violations per tier
CREATE INDEX idx_rate_limit_events_tier
    ON rate_limit_events (tier, created_at DESC);

-- Seed data for the three tiers
INSERT INTO rate_limit_config (tier, endpoint_pattern, http_method, max_requests, window_seconds, burst_capacity, refill_rate, description)
VALUES
    -- Free tier
    ('free', '/api/v1/search',    'GET',  60,   60,   15,  1.0,   'Free: 60 searches/min, burst 15'),
    ('free', '/api/v1/bookings',  'POST', 5,    3600, 2,   0.0014, 'Free: 5 bookings/hour, burst 2'),
    ('free', '/api/v1/bookings',  'GET',  120,  60,   30,  2.0,   'Free: 120 booking reads/min'),
    ('free', '/api/v1/*',         '*',    300,  60,   50,  5.0,   'Free: 300 total requests/min'),

    -- Premium tier
    ('premium', '/api/v1/search',    'GET',  600,  60,   100, 10.0, 'Premium: 600 searches/min'),
    ('premium', '/api/v1/bookings',  'POST', 50,   3600, 10,  0.014, 'Premium: 50 bookings/hour'),
    ('premium', '/api/v1/bookings',  'GET',  1200, 60,   200, 20.0, 'Premium: 1200 booking reads/min'),
    ('premium', '/api/v1/*',         '*',    3000, 60,   500, 50.0, 'Premium: 3000 total requests/min'),

    -- Enterprise tier
    ('enterprise', '/api/v1/search',    'GET',  6000,  60,   1000, 100.0, 'Enterprise: 6000 searches/min'),
    ('enterprise', '/api/v1/bookings',  'POST', 500,   3600, 100,  0.14,  'Enterprise: 500 bookings/hour'),
    ('enterprise', '/api/v1/bookings',  'GET',  12000, 60,   2000, 200.0, 'Enterprise: 12000 booking reads/min'),
    ('enterprise', '/api/v1/*',         '*',    30000, 60,   5000, 500.0, 'Enterprise: 30000 total requests/min');
```

Now the equivalent Prisma schema:

```prisma
// prisma/schema.prisma (rate limiting models)

enum RateLimitTier {
  free
  premium
  enterprise
}

enum IdentifierType {
  ip
  user
  api_key
}

enum RateLimitAction {
  rejected
  throttled
  warned
}

model RateLimitConfig {
  id              String        @id @default(uuid()) @db.Uuid
  tier            RateLimitTier
  endpointPattern String        @map("endpoint_pattern") @db.VarChar(255)
  httpMethod      String        @default("*") @map("http_method") @db.VarChar(10)
  algorithm       String        @default("token_bucket") @db.VarChar(30)
  maxRequests     Int           @map("max_requests")
  windowSeconds   Int           @map("window_seconds")
  burstCapacity   Int?          @map("burst_capacity")
  refillRate      Float?        @map("refill_rate")
  description     String?       @db.Text
  isActive        Boolean       @default(true) @map("is_active")
  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt       DateTime      @updatedAt @map("updated_at") @db.Timestamptz()

  @@unique([tier, endpointPattern, httpMethod])
  @@map("rate_limit_config")
}

model RateLimitEvent {
  id               String          @id @default(uuid()) @db.Uuid
  clientIdentifier String          @map("client_identifier") @db.VarChar(255)
  identifierType   IdentifierType  @map("identifier_type")
  endpoint         String          @db.VarChar(255)
  httpMethod       String          @map("http_method") @db.VarChar(10)
  tier             RateLimitTier
  violatedLimit    Int             @map("violated_limit")
  actualCount      Int             @map("actual_count")
  actionTaken      RateLimitAction @default(rejected) @map("action_taken")
  clientIp         String          @map("client_ip") @db.Inet
  userAgent        String?         @map("user_agent") @db.Text
  createdAt        DateTime        @default(now()) @map("created_at") @db.Timestamptz()

  @@index([clientIdentifier, createdAt(sort: Desc)], map: "idx_rate_limit_events_client")
  @@index([clientIp, createdAt(sort: Desc)], map: "idx_rate_limit_events_ip_time")
  @@index([tier, createdAt(sort: Desc)], map: "idx_rate_limit_events_tier")
  @@map("rate_limit_events")
}
```

And the Prisma Client code to load tier configs and record violations:

```typescript
// rate-limiting/tier-config.service.ts

import { PrismaClient, RateLimitTier } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Load all active rate limit configs for a given tier.
 * Results are cached in Redis for 5 minutes to avoid
 * hitting the database on every request.
 */
export async function getTierConfig(tier: RateLimitTier) {
  const configs = await prisma.rateLimitConfig.findMany({
    where: {
      tier,
      isActive: true,
    },
    orderBy: {
      endpointPattern: 'asc',
    },
  });

  return configs;
}

/**
 * Find the most specific rate limit config for a given
 * tier + endpoint + method combination.
 */
export async function findMatchingConfig(
  tier: RateLimitTier,
  endpoint: string,
  method: string,
) {
  // First try exact match on endpoint + method
  let config = await prisma.rateLimitConfig.findFirst({
    where: {
      tier,
      endpointPattern: endpoint,
      httpMethod: method,
      isActive: true,
    },
  });

  // Fall back to wildcard method
  if (!config) {
    config = await prisma.rateLimitConfig.findFirst({
      where: {
        tier,
        endpointPattern: endpoint,
        httpMethod: '*',
        isActive: true,
      },
    });
  }

  // Fall back to wildcard endpoint
  if (!config) {
    config = await prisma.rateLimitConfig.findFirst({
      where: {
        tier,
        endpointPattern: { endsWith: '/*' },
        httpMethod: '*',
        isActive: true,
      },
    });
  }

  return config;
}

/**
 * Record a rate limit violation for analytics and abuse detection.
 */
export async function recordViolation(params: {
  clientIdentifier: string;
  identifierType: 'ip' | 'user' | 'api_key';
  endpoint: string;
  httpMethod: string;
  tier: RateLimitTier;
  violatedLimit: number;
  actualCount: number;
  clientIp: string;
  userAgent?: string;
}) {
  await prisma.rateLimitEvent.create({
    data: {
      clientIdentifier: params.clientIdentifier,
      identifierType: params.identifierType,
      endpoint: params.endpoint,
      httpMethod: params.httpMethod,
      tier: params.tier,
      violatedLimit: params.violatedLimit,
      actualCount: params.actualCount,
      actionTaken: 'rejected',
      clientIp: params.clientIp,
      userAgent: params.userAgent,
    },
  });
}

/**
 * Detect potential abuse: clients with more than N violations
 * in the last hour. Used by the abuse detection background job.
 */
export async function findFrequentViolators(
  thresholdCount: number,
  windowHours: number = 1,
) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const violators = await prisma.rateLimitEvent.groupBy({
    by: ['clientIdentifier', 'identifierType', 'clientIp'],
    where: {
      createdAt: { gte: since },
    },
    _count: {
      id: true,
    },
    having: {
      id: {
        _count: {
          gte: thresholdCount,
        },
      },
    },
    orderBy: {
      _count: {
        id: 'desc',
      },
    },
  });

  return violators;
}
```

> **Analogy:** Tiered rate limits are like highway toll passes. The basic pass lets you through 5 toll booths per day. The premium pass gives you 50. The enterprise pass gives you unlimited. If you try to use more than your pass allows, the gate stays down. The toll authority does not hate you — they just need you to upgrade your pass.

---

## Graceful Degradation Under Rate Limiting

Returning a hard 429 for every excess request is a blunt instrument. In a booking system, some traffic is more important than other traffic. A user about to confirm a $2,000 hotel booking should not be rejected because they browsed one too many search results. Graceful degradation means **prioritizing critical requests** even when the system is under pressure.

```typescript
// rate-limiting/graceful-degradation.ts

interface DegradationStrategy {
  priority: number;          // 1 = highest (must not block), 5 = lowest (shed first)
  degradeResponse?: boolean; // Return a simplified response instead of rejecting
  allowOverage: number;      // Allow N% over the limit before hard rejection
}

const ENDPOINT_PRIORITIES: Record<string, DegradationStrategy> = {
  // Priority 1: Payment and booking confirmation — NEVER rate limit
  'POST /api/v1/bookings/confirm':   { priority: 1, allowOverage: 100 },
  'POST /api/v1/payments/complete':  { priority: 1, allowOverage: 100 },

  // Priority 2: Active booking management—allow some overage
  'POST /api/v1/bookings':           { priority: 2, allowOverage: 25 },
  'PUT /api/v1/bookings/:id':        { priority: 2, allowOverage: 25 },
  'DELETE /api/v1/bookings/:id':     { priority: 2, allowOverage: 25 },

  // Priority 3: User-facing reads — degrade before rejecting
  'GET /api/v1/bookings':            { priority: 3, degradeResponse: true, allowOverage: 10 },
  'GET /api/v1/bookings/:id':        { priority: 3, degradeResponse: true, allowOverage: 10 },

  // Priority 4: Search — can serve from cache when degrading
  'GET /api/v1/search':              { priority: 4, degradeResponse: true, allowOverage: 0 },

  // Priority 5: Analytics, reports — shed first
  'GET /api/v1/reports':             { priority: 5, degradeResponse: false, allowOverage: 0 },
  'GET /api/v1/analytics':           { priority: 5, degradeResponse: false, allowOverage: 0 },
};

export function shouldAllowDespiteRateLimit(
  endpoint: string,
  currentCount: number,
  limit: number,
): { allowed: boolean; degrade: boolean } {
  const strategy = ENDPOINT_PRIORITIES[endpoint];

  if (!strategy) {
    // Unknown endpoint — enforce strictly
    return { allowed: false, degrade: false };
  }

  // Calculate how far over the limit we are
  const overagePercent = ((currentCount - limit) / limit) * 100;

  if (overagePercent <= strategy.allowOverage) {
    return {
      allowed: true,
      degrade: strategy.degradeResponse || false,
    };
  }

  return { allowed: false, degrade: false };
}

/**
 * Degrade a search response: return cached results instead of
 * querying the database. Less fresh, but available.
 */
export async function degradedSearchResponse(
  searchParams: any,
  cacheService: any,
): Promise<any> {
  const cacheKey = `degraded:search:${JSON.stringify(searchParams)}`;
  const cached = await cacheService.get(cacheKey);

  if (cached) {
    return {
      ...cached,
      _degraded: true,
      _notice: 'Results may not reflect the latest availability. Please retry in a few seconds.',
    };
  }

  // No cache available — must reject
  return null;
}
```

> **What If You Skip This?** Without graceful degradation, a travel agent who searched for too many destinations gets their booking confirmation blocked. They are holding a $3,000 reservation that will expire in 2 minutes. They click "Confirm" and see "Too Many Requests." They lose the booking. They lose trust in your platform. They call your support team. This is a real scenario that happened to a major online travel agency in 2019. The fix took 30 minutes to implement and prevented an estimated $240,000 in lost bookings per month.

---

## Production War Story: The Valentine's Day DDoS

**The Setup:** February 14th, 2023. A luxury hotel booking platform serving 3,000 requests per second on a normal day. They had basic rate limiting — `express-rate-limit` with the default in-memory store, set to 100 requests per minute per IP.

**The Attack:** At 2:17 PM EST, traffic spiked from 3,000 to 180,000 requests per second. A botnet of 25,000 IP addresses, each sending about 7 requests per second. Every single IP was under the 100/minute limit. The rate limiter saw 25,000 well-behaved clients. It allowed all of them through.

**The Cascade:**
1. **2:17 PM** — Traffic spike begins. Application servers start consuming more CPU. Response times increase from 45ms to 200ms.
2. **2:19 PM** — Kubernetes auto-scaler kicks in, scaling from 12 pods to 40 pods. Cloud costs are now 3.3x normal.
3. **2:22 PM** — Database connection pools are exhausted across all pods. The primary PostgreSQL database hits max_connections (500). New requests start queuing.
4. **2:25 PM** — Average response time hits 8 seconds. Legitimate users start abandoning their Valentine's Day dinner reservations. The booking completion rate drops from 34% to 3%.
5. **2:28 PM** — The payment processor's webhook delivery starts timing out. Confirmed bookings are not being recorded. The system is now losing data.
6. **2:31 PM** — Auto-scaler reaches 80 pods. Monthly cloud budget consumed in 14 minutes.
7. **2:35 PM** — On-call engineer manually adds an IP block list. But the botnet uses rotating IPs, so new ones appear faster than they can be blocked.

**The Fix (implemented over the next 72 hours):**

1. **Moved rate limiting to Redis** with the token bucket algorithm. All application instances now share rate limit state.
2. **Added aggregate rate limiting** — not just per-IP, but also total requests per second across all clients. When total traffic exceeds 10,000 RPS (3x normal peak), all non-authenticated traffic gets a 50% reduced limit.
3. **Implemented the tiered degradation** system described above. Search requests get cached results. Booking confirmations and payments are never rate limited.
4. **Added behavioral fingerprinting** — the bot requests had no cookies, identical User-Agent strings, and hit endpoints in alphabetical order. A simple heuristic caught 94% of them.
5. **Deployed Kong gateway** with Redis-backed rate limiting as the first line of defense, before traffic reached the application.

**The Result:** Two weeks later, a similar attack hit. The new system:
- Kong rejected 92% of bot traffic before it reached the application.
- Application-level rate limiting caught the remaining 8% that got through with legitimate-looking patterns.
- Total traffic to the booking service stayed under 4,500 RPS during the attack.
- Response times remained under 60ms for legitimate users.
- Cloud costs did not spike — auto-scaler stayed at 15 pods.
- Zero lost bookings. Zero payment webhook timeouts.

> **The Lesson:** Per-IP rate limiting is necessary but not sufficient. Distributed attacks come from thousands of IPs, each individually below your limit. You need multi-layered defense: gateway-level rate limiting, aggregate system-wide limits, per-client limits, behavioral detection, and graceful degradation. No single algorithm or single layer protects you. Defense in depth is not optional.

---

## Common Mistakes

### Mistake 1: Rate Limiting Only by IP Address

**The Problem:** The team adds `express-rate-limit` with IP-based limiting. Behind a corporate NAT, 500 employees at a travel agency share one public IP address. The first 10 employees to use the API consume the entire rate limit bucket. The other 490 get 429 errors all day. The travel agency files a support ticket, threatens to switch providers.

**The Fix:** Rate limit by authenticated user ID as the primary key. Use IP-based rate limiting only as a fallback for unauthenticated endpoints (login, registration, search). For large corporate clients, issue API keys with dedicated rate limit pools.

### Mistake 2: Not Handling Redis Failures

**The Problem:** The team deploys Redis-backed rate limiting. Redis goes down for maintenance. The rate limiter throws an exception. The exception is uncaught. Every request to the API returns a 500 error. The team turned a rate limiting feature into a complete outage.

**The Fix:** Always fail open. If Redis is unreachable, allow the request through. Log the failure, alert on it, but never let the rate limiter become a single point of failure.

```typescript
// WRONG: Redis failure crashes the request
async function checkRateLimit(key: string): Promise<boolean> {
  const result = await redis.eval(luaScript, 1, key, limit, window);
  return result[0] === 1;
}

// RIGHT: Redis failure allows the request through
async function checkRateLimit(key: string): Promise<boolean> {
  try {
    const result = await redis.eval(luaScript, 1, key, limit, window);
    return result[0] === 1;
  } catch (error) {
    logger.error('Rate limiter Redis failure — failing open', { error, key });
    metrics.increment('rate_limiter.redis_failure');
    return true; // Allow the request
  }
}
```

### Mistake 3: Not Sending Rate Limit Headers on Successful Requests

**The Problem:** The team only includes `X-RateLimit-Remaining` headers on 429 responses. Clients have no way to know they are approaching the limit until they hit it. Well-intentioned partners cannot implement proactive throttling because they get no signal.

**The Fix:** Include rate limit headers on every response — 200, 201, 204, all of them. Clients should always know where they stand.

### Mistake 4: Using In-Memory Rate Limiting with Multiple Instances

**The Problem:** The team uses an in-memory counter for rate limiting. In development, it works perfectly. In production with 8 application replicas behind a load balancer, each instance maintains its own counter. Effective limits are multiplied by the number of instances: an 8-instance deployment with a 100/minute limit effectively allows 800/minute.

**The Fix:** Use Redis (or another shared store) for rate limit state. Every instance must read from and write to the same counter.

### Mistake 5: Setting Rate Limits Too Tight in Development

**The Problem:** The team sets aggressive rate limits during development (10 requests per minute). In production, legitimate usage patterns immediately trigger rate limits. The team spends two weeks adjusting limits reactively, breaking partner integrations each time they change a number.

**The Fix:** Start with generous limits in production (10x what you think is reasonable). Monitor actual usage patterns for 2-4 weeks. Then tighten limits to 2-3x the 99th percentile of legitimate usage. Publish your rate limits in your API documentation before you enforce them, giving partners time to adjust.

### Mistake 6: Rate Limiting Without Logging Violations

**The Problem:** The team implements rate limiting but does not log which clients are being rate limited or why. When a partner complains, the team has no data to investigate. They cannot distinguish between a legitimate client with high usage and an attacker.

**The Fix:** Log every rate limit violation with the client identifier, endpoint, current count, and limit. Store these in the `rate_limit_events` table. Build a dashboard that shows violations per client, per endpoint, per hour. This data is invaluable for tuning limits and detecting abuse patterns.

---

## Chapter Summary

| Topic | Key Takeaway |
|---|---|
| **Why Rate Limit** | Prevents abuse, ensures fair usage, and protects cloud costs from runaway traffic |
| **Fixed Window** | Simplest algorithm; use for internal APIs where boundary bursts are acceptable |
| **Sliding Window Log** | Most accurate; stores every request timestamp; high memory cost at scale |
| **Token Bucket** | Best for public APIs; allows controlled bursts; low memory; used by AWS and Google |
| **Sliding Window Counter** | Hybrid accuracy with low memory; used by Cloudflare; great for partner APIs |
| **Leaky Bucket** | Smooths all bursts; constant output rate; use for payment gateways and downstream APIs |
| **Multi-Dimension Limiting** | Combine per-IP, per-user, and per-API-key; check in parallel for low latency |
| **Rate Limit Headers** | Always send X-RateLimit-Limit, Remaining, Reset; send Retry-After on 429 |
| **NestJS Throttler** | Use @nestjs/throttler with Redis storage; extend ThrottlerGuard for custom keys |
| **API Gateway** | Kong or Nginx as first defense layer; rejects traffic before it reaches the app |
| **Tiered Limits** | Free, premium, enterprise tiers stored in rate_limit_config; loaded at request time |
| **Graceful Degradation** | Prioritize critical requests; degrade search results before blocking payments |
| **Redis Atomicity** | All rate limit checks MUST use Lua scripts; multi-step Redis commands are not safe |
| **Fail Open** | If Redis is down, allow requests through; rate limiting must never cause outages |
| **Logging Violations** | Record every 429 in rate_limit_events for analytics and abuse detection |

> **What Comes Next:** In Chapter 23, we move from protecting the gates to monitoring what happens inside them. We will build observability into our booking system — structured logging, distributed tracing with OpenTelemetry, and dashboards that show rate limit violations alongside latency, errors, and throughput. Rate limiting generates data; observability makes that data actionable.
