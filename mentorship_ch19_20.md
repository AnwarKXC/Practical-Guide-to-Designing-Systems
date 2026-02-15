# Part 6: Distributed Patterns & Resilience

---

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

> **Key Term:** **Distributed Transaction** — A transaction that spans multiple services or databases. Unlike a local transaction, there is no single database engine coordinating the commit or rollback. You must coordinate it yourself.

## The Wedding Planning Analogy

> **Analogy:** Imagine you are planning a wedding. You need to book three vendors: a venue, a caterer, and a photographer. Each vendor has their own contract, their own cancellation policy, and their own calendar. You cannot call all three simultaneously and say "book yourselves together as one atomic operation." Instead, you call them one at a time:
>
> 1. You book the venue. The venue confirms: "You're on our calendar for June 15th."
> 2. You book the caterer. The caterer confirms: "We'll be there with 120 plates."
> 3. You call the photographer. The photographer says: "Sorry, I'm already booked that day."
>
> Now what? The venue is reserved. The caterer is reserved. But you have no photographer, and a wedding without photos is not acceptable. You need to **undo** steps 1 and 2 -- call the venue and cancel, call the caterer and cancel. These undo operations are called **compensating actions**. They do not magically reverse time. The venue might charge you a cancellation fee. The caterer might keep your deposit. But they bring the system back to a *logically consistent state*: no half-planned wedding sitting in limbo.
>
> That is exactly what the Saga pattern does for distributed systems.

## Why You Cannot Just Use a Bigger Transaction

Before we go further, let us address the temptation: "Can't I just use a distributed transaction protocol like two-phase commit?" Technically, yes. Practically, it is a terrible idea at scale.

Two-phase commit (2PC) locks resources across all participating databases until every participant agrees to commit. At 100,000 bookings per minute, those locks create devastating bottlenecks. If any participant is slow or unreachable, every other participant is stuck waiting with resources locked. One slow service brings the entire system to its knees.

> **Key Term:** **Two-phase commit (2PC)** — A distributed transaction protocol where a coordinator asks all participants to prepare (phase 1), then tells them to commit (phase 2). It guarantees atomicity but requires locking resources across all participants until agreement is reached, creating severe bottlenecks at scale.

The Saga pattern takes a different approach. Instead of locking everything and hoping for the best, it executes each step independently and defines an explicit "undo" for each step. If step 3 fails, you undo step 2, then undo step 1. No cross-service locks. No waiting for global consensus. Each service does its work and moves on.

> **What If You Skip This?** Without the Saga pattern (or something like it), your distributed transactions will leave the system in inconsistent states. A customer gets charged but has no booking. A room is reserved but nobody paid for it. An email confirmation goes out for a booking that was never saved. You will spend your weekends writing manual database cleanup scripts and issuing apologetic refunds.

## The Booking Saga: A State Machine

Our booking flow has three steps that must happen in order, each managed by a different service:

1. **Hold Inventory** —Ask the Inventory Service to temporarily reserve a room.
2. **Process Payment** —Ask the Payment Service to charge the customer's card.
3. **Confirm Booking** —Create the booking record and finalize the reservation.

Each step can succeed or fail. If any step fails, we run the compensating actions for all *previously completed* steps, in reverse order. Here is the state machine:

```
                    +------------------+
                    |  SAGA_STARTED    |  <-- We begin here
                    +--------+---------+
                             |
                             v
                    +------------------+     +-------------------+
                    | INVENTORY_HELD   |---->| INVENTORY_FAILED  |
                    +--------+---------+     +-------------------+
                             |                 (No compensation needed --
                             |                  nothing succeeded yet)
                             v
                    +------------------+     +-------------------+
                    | PAYMENT_CHARGED  |---->|  PAYMENT_FAILED   |
                    +--------+---------+     +--------+----------+
                             |                        |
                             |                        v
                             |               Release inventory hold
                             |               (compensate step 1)
                             v
                    +------------------+     +-------------------+
                    |BOOKING_CONFIRMED |---->| BOOKING_FAILED    |
                    +--------+---------+     +--------+----------+
                             |                        |
                             |                        v
                             |               Refund payment (compensate step 2)
                             |               + Release hold (compensate step 1)
                             v
                    +------------------+
                    |  SAGA_COMPLETE   |  <-- Happy path ends here
                    +------------------+
```

Read this diagram from top to bottom. The left column is the happy path -- every step succeeds. The right column shows what happens when a step fails. Notice the pattern: the further down you fail, the more compensation you have to do.

If step 1 (inventory) fails, there is nothing to undo. We never reserved anything or charged anyone.

If step 2 (payment) fails, we have to release the inventory hold from step 1.

If step 3 (booking confirmation) fails, we have to refund the payment from step 2 *and* release the inventory hold from step 1. Compensation always runs in reverse order.

> **Key Term:** **Compensating Action** — An operation that semantically undoes the effect of a previously completed step. It does not literally reverse the operation (you cannot "un-send" a network request). Instead, it performs a new action that logically cancels the original one -- like issuing a refund to undo a charge, or releasing a hold to undo a reservation.

## The Saga Orchestrator: Line by Line

Now let us look at the code. The Saga Orchestrator is the "wedding planner" -- it knows the sequence of steps, executes them in order, and coordinates the undo process when something goes wrong.

