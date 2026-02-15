# Part 1: System Foundations

---

# Chapter 5: Design Philosophy — The Non-Negotiables

## From "It Works" to "It Works at Scale"

In your CRUD applications, you have probably never thought about design philosophy. You pick Express or NestJS, wire up some routes, connect to a database, and ship. The app works. Your ten users are happy. You move on to the next feature.

That approach does not survive at scale. Here is why.

Our Global Booking System needs to handle **100,000 bookings per minute**. That is **1,666 bookings per second**. Each booking touches multiple database tables -- the booking record, inventory, payment, events -- so the real write load is closer to 8,000-10,000 database operations per second. The system must support **1,000,000 concurrent users** and maintain **99.99% availability**, which allows for only **52.6 minutes of downtime per year**.

Let those numbers sink in. Fifty-two minutes. For the entire year. If your system goes down for an hour, you have already blown your budget.

But raw numbers do not tell the full story. Consider the financial stakes. Each booking averages $340. At 1,666 bookings per second, the system processes **$566,440 per second** -- roughly **$34 million per minute**. A single minute of downtime does not just mean unhappy users; it means $34 million in lost potential revenue. A one-hour outage during peak travel season could cost the business over **$2 billion** in missed bookings, customer compensation, and brand damage.

> **Analogy:** Imagine you run a tiny coffee shop with one barista. If five customers show up, everyone gets served quickly. Now imagine 1,666 customers per second walking through the door. You do not just hire more baristas -- you need a fundamentally different business model. Drive-through lanes, mobile ordering, multiple locations, supply chain logistics. The "one barista" model does not scale by adding increments. It requires architectural rethinking. That is what this chapter is about.

This chapter establishes the four non-negotiable design principles that govern every decision in the system. Violating any single principle can -- and in real production systems, has -- brought down entire platforms. We will examine each principle in depth: the business cost of violating it, real-world production failures caused by ignoring it, code anti-patterns that look correct but break under pressure, and the correct implementation.

---

## The Four Principles

Every architectural decision in this system traces back to four non-negotiable principles. These are not suggestions. They are constraints that the system must satisfy, and they will shape every line of code you write from here forward.

Think of these principles as the load-bearing walls of a building. You can change the paint color, rearrange the furniture, and even knock down some interior walls. But if you remove a load-bearing wall, the entire structure collapses. Each principle is a load-bearing wall.

| Principle | Protects Against | Failure Cost |
|-----------|-----------------|--------------|
| Zero Overselling | Selling inventory that does not exist | Lawsuits, refunds, partner loss |
| Financial Auditability | Unrecoverable payment disputes | Regulatory fines, license revocation |
| Active-Active | Regional outages taking down the platform | Multi-billion dollar revenue loss |
| Graceful Degradation | Cascading failures destroying all services | Total platform outage |

---

### Principle 1: Zero Overselling via Fencing Tokens

#### The Problem: Why Overselling Is an Existential Threat

Here is the nightmare scenario. Two users try to book the last hotel room at the same time. Your server checks availability -- one room left. Both requests see "available." Both proceed to book. Now you have two confirmed bookings for one room. A guest shows up and has no room. You have a lawsuit, a refund, and a one-star review.

This is called **overselling**, and it is the single most dangerous failure mode in a booking system.

> **Key Term:** **Overselling** -- When a system confirms more bookings than there is available inventory. In airlines, this is sometimes intentional (airlines overbook by 5-10%). In our system, unintentional overselling is a critical bug.

#### The Business Cost of Overselling

The financial damage of overselling extends far beyond the refund amount:

| Cost Category | Per-Incident Cost | Annual Cost (at 1 oversell/day) |
|---------------|-------------------|-------------------------------|
| Customer refund + compensation | $500 - $2,000 | $182,500 - $730,000 |
| Emergency rebooking at competitor prices | $200 - $1,500 | $73,000 - $547,500 |
| Customer lifetime value loss | $3,000 - $15,000 | $1.1M - $5.5M |
| Legal settlement (if sued) | $10,000 - $100,000 | Varies |
| Partner trust damage | Incalculable | Contract renegotiation, lost deals |
| Brand reputation (social media) | Incalculable | Long-term revenue decline |

A single overselling incident at major platforms has resulted in viral social media posts with millions of views, regulatory investigations, and class-action lawsuits. In 2017, a major airline's overselling incident (though that was intentional overbooking) resulted in a $1.4 billion market cap loss in a single day.

> **Production War Story:** A mid-sized European hotel aggregator launched their platform without proper distributed locking. During a summer promotion, two concurrent requests both booked the last room at a popular Barcelona hotel. The family that arrived second -- with two young children, at 11 PM -- was turned away. They posted about the experience on social media. The post went viral. Within a week, the aggregator lost three major hotel chain partnerships, received a formal complaint from the regional consumer protection authority, and spent four months rebuilding their booking engine from scratch. Their engineering lead later estimated the total cost at over 2 million euros, not counting the brand damage. "We thought database transactions were enough," he said. "We did not understand what 'distributed' actually meant."

#### Why Database Locks Alone Are Not Enough

The naive solution is to use database locks -- lock the inventory row, check availability, book, unlock. This works on a single database. But we have 16 shards across 4 regions. A database lock on Shard 7 in `us-east-1` does not protect against a concurrent booking on Shard 7 in `eu-west-1`.

Let us trace the failure step by step:

```
Timeline of a Cross-Region Overselling Bug:

Time 0ms    Region: us-east-1
            User A requests last room at Hotel Barcelona-042
            Booking Service checks inventory: available_quantity = 1
            Acquires MySQL row lock on shard_07

Time 2ms    Region: eu-west-1
            User B requests last room at Hotel Barcelona-042
            Booking Service checks inventory on LOCAL shard: available_quantity = 1
            (Replication lag: the decrement from us-east-1 has not arrived yet)
            Acquires MySQL row lock on LOCAL shard_07

Time 5ms    Region: us-east-1
            User A's booking confirmed, available_quantity decremented to 0
            Row lock released

Time 7ms    Region: eu-west-1
            User B's booking confirmed, available_quantity decremented to 0
            Row lock released

Result:     Two confirmed bookings. One room. Disaster.
```

The problem is that MySQL row locks are **local to a single database instance**. They do not cross regions. They do not cross shards. In a distributed system, you need a **distributed lock** -- and even distributed locks have failure modes.

#### The Anti-Pattern: Code That Looks Correct But Oversells

Here is code that a competent developer might write. It uses a database transaction with `SELECT ... FOR UPDATE`. It looks safe. It is not.

```typescript
// ============================================
// ANTI-PATTERN: Looks safe, oversells at scale
// ============================================
async reserveRoom(resourceId: number, date: Date): Promise<boolean> {
  return await this.dataSource.transaction(async (manager) => {
    // Lock the row -- this prevents OTHER transactions
    // on THIS database from reading it
    const inventory = await manager.query(
      `SELECT available_quantity
       FROM inventory
       WHERE resource_id = ? AND resource_date = ?
       FOR UPDATE`,
      [resourceId, date]
    );

    if (inventory[0].available_quantity <= 0) {
      return false; // No availability
    }

    // Decrement the count
    await manager.query(
      `UPDATE inventory
       SET available_quantity = available_quantity - 1,
           reserved_quantity = reserved_quantity + 1
       WHERE resource_id = ? AND resource_date = ?`,
      [resourceId, date]
    );

    return true; // Reserved!
  });
}
```

**Why this breaks:**

1. **Cross-region blindness.** `FOR UPDATE` only locks the row on the local MySQL instance. A replica in another region still reads the old value.
2. **No stale-write protection.** If a distributed lock expires while this code runs (network hiccup, GC pause), another service acquires the lock and proceeds. Both complete the transaction. Both succeed. Both are wrong.
3. **No audit trail.** Who acquired the lock? When did they acquire it? Was the lock still valid when the write happened? This code answers none of those questions.

#### The Solution: Fencing Tokens

Our solution is **fencing tokens**. Every inventory mutation goes through a distributed lock that issues a monotonically increasing token. The database rejects any write carrying a stale token. Even if a lock expires and two services both think they own the lock, only the one with the higher token succeeds.

> **Key Term:** **Fencing Token** -- A monotonically increasing number attached to a distributed lock. When a service acquires a lock, it receives a token (say, 42). If the lock expires and another service acquires it, that service gets token 43. The database checks: "Is this token higher than the last one I saw?" If not, the write is rejected. This prevents stale lock holders from corrupting data.

> **Analogy:** Think of a deli counter with numbered tickets. You pull ticket #42 and step up to order. But you get a phone call and step away. While you are gone, someone else pulls ticket #43 and orders. When you come back with ticket #42, the clerk says, "Sorry, we are already serving #43. Your ticket is stale." The fencing token is that numbered ticket.

Here is the correct implementation:

```typescript
// ============================================
// CORRECT: Fencing token prevents stale writes
// ============================================
async reserveRoom(
  resourceId: number,
  date: Date,
  userId: number
): Promise<ReservationResult> {
  // Step 1: Acquire a distributed lock with a fencing token
  const lock = await this.redisLock.acquire(
    `inventory:${resourceId}:${date.toISOString()}`,
    { ttl: 5000 } // Lock expires after 5 seconds
  );

  if (!lock) {
    throw new ConflictException(
      'Could not acquire inventory lock. Try again.'
    );
  }

  try {
    const fencingToken = lock.fencingToken; // e.g., 42

    // Step 2: Update inventory, BUT only if our token is the latest
    const result = await this.dataSource.query(
      `UPDATE inventory
       SET available_quantity = available_quantity - 1,
           reserved_quantity = reserved_quantity + 1,
           fencing_token = ?,
           last_updated_by = ?
       WHERE resource_id = ?
         AND resource_date = ?
         AND available_quantity > 0
         AND (fencing_token IS NULL OR fencing_token < ?)`,
      [fencingToken, `user:${userId}`, resourceId, date, fencingToken]
    );

    if (result.affectedRows === 0) {
      // Either no availability, or our fencing token is stale
      // Both cases mean: do NOT reserve
      return { success: false, reason: 'unavailable_or_stale_token' };
    }

    return { success: true, fencingToken };
  } finally {
    // Step 3: Always release the lock
    await this.redisLock.release(lock);
  }
}
```

**Why this works:**

1. **The WHERE clause is the guardian.** `fencing_token < ?` ensures that only the holder of the highest token can write. If our lock expired and someone else got token 43, our write with token 42 affects zero rows.
2. **`available_quantity > 0` is the safety net.** Even if the fencing logic has a bug, the database itself refuses to decrement below zero (backed by the `CHECK (available_quantity >= 0)` constraint on the table).
3. **`last_updated_by` creates an audit trail.** When investigating an incident, you can see exactly who made the last write and with which fencing token.

```prisma
// Prisma Schema for the inventory table
model Inventory {
  id                Int       @id @default(autoincrement())
  resourceType      ResourceType @map("resource_type")
  resourceId        BigInt    @map("resource_id")
  resourceDate      DateTime  @map("resource_date") @db.Date
  totalQuantity     Int       @map("total_quantity") @db.SmallInt
  availableQuantity Int       @map("available_quantity") @db.SmallInt
  reservedQuantity  Int       @default(0) @map("reserved_quantity") @db.SmallInt
  overbookingLimit  Int       @default(0) @map("overbooking_limit") @db.SmallInt
  fencingToken      BigInt?   @map("fencing_token")
  basePrice         Decimal   @map("base_price") @db.Decimal(10, 2)
  currency          String    @default("USD") @db.Char(3)
  lastUpdatedBy     String?   @map("last_updated_by") @db.VarChar(100)
  updatedAt         DateTime  @updatedAt @map("updated_at")

  @@unique([resourceType, resourceId, resourceDate], map: "uniq_resource_date")
  @@index([resourceType, resourceId], map: "idx_resource")
  @@index([resourceDate], map: "idx_date")
  @@index([resourceType, resourceDate, availableQuantity], map: "idx_availability")
  @@index([resourceType, resourceId, fencingToken], map: "idx_fencing")
  @@map("inventory")
}

enum ResourceType {
  hotel_room
  flight_seat
  car
}
```

```typescript
// Prisma Client equivalent of the fencing token update
const result = await prisma.$executeRaw`
  UPDATE inventory
  SET available_quantity = available_quantity - 1,
      reserved_quantity = reserved_quantity + 1,
      fencing_token = ${fencingToken},
      last_updated_by = ${`user:${userId}`}
  WHERE resource_id = ${resourceId}
    AND resource_date = ${date}
    AND available_quantity > 0
    AND (fencing_token IS NULL OR fencing_token < ${fencingToken})
`;

if (result === 0) {
  // No rows affected -- either sold out or stale token
  throw new ConflictException('Reservation failed');
}
```

> **Why Not a Simple Redis Lock?** A Redis lock without a fencing token is vulnerable to the "lock expiry" problem. Service A acquires the lock with a 5-second TTL. Service A experiences a GC pause lasting 6 seconds. The lock expires. Service B acquires the lock and begins writing. Service A wakes up from GC, believing it still holds the lock, and also writes. Both writes succeed. The fencing token solves this because even if Service A writes after its lock expired, the database rejects the write because Service B's higher token has already been recorded.

> **What If You Skip This?** You will oversell inventory. Not "maybe" -- you will, guaranteed, under concurrent load. Two users will book the last room. Your support team will spend hours manually fixing double-bookings. Hotels and airlines will lose trust in your platform. This is a business-ending bug at scale.

We will build the full fencing token implementation in Chapter 11 (Inventory Management). For now, just remember: every write to inventory goes through a fencing token check.

---

### Principle 2: Financial Auditability via Double-Entry Accounting

#### The Problem: Money Must Never Disappear

Every monetary operation in our system creates balanced journal entries. For every debit, there is a credit. The total debits always equal the total credits. This is not optional -- it is a legal requirement for financial compliance.

The payment ledger is **immutable**. Once a record is written, it cannot be updated or deleted. We enforce this with database triggers that physically reject `UPDATE` and `DELETE` statements. If a payment needs to be reversed, we do not delete the original record. We create a new record that reverses it.

> **Key Term:** **Double-Entry Accounting** -- An accounting method where every transaction has two entries: a debit and a credit. If a customer pays $200 for a hotel room, the system records a $200 debit to the customer's account and a $200 credit to the hotel's account. The books always balance.

> **Key Term:** **Immutable Ledger** -- A database table where rows can only be inserted, never updated or deleted. This creates a permanent audit trail. If regulators ask "what happened to payment #12345?", you can trace every event from authorization through capture, refund, and chargeback.

#### The Business Cost of Violating Auditability

Financial systems are regulated. Depending on the jurisdiction, you must comply with PCI-DSS (Payment Card Industry Data Security Standard), SOX (Sarbanes-Oxley for public companies), GAAP or IFRS accounting standards, and local financial reporting laws. Failing an audit does not result in a polite warning. It results in:

| Violation | Consequence |
|-----------|-------------|
| Cannot produce audit trail for transactions | Fines from $100K to $10M depending on jurisdiction |
| Mutable payment records | Loss of PCI-DSS certification, inability to process cards |
| Unbalanced books (debits != credits) | Regulatory investigation, potential fraud charges |
| Missing refund documentation | Chargeback losses, payment processor penalties |
| Unable to reconcile with payment providers | Frozen merchant account, loss of payment processing |

> **Production War Story:** A travel startup processed $50M in bookings during their first year. Their ledger used a simple `transactions` table with mutable rows. When a refund occurred, they updated the original row's `status` to `refunded` and changed the `amount` to 0. This seemed clean and simple. When Stripe requested a quarterly reconciliation, the startup discovered that 847 transactions in their database did not match Stripe's records. The original amounts had been overwritten, so there was no way to reconstruct what happened. It took three accountants working full-time for six weeks to manually reconcile the books using Stripe's API logs. Stripe placed the startup on a monitoring plan. During the next audit, they found additional discrepancies -- refunds that were recorded in the database but never actually processed through Stripe. The startup's Stripe account was suspended for 30 days. They lost $4.2M in bookings during the suspension period. Their CTO later wrote a post-mortem attributing the entire incident to one architectural decision: making the ledger mutable.

#### The Anti-Pattern: Mutable Financial Records

```typescript
// ============================================
// ANTI-PATTERN: Mutable payment records
// ============================================
async processRefund(bookingId: number, amount: number) {
  // Find the original payment
  const payment = await this.db.query(
    'SELECT * FROM payments WHERE booking_id = ?',
    [bookingId]
  );

  // Call Stripe to process the refund
  const refund = await stripe.refunds.create({
    payment_intent: payment.stripe_id,
    amount: amount * 100, // Stripe uses cents
  });

  // UPDATE the original record -- DESTROYING the audit trail
  await this.db.query(
    `UPDATE payments
     SET status = 'refunded',
         refund_amount = ?,
         refund_id = ?,
         updated_at = NOW()
     WHERE booking_id = ?`,
    [amount, refund.id, bookingId]
  );
  // The original payment amount, status, and timestamp are GONE.
  // If the refund amount was wrong, you cannot prove what the
  // original charge was.
}
```

**Why this breaks:**

1. **Lost history.** The original payment record is overwritten. If someone asks "what was the original charge?", you cannot answer from the database alone.
2. **Reconciliation failure.** When you compare your records with Stripe's, Stripe shows a charge of $340 and a refund of $340. Your database shows a single row with `refund_amount: 340` and `status: refunded`. If the amounts disagree, you have no way to determine when the discrepancy began.
3. **Partial refund chaos.** What if the customer gets a $100 partial refund, then disputes the remaining $240? Your `UPDATE` approach cannot represent the sequence of events.

#### The Correct Approach: Append-Only with Hash Chaining

