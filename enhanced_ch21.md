# Chapter 21: Circuit Breaker & Bulkhead — Containing the Blast

## The Problem You Do Not Know You Have

Right now, when you call an external API from your NestJS code, you probably write something like this:

```typescript
const response = await fetch('https://supplier-api.example.com/book', {
  method: 'POST',
  body: JSON.stringify(bookingData),
});
const result = await response.json();
```

And you move on. It works in development against a local mock. It works in staging against a healthy API. So you ship it.

Then, at 2 AM on a Saturday, the supplier API starts responding in 45 seconds instead of 200 milliseconds. Your `await` hangs. Every incoming booking request stacks up behind that slow call. Your Node.js event loop is blocked with hundreds of pending promises. Your database connection pool fills up because those in-flight requests are also holding database connections. Your health check endpoint stops responding. Kubernetes declares your pod unhealthy and kills it. The replacement pod starts, immediately gets swamped by the same traffic, and dies too. Your entire booking service is down -- not because *your* code has a bug, but because *someone else's* API got slow.

This is called **cascading failure**, and it is one of the most common ways distributed systems die. A single unhealthy dependency drags down everything that touches it, and then everything that touches *those* services, like dominoes falling in a chain.

This chapter teaches you two patterns that prevent this: the **Circuit Breaker** and the **Bulkhead**. Together, they contain the blast radius of downstream failures so that one sick dependency cannot sink your entire system. By the end of this chapter, you will have built both patterns from scratch, integrated them into NestJS as interceptors and decorators, wired them to Prometheus dashboards, and tested them with fault injection. No hand-waving, no toy demos -- production-grade resilience for our 100K-bookings-per-minute system.

---

## Why Cascading Failures Happen in Microservices

Before we build the solution, you need to deeply understand the problem. Cascading failures are not theoretical -- they are the number one killer of microservice architectures in production.

### The Domino Effect, Step by Step

Let us trace exactly how a single slow supplier API takes down an entire booking platform. Each step is what actually happens inside your Node.js process, your connection pools, and your Kubernetes cluster.

```
Timeline of a Cascading Failure:

T+0s    Supplier API latency spikes from 200ms to 45s
        (cause: their database is running a full table scan)

T+5s    Your booking-service has 25 in-flight requests to supplier
        Each is holding: 1 HTTP connection + 1 DB connection + ~2MB heap

T+15s   Your booking-service has 75 in-flight requests to supplier
        HTTP connection pool (max 100): 75% consumed by supplier calls
        DB connection pool (max 50): 40 connections held by waiting requests

T+30s   Your booking-service has 150 in-flight requests queued
        HTTP connection pool: EXHAUSTED
        DB connection pool: EXHAUSTED
        New requests to inventory, payments, notifications: BLOCKED
        Event loop lag: 2,400ms and climbing

T+45s   Kubernetes health check (GET /health) times out
        Pod marked as unhealthy, traffic rerouted to remaining pods

T+50s   Remaining pods now receive 2x traffic, accelerating the same failure
        Users see 504 Gateway Timeout across ALL booking features

T+60s   All booking-service pods are dead
        API Gateway returns 503 for everything
        Search, payments, notifications -- all down

T+90s   Payment-service, which calls booking-service for validation,
        starts failing too. Its request queues fill up.

T+120s  Notification-service, which listens for booking events, has
        a backlog of 50,000 unprocessed messages. Memory pressure
        causes OOM kills.

T+180s  Complete platform outage. Root cause: one supplier's slow DB query.
```

Notice the progression. The failure does not jump from "supplier is slow" to "everything is down" in one step. It cascades through layers, each layer amplifying the problem. This is why the pattern is called "cascading failure" -- it is a cascade, a waterfall of failures where each level feeds the next.

> **Key Term:** **Cascading failure** -- A failure mode in distributed systems where one unhealthy dependency causes its callers to exhaust their resources (connections, threads, memory), making them unhealthy too, which in turn causes *their* callers to fail, spreading outward like falling dominoes. The critical insight is that the original dependency does not even need to be *down* -- it only needs to be *slow*.

### The Five Root Causes

Cascading failures always start with one of these five root causes. Understanding them helps you configure your circuit breakers correctly:

| Root Cause | Example | Why It Cascades |
|---|---|---|
| **Slow responses** | Supplier API responds in 30s instead of 200ms | Callers hold connections and memory while waiting |
| **Error storms** | Payment gateway returns 500 on every request | Callers retry aggressively, multiplying load |
| **Resource exhaustion** | Database connection pool drained | Subsequent requests queue up, consuming thread/memory |
| **Timeout misconfiguration** | HTTP client timeout set to 120s (default) | Each failed call wastes 2 minutes of resources |
| **Retry amplification** | 3 replicas each retry 3 times = 9x original load | Failing service gets hammered harder the sicker it gets |

> **Common Mistake:** Setting your HTTP client timeout to the default (often 30-120 seconds). In a microservice that handles 1,000 requests per second, a 30-second timeout means you can accumulate 30,000 hanging requests before the first one even times out. Always set explicit, aggressive timeouts: 2-5 seconds for synchronous calls in the request path.

### Why Retries Make It Worse

Your instinct when a call fails is to retry it. This is correct for transient errors (a single dropped packet, a momentary network blip). But during a cascading failure, retries are gasoline on a fire.

Consider: your booking service sends 100 requests per second to the supplier API. The supplier is overloaded and starts failing 80% of requests. Without retries, the supplier receives 100 req/s. With 3 retries per failure, the supplier now receives:

```
100 original + (80 failures x 3 retries) = 340 requests per second
```

You have more than tripled the load on a service that was already drowning. This is **retry amplification**, and it is one of the most common reasons cascading failures become total outages instead of partial degradations.

> **Analogy:** Imagine a restaurant kitchen is backed up and orders are coming out late. The waiters respond by resubmitting every order three times. Now the kitchen has 4x the tickets, which makes it even slower, which causes more resubmissions. The correct response is to stop taking new orders temporarily and let the kitchen catch up. That is what a circuit breaker does.

---

## The Circuit Breaker Pattern

### The Three States: A Complete State Machine

A circuit breaker is a finite state machine with exactly three states. Understanding the transitions between them is the key to understanding everything that follows.

```
                        ┌──────────────────────────────────────────┐
                        │         CIRCUIT BREAKER STATE MACHINE     │
                        └──────────────────────────────────────────┘

    ┌─────────────┐          failure threshold          ┌─────────────┐
    │             │          exceeded                    │             │
    │   CLOSED    │────────────────────────────────────>│    OPEN     │
    │  (normal)   │                                     │  (tripped)  │
    │             │                                     │             │
    └─────────────┘                                     └──────┬──────┘
          ^                                                    │
          │                                                    │
          │ probe succeeds                      reset timeout  │
          │ (+ success threshold                expires        │
          │   met in HALF_OPEN)                                │
          │                                                    v
          │                                             ┌─────────────┐
          │                                             │             │
          └─────────────────────────────────────────────│  HALF_OPEN  │
                                                        │  (probing)  │
                                                        │             │
                                                        └──────┬──────┘
                                                               │
                                                               │ probe fails
                                                               │
                                                               └──> back to OPEN
                                                                    (timer restarts)
```

Let us define each state precisely, including what data the breaker tracks in each state:

**CLOSED (Normal Operation)**

This is the default, happy-path state. Every request passes through to the downstream service. The breaker silently maintains a **sliding window** of recent call results in the background. Think of this as your kitchen breaker switch in the "ON" position -- electricity flows normally, but the breaker is monitoring the current.

In CLOSED state, the breaker tracks:
- A sliding window of the last N calls (or calls within the last N seconds)
- The count of failures within that window
- The count of slow calls within that window (calls that succeeded but exceeded a latency threshold)
- Whether the minimum volume threshold has been met (to avoid tripping on tiny sample sizes)

**OPEN (Failing -- Do Not Even Try)**

When the failure rate crosses a threshold (for example, 50% of the last 20 calls failed), the breaker trips to OPEN. In this state, **no requests are sent to the downstream service at all**. Instead, every call immediately gets a fallback response or an error. This happens in microseconds -- no network call, no timeout, no wasted connections. A timer starts counting down (say, 30 seconds).

Why is this a good thing? Two reasons:
1. **It protects your service** from wasting resources on calls that will almost certainly fail.
2. **It protects the downstream service** by giving it breathing room to recover instead of hammering it with more requests.

> **Analogy:** A circuit breaker in code works like the breaker box in your house. When one circuit (a downstream service) is overloaded or shorted out, the breaker trips and cuts it off -- protecting the rest of your system from catching fire. You do not keep flipping the light switch when the breaker has tripped; you wait, check if the problem is fixed, and then flip the breaker back on.

**HALF-OPEN (Testing Recovery)**

