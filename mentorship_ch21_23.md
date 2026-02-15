# Chapter 21: Circuit Breaker & Bulkhead — Containing the Blast

## The Problem You Do Not Know You Have

Right now, when you call an external API from your Express or NestJS code, you probably write something like this:

```typescript
const response = await fetch('https://supplier-api.example.com/book', {
  method: 'POST',
  body: JSON.stringify(bookingData),
});
const result = await response.json();
```

And you move on. It works in development against a local mock. It works in staging against a healthy API. So you ship it.

Then, at 2 AM on a Saturday, the supplier API starts responding in 45 seconds instead of 200 milliseconds. Your `await` hangs. Every incoming booking request stacks up behind that slow call. Your Node.js event loop is blocked with hundreds of pending promises. Your database connection pool fills up because those in-flight requests are also holding database connections. Your health check endpoint stops responding. Kubernetes declares your pod unhealthy and kills it. The replacement pod starts, immediately gets swamped by the same traffic, and dies too. Your entire booking service is down — not because *your* code has a bug, but because *someone else's* API got slow.

This is called **cascading failure**, and it is one of the most common ways distributed systems die. A single unhealthy dependency drags down everything that touches it, and then everything that touches *those* services, like dominoes falling in a chain.

> **Key Term:** **Cascading failure** — A failure mode in distributed systems where one unhealthy dependency causes its callers to exhaust their resources (connections, threads, memory), making them unhealthy too, which in turn causes their callers to fail, spreading outward like falling dominoes.

This chapter teaches you two patterns that prevent this: the **Circuit Breaker** and the **Bulkhead**. Together, they contain the blast radius of downstream failures so that one sick dependency cannot sink your entire system.

---

## The Circuit Breaker Pattern

### The Analogy: Your House's Breaker Box

Walk over to the electrical panel in your house or apartment. You will see a row of switches — those are circuit breakers. Their job is simple: if a short circuit or overload happens in one circuit (say, the kitchen), the breaker for that circuit **trips** and cuts the power to the kitchen. The rest of your house — lights, computers, refrigerator — keeps running. Without the breaker, the overloaded circuit would overheat the wiring, potentially starting a fire that takes down the entire house.

A software circuit breaker does the same thing. It wraps your calls to a downstream service and monitors them. If too many calls fail, it "trips" and **stops sending requests entirely** for a cooldown period. This protects your service from wasting resources on a dependency that is clearly not working, and it protects the failing dependency from being hammered by requests it cannot handle.

> **Analogy:** A circuit breaker in code works like the breaker box in your house. When one circuit (a downstream service) is overloaded or shorted out, the breaker trips and cuts it off — protecting the rest of your system from catching fire. You do not keep flipping the light switch when the breaker has tripped; you wait, check if the problem is fixed, and then flip the breaker back on.

### The Three States

A circuit breaker has exactly three states. Understanding them is the key to understanding the entire pattern.

```
                    success
            +------------------+
            |                  |
            v                  |
     +------------+    +--------------+
     |   CLOSED   |--->|    OPEN      |
     +------------+    +--------------+
            ^           failure threshold    |
            |           exceeded             |
            |                                |
            |          reset timeout         |
            |          expires               v
            |                         +--------------+
            +-------------------------+  HALF_OPEN   |
                  probe succeeds      +--------------+
                                           |
                                           | probe fails
                                           +---> back to OPEN
```

**CLOSED (Normal Operation)**
This is the default, happy-path state. Every request passes through to the downstream service. The breaker is silently counting successes and failures in the background. Think of this as your kitchen breaker switch in the "ON" position — electricity flows normally, but the breaker is monitoring the current.

**OPEN (Failing — Do Not Even Try)**
When the failure rate crosses a threshold (for example, 50% of the last 10 calls failed), the breaker trips to OPEN. In this state, **no requests are sent to the downstream service at all**. Instead, every call immediately gets a fallback response or an error. This happens in microseconds — no network call, no timeout, no wasted connections. A timer starts counting down (say, 30 seconds).

Why is this a good thing? Because sending requests to a service that is already struggling just makes it worse. It is like trying to push more water through a clogged pipe — you are not helping, you are creating pressure that might burst the pipe.

**HALF-OPEN (Testing Recovery)**
When the timer expires, the breaker moves to HALF-OPEN. It lets **one single probe request** through to the downstream service. Just one. If that request succeeds, the breaker assumes the service has recovered and moves back to CLOSED. If it fails, the breaker goes back to OPEN and the timer restarts. This is you cautiously flipping the kitchen breaker back on to see if the problem is fixed, rather than just slamming it on and hoping for the best.

> **Key Term:** **Circuit Breaker** — A resilience pattern that monitors calls to a downstream service and "trips open" when failures exceed a threshold, preventing further calls until the service recovers. It has three states: CLOSED (normal), OPEN (rejecting all calls), and HALF-OPEN (testing with a single probe).

### Implementing It with the Opossum Library

You could build a circuit breaker from scratch, but you would be reinventing a well-solved wheel. The `opossum` library is the most widely used circuit breaker for Node.js. Let us walk through a real implementation for our booking system, where we wrap calls to a supplier API.

First, the interfaces that define what goes in and what comes out:

```typescript
import CircuitBreaker from 'opossum';

interface BookRoomParams {
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  guestInfo: GuestInfo;
  paymentToken: string;
}

interface BookingResult {
  status: 'confirmed' | 'pending' | 'failed';
  bookingId?: string;
  message?: string;
  queueId?: string;
}
```

Nothing surprising here — just TypeScript interfaces describing the shape of a booking request and its result. You have written similar types for your CRUD controllers. Now the class that wraps the supplier API:

```typescript
class SupplierAPIClient {
  private circuitBreaker: CircuitBreaker;

  constructor(private supplierName: string) {
    this.circuitBreaker = new CircuitBreaker(
      this.callSupplierAPI.bind(this),
      {
        timeout: 5000,                   // Trip if call takes longer than 5s
        errorThresholdPercentage: 50,    // Open after 50% failures
        resetTimeout: 30000,             // Try again after 30s
        volumeThreshold: 10              // Minimum calls before evaluating
      }
    );

    // Fallback receives the SAME arguments as the original function,
    // plus the error as the final argument
    this.circuitBreaker.fallback(this.handleFallback.bind(this));

    this.circuitBreaker.on('open', () => {
      console.error(`Circuit breaker OPEN for ${this.supplierName}`);
      metrics.circuitBreakerState.set(
        { supplier: this.supplierName, state: 'open' }, 1
      );
    });

    this.circuitBreaker.on('halfOpen', () => {
      console.warn(`Circuit breaker HALF-OPEN for ${this.supplierName}`);
    });

    this.circuitBreaker.on('close', () => {
      console.log(`Circuit breaker CLOSED for ${this.supplierName}`);
      metrics.circuitBreakerState.set(
        { supplier: this.supplierName, state: 'closed' }, 1
      );
    });
  }

  async bookRoom(params: BookRoomParams): Promise<BookingResult> {
    return await this.circuitBreaker.fire(params);
  }

  private async callSupplierAPI(
    params: BookRoomParams
  ): Promise<BookingResult> {
    const response = await axios.post(
      `${this.getSupplierEndpoint()}/book`,
      params,
      { timeout: 5000 }
    );
    return response.data;
  }

  // FIXED: params is properly received from opossum's fallback chain
  private handleFallback(
    params: BookRoomParams,
    error: Error
  ): BookingResult {
    console.error(
      `Fallback triggered for ${this.supplierName}:`, error.message
    );
    return {
      status: 'pending',
      message: 'Supplier temporarily unavailable. Request queued.',
      queueId: this.queueRequest(params)
    };
  }

  private queueRequest(params: BookRoomParams): string {
    const queueId = generateUUID();
    // Push to a persistent queue for later processing
    messageQueue.send('supplier-retry-queue', {
      queueId,
      supplier: this.supplierName,
      params,
      enqueuedAt: new Date().toISOString()
    });
    return queueId;
  }

  private getSupplierEndpoint(): string {
    return config.suppliers[this.supplierName].endpoint;
  }
}
```

Let us break this down piece by piece.

**The constructor** creates a new `CircuitBreaker` instance. The first argument is the function to protect — `this.callSupplierAPI`. The second is the configuration object:

- `timeout: 5000` — If the supplier does not respond within 5 seconds, opossum treats it as a failure. Without this, your request would hang for however long axios waits (often 30-120 seconds by default).
- `errorThresholdPercentage: 50` — If half the calls fail, trip the breaker. Set this lower (say, 30%) if you want to be more aggressive, higher (say, 80%) if you want to tolerate more failure.
- `resetTimeout: 30000` — Wait 30 seconds in the OPEN state before trying a probe request. Too short and you hammer a recovering service. Too long and you delay recovery.
- `volumeThreshold: 10` — Do not start evaluating failure rates until at least 10 calls have been made. This prevents the breaker from tripping after 2 calls if 1 of them fails (that is a 50% failure rate, but from a tiny sample).

**The `bookRoom` method** is what the rest of your code calls. It delegates to `this.circuitBreaker.fire(params)`. Opossum handles everything: if the breaker is CLOSED, it calls `callSupplierAPI`. If it is OPEN, it immediately calls the fallback. If it is HALF-OPEN, it sends one probe.

**The event listeners** (`open`, `halfOpen`, `close`) let you log state transitions and update metrics dashboards. In production, you want alerts when a breaker opens — it means a dependency is in trouble.

### The Common Mistake: Undeclared params in Fallback

This is a bug that has bitten many developers, and it is worth understanding in detail because it teaches you something important about how opossum works internally.

Here is the **wrong** version of the fallback:

```typescript
// WRONG - will crash at the worst possible time
private handleFallback(error: Error): BookingResult {
  console.error(`Fallback triggered:`, error.message);
  return {
    status: 'pending',
    message: 'Supplier temporarily unavailable.',
    queueId: this.queueRequest(params)  // ReferenceError: params is not defined!
  };
}
```

When the circuit breaker trips and calls your fallback, you need access to the original request parameters so you can queue them for later processing. But `params` is not magically available inside the fallback — unless you declare it in the function signature.

Here is how opossum calls your fallback internally: it passes **the same arguments that were given to `.fire()`**, followed by the error as the last argument. So if you called `this.circuitBreaker.fire(params)`, the fallback receives `(params, error)`. If your protected function accepted three arguments — say, `(hotelId, roomId, dates)` — then the fallback would receive `(hotelId, roomId, dates, error)`.

The **correct** signature:

```typescript
// CORRECT - params comes from opossum's argument forwarding
private handleFallback(params: BookRoomParams, error: Error): BookingResult {
  // params is now in scope and contains the original request data
  return {
    status: 'pending',
    message: 'Supplier temporarily unavailable. Request queued.',
    queueId: this.queueRequest(params)  // works!
  };
}
```

Why is this bug so insidious? Because the fallback only runs when the circuit breaker trips — which only happens under real failure conditions. You will never hit this bug in unit tests unless you specifically test the fallback path. You will hit it at 2 AM during an outage, when the fallback is the one thing between you and a complete meltdown. Test your fallbacks.

> **What If You Skip This?** Without a circuit breaker, a single slow or failing downstream service will consume all your available connections and event loop time. Your service becomes unresponsive to *all* requests — not just the ones going to the failing dependency. In our booking system, a flaky supplier API would take down search, payments, and notifications along with it. We have seen this happen to real companies during peak booking periods.

---

## The Bulkhead Pattern

### The Analogy: Ship Compartments

The word "bulkhead" comes from shipbuilding. A ship's hull is divided into watertight compartments by thick walls called bulkheads. If the hull is breached in one compartment, water floods that section — but the bulkheads prevent it from spreading to the rest of the ship. Without bulkheads, a single hole sinks the entire vessel.

