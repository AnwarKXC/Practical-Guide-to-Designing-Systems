# Chapter 3: The Booking System We're Building

## What Are We Actually Building?

Picture this: a single platform where anyone on the planet can search for a hotel in Tokyo,
a flight from London to Dubai, or a rental car in Los Angeles — and book all three in under
ten seconds. That's our system. We're building an **enterprise global booking platform** that
handles hotels, flights, and rental cars at a target throughput of **100,000 bookings per minute**.

That number isn't arbitrary. Think about Black Friday, the summer travel rush, or a flash sale
where a major airline drops fares by 60%. Traffic doesn't politely ramp up — it spikes. Our
architecture must handle those spikes without dropping a single booking or double-selling a
seat on a plane.

A monolithic application could handle a few hundred bookings per minute before buckling. We
need something fundamentally different. We need microservices — small, independent services
that each own one job and do it extremely well.

---

## Meet the Team: Every Service as a Person

The easiest way to understand our microservices is to imagine them as people working at a
travel company. Each person has a specific role, their own desk, and their own filing cabinet.
They communicate by passing messages — sometimes face-to-face, sometimes by memo.

### API Gateway — The Front Desk Receptionist

Every request from the outside world hits the API Gateway first. It's the single entry point.
Like a receptionist, it checks if you have an appointment (valid request format), directs you
to the right department (routes to the correct service), and turns away anyone suspicious
(rate limiting, IP blocking).

The Gateway doesn't do the actual work. It never books a hotel or charges a credit card.
It simply makes sure you get to the right person.

**Responsibilities:**
- Route incoming HTTP requests to the correct internal service
- Enforce rate limits (e.g., 1,000 requests/second per client)
- Aggregate responses when a single API call needs data from multiple services
- Terminate TLS (HTTPS) so internal traffic can stay plain HTTP

### Auth Service — The Security Guard

Before you can do anything meaningful, the Security Guard checks your identity. Are you who
you claim to be? The Auth Service handles login, registration, password resets, and — most
importantly — issues **JWT tokens** (think of them as visitor badges). Every subsequent request
carries this badge so other services can verify you without asking the guard again.

> **Key Term:** **JWT (JSON Web Token)** — A compact, self-contained token that carries user
> identity and permissions. Services can verify it without calling the Auth Service every time
> because it's cryptographically signed.

**Responsibilities:**
- Authenticate users (email/password, OAuth, SSO)
- Issue and refresh JWT access tokens
- Manage roles and permissions (admin, customer, partner)

### Search Service — The Library Researcher

When a user types "hotels in Paris, March 15-20, under $200/night," the Search Service
springs into action. It doesn't store bookings or manage inventory — it's purely about
**finding things fast**. It queries Elasticsearch with filters, sorts by relevance or price,
and returns results in milliseconds.

> **Analogy:** Imagine asking a librarian to find every book about French cooking published
> after 2020 that costs less than $30. They don't own the books — they know how to search
> the catalog impossibly fast. That's our Search Service backed by Elasticsearch.

**Responsibilities:**
- Accept complex search queries (location, dates, price range, amenities, ratings)
- Query Elasticsearch indexes for hotels, flights, and cars
- Return paginated, sorted, filtered results
- Support autocomplete and fuzzy matching ("did you mean Marrakech?")

### Inventory Service — The Warehouse Manager

This service knows exactly what's available right now. How many rooms does the Hilton Tokyo
have on March 17? Three seats left on Flight BA-207? The Inventory Service is the **single
source of truth** for availability. When a booking is made, this service decrements the count.
When a cancellation happens, it increments it back.

> **What If You Skip This?** Without a dedicated Inventory Service, two users could book the
> last hotel room simultaneously — both succeed, and you've just oversold. This is called a
> **race condition**, and it will cost you refunds, angry customers, and partner trust.

