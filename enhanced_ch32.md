# Chapter 32: SLOs & SLIs — Promises to Your Users

## The Gap Between "Up" and "Working"

At 2:14 AM on a Tuesday, your pager is silent. Grafana dashboards glow green. Every pod is healthy, every health check passes, every database connection pool reports availability. Your system is "up."

But right now, 12,000 users in Tokyo are watching a loading spinner for 11 seconds before search results appear. A payment confirmation page in Berlin is returning stale cached data from 45 seconds ago. And in New York, 0.3% of booking attempts are silently failing because a downstream inventory service is returning malformed responses that your API gateway marks as 200 OK -- because technically, it did return a response.

Your system is up. Your system is also broken.

This is the fundamental problem that SLOs solve. "Is it up?" is the wrong question. The right question is: "Is our system delivering the experience we promised to our users?" And to answer that question, you need three things: a way to measure user experience numerically, a target for what "good enough" means, and a decision-making framework for when you fall short.

This chapter gives you all three. By the end, you will have precise SLI definitions for every service in our Global Booking System, mathematically grounded SLO targets, automated error budget tracking, multi-window burn-rate alerting, and a full NestJS implementation you can deploy tomorrow. More importantly, you will have a shared language for the hardest conversation in engineering: "How reliable is reliable enough?"

> **Analogy:** Think about a restaurant. The restaurant is "open" -- the doors are unlocked, the lights are on, the kitchen is staffed. But if your food takes 90 minutes to arrive, the steak is raw in the center, and the waiter brings the wrong bill, the restaurant is not delivering on its promise. The health inspector (your monitoring system) might give it a passing grade -- no rats, the fridge is cold enough, the fire exits work. But the Michelin guide (your SLOs) would give it zero stars. SLOs measure what the diner experiences, not what the kitchen reports.

---

## SLI versus SLO versus SLA: The Three Pillars

These three acronyms look almost identical. They are not. Each one operates at a different level of abstraction, is owned by a different group, and serves a different purpose. Confusing them leads to organizational dysfunction -- engineers arguing about contracts, lawyers defining metrics, product managers setting targets they do not understand.

Let us separate them permanently.

### SLI: The Thermometer

> **Key Term:** **SLI (Service Level Indicator)** -- A quantitative measurement of some aspect of the service that users care about. An SLI is a ratio, typically expressed as a proportion between 0 and 1 (or equivalently, 0% to 100%). Examples: the fraction of requests that completed successfully, the fraction of requests served faster than a threshold, the fraction of records processed correctly.

An SLI is a thermometer. It tells you the temperature. It does not tell you whether the temperature is acceptable -- that is the SLO's job. It does not create consequences for unacceptable temperature -- that is the SLA's job. It just measures.

For our booking system, here are concrete SLIs:

```
SLI: Availability
  = (number of non-5xx responses) / (total number of responses)

SLI: Booking Latency
  = (number of booking requests completed in < 2s) / (total booking requests)

SLI: Search Correctness
  = (number of search results matching ground truth) / (total search results)

SLI: Data Freshness
  = (number of reads returning data < 5s old) / (total reads)
```

Notice the pattern. Every SLI is a fraction: good events divided by total events. This is not an accident. Google's SRE team discovered that expressing SLIs as ratios makes them composable, comparable, and amenable to error budget math. A P99 latency of 1.2 seconds is harder to reason about than "98.7% of requests are served under 2 seconds." The ratio form tells you directly what fraction of your users are happy.

> **What If You Skip This?** If you define SLIs as raw numbers instead of ratios (e.g., "average latency is 200ms" or "we had 47 errors today"), you lose the ability to calculate error budgets. You also lose comparability -- is 47 errors good or bad? It depends on total traffic, which a raw count does not capture. Always use ratios.

### SLO: The Thermostat

> **Key Term:** **SLO (Service Level Objective)** -- A target value (or range) for an SLI, measured over a specific time window. An SLO says: "We aim for this SLI to be at or above X% over a rolling Y-day window." Example: "99.99% of requests return a non-5xx response, measured over a rolling 30-day window."

An SLO is a thermostat. It defines the desired temperature. When the actual temperature (SLI) deviates from the target, the system (your team) takes action. Too cold? Turn up the heat (invest in reliability). At the right temperature? Save energy (ship features instead).

An SLO has four components:

1. **The SLI it references.** "Availability" or "booking latency."
2. **The target value.** "99.99%" or "< 2 seconds for 99% of requests."
3. **The measurement window.** "Rolling 30-day" or "calendar month."
4. **The denominator exclusions.** "Excluding health checks and synthetic probes."

Here is a fully specified SLO for our booking system:

```
SLO: Booking API Availability
  SLI: (non-5xx responses to /api/v1/bookings) / (total responses to /api/v1/bookings)
  Target: >= 99.99%
  Window: Rolling 30 days
  Exclusions: Health check endpoints, synthetic monitoring requests,
              requests during announced maintenance windows
```

The exclusions matter. If your Kubernetes liveness probe hits your API 10 times per second, those synthetic requests will inflate your denominator and make your availability look artificially high. Exclude them to measure what real users experience.

### SLA: The Contract

> **Key Term:** **SLA (Service Level Agreement)** -- A formal, legally binding contract between a service provider and its customers that specifies the consequences of meeting or missing specific SLO targets. SLAs include remedies: service credits, refund percentages, or contract termination rights.

An SLA is a legal document. It lives in a contract, not in a YAML file. It is negotiated by business development and legal teams, not by engineers. And critically, **your SLA targets should always be weaker than your SLO targets.**

Here is why. If your internal SLO is 99.99% and your external SLA is also 99.99%, you have zero safety margin. The moment you dip below target, you owe customers money. Instead, set your SLA at 99.9% while keeping your SLO at 99.99%. That 10x gap gives you room to have a bad week without triggering contractual penalties.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   SLO: 99.99%  ←── Internal engineering target          │
│   ════════════════════════════════════════               │
│                                                         │
│   ↕ Safety buffer (10x gap in error budget)             │
│                                                         │
│   SLA: 99.9%   ←── Contractual customer promise         │
│   ════════════════════════════════════════               │
│                                                         │
│   Below SLA: penalty zone (credits, refunds)            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

For our Global Booking System, here is how the three layers map:

| Layer | Target | Who Owns It | Consequence of Missing |
|-------|--------|-------------|----------------------|
| SLI | Measured value (e.g., 99.97%) | Engineering (instrumentation) | None -- it is just data |
| SLO | 99.99% availability | Engineering + Product | Error budget policy triggers (deploy freeze, reliability sprint) |
| SLA | 99.9% availability | Business + Legal | 10% service credit per 0.1% below target, up to 30% |

> **Checkpoint:** Your booking API returned 9,994 successful responses out of 10,000 total requests last month. What is the SLI value? (Answer: 99.94%.) Is this meeting an SLO of 99.99%? (Answer: No -- you are 0.05% below target.) Would this trigger an SLA penalty if the SLA threshold is 99.9%? (Answer: Yes -- 99.94% is above 99.9%, so no penalty is triggered.) Make sure you got all three right before continuing.

---

## Choosing the Right SLIs: What to Measure

Not everything that can be measured should become an SLI. Your Prometheus instance tracks hundreds of metrics -- CPU utilization, JVM heap pressure, Kafka consumer lag, connection pool saturation, goroutine counts. Most of these are **implementation details**, not user-facing quality signals. If you make CPU utilization an SLI, you will page engineers when the CPU spikes to 90% even though users are seeing sub-200ms latencies and zero errors. That is noise, not signal.

Good SLIs satisfy three criteria:

1. **Users care about it.** If the metric went from good to bad, would a user notice? Users notice latency. Users notice errors. Users notice stale search results. Users do not notice that your Redis instance swapped from node A to node B.

2. **It is measurable at the boundary.** Measure at the point closest to the user: the load balancer, the API gateway, the CDN edge. Internal metrics (database query time, queue depth) are useful for debugging but not for SLIs, because they miss problems that occur between the internal component and the user.

3. **It differentiates good from bad events.** Every request must be classifiable as either "good" or "bad" with respect to this SLI. A 200 response in 150ms is good. A 500 response is bad. A 200 response that took 30 seconds? Your SLI definition must handle that case explicitly (it is bad for the latency SLI, good for the availability SLI).

### The Four SLI Categories

Google's SRE Workbook identifies four categories of SLIs that cover virtually all user-facing quality signals. Here is how each one applies to our booking system.

#### 1. Availability: "Did it work?"

The most fundamental SLI. When a user sends a request, do they get a valid response?

```
SLI Definition:
  Good event:  HTTP response with status code not in {500, 501, 502, 503, 504}
  Bad event:   HTTP response with status code in {500, 501, 502, 503, 504}
  Valid event: All HTTP responses (excluding health checks)

  Formula: count(good events) / count(valid events)
```

Why exclude 4xx errors from "bad events"? Because a 404 or 400 is the system working correctly -- it is telling the user they made a mistake. A 5xx is the system failing. If a user sends a malformed request and gets a 400, that is the system doing its job.

However, there are exceptions. A 429 (Too Many Requests) might indicate that your rate limiter is too aggressive, causing legitimate users to be throttled. You might choose to include 429s in your "bad events" count if throttling becomes a user-experience problem. The key is to define your SLI explicitly and document the edge cases.

#### 2. Latency: "Was it fast enough?"

Users have latency expectations. Searches should feel instant. Bookings can take a moment (the user expects some processing). Payment confirmations should be quick but not necessarily instant (the user understands that charging a credit card takes a second).

```
SLI Definition:
  Good event:  Successful request completed in less than threshold T
  Bad event:   Successful request completed in T or more
  Valid event: All successful requests (exclude errors — they are handled
               by the availability SLI)

  Formula: count(successful requests faster than T) / count(successful requests)
```

Notice we only measure latency on successful requests. A 500 error that returns in 2ms is not "fast" -- it is broken. Latency and availability are orthogonal SLIs that should not contaminate each other.

