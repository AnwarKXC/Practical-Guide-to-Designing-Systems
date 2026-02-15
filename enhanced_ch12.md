# Chapter 12: Booking Service — The Orchestrator

## Where You Are Right Now

You have built CRUD endpoints. You know the drill: the user sends a POST request, your controller calls a service, the service calls the repository, the repository runs an INSERT, and you send back a 201. One function, one database, one table, done.

That pattern carried you through your first year. And it works brilliantly for single-resource operations: create a user, update a profile, delete a comment.

But what happens when a single user action -- "Book this hotel room" -- must touch *four different services*, each with its own database, each capable of failing independently? You cannot wrap that in a single `BEGIN` / `COMMIT`. You cannot do it in one function call. You need something fundamentally different.

You need an **orchestrator**.

And this chapter will build one from the ground up. Not a toy version -- a production-grade Booking Service with a formal state machine, idempotency guarantees, a business rules engine, compensating transactions for partial failures, event sourcing for audit trails, and performance optimizations that let you handle 100,000 bookings per minute. By the end, you will have written the most critical service in the entire Global Booking System.

---

## Why the Booking Service Is the Orchestrator, Not a Participant

Before we write any code, we need to settle a fundamental architectural question: why does the Booking Service *coordinate* the other services instead of being just another participant in the workflow?

> **Analogy:** Think of a project manager at a construction site. The project manager does not lay bricks, wire electrical panels, or install plumbing. Instead, they coordinate: "Electrician, run the wiring for floor three. Done? Good. Plumber, you're clear to install pipes on floor three now. Done? Good. Inspector, come verify floor three." If the plumber finds a cracked pipe and cannot proceed, the project manager tells the electrician to pause and the inspector to stand down. The project manager does not DO the work. They coordinate others and handle the consequences when something goes wrong.

The Booking Service is our project manager. When a user clicks "Book Now," the Booking Service does not check room availability itself. It does not charge credit cards itself. It does not send confirmation emails itself. Instead, it calls the Inventory Service, the Payment Service, and the Notification Service -- in the right order, with the right data, handling failures at every step.

### Three Reasons the Orchestrator Must Be a Separate Concern

**Reason 1: The orchestrator owns the workflow state.** The Inventory Service knows about rooms. The Payment Service knows about charges. But neither knows the full picture: "This booking is halfway through creation -- inventory is held but payment has not been attempted yet." Only the Booking Service tracks where we are in the multi-step process. If the Booking Service were also responsible for inventory logic, the workflow state and the domain logic would be tangled together, making both harder to reason about and harder to test.

**Reason 2: Failure handling is the orchestrator's job, not the participant's.** When payment fails, the Inventory Service should not decide on its own to release the hold. Why? Because it does not know *why* the hold was created, whether a retry is coming, or whether a human needs to review the case. The orchestrator makes that decision. Each participant does one thing and reports success or failure. The orchestrator decides what happens next.

**Reason 3: The orchestrator enables workflow evolution without touching participants.** Today the flow is: check availability, hold inventory, charge payment, confirm hold, send email. Next quarter, the business wants to add a fraud check between holding inventory and charging the card. With orchestration, you add one step to the Booking Service. The Inventory Service and Payment Service remain untouched. With choreography (where each service listens for events and decides its own next step), adding a fraud check means rewiring the event chains across multiple services. The blast radius is enormous.

> **Key Term:** **Orchestration** -- A coordination pattern where one central service (the orchestrator) directs the workflow by making explicit calls to other services in sequence. The orchestrator knows the full flow and controls the order of operations. This contrasts with *choreography*, where each service reacts to events independently without a central coordinator.

### What the Orchestrator Does NOT Do

The Booking Service does not:

- **Manage inventory.** It does not know how many rooms are available. It asks the Inventory Service.
- **Process payments.** It does not talk to Stripe directly. It asks the Payment Service.
- **Send notifications.** It does not format emails or push notifications. It publishes events that the Notification Service consumes.
- **Handle authentication.** It receives a validated user ID from the API gateway. It does not verify tokens.

The Booking Service's only job is to call these services in the right order, pass the right data between them, handle failures at every step, and maintain an authoritative record of every booking's current state.

> **What If You Skip This?** If you embed orchestration logic inside a participant service -- for example, having the Payment Service trigger inventory confirmation after a successful charge -- you create hidden dependencies. The Payment Service now needs to know about inventory. When you change the inventory API, the Payment Service breaks. You have coupled two services that should be completely independent.

---

## The Booking Lifecycle: A Full State Machine

Before we look at code, let us understand the *states* a booking can be in. This is not just a status column you casually update. It is a **state machine** -- a formal model of every valid state and every valid transition between states.

Our system supports a richer lifecycle than most tutorials show. A booking does not just go from "created" to "done." It moves through distinct phases, each with its own meaning and constraints.

```
                                     modify
                              +------------------+
                              |                  |
  +----------+   confirm   +--+--------+  check_in   +------------+  complete  +------------+
  | PENDING  |------------>| CONFIRMED |------------>| CHECKED_IN |---------->| COMPLETED  |
  +----+-----+             +-----+-----+             +------+-----+           +------------+
       |                         |                          |
       |  payment_failed         |  cancel                  |  cancel (early departure)
       |                         |                          |
  +----v-----+             +-----v------+                   |
  |  FAILED  |             | CANCELLED  |<------------------+
  +----------+             +-----+------+
                                 |
                                 |  refund_processed
                                 |
                           +-----v------+
                           |  REFUNDED  |
                           +------------+
```

Let us walk through every state and every arrow.

| State | Meaning | How We Got Here |
|---|---|---|
| **PENDING** | Booking created, inventory held, payment not yet processed | User clicked "Book Now" and we reserved the room |
| **CONFIRMED** | Payment succeeded, inventory permanently reserved | Payment Service charged the card successfully |
| **CHECKED_IN** | The guest has physically arrived and checked in | Hotel front desk or automated kiosk confirmed arrival |
| **COMPLETED** | The guest checked out and the service was fully delivered | Triggered by check-out date or manual confirmation |
| **FAILED** | Payment was declined or another critical step failed | Payment Service returned a decline, or a timeout occurred |
| **CANCELLED** | The customer or system cancelled a confirmed booking | Customer requested cancellation, or no-show policy triggered |
| **REFUNDED** | A cancelled booking has had its payment refunded | Payment Service processed the refund successfully |

> **Key Term:** **State Machine** -- A model that defines a finite set of states an entity can be in, plus the valid transitions between those states. A booking in the PENDING state can move to CONFIRMED or FAILED, but it cannot jump directly to REFUNDED. The state machine enforces business rules: you cannot refund a booking that was never confirmed.

### Why CHECKED_IN Matters

Many booking systems skip the CHECKED_IN state and jump straight from CONFIRMED to COMPLETED. That is a mistake in an enterprise system for three reasons:

1. **Revenue recognition timing.** Accounting rules require that revenue is recognized when the service begins to be delivered, not when the booking is confirmed. CHECKED_IN marks the start of service delivery.
2. **No-show detection.** If a CONFIRMED booking never transitions to CHECKED_IN by a certain time after the check-in date, the system can automatically trigger no-show policies -- charging a penalty, releasing the room, or notifying the operations team.
3. **Early departure handling.** A guest who checks in but leaves two days early needs a different cancellation flow than a guest who cancels before arrival. The CHECKED_IN state enables this distinction.

### The State Machine as Code

Here is the formal implementation. Every state transition is validated before it is applied.

```typescript
// booking-state-machine.ts
// ============================================
// Booking State Machine — enforces valid transitions
// ============================================

export enum BookingStatus {
  PENDING    = 'pending',
  CONFIRMED  = 'confirmed',
  CHECKED_IN = 'checked_in',
  COMPLETED  = 'completed',
  FAILED     = 'failed',
  CANCELLED  = 'cancelled',
  REFUNDED   = 'refunded',
}

// Every key is a current state.
// Every value is an array of states it can transition TO.
const VALID_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  [BookingStatus.PENDING]:    [BookingStatus.CONFIRMED, BookingStatus.FAILED],
  [BookingStatus.CONFIRMED]:  [BookingStatus.CHECKED_IN, BookingStatus.CANCELLED],
  [BookingStatus.CHECKED_IN]: [BookingStatus.COMPLETED, BookingStatus.CANCELLED],
  [BookingStatus.COMPLETED]:  [],  // Terminal state — no transitions out
  [BookingStatus.FAILED]:     [],  // Terminal state
  [BookingStatus.CANCELLED]:  [BookingStatus.REFUNDED],
  [BookingStatus.REFUNDED]:   [],  // Terminal state
};

export function canTransition(
  currentStatus: BookingStatus,
  newStatus: BookingStatus,
): boolean {
  const allowed = VALID_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(newStatus) : false;
}

export function assertTransition(
  currentStatus: BookingStatus,
  newStatus: BookingStatus,
): void {
  if (!canTransition(currentStatus, newStatus)) {
    throw new InvalidStateTransitionError(
      `Cannot transition booking from '${currentStatus}' to '${newStatus}'. ` +
      `Allowed transitions from '${currentStatus}': [${VALID_TRANSITIONS[currentStatus].join(', ')}]`
    );
  }
}
```

Every time you update a booking's status, you call `assertTransition` first. If the transition is invalid, the function throws an exception with a clear message explaining what went wrong and what the valid options are. This catches bugs early, prevents data corruption, and gives your support team actionable error messages.

### Why a Plain Status Column Is Not Enough

You probably have code that does this:

```typescript
// The naive approach — just update the column
await db.query(
  'UPDATE bookings SET status = $1 WHERE id = $2',
  ['confirmed', bookingId]
);
```

This compiles. This runs. But it does not enforce the state machine. Nothing stops you from updating a COMPLETED booking back to PENDING. Nothing stops you from setting a FAILED booking to REFUNDED (skipping CANCELLED entirely). Over time, you will have bookings in impossible states, and your support team will spend hours figuring out what happened.

In a production system, we validate transitions before applying them and we record *every* transition as an immutable event:

```typescript
// This is what production code looks like
async transitionBooking(
  bookingId: string,
  newStatus: BookingStatus,
  reason: string,
  actorId: string,
): Promise<Booking> {
  return await this.prisma.$transaction(async (tx) => {
    // 1. Lock the booking row to prevent concurrent transitions
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });

    // 2. Validate the transition
    assertTransition(booking.status as BookingStatus, newStatus);

    // 3. Update the booking status
    const updated = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: newStatus,
        updatedAt: new Date(),
      },
    });

    // 4. Record the transition as an immutable event
    await tx.bookingEvent.create({
      data: {
        bookingId,
        eventType: `status.${newStatus}`,
        previousStatus: booking.status,
        newStatus: newStatus,
        reason,
        actorId,
        metadata: {},
        occurredAt: new Date(),
      },
    });

    return updated;
  });
}
```

Notice three things about this code. First, we fetch the current booking inside a transaction so the status cannot change between our read and our write. Second, we call `assertTransition` before doing anything destructive. Third, we write a `bookingEvent` record that captures the previous state, the new state, who made the change, and why. This event log is immutable -- you never update or delete these records. They form the complete audit trail for the booking's lifecycle.

> **Analogy:** Think of a traffic light. It goes green, then yellow, then red, then green again. It never goes from green straight to red. If it did, drivers would crash. The state machine is your traffic light -- it enforces a safe, predictable sequence.

---

## The Database Schema: Building the Foundation

Every service in our system owns its data. The Booking Service is no exception. It has three core tables: `bookings` (the current state of every booking), `booking_events` (the immutable audit trail of every change), and `outbox_events` (events waiting to be published to Kafka).

Let us build all three, first in raw SQL, then in Prisma.

### Raw SQL: The `bookings` Table

```sql
-- ============================================
-- Table: bookings
-- The source of truth for every booking in the system.
-- Each row represents a single booking with its current state.
-- ============================================

CREATE TABLE bookings (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    reference_code  VARCHAR(20) NOT NULL UNIQUE,          -- Human-readable: BK-20260215-A3F9K2
    idempotency_key VARCHAR(64) NOT NULL UNIQUE,          -- Prevents duplicate bookings

    -- Who and what
    user_id         BIGINT NOT NULL,
    booking_type    ENUM('hotel', 'flight', 'car') NOT NULL,
    resource_id     BIGINT NOT NULL,                      -- Room ID, flight ID, or car ID
    resource_name   VARCHAR(255) NOT NULL,                -- "Deluxe Room - Tokyo Hilton"

    -- When
    check_in_date   DATE NOT NULL,
    check_out_date  DATE NOT NULL,
    nights          SMALLINT GENERATED ALWAYS AS (DATEDIFF(check_out_date, check_in_date)) STORED,

    -- How much
    base_price      DECIMAL(12,2) NOT NULL,
    taxes           DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    fees            DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    discount        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    total_amount    DECIMAL(12,2) GENERATED ALWAYS AS (base_price + taxes + fees - discount) STORED,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',

    -- State machine
    status          ENUM('pending','confirmed','checked_in','completed','failed','cancelled','refunded')
                    NOT NULL DEFAULT 'pending',
    previous_status ENUM('pending','confirmed','checked_in','completed','failed','cancelled','refunded') NULL,

    -- External references
    hold_id         BIGINT NULL,                          -- Links to inventory_holds
    payment_id      BIGINT NULL,                          -- Links to payment_transactions
    refund_id       BIGINT NULL,                          -- Links to refund record

    -- Guest details (denormalized for read performance)
    guest_name      VARCHAR(255) NOT NULL,
    guest_email     VARCHAR(255) NOT NULL,
    guest_phone     VARCHAR(50) NULL,
    special_requests TEXT NULL,

    -- Cancellation
    cancelled_at        TIMESTAMP NULL,
    cancellation_reason TEXT NULL,
    cancellation_fee    DECIMAL(12,2) NULL,

    -- Metadata
    source          VARCHAR(50) NOT NULL DEFAULT 'web',   -- web, mobile, api, agent
    ip_address      VARCHAR(45) NULL,
    user_agent      TEXT NULL,

    -- Timestamps
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    confirmed_at    TIMESTAMP NULL,
    checked_in_at   TIMESTAMP NULL,
    completed_at    TIMESTAMP NULL,
    version         INT NOT NULL DEFAULT 1,               -- Optimistic locking

    -- Constraints
    CONSTRAINT chk_dates CHECK (check_out_date > check_in_date),
    CONSTRAINT chk_positive_price CHECK (base_price >= 0),
    CONSTRAINT chk_currency_code CHECK (LENGTH(currency) = 3),

    -- Indexes for common queries
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_reference_code (reference_code),
    INDEX idx_check_in (check_in_date),
    INDEX idx_resource (booking_type, resource_id),
    INDEX idx_created_at (created_at),
    INDEX idx_user_status (user_id, status),             -- "Show me my confirmed bookings"
    INDEX idx_dates_status (check_in_date, check_out_date, status)  -- Availability queries
);
```