**Responsibilities:**
- Track real-time availability across all hotels, flights, and car providers
- Reserve inventory atomically (lock, check, decrement — or reject)
- Release inventory on cancellation or expiry
- Sync with external provider systems via scheduled jobs

### Booking Service — The Project Manager

The Booking Service is the **orchestrator**. It doesn't check inventory itself. It doesn't
charge credit cards itself. Instead, it coordinates: "Hey Inventory, reserve that room. Good.
Hey Payment, charge the customer. Good. Hey Notification, send the confirmation." If any
step fails, the Project Manager rolls everything back gracefully.

> **Key Term:** **Saga Pattern** — A sequence of local transactions across services. If step 3
> fails, the saga triggers compensating actions (refund the payment, release the inventory)
> instead of a traditional database rollback, which can't span multiple services.

**Responsibilities:**
- Orchestrate the full booking flow across services
- Implement the Saga Pattern for distributed transactions
- Store booking records (confirmation numbers, status, history)
- Handle cancellations and modifications

### Payment Service — The Accountant

Money is sacred. The Payment Service handles charges, refunds, and payment records with
extreme precision. It integrates with payment gateways (Stripe, PayPal) and ensures that
every cent is accounted for. This service is deliberately isolated — if the Search Service
has a bug, your payment logic stays untouched.

**Responsibilities:**
- Process payments via third-party gateways
- Handle refunds and partial refunds
- Store transaction records with full audit trails
- Manage currency conversion for international bookings

### Notification Service — The Messenger

After a booking is confirmed, someone needs to tell the customer. The Notification Service
sends confirmation emails, SMS alerts, push notifications, and partner notifications. It
listens for events ("booking confirmed," "payment failed," "flight delayed") and delivers
the right message through the right channel.

> **Analogy:** The Messenger doesn't decide what happened — they just deliver the news.
> They subscribe to events on the company bulletin board (Kafka) and rush off to tell the
> right people.

**Responsibilities:**
- Send emails (booking confirmations, receipts, itineraries)
- Send SMS and push notifications
- Listen to Kafka events and trigger appropriate messages
- Manage notification templates and user channel preferences

---

## The Tech Stack — Why Each Piece Exists

Every technology in our stack solves a specific problem. Here's what we're using and,
more importantly, **why**.

### TypeScript — JavaScript with a Safety Net

You already know JavaScript. TypeScript is JavaScript with **static types** bolted on. Why
does that matter in microservices? Because when Service A sends a message to Service B,
both sides must agree on the shape of that message. TypeScript catches mismatches at
compile time — before your code ever runs in production.

```typescript
// Without TypeScript: this bug hides until runtime
const booking = { hotelId: 42, checkIn: "2026-03-15" };
console.log(booking.checkin); // undefined — typo, no error

// With TypeScript: caught immediately
interface Booking {
  hotelId: number;
  checkIn: string;
}
const booking: Booking = { hotelId: 42, checkIn: "2026-03-15" };
console.log(booking.checkin); // Compile error: did you mean 'checkIn'?
```

### NestJS — Express with Guardrails

Express is flexible but gives you zero structure. In a microservices project with dozens of
modules, you need conventions. NestJS provides **modules** (organize code), **dependency
injection** (manage service instances), and **decorators** (clean, declarative routing). It
also has first-class support for microservice transports — Kafka, Redis, gRPC — out of
the box.

```typescript
@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  async create(@Body() dto: CreateBookingDto) {
    return this.bookingService.create(dto);
  }
}
```

### MySQL 8.0 — Battle-Tested Relational Storage

We need **ACID transactions** — when you book a hotel, the inventory decrement and the
booking record must succeed or fail together. MySQL 8.0 delivers this reliably. We shard
across **16 MySQL instances** to distribute load. Each shard holds a subset of data (e.g.,
bookings for regions A-D on shard 1, E-H on shard 2).

