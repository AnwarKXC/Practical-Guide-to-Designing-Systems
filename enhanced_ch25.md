# Chapter 25: Dead Letter Queue — Where Failed Messages Go

## The Conveyor Belt That Jams

In the last several chapters, you have seen Kafka at work. A booking is created, an event is published, and downstream consumers process that event -- updating search indexes, sending confirmation emails, triggering payment processing. When everything works, events flow smoothly from producer to consumer like packages on a conveyor belt.

But conveyor belts jam.

What happens when a consumer *cannot* process a message? Maybe the downstream database is temporarily unreachable. Maybe the message payload contains unexpected data -- a booking with a null user ID, a negative price, a check-in date in the year 1970. Maybe a new deployment introduced a serialization bug that crashes the consumer when it encounters a specific edge case. Maybe the payment gateway is returning 503 errors because *their* infrastructure is on fire.

In a simple Express app, when something goes wrong, you return a 500 error to the user and they try again. But Kafka consumers are not handling live HTTP requests. They are pulling messages off a topic and processing them in the background, autonomously, without a human waiting on the other end. If a consumer crashes while processing a message, what happens to that message?

Without a strategy, one of two unacceptable outcomes occurs:

1. **The message is lost.** The consumer committed its offset before processing finished, or the consumer group rebalances and moves past it. A real customer's booking confirmation email is never sent. A payment is never captured. A hotel is never notified of an incoming guest. Nobody knows until the customer calls support three days later asking why they have no reservation.

2. **The message blocks the entire pipeline.** The consumer encounters the bad message, throws an exception, restarts, pulls the same message again, throws again, restarts again -- an infinite death loop. Every message *behind* the poisonous one -- potentially thousands of perfectly valid bookings -- cannot be processed because they are stuck in line behind the one message that always fails. Your booking pipeline goes from processing 100,000 messages per minute to processing zero.

Neither outcome is acceptable at our scale. We need a third option: **quarantine the bad message, preserve it for investigation, and keep the pipeline moving.**

That third option is the Dead Letter Queue.

---

## The Dead Letter Queue Concept

> **Analogy:** Think of a post office. Most letters are deliverable -- they have a valid address, proper postage, and they reach the recipient. But some letters cannot be delivered. The address does not exist. The recipient moved. The postage is insufficient. The post office does not throw these letters in the trash, and it does not keep sending the same mail carrier to the same nonexistent address forever. Instead, undeliverable mail goes to a special department -- the **Dead Letter Office** -- where clerks inspect the letters, try to figure out what went wrong, and either fix the problem (forward to the new address) or return the letter to the sender. A Dead Letter Queue in Kafka works exactly the same way.

> **Key Term:** **Dead Letter Queue (DLQ)** -- A special Kafka topic (or message queue destination) where messages that cannot be successfully processed after multiple retry attempts are sent. Messages in the DLQ are preserved for inspection, debugging, and selective reprocessing. They represent real user actions that failed and need human or automated attention.

The DLQ is not a trash can. It is a triage ward. Every message in the DLQ represents a real customer action -- a booking someone tried to make, a payment someone tried to complete, a notification someone should have received. The DLQ preserves these messages so that once the root cause is fixed, they can be replayed and the original action can complete.

> **What If You Skip This?** Without a DLQ, failed messages either disappear silently (data loss) or loop forever (pipeline blockage). In a booking system handling 100,000 bookings per minute, even a 0.01% failure rate means 10 messages per minute entering the retry flow. Without proper DLQ handling, those 10 messages per minute compound into 600 per hour, then 14,400 per day -- each one a real customer whose booking was silently dropped. DLQs are the safety net that ensures no customer action silently vanishes.

---

## DLQ Topic Naming Conventions

Before writing a single line of code, you need a naming convention. When you have dozens of topics, each with its own retry chain and DLQ, naming discipline is the difference between organized operations and chaos.

Here is the convention we use in the Global Booking System:

```
Original topic:    booking-events
Retry topics:      booking-events.retry-1
                   booking-events.retry-2
                   booking-events.retry-3
DLQ topic:         booking-events.dlq

Original topic:    payment-events
Retry topics:      payment-events.retry-1
                   payment-events.retry-2
                   payment-events.retry-3
DLQ topic:         payment-events.dlq

Original topic:    notification-events
Retry topics:      notification-events.retry-1
                   notification-events.retry-2
                   notification-events.retry-3
DLQ topic:         notification-events.dlq
```

Notice the pattern: `{original-topic}.{suffix}`. The dot-separated suffix keeps everything organized. When you look at your Kafka cluster's topic list, all topics related to `booking-events` are grouped together alphabetically. You can instantly see which topics are primary, which are retries, and which are DLQs.

Here is the NestJS configuration for this naming scheme:

```typescript
// src/dlq/dlq.config.ts

export interface RetryLevelConfig {
  level: number;         // 1, 2, or 3
  delayMs: number;       // How long to wait before retrying
  maxAttempts: number;   // How many attempts at this level
}

export interface DLQConfig {
  /** The original topic name (e.g., 'booking-events') */
  originalTopic: string;

  /** Retry levels with graduated delays */
  retryLevels: RetryLevelConfig[];

  /** Consumer group ID for retry consumers */
  consumerGroupPrefix: string;

  /** Maximum message age in DLQ before auto-archival (ms) */
  dlqRetentionMs: number;

  /** Alert threshold: fire alert if DLQ exceeds this count */
  dlqAlertThreshold: number;
}

export const DEFAULT_DLQ_CONFIG: DLQConfig = {
  originalTopic: 'booking-events',
  retryLevels: [
    { level: 1, delayMs: 60_000, maxAttempts: 3 },      // retry-1: wait 1 minute
    { level: 2, delayMs: 300_000, maxAttempts: 2 },      // retry-2: wait 5 minutes
    { level: 3, delayMs: 1_800_000, maxAttempts: 1 },    // retry-3: wait 30 minutes
  ],
  consumerGroupPrefix: 'booking-service',
  dlqRetentionMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
  dlqAlertThreshold: 50,
};

/**
 * Generate topic names following our naming convention.
 *
 * getRetryTopic('booking-events', 1) => 'booking-events.retry-1'
 * getDLQTopic('booking-events')      => 'booking-events.dlq'
 */
export function getRetryTopic(originalTopic: string, level: number): string {
  return `${originalTopic}.retry-${level}`;
}

export function getDLQTopic(originalTopic: string): string {
  return `${originalTopic}.dlq`;
}

export function getAllTopicsForConfig(config: DLQConfig): string[] {
  const topics = [config.originalTopic];
  for (const level of config.retryLevels) {
    topics.push(getRetryTopic(config.originalTopic, level.level));
  }
  topics.push(getDLQTopic(config.originalTopic));
  return topics;
}
// getAllTopicsForConfig(DEFAULT_DLQ_CONFIG) returns:
// ['booking-events', 'booking-events.retry-1', 'booking-events.retry-2',
//  'booking-events.retry-3', 'booking-events.dlq']
```

> **Checkpoint:** Given the topic `payment-events`, what would the retry-2 topic be named? What about the DLQ topic? Answer: `payment-events.retry-2` and `payment-events.dlq`. If you got that right, the naming convention has clicked.

---

## The Retry Chain: Graduated Second Chances

Before a message lands in the DLQ, we give it multiple chances to succeed. But we do not retry immediately -- if the downstream service is overloaded, hammering it with instant retries makes the problem worse. Instead, we use **graduated delays**: each retry level waits longer than the last, giving transient problems time to resolve.

Here is the complete retry chain for our booking system:

```
  booking-events (main topic)
      |
      |  Consumer fails to process message
      |
      v
  booking-events.retry-1 ─── wait 1 minute, up to 3 attempts
      |
      |  All 3 attempts at this level failed
      |
      v
  booking-events.retry-2 ─── wait 5 minutes, up to 2 attempts
      |
      |  Both attempts failed
      |
      v
  booking-events.retry-3 ─── wait 30 minutes, 1 final attempt
      |
      |  STILL fails
      |
      v
  booking-events.dlq ─── Dead Letter Queue (needs investigation)
```

Why these specific delays? Think about what kinds of failures resolve at each timescale:

- **1 minute (retry-1, up to 3 attempts):** Network blips, momentary connection resets, a microservice that just restarted after a deployment. Most transient failures resolve within a minute. We give three attempts at this level because the vast majority of retriable failures are caught here -- in production, roughly 85% of retried messages succeed at retry-1.

- **5 minutes (retry-2, up to 2 attempts):** A database connection pool is exhausted. A downstream service is doing a rolling restart. A cloud provider is having a brief regional issue. These problems typically clear within five minutes. Two attempts here catch another 10% of failures.