Let us examine the design decisions in this schema:

- **`reference_code`**: Human-readable identifiers like `BK-20260215-A3F9K2` that customers see in emails and support calls. The `id` column is an internal auto-increment for joins and foreign keys. Never expose auto-increment IDs to users -- they leak information about your volume and are easy to guess.
- **`idempotency_key`**: A client-generated unique key that prevents duplicate bookings. We will cover this in detail in the Idempotency section below.
- **`nights` (generated column)**: Computed automatically from `check_in_date` and `check_out_date`. You never set this manually, so it cannot drift out of sync.
- **`total_amount` (generated column)**: Computed from `base_price + taxes + fees - discount`. Same principle -- derived data is computed, not stored manually.
- **`version`**: Used for optimistic locking. When you update a booking, you include `WHERE version = @currentVersion` in your UPDATE. If another process changed the booking between your read and your write, the version will not match and the UPDATE will affect zero rows. You detect that and retry or fail.

### Raw SQL: The `booking_events` Table

This table is the immutable event log. Every time anything happens to a booking -- status change, modification, note added -- a row goes here. You never UPDATE or DELETE from this table.

```sql
-- ============================================
-- Table: booking_events
-- Immutable audit trail for every booking change.
-- This table is append-only. No UPDATEs. No DELETEs.
-- ============================================

CREATE TABLE booking_events (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id      BIGINT NOT NULL,
    event_type      VARCHAR(50) NOT NULL,               -- 'status.confirmed', 'modification.date_change', etc.
    event_version   INT NOT NULL,                       -- Sequential per booking: 1, 2, 3, ...

    -- State change details
    previous_status VARCHAR(20) NULL,
    new_status      VARCHAR(20) NULL,

    -- Who did it and why
    actor_id        VARCHAR(100) NOT NULL,              -- User ID, 'system', 'cron', 'admin:john@example.com'
    actor_type      ENUM('user', 'system', 'admin', 'api') NOT NULL DEFAULT 'system',
    reason          TEXT NULL,

    -- What changed (for modifications)
    changes         JSON NULL,                          -- {"check_in_date": {"from": "2026-03-10", "to": "2026-03-12"}}
    metadata        JSON NULL,                          -- Additional context: IP, user agent, correlation ID

    -- Timestamps
    occurred_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at    TIMESTAMP NULL,                     -- When downstream consumers processed this event

    -- Indexes
    INDEX idx_booking_id (booking_id),
    INDEX idx_booking_version (booking_id, event_version),
    INDEX idx_event_type (event_type),
    INDEX idx_occurred_at (occurred_at),

    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT
);
```

> **Key Term:** **Append-Only Log** -- A data structure where new records are only added, never modified or removed. The booking_events table is an append-only log. It gives you a complete, tamper-proof history of everything that ever happened to a booking. If you need to "undo" an event, you add a *new* event that reverses it -- you do not delete the original.

### Raw SQL: The `outbox_events` Table

The outbox table stores events that need to be published to Kafka. A background relay process reads from this table and publishes the events. Once published, the row is marked as processed (not deleted -- we keep it for debugging).

```sql
-- ============================================
-- Table: outbox_events
-- Transactional outbox for reliable event publishing.
-- Events are written here in the same transaction as business data,
-- then published to Kafka by a background relay process.
-- ============================================

CREATE TABLE outbox_events (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    aggregate_type  VARCHAR(50) NOT NULL,               -- 'booking', 'payment', etc.
    aggregate_id    VARCHAR(100) NOT NULL,              -- The booking ID or other entity ID
    event_type      VARCHAR(100) NOT NULL,              -- 'booking.created', 'booking.cancelled', etc.
    payload         JSON NOT NULL,                      -- The full event data as JSON

    -- Publishing status
    status          ENUM('pending', 'published', 'failed') NOT NULL DEFAULT 'pending',
    retry_count     SMALLINT NOT NULL DEFAULT 0,
    max_retries     SMALLINT NOT NULL DEFAULT 5,
    last_error      TEXT NULL,

    -- Ordering guarantee
    sequence_number BIGINT NOT NULL UNIQUE, -- Strict ordering (use a separate sequence table or app-generated counter; MySQL allows only one AUTO_INCREMENT per table)

    -- Timestamps
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at    TIMESTAMP NULL,
    next_retry_at   TIMESTAMP NULL,

    -- Indexes
    INDEX idx_status_created (status, created_at),       -- Relay polls: pending events oldest first
    INDEX idx_aggregate (aggregate_type, aggregate_id),  -- Find all events for an entity
    INDEX idx_next_retry (status, next_retry_at)         -- Failed events ready for retry
);
```

### Prisma Schema: All Three Tables

Now let us define the same schema in Prisma. If you are not familiar with Prisma, it is an ORM for TypeScript that generates type-safe database client code from a schema file. Every raw SQL table above has a corresponding Prisma model below.