> **Key Term:** **Sharding** — Splitting a database into smaller pieces (shards), each on its
> own server. This lets you scale horizontally — add more shards as traffic grows instead of
> buying one enormous server.

### Redis Cluster — The In-Memory Swiss Army Knife

Redis stores data in RAM, making it orders of magnitude faster than disk-based databases.
We use it for four distinct purposes:

| Use Case          | Why Redis?                                          |
|-------------------|-----------------------------------------------------|
| **Caching**       | Cache search results so repeated queries skip the DB |
| **Distributed Locks** | Prevent two services from modifying the same inventory simultaneously |
| **Session Storage** | Store user sessions with automatic expiration       |
| **Rate Limiting** | Track request counts per client with TTL-based counters |

### Kafka (KRaft Mode) — The Giant Conveyor Belt

> **Analogy:** Imagine a conveyor belt in a factory. One worker places a box on the belt
> (produces an event), and three different workers downstream each grab a copy to do their
> own thing (consume the event). The belt doesn't care who picks up the box — it just
> keeps moving.

Kafka is our **event streaming platform**. When a booking is created, the Booking Service
publishes a `booking.created` event. The Payment Service picks it up to charge the card.
The Notification Service picks it up to send the email. The Search Service picks it up to
update its index. None of them need to know about each other.

KRaft mode means Kafka manages its own metadata without needing a separate ZooKeeper
cluster — one less system to operate.

### Kubernetes (K8s) — Autopilot for Servers