- **30 minutes (retry-3, 1 final attempt):** A sustained outage. A payment gateway is down. A third-party API has a degraded service. If the message cannot be processed after 30 minutes of waiting, it is almost certainly not a transient failure -- something is genuinely wrong with this specific message or the downstream system needs human intervention.

After all retry levels are exhausted, a message that has failed **six total attempts** (3 + 2 + 1) across approximately 40 minutes of elapsed time lands in the DLQ. At this point, we are confident: this is not a transient failure. This message needs investigation.

> **Analogy:** Imagine you are trying to deliver a certified letter. You knock on the door -- nobody home. You come back in an hour (retry-1, attempt 1). Still nobody. You try twice more that afternoon (retry-1, attempts 2 and 3). Nobody. The next morning, you try twice more (retry-2). Still no answer. One final attempt the next day (retry-3). After six honest attempts spread over hours, the letter goes to the Dead Letter Office. You gave it a genuine effort, but at some point, you have to stop knocking and escalate.

---

## The NestJS DLQ Module: Architecture Overview

The DLQ system in NestJS consists of four key components:

1. **DLQModule** -- The NestJS module that wires everything together
2. **RetryService** -- Manages the retry chain, moving messages between retry levels
3. **DLQService** -- Handles messages that have exhausted all retries
4. **DLQAdminController** -- REST API for inspecting, replaying, and managing DLQ messages

Let us build each one.

```typescript
// src/dlq/dlq.module.ts

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { RetryService } from './retry.service';
import { DLQService } from './dlq.service';
import { DLQAdminController } from './dlq-admin.controller';
import { DLQRepository } from './dlq.repository';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'dlq-service',
            brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
            ssl: process.env.NODE_ENV === 'production',
            // In production, use SASL authentication
            ...(process.env.NODE_ENV === 'production' && {
              sasl: {
                mechanism: 'scram-sha-256',
                username: process.env.KAFKA_USERNAME,
                password: process.env.KAFKA_PASSWORD,
              },
            }),
          },
          producer: {
            allowAutoTopicCreation: false,
            //                      ^^^^^ IMPORTANT: In production, never auto-create
            //                      topics. Create them explicitly with proper partition
            //                      counts and replication factors.
          },
        },
      },
    ]),
  ],
  controllers: [DLQAdminController],
  providers: [RetryService, DLQService, DLQRepository],
  exports: [RetryService, DLQService],
})
export class DLQModule {}
```

> **Key Term:** **Poison Message (Poisonous Message)** -- A message that causes the consumer to fail every time it is processed, regardless of how many times it is retried. Unlike transient failures (where the message is fine but the downstream system is temporarily unavailable), a poison message has something fundamentally wrong with its content -- malformed data, a reference to a deleted entity, a schema mismatch. Poison messages are the primary reason DLQs exist: they must be removed from the processing pipeline before they block everything else.

---

## The Retry Service: Moving Messages Through the Chain

The `RetryService` is the heart of the retry mechanism. When a consumer fails to process a message, it calls `RetryService.handleFailure()`, which decides whether to retry the message at the current level, escalate to the next level, or send it to the DLQ.

```typescript
// src/dlq/retry.service.ts

import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { DLQService } from './dlq.service';
import {
  DLQConfig,
  DEFAULT_DLQ_CONFIG,
  getRetryTopic,
  getDLQTopic,
} from './dlq.config';
import * as promClient from 'prom-client';

/** Metadata attached to every message in the retry chain */
export interface RetryEnvelope {
  originalTopic: string;
  originalKey: string | null;
  originalPayload: any;
  retryLevel: number;
  attemptAtThisLevel: number;
  totalAttempts: number;
  errors: Array<{
    timestamp: string;
    message: string;
    stack?: string;
    serviceName: string;
    retryLevel: number;
    attempt: number;
  }>;
  firstFailedAt: string;
  lastFailedAt: string;
  messageId: string;         // UUID for tracking across the chain
  correlationId?: string;    // Links back to the original booking/payment
}

@Injectable()
export class RetryService implements OnModuleInit {
  private readonly logger = new Logger(RetryService.name);
  private readonly configs: Map<string, DLQConfig> = new Map();

  // Prometheus metrics for monitoring retries
  private readonly retryCounter = new promClient.Counter({
    name: 'dlq_retry_messages_total',
    help: 'Total messages sent to retry topics',
    labelNames: ['original_topic', 'retry_level'],
  });

  private readonly retrySuccessCounter = new promClient.Counter({
    name: 'dlq_retry_success_total',
    help: 'Messages successfully processed on retry',
    labelNames: ['original_topic', 'retry_level'],
  });

  constructor(
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka,
    private readonly dlqService: DLQService,
  ) {}

  async onModuleInit() {
    await this.kafkaClient.connect();
  }

  /** Register a topic for DLQ handling */
  registerTopic(config: DLQConfig): void {
    this.configs.set(config.originalTopic, config);
    this.logger.log(
      `Registered DLQ config for topic: ${config.originalTopic} ` +
      `(${config.retryLevels.length} retry levels)`,
    );
  }

  /**
   * Handle a failed message. This is the method consumers call when
   * they cannot process a message.
   *
   * @param originalTopic - The topic the message originally came from
   * @param key           - The Kafka message key (used for partition ordering)
   * @param payload       - The original message payload
   * @param error         - The error that occurred during processing
   * @param envelope      - Existing retry envelope (if this is already a retry)
   */
  async handleFailure(
    originalTopic: string,
    key: string | null,
    payload: any,
    error: Error,
    envelope?: RetryEnvelope,
  ): Promise<void> {
    const config = this.configs.get(originalTopic) || DEFAULT_DLQ_CONFIG;
    const now = new Date().toISOString();
    const serviceName = process.env.SERVICE_NAME || 'unknown';

    // Build or update the retry envelope
    const currentEnvelope: RetryEnvelope = envelope
      ? {
          ...envelope,
          totalAttempts: envelope.totalAttempts + 1,
          lastFailedAt: now,
          errors: [
            ...envelope.errors,
            {
              timestamp: now,
              message: error.message,
              stack: error.stack,
              serviceName,
              retryLevel: envelope.retryLevel,
              attempt: envelope.attemptAtThisLevel + 1,
            },
          ],
        }
      : {
          // First failure -- create a new envelope
          originalTopic,
          originalKey: key,
          originalPayload: payload,
          retryLevel: 1,
          attemptAtThisLevel: 0,
          totalAttempts: 1,
          errors: [
            {
              timestamp: now,
              message: error.message,
              stack: error.stack,
              serviceName,
              retryLevel: 0,
              attempt: 1,
            },
          ],
          firstFailedAt: now,
          lastFailedAt: now,
          messageId: crypto.randomUUID(),
          correlationId: payload?.bookingId || payload?.correlationId,
        };

    // Determine where this message should go next
    const currentLevel = config.retryLevels.find(
      (l) => l.level === currentEnvelope.retryLevel,
    );

    if (!currentLevel) {
      // No more retry levels. Send to DLQ.
      await this.dlqService.sendToDLQ(currentEnvelope);
      return;
    }

    // Have we exhausted attempts at this level?
    if (currentEnvelope.attemptAtThisLevel >= currentLevel.maxAttempts) {
      // Move to the next retry level
      const nextLevel = config.retryLevels.find(
        (l) => l.level === currentEnvelope.retryLevel + 1,
      );

      if (!nextLevel) {
        // No more retry levels. Send to DLQ.
        await this.dlqService.sendToDLQ(currentEnvelope);
        return;
      }

      // Escalate to the next level
      currentEnvelope.retryLevel = nextLevel.level;
      currentEnvelope.attemptAtThisLevel = 0;
    }

    // Send to the appropriate retry topic
    const retryTopic = getRetryTopic(
      originalTopic,
      currentEnvelope.retryLevel,
    );
    const retryDelay = config.retryLevels.find(
      (l) => l.level === currentEnvelope.retryLevel,
    )!.delayMs;

    currentEnvelope.attemptAtThisLevel += 1;

    this.kafkaClient.emit(retryTopic, {
      key: key,
      value: JSON.stringify({
        envelope: currentEnvelope,
        scheduledFor: Date.now() + retryDelay,
        //            ^^^^^^^^^^^^^^^^^^^^^^^^^^ The retry consumer will check
        //            this timestamp. If the current time is before scheduledFor,
        //            the consumer waits before processing.
      }),
      headers: {
        'x-retry-level': currentEnvelope.retryLevel.toString(),
        'x-attempt': currentEnvelope.attemptAtThisLevel.toString(),
        'x-total-attempts': currentEnvelope.totalAttempts.toString(),
        'x-original-topic': originalTopic,
        'x-message-id': currentEnvelope.messageId,
        'x-error-type': error.constructor.name,
        'x-first-failed-at': currentEnvelope.firstFailedAt,
      },
    });

    // Track the retry metric
    this.retryCounter.inc({
      original_topic: originalTopic,
      retry_level: currentEnvelope.retryLevel.toString(),
    });

    this.logger.warn(
      `Message ${currentEnvelope.messageId} sent to ${retryTopic} ` +
      `(attempt ${currentEnvelope.attemptAtThisLevel} at level ` +
      `${currentEnvelope.retryLevel}, total attempts: ` +
      `${currentEnvelope.totalAttempts}). Error: ${error.message}`,
    );
  }

  /** Record a successful retry (for metrics tracking) */
  recordRetrySuccess(originalTopic: string, retryLevel: number): void {
    this.retrySuccessCounter.inc({
      original_topic: originalTopic,
      retry_level: retryLevel.toString(),
    });
  }
}
```

