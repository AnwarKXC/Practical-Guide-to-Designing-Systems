# Part 8: Observability & Operations

---

# Chapter 30: Monitoring & Alerting — Eyes on the Dashboard

## How You Monitor Things Today

Be honest. Right now, when you want to know if your Express app is working, you open the terminal and look for `console.log` output. Maybe you sprinkle in a few `console.error` calls for the scary parts. When a user reports something broken, you SSH into the server, scroll through a wall of text, squint at timestamps, and hope you find the line that explains what happened.

For a single application running on a single server, this works. Barely. But here is the thing: our booking platform is not a single application on a single server. It is 7 services running across 50+ containers spread across multiple regions. When bookings start failing at 2 AM, you cannot open 50 terminal windows and scroll through logs on each one. You need a dashboard. You need numbers. You need alerts that wake you up before your users start tweeting.

This chapter is about building that dashboard.

> **Analogy:** Think of your car's dashboard. You do not drive by opening the hood every five minutes to check the engine temperature, oil pressure, and fuel level. Instead, those readings are continuously measured by sensors and displayed on gauges right in front of you. If something goes wrong -- the engine overheats, the oil pressure drops, the fuel runs low -- a warning light turns on. You might even hear a beep. That is monitoring and alerting. Prometheus is the collection of sensors. Grafana is the dashboard with gauges. Alert rules are the warning lights and beeps. Without them, you are driving blind at 200 km/h.

## The Three Pillars of Observability

Before we dive into code, let us establish the vocabulary. Observability in distributed systems rests on three pillars:

> **Key Term:** **Metrics** — Numeric measurements collected over time. "How many bookings per second?" "What is the average response time?" "How much memory is each container using?" Metrics are cheap to collect, cheap to store, and great for dashboards and alerts. They tell you *what* is happening.

> **Key Term:** **Logs** — Timestamped text records of discrete events. "User U-881 created booking BK-55012 at 14:03:22." You already know logs from `console.log`. In a distributed system, you aggregate logs from all services into a central system (like the ELK stack or Loki) so you can search them in one place. Logs tell you *why* something happened.

> **Key Term:** **Traces** — Records of a single request's journey across multiple services. "This booking request started at the API Gateway, went to the Booking Service, then to Inventory, then to Payment, and took 1.8 seconds total." Traces tell you *where* time was spent. We will cover these in depth in Chapter 31.

This chapter focuses on the first pillar: **metrics**. Specifically, how to collect them with Prometheus and visualize them with Grafana.

## Why console.log Fails at Scale

Let us make the problem concrete. Suppose you add logging to your booking endpoint:

```typescript
// The approach you know: console.log everything
app.post('/api/bookings', async (req, res) => {
  console.log('Booking request received', req.body);

  const start = Date.now();
  const booking = await createBooking(req.body);
  const duration = Date.now() - start;

  console.log(`Booking created in ${duration}ms`, booking.id);
  res.status(201).json(booking);
});
```

This gives you individual data points. "Booking X took 450ms." But it cannot answer aggregate questions:

- What is the **average** booking creation time over the last 5 minutes?
- What percentage of bookings are **failing** right now?
- Is latency **trending upward** over the past hour?
- How many bookings have we processed **today** compared to yesterday?

To answer those questions from `console.log`, you would need to parse thousands of log lines, extract numbers, and calculate statistics. Every time you want an answer. In real time. That is not sustainable.

Metrics solve this. Instead of logging text, you increment counters, update gauges, and record measurements into a system designed for exactly these aggregate queries.

## Prometheus: The Metrics Engine

Prometheus is an open-source monitoring system. Here is how it works in plain terms:

1. Your application exposes a `/metrics` endpoint that returns current measurements in a specific text format.
2. Prometheus scrapes (fetches) that endpoint every 15 seconds.
3. Prometheus stores the data in a time-series database.
4. You query the data using a language called PromQL.
5. Grafana connects to Prometheus and draws charts from those queries.

The important mental shift: **your application does not push metrics to Prometheus. Prometheus pulls them from your application.** Your app just keeps a running tally and serves it when asked.

### The Three Metric Types You Need to Know

Prometheus has several metric types, but three cover 90% of what you will use:

| Metric Type   | What It Does                                   | Example                                      | Analogy                                   |
|---------------|------------------------------------------------|----------------------------------------------|-------------------------------------------|
| **Counter**   | A number that only goes up                     | Total bookings created                       | Your car's odometer -- it never goes down |
| **Gauge**     | A number that goes up and down                 | Current payment failure rate                 | Your speedometer -- it changes constantly |
| **Histogram** | Records the distribution of values in buckets  | Booking creation time (how many took <100ms, <500ms, <1s, etc.) | A set of buckets sorting lap times at a race track |

A **counter** answers: "How many total?" Use rate() in PromQL to turn it into "how many per second?"

A **gauge** answers: "What is the current value?" Use it for things like queue depth, active connections, or failure rates.

A **histogram** answers: "What does the distribution look like?" Use it for latencies and sizes. It lets you ask questions like "What is the 95th percentile response time?" -- meaning 95% of requests were faster than this value.

## The Metrics Service: Code Walkthrough

Now let us look at the actual `MetricsService` class from our booking platform. This is the code that defines what we measure.

```typescript
import promClient from 'prom-client';

export class MetricsService {
  private static registry = new promClient.Registry();

  // Booking metrics
  static bookingCreationTime = new promClient.Histogram({
    name: 'booking_creation_duration_seconds',
    help: 'Time to create booking',
    labelNames: ['booking_type', 'status', 'region'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]
  });

  static bookingCounter = new promClient.Counter({
    name: 'bookings_total',
    help: 'Total bookings',
    labelNames: ['booking_type', 'status', 'region']
  });

  static bookingRevenue = new promClient.Counter({
    name: 'booking_revenue_total',
    help: 'Total booking revenue',
    labelNames: ['booking_type', 'currency']
  });

  // Inventory metrics
  static inventoryOversellCounter = new promClient.Counter({
    name: 'inventory_oversell_attempts_total',
    help: 'Oversell attempts prevented',
    labelNames: ['resource_type']
  });

  static lockContentionCounter = new promClient.Counter({
    name: 'lock_contention_total',
    help: 'Lock acquisition failures',
    labelNames: ['resource_type']
  });

  // Payment metrics
  static paymentLatency = new promClient.Histogram({
    name: 'payment_duration_seconds',
    help: 'Payment processing time',
    labelNames: ['provider', 'status'],
    buckets: [0.5, 1, 2, 5, 10]
  });

  static paymentFailureRate = new promClient.Gauge({
    name: 'payment_failure_rate',
    help: 'Payment failure rate (rolling 5 min)',
    labelNames: ['provider']
  });

  // Circuit breaker metrics
  static circuitBreakerState = new promClient.Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
    labelNames: ['service', 'supplier']
  });

  static {
    this.registry.registerMetric(this.bookingCreationTime);
    this.registry.registerMetric(this.bookingCounter);
    this.registry.registerMetric(this.bookingRevenue);
    this.registry.registerMetric(this.inventoryOversellCounter);
    this.registry.registerMetric(this.lockContentionCounter);
    this.registry.registerMetric(this.paymentLatency);
    this.registry.registerMetric(this.paymentFailureRate);
    this.registry.registerMetric(this.circuitBreakerState);

    promClient.collectDefaultMetrics({ register: this.registry });
  }

  static async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }
}
```

Let us break this down piece by piece.

**The Registry.** Think of `promClient.Registry` as a filing cabinet. Every metric you create gets registered (filed) here. When Prometheus scrapes your `/metrics` endpoint, the registry dumps everything it has been tracking.

**Booking metrics.** We track three things about bookings:

- `bookingCreationTime` (Histogram): How long does it take to create a booking? The `buckets` array -- `[0.1, 0.25, 0.5, 1, 2, 5, 10, 30]` -- defines time boundaries in seconds. After collecting data, you can ask: "What percentage of bookings complete in under 500ms?" or "What is the 99th percentile creation time?" The `labelNames` let you slice the data by `booking_type` (hotel, flight, car), `status` (success, failure), and `region` (us-east, eu-west).

