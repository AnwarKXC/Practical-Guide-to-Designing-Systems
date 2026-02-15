# Chapter 31: Distributed Tracing — Following a Request Across Services

## Introduction: The Invisible Problem

You have built something impressive. Your Global Booking System processes 100,000 bookings per minute. It spans dozens of microservices: an API Gateway, an Auth Service, a Booking Service, an Inventory Service, a Payment Service, a Notification Service, and more. Each service has its own container, its own logs, its own lifecycle. The system works. Users are happy.

Then one morning, a user reports: "My booking took 47 seconds." Your SLA says 3 seconds. Something is terribly wrong --- but *where*? That single user click touched seven services. The request bounced between containers running on different nodes in different availability zones. Where did those 44 extra seconds go?

This is the question that distributed tracing answers. And in this chapter, you will learn not just *how* to set it up, but *why* every design decision matters, *what* patterns to follow in production, and *where* teams get burned when they skip the details.

---

## 31.1 The console.log Debugging Problem

### How Debugging Works in a Monolith

Think back to when you built your first Express or NestJS application as a single process. When something went wrong, your debugging workflow was straightforward:

1. Add `console.log('here 1')`, `console.log('here 2')`, `console.log('value:', someVariable)`.
2. Trigger the request.
3. Read the output top to bottom.
4. Find the line where the value is wrong or the log stops appearing.
5. Fix the bug. Remove the logs. Ship it.

This works because everything runs in one process. The logs appear in one terminal. The execution is sequential --- or at least, traceable within one call stack. You can follow the thread from start to finish.

```typescript
// Monolith debugging: simple and effective
async function createBooking(req, res) {
  console.log('[1] Received booking request', req.body);

  const user = await validateUser(req.headers.authorization);
  console.log('[2] User validated:', user.id);

  const available = await checkInventory(req.body.roomId, req.body.dates);
  console.log('[3] Availability check:', available);

  const payment = await processPayment(user, req.body.amount);
  console.log('[4] Payment result:', payment.status);

  const booking = await saveBooking(user, req.body, payment);
  console.log('[5] Booking saved:', booking.id);

  res.json(booking);
}
```

You run this, hit the endpoint, and see five log lines in order. If the process blows up between `[3]` and `[4]`, you know the payment processing is the problem. Total debugging time: two minutes.

### Why It Falls Apart in Microservices

Now picture the same flow in your distributed system. That single `createBooking` function has been decomposed into five independent services:

```
User clicks "Book Now"
    |
    v
[API Gateway]  -->  [Auth Service]  (validates JWT)
    |
    v
[Booking Service]  -->  [Inventory Service]  (checks room availability)
    |
    v
[Payment Service]  -->  [Stripe API]  (charges the card)
    |
    v
[Notification Service]  (sends confirmation email)
```

Each service runs in its own container. Each container writes logs to its own stdout. In Kubernetes, those logs might be spread across different nodes, collected by Fluentd, and shipped to different log streams. When the user reports a 47-second booking, here is what your actual debugging session looks like:

```bash
# Step 1: Check the API Gateway logs
kubectl logs -n production api-gateway-pod-7d8f9 --since=10m | grep "user-12345"
# Result: 200 request completed in 47.2s. But which downstream call was slow?

# Step 2: Check the Booking Service logs
kubectl logs -n production booking-svc-pod-3a2b1 --since=10m | grep "user-12345"
# Result: Nothing. The Booking Service logs by booking ID, not user ID.
# You don't know the booking ID yet because you're trying to FIND it.

# Step 3: Try a wider search in Booking Service
kubectl logs -n production booking-svc-pod-3a2b1 --since=10m | grep "slow\|timeout\|error"
# Result: 847 matches. Which one is yours?

# Step 4: Find the booking by timestamp correlation
kubectl logs -n production booking-svc-pod-3a2b1 --since=10m | grep "2026-02-15T09:14"
# Result: 23 bookings were created in that minute. You try each one.

# Step 5: Finally find it. Now check the Payment Service.
kubectl logs -n production payment-svc-pod-9c4e2 --since=10m | grep "txn-88201"
# Result: Payment completed in 340ms. Not the bottleneck.

# Step 6: Check the Inventory Service
kubectl logs -n production inventory-svc-pod-1f7a3 --since=10m | grep "inv-req-55012"
# Result: "Connection pool exhausted, waited 43s for available connection"
# FOUND IT. 45 minutes later.
```

Forty-five minutes to find a slow database connection pool. In a monolith, this would have taken two minutes.

> **Analogy:** Imagine you are a detective investigating a crime that happened across five different cities. Each city has its own police department, its own filing system, and its own case numbering scheme. No one shared information between departments. You have to fly to each city, walk into the records office, and manually search for clues --- and the clues use different ID numbers in each city. Distributed tracing is like giving every detective a single case file number that works everywhere. One number, one search, complete picture.

### The Real Cost

This is not just an inconvenience. Without distributed tracing, teams experience:

- **5-10x longer incident resolution times.** Instead of minutes, you spend hours connecting dots across services.
- **Ghost bugs.** Intermittent issues that cross service boundaries are nearly impossible to reproduce or diagnose without trace data.
- **Blame games.** "It's not my service, my logs look fine." Without a unified view, every team points at every other team.
- **SLA violations.** You cannot optimize what you cannot measure. If you do not know that the Inventory Service adds 200ms of latency on every request, you cannot fix it.
- **Alert fatigue.** Without traces, you compensate by adding more and more log-based alerts, most of which fire on symptoms rather than causes.

> **What If You Skip This?** Without distributed tracing, debugging a production issue in a microservices system is like solving a crime with the clues scattered across seven different cities, with no shared case file number. Teams without tracing report spending 5-10x longer on incident resolution. At 100K bookings per minute, even a 15-minute delay in diagnosing a latency spike means 1.5 million degraded user experiences. The investment in tracing pays for itself after the first production incident.

---

## 31.2 Core Concepts: Traces, Spans, and Context

Before we touch any code, you need to internalize three concepts. These are not just vocabulary words --- they are the mental model you will use every time you debug a production issue for the rest of your career.

### Traces

> **Key Term:** A **Trace** is the complete record of a single request's journey through your entire system. One user click equals one trace. A trace has a globally unique identifier --- the **Trace ID** --- which is a 128-bit hex string like `4bf92f3577b34da6a3ce929d0e0e4736`. This ID follows the request from the moment it enters your system until the final response is sent back.

Think of a trace as a tree. The root is the initial request. Each branch is a service call. Each leaf is a specific operation within a service. The trace captures the *entire* tree --- every branch, every leaf, every timing.

```
Trace: 4bf92f3577b34da6a3ce929d0e0e4736
Duration: 1,847ms
Services involved: api-gateway, auth-service, booking-service,
                   inventory-service, payment-service

Root Span: HTTP POST /api/v1/bookings
  |-- auth.validateToken (80ms)
  |-- booking.createBooking (1,400ms)
      |-- inventory.checkAvailability (200ms)
      |-- payment.processPayment (800ms)
      |   |-- stripe.chargeCard (750ms)
      |-- booking.saveRecord (150ms)
      |-- events.publishBookingCreated (50ms)
```

### Spans

> **Key Term:** A **Span** represents a single, named, timed operation within a trace. Every span has: a **span name** (what operation), a **span ID** (unique identifier), a **parent span ID** (who called me), a **start timestamp**, a **duration**, a **status** (OK, ERROR, or UNSET), and zero or more **attributes** (key-value metadata).

Spans are the building blocks of traces. A trace is nothing more than a collection of spans that share the same Trace ID. The parent-child relationships between spans create the tree structure.

Here is what a single span looks like as raw data:

```json
{
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "parentSpanId": "a1b2c3d4e5f60718",
  "operationName": "payment.processPayment",
  "startTime": "2026-02-15T09:14:22.150Z",
  "duration": 800,
  "status": { "code": "OK" },
  "attributes": {
    "payment.provider": "stripe",
    "payment.amount": 299.99,
    "payment.currency": "USD",
    "payment.method": "card",
    "service.name": "payment-service",
    "service.version": "2.3.1"
  },
  "events": [
    {
      "name": "payment.authorized",
      "timestamp": "2026-02-15T09:14:22.750Z",
      "attributes": { "authorization_code": "AUTH-889912" }
    }
  ]
}
```

Notice the `parentSpanId`. This is how spans form a tree. The payment span's parent is the booking span. The booking span's parent is the gateway span. Follow the chain, and you reconstruct the entire request flow.

### Context Propagation

> **Key Term:** **Context Propagation** is the mechanism that carries the Trace ID and current Span ID from one service to the next. Without it, each service would create isolated, disconnected traces. Context propagation is the *glue* that connects spans across service boundaries into a single, unified trace.

This is the concept most people underestimate. Creating spans is easy. Connecting them across network boundaries is the hard part. Context propagation works through headers.

