# Chapter 17: Multi-Region Conflict Resolution — When Tokyo and London Disagree

## The Problem That Wakes You Up at 3 AM

It is 2:47 AM in your time zone. Your phone buzzes. PagerDuty. The message reads: "CRITICAL: Double-booking detected. Guest arriving at Tokyo Marriott for room 4215 — room already occupied by another guest confirmed through London."

Two guests. One room. Two regions, each confident they processed a valid booking. Both were right — locally. Both were wrong — globally.

This is not a hypothetical. This is what happens when you deploy the same booking system across multiple regions without solving the conflict resolution problem. And at 100,000 bookings per minute across four continents, it is not a matter of *if* this happens — it is a matter of *how often*.

This chapter teaches you how to detect, resolve, and prevent multi-region conflicts so that Tokyo and London never permanently disagree about who booked what.

---

## Why Multi-Region: Three Forces That Leave You No Choice

Up to this point, every system we have built lives in one place. One data center, one set of servers, one region. And for many applications, that is perfectly fine. But our booking platform serves users in Tokyo, London, Sao Paulo, and New York. Running everything from a single region creates three problems that compound until they become existential threats.

### Force 1: Latency Kills Conversions

If all our servers sit in `us-east-1` (Virginia), here is what happens:

| User Location | Network Round Trip to Virginia | Booking Flow (5 hops) | User Experience |
|---|---|---|---|
| Virginia | 5-10 ms | ~50 ms | Instant |
| London | 75-85 ms | ~425 ms | Noticeable delay |
| Tokyo | 180-250 ms | ~1,250 ms | Frustrating |
| Sao Paulo | 120-160 ms | ~800 ms | Slow |
| Sydney | 200-280 ms | ~1,400 ms | Unacceptable |

A booking flow involves multiple service-to-service calls: check inventory, validate payment, confirm reservation, send notification. Each one pays the latency tax. Your Tokyo user waits 1.2 seconds for something that takes 50 milliseconds in Virginia. They notice. They leave. You lose the booking.

Research from Google and Amazon consistently shows that every 100ms of added latency costs 1% of revenue. At 100,000 bookings per minute with an average booking value of $200, a 1% drop means $200,000 lost per hour — just from latency.

```
Single Region (us-east-1 only):

  Tokyo User ----[ 180ms ]----> us-east-1 ----[ 180ms ]----> Tokyo User
                                   |
  London User ---[  80ms ]----> Servers   ----[  80ms ]----> London User
                                   |
  Sao Paulo -----[ 140ms ]----> Database  ----[ 140ms ]----> Sao Paulo

Multi-Region:

  Tokyo User ----[  5ms ]----> ap-northeast-1 ----[  5ms ]----> Tokyo User
  London User ---[  5ms ]----> eu-west-1       ----[  5ms ]----> London User
  Sao Paulo -----[  5ms ]----> sa-east-1       ----[  5ms ]----> Sao Paulo
```

### Force 2: Disaster Recovery Demands It

On December 7, 2021, AWS `us-east-1` experienced a major outage lasting over eight hours. Services including Disney+, Slack, Venmo, and large portions of the internet went dark. Companies running in a single region had zero options: they waited.

For a booking platform processing 100,000 bookings per minute, an eight-hour outage means:
- **48 million lost bookings** (assuming average demand)
- **Tens of millions in lost revenue**
- **Contractual SLA violations** with hotel and airline partners
- **Reputation damage** that takes months to recover from

Multi-region deployment transforms a regional outage from a company-ending event into a traffic routing change. When `us-east-1` goes down, users are automatically redirected to `eu-west-1` or `ap-northeast-1`. The system continues operating.

> **Analogy:** Running a single region is like a city with one hospital. Most days, it is fine. But when that hospital shuts down for an emergency, every patient in the city has nowhere to go. Multi-region is like having hospitals in every district. If one closes, the others absorb the load. Nobody dies waiting.

### Force 3: Data Sovereignty Is Not Optional

The European Union's GDPR requires that personal data of EU residents be processed within the EU or in countries with adequate data protection. Similar laws exist in Brazil (LGPD), Japan (APPI), China (PIPL), and India (DPDP).

If your only data center is in Virginia, processing a German user's booking requires their personal data to leave the EU. That is a GDPR violation that can cost up to 4% of global annual turnover — potentially hundreds of millions of dollars for a large platform.

Multi-region is the solution: EU users' data stays in `eu-west-1` (Ireland). Japanese users' data stays in `ap-northeast-1` (Tokyo). You comply by architecture, not by legal gymnastics.

> **Key Term:** **Data sovereignty** — The legal principle that data is subject to the laws of the country or region in which it is collected or processed. Multi-region deployment allows you to keep data within its jurisdiction of origin.

> **What If You Skip This?** If you run a single region, you are simultaneously paying a latency tax on three-quarters of your users, betting your entire business on one data center's uptime, and potentially violating data protection laws in every major market. Any one of these is a business risk. Together, they are a countdown to failure.

---

## Active-Active vs Active-Passive: Choose Your Architecture

There are two fundamental approaches to multi-region deployment. Choosing the wrong one costs you either availability or engineering complexity. Both have real costs.

### Active-Passive: One King, Many Backups

In active-passive, one region (the "primary") handles all write traffic. Other regions ("secondaries") replicate data from the primary and serve only read traffic (or sit idle as hot standbys).

```
Active-Passive Architecture:

                    ┌─────────────────────┐
                    │   PRIMARY REGION    │
                    │    (us-east-1)      │
     All writes ──>│                     │
                    │  ┌─────────────┐   │
                    │  │  MySQL      │   │
                    │  │  Primary    │   │
                    │  └──────┬──────┘   │
                    └─────────┼──────────┘
                              │ Replication
               ┌──────────────┼──────────────┐
               │              │              │
    ┌──────────▼───┐  ┌──────▼───────┐  ┌──▼────────────┐
    │  SECONDARY   │  │  SECONDARY   │  │  SECONDARY    │
    │ (eu-west-1)  │  │(ap-northeast)│  │ (sa-east-1)   │
    │              │  │              │  │               │
    │  MySQL       │  │  MySQL       │  │  MySQL        │
    │  Replica     │  │  Replica     │  │  Replica      │
    │  (read-only) │  │  (read-only) │  │  (read-only)  │
    └──────────────┘  └──────────────┘  └───────────────┘
          │                  │                  │
      Reads only         Reads only         Reads only
```

**Advantages:**
- No conflicts. All writes go through one database. Problem solved trivially.
- Simpler operational model. One source of truth.
- Replication is one-directional and well-understood.

**Disadvantages:**
- Write latency for remote users. A Tokyo user's booking goes Virginia -> MySQL write -> back to Tokyo. ~360ms minimum per write.
- Single point of failure for writes. If `us-east-1` goes down, no bookings can be created until failover completes.
- Failover is disruptive. Promoting a secondary to primary requires DNS changes, replication reconfiguration, and data verification. Typical failover time: 30 seconds to 5 minutes.

### Active-Active: Everyone Is a King

In active-active, every region handles both reads and writes. Each region has its own primary database, and writes replicate asynchronously to all other regions.

```
Active-Active Architecture:

  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │    us-east-1     │    │    eu-west-1     │    │  ap-northeast-1  │
  │                  │    │                  │    │                  │
  │  ┌────────────┐  │    │  ┌────────────┐  │    │  ┌────────────┐  │
  │  │  App       │  │    │  │  App       │  │    │  │  App       │  │
  │  │  Servers   │  │    │  │  Servers   │  │    │  │  Servers   │  │
  │  └─────┬──────┘  │    │  └─────┬──────┘  │    │  └─────┬──────┘  │
  │  ┌─────▼──────┐  │    │  ┌─────▼──────┐  │    │  ┌─────▼──────┐  │
  │  │ MySQL      │◄─┼────┼──│ MySQL      │◄─┼────┼──│ MySQL      │  │
  │  │ Primary    │──┼────┼─►│ Primary    │──┼────┼─►│ Primary    │  │
  │  └────────────┘  │    │  └────────────┘  │    │  └────────────┘  │
  │                  │    │                  │    │                  │
  │  Reads + Writes  │    │  Reads + Writes  │    │  Reads + Writes  │
  └──────────────────┘    └──────────────────┘    └──────────────────┘
         ▲                        ▲                        ▲
         │                        │                        │
    Local users              Local users              Local users
   (Americas)               (Europe/Africa)          (Asia/Pacific)
```

**Advantages:**
- Low write latency everywhere. Every user writes to their nearest region.
- No single point of failure. Any region can go down and the others continue operating independently.
- True global availability. No region depends on any other region to accept writes.

**Disadvantages:**
- Conflicts. Two regions can accept conflicting writes for the same resource at the same time.
- Operational complexity. Multi-primary replication is harder to set up, monitor, and debug.
- Data divergence. During network partitions, regions can drift apart and must reconcile when connectivity resumes.

### Our Choice: Active-Active with Conflict Resolution

For our booking system, we choose **active-active**. Here is why:

1. **Latency matters more than simplicity.** Our users book hotels; they do not tolerate 360ms write latency when a competitor offers 10ms.
2. **Availability is non-negotiable.** A single-region write bottleneck means a single-region failure takes down all bookings globally.
3. **We can solve conflicts deterministically.** Booking conflicts are detectable (same room, same date) and resolvable (higher fencing token wins). Not all domains have this luxury.

> **What If You Skip This?** If you do not make an explicit active-active vs active-passive decision, you will default to active-passive (because it is easier) and pay the latency penalty on most of your global users. When you later realize you need active-active, retrofitting conflict resolution into an existing system is 10x harder than building it in from the start.

---

## The CAP Theorem: You Cannot Have Everything

Before we design a solution, you need to understand a fundamental law of distributed systems. It is called the **CAP theorem**, proposed by Eric Brewer in 2000, and it says that any distributed data store can guarantee only two of the following three properties simultaneously:

| Property | What It Means | Real-World Example |
|---|---|---|
| **Consistency (C)** | Every read receives the most recent write. All regions see exactly the same data at the same time. | A bank balance: if you deposit $100, every ATM shows the new balance immediately. |
| **Availability (A)** | Every request receives a non-error response, even if some nodes are down. | Google Search: it always returns results, even if some servers are failing behind the scenes. |
| **Partition Tolerance (P)** | The system continues operating even when network communication between regions is interrupted. | Any internet-connected distributed system: cables get cut, routers fail, partitions happen. |

Here is the crux: network partitions are not optional. The internet between Tokyo and London **will** have outages. Submarine cables get damaged by anchors and earthquakes. Cloud provider networks experience internal partitions multiple times per year. So you must pick partition tolerance. That leaves you choosing between consistency and availability.

```
The CAP Triangle:

              Consistency (C)
                   /\
                  /  \
                 /    \
                / CP   \
               / Systems\
              /  (MySQL  \
             /  single    \
            /   primary)   \
           /________________\
          /\      CA        /\
         /  \   Systems   /  \
        / AP \  (single  / CP \
       /Systems\ data   /Systems\
      / (Our    \center)/       \
     / Booking   \    / (Spanner,\
    /  System)    \  / CockroachDB\
   /_______________\/_______________\
  Availability (A)    Partition Tolerance (P)

  Note: CA systems cannot exist in distributed deployments
  because network partitions are inevitable.
```

> **Analogy:** Think of it like a married couple who live in different cities. They share a joint bank account. **Option 1 (CP — Consistency + Partition tolerance):** Before either person spends money, they call each other and agree. This guarantees they never overdraw, but if the phone line is down, neither can spend anything — they are blocked. **Option 2 (AP — Availability + Partition tolerance):** Both can spend freely without calling. They are never blocked, but they might both spend the last $100 at the same time and overdraw the account. The phone line going down is the "partition." You must pick: always agree but sometimes be stuck, or always be available but sometimes disagree.

### What Our System Actually Chooses — And Why

Our booking system chooses **AP — Availability and Partition tolerance**. Here is our reasoning, and it was not taken lightly:

**Why AP:**
- We want every region to keep accepting bookings even if the network between regions goes down. A network outage between Tokyo and London should not freeze bookings in Tokyo. Users should never see "Service Unavailable" because an undersea cable had a bad day.
- We accept that, for a tiny window of 2-3 seconds, two regions might both think they booked the last room. We will detect and fix that conflict automatically.
- Bookings are economically reversible. A double-booking can be resolved by relocating one guest, offering a refund, or upgrading them to a different room. It is not like transferring money, where an inconsistency means actual money is lost.

**Why not CP:**
- Strict consistency would require every region to check with every other region before confirming any booking. That adds 150-300ms to every single booking — the cross-region round trip.
- During a partition, CP means the system stops accepting bookings entirely in affected regions. If the Tokyo-London link goes down for 30 minutes, all bookings by Asian users queue up or fail. We tried it in staging; the user experience was unacceptable.
- At 100,000 bookings per minute, even a 5-minute partition means 500,000 failed or queued bookings.

**Why not CA:**
- CA (Consistency + Availability without Partition tolerance) is impossible in a distributed system. You cannot wish away network partitions. Any system that claims CA either runs in a single data center (not distributed) or is lying about one of the guarantees.

> **Key Term:** **AP system (Availability + Partition tolerance)** — A distributed system that prioritizes always being able to respond to requests, even during network partitions, at the cost of temporary inconsistencies between nodes. Conflicts are detected and resolved after the fact. This is also known as "eventual consistency."

> **Key Term:** **Eventual consistency** — A consistency model where, given enough time without new updates, all replicas will converge to the same value. There is no guarantee about *when* they will converge, only that they *will*. In our system, "enough time" is typically 2-5 seconds.

> **What If You Skip This?** If you do not make a deliberate CAP choice, you end up with an accidental one — usually the worst kind. Your system will sometimes be inconsistent AND unavailable, because you did not design for either tradeoff. Every multi-region system must make this choice explicitly. Write it in your architecture decision records. Defend it in design reviews. Revisit it annually.

---

## Conflict Detection: How Do You Know Two Regions Disagree?

Choosing AP means accepting that conflicts will happen. The next question is: how do you *detect* them? You cannot resolve what you cannot see. There are four major approaches to conflict detection, each with different tradeoffs.

### Approach 1: Last-Write-Wins (LWW) with Timestamps

The simplest approach: attach a timestamp to every write. When two writes conflict, the one with the later timestamp wins.

```typescript
// Last-Write-Wins: the simplest conflict detection
interface LWWRecord {
  id: bigint;
  data: string;
  timestamp: number;     // Unix timestamp in milliseconds
  sourceRegion: string;  // Which region wrote this
}

function resolveConflictLWW(local: LWWRecord, remote: LWWRecord): LWWRecord {
  // Later timestamp wins
  if (remote.timestamp > local.timestamp) {
    return remote;   // Remote write is newer — it wins
  }
  if (local.timestamp > remote.timestamp) {
    return local;    // Local write is newer — it wins
  }
  // Timestamps are identical (rare but possible)
  // Break the tie deterministically using region name
  return local.sourceRegion > remote.sourceRegion ? local : remote;
}
```