> **Analogy:** A ship without bulkheads sinks from a single leak. A ship with bulkheads contains the flood to one compartment and stays afloat. In your system, each downstream dependency gets its own "compartment" of resources (connections, threads, memory). If one dependency floods its compartment, the others stay dry.

> **Key Term:** **Bulkhead** — A resilience pattern borrowed from shipbuilding that isolates resources (connection pools, concurrency limits, memory) per downstream dependency. If one dependency consumes all its allocated resources, other dependencies are unaffected because they have their own separate pools.

### Why Circuit Breakers Are Not Enough

You might be thinking: "I already have circuit breakers. If a service fails, the breaker trips and stops sending calls. Problem solved, right?"

Not entirely. Consider this scenario: your payment service is *slow* but not fully failing. It responds in 4.5 seconds instead of 200 milliseconds. Your circuit breaker is configured with a 5-second timeout, so these calls technically succeed — they are just extremely slow. The breaker stays CLOSED.

Meanwhile, each of those 4.5-second calls is holding one of your HTTP connections, one slot in your connection pool, and a chunk of memory. If you have 100 concurrent booking requests trying to reach the payment service, you have 100 connections tied up. And if your total connection pool is 150 connections shared across payment, inventory, and supplier calls — you only have 50 connections left for everything else. Your inventory lookups, which take 50 milliseconds each, are now waiting in line behind slow payment calls.

This is where the bulkhead helps. Instead of one shared pool of 150 connections, you create **separate pools** for each downstream service:

- Payment service: max 50 concurrent connections
- Inventory service: max 100 concurrent connections
- Supplier API: max 20 concurrent connections

Now if the payment service gets slow and fills up its 50 connections, inventory still has its own 100 connections, completely unaffected.

### Connection Pool Isolation in Code

Here is the `BulkheadManager` implementation. Read through it carefully — it is one of those classes that is simple in concept but precise in execution:

```typescript
export class BulkheadRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadRejectError';
  }
}

export class BulkheadManager {
  private readonly pools = new Map<string, {
    maxConcurrent: number;
    currentActive: number;
    queue: Array<{
      resolve: Function;
      reject: Function;
      fn: Function;
    }>;
    maxQueueSize: number;
  }>();

  register(
    serviceName: string,
    maxConcurrent: number,
    maxQueueSize: number = 100
  ) {
    this.pools.set(serviceName, {
      maxConcurrent,
      currentActive: 0,
      queue: [],
      maxQueueSize
    });
  }

  async execute<T>(
    serviceName: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const pool = this.pools.get(serviceName);
    if (!pool) {
      throw new Error(`No bulkhead registered for ${serviceName}`);
    }

    if (pool.currentActive >= pool.maxConcurrent) {
      if (pool.queue.length >= pool.maxQueueSize) {
        throw new BulkheadRejectError(
          `Bulkhead full for ${serviceName}`
        );
      }

      // Park the request in the queue until a slot opens
      return new Promise((resolve, reject) => {
        pool.queue.push({ resolve, reject, fn });
      });
    }

    // We have a slot — run the function
    pool.currentActive++;
    try {
      const result = await fn();
      return result;
    } finally {
      pool.currentActive--;
      this.processQueue(serviceName);
    }
  }

  private processQueue(serviceName: string) {
    const pool = this.pools.get(serviceName);
    if (!pool || pool.queue.length === 0) return;
    if (pool.currentActive >= pool.maxConcurrent) return;

    const { resolve, reject, fn } = pool.queue.shift()!;
    pool.currentActive++;

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        pool.currentActive--;
        this.processQueue(serviceName);
      });
  }
}
```

Let us walk through what happens when a request comes in:

1. **`execute` is called** with a service name and a function to run. The manager looks up the pool for that service.
2. **If a slot is available** (`currentActive < maxConcurrent`), it increments the counter, runs the function, decrements when done, and checks if anything is waiting in the queue.
3. **If all slots are busy** but the queue is not full, the request is parked in a queue. It waits there as a Promise until a slot opens. The `processQueue` method, called in the `finally` block of every completed request, picks up the next queued item.
4. **If all slots are busy AND the queue is full**, the request is immediately rejected with a `BulkheadRejectError`. This is the "fail fast" behavior that prevents resource exhaustion.

Here is how you wire it up in practice:

```typescript
const bulkhead = new BulkheadManager();
bulkhead.register('payment-service', 50, 200);
// Max 50 concurrent calls, 200 waiting in queue

bulkhead.register('inventory-service', 100, 500);
// Max 100 concurrent calls, 500 waiting in queue

bulkhead.register('supplier-api', 20, 50);
// Max 20 concurrent calls, 50 waiting in queue

// Wrapping a call with bulkhead isolation
async function chargePayment(
  paymentData: PaymentData
): Promise<PaymentResult> {
  return bulkhead.execute('payment-service', async () => {
    return paymentGateway.charge(paymentData);
  });
}
```

Notice the different limits for each service. The inventory service gets 100 slots because it handles high-volume search queries. The supplier API gets only 20 because the external supplier has told us they can handle a maximum of 25 concurrent connections — we stay below their limit to be a good neighbor.

### Circuit Breaker + Bulkhead: Better Together

In production, you use both patterns together. The bulkhead limits how many concurrent calls can go to each service. The circuit breaker monitors those calls and trips if too many fail. They solve different problems:

| Pattern | What It Prevents | How It Works |
|---|---|---|
| **Circuit Breaker** | Wasted calls to a service that is clearly broken | Stops sending requests after failures exceed a threshold |
| **Bulkhead** | One slow service consuming all shared resources | Gives each service its own isolated pool of connections |

The circuit breaker says: "This service is broken, stop calling it." The bulkhead says: "Even if this service is slow, it cannot steal resources from other services."