When Service A calls Service B over HTTP, the tracing library automatically injects a special header into the outgoing request:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
```

This header follows the **W3C Trace Context** standard (we will dissect it in detail in Section 31.5). It contains:
- The trace ID (so Service B knows which trace this belongs to)
- The parent span ID (so Service B's spans become children of Service A's span)
- A flags byte (whether this trace is being sampled)

When Service B receives the request, its tracing library reads the `traceparent` header, extracts the trace ID and parent span ID, and creates its own spans as children. The chain continues for every subsequent service call.

> **Common Mistake:** Forgetting context propagation across asynchronous boundaries. HTTP propagation usually works automatically with OpenTelemetry's auto-instrumentation. But if you communicate via Kafka, RabbitMQ, or any message queue, you need to manually inject the trace context into message headers and extract it on the consumer side. We will cover this in detail in Section 31.5.

### The Visual: What a Trace Looks Like in Jaeger

When you put traces, spans, and context propagation together, you get a visualization like this in Jaeger or Grafana Tempo:

```
Trace ID: 4bf92f3577b34da6a3ce929d0e0e4736     Total Duration: 1.85s

SERVICE             OPERATION                TIME
api-gateway         HTTP POST /bookings      |========================================| 1850ms
  auth-service      validateToken              |====|                                    80ms
  booking-service   createBooking                    |==============================|  1400ms
    inventory-svc   checkAvailability                  |======|                        200ms
    payment-service processPayment                            |=================|      800ms
      stripe-api    POST /v1/charges                          |================|       750ms
    booking-service saveBookingRecord                                          |===|   150ms
    booking-service publishEvent                                                  |=|   50ms
```

At a glance, you see:
- The total request took 1.85 seconds
- Payment processing consumed 800ms (43% of the total)
- The Stripe API call within payment took 750ms (93% of the payment time)
- The bottleneck is the external Stripe API, not your code

This is the power of distributed tracing. One screenshot replaces 45 minutes of log grep.

---

## 31.3 OpenTelemetry SDK Setup in NestJS

### Why OpenTelemetry?

Before we set up the SDK, let me explain why OpenTelemetry is the right choice --- and the only choice you should seriously consider.

**OpenTelemetry** (often abbreviated **OTel**) is the second-largest project in the Cloud Native Computing Foundation (CNCF), behind only Kubernetes. It is vendor-neutral, meaning your instrumentation code works with *any* backend: Jaeger, Zipkin, Grafana Tempo, Datadog, New Relic, Honeycomb, AWS X-Ray, or any other. If you instrument with OpenTelemetry today and switch from Jaeger to Datadog next year, you change one exporter configuration --- not a single line of instrumentation code.

Before OpenTelemetry, the tracing ecosystem was fragmented. You had OpenTracing (an API standard without implementation), OpenCensus (Google's tracing library), and vendor-specific SDKs (Datadog's dd-trace, Jaeger's client libraries). OpenTelemetry merged OpenTracing and OpenCensus into a single, unified standard. It is the clear winner. Do not use anything else for new projects.

> **Key Term:** **OpenTelemetry (OTel)** is a collection of APIs, SDKs, and tools for generating, collecting, and exporting telemetry data (traces, metrics, and logs). It is vendor-neutral, open-source, and the industry standard for observability instrumentation.

### Installing the Dependencies

Here are the packages you need for a NestJS application:

```bash
# Core OpenTelemetry packages
npm install @opentelemetry/sdk-node \
            @opentelemetry/api \
            @opentelemetry/resources \
            @opentelemetry/semantic-conventions

# Exporters (choose based on your backend)
npm install @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/exporter-trace-otlp-grpc

# Auto-instrumentation libraries
npm install @opentelemetry/instrumentation-http \
            @opentelemetry/instrumentation-express \
            @opentelemetry/instrumentation-nestjs-core \
            @opentelemetry/instrumentation-mysql2 \
            @opentelemetry/instrumentation-redis \
            @opentelemetry/instrumentation-grpc

# Context propagation
npm install @opentelemetry/context-async-hooks \
            @opentelemetry/propagator-b3

# Sampling
npm install @opentelemetry/sdk-trace-base \
            @opentelemetry/sdk-trace-node
```

Each package serves a specific purpose. Let me explain the groupings:

- **Core packages** provide the API and SDK foundation. `@opentelemetry/api` is the stable interface; `@opentelemetry/sdk-node` is the Node.js implementation.
- **Exporters** send your trace data to a backend. The HTTP exporter sends JSON over HTTP; the gRPC exporter uses Protocol Buffers over gRPC (more efficient for high-volume production workloads).
- **Auto-instrumentation libraries** automatically wrap common libraries to create spans. Install one for each library you use: `pg` for PostgreSQL, `redis` for Redis, `grpc` for gRPC calls.
- **Context propagation** packages handle carrying trace context across async boundaries. `context-async-hooks` uses Node.js AsyncLocalStorage to maintain context across `await` calls.

### The Tracing Bootstrap File

This is the most critical file in your tracing setup. It **must** run before any other application code --- before NestJS initializes, before any module loads, before any request handler is registered. If it runs too late, the auto-instrumentation libraries will not be able to patch the HTTP and database libraries.

Create a file called `tracing.ts` in your project root:

```typescript
// tracing.ts — MUST be loaded before anything else
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { DiagConsoleLogger, DiagLogLevel, diag } from '@opentelemetry/api';

// Enable diagnostic logging during development
if (process.env.NODE_ENV !== 'production') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
}

// Define who this service is
const resource = new Resource({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'booking-service',
  [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
  [ATTR_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  'service.instance.id': process.env.HOSTNAME || 'local',
  'team.name': 'booking-platform',
  'team.oncall': 'booking-oncall@company.com',
});

// Configure the exporter
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    || 'http://otel-collector.monitoring:4318/v1/traces',
  headers: {
    // Some backends require authentication
    'x-api-key': process.env.OTEL_EXPORTER_API_KEY || '',
  },
});

// Configure the span processor
// BatchSpanProcessor batches spans and sends them in bulk,
// reducing network overhead. SimpleSpanProcessor sends each
// span immediately (useful for development, bad for production).
const spanProcessor = new BatchSpanProcessor(traceExporter, {
  maxQueueSize: 2048,           // Max spans to buffer
  maxExportBatchSize: 512,      // Max spans per export batch
  scheduledDelayMillis: 5000,   // Export every 5 seconds
  exportTimeoutMillis: 30000,   // Timeout per export attempt
});

// Initialize the SDK
const sdk = new NodeSDK({
  resource,
  spanProcessor,
  instrumentations: [
    // HTTP: auto-creates spans for all incoming/outgoing HTTP requests
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => {
        // Do not trace health checks — they create noise
        const url = req.url || '';
        return url.includes('/health') || url.includes('/ready') || url.includes('/metrics');
      },
      requestHook: (span, request) => {
        // Add custom attributes to every HTTP span
        span.setAttribute('http.request_id',
          request.headers?.['x-request-id'] as string || 'unknown');
      },
    }),

    // Express: auto-creates spans for Express middleware and routes
    new ExpressInstrumentation(),

    // NestJS: auto-creates spans for NestJS controllers, guards, pipes, interceptors
    new NestInstrumentation(),

    // PostgreSQL: auto-creates spans for every database query
    new MySQL2Instrumentation({
      enhancedDatabaseReporting: true,  // Include query text in spans
      addSqlCommenterCommentToQueries: true,  // Add trace context to SQL comments
    }),

    // Redis: auto-creates spans for every Redis command
    new RedisInstrumentation(),
  ],
});

// Start the SDK
sdk.start();
console.log('OpenTelemetry tracing initialized');

