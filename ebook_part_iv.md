# PART IV: RESILIENCE & RELIABILITY

Modern distributed systems do not fail cleanly. They degrade. A payment gateway starts responding in 12 seconds instead of 200 milliseconds. A supplier API returns HTTP 503 for 40% of requests while the other 60% succeed. A Redis node runs out of memory and silently drops cache entries. A database replica falls 30 seconds behind the primary. These are not hypothetical scenarios -- they are Tuesday afternoon in a system processing 1,666 bookings per second across multiple continents. This part teaches you how to build a system that survives these failures without losing bookings, corrupting data, or waking up the on-call engineer at 3 AM.

Part III prevented data corruption -- ensuring that concurrent writes, distributed transactions, and cross-shard operations maintain consistency even under contention. This part prevents cascading failures, thundering herds, and cache stampedes. Where Part III asked "is the data correct?", Part IV asks "is the system still standing?" The patterns here -- circuit breakers, bulkheads, rate limiters, retry budgets, cache stampede prevention, dead letter queues, and read/write splitting -- form the defensive armor of a production system. Each pattern addresses a specific failure mode, and together they create layers of protection that keep the booking pipeline operational even when individual components are struggling.

You will notice a recurring theme: every pattern in this part exists because the naive approach causes more harm than the original failure. Retrying without backoff creates thundering herds. Caching without stampede prevention turns a cache miss into a database avalanche. Processing without dead letter queues means lost bookings. Reading without replica lag detection means stale data and overbooking. The "why" matters as much as the "how" -- understanding the failure mode is the only way to understand why the solution is shaped the way it is.

---

## 17. Circuit Breaker & Bulkhead Patterns

> **Learning Objectives**
>
> - Understand how a single slow downstream dependency can cascade into a system-wide outage
> - Describe the three states of a circuit breaker (CLOSED, OPEN, HALF_OPEN) and the transitions between them
> - Implement a circuit breaker with a correct fallback signature using the opossum library
> - Explain why bulkheads isolate failure domains and how they complement circuit breakers
> - Configure separate resource pools per downstream service to prevent resource starvation

**Why:** In a globally distributed booking system that fans out requests to dozens of downstream supplier APIs, payment gateways, and inventory services, any single downstream failure can cascade upward. Without isolation, a slow or unresponsive supplier can exhaust thread pools, saturate connection limits, and bring down the entire booking pipeline. Circuit breakers detect failure thresholds and short-circuit requests before they pile up. Bulkheads isolate failure domains so that one misbehaving dependency cannot consume all available resources and starve healthy services.

### Circuit Breaker with Opossum

The circuit breaker transitions through three states:

1. **CLOSED** -- Normal operation. Requests pass through. Failures are counted.
2. **OPEN** -- Failure threshold exceeded. All requests are immediately rejected or routed to a fallback. A timer begins.
3. **HALF_OPEN** -- After the reset timeout, a single probe request is allowed through. If it succeeds the breaker closes; if it fails the breaker reopens.

```
                    success
            ┌──────────────────┐
            │                  │
            ▼                  │
     ┌────────────┐    ┌──────────────┐
     │   CLOSED   │───▶│    OPEN      │
     └────────────┘    └──────────────┘
            ▲           failure threshold    │
            │           exceeded             │
            │                                │
            │          reset timeout         │
            │          expires               ▼
            │                         ┌──────────────┐
            └─────────────────────────│  HALF_OPEN   │
                  probe succeeds      └──────────────┘
                                           │
                                           │ probe fails
                                           └──▶ back to OPEN
```

