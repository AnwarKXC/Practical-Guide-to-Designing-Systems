# Chapter 19: Saga Pattern — Distributed Transactions Without a Safety Net

## What You Already Know About Transactions

You have written database transactions before. You know the ritual: `BEGIN`, do your work, `COMMIT` if everything worked, `ROLLBACK` if anything went sideways. It looks like this:

```typescript
// The transaction you already know and love.
// Everything here talks to ONE database.
await db.query('BEGIN');

try {
  await db.query('UPDATE rooms SET available = false WHERE id = $1', [roomId]);
  await db.query('INSERT INTO payments (booking_id, amount) VALUES ($1, $2)', [bookingId, amount]);
  await db.query('INSERT INTO bookings (id, user_id, room_id, status) VALUES ($1, $2, $3, $4)',
    [bookingId, userId, roomId, 'CONFIRMED']);

  await db.query('COMMIT');   // All three writes succeed together
} catch (error) {
  await db.query('ROLLBACK'); // All three writes vanish together
}
```

Three operations. One database. The database engine guarantees that they either *all* happen or *none* of them happen. You have probably relied on this behavior dozens of times without thinking about it. It just works.

Now here is the question that will define this entire chapter: **what happens when those three operations live in three different databases, on three different servers, owned by three different services?**

There is no `BEGIN` that spans multiple databases. There is no `ROLLBACK` that reaches across the network to undo a write on another machine. The safety net you have been standing on your entire career? It is gone.

> **Key Term:** **Distributed Transaction** -- A transaction that spans multiple services or databases. Unlike a local transaction, there is no single database engine coordinating the commit or rollback. You must coordinate it yourself.

---

## Why Distributed Transactions (2PC) Do Not Work in Microservices

Before we introduce the Saga pattern, we need to understand why the "obvious" solution -- two-phase commit -- is a trap at scale.

### How Two-Phase Commit Works

Two-phase commit (2PC) uses a **coordinator** and multiple **participants**. The protocol has two phases:

**Phase 1 -- Prepare (Voting).** The coordinator sends a `PREPARE` message to every participant. Each participant acquires locks on its resources, writes a prepare record to its local transaction log, and responds with either `VOTE_COMMIT` (ready) or `VOTE_ABORT` (not ready).

**Phase 2 -- Commit (Decision).** If every participant voted `COMMIT`, the coordinator sends a global `COMMIT` message. If any participant voted `ABORT`, or if any participant failed to respond, the coordinator sends a global `ABORT`. Each participant then either commits or rolls back its local transaction.

```
     Coordinator                       Participant A          Participant B
         |                                  |                      |
         |--- PREPARE --->                  |                      |
         |--- PREPARE ------------------------------------------>  |
         |                                  |                      |
         |<-- VOTE_COMMIT --                |                      |
         |<-- VOTE_COMMIT ---------------------------------------- |
         |                                  |                      |
         |--- COMMIT --->                   |                      |
         |--- COMMIT -------------------------------------------> |
         |                                  |                      |
     All done                          Committed              Committed
```

This looks elegant on a whiteboard. In production, it is a disaster.

### Five Reasons 2PC Fails at 100,000 Bookings Per Minute

**1. Lock Duration Amplification.** During Phase 1, every participant holds locks on its resources while waiting for the coordinator's final decision. At 100,000 bookings/minute, that is roughly 1,667 transactions per second. If the coordinator takes even 100ms to collect all votes, that is 1,667 transactions holding locks across three services simultaneously. A single slow participant -- say the Payment Service experiencing a GC pause -- blocks every other transaction waiting on those same rows.

```
Timeline of lock contention at scale:

T+0ms:   Inventory locks Room #4421    Payment locks Card Auth
T+50ms:  Coordinator waiting for Payment Service response...
T+100ms: Still waiting... 83 OTHER bookings want Room #4421
T+150ms: Still waiting... 125 bookings now queued
T+200ms: Payment finally responds. But 200ms of lock time
         at 1,667 TPS means ~333 transactions were blocked.
```

**2. The Coordinator Is a Single Point of Failure.** If the coordinator crashes after sending `PREPARE` but before sending `COMMIT`, every participant is stuck. They have voted, they hold locks, and they cannot release them because they do not know whether the final decision was `COMMIT` or `ABORT`. This state is called **in-doubt**, and it persists until the coordinator recovers. In the worst case, participants remain locked indefinitely.

**3. Network Partitions Create Impossible Choices.** In a microservices architecture, services communicate over the network. Networks partition. If the coordinator can reach Participant A but not Participant B, it cannot proceed. It must wait indefinitely for B to respond -- or make a unilateral decision that might conflict with B's state.

**4. Heterogeneous Data Stores Break the Protocol.** 2PC requires all participants to implement the XA interface (a standard for distributed transaction coordination). Your PostgreSQL database supports XA. Your Redis cache does not. Your third-party payment gateway definitely does not. The moment one participant in your transaction does not support the protocol, the whole approach collapses.

**5. Latency Multiplies, Not Adds.** The total transaction time is not `Service A + Service B + Service C`. It is `Service A + wait for A's vote + Service B + wait for B's vote + Service C + wait for C's vote + coordinator decision time`. Every network round trip adds latency, and every added millisecond extends lock duration. At our scale, this compounds into catastrophic throughput degradation.

> **Key Term:** **Two-Phase Commit (2PC)** -- A distributed transaction protocol where a coordinator asks all participants to prepare (Phase 1), then tells them to commit or abort (Phase 2). It guarantees atomicity across multiple databases but requires all participants to hold locks until global consensus is reached, creating severe bottlenecks at scale. It also requires all participants to support the XA protocol.

> **What If You Skip This?** If you attempt to use 2PC for a high-throughput booking system, your database connection pools will saturate under moderate load. Lock contention will cause cascading timeouts. The coordinator becomes a bottleneck that no amount of horizontal scaling can fix because every transaction funnels through it. We have seen teams spend months implementing XA transactions only to rip them out when they hit 500 bookings/minute -- a fraction of our target.

### The Fundamental Tension

2PC prioritizes **consistency** above all else. Every participant either commits or rolls back together. That is noble, but in a microservices architecture, you have already chosen **availability** and **partition tolerance** (remember the CAP theorem from Chapter 8). You cannot have all three. The Saga pattern accepts this reality: it trades strict consistency for **eventual consistency**, and it replaces global locks with **compensating actions**.

---

## The Saga Pattern: Theory and Foundations

