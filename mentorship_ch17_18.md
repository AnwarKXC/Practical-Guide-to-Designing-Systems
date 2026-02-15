# Chapter 17: Multi-Region Conflict Resolution — When Tokyo and London Disagree

## Why Your Server's Location Matters

Up to this point, every system we have built lives in one place. One data center, one set of servers, one region. And for many applications, that is perfectly fine. But think about our booking platform. We have users in Tokyo, London, Sao Paulo, and New York. If all our servers sit in Virginia, here is what happens:

- A user in Tokyo clicks "Book Now." Their request travels across the Pacific Ocean to Virginia, gets processed, and the response travels back. Round trip: **180-250 milliseconds** just for the network, before the server does any work.
- A user in Virginia clicks "Book Now." Round trip: **5-10 milliseconds**.

That 200-millisecond gap might not sound like much, but it compounds. A booking flow involves multiple service-to-service calls — check inventory, process payment, confirm reservation. Each one pays the latency tax. Your Tokyo user waits 2-3 seconds for something that takes 400 milliseconds in Virginia. They notice. They leave. You lose the booking.

The fix seems obvious: run the system in multiple regions. Put servers in Tokyo for Asian users, London for European users, Virginia for North American users, and Sao Paulo for South American users. Each region handles its own traffic locally. Latency drops. Users are happy.

But here is the problem nobody warns you about: the moment you run the same system in multiple regions, those regions can **disagree** about what just happened.

> **Analogy:** Imagine a company with two offices — one in Tokyo and one in London. Both offices have a shared conference room booking calendar, but the calendar is a physical whiteboard in each office. Each office's receptionist can accept reservations independently. At 9:00 AM UTC, a person in Tokyo asks their receptionist to book Conference Room A for Wednesday at 2 PM. At the exact same moment, a person in London asks their receptionist the same thing. Both receptionists check their local whiteboard, see that Room A is open, and write in the booking. Both confirm success. Now you have two groups expecting the same room at the same time. That is the multi-region conflict problem.

This chapter teaches you how to detect and resolve these conflicts so that two regions never permanently disagree.

---

## What You Already Know (And Where It Breaks)

In your CRUD experience, you have probably solved race conditions with a database lock. Two users try to book the same room? Use `SELECT ... FOR UPDATE`:

```typescript
// Your existing mental model: single-database locking
await db.query('BEGIN');

const room = await db.query(
  `SELECT * FROM rooms WHERE id = $1 FOR UPDATE`, // lock the row
  [roomId]
);

if (room.rows[0].available) {
  await db.query(
    `UPDATE rooms SET available = false WHERE id = $1`,
    [roomId]
  );
  await db.query(
    `INSERT INTO bookings (room_id, user_id) VALUES ($1, $2)`,
    [roomId, userId]
  );
}

await db.query('COMMIT'); // lock released, other transactions can proceed
```

This works because both users are talking to the **same database**. The database serializes the transactions — one goes first, the other goes second. It is a traffic light at an intersection. Only one car moves at a time.

But in a multi-region setup, Tokyo has its own database and London has its own database. There is no single traffic light. Both intersections have their own lights, and both turn green at the same time. That is how collisions happen.

> **Key Term:** **Multi-region deployment** — Running copies of your application (and often its data) in geographically separate data centers (regions). Each region serves local users with low latency but must coordinate with other regions to maintain data consistency.

---

## The CAP Theorem: You Cannot Have Everything

Before we design a solution, you need to understand a fundamental law of distributed systems. It is called the **CAP theorem**, and it says that any distributed data store can guarantee only two of the following three properties simultaneously:

| Property | What It Means |
|---|---|
| **Consistency** | Every read receives the most recent write. All regions see exactly the same data at the same time. |
| **Availability** | Every request receives a response (not an error), even if some nodes are down. |
| **Partition Tolerance** | The system continues operating even when network communication between regions is interrupted. |

Here is the crux: network partitions are not optional. The internet between Tokyo and London **will** have outages. Cables get cut. Routers fail. So you must pick partition tolerance. That leaves you choosing between consistency and availability.

> **Analogy:** Think of it like a married couple who live in different cities. They share a joint bank account. Option 1 (Consistency): Before either person spends money, they call each other and agree. This guarantees they never overdraw, but if the phone line is down, neither can spend anything — they are blocked. Option 2 (Availability): Both can spend freely without calling. They are never blocked, but they might both spend the last $100 at the same time and overdraw the account. The phone line going down is the "partition." You must pick: always agree (but sometimes be stuck) or always be available (but sometimes disagree).

Our booking system chooses **AP — Availability and Partition tolerance**. Here is why:

- We want every region to keep accepting bookings even if the network between regions goes down. A network outage between Tokyo and London should not freeze bookings in Tokyo. Users should never see "Service Unavailable" just because an undersea cable has a bad day.
- We accept that, for a tiny window of **2-3 seconds**, two regions might both think they booked the last room. We will detect and fix that conflict automatically.
- The alternative — strict consistency — would require every region to check with every other region before confirming any booking. That adds hundreds of milliseconds to every single booking and makes the system unavailable during partitions. We tried it; the latency was unacceptable.

> **Key Term:** **AP system (Availability + Partition tolerance)** — A distributed system that prioritizes always being able to respond to requests, even during network partitions, at the cost of temporary inconsistencies between nodes. Conflicts are detected and resolved after the fact.

> **What If You Skip This?** If you do not make a deliberate CAP choice, you end up with an accidental one — usually the worst kind. Your system will sometimes be inconsistent AND unavailable, because you did not design for either tradeoff. Every multi-region system must make this choice explicitly.

---

## The Solution: Reserve Locally, Verify Globally

Our conflict resolution strategy has four steps:

1. **Reserve locally** — The region accepts the booking and writes it to its local database immediately. The user gets a fast response.
2. **Broadcast globally** — The region publishes a "reservation made" event to a global Kafka topic that all regions consume.
3. **Detect conflicts** — Every region watches the global event stream. If it sees a reservation from another region for the same resource, it compares fencing tokens to decide who wins.
4. **Resolve deterministically** — The reservation with the higher fencing token wins. The loser rolls back. No human intervention. No randomness. Every region reaches the same conclusion.