```prisma
// schema.prisma
// ============================================
// Booking Service — Prisma Schema
// ============================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

enum BookingType {
  hotel
  flight
  car
}

enum BookingStatus {
  pending
  confirmed
  checked_in
  completed
  failed
  cancelled
  refunded
}

enum ActorType {
  user
  system
  admin
  api
}

enum OutboxStatus {
  pending
  published
  failed
}

model Booking {
  id              BigInt        @id @default(autoincrement())
  referenceCode   String        @unique @map("reference_code") @db.VarChar(20)
  idempotencyKey  String        @unique @map("idempotency_key") @db.VarChar(64)

  // Who and what
  userId          BigInt        @map("user_id")
  bookingType     BookingType   @map("booking_type")
  resourceId      BigInt        @map("resource_id")
  resourceName    String        @map("resource_name") @db.VarChar(255)

  // When
  checkInDate     DateTime      @map("check_in_date") @db.Date
  checkOutDate    DateTime      @map("check_out_date") @db.Date

  // How much
  basePrice       Decimal       @map("base_price") @db.Decimal(12, 2)
  taxes           Decimal       @default(0) @db.Decimal(12, 2)
  fees            Decimal       @default(0) @db.Decimal(12, 2)
  discount        Decimal       @default(0) @db.Decimal(12, 2)
  currency        String        @default("USD") @db.Char(3)

  // State
  status          BookingStatus @default(pending)
  previousStatus  BookingStatus? @map("previous_status")

  // External references
  holdId          BigInt?       @map("hold_id")
  paymentId       BigInt?       @map("payment_id")
  refundId        BigInt?       @map("refund_id")

  // Guest details
  guestName       String        @map("guest_name") @db.VarChar(255)
  guestEmail      String        @map("guest_email") @db.VarChar(255)
  guestPhone      String?       @map("guest_phone") @db.VarChar(50)
  specialRequests String?       @map("special_requests") @db.Text

  // Cancellation
  cancelledAt         DateTime? @map("cancelled_at")
  cancellationReason  String?   @map("cancellation_reason") @db.Text
  cancellationFee     Decimal?  @map("cancellation_fee") @db.Decimal(12, 2)

  // Metadata
  source          String        @default("web") @db.VarChar(50)
  ipAddress       String?       @map("ip_address") @db.VarChar(45)
  userAgent       String?       @map("user_agent") @db.Text

  // Timestamps
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")
  confirmedAt     DateTime?     @map("confirmed_at")
  checkedInAt     DateTime?     @map("checked_in_at")
  completedAt     DateTime?     @map("completed_at")
  version         Int           @default(1)

  // Relations
  events          BookingEvent[]

  @@index([userId], map: "idx_user_id")
  @@index([status], map: "idx_status")
  @@index([checkInDate], map: "idx_check_in")
  @@index([bookingType, resourceId], map: "idx_resource")
  @@index([createdAt], map: "idx_created_at")
  @@index([userId, status], map: "idx_user_status")
  @@index([checkInDate, checkOutDate, status], map: "idx_dates_status")
  @@map("bookings")
}

model BookingEvent {
  id              BigInt        @id @default(autoincrement())
  bookingId       BigInt        @map("booking_id")
  eventType       String        @map("event_type") @db.VarChar(50)
  eventVersion    Int           @map("event_version")

  previousStatus  String?       @map("previous_status") @db.VarChar(20)
  newStatus       String?       @map("new_status") @db.VarChar(20)

  actorId         String        @map("actor_id") @db.VarChar(100)
  actorType       ActorType     @default(system) @map("actor_type")
  reason          String?       @db.Text

  changes         Json?
  metadata        Json?

  occurredAt      DateTime      @default(now()) @map("occurred_at")
  processedAt     DateTime?     @map("processed_at")

  // Relations
  booking         Booking       @relation(fields: [bookingId], references: [id], onDelete: Restrict)

  @@index([bookingId], map: "idx_booking_id")
  @@index([bookingId, eventVersion], map: "idx_booking_version")
  @@index([eventType], map: "idx_event_type")
  @@index([occurredAt], map: "idx_occurred_at")
  @@map("booking_events")
}

model OutboxEvent {
  id              BigInt        @id @default(autoincrement())
  aggregateType   String        @map("aggregate_type") @db.VarChar(50)
  aggregateId     String        @map("aggregate_id") @db.VarChar(100)
  eventType       String        @map("event_type") @db.VarChar(100)
  payload         Json

  status          OutboxStatus  @default(pending)
  retryCount      Int           @default(0) @map("retry_count") @db.SmallInt
  maxRetries      Int           @default(5) @map("max_retries") @db.SmallInt
  lastError       String?       @map("last_error") @db.Text

  sequenceNumber  BigInt        @unique @default(autoincrement()) @map("sequence_number")

  createdAt       DateTime      @default(now()) @map("created_at")
  publishedAt     DateTime?     @map("published_at")
  nextRetryAt     DateTime?     @map("next_retry_at")

  @@index([status, createdAt], map: "idx_status_created")
  @@index([aggregateType, aggregateId], map: "idx_aggregate")
  @@index([status, nextRetryAt], map: "idx_next_retry")
  @@map("outbox_events")
}
```

> **Checkpoint:** Look at the Prisma schema above and the raw SQL above it. Can you trace each Prisma field back to its SQL column? Notice how `@map("column_name")` translates camelCase TypeScript names to snake_case database columns. This is critical -- your TypeScript code uses `booking.checkInDate` while the database column is `check_in_date`. Prisma handles the translation automatically.

---

## The NestJS Booking Module: Structure and Components

Now that we have our database schema, let us build the NestJS module that wraps it. If you have used NestJS before, you know the pattern: a module contains controllers (HTTP endpoints), services (business logic), and DTOs (data transfer objects that validate incoming requests).

If you have not used NestJS, here is the minimum you need to know: NestJS is a TypeScript framework that uses decorators (`@Controller`, `@Injectable`, `@Get`, `@Post`) to wire things together. It enforces a modular architecture that maps naturally to microservices. Each service in our system is a NestJS application.

### DTOs: Validating What Comes In

DTOs define the shape of incoming requests and apply validation rules. If a request does not match the DTO, NestJS rejects it with a 400 before your service code ever runs.

```typescript
// dto/create-booking.dto.ts
// ============================================
// DTO for creating a new booking.
// Every field is validated before the service sees it.
// ============================================

import {
  IsString, IsEnum, IsNumber, IsDate, IsOptional,
  IsEmail, Min, MaxLength, IsUUID, IsIP,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBookingDto {
  @IsUUID()
  idempotencyKey: string;                // Client-generated, prevents duplicates

  @IsNumber()
  userId: number;

  @IsEnum(['hotel', 'flight', 'car'])
  bookingType: 'hotel' | 'flight' | 'car';

  @IsNumber()
  resourceId: number;

  @IsString()
  @MaxLength(255)
  resourceName: string;

  @IsDate()
  @Type(() => Date)
  checkInDate: Date;

  @IsDate()
  @Type(() => Date)
  checkOutDate: Date;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsNumber()
  @Min(0)
  taxes: number;

  @IsNumber()
  @Min(0)
  fees: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  discount?: number;

  @IsString()
  @MaxLength(3)
  currency: string;

  @IsString()
  @MaxLength(255)
  guestName: string;

  @IsEmail()
  guestEmail: string;

  @IsString()
  @IsOptional()
  guestPhone?: string;

  @IsString()
  @IsOptional()
  specialRequests?: string;

  @IsString()
  @IsOptional()
  source?: string;

  @IsString()
  paymentMethodId: string;              // Stripe payment method token
}
```