When the timer expires, the breaker moves to HALF-OPEN. It lets a small number of **probe requests** through to the downstream service. If those probes succeed (meeting a configurable success threshold), the breaker assumes the service has recovered and moves back to CLOSED, resetting all counters. If any probe fails, the breaker goes back to OPEN and the timer restarts.

This is you cautiously flipping the kitchen breaker back on to see if the problem is fixed, rather than slamming it on and hoping for the best.

In HALF-OPEN state, the breaker tracks:
- The number of probe requests permitted (e.g., 3)
- The number of probes that have succeeded so far
- The number of probes that have failed so far

> **Key Term:** **Circuit Breaker** -- A resilience pattern that monitors calls to a downstream service and "trips open" when failures exceed a threshold, preventing further calls until the service recovers. It operates as a three-state machine: CLOSED (normal), OPEN (rejecting all calls), and HALF-OPEN (testing recovery with limited probe requests).

### State Transition Rules

Here are the precise rules governing every state transition. When you build your own circuit breaker (which we will do next), these rules are your specification:

| From State | To State | Trigger |
|---|---|---|
| CLOSED | OPEN | Failure rate >= `failureRateThreshold` AND call count >= `minimumCallCount` |
| CLOSED | OPEN | Slow call rate >= `slowCallRateThreshold` AND call count >= `minimumCallCount` |
| OPEN | HALF_OPEN | `resetTimeout` duration has elapsed since entering OPEN |
| HALF_OPEN | CLOSED | `successThresholdInHalfOpen` consecutive successes observed |
| HALF_OPEN | OPEN | Any single failure observed (conservative) or failure threshold exceeded |

> **Why Not a Two-State Breaker (just CLOSED and OPEN)?** Without HALF-OPEN, you would need to either (a) manually reset the breaker, requiring human intervention at 2 AM, or (b) use a timer that simply slams the breaker shut after N seconds, potentially routing a flood of traffic to a service that has not recovered. HALF-OPEN gives you automatic recovery detection with minimal risk: test with one or two requests before committing to full traffic.

> **Checkpoint:** Can you trace what happens in the following scenario? The breaker is CLOSED. In a window of 20 calls, 12 fail. The failure threshold is 50%. The minimum call count is 10. Walk through the state transitions. Answer: 12/20 = 60% failure rate, which exceeds 50%, and 20 >= 10 minimum calls, so the breaker transitions to OPEN. After `resetTimeout` expires, it moves to HALF_OPEN. A single probe is sent. If it succeeds, it returns to CLOSED. If it fails, back to OPEN.

---

## Building a Circuit Breaker from Scratch in TypeScript

Understanding opossum (which we will use in production) is much easier once you have built a circuit breaker yourself. This implementation is not a toy -- it uses sliding windows, configurable thresholds, and proper state management. You could run this in production, though we recommend opossum for its battle-tested edge case handling.

### The Configuration Interface

Every circuit breaker needs a configuration object. Let us define exactly what knobs we need:

```typescript
// circuit-breaker/types.ts

export enum CircuitBreakerState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  /** Name for logging and metrics */
  name: string;

  /** Number of calls to keep in the sliding window */
  slidingWindowSize: number;

  /** Minimum number of calls before evaluating failure rate */
  minimumCallCount: number;

  /** Failure rate threshold (0-100) to trip the breaker */
  failureRateThreshold: number;

  /** Slow call rate threshold (0-100) to trip the breaker */
  slowCallRateThreshold: number;

  /** Duration in ms above which a call is considered "slow" */
  slowCallDurationThreshold: number;

  /** How long (ms) to stay in OPEN before moving to HALF_OPEN */
  resetTimeout: number;

  /** Number of permitted probe calls in HALF_OPEN state */
  permittedCallsInHalfOpen: number;

  /** Optional fallback function */
  fallback?: (...args: any[]) => any;
}

export const DEFAULT_CONFIG: Omit<CircuitBreakerConfig, 'name'> = {
  slidingWindowSize: 20,
  minimumCallCount: 10,
  failureRateThreshold: 50,
  slowCallRateThreshold: 80,
  slowCallDurationThreshold: 5000,
  resetTimeout: 30000,
  permittedCallsInHalfOpen: 3,
};

export interface CallResult {
  success: boolean;
  duration: number;
  timestamp: number;
}
```

Each configuration option maps directly to a concept we discussed in the state transition rules. The `slidingWindowSize` determines how many recent calls we consider when calculating failure rates. The `minimumCallCount` prevents premature tripping on small samples. The `slowCallDurationThreshold` lets us detect services that are technically succeeding but dangerously slow.

### The Sliding Window

The sliding window is the circuit breaker's memory. It remembers the last N call results and calculates failure and slow-call rates from them:

```typescript
// circuit-breaker/sliding-window.ts

import { CallResult } from './types';

export class SlidingWindow {
  private results: CallResult[] = [];

  constructor(private readonly maxSize: number) {}

  record(result: CallResult): void {
    this.results.push(result);
    if (this.results.length > this.maxSize) {
      this.results.shift(); // Remove the oldest entry
    }
  }

  getFailureRate(): number {
    if (this.results.length === 0) return 0;
    const failures = this.results.filter(r => !r.success).length;
    return (failures / this.results.length) * 100;
  }

  getSlowCallRate(durationThreshold: number): number {
    if (this.results.length === 0) return 0;
    const slowCalls = this.results.filter(
      r => r.success && r.duration > durationThreshold
    ).length;
    return (slowCalls / this.results.length) * 100;
  }

  getCallCount(): number {
    return this.results.length;
  }

  reset(): void {
    this.results = [];
  }
}
```

> **Why Not a Time-Based Window?** We use a count-based sliding window (last N calls) instead of a time-based window (calls in the last N seconds) because it is simpler and works better for services with variable traffic. A time-based window can give misleading rates during low-traffic periods. Production libraries like resilience4j offer both options; for our implementation, count-based is clearer to understand and sufficient for most use cases.

### The CircuitBreaker Class

Now we build the core state machine. Read this implementation carefully -- every method maps to a state transition rule from the table above. This is not pseudocode; you can paste this into your project and it will work.

