# Chapter 14: Notification Service — The Messenger

## Starting from What You Know

You have sent emails from a backend before. Maybe you installed `nodemailer`, pointed it at a Gmail SMTP server, and wrote something like this inside an Express route:

```typescript
// The approach you probably learned first
app.post('/api/bookings', async (req, res) => {
  const { userId, roomId, checkIn, checkOut } = req.body;

  // 1. Save the booking to the database
  const booking = await db.query(
    `INSERT INTO bookings (user_id, room_id, check_in, check_out, status)
     VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
    [userId, roomId, checkIn, checkOut]
  );

  // 2. Send confirmation email — RIGHT HERE, inside the request handler
  await transporter.sendMail({
    from: 'bookings@myapp.com',
    to: user.email,
    subject: 'Booking Confirmed!',
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

```
Here is the timeline your user experiences:

T=0ms    User clicks "Book Now"
T=5ms    Database INSERT completes (booking is saved!)
T=5ms    Server starts sending email via SMTP...
T=3005ms Email provider finally responds (slow day)
T=3005ms User FINALLY sees the confirmation page

The user waited 3 seconds for something they didn't need right now.
If the email provider had a 30-second timeout? The user left.
```

### Problem 2: Email Failures Kill the Entire Request

What happens when the email server is completely down? Your `await transporter.sendMail()` throws an error. If you do not catch it, the entire request fails — even though the booking was already saved to the database. The user sees a 500 error and thinks their booking failed. They try again. Now you have a duplicate booking and a confused customer.

If you do catch the error, what then? You swallow it and respond with success? The user never gets a confirmation email. You retry right there? You are making the user wait even longer.

### Problem 3: One Channel Is Not Enough

Users do not all want emails. Some want SMS. Some want push notifications. Some want all three. Some want emails for confirmations but SMS for cancellations. Once you start supporting multiple channels, your request handler turns into a tangled mess:

```typescript
// This is where "just send an email" leads you eventually
app.post('/api/bookings', async (req, res) => {
  const booking = await saveBooking(req.body);

  const prefs = await getUserPreferences(req.body.userId);

  if (prefs.email) {
    await sendEmail(user.email, 'Booking Confirmed', htmlTemplate);
  }
  if (prefs.sms) {
    await sendSMS(user.phone, 'Your booking BK-123 is confirmed.');
  }
  if (prefs.push) {
    await sendPushNotification(user.deviceToken, 'Booking Confirmed');
  }

  res.status(201).json(booking);
});
// This handler now has FOUR responsibilities: save booking, send email,
// send SMS, send push. It's slow, fragile, and untestable.
```

> **What If You Skip This?** If you keep notifications synchronous inside your request handlers, your API response times will be at the mercy of every external email, SMS, and push notification provider you integrate. When any one of them has an outage or slows down, your booking API — the most important endpoint in your entire system — goes down with it. We have seen production systems where a Twilio outage caused a 45-second average response time on the booking endpoint. At 100,000 bookings per minute, that means 100,000 users per minute staring at loading spinners they never recover from.

---

## The Fix: Decouple with Events

The answer is to separate **"something happened"** from **"tell the user about it."** The Booking Service should not know or care about emails, SMS, or push notifications. Its job is to create bookings. Period.

Instead, the Booking Service publishes an event — a simple message that says "a booking was created" — and moves on. A completely separate service, the **Notification Service**, picks up that event and decides what to do with it: which channels to use, which template to render, when to send it.

> **Analogy:** Think of a company bulletin board in an office lobby. When something important happens — a new client signs up, a project launches, someone gets promoted — the relevant department pins a note to the bulletin board. They do not walk around the building tapping every single person on the shoulder. Meanwhile, anyone who cares about that type of news checks the bulletin board regularly. The sales team looks for new client announcements. HR looks for staffing updates. The mailroom looks for shipping requests. Each department acts on the notes that are relevant to them and ignores the rest. In our system, **Kafka is the bulletin board**, **events are the pinned notes**, and **the Notification Service is one of the departments checking the board**.

> **Key Term:** **Event-driven architecture** — A design pattern where services communicate by producing and consuming events (messages describing something that happened) rather than calling each other directly. The producer does not know who will consume the event, and the consumer does not know who produced it.

Here is what the flow looks like after the decoupling:

```
BEFORE (synchronous):
  User -> Booking Service -> [save to DB] -> [send email] -> [send SMS] -> respond to user
  Total time: 500ms-30s depending on email/SMS provider speed

AFTER (event-driven):
  User -> Booking Service -> [save to DB] -> [publish event to Kafka] -> respond to user
  Total time: 10-50ms (fast, predictable)

  Meanwhile, in the background:
  Kafka -> Notification Service -> [read preferences] -> [send email] -> [send SMS] -> [send push]
  The user already has their confirmation page. They don't wait for this.
```

The user gets their response in milliseconds. The email might arrive 2-5 seconds later. That is completely fine — nobody expects an email in their inbox before the web page finishes loading.

---

## The Data Model: What the Notification Service Stores

Before we write a single line of service code, we need tables. The Notification Service is not just a fire-and-forget pipe. It needs to track what was sent, to whom, through which channel, whether it succeeded, and when. This audit trail is essential for debugging, compliance, and customer support ("I never received my confirmation email" is a support ticket you will handle weekly).

We also need to store user notification preferences and templates. Let us start with the raw SQL, then show the Prisma equivalents.

### Raw SQL: Core Notification Tables

```sql
-- =============================================
-- Notification Tables
-- =============================================

-- Table 1: Notification log — every notification attempt
CREATE TABLE notifications (
    id                CHAR(36) PRIMARY KEY -- UUID generated by application
    idempotency_key   VARCHAR(255) NOT NULL UNIQUE,
    user_id           CHAR(36) NOT NULL,
    event_type        VARCHAR(100) NOT NULL,
    channel           VARCHAR(20) NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
    priority          SMALLINT NOT NULL DEFAULT 5,
    status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'queued', 'sending', 'delivered',
                                          'failed', 'bounced', 'dlq')),
    template_id       VARCHAR(100),
    rendered_subject  TEXT,
    rendered_body     TEXT,
    recipient_address VARCHAR(500) NOT NULL,
    provider          VARCHAR(50),
    provider_msg_id   VARCHAR(255),
    attempt_count     SMALLINT NOT NULL DEFAULT 0,
    max_attempts      SMALLINT NOT NULL DEFAULT 3,
    next_retry_at     DATETIME(6),
    last_error        TEXT,
    metadata          JSON DEFAULT '{}',
    created_at        DATETIME(6) NOT NULL DEFAULT NOW(6),
    sent_at           DATETIME(6),
    delivered_at      DATETIME(6),
    updated_at        DATETIME(6) NOT NULL DEFAULT NOW(6)
);

-- Index for querying by user (support tickets: "show me all notifications for user X")
CREATE INDEX idx_notifications_user_id ON notifications(user_id);
-- Index for retry worker polling
CREATE INDEX idx_notifications_retry ON notifications(status, next_retry_at)
  WHERE status = 'failed' AND next_retry_at IS NOT NULL;
-- Index for idempotency lookups
CREATE INDEX idx_notifications_idempotency ON notifications(idempotency_key);
-- Index for audit queries by event type and status
CREATE INDEX idx_notifications_event_status ON notifications(event_type, status, created_at);

-- Table 2: User notification preferences
CREATE TABLE notification_preferences (
    id                  CHAR(36) PRIMARY KEY -- UUID generated by application
    user_id             CHAR(36) NOT NULL UNIQUE,
    email_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    sms_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    push_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    in_app_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    quiet_hours_start   TIME,
    quiet_hours_end     TIME,
    timezone            VARCHAR(50) NOT NULL DEFAULT 'UTC',
    frequency_cap       INTEGER NOT NULL DEFAULT 50,
    frequency_window    VARCHAR(20) NOT NULL DEFAULT 'daily',
    digest_enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    digest_frequency    VARCHAR(20) DEFAULT 'daily',
    digest_time         TIME DEFAULT '09:00',
    category_overrides  JSON DEFAULT '{}',
    created_at          DATETIME(6) NOT NULL DEFAULT NOW(6),
    updated_at          DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_notification_prefs_user ON notification_preferences(user_id);

-- Table 3: Notification templates
CREATE TABLE notification_templates (
    id              VARCHAR(100) PRIMARY KEY,
    event_type      VARCHAR(100) NOT NULL,
    channel         VARCHAR(20) NOT NULL,
    locale          VARCHAR(10) NOT NULL DEFAULT 'en',
    subject         TEXT,
    body_template   TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      DATETIME(6) NOT NULL DEFAULT NOW(6),
    updated_at      DATETIME(6) NOT NULL DEFAULT NOW(6),
    UNIQUE(event_type, channel, locale)
);

-- Table 4: Rate limit tracking
CREATE TABLE notification_rate_limits (
    id              CHAR(36) PRIMARY KEY -- UUID generated by application
    user_id         CHAR(36) NOT NULL,
    channel         VARCHAR(20) NOT NULL,
    window_start    DATETIME(6) NOT NULL,
    count           INTEGER NOT NULL DEFAULT 1,
    UNIQUE(user_id, channel, window_start)
);

CREATE INDEX idx_rate_limits_user_window
  ON notification_rate_limits(user_id, channel, window_start);

-- Table 5: Batch digest queue — holds notifications for digest delivery
CREATE TABLE notification_digest_queue (
    id              CHAR(36) PRIMARY KEY -- UUID generated by application
    user_id         CHAR(36) NOT NULL,
    event_type      VARCHAR(100) NOT NULL,
    channel         VARCHAR(20) NOT NULL,
    payload         JSON NOT NULL,
    scheduled_for   DATETIME(6) NOT NULL,
    is_processed    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_digest_queue_schedule
  ON notification_digest_queue(scheduled_for, is_processed)
  WHERE is_processed = FALSE;
```

> **Common Mistake:** Storing notification content only in the event payload and never persisting it. When a customer opens a support ticket saying "I never got my booking confirmation," you need to answer: "Was the notification sent? What channel? Did the provider accept it? Did it bounce?" Without a `notifications` table with status tracking, you are flying blind.

### Prisma Schema: The Same Tables, ORM-Style

Every raw SQL table above has a Prisma equivalent. If your team uses Prisma for migrations and type-safe queries, here is the schema:

```prisma
// schema.prisma — Notification Service models

model Notification {
  id               String    @id @default(uuid()) @db.Uuid
  idempotencyKey   String    @unique @map("idempotency_key") @db.VarChar(255)
  userId           String    @map("user_id") @db.Uuid
  eventType        String    @map("event_type") @db.VarChar(100)
  channel          String    @db.VarChar(20)
  priority         Int       @default(5) @db.SmallInt
  status           String    @default("pending") @db.VarChar(20)
  templateId       String?   @map("template_id") @db.VarChar(100)
  renderedSubject  String?   @map("rendered_subject")
  renderedBody     String?   @map("rendered_body")
  recipientAddress String    @map("recipient_address") @db.VarChar(500)
  provider         String?   @db.VarChar(50)
  providerMsgId    String?   @map("provider_msg_id") @db.VarChar(255)
  attemptCount     Int       @default(0) @map("attempt_count") @db.SmallInt
  maxAttempts      Int       @default(3) @map("max_attempts") @db.SmallInt
  nextRetryAt      DateTime? @map("next_retry_at") @db.Timestamptz()
  lastError        String?   @map("last_error")
  metadata         Json      @default("{}")
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz()
  sentAt           DateTime? @map("sent_at") @db.Timestamptz()
  deliveredAt      DateTime? @map("delivered_at") @db.Timestamptz()
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz()

  @@index([userId], name: "idx_notifications_user_id")
  @@index([status, nextRetryAt], name: "idx_notifications_retry")
  @@index([idempotencyKey], name: "idx_notifications_idempotency")
  @@index([eventType, status, createdAt], name: "idx_notifications_event_status")
  @@map("notifications")
}

model NotificationPreference {
  id                String   @id @default(uuid()) @db.Uuid
  userId            String   @unique @map("user_id") @db.Uuid
  emailEnabled      Boolean  @default(true) @map("email_enabled")
  smsEnabled        Boolean  @default(false) @map("sms_enabled")
  pushEnabled       Boolean  @default(true) @map("push_enabled")
  inAppEnabled      Boolean  @default(true) @map("in_app_enabled")
  quietHoursStart   DateTime? @map("quiet_hours_start") @db.Time()
  quietHoursEnd     DateTime? @map("quiet_hours_end") @db.Time()
  timezone          String   @default("UTC") @db.VarChar(50)
  frequencyCap      Int      @default(50) @map("frequency_cap")
  frequencyWindow   String   @default("daily") @map("frequency_window") @db.VarChar(20)
  digestEnabled     Boolean  @default(false) @map("digest_enabled")
  digestFrequency   String?  @default("daily") @map("digest_frequency") @db.VarChar(20)
  digestTime        DateTime? @default(dbgenerated("'09:00'::time")) @map("digest_time") @db.Time()
  categoryOverrides Json     @default("{}") @map("category_overrides")
  createdAt         DateTime @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt         DateTime @updatedAt @map("updated_at") @db.Timestamptz()

  @@map("notification_preferences")
}

model NotificationTemplate {
  id           String   @id @db.VarChar(100)
  eventType    String   @map("event_type") @db.VarChar(100)
  channel      String   @db.VarChar(20)
  locale       String   @default("en") @db.VarChar(10)
  subject      String?
  bodyTemplate String   @map("body_template")
  version      Int      @default(1)
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz()
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz()

  @@unique([eventType, channel, locale])
  @@map("notification_templates")
}

model NotificationRateLimit {
  id          String   @id @default(uuid()) @db.Uuid
  userId      String   @map("user_id") @db.Uuid
  channel     String   @db.VarChar(20)
  windowStart DateTime @map("window_start") @db.Timestamptz()
  count       Int      @default(1)

  @@unique([userId, channel, windowStart])
  @@index([userId, channel, windowStart], name: "idx_rate_limits_user_window")
  @@map("notification_rate_limits")
}

model NotificationDigestQueue {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @map("user_id") @db.Uuid
  eventType    String   @map("event_type") @db.VarChar(100)
  channel      String   @db.VarChar(20)
  payload      Json
  scheduledFor DateTime @map("scheduled_for") @db.Timestamptz()
  isProcessed  Boolean  @default(false) @map("is_processed")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz()

  @@index([scheduledFor, isProcessed], name: "idx_digest_queue_schedule")
  @@map("notification_digest_queue")
}
```

### Prisma Client: Querying Notifications

Here is how you use the Prisma Client to interact with these models throughout the service. We will reference these patterns in every section that follows:

```typescript
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// ---- Create a notification record with idempotency ----
async function createNotificationRecord(
  data: Prisma.NotificationCreateInput,
): Promise<Notification | null> {
  try {
    return await prisma.notification.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        // Unique constraint violation on idempotency_key
        // This notification was already created — return existing
        return prisma.notification.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
        });
      }
    }
    throw error;
  }
}

// ---- Fetch user preferences with fallback defaults ----
async function getUserPreferences(userId: string) {
  const prefs = await prisma.notificationPreference.findUnique({
    where: { userId },
  });

  // If no preferences exist, return sensible defaults
  return prefs ?? {
    emailEnabled: true,
    smsEnabled: false,
    pushEnabled: true,
    inAppEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'UTC',
    frequencyCap: 50,
    frequencyWindow: 'daily',
    digestEnabled: false,
    categoryOverrides: {},
  };
}

// ---- Check rate limits before sending ----
async function checkRateLimit(
  userId: string,
  channel: string,
  maxPerWindow: number,
): Promise<boolean> {
  const windowStart = getWindowStart('hourly'); // truncate to current hour

  const result = await prisma.notificationRateLimit.upsert({
    where: {
      userId_channel_windowStart: { userId, channel, windowStart },
    },
    update: { count: { increment: 1 } },
    create: { userId, channel, windowStart, count: 1 },
  });

  return result.count <= maxPerWindow;
}

// ---- Query failed notifications for retry ----
async function getNotificationsForRetry(batchSize: number) {
  return prisma.notification.findMany({
    where: {
      status: 'failed',
      nextRetryAt: { lte: new Date() },
      attemptCount: { lt: 3 }, // MAX_RETRY_ATTEMPTS — use a constant or config value in production
    },
    orderBy: [
      { priority: 'asc' },    // lower number = higher priority
      { nextRetryAt: 'asc' }, // oldest retry first
    ],
    take: batchSize,
  });
}
```

> **Why Not [Alternative]?** Why not store notification status in Redis instead of PostgreSQL? Redis is faster for writes, but notification audit logs are compliance-critical data. You need durability, queryability (find all failed SMS notifications for user X in the last 30 days), and the ability to join with user data. PostgreSQL gives you all three. Use Redis for rate limiting counters — that is ephemeral data where speed matters more than durability.

---

## The Full NestJS Notification Module

We are not building a script. We are building a production service that runs 24/7, processes millions of events, and must not lose a single booking confirmation. NestJS gives us dependency injection, module boundaries, and lifecycle hooks that make this manageable. Let us build the complete module structure.

### Module Architecture

```
notification-service/
  src/
    notification.module.ts          # Root module wiring
    notification.controller.ts      # REST API (preferences, resend, audit)
    notification.service.ts         # Core orchestration logic
    kafka/
      kafka.consumer.ts             # Consumer group with partition assignment
      kafka.producer.ts             # For retry topics and DLQ
    providers/
      provider.interface.ts         # Common interface for all channels
      sendgrid-email.provider.ts    # SendGrid implementation
      twilio-sms.provider.ts        # Twilio implementation
      firebase-push.provider.ts     # Firebase Cloud Messaging
      in-app.provider.ts            # WebSocket/database in-app notifications
    templates/
      template.service.ts           # Handlebars engine with i18n
      mjml.compiler.ts              # MJML-to-HTML compiler
    preferences/
      preferences.service.ts        # User opt-in/out, quiet hours
    rate-limiter/
      rate-limiter.service.ts       # Per-user, per-channel throttling
    retry/
      retry.service.ts              # Exponential backoff retry logic
    batch/
      digest.service.ts             # Daily/weekly digest aggregation
    audit/
      audit.service.ts              # Delivery tracking and reporting
```

### The Root Module

```typescript
// src/notification.module.ts

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';

import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { KafkaNotificationConsumer } from './kafka/kafka.consumer';
import { KafkaRetryProducer } from './kafka/kafka.producer';
import { SendGridEmailProvider } from './providers/sendgrid-email.provider';
import { TwilioSmsProvider } from './providers/twilio-sms.provider';
import { FirebasePushProvider } from './providers/firebase-push.provider';
import { InAppProvider } from './providers/in-app.provider';
import { TemplateService } from './templates/template.service';
import { MjmlCompiler } from './templates/mjml.compiler';
import { PreferencesService } from './preferences/preferences.service';
import { RateLimiterService } from './rate-limiter/rate-limiter.service';
import { RetryService } from './retry/retry.service';
import { DigestService } from './batch/digest.service';
import { AuditService } from './audit/audit.service';

@Module({
  imports: [
    PrismaModule,

    // Schedule module for cron jobs (digest, retry polling)
    ScheduleModule.forRoot(),

    // Kafka client for producing retry/DLQ messages
    ClientsModule.register([
      {
        name: 'KAFKA_SERVICE',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'notification-service',
            brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
            ssl: process.env.KAFKA_SSL === 'true',
            sasl: process.env.KAFKA_SASL_USERNAME
              ? {
                  mechanism: 'scram-sha-256',
                  username: process.env.KAFKA_SASL_USERNAME,
                  password: process.env.KAFKA_SASL_PASSWORD,
                }
              : undefined,
          },
          consumer: {
            groupId: 'notification-service-group',
            sessionTimeout: 30000,
            heartbeatInterval: 3000,
            maxBytesPerPartition: 1048576, // 1 MB
          },
        },
      },
    ]),
  ],

  controllers: [NotificationController],

  providers: [
    NotificationService,
    KafkaNotificationConsumer,
    KafkaRetryProducer,

    // Channel providers — injected by token so we can swap implementations
    { provide: 'EMAIL_PROVIDER', useClass: SendGridEmailProvider },
    { provide: 'SMS_PROVIDER', useClass: TwilioSmsProvider },
    { provide: 'PUSH_PROVIDER', useClass: FirebasePushProvider },
    { provide: 'IN_APP_PROVIDER', useClass: InAppProvider },

    TemplateService,
    MjmlCompiler,
    PreferencesService,
    RateLimiterService,
    RetryService,
    DigestService,
    AuditService,
  ],
})
export class NotificationModule {}
```

Notice how each channel provider is registered with a string token (`'EMAIL_PROVIDER'`, `'SMS_PROVIDER'`, etc.). This lets us swap SendGrid for Amazon SES by changing one line — `useClass: SesEmailProvider` — without touching any business logic. In tests, you inject mock providers that record what was sent instead of actually hitting external APIs.

### The Kafka Consumer Group: Processing Events at Scale

This is the heart of the service. The consumer group is how Kafka distributes work across multiple instances of the Notification Service. If you have 3 instances running and the `notification-events` topic has 12 partitions, Kafka assigns 4 partitions to each instance. No event is processed twice. If one instance dies, Kafka reassigns its partitions to the survivors within seconds.

```typescript
// src/kafka/kafka.consumer.ts

import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Consumer, EachMessagePayload, logLevel } from 'kafkajs';
import { NotificationService } from '../notification.service';

// Priority mapping: lower number = higher priority = processed first
export enum NotificationPriority {
  CRITICAL = 1,        // Booking confirmations, payment receipts
  HIGH = 3,            // Cancellations, schedule changes
  NORMAL = 5,          // Reminders, check-in notifications
  LOW = 7,             // Marketing, promotions
  BATCH = 9,           // Digest items, weekly summaries
}

// The event shape that arrives on the Kafka topic
interface NotificationEvent {
  eventId: string;          // Unique ID for idempotency
  type: string;             // e.g., 'booking.created', 'payment.refunded'
  userId: string;
  priority: NotificationPriority;
  data: Record<string, any>;
  timestamp: string;
  retryCount?: number;
}

@Injectable()
export class KafkaNotificationConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaNotificationConsumer.name);
  private consumer: Consumer;
  private readonly kafka: Kafka;

  // We subscribe to THREE topics:
  // 1. notification-events — primary events from other services
  // 2. notification-events-retry — failed notifications waiting for retry
  // 3. notification-events-priority — high-priority bypass lane
  private readonly TOPICS = [
    'notification-events',
    'notification-events-retry',
    'notification-events-priority',
  ];

  constructor(private readonly notificationService: NotificationService) {
    this.kafka = new Kafka({
      clientId: 'notification-service',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
      logLevel: logLevel.WARN,
      retry: {
        initialRetryTime: 300,
        retries: 10,
      },
    });

    // Consumer group ID is critical.
    // All instances with the SAME group ID share the workload.
    // Kafka guarantees each partition is consumed by exactly ONE member
    // of the group at any time.
    this.consumer = this.kafka.consumer({
      groupId: 'notification-service-group',
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
      maxWaitTimeInMs: 100,
      // Process messages one at a time per partition.
      // This ensures ordering within a partition (all events for one user
      // are processed sequentially if we partition by userId).
    });
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();

    // Subscribe to all three topics
    for (const topic of this.TOPICS) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      // eachMessage processes ONE message at a time per partition.
      // For higher throughput, you could use eachBatch, but eachMessage
      // gives you simpler error handling and automatic offset management.
      eachMessage: async (payload: EachMessagePayload) => {
        await this.handleMessage(payload);
      },
    });

    this.logger.log(
      `Kafka consumer started, subscribed to: ${this.TOPICS.join(', ')}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    // Graceful shutdown: stop consuming, commit offsets, disconnect
    await this.consumer.disconnect();
    this.logger.log('Kafka consumer disconnected gracefully');
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const startTime = Date.now();

    let event: NotificationEvent;

    try {
      event = JSON.parse(message.value?.toString() || '{}');
    } catch (parseError) {
      // Malformed message — log it and skip. Do NOT retry parsing failures.
      this.logger.error(
        `Malformed message on ${topic}[${partition}], offset ${message.offset}`,
        parseError,
      );
      return; // Kafka auto-commits the offset, so we move past this message
    }

    try {
      this.logger.debug(
        `Processing event ${event.eventId} (${event.type}) from ${topic}[${partition}]`,
      );

      // Hand off to the core notification service.
      // This method handles preferences, templates, channel dispatch,
      // rate limiting, and audit logging.
      await this.notificationService.processEvent(event);

      const elapsed = Date.now() - startTime;
      this.logger.debug(
        `Event ${event.eventId} processed in ${elapsed}ms`,
      );
    } catch (processingError) {
      // Processing failed — the NotificationService.processEvent method
      // handles its own retry logic internally. If it throws, something
      // truly unexpected happened (database down, OOM, etc.).
      this.logger.error(
        `Unhandled error processing event ${event.eventId}: ${processingError.message}`,
        processingError.stack,
      );

      // We do NOT rethrow. Rethrowing would cause KafkaJS to pause the
      // partition and retry indefinitely, blocking all other messages
      // on that partition. Instead, we let the offset commit and rely
      // on the notification record in the database (status: 'failed')
      // for the retry worker to pick up.
    }
  }
}
```

> **Key Term:** **Consumer group** — A set of consumers that share a group ID. Kafka distributes topic partitions across members of the same group so that each message is processed by exactly one consumer. Adding more consumers to the group increases parallelism (up to the number of partitions). If a consumer crashes, Kafka triggers a **rebalance** and reassigns its partitions to the remaining group members.

### Notification Queue Priority System

Not all notifications are equal. A booking confirmation must never wait behind a marketing email. We implement priority at two levels: Kafka topic separation and database-level ordering.

```typescript
// src/notification.service.ts — Core orchestration (simplified, full version below)

