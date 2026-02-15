# Part 4: Core Business Services

---

# Chapter 12: Booking Service — The Orchestrator

## Where You Are Right Now

You have built CRUD endpoints. You know the drill: the user sends a POST request, your controller calls a service, the service calls the repository, the repository runs an INSERT, and you send back a 201. One function, one database, one table, done.

That pattern carried you through your first year. And it works brilliantly for single-resource operations: create a user, update a profile, delete a comment.

But what happens when a single user action -- "Book this hotel room" -- must touch *four different services*, each with its own database, each capable of failing independently? You cannot wrap that in a single `BEGIN` / `COMMIT`. You cannot do it in one function call. You need something fundamentally different.

You need an **orchestrator**.

---

## What Is Orchestration?

> **Analogy:** Think of a project manager at a construction site. The project manager does not lay bricks, wire electrical panels, or install plumbing. Instead, they coordinate: "Electrician, run the wiring for floor three. Done? Good. Plumber, you're clear to install pipes on floor three now. Done? Good. Inspector, come verify floor three." If the plumber finds a cracked pipe and cannot proceed, the project manager tells the electrician to pause and the inspector to stand down. The project manager does not DO the work. They coordinate others and handle the consequences when something goes wrong.

The Booking Service is our project manager. When a user clicks "Book Now," the Booking Service does not check room availability itself. It does not charge credit cards itself. It does not send confirmation emails itself. Instead, it calls the Inventory Service, the Payment Service, and the Notification Service -- in the right order, with the right data, handling failures at every step.

> **Key Term:** **Orchestration** — A coordination pattern where one central service (the orchestrator) directs the workflow by making explicit calls to other services in sequence. The orchestrator knows the full flow and controls the order of operations. This contrasts with *choreography*, where each service reacts to events independently without a central coordinator.

### Why Not Just Do Everything in One Function?

You might be thinking: "Can't I just call all the services from one big async function? Check availability, charge the card, save the booking, send the email, done?"

You can. And for the first version, that is essentially what we do. But there is a critical difference between calling everything in one go and orchestrating with awareness of failure at each step. Let us look at why.

In a monolith, your "one big function" looked like this:

```typescript
// The monolith approach you already know
app.post('/api/bookings', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check availability - same database
    const rooms = await client.query('SELECT ... FROM rooms WHERE ...');
    if (rooms.rows.length === 0) throw new Error('No availability');

    // Charge the card - external call, but inside our transaction scope
    const payment = await chargeCard(userId, totalPrice);

    // Save booking - same database
    await client.query('INSERT INTO bookings ...');

    await client.query('COMMIT');
    res.status(201).json({ status: 'confirmed' });
  } catch (error) {
    await client.query('ROLLBACK');  // One command undoes EVERYTHING
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});
```

That `ROLLBACK` is magical. One word and the database throws away every change. No partial state. No cleanup. The database guarantees it.

In microservices, there is no shared transaction and no magic `ROLLBACK`. Each service has its own database. The Inventory Service committed its changes to its own MySQL instance. The Payment Service charged the card through Stripe. If the Booking Service crashes after those two steps succeed, there is no single command that undoes everything. You have to undo each step manually, in reverse order, by calling each service again.

That is why we need a deliberate, stepwise process. Each step must be planned, each failure must be anticipated, and each undo operation must be coded explicitly.

> **What If You Skip This?** If you treat a multi-service operation like a single function call -- just chaining `await` calls and hoping they all succeed -- you will eventually get partial failures. A customer gets charged but no booking is created. A room gets reserved but the payment fails and nobody releases the room. These are not hypothetical scenarios. They are certainties at scale.

---

## The Booking Lifecycle: A State Machine

Before we look at code, let us understand the *states* a booking can be in. This is not just a status column you casually update. It is a **state machine** -- a formal model of every valid state and every valid transition between states.

```
  +----------+     confirm     +------------+     complete     +------------+
  | PENDING  |---------------->| CONFIRMED  |----------------->| COMPLETED  |
  +----+-----+                 +------+------+                 +------------+
       |                              |
       |  payment_failed              |  cancel
       |                              |
  +----v-----+                 +------v------+     refund      +------------+
  |  FAILED  |                 |  CANCELLED  |---------------->|  REFUNDED  |
  +----------+                 +-------------+                 +------------+
```

Let us walk through every state and every arrow:

| State | Meaning | How We Got Here |
|---|---|---|
| **PENDING** | Booking created, inventory held, payment not yet processed | User clicked "Book Now" and we reserved the room |
| **CONFIRMED** | Payment succeeded, inventory permanently reserved | Payment Service charged the card successfully |
| **COMPLETED** | The guest checked in and checked out (service was delivered) | Triggered by date or by hotel confirmation |
| **FAILED** | Payment was declined or another step failed | Payment Service returned a decline |
| **CANCELLED** | The customer or system cancelled a confirmed booking | Customer requested cancellation before check-in |
| **REFUNDED** | A cancelled booking has been refunded | Payment Service processed the refund |

> **Key Term:** **State Machine** — A model that defines a finite set of states an entity can be in, plus the valid transitions between those states. A booking in the PENDING state can move to CONFIRMED or FAILED, but it cannot jump directly to REFUNDED. The state machine enforces business rules: you cannot refund a booking that was never confirmed.

Notice the arrows. A PENDING booking can become CONFIRMED or FAILED — nothing else. A CONFIRMED booking can become COMPLETED or CANCELLED — nothing else. A CANCELLED booking can become REFUNDED — nothing else. There is no arrow from COMPLETED back to PENDING. There is no arrow from FAILED to CONFIRMED. These constraints are not arbitrary. They represent real business rules.

### Why a Status Column Is Not Enough

You probably have code that does this:

```typescript
// The naive approach -- just update the column
await db.query(
  'UPDATE bookings SET status = $1 WHERE id = $2',
  ['confirmed', bookingId]
);
```

This compiles. This runs. But it does not enforce the state machine. Nothing stops you from updating a COMPLETED booking back to PENDING. Nothing stops you from setting a FAILED booking to REFUNDED (skipping CANCELLED entirely). Over time, you will have bookings in impossible states, and your support team will spend hours figuring out what happened.

In a production system, we validate transitions before applying them:

```typescript
// Valid state transitions -- the state machine as code
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:   ['confirmed', 'failed'],
  confirmed: ['completed', 'cancelled'],
  cancelled: ['refunded'],
  // failed and completed and refunded are terminal -- no transitions out
};

function canTransition(currentStatus: string, newStatus: string): boolean {
  const allowed = VALID_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}
```

Every time you update a booking's status, you check `canTransition` first. If it returns false, you reject the update and log the illegal attempt. This catches bugs early and keeps your data clean.

> **Analogy:** Think of a traffic light. It goes green, then yellow, then red, then green again. It never goes from green straight to red. If it did, drivers would crash. The state machine is your traffic light -- it enforces a safe, predictable sequence.

---

## The Booking Creation Flow: Step by Step

Now let us look at the actual orchestration code. This is the heart of the Booking Service. Read every comment carefully -- each line has a reason.

