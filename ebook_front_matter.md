<div align="center">

# Building a Global Booking System

## A Practical Guide to Designing Systems at 100,000 Bookings Per Minute

---

**Version 3.0**

---

*From database sharding to distributed sagas — every architectural decision explained with production-ready code*

</div>

---

## About This Book

This book teaches you how to design, build, and operate a global-scale booking platform — the kind that powers Booking.com, Expedia, or Airbnb. Rather than presenting theory in isolation, every concept is taught through **one continuous system**: a platform that handles 100,000 bookings per minute across four geographic regions.

Each chapter solves a real problem. When you learn about fencing tokens, you're solving *this system's* race conditions. When you learn about sagas, you're orchestrating *this system's* distributed transactions. By the end, you'll have a complete mental model of how all 40 architectural components connect and depend on each other.

**What makes this book different:**
- **One system, not 40 examples.** Every code sample belongs to the same booking platform. Cross-references connect related concepts across chapters.
- **"Why" before "How."** Each chapter opens with the business problem that demands the solution. You'll never implement a pattern without understanding the failure it prevents.
- **Common Mistake callouts.** Seven critical bugs (real mistakes from production systems) are embedded in the text with detailed explanations of what goes wrong and how to fix it.
- **Production-ready code.** TypeScript implementations, SQL schemas, Kubernetes manifests, and CI/CD pipelines — all designed to work together.

---

## The System at a Glance: Scale in Numbers

This book designs for 100,000 bookings per minute. That number is easy to say and easy to forget. Before you read another word, let's unpack what it actually means for the machines running your code.

### Traffic Breakdown

A booking doesn't appear out of thin air. Users search, compare, filter, and hesitate before they commit. Every confirmed booking is the survivor of roughly 20 search queries that didn't convert. And every search fans out to multiple backend services. Here's what 100K bookings/min looks like when you follow the math downstream:

| Metric | Rate | How It's Derived |
|---|---|---|
| Bookings | 100,000/min | 1,667/sec — the headline number |
| Search queries | 2,000,000/min | ~20 searches per booking conversion = 33,333/sec |
| Internal RPC calls | ~6,000,000/min | Each search fans out to 3-4 services = ~100,000/sec |
| Read:write ratio | 20:1 | Searches (reads) vastly outnumber bookings (writes) |
| Database write operations | ~5,000/sec | Across 16 shards = ~312 writes/sec per shard |

That last row is the one people miss. The headline number sounds impossible until you shard it. Per shard, 312 writes/sec is entirely reasonable for a well-tuned MySQL instance. The trick is getting there — and that's what this book teaches.

### Geographic Scope

The system operates across four regions, each running a full deployment stack:

| Region | Code | Steady-State Load | Role |
|---|---|---|---|
| US East (Virginia) | `us-east-1` | ~25K bookings/min | Primary for Americas |
| EU West (Frankfurt) | `eu-west-1` | ~25K bookings/min | Primary for EMEA |
| AP Southeast (Singapore) | `ap-southeast-1` | ~25K bookings/min | Primary for Southeast Asia, Oceania |
| AP Northeast (Tokyo) | `ap-northeast-1` | ~25K bookings/min | Primary for East Asia |

At steady state, traffic distributes roughly evenly. But steady state is not what keeps you up at night. During a flash sale targeting the Japanese market, `ap-northeast-1` can spike to 60,000 bookings/min while the other three regions absorb overflow through global load balancing. The multi-region architecture in Chapter 17 exists specifically for this scenario.

### Data Dimensions

These are the volumes the system manages at rest:

| Dimension | Scale |
|---|---|
| Hotel properties worldwide | 10M+ |
| Room-nights of inventory (rolling 365 days) | 50M+ |
| Registered users | 200M+ |
| Average booking value | $180 USD |
| Daily transaction volume | ~$2.6B USD |

That daily transaction number is not a typo. At 100K bookings/min sustained over a 24-hour cycle with an average value of $180, you get roughly 144 million bookings/day, totaling $25.9B. In practice, traffic follows a diurnal curve — peak hours carry several times the volume of off-peak — so the real daily figure hovers around $2.6B. Still a number that demands double-entry accounting, financial reconciliation, and the kind of transactional guarantees you'll build in Chapter 13.