Let us walk through each step with the actual code.

### Step 1: Reserve Locally with a Fencing Token

```typescript
export class MultiRegionInventoryService {
  // Each instance knows which region it runs in (e.g., 'us-east-1', 'eu-west-1')
  private readonly region = process.env.REGION;

  async reserveInventory(params: ReservationParams): Promise<ReservationResult> {

    // Build a lock key that uniquely identifies THIS specific resource
    // on THIS specific date. Example: "lock:hotel:TOKYO-042:2026-03-15"
    const lockKey = this.getInventoryLockKey(
      params.resourceType, params.resourceId, params.resourceDate
    );

    // Acquire a distributed lock in Redis.
    // The fencing token is a monotonically increasing number.
    // Each lock acquisition gets a HIGHER token than the last.
    const lockResult = await this.fencedLockService.acquireLockWithFencing(
      lockKey, 10000 // lock expires after 10 seconds
    );

    if (!lockResult) {
      // Another process in THIS region already holds the lock.
      // This is the same-region race condition you already know how to handle.
      throw new ConflictError('Resource is locked');
    }

    const { lock, fencingToken } = lockResult;

    try {
      // Write the reservation to our LOCAL database.
      // The fencing token is stored alongside it — think of it as a receipt number.
      const localReservation = await this.reserveLocally(params, fencingToken);

      if (!localReservation.success) {
        return localReservation; // room not available locally
      }

      // Publish a global event so other regions know about this reservation.
      // (We use the outbox pattern from Chapter 18 — not a direct Kafka call.)
      await this.writeOutboxEvent('inventory_reservation',
        localReservation.reservationId, 'inventory.reserved', {
          reservationId: localReservation.reservationId,
          region: this.region,
          fencingToken,
          ...params,
          timestamp: Date.now()
        }
      );

      // Now we wait. For up to 2 seconds, we listen for conflict signals
      // from other regions. If nobody objects, we are good.
      const consensus = await this.waitForGlobalConsensus(
        localReservation.reservationId, 2000 // 2-second window
      );

      if (!consensus.success) {
        // Another region made a conflicting reservation and won.
        // Roll back our local reservation.
        await this.rollbackReservation(localReservation.reservationId);

        return {
          success: false,
          reason: consensus.reason,
          conflictingRegion: consensus.conflictingRegion
        };
      }

      // No conflicts detected. Our reservation stands.
      return localReservation;

    } finally {
      // Always release the lock, whether we succeeded or failed.
      await this.fencedLockService.releaseLock(lockKey, lock, fencingToken);
    }
  }
}
```

Let us break down what this code does in plain language:

1. **Lock locally.** We grab a Redis distributed lock on the specific resource (e.g., "Hotel Tokyo-042, March 15"). This prevents two processes in the *same* region from creating duplicate reservations. You have done this kind of thing with `SELECT ... FOR UPDATE` — this is the distributed equivalent.

2. **Reserve locally.** We write the reservation to our region's database. At this point, the user's booking exists in our local data but no other region knows about it yet.

3. **Broadcast.** We write an outbox event (more on this pattern in Chapter 18) announcing our reservation to the global Kafka topic. Every region receives this message.

4. **Wait for consensus.** We pause for up to 2 seconds, listening on a Redis pub/sub channel for conflict notifications. If another region reserved the same resource, its conflict detection consumer will notify us.

5. **React.** If a conflict is detected, we roll back. If no conflict arrives and verification passes, we confirm the booking.

> **Key Term:** **Fencing token** — A monotonically increasing number issued each time a distributed lock is acquired. It acts as a tiebreaker: when two regions create conflicting reservations, the one with the higher fencing token wins. Because the tokens always increase, the outcome is deterministic — every region will agree on who won, even if they process events in a different order.

---

## The Critical Mistake: Treating Silence as Agreement

This is the most important lesson in this chapter. Read it twice.

Here is the consensus-waiting function:

```typescript
private async waitForGlobalConsensus(
  reservationId: bigint,
  timeoutMs: number
): Promise<{
  success: boolean;
  reason?: string;
  conflictingRegion?: string;
}> {

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      subscriber.quit();

      // CRITICAL: Timeout is AMBIGUOUS — not a success signal.
      // A network partition could be hiding a conflict.
      // We must actively verify before confirming.
      this.verifyNoConflictExists(reservationId).then((verified) => {
        if (verified) {
          resolve({ success: true }); // Verified: our token is still latest
        } else {
          resolve({
            success: false,
            reason: 'timeout_ambiguous'
          });
        }
      }).catch(() => {
        // If we can't even verify, we must assume the worst.
        resolve({
          success: false,
          reason: 'verification_failed'
        });
      });
    }, timeoutMs);

    // Listen for conflict signals on a Redis pub/sub channel
    // specific to this reservation
    const subscriber = redis.duplicate();

    subscriber.subscribe(`conflicts:${reservationId}`, (err) => {
      if (err) {
        clearTimeout(timeout);
        subscriber.quit();
        resolve({ success: false, reason: 'subscription_error' });
      }
    });

    // If another region's conflict detector finds us, it publishes here
    subscriber.on('message', (channel, message) => {
      clearTimeout(timeout);
      subscriber.quit();

      const conflict = JSON.parse(message);
      resolve({
        success: false,
        reason: 'conflict_detected',
        conflictingRegion: conflict.region
      });
    });
  });
}
```

Here is the trap. An earlier version of this code looked like this:

```typescript
// DANGEROUS — DO NOT DO THIS
const timeout = setTimeout(() => {
  subscriber.quit();
  resolve({ success: true }); // "Nobody complained, so we're good!"
}, timeoutMs);
```

The developer who wrote it reasoned: "If no conflict arrives within 2 seconds, no other region reserved this resource. We are safe." That reasoning is **wrong**, and it caused double-bookings in production.

