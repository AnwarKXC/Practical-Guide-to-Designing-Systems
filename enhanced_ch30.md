# Chapter 30: Monitoring & Alerting — Eyes on the Dashboard

## How You Monitor Things Today

Be honest. Right now, when you want to know if your Express app is working, you open the terminal and look for `console.log` output. Maybe you sprinkle in a few `console.error` calls for the scary parts. When a user reports something broken, you SSH into the server, scroll through a wall of text, squint at timestamps, and hope you find the line that explains what happened.

For a single application running on a single server, this works. Barely. But here is the thing: our booking platform is not a single application on a single server. It is 7 services running across 50+ containers spread across multiple regions. When bookings start failing at 2 AM, you cannot open 50 terminal windows and scroll through logs on each one. You need a dashboard. You need numbers. You need alerts that wake you up before your users start tweeting.

This chapter is about building that dashboard -- and everything behind it.

> **Analogy:** Think of your car's dashboard. You do not drive by opening the hood every five minutes to check the engine temperature, oil pressure, and fuel level. Instead, those readings are continuously measured by sensors and displayed on gauges right in front of you. If something goes wrong -- the engine overheats, the oil pressure drops, the fuel runs low -- a warning light turns on. You might even hear a beep. That is monitoring and alerting. Prometheus is the collection of sensors. Grafana is the dashboard with gauges. Alert rules are the warning lights and beeps. Without them, you are driving blind at 200 km/h on the Autobahn.

---

## The Three Pillars of Observability

Before we dive into code, let us establish the vocabulary. Observability in distributed systems rests on three pillars. Not two. Not one. You need all three, because each answers a fundamentally different question.

> **Key Term:** **Observability** — The ability to understand a system's internal state by examining its external outputs. A system is "observable" when you can answer any question about what it is doing -- without deploying new code or SSH-ing into a box. The three pillars (metrics, logs, traces) work together to give you this power.

### Pillar 1: Metrics

> **Key Term:** **Metrics** — Numeric measurements collected at regular intervals over time. "How many bookings per second?" "What is the average response time?" "How much memory is each container using?" Metrics are cheap to collect, cheap to store, and great for dashboards and alerts. They tell you *what* is happening.

Metrics are your first line of defense. They are lightweight -- a single metric data point is just a number, a timestamp, and a set of labels. You can store millions of data points per second without breaking a sweat. Metrics answer aggregate questions: "What is the error rate across all booking services in us-east right now?" You cannot answer that question by reading individual log lines.

**When to use metrics:** Dashboards, alerting, trend analysis, capacity planning, SLO tracking.

### Pillar 2: Logs

> **Key Term:** **Logs** — Timestamped text records of discrete events. "User U-881 created booking BK-55012 at 14:03:22 UTC." You already know logs from `console.log`. In a distributed system, you aggregate logs from all services into a central system (like the ELK stack or Loki) so you can search them in one place. Logs tell you *why* something happened.

Logs are the richest data source. They can contain arbitrary text, structured JSON, stack traces, request payloads -- anything. But richness comes at a cost: logs are expensive to store, expensive to search, and impossible to aggregate without structure. A single booking request across 7 services might generate 50 log lines. At 100,000 bookings per minute, that is 5 million log lines per minute. You had better have a plan.

**When to use logs:** Debugging specific failures, audit trails, compliance requirements, understanding the "why" behind a metric spike.

### Pillar 3: Traces

> **Key Term:** **Traces** — Records of a single request's journey across multiple services. "This booking request started at the API Gateway (12ms), went to the Booking Service (45ms), then to Inventory (180ms), then to Payment (1,400ms), and took 1,637ms total." Traces tell you *where* time was spent. We will cover these in depth in Chapter 31.

Traces are what make distributed systems debuggable. Without them, when a booking takes 5 seconds, you have no idea which of the 7 services is the bottleneck. With traces, you see a waterfall diagram that pinpoints the slow service instantly.

**When to use traces:** Latency investigations, dependency mapping, understanding request flow, finding bottlenecks.

### How the Three Pillars Connect

Here is the critical insight: metrics tell you something is wrong, logs tell you why, and traces tell you where. In practice, you follow this workflow during an incident:

1. **Metric alert fires:** "Booking error rate exceeds 5%."
2. **Dashboard drill-down:** You open Grafana and see the error rate spiking in the `us-east` region, specifically for `flight` bookings.
3. **Trace search:** You find a trace for a failed flight booking and see the Payment Service is returning 500 errors after 10-second timeouts.
4. **Log search:** You search for Payment Service logs with the trace's correlation ID and find: `"Connection refused: payment-provider-api.example.com:443"`.
5. **Root cause:** The payment provider's API is down. You activate the circuit breaker for that provider and route to the backup.

Total time from alert to root cause: 4 minutes. Without these three pillars, the same investigation takes 45 minutes of SSH-ing into boxes and guessing.

> **Common Mistake:** Teams often invest heavily in one pillar and neglect the others. A team with excellent Grafana dashboards but no structured logging will know *that* errors are spiking but not *why*. A team with perfect traces but no metrics will catch individual slow requests but miss gradual degradation trends. You need all three.

---

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
- What is the **95th percentile** response time? (The metric that matters far more than the average.)

To answer those questions from `console.log`, you would need to parse thousands of log lines, extract numbers, and calculate statistics. Every time you want an answer. In real time. Across 50 containers. That is not sustainable.

Metrics solve this. Instead of logging text, you increment counters, update gauges, and record measurements into a system designed for exactly these aggregate queries.

> **Why Not Just Parse Logs For Metrics?** Some teams try to extract metrics from logs using tools like Logstash or Fluentd pipelines. This works for small scale, but it is fragile, expensive, and introduces delay. You are parsing unstructured text to extract numbers that you could have just recorded as numbers in the first place. Prometheus metrics are purpose-built for this: they are compact, fast to query, and designed for time-series aggregation. Use logs for context. Use metrics for numbers.

---

## Prometheus: The Metrics Engine

Prometheus is an open-source monitoring system originally built at SoundCloud and now a graduated Cloud Native Computing Foundation (CNCF) project. It has become the de facto standard for metrics in the Kubernetes ecosystem. Here is how it works.

### The Pull-Based Scraping Architecture

Most monitoring systems work on a push model: your application sends metrics to a central server. Prometheus flips this. It uses a pull model:

1. Your application exposes a `/metrics` endpoint that returns current measurements in a specific text format.
2. Prometheus **scrapes** (HTTP GETs) that endpoint at a configurable interval (typically every 15 seconds).
3. Prometheus stores the data in its built-in time-series database (TSDB).
4. You query the data using a language called **PromQL** (Prometheus Query Language).
5. Grafana connects to Prometheus and draws charts from those queries.