```typescript
// circuit-breaker/circuit-breaker.ts

import { EventEmitter } from 'events';
import {
  CircuitBreakerState,
  CircuitBreakerConfig,
  DEFAULT_CONFIG,
  CallResult,
} from './types';
import { SlidingWindow } from './sliding-window';

export class CircuitBreaker extends EventEmitter {
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private readonly window: SlidingWindow;
  private readonly config: CircuitBreakerConfig;

  // OPEN state tracking
  private openedAt: number = 0;
  private resetTimer: NodeJS.Timeout | null = null;

  // HALF_OPEN state tracking
  private halfOpenSuccesses: number = 0;
  private halfOpenFailures: number = 0;
  private halfOpenCallCount: number = 0;

  constructor(config: Partial<CircuitBreakerConfig> & { name: string }) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.window = new SlidingWindow(this.config.slidingWindowSize);
  }

  /**
   * Execute a function through the circuit breaker.
   * This is the primary API -- wrap any async call with this method.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Step 1: Check if the call is permitted in the current state
    if (!this.isCallPermitted()) {
      this.emit('rejected', { state: this.state, name: this.config.name });

      if (this.config.fallback) {
        return this.config.fallback();
      }
      throw new CircuitBreakerOpenError(
        `Circuit breaker "${this.config.name}" is ${this.state}. ` +
        `Call rejected to protect downstream service.`
      );
    }

    // Step 2: Execute the function and record the result
    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      this.recordSuccess(duration);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordFailure(duration);
      throw error;
    }
  }

  /**
   * Determines whether a call is permitted based on the current state.
   */
  private isCallPermitted(): boolean {
    switch (this.state) {
      case CircuitBreakerState.CLOSED:
        return true; // Always permit in CLOSED

      case CircuitBreakerState.OPEN:
        // Check if reset timeout has elapsed
        if (Date.now() - this.openedAt >= this.config.resetTimeout) {
          this.transitionTo(CircuitBreakerState.HALF_OPEN);
          return true; // Permit as first probe in HALF_OPEN
        }
        return false; // Still in timeout period

      case CircuitBreakerState.HALF_OPEN:
        // Only permit up to the configured number of probe calls
        return this.halfOpenCallCount < this.config.permittedCallsInHalfOpen;

      default:
        return false;
    }
  }

  /**
   * Record a successful call and evaluate state transitions.
   */
  private recordSuccess(duration: number): void {
    const result: CallResult = {
      success: true,
      duration,
      timestamp: Date.now(),
    };

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      this.halfOpenCallCount++;
      this.emit('halfOpenProbe', {
        success: true,
        successes: this.halfOpenSuccesses,
        required: this.config.permittedCallsInHalfOpen,
      });

      // If we have enough successes, close the breaker
      if (this.halfOpenSuccesses >= this.config.permittedCallsInHalfOpen) {
        this.transitionTo(CircuitBreakerState.CLOSED);
      }
    } else {
      // CLOSED state: record in sliding window and evaluate
      this.window.record(result);
      this.evaluateWindow();
    }

    this.emit('success', { duration, state: this.state });
  }

  /**
   * Record a failed call and evaluate state transitions.
   */
  private recordFailure(duration: number): void {
    const result: CallResult = {
      success: false,
      duration,
      timestamp: Date.now(),
    };

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenFailures++;
      this.halfOpenCallCount++;
      this.emit('halfOpenProbe', { success: false });

      // Any failure in HALF_OPEN sends us back to OPEN
      this.transitionTo(CircuitBreakerState.OPEN);
    } else {
      // CLOSED state: record in sliding window and evaluate
      this.window.record(result);
      this.evaluateWindow();
    }

    this.emit('failure', { duration, state: this.state });
  }

  /**
   * Evaluate the sliding window metrics and decide whether to trip.
   */
  private evaluateWindow(): void {
    if (this.state !== CircuitBreakerState.CLOSED) return;
    if (this.window.getCallCount() < this.config.minimumCallCount) return;

    const failureRate = this.window.getFailureRate();
    const slowCallRate = this.window.getSlowCallRate(
      this.config.slowCallDurationThreshold
    );

    if (failureRate >= this.config.failureRateThreshold) {
      this.emit('tripReason', {
        reason: 'failure_rate',
        rate: failureRate,
        threshold: this.config.failureRateThreshold,
      });
      this.transitionTo(CircuitBreakerState.OPEN);
    } else if (slowCallRate >= this.config.slowCallRateThreshold) {
      this.emit('tripReason', {
        reason: 'slow_call_rate',
        rate: slowCallRate,
        threshold: this.config.slowCallRateThreshold,
      });
      this.transitionTo(CircuitBreakerState.OPEN);
    }
  }

  /**
   * Transition to a new state with proper cleanup and initialization.
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;

    // Cleanup old state
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Initialize new state
    switch (newState) {
      case CircuitBreakerState.OPEN:
        this.openedAt = Date.now();
        // Set a timer to automatically transition to HALF_OPEN
        this.resetTimer = setTimeout(() => {
          if (this.state === CircuitBreakerState.OPEN) {
            this.transitionTo(CircuitBreakerState.HALF_OPEN);
          }
        }, this.config.resetTimeout);
        break;

      case CircuitBreakerState.HALF_OPEN:
        this.halfOpenSuccesses = 0;
        this.halfOpenFailures = 0;
        this.halfOpenCallCount = 0;
        break;

      case CircuitBreakerState.CLOSED:
        this.window.reset();
        break;
    }

    this.emit('stateChange', {
      from: oldState,
      to: newState,
      name: this.config.name,
      timestamp: Date.now(),
    });
  }

  /** Get the current state (for monitoring/testing). */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /** Get current metrics snapshot. */
  getMetrics() {
    return {
      state: this.state,
      failureRate: this.window.getFailureRate(),
      slowCallRate: this.window.getSlowCallRate(
        this.config.slowCallDurationThreshold
      ),
      callCount: this.window.getCallCount(),
      halfOpenSuccesses: this.halfOpenSuccesses,
      halfOpenCallCount: this.halfOpenCallCount,
    };
  }

  /** Force the breaker to a specific state (for testing only). */
  forceState(state: CircuitBreakerState): void {
    this.transitionTo(state);
  }
}

/** Custom error thrown when a call is rejected by an open circuit breaker. */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}
```

Study the `execute` method. It is deliberately simple: check if the call is permitted, run the function, record the outcome. All the intelligence is in `isCallPermitted`, `recordSuccess`, `recordFailure`, and `evaluateWindow`. Each of those methods does exactly one thing, which makes the state machine easy to reason about and debug.

> **Checkpoint:** Open the `evaluateWindow` method and trace through this scenario: the sliding window has 20 calls, 11 of which failed. The `failureRateThreshold` is 50, and `minimumCallCount` is 10. Does the breaker trip? Answer: Yes. 11/20 = 55% failure rate, which exceeds 50%, and 20 >= 10 minimum calls. The breaker transitions to OPEN.

### Configuration Recipes for Production

Different downstream services need different circuit breaker configurations. Here is a reference table we use for the Global Booking System:

```
┌─────────────────────┬─────────────┬──────────────┬──────────┬──────────────┐
│   Downstream        │ Failure     │ Reset        │ Window   │ Min Calls    │
│   Service           │ Threshold   │ Timeout      │ Size     │ Before Trip  │
├─────────────────────┼─────────────┼──────────────┼──────────┼──────────────┤
│ Payment Gateway     │ 25%         │ 60s          │ 30       │ 10           │
│ (critical, costly)  │ (low: trip  │ (long: let   │          │              │
│                     │  early)     │  them heal)  │          │              │
├─────────────────────┼─────────────┼──────────────┼──────────┼──────────────┤
│ Supplier Search API │ 50%         │ 30s          │ 20       │ 15           │
│ (high-volume)       │ (moderate)  │ (standard)   │          │              │
├─────────────────────┼─────────────┼──────────────┼──────────┼──────────────┤
│ Email Notification  │ 70%         │ 15s          │ 10       │ 5            │
│ (non-critical)      │ (high: very │ (short: try  │          │              │
│                     │  tolerant)  │  again soon) │          │              │
├─────────────────────┼─────────────┼──────────────┼──────────┼──────────────┤
│ Analytics Telemetry │ 80%         │ 10s          │ 10       │ 5            │
│ (fire-and-forget)   │ (very high) │ (aggressive) │          │              │
└─────────────────────┴─────────────┴──────────────┴──────────┴──────────────┘
```

> **Rule of thumb:** The more critical the downstream service, the lower your failure threshold (trip earlier) and the longer your reset timeout (give them more time to recover). For non-critical services, be lenient with the threshold but aggressive with the reset timeout so you resume quickly.

---

## The Bulkhead Pattern

### Why Circuit Breakers Are Not Enough

A circuit breaker protects you from a failing downstream service. But what about a *slow* downstream service that has not yet tripped the breaker? Before the breaker trips, you still have requests piling up. If all your application's resources (connection pool slots, memory, event loop time) are shared across all downstream calls, one slow dependency can consume all available resources before the breaker even triggers.

This is where the **Bulkhead** pattern comes in.

> **Analogy:** The name comes from the bulkheads in a ship's hull -- watertight compartments that prevent a breach in one section from flooding the entire vessel. Even if one compartment fills with water, the ship stays afloat because the damage is contained. That is exactly what we want: if one downstream service goes bad, its resource consumption should be *contained* to a fixed portion of our total capacity.

### Two Isolation Strategies

There are two ways to implement the Bulkhead pattern, each with different tradeoffs:

```
┌──────────────────────────────────────────────────────────────────┐
│                  BULKHEAD ISOLATION STRATEGIES                   │
├─────────────────────────────────┬────────────────────────────────┤
│      SEMAPHORE ISOLATION        │     THREAD POOL ISOLATION      │
│                                 │     (Worker Pool in Node.js)   │
├─────────────────────────────────┼────────────────────────────────┤
│                                 │                                │
│  ┌──────────────────────┐       │  ┌──────────────────────┐      │
│  │  Max concurrent: 10  │       │  │  Worker Pool: 4      │      │
│  │  ┌──┐ ┌──┐ ┌──┐     │       │  │  Queue max: 20       │      │
│  │  │S1│ │S2│ │S3│ ... │       │  │  ┌───┐ ┌───┐        │      │
│  │  └──┘ └──┘ └──┘     │       │  │  │W1 │ │W2 │ ...    │      │
│  │  Slots: 7/10 used   │       │  │  └───┘ └───┘        │      │
│  └──────────────────────┘       │  └──────────────────────┘      │
│                                 │                                │
│  HOW IT WORKS:                  │  HOW IT WORKS:                 │
│  A counter limits concurrent    │  A separate pool of workers    │
│  in-flight calls. When the      │  handles calls. Main thread    │
│  limit is reached, new calls    │  is never blocked. When the    │
│  are rejected immediately.      │  pool and queue are full,      │
│                                 │  new calls are rejected.       │
│  PROS:                          │  PROS:                         │
│  - Zero overhead                │  - True isolation (separate    │
│  - Simple to implement          │    memory/event loop)          │
│  - Works on main thread         │  - Main thread stays fast      │
│                                 │                                │
│  CONS:                          │  CONS:                         │
│  - Slow calls still block       │  - Higher memory overhead      │
│    event loop indirectly         │  - Cross-thread serialization  │
│  - No timeout enforcement       │  - Complex error handling      │
│                                 │                                │
│  BEST FOR:                      │  BEST FOR:                     │
│  - Most I/O-bound calls         │  - CPU-bound operations        │
│  - HTTP client calls            │  - PDF generation, encryption  │
│  - Database queries             │  - Image processing            │
└─────────────────────────────────┴────────────────────────────────┘
```