// Graceful shutdown: flush pending spans before process exits
const shutdown = async () => {
  console.log('Shutting down OpenTelemetry...');
  await sdk.shutdown();
  console.log('OpenTelemetry shut down complete');
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { sdk };
```

Now, update your `main.ts` to load tracing first:

```typescript
// main.ts — tracing MUST be imported first
import './tracing';  // <-- This line must be FIRST

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

bootstrap();
```

> **Common Mistake:** Importing the tracing file *after* other modules. If NestJS loads the HTTP or database modules before OpenTelemetry patches them, auto-instrumentation will silently fail. You will see no spans for HTTP calls or database queries, and you will spend hours wondering why. Always import `./tracing` as the very first line of `main.ts`. Some teams use Node's `--require` flag instead: `node --require ./tracing.js dist/main.js`. This guarantees it loads first.

### Understanding Each Layer

Let me walk through the key decisions in this setup, because every line matters in production.

**Resource attributes.** These tags appear on every single span your service produces. `service.name` is how Jaeger groups spans --- if you get this wrong, your traces will be labeled "unknown_service" and you will not be able to filter by service. `service.instance.id` (set to the container hostname) lets you distinguish between different replicas of the same service. `team.name` and `team.oncall` are custom attributes that help operations teams route alerts to the right people.

**BatchSpanProcessor vs SimpleSpanProcessor.** The `BatchSpanProcessor` buffers spans in memory and exports them in batches every 5 seconds (or when the buffer reaches 512 spans). This is essential for production: it reduces network calls from potentially thousands per second to a handful. The `SimpleSpanProcessor` exports each span immediately, which is useful during local development when you want instant feedback in Jaeger, but it adds noticeable latency to every request in production.

**Filtering health check requests.** Kubernetes sends health probes (`/health`, `/ready`) every few seconds to every pod. Without the `ignoreIncomingRequestHook`, these probes would generate thousands of useless trace spans per hour, drowning out real traffic. Always filter them.

**Enhanced database reporting.** The `enhancedDatabaseReporting: true` option on the PostgreSQL instrumentation includes the actual SQL query text in the span. This is incredibly useful for debugging slow queries --- you can see `SELECT * FROM bookings WHERE id = $1` right in the trace. However, be cautious: if your queries contain sensitive data (email addresses, SSNs), this data will appear in your traces. In production, you may want to sanitize or disable this.

---

## 31.4 Auto-Instrumentation vs Manual Spans

### What Auto-Instrumentation Gives You for Free

With the setup above, you get automatic traces for a surprising amount of your application's behavior without writing a single line of tracing code:

| Library                | What Gets Traced Automatically                          |
|------------------------|---------------------------------------------------------|
| HTTP (incoming)        | Every incoming HTTP request: method, URL, status code, duration |
| HTTP (outgoing)        | Every outgoing HTTP call: target URL, response status, duration  |
| Express                | Middleware execution, route matching                     |
| NestJS                 | Controller handlers, Guards, Pipes, Interceptors         |
| PostgreSQL             | Every SQL query: query text, database name, duration     |
| Redis                  | Every Redis command: command name, key, duration         |
| gRPC                   | Every gRPC call: service, method, status code            |

This covers roughly **80% of what you need**. For a typical NestJS request that hits a database and calls another service, you get a complete trace with zero manual work.

But the remaining 20% --- the business logic, the domain-specific operations, the things that make *your* system unique --- require manual instrumentation. You need to tell the tracing system: "This chunk of code is 'checking inventory,' and this chunk is 'processing payment.'"

### Creating Manual Spans

Here is the pattern for creating manual spans in NestJS:

```typescript
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';

// Get a tracer — think of this as your "span factory"
// The name and version identify which component is creating spans
const tracer = trace.getTracer('booking-service', '1.0.0');
```

> **Key Term:** A **Tracer** is the object you use to create spans. You get a tracer by calling `trace.getTracer()` with a name (usually your service or module name) and a version. The tracer is lightweight --- creating one is essentially free. Most teams create one tracer per module or service.

Now let us create spans for your booking service's business logic:

```typescript
import { Injectable } from '@nestjs/common';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('booking-service', '1.0.0');

@Injectable()
export class BookingService {
  constructor(
    private readonly inventoryClient: InventoryClient,
    private readonly paymentClient: PaymentClient,
    private readonly bookingRepo: BookingRepository,
    private readonly eventPublisher: EventPublisher,
  ) {}

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    // Start the parent span for the entire operation
    return tracer.startActiveSpan(
      'BookingService.createBooking',
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'booking.type': dto.bookingType,
          'booking.user_id': dto.userId,
          'booking.hotel_id': dto.hotelId,
          'booking.room_type': dto.roomType,
          'booking.check_in': dto.checkIn.toISOString(),
          'booking.check_out': dto.checkOut.toISOString(),
          'booking.guest_count': dto.guestCount,
          'booking.requested_amount': dto.totalAmount,
        },
      },
      async (parentSpan) => {
        try {
          // --- Step 1: Check availability ---
          const availability = await tracer.startActiveSpan(
            'BookingService.checkAvailability',
            { kind: SpanKind.INTERNAL },
            async (span) => {
              try {
                const result = await this.inventoryClient.checkAvailability({
                  hotelId: dto.hotelId,
                  roomType: dto.roomType,
                  checkIn: dto.checkIn,
                  checkOut: dto.checkOut,
                });
                span.setAttribute('availability.rooms_available', result.availableCount);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              } catch (error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                throw error;
              } finally {
                span.end();
              }
            },
          );

          if (!availability.isAvailable) {
            parentSpan.addEvent('booking.rejected', {
              'rejection.reason': 'no_availability',
              'rejection.rooms_available': availability.availableCount,
            });
            parentSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'No rooms available for requested dates',
            });
            throw new NoAvailabilityException(dto.hotelId, dto.checkIn, dto.checkOut);
          }

          // --- Step 2: Process payment ---
          const payment = await tracer.startActiveSpan(
            'BookingService.processPayment',
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                'payment.provider': dto.paymentProvider,
                'payment.amount': dto.totalAmount,
                'payment.currency': dto.currency,
              },
            },
            async (span) => {
              try {
                const result = await this.paymentClient.charge({
                  userId: dto.userId,
                  amount: dto.totalAmount,
                  currency: dto.currency,
                  provider: dto.paymentProvider,
                  idempotencyKey: dto.idempotencyKey,
                });
                span.setAttribute('payment.transaction_id', result.transactionId);
                span.setAttribute('payment.status', result.status);
                span.addEvent('payment.completed', {
                  'transaction_id': result.transactionId,
                });
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              } catch (error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                throw error;
              } finally {
                span.end();
              }
            },
          );

          // --- Step 3: Save booking record ---
          const booking = await tracer.startActiveSpan(
            'BookingService.saveBookingRecord',
            { kind: SpanKind.INTERNAL },
            async (span) => {
              try {
                const result = await this.bookingRepo.create({
                  ...dto,
                  paymentId: payment.transactionId,
                  status: 'CONFIRMED',
                });
                span.setAttribute('booking.id', result.id);
                span.setAttribute('booking.confirmation_code', result.confirmationCode);
                span.setStatus({ code: SpanStatusCode.OK });
                return result;
              } catch (error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                throw error;
              } finally {
                span.end();
              }
            },
          );

          // --- Step 4: Publish domain event ---
          await tracer.startActiveSpan(
            'BookingService.publishBookingCreated',
            { kind: SpanKind.PRODUCER },
            async (span) => {
              try {
                await this.eventPublisher.publish('booking.created', {
                  bookingId: booking.id,
                  userId: dto.userId,
                  hotelId: dto.hotelId,
                  amount: dto.totalAmount,
                });
                span.setStatus({ code: SpanStatusCode.OK });
              } catch (error) {
                // Event publishing failure should not fail the booking
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                // Log but do not rethrow — the booking is already confirmed
              } finally {
                span.end();
              }
            },
          );

          // Set final attributes on the parent span
          parentSpan.setAttribute('booking.id', booking.id);
          parentSpan.setAttribute('booking.confirmation_code', booking.confirmationCode);
          parentSpan.setAttribute('booking.status', 'CONFIRMED');
          parentSpan.setStatus({ code: SpanStatusCode.OK });

          return booking;

        } catch (error) {
          parentSpan.recordException(error);
          parentSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          throw error;
        } finally {
          parentSpan.end();
        }
      },
    );
  }
}
```

This is a lot of code. Let me break down every decision.

## 31.5 The `withSpan` Helper — Reducing Boilerplate

Look back at the `createBooking` code in Section 31.4. Every single span follows the same pattern: start spin, set attributes, try the operation, catch errors, record exception, set status, end span in `finally`. That is 15 lines of tracing boilerplate wrapped around 2 lines of actual business logic. Multiply this across 200 service methods and your codebase becomes more tracing code than business code.

This is unsustainable. Let us fix it with a helper.

> **Analogy:** Think of the `withSpan` pattern like a picture frame. Every painting needs a frame, but you do not hand-carve a new frame for each painting. You build a reusable frame, and then you just slot each painting in. The frame (error handling, status setting, span lifecycle) stays the same. The painting (your business logic) is the part that changes.

```typescript
// src/tracing/with-span.ts — The span helper that saves your sanity
import { trace, context, SpanStatusCode, SpanKind, Span, Attributes } from '@opentelemetry/api';

interface SpanOptions {
  name: string;
  tracerName?: string;
  kind?: SpanKind;
  attributes?: Attributes;
  /** If true, errors are recorded but not rethrown */
  swallowErrors?: boolean;
}

const defaultTracer = trace.getTracer('booking-service', '1.0.0');