```typescript
// dto/modify-booking.dto.ts
// ============================================
// DTO for modifying an existing booking.
// Only the fields being changed are required.
// ============================================

import {
  IsDate, IsNumber, IsOptional, IsString, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ModifyBookingDto {
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  checkInDate?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  checkOutDate?: Date;

  @IsNumber()
  @IsOptional()
  resourceId?: number;                  // For room upgrades

  @IsString()
  @IsOptional()
  resourceName?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  basePrice?: number;

  @IsString()
  @IsOptional()
  reason?: string;
}
```

```typescript
// dto/cancel-booking.dto.ts
// ============================================
// DTO for cancelling a booking.
// ============================================

import { IsString, IsOptional } from 'class-validator';

export class CancelBookingDto {
  @IsString()
  reason: string;

  @IsString()
  @IsOptional()
  requestedBy?: string;                 // 'user', 'admin', 'system'
}
```

```typescript
// dto/booking-query.dto.ts
// ============================================
// DTO for searching and filtering bookings.
// ============================================

import {
  IsOptional, IsEnum, IsNumber, IsDate, IsString, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BookingQueryDto {
  @IsNumber()
  @IsOptional()
  userId?: number;

  @IsEnum(['hotel', 'flight', 'car'])
  @IsOptional()
  bookingType?: string;

  @IsEnum(['pending', 'confirmed', 'checked_in', 'completed', 'failed', 'cancelled', 'refunded'])
  @IsOptional()
  status?: string;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  checkInFrom?: Date;

  @IsDate()
  @Type(() => Date)
  @IsOptional()
  checkInTo?: Date;

  @IsString()
  @IsOptional()
  referenceCode?: string;

  @IsString()
  @IsOptional()
  guestEmail?: string;

  @IsNumber()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  offset?: number = 0;

  @IsString()
  @IsOptional()
  sortBy?: string = 'createdAt';

  @IsEnum(['asc', 'desc'])
  @IsOptional()
  sortOrder?: 'asc' | 'desc' = 'desc';
}
```

### The Booking Controller: HTTP Endpoints

The controller is thin. It receives HTTP requests, delegates to the service, and returns responses. It does not contain business logic -- that lives in the service.

```typescript
// booking.controller.ts
// ============================================
// Booking Controller — HTTP layer only.
// All business logic is in BookingService.
// ============================================

import {
  Controller, Post, Get, Patch, Delete, Body, Param,
  Query, Headers, HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { ModifyBookingDto } from './dto/modify-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { BookingQueryDto } from './dto/booking-query.dto';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('bookings')
@UseGuards(AuthGuard)
export class BookingController {

  constructor(private readonly bookingService: BookingService) {}

  // ----- Create a new booking -----
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createBooking(
    @Body() dto: CreateBookingDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Headers('x-request-id') requestId: string,
    @CurrentUser() user: { id: number },
  ) {
    // The idempotency key can come from the header or the body.
    // Header takes precedence if both are provided.
    dto.idempotencyKey = idempotencyKey || dto.idempotencyKey;
    dto.userId = user.id;

    return this.bookingService.createBooking(dto, requestId);
  }

  // ----- Get a single booking by reference code -----
  @Get(':referenceCode')
  async getBooking(
    @Param('referenceCode') referenceCode: string,
    @CurrentUser() user: { id: number; role: string },
  ) {
    return this.bookingService.getBookingByReferenceCode(
      referenceCode,
      user,
    );
  }

  // ----- Search and filter bookings -----
  @Get()
  async searchBookings(
    @Query() query: BookingQueryDto,
    @CurrentUser() user: { id: number; role: string },
  ) {
    // Regular users can only see their own bookings.
    // Admins can see everything.
    if (user.role !== 'admin') {
      query.userId = user.id;
    }
    return this.bookingService.searchBookings(query);
  }

  // ----- Modify a confirmed booking -----
  @Patch(':referenceCode')
  async modifyBooking(
    @Param('referenceCode') referenceCode: string,
    @Body() dto: ModifyBookingDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.bookingService.modifyBooking(
      referenceCode,
      dto,
      String(user.id),
    );
  }

  // ----- Cancel a booking -----
  @Post(':referenceCode/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelBooking(
    @Param('referenceCode') referenceCode: string,
    @Body() dto: CancelBookingDto,
    @CurrentUser() user: { id: number },
  ) {
    return this.bookingService.cancelBooking(
      referenceCode,
      dto,
      String(user.id),
    );
  }

  // ----- Get booking event history (audit trail) -----
  @Get(':referenceCode/events')
  async getBookingEvents(
    @Param('referenceCode') referenceCode: string,
    @CurrentUser() user: { id: number; role: string },
  ) {
    return this.bookingService.getBookingEvents(referenceCode, user);
  }

  // ----- Check in (hotel/admin endpoint) -----
  @Post(':referenceCode/check-in')
  @HttpCode(HttpStatus.OK)
  async checkIn(
    @Param('referenceCode') referenceCode: string,
    @CurrentUser() user: { id: number },
  ) {
    return this.bookingService.checkIn(referenceCode, String(user.id));
  }
}
```

Notice how thin this controller is. Every method follows the same pattern: extract data from the request, call the service, return the result. There is no `if (status === 'pending')` logic here. There is no database access. There are no try-catch blocks -- NestJS exception filters handle errors globally. The controller is a *routing layer*, nothing more.

> **What If You Skip This?** If you put business logic in your controller (checking availability, validating state transitions, calling external services), your controller becomes untestable without an HTTP server running. By keeping logic in the service, you can unit-test booking creation with a simple function call -- no `supertest`, no mock requests, no HTTP overhead.

### The Booking Module: Wiring It Together

```typescript
// booking.module.ts
// ============================================
// NestJS Module — declares the controller, service,
// and injects dependencies.
// ============================================

import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentModule } from '../payment/payment.module';
import { BookingValidationService } from './booking-validation.service';
import { BookingStateService } from './booking-state.service';

@Module({
  imports: [PrismaModule, InventoryModule, PaymentModule],
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingValidationService,
    BookingStateService,
  ],
  exports: [BookingService],
})
export class BookingModule {}
```

---

## Idempotency Key Handling: Preventing Duplicate Bookings

Here is a scenario that will happen in production, guaranteed: a user clicks "Book Now," their browser shows a spinner, three seconds pass, the user gets impatient and clicks again. Two requests hit your server. Without idempotency handling, you create two bookings for the same room, charge the customer twice, and generate hours of support work.