### Latency Goals

Speed is a feature. Every 100ms of added latency on a search page costs measurable revenue. These are the latency budgets the architecture is designed to meet:

| Operation | p99 Target | Why This Number |
|---|---|---|
| Search API (end-to-end) | < 200ms | Users abandon after ~300ms perceived delay |
| Booking confirmation | < 2 seconds | Includes payment auth + inventory lock + saga completion |
| Inventory availability check | < 50ms | Served from Redis; on the hot path for every search result |
| Cache hit rate (search results) | > 95% | Below 95%, database load becomes unsustainable at this query volume |

The booking confirmation budget of 2 seconds might seem generous compared to search, but consider what happens in those 2 seconds: the system authorizes a payment, acquires a distributed lock, decrements inventory with fencing tokens, writes to the financial ledger, and orchestrates a saga across five services. Two seconds is tight.

### Peak vs. Average

No system runs at peak 24/7. The architecture is designed for sustained peak at 100K/min with headroom for burst:

| Traffic Profile | Bookings/min | When It Happens |
|---|---|---|
| Off-peak average | 40,000 | Nighttime in primary markets |
| Sustained peak | 100,000 | Holiday season, weekday evenings across major markets |
| Absolute max (burst) | 150,000 | Black Friday, Singles' Day, flash sales |

The system is provisioned for 100K sustained. The gap between 100K and the 150K burst ceiling is handled by elastic auto-scaling — Kubernetes HPA spinning up additional pods, read replicas absorbing overflow queries, and Kafka consumer groups rebalancing across new instances. You'll configure all of this in Chapters 35 and 36.

Designing for 150K when your sustained target is 100K is not over-engineering. It's the difference between a flash sale that prints money and a flash sale that prints error pages.

### Why These Numbers Matter

Every architectural decision in this book — from sharding to CQRS to multi-region conflict resolution — exists because these numbers demand it. At 1,000 bookings per minute, a single MySQL instance with careful indexing would suffice. At 100,000, you need 16 database shards, a distributed consensus layer, and geographic replication. Understanding *why* each pattern is needed at this scale — and unnecessary below it — is the core lesson of this book.

When you encounter a pattern in a later chapter and wonder "couldn't I just use a simpler approach?", come back to this page. Check the numbers. If your system handles 500 bookings per minute, then yes, you absolutely could and should use the simpler approach. But if you're here because you need to understand how the big systems work — or because you're building one — these numbers are your constant companion.

---

## The Cost of Complexity: Trade-Off Tables

Every pattern in this book solves a real problem. But every pattern also introduces complexity, operational overhead, and new failure modes. This table summarizes the key trade-offs. When you reach each chapter, come back here and check whether the trade-off makes sense for YOUR system's scale.

| Pattern | Chapter | What It Solves | What It Costs | Skip If... |
|---------|---------|---------------|---------------|------------|
| CQRS | 20 | Scales reads independently from writes; search doesn't compete with bookings | Two data models to maintain, eventual consistency between read/write stores, event replay infrastructure | Your read:write ratio is below 5:1 |
| Saga Orchestration | 19 | Distributed transactions across services without 2PC | Eventual consistency, compensating actions for every step, saga state persistence | You have fewer than 3 services in the transaction |
| Database Sharding | 7 | Horizontal write scaling beyond a single node | Cross-shard queries become expensive or impossible, rebalancing is a major operation | A single MySQL instance handles your write throughput (typically < 5K writes/sec) |
| Multi-Region | 17 | Low latency for global users, disaster recovery | Conflict resolution, data sovereignty complexity, cross-region replication lag | All your users are in one geographic region |
| Event Sourcing | 18 | Complete audit trail, temporal queries, event replay | Storage growth, projection rebuild time, eventual consistency | You don't need audit trails or temporal queries |
| Circuit Breaker | 21 | Prevents cascade failures when a dependency is down | Requests are rejected during open state, tuning thresholds is tricky | You have only one downstream dependency |
| Distributed Locking | 15 | Prevents concurrent modifications to the same resource | Lock contention reduces throughput, clock skew in distributed locks | Your writes are naturally partitioned (no contention) |
| Rate Limiting | 22 | Protects services from traffic spikes and abuse | Legitimate traffic gets rejected during peaks, adds latency to every request | You're behind a managed API gateway that handles this |
| Cache Layer | 24 | Reduces database load, improves read latency | Stale data risk, cache invalidation complexity, memory costs | Your database can handle the read load directly |
| Read Replicas | 26 | Scales read traffic horizontally | Replication lag means stale reads, read-after-write inconsistency | Your read:write ratio is below 3:1 |
| Outbox Pattern | 18 | Guarantees at-least-once event delivery with transactional consistency | Polling overhead, increased database load, eventual delivery delay | You can tolerate occasional lost events |
| DLQ | 25 | Failed messages are preserved for inspection and retry | Operational overhead to monitor and reprocess, messages can pile up | Your message processing is idempotent and retryable inline |