### Step 1: Define the Shape of a Saga Step

```typescript
// Every step in the saga has two halves: an "execute" and a "compensate."
// Think of them as "do" and "undo."
interface SagaStep {
  name: string;                                       // Human-readable label for logging
  execute: (context: SagaContext) => Promise<void>;   // The forward action
  compensate: (context: SagaContext) => Promise<void>; // The undo action
}
```

This interface is the foundation of the entire pattern. Every saga step is a pair: the thing you want to do, and the thing that undoes it. This is fundamentally different from a database rollback. A rollback says "pretend this never happened." A compensating action says "this happened, and here is how we reverse its effects."

### Step 2: Define the Saga Context

```typescript
// The context is the shared state that flows through every step.
// Each step can read from it and write to it.
interface SagaContext {
  bookingDto: CreateBookingDto;  // The original booking request from the user
  holdId?: bigint;               // Set by step 1 (inventory hold)
  paymentId?: bigint;            // Set by step 2 (payment charge)
  bookingId?: bigint;            // Set by step 3 (booking confirmation)
  sagaId: string;                // Unique ID for tracking this saga instance
  currentStep: number;           // Which step are we on? (0, 1, or 2)
  status: string;                // Current state (for persistence and debugging)
}
```

The context is like a clipboard that the wedding planner carries around. When the venue confirms, they write the reservation number on the clipboard. When the caterer confirms, they write the catering order number. If the photographer cancels and we need to undo everything, we look at the clipboard to find the reservation number for canceling the venue and the order number for canceling the caterer.

Notice that `holdId`, `paymentId`, and `bookingId` are all optional (`?`). They start as `undefined` and only get set as each step completes. If step 2 fails, `paymentId` will still be `undefined` -- which is exactly how the compensating action for step 2 knows there is nothing to refund.

### Step 3: Define the Three Saga Steps

Here is the full orchestrator class. Read each step and its compensating action as a pair:

```typescript
export class BookingSagaOrchestrator {

  private readonly steps: SagaStep[] = [

    // ── Step 1: Hold Inventory ──────────────────────────
    // Forward action: Ask Inventory Service to reserve the room.
    // Compensate: Release the hold so the room becomes available again.
    {
      name: 'HOLD_INVENTORY',
      execute: async (ctx) => {
        const hold = await this.inventoryService.createHold({
          resourceType: ctx.bookingDto.resourceType,  // "hotel_room", "flight_seat", etc.
          resourceId: ctx.bookingDto.resourceId,       // Which specific room
          resourceDate: ctx.bookingDto.date,           // Which date
          quantity: ctx.bookingDto.quantity,            // How many rooms
          userId: ctx.bookingDto.userId,               // Who is booking
          sessionId: ctx.bookingDto.sessionId,         // Browser session (for dedup)
          ttlSeconds: 600                              // Hold expires in 10 minutes
        });
        ctx.holdId = hold.id;  // Save the hold ID on our "clipboard"
      },
      compensate: async (ctx) => {
        if (ctx.holdId) {  // Only release if we actually got a hold
          await this.inventoryService.releaseHold(
            ctx.holdId, 'Saga compensation', 'saga-orchestrator'
          );
        }
      }
    },

    // ── Step 2: Process Payment ─────────────────────────
    // Forward action: Charge the customer's credit card.
    // Compensate: Issue a full refund.
    {
      name: 'PROCESS_PAYMENT',
      execute: async (ctx) => {
        // NOTE: The booking does not exist yet at this point.
        // We reference the holdId, not a bookingId.
        const payment = await this.paymentService.processPayment({
          userId: ctx.bookingDto.userId,
          amount: ctx.bookingDto.totalAmount,
          currency: ctx.bookingDto.currency,
          paymentMethod: ctx.bookingDto.paymentMethod,
          holdId: ctx.holdId        // Link payment to the inventory hold
        });
        ctx.paymentId = payment.transactionId;  // Save on clipboard
      },
      compensate: async (ctx) => {
        if (ctx.paymentId) {  // Only refund if we actually charged
          await this.paymentService.refundPayment(ctx.paymentId, 'Saga rollback');
        }
      }
    },

    // ── Step 3: Confirm Booking ─────────────────────────
    // Forward action: Create the booking record and finalize the hold.
    // Compensate: Cancel the booking record.
    {
      name: 'CONFIRM_BOOKING',
      execute: async (ctx) => {
        const booking = await this.bookingService.createAndConfirmBooking(
          ctx.bookingDto, ctx.paymentId      // Pass the payment reference
        );
        ctx.bookingId = booking.id;          // Save on clipboard
        // Convert the temporary hold into a permanent confirmed reservation
        await this.inventoryService.confirmHold(ctx.holdId, booking.id);
      },
      compensate: async (ctx) => {
        if (ctx.bookingId) {  // Only cancel if we actually created a booking
          await this.bookingService.cancelBooking(ctx.bookingId, 'Saga rollback');
        }
      }
    }
  ];
```

Let us pause here and make sure each pair makes sense:

| Step | Forward Action | Compensating Action | "Wedding" Equivalent |
|------|---------------|--------------------|--------------------|
| 1 | Reserve room for 10 minutes | Release the reservation | Book the venue / Cancel the venue |
| 2 | Charge the credit card | Issue a refund | Pay the caterer / Get your money back |
| 3 | Create booking record + finalize hold | Cancel the booking | Sign the photographer / Cancel the photographer |

Every forward action has a matching undo. If you can internalize this pairing, you understand the Saga pattern.

### Step 4: The Execution Engine

Now here is the code that actually runs the steps in order and handles failures:

```typescript
  async executeSaga(dto: CreateBookingDto): Promise<SagaResult> {
    // Create the context -- our "clipboard" starts mostly empty
    const context: SagaContext = {
      bookingDto: dto,
      sagaId: randomUUID(),     // Every saga gets a unique ID for tracking
      currentStep: 0,
      status: 'STARTED'
    };

    // Persist the saga state BEFORE doing anything.
    // If we crash right here, the recovery process can find this saga
    // and know it never got past STARTED.
    await this.saveSagaState(context);

    // Walk through the steps in order: 0, 1, 2
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      context.currentStep = i;
      context.status = step.name;

      // Save state BEFORE executing.
      // If we crash mid-step, we know which step was in progress.
      await this.saveSagaState(context);

      try {
        await step.execute(context);
      } catch (error) {
        // This step failed. Record the failure.
        context.status = `${step.name}_FAILED`;
        await this.saveSagaState(context);

        // Run compensating transactions for all COMPLETED steps, in reverse.
        await this.compensate(context, i);

        // Tell the caller what happened.
        return {
          success: false,
          sagaId: context.sagaId,
          failedStep: step.name,
          error: error.message
        };
      }
    }

    // All steps succeeded! Mark the saga as complete.
    context.status = 'COMPLETED';
    await this.saveSagaState(context);

    return {
      success: true,
      sagaId: context.sagaId,
      bookingId: context.bookingId
    };
  }
```

This is a straightforward `for` loop. That might surprise you -- you might expect distributed transactions to require some exotic concurrency primitive. But the orchestrator pattern is intentionally sequential. Step 1, then step 2, then step 3. The complexity is not in the execution order; it is in the error handling.

Look at the `catch` block. When a step fails, three things happen:

1. The failure is recorded (`saveSagaState`).
2. Compensation runs for every previously completed step (`this.compensate(context, i)`).
3. The caller receives a failure result with the saga ID and the failed step name.

The caller (your API controller) can use this to return a meaningful error to the user: "Your booking could not be completed because payment processing failed. You have not been charged."

### Step 5: The Compensation Engine

This is where the reverse undo happens:

```typescript
  /**
   * Run compensating transactions in reverse order,
   * starting from the step BEFORE the one that failed.
   */
  private async compensate(context: SagaContext, failedStep: number): Promise<void> {
    // If step 2 failed (index 2), we compensate steps 1 and 0.
    // If step 1 failed (index 1), we compensate step 0 only.
    // If step 0 failed (index 0), the loop body never runs -- nothing to undo.
    for (let i = failedStep - 1; i >= 0; i--) {
      const step = this.steps[i];

      try {
        await step.compensate(context);
        context.status = `${step.name}_COMPENSATED`;
        await this.saveSagaState(context);
      } catch (compensationError) {
        // This is the nightmare scenario: the undo itself failed.
        // We cannot just retry blindly -- we need a human to investigate.
        console.error(
          `Saga ${context.sagaId}: Compensation failed for step ${step.name}`,
          compensationError
        );
        context.status = `${step.name}_COMPENSATION_FAILED`;
        await this.saveSagaState(context);

        // Write to a dead letter queue for manual resolution
        await this.writeToDLQ(context, step.name, compensationError);
      }
    }
  }
```

Let us walk through a concrete failure scenario. Say the user tries to book a hotel room, and step 3 (`CONFIRM_BOOKING`) fails because the Booking Service's database is temporarily down.

Here is what happens, step by step:

1. **Step 0 (`HOLD_INVENTORY`) executed successfully.** The room is held. `ctx.holdId` is set.
2. **Step 1 (`PROCESS_PAYMENT`) executed successfully.** The customer's card was charged. `ctx.paymentId` is set.
3. **Step 2 (`CONFIRM_BOOKING`) fails.** The database is down. An exception is thrown.
4. The `catch` block fires. `failedStep` is `2`.
5. Compensation starts: `for (let i = 2 - 1; i >= 0; i--)` -- so `i` goes `1`, then `0`.
6. **Compensate step 1 (`PROCESS_PAYMENT`):** `ctx.paymentId` exists, so we call `refundPayment`. The customer gets their money back.
7. **Compensate step 0 (`HOLD_INVENTORY`):** `ctx.holdId` exists, so we call `releaseHold`. The room becomes available again.
8. The saga returns `{ success: false, failedStep: 'CONFIRM_BOOKING' }`.

The customer is not charged. The room is not blocked. The system is consistent. Nobody is happy that the booking failed, but at least nobody has a phantom charge on their credit card.

> **Analogy:** The wedding planner calls the photographer and gets rejected. They check their clipboard: "I booked the caterer (order #4471) and the venue (reservation #882)." They call the caterer first (most recently booked) to cancel, then the venue. Each vendor has their own cancellation process, but the planner knows exactly who to call and in what order because the clipboard has every confirmation number.