```typescript
// Circuit Breaker with corrected fallback
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

    // Fallback receives the SAME arguments as the original function, plus the error
    this.circuitBreaker.fallback(this.handleFallback.bind(this));

    this.circuitBreaker.on('open', () => {
      console.error(`Circuit breaker OPEN for ${this.supplierName}`);
      metrics.circuitBreakerState.set({ supplier: this.supplierName, state: 'open' }, 1);
    });

    this.circuitBreaker.on('halfOpen', () => {
      console.warn(`Circuit breaker HALF-OPEN for ${this.supplierName}`);
    });

    this.circuitBreaker.on('close', () => {
      console.log(`Circuit breaker CLOSED for ${this.supplierName}`);
      metrics.circuitBreakerState.set({ supplier: this.supplierName, state: 'closed' }, 1);
    });
  }

  async bookRoom(params: BookRoomParams): Promise<BookingResult> {
    return await this.circuitBreaker.fire(params);
  }

  private async callSupplierAPI(params: BookRoomParams): Promise<BookingResult> {
    const response = await axios.post(
      `${this.getSupplierEndpoint()}/book`,
      params,
      { timeout: 5000 }
    );
    return response.data;
  }

  // FIXED: params is now properly received from opossum's fallback chain
  private handleFallback(params: BookRoomParams, error: Error): BookingResult {
    console.error(`Fallback triggered for ${this.supplierName}:`, error.message);
    return {
      status: 'pending',
      message: 'Supplier temporarily unavailable. Request queued.',
      queueId: this.queueRequest(params)  // params is now in scope
    };
  }

  private queueRequest(params: BookRoomParams): string {
    const queueId = generateUUID();
    // Push to a persistent queue (e.g., SQS, RabbitMQ) for later processing
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

> **Common Mistake: Undeclared `params` in Fallback**
>
> An earlier version declared `handleFallback(error: Error)` but referenced `this.queueRequest(params)` inside the method body -- `params` was never in scope. In opossum, the fallback function receives the **same arguments** as the protected function, followed by the error as the final argument. The correct signature is `handleFallback(params: BookRoomParams, error: Error)`. If your protected function accepted multiple arguments, all of them would appear before the error in the fallback signature. Failing to account for this causes a `ReferenceError` at runtime -- exactly when you need the fallback to work most.

### Bulkhead Pattern

**Why:** Even with circuit breakers, a single service consuming all available connections or threads can starve other healthy services. The bulkhead pattern partitions resources into isolated pools -- just as bulkheads in a ship prevent a single hull breach from sinking the entire vessel.

```typescript
// Bulkhead: Separate connection pools per downstream service
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
    queue: Array<{ resolve: Function; reject: Function; fn: Function }>;
    maxQueueSize: number;
  }>();

  register(serviceName: string, maxConcurrent: number, maxQueueSize: number = 100) {
    this.pools.set(serviceName, {
      maxConcurrent,
      currentActive: 0,
      queue: [],
      maxQueueSize
    });
  }

  async execute<T>(serviceName: string, fn: () => Promise<T>): Promise<T> {
    const pool = this.pools.get(serviceName);
    if (!pool) throw new Error(`No bulkhead registered for ${serviceName}`);

    if (pool.currentActive >= pool.maxConcurrent) {
      if (pool.queue.length >= pool.maxQueueSize) {
        throw new BulkheadRejectError(`Bulkhead full for ${serviceName}`);
      }

      return new Promise((resolve, reject) => {
        pool.queue.push({ resolve, reject, fn });
      });
    }

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

    fn().then(resolve).catch(reject).finally(() => {
      pool.currentActive--;
      this.processQueue(serviceName);
    });
  }
}

// Usage: each downstream service has its own isolated pool
const bulkhead = new BulkheadManager();
bulkhead.register('payment-service', 50, 200);    // Max 50 concurrent, 200 queued
bulkhead.register('inventory-service', 100, 500);  // Max 100 concurrent, 500 queued
bulkhead.register('supplier-api', 20, 50);          // Max 20 concurrent, 50 queued

// Wrapping a call with bulkhead isolation
async function chargePayment(paymentData: PaymentData): Promise<PaymentResult> {
  return bulkhead.execute('payment-service', async () => {
    return paymentGateway.charge(paymentData);
  });
}
```

### Key Takeaways

- A circuit breaker protects your system from wasting resources on calls that are likely to fail. It transitions through CLOSED, OPEN, and HALF_OPEN states based on failure thresholds, and the `volumeThreshold` setting prevents the breaker from tripping on a small number of initial requests.
- The fallback function in opossum receives the same arguments as the protected function, followed by the error. Getting this signature wrong causes a `ReferenceError` at the exact moment you need the fallback to work -- under failure conditions.
- The bulkhead pattern complements circuit breakers by isolating resource pools per downstream service, so that a misbehaving dependency cannot starve healthy services of connections or threads.
- Circuit breakers and bulkheads work at different granularities: circuit breakers protect individual call paths, while bulkheads protect shared resources (connection pools, thread pools) across all call paths to a given service.
- Always emit metrics on circuit breaker state transitions (open, halfOpen, close) so dashboards and alerts can track which suppliers are degraded.

### Review Questions

1. **Conceptual:** Why does the circuit breaker require a `volumeThreshold` of 10 before evaluating the error percentage? What would happen if it evaluated the error rate after only 1 or 2 requests?

2. **Code Reading:** In the `BulkheadManager.execute` method, what happens when `pool.currentActive >= pool.maxConcurrent` and `pool.queue.length >= pool.maxQueueSize`? Trace the behavior from the caller's perspective and explain why this is preferable to unbounded queuing.

3. **Conceptual:** The circuit breaker's HALF_OPEN state allows a single probe request through. Why only one? What failure scenario would occur if HALF_OPEN allowed all pending requests through simultaneously?

### Hands-On Exercise

**Build a Combined Circuit Breaker + Bulkhead Wrapper**

Create a `ResilientServiceCaller` class that wraps a downstream service call with both a circuit breaker and a bulkhead. The class should:

1. Accept a service name, max concurrency, and circuit breaker options in the constructor.
2. Expose an `execute<T>(fn: () => Promise<T>): Promise<T>` method that first checks the bulkhead for available capacity, then routes through the circuit breaker.
3. Include a fallback that returns a default value (passed in the constructor) when both the primary call and the bulkhead are exhausted.
4. Emit console logs for each state transition and each bulkhead rejection.

Test it by simulating a downstream service that fails 60% of the time and observe the circuit breaker opening, the bulkhead rejecting excess concurrent calls, and the fallback activating.

---

## 18. Rate Limiting

> **Learning Objectives**
>
> - Explain why rate limiting is essential for protecting a globally distributed booking system from abuse and overload
> - Compare the sliding window counter and token bucket algorithms and identify when each is appropriate
> - Read and understand Redis Lua scripts that implement atomic rate limiting logic
> - Configure tiered rate limits based on user roles (guest, user, premium, admin)
> - Implement rate limit middleware that sets standard HTTP headers for client self-regulation

**Why:** Protect backend services from traffic spikes, bot attacks, and abusive clients. A global booking system is an attractive target for scrapers, price-monitoring bots, and denial-of-service attacks. Rate limiting ensures fair resource allocation across tenants, prevents any single user or IP from monopolizing capacity, and provides a safety net against runaway internal services. Without it, a misbehaving client can exhaust database connections, degrade search latency for everyone, and inflate infrastructure costs.

### Sliding Window Counter Algorithm

The sliding window counter provides a smoother rate limiting experience than fixed windows by avoiding the "boundary burst" problem where a client can send 2x the limit by timing requests at the boundary of two fixed windows.

```typescript
// Sliding Window Counter (Redis Lua Script)
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  windowSeconds: number;
}

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
      -- Add new entry
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