The Saga pattern was introduced by Hector Garcia-Molina and Kenneth Salem in a 1987 paper at Princeton. The original idea was about long-lived database transactions -- transactions that hold locks for minutes or hours (like processing a payroll run). The authors proposed breaking these long transactions into a sequence of smaller transactions, each with a compensating counterpart. If any small transaction fails, you run the compensations for all previously completed ones.

Thirty-seven years later, we use the same pattern for a different reason: our "long transaction" spans multiple *databases*, not just multiple *minutes*.

> **Key Term:** **Saga** -- A sequence of local transactions where each transaction updates a single service's database. If any local transaction fails, the saga executes compensating transactions to undo the changes made by preceding transactions. The system achieves eventual consistency without holding cross-service locks.

### The Wedding Planning Analogy

> **Analogy:** Imagine you are planning a wedding. You need to book four vendors: a venue, a caterer, a photographer, and a DJ. Each vendor has their own contract, their own cancellation policy, and their own calendar. You cannot call all four simultaneously and say "book yourselves together as one atomic operation." Instead, you call them one at a time:
>
> 1. You book the venue. The venue confirms: "You are on our calendar for June 15th."
> 2. You book the caterer. The caterer confirms: "We will be there with 120 plates."
> 3. You call the photographer. The photographer says: "Sorry, I am already booked that day."
>
> Now what? The venue is reserved. The caterer is reserved. But you have no photographer, and a wedding without photos is not acceptable. You need to **undo** steps 1 and 2 -- call the venue and cancel, call the caterer and cancel. These undo operations are called **compensating actions**. They do not magically reverse time. The venue might charge you a cancellation fee. The caterer might keep your deposit. But they bring the system back to a *logically consistent state*: no half-planned wedding sitting in limbo.
>
> That is exactly what the Saga pattern does for distributed systems.

### Two Flavors: Orchestration vs. Choreography

There are two ways to coordinate a saga's steps. The choice between them affects everything -- how you debug failures, how you add new steps, and how tightly coupled your services become.

#### Orchestration: The Wedding Planner

In the orchestration approach, a **central coordinator** (the "orchestrator") knows the entire sequence of steps. It calls each service in order, waits for the response, and decides what to do next. If a step fails, the orchestrator triggers compensating actions in reverse order.

```
                  ┌──────────────────┐
                  │  Saga            │
                  │  Orchestrator    │
                  └──────┬───────────┘
                         │
          ┌──────────────┼──────────────┐──────────────┐
          │              │              │              │
          v              v              v              v
   ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │  Inventory  │ │ Payment  │ │ Booking  │ │ Notification │
   │  Service    │ │ Service  │ │ Service  │ │ Service      │
   └─────────────┘ └──────────┘ └──────────┘ └──────────────┘
```

Think of it as a wedding planner who holds a checklist. The planner calls the venue, checks off "venue booked," calls the caterer, checks off "caterer booked," and so on. The planner is the single source of truth for the plan's progress.

#### Choreography: Everyone Knows the Dance

In the choreography approach, there is **no central coordinator**. Instead, each service listens for events and decides what to do next. When the Inventory Service reserves a room, it emits an `InventoryHeld` event. The Payment Service listens for that event and charges the card. When the charge succeeds, it emits a `PaymentProcessed` event. The Booking Service listens for that and creates the booking record.

```
   ┌─────────────┐     InventoryHeld     ┌──────────┐
   │  Inventory  │ ──────────────────────>│ Payment  │
   │  Service    │                        │ Service  │
   └─────────────┘                        └────┬─────┘
                                               │
                                        PaymentProcessed
                                               │
   ┌──────────────┐    BookingConfirmed   ┌────v─────┐
   │ Notification │ <─────────────────────│ Booking  │
   │ Service      │                       │ Service  │
   └──────────────┘                       └──────────┘
```

Think of it as a relay race. Runner 1 finishes their leg and passes the baton to Runner 2. Runner 2 does not need a coach telling them when to start -- the baton arriving *is* the signal.

#### Head-to-Head Comparison

| Aspect | Orchestration | Choreography |
|--------|--------------|--------------|
| **Flow control** | Central orchestrator owns the sequence | Each service decides what to do next |
| **Coupling** | Services are coupled to the orchestrator | Services are coupled to each other's events |
| **Visibility** | Read one file to understand the entire flow | Trace events across N services to reconstruct the flow |
| **Adding a step** | Add one entry to the orchestrator's step array | Modify producer *and* new consumer, test the event contract |
| **Debugging** | Query the orchestrator's state table | Correlate logs across every service using a correlation ID |
| **Single point of failure** | Yes -- if the orchestrator dies, sagas stall | No -- services operate independently |
| **Circular dependencies** | Impossible by design | Easy to create accidentally (A -> B -> C -> A) |
| **Compensation logic** | Centralized in the orchestrator | Scattered across every service |
| **Best for** | Complex flows (4+ steps), strict ordering needs | Simple flows (2-3 steps), loosely coupled domains |

> **What If You Skip This?** Choosing choreography for a complex saga (like our 5-step booking flow) means your compensation logic is scattered across five services. When a saga fails, you need to trace events through message broker logs, correlate them by saga ID, and hope every service handled its compensating event correctly. We have seen teams spend *days* debugging a single stuck saga because no one service had the full picture. Orchestration keeps everything in one class.

#### Our Choice: Orchestration

For the Global Booking System, we use orchestration. Here is why:

1. **Our booking flow has five steps with strict ordering.** Inventory must be held before payment is charged. Payment must succeed before the booking is confirmed. The orchestrator enforces this sequence.

2. **Compensation logic is complex.** Each step's undo depends on what previous steps accomplished. Centralizing this logic in one class makes it auditable and testable.

3. **We need saga state tracking.** We want to query "show me all in-flight sagas" and "show me all sagas stuck longer than 5 minutes." The orchestrator's state table gives us this for free.

4. **The single point of failure is manageable.** We run multiple orchestrator instances behind a message queue, and we persist saga state to a database. If one instance dies, another picks up its in-flight sagas.

---

## Our Booking Saga: Five Steps, Five Safety Nets

Let us expand our booking saga from three steps to the five steps a real production system needs. Each step talks to a different service, and each step has a compensating action.

```
Step    Service              Forward Action                  Compensating Action
─────   ──────────────────   ─────────────────────────────   ──────────────────────────────
  1     Inventory Service    Reserve room (10-min hold)      Release the hold
  2     Payment Service      Authorize + charge the card     Refund the charge
  3     Booking Service      Create booking record           Cancel the booking record
  4     Inventory Service    Convert hold → confirmed        Revert to hold (then release)
  5     Notification Svc     Send confirmation email/SMS     Send cancellation notice
```