Here is why. Imagine this scenario:

```
Time 0.0s  Tokyo reserves Hotel Room 42 for March 15
Time 0.0s  London reserves Hotel Room 42 for March 15

Time 0.1s  Tokyo publishes 'inventory.reserved' to global Kafka topic
Time 0.1s  London publishes 'inventory.reserved' to global Kafka topic

Time 0.5s  === NETWORK PARTITION BEGINS ===
           Tokyo and London can no longer receive each other's Kafka messages

Time 2.0s  Tokyo's consensus timer expires. No conflict arrived.
           Old code: resolve({ success: true })  <-- WRONG!
           Tokyo confirms the booking.

Time 2.0s  London's consensus timer expires. No conflict arrived.
           Old code: resolve({ success: true })  <-- WRONG!
           London confirms the booking.

Time 5.0s  === NETWORK PARTITION ENDS ===
           Both regions realize the other also confirmed.
           DOUBLE BOOKING. Two guests show up for the same room.
```

The silence was not agreement. The silence was a broken phone line.

> **Analogy:** You send a text message to your roommate: "I'm going to eat the last slice of pizza unless you object in 2 minutes." Two minutes pass. No response. You eat the pizza. But your roommate's phone was dead. They also thought the pizza was theirs. You both "had" the last slice — except there was only one. Silence is not consent when the communication channel might be broken.

The fix is the `verifyNoConflictExists` method:

```typescript
private async verifyNoConflictExists(reservationId: bigint): Promise<boolean> {
  // Look up our reservation in the database
  const [reservation] = await db.execute(`
    SELECT resource_type, resource_id, resource_date, fencing_token
    FROM inventory_reservations WHERE id = ?
  `, [reservationId]);

  if (reservation.length === 0) return false; // our reservation vanished

  const res = reservation[0];

  // Check if the inventory record's fencing token still matches ours
  const [inventory] = await db.execute(`
    SELECT fencing_token FROM inventory
    WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
  `, [res.resource_type, res.resource_id, res.resource_date]);

  // If our fencing token is still the latest in the inventory table,
  // no other region has updated this resource. We are safe.
  return inventory[0]?.fencing_token === res.fencing_token;
}
```

This method does not rely on hearing from other regions. It checks the **database directly**: "Is our fencing token still the latest one?" If another region snuck in a reservation with a higher token, the database will reflect that, even if the Kafka notification never arrived. The database is the source of truth, not the event stream.

> **What If You Skip This?** If you treat timeout as success, you will see double-bookings during every network partition between regions. Partitions happen more often than you think — cloud providers report them multiple times per year. Each double-booking means two customers show up for the same room, one gets turned away, you issue a refund, and your platform's reputation takes a hit. The verification step costs one extra database query. The alternative costs customer trust.

---

## Conflict Detection: How Regions Police Each Other

So far we have seen how one region reserves and waits for consensus. Now let us look at the other side: the Kafka consumer that runs in every region, watching for reservations from other regions and flagging conflicts.

```typescript
export class ConflictDetectionConsumer {
  private readonly region = process.env.REGION;

  async start(): Promise<void> {
    // Subscribe to the global topic where all regions publish reservations
    await kafka.subscribe({
      topic: 'inventory-reservations-global',
      fromBeginning: false // we only care about new events, not history
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        const sourceRegion = message.headers['source-region'].toString();

        // Ignore events from our own region.
        // We already handle local conflicts with the Redis lock.
        if (sourceRegion === this.region) return;

        // Check: did WE also make a reservation for this same resource?
        const localReservation = await this.findLocalReservation(
          event.resourceType, event.resourceId, event.resourceDate
        );

        if (!localReservation) return; // No overlap. Nothing to do.

        // CONFLICT DETECTED.
        // Two regions reserved the same resource. Who wins?
        // Answer: the one with the HIGHER fencing token.
        if (event.fencingToken > localReservation.fencingToken) {
          // The remote region's token is higher. They win. We lose.
          // Roll back our local reservation.
          await this.rollbackReservation(localReservation.id);

          // Tell our local waitForGlobalConsensus() that we lost.
          // It is listening on this Redis pub/sub channel.
          await redis.publish(
            `conflicts:${localReservation.id}`,
            JSON.stringify({
              region: sourceRegion,
              reservationId: event.reservationId,
              fencingToken: event.fencingToken
            })
          );
        } else {
          // Our token is higher. We win. Tell the remote region to roll back.
          await kafka.send({
            topic: 'inventory-conflicts',
            messages: [{
              value: JSON.stringify({
                winningRegion: this.region,
                winningReservationId: localReservation.id,
                losingRegion: sourceRegion,
                losingReservationId: event.reservationId
              })
            }]
          });
        }
      }
    });
  }
}
```

Let us trace through a concrete conflict:

```
1. Tokyo reserves Room 42 with fencing token 1001.
2. London reserves Room 42 with fencing token 1003.
3. Both publish to 'inventory-reservations-global'.

4. Tokyo's ConflictDetectionConsumer receives London's event.
   - event.fencingToken (1003) > localReservation.fencingToken (1001)
   - London wins. Tokyo rolls back its reservation.
   - Tokyo publishes to Redis: "conflicts:tokyo-reservation-id"
   - Tokyo's waitForGlobalConsensus() receives the conflict signal and
     tells the user: "Sorry, that room was just booked by someone else."

5. London's ConflictDetectionConsumer receives Tokyo's event.
   - event.fencingToken (1001) < localReservation.fencingToken (1003)
   - London wins. It publishes to 'inventory-conflicts' telling Tokyo
     to roll back (belt-and-suspenders — Tokyo already rolled back in step 4).
   - London's waitForGlobalConsensus() never receives a conflict signal.
   - London confirms the booking.
```

The resolution is **deterministic**. No matter what order the events arrive, no matter which region processes them first, the higher fencing token always wins. Both regions will always reach the same conclusion independently. That is the key insight: deterministic conflict resolution means you do not need regions to coordinate in real time. They just need to eventually see the same events and apply the same rule.