- `bookingCounter` (Counter): The total number of bookings ever attempted. By applying PromQL's `rate()` function, you turn this into "bookings per second." By filtering on the `status` label, you can calculate success rates.

- `bookingRevenue` (Counter): Total revenue processed. This is a business metric. Engineering dashboards track latency and errors; executive dashboards track revenue. Same Prometheus. Different Grafana dashboard.

**Inventory metrics.** Two counters track dangerous situations:

- `inventoryOversellCounter`: How many times did the system prevent a double-booking? If this counter is incrementing rapidly, something is wrong with your locking strategy.
- `lockContentionCounter`: How many times did a service fail to acquire a distributed lock? High contention means too many concurrent requests fighting over the same resource.

**Payment metrics.** Two metrics cover the money flow:

- `paymentLatency` (Histogram): How long do payment provider calls take? Notice the buckets start at 0.5 seconds -- payment APIs are inherently slower than internal service calls.
- `paymentFailureRate` (Gauge): The current failure rate for each payment provider, recalculated every 5 minutes. A gauge because this value goes up and down.

**Circuit breaker metrics.** A gauge that reports 0 (closed/healthy), 0.5 (half-open/testing), or 1 (open/tripped). If you see this go to 1, a downstream service has been cut off because it was failing too much. You learned about circuit breakers in earlier chapters; this is how you monitor them.

**Default metrics.** The line `promClient.collectDefaultMetrics(...)` automatically tracks Node.js internals: event loop lag, heap usage, active handles, garbage collection duration. You get these for free.

### The Metrics Endpoint

Every service exposes a `/metrics` HTTP endpoint that Prometheus scrapes:

```typescript
// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', MetricsService.registry.contentType);
  res.end(await MetricsService.getMetrics());
});
```

When Prometheus hits this endpoint, it gets back something like:

```
# HELP bookings_total Total bookings
# TYPE bookings_total counter
bookings_total{booking_type="hotel",status="success",region="us-east"} 142857
bookings_total{booking_type="hotel",status="failure",region="us-east"} 312
bookings_total{booking_type="flight",status="success",region="eu-west"} 98421

# HELP booking_creation_duration_seconds Time to create booking
# TYPE booking_creation_duration_seconds histogram
booking_creation_duration_seconds_bucket{le="0.1"} 45000
booking_creation_duration_seconds_bucket{le="0.25"} 89000
booking_creation_duration_seconds_bucket{le="0.5"} 120000
...
```

Plain text. Human-readable. Every metric, every label combination, every bucket. Prometheus parses this, stores it, and makes it queryable.

## Grafana: The Visual Dashboard

Prometheus stores the data. Grafana draws the pictures. You connect Grafana to Prometheus as a data source, then build dashboards with panels. Each panel runs a PromQL query and displays the result as a graph, gauge, or table.

Here are the dashboards you would build for our booking platform:

| Dashboard            | Key Panels                                                         | Who Watches It        |
|----------------------|--------------------------------------------------------------------|-----------------------|
| **Booking Overview** | Bookings/sec, success rate, P99 latency, revenue/min              | Engineering + Product |
| **Payment Health**   | Payment latency by provider, failure rate, circuit breaker states  | Engineering           |
| **Infrastructure**   | CPU, memory, pod count, database connections, Kafka lag            | Platform/SRE team     |
| **Business KPIs**    | Revenue by region, bookings by type, cancellation rate             | Executives            |

You do not need to memorize PromQL syntax right now. The key insight is that the same metrics data powers every dashboard. Engineers care about P99 latency. Product managers care about conversion rates. Executives care about revenue. All from the same Prometheus metrics, just sliced differently.

## Alert Rules: The Warning Lights

Collecting metrics is useless if nobody looks at the dashboard. Alerts solve this. An alert rule is a PromQL query with a threshold: "If this condition is true for X minutes, notify someone."

Our platform defines three tiers of alerts:

### Critical Alerts -- Wake Someone Up

These represent active damage. Users are being affected right now. Someone gets paged immediately.

```typescript
export const alertRules = {
  critical: [
    {
      name: 'BookingSuccessRateCritical',
      expr: 'rate(bookings_total{status="success"}[5m]) / rate(bookings_total[5m]) < 0.995',
      for: '2m',
      severity: 'critical',
      annotations: {
        summary: 'Booking success rate below 99.5%',
        runbook: 'https://runbooks.company.com/booking-failures'
      }
    },
    {
      name: 'InventoryOversellDetected',
      expr: 'increase(inventory_oversell_attempts_total[1m]) > 0',
      for: '0s',
      severity: 'critical',
      annotations: { summary: 'Inventory oversell detected' }
    },
    {
      name: 'PaymentGatewayDown',
      expr: 'up{job="payment-gateway"} == 0',
      for: '1m',
      severity: 'critical'
    },
    {
      name: 'DatabasePrimaryDown',
      expr: 'mysql_up{role="primary"} == 0',
      for: '30s',
      severity: 'critical'
    },
    {
      name: 'KafkaBrokerDown',
      expr: 'kafka_broker_online{} == 0',
      for: '2m',
      severity: 'critical'
    }
  ],
```

Let us unpack the first rule. `BookingSuccessRateCritical` divides the rate of successful bookings over 5 minutes by the total rate of bookings over 5 minutes. If the result drops below 0.995 (99.5%), and it stays that low for 2 minutes (the `for` field), a critical alert fires. The `runbook` annotation links to a documented procedure for investigating booking failures -- so the on-call engineer does not have to figure it out from scratch at 3 AM.

`InventoryOversellDetected` fires **instantly** (`for: '0s'`). Any increase in oversell attempts, even by one, is a critical event. Double-bookings cost money, damage trust, and require manual intervention. Zero tolerance.

`PaymentGatewayDown`, `DatabasePrimaryDown`, and `KafkaBrokerDown` monitor core infrastructure. If the payment gateway is unreachable for 1 minute, the primary database is down for 30 seconds, or a Kafka broker goes offline for 2 minutes, someone needs to know immediately.

### Warning Alerts -- Investigate Soon

These represent degradation. The system is still working, but something is trending badly.

```typescript
  warning: [
    {
      name: 'PaymentLatencyHigh',
      expr: 'histogram_quantile(0.95, rate(payment_duration_seconds_bucket[5m])) > 2',
      for: '5m',
      severity: 'warning'
    },
    {
      name: 'LockContentionHigh',
      expr: 'rate(lock_contention_total[5m]) > 100',
      for: '10m',
      severity: 'warning'
    },
    {
      name: 'DatabaseReplicationLag',
      expr: 'mysql_slave_lag_seconds > 30',
      for: '3m',
      severity: 'warning'
    }
  ],
```

`PaymentLatencyHigh` fires when the 95th percentile payment duration exceeds 2 seconds for 5 minutes straight. Users are still getting charged, but they are waiting too long. `LockContentionHigh` fires when more than 100 lock failures per second persist for 10 minutes -- the system is under too much concurrent pressure. `DatabaseReplicationLag` fires when read replicas fall more than 30 seconds behind the primary -- users might see stale data.

### Info Alerts -- Good to Know

These are for awareness, not urgency.

```typescript
  info: [
    {
      name: 'BookingVolumeSpike',
      expr: 'rate(bookings_total[5m]) > avg_over_time(rate(bookings_total[5m])[1h]) * 1.5',
      for: '10m',
      severity: 'info'
    }
  ]
};
```

`BookingVolumeSpike` fires when you are getting 50% more bookings than your hourly average. This is not a problem -- it might be a marketing campaign or a viral moment. But the team should know, because if it continues, you might need to scale up.

> **What If You Skip This?** Without monitoring and alerting, you learn about outages from angry users on social media. By the time someone tweets "your site is broken," hundreds or thousands of bookings have already failed. With proper alerting, you know within 2 minutes. That difference -- minutes versus hours -- can mean the difference between a minor blip and a front-page incident.

## Chapter 30 Summary