Kubernetes handles deployment, scaling, and self-healing. If the Search Service crashes at
3 AM, Kubernetes detects the failure and restarts it automatically. If traffic spikes,
Kubernetes spins up more replicas. You describe the desired state ("I want 5 instances of
the Booking Service"), and Kubernetes makes it so.

### Elasticsearch — Google Search for Your Data

MySQL is great for precise lookups ("get booking #12345") but terrible at "find hotels near
Times Square with a pool, sorted by guest rating." Elasticsearch is built for exactly this:
full-text search, fuzzy matching, geo queries, and aggregations — all returning results in
single-digit milliseconds.

---

## Follow a Booking: Click to Confirmation

Let's trace what happens when a user books a hotel room, step by step.

```
1. USER clicks "Book Now" on a hotel in Tokyo for March 15-17.
   Browser sends POST /api/bookings to the API Gateway.

2. API GATEWAY validates the request format and extracts the JWT
   token from the Authorization header.

3. AUTH SERVICE verifies the JWT. Valid? Proceed. Expired? Return 401.

4. BOOKING SERVICE receives the verified request and starts the saga:
   a. Calls INVENTORY SERVICE: "Reserve 1 room, Hotel Tokyo-042,
      March 15-17."
   b. Inventory checks availability, places a temporary hold (TTL: 10
      minutes), returns reservation ID.

5. BOOKING SERVICE calls PAYMENT SERVICE: "Charge $340.00 to card
   ending 4242, reservation REF-98761."
   a. Payment Service contacts Stripe, processes the charge, returns
      transaction ID.

6. BOOKING SERVICE confirms the reservation with INVENTORY SERVICE:
   "Convert temporary hold to confirmed booking."

7. BOOKING SERVICE publishes event to Kafka: booking.confirmed
   {bookingId: "BK-55012", userId: "U-881", hotel: "Tokyo-042", ...}

8. NOTIFICATION SERVICE consumes the event and sends a confirmation
   email with itinerary details.

9. SEARCH SERVICE consumes the event and updates the Elasticsearch
   index (one fewer room available for those dates).

10. USER receives confirmation email and sees "Booking Confirmed" in
    the browser.
```

Total elapsed time for the user: **under 3 seconds**.

---

## Architecture at a Glance

```
                              +-----------------+
         HTTPS                |   API GATEWAY   |
  User ───────────────────────|  (Rate Limit,   |
  Browser                     |   Routing, TLS) |
                              +-------+---------+
                                      |
                    +-----------------+-----------------+
                    |                                   |
              +-----+------+                     +------+-----+
              |   AUTH     |                     |   SEARCH   |
              |  SERVICE   |                     |  SERVICE   |
              +------------+                     +-----+------+
                                                       |
                              +------------+     +-----+------+
                              |  BOOKING   |     | Elastic-   |
                              |  SERVICE   |     | search     |
                              +-----+------+     +------------+
                                    |
                       +------------+------------+
                       |                         |
                 +-----+------+           +------+-----+
                 | INVENTORY  |           |  PAYMENT   |
                 |  SERVICE   |           |  SERVICE   |
                 +-----+------+           +------------+
                       |
                 +-----+------+
                 |  MySQL     |
                 | (16 shards)|
                 +------------+

         ════════════════════════════════════════════
                        KAFKA EVENT BUS
         ════════════════════════════════════════════
                              |
                    +---------+---------+
                    |  NOTIFICATION     |
                    |  SERVICE          |
                    +-------------------+

         ┌────────────────────────────────────────┐
         │          REDIS CLUSTER                 │
         │  (Cache, Locks, Sessions, Rate Limits) │
         └────────────────────────────────────────┘
```

> **Checkpoint:** Can you name each service and its "company role"? Try it without
> scrolling up. If you can name at least five and explain what they do, you've internalized
> the architecture. If not, re-read the "Meet the Team" section — this mental model will
> carry you through every chapter ahead.

---

---

# Chapter 4: System Architecture Overview

## The Full Picture

Now that you've met each service, let's zoom out and see how they all connect. The diagram
below adds the communication paths — which services talk to each other, and how.

```
                         ┌─────────────────────────────────┐
                         │         LOAD BALANCER            │
                         │    (Cloud Provider / Ingress)    │
                         └───────────────┬─────────────────┘
                                         │ HTTPS
                         ┌───────────────┴─────────────────┐
                         │          API GATEWAY             │
                         │  ┌───────────┐ ┌──────────────┐ │
                         │  │Rate Limit │ │  JWT Extract  │ │
                         │  └───────────┘ └──────────────┘ │
                         └──┬──────┬──────┬──────┬─────────┘
                  HTTP      │      │      │      │
          ┌─────────────────┘      │      │      └──────────────┐
          │               HTTP     │      │ HTTP                │
   ┌──────┴──────┐    ┌───────────┴┐  ┌──┴──────────┐  ┌───────┴──────┐
   │    AUTH     │    │  SEARCH    │  │   BOOKING   │  │   USER       │
   │   SERVICE   │    │  SERVICE   │  │   SERVICE   │  │  PROFILE     │
   │ (port 3001) │    │ (port 3002)│  │ (port 3003) │  │ (port 3006)  │
   └─────────────┘    └──────┬─────┘  └──┬─────┬───┘  └──────────────┘
                             │    HTTP    │     │ HTTP
                      ┌──────┴─────┐  ┌──┴─────┴──┐
                      │Elasticsearch│  │ INVENTORY │
                      │  Cluster   │  │  SERVICE  │
                      └────────────┘  │(port 3004)│
                                      └─────┬─────┘
                                             │
              ┌──────────────┐         ┌─────┴──────┐
              │   PAYMENT    │◄── HTTP─┤  MySQL 8.0 │
              │   SERVICE    │         │ (16 shards)│
              │ (port 3005)  │         └────────────┘
              └──────────────┘

    ══════════════════════════════════════════════════════════
         KAFKA CLUSTER (KRaft) ── Event Topics:
         booking.created | booking.confirmed | booking.cancelled
         payment.processed | payment.failed
         inventory.updated | notification.send
    ══════════════════════════════════════════════════════════
          ▲        ▲        ▲         ▲          ▲
          │        │        │         │          │
       Booking  Payment  Search  Inventory  Notification
       Service  Service  Service  Service    Service

    ┌────────────────────────────────────────────────────────┐
    │              REDIS CLUSTER (6 nodes)                   │
    │  Search Cache │ Distributed Locks │ Session Store      │
    └────────────────────────────────────────────────────────┘
```

Notice two distinct communication paths. The **top half** shows HTTP connections — direct,
synchronous calls where one service waits for a response. The **bottom half** shows Kafka —
asynchronous events where services publish and subscribe without waiting.

---

## Service-to-Service Communication

This is one of the most important architectural decisions you'll make. Microservices need
to talk to each other, and there are two fundamentally different ways to do it.

### Synchronous Communication (HTTP) — The Phone Call

> **Analogy:** You pick up the phone, dial your coworker, and wait on the line until they
> answer. You can't do anything else until the conversation is over.

When the Booking Service needs to check inventory, it sends an HTTP request to the
Inventory Service and **waits for the response**. This is synchronous communication.

```typescript
// Booking Service calls Inventory Service synchronously
const response = await this.httpService.axiosRef.post(
  'http://inventory-service:3004/api/inventory/reserve',
  {
    hotelId: 'TOKYO-042',
    checkIn: '2026-03-15',
    checkOut: '2026-03-17',
    rooms: 1,
  },
);

if (response.data.reserved) {
  // proceed to payment
} else {
  throw new BadRequestException('Room no longer available');
}
```

**When to use it:**
- You need an immediate answer before proceeding
- The operation must succeed or fail right now
- The caller's next step depends on the response

**Trade-offs:**
- If the downstream service is slow or down, the caller is stuck waiting
- Creates tight coupling between services
- Cascading failures: if Inventory is down, Booking is effectively down too

### Asynchronous Communication (Kafka) — The Email

> **Analogy:** You send an email to your coworker and immediately move on to your next task.
> They'll read it and act on it when they can. You don't sit staring at your inbox.

When a booking is confirmed, the Booking Service publishes an event to Kafka. The
Notification Service, Search Service, and any future service that cares about bookings
will consume that event on their own time.

```typescript
// Booking Service publishes event asynchronously
await this.kafkaProducer.send({
  topic: 'booking.confirmed',
  messages: [
    {
      key: bookingId,
      value: JSON.stringify({
        bookingId: 'BK-55012',
        userId: 'U-881',
        hotelId: 'TOKYO-042',
        checkIn: '2026-03-15',
        checkOut: '2026-03-17',
        totalAmount: 340.0,
        currency: 'USD',
        confirmedAt: new Date().toISOString(),
      }),
    },
  ],
});

// Booking Service does NOT wait for Notification to finish sending email.
// It moves on immediately.
```

**When to use it:**
- The caller doesn't need a response to continue
- Multiple services need to react to the same event
- You want loose coupling between services
- The downstream work can happen seconds or minutes later

**Trade-offs:**
- Eventual consistency: the email might arrive 5 seconds after the booking
- Harder to debug (the event hops between systems)
- You need to handle the case where a consumer fails and retries

### Decision Matrix: Sync vs. Async

| Scenario                                        | Use         | Why                                    |
|-------------------------------------------------|-------------|----------------------------------------|
| Check room availability before booking          | **Sync**    | Need answer now to proceed or reject   |
| Charge a credit card                            | **Sync**    | Must confirm payment succeeded         |
| Send confirmation email                         | **Async**   | User doesn't wait for the email        |
| Update search index after booking               | **Async**   | Can happen seconds later               |
| Verify JWT token                                | **Sync**    | Can't proceed without auth result      |
| Notify partner hotel of new reservation         | **Async**   | Partner system might be slow           |
| Get user profile for personalization            | **Sync**    | Need data to render the response       |
| Log booking analytics                           | **Async**   | Analytics is non-blocking              |

> **Real-World Scenario:** A major airline once used synchronous HTTP calls for everything —
> including sending booking confirmation emails. During a flash sale, the email provider
> slowed down under load. Because the email call was synchronous, the entire booking pipeline
> backed up. Users saw spinning loaders for 30+ seconds. Moving email notifications to an
> async Kafka event solved the problem overnight.

---

## Kubernetes Service Discovery

In a monolith, calling another function is trivial — it's in the same process. In
microservices, your services run on different machines (or containers) with IP addresses
that change constantly. How does the Booking Service find the Inventory Service?

> **Analogy:** Instead of memorizing every coworker's personal phone number (which changes
> when they get a new phone), you call the company directory and ask for "Inventory
> Department." The directory always knows the current number. That's Kubernetes DNS.