export async function withSpan<T>(
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = options.tracerName
    ? trace.getTracer(options.tracerName)
    : defaultTracer;

  return tracer.startActiveSpan(
    options.name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: options.attributes,
    },
    async (span: Span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        if (options.swallowErrors) {
          return undefined as T;
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
```

Now look at how clean your booking service becomes:

```typescript
@Injectable()
export class BookingService {
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    return withSpan(
      {
        name: 'BookingService.createBooking',
        attributes: {
          'booking.type': dto.bookingType,
          'booking.user_id': dto.userId,
          'booking.hotel_id': dto.hotelId,
        },
      },
      async (parentSpan) => {
        // Step 1: Check availability — 3 lines, not 15
        const availability = await withSpan(
          { name: 'BookingService.checkAvailability' },
          async (span) => {
            const result = await this.inventoryClient.checkAvailability(dto);
            span.setAttribute('availability.rooms_available', result.availableCount);
            return result;
          },
        );

        if (!availability.isAvailable) {
          throw new NoAvailabilityException(dto.hotelId, dto.checkIn, dto.checkOut);
        }

        // Step 2: Process payment — same clean pattern
        const payment = await withSpan(
          {
            name: 'BookingService.processPayment',
            attributes: { 'payment.amount': dto.totalAmount },
          },
          async (span) => {
            const result = await this.paymentClient.charge(dto);
            span.setAttribute('payment.transaction_id', result.transactionId);
            return result;
          },
        );

        // Step 3: Save the booking
        const booking = await withSpan(
          { name: 'BookingService.saveRecord' },
          async (span) => {
            const result = await this.bookingRepo.create({ ...dto, paymentId: payment.transactionId });
            span.setAttribute('booking.id', result.id);
            return result;
          },
        );

        // Step 4: Publish event (swallow errors — booking is already confirmed)
        await withSpan(
          { name: 'BookingService.publishEvent', kind: SpanKind.PRODUCER, swallowErrors: true },
          async () => {
            await this.eventPublisher.publish('booking.created', { bookingId: booking.id });
          },
        );

        parentSpan.setAttribute('booking.id', booking.id);
        return booking;
      },
    );
  }
}
```

The business logic is now front and center. The tracing infrastructure is invisible. Every span still gets proper error handling, status codes, and cleanup --- but you write it once in the helper and never again.

> **Common Mistake:** Some teams skip the helper and rely entirely on auto-instrumentation because "it is easier." Auto-instrumentation covers HTTP and database calls, but it cannot name your business operations. In Jaeger, you will see `HTTP POST /api/bookings` and `pg.query SELECT ...`, but you will not see `checkAvailability` or `processPayment`. When debugging at 3 AM, those business-level span names are what save you. Use `withSpan` for business logic. Let auto-instrumentation handle the plumbing.

---

## 31.6 Trace Context Propagation Across Message Queues

### The Problem: Kafka Breaks the Chain

HTTP propagation works automatically. When your Booking Service makes an HTTP call to the Payment Service, the OpenTelemetry HTTP instrumentation injects the `traceparent` header into the outgoing request and extracts it on the incoming side. You do not write any propagation code.

But your Global Booking System does not communicate exclusively over HTTP. When a booking is confirmed, you publish a `booking.created` event to Kafka. The Notification Service, the Analytics Service, and the Loyalty Service all consume that event. If you do not manually propagate trace context through Kafka message headers, every consumer creates an orphaned trace --- disconnected from the original booking flow.

> **Analogy:** Imagine you are a relay runner passing a baton. In an HTTP call, the baton pass happens hand-to-hand --- automatic and reliable. But with a message queue, you set the baton down on a shelf, walk away, and someone else picks it up later. If you do not label the baton with the race number, the next runner has no idea which race they are continuing. You must tape the race number (trace context) to the baton (Kafka message) yourself.

### Producer: Injecting Trace Context into Kafka Headers

```typescript
// src/kafka/traced-kafka-producer.ts
import { trace, context, propagation, SpanKind } from '@opentelemetry/api';
import { Producer, Message } from 'kafkajs';
import { withSpan } from '../tracing/with-span';

export class TracedKafkaProducer {
  constructor(private readonly producer: Producer) {}

  async publish(topic: string, payload: object, key?: string): Promise<void> {
    await withSpan(
      {
        name: `kafka.produce.${topic}`,
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.destination': topic,
          'messaging.destination_kind': 'topic',
        },
      },
      async (span) => {
        // Step 1: Create a carrier object to hold propagation headers
        const carrier: Record<string, string> = {};

        // Step 2: Inject current trace context into the carrier
        // This writes 'traceparent' and optionally 'tracestate' into carrier
        propagation.inject(context.active(), carrier);

        // Step 3: Convert carrier entries into Kafka message headers
        const headers: Record<string, Buffer> = {};
        for (const [headerKey, headerValue] of Object.entries(carrier)) {
          headers[headerKey] = Buffer.from(headerValue);
        }

        // Step 4: Add business metadata headers (optional but useful)
        headers['x-produced-by'] = Buffer.from('booking-service');
        headers['x-produced-at'] = Buffer.from(new Date().toISOString());

        const message: Message = {
          key: key ? Buffer.from(key) : undefined,
          value: Buffer.from(JSON.stringify(payload)),
          headers,
        };

        await this.producer.send({ topic, messages: [message] });

        span.setAttribute('messaging.kafka.message_key', key ?? 'null');
        span.setAttribute(
          'messaging.message_payload_size_bytes',
          Buffer.byteLength(JSON.stringify(payload)),
        );
      },
    );
  }
}
```

The critical part is steps 1 through 3. `propagation.inject()` takes the current active context --- which contains the trace ID and current span ID --- and writes it into a plain JavaScript object. You then convert those string key-value pairs into Kafka message headers (which are `Buffer` values). When the consumer reads these headers, it can reconstruct the trace context and link its spans to the same trace.

### Consumer: Extracting Trace Context from Kafka Headers

```typescript
// src/kafka/traced-kafka-consumer.ts
import { trace, context, propagation, SpanKind, ROOT_CONTEXT } from '@opentelemetry/api';
import { EachMessagePayload } from 'kafkajs';
import { withSpan } from '../tracing/with-span';

export class TracedKafkaConsumer {
  async handleMessage(
    handler: (payload: any, traceId: string) => Promise<void>,
    messagePayload: EachMessagePayload,
  ): Promise<void> {
    const { topic, partition, message } = messagePayload;

    // Step 1: Extract trace context from Kafka message headers
    const carrier: Record<string, string> = {};
    if (message.headers) {
      for (const [key, value] of Object.entries(message.headers)) {
        if (value) {
          carrier[key] = value.toString();
        }
      }
    }

    // Step 2: Create a context from the extracted headers
    // This reconstructs the trace ID and parent span ID
    const extractedContext = propagation.extract(ROOT_CONTEXT, carrier);

    // Step 3: Run the handler within the extracted context
    // This makes the consumer's spans children of the producer's span
    await context.with(extractedContext, async () => {
      await withSpan(
        {
          name: `kafka.consume.${topic}`,
          kind: SpanKind.CONSUMER,
          attributes: {
            'messaging.system': 'kafka',
            'messaging.source': topic,
            'messaging.kafka.partition': partition,
            'messaging.kafka.offset': message.offset,
            'messaging.source_kind': 'topic',
          },
        },
        async (span) => {
          const body = JSON.parse(message.value!.toString());
          const traceId = span.spanContext().traceId;

          span.setAttribute('messaging.message_payload_size_bytes',
            message.value ? message.value.length : 0);

          await handler(body, traceId);
        },
      );
    });
  }
}
```

The key technique here is `propagation.extract(ROOT_CONTEXT, carrier)`. This reads the `traceparent` header from the carrier, parses the trace ID and parent span ID, and creates a new context that "remembers" the original trace. By wrapping the handler in `context.with(extractedContext, ...)`, every span created inside the handler becomes a child of the producer's span.

The result: when you open Jaeger and search for a booking trace, you see the entire flow --- from the HTTP request, through `processPayment`, through `publishEvent` on the Kafka producer side, all the way down to `sendConfirmationEmail` on the Notification Service consumer side. One trace. One story. Across HTTP and Kafka.

> **Common Mistake:** Using `context.active()` instead of `ROOT_CONTEXT` as the first argument to `propagation.extract()`. If the consumer already has an active span from a previous message, using `context.active()` would nest the new message's trace under the previous message's trace --- creating a nonsensical parent-child relationship between unrelated messages. Always start from `ROOT_CONTEXT` when extracting context from a message queue.

### Trace Context Propagation Across gRPC

If your services communicate via gRPC instead of (or in addition to) HTTP and Kafka, context propagation works similarly but is handled by the gRPC auto-instrumentation library:

```typescript
// tracing.ts — add gRPC instrumentation
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';

const sdk = new NodeSDK({
  // ... resource, exporter, etc.
  instrumentations: [
    new HttpInstrumentation(),
    new GrpcInstrumentation({
      // Optionally ignore certain gRPC methods (like health checks)
      ignoreGrpcMethods: ['grpc.health.v1.Health/Check'],
    }),
    // ... other instrumentations
  ],
});
```

Unlike Kafka, gRPC propagation is automatic. The `GrpcInstrumentation` library patches the gRPC client and server to inject and extract the `traceparent` metadata automatically. Every gRPC call from Service A to Service B carries the trace context in gRPC metadata (the gRPC equivalent of HTTP headers) without any manual code.

The auto-created spans include:

- `grpc.unary.client/serviceName/MethodName` for outgoing calls
- `grpc.unary.server/serviceName/MethodName` for incoming calls
- gRPC status codes, method names, and service names as span attributes

```typescript
// Example: Your gRPC call is traced automatically
const response = await this.inventoryGrpcClient.checkAvailability({
  hotelId: dto.hotelId,
  checkIn: dto.checkIn,
  checkOut: dto.checkOut,
});
// A span named "grpc.unary.client/InventoryService/CheckAvailability"
// is created automatically with the trace context propagated.
```

---

## 31.7 W3C Trace Context: What Is Inside the Header

You have seen the `traceparent` header mentioned several times. Let us dissect it byte by byte, because understanding this format helps you debug propagation failures.

> **Key Term:** **W3C Trace Context** is a W3C Recommendation (an official web standard) that defines the `traceparent` and `tracestate` HTTP headers for propagating trace context across services. It is the default propagation format used by OpenTelemetry.

The `traceparent` header has exactly this format:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^^-^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^-^^^^^^^^^^^^^^^^-^^
             |            |                           |            |
          version     trace-id                    parent-id     flags
```

| Field       | Length   | Description                                                    |
|-------------|----------|----------------------------------------------------------------|
| `version`   | 2 hex    | Always `00` for the current spec version                       |
| `trace-id`  | 32 hex   | 128-bit globally unique identifier for the entire trace        |
| `parent-id` | 16 hex   | 64-bit identifier of the calling span (the immediate parent)   |
| `flags`     | 2 hex    | Bit flags; `01` means "this trace is sampled" (being recorded) |

The companion header `tracestate` carries vendor-specific data:

```
tracestate: congo=t61rcWkgMzE,rojo=00f067aa0ba902b7
```

This lets multiple tracing vendors coexist. If your system runs both Datadog and OpenTelemetry, each can store its own context in `tracestate` without interfering with the other.

**Why does this matter in practice?** When traces are not connecting across services, the first thing you debug is the `traceparent` header. Curl the downstream service and inspect the headers:

```bash
curl -v https://inventory-service.internal/api/check \
  -H "traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
```

If the response trace shows a different trace ID than what you sent, propagation is broken somewhere. Knowing the header format lets you verify this manually.

---

## 31.8 The Baggage API: Cross-Service Metadata

Sometimes you need to pass business metadata across services without adding it to every intermediary's function signatures. The OpenTelemetry **Baggage API** exists for this.

> **Key Term:** **Baggage** is a set of key-value pairs that propagate alongside trace context across service boundaries. Unlike span attributes (which are local to one span), baggage values travel with the request to every downstream service. Any service in the chain can read baggage values set by an upstream service.

```typescript
// src/middleware/baggage.middleware.ts
import { propagation, context, BaggageEntry } from '@opentelemetry/api';

// Setting baggage at the API Gateway
export function setBaggageMiddleware(req: Request, res: Response, next: NextFunction) {
  const entries: Record<string, BaggageEntry> = {
    'user.tier': { value: req.user?.tier ?? 'free' },
    'request.region': { value: req.headers['x-region'] as string ?? 'unknown' },
    'feature.flags': { value: req.headers['x-feature-flags'] as string ?? '' },
    'session.id': { value: req.sessionId ?? 'anonymous' },
  };

  const baggage = propagation.createBaggage(entries);
  const newContext = propagation.setBaggage(context.active(), baggage);

  context.with(newContext, () => {
    next();
  });
}

// Reading baggage in a downstream service (e.g., Payment Service)
export function readBaggage(): Record<string, string> {
  const baggage = propagation.getBaggage(context.active());
  const result: Record<string, string> = {};

  if (baggage) {
    for (const [key, entry] of baggage.getAllEntries()) {
      result[key] = entry.value;
    }
  }

  return result;
}

// Usage in Payment Service
@Injectable()
export class PaymentService {
  async processPayment(dto: PaymentDto): Promise<PaymentResult> {
    const baggage = readBaggage();
    const userTier = baggage['user.tier'];

    // Premium users get routed to a faster payment processor
    if (userTier === 'premium') {
      return this.premiumPaymentProcessor.charge(dto);
    }

    return this.standardPaymentProcessor.charge(dto);
  }
}
```

Baggage is powerful because it avoids the "pass-through parameter" problem --- where every service in the chain must accept and forward a parameter that only the last service needs. With baggage, the API Gateway sets `user.tier`, and the Payment Service reads it four hops later, without the Booking Service or Inventory Service knowing or caring about it.

> **Common Mistake:** Putting sensitive data in baggage. Baggage values propagate as plain-text HTTP headers (`baggage: user.tier=premium,session.id=abc123`). Any service or proxy in the chain can read them. Never put PII, authentication tokens, or secrets in baggage. Use it for routing hints, feature flags, and non-sensitive metadata only. Also be aware that baggage adds bytes to every HTTP request header --- keep values short and the number of entries small (under 10).

> **Common Mistake:** Using baggage as a replacement for proper API design. If Service D always needs `userId` from Service A, pass it through the API contract, not baggage. Baggage is for *cross-cutting concerns* (like user tier for routing decisions), not for core business data. Over-reliance on baggage creates invisible coupling that is impossible to trace by reading the code.

---

## 31.9 Sampling Strategies: You Cannot Trace Everything

At 100,000 bookings per minute, each booking generates 10 to 30 spans. That is 1 to 3 million spans per minute. Each span is roughly 1 KB of data. That is 1 to 3 GB of trace data per minute, 1.4 to 4.3 TB per day.

You cannot store all of it. You should not try. This is where sampling comes in.

> **Key Term:** **Sampling** is the practice of recording only a fraction of traces while discarding the rest. The goal is to capture enough traces to understand system behavior, diagnose issues, and measure latency, without overwhelming your storage and budget.

### Head-Based Sampling

The simplest approach. The decision to sample (record) or drop a trace is made at the *beginning* of the trace --- at the "head." Every downstream service respects the decision made at the head.

```typescript
// tracing.ts — Head-based sampling configuration
import { TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';

const sdk = new NodeSDK({
  // ... resource, exporter
  sampler: new ParentBasedSampler({
    // Sample 10% of new traces (no parent = root span)
    root: new TraceIdRatioBasedSampler(0.1),
    // If parent was sampled, always sample the child (keep the trace complete)
    // If parent was not sampled, never sample the child
  }),
  // ... instrumentations
});
```

`ParentBasedSampler` is the key here. It wraps a root sampler and adds parent-awareness:

- If a request arrives **without** a `traceparent` header (it is a new trace), the `root` sampler decides: 10% chance of sampling.
- If a request arrives **with** a `traceparent` header and the `flags` byte says "sampled" (`01`), this service always samples. This ensures you never have a half-complete trace where the first service recorded spans but the third one did not.
- If a request arrives **with** a `traceparent` header and the `flags` byte says "not sampled" (`00`), this service drops the trace.

**Pros:** Simple. Low overhead. Deterministic across service boundaries.
**Cons:** You miss 90% of traces. If a rare error occurs in an unsampled trace, you have no data.

### Tail-Based Sampling

The decision to keep or drop a trace is made at the *end* --- at the "tail" --- after all spans have been collected. A collector component (like the OpenTelemetry Collector) buffers complete traces and applies rules:

```yaml
# otel-collector-config.yaml — Tail-based sampling
processors:
  tail_sampling:
    decision_wait: 30s           # Wait up to 30s for all spans to arrive
    num_traces: 100000           # Max traces to hold in memory
    policies:
      # Policy 1: Always keep error traces
      - name: errors-policy
        type: status_code
        status_code:
          status_codes: [ERROR]

      # Policy 2: Always keep slow traces (> 5 seconds)
      - name: latency-policy
        type: latency
        latency:
          threshold_ms: 5000

      # Policy 3: Always keep traces for specific high-value operations
      - name: booking-creation-policy
        type: string_attribute
        string_attribute:
          key: operation.type
          values: [booking.create, payment.process]

      # Policy 4: Sample 5% of remaining normal traces
      - name: probabilistic-policy
        type: probabilistic
        probabilistic:
          sampling_percentage: 5

exporters:
  otlp:
    endpoint: "tempo.monitoring:4317"

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling]
      exporters: [otlp]
```

This configuration tells the collector:

1. Keep 100% of traces that contain at least one error span. These are the traces you will actually investigate.
2. Keep 100% of traces slower than 5 seconds. These indicate performance problems.
3. Keep 100% of traces involving booking creation or payment processing. These are your most important business operations.
4. For everything else (healthy, fast traces), keep only 5%.

**Pros:** You never miss an error trace. You capture all slow requests. You can define policies based on outcomes that are only known after the fact.
**Cons:** Higher resource usage (the collector must buffer traces in memory). More complex infrastructure. The `decision_wait` adds latency to trace visibility --- you must wait 30 seconds for the tail to arrive before the decision is made.

### Adaptive Sampling

A dynamic approach where the sampling rate adjusts based on traffic volume. During low-traffic periods, you sample a higher percentage (more detail). During peak traffic, you reduce sampling to avoid storage overload.

```typescript
// src/tracing/adaptive-sampler.ts
import { Sampler, SamplingDecision, SamplingResult, Context, Link, Attributes } from '@opentelemetry/api';

export class AdaptiveSampler implements Sampler {
  private requestCount = 0;
  private readonly windowMs = 60_000; // 1 minute window
  private windowStart = Date.now();

  private readonly tiers = [
    { maxRpm: 1_000,   rate: 1.0  },   // < 1K rpm: sample everything
    { maxRpm: 10_000,  rate: 0.5  },   // < 10K rpm: sample 50%
    { maxRpm: 100_000, rate: 0.1  },   // < 100K rpm: sample 10%
    { maxRpm: Infinity, rate: 0.01 },  // > 100K rpm: sample 1%
  ];

  shouldSample(
    parentContext: Context,
    traceId: string,
    spanName: string,
    spanKind: number,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    this.requestCount++;

    // Reset window every minute
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.requestCount = 0;
      this.windowStart = now;
    }

    // Determine sampling rate based on current traffic volume
    const rpm = this.requestCount;
    const tier = this.tiers.find(t => rpm <= t.maxRpm)!;
    const rate = tier.rate;

    // Use trace ID hash for deterministic sampling
    // This ensures the same trace ID always gets the same decision
    const hash = parseInt(traceId.substring(0, 8), 16);
    const threshold = Math.floor(rate * 0xffffffff);
    const sampled = hash <= threshold;

    return {
      decision: sampled
        ? SamplingDecision.RECORD_AND_SAMPLED
        : SamplingDecision.NOT_RECORD,
      attributes: {
        'sampling.rate': rate,
        'sampling.rpm': rpm,
      },
    };
  }

  toString(): string {
    return 'AdaptiveSampler';
  }
}
```

> **Production War Story:** A team at a large travel platform used a fixed 100% sampling rate during development and forgot to lower it before launching to production. On the first day of a flash sale, their system handled 200,000 requests per minute. The tracing backend ingested 4 million spans per minute --- 6 GB of data every 60 seconds. Their Jaeger cluster ran out of disk within 3 hours. The storage costs for that single day exceeded their entire monthly observability budget. They scrambled to add sampling at 3 AM while the sale was running. The fix: a 10% head-based sampler, deployed in under 5 minutes, immediately cut ingest volume by 90%. The lesson: always configure sampling before you go to production, and always use tail-based sampling for errors so you never lose the traces that matter most.

---

## 31.10 Instrumenting Database Queries

### Auto-Instrumentation for MySQL, Redis, and Elasticsearch

The OpenTelemetry ecosystem provides auto-instrumentation libraries for most popular databases. Once registered, these libraries monkey-patch the database client and automatically create spans for every query.

```typescript
// tracing.ts — Database auto-instrumentation
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { MySQL2Instrumentation } from '@opentelemetry/instrumentation-mysql2';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis-4';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

const sdk = new NodeSDK({
  instrumentations: [
    // MySQL: auto-traces every query via mysql2 driver
    new MySQL2Instrumentation({
      enhancedDatabaseReporting: true,  // Include SQL text in spans
    }),

    // PostgreSQL: auto-traces every query via pg driver
    new MySQL2Instrumentation({
      enhancedDatabaseReporting: true,
      addSqlCommenterCommentToQueries: true,
      // Adds a SQL comment like:
      // SELECT * FROM bookings WHERE id = $1
      // /*traceparent='00-abc123-def456-01'*/
      // This lets you correlate slow query logs to traces!
    }),

    // Redis v4 (node-redis): auto-traces every command
    new RedisInstrumentation({
      dbStatementSerializer: (cmdName, cmdArgs) => {
        // Customize what the span shows for Redis commands
        // Be careful not to log sensitive values
        return `${cmdName} ${cmdArgs[0] ?? ''}`;
      },
    }),

    // ioredis: auto-traces every command
    new IORedisInstrumentation(),
  ],
});
```

After registering these, your traces automatically include database spans:

```
BookingService.createBooking        [1400ms]
  inventory.checkAvailability       [200ms]
    pg.query SELECT                 [15ms]     db.statement: "SELECT available_count FROM rooms WHERE..."
    redis.GET                       [2ms]      db.statement: "GET inventory:hotel:123:2026-03-15"
  payment.processPayment            [800ms]
    pg.query INSERT                 [12ms]     db.statement: "INSERT INTO transactions ..."
  pg.query INSERT                   [18ms]     db.statement: "INSERT INTO bookings ..."
```

Now when a query takes 500ms instead of 15ms, you see it immediately in the trace. No slow-query-log hunting required.

> **Common Mistake:** Enabling `enhancedDatabaseReporting` in a service that handles personally identifiable information (PII). If your queries contain email addresses, phone numbers, or credit card data (`WHERE email = 'alice@example.com'`), that data appears in your spans and gets stored in your tracing backend. Either disable enhanced reporting for sensitive services or implement a sanitization hook that redacts PII before the span is exported.

### SQL Commenter: Connecting Slow Query Logs to Traces

The `addSqlCommenterCommentToQueries` option on the PostgreSQL instrumentation deserves special attention. It appends a SQL comment to every query:

```sql
SELECT * FROM bookings WHERE user_id = $1
/*traceparent='00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'*/
```

This comment is ignored by the database engine (it is just a comment), but it appears in your database's slow query log. When your DBA reports "this query took 12 seconds," you can extract the trace ID from the SQL comment and look up the exact trace in Jaeger. You go from "some query was slow" to "this specific user's booking request was slow because of this specific query" in seconds.

### Prisma Instrumentation with OpenTelemetry

If your NestJS application uses Prisma as its ORM, OpenTelemetry integration requires a slightly different setup. Prisma has built-in support for tracing through its client extensions:

```typescript
// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

Enable tracing in your Prisma schema and client generator:

```prisma
// schema.prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["tracing"]
}
```

Then configure the OpenTelemetry instrumentation for Prisma:

```typescript
// tracing.ts — Add Prisma instrumentation
import { PrismaInstrumentation } from '@prisma/instrumentation';