| Concept              | One-Sentence Summary                                                                           |
|----------------------|-----------------------------------------------------------------------------------------------|
| Observability        | The ability to understand a system's internal state from its external outputs (metrics, logs, traces). |
| Prometheus           | A pull-based monitoring system that scrapes `/metrics` endpoints and stores time-series data.  |
| Counter              | A metric that only increases -- use `rate()` to derive per-second values.                     |
| Gauge                | A metric that goes up and down -- represents current state like failure rate or temperature.   |
| Histogram            | A metric that sorts values into buckets -- use for latency percentiles.                       |
| Grafana              | A dashboarding tool that visualizes Prometheus data as charts, gauges, and tables.             |
| Alert tiers          | Critical (wake someone up), Warning (investigate soon), Info (good to know).                  |
| Runbooks             | Documented procedures linked from alerts so on-call engineers know what to do.                |

> **Checkpoint:** Without scrolling back, can you explain the difference between a counter and a gauge? Can you give one example of each from our booking system? If you can also explain what a histogram's "buckets" do, you have nailed this chapter.

---

# Chapter 31: Distributed Tracing — Following the Breadcrumbs

## The console.log Debugging Problem

You know how to debug a bug in your Express app. You add `console.log` statements, run the request, and read the output top to bottom. The log shows you exactly what happened, in order, in one place. Simple.

Now imagine this: a user clicks "Book Now" and gets an error. That single click triggered an HTTP request that hit the API Gateway, which called the Auth Service, which validated the token, which let the request through to the Booking Service, which called the Inventory Service to check availability, which called the Payment Service to charge the card. One user action. Five services. Five separate log outputs on five separate containers.

You SSH into the Booking Service logs. You see: "Payment failed for booking BK-55012." But why? You SSH into the Payment Service logs. You see 14,000 log lines from the last minute. Which one is yours? You search for "BK-55012." Nothing -- the Payment Service does not know booking IDs, it only knows transaction IDs. So you go back to the Booking Service logs, find the transaction ID, go back to the Payment Service logs, search for that ID... and eventually piece together what happened. Forty-five minutes later.

This is not sustainable. You need a way to follow a single request across every service it touches, like following breadcrumbs through a forest.

> **Analogy:** When you order a package from an online store, you get a tracking number. That one number follows your package from the warehouse to the truck to the sorting facility to the delivery van to your door. At any point, you can enter that tracking number and see exactly where your package is and where it has been. Distributed tracing gives every request a "tracking number" (called a **trace ID**). No matter how many services the request passes through, that trace ID follows it, and you can look up the full journey in one place.

## Key Concepts: Traces, Spans, and Context

Before we look at code, let us define three terms you will use constantly.

> **Key Term:** **Trace** — The complete record of a single request's journey through the system. One user click = one trace. A trace has a unique ID (the "tracking number") and contains multiple spans.

> **Key Term:** **Span** — A single operation within a trace. "Check availability" is one span. "Process payment" is another span. Each span has a name, a start time, a duration, and a status (OK or ERROR). Spans are nested: the "create booking" span is the parent, and "check availability" and "process payment" are its children.

> **Key Term:** **Context Propagation** — The mechanism by which the trace ID and current span ID are passed from one service to another. When the Booking Service calls the Payment Service via HTTP, it includes the trace ID in a special header (`traceparent`). The Payment Service reads that header and creates its spans under the same trace. Without context propagation, each service would create its own isolated trace, and you could never connect them.

Here is what a trace looks like visually in Jaeger (the tracing UI):

```
Trace ID: abc-123-def-456     Total Duration: 1.8s

API Gateway       |========|                                    200ms
  Auth Service       |====|                                      80ms
  Booking Service        |================================|    1400ms
    Check Availability       |======|                           200ms
    Process Payment                   |=================|       800ms
    Save Booking                                         |===|  150ms
    Publish Event                                            |=| 50ms
```

At a glance, you can see that payment processing took 800ms out of the total 1.8 seconds. That is your bottleneck. No log-grepping required.

## The Tracing Middleware: Code Walkthrough

Our booking platform uses **OpenTelemetry**, the industry-standard library for distributed tracing. OpenTelemetry is vendor-neutral -- it works with Jaeger, Zipkin, Datadog, and others. You instrument your code once, and send traces to whichever backend you choose.

### Setting Up OpenTelemetry

First, you initialize the SDK at application startup. This runs before any request is handled:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'booking-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      || 'http://jaeger.monitoring:4318/v1/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

sdk.start();
```

Let us walk through this.

**Resource.** This tells the tracing backend "who am I?" Every span created by this process will be tagged with `service.name = 'booking-service'`, `service.version = '1.0.0'`, and the current environment (`production`, `staging`, etc.). When you look at a trace in Jaeger, you can see exactly which service version produced each span.

**OTLPTraceExporter.** This is where spans get sent. OTLP (OpenTelemetry Protocol) is the standard wire format. Our exporter sends trace data over HTTP to a Jaeger instance running in the `monitoring` namespace of our Kubernetes cluster.

**Instrumentations.** This is the magic. `HttpInstrumentation` automatically creates spans for every outgoing HTTP request your service makes. When the Booking Service calls the Payment Service, a span is created automatically -- you do not need to write any tracing code for that call. `ExpressInstrumentation` does the same for incoming requests. These two libraries handle context propagation as well: they automatically inject the `traceparent` header into outgoing requests and extract it from incoming ones.

In other words: **just by initializing this SDK, every HTTP call your service makes or receives is traced**. That covers about 80% of what you need. The remaining 20% is custom spans for internal operations.

### Custom Spans: The Traced Booking Service

For operations that are not HTTP calls -- database queries, business logic, internal calculations -- you create custom spans:

```typescript
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('booking-service', '1.0.0');

export class TracedBookingService {
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    const span = tracer.startSpan('createBooking', {
      attributes: {
        'booking.type': dto.bookingType,
        'booking.user_id': dto.userId.toString(),
        'booking.amount': dto.totalAmount
      }
    });

    try {
      return await context.with(
        trace.setSpan(context.active(), span),
        async () => {
          // Child span: Check availability
          const availSpan = tracer.startSpan('checkAvailability');
          const available = await this.inventoryService.checkAvailability(dto);
          availSpan.end();

          if (!available) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'Not available'
            });
            throw new InsufficientInventoryError();
          }

          // Child span: Process payment
          const paySpan = tracer.startSpan('processPayment', {
            attributes: {
              'payment.provider': dto.paymentProvider,
              'payment.amount': dto.totalAmount
            }
          });
          const payment = await this.paymentService.processPayment(dto);
          paySpan.end();

          // Create booking
          const booking = await this.createBookingRecord(dto, payment.id);
          span.setAttribute('booking.id', booking.id.toString());
          span.setStatus({ code: SpanStatusCode.OK });

          return booking;
        }
      );
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
```

This is denser than what you are used to, so let us go through it slowly.

**`tracer.startSpan('createBooking', ...)`** -- This creates a new span named `createBooking`. The `attributes` object attaches metadata: what type of booking, which user, how much money. These attributes are searchable in Jaeger. You can later query "show me all traces where `booking.amount` > 500."

**`context.with(trace.setSpan(context.active(), span), ...)`** -- This is context propagation within a single process. It says: "For everything that runs inside this callback, the current span is `createBooking`." Any child span created inside the callback automatically becomes a child of `createBooking`. Without this, child spans would be orphaned -- they would not know they belong together.

**Child spans.** Inside the callback, we create two child spans: `checkAvailability` and `processPayment`. Each one wraps a specific operation. When you view this trace in Jaeger, you see the parent span with two children nested under it, each showing its own duration. If `processPayment` takes 800ms, you see it instantly.

**`span.setStatus(...)`** -- Marks the span as either OK or ERROR. Jaeger highlights error spans in red, making them easy to spot.

**`span.recordException(error)`** -- Attaches the full error (message, stack trace) to the span. When you click on the error span in Jaeger, you see the exact exception.

**`span.end()`** -- Marks the span as complete and sends it to the exporter. Always call this in a `finally` block for the parent span to ensure it gets recorded even if an exception occurs.

### What This Looks Like in Jaeger

After deploying this code, you open Jaeger's UI, select "booking-service" from the service dropdown, and search for traces. You click on one and see:

```
createBooking          [1.4s] ........................... OK
  checkAvailability    [0.2s] .........                   OK
  processPayment       [0.8s]           ................. OK
  createBookingRecord  [0.15s]                           OK
  publishEvent         [0.05s]                           OK
