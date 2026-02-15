# Chapter 45: Real Production Metrics --- The Numbers That Keep You Employed

## You Cannot Fix What You Cannot See

You have spent forty-four chapters building a system that handles 100,000 bookings per minute across four regions. You have designed sharding strategies, implemented saga patterns, tuned Kafka consumers, and rehearsed incident response. All of that work is meaningless if you cannot answer one question at any given moment: **is the system healthy right now?**

Not "was it healthy when we last checked." Not "it was healthy when I went to bed." Right now. This second.

Production systems do not send you a polite email when they start degrading. They rot quietly. A memory leak grows by 2 MB per hour. A Kafka consumer falls behind by a few hundred messages per minute. A single MySQL shard starts taking 50ms longer per query. None of these will trigger a page at first. But left undetected, each one will escalate into a 3 AM incident that costs you revenue, reputation, and sleep.

This chapter is about the metrics, dashboards, alerts, and calculations that keep you ahead of failure. Not theoretical metrics from a textbook --- the specific numbers that matter when you are operating a global booking platform at scale.

> **Analogy:** Think of production metrics like the instrument panel in a commercial aircraft cockpit. A pilot does not fly by looking out the window and guessing. They watch airspeed, altitude, fuel levels, engine temperature, and dozens of other gauges --- all in real time. Some gauges matter during takeoff, others during cruising, others during landing. The same is true for your system. Different metrics matter during a deployment, a traffic spike, a flash sale, and steady-state operation. This chapter teaches you which gauges to watch and when.

---

## 1. The Four Golden Signals

Google's Site Reliability Engineering book introduced the Four Golden Signals: **Latency**, **Traffic**, **Errors**, and **Saturation**. These four categories cover everything you need to monitor in a booking system. Every metric you track should map to one of these four. If it does not, you are probably tracking vanity metrics that look impressive on a slide deck but do not help you detect or resolve problems.

Let us walk through each one with real PromQL queries tuned for our architecture.

### Signal 1: Latency --- How Long Things Take

Latency is the most user-visible signal. A user clicks "Book Now" and waits. If the response takes 200ms, they feel instant gratification. If it takes 3 seconds, they wonder if something broke. If it takes 10 seconds, they leave and book with a competitor.

You must track latency at multiple percentiles. Averages are useless --- they hide the pain. If your average booking latency is 300ms but your p99 is 4 seconds, one in every hundred users is having a terrible experience. At 100,000 bookings per minute, that is 1,000 users per minute who might abandon your platform.

Here are the PromQL queries you need:

```promql
# Booking creation latency - p50 (median)
# This is your "normal" user experience
histogram_quantile(0.50,
  sum(rate(booking_duration_seconds_bucket{service="booking"}[5m])) by (le, region)
)

# Booking creation latency - p95
# 1 in 20 users experience this or worse
histogram_quantile(0.95,
  sum(rate(booking_duration_seconds_bucket{service="booking"}[5m])) by (le, region)
)

# Booking creation latency - p99
# Your worst-case common experience. If this is bad, you have a tail latency problem
histogram_quantile(0.99,
  sum(rate(booking_duration_seconds_bucket{service="booking"}[5m])) by (le, region)
)
```

Notice that every query breaks down by `region`. A healthy p99 in `us-east-1` does not mean much if `ap-southeast-1` is suffering. In a global system, regional breakdowns are not optional --- they are mandatory.

Now do the same for search, because search latency directly impacts conversion rate:

```promql
# Search latency p95 - this is the one product managers care about
histogram_quantile(0.95,
  sum(rate(search_duration_seconds_bucket{service="search"}[5m])) by (le, search_type)
)

# Search latency by type: availability check vs. full property search
# These have very different performance profiles
histogram_quantile(0.99,
  sum(rate(search_duration_seconds_bucket{service="search", search_type="availability"}[5m])) by (le)
)

histogram_quantile(0.99,
  sum(rate(search_duration_seconds_bucket{service="search", search_type="property_search"}[5m])) by (le)
)
```

Your targets should be concrete. Write them down and hold yourself to them:

| Operation | p50 Target | p95 Target | p99 Target |
|-----------|-----------|-----------|-----------|
| Booking creation | < 200ms | < 500ms | < 1.5s |
| Availability search | < 50ms | < 150ms | < 400ms |
| Property search | < 100ms | < 300ms | < 800ms |
| Payment processing | < 300ms | < 800ms | < 2s |
| Booking retrieval | < 30ms | < 80ms | < 200ms |

When a percentile exceeds its target, you investigate. Not tomorrow. Now.

### Signal 2: Traffic --- How Much Work the System Is Doing

Traffic tells you what the system is handling right now compared to what you expect. A sudden spike might mean a flash sale started. A sudden drop might mean something is broken and users cannot reach you. Both are actionable.

```promql
# Total bookings per second, broken down by region
sum(rate(bookings_total[1m])) by (region)

# Searches per second by region and type
sum(rate(searches_total[1m])) by (region, search_type)

# Kafka events produced per second by topic
sum(rate(kafka_producer_record_send_total[1m])) by (topic)

# Kafka events consumed per second by consumer group
sum(rate(kafka_consumer_records_consumed_total[1m])) by (consumer_group, topic)

# API requests per second by service and HTTP method
sum(rate(http_requests_total[1m])) by (service, method)
```

The most important derived metric from traffic is the **search-to-booking conversion rate**:

```promql
# Conversion rate: what percentage of searches result in a booking?
# A sudden drop here means your funnel is broken
(sum(rate(bookings_total[5m])) / sum(rate(searches_total{search_type="availability"}[5m]))) * 100
```

If your conversion rate drops from 3.2% to 1.8% over thirty minutes and traffic is stable, something in the booking flow is broken --- even if no errors are showing up in your logs. Maybe the payment form is not rendering. Maybe prices are displaying incorrectly. Conversion rate catches problems that error rates miss.

### Signal 3: Errors --- How Often Things Fail