### What Does a Booking Actually Cost?

| Component | Monthly Cost (at 100K/min) | Cost Per Booking | Notes |
|-----------|---------------------------|-----------------|-------|
| MySQL (16 shards, 3 replicas each) | ~$180,000 | $0.0012 | db.r6g.4xlarge equivalent |
| Redis Cluster (6 nodes) | ~$24,000 | $0.00016 | cache.r6g.2xlarge equivalent |
| Kafka (15 brokers) | ~$45,000 | $0.0003 | m6i.4xlarge equivalent |
| Kubernetes (compute) | ~$320,000 | $0.0022 | ~200 pods across 4 regions |
| Elasticsearch (search) | ~$36,000 | $0.00025 | 3 data nodes per region |
| Networking (cross-region) | ~$85,000 | $0.00058 | Data transfer between regions |
| Monitoring (Prometheus/Grafana) | ~$12,000 | $0.00008 | Time series storage |
| **Total infrastructure** | **~$702,000/month** | **$0.0048** | **Against $180 average booking value** |

At $0.0048 per booking against a $180 average value, infrastructure costs 0.0027% of revenue. That's exceptionally efficient — but only because each component is right-sized for the load. Over-provisioning doubles this number. Under-provisioning causes outages that cost far more. Capacity planning (Chapter 35) is where these numbers come to life.

---

## Who This Book Is For

- **Mid-level developers** (2-5 years) looking to understand distributed systems architecture beyond CRUD applications
- **Senior developers** preparing for system design interviews at FAANG-level companies
- **Tech leads** evaluating architectural patterns for high-scale platforms
- **Self-taught engineers** who want a structured deep-dive into enterprise-grade system design

**You should already know:**
- TypeScript/JavaScript fundamentals
- Basic SQL (SELECT, INSERT, JOINs, transactions)
- What REST APIs are and how HTTP works
- Basic Docker concepts (containers, images)

**You don't need to know (this book teaches these):**
- Distributed systems theory (CAP, consensus, fencing)
- Message queues (Kafka)
- Container orchestration (Kubernetes)
- Database sharding or replication
- Financial systems (double-entry accounting)

---

## How to Read This Book

### Reading Order

The book is organized into **13 Parts** with **46 Chapters**. While you can jump to any chapter, the recommended reading path follows the natural flow of a booking request through the system:

```
Part 0: Foundations (Ch 1-4)
  - Chapter 1: Who This Book Is For & How to Read It
  - Chapter 2: From Monolith to Microservices — Why Bother?
  - Chapter 3: The Booking System We're Building
  - Chapter 4: System Architecture Overview

Part 1: System Foundations (Ch 5-7)
  - Chapter 5: Design Philosophy — The Non-Negotiables
  - Chapter 6: System Architecture Deep Dive
  - Chapter 7: Database Design & Sharding

Part 2: The Booking Flow (Ch 8-9)
  - Chapter 8: API Gateway — The Front Door
  - Chapter 9: Authentication & Authorization — The Bouncer

Part 3: The Read Path & Inventory (Ch 10-11)
  - Chapter 10: Search Service — Finding Needles in Haystacks
  - Chapter 11: Inventory Management — Guarding the Last Room

Part 4: Core Business Services (Ch 12-13)
  - Chapter 12: Booking Service — The Orchestrator
  - Chapter 13: Financial Ledger & Double-Entry Accounting

Part 5: Service Communication & Events (Ch 14-18)
  - Chapter 14: Notification Service — The Messenger
  - Chapter 15: Distributed Locking — One at a Time, Please
  - Chapter 16: Idempotency — Making Requests Safe to Retry
  - Chapter 17: Multi-Region Conflict Resolution — When Tokyo and London Disagree
  - Chapter 18: Outbox Pattern — Reliable Event Publishing

Part 6: Distributed Patterns & Resilience (Ch 19-26)
  - Chapter 19: Saga Pattern — Distributed Transactions Without a Safety Net
  - Chapter 20: CQRS — Separating Reads from Writes
  - Chapter 21: Circuit Breaker & Bulkhead — Containing the Blast
  - Chapter 22: Rate Limiting — Protecting Your Castle Gates
  - Chapter 23: Retry & Backoff — When to Try Again
  - Chapter 24: Cache Strategy & Invalidation — The Hardest Problem
  - Chapter 25: Dead Letter Queue — Where Failed Messages Go
  - Chapter 26: Read/Write Splitting — Two Doors, One Room

Part 7: Security & Compliance (Ch 27-29)
  - Chapter 27: Security Architecture — Thinking Like an Attacker
  - Chapter 28: Fraud Detection — Catching the Bad Guys
  - Chapter 29: GDPR & Data Privacy — The Law Meets Code

Part 8: Observability & Operations (Ch 30-34)
  - Chapter 30: Monitoring & Alerting — Eyes on the Dashboard
  - Chapter 31: Distributed Tracing — Following the Breadcrumbs
  - Chapter 32: SLOs & SLIs — Promises to Your Users
  - Chapter 33: Incident Response — When Things Go Wrong at 3 AM
  - Chapter 34: Disaster Recovery — Preparing for the Worst

Part 9: Infrastructure & Deployment (Ch 35-39)
  - Chapter 35: Capacity Planning — How Much Server Do We Need?
  - Chapter 36: Kubernetes Deployment — Your App in the Cloud
  - Chapter 37: CI/CD Pipeline — From Code to Production
  - Chapter 38: Infrastructure as Code — Servers as Configuration Files
  - Chapter 39: Local Development Setup — Running Everything on Your Laptop

Part 10: Professional Practices & Reference (Ch 40-44)
  - Chapter 40: API Documentation — Writing Docs That Developers Actually Read
  - Chapter 41: Development Guidelines & Code Standards — Writing Code Like a Team
  - Chapter 42: Testing Strategy — Proving Your Code Works
  - Chapter 43: Schema Registry & Event Contracts — Agreeing on the Message Format
  - Chapter 44: Glossary & Learning Resources — Your Reference Shelf

Part 11: Real Production Metrics (Ch 45)
  - Chapter 45: Production Metrics — Dashboards, Alerts, SLO Math & Cost Per Booking

Part 12: Interview Mode (Ch 46)
  - Chapter 46: Interview Mode — Presenting This System in 45 Minutes
```

### Chapter Structure

Every chapter follows the same pattern for consistent learning:

1. **"Why" Introduction** — The business problem this chapter solves
2. **Architecture/Design** — Diagrams and schemas showing the solution
3. **Implementation** — Production-ready TypeScript code with inline explanations
4. **Common Mistakes** — Bugs that look correct but fail in production (marked with callout boxes)
5. **Key Takeaways**, presented as a summary table at the end of each chapter.

### Conventions Used

Throughout this book:

- **Bold terms** on first use indicate entries in the Glossary (Chapter 44)
- `Code blocks` show production-ready implementations
- `> Common Mistake:` callout boxes highlight bugs that pass code review but fail in production
- **(See Section N)** cross-references connect related concepts across chapters
- **"Why:"** paragraphs at the start of each section explain the business justification

---

## Visual Architecture Guide

Before you read a single chapter, plant these three diagrams in your head. They are the map you will carry through the entire book. Every chapter zooms into one piece of these pictures. If you ever feel lost in the details, come back here and locate yourself.

### 1. The Booking Request Lifecycle