Here is the state machine, showing every possible path through the saga:

```
                         ┌───────────────────┐
                         │   SAGA_STARTED    │
                         └────────┬──────────┘
                                  │
                                  v
                    ┌─────────────────────────┐       ┌─────────────────────┐
                    │   INVENTORY_RESERVED    │──────>│  INVENTORY_FAILED   │
                    └────────────┬────────────┘       └─────────────────────┘
                                 │                     No compensation needed
                                 v
                    ┌─────────────────────────┐       ┌─────────────────────┐
                    │   PAYMENT_CHARGED       │──────>│  PAYMENT_FAILED     │
                    └────────────┬────────────┘       └─────────┬───────────┘
                                 │                              │
                                 │                     Compensate: release hold
                                 v
                    ┌─────────────────────────┐       ┌─────────────────────┐
                    │   BOOKING_CREATED       │──────>│  BOOKING_FAILED     │
                    └────────────┬────────────┘       └─────────┬───────────┘
                                 │                              │
                                 │                     Compensate: refund payment
                                 │                     + release hold
                                 v
                    ┌─────────────────────────┐       ┌─────────────────────┐
                    │   INVENTORY_CONFIRMED   │──────>│  CONFIRM_FAILED     │
                    └────────────┬────────────┘       └─────────┬───────────┘
                                 │                              │
                                 │                     Compensate: cancel booking
                                 │                     + refund + release hold
                                 v
                    ┌─────────────────────────┐       ┌─────────────────────┐
                    │   NOTIFICATION_SENT     │──────>│  NOTIFY_FAILED      │
                    └────────────┬────────────┘       └─────────┬───────────┘
                                 │                              │
                                 │                     Compensate: (best-effort)
                                 │                     or mark for manual follow-up
                                 v
                         ┌───────────────────┐
                         │   SAGA_COMPLETED  │
                         └───────────────────┘
```

Notice the asymmetry: step 5 (notification) is different from the others. Sending an email is a **side effect** that cannot truly be undone -- you cannot un-send an email. If step 5 fails, we have two options: retry (emails are idempotent) or mark the saga as "completed with notification pending" and let a background job handle it. If *earlier* steps fail after step 5 succeeds, we send a *cancellation* notification as the compensating action.

> **Key Term:** **Compensating Action** -- An operation that semantically undoes the effect of a previously completed step. It does not literally reverse the operation (you cannot "un-send" a network request or "un-charge" a credit card). Instead, it performs a *new* action that logically cancels the original one: issuing a refund to undo a charge, releasing a hold to undo a reservation, sending a cancellation notice to undo a confirmation email.

> **Analogy:** Consider the difference between `Ctrl+Z` in a text editor and a compensating action. `Ctrl+Z` literally reverses the operation -- the character you typed vanishes as if it never existed. A compensating action is more like crossing out a word on a legal document: the original word is still visible, a new action (the strikethrough) has been added, and the net effect is that the word no longer counts. Both achieve the same logical result, but the compensating action leaves an audit trail.

---

## Full Saga Orchestrator Implementation in NestJS

Time to build the production implementation. We will use NestJS with a proper state machine, injectable services, and full error handling. This is not a toy example -- this is the code structure you would deploy to handle real bookings.

### Step 1: Define the Saga Types

Every saga needs clear type definitions. These types form the contract between the orchestrator and the rest of your application.

```typescript
// src/sagas/types/saga.types.ts

/** Every possible state the saga can be in. */
export enum SagaStatus {
  STARTED              = 'STARTED',
  INVENTORY_RESERVED   = 'INVENTORY_RESERVED',
  INVENTORY_FAILED     = 'INVENTORY_FAILED',
  PAYMENT_CHARGED      = 'PAYMENT_CHARGED',
  PAYMENT_FAILED       = 'PAYMENT_FAILED',
  BOOKING_CREATED      = 'BOOKING_CREATED',
  BOOKING_FAILED       = 'BOOKING_FAILED',
  INVENTORY_CONFIRMED  = 'INVENTORY_CONFIRMED',
  CONFIRM_FAILED       = 'CONFIRM_FAILED',
  NOTIFICATION_SENT    = 'NOTIFICATION_SENT',
  NOTIFY_FAILED        = 'NOTIFY_FAILED',
  COMPENSATING         = 'COMPENSATING',
  COMPENSATED          = 'COMPENSATED',
  COMPENSATION_FAILED  = 'COMPENSATION_FAILED',
  COMPLETED            = 'COMPLETED',
}

/** The shared context that flows through every saga step.
 *  Think of it as the wedding planner's clipboard. */
export interface SagaContext {
  // Immutable: set once when the saga starts
  readonly sagaId: string;
  readonly bookingDto: CreateBookingDto;
  readonly startedAt: Date;

  // Mutable: populated by each step as it completes
  holdId?: string;
  paymentId?: string;
  bookingId?: string;
  confirmationId?: string;
  notificationId?: string;

  // Tracking
  currentStep: number;
  status: SagaStatus;
  failureReason?: string;
  completedAt?: Date;
}

/** A single step in the saga: "do" and "undo". */
export interface SagaStep {
  /** Human-readable name for logging and state persistence */
  name: string;
  /** The forward action. Receives the context, mutates it on success. */
  execute: (context: SagaContext) => Promise<void>;
  /** The compensating action. Undoes what execute() did. */
  compensate: (context: SagaContext) => Promise<void>;
  /** Max time (ms) this step is allowed to take before we consider it failed. */
  timeoutMs: number;
}

/** The result returned to the caller after a saga completes or fails. */
export interface SagaResult {
  success: boolean;
  sagaId: string;
  bookingId?: string;
  failedStep?: string;
  error?: string;
  compensationStatus?: 'COMPENSATED' | 'COMPENSATION_FAILED';
  durationMs: number;
}

/** The DTO for creating a booking. */
export interface CreateBookingDto {
  userId: string;
  resourceType: string;       // 'hotel_room', 'flight_seat', 'car_rental'
  resourceId: string;         // Which specific resource
  date: string;               // ISO date string
  checkIn: string;
  checkOut: string;
  quantity: number;
  totalAmount: number;
  currency: string;
  paymentMethod: string;      // 'credit_card', 'wallet', etc.
  sessionId: string;          // Browser session for deduplication
  idempotencyKey: string;     // Client-provided key for retry safety
  guestEmail: string;
  guestPhone?: string;
}
```