Here are the latency thresholds we chose for each endpoint category:

| Endpoint Category | Threshold | Percentile | Rationale |
|-------------------|-----------|------------|-----------|
| Search queries | 500ms | P99 | Users expect near-instant search results |
| Booking creation | 2,000ms | P99 | Users accept brief processing time for booking |
| Payment processing | 3,000ms | P95 | External payment providers add unpredictable latency |
| Booking retrieval | 300ms | P99 | Simple database lookup, should be fast |
| Inventory check | 200ms | P99 | Called frequently by search, must be fast |

Why P99 for most endpoints but P95 for payment? Because payment latency depends on external providers (Stripe, PayPal, local gateways) that we cannot control. Using P99 would mean a single slow Stripe API call per hundred requests would violate our SLO. P95 gives us headroom for external variability while still ensuring the vast majority of payments are fast.

#### 3. Correctness: "Was the answer right?"

This SLI is often overlooked, but for a booking system it is critical. A search that returns available rooms that are actually booked is worse than a search that fails -- because it leads the user down a path that ends in frustration at checkout.

```
SLI Definition:
  Good event:  Response where the data matches the source of truth
  Bad event:   Response where the data diverges from the source of truth
  Valid event: All responses that return data

  Formula: count(correct responses) / count(all data-returning responses)
```

Measuring correctness is harder than measuring availability or latency because you need a "source of truth" to compare against. In practice, we measure correctness indirectly through proxy metrics:

- **Inventory oversell rate**: bookings that succeed but the room was already booked. Measured by counting compensation events (refunds due to oversell) divided by total bookings.
- **Search result staleness**: search results that show rooms as available when they were booked more than T seconds ago. Measured by comparing search cache timestamps to the primary database.
- **Price consistency**: the price shown in search results versus the price charged at booking time. Measured by comparing the two values in the booking pipeline.

#### 4. Freshness: "Is the data current?"

In a distributed system with read replicas, caches, and eventual consistency, users might see stale data. The freshness SLI measures how old the data is.

```
SLI Definition:
  Good event:  Read request served with data no older than threshold F
  Bad event:   Read request served with data older than threshold F
  Valid event: All read requests

  Formula: count(reads with data age < F) / count(all reads)
```

For our booking system:

| Data Type | Freshness Threshold | Rationale |
|-----------|-------------------|-----------|
| Room availability | 5 seconds | Users should see near-real-time availability |
| Pricing | 30 seconds | Prices change less frequently than availability |
| Booking status | 2 seconds | User just booked -- they want immediate confirmation |
| Search index | 60 seconds | Full re-indexing takes time; 1-minute staleness acceptable |

> **What If You Skip This?** If you only measure availability and latency, you will miss entire categories of user-visible degradation. Your system could return 200 OK with lightning-fast responses, but serve completely wrong data. Correctness and freshness SLIs catch this. At 100K bookings per minute, even a 0.01% correctness failure means 10 users per minute are having a terrible experience.

---

## Setting SLOs: The Math Behind the Nines

Choosing an SLO target is not guesswork. It is a negotiation between user expectations, engineering capability, and business cost. Let us work through the math that makes this concrete.

### The Nines Table

Every additional "nine" in your availability target costs exponentially more to achieve while providing linearly less downtime. Here is the math for a 30-day month (43,200 minutes):

| SLO Target | Error Budget (Monthly) | Error Budget (Yearly) | What It Means in Practice |
|------------|----------------------|---------------------|--------------------------|
| 99% (two nines) | 432 minutes (7.2 hours) | 3.65 days | Acceptable for internal tools, dev environments |
| 99.9% (three nines) | 43.2 minutes | 8.77 hours | Standard for most B2B SaaS applications |
| 99.95% | 21.6 minutes | 4.38 hours | High-reliability web applications |
| 99.99% (four nines) | 4.32 minutes | 52.56 minutes | Mission-critical systems (our booking platform) |
| 99.999% (five nines) | 25.9 seconds | 5.26 minutes | Telecom, financial trading, pacemaker software |
| 99.9999% (six nines) | 2.6 seconds | 31.5 seconds | Theoretical; almost never achievable end-to-end |

Look at the jump from 99.9% to 99.99%. Your error budget shrinks by 10x -- from 43 minutes to 4.3 minutes per month. That means:

- You cannot have a 5-minute deployment window with errors. At 99.9%, a single 5-minute blip is one-eighth of your monthly budget. At 99.99%, that same blip exceeds your entire monthly budget.
- You need automated rollbacks that detect and revert bad deployments in under 60 seconds.
- You need redundancy at every layer -- no single point of failure can cause more than a few seconds of errors.
- You need multi-region failover, because a single-region outage lasting 5 minutes blows your budget.

Each additional nine roughly doubles your infrastructure cost and triples your engineering complexity. Choose wisely.

### How We Chose 99.99% for Booking Availability

The decision process for our Global Booking System looked like this:

**Step 1: Quantify the business impact of downtime.** At 100,000 bookings per minute with an average booking value of $200, each minute of complete downtime costs $20,000,000 in potential lost revenue. Even assuming only 10% of users abandon permanently (the rest retry), that is $2M per minute in real losses.

**Step 2: Assess user expectations.** Our users are travelers booking hotels, flights, and experiences. They compare us to Booking.com, Expedia, and Airbnb -- platforms that are functionally always available. If our system is down when they try to book, they will go to a competitor. The switching cost is near zero.

**Step 3: Evaluate engineering capability.** Can we realistically achieve 99.99%? With Kubernetes multi-region deployments, automated canary releases, circuit breakers, and the architecture we have built in earlier chapters, yes. Could we achieve 99.999%? Probably not without rearchitecting our payment integration (external dependency) and investing in active-active multi-region databases.

**Step 4: Calculate the cost of the next nine.** Going from 99.99% to 99.999% would require: active-active database replication across three or more regions ($50K+/month), custom payment provider failover with sub-second switching ($30K+/month in engineering time), and 24/7 SRE on-call coverage with 1-minute response times (3+ additional engineers at $180K+/year each). Total incremental cost: roughly $1.5M/year. The error budget gain: we go from 4.32 minutes to 25.9 seconds of allowed monthly downtime.

**Decision:** 99.99% is the right target. The business impact of downtime justifies four nines, but the incremental cost of five nines is not justified by the marginal improvement.

> **Analogy:** Think about home security. A basic lock on your front door (two nines) stops casual thieves. A deadbolt and alarm system (three nines) stops most break-ins. A monitored alarm with cameras and reinforced doors (four nines) stops almost everything. A panic room with armed guards (five nines) is possible but costs more than most houses are worth. You choose the level that matches the value of what you are protecting.

---

## Error Budgets: The Reliability Currency

An error budget is the inverse of your SLO target, expressed as a concrete quantity of allowed failure. It transforms reliability from an abstract aspiration into a spendable resource with a finite balance.

If your SLO is 99.99% availability over a rolling 30-day window, your error budget is:

```
Error Budget = 1 - SLO target
             = 1 - 0.9999
             = 0.0001
             = 0.01% of all requests can fail

In absolute terms (for a service handling 10,000 requests per minute):
  Monthly requests:  10,000 * 60 * 24 * 30 = 432,000,000
  Allowed failures:  432,000,000 * 0.0001  = 43,200 failed requests per month
  Per-day budget:    43,200 / 30           = 1,440 failed requests per day
  Per-hour budget:   1,440 / 24            = 60 failed requests per hour
```

That last number is the one that changes behavior. Sixty failed requests per hour. If a deploy causes 100 errors in the first 10 minutes, you have already consumed more than an hour's worth of budget. If those errors continue for 30 minutes, you have blown three days of budget and need an immediate rollback.

> **Mentor's Insight:** Error budgets are the single most powerful concept in SRE because they turn reliability into an optimization problem with a known constraint. Without error budgets, the reliability versus velocity argument is subjective -- "we should be more careful" versus "we need to ship faster." With error budgets, the argument is mathematical: "We have 12,000 errors remaining this month. This deploy will cost approximately 500 errors. We can afford it." That is a conversation engineers and product managers can have productively.

### Spending the Error Budget

Error budgets are meant to be spent. A team that never touches its error budget is over-investing in reliability at the expense of feature velocity. Here is how to think about spending:

**Intentional spending (good):**
- Deploying a risky but valuable new feature that might cause brief errors during rollout
- Running chaos engineering experiments to discover weaknesses
- Performing database migrations that require brief write pauses
- Upgrading major dependencies (Node.js version, Prisma version) that might surface regressions

**Unintentional spending (acceptable):**
- A downstream dependency (Stripe, a GDS provider) has a brief outage
- A sudden traffic spike causes transient capacity-related errors before autoscaling kicks in
- A bug in new code that was caught by canary analysis and rolled back within minutes

**Wasteful spending (bad):**
- The same bug causing errors every Tuesday because the post-mortem action items were never completed
- A known memory leak that causes pod restarts every 6 hours, each causing 30 seconds of errors
- Configuration drift between staging and production causing deploy-time errors

The distinction between "acceptable" and "wasteful" spending is whether you learned something and fixed the root cause. Every error budget expenditure should either be intentional (you chose to take the risk) or should result in a corrective action that prevents recurrence.

### When to Freeze

The most powerful aspect of error budgets is the freeze trigger. When the error budget is exhausted, feature deployments stop and the team focuses exclusively on reliability work until the budget recovers.

This is not punitive. It is mechanical. Just as your car stops when it runs out of fuel, your deploy pipeline pauses when it runs out of error budget. The budget recovers naturally as the rolling window advances -- old bad minutes fall off the trailing edge as new good minutes are added at the leading edge.