An idempotency key solves this. The client generates a unique key (usually a UUID) and sends it with the request. The server checks whether a booking with that key already exists. If it does, the server returns the existing booking instead of creating a new one. If it does not, the server creates the booking and stores the key.

> **Key Term:** **Idempotency** -- The property of an operation where performing it multiple times produces the same result as performing it once. In our context, sending the same booking request twice (with the same idempotency key) creates exactly one booking.

### How the Client Sends It

```typescript
// Client-side code (React, Vue, mobile app, etc.)
// Generate the idempotency key ONCE when the user opens the booking form,
// NOT when they click the button. This way, multiple clicks send the same key.

const idempotencyKey = crypto.randomUUID();  // e.g., "f47ac10b-58cc-4372-a567-0e02b2c3d479"

const response = await fetch('/api/bookings', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Idempotency-Key': idempotencyKey,    // <-- Same key for every retry
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify(bookingData),
});
```

### How the Server Handles It

```typescript
// Inside BookingService.createBooking()
// This is the FIRST thing we do, before any external calls.

async createBooking(dto: CreateBookingDto, requestId: string): Promise<Booking> {

  // ----- Step 0: Idempotency check -----
  // Have we already processed this exact request?
  const existingBooking = await this.prisma.booking.findUnique({
    where: { idempotencyKey: dto.idempotencyKey },
  });

  if (existingBooking) {
    // This is a duplicate request. Return the existing booking
    // with the SAME response the first request received.
    // Do NOT create a new booking. Do NOT charge the card again.
    this.logger.warn(
      `Duplicate booking request detected. Idempotency key: ${dto.idempotencyKey}. ` +
      `Returning existing booking: ${existingBooking.referenceCode}`,
    );
    return existingBooking;
  }

  // If we get here, this is a new request. Proceed with creation.
  // The idempotency key is stored in the booking record (UNIQUE constraint
  // in the database prevents race conditions even under concurrent requests).
  // ...rest of creation flow...
}
```

### The Race Condition: What If Two Requests Arrive Simultaneously?

The `findUnique` check above has a gap: between the moment you check and the moment you INSERT, another request with the same key could slip through. This is a classic TOCTOU (Time Of Check, Time Of Use) problem.

The database's UNIQUE constraint on `idempotency_key` is the real safety net. If two concurrent requests both pass the `findUnique` check (both find nothing), one of them will succeed at INSERT and the other will hit the UNIQUE constraint violation. We catch that specific error and treat it as a duplicate:

```typescript
// Handling the race condition at the database level
async createBooking(dto: CreateBookingDto, requestId: string): Promise<Booking> {
  // Step 0: Idempotency check (optimistic path)
  const existingBooking = await this.prisma.booking.findUnique({
    where: { idempotencyKey: dto.idempotencyKey },
  });

  if (existingBooking) {
    return existingBooking;
  }

  try {
    // ... Step 1-6: the full booking creation flow ...
    const booking = await this.executeBookingFlow(dto);
    return booking;

  } catch (error) {
    // If the INSERT failed because of a duplicate idempotency key,
    // another request won the race. Return the winner's booking.
    if (this.isDuplicateKeyError(error, 'idempotency_key')) {
      const racedBooking = await this.prisma.booking.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (racedBooking) {
        this.logger.warn(
          `Idempotency race condition resolved. Key: ${dto.idempotencyKey}`,
        );
        return racedBooking;
      }
    }
    throw error;  // Some other error — rethrow
  }
}

private isDuplicateKeyError(error: any, field: string): boolean {
  // Prisma wraps MySQL duplicate key errors in a P2002 code
  return error?.code === 'P2002' && error?.meta?.target?.includes(field);
}
```

> **Analogy:** Imagine two people trying to register the same license plate at the DMV at the same time. Even if both clerks check the system and find the plate available, only one can actually register it. The database's UNIQUE constraint is like the DMV's central registry -- it is the final arbiter, and it prevents duplicates even when the check and the registration are not atomic.

### Idempotency Key Lifecycle

| Scenario | What Happens | Result |
|---|---|---|
| First request | Key not found, booking created, key stored | 201 Created |
| Same key, booking succeeded | Key found, existing booking returned | 200 OK (same data) |
| Same key, booking previously failed | Key found with FAILED status | Depends on policy (retry or return failure) |
| Two simultaneous requests, same key | One wins INSERT, other hits UNIQUE violation | Both return same booking |
| Different key, same room/dates | Both proceed independently | Two separate bookings (if inventory allows) |

> **What If You Skip This?** Without idempotency handling, every network timeout and retry creates a duplicate booking. At 100K bookings/minute, even a 0.1% duplicate rate means 100 phantom bookings every minute. Each one blocks inventory, charges customers, and generates support tickets. Your payment processor will flag your account for excessive charges. Your hotel partners will lose trust when they see double bookings.

---

## Booking Validation: A Configurable Business Rules Engine

Before the orchestration flow begins -- before we check inventory, before we create holds, before we even think about payment -- we validate the booking request against a set of business rules. These rules are not just "is the email valid?" (that is DTO validation, already handled). These are *business* rules: "Can this user book this type of room? Is the check-in date at least 24 hours from now? Does this booking violate the maximum stay policy?"

The key insight is that business rules change frequently. Marketing might decide that bookings must be made 48 hours in advance during peak season, but only 2 hours in advance during the off-season. If these rules are scattered throughout your service code as hard-coded `if` statements, changing them requires a code deployment. A rules engine centralizes them and makes them configurable.

