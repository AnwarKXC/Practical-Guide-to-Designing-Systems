# Part 5: Service Communication & Events

---

# Chapter 14: Notification Service — The Messenger

## Starting from What You Know

You have sent emails from a backend before. Maybe you installed `nodemailer`, pointed it at a Gmail SMTP server, and wrote something like this inside an Express route:

```typescript
// The approach you probably learned first
app.post("/api/bookings", async (req, res) => {
  const { userId, roomId, checkIn, checkOut } = req.body;

  // 1. Save the booking to the database
  const booking = await db.query(
    `INSERT INTO bookings (user_id, room_id, check_in, check_out, status)
     VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
    [userId, roomId, checkIn, checkOut]
  );

  // 2. Send confirmation email — RIGHT HERE, inside the request handler
  await transporter.sendMail({
    from: "bookings@myapp.com",
    to: user.email,
    subject: "Booking Confirmed!",
    html: `<h1>You're booked!</h1><p>Room ${roomId}, ${checkIn} to ${checkOut}.</p>`,
  });

  // 3. Only AFTER the email sends do we respond to the user
  res.status(201).json(booking.rows[0]);
});
```

This works. At small scale, it works perfectly fine. The user clicks "Book," the server saves the booking, fires off an email, and responds. Total time: maybe 300 milliseconds. Nobody complains.

But there is a ticking time bomb in this code, and we need to talk about it before we build the real thing.

---

## Why This Breaks at Scale

Three things go wrong as your system grows. All three are rooted in the same mistake: you are sending the email **synchronously**, inside the request handler, while the user sits there waiting.

### Problem 1: Slow Email Servers Block Your Users

SMTP is not fast. A healthy email provider might take 200-500 milliseconds to accept your message. But email providers have bad days too. Maybe SendGrid is under heavy load and starts responding in 3 seconds instead of 200 milliseconds. Maybe the SMTP connection times out entirely after 30 seconds.

During that entire wait, **your user is staring at a loading spinner**. The booking is already saved. The database did its job in 5 milliseconds. But the HTTP response is held hostage by the email server. Your user does not care about the email right now — they want to see the confirmation screen.

```typescript
// Here's the timeline your user experiences:
//
// T=0ms    User clicks "Book Now"
// T=5ms    Database INSERT completes (booking is saved!)
// T=5ms    Server starts sending email via SMTP...
// T=3005ms Email provider finally responds (slow day)
// T=3005ms User FINALLY sees the confirmation page
//
// The user waited 3 seconds for something they didn't need right now.
// If the email provider had a 30-second timeout? The user left.
```

### Problem 2: Email Failures Kill the Entire Request

What happens when the email server is completely down? Your `await transporter.sendMail()` throws an error. If you do not catch it, the entire request fails — even though the booking was already saved to the database. The user sees a 500 error and thinks their booking failed. They try again. Now you have a duplicate booking and a confused customer.

If you do catch the error, what then? You swallow it and respond with success? The user never gets a confirmation email. You retry right there? You are making the user wait even longer.

### Problem 3: One Channel Is Not Enough

Users do not all want emails. Some want SMS. Some want push notifications. Some want all three. Some want emails for confirmations but SMS for cancellations. Once you start supporting multiple channels, your request handler turns into a tangled mess:

```typescript
// This is where "just send an email" leads you eventually
app.post("/api/bookings", async (req, res) => {
  const booking = await saveBooking(req.body);

  // Now we need to check preferences and send through multiple channels...
  const prefs = await getUserPreferences(req.body.userId);

  if (prefs.email) {
    await sendEmail(user.email, "Booking Confirmed", htmlTemplate);
  }
  if (prefs.sms) {
    await sendSMS(user.phone, "Your booking BK-123 is confirmed.");
  }
  if (prefs.push) {
    await sendPushNotification(user.deviceToken, "Booking Confirmed");
  }

  res.status(201).json(booking);
});
// This handler now has FOUR responsibilities: save booking, send email,
// send SMS, send push. It's slow, fragile, and untestable.
```

> **What If You Skip This?** If you keep notifications synchronous inside your request handlers, your API response times will be at the mercy of every external email, SMS, and push notification provider you integrate. When any one of them has an outage or slows down, your booking API — the most important endpoint in your entire system — goes down with it. We have seen production systems where a Twilio outage caused a 45-second average response time on the booking endpoint.

---

## The Fix: Decouple with Events

The answer is to separate **"something happened"** from **"tell the user about it."** The Booking Service should not know or care about emails, SMS, or push notifications. Its job is to create bookings. Period.

Instead, the Booking Service publishes an event — a simple message that says "a booking was created" — and moves on. A completely separate service, the **Notification Service**, picks up that event and decides what to do with it: which channels to use, which template to render, when to send it.

> **Analogy:** Think of a company bulletin board in an office lobby. When something important happens — a new client signs up, a project launches, someone gets promoted — the relevant department pins a note to the bulletin board. They do not walk around the building tapping every single person on the shoulder. Meanwhile, anyone who cares about that type of news checks the bulletin board regularly. The sales team looks for new client announcements. HR looks for staffing updates. The mailroom looks for shipping requests. Each department acts on the notes that are relevant to them and ignores the rest. In our system, **Kafka is the bulletin board**, **events are the pinned notes**, and **the Notification Service is one of the departments checking the board**.

> **Key Term:** **Event-driven architecture** — A design pattern where services communicate by producing and consuming events (messages describing something that happened) rather than calling each other directly. The producer does not know who will consume the event, and the consumer does not know who produced it.

Here is what the flow looks like after the decoupling:

```
BEFORE (synchronous):
  User → Booking Service → [save to DB] → [send email] → [send SMS] → respond to user
  Total time: 500ms—30s depending on email/SMS provider speed

AFTER (event-driven):
  User → Booking Service → [save to DB] → [publish event to Kafka] → respond to user
  Total time: 10-50ms (fast, predictable)

  Meanwhile, in the background:
  Kafka → Notification Service → [read preferences] → [send email] → [send SMS] → [send push]
  The user already has their confirmation page. They don't wait for this.
```

The user gets their response in milliseconds. The email might arrive 2-5 seconds later. That is completely fine — nobody expects an email in their inbox before the web page finishes loading.

---

## How the Notification Service Works

Let us build the Notification Service step by step. This service does exactly one thing: it listens for events on Kafka and delivers notifications through the right channels.

### Step 1: The Kafka Consumer

The Notification Service subscribes to a Kafka topic called `notification-events`. Every time a new event arrives on that topic, the service processes it.

```typescript
// ============================================
// Notification Service - Kafka Consumer
// ============================================

export class NotificationService {
  // Three providers, one for each channel we support.
  // Each provider knows how to talk to its external service.
  private readonly providers = {
    email: new SESEmailProvider(),     // Amazon SES for email
    sms: new TwilioSMSProvider(),      // Twilio for SMS
    push: new FCMPushProvider()        // Firebase Cloud Messaging for push
  };