Notice the `timeoutMs` field on each `SagaStep`. In the original chapter, we did not address what happens when a step hangs. A step that never returns is worse than a step that fails -- at least a failure triggers compensation. We will use this timeout to prevent sagas from getting stuck forever.

### Step 2: The Five Saga Steps

Each step is a pair: the forward action and the compensating action. Read them as "do" and "undo."

```typescript
// src/sagas/steps/booking-saga.steps.ts
import { Injectable } from '@nestjs/common';
import { SagaStep, SagaContext } from '../types/saga.types';
import { InventoryService } from '../../inventory/inventory.service';
import { PaymentService } from '../../payment/payment.service';
import { BookingService } from '../../booking/booking.service';
import { NotificationService } from '../../notification/notification.service';

@Injectable()
export class BookingSagaSteps {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly bookingService: BookingService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * Returns the ordered array of saga steps.
   * The orchestrator will execute them top-to-bottom on the happy path
   * and compensate bottom-to-top on failure.
   */
  getSteps(): SagaStep[] {
    return [

      // ── Step 1: Reserve Inventory ─────────────────────────
      // Forward:    Place a 10-minute hold on the requested resource.
      // Compensate: Release the hold so the resource becomes available again.
      {
        name: 'RESERVE_INVENTORY',
        timeoutMs: 5_000,
        execute: async (ctx: SagaContext) => {
          const hold = await this.inventoryService.createHold({
            resourceType: ctx.bookingDto.resourceType,
            resourceId: ctx.bookingDto.resourceId,
            date: ctx.bookingDto.date,
            quantity: ctx.bookingDto.quantity,
            userId: ctx.bookingDto.userId,
            sessionId: ctx.bookingDto.sessionId,
            idempotencyKey: `${ctx.sagaId}-inventory`,   // Saga-scoped idempotency
            ttlSeconds: 600,                              // 10-minute hold
          });
          ctx.holdId = hold.id;  // Save to clipboard
        },
        compensate: async (ctx: SagaContext) => {
          if (ctx.holdId) {
            await this.inventoryService.releaseHold(
              ctx.holdId,
              'saga-compensation',
              ctx.sagaId,
            );
          }
          // If holdId is undefined, the step never completed.
          // Nothing to compensate. This is safe.
        },
      },

      // ── Step 2: Charge Payment ────────────────────────────
      // Forward:    Authorize and capture the payment.
      // Compensate: Issue a full refund.
      {
        name: 'CHARGE_PAYMENT',
        timeoutMs: 15_000,   // Payment gateways can be slow
        execute: async (ctx: SagaContext) => {
          const payment = await this.paymentService.chargePayment({
            userId: ctx.bookingDto.userId,
            amount: ctx.bookingDto.totalAmount,
            currency: ctx.bookingDto.currency,
            paymentMethod: ctx.bookingDto.paymentMethod,
            holdId: ctx.holdId!,
            idempotencyKey: `${ctx.sagaId}-payment`,
          });
          ctx.paymentId = payment.transactionId;
        },
        compensate: async (ctx: SagaContext) => {
          if (ctx.paymentId) {
            await this.paymentService.refundPayment(
              ctx.paymentId,
              `saga-compensation:${ctx.sagaId}`,
            );
          }
        },
      },

      // ── Step 3: Create Booking Record ─────────────────────
      // Forward:    Insert the booking into the Booking Service's database.
      // Compensate: Mark the booking as cancelled.
      {
        name: 'CREATE_BOOKING',
        timeoutMs: 5_000,
        execute: async (ctx: SagaContext) => {
          const booking = await this.bookingService.createBooking({
            ...ctx.bookingDto,
            paymentId: ctx.paymentId!,
            holdId: ctx.holdId!,
            sagaId: ctx.sagaId,
            idempotencyKey: `${ctx.sagaId}-booking`,
          });
          ctx.bookingId = booking.id;
        },
        compensate: async (ctx: SagaContext) => {
          if (ctx.bookingId) {
            await this.bookingService.cancelBooking(
              ctx.bookingId,
              `saga-compensation:${ctx.sagaId}`,
            );
          }
        },
      },

      // ── Step 4: Confirm Inventory ─────────────────────────
      // Forward:    Convert the temporary hold into a permanent reservation.
      // Compensate: Revert to hold state (which step 1's compensation
      //             will then release).
      {
        name: 'CONFIRM_INVENTORY',
        timeoutMs: 5_000,
        execute: async (ctx: SagaContext) => {
          const confirmation = await this.inventoryService.confirmHold(
            ctx.holdId!,
            ctx.bookingId!,
          );
          ctx.confirmationId = confirmation.id;
        },
        compensate: async (ctx: SagaContext) => {
          if (ctx.confirmationId) {
            await this.inventoryService.revertConfirmation(
              ctx.confirmationId,
              ctx.holdId!,
              `saga-compensation:${ctx.sagaId}`,
            );
          }
        },
      },

      // ── Step 5: Send Notification ─────────────────────────
      // Forward:    Send confirmation email and/or SMS.
      // Compensate: Send a cancellation notice.
      // NOTE: This step is "best-effort." A failed notification does NOT
      //       cause the entire saga to fail. The booking is already confirmed.
      {
        name: 'SEND_NOTIFICATION',
        timeoutMs: 10_000,
        execute: async (ctx: SagaContext) => {
          const notification = await this.notificationService.sendConfirmation({
            userId: ctx.bookingDto.userId,
            email: ctx.bookingDto.guestEmail,
            phone: ctx.bookingDto.guestPhone,
            bookingId: ctx.bookingId!,
            sagaId: ctx.sagaId,
            idempotencyKey: `${ctx.sagaId}-notification`,
          });
          ctx.notificationId = notification.id;
        },
        compensate: async (ctx: SagaContext) => {
          if (ctx.notificationId) {
            // Best effort: send a "your booking was cancelled" notice.
            // If this also fails, it goes to the dead letter queue.
            await this.notificationService.sendCancellation({
              userId: ctx.bookingDto.userId,
              email: ctx.bookingDto.guestEmail,
              bookingId: ctx.bookingId!,
              originalNotificationId: ctx.notificationId,
            });
          }
        },
      },
    ];
  }
}
```

Let us pause and make sure each pair makes sense:

| Step | Forward Action | Compensating Action | Can It Be Undone Perfectly? |
|------|---------------|--------------------|-----------------------------|
| 1 | Reserve room for 10 minutes | Release the reservation | Yes -- room is immediately available again |
| 2 | Charge the credit card | Issue a full refund | Mostly -- refund takes 3-5 business days |
| 3 | Create booking record | Cancel the booking record | Yes -- mark as `CANCELLED` in the database |
| 4 | Convert hold to permanent reservation | Revert confirmation to hold | Yes -- reverses the state change |
| 5 | Send confirmation email | Send cancellation email | No -- the original email was already read |