```typescript
// ============================================
// CORRECT: Immutable ledger with hash chain
// ============================================
async processRefund(bookingId: number, amount: number) {
  // Step 1: Get the last ledger entry for this booking
  const lastEntry = await this.db.query(
    `SELECT record_hash, balance
     FROM payment_ledger
     WHERE booking_id = ?
     ORDER BY id DESC LIMIT 1`,
    [bookingId]
  );

  // Step 2: Process the refund through Stripe
  const refund = await stripe.refunds.create({
    payment_intent: payment.stripe_id,
    amount: amount * 100,
  });

  // Step 3: Calculate the new running balance
  const newBalance = lastEntry.balance - amount;

  // Step 4: Create the hash for this record
  const recordData = `${bookingId}|refund|${amount}|${newBalance}|${Date.now()}`;
  const recordHash = crypto
    .createHash('sha256')
    .update(recordData)
    .digest('hex');

  // Step 5: INSERT a new record -- never update the old one
  await this.db.query(
    `INSERT INTO payment_ledger (
      booking_id, event_type, amount, currency, balance,
      payment_provider, provider_transaction_id,
      record_hash, previous_record_hash,
      event_timestamp, initiated_by, initiated_by_type
    ) VALUES (?, 'refund', ?, 'USD', ?, 'stripe', ?, ?, ?, NOW(), ?, 'system')`,
    [
      bookingId, amount, newBalance, refund.id,
      recordHash, lastEntry.record_hash,
      systemUserId
    ]
  );

  // The original charge record is UNTOUCHED.
  // The ledger now shows:
  //   Record 1: authorization  | +$340 | balance: $340
  //   Record 2: capture        | +$340 | balance: $340
  //   Record 3: refund         | -$100 | balance: $240
  // Every record is linked by hash. Tamper with one, the chain breaks.
}
```

```prisma
// Prisma Schema for the payment ledger
model PaymentLedger {
  id                    BigInt    @id @default(autoincrement())
  bookingId             BigInt    @map("booking_id")
  transactionId         BigInt?   @map("transaction_id")
  eventType             LedgerEventType @map("event_type")
  amount                Decimal   @db.Decimal(12, 2)
  currency              String    @db.Char(3)
  balance               Decimal   @db.Decimal(12, 2)
  paymentProvider       String    @map("payment_provider") @db.VarChar(50)
  providerTransactionId String?   @map("provider_transaction_id") @db.VarChar(255)
  providerReference     String?   @map("provider_reference") @db.VarChar(255)
  reason                String?   @db.Text
  processorResponseCode String?   @map("processor_response_code") @db.VarChar(20)
  recordHash            String    @map("record_hash") @db.VarChar(64)
  previousRecordHash    String?   @map("previous_record_hash") @db.VarChar(64)
  eventTimestamp        DateTime  @map("event_timestamp")
  createdAt             DateTime  @default(now()) @map("created_at")
  initiatedBy           BigInt?   @map("initiated_by")
  initiatedByType       InitiatedByType @map("initiated_by_type")

  @@index([bookingId, eventTimestamp], map: "idx_booking")
  @@index([transactionId], map: "idx_transaction")
  @@index([eventType], map: "idx_event_type")
  @@index([eventTimestamp], map: "idx_timestamp")
  @@map("payment_ledger")
}

enum LedgerEventType {
  authorization
  authorization_void
  capture
  partial_capture
  refund
  partial_refund
  chargeback
  chargeback_reversal
}

enum InitiatedByType {
  user
  admin
  system
}
```

```typescript
// Prisma Client: Insert a new ledger entry (append-only)
const newEntry = await prisma.paymentLedger.create({
  data: {
    bookingId: bookingId,
    eventType: 'refund',
    amount: new Prisma.Decimal(amount),
    currency: 'USD',
    balance: new Prisma.Decimal(newBalance),
    paymentProvider: 'stripe',
    providerTransactionId: refund.id,
    recordHash: recordHash,
    previousRecordHash: lastEntry.recordHash,
    eventTimestamp: new Date(),
    initiatedBy: systemUserId,
    initiatedByType: 'system',
  },
});

// Verify the hash chain is intact
const entries = await prisma.paymentLedger.findMany({
  where: { bookingId },
  orderBy: { id: 'asc' },
});

for (let i = 1; i < entries.length; i++) {
  if (entries[i].previousRecordHash !== entries[i - 1].recordHash) {
    // ALERT: Hash chain is broken -- possible tampering!
    await this.alertService.critical(
      `Ledger hash chain broken for booking ${bookingId} at entry ${entries[i].id}`
    );
  }
}
```

> **Analogy:** Think of a paper checkbook register. You do not erase entries when you make a mistake -- you write a new entry that corrects the error. If you accidentally recorded a $100 payment twice, you do not erase one entry. You write a new line: "Void -- duplicate entry, +$100." The full history is preserved, and anyone can follow the trail.

> **Why Not a Simple Status Column?** A status column (`paid`, `refunded`, `disputed`) shows you the current state but not how you got there. Was it authorized then voided, or authorized then captured then partially refunded? When did each transition happen? Who initiated it? An append-only ledger answers all of these questions because every state change is a separate record.

> **What If You Skip This?** You will fail financial audits. Payment disputes will become unresolvable because you cannot prove what happened. In regulated markets, this can mean fines or losing your payment processing license. The immutable ledger is your legal shield.

We will build the payment ledger in Chapter 13 (Financial Ledger). For now, understand that money never "disappears" -- every dollar has a paper trail.

---

### Principle 3: Multi-Region Active-Active via Kafka

#### The Problem: A Single Region Is a Single Point of Failure

Our system runs in four AWS regions simultaneously: `us-east-1` (Virginia), `eu-west-1` (Ireland), `ap-southeast-1` (Singapore), and `sa-east-1` (Sao Paulo). All four regions process bookings independently. There is no "primary" region that everything depends on.

This is called **active-active** deployment. If the Virginia region goes down entirely, the other three continue operating without interruption. Users are routed to the nearest healthy region.

> **Key Term:** **Active-Active Deployment** -- A configuration where multiple data centers or regions simultaneously handle live traffic. Contrast this with **active-passive**, where one region handles all traffic and the other is a standby that only activates during failure. Active-active provides lower latency and higher availability but is much harder to build.

#### The Business Cost of Single-Region Deployment

AWS regions do go down. Here is the history:

| Incident | Duration | Services Affected |
|----------|----------|-------------------|
| us-east-1, December 2021 | ~7 hours | API Gateway, Lambda, DynamoDB, many others |
| ap-southeast-2, June 2023 | ~4 hours | EC2, RDS, ElastiCache |
| us-east-1, June 2023 | ~2 hours | Lambda edge functions |
| us-west-2, August 2023 | ~3 hours | EC2, EBS |

If our system ran in a single region and that region experienced a 4-hour outage, the cost would be:

```
Downtime cost calculation:
- 4 hours = 240 minutes
- 100,000 bookings/minute at peak
- Average booking: $340
- Direct revenue loss: 240 * 100,000 * $340 = $8.16 billion
  (Note: actual loss depends on time-of-day and seasonality,
   but even at 10% of peak, that is still $816 million)

- Customer compensation for failed bookings: ~$5M - $50M
- SLA violation penalties to partners: ~$1M - $10M
- Regulatory scrutiny: priceless headache
```

Even if you have only 10% of this traffic, a single-region outage is catastrophic for any business with 99.99% availability targets.

> **Production War Story:** In December 2021, a major US-based travel platform experienced the us-east-1 outage firsthand. They ran active-passive: us-east-1 was active, us-west-2 was passive standby. When us-east-1 went down, the failover to us-west-2 took 47 minutes -- not because the failover was slow, but because DNS propagation took time, database replicas needed to be promoted to primary, and connection pools needed to drain and re-establish. During those 47 minutes, the platform was completely offline. They estimated the cost at $12M in direct revenue loss plus $3M in customer compensation. The following quarter, they began their migration to active-active. It took 14 months and cost $8M in engineering effort. Their VP of Engineering later said: "The migration paid for itself in the first avoided outage."

#### Why Active-Active Is Hard: The Conflict Problem

But here is the problem: if two regions both process a booking for the last hotel room at the same time, who wins? This is where **Kafka** comes in.

> **Key Term:** **CAP Theorem** -- A fundamental theorem in distributed systems stating that you can only guarantee two out of three properties: **Consistency** (all nodes see the same data), **Availability** (every request gets a response), and **Partition tolerance** (the system works despite network failures). Our system chooses AP -- availability and partition tolerance -- meaning during a network split, both regions continue accepting bookings, and conflicts are resolved after the partition heals.

All booking events flow through a global Kafka event stream. When a conflict is detected -- two regions booked the same room -- the system resolves it deterministically using fencing token ordering. The higher token wins.

#### The Anti-Pattern: Primary-Region Bottleneck

```typescript
// ============================================
// ANTI-PATTERN: All writes go to one region
// ============================================
class BookingService {
  async createBooking(data: CreateBookingDto) {
    if (process.env.REGION !== 'us-east-1') {
      // Forward to the "primary" region
      return await this.httpService.post(
        'https://us-east-1.internal.booking.com/api/bookings',
        data,
        { timeout: 5000 }
      );
    }

    // Only us-east-1 processes writes
    return await this.processBooking(data);
  }
}
// PROBLEM: If us-east-1 goes down, NO region can create bookings.
// PROBLEM: Users in Singapore have 200ms+ latency to Virginia.
// PROBLEM: The us-east-1 cluster becomes a bottleneck under load.
```

#### The Correct Approach: Local Processing with Global Reconciliation

```typescript
// ============================================
// CORRECT: Each region processes locally,
//          conflicts resolved via Kafka
// ============================================
class BookingService {
  async createBooking(data: CreateBookingDto) {
    // Step 1: Process the booking locally -- no cross-region calls
    const booking = await this.processBookingLocally(data);

    // Step 2: Publish to the GLOBAL Kafka stream
    //         All regions see this event
    await this.kafkaProducer.send({
      topic: 'bookings.global',
      messages: [{
        key: `${data.resourceType}:${data.resourceId}:${data.resourceDate}`,
        value: JSON.stringify({
          ...booking,
          region: process.env.REGION,
          fencingToken: booking.fencingToken,
          timestamp: Date.now(),
        }),
        headers: {
          'X-Region': process.env.REGION,
          'X-Fencing-Token': String(booking.fencingToken),
        },
      }],
    });

    return booking;
  }
}

// Conflict Resolution Consumer (runs in every region)
class ConflictResolutionConsumer {
  @KafkaListener({ topic: 'bookings.global' })
  async handleGlobalBookingEvent(event: BookingEvent) {
    const existingBooking = await this.findConflictingBooking(event);

    if (!existingBooking) {
      // No conflict -- replicate to local database
      await this.replicateBooking(event);
      return;
    }

    // Conflict detected! Two regions booked the same resource.
    // Resolution rule: highest fencing token wins.
    if (event.fencingToken > existingBooking.fencingToken) {
      // Incoming event wins -- cancel the local booking
      await this.cancelWithCompensation(existingBooking);
      await this.replicateBooking(event);
    } else {
      // Local booking wins -- the incoming event is stale
      await this.publishConflictResolution({
        winnerId: existingBooking.id,
        loserId: event.bookingId,
        reason: 'stale_fencing_token',
      });
    }
  }
}
```

> **Analogy:** Imagine two branch offices of a car rental company. Both have their own inventory sheets. A customer in Office A rents the last sedan. At the same moment, a customer in Office B also rents "the last sedan" because their sheets have not synced yet. When the offices sync up at the end of the day, they discover the conflict. The resolution rule is simple: whichever rental was logged with the higher sequence number wins, and the other customer gets a call offering an upgrade or alternative. Our system does this automatically, within seconds rather than at end of day.

> **Why Not Active-Passive?** Active-passive means one region handles all traffic while others sit idle. Problems: (1) Users far from the active region get high latency (Singapore to Virginia is ~200ms round-trip). (2) Failover is not instantaneous -- DNS propagation, database promotion, and connection re-establishment take minutes. (3) You are paying for idle infrastructure. (4) You never test the failover path in production, so when you need it, it might not work. Active-active eliminates all four problems.

> **What If You Skip This?** If you run in a single region and that region goes down, your entire platform goes offline. Every user worldwide sees an error page. 99.99% availability is impossible with a single region because individual regions have outages that last hours.

We will build the multi-region architecture in Chapter 17 (Multi-Region Conflict Resolution). For now, understand that every service must be stateless and every piece of state must flow through the event stream.

---

### Principle 4: Graceful Degradation via Circuit Breakers

#### The Problem: Cascading Failures Destroy Everything

In a microservices architecture, services depend on each other. The Booking Service calls the Inventory Service. The Inventory Service calls Redis. If Redis goes down, the Inventory Service starts timing out. The Booking Service retries, flooding the Inventory Service with requests. The Inventory Service collapses. Now the API Gateway is timing out. The entire system fails because one upstream dependency had a hiccup.

This is called a **cascading failure**, and it is the most common way microservice architectures die.

> **Key Term:** **Cascading Failure** -- When the failure of one component causes dependent components to fail, which causes their dependents to fail, spreading like dominoes until the entire system is down.

> **Production War Story:** A major ride-sharing company experienced a cascading failure that took their entire platform offline for 8 minutes during a Friday evening rush. The root cause was a single slow database query in their pricing service. The query normally took 5ms but spiked to 12 seconds due to a missing index on a newly added column. The dispatch service, which called the pricing service synchronously, ran out of connection pool threads waiting for responses. The dispatch service started rejecting requests. The rider app started retrying failed requests, tripling the load. The load balancer marked dispatch instances as unhealthy and started routing all traffic to the remaining healthy instances, which then also collapsed. Within 90 seconds, every instance of every downstream service was either hung or crashed. The 8-minute outage during peak hours cost them an estimated $2M in revenue and resulted in thousands of angry social media posts. The post-mortem identified the root cause in 30 seconds. The fix (adding an index) took 2 minutes. But without circuit breakers, that 2-minute fix required an 8-minute outage because there was no way to isolate a failing service.

#### The Business Cost: The Blast Radius Problem

Without graceful degradation, every failure has a blast radius of 100% -- any component failure takes down the entire system.

```
Without Graceful Degradation:
   Redis hiccup (5 seconds)
   └── Inventory Service timeouts (5 seconds * retry count)
       └── Booking Service thread pool exhaustion (15 seconds)
           └── API Gateway timeout cascades (30 seconds)
               └── TOTAL PLATFORM OUTAGE (until restart)

With Graceful Degradation:
   Redis hiccup (5 seconds)
   └── Circuit breaker opens on Redis calls
       └── Inventory returns cached/fallback data
           └── Booking Service operates normally
               └── Users experience degraded (not broken) service
                   └── Platform stays up. Revenue continues flowing.
```

The difference between these two scenarios is the difference between a $50M annual loss from downtime and a $500K annual loss from brief periods of degraded service. That is a 100x improvement.

#### Three Defensive Patterns

We enforce three defensive patterns:

**Pattern 1: Circuit Breakers**

> **Key Term:** **Circuit Breaker** -- A pattern borrowed from electrical engineering. When a service detects too many failures to a downstream dependency, it "opens the circuit" -- it stops making calls to that dependency entirely and returns a fallback response instead. After a timeout period, it allows a few test requests through ("half-open"). If those succeed, it closes the circuit and resumes normal operations.

```typescript
// ============================================
// Circuit Breaker Implementation
// ============================================
import CircuitBreaker from 'opossum';

class InventoryClient {
  private breaker: CircuitBreaker;

  constructor() {
    this.breaker = new CircuitBreaker(
      this.callInventoryService.bind(this),
      {
        timeout: 2000,        // Trip if call takes > 2 seconds
        errorThresholdPercentage: 50,  // Trip if 50% of calls fail
        resetTimeout: 10000,  // Try again after 10 seconds
        rollingCountTimeout: 10000,    // Measure over 10-second window
        rollingCountBuckets: 10,       // 10 one-second buckets
        volumeThreshold: 5,   // Minimum 5 calls before tripping
      }
    );

    // When the circuit opens, return cached data
    this.breaker.fallback(async (params) => {
      const cached = await this.redis.get(
        `inventory:${params.resourceId}:${params.date}`
      );
      if (cached) {
        return { ...JSON.parse(cached), fromCache: true };
      }
      // No cache available -- return a "service degraded" response
      throw new ServiceUnavailableException(
        'Inventory service is temporarily unavailable'
      );
    });

    // Monitoring hooks
    this.breaker.on('open', () => {
      this.logger.warn('Circuit breaker OPENED for Inventory Service');
      this.metrics.increment('circuit_breaker.inventory.open');
    });
    this.breaker.on('halfOpen', () => {
      this.logger.info('Circuit breaker HALF-OPEN for Inventory Service');
    });
    this.breaker.on('close', () => {
      this.logger.info('Circuit breaker CLOSED for Inventory Service');
      this.metrics.increment('circuit_breaker.inventory.close');
    });
  }

  async checkAvailability(params: CheckAvailabilityParams) {
    return this.breaker.fire(params);
  }

  private async callInventoryService(params: CheckAvailabilityParams) {
    const response = await axios.post(
      `${this.inventoryUrl}/api/inventory/check`,
      params,
      { timeout: 2000 }
    );
    return response.data;
  }
}
```

> **Analogy:** Your house has circuit breakers in the electrical panel. If a short circuit happens in your kitchen, the kitchen breaker trips, cutting power to the kitchen. But your living room, bedroom, and bathroom keep working. Without circuit breakers, a short circuit in the kitchen would blow out the entire house. In our system, if the search service goes down, users cannot search -- but they can still complete existing bookings, make payments, and receive confirmations.

**Pattern 2: Bulkheads**

> **Key Term:** **Bulkhead** -- A pattern that isolates different parts of the system into separate failure domains, each with its own pool of resources (threads, connections, memory). If one domain exhausts its resources, the others are unaffected. The name comes from the watertight compartments in a ship's hull -- if one compartment floods, the bulkheads prevent water from spreading to the rest of the ship.

```typescript
// ============================================
// Bulkhead: Separate connection pools per dependency
// ============================================
class ServiceDependencies {
  // Each downstream service gets its own connection pool.
  // If one pool is exhausted, the others are unaffected.

  private readonly inventoryPool = new ConnectionPool({
    maxConnections: 20,
    timeout: 2000,
    name: 'inventory',
  });

  private readonly paymentPool = new ConnectionPool({
    maxConnections: 15,
    timeout: 5000,  // Payments need more time
    name: 'payment',
  });

  private readonly notificationPool = new ConnectionPool({
    maxConnections: 10,
    timeout: 3000,
    name: 'notification',
  });

  // If the payment provider is slow and exhausts its 15 connections,
  // inventory checks still work fine using their separate 20 connections.
  // Without bulkheads, a single shared pool of 45 connections could be
  // entirely consumed by slow payment calls, blocking inventory and
  // notification calls too.
}
```

