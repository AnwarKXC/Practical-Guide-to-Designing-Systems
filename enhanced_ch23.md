# Chapter 23: Retry & Backoff — When to Try Again

## The Phone Call That Did Not Go Through

You call a restaurant to make a reservation. The line is busy. What do you do? You hang up and try again. Maybe you wait a few seconds. Maybe a minute. If the line is busy five times in a row, you might wait even longer between attempts, because clearly they are swamped. And if after ten tries the line is still busy, you give up and try a different restaurant.

You do not call back 500 times per second. You do not recruit every person in your office building to call the same number simultaneously. You do not keep calling a number that has been disconnected. These are obvious in real life, but developers violate all three rules in code — every single day.

This chapter is about retrying network calls correctly. Not the toy version with a `for` loop and a `catch` block. The production version that handles 100,000 bookings per minute without turning a brief network blip into a catastrophic outage. We will build it from first principles, and by the end, you will understand every retry decision in our Global Booking System.

---

## Why Retries Are Necessary

Distributed systems fail. Not occasionally — constantly. In a monolith, a function call either works or it throws, and the reason is usually a bug. In a microservices architecture, a call from your booking service to the payment service crosses process boundaries, network interfaces, load balancers, and possibly data centers. Any of these can fail independently, temporarily, and for reasons that have nothing to do with your code.

Here are real failure scenarios from our booking system:

1. A TCP connection is reset because a load balancer recycled its connection pool.
2. The inventory service takes 3 seconds to respond because the JVM is doing garbage collection, and your 2-second timeout fires.
3. A network switch flaps for 200 milliseconds, dropping packets.
4. Kubernetes is rolling out a new deployment, and for 500 milliseconds, some pods are terminating while new ones are starting.
5. The payment provider's API returns 503 because they are doing a scheduled database failover.

Every one of these failures is **transient** — it will resolve on its own within seconds. Without retries, each one becomes a failed booking, a frustrated customer, and lost revenue. With retries, the customer never knows anything happened.

> **Key Term:** **Transient failure** — A temporary error caused by infrastructure conditions (network blips, service restarts, resource contention) that will resolve on its own without any code change or human intervention. These are the failures retries are designed to handle.

### Transient Failures vs. Permanent Failures

This distinction is the single most important concept in retry logic. Get it wrong, and your retries either miss real recovery opportunities or waste resources hammering errors that will never succeed.

**Transient failures** are temporary. The system will recover. Retrying after a short delay is likely to succeed.

| Error | Why It Is Transient |
|-------|-------------------|
| `ECONNRESET` | Connection dropped mid-flight — next connection will work |
| `ETIMEDOUT` | Request took too long — server was busy, may be free now |
| `ECONNREFUSED` | Service not accepting connections — probably restarting |
| HTTP `500` | Internal server error — often a temporary resource issue |
| HTTP `502` | Bad gateway — upstream server was briefly unavailable |
| HTTP `503` | Service unavailable — explicitly temporary |
| HTTP `504` | Gateway timeout — upstream was slow, may be faster now |
| HTTP `429` | Too many requests — server says "slow down and try again" |

**Permanent failures** will produce the same error no matter how many times you retry. The request itself is the problem.

| Error | Why It Is Permanent |
|-------|-------------------|
| HTTP `400` | Bad request — your payload is malformed |
| HTTP `401` | Unauthorized — your credentials are invalid |
| HTTP `403` | Forbidden — you lack permission, and retrying will not grant it |
| HTTP `404` | Not found — the resource does not exist |
| HTTP `409` | Conflict — business rule violation (e.g., double booking) |
| HTTP `422` | Unprocessable entity — validation failed on valid-format data |

> **Analogy:** Transient failures are like a busy signal when you call a restaurant — they are overwhelmed right now, but if you call back in a minute, someone will answer. Permanent failures are like calling a number that has been disconnected — you can call a thousand times, and the result will be the same.

```typescript
// This function encodes the transient vs. permanent distinction
function classifyError(error: any): 'transient' | 'permanent' | 'unknown' {
  // Network-level errors are almost always transient
  const transientCodes = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
    'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN',
  ]);
  if (transientCodes.has(error.code)) return 'transient';

  // HTTP status codes
  const status = error.response?.status;
  if (status) {
    // 429 is the only 4xx that is transient
    if (status === 429) return 'transient';
    // All other 4xx are permanent
    if (status >= 400 && status < 500) return 'permanent';
    // 5xx are generally transient
    if (status >= 500) return 'transient';
  }

  // Business logic errors are permanent
  if (error.name === 'ValidationError') return 'permanent';
  if (error.name === 'InsufficientInventoryError') return 'permanent';
  if (error.name === 'PaymentDeclinedError') return 'permanent';

  // When in doubt, assume transient (but log it for investigation)
  return 'unknown';
}
```

> **What If You Skip This?** If you retry permanent errors, you waste CPU cycles, network bandwidth, and the downstream service's capacity on requests that are guaranteed to fail. Worse, if you retry a `409 Conflict` on a payment endpoint, you might trigger duplicate charges. If you do not retry transient errors, every network hiccup becomes a user-facing error, and your system's effective availability drops from 99.99% to 99.5% or worse.

---

## Immediate Retry vs. Delayed Retry

Not all retries need a delay. There are two distinct strategies, and choosing the wrong one for the situation causes real problems.

### Immediate Retry (Zero Delay)

An immediate retry sends the request again with no waiting period. This is appropriate in exactly one scenario: **when the failure is a one-off anomaly and the service is otherwise healthy**.

```typescript
// Immediate retry — suitable ONLY for isolated, rare failures
async function withImmediateRetry<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 2,
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (classifyError(error) === 'permanent') throw error;
      // No delay — retry immediately
    }
  }
  throw lastError!;
}
```

When is this appropriate? Consider a scenario where a single TCP packet is dropped due to a cosmic ray (yes, this happens). The connection resets, your request fails, but the server is perfectly healthy. An immediate retry will succeed. Adding a 200ms delay would be unnecessary latency for the user.

**But here is the trap:** you almost never know for certain that the failure is isolated. If the failure rate is even slightly elevated — say 5% of requests are failing — immediate retries amplify the load by 5%. If that 5% becomes 20% because the service is under load, immediate retries amplify it by 20%. The amplification gets worse precisely when the system can least afford it.

### Delayed Retry (Backoff)

A delayed retry waits before trying again. The delay gives the failing service time to recover.

```typescript
// Delayed retry — the safe default for production systems
async function withDelayedRetry<T>(
  operation: () => Promise<T>,
  delayMs: number = 500,
  maxAttempts: number = 3,
): Promise<T> {
  let lastError: Error;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (classifyError(error) === 'permanent') throw error;
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError!;
}
```

Delayed retries are the correct default for nearly every production scenario. The question is: how long should the delay be? A fixed delay is better than no delay, but it has its own problems. If you pick 500ms and 500 clients all retry at 500ms, you get a synchronized spike at the 500ms mark. This is where exponential backoff enters the picture.

> **Checkpoint:** You have a service that makes calls to a partner API. The partner API has a guaranteed SLA of 99.99% (roughly 1 failure per 10,000 requests). Should you use immediate retry or delayed retry? (Answer: Immediate retry with at most one attempt is reasonable here, because at 99.99% availability, failures are genuinely isolated anomalies. But you should still have delayed retry as a fallback if the immediate retry also fails.)

---

## Exponential Backoff: The Math

Exponential backoff is not a vague idea — it is a specific mathematical formula. Understanding the math lets you tune it correctly for your system instead of copy-pasting someone else's magic numbers.

### The Formula

```
delay = min(maxDelay, baseDelay * multiplier ^ attempt)
```

Where:
- `baseDelay` is the initial delay (e.g., 200ms)
- `multiplier` is how aggressively the delay grows (usually 2)
- `attempt` is the zero-indexed attempt number (0, 1, 2, ...)
- `maxDelay` is the ceiling so delays do not grow unbounded

Let us trace through with `baseDelay = 200ms`, `multiplier = 2`, `maxDelay = 30000ms`:

| Attempt | Raw Delay | Capped Delay |
|---------|-----------|-------------|
| 0 | 200 * 2^0 = 200ms | 200ms |
| 1 | 200 * 2^1 = 400ms | 400ms |
| 2 | 200 * 2^2 = 800ms | 800ms |
| 3 | 200 * 2^3 = 1,600ms | 1,600ms |
| 4 | 200 * 2^4 = 3,200ms | 3,200ms |
| 5 | 200 * 2^5 = 6,400ms | 6,400ms |
| 6 | 200 * 2^6 = 12,800ms | 12,800ms |
| 7 | 200 * 2^7 = 25,600ms | 25,600ms |
| 8 | 200 * 2^8 = 51,200ms | **30,000ms** (capped) |
| 9 | 200 * 2^9 = 102,400ms | **30,000ms** (capped) |