```typescript
// booking-validation.service.ts
// ============================================
// Business Rules Engine for Booking Validation
// Rules are evaluated in order. If any rule fails,
// validation stops and returns the error.
// ============================================

import { Injectable } from '@nestjs/common';
import { CreateBookingDto } from './dto/create-booking.dto';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  rule: string;
  message: string;
  field?: string;
}

type ValidationRule = (dto: CreateBookingDto) => ValidationError | null;

@Injectable()
export class BookingValidationService {

  // ----- The rule registry -----
  // Each rule is a function that takes the DTO and returns
  // null (pass) or a ValidationError (fail).
  // Add, remove, or reorder rules without touching the core service.
  private readonly rules: ValidationRule[] = [
    this.checkDatesAreInFuture.bind(this),
    this.checkMinimumAdvanceBooking.bind(this),
    this.checkMaximumStayLength.bind(this),
    this.checkCheckOutAfterCheckIn.bind(this),
    this.checkCurrencySupported.bind(this),
    this.checkPriceWithinRange.bind(this),
    this.checkGuestDetailsComplete.bind(this),
    this.checkBlackoutDates.bind(this),
  ];

  validate(dto: CreateBookingDto): ValidationResult {
    const errors: ValidationError[] = [];

    for (const rule of this.rules) {
      const error = rule(dto);
      if (error) {
        errors.push(error);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // ----- Individual rules -----

  private checkDatesAreInFuture(dto: CreateBookingDto): ValidationError | null {
    const now = new Date();
    now.setHours(0, 0, 0, 0);  // Compare dates only, not times

    if (dto.checkInDate < now) {
      return {
        rule: 'dates_in_future',
        message: 'Check-in date must be in the future.',
        field: 'checkInDate',
      };
    }
    return null;
  }

  private checkMinimumAdvanceBooking(dto: CreateBookingDto): ValidationError | null {
    const now = new Date();
    const hoursUntilCheckIn =
      (dto.checkInDate.getTime() - now.getTime()) / (1000 * 60 * 60);

    // Minimum 2 hours advance for same-day bookings
    if (hoursUntilCheckIn < 2) {
      return {
        rule: 'minimum_advance',
        message: 'Bookings must be made at least 2 hours before check-in.',
        field: 'checkInDate',
      };
    }
    return null;
  }

  private checkMaximumStayLength(dto: CreateBookingDto): ValidationError | null {
    const nights = Math.ceil(
      (dto.checkOutDate.getTime() - dto.checkInDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    const MAX_STAY: Record<string, number> = {
      hotel: 30,    // 30 nights max
      flight: 1,    // Flights are single-day
      car: 90,      // 90 days max for car rental
    };

    const maxNights = MAX_STAY[dto.bookingType] || 30;

    if (nights > maxNights) {
      return {
        rule: 'maximum_stay',
        message: `Maximum stay for ${dto.bookingType} is ${maxNights} nights. Requested: ${nights}.`,
        field: 'checkOutDate',
      };
    }
    return null;
  }

  private checkCheckOutAfterCheckIn(dto: CreateBookingDto): ValidationError | null {
    if (dto.checkOutDate <= dto.checkInDate) {
      return {
        rule: 'checkout_after_checkin',
        message: 'Check-out date must be after check-in date.',
        field: 'checkOutDate',
      };
    }
    return null;
  }

  private checkCurrencySupported(dto: CreateBookingDto): ValidationError | null {
    const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AED', 'SAR'];
    if (!SUPPORTED_CURRENCIES.includes(dto.currency)) {
      return {
        rule: 'currency_supported',
        message: `Currency '${dto.currency}' is not supported. Supported: ${SUPPORTED_CURRENCIES.join(', ')}.`,
        field: 'currency',
      };
    }
    return null;
  }

  private checkPriceWithinRange(dto: CreateBookingDto): ValidationError | null {
    if (dto.basePrice <= 0) {
      return {
        rule: 'price_positive',
        message: 'Base price must be greater than zero.',
        field: 'basePrice',
      };
    }
    // Sanity check: no single booking should exceed $100,000
    if (dto.basePrice > 100000) {
      return {
        rule: 'price_maximum',
        message: 'Base price exceeds maximum allowed ($100,000). Contact support for large bookings.',
        field: 'basePrice',
      };
    }
    return null;
  }

  private checkGuestDetailsComplete(dto: CreateBookingDto): ValidationError | null {
    if (!dto.guestName || dto.guestName.trim().length < 2) {
      return {
        rule: 'guest_name_required',
        message: 'Guest name must be at least 2 characters.',
        field: 'guestName',
      };
    }
    return null;
  }

  private checkBlackoutDates(dto: CreateBookingDto): ValidationError | null {
    // In production, blackout dates come from a database or config service.
    // Here we show the pattern with hardcoded examples.
    const BLACKOUT_DATES = [
      { start: new Date('2026-12-31'), end: new Date('2027-01-02'), reason: 'New Year' },
    ];

    for (const blackout of BLACKOUT_DATES) {
      if (dto.checkInDate <= blackout.end && dto.checkOutDate >= blackout.start) {
        return {
          rule: 'blackout_dates',
          message: `Bookings are not available during ${blackout.reason} (${blackout.start.toISOString().slice(0,10)} to ${blackout.end.toISOString().slice(0,10)}).`,
          field: 'checkInDate',
        };
      }
    }
    return null;
  }
}
```

The validation service is called at the very beginning of the booking flow, before any external service calls:

```typescript
// Inside BookingService.createBooking()
const validation = this.validationService.validate(dto);
if (!validation.valid) {
  throw new BookingValidationError(validation.errors);
}
// Only then proceed to inventory check, hold, payment, etc.
```

Why structure validation as a separate service with individual rule functions? Three reasons:

1. **Testability.** Each rule is a pure function. You can test `checkMaximumStayLength` with a simple unit test -- no database, no HTTP, no mocking.
2. **Configurability.** Adding a new rule means adding one function and one entry in the `rules` array. No refactoring of existing code.
3. **Observability.** When a booking is rejected, the error tells you *which* rule failed and *why*. "Rule: maximum_stay, Message: Maximum stay for hotel is 30 nights. Requested: 45." Your support team can resolve the issue without reading code.

---

## The Full Booking Creation Flow: Step by Step

Now let us put it all together. This is the complete `BookingService.createBooking()` method -- the heart of the entire system. Every line is annotated. Every step has error handling. Read it carefully.