import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { TemplateService } from './templates/template.service';
import { PreferencesService } from './preferences/preferences.service';
import { RateLimiterService } from './rate-limiter/rate-limiter.service';
import { RetryService } from './retry/retry.service';
import { AuditService } from './audit/audit.service';
import { NotificationPriority } from './kafka/kafka.consumer';
import { ChannelProvider } from './providers/provider.interface';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly templateService: TemplateService,
    private readonly preferencesService: PreferencesService,
    private readonly rateLimiter: RateLimiterService,
    private readonly retryService: RetryService,
    private readonly auditService: AuditService,
    @Inject('EMAIL_PROVIDER') private readonly emailProvider: ChannelProvider,
    @Inject('SMS_PROVIDER') private readonly smsProvider: ChannelProvider,
    @Inject('PUSH_PROVIDER') private readonly pushProvider: ChannelProvider,
    @Inject('IN_APP_PROVIDER') private readonly inAppProvider: ChannelProvider,
  ) {}

  async processEvent(event: NotificationEvent): Promise<void> {
    // Step 1: Idempotency check — have we already processed this event?
    const idempotencyKey = `${event.eventId}`;
    const existing = await this.prisma.notification.findUnique({
      where: { idempotencyKey },
    });

    if (existing && existing.status === 'delivered') {
      this.logger.debug(`Event ${event.eventId} already delivered, skipping`);
      return; // Already processed successfully
    }

    // Step 2: Load user preferences
    const preferences = await this.preferencesService.getPreferences(
      event.userId,
    );

    // Step 3: Determine which channels to use
    const channels = this.resolveChannels(event, preferences);

    if (channels.length === 0) {
      this.logger.debug(
        `No channels enabled for user ${event.userId}, event ${event.type}`,
      );
      return;
    }

    // Step 4: Check quiet hours — if in quiet hours, defer unless CRITICAL
    if (
      event.priority !== NotificationPriority.CRITICAL &&
      this.preferencesService.isInQuietHours(preferences)
    ) {
      await this.deferToNextWindow(event, preferences);
      return;
    }

    // Step 5: Render templates for each channel
    const rendered = await this.templateService.renderForChannels(
      event.type,
      channels,
      { userName: event.data.userName, ...event.data },
      preferences.timezone,
    );

    // Step 6: Dispatch to each channel with rate limiting
    const results = await Promise.allSettled(
      channels.map((channel) =>
        this.dispatchToChannel(channel, event, rendered[channel], preferences),
      ),
    );

    // Step 7: Audit log every result
    await this.auditService.logResults(event, channels, results);
  }

  private resolveChannels(
    event: NotificationEvent,
    preferences: UserPreferences,
  ): string[] {
    const channels: string[] = [];

    // Check each channel against user preferences
    if (preferences.emailEnabled) channels.push('email');
    if (preferences.smsEnabled) channels.push('sms');
    if (preferences.pushEnabled) channels.push('push');
    if (preferences.inAppEnabled) channels.push('in_app');

    // Apply category overrides.
    // A user might say: "Email me for booking events, but NOT for marketing."
    const overrides = preferences.categoryOverrides as Record<string, any>;
    const category = this.getEventCategory(event.type);

    if (overrides[category]) {
      return channels.filter(
        (ch) => overrides[category][ch] !== false,
      );
    }

    return channels;
  }

  private getEventCategory(eventType: string): string {
    // Map event types to categories for preference overrides
    const categoryMap: Record<string, string> = {
      'booking.created': 'transactional',
      'booking.cancelled': 'transactional',
      'booking.reminder': 'reminders',
      'payment.refunded': 'transactional',
      'promotion.new': 'marketing',
      'digest.daily': 'digest',
    };
    return categoryMap[eventType] || 'general';
  }

  private async dispatchToChannel(
    channel: string,
    event: NotificationEvent,
    rendered: RenderedContent,
    preferences: UserPreferences,
  ): Promise<void> {
    // Rate limit check BEFORE sending
    const withinLimits = await this.rateLimiter.checkAndIncrement(
      event.userId,
      channel,
      preferences.frequencyCap,
    );

    if (!withinLimits) {
      this.logger.warn(
        `Rate limit exceeded for user ${event.userId} on ${channel}`,
      );
      // If rate limited, queue for digest instead of dropping
      if (event.priority > NotificationPriority.HIGH) {
        await this.queueForDigest(event, channel);
      }
      return;
    }

    // Create the notification record BEFORE sending (status: 'sending')
    const notification = await this.prisma.notification.upsert({
      where: { idempotencyKey: `${event.eventId}-${channel}` },
      create: {
        idempotencyKey: `${event.eventId}-${channel}`,
        userId: event.userId,
        eventType: event.type,
        channel,
        priority: event.priority,
        status: 'sending',
        renderedSubject: rendered.subject,
        renderedBody: rendered.body,
        recipientAddress: rendered.recipientAddress,
        metadata: event.data as any,
      },
      update: {
        status: 'sending',
        attemptCount: { increment: 1 },
      },
    });

    try {
      // Dispatch to the appropriate provider
      const provider = this.getProvider(channel);
      const result = await provider.send(rendered);

      // Update status to delivered
      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: 'delivered',
          sentAt: new Date(),
          deliveredAt: new Date(),
          provider: provider.name,
          providerMsgId: result.messageId,
        },
      });
    } catch (error) {
      // Update status to failed, schedule retry
      await this.retryService.scheduleRetry(notification, error);
    }
  }

  private getProvider(channel: string): ChannelProvider {
    const providers: Record<string, ChannelProvider> = {
      email: this.emailProvider,
      sms: this.smsProvider,
      push: this.pushProvider,
      in_app: this.inAppProvider,
    };
    return providers[channel];
  }

  private async deferToNextWindow(
    event: NotificationEvent,
    preferences: UserPreferences,
  ): Promise<void> {
    // Calculate when quiet hours end in the user's timezone
    const nextWindow = this.preferencesService.getQuietHoursEnd(preferences);

    await this.prisma.notification.create({
      data: {
        idempotencyKey: `${event.eventId}-deferred`,
        userId: event.userId,
        eventType: event.type,
        channel: 'deferred',
        priority: event.priority,
        status: 'queued',
        recipientAddress: 'deferred',
        nextRetryAt: nextWindow,
        metadata: event as any,
      },
    });

    this.logger.debug(
      `Deferred event ${event.eventId} until ${nextWindow.toISOString()} (quiet hours)`,
    );
  }

  private async queueForDigest(
    event: NotificationEvent,
    channel: string,
  ): Promise<void> {
    await this.prisma.notificationDigestQueue.create({
      data: {
        userId: event.userId,
        eventType: event.type,
        channel,
        payload: event.data as any,
        scheduledFor: this.getNextDigestTime(event.userId),
      },
    });
  }

  private getNextDigestTime(userId: string): Date {
    // Default: next day at 9 AM UTC. In production, this reads
    // the user's digest_time preference.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    return tomorrow;
  }
}
```

> **Analogy:** Think of the notification priority system like a hospital emergency room. Critical patients (booking confirmations) go straight to a doctor. Urgent cases (cancellations) wait briefly. Routine checkups (reminders) sit in the waiting room. And the flu-shot campaign (marketing emails) happens when there is downtime. You never delay a critical patient because the waiting room is full of routine appointments.

---

## Multi-Channel Providers: Four Ways to Reach a User

Every notification channel — email, SMS, push, in-app — talks to a different external API with different authentication, rate limits, payload formats, and failure modes. We hide all of this behind a common interface so the core notification service does not care which channel it is dispatching to.

### The Provider Interface

```typescript
// src/providers/provider.interface.ts