**The problem:** LWW relies on synchronized clocks. But clocks across regions are never perfectly synchronized. Even with NTP (Network Time Protocol), clock skew between regions can be 1-10 milliseconds. With GPS-synchronized clocks (like Google's TrueTime), skew drops to microseconds — but that requires specialized hardware most companies do not have.

Consider this scenario:
```
Tokyo's clock: 1708000000100 (100ms ahead of reality)
London's clock: 1708000000090 (10ms behind reality)
Real time: 1708000000095

Tokyo writes at real time 1708000000095 → timestamp 1708000000100
London writes at real time 1708000000095 → timestamp 1708000000090

LWW picks Tokyo because 1708000000100 > 1708000000090.
But both writes happened at the SAME real time.
The "winner" is determined by clock skew, not actual causality.
```

Despite this limitation, LWW is widely used because it is simple, fast, and "good enough" for many use cases. Amazon DynamoDB and Apache Cassandra both use LWW as their default conflict resolution strategy.

> **Key Term:** **Last-Write-Wins (LWW)** — A conflict resolution strategy where the write with the most recent timestamp is kept and all older writes are discarded. Simple but depends on synchronized clocks. Data loss is possible if the "losing" write contained information the user intended to keep.

### Approach 2: Version Vectors — Who Has Seen What

Version vectors solve the clock-synchronization problem of LWW by tracking *causality* instead of *time*. Each node maintains a vector of counters — one counter per region. When a region writes, it increments its own counter.

```typescript
// Version Vector: tracks causality, not time
interface VersionVector {
  // Map of region -> logical counter
  // Example: { 'us-east-1': 5, 'eu-west-1': 3, 'ap-northeast-1': 7 }
  [region: string]: number;
}

// Increment the vector when THIS region makes a write
function incrementVector(
  vector: VersionVector,
  region: string
): VersionVector {
  return {
    ...vector,
    [region]: (vector[region] || 0) + 1,
  };
}

// Compare two version vectors
// Returns: 'before', 'after', 'concurrent', or 'equal'
function compareVectors(a: VersionVector, b: VersionVector): string {
  const allRegions = new Set([...Object.keys(a), ...Object.keys(b)]);

  let aGreater = false;
  let bGreater = false;

  for (const region of allRegions) {
    const aVal = a[region] || 0;
    const bVal = b[region] || 0;

    if (aVal > bVal) aGreater = true;  // A has seen something B hasn't
    if (bVal > aVal) bGreater = true;  // B has seen something A hasn't
  }

  if (aGreater && !bGreater) return 'after';    // A happened after B
  if (bGreater && !aGreater) return 'before';   // A happened before B
  if (!aGreater && !bGreater) return 'equal';   // Identical histories
  return 'concurrent';                           // Neither dominates — CONFLICT
}
```

Here is how it works in practice:

```
Step 1: Initial state
  us-east-1 vector: { us: 0, eu: 0, ap: 0 }
  eu-west-1 vector: { us: 0, eu: 0, ap: 0 }

Step 2: us-east-1 creates a booking
  us-east-1 vector: { us: 1, eu: 0, ap: 0 }  ← incremented 'us'

Step 3: us-east-1 replicates to eu-west-1
  eu-west-1 receives the update and merges vectors:
  eu-west-1 vector: { us: 1, eu: 0, ap: 0 }  ← now in sync

Step 4: eu-west-1 modifies the booking
  eu-west-1 vector: { us: 1, eu: 1, ap: 0 }  ← incremented 'eu'

Step 5: CONFLICT SCENARIO — BEFORE replication, us-east-1 also modifies
  us-east-1 vector: { us: 2, eu: 0, ap: 0 }  ← incremented 'us' again

  Now compare:
  us-east-1: { us: 2, eu: 0, ap: 0 }
  eu-west-1: { us: 1, eu: 1, ap: 0 }

  us-east-1 has us=2 > 1 (it's ahead on 'us')
  eu-west-1 has eu=1 > 0 (it's ahead on 'eu')
  Neither dominates → result: 'concurrent' → CONFLICT DETECTED
```

The beauty of version vectors is that they never give a false negative. If two writes are truly concurrent (neither causally depends on the other), the version vector comparison will always return `'concurrent'`. LWW might silently drop one of them based on clock skew.

> **Analogy:** Imagine each region keeps a scoreboard: "I have made X writes, and the last time I synced with Region B, they had made Y writes." When two scoreboards show that each region has made writes the other has not seen, you know they worked independently — and their results might conflict. It is like two coauthors who both edited the same chapter of a book without seeing each other's edits.

### Approach 3: Vector Clocks — Version Vectors for Individual Records

Vector clocks are version vectors applied at the record level rather than the region level. Each individual record carries its own vector clock, enabling per-record conflict detection.

```typescript
interface BookingRecord {
  id: bigint;
  roomId: string;
  guestId: string;
  checkIn: Date;
  checkOut: Date;

  // Each record carries its own vector clock
  vectorClock: VersionVector;

  // Which region last wrote this record
  lastWriteRegion: string;
}

class VectorClockConflictDetector {
  private readonly region = process.env.REGION!;

  // When we receive a replicated record from another region,
  // compare its vector clock against our local version
  detectConflict(
    localRecord: BookingRecord,
    remoteRecord: BookingRecord
  ): 'no_conflict' | 'remote_wins' | 'local_wins' | 'conflict' {

    const comparison = compareVectors(
      localRecord.vectorClock,
      remoteRecord.vectorClock
    );

    switch (comparison) {
      case 'before':
        // Our local record happened before the remote one.
        // The remote record includes all our changes plus more.
        // Accept the remote version.
        return 'remote_wins';

      case 'after':
        // Our local record happened after the remote one.
        // We already have everything the remote record has, plus more.
        // Keep our local version.
        return 'local_wins';

      case 'equal':
        // Identical. Nothing to do.
        return 'no_conflict';

      case 'concurrent':
        // CONFLICT. Both regions made independent changes.
        // We need a resolution strategy (next section).
        return 'conflict';
    }
  }

  // Merge vector clocks after resolving a conflict
  mergeClocks(a: VersionVector, b: VersionVector): VersionVector {
    const merged: VersionVector = {};
    const allRegions = new Set([...Object.keys(a), ...Object.keys(b)]);

    for (const region of allRegions) {
      // Take the maximum of each component
      merged[region] = Math.max(a[region] || 0, b[region] || 0);
    }

    return merged;
  }
}
```

> **Key Term:** **Vector clock** — A data structure attached to each record that tracks the causal history of that record across all regions. Each element in the vector represents a region's write counter. By comparing vector clocks, you can determine whether two versions of a record are causally related (one happened after the other) or concurrent (they diverged independently, indicating a conflict).

### Why We Use Fencing Tokens Instead

You might wonder: if vector clocks are so powerful, why does our booking system use fencing tokens instead? Three reasons:

1. **Space overhead.** A vector clock grows with the number of regions. With four regions, each record carries four integers. With twenty regions (as some large deployments have), the overhead is significant when multiplied across billions of records.

2. **Our conflicts have a natural ordering.** Booking conflicts over the same room on the same date have a clear "winner" — the one that acquired the distributed lock most recently (highest fencing token). We do not need to preserve both versions; we need to pick one.

3. **Simplicity.** Fencing tokens are a single integer comparison. Vector clocks require merging, resolving, and propagating multi-dimensional state. For our use case, the simpler approach wins.

That said, vector clocks are the right choice when you need to detect conflicts without choosing a winner automatically — for example, in a collaborative document editor where both edits should be shown to the user for manual resolution.

---

## Conflict Resolution Strategies: What Happens After Detection

Detecting a conflict is only half the battle. Once you know Tokyo and London disagree, you need a strategy to bring them back into agreement. There are four major strategies, ranging from simple to sophisticated.

### Strategy 1: Last-Write-Wins (LWW)

We have already seen LWW for detection. As a resolution strategy, it is the same: the most recent write wins, all others are discarded.

```typescript
class LWWResolver {
  resolve<T extends { timestamp: number; sourceRegion: string }>(
    records: T[]
  ): T {
    // Sort by timestamp descending, break ties by region name
    return records.sort((a, b) => {
      if (b.timestamp !== a.timestamp) {
        return b.timestamp - a.timestamp;
      }
      return b.sourceRegion.localeCompare(a.sourceRegion);
    })[0];
  }
}
```

**When to use:** Read-heavy systems where occasional data loss from discarded writes is acceptable. User profile updates, session data, cached values.

**When NOT to use:** Financial transactions. Medical records. Anything where silently discarding a write is dangerous.

### Strategy 2: Merge Functions — Custom Business Logic

Instead of picking a winner, merge the conflicting values into a combined result using domain-specific logic.

```typescript
class BookingMergeResolver {
  // When two regions create different bookings for overlapping resources,
  // apply business rules to decide the outcome
  async resolveBookingConflict(
    localBooking: Booking,
    remoteBooking: Booking
  ): Promise<MergeResult> {

    // Rule 1: If one booking is for a premium member and the other isn't,
    // the premium member wins
    if (localBooking.memberTier === 'PLATINUM' &&
        remoteBooking.memberTier !== 'PLATINUM') {
      return {
        winner: localBooking,
        loser: remoteBooking,
        reason: 'premium_member_priority',
        compensationAction: 'offer_alternative_room'
      };
    }

    // Rule 2: If both are the same tier, the higher fencing token wins
    if (localBooking.fencingToken > remoteBooking.fencingToken) {
      return {
        winner: localBooking,
        loser: remoteBooking,
        reason: 'higher_fencing_token',
        compensationAction: 'offer_alternative_room'
      };
    }

    // Rule 3: For non-exclusive resources (like event tickets with
    // capacity > 1), BOTH can win if total doesn't exceed capacity
    if (localBooking.resourceType === 'EVENT_TICKET') {
      const totalQuantity =
        localBooking.quantity + remoteBooking.quantity;
      const capacity = await this.getResourceCapacity(
        localBooking.resourceId
      );

      if (totalQuantity <= capacity) {
        return {
          winner: 'BOTH',
          reason: 'sufficient_capacity',
          compensationAction: 'none'
        };
      }
    }

    // Default: higher fencing token wins
    return {
      winner: remoteBooking,
      loser: localBooking,
      reason: 'higher_fencing_token',
      compensationAction: 'offer_alternative_room'
    };
  }
}
```

**When to use:** When conflicts have domain-specific resolution rules. When you want to preserve as much data as possible rather than discarding writes.

**When NOT to use:** When you need automatic, zero-latency resolution without database lookups or business logic evaluation.

### Strategy 3: CRDTs — Conflict-Free by Design

CRDTs (Conflict-free Replicated Data Types) are data structures that are mathematically guaranteed to converge to the same state across all replicas, regardless of the order in which operations are applied. They make conflicts impossible by construction.

```typescript
// G-Counter: a "grow-only" counter that never has conflicts
// Each region maintains its own counter. The total is the sum.
class GCounter {
  // Internal state: one counter per region
  private counters: Map<string, number> = new Map();
  private readonly region = process.env.REGION!;

  // Increment: only touch OUR region's counter
  increment(amount: number = 1): void {
    const current = this.counters.get(this.region) || 0;
    this.counters.set(this.region, current + amount);
  }

  // Value: sum of all regions' counters
  value(): number {
    let total = 0;
    for (const count of this.counters.values()) {
      total += count;
    }
    return total;
  }

  // Merge: take the MAX of each region's counter
  // This is commutative, associative, and idempotent — the three
  // properties that guarantee convergence.
  merge(other: GCounter): void {
    for (const [region, count] of other.counters) {
      const local = this.counters.get(region) || 0;
      this.counters.set(region, Math.max(local, count));
    }
  }
}

// PN-Counter: supports both increment and decrement
// Uses two G-Counters internally: one for additions, one for subtractions
class PNCounter {
  private positive = new GCounter();  // tracks increments
  private negative = new GCounter();  // tracks decrements

  increment(amount: number = 1): void {
    this.positive.increment(amount);
  }

  decrement(amount: number = 1): void {
    this.negative.increment(amount);
  }

  value(): number {
    return this.positive.value() - this.negative.value();
  }

  merge(other: PNCounter): void {
    this.positive.merge(other.positive);
    this.negative.merge(other.negative);
  }
}
```

Here is how we use a PN-Counter for inventory tracking across regions:

```typescript
// CRDT-based inventory: every region can decrement independently,
// and they converge to the correct count without conflicts
class CRDTInventoryTracker {
  private inventoryCounts: Map<string, PNCounter> = new Map();

  // When a booking is made in THIS region, decrement locally
  bookItem(resourceKey: string): void {
    const counter = this.getOrCreateCounter(resourceKey);
    counter.decrement(1); // one unit booked
  }

  // When a booking is cancelled, increment locally
  cancelItem(resourceKey: string): void {
    const counter = this.getOrCreateCounter(resourceKey);
    counter.increment(1); // one unit freed
  }

  // Get current available inventory (sum of all regions)
  getAvailable(resourceKey: string, totalCapacity: number): number {
    const counter = this.getOrCreateCounter(resourceKey);
    return totalCapacity + counter.value();
    // counter.value() is negative (bookings exceed cancellations)
    // so: 100 + (-37) = 63 rooms available
  }

  // When we receive state from another region, merge it
  mergeFromRemote(resourceKey: string, remoteCounter: PNCounter): void {
    const local = this.getOrCreateCounter(resourceKey);
    local.merge(remoteCounter); // guaranteed to converge
  }

  private getOrCreateCounter(key: string): PNCounter {
    if (!this.inventoryCounts.has(key)) {
      this.inventoryCounts.set(key, new PNCounter());
    }
    return this.inventoryCounts.get(key)!;
  }
}
```

> **Key Term:** **CRDT (Conflict-free Replicated Data Type)** — A data structure that can be replicated across multiple regions, updated independently at each region, and merged automatically without conflicts. The mathematical properties of CRDTs (commutativity, associativity, idempotency) guarantee that all replicas converge to the same state, regardless of the order in which updates are received or merged.

**The catch with CRDTs:** They work brilliantly for counters, sets, and flags. But booking a specific room on a specific date is an *exclusive* operation — only one guest can have it. CRDTs cannot enforce exclusivity because their whole design is about allowing concurrent modifications without blocking. For our core booking flow, we still need fencing tokens. But for supporting data like "how many rooms are available" (a counter) or "which amenities does this hotel offer" (a set), CRDTs eliminate entire categories of conflicts.

> **What If You Skip This?** If you do not explicitly choose a conflict resolution strategy, your system will silently apply LWW (because most databases default to it) and you will lose writes without knowing it. For a booking system, "lost write" means a confirmed reservation vanishes. The guest shows up. There is no record of their booking. You can imagine how that conversation goes.

### Our Hybrid Approach

Our booking system uses a combination:

| Data Type | Strategy | Why |
|---|---|---|
| Room bookings | Fencing tokens (deterministic winner) | Exclusive resource — only one guest per room per night |
| Inventory counts | PN-Counter CRDT | Needs to track additions and subtractions across regions without coordination |
| Hotel metadata | LWW with timestamps | Non-critical, easily re-synced, rarely concurrent writes |
| User profiles | LWW with timestamps | Last profile update is almost always what the user wants |
| Price changes | Merge function (highest price wins during conflicts) | Business rule: never accidentally offer a lower price |
| Availability flags | Boolean CRDT (OR-set) | If ANY region marks a hotel as unavailable, it is unavailable everywhere |

---
## Multi-Region MySQL Replication: The Backbone of Your Data Layer

You have chosen active-active. You have designed your conflict resolution strategy. Now you need the plumbing: how does data actually flow between regions? The answer is MySQL replication, configured very differently from the single-region setup you are used to.

In a single-region deployment, you might have one primary and two replicas, all in the same data center, connected by a 10 Gbps local network with sub-millisecond latency. Cross-region replication is a different animal. Tokyo to London is 250 milliseconds. Tokyo to Virginia is 180 milliseconds. Those milliseconds change everything about how you configure replication.

### The Replication Topology

Our system uses a **star topology with regional primaries**. Each region has one MySQL primary that handles all local writes, plus one local replica for read scaling. Each regional primary replicates to every other regional primary asynchronously.

```
Multi-Region MySQL Replication Topology:

  ┌─────────────────────────────────────┐
  │         us-east-1 (Virginia)        │
  │                                     │
  │  ┌────────────┐   ┌────────────┐   │
  │  │  Primary   │──>│  Local     │   │
  │  │  (writes)  │   │  Replica   │   │
  │  │  server-id │   │  (reads)   │   │
  │  │  = 1001    │   │  semi-sync │   │
  │  └─────┬──────┘   └────────────┘   │
  └────────┼───────────────────────────┘
           │ async replication
     ┌─────┼──────────────────┐
     │     │                  │
     ▼     ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  eu-west-1   │  │ap-northeast-1│  │  sa-east-1   │
  │  Primary     │  │  Primary     │  │  Primary     │
  │  server-id   │  │  server-id   │  │  server-id   │
  │  = 2001      │  │  = 3001      │  │  = 4001      │
  │      │       │  │      │       │  │      │       │
  │      ▼       │  │      ▼       │  │      ▼       │
  │  Local       │  │  Local       │  │  Local       │
  │  Replica     │  │  Replica     │  │  Replica     │
  └──────────────┘  └──────────────┘  └──────────────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
              async replication back
              to all other primaries
```

### Source Configuration (my.cnf) — The Primary in Each Region

Every regional primary needs its own `my.cnf` configuration. Here is the annotated configuration for the `us-east-1` primary. The other regions use the same structure with different `server-id` values.

```ini
# =============================================================
# my.cnf — Regional Primary (us-east-1)
# =============================================================

[mysqld]

# --- Identity ---
# Every MySQL instance in the entire multi-region cluster must
# have a unique server-id. We use a convention:
#   1001-1999 = us-east-1
#   2001-2999 = eu-west-1
#   3001-3999 = ap-northeast-1
#   4001-4999 = sa-east-1
# The primary gets the x001 ID; local replicas get x002, x003, etc.
server-id = 1001

# --- Binary Logging (required for replication) ---
# The binlog is MySQL's write-ahead log. Every write operation
# is recorded here before being applied. Replicas read this log
# to reproduce the same writes.
log_bin = /var/log/mysql/mysql-bin

# ROW format logs the actual data changes (before/after images),
# not the SQL statements. This is critical for multi-region because:
#   1. Statement-based replication can produce different results on
#      different servers (e.g., NOW() returns different values)
#   2. Row-based replication is deterministic — the replica applies
#      the exact same data changes
#   3. CDC tools like Debezium require ROW format to capture changes
binlog_format = ROW

# Full row images include both before and after values for every
# column in the changed row. This is needed for conflict detection:
# you need to know what the row looked like BEFORE the change to
# detect whether another region changed the same row differently.
binlog_row_image = FULL

# Keep binlogs for 7 days. Cross-region replicas may fall behind
# during network issues, and they need old binlogs to catch up.
# Too short = replicas cannot recover from extended outages.
# Too long = disk fills up.
binlog_expire_logs_seconds = 604800

# --- GTID (Global Transaction Identifiers) ---
# GTID assigns a globally unique ID to every transaction.
# Format: source_uuid:transaction_number
# Example: 3E11FA47-71CA-11E1-9E33-C80AA9429562:23
#
# Why GTID matters for multi-region:
#   1. Replicas can identify exactly which transactions they have
#      and which they are missing, even after failover
#   2. During failover, the new primary knows exactly where to
#      resume replication — no manual binlog position tracking
#   3. Prevents duplicate transaction application: if a replica
#      already has GTID X, it skips it even if received again
gtid_mode = ON
enforce_gtid_consistency = ON

# --- Replication Filtering ---
# Only replicate our application databases, not system databases.
# This reduces cross-region bandwidth and avoids replicating
# region-specific admin operations.
binlog_do_db = booking_system
binlog_do_db = booking_analytics

# --- Semi-Synchronous Replication (for LOCAL replica only) ---
# Semi-sync means the primary waits for at least one replica to
# acknowledge receiving the transaction before returning success
# to the client. This guarantees zero data loss for the local
# replica (which is connected over a fast local network).
#
# We do NOT use semi-sync for cross-region replicas — waiting
# 250ms for Tokyo to acknowledge every write would be unacceptable.
plugin_load_add = "rpl_semi_sync_source=semisync_source.so"
rpl_semi_sync_source_enabled = 1

# Wait for 1 replica to acknowledge (the local one)
rpl_semi_sync_source_wait_for_replica_count = 1

# If no replica acknowledges within 1 second, fall back to async.
# This prevents the primary from hanging if the local replica dies.
rpl_semi_sync_source_timeout = 1000

# --- Performance Tuning for Replication ---
# Enable parallel replication on replicas reading from this source.
# WRITESET means transactions that touch different rows can be
# applied in parallel, dramatically improving replica throughput.
binlog_transaction_dependency_tracking = WRITESET

# --- Network and Timeout Settings for Cross-Region ---
# Cross-region connections are slower and less reliable.
# These timeouts prevent zombie connections from blocking replication.
slave_net_timeout = 60
replica_net_timeout = 60

# Maximum binlog size before rotation. 256MB files are a good
# balance between frequent rotation overhead and single-file size.
max_binlog_size = 256M

# --- InnoDB Settings for High-Throughput Writes ---
# Flush the redo log at each commit for durability.
# Combined with semi-sync, this guarantees no committed
# transaction is ever lost, even during a server crash.
innodb_flush_log_at_trx_commit = 1

# Sync the binlog to disk at every commit. Together with
# innodb_flush_log_at_trx_commit = 1, this is the "double-sync"
# configuration that guarantees crash-safe replication.
sync_binlog = 1

# Buffer pool should be ~70-80% of available RAM.
# The larger the buffer pool, the more data stays in memory
# and the fewer disk reads your queries need.
innodb_buffer_pool_size = 48G
```

### Replica Configuration — Local (Same-Region) Replica

The local replica sits in the same data center as the primary, connected by a fast local network. It uses semi-synchronous replication for zero data loss.

```ini
# =============================================================
# my.cnf — Local Replica (us-east-1, same data center)
# =============================================================

[mysqld]
server-id = 1002

# This replica is read-only. Application writes go to the primary.
read_only = ON
super_read_only = ON

# GTID-based replication (must match the source)
gtid_mode = ON
enforce_gtid_consistency = ON

# Enable semi-sync on the replica side
plugin_load_add = "rpl_semi_sync_replica=semisync_replica.so"
rpl_semi_sync_replica_enabled = 1

# Parallel replication: apply transactions in parallel using
# the WRITESET dependency information from the source.
# This lets the replica keep up with a high-throughput primary.
replica_parallel_type = LOGICAL_CLOCK
replica_parallel_workers = 16
replica_preserve_commit_order = ON

# If replication breaks, do not start it automatically on restart.
# This gives the operator a chance to inspect the error before
# replication resumes and potentially applies corrupt data.
skip_replica_start = ON

# Relay log settings
relay_log = /var/log/mysql/relay-bin
relay_log_recovery = ON
```

### Cross-Region Replica Configuration

Cross-region replicas connect over the public internet (or a dedicated inter-region link). They use asynchronous replication because the latency makes semi-sync impractical.

```ini
# =============================================================
# my.cnf — Cross-Region Replication Channel
# Applied on eu-west-1 primary to replicate FROM us-east-1
# =============================================================
# MySQL 8.0+ supports multi-source replication with named channels.
# Each channel pulls from a different source (region).

# On the eu-west-1 primary, run:
# CHANGE REPLICATION SOURCE TO
#   SOURCE_HOST = 'us-east-1-primary.internal',
#   SOURCE_PORT = 3306,
#   SOURCE_USER = 'repl_cross_region',
#   SOURCE_PASSWORD = '...',
#   SOURCE_AUTO_POSITION = 1,      -- use GTID, not binlog positions
#   SOURCE_SSL = 1,                -- encrypt cross-region traffic
#   SOURCE_CONNECT_RETRY = 10,     -- retry every 10 seconds on failure
#   SOURCE_RETRY_COUNT = 86400,    -- keep retrying for 24 hours
#   SOURCE_HEARTBEAT_PERIOD = 5,   -- heartbeat every 5 seconds
#   SOURCE_COMPRESSION_ALGORITHMS = 'zstd',  -- compress cross-region data
#   FOR CHANNEL 'us-east-1';       -- name this channel
```

> **Analogy:** Think of replication channels like postal routes between cities. The local replica is a courier within the same building -- fast, reliable, you wait for confirmation that the package was received (semi-sync). Cross-region replication is international mail -- it takes longer, you do not wait by the mailbox for confirmation (async), you compress the package to save on shipping costs (zstd), and if the postal service is disrupted, the letters queue up and get delivered when the route reopens (retry for 24 hours).

> **Common Mistake:** Using semi-synchronous replication for cross-region replicas. A developer once configured semi-sync across all replicas, including the Tokyo-to-London link. Every write in London waited 250ms for Tokyo to acknowledge. Write throughput dropped by 80%. The fix was a one-line config change, but it took three days to diagnose because the symptom looked like "the database is slow" rather than "replication is blocking writes."

---

## Replication Lag Monitoring: The Number You Cannot Ignore

Replication lag is the time difference between when a transaction commits on the source and when it is applied on the replica. For a local replica on a fast network, lag should be under 100 milliseconds. For cross-region replicas, lag of 1-5 seconds is normal and acceptable. Lag above 30 seconds is a warning. Lag above 5 minutes is an emergency.

Why does lag matter? Because your application reads from replicas. If a user creates a booking in London and then immediately views their bookings (which hits a replica), the booking might not be there yet if the replica is lagging. The user clicks "Book," gets a confirmation, refreshes the page, and their booking has vanished. They panic. They book again. Now you have a duplicate.

```typescript
// replication-lag-monitor.ts
// Monitors replication lag across all regions and raises alerts

import { createConnection, Connection } from 'mysql2/promise';

interface ReplicaLagInfo {
  region: string;
  channel: string;
  lagSeconds: number;
  replicaStatus: 'running' | 'stopped' | 'error';
  lastChecked: Date;
}

interface LagThresholds {
  localWarnSeconds: number;      // local replica warning threshold
  localCriticalSeconds: number;  // local replica critical threshold
  crossRegionWarnSeconds: number;
  crossRegionCriticalSeconds: number;
}

const DEFAULT_THRESHOLDS: LagThresholds = {
  localWarnSeconds: 1,
  localCriticalSeconds: 5,
  crossRegionWarnSeconds: 10,
  crossRegionCriticalSeconds: 30,
};

export class ReplicationLagMonitor {
  private readonly connections: Map<string, Connection> = new Map();
  private readonly thresholds: LagThresholds;
  private monitoringInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly regionConfigs: Array<{
      region: string;
      host: string;
      port: number;
      user: string;
      password: string;
    }>,
    thresholds?: Partial<LagThresholds>
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  async startMonitoring(intervalMs: number = 5000): Promise<void> {
    // Initialize connections to all regional primaries
    for (const config of this.regionConfigs) {
      const conn = await createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
      });
      this.connections.set(config.region, conn);
    }

    // Poll replication status at the specified interval
    this.monitoringInterval = setInterval(async () => {
      await this.checkAllRegions();
    }, intervalMs);

    console.log(
      `Replication lag monitor started. Checking every ${intervalMs}ms.`
    );
  }

  async stopMonitoring(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    for (const conn of this.connections.values()) {
      await conn.end();
    }
  }

  private async checkAllRegions(): Promise<void> {
    for (const [region, conn] of this.connections) {
      try {
        const lagInfos = await this.getReplicaLag(conn, region);

        for (const lagInfo of lagInfos) {
          this.evaluateAndAlert(lagInfo);
          this.emitMetric(lagInfo);
        }
      } catch (error) {
        console.error(
          `Failed to check replication lag for ${region}:`,
          error
        );
        this.emitAlert('error', region, 'unknown',
          `Replication monitoring query failed: ${error}`
        );
      }
    }
  }

  private async getReplicaLag(
    conn: Connection,
    region: string
  ): Promise<ReplicaLagInfo[]> {
    // SHOW REPLICA STATUS returns one row per replication channel.
    // For multi-source replication, we get one row for each source
    // region that this server replicates from.
    const [rows] = await conn.execute(
      'SHOW REPLICA STATUS'
    ) as any[];

    if (!rows || rows.length === 0) {
      // This server is not a replica (it is a standalone primary)
      // or replication is not configured.
      return [];
    }

    return rows.map((row: any) => ({
      region,
      channel: row.Channel_Name || 'default',
      lagSeconds: row.Seconds_Behind_Source ?? -1,
      replicaStatus:
        row.Replica_IO_Running === 'Yes' &&
        row.Replica_SQL_Running === 'Yes'
          ? 'running'
          : row.Last_Error
            ? 'error'
            : 'stopped',
      lastChecked: new Date(),
    }));
  }

  private evaluateAndAlert(lagInfo: ReplicaLagInfo): void {
    const isLocal = lagInfo.channel === 'default'
      || lagInfo.channel === 'local';
    const warnThreshold = isLocal
      ? this.thresholds.localWarnSeconds
      : this.thresholds.crossRegionWarnSeconds;
    const criticalThreshold = isLocal
      ? this.thresholds.localCriticalSeconds
      : this.thresholds.crossRegionCriticalSeconds;

    if (lagInfo.replicaStatus === 'error') {
      this.emitAlert('critical', lagInfo.region, lagInfo.channel,
        `Replication channel ${lagInfo.channel} is in ERROR state`
      );
      return;
    }

    if (lagInfo.replicaStatus === 'stopped') {
      this.emitAlert('critical', lagInfo.region, lagInfo.channel,
        `Replication channel ${lagInfo.channel} is STOPPED`
      );
      return;
    }

    if (lagInfo.lagSeconds >= criticalThreshold) {
      this.emitAlert('critical', lagInfo.region, lagInfo.channel,
        `Lag is ${lagInfo.lagSeconds}s (threshold: ${criticalThreshold}s)`
      );
    } else if (lagInfo.lagSeconds >= warnThreshold) {
      this.emitAlert('warning', lagInfo.region, lagInfo.channel,
        `Lag is ${lagInfo.lagSeconds}s (threshold: ${warnThreshold}s)`
      );
    }
  }

  private emitMetric(lagInfo: ReplicaLagInfo): void {
    // Emit to your metrics system (Prometheus, CloudWatch, Datadog)
    // This enables dashboards and historical lag analysis
    const metric = {
      name: 'mysql_replication_lag_seconds',
      value: lagInfo.lagSeconds,
      tags: {
        region: lagInfo.region,
        channel: lagInfo.channel,
        status: lagInfo.replicaStatus,
      },
      timestamp: lagInfo.lastChecked.toISOString(),
    };
    // metricsClient.gauge(metric.name, metric.value, metric.tags);
    console.log(`[METRIC] ${JSON.stringify(metric)}`);
  }

  private emitAlert(
    severity: 'warning' | 'critical' | 'error',
    region: string,
    channel: string,
    message: string
  ): void {
    console.log(
      `[ALERT][${severity.toUpperCase()}] Region: ${region}, ` +
      `Channel: ${channel} — ${message}`
    );
    // In production: send to PagerDuty, Slack, OpsGenie, etc.
  }
}
```

> **What If You Skip This?** Without lag monitoring, you will not know your cross-region replica is 45 minutes behind until a user in Tokyo reports they cannot see bookings made in London. By then, 45 minutes of data appears "missing" to an entire region. Lag monitoring costs a single lightweight query per region every few seconds. Not monitoring costs your on-call engineer's sleep.

---

## Prisma Schema with Multi-Region Connection Strategy

Your application needs to talk to the right database at the right time. Reads can go to any replica (usually the nearest one). Writes must go to the regional primary. And sometimes, after a write, you need to read from the primary to guarantee you see your own write. This is called **read-after-write consistency**.

Here is how we structure our Prisma configuration for multi-region:

```prisma
// schema.prisma
// Multi-region connection strategy with read/write splitting

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  // The default URL points to the regional primary (writes).
  // Read replicas are configured at the application level.
  url      = env("DATABASE_PRIMARY_URL")
}

model Booking {
  id            BigInt     @id @default(autoincrement())
  roomId        String     @map("room_id")
  guestId       String     @map("guest_id")
  checkIn       DateTime   @map("check_in")
  checkOut      DateTime   @map("check_out")
  status        String     @default("CONFIRMED")
  fencingToken  BigInt     @map("fencing_token")
  sourceRegion  String     @map("source_region")
  vectorClock   Json?      @map("vector_clock")
  createdAt     DateTime   @default(now()) @map("created_at")
  updatedAt     DateTime   @updatedAt @map("updated_at")

  @@index([roomId, checkIn, checkOut])
  @@index([guestId])
  @@index([sourceRegion])
  @@map("bookings")
}

model InventoryReservation {
  id            BigInt     @id @default(autoincrement())
  resourceType  String     @map("resource_type")
  resourceId    String     @map("resource_id")
  resourceDate  DateTime   @map("resource_date")
  fencingToken  BigInt     @map("fencing_token")
  status        String     @default("PENDING")
  region        String
  createdAt     DateTime   @default(now()) @map("created_at")

  @@unique([resourceType, resourceId, resourceDate])
  @@map("inventory_reservations")
}
```

```typescript
// multi-region-db.ts
// Database connection manager with read/write splitting

import { PrismaClient } from '@prisma/client';

interface RegionDbConfig {
  primaryUrl: string;
  replicaUrls: string[];
  region: string;
}

export class MultiRegionDatabase {
  private readonly writer: PrismaClient;
  private readonly readers: PrismaClient[];
  private readerIndex: number = 0;
  private readonly region: string;

  constructor(config: RegionDbConfig) {
    this.region = config.region;

    // The writer always points to the regional primary.
    // All INSERT, UPDATE, DELETE operations go here.
    this.writer = new PrismaClient({
      datasources: {
        db: { url: config.primaryUrl },
      },
      log: ['warn', 'error'],
    });

    // Readers point to local replicas for fast reads.
    // We round-robin across available replicas.
    this.readers = config.replicaUrls.map(
      (url) =>
        new PrismaClient({
          datasources: {
            db: { url },
          },
          log: ['warn', 'error'],
        })
    );

    // If no replicas are configured, fall back to reading from
    // the primary. This handles the case where a region has not
    // yet set up read replicas.
    if (this.readers.length === 0) {
      this.readers.push(this.writer);
    }
  }

  /**
   * Get a client for WRITE operations (INSERT, UPDATE, DELETE).
   * Always returns the regional primary connection.
   */
  getWriter(): PrismaClient {
    return this.writer;
  }

  /**
   * Get a client for READ operations (SELECT).
   * Round-robins across available read replicas.
   * Use this for queries where slight staleness is acceptable
   * (e.g., browsing hotel listings, viewing search results).
   */
  getReader(): PrismaClient {
    const reader = this.readers[this.readerIndex];
    this.readerIndex = (this.readerIndex + 1) % this.readers.length;
    return reader;
  }

  /**
   * Get a client for CONSISTENT READ operations.
   * Returns the primary connection so you read your own writes.
   *
   * Use this when the user just performed a write and needs to
   * immediately see the result (e.g., after creating a booking,
   * redirect to a page that shows the booking details).
   */
  getConsistentReader(): PrismaClient {
    return this.writer;
  }

  async disconnect(): Promise<void> {
    await this.writer.$disconnect();
    for (const reader of this.readers) {
      if (reader !== this.writer) {
        await reader.$disconnect();
      }
    }
  }
}

// --- Usage Examples ---

const db = new MultiRegionDatabase({
  region: process.env.REGION!,
  primaryUrl: process.env.DATABASE_PRIMARY_URL!,
  replicaUrls: (process.env.DATABASE_REPLICA_URLS || '')
    .split(',')
    .filter(Boolean),
});

// Browsing hotels: read from replica (fast, slight staleness OK)
async function searchHotels(city: string) {
  const reader = db.getReader();
  return reader.booking.findMany({
    where: { roomId: { startsWith: city } },
  });
}

// Creating a booking: write to primary
async function createBooking(data: any) {
  const writer = db.getWriter();
  return writer.booking.create({ data });
}

// Viewing booking after creation: read from primary (consistent)
async function getBookingAfterCreate(bookingId: bigint) {
  const reader = db.getConsistentReader();
  return reader.booking.findUnique({
    where: { id: bookingId },
  });
}
```

> **Common Mistake:** Reading from a replica immediately after a write and expecting to see the data. A developer once wrote a `createBooking()` function followed by `getBooking()` that hit a replica. One in every hundred users saw "Booking not found" right after booking. The fix: use `getConsistentReader()` (which reads from the primary) for any read that follows a write in the same user session. Save the replica reads for truly read-only flows like search and browsing.

---

## Data Sovereignty Implementation: Keeping Data Where the Law Says It Must Stay

Data sovereignty is not a feature you add later. It is a constraint that shapes your entire data architecture. If a German user's personal data leaves the EU, even for a millisecond in a cross-region replication stream, you are violating GDPR. The fine is up to 4% of global annual turnover. For a large booking platform, that could be hundreds of millions of dollars.

### The Routing Layer: GDPR-Aware Request Routing

Every incoming request must be routed to the correct region based on the user's data residency requirements, not just their geographic proximity.

```typescript
// data-sovereignty-router.ts
// Routes requests to the legally correct region

interface DataResidencyRule {
  region: string;
  countries: string[];
  regulation: string;
  personalDataMustStayInRegion: boolean;
  allowedReplicationTargets: string[];
}

// These rules are defined by your legal team, not your engineering team.
// Treat them as immutable configuration, not business logic.
const DATA_RESIDENCY_RULES: DataResidencyRule[] = [
  {
    region: 'eu-west-1',
    countries: [
      'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'PT', 'FI', 'IE',
      'GR', 'SE', 'DK', 'PL', 'CZ', 'RO', 'HU', 'BG', 'HR', 'SK',
      'SI', 'LT', 'LV', 'EE', 'CY', 'LU', 'MT',
      // EEA members
      'NO', 'IS', 'LI',
      // Adequacy decision countries (can receive EU data)
      'GB', 'CH', 'JP', 'NZ', 'IL', 'KR', 'CA',
    ],
    regulation: 'GDPR',
    personalDataMustStayInRegion: true,
    allowedReplicationTargets: ['eu-west-1'],
    // EU personal data stays in EU. Period.
    // Booking metadata (anonymized) can replicate globally.
  },
  {
    region: 'ap-northeast-1',
    countries: ['JP'],
    regulation: 'APPI',
    personalDataMustStayInRegion: true,
    allowedReplicationTargets: ['ap-northeast-1', 'eu-west-1'],
    // Japan allows transfer to EU (adequacy decision both ways)
  },
  {
    region: 'sa-east-1',
    countries: ['BR'],
    regulation: 'LGPD',
    personalDataMustStayInRegion: true,
    allowedReplicationTargets: ['sa-east-1'],
  },
  {
    region: 'us-east-1',
    countries: ['US', 'MX'],
    regulation: 'CCPA/State',
    personalDataMustStayInRegion: false,
    allowedReplicationTargets: ['us-east-1', 'eu-west-1',
      'ap-northeast-1', 'sa-east-1'],
    // US has no federal data residency requirement (as of 2026)
  },
];

export class DataSovereigntyRouter {
  private readonly rulesByCountry: Map<string, DataResidencyRule>;

  constructor() {
    this.rulesByCountry = new Map();
    for (const rule of DATA_RESIDENCY_RULES) {
      for (const country of rule.countries) {
        this.rulesByCountry.set(country, rule);
      }
    }
  }

  /**
   * Determine the correct region for a user's data based on
   * their country of residence (not their current location).
   *
   * A German tourist booking from a hotel in New York is still
   * GDPR-protected. Their data goes to eu-west-1, not us-east-1.
   */
  getDataRegion(userCountryCode: string): string {
    const rule = this.rulesByCountry.get(userCountryCode);
    if (!rule) {
      // Unknown country: default to US region (least restrictive)
      // but flag for legal review
      console.warn(
        `No data residency rule for country: ${userCountryCode}. ` +
        `Defaulting to us-east-1. FLAG FOR LEGAL REVIEW.`
      );
      return 'us-east-1';
    }
    return rule.region;
  }

  /**
   * Check whether a specific data field can be replicated to
   * a target region. Personal data (name, email, phone) may
   * be restricted. Anonymized data (booking counts, revenue
   * aggregates) is usually fine.
   */
  canReplicateField(
    fieldName: string,
    sourceRegion: string,
    targetRegion: string
  ): boolean {
    // If source and target are the same region, always allowed.
    if (sourceRegion === targetRegion) return true;

    // Non-personal fields can replicate freely.
    const personalFields = [
      'guest_name', 'email', 'phone', 'passport_number',
      'credit_card', 'address', 'date_of_birth', 'ip_address',
    ];

    if (!personalFields.includes(fieldName)) return true;

    // For personal fields, check the residency rule.
    const rule = DATA_RESIDENCY_RULES.find(
      (r) => r.region === sourceRegion
    );
    if (!rule) return false;

    return rule.allowedReplicationTargets.includes(targetRegion);
  }
}
```

### Per-Region Data Storage: What Gets Replicated and What Does Not

The key insight is that not all fields in a booking record need to cross regional boundaries. You split the data into two categories:

```typescript
// data-classification.ts
// Defines what data can cross regional boundaries

interface BookingRecord {
  // === GLOBALLY REPLICATED (operational data) ===
  // These fields contain no personal information and are
  // needed by all regions for inventory management and
  // conflict resolution.
  id: bigint;
  roomId: string;
  hotelId: string;
  checkIn: Date;
  checkOut: Date;
  status: string;
  fencingToken: bigint;
  sourceRegion: string;
  totalPrice: number;      // price, not who paid it
  currencyCode: string;

  // === REGION-LOCAL ONLY (personal data) ===
  // These fields stay in the user's data region. They are
  // NEVER included in cross-region replication streams.
  // Other regions see these as NULL.
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  passportNumber: string | null;
  paymentMethodLast4: string | null;
  ipAddress: string | null;
}

// MySQL replication filter to exclude personal data columns
// from cross-region binlog streams:
//
// On the eu-west-1 primary, for the channel replicating TO us-east-1:
//
// CHANGE REPLICATION FILTER
//   REPLICATE_WILD_DO_TABLE = ('booking_system.%'),
//   -- We cannot filter columns in MySQL replication natively.
//   -- Instead, we use a separate table structure:
//   --   bookings          (global data, replicated everywhere)
//   --   bookings_pii      (personal data, region-local only)
//   REPLICATE_IGNORE_TABLE = (
//     'booking_system.bookings_pii',
//     'booking_system.guest_profiles',
//     'booking_system.payment_methods'
//   )
//   FOR CHANNEL 'us-east-1';
```

> **Production War Story:** In 2024, a mid-size European travel platform was fined 2.3 million euros because their cross-region MySQL replication included guest email addresses in the binlog stream flowing from Frankfurt to Virginia. The emails of 400,000 EU residents were stored, even temporarily, on US servers. The platform argued the data was "in transit" and encrypted. The regulator disagreed. The fix was simple: split personal data into a separate table that is excluded from cross-region replication. The fine was not simple to pay. Learn from their mistake.

> **What If You Skip This?** If you do not implement data sovereignty routing from day one, retrofitting it later means migrating millions of user records between regions, rewriting replication filters while the system is live, and hoping you do not miss any personal data fields. Companies that skip this typically discover the problem when they receive a regulatory inquiry. By then, the violation has been ongoing for months or years.

---

## DNS-Based Routing: Getting Users to the Right Region

Your application runs in four regions. When a user types `booking.example.com`, how does their browser know which region to connect to? The answer is DNS-based routing, and AWS Route 53 is the most common tool for this in AWS deployments.

### Latency-Based Routing with Route 53

```
DNS Request Flow:

  User in Tokyo types booking.example.com
      │
      ▼
  Local DNS Resolver (ISP or corporate)
      │
      ▼
  Route 53 receives the query
      │
      ├─ Measures latency from resolver to each region
      │  us-east-1: 180ms
      │  eu-west-1: 250ms
      │  ap-northeast-1: 5ms   ← lowest
      │  sa-east-1: 300ms
      │
      ▼
  Returns IP of ap-northeast-1 load balancer
      │
      ▼
  User connects to Tokyo region (5ms latency)
```

### Route 53 Configuration (Terraform)

```hcl
# route53-multi-region.tf
# Latency-based routing with health checks and failover

# Health checks — Route 53 pings each region every 10 seconds.
# If a region fails 3 consecutive checks, it is removed from DNS.
resource "aws_route53_health_check" "us_east_1" {
  fqdn              = "api-us-east-1.booking.example.com"
  port               = 443
  type               = "HTTPS"
  resource_path      = "/health"
  failure_threshold  = 3
  request_interval   = 10

  tags = {
    Name   = "us-east-1-health-check"
    Region = "us-east-1"
  }
}

resource "aws_route53_health_check" "eu_west_1" {
  fqdn              = "api-eu-west-1.booking.example.com"
  port               = 443
  type               = "HTTPS"
  resource_path      = "/health"
  failure_threshold  = 3
  request_interval   = 10

  tags = {
    Name   = "eu-west-1-health-check"
    Region = "eu-west-1"
  }
}

resource "aws_route53_health_check" "ap_northeast_1" {
  fqdn              = "api-ap-northeast-1.booking.example.com"
  port               = 443
  type               = "HTTPS"
  resource_path      = "/health"
  failure_threshold  = 3
  request_interval   = 10

  tags = {
    Name   = "ap-northeast-1-health-check"
    Region = "ap-northeast-1"
  }
}

# Latency-based DNS records — Route 53 returns the IP of the
# region with the lowest measured latency to the requesting resolver.
resource "aws_route53_record" "us_east_1" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.booking.example.com"
  type    = "A"

  alias {
    name                   = aws_lb.us_east_1.dns_name
    zone_id                = aws_lb.us_east_1.zone_id
    evaluate_target_health = true
  }

  set_identifier = "us-east-1"
  latency_routing_policy {
    region = "us-east-1"
  }
  health_check_id = aws_route53_health_check.us_east_1.id
}

resource "aws_route53_record" "eu_west_1" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.booking.example.com"
  type    = "A"

  alias {
    name                   = aws_lb.eu_west_1.dns_name
    zone_id                = aws_lb.eu_west_1.zone_id
    evaluate_target_health = true
  }

  set_identifier = "eu-west-1"
  latency_routing_policy {
    region = "eu-west-1"
  }
  health_check_id = aws_route53_health_check.eu_west_1.id
}

resource "aws_route53_record" "ap_northeast_1" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.booking.example.com"
  type    = "A"

  alias {
    name                   = aws_lb.ap_northeast_1.dns_name
    zone_id                = aws_lb.ap_northeast_1.zone_id
    evaluate_target_health = true
  }

  set_identifier = "ap-northeast-1"
  latency_routing_policy {
    region = "ap-northeast-1"
  }
  health_check_id = aws_route53_health_check.ap_northeast_1.id
}
```

> **Common Mistake:** Relying only on DNS for failover without considering TTL (Time-To-Live). Route 53 health checks detect a region failure in 30 seconds (3 checks x 10 seconds). But DNS resolvers cache the old IP for the duration of the TTL. If your TTL is 300 seconds (5 minutes), users keep hitting the dead region for up to 5 minutes after Route 53 has removed it. Set your TTL to 60 seconds for latency-based records. You pay slightly more DNS query costs, but failover happens in under 2 minutes instead of under 7.

---

## Regional Failover Orchestration

When a region goes down, the system needs to redirect traffic, promote replicas, and re-route data pipelines. This is not a single button press. It is a choreographed sequence of operations that must happen in the right order.

### The Failover Procedure

```typescript
// regional-failover.ts
// Orchestrates failover when a region becomes unhealthy

interface RegionHealth {
  region: string;
  healthy: boolean;
  lastHealthCheck: Date;
  consecutiveFailures: number;
  dbPrimaryReachable: boolean;
  kafkaBrokersReachable: boolean;
  redisPrimaryReachable: boolean;
}

interface FailoverStep {
  name: string;
  execute: () => Promise<void>;
  rollback: () => Promise<void>;
  timeout: number;
}

export class RegionalFailoverOrchestrator {
  private readonly currentRegion = process.env.REGION!;
  private failoverInProgress = false;

  /**
   * Execute a full regional failover. This is called when a region
   * has been unhealthy for longer than the failover threshold
   * (typically 60 seconds of consecutive health check failures).
   */
  async executeFailover(failedRegion: string): Promise<void> {
    if (this.failoverInProgress) {
      console.warn('Failover already in progress. Skipping.');
      return;
    }
    this.failoverInProgress = true;

    console.log(`[FAILOVER] Starting failover for region: ${failedRegion}`);

    const steps: FailoverStep[] = [
      {
        // Step 1: Remove the failed region from DNS so new requests
        // stop going there. This is the fastest way to stop the bleeding.
        name: 'Remove failed region from DNS',
        execute: async () => {
          await this.updateDnsHealthCheck(failedRegion, false);
          // Route 53 propagates within 60 seconds with TTL=60
          console.log(`[FAILOVER] DNS updated: ${failedRegion} removed`);
        },
        rollback: async () => {
          await this.updateDnsHealthCheck(failedRegion, true);
        },
        timeout: 10_000,
      },
      {
        // Step 2: Pause replication channels FROM the failed region.
        // Other regions should stop trying to pull data from a dead
        // source — it generates errors that fill up logs.
        name: 'Pause inbound replication from failed region',
        execute: async () => {
          await this.pauseReplicationChannel(failedRegion);
          console.log(
            `[FAILOVER] Replication from ${failedRegion} paused`
          );
        },
        rollback: async () => {
          await this.resumeReplicationChannel(failedRegion);
        },
        timeout: 5_000,
      },
      {
        // Step 3: Redirect resources that were "homed" in the failed
        // region to surviving regions. The regional partitioning
        // strategy assigns each resource a home region. If that
        // region is down, we temporarily reassign to the nearest
        // surviving region.
        name: 'Reassign resource home regions',
        execute: async () => {
          const nearestRegion = this.getNearestSurvivingRegion(
            failedRegion
          );
          await this.reassignHomeRegion(failedRegion, nearestRegion);
          console.log(
            `[FAILOVER] Resources from ${failedRegion} reassigned ` +
            `to ${nearestRegion}`
          );
        },
        rollback: async () => {
          await this.reassignHomeRegion(
            this.getNearestSurvivingRegion(failedRegion),
            failedRegion
          );
        },
        timeout: 30_000,
      },
      {
        // Step 4: Notify all services in surviving regions to
        // expect increased traffic. Auto-scaling policies should
        // handle this, but an explicit notification lets services
        // pre-warm caches and increase connection pool sizes.
        name: 'Notify surviving regions of increased load',
        execute: async () => {
          await this.broadcastFailoverEvent(failedRegion);
          console.log('[FAILOVER] Surviving regions notified');
        },
        rollback: async () => {
          await this.broadcastRecoveryEvent(failedRegion);
        },
        timeout: 5_000,
      },
    ];

    // Execute steps in order. If any step fails, roll back
    // all previously completed steps in reverse order.
    const completedSteps: FailoverStep[] = [];

    for (const step of steps) {
      try {
        console.log(`[FAILOVER] Executing: ${step.name}`);
        await Promise.race([
          step.execute(),
          this.timeoutPromise(step.timeout, step.name),
        ]);
        completedSteps.push(step);
      } catch (error) {
        console.error(
          `[FAILOVER] Step failed: ${step.name}`,
          error
        );

        // Roll back completed steps in reverse order
        for (const completed of completedSteps.reverse()) {
          try {
            await completed.rollback();
          } catch (rollbackError) {
            console.error(
              `[FAILOVER] Rollback failed: ${completed.name}`,
              rollbackError
            );
          }
        }

        this.failoverInProgress = false;
        throw new Error(`Failover aborted at step: ${step.name}`);
      }
    }

    console.log(`[FAILOVER] Failover complete for ${failedRegion}`);
    this.failoverInProgress = false;
  }

  private getNearestSurvivingRegion(failedRegion: string): string {
    // Map each region to its nearest neighbor for failover
    const failoverMap: Record<string, string> = {
      'us-east-1': 'eu-west-1',       // Virginia -> Ireland
      'eu-west-1': 'us-east-1',       // Ireland -> Virginia
      'ap-northeast-1': 'eu-west-1',  // Tokyo -> Ireland
      'sa-east-1': 'us-east-1',       // Sao Paulo -> Virginia
    };
    return failoverMap[failedRegion] || 'us-east-1';
  }

  private timeoutPromise(ms: number, stepName: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Step timed out: ${stepName}`)),
        ms
      )
    );
  }

  // Placeholder methods — actual implementations depend on your
  // cloud provider and infrastructure tooling (Terraform, AWS SDK, etc.)
  private async updateDnsHealthCheck(
    region: string, healthy: boolean
  ): Promise<void> { /* Route 53 API call */ }
  private async pauseReplicationChannel(
    region: string
  ): Promise<void> { /* STOP REPLICA FOR CHANNEL */ }
  private async resumeReplicationChannel(
    region: string
  ): Promise<void> { /* START REPLICA FOR CHANNEL */ }
  private async reassignHomeRegion(
    from: string, to: string
  ): Promise<void> { /* Update resource routing table */ }
  private async broadcastFailoverEvent(
    failedRegion: string
  ): Promise<void> { /* Kafka event to all regions */ }
  private async broadcastRecoveryEvent(
    failedRegion: string
  ): Promise<void> { /* Kafka event to all regions */ }
}
```

> **Production War Story:** A team ran their first regional failover drill at 2 AM on a Saturday (to minimize impact). Step 1 worked: DNS stopped sending traffic to the "failed" region. Step 3 failed: the resource reassignment query timed out because it tried to update 12 million rows in a single transaction. The failover stalled for 40 minutes. Meanwhile, users whose resources were homed in the "failed" region could not book anything. The fix was to batch the reassignment into chunks of 10,000 rows. The lesson: always test your failover procedure under production-like data volumes, not on a staging database with 500 rows.

---

## Cross-Region Kafka Replication with MirrorMaker 2

Your regional Kafka clusters need to share data. When Tokyo publishes an `inventory.reserved` event, London needs to receive it for conflict detection. Kafka does not natively replicate across clusters. You need **MirrorMaker 2** (MM2), which is part of Apache Kafka and mirrors topics between clusters.

### MirrorMaker 2 Configuration

```properties
# mm2-config.properties
# MirrorMaker 2 configuration for cross-region topic mirroring