```
Error Budget Lifecycle Over a Month:

Day 1-10:  Budget healthy (95% remaining)
           → Ship features normally
           → Run chaos experiments
           → Deploy 3x per day

Day 11:    Bad deploy causes 2-hour incident
           → Budget drops to 40% remaining

Day 12-18: Budget cautious (40% → 25% remaining)
           → Reduce deploy frequency to 1x per day
           → Skip non-critical deployments
           → Increase canary analysis duration

Day 19:    Another incident (external dependency outage)
           → Budget drops to 5% remaining

Day 20-25: Budget frozen (< 10% remaining)
           → Feature deployments halted
           → Only reliability fixes deployed
           → Team focuses on incident follow-ups
           → Root cause fixes for both incidents

Day 26-30: Budget recovering (old bad days rolling off the window)
           → Budget climbs back to 30%
           → Resume cautious deployments
```

> **What If You Skip This?** Without error budget enforcement, SLOs become aspirational targets that everyone ignores. Teams will say "we are committed to 99.99%" while deploying untested features on Friday afternoons. The error budget is the enforcement mechanism. It creates real consequences (deploy freezes) that make the SLO target binding rather than decorative.

---

## Error Budget Policy: The Rules of Engagement

An error budget policy is a written document, agreed upon by engineering leadership and product management, that specifies exactly what happens at each level of budget consumption. It removes ambiguity and prevents arguments during incidents.

Here is the error budget policy we use for our Global Booking System:

```
┌────────────────────────────────────────────────────────────────────┐
│              GLOBAL BOOKING SYSTEM ERROR BUDGET POLICY             │
│              Version 2.3 — Last Updated 2025-11-15                │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  SERVICE: Booking API (api-gateway + booking-service)              │
│  SLO:     99.99% availability, rolling 30 days                    │
│  BUDGET:  43,200 allowed failed requests per month                │
│           (at 10,000 requests/minute baseline)                    │
│                                                                    │
│  ─── THRESHOLDS ───                                               │
│                                                                    │
│  GREEN (budget > 50%):                                            │
│    • Normal development velocity                                  │
│    • Deploy up to 5 times per day                                 │
│    • Chaos experiments permitted                                  │
│    • Feature flags can be toggled freely                          │
│                                                                    │
│  YELLOW (budget 25%–50%):                                         │
│    • Reduce deploy frequency to 2x per day                       │
│    • Extend canary analysis from 5 min to 30 min                 │
│    • No chaos experiments                                         │
│    • Review all pending deploys for risk                          │
│    • Assign one engineer to reliability improvements              │
│                                                                    │
│  ORANGE (budget 10%–25%):                                         │
│    • Deploy only critical bug fixes and reliability improvements  │
│    • All deploys require SRE approval                             │
│    • Extend canary analysis to 60 minutes                        │
│    • Assign 50% of sprint capacity to reliability                │
│    • Daily error budget review meeting                            │
│                                                                    │
│  RED (budget < 10%):                                              │
│    • DEPLOY FREEZE for all non-reliability changes               │
│    • 100% of sprint capacity on reliability                      │
│    • Daily leadership escalation                                 │
│    • Post-mortem for every SLI-impacting event                   │
│    • Freeze remains until budget recovers above 25%              │
│                                                                    │
│  ─── ESCALATION PATH ───                                          │
│    YELLOW → Team lead notified via Slack                          │
│    ORANGE → Engineering manager + Product manager notified        │
│    RED    → VP Engineering + CTO notified                         │
│                                                                    │
│  ─── EXCEPTIONS ───                                               │
│    • Security patches may be deployed at any budget level         │
│    • Legal compliance changes may be deployed at any budget level │
│    • Exception requests require VP Engineering approval           │
│                                                                    │
│  ─── REVIEW CADENCE ───                                           │
│    • Policy reviewed quarterly by SRE + Product + Engineering     │
│    • SLO targets reviewed annually                               │
│    • Thresholds adjusted based on historical budget patterns      │
│                                                                    │
│  SIGNATORIES:                                                      │
│    VP Engineering ________________  Date ________                 │
│    Product Director ______________  Date ________                 │
│    SRE Lead ______________________  Date ________                 │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Notice the asymmetry in the recovery threshold. The freeze triggers at 10% but lifts at 25%. This hysteresis prevents thrashing -- if you froze at 10% and unfroze at 10.1%, a single good hour would unfreeze deploys, followed by another incident that immediately re-freezes them. The 15-point gap ensures genuine recovery before resuming normal operations.

> **Checkpoint:** Your team's error budget is at 35%. A product manager wants to deploy a major UI redesign that historically causes a 0.5% error spike for 2 hours during rollout. At 10,000 requests per minute, that is 50 errors per minute for 120 minutes = 6,000 errors. Your remaining budget is 43,200 * 0.35 = 15,120 errors. Should you approve this deploy? (Answer: Technically yes -- 6,000 is within the 15,120 remaining. But it would drop your budget to about 21%, dangerously close to ORANGE. You might negotiate a phased rollout: 10% of traffic first, then 50%, then 100%, to reduce the blast radius and limit error budget consumption.)

---

## Full NestJS SLO Tracking Implementation

Now let us build the infrastructure that makes everything above operational. We need four components:

1. **SLI collection middleware** that classifies every request as good or bad
2. **Error budget calculation service** that computes remaining budget in real time
3. **Policy enforcement interceptor** that blocks deploys when budget is exhausted
4. **Prometheus metrics** that feed Grafana dashboards

### Prisma Schema for SLO Storage

Before writing application code, we need database tables to store SLO definitions and measurements. Here is the Prisma schema:

```prisma
// schema.prisma — SLO tracking models

model SloDefinition {
  id              String   @id @default(uuid()) @db.Uuid
  serviceName     String   @map("service_name") @db.VarChar(100)
  sliType         String   @map("sli_type") @db.VarChar(50)
  // One of: 'availability', 'latency', 'correctness', 'freshness'
  targetValue     Decimal  @map("target_value") @db.Decimal(7, 5)
  // e.g., 0.99990 for 99.99%
  windowDays      Int      @map("window_days") @default(30)
  latencyThresholdMs  Int? @map("latency_threshold_ms")
  // Only for latency SLIs, e.g., 2000 for 2s
  freshnessThresholdS Int? @map("freshness_threshold_s")
  // Only for freshness SLIs, e.g., 5 for 5s
  description     String?  @db.Text
  isActive        Boolean  @default(true) @map("is_active")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  measurements    SloMeasurement[]
  budgetSnapshots ErrorBudgetSnapshot[]

  @@unique([serviceName, sliType])
  @@index([isActive])
  @@map("slo_definitions")
}

model SloMeasurement {
  id              String   @id @default(uuid()) @db.Uuid
  sloDefinitionId String   @map("slo_definition_id") @db.Uuid
  windowStart     DateTime @map("window_start")
  windowEnd       DateTime @map("window_end")
  totalEvents     BigInt   @map("total_events")
  goodEvents      BigInt   @map("good_events")
  badEvents       BigInt   @map("bad_events")
  sliValue        Decimal  @map("sli_value") @db.Decimal(10, 8)
  // e.g., 0.99994321
  bucketDuration  String   @map("bucket_duration") @db.VarChar(20)
  // '1_minute', '5_minute', '1_hour', '1_day'
  createdAt       DateTime @default(now()) @map("created_at")

  sloDefinition   SloDefinition @relation(fields: [sloDefinitionId],
                    references: [id], onDelete: Cascade)

  @@index([sloDefinitionId, windowStart])
  @@index([windowStart, windowEnd])
  @@map("slo_measurements")
}

model ErrorBudgetSnapshot {
  id              String   @id @default(uuid()) @db.Uuid
  sloDefinitionId String   @map("slo_definition_id") @db.Uuid
  snapshotTime    DateTime @map("snapshot_time")
  budgetTotal     BigInt   @map("budget_total")
  budgetConsumed  BigInt   @map("budget_consumed")
  budgetRemaining BigInt   @map("budget_remaining")
  budgetPercent   Decimal  @map("budget_percent") @db.Decimal(7, 4)
  // e.g., 45.3200 means 45.32% remaining
  policyStatus    String   @map("policy_status") @db.VarChar(20)
  // 'green', 'yellow', 'orange', 'red'
  createdAt       DateTime @default(now()) @map("created_at")

  sloDefinition   SloDefinition @relation(fields: [sloDefinitionId],
                    references: [id], onDelete: Cascade)

  @@index([sloDefinitionId, snapshotTime])
  @@index([policyStatus])
  @@map("error_budget_snapshots")
}
```

The equivalent raw SQL migration for this schema:

```sql
-- CreateTable: slo_definitions
CREATE TABLE slo_definitions (
    id                    CHAR(36) PRIMARY KEY -- UUID generated by application,
    service_name          VARCHAR(100) NOT NULL,
    sli_type              VARCHAR(50) NOT NULL,
    target_value          DECIMAL(7, 5) NOT NULL,
    window_days           INTEGER NOT NULL DEFAULT 30,
    latency_threshold_ms  INTEGER,
    freshness_threshold_s INTEGER,
    description           TEXT,
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            DATETIME(6) NOT NULL DEFAULT NOW(6),
    updated_at            DATETIME(6) NOT NULL DEFAULT NOW(6),
    CONSTRAINT uq_slo_service_sli UNIQUE (service_name, sli_type)
);

CREATE INDEX idx_slo_definitions_active ON slo_definitions (is_active);