**Pattern 3: Retry Budgets**

> **Key Term:** **Retry Budget** -- A limit on how many retries a service is allowed to perform within a given time window. Without a budget, every failed request triggers a retry, and those retries can fail and trigger more retries, creating an exponential "retry storm" that overwhelms the downstream service. A typical retry budget might allow only 10% of total requests to be retries.

```typescript
// ============================================
// ANTI-PATTERN: Unlimited retries
// ============================================
async callServiceWithRetry(fn: () => Promise<any>) {
  while (true) {  // DANGER: infinite retry loop
    try {
      return await fn();
    } catch (error) {
      await sleep(1000); // Wait 1 second and try again
      // If the downstream service is down, this loop runs forever,
      // holding a connection, a thread, and memory. Multiply by
      // 1,666 requests/second and you exhaust everything in seconds.
    }
  }
}

// ============================================
// CORRECT: Retry budget with exponential backoff
// ============================================
class RetryBudget {
  private retryCount = 0;
  private requestCount = 0;
  private readonly maxRetryRatio = 0.1;  // Max 10% of requests can be retries
  private readonly maxRetries = 3;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.requestCount++;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        // Check the retry budget
        const retryRatio = this.retryCount / this.requestCount;
        if (retryRatio >= this.maxRetryRatio) {
          throw new Error(
            `Retry budget exhausted (${(retryRatio * 100).toFixed(1)}% of requests are retries)`
          );
        }

        if (attempt === this.maxRetries) {
          throw error; // No more retries
        }

        this.retryCount++;

        // Exponential backoff with jitter
        const backoff = Math.min(
          1000 * Math.pow(2, attempt) + Math.random() * 1000,
          10000  // Max 10 seconds
        );
        await sleep(backoff);
      }
    }
  }
}
```

> **What If You Skip This?** A single slow database query will take down your entire platform. We have seen this in production: one service has a memory leak, it starts responding slowly, every caller retries, the retry storm consumes all available connections, and every service crashes simultaneously. Circuit breakers prevent this domino effect.

We will implement circuit breakers in Chapter 21 (Circuit Breaker & Bulkhead).

---

## Principle Violations Checklist

Use this checklist during code reviews. If any item is checked, the code violates a design principle and must be fixed before merging.

### Zero Overselling Violations
- [ ] Inventory mutation without a fencing token
- [ ] `SELECT ... FOR UPDATE` used as the sole concurrency control across regions
- [ ] No `CHECK (available_quantity >= 0)` constraint on the inventory table
- [ ] Distributed lock acquired but no fencing token passed to the database
- [ ] Lock TTL longer than 10 seconds (increases window for stale writes)
- [ ] Missing `WHERE fencing_token < ?` in inventory UPDATE statements

### Financial Auditability Violations
- [ ] `UPDATE` or `DELETE` statement on `payment_ledger` table
- [ ] Financial amounts stored as `FLOAT` or `DOUBLE` instead of `DECIMAL`
- [ ] Refund implemented by modifying the original payment record
- [ ] Missing `record_hash` or `previous_record_hash` on ledger entries
- [ ] No verification of hash chain integrity during reconciliation
- [ ] Currency conversions done with JavaScript floating point arithmetic

### Active-Active Violations
- [ ] Cross-region synchronous HTTP calls in the booking path
- [ ] A "primary region" that all writes must flow through
- [ ] Hardcoded region in service configuration
- [ ] Missing `region` field on events published to Kafka
- [ ] Conflict resolution logic that is non-deterministic (e.g., "first writer wins" where "first" depends on clock time)

### Graceful Degradation Violations
- [ ] Inter-service calls without a timeout
- [ ] Missing circuit breaker on any downstream service call
- [ ] Single shared connection pool for all downstream dependencies
- [ ] Unlimited retries or retries without exponential backoff
- [ ] No fallback behavior when a circuit breaker opens
- [ ] Health check endpoint that does not verify downstream dependencies

---

## Decision Matrix: Choosing the Right Safety Mechanism

| Scenario | Mechanism | Why |
|----------|-----------|-----|
| Two users booking the last room simultaneously | Fencing token + DB CHECK constraint | Distributed lock alone is not enough; the database must be the final arbiter |
| Refund needs to be processed | Append-only ledger entry | Original charge record must remain intact for audit trail |
| us-east-1 goes down during peak traffic | Active-active with Kafka conflict resolution | Other regions continue processing; conflicts resolved when connectivity returns |
| Payment provider is slow (>2s response) | Circuit breaker with cached fallback | Prevent slow payments from blocking all booking requests |
| Redis cluster is temporarily unreachable | Bulkhead isolation + fallback to database | Fencing token operations degrade to database-level locks temporarily |
| Kafka consumer lag exceeds 5 minutes | Backpressure + alerting | Proactive intervention before events become too stale for conflict resolution |

---

## The Technology Stack

Now that you understand the principles, here is the technology stack that implements them. Every choice maps back to a specific requirement.

```yaml
Backend:
  Language: TypeScript/Node.js
  Framework: NestJS / Express
  Runtime: Node.js 20 LTS

Database:
  Primary: MySQL 8.0 (Sharded)
  Strategy: 16 shards with 5 replicas each
  ORM: TypeORM / Prisma

Caching:
  Technology: Redis Cluster
  Clusters: 4 separate (sessions, fencing, cache, rate-limiting)

Message Queue:
  Technology: Apache Kafka (KRaft mode, no ZooKeeper)
  Brokers: 15 nodes
  Partitions: 500+ total

Container Orchestration:
  Platform: Kubernetes (EKS/GKE)
  Service Mesh: Istio

Search:
  Engine: Elasticsearch / Algolia

Monitoring:
  Metrics: Prometheus + Grafana
  Logging: ELK Stack
  Tracing: OpenTelemetry + Jaeger
  Alerting: PagerDuty

Cloud Provider:
  Primary: AWS
  Regions: us-east-1, eu-west-1, ap-southeast-1, sa-east-1
```

Let us walk through the non-obvious choices:

**Why 4 separate Redis clusters?** Because mixing concerns in a single cluster is dangerous. If your rate-limiting logic suddenly needs more memory and evicts your fencing tokens, you have just made overselling possible. Separate clusters mean separate failure domains. The session cluster can crash without affecting the fencing token cluster.

| Redis Cluster | Purpose | Eviction Policy | Failure Impact if Mixed |
|---------------|---------|-----------------|------------------------|
| Sessions | User auth sessions, 7-day TTL | `volatile-lru` | Session loss forces re-login |
| Fencing | Distributed lock tokens | `noeviction` | **Overselling** -- critical |
| Cache | Search results, availability | `allkeys-lru` | Slightly slower responses |
| Rate-Limiting | Request counters, sliding window | `volatile-ttl` | Rate limits not enforced |

If these were combined into one cluster and memory pressure caused eviction, `allkeys-lru` would evict fencing tokens (they have no TTL). A fencing token eviction means the next write has no token to compare against, bypassing the safety check. This is why the fencing cluster uses `noeviction` -- it rejects new writes rather than evicting existing data. Mixing it with a cache cluster that uses `allkeys-lru` would override this policy.

**Why Kafka KRaft (no ZooKeeper)?** KRaft mode removes ZooKeeper as a dependency, simplifying operations. ZooKeeper was historically the coordination layer for Kafka, but it added another system to monitor, configure, and debug. KRaft moves coordination into Kafka itself.

> **Key Term:** **KRaft Mode** -- Kafka's built-in consensus protocol that replaces Apache ZooKeeper. KRaft handles metadata management, controller election, and topic configuration within Kafka itself, eliminating the need for an external coordination service.

**Why 16 shards?** A single MySQL instance handles about 10,000 writes/second comfortably. Our peak load is roughly 8,000-10,000 writes/second total. With 16 shards, each shard handles about 500-625 writes/second -- well within MySQL's comfort zone. This leaves room to grow 10x before needing to re-shard.

**Why 15 Kafka brokers?** At 500+ partitions with a replication factor of 3, each broker manages approximately 100 partition replicas. This keeps the per-broker load manageable and allows for broker maintenance (rolling restarts) without impacting throughput. With 15 brokers, losing one broker shifts only ~7% of the load to the remaining 14.

> **Checkpoint:** Can you explain why we use 4 separate Redis clusters instead of one large cluster? What could go wrong if we combined them? Try to name a specific failure scenario involving two different Redis use cases conflicting with each other.

---

## Chapter Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Scale Requirements | 1,666 bookings/sec, 1M concurrent users, 99.99% uptime (52.6 min/year downtime) |
| Financial Stakes | $566K/second in bookings; a 1-minute outage costs $34M in potential revenue |
| Fencing Tokens | Every inventory write carries a monotonically increasing token; stale tokens are rejected to prevent overselling |
| Double-Entry Accounting | Every financial operation creates balanced debits and credits in an immutable, hash-chained ledger |
| Active-Active | Four AWS regions process bookings independently; conflicts resolved via Kafka event ordering and fencing tokens |
| Graceful Degradation | Circuit breakers, bulkheads, and retry budgets prevent any single failure from cascading |
| Principle Violations Checklist | A code review checklist mapping common mistakes to the principles they violate |
| Technology Stack | TypeScript/NestJS, MySQL 8.0 (16 shards), Redis Cluster (4 clusters), Kafka KRaft (15 nodes), Kubernetes |

---

# Chapter 6: System Architecture Deep Dive

## The Big Picture

In Chapter 4, you saw a high-level overview of the system: seven services, two communication styles, Kubernetes for orchestration. Now we zoom in. This chapter shows you the exact architecture diagram, the exact replica counts, the exact data flow, and the actual code that services use to talk to each other. By the end of this chapter, you will be able to trace any request from ingress to database to event bus and explain why every component exists.

This is the chapter you will reference most often during implementation. Bookmark it.

---

## The Architecture Diagram

Here is how a user request flows through the system:

```
                                    ┌──────────────────┐
                                    │  Route 53 / DNS  │
                                    │ (Latency-based)  │
                                    └────────┬─────────┘
                                             │
                                    ┌────────v─────────┐
                                    │   Global CDN     │
                                    │  (CloudFront)    │
                                    │  Static assets,  │
                                    │  edge caching    │
                                    └────────┬─────────┘
                                             │
                                    ┌────────v─────────┐
                                    │  API Gateway     │
                                    │  (Kong/NGINX)    │
                                    │  Auth, Rate Limit│
                                    │  10 replicas     │
                                    └────────┬─────────┘
                                             │
          ┌────────────┬─────────────┬───────┴───────┬──────────────┬────────────┐
          │            │             │               │              │            │
   ┌──────v──────┐ ┌───v────────┐ ┌──v──────────┐ ┌──v──────────┐ ┌─v─────────┐ │
   │   User      │ │  Search    │ │  Booking    │ │  Inventory  │ │  Payment  │ │
   │  Service    │ │  Service   │ │  Service    │ │  Service    │ │  Service  │ │
   │  10 reps    │ │  12 reps   │ │  20 reps    │ │  15 reps    │ │  12 reps  │ │
   └──────┬──────┘ └───┬────────┘ └──┬──────────┘ └──┬──────────┘ └─┬─────────┘ │
          │            │             │               │              │            │
          │       ┌────v────────┐    │          ┌────v────────┐     │            │
          │       │Elasticsearch│    │          │    Redis     │     │            │
          │       │  Cluster    │    │          │   Clusters   │     │            │
          │       └─────────────┘    │          │  (4 clusters)│     │            │
          │                          │          └──────────────┘     │            │
          │                          │                               │            │
          └──────────────┬───────────┴───────────────────────────────┘            │
                         │                                                        │
                ┌────────v─────────┐                                              │
                │  MySQL 8.0       │                                              │
                │  (16 shards,     │                                              │
                │  5 replicas each)│                                              │
                └────────┬─────────┘                                              │
                         │                                                        │
                ┌────────v─────────────────────────────────────────────────────────┘
                │
       ┌────────v─────────┐
       │  Kafka Event Bus │
       │  (15 brokers,    │
       │   KRaft mode)    │
       └────────┬─────────┘
                │
       ┌────────┼─────────────────┬──────────────────┐
       │        │                 │                   │
  ┌────v──────┐ ┌──v──────────┐ ┌──v──────────┐ ┌────v────────┐
  │  Fraud    │ │ Notification│ │  Analytics  │ │ Event Store │
  │ Detection │ │  Service    │ │  Service    │ │  Service    │
  │  8 reps   │ │  8 reps     │ │  5 reps     │ │  8 reps     │
  └───────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

Read this top to bottom. Every user request starts at **Route 53**, which routes the user to the nearest healthy region based on latency. Static assets (images, CSS, JavaScript) are served from the **CloudFront CDN**. Dynamic API calls pass through to the **API Gateway**, which authenticates the user, checks rate limits, and routes the request to the correct service. The core services -- Booking, Inventory, Payment -- talk to each other synchronously (HTTP) and share Redis for caching and distributed locks. After completing their work, they publish events to the **Kafka Event Bus**. Downstream services -- Fraud Detection, Notifications, Analytics, Event Store -- consume those events asynchronously.

> **Key Term:** **CDN (Content Delivery Network)** -- A network of servers distributed globally that cache and serve static content (images, scripts, stylesheets) from locations close to the user. CloudFront is AWS's CDN. It reduces latency because a user in Tokyo gets static assets from a Tokyo edge server instead of from Virginia.

> **Analogy:** The architecture is like a hospital. The front desk (API Gateway) triages every patient. Critical cases go to the ER (Booking Service). The ER calls the pharmacy (Inventory Service) for medication and the billing department (Payment Service) for insurance. After treatment, the ER files reports -- the hospital newsletter (Notification Service) sends the patient a summary, the research department (Analytics Service) logs the case for studies, and the fraud department checks for insurance fraud. The front desk never tells the newsletter to send an email directly. Everything flows through the proper channels.

---

## Microservices Breakdown: Every Service in Detail

Here is every service in the system, what it does, what technology it uses, how many replicas it runs per region, and -- critically -- **why** each technology choice was made.

### API Gateway — The Gatekeeper

| Property | Value |
|----------|-------|
| Technology | Kong / NGINX |
| Replicas per region | 10 |
| Port | 443 (external), 8000 (internal) |
| Dependencies | Auth Service (JWT validation), Redis (rate limiting) |

**Responsibility:** Every single request from the outside world enters through the API Gateway. It handles TLS termination, JWT validation, rate limiting (1,000 req/sec per client), request routing, CORS enforcement, and response header injection (security headers like `Strict-Transport-Security`).

**Why Kong and not a custom Node.js gateway?** Kong is written in C (via OpenResty/Lua on top of NGINX) and handles 50,000+ requests/second per instance. A Node.js gateway would need 10x more instances for the same throughput. Kong also provides a plugin ecosystem for authentication, rate limiting, logging, and transformation without writing custom code.

> **Why Not AWS API Gateway (managed)?** AWS API Gateway charges per request ($3.50/million). At 1,666 requests/second, that is roughly 4.3 billion requests/month, costing approximately **$15,000/month** just for the gateway. A self-hosted Kong cluster costs a fraction of that and gives us full control over routing logic, custom plugins, and multi-region deployment without vendor lock-in.

---

### Booking Service — The Orchestrator

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS |
| Replicas per region | 20 |
| Port | 3000 |
| Dependencies | Inventory Service (sync), Payment Service (sync), Kafka (async), MySQL, Redis |

**Responsibility:** The booking service is the **orchestrator**. It does not check inventory itself. It does not charge credit cards itself. It coordinates: "Inventory, reserve that room. Payment, charge the customer. Kafka, publish the event." If any step fails, it triggers compensating transactions (the Saga pattern). It manages the full booking lifecycle: creation, confirmation, modification, cancellation, and completion.

**Why 20 replicas?** This is the highest-throughput service. Every booking flows through it. At 1,666 bookings/second, each replica handles approximately 83 bookings/second. Each booking involves multiple downstream calls (inventory check, payment processing), so each request occupies a connection for 200-500ms. With Node.js handling requests concurrently via the event loop, 83 requests/second is well within the comfort zone for a single instance with 512MB RAM.

```typescript
// ============================================
// Booking Service: NestJS Module Structure
// ============================================