### Token Bucket Algorithm

**Why:** The token bucket complements the sliding window by allowing controlled bursts. A client can accumulate tokens over idle periods and spend them in a burst, which is useful for legitimate use cases like a travel agent submitting a batch of bookings.

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

    -- Refill tokens
    local elapsed = now - last_refill
    tokens = math.min(capacity, tokens + (elapsed * refill_rate))

    if tokens >= requested then
      tokens = tokens - requested
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {1, tokens}
    else
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {0, tokens}
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

### Rate Limit Tiers

Different user roles receive different rate limits. Guests see the most restrictive limits, while admin accounts used for operational tooling receive generous allowances.

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

### Rate Limit Middleware

```typescript
export class RateLimitMiddleware {
  private readonly limiter = new SlidingWindowRateLimiter();

  async handle(req: Request, res: Response, next: NextFunction) {
    const userRole = req.user?.role || 'guest';
    const endpoint = this.categorizeEndpoint(req.path);
    const tier = rateLimitTiers[userRole]?.[endpoint] || rateLimitTiers[userRole]?.general;

    if (!tier) return next();

    const key = `ratelimit:${userRole}:${req.user?.id || req.ip}:${endpoint}`;
    const result = await this.limiter.checkRateLimit({ key, ...tier });

    // Always set rate limit headers so clients can self-regulate
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
    if (path.includes('/bookings') && path === '/api/v1/bookings') return 'booking';
    return 'general';
  }
}
```

### Key Takeaways

- The sliding window counter avoids the "boundary burst" problem of fixed windows by using a Redis sorted set and removing expired entries before counting. This ensures a client cannot send 2x the limit by timing requests at a window boundary.
- The token bucket algorithm complements the sliding window by allowing controlled bursts -- useful for legitimate batch operations like a travel agent submitting multiple bookings. It refills tokens at a steady rate, letting idle clients accumulate burst capacity.
- Both algorithms use Redis Lua scripts for atomicity. Without atomic execution, a race condition between the "check count" and "increment count" steps would allow clients to exceed their limits under concurrent requests.
- Tiered rate limits ensure that guests, regular users, premium users, and admins each receive appropriate allowances. The middleware always sets `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers so well-behaved clients can self-regulate before hitting the limit.

### Review Questions

1. **Conceptual:** Explain the "boundary burst" problem with fixed-window rate limiting. How does the sliding window counter solve it, and what is the trade-off in terms of Redis memory usage?

2. **Code Reading:** In the sliding window Lua script, the line `redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))` appends a random number to the member value. Why is this random suffix necessary? What would happen if the member value were just `now`?

3. **Conceptual:** The `rateLimitTiers` configuration gives guests 30 search requests per minute but does not define a `booking` tier for guests. Looking at the middleware code, what happens when an unauthenticated guest attempts to hit a booking endpoint? Which tier is applied?

### Hands-On Exercise

**Implement a Dual-Algorithm Rate Limiter**

Build a rate limiter that uses the sliding window counter for the `/search` endpoint and the token bucket for the `/bookings` endpoint. Your implementation should:

1. Create an Express middleware that selects the algorithm based on the request path.
2. For `/search`, enforce a strict 100-requests-per-minute limit with no burst allowance.
3. For `/bookings`, use a token bucket with capacity 10, refill rate of 1 token per 6 seconds, allowing a burst of up to 5 bookings at once.
4. Return proper `429` responses with `Retry-After` headers and log each rejection with the client IP and endpoint.

Verify your implementation by writing a test script that sends 15 booking requests in rapid succession and confirms that only the first 10 succeed (the bucket's capacity), the next 5 are rejected, and after waiting 30 seconds, 5 more tokens have accumulated.

---

## 19. Retry & Backoff Strategies

> **Learning Objectives**
>
> - Explain why naive retries (immediate, unbounded) amplify failures in distributed systems rather than recovering from them
> - Implement exponential backoff with full jitter and understand why jitter prevents the thundering herd problem
> - Distinguish between retryable errors (transient network issues, 503, 429) and non-retryable errors (business logic failures, 4xx client errors)
> - Design a retry budget that caps the system-wide ratio of retries to original requests
> - Combine retry logic with a budget so that the system fails fast when retries would cause more harm than good

**Why:** Transient failures are normal in distributed systems. Network partitions heal, overloaded services recover, and cloud provider control planes experience brief hiccups. Smart retry with exponential backoff and jitter prevents the "thundering herd" problem -- where all clients retry simultaneously and re-overload a recovering service -- while still recovering from temporary errors. However, retries must be bounded; unbounded retries amplify load on a failing system and can turn a partial outage into a total one.

### Exponential Backoff with Full Jitter

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
      retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '503', '429'],
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
        // Full jitter: uniform random between 0 and the exponential cap
        const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
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

    // Never retry business logic errors -- these will not succeed on retry
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

### Retry Budget

**Why:** Individual retry policies are not enough. If every caller retries 3 times, a service receiving 1,000 requests/second under partial failure could see 3,000 retry requests/second on top of the original traffic. A retry budget caps the total ratio of retries to original requests across the entire system, preventing retry amplification.

```typescript
export class RetryBudget {
  private windowMs: number;
  private maxRetryRatio: number;
  private requests: number[] = [];
  private retries: number[] = [];