Without the `maxDelay` cap, attempt 15 would wait 200 * 2^15 = 6,553,600ms — that is almost **two hours**. No user will wait two hours for a booking to complete. The cap is not optional; it is mandatory.

### Why Exponential and Not Linear?

You might wonder: why not increase the delay linearly (200ms, 400ms, 600ms, 800ms)? The answer is about matching the recovery profile of real systems.

When a service goes down, the first few seconds are the most uncertain. The service might come back in 100ms (a restarted process), or it might take 30 seconds (a database failover), or it might take 5 minutes (a deployment rollback). Exponential backoff front-loads retries when a quick recovery is possible, but quickly backs off if the failure persists.

```
Linear backoff (base=200, increment=200):
  200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000
  Total wait after 10 retries: 11,000ms

Exponential backoff (base=200, multiplier=2):
  200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30000, 30000
  Total wait after 10 retries: 111,000ms
```

With linear backoff, you have made 10 attempts in 11 seconds. If the service needs 30 seconds to recover, you have burned all your retries and given up before it came back. With exponential backoff, your later retries are spaced far enough apart that you are still trying when the service recovers.

> **Key Term:** **Exponential backoff** — A retry strategy where the delay between attempts grows exponentially (typically doubling each time), capped at a maximum value. The formula is `delay = min(maxDelay, baseDelay * multiplier^attempt)`. This matches the real-world recovery profile of failing services: rapid early retries catch quick recoveries, while progressively longer delays avoid overwhelming services that need more time.

### Choosing Your Parameters

Here are the parameters we use in the Global Booking System and why:

```typescript
// booking-service → payment-service
const PAYMENT_RETRY_CONFIG = {
  baseDelay: 200,    // Start at 200ms — payment is latency-sensitive
  multiplier: 2,     // Standard doubling
  maxDelay: 10000,   // Cap at 10s — user is waiting for booking confirmation
  maxAttempts: 4,    // 4 attempts max (1 original + 3 retries)
};

// booking-service → notification-service (email)
const NOTIFICATION_RETRY_CONFIG = {
  baseDelay: 1000,   // Start at 1s — email delivery is not urgent
  multiplier: 3,     // Aggressive backoff — if email fails, wait longer
  maxDelay: 60000,   // Cap at 60s — email can wait
  maxAttempts: 5,    // 5 attempts — email is important but not time-critical
};

// booking-service → inventory-service
const INVENTORY_RETRY_CONFIG = {
  baseDelay: 100,    // Start at 100ms — inventory checks must be fast
  multiplier: 2,     // Standard doubling
  maxDelay: 5000,    // Cap at 5s — user is browsing, latency matters
  maxAttempts: 3,    // 3 attempts max — if inventory is down, show cached data
};
```

Notice how each config is different. The payment service gets a lower max delay because the user is actively waiting for confirmation. The notification service gets a higher base delay and more attempts because email delivery is asynchronous — the user will not be staring at a loading spinner. The inventory service gets the lowest base delay and max delay because availability checks need to feel instant.

> **What If You Skip This?** If you use the same retry config for every service, you either wait too long for time-sensitive calls (frustrating users) or retry too aggressively for non-critical calls (amplifying load on already-struggling services). One-size-fits-all retry policies are a code smell in any distributed system.

---

## Why Naive Retries Cause Thundering Herd and Retry Storms

Before we implement a production retry utility, you need to understand the single most dangerous failure mode of retries. This is not theoretical — it is the number one way retries cause outages instead of preventing them.

### The Thundering Herd Problem

Imagine the inventory service in our booking system goes down for 2 seconds. During those 2 seconds, 5,000 requests arrive and fail. If every caller retries immediately, the inventory service — which just recovered from whatever caused the outage — is instantly hit with 5,000 requests simultaneously. This is the **thundering herd**.

The service might handle 2,000 requests per second under normal load. Now it gets 5,000 in a single burst. The result? It goes down again. Now those 5,000 requests fail a second time, and all 5,000 retry again, plus the new requests that arrived during the second outage. The failure compounds.

```
Timeline of a retry storm:

T=0s:   Service goes down
T=0-2s: 5,000 requests accumulate, all fail
T=2s:   Service recovers
T=2s:   5,000 retries hit simultaneously → service goes down again
T=2-4s: 5,000 more new requests arrive, all fail
T=4s:   Service recovers
T=4s:   10,000 retries hit → service goes down again
T=4-6s: Cascading failure spreads to upstream services
```

This is a **retry storm**. It turns a 2-second blip into a sustained outage that can last minutes or hours. The retries — which exist to improve reliability — become the primary cause of the outage.

### The Math of Amplification

Let us quantify this. Suppose your service handles 1,000 requests per second (rps) normally, and the error rate jumps to 20%.

- Without retries: 200 errors/second. Total load stays at 1,000 rps.
- With 1 retry (no delay): 200 retries/second. Total load = 1,200 rps. Of the retries, 20% fail again = 40 more retries. Total load ≈ 1,240 rps.
- With 3 retries (no delay): Total load ≈ 1,000 + 200 + 40 + 8 ≈ 1,248 rps. Manageable.

But what if the error rate is 80% (service is badly degraded)?

- Without retries: 800 errors/second. Total load = 1,000 rps.
- With 3 retries (no delay): 1,000 + 800 + 640 + 512 ≈ **2,952 rps**. Nearly 3x the normal load.
- With 5 retries (no delay): ≈ **4,300 rps**. Over 4x the normal load.

The retries amplify the load by a factor that grows with **both** the error rate **and** the number of retry attempts. When the error rate is high — precisely when the service can least afford extra load — retries make it worse.

> **Key Term:** **Retry storm** — A cascading failure pattern where multiple clients simultaneously retry failed requests, creating a burst of traffic that overwhelms a recovering service. Each wave of failures triggers another wave of retries, creating a self-reinforcing cycle that can sustain an outage indefinitely.

```typescript
// This function demonstrates why naive retries are dangerous
// DO NOT use this in production — this is an anti-pattern
async function naiveRetry<T>(
  operation: () => Promise<T>,
  maxAttempts: number = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts - 1) throw error;
      // No delay, no jitter, no error classification
      // Every client retries at the same time → thundering herd
    }
  }
  throw new Error('Unreachable');
}
```

> **Analogy:** Imagine a popular restaurant where every customer who cannot get a table immediately walks outside and comes back exactly 5 minutes later. If 50 people are turned away at 7:00 PM, the hostess faces a mob of 50 at 7:05 PM — plus all the new arrivals. If she turns away 30 of those, she faces 30 at 7:10 PM, plus new arrivals. The restaurant never stabilizes. If instead each turned-away customer waited a random time between 5 and 15 minutes, the load would spread evenly and the restaurant would process everyone.

---

## Jitter: Why Randomization Matters

Exponential backoff spaces out retries over time. But it does not prevent synchronization. If 1,000 clients all start their first retry at T=0, with a 200ms base delay, all 1,000 will retry at T=200ms. Then at T=600ms. Then at T=1400ms. The retries are spaced further apart, but they still happen in synchronized bursts.

**Jitter** adds randomness to the delay, breaking the synchronization. Instead of all 1,000 clients retrying at T=200ms, they retry at random times between T=0ms and T=200ms, spreading the load evenly.

### Three Jitter Strategies

The AWS Architecture Blog published the definitive analysis of jitter strategies in 2015. There are three main approaches, each with different trade-offs.

#### 1. Full Jitter

```
delay = random(0, min(maxDelay, baseDelay * multiplier ^ attempt))
```

Full jitter picks a completely random delay between 0 and the calculated exponential delay. This provides the widest spread and the best load distribution.

```typescript
function fullJitterDelay(
  attempt: number,
  baseDelay: number,
  multiplier: number,
  maxDelay: number,
): number {
  const exponentialDelay = Math.min(
    maxDelay,
    baseDelay * Math.pow(multiplier, attempt),
  );
  // Random value between 0 and the exponential delay
  return Math.floor(Math.random() * exponentialDelay);
}

// Example outputs for attempt=3, base=200, multiplier=2, max=30000:
// Exponential delay = 1600ms
// Full jitter range: [0, 1600ms]
// Possible values: 0, 47, 312, 899, 1201, 1587, ...
```

**Pros:** Maximum spread of retries. Best at preventing thundering herd.
**Cons:** Some retries happen very quickly (near 0ms), which provides less recovery time for the failing service.

#### 2. Equal Jitter

```
delay = (exponentialDelay / 2) + random(0, exponentialDelay / 2)
```

Equal jitter guarantees a minimum delay of half the exponential value, then adds randomness for the other half.