// src/app.module.ts — Root module
import { Module } from '@nestjs/common';
import { BookingModule } from './booking/booking.module';
import { HealthModule } from './health/health.module';
import { KafkaModule } from './kafka/kafka.module';
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    DatabaseModule,     // MySQL connection with shard routing
    RedisModule,        // Redis for caching and distributed locks
    KafkaModule,        // Event publishing
    BookingModule,      // Core booking logic
    HealthModule,       // K8s liveness/readiness probes
  ],
})
export class AppModule {}
```

```typescript
// src/booking/booking.module.ts — Feature module
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { BookingSagaService } from './booking-saga.service';
import { Booking } from './entities/booking.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { KafkaModule } from '../kafka/kafka.module';
import { InventoryClientModule } from '../clients/inventory-client.module';
import { PaymentClientModule } from '../clients/payment-client.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, OutboxEvent]),
    HttpModule.register({
      timeout: 2000,
      maxRedirects: 0,
    }),
    KafkaModule,
    InventoryClientModule,
    PaymentClientModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingSagaService],
  exports: [BookingService],
})
export class BookingModule {}
```

```typescript
// src/booking/booking.controller.ts — HTTP endpoints
import {
  Controller, Post, Get, Param, Body,
  Headers, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { BookingService } from './booking.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';

@Controller('api/v1/bookings')
@UseGuards(JwtAuthGuard)
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)  // 202: booking is async
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: TokenPayload,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-request-id') requestId: string,
  ) {
    return this.bookingService.create({
      ...dto,
      userId: user.userId,
      idempotencyKey,
      requestId,
      region: process.env.REGION,
    });
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: TokenPayload,
  ) {
    return this.bookingService.findByIdForUser(id, user.userId);
  }
}
```

```typescript
// src/booking/booking.service.ts — Business logic (simplified)
import { Injectable, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Booking } from './entities/booking.entity';
import { OutboxEvent } from '../outbox/entities/outbox-event.entity';
import { InventoryClient } from '../clients/inventory.client';
import { PaymentClient } from '../clients/payment.client';

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly dataSource: DataSource,
    private readonly inventoryClient: InventoryClient,
    private readonly paymentClient: PaymentClient,
  ) {}

  async create(data: CreateBookingInput): Promise<BookingResponse> {
    // Step 0: Idempotency check
    const existing = await this.bookingRepo.findOne({
      where: {
        userId: data.userId,
        idempotencyKey: data.idempotencyKey,
      },
    });
    if (existing) {
      return this.toResponse(existing); // Return existing booking
    }

    // Step 1: Reserve inventory (sync call with circuit breaker)
    const hold = await this.inventoryClient.reserveInventory({
      resourceType: data.bookingType,
      resourceId: data.resourceId,
      resourceDate: data.resourceDate,
      quantity: data.quantity,
      userId: data.userId,
    });

    try {
      // Step 2: Process payment (sync call with circuit breaker)
      const payment = await this.paymentClient.processPayment({
        amount: data.totalAmount,
        currency: data.currency,
        userId: data.userId,
        bookingReference: data.referenceCode,
      });

      // Step 3: Save booking + outbox event in ONE transaction
      const booking = await this.dataSource.transaction(async (manager) => {
        const newBooking = manager.create(Booking, {
          userId: data.userId,
          bookingType: data.bookingType,
          referenceCode: this.generateReferenceCode(data.bookingType),
          idempotencyKey: data.idempotencyKey,
          subtotal: data.subtotal,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          totalAmount: data.totalAmount,
          currency: data.currency,
          status: 'confirmed',
          confirmedAt: new Date(),
        });
        const savedBooking = await manager.save(newBooking);

        // Outbox event for Kafka (same transaction!)
        const outboxEvent = manager.create(OutboxEvent, {
          aggregateType: 'booking',
          aggregateId: savedBooking.id,
          eventType: 'booking.confirmed',
          payload: JSON.stringify({
            bookingId: savedBooking.id,
            userId: data.userId,
            resourceType: data.bookingType,
            resourceId: data.resourceId,
            amount: data.totalAmount,
            region: data.region,
          }),
          topic: 'booking.confirmed',
          partitionKey: String(data.userId),
          status: 'pending',
        });
        await manager.save(outboxEvent);

        return savedBooking;
      });

      return this.toResponse(booking);
    } catch (error) {
      // Compensating transaction: release the hold
      await this.inventoryClient.releaseHold(hold.holdId);
      throw error;
    }
  }
}
```

---

### Inventory Service — The Guardian of Availability

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS |
| Replicas per region | 15 |
| Port | 3000 |
| Dependencies | MySQL (shard), Redis (fencing tokens, caching), Kafka |

**Responsibility:** The single source of truth for what is available right now. How many rooms does the Hilton Tokyo have on March 17? Three seats left on Flight BA-207? This service manages the fencing token mechanism (Principle 1), temporary inventory holds with the state machine (active/confirmed/expired/released/cancelled), and overbooking limits.

**Why 15 replicas?** Every booking requires at least one inventory check, and search queries also hit inventory for real-time availability counts. The search-to-booking ratio is typically 50:1 (users search 50 times for every booking they make), multiplying the load on this service.

---

### Payment Service — The Accountant

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS |
| Replicas per region | 12 |
| Port | 3000 |
| Dependencies | Stripe/Adyen (external), MySQL, Kafka |

**Responsibility:** Processes charges, refunds, partial refunds, and chargebacks. Maintains the immutable payment ledger with hash chaining (Principle 2). Integrates with payment gateways (Stripe, Adyen) and handles currency conversion for international bookings. This service is deliberately isolated -- if the Search Service has a bug, payment logic stays untouched.

**Why 12 replicas?** Payment processing is I/O-bound (waiting for Stripe's API response, typically 500ms-2s). Each replica can handle roughly 100-140 concurrent payment requests. At 1,666 bookings/second, 12 replicas provide comfortable headroom.

> **Common Mistake:** Some teams put payment logic inside the Booking Service "to simplify things." This means a bug in booking search logic could crash the payment processor. Separate services mean separate blast radii. A memory leak in the Booking Service never affects payment processing.

---

### Search Service — The Researcher

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS + Algolia/Elasticsearch |
| Replicas per region | 12 |
| Port | 3000 |
| Dependencies | Elasticsearch/Algolia, Redis (cache), Kafka (index updates) |

**Responsibility:** Handles complex search queries -- "hotels in Paris, March 15-20, under $200/night, with pool, sorted by guest rating." It queries Elasticsearch indexes and returns paginated, sorted, filtered results in single-digit milliseconds. Supports autocomplete, fuzzy matching, and geo queries.

**Why Elasticsearch/Algolia and not MySQL?** MySQL is terrible at full-text search, fuzzy matching, and geo queries. A query like "find hotels near Times Square with a pool, sorted by guest rating" requires a combination of geo-distance calculations, full-text indexing, faceted filtering, and relevance scoring. Elasticsearch is purpose-built for this. MySQL would require multiple sequential queries and application-level aggregation.

---

### Fraud Detection Service — The Investigator

| Property | Value |
|----------|-------|
| Technology | Node.js + Python (ML models) |
| Replicas per region | 8 |
| Port | 3000 |
| Dependencies | Kafka (event-driven), MySQL (fraud rules), Redis (device fingerprints) |

**Responsibility:** Scores every booking for fraud risk. Uses device fingerprints, email reputation, velocity checks (how many bookings from this IP in the last hour?), and ML models trained on historical fraud data. High-risk bookings are flagged for manual review.

**Why Python alongside Node.js?** The fraud scoring models are trained using scikit-learn and TensorFlow, which are Python ecosystems. The Node.js layer handles the API and event consumption; the Python layer runs the ML inference. They communicate via gRPC for low-latency model calls.

---

### Notification Service — The Messenger

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS |
| Replicas per region | 8 |
| Port | 3000 |
| Dependencies | Kafka (event-driven), SendGrid/Twilio (external), Redis (template cache) |

**Responsibility:** Sends confirmation emails, SMS alerts, push notifications, and partner notifications. Listens to Kafka events ("booking.confirmed", "payment.failed", "flight.delayed") and delivers the right message through the right channel.

**Why only 8 replicas?** Notifications are asynchronous and non-blocking. A slight delay (2-5 seconds) in sending a confirmation email is acceptable. The service consumes Kafka events at its own pace.

---

### Analytics Service — The Data Scientist

| Property | Value |
|----------|-------|
| Technology | Python + Apache Spark |
| Replicas per region | 5 |
| Port | N/A (batch processing) |
| Dependencies | Kafka (event source), MySQL (read replicas), S3 (data lake) |

**Responsibility:** Aggregates booking data for business intelligence -- revenue reports, occupancy rates, booking trends, conversion funnels. Processes events in batch, not real-time.

**Why only 5 replicas and Python/Spark?** Analytics is batch-oriented, not user-facing. It does not need to respond within 200ms. Spark excels at processing large datasets across multiple nodes. Python's data ecosystem (pandas, numpy, matplotlib) is unmatched for analysis.

---

### Event Store Service — The Historian

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS |
| Replicas per region | 8 |
| Port | 3000 |
| Dependencies | Kafka (event consumption), MySQL (event storage) |

**Responsibility:** Persists every event from the Kafka stream into the `booking_events` table for event sourcing. Enables time-travel debugging ("what did booking #12345 look like at 2PM yesterday?") and aggregate reconstruction.

---

### User Service — The Identity Manager

| Property | Value |
|----------|-------|
| Technology | Node.js 20 LTS + NestJS |
| Replicas per region | 10 |
| Port | 3000 |
| Dependencies | MySQL, Redis (sessions), Kafka |

**Responsibility:** Authentication (login, registration, password reset, OAuth), profile management, preferences, and JWT token issuance. Every authenticated request in the system traces back to a token issued by this service.

---

## Architecture Decision Records (ADRs)

Every significant technology choice has an ADR that documents **what** was decided, **why**, and **what alternatives were considered**. Here are the three most important ones.

### ADR-001: Why NestJS over Express?

| Aspect | Express | NestJS |
|--------|---------|--------|
| Structure | None by default | Modules, controllers, services, providers |
| Dependency Injection | Manual or third-party | Built-in, first-class |
| TypeScript | Bolted-on | First-class, decorators everywhere |
| Microservice Support | Manual implementation | Built-in transports: Kafka, Redis, gRPC, RabbitMQ |
| Validation | Manual (joi, zod) | Built-in pipes with class-validator |
| Testing | Manual setup | Built-in testing module with DI overrides |
| Learning Curve | Low | Medium |
| Community | Larger (older) | Large and growing |

**Decision:** NestJS.

**Rationale:** With 10 microservices, each with multiple modules, we need enforced structure. Express gives you freedom, but that freedom means every developer makes different organizational decisions. Service A has `routes/booking.js`, Service B has `controllers/booking.controller.ts`, Service C has `handlers/booking-handler.ts`. NestJS eliminates this chaos. Every service follows the same pattern: module, controller, service, entity, DTO. A developer who learns the Booking Service structure can immediately navigate the Payment Service.

NestJS's built-in Kafka transport is particularly valuable. Setting up a Kafka consumer in Express requires 50+ lines of boilerplate. In NestJS:

```typescript
// Express: Manual Kafka consumer setup (50+ lines)
const { Kafka } = require('kafkajs');
const kafka = new Kafka({ brokers: ['kafka:9092'] });
const consumer = kafka.consumer({ groupId: 'booking-service' });
await consumer.connect();
await consumer.subscribe({ topic: 'payment.processed' });
await consumer.run({
  eachMessage: async ({ topic, partition, message }) => {
    const event = JSON.parse(message.value.toString());
    // manually route to correct handler based on event type
    // manually handle errors
    // manually handle offset commits
    // manually handle deserialization
  },
});

// NestJS: Declarative Kafka consumer (3 lines of business logic)
@Controller()
export class BookingEventsController {
  @EventPattern('payment.processed')
  async handlePaymentProcessed(@Payload() event: PaymentProcessedEvent) {
    await this.bookingService.confirmBooking(event.bookingId);
  }
}
```

> **Why Not Express?** Express is the right choice for small projects and prototypes. For a 10-service platform where consistency across services, dependency injection for testability, and built-in microservice transports matter, NestJS's structure pays for its learning curve within the first month.

---

### ADR-002: Why MySQL over PostgreSQL?

| Aspect | MySQL 8.0 | PostgreSQL 15 |
|--------|-----------|---------------|
| Write throughput | 10,000-15,000 writes/sec (InnoDB) | 5,000-10,000 writes/sec |
| Replication | Native async + semi-sync, battle-tested | Streaming replication, slightly newer |
| Sharding | `PARTITION BY HASH` built-in | Requires Citus extension or manual |
| JSON support | Native JSON type, fair querying | Superior JSONB with indexing |
| Operational maturity | 30+ years, massive DBA talent pool | 35+ years, strong but smaller DBA pool |
| Cloud support | AWS RDS/Aurora, GCP Cloud SQL | AWS RDS/Aurora, GCP Cloud SQL |
| Connection model | Thread-per-connection | Process-per-connection (heavier) |
| Memory usage | Lower per-connection overhead | Higher per-connection overhead |

**Decision:** MySQL 8.0.

**Rationale:** Our primary need is **write throughput** and **sharding**. MySQL's InnoDB engine with `PARTITION BY HASH` gives us table-level sharding without third-party extensions. MySQL's thread-per-connection model uses less memory than PostgreSQL's process-per-connection model, which matters when each shard has hundreds of connections from 20+ Booking Service replicas.

PostgreSQL's JSONB support is superior, but we use JSON columns primarily for event payloads (read-heavy, write-once), not for queried documents. MySQL's JSON type is sufficient for this use case.

> **Why Not PostgreSQL?** PostgreSQL would also work for this system. The deciding factors were MySQL's native partitioning support (no external extensions), lower per-connection memory overhead (critical at 16 shards x 5 replicas = 80 database instances), and the team's existing MySQL expertise. If the system needed complex JSONB queries or advanced indexing (GIN, GiST), PostgreSQL would be the better choice.

> **Common Mistake:** Choosing a database based on popularity rather than workload characteristics. PostgreSQL is often called "more advanced," but "more advanced" features (CTEs, window functions, JSONB indexing) only matter if your workload uses them. Our workload is: high-volume writes, hash-based lookups, and simple range queries. MySQL excels at this.

---

### ADR-003: Why Kafka over RabbitMQ?

| Aspect | Apache Kafka | RabbitMQ |
|--------|-------------|----------|
| Model | Distributed log (append-only) | Message queue (deliver and forget) |
| Message retention | Configurable (days, weeks, forever) | Deleted after consumption |
| Consumer groups | Built-in, parallel consumption | Competing consumers pattern |
| Throughput | 1M+ messages/sec per cluster | 20,000-50,000 messages/sec |
| Message replay | Yes (consumers can seek to any offset) | No (once consumed, gone) |
| Ordering | Per-partition ordering guaranteed | Per-queue ordering |
| Multi-region | MirrorMaker for cross-region replication | Shovel/Federation plugins |
| Operational complexity | Higher (ZooKeeper/KRaft, partitions) | Lower (simpler to set up) |

**Decision:** Apache Kafka (KRaft mode).

**Rationale:** Three features make Kafka essential for our system:

1. **Message replay.** When we deploy a new Analytics Service, it needs to process all historical booking events, not just new ones. Kafka retains messages for 30 days. The new service sets its consumer offset to the beginning and replays the entire history. RabbitMQ deletes messages after they are consumed -- no replay possible.

2. **Multi-consumer support.** A single `booking.confirmed` event needs to be consumed by four services independently: Notification (send email), Analytics (record metrics), Search (update index), and Fraud (score for risk). In Kafka, each service has its own consumer group and reads from the same topic independently. In RabbitMQ, you would need to set up a fanout exchange with four separate queues, adding operational complexity.

3. **Throughput.** At 1,666 bookings/second, with 7+ events per booking, the event stream handles approximately 12,000 events/second. Kafka handles this easily on a 15-broker cluster. RabbitMQ would require significant tuning and might still struggle at peak load.

> **Why Not RabbitMQ?** RabbitMQ is excellent for task queues ("process this job exactly once") and simple pub/sub. If our system only needed "send this email" and "process this payment" message passing without replay, audit trails, or multi-region replication, RabbitMQ would be simpler. But our event-driven architecture requires message retention (for replay), per-partition ordering (for consistency), and multi-region replication (for active-active). These are Kafka's strengths.

---

## Service Dependency Graph

Understanding which services depend on which is critical for failure analysis. Here is the complete dependency graph:

```
Service Dependencies (arrows = "depends on"):

API Gateway ──────► User Service (JWT validation)
    │
    ├──────────────► Booking Service
    │                   ├──► Inventory Service (sync: reserve)
    │                   ├──► Payment Service (sync: charge)
    │                   ├──► MySQL (write: bookings, outbox)
    │                   ├──► Redis (cache, idempotency)
    │                   └──► Kafka (async: publish events)
    │
    ├──────────────► Search Service
    │                   ├──► Elasticsearch (query)
    │                   └──► Redis (cache search results)
    │
    ├──────────────► Inventory Service
    │                   ├──► MySQL (read/write: inventory)
    │                   ├──► Redis (fencing tokens, locks)
    │                   └──► Kafka (async: publish changes)
    │
    └──────────────► Payment Service
                        ├──► Stripe/Adyen (external: charge)
                        ├──► MySQL (write: ledger, transactions)
                        └──► Kafka (async: publish events)

Kafka ─────────────► Notification Service
    │                   └──► SendGrid/Twilio (external: deliver)
    │
    ├──────────────► Fraud Detection Service
    │                   ├──► MySQL (fraud rules)
    │                   └──► Redis (device fingerprints)
    │
    ├──────────────► Analytics Service
    │                   ├──► MySQL read replicas
    │                   └──► S3 (data lake)
    │
    └──────────────► Event Store Service
                        └──► MySQL (write: booking_events)
```

**Critical path (synchronous):** API Gateway -> Booking Service -> Inventory Service -> Payment Service. Any failure in this chain affects the user directly.

**Non-critical path (asynchronous):** Kafka -> Notification/Analytics/Fraud/Event Store. Failures here do not affect the user's booking experience.

---

## Latency Budgets: How 200ms Becomes Reality

Our target end-to-end response time for booking creation is **under 200ms** (excluding payment provider latency, which adds 500ms-2s). Here is how the 200ms budget is allocated across services:

```
Latency Budget Breakdown (booking creation, p99):

