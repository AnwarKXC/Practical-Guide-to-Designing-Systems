# Chapter 16: Idempotency — Making Requests Safe to Retry

## The Word That Saves Millions of Dollars

If someone dropped the word "idempotent" in a meeting, you might nod politely and Google it later. Let us save you the search — and then go far deeper than any search result will take you.

> **Key Term:** **Idempotent** — An operation where doing it once and doing it multiple times produces the **exact same result**. The second, third, and hundredth execution have no additional effect beyond what the first one did.

That is the textbook definition. Here is the mathematical one.

### The Math Behind Idempotency

In mathematics, a function `f` is idempotent if applying it more than once gives the same result as applying it once:

```
f(f(x)) = f(x)
```

Let us make that concrete. Consider the function `abs()` (absolute value):

```
abs(-5) = 5
abs(abs(-5)) = abs(5) = 5
abs(abs(abs(-5))) = abs(abs(5)) = abs(5) = 5
```

No matter how many times you apply `abs()`, after the first application, the result never changes. That is idempotency.

Now consider the function `increment()`:

```
increment(5) = 6
increment(increment(5)) = increment(6) = 7
increment(increment(increment(5))) = increment(7) = 8
```

Each application changes the result. This is **not** idempotent.

In our Global Booking System, the function is an API endpoint and x is the state of the system (the database):

```
// Idempotent: GET /api/bookings/123
state_after_1_call  = GET(database)   → { booking: BK-123, status: "confirmed" }
state_after_2_calls = GET(database)   → { booking: BK-123, status: "confirmed" }
// f(f(x)) = f(x) ✓

// NOT Idempotent: POST /api/bookings (without idempotency key)
state_after_1_call  = POST(database)  → database now has 1 booking
state_after_2_calls = POST(database)  → database now has 2 bookings
// f(f(x)) ≠ f(x) ✗
```

The mathematical property is not just academic. It tells us something precise: **an idempotent API endpoint must be a function whose effect on system state converges after the first successful execution.** Every subsequent call with the same inputs is a no-op with respect to state, though it still returns the same response.

> **Analogy:** Think about pressing an elevator button. You press "5" and it lights up. The elevator is going to the fifth floor. Now you press "5" again, and again, and five more times for good measure. Does the elevator go to the fifth floor eight times? No. It goes once. The button press is **idempotent** — pressing it multiple times has the same effect as pressing it once. Now think about a vending machine. You insert a dollar and press "Cola." You get a cola. You insert another dollar and press "Cola." You get another cola. The vending machine is **not** idempotent — repeating the action produces additional effects.

---

## Why Networks Are Unreliable (And Why That Makes Idempotency Non-Negotiable)

In a monolith running on one server, you call a function and it either succeeds or throws an error. Simple. But in a distributed system, requests travel across networks, and networks are unreliable in ways you might not have encountered.

### TCP Guarantees vs. Application-Level Guarantees

Here is a misconception that trips up many developers: "We use TCP, and TCP guarantees delivery, so our requests are safe." Let us unpack why this is dangerously wrong.

TCP (Transmission Control Protocol) does guarantee that bytes sent from one end arrive at the other end, in order, without corruption. It does this through acknowledgments, retransmissions, and sequence numbers. But here is what TCP does **not** guarantee:

| TCP Guarantees | TCP Does NOT Guarantee |
|---|---|
| Bytes arrive in order | That the connection stays open |
| Bytes are not corrupted | That a response arrives before the client times out |
| Lost packets are retransmitted | That the server finished processing before the connection drops |
| Duplicate packets are filtered out | That both sides agree on whether a request "completed" |

The critical gap is this: **TCP operates at the transport layer. Your business logic operates at the application layer.** TCP can successfully deliver your HTTP request to the server, the server can successfully process it (charge the credit card, create the booking, publish the event), and then the TCP connection can die before the HTTP response reaches the client.

From TCP's perspective, packets were delivered. From your application's perspective, the request "failed" because the client never got a response. This is the **ambiguous failure** — the most dangerous kind:

```
Three possible outcomes of a network request:
┌─────────────────────────────────────────────────────────────────┐
│ 1. SUCCESS:  Request arrived, server processed, response       │
│              arrived. Client knows it succeeded. ✓              │
│                                                                 │
│ 2. FAILURE:  Request never arrived (DNS failure, server down).  │
│              Client knows it failed. Can safely retry. ✓        │
│                                                                 │
│ 3. AMBIGUOUS: Request arrived, server processed, response LOST. │
│               Client does not know if it succeeded or failed.   │
│               Retrying might create a duplicate. ✗              │
│                                                                 │
│               This is the scenario idempotency solves.          │
└─────────────────────────────────────────────────────────────────┘
```

### Eight Ways a Request Can "Fail" After Succeeding

In our Global Booking System handling 100,000 bookings per minute, each of these happens multiple times per hour:

1. **Client timeout.** The server takes 3 seconds to process. The client's timeout is 2 seconds. The client gives up and shows an error. The server finishes and commits. The booking exists, but the client does not know.

2. **Load balancer cuts the connection.** AWS ALB has a default idle timeout of 60 seconds. If your request takes longer (maybe it is waiting for a third-party API), the ALB terminates the connection. The server keeps processing.

3. **TCP RST (reset).** A network device between client and server (a firewall, a NAT gateway, a proxy) decides the connection has been idle too long and sends a RST packet. The server has already committed.

4. **Server crashes after commit, before response.** The database transaction commits at timestamp T. The server process crashes at T+1ms (out of memory, segfault, OOM killer). The response is never sent.

5. **Kubernetes pod eviction.** Kubernetes decides to reschedule your pod to a different node. It sends SIGTERM. Your graceful shutdown handler tries to finish in-flight requests, but the 30-second grace period expires. The booking was committed 28 seconds ago. The response never arrives.

6. **DNS resolution failure on response path.** The request arrived via a working DNS resolution, but the response path involves a different DNS lookup (for a callback URL, perhaps) that fails.

7. **Mobile network handoff.** The user is on a train. Their phone switches from one cell tower to another mid-request. The TCP connection drops. The server does not know and finishes processing.

8. **CDN or reverse proxy timeout.** Cloudflare, Nginx, or your API gateway has its own timeout. It returns 504 to the client while the upstream server is still happily processing.

> **What If You Skip This?** Without idempotency, any of these eight scenarios — and they all happen in production, regularly — creates duplicate work. For a booking system, "duplicate work" means double charges, double bookings, or double inventory reservations. During a high-traffic flash sale with 100,000 requests per minute, even a 0.1% ambiguous failure rate means 100 potential duplicates every minute. Over a 2-hour sale, that is 12,000 customers with duplicate charges.

### The Scenario That Will Keep You Up at Night

Here is a concrete walkthrough of scenario #1 in our booking system:

```
User clicks "Pay Now" to complete a $340 hotel booking.

1. Browser sends POST /api/payments to your API Gateway.

2. API Gateway forwards to Payment Service.

3. Payment Service calls Stripe. Stripe charges the credit card.
   $340 is deducted from the user's card.

4. Payment Service starts to send the response back...

5. NETWORK BLIP. The response is lost in transit.
   The TCP connection drops. The browser gets a timeout error.

6. The user sees: "Something went wrong. Please try again."

7. The user clicks "Pay Now" again. (What else would they do?)

8. POST /api/payments is sent again. Payment Service calls Stripe again.
   Stripe charges the card again. Another $340 is deducted.

9. The user is charged $680 for a $340 booking.
```

The payment **succeeded** the first time. But the response never reached the client. From the user's perspective, it failed. So they retried — which is **exactly what you would tell them to do**. And they got double-charged.

This is not a contrived edge case. This happens in production. Every payment processor, every API that handles money, every system where a duplicate operation has real consequences must deal with this.

And it is not just users double-clicking. Many HTTP client libraries (Axios, got, fetch wrappers) automatically retry failed requests. Kubernetes' service mesh (Istio, Linkerd) automatically retries failed inter-service calls. AWS SDK automatically retries failed API calls with exponential backoff. Your system is retrying requests **without you even knowing it**.

---

## The Fix: Idempotency Keys

The idea is simple but powerful: every request carries a unique identifier called an **idempotency key**. Before processing the request, we check: "Have I already processed a request with this key?" If yes, we return the original result without doing the work again. If no, we process the request and store the result, keyed by the idempotency key.