```typescript
function equalJitterDelay(
  attempt: number,
  baseDelay: number,
  multiplier: number,
  maxDelay: number,
): number {
  const exponentialDelay = Math.min(
    maxDelay,
    baseDelay * Math.pow(multiplier, attempt),
  );
  const halfDelay = exponentialDelay / 2;
  // Guaranteed minimum of half + random up to half
  return Math.floor(halfDelay + Math.random() * halfDelay);
}

// Example outputs for attempt=3, base=200, multiplier=2, max=30000:
// Exponential delay = 1600ms, half = 800ms
// Equal jitter range: [800ms, 1600ms]
// Possible values: 800, 912, 1055, 1300, 1587, ...
```

**Pros:** Guarantees a minimum backoff period. Good balance of spread and recovery time.
**Cons:** Less spread than full jitter — retries are concentrated in the upper half of the range.

#### 3. Decorrelated Jitter

```
delay = min(maxDelay, random(baseDelay, previousDelay * 3))
```

Decorrelated jitter is different: instead of computing from the attempt number, it bases each delay on the previous delay. This creates a random walk that tends to increase over time but is not strictly exponential.

```typescript
function decorrelatedJitterDelay(
  previousDelay: number,
  baseDelay: number,
  maxDelay: number,
): number {
  // Next delay is random between base and 3x the previous delay
  const nextDelay = Math.floor(
    baseDelay + Math.random() * (previousDelay * 3 - baseDelay),
  );
  return Math.min(maxDelay, nextDelay);
}

// Example sequence with base=200, max=30000:
// Attempt 0: previousDelay=200, range=[200, 600], picked 450
// Attempt 1: previousDelay=450, range=[200, 1350], picked 870
// Attempt 2: previousDelay=870, range=[200, 2610], picked 1900
// Attempt 3: previousDelay=1900, range=[200, 5700], picked 3200
```

**Pros:** Best decorrelation between clients. Each client follows its own random path.
**Cons:** Less predictable total retry time. Harder to reason about worst-case latency.

### Which Jitter Strategy Should You Use?

For the Global Booking System, we use **full jitter** as the default. The AWS analysis showed that full jitter produces the best overall results: fewest total calls to the server, shortest completion time for all clients, and most even load distribution.

```typescript
// Comparison: 1000 clients retrying with attempt=3, base=200ms, multiplier=2

// No jitter: All 1000 retry at exactly 1600ms → single spike of 1000 requests
// Full jitter: Retries spread across [0, 1600ms] → ~0.6 requests/ms average
// Equal jitter: Retries spread across [800, 1600ms] → ~1.25 requests/ms average
// Decorrelated: Retries spread unpredictably → varies, but well-distributed
```

> **Checkpoint:** You have 10,000 clients all failing simultaneously. Each uses exponential backoff with multiplier=2 and base=100ms. After attempt 4, the exponential delay is 1600ms. With full jitter, what is the average load per millisecond from retries? (Answer: 10,000 retries / 1600ms = ~6.25 retries per millisecond. Without jitter, it would be 10,000 retries in a single millisecond — 1,600x worse.)

---

## Full TypeScript Retry Utility with Configurable Strategies

Now we build the production retry utility that the Global Booking System actually uses. This is not a toy — it handles error classification, multiple jitter strategies, retry budgets, event emission for monitoring, and abort signals.

```typescript
// src/common/retry/retry.types.ts

export type JitterStrategy = 'none' | 'full' | 'equal' | 'decorrelated';

export interface RetryConfig {
  /** Maximum number of attempts (including the first try) */
  maxAttempts: number;
  /** Base delay in milliseconds */
  baseDelayMs: number;
  /** Multiplier for exponential backoff (default: 2) */
  multiplier?: number;
  /** Maximum delay in milliseconds */
  maxDelayMs: number;
  /** Jitter strategy (default: 'full') */
  jitter?: JitterStrategy;
  /** Function to classify errors as retryable or not */
  isRetryable?: (error: Error) => boolean;
  /** Optional abort signal to cancel retries */
  abortSignal?: AbortSignal;
  /** Callback invoked before each retry (for logging/metrics) */
  onRetry?: (error: Error, attempt: number, delayMs: number) => void;
}

export interface RetryResult<T> {
  /** The successful result */
  data: T;
  /** Number of attempts it took (1 = succeeded on first try) */
  attempts: number;
  /** Total time spent including delays, in milliseconds */
  totalTimeMs: number;
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly lastError: Error,
    public readonly attempts: number,
    public readonly totalTimeMs: number,
  ) {
    super(
      `Retry exhausted after ${attempts} attempts ` +
      `(${totalTimeMs}ms): ${lastError.message}`,
    );
    this.name = 'RetryExhaustedError';
  }
}

export class RetryAbortedError extends Error {
  constructor(
    public readonly lastError: Error,
    public readonly attempts: number,
  ) {
    super(
      `Retry aborted after ${attempts} attempts: ${lastError.message}`,
    );
    this.name = 'RetryAbortedError';
  }
}
```

```typescript
// src/common/retry/retry.service.ts

import {
  RetryConfig,
  RetryResult,
  RetryExhaustedError,
  RetryAbortedError,
  JitterStrategy,
} from './retry.types';

export class RetryService {
  /**
   * Executes an operation with retry logic.
   *
   * Why this exists: Every outbound call in the booking system must handle
   * transient failures. This utility encapsulates the retry logic so that
   * individual services do not re-implement it (and get it wrong).
   */
  async execute<T>(
    operation: () => Promise<T>,
    config: RetryConfig,
  ): Promise<RetryResult<T>> {
    const {
      maxAttempts,
      baseDelayMs,
      multiplier = 2,
      maxDelayMs,
      jitter = 'full',
      isRetryable = () => true,
      abortSignal,
      onRetry,
    } = config;

    let lastError: Error | undefined;
    let previousDelay = baseDelayMs;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if retry was cancelled
      if (abortSignal?.aborted) {
        throw new RetryAbortedError(
          lastError ?? new Error('Operation aborted'),
          attempt,
        );
      }

      try {
        const data = await operation();
        return {
          data,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error as Error;

        // Do not retry non-retryable errors
        if (!isRetryable(lastError)) {
          throw lastError;
        }

        // Do not delay after the last attempt
        if (attempt < maxAttempts - 1) {
          const delay = this.calculateDelay(
            attempt,
            baseDelayMs,
            multiplier,
            maxDelayMs,
            jitter,
            previousDelay,
          );
          previousDelay = delay;

          // Notify listener before sleeping
          onRetry?.(lastError, attempt + 1, delay);

          // Sleep, but respect the abort signal
          await this.sleep(delay, abortSignal);
        }
      }
    }

    throw new RetryExhaustedError(
      lastError!,
      maxAttempts,
      Date.now() - startTime,
    );
  }

  private calculateDelay(
    attempt: number,
    baseDelayMs: number,
    multiplier: number,
    maxDelayMs: number,
    jitter: JitterStrategy,
    previousDelay: number,
  ): number {
    const exponentialDelay = Math.min(
      maxDelayMs,
      baseDelayMs * Math.pow(multiplier, attempt),
    );

    switch (jitter) {
      case 'none':
        return exponentialDelay;

      case 'full':
        return Math.floor(Math.random() * exponentialDelay);

      case 'equal': {
        const half = exponentialDelay / 2;
        return Math.floor(half + Math.random() * half);
      }

      case 'decorrelated':
        return Math.min(
          maxDelayMs,
          Math.floor(
            baseDelayMs + Math.random() * (previousDelay * 3 - baseDelayMs),
          ),
        );

      default:
        return exponentialDelay;
    }
  }

  private sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);

      if (abortSignal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Retry sleep aborted'));
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
```

```typescript
// Usage example: booking-service calling payment-service
import { RetryService } from '../common/retry/retry.service';

const retryService = new RetryService();

async function processPayment(bookingId: string, amount: number) {
  const result = await retryService.execute(
    () => paymentClient.charge({
      bookingId,
      amount,
      currency: 'USD',
      idempotencyKey: `payment-${bookingId}`, // Critical for safe retries
    }),
    {
      maxAttempts: 4,
      baseDelayMs: 200,
      maxDelayMs: 10_000,
      jitter: 'full',
      isRetryable: (error) => {
        const classification = classifyError(error);
        return classification !== 'permanent';
      },
      onRetry: (error, attempt, delay) => {
        logger.warn({
          message: 'Payment call failed, retrying',
          bookingId,
          attempt,
          delayMs: delay,
          error: error.message,
        });
      },
    },
  );

  logger.info({
    message: 'Payment processed successfully',
    bookingId,
    attempts: result.attempts,
    totalTimeMs: result.totalTimeMs,
  });

  return result.data;
}
```

> **What If You Skip This?** Without a centralized retry utility, every developer on the team writes their own retry loop. Some forget jitter. Some retry permanent errors. Some do not cap the delay. Some do not log retries. You end up with 15 different retry implementations across 15 services, each with its own bugs and blind spots. Centralizing retry logic is not perfectionism — it is the only way to ensure consistent, safe behavior across your system.

---

## Retry Budgets: Limiting Total Retries Across a Service