  constructor(windowMs: number = 60000, maxRetryRatio: number = 0.1) {
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

### Combining Retry with Budget

```typescript
// Usage: retry only if the budget allows
const retryService = new RetryService();
const retryBudget = new RetryBudget(60000, 0.1); // Max 10% retries in 60s

async function bookWithRetry(params: BookRoomParams): Promise<BookingResult> {
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
          `Retry attempt ${attempt} after ${delay.toFixed(0)}ms: ${error.message}`
        );
      }
    }
  );
}
```

### Key Takeaways

- Exponential backoff with full jitter spreads retries uniformly across the delay window (`0` to `min(maxDelay, baseDelay * 2^attempt)`), preventing the thundering herd problem where all clients retry at the same instant and re-overload a recovering service.
- Not all errors are retryable. Business logic failures (`InsufficientInventoryError`, `FraudBlockedError`, `PaymentDeclinedError`) and most 4xx HTTP errors will never succeed on retry -- retrying them wastes resources and delays the error response to the user.
- A retry budget caps the system-wide retry ratio (e.g., 10% of total requests in a 60-second window). Without it, every caller independently retrying 3 times can turn 1,000 requests/second into 4,000 requests/second under partial failure -- exactly when the downstream can least afford it.
- The `onRetry` callback is the integration point between the retry service and the retry budget. By checking `canRetry()` inside `onRetry`, the system fails fast when the budget is exhausted rather than piling on more retries.
- Always log retry attempts with the attempt number, delay, and error message. These logs are essential for diagnosing whether retries are helping (transient errors recovering) or hurting (budget exhaustion under sustained failure).

### Review Questions

1. **Conceptual:** What is the difference between "full jitter" and "equal jitter" in exponential backoff? Why does this codebase use full jitter (`Math.random() * exponentialDelay`) rather than equal jitter (`exponentialDelay / 2 + Math.random() * exponentialDelay / 2`)?

2. **Code Reading:** In the `isRetryable` method, HTTP 429 (Too Many Requests) is explicitly allowed as retryable even though it is a 4xx status code. Why does this make sense? What would happen if 429 were treated as a non-retryable client error?

3. **Conceptual:** The `RetryBudget` uses an array of timestamps and filters out entries older than `windowMs`. What is the memory implication of this approach under 1,000 requests/second? How would you redesign the budget to use constant memory?

### Hands-On Exercise

**Simulate Retry Amplification and Budget Protection**

Write a simulation that demonstrates retry amplification and how a retry budget mitigates it:

1. Create a mock downstream service that fails 70% of requests for 30 seconds, then recovers.
2. Simulate 100 concurrent callers, each making 1 request per second, with `maxRetries: 3` and `baseDelayMs: 200`.
3. First, run the simulation without a retry budget and log the total number of requests hitting the downstream per second (original + retries). Observe how the load spikes to 3-4x during the failure window.
4. Then, run the same simulation with a `RetryBudget(60000, 0.1)` and observe how the total downstream load is capped at approximately 1.1x.
5. Print a summary comparing the two runs: total requests sent, total failures seen by callers, and time to recovery after the downstream heals.

---

## 20. Cache Strategy & Invalidation

> **Learning Objectives**
>
> - Explain why caching is critical for a booking system handling 3,888 read queries/second and how stale cache data leads to overbooking
> - Implement cache-aside with distributed lock-based stampede prevention and probabilistic early expiry
> - Understand why cache invalidation uses SCAN (never KEYS) to avoid blocking Redis in production
> - Design event-driven cache invalidation via Kafka to purge stale entries as soon as the source of truth changes
> - Configure TTL strategies that reflect the volatility of different data types (flight prices vs. country codes)

**Why:** Caching reduces database load and improves response times. At 1,666 bookings/second with a 70/30 read/write ratio, the read path generates approximately 3,888 queries/second. Without caching, every search, availability check, and profile lookup hits the database directly. A well-designed caching layer handles the majority of these reads without touching the database, reducing p99 latency from hundreds of milliseconds to single-digit milliseconds. However, caching introduces a consistency challenge: stale data can lead to overbooking, incorrect pricing, or phantom inventory. The strategies below balance freshness with performance.

### Cache-Aside with Stampede Prevention

```typescript
interface CacheOptions {
  earlyExpiry?: boolean;
  preventStampede?: boolean;
}

export class CacheService {
  private readonly defaultTTL = 3600; // 1 hour

  // Cache-aside: read from cache, fallback to DB
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number = this.defaultTTL,
    options: CacheOptions = {}
  ): Promise<T> {
    // Try cache first
    const cached = await redis.get(`cache:${key}`);

    if (cached) {
      const parsed = JSON.parse(cached);

      // Probabilistic early expiry to prevent stampede
      if (options.earlyExpiry) {
        const ttl = await redis.ttl(`cache:${key}`);
        const expiryWindow = ttlSeconds * 0.1; // 10% of TTL
        if (ttl < expiryWindow && Math.random() < 0.1) {
          // 10% chance to refresh early -- prevents all instances refreshing at once
          this.refreshInBackground(key, fetchFn, ttlSeconds);
        }
      }

      return parsed;
    }

    // Prevent cache stampede with distributed lock
    if (options.preventStampede) {
      return await this.fetchWithLock(key, fetchFn, ttlSeconds);
    }

    // Standard cache miss: fetch and store
    const value = await fetchFn();
    await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
    return value;
  }

  private async fetchWithLock<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    const lockKey = `cache:lock:${key}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

    if (!acquired) {
      // Another instance is refreshing -- wait briefly and retry from cache
      await new Promise(resolve => setTimeout(resolve, 100));
      const cached = await redis.get(`cache:${key}`);
      if (cached) return JSON.parse(cached);
      return await fetchFn();  // Give up waiting, fetch directly
    }

    try {
      const value = await fetchFn();
      await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
      return value;
    } finally {
      await redis.del(lockKey);
    }
  }