```
Without Idempotency Key:
  Request 1: POST /api/bookings { hotel: "TOKYO-042" } → Creates booking BK-001
  Request 2: POST /api/bookings { hotel: "TOKYO-042" } → Creates booking BK-002  ← DUPLICATE!
  (Server sees two independent requests. No way to know they are the same.)

With Idempotency Key:
  Request 1: POST /api/bookings { hotel: "TOKYO-042" }
             Header: Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
             → Creates booking BK-001, stores result under key 550e8400...

  Request 2: POST /api/bookings { hotel: "TOKYO-042" }
             Header: Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
             → Finds cached result for key 550e8400... → Returns BK-001 (no work done)
```

> **Key Term:** **Idempotency key** — A unique string (usually a UUID v4 or a deterministic hash) sent with a request that allows the server to identify duplicate requests. The server stores the result of the first request and returns it for any subsequent request with the same key.

Think of it as giving the server a memory. Without an idempotency key, every POST request looks brand new to the server — it has no way to know it already processed an identical request 5 seconds ago. With an idempotency key, the server can say: "I've seen key `550e8400...` before. Last time, I created booking BK-001 and charged $340. Here is that same result. I will not do any of the work again."

---

## Idempotency Key Design: Getting It Right

Not all idempotency keys are created equal. The design of your key determines how robust your idempotency implementation is. Let us go deep.

### Option 1: Client-Generated UUID v4 (The Gold Standard)

```typescript
// Client-side: generate a UUID v4 for each user action
const idempotencyKey = crypto.randomUUID();
// Result: "550e8400-e29b-41d4-a716-446655440000"

// This key is generated ONCE per user action (button click).
// If the request fails and is retried, the SAME key is sent again.
```

**Why UUID v4?**
- **Universally unique**: 122 bits of randomness = 2^122 possible values. The probability of two clients generating the same UUID is about 1 in 5.3 x 10^36. You would need to generate 1 billion UUIDs per second for 85 years to have a 50% chance of a collision.
- **No coordination required**: The client generates it locally. No need to call the server for a key. No need for a centralized key-generation service.
- **Stateless**: The server does not need to know anything about the client's key generation strategy.

**Why client-generated?**
The client generates the key **before** making the request. This is critical because:

```
WRONG approach: Server generates the key
1. Client sends POST /api/bookings (no key)
2. Server generates key K1, processes, returns { key: K1, booking: BK-001 }
3. Response is lost in transit.
4. Client retries POST /api/bookings (no key — it never received K1)
5. Server generates key K2 (different!), processes → DUPLICATE BOOKING

RIGHT approach: Client generates the key
1. Client generates key K1
2. Client sends POST /api/bookings with Idempotency-Key: K1
3. Server processes, stores result under K1, returns { booking: BK-001 }
4. Response is lost in transit.
5. Client retries POST /api/bookings with Idempotency-Key: K1 (same key!)
6. Server finds cached result for K1 → Returns BK-001 (no duplicate)
```

### Option 2: Deterministic Keys From Request Parameters

When the client cannot generate a key (legacy systems, webhooks from third parties), we generate one server-side from the request parameters:

```typescript
import { createHash } from 'crypto';

/**
 * Generate a deterministic key from booking parameters.
 * Same user + same resource + same dates + same minute = same key.
 *
 * Why include the timestamp rounded to the minute?
 * Because a user might legitimately book the same room for the same dates
 * twice — once in January (then cancel) and again in March. The timestamp
 * ensures those are treated as separate requests.
 */
function generateDeterministicKey(dto: CreateBookingDto): string {
  const payload = {
    userId: dto.userId,
    resourceId: dto.resourceId,
    checkIn: dto.checkIn?.toISOString(),
    checkOut: dto.checkOut?.toISOString(),
    timestamp: Math.floor(Date.now() / 60000), // Current minute
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .substring(0, 32);
}
```

Why SHA-256? Because we need a function that always returns the same output for the same input (deterministic), produces a fixed-length string (fits in a database column), and has practically zero chance of two different inputs producing the same output (collision-resistant).

The `Math.floor(Date.now() / 60000)` rounds the timestamp to the current minute. This means if a user submits the same booking twice within the same minute (a double-click, a retry, a browser auto-retry), they get the same idempotency key. But if they come back an hour later and submit the same parameters, they get a different key — because it is a genuinely new intent.

### Server-Side Validation of Idempotency Keys

The server must validate incoming keys. Never trust client input blindly:

```typescript
function validateIdempotencyKey(key: string): void {
  // Must be present for mutating operations
  if (!key) {
    throw new BadRequestException(
      'Idempotency-Key header is required for POST requests'
    );
  }

  // Must be a valid UUID v4 format
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(key)) {
    throw new BadRequestException(
      'Idempotency-Key must be a valid UUID v4'
    );
  }

  // Must not be reused with different request bodies
  // (We check this later when we compare stored vs incoming request)
}
```

> **What If You Skip This?** Without key validation, clients can send empty strings, sequential integers (1, 2, 3...), or reuse the same key for different operations — all of which break your idempotency guarantees. A key like "1" will collide with every other client who also uses "1". A key reused across different operations will return stale cached responses for unrelated requests.

---

## Idempotency for Different HTTP Methods

Not all HTTP methods need idempotency keys. The HTTP specification itself defines which methods are idempotent:

| Method | Naturally Idempotent? | Needs Idempotency Key? | Explanation |
|--------|----------------------|----------------------|-------------|
| `GET` | Yes | No | Read-only. Same request always returns current state. No side effects. |
| `HEAD` | Yes | No | Like GET but returns only headers. No side effects. |
| `OPTIONS` | Yes | No | Returns allowed methods. No side effects. |
| `PUT` | Yes | No | "Set this resource to this state." Repeating sets it to the same state. |
| `DELETE` | Yes | No | "Remove this resource." First call removes it. Second call: already gone. Same result. |
| `POST` | **No** | **Yes** | "Create something new." Each call creates a new resource. |
| `PATCH` | **It depends** | **Sometimes** | "Modify part of a resource." Depends on the operation. |

Let us explore the nuances.

### GET: Always Idempotent (By Definition)

```typescript
// GET never changes server state. Calling it 100 times is always safe.
@Get('/bookings/:id')
async getBooking(@Param('id') id: string): Promise<Booking> {
  return this.bookingService.findById(id);
}
// 100 calls = 100 identical responses. Zero state changes.
```

### PUT: Idempotent By Design

PUT means "replace the entire resource with this representation." It is idempotent because setting something to a value 10 times leaves it at that value:

```typescript
// PUT replaces the entire resource. Repeating is safe.
@Put('/bookings/:id')
async updateBooking(
  @Param('id') id: string,
  @Body() dto: UpdateBookingDto,
): Promise<Booking> {
  // This sets the booking to exactly this state.
  // Doing it twice sets it to the same state twice = same result.
  return this.bookingService.replaceBooking(id, dto);
}
// Math: PUT(PUT(state, data), data) = PUT(state, data) ✓
```

### DELETE: Idempotent (But Watch for 404s)

```typescript
// DELETE is idempotent in terms of server state.
@Delete('/bookings/:id')
async deleteBooking(@Param('id') id: string): Promise<void> {
  const booking = await this.bookingService.findById(id);

  if (!booking) {
    // The resource is already gone. Return 204 (or 404, see below).
    // Either way, the server state is the same: the booking does not exist.
    return; // 204 No Content
  }

  await this.bookingService.delete(id);
  // First call: booking deleted. Second call: booking already gone.
  // Server state after both: booking does not exist. ✓
}
```

**The 404 debate**: Should the second DELETE return 204 (No Content) or 404 (Not Found)? Technically, both are valid. Returning 204 is "more idempotent" because the response is the same every time. Returning 404 is "more RESTful" because the resource genuinely does not exist. In our system, we return 204 for deletes to keep clients simple — they do not need to handle two different success codes.

### POST: Not Idempotent (Without Our Help)

POST is the problem child. Each call is meant to create something new:

```typescript
// POST without idempotency key: DANGEROUS
@Post('/bookings')
async createBooking(@Body() dto: CreateBookingDto): Promise<Booking> {
  // Every call creates a new booking. 3 calls = 3 bookings. Bad.
  return this.bookingService.create(dto);
}

// POST with idempotency key: SAFE
@Post('/bookings')
@UseGuards(IdempotencyGuard) // ← We will build this next
async createBooking(
  @Body() dto: CreateBookingDto,
  @Headers('Idempotency-Key') idempotencyKey: string,
): Promise<Booking> {
  // First call creates the booking. Retries return the cached result.
  return this.bookingService.create(dto, idempotencyKey);
}
```