```

If the booking failed, the error span is highlighted red:

```
createBooking          [0.9s] ........................... ERROR
  checkAvailability    [0.2s] .........                   OK
  processPayment       [0.6s]           .............     ERROR
    stripe-api-call    [0.55s]          ............      ERROR
      "Card declined: insufficient funds"
```

You immediately see: the payment failed because of a declined card, specifically during the Stripe API call. No log searching. No guessing. One click.

> **What If You Skip This?** Without distributed tracing, debugging a production issue in a microservices system is like solving a mystery with the clues scattered across 7 different rooms, with no map telling you which room to check first. Teams without tracing report spending 5-10x longer on incident resolution. The 30 minutes you invest setting up OpenTelemetry will save you hundreds of hours over the life of the system.

## Chapter 31 Summary

| Concept              | One-Sentence Summary                                                                      |
|----------------------|------------------------------------------------------------------------------------------|
| Distributed tracing  | Recording a request's full journey across services with a single trace ID.                |
| Trace                | The complete story of one request, composed of multiple spans.                            |
| Span                 | A timed record of a single operation (checking availability, processing payment, etc.).   |
| Context propagation  | Passing the trace ID from service to service via HTTP headers so spans connect together.  |
| OpenTelemetry        | The vendor-neutral standard library for instrumenting your code with traces.              |
| Jaeger               | A tracing backend and UI where you search, view, and analyze traces.                      |
| Auto-instrumentation | Libraries that automatically create spans for HTTP calls without manual code.             |
| Custom spans         | Spans you create manually for non-HTTP operations like database writes or business logic. |

> **Checkpoint:** Imagine a user reports that their booking took 15 seconds. You open Jaeger and find their trace. The trace shows five spans. Four of them took under 200ms. One -- `processPayment` -- took 14 seconds. Can you explain what each layer of this trace represents (trace vs. span vs. attribute)? Can you explain how the trace ID traveled from the Booking Service to the Payment Service? If yes, you are ready to move on.

---

# Chapter 32: SLOs & SLIs — Promises to Your Users

## Why Uptime Is Not Just "Is It Up?"

Right now, if someone asks you "Is your app working?", you probably answer in binary: yes or no. It is up or it is down. And when it is up, you assume everything is fine.

But "up" is not the same as "working well." Your app can be "up" -- it responds to requests -- but with 5-second response times, a 3% error rate, and stale search results. From the user's perspective, your app is broken. From your server's perspective, everything is green.

This chapter is about defining what "working" actually means, writing those definitions down, and using them to make engineering decisions. It is about replacing gut feelings with math.

> **Analogy:** Think about a train schedule. The train company does not promise that every single train will be on time for eternity. That is impossible -- weather, mechanical issues, track work. Instead, they publish a reliability target: "95% of trains arrive within 5 minutes of scheduled time." That target does two things. First, it sets expectations for passengers: you know the train is usually on time, but occasionally it will be late. Second, it gives the train company a measurable goal. If they drop to 85%, something is wrong and they need to investigate. This is exactly what SLOs do for software. The **SLI** is the measurement ("percentage of trains on time"). The **SLO** is the target ("95%"). The passengers' contract with the train company, with penalties for missing the target, is the **SLA**.

## The Three Letters: SLI, SLO, SLA

These three acronyms are confusingly similar, but they represent distinct concepts. Let us separate them clearly.

> **Key Term:** **SLI (Service Level Indicator)** — The metric you measure. It is a number, derived from real system data. Examples: "the percentage of HTTP requests that return a non-error response," "the 99th percentile booking creation latency," "the maximum database replication lag in seconds." An SLI is a fact. It does not contain a target or a promise.

> **Key Term:** **SLO (Service Level Objective)** — The target you set for an SLI. It is the number you promise to maintain. Examples: "99.99% of requests return non-error responses," "P99 booking latency is under 2 seconds," "replication lag stays under 5 seconds." An SLO is an internal goal. Your team decides it.

> **Key Term:** **SLA (Service Level Agreement)** — A formal contract with your customers that includes consequences for missing the target. "We guarantee 99.9% uptime. If we miss it, affected customers receive a 10% credit." SLAs are legal documents, usually weaker than SLOs (you set your internal target higher than what you promise externally, giving yourself a safety margin).

Here is a simple way to remember:

| Concept | Question It Answers      | Who Sets It      | Example                          |
|---------|--------------------------|------------------|----------------------------------|
| SLI     | What are we measuring?   | Engineering      | Success rate of HTTP responses   |
| SLO     | What target do we aim for? | Engineering    | 99.99% success rate              |
| SLA     | What do we promise customers? | Business + Legal | 99.9% uptime or credits apply  |

Notice the SLA (99.9%) is lower than the SLO (99.99%). That gap is your safety buffer. You aim for four nines internally so that even if you slip, you still meet your three-nine customer promise.

## Our Booking Platform's SLOs

Here are the SLO definitions for our global booking system. Each one pairs an SLI (what we measure) with an SLO (what we target).

```typescript
export const sloDefinitions = {
  availability: {
    sli: 'Percentage of successful HTTP responses (non-5xx) over total requests',
    slo: 0.9999,  // 99.99%
    errorBudget: {
      monthly: 4.32,        // minutes
      quarterly: 12.96,     // minutes
      yearly: 52.56         // minutes
    },
    measurement: 'rate(http_responses_total{status!~"5.."}[30d]) '
               + '/ rate(http_responses_total[30d])'
  },

  bookingLatency: {
    sli: 'P99 latency for successful booking creation',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.99, '
               + 'rate(booking_creation_duration_seconds_bucket'
               + '{status="success"}[5m]))'
  },

  paymentLatency: {
    sli: 'P95 latency for payment processing',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.95, '
               + 'rate(payment_duration_seconds_bucket[5m]))'
  },

  searchLatency: {
    sli: 'P99 latency for search queries',
    slo: 0.5,  // 500ms
    measurement: 'histogram_quantile(0.99, '
               + 'rate(search_duration_seconds_bucket[5m]))'
  },

  inventoryAccuracy: {
    sli: 'Percentage of bookings without oversell incidents',
    slo: 0.99999,  // 99.999%
    measurement: '1 - (rate(inventory_oversell_attempts_total[30d]) '
               + '/ rate(bookings_total[30d]))'
  },

  dataFreshness: {
    sli: 'Maximum replication lag across all database replicas',
    slo: 5,  // 5 seconds
    measurement: 'max(mysql_slave_lag_seconds)'
  }
};
```

Let us read through these one by one.

**Availability (99.99%).** This is the big one. Out of every 10,000 requests, at most 1 can be a server error (5xx). This is measured over a rolling 30-day window. Why 99.99% and not 100%? Because 100% is mathematically impossible in a distributed system. Hardware fails. Networks partition. Deploys occasionally introduce bugs. The question is not "will we have errors?" but "how many errors can we tolerate?"

**Booking latency (P99 under 2 seconds).** 99% of successful bookings must complete in under 2 seconds. The 1% that take longer are acceptable -- maybe they hit a slow payment provider or a cold cache. But if more than 1% exceed 2 seconds, the user experience is degrading.

**Payment latency (P95 under 2 seconds).** 95% of payments must process in under 2 seconds. We use P95 instead of P99 here because payment providers are external and occasionally slow for reasons outside our control. The slightly looser percentile gives us room.

**Search latency (P99 under 500ms).** Searches must be fast. Users expect near-instant results when they type "hotels in Paris." Even the slowest 1% should resolve in under half a second.

**Inventory accuracy (99.999%).** Out of 100,000 bookings, at most 1 can be an oversell. This is the tightest SLO because oversells have the highest business impact: angry customers, refunds, partner trust damage.

**Data freshness (under 5 seconds).** Read replicas must stay within 5 seconds of the primary database. If replicas fall further behind, users might see stale search results or outdated availability.

## Understanding Error Budgets

Here is where SLOs become a decision-making tool rather than just a number on a dashboard.

> **Key Term:** **Error Budget** — The amount of unreliability your SLO permits. If your SLO is 99.99% availability, your error budget is 0.01% of total time. Over a month (43,200 minutes), that is 4.32 minutes of allowed downtime. You can "spend" this budget on deployments, experiments, planned maintenance -- anything that might cause errors.

Think of it like a monthly spending allowance. You have 4.32 minutes of downtime you can "spend" each month. A risky deployment might "cost" 2 minutes if it causes a brief spike in errors. A database migration might "cost" 1 minute. As long as you stay within budget, you are meeting your SLO.

But if you burn through your error budget early in the month -- say a bad deploy caused 3 minutes of errors on day 5 -- you only have 1.32 minutes left for the remaining 25 days. At that point, the team should **freeze risky changes** and focus on reliability until the budget resets.

This is the power of error budgets: they turn the abstract question "should we ship this risky feature?" into a concrete math problem. "We have 2.1 minutes of budget left this month. This deploy has historically caused 30-second error spikes. We can afford it."

### Error Budget Burn Rate Alerts

To catch budget problems early, we set up burn rate alerts:

```typescript
export const burnRateAlerts = [
  {
    name: 'ErrorBudgetFastBurn',
    description: '2% of monthly error budget consumed in 1 hour',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[1h]) '
        + '/ rate(http_responses_total[1h])) > 14.4 * (1 - 0.9999)',
    severity: 'critical',
    window: '1h'
  },
  {
    name: 'ErrorBudgetSlowBurn',
    description: '5% of monthly error budget consumed in 6 hours',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[6h]) '
        + '/ rate(http_responses_total[6h])) > 6 * (1 - 0.9999)',
    severity: 'warning',
    window: '6h'
  }
];
```

**Fast burn (critical).** If you are burning error budget at a rate that would consume 2% of your monthly budget in just 1 hour, something is actively on fire. At this rate, you will exhaust your entire monthly budget in about 2 days. This triggers an immediate page.

**Slow burn (warning).** If you are burning error budget at a rate that would consume 5% of your monthly budget in 6 hours, something is subtly wrong. Maybe a new deploy introduced a low-rate error, or a database is slightly overloaded. This triggers a warning -- investigate during working hours, but do not ignore it.

Why two alerts? Because a fast burn is obvious (the site is visibly broken), but a slow burn is insidious. A 0.02% error rate looks harmless, but sustained over a week, it eats your entire monthly budget. The slow burn alert catches what human intuition misses.

## Calculating Your Own Availability

Here is the math, simplified so you can do it on the back of an envelope.

**Step 1: Pick your SLO.** Let us say 99.99%.

**Step 2: Calculate your error budget.** Your allowed downtime is: `(1 - SLO) * total_time`.

| Time Period | Total Minutes | Error Budget (at 99.99%) |
|-------------|---------------|--------------------------|
| Monthly     | 43,200        | 4.32 minutes             |
| Quarterly   | 129,600       | 12.96 minutes            |
| Yearly      | 525,600       | 52.56 minutes            |

**Step 3: Track your actual availability.** Count 5xx responses and total responses:

```
Actual availability = (total_requests - 5xx_requests) / total_requests
```

If you served 10,000,000 requests this month and 800 returned 5xx errors:

```
Availability = (10,000,000 - 800) / 10,000,000 = 0.99992 = 99.992%
```

That is above your 99.99% SLO. You still have error budget remaining.

**Step 4: Calculate remaining budget.** Your budget was 4.32 minutes. You consumed (in terms of error fraction): `0.00008 * 43,200 = 3.46 minutes`. You have `4.32 - 3.46 = 0.86 minutes` remaining for the rest of the month.

> **What If You Skip This?** Without SLOs, reliability conversations devolve into gut feelings. "The system feels slow." "I think we had some errors last week." "Are we reliable enough?" Nobody knows. With SLOs, you have a number: "We are at 99.97% this month, which is below our 99.99% target. We have consumed 130% of our error budget. We need to freeze deploys and investigate." That clarity transforms how teams prioritize work.

## Chapter 32 Summary

| Concept        | One-Sentence Summary                                                                   |
|----------------|----------------------------------------------------------------------------------------|
| SLI            | A metric you measure (e.g., percentage of successful responses, P99 latency).          |
| SLO            | A target you set for an SLI (e.g., 99.99% success rate, P99 under 2 seconds).         |
| SLA            | A contractual promise to customers with penalties for missing it.                      |
| Error budget   | The allowed amount of unreliability -- your SLO gap expressed as time or error count.  |
| Fast burn      | Consuming error budget rapidly -- triggers critical alerts for immediate response.      |
| Slow burn      | Consuming error budget gradually -- triggers warnings for investigation.                |
| Budget freeze  | When error budget runs out, freeze risky changes and focus on reliability.              |

> **Checkpoint:** Your SLO is 99.95% monthly availability. How many minutes of downtime can you tolerate in a 30-day month? (Answer: 30 days * 24 hours * 60 minutes = 43,200 minutes. 43,200 * 0.0005 = 21.6 minutes.) If you got that right, you understand the math behind SLOs. If you can also explain why the SLA should be set lower than the SLO, you are thinking like an SRE.

---

# Chapter 33: Incident Response — When Things Go Wrong at 3 AM

## A Story

It is 3:07 AM on a Tuesday. Your phone buzzes on the nightstand. You fumble for it, squinting at the screen. The PagerDuty notification reads:

> **CRITICAL: BookingSuccessRateCritical -- Booking success rate below 99.5%. Firing for 3 minutes. Affected: booking-service, us-east-1.**

Your heart rate jumps. You are the on-call engineer this week. Thousands of users are trying to book hotels right now, and more than half a percent of them are failing. At 100,000 bookings per minute, that is at least 500 failed bookings every minute you are in bed.

What do you do?

If you have never been in this situation, your instinct might be: "I will figure it out." You SSH into a server, look at logs, try things, maybe restart something. That approach works for a side project. For a production system handling real money and real customers, it is chaos. You waste time deciding what to check first. You forget to tell anyone what is happening. You accidentally make things worse because you are half asleep and typing commands from memory.

Incident response is not about heroics. It is about **process**. A well-defined playbook turns a 3 AM panic into a systematic procedure that any trained engineer can execute, even with sleep-deprived judgment.

This chapter is about building that playbook.

## Severity Levels: Not All Fires Are the Same

The first thing you do when an alert fires is determine how bad it is. Not every incident is a "wake the VP" situation. Our platform defines four severity levels:

```typescript
export const incidentResponsePlan = {
  severityLevels: {
    P0: {
      description: 'Complete service outage or data loss',
      examples: [
        'All bookings failing',
        'Database corruption',
        'Payment double-charging'
      ],
      responseTime: '5 minutes',
      notifyChannels: ['PagerDuty', 'Phone Tree', 'Executive Slack'],
      teamRequired: ['On-call engineer', 'Tech Lead', 'VP Engineering'],
      updateFrequency: 'Every 15 minutes'
    },
    P1: {
      description: 'Major feature degradation affecting >10% of users',
      examples: [
        'One region down',
        'Payment provider failing',
        'Search errors'
      ],
      responseTime: '15 minutes',
      notifyChannels: ['PagerDuty', 'Slack #incidents'],
      teamRequired: ['On-call engineer', 'Tech Lead'],
      updateFrequency: 'Every 30 minutes'
    },
    P2: {
      description: 'Minor feature degradation affecting <10% of users',
      examples: [
        'Elevated error rates',
        'Slow responses',
        'One shard degraded'
      ],
      responseTime: '1 hour',
      notifyChannels: ['Slack #incidents'],
      teamRequired: ['On-call engineer'],
      updateFrequency: 'Every 2 hours'
    },
    P3: {
      description: 'Non-urgent issue with workaround available',
      examples: [
        'Monitoring gaps',
        'Non-critical alert noise'
      ],
      responseTime: 'Next business day',
      notifyChannels: ['Slack #platform'],
      teamRequired: ['Assigned engineer'],
      updateFrequency: 'Daily'
    }
  }
};
```

Let us walk through each level.

**P0 -- Everything is on fire.** The entire system is down, or data is being corrupted, or customers are being double-charged. This is the "all hands on deck" scenario. The on-call engineer must acknowledge within 5 minutes. The tech lead and VP of Engineering are notified via phone calls, not just Slack messages. Status updates go out every 15 minutes, even if the update is "still investigating." Examples: the primary database crashed and bookings cannot be saved; a bug in the payment service is charging customers twice; every booking request returns a 500 error.

**P1 -- One limb is broken.** A major part of the system is not working, but not everything. More than 10% of users are affected. The on-call engineer must respond within 15 minutes, and the tech lead joins. Updates go out every 30 minutes. Examples: all bookings in the US-East region are failing (but Europe and Asia are fine); the Stripe payment integration is down (but PayPal still works); search returns errors for flights (but hotel and car search work).

**P2 -- A bruise.** Something is off, but most users are unaffected. Error rates are elevated but below 10%. Response times are high but not catastrophic. The on-call engineer handles it alone, with a 1-hour response window. Examples: one out of 16 database shards is degraded, affecting 6% of bookings; payment latency has doubled but is still under 5 seconds; email confirmations are delayed by 10 minutes.

**P3 -- A paper cut.** There is an issue, but there is a workaround and nobody is actively suffering. Handle it during normal working hours. Examples: a monitoring dashboard is missing a panel; an alert is firing spuriously and needs tuning; a non-critical log aggregator is behind.

### How to Assign Severity

Back to our 3 AM scenario. The alert says booking success rate dropped below 99.5%. Is that a P0 or a P1?

Ask yourself:
1. Are **all** bookings failing, or just some? Check the metrics. If the success rate is 99.2%, that means 0.8% are failing. Not all bookings.
2. Is it affecting **more than 10% of users?** At 0.8% failure rate, no. The vast majority of users are succeeding.
3. Is there **data loss or corruption?** Check the error details. If it is a timeout error, probably not. If it is a "duplicate payment" error, escalate immediately.

In this case, the failure rate (0.5-0.8%) suggests elevated errors but not a total outage. You would likely classify this as **P2** -- elevated error rates, on-call engineer investigates. But if the rate drops below 95%, you escalate to P1 or P0.

The key point: **severity is not set in stone at declaration time.** You can escalate if things get worse, or de-escalate if the impact is smaller than initially feared.

> **Analogy:** Think of incident response like a hospital emergency room. When a patient arrives, the first thing that happens is triage — a nurse assesses severity. A cardiac arrest (P0) gets the entire trauma team immediately. A broken arm (P1) gets seen within minutes by an available doctor. A sprained ankle (P2) waits an hour. A mild headache (P3) is told to see their regular doctor tomorrow. The ER does not treat every patient the same way — and neither should your incident response. The severity determines the speed, the team size, and the communication cadence.

## The Incident Lifecycle: Step by Step

Every incident, regardless of severity, follows the same lifecycle:

### 1. Detection

Something triggers the investigation. It might be a PagerDuty alert (ideal), a customer complaint (less ideal), or a developer noticing something odd (least ideal but still valid). The earlier you detect, the less damage is done.

### 2. Declaration

Someone formally declares the incident. This is not just "I'm looking at it." It is a deliberate act that creates an incident record, notifies the right people, and starts the clock.

```typescript
export class IncidentManager {
  async declareIncident(params: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    title: string;
    description: string;
    affectedServices: string[];
    declaredBy: string;
  }): Promise<Incident> {
    const incident = await db.execute(`
      INSERT INTO incidents (
        severity, title, description, affected_services,
        declared_by, status, declared_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NOW())
    `, [
      params.severity, params.title, params.description,
      JSON.stringify(params.affectedServices), params.declaredBy
    ]);

    const config = incidentResponsePlan.severityLevels[params.severity];

    // Notify appropriate channels
    for (const channel of config.notifyChannels) {
      await this.notify(channel, {
        severity: params.severity,
        title: params.title,
        description: params.description,
        responseTime: config.responseTime
      });
    }

    return { id: incident.insertId, ...params };
  }
}
```

This code does three things: (1) creates a database record of the incident with a timestamp, (2) looks up which channels to notify based on severity, and (3) sends notifications. The record matters because you need a timeline for the post-mortem later.

A real declaration might look like this:

```
Severity: P1
Title: Elevated booking failures in US-East
Description: Booking success rate dropped to 98.7% at 03:07 UTC.
  Errors are timeout-related, concentrated on booking-service
  pods in us-east-1a availability zone.