Errors are the most obvious signal, but they are trickier than they appear. A raw count of errors is useless --- you need error **rates** as a percentage of total traffic. Ten errors per minute during off-peak (when you handle 10,000 requests per minute) is a 0.1% error rate. Ten errors per minute during peak (100,000 requests per minute) is a 0.01% error rate. Same count, very different severity.

```promql
# HTTP 5xx error rate (server errors) by service
sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)
  /
sum(rate(http_requests_total[5m])) by (service)

# Error budget burn rate: how fast are you consuming your error budget?
# For a 99.9% SLO, your budget is 0.1% of requests
# A burn rate of 1.0 means you are burning at exactly the sustainable rate
# A burn rate above 1.0 means you will exhaust your budget before the window ends
(
  sum(rate(http_requests_total{service="booking", status=~"5.."}[1h]))
  / sum(rate(http_requests_total{service="booking"}[1h]))
) / 0.001

# Saga failure rate: what percentage of booking sagas fail?
sum(rate(saga_completed_total{outcome="failed"}[5m]))
  /
sum(rate(saga_completed_total[5m]))

# Saga compensation rate: how often do we need to roll back?
sum(rate(saga_completed_total{outcome="compensated"}[5m]))
  /
sum(rate(saga_completed_total[5m]))

# Payment decline rate by payment provider
sum(rate(payment_attempts_total{outcome="declined"}[5m])) by (provider)
  /
sum(rate(payment_attempts_total[5m])) by (provider)

# Kafka consumer errors by consumer group
sum(rate(kafka_consumer_fetch_errors_total[5m])) by (consumer_group)
```

Pay attention to the saga metrics. In a choreography-based booking system, a failed saga does not just mean one thing went wrong. It means a chain of compensating transactions had to execute --- inventory was released, payments were refunded, notifications were sent. Each compensation is a potential failure point. If your saga failure rate climbs above 2%, you have a systemic problem, not a fluke.

### Signal 4: Saturation --- How Full Your Resources Are

Saturation answers the question: "How close is each component to its limit?" A system can have low latency, steady traffic, and zero errors --- and still be minutes away from collapse because a resource is 95% consumed.

```promql
# MySQL connection pool utilization per shard
# You have 16 shards. If any one hits 100%, writes to that shard stop.
(
  sum(mysql_connection_pool_active{}) by (shard)
  /
  sum(mysql_connection_pool_max{}) by (shard)
) * 100

# Redis memory utilization as percentage of maxmemory
# When this hits 100%, evictions begin and your cache hit rate collapses
(redis_memory_used_bytes / redis_memory_max_bytes) * 100

# Redis eviction rate: if this is > 0, you are already at capacity
rate(redis_evicted_keys_total[5m])

# Kafka consumer lag per consumer group and partition
# This is the number of messages waiting to be processed
kafka_consumer_group_lag{}

# Kafka consumer lag rate of change (is the lag growing or shrinking?)
rate(kafka_consumer_group_lag{}[5m])

# Kubernetes CPU utilization per pod vs. request
sum(rate(container_cpu_usage_seconds_total{namespace="booking"}[5m])) by (pod)
  /
sum(kube_pod_container_resource_requests{namespace="booking", resource="cpu"}) by (pod)

# Kubernetes memory utilization per pod vs. limit
sum(container_memory_working_set_bytes{namespace="booking"}) by (pod)
  /
sum(kube_pod_container_resource_limits{namespace="booking", resource="memory"}) by (pod)

# Disk I/O utilization on MySQL shards (approaching saturation?)
rate(node_disk_io_time_seconds_total{instance=~"mysql-shard-.*"}[5m])
```

The most dangerous saturation metric in our system is MySQL connection pool utilization per shard. Here is why: with 16 shards and consistent hashing, traffic is not perfectly balanced. A viral destination --- say, a celebrity posts about a hotel in Bali --- can send a disproportionate amount of traffic to one or two shards. Those shards run out of connections while the others sit idle. The global error rate might be 1%, but for users trying to book that hotel, the error rate is 100%.

This is why you monitor per-shard, not aggregate.

---

## 2. Production Dashboards --- Four Screens, Four Audiences

Dashboards exist for humans. Different humans need different information at different times. An executive asking "how is the business doing?" does not need Kafka consumer lag numbers. An on-call engineer at 3 AM does not need conversion rates. Building a single "everything dashboard" guarantees that nobody finds it useful.

You need exactly four dashboards. No more, no fewer.

### Dashboard 1: Business Metrics (Audience: Stakeholders, Product Managers, Executives)

This dashboard answers one question: **is the business healthy?** It uses business language, not engineering language. There are no mentions of pods, shards, or consumer groups. The refresh interval is 30 seconds --- fast enough to feel real-time, slow enough to avoid chart jitter.

**Panels:**

1. **Bookings Per Minute (Real-Time)** --- A single large time-series line chart dominating the top of the dashboard. Current value displayed as a big number overlay. Compared against same-day-last-week as a faded reference line. Breakdown by region available via dropdown but defaulting to global aggregate.

2. **Revenue Per Hour** --- Bar chart showing revenue in the last 24 hours, one bar per hour. Currency normalized to USD. A horizontal reference line showing the hourly revenue target. Color shifts from green to amber to red as performance deviates from target.

3. **Conversion Rate (Searches to Bookings)** --- Line chart showing the trailing 1-hour conversion rate. This is the single most important metric for the product team. A target band of 2.5%--4.0% is shaded in green. Values outside that band trigger visual warnings.

4. **Top 10 Destinations by Volume** --- A horizontal bar chart updated every 5 minutes. Shows the ten destinations with the most bookings in the last hour. Useful for spotting viral trends and marketing campaign impact.

5. **Average Booking Value with 7-Day Trend** --- A stat panel showing today's average booking value alongside a sparkline of the last 7 days. If average booking value drops sharply, it might indicate a pricing error or a change in traffic mix.

6. **Booking Status Breakdown** --- A pie or donut chart showing the proportion of bookings in each status: confirmed, pending, cancelled, failed. A growing "failed" slice is an immediate red flag.

This dashboard is displayed on a large monitor in the office. Non-technical people glance at it throughout the day. It tells them whether to be calm or concerned.