This is the journey of a single booking request -- from the moment a user clicks "Book Now" to the moment they see a confirmation screen. Study it once now. You will see every one of these services again in its own chapter.

**The Happy Path (all steps succeed):**

```
 Step  Direction                       What Happens
 ────  ─────────────────────────────   ──────────────────────────────────────────────────────────

  1    Client ──────────► API Gateway  User clicks "Book Now." HTTPS request hits Kong.
                                       (Chapter 8)

  2    API Gateway ─────► Auth Service Verify JWT token, extract user_id and roles.
                                       Reject if expired or tampered. (Chapter 9)

  3    API Gateway ─────► Search Svc   Validate the property/room exists, fetch pricing.
                                       Elasticsearch returns the read model. (Chapter 10)

  4    API Gateway ─────► Booking Svc  Route the validated request to the Booking Service.
       (Saga Orchestrator)             The orchestrator begins the saga. (Chapter 12)

  5    Booking Svc ─────► Inventory    Reserve the room with a 10-minute hold and fencing
                          Service      token. Atomic decrement via SELECT...FOR UPDATE.
                                       (Chapter 11)

  6    Booking Svc ─────► Payment Svc  Authorize and charge the card. The Payment Service
                                       talks to the payment gateway (e.g., Stripe).
                                       (Chapter 19, Step 2)

  7    Booking Svc ─────► Financial    Write debit and credit journal entries. Every dollar
                          Ledger       is double-entry: Assets = Liabilities + Equity.
                                       (Chapter 13)

  8    Booking Svc ─────► Inventory    Convert the 10-minute hold to a confirmed reservation.
                          Service      Permanent decrement. (Chapter 19, Step 4)

  9    Booking Svc ─────► Notification Publish booking.confirmed event to Kafka. Notification
                          Service      Service consumes it, sends email/SMS/push.
                                       (Chapter 14)

 10    Notification ────► Client       User sees confirmation screen + receives email.
       Service                         Total time budget: < 2 seconds. (Front matter)
```

**The Compensating Path (payment fails at Step 6):**

When something breaks mid-saga, the orchestrator does not panic. It walks backward through the completed steps, undoing each one. This is the core of the Saga pattern (Chapter 19).

```
 Step  Direction                       What Happens
 ────  ─────────────────────────────   ──────────────────────────────────────────────────────────

  6    Payment Svc ─────► Booking Svc  Payment gateway returns DECLINED. Booking Service
                                       receives the failure.

  C1   Booking Svc ─────► Inventory    COMPENSATE: Release the 10-minute hold. Room becomes
                          Service      available again for other customers.

  C2   Booking Svc ─────► Booking DB   Set saga state to PAYMENT_FAILED. Record the decline
                                       reason for audit.

  C3   Booking Svc ─────► Notification Publish booking.failed event. Notification Service
                          Service      sends "payment declined" email to the user.

  --   Booking Svc ─────► Client       Return HTTP 402 with decline reason. User can retry
                                       with a different card.
```

The key insight: compensating actions do not "undo" in the database sense (there is no ROLLBACK across services). They are *new forward actions* that logically reverse the effect. Releasing an inventory hold is an INSERT of a release record, not a DELETE of the hold. This distinction matters for audit trails and debugging. Chapter 19 covers this in depth.

---

### 2. Data Ownership Map

In microservices, the number one rule is: **each service owns its data exclusively.** No service reads another service's database directly. All cross-service communication happens through APIs or events. Violate this rule and you get invisible coupling -- the kind that breaks at 3 AM when someone changes a column name.

Here is who owns what:

```
┌────────────────────┬─────────────────────┬──────────────────────────────────────────────┐
│ Service            │ Primary Data Store  │ Data Owned                                   │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Search             │ Elasticsearch       │ Property listings, room types, prices,       │
│ (Ch 10)            │                     │ amenities, geo-coordinates (read model)      │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Inventory          │ MySQL (sharded)     │ Room availability, holds, fencing tokens,    │
│ (Ch 11)            │ + Redis (locks)     │ reserved/available quantities                │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Booking            │ MySQL (sharded)     │ Booking records, booking events, saga state, │
│ (Ch 12)            │                     │ idempotency keys, state machine transitions  │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Financial Ledger   │ MySQL               │ Journal entries, account entries, GL         │
│ (Ch 13)            │                     │ accounts, reconciliation records             │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Auth               │ MySQL + Redis       │ Users, sessions, API keys, OAuth clients,    │
│ (Ch 9)             │                     │ JWT signing keys, role assignments            │
├────────────────────┼─────────────────────┼──────────────────────────────────────────────┤
│ Notification       │ MySQL               │ Templates, delivery logs, user channel       │
│ (Ch 14)            │                     │ preferences, retry state                     │
└────────────────────┴─────────────────────┴──────────────────────────────────────────────┘
```