> **Key Term:** **Deterministic conflict resolution** — A strategy where conflicting operations are resolved using a fixed rule (e.g., highest token wins) that every node can apply independently, guaranteeing all nodes converge to the same state without real-time coordination.

---

## Reducing Conflicts Before They Happen: Regional Partitioning

Conflict resolution works, but it has a cost: the losing user gets told "sorry, that room was just booked" after they thought they had it. The best conflict is one that never happens. We reduce conflicts by giving each resource a "home region":

```typescript
export const inventoryPartitioningStrategy = {

  // Deterministically assign each resource to a home region
  // based on its ID. This is a simple modulo operation.
  getResourceHomeRegion(resourceId: bigint): string {
    const regionIndex = Number(resourceId % 4n);
    const regions = ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'sa-east-1'];
    return regions[regionIndex];
  },

  async reserveWithRegionalRouting(params: {
    resourceId: bigint;
    userRegion: string;
  }): Promise<ReservationResult> {

    const homeRegion = this.getResourceHomeRegion(params.resourceId);

    if (params.userRegion === homeRegion) {
      // The user is in the resource's home region.
      // Handle it locally — fastest path, no cross-region conflict possible
      // for this specific resource.
      return await inventoryService.reserveInventory(params);
    } else {
      // The user is in a different region than the resource's home.
      // Forward the request to the home region.
      // This adds latency (~100-200ms) but eliminates the conflict window.
      return await this.forwardToHomeRegion(homeRegion, params);
    }
  }
};
```

Here is the logic in plain English:

- Each resource ID maps to one of four regions using modulo arithmetic. Resource 100 maps to region 0 (us-east-1). Resource 101 maps to region 1 (eu-west-1). And so on.
- When a user wants to book a resource, we first check: is the user in that resource's home region?
- **If yes:** Handle the booking locally. No cross-region conflict is possible because all bookings for this resource funnel through one region.
- **If no:** Forward the request to the home region. The user pays a small latency penalty (one cross-region hop), but we eliminate the conflict window entirely.

> **Analogy:** Think of it like a company where each conference room has one designated admin. If you want to book Room A, you must go through Room A's admin, even if you sit in a different office. This adds a step, but it guarantees two people never double-book Room A because only one person controls the calendar.

This does not eliminate multi-region conflicts entirely — during a network partition, the forwarding might fail, and the user's local region might fall back to reserving locally. But under normal conditions, it dramatically reduces the conflict rate.

---

## The Full Conflict Resolution Flow

Let us put it all together with a complete timeline:

```
Normal Operation (no partition):
  1. User in Tokyo books Room 42 (home region: eu-west-1)
  2. Tokyo forwards request to London (eu-west-1)
  3. London processes the booking locally — no conflict possible
  4. London returns confirmation to Tokyo
  5. Tokyo returns confirmation to user
  Total latency: ~300ms (mostly cross-region network)

During Network Partition:
  1. User in Tokyo books Room 42 — London unreachable
  2. Tokyo falls back to local reservation with fencing token 1001
  3. Meanwhile, User in London also books Room 42, token 1003
  4. Both publish to global Kafka (events queue during partition)
  5. Partition heals. Events flow.
  6. Conflict detected: London (1003) > Tokyo (1001). London wins.
  7. Tokyo rolls back, notifies user: "Sorry, room was taken"
  8. London confirms booking
  Total time to resolution: partition duration + ~2 seconds
```

---

## Chapter 17 Summary

| Concept | One-Sentence Summary |
|---|---|
| Multi-region deployment | Running the same system in multiple data centers to reduce latency for geographically distributed users. |
| CAP theorem | You can guarantee only two of three properties: Consistency, Availability, Partition tolerance. Pick two. |
| AP system | Our system chooses availability and partition tolerance, accepting brief inconsistency windows. |
| Fencing tokens | Monotonically increasing numbers that act as deterministic tiebreakers for conflicting operations. |
| Local reservation + global broadcast | Write fast to the local database, then announce to all regions via Kafka. |
| Conflict detection consumer | A Kafka consumer in each region that watches for overlapping reservations from other regions. |
| Deterministic resolution | Higher fencing token always wins, so every region independently reaches the same conclusion. |
| Timeout is not success | During a network partition, silence means the conflict notification might not have arrived — verify against the database. |
| Regional partitioning | Assign each resource a "home region" to route most reservations through one region and avoid conflicts. |

> **Checkpoint:** Answer these without scrolling back. (1) Why does our system choose AP over CP? (2) What happens when the consensus timer expires — is it a success? Why or why not? (3) If Tokyo gets fencing token 500 and London gets fencing token 502 for the same room, who wins? (4) What is the purpose of `verifyNoConflictExists`? If you can answer all four, you understand multi-region conflict resolution. If not, re-read the "Treating Silence as Agreement" section — it is the most important part of this chapter.

---

---

# Chapter 18: Outbox Pattern — Reliable Event Publishing

## The Code That Looks Correct But Is Not

If you have been following along, you have written code like this many times by now. A user creates a booking, you save it to the database, and then you publish an event so other services know about it:

```typescript
// This is what most developers write first. It looks fine.
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  // Step 1: Save the booking to the database
  const booking = await db.query(
    `INSERT INTO bookings (user_id, room_id, check_in, check_out, status)
     VALUES ($1, $2, $3, $4, 'CONFIRMED') RETURNING *`,
    [dto.userId, dto.roomId, dto.checkIn, dto.checkOut]
  );

  // Step 2: Tell the world about it
  await kafkaProducer.send({
    topic: 'booking.created',
    messages: [{
      key: booking.rows[0].id,
      value: JSON.stringify(booking.rows[0])
    }]
  });

  return booking.rows[0];
}
```

You write to the database, then you publish to Kafka. Two steps. Both succeed most of the time. So what is the problem?