### Dashboard 2: Service Health (Audience: Backend Engineers, Team Leads)

This dashboard answers: **is each service behaving correctly?** It is service-oriented, showing individual microservice health across the booking, inventory, payment, notification, and search services.

**Panels:**

1. **Per-Service Latency Heatmaps** --- One heatmap per service showing request duration distribution over time. Dense clusters in the low-latency band are healthy. Bands creeping upward indicate degradation. Heatmaps reveal bimodal distributions (a sign of intermittent failures) that line charts hide.

2. **Error Rates by Service and Endpoint** --- A table showing every service/endpoint combination, its request rate, its error rate, and a colored status indicator. Sorted by error rate descending so problems float to the top.

3. **Circuit Breaker States** --- A status panel showing each circuit breaker's state: closed (healthy, green), half-open (testing, amber), open (tripped, red). At a glance, you can see which downstream dependencies are struggling.

4. **Saga Success / Failure / Compensation Rates** --- A stacked area chart showing the three outcomes of booking sagas over time. The failure and compensation areas should be thin slivers. If they start growing, the saga orchestration has a problem.

5. **Active Distributed Locks Count** --- A time-series chart showing the number of currently held distributed locks (Redis-based). A growing count indicates locks are being acquired but not released --- likely a deadlock or a process that crashed while holding a lock.

6. **Dependency Health Matrix** --- A grid showing each service-to-service dependency with a color-coded status (healthy, degraded, down). This is the first place you look during an incident to identify which dependency is causing cascading failures.

### Dashboard 3: Infrastructure (Audience: SRE Team, Platform Engineers)

This dashboard answers: **are the underlying systems healthy and within capacity?** It is component-oriented, focusing on MySQL, Redis, Kafka, Kubernetes, and networking.

**Panels:**

1. **Per-Shard MySQL Query Latency** --- A multi-line chart with one line per shard (all 16). When one shard's latency diverges from the others, it indicates a hot partition, a slow query, or hardware issues on that node.

2. **Per-Shard MySQL Connection Count** --- Bar chart showing active connections per shard versus the configured maximum. A shard approaching its connection limit needs immediate attention.

3. **Redis Memory Usage and Eviction Rate** --- Dual-axis chart. Left axis: memory usage in GB per Redis node. Right axis: eviction rate. When evictions start, your cache hit rate is about to collapse.

4. **Kafka Consumer Lag Per Consumer Group** --- A multi-line chart showing lag for each consumer group. Steady low lag is good. Growing lag means consumers cannot keep up with producers. This is the early-warning system for event processing delays.

5. **Kubernetes Pod Count vs. HPA Targets** --- A chart showing actual pod count alongside the HPA's desired pod count and the configured min/max bounds. When actual pods consistently hit the maximum, you have outgrown your autoscaling configuration.

6. **Cross-Region Replication Lag** --- A gauge showing the replication delay between the primary region and each replica region. For MySQL async replication, anything over 5 seconds is concerning. For Redis replication, anything over 1 second is concerning.

7. **Network Throughput Between Regions** --- Line chart showing inter-region bandwidth utilization. Approaching the bandwidth cap causes packet drops and retransmissions that manifest as mysterious latency spikes.

### Dashboard 4: On-Call (Audience: The Engineer Who Got Paged)

This dashboard answers: **what is broken right now and what changed recently?** It is the first thing you open when your pager goes off. Every panel is designed to reduce mean time to diagnosis.

**Panels:**

1. **Error Budget Remaining (30-Day Rolling Window)** --- A gauge showing what percentage of this month's error budget remains. Below 50% means you should freeze non-critical deployments. Below 20% means you are one incident away from breaching your SLO.

2. **Active Alerts with Severity** --- A table listing every currently firing alert, its severity (critical, warning, info), when it started, and a clickable link to its runbook. Sorted by severity so criticals appear at the top.

3. **Recent Deployments Timeline Overlay** --- A timeline bar across the top of the dashboard showing every deployment in the last 24 hours, with service name, version, and deployer. During an incident, the first question is always "did someone deploy something?" This panel answers it instantly.

4. **Anomaly Detection Highlights** --- Panels powered by Grafana's ML-based anomaly detection (or a connected tool like Prophet) that flag metrics behaving abnormally compared to their historical patterns. A metric might not have breached a threshold, but if it is three standard deviations from its 7-day norm, it deserves attention.

5. **Top Errors by Stack Trace** --- A table showing the most frequent error messages and stack traces in the last 30 minutes, grouped and counted. This prevents you from drowning in thousands of individual log lines when a single root cause produces thousands of symptoms.

6. **Correlated Metrics Panel** --- A multi-metric overlay showing latency, error rate, traffic, and CPU on a single timeline. Correlated spikes (latency and CPU rising together when traffic spikes) tell a different story than uncorrelated ones (latency rising while traffic is flat, suggesting a dependency issue).

---

## 3. Alert Design --- Making Alerts Actionable

Here is the uncomfortable truth about alerting in most organizations: **the majority of alerts are ignored.** Engineers get paged, glance at the alert, mutter "that one fires every Tuesday, it is nothing," and go back to sleep. This is called alert fatigue, and it is how real incidents get missed.

Every alert in your system must pass three tests:

1. **Is it actionable?** If the engineer who receives this alert cannot do anything about it, it should not be an alert. It should be a dashboard panel or a weekly report.

2. **Does it have a runbook?** Every alert must include a link to a runbook that explains what the alert means, what to check first, and what remediation steps to take. No runbook, no alert. This is not negotiable.

3. **Does it fire on symptoms, not causes?** Alert on "booking latency p99 is above 2 seconds," not on "MySQL CPU is above 80%." Users experience symptoms. High CPU is a cause that might or might not produce a symptom. If CPU is at 90% and latency is fine, there is nothing to wake someone up about.

### Multi-Window, Multi-Burn-Rate Alerting

Traditional threshold-based alerts (e.g., "alert if error rate > 1%") are brittle. They either fire too early (causing alert fatigue) or too late (missing slow-burn incidents). The modern approach is **multi-window, multi-burn-rate alerting**, tied to your SLO.