const sdk = new NodeSDK({
  instrumentations: [
    new PrismaInstrumentation(),
    // ... other instrumentations
  ],
});
```

With this setup, every Prisma query generates a span with attributes like `db.system`, `db.statement`, and `db.operation`. You see spans named `prisma:client:operation` (for the high-level Prisma operation like `findMany` or `create`) and `prisma:engine:query` (for the actual SQL query executed by the Prisma engine).

```
BookingService.createBooking            [1400ms]
  prisma:client:operation findFirst     [22ms]     model: Room, operation: findFirst
    prisma:engine:db_query              [8ms]      db.statement: SELECT ... FROM "Room" WHERE ...
    prisma:engine:serialize             [1ms]
  prisma:client:operation create        [35ms]     model: Booking, operation: create
    prisma:engine:db_query              [12ms]     db.statement: INSERT INTO "Booking" ...
    prisma:engine:serialize             [2ms]
```

---

## 31.11 Correlating Traces with Logs

Traces show you the structure and timing of a request. Logs show you the details --- the actual error messages, the variable values, the decision points. The real power comes when you connect them.

### Injecting Trace IDs into Structured Logs

The technique is simple: when writing a log line, include the current trace ID and span ID. Then, in your log aggregator (ELK, Loki, Datadog Logs), you can search by trace ID and see every log line from every service that participated in that trace.

```typescript
// src/logging/traced-logger.ts
import { trace, context } from '@opentelemetry/api';
import { Logger, createLogger, format, transports } from 'winston';