For our NestJS booking system, **semaphore isolation** is the right choice 95% of the time. Node.js is single-threaded by design, and most of our downstream calls are I/O-bound (HTTP requests, database queries). Semaphore isolation gives us resource containment without the complexity of worker threads.

### Semaphore Bulkhead Implementation

Here is a complete, production-ready semaphore bulkhead:

```typescript
// bulkhead/semaphore-bulkhead.ts

import { EventEmitter } from 'events';

export interface BulkheadConfig {
  /** Name for logging and metrics */
  name: string;

  /** Maximum number of concurrent calls permitted */
  maxConcurrent: number;

  /** Maximum number of calls waiting in the queue */
  maxQueue: number;

  /** Maximum time (ms) a call can wait in the queue before being rejected */
  queueTimeout: number;
}

export const DEFAULT_BULKHEAD_CONFIG: Omit<BulkheadConfig, 'name'> = {
  maxConcurrent: 10,
  maxQueue: 20,
  queueTimeout: 5000,
};

interface QueuedCall {
  resolve: (value: void) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  enqueuedAt: number;
}

export class SemaphoreBulkhead extends EventEmitter {
  private activeCalls: number = 0;
  private readonly queue: QueuedCall[] = [];
  private readonly config: BulkheadConfig;

  constructor(config: Partial<BulkheadConfig> & { name: string }) {
    super();
    this.config = { ...DEFAULT_BULKHEAD_CONFIG, ...config };
  }

  /**
   * Execute a function within the bulkhead's concurrency limits.
   * If the active slots are full, the call is queued.
   * If the queue is also full, the call is rejected immediately.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we can run immediately
    if (this.activeCalls < this.config.maxConcurrent) {
      return this.run(fn);
    }

    // Check if we can queue
    if (this.queue.length >= this.config.maxQueue) {
      this.emit('rejected', {
        name: this.config.name,
        activeCalls: this.activeCalls,
        queueLength: this.queue.length,
      });
      throw new BulkheadFullError(
        `Bulkhead "${this.config.name}" is full. ` +
        `Active: ${this.activeCalls}/${this.config.maxConcurrent}, ` +
        `Queue: ${this.queue.length}/${this.config.maxQueue}`
      );
    }

    // Add to queue and wait for a slot
    await this.enqueue();
    return this.run(fn);
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.activeCalls++;
    this.emit('callStarted', {
      activeCalls: this.activeCalls,
      queueLength: this.queue.length,
    });

    try {
      const result = await fn();
      return result;
    } finally {
      this.activeCalls--;
      this.emit('callFinished', {
        activeCalls: this.activeCalls,
        queueLength: this.queue.length,
      });
      this.dequeue();
    }
  }

  private enqueue(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex(q => q.resolve === resolve);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(new BulkheadQueueTimeoutError(
            `Bulkhead "${this.config.name}" queue timeout after ` +
            `${this.config.queueTimeout}ms`
          ));
        }
      }, this.config.queueTimeout);

      this.queue.push({ resolve, reject, timer, enqueuedAt: Date.now() });
      this.emit('queued', { queueLength: this.queue.length });
    });
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.activeCalls < this.config.maxConcurrent) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      next.resolve();
    }
  }

  getMetrics() {
    return {
      activeCalls: this.activeCalls,
      queueLength: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueue: this.config.maxQueue,
      availableSlots: this.config.maxConcurrent - this.activeCalls,
      availableQueueSlots: this.config.maxQueue - this.queue.length,
    };
  }
}

export class BulkheadFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadFullError';
  }
}

export class BulkheadQueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadQueueTimeoutError';
  }
}
```

Walk through the `execute` method: first, try to run immediately if a slot is available. If not, try to enqueue. If the queue is also full, reject immediately. When a running call finishes, `dequeue` releases the next waiting call. The `queueTimeout` prevents calls from waiting forever in the queue -- if a slot does not open up within the timeout, the waiting call is rejected.

> **Key Term:** **Bulkhead** -- A resilience pattern that limits the number of concurrent calls to a specific downstream service, preventing one slow or failing dependency from consuming all of the caller's resources. Named after the watertight compartments in a ship's hull that prevent a single breach from sinking the vessel.

---

## NestJS Integration: Decorators and Interceptors

Now we bring everything together in NestJS. We will create custom decorators (`@CircuitBreaker` and `@Bulkhead`) that you can apply to any service method. This transforms the raw classes we built above into something idiomatic for your NestJS codebase.

### The Circuit Breaker Registry

First, we need a central registry that manages circuit breaker instances. Each downstream service gets exactly one breaker, shared across all callers:

```typescript
// resilience/circuit-breaker.registry.ts

import { Injectable, Logger } from '@nestjs/common';
import { CircuitBreaker } from '../circuit-breaker/circuit-breaker';
import { CircuitBreakerConfig, CircuitBreakerState } from '../circuit-breaker/types';

@Injectable()
export class CircuitBreakerRegistry {
  private readonly logger = new Logger(CircuitBreakerRegistry.name);
  private readonly breakers = new Map<string, CircuitBreaker>();

  getOrCreate(config: Partial<CircuitBreakerConfig> & { name: string }): CircuitBreaker {
    if (!this.breakers.has(config.name)) {
      const breaker = new CircuitBreaker(config);

      // Wire up logging for state changes
      breaker.on('stateChange', ({ from, to, name }) => {
        this.logger.warn(
          `Circuit breaker "${name}" transitioned: ${from} -> ${to}`
        );
      });

      breaker.on('rejected', ({ name, state }) => {
        this.logger.warn(
          `Circuit breaker "${name}" rejected call (state: ${state})`
        );
      });

      breaker.on('tripReason', ({ reason, rate, threshold }) => {
        this.logger.error(
          `Circuit breaker tripped: ${reason} (${rate.toFixed(1)}% >= ${threshold}%)`
        );
      });

      this.breakers.set(config.name, breaker);
    }

    return this.breakers.get(config.name)!;
  }

  getAllMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {};
    for (const [name, breaker] of this.breakers) {
      metrics[name] = breaker.getMetrics();
    }
    return metrics;
  }

  getBreaker(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }
}
```

### The @CircuitBreaker Decorator

This is where NestJS magic meets resilience engineering. The decorator wraps any method with circuit breaker protection:

```typescript
// resilience/circuit-breaker.decorator.ts

import { SetMetadata } from '@nestjs/common';
import { CircuitBreakerConfig } from '../circuit-breaker/types';

export const CIRCUIT_BREAKER_OPTIONS = 'CIRCUIT_BREAKER_OPTIONS';

export type CircuitBreakerOptions = Partial<CircuitBreakerConfig> & {
  name: string;
};

/**
 * Decorator that wraps a method with circuit breaker protection.
 *
 * Usage:
 *   @CircuitBreaker({ name: 'supplier-api', failureRateThreshold: 50 })
 *   async searchSupplier(query: SearchQuery): Promise<SearchResult[]> { ... }
 */
export function CircuitBreaker(options: CircuitBreakerOptions): MethodDecorator {
  return (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      // Access the registry from the NestJS DI container
      const registry: import('./circuit-breaker.registry').CircuitBreakerRegistry =
        (this as any)._circuitBreakerRegistry;

      if (!registry) {
        // Fallback: no registry injected, run without protection
        return originalMethod.apply(this, args);
      }

      const breaker = registry.getOrCreate(options);
      return breaker.execute(() => originalMethod.apply(this, args));
    };

    // Preserve metadata for NestJS
    SetMetadata(CIRCUIT_BREAKER_OPTIONS, options)(target, propertyKey, descriptor);
    return descriptor;
  };
}
```

### The @Bulkhead Decorator

Same pattern, applied to bulkhead isolation:

```typescript
// resilience/bulkhead.decorator.ts

import { SetMetadata } from '@nestjs/common';
import { BulkheadConfig } from '../bulkhead/semaphore-bulkhead';

export const BULKHEAD_OPTIONS = 'BULKHEAD_OPTIONS';

export type BulkheadOptions = Partial<BulkheadConfig> & {
  name: string;
};

/**
 * Decorator that wraps a method with bulkhead concurrency limits.
 *
 * Usage:
 *   @Bulkhead({ name: 'supplier-api', maxConcurrent: 10, maxQueue: 20 })
 *   async searchSupplier(query: SearchQuery): Promise<SearchResult[]> { ... }
 */
export function Bulkhead(options: BulkheadOptions): MethodDecorator {
  return (
    target: any,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor
  ) => {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      const registry: import('./bulkhead.registry').BulkheadRegistry =
        (this as any)._bulkheadRegistry;

      if (!registry) {
        return originalMethod.apply(this, args);
      }

      const bulkhead = registry.getOrCreate(options);
      return bulkhead.execute(() => originalMethod.apply(this, args));
    };

    SetMetadata(BULKHEAD_OPTIONS, options)(target, propertyKey, descriptor);
    return descriptor;
  };
}
```