### How It Works

When you deploy a service to Kubernetes, K8s automatically creates a **DNS entry** for it.
Every service gets a stable hostname that follows this pattern:

```
<service-name>.<namespace>.svc.cluster.local
```

For our booking platform:

```
auth-service.production.svc.cluster.local:3001
search-service.production.svc.cluster.local:3002
booking-service.production.svc.cluster.local:3003
inventory-service.production.svc.cluster.local:3004
payment-service.production.svc.cluster.local:3005
notification-service.production.svc.cluster.local:3006
```

Within the same namespace, you can use the short form:

```typescript
// Full DNS name (cross-namespace)
const url = 'http://inventory-service.production.svc.cluster.local:3004';

// Short form (same namespace — this is what you'll usually use)
const url = 'http://inventory-service:3004';
```

Kubernetes handles load balancing too. If you have 5 replicas of the Inventory Service,
K8s distributes requests across all 5 automatically.

### Common Mistake: Hardcoded Service Endpoints

```typescript
// BAD: Hardcoded IP address. If the pod restarts, this IP is gone.
const INVENTORY_URL = 'http://10.244.3.17:3004';

// BAD: Environment-specific URL baked into code
const INVENTORY_URL = 'http://192.168.1.100:3004';

// GOOD: Kubernetes DNS name. Always resolves to the current pods.
const INVENTORY_URL = 'http://inventory-service:3004';

// BETTER: Configurable via environment variables
const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL
  || 'http://inventory-service:3004';
```