# Define the Kafka clusters (one per region)
clusters = us-east-1, eu-west-1, ap-northeast-1, sa-east-1

# Cluster connection settings
us-east-1.bootstrap.servers = kafka-us-east-1-1:9092,kafka-us-east-1-2:9092,kafka-us-east-1-3:9092
eu-west-1.bootstrap.servers = kafka-eu-west-1-1:9092,kafka-eu-west-1-2:9092,kafka-eu-west-1-3:9092
ap-northeast-1.bootstrap.servers = kafka-ap-ne-1-1:9092,kafka-ap-ne-1-2:9092,kafka-ap-ne-1-3:9092
sa-east-1.bootstrap.servers = kafka-sa-east-1-1:9092,kafka-sa-east-1-2:9092,kafka-sa-east-1-3:9092

# --- Replication flows ---
# Each flow defines: source -> target, which topics to mirror.
# We replicate the global topics (inventory, conflicts) but NOT
# region-local topics (local logs, metrics).

# us-east-1 -> eu-west-1
us-east-1->eu-west-1.enabled = true
us-east-1->eu-west-1.topics = inventory-reservations-global, inventory-conflicts, booking-events
# Do NOT replicate internal/operational topics
us-east-1->eu-west-1.topics.exclude = .*\\.internal, __consumer_offsets, __transaction_state