### Using Both Decorators Together

Here is how you use them in a real service. Notice that you can stack both decorators -- the bulkhead limits concurrency, and the circuit breaker watches for failure rates:

```typescript
// suppliers/supplier-search.service.ts

import { Injectable, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { CircuitBreaker } from '../resilience/circuit-breaker.decorator';
import { Bulkhead } from '../resilience/bulkhead.decorator';
import { CircuitBreakerRegistry } from '../resilience/circuit-breaker.registry';
import { BulkheadRegistry } from '../resilience/bulkhead.registry';

@Injectable()
export class SupplierSearchService {
  // Inject registries so decorators can access them
  constructor(
    private readonly httpService: HttpService,
    @Inject(CircuitBreakerRegistry)
    private readonly _circuitBreakerRegistry: CircuitBreakerRegistry,
    @Inject(BulkheadRegistry)
    private readonly _bulkheadRegistry: BulkheadRegistry,
  ) {}

  @Bulkhead({ name: 'supplier-search', maxConcurrent: 15, maxQueue: 30 })
  @CircuitBreaker({
    name: 'supplier-search',
    failureRateThreshold: 50,
    resetTimeout: 30000,
    slowCallDurationThreshold: 5000,
  })
  async searchAvailability(query: SearchQuery): Promise<SupplierResult[]> {
    const response = await this.httpService.axiosRef.get(
      'https://supplier-api.example.com/search',
      {
        params: query,
        timeout: 5000, // Always set explicit timeouts!
      }
    );
    return response.data;
  }

  @Bulkhead({ name: 'supplier-booking', maxConcurrent: 5, maxQueue: 10 })
  @CircuitBreaker({
    name: 'supplier-booking',
    failureRateThreshold: 25,  // Trip early for bookings (money is involved)
    resetTimeout: 60000,       // Longer recovery for booking endpoint
    minimumCallCount: 5,
  })
  async createBooking(booking: BookingRequest): Promise<BookingConfirmation> {
    const response = await this.httpService.axiosRef.post(
      'https://supplier-api.example.com/book',
      booking,
      { timeout: 10000 }
    );
    return response.data;
  }
}
```

> **Why separate breakers for search vs. booking?** The search endpoint might be flaky during peak hours, but we do not want that to prevent bookings from going through. Separate circuit breakers per endpoint mean the search breaker can trip while the booking breaker stays closed. Same supplier, isolated failure domains.

---

## Axios Interceptors: Circuit Breaker at the HTTP Layer

Instead of decorating individual methods, you can wire circuit breakers directly into your HTTP client. This approach catches every HTTP call to a given host, regardless of which service method makes it:

```typescript
// http/resilient-http.service.ts

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { CircuitBreakerRegistry } from '../resilience/circuit-breaker.registry';
import { CircuitBreakerOpenError } from '../circuit-breaker/circuit-breaker';

@Injectable()
export class ResilientHttpService {
  private readonly logger = new Logger(ResilientHttpService.name);
  private readonly client: AxiosInstance;

  constructor(
    private readonly circuitBreakerRegistry: CircuitBreakerRegistry,
  ) {
    this.client = axios.create({
      timeout: 5000, // Global default timeout
    });

    // REQUEST interceptor: check circuit breaker before sending
    this.client.interceptors.request.use(
      (config) => {
        const host = new URL(config.url || '').hostname;
        const breaker = this.circuitBreakerRegistry.getBreaker(host);

        if (breaker && breaker.getState() === 'OPEN') {
          // Reject immediately without making the network call
          return Promise.reject(
            new CircuitBreakerOpenError(
              `Circuit breaker for ${host} is OPEN. Request blocked.`
            )
          );
        }
        // Tag the request with start time for duration tracking
        (config as any)._startTime = Date.now();
        return config;
      },
      (error) => Promise.reject(error)
    );

    // RESPONSE interceptor: record success/failure in the breaker
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        const host = new URL(response.config.url || '').hostname;
        const duration = Date.now() - ((response.config as any)._startTime || 0);
        const breaker = this.circuitBreakerRegistry.getOrCreate({ name: host });

        // Record the success -- the breaker's sliding window is updated
        breaker.execute(async () => response.data).catch(() => {});
        this.logger.debug(`${host}: success in ${duration}ms`);
        return response;
      },
      (error) => {
        if (error.config) {
          const host = new URL(error.config.url || '').hostname;
          const breaker = this.circuitBreakerRegistry.getOrCreate({ name: host });

          // Record the failure -- this may trip the breaker
          breaker.execute(async () => { throw error; }).catch(() => {});
          this.logger.warn(`${host}: failure recorded in circuit breaker`);
        }
        return Promise.reject(error);
      }
    );
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.get<T>(url, config);
    return response.data;
  }

  async post<T>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.client.post<T>(url, data, config);
    return response.data;
  }
}
```

> **Common Mistake:** Wrapping the entire Axios call inside `breaker.execute()` AND using an Axios interceptor that also records results. This double-counts every call and causes the breaker to trip at half the actual failure rate. Choose ONE approach: either the decorator/execute pattern or the interceptor pattern, never both for the same call.

---

## Monitoring: Prometheus Metrics for Circuit Breakers

A circuit breaker you cannot observe is a circuit breaker you cannot trust. You need to know when breakers trip, how long they stay open, and how many calls they reject. Here is a complete Prometheus integration:

```typescript
// monitoring/circuit-breaker.metrics.ts

import { Injectable, OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, register } from 'prom-client';
import { CircuitBreakerRegistry } from '../resilience/circuit-breaker.registry';

@Injectable()
export class CircuitBreakerMetrics implements OnModuleInit {
  private readonly stateGauge = new Gauge({
    name: 'circuit_breaker_state',
    help: 'Current circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)',
    labelNames: ['breaker_name'],
  });

  private readonly callTotal = new Counter({
    name: 'circuit_breaker_calls_total',
    help: 'Total calls through circuit breakers',
    labelNames: ['breaker_name', 'result'], // result: success, failure, rejected
  });

  private readonly stateTransitions = new Counter({
    name: 'circuit_breaker_state_transitions_total',
    help: 'Number of state transitions',
    labelNames: ['breaker_name', 'from_state', 'to_state'],
  });

  private readonly callDuration = new Histogram({
    name: 'circuit_breaker_call_duration_seconds',
    help: 'Duration of calls through circuit breakers',
    labelNames: ['breaker_name', 'result'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

  private readonly rejectedTotal = new Counter({
    name: 'circuit_breaker_rejected_total',
    help: 'Total calls rejected by open circuit breakers',
    labelNames: ['breaker_name'],
  });

  private readonly bulkheadActive = new Gauge({
    name: 'bulkhead_active_calls',
    help: 'Current number of active calls in bulkhead',
    labelNames: ['bulkhead_name'],
  });

  private readonly bulkheadQueue = new Gauge({
    name: 'bulkhead_queue_length',
    help: 'Current number of calls waiting in bulkhead queue',
    labelNames: ['bulkhead_name'],
  });

  constructor(private readonly registry: CircuitBreakerRegistry) {}

  onModuleInit(): void {
    // Poll breaker states every 5 seconds for Prometheus scraping
    setInterval(() => {
      const allMetrics = this.registry.getAllMetrics();
      for (const [name, metrics] of Object.entries(allMetrics)) {
        const stateValue =
          metrics.state === 'CLOSED' ? 0 :
          metrics.state === 'OPEN' ? 1 : 2;

        this.stateGauge.set({ breaker_name: name }, stateValue);
      }
    }, 5000);
  }

  recordCall(breakerName: string, result: 'success' | 'failure' | 'rejected', durationMs: number): void {
    this.callTotal.inc({ breaker_name: breakerName, result });
    this.callDuration.observe(
      { breaker_name: breakerName, result },
      durationMs / 1000
    );

    if (result === 'rejected') {
      this.rejectedTotal.inc({ breaker_name: breakerName });
    }
  }

  recordStateTransition(breakerName: string, from: string, to: string): void {
    this.stateTransitions.inc({
      breaker_name: breakerName,
      from_state: from,
      to_state: to,
    });
  }

  recordBulkheadMetrics(name: string, active: number, queued: number): void {
    this.bulkheadActive.set({ bulkhead_name: name }, active);
    this.bulkheadQueue.set({ bulkhead_name: name }, queued);
  }
}
```

Key Grafana alerts to configure based on these metrics:

```
┌──────────────────────────────────────────────────────────────────────┐
│                    CRITICAL GRAFANA ALERTS                           │
├──────────────────────┬───────────────────────────────────────────────┤
│ Alert Name           │ PromQL Expression                            │
├──────────────────────┼───────────────────────────────────────────────┤
│ Breaker Opened       │ circuit_breaker_state == 1                   │
│                      │ (fires when any breaker is OPEN)             │
├──────────────────────┼───────────────────────────────────────────────┤
│ High Rejection Rate  │ rate(circuit_breaker_rejected_total[5m]) > 10│
│                      │ (more than 10 rejections/sec over 5min)      │
├──────────────────────┼───────────────────────────────────────────────┤
│ Breaker Flapping     │ rate(circuit_breaker_state_transitions_total  │
│                      │  [10m]) > 6                                  │
│                      │ (more than 6 transitions in 10min = flapping)│
├──────────────────────┼───────────────────────────────────────────────┤
│ Bulkhead Saturated   │ bulkhead_active_calls /                      │
│                      │ bulkhead_max_concurrent > 0.9                │
│                      │ (90%+ of bulkhead capacity used)             │
└──────────────────────┴───────────────────────────────────────────────┘
```

> **Checkpoint:** If you see the "Breaker Flapping" alert firing, what does it tell you? Answer: The downstream service is recovering just enough to pass the HALF-OPEN probes, then immediately getting sick again. This usually means the recovery timeout is too short -- the service has not truly recovered, it just had a few good moments. Increase `resetTimeout` to give it more breathing room.

---

## Combining Circuit Breaker + Retry + Timeout

These three patterns are designed to work together, but the order matters. Get the layering wrong and you create the exact problems you are trying to solve.

```
┌─────────────────────────────────────────────────────────────────────┐
│              CORRECT LAYERING (outside to inside)                   │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  CIRCUIT BREAKER (outermost)                                  │  │
│  │  - Checks state BEFORE any attempt                            │  │
│  │  - Records final outcome AFTER all retries                    │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  BULKHEAD (middle)                                      │  │  │
│  │  │  - Limits concurrency of the combined retry+call        │  │  │
│  │  │                                                         │  │  │
│  │  │  ┌───────────────────────────────────────────────────┐  │  │  │
│  │  │  │  RETRY (inner, with exponential backoff)          │  │  │  │
│  │  │  │                                                   │  │  │  │
│  │  │  │  ┌─────────────────────────────────────────────┐  │  │  │  │
│  │  │  │  │  TIMEOUT (innermost)                        │  │  │  │  │
│  │  │  │  │  - Each individual attempt has a timeout    │  │  │  │  │
│  │  │  │  │  - e.g., 3 seconds per attempt              │  │  │  │  │
│  │  │  │  └─────────────────────────────────────────────┘  │  │  │  │
│  │  │  └───────────────────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

Here is the combined implementation:

```typescript
// resilience/resilient-call.ts

import { CircuitBreaker } from '../circuit-breaker/circuit-breaker';
import { SemaphoreBulkhead } from '../bulkhead/semaphore-bulkhead';
import { Logger } from '@nestjs/common';

interface ResilientCallOptions {
  /** Circuit breaker instance */
  circuitBreaker: CircuitBreaker;

  /** Bulkhead instance */
  bulkhead: SemaphoreBulkhead;

  /** Maximum retry attempts (not including the first call) */
  maxRetries: number;

  /** Timeout per individual attempt in ms */
  timeoutPerAttempt: number;

  /** Base delay between retries in ms (doubles each time) */
  retryBaseDelay: number;

  /** Optional: which errors are retryable */
  isRetryable?: (error: Error) => boolean;
}

const defaultIsRetryable = (error: any): boolean => {
  // Retry on network errors and 5xx responses, NOT on 4xx
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
  if (error.response?.status >= 500) return true;
  return false;
};