The idea is simple: instead of asking "is the error rate above a threshold right now?", you ask "at the current error rate, will we exhaust our error budget before the end of the SLO window?" You check this at multiple time windows (1 hour, 6 hours) to catch both fast and slow burns.

Here are the critical alert rules for our booking system:

```yaml
groups:
  - name: booking-slo-alerts
    rules:
      # ---------------------------------------------------------------
      # Alert 1: Booking Error Budget Burn Rate (Fast Burn)
      # If we are burning error budget 14.4x faster than sustainable
      # over a 1-hour window, we will exhaust our monthly budget in ~2 days.
      # This catches acute incidents.
      # ---------------------------------------------------------------
      - alert: BookingErrorBudgetFastBurn
        expr: |
          (
            sum(rate(http_requests_total{service="booking", status=~"5.."}[1h]))
            / sum(rate(http_requests_total{service="booking"}[1h]))
          ) > (14.4 * 0.001)
        for: 5m
        labels:
          severity: critical
          team: booking
        annotations:
          summary: >-
            Booking service burning error budget 14.4x faster than
            sustainable (1h window)
          description: >-
            At the current error rate, the 30-day error budget will be
            exhausted in approximately 2 days. Immediate investigation
            required.
          runbook: "https://runbooks.internal/booking/error-budget-burn"
          dashboard: "https://grafana.internal/d/oncall"

      # ---------------------------------------------------------------
      # Alert 2: Booking Error Budget Burn Rate (Slow Burn)
      # A slower burn over a 6-hour window. This catches degradations
      # that are not severe enough to trigger the fast-burn alert but
      # will still exhaust the budget if left unchecked.
      # ---------------------------------------------------------------
      - alert: BookingErrorBudgetSlowBurn
        expr: |
          (
            sum(rate(http_requests_total{service="booking", status=~"5.."}[6h]))
            / sum(rate(http_requests_total{service="booking"}[6h]))
          ) > (6 * 0.001)
        for: 30m
        labels:
          severity: warning
          team: booking
        annotations:
          summary: >-
            Booking service burning error budget 6x faster than
            sustainable (6h window)
          description: >-
            Sustained elevated error rate over 6 hours. Error budget
            will be exhausted in approximately 5 days at this rate.
          runbook: "https://runbooks.internal/booking/error-budget-burn"

      # ---------------------------------------------------------------
      # Alert 3: Kafka Consumer Lag Critical
      # If any consumer group falls behind by more than 100,000 messages
      # for more than 5 minutes, events are not being processed.
      # Bookings might be confirmed but payments not initiated,
      # notifications not sent, or search index not updated.
      # ---------------------------------------------------------------
      - alert: KafkaConsumerLagCritical
        expr: |
          sum(kafka_consumer_group_lag{}) by (consumer_group, topic) > 100000
        for: 5m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: >-
            Kafka consumer group {{ $labels.consumer_group }} has
            lag > 100K on topic {{ $labels.topic }}
          description: >-
            Consumer group {{ $labels.consumer_group }} is {{ $value }}
            messages behind on topic {{ $labels.topic }}. This means
            downstream processing (payments, notifications, search
            indexing) is significantly delayed.
          runbook: "https://runbooks.internal/kafka/consumer-lag"
          action: >-
            1. Check consumer group health: kubectl logs -l app={{ $labels.consumer_group }}
            2. Check for rebalancing: look for JoinGroup/LeaveGroup in logs
            3. Check downstream dependencies (DB, Redis) for slowness
            4. Consider temporarily scaling consumer instances

      # ---------------------------------------------------------------
      # Alert 4: Saga Failure Rate Elevated
      # If more than 5% of booking sagas are failing, something
      # systemic is wrong. Individual saga failures are expected;
      # a pattern of failures is not.
      # ---------------------------------------------------------------
      - alert: SagaFailureRateElevated
        expr: |
          (
            sum(rate(saga_completed_total{saga_type="booking", outcome="failed"}[10m]))
            / sum(rate(saga_completed_total{saga_type="booking"}[10m]))
          ) > 0.05
        for: 5m
        labels:
          severity: critical
          team: booking
        annotations:
          summary: >-
            Booking saga failure rate is {{ $value | humanizePercentage }}
            (threshold: 5%)
          description: >-
            More than 5% of booking sagas are failing. This likely
            indicates a downstream service (inventory, payment) is
            unhealthy. Check circuit breaker states and dependency
            health.
          runbook: "https://runbooks.internal/booking/saga-failures"

      # ---------------------------------------------------------------
      # Alert 5: Inventory Double-Booking Detection
      # This is the nuclear alert. If the inventory system detects
      # that two confirmed bookings overlap for the same room on the
      # same dates, data integrity has been compromised. This should
      # NEVER fire. If it does, all hands on deck.
      # ---------------------------------------------------------------
      - alert: InventoryDoubleBookingDetected
        expr: |
          increase(inventory_double_booking_detected_total[5m]) > 0
        for: 0m
        labels:
          severity: critical
          team: booking
          escalation: immediate
        annotations:
          summary: >-
            DOUBLE BOOKING DETECTED - {{ $value }} overlapping
            reservations found in the last 5 minutes
          description: >-
            The inventory reconciliation check has detected overlapping
            confirmed bookings. This is a data integrity violation.
            Immediate manual intervention required. Do NOT silence
            this alert.
          runbook: "https://runbooks.internal/booking/double-booking-emergency"
          action: >-
            1. Page the booking team lead immediately
            2. Identify affected booking IDs from the reconciliation log
            3. Contact affected guests proactively
            4. Freeze inventory writes for the affected property
            5. Root-cause the distributed lock failure

      # ---------------------------------------------------------------
      # Alert 6: Payment Timeout Rate Elevated
      # If more than 3% of payment attempts are timing out, the
      # payment provider may be degraded. This directly impacts
      # revenue.
      # ---------------------------------------------------------------
      - alert: PaymentTimeoutRateElevated
        expr: |
          (
            sum(rate(payment_attempts_total{outcome="timeout"}[5m])) by (provider)
            / sum(rate(payment_attempts_total[5m])) by (provider)
          ) > 0.03
        for: 3m
        labels:
          severity: critical
          team: payments
        annotations:
          summary: >-
            Payment timeout rate for {{ $labels.provider }} is
            {{ $value | humanizePercentage }} (threshold: 3%)
          description: >-
            Payment provider {{ $labels.provider }} is experiencing
            elevated timeout rates. Users are seeing payment failures.
            Consider switching to fallback provider if available.
          runbook: "https://runbooks.internal/payments/provider-timeout"

      # ---------------------------------------------------------------
      # Alert 7: Cross-Region Replication Lag
      # If replication lag exceeds 10 seconds, users in replica
      # regions may see stale data --- bookings that do not appear,
      # inventory that looks available when it is not.
      # ---------------------------------------------------------------
      - alert: CrossRegionReplicationLagHigh
        expr: |
          mysql_slave_seconds_behind_master{role="replica"} > 10
        for: 3m
        labels:
          severity: warning
          team: platform
        annotations:
          summary: >-
            MySQL replication lag is {{ $value }}s for
            {{ $labels.instance }} (threshold: 10s)
          description: >-
            Cross-region replication is falling behind. Users in
            {{ $labels.region }} may see stale booking data. If lag
            exceeds 30 seconds, consider redirecting traffic to the
            primary region.
          runbook: "https://runbooks.internal/mysql/replication-lag"
```