# eu-west-1 -> us-east-1
eu-west-1->us-east-1.enabled = true
eu-west-1->us-east-1.topics = inventory-reservations-global, inventory-conflicts, booking-events
eu-west-1->us-east-1.topics.exclude = .*\\.internal, __consumer_offsets, __transaction_state

# ap-northeast-1 -> us-east-1
ap-northeast-1->us-east-1.enabled = true
ap-northeast-1->us-east-1.topics = inventory-reservations-global, inventory-conflicts, booking-events

# us-east-1 -> ap-northeast-1
us-east-1->ap-northeast-1.enabled = true
us-east-1->ap-northeast-1.topics = inventory-reservations-global, inventory-conflicts, booking-events

# (Similar entries for sa-east-1 <-> all others)

# --- Topic naming ---
# By default, MM2 prefixes mirrored topics with the source cluster name.
# us-east-1.inventory-reservations-global (on eu-west-1 cluster)
# This prevents name collisions with the local version of the topic.
replication.policy.class = org.apache.kafka.connect.mirror.DefaultReplicationPolicy
replication.policy.separator = .

# --- Performance tuning ---
# Number of replication tasks per flow (parallelism)
tasks.max = 4

# How frequently to check for new topics to mirror (5 minutes)
refresh.topics.interval.seconds = 300