  // Event-driven invalidation (uses SCAN, never KEYS, to avoid blocking Redis)
  async invalidate(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `cache:${pattern}`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  private refreshInBackground<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): void {
    fetchFn().then(value => {
      redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
    }).catch(err => {
      console.warn(`Background cache refresh failed for ${key}:`, err.message);
    });
  }
}
```

### Event-Driven Cache Invalidation via Kafka

**Why:** Time-based TTL expiry alone is insufficient for a booking system. When inventory is reserved or a price changes, stale cache entries can cause overbooking or display incorrect prices. Event-driven invalidation ensures caches are purged as soon as the source of truth changes.

```typescript
// Kafka consumer for cache invalidation
export class CacheInvalidationConsumer {
  async start(): Promise<void> {
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events'],
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'inventory.updated':
          case 'inventory.reserved':
            await cacheService.invalidate(`inventory:${event.payload.resourceId}:*`);
            await cacheService.invalidate(`search:*`);  // Invalidate search cache
            break;

          case 'booking.created':
          case 'booking.cancelled':
            await cacheService.invalidate(`booking:${event.payload.bookingId}`);
            await cacheService.invalidate(`user:${event.payload.userId}:bookings`);
            break;

          case 'price.updated':
            await cacheService.invalidate(`pricing:${event.payload.resourceId}:*`);
            break;
        }
      }
    });
  }
}
```

### Cache TTL Strategy

Different data types have different volatility. Flight prices change by the minute; country codes change once a year. TTLs must reflect this reality.

```typescript
export const cacheTTLStrategy = {
  search: {
    hotelSearch: 300,        // 5 minutes -- changes frequently
    flightSearch: 120,       // 2 minutes -- very dynamic pricing
    carSearch: 600           // 10 minutes -- less volatile
  },
  inventory: {
    availability: 30,        // 30 seconds -- near real-time
    pricing: 300,            // 5 minutes
    hotelDetails: 3600       // 1 hour -- rarely changes
  },
  user: {
    profile: 1800,           // 30 minutes
    bookingHistory: 600,     // 10 minutes
    preferences: 3600        // 1 hour
  },
  static: {
    currencies: 86400,       // 24 hours
    countries: 86400,        // 24 hours
    bookingTypes: 86400      // 24 hours
  }
};
```

### Key Takeaways

- Cache-aside with stampede prevention uses a distributed lock (`SET lockKey '1' EX 5 NX`) so that only one instance fetches from the database on a cache miss. Without this, hundreds of concurrent requests for the same expired key would all hit the database simultaneously -- a cache stampede.
- Probabilistic early expiry (10% chance to refresh when TTL is within 10% of expiration) spreads cache refreshes over time, preventing the "cliff edge" where all cached entries expire at the same instant and flood the database.
- The `invalidate` method uses `SCAN` with `COUNT 100` instead of `KEYS` to find matching cache entries. `KEYS` blocks the entire Redis instance for the duration of the scan, which can cause multi-second pauses in production. `SCAN` is cursor-based and non-blocking.
- Event-driven invalidation via Kafka ensures caches are purged within seconds of the source of truth changing. This is essential for inventory and pricing data where stale cache entries directly cause overbooking or incorrect prices.
- TTL values must reflect data volatility: 30 seconds for availability (near real-time), 2 minutes for flight prices (dynamic), and 24 hours for static reference data (currencies, countries).

### Review Questions

1. **Conceptual:** The `fetchWithLock` method waits 100ms and retries from cache if the lock is not acquired. What happens if the instance holding the lock crashes before releasing it? How does the `EX 5` parameter on the lock mitigate this?

2. **Code Reading:** In the `invalidate` method, the SCAN loop uses `'COUNT', 100`. This does not mean exactly 100 keys are returned per iteration. What does `COUNT` actually control in Redis SCAN, and why is 100 a reasonable value for a production system?

3. **Conceptual:** The `CacheInvalidationConsumer` invalidates `search:*` whenever inventory changes. This is a broad invalidation that purges all cached search results. What is the trade-off here? How would you design a more targeted invalidation strategy for search results?

### Hands-On Exercise

**Build a Cache Stampede Detector**

Create a monitoring tool that detects cache stampedes in real time:

1. Instrument the `CacheService.getOrSet` method to emit a metric every time a cache miss occurs, tagged with the cache key prefix (e.g., `inventory`, `search`, `user`).
2. Build a `StampedeDetector` class that tracks the rate of cache misses per key prefix over a 5-second sliding window.
3. If more than 50 cache misses occur for the same key prefix within 5 seconds, log a warning: `"Potential cache stampede detected for prefix: {prefix}, miss rate: {rate}/s"`.
4. Test it by simulating 200 concurrent requests for the same uncached key (with stampede prevention disabled) and verify the detector fires. Then enable stampede prevention and verify the detector stays silent.

---

## 21. Dead Letter Queue Handling

> **Learning Objectives**
>
> - Explain why dead letter queues are the safety net that prevents failed messages (bookings, payments) from silently disappearing
> - Design a retry topic chain with graduated delays (1s, 10s, 1min, 5min, 1hr) that avoids hammering a struggling downstream
> - Trace the lifecycle of a failed message from the main topic through retry levels to the DLQ
> - Implement DLQ inspection and selective replay so operations teams can recover failed messages after fixing the root cause
> - Understand why DLQ messages are not garbage -- they represent real user actions that require human attention

**Why:** Not all messages can be processed successfully. Network glitches, data format issues, unexpected payloads, or downstream failures can cause message processing to fail even after multiple retries. Without a Dead Letter Queue (DLQ), failed messages are lost forever or block the main processing pipeline. DLQs capture these failed messages in a separate topic for later investigation, alerting, and selective reprocessing. They are the "safety net" that ensures no booking request, payment confirmation, or inventory update silently disappears.

### Retry Topic Chain with Graduated Delays

Rather than retrying immediately (which hammers an already-struggling downstream), each retry level introduces a longer delay. After all retry levels are exhausted, the message moves to the DLQ.

```
  Main Topic
      │
      ▼ (failure)
  retry-1  (1 second delay)
      │
      ▼ (failure)
  retry-2  (10 second delay)
      │
      ▼ (failure)
  retry-3  (1 minute delay)
      │
      ▼ (failure)
  retry-4  (5 minute delay)
      │
      ▼ (failure)
  retry-5  (1 hour delay -- final retry)
      │
      ▼ (failure)
  dlq-{topic}  (dead letter queue)