Affected Services: booking-service, inventory-service
Declared By: Alice (on-call engineer)
```

### 3. Triage and Investigation

Now you actually diagnose the problem. Follow this checklist:

1. **Check dashboards.** Open your Grafana booking overview dashboard. Is the problem confined to one region, one service, one pod?
2. **Check recent changes.** Was there a deployment in the last hour? A configuration change? A database migration? Most incidents are caused by changes.
3. **Check dependencies.** Are downstream services healthy? Is the database responsive? Is Kafka lagging? Use the infrastructure dashboard.
4. **Check traces.** Open Jaeger (Chapter 31). Find a failing request. Where is it failing? What error is it throwing?
5. **Check logs.** Now -- and only now -- look at logs for the specific service and time window you have identified. Searching logs without knowing which service and time range to check is a waste of precious minutes.

### 4. Mitigation

Fix the immediate problem. This is not about finding the root cause -- that comes later. Mitigation is about stopping the bleeding. Common mitigations:

- **Roll back a deployment.** If the last deploy correlates with the errors, revert it.
- **Restart unhealthy pods.** If one pod is misbehaving, kill it and let Kubernetes replace it.
- **Scale up.** If the problem is capacity, add more replicas.
- **Failover.** If a region is unhealthy, shift traffic to other regions.
- **Toggle a feature flag.** If a new feature is causing problems, disable it without a full rollback.

### 5. Communication

Throughout the incident, communicate regularly. Remember the `updateFrequency` from the severity levels: every 15 minutes for P0, every 30 for P1, every 2 hours for P2.

A good status update looks like:

```
INCIDENT UPDATE -- INC-4471 [P1] Elevated booking failures in US-East
Time: 03:45 UTC
Status: Investigating
Current impact: ~1.3% of bookings in US-East failing with timeout errors.
  Other regions unaffected. Estimated 780 failed bookings since start.