┌─────────────────────────┬──────────┬─────────────────────────────────────┐
│ Component               │ Budget   │ Notes                               │
├─────────────────────────┼──────────┼─────────────────────────────────────┤
│ API Gateway routing     │  5ms     │ Kong request parsing + JWT extract  │
│ Auth (JWT verification) │  3ms     │ Symmetric key verification, no I/O  │
│ Network: GW → Booking   │  1ms     │ Same K8s cluster, sub-ms            │
│ Booking Service logic   │ 10ms     │ Validation, idempotency check       │
│ Network: Booking → Inv  │  1ms     │ Same K8s cluster                    │
│ Inventory Service       │ 25ms     │ Redis lock + MySQL update           │
│   ├─ Redis lock acquire │  5ms     │ Single SETNX command                │
│   ├─ MySQL fenced write │ 15ms     │ UPDATE with fencing token           │
│   └─ Redis lock release │  5ms     │ Single DEL command                  │
│ Network: Inv → Booking  │  1ms     │ Response return                     │
│ Network: Booking → Pay  │  1ms     │ Same K8s cluster                    │
│ Payment Service         │ varies   │ Stripe: 500ms-2s (external)         │
│ Network: Pay → Booking  │  1ms     │ Response return                     │
│ Booking DB transaction  │ 15ms     │ INSERT booking + INSERT outbox      │
│ Response serialization  │  2ms     │ JSON response                       │
├─────────────────────────┼──────────┼─────────────────────────────────────┤
│ Total (excl. payment)   │ ~65ms    │ Well under 200ms budget             │
│ Total (incl. payment)   │ ~565ms   │ Dominated by Stripe latency         │
└─────────────────────────┴──────────┴─────────────────────────────────────┘
```

**Key insight:** The internal services contribute only ~65ms of the total latency. The external payment provider (Stripe) dominates at 500ms-2s. This is why we process the payment synchronously but return a "confirmed" status immediately if both the inventory hold and payment succeed. The confirmation email is asynchronous via Kafka.

**How each budget is enforced:**

1. **Timeout enforcement.** Every inter-service call has a hard timeout: `timeout: 2000` in the HTTP client. If the Inventory Service does not respond in 2s, the call fails.
2. **Connection pooling.** Each service maintains a persistent HTTP connection pool to downstream services. No TCP handshake overhead per request.
3. **Query optimization.** All database queries are indexed. We monitor `slow_query_log` for any query exceeding 50ms and treat it as a P1 bug.
4. **Prometheus alerts.** If p99 latency for any inter-service call exceeds its budget for 5 minutes, a PagerDuty alert fires.

> **Checkpoint:** If the Inventory Service starts taking 100ms instead of 25ms (a 4x slowdown), what is the impact on the total booking time? Does it breach the 200ms internal budget? At what point does the circuit breaker trip?

---

## What Happens When Service X Goes Down?

For each critical service, here is the impact and the mitigation:

### Scenario 1: API Gateway goes down

| Aspect | Impact |
|--------|--------|
| User experience | **Total outage** -- no requests enter the system |
| Mitigation | 10 replicas with K8s health checks; unhealthy pods replaced in <30s |
| Recovery time | Automatic within 30 seconds (K8s restarts unhealthy pods) |
| Prevention | Multiple replicas behind the cloud load balancer; no single point of failure |

### Scenario 2: Booking Service goes down

| Aspect | Impact |
|--------|--------|
| User experience | Cannot create new bookings; search and existing bookings still work |
| Mitigation | 20 replicas; K8s auto-restarts failed pods |
| Recovery time | <30 seconds per pod |
| Data risk | None -- uncommitted bookings are simply not created; idempotency keys prevent duplicates on retry |

### Scenario 3: Inventory Service goes down

| Aspect | Impact |
|--------|--------|
| User experience | Cannot check availability or create bookings; search shows cached results |
| Mitigation | Circuit breaker returns cached availability data for searches; new bookings are rejected with a "try again later" message |
| Recovery time | <30 seconds per pod |
| Data risk | Inventory holds that were active when the service went down will expire (10-minute TTL) and be automatically released |

### Scenario 4: Payment Service goes down

| Aspect | Impact |
|--------|--------|
| User experience | Cannot complete new bookings; search and inventory checks still work |
| Mitigation | Booking Service's Saga pattern releases inventory holds when payment fails |
| Recovery time | <30 seconds per pod |
| Data risk | No double-charges -- Stripe's idempotency keys prevent duplicate payments on retry |

### Scenario 5: Kafka goes down

| Aspect | Impact |
|--------|--------|
| User experience | Bookings still complete (sync path works), but confirmation emails are delayed |
| Mitigation | Outbox Pattern -- events are stored in the database outbox table and published when Kafka recovers |
| Recovery time | Kafka with 15 brokers tolerates up to 4 broker failures (replication factor = 3) |
| Data risk | None -- events in the outbox are durable and will be published eventually |

### Scenario 6: MySQL Shard goes down

| Aspect | Impact |
|--------|--------|
| User experience | Users on that shard cannot create or view bookings; other shards are unaffected |
| Mitigation | Each shard has 4 read replicas; one can be promoted to primary within 60 seconds |
| Recovery time | 60-120 seconds for replica promotion |
| Data risk | Potential loss of up to 1 second of committed transactions (async replication lag); semi-synchronous replication reduces this to near-zero |

### Scenario 7: Redis goes down

| Aspect | Impact |
|--------|--------|
| User experience | Depends on which cluster: session cluster down = users must re-login; cache cluster down = slower responses; fencing cluster down = inventory operations pause |
| Mitigation | Each Redis cluster is independent; fencing cluster failure triggers fallback to database-level locking |
| Recovery time | Redis Cluster with 6 nodes tolerates 3 node failures (3 primary, 3 replica) |
| Data risk | Fencing cluster failure could temporarily widen the overselling window; the database CHECK constraint remains as the last line of defense |

---

## Data Flow: The Outbox Pattern

Here is how data flows through the system when a user creates a booking:

```
User Request --> API Gateway --> Booking Service --> Database
                    |                   |
                    |                   +---> Outbox Table ---> Kafka Event
                    |                                               |
                    |                                               +---> Notification Service
                    |                                               +---> Analytics Service
                    |                                               +---> Fraud Detection
                    |                                               +---> Event Store (Audit)
                    |
                    +---> Redis Cache
```

Notice that events are published through the **Outbox Table**, not by calling Kafka directly after a database commit. This is crucial.

> **Analogy:** Imagine you are a manager who needs to update some records AND send a letter about the change. If you update the records first and then hand the letter to a courier, what happens if the courier's van breaks down before they can deliver it? Your records are updated but nobody downstream knows. The Outbox Pattern is like putting the letter into your office's outbox tray as part of the same batch of paperwork. A mail clerk picks up everything from the tray and delivers it. The letter is never lost because it was part of the same batch of work -- if the paperwork went through, the letter is guaranteed to be in the tray for pickup.

> **Key Term:** **Outbox Pattern** -- A reliability pattern where events are written to an "outbox" table within the same database transaction as the business data. A separate publisher process reads pending events from the outbox and publishes them to Kafka. This guarantees that if the database transaction succeeds, the event will eventually be published -- even if the application crashes immediately after the commit.

Here is the failure scenario the Outbox Pattern prevents:

```typescript
// ============================================
// WRONG: This can lose events
// ============================================
async createBooking(data) {
  await this.db.insert('bookings', data);     // Step 1: DB write succeeds
  await this.kafka.publish('booking.created');  // Step 2: App crashes HERE
  // The booking exists in the database, but the event was never published.
  // The notification service never sends a confirmation email.
  // The analytics service never records the booking.
}
```

```typescript
// ============================================
// CORRECT: Outbox Pattern
// ============================================
async createBooking(data) {
  await this.db.transaction(async (trx) => {
    await trx.insert('bookings', data);
    await trx.insert('outbox_events', {
      event_type: 'booking.created',
      payload: JSON.stringify(data),
      topic: 'booking.confirmed',
      partition_key: String(data.userId),
      status: 'pending',
    });
    // Both writes are in the SAME transaction.
    // Either both succeed or both fail.
  });
  // A separate publisher process reads outbox_events
  // and publishes to Kafka.
}
```

The **Outbox Publisher** runs as a separate process (or a scheduled job within each service):

```typescript
// ============================================
// Outbox Publisher: Reads pending events and
// publishes them to Kafka
// ============================================
class OutboxPublisher {
  private readonly BATCH_SIZE = 100;
  private readonly POLL_INTERVAL_MS = 100; // 100ms polling