  async startConsumer(): Promise<void> {
    // Subscribe to the notification-events topic.
    // fromBeginning: false means "only process NEW events, not old ones."
    await kafka.subscribe({ topic: 'notification-events', fromBeginning: false });

    // For every message that arrives on the topic, call processNotification.
    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        await this.processNotification(event);
      }
    });
  }

  // ... (we'll build processNotification next)
}
```

Let us unpack what is happening here.

The `kafka.subscribe()` call tells Kafka: "I want to receive messages from the `notification-events` topic." The `fromBeginning: false` flag is important — it means the service only processes events that arrive **after** it starts. Without this flag, if the service restarts, it would reprocess every event ever published to the topic. That could mean resending thousands of emails.

The `kafka.run()` call starts the consumer loop. Kafka pushes messages to our `eachMessage` callback one at a time. Each message is a raw buffer, so we parse it as JSON and pass it to our processing logic.

> **Key Term:** **Kafka consumer** — A process that reads messages from a Kafka topic. Consumers belong to **consumer groups**: if you run 3 instances of the Notification Service, Kafka distributes the messages across all 3 so no message is processed twice.

### Step 2: Processing a Notification

This is the core logic. When an event arrives, the service needs to:

1. Look up the user (to get their email, phone number, device token)
2. Look up their notification preferences (do they want email? SMS? push?)
3. Pick the right template for this event type
4. Render the template with the event data
5. Send through each preferred channel
6. Handle any failures

```typescript
private async processNotification(event: NotificationEvent): Promise<void> {
  // Step 1: Who are we notifying?
  const user = await this.userService.getById(event.userId);

  // Step 2: How do they want to be notified?
  const preferences = await this.getPreferences(event.userId);

  // Step 3: What template matches this event type?
  const template = this.getTemplate(event.type);

  // Step 4: Fill in the template with actual data
  const rendered = template.render({
    userName: user.name,
    ...event.data
    // For a booking.created event, event.data might include:
    // { hotelName: "Tokyo Grand", checkIn: "2026-03-15", confirmationCode: "GBK-55012" }
  });

  // Step 5: Send through all preferred channels IN PARALLEL
  const results = await Promise.allSettled([
    preferences.email && this.providers.email.send({
      to: user.email,
      subject: rendered.subject,
      html: rendered.htmlBody
    }),
    preferences.sms && this.providers.sms.send({
      to: user.phone,
      body: rendered.smsBody
    }),
    preferences.push && this.providers.push.send({
      token: user.pushToken,
      title: rendered.pushTitle,
      body: rendered.pushBody
    })
  ]);

  // Step 6: Handle failures
  for (const result of results) {
    if (result.status === 'rejected') {
      // Don't crash. Don't give up. Queue it for retry.
      await this.writeToRetryQueue(event, result.reason);
    }
  }
}
```

There are several important patterns in this code. Let us walk through them.

**`Promise.allSettled` instead of `Promise.all`.** This is a critical choice. `Promise.all` stops at the first failure — if the email fails, it would not even attempt SMS or push. `Promise.allSettled` tries **every** channel independently. If email fails but SMS succeeds, the user still gets notified. You always want `allSettled` when the operations are independent of each other.

**Channel preferences.** The `preferences.email && this.providers.email.send(...)` pattern is a short-circuit: if the user has disabled email notifications, the expression evaluates to `false` and the send never happens. This keeps the logic clean without cluttering it with `if` blocks.

**Retry on failure.** When a channel fails (maybe Twilio is briefly unreachable), we do not throw an error or lose the notification. We write it to a **retry queue** — a separate Kafka topic or database table where failed notifications wait to be retried later. This is essential because transient failures (network blips, provider maintenance windows) resolve themselves. A notification that fails at 2:00 AM might succeed perfectly at 2:05 AM.

> **Key Term:** **Dead-letter queue (DLQ)** — A holding area for messages that have failed processing multiple times. After a notification fails its retry attempts (say, 3 retries over 15 minutes), it moves to the DLQ for manual investigation. This prevents infinite retry loops while ensuring no message is silently lost.

---

## Templates: Keeping Content Separate from Logic

Your code should never have raw HTML email strings embedded in it. Templates separate **what to say** from **how to deliver it**.

```typescript
private getTemplate(type: string): NotificationTemplate {
  // Each event type maps to a specific template.
  // Templates know how to render content for every channel.
  const templates: Record<string, NotificationTemplate> = {
    'booking.created': new BookingConfirmationTemplate(),
    'booking.cancelled': new BookingCancellationTemplate(),
    'booking.reminder': new CheckInReminderTemplate(),
    'payment.refunded': new RefundConfirmationTemplate()
  };

  // If we get an event type we don't have a template for,
  // fall back to a generic template instead of crashing.
  return templates[type] || new GenericTemplate();
}
```

A single template class produces content for all channels. Here is what a booking confirmation template might look like:

```typescript
class BookingConfirmationTemplate implements NotificationTemplate {
  render(data: TemplateData): RenderedNotification {
    return {
      // Email gets the full HTML treatment
      subject: `Booking Confirmed — ${data.confirmationCode}`,
      htmlBody: `
        <h1>You're booked, ${data.userName}!</h1>
        <p>Hotel: ${data.hotelName}</p>
        <p>Check-in: ${data.checkIn}</p>
        <p>Check-out: ${data.checkOut}</p>
        <p>Confirmation: ${data.confirmationCode}</p>
      `,

      // SMS gets a short version (160 characters is the limit)
      smsBody: `Booking confirmed! ${data.hotelName}, ${data.checkIn}. Code: ${data.confirmationCode}`,

      // Push notification gets a title and brief body
      pushTitle: "Booking Confirmed",
      pushBody: `${data.hotelName} — ${data.checkIn} to ${data.checkOut}`
    };
  }
}
```

Why do we bother with this? Because templates change constantly. Marketing wants to tweak the email wording. Legal needs to add cancellation policy text. Customer support wants the confirmation code in the SMS. With templates separated from delivery logic, you can change what the email says without touching any Kafka consumer code. Different concerns, different files, different deployment risk.

---

## Channel Preferences: Respecting User Choices

Not every user wants every channel. Some people hate SMS. Some never check email. The Notification Service respects these preferences by checking them before sending.

```typescript
// User preferences stored in the database might look like:
// {
//   userId: "U-881",
//   email: true,        // "Yes, send me emails"
//   sms: false,         // "No texts, please"
//   push: true,         // "Push notifications are fine"
//   quietHours: {       // "But not between midnight and 7 AM"
//     start: "00:00",
//     end: "07:00",
//     timezone: "Asia/Tokyo"
//   }
// }
```

The `processNotification` method checks these preferences before sending through each channel. If a user has `sms: false`, we skip Twilio entirely. If it is 3 AM in their timezone and they have quiet hours enabled, we delay the notification. This is a feature your users will love and your support team will thank you for.

---

## Retry Logic: Never Lose a Notification

External services fail. Twilio has outages. SES rate-limits you. Firebase has maintenance windows. The Notification Service must handle all of this gracefully.

```typescript
private async writeToRetryQueue(
  event: NotificationEvent,
  error: Error
): Promise<void> {
  // Increment the retry counter
  const retryCount = (event.retryCount || 0) + 1;

  if (retryCount > 3) {
    // After 3 retries, move to the dead-letter queue.
    // A human will investigate why this notification keeps failing.
    await this.writeToDeadLetterQueue(event, error);
    return;
  }

  // Publish back to Kafka with an incremented retry count.
  // A delay mechanism (or a separate delayed-retry topic) ensures
  // we don't retry immediately — we wait 30s, then 60s, then 120s.
  await this.kafkaProducer.send({
    topic: 'notification-events-retry',
    messages: [{
      key: event.userId,
      value: JSON.stringify({
        ...event,
        retryCount,
        retryAfter: Date.now() + (retryCount * 30000) // Exponential backoff
      })
    }]
  });
}
```

> **Key Term:** **Exponential backoff** — A retry strategy where you wait progressively longer between attempts: 30 seconds, then 60 seconds, then 120 seconds. This gives the failing external service time to recover without hammering it with rapid-fire retries that make the problem worse.

This retry pattern — try, fail, wait, try again, fail again, wait longer, try one last time, then give up and send to the DLQ — is something you will see in every production microservice. It is one of the most important patterns in distributed systems.

---

## The Big Picture: From Event to Inbox

Let us trace the full lifecycle of a notification from start to finish:

```
1. User books a hotel room.
   Booking Service saves the booking to its database.