```

```typescript
export class RetryTopicChain {
  private readonly retryTopics = [
    { topic: 'retry-1', delayMs: 1000 },      // 1 second
    { topic: 'retry-2', delayMs: 10000 },     // 10 seconds
    { topic: 'retry-3', delayMs: 60000 },     // 1 minute
    { topic: 'retry-4', delayMs: 300000 },    // 5 minutes
    { topic: 'retry-5', delayMs: 3600000 }    // 1 hour (final retry)
  ];

  async handleFailedMessage(
    originalTopic: string,
    message: any,
    error: Error,
    retryCount: number = 0
  ): Promise<void> {
    if (retryCount >= this.retryTopics.length) {
      // All retries exhausted -- send to DLQ
      await this.sendToDLQ(originalTopic, message, error, retryCount);
      return;
    }

    const retryConfig = this.retryTopics[retryCount];

    await kafka.send({
      topic: retryConfig.topic,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          originalTopic,
          originalMessage: message,
          retryCount: retryCount + 1,
          error: { message: error.message, stack: error.stack },
          scheduledFor: Date.now() + retryConfig.delayMs,
          firstFailedAt: message.firstFailedAt || new Date().toISOString()
        }),
        headers: {
          'retry-count': (retryCount + 1).toString(),
          'original-topic': originalTopic,
          'error-type': error.constructor.name
        }
      }]
    });

    metrics.messageRetries.inc({
      topic: originalTopic,
      retry_level: retryCount + 1
    });
  }

  private async sendToDLQ(
    originalTopic: string,
    message: any,
    error: Error,
    retryCount: number
  ): Promise<void> {
    await kafka.send({
      topic: `dlq-${originalTopic}`,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          originalTopic,
          originalMessage: message,
          totalRetries: retryCount,
          error: { message: error.message, stack: error.stack },
          firstFailedAt: message.firstFailedAt,
          sentToDLQAt: new Date().toISOString()
        })
      }]
    });

    metrics.dlqMessages.inc({ topic: originalTopic });

    // Alert if DLQ grows too large
    console.error(`Message sent to DLQ for topic ${originalTopic}`, {
      error: error.message,
      retries: retryCount
    });
  }
}
```

### DLQ Consumer: Inspection and Replay

**Why:** Messages in the DLQ are not garbage -- they represent real user actions (bookings, payments) that failed. Operations teams need to inspect these messages, understand why they failed, and selectively replay them once the root cause is fixed.

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
  async inspectDLQ(topic: string, limit: number = 100): Promise<DLQMessage[]> {
    const consumer = kafka.consumer({ groupId: `dlq-inspector-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: `dlq-${topic}`, fromBeginning: true });

    const messages: DLQMessage[] = [];

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (messages.length >= limit) return;
        messages.push(JSON.parse(message.value.toString()));
      }
    });

    // Wait briefly for messages to arrive then disconnect
    await new Promise(resolve => setTimeout(resolve, 2000));
    await consumer.disconnect();

    return messages;
  }

  async replayMessage(dlqMessage: DLQMessage): Promise<void> {
    await kafka.send({
      topic: dlqMessage.originalTopic,
      messages: [{
        key: dlqMessage.originalMessage.key,
        value: JSON.stringify(dlqMessage.originalMessage),
        headers: {
          'replayed-from-dlq': 'true',
          'original-error': dlqMessage.error.message
        }
      }]
    });
  }

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