  async start() {
    while (true) {
      const events = await this.db.query(
        `SELECT * FROM outbox_events
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
        [this.BATCH_SIZE]
      );

      for (const event of events) {
        try {
          await this.kafka.publish({
            topic: event.topic,
            messages: [{
              key: event.partition_key,
              value: event.payload,
            }],
          });

          await this.db.query(
            `UPDATE outbox_events
             SET status = 'published', published_at = NOW()
             WHERE id = ?`,
            [event.id]
          );
        } catch (error) {
          await this.db.query(
            `UPDATE outbox_events
             SET retry_count = retry_count + 1,
                 last_retry_at = NOW(),
                 error_message = ?,
                 status = CASE
                   WHEN retry_count >= max_retries THEN 'failed'
                   ELSE 'pending'
                 END
             WHERE id = ?`,
            [error.message, event.id]
          );
        }
      }

      if (events.length === 0) {
        await sleep(this.POLL_INTERVAL_MS);
      }
    }
  }
}
```

> **What If You Skip This?** You will lose events. Not every time -- maybe one in ten thousand requests. But at 1,666 bookings/second, that is one lost event every six seconds. Over a day, that is 14,400 missing notifications, missing analytics records, and missing audit entries. The Outbox Pattern eliminates this failure mode.

---

## Service Communication: Kubernetes DNS

Services discover each other through Kubernetes DNS. Here is the actual code a service uses to call another service:

```typescript
// ============================================
// Service Client with K8s Service Discovery
// ============================================

class InventoryServiceClient {
  // Kubernetes service DNS -- the cluster load-balances across all pods
  private readonly baseUrl =
    'http://inventory-service.production.svc.cluster.local:3000';

  async checkAvailability(params: CheckAvailabilityParams): Promise<boolean> {
    const response = await axios.post(
      `${this.baseUrl}/api/inventory/check`,
      params,
      {
        timeout: 2000,
        headers: {
          'X-Request-ID': randomUUID(),
          'X-Service': 'booking-service'
        }
      }
    );
    return response.data.available;
  }
}
```

Let us break this down:

- **`inventory-service.production.svc.cluster.local`** -- This is a Kubernetes DNS name. `inventory-service` is the service name, `production` is the namespace, `svc.cluster.local` is the Kubernetes internal domain. When the Booking Service makes a request to this URL, Kubernetes automatically load-balances it across all 15 Inventory Service pods. You never specify a pod IP address.

- **`timeout: 2000`** -- Every inter-service call has a 2-second timeout. If the Inventory Service does not respond within 2 seconds, the request fails. This prevents one slow service from blocking the caller indefinitely. Without timeouts, a hung downstream service would cause the caller's request threads to pile up until it crashes too.

- **`'X-Request-ID': randomUUID()`** -- Every request gets a unique ID. This ID propagates through every service in the chain, so when you are debugging a failed booking, you can search your logs for that one request ID and see its entire journey: gateway -> booking -> inventory -> payment -> Kafka -> notification.

- **`'X-Service': 'booking-service'`** -- This header tells the receiving service who is calling. This is useful for access control ("only the booking service and admin service can call this endpoint") and for observability ("the booking service is making 500 requests/second to inventory -- is that normal?").

> **Key Term:** **Kubernetes Service DNS** -- Kubernetes provides built-in DNS resolution for services. Instead of hardcoding IP addresses (which change every time a pod restarts), you use a stable DNS name like `service-name.namespace.svc.cluster.local`. Kubernetes resolves this to the current set of healthy pod IPs and load-balances across them.

> **Key Term:** **X-Request-ID** -- A header containing a unique identifier (usually a UUID) that follows a request through every service it touches. Also called a **correlation ID** or **trace ID**. It is essential for debugging distributed systems where a single user action triggers calls across multiple services.

> **Analogy:** Think of a patient's hospital wristband. When you are admitted, you get a band with a unique ID. Every nurse, doctor, lab tech, and pharmacist scans that band before doing anything. At the end of your stay, the hospital can pull up your wristband number and see every interaction across every department -- blood drawn at 9 AM, X-ray at 10 AM, medication at 11 AM. The `X-Request-ID` is that wristband for a request traveling through your microservices. Without it, tracking a single user's journey across 5 services is like searching a hospital's records without a patient ID.

> **Common Mistake: Hardcoded Service Endpoints.** An earlier version of this code listed three specific pod IP addresses and implemented manual round-robin load balancing. This breaks when pods restart (they get new IPs), when pods are added for scaling, or when pods are removed during downtime. Always use the Kubernetes service DNS name and let the cluster handle load balancing.

---

## NestJS Module Structure: The Full Blueprint

Every microservice in our platform follows this exact directory structure. Once you learn one, you know them all.

```
booking-service/
├── src/
│   ├── app.module.ts              # Root module — imports all feature modules
│   ├── main.ts                    # Entry point — bootstraps the NestJS app
│   │
│   ├── booking/                   # Core feature module
│   │   ├── booking.module.ts      # Declares this feature's pieces
│   │   ├── booking.controller.ts  # HTTP endpoints (POST /bookings, etc.)
│   │   ├── booking.service.ts     # Business logic (orchestrates the saga)
│   │   ├── booking-saga.service.ts # Saga orchestration logic
│   │   ├── entities/
│   │   │   └── booking.entity.ts  # TypeORM entity (maps to MySQL table)
│   │   └── dto/
│   │       ├── create-booking.dto.ts   # Input validation shape
│   │       └── booking-response.dto.ts # Output shape
│   │
│   ├── clients/                   # Inter-service communication
│   │   ├── inventory-client.module.ts
│   │   ├── inventory.client.ts    # HTTP client with circuit breaker
│   │   ├── payment-client.module.ts
│   │   └── payment.client.ts      # HTTP client with circuit breaker
│   │
│   ├── outbox/                    # Outbox pattern implementation
│   │   ├── outbox.module.ts
│   │   ├── outbox.publisher.ts    # Polls outbox table, publishes to Kafka
│   │   └── entities/
│   │       └── outbox-event.entity.ts
│   │
│   ├── kafka/                     # Kafka producer/consumer config
│   │   ├── kafka.module.ts
│   │   └── kafka.service.ts       # Publish events to topics
│   │
│   ├── database/                  # Database configuration
│   │   ├── database.module.ts     # TypeORM/Prisma connection setup
│   │   └── shard-router.ts        # Routes queries to correct shard
│   │
│   ├── redis/                     # Redis configuration
│   │   ├── redis.module.ts
│   │   └── redis.service.ts       # Cache, locks, idempotency
│   │
│   ├── auth/                      # Auth guard and decorators
│   │   ├── jwt-auth.guard.ts      # Validates JWT on incoming requests
│   │   └── current-user.decorator.ts
│   │
│   └── health/                    # Kubernetes probes
│       ├── health.module.ts
│       └── health.controller.ts   # GET /health and GET /ready
│
├── test/
│   ├── booking.service.spec.ts    # Unit tests
│   ├── booking.controller.spec.ts # Controller tests
│   └── booking.e2e-spec.ts        # End-to-end tests
│
├── prisma/
│   └── schema.prisma              # Prisma schema (alternative to TypeORM)
│
├── Dockerfile
├── package.json
└── tsconfig.json
```

Here is the `main.ts` entry point that bootstraps the NestJS application:

```typescript
// src/main.ts — Application bootstrap
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { LoggingInterceptor } from './interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation pipe -- rejects malformed requests
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,        // Strip unknown properties
      forbidNonWhitelisted: true, // Throw on unknown properties
      transform: true,        // Auto-transform types
    }),
  );

  // Global exception filter -- standardized error responses
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global logging interceptor -- log every request/response
  app.useGlobalInterceptors(new LoggingInterceptor());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Booking Service running on port ${port}`);
}
bootstrap();
```

> **Key Term:** **Dependency Injection (DI)** -- Instead of a class creating its own dependencies (`new BookingService()`), NestJS creates them and passes them in automatically. This makes testing easy -- you can swap real services for mocks without changing the business logic code.

> **Checkpoint:** Look at the service communication code above. Why do we set a `timeout` of 2000 milliseconds? What would happen if we did not set a timeout at all and the Inventory Service had a bug that caused it to hang? Trace the failure from the Inventory Service back through the Booking Service to the user.

---

## Chapter Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Architecture Layers | Route 53 -> CDN -> API Gateway -> Core Services -> Kafka Event Bus -> Downstream Services |
| Replica Sizing | Each service gets replicas proportional to its load; Booking (20) needs more than Analytics (5) |
| ADR: NestJS over Express | NestJS provides enforced structure, DI, and built-in microservice transports across 10 services |
| ADR: MySQL over PostgreSQL | MySQL's native partitioning and lower connection overhead suit our write-heavy, shard-based workload |
| ADR: Kafka over RabbitMQ | Kafka's message replay, multi-consumer groups, and throughput (1M+ msg/sec) match our event-driven needs |
| Latency Budgets | Internal services contribute ~65ms; external payment provider dominates at 500ms-2s |
| Service Failure Isolation | Each service has documented failure impact, mitigation, and recovery time |
| Outbox Pattern | Write events to a database table in the same transaction as business data to guarantee delivery |
| K8s Service DNS | Use `service-name.namespace.svc.cluster.local` instead of hardcoded IPs for service discovery |
| X-Request-ID | A unique ID that follows a request through every service for end-to-end debugging |
| NestJS Module Structure | Every service follows: module -> controller -> service -> entity -> DTO |

---

# Chapter 7: Database Design & Sharding

## Why One Database Is Not Enough

You know MySQL. You have created tables, written queries, maybe even set up indexes. You have probably never thought about whether MySQL itself is the bottleneck -- because at your scale, it never has been.

Here is the math. A single MySQL instance can handle roughly **10,000 writes per second** under optimal conditions. Our system needs **1,666 bookings per second**. That sounds like plenty of headroom. But here is what you are not accounting for: each booking is not one write.

A single booking creation touches:
1. The `bookings` table (1 insert)
2. The `inventory` table (1 update to decrement availability)
3. The `inventory_holds` table (1 update to confirm the hold)
4. The `transactions` table (1 insert for the payment)
5. The `payment_ledger` table (1 insert for the audit trail)
6. The `booking_events` table (1 insert for event sourcing)
7. The `outbox_events` table (1 insert for Kafka publishing)

That is 7 writes per booking. At 1,666 bookings/second, that is **11,662 writes/second**. A single MySQL instance is already over capacity before you account for read queries, search operations, and background jobs.

> **Analogy:** Think of a single librarian handling every request in a massive library. Returns, checkouts, questions, shelving -- one person. At 10 visitors, no problem. At 10,000 visitors, the line stretches out the door and wraps around the block. You do not fix this by giving the librarian a faster computer. You hire more librarians and give each one their own section. That is sharding.

---

## Enter Sharding

> **Key Term:** **Sharding** -- Splitting a database's data across multiple independent database servers (called **shards**). Each shard holds a subset of the total data. Queries are routed to the correct shard based on a **shard key**. Sharding is horizontal scaling for databases -- instead of one big server, you have many smaller servers working in parallel.

Our system uses **16 shards**. Each shard is a complete MySQL instance with its own storage, its own connections, and its own compute. To determine which shard holds a user's data, we use a hash function:

```sql
-- Shard determination
shard_number = hash(user_id) % 16

-- Example:
-- user_id = 12345
-- shard = hash(12345) % 16 = 7
-- Route to shard_07
```

**Configuration per shard:**
- 1 primary instance (handles writes)
- 4 read replicas (handle read queries)
- Cross-region replication for disaster recovery

**Total infrastructure:** 16 shards x 5 instances = **80 MySQL instances** across all regions.

> **Key Term:** **Read Replica** -- A copy of a database that receives a continuous stream of changes from the primary instance. Read replicas handle read queries (SELECT), reducing load on the primary, which focuses on writes (INSERT, UPDATE, DELETE). Our 4 replicas per shard mean we can handle 4x more read traffic without touching the primary.

> **Analogy:** Imagine a newspaper. The printing press (primary) produces the master copy. Then four copy machines (read replicas) make duplicates for distribution. When readers want the news, they read from the copies, not from the printing press. The printing press is only busy when there is new content to print. If one copy machine breaks, three others are still serving readers.

> **What If You Skip This?** At about 10,000 writes/second, your single database locks up. Queries that normally take 5ms start taking 500ms. Users see spinning loaders during checkout. Payment authorizations time out. Bookings fail. You lose revenue every second the database is overloaded.

> **Checkpoint:** If we have 16 shards and each shard handles roughly 1/16th of the write load, how many writes per second does each shard need to handle? Is that comfortably within MySQL's capacity of ~10,000 writes/second?

---

## Sharding Strategy Deep Dive: Hash-Based vs. Range-Based

There are two primary sharding strategies. We chose hash-based, but understanding both is essential.

### Hash-Based Sharding (Our Choice)

```
shard = hash(user_id) % number_of_shards

Advantages:
  + Even data distribution (assuming good hash function)
  + No hotspots (no single shard gets disproportionate traffic)
  + Simple routing logic
  + All user data on one shard (no cross-shard joins for user queries)

Disadvantages:
  - Range queries across users require scatter-gather (query all shards)
  - Adding shards requires resharding (rehashing all data)
  - Cannot easily move "hot" users to dedicated shards
```

### Range-Based Sharding (The Alternative)

```
shard = region_lookup(user_region)
  e.g., US users → shards 1-4
        EU users → shards 5-8
        APAC users → shards 9-12
        LATAM users → shards 13-16

Advantages:
  + Range queries within a region are efficient (single shard)
  + Adding shards is easier (split a range)
  + Can co-locate users with their data's geographic region

Disadvantages:
  - Uneven distribution (US might have 60% of users, creating hotspots)
  - Popular regions become bottlenecks
  - Rebalancing requires moving data between shards
```

### Why We Chose Hash-Based

| Factor | Hash-Based | Range-Based |
|--------|-----------|-------------|
| Data distribution | Even (guaranteed) | Uneven (depends on user distribution) |
| Hotspot risk | Low | High (popular regions) |
| Cross-shard queries | Required for "all users" queries | Required for cross-region queries |
| Resharding difficulty | High (must rehash) | Medium (split ranges) |
| Our workload fit | Excellent (user-centric queries) | Poor (60% US skew) |

Our booking queries are almost always user-centric:
- "Show me MY bookings" -- single shard (hash of my user_id)
- "Create a booking for ME" -- single shard
- "Show MY payment history" -- single shard

The rare admin query "show all bookings today" is a scatter-gather across all 16 shards, but admin queries represent less than 0.01% of total queries and are routed to read replicas.

> **Why Not Range-Based?** Our user base is geographically skewed: 45% US, 25% EU, 20% APAC, 10% LATAM. Range-based sharding by region would put 45% of all traffic on shards 1-4, making them hotspots. Hash-based sharding distributes users evenly regardless of their region.

---

## Shard Key Selection: Why `user_id`?

The shard key is the most important database design decision. It determines which shard stores each row and, critically, which queries can be answered by a single shard vs. requiring a scatter-gather across all shards.

| Candidate Shard Key | Single-Shard Queries | Cross-Shard Queries | Verdict |
|---------------------|---------------------|---------------------|---------|
| `user_id` | User bookings, payments, history | "All bookings today" (admin) | Best fit |
| `booking_id` | Single booking lookup | User's booking list (scatter-gather!) | Poor |
| `resource_id` (hotel) | Hotel availability | User bookings (scatter-gather!) | Poor |
| `created_at` (date) | Today's bookings | User history (scatter-gather!) | Poor |

**Why `user_id` wins:** A user's bookings, payments, and events are almost always accessed together. When a user views their booking history, we need their bookings, the associated payments, and the event timeline. If all of this data lives on the same shard, we can answer the query with a single database call. No cross-shard joins. No scatter-gather.

**The tradeoff:** Hotel-centric queries ("how many bookings does Hotel Tokyo-042 have?") require scatter-gather. But these are analytics queries that run on read replicas, not user-facing queries on the primary.

```typescript
// ============================================
// Shard Router: Routes queries to the correct shard
// ============================================
class ShardRouter {
  private readonly shardCount = 16;
  private readonly shardConnections: Map<number, DataSource>;

  constructor() {
    this.shardConnections = new Map();
    for (let i = 0; i < this.shardCount; i++) {
      this.shardConnections.set(i, new DataSource({
        type: 'mysql',
        host: `shard-${i.toString().padStart(2, '0')}.mysql.internal`,
        port: 3306,
        database: 'booking_platform',
        // ... connection options
      }));
    }
  }

  getShardForUser(userId: bigint): number {
    // Consistent hashing using murmur3
    return Number(this.murmurHash(userId) % BigInt(this.shardCount));
  }

  getConnection(userId: bigint): DataSource {
    const shard = this.getShardForUser(userId);
    return this.shardConnections.get(shard);
  }

  // For admin queries that need all shards
  async scatterGather<T>(
    query: string,
    params: any[]
  ): Promise<T[]> {
    const promises = Array.from(this.shardConnections.values()).map(
      (conn) => conn.query(query, params)
    );
    const results = await Promise.all(promises);
    return results.flat();
  }

  private murmurHash(value: bigint): bigint {
    // MurmurHash3 implementation for consistent distribution
    let hash = BigInt(0x811c9dc5);
    const bytes = Buffer.from(value.toString());
    for (const byte of bytes) {
      hash ^= BigInt(byte);
      hash = (hash * BigInt(0x01000193)) & BigInt(0xFFFFFFFF);
    }
    return hash;
  }
}
```

---

## The Core Tables: SQL and Prisma Side by Side

Now let us look at every important table in the system. For each table, I will show you the full SQL schema, the corresponding Prisma schema, and Prisma Client usage examples.

### The Bookings Table

This is the most important table in the entire system. Every booking -- hotel, flight, or car rental -- lives here.

**SQL Schema:**

```sql
CREATE TABLE bookings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- User & Type
    user_id BIGINT NOT NULL,
    booking_type VARCHAR(20) NOT NULL,  -- 'hotel', 'flight', 'car'
    reference_code VARCHAR(20) NOT NULL UNIQUE,  -- 'HT-20260215-000042'

    -- Idempotency
    idempotency_key VARCHAR(100) NOT NULL,

    -- Pricing
    subtotal DECIMAL(12,2) NOT NULL,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Status
    status ENUM('pending', 'confirmed', 'cancelled', 'completed', 'refunded')
        DEFAULT 'pending',

    -- Soft Delete
    deleted_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,

    UNIQUE KEY uniq_user_idempotency (user_id, idempotency_key),

    CONSTRAINT chk_amounts CHECK (
        subtotal >= 0 AND
        tax_amount >= 0 AND
        discount_amount >= 0 AND
        total_amount >= 0 AND
        total_amount = (subtotal + tax_amount - discount_amount)
    ),

    INDEX idx_user (user_id, deleted_at),
    INDEX idx_status (status, deleted_at),
    INDEX idx_type (booking_type),
    INDEX idx_created (created_at),
    INDEX idx_reference (reference_code)
) PARTITION BY HASH(user_id) PARTITIONS 16;
```

**Prisma Schema:**

```prisma
model Booking {
  id              BigInt    @id @default(autoincrement())
  userId          BigInt    @map("user_id")
  bookingType     String    @map("booking_type") @db.VarChar(20)
  referenceCode   String    @unique @map("reference_code") @db.VarChar(20)
  idempotencyKey  String    @map("idempotency_key") @db.VarChar(100)
  subtotal        Decimal   @db.Decimal(12, 2)
  taxAmount       Decimal   @default(0) @map("tax_amount") @db.Decimal(12, 2)
  discountAmount  Decimal   @default(0) @map("discount_amount") @db.Decimal(12, 2)
  totalAmount     Decimal   @map("total_amount") @db.Decimal(12, 2)
  currency        String    @default("USD") @db.Char(3)
  status          BookingStatus @default(pending)
  deletedAt       DateTime? @map("deleted_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  confirmedAt     DateTime? @map("confirmed_at")
  cancelledAt     DateTime? @map("cancelled_at")

  // Relations
  transactions    Transaction[]
  ledgerEntries   PaymentLedger[]
  events          BookingEvent[]

  @@unique([userId, idempotencyKey], map: "uniq_user_idempotency")
  @@index([userId, deletedAt], map: "idx_user")
  @@index([status, deletedAt], map: "idx_status")
  @@index([bookingType], map: "idx_type")
  @@index([createdAt], map: "idx_created")
  @@index([referenceCode], map: "idx_reference")
  @@map("bookings")
}

enum BookingStatus {
  pending
  confirmed
  cancelled
  completed
  refunded
}
```

**Prisma Client Usage:**

```typescript
// Create a booking with idempotency check
async function createBooking(data: CreateBookingInput) {
  // Idempotency: check if this booking already exists
  const existing = await prisma.booking.findUnique({
    where: {
      uniq_user_idempotency: {
        userId: data.userId,
        idempotencyKey: data.idempotencyKey,
      },
    },
  });

  if (existing) {
    return existing; // Return the existing booking
  }

  // Create within a transaction (booking + outbox event)
  return await prisma.$transaction(async (tx) => {
    const booking = await tx.booking.create({
      data: {
        userId: data.userId,
        bookingType: data.bookingType,
        referenceCode: generateReferenceCode(data.bookingType),
        idempotencyKey: data.idempotencyKey,
        subtotal: new Prisma.Decimal(data.subtotal),
        taxAmount: new Prisma.Decimal(data.taxAmount),
        discountAmount: new Prisma.Decimal(data.discountAmount),
        totalAmount: new Prisma.Decimal(data.totalAmount),
        currency: data.currency,
        status: 'confirmed',
        confirmedAt: new Date(),
      },
    });

    await tx.outboxEvent.create({
      data: {
        aggregateType: 'booking',
        aggregateId: booking.id,
        eventType: 'booking.confirmed',
        payload: JSON.stringify({ bookingId: booking.id, userId: data.userId }),
        topic: 'booking.confirmed',
        partitionKey: String(data.userId),
        status: 'pending',
      },
    });

    return booking;
  });
}

// Query bookings for a user (hits single shard via user_id)
const userBookings = await prisma.booking.findMany({
  where: {
    userId: BigInt(12345),
    deletedAt: null,
  },
  orderBy: { createdAt: 'desc' },
  take: 20,
});
```

Let us walk through the important column design decisions:

- **`idempotency_key`** -- This prevents duplicate bookings. If a user's browser sends the same booking request twice (network glitch, double-click), the second insert fails because the combination of `user_id` and `idempotency_key` is unique. The system returns the result of the first booking instead of creating a duplicate.

> **Key Term:** **Idempotency** -- The property that performing an operation multiple times produces the same result as performing it once. If a user clicks "Book Now" twice, the system should create one booking and return it both times, not create two bookings.

- **`DECIMAL(12,2)`** for money -- Never use `FLOAT` or `DOUBLE` for currency. Floating-point numbers introduce rounding errors. `DECIMAL(12,2)` stores exact values up to 9,999,999,999.99.

> **Common Mistake:** Using `FLOAT` for currency.
> ```typescript
> // WRONG: Floating-point arithmetic
> const price = 0.1 + 0.2;
> console.log(price); // 0.30000000000000004 -- NOT 0.3!
>
> // At scale, these errors compound:
> // 1,666 bookings/sec * $0.000000000000004 error per booking
> // = barely noticeable per booking
> // BUT: rounding errors accumulate in aggregate reports
> // After 1M bookings, the total might be off by $4-$40
> // That triggers an audit flag.
> ```

- **`chk_amounts` CHECK constraint** -- The database enforces that `total_amount = subtotal + tax_amount - discount_amount`. This catches application bugs where the math is wrong. If a developer accidentally sets `total_amount` to a value that does not match the breakdown, the INSERT fails.

- **`PARTITION BY HASH(user_id) PARTITIONS 16`** -- This is how MySQL implements sharding at the table level. Each partition maps to one of our 16 shards. When you query `WHERE user_id = 12345`, MySQL knows to check only partition 7 instead of scanning all 16.

- **`deleted_at` (soft delete)** -- We never physically delete bookings. Setting `deleted_at` to a timestamp marks the record as deleted. Queries include `WHERE deleted_at IS NULL` to filter them out. This lets us restore accidentally deleted records and maintains audit trails.

- **No foreign keys** -- Notice there are no `FOREIGN KEY` constraints. This is intentional. MySQL does not support foreign keys on partitioned tables (with `PARTITION BY HASH`). Referential integrity is enforced at the application layer by the `BookingService.validate()` method.

---

### The Inventory Table

This table tracks how many rooms, seats, or cars are available for each date.

**SQL Schema:**

```sql
CREATE TABLE inventory (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    resource_type ENUM('hotel_room', 'flight_seat', 'car') NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,

    -- Quantities
    total_quantity SMALLINT NOT NULL,
    available_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL DEFAULT 0,
    overbooking_limit SMALLINT DEFAULT 0,

    -- Distributed Locking
    fencing_token BIGINT,

    -- Pricing
    base_price DECIMAL(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Metadata
    last_updated_by VARCHAR(100),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT chk_available_quantity CHECK (available_quantity >= 0),
    CONSTRAINT chk_reserved_quantity CHECK (reserved_quantity >= 0),
    CONSTRAINT chk_total_quantity CHECK (total_quantity >= 0),
    CONSTRAINT chk_quantity_balance CHECK (
        available_quantity + reserved_quantity
            <= total_quantity + overbooking_limit
    ),

    UNIQUE KEY uniq_resource_date (resource_type, resource_id, resource_date),
    INDEX idx_resource (resource_type, resource_id),
    INDEX idx_date (resource_date),
    INDEX idx_availability (resource_type, resource_date, available_quantity),
    INDEX idx_fencing (resource_type, resource_id, fencing_token)
);
```

**Prisma Schema:**

```prisma
model Inventory {
  id                Int       @id @default(autoincrement())
  resourceType      ResourceType @map("resource_type")
  resourceId        BigInt    @map("resource_id")
  resourceDate      DateTime  @map("resource_date") @db.Date
  totalQuantity     Int       @map("total_quantity") @db.SmallInt
  availableQuantity Int       @map("available_quantity") @db.SmallInt
  reservedQuantity  Int       @default(0) @map("reserved_quantity") @db.SmallInt
  overbookingLimit  Int       @default(0) @map("overbooking_limit") @db.SmallInt
  fencingToken      BigInt?   @map("fencing_token")
  basePrice         Decimal   @map("base_price") @db.Decimal(10, 2)
  currency          String    @default("USD") @db.Char(3)
  lastUpdatedBy     String?   @map("last_updated_by") @db.VarChar(100)
  updatedAt         DateTime  @updatedAt @map("updated_at")

  @@unique([resourceType, resourceId, resourceDate], map: "uniq_resource_date")
  @@index([resourceType, resourceId], map: "idx_resource")
  @@index([resourceDate], map: "idx_date")
  @@index([resourceType, resourceDate, availableQuantity], map: "idx_availability")
  @@index([resourceType, resourceId, fencingToken], map: "idx_fencing")
  @@map("inventory")
}

enum ResourceType {
  hotel_room
  flight_seat
  car
}
```

**Prisma Client Usage:**

```typescript
// Check availability for a resource
const availability = await prisma.inventory.findUnique({
  where: {
    uniq_resource_date: {
      resourceType: 'hotel_room',
      resourceId: BigInt(42),
      resourceDate: new Date('2026-03-15'),
    },
  },
  select: {
    availableQuantity: true,
    basePrice: true,
    currency: true,
  },
});

// Fenced inventory update (must use raw SQL for atomic conditional update)
const affectedRows = await prisma.$executeRaw`
  UPDATE inventory
  SET available_quantity = available_quantity - 1,
      reserved_quantity = reserved_quantity + 1,
      fencing_token = ${fencingToken},
      last_updated_by = ${`user:${userId}`}
  WHERE resource_type = ${resourceType}
    AND resource_id = ${resourceId}
    AND resource_date = ${resourceDate}
    AND available_quantity > 0
    AND (fencing_token IS NULL OR fencing_token < ${fencingToken})
`;
```

Key design decisions:

- **`fencing_token BIGINT`** -- This is the column that enforces Principle 1 (Zero Overselling). Before updating this row, the service must acquire a distributed lock and receive a fencing token. The UPDATE statement includes `WHERE fencing_token < :new_token`. If another service already updated with a higher token, the WHERE clause matches zero rows, and the update does nothing.

- **`overbooking_limit`** -- Airlines routinely overbook by 5-10%. Hotels by 1-2%. This column allows intentional overbooking within a configurable limit. The `chk_quantity_balance` constraint ensures that `available + reserved` never exceeds `total + overbooking_limit`.

- **`chk_available_quantity CHECK (available_quantity >= 0)`** -- This is the database-level last line of defense against overselling. Even if the application logic has a bug, the database will reject any update that drops `available_quantity` below zero.

---

### The Inventory Holds Table (State Machine)

When a user starts the booking flow, we need to temporarily **hold** inventory. If the user takes 10 minutes to enter their credit card, we do not want someone else booking that last room from under them.

**SQL Schema:**

```sql
CREATE TABLE inventory_holds (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    hold_uuid VARCHAR(36) NOT NULL UNIQUE,

    -- Resource
    resource_type ENUM('hotel_room', 'flight_seat', 'car') NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,
    quantity SMALLINT NOT NULL,

    -- User Context
    user_id BIGINT NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    booking_id BIGINT,

    -- Distributed Locking
    fencing_token BIGINT NOT NULL,
    region VARCHAR(20) NOT NULL,

    -- State Machine
    status ENUM('active', 'confirmed', 'expired', 'released', 'cancelled')
        DEFAULT 'active',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    confirmed_at TIMESTAMP NULL,
    released_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,

    -- Metadata
    hold_reason VARCHAR(50),
    released_by VARCHAR(100),

    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_expiry CHECK (expires_at > created_at),

    UNIQUE KEY uniq_active_hold (
        resource_type, resource_id, resource_date,
        user_id, session_id, status
    ),

    INDEX idx_expires (expires_at, status),
    INDEX idx_user_session (user_id, session_id),
    INDEX idx_booking (booking_id),
    INDEX idx_status (status, created_at),
    INDEX idx_fencing (resource_type, resource_id, resource_date, fencing_token)
);
```

**Prisma Schema:**

```prisma
model InventoryHold {
  id            BigInt    @id @default(autoincrement())
  holdUuid      String    @unique @map("hold_uuid") @db.VarChar(36)
  resourceType  ResourceType @map("resource_type")
  resourceId    BigInt    @map("resource_id")
  resourceDate  DateTime  @map("resource_date") @db.Date
  quantity      Int       @db.SmallInt
  userId        BigInt    @map("user_id")
  sessionId     String    @map("session_id") @db.VarChar(100)
  bookingId     BigInt?   @map("booking_id")
  fencingToken  BigInt    @map("fencing_token")
  region        String    @db.VarChar(20)
  status        HoldStatus @default(active)
  createdAt     DateTime  @default(now()) @map("created_at")
  expiresAt     DateTime  @map("expires_at")
  confirmedAt   DateTime? @map("confirmed_at")
  releasedAt    DateTime? @map("released_at")
  cancelledAt   DateTime? @map("cancelled_at")
  holdReason    String?   @map("hold_reason") @db.VarChar(50)
  releasedBy    String?   @map("released_by") @db.VarChar(100)

  // Relations
  transitions   InventoryHoldTransition[]

  @@unique([resourceType, resourceId, resourceDate, userId, sessionId, status], map: "uniq_active_hold")
  @@index([expiresAt, status], map: "idx_expires")
  @@index([userId, sessionId], map: "idx_user_session")
  @@index([bookingId], map: "idx_booking")
  @@index([status, createdAt], map: "idx_status")
  @@index([resourceType, resourceId, resourceDate, fencingToken], map: "idx_fencing")
  @@map("inventory_holds")
}

enum HoldStatus {
  active
  confirmed
  expired
  released
  cancelled
}

model InventoryHoldTransition {
  id               BigInt    @id @default(autoincrement())
  holdId           BigInt    @map("hold_id")
  fromStatus       String    @map("from_status") @db.VarChar(20)
  toStatus         String    @map("to_status") @db.VarChar(20)
  transitionReason String?   @map("transition_reason") @db.VarChar(255)
  transitionedBy   String?   @map("transitioned_by") @db.VarChar(100)
  createdAt        DateTime  @default(now()) @map("created_at")

  hold             InventoryHold @relation(fields: [holdId], references: [id], onDelete: Cascade)

  @@index([holdId], map: "idx_hold")
  @@index([createdAt], map: "idx_created")
  @@map("inventory_hold_transitions")
}
```

**Prisma Client Usage:**

```typescript
// Create a hold with a transition record
async function createHold(data: CreateHoldInput) {
  return await prisma.$transaction(async (tx) => {
    const hold = await tx.inventoryHold.create({
      data: {
        holdUuid: randomUUID(),
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        resourceDate: data.resourceDate,
        quantity: data.quantity,
        userId: data.userId,
        sessionId: data.sessionId,
        fencingToken: data.fencingToken,
        region: process.env.REGION,
        status: 'active',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
        holdReason: 'booking_flow',
      },
    });

    // Record the initial transition
    await tx.inventoryHoldTransition.create({
      data: {
        holdId: hold.id,
        fromStatus: 'none',
        toStatus: 'active',
        transitionReason: 'User initiated booking flow',
        transitionedBy: `user:${data.userId}`,
      },
    });

    return hold;
  });
}

// Expire holds that have exceeded their TTL
async function expireStaleHolds() {
  const expiredHolds = await prisma.inventoryHold.findMany({
    where: {
      status: 'active',
      expiresAt: { lt: new Date() },
    },
    take: 100,
  });

  for (const hold of expiredHolds) {
    await prisma.$transaction(async (tx) => {
      await tx.inventoryHold.update({
        where: { id: hold.id },
        data: { status: 'expired' },
      });

      await tx.inventoryHoldTransition.create({
        data: {
          holdId: hold.id,
          fromStatus: 'active',
          toStatus: 'expired',
          transitionReason: '10-minute TTL exceeded',
          transitionedBy: 'hold-expiry-worker',
        },
      });

      // Release the inventory back
      await tx.$executeRaw`
        UPDATE inventory
        SET available_quantity = available_quantity + ${hold.quantity},
            reserved_quantity = reserved_quantity - ${hold.quantity}
        WHERE resource_type = ${hold.resourceType}
          AND resource_id = ${hold.resourceId}
          AND resource_date = ${hold.resourceDate}
      `;
    });
  }
}
```

> **Key Term:** **State Machine** -- A model where an entity can be in exactly one of a finite set of states, and transitions between states follow strict rules. In this table, a hold starts as `active` and can transition to `confirmed` (user completed the booking), `expired` (10-minute timer ran out), `released` (user abandoned the flow), or `cancelled` (user explicitly cancelled). An `expired` hold cannot transition to `confirmed` -- the rules are enforced in application code and logged in the transitions table.

> **Analogy:** Think of a fitting room at a clothing store. When you take a shirt into the fitting room, it is "on hold" -- other shoppers cannot buy it. You have 10 minutes. If you decide to buy it (confirmed), the hold converts to a purchase. If you take too long (expired), the attendant puts it back on the rack. If you decide you do not want it (released/cancelled), it goes back immediately. The shirt is always in exactly one state.

---

### The Transactions Table

**SQL Schema:**

```sql
CREATE TABLE transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT NOT NULL,

    -- Transaction Details
    transaction_type ENUM('payment', 'refund', 'chargeback') NOT NULL,
    payment_provider VARCHAR(50) NOT NULL,
    payment_method ENUM('credit_card', 'debit_card', 'paypal',
                        'bank_transfer', 'wallet') NOT NULL,

    -- Amounts
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,

    -- Provider Details
    provider_transaction_id VARCHAR(255) UNIQUE,
    provider_status VARCHAR(50),

    -- Status
    status ENUM('pending', 'processing', 'completed', 'failed', 'refunded')
        DEFAULT 'pending',

    -- Card Info (tokenized)
    card_last_4 CHAR(4),
    card_brand VARCHAR(20),

    -- Error Handling
    error_code VARCHAR(50),
    error_message TEXT,

    -- Soft Delete
    deleted_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    CONSTRAINT chk_transaction_amount CHECK (amount > 0),

    INDEX idx_booking (booking_id),
    INDEX idx_status (status),
    INDEX idx_provider_id (provider_transaction_id),
    INDEX idx_created (created_at)
);
```

**Prisma Schema:**

```prisma
model Transaction {
  id                    BigInt    @id @default(autoincrement())
  bookingId             BigInt    @map("booking_id")
  transactionType       TransactionType @map("transaction_type")
  paymentProvider       String    @map("payment_provider") @db.VarChar(50)
  paymentMethod         PaymentMethod @map("payment_method")
  amount                Decimal   @db.Decimal(12, 2)
  currency              String    @db.Char(3)
  providerTransactionId String?   @unique @map("provider_transaction_id") @db.VarChar(255)
  providerStatus        String?   @map("provider_status") @db.VarChar(50)
  status                TransactionStatus @default(pending)
  cardLast4             String?   @map("card_last_4") @db.Char(4)
  cardBrand             String?   @map("card_brand") @db.VarChar(20)
  errorCode             String?   @map("error_code") @db.VarChar(50)
  errorMessage          String?   @map("error_message") @db.Text
  deletedAt             DateTime? @map("deleted_at")
  createdAt             DateTime  @default(now()) @map("created_at")
  completedAt           DateTime? @map("completed_at")

  booking               Booking   @relation(fields: [bookingId], references: [id])

  @@index([bookingId], map: "idx_booking")
  @@index([status], map: "idx_status")
  @@index([providerTransactionId], map: "idx_provider_id")
  @@index([createdAt], map: "idx_created")
  @@map("transactions")
}

enum TransactionType {
  payment
  refund
  chargeback
}

enum PaymentMethod {
  credit_card
  debit_card
  paypal
  bank_transfer
  wallet
}

enum TransactionStatus {
  pending
  processing
  completed
  failed
  refunded
}
```

- **`card_last_4` and `card_brand`** -- We never store full credit card numbers. That would violate PCI-DSS (the Payment Card Industry Data Security Standard). We store only the last 4 digits and the brand (Visa, Mastercard) for display purposes. The actual card data is tokenized by the payment provider (Stripe, Adyen).

> **Key Term:** **Tokenization** -- Replacing sensitive data (like a credit card number) with a non-sensitive placeholder (a "token") that has no exploitable value. The payment provider keeps the mapping between the token and the real card number. Your system only stores the token. Even if your database is breached, attackers get useless tokens, not card numbers.

---

### The Payment Ledger (Immutable)

This is the financial backbone of the system. The ledger is the single source of truth for all monetary activity.

**SQL Schema:**

```sql
CREATE TABLE payment_ledger (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    booking_id BIGINT NOT NULL,
    transaction_id BIGINT,

    -- Event Type
    event_type ENUM(
        'authorization', 'authorization_void',
        'capture', 'partial_capture',
        'refund', 'partial_refund',
        'chargeback', 'chargeback_reversal'
    ) NOT NULL,

    -- Amounts
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    balance DECIMAL(12,2) NOT NULL,  -- Running balance

    -- Provider Details
    payment_provider VARCHAR(50) NOT NULL,
    provider_transaction_id VARCHAR(255),
    provider_reference VARCHAR(255),

    -- Metadata
    reason TEXT,
    processor_response_code VARCHAR(20),

    -- Blockchain-style Integrity
    record_hash VARCHAR(64) NOT NULL,
    previous_record_hash VARCHAR(64),

    -- Timestamps
    event_timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Initiated By
    initiated_by BIGINT,
    initiated_by_type ENUM('user', 'admin', 'system') NOT NULL,

    INDEX idx_booking (booking_id, event_timestamp),
    INDEX idx_transaction (transaction_id),
    INDEX idx_event_type (event_type),
    INDEX idx_timestamp (event_timestamp)
);

-- Immutability triggers
DELIMITER //

CREATE TRIGGER prevent_ledger_update
BEFORE UPDATE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Updates not allowed.';
END//

CREATE TRIGGER prevent_ledger_delete
BEFORE DELETE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Deletes not allowed.';
END//

DELIMITER ;
```

> **Key Term:** **SIGNAL SQLSTATE '45000'** -- MySQL's way of raising a user-defined error. When the trigger fires, it immediately raises this error, which aborts the UPDATE or DELETE operation. The row remains unchanged. Even a database administrator with root access cannot modify or delete ledger records without first dropping the triggers -- which would itself be logged in the database's general log.

> **What If You Skip This?** A developer accidentally runs `UPDATE payment_ledger SET amount = 0 WHERE booking_id = 12345` to "fix" a display bug. They just erased the financial record for that booking. When the customer disputes the charge, you have no audit trail. The immutability triggers make this impossible.

---

### The Outbox Events Table

This is the engine behind the Outbox Pattern we discussed in Chapter 6.

**SQL Schema:**

```sql
CREATE TABLE outbox_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,

    payload JSON NOT NULL,
    topic VARCHAR(100) NOT NULL,
    partition_key VARCHAR(100),

    status ENUM('pending', 'published', 'failed') DEFAULT 'pending',
    retry_count SMALLINT DEFAULT 0,
    max_retries SMALLINT DEFAULT 5,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,
    last_retry_at TIMESTAMP NULL,
    error_message TEXT,

    INDEX idx_status (status, created_at),
    INDEX idx_aggregate (aggregate_type, aggregate_id)
);
```

**Prisma Schema:**

```prisma
model OutboxEvent {
  id            BigInt    @id @default(autoincrement())
  aggregateType String    @map("aggregate_type") @db.VarChar(50)
  aggregateId   BigInt    @map("aggregate_id")
  eventType     String    @map("event_type") @db.VarChar(100)
  payload       Json
  topic         String    @db.VarChar(100)
  partitionKey  String?   @map("partition_key") @db.VarChar(100)
  status        OutboxStatus @default(pending)
  retryCount    Int       @default(0) @map("retry_count") @db.SmallInt
  maxRetries    Int       @default(5) @map("max_retries") @db.SmallInt
  createdAt     DateTime  @default(now()) @map("created_at")
  publishedAt   DateTime? @map("published_at")
  lastRetryAt   DateTime? @map("last_retry_at")
  errorMessage  String?   @map("error_message") @db.Text

  @@index([status, createdAt], map: "idx_status")
  @@index([aggregateType, aggregateId], map: "idx_aggregate")
  @@map("outbox_events")
}

enum OutboxStatus {
  pending
  published
  failed
}
```

---

### Booking Events (Event Store)

**SQL Schema:**

```sql
CREATE TABLE booking_events (
    id BIGINT AUTO_INCREMENT,

    event_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_version SMALLINT NOT NULL DEFAULT 1,

    aggregate_id BIGINT NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL DEFAULT 'booking',
    aggregate_version BIGINT NOT NULL,

    event_data JSON NOT NULL,
    event_metadata JSON,

    causation_id VARCHAR(36),
    correlation_id VARCHAR(36),

    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    partition_key VARCHAR(7) NOT NULL,  -- '2026-02'

    PRIMARY KEY (id, partition_key),
    UNIQUE KEY uniq_event (event_id, partition_key),

    INDEX idx_aggregate (aggregate_id, aggregate_version),
    INDEX idx_event_type (event_type),
    INDEX idx_occurred (occurred_at),
    INDEX idx_correlation (correlation_id)

) PARTITION BY RANGE COLUMNS(partition_key) (
    PARTITION p_2026_01 VALUES LESS THAN ('2026-02'),
    PARTITION p_2026_02 VALUES LESS THAN ('2026-03'),
    PARTITION p_2026_03 VALUES LESS THAN ('2026-04'),
    PARTITION p_2026_04 VALUES LESS THAN ('2026-05'),
    PARTITION p_2026_05 VALUES LESS THAN ('2026-06'),
    PARTITION p_2026_06 VALUES LESS THAN ('2026-07'),
    PARTITION p_2026_07 VALUES LESS THAN ('2026-08'),
    PARTITION p_2026_08 VALUES LESS THAN ('2026-09'),
    PARTITION p_2026_09 VALUES LESS THAN ('2026-10'),
    PARTITION p_2026_10 VALUES LESS THAN ('2026-11'),
    PARTITION p_2026_11 VALUES LESS THAN ('2026-12'),
    PARTITION p_2026_12 VALUES LESS THAN ('2027-01'),
    PARTITION p_future VALUES LESS THAN (MAXVALUE)
);
```

**Prisma Schema:**

```prisma
model BookingEvent {
  id               BigInt    @default(autoincrement())
  eventId          String    @map("event_id") @db.VarChar(36)
  eventType        String    @map("event_type") @db.VarChar(100)
  eventVersion     Int       @default(1) @map("event_version") @db.SmallInt
  aggregateId      BigInt    @map("aggregate_id")
  aggregateType    String    @default("booking") @map("aggregate_type") @db.VarChar(50)
  aggregateVersion BigInt    @map("aggregate_version")
  eventData        Json      @map("event_data")
  eventMetadata    Json?     @map("event_metadata")
  causationId      String?   @map("causation_id") @db.VarChar(36)
  correlationId    String?   @map("correlation_id") @db.VarChar(36)
  occurredAt       DateTime  @default(now()) @map("occurred_at")
  recordedAt       DateTime  @default(now()) @map("recorded_at")
  partitionKey     String    @map("partition_key") @db.VarChar(7)

  booking          Booking   @relation(fields: [aggregateId], references: [id])

  @@id([id, partitionKey])
  @@unique([eventId, partitionKey], map: "uniq_event")
  @@index([aggregateId, aggregateVersion], map: "idx_aggregate")
  @@index([eventType], map: "idx_event_type")
  @@index([occurredAt], map: "idx_occurred")
  @@index([correlationId], map: "idx_correlation")
  @@map("booking_events")
}
```

> **Key Term:** **Event Sourcing** -- Instead of storing only the current state of a booking (status = "confirmed"), you store every event that happened to it: "booking.created", "payment.authorized", "payment.captured", "booking.confirmed". You can reconstruct the current state by replaying the events in order. More importantly, you can answer "what did this booking look like at 2PM yesterday?" by replaying events up to that point.

- **Monthly partitioning (`PARTITION BY RANGE COLUMNS`)** -- Events accumulate fast. At 1,666 bookings/second with multiple events per booking, the table grows by millions of rows per month. Monthly partitioning lets us efficiently archive old months and keeps queries against recent data fast. Dropping a partition is nearly instantaneous compared to deleting millions of rows.

- **`causation_id` and `correlation_id`** -- Causation answers "what event caused this event?" and correlation groups related events together. If a "booking.created" event caused a "payment.authorize" event, the payment event's `causation_id` points to the booking event. Both share the same `correlation_id`, which ties them to the same user action.

---

## Index Design with EXPLAIN ANALYZE

Indexes are not something you add after performance problems appear. They are something you design alongside the schema. Here is how to verify that your indexes are working.

### Example 1: Booking Lookup by User

```sql
-- Query: Find active bookings for a user
EXPLAIN ANALYZE
SELECT id, reference_code, booking_type, total_amount, status, created_at
FROM bookings
WHERE user_id = 12345 AND deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 20;

-- Expected output (good):
-> Limit: 20 row(s)
  -> Index lookup on bookings using idx_user (user_id=12345, deleted_at IS NULL)
     rows=18, cost=3.2, time=0.4ms
     -> Sort: bookings.created_at DESC
```

The query uses the `idx_user (user_id, deleted_at)` composite index. MySQL reads only the rows for user 12345 that are not soft-deleted. The partition pruning eliminates 15 out of 16 partitions (hash(12345) = partition 7). Total time: **under 1ms**.

### Example 2: Inventory Availability Check (Bad Index)

```sql
-- Query: Check availability for a resource on a date
EXPLAIN ANALYZE
SELECT available_quantity, base_price
FROM inventory
WHERE resource_type = 'hotel_room'
  AND resource_id = 42
  AND resource_date = '2026-03-15';

-- Output with proper index (good):
-> Index lookup on inventory using uniq_resource_date
     (resource_type='hotel_room', resource_id=42, resource_date='2026-03-15')
     rows=1, cost=1.0, time=0.2ms

-- Output WITHOUT the index (bad):
-> Filter: ((resource_type = 'hotel_room') AND (resource_id = 42)
     AND (resource_date = '2026-03-15'))
  -> Table scan on inventory
     rows=500000, cost=50123.0, time=487.3ms
```

The difference between 0.2ms (indexed) and 487ms (full table scan) is the difference between a responsive system and one that buckles under load. At 1,666 queries/second, a 487ms query means 810 queries are in-flight simultaneously, exhausting the connection pool.

### Example 3: Expired Holds Cleanup

```sql
-- Query: Find active holds that have expired (run every 30 seconds)
EXPLAIN ANALYZE
SELECT id, resource_type, resource_id, resource_date, quantity, user_id
FROM inventory_holds
WHERE status = 'active' AND expires_at < NOW()
LIMIT 100;

-- Output with proper index (good):
-> Limit: 100 row(s)
  -> Index range scan on inventory_holds using idx_expires
     (status='active', expires_at < '2026-02-15 10:00:00')
     rows=23, cost=5.1, time=0.8ms
```

The `idx_expires (expires_at, status)` composite index enables this query to efficiently find expired holds without scanning the entire table. The order of columns in the index matters -- `status` first (equality), then `expires_at` (range) would be slightly more efficient if most holds are not active. We chose `(expires_at, status)` because the expiry worker runs frequently and benefits from the temporal ordering.

> **Common Mistake:** Adding an index on every column individually instead of designing composite indexes. Five single-column indexes (`idx_a`, `idx_b`, `idx_c`, `idx_d`, `idx_e`) are not equivalent to one composite index `idx_abcde`. MySQL uses at most one index per query (in most cases). A composite index on `(status, expires_at)` serves queries filtering on both columns. Two separate indexes on `status` and `expires_at` force MySQL to choose one, then scan the results for the other condition.

---

## Migration Strategy: Zero-Downtime Schema Changes

In a system that processes 1,666 bookings/second, you cannot afford downtime for schema migrations. A traditional `ALTER TABLE` on a table with 100 million rows can lock the table for hours. Here is how we perform zero-downtime migrations.

### The Expand-Contract Pattern

Every schema change follows three phases:

```
Phase 1: EXPAND (add the new, keep the old)
  - Add new column with a default value (no lock)
  - Deploy application code that writes to BOTH old and new columns
  - Backfill existing rows (in batches)

Phase 2: MIGRATE (switch to the new)
  - Deploy application code that reads from the new column
  - Verify all rows are backfilled
  - Monitor for issues

Phase 3: CONTRACT (remove the old)
  - Deploy application code that stops writing to the old column
  - Drop the old column (brief metadata lock, no data lock)
```

### Example: Adding a `loyalty_tier` Column to Bookings

```sql
-- Phase 1: EXPAND (instant, no lock)
ALTER TABLE bookings ADD COLUMN loyalty_tier VARCHAR(20) DEFAULT NULL;
-- This is instant in MySQL 8.0 for nullable columns with no default
-- or with a default value. No table rebuild required.

-- Phase 1: Backfill in batches (runs in background)
-- Process 1,000 rows at a time to avoid long-running transactions
SET @batch_start = 0;
REPEAT
  UPDATE bookings
  SET loyalty_tier = (
    SELECT tier FROM user_loyalty WHERE user_loyalty.user_id = bookings.user_id
  )
  WHERE id > @batch_start AND id <= @batch_start + 1000
    AND loyalty_tier IS NULL;
  SET @batch_start = @batch_start + 1000;
  -- Sleep 100ms between batches to reduce load
  DO SLEEP(0.1);
UNTIL ROW_COUNT() = 0
END REPEAT;
```

```typescript
// Phase 1: Application code writes to BOTH columns
// (old: loyalty lookup in user service, new: loyalty_tier column)
async createBooking(data: CreateBookingInput) {
  const loyaltyTier = await this.userService.getLoyaltyTier(data.userId);

  const booking = await prisma.booking.create({
    data: {
      ...data,
      loyaltyTier: loyaltyTier, // Write to new column
    },
  });
}

// Phase 2: Application code reads from new column
async getBooking(bookingId: bigint) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
  });

  // Read from new column (fall back to service call if null)
  const tier = booking.loyaltyTier
    ?? await this.userService.getLoyaltyTier(booking.userId);
}
```

```sql
-- Phase 3: CONTRACT (brief metadata lock only)
ALTER TABLE bookings DROP COLUMN old_loyalty_field;
```

> **What If You Skip This?** A naive `ALTER TABLE bookings ADD COLUMN ... NOT NULL DEFAULT 'standard'` on a table with 100 million rows can lock the table for 30-60 minutes in older MySQL versions. During that lock, no bookings can be created. At $34M/minute in lost bookings, a 30-minute lock costs over $1 billion. The expand-contract pattern eliminates this risk.

### Tools for Online Schema Changes

For operations that do require table rebuilds (changing column types, adding indexes on large tables), use **pt-online-schema-change** (Percona) or **gh-ost** (GitHub):

```bash
# gh-ost: Online schema change without locking the table
gh-ost \
  --host=shard-07.mysql.internal \
  --database=booking_platform \
  --table=bookings \
  --alter="ADD INDEX idx_loyalty (loyalty_tier, created_at)" \
  --execute \
  --chunk-size=1000 \
  --max-load=Threads_running=25 \
  --critical-load=Threads_running=50