The last column is important. Not every compensating action can perfectly undo its forward action. Refunds take days. Emails cannot be un-read. Compensation achieves *logical* consistency, not *physical* reversal.

### Step 3: The Orchestrator Engine

This is the heart of the system -- the engine that executes steps, handles failures, and coordinates compensation.

```typescript
// src/sagas/orchestrator/booking-saga.orchestrator.ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SagaContext, SagaResult, SagaStatus, SagaStep, CreateBookingDto,
} from '../types/saga.types';
import { BookingSagaSteps } from '../steps/booking-saga.steps';
import { SagaRepository } from '../repository/saga.repository';
import { SagaMetrics } from '../monitoring/saga.metrics';
import { DeadLetterQueue } from '../../messaging/dead-letter-queue.service';

@Injectable()
export class BookingSagaOrchestrator {
  private readonly logger = new Logger(BookingSagaOrchestrator.name);
  private readonly steps: SagaStep[];

  constructor(
    private readonly sagaSteps: BookingSagaSteps,
    private readonly sagaRepo: SagaRepository,
    private readonly metrics: SagaMetrics,
    private readonly dlq: DeadLetterQueue,
  ) {
    this.steps = this.sagaSteps.getSteps();
  }

  /**
   * Execute the entire booking saga.
   * This is the single entry point called by the BookingController.
   */
  async execute(dto: CreateBookingDto): Promise<SagaResult> {
    const startTime = Date.now();

    // ── 1. Check idempotency: has this saga already been executed? ──
    const existing = await this.sagaRepo.findByIdempotencyKey(
      dto.idempotencyKey,
    );
    if (existing) {
      this.logger.log(
        `Saga already exists for idempotency key ${dto.idempotencyKey}. ` +
        `Returning cached result.`,
      );
      return this.buildResultFromContext(existing, startTime);
    }

    // ── 2. Initialize the saga context ──
    const context: SagaContext = {
      sagaId: randomUUID(),
      bookingDto: dto,
      startedAt: new Date(),
      currentStep: 0,
      status: SagaStatus.STARTED,
    };

    // ── 3. Persist the saga BEFORE doing anything ──
    //    If we crash here, the recovery process finds a STARTED saga
    //    and knows it never progressed past initialization.
    await this.sagaRepo.createSagaInstance(context);
    this.metrics.sagaStarted();

    // ── 4. Execute each step in order ──
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      context.currentStep = i;

      // Record that we are ABOUT to execute this step.
      await this.sagaRepo.recordStepStarted(context.sagaId, step.name, i);

      try {
        // Wrap the step execution with a timeout.
        // A step that hangs forever is worse than one that fails.
        await this.executeWithTimeout(
          () => step.execute(context),
          step.timeoutMs,
          step.name,
        );

        // Step succeeded. Record the success.
        context.status = step.name as unknown as SagaStatus;
        await this.sagaRepo.recordStepCompleted(
          context.sagaId, step.name, i, context,
        );

        this.logger.log(
          `Saga ${context.sagaId}: Step ${i + 1}/${this.steps.length} ` +
          `(${step.name}) completed successfully.`,
        );
      } catch (error) {
        // ── Step failed. Begin compensation. ──
        this.logger.error(
          `Saga ${context.sagaId}: Step ${step.name} failed: ${error.message}`,
        );

        context.status = SagaStatus.COMPENSATING;
        context.failureReason = `${step.name}: ${error.message}`;
        await this.sagaRepo.recordStepFailed(
          context.sagaId, step.name, i, error.message,
        );

        // Compensate all previously COMPLETED steps, in reverse order.
        const compensationSuccess = await this.compensate(context, i);

        context.status = compensationSuccess
          ? SagaStatus.COMPENSATED
          : SagaStatus.COMPENSATION_FAILED;
        context.completedAt = new Date();
        await this.sagaRepo.updateSagaInstance(context);

        this.metrics.sagaFailed(step.name, Date.now() - startTime);

        return {
          success: false,
          sagaId: context.sagaId,
          failedStep: step.name,
          error: error.message,
          compensationStatus: compensationSuccess
            ? 'COMPENSATED'
            : 'COMPENSATION_FAILED',
          durationMs: Date.now() - startTime,
        };
      }
    }

    // ── 5. All steps succeeded ──
    context.status = SagaStatus.COMPLETED;
    context.completedAt = new Date();
    await this.sagaRepo.updateSagaInstance(context);
    this.metrics.sagaCompleted(Date.now() - startTime);

    this.logger.log(
      `Saga ${context.sagaId}: All ${this.steps.length} steps completed. ` +
      `Booking ID: ${context.bookingId}`,
    );

    return {
      success: true,
      sagaId: context.sagaId,
      bookingId: context.bookingId,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute a function with a timeout.
   * If the function does not resolve within `timeoutMs`,
   * we reject with a timeout error.
   */
  private async executeWithTimeout(
    fn: () => Promise<void>,
    timeoutMs: number,
    stepName: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `Step ${stepName} timed out after ${timeoutMs}ms`,
        ));
      }, timeoutMs);

      fn()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Run compensating transactions in reverse order,
   * starting from the step BEFORE the one that failed.
   * Returns true if all compensations succeeded.
   */
  private async compensate(
    context: SagaContext,
    failedStepIndex: number,
  ): Promise<boolean> {
    let allSucceeded = true;

    // If step 3 failed (index 3), compensate steps 2, 1, 0.
    // If step 0 failed (index 0), the loop body never runs.
    for (let i = failedStepIndex - 1; i >= 0; i--) {
      const step = this.steps[i];

      try {
        this.logger.warn(
          `Saga ${context.sagaId}: Compensating step ${step.name}...`,
        );

        await this.executeWithTimeout(
          () => step.compensate(context),
          step.timeoutMs * 2,   // Give compensations extra time
          `${step.name}_COMPENSATE`,
        );

        await this.sagaRepo.recordStepCompensated(
          context.sagaId, step.name, i,
        );

        this.logger.warn(
          `Saga ${context.sagaId}: Step ${step.name} compensated successfully.`,
        );
      } catch (compensationError) {
        // The undo itself failed. This is the nightmare scenario.
        allSucceeded = false;

        this.logger.error(
          `Saga ${context.sagaId}: COMPENSATION FAILED for step ` +
          `${step.name}: ${compensationError.message}`,
        );

        await this.sagaRepo.recordCompensationFailed(
          context.sagaId, step.name, i, compensationError.message,
        );

        // Write to dead letter queue for manual resolution.
        await this.dlq.publish({
          sagaId: context.sagaId,
          step: step.name,
          stepIndex: i,
          error: compensationError.message,
          context: JSON.stringify(context),
          timestamp: new Date().toISOString(),
        });

        this.metrics.compensationFailed(step.name);

        // IMPORTANT: Do NOT stop compensating remaining steps.
        // Even if step 2's compensation failed, we still try step 1
        // and step 0. Each compensation is independent.
      }
    }

    return allSucceeded;
  }

  /** Build a SagaResult from an already-existing context (for idempotent replays). */
  private buildResultFromContext(
    context: SagaContext,
    startTime: number,
  ): SagaResult {
    return {
      success: context.status === SagaStatus.COMPLETED,
      sagaId: context.sagaId,
      bookingId: context.bookingId,
      failedStep: context.failureReason?.split(':')[0],
      error: context.failureReason,
      durationMs: Date.now() - startTime,
    };
  }
}
```