// Custom Winston format that injects trace context
const traceFormat = format((info) => {
  const activeSpan = trace.getSpan(context.active());

  if (activeSpan) {
    const spanContext = activeSpan.spanContext();
    info.trace_id = spanContext.traceId;
    info.span_id = spanContext.spanId;
    info.trace_flags = spanContext.traceFlags;
    // Also set the service name for log correlation
    info.service_name = process.env.OTEL_SERVICE_NAME || 'unknown';
  }

  return info;
});

export const logger: Logger = createLogger({
  level: 'info',
  format: format.combine(
    traceFormat(),
    format.timestamp(),
    format.json(),
  ),
  transports: [
    new transports.Console(),
    // In production, also send to your log aggregator
  ],
});
```

Now every log line automatically includes trace context:

```json
{
  "timestamp": "2026-02-15T09:14:22.150Z",
  "level": "info",
  "message": "Payment processed successfully",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "trace_flags": 1,
  "service_name": "payment-service",
  "transaction_id": "txn-88201",
  "amount": 299.99
}
```

### The Workflow: From Trace to Logs and Back

In Grafana, you can configure a data link between Tempo (traces) and Loki (logs):

1. You see a slow span in Tempo: `payment.processPayment` took 12 seconds.
2. You click the span. Grafana shows a "View Logs" link.
3. The link opens Loki with a pre-filled query: `{service_name="payment-service"} | json | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"`.
4. You see every log line the Payment Service wrote during that specific request.
5. The logs show: "Stripe webhook timeout after 10s, retrying..." --- mystery solved.