> **Checkpoint:** Can you explain the difference between a circuit breaker and a bulkhead to a colleague? Here is the test: if a downstream service is *failing fast* (returning errors in 10 milliseconds), which pattern helps? If a downstream service is *succeeding but slowly* (responding in 4 seconds instead of 200 milliseconds), which pattern helps? Answer: the circuit breaker handles the fast-failure case (it trips after enough errors). The bulkhead handles the slow-success case (it prevents those slow calls from stealing all your connections).

---

## Chapter 21 Summary

| Concept | One-Sentence Summary |
|---|---|
| Cascading failure | One failing dependency drags down everything that depends on it, and then everything that depends on those services. |
| Circuit Breaker | A wrapper that monitors downstream calls and stops sending them when failure rates get too high. |
| CLOSED state | Normal operation; requests pass through while the breaker counts failures. |
| OPEN state | Failure threshold exceeded; all requests immediately get a fallback or error with no network call. |
| HALF-OPEN state | After a cooldown, one probe request tests whether the service has recovered. |
| Opossum | The standard Node.js circuit breaker library; wraps an async function and manages state transitions. |
| Fallback signature | Opossum passes the original function's arguments to the fallback, followed by the error as the last argument. |
| Bulkhead | Isolates resources (connections, concurrency slots) per downstream service so one slow service cannot starve others. |
| Circuit Breaker + Bulkhead | Use both: the breaker stops calls to broken services, the bulkhead prevents slow services from stealing shared resources. |

---

# Chapter 22: Rate Limiting — Protecting Your Castle Gates

## Why Someone Will Abuse Your API

You have deployed your booking API. It works. Users can search for hotels, create bookings, and check their reservations. You might even have authentication in place, so only logged-in users can access certain endpoints. You feel safe.

You are not safe.

Here is what happens when your API is publicly accessible:

- A competitor builds a bot that hits your search endpoint 10,000 times per minute, scraping every hotel price in every city. Your database groans. Search latency quadruples for real users.
- An angry user writes a script that submits booking requests in a tight loop, trying to overwhelm your system.
- A buggy mobile app has a retry loop with no backoff — every time a request fails, it retries instantly, forever. One user's broken phone generates more traffic than your next 1,000 users combined.
- A denial-of-service attack sends a flood of requests from a botnet, attempting to make your service unavailable to everyone.

Rate limiting is the gate at the front of your castle. It does not care whether the traffic is malicious or accidental. It enforces a simple rule: **no single client gets to use more than their fair share of your system's capacity**.

You may have seen `express-rate-limit` — the popular middleware that counts requests per IP address and returns a 429 status code when the limit is exceeded. That works great for a single Express server. But in our booking system, we have multiple instances of each service running behind a load balancer. If User A sends 100 requests and those requests get distributed across 5 server instances, each instance only sees 20 requests. The per-instance counter never trips.

Distributed rate limiting solves this by storing the counters in a shared location — Redis — so all instances see the same count.

> **Key Term:** **Rate Limiting** — Controlling the number of requests a client can make to your API within a given time window. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests) and tells the client when they can try again.

---

## The Three Algorithms

There are three main approaches to counting requests against a limit. Each has tradeoffs. Understanding them will help you pick the right one for each situation.

### Fixed Window

The simplest approach. Divide time into fixed windows (say, one-minute intervals). Count requests in the current window. If the count exceeds the limit, reject.

```
Window 1 (12:00:00 - 12:00:59)    Window 2 (12:01:00 - 12:01:59)
|==========================|      |==========================|
  45 requests (limit: 100)          12 requests (limit: 100)
  Status: OK                        Status: OK
```

**The problem**: boundary bursts. A client can send 100 requests at 12:00:59 (end of window 1) and another 100 requests at 12:01:00 (start of window 2). They have sent 200 requests in 2 seconds, but each window only counts 100. They never hit the limit.

```
        Window 1               Window 2
|========================|========================|
                   100 reqs  100 reqs
                   ^  12:00:59   ^ 12:01:00
                   |--- 200 requests in 2 seconds! ---|
```

Fixed window is easy to implement and good enough if exact precision does not matter. For many internal APIs, it is fine.

### Sliding Window

Instead of hard window boundaries, the sliding window looks at a moving window of time that ends at "right now." If the window is 60 seconds, it counts all requests from 60 seconds ago until now.

```
                          NOW
                           |
  |========================|
  60 seconds ago    sliding window
  Count all requests in this range
```

No boundary burst problem. A request at 12:00:59 and a request at 12:01:00 are both within the same 60-second sliding window. The count is always accurate.

The implementation uses a Redis sorted set where each request is a member with its timestamp as the score. To check the rate, remove entries older than the window, then count what remains:

```typescript
export class SlidingWindowRateLimiter {
  private readonly luaScript = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local window_start = now - window

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count current entries
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Add new entry with timestamp as score
      redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
      redis.call('EXPIRE', key, window)
      return {1, limit - count - 1, 0}  -- allowed, remaining, retry_after
    else
      -- Get oldest entry to calculate retry time
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local retry_after = window - (now - tonumber(oldest[2]))
      return {0, 0, retry_after}  -- denied, remaining, retry_after
    end
  `;

  async checkRateLimit(params: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const [allowed, remaining, retryAfter] = await redis.eval(
      this.luaScript, 1, params.key,
      params.windowSeconds, params.maxRequests, now
    ) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining,
      retryAfter: retryAfter > 0 ? retryAfter : undefined,
      limit: params.maxRequests,
      windowSeconds: params.windowSeconds
    };
  }
}
```

Why a Lua script instead of multiple Redis commands from TypeScript? Because Lua scripts execute **atomically** inside Redis. Between the `ZREMRANGEBYSCORE` (removing old entries) and the `ZADD` (adding the new one), no other client can sneak in a request. Without atomicity, two requests arriving at the exact same millisecond could both pass the count check and both get admitted, exceeding the limit.

If you have used Redis only as a simple key-value cache before, this might be your first encounter with sorted sets and Lua scripts. Here is what each Redis command does:

- `ZREMRANGEBYSCORE key -inf window_start` — Remove all members from the sorted set whose score (timestamp) is before the start of our window. This cleans out expired entries.
- `ZCARD key` — Count how many members remain. This is our request count for the current window.
- `ZADD key score member` — Add a new member (the current request) with the current timestamp as its score.
- `EXPIRE key window` — Set a TTL on the entire key so Redis cleans it up automatically if the client stops sending requests.

> **Analogy:** Imagine a bouncer at a club who keeps a list of everyone who entered in the last hour. When you walk up, the bouncer crosses off everyone who entered more than an hour ago, counts the remaining names, and lets you in only if the club is not at capacity. The bouncer's clipboard is the Redis sorted set. The one-hour window slides forward with every new arrival.

### Token Bucket

The token bucket is different in philosophy. Instead of counting requests, it models a bucket that fills with tokens at a steady rate. Each request consumes one token. If the bucket is empty, the request is denied.

The key property: **tokens accumulate during idle periods**. If your limit is 100 requests per minute but you send nothing for 5 minutes, you build up tokens (capped at the bucket capacity). Then you can use those tokens in a burst. This is perfect for clients with legitimate burst patterns — like a travel agent who submits a batch of 20 bookings at once but then goes quiet for several minutes.

```
Capacity: 10 tokens, Refill rate: 2 tokens/second

Time 0s:  [||||||||||]  10 tokens (full bucket)
Time 0s:  Request -> consume 1 token -> [|||||||||.]  9 tokens
Time 0s:  Request -> consume 1 token -> [||||||||..]  8 tokens
...burst of 8 more requests...
Time 0s:  [..........]  0 tokens (empty bucket)
Time 0s:  Request -> DENIED (no tokens)
Time 1s:  [||........]  2 tokens (refilled at 2/sec)
Time 1s:  Request -> consume 1 token -> [|.........]  1 token
```

Here is the Redis implementation:

```typescript
export class TokenBucketRateLimiter {
  private readonly luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or capacity
    local last_refill = tonumber(bucket[2]) or now

    -- Refill tokens based on elapsed time
    local elapsed = now - last_refill
    tokens = math.min(capacity, tokens + (elapsed * refill_rate))