The problem is the word "then." Those two operations are independent. They are not wrapped in a single transaction. And independent operations can fail independently. There are three possible outcomes, and two of them are bad:

```
Scenario 1: Both succeed (the happy path)
  1. INSERT INTO bookings → SUCCESS
  2. kafkaProducer.send() → SUCCESS
  ✅ Database has the booking. Kafka has the event. Everything is consistent.

Scenario 2: Database succeeds, Kafka fails
  1. INSERT INTO bookings → SUCCESS
  2. kafkaProducer.send() → FAILURE (Kafka is down, network timeout, etc.)
  ❌ Database has the booking. Kafka does NOT have the event.
     The Notification Service never sends a confirmation email.
     The Search Service never updates availability.
     The booking exists, but the system doesn't know about it.

Scenario 3: Database fails, Kafka never runs
  1. INSERT INTO bookings → FAILURE (constraint violation, DB down, etc.)
  2. kafkaProducer.send() → never executes
  ✅ Actually fine. Nothing happened. The user gets an error. Retry.
```

Scenario 2 is the dangerous one. Let us zoom in on what it looks like in practice:

```
Timeline of Failure:

09:00:00.000  User clicks "Book Now"
09:00:00.050  Database INSERT succeeds — booking BK-99001 is saved
09:00:00.051  Application tries to publish to Kafka...
09:00:00.051  Kafka broker is unreachable (network blip, broker restarting)
09:00:03.051  kafkaProducer.send() throws TimeoutError after 3 seconds
09:00:03.052  Application catches the error and... what? The booking is
             already committed to the database. You cannot un-commit it.

Result:
  - bookings table: BK-99001 exists, status = CONFIRMED
  - Kafka: no 'booking.created' event
  - Notification Service: sends nothing (it never heard about BK-99001)
  - Search Service: still shows the room as available
  - User: stares at a loading spinner, refreshes, sees the booking but
    never gets a confirmation email
  - Next user: books the same room (Search thinks it's available)
    → DOUBLE BOOKING
```

> **Analogy:** Imagine you write a check and hand it to a courier to deliver to your landlord. You record the payment in your checkbook (database write). The courier loses the check on the way (Kafka publish fails). Your checkbook says you paid rent, but your landlord never got the money. Your records and your landlord's records are now out of sync, and nobody realizes it until you get an eviction notice.

This is called the **dual-write problem**: writing to two different systems (database and Kafka) without a mechanism to guarantee both writes succeed or both fail.

> **Key Term:** **Dual-write problem** — The failure mode that occurs when an application writes to two independent systems (e.g., a database and a message broker) in sequence without a transaction spanning both. If the first write succeeds and the second fails, the systems become permanently inconsistent.

> **What If You Skip This?** Every event-driven system without the outbox pattern has a ticking time bomb. It works fine 99.9% of the time. But that 0.1% means you lose events during Kafka restarts, network blips, and application crashes. Lost events mean lost emails, stale search indexes, missed payments, and phantom bookings. Over time, your services silently drift out of sync, and nobody notices until a customer complains.

---

## The Outbox Pattern: One Transaction, One Source of Truth

The fix is elegant: instead of writing to the database AND then to Kafka, write the event **to the database** in the same transaction as your business data. Then have a separate background process read those events from the database and publish them to Kafka.

Here is the concept, side by side:

```
WITHOUT Outbox (dangerous — the approach you know):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)        -- business data
  3. COMMIT                            -- database commit succeeds
  4. kafkaProducer.send('booking.created')  -- App crashes HERE = event LOST

WITH Outbox (safe — the pattern you will learn):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)        -- business data
  3. INSERT INTO outbox_events (...)   -- event, SAME transaction
  4. COMMIT                            -- both succeed or BOTH fail
  5. [Background process reads outbox_events and publishes to Kafka]
  6. [Background process marks event as 'published']
```

The key insight: in Step 4, the database guarantees atomicity. Either BOTH the booking AND the outbox event are saved, or NEITHER is saved. There is no window where one exists without the other. The event cannot be lost because it is stored in the same database, in the same transaction, as the business data.

The background process (Step 5) can retry as many times as needed. If Kafka is down, the events just sit in the outbox table until Kafka comes back. They are safe in the database. Nothing is lost.

> **Analogy:** Instead of handing the check directly to a courier (who might lose it), you put the check in your office's outgoing mail tray (the outbox table). The mail room (the outbox publisher) picks up checks from the tray and delivers them. If the mail room is closed today, the check sits safely in the tray until tomorrow. It will not be lost. The tray is inside your office, right next to your checkbook — both are in the same place (the database), under the same lock and key (the transaction).

> **Key Term:** **Outbox pattern** — A reliability pattern where application events are written to an "outbox" database table within the same transaction as business data, then asynchronously published to a message broker by a separate process. This eliminates the dual-write problem by reducing two writes (database + broker) to one atomic database write.

---

## The Outbox Table

Before we look at the publisher, let us understand what the outbox table looks like:

```sql
CREATE TABLE outbox_events (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  aggregate_type VARCHAR(100) NOT NULL,   -- e.g., 'booking', 'payment'
  aggregate_id  VARCHAR(100) NOT NULL,    -- e.g., 'BK-99001'
  event_type    VARCHAR(100) NOT NULL,    -- e.g., 'booking.created'
  topic         VARCHAR(255) NOT NULL,    -- Kafka topic to publish to
  partition_key VARCHAR(255) NOT NULL,    -- Kafka partition key
  payload       JSON NOT NULL,            -- the event data
  status        ENUM('pending', 'published', 'failed') DEFAULT 'pending',
  retry_count   INT DEFAULT 0,
  max_retries   INT DEFAULT 5,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  published_at  TIMESTAMP NULL,
  last_retry_at TIMESTAMP NULL
);
```

Each row is an event waiting to be published. The columns tell the publisher everything it needs to know: which Kafka topic to send it to, what partition key to use, what the payload is, and whether it has already been published.

Here is how your booking code changes to use the outbox:

```typescript
// BEFORE (dangerous dual-write):
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  const booking = await db.query(`INSERT INTO bookings ...`);
  await kafkaProducer.send({ topic: 'booking.created', ... }); // can fail!
  return booking;
}

// AFTER (safe outbox pattern):
async createBooking(dto: CreateBookingDto): Promise<Booking> {
  // Single transaction — both writes succeed or both fail
  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // Write the business data
    const [booking] = await connection.execute(
      `INSERT INTO bookings (user_id, room_id, check_in, check_out, status)
       VALUES (?, ?, ?, ?, 'CONFIRMED')`,
      [dto.userId, dto.roomId, dto.checkIn, dto.checkOut]
    );

    // Write the event to the outbox — same transaction!
    await connection.execute(
      `INSERT INTO outbox_events
         (aggregate_type, aggregate_id, event_type, topic, partition_key, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'booking',
        booking.insertId,
        'booking.created',
        'booking.created',        // Kafka topic
        String(booking.insertId), // partition key
        JSON.stringify({
          bookingId: booking.insertId,
          userId: dto.userId,
          roomId: dto.roomId,
          checkIn: dto.checkIn,
          checkOut: dto.checkOut,
          status: 'CONFIRMED'
        })
      ]
    );

    await connection.commit();
    return { id: booking.insertId, ...dto, status: 'CONFIRMED' };

  } catch (error) {
    await connection.rollback(); // both the booking AND the event are rolled back
    throw error;
  } finally {
    connection.release();
  }
}
```

Notice what changed:

1. **No `kafkaProducer.send()` call.** Your application code never talks to Kafka directly.
2. **One transaction wraps everything.** The booking INSERT and the outbox INSERT are in the same `BEGIN/COMMIT` block.
3. **If the transaction fails,** neither the booking nor the event is saved. Clean failure. The user retries.
4. **If the transaction succeeds,** the event is safely parked in the outbox table, waiting for the publisher to pick it up.

---

## The Outbox Publisher: Polling for Events

The outbox publisher is a separate background process (often a separate microservice or a long-running worker thread) that continuously checks the outbox table for new events and publishes them to Kafka. Here is the full implementation, explained line by line:

```typescript
export class OutboxPublisherService {
  // How often to check for new events when the outbox is empty
  private readonly pollIntervalMs = 100; // 100 milliseconds

  // How many events to process in one batch
  private readonly batchSize = 100;

  // Flag to control the polling loop
  private running = false;