Let us unpack the critical design decisions in this orchestrator:

**1. Idempotency check at the top.** Before creating a new saga, we check whether a saga with the same `idempotencyKey` already exists. If the client retries a request (because they got a network timeout), we return the cached result instead of creating a duplicate booking. This is not optional -- without it, every retry creates a new charge on the customer's credit card.

**2. State persistence before every step.** We call `sagaRepo.recordStepStarted()` *before* executing the step and `sagaRepo.recordStepCompleted()` *after*. If the orchestrator crashes between these two calls, the recovery process knows the step was started but not completed. It can then retry or compensate.

**3. Timeout wrapping.** Every step is wrapped in `executeWithTimeout()`. A payment gateway that hangs for 60 seconds without responding ties up the saga and the resources it holds. The timeout converts a hang into an explicit failure, which triggers compensation.

**4. Compensation continues even when a compensation fails.** Look at the comment inside the `compensate()` method: "Do NOT stop compensating remaining steps." If refunding the payment fails, we *still* try to release the inventory hold. Each compensation is independent. The dead letter queue catches the ones that need manual attention.

> **What If You Skip This?** If you do not wrap saga steps in timeouts, a single unresponsive downstream service can cause all your sagas to pile up. The orchestrator's thread pool fills up, new bookings are rejected, and your system appears to be "down" even though only one downstream service is slow. We have seen a payment gateway timeout cause a 45-minute outage because the orchestrator had no timeout -- every saga waited indefinitely for a response that never came.

---

## Compensating Transactions: What to Undo When Step 3 of 5 Fails

Let us walk through a concrete failure scenario in detail. Understanding this walkthrough is the key to internalizing the Saga pattern.

**Scenario:** A customer books a hotel room. Steps 1, 2, and 3 succeed. Step 4 (confirm inventory) fails because the Inventory Service's database has a replication lag and the hold record has not propagated to the primary yet.

Here is what happens, tick by tick:

```
Timeline:
─────────────────────────────────────────────────────────────────
T+0ms     Saga starts. sagaId = "a1b2c3"
T+12ms    Step 1 (RESERVE_INVENTORY) → SUCCESS. holdId = "h-991"
T+45ms    Step 2 (CHARGE_PAYMENT) → SUCCESS. paymentId = "pay-442"
T+62ms    Step 3 (CREATE_BOOKING) → SUCCESS. bookingId = "bk-7788"
T+78ms    Step 4 (CONFIRM_INVENTORY) → FAILED!
          Error: "Hold h-991 not found on primary replica"
─────────────────────────────────────────────────────────────────
          Compensation begins. failedStepIndex = 3.
          Compensate steps 2, 1, 0 (reverse order).
─────────────────────────────────────────────────────────────────
T+80ms    Compensate step 2 (CREATE_BOOKING):
          → bookingService.cancelBooking("bk-7788")
          → Booking record marked as CANCELLED. ✓
T+95ms    Compensate step 1 (CHARGE_PAYMENT):
          → paymentService.refundPayment("pay-442")
          → Refund initiated. Customer gets money back in 3-5 days. ✓
T+110ms   Compensate step 0 (RESERVE_INVENTORY):
          → inventoryService.releaseHold("h-991")
          → Room is available for other customers again. ✓
─────────────────────────────────────────────────────────────────
T+112ms   Saga status = COMPENSATED. All undos succeeded.
          Return: { success: false, failedStep: "CONFIRM_INVENTORY" }
```

Notice the reverse order: step 2, then step 1, then step 0. This is not arbitrary. Compensation runs in reverse because later steps may depend on earlier ones. If we released the inventory hold (step 0) before cancelling the booking (step 2), there would be a brief moment where the booking record exists but the inventory is available -- another customer could grab the room, and now two bookings reference the same room.

### The Worst Case: Compensation Itself Fails

Now consider a harder scenario. Step 4 fails, and during compensation, the refund (compensating step 1) also fails because the Payment Service is temporarily unreachable.

```
Timeline:
─────────────────────────────────────────────────────────────────
T+80ms    Compensate step 2 (CREATE_BOOKING) → SUCCESS ✓
T+95ms    Compensate step 1 (CHARGE_PAYMENT) → FAILED!
          Error: "Payment Service unavailable (503)"
          → Write to Dead Letter Queue:
            { sagaId: "a1b2c3", step: "CHARGE_PAYMENT",
              error: "503", context: {...} }
          → Continue compensating (do NOT stop here)
T+110ms   Compensate step 0 (RESERVE_INVENTORY) → SUCCESS ✓
─────────────────────────────────────────────────────────────────
T+112ms   Saga status = COMPENSATION_FAILED
          (because one compensation did not complete)
```

The system is now in an inconsistent state: the booking is cancelled, the room is released, but the customer's card is still charged. This is where the **dead letter queue** earns its keep. An operations team member or an automated reconciliation job reads the DLQ entry and manually triggers the refund once the Payment Service is back online.

This might feel unsatisfying. You might think, "The system should handle this automatically." And you are right -- in many cases, a background retry job *will* process the DLQ entry automatically. But the key insight is: **you cannot guarantee automatic resolution for every failure**. Some failures require human judgment. The Saga pattern's honesty about this is a feature, not a bug.

> **Key Term:** **Dead Letter Queue (DLQ)** -- A message queue where messages are sent when automated processing has exhausted all retry attempts. In the context of sagas, DLQ entries represent compensating actions that failed and require manual resolution. Monitoring DLQ depth is a critical production metric.