### PATCH: It Depends on the Operation

PATCH is the tricky one. It can be idempotent or not, depending on what it does:

```typescript
// IDEMPOTENT PATCH: "Set status to confirmed"
// Doing this twice leaves status as "confirmed". Safe.
@Patch('/bookings/:id')
async confirmBooking(@Param('id') id: string): Promise<Booking> {
  return this.bookingService.updateStatus(id, 'confirmed');
}

// NOT IDEMPOTENT PATCH: "Add $50 surcharge"
// Doing this twice adds $100. Not safe — needs idempotency key.
@Patch('/bookings/:id/surcharge')
@UseGuards(IdempotencyGuard)
async addSurcharge(
  @Param('id') id: string,
  @Body() dto: { amount: number },
  @Headers('Idempotency-Key') idempotencyKey: string,
): Promise<Booking> {
  return this.bookingService.addSurcharge(id, dto.amount, idempotencyKey);
}
```

The rule of thumb: **if the operation is additive (adds to a total, appends to a list, increments a counter), it needs an idempotency key. If it is absolute (sets a value, replaces a state), it is naturally idempotent.**

---

## Case Study: How Stripe Implements Idempotency

Before we build our own implementation, let us study the best in the industry. Stripe processes billions of dollars in payments and has one of the most battle-tested idempotency systems in existence. Their approach has become the de facto standard.

### Stripe's API Contract

```bash
# Stripe requires an Idempotency-Key header for all POST requests
curl https://api.stripe.com/v1/charges \
  -u sk_test_xyz: \
  -H "Idempotency-Key: KG5LxwFBepaKHyud" \
  -d amount=2000 \
  -d currency=usd \
  -d source=tok_visa

# If the request fails and you retry with the SAME key:
# → Stripe returns the original charge, not a new one.
# → The credit card is charged exactly once.
```

### What Stripe Does Under the Hood

Stripe's idempotency implementation has several key design decisions we should learn from:

**1. Keys are scoped to the API key.** If two different merchants happen to use the same idempotency key, they do not collide. The key is always paired with the authenticated account.

**2. Keys expire after 24 hours.** Stripe stores idempotency results for 24 hours. After that, the same key can be reused. This balances memory usage against the retry window.

**3. Request body must match.** If you send key `abc-123` with `amount=2000`, and then send key `abc-123` with `amount=3000`, Stripe returns a `400` error. Reusing a key with a different request body is treated as a bug in the client, not a legitimate retry.

**4. Stripe tracks request lifecycle.** This is the most sophisticated part. Stripe does not just cache the final response — it tracks the state of the request through its lifecycle:

```
Idempotency Key Lifecycle (Stripe's model):
┌──────────┐     ┌────────────┐     ┌───────────┐
│ CREATED  │────→│ PROCESSING │────→│ COMPLETED │
│ (locked) │     │  (locked)  │     │ (cached)  │
└──────────┘     └────────────┘     └───────────┘
                       │
                       ├────→ ┌──────────┐
                       │      │  FAILED  │
                       │      │ (retry   │
                       └────→ │ allowed) │
                              └──────────┘
```

**5. In-flight request detection.** If a retry arrives while the original request is still processing, Stripe returns `409 Conflict` with a message like "A request with this idempotency key is already being processed." This prevents race conditions — we will build this ourselves shortly.

### What We Will Borrow From Stripe

Our implementation will adopt these patterns:
- Client-generated keys scoped to the user/tenant
- 24-hour TTL with configurable override
- Request body fingerprinting to detect misuse
- In-flight request locking to handle concurrent duplicates
- Full lifecycle tracking (created → processing → completed/failed)

---

## Database Schema: The idempotency_keys Table

Before we build the middleware, we need somewhere to store idempotency records. Let us define both the raw SQL and the Prisma schema.

### Raw SQL: CREATE TABLE

```sql
-- ============================================
-- Idempotency Keys Table
-- Stores the result of every idempotent request
-- so that retries return the same response.
-- ============================================
CREATE TABLE idempotency_keys (
    id              BIGINT          PRIMARY KEY AUTO_INCREMENT,

    -- The idempotency key itself (UUID v4 from the client)
    idempotency_key VARCHAR(255)    NOT NULL,

    -- Scope the key to a specific user/tenant to avoid collisions
    user_id         BIGINT          NOT NULL,

    -- The HTTP method and path (e.g., "POST /api/bookings")
    -- Used to ensure a key is not reused across different endpoints
    request_method  VARCHAR(10)     NOT NULL,
    request_path    VARCHAR(500)    NOT NULL,

    -- SHA-256 hash of the request body
    -- Used to detect when a client reuses a key with different parameters
    request_hash    VARCHAR(64)     NOT NULL,

    -- Lifecycle state: 'processing', 'completed', 'failed'
    status          ENUM('processing', 'completed', 'failed')
                    NOT NULL DEFAULT 'processing',

    -- The cached response (stored as JSON)
    response_code   INT             NULL,
    response_body   JSON            NULL,

    -- Timestamps for lifecycle tracking and TTL enforcement
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    TIMESTAMP       NULL,
    expires_at      TIMESTAMP       NOT NULL,

    -- The resource that was created (if any)
    -- e.g., aggregate_type = 'booking', aggregate_id = 'BK-55012'
    aggregate_type  VARCHAR(100)    NULL,
    aggregate_id    VARCHAR(100)    NULL,

    -- Unique constraint: one key per user per endpoint
    UNIQUE KEY uk_idempotency (user_id, idempotency_key),

    -- Index for TTL cleanup (find expired records efficiently)
    INDEX idx_expires_at (expires_at),

    -- Index for looking up by aggregate (find idempotency record for a booking)
    INDEX idx_aggregate (aggregate_type, aggregate_id),

    -- Foreign key to users table
    CONSTRAINT fk_idempotency_user
        FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ============================================
-- Automatic cleanup of expired idempotency keys
-- Run this as a scheduled event (every hour)
-- ============================================
CREATE EVENT IF NOT EXISTS cleanup_expired_idempotency_keys
ON SCHEDULE EVERY 1 HOUR
DO
  DELETE FROM idempotency_keys
  WHERE expires_at < NOW()
  AND status != 'processing';  -- Never delete keys for in-flight requests
```

### Prisma Schema

```prisma
// schema.prisma

model IdempotencyKey {
  id              BigInt   @id @default(autoincrement())

  // The idempotency key itself (UUID v4)
  idempotencyKey  String   @map("idempotency_key") @db.VarChar(255)

  // Scoped to a user/tenant
  userId          BigInt   @map("user_id")
  user            User     @relation(fields: [userId], references: [id])

  // Request metadata
  requestMethod   String   @map("request_method") @db.VarChar(10)
  requestPath     String   @map("request_path") @db.VarChar(500)
  requestHash     String   @map("request_hash") @db.VarChar(64)

  // Lifecycle state
  status          IdempotencyStatus @default(processing)

  // Cached response
  responseCode    Int?     @map("response_code")
  responseBody    Json?    @map("response_body")

  // Timestamps
  createdAt       DateTime @default(now()) @map("created_at")
  completedAt     DateTime? @map("completed_at")
  expiresAt       DateTime @map("expires_at")

  // The resource created by this request
  aggregateType   String?  @map("aggregate_type") @db.VarChar(100)
  aggregateId     String?  @map("aggregate_id") @db.VarChar(100)

  @@unique([userId, idempotencyKey], name: "uk_idempotency")
  @@index([expiresAt], name: "idx_expires_at")
  @@index([aggregateType, aggregateId], name: "idx_aggregate")
  @@map("idempotency_keys")
}

enum IdempotencyStatus {
  processing
  completed
  failed

  @@map("idempotency_status")
}
```

### Prisma Client Usage