Notice the structure. Every alert has:
- A clear `summary` that fits in a Slack notification or PagerDuty title.
- A `description` that provides context without requiring the engineer to look elsewhere.
- A `runbook` link that opens a step-by-step guide.
- An `action` (on the most critical alerts) with numbered steps the on-call engineer can follow immediately.

The `for` clause prevents transient spikes from triggering alerts. The double-booking alert has `for: 0m` because there is no acceptable duration for that condition --- if it happens even once, you need to know immediately.

---

## 4. SLO Math for Engineers

SLOs --- Service Level Objectives --- are where engineering meets business. An SLO is a promise: "We will successfully handle X% of requests." Everything in the previous sections (metrics, dashboards, alerts) exists to help you keep that promise.

Let us make the math concrete with our booking system's numbers.

### The Error Budget Concept

Your SLO is 99.9% availability for the booking endpoint. That sounds impressively high. Here is what it actually means:

| Time Window | Total Minutes | Allowed Downtime |
|-------------|--------------|-----------------|
| Per day | 1,440 | 1.44 minutes (86.4 seconds) |
| Per week | 10,080 | 10.08 minutes |
| Per month (30 days) | 43,200 | 43.2 minutes |
| Per quarter | 129,600 | 129.6 minutes (~2.16 hours) |
| Per year | 525,600 | 525.6 minutes (~8.76 hours) |

43.2 minutes per month. That is your **error budget**. Every minute of downtime, every 5xx response, every failed booking --- all of it subtracts from that budget.

But downtime is not the only way to think about error budgets. You can express them in terms of requests:

```
Error budget (requests) = (1 - SLO) * total_requests
```

At 100,000 bookings per minute:

```
Requests per month = 100,000 * 60 * 24 * 30 = 4,320,000,000

Error budget = (1 - 0.999) * 4,320,000,000 = 4,320,000 failed requests per month
```

That seems like a lot --- 4.32 million failed requests. But spread over a month, it is only 100 failures per minute. If a single bad deployment causes 5,000 errors per minute for 20 minutes, you have consumed 100,000 of your 4.32 million budget in a single incident. A few incidents like that and your budget is gone.

### Burn Rate Calculation

The burn rate tells you how fast you are consuming the budget relative to the sustainable rate. A burn rate of 1.0 means you will exactly exhaust your budget at the end of the window. A burn rate of 2.0 means you will exhaust it in half the time.

```
Burn rate = actual_error_rate / allowed_error_rate
```

For a 99.9% SLO, the allowed error rate is 0.1% (0.001). If your actual error rate over the last hour is 0.5%:

```
Burn rate = 0.005 / 0.001 = 5.0
```

A burn rate of 5.0 means you are consuming your monthly error budget 5x faster than you can afford. At that rate, your 30-day budget will last only 6 days.

Here is the burn rate table used by our alert rules:

| Burn Rate | Budget Exhaustion Time | Alert Severity | Window |
|-----------|----------------------|----------------|--------|
| 14.4x | ~2 days | Critical | 1 hour |
| 6.0x | ~5 days | Warning | 6 hours |
| 3.0x | ~10 days | Warning | 1 day |
| 1.0x | 30 days (on budget) | None | --- |

### The SLO Calculator Service

In a production system, you do not calculate this by hand. You build a service that tracks it continuously and exposes the results to dashboards and alert rules.

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrometheusService } from '../prometheus/prometheus.service';

interface ErrorBudgetResult {
  slo: number;
  windowDays: number;
  totalRequests: number;
  failedRequests: number;
  errorBudgetTotal: number;
  errorBudgetConsumed: number;
  errorBudgetRemaining: number;
  percentRemaining: number;
  burnRate: number;
  estimatedExhaustionDays: number | null;
  status: 'healthy' | 'warning' | 'critical' | 'exhausted';
}

interface SLOTarget {
  service: string;
  endpoint: string;
  slo: number;
  windowDays: number;
}

@Injectable()
export class SLOCalculatorService {
  private readonly logger = new Logger(SLOCalculatorService.name);

  private readonly sloTargets: SLOTarget[] = [
    {
      service: 'booking',
      endpoint: '/api/v1/bookings',
      slo: 0.999,
      windowDays: 30,
    },
    {
      service: 'search',
      endpoint: '/api/v1/search',
      slo: 0.995,
      windowDays: 30,
    },
    {
      service: 'payment',
      endpoint: '/api/v1/payments',
      slo: 0.9995,
      windowDays: 30,
    },
    {
      service: 'inventory',
      endpoint: '/api/v1/inventory',
      slo: 0.999,
      windowDays: 30,
    },
  ];