# How frequently to sync consumer group offsets (1 minute)
sync.group.offsets.enabled = true
sync.group.offsets.interval.seconds = 60

# Emit heartbeats so we can monitor MM2 liveness
emit.heartbeats.enabled = true
emit.heartbeats.interval.seconds = 10

# Compression for cross-region transfer (saves bandwidth)
producer.compression.type = zstd

# Increase batch size for cross-region efficiency
producer.batch.size = 65536
producer.linger.ms = 100
```

> **Analogy:** MirrorMaker 2 is like a network of translators at the United Nations. Each country's delegation (Kafka cluster) speaks in its own session (publishes to local topics). The translators (MM2) listen to each delegation and repeat the relevant speeches to every other delegation in their own room. The speakers do not need to know about the translation process. They just speak. The translators handle the rest.

---

## Redis Cross-Region Sync Strategy

Redis serves two critical roles in our multi-region system: distributed locking (for fencing tokens) and pub/sub (for conflict notifications). Each role has different cross-region requirements.

```typescript
// redis-multi-region.ts
// Redis configuration strategy for cross-region deployment

interface RedisRegionConfig {
  region: string;
  lockCluster: {
    // Each region has its own Redis cluster for locks.
    // Locks are REGION-LOCAL. A lock acquired in Tokyo only
    // exists in Tokyo's Redis cluster. This is intentional:
    // cross-region locks would add 200ms+ to every lock
    // acquisition, making the system unusably slow.
    nodes: string[];
  };
  cacheCluster: {
    // Each region has its own cache cluster.
    // Cache is eventually consistent across regions.
    // We use a "write-through, invalidate-remote" strategy:
    //   1. When a write happens, update the local cache.
    //   2. Publish an invalidation message to other regions.
    //   3. Other regions delete the stale entry from their cache.
    //   4. Next read in those regions fetches fresh data from DB.
    nodes: string[];
  };
  pubsubCluster: {
    // Pub/sub for real-time conflict notifications.
    // Region-local: conflict signals only need to reach the
    // local waitForGlobalConsensus() listeners.
    nodes: string[];
  };
}