Actions taken: Identified correlation with 02:50 UTC deploy of
  booking-service v2.14.3. Rolling back to v2.14.2.
Next update: 04:15 UTC or when rollback completes.
```

This update tells everyone: how bad it is, what is being done, and when the next update comes. Stakeholders can read it and feel informed without interrupting the engineer doing the work.

### 6. Resolution

The incident is resolved when the system returns to normal operation and the metrics confirm it. You mark the incident as resolved, send a final communication, and go back to bed.

### 7. Post-mortem

This is what happens after the fire is out. Within 48 hours, the team writes a post-mortem document that answers:

> **Key Term:** **Post-mortem** — A structured, blameless analysis conducted after an incident is resolved. It documents what happened, why it happened, what went well, what went wrong, and produces specific action items with owners and deadlines. The goal is systemic improvement, not individual blame.

```typescript
  postMortemTemplate: {
    sections: [
      'Incident Summary',
      'Timeline of Events',
      'Root Cause Analysis',
      'Impact Assessment',
      'What Went Well',
      'What Went Wrong',
      'Action Items (with owners and due dates)',
      'Lessons Learned'
    ],
    rules: [
      'Blameless -- focus on systems, not people',
      'Must be completed within 48 hours of resolution',
      'Action items must have owners and deadlines',
      'Reviewed by the team in a group meeting'
    ]
  }