And here is that same ownership as a structural diagram, showing the boundaries between services:

```
    ┌─────────────────────────────────────────────────────────────────────────┐
    │                        SERVICE BOUNDARIES                              │
    │  Each box is a service. Each service has its own database(s).          │
    │  No arrows cross directly between databases.                          │
    │                                                                       │
    │   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐               │
    │   │   Search    │   │  Inventory  │   │   Booking    │               │
    │   │   Service   │   │   Service   │   │   Service    │               │
    │   │             │   │             │   │  (Orchestr.) │               │
    │   └──────┬──────┘   └──────┬──────┘   └──────┬───────┘               │
    │          │                 │                  │                       │
    │     ┌────▼────┐      ┌────▼────┐       ┌────▼────┐                   │
    │     │  Elastic │      │  MySQL  │       │  MySQL  │                   │
    │     │  search  │      │ (shard) │       │ (shard) │                   │
    │     └─────────┘      │ + Redis │       └─────────┘                   │
    │                      └─────────┘                                     │
    │   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐               │
    │   │  Financial  │   │    Auth     │   │ Notification │               │
    │   │   Ledger    │   │   Service   │   │   Service    │               │
    │   └──────┬──────┘   └──────┬──────┘   └──────┬───────┘               │
    │          │                 │                  │                       │
    │     ┌────▼────┐      ┌────▼────┐       ┌────▼────┐                   │
    │     │  MySQL  │      │  MySQL  │       │  MySQL  │                   │
    │     │         │      │ + Redis │       │         │                   │
    │     └─────────┘      └─────────┘       └─────────┘                   │
    │                                                                       │
    │   Communication between services: REST APIs + Kafka events            │
    │   Communication with own database: Direct connection (private)        │
    └─────────────────────────────────────────────────────────────────────────┘
```

Why this matters: when the Search Service needs booking data, it does not query the Booking Service's MySQL database. It consumes `booking.confirmed` events from Kafka and builds its own read model in Elasticsearch. This is CQRS in action (Chapter 20). The same principle applies everywhere. The Financial Ledger does not read inventory tables. The Notification Service does not query the auth database for email addresses -- it receives them in the event payload.

This rule is the single biggest difference between "microservices that work" and "a distributed monolith that is worse than the monolith you started with."

---

### 3. Infrastructure Topology

The system operates across four geographic regions in an active-active configuration. Every region runs a complete deployment stack and can serve any request independently. Here is the physical layout:

```
                         ┌─────────────────────┐
                         │     US-East (VA)     │
                         │  ┌─────────────────┐ │
                         │  │ Kong API GW     │ │
                         │  │ K8s Cluster     │ │
                         │  │ MySQL (4 shards)│ │
                         │  │ Redis Cluster   │ │
                         │  │ Kafka Brokers   │ │
                         │  │ Elasticsearch   │ │
                         │  └─────────────────┘ │
                         └──────────┬────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            │          Kafka MirrorMaker 2 (MM2)            │
            │      mirrors global topics across all         │
            │       four regional Kafka clusters             │
            │                       │                       │
  ┌─────────▼───────────┐          │          ┌─────────────▼─────────┐
  │    EU-West (FFT)    │          │          │  AP-Southeast (SIN)   │
  │  ┌─────────────────┐│          │          │┌─────────────────┐    │
  │  │ Kong API GW     ││          │          ││ Kong API GW     │    │
  │  │ K8s Cluster     ││          │          ││ K8s Cluster     │    │
  │  │ MySQL (4 shards)││          │          ││ MySQL (4 shards)│    │
  │  │ Redis Cluster   ││          │          ││ Redis Cluster   │    │
  │  │ Kafka Brokers   ││          │          ││ Kafka Brokers   │    │
  │  │ Elasticsearch   ││          │          ││ Elasticsearch   │    │
  │  └─────────────────┘│          │          │└─────────────────┘    │
  └─────────────────────┘          │          └───────────────────────┘
                                   │
                         ┌─────────▼───────────┐
                         │  AP-Northeast (TYO) │
                         │  ┌─────────────────┐│
                         │  │ Kong API GW     ││
                         │  │ K8s Cluster     ││
                         │  │ MySQL (4 shards)││
                         │  │ Redis Cluster   ││
                         │  │ Kafka Brokers   ││
                         │  │ Elasticsearch   ││
                         │  └─────────────────┘│
                         └─────────────────────┘
```