2. Booking Service publishes event to Kafka:
   Topic: "notification-events"
   Payload: { type: "booking.created", userId: "U-881",
              data: { hotelName: "Tokyo Grand", checkIn: "2026-03-15", ... } }

3. Notification Service's Kafka consumer picks up the event.

4. Notification Service looks up user U-881:
   - Email: alice@example.com
   - Phone: +1-555-0123
   - Push token: "fcm_abc123..."

5. Notification Service checks preferences:
   - Email: enabled ✓
   - SMS: disabled ✗
   - Push: enabled ✓

6. Notification Service selects the "booking.created" template.
   Renders it with the event data (hotel name, dates, confirmation code).

7. Sends email via Amazon SES → success ✓
   Skips SMS (user preference).
   Sends push via Firebase → success ✓

8. Alice sees a push notification on her phone immediately.
   The confirmation email lands in her inbox 2 seconds later.
   The booking page loaded 5 seconds ago. She already saw the confirmation on-screen.
```

Compare this to the synchronous approach where Alice would have been staring at a spinner for the duration of steps 4-7. In the event-driven model, Alice got her response at step 2. Everything else happened in the background.

---

## Chapter 14 Summary

| Concept | One-Sentence Summary |
|---|---|
| Synchronous notifications | Sending emails inside the request handler blocks the user and creates a single point of failure. |
| Event-driven notifications | Publish an event to Kafka and let a dedicated Notification Service handle delivery asynchronously. |
| Multi-channel delivery | Use `Promise.allSettled` to attempt all channels independently so one failure does not block the others. |
| Templates | Separate message content from delivery logic so marketing can change wording without touching infrastructure code. |
| Channel preferences | Respect each user's choices about which channels they want and when they want to be contacted. |
| Retry with backoff | Failed deliveries go to a retry queue with exponential backoff; after exhausting retries, they land in a dead-letter queue. |
| Bulletin board analogy | Kafka is the office bulletin board; services pin notes and interested departments check the board independently. |

> **Checkpoint:** Imagine your teammate says "let's just add the email send inside the booking route handler — it's simpler." You now know three reasons why that breaks at scale. Can you name them without scrolling up? They are: slow email servers block user responses, email failures kill the whole request, and adding more channels turns the handler into an untestable mess. If you can explain these to your teammate and sketch the event-driven alternative on a whiteboard, you have internalized this chapter.

---

---

# Chapter 15: Distributed Locking — One at a Time, Please

## A Problem You Have Never Thought About

When you work on a single-server application, you do not think much about two pieces of code running the exact same operation at the exact same moment. Your Express app runs on one machine, and even though Node.js handles many requests concurrently (thanks to the event loop), your database transactions keep things orderly. You use `BEGIN` and `COMMIT`, maybe a `SELECT ... FOR UPDATE`, and the database makes sure two requests do not step on each other.

But in a microservices world, you are not running one server. You are running five, ten, or fifty replicas of the same service. Each replica talks to the same database, the same Redis cache, the same inventory data. And there is no shared memory, no shared process, no single event loop keeping things orderly.

This is where things get dangerous.

---

## The Race Condition: See It Before We Fix It

Let us start with a concrete scenario. Our Inventory Service is running on three servers (replicas) behind a load balancer. A hotel has **one room left** for March 15. Two users, Alice and Bob, both click "Book Now" at the exact same instant.

```
Timeline — The Race Condition (NO locking):