Individual retry configs are necessary but not sufficient. Even with perfect jitter and exponential backoff, there is a system-level problem: if 50% of requests are failing, and each request retries 3 times, your service generates 1.5x its normal outbound traffic. A retry budget limits the **total** number of retries your service generates, regardless of how many individual requests want to retry.

### How Retry Budgets Work

A retry budget tracks the ratio of retries to successful requests over a sliding time window. When the ratio exceeds a threshold, new retries are rejected — the request fails immediately instead of being retried.

Google's SRE book recommends a retry budget of **10%**: for every 10 successful requests, you are allowed 1 retry. If you are generating more retries than that, something is systemically wrong, and additional retries will not help.

```typescript
// src/common/retry/retry-budget.service.ts

export class RetryBudgetService {
  private successCount = 0;
  private retryCount = 0;
  private readonly windowMs: number;
  private readonly maxRetryRatio: number;
  private lastResetTime: number;

  /**
   * A retry budget prevents a service from generating excessive
   * retry traffic during widespread failures. Without this, a degraded
   * downstream service gets hammered by retries from every caller,
   * turning partial failure into total failure.
   *
   * @param windowMs - Time window for tracking (default: 60 seconds)
   * @param maxRetryRatio - Maximum retries per successful request (default: 0.1 = 10%)
   */
  constructor(windowMs = 60_000, maxRetryRatio = 0.1) {
    this.windowMs = windowMs;
    this.maxRetryRatio = maxRetryRatio;
    this.lastResetTime = Date.now();
  }

  /** Call this after every successful request */
  recordSuccess(): void {
    this.maybeResetWindow();
    this.successCount++;
  }

  /** Call this after every retry attempt */
  recordRetry(): void {
    this.maybeResetWindow();
    this.retryCount++;
  }

  /**
   * Returns true if a retry is allowed within the budget.
   * During the first few requests of a window, we allow retries
   * to avoid blocking retries when there is insufficient data.
   */
  canRetry(): boolean {
    this.maybeResetWindow();

    // Allow retries when we have fewer than 100 data points
    // (not enough data to make a reliable ratio decision)
    const totalRequests = this.successCount + this.retryCount;
    if (totalRequests < 100) return true;

    // Check the retry ratio
    const currentRatio = this.retryCount / Math.max(1, this.successCount);
    return currentRatio < this.maxRetryRatio;
  }

  /** Get current retry ratio for monitoring */
  getCurrentRatio(): number {
    return this.retryCount / Math.max(1, this.successCount);
  }

  private maybeResetWindow(): void {
    const now = Date.now();
    if (now - this.lastResetTime > this.windowMs) {
      this.successCount = 0;
      this.retryCount = 0;
      this.lastResetTime = now;
    }
  }
}
```

```typescript
// Integrating the retry budget with RetryService
const retryBudget = new RetryBudgetService(60_000, 0.1); // 10% budget

async function callInventoryService(propertyId: string) {
  const result = await retryService.execute(
    () => inventoryClient.checkAvailability(propertyId),
    {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      jitter: 'full',
      isRetryable: (error) => {
        // Check the budget BEFORE checking the error
        if (!retryBudget.canRetry()) {
          logger.warn({
            message: 'Retry budget exhausted — failing fast',
            retryRatio: retryBudget.getCurrentRatio(),
            propertyId,
          });
          return false; // Do not retry — budget exceeded
        }
        retryBudget.recordRetry();
        return classifyError(error) !== 'permanent';
      },
    },
  );

  retryBudget.recordSuccess();
  return result.data;
}
```

> **Analogy:** A retry budget is like a credit limit on a credit card. Each individual purchase (retry) might be reasonable, but if you are spending more than you earn, the bank cuts you off. The retry budget cuts off retries when the ratio of failures to successes exceeds a healthy threshold — because at that point, the downstream service needs you to stop, not to try harder.

---

## Idempotency: Why Retries Require Idempotent Operations

Here is a question that separates junior from senior engineers: if a request times out, did the server process it? You do not know. The timeout means the client gave up waiting for a response, but the server may have completed the operation successfully. If you retry, you might execute the operation **twice**.

For a `GET` request, this is harmless — reading data twice produces the same result. But for a `POST /payments/charge`, retrying means potentially charging the customer twice. This is why **every operation that can be retried must be idempotent**.

> **Key Term:** **Idempotency** — An operation is idempotent if performing it multiple times produces the same result as performing it once. `GET`, `PUT`, and `DELETE` are idempotent by definition. `POST` is not idempotent by default and must be made idempotent explicitly using idempotency keys.

### Implementing Idempotency Keys

The standard approach is to generate a unique **idempotency key** on the client and send it with every request. The server checks if it has already processed a request with that key, and if so, returns the cached response instead of processing it again.

```typescript
// Client side: generating and sending idempotency keys
async function chargePayment(bookingId: string, amount: number) {
  // The idempotency key is derived from the business operation,
  // NOT from the retry attempt. This ensures all retries of the
  // same charge map to the same key.
  const idempotencyKey = `charge-${bookingId}-${amount}`;

  return retryService.execute(
    () => paymentClient.post('/charges', {
      bookingId,
      amount,
      currency: 'USD',
    }, {
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
    }),
    {
      maxAttempts: 4,
      baseDelayMs: 200,
      maxDelayMs: 10_000,
      jitter: 'full',
      isRetryable: (error) => classifyError(error) !== 'permanent',
    },
  );
}
```

```typescript
// Server side: processing idempotency keys
// src/payment/payment.service.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentService {
  constructor(private readonly prisma: PrismaService) {}

  async processCharge(
    bookingId: string,
    amount: number,
    currency: string,
    idempotencyKey: string,
  ) {
    // Step 1: Check if we already processed this request
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key: idempotencyKey },
    });

    if (existing) {
      // Already processed — return the cached response
      return JSON.parse(existing.responseBody);
    }

    // Step 2: Process the charge inside a transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create the idempotency record first (acts as a lock)
      await tx.idempotencyRecord.create({
        data: {
          key: idempotencyKey,
          status: 'processing',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
        },
      });

      // Process the actual charge
      const charge = await tx.payment.create({
        data: {
          bookingId,
          amount,
          currency,
          status: 'completed',
          processedAt: new Date(),
        },
      });

      // Update the idempotency record with the response
      await tx.idempotencyRecord.update({
        where: { key: idempotencyKey },
        data: {
          status: 'completed',
          responseBody: JSON.stringify(charge),
        },
      });

      return charge;
    });

    return result;
  }
}
```

**Prisma schema for idempotency records:**

```prisma
// prisma/schema.prisma

model IdempotencyRecord {
  id           String   @id @default(uuid())
  key          String   @unique
  status       String   // 'processing' | 'completed' | 'failed'
  responseBody String?  @db.Text
  createdAt    DateTime @default(now())
  expiresAt    DateTime

  @@index([expiresAt]) // For cleanup jobs that purge expired records
  @@map("idempotency_records")
}

model Payment {
  id          String   @id @default(uuid())
  bookingId   String
  amount      Float
  currency    String   @default("USD")
  status      String   // 'pending' | 'completed' | 'failed' | 'refunded'
  processedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  booking     Booking  @relation(fields: [bookingId], references: [id])

  @@index([bookingId])
  @@map("payments")
}
```

```typescript
// Prisma Client query equivalent for the idempotency check:
const existing = await prisma.idempotencyRecord.findUnique({
  where: { key: 'charge-booking-123-99.99' },
});

// Raw SQL equivalent (for understanding what Prisma generates):
// SELECT id, key, status, response_body, created_at, expires_at
// FROM idempotency_records
// WHERE key = 'charge-booking-123-99.99'
// LIMIT 1;
```

> **What If You Skip This?** Without idempotency keys, your retry logic can cause duplicate charges, double bookings, duplicate notifications, and data corruption. This is not hypothetical — it is the most common financial bug in payment systems. Stripe, PayPal, and every mature payment API require idempotency keys for exactly this reason.

---

## Circuit Breaker + Retry Integration

Retries and circuit breakers are complementary patterns that solve different parts of the same problem. Retries handle **transient** failures by trying again. Circuit breakers handle **sustained** failures by stopping all attempts. Together, they form a complete failure-handling strategy.

### Why You Need Both

Consider what happens with retries alone: if a service is completely down, every request retries 3 times, waits for timeouts, and eventually fails. During a 30-second outage with 1,000 rps, you generate 1,000 * 3 = 3,000 retries, all of which fail. Your users wait 3x longer for an error they are going to get anyway.

Now add a circuit breaker: after 10 consecutive failures, the circuit opens. All subsequent requests fail immediately (within 1ms, not after a timeout). The user gets a fast error, your service is not blocked waiting, and the failing service is not hammered with retries.