  calculateErrorBudget(
    slo: number,
    windowDays: number,
    totalRequests: number,
    failedRequests: number,
  ): ErrorBudgetResult {
    const errorBudgetTotal = (1 - slo) * totalRequests;
    const errorBudgetConsumed = failedRequests;
    const errorBudgetRemaining = Math.max(
      0,
      errorBudgetTotal - errorBudgetConsumed,
    );
    const percentRemaining =
      errorBudgetTotal > 0
        ? (errorBudgetRemaining / errorBudgetTotal) * 100
        : 0;

    // Burn rate: how fast are we consuming relative to sustainable rate
    const allowedErrorRate = 1 - slo;
    const actualErrorRate =
      totalRequests > 0 ? failedRequests / totalRequests : 0;
    const burnRate =
      allowedErrorRate > 0 ? actualErrorRate / allowedErrorRate : 0;

    // Estimated exhaustion: at current burn rate, when do we run out?
    let estimatedExhaustionDays: number | null = null;
    if (burnRate > 0) {
      estimatedExhaustionDays = windowDays / burnRate;
    }

    // Status determination
    let status: ErrorBudgetResult['status'];
    if (percentRemaining <= 0) {
      status = 'exhausted';
    } else if (percentRemaining < 20) {
      status = 'critical';
    } else if (percentRemaining < 50) {
      status = 'warning';
    } else {
      status = 'healthy';
    }

    return {
      slo,
      windowDays,
      totalRequests,
      failedRequests,
      errorBudgetTotal,
      errorBudgetConsumed,
      errorBudgetRemaining,
      percentRemaining,
      burnRate,
      estimatedExhaustionDays,
      status,
    };
  }

  async evaluateAllSLOs(): Promise<Map<string, ErrorBudgetResult>> {
    const results = new Map<string, ErrorBudgetResult>();

    for (const target of this.sloTargets) {
      const key = `${target.service}:${target.endpoint}`;

      // In production, these values come from Prometheus queries
      const totalRequests = await this.queryTotalRequests(
        target.service,
        target.endpoint,
        target.windowDays,
      );
      const failedRequests = await this.queryFailedRequests(
        target.service,
        target.endpoint,
        target.windowDays,
      );

      const result = this.calculateErrorBudget(
        target.slo,
        target.windowDays,
        totalRequests,
        failedRequests,
      );

      results.set(key, result);

      if (result.status === 'critical' || result.status === 'exhausted') {
        this.logger.warn(
          `SLO ${key}: ${result.percentRemaining.toFixed(1)}% budget remaining. ` +
          `Burn rate: ${result.burnRate.toFixed(2)}x. ` +
          `Status: ${result.status}`,
        );
      }
    }

    return results;
  }

  /**
   * Calculates whether a proposed maintenance window is safe
   * given the current error budget remaining.
   */
  canAffordMaintenanceWindow(
    budget: ErrorBudgetResult,
    estimatedDowntimeMinutes: number,
    requestsPerMinute: number,
  ): { safe: boolean; reason: string } {
    const estimatedFailedRequests =
      estimatedDowntimeMinutes * requestsPerMinute;
    const budgetAfterMaintenance =
      budget.errorBudgetRemaining - estimatedFailedRequests;
    const percentAfter =
      budget.errorBudgetTotal > 0
        ? (budgetAfterMaintenance / budget.errorBudgetTotal) * 100
        : 0;

    if (budgetAfterMaintenance < 0) {
      return {
        safe: false,
        reason:
          `Maintenance would consume ${estimatedFailedRequests.toLocaleString()} ` +
          `requests but only ${budget.errorBudgetRemaining.toLocaleString()} remain. ` +
          `This would breach the ${(budget.slo * 100).toFixed(2)}% SLO.`,
      };
    }

    if (percentAfter < 20) {
      return {
        safe: false,
        reason:
          `Maintenance would leave only ${percentAfter.toFixed(1)}% error budget. ` +
          `Any subsequent incident would breach the SLO. Postpone if possible.`,
      };
    }

    return {
      safe: true,
      reason:
        `Maintenance would consume ${estimatedFailedRequests.toLocaleString()} ` +
        `of ${budget.errorBudgetRemaining.toLocaleString()} remaining budget ` +
        `(${percentAfter.toFixed(1)}% would remain).`,
    };
  }

  private async queryTotalRequests(
    service: string,
    endpoint: string,
    windowDays: number,
  ): Promise<number> {
    // In production, this executes a PromQL query:
    // sum(increase(http_requests_total{service="${service}",
    //   endpoint="${endpoint}"}[${windowDays}d]))
    // Stubbed here for illustration
    return 0;
  }

  private async queryFailedRequests(
    service: string,
    endpoint: string,
    windowDays: number,
  ): Promise<number> {
    // In production, this executes a PromQL query:
    // sum(increase(http_requests_total{service="${service}",
    //   endpoint="${endpoint}", status=~"5.."}[${windowDays}d]))
    return 0;
  }
}
```

The `canAffordMaintenanceWindow` method deserves special attention. Before any planned maintenance --- database migrations, cluster upgrades, network changes --- you check whether you can afford the downtime. If your error budget is already 70% consumed and you are only halfway through the month, the answer might be "not right now." This is how error budgets turn abstract numbers into concrete engineering decisions.

---

## 5. Cost Per Booking --- The Metric Your CFO Cares About

Engineers optimize for latency, reliability, and throughput. CFOs optimize for one thing: **unit economics.** The metric that bridges these two worlds is **cost per booking** --- the total infrastructure cost divided by the total number of successful bookings.

### The Calculation

```
Cost per booking = Total monthly infrastructure cost / Total monthly successful bookings
```

At our scale:

```
Total monthly bookings = 100,000/min * 60 * 24 * 30 = 4,320,000,000
Assume 10% are failed/cancelled, so successful = 3,888,000,000