> **What If You Skip This?** Hardcoded IPs work on your laptop. The moment Kubernetes
> reschedules a pod to a different node (which happens routinely — during scaling, updates,
> node failures), your hardcoded IP points to nothing. Your service throws connection errors
> at 2 AM, and you get paged. Use DNS names. Always.

---

## The Request Lifecycle: Step by Step

Let's trace a complete booking request through the system with more technical detail than
Chapter 3's overview. Every arrow is a real network call.

```
Step 1  Browser ──── POST /api/bookings ────► API Gateway (:443)
        Headers: { Authorization: "Bearer eyJhbG..." }
        Body: { hotelId: "TOKYO-042", checkIn: "2026-03-15",
                checkOut: "2026-03-17", guests: 2 }

Step 2  API Gateway ── GET /auth/verify ────► Auth Service (:3001)
        Sends the JWT for validation.
        Auth returns: { valid: true, userId: "U-881", role: "customer" }

Step 3  API Gateway ── POST /bookings ──────► Booking Service (:3003)
        Forwards the original request + verified user context.

Step 4  Booking Service ── POST /reserve ───► Inventory Service (:3004)
        Inventory checks MySQL shard for TOKYO-042, March 15-17.
        Acquires a Redis distributed lock on that room.
        Decrements available count. Returns: { reservationId: "RES-4421" }

Step 5  Booking Service ── POST /charge ────► Payment Service (:3005)
        Sends: { amount: 340.00, currency: "USD", card: "tok_visa_4242" }
        Payment calls Stripe API. Returns: { transactionId: "TXN-8890" }

Step 6  Booking Service writes to MySQL:
        INSERT INTO bookings (id, user_id, hotel_id, status, ...)
        VALUES ('BK-55012', 'U-881', 'TOKYO-042', 'CONFIRMED', ...)

Step 7  Booking Service ── publish ─────────► Kafka topic: booking.confirmed

Step 8  Notification Service ◄── consume ─── Kafka topic: booking.confirmed
        Sends confirmation email via SendGrid.

Step 9  Search Service ◄── consume ─────────  Kafka topic: booking.confirmed
        Updates Elasticsearch: decrement available rooms for those dates.

Step 10 API Gateway returns to browser:
        { status: "confirmed", bookingId: "BK-55012",
          confirmationCode: "GBK-TOKYO-55012" }
```