    if tokens >= requested then
      tokens = tokens - requested
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {1, tokens}  -- allowed, remaining tokens
    else
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {0, tokens}  -- denied, remaining tokens
    end
  `;

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number = 1
  ): Promise<{ allowed: boolean; remainingTokens: number }> {
    const now = Date.now() / 1000;
    const [allowed, remaining] = await redis.eval(
      this.luaScript, 1, key, capacity, refillRate, now, tokens
    ) as [number, number];

    return { allowed: allowed === 1, remainingTokens: remaining };
  }
}
```

The Lua script uses a Redis hash (`HMGET`/`HMSET`) to store two values per client: the current number of tokens and the timestamp of the last refill. Every time a request arrives, it calculates how many tokens should have been added since the last check, adds them (up to the capacity), and then tries to subtract the requested amount.

### Algorithm Comparison

| Algorithm | Burst Handling | Precision | Memory Usage | Best For |
|---|---|---|---|---|
| **Fixed Window** | Allows 2x bursts at boundaries | Low | Very low | Simple internal APIs |
| **Sliding Window** | No boundary bursts | High | Moderate (one entry per request) | Public APIs needing accuracy |
| **Token Bucket** | Allows controlled bursts | Medium | Very low (2 values per client) | APIs with legitimate burst patterns |

---

## Per-User, Per-IP, and Per-Endpoint Limits

Not all requests are equal, and not all users should get the same limits. Our booking system uses **tiered rate limits** based on who is making the request and what they are requesting:

```typescript
export const rateLimitTiers = {
  guest: {
    search:  { windowSeconds: 60, maxRequests: 30 },
    general: { windowSeconds: 60, maxRequests: 60 }
  },
  user: {
    search:  { windowSeconds: 60, maxRequests: 100 },
    booking: { windowSeconds: 60, maxRequests: 10 },
    general: { windowSeconds: 60, maxRequests: 200 }
  },
  premium: {
    search:  { windowSeconds: 60, maxRequests: 300 },
    booking: { windowSeconds: 60, maxRequests: 30 },
    general: { windowSeconds: 60, maxRequests: 500 }
  },
  admin: {
    search:  { windowSeconds: 60, maxRequests: 1000 },
    booking: { windowSeconds: 60, maxRequests: 100 },
    general: { windowSeconds: 60, maxRequests: 2000 }
  }
};
```

Notice the design decisions:

- **Guests** (unauthenticated users) get the most restrictive limits. They can search 30 times per minute — enough to browse, but not enough to scrape.
- **Authenticated users** get 100 searches per minute and can create 10 bookings per minute. That is plenty for normal usage.
- **Premium users** (travel agents, business accounts) get 3x the limits of regular users. They pay more and have legitimate high-volume use cases.
- **Admin accounts** get very high limits because they might be running bulk operations or admin tools.
- **Booking endpoints get separate limits** from general endpoints. You might search 100 times to find the right hotel, but you should not be creating 100 bookings per minute.

### The Rate Limit Middleware

Here is how these tiers plug into an Express-style middleware:

```typescript
export class RateLimitMiddleware {
  private readonly limiter = new SlidingWindowRateLimiter();

  async handle(req: Request, res: Response, next: NextFunction) {
    const userRole = req.user?.role || 'guest';
    const endpoint = this.categorizeEndpoint(req.path);
    const tier = rateLimitTiers[userRole]?.[endpoint]
              || rateLimitTiers[userRole]?.general;

    if (!tier) return next();

    // Build a unique key: role + user ID (or IP for guests) + endpoint
    const key = `ratelimit:${userRole}:${req.user?.id || req.ip}:${endpoint}`;
    const result = await this.limiter.checkRateLimit({ key, ...tier });

    // Always set headers so well-behaved clients can self-regulate
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter || 60);
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
        retryAfter: result.retryAfter
      });
    }

    next();
  }

  private categorizeEndpoint(path: string): string {
    if (path.includes('/search')) return 'search';
    if (path.includes('/bookings') && path === '/api/v1/bookings') {
      return 'booking';
    }
    return 'general';
  }
}
```

The key line is `const key = ...`. This string uniquely identifies a client-endpoint pair. For an authenticated user, the key includes their user ID, so rate limits are per-user. For a guest, the key includes their IP address, so rate limits are per-IP. The endpoint category is also in the key, so hitting the search endpoint does not count against your booking limit.

The middleware also sets `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers on **every** response — even successful ones. This is good API citizenship. Well-built client applications read these headers and slow down before hitting the limit, avoiding 429 errors entirely.

When a request is denied, the `Retry-After` header tells the client exactly how many seconds to wait before trying again. Without this header, clients have to guess how long to wait, and they often guess wrong (too short, hammering your API in a loop of 429s).

> **What If You Skip This?** Without rate limiting, a single misbehaving client — whether malicious or just buggy — can consume enough resources to degrade the experience for all other users. We have seen a single-user script (someone trying to auto-book concert tickets) generate enough load to increase search latency for an entire region from 50ms to 8 seconds. Rate limiting would have stopped them after 30 requests and protected everyone else.

> **Checkpoint:** Suppose a premium user sends 295 search requests in 58 seconds, then sends 10 more in the next 2 seconds. Under the sliding window algorithm with a 300-request-per-minute limit, would those last 10 requests be allowed? Yes — they would. At the moment the 301st request arrives, the sliding window looks back 60 seconds and counts 301 requests, which exceeds 300. Request 301 is denied. But requests 296-300 would have been allowed. Now answer this: would a fixed-window algorithm give a different answer? (Hint: it depends on whether those requests span a window boundary.)

---

## Chapter 22 Summary

| Concept | One-Sentence Summary |
|---|---|
| Rate limiting | Capping how many requests a client can make within a time window to protect your system from overuse. |
| Fixed window | Divides time into fixed intervals and counts requests per interval; simple but allows boundary bursts. |
| Sliding window | Uses a moving time window with no fixed boundaries; prevents boundary bursts but uses more memory. |
| Token bucket | Tokens accumulate over time and are spent on requests; allows controlled bursts during idle-to-active transitions. |
| Redis Lua scripts | Atomic scripts executed inside Redis; essential for accurate counting when multiple server instances share a rate limiter. |
| Per-user vs. per-IP | Authenticated users get per-user limits (tracking their user ID); unauthenticated guests get per-IP limits. |
| Rate limit tiers | Different user roles get different limits; guests are restricted, admins are generous, and booking endpoints are separate from search. |
| X-RateLimit headers | Response headers that tell clients their limit and how many requests remain; good API citizenship. |
| HTTP 429 | The standard "Too Many Requests" status code, paired with a `Retry-After` header. |

---

# Chapter 23: Retry & Backoff — When to Try Again

## The Retry You Are Doing Right Now (And Why It Is Wrong)

When a network call fails, the natural instinct is to try again. You have probably written something like this:

```typescript
async function callPaymentService(data: PaymentData) {
  for (let i = 0; i < 3; i++) {
    try {
      const result = await fetch('http://payment-service:3005/charge', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return await result.json();
    } catch (error) {
      console.log(`Attempt ${i + 1} failed, retrying...`);
    }
  }
  throw new Error('Payment service unavailable after 3 attempts');
}
```

This looks reasonable. Three attempts, with a `catch` to handle the error and try again. But there is a critical problem: **there is no delay between retries**. The moment a call fails, you send the next one instantly.

Why is this bad? Think about *why* the call failed. The most common reasons:

1. The service is overloaded with too many requests.
2. The service is restarting after a crash.
3. The network is congested.

In all three cases, sending another request immediately makes the situation **worse**. If the service is overloaded, your instant retry adds to the overload. If it is restarting, it is not ready yet — your request will fail again. If the network is congested, you are adding more packets to the congestion.

Now multiply this by every client. If your booking service has 500 concurrent requests in flight when the payment service goes down, all 500 fail. All 500 retry instantly. The payment service, which was just starting to recover, now gets hit with 500 requests at once. It goes down again. All 500 fail. All 500 retry. This cycle repeats until something breaks permanently.

This is called the **thundering herd** problem, and it is one of the most common ways a brief blip turns into a prolonged outage.

> **Analogy:** Imagine you knock on a friend's door and nobody answers. "They must be busy," you think. So you knock again immediately. Then again. Then you start hammering the door. Then their neighbor walks over and starts hammering too. Then the whole street is pounding on the door. Your friend, who was just in the bathroom, is now so terrified that they have locked the deadbolt and called the police. You could have just waited 30 seconds and knocked once more, politely.

> **Key Term:** **Thundering Herd** — A failure pattern where many clients simultaneously retry failed requests, creating a surge of traffic that overwhelms a service that was beginning to recover. The result is a self-reinforcing cycle of failure and recovery that can last far longer than the original outage.

---

## Exponential Backoff with Jitter

The solution has two parts: **exponential backoff** and **jitter**.

**Exponential backoff** means that each retry waits longer than the previous one. Instead of retrying after 0ms, 0ms, 0ms, you retry after 200ms, 400ms, 800ms. The delay doubles (or otherwise increases exponentially) with each attempt. This gives the failing service progressively more time to recover.

> **Key Term:** **Exponential backoff** — A retry strategy where the delay between attempts increases exponentially (e.g., 200ms, 400ms, 800ms, 1600ms). This gives a failing service progressively more breathing room to recover, rather than hammering it with rapid-fire requests.

**Jitter** adds randomness to the delay. Without jitter, if 500 clients all start retrying with exponential backoff at the same time, they all wait 200ms for the first retry, then all hit the service at the same 200ms mark. Then they all wait 400ms and hit it again at the same 600ms mark. They are in lockstep — the thundering herd is just scheduled instead of immediate.

With **full jitter**, instead of waiting exactly 400ms, each client waits a random amount between 0 and 400ms. The retries spread out over time. Some clients retry at 50ms, some at 200ms, some at 380ms. The load is distributed smoothly instead of arriving in spikes.

> **Key Term:** **Jitter** — Randomness added to backoff delays so that retrying clients do not all fire at the same moment. Full jitter randomizes the delay between 0 and the calculated backoff time, spreading retry load smoothly over time and preventing synchronized spikes.

```
Without jitter (500 clients, all start at time 0):
Time 0ms:    ||||||||||||||||||| 500 requests (all fail)
Time 200ms:  ||||||||||||||||||| 500 retries (spike!)
Time 600ms:  ||||||||||||||||||| 500 retries (spike!)
Time 1400ms: ||||||||||||||||||| 500 retries (spike!)

With full jitter (500 clients, all start at time 0):
Time 0ms:    ||||||||||||||||||| 500 requests (all fail)
Time 0-200ms:    ||  |  ||  | |  ||| retries spread out
Time 0-600ms:       |    ||   |   |  retries spread further
Time 0-1400ms:        |     |    |   retries well-distributed
```

### The Implementation

Here is the retry service for our booking system. Read through it — every line is deliberate:

```typescript
interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

export class RetryService {
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      baseDelayMs = 200,
      maxDelayMs = 10000,
      retryableErrors = [
        'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '503', '429'
      ],
      onRetry
    } = options;

    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === maxRetries) break;
        if (!this.isRetryable(error, retryableErrors)) break;