Target infrastructure cost: < $0.005 per booking
Maximum monthly infrastructure budget: 3,888,000,000 * $0.005 = $19,440,000
```

That sounds like a lot, but infrastructure for a system at this scale is expensive. The question is not whether the total is large --- the question is whether each component is pulling its weight.

### Breaking Down the Cost

You need to attribute costs to individual components so you can identify where the money goes and where to optimize. Here is a representative breakdown:

| Component | Monthly Cost | % of Total | Cost per Booking |
|-----------|-------------|-----------|-----------------|
| Kubernetes compute (4 regions) | $7,200,000 | 42% | $0.00185 |
| MySQL (16 shards, replicas, backups) | $3,400,000 | 20% | $0.00087 |
| Kafka (15 brokers, KRaft, storage) | $1,800,000 | 10% | $0.00046 |
| Redis Cluster (memory is expensive) | $1,500,000 | 9% | $0.00039 |
| Elasticsearch (search cluster) | $1,200,000 | 7% | $0.00031 |
| Network (cross-region transfer) | $1,000,000 | 6% | $0.00026 |
| Observability (metrics, logs, traces) | $800,000 | 5% | $0.00021 |
| Other (DNS, CDN, secrets management) | $200,000 | 1% | $0.00005 |
| **Total** | **$17,100,000** | **100%** | **$0.0044** |

At $0.0044 per booking, you are under the $0.005 target. But look at the breakdown --- compute is 42% of the total. That is where optimization efforts yield the largest return.

### Cost Optimization Strategies That Do Not Sacrifice Reliability

**1. Right-size Kubernetes resource requests.**
Most teams over-provision CPU and memory requests. If your pods request 2 CPU cores but use 0.6 on average, you are paying for 1.4 unused cores per pod, multiplied by hundreds of pods. Use Vertical Pod Autoscaler (VPA) in recommendation mode to identify over-provisioned workloads. Reducing Kubernetes compute cost by even 15% saves over $1 million per month at this scale.

**2. Use reserved instances or committed use discounts.**
On-demand pricing is for traffic you cannot predict. Your baseline capacity is predictable. Reserve it. Three-year commitments on compute instances typically save 40-60% compared to on-demand pricing. At $7.2M per month in compute, a 50% savings on 70% of capacity (the baseline) is $2.52M per month.

**3. Tiered storage for Kafka.**
Not all Kafka data needs to live on fast SSDs. Messages older than 24 hours can be moved to cheaper object storage (S3, GCS). Kafka's tiered storage feature (KRaft mode supports this) can reduce Kafka storage costs by 60% or more for topics with long retention.

**4. RedisJSON and compression for large values.**
If your Redis values average 2 KB and you can compress them to 800 bytes, you just reduced your Redis memory requirement by 60%. With Redis being 9% of your total cost, that is a meaningful saving.

**5. Elasticsearch index lifecycle management.**
Search data older than 30 days does not need hot-tier nodes. Move it to warm-tier, then cold-tier, then delete it. Hot-tier Elasticsearch nodes cost 3-5x more than cold-tier nodes for the same storage capacity.

### Tracking Cost Per Booking Over Time

Expose cost per booking as a Prometheus metric so it appears on your Business Metrics dashboard:

```promql
# Cost per booking trend (updated daily from billing API)
infrastructure_cost_per_booking_dollars{component="total"}

# Cost breakdown by component
infrastructure_cost_per_booking_dollars{} by (component)
```

If cost per booking is rising while traffic is flat, something is wrong --- maybe a new logging pipeline is consuming more storage, or an autoscaler got stuck at maximum capacity overnight. If cost per booking is falling while traffic grows, your system is demonstrating healthy economies of scale.

---

## 6. Capacity Planning Signals --- When to Scale, When to Hold

Autoscaling handles short-term variability. Capacity planning handles long-term growth. These are different disciplines with different time horizons. Autoscaling reacts in minutes. Capacity planning looks months ahead.

The signals you monitor for capacity planning are the same saturation metrics from Section 1, but evaluated over longer windows and with different thresholds.

### When to Scale Up

Each threshold below represents the point at which a component has enough headroom for daily variability but not enough for sustained growth. Crossing these thresholds does not mean "the system is about to crash." It means "if traffic grows another 20%, we will not have enough margin."

**MySQL Shard Write Capacity > 70%**

```promql
# Sustained write throughput vs. tested maximum per shard
(
  avg_over_time(
    mysql_shard_writes_per_second{}[24h]
  )
  /
  mysql_shard_max_tested_writes_per_second{}
) > 0.70
```

When a shard consistently uses more than 70% of its tested write capacity, you have two options: split the shard (adding a 17th shard), or vertically scale the database instance. Splitting is preferred because it also reduces read load and data volume per shard.

**Redis Memory > 75%**

```promql
# Sustained Redis memory usage approaching limit
(
  avg_over_time(redis_memory_used_bytes[24h])
  /
  redis_memory_max_bytes
) > 0.75
```

At 75% memory, you have room for a traffic spike but not for sustained growth. Options: add nodes to the Redis Cluster (redistributing hash slots), increase `maxmemory` on existing nodes, or optimize your data structures to use less memory per key. Review your TTLs first --- you may be caching data longer than necessary.

**Kafka Consumer Lag Growing for > 5 Minutes**

```promql
# Consumer lag rate of change: positive = falling behind
avg_over_time(
  deriv(kafka_consumer_group_lag{}[5m])[10m:]
) > 0
```

If consumer lag is consistently growing (not just spiking and recovering), consumers cannot keep up. Before adding consumer instances, check whether the bottleneck is CPU (add instances), I/O (upgrade disk), or downstream calls (optimize the consumer's processing logic). Adding instances to a consumer group that is slow because of a database bottleneck will not help --- you will just have more consumers waiting on the same slow database.

**Kubernetes Pods at > 80% CPU for > 10 Minutes**

```promql
# Pods consistently hitting CPU limits suggests HPA max is too low
# or the pod's CPU request/limit needs to increase
(
  sum(rate(container_cpu_usage_seconds_total{namespace="booking"}[5m])) by (pod)
  /
  sum(kube_pod_container_resource_limits{namespace="booking", resource="cpu"}) by (pod)
) > 0.80
```

When pods are at 80% CPU and HPA has already scaled to its configured maximum, you need to either raise the HPA maximum, vertically scale (increase CPU per pod), or optimize the application code. Profiling the application to find CPU-intensive operations (JSON serialization, complex validation, logging) often yields 20-30% CPU improvements without infrastructure changes.

### When to Scale Down

Scaling down saves money but is more dangerous than scaling up. Remove too much capacity and the next traffic spike causes an outage. The rules for scaling down must be more conservative.

**Resource utilization below 30% for > 24 hours**

Do not scale down based on a few hours of low traffic. Wait a full 24-hour cycle to confirm that even peak-hour utilization stays below 30%. This accounts for daily traffic patterns --- low utilization at 3 AM does not mean low utilization tomorrow at 11 AM.

```promql
# Only flag for scale-down if the MAXIMUM utilization over 24h is below 30%
max_over_time(
  (
    sum(rate(container_cpu_usage_seconds_total{namespace="booking"}[5m])) by (deployment)
    /
    sum(kube_pod_container_resource_requests{namespace="booking", resource="cpu"}) by (deployment)
  )[24h:]
) < 0.30
```

**NEVER auto-scale down during business hours in any active region.**

This is non-negotiable. Automated scale-down should only execute between 02:00 and 06:00 local time in the region where the resources are deployed. And even then, only if the 24-hour utilization check passes.

Here is the logic expressed as a capacity planning policy:

```typescript
interface ScaleDownDecision {
  shouldScaleDown: boolean;
  reason: string;
  safeToExecute: boolean;
  recommendedAction: string;
}