```typescript
// src/common/resilience/resilient-client.ts

import { RetryService } from '../retry/retry.service';
import { CircuitBreaker, CircuitBreakerState } from './circuit-breaker';

export class ResilientClient {
  private retryService = new RetryService();
  private circuitBreaker: CircuitBreaker;

  constructor(
    private readonly serviceName: string,
    circuitBreakerConfig: {
      failureThreshold: number;
      resetTimeoutMs: number;
      halfOpenMaxAttempts: number;
    },
  ) {
    this.circuitBreaker = new CircuitBreaker(circuitBreakerConfig);
  }

  /**
   * Executes a call with both circuit breaker and retry logic.
   *
   * Order of operations:
   * 1. Check circuit breaker — if OPEN, fail immediately
   * 2. If CLOSED or HALF_OPEN, attempt the call with retries
   * 3. On success, notify circuit breaker (may close it)
   * 4. On failure, notify circuit breaker (may open it)
   *
   * The circuit breaker wraps the entire retry sequence, NOT
   * individual attempts. If all retries fail, that counts as
   * one failure for the circuit breaker.
   */
  async call<T>(
    operation: () => Promise<T>,
    retryConfig: {
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
    },
  ): Promise<T> {
    // Step 1: Check the circuit breaker
    if (this.circuitBreaker.getState() === CircuitBreakerState.OPEN) {
      throw new Error(
        `Circuit breaker OPEN for ${this.serviceName}. ` +
        `Failing fast to protect the downstream service.`,
      );
    }

    try {
      // Step 2: Execute with retries
      const result = await this.retryService.execute(operation, {
        ...retryConfig,
        jitter: 'full',
        isRetryable: (error) => {
          // If the circuit breaker has opened during retries, stop retrying
          if (this.circuitBreaker.getState() === CircuitBreakerState.OPEN) {
            return false;
          }
          return classifyError(error) !== 'permanent';
        },
        onRetry: (error, attempt, delay) => {
          logger.warn({
            message: `Retry ${attempt} for ${this.serviceName}`,
            delayMs: delay,
            circuitState: this.circuitBreaker.getState(),
            error: error.message,
          });
        },
      });

      // Step 3: Success — notify circuit breaker
      this.circuitBreaker.recordSuccess();
      return result.data;

    } catch (error) {
      // Step 4: All retries exhausted — notify circuit breaker
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }
}
```

```typescript
// Usage in booking service
const paymentClient = new ResilientClient('payment-service', {
  failureThreshold: 5,      // Open after 5 consecutive failures
  resetTimeoutMs: 30_000,   // Try again after 30 seconds
  halfOpenMaxAttempts: 3,    // Allow 3 test requests in half-open
});

async function handleBookingPayment(bookingId: string, amount: number) {
  try {
    return await paymentClient.call(
      () => paymentApi.charge({ bookingId, amount }),
      { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
    );
  } catch (error) {
    if (error.message.includes('Circuit breaker OPEN')) {
      // Fast failure — payment service is known to be down
      // Enqueue for later processing instead of failing the booking
      await deadLetterQueue.enqueue({
        type: 'payment',
        bookingId,
        amount,
        enqueuedAt: new Date(),
      });
      return { status: 'deferred', message: 'Payment will be processed shortly' };
    }
    throw error;
  }
}
```

> **Key Term:** **Circuit breaker** — A pattern that monitors failures to a downstream service and, after a threshold is reached, "opens" the circuit to prevent all further calls. After a timeout period, it enters a "half-open" state where a limited number of test requests are allowed through. If those succeed, the circuit closes and normal traffic resumes. If they fail, the circuit opens again. This prevents a failed service from being overwhelmed by requests it cannot handle.

---

## Which HTTP Status Codes to Retry

This is one of the most frequently asked questions, and getting it wrong has real consequences. Here is the complete decision matrix.

### Retryable Status Codes

| Code | Name | Why Retryable | Retry Strategy |
|------|------|---------------|----------------|
| `429` | Too Many Requests | Server is rate-limiting you. The `Retry-After` header tells you exactly when to retry. | **Always** respect the `Retry-After` header. If absent, use exponential backoff. |
| `500` | Internal Server Error | Catch-all for server-side bugs or transient issues. May resolve on retry if caused by temporary resource exhaustion. | Retry with caution — if the same request triggers the same bug, retries are wasted. |
| `502` | Bad Gateway | The gateway received an invalid response from an upstream server. Common during deployments. | Retry — this almost always resolves within seconds. |
| `503` | Service Unavailable | Server explicitly says "I am temporarily unavailable." Often includes `Retry-After`. | **Always** retry — this is the most definitively transient status code. |
| `504` | Gateway Timeout | The gateway did not get a response from the upstream server in time. Server may still be processing. | Retry, but **ensure idempotency** — the request may have been processed despite the timeout. |

### Non-Retryable Status Codes

| Code | Name | Why NOT Retryable | Correct Action |
|------|------|-------------------|----------------|
| `400` | Bad Request | Your request is malformed. Retrying the same request will produce the same error. | Fix the request payload. Log and alert developers. |
| `401` | Unauthorized | Your authentication token is invalid or expired. Retrying with the same token will fail. | Refresh the token, then retry with the new token (this is a different request, not a retry). |
| `403` | Forbidden | You lack permission. No amount of retrying will grant you access. | Check permissions configuration. Alert operators. |
| `404` | Not Found | The resource does not exist. Retrying will not make it appear. | Verify the URL/resource ID is correct. |
| `409` | Conflict | Business rule conflict (e.g., double booking). Retrying will produce the same conflict. | Handle the conflict in business logic (e.g., suggest alternative dates). |
| `422` | Unprocessable Entity | Validation failed. The data is structurally valid but semantically wrong. | Fix the data and resubmit. |

```typescript
// Encoding the retry decision matrix
function shouldRetryHttpStatus(status: number, headers?: Record<string, string>): {
  shouldRetry: boolean;
  retryAfterMs?: number;
} {
  // Check Retry-After header for 429 and 503
  let retryAfterMs: number | undefined;
  if (headers?.['retry-after']) {
    const retryAfter = headers['retry-after'];
    // Retry-After can be seconds (integer) or an HTTP date
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      retryAfterMs = seconds * 1000;
    } else {
      const date = new Date(retryAfter);
      retryAfterMs = Math.max(0, date.getTime() - Date.now());
    }
  }

  switch (status) {
    case 429: return { shouldRetry: true, retryAfterMs };
    case 500: return { shouldRetry: true };
    case 502: return { shouldRetry: true };
    case 503: return { shouldRetry: true, retryAfterMs };
    case 504: return { shouldRetry: true };
    // All 4xx except 429 are non-retryable
    default:
      if (status >= 400 && status < 500) return { shouldRetry: false };
      // 1xx, 2xx, 3xx should not reach retry logic
      return { shouldRetry: false };
  }
}
```

---

## NestJS Retry Interceptor Implementation

In the Global Booking System, we implement retries as a NestJS interceptor. This gives us a clean, declarative way to add retry logic to any outbound HTTP call without cluttering business logic.

```typescript
// src/common/interceptors/retry.interceptor.ts

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Observable, throwError, timer } from 'rxjs';
import { retryWhen, mergeMap, catchError } from 'rxjs/operators';
import { RetryConfig } from '../retry/retry.types';

/**
 * A NestJS interceptor that wraps outbound HTTP calls with retry logic.
 *
 * Why an interceptor? Because retry logic is a cross-cutting concern.
 * It does not belong in business logic (the booking service should not
 * know about backoff algorithms), and it must be applied consistently
 * across all outbound calls.
 */
@Injectable()
export class RetryInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RetryInterceptor.name);

  constructor(private readonly config: RetryConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    let attempt = 0;
    let previousDelay = this.config.baseDelayMs;

    return next.handle().pipe(
      retryWhen((errors) =>
        errors.pipe(
          mergeMap((error) => {
            attempt++;

            // Do not retry permanent errors
            if (error instanceof HttpException) {
              const status = error.getStatus();
              const { shouldRetry } = shouldRetryHttpStatus(status);
              if (!shouldRetry) {
                return throwError(() => error);
              }
            }

            // Check if we have exhausted attempts
            if (attempt >= this.config.maxAttempts) {
              this.logger.error(
                `Retry exhausted after ${attempt} attempts: ${error.message}`,
              );
              return throwError(() => error);
            }

            // Calculate delay with jitter
            const exponentialDelay = Math.min(
              this.config.maxDelayMs,
              this.config.baseDelayMs * Math.pow(
                this.config.multiplier ?? 2,
                attempt - 1,
              ),
            );
            const delay = Math.floor(Math.random() * exponentialDelay); // Full jitter

            this.logger.warn(
              `Attempt ${attempt} failed, retrying in ${delay}ms: ${error.message}`,
            );

            previousDelay = delay;
            return timer(delay);
          }),
        ),
      ),
      catchError((error) => {
        // Final error — all retries exhausted or non-retryable error
        return throwError(() => error);
      }),
    );
  }
}
```