        // Exponential backoff with full jitter
        const exponentialDelay = Math.min(
          maxDelayMs,
          baseDelayMs * Math.pow(2, attempt)
        );
        const jitteredDelay = Math.random() * exponentialDelay;

        if (onRetry) onRetry(attempt + 1, jitteredDelay, error);

        await this.sleep(jitteredDelay);
      }
    }

    throw lastError!;
  }

  private isRetryable(error: any, retryableErrors: string[]): boolean {
    // Never retry client errors (except 429 Too Many Requests)
    if (error.response?.status >= 400 &&
        error.response?.status < 500 &&
        error.response?.status !== 429) {
      return false;
    }

    // Never retry business logic errors
    if (error instanceof InsufficientInventoryError) return false;
    if (error instanceof FraudBlockedError) return false;
    if (error instanceof PaymentDeclinedError) return false;

    const errorCode = error.code || error.response?.status?.toString();
    return retryableErrors.includes(errorCode);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

Let us trace through a concrete example. Suppose we call a supplier API that is temporarily overloaded:

**Attempt 0** (the initial call): The call fails with `ECONNRESET`. We check: is this the last attempt? No (we allow 3 retries). Is it retryable? `ECONNRESET` is in our list, so yes. We calculate the delay: `min(10000, 200 * 2^0)` = `min(10000, 200)` = 200ms. Then jitter: `Math.random() * 200` = let us say 147ms. We sleep 147ms.

**Attempt 1**: The call fails again with `503`. Retryable? Yes (503 is in our list). Delay: `min(10000, 200 * 2^1)` = `min(10000, 400)` = 400ms. Jitter: `Math.random() * 400` = say 289ms. We sleep 289ms.

**Attempt 2**: The call fails with `ETIMEDOUT`. Delay: `min(10000, 200 * 2^2)` = `min(10000, 800)` = 800ms. Jitter: `Math.random() * 800` = say 512ms. We sleep 512ms.

**Attempt 3**: The call succeeds! The service has recovered. We return the result.

Total time: 147 + 289 + 512 = roughly 950ms of waiting, spread over about 1.5 seconds. Without retries, the user would have seen an error. With retries, they never knew anything was wrong.

The `maxDelayMs` cap is important. Without it, after 10 retries the delay would be 200 * 2^10 = 204,800ms (over 3 minutes). You do not want a single request waiting that long. The cap ensures the delay never exceeds a reasonable maximum.

### When NOT to Retry

This is just as important as knowing when to retry. The `isRetryable` method encodes a critical rule: **never retry errors that will not succeed on retry**.

**Do not retry 4xx client errors (except 429).** A 400 Bad Request means your request data is malformed. Sending the same malformed data again will get the same error. A 401 Unauthorized means your token is invalid. Retrying will not mint a new token. A 404 Not Found means the resource does not exist. It will still not exist in 200 milliseconds.

The one exception in the 4xx range is **429 Too Many Requests**. This explicitly means "you are being rate limited; try again later." The server is telling you the request would succeed if you slowed down.

**Do not retry business logic errors.** If the inventory service says there are no rooms available (`InsufficientInventoryError`), retrying will not create new rooms. If the fraud detection system blocked a payment (`FraudBlockedError`), retrying will get blocked again. If the customer's credit card was declined (`PaymentDeclinedError`), it will be declined again. These are not transient failures — they are correct responses to conditions that will not change in milliseconds.

**Do retry infrastructure errors.** `ECONNRESET` (connection dropped), `ETIMEDOUT` (timed out), `ECONNREFUSED` (service not accepting connections), `503` (service temporarily unavailable) — these all indicate transient problems that are likely to resolve on their own within seconds or minutes.

> **What If You Skip This?** Without proper retry logic, transient network blips become user-visible errors. A 100ms network hiccup that would have been invisible with a retry instead shows the user a "something went wrong" error page. Without backoff and jitter, your retries create thundering herds that turn brief outages into prolonged ones. And without filtering non-retryable errors, your system wastes time and resources sending requests that are guaranteed to fail again.

---

## Retry Budget: The System-Wide Safety Valve

Individual retry policies are necessary but not sufficient. Here is the scenario they do not handle:

Your booking service receives 1,000 requests per second. Each request calls the payment service. The payment service starts failing 50% of the time. Each failed request retries up to 3 times. Now the payment service is receiving: 1,000 original requests + up to 1,500 retries (50% of 1,000, times 3 retry attempts) = 2,500 requests per second. The additional load from retries pushes the failure rate from 50% to 80%. Now there are even more retries. The system spirals.

A **retry budget** puts a cap on the **ratio** of retries to original requests across the entire system. If you set it to 10%, then no matter how many requests are failing, the total number of retries cannot exceed 10% of total traffic.

> **Key Term:** **Retry budget** — A system-wide cap that limits the total number of retries to a fixed percentage of original requests (e.g., 10%) within a rolling time window. This prevents retries from amplifying load during widespread failures, where individual per-request retry policies would otherwise multiply traffic many times over.

```typescript
export class RetryBudget {
  private windowMs: number;
  private maxRetryRatio: number;
  private requests: number[] = [];
  private retries: number[] = [];

  constructor(
    windowMs: number = 60000,
    maxRetryRatio: number = 0.1
  ) {
    this.windowMs = windowMs;
    this.maxRetryRatio = maxRetryRatio;
  }

  recordRequest(): void {
    this.requests.push(Date.now());
    this.cleanup();
  }

  canRetry(): boolean {
    this.cleanup();
    const totalRequests = this.requests.length;
    const totalRetries = this.retries.length;

    if (totalRequests === 0) return true;
    return (totalRetries / totalRequests) < this.maxRetryRatio;
  }

  recordRetry(): void {
    this.retries.push(Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.requests = this.requests.filter(t => t > cutoff);
    this.retries = this.retries.filter(t => t > cutoff);
  }
}
```

The `RetryBudget` tracks two arrays: timestamps of all requests and timestamps of all retries within a rolling window (default: 60 seconds). Before each retry, you call `canRetry()`. It cleans out old entries, calculates the current ratio, and returns `false` if retries would exceed the budget.

### Combining Retry with Budget

Here is how you wire the retry service and the retry budget together in practice:

```typescript
const retryService = new RetryService();
const retryBudget = new RetryBudget(60000, 0.1); // Max 10% retries in 60s

async function bookWithRetry(
  params: BookRoomParams
): Promise<BookingResult> {
  retryBudget.recordRequest();

  return retryService.executeWithRetry(
    () => supplierClient.bookRoom(params),
    {
      maxRetries: 3,
      onRetry: (attempt, delay, error) => {
        if (!retryBudget.canRetry()) {
          throw new Error('Retry budget exhausted -- failing fast');
        }
        retryBudget.recordRetry();
        console.warn(
          `Retry attempt ${attempt} after ${delay.toFixed(0)}ms: ` +
          `${error.message}`
        );
      }
    }
  );
}
```

Every original request calls `retryBudget.recordRequest()`. Before each retry, the `onRetry` callback checks `retryBudget.canRetry()`. If the budget is exhausted — meaning retries already account for 10% or more of recent traffic — the function throws immediately instead of retrying. This is the "fail fast" principle: it is better to return an error quickly than to pile more load onto a struggling system.

In our booking system with 1,000 requests per second and a 10% budget, the maximum retry rate is 100 retries per second. Even if every request is failing, the payment service will see at most 1,100 requests per second (1,000 original + 100 retries) instead of the 2,500 it would see without a budget. That difference can be the margin between "the service recovers in 30 seconds" and "the service is down for an hour."

### How Circuit Breakers, Rate Limiting, and Retries Work Together

These three patterns from Chapters 21, 22, and 23 are not alternatives — they are layers that complement each other:

```
Request arrives
    |
    v
[Rate Limiter] -- Too many requests? --> 429 Reject
    |
    | (allowed)
    v
[Circuit Breaker] -- Breaker open? --> Fallback response
    |
    | (closed or half-open)
    v
[Actual API call]
    |
    | (failure)
    v
[Retry with backoff] -- Budget exhausted? --> Fail fast
    |
    | (budget OK)
    v
[Wait with jitter, then retry]
```

The **rate limiter** sits at the entrance and protects you from excessive inbound traffic. The **circuit breaker** wraps your outbound calls and stops them when a dependency is clearly broken. The **retry with backoff** handles transient failures gracefully, and the **retry budget** prevents retries from becoming an amplification attack on your own infrastructure.

> **Checkpoint:** A junior developer on your team writes a retry loop with no delay, no jitter, and no distinction between error types. They test it against a local mock API and it works fine. List three specific things that will go wrong in production that will not show up in their local testing. (Answers: 1. Thundering herd when the service goes down under real concurrency. 2. Retrying 400 Bad Request errors wastes resources and will never succeed. 3. Without a retry budget, retries during a partial outage will amplify load and prevent recovery.)

---

## Chapter 23 Summary

| Concept | One-Sentence Summary |
|---|---|
| Naive retry | Retrying immediately in a tight loop makes outages worse by amplifying load on a failing service. |
| Thundering herd | When many clients retry simultaneously, they create a load spike that prevents recovery. |
| Exponential backoff | Each retry waits longer than the previous one (e.g., 200ms, 400ms, 800ms), giving the service time to recover. |
| Full jitter | Adding randomness to the backoff delay spreads retries over time, preventing synchronized spikes. |
| maxDelayMs cap | An upper bound on the backoff delay so a single request does not wait absurdly long. |
| Non-retryable errors | Client errors (4xx except 429) and business logic errors should never be retried — they will fail the same way every time. |
| Retryable errors | Infrastructure errors (ECONNRESET, ETIMEDOUT, 503) and rate-limit errors (429) are transient and worth retrying. |
| Retry budget | A system-wide cap on the ratio of retries to original requests, preventing retry amplification during widespread failures. |
| Layered resilience | Rate limiting, circuit breakers, and retries with backoff work together as complementary layers, each solving a different failure mode. |