**Three things to understand about this topology:**

**Cross-region replication is for reads, not writes.** Each region's MySQL shards replicate to read replicas in other regions. A search query in Tokyo can read from a local replica of Frankfurt's data without crossing the ocean. But writes always go to the shard's primary, which lives in one specific region. This is how you get low-latency reads globally without sacrificing write consistency. Chapter 7 covers the replication setup, and Chapter 26 covers read/write splitting.

**Writes that touch the same resource from different regions create conflicts.** If a user in Tokyo and a user in London both try to book the last room at the same hotel within the same second, their writes hit different regional primaries. The system must detect this conflict and resolve it. Chapter 17 is entirely dedicated to this problem -- it implements last-writer-wins with vector clocks, region-aware fencing tokens, and a conflict resolution service that runs asynchronously via Kafka events. This is the hardest distributed systems problem in the entire book.

**Kafka MirrorMaker 2 connects the regional event buses.** Each region runs its own Kafka cluster for local event processing (booking events, inventory updates, notifications). MirrorMaker 2 mirrors selected "global" topics -- like `inventory.reserved` and `booking.confirmed` -- between all four clusters. This means when Tokyo publishes an `inventory.reserved` event, London's conflict detection consumer receives it within seconds. Local topics (like notification delivery logs) stay local. The MM2 configuration, including topic allowlists and bandwidth throttling with zstd compression, is detailed in Chapter 17.

**Total infrastructure per region:** 4 MySQL shard primaries + 16 read replicas, a 3-node Redis cluster, a 5-broker Kafka cluster, a 3-node Elasticsearch cluster, and a Kubernetes cluster running all service pods behind Kong. Multiply by four regions. The full capacity planning math is in Chapter 35.

---

## Prerequisites & Setup

To follow along with the code examples, you'll need:

```bash
# Required tooling
node --version        # v20+ LTS
npm --version         # v10+
docker --version      # v24+
kubectl version       # v1.28+

# Quick start (Chapter 35 has the full guide)
git clone <your-repo-url>
cd global-booking-system
docker compose up -d          # Starts MySQL, Redis, Kafka, Elasticsearch
npm install
npm run dev
```

### Architecture at a Glance

Before diving in, here's what you're building:

```
                        ┌──────────────┐
                        │   Clients    │
                        │ (Web/Mobile) │
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │  API Gateway │  Ch 4
                        │    (Kong)    │
                        └──────┬───────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
       ┌──────▼──────┐ ┌──────▼──────┐ ┌───────▼─────┐
       │   Booking   │ │   Search    │ │  Inventory  │  Ch 6-8
       │   Service   │ │   Service   │ │   Service   │
       └──────┬──────┘ └──────┬──────┘ └───────┬─────┘
              │               │                │
      ┌───────┼───────┐      │         ┌──────┼──────┐
      │       │       │      │         │      │      │
  ┌───▼──┐┌───▼──┐┌───▼──┐┌─▼───┐ ┌───▼──┐┌──▼───┐
  │MySQL ││Redis ││Kafka ││ ES  │ │MySQL ││Redis │   Ch 3, 20
  │(16   ││Clstr ││(15   ││     │ │(Shrd)││(Lock)│
  │shrds)││      ││brkrs)││     │ │      ││      │
  └──────┘└──────┘└──────┘└─────┘ └──────┘└──────┘
```

---