---

## Saga Execution Tracking: Storing Saga State in the Database

Every saga must persist its state to a durable store. Without persistence, a server crash means lost sagas -- inventory held indefinitely, payments charged with no booking, customers left in limbo.

We need two tables: `saga_instances` (one row per saga) and `saga_steps` (one row per step execution within a saga).

### Raw SQL: CREATE TABLE

```sql
-- ── Table 1: saga_instances ──────────────────────────────────────
-- One row per saga execution. This is the "flight recorder."
CREATE TABLE saga_instances (
  id              VARCHAR(36)   PRIMARY KEY,        -- UUID, same as sagaId
  idempotency_key VARCHAR(255)  NOT NULL UNIQUE,    -- Client-provided dedup key
  saga_type       VARCHAR(50)   NOT NULL DEFAULT 'BOOKING',
  status          VARCHAR(30)   NOT NULL,           -- STARTED, COMPLETED, COMPENSATED, etc.
  current_step    INT           NOT NULL DEFAULT 0,
  context_data    JSON          NOT NULL,           -- Full SagaContext as JSON
  failure_reason  TEXT          NULL,
  started_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at    TIMESTAMP(3)  NULL,

  -- Extracted fields for efficient querying (denormalized from context_data)
  user_id         VARCHAR(36)   NOT NULL,
  booking_id      VARCHAR(36)   NULL,
  hold_id         VARCHAR(36)   NULL,
  payment_id      VARCHAR(36)   NULL,

  -- Indexes for the queries we will actually run in production
  INDEX idx_saga_status      (status),
  INDEX idx_saga_user        (user_id),
  INDEX idx_saga_started     (started_at),
  INDEX idx_saga_stuck       (status, updated_at),       -- Find stuck sagas
  INDEX idx_saga_idempotency (idempotency_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ── Table 2: saga_steps ──────────────────────────────────────────
-- One row per step execution. A saga with 5 steps has up to 5 rows here.
-- If compensation runs, additional rows are added for the compensating actions.
CREATE TABLE saga_steps (
  id              BIGINT        AUTO_INCREMENT PRIMARY KEY,
  saga_id         VARCHAR(36)   NOT NULL,           -- FK to saga_instances.id
  step_name       VARCHAR(50)   NOT NULL,           -- 'RESERVE_INVENTORY', etc.
  step_index      INT           NOT NULL,           -- 0, 1, 2, 3, 4
  action_type     VARCHAR(15)   NOT NULL DEFAULT 'EXECUTE',  -- 'EXECUTE' or 'COMPENSATE'
  status          VARCHAR(20)   NOT NULL,           -- 'STARTED', 'COMPLETED', 'FAILED'
  error_message   TEXT          NULL,
  context_snapshot JSON         NULL,               -- Context state at this point
  started_at      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at    TIMESTAMP(3)  NULL,
  duration_ms     INT           NULL,               -- How long this step took

  INDEX idx_step_saga       (saga_id),
  INDEX idx_step_status     (status),
  INDEX idx_step_name       (step_name, status),    -- "How many payment steps failed today?"
  CONSTRAINT fk_step_saga   FOREIGN KEY (saga_id)
                             REFERENCES saga_instances(id)
                             ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Let us explain why these tables are designed this way:

**`saga_instances` stores the denormalized context.** The `context_data` JSON column holds the complete `SagaContext` object. We also extract `user_id`, `booking_id`, `hold_id`, and `payment_id` into their own columns so we can query them efficiently without parsing JSON. This is a deliberate denormalization: the JSON is the source of truth for the orchestrator, and the extracted columns are indexes for your operations dashboard.

**`saga_steps` is an append-only log.** Each step execution creates a new row. When compensation runs, it adds more rows with `action_type = 'COMPENSATE'`. This gives you a complete audit trail of everything the saga did, in chronological order.

**The `idx_saga_stuck` index** is the most important one operationally. It lets you run this query efficiently:

```sql
-- Find sagas that have been stuck for more than 5 minutes.
-- These are sagas where the orchestrator crashed or a step is hanging.
SELECT id, status, current_step, context_data, failure_reason,
       TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS stuck_seconds
FROM saga_instances
WHERE status NOT IN ('COMPLETED', 'COMPENSATED', 'COMPENSATION_FAILED')
  AND updated_at < NOW() - INTERVAL 5 MINUTE
ORDER BY updated_at ASC;
```

### Prisma Schema

Here is the same schema expressed in Prisma, which generates the migration SQL and provides type-safe queries:

```prisma
// prisma/schema.prisma

model SagaInstance {
  id              String       @id @default(uuid()) @db.VarChar(36)
  idempotencyKey  String       @unique @map("idempotency_key") @db.VarChar(255)
  sagaType        String       @default("BOOKING") @map("saga_type") @db.VarChar(50)
  status          String       @db.VarChar(30)
  currentStep     Int          @default(0) @map("current_step")
  contextData     Json         @map("context_data")
  failureReason   String?      @map("failure_reason") @db.Text
  startedAt       DateTime     @default(now()) @map("started_at") @db.Timestamp(3)
  updatedAt       DateTime     @updatedAt @map("updated_at") @db.Timestamp(3)
  completedAt     DateTime?    @map("completed_at") @db.Timestamp(3)

  // Denormalized fields for efficient querying
  userId          String       @map("user_id") @db.VarChar(36)
  bookingId       String?      @map("booking_id") @db.VarChar(36)
  holdId          String?      @map("hold_id") @db.VarChar(36)
  paymentId       String?      @map("payment_id") @db.VarChar(36)

  // Relations
  steps           SagaStep[]

  @@index([status], name: "idx_saga_status")
  @@index([userId], name: "idx_saga_user")
  @@index([startedAt], name: "idx_saga_started")
  @@index([status, updatedAt], name: "idx_saga_stuck")
  @@map("saga_instances")
}

model SagaStep {
  id              BigInt       @id @default(autoincrement())
  sagaId          String       @map("saga_id") @db.VarChar(36)
  stepName        String       @map("step_name") @db.VarChar(50)
  stepIndex       Int          @map("step_index")
  actionType      String       @default("EXECUTE") @map("action_type") @db.VarChar(15)
  status          String       @db.VarChar(20)
  errorMessage    String?      @map("error_message") @db.Text
  contextSnapshot Json?        @map("context_snapshot")
  startedAt       DateTime     @default(now()) @map("started_at") @db.Timestamp(3)
  completedAt     DateTime?    @map("completed_at") @db.Timestamp(3)
  durationMs      Int?         @map("duration_ms")

  // Relations
  saga            SagaInstance @relation(fields: [sagaId], references: [id], onDelete: Cascade)

  @@index([sagaId], name: "idx_step_saga")
  @@index([status], name: "idx_step_status")
  @@index([stepName, status], name: "idx_step_name")
  @@map("saga_steps")
}
```

### Prisma Client: The Saga Repository

Now let us implement the `SagaRepository` that the orchestrator depends on. Every method maps to a Prisma Client call:

```typescript
// src/sagas/repository/saga.repository.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SagaContext, SagaStatus } from '../types/saga.types';