**Key observations:**
- Steps 2-6 are **synchronous** — each must succeed before the next begins
- Steps 7-9 are **asynchronous** — Booking Service doesn't wait for email or index updates
- If Step 5 (payment) fails, the Booking Service triggers a **compensating transaction**:
  it calls Inventory Service to release the reservation from Step 4

---

## NestJS Module Structure

NestJS organizes code into **modules**, each encapsulating a feature. Here's what the
Booking Service looks like internally:

```
booking-service/
├── src/
│   ├── app.module.ts              # Root module — imports all feature modules
│   ├── main.ts                    # Entry point — bootstraps the NestJS app
│   │
│   ├── booking/
│   │   ├── booking.module.ts      # Declares this feature's pieces
│   │   ├── booking.controller.ts  # HTTP endpoints (POST /bookings, etc.)
│   │   ├── booking.service.ts     # Business logic (orchestrates the saga)
│   │   ├── booking.entity.ts      # TypeORM entity (maps to MySQL table)
│   │   └── dto/
│   │       ├── create-booking.dto.ts   # Input validation shape
│   │       └── booking-response.dto.ts # Output shape
│   │
│   ├── kafka/
│   │   ├── kafka.module.ts        # Kafka producer/consumer config
│   │   └── kafka.service.ts       # Publish events to topics
│   │
│   └── health/
│       ├── health.module.ts       # Kubernetes liveness/readiness probes
│       └── health.controller.ts   # GET /health → { status: "ok" }
```

Here's a simplified `booking.module.ts` to show how NestJS wires things together:

```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { Booking } from './booking.entity';
import { KafkaModule } from '../kafka/kafka.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking]),  // Register the Booking entity
    HttpModule,                           // For sync calls to other services
    KafkaModule,                          // For async event publishing
  ],
  controllers: [BookingController],       // Handle incoming HTTP requests
  providers: [BookingService],            // Business logic, injectable
})
export class BookingModule {}
```

> **Key Term:** **Dependency Injection (DI)** — Instead of a class creating its own
> dependencies (`new BookingService()`), NestJS creates them and passes them in
> automatically. This makes testing easy — you can swap real services for mocks without
> changing the business logic code.

Each microservice in our platform follows this same structure. The Search Service has a
`search.module.ts`, the Payment Service has a `payment.module.ts`, and so on. The pattern
is identical; only the business logic inside changes.

---

## Putting It All Together

By now you should have a clear mental map of the system:

1. **Seven services**, each with a single responsibility
2. **Two communication styles**: synchronous HTTP for "I need an answer now" and
   asynchronous Kafka events for "someone should handle this eventually"
3. **Kubernetes DNS** for service discovery — no hardcoded addresses
4. **NestJS modules** as the organizational unit inside each service
5. **MySQL shards** for durable storage, **Redis** for speed, **Elasticsearch** for search,
   **Kafka** for event streaming

> **Checkpoint:** Can you explain the difference between synchronous and asynchronous service
> communication? When would you choose each? Try answering with a concrete example from our
> booking system — for instance, why is payment synchronous but email notification is
> asynchronous? If you can articulate this clearly, you understand the architectural
> foundation we'll build on for the rest of this book.

In Chapter 5, we'll stop talking and start coding. You'll set up your local development
environment, scaffold your first NestJS microservice, and send your first Kafka event.