Server A (handling Alice's request):
  T=0ms: SELECT available_quantity FROM inventory
         WHERE hotel_id = 'TOKYO-042' AND date = '2026-03-15';
         → Result: available_quantity = 1 (one room left!)

  T=1ms: Great, there's a room! Let me reserve it...

Server B (handling Bob's request):
  T=0ms: SELECT available_quantity FROM inventory
         WHERE hotel_id = 'TOKYO-042' AND date = '2026-03-15';
         → Result: available_quantity = 1 (one room left!)

  T=1ms: Great, there's a room! Let me reserve it...

Server A:
  T=5ms: UPDATE inventory SET available_quantity = 0 WHERE hotel_id = 'TOKYO-042';
         → Success. Alice is booked. ✓

Server B:
  T=6ms: UPDATE inventory SET available_quantity = 0 WHERE hotel_id = 'TOKYO-042';
         → "Success." Bob is booked too. ✓

Result: TWO bookings for ONE room. Someone shows up at the hotel with no
        room available. Lawyers get involved. Nobody is happy.
```

Both servers checked the inventory at the same moment. Both saw "1 room left." Both went ahead and booked it. This is a **race condition** — two processes racing to modify the same data, with the outcome depending on who finishes first.

In a monolith with one server, you could solve this with a database-level lock (`SELECT ... FOR UPDATE`). But across multiple servers, you need something bigger. You need a **distributed lock**.

> **Key Term:** **Race condition** — A bug that occurs when two or more processes access shared data concurrently, and the result depends on the timing of their execution. Race conditions are intermittent — they might happen once in 10,000 requests — which makes them infuriatingly hard to reproduce and debug.

---

## The Bathroom Lock Analogy

> **Analogy:** Think of a bathroom with a lock on the door. When you go in, you turn the lock. Anyone else who tries the door sees it is locked and waits. When you come out, you unlock it, and the next person can enter. Only one person uses the bathroom at a time. A **distributed lock** works the same way: before modifying shared data (the bathroom), your service must acquire a lock (turn the deadbolt). If another service already holds the lock, you wait. When the first service finishes, it releases the lock, and the next service can proceed.

This is exactly what we need for our inventory problem. Before checking and updating the available room count, the service must acquire a lock on that specific resource. If another server already holds the lock, this one waits until the lock is released.

---

## Redis SETNX: The Simplest Lock

Redis has a command called `SETNX` — "SET if Not eXists." It writes a key to Redis only if that key does not already exist. If the key already exists, it does nothing and returns `0`. This is the building block of a distributed lock.

```typescript
// The simplest possible distributed lock using Redis
async function acquireLock(resourceKey: string): Promise<boolean> {
  // SETNX: "Set this key ONLY if it doesn't already exist."
  // If the key doesn't exist → sets it, returns 1 (we got the lock!)
  // If the key already exists → does nothing, returns 0 (someone else has it)
  const result = await redis.setnx(`lock:${resourceKey}`, 'locked');
  return result === 1;
}

async function releaseLock(resourceKey: string): Promise<void> {
  await redis.del(`lock:${resourceKey}`);
}

// Usage:
const gotLock = await acquireLock('inventory:TOKYO-042:2026-03-15');

if (gotLock) {
  try {
    // We hold the lock. Only our server can be in this block.
    const available = await checkInventory('TOKYO-042', '2026-03-15');
    if (available > 0) {
      await decrementInventory('TOKYO-042', '2026-03-15');
      await createBooking(userId, 'TOKYO-042', '2026-03-15');
    }
  } finally {
    // ALWAYS release the lock when done, even if an error occurred.
    await releaseLock('inventory:TOKYO-042:2026-03-15');
  }
} else {
  // Another server holds the lock. We can retry after a short wait,
  // or tell the user to try again.
  return { error: 'Room is being booked by another user. Please try again.' };
}
```

With this lock in place, here is what happens when Alice and Bob try to book the same room:

```
Timeline — With Redis SETNX Lock:

Server A (Alice):
  T=0ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 1 (got the lock!)
  T=1ms: SELECT available_quantity → 1
  T=5ms: UPDATE available_quantity = 0
  T=6ms: DEL lock:inventory:TOKYO-042:2026-03-15 (release lock)

Server B (Bob):
  T=0ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 0 (lock exists!)
  T=0ms: "Room is being booked by another user. Please try again."

  (Bob retries at T=100ms):
  T=100ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 1 (got the lock!)
  T=101ms: SELECT available_quantity → 0
  T=101ms: "Sorry, no rooms available."

Result: ONE booking for ONE room. Correct behavior. ✓
```

This is a major improvement. But this simple lock has a fatal flaw.

---

## The Crash Problem: Why Naive Locks Fail

What happens if Server A acquires the lock, starts processing, and then **crashes**? Maybe the server runs out of memory. Maybe Kubernetes kills the pod during a rolling deployment. Maybe the network between the server and Redis goes down.

```
Timeline — The Crash Scenario:

Server A:
  T=0ms: SETNX lock:inventory:TOKYO-042:2026-03-15 → 1 (got the lock!)
  T=1ms: SELECT available_quantity → 1
  T=3ms: 💀 SERVER CRASHES (out of memory, pod killed, power outage)
         The lock is NEVER released.

Server B:
  T=100ms: SETNX lock:inventory:TOKYO-042 → 0 (locked!)
  T=200ms: SETNX lock:inventory:TOKYO-042 → 0 (still locked!)
  T=1sec:  SETNX lock:inventory:TOKYO-042 → 0 (STILL locked!)
  ... forever. The room can never be booked again.
```

The lock is stuck. Nobody can acquire it because the server that held it died before releasing it. The room appears permanently unavailable. This is called a **deadlock** — a situation where a resource is locked and no process can unlock it.

> **Key Term:** **Deadlock** — A state where a lock is held indefinitely because the holder crashed, lost connectivity, or forgot to release it. In distributed systems, deadlocks are not theoretical — they happen in production, usually at 3 AM.

The fix is to add a **TTL (Time To Live)** to the lock. Instead of a lock that lives forever, you create one that automatically expires after a set duration:

```typescript
async function acquireLock(resourceKey: string, ttlMs: number = 10000): Promise<boolean> {
  // SET with NX (only if not exists) and PX (expire after milliseconds).
  // This is atomic — the SET and the expiration happen as one operation.
  const result = await redis.set(
    `lock:${resourceKey}`,
    'locked',
    'PX', ttlMs,    // Auto-expire after 10 seconds
    'NX'            // Only set if not exists
  );
  return result === 'OK';
}
```

Now, if Server A crashes, the lock automatically expires after 10 seconds. Server B can acquire it and proceed. Crisis averted.

But we have introduced a **new** problem. What if Server A does not crash — it just runs slowly?

---

## The Slow Process Problem

```
Timeline — The TTL Trap:

Server A:
  T=0ms:  Acquires lock (TTL: 10 seconds)
  T=1ms:  SELECT available_quantity → 1
  T=8ms:  Garbage collector pauses (GC pause in Node.js)
  ...     Server A is frozen. It thinks it still holds the lock.
  T=10s:  ⏰ LOCK EXPIRES AUTOMATICALLY (TTL reached)

Server B:
  T=10s:  Acquires lock (Server A's lock expired!)
  T=11s:  SELECT available_quantity → 1
  T=12s:  UPDATE available_quantity = 0 (Bob's booking)
  T=13s:  Release lock

Server A:
  T=13s:  GC pause ends. Server A "wakes up."
          Server A still thinks it holds the lock!
  T=14s:  UPDATE available_quantity = -1 (Alice's booking)
          → DOUBLE BOOKING! Inventory is now negative!
```

Server A had a legitimate reason for being slow — a garbage collection pause. The lock expired while it was paused. Server B acquired the lock, updated the inventory, and released it. Then Server A woke up and wrote to the database, **not knowing its lock had expired**. We are back to the race condition.

This is the fundamental challenge of distributed locking: **a lock with a TTL protects against crashes but not against slow processes.** And in production, processes are slow all the time — GC pauses, network latency, disk I/O, CPU contention.

This is exactly the problem that **Redlock** and **fencing tokens** solve.

---

## Redlock: Locking Across Multiple Redis Nodes

Before we talk about fencing tokens, let us address another concern: what if Redis itself goes down? If you have one Redis instance and it crashes, all your locks are gone. Every service thinks it is free to proceed, and you get race conditions everywhere.

**Redlock** is an algorithm designed by the creator of Redis (Salvatore Sanfilippo) that distributes locks across **multiple independent Redis instances**. To acquire a lock, you must successfully lock on a **majority** of instances (a quorum). This way, even if one Redis node dies, the lock is still held on the others.

```typescript
import Redlock from 'redlock';
import Redis from 'ioredis';

export class FencedRedlockService {
  private redlock: Redlock;

  constructor() {
    // Three independent Redis instances.
    // They don't share data — that's the point.
    // Each one is a separate vote in the quorum.
    const redisClients = [
      new Redis({ host: 'redis-lock-1.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-2.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-3.cluster.local', port: 6379 })
    ];

    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,  // Clock drift compensation (1% of TTL)
      retryCount: 10,     // Try up to 10 times to acquire the lock
      retryDelay: 200     // Wait 200ms between retries
    });
  }
}
```

To acquire a Redlock, the algorithm tries to set the lock key on all three Redis instances. If it succeeds on **at least 2 out of 3** (the majority), the lock is considered acquired. If one Redis node is down, the other two still hold the lock, so no other process can acquire it.

> **Key Term:** **Quorum** — A majority of nodes that must agree before an action is considered valid. With 3 Redis nodes, the quorum is 2. With 5 nodes, the quorum is 3. This ensures that even if some nodes fail, the system still reaches a consistent decision.

But Redlock alone still does not solve the slow-process problem. That is where fencing tokens come in.

---

## Fencing Tokens: The Deli Counter Ticket

> **Analogy:** Imagine the deli counter at a grocery store. When you arrive, you pull a numbered ticket from the dispenser — your number is 42. Someone who arrives after you gets 43, and the next person gets 44. The deli counter will only serve the **current** ticket number. If you wander off, come back late, and try to claim your order with ticket 42 when the counter is already serving ticket 44, the clerk says "sorry, that number has already been served." Your stale ticket is rejected. This is exactly how a **fencing token** works.

A fencing token is a **monotonically increasing number** assigned to each lock acquisition. Every time a service acquires a lock, it gets a token that is higher than the previous one. When the service writes to the database, it includes its fencing token. The database has a simple rule: **only accept writes with a token higher than the one currently stored.**

> **Key Term:** **Fencing token** — A monotonically increasing number assigned to each lock acquisition. When a service writes to the database, it includes its fencing token. The database rejects any write with a token lower than the one currently stored, preventing stale writes from slow or crashed processes.

Here is the implementation:

```typescript
export class FencedRedlockService {
  private redlock: Redlock;
  private fencingCounter: Redis;

  constructor() {
    const redisClients = [
      new Redis({ host: 'redis-lock-1.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-2.cluster.local', port: 6379 }),
      new Redis({ host: 'redis-lock-3.cluster.local', port: 6379 })
    ];

    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200
    });

    // A SEPARATE Redis instance for fencing tokens.
    // This is the single source of truth for token numbers.
    this.fencingCounter = new Redis({
      host: 'redis-fencing.cluster.local'
    });
  }

  /**
   * Acquire a lock AND get a fencing token.
   * The fencing token is what actually protects against stale writes.
   */
  async acquireLockWithFencing(
    resourceKey: string,
    ttlMs: number = 10000
  ): Promise<{ lock: Redlock.Lock; fencingToken: number } | null> {

    try {
      // Step 1: Acquire the distributed lock across the Redis quorum.
      //         This prevents two services from BOTH thinking they have
      //         exclusive access at the same time.
      const lock = await this.redlock.acquire([resourceKey], ttlMs);

      // Step 2: Get a fencing token by atomically incrementing a counter.
      //         INCR is atomic in Redis — even if two commands arrive at
      //         the same microsecond, each gets a unique, increasing number.
      const fencingToken = await this.fencingCounter.incr(`fence:${resourceKey}`);

      // Step 3: Store which token is currently active, with a TTL matching
      //         the lock. This lets us verify tokens during release.
      await this.fencingCounter.set(
        `fence:active:${resourceKey}`,
        fencingToken,
        'EX',
        Math.ceil(ttlMs / 1000)
      );

      return { lock, fencingToken };

    } catch (error) {
      // Lock acquisition failed — another process holds the lock.
      return null;
    }
  }

  /**
   * Release the lock, but only if our fencing token is still the active one.
   * If a newer token exists, our lock was superseded and we should not
   * release it (doing so might interfere with the newer holder).
   */
  async releaseLock(
    resourceKey: string,
    lock: Redlock.Lock,
    fencingToken: number
  ): Promise<boolean> {

    // Check: is our token still the active one?
    const currentToken = await this.fencingCounter.get(
      `fence:active:${resourceKey}`
    );

    if (currentToken && parseInt(currentToken) !== fencingToken) {
      // Our token is old. A newer lock holder has taken over.
      // Do NOT release — we might release THEIR lock.
      console.warn(`Fencing token mismatch. Lock may have been superseded.`);
      return false;
    }

    // Our token is still active. Safe to release.
    await lock.release();
    return true;
  }
}
```

Let us walk through each step.

**Step 1: Acquire the lock.** `this.redlock.acquire()` contacts all three Redis nodes and attempts to set the lock key with a TTL. If a majority (2 out of 3) agree, we get the lock. If the lock is already held, the method either retries (up to `retryCount` times) or throws an error.

**Step 2: Get the fencing token.** `this.fencingCounter.incr()` atomically increments a counter in Redis. "Atomically" means that even if five servers call `INCR` at the same nanosecond, each one gets a unique, sequential number. The first caller gets 1, the next gets 2, then 3, and so on. This gives us the monotonically increasing token we need.

**Step 3: Store the active token.** We record which token is currently active for this resource. This is used during lock release to verify that our token has not been superseded.

**Release with verification.** When releasing the lock, we first check if our token is still the active one. If a newer token exists (meaning our lock expired and another process acquired a new lock with a higher token), we do **not** release — because we would be releasing someone else's lock.

---

## Database-Level Fencing: The Last Line of Defense

Here is the most important part. The fencing token is not just checked in application code — it is enforced **at the database level**. This means even if a buggy or slow service completely bypasses our lock logic, the database itself will reject the stale write.

```sql
-- This UPDATE only succeeds if BOTH conditions are true:
-- 1. There is enough inventory (available_quantity >= requested amount)
-- 2. Our fencing token is HIGHER than the one stored in the database

UPDATE inventory
SET available_quantity = available_quantity - ?,    -- Decrement available rooms
    reserved_quantity = reserved_quantity + ?,      -- Increment reserved count
    fencing_token = ?,                              -- Store our token
    updated_at = NOW()
WHERE resource_type = ?                             -- e.g., 'hotel_room'
AND resource_id = ?                                 -- e.g., 'TOKYO-042'
AND resource_date = ?                               -- e.g., '2026-03-15'
AND available_quantity >= ?                          -- Enough inventory?
AND (fencing_token IS NULL OR fencing_token < ?);   -- Our token is newer?

-- After running this, check affectedRows:
-- If affectedRows === 1 → Success. Our write was accepted.
-- If affectedRows === 0 → Rejected. Either:
--   (a) Not enough inventory (available_quantity < requested)
--   (b) A higher fencing token already exists (we are stale)
-- Both are SAFE rejections. No data corruption.
```

This is the key insight. The `WHERE fencing_token IS NULL OR fencing_token < ?` clause turns the database itself into a fencing enforcement mechanism. Even if our application code has a bug, even if our lock expired without us knowing, the database will not allow a write with a stale token. The data stays consistent.

Let us replay the slow-process scenario from earlier, but now with fencing tokens:

```
Timeline — With Fencing Tokens (SAFE):

Server A:
  T=0ms:    Acquires lock (TTL: 10s), gets fencing token = 42
  T=1ms:    SELECT available_quantity → 1
  T=8ms:    GC pause begins...
  T=10s:    ⏰ Lock expires (Server A doesn't know)

Server B:
  T=10s:    Acquires lock, gets fencing token = 43
  T=11s:    SELECT available_quantity → 1
  T=12s:    UPDATE inventory SET ... fencing_token = 43
            WHERE ... AND (fencing_token IS NULL OR fencing_token < 43)
            → affectedRows = 1. Success! Bob is booked. ✓
  T=13s:    Release lock.

Server A:
  T=13s:    GC pause ends. Server A wakes up.
            Server A still thinks it has the lock (it doesn't).
  T=14s:    UPDATE inventory SET ... fencing_token = 42
            WHERE ... AND (fencing_token IS NULL OR fencing_token < 42)
            → fencing_token is 43. Is 43 < 42? NO.
            → affectedRows = 0. Write REJECTED. ✓

Result: ONE booking for ONE room. Server A's stale write was safely
        rejected by the database. No double booking. No data corruption.
```

> **What If You Skip This?** Without fencing tokens, you will eventually experience double bookings in production. It might not happen in testing. It might not happen with 100 users. But with 10,000 concurrent users hammering the same popular hotel during a flash sale, the probability of two servers both writing to the same inventory row within a 10-second window is effectively 100%. One double booking might cost you a refund and an apology. A hundred of them will cost you your hotel partners.

---

## Why Not Just Use Database Locks?

You might be wondering: "Why go through all this Redis business? Can't I just use `SELECT ... FOR UPDATE` in MySQL?"

You can, and it works. But it has scaling limits.

`SELECT ... FOR UPDATE` locks a row in the database until your transaction commits. If Server A locks row `TOKYO-042`, Server B's query on that row **blocks** — it waits until Server A's transaction is done. At 10 concurrent requests, the wait is negligible. At 1,000 concurrent requests for the same popular hotel during a flash sale, you create a queue of requests all waiting on one database row. Response times spike. Connection pools fill up. The database becomes the bottleneck.

Redis locks are faster because Redis is an in-memory store — acquiring and releasing a lock takes less than 1 millisecond, compared to the overhead of a database transaction. And Redis does not tie up database connections while holding the lock.

That said, the fencing token approach gives you the best of both worlds: a fast Redis lock to prevent most contention, plus a database-level fencing check as the ultimate safety net.

---

## Chapter 15 Summary

| Concept | One-Sentence Summary |
|---|---|
| Race condition | Two servers read the same data, both make decisions based on stale information, and both write — corrupting the data. |
| Distributed lock | A mechanism (using Redis or similar) that ensures only one server can modify a shared resource at a time. |
| SETNX | Redis command that sets a key only if it does not exist — the building block of a simple distributed lock. |
| TTL on locks | Auto-expire locks after a timeout to prevent deadlocks when the lock holder crashes. |
| The slow-process problem | A lock can expire while the holder is still running (GC pause, network delay), allowing another process to acquire it. |
| Redlock | An algorithm that acquires locks across multiple independent Redis nodes, requiring a majority quorum to succeed. |
| Fencing token | A monotonically increasing number attached to each lock acquisition; the database rejects writes with a token lower than the current one. |
| Database-level fencing | Enforcing the fencing token check in the SQL `WHERE` clause so the database itself is the final guard against stale writes. |

> **Checkpoint:** Imagine two servers both try to book the last hotel room at the same time. Can you walk through what happens with (a) no locking, (b) a simple Redis lock, (c) a Redis lock with TTL but no fencing token, and (d) Redlock with a fencing token? If you can explain all four scenarios and why only the last one is fully safe, you have mastered this chapter.

---

---

# Chapter 16: Idempotency — Making Requests Safe to Retry

## A Word You Have Never Heard

If someone dropped the word "idempotent" in a meeting, you might nod politely and Google it later. Let us save you the search.

> **Key Term:** **Idempotent** — An operation where doing it once and doing it multiple times produces the **exact same result**. The second, third, and hundredth execution have no additional effect beyond what the first one did.

That is the textbook definition. Here is the everyday one:

> **Analogy:** Think about pressing an elevator button. You press "5" and it lights up. The elevator is going to the fifth floor. Now you press "5" again, and again, and five more times for good measure. Does the elevator go to the fifth floor eight times? No. It goes once. The button press is **idempotent** — pressing it multiple times has the same effect as pressing it once. Now think about a vending machine. You insert a dollar and press "Cola." You get a cola. You insert another dollar and press "Cola." You get another cola. The vending machine is **not** idempotent — repeating the action produces additional effects.

In the context of APIs:
- `GET /api/bookings/123` is idempotent. Calling it 10 times returns the same booking 10 times. Nothing changes.
- `DELETE /api/bookings/123` is idempotent. The first call deletes the booking. The second call? The booking is already gone. Same result: the booking does not exist.
- `POST /api/bookings` is **NOT** idempotent by default. Calling it twice creates two bookings. Calling it three times creates three bookings. This is the problem.

---

## Why Networks Make This Urgent

In a monolith running on one server, you call a function and it either succeeds or throws an error. Simple. But in a distributed system, requests travel across networks, and networks are unreliable in ways you might not have encountered.

Here is a scenario that will keep you up at night:

```
User clicks "Pay Now" to complete a $340 hotel booking.

1. Browser sends POST /api/payments to your API Gateway.

2. API Gateway forwards to Payment Service.

3. Payment Service calls Stripe. Stripe charges the credit card. $340 is deducted.

4. Payment Service starts to send the response back...

5. 💥 NETWORK BLIP. The response is lost in transit.
   The TCP connection drops. The browser gets a timeout error.

6. The user sees: "Something went wrong. Please try again."

7. The user clicks "Pay Now" again. (What else would they do?)

8. POST /api/payments is sent again. Payment Service calls Stripe again.
   Stripe charges the card again. Another $340 is deducted.

9. The user is charged $680 for a $340 booking.
```

The payment succeeded the first time. But the response never reached the client. From the user's perspective, it failed. So they retried — which is **exactly what you would tell them to do**. And they got double-charged.

This is not a contrived edge case. This happens in production. Every payment processor, every API that handles money, every system where a duplicate operation has real consequences must deal with this.

> **What If You Skip This?** Without idempotency, any network hiccup, user double-click, or automatic retry (many HTTP clients retry failed requests by default) can create duplicate bookings, duplicate payments, or duplicate inventory reservations. During a high-traffic flash sale, you could have hundreds of customers double-charged before anyone notices.

---

## The Fix: Idempotency Keys

The idea is simple: every request carries a unique identifier called an **idempotency key**. Before processing the request, we check: "Have I already processed a request with this key?" If yes, we return the original result without doing the work again. If no, we process the request and store the result, keyed by the idempotency key.

> **Key Term:** **Idempotency key** — A unique string (usually a UUID or a deterministic hash) sent with a request that allows the server to identify duplicate requests. The server stores the result of the first request and returns it for any subsequent request with the same key.

Think of it as giving the server a memory. Without an idempotency key, every POST request looks brand new to the server — it has no way to know it already processed an identical request 5 seconds ago. With an idempotency key, the server can say: "I've seen key `abc-123` before. Last time, I created booking BK-55012 and charged $340. Here is that same result. I will not do any of the work again."

---

## Building Idempotent Booking Creation

Let us build this step by step. Here is the full implementation:

```typescript
// ============================================
// Idempotent Booking Creation
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // Step 1: Get or generate the idempotency key.
    // The client can send one (preferred), or we generate one
    // from the booking parameters (fallback).
    const idempotencyKey = dto.idempotencyKey || this.generateIdempotencyKey(dto);

    // Step 2: Have we already processed this key?
    const existingBooking = await this.findByIdempotencyKey(
      dto.userId,
      idempotencyKey
    );

    if (existingBooking) {
      // YES! We processed this exact request before.
      // Return the original booking. Do NOT create a new one.
      // This is the idempotent response.
      return existingBooking;
    }

    // Step 3: This is a new request. Process it normally.
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Insert the booking with its idempotency key.
      // The idempotency_key column has a UNIQUE constraint,
      // so the database will reject any duplicate.
      const [result] = await connection.execute(`
        INSERT INTO bookings (
          user_id, booking_type, reference_code, idempotency_key,
          subtotal, tax_amount, discount_amount, total_amount, currency,
          status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `, [
        dto.userId, dto.bookingType,
        this.generateReferenceCode(dto.bookingType),
        idempotencyKey,
        dto.subtotal, dto.taxAmount, dto.discountAmount,
        dto.totalAmount, dto.currency
      ]);

      const bookingId = result.insertId;

      // Create the sub-type record (hotel details, flight details, etc.)
      await this.createSubTypeRecord(connection, bookingId, dto);

      // Write event to the outbox table (same transaction = atomic)
      await connection.execute(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, topic, partition_key
        ) VALUES ('booking', ?, 'booking.created', ?, 'booking-events', ?)
      `, [bookingId, JSON.stringify({
        bookingId, userId: dto.userId, bookingType: dto.bookingType,
        totalAmount: dto.totalAmount, currency: dto.currency
      }), `user:${dto.userId}`]);

      await connection.commit();
      return this.getBookingById(bookingId);

    } catch (error) {
      await connection.rollback();

      // Step 4: Handle the race condition.
      // What if two identical requests arrive at the EXACT same time?
      // Both pass the "check if exists" step (Step 2) because
      // neither has been created yet. Both try to INSERT.
      // The UNIQUE constraint on idempotency_key catches this:
      // one succeeds, one gets a duplicate entry error.
      if (error.code === 'ER_DUP_ENTRY') {
        // The other request won the race. Return its result.
        return this.findByIdempotencyKey(dto.userId, idempotencyKey);
      }

      throw error;
    } finally {
      connection.release();
    }
  }
}
```

Let us walk through this carefully.

### Step 1: The Idempotency Key

The client can send its own idempotency key in the request (this is the best approach — Stripe, for example, requires this for payment creation). If the client does not send one, we generate one from the booking parameters. More on that in a moment.

### Step 2: Check for Duplicates

Before doing any work, we look up the idempotency key in the database. If we find a matching booking, we return it immediately. No new database writes. No new payment charges. No new Kafka events. The user gets the exact same response they would have gotten from the first request.

This is the core of idempotency. The first call does the work. Every subsequent call returns the cached result.

### Step 3: Process Normally

If the key does not exist, this is a genuinely new request. We process it normally: insert the booking, create the sub-type record, write an event to the outbox — all within a single database transaction. The idempotency key is stored as a column on the booking row with a `UNIQUE` constraint.

### Step 4: Handle the Race Condition

Here is a subtlety. What if two identical requests arrive at the exact same millisecond? Both check for the idempotency key. Both find nothing (because neither has been committed yet). Both try to INSERT. The database's `UNIQUE` constraint on `idempotency_key` catches this — one INSERT succeeds, the other gets an `ER_DUP_ENTRY` error. We catch that error and return the booking that was created by the winning request.

This is **defense in depth** — the application-level check (Step 2) handles the common case (a retry arriving seconds later), and the database-level constraint (Step 4) handles the edge case (two requests arriving simultaneously).

---

## Generating Deterministic Idempotency Keys

When the client does not provide an idempotency key, we generate one from the booking parameters. The key property is that the same inputs must always produce the same key.

```typescript
/**
 * Generate a deterministic key from booking parameters.
 * Same user + same resource + same dates + same minute = same key.
 *
 * Why include the timestamp rounded to the minute?
 * Because a user might legitimately book the same room for the same dates
 * twice — once in January (then cancel) and again in March. The timestamp
 * ensures those are treated as separate requests.
 */
private generateIdempotencyKey(dto: CreateBookingDto): string {
  const payload = {
    userId: dto.userId,
    resourceId: dto.resourceId,
    checkIn: dto.checkIn?.toISOString(),      // "2026-03-15T00:00:00.000Z"
    checkOut: dto.checkOut?.toISOString(),     // "2026-03-17T00:00:00.000Z"
    timestamp: Math.floor(Date.now() / 60000) // Current minute (not millisecond)
  };

  // SHA-256 hash: deterministic, fixed length, virtually no collisions
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .substring(0, 32);
  // Result: something like "a1b2c3d4e5f6789012345678abcdef01"
}
```

Why SHA-256? Because we need a function that always returns the same output for the same input (deterministic), produces a fixed-length string (fits in a database column), and has practically zero chance of two different inputs producing the same output (collision-resistant).

The `Math.floor(Date.now() / 60000)` rounds the timestamp to the current minute. This means if a user submits the same booking twice within the same minute (a double-click, a retry, a browser auto-retry), they get the same idempotency key. But if they come back an hour later and submit the same booking parameters, they get a different key — because it is a genuinely new intent.

---

## Idempotency at the API Gateway Level

The booking-level idempotency we just built is specific to the Booking Service. But idempotency is so important that we can implement it as a **gateway-level middleware** that protects all POST and PUT endpoints across every service.

```typescript
// Middleware that intercepts all POST/PUT requests and checks for
// an Idempotency-Key header. If found, it caches the response so
// that retries return the same result without hitting the service.

export class IdempotencyMiddleware {
  async handle(req: Request, res: Response, next: NextFunction) {

    // Step 1: Look for the Idempotency-Key header.
    // This is a standard convention (Stripe, AWS, and others use it).
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey) {
      // No key provided. Let the request through normally.
      // The service itself may have its own idempotency handling.
      return next();
    }

    // Step 2: Check Redis for a cached response with this key.
    const cached = await redis.get(`idempotency:${idempotencyKey}`);

    if (cached) {
      // We've seen this key before! Return the cached response.
      // The service is never called. No duplicate work.
      const { statusCode, body } = JSON.parse(cached);
      return res.status(statusCode).json(body);
    }

    // Step 3: This is a new key. Let the request through,
    // but intercept the response so we can cache it.
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {

      // Only cache SUCCESSFUL responses (2xx).
      // If the request failed (4xx, 5xx), the client should be able
      // to retry and get a fresh attempt, not a cached error.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.setex(
          `idempotency:${idempotencyKey}`,
          86400,  // Cache for 24 hours
          JSON.stringify({ statusCode: res.statusCode, body })
        );
      }
      return originalJson(body);
    };

    next();
  }
}
```

Let us walk through what this middleware does.

**Step 1: Check for the header.** The client sends an `Idempotency-Key` header with a unique value (usually a UUID they generate). If the header is missing, we let the request through — not every endpoint needs gateway-level idempotency.

**Step 2: Check the cache.** We look in Redis for a cached response matching this key. If we find one, we immediately return it. The request never reaches the downstream service. No database writes, no Kafka events, no payment charges. The user gets the exact same response as their first request.

**Step 3: Cache the response.** If this is a new key, we let the request through to the service. But we intercept the response using a clever trick: we replace the `res.json` method with our own version that first caches the response in Redis, then sends it to the client. We only cache successful responses (2xx status codes). If a request failed because of a server error, we want the client to be able to retry and get a fresh attempt — not a cached error.

The 24-hour TTL (86400 seconds) means we remember each idempotency key for one day. After that, the key is forgotten, and a request with the same key would be processed as new. This prevents our cache from growing indefinitely while providing a generous window for retries.

### How the Client Uses This

```typescript
// Client-side code (browser or another service)
const idempotencyKey = crypto.randomUUID(); // Generate once per user action

// First attempt (or retry — same key either way)
const response = await fetch('/api/bookings', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey  // ← This is the magic header
  },
  body: JSON.stringify({
    hotelId: 'TOKYO-042',
    checkIn: '2026-03-15',
    checkOut: '2026-03-17'
  })
});

// If the request times out or fails, the client retries with the SAME key.
// The server recognizes the key and returns the original response
// without creating a second booking.
```

The key is generated **once per user action** (once per button click). If the user clicks "Book Now," the frontend generates a UUID right then. If the request fails and the user retries (or the HTTP client auto-retries), the same UUID is sent. The server sees the same key and knows it is a retry.

---

## Defense in Depth: Two Layers of Protection

Notice that we now have idempotency at **two levels**:

1. **API Gateway level** (Redis cache) — Catches retries quickly, before they even reach the service. Fast, cheap, and effective for the common case.

2. **Service level** (database unique constraint) — Catches edge cases where the Redis cache was missed (cache eviction, Redis failure, two requests arriving before the first is cached). The database is the final source of truth.

```
Request arrives → API Gateway checks Redis cache
                  ├─ Cache HIT  → Return cached response (no work done)
                  └─ Cache MISS → Forward to service
                                  ├─ Service checks DB for idempotency key
                                  │  ├─ Key found → Return existing booking
                                  │  └─ Key not found → Create booking
                                  │     └─ INSERT with UNIQUE constraint
                                  │        ├─ Success → Cache response, return
                                  │        └─ ER_DUP_ENTRY → Return existing booking
```

This layered approach means that even if Redis goes down entirely, the database unique constraint still prevents duplicates. And even if the database check has a race condition (two requests arriving at the same microsecond), the unique constraint catches it. You need multiple simultaneous failures to breach both layers, which is vanishingly unlikely.

---

## Everyday Examples of Idempotency

Idempotency is not an exotic distributed-systems concept. You already interact with idempotent systems every day:

| Action | Idempotent? | Why? |
|---|---|---|
| Pressing an elevator button | Yes | Pressing it 5 times still sends you to one floor |
| Turning on a light switch (already on) | Yes | The light stays on regardless of how many times you flip it |
| Setting a thermostat to 72F | Yes | Setting it to 72F ten times keeps it at 72F |
| Inserting a coin into a vending machine | No | Each coin adds to the balance |
| `GET /api/bookings/123` | Yes | Returns the same booking every time, changes nothing |
| `DELETE /api/bookings/123` | Yes | First call deletes it, subsequent calls find it already gone |
| `POST /api/bookings` (without idempotency key) | No | Each call creates a new booking |
| `POST /api/bookings` (with idempotency key) | Yes | First call creates, subsequent calls return the same one |

The goal is to make every write operation in our system idempotent. Not just bookings — payments, inventory updates, notification deliveries, all of it. When you cannot trust the network (and in distributed systems, you never can), idempotency is your safety net.

---

## Chapter 16 Summary

| Concept | One-Sentence Summary |
|---|---|
| Idempotency | Doing the same operation multiple times has the same effect as doing it once. |
| The network problem | Successful operations can appear to fail because the response is lost, causing clients to retry and create duplicates. |
| Idempotency key | A unique identifier sent with each request that lets the server detect and deduplicate retries. |
| Deterministic key generation | Hashing the request parameters produces a consistent key so identical requests always map to the same key. |
| Database UNIQUE constraint | A database-level safeguard that prevents duplicate records even when application-level checks race. |
| ER_DUP_ENTRY handling | Catching the duplicate-entry error and returning the existing record instead of crashing. |
| Gateway-level caching | An API Gateway middleware that caches successful responses in Redis and replays them for duplicate requests. |
| Defense in depth | Two layers of idempotency (Redis cache at the gateway, UNIQUE constraint in the database) ensure duplicates cannot slip through. |

> **Checkpoint:** A colleague asks you: "Why can't we just tell users not to double-click?" Explain to them (without scrolling up) why that does not work. Think about: automatic HTTP client retries, lost responses on successful requests, and mobile networks dropping connections mid-response. If you can explain the network problem and sketch the idempotency key solution on a whiteboard, you are ready for the next chapter.

---