## What Happens When Compensation Fails?

Look again at the inner `catch` inside the `compensate` method. What if the refund request to the Payment Service also fails? Maybe the Payment Service is also down. Maybe the network is partitioned.

This is the worst-case scenario, and the code handles it honestly: it logs the error, saves the failed state, and writes to a **dead letter queue** (DLQ). A dead letter queue is where messages go when automated processing has given up. A human operator (or an automated reconciliation job) will eventually pick up the message and resolve it manually.

This might feel unsatisfying. "You mean the system just... gives up?" Yes, in a sense. But consider the alternative: retrying the refund indefinitely could cause duplicate refunds if the first attempt actually succeeded but the response was lost. The correct approach is: try once, and if that fails, flag it for human attention. In production systems, this is called **manual intervention** and it is a normal part of operating distributed systems.

> **What If You Skip This?** If you do not handle compensation failures, you will have "stuck" sagas -- half-completed transactions that never get cleaned up. Over time, these accumulate: rooms permanently held, payments never refunded, bookings in limbo. Your support team will drown in "I was charged but have no booking" tickets, and you will have no automated way to find or fix the underlying records.

## Saga State Persistence: Surviving Crashes

You have probably noticed the `saveSagaState` method being called repeatedly. We call it before and after every step. Why so aggressively?