export interface SendResult {
  messageId: string;      // Provider's unique ID for tracking
  provider: string;       // e.g., 'sendgrid', 'twilio'
  channel: string;        // e.g., 'email', 'sms'
  timestamp: Date;
}

export interface RenderedContent {
  recipientAddress: string;   // Email address, phone number, device token, or user ID
  subject?: string;           // Email/push title
  body: string;               // HTML for email, plain text for SMS, body for push
  plainText?: string;         // Plain text fallback for email
  metadata?: Record<string, any>;
}

export interface ChannelProvider {
  readonly name: string;
  readonly channel: string;
  send(content: RenderedContent): Promise<SendResult>;
  validateRecipient(address: string): boolean;
}
```

### Provider 1: SendGrid Email

```typescript
// src/providers/sendgrid-email.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import * as sgMail from '@sendgrid/mail';
import { ChannelProvider, RenderedContent, SendResult } from './provider.interface';

@Injectable()
export class SendGridEmailProvider implements ChannelProvider {
  readonly name = 'sendgrid';
  readonly channel = 'email';
  private readonly logger = new Logger(SendGridEmailProvider.name);

  constructor() {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }

  async send(content: RenderedContent): Promise<SendResult> {
    const msg = {
      to: content.recipientAddress,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL || 'bookings@globalbooking.com',
        name: process.env.SENDGRID_FROM_NAME || 'Global Booking System',
      },
      subject: content.subject,
      html: content.body,
      text: content.plainText || this.stripHtml(content.body),
      // SendGrid categories for analytics
      categories: [content.metadata?.eventType || 'transactional'],
      // Custom tracking arguments
      customArgs: {
        notificationId: content.metadata?.notificationId,
        userId: content.metadata?.userId,
      },
      // Tracking settings
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true },
      },
    };

    try {
      const [response] = await sgMail.send(msg);

      this.logger.debug(
        `Email sent to ${content.recipientAddress}, ` +
        `status: ${response.statusCode}, msgId: ${response.headers['x-message-id']}`,
      );

      return {
        messageId: response.headers['x-message-id'] as string,
        provider: this.name,
        channel: this.channel,
        timestamp: new Date(),
      };
    } catch (error) {
      // SendGrid returns structured errors with a response body
      const sgError = error.response?.body?.errors?.[0];
      this.logger.error(
        `SendGrid error: ${sgError?.message || error.message}`,
      );
      throw new Error(
        `SendGrid delivery failed: ${sgError?.message || error.message}`,
      );
    }
  }

  validateRecipient(address: string): boolean {
    // Basic email validation — in production, use a library like validator.js
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}
```

### Provider 2: Twilio SMS

```typescript
// src/providers/twilio-sms.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import { Twilio } from 'twilio';
import { ChannelProvider, RenderedContent, SendResult } from './provider.interface';