### Key Takeaways

- A retry topic chain with graduated delays (1s, 10s, 1min, 5min, 1hr) gives the downstream service progressively more time to recover between attempts, avoiding the pile-on effect of immediate retries that hammer an already-struggling service.
- Each retry message preserves the full context: the original topic, the original message payload, the retry count, the error details, and the timestamp of the first failure. This metadata is essential for debugging and for the DLQ consumer to understand what went wrong.
- The DLQ is not a graveyard -- it is a staging area for human review. Messages in the DLQ represent real user actions (bookings, payments, inventory updates) that failed after all retry attempts. The `replayMessage` method allows operations teams to selectively reprocess messages after the root cause is fixed.
- The `replayAll` method should be used with caution. Replaying thousands of messages at once can re-overload a recently recovered service. In practice, replay should be throttled and monitored.
- Alerting on DLQ growth is critical. A steadily growing DLQ indicates that the root cause has not been resolved and that real user requests are accumulating unprocessed.

### Review Questions

1. **Conceptual:** Why does the retry topic chain use separate Kafka topics (`retry-1`, `retry-2`, ...) instead of re-publishing to the original topic with a delay header? What advantage does the separate-topic approach provide for monitoring and operations?

2. **Code Reading:** In the `inspectDLQ` method, a new consumer group is created with `groupId: dlq-inspector-${Date.now()}`. Why does each inspection call create a unique consumer group? What would happen if a fixed group ID like `dlq-inspector` were used instead?

3. **Conceptual:** The `replayMessage` method adds a `'replayed-from-dlq': 'true'` header to replayed messages. How should the original consumer use this header? What safeguards should be in place to prevent a replayed message from entering an infinite retry-DLQ-replay loop?

### Hands-On Exercise

**Build a DLQ Dashboard**

Create a command-line dashboard that provides operational visibility into your dead letter queues:

1. Write a `DLQDashboard` class that periodically (every 10 seconds) calls `inspectDLQ` for a list of monitored topics (e.g., `booking-events`, `inventory-events`, `payment-events`).
2. For each topic, display: the total number of messages in the DLQ, a breakdown of error types (grouped by `error.message`), the oldest `firstFailedAt` timestamp, and the most recent `sentToDLQAt` timestamp.
3. Add a `replayByErrorType` method that replays only messages matching a specific error pattern (e.g., replay all messages that failed with `"ECONNREFUSED"` but leave messages that failed with `"ValidationError"` in the DLQ).
4. Test it by producing 20 messages to a DLQ topic -- 10 with a network error and 10 with a validation error -- and verify that `replayByErrorType('ECONNREFUSED')` replays exactly 10 messages.

---

## 22. Database Read/Write Splitting

> **Learning Objectives**
>
> - Explain why read/write splitting is necessary for a system with 1 primary + 4 read replicas per shard
> - Implement connection routing that directs writes to the primary and reads to healthy replicas using round-robin selection
> - Understand how replication lag detection prevents stale reads from lagging replicas and when to fall back to the primary
> - Design a two-level routing hierarchy: shard router (data locality by user ID) above read/write splitter (query type routing)
> - Implement scatter-gather for cross-shard queries used in admin reporting

**Why:** With 1 primary + 4 read replicas per shard, directing read queries to replicas distributes load across multiple database nodes. The primary handles only writes and critical reads that require the absolute latest data (e.g., checking inventory before confirming a booking). Read replicas handle the bulk of traffic: search results, booking history, user profiles, and reporting queries. This architecture allows the system to scale read capacity horizontally by adding replicas, while the primary remains focused on maintaining write consistency. Replication lag detection ensures that stale replicas are automatically bypassed.

### Connection Routing Based on Query Type

```typescript
interface QueryOptions {
  requirePrimary?: boolean;
  maxLagSeconds?: number;
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
  private currentReplicaIndex = 0;

  constructor(shardConfig: ShardConfig) {
    this.primaryPool = createPool({
      host: shardConfig.primaryHost,
      port: 3306,
      connectionLimit: shardConfig.primaryPoolSize || 200
    });

    this.replicaPools = shardConfig.replicaHosts.map(host =>
      createPool({
        host,
        port: 3306,
        connectionLimit: shardConfig.replicaPoolSize || 500
      })
    );
  }

  async query(sql: string, params: any[], options: QueryOptions = {}): Promise<any> {
    const isWrite = this.isWriteQuery(sql);

    if (isWrite || options.requirePrimary) {
      return this.primaryPool.execute(sql, params);
    }

    // Check replication lag before using replica
    const replica = await this.getHealthyReplica(options.maxLagSeconds || 5);

    if (!replica) {
      // All replicas have excessive lag -- fall back to primary
      console.warn('All replicas lagging, falling back to primary for read');
      return this.primaryPool.execute(sql, params);
    }

    return replica.execute(sql, params);
  }

  private isWriteQuery(sql: string): boolean {
    const writePatterns = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)/i;
    return writePatterns.test(sql);
  }

  private async getHealthyReplica(maxLagSeconds: number): Promise<ConnectionPool | null> {
    // Round-robin through replicas, skipping unhealthy ones
    for (let i = 0; i < this.replicaPools.length; i++) {
      const index = (this.currentReplicaIndex + i) % this.replicaPools.length;
      const pool = this.replicaPools[index];

      try {
        const [rows] = await pool.execute('SHOW SLAVE STATUS');
        const lag = rows[0]?.Seconds_Behind_Master;

        if (lag !== null && lag <= maxLagSeconds) {
          this.currentReplicaIndex = (index + 1) % this.replicaPools.length;
          return pool;
        }
      } catch (error) {
        // Replica unreachable, try next
        continue;
      }
    }

    return null;
  }

  // For operations that need read-after-write consistency
  async queryAfterWrite(sql: string, params: any[]): Promise<any> {
    return this.query(sql, params, { requirePrimary: true });
  }
}
```