Let us trace through a concrete example. A `booking.created` event is published. The Notification Service tries to send a confirmation email but the email provider (SendGrid) is returning 503 errors:

1. **First attempt (main topic):** The Notification Service pulls the message from `booking-events`. It tries to call SendGrid. SendGrid returns 503. The consumer calls `retryService.handleFailure('booking-events', key, payload, error)`. A new `RetryEnvelope` is created with `retryLevel: 1`, `attemptAtThisLevel: 1`. The message is sent to `booking-events.retry-1`.

2. **Retry-1, attempt 1:** After waiting 1 minute, the retry consumer pulls the message from `booking-events.retry-1`. It tries SendGrid again. Still 503. `handleFailure` is called again with the existing envelope. `attemptAtThisLevel` becomes 2. The message goes back to `booking-events.retry-1`.

3. **Retry-1, attempt 2:** Another minute passes. The consumer tries again. Still failing. `attemptAtThisLevel` becomes 3. Back to `booking-events.retry-1`.

4. **Retry-1, attempt 3:** One more minute. Fails again. Now `attemptAtThisLevel` (3) equals `maxAttempts` (3) for retry-1. The message **escalates** to `booking-events.retry-2` with `retryLevel: 2`, `attemptAtThisLevel: 1`.

5. **Retry-2, attempt 1:** After waiting 5 minutes, the retry-2 consumer tries. Still failing. `attemptAtThisLevel` becomes 2.

6. **Retry-2, attempt 2:** Another 5 minutes. Fails again. `attemptAtThisLevel` (2) equals `maxAttempts` (2) for retry-2. Escalate to `booking-events.retry-3`.

7. **Retry-3, attempt 1 (FINAL):** After waiting 30 minutes, the retry-3 consumer makes one last attempt. If SendGrid is back, the email is sent and the chain ends. If it still fails, the message has exhausted all retry levels. It goes to `booking-events.dlq`.

Total elapsed time: approximately 3 minutes (retry-1) + 10 minutes (retry-2) + 30 minutes (retry-3) = **43 minutes** with **6 total attempts** before a message reaches the DLQ.

> **Checkpoint:** If a message fails at retry-1 on all three attempts but succeeds on the first attempt at retry-2, how many total attempts did it take? Answer: 4 (1 original + 3 at retry-1 + 1 at retry-2 -- wait, that is 5). Actually, the first failure is on the main topic, then 3 failures at retry-1 (attempts 1, 2, 3), then success at retry-2 (attempt 1). That is 5 total processing attempts: 1 original + 3 retry-1 + 1 retry-2. The `totalAttempts` field in the envelope would read 5.

---

## The DLQ Service: Final Destination for Failed Messages

When a message exhausts all retry levels, the `DLQService` does two things: it publishes the message to the DLQ Kafka topic (so other systems can react to the failure), and it persists the message to a PostgreSQL table (so operators can query, inspect, and replay failed messages through the admin API).

Why both Kafka *and* a database? Because they serve different purposes. The Kafka DLQ topic enables real-time alerting -- a monitoring consumer watches the DLQ topic and fires PagerDuty alerts when messages arrive. The database table enables operational workflows -- an engineer can query "show me all DLQ messages from the last 24 hours where the error contains 'connection refused'," then replay them in bulk once the connectivity issue is resolved.

### The Prisma Schema for DLQ Tracking

First, let us define the database schema. Every DLQ message gets a row in the `dlq_messages` table:

```prisma
// prisma/schema.prisma (add to your existing schema)

model DlqMessage {
  id               String          @id @default(uuid()) @db.Uuid
  messageId        String          @unique @map("message_id")
  originalTopic    String          @map("original_topic")
  originalKey      String?         @map("original_key")
  originalPayload  Json            @map("original_payload")
  correlationId    String?         @map("correlation_id")

  // Retry tracking
  retryLevel       Int             @map("retry_level")
  totalAttempts    Int             @map("total_attempts")
  errors           Json            @map("errors")  // Array of error objects

  // Timestamps
  firstFailedAt    DateTime        @map("first_failed_at")
  lastFailedAt     DateTime        @map("last_failed_at")
  arrivedInDlqAt   DateTime        @default(now()) @map("arrived_in_dlq_at")

  // DLQ management
  status           DlqMessageStatus @default(UNPROCESSED)
  replayedAt       DateTime?       @map("replayed_at")
  replayedBy       String?         @map("replayed_by")
  resolution       String?         // Human-entered resolution notes
  category         DlqCategory?    // Categorization of the failure

  // Indexes for operational queries
  @@index([originalTopic, status])
  @@index([correlationId])
  @@index([arrivedInDlqAt])
  @@index([status, arrivedInDlqAt])
  @@index([category])

  @@map("dlq_messages")
}

enum DlqMessageStatus {
  UNPROCESSED      // Just arrived, nobody has looked at it
  INVESTIGATING    // An engineer is examining it
  REPLAYED         // Message was replayed back to the original topic
  DISCARDED        // Message was intentionally discarded (e.g., duplicate)
  RESOLVED         // Root cause identified and fixed, no replay needed

  @@map("dlq_message_status")
}

enum DlqCategory {
  TRANSIENT_FAILURE     // Downstream timeout, connection error
  POISON_MESSAGE        // Malformed data, schema mismatch
  BUSINESS_RULE         // Valid format but violates business logic
  DEPENDENCY_OUTAGE     // Extended third-party outage
  BUG                   // Application code bug
  UNKNOWN               // Not yet categorized

  @@map("dlq_category")
}
```

> **Mentor Note:** Notice that the `errors` column is typed as `Json`, not as a separate relation. We chose this deliberately. The error history is write-once, read-many data that is always accessed in the context of a single DLQ message. Normalizing it into a separate table would add join overhead for zero practical benefit. Prisma handles JSON columns well on PostgreSQL, and you can even filter on JSON fields when needed.

Here is the raw SQL migration for reference, followed by the equivalent Prisma commands:

```sql
-- Raw SQL (for reference only -- use Prisma migrations in practice)
CREATE TYPE dlq_message_status AS ENUM (
  'UNPROCESSED', 'INVESTIGATING', 'REPLAYED', 'DISCARDED', 'RESOLVED'
);

CREATE TYPE dlq_category AS ENUM (
  'TRANSIENT_FAILURE', 'POISON_MESSAGE', 'BUSINESS_RULE',
  'DEPENDENCY_OUTAGE', 'BUG', 'UNKNOWN'
);

CREATE TABLE dlq_messages (
  id                CHAR(36) PRIMARY KEY -- UUID generated by application,
  message_id        TEXT NOT NULL UNIQUE,
  original_topic    TEXT NOT NULL,
  original_key      TEXT,
  original_payload  JSON NOT NULL,
  correlation_id    TEXT,
  retry_level       INTEGER NOT NULL,
  total_attempts    INTEGER NOT NULL,
  errors            JSON NOT NULL,
  first_failed_at   DATETIME(6) NOT NULL,
  last_failed_at    DATETIME(6) NOT NULL,
  arrived_in_dlq_at DATETIME(6) NOT NULL DEFAULT NOW(6),
  status            dlq_message_status NOT NULL DEFAULT 'UNPROCESSED',
  replayed_at       DATETIME(6),
  replayed_by       TEXT,
  resolution        TEXT,
  category          dlq_category
);

CREATE INDEX idx_dlq_messages_topic_status ON dlq_messages (original_topic, status);
CREATE INDEX idx_dlq_messages_correlation ON dlq_messages (correlation_id);
CREATE INDEX idx_dlq_messages_arrived ON dlq_messages (arrived_in_dlq_at);
CREATE INDEX idx_dlq_messages_status_arrived ON dlq_messages (status, arrived_in_dlq_at);
CREATE INDEX idx_dlq_messages_category ON dlq_messages (category);
```