```typescript
// booking.service.ts
// ============================================
// Booking Service — The Orchestrator
// This is the most important file in the entire system.
// ============================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentService } from '../payment/payment.service';
import { BookingValidationService } from './booking-validation.service';
import { BookingStatus, assertTransition } from './booking-state-machine';
import { CreateBookingDto } from './dto/create-booking.dto';
import { nanoid } from 'nanoid';

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly validationService: BookingValidationService,
  ) {}

  async createBooking(dto: CreateBookingDto, requestId: string): Promise<any> {

    // =============================================
    // Step 0: Idempotency Check
    // =============================================
    const existingBooking = await this.prisma.booking.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });

    if (existingBooking) {
      this.logger.warn(`Duplicate request. Key: ${dto.idempotencyKey}`);
      return existingBooking;
    }

    // =============================================
    // Step 1: Validate Business Rules
    // =============================================
    const validation = this.validationService.validate(dto);
    if (!validation.valid) {
      throw new BookingValidationError(validation.errors);
    }

    // =============================================
    // Step 2: Check Inventory Availability
    // =============================================
    // This is a read-only check. "Is there at least one room
    // of this type available on these dates?"
    // If no: fail fast. No holds, no payments, no cleanup.
    const available = await this.inventoryService.checkAvailability({
      resourceType: dto.bookingType,
      resourceId: dto.resourceId,
      checkInDate: dto.checkInDate,
      checkOutDate: dto.checkOutDate,
    });

    if (!available) {
      throw new InsufficientInventoryError(
        `No availability for ${dto.resourceName} from ` +
        `${dto.checkInDate.toISOString().slice(0,10)} to ${dto.checkOutDate.toISOString().slice(0,10)}.`
      );
    }

    // =============================================
    // Step 3: Reserve Inventory (Create a Hold)
    // =============================================
    // Place a temporary hold with a 10-minute TTL.
    // If payment fails or times out, the hold auto-releases.
    const hold = await this.inventoryService.createHold({
      resourceType: dto.bookingType,
      resourceId: dto.resourceId,
      checkInDate: dto.checkInDate,
      checkOutDate: dto.checkOutDate,
      ttlSeconds: 600,
      requestedBy: 'booking-service',
    });

    this.logger.log(
      `Hold created: ${hold.id} for resource ${dto.resourceId}. TTL: 600s.`
    );

    try {
      // =============================================
      // Step 4: Process Payment
      // =============================================
      // The riskiest step. Involves an external provider (Stripe),
      // network calls, fraud checks, and real money movement.
      const payment = await this.paymentService.processPayment({
        userId: dto.userId,
        amount: dto.basePrice + dto.taxes + dto.fees - (dto.discount || 0),
        currency: dto.currency,
        paymentMethodId: dto.paymentMethodId,
        description: `Booking: ${dto.resourceName}`,
        metadata: {
          bookingType: dto.bookingType,
          resourceId: String(dto.resourceId),
          idempotencyKey: dto.idempotencyKey,
        },
      });

      this.logger.log(`Payment processed: ${payment.id}. Amount: ${payment.amount}`);

      // =============================================
      // Step 5: Create Booking Record + Outbox Event
      // =============================================
      // Both the booking and the outbox event are written in
      // the SAME database transaction. Either both succeed or
      // neither does.
      const referenceCode = this.generateReferenceCode();

      const booking = await this.prisma.$transaction(async (tx) => {
        // 5a. Insert the booking
        const newBooking = await tx.booking.create({
          data: {
            referenceCode,
            idempotencyKey: dto.idempotencyKey,
            userId: BigInt(dto.userId),
            bookingType: dto.bookingType,
            resourceId: BigInt(dto.resourceId),
            resourceName: dto.resourceName,
            checkInDate: dto.checkInDate,
            checkOutDate: dto.checkOutDate,
            basePrice: dto.basePrice,
            taxes: dto.taxes,
            fees: dto.fees,
            discount: dto.discount || 0,
            currency: dto.currency,
            status: 'confirmed',      // Payment succeeded — skip PENDING
            holdId: BigInt(hold.id),
            paymentId: BigInt(payment.id),
            guestName: dto.guestName,
            guestEmail: dto.guestEmail,
            guestPhone: dto.guestPhone,
            specialRequests: dto.specialRequests,
            source: dto.source || 'web',
            confirmedAt: new Date(),
          },
        });

        // 5b. Record the creation event
        await tx.bookingEvent.create({
          data: {
            bookingId: newBooking.id,
            eventType: 'booking.created',
            eventVersion: 1,
            previousStatus: null,
            newStatus: 'confirmed',
            actorId: String(dto.userId),
            actorType: 'user',
            reason: 'New booking created',
            metadata: {
              requestId,
              paymentId: String(payment.id),
              holdId: String(hold.id),
            },
          },
        });

        // 5c. Write to the outbox (same transaction!)
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'booking',
            aggregateId: String(newBooking.id),
            eventType: 'booking.created',
            payload: {
              bookingId: String(newBooking.id),
              referenceCode,
              userId: dto.userId,
              bookingType: dto.bookingType,
              resourceId: dto.resourceId,
              totalAmount: dto.basePrice + dto.taxes + dto.fees - (dto.discount || 0),
              currency: dto.currency,
              checkInDate: dto.checkInDate.toISOString(),
              checkOutDate: dto.checkOutDate.toISOString(),
              guestEmail: dto.guestEmail,
            },
          },
        });

        return newBooking;
      });

      // =============================================
      // Step 6: Confirm the Inventory Hold
      // =============================================
      // Tell Inventory: "Convert this temporary hold into a
      // permanent reservation linked to this booking."
      await this.inventoryService.confirmHold(hold.id, String(booking.id));

      this.logger.log(
        `Booking created: ${booking.referenceCode}. ` +
        `Payment: ${payment.id}. Hold: ${hold.id}.`
      );

      return booking;

    } catch (error) {
      // =============================================
      // Rollback: Release the Inventory Hold
      // =============================================
      this.logger.error(
        `Booking creation failed. Releasing hold ${hold.id}. Error: ${error.message}`,
      );

      try {
        await this.inventoryService.releaseHold(
          hold.id,
          `Booking creation failed: ${error.message}`,
          'booking-service',
        );
      } catch (releaseError) {
        // If the release itself fails, the hold will expire via TTL.
        // Log it so we can investigate, but do not throw — the original
        // error is more important.
        this.logger.error(
          `Failed to release hold ${hold.id}: ${releaseError.message}. ` +
          `Hold will auto-expire in ≤600s.`,
        );
      }

      throw error;
    }
  }

  // ----- Generate a human-readable reference code -----
  private generateReferenceCode(): string {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const random = nanoid(6).toUpperCase();  // e.g., "A3F9K2"
    return `BK-${date}-${random}`;
  }
}
```

### Step-by-Step Walkthrough

**Step 0: Idempotency Check.** Before touching any external system, we check if this request has been seen before. If yes, return the existing booking. Cost: one database read. This prevents duplicate charges and duplicate bookings, which are the most common support issues in any booking system.

**Step 1: Validate Business Rules.** Run the request through our rules engine. Fail fast with clear error messages. Cost: zero external calls -- all rules are evaluated locally.

**Step 2: Check Availability.** Ask the Inventory Service if the resource exists and is available for the requested dates. This is a synchronous HTTP call. If the answer is no, we stop immediately. No resources consumed, no side effects, no cleanup needed. This is the cheapest possible failure point after validation.

**Step 3: Create a Hold.** Reserve the resource temporarily with a 10-minute TTL. This is our safety net against the two biggest problems: concurrent bookings claiming the same room, and abandoned flows leaving resources locked forever.

**Step 4: Process Payment.** The riskiest step. External provider, network calls, fraud checks, real money movement. If this fails, we release the hold in the catch block. If it succeeds, we have a `payment.id` linking the booking to the financial transaction.

**Step 5: Create Booking Record + Event + Outbox.** All three writes happen in a single Prisma transaction (`$transaction`). Either all three succeed or none do. This guarantees that a booking always has its first event and its outbox entry. No orphaned records, no missing events.

**Step 6: Confirm Hold.** Convert the temporary hold to a permanent reservation. The TTL is removed. The room is now booked until check-out or cancellation.

> **What If You Skip This?** If you do Steps 5a and 5c in separate transactions, you can end up with a booking that has no outbox event. Downstream services (Notification, Search, Analytics) will never know about the booking. The customer never receives a confirmation email. The search index shows stale availability. The business loses trust.