```
┌─────────────┐     scrape /metrics      ┌──────────────┐
│  Booking    │◄─────────────────────────│              │
│  Service    │                          │              │
│  :3000      │                          │              │
└─────────────┘                          │              │
                                         │  Prometheus  │
┌─────────────┐     scrape /metrics      │  Server      │──► Grafana
│  Payment    │◄─────────────────────────│              │
│  Service    │                          │              │
│  :3001      │                          │              │
└─────────────┘                          │              │
                                         │              │
┌─────────────┐     scrape /metrics      │              │
│  Inventory  │◄─────────────────────────│              │
│  Service    │                          │              │
│  :3002      │                          └──────────────┘
└─────────────┘
```

The important mental shift: **your application does not push metrics to Prometheus. Prometheus pulls them from your application.** Your app just keeps a running tally and serves it when asked.

> **Why Not Push?** Push-based systems (like StatsD or InfluxDB's Telegraf) require your application to know where the monitoring server is. If the monitoring server goes down, metrics are lost. If you spin up new instances, you must configure each one to push to the right place. With pull-based Prometheus, your app does not care who scrapes it. Prometheus discovers targets through service discovery (Kubernetes labels, DNS, consul, etc.) and scrapes them automatically. New pods appear? Prometheus finds them. Pods die? Prometheus stops scraping them. Zero configuration on the application side.

### Prometheus Configuration: Service Discovery

In Kubernetes, Prometheus discovers your services automatically. Here is a typical `prometheus.yml` configuration:

```yaml
# prometheus.yml
global:
  scrape_interval: 15s       # How often to scrape targets
  evaluation_interval: 15s   # How often to evaluate alert rules

rule_files:
  - '/etc/prometheus/alert-rules.yml'

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

scrape_configs:
  # Scrape Prometheus itself
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']

  # Auto-discover Kubernetes pods with prometheus annotations
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      # Only scrape pods with annotation prometheus.io/scrape: "true"
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      # Use the annotation prometheus.io/port for the scrape port
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: ([^:]+)(?::d+)?;(d+)
        replacement: ${1}:${2}
      # Use the annotation prometheus.io/path for the metrics path
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      # Add pod labels as Prometheus labels
      - action: labelmap
        regex: __meta_kubernetes_pod_label_(.+)
```

With this configuration, any Kubernetes pod annotated with `prometheus.io/scrape: "true"` gets scraped automatically:

```yaml
# In your Kubernetes deployment
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "3000"
    prometheus.io/path: "/metrics"
```

No manual target lists. No restarts. Deploy a new service with the right annotations, and Prometheus starts collecting its metrics within 15 seconds.

### The Four Metric Types

Prometheus defines four metric types. You saw three in the original chapter. The fourth -- Summary -- is less common but worth understanding.

| Metric Type    | What It Does                                        | Example                                        | Analogy                                        |
|----------------|-----------------------------------------------------|------------------------------------------------|------------------------------------------------|
| **Counter**    | A number that only goes up (resets to 0 on restart) | Total bookings created                         | Your car's odometer -- it never goes down      |
| **Gauge**      | A number that goes up and down                      | Current active connections                     | Your speedometer -- it changes constantly      |
| **Histogram**  | Records value distribution in configurable buckets  | Booking creation time distribution             | Sorting lap times into buckets at a race track |
| **Summary**    | Records value distribution with streaming quantiles | Payment processing time (pre-calculated P50, P99) | A running leaderboard that updates live        |

Let us examine each one in depth.

#### Counter: The Only-Goes-Up Number

A counter starts at 0 and only increments. It resets to 0 when the process restarts. You never read a counter's raw value directly -- instead, you use PromQL's `rate()` function to calculate per-second rates over a time window.

```typescript
import { Counter } from 'prom-client';

// Define the counter
const bookingsTotal = new Counter({
  name: 'bookings_total',
  help: 'Total number of booking attempts',
  labelNames: ['booking_type', 'status', 'region'],
});

// Increment it when a booking is attempted
async function createBooking(data: BookingInput) {
  try {
    const booking = await bookingService.create(data);
    bookingsTotal.inc({
      booking_type: data.type,    // 'hotel', 'flight', 'car'
      status: 'success',
      region: data.region,        // 'us-east', 'eu-west', 'ap-south'
    });
    return booking;
  } catch (error) {
    bookingsTotal.inc({
      booking_type: data.type,
      status: 'failure',
      region: data.region,
    });
    throw error;
  }
}
```

**Key PromQL queries for counters:**

```promql
# Bookings per second (rate over 5 minutes)
rate(bookings_total[5m])

# Bookings per second, only failures
rate(bookings_total{status="failure"}[5m])

# Success rate as a percentage
rate(bookings_total{status="success"}[5m]) / rate(bookings_total[5m]) * 100

# Total bookings in the last hour
increase(bookings_total[1h])
```

> **Common Mistake:** Never use a counter to track something that can decrease, like "currently active users" or "queue depth." If you do, your counter will break when the value needs to go down. Use a gauge instead. The clue is in the name: if you would ever call `.dec()` on it, it should be a gauge.

#### Gauge: The Up-and-Down Number

A gauge represents a current value that can increase or decrease. It is a snapshot of "right now."

```typescript
import { Gauge } from 'prom-client';

// Current number of active WebSocket connections
const activeConnections = new Gauge({
  name: 'active_connections_total',
  help: 'Number of currently active client connections',
  labelNames: ['service'],
});

// In your connection handler
wsServer.on('connection', (socket) => {
  activeConnections.inc({ service: 'booking-ws' });

  socket.on('close', () => {
    activeConnections.dec({ service: 'booking-ws' });
  });
});

// Queue depth -- set to current value
const queueDepth = new Gauge({
  name: 'message_queue_depth',
  help: 'Current number of messages waiting in the queue',
  labelNames: ['queue_name'],
});

// Periodically update from the actual queue
setInterval(async () => {
  const depth = await kafkaAdmin.getQueueDepth('booking-events');
  queueDepth.set({ queue_name: 'booking-events' }, depth);
}, 5000);
```

#### Histogram: The Distribution Tracker

A histogram is the most powerful metric type. It does not just record a value -- it sorts each observation into configurable buckets, letting you calculate percentiles after the fact.

```typescript
import { Histogram } from 'prom-client';

const bookingDuration = new Histogram({
  name: 'booking_creation_duration_seconds',
  help: 'Time to create a booking end-to-end',
  labelNames: ['booking_type', 'status', 'region'],
  // These bucket boundaries are in seconds
  // Chosen based on our SLOs: P50 < 250ms, P95 < 1s, P99 < 2s
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
});

// Usage: time a booking creation
async function createBooking(data: BookingInput) {
  const stopTimer = bookingDuration.startTimer({
    booking_type: data.type,
    region: data.region,
  });

  try {
    const result = await bookingService.create(data);
    stopTimer({ status: 'success' }); // Records the elapsed time
    return result;
  } catch (error) {
    stopTimer({ status: 'failure' });
    throw error;
  }
}
```

When Prometheus scrapes this, it gets bucket counts:

```
booking_creation_duration_seconds_bucket{le="0.05"} 12000
booking_creation_duration_seconds_bucket{le="0.1"}  34000
booking_creation_duration_seconds_bucket{le="0.25"} 78000
booking_creation_duration_seconds_bucket{le="0.5"}  95000
booking_creation_duration_seconds_bucket{le="1"}    98500
booking_creation_duration_seconds_bucket{le="2"}    99200
booking_creation_duration_seconds_bucket{le="5"}    99800
booking_creation_duration_seconds_bucket{le="10"}   99950
booking_creation_duration_seconds_bucket{le="30"}   100000
booking_creation_duration_seconds_bucket{le="+Inf"} 100000
booking_creation_duration_seconds_sum 45230.5
booking_creation_duration_seconds_count 100000
```

From this, you can calculate any percentile:

```promql
# P50 (median) booking creation time
histogram_quantile(0.5, rate(booking_creation_duration_seconds_bucket[5m]))

# P95 booking creation time
histogram_quantile(0.95, rate(booking_creation_duration_seconds_bucket[5m]))

# P99 booking creation time
histogram_quantile(0.99, rate(booking_creation_duration_seconds_bucket[5m]))

# Average booking creation time
rate(booking_creation_duration_seconds_sum[5m]) / rate(booking_creation_duration_seconds_count[5m])
```

> **Key Term:** **Percentile (P99, P95, P50)** — The value below which a given percentage of observations fall. P99 = 2 seconds means 99% of bookings complete in under 2 seconds. The remaining 1% take longer. P99 is the metric SRE teams care about most, because it represents the worst experience your users have (excluding extreme outliers). The average hides this: an average of 200ms could mean most requests take 100ms but 1% take 10 seconds. That 1% represents real users having a terrible experience.

> **Common Mistake:** Choosing bucket boundaries carelessly. If your SLO says "P99 < 2 seconds" but your smallest bucket is 1 second, you cannot accurately measure P50 or P95. Your buckets should be densest around your SLO thresholds. Too many buckets waste storage. Too few give you inaccurate percentiles. Start with the defaults and refine based on your actual latency distribution.

#### Summary: Pre-Calculated Quantiles

A summary is similar to a histogram but calculates quantiles on the client side (in your application) rather than on the Prometheus server.

```typescript
import { Summary } from 'prom-client';

const paymentDuration = new Summary({
  name: 'payment_processing_duration_seconds',
  help: 'Payment processing time with pre-calculated quantiles',
  labelNames: ['provider'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  maxAgeSeconds: 300,      // Sliding window: 5 minutes
  ageBuckets: 5,           // Number of buckets in the sliding window
});
```

> **Why Not Summary?** Summaries seem convenient -- they give you exact percentiles without PromQL. But they have two serious limitations: (1) you cannot aggregate summaries across multiple instances (you cannot average a P99 from 20 pods to get the fleet P99 -- that is mathematically wrong), and (2) you must decide the quantiles at instrumentation time, not at query time. Histograms let you calculate any percentile at query time and aggregate across instances correctly. **Use histograms for almost everything.** Use summaries only for client-side libraries where you need exact quantiles from a single instance.

---

## The Four Golden Signals

Google's Site Reliability Engineering book defines four "golden signals" that every service should monitor. These are not optional. If you monitor only four things, monitor these four things. Everything else is secondary.

> **Key Term:** **The Four Golden Signals** — Latency, Traffic, Errors, and Saturation. Defined by Google SRE as the minimum metrics needed to understand a service's health. If you can only measure four things, measure these. They cover the complete picture: how fast (latency), how much (traffic), how broken (errors), and how full (saturation).

### Signal 1: Latency

Latency is the time it takes to serve a request. But not all latency is equal. You must distinguish between **successful request latency** and **failed request latency**. A request that fails in 2ms (because a database connection was refused instantly) should not bring down your average latency -- that would mask the failure.

```typescript
import { Histogram } from 'prom-client';

// Separate tracking for success and failure latency
const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'status_class'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

// In your Express/NestJS middleware
function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const stopTimer = httpRequestDuration.startTimer();

  // Capture the original end to record when the response finishes
  const originalEnd = res.end;
  res.end = function (...args: any[]) {
    const statusCode = res.statusCode.toString();
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    const route = req.route?.path || req.path || 'unknown';

    stopTimer({
      method: req.method,
      route: route,
      status_code: statusCode,
      status_class: statusClass,
    });

    return originalEnd.apply(this, args);
  };

  next();
}
```

**Key PromQL queries for latency:**

```promql
# P99 latency for successful booking requests only
histogram_quantile(0.99,
  rate(http_request_duration_seconds_bucket{
    route="/api/bookings",
    status_class="2xx"
  }[5m])
)

# Compare P50 vs P99 to detect latency outliers
# If P99 >> P50, you have a long-tail latency problem
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
  /
histogram_quantile(0.50, rate(http_request_duration_seconds_bucket[5m]))
```

> **Mentor Note:** When your P99 is more than 10x your P50, it means most users are fine but a small percentage are having a terrible experience. This often points to garbage collection pauses, cold database connections, or cache misses. Do not ignore it just because the average looks good.

### Signal 2: Traffic

Traffic measures how much demand is being placed on your system. For an HTTP service, this is typically requests per second. For our booking system, it is bookings per minute, searches per second, and payment transactions per hour.

```typescript
import { Counter } from 'prom-client';

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_class'],
});

// In middleware
httpRequestsTotal.inc({
  method: req.method,
  route: req.route?.path || 'unknown',
  status_class: `${Math.floor(res.statusCode / 100)}xx`,
});
```

**Key PromQL queries for traffic:**

```promql
# Total requests per second across all services
sum(rate(http_requests_total[5m]))

# Requests per second by service
sum by (service) (rate(http_requests_total[5m]))

# Compare current traffic to same time last week
# Useful for detecting anomalies: "Is this spike normal for Sunday evening?"
sum(rate(http_requests_total[5m]))
  /
sum(rate(http_requests_total[5m] offset 7d))
```

### Signal 3: Errors

Errors are the fraction of requests that fail. You need to track both **explicit errors** (HTTP 500s, gRPC errors, thrown exceptions) and **implicit errors** (a request that returns 200 but with wrong data, or a booking that succeeds but charges the wrong amount).

```typescript
import { Counter } from 'prom-client';

const errorsTotal = new Counter({
  name: 'service_errors_total',
  help: 'Total number of errors by type',
  labelNames: ['service', 'error_type', 'severity'],
});

// Explicit error: HTTP 500
errorsTotal.inc({
  service: 'booking-service',
  error_type: 'internal_server_error',
  severity: 'critical',
});

// Explicit error: upstream timeout
errorsTotal.inc({
  service: 'booking-service',
  error_type: 'upstream_timeout',
  severity: 'warning',
});

// Implicit error: business logic failure
errorsTotal.inc({
  service: 'booking-service',
  error_type: 'double_booking_detected',
  severity: 'critical',
});
```

**Key PromQL queries for errors:**

```promql
# Error rate as a percentage of total requests
sum(rate(http_requests_total{status_class="5xx"}[5m]))
  /
sum(rate(http_requests_total[5m])) * 100

# Error rate by route -- which endpoints are failing?
sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))
  /
sum by (route) (rate(http_requests_total[5m])) * 100
```

### Signal 4: Saturation

Saturation measures how "full" your service is. A service at 95% CPU has very different characteristics than one at 30% CPU. Saturation predicts imminent problems -- it tells you trouble is coming before it arrives.

```typescript
import { Gauge } from 'prom-client';

// Track connection pool saturation
const dbPoolUtilization = new Gauge({
  name: 'db_connection_pool_utilization_ratio',
  help: 'Ratio of active connections to total pool size',
  labelNames: ['database'],
});

// Track event loop lag (critical for Node.js)
const eventLoopLag = new Gauge({
  name: 'nodejs_eventloop_lag_seconds',
  help: 'Event loop lag in seconds',
});

// Update event loop lag periodically
setInterval(() => {
  const start = process.hrtime.bigint();
  setImmediate(() => {
    const lag = Number(process.hrtime.bigint() - start) / 1e9;
    eventLoopLag.set(lag);
  });
}, 1000);

// Track memory usage relative to limits
const memoryUtilization = new Gauge({
  name: 'memory_utilization_ratio',
  help: 'Ratio of used memory to memory limit',
});

setInterval(() => {
  const used = process.memoryUsage();
  const limitMB = parseInt(process.env.MEMORY_LIMIT_MB || '512');
  memoryUtilization.set(used.heapUsed / (limitMB * 1024 * 1024));
}, 5000);
```

**Key PromQL queries for saturation:**

```promql
# Database connection pool utilization
db_connection_pool_utilization_ratio{database="booking-primary"}

# Node.js event loop lag -- should be < 100ms
nodejs_eventloop_lag_seconds

# Memory utilization -- alert at 85%
memory_utilization_ratio > 0.85
```

> **Common Mistake:** Teams often monitor only latency and errors, ignoring traffic and saturation. This is like driving a car while only watching the speedometer and check-engine light, ignoring the fuel gauge and temperature gauge. Saturation is the signal that lets you scale proactively. If your database connection pool is at 90% utilization, you know you need to scale *before* requests start failing.

---

## Custom Business Metrics: Beyond Technical Health

Technical metrics tell you if the systems are working. Business metrics tell you if the *business* is working. Both matter. A booking system with perfect uptime but zero bookings is a failure.

> **Analogy:** Technical metrics are like a hospital's equipment monitors -- heart rate, blood pressure, oxygen saturation. Business metrics are like patient outcomes -- recovery rate, readmission rate, patient satisfaction. The equipment monitors can all look fine while the patient is not improving. You need both views.

### Bookings Per Minute

```typescript
import { Counter, Gauge } from 'prom-client';

const bookingsCreated = new Counter({
  name: 'business_bookings_created_total',
  help: 'Total bookings successfully created',
  labelNames: ['booking_type', 'channel', 'region', 'tier'],
});

// Revenue counter (in cents to avoid floating point issues)
const revenueTotal = new Counter({
  name: 'business_revenue_cents_total',
  help: 'Total revenue in cents from completed bookings',
  labelNames: ['booking_type', 'currency', 'region'],
});

// Average booking value (updated periodically from the database)
const avgBookingValue = new Gauge({
  name: 'business_avg_booking_value_cents',
  help: 'Rolling average booking value in cents over the last hour',
  labelNames: ['booking_type'],
});

// Usage in your booking service
async function completeBooking(booking: Booking) {
  bookingsCreated.inc({
    booking_type: booking.type,
    channel: booking.channel, // 'web', 'mobile', 'api', 'agent'
    region: booking.region,
    tier: booking.customer.tier, // 'standard', 'premium', 'enterprise'
  });

  revenueTotal.inc(
    {
      booking_type: booking.type,
      currency: booking.currency,
      region: booking.region,
    },
    booking.totalAmountCents
  );
}
```

**Key PromQL queries:**

```promql
# Bookings per minute right now
sum(rate(business_bookings_created_total[5m])) * 60

# Bookings per minute by type
sum by (booking_type) (rate(business_bookings_created_total[5m])) * 60

# Revenue per hour
sum(rate(business_revenue_cents_total[5m])) * 3600 / 100

# Compare bookings to the same time yesterday
sum(rate(business_bookings_created_total[5m])) * 60
  /
sum(rate(business_bookings_created_total[5m] offset 1d)) * 60
```

### Payment Success Rate

Payment failures directly impact revenue. A 2% drop in payment success rate could mean tens of thousands of dollars in lost bookings.

```typescript
const paymentAttempts = new Counter({
  name: 'business_payment_attempts_total',
  help: 'Total payment attempts',
  labelNames: ['provider', 'method', 'status', 'decline_reason'],
});

// Track the full payment lifecycle
async function processPayment(payment: PaymentRequest) {
  const labels = {
    provider: payment.provider,  // 'stripe', 'adyen', 'paypal'
    method: payment.method,      // 'credit_card', 'debit', 'wallet'
  };

  try {
    const result = await paymentGateway.charge(payment);

    if (result.success) {
      paymentAttempts.inc({ ...labels, status: 'success', decline_reason: 'none' });
    } else {
      paymentAttempts.inc({
        ...labels,
        status: 'declined',
        decline_reason: result.declineReason || 'unknown',
      });
    }
    return result;
  } catch (error) {
    paymentAttempts.inc({
      ...labels,
      status: 'error',
      decline_reason: 'system_error',
    });
    throw error;
  }
}
```

**Key PromQL queries:**

```promql
# Payment success rate by provider
sum by (provider) (rate(business_payment_attempts_total{status="success"}[5m]))
  /
sum by (provider) (rate(business_payment_attempts_total[5m])) * 100

# Decline reasons breakdown
sum by (decline_reason) (rate(business_payment_attempts_total{status="declined"}[5m]))
```

### Inventory Utilization

For a booking system, inventory is the lifeblood. How full are the hotels? How many seats remain on flights? What percentage of rental cars are booked?

```typescript
const inventoryTotal = new Gauge({
  name: 'business_inventory_total',
  help: 'Total available inventory units',
  labelNames: ['inventory_type', 'region', 'property_id'],
});

const inventoryBooked = new Gauge({
  name: 'business_inventory_booked',
  help: 'Currently booked inventory units',
  labelNames: ['inventory_type', 'region', 'property_id'],
});

// Update gauges periodically from the database
async function updateInventoryMetrics() {
  const stats = await prisma.inventoryUnit.groupBy({
    by: ['type', 'region', 'propertyId'],
    _count: { id: true },
    where: { deletedAt: null },
  });

  const booked = await prisma.inventoryUnit.groupBy({
    by: ['type', 'region', 'propertyId'],
    _count: { id: true },
    where: { status: 'BOOKED', deletedAt: null },
  });

  stats.forEach((stat) => {
    inventoryTotal.set(
      {
        inventory_type: stat.type,
        region: stat.region,
        property_id: stat.propertyId,
      },
      stat._count.id
    );
  });

  booked.forEach((stat) => {
    inventoryBooked.set(
      {
        inventory_type: stat.type,
        region: stat.region,
        property_id: stat.propertyId,
      },
      stat._count.id
    );
  });
}

// Run every 30 seconds
setInterval(updateInventoryMetrics, 30_000);
```

**Key PromQL queries:**

```promql
# Overall utilization rate
sum(business_inventory_booked) / sum(business_inventory_total) * 100

# Utilization by type
sum by (inventory_type) (business_inventory_booked)
  /
sum by (inventory_type) (business_inventory_total) * 100

# Properties nearing full capacity (> 90% booked)
(business_inventory_booked / business_inventory_total) > 0.9
```

---

## Grafana Dashboard Design: The Ops Dashboard

A well-designed Grafana dashboard is like a well-designed cockpit. The most critical information is front and center. Less critical information is still visible but secondary. You should be able to glance at the dashboard and know in 3 seconds whether the system is healthy.

> **Analogy:** Think about an airplane cockpit. The six primary instruments (airspeed, altitude, attitude, heading, vertical speed, turn coordinator) are arranged in a standard "six-pack" layout. Every pilot in the world knows exactly where to look. Your Grafana dashboard should work the same way. Same layout, every time, for every service. When you are debugging an incident at 2 AM, muscle memory matters.

### Dashboard Layout: The Booking System Ops View

Here is how to organize a production-grade Grafana dashboard for our booking platform. The layout follows the "inverted pyramid" pattern: most critical at top, supporting details below.

```
┌─────────────────────────────────────────────────────────────────────┐
│  ROW 1: STATUS OVERVIEW  (single-stat panels, full width)          │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Bookings │ │  Error   │ │   P99    │ │ Revenue  │ │ Active   │ │
│  │  /min    │ │  Rate    │ │ Latency  │ │  /hour   │ │  Users   │ │
│  │   847    │ │  0.3%    │ │  420ms   │ │ $12,400  │ │  3,291   │ │
│  │  (green) │ │ (green)  │ │ (yellow) │ │ (green)  │ │ (green)  │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  ROW 2: THE GOLDEN SIGNALS  (time-series graphs, 2x2 grid)        │
│                                                                     │
│  ┌────────────────────────────┐ ┌────────────────────────────────┐ │
│  │  Latency (P50/P95/P99)    │ │  Traffic (requests/sec)        │ │
│  │  ▁▂▂▃▃▃▅▅▄▃▂▂▁▁▂▃▅▇█▇▅   │ │  ▃▃▃▃▄▅▆▇▇▇▆▆▅▅▄▃▃▃▃▃▄▅▆▇  │ │
│  └────────────────────────────┘ └────────────────────────────────┘ │
│  ┌────────────────────────────┐ ┌────────────────────────────────┐ │
│  │  Error Rate (%)            │ │  Saturation (CPU/Mem/Pool)     │ │
│  │  ▁▁▁▁▁▁▁▁▁▁▂▅▇▅▂▁▁▁▁▁▁   │ │  ▄▄▄▄▅▅▅▆▆▆▅▅▅▄▄▄▄▅▅▆▆▇▇  │ │
│  └────────────────────────────┘ └────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  ROW 3: BUSINESS METRICS  (time-series, 3 columns)                │
│                                                                     │
│  ┌─────────────────┐ ┌────────────────┐ ┌─────────────────────┐   │
│  │ Bookings by Type│ │ Payment Success│ │ Inventory Utiliz.   │   │
│  │ (hotel/flight)  │ │ Rate by Provdr │ │ by Region           │   │
│  └─────────────────┘ └────────────────┘ └─────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  ROW 4: INFRASTRUCTURE  (time-series, 3 columns)                  │
│                                                                     │
│  ┌─────────────────┐ ┌────────────────┐ ┌─────────────────────┐   │
│  │ DB Connection   │ │ Kafka Consumer │ │ Redis Hit Rate      │   │
│  │ Pool Usage      │ │ Lag            │ │ & Memory            │   │
│  └─────────────────┘ └────────────────┘ └─────────────────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│  ROW 5: RECENT ALERTS  (table panel, full width)                   │
│                                                                     │
│  | Time     | Alert              | Severity | Status   | Duration |│
│  | 14:03    | High Error Rate    | Warning  | Resolved | 4m       |│
│  | 12:55    | Payment Timeout    | Critical | Resolved | 12m      |│
│  | 09:30    | DB Pool Saturation | Warning  | Active   | ongoing  |│
└─────────────────────────────────────────────────────────────────────┘
```

### Grafana Dashboard as Code (JSON Model)

Rather than clicking through the Grafana UI, define your dashboards as code. This lets you version-control them, review them in pull requests, and deploy them automatically.

```json
{
  "dashboard": {
    "title": "Booking Platform - Operations",
    "uid": "booking-ops-v2",
    "tags": ["booking", "production", "ops"],
    "timezone": "UTC",
    "refresh": "30s",
    "time": { "from": "now-3h", "to": "now" },
    "panels": [
      {
        "title": "Bookings / Minute",
        "type": "stat",
        "gridPos": { "h": 4, "w": 5, "x": 0, "y": 0 },
        "targets": [{
          "expr": "sum(rate(business_bookings_created_total[5m])) * 60",
          "legendFormat": "bookings/min"
        }],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "steps": [
                { "color": "red", "value": 0 },
                { "color": "yellow", "value": 100 },
                { "color": "green", "value": 500 }
              ]
            }
          }
        }
      },
      {
        "title": "Error Rate",
        "type": "stat",
        "gridPos": { "h": 4, "w": 5, "x": 5, "y": 0 },
        "targets": [{
          "expr": "sum(rate(http_requests_total{status_class='5xx'}[5m])) / sum(rate(http_requests_total[5m])) * 100",
          "legendFormat": "error %"
        }],
        "fieldConfig": {
          "defaults": {
            "unit": "percent",
            "thresholds": {
              "steps": [
                { "color": "green", "value": 0 },
                { "color": "yellow", "value": 1 },
                { "color": "red", "value": 5 }
              ]
            }
          }
        }
      },
      {
        "title": "P99 Latency",
        "type": "stat",
        "gridPos": { "h": 4, "w": 5, "x": 10, "y": 0 },
        "targets": [{
          "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "P99"
        }],
        "fieldConfig": {
          "defaults": {
            "unit": "s",
            "thresholds": {
              "steps": [
                { "color": "green", "value": 0 },
                { "color": "yellow", "value": 1 },
                { "color": "red", "value": 2 }
              ]
            }
          }
        }
      }
    ]
  }
}
```

> **Common Mistake:** Building dashboards with dozens of panels that show everything possible. A dashboard with 40 graphs is a screensaver, not a tool. Follow the "5-second rule": if someone cannot assess system health within 5 seconds of looking at the dashboard, it has too many panels. Create focused dashboards for different audiences. An ops overview dashboard (5-8 panels). A deep-dive latency dashboard. A business metrics dashboard. A database performance dashboard. Specialization beats sprawl.

---

## Alert Rules: When to Page vs When to Ticket

Not every alert deserves to wake someone up at 3 AM. The distinction between "page the on-call engineer immediately" and "create a ticket for tomorrow" is one of the most important decisions in your monitoring setup. Get it wrong, and you either miss critical outages or burn out your team.

> **Key Term:** **Alert Severity Levels** — A classification system that determines how urgently an alert is communicated. The most common scheme has four levels: Critical (page immediately), Warning (ticket + Slack), Info (log only), and Debug (suppressed in production). The severity determines the notification channel, response time expectation, and escalation path.

### The Severity Matrix

| Severity     | User Impact                         | Response Time | Notification Channel                  | Example                                           |
|-------------|--------------------------------------|---------------|----------------------------------------|---------------------------------------------------|
| **Critical** | Service is down or data is at risk  | < 5 minutes   | PagerDuty page + phone call            | Booking API returning 500 for > 1% of requests    |
| **Warning**  | Degraded but functional             | < 30 minutes  | Slack #alerts + ticket created         | P99 latency exceeds SLO (2s) for > 10 minutes     |
| **Info**     | No user impact, needs attention     | Next business day | Slack #monitoring                  | Database connection pool at 70% capacity           |
| **Debug**    | Operational data, no action needed  | No response   | Dashboard only                         | Deployment completed, new version is serving       |

### Prometheus Alert Rules

Alert rules live in a YAML file that Prometheus evaluates on its configured interval. Here is a comprehensive set for our booking system:

```yaml
# alert-rules.yml
groups:
  - name: booking_critical
    rules:
      # CRITICAL: High error rate on booking API
      - alert: BookingHighErrorRate
        expr: |
          sum(rate(http_requests_total{service="booking-service", status_class="5xx"}[5m]))
          /
          sum(rate(http_requests_total{service="booking-service"}[5m])) > 0.05
        for: 2m
        labels:
          severity: critical
          team: booking
          runbook: "https://runbooks.internal/booking-high-error-rate"
        annotations:
          summary: "Booking service error rate above 5%"
          description: >
            The booking service error rate is {{ $value | humanizePercentage }}
            over the last 5 minutes. This exceeds the 5% threshold for 2+ minutes.
            Check the booking service logs and downstream dependencies.

      # CRITICAL: No bookings being created
      - alert: BookingZeroThroughput
        expr: |
          sum(rate(business_bookings_created_total[10m])) == 0
        for: 5m
        labels:
          severity: critical
          team: booking
          runbook: "https://runbooks.internal/booking-zero-throughput"
        annotations:
          summary: "No bookings created in the last 5 minutes"
          description: >
            Zero bookings have been created in the last 5 minutes.
            This is extremely unusual and indicates a critical failure.

      # CRITICAL: Payment processing completely failing
      - alert: PaymentTotalFailure
        expr: |
          sum(rate(business_payment_attempts_total{status="success"}[5m]))
          /
          sum(rate(business_payment_attempts_total[5m])) < 0.5
        for: 3m
        labels:
          severity: critical
          team: payments
          runbook: "https://runbooks.internal/payment-total-failure"
        annotations:
          summary: "Payment success rate below 50%"
          description: >
            Payment success rate is {{ $value | humanizePercentage }}.
            More than half of all payment attempts are failing.

  - name: booking_warning
    rules:
      # WARNING: Latency exceeding SLO
      - alert: BookingHighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(http_request_duration_seconds_bucket{
              service="booking-service"
            }[5m])) by (le)
          ) > 2
        for: 10m
        labels:
          severity: warning
          team: booking
          runbook: "https://runbooks.internal/booking-high-latency"
        annotations:
          summary: "Booking P99 latency exceeds 2 seconds"
          description: >
            P99 latency is {{ $value | humanizeDuration }}.
            SLO target is 2 seconds. Investigate slow queries or upstream timeouts.

      # WARNING: Database connection pool nearing saturation
      - alert: DatabasePoolSaturation
        expr: db_connection_pool_utilization_ratio > 0.85
        for: 5m
        labels:
          severity: warning
          team: platform
          runbook: "https://runbooks.internal/db-pool-saturation"
        annotations:
          summary: "Database connection pool above 85%"
          description: >
            Database {{ $labels.database }} connection pool utilization
            is at {{ $value | humanizePercentage }}. Consider increasing
            pool size or investigating connection leaks.

      # WARNING: Kafka consumer lag growing
      - alert: KafkaConsumerLagGrowing
        expr: |
          delta(kafka_consumer_group_lag[10m]) > 1000
        for: 10m
        labels:
          severity: warning
          team: platform
          runbook: "https://runbooks.internal/kafka-consumer-lag"
        annotations:
          summary: "Kafka consumer lag is increasing"
          description: >
            Consumer group {{ $labels.consumer_group }} lag has increased
            by {{ $value }} messages in the last 10 minutes.

  - name: booking_info
    rules:
      # INFO: Inventory nearing capacity
      - alert: InventoryHighUtilization
        expr: |
          (business_inventory_booked / business_inventory_total) > 0.9
        for: 30m
        labels:
          severity: info
          team: business
        annotations:
          summary: "Inventory utilization above 90%"
          description: >
            {{ $labels.inventory_type }} inventory in {{ $labels.region }}
            is {{ $value | humanizePercentage }} utilized.
```

> **Mentor Note:** The `for` clause is critical. It prevents transient spikes from triggering alerts. `for: 2m` means the condition must be true for 2 consecutive evaluation cycles (at 15-second intervals, that is 8 evaluations). Without `for`, a single spike that resolves in 5 seconds would page your on-call engineer at 3 AM for nothing. But do not set `for` too high either -- `for: 30m` on a critical alert means you are okay with the system being broken for 30 minutes before anyone is notified.

---

## Alert Fatigue: The Silent Killer of On-Call Teams

Alert fatigue is what happens when your team receives so many alerts that they start ignoring them. It is not a hypothetical risk -- it is the primary reason production incidents are missed at companies with monitoring in place. The monitoring exists. The alerts fire. Nobody looks at them because 95% of alerts are false positives.

> **Analogy:** Think of the "boy who cried wolf." If your monitoring system pages you at 2 AM for a CPU spike that resolves on its own, and this happens three times a week, by the fourth time you will not get out of bed. The fifth time, it will be a real incident, and you will sleep through it. Alert fatigue is real, measurable, and dangerous.

### The Rules for Avoiding Alert Fatigue

**Rule 1: Every alert must be actionable.** If there is nothing an on-call engineer can do when the alert fires, it should not be an alert. "CPU usage is high" is not actionable unless you include "and here is what to do about it." Convert it to "CPU usage exceeds 90% for > 10 minutes -- scale horizontally per runbook X."

**Rule 2: Alerts must have runbooks.** Every alert should link to a runbook that describes the diagnosis steps and remediation actions. An alert without a runbook is just panic in a box.

**Rule 3: Review alert frequency monthly.** If an alert fires more than once a week and the response is always "acknowledge and ignore," either fix the underlying issue or delete the alert. There is no third option.

**Rule 4: Tune thresholds with real data.** Do not guess thresholds. Look at your historical data. If your P99 latency is normally 400ms, setting an alert at 500ms will fire constantly. Set it at a level that represents actual degradation, like 2x the normal baseline.

**Rule 5: Use alert grouping and deduplication.** If one failure causes 15 alerts, your on-call engineer should receive one page with 15 grouped alerts, not 15 separate pages. Alertmanager's `group_by` and `group_wait` settings handle this:

```yaml
# alertmanager.yml
route:
  receiver: 'default'
  group_by: ['alertname', 'service']
  group_wait: 30s       # Wait 30s to group related alerts together
  group_interval: 5m    # Wait 5m before sending updates about the group
  repeat_interval: 4h   # Re-notify every 4 hours if the alert is still firing

  routes:
    - match:
        severity: critical
      receiver: 'pagerduty-critical'
      group_wait: 10s      # Critical alerts: shorter group wait
      repeat_interval: 30m

    - match:
        severity: warning
      receiver: 'slack-warnings'
      group_wait: 1m
      repeat_interval: 8h

    - match:
        severity: info
      receiver: 'slack-info'
      group_wait: 5m
      repeat_interval: 24h

receivers:
  - name: 'pagerduty-critical'
    pagerduty_configs:
      - service_key: '<your-pagerduty-key>'
        description: '{{ .GroupLabels.alertname }}: {{ .CommonAnnotations.summary }}'

  - name: 'slack-warnings'
    slack_configs:
      - api_url: '<your-slack-webhook>'
        channel: '#alerts-warning'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ .CommonAnnotations.description }}'

  - name: 'slack-info'
    slack_configs:
      - api_url: '<your-slack-webhook>'
        channel: '#alerts-info'
        title: '{{ .GroupLabels.alertname }}'
        text: '{{ .CommonAnnotations.description }}'
```

> **Common Mistake:** Setting up alerts and never reviewing them. Alert configurations rot just like code. What was a critical threshold six months ago might be normal today because traffic grew. Schedule a monthly "alert hygiene" review where the team looks at every alert that fired, asks "Was this useful? Did someone take action?", and tunes or removes alerts that are not serving their purpose.

---

## Full NestJS Metrics Middleware with Prometheus Client

Now let us build a complete, production-grade metrics module for NestJS. This is not a toy example -- this is what we run in production.

```typescript
// src/metrics/metrics.module.ts
import { Module, Global } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { APP_INTERCEPTOR } from '@nestjs/core';

@Global()
@Module({
  providers: [
    MetricsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
```

```typescript
// src/metrics/metrics.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  // The Prometheus registry that holds all metrics
  private readonly registry: client.Registry;

  // HTTP metrics
  public readonly httpRequestDuration: client.Histogram<string>;
  public readonly httpRequestsTotal: client.Counter<string>;
  public readonly httpActiveRequests: client.Gauge<string>;

  // Business metrics
  public readonly bookingsCreated: client.Counter<string>;
  public readonly paymentAttempts: client.Counter<string>;
  public readonly revenueTotal: client.Counter<string>;

  // Infrastructure metrics
  public readonly dbQueryDuration: client.Histogram<string>;
  public readonly dbPoolUtilization: client.Gauge<string>;
  public readonly cacheHitRate: client.Gauge<string>;
  public readonly eventLoopLag: client.Gauge<string>;

  constructor() {
    this.registry = new client.Registry();

    // Register default Node.js metrics (GC, memory, CPU, event loop)
    client.collectDefaultMetrics({ register: this.registry });

    // --- HTTP Metrics ---
    this.httpRequestDuration = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labelNames: ['method', 'route', 'status_code', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code', 'status_class'],
      registers: [this.registry],
    });

    this.httpActiveRequests = new client.Gauge({
      name: 'http_active_requests',
      help: 'Number of HTTP requests currently being processed',
      labelNames: ['method', 'route'],
      registers: [this.registry],
    });

    // --- Business Metrics ---
    this.bookingsCreated = new client.Counter({
      name: 'business_bookings_created_total',
      help: 'Total bookings successfully created',
      labelNames: ['booking_type', 'channel', 'region', 'status'],
      registers: [this.registry],
    });

    this.paymentAttempts = new client.Counter({
      name: 'business_payment_attempts_total',
      help: 'Total payment attempts',
      labelNames: ['provider', 'method', 'status', 'decline_reason'],
      registers: [this.registry],
    });

    this.revenueTotal = new client.Counter({
      name: 'business_revenue_cents_total',
      help: 'Total revenue in cents from completed bookings',
      labelNames: ['booking_type', 'currency'],
      registers: [this.registry],
    });

    // --- Infrastructure Metrics ---
    this.dbQueryDuration = new client.Histogram({
      name: 'db_query_duration_seconds',
      help: 'Duration of database queries in seconds',
      labelNames: ['operation', 'model', 'success'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.dbPoolUtilization = new client.Gauge({
      name: 'db_connection_pool_utilization_ratio',
      help: 'Ratio of active connections to total pool size',
      labelNames: ['database'],
      registers: [this.registry],
    });

    this.cacheHitRate = new client.Gauge({
      name: 'cache_hit_rate_ratio',
      help: 'Cache hit rate as a ratio (0-1)',
      labelNames: ['cache_name'],
      registers: [this.registry],
    });

    this.eventLoopLag = new client.Gauge({
      name: 'nodejs_eventloop_lag_p99_seconds',
      help: 'P99 event loop lag in seconds',
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Measure event loop lag every second
    setInterval(() => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const lagNs = Number(process.hrtime.bigint() - start);
        this.eventLoopLag.set(lagNs / 1e9);
      });
    }, 1000);
  }

  // Expose the registry for the /metrics endpoint
  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }
}
```

```typescript
// src/metrics/metrics.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const method = request.method;
    // Use the controller route pattern, not the actual URL with params
    const route = this.extractRoute(context);

    // Track active requests (in-flight)
    this.metrics.httpActiveRequests.inc({ method, route });

    const stopTimer = this.metrics.httpRequestDuration.startTimer();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const statusCode = response.statusCode.toString();
        const statusClass = `${Math.floor(response.statusCode / 100)}xx`;

        stopTimer({ method, route, status_code: statusCode, status_class: statusClass });
        this.metrics.httpRequestsTotal.inc({ method, route, status_code: statusCode, status_class: statusClass });
        this.metrics.httpActiveRequests.dec({ method, route });
      }),
      catchError((error) => {
        const statusCode = (error.status || 500).toString();
        const statusClass = `${Math.floor(Number(statusCode) / 100)}xx`;

        stopTimer({ method, route, status_code: statusCode, status_class: statusClass });
        this.metrics.httpRequestsTotal.inc({ method, route, status_code: statusCode, status_class: statusClass });
        this.metrics.httpActiveRequests.dec({ method, route });

        throw error;
      }),
    );
  }

  private extractRoute(context: ExecutionContext): string {
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    return `${controller}.${handler}`;
  }
}
```

```typescript
// src/metrics/metrics.controller.ts
import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  async getMetrics(@Res() response: Response) {
    const metrics = await this.metricsService.getMetrics();
    response.set('Content-Type', this.metricsService.getContentType());
    response.send(metrics);
  }
}
```

> **Mentor Note:** Notice that the `MetricsModule` is decorated with `@Global()`. This means any module in the application can inject `MetricsService` without importing `MetricsModule`. This is intentional -- you want every service, controller, and guard in your application to be able to record custom metrics without ceremony. If teams have to jump through hoops to add a metric, they will not add metrics.

---

## Health Check Endpoints: Liveness vs Readiness Probes

Kubernetes uses two types of health checks to manage your pods. Confusing them is one of the most common sources of unnecessary downtime.

> **Key Term:** **Liveness Probe** — "Is this process alive and not deadlocked?" If the liveness probe fails, Kubernetes **kills the pod and restarts it**. This is the nuclear option. Only fail the liveness probe when the process is truly stuck and cannot recover on its own.

> **Key Term:** **Readiness Probe** — "Is this process ready to accept traffic?" If the readiness probe fails, Kubernetes **removes the pod from the load balancer** but does not restart it. The pod stays alive and has time to recover. When the readiness probe passes again, traffic is restored.

### The Critical Difference

```
Liveness fails → Kubernetes kills and restarts the pod
Readiness fails → Kubernetes stops sending traffic to the pod

These are NOT the same thing!
```

If your database connection drops for 30 seconds:
- **Liveness** should still pass (the process is alive and can reconnect)
- **Readiness** should fail (the process cannot serve requests right now)

If you fail the liveness probe when the database is down, Kubernetes will kill your pod, start a new one, the new pod will also fail to connect to the database, get killed, and so on. You now have a **crash loop** that makes recovery harder, not easier.

### Implementation in NestJS

```typescript
// src/health/health.module.ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { KafkaHealthIndicator } from './indicators/kafka.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator, KafkaHealthIndicator],
})
export class HealthModule {}
```

```typescript
// src/health/health.controller.ts
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { KafkaHealthIndicator } from './indicators/kafka.health';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private prisma: PrismaHealthIndicator,
    private redis: RedisHealthIndicator,
    private kafka: KafkaHealthIndicator,
  ) {}

  /**
   * LIVENESS probe: Is the process alive?
   * Only checks that the process can respond to HTTP requests.
   * Does NOT check external dependencies.
   * If this fails, Kubernetes will KILL the pod.
   */
  @Get('live')
  @HealthCheck()
  liveness() {
    return this.health.check([
      // Minimal checks only: process is alive, event loop is not blocked
      () => ({
        process: {
          status: 'up',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage().heapUsed,
        },
      }),
    ]);
  }

  /**
   * READINESS probe: Can this pod serve traffic?
   * Checks all critical dependencies.
   * If this fails, Kubernetes removes the pod from the load balancer.
   */
  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
      () => this.redis.isHealthy('cache'),
      () => this.kafka.isHealthy('message-broker'),
    ]);
  }

  /**
   * STARTUP probe: Has the application finished initializing?
   * Used during initial boot to give the app time to warm up.
   * Kubernetes will not send liveness/readiness probes until this passes.
   */
  @Get('startup')
  @HealthCheck()
  startup() {
    return this.health.check([
      () => this.prisma.isHealthy('database'),
    ]);
  }
}
```

```typescript
// src/health/indicators/prisma.health.ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      // Execute a lightweight query to verify the connection
      await this.prisma.$queryRaw`SELECT 1`;
      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError(
        `${key} health check failed`,
        this.getStatus(key, false, { message: error.message }),
      );
    }
  }
}
```

**Kubernetes deployment configuration:**

```yaml
# kubernetes/booking-service-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
spec:
  template:
    spec:
      containers:
        - name: booking-service
          image: booking-service:latest
          ports:
            - containerPort: 3000
          livenessProbe:
            httpGet:
              path: /health/live
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
            timeoutSeconds: 5
            failureThreshold: 3    # Kill after 3 consecutive failures (45s)
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3    # Remove from LB after 3 failures (30s)
            successThreshold: 1    # Re-add after 1 success
          startupProbe:
            httpGet:
              path: /health/startup
              port: 3000
            initialDelaySeconds: 0
            periodSeconds: 5
            failureThreshold: 30   # Give up to 150s for initial startup
```

> **Common Mistake:** Putting database health checks in the liveness probe. This is the number one cause of unnecessary cascading failures. Database goes down for 30 seconds -- every pod fails its liveness probe, Kubernetes restarts all pods simultaneously, the database comes back but now all pods are in a restart storm, amplifying the outage from 30 seconds to 5 minutes. The liveness probe should only check: "Can this process respond to HTTP? Is the event loop running?" Everything else belongs in readiness.