```typescript
  private async saveSagaState(context: SagaContext): Promise<void> {
    await db.execute(`
      INSERT INTO saga_state (saga_id, status, context_data, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE status = ?, context_data = ?, updated_at = NOW()
    `, [
      context.sagaId, context.status, JSON.stringify(context),
      context.status, JSON.stringify(context)
    ]);
  }
```

This method saves the saga's entire state -- which step it is on, what IDs have been generated, what the current status is -- to a `saga_state` table in MySQL. It uses `ON DUPLICATE KEY UPDATE`, which means the first call creates the row, and every subsequent call updates the same row.

Here is why this matters: **the orchestrator process can crash at any time.** The server might run out of memory. Kubernetes might reschedule the pod. A hardware failure might kill the machine. If the orchestrator dies between step 1 and step 2, what happens?

Without state persistence, the saga is lost. The inventory hold exists but nobody knows about it. The hold will eventually expire (we set a 10-minute TTL), but in the meantime, the room is unavailable and the customer has no booking.

With state persistence, a **recovery process** can scan the `saga_state` table on startup, find sagas that are stuck in intermediate states, and either resume them or compensate them:

```
-- Find sagas that did not finish
SELECT saga_id, status, context_data
FROM saga_state
WHERE status NOT IN ('COMPLETED', 'COMPENSATED')
  AND updated_at < NOW() - INTERVAL 5 MINUTE;
```

If a saga was stuck at `HOLD_INVENTORY` (step 0 completed, step 1 never started), the recovery process can pick it up and continue from step 1. If a saga was stuck at `PAYMENT_CHARGED` (step 1 completed, step 2 failed), recovery can either retry step 2 or trigger compensation.

This `saga_state` table is the orchestrator's "flight recorder." No matter what crashes, burns, or reboots, the table tells you exactly where every saga was when it stopped.

> **Key Term:** **Saga State Persistence** — The practice of saving the saga's progress to durable storage (a database) at each step. This enables crash recovery: a new process can read the saved state, determine where the saga left off, and continue or compensate accordingly.

## Orchestration vs. Choreography: Two Flavors of Saga

We have been looking at the **orchestration** approach, where a central coordinator (the `BookingSagaOrchestrator`) controls the flow. There is another approach called **choreography**, where there is no central coordinator. Instead, each service listens for events and decides what to do next.

| Aspect | Orchestration | Choreography |
|--------|-------------|--------------|
| Who controls the flow? | Central orchestrator | No one -- services react to events |
| Where is the logic? | One place (orchestrator class) | Spread across all participating services |
| Easy to understand? | Yes -- read the steps array | No -- you have to trace events across services |
| Easy to change? | Yes -- modify the steps array | Hard -- changing the flow means changing multiple services |
| Single point of failure? | Yes -- the orchestrator | No -- each service is independent |
| Best for... | Complex flows with many steps | Simple flows with 2-3 steps |

For our booking system, orchestration is the right choice. The booking flow is complex (3 steps with specific ordering and compensation logic), and having all that logic in one class makes it dramatically easier to debug and modify. You can read `BookingSagaOrchestrator` top to bottom and understand the entire flow. With choreography, you would have to trace events across three different services to reconstruct the same understanding.

## Connecting Back to What You Know

Let us make this concrete by comparing the monolith transaction to the saga side by side:

```typescript
// ── Monolith: One database, one transaction ──
await db.query('BEGIN');
await db.query('INSERT INTO holds ...');
await db.query('INSERT INTO payments ...');
await db.query('INSERT INTO bookings ...');
await db.query('COMMIT');
// If anything fails: ROLLBACK undoes everything automatically.

// ── Microservices: Three databases, saga pattern ──
// Step 1: inventoryService.createHold()   → if fails, stop
// Step 2: paymentService.processPayment() → if fails, release hold
// Step 3: bookingService.createBooking()  → if fails, refund + release hold
// If everything succeeds: mark saga COMPLETED
// The saga orchestrator coordinates what ROLLBACK used to do for free.
```

The saga is the manual version of what the database engine used to handle automatically. It is more work. It is more code. It has more failure modes. But it is the only option when your data is spread across multiple services and databases. The tradeoff is worth it because it lets each service own its own data, scale independently, and deploy independently -- all the things we discussed in Chapter 6.

## Chapter 19 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Distributed transaction | A logical transaction that spans multiple services; no single database can guarantee atomicity. |
| Saga pattern | Breaks a distributed transaction into ordered local transactions, each with a compensating action. |
| Compensating action | A new operation that logically reverses a previously completed step (e.g., refund reverses charge). |
| Saga orchestrator | A central coordinator that executes steps in sequence and triggers compensation on failure. |
| Saga context | Shared state (the "clipboard") carrying IDs and data through every step. |
| Reverse-order compensation | When step N fails, compensating actions run for steps N-1, N-2, ... down to step 0. |
| Saga state persistence | Saving the saga's progress to a database so a crashed process can recover and resume. |
| Dead letter queue | Where failed compensations go for manual resolution when automated retries are not safe. |
| Orchestration vs. choreography | Central coordinator (one file, easy to read) vs. decentralized events (no single point of failure). |

> **Checkpoint:** Without scrolling back up, answer these:
>
> 1. If step 2 of a three-step saga fails, which steps get compensated, and in what order?
> 2. Why does the orchestrator save state to the database before *and* after each step?
> 3. What happens when a compensating action itself fails?
> 4. Why can't you just use `BEGIN`/`COMMIT`/`ROLLBACK` across three microservices?
>
> If you can answer all four from memory, you have internalized the Saga pattern. If not, re-read the failure scenario walkthrough -- that is where the pattern truly clicks.

---

---

# Chapter 20: CQRS — Separating Reads from Writes

## What You Already Know About Reading and Writing Data

Right now, you probably read and write data through the same database table. Your Express or NestJS app has a `bookings` table, and when a user creates a booking, you `INSERT` into it. When a user wants to see their bookings, you `SELECT` from it. Same table. Same database. Same connection pool.

```typescript
// Writing
await db.query(
  'INSERT INTO bookings (user_id, hotel_id, check_in, check_out, status) VALUES ($1, $2, $3, $4, $5)',
  [userId, hotelId, checkIn, checkOut, 'confirmed']
);

// Reading
const result = await db.query(
  'SELECT * FROM bookings WHERE user_id = $1 ORDER BY created_at DESC',
  [userId]
);
```

At small scale, this works perfectly. Your one PostgreSQL or MySQL instance handles both reads and writes without breaking a sweat. The data is always consistent -- the moment you insert a booking, a subsequent `SELECT` will include it. There is zero delay, zero ambiguity.

But here is what happens at 100,000 bookings per minute.

## The Bottleneck: Reads and Writes Want Different Things

Writes and reads have fundamentally different requirements, and those requirements conflict when they share the same database.

**Writes need strong consistency.** When you book the last available room, the system must guarantee that no one else can book the same room at the same instant. This means row-level locks, ACID transactions, and fencing tokens. These operations are slow by nature -- they sacrifice speed for correctness.

**Reads need speed.** When a user searches for "hotels in Tokyo under $200 with a pool, sorted by guest rating," they expect results in under 200 milliseconds. They do not care if the results are 2 seconds stale -- they care that the results are fast, filterable, and sortable by a dozen different criteria.

When both workloads hit the same database, they fight:

- Write transactions acquire locks. Read queries wait behind those locks.
- Read queries generate heavy I/O (scanning, sorting, aggregating). Write transactions wait for I/O bandwidth.
- You tune the database for fast writes (fewer indexes, simpler schema). Reads get slower.
- You tune for fast reads (more indexes, denormalized data). Writes get slower because every `INSERT` must update all those indexes.

At modest scale, you barely notice this tension. At 100,000 writes per minute with concurrent search traffic, the database is trying to be two things at once and failing at both.

> **Analogy:** Think about a physical store. The **catalog** is how customers browse products -- it has beautiful photos, detailed descriptions, filters by category and price, and it is optimized for discovery. The **order form** is how customers buy products -- it has precise fields for quantity, shipping address, and payment details, and it is optimized for accuracy. Nobody expects the catalog and the order form to be the same document. You would never hand a customer a raw inventory spreadsheet and say "here, find what you want and also fill out your order on row 4,327." Yet that is exactly what we do when we use one database table for both reading and writing.
>
> CQRS says: make the catalog and the order form separate documents. Optimize each for its purpose.

> **Key Term:** **CQRS (Command Query Responsibility Segregation)** — An architectural pattern that separates the write model (commands) from the read model (queries). Writes go to one data store optimized for consistency (e.g., MySQL). Reads come from a different data store optimized for speed (e.g., Elasticsearch). Data flows from the write store to the read store through events.

## The Architecture: Two Stores, One Flow

Here is how our booking system applies CQRS:

```
Commands (Writes):                    Queries (Reads):
  +---------------+                    +---------------+
  |  Booking API  |                    |  Search API   |
  +-------+-------+                    +-------+-------+
          |                                    |
  +-------v-------+                    +-------v-------+
  |    MySQL      |---- Events ---->   | Elasticsearch |
  |   (Primary)   |   (via Kafka)      | (Read Model)  |
  +---------------+                    +---------------+
          |                                    |
    Strong consistency              Sub-200ms queries
    Fencing tokens                  Geo-search
    ACID transactions               Full-text search
```

Let us break down each side.

**The left side (commands/writes):** When a user creates, updates, or cancels a booking, the request goes to the Booking API, which writes to MySQL. MySQL is our **source of truth**. It uses ACID transactions, row-level locks, and fencing tokens to guarantee that every write is correct. This is the "order form" side -- precision above all else.

**The right side (queries/reads):** When a user searches for hotels, views their booking history, or a customer support agent looks up a customer's reservations, the request goes to the Search API, which reads from Elasticsearch. Elasticsearch is our **read model** — a denormalized, indexed, lightning-fast copy of the data, optimized for the exact queries our users run. This is the "catalog" side -- speed and flexibility above all else.

**The arrow in the middle (events):** How does data get from MySQL to Elasticsearch? Through Kafka events. When a booking is created in MySQL, an event is published to Kafka. A component called the **Event Projector** consumes that event and writes the data to Elasticsearch in a format optimized for search queries.

> **Key Term:** **Read Model** — A denormalized, query-optimized representation of the data. Unlike the write model (normalized MySQL tables), the read model stores data in exactly the shape that queries need, even if that means duplicating information. This eliminates expensive JOINs and enables sub-millisecond lookups.

> **Key Term:** **Event Projector** (also called a **Projection Handler**) — A component that listens for events from the write side and transforms them into documents in the read store. It "projects" the write model's data into the read model's format.

## The Event Projector: Syncing Writes to Reads

The Event Projector is the bridge between the two worlds. It subscribes to Kafka topics for booking, inventory, and payment events, and writes the appropriate data to Elasticsearch. Let us walk through it:

```typescript
export class BookingReadModelProjector {

  // Start listening for events from Kafka
  async start(): Promise<void> {
    // Subscribe to three topics -- we care about events from
    // multiple services, not just the Booking Service.
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events', 'payment-events'],
      fromBeginning: false  // Only process new events, not historical ones
    });

    // For each incoming event, route it to the right handler
    await kafka.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'booking.created':
            await this.projectBookingCreated(event.payload);
            break;
          case 'booking.confirmed':
            await this.projectBookingConfirmed(event.payload);
            break;
          case 'booking.cancelled':
            await this.projectBookingCancelled(event.payload);
            break;
          case 'inventory.updated':
            await this.projectInventoryUpdated(event.payload);
            break;
        }
      }
    });
  }
```

This is the entry point. The projector subscribes to three Kafka topics and dispatches events based on `eventType`. Think of it as a mail room: envelopes arrive, and someone reads the label and puts each one in the right inbox.

Now let us look at the individual handlers -- the functions that actually write to Elasticsearch.

### Projecting a New Booking

```typescript
  private async projectBookingCreated(payload: any): Promise<void> {
    // Write a denormalized document to the "bookings" index in Elasticsearch.
    // "Denormalized" means we include data that would normally live in
    // separate tables -- the hotel name, the location, the dates --
    // all in one flat document. No JOINs needed at query time.
    await elasticsearch.index({
      index: 'bookings',                          // Which Elasticsearch index
      id: payload.bookingId.toString(),            // Document ID = booking ID
      body: {
        bookingId: payload.bookingId,
        userId: payload.userId,
        bookingType: payload.bookingType,          // "hotel", "flight", "car"
        status: 'pending',                         // Starts as pending
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        createdAt: payload.timestamp,

        // Denormalized fields -- in MySQL, these live in separate tables.
        // In Elasticsearch, we flatten them into the booking document
        // so a single query can filter by hotel name AND booking status.
        resourceName: payload.resourceName,        // "Hilton Tokyo"
        location: payload.location,                // { lat: 35.68, lon: 139.69 }
        dates: {
          checkIn: payload.checkIn,                // "2026-03-15"
          checkOut: payload.checkOut                // "2026-03-17"
        }
      }
    });
  }
```

In MySQL, the hotel name, location, and dates might live in three different tables -- `hotels`, `locations`, and `bookings`. To display a booking with these details, you would need a multi-table `JOIN`. At high query volume, those JOINs are expensive.

In Elasticsearch, the projector **denormalizes** the data: it takes information from multiple sources and flattens it into one document. When you query "show me all confirmed hotel bookings in Tokyo," Elasticsearch searches a single index with no JOINs. That is why it answers in milliseconds.

Yes, this means the data is duplicated. The hotel name exists in MySQL *and* in Elasticsearch. That is the explicit tradeoff of CQRS: you trade storage efficiency for read speed.

### Projecting an Inventory Update

```typescript
  private async projectInventoryUpdated(payload: any): Promise<void> {
    // Update the hotel's availability in the search index.
    // This is what makes search results reflect current availability.
    await elasticsearch.update({
      index: 'hotels',
      id: payload.resourceId.toString(),
      body: {
        doc: {
          available_rooms: payload.availableQuantity,  // e.g., 3 rooms left
          price_per_night: payload.basePrice,          // e.g., $189.00
          updated_at: new Date().toISOString()         // When this was last synced
        }
      }
    });
  }
```

When the Inventory Service decrements available rooms (because someone booked one), it publishes an `inventory.updated` event. The projector catches it and updates the hotel's document in Elasticsearch. The next user who searches for hotels will see the updated availability.

Notice this is an `update`, not an `index`. We are not replacing the entire hotel document -- just updating the fields that changed. Elasticsearch handles partial updates efficiently.

## The Query Service: Reading from the Read Model

Now let us see what the read side looks like from the API's perspective. The Query Service reads exclusively from Elasticsearch -- it never touches MySQL:

```typescript
export class BookingQueryService {

  // Return a user's bookings with filters, sorting, and pagination.
  // This reads from Elasticsearch, NOT from MySQL.
  async getUserBookings(userId: bigint, filters: BookingFilters): Promise<BookingList> {
    const { body } = await elasticsearch.search({
      index: 'bookings',
      body: {
        query: {
          bool: {
            // "must" = required conditions (like WHERE ... AND ... in SQL)
            must: [
              { term: { userId: userId.toString() } },

              // Only add status filter if the caller provided one
              ...(filters.status
                ? [{ term: { status: filters.status } }]
                : []),

              // Only add booking type filter if provided
              ...(filters.bookingType
                ? [{ term: { bookingType: filters.bookingType } }]
                : [])
            ],

            // "filter" = non-scoring filters (like date ranges)
            filter: [
              ...(filters.dateFrom ? [{
                range: { 'dates.checkIn': { gte: filters.dateFrom } }
              }] : [])
            ]
          }
        },
        sort: [{ createdAt: 'desc' }],    // Newest first
        from: filters.offset || 0,         // Pagination: skip N results
        size: filters.limit || 20          // Pagination: return N results
      }
    });

    return {
      bookings: body.hits.hits.map(hit => hit._source),  // Extract documents
      total: body.hits.total.value                        // Total count for pagination
    };
  }
}
```

If you are used to SQL, here is the mental translation:

```sql
-- This Elasticsearch query is roughly equivalent to:
SELECT *
FROM bookings
WHERE user_id = ?
  AND (status = ? OR ? IS NULL)         -- optional status filter
  AND (booking_type = ? OR ? IS NULL)   -- optional type filter
  AND (check_in >= ? OR ? IS NULL)      -- optional date filter
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

The difference is that Elasticsearch can handle this query -- with full-text search, geo-distance sorting, fuzzy matching, and aggregations -- in single-digit milliseconds, even across millions of documents. MySQL could handle the simple version, but the moment you add "sort by distance from my current location" or "find hotels whose names sound like 'Marioott,'" MySQL struggles.

> **What If You Skip This?** Without CQRS, your MySQL database must handle both heavy write traffic (bookings, payments, inventory updates) and heavy read traffic (searches, dashboards, analytics). At scale, these workloads interfere with each other. Write locks block read queries. Read-heavy aggregation queries slow down write transactions. Your database becomes a bottleneck for everything, and scaling it means scaling everything -- you cannot scale reads independently from writes.

## Eventual Consistency: The Price of Separation

Here is the elephant in the room. When the write model (MySQL) and the read model (Elasticsearch) are separate, they are not always in sync. There is a delay between when a booking is written to MySQL and when the Event Projector processes the event and updates Elasticsearch.

This delay is typically **50 to 500 milliseconds** under normal load. In extreme cases (Kafka lag, Elasticsearch indexing backlog), it could be a few seconds.

What does this mean in practice? If you create a booking and then immediately search for it, the search results *might not include it yet*. The booking exists in MySQL (the source of truth), but the Elasticsearch index has not been updated.

This is called **eventual consistency**: the read model will eventually reflect the write model, but not necessarily immediately.

> **Key Term:** **Eventual Consistency** — A consistency model where, after a write, reads are guaranteed to return the updated data *eventually*, but not necessarily *immediately*. Given enough time without new writes, all replicas converge to the same state.

### Why This Is OK

Eventual consistency sounds scary, but for most read workloads, it is completely acceptable. Ask yourself: does the user really need search results from *this exact millisecond*, or is "2 seconds ago" good enough?

Here are concrete examples from our booking system:

| Scenario | Consistency Requirement | Why Eventual Is Fine |
|----------|------------------------|---------------------|
| Hotel search results | 2-3 seconds behind | If a room was booked 1 second ago, showing it as available for 2 more seconds is acceptable -- the booking flow will recheck availability |
| User's booking history page | 1-2 seconds behind | The user just clicked "Book Now" and sees a confirmation page. The history page being a second behind is invisible |
| Admin dashboard metrics | 5-10 seconds behind | Dashboards showing total bookings today do not need millisecond precision |
| Customer support lookup | 1-2 seconds behind | The agent knows the customer just called; a 1-second delay is irrelevant |

Contrast this with scenarios where eventual consistency is *not* acceptable:

| Scenario | Consistency Requirement | Why Eventual Is NOT Fine |
|----------|------------------------|-------------------------|
| Checking room availability before booking | Must be real-time | If we use stale data, we might sell a room that was just booked |
| Processing a payment | Must be real-time | You cannot charge a card based on a stale price |
| Decrementing inventory | Must be real-time | Two concurrent decrements must both see the latest count |

Notice the pattern: **writes** (booking, paying, reserving) need strong consistency and go through MySQL. **Reads** (searching, browsing, reporting) can tolerate slight staleness and go through Elasticsearch. CQRS lets you give each side exactly the consistency model it needs.

> **Analogy:** Think about a newspaper. The events (news) happen in real time. The newspaper reports on them the next morning. Readers accept that the newspaper is "eventual" -- it is always a few hours behind reality. But nobody would *make decisions about current events* based solely on yesterday's newspaper. You would check a live source (TV, radio, the internet) for that. Similarly, our read model (Elasticsearch) is the "newspaper" -- great for browsing and discovery. Our write model (MySQL) is the "live source" -- authoritative for decisions that require the latest data.

## The Full Data Flow: From User Click to Search Result

Let us trace the entire path from a booking being created to a search result being updated:

```
1. User clicks "Book Now"
   └──> Booking API receives POST request

2. Booking API writes to MySQL (source of truth)
   └──> INSERT INTO bookings (...) VALUES (...)

3. The outbox pattern (or a Kafka producer in the Booking Service)
   publishes an event to Kafka topic "booking-events"
   └──> { eventType: "booking.created", payload: { bookingId, userId, ... } }

4. Kafka durably stores the event. It is now available for any consumer.

5. BookingReadModelProjector consumes the event
   └──> Parses the payload, transforms it into a denormalized document

6. Projector writes to Elasticsearch
   └──> elasticsearch.index({ index: 'bookings', body: { ... } })

7. Next user who searches for bookings sees the updated data
   └──> Elasticsearch returns the denormalized document in sub-200ms
```

The gap between step 2 and step 7 is the "eventual" part. Under normal conditions, it is under a second. The user who just created the booking does not typically search for it immediately -- they are looking at a confirmation page that reads directly from the API response (not from Elasticsearch).

## When to Use CQRS (and When Not To)

CQRS adds complexity. You have two data stores to maintain, an event pipeline to operate, and eventual consistency to reason about. Here is when it is worth it:

**Use CQRS when:**
- Your read and write workloads have very different performance requirements
- You need to search or filter data in ways that relational databases handle poorly (full-text, geo, faceted search)
- Your read traffic is 10x-100x higher than your write traffic
- You need to scale reads independently from writes

**Do NOT use CQRS when:**
- Your application is small enough that one database handles both workloads comfortably
- Your read patterns are simple `SELECT` queries with basic `WHERE` clauses
- Eventual consistency is genuinely unacceptable for your use case (e.g., a banking ledger)
- You do not have the operational capacity to run and monitor a second data store and an event pipeline

For our booking platform, CQRS is the right call. We have 100,000 bookings per minute (writes) and millions of search queries per minute (reads). The read patterns involve geo-search, full-text matching, and complex filtering. MySQL cannot serve those reads fast enough while also handling write-heavy transactions. Splitting the responsibilities lets each store do what it was designed for.

## Connecting Back to What You Know

In your current applications, you probably have a single read/write database. CQRS does not invalidate that approach -- it extends it for a specific set of scaling challenges. Here is the progression:

```
Level 1 (where you are now):
  One database, reads and writes share it.
  Works great up to moderate traffic.

Level 2 (read replicas):
  One primary database for writes, one or more replicas for reads.
  Same schema, same query language. Reduces load on the primary.

Level 3 (CQRS):
  Writes go to a store optimized for writes (MySQL).
  Reads come from a store optimized for reads (Elasticsearch).
  Different schemas, different query languages, event-driven sync.
  Each side scales independently.
```

You do not jump from Level 1 to Level 3 overnight. Most teams go through Level 2 first and only adopt CQRS when read replicas can no longer keep up with the query complexity or volume.

## Chapter 20 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| CQRS | Separate the write model (commands) from the read model (queries) so each can be optimized independently. |
| Write model | The authoritative data store (MySQL) optimized for consistency, transactions, and correctness. |
| Read model | A denormalized, query-optimized store (Elasticsearch) built for speed, search, and flexible filtering. |
| Event Projector | A service that consumes events from the write side and transforms them into documents for the read side. |
| Denormalization | Storing redundant data in the read model to avoid expensive JOINs at query time. |
| Eventual consistency | The read model reflects the write model after a short delay (typically under 1 second), not instantaneously. |
| When NOT to use CQRS | When your app is small, reads are simple, or eventual consistency is unacceptable. |
| Progression path | Single DB, then read replicas, then CQRS -- each step addresses a specific scaling bottleneck. |

> **Checkpoint:** Without scrolling back, answer these:
>
> 1. What are the two data stores in our CQRS setup, and what is each optimized for?
> 2. What is the Event Projector's job, in one sentence?
> 3. If a user creates a booking and immediately searches for it, will it always appear? Why or why not?
> 4. Name two scenarios where eventual consistency is acceptable and one where it is not.
>
> If you can answer all four confidently, you understand CQRS. If the eventual consistency part feels fuzzy, re-read the "Why This Is OK" section -- that is the concept most developers struggle with when encountering CQRS for the first time.