The Prisma Client code to create, query, and update DLQ messages:

```typescript
// Prisma Client equivalents for the raw SQL operations above

// INSERT INTO dlq_messages (message_id, original_topic, ...) VALUES (...)
const dlqRecord = await prisma.dlqMessage.create({
  data: {
    messageId: envelope.messageId,
    originalTopic: envelope.originalTopic,
    originalKey: envelope.originalKey,
    originalPayload: envelope.originalPayload,
    correlationId: envelope.correlationId,
    retryLevel: envelope.retryLevel,
    totalAttempts: envelope.totalAttempts,
    errors: envelope.errors,
    firstFailedAt: new Date(envelope.firstFailedAt),
    lastFailedAt: new Date(envelope.lastFailedAt),
    status: 'UNPROCESSED',
  },
});

// SELECT * FROM dlq_messages WHERE original_topic = 'booking-events'
//   AND status = 'UNPROCESSED' ORDER BY arrived_in_dlq_at DESC LIMIT 50
const unprocessedMessages = await prisma.dlqMessage.findMany({
  where: {
    originalTopic: 'booking-events',
    status: 'UNPROCESSED',
  },
  orderBy: { arrivedInDlqAt: 'desc' },
  take: 50,
});

// UPDATE dlq_messages SET status = 'REPLAYED', replayed_at = NOW(),
//   replayed_by = 'engineer@company.com' WHERE id = $1
const replayed = await prisma.dlqMessage.update({
  where: { id: dlqMessageId },
  data: {
    status: 'REPLAYED',
    replayedAt: new Date(),
    replayedBy: operatorEmail,
  },
});
```

### The DLQ Service Implementation

Now the service that uses this schema:

```typescript
// src/dlq/dlq.service.ts

import { Injectable, Inject, Logger } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { DLQRepository } from './dlq.repository';
import { RetryEnvelope } from './retry.service';
import { getDLQTopic } from './dlq.config';
import * as promClient from 'prom-client';

@Injectable()
export class DLQService {
  private readonly logger = new Logger(DLQService.name);

  private readonly dlqCounter = new promClient.Counter({
    name: 'dlq_messages_total',
    help: 'Total messages sent to DLQ',
    labelNames: ['original_topic'],
  });

  private readonly dlqGauge = new promClient.Gauge({
    name: 'dlq_unprocessed_messages',
    help: 'Number of unprocessed messages in DLQ',
    labelNames: ['original_topic'],
  });

  constructor(
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka,
    private readonly repository: DLQRepository,
  ) {}

  /**
   * Send a message to the Dead Letter Queue.
   * This is called by RetryService when all retries are exhausted.
   */
  async sendToDLQ(envelope: RetryEnvelope): Promise<void> {
    const dlqTopic = getDLQTopic(envelope.originalTopic);

    // 1. Publish to the Kafka DLQ topic (for real-time alerting)
    this.kafkaClient.emit(dlqTopic, {
      key: envelope.originalKey,
      value: JSON.stringify(envelope),
      headers: {
        'x-message-id': envelope.messageId,
        'x-original-topic': envelope.originalTopic,
        'x-total-attempts': envelope.totalAttempts.toString(),
        'x-first-failed-at': envelope.firstFailedAt,
        'x-last-failed-at': envelope.lastFailedAt,
        'x-error-count': envelope.errors.length.toString(),
        'x-last-error': envelope.errors.at(-1)?.message || 'unknown',
      },
    });

    // 2. Persist to the database (for admin UI and operational queries)
    await this.repository.create(envelope);

    // 3. Update Prometheus metrics
    this.dlqCounter.inc({ original_topic: envelope.originalTopic });
    const unprocessedCount = await this.repository.countByStatus(
      envelope.originalTopic,
      'UNPROCESSED',
    );
    this.dlqGauge.set(
      { original_topic: envelope.originalTopic },
      unprocessedCount,
    );

    // 4. Log with high severity
    this.logger.error(
      `MESSAGE SENT TO DLQ: ${envelope.messageId} ` +
      `(topic: ${envelope.originalTopic}, ` +
      `attempts: ${envelope.totalAttempts}, ` +
      `correlation: ${envelope.correlationId || 'none'}, ` +
      `last error: ${envelope.errors.at(-1)?.message})`,
    );
  }
}
```

### The DLQ Repository

The repository encapsulates all Prisma interactions for DLQ messages:

```typescript
// src/dlq/dlq.repository.ts

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RetryEnvelope } from './retry.service';
import { DlqMessageStatus, DlqCategory, Prisma } from '@prisma/client';

export interface DLQQueryFilters {
  topic?: string;
  status?: DlqMessageStatus;
  category?: DlqCategory;
  correlationId?: string;
  fromDate?: Date;
  toDate?: Date;
}

@Injectable()
export class DLQRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(envelope: RetryEnvelope) {
    return this.prisma.dlqMessage.create({
      data: {
        messageId: envelope.messageId,
        originalTopic: envelope.originalTopic,
        originalKey: envelope.originalKey,
        originalPayload: envelope.originalPayload as Prisma.InputJsonValue,
        correlationId: envelope.correlationId,
        retryLevel: envelope.retryLevel,
        totalAttempts: envelope.totalAttempts,
        errors: envelope.errors as unknown as Prisma.InputJsonValue,
        firstFailedAt: new Date(envelope.firstFailedAt),
        lastFailedAt: new Date(envelope.lastFailedAt),
      },
    });
  }

  async findById(id: string) {
    return this.prisma.dlqMessage.findUnique({ where: { id } });
  }

  async findByMessageId(messageId: string) {
    return this.prisma.dlqMessage.findUnique({ where: { messageId } });
  }

  async findMany(filters: DLQQueryFilters, skip = 0, take = 50) {
    const where: Prisma.DlqMessageWhereInput = {};

    if (filters.topic) where.originalTopic = filters.topic;
    if (filters.status) where.status = filters.status;
    if (filters.category) where.category = filters.category;
    if (filters.correlationId) where.correlationId = filters.correlationId;
    if (filters.fromDate || filters.toDate) {
      where.arrivedInDlqAt = {};
      if (filters.fromDate) where.arrivedInDlqAt.gte = filters.fromDate;
      if (filters.toDate) where.arrivedInDlqAt.lte = filters.toDate;
    }

    const [data, total] = await Promise.all([
      this.prisma.dlqMessage.findMany({
        where,
        orderBy: { arrivedInDlqAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.dlqMessage.count({ where }),
    ]);

    return { data, total, skip, take };
  }

  async countByStatus(topic: string, status: DlqMessageStatus) {
    return this.prisma.dlqMessage.count({
      where: { originalTopic: topic, status },
    });
  }

  async updateStatus(
    id: string,
    status: DlqMessageStatus,
    extra?: { replayedBy?: string; resolution?: string; category?: DlqCategory },
  ) {
    return this.prisma.dlqMessage.update({
      where: { id },
      data: {
        status,
        ...(status === 'REPLAYED' && { replayedAt: new Date() }),
        ...extra,
      },
    });
  }

  /**
   * Get a summary of DLQ messages grouped by topic and status.
   * This powers the admin dashboard.
   */
  async getSummary() {
    // Raw SQL for the aggregation (Prisma groupBy equivalent follows)
    // SELECT original_topic, status, COUNT(*) as count
    //   FROM dlq_messages GROUP BY original_topic, status
    //   ORDER BY original_topic, status;
    return this.prisma.dlqMessage.groupBy({
      by: ['originalTopic', 'status'],
      _count: { _all: true },
      orderBy: [
        { originalTopic: 'asc' },
        { status: 'asc' },
      ],
    });
  }

  /**
   * Get category breakdown for a specific topic.
   * Helps identify whether failures are transient or structural.
   */
  async getCategoryBreakdown(topic: string) {
    // SELECT category, COUNT(*) as count FROM dlq_messages
    //   WHERE original_topic = $1 GROUP BY category;
    return this.prisma.dlqMessage.groupBy({
      by: ['category'],
      where: { originalTopic: topic },
      _count: { _all: true },
    });
  }
}
```

> **Checkpoint:** Why do we store DLQ messages in *both* Kafka and PostgreSQL? Could we skip one? You could skip the Kafka DLQ topic if you do not need real-time stream-based monitoring or downstream consumers reacting to failures. You could skip the database if you do not need query-based inspection or an admin UI. In practice, most production systems benefit from both: Kafka for event-driven alerting, PostgreSQL for operational tooling.