```

gh-ost creates a ghost (shadow) table, copies data in small chunks, applies the schema change to the ghost table, and swaps the tables atomically. The original table is never locked for more than a few milliseconds during the swap.

---

## Connection Pooling Deep Dive

Each MySQL shard has a limited number of connections. With 20 Booking Service instances, 15 Inventory Service instances, and 12 Payment Service instances all connecting to the same shard, connection management is critical.

### The Problem: Connection Exhaustion

```
MySQL default max_connections: 151

Our connection demand per shard:
  Booking Service:   20 replicas × 10 connections/replica = 200
  Inventory Service: 15 replicas × 10 connections/replica = 150
  Payment Service:   12 replicas × 10 connections/replica = 120
  Analytics Service:  5 replicas ×  5 connections/replica =  25
  Event Store:        8 replicas ×  5 connections/replica =  40
  ─────────────────────────────────────────────────────────────
  Total demand: 535 connections per shard

  MySQL practical limit: ~500 connections per instance
  (beyond this, connection overhead hurts query performance)
```

We are already over budget. Without connection pooling, the database rejects connections, and bookings fail.

### The Solution: PgBouncer-Style Connection Pooling with ProxySQL

We use **ProxySQL** as a connection pooler that sits between the application and MySQL:

```
Application (20 replicas)
    └── Each replica opens 10 connections to ProxySQL
        └── ProxySQL maintains 50 persistent connections to MySQL
            └── MySQL sees only 50 connections (not 200)