export class MultiRegionRedisManager {
  private readonly configs: Map<string, RedisRegionConfig> = new Map();
  private readonly localRegion = process.env.REGION!;

  /**
   * Invalidate a cache key across all regions.
   * Called after any write that changes data other regions might cache.
   */
  async invalidateGlobally(cacheKey: string): Promise<void> {
    // Step 1: Delete from local cache immediately
    await this.getLocalCache().del(cacheKey);

    // Step 2: Publish invalidation to a Kafka topic
    // (not Redis pub/sub — Kafka survives partitions, Redis doesn't)
    await this.publishCacheInvalidation({
      key: cacheKey,
      sourceRegion: this.localRegion,
      timestamp: Date.now(),
    });

    // Other regions' cache invalidation consumers will receive
    // this message and delete the key from their local Redis.
  }

  /**
   * Read-through cache with region awareness.
   * Reads from local Redis first. On cache miss, fetches from DB.
   * On cache hit, checks if the data is too stale (based on the
   * cross-region replication lag tolerance).
   */
  async getWithRegionAwareness<T>(
    cacheKey: string,
    fetchFromDb: () => Promise<T>,
    options: { maxStalenessMs?: number } = {}
  ): Promise<T> {
    const maxStale = options.maxStalenessMs ?? 5000; // 5s default

    const cached = await this.getLocalCache().get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      const age = Date.now() - parsed._cachedAt;

      if (age < maxStale) {
        return parsed.data as T;
      }
      // Cache entry is too old — fetch fresh data
    }

    // Cache miss or stale: fetch from database
    const fresh = await fetchFromDb();

    // Store in local cache with timestamp
    await this.getLocalCache().set(
      cacheKey,
      JSON.stringify({ data: fresh, _cachedAt: Date.now() }),
      'EX',
      300 // 5-minute TTL as a safety net
    );

    return fresh;
  }

  private getLocalCache(): any {
    return this.configs.get(this.localRegion)?.cacheCluster;
  }

  private async publishCacheInvalidation(event: any): Promise<void> {
    // Publishes to Kafka topic: cache-invalidations
    // All regions consume this topic and delete the specified key
  }
}
```

> **Common Mistake:** Running a single global Redis cluster (like AWS ElastiCache Global Datastore) for distributed locking. A team tried this and every lock acquisition took 200-400ms because Redis had to replicate the lock to the secondary region before acknowledging. At 100,000 bookings per minute, that is 100,000 cross-region round trips per minute just for locks. The fix: use region-local Redis for locking and accept that locks only provide intra-region mutual exclusion. Cross-region conflicts are handled by the fencing token mechanism at the application layer, not by distributed locks.

---

## Latency Budgets Per Region

Every booking flow has a total latency budget. When you break that budget, users bounce. The budget is not uniform across regions because cross-region hops have different costs depending on geographic distance.

| Operation | us-east-1 (local) | eu-west-1 (local) | ap-northeast-1 (local) | Cross-Region Hop (worst case) |
|---|---|---|---|---|
| DNS resolution | 5 ms | 5 ms | 5 ms | N/A (always local) |
| TLS handshake | 10 ms | 10 ms | 10 ms | +150-250 ms |
| Load balancer routing | 2 ms | 2 ms | 2 ms | N/A |
| API gateway auth | 8 ms | 8 ms | 8 ms | N/A |
| Redis lock acquisition | 3 ms | 3 ms | 3 ms | +180-260 ms (do not do this) |
| MySQL write (primary) | 5 ms | 5 ms | 5 ms | +160-240 ms (forwarded write) |
| MySQL read (replica) | 3 ms | 3 ms | 3 ms | N/A (always local replica) |
| Kafka publish (outbox) | 5 ms | 5 ms | 5 ms | N/A (local Kafka) |
| Conflict consensus wait | 2,000 ms | 2,000 ms | 2,000 ms | N/A (fixed timeout) |
| **Total (local booking)** | **~41 ms** | **~41 ms** | **~41 ms** | — |
| **Total (forwarded to home region)** | **~250-350 ms** | **~250-350 ms** | **~250-350 ms** | — |
| **Total (with consensus wait)** | **~2,041 ms** | **~2,041 ms** | **~2,041 ms** | — |

The consensus wait is the dominant factor. Notice that the actual database and service operations take under 50ms. The 2-second wait is the price of distributed conflict resolution. This is why we return an optimistic confirmation to the user ("Booking received!") and handle the consensus check asynchronously, notifying the user only if a conflict is detected.

> **What If You Skip This?** Without latency budgets, you will not notice when a seemingly small change adds 50ms to every request in a specific region. Those milliseconds accumulate across the booking flow. A team once added a "quick" cross-region cache check that added 180ms to every Tokyo request. They did not have a latency budget, so nobody flagged it. Booking completions in Asia dropped 12% over two weeks before anyone connected the dots.

---

## Testing Multi-Region Locally with Docker Compose

You cannot deploy to four AWS regions every time you want to test a replication change. Here is a Docker Compose setup that simulates a multi-region environment on your local machine using network delay simulation.

```yaml
# docker-compose.multi-region.yml
# Simulates a 3-region deployment with network latency

version: "3.8"

# Define separate networks to simulate regional boundaries.
# Traffic between networks goes through a simulated WAN link.
networks:
  us-east-1:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/24
  eu-west-1:
    driver: bridge
    ipam:
      config:
        - subnet: 172.21.0.0/24
  ap-northeast-1:
    driver: bridge
    ipam:
      config:
        - subnet: 172.22.0.0/24
  # Cross-region "WAN" network — all regions connect here
  # to communicate with each other
  wan:
    driver: bridge
    ipam:
      config:
        - subnet: 172.30.0.0/24

services:
  # =================== US-EAST-1 ===================
  mysql-us-east-1:
    image: mysql:8.0
    container_name: mysql-us-east-1
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: booking_system
    volumes:
      - ./config/mysql/us-east-1.cnf:/etc/mysql/conf.d/region.cnf
      - mysql-us-data:/var/lib/mysql
    networks:
      us-east-1:
        ipv4_address: 172.20.0.10
      wan:
        ipv4_address: 172.30.0.10
    ports:
      - "3307:3306"

  redis-us-east-1:
    image: redis:7-alpine
    container_name: redis-us-east-1
    networks:
      us-east-1:
        ipv4_address: 172.20.0.20
    ports:
      - "6380:6379"

  kafka-us-east-1:
    image: confluentinc/cp-kafka:7.5.0
    container_name: kafka-us-east-1
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zk-us-east-1:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka-us-east-1:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    networks:
      us-east-1:
        ipv4_address: 172.20.0.30
      wan:
        ipv4_address: 172.30.0.30

  app-us-east-1:
    build: .
    container_name: app-us-east-1
    environment:
      REGION: us-east-1
      DATABASE_PRIMARY_URL: mysql://root:root@mysql-us-east-1:3306/booking_system
      REDIS_URL: redis://redis-us-east-1:6379
      KAFKA_BROKERS: kafka-us-east-1:9092
    networks:
      us-east-1:
        ipv4_address: 172.20.0.40
    ports:
      - "3001:3000"

  # =================== EU-WEST-1 ===================
  mysql-eu-west-1:
    image: mysql:8.0
    container_name: mysql-eu-west-1
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: booking_system
    volumes:
      - ./config/mysql/eu-west-1.cnf:/etc/mysql/conf.d/region.cnf
      - mysql-eu-data:/var/lib/mysql
    networks:
      eu-west-1:
        ipv4_address: 172.21.0.10
      wan:
        ipv4_address: 172.30.0.11
    ports:
      - "3308:3306"

  redis-eu-west-1:
    image: redis:7-alpine
    container_name: redis-eu-west-1
    networks:
      eu-west-1:
        ipv4_address: 172.21.0.20
    ports:
      - "6381:6379"

  kafka-eu-west-1:
    image: confluentinc/cp-kafka:7.5.0
    container_name: kafka-eu-west-1
    environment:
      KAFKA_BROKER_ID: 2
      KAFKA_ZOOKEEPER_CONNECT: zk-eu-west-1:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka-eu-west-1:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    networks:
      eu-west-1:
        ipv4_address: 172.21.0.30
      wan:
        ipv4_address: 172.30.0.31

  app-eu-west-1:
    build: .
    container_name: app-eu-west-1
    environment:
      REGION: eu-west-1
      DATABASE_PRIMARY_URL: mysql://root:root@mysql-eu-west-1:3306/booking_system
      REDIS_URL: redis://redis-eu-west-1:6379
      KAFKA_BROKERS: kafka-eu-west-1:9092
    networks:
      eu-west-1:
        ipv4_address: 172.21.0.40
    ports:
      - "3002:3000"

  # =================== AP-NORTHEAST-1 ===================
  mysql-ap-northeast-1:
    image: mysql:8.0
    container_name: mysql-ap-northeast-1
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: booking_system
    volumes:
      - ./config/mysql/ap-northeast-1.cnf:/etc/mysql/conf.d/region.cnf
      - mysql-ap-data:/var/lib/mysql
    networks:
      ap-northeast-1:
        ipv4_address: 172.22.0.10
      wan:
        ipv4_address: 172.30.0.12
    ports:
      - "3309:3306"

  redis-ap-northeast-1:
    image: redis:7-alpine
    container_name: redis-ap-northeast-1
    networks:
      ap-northeast-1:
        ipv4_address: 172.22.0.20
    ports:
      - "6382:6379"

  kafka-ap-northeast-1:
    image: confluentinc/cp-kafka:7.5.0
    container_name: kafka-ap-northeast-1
    environment:
      KAFKA_BROKER_ID: 3
      KAFKA_ZOOKEEPER_CONNECT: zk-ap-northeast-1:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka-ap-northeast-1:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    networks:
      ap-northeast-1:
        ipv4_address: 172.22.0.30
      wan:
        ipv4_address: 172.30.0.32

  app-ap-northeast-1:
    build: .
    container_name: app-ap-northeast-1
    environment:
      REGION: ap-northeast-1
      DATABASE_PRIMARY_URL: mysql://root:root@mysql-ap-northeast-1:3306/booking_system
      REDIS_URL: redis://redis-ap-northeast-1:6379
      KAFKA_BROKERS: kafka-ap-northeast-1:9092
    networks:
      ap-northeast-1:
        ipv4_address: 172.22.0.40
    ports:
      - "3003:3000"

  # =================== NETWORK DELAY SIMULATOR ===================
  # Uses tc (traffic control) to add realistic latency on the WAN network
  network-shaper:
    image: alpine:3.19
    container_name: network-shaper
    cap_add:
      - NET_ADMIN
    networks:
      wan:
        ipv4_address: 172.30.0.100
    entrypoint: /bin/sh
    command: >
      -c "
        apk add iproute2 &&
        echo 'Adding 80ms delay to simulate US-EU latency...' &&
        tc qdisc add dev eth0 root netem delay 80ms 10ms &&
        echo 'Network shaping active. Sleeping...' &&
        sleep infinity
      "