### Shard Router

**Why:** The shard router sits above the read/write splitter and directs queries to the correct shard based on user ID. Combined with read/write splitting within each shard, this creates a two-level routing hierarchy: first by shard (data locality), then by query type (read vs. write).

```typescript
export class ShardRouter {
  private shards: Map<number, ReadWriteSplitter> = new Map();

  constructor(shardConfigs: ShardConfig[]) {
    for (const config of shardConfigs) {
      this.shards.set(config.shardNumber, new ReadWriteSplitter(config));
    }
  }

  getShardForUser(userId: bigint): ReadWriteSplitter {
    const shardNumber = Number(userId % 16n);
    const shard = this.shards.get(shardNumber);
    if (!shard) throw new Error(`Shard ${shardNumber} not configured`);
    return shard;
  }

  async queryForUser(
    userId: bigint,
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<any> {
    const shard = this.getShardForUser(userId);
    return shard.query(sql, params, options);
  }

  // Scatter-gather for cross-shard queries (e.g., admin reports)
  async queryAllShards(
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<Map<number, any>> {
    const results = new Map<number, any>();

    await Promise.all(
      Array.from(this.shards.entries()).map(async ([shardNum, splitter]) => {
        const result = await splitter.query(sql, params, options);
        results.set(shardNum, result);
      })
    );

    return results;
  }
}
```

### Key Takeaways

- Read/write splitting directs the bulk of read traffic (search results, booking history, user profiles) to replicas, keeping the primary focused on writes and critical reads that require the absolute latest data. This is essential for horizontal read scalability.
- Replication lag detection (`SHOW SLAVE STATUS` and `Seconds_Behind_Master`) prevents the system from serving stale data from a lagging replica. When all replicas exceed the lag threshold, the splitter falls back to the primary -- accepting higher primary load rather than returning stale results that could cause overbooking.
- The `queryAfterWrite` method is a convenience wrapper for operations that need read-after-write consistency (e.g., reading a booking immediately after creating it). It forces the query to the primary, bypassing replicas entirely.
- The two-level routing hierarchy -- shard router above read/write splitter -- cleanly separates data locality (which shard holds this user's data) from query routing (should this query go to the primary or a replica). Each level has a single responsibility.
- Scatter-gather (`queryAllShards`) is an expensive operation that queries every shard in parallel. It is appropriate for admin reports and aggregate analytics, but should never be used in the hot booking path. Monitor its usage and set alerts if it appears in latency-sensitive endpoints.

### Review Questions

1. **Conceptual:** The `isWriteQuery` method uses a regex that checks the beginning of the SQL string for write keywords. What types of queries would this regex misclassify? Give an example of a read query that would be incorrectly routed to the primary, and a write query that would be incorrectly routed to a replica.

2. **Code Reading:** In `getHealthyReplica`, the method executes `SHOW SLAVE STATUS` on each replica to check lag. This means every read query incurs an additional round-trip to check replication status. What performance concern does this raise, and how would you redesign the lag check to avoid this per-query overhead?

3. **Conceptual:** The shard router uses `userId % 16n` to determine the shard number. What happens when the system needs to grow from 16 shards to 32? How does this modulo-based approach complicate shard expansion, and what alternative sharding strategies would make expansion smoother?

### Hands-On Exercise

**Build a Lag-Aware Read Router with Caching**

Extend the `ReadWriteSplitter` to avoid the per-query `SHOW SLAVE STATUS` overhead:

1. Create a `ReplicaHealthMonitor` class that runs a background loop every 2 seconds, checking `SHOW SLAVE STATUS` on each replica and caching the results in memory.
2. Modify `getHealthyReplica` to read from the cached lag values instead of executing a query on every call.
3. Add a `replicaHealth()` method that returns the current health status of all replicas: host, lag in seconds, last checked timestamp, and whether the replica is marked healthy.
4. Add a weighted round-robin strategy where replicas with lower lag receive proportionally more traffic (e.g., a replica with 0s lag gets 4x the traffic of a replica with 4s lag when `maxLagSeconds` is 5).
5. Write a test that simulates 4 replicas with lags of 0s, 1s, 3s, and 10s (above threshold), verifies that the 10s replica receives zero traffic, and confirms that the 0s replica receives the most requests.

---