@Injectable()
export class TwilioSmsProvider implements ChannelProvider {
  readonly name = 'twilio';
  readonly channel = 'sms';
  private readonly logger = new Logger(TwilioSmsProvider.name);
  private readonly client: Twilio;
  private readonly fromNumber: string;

  constructor() {
    this.client = new Twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
    );
    this.fromNumber = process.env.TWILIO_FROM_NUMBER;
  }

  async send(content: RenderedContent): Promise<SendResult> {
    // SMS has a 160-character limit for a single segment.
    // Messages longer than 160 chars are split into multiple segments
    // and cost more. We truncate to 160 for cost control.
    const body = this.truncateForSms(content.body);

    try {
      const message = await this.client.messages.create({
        to: content.recipientAddress,
        from: this.fromNumber,
        body,
        // Status callback — Twilio will POST delivery status updates here
        statusCallback: `${process.env.BASE_URL}/api/notifications/webhooks/twilio`,
      });

      this.logger.debug(
        `SMS sent to ${content.recipientAddress}, SID: ${message.sid}`,
      );

      return {
        messageId: message.sid,
        provider: this.name,
        channel: this.channel,
        timestamp: new Date(),
      };
    } catch (error) {
      // Twilio error codes: 21211 = invalid number, 21608 = unverified number
      this.logger.error(
        `Twilio error ${error.code}: ${error.message}`,
      );
      throw new Error(`Twilio delivery failed: [${error.code}] ${error.message}`);
    }
  }

  validateRecipient(address: string): boolean {
    // E.164 format: +{country code}{number}, 8-15 digits
    return /^\+[1-9]\d{7,14}$/.test(address);
  }

  private truncateForSms(text: string, maxLength = 160): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }
}
```

### Provider 3: Firebase Cloud Messaging (Push)

```typescript
// src/providers/firebase-push.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { ChannelProvider, RenderedContent, SendResult } from './provider.interface';