```typescript
// Using the interceptor with a custom decorator
// src/common/decorators/with-retry.decorator.ts

import { applyDecorators, UseInterceptors } from '@nestjs/common';
import { RetryInterceptor } from '../interceptors/retry.interceptor';
import { RetryConfig } from '../retry/retry.types';

/**
 * Decorator that applies retry logic to a controller method.
 * Use this for outbound calls that need automatic retry on transient failures.
 *
 * @example
 * @WithRetry({ maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 })
 * @Get('availability/:propertyId')
 * async checkAvailability(@Param('propertyId') id: string) { ... }
 */
export function WithRetry(config: RetryConfig) {
  return applyDecorators(
    UseInterceptors(new RetryInterceptor(config)),
  );
}
```

```typescript
// Controller usage
// src/booking/booking.controller.ts

import { Controller, Post, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { WithRetry } from '../common/decorators/with-retry.decorator';
import { BookingService } from './booking.service';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @WithRetry({
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
  })
  async createBooking(@Body() dto: CreateBookingDto) {
    return this.bookingService.create(dto);
  }
}
```

> **Checkpoint:** Your NestJS booking service calls three downstream services: payment (critical, user-facing), notification (non-critical, async), and analytics (non-critical, fire-and-forget). Should all three use the same retry interceptor configuration? (Answer: No. Payment needs aggressive retries with short delays because the user is waiting. Notification needs more retries with longer delays because email can wait. Analytics should not retry at all — dropping an analytics event is acceptable, but adding latency to the booking flow is not.)

---

## Retry with Dead Letter Queue Fallback

Sometimes retries are not enough. The downstream service might be down for minutes, and you cannot keep the user waiting. In these cases, you need a **dead letter queue (DLQ)** — a durable queue where failed operations are parked for later processing.

The pattern is: try immediately with retries, and if all retries fail, enqueue the operation for later. A background worker picks up DLQ items periodically and retries them with much longer intervals and more patience.

```typescript
// src/common/retry/retry-with-dlq.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { RetryService } from './retry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RetryConfig } from './retry.types';

interface DlqMessage {
  operationType: string;
  payload: Record<string, any>;
  originalError: string;
  maxDlqAttempts: number;
}

@Injectable()
export class RetryWithDlqService {
  private readonly logger = new Logger(RetryWithDlqService.name);
  private readonly retryService = new RetryService();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts an operation with retries. If all retries fail,
   * enqueues the operation in a dead letter queue for later processing.
   *
   * Why this pattern: Some operations (like sending confirmation emails
   * or processing refunds) MUST eventually succeed, but cannot block
   * the user's request. The DLQ ensures nothing is lost, even during
   * extended outages.
   */
  async executeWithDlqFallback<T>(
    operation: () => Promise<T>,
    retryConfig: RetryConfig,
    dlqConfig: {
      operationType: string;
      payload: Record<string, any>;
      maxDlqAttempts: number;
    },
  ): Promise<{ data: T; source: 'direct' } | { source: 'dlq'; dlqId: string }> {
    try {
      const result = await this.retryService.execute(operation, retryConfig);
      return { data: result.data, source: 'direct' };
    } catch (error) {
      this.logger.warn({
        message: 'All retries exhausted, enqueueing to DLQ',
        operationType: dlqConfig.operationType,
        error: (error as Error).message,
      });

      // Enqueue to the dead letter queue
      const dlqEntry = await this.prisma.deadLetterQueueItem.create({
        data: {
          operationType: dlqConfig.operationType,
          payload: JSON.stringify(dlqConfig.payload),
          originalError: (error as Error).message,
          maxAttempts: dlqConfig.maxDlqAttempts,
          attemptCount: 0,
          status: 'pending',
          nextAttemptAt: new Date(Date.now() + 60_000), // First DLQ retry in 1 minute
          createdAt: new Date(),
        },
      });

      return { source: 'dlq', dlqId: dlqEntry.id };
    }
  }
}
```

```typescript
// src/common/retry/dlq-processor.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class DlqProcessorService {
  private readonly logger = new Logger(DlqProcessorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Processes dead letter queue items every 30 seconds.
   * Uses exponential backoff between DLQ attempts:
   * 1min, 5min, 25min, 2hr, 10hr (capped).
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async processDlqItems(): Promise<void> {
    const items = await this.prisma.deadLetterQueueItem.findMany({
      where: {
        status: 'pending',
        nextAttemptAt: { lte: new Date() },
      },
      take: 10, // Process 10 items at a time
      orderBy: { nextAttemptAt: 'asc' },
    });

    for (const item of items) {
      try {
        // Route to the appropriate handler based on operation type
        await this.processItem(item);

        // Mark as completed
        await this.prisma.deadLetterQueueItem.update({
          where: { id: item.id },
          data: { status: 'completed', completedAt: new Date() },
        });

        this.logger.log(`DLQ item ${item.id} processed successfully`);
      } catch (error) {
        const newAttemptCount = item.attemptCount + 1;

        if (newAttemptCount >= item.maxAttempts) {
          // Permanently failed — alert operators
          await this.prisma.deadLetterQueueItem.update({
            where: { id: item.id },
            data: {
              status: 'failed',
              attemptCount: newAttemptCount,
              lastError: (error as Error).message,
              failedAt: new Date(),
            },
          });
          this.logger.error({
            message: `DLQ item ${item.id} permanently failed after ${newAttemptCount} attempts`,
            operationType: item.operationType,
            error: (error as Error).message,
          });
        } else {
          // Schedule next attempt with exponential backoff
          const nextDelayMs = Math.min(
            36_000_000, // Cap at 10 hours
            60_000 * Math.pow(5, newAttemptCount), // 1min, 5min, 25min, ...
          );
          await this.prisma.deadLetterQueueItem.update({
            where: { id: item.id },
            data: {
              attemptCount: newAttemptCount,
              lastError: (error as Error).message,
              nextAttemptAt: new Date(Date.now() + nextDelayMs),
            },
          });
        }
      }
    }
  }

  private async processItem(item: any): Promise<void> {
    const payload = JSON.parse(item.payload);
    switch (item.operationType) {
      case 'payment_charge':
        await this.processPaymentCharge(payload);
        break;
      case 'send_confirmation_email':
        await this.sendConfirmationEmail(payload);
        break;
      case 'sync_inventory':
        await this.syncInventory(payload);
        break;
      default:
        throw new Error(`Unknown DLQ operation type: ${item.operationType}`);
    }
  }

  private async processPaymentCharge(payload: any): Promise<void> {
    // Re-attempt the payment charge with idempotency key
    // Implementation delegates to payment service
  }

  private async sendConfirmationEmail(payload: any): Promise<void> {
    // Re-attempt sending the confirmation email
    // Implementation delegates to notification service
  }

  private async syncInventory(payload: any): Promise<void> {
    // Re-attempt synchronizing inventory counts
    // Implementation delegates to inventory service
  }
}
```

**Prisma schema for the dead letter queue:**

```prisma
// prisma/schema.prisma

model DeadLetterQueueItem {
  id             String    @id @default(uuid())
  operationType  String    // 'payment_charge' | 'send_confirmation_email' | etc.
  payload        String    @db.Text
  originalError  String    @db.Text
  lastError      String?   @db.Text
  maxAttempts    Int       @default(5)
  attemptCount   Int       @default(0)
  status         String    @default("pending") // 'pending' | 'completed' | 'failed'
  nextAttemptAt  DateTime
  completedAt    DateTime?
  failedAt       DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([status, nextAttemptAt])
  @@index([operationType])
  @@map("dead_letter_queue_items")
}
```

```typescript
// Prisma Client example: finding pending DLQ items ready for processing
const pendingItems = await prisma.deadLetterQueueItem.findMany({
  where: {
    status: 'pending',
    nextAttemptAt: { lte: new Date() },
  },
  take: 10,
  orderBy: { nextAttemptAt: 'asc' },
});

// Raw SQL equivalent:
// SELECT * FROM dead_letter_queue_items
// WHERE status = 'pending'
//   AND next_attempt_at <= NOW()
// ORDER BY next_attempt_at ASC
// LIMIT 10;
```

> **Analogy:** The DLQ is like the "undeliverable mail" bin at a post office. If a letter cannot be delivered after several attempts, it goes into a special bin where a dedicated worker reviews it, tries alternative delivery methods, and eventually either delivers it or flags it for human intervention. The letter is never lost.

---

## Monitoring Retries: Prometheus Metrics for Retry Rates

You cannot manage what you do not measure. If your services are silently retrying thousands of requests per minute, you have a problem you do not know about. Retry metrics are the early warning system for cascading failures.

### Essential Retry Metrics