function evaluateScaleDown(
  deploymentName: string,
  region: string,
  maxUtilization24h: number,
  currentHourUTC: number,
  regionOffsetHours: number,
): ScaleDownDecision {
  const localHour = (currentHourUTC + regionOffsetHours) % 24;
  const isBusinessHours = localHour >= 6 && localHour < 2; // 06:00 - 02:00
  const isLowUtilization = maxUtilization24h < 0.30;

  if (!isLowUtilization) {
    return {
      shouldScaleDown: false,
      reason: `Max 24h utilization is ${(maxUtilization24h * 100).toFixed(1)}% (threshold: 30%)`,
      safeToExecute: false,
      recommendedAction: 'No action needed. Utilization is within expected range.',
    };
  }

  if (isBusinessHours) {
    return {
      shouldScaleDown: true,
      reason: `Max 24h utilization is ${(maxUtilization24h * 100).toFixed(1)}%, below 30% threshold`,
      safeToExecute: false,
      recommendedAction:
        `Scale-down recommended for ${deploymentName} in ${region} but blocked ` +
        `during business hours (local time: ${localHour}:00). Will execute ` +
        `automatically during the next maintenance window (02:00-06:00 local).`,
    };
  }

  return {
    shouldScaleDown: true,
    reason: `Max 24h utilization is ${(maxUtilization24h * 100).toFixed(1)}%, below 30% threshold`,
    safeToExecute: true,
    recommendedAction:
      `Safe to scale down ${deploymentName} in ${region}. ` +
      `Local time is ${localHour}:00 (within maintenance window). ` +
      `Reduce replica count by 1 and re-evaluate in 24 hours.`,
  };
}
```

Notice the conservatism: scale down by one replica at a time, then wait 24 hours before considering further reductions. Aggressive scale-down is how you save $50,000 on infrastructure and lose $500,000 in revenue when a traffic spike hits an under-provisioned system.

### Capacity Planning Calendar

Beyond reactive signals, maintain a forward-looking capacity planning calendar:

| Event | Expected Impact | Lead Time | Action |
|-------|----------------|-----------|--------|
| Holiday season (Dec) | +300% booking traffic | 8 weeks | Pre-scale all components, load test at 4x |
| Flash sale events | +500% for 2-4 hours | 1 week | Pre-scale, warm caches, notify on-call |
| New region launch | +25% global traffic | 12 weeks | Provision full regional stack |
| Marketing campaign | +50-100% search traffic | 2 weeks | Scale search and Elasticsearch |
| Rate refresh (pricing) | +200% inventory writes | 4 weeks | Scale MySQL write capacity |

The best capacity planners do not wait for metrics to tell them to scale. They look at the business calendar and scale before the traffic arrives.

---

## Chapter Summary

| Topic | Key Takeaway | Primary Metric |
|-------|-------------|----------------|
| Latency | Track p50, p95, and p99 separately. Averages hide tail latency pain. | `histogram_quantile(0.99, ...)` |
| Traffic | Monitor absolute rates and derived metrics like conversion rate. A traffic drop can be as bad as an error spike. | `sum(rate(bookings_total[1m])) by (region)` |
| Errors | Express errors as rates relative to traffic, not raw counts. Tie them to error budgets. | Error rate / (1 - SLO) = burn rate |
| Saturation | Monitor per-component, per-shard, per-node. Aggregates hide hot spots. | Connection pool %, memory %, consumer lag |
| Dashboards | Four dashboards, four audiences. Business, service health, infrastructure, on-call. | --- |
| Alert design | Every alert must be actionable, symptom-based, and linked to a runbook. Use multi-burn-rate alerting. | Burn rate thresholds: 14.4x, 6x, 3x |
| SLO math | 99.9% = 43.2 min downtime/month. Error budget = (1 - SLO) * total requests. Track burn rate continuously. | Error budget % remaining |
| Cost per booking | Total infra cost / total bookings. Target < $0.005. Compute is your biggest lever. | `infrastructure_cost_per_booking_dollars` |
| Scale-up signals | MySQL > 70% writes, Redis > 75% memory, Kafka lag growing, pods > 80% CPU. | Per-component saturation metrics |
| Scale-down signals | Max utilization < 30% for 24h. Never during business hours. One replica at a time. | `max_over_time(...[24h:])` |

The metrics in this chapter are not academic exercises. They are the numbers you will stare at during incidents, reference during capacity planning meetings, and present during executive reviews. Internalize them. Build the dashboards before you need them. Write the alerts before the first failure. Calculate the error budgets before the first SLO breach.

The best time to instrument your system was when you built it. The second-best time is right now.