This also works in reverse. You find an error in your logs. The log line includes `trace_id`. You click it, and Grafana opens the full trace in Tempo, showing you the complete request flow that led to that error.

> **Analogy:** Think of trace-log correlation like a textbook with footnotes. The main text (the trace) tells you the story at a high level: "The request went here, then here, then here, and this part was slow." The footnotes (the logs) give you the details: "The reason this was slow is because the connection pool was exhausted." Without footnotes, you know *what* happened but not *why*. Without the main text, you have details but no structure. Together, they tell the complete story.

---

## 31.12 Building Custom Dashboards from Trace Data

Traces are not just for debugging individual requests. Aggregated trace data reveals systemic patterns that metrics alone cannot capture.

### Grafana + Tempo: The RED Dashboard

The RED method (Rate, Errors, Duration) applied to trace data gives you a service-level health dashboard:

```
Grafana Dashboard: "Service Health — Derived from Traces"

Panel 1: Request Rate by Service (TraceQL)
  Query: { } | rate() by (resource.service.name)
  Visualization: Time series, stacked

Panel 2: Error Rate by Service
  Query: { status = error } | rate() by (resource.service.name)
  Visualization: Time series with threshold at 0.5%

Panel 3: P95 Latency by Service
  Query: { } | quantile_over_time(duration, 0.95) by (resource.service.name)
  Visualization: Time series with threshold at 2s

Panel 4: Slowest Endpoints (Top 10)
  Query: { } | avg(duration) by (name) | top(10)
  Visualization: Bar chart, horizontal

Panel 5: Service Dependency Map
  Query: (Derived from trace parent-child relationships)
  Visualization: Node graph showing service-to-service call patterns
```

The **Service Dependency Map** is particularly powerful. By analyzing the parent-child relationships between spans across services, Grafana can automatically draw a graph showing which services call which other services, how often, and the error rate of each connection. You did not write any code for this --- it is derived entirely from trace data.

### Identifying N+1 Query Patterns from Traces

One of the most valuable uses of trace data is spotting N+1 query problems. If a single request generates 50 `pg.query SELECT` spans, that is an N+1 problem. You can build a Grafana alert:

```
Alert: "N+1 Query Detection"
Query: count of spans where name = "pg.query" grouped by trace_id > 20
Condition: Any trace with more than 20 database queries
Severity: Warning
```

This catches performance problems that metrics alone would miss. The overall latency might look fine (each query is fast), but the cumulative overhead of 50 queries adds up.

---

## 31.13 Performance Overhead: Measurement and Tuning

Every span you create has a cost: CPU time to construct it, memory to buffer it, network bandwidth to export it. How much cost?

### Benchmarking the Overhead

```typescript
// benchmark/tracing-overhead.ts
import { performance } from 'perf_hooks';

async function benchmarkWithout(): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    await simulateBookingLogic();
  }
  return performance.now() - start;
}

async function benchmarkWith(): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) {
    await withSpan({ name: 'benchmark.operation' }, async (span) => {
      span.setAttribute('iteration', i);
      await simulateBookingLogic();
    });
  }
  return performance.now() - start;
}

// Typical results on a c5.xlarge EC2 instance:
// Without tracing: 10,000 iterations in 2,340ms (0.234ms/op)
// With tracing:     10,000 iterations in 2,520ms (0.252ms/op)
// Overhead: ~7.7% in CPU time, ~0.018ms per span
```

The overhead is roughly **0.02ms per span** and **5-10% total CPU** at high throughput. For most services, this is negligible. But there are ways to reduce it if needed.

### Tuning for Lower Overhead

| Technique                          | Impact                    | Trade-off                              |
|------------------------------------|---------------------------|----------------------------------------|
| Increase `BatchSpanProcessor` batch size | Less frequent exports, lower network overhead | Higher memory usage, delayed visibility |
| Reduce span attribute count        | Less serialization work per span | Less debugging detail                  |
| Use `TraceIdRatioBasedSampler(0.1)` | 90% fewer spans created and exported | Miss 90% of traces                    |
| Disable `enhancedDatabaseReporting` | No SQL text serialization | Cannot see query text in spans         |
| Use gRPC exporter instead of HTTP  | More efficient serialization (protobuf vs JSON) | Requires gRPC infrastructure  |
| Increase `scheduledDelayMillis`    | Less frequent export batches | Longer delay before traces appear      |

```typescript
// Production-tuned BatchSpanProcessor
const spanProcessor = new BatchSpanProcessor(traceExporter, {
  maxQueueSize: 4096,           // Larger buffer for high throughput
  maxExportBatchSize: 1024,     // Bigger batches, fewer network calls
  scheduledDelayMillis: 10000,  // Export every 10s instead of 5s
  exportTimeoutMillis: 30000,
});
```

> **Common Mistake:** Over-instrumenting internal helper functions. If your `createBooking` method calls `validateInput()`, `sanitizeData()`, `calculatePrice()`, and `formatResponse()`, you do not need a span for each one. Span the business-meaningful operations (check availability, process payment, save booking) and skip the utility functions. Each unnecessary span adds overhead and noise. Aim for 5-15 spans per trace in a typical request, not 50.

---

## 31.14 Debugging a Production Issue with Traces: A Step-by-Step Walkthrough

Let us walk through a real debugging session. This is the scenario: the on-call engineer receives an alert at 2:17 AM.

**Alert:** `BookingLatencyP99 > 5s for 3 minutes. Service: booking-service. Region: eu-west-1.`

### Step 1: Confirm the Problem (30 seconds)

Open the Grafana "Booking Overview" dashboard. The P99 latency panel shows a spike starting at 2:14 AM, climbing from 1.8s to 7.2s. Only eu-west-1 is affected; us-east-1 and ap-southeast-1 are normal.

### Step 2: Find an Affected Trace (60 seconds)

Switch to the Grafana Explore view with Tempo as the data source. Query:

```
{ resource.service.name = "booking-service" && duration > 5s }
```

Results show 47 traces in the last 5 minutes with duration over 5 seconds. Click the first one.

### Step 3: Analyze the Trace (2 minutes)

```
Trace ID: 9a3f1b2c4d5e6f7a8b9c0d1e2f3a4b5c   Duration: 7.2s

booking-service     createBooking                   |=====================================| 7200ms
  inventory-svc     checkAvailability               |==|                                    180ms
  payment-service   processPayment                     |==============================|    6800ms
    payment-service stripe.createCharge                 |====|                              320ms
    payment-service db.query INSERT transactions        |                             |==| 6100ms
      attributes:
        db.statement: "INSERT INTO transactions ..."
        db.system: "postgresql"
        net.peer.name: "payment-db-eu-west.cluster-xyz.eu-west-1.rds.amazonaws.com"
```

The trace reveals the bottleneck instantly: a single `INSERT INTO transactions` query is taking 6.1 seconds. The Stripe API call was fast (320ms). The database write is the problem.

### Step 4: Investigate the Database (2 minutes)

The span shows the database host: `payment-db-eu-west`. Check the infrastructure dashboard for that database. CPU: 94%. Active connections: 147 out of 150 max. Write IOPS: pegged at the provisioned limit.

The database is overloaded. But why? It was fine yesterday.

### Step 5: Correlate with Logs (1 minute)

Click "View Logs" on the slow span. Loki shows:

```
2026-02-15T02:13:55Z [payment-service] WARN: Connection pool wait time: 4200ms
2026-02-15T02:14:01Z [payment-service] WARN: Connection pool wait time: 5800ms
2026-02-15T02:13:22Z [payment-service] INFO: Batch reconciliation job started (nightly)
```

A nightly batch reconciliation job kicked off at 2:13 AM, saturating the database connection pool and IOPS.

### Step 6: Mitigate (3 minutes)

Kill the batch reconciliation job. Within 60 seconds, the connection pool drains, IOPS drop, and P99 latency returns to 1.8s.

### Step 7: Follow Up (Next Day)

Create a ticket: "Move batch reconciliation job to read replica. Current behavior saturates the primary database connection pool."

**Total time from alert to mitigation: under 10 minutes.** Without distributed tracing, this same investigation would have taken 45 minutes to an hour --- most of it spent grepping logs across services to find which query was slow and which database was overloaded.

---

## 31.15 Production War Stories

### War Story 1: The Vanishing Traces Across Async Boundaries