```typescript
// src/common/metrics/retry.metrics.ts

import { Injectable } from '@nestjs/common';
import {
  Counter,
  Histogram,
  Gauge,
  register,
} from 'prom-client';

@Injectable()
export class RetryMetricsService {
  // Total number of retry attempts (counter — always goes up)
  private readonly retryAttempts = new Counter({
    name: 'retry_attempts_total',
    help: 'Total number of retry attempts',
    labelNames: ['service', 'operation', 'attempt_number', 'result'],
    // result: 'success' | 'failure' | 'budget_exhausted' | 'circuit_open'
  });

  // Duration of the entire retry sequence (including all delays)
  private readonly retryDuration = new Histogram({
    name: 'retry_duration_seconds',
    help: 'Total duration of retry sequences including delays',
    labelNames: ['service', 'operation', 'final_result'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  });

  // Current retry budget utilization (gauge — goes up and down)
  private readonly retryBudgetUtilization = new Gauge({
    name: 'retry_budget_utilization_ratio',
    help: 'Current retry-to-success ratio (0.0 to 1.0+)',
    labelNames: ['service'],
  });

  // Dead letter queue depth
  private readonly dlqDepth = new Gauge({
    name: 'dlq_items_pending',
    help: 'Number of pending items in the dead letter queue',
    labelNames: ['operation_type'],
  });

  // Number of requests that succeeded without any retries
  private readonly firstAttemptSuccess = new Counter({
    name: 'first_attempt_success_total',
    help: 'Requests that succeeded on the first attempt (no retries needed)',
    labelNames: ['service', 'operation'],
  });

  recordRetryAttempt(
    service: string,
    operation: string,
    attemptNumber: number,
    result: 'success' | 'failure' | 'budget_exhausted' | 'circuit_open',
  ): void {
    this.retryAttempts.inc({
      service,
      operation,
      attempt_number: String(attemptNumber),
      result,
    });
  }

  recordRetryDuration(
    service: string,
    operation: string,
    durationMs: number,
    finalResult: 'success' | 'exhausted' | 'aborted',
  ): void {
    this.retryDuration.observe(
      { service, operation, final_result: finalResult },
      durationMs / 1000,
    );
  }

  updateBudgetUtilization(service: string, ratio: number): void {
    this.retryBudgetUtilization.set({ service }, ratio);
  }

  updateDlqDepth(operationType: string, depth: number): void {
    this.dlqDepth.set({ operation_type: operationType }, depth);
  }

  recordFirstAttemptSuccess(service: string, operation: string): void {
    this.firstAttemptSuccess.inc({ service, operation });
  }
}
```

### Alerting Rules

```yaml
# prometheus/alerts/retry-alerts.yml

groups:
  - name: retry_alerts
    rules:
      # Alert when retry rate exceeds 5% of total requests
      - alert: HighRetryRate
        expr: |
          rate(retry_attempts_total{result="failure"}[5m])
          /
          rate(retry_attempts_total[5m])
          > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High retry rate for {{ $labels.service }}"
          description: >
            Service {{ $labels.service }} operation {{ $labels.operation }}
            has a retry failure rate of {{ $value | humanizePercentage }}
            over the last 5 minutes. This indicates a degraded downstream dependency.

      # Alert when retry budget is nearly exhausted
      - alert: RetryBudgetNearExhaustion
        expr: retry_budget_utilization_ratio > 0.08
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Retry budget nearly exhausted for {{ $labels.service }}"
          description: >
            The retry budget for {{ $labels.service }} is at
            {{ $value | humanizePercentage }} utilization (threshold: 10%).
            If this continues, retries will be throttled.

      # Alert when DLQ has items older than 1 hour
      - alert: DlqItemsStale
        expr: dlq_items_pending > 0
        for: 60m
        labels:
          severity: critical
        annotations:
          summary: "Dead letter queue items pending for over 1 hour"
          description: >
            There are {{ $value }} pending items in the DLQ for
            {{ $labels.operation_type }}. These operations have not been
            processed despite multiple retry attempts.
```

---

## Prisma Schema for Retry Event Tracking

For debugging and post-incident analysis, we store every retry event in the database. This creates an audit trail that lets you answer questions like "how many retries happened during last Tuesday's outage?" and "which service caused the most retries last month?"

```prisma
// prisma/schema.prisma

model RetryEvent {
  id             String   @id @default(uuid())
  serviceName    String   // 'payment-service', 'inventory-service', etc.
  operationName  String   // 'charge', 'checkAvailability', etc.
  attemptNumber  Int      // 1, 2, 3, ...
  maxAttempts    Int      // Total allowed attempts
  delayMs        Int      // How long we waited before this attempt
  errorMessage   String   @db.Text
  errorCode      String?  // HTTP status or error code
  result         String   // 'retry' | 'success' | 'exhausted' | 'aborted'
  bookingId      String?  // Optional link to the booking that triggered this
  correlationId  String   // For tracing across services
  createdAt      DateTime @default(now())

  booking        Booking? @relation(fields: [bookingId], references: [id])

  @@index([serviceName, createdAt])
  @@index([bookingId])
  @@index([correlationId])
  @@index([result, createdAt])
  @@map("retry_events")
}
```

```typescript
// Prisma Client: recording a retry event
await prisma.retryEvent.create({
  data: {
    serviceName: 'payment-service',
    operationName: 'charge',
    attemptNumber: 2,
    maxAttempts: 4,
    delayMs: 450,
    errorMessage: 'ECONNRESET: Connection reset by peer',
    errorCode: 'ECONNRESET',
    result: 'retry',
    bookingId: 'booking-abc-123',
    correlationId: 'trace-xyz-789',
  },
});

// Raw SQL equivalent:
// INSERT INTO retry_events
//   (id, service_name, operation_name, attempt_number, max_attempts,
//    delay_ms, error_message, error_code, result, booking_id,
//    correlation_id, created_at)
// VALUES
//   (UUID() -- or use application-generated UUID, 'payment-service', 'charge', 2, 4,
//    450, 'ECONNRESET: Connection reset by peer', 'ECONNRESET',
//    'retry', 'booking-abc-123', 'trace-xyz-789', NOW());
```

```typescript
// Prisma Client: querying retry events for analysis
// "How many retries happened per service in the last hour?"
const retryCountsByService = await prisma.retryEvent.groupBy({
  by: ['serviceName'],
  where: {
    createdAt: { gte: new Date(Date.now() - 3_600_000) },
  },
  _count: { id: true },
  orderBy: { _count: { id: 'desc' } },
});

// Raw SQL equivalent:
// SELECT service_name, COUNT(id) as retry_count
// FROM retry_events
// WHERE created_at >= NOW() - INTERVAL '1 hour'
// GROUP BY service_name
// ORDER BY retry_count DESC;
```

```typescript
// Prisma Client: finding all retry events for a specific booking
const bookingRetries = await prisma.retryEvent.findMany({
  where: { bookingId: 'booking-abc-123' },
  orderBy: { createdAt: 'asc' },
});

// Raw SQL equivalent:
// SELECT * FROM retry_events
// WHERE booking_id = 'booking-abc-123'
// ORDER BY created_at ASC;
```

> **What If You Skip This?** Without retry event tracking, your incident retrospectives become guesswork. "We think the payment service was slow, which caused retries, which caused more slowness" is not actionable. "Between 14:32 and 14:47 UTC, the booking service generated 12,847 retries against payment-service, with a peak of 340 retries per second at 14:38, which exceeded the retry budget at 14:39 and triggered the circuit breaker at 14:40" — that is actionable.

---

## Production War Story: The Retry Storm That Took Down Black Friday

This happened at a travel booking company (anonymized, but the details are real). The lesson cost $2.3 million in lost revenue.

### The Setup

The booking system had three services: **booking-service**, **pricing-service**, and **payment-service**. The booking service called pricing to get the final price, then called payment to charge the customer.

All three services used retries. The retry configuration was identical across all services:

```typescript
// The configuration that caused the outage
const RETRY_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 100,
  multiplier: 2,
  maxDelayMs: 30_000,
  jitter: 'none',  // ← Problem 1: No jitter
};
```

There was no retry budget. There was no circuit breaker. There was no error classification — all errors were retried, including 400 Bad Request.

### The Trigger

At 09:00 on Black Friday, the pricing service received a deployment that introduced a subtle bug: for certain room types, the pricing calculation returned a negative number, which the payment service rejected with a `422 Unprocessable Entity`.

The error affected approximately 8% of requests — those involving the "suite" room type.

### The Cascade