  async start(): Promise<void> {
    this.running = true;

    // This is the main polling loop. It runs forever until stop() is called.
    while (this.running) {
      const published = await this.publishBatch();

      if (published === 0) {
        // No events were found. Wait 100ms before checking again.
        // This prevents the loop from hammering the database with
        // empty queries when there's nothing to do.
        await this.sleep(this.pollIntervalMs);
      }
      // If we DID publish events, loop immediately — there might be more.
      // This gives us high throughput when events are flowing.
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async publishBatch(): Promise<number> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // SELECT ... FOR UPDATE SKIP LOCKED is the magic here.
      //
      // FOR UPDATE: Lock the rows we select so no other publisher
      //   instance grabs the same events (prevents duplicate publishing).
      //
      // SKIP LOCKED: If another publisher instance already locked some rows,
      //   skip those and grab different ones. This lets multiple publisher
      //   instances run in parallel without blocking each other.
      //
      // ORDER BY id ASC: Process events in the order they were created.
      //   This preserves event ordering within the same aggregate.
      const [events] = await connection.execute(`
        SELECT id, aggregate_type, aggregate_id, event_type,
               payload, topic, partition_key
        FROM outbox_events
        WHERE status = 'pending'
        ORDER BY id ASC
        LIMIT ?
        FOR UPDATE SKIP LOCKED
      `, [this.batchSize]);

      if (events.length === 0) {
        await connection.rollback(); // nothing to do, release the transaction
        return 0;
      }

      // Group events by Kafka topic.
      // A single batch might contain events for 'booking.created',
      // 'payment.processed', and 'inventory.updated' — we send each
      // group to its respective topic.
      const messagesByTopic = new Map<string, any[]>();

      for (const event of events) {
        if (!messagesByTopic.has(event.topic)) {
          messagesByTopic.set(event.topic, []);
        }
        messagesByTopic.get(event.topic).push({
          key: event.partition_key,   // ensures ordering per aggregate
          value: JSON.stringify({
            eventId: event.id,        // from the outbox table
            eventType: event.event_type,
            aggregateType: event.aggregate_type,
            aggregateId: event.aggregate_id,
            payload: JSON.parse(event.payload),
            timestamp: new Date().toISOString()
          }),
          headers: {
            'event-type': event.event_type,
            'aggregate-type': event.aggregate_type
          }
        });
      }

      // Publish each group of messages to its Kafka topic
      for (const [topic, messages] of messagesByTopic) {
        await kafka.send({ topic, messages });
      }

      // Mark all published events as 'published' with a timestamp.
      // This happens inside the same transaction as the FOR UPDATE lock,
      // so the rows are released and won't be picked up again.
      const eventIds = events.map(e => e.id);
      await connection.execute(`
        UPDATE outbox_events
        SET status = 'published', published_at = NOW()
        WHERE id IN (${eventIds.map(() => '?').join(',')})
      `, eventIds);

      await connection.commit();
      return events.length;

    } catch (error) {
      // If ANYTHING fails — Kafka send, database update, anything —
      // we roll back. The events remain 'pending' and will be picked
      // up on the next poll iteration.
      await connection.rollback();
      console.error('Outbox publish failed:', error);
      return 0;

    } finally {
      connection.release();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

Let us walk through the lifecycle of a single event:

```
1. Your createBooking() method saves a booking and an outbox event
   in one transaction. Status: 'pending'.

2. The OutboxPublisherService polling loop runs.
   It selects the event with FOR UPDATE SKIP LOCKED.

3. It builds a Kafka message from the event data.

4. It calls kafka.send() to publish the message.

5. If Kafka accepts the message:
   - The publisher updates the event status to 'published'.
   - The transaction commits. Done.

6. If Kafka is down:
   - kafka.send() throws an error.
   - The catch block rolls back the transaction.
   - The event's status is still 'pending'.
   - On the next poll (100ms later), the publisher tries again.
   - It will keep trying until Kafka comes back.

7. The event is never lost because it lives in the database —
   the same database that holds your booking data.
```

> **What If You Skip This?** Without the outbox pattern, you have exactly two choices when Kafka is down: (1) fail the booking (bad user experience — "sorry, our email system is down so you can't book a hotel") or (2) swallow the error and lose the event (silent data inconsistency that festers). The outbox pattern gives you a third option: succeed the booking, park the event safely, and publish it as soon as Kafka recovers.

---

## FOR UPDATE SKIP LOCKED: Why Those Four Words Matter

You might have glossed over the `FOR UPDATE SKIP LOCKED` clause. Do not. It is critical for running multiple publisher instances safely.

```sql
SELECT ... FROM outbox_events
WHERE status = 'pending'
ORDER BY id ASC
LIMIT 100
FOR UPDATE SKIP LOCKED
```

Here is what each part does:

| Clause | Purpose |
|---|---|
| `FOR UPDATE` | Locks the selected rows. No other transaction can modify or select them with `FOR UPDATE` until this transaction commits. |
| `SKIP LOCKED` | If some rows are already locked by another transaction, skip them instead of waiting. |

Why does this matter? In production, you will run multiple instances of the outbox publisher for redundancy. If Instance A and Instance B both poll at the same time:

- **Without SKIP LOCKED:** Instance B would wait for Instance A to finish, creating a bottleneck. Only one publisher works at a time.
- **With SKIP LOCKED:** Instance B skips the rows that Instance A locked and grabs different pending events. Both publishers work in parallel on different events. Throughput doubles.

Think of it like checkout lanes at a grocery store. Without SKIP LOCKED, everyone waits in one line. With SKIP LOCKED, if a lane is occupied, you move to the next open lane.

---

## Polling vs. Change Data Capture (CDC)

The outbox publisher we built uses **polling** — it checks the outbox table every 100 milliseconds for new events. This works well, but there is an alternative approach called **Change Data Capture (CDC)**.

### Polling (What We Built)

```
Application → writes to outbox_events table
              ↓
Publisher → every 100ms, SELECT pending events
              ↓
Publisher → sends to Kafka
              ↓
Publisher → UPDATE status = 'published'
```

**Pros:**
- Simple to implement and understand. You already saw the code.
- No extra infrastructure. Just your database and a polling loop.
- Easy to debug. `SELECT * FROM outbox_events WHERE status = 'pending'` shows you exactly what has not been published yet.

**Cons:**
- Adds load to your database. Every 100ms, the publisher runs a query, even when there are no new events.
- Latency floor: events wait up to 100ms (your poll interval) before being published. You can reduce this, but faster polling means more database load.
- At very high throughput, the polling queries can become a bottleneck.

### Change Data Capture (CDC)

CDC takes a fundamentally different approach. Instead of polling the table, it reads the database's **transaction log** (MySQL's binlog, PostgreSQL's WAL). Every time a row is inserted into the outbox table, the CDC tool detects the change in the log and streams it to Kafka.

```
Application → writes to outbox_events table
              ↓
Database → writes the change to its transaction log (binlog)
              ↓
CDC Tool (e.g., Debezium) → reads binlog, detects new outbox row
              ↓
CDC Tool → sends to Kafka immediately
              ↓
(Optional) → mark as published or let the CDC tool track its position
```

> **Analogy:** Polling is like checking your mailbox every 5 minutes to see if a letter arrived. CDC is like having a doorbell camera that alerts you the instant the mail carrier drops something off. Both get you the mail, but the camera is faster and you stop making trips to the mailbox.

**Pros:**
- Near-zero latency. Events are published almost instantly after the transaction commits.
- No database polling load. The CDC tool reads the binlog, which the database writes anyway.
- Scales better at high throughput.

**Cons:**
- More infrastructure. You need a CDC tool like Debezium, which runs as a Kafka Connect connector.
- More operational complexity. You need to manage the CDC tool's offset (where it is in the binlog), handle schema changes, and monitor for lag.
- Harder to debug. The data flow is less visible than a SQL query.

### Which Should You Choose?

| Factor | Polling | CDC |
|---|---|---|
| Simplicity | Simple — just SQL queries | Complex — needs Debezium + Kafka Connect |
| Latency | 50-200ms (depends on poll interval) | Near-instant (single-digit ms) |
| Database load | Moderate (constant polling) | Low (reads binlog, no extra queries) |
| Throughput ceiling | ~1,000-5,000 events/second | ~50,000+ events/second |
| Debugging | Easy — query the outbox table | Harder — check CDC connector status |
| Infrastructure | None beyond your database | Debezium, Kafka Connect, connectors |

**Recommendation:** Start with polling. It is simpler, easier to debug, and handles most workloads. Switch to CDC when polling becomes a bottleneck — typically when you are processing thousands of events per second and the polling queries start showing up in your slow query log.

> **Key Term:** **Change Data Capture (CDC)** — A technique that detects changes in a database by reading its internal transaction log (binlog/WAL) rather than polling the data tables. Tools like Debezium can stream these changes to Kafka in near-real-time.

---

## Keeping the Outbox Table Clean

The outbox table is a transit point, not a permanent store. Events flow in, get published, and should be cleaned up. Without cleanup, the table grows unbounded and queries slow down. Here are two maintenance jobs:

```sql
-- Job 1: Clean up published events older than 7 days.
-- We keep them for 7 days so we can investigate issues if needed.
-- The LIMIT 10000 prevents this from being a massive, table-locking operation.
CREATE EVENT cleanup_outbox_events
ON SCHEDULE EVERY 1 HOUR
DO
  DELETE FROM outbox_events
  WHERE status = 'published'
  AND published_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
  LIMIT 10000;
```

```sql
-- Job 2: Retry failed events.
-- Some events might fail permanently (bad payload, invalid topic).
-- We retry them up to max_retries times, waiting at least 1 minute between attempts.
CREATE EVENT retry_failed_outbox_events
ON SCHEDULE EVERY 1 MINUTE
DO
  UPDATE outbox_events
  SET status = 'pending',
      retry_count = retry_count + 1,
      last_retry_at = NOW()
  WHERE status = 'failed'
  AND retry_count < max_retries
  AND (last_retry_at IS NULL OR last_retry_at < DATE_SUB(NOW(), INTERVAL 1 MINUTE));
```

**Job 1** is straightforward garbage collection. Published events that are older than 7 days have served their purpose. Delete them in small batches to avoid locking the table.

**Job 2** handles failure recovery. If an event fails to publish (maybe the Kafka topic was misconfigured, or the payload was too large), it gets marked as `'failed'`. This job resets it to `'pending'` so the publisher picks it up again. After `max_retries` attempts, the event stays `'failed'` permanently — that is your signal to investigate manually.

> **What If You Skip This?** Without cleanup, your outbox table will grow by thousands of rows per day. After a few months, the publisher's `SELECT ... WHERE status = 'pending'` query has to scan millions of rows, most of which are published. Response times degrade, and your outbox — designed to make the system reliable — becomes a performance bottleneck. A cleanup job takes five minutes to implement and saves you hours of debugging later.

---

## Idempotency: Handling Duplicate Events

There is one more subtlety. The outbox pattern guarantees **at-least-once delivery**, not **exactly-once delivery**. Here is why: if the publisher sends the event to Kafka successfully but then crashes before updating the outbox row to `'published'`, the event stays `'pending'`. On restart, the publisher sends it again. The consumer receives the same event twice.

Your consumers must be prepared for this. The solution is idempotency — processing the same event multiple times produces the same result as processing it once.

```typescript
// Consumer that handles duplicate events safely
async handleBookingCreated(event: BookingCreatedEvent): Promise<void> {
  // Check if we already processed this event
  const exists = await db.query(
    `SELECT 1 FROM processed_events WHERE event_id = ?`,
    [event.eventId]
  );

  if (exists.length > 0) {
    // Already processed. Skip.
    console.log(`Duplicate event ${event.eventId}, skipping.`);
    return;
  }

  // Process the event (send email, update index, etc.)
  await this.processBooking(event);

  // Record that we processed it
  await db.query(
    `INSERT INTO processed_events (event_id, processed_at)
     VALUES (?, NOW())`,
    [event.eventId]
  );
}
```

> **Key Term:** **At-least-once delivery** — A messaging guarantee where every event is delivered to the consumer at least once, but possibly more than once. Consumers must be idempotent to handle duplicates safely.

> **Key Term:** **Idempotent consumer** — A consumer that produces the same result whether it processes an event once or multiple times. This is typically achieved by tracking processed event IDs and skipping duplicates.

---

## Connecting It All: From CRUD to Outbox

Let us step back and see how far you have come. In your CRUD applications, data operations looked like this:

```typescript
// CRUD app: one database, one operation, done
await db.query(`INSERT INTO bookings (...) VALUES (...)`);
res.json({ message: 'Booking created' });
```

Then you learned about events and started notifying other services:

```typescript
// Naive event-driven: two writes, no transaction safety
await db.query(`INSERT INTO bookings (...) VALUES (...)`);
await kafkaProducer.send({ topic: 'booking.created', ... }); // can fail!
```

Now, with the outbox pattern, you have a production-grade approach:

```typescript
// Outbox pattern: one atomic transaction, guaranteed delivery
await connection.beginTransaction();
await connection.execute(`INSERT INTO bookings (...) VALUES (...)`);
await connection.execute(`INSERT INTO outbox_events (...) VALUES (...)`);
await connection.commit();
// The publisher process handles Kafka delivery asynchronously.
```

Each step builds on the last. Your CRUD instincts — "write to the database in a transaction" — are exactly right. The outbox pattern just extends that instinct: put everything that must happen together into the same transaction, and let background processes handle the rest.

---

## Chapter 18 Summary

| Concept | One-Sentence Summary |
|---|---|
| Dual-write problem | Writing to a database and a message broker separately creates a window where one succeeds and the other fails, causing permanent inconsistency. |
| Outbox pattern | Write the event to a database table in the same transaction as business data, then publish to Kafka asynchronously with a separate process. |
| Outbox table | A database table (outbox_events) that stores pending events with their topic, payload, and publish status. |
| Outbox publisher | A background process that polls the outbox table for pending events, publishes them to Kafka, and marks them as published. |
| FOR UPDATE SKIP LOCKED | A SQL clause that locks rows for exclusive processing while letting other publisher instances skip locked rows and process different events in parallel. |
| Polling | The publisher checks the outbox table at regular intervals (e.g., every 100ms) for new events — simple but adds database load. |
| CDC (Change Data Capture) | An alternative to polling that reads the database's transaction log to detect new outbox events in near-real-time — faster but more complex infrastructure. |
| At-least-once delivery | The outbox pattern guarantees events are delivered at least once but possibly more than once; consumers must be idempotent. |
| Cleanup jobs | Scheduled tasks that delete old published events and retry failed ones to keep the outbox table small and functional. |

> **Checkpoint:** Without scrolling back, answer these: (1) Why can't you just wrap `db.query()` and `kafkaProducer.send()` in a try/catch to solve the dual-write problem? (2) What is the outbox table's role in the pattern? (3) What does `FOR UPDATE SKIP LOCKED` do and why is it important for running multiple publisher instances? (4) When would you choose CDC over polling? (5) Why must consumers be idempotent when using the outbox pattern? If you can answer all five, you have a solid grasp of reliable event publishing. If question 1 tripped you up, re-read "The Code That Looks Correct But Is Not" — understanding *why* the naive approach fails is the foundation of everything else in this chapter.