@Injectable()
export class FirebasePushProvider implements ChannelProvider {
  readonly name = 'firebase';
  readonly channel = 'push';
  private readonly logger = new Logger(FirebasePushProvider.name);

  constructor() {
    // Initialize Firebase Admin SDK only once
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
  }

  async send(content: RenderedContent): Promise<SendResult> {
    const message: admin.messaging.Message = {
      token: content.recipientAddress,   // The user's FCM device token
      notification: {
        title: content.subject || 'Global Booking',
        body: content.body,
      },
      data: {
        // Custom data payload — the mobile app reads this to decide
        // which screen to navigate to when the user taps the notification
        eventType: content.metadata?.eventType || '',
        bookingId: content.metadata?.bookingId || '',
        deepLink: content.metadata?.deepLink || '',
      },
      // Platform-specific configuration
      android: {
        priority: 'high',
        notification: {
          channelId: 'booking-notifications',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    try {
      const messageId = await admin.messaging().send(message);

      this.logger.debug(
        `Push notification sent, FCM ID: ${messageId}`,
      );

      return {
        messageId,
        provider: this.name,
        channel: this.channel,
        timestamp: new Date(),
      };
    } catch (error) {
      // FCM error codes:
      // messaging/invalid-registration-token — token is malformed
      // messaging/registration-token-not-registered — user uninstalled the app
      if (error.code === 'messaging/registration-token-not-registered') {
        this.logger.warn(
          `Device token no longer valid for user, should be cleaned up`,
        );
      }
      throw new Error(`FCM delivery failed: ${error.code} — ${error.message}`);
    }
  }

  validateRecipient(token: string): boolean {
    // FCM tokens are typically 150+ characters
    return typeof token === 'string' && token.length > 100;
  }
}
```

### Provider 4: In-App Notifications

In-app notifications are stored in the database and delivered via WebSocket or polling. Unlike external channels, in-app notifications never fail due to a third-party outage — they are entirely within your control.

```typescript
// src/providers/in-app.provider.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelProvider, RenderedContent, SendResult } from './provider.interface';
import { WebSocketGateway } from '../websocket/websocket.gateway';

@Injectable()
export class InAppProvider implements ChannelProvider {
  readonly name = 'internal';
  readonly channel = 'in_app';
  private readonly logger = new Logger(InAppProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wsGateway: WebSocketGateway,
  ) {}

  async send(content: RenderedContent): Promise<SendResult> {
    // Step 1: Persist the in-app notification to the database
    const notification = await this.prisma.$queryRaw`
      INSERT INTO in_app_notifications (user_id, title, body, event_type, deep_link, is_read)
      VALUES (
        ${content.recipientAddress}::uuid,
        ${content.subject || 'Notification'},
        ${content.body},
        ${content.metadata?.eventType || 'general'},
        ${content.metadata?.deepLink || null},
        false
      )
      RETURNING id::text
    `;

    const notificationId = notification[0].id;

    // Step 2: Push to the user's WebSocket connection (if online)
    // If the user is not connected, they will see it when they next open the app
    const pushed = await this.wsGateway.sendToUser(
      content.recipientAddress,
      'notification',
      {
        id: notificationId,
        title: content.subject,
        body: content.body,
        eventType: content.metadata?.eventType,
        deepLink: content.metadata?.deepLink,
        createdAt: new Date().toISOString(),
      },
    );

    this.logger.debug(
      `In-app notification stored (${notificationId}), ` +
      `WebSocket delivery: ${pushed ? 'online' : 'offline'}`,
    );

    return {
      messageId: notificationId,
      provider: this.name,
      channel: this.channel,
      timestamp: new Date(),
    };
  }

  validateRecipient(userId: string): boolean {
    // UUID format check
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
  }
}
```

> **Why Not [Alternative]?** Why not use Amazon SES instead of SendGrid for email? Both are excellent. SES is cheaper at high volume ($0.10 per 1,000 emails vs. SendGrid's tiered pricing) but requires more setup: SES starts in sandbox mode, you must verify every domain, and you manage your own reputation monitoring. SendGrid gives you a polished dashboard, built-in analytics, and webhook-based delivery tracking out of the box. For a booking platform where email reliability is critical and your team is small, SendGrid gets you to production faster. Switch to SES once you are sending more than 500,000 emails per month and the cost savings justify the operational overhead.

---

## Template Engine: Handlebars with i18n Support

Hard-coded strings in your provider code are a maintenance nightmare. Imagine changing the wording of a booking confirmation — you would need to update the email template, the SMS template, the push title, and the in-app body, all in different files. And then multiply that by every language you support.

We use **Handlebars** as our template engine because it is logic-less by design (no `if/else` spaghetti in templates), has excellent i18n library support, and compiles templates once for fast rendering.

> **Key Term:** **Handlebars** — A minimal templating language that uses `{{variable}}` syntax for placeholders and `{{#helper}}` blocks for formatting. Unlike full programming languages in templates (EJS, Pug), Handlebars intentionally limits logic in templates, forcing you to prepare data before rendering. This makes templates easier to read, test, and hand off to non-engineers.

### The Template Service

```typescript
// src/templates/template.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { PrismaService } from '../prisma/prisma.service';
import { MjmlCompiler } from './mjml.compiler';

// i18n translations loaded per locale
interface TranslationMap {
  [locale: string]: Record<string, string>;
}

@Injectable()
export class TemplateService implements OnModuleInit {
  private readonly logger = new Logger(TemplateService.name);

  // Cache compiled templates: key = `${eventType}:${channel}:${locale}`
  private compiledTemplates = new Map<string, HandlebarsTemplateDelegate>();

  // i18n translation strings
  private translations: TranslationMap = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly mjmlCompiler: MjmlCompiler,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register Handlebars helpers for i18n and formatting
    this.registerHelpers();

    // Load translations from files or database
    await this.loadTranslations();

    // Pre-compile all active templates from the database
    await this.precompileTemplates();

    this.logger.log(
      `Template service initialized: ${this.compiledTemplates.size} templates compiled`,
    );
  }

  private registerHelpers(): void {
    // {{t "booking.confirmed"}} — translate a key to the current locale
    Handlebars.registerHelper('t', (key: string, options: any) => {
      const locale = options.data?.root?._locale || 'en';
      return this.translations[locale]?.[key] || this.translations['en']?.[key] || key;
    });

    // {{formatDate checkIn "MMMM d, yyyy"}} — format a date
    Handlebars.registerHelper('formatDate', (dateStr: string, format: string) => {
      const date = new Date(dateStr);
      // Simplified formatter — in production, use date-fns or Intl.DateTimeFormat
      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      };
      return date.toLocaleDateString('en-US', options);
    });

    // {{formatCurrency amount currency}} — format money values
    Handlebars.registerHelper(
      'formatCurrency',
      (amount: number, currency: string) => {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: currency || 'USD',
        }).format(amount);
      },
    );

    // {{pluralize count "night" "nights"}} — singular/plural
    Handlebars.registerHelper(
      'pluralize',
      (count: number, singular: string, plural: string) => {
        return count === 1 ? singular : plural;
      },
    );

    // {{ifEquals a b}} — conditional equality check
    Handlebars.registerHelper(
      'ifEquals',
      function (a: any, b: any, options: any) {
        return a === b ? options.fn(this) : options.inverse(this);
      },
    );
  }

  private async loadTranslations(): Promise<void> {
    // In production, load from JSON files, a CMS, or a translations table
    this.translations = {
      en: {
        'booking.confirmed.title': 'Booking Confirmed',
        'booking.confirmed.greeting': 'Great news, {{userName}}!',
        'booking.confirmed.details': 'Your stay at {{hotelName}} is confirmed.',
        'booking.confirmed.checkin': 'Check-in',
        'booking.confirmed.checkout': 'Check-out',
        'booking.confirmed.code': 'Confirmation Code',
        'booking.cancelled.title': 'Booking Cancelled',
        'booking.cancelled.greeting': 'We are sorry to see you cancel.',
        'booking.reminder.title': 'Check-in Tomorrow',
        'booking.reminder.body': 'Your stay at {{hotelName}} begins tomorrow!',
        'payment.refunded.title': 'Refund Processed',
        'common.support': 'Need help? Contact support@globalbooking.com',
      },
      es: {
        'booking.confirmed.title': 'Reserva Confirmada',
        'booking.confirmed.greeting': 'Buenas noticias, {{userName}}!',
        'booking.confirmed.details': 'Su estancia en {{hotelName}} esta confirmada.',
        'booking.confirmed.checkin': 'Llegada',
        'booking.confirmed.checkout': 'Salida',
        'booking.confirmed.code': 'Codigo de Confirmacion',
        'booking.cancelled.title': 'Reserva Cancelada',
        'booking.cancelled.greeting': 'Lamentamos su cancelacion.',
        'booking.reminder.title': 'Llegada Manana',
        'booking.reminder.body': 'Su estancia en {{hotelName}} comienza manana!',
        'payment.refunded.title': 'Reembolso Procesado',
        'common.support': 'Necesita ayuda? Contacte soporte@globalbooking.com',
      },
      ja: {
        'booking.confirmed.title': '予約確認',
        'booking.confirmed.greeting': '{{userName}}様、予約が確定しました。',
        'booking.confirmed.details': '{{hotelName}}でのご滞在が確認されました。',
        'booking.confirmed.checkin': 'チェックイン',
        'booking.confirmed.checkout': 'チェックアウト',
        'booking.confirmed.code': '確認コード',
        'booking.cancelled.title': '予約キャンセル',
        'booking.reminder.title': '明日チェックイン',
        'payment.refunded.title': '返金処理完了',
        'common.support': 'サポートが必要ですか？ support@globalbooking.com',
      },
    };
  }

  private async precompileTemplates(): Promise<void> {
    // Load all active templates from the database
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { isActive: true },
    });

    for (const template of templates) {
      const cacheKey = `${template.eventType}:${template.channel}:${template.locale}`;

      let source = template.bodyTemplate;

      // If this is an email template written in MJML, compile to HTML first
      if (template.channel === 'email' && source.includes('<mjml>')) {
        source = this.mjmlCompiler.compile(source);
      }

      // Compile the Handlebars template and cache it
      this.compiledTemplates.set(cacheKey, Handlebars.compile(source));
    }
  }

  /**
   * Render templates for all requested channels, with i18n.
   */
  async renderForChannels(
    eventType: string,
    channels: string[],
    data: Record<string, any>,
    locale: string = 'en',
  ): Promise<Record<string, RenderedContent>> {
    const results: Record<string, RenderedContent> = {};

    for (const channel of channels) {
      const cacheKey = `${eventType}:${channel}:${locale}`;

      // Try locale-specific template, fall back to English
      let compiled = this.compiledTemplates.get(cacheKey);
      if (!compiled) {
        const fallbackKey = `${eventType}:${channel}:en`;
        compiled = this.compiledTemplates.get(fallbackKey);
      }

      if (!compiled) {
        this.logger.warn(
          `No template found for ${cacheKey}, using generic fallback`,
        );
        compiled = Handlebars.compile(this.getGenericTemplate(channel));
      }

      // Inject locale into template context for the {{t}} helper
      const context = { ...data, _locale: locale };

      results[channel] = {
        recipientAddress: this.getRecipientAddress(channel, data),
        subject: this.renderSubject(eventType, locale, data),
        body: compiled(context),
        plainText: channel === 'email'
          ? this.stripHtml(compiled(context))
          : undefined,
        metadata: {
          eventType,
          userId: data.userId,
          bookingId: data.bookingId,
          deepLink: data.deepLink,
        },
      };
    }

    return results;
  }

  private renderSubject(
    eventType: string,
    locale: string,
    data: Record<string, any>,
  ): string {
    const subjectKey = `${eventType.replace('.', '.')}.title`;
    const subjectTemplate =
      this.translations[locale]?.[subjectKey] ||
      this.translations['en']?.[subjectKey] ||
      'Notification';

    // Subject lines can also contain Handlebars placeholders
    return Handlebars.compile(subjectTemplate)(data);
  }

  private getRecipientAddress(
    channel: string,
    data: Record<string, any>,
  ): string {
    switch (channel) {
      case 'email': return data.email;
      case 'sms': return data.phone;
      case 'push': return data.pushToken;
      case 'in_app': return data.userId;
      default: return '';
    }
  }

  private getGenericTemplate(channel: string): string {
    if (channel === 'sms') {
      return '{{subject}}: {{body}}';
    }
    if (channel === 'push') {
      return '{{body}}';
    }
    return '<p>{{body}}</p>';
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}
```

### Seeding Templates with Prisma

Here is how you insert templates into the database using Prisma Client, which the template service will then load and compile on startup:

```typescript
// prisma/seed-templates.ts — Run with: npx prisma db seed

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function seedTemplates() {
  const templates = [
    // ---- Booking Confirmation: Email (MJML) ----
    {
      id: 'booking-created-email-en',
      eventType: 'booking.created',
      channel: 'email',
      locale: 'en',
      subject: 'Booking Confirmed — {{confirmationCode}}',
      bodyTemplate: `<mjml>
  <mj-body background-color="#f4f4f4">
    <mj-section background-color="#1a73e8" padding="20px">
      <mj-column>
        <mj-text color="#ffffff" font-size="24px" align="center">
          {{t "booking.confirmed.title"}}
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" padding="30px">
      <mj-column>
        <mj-text font-size="18px">
          {{t "booking.confirmed.greeting"}}
        </mj-text>
        <mj-text>{{t "booking.confirmed.details"}}</mj-text>
        <mj-divider border-color="#e0e0e0" />
        <mj-text>
          <strong>{{t "booking.confirmed.checkin"}}:</strong>
          {{formatDate checkIn}}
        </mj-text>
        <mj-text>
          <strong>{{t "booking.confirmed.checkout"}}:</strong>
          {{formatDate checkOut}}
        </mj-text>
        <mj-text>
          <strong>{{t "booking.confirmed.code"}}:</strong>
          {{confirmationCode}}
        </mj-text>
        <mj-text>
          <strong>Total:</strong>
          {{formatCurrency totalAmount currency}} for
          {{nightCount}} {{pluralize nightCount "night" "nights"}}
        </mj-text>
        <mj-button background-color="#1a73e8"
                   href="{{appUrl}}/bookings/{{bookingId}}">
          View Booking Details
        </mj-button>
      </mj-column>
    </mj-section>
    <mj-section padding="10px">
      <mj-column>
        <mj-text font-size="12px" color="#888" align="center">
          {{t "common.support"}}
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
    },

    // ---- Booking Confirmation: SMS ----
    {
      id: 'booking-created-sms-en',
      eventType: 'booking.created',
      channel: 'sms',
      locale: 'en',
      subject: null,
      bodyTemplate:
        'Booking confirmed! {{hotelName}}, {{formatDate checkIn}} — ' +
        '{{formatDate checkOut}}. Code: {{confirmationCode}}',
    },

    // ---- Booking Confirmation: Push ----
    {
      id: 'booking-created-push-en',
      eventType: 'booking.created',
      channel: 'push',
      locale: 'en',
      subject: '{{t "booking.confirmed.title"}}',
      bodyTemplate:
        '{{hotelName}} — {{formatDate checkIn}} to {{formatDate checkOut}}',
    },

    // ---- Booking Confirmation: In-App ----
    {
      id: 'booking-created-inapp-en',
      eventType: 'booking.created',
      channel: 'in_app',
      locale: 'en',
      subject: '{{t "booking.confirmed.title"}}',
      bodyTemplate:
        'Your booking at {{hotelName}} ({{confirmationCode}}) is confirmed ' +
        'for {{formatDate checkIn}}.',
    },
  ];

  for (const template of templates) {
    await prisma.notificationTemplate.upsert({
      where: { id: template.id },
      create: template,
      update: template,
    });
  }

  console.log(`Seeded ${templates.length} notification templates.`);
}

seedTemplates()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

> **Common Mistake:** Embedding HTML directly in your TypeScript code instead of using a template engine. This seems faster initially, but within three months you will have booking confirmation emails in six languages with seasonal marketing banners, legal disclosures, and A/B-testable subject lines. At that point, every email change requires a code deployment. With database-stored Handlebars templates, your marketing team can update email copy through an admin panel without touching code or redeploying.

---