```typescript
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

// ============================================
// Create an idempotency record (start of request processing)
// ============================================
async function createIdempotencyRecord(
  userId: bigint,
  idempotencyKey: string,
  method: string,
  path: string,
  requestBody: object,
): Promise<IdempotencyKey | 'duplicate'> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify(requestBody))
    .digest('hex');

  try {
    const record = await prisma.idempotencyKey.create({
      data: {
        idempotencyKey,
        userId,
        requestMethod: method,
        requestPath: path,
        requestHash,
        status: 'processing',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      },
    });
    return record;
  } catch (error) {
    // Unique constraint violation = duplicate key
    if (error.code === 'P2002') {
      return 'duplicate';
    }
    throw error;
  }
}

// ============================================
// Look up an existing idempotency record
// ============================================
async function findIdempotencyRecord(
  userId: bigint,
  idempotencyKey: string,
) {
  return prisma.idempotencyKey.findUnique({
    where: {
      uk_idempotency: { userId, idempotencyKey },
    },
  });
}

// ============================================
// Complete an idempotency record (store the response)
// ============================================
async function completeIdempotencyRecord(
  id: bigint,
  responseCode: number,
  responseBody: object,
  aggregateType?: string,
  aggregateId?: string,
) {
  return prisma.idempotencyKey.update({
    where: { id },
    data: {
      status: 'completed',
      responseCode,
      responseBody: responseBody as any,
      completedAt: new Date(),
      aggregateType,
      aggregateId,
    },
  });
}

// ============================================
// Mark as failed (allows retry with same key)
// ============================================
async function failIdempotencyRecord(id: bigint) {
  return prisma.idempotencyKey.update({
    where: { id },
    data: {
      status: 'failed',
      completedAt: new Date(),
    },
  });
}

// ============================================
// Cleanup expired records (called by cron job)
// ============================================
async function cleanupExpiredRecords(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
      status: { not: 'processing' },
    },
  });
  return result.count;
}
```

> **Checkpoint:** Look at the `createIdempotencyRecord` function above. Why do we catch `P2002` (Prisma's unique constraint violation code) and return `'duplicate'` instead of throwing? Think about what happens when two identical requests arrive at the same time — both try to INSERT, one succeeds, one gets the constraint violation. Catching this error is how we handle the race condition at the database level.

---

## Database-Level Idempotency: The Bookings Table

Beyond the dedicated `idempotency_keys` table, we also want idempotency built directly into our business tables. Here is the bookings table with its idempotency column:

### Raw SQL

```sql
-- The bookings table with built-in idempotency
CREATE TABLE bookings (
    id                  BIGINT          PRIMARY KEY AUTO_INCREMENT,
    user_id             BIGINT          NOT NULL,
    booking_type        ENUM('hotel', 'flight', 'car_rental', 'experience')
                        NOT NULL,
    reference_code      VARCHAR(20)     NOT NULL,

    -- This column enables database-level idempotency
    idempotency_key     VARCHAR(64)     NOT NULL,

    subtotal            DECIMAL(12,2)   NOT NULL,
    tax_amount          DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    discount_amount     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
    total_amount        DECIMAL(12,2)   NOT NULL,
    currency            CHAR(3)         NOT NULL DEFAULT 'USD',
    status              ENUM('pending','confirmed','cancelled','completed','failed')
                        NOT NULL DEFAULT 'pending',
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

    -- UNIQUE constraint on idempotency_key prevents duplicate bookings
    -- even if the application-level check has a race condition
    UNIQUE KEY uk_booking_idempotency (idempotency_key),

    CONSTRAINT fk_booking_user
        FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### Prisma Schema

```prisma
model Booking {
  id              BigInt        @id @default(autoincrement())
  userId          BigInt        @map("user_id")
  user            User          @relation(fields: [userId], references: [id])
  bookingType     BookingType   @map("booking_type")
  referenceCode   String        @map("reference_code") @db.VarChar(20)

  // Database-level idempotency
  idempotencyKey  String        @unique @map("idempotency_key") @db.VarChar(64)

  subtotal        Decimal       @db.Decimal(12, 2)
  taxAmount       Decimal       @default(0.00) @map("tax_amount") @db.Decimal(12, 2)
  discountAmount  Decimal       @default(0.00) @map("discount_amount") @db.Decimal(12, 2)
  totalAmount     Decimal       @map("total_amount") @db.Decimal(12, 2)
  currency        String        @default("USD") @db.Char(3)
  status          BookingStatus @default(pending)
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")

  // Relations
  hotelBooking    HotelBooking?
  flightBooking   FlightBooking?
  payments        Payment[]
  outboxEvents    OutboxEvent[]

  @@map("bookings")
}

enum BookingType {
  hotel
  flight
  car_rental
  experience

  @@map("booking_type")
}

enum BookingStatus {
  pending
  confirmed
  cancelled
  completed
  failed

  @@map("booking_status")
}
```

### Prisma Client: Creating an Idempotent Booking

```typescript
async function createBookingIdempotent(
  dto: CreateBookingDto,
  idempotencyKey: string,
): Promise<Booking> {

  // Step 1: Check if a booking with this key already exists
  const existing = await prisma.booking.findUnique({
    where: { idempotencyKey },
    include: { hotelBooking: true, flightBooking: true },
  });

  if (existing) {
    // Already processed. Return the original booking.
    return existing;
  }

  // Step 2: Create the booking with the idempotency key
  try {
    const booking = await prisma.$transaction(async (tx) => {
      // Create the main booking record
      const newBooking = await tx.booking.create({
        data: {
          userId: dto.userId,
          bookingType: dto.bookingType,
          referenceCode: generateReferenceCode(dto.bookingType),
          idempotencyKey,  // ← stored with the booking
          subtotal: dto.subtotal,
          taxAmount: dto.taxAmount,
          discountAmount: dto.discountAmount,
          totalAmount: dto.totalAmount,
          currency: dto.currency,
          status: 'pending',
        },
      });

      // Create sub-type record (hotel details, flight details, etc.)
      if (dto.bookingType === 'hotel') {
        await tx.hotelBooking.create({
          data: {
            bookingId: newBooking.id,
            hotelId: dto.hotelId,
            roomType: dto.roomType,
            checkIn: dto.checkIn,
            checkOut: dto.checkOut,
          },
        });
      }

      // Write event to outbox (same transaction = atomic)
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'booking',
          aggregateId: String(newBooking.id),
          eventType: 'booking.created',
          payload: {
            bookingId: String(newBooking.id),
            userId: String(dto.userId),
            bookingType: dto.bookingType,
            totalAmount: dto.totalAmount.toString(),
            currency: dto.currency,
          },
          topic: 'booking-events',
          partitionKey: `user:${dto.userId}`,
        },
      });

      return newBooking;
    });

    return booking;

  } catch (error) {
    // Step 3: Handle the race condition
    // Two identical requests arrived simultaneously.
    // Both passed Step 1 (neither existed yet).
    // Both tried to INSERT. The UNIQUE constraint caught the duplicate.
    if (error.code === 'P2002' && error.meta?.target?.includes('idempotency_key')) {
      // The other request won the race. Return its result.
      const existing = await prisma.booking.findUnique({
        where: { idempotencyKey },
        include: { hotelBooking: true, flightBooking: true },
      });
      if (existing) return existing;
    }
    throw error;
  }
}
```

This is **defense in depth** — the application-level check (Step 1) handles the common case (a retry arriving seconds later), and the database-level constraint (Step 3) handles the edge case (two requests arriving simultaneously).

---

## Idempotency Key Storage: Database vs. Redis

You have built the schema and the Prisma models. But before you wire them into a NestJS interceptor, you face a fundamental architectural decision: **where do you store idempotency records?** The two primary options are your relational database (MySQL/PostgreSQL) and an in-memory store like Redis. Each has real trade-offs, and in production you will likely use both.

### Option A: Relational Database (MySQL / PostgreSQL)

Storing idempotency keys in your primary database is the simplest option and the one you should start with.

**Advantages:**
- **Transactional consistency.** You can create the idempotency record and the business entity (the booking, the payment) in a single database transaction. If the transaction rolls back, both are undone atomically. No orphaned idempotency records, no ghost bookings.
- **Durability.** Records survive restarts, crashes, and deployments. They are backed by disk, replicated, and part of your backup strategy.
- **Familiar tooling.** You can query, debug, and audit idempotency records with the same SQL tools you use for everything else.

**Disadvantages:**
- **Latency.** A database round-trip is 1-5ms on a local network, 10-50ms across availability zones. For every incoming request, you add at least one database query before you even start processing.
- **Connection pressure.** Each idempotency lookup consumes a connection from your pool. At 100,000 requests per minute, that is significant.
- **Storage growth.** Without aggressive TTL cleanup, the table can grow to millions of rows.

### Option B: Redis

Redis stores data in memory with optional disk persistence. It is purpose-built for fast key-value lookups.

**Advantages:**
- **Speed.** A Redis GET is typically 0.1-0.5ms. That is 10-100x faster than a database query.
- **Built-in TTL.** Redis natively supports key expiration — `SET key value EX 86400` automatically deletes the key after 24 hours. No cron jobs needed.
- **Atomic operations.** Redis `SET ... NX` (set if not exists) is atomic and handles race conditions without database-level locks.

**Disadvantages:**
- **No transactional link to your database.** You cannot atomically create a Redis key and a database row. If the database transaction succeeds but Redis fails (or vice versa), you have an inconsistency.
- **Durability concerns.** Even with AOF persistence, Redis can lose the last few seconds of writes on a crash. An idempotency key could vanish, allowing a duplicate.
- **Operational complexity.** Another system to monitor, scale, and keep available.

### Our Recommendation: Hybrid Approach

In our Global Booking System, we use **both**:

```
Request arrives with Idempotency-Key header
        │
        ▼