-- CreateTable: slo_measurements
CREATE TABLE slo_measurements (
    id                CHAR(36) PRIMARY KEY -- UUID generated by application,
    slo_definition_id UUID NOT NULL
        REFERENCES slo_definitions(id) ON DELETE CASCADE,
    window_start      DATETIME(6) NOT NULL,
    window_end        DATETIME(6) NOT NULL,
    total_events      BIGINT NOT NULL,
    good_events       BIGINT NOT NULL,
    bad_events        BIGINT NOT NULL,
    sli_value         DECIMAL(10, 8) NOT NULL,
    bucket_duration   VARCHAR(20) NOT NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_slo_measurements_def_window
    ON slo_measurements (slo_definition_id, window_start);
CREATE INDEX idx_slo_measurements_window
    ON slo_measurements (window_start, window_end);

-- CreateTable: error_budget_snapshots
CREATE TABLE error_budget_snapshots (
    id                CHAR(36) PRIMARY KEY -- UUID generated by application,
    slo_definition_id UUID NOT NULL
        REFERENCES slo_definitions(id) ON DELETE CASCADE,
    snapshot_time     DATETIME(6) NOT NULL,
    budget_total      BIGINT NOT NULL,
    budget_consumed   BIGINT NOT NULL,
    budget_remaining  BIGINT NOT NULL,
    budget_percent    DECIMAL(7, 4) NOT NULL,
    policy_status     VARCHAR(20) NOT NULL,
    created_at        DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_budget_snapshots_def_time
    ON error_budget_snapshots (slo_definition_id, snapshot_time);
CREATE INDEX idx_budget_snapshots_status
    ON error_budget_snapshots (policy_status);
```

And the corresponding Prisma Client operations for seeding SLO definitions:

```typescript
// seed-slo-definitions.ts
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

async function seedSloDefinitions(): Promise<void> {
  const definitions: Prisma.SloDefinitionCreateInput[] = [
    {
      serviceName: 'booking-api',
      sliType: 'availability',
      targetValue: new Prisma.Decimal('0.99990'),
      windowDays: 30,
      description: 'Fraction of non-5xx responses for the booking API',
    },
    {
      serviceName: 'booking-api',
      sliType: 'latency',
      targetValue: new Prisma.Decimal('0.99000'),
      windowDays: 30,
      latencyThresholdMs: 2000,
      description: 'Fraction of booking requests completed under 2 seconds',
    },
    {
      serviceName: 'search-service',
      sliType: 'availability',
      targetValue: new Prisma.Decimal('0.99950'),
      windowDays: 30,
      description: 'Fraction of non-5xx responses for search queries',
    },
    {
      serviceName: 'search-service',
      sliType: 'latency',
      targetValue: new Prisma.Decimal('0.99000'),
      windowDays: 30,
      latencyThresholdMs: 500,
      description: 'Fraction of search requests completed under 500ms',
    },
    {
      serviceName: 'inventory-service',
      sliType: 'freshness',
      targetValue: new Prisma.Decimal('0.99900'),
      windowDays: 30,
      freshnessThresholdS: 5,
      description: 'Fraction of reads returning data less than 5 seconds old',
    },
  ];

  for (const def of definitions) {
    await prisma.sloDefinition.upsert({
      where: {
        serviceName_sliType: {
          serviceName: def.serviceName,
          sliType: def.sliType,
        },
      },
      update: {
        targetValue: def.targetValue,
        windowDays: def.windowDays,
        latencyThresholdMs: def.latencyThresholdMs,
        freshnessThresholdS: def.freshnessThresholdS,
        description: def.description,
      },
      create: def,
    });
  }

  console.log('SLO definitions seeded successfully.');
}

seedSloDefinitions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
```

### SLI Collection Middleware

This NestJS middleware intercepts every HTTP request, classifies it as good or bad according to our SLI definitions, and emits Prometheus metrics:

```typescript
// src/slo/sli-collection.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { Counter, Histogram } from 'prom-client';

@Injectable()
export class SliCollectionMiddleware implements NestMiddleware {
  // Counter for total requests, labeled by status classification
  private readonly requestTotal = new Counter({
    name: 'sli_request_total',
    help: 'Total requests classified for SLI calculation',
    labelNames: ['service', 'endpoint', 'sli_status'] as const,
    // sli_status: 'good' | 'bad'
  });

  // Histogram for latency measurement
  private readonly requestDuration = new Histogram({
    name: 'sli_request_duration_seconds',
    help: 'Request duration in seconds for latency SLI',
    labelNames: ['service', 'endpoint'] as const,
    buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10],
  });

  // Counter specifically for error budget tracking
  private readonly errorBudgetConsumed = new Counter({
    name: 'slo_error_budget_consumed_total',
    help: 'Total error budget units consumed (each bad request = 1 unit)',
    labelNames: ['service', 'sli_type'] as const,
  });

  // Endpoints to exclude from SLI measurement
  private readonly excludedPaths = new Set([
    '/health',
    '/healthz',
    '/ready',
    '/readyz',
    '/metrics',
    '/liveness',
  ]);

  use(req: Request, res: Response, next: NextFunction): void {
    // Skip excluded paths
    if (this.excludedPaths.has(req.path)) {
      return next();
    }

    // Skip synthetic monitoring requests
    if (req.headers['x-synthetic-monitor'] === 'true') {
      return next();
    }

    const startTime = process.hrtime.bigint();
    const service = this.extractServiceName(req.path);
    const endpoint = this.normalizeEndpoint(req.path);

    // Hook into response finish event
    res.on('finish', () => {
      const endTime = process.hrtime.bigint();
      const durationSeconds =
        Number(endTime - startTime) / 1_000_000_000;

      // --- Availability SLI ---
      const isServerError = res.statusCode >= 500;
      const availabilityStatus = isServerError ? 'bad' : 'good';

      this.requestTotal.inc({
        service,
        endpoint,
        sli_status: availabilityStatus,
      });

      if (isServerError) {
        this.errorBudgetConsumed.inc({
          service,
          sli_type: 'availability',
        });
      }

      // --- Latency SLI (only for successful requests) ---
      if (!isServerError) {
        this.requestDuration.observe(
          { service, endpoint },
          durationSeconds,
        );

        const latencyThreshold =
          this.getLatencyThreshold(endpoint);
        if (durationSeconds > latencyThreshold) {
          this.errorBudgetConsumed.inc({
            service,
            sli_type: 'latency',
          });
        }
      }
    });

    next();
  }

  private extractServiceName(path: string): string {
    // /api/v1/bookings/... → booking-api
    // /api/v1/search/...   → search-service
    // /api/v1/inventory/.. → inventory-service
    if (path.includes('/bookings') || path.includes('/booking')) {
      return 'booking-api';
    }
    if (path.includes('/search')) {
      return 'search-service';
    }
    if (path.includes('/inventory')) {
      return 'inventory-service';
    }
    return 'unknown-service';
  }

  private normalizeEndpoint(path: string): string {
    // Replace UUIDs and numeric IDs with placeholders
    // /api/v1/bookings/abc-123-def → /api/v1/bookings/:id
    return path
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        ':id',
      )
      .replace(/\/\d+/g, '/:id');
  }

  private getLatencyThreshold(endpoint: string): number {
    // Returns threshold in seconds
    if (endpoint.includes('/search')) return 0.5;
    if (endpoint.includes('/bookings')) return 2.0;
    if (endpoint.includes('/payments')) return 3.0;
    if (endpoint.includes('/inventory')) return 0.2;
    return 1.0; // default threshold
  }
}
```

### Error Budget Calculation Service

The calculation service reads Prometheus metrics and computes the current error budget status. It also persists snapshots to the database for historical analysis:

```typescript
// src/slo/error-budget.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PrometheusService } from '../metrics/prometheus.service';
import { Prisma } from '@prisma/client';

interface BudgetStatus {
  serviceName: string;
  sliType: string;
  targetValue: number;
  currentSliValue: number;
  budgetTotal: number;
  budgetConsumed: number;
  budgetRemaining: number;
  budgetPercentRemaining: number;
  policyStatus: 'green' | 'yellow' | 'orange' | 'red';
}

@Injectable()
export class ErrorBudgetService {
  private readonly logger = new Logger(ErrorBudgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prometheus: PrometheusService,
  ) {}

  async calculateBudget(
    serviceName: string,
    sliType: string,
  ): Promise<BudgetStatus> {
    // 1. Fetch the SLO definition
    const sloDef = await this.prisma.sloDefinition.findUnique({
      where: {
        serviceName_sliType: { serviceName, sliType },
      },
    });

    if (!sloDef) {
      throw new Error(
        `No SLO definition found for ${serviceName}/${sliType}`,
      );
    }

    // 2. Query Prometheus for the current SLI value over the window
    const windowSeconds = sloDef.windowDays * 24 * 60 * 60;
    const query = this.buildPrometheusQuery(
      serviceName,
      sliType,
      windowSeconds,
    );
    const result = await this.prometheus.instantQuery(query);
    const currentSliValue = parseFloat(result.value) || 0;

    // 3. Calculate budget
    const targetValue = Number(sloDef.targetValue);
    const errorBudgetFraction = 1 - targetValue;

    // Total events in the window (from Prometheus)
    const totalEventsQuery =
      `sum(increase(sli_request_total{service="${serviceName}"}` +
      `[${windowSeconds}s]))`;
    const totalEventsResult =
      await this.prometheus.instantQuery(totalEventsQuery);
    const totalEvents = Math.round(
      parseFloat(totalEventsResult.value) || 0,
    );

    const budgetTotal = Math.round(totalEvents * errorBudgetFraction);
    const badEvents = Math.round(totalEvents * (1 - currentSliValue));
    const budgetConsumed = badEvents;
    const budgetRemaining = Math.max(0, budgetTotal - budgetConsumed);
    const budgetPercentRemaining =
      budgetTotal > 0 ? (budgetRemaining / budgetTotal) * 100 : 0;

    // 4. Determine policy status
    const policyStatus =
      this.determinePolicyStatus(budgetPercentRemaining);

    return {
      serviceName,
      sliType,
      targetValue,
      currentSliValue,
      budgetTotal,
      budgetConsumed,
      budgetRemaining,
      budgetPercentRemaining,
      policyStatus,
    };
  }

  private determinePolicyStatus(
    percentRemaining: number,
  ): 'green' | 'yellow' | 'orange' | 'red' {
    if (percentRemaining > 50) return 'green';
    if (percentRemaining > 25) return 'yellow';
    if (percentRemaining > 10) return 'orange';
    return 'red';
  }