---

## Monitoring DLQ Depth: The Canary in the Coal Mine

A DLQ that nobody watches is worse than no DLQ at all. It gives you a false sense of safety -- "we have a DLQ, failed messages are being captured" -- while thousands of unprocessed customer actions silently pile up. The DLQ depth (number of unprocessed messages) is one of the most critical operational metrics in an event-driven system.

> **Analogy:** Your DLQ is like a hospital emergency room waiting area. A few people waiting is normal -- there are always some edge cases. But if the waiting room is overflowing and nobody is triaging patients, you have a systemic crisis. DLQ depth monitoring is the triage nurse who says "we have 200 people waiting -- something is very wrong, call in more staff."

Here is how we set up DLQ monitoring with Prometheus and Grafana:

```typescript
// src/dlq/dlq-monitor.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DLQRepository } from './dlq.repository';
import { DEFAULT_DLQ_CONFIG, DLQConfig } from './dlq.config';
import * as promClient from 'prom-client';

interface AlertChannel {
  send(message: string, severity: 'warning' | 'critical'): Promise<void>;
}

@Injectable()
export class DLQMonitorService implements OnModuleInit {
  private readonly logger = new Logger(DLQMonitorService.name);
  private readonly configs: DLQConfig[] = [DEFAULT_DLQ_CONFIG];

  private readonly dlqDepthGauge = new promClient.Gauge({
    name: 'dlq_depth_total',
    help: 'Total unprocessed messages in DLQ by topic',
    labelNames: ['topic'],
  });

  private readonly dlqAgeGauge = new promClient.Gauge({
    name: 'dlq_oldest_message_age_seconds',
    help: 'Age of the oldest unprocessed DLQ message in seconds',
    labelNames: ['topic'],
  });

  private readonly dlqRateGauge = new promClient.Gauge({
    name: 'dlq_arrival_rate_per_minute',
    help: 'Rate of new DLQ messages per minute (rolling 5-min window)',
    labelNames: ['topic'],
  });

  constructor(
    private readonly repository: DLQRepository,
    // In production, inject your alerting service (PagerDuty, Slack, etc.)
    // private readonly alertChannel: AlertChannel,
  ) {}

  async onModuleInit() {
    // Run an initial check on startup
    await this.checkDLQDepth();
  }

  /**
   * Check DLQ depth every 60 seconds.
   * This runs as a NestJS cron job.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async checkDLQDepth(): Promise<void> {
    for (const config of this.configs) {
      const topic = config.originalTopic;
      const unprocessedCount = await this.repository.countByStatus(
        topic,
        'UNPROCESSED',
      );

      // Update Prometheus gauge
      this.dlqDepthGauge.set({ topic }, unprocessedCount);

      // Check alert thresholds
      if (unprocessedCount >= config.dlqAlertThreshold * 2) {
        this.logger.error(
          `CRITICAL: DLQ depth for ${topic} is ${unprocessedCount} ` +
          `(threshold: ${config.dlqAlertThreshold}). ` +
          `Immediate investigation required.`,
        );
        // await this.alertChannel.send(
        //   `CRITICAL: DLQ for ${topic} has ${unprocessedCount} unprocessed messages`,
        //   'critical',
        // );
      } else if (unprocessedCount >= config.dlqAlertThreshold) {
        this.logger.warn(
          `WARNING: DLQ depth for ${topic} is ${unprocessedCount} ` +
          `(threshold: ${config.dlqAlertThreshold}). ` +
          `Review recommended.`,
        );
        // await this.alertChannel.send(
        //   `WARNING: DLQ for ${topic} has ${unprocessedCount} unprocessed messages`,
        //   'warning',
        // );
      }
    }
  }

  /**
   * Aggregate DLQ statistics for the monitoring dashboard.
   * Returns a snapshot of DLQ health across all tracked topics.
   */
  async getDashboardStats() {
    const summary = await this.repository.getSummary();
    const stats: Record<string, {
      unprocessed: number;
      investigating: number;
      replayed: number;
      discarded: number;
      resolved: number;
    }> = {};

    for (const row of summary) {
      if (!stats[row.originalTopic]) {
        stats[row.originalTopic] = {
          unprocessed: 0,
          investigating: 0,
          replayed: 0,
          discarded: 0,
          resolved: 0,
        };
      }
      const statusKey = row.status.toLowerCase() as keyof typeof stats[string];
      stats[row.originalTopic][statusKey] = row._count._all;
    }

    return stats;
  }
}
```

The Prometheus alerting rules that accompany this monitoring:

```yaml
# prometheus/alerts/dlq-alerts.yml

groups:
  - name: dlq_alerts
    rules:
      - alert: DLQDepthWarning
        expr: dlq_depth_total > 50
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DLQ depth elevated for {{ $labels.topic }}"
          description: >
            The DLQ for topic {{ $labels.topic }} has {{ $value }}
            unprocessed messages. This may indicate a downstream
            service issue. Check the DLQ admin dashboard.

      - alert: DLQDepthCritical
        expr: dlq_depth_total > 200
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "CRITICAL: DLQ overflow for {{ $labels.topic }}"
          description: >
            The DLQ for topic {{ $labels.topic }} has {{ $value }}
            unprocessed messages. This indicates a systemic failure.
            Investigate immediately.

      - alert: DLQRateSpike
        expr: rate(dlq_messages_total[5m]) > 1
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "DLQ message rate spiking for {{ $labels.topic }}"
          description: >
            More than 1 message per second is entering the DLQ for
            {{ $labels.topic }}. This likely indicates a deployment issue
            or a major downstream outage.

      - alert: DLQOldMessages
        expr: dlq_oldest_message_age_seconds > 86400
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Stale DLQ messages for {{ $labels.topic }}"
          description: >
            The oldest unprocessed DLQ message for {{ $labels.topic }}
            is {{ $value | humanizeDuration }} old. DLQ messages should
            be triaged within 24 hours.
```

> **What If You Skip This?** In 2024, a major ride-sharing company discovered that their DLQ had been silently accumulating driver payout messages for 11 days. Nobody was monitoring DLQ depth. Over 47,000 drivers were not paid on time. The fix took 20 minutes -- the root cause was a misconfigured database connection string in a new deployment. But the *damage* -- 47,000 angry drivers and a PR crisis -- took months to recover from. Monitor your DLQ depth. Set alerts. Treat a growing DLQ like a growing fire.

---

## Poison Pill Detection: Messages That Will Never Succeed

Not all DLQ messages are created equal. Some failed because of a transient problem -- a database was temporarily unavailable, a rate limit was hit, a network partition occurred. These messages will succeed if you replay them after the transient problem resolves.

But other messages are **poison pills**. They will *never* succeed, no matter how many times you retry them, because there is something fundamentally wrong with the data. Replaying a poison pill wastes resources and, worse, creates noise that obscures the legitimate transient failures that actually need attention.

> **Key Term:** **Poison Pill (Poison Message)** -- A message whose content is structurally or semantically invalid in a way that will cause processing to fail every single time. Examples: a booking with a `null` user ID, a payment with a negative amount, a JSON string that fails schema validation, a reference to an entity that has been permanently deleted. The distinguishing characteristic of a poison pill is that **no amount of waiting or retrying will fix it** -- the message itself must be corrected or discarded.

Here is a poison pill detector that analyzes DLQ messages and categorizes them:

```typescript
// src/dlq/poison-pill-detector.ts

import { Injectable, Logger } from '@nestjs/common';
import { DLQRepository } from './dlq.repository';
import { DlqCategory } from '@prisma/client';

interface PoisonPillRule {
  name: string;
  category: DlqCategory;
  /** Returns true if this message matches the poison pill pattern */
  detect: (payload: any, errors: any[]) => boolean;
}

@Injectable()
export class PoisonPillDetector {
  private readonly logger = new Logger(PoisonPillDetector.name);

  /** Rules for detecting known poison pill patterns */
  private readonly rules: PoisonPillRule[] = [
    {
      name: 'null-user-id',
      category: 'POISON_MESSAGE',
      detect: (payload) =>
        payload?.userId === null || payload?.userId === undefined,
    },
    {
      name: 'negative-amount',
      category: 'POISON_MESSAGE',
      detect: (payload) =>
        typeof payload?.amount === 'number' && payload.amount < 0,
    },
    {
      name: 'invalid-date',
      category: 'POISON_MESSAGE',
      detect: (payload) => {
        if (!payload?.checkInDate) return false;
        const date = new Date(payload.checkInDate);
        return isNaN(date.getTime()) || date.getFullYear() < 2000;
      },
    },
    {
      name: 'schema-validation-error',
      category: 'POISON_MESSAGE',
      detect: (_payload, errors) =>
        errors.some((e) =>
          /validation|schema|parse|deseriali/i.test(e.message),
        ),
    },
    {
      name: 'entity-not-found',
      category: 'POISON_MESSAGE',
      detect: (_payload, errors) =>
        errors.some((e) =>
          /not found|does not exist|no such/i.test(e.message),
        ),
    },
    {
      name: 'connection-error',
      category: 'TRANSIENT_FAILURE',
      detect: (_payload, errors) =>
        errors.some((e) =>
          /ECONNREFUSED|ETIMEDOUT|ECONNRESET|connection refused/i.test(
            e.message,
          ),
        ),
    },
    {
      name: 'rate-limited',
      category: 'TRANSIENT_FAILURE',
      detect: (_payload, errors) =>
        errors.some((e) =>
          /429|rate limit|too many requests|throttl/i.test(e.message),
        ),
    },
    {
      name: 'service-unavailable',
      category: 'DEPENDENCY_OUTAGE',
      detect: (_payload, errors) =>
        errors.some((e) =>
          /503|service unavailable|temporarily unavailable/i.test(e.message),
        ),
    },
  ];

  constructor(private readonly repository: DLQRepository) {}

  /**
   * Analyze a DLQ message and categorize it.
   * Returns the matched rule name and category, or null if no rule matches.
   */
  analyze(payload: any, errors: any[]): {
    ruleName: string;
    category: DlqCategory;
    isPoisonPill: boolean;
  } | null {
    for (const rule of this.rules) {
      if (rule.detect(payload, errors)) {
        return {
          ruleName: rule.name,
          category: rule.category,
          isPoisonPill: rule.category === 'POISON_MESSAGE',
        };
      }
    }
    return null;
  }

  /**
   * Run analysis on all uncategorized DLQ messages.
   * This can be triggered manually or on a schedule.
   */
  async analyzeUnprocessed(): Promise<{
    analyzed: number;
    poisonPills: number;
    transient: number;
    unknown: number;
  }> {
    const { data: messages } = await this.repository.findMany(
      { status: 'UNPROCESSED', category: undefined },
      0,
      500,
    );

    let poisonPills = 0;
    let transient = 0;
    let unknown = 0;

    for (const msg of messages) {
      const result = this.analyze(
        msg.originalPayload,
        msg.errors as any[],
      );

      if (result) {
        await this.repository.updateStatus(msg.id, 'UNPROCESSED', {
          category: result.category,
        });

        if (result.isPoisonPill) {
          poisonPills++;
          this.logger.warn(
            `Poison pill detected: ${msg.messageId} ` +
            `(rule: ${result.ruleName})`,
          );
        } else {
          transient++;
        }
      } else {
        await this.repository.updateStatus(msg.id, 'UNPROCESSED', {
          category: 'UNKNOWN',
        });
        unknown++;
      }
    }

    this.logger.log(
      `DLQ analysis complete: ${messages.length} messages analyzed. ` +
      `Poison pills: ${poisonPills}, Transient: ${transient}, ` +
      `Unknown: ${unknown}`,
    );

    return {
      analyzed: messages.length,
      poisonPills,
      transient,
      unknown,
    };
  }
}
```

> **Checkpoint:** A message with the error "TypeError: Cannot read properties of null (reading 'email')" is in the DLQ. Is it a poison pill or a transient failure? It is almost certainly a poison pill. The `null` reference means the message payload is missing expected data. No amount of retrying will make that data appear. The correct resolution is either to fix the upstream producer or to discard the message.

---

## The DLQ Consumer: Processing Retry Messages

The retry consumer is a dedicated NestJS microservice that listens to retry topics, waits for the scheduled delay, and re-attempts processing. If re-processing still fails, it feeds the message back into the `RetryService` which handles escalation or DLQ routing.

```typescript
// src/dlq/dlq-retry.consumer.ts

import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  KafkaContext,
  MessagePattern,
  Payload,
  Transport,
} from '@nestjs/microservices';
import { RetryService, RetryEnvelope } from './retry.service';
import { BookingProcessor } from '../booking/booking.processor';

@Controller()
export class DLQRetryConsumer {
  private readonly logger = new Logger(DLQRetryConsumer.name);

  constructor(
    private readonly retryService: RetryService,
    private readonly bookingProcessor: BookingProcessor,
  ) {}

  /**
   * Listen to all retry-level topics for booking-events.
   * Each @MessagePattern corresponds to one retry level.
   */
  @MessagePattern('booking-events.retry-1', Transport.KAFKA)
  async handleRetryLevel1(
    @Payload() message: { envelope: RetryEnvelope; scheduledFor: number },
    @Ctx() context: KafkaContext,
  ) {
    await this.processRetry(message, context, 1);
  }

  @MessagePattern('booking-events.retry-2', Transport.KAFKA)
  async handleRetryLevel2(
    @Payload() message: { envelope: RetryEnvelope; scheduledFor: number },
    @Ctx() context: KafkaContext,
  ) {
    await this.processRetry(message, context, 2);
  }

  @MessagePattern('booking-events.retry-3', Transport.KAFKA)
  async handleRetryLevel3(
    @Payload() message: { envelope: RetryEnvelope; scheduledFor: number },
    @Ctx() context: KafkaContext,
  ) {
    await this.processRetry(message, context, 3);
  }

  /**
   * Core retry processing logic.
   *
   * 1. Check if we need to wait (scheduled delay not yet elapsed)
   * 2. Re-attempt the original processing logic
   * 3. On success: commit offset, record metric
   * 4. On failure: feed back into RetryService for escalation
   */
  private async processRetry(
    message: { envelope: RetryEnvelope; scheduledFor: number },
    context: KafkaContext,
    level: number,
  ): Promise<void> {
    const { envelope, scheduledFor } = message;
    const now = Date.now();

    // Wait for the scheduled delay if it hasn't elapsed yet.
    // This is a simple approach; in production, you might use a
    // delay queue or Kafka's message timestamp to achieve this more
    // efficiently.
    if (now < scheduledFor) {
      const waitMs = scheduledFor - now;
      this.logger.debug(
        `Message ${envelope.messageId} scheduled for ` +
        `${new Date(scheduledFor).toISOString()}, ` +
        `waiting ${waitMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.logger.log(
      `Retry attempt: message ${envelope.messageId}, ` +
      `level ${level}, attempt ${envelope.attemptAtThisLevel} ` +
      `of total ${envelope.totalAttempts}`,
    );

    try {
      // Re-attempt the original processing.
      // The bookingProcessor.process() method is the same one that
      // the main consumer uses. We pass the ORIGINAL payload, not
      // the retry envelope.
      await this.bookingProcessor.process(envelope.originalPayload);

      // Success! Record the metric and let the offset commit.
      this.retryService.recordRetrySuccess(
        envelope.originalTopic,
        level,
      );

      this.logger.log(
        `Message ${envelope.messageId} successfully processed ` +
        `on retry (level ${level}, total attempts: ` +
        `${envelope.totalAttempts})`,
      );
    } catch (error) {
      // Still failing. Feed back into the retry chain.
      this.logger.warn(
        `Message ${envelope.messageId} failed again at ` +
        `level ${level}: ${error.message}`,
      );

      await this.retryService.handleFailure(
        envelope.originalTopic,
        envelope.originalKey,
        envelope.originalPayload,
        error as Error,
        envelope,
      );
    }
  }
}
```

> **Mentor Note:** The `setTimeout` approach for delay is simple but imperfect. In a production system at scale, you have two better options: (1) use Kafka headers with a `scheduledFor` timestamp and have the consumer check-and-pause if the message is not yet due, or (2) use a dedicated delay queue service (like a Redis-backed scheduler) that publishes to the retry topic only when the delay has elapsed. The `setTimeout` approach works for moderate throughput but ties up a consumer thread during the wait.

---

## The DLQ Admin Controller: Operational Tooling

The admin controller provides REST endpoints for engineers to inspect, categorize, replay, and discard DLQ messages. This is the operational dashboard backend -- the interface that an on-call engineer uses at 3 AM when PagerDuty fires a "DLQ depth critical" alert.

```typescript
// src/dlq/dlq-admin.controller.ts

import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Inject,
  Logger,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { DLQRepository, DLQQueryFilters } from './dlq.repository';