┌──────────────────────┐
│  1. Check Redis      │  ← Fast path (sub-millisecond)
│     (SET NX + TTL)   │
└──────────┬───────────┘
           │
     Key exists?
      /         \
    YES          NO (we acquired the lock)
     │            │
     ▼            ▼
┌──────────┐  ┌──────────────────────────────────────┐
│ Return   │  │ 2. Process request                    │
│ cached   │  │ 3. Store result in DB (same tx as     │
│ response │  │    business logic)                     │
│ from DB  │  │ 4. Cache result in Redis for fast      │
└──────────┘  │    lookup on future retries            │
              └──────────────────────────────────────┘
```

Redis handles the **fast check** and the **distributed lock** (preventing concurrent duplicates). The database handles the **durable record** (surviving crashes and providing audit trails). Here is the Redis side in code:

```typescript
import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class IdempotencyRedisService {
  constructor(private readonly redis: Redis) {}

  /**
   * Attempt to acquire an idempotency lock in Redis.
   * Returns true if this is the FIRST request with this key.
   * Returns false if a previous request already claimed the key.
   *
   * NX = "set only if Not eXists" — this is atomic in Redis.
   * EX = "expire after N seconds"
   */
  async acquireLock(
    userId: string,
    idempotencyKey: string,
    ttlSeconds: number = 86400,
  ): Promise<boolean> {
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;
    const result = await this.redis.set(
      redisKey,
      'processing',
      'EX', ttlSeconds,
      'NX',  // Only set if key does NOT exist
    );
    return result === 'OK'; // 'OK' means we set it (first request)
  }

  /**
   * Store the cached response in Redis for fast retrieval.
   */
  async cacheResponse(
    userId: string,
    idempotencyKey: string,
    response: { code: number; body: object },
    ttlSeconds: number = 86400,
  ): Promise<void> {
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;
    await this.redis.set(
      redisKey,
      JSON.stringify({ status: 'completed', response }),
      'EX', ttlSeconds,
    );
  }

  /**
   * Retrieve a cached response.
   */
  async getCachedResponse(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ code: number; body: object } | null> {
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;
    const raw = await this.redis.get(redisKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (parsed.status === 'completed' && parsed.response) {
      return parsed.response;
    }
    return null;  // Key exists but still processing
  }

  /**
   * Release the lock if request processing failed.
   * This allows the client to retry with the same key.
   */
  async releaseLock(
    userId: string,
    idempotencyKey: string,
  ): Promise<void> {
    const redisKey = `idempotency:${userId}:${idempotencyKey}`;
    await this.redis.del(redisKey);
  }
}
```

> **Checkpoint:** Notice the `NX` flag in the Redis `SET` command. This is the single most important detail. Without `NX`, two simultaneous requests would both overwrite each other's value and both believe they are the "first" request. With `NX`, Redis guarantees that only one of them succeeds — the other gets `null` back, meaning someone else already claimed this key.

---

## Full NestJS Idempotency Interceptor

Now let us wire everything together into a NestJS interceptor that you can attach to any controller endpoint with a single decorator.

> **Key Term:** **Interceptor** — In NestJS, an interceptor is a class that wraps the execution of a route handler. It runs code *before* and *after* the handler, making it ideal for cross-cutting concerns like idempotency, logging, and caching.

```typescript
// src/common/interceptors/idempotency.interceptor.ts

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ConflictException,
  BadRequestException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Observable, of, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyRedisService } from './idempotency-redis.service';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: IdempotencyRedisService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Only apply to mutating methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'];
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency-Key header is required for mutating requests',
      );
    }

    // Validate UUID v4 format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(idempotencyKey)) {
      throw new BadRequestException(
        'Idempotency-Key must be a valid UUID v4',
      );
    }

    const userId = request.user?.id;
    if (!userId) {
      throw new BadRequestException('Authenticated user required');
    }

    const requestHash = createHash('sha256')
      .update(JSON.stringify(request.body || {}))
      .digest('hex');

    // ── Step 1: Fast check in Redis ──────────────────────────
    const acquired = await this.redisService.acquireLock(
      String(userId),
      idempotencyKey,
    );

    if (!acquired) {
      // Key already exists — either completed or still processing
      const cached = await this.redisService.getCachedResponse(
        String(userId),
        idempotencyKey,
      );

      if (cached) {
        // Completed: return the cached response
        this.logger.log(
          `Idempotency hit (Redis): key=${idempotencyKey}`,
        );
        response.status(cached.code);
        return of(cached.body);
      }

      // Still processing: another request with this key is in flight
      throw new ConflictException(
        'A request with this idempotency key is currently being processed. ' +
        'Please wait and retry.',
      );
    }

    // ── Step 2: Check database (in case Redis lost the key) ──
    const existingRecord = await this.prisma.idempotencyKey.findUnique({
      where: {
        uk_idempotency: {
          userId: BigInt(userId),
          idempotencyKey,
        },
      },
    });

    if (existingRecord) {
      if (existingRecord.status === 'completed') {
        // Verify request body matches
        if (existingRecord.requestHash !== requestHash) {
          await this.redisService.releaseLock(
            String(userId),
            idempotencyKey,
          );
          throw new BadRequestException(
            'Idempotency key was already used with a different request body',
          );
        }

        // Return cached response from database
        this.logger.log(
          `Idempotency hit (DB): key=${idempotencyKey}`,
        );
        response.status(existingRecord.responseCode || 200);
        return of(existingRecord.responseBody);
      }

      if (existingRecord.status === 'processing') {
        throw new ConflictException(
          'A request with this idempotency key is currently being processed',
        );
      }

      // Status is 'failed' — allow retry by deleting old record
      await this.prisma.idempotencyKey.delete({
        where: { id: existingRecord.id },
      });
    }

    // ── Step 3: Create idempotency record in database ────────
    let recordId: bigint;
    try {
      const record = await this.prisma.idempotencyKey.create({
        data: {
          idempotencyKey,
          userId: BigInt(userId),
          requestMethod: request.method,
          requestPath: request.path,
          requestHash,
          status: 'processing',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      recordId = record.id;
    } catch (error) {
      if (error.code === 'P2002') {
        // Race condition: another instance beat us
        await this.redisService.releaseLock(
          String(userId),
          idempotencyKey,
        );
        throw new ConflictException(
          'A request with this idempotency key is currently being processed',
        );
      }
      throw error;
    }

    // ── Step 4: Execute the actual handler ────────────────────
    return next.handle().pipe(
      tap(async (responseBody) => {
        const statusCode = response.statusCode || 200;

        // Store result in database
        await this.prisma.idempotencyKey.update({
          where: { id: recordId },
          data: {
            status: 'completed',
            responseCode: statusCode,
            responseBody: responseBody as any,
            completedAt: new Date(),
          },
        });

        // Cache in Redis for fast future lookups
        await this.redisService.cacheResponse(
          String(userId),
          idempotencyKey,
          { code: statusCode, body: responseBody },
        );

        this.logger.log(
          `Idempotency recorded: key=${idempotencyKey}, status=${statusCode}`,
        );
      }),
      catchError(async (error) => {
        // Mark as failed so the key can be retried
        await this.prisma.idempotencyKey.update({
          where: { id: recordId },
          data: { status: 'failed', completedAt: new Date() },
        });

        // Release the Redis lock so retries can proceed
        await this.redisService.releaseLock(
          String(userId),
          idempotencyKey,
        );

        this.logger.error(
          `Idempotency failed: key=${idempotencyKey}, error=${error.message}`,
        );

        return throwError(() => error);
      }),
    );
  }
}
```

To apply this interceptor to a controller, you use NestJS's `@UseInterceptors` decorator:

```typescript
// src/bookings/bookings.controller.ts

import { Controller, Post, Body, UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('bookings')
export class BookingsController {
  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  async createBooking(@Body() dto: CreateBookingDto) {
    return this.bookingService.create(dto);
  }
}
```

Or apply it globally to every mutating endpoint in your module:

```typescript
// src/app.module.ts

import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';

@Module({
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
```

> **Analogy:** Think of the idempotency interceptor as a vigilant receptionist at a doctor's office. When you arrive for your 2pm appointment, the receptionist marks you as "checked in." If your phone glitches and the app sends the check-in request again, the receptionist does not create a second appointment — she says, "You are already checked in. Here is your confirmation number." And if someone else walks in while you are still being checked in, she says, "Please wait — your appointment is being processed." That is exactly what our interceptor does.

---

## Handling Concurrent Requests: The Race Condition Deep Dive

When two identical requests arrive at the exact same millisecond, you face a race condition. Let us trace through exactly what happens and how each layer of defense handles it.

```
Timeline of a Race Condition:

T=0ms   Request A arrives with key K1
T=0ms   Request B arrives with key K1 (duplicate, same millisecond)

T=1ms   Request A: Redis SET NX → "OK" (acquired lock)
T=1ms   Request B: Redis SET NX → null (lock already taken)

T=2ms   Request B: Checks Redis for cached response → null (still processing)
T=2ms   Request B: Returns 409 Conflict ("currently being processed")

T=50ms  Request A: Business logic completes. Booking BK-007 created.
T=51ms  Request A: Idempotency record stored in DB with status=completed.
T=52ms  Request A: Response cached in Redis.
T=53ms  Request A: Returns 201 { booking: "BK-007" } to client.

T=1000ms Request C arrives with key K1 (user clicked "retry")
T=1001ms Request C: Redis SET NX → null (key exists)
T=1002ms Request C: Checks Redis for cached response → found!
T=1003ms Request C: Returns 201 { booking: "BK-007" } (cached, no work done)
```

What about when Redis is unavailable? The database's unique constraint is our safety net:

```
Timeline WITHOUT Redis (fallback to database only):

T=0ms   Request A: Tries INSERT into idempotency_keys → succeeds
T=0ms   Request B: Tries INSERT into idempotency_keys → UNIQUE violation (P2002)
T=1ms   Request B: Catches P2002, queries the existing record
T=2ms   Request B: Record status is 'processing' → returns 409 Conflict
```

The database's UNIQUE constraint is the **ultimate safety net**. Even if Redis goes down, even if your application-level checks have bugs, the database will not allow two rows with the same `(user_id, idempotency_key)`.

> **What If You Skip This?** Without race condition handling, two simultaneous requests can both pass the "does this key exist?" check (both see "no"), both proceed to create the booking, and you end up with two bookings for the same idempotency key. The entire point of idempotency is defeated.

---

## Idempotency at the Database Level: UPSERT Patterns

Sometimes you want idempotency built directly into your database operations, without a separate idempotency key table. The UPSERT pattern (INSERT ... ON DUPLICATE KEY UPDATE in MySQL, INSERT ... ON CONFLICT in PostgreSQL) is your tool.

### Raw SQL: MySQL UPSERT

```sql
-- Idempotent booking creation using UPSERT.
-- If the idempotency_key already exists, we do NOT create a new row.
-- Instead, we "update" the existing row to itself (a no-op) and return it.
INSERT INTO bookings (
    user_id, booking_type, reference_code, idempotency_key,
    subtotal, tax_amount, discount_amount, total_amount, currency, status
) VALUES (
    42, 'hotel', 'BK-TOKYO-55012', 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    300.00, 40.00, 0.00, 340.00, 'USD', 'pending'
)
ON DUPLICATE KEY UPDATE
    -- These "updates" set columns to their existing values (a no-op).
    -- We do this because MySQL requires at least one SET clause.
    id = LAST_INSERT_ID(id),
    updated_at = updated_at;

-- LAST_INSERT_ID(id) ensures that both the INSERT path and the
-- ON DUPLICATE path return the same id via LAST_INSERT_ID().
SELECT * FROM bookings WHERE id = LAST_INSERT_ID();
```

### Prisma Schema (same as defined earlier)

The Prisma `Booking` model already includes the `@unique` constraint on `idempotencyKey`, which powers the UPSERT.

### Prisma Client: UPSERT

```typescript
/**
 * Idempotent booking creation using Prisma's upsert.
 *
 * If a booking with this idempotency key exists, return it unchanged.
 * If it does not exist, create it.
 *
 * The `update` block is intentionally a no-op — we do NOT want to
 * modify an existing booking when a retry arrives.
 */
async function upsertBooking(
  dto: CreateBookingDto,
  idempotencyKey: string,
): Promise<Booking> {
  return prisma.booking.upsert({
    where: { idempotencyKey },
    create: {
      userId: dto.userId,
      bookingType: dto.bookingType,
      referenceCode: generateReferenceCode(dto.bookingType),
      idempotencyKey,
      subtotal: dto.subtotal,
      taxAmount: dto.taxAmount,
      discountAmount: dto.discountAmount,
      totalAmount: dto.totalAmount,
      currency: dto.currency,
      status: 'pending',
    },
    update: {
      // Intentional no-op. We do NOT update anything on a retry.
      // This ensures the first request's data is preserved exactly.
    },
    include: {
      hotelBooking: true,
      flightBooking: true,
    },
  });
}
```

> **Checkpoint:** Why is the `update` block empty? Because the whole point of idempotency is that the second request does not change anything. If you put real update logic there, you would be modifying the booking on every retry — that is not idempotent, that is just an upsert.

---

## Idempotency for Kafka Consumers: Exactly-Once Processing

In our Global Booking System, services communicate through Kafka events. When the Booking Service publishes a `booking.created` event, the Payment Service consumes it and charges the customer. But Kafka guarantees **at-least-once delivery**, not exactly-once. If the consumer crashes after processing the message but before committing its offset, Kafka will redeliver the same message. Without consumer-side idempotency, you charge the customer twice.

### The Problem: At-Least-Once Delivery

```
Kafka At-Least-Once Delivery — The Danger:

1. Payment Service reads message: { event: "booking.created", bookingId: "BK-007" }
2. Payment Service charges Stripe: $340 deducted from card.
3. Payment Service CRASHES before committing the Kafka offset.
4. Payment Service restarts.
5. Kafka redelivers the SAME message (offset was never committed).
6. Payment Service charges Stripe AGAIN: another $340 deducted.
7. Customer is charged $680 for a $340 booking.
```

### The Solution: Processed Events Table

We need a database table that tracks which events have already been processed. Before processing any event, we check this table.

#### Raw SQL

```sql
-- ============================================
-- Tracks which Kafka events have been processed
-- to prevent duplicate processing.
-- ============================================
CREATE TABLE processed_events (
    id              BIGINT          PRIMARY KEY AUTO_INCREMENT,
    event_id        VARCHAR(255)    NOT NULL,
    consumer_group  VARCHAR(255)    NOT NULL,
    topic           VARCHAR(255)    NOT NULL,
    partition_num   INT             NOT NULL,
    offset_num      BIGINT          NOT NULL,
    processed_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The combination of event_id + consumer_group must be unique.
    -- This prevents the same consumer group from processing the
    -- same event twice, while allowing different consumer groups
    -- (different services) to each process it once.
    UNIQUE KEY uk_event_consumer (event_id, consumer_group),

    -- Index for TTL cleanup
    INDEX idx_processed_at (processed_at)
);
```

#### Prisma Schema

```prisma
model ProcessedEvent {
  id             BigInt   @id @default(autoincrement())
  eventId        String   @map("event_id") @db.VarChar(255)
  consumerGroup  String   @map("consumer_group") @db.VarChar(255)
  topic          String   @db.VarChar(255)
  partitionNum   Int      @map("partition_num")
  offsetNum      BigInt   @map("offset_num")
  processedAt    DateTime @default(now()) @map("processed_at")

  @@unique([eventId, consumerGroup], name: "uk_event_consumer")
  @@index([processedAt], name: "idx_processed_at")
  @@map("processed_events")
}
```

#### Prisma Client: Idempotent Kafka Consumer

```typescript
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Process a Kafka message idempotently.
 *
 * The entire operation — marking the event as processed AND executing
 * the business logic — happens in a single database transaction.
 * If anything fails, both are rolled back. No partial state.
 */
async function processEventIdempotently(
  eventId: string,
  consumerGroup: string,
  topic: string,
  partition: number,
  offset: number,
  handler: (tx: PrismaClient) => Promise<void>,
): Promise<{ processed: boolean }> {

  try {
    await prisma.$transaction(async (tx) => {
      // Step 1: Record that we are processing this event.
      // If it already exists, the UNIQUE constraint throws P2002.
      await tx.processedEvent.create({
        data: {
          eventId,
          consumerGroup,
          topic,
          partitionNum: partition,
          offsetNum: BigInt(offset),
        },
      });

      // Step 2: Execute the actual business logic.
      // This happens in the SAME transaction as Step 1.
      await handler(tx);
    });

    return { processed: true };

  } catch (error) {
    if (error.code === 'P2002') {
      // This event was already processed. Skip it.
      console.log(
        `Skipping duplicate event: ${eventId} for ${consumerGroup}`,
      );
      return { processed: false };
    }
    throw error;
  }
}

// ── Usage in a Kafka consumer ────────────────────────────
// @EventPattern('booking.created')
async function handleBookingCreated(message: KafkaMessage) {
  const event = JSON.parse(message.value.toString());

  await processEventIdempotently(
    event.eventId,            // Unique event identifier
    'payment-service',        // This consumer group
    message.topic,
    message.partition,
    Number(message.offset),
    async (tx) => {
      // This is the actual business logic — charge the customer.
      // It runs inside the same transaction as the dedup check.
      await tx.payment.create({
        data: {
          bookingId: BigInt(event.bookingId),
          amount: event.totalAmount,
          currency: event.currency,
          status: 'pending',
          idempotencyKey: `payment-for-${event.bookingId}`,
        },
      });

      // Call Stripe with the booking-specific idempotency key
      // so Stripe itself also deduplicates.
      await stripe.charges.create(
        {
          amount: Math.round(event.totalAmount * 100),
          currency: event.currency,
          source: event.paymentMethodId,
        },
        { idempotencyKey: `stripe-charge-${event.bookingId}` },
      );
    },
  );
}
```

> **Analogy:** Imagine a mailroom clerk who stamps every incoming package with "RECEIVED" and writes the tracking number in a ledger. If the courier brings the same package again (maybe the first delivery confirmation was lost), the clerk checks the ledger, sees the tracking number is already recorded, and says, "We already received this one." The processed_events table is that ledger.

---

## TTL for Idempotency Keys: When to Expire Them

Idempotency keys cannot live forever. Without a TTL (Time to Live), your `idempotency_keys` table grows unbounded — eventually reaching millions of rows and slowing down lookups. But choosing the right TTL requires balancing two concerns.

**Too short (e.g., 1 minute):** A user's retry might arrive after the key expires, and the system treats it as a new request. Duplicate created.

**Too long (e.g., 30 days):** The table accumulates millions of rows. Index lookups slow down. Storage costs increase. And a user who legitimately wants to create a similar booking a week later might collide with an old key.

### TTL Guidelines by Use Case

| Use Case | Recommended TTL | Reasoning |
|---|---|---|
| Payment processing | 24 hours | Stripe uses 24h. Covers all reasonable retry scenarios including overnight batch retries. |
| Booking creation | 24 hours | A user retrying a failed booking will do so within minutes, not days. 24h provides ample margin. |
| API webhooks | 72 hours | Webhook providers (Stripe, Twilio) may retry for up to 72 hours before giving up. |
| Inter-service events (Kafka) | 7 days | Kafka consumers might be down for maintenance. Events replayed after a multi-day outage need dedup. |
| Financial reconciliation | 30 days | Month-end reconciliation jobs might reprocess an entire month of transactions. |

### Implementing TTL Cleanup

#### Raw SQL: Scheduled Cleanup

```sql
-- Delete expired idempotency keys in batches to avoid
-- locking the table for too long during cleanup.
-- Run this every hour via a cron job or database event.
DELETE FROM idempotency_keys
WHERE expires_at < NOW()
  AND status != 'processing'   -- Never delete in-flight requests
ORDER BY expires_at ASC
LIMIT 10000;                   -- Process in batches of 10,000

-- Check how many remain for monitoring
SELECT COUNT(*) AS remaining_expired
FROM idempotency_keys
WHERE expires_at < NOW()
  AND status != 'processing';
```

#### Prisma Client: Batch Cleanup Service

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private readonly BATCH_SIZE = 10_000;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Run every hour. Delete expired idempotency keys in batches.
   * Batching prevents table-level locks on large deletes.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async cleanupExpiredKeys(): Promise<void> {
    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      // Prisma does not support LIMIT on deleteMany, so we use raw SQL
      const result = await this.prisma.$executeRaw`
        DELETE FROM idempotency_keys
        WHERE expires_at < NOW()
          AND status != 'processing'
        ORDER BY expires_at ASC
        LIMIT ${this.BATCH_SIZE}
      `;

      batchDeleted = result;
      totalDeleted += batchDeleted;

      // Small pause between batches to reduce DB pressure
      if (batchDeleted === this.BATCH_SIZE) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } while (batchDeleted === this.BATCH_SIZE);

    this.logger.log(
      `Idempotency cleanup: deleted ${totalDeleted} expired records`,
    );
  }
}
```

> **What If You Skip This?** We have seen production databases where the `idempotency_keys` table grew to 50 million rows because nobody configured TTL cleanup. Index scans that should take 0.5ms were taking 200ms. The extra latency on every single request added up to a measurable drop in p99 response times across the entire system.

---

## Testing Idempotency: Catching Non-Idempotent Behavior

Idempotency bugs are some of the hardest to catch because they only manifest under specific conditions: retries, network failures, race conditions. You need tests that deliberately simulate these scenarios.

### Test 1: Basic Idempotency — Same Key Returns Same Result

```typescript
describe('Idempotency', () => {
  it('should return the same booking for repeated requests with the same key', async () => {
    const idempotencyKey = crypto.randomUUID();
    const bookingData = {
      userId: 42,
      bookingType: 'hotel',
      hotelId: 'TOKYO-042',
      checkIn: '2026-03-15',
      checkOut: '2026-03-18',
      totalAmount: 340.00,
    };

    // First request — should create a booking
    const response1 = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', `Bearer ${token}`)
      .send(bookingData)
      .expect(201);

    // Second request — same key, should return the SAME booking
    const response2 = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', `Bearer ${token}`)
      .send(bookingData)
      .expect(201);

    // The booking IDs must be identical
    expect(response1.body.id).toBe(response2.body.id);
    expect(response1.body.referenceCode).toBe(response2.body.referenceCode);

    // Only ONE booking should exist in the database
    const bookings = await prisma.booking.findMany({
      where: { userId: BigInt(42), idempotencyKey },
    });
    expect(bookings).toHaveLength(1);
  });

  // Test 2: Different keys create different bookings
  it('should create separate bookings for different idempotency keys', async () => {
    const bookingData = {
      userId: 42,
      bookingType: 'hotel',
      hotelId: 'TOKYO-042',
      checkIn: '2026-03-15',
      checkOut: '2026-03-18',
      totalAmount: 340.00,
    };

    const response1 = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', crypto.randomUUID())
      .set('Authorization', `Bearer ${token}`)
      .send(bookingData)
      .expect(201);

    const response2 = await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', crypto.randomUUID())  // Different key
      .set('Authorization', `Bearer ${token}`)
      .send(bookingData)
      .expect(201);

    // Different keys = different bookings
    expect(response1.body.id).not.toBe(response2.body.id);
  });

  // Test 3: Reusing a key with different body is rejected
  it('should reject reusing a key with a different request body', async () => {
    const idempotencyKey = crypto.randomUUID();

    await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 42, totalAmount: 340.00 })
      .expect(201);

    // Same key, different body — should be rejected
    await request(app.getHttpServer())
      .post('/api/bookings')
      .set('Idempotency-Key', idempotencyKey)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 42, totalAmount: 500.00 })  // Different amount
      .expect(400);
  });

  // Test 4: Concurrent requests with the same key
  it('should handle concurrent requests without creating duplicates', async () => {
    const idempotencyKey = crypto.randomUUID();
    const bookingData = {
      userId: 42,
      bookingType: 'hotel',
      totalAmount: 340.00,
    };

    // Fire 10 simultaneous requests with the same key
    const promises = Array.from({ length: 10 }, () =>
      request(app.getHttpServer())
        .post('/api/bookings')
        .set('Idempotency-Key', idempotencyKey)
        .set('Authorization', `Bearer ${token}`)
        .send(bookingData),
    );

    const results = await Promise.allSettled(promises);

    // Exactly one should create a booking (201)
    // Others should return 201 (cached) or 409 (in-flight)
    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 201,
    );
    const conflicts = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 409,
    );

    // All successful responses should have the same booking ID
    const bookingIds = created
      .map((r) => (r as any).value.body.id)
      .filter(Boolean);
    const uniqueIds = new Set(bookingIds);
    expect(uniqueIds.size).toBeLessThanOrEqual(1);

    // Database should have exactly one booking
    const bookings = await prisma.booking.findMany({
      where: { idempotencyKey },
    });
    expect(bookings).toHaveLength(1);
  });
});
```

> **Checkpoint:** Test 4 is the most critical. It fires 10 simultaneous requests and verifies that only one booking is created. If this test fails, your idempotency implementation has a race condition. Run this test in CI with every deploy — race conditions are notoriously environment-dependent, and a test that passes on your laptop might fail under the higher concurrency of your CI server.

---

## Production War Story: The $2.3 Million Double-Charge Incident

> **What happened:** A mid-size travel booking platform (not our system — this was a company one of our engineers worked at previously) launched a flash sale on Black Friday. Their payment service had no idempotency.
>
> **The trigger:** At 3:47 AM UTC, the Kubernetes cluster autoscaled, evicting three payment service pods simultaneously. Each pod had 15-20 in-flight payment requests. The pods were terminated after the 30-second grace period. All 52 requests had already been processed (credit cards charged) but their HTTP responses were never delivered to the API Gateway.
>
> **The cascade:** The API Gateway's retry policy fired. All 52 requests were retried. 52 customers were charged twice. Then it got worse. The mobile app had its own retry logic — 3 automatic retries with exponential backoff. Some of those retries hit the newly-scaled pods during their startup phase, timed out, and triggered yet another round of retries.
>
> **The damage:** Over 37 minutes, 847 customers were charged a total of $2.3 million in duplicate payments. The average booking was $1,360, so the average double-charge was $1,360 extra on a customer's credit card on Black Friday morning.
>
> **The aftermath:** The on-call engineer realized the scope at 4:12 AM and paged the VP of Engineering. By 4:30 AM, a war room was assembled. They could not simply "refund all recent charges" because legitimate charges and duplicate charges were interleaved. They had to manually reconcile 3,200 payment records, cross-referencing Stripe's records with their own database, to identify which charges were duplicates. This took 14 hours with 6 engineers.
>
> **Customer impact:** 312 of the 847 customers called their banks to dispute the charges before the refunds were processed, resulting in $89,000 in chargeback fees that could not be recovered. The company's payment processor threatened to increase their processing rate from 2.4% to 3.1% due to the elevated chargeback ratio. Social media backlash resulted in an estimated $400,000 in lost bookings over the following week.
>
> **The fix:** They implemented idempotency keys the following sprint. Total engineering time: 3 days. Total cost of not doing it earlier: approximately $2.7 million when you add up the duplicate charges (float cost), chargeback fees, increased processing rates, engineering time for reconciliation, and lost revenue from brand damage.
>
> **The lesson:** Idempotency is not a "nice to have." It is not something you add when you have time. It is a financial safeguard that should be in place **before** you process your first real payment.

---

## Common Mistakes

| # | Mistake | Why It Is Wrong | The Fix |
|---|---------|----------------|---------|
| 1 | **Using sequential IDs as idempotency keys** (1, 2, 3...) | Two different users both send key "1" and collide. One user's booking overwrites the other's cached response. | Always use UUID v4. Scope keys to the authenticated user. |
| 2 | **Generating the idempotency key server-side** | If the response is lost, the client does not know the key. The retry sends a new request without a key (or with a new key), creating a duplicate. | The client generates the key **before** the first request and reuses it on retries. |
| 3 | **Storing idempotency keys only in Redis** (no database backup) | Redis can lose data on restart (even with AOF, up to 1 second of writes). A lost key allows duplicate processing. | Store the durable record in your database. Use Redis only as a fast cache layer on top. |
| 4 | **Not validating the request body against the stored hash** | A client reuses key "abc" for a $200 charge, then reuses "abc" for a $500 charge. Without body validation, the $500 charge returns the $200 cached response — the client thinks they charged $500 but only $200 was actually charged. | Hash the request body and compare it on retrieval. Return 400 if the hash differs. |
| 5 | **No TTL on idempotency keys** | The table grows unbounded. After months, it has tens of millions of rows. Index lookups slow down. Every request pays a latency tax. | Set a 24-hour TTL for most use cases. Run hourly batch cleanup. |
| 6 | **Making GET requests non-idempotent** by adding side effects | A GET endpoint that increments a view counter changes state on every call. Crawlers and prefetch mechanisms trigger it hundreds of times. | GET must be side-effect-free. Move side effects to separate POST endpoints or background jobs. |
| 7 | **Locking the idempotency key but never releasing it on failure** | If request processing throws an error, the key stays in "processing" state forever. All future retries are rejected with 409 Conflict. The user can never complete their booking. | Always release the lock (delete the Redis key, set status to "failed") in catch/finally blocks. |
| 8 | **Not including idempotency keys in third-party API calls** | Your service is idempotent, but you call Stripe without an idempotency key. A retry hits your cached response (good), but a failure-then-retry actually calls Stripe twice (bad). | Pass idempotency keys to every external API call (Stripe, payment processors, SMS providers). |
| 9 | **Applying idempotency to GET/PUT/DELETE unnecessarily** | These methods are already idempotent by design. Adding idempotency key checks to them wastes database queries and adds latency for no benefit. | Only require idempotency keys for POST and non-absolute PATCH operations. |
| 10 | **Using the same idempotency key across different endpoints** | Key "abc" is used for POST /bookings and also for POST /payments. The payment request returns the cached booking response — completely wrong data. | Include the request method and path in the uniqueness check, or validate them against the stored record. |

---

## Chapter Summary

| Concept | Key Takeaway |
|---|---|
| **Idempotency definition** | An operation where executing it once or multiple times produces the same result: f(f(x)) = f(x). |
| **Why it matters** | Networks are unreliable. Requests succeed but responses are lost. Clients retry. Without idempotency, retries create duplicates. |
| **Ambiguous failure** | The most dangerous scenario: the server processed the request, but the client never received the response. The client does not know whether to retry. |
| **Idempotency key** | A client-generated UUID v4 sent with every mutating request. The server uses it to detect and deduplicate retries. |
| **Key generation** | Client generates the key before the first request. The same key is reused on all retries of that same user action. |
| **HTTP method idempotency** | GET, PUT, DELETE are naturally idempotent. POST is not. PATCH depends on the operation (absolute vs. additive). |
| **Storage: Database vs. Redis** | Use both. Redis for sub-millisecond lock acquisition and caching. Database for durable records and transactional consistency. |
| **NestJS Interceptor** | A reusable interceptor that wraps any endpoint, checks for duplicate keys, locks the request, and caches the response. |
| **Race conditions** | Redis SET NX provides the first line of defense. Database UNIQUE constraints provide the ultimate safety net. |
| **UPSERT pattern** | INSERT ... ON DUPLICATE KEY UPDATE (MySQL) or INSERT ... ON CONFLICT (PostgreSQL) provides database-level idempotency without a separate table. |
| **Kafka consumers** | Use a processed_events table to prevent duplicate event processing. Insert the dedup record in the same transaction as the business logic. |
| **TTL** | 24 hours for payments and bookings. 72 hours for webhooks. 7 days for inter-service events. Clean up in batches hourly. |
| **Testing** | Test basic dedup, different keys, body mismatch rejection, and concurrent requests. Test 4 (10 simultaneous requests) is the most critical. |
| **Third-party idempotency** | Always pass idempotency keys to external APIs (Stripe, payment processors). Your idempotency is only as strong as the weakest link in the chain. |

> **Final Thought:** Idempotency is one of those rare engineering investments where the implementation cost is measured in days but the cost of skipping it is measured in millions. Every system that handles money, inventory, or any resource where duplicates have real-world consequences needs idempotency from day one. Not after the first incident. Not after the first lawsuit. From day one.