  private buildPrometheusQuery(
    service: string,
    sliType: string,
    windowSeconds: number,
  ): string {
    if (sliType === 'availability') {
      return (
        `sum(increase(sli_request_total{service="${service}",` +
        `sli_status="good"}[${windowSeconds}s]))` +
        ` / ` +
        `sum(increase(sli_request_total{service="${service}"}` +
        `[${windowSeconds}s]))`
      );
    }
    if (sliType === 'latency') {
      return (
        `sum(increase(sli_request_duration_seconds_bucket` +
        `{service="${service}",le="2.0"}[${windowSeconds}s]))` +
        ` / ` +
        `sum(increase(sli_request_duration_seconds_count` +
        `{service="${service}"}[${windowSeconds}s]))`
      );
    }
    throw new Error(`Unsupported SLI type: ${sliType}`);
  }

  // Persist budget snapshots every 5 minutes
  @Cron(CronExpression.EVERY_5_MINUTES)
  async snapshotAllBudgets(): Promise<void> {
    const activeSlos = await this.prisma.sloDefinition.findMany({
      where: { isActive: true },
    });

    for (const slo of activeSlos) {
      try {
        const budget = await this.calculateBudget(
          slo.serviceName,
          slo.sliType,
        );

        await this.prisma.errorBudgetSnapshot.create({
          data: {
            sloDefinitionId: slo.id,
            snapshotTime: new Date(),
            budgetTotal: BigInt(budget.budgetTotal),
            budgetConsumed: BigInt(budget.budgetConsumed),
            budgetRemaining: BigInt(budget.budgetRemaining),
            budgetPercent: new Prisma.Decimal(
              budget.budgetPercentRemaining.toFixed(4),
            ),
            policyStatus: budget.policyStatus,
          },
        });

        this.logger.log(
          `Budget snapshot: ${slo.serviceName}/${slo.sliType} ` +
          `= ${budget.budgetPercentRemaining.toFixed(2)}% ` +
          `remaining (${budget.policyStatus})`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to snapshot budget for ` +
          `${slo.serviceName}/${slo.sliType}: ${error.message}`,
        );
      }
    }
  }
}
```

### Querying Budget History with Prisma

To build dashboards and API endpoints, you need to query budget history. Here are the essential Prisma Client queries alongside their raw SQL equivalents:

```typescript
// Fetch the latest budget status for all active SLOs
// Raw SQL equivalent:
// SELECT DISTINCT ON (slo_definition_id) *
// FROM error_budget_snapshots
// ORDER BY slo_definition_id, snapshot_time DESC;

const latestSnapshots = await prisma.errorBudgetSnapshot.findMany({
  where: {
    sloDefinition: { isActive: true },
  },
  orderBy: { snapshotTime: 'desc' },
  distinct: ['sloDefinitionId'],
  include: {
    sloDefinition: {
      select: {
        serviceName: true,
        sliType: true,
        targetValue: true,
      },
    },
  },
});

// Fetch budget trend over last 7 days (hourly granularity)
// Raw SQL equivalent:
// SELECT date_trunc('hour', snapshot_time) AS hour,
//        AVG(budget_percent) AS avg_budget_pct,
//        MIN(budget_percent) AS min_budget_pct
// FROM error_budget_snapshots
// WHERE slo_definition_id = $1
//   AND snapshot_time >= NOW() - INTERVAL '7 days'
// GROUP BY date_trunc('hour', snapshot_time)
// ORDER BY hour;

const sevenDaysAgo = new Date(
  Date.now() - 7 * 24 * 60 * 60 * 1000,
);

const budgetTrend = await prisma.$queryRaw<
  { hour: Date; avg_budget_pct: number; min_budget_pct: number }[]
>`
  SELECT date_trunc('hour', snapshot_time) AS hour,
         AVG(budget_percent)::FLOAT AS avg_budget_pct,
         MIN(budget_percent)::FLOAT AS min_budget_pct
  FROM error_budget_snapshots
  WHERE slo_definition_id = ${sloDefinitionId}::uuid
    AND snapshot_time >= ${sevenDaysAgo}
  GROUP BY date_trunc('hour', snapshot_time)
  ORDER BY hour
`;

// Find all periods where budget was in RED status
// Raw SQL equivalent:
// SELECT MIN(snapshot_time) AS red_start,
//        MAX(snapshot_time) AS red_end,
//        AVG(budget_percent) AS avg_pct_during_red
// FROM error_budget_snapshots
// WHERE slo_definition_id = $1 AND policy_status = 'red'
// GROUP BY date_trunc('day', snapshot_time)
// ORDER BY red_start DESC;

const redPeriods = await prisma.errorBudgetSnapshot.groupBy({
  by: ['policyStatus'],
  where: {
    sloDefinitionId: sloDefinitionId,
    policyStatus: 'red',
  },
  _min: { snapshotTime: true },
  _max: { snapshotTime: true },
  _avg: { budgetPercent: true },
});
```

> **Mentor's Insight:** Notice that we use `$queryRaw` for the time-bucketed aggregation query. Prisma's query builder does not natively support `date_trunc` or window-function-based grouping. This is one of the cases where raw SQL is the right choice. But we keep the Prisma schema as the source of truth for the table structure, and use Prisma Client for all CRUD operations. Raw SQL is reserved for analytical queries that need database-specific functions.

---

## Prometheus Queries for SLI Calculation

The SLI collection middleware emits raw counters. Prometheus turns those counters into meaningful SLI values. Here are the essential PromQL queries for our booking system:

### Availability SLI (30-day rolling)

```promql
# Current availability SLI for booking-api (rolling 30d)
sum(increase(sli_request_total{
  service="booking-api",
  sli_status="good"
}[30d]))
/
sum(increase(sli_request_total{
  service="booking-api"
}[30d]))
```

This query divides good events by total events over a 30-day window. The `increase()` function handles counter resets (from pod restarts) automatically.

### Latency SLI (30-day rolling)

```promql
# Fraction of booking requests faster than 2 seconds (rolling 30d)
sum(increase(sli_request_duration_seconds_bucket{
  service="booking-api",
  le="2.0"
}[30d]))
/
sum(increase(sli_request_duration_seconds_count{
  service="booking-api"
}[30d]))
```

The `le="2.0"` label selects the histogram bucket for requests completing in 2 seconds or less. Dividing by the total count gives the fraction of requests meeting the latency threshold.

### Error Budget Remaining (percentage)

```promql
# Error budget remaining as a percentage
(
  (1 - 0.9999)  # total budget fraction
  -
  (
    1 -
    (
      sum(increase(sli_request_total{
        service="booking-api",
        sli_status="good"
      }[30d]))
      /
      sum(increase(sli_request_total{
        service="booking-api"
      }[30d]))
    )
  )
)
/
(1 - 0.9999)
* 100
```

This formula computes: `(total_budget - consumed_budget) / total_budget * 100`. When this value hits zero, the error budget is exhausted.

### Burn Rate (how fast you are consuming budget)

```promql
# 1-hour burn rate for booking-api availability
(
  1 - (
    sum(increase(sli_request_total{
      service="booking-api",
      sli_status="good"
    }[1h]))
    /
    sum(increase(sli_request_total{
      service="booking-api"
    }[1h]))
  )
)
/
(1 - 0.9999)
```

A burn rate of 1.0 means you are consuming budget at exactly the expected rate -- you will exhaust it precisely at the end of the 30-day window. A burn rate of 14.4 means you are consuming budget 14.4 times faster than sustainable -- at this rate, you will exhaust 30 days of budget in roughly 50 hours.

> **What If You Skip This?** Without burn rate calculations, you only know your current budget balance, not the trajectory. A team with 60% budget remaining feels comfortable. But if their burn rate is 10x, they will hit zero in 3 days. Burn rate is the speedometer; budget remaining is the fuel gauge. You need both.

---

## Grafana SLO Burn Rate Dashboards

A well-designed SLO dashboard answers three questions at a glance: "Are we meeting our SLO right now?", "How fast are we burning through our error budget?", and "When will we run out if things do not change?"

### Dashboard Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  GLOBAL BOOKING SYSTEM — SLO DASHBOARD                   [30d ▼]  │
├───────────────────────────┬─────────────────────────────────────────┤
│                           │                                         │
│   BOOKING API             │   SEARCH SERVICE                        │
│   Availability: 99.987%   │   Availability: 99.962%                 │
│   Target:       99.990%   │   Target:       99.950%                 │
│   Status:       ● YELLOW  │   Status:       ● GREEN                 │
│                           │                                         │
│   Budget: ████████░░ 38%  │   Budget: █████████░ 87%                │
│                           │                                         │
├───────────────────────────┴─────────────────────────────────────────┤
│                                                                     │
│   ERROR BUDGET REMAINING OVER TIME (30-day window)                  │
│                                                                     │
│   100% ┤ ╭───╮                                                      │
│    80% ┤ │   ╰──╮         ╭───────────────                          │
│    60% ┤ │      │         │                                         │
│    40% ┤─╯      ╰────╮   │                                         │
│    20% ┤              ╰───╯                                         │
│     0% ┤────────────────────────────────────────────                 │
│        └──┬────┬────┬────┬────┬────┬────┬────┬───                   │
│          Day1  Day5  Day9 Day13 Day17 Day21 Day25                   │
│                                                                     │
│   ── booking-api (availability)                                     │
│   -- search-service (availability)                                  │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   BURN RATE (1h window)        BURN RATE (6h window)                │
│                                                                     │
│   booking-api:    2.3x  ▲      booking-api:    1.1x  →             │
│   search-service: 0.4x  ▼      search-service: 0.7x  ▼            │
│   inventory-svc:  0.0x  →      inventory-svc:  0.2x  →             │
│                                                                     │
│   Legend: ▲ above sustainable   → at sustainable   ▼ below          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   RECENT SLO-IMPACTING EVENTS                                       │
│                                                                     │
│   2025-11-14 03:22  booking-api  502 spike (deploy v2.41)    -4.2% │
│   2025-11-12 17:45  search-svc   timeout cascade (Redis)     -1.8% │
│   2025-11-10 09:01  booking-api  GDS provider outage         -8.1% │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Grafana Panel Configuration (JSON model excerpt)

```json
{
  "title": "Availability SLI — Booking API (30d)",
  "type": "gauge",
  "datasource": "Prometheus",
  "targets": [
    {
      "expr": "sum(increase(sli_request_total{service=\"booking-api\",sli_status=\"good\"}[30d])) / sum(increase(sli_request_total{service=\"booking-api\"}[30d])) * 100",
      "legendFormat": "Availability %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "min": 99,
      "max": 100,
      "thresholds": {
        "steps": [
          { "value": 0,     "color": "red"    },
          { "value": 99.9,  "color": "orange" },
          { "value": 99.95, "color": "yellow" },
          { "value": 99.99, "color": "green"  }
        ]
      },
      "unit": "percent",
      "decimals": 4
    }
  }
}
```

```json
{
  "title": "Error Budget Remaining — Booking API",
  "type": "timeseries",
  "datasource": "Prometheus",
  "targets": [
    {
      "expr": "((1 - 0.9999) - (1 - (sum(increase(sli_request_total{service=\"booking-api\",sli_status=\"good\"}[30d])) / sum(increase(sli_request_total{service=\"booking-api\"}[30d]))))) / (1 - 0.9999) * 100",
      "legendFormat": "Budget Remaining %"
    }
  ],
  "fieldConfig": {
    "defaults": {
      "min": 0,
      "max": 100,
      "custom": {
        "fillOpacity": 20,
        "lineWidth": 2,
        "thresholdsStyle": { "mode": "area" }
      },
      "thresholds": {
        "steps": [
          { "value": 0,  "color": "red"    },
          { "value": 10, "color": "orange" },
          { "value": 25, "color": "yellow" },
          { "value": 50, "color": "green"  }
        ]
      }
    }
  }
}
```

> **Checkpoint:** Look at the dashboard layout above. The booking API shows 99.987% availability against a 99.990% target. Is the SLO being met? (Answer: No -- 99.987% is below the 99.990% target.) What is the error budget consumption? (Answer: The target allows 0.010% errors. Actual error rate is 0.013%. So consumed budget is 0.013% / 0.010% = 130% of the allocated rate. The 38% remaining budget means we have used 62% of the 30-day budget so far.)

---

## SLO Document Template

Every service in a production system should have a formal SLO document. Here is the template we use for the Global Booking System. Copy this for each service and fill in the specifics:

```
╔══════════════════════════════════════════════════════════════════════╗
║                    SERVICE LEVEL OBJECTIVES                         ║
║                    Document ID: SLO-BOOKING-001                     ║
║                    Version: 3.1                                     ║
║                    Effective Date: 2025-12-01                       ║
║                    Review Date: 2026-03-01                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  SERVICE:          Booking API                                       ║
║  TEAM:             Reservations Platform                             ║
║  OWNER:            Jane Doe (Staff Engineer)                         ║
║  STAKEHOLDERS:     Product (Bob), SRE (Alice), Business (Carol)     ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  1. SERVICE DESCRIPTION                                              ║
║                                                                      ║
║  The Booking API handles the complete lifecycle of travel             ║
║  reservations: creation, modification, cancellation, and retrieval.  ║
║  It processes approximately 10,000 requests/minute at peak and       ║
║  integrates with payment providers, GDS systems, and the inventory   ║
║  service. Revenue directly depends on this service's availability.   ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  2. SLI DEFINITIONS                                                  ║
║                                                                      ║
║  SLI-1: Availability                                                 ║
║    Metric:    sli_request_total{service="booking-api"}                ║
║    Good:      HTTP status < 500                                      ║
║    Bad:       HTTP status >= 500                                     ║
║    Excludes:  /health, /metrics, synthetic monitors                  ║
║                                                                      ║
║  SLI-2: Latency                                                      ║
║    Metric:    sli_request_duration_seconds{service="booking-api"}     ║
║    Good:      Response time < 2000ms                                 ║
║    Bad:       Response time >= 2000ms                                ║
║    Excludes:  5xx responses (covered by SLI-1)                       ║
║                                                                      ║
║  SLI-3: Correctness (Booking Integrity)                              ║
║    Metric:    booking_oversell_total / booking_completed_total        ║
║    Good:      No double-booking or oversell detected                 ║
║    Bad:       Oversell event requiring compensation                  ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  3. SLO TARGETS                                                      ║
║                                                                      ║
║  ┌────────────┬──────────┬──────────┬────────────────┐               ║
║  │ SLI        │ Target   │ Window   │ Error Budget    │              ║
║  ├────────────┼──────────┼──────────┼────────────────┤               ║
║  │ Avail.     │ 99.99%   │ 30d roll │ 43,200 bad req │              ║
║  │ Latency    │ 99.00%   │ 30d roll │ 4.32M slow req │              ║
║  │ Correct.   │ 99.999%  │ 30d roll │ 4.3 oversells  │              ║
║  └────────────┴──────────┴──────────┴────────────────┘               ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  4. ERROR BUDGET POLICY                                              ║
║                                                                      ║
║  See: Global Error Budget Policy v2.3                                ║
║  Thresholds:  GREEN > 50%  |  YELLOW 25-50%  |                      ║
║               ORANGE 10-25%  |  RED < 10%                           ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  5. ALERTING                                                         ║
║                                                                      ║
║  Multi-window, multi-burn-rate alerts (see Section below)            ║
║  Page:    1h burn > 14.4x AND 5m burn > 14.4x                      ║
║  Ticket:  6h burn > 6x AND 30m burn > 6x                           ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  6. DEPENDENCIES                                                     ║
║                                                                      ║
║  Critical: inventory-service (SLO: 99.95%)                          ║
║  Critical: payment-gateway (SLO: 99.9%, external)                   ║
║  Best-effort: notification-service (SLO: 99.5%)                     ║
║                                                                      ║
║  NOTE: Our SLO cannot exceed the combined reliability of our         ║
║  critical dependencies. With inventory at 99.95% and payment at      ║
║  99.9%, the theoretical maximum for booking is approximately         ║
║  99.95% × 99.9% = 99.85% — assuming serial dependency. Our          ║
║  99.99% target requires circuit breakers, retries, and graceful      ║
║  degradation to exceed the raw dependency chain reliability.         ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║  7. REVISION HISTORY                                                 ║
║                                                                      ║
║  v3.1 (2025-12-01): Added correctness SLI for oversell tracking     ║
║  v3.0 (2025-09-01): Upgraded availability target from 99.95%        ║
║  v2.0 (2025-03-01): Added latency SLI                               ║
║  v1.0 (2024-06-01): Initial SLO document                            ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

> **Mentor's Insight:** The dependency section (item 6) is the most commonly omitted part of an SLO document, and it is arguably the most important. Your service's SLO is bounded by the SLOs of your critical dependencies. If you promise 99.99% but depend on a service that only delivers 99.9%, you are making a promise you can only keep through heroic engineering -- retries, caches, fallbacks. Those mechanisms should be documented here, along with their limitations. When a dependency degrades, this document tells you whether your own SLO is achievable or whether you need to escalate.

---

## Multi-Window, Multi-Burn-Rate Alerting

Traditional threshold-based alerts ("page me if error rate > 1%") have two fatal flaws. First, they are either too sensitive (paging on brief spikes that resolve themselves) or too slow (not paging until the budget is nearly gone). Second, they do not account for the SLO window -- a 1% error rate for 30 seconds is nothing, but a 1% error rate for 6 hours is catastrophic.

Multi-window, multi-burn-rate alerting solves both problems by requiring that the burn rate exceed a threshold in two different time windows simultaneously. This eliminates false positives from brief spikes while catching sustained problems quickly.

### The Math Behind Burn Rate Alerting

The core idea: if your SLO is 99.99% over 30 days, you can lose 0.01% of requests. A burn rate of 1x means you are consuming budget at exactly the sustainable rate. A burn rate of Nx means you will exhaust N days of budget in one day.

The alerting windows are derived from how quickly you want to detect different severities:

```
┌────────────────────────────────────────────────────────────────────┐
│           MULTI-WINDOW BURN RATE ALERT MATRIX                     │
├──────────┬───────────┬───────────┬────────────┬───────────────────┤
│ Severity │ Long      │ Short     │ Burn Rate  │ Budget consumed   │
│          │ Window    │ Window    │ Threshold  │ before alert      │
├──────────┼───────────┼───────────┼────────────┼───────────────────┤
│ PAGE     │ 1 hour    │ 5 min     │ 14.4x     │ 2% (in ~1h)      │
│ PAGE     │ 6 hours   │ 30 min    │ 6x        │ 5% (in ~6h)      │
│ TICKET   │ 1 day     │ 2 hours   │ 3x        │ 10% (in ~1d)     │
│ TICKET   │ 3 days    │ 6 hours   │ 1x        │ 10% (in ~3d)     │
└──────────┴───────────┴───────────┴────────────┴───────────────────┘

How to read this table:
- PAGE (1h/5m at 14.4x): If the burn rate over the past 1 hour exceeds
  14.4x AND the burn rate over the past 5 minutes also exceeds 14.4x,
  fire a page. This catches acute incidents that will burn 2% of your
  monthly budget per hour. The 5-minute short window confirms the
  problem is ongoing (not a resolved spike).

- TICKET (1d/2h at 3x): If the burn rate over the past 1 day exceeds
  3x AND the burn rate over the past 2 hours also exceeds 3x, create
  a ticket. This catches slow-burn problems that individually are not
  urgent but will exhaust the budget within 10 days if unchecked.
```

Why 14.4x for the fastest page? Because at 14.4x burn rate, you consume 2% of a 30-day budget in one hour: `14.4 * (1/30) * (1/24) = 0.02 = 2%`. This gives you time to respond before the damage becomes severe, while filtering out sub-minute blips.

### Prometheus Alerting Rules

```yaml
# prometheus/slo-alerts.yml
groups:
  - name: slo_burn_rate_alerts
    rules:
      # ──────────────────────────────────────────────────
      # PAGE: Acute incident (1h / 5m window, 14.4x burn)
      # ──────────────────────────────────────────────────
      - alert: SLO_HighBurnRate_Page_Fast
        expr: |
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[1h]))
              /
              sum(increase(sli_request_total{service="booking-api"}[1h]))
            )
          ) / (1 - 0.9999) > 14.4
          AND
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[5m]))
              /
              sum(increase(sli_request_total{service="booking-api"}[5m]))
            )
          ) / (1 - 0.9999) > 14.4
        for: 1m
        labels:
          severity: page
          service: booking-api
          slo: availability
        annotations:
          summary: "Booking API availability SLO burn rate critical"
          description: |
            Burn rate is {{ $value }}x over the last 1 hour.
            At this rate, the entire 30-day error budget will be
            exhausted in {{ printf "%.1f" (div 720 $value) }} hours.
            Immediate investigation required.
          runbook_url: "https://runbooks.internal/slo/booking-api-availability"

      # ──────────────────────────────────────────────────
      # PAGE: Sustained incident (6h / 30m window, 6x burn)
      # ──────────────────────────────────────────────────
      - alert: SLO_HighBurnRate_Page_Slow
        expr: |
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[6h]))
              /
              sum(increase(sli_request_total{service="booking-api"}[6h]))
            )
          ) / (1 - 0.9999) > 6
          AND
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[30m]))
              /
              sum(increase(sli_request_total{service="booking-api"}[30m]))
            )
          ) / (1 - 0.9999) > 6
        for: 5m
        labels:
          severity: page
          service: booking-api
          slo: availability
        annotations:
          summary: "Booking API availability SLO sustained burn"
          description: |
            Burn rate is {{ $value }}x sustained over 6 hours.
            Error budget will be exhausted in approximately
            {{ printf "%.0f" (div 720 $value) }} hours.

      # ──────────────────────────────────────────────────
      # TICKET: Slow burn (1d / 2h window, 3x burn)
      # ──────────────────────────────────────────────────
      - alert: SLO_ElevatedBurnRate_Ticket
        expr: |
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[1d]))
              /
              sum(increase(sli_request_total{service="booking-api"}[1d]))
            )
          ) / (1 - 0.9999) > 3
          AND
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[2h]))
              /
              sum(increase(sli_request_total{service="booking-api"}[2h]))
            )
          ) / (1 - 0.9999) > 3
        for: 15m
        labels:
          severity: ticket
          service: booking-api
          slo: availability
        annotations:
          summary: "Booking API availability SLO slow burn detected"
          description: |
            Burn rate is {{ $value }}x over the past day.
            Budget will be exhausted in ~{{ printf "%.0f" (div 30 $value) }} days
            if this rate continues. Create a ticket for investigation.

      # ──────────────────────────────────────────────────
      # TICKET: Background degradation (3d / 6h window, 1x burn)
      # ──────────────────────────────────────────────────
      - alert: SLO_BudgetDrain_Ticket
        expr: |
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[3d]))
              /
              sum(increase(sli_request_total{service="booking-api"}[3d]))
            )
          ) / (1 - 0.9999) > 1
          AND
          (
            1 - (
              sum(increase(sli_request_total{service="booking-api",sli_status="good"}[6h]))
              /
              sum(increase(sli_request_total{service="booking-api"}[6h]))
            )
          ) / (1 - 0.9999) > 1
        for: 30m
        labels:
          severity: ticket
          service: booking-api
          slo: availability
        annotations:
          summary: "Booking API on track to miss SLO this month"
          description: |
            Over the past 3 days, error budget consumption rate
            exceeds the sustainable rate. At current trajectory,
            the SLO will be missed before the window closes.