```

```yaml
# ProxySQL configuration per shard
mysql_servers:
  - address: "shard-07-primary.mysql.internal"
    port: 3306
    hostgroup: 0  # Writer hostgroup
    max_connections: 100
  - address: "shard-07-replica-1.mysql.internal"
    port: 3306
    hostgroup: 1  # Reader hostgroup
    max_connections: 100
  - address: "shard-07-replica-2.mysql.internal"
    port: 3306
    hostgroup: 1
    max_connections: 100

mysql_query_rules:
  # Route SELECT queries to read replicas
  - match_pattern: "^SELECT"
    destination_hostgroup: 1
  # Route everything else (INSERT, UPDATE, DELETE) to primary
  - match_pattern: ".*"
    destination_hostgroup: 0
```

```typescript
// Application-level connection pool configuration (TypeORM)
const dataSourceOptions: DataSourceOptions = {
  type: 'mysql',
  host: 'proxysql-shard-07.internal',  // Connect via ProxySQL
  port: 6033,
  database: 'booking_platform',

  // Connection pool settings
  extra: {
    connectionLimit: 10,    // Max connections this replica opens
    waitForConnections: true,
    queueLimit: 50,         // Max queued requests before rejecting
    connectTimeout: 5000,   // 5s to establish connection
    acquireTimeout: 10000,  // 10s to acquire from pool
  },
};
```

### Connection Pool Monitoring

```typescript
// Monitor connection pool health
class ConnectionPoolMonitor {
  @Interval(5000) // Check every 5 seconds
  async checkPoolHealth() {
    const pool = this.dataSource.driver.pool;

    const metrics = {
      total: pool.totalCount,     // Total connections in pool
      idle: pool.idleCount,       // Connections available
      waiting: pool.waitingCount, // Requests waiting for a connection
    };

    // Alert if waiting queue is growing
    if (metrics.waiting > 10) {
      this.logger.warn(
        `Connection pool pressure: ${metrics.waiting} requests waiting`,
        metrics
      );
      this.metrics.gauge('db.pool.waiting', metrics.waiting);
    }

    // Alert if no idle connections (pool exhaustion imminent)
    if (metrics.idle === 0 && metrics.waiting > 0) {
      this.alertService.warn(
        `Connection pool exhaustion on shard ${this.shardId}: ` +
        `${metrics.total} total, 0 idle, ${metrics.waiting} waiting`
      );
    }
  }
}
```

> **Common Mistake:** Setting `connectionLimit` too high. If every application instance opens 50 connections to every shard, and you have 47 application instances (20 Booking + 15 Inventory + 12 Payment), that is 47 * 50 = 2,350 connections per shard. MySQL will spend more time context-switching between connections than executing queries. Keep the per-instance limit low (5-10) and let ProxySQL multiplex.

---

## Slow Query Debugging

Slow queries are the number one cause of database-related outages. Here is the systematic approach to finding and fixing them.

### Step 1: Enable the Slow Query Log

```sql
-- MySQL configuration
SET GLOBAL slow_query_log = 1;
SET GLOBAL slow_query_log_file = '/var/log/mysql/slow.log';
SET GLOBAL long_query_time = 0.05;  -- Log queries slower than 50ms
SET GLOBAL log_queries_not_using_indexes = 1;  -- Log queries without indexes
```

### Step 2: Identify the Offending Query

```
# Sample slow query log entry:
# Time: 2026-02-15T10:30:45.123456Z
# User@Host: booking_service[booking_service] @ 10.0.5.23
# Query_time: 2.345678  Lock_time: 0.000123
# Rows_sent: 1  Rows_examined: 4500000
# SET timestamp=1739612445;
SELECT * FROM bookings
WHERE booking_type = 'hotel' AND status = 'confirmed'
  AND created_at > '2026-01-01';
```

**Red flags in this entry:**
- `Query_time: 2.345678` -- 2.3 seconds is catastrophic at 1,666 bookings/sec
- `Rows_examined: 4500000` -- The query scanned 4.5 million rows to return 1 row
- `SELECT *` -- Fetching all columns when only a few are needed

### Step 3: Analyze with EXPLAIN

```sql
EXPLAIN ANALYZE
SELECT * FROM bookings
WHERE booking_type = 'hotel' AND status = 'confirmed'
  AND created_at > '2026-01-01';

-- Output (BAD):
-> Filter: ((booking_type = 'hotel') AND (status = 'confirmed')
     AND (created_at > '2026-01-01'))
  -> Table scan on bookings
     rows=4500000, cost=450000.0, time=2345.6ms
```

The query is doing a **full table scan** because there is no composite index on `(booking_type, status, created_at)`.

### Step 4: Add the Correct Index

```sql
-- Add a covering composite index
ALTER TABLE bookings ADD INDEX idx_type_status_created
  (booking_type, status, created_at);

-- Verify with EXPLAIN ANALYZE
EXPLAIN ANALYZE
SELECT id, reference_code, total_amount, created_at
FROM bookings
WHERE booking_type = 'hotel' AND status = 'confirmed'
  AND created_at > '2026-01-01';

-- Output (GOOD):
-> Index range scan on bookings using idx_type_status_created
     (booking_type='hotel', status='confirmed', created_at > '2026-01-01')
     rows=1523, cost=45.2, time=1.8ms
```

From 2,345ms to 1.8ms -- a **1,300x improvement** -- by adding a single index.

### Step 5: Prevent Future Slow Queries

```typescript
// Automated slow query detection in the application
class QueryMonitor {
  constructor(private readonly dataSource: DataSource) {
    // Intercept all queries and log slow ones
    this.dataSource.driver.afterQuery = (query, parameters, result, time) => {
      if (time > 50) {  // 50ms threshold
        this.logger.warn('Slow query detected', {
          query: query.substring(0, 500), // Truncate for logging
          params: parameters,
          duration: `${time}ms`,
          rowsAffected: result?.affectedRows,
        });

        this.metrics.histogram('db.query.duration', time, {
          query_type: query.trim().split(' ')[0], // SELECT, INSERT, etc.
        });

        // Auto-alert if a query exceeds 200ms
        if (time > 200) {
          this.alertService.warn(
            `Critical slow query: ${time}ms - ${query.substring(0, 200)}`
          );
        }
      }
    };
  }
}
```

### Slow Query Debugging Checklist

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `Rows_examined` >> `Rows_sent` | Missing or wrong index | Add composite index matching WHERE clause |
| `Lock_time` > 100ms | Table-level lock contention | Check for DDL operations, switch to row-level locks |
| `Query_time` spikes during peak hours | Connection pool exhaustion | Increase pool size, add ProxySQL |
| `SELECT *` in slow query log | Fetching unnecessary columns | Select only needed columns |
| Query uses `ORDER BY` without index | Sort operation in memory/disk | Add index matching ORDER BY clause |
| Subquery in WHERE clause | Correlated subquery executing per row | Rewrite as JOIN |
| `LIKE '%search%'` | Leading wildcard prevents index use | Use Elasticsearch for text search |

---

## The Complete Table List

Here is every table in the database, grouped by domain:

**Core Entities:**
- `bookings` -- Main booking records
- `hotel_bookings` -- Hotel-specific details (check-in/out dates, room type)
- `flight_bookings` -- Flight-specific details (departure, arrival, seat)
- `car_bookings` -- Car rental details (pickup/dropoff location, vehicle type)
- `booking_passengers` -- Passenger information for flights
- `booking_rooms` -- Room details for hotel bookings

**Inventory:**
- `inventory` -- Availability tracking with fencing tokens
- `inventory_holds` -- Temporary reservations with state machine
- `inventory_hold_transitions` -- Hold state change audit log
- `inventory_locks` -- Distributed lock records (audit trail)
- `inventory_snapshots` -- Daily snapshots for reconciliation
- `overbooking_log` -- Oversell event audit log

**Payments:**
- `transactions` -- Payment transaction records
- `payment_ledger` -- Immutable financial audit log with hash chaining
- `accounting_entries` -- Double-entry journal entries
- `accounting_entry_lines` -- Journal line items (debits and credits)
- `chart_of_accounts` -- Account definitions (assets, liabilities, revenue)

**Events:**
- `booking_events` -- Event sourcing store (monthly partitioned)
- `booking_snapshots` -- Aggregate state snapshots for performance
- `outbox_events` -- Reliable event publishing queue

**Audit:**
- `booking_audit_logs` -- Booking state transitions
- `inventory_hold_transitions` -- Hold state changes
- `overbooking_log` -- Oversell attempts

**Fraud:**
- `fraud_checks` -- Fraud analysis results per booking
- `device_fingerprints` -- Device tracking for fraud detection
- `email_reputation` -- Email address scoring
- `phone_validation` -- Phone number verification records

**Lookups:**
- `booking_types` -- Booking categories (hotel, flight, car)
- `currencies` -- Currency definitions (USD, EUR, GBP)
- `payment_providers` -- Payment gateway configuration (Stripe, Adyen)
- `booking_transition_reasons` -- Cancellation and transition reason codes

That is roughly 30 tables. It sounds like a lot, but each table has a clear, single purpose. There is no "catch-all" table that mixes concerns. When you need to debug a payment issue, you look at `payment_ledger`. When you need to understand why inventory was oversold, you look at `overbooking_log`. When you need to trace a booking's lifecycle, you look at `booking_events`.

> **Checkpoint:** Look at the bookings table schema. Why does it use `DECIMAL(12,2)` for money columns instead of `FLOAT`? Why is there no `FOREIGN KEY` constraint on `booking_type`? What is the `idempotency_key` column for, and what problem does it solve?

---

## Chapter Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Sharding | Splitting data across 16 MySQL instances using `hash(user_id) % 16` so each shard handles a fraction of the total load |
| Hash vs. Range Sharding | Hash-based distributes evenly; range-based allows regional co-location but creates hotspots with skewed data |
| Shard Key (`user_id`) | All user data on one shard eliminates cross-shard joins for 99.9% of user-facing queries |
| Read Replicas | 4 copies per shard handle SELECT queries, keeping the primary instance free for writes |
| Idempotency Key | A unique key per booking that prevents duplicate bookings from network retries or double-clicks |
| Fencing Token (in inventory) | A column that ensures only the lock holder with the highest token can update inventory |
| Inventory Holds (State Machine) | Temporary reservations that follow strict state transitions: active -> confirmed/expired/released/cancelled |
| Payment Ledger (Immutable) | Financial records with hash chaining and triggers that reject all UPDATE and DELETE operations |
| Event Sourcing | Storing every state change as an event instead of just the current state, enabling replay and time-travel debugging |
| Outbox Pattern | Writing events to a database table in the same transaction as business data for guaranteed delivery |
| Index Design | Composite indexes matched to query WHERE clauses; verified with EXPLAIN ANALYZE |
| Zero-Downtime Migrations | Expand-contract pattern: add new, write to both, switch reads, drop old |
| Connection Pooling | ProxySQL multiplexes 535 application connections into ~50 database connections per shard |
| Slow Query Debugging | Enable slow_query_log, EXPLAIN ANALYZE, add composite index, verify improvement |

In Chapter 8, we will build the API Gateway -- the single entry point that sits in front of all these services, authenticates every request, and routes it to the right microservice.