1. **09:00** — 8% of pricing responses return invalid data. Payment service returns 422 for these.
2. **09:00** — Booking service retries every 422. Five attempts per request, 100ms apart (no jitter). The 8% error rate generates 40% additional load on the payment service.
3. **09:02** — Payment service, now handling 140% of normal load, starts timing out on legitimate requests. Error rate climbs from 8% to 25%.
4. **09:03** — 25% error rate with 5 retries each. Booking service is now generating 125% additional load. Request queues fill up on all services.
5. **09:05** — Payment service hits 100% CPU. All requests time out. Error rate: 100%.
6. **09:05** — Booking service retries every single request 5 times. Total request volume is 6x normal.
7. **09:06** — Pricing service, overwhelmed by the retry traffic, goes down.
8. **09:07** — Booking service is now retrying against **two** down services. Request threads are exhausted. Health checks fail.
9. **09:08** — Load balancer marks all booking-service instances as unhealthy. **All three services are down.**
10. **09:08 to 09:47** — The on-call engineer discovers the outage, identifies the cause, and rolls back the pricing service deployment. But the retry storm has filled every request queue. Even after the rollback, it takes 20 minutes for the queues to drain and the services to stabilize.

Total outage duration: **47 minutes** on Black Friday morning.

### What Should Have Been Different

| Problem | Fix |
|---------|-----|
| No jitter | Full jitter would have spread retries evenly instead of synchronized bursts |
| No error classification | 422 is a permanent error — retrying it was pointless and harmful |
| 5 retries for all services | Payment should have had 3 attempts max; pricing should have had 2 |
| No retry budget | A 10% retry budget would have capped retry traffic at 10% of normal load |
| No circuit breaker | After 10 failures, the circuit should have opened and failed fast |
| Identical config everywhere | Each service-to-service call has different requirements |
| No monitoring | Nobody noticed the retry rate climbing until the entire system was down |

> **Mentor's Note:** This is not an unusual story. Retry storms are the most common cause of cascading failures in microservice architectures. Every single fix in the table above is covered in this chapter. If you implement all of them, you will not have this outage. If you skip even one, you are vulnerable.

---

## Common Mistakes with Retries

### Mistake 1: Retrying Without Idempotency

```typescript
// WRONG — retrying a non-idempotent operation
async function createBooking(data: BookingData) {
  return retryService.execute(
    () => bookingApi.post('/bookings', data), // No idempotency key!
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 },
  );
}
// If the first attempt succeeds but the response times out,
// the retry creates a SECOND booking.
```

```typescript
// CORRECT — always include an idempotency key for mutating operations
async function createBooking(data: BookingData) {
  return retryService.execute(
    () => bookingApi.post('/bookings', data, {
      headers: { 'Idempotency-Key': `booking-${data.guestId}-${data.checkIn}` },
    }),
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5000 },
  );
}
```

### Mistake 2: Retrying Permanent Errors

```typescript
// WRONG — retrying a 404
async function getProperty(id: string) {
  return retryService.execute(
    () => propertyApi.get(`/properties/${id}`),
    {
      maxAttempts: 5,      // Will retry 5 times
      baseDelayMs: 200,
      maxDelayMs: 10_000,
      isRetryable: () => true,  // Retries everything, including 404
    },
  );
}
// The property does not exist. Retrying 5 times just wastes resources.
```

```typescript
// CORRECT — only retry transient errors
async function getProperty(id: string) {
  return retryService.execute(
    () => propertyApi.get(`/properties/${id}`),
    {
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 5_000,
      isRetryable: (error) => classifyError(error) !== 'permanent',
    },
  );
}
```

### Mistake 3: No Maximum Delay Cap

```typescript
// WRONG — unbounded exponential growth
function calculateDelay(attempt: number): number {
  return 200 * Math.pow(2, attempt); // Attempt 20 = 209,715,200ms = 58 HOURS
}
```

```typescript
// CORRECT — always cap the maximum delay
function calculateDelay(attempt: number): number {
  return Math.min(30_000, 200 * Math.pow(2, attempt)); // Never exceeds 30 seconds
}
```

### Mistake 4: Using the Same Config for All Services

```typescript
// WRONG — one-size-fits-all
const UNIVERSAL_RETRY = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

// Payment call — 500ms base delay is too high (user is waiting)
await retryService.execute(() => paymentApi.charge(data), UNIVERSAL_RETRY);

// Background analytics — 3 attempts is too many (not worth the resources)
await retryService.execute(() => analyticsApi.track(event), UNIVERSAL_RETRY);
```

### Mistake 5: Retrying Inside Retries (Retry Amplification)

```typescript
// WRONG — nested retries create exponential amplification
async function bookRoom(data: BookingData) {
  return retryService.execute(           // Outer: 3 attempts
    () => callBookingService(data),      // Inner (inside callBookingService):
    { maxAttempts: 3 },                  // Also 3 attempts
  );                                     // Total: up to 9 attempts
}

async function callBookingService(data: BookingData) {
  return retryService.execute(           // This is INSIDE the outer retry
    () => httpClient.post('/bookings', data),
    { maxAttempts: 3 },
  );
}
// If there are 3 layers with 3 retries each: 3^3 = 27 total attempts!
```

```typescript
// CORRECT — retry at only one layer (typically the outermost)
async function bookRoom(data: BookingData) {
  return retryService.execute(
    () => httpClient.post('/bookings', data), // Direct call, no inner retry
    { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 5_000 },
  );
}
```

### Mistake 6: Not Respecting Retry-After Headers

```typescript
// WRONG — ignoring the server's explicit instruction
async function callRateLimitedApi() {
  return retryService.execute(
    () => externalApi.get('/data'),
    { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5_000 }, // Ignores Retry-After
  );
}
// If the server says "Retry-After: 60", and you retry in 100ms,
// you will get rate-limited again. And again. And again.
```

```typescript
// CORRECT — respect the Retry-After header
async function callRateLimitedApi() {
  return retryService.execute(
    () => externalApi.get('/data'),
    {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 120_000,
      onRetry: (error, attempt, delay) => {
        const retryAfter = error.response?.headers?.['retry-after'];
        if (retryAfter) {
          const waitMs = parseInt(retryAfter, 10) * 1000;
          // Override the calculated delay with the server's instruction
          return waitMs;
        }
      },
    },
  );
}
```

---

## Chapter Summary

| Concept | What It Does | When to Use It | Key Takeaway |
|---------|-------------|----------------|--------------|
| **Error classification** | Categorizes errors as transient or permanent | Before every retry decision | Never retry permanent errors (400, 401, 404). Always retry transient errors (429, 502, 503, 504). |
| **Exponential backoff** | Increases delay between retries: `baseDelay * multiplier^attempt` | Every delayed retry | Matches the recovery profile of real systems. Always cap with `maxDelay`. |
| **Jitter** | Adds randomness to retry delays | Always (use full jitter as default) | Prevents thundering herd. Without jitter, all clients retry at the same time. |
| **Retry budget** | Limits total retries to a percentage of successful requests | Service level | Prevents a failing service from being overwhelmed by retry traffic. Google recommends 10%. |
| **Idempotency keys** | Ensures retrying a request does not duplicate its side effects | Every mutating operation that can be retried | Without idempotency, retries cause double charges, duplicate bookings, and data corruption. |
| **Circuit breaker** | Stops all requests to a failing service after a failure threshold | Wraps the entire retry sequence | Provides fast failure during sustained outages. Retry handles transient errors; circuit breaker handles sustained errors. |
| **Dead letter queue** | Parks failed operations for later processing | Operations that must eventually succeed | Ensures no operation is permanently lost, even during extended outages. |
| **Retry-After header** | Server tells the client exactly when to retry | 429 and 503 responses | Always respect this header. Ignoring it leads to repeated rate-limiting. |
| **Retry monitoring** | Tracks retry rates, durations, and outcomes via Prometheus | Always | You cannot fix what you cannot see. Retry metrics are the early warning system for cascading failures. |
| **Retry event tracking** | Stores every retry event in the database for post-incident analysis | Production systems | Turns incident retrospectives from guesswork into data-driven analysis. |

### The Hierarchy of Retry Safety

If you implement nothing else from this chapter, implement these in order:

1. **Classify errors** — Stop retrying permanent errors. This alone prevents the majority of retry-related outages.
2. **Add exponential backoff with full jitter** — Space out retries and break synchronization.
3. **Add idempotency keys** — Make retries safe for mutating operations.
4. **Add a retry budget** — Prevent your service from generating excessive retry traffic.
5. **Add a circuit breaker** — Stop retrying during sustained outages.
6. **Add monitoring** — See retries happening before they become outages.
7. **Add a dead letter queue** — Ensure critical operations eventually complete.

Each layer builds on the previous one. Step 1 without step 2 still causes synchronized bursts. Step 2 without step 3 still causes duplicate operations. Step 3 without step 4 still allows retry storms. The complete stack makes your system resilient to the kinds of failures that take down real production systems on the busiest day of the year.

> **Final Thought:** Retries are the most deceptively simple concept in distributed systems. A `for` loop with a `catch` block takes 5 lines of code. The production-grade version takes 500. The difference between those two implementations is the difference between a system that shrugs off a network blip and a system that turns a network blip into a 47-minute outage on Black Friday. There are no shortcuts here — understand every concept in this chapter, implement every layer, and test it before you need it.