import { PoisonPillDetector } from './poison-pill-detector';
import { DLQMonitorService } from './dlq-monitor.service';
import { DlqMessageStatus, DlqCategory } from '@prisma/client';

@Controller('admin/dlq')
export class DLQAdminController {
  private readonly logger = new Logger(DLQAdminController.name);

  constructor(
    @Inject('KAFKA_CLIENT') private readonly kafkaClient: ClientKafka,
    private readonly repository: DLQRepository,
    private readonly poisonDetector: PoisonPillDetector,
    private readonly monitor: DLQMonitorService,
  ) {}

  /**
   * GET /admin/dlq/dashboard
   * Returns a summary of DLQ health across all topics.
   */
  @Get('dashboard')
  async getDashboard() {
    const [stats, summary] = await Promise.all([
      this.monitor.getDashboardStats(),
      this.repository.getSummary(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      topics: stats,
      rawSummary: summary,
    };
  }

  /**
   * GET /admin/dlq/messages?topic=booking-events&status=UNPROCESSED&skip=0&take=50
   * Paginated list of DLQ messages with filtering.
   */
  @Get('messages')
  async getMessages(
    @Query('topic') topic?: string,
    @Query('status') status?: DlqMessageStatus,
    @Query('category') category?: DlqCategory,
    @Query('correlationId') correlationId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    const filters: DLQQueryFilters = {
      topic,
      status,
      category,
      correlationId,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    };

    return this.repository.findMany(
      filters,
      parseInt(skip, 10),
      Math.min(parseInt(take, 10), 200),  // Cap at 200 per page
    );
  }

  /**
   * GET /admin/dlq/messages/:id
   * Detailed view of a single DLQ message, including full error history.
   */
  @Get('messages/:id')
  async getMessage(@Param('id', ParseUUIDPipe) id: string) {
    const message = await this.repository.findById(id);
    if (!message) {
      throw new BadRequestException(`DLQ message ${id} not found`);
    }

    // Run poison pill analysis on this specific message
    const analysis = this.poisonDetector.analyze(
      message.originalPayload,
      message.errors as any[],
    );

    return {
      ...message,
      analysis: analysis || { ruleName: 'none', category: 'UNKNOWN', isPoisonPill: false },
    };
  }

  /**
   * POST /admin/dlq/messages/:id/replay
   * Replay a single DLQ message back to its original topic.
   *
   * This is the most powerful and dangerous endpoint. It takes a message
   * that previously failed and sends it back to the beginning of the
   * pipeline for reprocessing. Only use this after fixing the root cause.
   */
  @Post('messages/:id/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  async replayMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('replayedBy') replayedBy: string,
  ) {
    if (!replayedBy) {
      throw new BadRequestException(
        'replayedBy is required (your email address)',
      );
    }

    const message = await this.repository.findById(id);
    if (!message) {
      throw new BadRequestException(`DLQ message ${id} not found`);
    }

    if (message.status === 'REPLAYED') {
      throw new BadRequestException(
        `Message ${id} was already replayed at ${message.replayedAt}`,
      );
    }

    // Publish the ORIGINAL payload back to the ORIGINAL topic
    this.kafkaClient.emit(message.originalTopic, {
      key: message.originalKey,
      value: JSON.stringify(message.originalPayload),
      headers: {
        'x-replayed-from-dlq': 'true',
        'x-dlq-message-id': message.messageId,
        'x-replayed-by': replayedBy,
        'x-replayed-at': new Date().toISOString(),
      },
    });

    // Update the DLQ record
    await this.repository.updateStatus(id, 'REPLAYED', { replayedBy });

    this.logger.log(
      `DLQ message ${message.messageId} replayed to ` +
      `${message.originalTopic} by ${replayedBy}`,
    );

    return {
      status: 'accepted',
      messageId: message.messageId,
      replayedTo: message.originalTopic,
      replayedBy,
      replayedAt: new Date().toISOString(),
    };
  }

  /**
   * POST /admin/dlq/replay-bulk
   * Replay multiple DLQ messages matching a filter.
   *
   * Use with extreme caution. This can flood the original topic if
   * the root cause has not been fixed yet.
   */
  @Post('replay-bulk')
  @HttpCode(HttpStatus.ACCEPTED)
  async replayBulk(
    @Body('topic') topic: string,
    @Body('category') category?: DlqCategory,
    @Body('replayedBy') replayedBy?: string,
    @Body('maxMessages') maxMessages = 100,
  ) {
    if (!topic || !replayedBy) {
      throw new BadRequestException('topic and replayedBy are required');
    }

    const filters: DLQQueryFilters = {
      topic,
      status: 'UNPROCESSED',
      category,
    };

    const { data: messages } = await this.repository.findMany(
      filters,
      0,
      Math.min(maxMessages, 500),  // Hard cap at 500 per bulk replay
    );

    let replayed = 0;
    let failed = 0;

    for (const msg of messages) {
      try {
        this.kafkaClient.emit(msg.originalTopic, {
          key: msg.originalKey,
          value: JSON.stringify(msg.originalPayload),
          headers: {
            'x-replayed-from-dlq': 'true',
            'x-dlq-message-id': msg.messageId,
            'x-replayed-by': replayedBy,
            'x-bulk-replay': 'true',
          },
        });

        await this.repository.updateStatus(msg.id, 'REPLAYED', {
          replayedBy,
        });
        replayed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to replay DLQ message ${msg.messageId}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Bulk replay complete: ${replayed} replayed, ${failed} failed ` +
      `(topic: ${topic}, by: ${replayedBy})`,
    );

    return { replayed, failed, total: messages.length };
  }

  /**
   * PATCH /admin/dlq/messages/:id
   * Update a DLQ message's status, category, or resolution notes.
   */
  @Patch('messages/:id')
  async updateMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('status') status?: DlqMessageStatus,
    @Body('category') category?: DlqCategory,
    @Body('resolution') resolution?: string,
  ) {
    const message = await this.repository.findById(id);
    if (!message) {
      throw new BadRequestException(`DLQ message ${id} not found`);
    }

    return this.repository.updateStatus(
      id,
      status || message.status,
      { category, resolution },
    );
  }

  /**
   * POST /admin/dlq/analyze
   * Run the poison pill detector on all uncategorized DLQ messages.
   */
  @Post('analyze')
  @HttpCode(HttpStatus.OK)
  async runAnalysis() {
    return this.poisonDetector.analyzeUnprocessed();
  }

  /**
   * GET /admin/dlq/categories/:topic
   * Get a breakdown of failure categories for a specific topic.
   */
  @Get('categories/:topic')
  async getCategoryBreakdown(@Param('topic') topic: string) {
    return this.repository.getCategoryBreakdown(topic);
  }
}
```

> **What If You Skip This?** Without admin tooling, replaying DLQ messages means writing ad-hoc scripts, manually producing messages to Kafka topics, and hoping you do not accidentally replay messages that have already been replayed. Admin tooling turns a stressful, error-prone manual process into a controlled, auditable operation. The `replayedBy` field alone has saved teams from finger-pointing during post-incident reviews.

---

## Production War Story: The Ghost Bookings

> **War Story:** At a large hotel booking platform, the team built a solid DLQ infrastructure. Messages that failed processing were captured, alerts were configured, and there was even a basic admin UI. Everything worked perfectly -- during normal operations.
>
> Then came Black Friday.
>
> The booking rate surged from 2,000 per minute to 18,000 per minute. The payment processing service, overwhelmed by the load, started returning timeouts. The retry chain did its job: messages flowed through retry-1, retry-2, and retry-3. Most succeeded on retry as the payment service recovered between surges. But 4,200 messages -- real customer bookings -- ended up in the DLQ over a four-hour window.
>
> Here is where the mistake happened: **nobody replayed the DLQ messages after the incident.**
>
> The on-call engineer acknowledged the PagerDuty alerts. The team investigated and confirmed the root cause (payment service overload) was resolved. They marked the incident as closed. But the 4,200 DLQ messages sat there, untouched, for 19 days.
>
> Each of those messages represented a customer who had selected a hotel room, entered their payment details, and clicked "Book Now." From the customer's perspective, the booking was confirmed -- the frontend had optimistically shown a confirmation page. But the backend had never completed the payment capture or the hotel notification. 4,200 customers arrived at hotels that had no record of their reservation.
>
> The fallout was severe. The company had to issue refunds, pay for alternative accommodations, and handle a wave of social media complaints. The total cost exceeded $2.3 million.
>
> **The fix was straightforward but the lesson was painful:**
>
> ```typescript
> // What they added after the incident:
>
> // 1. A daily DLQ audit job that runs every morning
> @Cron('0 8 * * *')  // 8 AM every day
> async dailyDLQAudit(): Promise<void> {
>   for (const config of this.configs) {
>     const count = await this.repository.countByStatus(
>       config.originalTopic,
>       'UNPROCESSED',
>     );
>
>     if (count > 0) {
>       // This alert cannot be silenced or auto-resolved.
>       // It requires a human to explicitly acknowledge AND
>       // either replay or discard every message.
>       await this.alertChannel.send(
>         `DAILY DLQ AUDIT: ${config.originalTopic} has ${count} ` +
>         `unprocessed messages. These represent real customer ` +
>         `actions that have not completed. Each message must be ` +
>         `explicitly replayed or discarded with a resolution note.`,
>         'critical',
>       );
>     }
>   }
> }
>
> // 2. A DLQ "age" metric that tracks how old the oldest message is
> // If any message sits unprocessed for more than 24 hours, fire a
> // critical alert that escalates to management.
>
> // 3. A mandatory post-incident checklist item:
> //    "Have all DLQ messages from this incident been replayed or
> //     explicitly discarded with resolution notes?"
> ```
>
> **The lesson:** A DLQ is not a "set and forget" system. It is an active triage queue that requires daily attention. Every message in the DLQ is a customer promise that was broken. Your incident is not over until the DLQ is empty.

---

## Common Mistakes with Dead Letter Queues

These are the mistakes we have seen teams make repeatedly. Each one has caused real production incidents in booking systems at scale.

### Mistake 1: Treating the DLQ as a Trash Can

```typescript
// WRONG: Sending messages to DLQ and forgetting about them
async handleFailure(message: any, error: Error): Promise<void> {
  await this.kafkaClient.emit('events.dlq', { value: message });
  // ...and that's it. No database record. No alert. No monitoring.
  // These messages will sit in Kafka until the retention period
  // expires and then silently vanish.
}

// RIGHT: DLQ messages are tracked, monitored, and require resolution
async handleFailure(message: any, error: Error): Promise<void> {
  // Persist to database for tracking
  await this.repository.create(envelope);
  // Publish to Kafka for real-time alerting
  await this.kafkaClient.emit('events.dlq', { value: envelope });
  // Increment monitoring metrics
  this.dlqCounter.inc({ original_topic: envelope.originalTopic });
  // Log at ERROR level for visibility
  this.logger.error(`Message ${envelope.messageId} sent to DLQ`);
}
```

### Mistake 2: Retrying Immediately and Aggressively

```typescript
// WRONG: Instant retries with no backoff
// This hammers a failing downstream service, making the outage worse
for (let i = 0; i < 10; i++) {
  try {
    await processMessage(message);
    return; // success
  } catch (error) {
    // Immediately try again -- no delay, no backoff
    continue;
  }
}

// RIGHT: Graduated delays with escalating wait times
// Retry-1: 1 minute delay, 3 attempts
// Retry-2: 5 minute delay, 2 attempts
// Retry-3: 30 minute delay, 1 attempt
// This gives transient failures time to resolve naturally
```

### Mistake 3: Replaying Without Fixing the Root Cause

```typescript
// WRONG: Blindly replaying all DLQ messages
@Post('replay-all')
async replayAll() {
  const messages = await this.repository.findMany(
    { status: 'UNPROCESSED' },
    0,
    10000,
  );
  for (const msg of messages) {
    this.kafkaClient.emit(msg.originalTopic, msg.originalPayload);
  }
  // If the root cause is not fixed, these messages will fail again,
  // re-enter the retry chain, and end up back in the DLQ.
  // Congratulations, you have created an infinite loop.
}

// RIGHT: Verify fix before replaying, replay in small batches,
// monitor the retry rate after replay
@Post('replay-verified')
async replayVerified(
  @Body('rootCauseFixed') rootCauseFixed: boolean,
  @Body('fixDescription') fixDescription: string,
  @Body('batchSize') batchSize: number,
) {
  if (!rootCauseFixed || !fixDescription) {
    throw new BadRequestException(
      'You must confirm the root cause is fixed and describe the fix',
    );
  }
  // Replay in small batches (e.g., 10 at a time)
  // Monitor retry metrics after each batch
  // Stop if messages start failing again
}
```

### Mistake 4: No Idempotency in the Consumer

```typescript
// WRONG: A consumer that creates duplicate records when replayed
async processBooking(event: BookingCreatedEvent): Promise<void> {
  await this.prisma.booking.create({
    data: { id: randomUUID(), ...event },
    //      ^^^^^^^^^^^^^^^^^^
    //      New ID every time -- replaying creates a duplicate booking!
  });
}

// RIGHT: Idempotent consumer using upsert
async processBooking(event: BookingCreatedEvent): Promise<void> {
  await this.prisma.booking.upsert({
    where: { bookingId: event.bookingId },
    //       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //       Use the event's natural key. Replaying the same event
    //       updates the existing record instead of creating a duplicate.
    create: { bookingId: event.bookingId, ...event },
    update: { ...event, updatedAt: new Date() },
  });
}
```

### Mistake 5: Not Preserving the Original Message

```typescript
// WRONG: Wrapping error info but losing the original payload
async sendToDLQ(error: Error, topic: string): Promise<void> {
  this.kafkaClient.emit(`${topic}.dlq`, {
    value: JSON.stringify({
      error: error.message,
      topic: topic,
      timestamp: new Date().toISOString(),
      // Where is the original message?! Without it, you cannot
      // replay. You cannot debug. You cannot do anything useful.
    }),
  });
}

// RIGHT: The RetryEnvelope preserves everything
// - originalPayload: the complete original message
// - originalTopic: where it came from
// - originalKey: the Kafka partition key
// - errors: full error history with timestamps and stack traces
// - correlationId: links back to the business entity
```

> **Mentor Note:** Of these five mistakes, Mistake 4 (no idempotency) is the most subtle and dangerous. Even teams with excellent DLQ infrastructure stumble here. Replaying a DLQ message should be a safe operation -- it should produce the same result regardless of how many times it runs. If your consumer is not idempotent, replaying DLQ messages can create duplicate bookings, duplicate payments, or duplicate notifications. Always design your consumers to be idempotent before building DLQ replay tooling.

---

## Chapter Summary

| Concept | What It Means | Why It Matters |
|---|---|---|
| **Dead Letter Queue (DLQ)** | A dedicated topic/table where messages that fail all retry attempts are preserved | Prevents data loss and pipeline blockage -- the two worst outcomes of message processing failures |
| **Retry Chain** | Graduated retry levels (retry-1, retry-2, retry-3) with increasing delays | Gives transient failures time to resolve without hammering downstream services |
| **RetryEnvelope** | Metadata wrapper that tracks retry level, attempt count, error history, and timestamps | Provides full observability into why a message failed and how many times it was retried |
| **Poison Pill** | A message that will never succeed regardless of retries due to invalid data | Must be detected and quarantined to prevent wasted retry cycles and DLQ noise |
| **DLQ Monitoring** | Prometheus metrics and alerting on DLQ depth, message age, and arrival rate | A DLQ without monitoring is a silent graveyard for customer actions |
| **DLQ Replay** | Admin API to republish failed messages back to the original topic after fixing root cause | Completes the recovery cycle -- ensures no customer action is permanently lost |
| **Idempotent Consumers** | Consumers that produce the same result regardless of how many times they process a message | Essential for safe DLQ replay -- without idempotency, replay creates duplicates |
| **Naming Convention** | `{topic}.retry-{N}` and `{topic}.dlq` pattern | Keeps topic organization clean and enables automated tooling |
| **DLQ Persistence** | Storing DLQ messages in both Kafka (streaming) and PostgreSQL (queryable) | Kafka enables real-time alerting; PostgreSQL enables operational queries and admin UI |
| **Daily DLQ Audit** | Scheduled job that alerts if any unprocessed messages remain | Prevents the "forgotten DLQ" anti-pattern that caused the Ghost Bookings incident |
| **Failure Categorization** | Automated classification of DLQ messages (transient, poison pill, dependency outage, bug) | Prioritizes triage -- transient failures should be replayed, poison pills should be discarded |
| **Bulk Replay** | Replaying multiple DLQ messages matching a filter in controlled batches | Recovers from sustained outages where hundreds or thousands of messages accumulated |

> **What is next?** In Chapter 26, we will tackle **Schema Evolution** -- what happens when the structure of your Kafka messages changes over time. If you add a new field to a booking event, how do you ensure that consumers running the old code can still process the new messages? And how do you ensure that DLQ messages from *before* the schema change can still be replayed *after* the change? Schema evolution is the long-term sustainability challenge that every event-driven system must face.