```typescript
// ============================================
// Booking Service - Core Orchestration
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // ----- Step 1: Check inventory availability -----
    // Before we do ANYTHING, ask the Inventory Service
    // if the resource (hotel room, flight seat, rental car) is free.
    // This is a synchronous HTTP call -- we NEED the answer before proceeding.
    const available = await this.inventoryService.checkAvailability({
      resourceType: dto.resourceType,  // 'hotel', 'flight', or 'car'
      resourceId: dto.resourceId,      // e.g., 'TOKYO-042'
      date: dto.date                   // check-in / check-out range
    });

    // If nothing is available, stop immediately. No hold, no payment,
    // no booking record. Just a clean error.
    if (!available) {
      throw new InsufficientInventoryError();
    }

    // ----- Step 2: Reserve inventory (create a hold) -----
    // The room IS available, but between our check (Step 1) and now,
    // someone else might grab it. So we ask Inventory to place a
    // temporary hold. This hold expires after 10 minutes (TTL).
    // If we don't complete payment in time, the hold auto-releases.
    const hold = await this.inventoryService.createHold({
      ...dto,
      ttlSeconds: 600  // 10 minutes -- enough time for payment processing
    });

    try {
      // ----- Step 3: Process payment -----
      // We have a hold on the room. Now charge the customer.
      // This calls the Payment Service, which talks to Stripe.
      const payment = await this.paymentService.processPayment({
        amount: dto.totalAmount,
        currency: dto.currency,
        paymentMethod: dto.paymentMethod
      });

      // ----- Step 4: Create the booking record -----
      // Payment succeeded. Now save the booking to OUR database
      // (the Booking Service's own MySQL instance).
      // The status starts as PENDING -- it will become CONFIRMED
      // once we finalize everything.
      const booking = await this.createBookingRecord(dto, payment.id);

      // ----- Step 5: Confirm the hold -----
      // Tell Inventory: "Convert that temporary hold into a permanent
      // reservation linked to this booking." The hold's TTL is removed.
      // The room is now definitively booked.
      await this.inventoryService.confirmHold(hold.id, booking.id);

      // ----- Step 6: Write event to outbox -----
      // Instead of publishing directly to Kafka (which could fail
      // independently of our database commit), we write the event
      // to an outbox table in the SAME database transaction.
      // A separate process reads the outbox and publishes to Kafka.
      // This is the Transactional Outbox pattern (covered in Chapter 18, Outbox Pattern).
      await this.writeOutboxEvent('booking', booking.id, 'booking.created', {
        bookingId: booking.id,
        referenceCode: booking.referenceCode,
        userId: dto.userId,
        bookingType: dto.bookingType,
        totalAmount: dto.totalAmount,
        currency: dto.currency
      });

      return booking;

    } catch (error) {
      // ----- Rollback: Release the hold -----
      // If ANYTHING in Steps 3-6 fails, we must release the
      // inventory hold. Otherwise the room stays blocked for 10
      // minutes even though nothing happened.
      await this.inventoryService.releaseHold(
        hold.id,
        error.message,       // why we're releasing
        'booking-service'    // who is releasing
      );
      throw error;  // Re-throw so the caller gets the error
    }
  }

  // The Saga Pattern (Chapter 19) makes this even more resilient
  // by adding compensating transactions for every step.
}
```

Let us break down what just happened, because this is the most important flow in the entire system.

### Step-by-Step Walkthrough

**Step 1: Check Availability.** This is a read-only check. "Is there at least one room of this type available on these dates?" We ask the Inventory Service via a synchronous HTTP call. If the answer is no, we fail fast. No resources consumed, no side effects, no cleanup needed. This is the cheapest possible failure.

**Step 2: Create a Hold.** We ask the Inventory Service to *reserve* the resource temporarily. The hold has a TTL (Time To Live) of 600 seconds -- 10 minutes. Why temporary? Because we have not charged the customer yet. If the payment fails or the user abandons the flow, we do not want that room blocked forever. The TTL is our safety net: if we never come back to confirm, the hold expires and the room becomes available again.

> **Key Term:** **Hold (Inventory Hold)** — A temporary reservation that prevents other bookings from claiming the same resource. It has a TTL and auto-expires if not confirmed. Think of it as putting a "reserved" sign on a restaurant table — if the party does not show up in 15 minutes, the sign comes down.

**Step 3: Process Payment.** With the room held, we call the Payment Service. This is the riskiest step — it involves an external provider (Stripe), network calls, fraud checks, and actual money movement. If it fails, we release the hold in the catch block. If it succeeds, we have a `payment.id` linking to the transaction record.

**Step 4: Create Booking Record.** Now we write to the Booking Service's own database. This is a familiar INSERT — you have done this a thousand times. The difference is that this record references the `payment.id` from Step 3, linking the booking to its payment.

**Step 5: Confirm Hold.** We go back to the Inventory Service and say "convert that temporary hold into a permanent reservation." The TTL is removed. The room is now booked until check-out or cancellation.

**Step 6: Write Outbox Event.** Instead of publishing directly to Kafka, we write the event to an **outbox table** in the same database transaction that created the booking. This guarantees that the event is written if and only if the booking is written. A background process (the outbox relay) reads this table and publishes to Kafka. Why? Because if we published to Kafka directly, and the Kafka call failed after the database commit, we would have a booking with no event — and downstream services (Notification, Search) would never know about it.

> **Key Term:** **Transactional Outbox** — A pattern where events destined for a message broker are first written to a table in the same database as the business data, within the same transaction. A separate process polls the outbox table and publishes the events to Kafka. This guarantees "at least once" delivery without distributed transactions.

### The Catch Block: Manual Rollback

Look at the `catch` block again:

```typescript
catch (error) {
  await this.inventoryService.releaseHold(
    hold.id,
    error.message,
    'booking-service'
  );
  throw error;
}
```

In your monolith, you wrote `ROLLBACK` and everything was undone. Here, we have to *manually* undo Step 2 (the hold) when Steps 3-6 fail. We call `releaseHold` explicitly, passing the hold ID, a reason string for the audit log, and the name of the calling service.

What if `releaseHold` itself fails? Now we have a hold that will linger until its TTL expires (10 minutes). This is not ideal, but it is not catastrophic — the TTL is our safety net. The Saga Pattern (covered in a later chapter) adds retry logic and dead-letter queues for these compensating actions.

> **What If You Skip This?** If your catch block does not release the hold, every failed payment attempt locks a room for 10 minutes. During a flash sale with thousands of booking attempts, you could lock up your entire inventory with phantom holds. Customers see "no availability" when rooms are actually available. Revenue drops. Partners lose trust.

---

## Why Stepwise? Why Not Parallel?

You might wonder: "Can't we call Inventory, Payment, and Notification in parallel with `Promise.all`? That would be faster."

The answer is no, and the reason is *dependency*. Each step depends on the result of the previous one:

1. We cannot create a hold without first checking availability (Step 1 feeds Step 2).
2. We cannot process payment without having a hold (Step 2 feeds Step 3 — we need to know *what* to charge for and that the room is actually reserved).
3. We cannot create a booking record without a successful payment ID (Step 3 feeds Step 4).
4. We cannot confirm a hold without a booking ID (Step 4 feeds Step 5).
5. We cannot write an outbox event without a booking record (Step 4 feeds Step 6).

Every step passes data to the next step. The flow is inherently sequential. Parallelizing unrelated work (like analytics logging or cache warming) is fine. Parallelizing the core booking steps is not, because the inputs of each step come from the outputs of the previous one.

> **Analogy:** You cannot frost a cake before you bake it, and you cannot bake it before you mix the batter. Some workflows are inherently sequential. Trying to parallelize them does not make them faster — it makes them wrong.

---

## The Outbox Pattern: Why Not Publish Directly to Kafka?

This deserves extra emphasis because it tripped up many teams before it became a standard pattern.

Imagine we published to Kafka directly, without the outbox:

```typescript
// DANGER: Do NOT do this
const booking = await this.createBookingRecord(dto, payment.id);

// What if Kafka is down right now?
await this.kafkaProducer.send({
  topic: 'booking.created',
  messages: [{ key: booking.id, value: JSON.stringify(eventData) }]
});
// If this line fails, the booking exists in the database
// but no event was published. Notification Service never sends
// the confirmation email. Search Service never updates availability.
// The system is now in an inconsistent state.
```

With the outbox, both the booking and the event are written in the same database transaction:

```typescript
// SAFE: Outbox pattern
await db.beginTransaction();

const booking = await this.createBookingRecord(dto, payment.id);

await this.writeOutboxEvent('booking', booking.id, 'booking.created', eventData);
// This is just an INSERT into the outbox table — same database, same transaction.

await db.commit();
// Either BOTH the booking AND the event are committed, or NEITHER is.
// A background relay process reads the outbox table and publishes to Kafka.
```

The relay process runs independently. If Kafka is down, the events sit in the outbox table until Kafka recovers. The relay retries. No data is lost.

---

## Connecting Back to What You Know

Let us map this orchestration pattern to your existing CRUD experience:

| What You Know (CRUD) | What's New (Orchestration) |
|---|---|
| One database, one INSERT | Multiple services, multiple databases |
| `BEGIN` / `COMMIT` / `ROLLBACK` | Manual rollback via compensating calls |
| Synchronous — return when done | Mix of sync (payment) and async (notification) |
| Status is just a string column | Status is a state machine with enforced transitions |
| Errors throw and you catch once | Each step has its own failure mode and cleanup logic |
| Event = "it's done" | Event written to outbox, published later by relay |

The fundamental mental shift is: **you are writing coordination code, not data-access code**. Your CRUD endpoints talked to one database. Your orchestrator talks to multiple services and must handle partial failure gracefully at every stage.

---

## Chapter 12 Summary

| Concept | One-Sentence Summary |
|---|---|
| Orchestrator pattern | One service (Booking) coordinates the flow by calling others in sequence. |
| State machine | A booking moves through PENDING, CONFIRMED, COMPLETED, CANCELLED, FAILED, and REFUNDED — with strictly defined transitions. |
| Inventory hold | A temporary reservation with a TTL that prevents double-booking and auto-releases on expiry. |
| Stepwise flow | Each step depends on the previous step's result; the flow cannot be parallelized. |
| Manual rollback | In microservices, you undo completed steps by calling compensating actions explicitly. |
| Transactional outbox | Events are written to an outbox table in the same DB transaction as the booking, then published to Kafka by a relay process. |
| TTL as safety net | If the orchestrator dies mid-flow, time-based expiry prevents resources from being locked forever. |

> **Checkpoint:** Without scrolling back, answer these three questions:
>
> 1. Why can't you use a database `ROLLBACK` across microservices?
> 2. What happens to an inventory hold if the Booking Service crashes after creating the hold but before processing payment?
> 3. Why do we write to an outbox table instead of publishing directly to Kafka?
>
> If you can answer all three from memory, you understand orchestration. If not, re-read the sections on manual rollback, TTL safety nets, and the outbox pattern.

---

---

# Chapter 13: Financial Ledger & Double-Entry Accounting

## The INSERT That Lies

Right now, your mental model of "handling money" probably looks like this:

```typescript
// What you have done before
await db.query(
  'INSERT INTO payments (amount, user_id, status) VALUES ($1, $2, $3)',
  [100.00, userId, 'completed']
);
```

One row. One table. The user paid $100. Done. Ship it.

This works for a hobby project. It will **destroy** a real business. Here is why:

**No audit trail.** Where did the $100 go? Into your company's bank account? Into a holding account waiting to be sent to the hotel? Split between your commission and the supplier? The single row does not say. If a regulator asks "show me the money trail for this transaction," you have nothing to show them.

**No balance verification.** How much money is in the system right now? You would have to SUM the `amount` column with various WHERE clauses and hope you did not miss a filter. What about refunds? Chargebacks? Partial payments? Every special case is a new query you might get wrong.

**Easy to corrupt.** Someone accidentally updates a payment row: `UPDATE payments SET amount = 50 WHERE id = 42`. Was it $100 or $50? You do not know. There is no history, no second record to cross-reference. One bad UPDATE and the truth is gone.

**No separation of concerns.** The $100 from the customer is NOT your revenue. Not yet. The customer paid you, but you owe most of that to the hotel. Your revenue is the commission. Until the guest actually checks in, that $100 is a *liability* — money you might have to refund. A single `payments` table conflates all of these concepts.

> **What If You Skip This?** If you store financial data in a single table without double-entry accounting: (1) you will fail any serious audit, (2) you cannot produce accurate financial statements, (3) you will eventually lose track of money — which in a regulated business means fines, lawsuits, or worse. Every real fintech, marketplace, and booking platform uses double-entry accounting internally. This is not optional.

---

## What Is Double-Entry Accounting?

Double-entry accounting is a 700-year-old invention. Luca Pacioli described it in 1494. Every bank, every public company, and every serious financial system uses it. The core rule is simple:

**Every financial transaction must be recorded in at least two accounts, and the total debits must equal the total credits.**

That is it. That is the entire rule. But its implications are profound.

> **Analogy:** Imagine you have a notebook with two columns: "Where did the money come from?" and "Where did the money go?" Every time money moves, you write one line in each column. If you receive $100 from a customer, the left column says "$100 from customer" and the right column says "$100 into our clearing account." The two columns always add up to the same total. If they do not, something is wrong and you know it immediately. That is double-entry accounting.

> **Key Term:** **Double-Entry Accounting** — A bookkeeping system where every transaction creates at least two entries: a debit in one account and a credit in another. The sum of all debits must always equal the sum of all credits across the entire system. If they do not balance, you have an error.

### Debits and Credits: The Part Everyone Gets Wrong

Here is where most developers get confused. "Debit" does not mean "money goes out" and "credit" does not mean "money comes in." Those are the consumer banking definitions, and they will mislead you.

In accounting:

- A **debit** is an entry on the **left side** of an account.
- A **credit** is an entry on the **right side** of an account.

What "left" and "right" *mean* depends on the type of account:

| Account Type | Debit (Left Side) | Credit (Right Side) |
|---|---|---|
| **Asset** (cash, receivables) | Increases the balance | Decreases the balance |
| **Expense** (costs, fees) | Increases the balance | Decreases the balance |
| **Liability** (money you owe) | Decreases the balance | Increases the balance |
| **Revenue** (money you earned) | Decreases the balance | Increases the balance |
| **Equity** (owner's stake) | Decreases the balance | Increases the balance |

> **Analogy:** Think of a bank analogy. When you deposit $100 into your bank account, from the bank's perspective, that is a *liability* — the bank owes you $100. The bank credits your account (liability increases). At the same time, the bank debits its cash account (asset increases — they have the cash). Both sides record the event. Both sides balance. If you withdraw $50, the bank debits your account (liability decreases) and credits its cash (asset decreases). Two entries, always balanced.

Here is the mnemonic: **assets and expenses are "debit-normal"** (their normal balance is a debit), while **liabilities, revenue, and equity are "credit-normal"** (their normal balance is a credit). When you increase a debit-normal account, you debit it. When you increase a credit-normal account, you credit it.

If this feels backwards, that is normal. It took accountants centuries to standardize this. Spend a few minutes with the table above until it clicks. Every code example in this chapter assumes you understand the table.

---

## The Chart of Accounts: Your Financial Map

Before you can record any transaction, you need a **chart of accounts** — a master list of every "bucket" money can flow into or out of. Think of it as an enum of financial categories, but stored in a database table so it can evolve over time.

```sql
-- The master list of all financial accounts in our system
CREATE TABLE chart_of_accounts (
    account_code VARCHAR(50) PRIMARY KEY,   -- e.g., '1210' for Stripe Clearing
    account_name VARCHAR(255) NOT NULL,     -- human-readable name
    account_type ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    parent_account VARCHAR(50),             -- for hierarchical grouping
    is_active BOOLEAN DEFAULT TRUE,         -- soft-delete: deactivate, never remove
    is_system_account BOOLEAN DEFAULT FALSE,-- TRUE = auto-created, don't let users delete
    currency CHAR(3) DEFAULT 'USD',         -- default currency for this account
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_account) REFERENCES chart_of_accounts(account_code),
    INDEX idx_type (account_type),
    INDEX idx_parent (parent_account)
);
```

The `account_code` uses a numeric convention:
- **1000-1999**: Assets (things we have or are owed)
- **2000-2999**: Liabilities (things we owe to others)
- **3000-3999**: Equity (owner's stake)
- **4000-4999**: Revenue (money we earned)
- **5000-5999**: Expenses (money we spent)

Here is the full chart of accounts for our booking platform:

```sql
INSERT INTO chart_of_accounts
  (account_code, account_name, account_type, is_system_account) VALUES
-- =========================================
-- Assets (1000-1999): Things we HAVE or are OWED
-- =========================================
('1000', 'Cash and Cash Equivalents',     'asset', TRUE),
('1100', 'Accounts Receivable',           'asset', TRUE),
('1110', 'Customer Receivables',          'asset', TRUE),
('1200', 'Payment Gateway Clearing',      'asset', TRUE),   -- money "in transit" at Stripe/PayPal
('1210', 'Stripe Clearing',              'asset', TRUE),   -- specifically money at Stripe
('1220', 'PayPal Clearing',              'asset', TRUE),   -- specifically money at PayPal
('1300', 'Prepaid Expenses',              'asset', TRUE),

-- =========================================
-- Liabilities (2000-2999): Things we OWE
-- =========================================
('2000', 'Accounts Payable',              'liability', TRUE),
('2100', 'Customer Deposits',             'liability', TRUE),  -- money customers gave us that we might refund
('2110', 'Unearned Revenue',              'liability', TRUE),  -- revenue we haven't earned yet
('2200', 'Supplier Payables',             'liability', TRUE),  -- money we owe hotels/airlines
('2210', 'Hotel Suppliers Payable',       'liability', TRUE),
('2220', 'Flight Suppliers Payable',      'liability', TRUE),
('2230', 'Car Rental Suppliers Payable',  'liability', TRUE),
('2300', 'Refunds Payable',               'liability', TRUE),

-- =========================================
-- Equity (3000-3999): Owner's stake
-- =========================================
('3000', 'Shareholders Equity',           'equity', TRUE),
('3100', 'Retained Earnings',             'equity', TRUE),

-- =========================================
-- Revenue (4000-4999): Money we EARNED
-- =========================================
('4000', 'Operating Revenue',             'revenue', TRUE),
('4100', 'Booking Revenue',               'revenue', TRUE),
('4110', 'Hotel Booking Revenue',         'revenue', TRUE),
('4120', 'Flight Booking Revenue',        'revenue', TRUE),
('4130', 'Car Rental Revenue',            'revenue', TRUE),
('4200', 'Service Fees',                  'revenue', TRUE),
('4210', 'Booking Fees',                  'revenue', TRUE),
('4220', 'Cancellation Fees',             'revenue', TRUE),

-- =========================================
-- Expenses (5000-5999): Money we SPENT
-- =========================================
('5000', 'Operating Expenses',            'expense', TRUE),
('5100', 'Cost of Sales',                 'expense', TRUE),
('5110', 'Hotel Costs',                   'expense', TRUE),  -- what we pay the hotel
('5120', 'Flight Costs',                  'expense', TRUE),  -- what we pay the airline
('5130', 'Car Rental Costs',              'expense', TRUE),
('5200', 'Payment Processing Fees',       'expense', TRUE),
('5210', 'Credit Card Fees',              'expense', TRUE),
('5220', 'PayPal Fees',                   'expense', TRUE),
('5300', 'Refunds and Chargebacks',       'expense', TRUE);
```

Notice the hierarchy. Account `1200` (Payment Gateway Clearing) is the parent of `1210` (Stripe Clearing) and `1220` (PayPal Clearing). This lets you see totals at different levels: "How much money is sitting at all payment gateways?" or "How much specifically at Stripe?"

> **Key Term:** **Chart of Accounts** — The complete, organized listing of every account used in an organization's accounting system. Think of it as the schema for your financial data. Just as your database has tables, your ledger has accounts.

> **Key Term:** **Clearing Account** — A temporary holding account for money that is "in transit." When a customer pays via Stripe, the money does not appear in your bank account instantly. It sits in Stripe's system for a day or two. The clearing account tracks this in-transit money.

---

## The Accounting Entries Tables: Where Transactions Live

Now we need two tables to actually record transactions: a **header** table for the entry itself, and a **lines** table for the individual debits and credits.

### The Entry Header

```sql
CREATE TABLE accounting_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_number VARCHAR(50) NOT NULL UNIQUE,     -- human-readable: 'PAY-20260315-000042'
    entry_date DATE NOT NULL,                      -- the business date of the entry
    entry_type ENUM('journal', 'payment', 'refund', 'adjustment') NOT NULL,
    booking_id BIGINT,                             -- links to the booking that caused this
    transaction_id BIGINT,                         -- links to the payment transaction
    user_id BIGINT,                                -- the customer involved
    description TEXT,                              -- human-readable explanation
    is_posted BOOLEAN DEFAULT FALSE,               -- FALSE = draft, TRUE = finalized
    posted_at TIMESTAMP NULL,                      -- when it was finalized
    posted_by BIGINT,                              -- who finalized it
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT,

    -- This constraint says: if is_posted is TRUE, posted_at must NOT be null.
    -- You cannot claim an entry is posted without recording WHEN it was posted.
    CONSTRAINT chk_posted_immutable CHECK (
        is_posted = FALSE OR
        (is_posted = TRUE AND posted_at IS NOT NULL)
    ),

    INDEX idx_booking (booking_id),
    INDEX idx_date (entry_date),
    INDEX idx_posted (is_posted, posted_at)
);
```

The `is_posted` flag is critical. When an entry is first created, it is a **draft** (`is_posted = FALSE`). You can still add or modify lines. Once you post it (`is_posted = TRUE`), it becomes **immutable** — it can never be changed again. If you made a mistake, you create a new *reversing* entry. This is how real accounting systems work: you never erase history.

### The Entry Lines

```sql
CREATE TABLE accounting_entry_lines (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT NOT NULL,                      -- which entry this line belongs to
    line_number SMALLINT NOT NULL,                  -- order within the entry (1, 2, 3...)
    account_code VARCHAR(50) NOT NULL,             -- which account (from chart_of_accounts)
    debit_amount DECIMAL(12,2) NOT NULL DEFAULT 0, -- left side
    credit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,-- right side
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(12,6) DEFAULT 1.000000,  -- for multi-currency bookings
    description TEXT,
    reference_type VARCHAR(50),                     -- 'transaction', 'booking', etc.
    reference_id BIGINT,                            -- the specific transaction or booking ID
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (entry_id) REFERENCES accounting_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (account_code) REFERENCES chart_of_accounts(account_code),

    -- THE GOLDEN RULE: Every line is EITHER a debit OR a credit, never both.
    -- One of the amounts must be > 0, the other must be exactly 0.
    CONSTRAINT chk_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (debit_amount = 0 AND credit_amount > 0)
    ),

    INDEX idx_entry_line (entry_id, line_number),
    INDEX idx_account (account_code)
);
```

Study the `chk_debit_or_credit` constraint. It enforces that every line is *either* a debit *or* a credit -- never both, never neither. This is the database enforcing accounting rules. You could also enforce this in application code, but putting it in the database means no bug, no API exploit, and no manual SQL can violate it.

Also notice `ON DELETE RESTRICT` on the foreign key. You cannot delete an entry that has lines. And as we will see shortly, you cannot delete a *posted* entry at all. Immutability is enforced at every level.

> **Analogy:** Think of the header (accounting_entries) as a folder, and the lines (accounting_entry_lines) as papers inside that folder. Each folder is labeled with a date, type, and description. Inside the folder are exactly the papers (debits and credits) that document what happened. Once you stamp the folder as "POSTED," you lock it in a filing cabinet and nobody takes it out again. If you made a mistake, you create a new folder labeled "Reversal of Folder #42."

---

## The Balanced Entry Trigger: The Database Enforces Accounting

Here is where it gets interesting. We have a CHECK constraint that forces every line to be a debit or a credit. But who checks that the total debits equal the total credits? A MySQL trigger.

```sql
DELIMITER //

CREATE TRIGGER validate_balanced_entry_before_post
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    -- IMPORTANT: In MySQL, ALL DECLARE statements must appear at the
    -- very top of a BEGIN block, before any IF or other statements.
    -- This is a MySQL-specific rule that causes cryptic syntax errors
    -- if you get it wrong.
    DECLARE v_total_debit DECIMAL(12,2);
    DECLARE v_total_credit DECIMAL(12,2);

    -- Only validate when we are POSTING an entry (changing is_posted
    -- from FALSE to TRUE). We do not care about other updates.
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN

        -- Sum up all debits and credits for this entry's lines
        SELECT SUM(debit_amount), SUM(credit_amount)
        INTO v_total_debit, v_total_credit
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;

        -- THE FUNDAMENTAL ACCOUNTING EQUATION: Debits = Credits
        -- We allow a tiny rounding tolerance of $0.01 for floating-point
        -- edge cases in multi-currency conversions.
        IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = CONCAT(
                'Accounting entry is not balanced. ',
                'Debits: ', v_total_debit, ', ',
                'Credits: ', v_total_credit
            );
        END IF;

        -- Every entry needs at least 2 lines: one debit and one credit.
        -- An entry with only one line cannot be balanced (unless the
        -- amounts are zero, which our CHECK constraint prevents).
        IF (SELECT COUNT(*) FROM accounting_entry_lines
            WHERE entry_id = NEW.id) < 2 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Accounting entry must have at least 2 lines (debit and credit)';
        END IF;

        -- Auto-set the posted timestamp. The application does not
        -- need to provide this — the trigger handles it.
        SET NEW.posted_at = NOW();
    END IF;
END//

DELIMITER ;
```

Let us go through this line by line.

**`DELIMITER //`** — By default, MySQL uses `;` to separate statements. But our trigger body contains multiple `;`-terminated statements. We temporarily change the delimiter to `//` so MySQL knows where the trigger definition ends.

**`BEFORE UPDATE ON accounting_entries FOR EACH ROW`** — This trigger fires before every UPDATE on the `accounting_entries` table, for each row being updated. The `NEW` variable holds the incoming values; the `OLD` variable holds the existing values.

**`DECLARE v_total_debit DECIMAL(12,2)`** — We declare two variables to hold the summed debits and credits.

> **Common Mistake: DECLARE Position in MySQL Triggers**
> In MySQL stored programs, all `DECLARE` statements **must** appear at the very top of the `BEGIN` block, before any `IF`, `SELECT`, or other statements. If you write `IF ... THEN DECLARE ...`, MySQL throws a syntax error that looks like `You have an error in your SQL syntax near 'DECLARE'`. This is a MySQL-specific rule. PostgreSQL does not have this restriction. If you are coming from PostgreSQL, this will trip you up. The trigger above correctly places both `DECLARE` statements before the `IF` check.

**`IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE`** — We only validate when transitioning from draft to posted. If someone updates the `description` of a draft entry, we do not need to check balance.

**`SELECT SUM(...) INTO v_total_debit, v_total_credit`** — We sum all debit amounts and all credit amounts from all lines linked to this entry.

**`IF ABS(v_total_debit - v_total_credit) > 0.01`** — If the difference is more than one cent, the entry is unbalanced. We use `ABS()` because it could be off in either direction. The 0.01 tolerance handles floating-point edge cases from multi-currency exchange rate conversions.

**`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = ...`** — This is MySQL's way of throwing an error from inside a trigger. It aborts the UPDATE. The entry remains unposted. The application code receives this error and can show a meaningful message.

**`SET NEW.posted_at = NOW()`** — When the entry passes validation, we automatically stamp it with the current timestamp. The application does not need to set this manually -- the trigger handles it.

---

## Immutability Triggers: Locking the Books

Once an entry is posted, it must never be modified or deleted. This is not a suggestion. It is a legal and regulatory requirement for any financial system. If you could edit posted entries, an auditor would never be able to trust your records.

We enforce this with two more triggers:

```sql
DELIMITER //

-- Trigger 1: Prevent modification of posted entries
CREATE TRIGGER prevent_posted_entry_modification
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    -- If the entry is ALREADY posted (OLD.is_posted = TRUE)
    -- and we are not in the process of posting it for the first time,
    -- reject the update.
    IF OLD.is_posted = TRUE AND NEW.id = OLD.id THEN
        IF OLD.is_posted = TRUE AND NEW.is_posted = TRUE THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot modify a posted accounting entry. Create a reversing entry instead.';
        END IF;
    END IF;
END//

-- Trigger 2: Prevent deletion of posted entries
CREATE TRIGGER prevent_posted_entry_deletion
BEFORE DELETE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete a posted accounting entry. Create a reversing entry instead.';
    END IF;
END//

DELIMITER ;
```

**Trigger 1: prevent_posted_entry_modification** — Check the two nested `IF` conditions carefully. The outer condition `OLD.is_posted = TRUE AND NEW.id = OLD.id` ensures we are looking at an already-posted entry that is being updated (not a different row). The inner condition `OLD.is_posted = TRUE AND NEW.is_posted = TRUE` catches attempts to modify a posted entry while keeping it posted. The gap between these conditions allows the *initial* posting transition (`OLD.is_posted = FALSE` transitioning to `NEW.is_posted = TRUE`), which is handled by the balance validation trigger above.

**Trigger 2: prevent_posted_entry_deletion** — Simpler: if the row is posted, you cannot delete it. Period. The error message provides guidance: "Create a reversing entry instead." Reversing entries are the proper accounting mechanism for corrections — they create a new entry that exactly negates the original, leaving both entries in the ledger as a permanent record.

> **What If You Skip This?** Without immutability at the database level, any application bug or malicious query can alter financial history. "But my application code checks permissions before allowing edits." Good. But what about the developer who runs a manual SQL query during an incident? What about the ORM bug that issues an unexpected UPDATE? Database-level triggers are your last line of defense. When an auditor asks "can anyone in your organization alter a posted financial record?" your answer needs to be "no, the database literally prevents it."

---

## The Entry Number Generator: Deterministic, Atomic, Human-Readable

Every accounting entry needs a unique, human-readable number. Not a UUID — humans need to read these in reports, invoices, and support tickets. The format is:

```
{type prefix}-{YYYYMMDD}-{sequence}

Examples:
  PAY-20260315-000001   (first payment entry on March 15, 2026)
  PAY-20260315-000002   (second payment entry on March 15, 2026)
  JNL-20260315-000001   (first journal entry on March 15, 2026)
  JNL-20260316-000001   (first journal entry on March 16 -- sequence resets daily)
```

The sequence resets every day and increments atomically. Here is the supporting table:

```sql
-- This table tracks the next available sequence number for each
-- entry type + date combination.
CREATE TABLE entry_number_sequences (
    entry_type VARCHAR(20) NOT NULL,
    entry_date DATE NOT NULL,
    next_sequence INT NOT NULL DEFAULT 1,
    PRIMARY KEY (entry_type, entry_date)   -- composite key: one row per type per day
);
```

And here is the TypeScript method that generates entry numbers:

```typescript
private async generateEntryNumber(entryType: string): Promise<string> {
  // Determine the prefix based on entry type
  // 'payment' entries get 'PAY', everything else gets 'JNL' (journal)
  const prefix = entryType === 'payment' ? 'PAY' : 'JNL';

  // Format today's date as YYYYMMDD (no dashes)
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // new Date().toISOString() → '2026-03-15T10:30:00.000Z'
  // .slice(0, 10)           → '2026-03-15'
  // .replace(/-/g, '')      → '20260315'

  // ATOMIC INCREMENT using INSERT ... ON DUPLICATE KEY UPDATE
  // If the row (entryType, CURDATE()) does not exist, INSERT it with next_sequence = 2
  //   (because we are about to use sequence 1).
  // If the row DOES exist, increment next_sequence by 1.
  // This is a single atomic SQL statement — no race conditions.
  await db.execute(`
    INSERT INTO entry_number_sequences (entry_type, entry_date, next_sequence)
    VALUES (?, CURDATE(), 2)
    ON DUPLICATE KEY UPDATE next_sequence = next_sequence + 1
  `, [entryType]);

  // Now retrieve the sequence that was assigned to US.
  // We read next_sequence - 1 because the UPDATE already incremented it
  // for the NEXT caller.
  const [rows] = await db.execute(`
    SELECT next_sequence - 1 AS seq
    FROM entry_number_sequences
    WHERE entry_type = ? AND entry_date = CURDATE()
  `, [entryType]);

  // Pad the sequence to 6 digits: 1 → '000001', 42 → '000042'
  const seq = String(rows[0].seq).padStart(6, '0');

  // Assemble: 'PAY' + '-' + '20260315' + '-' + '000001'
  return `${prefix}-${today}-${seq}`;
}
```

**Why `INSERT ... ON DUPLICATE KEY UPDATE`?** This MySQL idiom is an "upsert" — insert if the row does not exist, update if it does. It is a single atomic operation. Two requests hitting the database at the exact same millisecond will get different sequence numbers because MySQL serializes the writes internally. No application-level locking needed.

**Why `next_sequence - 1`?** Because the INSERT statement sets `next_sequence = 2` (for the first entry) or increments it (for subsequent entries). After the INSERT/UPDATE executes, `next_sequence` holds the value for the *next* caller. We want the value for the *current* caller, which is `next_sequence - 1`.

**Why does the sequence reset daily?** Practical reasons: it keeps the numbers short, and it provides a natural grouping for daily reconciliation. If you need to review all entries from March 15, look for numbers starting with `*-20260315-*`.

---

## Recording a Customer Payment: The Full Journal Entry

Now let us see how a real financial transaction is recorded. When a customer pays $340 for a hotel booking via Stripe, the Accounting Service creates a journal entry with two lines:

1. **Debit** the Stripe Clearing account (asset increases — we have $340 at Stripe)
2. **Credit** the Customer Deposits account (liability increases — we owe the $340 back if the customer cancels)

Notice: this is NOT revenue yet. The customer paid, but the service has not been delivered. The $340 is a *deposit* — a liability. Revenue is recognized later, when the guest checks in.

```typescript
export class AccountingService {

  async recordCustomerPayment(params: {
    bookingId: bigint;
    transactionId: bigint;
    amount: number;
    currency: string;
    paymentProvider: string;
  }): Promise<void> {

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Generate a unique, human-readable entry number
      const entryNumber = await this.generateEntryNumber('payment');

      // Create the entry header
      const [paymentResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, transaction_id, description, created_by
        ) VALUES (?, CURDATE(), 'payment', ?, ?, ?, ?)
      `, [entryNumber, params.bookingId, params.transactionId,
          `Customer payment received for booking ${params.bookingId}`, null]);

      const entryId = paymentResult.insertId;

      // ----- LINE 1: Debit the Payment Gateway Clearing account -----
      // An asset account. Debit = increase.
      // "We now have $340 sitting at Stripe."
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 1, ?, ?, 0, ?, ?, 'transaction', ?)
      `, [entryId,
          this.getPaymentGatewayAccount(params.paymentProvider),  // '1210' for Stripe
          params.amount,           // 340.00 in the debit column
          params.currency,         // 'USD'
          `Payment received via ${params.paymentProvider}`,
          params.transactionId]);

      // ----- LINE 2: Credit the Customer Deposits account -----
      // A liability account. Credit = increase.
      // "We owe this $340 back to the customer if they cancel."
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 2, '2100', 0, ?, ?, ?, 'booking', ?)
      `, [entryId,
          params.amount,           // 340.00 in the credit column
          params.currency,
          'Customer deposit for booking',
          params.bookingId]);

      // ----- POST the entry -----
      // This UPDATE triggers our validate_balanced_entry_before_post trigger.
      // The trigger sums Line 1 (debit 340) and Line 2 (credit 340),
      // confirms they are equal, and allows the post.
      // If they were NOT equal, the trigger would SIGNAL an error
      // and the entire transaction would roll back.
      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [entryId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
```

Here is what the resulting data looks like in the database:

**accounting_entries:**

| id | entry_number | entry_date | entry_type | booking_id | is_posted |
|---|---|---|---|---|---|
| 1 | PAY-20260315-000001 | 2026-03-15 | payment | 55012 | TRUE |

**accounting_entry_lines:**

| entry_id | line | account_code | debit | credit | description |
|---|---|---|---|---|---|
| 1 | 1 | 1210 (Stripe Clearing) | 340.00 | 0.00 | Payment received via stripe |
| 1 | 2 | 2100 (Customer Deposits) | 0.00 | 340.00 | Customer deposit for booking |

Total debits: 340.00. Total credits: 340.00. Balanced. The trigger approved it.

---

## Revenue Recognition: When the Deposit Becomes Revenue

The customer paid $340, but that is not our revenue yet. Why? Because the guest has not checked in. If they cancel tomorrow, we refund them. Revenue is recognized when the service is delivered -- typically at check-in or check-out, depending on your accounting policy.

> **Key Term:** **Revenue Recognition** — The accounting principle that determines when income is recorded as "earned." In our booking system, a customer payment is initially recorded as a liability (Customer Deposits), not as revenue. It becomes revenue only when the service is delivered (the guest checks in). This timing distinction matters for accurate financial reporting and regulatory compliance -- recognizing revenue before the service is delivered overstates your income and can violate accounting standards.

When we recognize revenue, two things happen as **separate journal entries**:

**Entry 1: Revenue Recognition** — Transfer money from the Customer Deposits (liability) to Booking Revenue (revenue). The liability decreases and revenue increases.

**Entry 2: Cost Accrual** — Record what we owe the hotel (supplier). The Cost of Sales (expense) increases and the Supplier Payable (liability) increases.

> **Common Mistake: Mixing Revenue and Cost in One Journal Entry**
> An earlier version of this system combined revenue recognition and cost accrual into a single 4-line journal entry. While technically balanced (debits = credits), this violated the accounting principle of separating distinct economic events. Revenue recognition (customer deposit becoming revenue) and cost accrual (recording what we owe the supplier) are *independent* events that may occur at different times. They must be auditable separately. If a regulator asks "when was revenue recognized for booking 55012?" they want one entry with a clear timestamp, not a combined entry where they have to mentally untangle which lines are revenue and which are cost.

```typescript
async recognizeBookingRevenue(params: {
  bookingId: bigint;
  bookingType: string;   // 'hotel', 'flight', or 'car'
  amount: number;        // total customer paid (e.g., 340.00)
  supplierCost: number;  // what we owe the hotel (e.g., 290.00)
}): Promise<void> {

  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    // ==========================================
    // JOURNAL ENTRY 1: Revenue Recognition
    // "The customer's deposit is now our revenue."
    // ==========================================
    const revenueEntryNumber = await this.generateEntryNumber('journal');

    const [revenueResult] = await connection.execute(`
      INSERT INTO accounting_entries (
        entry_number, entry_date, entry_type,
        booking_id, description
      ) VALUES (?, CURDATE(), 'journal', ?, ?)
    `, [revenueEntryNumber, params.bookingId,
        `Revenue recognition for ${params.bookingType} booking`]);

    const revenueEntryId = revenueResult.insertId;

    // Line 1: Debit Customer Deposits (liability DECREASES)
    // "We no longer owe this money back to the customer."
    await connection.execute(`
      INSERT INTO accounting_entry_lines (
        entry_id, line_number, account_code,
        debit_amount, credit_amount, description
      ) VALUES (?, 1, '2100', ?, 0, 'Transfer from customer deposit')
    `, [revenueEntryId, params.amount]);

    // Line 2: Credit Booking Revenue (revenue INCREASES)
    // "We earned this money."
    const revenueAccount = this.getRevenueAccount(params.bookingType);
    // hotel → '4110', flight → '4120', car → '4130'
    await connection.execute(`
      INSERT INTO accounting_entry_lines (
        entry_id, line_number, account_code,
        debit_amount, credit_amount, description
      ) VALUES (?, 2, ?, 0, ?, 'Booking revenue recognized')
    `, [revenueEntryId, revenueAccount, params.amount]);

    // Post Entry 1 — triggers balance validation
    await connection.execute(
      'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
      [revenueEntryId]
    );

    // ==========================================
    // JOURNAL ENTRY 2: Cost Accrual
    // "We now owe the hotel $290 for providing the room."
    // ==========================================
    const costEntryNumber = await this.generateEntryNumber('journal');

    const [costResult] = await connection.execute(`
      INSERT INTO accounting_entries (
        entry_number, entry_date, entry_type,
        booking_id, description
      ) VALUES (?, CURDATE(), 'journal', ?, ?)
    `, [costEntryNumber, params.bookingId,
        `Cost accrual for ${params.bookingType} booking`]);

    const costEntryId = costResult.insertId;

    // Line 1: Debit Cost of Sales (expense INCREASES)
    // "This is what providing the room cost us."
    const costAccount = this.getCostAccount(params.bookingType);
    // hotel → '5110', flight → '5120', car → '5130'
    await connection.execute(`
      INSERT INTO accounting_entry_lines (
        entry_id, line_number, account_code,
        debit_amount, credit_amount, description
      ) VALUES (?, 1, ?, ?, 0, 'Supplier cost for booking')
    `, [costEntryId, costAccount, params.supplierCost]);

    // Line 2: Credit Supplier Payables (liability INCREASES)
    // "We owe this amount to the hotel."
    const payableAccount = this.getSupplierPayableAccount(params.bookingType);
    // hotel → '2210', flight → '2220', car → '2230'
    await connection.execute(`
      INSERT INTO accounting_entry_lines (
        entry_id, line_number, account_code,
        debit_amount, credit_amount, description
      ) VALUES (?, 2, ?, 0, ?, 'Amount owed to supplier')
    `, [costEntryId, payableAccount, params.supplierCost]);

    // Post Entry 2 — triggers balance validation
    await connection.execute(
      'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
      [costEntryId]
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
```

After revenue recognition for the $340 hotel booking (where the hotel's cost is $290), our database has:

**Journal Entry 1: Revenue Recognition**

| entry_id | line | account_code | debit | credit | description |
|---|---|---|---|---|---|
| 2 | 1 | 2100 (Customer Deposits) | 340.00 | 0.00 | Transfer from customer deposit |
| 2 | 2 | 4110 (Hotel Booking Revenue) | 0.00 | 340.00 | Booking revenue recognized |

**Journal Entry 2: Cost Accrual**

| entry_id | line | account_code | debit | credit | description |
|---|---|---|---|---|---|
| 3 | 1 | 5110 (Hotel Costs) | 290.00 | 0.00 | Supplier cost for booking |
| 3 | 2 | 2210 (Hotel Suppliers Payable) | 0.00 | 290.00 | Amount owed to supplier |

Our gross profit on this booking: $340 (revenue) - $290 (cost) = **$50 commission**. And every cent is traceable through the ledger.

---

## Getting an Account Balance

Now that we have entries and lines, how do we answer "how much money is in the Stripe Clearing account as of March 15?"

```typescript
async getAccountBalance(accountCode: string, asOfDate?: Date): Promise<number> {
  const queryParams: any[] = [accountCode];
  let dateFilter = '';

  // If the caller wants a balance "as of" a specific date,
  // we add a date filter. Otherwise, we get the current balance.
  if (asOfDate) {
    dateFilter = 'AND ae.entry_date <= ?';
    queryParams.push(asOfDate);
  }

  const [rows] = await db.execute(`
    SELECT
      SUM(ael.debit_amount) as total_debits,
      SUM(ael.credit_amount) as total_credits
    FROM accounting_entry_lines ael
    INNER JOIN accounting_entries ae ON ael.entry_id = ae.id
    WHERE ael.account_code = ?
    AND ae.is_posted = TRUE
    ${dateFilter}
  `, queryParams);

  const totalDebits = rows[0]?.total_debits || 0;
  const totalCredits = rows[0]?.total_credits || 0;

  // Look up the account type to determine how to calculate the balance
  const [accountInfo] = await db.execute(
    'SELECT account_type FROM chart_of_accounts WHERE account_code = ?',
    [accountCode]
  );

  const accountType = accountInfo[0]?.account_type;

  // Assets & Expenses have "debit-normal" balances: balance = debits - credits
  // Liabilities, Revenue & Equity have "credit-normal" balances: balance = credits - debits
  if (accountType === 'asset' || accountType === 'expense') {
    return totalDebits - totalCredits;
  }
  return totalCredits - totalDebits;
}
```

This is the power of the debit-normal / credit-normal distinction we covered earlier. The `getAccountBalance` method does not need hardcoded logic for each account. It just looks up the account type and applies the right formula.

For example:
- Stripe Clearing (account 1210, type: asset): balance = debits - credits = $340 - $0 = **$340**
- Customer Deposits (account 2100, type: liability): balance = credits - debits = $340 - $340 = **$0** (after revenue recognition)
- Hotel Booking Revenue (account 4110, type: revenue): balance = credits - debits = $340 - $0 = **$340**

> **Common Mistake: SQL Injection in Date Filtering**
> An earlier version of `getAccountBalance` interpolated the date directly into the SQL string: `` `AND ae.entry_date <= '${format(asOfDate, ...)}'` ``. This is a SQL injection vulnerability. **Always** use parameterized queries (`?` placeholders) for all dynamic values, even for dates. The version above builds the `queryParams` array and lets the database driver handle escaping. This is not paranoia -- it is basic security hygiene.

---

## Account Mapping Helpers

The Accounting Service uses four mapping functions to translate human-readable names into account codes:

```typescript
// Which clearing account to use based on payment provider
private getPaymentGatewayAccount(provider: string): string {
  const mapping: Record<string, string> = {
    stripe: '1210',   // Stripe Clearing
    paypal: '1220',   // PayPal Clearing
  };
  return mapping[provider.toLowerCase()] || '1200';  // fallback to generic clearing
}

// Which revenue account to use based on booking type
private getRevenueAccount(bookingType: string): string {
  const mapping: Record<string, string> = {
    hotel:  '4110',   // Hotel Booking Revenue
    flight: '4120',   // Flight Booking Revenue
    car:    '4130',   // Car Rental Revenue
  };
  return mapping[bookingType.toLowerCase()] || '4100';  // fallback to generic revenue
}

// Which cost account to use based on booking type
private getCostAccount(bookingType: string): string {
  const mapping: Record<string, string> = {
    hotel:  '5110',   // Hotel Costs
    flight: '5120',   // Flight Costs
    car:    '5130',   // Car Rental Costs
  };
  return mapping[bookingType.toLowerCase()] || '5100';  // fallback to generic cost
}

// Which supplier payable account to use based on booking type
private getSupplierPayableAccount(bookingType: string): string {
  const mapping: Record<string, string> = {
    hotel:  '2210',   // Hotel Suppliers Payable
    flight: '2220',   // Flight Suppliers Payable
    car:    '2230',   // Car Rental Suppliers Payable
  };
  return mapping[bookingType.toLowerCase()] || '2200';  // fallback to generic payable
}
```

Notice the fallback values (e.g., `|| '1200'`). If someone passes a payment provider you have not mapped yet (say, `'square'`), the system does not crash — it posts to the generic parent account. This is a defensive coding pattern that keeps the books balanced even when the mapping is incomplete, while flagging the need to add a new specific account.

---

## The Payment Processing Flow

The Payment Service sits between the Booking Service and external payment providers (Stripe, PayPal). It handles the full lifecycle of a payment: fraud check, authorization, capture, and ledger recording.

```typescript
export class PaymentService {

  async processPayment(params: PaymentParams): Promise<PaymentResult> {

    // ----- Step 1: Fraud Check -----
    // Before we touch any money, run the transaction through
    // the fraud detection system. This checks patterns like:
    // too many transactions in a short window, mismatched
    // IP address and billing country, known fraudulent devices.
    const fraudCheck = await this.fraudService.checkTransaction({
      userId: params.userId,
      amount: params.amount,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    if (fraudCheck.status === 'blocked') {
      throw new FraudBlockedError('Transaction blocked by fraud detection');
    }

    // ----- Step 2: Authorization (HOLD funds, don't charge yet) -----
    // Authorization asks the customer's bank: "Does this card have $340?"
    // If yes, the bank HOLDS $340 — the customer can't spend it elsewhere.
    // But we haven't actually charged it yet. This is a two-step payment
    // pattern used by hotels, rental cars, and any business that needs
    // to adjust the final amount before charging.
    const authorization = await this.authorizePayment(params);

    if (!authorization.success) {
      throw new PaymentDeclinedError(authorization.reason);
    }

    // ----- Step 3: Record authorization in payment ledger -----
    await this.ledgerService.recordAuthorization(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency, params.provider,
      authorization.providerTxnId
    );

    // ----- Step 4: Capture (actually charge the card) -----
    // Now we convert the hold into an actual charge. The bank
    // transfers the money to our Stripe account.
    const capture = await this.capturePayment(
      authorization.providerTxnId,
      params.amount
    );

    if (!capture.success) {
      // Capture failed — void the authorization so the
      // customer's funds are released back to their card.
      await this.voidAuthorization(authorization.providerTxnId);
      throw new PaymentCaptureError(capture.reason);
    }

    // ----- Step 5: Record capture in payment ledger -----
    await this.ledgerService.recordCapture(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency
    );

    // ----- Step 6: Record in double-entry accounting -----
    // This calls the AccountingService.recordCustomerPayment method
    // we walked through earlier — creating the balanced journal entry.
    await this.accountingService.recordCustomerPayment({
      bookingId: params.bookingId,
      transactionId: authorization.transactionId,
      amount: params.amount,
      currency: params.currency,
      paymentProvider: params.provider
    });

    return {
      success: true,
      transactionId: authorization.transactionId,
      providerTxnId: authorization.providerTxnId
    };
  }
}
```

> **Key Term:** **Authorization vs. Capture** — A two-step payment process. *Authorization* confirms the customer has funds and places a hold. *Capture* actually moves the money. This two-step process lets you verify everything (inventory, fraud, business rules) before committing to the charge. If anything fails between authorization and capture, you void the authorization and the customer's funds are released.

### The Authorize Method: Talking to Stripe

```typescript
private async authorizePayment(params: PaymentParams): Promise<any> {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(params.amount * 100),   // Stripe uses cents, not dollars
      currency: params.currency.toLowerCase(),
      payment_method: params.paymentMethodId,
      capture_method: 'manual',  // "manual" = authorize only, don't capture yet
      metadata: {
        booking_id: params.bookingId.toString(),
        user_id: params.userId.toString()
      }
    });

    return {
      success: true,
      transactionId: await this.createTransactionRecord(params, paymentIntent.id),
      providerTxnId: paymentIntent.id   // Stripe's ID for this payment
    };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}
```

Notice `capture_method: 'manual'`. This tells Stripe: "Hold the money, but do not charge yet." We charge later with the `capturePayment` method.

Also notice `Math.round(params.amount * 100)`. Stripe represents amounts in the smallest currency unit (cents for USD, pence for GBP). $340.00 becomes 34000. The `Math.round` handles floating-point imprecision — `340.00 * 100` might be `33999.99999999996` in JavaScript.

### The Capture Method

```typescript
private async capturePayment(
  providerTxnId: string,
  amount: number
): Promise<any> {
  try {
    await stripe.paymentIntents.capture(providerTxnId, {
      amount_to_capture: Math.round(amount * 100)
    });
    return { success: true };
  } catch (error) {
    return { success: false, reason: error.message };
  }
}
```

If capture fails (network error, expired authorization, Stripe outage), we void the authorization in the calling code. The customer's hold is released, and no money moves.

---

## Connecting Back to What You Know

| What You Know (Single payments Table) | What's New (Double-Entry Ledger) |
|---|---|
| `INSERT INTO payments (amount, user_id)` | Two-line journal entry: debit one account, credit another |
| One table with amount and status | Three tables: chart_of_accounts, accounting_entries, accounting_entry_lines |
| `UPDATE payments SET status = 'refunded'` | New reversing entry that negates the original — never modify the original |
| SUM(amount) to get total | `getAccountBalance()` that respects account types (debit-normal vs. credit-normal) |
| No audit trail | Every entry is posted, timestamped, and immutable |
| Revenue recognized at payment time | Revenue recognized at service delivery; payment is a liability until then |
| Single step: charge and record | Six steps: fraud check, authorize, record, capture, record, accounting entry |

The biggest mental shift: **a payment is not revenue**. When a customer pays $340, you have $340 more cash but you also have $340 more liability. Your net position is zero. Revenue only appears when the service is delivered (the guest checks in). This distinction is fundamental to every real financial system and probably the single most important takeaway from this chapter.

---

## Chapter 13 Summary

| Concept | One-Sentence Summary |
|---|---|
| Double-entry accounting | Every transaction has equal debits and credits, making errors immediately detectable. |
| Chart of accounts | Master list of financial buckets, organized by type (asset, liability, revenue, expense, equity). |
| Debit-normal vs. credit-normal | Assets and expenses increase with debits; liabilities, revenue, and equity increase with credits. |
| Balanced entry trigger | Database trigger that prevents posting an entry unless total debits equal total credits. |
| Immutability triggers | Database-enforced rule that posted entries can never be modified or deleted. |
| Entry number generator | Atomic sequence generator that produces human-readable, daily-resetting, unique entry numbers. |
| Customer deposit (liability) | A payment received is a liability until the service is delivered — it is not revenue yet. |
| Revenue recognition | Transferring a customer deposit into revenue when the service is actually delivered. |
| Cost accrual | Recording what you owe the supplier as a separate journal entry from revenue recognition. |
| Authorization vs. capture | Two-step payment: hold the funds (authorize), then charge (capture). Allows voiding if something fails. |
| Clearing account | Temporary holding account for money in transit at a payment provider. |
| SQL injection in dates | Always use parameterized queries, even for date values — string interpolation is never safe. |

> **Checkpoint:** Test yourself on these five questions:
>
> 1. Why is a customer's payment recorded as a *liability* and not as *revenue*?
> 2. What does the `chk_debit_or_credit` constraint enforce on every entry line?
> 3. Why are revenue recognition and cost accrual recorded as separate journal entries instead of one combined entry?
> 4. What happens if you try to UPDATE a posted accounting entry?
> 5. In the `generateEntryNumber` method, why does the INSERT statement set `next_sequence = 2` instead of `1`?
>
> If you can answer all five, you understand double-entry accounting well enough to implement it. If questions 1 or 4 gave you trouble, re-read the sections on customer deposits and immutability triggers. Those concepts are the foundation of financial system integrity.