```

### Storing Alert Events for Audit

When alerts fire, we record them for post-mortem analysis. Here is the Prisma schema and corresponding code:

```prisma
// Addition to schema.prisma

model SloAlertEvent {
  id              String   @id @default(uuid()) @db.Uuid
  sloDefinitionId String   @map("slo_definition_id") @db.Uuid
  alertName       String   @map("alert_name") @db.VarChar(100)
  severity        String   @db.VarChar(20)
  // 'page' or 'ticket'
  burnRate        Decimal  @map("burn_rate") @db.Decimal(8, 2)
  longWindow      String   @map("long_window") @db.VarChar(20)
  shortWindow     String   @map("short_window") @db.VarChar(20)
  firedAt         DateTime @map("fired_at")
  resolvedAt      DateTime? @map("resolved_at")
  acknowledgedBy  String?  @map("acknowledged_by") @db.VarChar(100)
  notes           String?  @db.Text
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([sloDefinitionId, firedAt])
  @@index([severity, firedAt])
  @@map("slo_alert_events")
}
```

The raw SQL equivalent:

```sql
CREATE TABLE slo_alert_events (
    id                CHAR(36) PRIMARY KEY -- UUID generated by application,
    slo_definition_id UUID NOT NULL
        REFERENCES slo_definitions(id) ON DELETE CASCADE,
    alert_name        VARCHAR(100) NOT NULL,
    severity          VARCHAR(20) NOT NULL,
    burn_rate         DECIMAL(8, 2) NOT NULL,
    long_window       VARCHAR(20) NOT NULL,
    short_window      VARCHAR(20) NOT NULL,
    fired_at          DATETIME(6) NOT NULL,
    resolved_at       DATETIME(6),
    acknowledged_by   VARCHAR(100),
    notes             TEXT,
    created_at        DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_slo_alert_events_def_time
    ON slo_alert_events (slo_definition_id, fired_at);
CREATE INDEX idx_slo_alert_events_severity
    ON slo_alert_events (severity, fired_at);
```

And the Prisma Client code for recording and querying alert events:

```typescript
// Record a new alert event when Alertmanager webhook fires
async function recordAlertEvent(payload: AlertmanagerWebhook) {
  const alert = payload.alerts[0];

  await prisma.sloAlertEvent.create({
    data: {
      sloDefinitionId: await resolveSloId(
        alert.labels.service,
        alert.labels.slo,
      ),
      alertName: alert.labels.alertname,
      severity: alert.labels.severity,
      burnRate: new Prisma.Decimal(alert.annotations.burnRate || '0'),
      longWindow: alert.labels.long_window || 'unknown',
      shortWindow: alert.labels.short_window || 'unknown',
      firedAt: new Date(alert.startsAt),
      resolvedAt: alert.endsAt
        ? new Date(alert.endsAt)
        : null,
    },
  });
}

// Query: How many pages did booking-api fire this month?
const monthlyPages = await prisma.sloAlertEvent.count({
  where: {
    sloDefinition: { serviceName: 'booking-api' },
    severity: 'page',
    firedAt: {
      gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    },
  },
});

// Query: Average time-to-resolution for page-severity alerts
// Raw SQL (no Prisma equivalent for AVG on interval):
// SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - fired_at))) / 60
//        AS avg_resolution_minutes
// FROM slo_alert_events
// WHERE severity = 'page'
//   AND resolved_at IS NOT NULL
//   AND fired_at >= NOW() - INTERVAL '90 days';

const avgResolution = await prisma.$queryRaw<
  { avg_resolution_minutes: number }[]
>`
  SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - fired_at))) / 60
         AS avg_resolution_minutes
  FROM slo_alert_events
  WHERE severity = 'page'
    AND resolved_at IS NOT NULL
    AND fired_at >= NOW() - INTERVAL '90 days'
`;
```

> **What If You Skip This?** Single-window alerting (e.g., "page if 5-minute error rate > 1%") generates enormous numbers of false positives. Teams develop alert fatigue, start ignoring pages, and eventually miss the real incident. Multi-window alerting reduces false positive rates by 90%+ while maintaining fast detection of genuine problems. The initial configuration effort is significant, but it pays for itself within the first month of operation.

---

## Production War Story: The SLO That Rewired Our Architecture

In March 2025, our Global Booking System had been running for eight months. We had SLOs, we had dashboards, we had error budgets. We thought we were doing SRE properly. We were wrong, and the SLOs themselves showed us why.

### The Symptom

Our booking API availability SLO was 99.99%. For two consecutive months, we hit 99.97%. Not terrible -- we were still well above our 99.9% SLA, so no customer penalties. But the error budget policy was clear: two consecutive months below SLO meant a mandatory architecture review.

The error budget analysis showed something puzzling. We were not losing budget to big incidents. There were no dramatic outages, no cascading failures, no "the database went down at 3 AM" stories. Instead, we were losing budget to a steady drizzle of errors -- 2 to 5 errors per minute, 24 hours a day, 7 days a week.

### The Investigation

The SLI data, broken down by endpoint, revealed the pattern:

```
Endpoint                    Error Rate    Errors/Day
─────────────────────────── ───────────── ──────────
POST /api/v1/bookings       0.08%         ~1,152
GET  /api/v1/bookings/:id   0.001%        ~14
PUT  /api/v1/bookings/:id   0.12%         ~173
DELETE /api/v1/bookings/:id 0.003%        ~4
GET  /api/v1/search         0.002%        ~29
POST /api/v1/payments       0.15%         ~216
```

The booking creation and payment endpoints had error rates 10 to 100 times higher than the read endpoints. We drilled into the error logs and found three root causes:

1. **Optimistic locking conflicts (40% of errors).** Two users trying to book the same room within a narrow time window. Our saga pattern would proceed to payment, then fail at the final inventory confirmation with a 409 Conflict that bubbled up as a 500 to the API gateway.

2. **Payment provider timeouts (35% of errors).** Stripe's API occasionally took 5+ seconds to respond. Our circuit breaker was set to 3 seconds. When it tripped, the booking was left in a partial state that returned 500 on subsequent status checks.

3. **Database connection pool exhaustion during traffic spikes (25% of errors).** Our connection pool was sized for average load. During the 10 AM and 6 PM daily peaks, the pool would briefly exhaust, causing a burst of 503s.

### The Architecture Changes

The SLO violation forced three architectural changes that we had been deferring because they were "not urgent":

**Change 1: Pessimistic locking for contested inventory.** We replaced the optimistic lock on popular rooms with a short-lived pessimistic lock (Redis-based, 30-second TTL). This eliminated the race condition entirely. Error rate for booking creation dropped from 0.08% to 0.005%.

**Change 2: Async payment with webhook confirmation.** Instead of waiting for Stripe synchronously, we moved payment processing to an async flow: accept the booking immediately with status "payment_pending", process payment in a background worker, and update status via webhook. This eliminated payment timeouts from the user-facing request path. Payment errors dropped from 0.15% to 0.01%.

**Change 3: ProxySQL connection pooling with autoscaling.** We moved from application-level connection pooling to ProxySQL with dynamic pool sizing based on active connections. The pool now scales from 20 to 100 connections based on demand. Connection exhaustion errors dropped to near zero.

### The Result

After implementing all three changes over a six-week sprint:

```
Before (February 2025):
  Availability SLI:  99.97%
  Daily errors:      ~1,588
  Error budget used: 112% (violated)

After (May 2025):
  Availability SLI:  99.996%
  Daily errors:      ~57
  Error budget used: 18% (healthy green)
```

Not only did we fix the SLO violation, we ended up with a system that was significantly more resilient than our original 99.99% target required. The "drizzle" of errors that the SLO caught would never have triggered a traditional incident. No single occurrence was important enough to investigate. But the SLO framework aggregated thousands of small failures into a clear signal: something is structurally wrong.

> **Mentor's Insight:** This is the deeper value of SLOs. They do not just tell you when something is broken -- they tell you when something is slowly degrading. Traditional monitoring catches fires. SLOs catch termites. A house can burn down in an hour, but it can also be quietly destroyed over years by insects in the walls. Without an SLO forcing you to account for every error, you would never investigate a 0.08% failure rate. It looks fine on a dashboard. But at 10,000 requests per minute, 0.08% is 8 users per minute having a bad experience. That is 480 frustrated users per hour, 11,520 per day. The SLO made that cost visible.

---

## Common Mistakes with SLOs

After helping dozens of teams adopt SLOs in production systems, these are the mistakes I see most frequently. Each one can derail your SLO program before it delivers value.

### Mistake 1: Setting SLOs Without Data

**The problem:** A team picks "99.99%" as their target because it sounds right, without measuring their current performance. They later discover they are at 99.7% and now face an impossible gap.

**The fix:** Run SLI measurement for at least 30 days before setting SLOs. Set your initial SLO slightly below your observed performance. If you are currently hitting 99.95%, set your SLO at 99.9%. This gives you a meaningful target that you can actually achieve while still leaving room to improve.

### Mistake 2: Too Many SLIs

**The problem:** A team defines 15 SLIs for a single service -- CPU utilization, memory pressure, disk I/O, queue depth, cache hit rate, and so on. Dashboards become unreadable, alerts fire constantly, and no one knows which SLI matters.

**The fix:** Limit to 3-5 SLIs per service. Focus on the four categories we discussed: availability, latency, correctness, and freshness. Everything else is a supporting metric for debugging, not an SLI.

### Mistake 3: SLOs Without Error Budget Policy

**The problem:** The team has SLOs and dashboards, but no written policy for what happens when the budget runs out. When an SLO violation occurs, there is no agreed-upon action. The SLO becomes informational rather than actionable.

**The fix:** Write the error budget policy before you launch SLO monitoring. Get VP-level sign-off. The policy must have teeth -- deploy freezes, sprint reallocation, escalation paths. An SLO without a policy is a speedometer with no speed limits.

### Mistake 4: Measuring at the Wrong Layer

**The problem:** The team measures SLIs at the application server, missing errors introduced by the load balancer, CDN, or DNS layer. Their SLI shows 99.99% but users are experiencing 99.9% because of intermittent 502s at the Nginx layer.

**The fix:** Measure as close to the user as possible. The ideal measurement point is the load balancer access log or the CDN edge. If you measure at the application layer, you miss infrastructure-level failures.

### Mistake 5: Including Health Checks in SLI Calculations

**The problem:** Kubernetes liveness and readiness probes hit the API 10 times per second per pod. With 20 pods, that is 200 synthetic requests per second -- 17 million per day. These inflate the denominator and make the SLI artificially high, hiding real problems.

**The fix:** Exclude health checks, synthetic monitors, and internal service-to-service probes from SLI calculations. Your SLI should only measure real user traffic.

### Mistake 6: Alerting on SLI Instead of Burn Rate

**The problem:** A team sets an alert for "availability drops below 99.99% over 5 minutes." A single 500 error in a low-traffic period (100 requests in 5 minutes) triggers a page: 99/100 = 99%, which is below 99.99%. The on-call engineer wakes up for a non-issue.

**The fix:** Alert on burn rate with multi-window confirmation. A single error is insignificant when measured against the 30-day error budget. Burn rate alerting naturally handles traffic volume differences.

### Mistake 7: Setting SLA Equal to SLO

**The problem:** The business team sets the external SLA at the same level as the internal SLO (both at 99.99%). The first time the SLO is missed by even 0.001%, the company owes customers money.

**The fix:** Always maintain a buffer between SLO and SLA. A common pattern: SLO is 10x stricter than SLA (SLO at 99.99%, SLA at 99.9%). This gives you headroom to miss your internal target without contractual consequences.

### Mistake 8: Ignoring Dependency SLOs

**The problem:** A team sets a 99.99% availability SLO for their service, which depends on a payment provider with a 99.9% SLA. Mathematically, the service cannot achieve 99.99% if its critical dependency only guarantees 99.9%.

**The fix:** Map your dependency chain and calculate the theoretical maximum reliability. Build circuit breakers, fallbacks, and graceful degradation to exceed the raw dependency-chain reliability. Document these mechanisms in your SLO document.

> **Checkpoint:** Review your own system (or a system you work with). Which of these eight mistakes are present? Most teams have at least three. Identifying them is the first step toward fixing them.

---

## Chapter Summary

This chapter has covered the complete lifecycle of SLOs, from theoretical foundations to production implementation. Here is a reference table of everything we built:

| Topic | Key Concept | Implementation |
|-------|------------|----------------|
| **SLI** | Quantitative measure of user experience, expressed as a ratio of good events to total events | `SliCollectionMiddleware` classifying every request and emitting Prometheus counters |
| **SLO** | Target value for an SLI over a time window (e.g., 99.99% over 30 days) | `SloDefinition` Prisma model storing targets per service per SLI type |
| **SLA** | Legally binding contract with consequences; always set weaker than SLO | Business document with 10x buffer below SLO target |
| **Error Budget** | Allowed failure = 1 - SLO target; finite resource to be spent deliberately | `ErrorBudgetService` computing remaining budget from Prometheus data |
| **Error Budget Policy** | Written rules for what happens at GREEN/YELLOW/ORANGE/RED thresholds | Policy document with deploy freeze triggers and escalation paths |
| **Burn Rate** | Speed of error budget consumption; 1x = sustainable, 14.4x = critical | PromQL queries dividing observed error rate by budget fraction |
| **Multi-Window Alerting** | Two-window confirmation to eliminate false positives; short + long window must both exceed threshold | Prometheus alerting rules with four severity tiers |
| **SLO Document** | Formal record of SLIs, targets, dependencies, and policy for a service | Template with 7 sections including dependency analysis |
| **SLI Categories** | Availability, Latency, Correctness, Freshness -- four categories that cover all user-facing quality signals | Endpoint-specific thresholds in middleware configuration |
| **Prisma Schema** | Database storage for SLO definitions, measurements, budget snapshots, and alert events | Four models: `SloDefinition`, `SloMeasurement`, `ErrorBudgetSnapshot`, `SloAlertEvent` |
| **Grafana Dashboard** | Visual overview of SLI values, budget remaining, burn rates, and recent incidents | Gauge and time-series panels with color-coded thresholds |

### Key Decisions We Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Booking API availability target | 99.99% (four nines) | Revenue impact justifies four nines; five nines' cost exceeds benefit |
| SLO window | Rolling 30 days | Long enough to smooth daily variance, short enough to respond to trends |
| Budget policy thresholds | 50/25/10% | Graduated response prevents over-reaction to brief budget dips |
| Freeze recovery hysteresis | Freeze at 10%, unfreeze at 25% | Prevents deploy freeze thrashing |
| Latency measurement | Only on successful requests | Prevents latency and availability SLIs from contaminating each other |
| Health check exclusion | All /health, /metrics, synthetic probes | Ensures SLI measures real user experience |
| Alert burn rate thresholds | 14.4x/6x/3x/1x | Derived from Google SRE Workbook; covers acute to chronic scenarios |

### What Comes Next

In Chapter 33, we will build on this SLO foundation to implement **capacity planning** -- using SLI data and traffic patterns to predict when we will need to scale, how much headroom we need to maintain our SLOs during traffic spikes, and how to automate scaling decisions based on error budget consumption rates.

> **Final Mentor's Insight:** SLOs are not a monitoring tool. They are a management tool. The dashboards, the alerts, the Prometheus queries -- all of that is just plumbing. The real output of an SLO program is better decision-making. When a product manager asks "can we ship this risky feature?", you answer with data: "our error budget is at 72%, and this feature historically costs 3% of budget in rollout errors, so yes." When an executive asks "why is the team spending two sprints on reliability instead of features?", you answer with data: "our error budget hit RED last month, and the policy requires full reliability focus until recovery." SLOs replace opinions with arithmetic. That is their power.