@Injectable()
export class SagaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a new saga instance (called once at saga start). */
  async createSagaInstance(context: SagaContext): Promise<void> {
    await this.prisma.sagaInstance.create({
      data: {
        id:             context.sagaId,
        idempotencyKey: context.bookingDto.idempotencyKey,
        sagaType:       'BOOKING',
        status:         context.status,
        currentStep:    context.currentStep,
        contextData:    JSON.parse(JSON.stringify(context)),
        userId:         context.bookingDto.userId,
        startedAt:      context.startedAt,
      },
    });
  }

  /** Update an existing saga instance (status, context, completion). */
  async updateSagaInstance(context: SagaContext): Promise<void> {
    await this.prisma.sagaInstance.update({
      where: { id: context.sagaId },
      data: {
        status:        context.status,
        currentStep:   context.currentStep,
        contextData:   JSON.parse(JSON.stringify(context)),
        failureReason: context.failureReason,
        completedAt:   context.completedAt,
        bookingId:     context.bookingId,
        holdId:        context.holdId,
        paymentId:     context.paymentId,
      },
    });
  }

  /** Find an existing saga by its idempotency key (for retry detection). */
  async findByIdempotencyKey(key: string): Promise<SagaContext | null> {
    const instance = await this.prisma.sagaInstance.findUnique({
      where: { idempotencyKey: key },
    });
    if (!instance) return null;
    return instance.contextData as unknown as SagaContext;
  }

  /** Record that a step is about to execute. */
  async recordStepStarted(
    sagaId: string, stepName: string, stepIndex: number,
  ): Promise<void> {
    await this.prisma.sagaStep.create({
      data: {
        sagaId,
        stepName,
        stepIndex,
        actionType: 'EXECUTE',
        status:     'STARTED',
      },
    });
  }

  /** Record that a step completed successfully. */
  async recordStepCompleted(
    sagaId: string,
    stepName: string,
    stepIndex: number,
    context: SagaContext,
  ): Promise<void> {
    // Find the STARTED record and update it.
    const existing = await this.prisma.sagaStep.findFirst({
      where: { sagaId, stepName, actionType: 'EXECUTE', status: 'STARTED' },
      orderBy: { startedAt: 'desc' },
    });

    if (existing) {
      const durationMs = Date.now() - existing.startedAt.getTime();
      await this.prisma.sagaStep.update({
        where: { id: existing.id },
        data: {
          status:          'COMPLETED',
          completedAt:     new Date(),
          durationMs,
          contextSnapshot: JSON.parse(JSON.stringify(context)),
        },
      });
    }

    // Also update the parent saga instance.
    await this.updateSagaInstance(context);
  }

  /** Record that a step failed. */
  async recordStepFailed(
    sagaId: string,
    stepName: string,
    stepIndex: number,
    errorMessage: string,
  ): Promise<void> {
    const existing = await this.prisma.sagaStep.findFirst({
      where: { sagaId, stepName, actionType: 'EXECUTE', status: 'STARTED' },
      orderBy: { startedAt: 'desc' },
    });

    if (existing) {
      await this.prisma.sagaStep.update({
        where: { id: existing.id },
        data: {
          status:       'FAILED',
          errorMessage,
          completedAt:  new Date(),
          durationMs:   Date.now() - existing.startedAt.getTime(),
        },
      });
    }
  }

  /** Record that a step was successfully compensated. */
  async recordStepCompensated(
    sagaId: string, stepName: string, stepIndex: number,
  ): Promise<void> {
    await this.prisma.sagaStep.create({
      data: {
        sagaId,
        stepName,
        stepIndex,
        actionType: 'COMPENSATE',
        status:     'COMPLETED',
        completedAt: new Date(),
      },
    });
  }

  /** Record that compensation failed for a step. */
  async recordCompensationFailed(
    sagaId: string,
    stepName: string,
    stepIndex: number,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.sagaStep.create({
      data: {
        sagaId,
        stepName,
        stepIndex,
        actionType: 'COMPENSATE',
        status:     'FAILED',
        errorMessage,
        completedAt: new Date(),
      },
    });
  }

  /** Find all stuck sagas (for the recovery process). */
  async findStuckSagas(stuckThresholdMinutes: number = 5): Promise<SagaContext[]> {
    const threshold = new Date(
      Date.now() - stuckThresholdMinutes * 60 * 1000,
    );

    const stuck = await this.prisma.sagaInstance.findMany({
      where: {
        status: {
          notIn: [
            SagaStatus.COMPLETED,
            SagaStatus.COMPENSATED,
            SagaStatus.COMPENSATION_FAILED,
          ],
        },
        updatedAt: { lt: threshold },
      },
      orderBy: { updatedAt: 'asc' },
    });

    return stuck.map(
      (s) => s.contextData as unknown as SagaContext,
    );
  }
}
```

This repository is the bridge between the orchestrator's in-memory state and the durable database. Every saga operation flows through it. If the orchestrator crashes and restarts, `findStuckSagas()` discovers all sagas that were abandoned mid-flight and feeds them back into the orchestrator for completion or compensation.

> **Key Term:** **Saga State Persistence** -- The practice of saving the saga's progress to durable storage (a database) at each step transition. This enables crash recovery: a new process can read the saved state, determine where the saga left off, and continue or compensate accordingly. The `saga_instances` table is the saga's "flight recorder."

> **Checkpoint:** Before moving on, make sure you can answer these questions:
>
> 1. Why does `saga_instances` have both a `context_data` JSON column *and* dedicated columns like `booking_id` and `payment_id`?
> 2. Why does `saga_steps` use `action_type` to distinguish between `EXECUTE` and `COMPENSATE` rows?
> 3. What query would you run to find all sagas that have a failed compensation?
>
> If you struggle with question 3, the answer is: `SELECT * FROM saga_steps WHERE action_type = 'COMPENSATE' AND status = 'FAILED'`. Join with `saga_instances` to get the full context.