> **Production War Story:** A team launched a new service that processed booking confirmations asynchronously via a Bull queue (Redis-based). Everything looked fine in staging --- traces were complete, spans connected properly. In production, the confirmation processing spans were completely disconnected from the booking traces. Every confirmation appeared as an orphaned root span.
>
> The root cause: Bull serializes job data to JSON and stores it in Redis. The team passed the booking data as the job payload but forgot to include the trace context. When the worker picked up the job, there was no `traceparent` to extract.
>
> The fix: before enqueuing a job, inject the trace context into the job payload:
>
> ```typescript
> const carrier: Record<string, string> = {};
> propagation.inject(context.active(), carrier);
> await queue.add('confirm-booking', {
>   ...bookingData,
>   _traceContext: carrier,  // <-- Carry trace context in the job payload
> });
> ```
>
> On the worker side, extract it before processing:
>
> ```typescript
> worker.process('confirm-booking', async (job) => {
>   const ctx = propagation.extract(ROOT_CONTEXT, job.data._traceContext);
>   await context.with(ctx, async () => {
>     // Now spans created here link back to the original booking trace
>     await processConfirmation(job.data);
>   });
> });
> ```
>
> This pattern applies to any async boundary: Bull, BullMQ, custom Redis queues, SQS, delayed jobs, scheduled tasks. If work crosses a process or time boundary, you must manually carry trace context.

### War Story 2: The 1% Sampler That Missed Every Error

> **Production War Story:** A team set their sampler to `TraceIdRatioBasedSampler(0.01)` --- 1% sampling. Their booking system handled 50,000 bookings per minute, producing 1.5 million spans per minute. At 1%, they stored 15,000 spans per minute --- very manageable.
>
> Then a payment provider started returning intermittent errors affecting 0.3% of transactions. The team went to Jaeger to investigate and found... nothing. Out of the 150 errors per minute, the 1% sampler only kept about 1-2 of them. With a 30-second investigation window, they often had zero error traces to examine.
>
> The fix: switch to tail-based sampling in the OpenTelemetry Collector with an "always keep errors" policy. After the switch, every single error trace was preserved. The base sampling rate for healthy traces stayed at 1%, keeping storage costs the same. But the team never again missed an error trace.

### War Story 3: The $47,000 Monthly Tracing Bill

> **Production War Story:** A team adopted a commercial tracing backend (Datadog APM) and instrumented every service enthusiastically. They traced HTTP calls, database queries, Redis commands, internal function calls, and even config lookups. Their average trace had 85 spans. At 200,000 requests per minute, they ingested 17 million spans per minute.
>
> The first monthly bill arrived: $47,000. For tracing alone. The CTO was not amused.
>
> The team audited their spans and found:
> - 40% of spans were from Redis `GET` commands for cached config values (the same config, read 200,000 times per minute). They added `ignoreIncomingRequestHook` to skip these.
> - 25% of spans were from health check endpoints being called by Kubernetes probes every 10 seconds across 300 pods. They filtered these in the HTTP instrumentation.
> - 15% of spans were from internal utility functions that added no debugging value. They removed those manual spans.
>
> After cleanup, their average trace had 12 spans. Their monthly bill dropped to $6,800. The debugging experience actually *improved* because there was less noise to wade through.

---

## 31.16 Common Mistakes and Anti-Patterns

| Mistake                                          | Why It Hurts                                                      | What to Do Instead                                            |
|--------------------------------------------------|-------------------------------------------------------------------|---------------------------------------------------------------|
| Tracing file loaded after app modules            | Auto-instrumentation silently fails; no HTTP or DB spans appear   | Import `./tracing` as the very first line of `main.ts`        |
| No sampling configured                           | Storage costs explode; tracing backend becomes slow and unusable  | Start with 10% head-based; graduate to tail-based for errors  |
| Forgetting context propagation across Kafka/queues | Consumer spans are orphaned; traces end at the producer           | Manually inject/extract using `propagation.inject/extract`    |
| PII in span attributes                           | User emails, card numbers stored in your tracing backend          | Sanitize attributes; disable `enhancedDatabaseReporting` for sensitive services |
| Over-instrumenting utility functions              | 80+ spans per trace; noise drowns signal; high overhead           | Instrument business operations only (5-15 spans per request)  |
| Using `SimpleSpanProcessor` in production         | Every span blocks request processing during export                | Always use `BatchSpanProcessor` with tuned buffer sizes       |
| Not filtering health check endpoints             | Thousands of useless health-check traces per hour                 | Use `ignoreIncomingRequestHook` to skip `/health`, `/ready`   |
| Hardcoding service names                          | All pods report the same generic name; cannot filter by service   | Use `OTEL_SERVICE_NAME` env var, set per deployment           |
| Not setting `span.end()` in all code paths       | Spans leak; memory grows; buffer fills; export stops              | Always call `span.end()` in a `finally` block or use `withSpan` |
| Ignoring `tracestate` header                     | Breaks interop with other tracing vendors in the call chain       | Let the propagator handle `tracestate` automatically          |
| Creating new tracers per request                 | Unnecessary object creation; GC pressure                          | Create tracer once at module level; reuse across requests     |
| Not correlating traces with logs                 | Two observability tools that cannot reference each other           | Inject `trace_id` and `span_id` into every structured log    |

> **Common Mistake:** Treating distributed tracing as a "set it up once and forget it" project. Tracing requires ongoing care: reviewing sampling rates as traffic grows, pruning noisy spans, updating instrumentation when services change, and rotating storage. Budget at least one engineering day per quarter for tracing hygiene. The teams that maintain their tracing setup find bugs in minutes. The teams that let it rot stop using it entirely and go back to grepping logs.

---

## 31.17 Chapter Summary

You have now covered the full lifecycle of distributed tracing, from the motivation ("why are my logs useless across services?") through production-grade implementation. Here is a reference table of every concept in this chapter.

| Concept                          | One-Sentence Summary                                                                                             |
|----------------------------------|------------------------------------------------------------------------------------------------------------------|
| Distributed tracing              | Recording a request's complete journey across services using a shared trace ID.                                  |
| Trace                            | A tree of spans sharing one trace ID, representing one user request end to end.                                  |
| Span                             | A timed, named operation with attributes, status, and parent-child relationships.                                |
| Context propagation              | The mechanism that passes trace ID and parent span ID across service boundaries (HTTP headers, Kafka headers, gRPC metadata). |
| OpenTelemetry                    | The vendor-neutral industry standard for instrumenting code with traces, metrics, and logs.                      |
| `traceparent` header             | W3C standard header carrying version, trace ID, parent span ID, and sampling flags.                             |
| Auto-instrumentation             | Libraries that automatically create spans for HTTP, database, Redis, and gRPC calls without manual code.         |
| Manual spans                     | Spans you create explicitly for business logic using `tracer.startActiveSpan()` or the `withSpan` helper.        |
| `withSpan` helper                | A utility function that encapsulates span lifecycle (create, set status, record exception, end) to reduce boilerplate. |
| Kafka context propagation        | Manually injecting trace context into Kafka message headers on the producer side and extracting on the consumer side. |
| gRPC context propagation         | Automatic via `GrpcInstrumentation`; trace context travels in gRPC metadata.                                     |
| Baggage API                      | Key-value pairs that propagate across service boundaries for cross-cutting metadata (routing hints, feature flags). |
| Head-based sampling              | Sampling decision made at trace creation; simple but misses rare errors.                                         |
| Tail-based sampling              | Sampling decision made after trace completion; keeps all errors and slow traces but requires more infrastructure. |
| Adaptive sampling                | Dynamically adjusts sampling rate based on traffic volume.                                                       |
| SQL Commenter                    | Appends trace context as a SQL comment so slow-query logs can be correlated with traces.                         |
| Prisma instrumentation           | OpenTelemetry integration for Prisma ORM via `@prisma/instrumentation` package.                                  |
| Trace-log correlation            | Injecting trace ID and span ID into structured logs so you can jump between traces and logs.                     |
| RED dashboards from traces       | Deriving Rate, Error, and Duration metrics from aggregated trace data in Grafana.                                |
| Performance overhead             | Approximately 0.02ms per span and 5-10% CPU overhead; tunable via batching, sampling, and attribute reduction.   |
| `BatchSpanProcessor`             | Buffers spans in memory and exports in bulk; essential for production performance.                                |
| Service dependency map           | A graph derived from trace data showing which services call which, with error rates and throughput.               |

> **Checkpoint:** You receive a Slack message: "Users in Europe are seeing slow bookings. Can you investigate?" Walk through your process. Where do you start? (Grafana dashboard to confirm the latency spike and narrow the region.) What do you search for in Tempo? (Traces from `booking-service` in `eu-west` with duration > 5 seconds.) You find a trace with a 6-second database query in the payment service. How do you see the exact SQL? (Click the `pg.query` span and read the `db.statement` attribute. If using SQL Commenter, the trace ID is embedded in the query itself.) How do you check if this is a one-off or a pattern? (Query Tempo for all traces with `payment-service` spans > 3 seconds in the last hour. Check the count.) If you can answer all of these, you are ready to operate a production tracing system.

---

*Next chapter: Chapter 32 explores SLOs and SLIs --- how to define, measure, and enforce the reliability promises your system makes to its users, and how error budgets turn "should we ship this?" into a math problem instead of a debate.*