export async function resilientCall<T>(
  fn: () => Promise<T>,
  options: ResilientCallOptions,
): Promise<T> {
  const logger = new Logger('ResilientCall');
  const isRetryable = options.isRetryable || defaultIsRetryable;

  // Layer 1: Circuit Breaker (outermost)
  return options.circuitBreaker.execute(async () => {

    // Layer 2: Bulkhead
    return options.bulkhead.execute(async () => {

      // Layer 3: Retry with exponential backoff
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
        try {
          // Layer 4: Timeout (innermost)
          const result = await withTimeout(
            fn(),
            options.timeoutPerAttempt,
          );
          return result;
        } catch (error) {
          lastError = error as Error;

          if (attempt < options.maxRetries && isRetryable(error as Error)) {
            const delay = options.retryBaseDelay * Math.pow(2, attempt);
            const jitter = Math.random() * delay * 0.1; // 10% jitter
            logger.debug(
              `Attempt ${attempt + 1} failed, retrying in ${delay + jitter}ms`
            );
            await sleep(delay + jitter);
          } else {
            break; // Non-retryable error or max retries exceeded
          }
        }
      }

      throw lastError;
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Call timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

> **Common Mistake:** Putting retries *outside* the circuit breaker. If you do this, each retry is a separate call from the circuit breaker's perspective. A single failed request with 3 retries counts as 4 failures in the sliding window instead of 1. This makes the breaker trip 4x faster than intended and misrepresents the actual failure rate. Always put the circuit breaker on the outside and retries on the inside.

---

## Persisting Circuit Breaker Events with Prisma

In production, you need a historical record of circuit breaker activity for post-incident analysis, capacity planning, and trend detection. We store every state transition and significant event in the database.

### Prisma Schema

```prisma
// schema.prisma (add to your existing schema)

model CircuitBreakerEvent {
  id            String   @id @default(cuid())
  breakerName   String   @map("breaker_name")
  eventType     String   @map("event_type")     // STATE_CHANGE, CALL_REJECTED, TRIP, RESET
  fromState     String?  @map("from_state")      // CLOSED, OPEN, HALF_OPEN
  toState       String?  @map("to_state")
  failureRate   Float?   @map("failure_rate")
  slowCallRate  Float?   @map("slow_call_rate")
  tripReason    String?  @map("trip_reason")      // failure_rate, slow_call_rate
  callCount     Int?     @map("call_count")
  metadata      Json?                             // Additional context
  serviceName   String   @map("service_name")     // Which microservice reported this
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([breakerName, createdAt])
  @@index([eventType, createdAt])
  @@index([serviceName, createdAt])
  @@map("circuit_breaker_events")
}

model BulkheadEvent {
  id             String   @id @default(cuid())
  bulkheadName   String   @map("bulkhead_name")
  eventType      String   @map("event_type")    // REJECTED, QUEUE_TIMEOUT, SATURATED
  activeCalls    Int      @map("active_calls")
  queueLength    Int      @map("queue_length")
  maxConcurrent  Int      @map("max_concurrent")
  maxQueue       Int      @map("max_queue")
  serviceName    String   @map("service_name")
  createdAt      DateTime @default(now()) @map("created_at")

  @@index([bulkheadName, createdAt])
  @@index([eventType, createdAt])
  @@map("bulkhead_events")
}
```

The equivalent raw SQL migration for reference:

```sql
-- CreateTable: circuit_breaker_events
CREATE TABLE "circuit_breaker_events" (
    "id"             TEXT         NOT NULL PRIMARY KEY,
    "breaker_name"   TEXT         NOT NULL,
    "event_type"     TEXT         NOT NULL,
    "from_state"     TEXT,
    "to_state"       TEXT,
    "failure_rate"   DOUBLE PRECISION,
    "slow_call_rate" DOUBLE PRECISION,
    "trip_reason"    TEXT,
    "call_count"     INTEGER,
    "metadata"       JSON,
    "service_name"   TEXT         NOT NULL,
    "created_at"     DATETIME(6)  NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_cb_events_breaker_time" ON "circuit_breaker_events" ("breaker_name", "created_at");
CREATE INDEX "idx_cb_events_type_time" ON "circuit_breaker_events" ("event_type", "created_at");
CREATE INDEX "idx_cb_events_service_time" ON "circuit_breaker_events" ("service_name", "created_at");

-- CreateTable: bulkhead_events
CREATE TABLE "bulkhead_events" (
    "id"              TEXT         NOT NULL PRIMARY KEY,
    "bulkhead_name"   TEXT         NOT NULL,
    "event_type"      TEXT         NOT NULL,
    "active_calls"    INTEGER      NOT NULL,
    "queue_length"    INTEGER      NOT NULL,
    "max_concurrent"  INTEGER      NOT NULL,
    "max_queue"       INTEGER      NOT NULL,
    "service_name"    TEXT         NOT NULL,
    "created_at"      DATETIME(6)  NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_bh_events_name_time" ON "bulkhead_events" ("bulkhead_name", "created_at");
CREATE INDEX "idx_bh_events_type_time" ON "bulkhead_events" ("event_type", "created_at");
```

### Prisma Client: Recording and Querying Events

```typescript
// resilience/circuit-breaker-event.repository.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CircuitBreakerEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a circuit breaker state transition.
   */
  async recordStateChange(data: {
    breakerName: string;
    fromState: string;
    toState: string;
    failureRate?: number;
    slowCallRate?: number;
    tripReason?: string;
    callCount?: number;
    serviceName: string;
  }): Promise<void> {
    await this.prisma.circuitBreakerEvent.create({
      data: {
        breakerName: data.breakerName,
        eventType: 'STATE_CHANGE',
        fromState: data.fromState,
        toState: data.toState,
        failureRate: data.failureRate,
        slowCallRate: data.slowCallRate,
        tripReason: data.tripReason,
        callCount: data.callCount,
        serviceName: data.serviceName,
      },
    });
  }

  /**
   * Record a rejected call (breaker was OPEN).
   */
  async recordRejection(data: {
    breakerName: string;
    serviceName: string;
  }): Promise<void> {
    await this.prisma.circuitBreakerEvent.create({
      data: {
        breakerName: data.breakerName,
        eventType: 'CALL_REJECTED',
        fromState: 'OPEN',
        serviceName: data.serviceName,
      },
    });
  }

  /**
   * Query: How many times did a breaker trip in the last 24 hours?
   *
   * Raw SQL equivalent:
   *   SELECT breaker_name, COUNT(*) as trip_count
   *   FROM circuit_breaker_events
   *   WHERE event_type = 'STATE_CHANGE'
   *     AND to_state = 'OPEN'
   *     AND created_at >= NOW() - INTERVAL '24 hours'
   *   GROUP BY breaker_name
   *   ORDER BY trip_count DESC;
   */
  async getTripCountsLast24Hours(): Promise<
    { breakerName: string; tripCount: number }[]
  > {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await this.prisma.circuitBreakerEvent.groupBy({
      by: ['breakerName'],
      where: {
        eventType: 'STATE_CHANGE',
        toState: 'OPEN',
        createdAt: { gte: since },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    return results.map(r => ({
      breakerName: r.breakerName,
      tripCount: r._count.id,
    }));
  }

  /**
   * Query: What is the average time a breaker stays open before recovering?
   *
   * Raw SQL equivalent:
   *   SELECT breaker_name,
   *          AVG(EXTRACT(EPOCH FROM (recovery_time - trip_time))) as avg_recovery_seconds
   *   FROM (
   *     SELECT breaker_name, created_at as trip_time,
   *            LEAD(created_at) OVER (PARTITION BY breaker_name ORDER BY created_at) as recovery_time
   *     FROM circuit_breaker_events
   *     WHERE event_type = 'STATE_CHANGE'
   *       AND (to_state = 'OPEN' OR to_state = 'CLOSED')
   *       AND created_at >= NOW() - INTERVAL '7 days'
   *   ) transitions
   *   WHERE recovery_time IS NOT NULL
   *   GROUP BY breaker_name;
   */
  async getAverageRecoveryTime(breakerName: string): Promise<number | null> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const events = await this.prisma.circuitBreakerEvent.findMany({
      where: {
        breakerName,
        eventType: 'STATE_CHANGE',
        toState: { in: ['OPEN', 'CLOSED'] },
        createdAt: { gte: sevenDaysAgo },
      },
      orderBy: { createdAt: 'asc' },
      select: { toState: true, createdAt: true },
    });

    // Pair consecutive OPEN -> CLOSED transitions
    const recoveryTimes: number[] = [];
    for (let i = 0; i < events.length - 1; i++) {
      if (events[i].toState === 'OPEN' && events[i + 1].toState === 'CLOSED') {
        const durationMs =
          events[i + 1].createdAt.getTime() - events[i].createdAt.getTime();
        recoveryTimes.push(durationMs / 1000);
      }
    }

    if (recoveryTimes.length === 0) return null;
    return recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length;
  }
}
```

> **Why persist breaker events to the database?** In-memory metrics disappear when a pod restarts. Prometheus retains data for 15-30 days. But when you are doing a post-mortem on a cascading failure six weeks ago, you need the full history: which breakers tripped, in what order, how long they stayed open, and what failure rates triggered them. The database gives you that permanent audit trail.

---

## Testing Circuit Breakers: A Chaos Engineering Approach

You cannot trust a circuit breaker you have never seen trip. Unit tests verify the state machine logic, but integration tests and chaos engineering verify that your breakers actually protect your system under realistic failure conditions.

### Unit Testing the State Machine

```typescript
// circuit-breaker/__tests__/circuit-breaker.spec.ts

import { CircuitBreaker, CircuitBreakerOpenError } from '../circuit-breaker';
import { CircuitBreakerState } from '../types';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: 'test-breaker',
      slidingWindowSize: 10,
      minimumCallCount: 5,
      failureRateThreshold: 50,
      resetTimeout: 1000,        // 1 second for fast tests
      permittedCallsInHalfOpen: 2,
      slowCallDurationThreshold: 500,
      slowCallRateThreshold: 80,
    });
  });

  it('should start in CLOSED state', () => {
    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('should stay CLOSED when failures are below threshold', async () => {
    // 4 successes, 1 failure = 20% failure rate (below 50%)
    for (let i = 0; i < 4; i++) {
      await breaker.execute(async () => 'ok');
    }
    await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});

    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('should trip to OPEN when failure rate exceeds threshold', async () => {
    // 3 successes, 4 failures = 57% failure rate (above 50%), and 7 >= 5 min calls
    for (let i = 0; i < 3; i++) {
      await breaker.execute(async () => 'ok');
    }
    for (let i = 0; i < 4; i++) {
      await breaker.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it('should reject calls immediately when OPEN', async () => {
    breaker.forceState(CircuitBreakerState.OPEN);

    await expect(
      breaker.execute(async () => 'should not reach')
    ).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('should transition to HALF_OPEN after reset timeout', async () => {
    breaker.forceState(CircuitBreakerState.OPEN);

    // Wait for reset timeout
    await new Promise(resolve => setTimeout(resolve, 1100));

    expect(breaker.getState()).toBe(CircuitBreakerState.HALF_OPEN);
  });

  it('should close after successful probes in HALF_OPEN', async () => {
    breaker.forceState(CircuitBreakerState.HALF_OPEN);

    // 2 successful probes (permittedCallsInHalfOpen = 2)
    await breaker.execute(async () => 'probe-1');
    await breaker.execute(async () => 'probe-2');

    expect(breaker.getState()).toBe(CircuitBreakerState.CLOSED);
  });

  it('should return to OPEN if a probe fails in HALF_OPEN', async () => {
    breaker.forceState(CircuitBreakerState.HALF_OPEN);

    await breaker.execute(async () => { throw new Error('probe fail'); }).catch(() => {});

    expect(breaker.getState()).toBe(CircuitBreakerState.OPEN);
  });

  it('should use fallback when configured and breaker is OPEN', async () => {
    const breakerWithFallback = new CircuitBreaker({
      name: 'test-fallback',
      fallback: () => ({ cached: true, results: [] }),
    });
    breakerWithFallback.forceState(CircuitBreakerState.OPEN);

    const result = await breakerWithFallback.execute(async () => 'should not run');
    expect(result).toEqual({ cached: true, results: [] });
  });
});
```

### Chaos Testing with Fault Injection

For integration testing, inject failures into your HTTP calls to simulate real downstream outages:

```typescript
// test/chaos/circuit-breaker.chaos.spec.ts

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as nock from 'nock';
import { SupplierSearchService } from '../../src/suppliers/supplier-search.service';
import { CircuitBreakerRegistry } from '../../src/resilience/circuit-breaker.registry';

describe('Circuit Breaker Chaos Tests', () => {
  let app: INestApplication;
  let searchService: SupplierSearchService;
  let registry: CircuitBreakerRegistry;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      // ... your module configuration
    }).compile();

    app = module.createNestApplication();
    await app.init();

    searchService = module.get(SupplierSearchService);
    registry = module.get(CircuitBreakerRegistry);
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('should trip breaker after sustained failures and recover', async () => {
    // Phase 1: Simulate supplier returning 500 errors
    const failingSupplier = nock('https://supplier-api.example.com')
      .get('/search')
      .query(true)
      .times(20)
      .reply(500, { error: 'Internal Server Error' });

    // Make enough failing calls to trip the breaker
    for (let i = 0; i < 15; i++) {
      await searchService.searchAvailability({ destination: 'LAX' }).catch(() => {});
    }

    // Verify the breaker has tripped
    const breaker = registry.getBreaker('supplier-search');
    expect(breaker?.getState()).toBe('OPEN');

    // Phase 2: Calls should be rejected without hitting the network
    const startTime = Date.now();
    await searchService.searchAvailability({ destination: 'LAX' }).catch(() => {});
    const rejectionTime = Date.now() - startTime;

    // Rejection should be near-instant (< 5ms), not a 5-second timeout
    expect(rejectionTime).toBeLessThan(50);

    // Phase 3: Simulate supplier recovery
    nock.cleanAll();
    nock('https://supplier-api.example.com')
      .get('/search')
      .query(true)
      .times(10)
      .reply(200, { results: [{ hotel: 'Test Hotel' }] });

    // Wait for reset timeout, then verify recovery
    await new Promise(resolve => setTimeout(resolve, 31000));

    const result = await searchService.searchAvailability({ destination: 'LAX' });
    expect(result).toBeDefined();
    expect(breaker?.getState()).not.toBe('OPEN');
  }, 60000); // 60-second timeout for this test
});
```

> **Key Insight:** The most important assertion in the chaos test above is `expect(rejectionTime).toBeLessThan(50)`. This proves that when the breaker is open, calls are rejected in microseconds instead of hanging for 5 seconds waiting for a timeout. That is the entire value proposition of the circuit breaker: turn slow failures into fast failures.

---

## Production War Story: The Notification Service That Sank the Ship

This happened to a team running a travel booking platform handling 80,000 bookings per day. The names and details have been changed, but the failure mode is real.

**The Setup:** The booking service called four downstream services: a payment gateway, a supplier API, an inventory service, and a notification service (for sending confirmation emails via a third-party API). All four shared the same HTTP connection pool (default Axios instance with a max of 100 concurrent connections). None had circuit breakers. None had bulkheads.

**The Trigger (Tuesday, 14:23 UTC):** The notification service's email provider experienced a DNS resolution failure. Every email send call hung for 30 seconds (the default DNS timeout) before failing.

**The Cascade:**

1. **T+0 to T+30s:** Email sends started timing out. The booking service accumulated 50 pending HTTP connections to the notification service. Nobody noticed -- email confirmations are "non-critical."

2. **T+30s to T+60s:** The shared HTTP connection pool hit maximum capacity. The 100 connection slots were consumed: 50 by hanging notification calls, 30 by normal supplier calls, 20 by payment calls. New payment calls started queuing.

3. **T+60s to T+90s:** Payment timeouts triggered. Bookings that had already charged the customer's card could not receive payment confirmation. The booking service started retrying payment confirmations, consuming even more connections.

4. **T+90s to T+3min:** Kubernetes health checks failed. Pods restarted. The remaining pods absorbed the traffic, immediately exceeded their connection pools, and died too.

5. **T+3min to T+45min:** Complete outage. 2,400 bookings were stuck in an inconsistent state (card charged, booking not confirmed). Customer support received 800 calls. The engineering team spent 42 minutes finding the root cause because their dashboards showed the payment gateway as healthy (because it *was* healthy -- the booking service just could not reach it through the saturated connection pool).

**The Fix:** After the incident, the team implemented three changes in 48 hours:

1. **Bulkheads:** Separate HTTP connection pools for each downstream service. Notification service got a bulkhead with `maxConcurrent: 10` -- even if all 10 connections hung, the other 90 were reserved for payments, suppliers, and inventory.

2. **Circuit Breaker on Notifications:** A circuit breaker with `failureRateThreshold: 50` and `resetTimeout: 60000`. After 5 out of 10 email sends failed, the breaker tripped and all subsequent emails were silently dropped (queued for later retry via a message broker).

3. **Aggressive Timeouts:** Every HTTP call got an explicit 3-second timeout. The 30-second DNS timeout that started the cascade would now be cut off at 3 seconds.

**The Cost of Not Having Circuit Breakers:** 42 minutes of total outage, 2,400 orphaned bookings requiring manual reconciliation (3 engineer-days), an estimated $180,000 in lost bookings, and a deeply uncomfortable meeting with the VP of Engineering.

> **The Lesson:** The notification service was the *least* critical dependency. It was "just emails." But because there were no bulkheads isolating it from the critical payment path, a failure in email delivery cascaded into a complete platform outage. Circuit breakers and bulkheads are not about protecting you from your critical dependencies -- they are about preventing your *non-critical* dependencies from taking down your critical ones.

---

## Common Mistakes

These are the mistakes we see most often when teams first implement circuit breakers and bulkheads. Every one of these has caused a production incident for someone.

**1. Sharing a single circuit breaker across all endpoints of a service.**
If you have one breaker for "supplier-api" and the `/search` endpoint is flaky but `/book` is fine, the flaky search trips the breaker and blocks perfectly healthy booking calls. Use one breaker per endpoint or per logical operation.

**2. Setting the `minimumCallCount` too low.**
A `minimumCallCount` of 1 means a single failed call at startup trips the breaker. During cold start, your first request might fail due to connection establishment latency, not because the service is unhealthy. Set this to at least 5-10 to avoid false trips.

**3. Not implementing a fallback.**
When the breaker trips, what does the user see? If you throw a raw `CircuitBreakerOpenError` up the stack, they get a 500 error. Instead, return cached data, a degraded response, or a clear "this feature is temporarily unavailable" message. The breaker's job is to fail fast; your job is to fail gracefully.

**4. Confusing bulkhead limits with rate limiting.**
A bulkhead limits *concurrent* calls (how many are in-flight at once). A rate limiter limits *total* calls per time window (e.g., 100 per second). You need both. A bulkhead with `maxConcurrent: 10` allows 10,000 calls per second if each call takes 1ms. It only kicks in when calls are *slow*, which is exactly when you need protection.

**5. Logging every rejected call at ERROR level.**
When a breaker trips and you are handling 1,000 requests per second, logging each rejection at ERROR creates 1,000 error log lines per second. This floods your log aggregator, triggers false alarms, and can even cause back-pressure on your logging pipeline. Log the state *transition* at WARN/ERROR level. Log individual rejections at DEBUG level.

**6. Not testing with the breaker open.**
Your application must work (with degraded functionality) when any circuit breaker is open. Write tests that force each breaker open and verify the application still responds with appropriate fallbacks. If you have never tested this path, you do not know what your users will experience during an outage.

**7. Using the same `resetTimeout` for all breakers.**
A payment gateway might need 60 seconds to recover from a rate-limit situation, while a CDN edge node recovers in 5 seconds. Match the reset timeout to the expected recovery time of each downstream service.

**8. Forgetting that bulkhead queue timeout needs to be shorter than your HTTP client timeout.**
If your HTTP timeout is 5 seconds and your bulkhead queue timeout is also 5 seconds, a request could wait 5 seconds in the queue and then wait another 5 seconds for the HTTP call -- 10 seconds total. Set the queue timeout to `httpTimeout - expectedCallDuration` so the total wait never exceeds what the caller expects.

---

## Chapter Summary

| Concept | What It Does | When It Activates | Key Configuration |
|---|---|---|---|
| **Circuit Breaker** | Stops calling a failing service, fails fast instead of slow | Failure rate exceeds threshold in the sliding window | `failureRateThreshold`, `resetTimeout`, `slidingWindowSize` |
| **Bulkhead** | Limits concurrent calls to one service, preventing resource starvation | Concurrent in-flight calls reach max limit | `maxConcurrent`, `maxQueue`, `queueTimeout` |
| **CLOSED state** | Normal operation; all calls pass through, failures are tracked | Default state | Sliding window tracks last N calls |
| **OPEN state** | All calls rejected immediately (fail fast), timer counts down | Failure rate >= threshold AND calls >= minimum | `resetTimeout` controls how long to stay open |
| **HALF_OPEN state** | Limited probe calls test if downstream has recovered | Reset timeout expires | `permittedCallsInHalfOpen` controls probe count |
| **Sliding Window** | Tracks recent call results for failure rate calculation | Every call in CLOSED state | `slidingWindowSize`, `minimumCallCount` |
| **Semaphore Bulkhead** | Counter-based concurrency limit on the main thread | Concurrent calls reach limit | `maxConcurrent`, `maxQueue` |
| **Resilient Call Stack** | Circuit Breaker > Bulkhead > Retry > Timeout (layered) | Each layer activates independently | All four patterns configured together |
| **Prometheus Metrics** | Observable state, rejection counts, durations, and saturation | Continuous (polled every 5s) | Gauge for state, Counter for transitions, Histogram for latency |
| **Event Persistence** | Prisma models record state changes for post-mortem analysis | Every state transition | `CircuitBreakerEvent`, `BulkheadEvent` Prisma models |

> **What comes next:** In the next chapter, we tackle **Rate Limiting** — how to protect your services from being overwhelmed by too many requests, whether from legitimate traffic spikes or malicious actors. You will learn token bucket and sliding window algorithms, per-user and per-IP limits, and how to implement rate limiting at both the application level and the API gateway level.