volumes:
  mysql-us-data:
  mysql-eu-data:
  mysql-ap-data:
```

To test a conflict scenario locally:

```bash
# Terminal 1: Create a booking in "us-east-1"
curl -X POST http://localhost:3001/bookings \
  -H "Content-Type: application/json" \
  -d '{"roomId": "ROOM-42", "checkIn": "2026-03-15", "guestId": "GUEST-A"}'

# Terminal 2: Simultaneously create a conflicting booking in "eu-west-1"
curl -X POST http://localhost:3002/bookings \
  -H "Content-Type: application/json" \
  -d '{"roomId": "ROOM-42", "checkIn": "2026-03-15", "guestId": "GUEST-B"}'

# Check which one won:
curl http://localhost:3001/bookings?roomId=ROOM-42&date=2026-03-15
curl http://localhost:3002/bookings?roomId=ROOM-42&date=2026-03-15
# Both should return the same winner (higher fencing token)
```

> **Analogy:** This Docker Compose setup is like building a model train layout in your garage. The three train stations are your regions. The tracks between them have speed limiters (network delay) that simulate the real-world distance between data centers. You can test what happens when a bridge (network link) is out without waiting for an actual ocean cable to fail.

---

## Production War Stories

These are real incidents (with details changed to protect the companies involved) that illustrate what goes wrong in multi-region deployments. Read them carefully. Every one of them was preventable.

### War Story 1: The Failover That Made Things Worse

> **Production War Story:** A booking platform ran active-passive with `us-east-1` as primary and `eu-west-1` as standby. When `us-east-1` experienced degraded networking (not a full outage — just 30% packet loss), the monitoring system triggered an automatic failover to `eu-west-1`. The failover promoted the EU replica to primary. But the original US primary was not actually down. It kept accepting writes for 4 minutes until operators manually shut it down. During those 4 minutes, both regions believed they were primary. The US primary accepted 23,000 bookings that were never replicated to the new EU primary. When the US primary was finally shut down and brought back as a replica, those 23,000 bookings had to be manually reconciled. Twelve hundred of them conflicted with bookings made on the EU primary during the same window.
>
> **The lesson:** Never automate failover for partial outages. Full outages are unambiguous -- the region is dead. Partial outages (high latency, packet loss, intermittent errors) are the dangerous case because both the old and new primary can be "alive" simultaneously. This is called **split-brain**, and it is the most feared failure mode in distributed systems. The correct response to a partial outage is to alert a human, not to flip the switch automatically.

### War Story 2: The Data Sovereignty Violation Nobody Noticed

> **Production War Story:** A European travel company expanded to serve US customers and added a `us-east-1` region in 2023. They configured MySQL cross-region replication correctly, replicating all tables. Six months later, during a routine GDPR audit, they discovered that the `guest_profiles` table -- containing full names, email addresses, passport numbers, and home addresses of 1.2 million EU residents -- had been replicating to the US region since day one. The replication filter excluded `bookings_pii` but nobody added `guest_profiles` to the exclusion list because it was created after the initial replication setup. The company self-reported to the Irish Data Protection Commission. The investigation took 14 months. The fine was 1.8 million euros. The engineering fix took two days.
>
> **The lesson:** Data sovereignty is not a one-time configuration. It is an ongoing process. Every new table containing personal data must be added to the replication exclusion list. Automate this: add a CI check that scans migration files for new tables and verifies they are classified as either "globally replicated" or "region-local." If a table is not classified, the CI pipeline fails. Make the safe path the default path.

### War Story 3: The Split-Brain That Lasted 47 Minutes

> **Production War Story:** An active-active booking system lost the network link between its US and EU Kafka clusters during a maintenance window at the cloud provider. MirrorMaker 2 stopped replicating events between regions. Both regions continued accepting bookings independently. After 47 minutes, the link was restored and MM2 resumed replication. The conflict detection consumer processed the backlog of 47 minutes of cross-region events. It found 340 conflicts -- rooms that had been booked in both regions during the partition. The automated conflict resolution (higher fencing token wins) resolved 338 of them correctly. Two conflicts could not be resolved because both bookings had the same fencing token. This should not have been possible, but it happened because both regions' Redis clusters assigned the same fencing token values independently during the partition (they used the same counter seed and incremented independently).
>
> **The lesson:** Fencing tokens must be globally unique, not just regionally unique. The fix was to embed the region identifier in the fencing token: `token = (regionId << 48) | localCounter`. This guarantees that even if two regions generate millions of tokens independently, none will collide. An alternative is to use UUIDs or ULIDs, but for ordering purposes, a region-prefixed integer is simpler and faster.

---

## Common Mistakes and Anti-Patterns

This section collects the most frequent mistakes teams make when deploying multi-region systems. Each one has been observed in production.

### Mistake 1: Treating All Data as Equal

Not all data needs to be in every region. Replicate what you must (inventory, booking status), skip what you can (analytics, logs, user preferences for non-data-sovereignty reasons). Every byte you replicate cross-region costs bandwidth, increases lag, and creates more potential conflicts.

> **Common Mistake:** Replicating your entire 2TB database across four regions because "what if we need it?" Cross-region bandwidth is expensive and finite. A team was paying $14,000/month in cross-region data transfer for tables that no remote region ever queried. Audit your replication streams quarterly.

### Mistake 2: No Circuit Breaker on Cross-Region Calls

When the network between Tokyo and London is degraded, every cross-region call takes 30 seconds to time out. If your booking flow includes a synchronous cross-region call (even "just for logging"), that 30-second timeout blocks the entire request. Users see a spinner for 30 seconds and give up.

> **Common Mistake:** Adding a "quick" cross-region API call to validate a booking against the home region's inventory. During normal operation, it adds 150ms. During a partition, it adds 30 seconds (the TCP timeout). The fix: wrap every cross-region call in a circuit breaker that trips after 3 consecutive failures and returns a fallback response. The fallback for an inventory check is "optimistically accept the booking and validate later via async conflict resolution."

### Mistake 3: Testing Failover for the First Time During an Actual Outage

If the first time you execute your failover runbook is during a real outage at 3 AM, you will discover that step 7 references a script that no longer exists, step 12 requires permissions that nobody has, and step 15 takes 40 minutes instead of the estimated 2 minutes.

> **What If You Skip This?** Without regular failover drills (monthly at minimum), your failover procedure degrades silently. Infrastructure changes, personnel changes, and configuration drift all conspire to make your runbook fiction. Run a "game day" every month where you simulate a regional failure during business hours with the full on-call team.

### Mistake 4: Forgetting About Clock Skew

Even with NTP, clocks across regions can differ by 1-10ms. If your conflict resolution uses timestamps, two writes at "the same time" might pick a winner based on which region's clock is slightly ahead, not which write actually happened first.

> **Common Mistake:** Using `Date.now()` in JavaScript for conflict resolution timestamps. `Date.now()` depends on the system clock, which drifts. Use monotonic clocks for ordering within a single region and logical clocks (vector clocks, fencing tokens) for cross-region ordering. The system clock tells you what time it is. A logical clock tells you what happened before what.

### Mistake 5: Ignoring the "Recovery" Half of Failover

Teams spend weeks perfecting the failover procedure but zero time on the failback procedure. When the failed region comes back online, you need to: (1) re-sync its database from the current primary, (2) verify data integrity, (3) resume replication channels, (4) gradually shift traffic back, (5) monitor for anomalies. Failback is often harder than failover because you are dealing with a region that has stale data and missed transactions.

---

## Chapter 17 Extended Summary

| Topic | Key Takeaway |
|---|---|
| MySQL replication topology | Star topology with regional primaries, semi-sync for local replicas, async for cross-region. GTID is mandatory for failover. |
| Binlog configuration | ROW format with FULL row images. Required for deterministic replication and CDC compatibility. |
| Replication lag monitoring | Monitor every 5 seconds. Local lag > 1s is a warning. Cross-region lag > 30s is critical. |
| Read/write splitting | Writes go to regional primary. Reads go to local replica. Reads-after-writes go to primary for consistency. |
| Data sovereignty | Split personal data into separate tables. Exclude those tables from cross-region replication. Automate compliance checks in CI. |
| DNS-based routing | Route 53 latency-based routing with health checks. Set TTL to 60 seconds for fast failover. |
| Failover orchestration | Ordered steps: DNS removal, replication pause, resource reassignment, load notification. Test monthly. |
| Cross-region Kafka | MirrorMaker 2 mirrors global topics between regional clusters. Use zstd compression for bandwidth efficiency. |
| Redis strategy | Region-local clusters for locks and pub/sub. Cache invalidation via Kafka (not Redis pub/sub, which does not survive partitions). |
| Latency budgets | Local booking: ~41ms. Forwarded booking: ~250-350ms. With consensus wait: ~2,041ms. Track and alert on budget violations. |
| Local testing | Docker Compose with separate networks per region and tc netem for simulated latency. |
| Split-brain prevention | Never auto-failover on partial outages. Embed region ID in fencing tokens for global uniqueness. |
| Failover drills | Monthly game days. Test with production-like data volumes. Update runbooks after every drill. |

> **Checkpoint:** Before moving on, answer these questions without scrolling back. (1) Why do we use semi-sync replication for the local replica but async for cross-region replicas? (2) What is the difference between `getReader()` and `getConsistentReader()` in the database layer? (3) Why do we split personal data into a separate table instead of filtering columns in the replication stream? (4) What is split-brain and why is automatic failover dangerous during partial outages? (5) Why must fencing tokens include a region identifier? If you can answer all five, you understand the operational reality of multi-region deployment. If question 4 gave you trouble, re-read War Story 1 — split-brain is the single most dangerous failure mode in distributed systems, and understanding it is non-negotiable.

---