```

The most important rule is the first one: **blameless**. The post-mortem asks "why did the system allow this to happen?" not "who caused this?" If an engineer deployed a bad build, the question is: "Why did our CI/CD pipeline, test suite, and canary deployment not catch this before it reached production?" The system failed, not the person.

Action items must be specific: "Add a circuit breaker to the inventory service call in the booking saga, owned by Bob, due March 22" -- not "improve resilience."

The post-mortem is reviewed in a group meeting so the entire team learns from the incident. Over time, your post-mortem archive becomes the most valuable document in your engineering organization. Patterns emerge. Recurring causes get fixed systemically. The team gets better at building reliable systems.

> **What If You Skip This?** Without incident response processes, every outage is improvised. Engineers waste precious minutes deciding who should investigate, who should communicate, and what to check first. Communication gaps mean stakeholders hear about outages from customers instead of from their own team. Without post-mortems, the same incidents repeat. The team never learns. The person who happened to cause the last outage gets blamed, creating a culture where engineers are afraid to deploy. That fear slows your entire organization.

## Chapter 33 Summary

| Concept             | One-Sentence Summary                                                                |
|---------------------|------------------------------------------------------------------------------------|
| Severity levels     | P0 (total outage) through P3 (paper cut) -- determines response speed and who gets paged. |
| Response time       | The maximum time before an engineer acknowledges a P0 is 5 minutes.                |
| Incident lifecycle  | Detect, Declare, Triage, Mitigate, Communicate, Resolve, Post-mortem.              |
| Communication       | Regular status updates at defined intervals -- even "still investigating" is an update. |
| Mitigation          | Stop the bleeding first (rollback, restart, scale) -- root cause comes later.      |
| Post-mortem         | A blameless analysis completed within 48 hours with specific, owned action items.  |
| Blameless culture   | Ask "why did the system allow this?" not "who did this?" -- fear kills reliability. |

> **Checkpoint:** It is 3 AM. An alert fires: "PaymentGatewayDown, severity critical, firing for 2 minutes." Walk through the first 10 minutes of your response. What severity do you assign? Who do you notify? What dashboards do you check first? What mitigation actions might you take? If you can describe this procedure without looking at notes, you are ready for the real thing.

---

# Chapter 34: Disaster Recovery — Preparing for the Worst

## Thinking Beyond a Single Server

Up until now, most of the problems we have discussed -- a slow query, a crashing pod, a failed payment -- are things that go wrong with individual components. Kubernetes restarts the pod. The circuit breaker trips. You roll back the deploy. Life goes on.

But what happens when an **entire data center goes down**?

This is not hypothetical. In 2017, an Amazon S3 outage in US-East-1 took down a significant portion of the internet for several hours. In 2021, a Facebook configuration change made their DNS unreachable globally for six hours. In 2023, a Microsoft Azure outage knocked out services across the southeastern United States. Data centers lose power. Fiber optic cables get cut by construction crews. Natural disasters flood server rooms.

If your entire booking platform runs in one data center and that data center goes dark, your system is down. Completely. For everyone. Until the data center comes back. You cannot deploy a fix. You cannot restart pods. You cannot do anything except wait.

Disaster recovery is the plan for that scenario. It is not about preventing the disaster -- you cannot prevent an earthquake. It is about ensuring your system **survives** the disaster with minimal data loss and minimal downtime.

> **Analogy:** Think of disaster recovery like fire safety in a building. You cannot guarantee a fire will never happen. But you can install fire exits, sprinkler systems, and fire alarms. You can run fire drills so everyone knows what to do. You can store backup copies of important documents off-site. The goal is not "fires never happen" but "when a fire happens, everyone gets out safely and we can resume operations quickly."

## Two Numbers That Define Your DR Plan

Every disaster recovery plan is built around two targets. These two numbers determine how much you invest in backups, replication, and failover infrastructure.

> **Key Term:** **RPO (Recovery Point Objective)** — How much data can you afford to lose? RPO is measured in time. An RPO of 1 second means that in the worst case, you lose the last 1 second of data. An RPO of 1 hour means you might lose the last hour of transactions. RPO determines your backup and replication strategy.

> **Key Term:** **RTO (Recovery Time Objective)** — How long can your system be down? RTO is measured in time. An RTO of 5 minutes means your system must be serving requests again within 5 minutes of the disaster. An RTO of 24 hours means you have a day to recover. RTO determines your failover strategy.

Here is how to think about the relationship:

| RPO              | What It Means                               | How You Achieve It                           | Cost    |
|------------------|---------------------------------------------|----------------------------------------------|---------|
| 0 seconds        | Zero data loss                              | Synchronous replication to another region     | Very high |
| < 1 second       | Lose at most the last second                | Async replication with sub-second lag         | High    |
| < 1 hour         | Lose at most the last hour                  | Hourly database snapshots                     | Medium  |
| < 24 hours       | Lose at most a day of data                  | Daily backups                                 | Low     |

| RTO              | What It Means                               | How You Achieve It                           | Cost    |
|------------------|---------------------------------------------|----------------------------------------------|---------|
| < 1 minute       | Near-instant recovery                       | Active-active multi-region (traffic shifts)   | Very high |
| < 5 minutes      | Brief interruption                          | Active-passive with automated failover        | High    |
| < 1 hour         | Noticeable outage                           | Standby servers, manual failover              | Medium  |
| < 24 hours       | Extended outage                             | Restore from backups to new infrastructure    | Low     |

For our booking platform, losing even 5 seconds of booking data means confirmed reservations vanish. Customers who were told "your booking is confirmed" suddenly have no booking. That is unacceptable. And 5 minutes of downtime at 100,000 bookings per minute means 500,000 missed bookings. So our targets are aggressive:

## Our Disaster Recovery Plan

```typescript
export const disasterRecoveryPlan = {
  rpo: {
    target: '< 1 second',
    achieved_via: 'Synchronous replication within AZ, async cross-region',
    worst_case: '< 5 seconds (async replication lag)'
  },

  rto: {
    target: '< 5 minutes',
    achieved_via: 'Active-active multi-region with automatic failover',
    steps: [
      'DNS failover detects region health check failure (30s)',
      'Route53 removes unhealthy region from rotation (30s)',
      'Remaining regions absorb traffic (auto-scaled) (2-3 min)',
      'Alert team for investigation'
    ]
  },
```

**RPO: less than 1 second.** Within a single availability zone (a segment of a data center), we use **synchronous replication**: every write to the primary database is simultaneously written to a replica before the write is acknowledged. This means zero data loss for same-AZ failures. Across regions (e.g., US-East to EU-West), we use **asynchronous replication** with a typical lag of less than 1 second. In the absolute worst case -- a sudden regional failure during a replication lag spike -- we might lose up to 5 seconds of data.

**RTO: less than 5 minutes.** We run in **active-active** mode across multiple regions. This means every region is handling real traffic at all times -- not sitting idle as a backup. When one region fails, the recovery steps are:

1. DNS health checks detect the failure within 30 seconds (Route53 pings the health endpoint every 10 seconds and triggers after 3 consecutive failures).
2. Route53 removes the unhealthy region from DNS rotation within 30 seconds.
3. The remaining healthy regions absorb the traffic. Because they are already active and auto-scaled, this takes 2-3 minutes to stabilize (Kubernetes spins up additional pods to handle the increased load).
4. The team is alerted to investigate the failed region.

Total: under 5 minutes from failure to full recovery. And importantly, much of this is **automatic**. The on-call engineer does not need to wake up and push a button for the failover to happen. They get paged to investigate, but the system has already healed itself.

### Failover Procedures

The plan distinguishes between automatic and manual failover:

```typescript
  failoverProcedure: {
    automatic: {
      trigger: 'Route53 health check failure for 3 consecutive checks',
      action: 'Remove region from DNS rotation',
      rollback: 'Re-add region when health checks pass for 5 consecutive checks'
    },

    manual: {
      trigger: 'Operator decision during partial degradation',
      steps: [
        'Assess impact and confirm failover is necessary',
        'Update Route53 weights to shift traffic',
        'Monitor receiving regions for capacity',
        'Investigate and remediate failed region',
        'Gradual traffic restoration (10% -> 50% -> 100%)'
      ]
    }
  },
```

**Automatic failover** handles clear-cut failures: the region is completely unreachable. The health check fails three times, DNS removes it, traffic shifts. When the region recovers and passes 5 consecutive health checks, it is gradually added back.

**Manual failover** is for ambiguous situations: the region is not fully down, but it is degraded. Maybe latency is 10x normal, or error rates are elevated but not catastrophic. An operator assesses the situation, decides to shift traffic manually, and controls the restoration process. The gradual restoration (10% then 50% then 100%) prevents a "thundering herd" where all traffic slams back into a freshly recovered region at once.

## Data Replication Strategy

Different components replicate differently:

```typescript
  dataReplication: {
    database: {
      withinRegion: 'Synchronous (primary -> replica)',
      crossRegion: 'Asynchronous (< 1s typical lag)',
      conflictResolution: 'Fencing token ordering (Section 13)'
    },
    kafka: {
      withinRegion: 'min.insync.replicas = 2',
      crossRegion: 'MirrorMaker 2 for topic replication'
    },
    redis: {
      withinRegion: 'Redis Cluster replication',
      crossRegion: 'Application-level rebuild from database'
    }
  },
```

**Database.** Within a region, synchronous replication ensures zero data loss. Cross-region, asynchronous replication keeps the lag under 1 second typically. In a multi-region active-active setup, two regions might both try to write to the same record, creating a conflict. We resolve conflicts using fencing tokens (a concept covered in an earlier chapter) -- essentially, each write carries a monotonically increasing token, and the highest token wins.

**Kafka.** Within a region, `min.insync.replicas = 2` means every message must be written to at least 2 Kafka brokers before it is acknowledged. If one broker dies, the message still exists on another. Cross-region, MirrorMaker 2 (a Kafka tool) replicates entire topics between Kafka clusters in different regions.

**Redis.** Within a region, Redis Cluster handles replication automatically. Cross-region, we do not replicate Redis. Instead, if a region fails, the Redis cache in the healthy region is rebuilt from the database. Caches are inherently temporary -- losing a cache means a brief performance dip (cache miss = database query) but no data loss.

## DNS-Based Failover: The Health Check

The lynchpin of automatic failover is the health check endpoint. Every region exposes a `/health` URL that Route53 pings:

```yaml
# Route53 Health Check and Failover
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  RegionHealthCheck:
    Type: AWS::Route53::HealthCheck
    Properties:
      HealthCheckConfig:
        FullyQualifiedDomainName: api-us-east-1.bookingplatform.com
        Port: 443
        Type: HTTPS
        ResourcePath: /health
        RequestInterval: 10
        FailureThreshold: 3

  PrimaryDNSRecord:
    Type: AWS::Route53::RecordSet
    Properties:
      HostedZoneId: !Ref HostedZone
      Name: api.bookingplatform.com
      Type: A
      SetIdentifier: us-east-1
      Weight: 35
      HealthCheckId: !Ref RegionHealthCheck
      AliasTarget:
        DNSName: !GetAtt USEastALB.DNSName
        HostedZoneId: !GetAtt USEastALB.CanonicalHostedZoneID
```

Let us read this YAML (it is an AWS CloudFormation template, but you do not need to know CloudFormation -- just read the values).

**RegionHealthCheck.** Route53 sends an HTTPS request to `api-us-east-1.bookingplatform.com/health` every 10 seconds (`RequestInterval: 10`). If 3 consecutive checks fail (`FailureThreshold: 3`), the region is declared unhealthy. That means the region has 30 seconds before it is removed from rotation.

**PrimaryDNSRecord.** The domain `api.bookingplatform.com` resolves to multiple regions using weighted routing. US-East-1 gets a weight of 35 (meaning roughly 35% of traffic). If the health check fails, Route53 automatically removes this record from the DNS response, and all traffic flows to the remaining healthy regions.

What does the `/health` endpoint actually check? A good health endpoint does not just return `{ "status": "ok" }`. It verifies that the service can reach its critical dependencies:

```typescript
// A real health check endpoint
app.get('/health', async (req, res) => {
  const checks = {
    database: false,
    redis: false,
    kafka: false,
  };

  try {
    // Can we query the database?
    await db.query('SELECT 1');
    checks.database = true;
  } catch (e) { /* leave false */ }

  try {
    // Can we reach Redis?
    await redis.ping();
    checks.redis = true;
  } catch (e) { /* leave false */ }

  try {
    // Can we connect to Kafka?
    await kafkaAdmin.describeCluster();
    checks.kafka = true;
  } catch (e) { /* leave false */ }

  const healthy = checks.database && checks.redis && checks.kafka;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
    checks,
    timestamp: new Date().toISOString(),
  });
});
```

If the database is unreachable, the health check returns 503. Route53 sees a non-200 response, counts it as a failure, and after 3 failures, removes the region. This is how the system "knows" to failover.

## Testing Disaster Recovery

A disaster recovery plan that has never been tested is not a plan -- it is a hope. Our testing schedule ensures we validate the plan regularly:

```typescript
  testingSchedule: {
    tableTopExercise: 'Monthly',
    failoverDrill: 'Quarterly',
    fullRegionFailover: 'Annually',
    chaosEngineering: 'Weekly (non-production), Monthly (production)'
  }
```

**Tabletop exercise (monthly).** The team gathers in a room (or video call) and walks through a disaster scenario on paper. "It is Tuesday at 3 PM. US-East-1 loses power. What happens?" Everyone talks through the steps without actually pushing buttons. This reveals gaps in documentation and knowledge.

**Failover drill (quarterly).** You actually trigger a failover in a staging environment that mirrors production. Shift traffic from one region to another and verify that the system handles it correctly. Measure actual RTO and RPO.

**Full region failover (annually).** Once a year, you failover a production region during a planned maintenance window. Real traffic. Real stakes. This is the ultimate test. Netflix famously does this with their "Chaos Monkey" and "Simian Army" tools.

**Chaos engineering (weekly in staging, monthly in production).** Intentionally inject failures -- kill pods, add network latency, fill disks, crash databases -- and verify the system responds correctly. In non-production, you do this weekly to catch regressions. In production, you do it monthly during low-traffic periods with safeguards in place.

> **Key Term:** **Chaos Engineering** — The practice of intentionally injecting controlled failures into a system (killing pods, adding network latency, crashing databases) to verify that recovery mechanisms work correctly. By breaking things on purpose under controlled conditions, you discover weaknesses before real disasters expose them.

> **What If You Skip This?** Without disaster recovery planning, a regional outage means total downtime until the region recovers -- which could be hours or even days. Your data might be lost entirely if it only existed in one region. Your users find competitors. Your business loses revenue and trust. The cost of DR infrastructure is significant, but it is a fraction of the cost of a day-long outage for a system handling 100,000 bookings per minute.

## Chapter 34 Summary

| Concept              | One-Sentence Summary                                                                          |
|----------------------|----------------------------------------------------------------------------------------------|
| RPO                  | Recovery Point Objective -- how much data you can afford to lose (measured in time).          |
| RTO                  | Recovery Time Objective -- how long your system can be down before recovery (measured in time). |
| Active-active        | Running multiple regions simultaneously so failover is just traffic shifting, not cold start. |
| Synchronous replication | Writing to two locations before acknowledging -- zero data loss, higher latency.          |
| Asynchronous replication | Writing to primary first, replicating later -- lower latency, small data loss risk.      |
| DNS failover         | Using health checks to automatically remove unhealthy regions from DNS routing.              |
| Health check endpoint | An API that verifies all critical dependencies (database, cache, queue) are reachable.      |
| Chaos engineering    | Intentionally breaking things in controlled ways to verify your recovery works.              |
| Tabletop exercise    | Walking through disaster scenarios on paper to find gaps before real disasters expose them.   |

> **Checkpoint:** Your booking platform runs in three AWS regions: US-East, EU-West, and AP-Southeast. US-East suddenly loses all network connectivity. Can you describe what happens automatically in the next 5 minutes? (Hint: think about Route53 health checks, DNS weights, and auto-scaling in the remaining regions.) If you can also explain why Redis is not replicated cross-region but the database is, you understand the trade-offs in this chapter.
