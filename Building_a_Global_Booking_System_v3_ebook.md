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

The book is organized into **8 Parts** with **40 Chapters**. While you can jump to any chapter, the recommended reading path follows the natural flow of a booking request through the system:

```
PART I: FOUNDATIONS (Chapters 1-3)
  Start here. Understand the big picture, the tech stack, and how data is stored.

PART II: THE BOOKING FLOW (Chapters 4-10)
  Follow a booking from API request → authentication → search → inventory →
  payment → confirmation → notification. This is the happy path.

PART III: DISTRIBUTED SYSTEMS PATTERNS (Chapters 11-16)
  Now learn what happens when things go wrong. Distributed locks prevent
  overselling. Sagas handle partial failures. CQRS separates reads from writes.

PART IV: RESILIENCE & RELIABILITY (Chapters 17-22)
  Make the system survive real-world failures: network partitions, service
  crashes, thundering herds, and cache stampedes.

PART V: SECURITY & COMPLIANCE (Chapters 23-25)
  Secure the platform and comply with regulations (GDPR, PCI-DSS).

PART VI: OBSERVABILITY & OPERATIONS (Chapters 26-30)
  Monitor, trace, alert, and recover from incidents.

PART VII: INFRASTRUCTURE & DEPLOYMENT (Chapters 31-35)
  Deploy to Kubernetes, set up CI/CD, plan capacity, and run locally.

PART VIII: DEVELOPER REFERENCE (Chapters 36-40)
  API docs, coding standards, testing strategies, and a glossary.
```

### Chapter Structure

Every chapter follows the same pattern for consistent learning:

1. **"Why" Introduction** — The business problem this chapter solves
2. **Architecture/Design** — Diagrams and schemas showing the solution
3. **Implementation** — Production-ready TypeScript code with inline explanations
4. **Common Mistakes** — Bugs that look correct but fail in production (marked with callout boxes)
5. **Key Takeaways** — 3-5 bullet points summarizing what you learned
6. **Review Questions** — Test your understanding
7. **Hands-On Exercise** — Build something that reinforces the concepts

### Conventions Used

Throughout this book:

- **Bold terms** on first use indicate entries in the Glossary (Chapter 40)
- `Code blocks` show production-ready implementations
- `> Common Mistake:` callout boxes highlight bugs that pass code review but fail in production
- **(See Section N)** cross-references connect related concepts across chapters
- **"Why:"** paragraphs at the start of each section explain the business justification

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

# PART I: FOUNDATIONS

Before you write a single line of booking logic, you need to understand what you are building and why the architecture looks the way it does. Part I establishes the ground truth: the scale targets that drive every design decision, the high-level service topology that organizes the system, and the database schemas that store the core business state.

These three sections are tightly linked. The executive summary defines four design principles -- zero overselling, financial auditability, multi-region active-active, and graceful degradation. The architecture overview shows how those principles map to concrete services and communication patterns. The database design then translates both into schemas, constraints, and triggers that enforce correctness at the storage layer. If you skip ahead to the booking flow or payment processing without understanding these foundations, you will constantly be asking "why is this done this way?" The answer is almost always here.

Read these sections carefully. Return to them when later sections reference back. The vocabulary, patterns, and constraints introduced here recur throughout the entire system.

### What You'll Build

- A clear mental model of the system's scale requirements (1,666 bookings/second, four regions, 99.99% uptime) and the four design principles that constrain every architectural choice
- A microservices topology map showing 10 services, their responsibilities, replica counts, and how they communicate through Kubernetes service discovery and the Kafka event bus
- A complete set of MySQL schemas covering bookings, inventory, payments, event sourcing, and audit logging -- including sharding configuration, immutability triggers, state machine constraints, and the outbox pattern table

---

## 1. Executive Summary & Design Philosophy

> **Learning Objectives**
> - Understand the scale and availability targets that drive the system's architecture
> - Articulate the four core design principles and explain why each one exists
> - Identify the major technology choices and how they map to specific requirements
> - Recognize the tradeoffs implied by choosing AP over CP in the CAP theorem

### 1.1 Project Overview

A **global-scale booking platform** similar to Booking.com/Expedia that handles:
- Hotels, Flights, Cars, and Package bookings
- Multi-currency transactions
- Real-time inventory management
- Fraud detection
- Multi-region deployment

### 1.2 Key Requirements

**Scale:**
- 1,666 bookings/second (100,000/minute)
- 1,000,000 concurrent users
- 99.99% availability (52.6 min downtime/year)
- < 2s payment processing latency

**Business:**
- Zero overselling
- Financial audit compliance
- GDPR compliance
- Multi-region disaster recovery

### 1.3 Design Philosophy

This system is built on four fundamental principles that inform every architectural decision:

**Principle 1: Zero Overselling via Fencing Tokens**
Every inventory mutation must go through a distributed lock with a monotonically increasing fencing token. The database rejects any write carrying a stale token. This means even if a lock expires and two services think they own the lock, only the one with the higher token can mutate inventory. (See Section 11)

**Principle 2: Financial Auditability via Double-Entry Accounting**
Every monetary operation creates balanced journal entries (debits = credits). The payment ledger is immutable -- enforced by database triggers that reject UPDATE and DELETE. This creates an unbreakable audit trail from payment authorization through capture, refund, and chargeback. (See Section 9)

**Principle 3: Multi-Region Active-Active via Kafka**
All four regions process bookings independently. Conflicts are detected through a global Kafka event stream and resolved deterministically using fencing token ordering. The system favors availability over strict consistency (AP in CAP theorem), with conflict resolution happening within seconds. (See Section 13)

**Principle 4: Graceful Degradation via Circuit Breakers**
When a downstream service fails, the system degrades gracefully rather than cascading the failure. Circuit breakers prevent thundering herd, bulkheads isolate failure domains, and retry budgets prevent amplification. (See Section 17)

### 1.4 Technology Stack

```yaml
Backend:
  Language: TypeScript/Node.js
  Framework: NestJS / Express
  Runtime: Node.js 20 LTS

Database:
  Primary: MySQL 8.0 (Sharded)
  Strategy: 16 shards with 5 replicas each
  ORM: TypeORM / Prisma

Caching:
  Technology: Redis Cluster
  Clusters: 4 separate (sessions, fencing, cache, rate-limiting)

Message Queue:
  Technology: Apache Kafka (KRaft mode, no ZooKeeper)
  Brokers: 15 nodes
  Partitions: 500+ total

Container Orchestration:
  Platform: Kubernetes (EKS/GKE)
  Service Mesh: Istio

Search:
  Engine: Elasticsearch / Algolia

Monitoring:
  Metrics: Prometheus + Grafana
  Logging: ELK Stack
  Tracing: OpenTelemetry + Jaeger
  Alerting: PagerDuty

Cloud Provider:
  Primary: AWS
  Regions: us-east-1, eu-west-1, ap-southeast-1, sa-east-1
```

### Key Takeaways

- The system targets 1,666 bookings/second across four regions with 99.99% availability -- these numbers dictate that a monolithic database and single-region deployment are insufficient.
- Four design principles (zero overselling, financial auditability, multi-region active-active, graceful degradation) act as architectural constraints: every component must satisfy all four.
- The technology stack is deliberately conventional (Node.js, MySQL, Redis, Kafka, Kubernetes) -- the complexity comes from how these pieces are composed, not from exotic tooling.
- The system explicitly chooses availability over strict consistency (AP in CAP), accepting that conflicts will occur and resolving them deterministically after the fact.

### Review Questions

1. The system targets 99.99% availability, which allows only 52.6 minutes of downtime per year. How does the choice of multi-region active-active deployment (Principle 3) directly support this target compared to a single-region active-passive failover approach?
2. Principle 1 states that fencing tokens prevent overselling even when a distributed lock expires while two services both believe they hold the lock. In your own words, explain why a simple "check-then-write" approach (read inventory, verify availability, then write the reservation) would fail at 1,666 bookings/second.
3. Look at the technology stack YAML. The system uses four separate Redis clusters for sessions, fencing, cache, and rate-limiting. Why would you separate these into distinct clusters rather than using a single large Redis cluster for everything?

### Hands-On Exercise

Take the four design principles and map each one to a failure scenario it prevents. For each principle, write a short paragraph (3-5 sentences) describing: (a) the specific failure that would occur without the principle, (b) the business impact of that failure (e.g., financial loss, regulatory violation, user-facing outage), and (c) which technology from the stack is the primary mechanism for enforcing the principle. For example, Principle 2 prevents undetectable financial tampering, which would cause audit failures and regulatory penalties, and it is enforced by MySQL triggers on the payment_ledger table.

---

## 2. System Architecture Overview

> **Learning Objectives**
> - Read and interpret the high-level architecture diagram, identifying the role of each service tier
> - Explain why the system uses a microservices architecture rather than a monolith, citing specific scaling requirements
> - Describe how the Outbox Pattern ensures reliable event delivery even if the application crashes after a database commit
> - Understand Kubernetes service discovery and why hardcoding pod IP addresses is an anti-pattern

### 2.1 High-Level Architecture

**Why:** A microservices architecture lets us scale each component independently. The booking service needs 20 replicas to handle creation throughput, while the notification service needs only 8. Monolithic architectures can't provide this granularity.

```
                        +------------------+
                        |   Global CDN     |
                        |  (CloudFront)    |
                        +--------+---------+
                                 |
                        +--------v---------+
                        |  API Gateway     |
                        |  (Kong/NGINX)    |
                        +--------+---------+
                                 |
        +------------------------+------------------------+
        |                        |                        |
   +----v------+        +--------v-------+       +--------v-------+
   | Booking   |        |  Inventory     |       |   Payment      |
   | Service   |<------>|   Service      |<----->|   Service      |
   +----+------+        +--------+-------+       +--------+-------+
        |                        |                        |
        |                +-------v--------+               |
        |                |    Redis       |               |
        |                |   Cluster      |               |
        |                +----------------+               |
        |                                                 |
        +------------------------+------------------------+
                                 |
                        +--------v---------+
                        |  Kafka Event Bus |
                        +--------+---------+
                                 |
        +------------------------+------------------------+
        |                        |                        |
   +----v------+        +--------v-------+       +--------v-------+
   |  Fraud    |        | Notification   |       |  Analytics     |
   | Service   |        |  Service       |       |   Service      |
   +-----------+        +----------------+       +----------------+
```

### 2.2 Microservices Breakdown

| Service | Purpose | Technology | Replicas/Region |
|---------|---------|------------|-----------------|
| **API Gateway** | Request routing, auth, rate limiting | Kong/NGINX | 10 |
| **Booking Service** | Core booking logic | Node.js + NestJS | 20 |
| **Inventory Service** | Availability management | Node.js + NestJS | 15 |
| **Payment Service** | Payment processing | Node.js + NestJS | 12 |
| **Fraud Detection** | Real-time fraud analysis | Node.js + Python | 8 |
| **Notification Service** | Email/SMS/Push | Node.js | 8 |
| **Search Service** | Product search | Node.js + Algolia | 12 |
| **Analytics Service** | Data processing | Python + Spark | 5 |
| **Event Store Service** | Event sourcing | Node.js | 8 |
| **User Service** | Authentication & profiles | Node.js | 10 |

### 2.3 Data Flow

```
User Request --> API Gateway --> Service --> Database
                    |              |
                    |              +---> Outbox Table ---> Kafka Event
                    |                                         |
                    |                                         +---> Notification Service
                    |                                         +---> Analytics Service
                    |                                         +---> Audit Log
                    |
                    +---> Redis Cache
```

> **Architecture Decision:** Events are published through the Outbox Pattern (Section 14), not by calling Kafka directly after a database commit. This guarantees that if the database transaction succeeds, the event will eventually be published -- even if the application crashes immediately after the commit.

### 2.4 Service Communication

**Why:** In a Kubernetes cluster, services discover each other through DNS. Hardcoding individual pod addresses defeats the purpose of service discovery and breaks when pods restart.

```typescript
// ============================================
// Service Client with K8s Service Discovery
// ============================================

class InventoryServiceClient {
  // Use Kubernetes service DNS -- the cluster load-balances across all pods
  private readonly baseUrl =
    'http://inventory-service.production.svc.cluster.local:3000';

  async checkAvailability(params: CheckAvailabilityParams): Promise<boolean> {
    const response = await axios.post(`${this.baseUrl}/api/inventory/check`, params, {
      timeout: 2000,
      headers: {
        'X-Request-ID': randomUUID(),
        'X-Service': 'booking-service'
      }
    });
    return response.data.available;
  }
}
```

> **Common Mistake: Hardcoded Service Endpoints**
> An earlier version of this code listed three specific pod addresses and implemented manual round-robin load balancing. This contradicts Kubernetes service discovery -- when pods restart, their IPs change, and the hardcoded addresses become stale. Always use the Kubernetes service DNS name (`service-name.namespace.svc.cluster.local`) and let the cluster handle load balancing.

### Key Takeaways

- The architecture splits into two tiers: synchronous services (Booking, Inventory, Payment) that handle the real-time booking flow, and asynchronous consumers (Fraud, Notification, Analytics) that react to events via Kafka.
- The Outbox Pattern is the bridge between the database and Kafka -- it guarantees at-least-once event delivery without requiring distributed transactions between MySQL and Kafka.
- Kubernetes service DNS (`service-name.namespace.svc.cluster.local`) replaces hardcoded addresses, ensuring that service-to-service calls survive pod restarts and scaling events.
- Each service has a specific replica count per region tuned to its throughput needs, demonstrating the independent scaling advantage of microservices over monoliths.

### Review Questions

1. In the high-level architecture diagram, the Booking, Inventory, and Payment services communicate directly with each other (shown by bidirectional arrows), while the Fraud, Notification, and Analytics services consume events from the Kafka Event Bus. What design rationale explains why the first group uses synchronous communication and the second group uses asynchronous event consumption?
2. Read the `InventoryServiceClient` code in Section 2.4. The request includes two custom headers: `X-Request-ID` and `X-Service`. What purpose does each header serve in a distributed microservices system, and what operational problems would you face without them?
3. The Architecture Decision callout states that events are published through the Outbox Pattern rather than by calling Kafka directly after a database commit. Describe the specific failure scenario that the Outbox Pattern prevents -- what happens if the application crashes between a successful database commit and a direct Kafka publish call?

### Hands-On Exercise

Draw a sequence diagram (on paper or using a tool like Mermaid or PlantUML) for the following scenario: A user submits a hotel booking request. Trace the request from the CDN through the API Gateway, into the Booking Service, then to the Inventory Service (to check and hold availability), then to the Payment Service (to process payment), and finally show the event being written to the Outbox Table and later published to Kafka, where the Notification Service picks it up and sends a confirmation email. Label each arrow with the communication style (synchronous HTTP, async event, database write). Identify which step would fail silently without the Outbox Pattern.

---

## 3. Database Design & Sharding

> **Learning Objectives**
> - Explain why hash-based sharding on `user_id` is chosen and what tradeoffs it introduces
> - Read and interpret the SQL schemas for bookings, inventory, payments, and events, understanding why specific constraints and indexes exist
> - Understand how database triggers enforce business invariants (immutability of the payment ledger, overbooking audit logging)
> - Describe the inventory hold state machine and its role in preventing overselling during the payment flow
> - Identify the purpose of the Outbox Events table and how it supports reliable event publishing

### 3.1 Sharding Strategy

**Why:** A single MySQL instance can handle roughly 10,000 writes/second. At 1,666 bookings/second, each booking touching multiple tables, we need horizontal partitioning. Sharding by `user_id` keeps all of a user's data on the same shard, enabling efficient joins and transactions.

**Method:** Hash-based sharding on `user_id`

```sql
-- Shard determination
shard_number = hash(user_id) % 16

-- Example:
-- user_id = 12345
-- shard = hash(12345) % 16 = 7
-- Route to shard_07
```

**Configuration:**
- 16 shards total
- 1 primary + 4 read replicas per shard
- Cross-region replication for DR

### 3.2 Core Tables Schema

#### Bookings Table

```sql
CREATE TABLE bookings (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- User & Type
    user_id BIGINT NOT NULL,
    booking_type VARCHAR(20) NOT NULL,  -- 'hotel', 'flight', 'car'
    reference_code VARCHAR(20) NOT NULL UNIQUE,  -- 'HT-20260215-000042'

    -- Idempotency
    idempotency_key VARCHAR(100) NOT NULL,

    -- Pricing
    subtotal DECIMAL(12,2) NOT NULL,
    tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Status
    status ENUM('pending', 'confirmed', 'cancelled', 'completed', 'refunded') DEFAULT 'pending',

    -- Soft Delete
    deleted_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    confirmed_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,

    -- Constraints
    -- NOTE: Foreign keys are NOT used with PARTITION BY HASH in MySQL.
    -- Referential integrity for booking_type and currency is enforced
    -- at the application layer (BookingService.validate()) instead.

    UNIQUE KEY uniq_user_idempotency (user_id, idempotency_key),

    CONSTRAINT chk_amounts CHECK (
        subtotal >= 0 AND
        tax_amount >= 0 AND
        discount_amount >= 0 AND
        total_amount >= 0 AND
        total_amount = (subtotal + tax_amount - discount_amount)
    ),

    INDEX idx_user (user_id, deleted_at),
    INDEX idx_status (status, deleted_at),
    INDEX idx_type (booking_type),
    INDEX idx_created (created_at),
    INDEX idx_reference (reference_code)
) PARTITION BY HASH(user_id) PARTITIONS 16;
```

#### Inventory Table

```sql
CREATE TABLE inventory (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    resource_type ENUM('hotel_room', 'flight_seat', 'car') NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,

    -- Quantities
    total_quantity SMALLINT NOT NULL,
    available_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL DEFAULT 0,
    overbooking_limit SMALLINT DEFAULT 0,

    -- Distributed Locking
    fencing_token BIGINT,

    -- Pricing
    base_price DECIMAL(10,2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',

    -- Metadata
    last_updated_by VARCHAR(100),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT chk_available_quantity CHECK (available_quantity >= 0),
    CONSTRAINT chk_reserved_quantity CHECK (reserved_quantity >= 0),
    CONSTRAINT chk_total_quantity CHECK (total_quantity >= 0),
    CONSTRAINT chk_quantity_balance CHECK (
        available_quantity + reserved_quantity <= total_quantity + overbooking_limit
    ),

    UNIQUE KEY uniq_resource_date (resource_type, resource_id, resource_date),

    INDEX idx_resource (resource_type, resource_id),
    INDEX idx_date (resource_date),
    INDEX idx_availability (resource_type, resource_date, available_quantity),
    INDEX idx_fencing (resource_type, resource_id, fencing_token)
);
```

#### Overbooking Audit Log

**Why:** Airlines routinely overbook by 5-10%. Hotels by 1-2%. This is intentional business logic, but every overbooking event must be logged for revenue management and regulatory compliance.

```sql
CREATE TABLE overbooking_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    resource_type VARCHAR(20) NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,

    -- Snapshot at time of overbooking
    total_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL,
    overbooking_limit SMALLINT NOT NULL,
    actual_oversell SMALLINT NOT NULL,

    -- Context
    triggered_by_booking_id BIGINT,
    triggered_by_user_id BIGINT,
    region VARCHAR(20),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_resource (resource_type, resource_id, resource_date),
    INDEX idx_booking (triggered_by_booking_id),
    INDEX idx_created (created_at)
);

-- Trigger to log overbooking events
DELIMITER //

CREATE TRIGGER log_overbooking_event
AFTER UPDATE ON inventory
FOR EACH ROW
BEGIN
    DECLARE v_oversell SMALLINT;

    -- Oversell = how far reserved exceeds the allowed maximum
    -- (total_quantity + overbooking_limit is the absolute ceiling)
    SET v_oversell = NEW.reserved_quantity - (NEW.total_quantity + NEW.overbooking_limit);

    IF v_oversell > 0 THEN
        INSERT INTO overbooking_log (
            resource_type, resource_id, resource_date,
            total_quantity, reserved_quantity, overbooking_limit,
            actual_oversell
        ) VALUES (
            NEW.resource_type, NEW.resource_id, NEW.resource_date,
            NEW.total_quantity, NEW.reserved_quantity, NEW.overbooking_limit,
            v_oversell
        );
    END IF;
END//

DELIMITER ;
```

#### Inventory Holds Table (State Machine)

**Why:** When a user starts the booking flow, we need to temporarily hold inventory to prevent overselling during the payment process. Holds have a finite lifetime (10 minutes) and follow a strict state machine: active -> confirmed/expired/released/cancelled.

```sql
CREATE TABLE inventory_holds (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    hold_uuid VARCHAR(36) NOT NULL UNIQUE,

    -- Resource
    resource_type ENUM('hotel_room', 'flight_seat', 'car') NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,
    quantity SMALLINT NOT NULL,

    -- User Context
    user_id BIGINT NOT NULL,
    session_id VARCHAR(100) NOT NULL,
    booking_id BIGINT,

    -- Distributed Locking
    fencing_token BIGINT NOT NULL,
    region VARCHAR(20) NOT NULL,

    -- State Machine
    status ENUM('active', 'confirmed', 'expired', 'released', 'cancelled') DEFAULT 'active',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    confirmed_at TIMESTAMP NULL,
    released_at TIMESTAMP NULL,
    cancelled_at TIMESTAMP NULL,

    -- Metadata
    hold_reason VARCHAR(50),
    released_by VARCHAR(100),

    CONSTRAINT chk_quantity CHECK (quantity > 0),
    CONSTRAINT chk_expiry CHECK (expires_at > created_at),

    UNIQUE KEY uniq_active_hold (
        resource_type, resource_id, resource_date,
        user_id, session_id, status
    ),

    INDEX idx_expires (expires_at, status),
    INDEX idx_user_session (user_id, session_id),
    INDEX idx_booking (booking_id),
    INDEX idx_status (status, created_at),
    INDEX idx_fencing (resource_type, resource_id, resource_date, fencing_token)
);

-- Hold state transition audit log
CREATE TABLE inventory_hold_transitions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    hold_id BIGINT NOT NULL,

    from_status VARCHAR(20) NOT NULL,
    to_status VARCHAR(20) NOT NULL,

    transition_reason VARCHAR(255),
    transitioned_by VARCHAR(100),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (hold_id) REFERENCES inventory_holds(id) ON DELETE CASCADE,

    INDEX idx_hold (hold_id),
    INDEX idx_created (created_at)
);
```

#### Transactions Table

```sql
CREATE TABLE transactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    booking_id BIGINT NOT NULL,

    -- Transaction Details
    transaction_type ENUM('payment', 'refund', 'chargeback') NOT NULL,
    payment_provider VARCHAR(50) NOT NULL,
    payment_method ENUM('credit_card', 'debit_card', 'paypal', 'bank_transfer', 'wallet') NOT NULL,

    -- Amounts
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,

    -- Provider Details
    provider_transaction_id VARCHAR(255) UNIQUE,
    provider_status VARCHAR(50),

    -- Status
    status ENUM('pending', 'processing', 'completed', 'failed', 'refunded') DEFAULT 'pending',

    -- Card Info (tokenized)
    card_last_4 CHAR(4),
    card_brand VARCHAR(20),

    -- Error Handling
    error_code VARCHAR(50),
    error_message TEXT,

    -- Soft Delete
    deleted_at TIMESTAMP NULL,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,

    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT,
    FOREIGN KEY (payment_provider) REFERENCES payment_providers(code),
    FOREIGN KEY (currency) REFERENCES currencies(code),

    CONSTRAINT chk_transaction_amount CHECK (amount > 0),

    INDEX idx_booking (booking_id),
    INDEX idx_status (status),
    INDEX idx_provider_id (provider_transaction_id),
    INDEX idx_created (created_at)
);
```

#### Payment Ledger (Immutable)

**Why:** The payment ledger is the single source of truth for all financial activity. It uses blockchain-style hash chaining -- each record includes a hash of the previous record, making tampering detectable. Database triggers enforce immutability by rejecting all UPDATE and DELETE operations.

```sql
CREATE TABLE payment_ledger (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    booking_id BIGINT NOT NULL,
    transaction_id BIGINT,

    -- Event Type
    event_type ENUM(
        'authorization',
        'authorization_void',
        'capture',
        'partial_capture',
        'refund',
        'partial_refund',
        'chargeback',
        'chargeback_reversal'
    ) NOT NULL,

    -- Amounts
    amount DECIMAL(12,2) NOT NULL,
    currency CHAR(3) NOT NULL,
    balance DECIMAL(12,2) NOT NULL,  -- Running balance

    -- Provider Details
    payment_provider VARCHAR(50) NOT NULL,
    provider_transaction_id VARCHAR(255),
    provider_reference VARCHAR(255),

    -- Metadata
    reason TEXT,
    processor_response_code VARCHAR(20),

    -- Blockchain-style Integrity
    record_hash VARCHAR(64) NOT NULL,
    previous_record_hash VARCHAR(64),

    -- Timestamps
    event_timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Initiated By
    initiated_by BIGINT,
    initiated_by_type ENUM('user', 'admin', 'system') NOT NULL,

    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE RESTRICT,

    INDEX idx_booking (booking_id, event_timestamp),
    INDEX idx_transaction (transaction_id),
    INDEX idx_event_type (event_type),
    INDEX idx_timestamp (event_timestamp)
);

-- Immutability triggers
DELIMITER //

CREATE TRIGGER prevent_ledger_update
BEFORE UPDATE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Updates not allowed.';
END//

CREATE TRIGGER prevent_ledger_delete
BEFORE DELETE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Deletes not allowed.';
END//

DELIMITER ;
```

#### Booking Events (Event Store)

**Why:** Event sourcing stores every state change as an immutable event. Instead of storing just the current state, we store the entire history. This enables time-travel debugging, audit trails, and rebuilding state from scratch.

```sql
CREATE TABLE booking_events (
    id BIGINT AUTO_INCREMENT,

    -- Event Metadata
    event_id VARCHAR(36) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_version SMALLINT NOT NULL DEFAULT 1,

    -- Aggregate
    aggregate_id BIGINT NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL DEFAULT 'booking',
    aggregate_version BIGINT NOT NULL,

    -- Event Data
    event_data JSON NOT NULL,
    event_metadata JSON,

    -- Causation & Correlation
    causation_id VARCHAR(36),
    correlation_id VARCHAR(36),

    -- Timestamps
    occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Partitioning
    partition_key VARCHAR(7) NOT NULL,  -- '2026-02'

    PRIMARY KEY (id, partition_key),
    UNIQUE KEY uniq_event (event_id, partition_key),

    INDEX idx_aggregate (aggregate_id, aggregate_version),
    INDEX idx_event_type (event_type),
    INDEX idx_occurred (occurred_at),
    INDEX idx_correlation (correlation_id)

) PARTITION BY RANGE COLUMNS(partition_key) (
    PARTITION p_2026_01 VALUES LESS THAN ('2026-02'),
    PARTITION p_2026_02 VALUES LESS THAN ('2026-03'),
    PARTITION p_2026_03 VALUES LESS THAN ('2026-04'),
    PARTITION p_2026_04 VALUES LESS THAN ('2026-05'),
    PARTITION p_2026_05 VALUES LESS THAN ('2026-06'),
    PARTITION p_2026_06 VALUES LESS THAN ('2026-07'),
    PARTITION p_2026_07 VALUES LESS THAN ('2026-08'),
    PARTITION p_2026_08 VALUES LESS THAN ('2026-09'),
    PARTITION p_2026_09 VALUES LESS THAN ('2026-10'),
    PARTITION p_2026_10 VALUES LESS THAN ('2026-11'),
    PARTITION p_2026_11 VALUES LESS THAN ('2026-12'),
    PARTITION p_2026_12 VALUES LESS THAN ('2027-01'),
    PARTITION p_future VALUES LESS THAN (MAXVALUE)
);
```

#### Outbox Events Table

**Why:** The Outbox Pattern (Section 14) requires a table where events are written in the same database transaction as business data. A separate publisher process reads from this table and publishes to Kafka.

```sql
CREATE TABLE outbox_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    aggregate_type VARCHAR(50) NOT NULL,   -- 'booking', 'inventory', 'payment'
    aggregate_id BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,      -- 'booking.created', 'inventory.reserved'

    payload JSON NOT NULL,
    topic VARCHAR(100) NOT NULL,           -- Kafka topic name
    partition_key VARCHAR(100),            -- Kafka partition key

    status ENUM('pending', 'published', 'failed') DEFAULT 'pending',
    retry_count SMALLINT DEFAULT 0,
    max_retries SMALLINT DEFAULT 5,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    published_at TIMESTAMP NULL,
    last_retry_at TIMESTAMP NULL,
    error_message TEXT,

    INDEX idx_status (status, created_at),
    INDEX idx_aggregate (aggregate_type, aggregate_id)
);
```

#### Inventory Snapshots

```sql
CREATE TABLE inventory_snapshots (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    snapshot_date DATE NOT NULL,
    resource_type VARCHAR(20) NOT NULL,
    resource_id BIGINT NOT NULL,
    resource_date DATE NOT NULL,

    -- Snapshot values
    total_quantity SMALLINT NOT NULL,
    available_quantity SMALLINT NOT NULL,
    reserved_quantity SMALLINT NOT NULL,
    overbooking_limit SMALLINT NOT NULL,

    -- Calculated metrics
    utilization_percent DECIMAL(5,2),
    revenue_per_unit DECIMAL(10,2),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_snapshot (snapshot_date, resource_type, resource_id, resource_date),
    INDEX idx_date (snapshot_date),
    INDEX idx_resource (resource_type, resource_id)
);
```

### 3.3 Complete Table List

**Core Entities:**
- `bookings` - Main booking records
- `hotel_bookings` - Hotel-specific details
- `flight_bookings` - Flight-specific details
- `car_bookings` - Car rental details
- `booking_passengers` - Passenger information
- `booking_rooms` - Room details

**Inventory:**
- `inventory` - Availability tracking
- `inventory_holds` - Temporary reservations with state machine
- `inventory_hold_transitions` - Hold state change audit log
- `inventory_locks` - Lock records (audit)
- `inventory_snapshots` - Daily snapshots for reconciliation
- `overbooking_log` - Oversell event audit log

**Payments:**
- `transactions` - Payment transactions
- `payment_ledger` - Immutable financial log
- `accounting_entries` - Double-entry journal
- `accounting_entry_lines` - Journal line items
- `chart_of_accounts` - Account definitions

**Events:**
- `booking_events` - Event sourcing store
- `booking_snapshots` - Aggregate snapshots
- `outbox_events` - Reliable event publishing

**Audit:**
- `booking_audit_logs` - State transitions
- `inventory_hold_transitions` - Hold state changes
- `overbooking_log` - Oversell attempts

**Fraud:**
- `fraud_checks` - Fraud analysis results
- `device_fingerprints` - Device tracking
- `email_reputation` - Email scoring
- `phone_validation` - Phone verification

**Lookups:**
- `booking_types` - Booking categories
- `currencies` - Currency definitions
- `payment_providers` - Payment gateways
- `booking_transition_reasons` - Cancellation reasons

### Key Takeaways

- Hash-based sharding on `user_id` across 16 shards enables horizontal scaling beyond a single MySQL instance's write capacity, while keeping all of a user's data co-located for efficient joins and transactions.
- The inventory table's `chk_quantity_balance` constraint (`available_quantity + reserved_quantity <= total_quantity + overbooking_limit`) is the database-level enforcement of the zero-overselling principle -- it prevents any write that would exceed the allowed capacity.
- The payment ledger is made immutable by two MySQL triggers that reject any UPDATE or DELETE with a `SIGNAL SQLSTATE '45000'` error. Combined with blockchain-style hash chaining, this creates a tamper-evident financial audit trail.
- Inventory holds implement a state machine (active -> confirmed/expired/released/cancelled) with a separate transitions table, ensuring that every state change is auditable and that holds automatically expire after 10 minutes to release inventory.
- The outbox_events table, booking_events table, and inventory_hold_transitions table each serve a different purpose: reliable Kafka publishing, full event sourcing history, and hold-specific audit logging, respectively.

### Review Questions

1. The bookings table uses `PARTITION BY HASH(user_id) PARTITIONS 16` and includes a comment stating that foreign keys are not used because MySQL does not support them with hash partitioning. Given this constraint, how does the system enforce referential integrity for fields like `booking_type` and `currency`? What are the tradeoffs of application-layer enforcement versus database-level foreign keys?
2. Read the `prevent_ledger_update` and `prevent_ledger_delete` triggers on the payment_ledger table. If a bug in the payment service writes an incorrect amount to the ledger, how would you correct it given that updates and deletes are blocked? How does the `record_hash` and `previous_record_hash` mechanism help detect such errors?
3. The inventory_holds table has a `UNIQUE KEY uniq_active_hold` on `(resource_type, resource_id, resource_date, user_id, session_id, status)`. Why does this unique key include `status`? What would happen if `status` were omitted from the key and a user attempted to create a new hold after their previous hold on the same resource was expired?

### Hands-On Exercise

Using any MySQL-compatible database (MySQL 8.0, MariaDB, or even an online SQL playground), create the `inventory` and `overbooking_log` tables along with the `log_overbooking_event` trigger. Then execute the following sequence and observe the results:

1. Insert an inventory row for a hotel room with `total_quantity = 10`, `available_quantity = 10`, `reserved_quantity = 0`, and `overbooking_limit = 1`.
2. Update the row to simulate reservations: set `reserved_quantity = 10` and `available_quantity = 0`. Verify that no row appears in `overbooking_log` (because 10 <= 10 + 1).
3. Update the row to simulate an overbooking: set `reserved_quantity = 12` and `available_quantity = -1`. Observe that the `chk_available_quantity` constraint rejects this (available cannot be negative). Then try `reserved_quantity = 12` and `available_quantity = 0`. Check whether `chk_quantity_balance` allows or rejects this write (12 + 0 = 12 > 10 + 1 = 11, so it should be rejected).
4. Set `overbooking_limit = 2` and retry step 3. This time the write should succeed, and a row should appear in `overbooking_log` with `actual_oversell = 1` (because 12 > 10 + 2 is false, but check the trigger logic: `v_oversell = 12 - (10 + 2) = 0`, so no log entry). Increase `reserved_quantity = 13` and verify that a log entry now appears with `actual_oversell = 1`.

Document what you observe at each step. Pay attention to which constraints fire and when the trigger writes to the overbooking log.

---
# PART II: THE BOOKING FLOW

Welcome to the heart of the Global Booking System. In Part I you learned the foundational building blocks -- the database schemas, the infrastructure topology, the guiding principles. Now you will follow a single booking request from the moment it hits the API Gateway to the moment inventory is held for a customer. Every service you encounter here exists because of a concrete problem: authentication must happen before anything else, search must be fast enough to keep users engaged, and inventory must be protected against concurrent access.

This part covers four critical layers in order. First, the API Gateway receives and routes the request while enforcing security headers and rate limits. Second, the authentication and authorization layer verifies who the user is and what they are allowed to do. Third, the Search Service translates user intent (dates, location, budget) into sub-200ms query results using Elasticsearch. Fourth, the Inventory Management service places a temporary hold on the requested resource, using fencing tokens and a state machine to prevent double-booking.

This is the happy path. Parts III and IV handle what happens when things go wrong -- payment failures, partial saga rollbacks, network partitions between regions, and all the edge cases that make distributed systems genuinely difficult. For now, assume every call succeeds, every service responds, and the user completes their booking without interruption. Understanding the happy path thoroughly is a prerequisite for understanding failure handling.

---

## 4. API Gateway & Request Routing

> **Learning Objectives**
> - Understand why a single entry point (API Gateway) exists and what cross-cutting concerns it absorbs from downstream services.
> - Read and interpret a declarative Kong Gateway configuration including services, routes, and plugins.
> - Explain the difference between liveness and readiness health checks and why both are necessary.
> - Identify which security headers the gateway injects and why each one matters.
> - Describe how the gateway routes requests to internal Kubernetes services using cluster-local DNS.

**Why:** The API Gateway is the single entry point for all client requests. It handles cross-cutting concerns -- authentication, rate limiting, request logging, CORS -- so individual microservices don't have to. Without a gateway, every service would need to implement these independently, leading to inconsistency and security gaps.

### 4.1 Kong Gateway Configuration

```yaml
# kong.yml - Declarative configuration
_format_version: "3.0"

services:
  - name: booking-service
    url: http://booking-service.production.svc.cluster.local:3000
    routes:
      - name: booking-routes
        paths:
          - /api/v1/bookings
        methods:
          - GET
          - POST
        strip_path: false

  - name: inventory-service
    url: http://inventory-service.production.svc.cluster.local:3000
    routes:
      - name: inventory-routes
        paths:
          - /api/v1/inventory
        methods:
          - GET
        strip_path: false

  - name: payment-service
    url: http://payment-service.production.svc.cluster.local:3000
    routes:
      - name: payment-routes
        paths:
          - /api/v1/payments
        methods:
          - POST
        strip_path: false

  - name: search-service
    url: http://search-service.production.svc.cluster.local:3000
    routes:
      - name: search-routes
        paths:
          - /api/v1/search
        methods:
          - GET
        strip_path: false

plugins:
  - name: cors
    config:
      origins:
        - "https://www.bookingplatform.com"
        - "https://app.bookingplatform.com"
      methods:
        - GET
        - POST
        - PUT
        - DELETE
        - OPTIONS
      headers:
        - Authorization
        - Content-Type
        - Idempotency-Key
        - X-Request-ID
      max_age: 3600
      credentials: true

  - name: request-transformer
    config:
      add:
        headers:
          - "X-Gateway-Region:us-east-1"
          - "X-Gateway-Timestamp:$(date +%s)"

  - name: response-transformer
    config:
      add:
        headers:
          - "Strict-Transport-Security:max-age=31536000; includeSubDomains"
          - "X-Content-Type-Options:nosniff"
          - "X-Frame-Options:DENY"
          - "Content-Security-Policy:default-src 'self'"
```

### 4.2 Health Check Endpoints

```typescript
// Every service exposes standardized health endpoints

// Liveness: Is the process alive?
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: Can the service accept traffic?
app.get('/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});
```

### Key Takeaways

- The API Gateway centralizes cross-cutting concerns (CORS, security headers, request transformation) so that individual microservices remain focused on business logic.
- Kong's declarative YAML configuration maps external URL paths to internal Kubernetes service addresses, with `strip_path: false` preserving the original path for downstream routing.
- Security headers like `Strict-Transport-Security`, `X-Content-Type-Options`, and `Content-Security-Policy` are injected at the gateway level, guaranteeing every response includes them regardless of which service handled the request.
- Liveness checks (`/health`) tell the orchestrator whether to restart a container; readiness checks (`/ready`) tell the load balancer whether to send traffic. Conflating the two causes either unnecessary restarts or traffic routed to broken instances.

### Review Questions

1. **Conceptual:** Why does the gateway configuration set `strip_path: false` on all routes? What would happen if it were set to `true` and the downstream service expected the full `/api/v1/bookings` path?
2. **Code-reading:** Look at the readiness endpoint. It checks both `db.query('SELECT 1')` and `redis.ping()`. If Redis is down but the database is up, the service reports `not_ready`. Is this the right behavior for a service that could technically serve some requests without Redis? What trade-off is being made?
3. **Conceptual:** The `Idempotency-Key` header is listed in the CORS allowed headers. Why would a booking platform need clients to send idempotency keys, and what problems does this prevent at the gateway level?

### Hands-On Exercise

**Add a new service route to the Kong configuration.** Suppose you are introducing a `notification-service` that listens on `http://notification-service.production.svc.cluster.local:3000` and should be reachable at `/api/v1/notifications` for both `GET` and `POST` methods. Write the YAML block that adds this service and its route to the existing `kong.yml`. Then add a rate-limiting plugin scoped only to this new service (not globally) that limits requests to 100 per minute per consumer. Refer to the Kong plugin documentation format used by the `cors` plugin as a structural guide.

---

## 5. Authentication & Authorization

> **Learning Objectives**
> - Understand the separation between authentication (who you are) and authorization (what you can do) and why both are necessary in a booking platform.
> - Trace the lifecycle of a JWT token pair from generation through verification to revocation.
> - Explain how Redis-backed session storage enables token revocation without waiting for token expiry.
> - Read and interpret an RBAC (Role-Based Access Control) permission model and its application via decorators.
> - Describe why service-to-service authentication uses a different mechanism (mTLS + API keys) than user-facing authentication (JWT).

**Why:** A booking platform handles financial transactions and personal data. Authentication verifies identity; authorization ensures users can only access their own bookings. Service-to-service communication needs its own auth to prevent unauthorized internal access.

### 5.1 JWT Token Structure

```typescript
// ============================================
// JWT Token Service
// ============================================

import jwt from 'jsonwebtoken';

interface TokenPayload {
  userId: string;       // Use string to avoid BigInt JSON serialization issues
  email: string;
  roles: string[];
  region: string;
  sessionId: string;
}

export class AuthService {
  private readonly accessTokenSecret = process.env.JWT_ACCESS_SECRET;
  private readonly refreshTokenSecret = process.env.JWT_REFRESH_SECRET;

  async generateTokenPair(user: User): Promise<TokenPair> {
    const payload: TokenPayload = {
      userId: user.id.toString(),  // Convert BigInt to string for JSON safety
      email: user.email,
      roles: user.roles,
      region: process.env.REGION,
      sessionId: randomUUID()
    };

    const accessToken = jwt.sign(payload, this.accessTokenSecret, {
      expiresIn: '15m',
      issuer: 'booking-platform',
      audience: 'booking-api'
    });

    const refreshToken = jwt.sign(
      { userId: user.id, sessionId: payload.sessionId },
      this.refreshTokenSecret,
      { expiresIn: '7d' }
    );

    // Store session in Redis for revocation support
    await redis.setex(
      `session:${payload.sessionId}`,
      7 * 24 * 60 * 60, // 7 days
      JSON.stringify({ userId: user.id, createdAt: Date.now() })
    );

    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const payload = jwt.verify(token, this.accessTokenSecret) as TokenPayload;

    // Check if session has been revoked
    const session = await redis.get(`session:${payload.sessionId}`);
    if (!session) {
      throw new UnauthorizedError('Session has been revoked');
    }

    return payload;
  }
}
```

### 5.2 RBAC Roles

```typescript
export enum Role {
  GUEST = 'guest',           // Can search, view prices
  USER = 'user',             // Can book, view own bookings
  PREMIUM_USER = 'premium',  // Higher rate limits, priority support
  ADMIN = 'admin',           // Manage bookings, view reports
  SUPER_ADMIN = 'super_admin' // System configuration, user management
}

// Permission guard decorator for NestJS
export const RequireRoles = (...roles: Role[]) => {
  return SetMetadata('roles', roles);
};

// Usage in controllers
@Post('/bookings')
@RequireRoles(Role.USER, Role.PREMIUM_USER, Role.ADMIN)
async createBooking(@Body() dto: CreateBookingDto) {
  // Only authenticated users with appropriate roles
}

@Get('/admin/reports')
@RequireRoles(Role.ADMIN, Role.SUPER_ADMIN)
async getReports() {
  // Admin-only endpoint
}
```

### 5.3 Service-to-Service Authentication

```typescript
// Internal services authenticate via mTLS (handled by Istio)
// plus API key validation for defense in depth

export class ServiceAuthMiddleware {
  async validate(req: Request, res: Response, next: NextFunction) {
    const serviceKey = req.headers['x-service-key'];
    const serviceName = req.headers['x-service'];

    if (!serviceKey || !serviceName) {
      return res.status(401).json({ error: 'Missing service credentials' });
    }

    const validKey = await redis.get(`service-key:${serviceName}`);
    if (validKey !== serviceKey) {
      return res.status(403).json({ error: 'Invalid service key' });
    }

    next();
  }
}
```

### Key Takeaways

- Access tokens are short-lived (15 minutes) to limit the damage window if a token is leaked; refresh tokens are long-lived (7 days) and paired with a Redis-backed session store that allows instant revocation.
- The `userId` field is stored as a string in the JWT payload because JavaScript's `JSON.stringify` cannot safely serialize BigInt values -- a subtle but important detail when your database uses 64-bit identifiers.
- RBAC is enforced via decorators (`@RequireRoles`) that attach metadata to route handlers, keeping authorization logic declarative and co-located with the endpoint definition rather than buried in middleware.
- Service-to-service authentication uses a layered defense: mTLS at the network level (handled by the Istio service mesh) plus application-level API key validation. Either layer alone is insufficient -- mTLS can be bypassed if the mesh is misconfigured, and API keys can be leaked.

### Review Questions

1. **Code-reading:** In `generateTokenPair`, the access token includes `email`, `roles`, and `region`, but the refresh token only includes `userId` and `sessionId`. Why is the refresh token's payload deliberately minimal? What would go wrong if the refresh token also contained roles?
2. **Conceptual:** The `verifyAccessToken` method checks Redis on every request to confirm the session has not been revoked. This adds a network round-trip to every authenticated API call. What is the trade-off being made here, and can you think of an alternative approach that avoids hitting Redis on every request while still supporting revocation?
3. **Code-reading:** In the `ServiceAuthMiddleware`, the code returns HTTP 401 for missing credentials but HTTP 403 for invalid credentials. What is the semantic difference between these two status codes, and why is it important to use the correct one?

### Hands-On Exercise

**Implement a token refresh endpoint.** Using the `AuthService` class as a starting point, write a `refreshAccessToken(refreshToken: string): Promise<TokenPair>` method. It should: (a) verify the refresh token using `this.refreshTokenSecret`, (b) check that the session still exists in Redis, (c) look up the current user from the database to get their latest roles (since roles may have changed since the original token was issued), and (d) generate and return a new token pair. Make sure to invalidate the old session and create a new one so that refresh tokens are single-use. Write out the full method implementation with error handling.

---

## 6. Search Service

> **Learning Objectives**
> - Understand why a dedicated search engine (Elasticsearch) is used instead of querying the primary MySQL database for read-heavy operations.
> - Identify this as the **read** side of the CQRS pattern and explain how it stays in sync with the write side.
> - Read and interpret a compound Elasticsearch query that combines geo-distance filtering, date range checks, price filtering, and amenity matching.
> - Explain how the search index is updated asynchronously via Kafka events from the transactional outbox.
> - Understand the pagination model (`from`/`size`) and its limitations at scale.

**Why:** Users need to find hotels, flights, and cars quickly with complex filters (location, dates, price range, amenities). The primary database (MySQL) is optimized for transactions, not full-text search or geo-queries. A dedicated search engine provides sub-200ms results. This is the **read** side of the CQRS pattern (Section 8) -- writes go to MySQL, reads are served from Elasticsearch.

### 6.1 Elasticsearch Integration

```typescript
// ============================================
// Search Service
// ============================================

import { Client } from '@elastic/elasticsearch';

export class SearchService {
  private readonly esClient = new Client({
    node: process.env.ELASTICSEARCH_URL,
    auth: { apiKey: process.env.ELASTICSEARCH_API_KEY }
  });

  async searchHotels(params: HotelSearchParams): Promise<SearchResult> {
    const { body } = await this.esClient.search({
      index: 'hotels',
      body: {
        query: {
          bool: {
            must: [
              // Geo-distance filter
              {
                geo_distance: {
                  distance: `${params.radiusKm || 50}km`,
                  location: {
                    lat: params.latitude,
                    lon: params.longitude
                  }
                }
              },
              // Date availability
              {
                range: {
                  available_from: { lte: params.checkIn }
                }
              },
              {
                range: {
                  available_to: { gte: params.checkOut }
                }
              }
            ],
            filter: [
              // Price range
              ...(params.minPrice || params.maxPrice ? [{
                range: {
                  price_per_night: {
                    ...(params.minPrice && { gte: params.minPrice }),
                    ...(params.maxPrice && { lte: params.maxPrice })
                  }
                }
              }] : []),
              // Star rating
              ...(params.minStars ? [{
                range: { star_rating: { gte: params.minStars } }
              }] : []),
              // Amenities
              ...(params.amenities?.length ? [{
                terms: { amenities: params.amenities }
              }] : [])
            ]
          }
        },
        sort: [
          { _score: 'desc' },
          { popularity_score: 'desc' },
          { price_per_night: params.sortByPrice || 'asc' }
        ],
        from: params.offset || 0,
        size: params.limit || 20
      }
    });

    return {
      results: body.hits.hits.map(hit => hit._source),
      total: body.hits.total.value,
      took: body.took
    };
  }

  // Index updates triggered by Kafka events from outbox
  async updateHotelIndex(event: HotelUpdatedEvent): Promise<void> {
    await this.esClient.update({
      index: 'hotels',
      id: event.hotelId.toString(),
      body: {
        doc: {
          price_per_night: event.basePrice,
          available_rooms: event.availableQuantity,
          updated_at: new Date().toISOString()
        }
      }
    });
  }
}
```

### Key Takeaways

- The Search Service exists because MySQL cannot efficiently handle geo-distance queries, full-text search, and complex faceted filtering at the latency targets a booking platform requires (sub-200ms).
- The Elasticsearch query uses a `bool` query with `must` clauses for hard requirements (location proximity, date availability) and `filter` clauses for optional narrowing (price range, star rating, amenities). Filters in the `filter` context are not scored, which makes them faster.
- Index updates are triggered asynchronously by Kafka events originating from the transactional outbox, meaning the search index is eventually consistent with the primary database -- not immediately consistent. A user who just changed a hotel's price may see the old price in search results for a brief window.
- The `from`/`size` pagination approach works for typical user-facing pages but degrades past ~10,000 results. For deep pagination, Elasticsearch's `search_after` API would be needed.
- The `updateHotelIndex` method demonstrates a partial document update (`doc`), which is more efficient than re-indexing the entire hotel document when only price or availability changes.

### Review Questions

1. **Conceptual:** The search query places the `geo_distance` check in the `must` clause, but the price range filter in the `filter` clause. Both are required constraints. What is the practical difference between `must` and `filter` in Elasticsearch, and why is the price range in `filter` instead of `must`?
2. **Code-reading:** The `updateHotelIndex` method updates `price_per_night`, `available_rooms`, and `updated_at`. But the search query filters on `available_from` and `available_to`, not `available_rooms`. How might a zero-room scenario (all rooms booked) be handled to prevent showing sold-out hotels in search results?
3. **Conceptual:** This section states that the search index is the read side of a CQRS pattern (Section 8). What guarantees does eventual consistency provide, and what user-visible anomalies could occur during the window between a write to MySQL and the index update in Elasticsearch?

### Hands-On Exercise

**Extend the search query with a text-based filter.** Suppose hotel documents in the `hotels` index also contain a `description` field (free-text) and a `name` field. Add a `keyword` parameter to `HotelSearchParams` that, when provided, performs a `multi_match` query across both `name` (boosted 3x) and `description`. Place this clause in the correct position within the `bool` query so that it contributes to relevance scoring. Write the modified query section and explain why you placed the clause where you did.

---

## 7. Inventory Management

> **Learning Objectives**
> - Understand why inventory is the most contention-prone part of a booking system and what mechanisms protect it from double-booking.
> - Read and trace the hold state machine through all valid transitions: creation, extension, confirmation, expiry, release, and cancellation.
> - Follow the `createHold` method line-by-line to understand how fencing tokens, transactional boundaries, and outbox events work together.
> - Explain how expired holds are cleaned up safely using a stored procedure with temporary tables and `FOR UPDATE` locking.
> - Interpret overbooking policies and understand the business reasoning behind different limits for different resource types and tiers.

**Why:** Inventory is the most contention-prone part of the system. Multiple users may try to book the last available room simultaneously. The inventory service uses fencing tokens (Section 11), temporary holds with a state machine, and overbooking policies to manage this safely. When a booking is confirmed, the hold flows into the Saga Orchestrator (Section 13) and triggers a double-entry accounting record (Section 9).

### 7.1 Hold State Machine

```
                 +--------+
                 | (none) |
                 +---+----+
                     |
                  createHold
                     |
                 +---v----+
            +--->| active |<---+
            |    +---+----+    |
            |        |         |
       extend TTL    |    hold still valid
            |        |
            +--------+----+--------+--------+
                     |    |        |        |
                 confirm expire  release  cancel
                     |    |        |        |
              +------v-+  +--v---+ +--v----+ +---v-----+
              |confirmed|  |expired| |released| |cancelled|
              +--------+  +------+ +-------+ +---------+
```

### 7.2 Inventory Hold Service

```typescript
// ============================================
// Inventory Hold Service
// ============================================

export class InventoryHoldService {

  async createHold(params: {
    resourceType: string;
    resourceId: bigint;
    resourceDate: Date;
    quantity: number;
    userId: bigint;
    sessionId: string;
    ttlSeconds: number;
  }): Promise<InventoryHold> {

    const holdUuid = randomUUID();
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
    const fencingToken = await this.getNextFencingToken(
      params.resourceType, params.resourceId, params.resourceDate
    );

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Check if user already has active hold for this resource
      const [existing] = await connection.execute(`
        SELECT id FROM inventory_holds
        WHERE user_id = ? AND session_id = ?
        AND resource_type = ? AND resource_id = ? AND resource_date = ?
        AND status = 'active'
      `, [params.userId, params.sessionId, params.resourceType,
          params.resourceId, params.resourceDate]);

      if (existing.length > 0) {
        // Extend existing hold
        await connection.execute(
          'UPDATE inventory_holds SET expires_at = ? WHERE id = ?',
          [expiresAt, existing[0].id]
        );
        await connection.commit();
        return this.getHoldById(existing[0].id);
      }

      // Reserve inventory with fencing token check (Section 11)
      const [result] = await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity + ?,
            available_quantity = available_quantity - ?,
            fencing_token = ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
        AND available_quantity >= ?
        AND (fencing_token IS NULL OR fencing_token < ?)
      `, [params.quantity, params.quantity, fencingToken,
          params.resourceType, params.resourceId, params.resourceDate,
          params.quantity, fencingToken]);

      if (result.affectedRows === 0) {
        throw new InsufficientInventoryError('Not enough inventory available');
      }

      // Create hold record
      const [holdResult] = await connection.execute(`
        INSERT INTO inventory_holds (
          hold_uuid, resource_type, resource_id, resource_date,
          quantity, user_id, session_id, fencing_token,
          region, status, expires_at, hold_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'user_booking')
      `, [holdUuid, params.resourceType, params.resourceId,
          params.resourceDate, params.quantity, params.userId,
          params.sessionId, fencingToken, process.env.REGION, expiresAt]);

      const holdId = holdResult.insertId;

      // Log state transition
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'none', 'active', 'Hold created by user', ?)
      `, [holdId, `user:${params.userId}`]);

      // Write to outbox for multi-region sync (Section 14)
      await connection.execute(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, topic, partition_key
        ) VALUES ('inventory_hold', ?, 'inventory.hold_created', ?, 'inventory-events', ?)
      `, [holdId, JSON.stringify({ holdId, holdUuid, ...params, fencingToken, expiresAt }),
          `${params.resourceType}:${params.resourceId}`]);

      await connection.commit();
      return this.getHoldById(holdId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async confirmHold(holdId: bigint, bookingId: bigint): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [result] = await connection.execute(`
        UPDATE inventory_holds
        SET status = 'confirmed', booking_id = ?, confirmed_at = NOW()
        WHERE id = ? AND status = 'active' AND expires_at > NOW()
      `, [bookingId, holdId]);

      if (result.affectedRows === 0) {
        throw new InvalidHoldStateError('Hold is not active or has expired');
      }

      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'confirmed', 'Booking confirmed', ?)
      `, [holdId, `booking:${bookingId}`]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async releaseHold(holdId: bigint, reason: string, releasedBy: string): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [holds] = await connection.execute(`
        SELECT resource_type, resource_id, resource_date, quantity, status
        FROM inventory_holds WHERE id = ? FOR UPDATE
      `, [holdId]);

      if (holds.length === 0) throw new NotFoundError('Hold not found');
      if (holds[0].status !== 'active') {
        throw new InvalidHoldStateError(`Cannot release hold in status: ${holds[0].status}`);
      }

      const hold = holds[0];

      await connection.execute(`
        UPDATE inventory_holds
        SET status = 'released', released_at = NOW(), released_by = ?
        WHERE id = ?
      `, [releasedBy, holdId]);

      await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ?,
            available_quantity = available_quantity + ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
      `, [hold.quantity, hold.quantity, hold.resource_type,
          hold.resource_id, hold.resource_date]);

      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'released', ?, ?)
      `, [holdId, reason, releasedBy]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
```

### 7.3 Expired Holds Cleanup

```sql
-- Stored procedure for safe hold release (runs every 30 seconds)
DELIMITER //

CREATE PROCEDURE release_expired_holds()
BEGIN
    DECLARE v_expired_count INT DEFAULT 0;
    DECLARE v_released_quantity INT DEFAULT 0;

    CREATE TEMPORARY TABLE IF NOT EXISTS temp_expired_holds (
        hold_id BIGINT,
        resource_type VARCHAR(20),
        resource_id BIGINT,
        resource_date DATE,
        quantity SMALLINT,
        fencing_token BIGINT
    );

    START TRANSACTION;

    INSERT INTO temp_expired_holds
    SELECT id, resource_type, resource_id, resource_date, quantity, fencing_token
    FROM inventory_holds
    WHERE status = 'active' AND expires_at < NOW()
    FOR UPDATE;

    UPDATE inventory_holds
    SET status = 'expired', released_at = NOW(), released_by = 'system_cron'
    WHERE id IN (SELECT hold_id FROM temp_expired_holds);

    SET v_expired_count = ROW_COUNT();

    UPDATE inventory i
    INNER JOIN temp_expired_holds h ON
        i.resource_type = h.resource_type AND
        i.resource_id = h.resource_id AND
        i.resource_date = h.resource_date
    SET i.reserved_quantity = i.reserved_quantity - h.quantity,
        i.available_quantity = i.available_quantity + h.quantity,
        i.updated_at = NOW()
    WHERE i.fencing_token < h.fencing_token;

    INSERT INTO inventory_hold_transitions (hold_id, from_status, to_status, transition_reason, transitioned_by)
    SELECT hold_id, 'active', 'expired', 'Automatic expiry by cron job', 'system_cron'
    FROM temp_expired_holds;

    COMMIT;

    DROP TEMPORARY TABLE IF EXISTS temp_expired_holds;

    SELECT v_expired_count as expired_holds, NOW() as processed_at;
END//

DELIMITER ;

CREATE EVENT release_expired_holds_event
ON SCHEDULE EVERY 30 SECOND
DO CALL release_expired_holds();
```

### 7.4 Overbooking Policies

```typescript
export const overbookingPolicies = {
  flight: {
    economy: 0.10,      // 10% overbooking allowed
    business: 0.05,     // 5%
    first: 0.00,        // No overbooking for first class
    compensation: {
      voluntary: 400,
      involuntary: 800
    }
  },
  hotel: {
    standard: 0.02,     // 2% overbooking allowed
    premium: 0.00,      // No overbooking for premium rooms
    compensation: {
      upgradeSameHotel: true,
      alternativeHotel: true,
      refundAmount: 1.5  // 1.5x room rate
    }
  },
  car: {
    overbookingLimit: 0.00,
    compensation: {
      upgradeCategory: true,
      refundAmount: 2.0
    }
  }
};
```

### Key Takeaways

- The hold state machine enforces a strict lifecycle: a hold can only be confirmed, expired, released, or cancelled from the `active` state. Every transition is logged in the `inventory_hold_transitions` table, creating a complete audit trail.
- The `createHold` method is idempotent per user-session-resource combination: if a user already has an active hold for the same resource, the method extends the TTL instead of creating a duplicate hold. This prevents inventory leaks from retried requests.
- Fencing tokens prevent stale writes. The `UPDATE inventory ... AND (fencing_token IS NULL OR fencing_token < ?)` clause ensures that if two concurrent requests race, only the one with the higher token succeeds. This is the same pattern detailed in Section 11.
- The expired holds cleanup procedure uses `FOR UPDATE` locking and a temporary table to batch-process expirations safely. Running every 30 seconds means a hold may remain in `active` state up to 30 seconds past its `expires_at` timestamp -- this is acceptable because the `confirmHold` method independently checks `expires_at > NOW()`.
- Overbooking policies are tiered by both resource type and tier (economy vs. first class, standard vs. premium). Higher-tier resources have zero overbooking tolerance, reflecting the business reality that premium customers have less tolerance for displacement.

### Review Questions

1. **Code-reading:** In the `createHold` method, the outbox event is written inside the same database transaction as the inventory update and hold creation. Why is this critical? What would happen if the outbox insert were done after the transaction committed, in a separate operation?
2. **Conceptual:** The expired holds cleanup procedure includes `WHERE i.fencing_token < h.fencing_token` in the inventory restoration UPDATE. Why is this fencing token check necessary during cleanup? What scenario would cause inventory to be incorrectly restored without it?
3. **Code-reading:** The `releaseHold` method uses `SELECT ... FOR UPDATE` to lock the hold row before checking its status. The `confirmHold` method does not -- it relies on the `WHERE status = 'active' AND expires_at > NOW()` clause in the UPDATE itself. Both approaches prevent invalid state transitions. What is the trade-off between these two locking strategies?

### Hands-On Exercise

**Implement the `cancelHold` transition.** Looking at the state machine diagram, `cancel` is a valid transition from `active` to `cancelled`. Write a `cancelHold(holdId: bigint, cancelledBy: string, reason: string): Promise<void>` method for the `InventoryHoldService` class. It should: (a) acquire a row-level lock on the hold, (b) verify the hold is in `active` status, (c) update the hold status to `cancelled`, (d) restore the reserved/available quantities in the `inventory` table, (e) log the transition in `inventory_hold_transitions`, and (f) write an outbox event for multi-region sync. Model your implementation on the `releaseHold` method, but use the appropriate status values and event type for cancellation. Wrap everything in a single transaction with proper error handling and connection cleanup.

---
## 8. Booking Service & Orchestration

> **Learning Objectives**
> - Understand how the booking service orchestrates inventory checks, payment processing, and confirmation into a single transactional flow
> - Recognize the role of inventory holds and their time-to-live (TTL) in preventing overselling
> - Learn how the outbox pattern is used to publish domain events reliably after a booking is created
> - Read a booking status state machine and trace every possible lifecycle transition
> - Identify where compensating actions (hold release) fit into error handling

**Why:** The booking service orchestrates the entire booking flow: checking inventory, creating holds, processing payments, and confirming reservations. This section shows the imperative flow; Section 13 (Saga Pattern) shows how to make this more resilient with compensating transactions. Fraud checks (Section 22) are performed before payment processing.

### 8.1 Booking Creation Flow

```typescript
// ============================================
// Booking Service - Core Orchestration
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // 1. Check inventory availability
    const available = await this.inventoryService.checkAvailability({
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      date: dto.date
    });

    if (!available) {
      throw new InsufficientInventoryError();
    }

    // 2. Reserve inventory (creates a hold)
    const hold = await this.inventoryService.createHold({
      ...dto,
      ttlSeconds: 600  // 10 minutes
    });

    try {
      // 3. Process payment
      const payment = await this.paymentService.processPayment({
        amount: dto.totalAmount,
        currency: dto.currency,
        paymentMethod: dto.paymentMethod
      });

      // 4. Create booking record
      const booking = await this.createBookingRecord(dto, payment.id);

      // 5. Confirm hold
      await this.inventoryService.confirmHold(hold.id, booking.id);

      // 6. Write event to outbox (not directly to Kafka)
      await this.writeOutboxEvent('booking', booking.id, 'booking.created', {
        bookingId: booking.id,
        referenceCode: booking.referenceCode,
        userId: dto.userId,
        bookingType: dto.bookingType,
        totalAmount: dto.totalAmount,
        currency: dto.currency
      });

      return booking;

    } catch (error) {
      // Rollback: Release hold
      await this.inventoryService.releaseHold(hold.id, error.message, 'booking-service');
      throw error;
    }
  }

  // See Section 15 (Saga Pattern) for a more resilient orchestration approach
}
```

### 8.2 Booking Status State Machine

```
  +--------+     confirm     +-----------+     complete     +-----------+
  |pending |--------------->| confirmed |---------------->| completed |
  +---+----+                +-----+-----+                 +-----------+
      |                           |
      |  payment_failed           |  cancel
      |                           |
  +---v-----+              +------v-----+     refund     +----------+
  | failed  |              | cancelled  |--------------->| refunded |
  +---------+              +------------+                +----------+
```

### Key Takeaways

- The booking service follows a strict sequential flow: check availability, create hold, process payment, create record, confirm hold, publish event. Each step depends on the previous one succeeding.
- Inventory holds with a TTL (10 minutes) act as a pessimistic lock that prevents double-selling while giving the system time to complete payment processing.
- The outbox pattern (step 6) ensures that the `booking.created` event is persisted in the same database transaction as the booking itself, guaranteeing at-least-once delivery without distributed transaction overhead.
- Error handling releases the inventory hold immediately so that the resource becomes available to other customers rather than remaining locked until TTL expiry.
- The state machine defines exactly five terminal and intermediate states; every transition is explicit, making it straightforward to audit booking lifecycle in production.

### Review Questions

1. **Conceptual:** Why does the booking service create an inventory hold *before* processing payment, rather than after? What would happen if the order were reversed?
2. **Code-Reading:** In the `createBooking` method, the `catch` block calls `releaseHold` but does *not* reverse the payment. Why is this safe given that the payment call is the first operation inside the `try` block? Under what circumstances could a payment succeed but the booking still fail?
3. **Conceptual:** The state machine shows that a booking can move from `confirmed` to `cancelled` to `refunded`, but there is no direct arrow from `confirmed` to `refunded`. Why might the system enforce this two-step transition instead of allowing a single jump?

### Hands-On Exercise

**Exercise: Extend the State Machine for Partial Cancellations**

Many real-world booking platforms allow partial cancellations (e.g., cancelling one night of a three-night hotel stay). Modify the state machine diagram to add a `partially_cancelled` state. Then write pseudocode for a `partialCancel` method on `BookingService` that: (a) validates the cancellation request against the booking line items, (b) creates a hold release for only the cancelled portion, (c) initiates a partial refund, and (d) transitions the booking to the new state. Consider what happens if the partial refund fails -- should the booking remain in `confirmed` or move to `partially_cancelled`?

---

## 9. Payment & Accounting System

> **Learning Objectives**
> - Understand the dual nature of financial tracking: external payment flow (Stripe) and internal double-entry accounting
> - Read a chart of accounts and identify the purpose of each account category (assets, liabilities, revenue, expenses, equity)
> - Trace how a customer payment moves through clearing accounts into revenue via journal entries
> - Explain why immutability of posted accounting entries is enforced at the database level with triggers
> - Recognize common accounting mistakes such as mixing distinct economic events in a single journal entry and SQL injection in date filtering

**Why:** Financial operations require two levels of tracking: (1) the payment flow with external providers (Stripe), and (2) internal double-entry accounting for audit compliance. Every dollar must be traceable from customer payment through revenue recognition to supplier payout.

### 9.1 Chart of Accounts

```sql
-- Complete chart of accounts for the booking platform
CREATE TABLE chart_of_accounts (
    account_code VARCHAR(50) PRIMARY KEY,
    account_name VARCHAR(255) NOT NULL,
    account_type ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    parent_account VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    is_system_account BOOLEAN DEFAULT FALSE,
    currency CHAR(3) DEFAULT 'USD',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (parent_account) REFERENCES chart_of_accounts(account_code),
    INDEX idx_type (account_type),
    INDEX idx_parent (parent_account)
);

INSERT INTO chart_of_accounts (account_code, account_name, account_type, is_system_account) VALUES
-- Assets (1000-1999)
('1000', 'Cash and Cash Equivalents', 'asset', TRUE),
('1100', 'Accounts Receivable', 'asset', TRUE),
('1110', 'Customer Receivables', 'asset', TRUE),
('1200', 'Payment Gateway Clearing', 'asset', TRUE),
('1210', 'Stripe Clearing', 'asset', TRUE),
('1220', 'PayPal Clearing', 'asset', TRUE),
('1300', 'Prepaid Expenses', 'asset', TRUE),
-- Liabilities (2000-2999)
('2000', 'Accounts Payable', 'liability', TRUE),
('2100', 'Customer Deposits', 'liability', TRUE),
('2110', 'Unearned Revenue', 'liability', TRUE),
('2200', 'Supplier Payables', 'liability', TRUE),
('2210', 'Hotel Suppliers Payable', 'liability', TRUE),
('2220', 'Flight Suppliers Payable', 'liability', TRUE),
('2230', 'Car Rental Suppliers Payable', 'liability', TRUE),
('2300', 'Refunds Payable', 'liability', TRUE),
-- Revenue (4000-4999)
('4000', 'Operating Revenue', 'revenue', TRUE),
('4100', 'Booking Revenue', 'revenue', TRUE),
('4110', 'Hotel Booking Revenue', 'revenue', TRUE),
('4120', 'Flight Booking Revenue', 'revenue', TRUE),
('4130', 'Car Rental Revenue', 'revenue', TRUE),
('4200', 'Service Fees', 'revenue', TRUE),
('4210', 'Booking Fees', 'revenue', TRUE),
('4220', 'Cancellation Fees', 'revenue', TRUE),
-- Expenses (5000-5999)
('5000', 'Operating Expenses', 'expense', TRUE),
('5100', 'Cost of Sales', 'expense', TRUE),
('5110', 'Hotel Costs', 'expense', TRUE),
('5120', 'Flight Costs', 'expense', TRUE),
('5130', 'Car Rental Costs', 'expense', TRUE),
('5200', 'Payment Processing Fees', 'expense', TRUE),
('5210', 'Credit Card Fees', 'expense', TRUE),
('5220', 'PayPal Fees', 'expense', TRUE),
('5300', 'Refunds and Chargebacks', 'expense', TRUE),
-- Equity (3000-3999)
('3000', 'Shareholders Equity', 'equity', TRUE),
('3100', 'Retained Earnings', 'equity', TRUE);
```

### 9.2 Accounting Entries Tables

```sql
CREATE TABLE accounting_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_number VARCHAR(50) NOT NULL UNIQUE,
    entry_date DATE NOT NULL,
    entry_type ENUM('journal', 'payment', 'refund', 'adjustment') NOT NULL,
    booking_id BIGINT,
    transaction_id BIGINT,
    user_id BIGINT,
    description TEXT,
    is_posted BOOLEAN DEFAULT FALSE,
    posted_at TIMESTAMP NULL,
    posted_by BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by BIGINT,

    CONSTRAINT chk_posted_immutable CHECK (
        is_posted = FALSE OR
        (is_posted = TRUE AND posted_at IS NOT NULL)
    ),

    INDEX idx_booking (booking_id),
    INDEX idx_date (entry_date),
    INDEX idx_posted (is_posted, posted_at)
);

CREATE TABLE accounting_entry_lines (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT NOT NULL,
    line_number SMALLINT NOT NULL,
    account_code VARCHAR(50) NOT NULL,
    debit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(12,6) DEFAULT 1.000000,
    description TEXT,
    reference_type VARCHAR(50),
    reference_id BIGINT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (entry_id) REFERENCES accounting_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (account_code) REFERENCES chart_of_accounts(account_code),

    CONSTRAINT chk_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (debit_amount = 0 AND credit_amount > 0)
    ),

    INDEX idx_entry_line (entry_id, line_number),
    INDEX idx_account (account_code)
);
```

### 9.3 Balanced Entry Validation Trigger

```sql
DELIMITER //

CREATE TRIGGER validate_balanced_entry_before_post
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    DECLARE v_total_debit DECIMAL(12,2);
    DECLARE v_total_credit DECIMAL(12,2);

    -- Only validate when posting
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN

        SELECT SUM(debit_amount), SUM(credit_amount)
        INTO v_total_debit, v_total_credit
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;

        -- Fundamental accounting equation: Debits = Credits
        IF ABS(v_total_debit - v_total_credit) > 0.01 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = CONCAT(
                'Accounting entry is not balanced. ',
                'Debits: ', v_total_debit, ', ',
                'Credits: ', v_total_credit
            );
        END IF;

        IF (SELECT COUNT(*) FROM accounting_entry_lines WHERE entry_id = NEW.id) < 2 THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Accounting entry must have at least 2 lines (debit and credit)';
        END IF;

        SET NEW.posted_at = NOW();
    END IF;
END//

DELIMITER ;
```

> **Common Mistake: DECLARE After IF in MySQL Triggers**
> In MySQL stored programs, all `DECLARE` statements must appear at the very top of the `BEGIN` block, before any other statements including `IF`. Placing `DECLARE` after an `IF` causes a syntax error. The v2 trigger above correctly places both `DECLARE` statements before the `IF NEW.is_posted` check.

### 9.3.1 Immutability Triggers

Once an accounting entry is posted, it must **never** be modified or deleted — corrections are made via reversing journal entries. These triggers enforce immutability at the database level:

```sql
DELIMITER //

-- Prevent modification of posted entries
CREATE TRIGGER prevent_posted_entry_modification
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE AND NEW.id = OLD.id THEN
        -- Only allow the is_posted transition (FALSE -> TRUE), handled by balanced entry trigger
        IF OLD.is_posted = TRUE AND NEW.is_posted = TRUE THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Cannot modify a posted accounting entry. Create a reversing entry instead.';
        END IF;
    END IF;
END//

-- Prevent deletion of posted entries
CREATE TRIGGER prevent_posted_entry_deletion
BEFORE DELETE ON accounting_entries
FOR EACH ROW
BEGIN
    IF OLD.is_posted = TRUE THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Cannot delete a posted accounting entry. Create a reversing entry instead.';
    END IF;
END//

DELIMITER ;
```

### 9.3.2 Entry Number Generator

Entry numbers follow a deterministic format: `{type prefix}-{YYYYMMDD}-{sequence}`. The sequence resets daily and is generated atomically to avoid duplicates under concurrency:

```sql
-- Supporting sequence table
CREATE TABLE entry_number_sequences (
    entry_type VARCHAR(20) NOT NULL,
    entry_date DATE NOT NULL,
    next_sequence INT NOT NULL DEFAULT 1,
    PRIMARY KEY (entry_type, entry_date)
);
```

```typescript
  private async generateEntryNumber(entryType: string): Promise<string> {
    const prefix = entryType === 'payment' ? 'PAY' : 'JNL';
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Atomic increment using INSERT ... ON DUPLICATE KEY UPDATE
    await db.execute(`
      INSERT INTO entry_number_sequences (entry_type, entry_date, next_sequence)
      VALUES (?, CURDATE(), 2)
      ON DUPLICATE KEY UPDATE next_sequence = next_sequence + 1
    `, [entryType]);

    // Retrieve the sequence that was assigned
    const [rows] = await db.execute(`
      SELECT next_sequence - 1 AS seq
      FROM entry_number_sequences
      WHERE entry_type = ? AND entry_date = CURDATE()
    `, [entryType]);

    const seq = String(rows[0].seq).padStart(6, '0');
    return `${prefix}-${today}-${seq}`;
  }
```

### 9.4 Accounting Service

```typescript
// ============================================
// Double-Entry Accounting Service
// ============================================

export class AccountingService {

  async recordCustomerPayment(params: {
    bookingId: bigint;
    transactionId: bigint;
    amount: number;
    currency: string;
    paymentProvider: string;
  }): Promise<void> {

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      const entryNumber = await this.generateEntryNumber('payment');

      const [paymentResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, transaction_id, description, created_by
        ) VALUES (?, CURDATE(), 'payment', ?, ?, ?, ?)
      `, [entryNumber, params.bookingId, params.transactionId,
          `Customer payment received for booking ${params.bookingId}`, null]);

      const entryId = paymentResult.insertId;

      // Debit: Payment Gateway Clearing (Asset increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 1, ?, ?, 0, ?, ?, 'transaction', ?)
      `, [entryId, this.getPaymentGatewayAccount(params.paymentProvider),
          params.amount, params.currency,
          `Payment received via ${params.paymentProvider}`, params.transactionId]);

      // Credit: Customer Deposits (Liability increases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, currency,
          description, reference_type, reference_id
        ) VALUES (?, 2, '2100', 0, ?, ?, ?, 'booking', ?)
      `, [entryId, params.amount, params.currency,
          'Customer deposit for booking', params.bookingId]);

      // Post entry (triggers balanced validation)
      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [entryId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Revenue recognition -- split into TWO separate journal entries
   * for proper accounting treatment
   */
  async recognizeBookingRevenue(params: {
    bookingId: bigint;
    bookingType: string;
    amount: number;
    supplierCost: number;
  }): Promise<void> {

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // ==========================================
      // ENTRY 1: Revenue Recognition
      // Transfer from liability to revenue
      // ==========================================
      const revenueEntryNumber = await this.generateEntryNumber('journal');

      const [revenueResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, description
        ) VALUES (?, CURDATE(), 'journal', ?, ?)
      `, [revenueEntryNumber, params.bookingId,
          `Revenue recognition for ${params.bookingType} booking`]);

      const revenueEntryId = revenueResult.insertId;

      // Debit: Customer Deposits (Liability decreases)
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 1, '2100', ?, 0, 'Transfer from customer deposit')
      `, [revenueEntryId, params.amount]);

      // Credit: Booking Revenue (Revenue increases)
      const revenueAccount = this.getRevenueAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 2, ?, 0, ?, 'Booking revenue recognized')
      `, [revenueEntryId, revenueAccount, params.amount]);

      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [revenueEntryId]
      );

      // ==========================================
      // ENTRY 2: Cost Accrual
      // Record supplier cost as a separate economic event
      // ==========================================
      const costEntryNumber = await this.generateEntryNumber('journal');

      const [costResult] = await connection.execute(`
        INSERT INTO accounting_entries (
          entry_number, entry_date, entry_type,
          booking_id, description
        ) VALUES (?, CURDATE(), 'journal', ?, ?)
      `, [costEntryNumber, params.bookingId,
          `Cost accrual for ${params.bookingType} booking`]);

      const costEntryId = costResult.insertId;

      // Debit: Cost of Sales (Expense increases)
      const costAccount = this.getCostAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 1, ?, ?, 0, 'Supplier cost for booking')
      `, [costEntryId, costAccount, params.supplierCost]);

      // Credit: Supplier Payables (Liability increases)
      const payableAccount = this.getSupplierPayableAccount(params.bookingType);
      await connection.execute(`
        INSERT INTO accounting_entry_lines (
          entry_id, line_number, account_code,
          debit_amount, credit_amount, description
        ) VALUES (?, 2, ?, 0, ?, 'Amount owed to supplier')
      `, [costEntryId, payableAccount, params.supplierCost]);

      await connection.execute(
        'UPDATE accounting_entries SET is_posted = TRUE WHERE id = ?',
        [costEntryId]
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Get account balance with parameterized date filtering
   */
  async getAccountBalance(accountCode: string, asOfDate?: Date): Promise<number> {
    const queryParams: any[] = [accountCode];
    let dateFilter = '';

    if (asOfDate) {
      dateFilter = 'AND ae.entry_date <= ?';
      queryParams.push(asOfDate);
    }

    const [rows] = await db.execute(`
      SELECT
        SUM(ael.debit_amount) as total_debits,
        SUM(ael.credit_amount) as total_credits
      FROM accounting_entry_lines ael
      INNER JOIN accounting_entries ae ON ael.entry_id = ae.id
      WHERE ael.account_code = ?
      AND ae.is_posted = TRUE
      ${dateFilter}
    `, queryParams);

    const totalDebits = rows[0]?.total_debits || 0;
    const totalCredits = rows[0]?.total_credits || 0;

    const [accountInfo] = await db.execute(
      'SELECT account_type FROM chart_of_accounts WHERE account_code = ?',
      [accountCode]
    );

    const accountType = accountInfo[0]?.account_type;

    // Assets & Expenses: Debit balance (debits - credits)
    // Liabilities, Revenue & Equity: Credit balance (credits - debits)
    if (accountType === 'asset' || accountType === 'expense') {
      return totalDebits - totalCredits;
    }
    return totalCredits - totalDebits;
  }

  private getPaymentGatewayAccount(provider: string): string {
    const mapping: Record<string, string> = { stripe: '1210', paypal: '1220' };
    return mapping[provider.toLowerCase()] || '1200';
  }

  private getRevenueAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '4110', flight: '4120', car: '4130' };
    return mapping[bookingType.toLowerCase()] || '4100';
  }

  private getCostAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '5110', flight: '5120', car: '5130' };
    return mapping[bookingType.toLowerCase()] || '5100';
  }

  private getSupplierPayableAccount(bookingType: string): string {
    const mapping: Record<string, string> = { hotel: '2210', flight: '2220', car: '2230' };
    return mapping[bookingType.toLowerCase()] || '2200';
  }
}
```

> **Common Mistake: Mixing Revenue and Cost in One Journal Entry**
> An earlier version combined revenue recognition and cost accrual into a single 4-line journal entry. While the entry was technically balanced (debits = credits), it violated the accounting principle of separating distinct economic events. Revenue recognition (customer deposit -> revenue) and cost accrual (expense -> supplier payable) are independent transactions that may occur at different times and should be auditable separately.

> **Common Mistake: SQL Injection in Date Filtering**
> An earlier version of `getAccountBalance` interpolated the date directly into the SQL string: `` `AND ae.entry_date <= '${format(asOfDate, ...)}'` ``. This creates a SQL injection vulnerability. Always use parameterized queries (`?` placeholders) for all dynamic values, even dates.

### 9.5 Payment Processing Flow

```typescript
// ============================================
// Payment Service
// ============================================

export class PaymentService {

  async processPayment(params: PaymentParams): Promise<PaymentResult> {

    // Step 1: Fraud check (Section 24)
    const fraudCheck = await this.fraudService.checkTransaction({
      userId: params.userId,
      amount: params.amount,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    if (fraudCheck.status === 'blocked') {
      throw new FraudBlockedError('Transaction blocked by fraud detection');
    }

    // Step 2: Authorization (hold funds)
    const authorization = await this.authorizePayment(params);

    if (!authorization.success) {
      throw new PaymentDeclinedError(authorization.reason);
    }

    // Step 3: Record in payment ledger
    await this.ledgerService.recordAuthorization(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency, params.provider,
      authorization.providerTxnId
    );

    // Step 4: Capture (actually charge)
    const capture = await this.capturePayment(authorization.providerTxnId, params.amount);

    if (!capture.success) {
      await this.voidAuthorization(authorization.providerTxnId);
      throw new PaymentCaptureError(capture.reason);
    }

    // Step 5: Record capture in ledger
    await this.ledgerService.recordCapture(
      params.bookingId, authorization.transactionId,
      params.amount, params.currency
    );

    // Step 6: Update accounting
    await this.accountingService.recordCustomerPayment({
      bookingId: params.bookingId,
      transactionId: authorization.transactionId,
      amount: params.amount,
      currency: params.currency,
      paymentProvider: params.provider
    });

    return {
      success: true,
      transactionId: authorization.transactionId,
      providerTxnId: authorization.providerTxnId
    };
  }

  private async authorizePayment(params: PaymentParams): Promise<any> {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(params.amount * 100),  // cents
        currency: params.currency.toLowerCase(),
        payment_method: params.paymentMethodId,
        capture_method: 'manual',  // Authorization only
        metadata: {
          booking_id: params.bookingId.toString(),
          user_id: params.userId.toString()
        }
      });

      return {
        success: true,
        transactionId: await this.createTransactionRecord(params, paymentIntent.id),
        providerTxnId: paymentIntent.id
      };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }

  private async capturePayment(providerTxnId: string, amount: number): Promise<any> {
    try {
      await stripe.paymentIntents.capture(providerTxnId, {
        amount_to_capture: Math.round(amount * 100)
      });
      return { success: true };
    } catch (error) {
      return { success: false, reason: error.message };
    }
  }
}
```

### Key Takeaways

- The payment and accounting system operates on two distinct layers: the payment layer handles real-time interactions with external providers (Stripe), while the accounting layer records every financial movement as immutable double-entry journal entries for audit compliance.
- The chart of accounts uses a standardized numbering scheme (1000s for assets, 2000s for liabilities, 3000s for equity, 4000s for revenue, 5000s for expenses) with sub-accounts that map directly to booking types (hotel, flight, car rental).
- Database triggers enforce the fundamental accounting equation (debits = credits) at the moment an entry is posted, preventing unbalanced entries from ever reaching persistent storage.
- Immutability of posted entries is enforced at the database level through triggers that block UPDATE and DELETE operations; corrections are always made through reversing journal entries, preserving a complete audit trail.
- Revenue recognition and cost accrual are recorded as separate journal entries because they represent distinct economic events that may occur at different times and must be independently auditable.

### Review Questions

1. **Code-Reading:** In the `recordCustomerPayment` method, the debit goes to Payment Gateway Clearing (an asset account) and the credit goes to Customer Deposits (a liability account). Walk through why both sides of this entry increase: how does debiting an asset increase it, and how does crediting a liability increase it?
2. **Conceptual:** The `generateEntryNumber` method uses `INSERT ... ON DUPLICATE KEY UPDATE` to atomically increment a sequence counter. Why is this approach preferred over a simple `SELECT` followed by `UPDATE`? What concurrency problem would the two-step approach introduce?
3. **Code-Reading:** Examine the `getAccountBalance` method. It returns `totalDebits - totalCredits` for assets and expenses, but `totalCredits - totalDebits` for liabilities, revenue, and equity. Explain why this inversion is necessary by referencing the accounting equation `Assets = Liabilities + Equity`.

### Hands-On Exercise

**Exercise: Implement a Refund Journal Entry**

Write a `recordRefund` method on the `AccountingService` that handles a full refund for a booking. The method should create two journal entries: (1) a reversal of the original customer payment (debit Customer Deposits / credit Payment Gateway Clearing), and (2) a reversal of the revenue recognition (debit Booking Revenue / credit Customer Deposits). Use the existing `generateEntryNumber` method with `entry_type = 'refund'` for the first entry and `'journal'` for the second. Make sure both entries are posted within a single database transaction and that the balanced-entry validation trigger will accept them. Test your logic by tracing the account balances before and after the refund to confirm they net to zero for the refunded booking.

---

## 10. Notification Service

> **Learning Objectives**
> - Understand how the notification service decouples delivery from booking logic by consuming events from Kafka
> - Identify the three notification channels (email, SMS, push) and how user preferences control which channels are used
> - Recognize the role of templates in rendering channel-specific content from a single event payload
> - Learn how `Promise.allSettled` enables parallel delivery across channels without one failure blocking the others
> - Understand how failed deliveries are routed to a retry queue (Dead Letter Queue) for reliable eventual delivery

**Why:** Users need immediate confirmation when they book, reminders before check-in, and alerts on changes. The notification service consumes events from Kafka (published via the Outbox Pattern) and delivers them through multiple channels.

### 10.1 Multi-Channel Notification Service

```typescript
// ============================================
// Notification Service - Kafka Consumer
// ============================================

export class NotificationService {
  private readonly providers = {
    email: new SESEmailProvider(),
    sms: new TwilioSMSProvider(),
    push: new FCMPushProvider()
  };

  async startConsumer(): Promise<void> {
    await kafka.subscribe({ topic: 'notification-events', fromBeginning: false });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        await this.processNotification(event);
      }
    });
  }

  private async processNotification(event: NotificationEvent): Promise<void> {
    const user = await this.userService.getById(event.userId);
    const preferences = await this.getPreferences(event.userId);
    const template = this.getTemplate(event.type);

    const rendered = template.render({
      userName: user.name,
      ...event.data
    });

    // Send through preferred channels
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

    // Log delivery results
    for (const result of results) {
      if (result.status === 'rejected') {
        // Failed deliveries go to DLQ for retry (Section 21)
        await this.writeToRetryQueue(event, result.reason);
      }
    }
  }

  private getTemplate(type: string): NotificationTemplate {
    const templates: Record<string, NotificationTemplate> = {
      'booking.created': new BookingConfirmationTemplate(),
      'booking.cancelled': new BookingCancellationTemplate(),
      'booking.reminder': new CheckInReminderTemplate(),
      'payment.refunded': new RefundConfirmationTemplate()
    };
    return templates[type] || new GenericTemplate();
  }
}
```

### Key Takeaways

- The notification service is fully decoupled from the booking and payment services; it reacts to domain events consumed from Kafka rather than being called directly, which means booking latency is never affected by notification delivery times.
- User preferences gate which channels receive notifications, and `Promise.allSettled` ensures that a failure in one channel (e.g., an invalid push token) does not prevent delivery through the remaining channels.
- Templates map event types to channel-specific renderings (HTML for email, plain text for SMS, title/body for push), keeping presentation logic separated from delivery infrastructure.
- Failed deliveries are not silently dropped; they are written to a retry queue (Dead Letter Queue, covered in Section 21) so that transient failures (e.g., Twilio rate limits, SES throttling) are eventually resolved.
- The consumer subscribes with `fromBeginning: false`, meaning it only processes new events from the point of subscription onward, avoiding reprocessing the entire event history on service restart.

### Review Questions

1. **Conceptual:** The notification service subscribes to Kafka with `fromBeginning: false`. What would happen if you changed this to `fromBeginning: true` after the service had been running in production for six months? What safeguards would you need to add to avoid sending duplicate or outdated notifications?
2. **Code-Reading:** The `processNotification` method passes `preferences.email && this.providers.email.send(...)` into the `Promise.allSettled` array. What value does JavaScript evaluate this expression to when `preferences.email` is `false`? Does `Promise.allSettled` handle that value correctly, or could it cause a runtime error?
3. **Conceptual:** Why does the notification service use `Promise.allSettled` instead of `Promise.all`? Describe a concrete scenario where using `Promise.all` would cause a user to miss a notification they should have received.

### Hands-On Exercise

**Exercise: Add a Webhook Notification Channel**

Extend the `NotificationService` to support a fourth channel: webhooks. Many business customers integrate booking platforms with their own systems (e.g., a corporate travel dashboard) via webhook callbacks. Implement a `WebhookProvider` class that POSTs the rendered notification payload to a URL stored in the user's preferences. Your implementation should: (a) include a configurable timeout (default 5 seconds) to avoid blocking the consumer, (b) include an HMAC signature header so the receiver can verify authenticity, (c) treat any non-2xx response as a failure that routes to the retry queue, and (d) integrate into the existing `Promise.allSettled` array alongside email, SMS, and push. Write the provider class and show the modifications to `processNotification`.

---
# PART III: DISTRIBUTED SYSTEMS PATTERNS

In a single-server application, failures are binary: the process is running or it is not. Distributed systems introduce a third, far more dangerous state -- partial failure. A payment service might have charged the customer while the inventory service never received the hold request. A lock might expire while the service holding it is stuck in a garbage collection pause. Two regions might simultaneously accept the last available room. These are not edge cases; at 100,000 bookings per minute across four global regions, they are certainties.

Part II showed the happy path. This part shows what happens when networks partition, services crash, and locks expire. The patterns in Sections 11 through 16 are the defensive infrastructure that prevents data corruption, ensures exactly-once semantics, and keeps the system consistent across continents. Each pattern addresses a specific failure mode: fencing tokens prevent stale writes after lock expiry, idempotency keys prevent duplicate processing after retries, the outbox pattern prevents lost events after crashes, sagas coordinate multi-service transactions with rollback capabilities, and CQRS separates read and write paths so neither becomes the bottleneck.

These patterns are not independent -- they compose into a layered defense. The outbox pattern (Section 14) relies on the same database transactions used by idempotent booking creation (Section 12). The saga orchestrator (Section 15) uses fencing tokens from Section 11 and publishes events through the outbox from Section 14. CQRS (Section 16) consumes the events that every other pattern produces. Understanding how these pieces interlock is as important as understanding each pattern individually.

---

## 11. Distributed Locking & Fencing Tokens

> **Learning Objectives**
> - Understand why distributed locks alone are insufficient to prevent race conditions in inventory reservations.
> - Explain how fencing tokens provide a monotonically increasing guard against stale writes after lock expiry.
> - Implement database-level fencing token enforcement using SQL `WHERE` clauses.
> - Trace through a timeline where a GC pause causes lock expiry and demonstrate how fencing tokens reject the stale write.

**Why:** Prevent race conditions in inventory reservations across multiple servers. When two booking requests arrive simultaneously for the last available room, only one should succeed. Distributed locks alone aren't sufficient -- if a lock expires while a service is still processing, two services may both think they hold the lock. Fencing tokens solve this by giving each lock acquisition a monotonically increasing number that the database uses to reject stale writes.

### 11.1 Fenced Redlock Implementation

```typescript
// ============================================
// Fenced Redlock Implementation
// ============================================

import Redlock from 'redlock';
import Redis from 'ioredis';

export class FencedRedlockService {
  private redlock: Redlock;
  private fencingCounter: Redis;

  constructor() {
    // Multiple Redis instances for quorum-based consensus
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

    // Separate Redis for fencing tokens (single source of truth)
    this.fencingCounter = new Redis({
      host: 'redis-fencing.cluster.local'
    });
  }

  /**
   * Acquire lock with monotonically increasing fencing token
   */
  async acquireLockWithFencing(
    resourceKey: string,
    ttlMs: number = 10000
  ): Promise<{ lock: Redlock.Lock; fencingToken: number } | null> {

    try {
      // Step 1: Acquire distributed lock across Redis quorum
      const lock = await this.redlock.acquire([resourceKey], ttlMs);

      // Step 2: Get fencing token (atomic increment -- guaranteed monotonic)
      const fencingToken = await this.fencingCounter.incr(`fence:${resourceKey}`);

      // Step 3: Store active token with TTL matching the lock
      await this.fencingCounter.set(
        `fence:active:${resourceKey}`,
        fencingToken,
        'EX',
        Math.ceil(ttlMs / 1000)
      );

      return { lock, fencingToken };

    } catch (error) {
      // Lock acquisition failed -- resource is locked by another process
      return null;
    }
  }

  /**
   * Release lock with token verification
   */
  async releaseLock(
    resourceKey: string,
    lock: Redlock.Lock,
    fencingToken: number
  ): Promise<boolean> {

    // Verify this token is still the active one
    const currentToken = await this.fencingCounter.get(
      `fence:active:${resourceKey}`
    );

    if (currentToken && parseInt(currentToken) !== fencingToken) {
      console.warn(`Fencing token mismatch. Lock may have been superseded.`);
      return false;
    }

    await lock.release();
    return true;
  }
}
```

### 11.2 Database-Level Fencing Token Enforcement

The fencing token check happens in the database `WHERE` clause, not in application code. This means even if two services bypass distributed locking, the database itself rejects stale writes:

```sql
-- Inventory update with fencing token check
-- Only succeeds if our token is higher than the stored one
UPDATE inventory
SET available_quantity = available_quantity - ?,
    reserved_quantity = reserved_quantity + ?,
    fencing_token = ?,
    updated_at = NOW()
WHERE resource_type = ?
AND resource_id = ?
AND resource_date = ?
AND available_quantity >= ?
AND (fencing_token IS NULL OR fencing_token < ?);

-- If affectedRows === 0, either:
-- 1. Not enough inventory (available_quantity < requested)
-- 2. Stale fencing token (another process already wrote a higher token)
-- Both are safe rejections
```

### 11.3 Why Fencing Tokens, Not Just Locks

```
Timeline showing why locks alone fail:

Service A: [--- acquires lock at T=0 ---]
           [--- GC pause at T=8s ---> lock expires at T=10s ---]
           [--- resumes, writes to DB at T=12s ---] <- STALE WRITE!

Service B:              [--- acquires same lock at T=10s ---]
                        [--- writes to DB at T=11s ---]

With fencing tokens:
Service A gets token=42, Service B gets token=43

At T=11s: DB has fencing_token=43 (from Service B)
At T=12s: Service A tries to write with token=42
          WHERE fencing_token < 42 -> FALSE (43 is not < 42)
          affectedRows = 0 -> Write rejected safely
```

### Key Takeaways

- Distributed locks have a fundamental flaw: they can expire while the holder is still processing (due to GC pauses, network delays, or slow I/O), allowing two services to believe they hold the lock simultaneously.
- Fencing tokens are monotonically increasing numbers assigned at lock acquisition time. The database uses them in `WHERE` clauses to reject any write carrying a token lower than the one already stored.
- The safety guarantee lives in the database, not the application. Even if application-level lock checks fail, the SQL `WHERE fencing_token < ?` clause serves as the last line of defense.
- Redlock provides quorum-based consensus across multiple Redis instances, but it only solves lock *acquisition* -- fencing tokens solve the stale *write* problem after expiry.

### Review Questions

1. In the `acquireLockWithFencing` method, why is the fencing token stored in a *separate* Redis instance from the Redlock quorum nodes? What would happen if the fencing counter shared a Redis instance that went down?
2. The SQL update uses `AND (fencing_token IS NULL OR fencing_token < ?)`. Why is the `IS NULL` check necessary? Under what circumstance would the fencing token column be NULL?
3. In the timeline diagram (Section 11.3), Service A resumes after a GC pause and writes at T=12s. Suppose the system used only distributed locks (no fencing tokens) and Service A checked `lock.isValid()` before writing. Would this prevent the stale write? Why or why not?

### Hands-On Exercise

**Exercise: Simulate a Fencing Token Race Condition**

Write a test that simulates the GC-pause scenario from Section 11.3. Create two async functions representing Service A and Service B. Service A acquires a lock and fencing token, then sleeps for longer than the lock TTL (simulating a GC pause). Service B acquires the same lock after expiry and writes to a mock inventory table. When Service A wakes up and attempts its write, assert that the write is rejected (affectedRows === 0) because Service B's higher fencing token is already stored. Use an in-memory object or SQLite table as your mock database, and implement the `WHERE fencing_token < ?` check in your mock update function.

---

## 12. Idempotency & Exactly-Once Processing

> **Learning Objectives**
> - Explain why idempotency is essential in distributed systems where retries, duplicate requests, and network failures are routine.
> - Implement deterministic idempotency key generation from booking parameters so that duplicate requests produce the same key.
> - Handle race conditions where two identical requests arrive simultaneously using database duplicate-entry detection.
> - Apply idempotency at the API gateway level to cache and replay responses for repeated requests.

**Why:** Networks are unreliable. Users double-click buttons. Services retry failed requests. Without idempotency, the same booking could be created twice, the same payment charged twice, or the same inventory reserved twice. Idempotency keys ensure that repeating an operation produces the same result as doing it once.

### 12.1 Idempotent Booking Creation

```typescript
// ============================================
// Idempotent Booking Creation
// ============================================

export class BookingService {

  async createBooking(dto: CreateBookingDto): Promise<Booking> {

    // Generate deterministic idempotency key from booking parameters
    const idempotencyKey = dto.idempotencyKey || this.generateIdempotencyKey(dto);

    // Check if booking already exists for this key
    const existingBooking = await this.findByIdempotencyKey(
      dto.userId,
      idempotencyKey
    );

    if (existingBooking) {
      // Return existing booking -- idempotent response
      return existingBooking;
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Create booking with idempotency key
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
      await this.createSubTypeRecord(connection, bookingId, dto);

      // Write event to outbox (Section 14)
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

      // Handle race condition: another request created the booking
      if (error.code === 'ER_DUP_ENTRY') {
        return this.findByIdempotencyKey(dto.userId, idempotencyKey);
      }

      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Generate deterministic key from booking parameters.
   * Same user + same resource + same time window = same key.
   */
  private generateIdempotencyKey(dto: CreateBookingDto): string {
    const payload = {
      userId: dto.userId,
      resourceId: dto.resourceId,
      checkIn: dto.checkIn?.toISOString(),
      checkOut: dto.checkOut?.toISOString(),
      timestamp: Math.floor(Date.now() / 60000)  // Same minute
    };

    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
      .substring(0, 32);
  }
}
```

### 12.2 Idempotency at the API Gateway Level

```typescript
// Middleware to handle idempotency keys for all POST/PUT requests

export class IdempotencyMiddleware {
  async handle(req: Request, res: Response, next: NextFunction) {
    const idempotencyKey = req.headers['idempotency-key'] as string;

    if (!idempotencyKey) {
      return next(); // Let the service handle it
    }

    // Check Redis for cached response
    const cached = await redis.get(`idempotency:${idempotencyKey}`);

    if (cached) {
      const { statusCode, body } = JSON.parse(cached);
      return res.status(statusCode).json(body);
    }

    // Intercept the response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Cache successful responses for 24 hours
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.setex(
          `idempotency:${idempotencyKey}`,
          86400,
          JSON.stringify({ statusCode: res.statusCode, body })
        );
      }
      return originalJson(body);
    };

    next();
  }
}
```

### Key Takeaways

- Idempotency operates at two levels: the service level (deterministic key generation from booking parameters, database unique constraints) and the API gateway level (caching full HTTP responses keyed by an `Idempotency-Key` header).
- Deterministic key generation using a SHA-256 hash of user, resource, dates, and a one-minute time window means that even if the client does not send an idempotency key, the system can detect duplicate intent.
- The `ER_DUP_ENTRY` catch block handles the race condition where two identical requests pass the initial `findByIdempotencyKey` check simultaneously -- the database unique constraint is the final arbiter.
- The outbox event write inside the same transaction (line referencing Section 14) shows how idempotency and the outbox pattern compose: the booking and its event are created atomically, and the idempotency key prevents duplicate events.

### Review Questions

1. The `generateIdempotencyKey` method includes `Math.floor(Date.now() / 60000)` in the hash payload. What is the effect of this one-minute window? What would happen if the timestamp granularity were one second instead? What if it were removed entirely?
2. In the `IdempotencyMiddleware`, only successful responses (status 200-299) are cached. Why is it important *not* to cache error responses? Consider a scenario where a transient database error causes a 500 response -- what would happen if that response were cached for 24 hours?
3. Walk through the code path when two identical `createBooking` requests arrive within the same millisecond. Both pass the `findByIdempotencyKey` check (no existing booking found). What happens next, and how does the system ensure only one booking is created?

### Hands-On Exercise

**Exercise: Build an Idempotency Middleware**

Implement a simplified version of the `IdempotencyMiddleware` using an in-memory `Map` instead of Redis. Write an Express route `POST /bookings` that accepts an `Idempotency-Key` header. On the first request with a given key, process the booking and store the response in your map. On subsequent requests with the same key, return the cached response without processing. Write three test cases: (1) first request creates a booking and returns 201, (2) second request with the same key returns the cached 201 without creating a duplicate, and (3) a request with a different key creates a new booking. Verify that your in-memory store contains exactly two entries after all three requests.

---

## 13. Multi-Region Conflict Resolution

> **Learning Objectives**
> - Analyze the CAP theorem tradeoffs made by this system (AP over CP) and articulate why availability is prioritized for a global booking platform.
> - Trace the full lifecycle of a cross-region inventory conflict: local reservation, global event publication, conflict detection, and deterministic resolution via fencing token ordering.
> - Explain why treating a consensus timeout as success is dangerous and how post-timeout verification corrects this.
> - Describe the regional partitioning strategy that minimizes cross-region conflicts by routing reservations to a resource's "home region."

**Why:** With four active regions processing bookings independently, two users in different regions may try to book the same last room simultaneously. The system must detect and resolve these conflicts deterministically. This section describes the global event stream architecture and explains the CAP theorem tradeoffs.

### 13.1 CAP Theorem Tradeoff

This system chooses **AP (Availability + Partition tolerance)** over strict consistency:

- Each region can accept bookings independently (availability)
- Conflicts are detected and resolved asynchronously within seconds
- During a network partition between regions, bookings continue locally
- A small window (2-3 seconds) exists where double-booking is theoretically possible
- Conflicts are resolved deterministically using fencing token ordering

### 13.2 Global Event Stream Architecture

```typescript
// ============================================
// Multi-Region Inventory Synchronization
// ============================================

export class MultiRegionInventoryService {
  private readonly region = process.env.REGION;

  async reserveInventory(params: ReservationParams): Promise<ReservationResult> {

    // Step 1: Acquire local distributed lock
    const lockKey = this.getInventoryLockKey(
      params.resourceType, params.resourceId, params.resourceDate
    );
    const lockResult = await this.fencedLockService.acquireLockWithFencing(
      lockKey, 10000
    );

    if (!lockResult) {
      throw new ConflictError('Resource is locked');
    }

    const { lock, fencingToken } = lockResult;

    try {
      // Step 2: Reserve locally (with fencing token in DB WHERE clause)
      const localReservation = await this.reserveLocally(params, fencingToken);

      if (!localReservation.success) {
        return localReservation;
      }

      // Step 3: Publish to global Kafka topic (via outbox -- Section 14)
      await this.writeOutboxEvent('inventory_reservation',
        localReservation.reservationId, 'inventory.reserved', {
          reservationId: localReservation.reservationId,
          region: this.region,
          fencingToken,
          ...params,
          timestamp: Date.now()
        }
      );

      // Step 4: Wait for conflict detection window
      const consensus = await this.waitForGlobalConsensus(
        localReservation.reservationId, 2000
      );

      if (!consensus.success) {
        await this.rollbackReservation(localReservation.reservationId);

        return {
          success: false,
          reason: consensus.reason,
          conflictingRegion: consensus.conflictingRegion
        };
      }

      return localReservation;

    } finally {
      await this.fencedLockService.releaseLock(lockKey, lock, fencingToken);
    }
  }

  /**
   * Wait for global consensus with proper timeout handling.
   *
   * IMPORTANT: A timeout does NOT mean consensus was achieved.
   * It means we couldn't verify -- this is ambiguous and must be
   * treated as potentially conflicting.
   */
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

        // Timeout is AMBIGUOUS -- not a success signal.
        // A network partition could be hiding a conflict.
        // We must verify before confirming.
        this.verifyNoConflictExists(reservationId).then((verified) => {
          if (verified) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              reason: 'timeout_ambiguous'
            });
          }
        }).catch(() => {
          resolve({
            success: false,
            reason: 'verification_failed'
          });
        });
      }, timeoutMs);

      // Listen for conflict notifications via Redis pub/sub
      const subscriber = redis.duplicate();

      subscriber.subscribe(`conflicts:${reservationId}`, (err) => {
        if (err) {
          clearTimeout(timeout);
          subscriber.quit();  // Clean up subscriber on error
          resolve({ success: false, reason: 'subscription_error' });
        }
      });

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

  /**
   * Post-timeout verification: Check if any other region reserved
   * the same resource during our timeout window.
   */
  private async verifyNoConflictExists(reservationId: bigint): Promise<boolean> {
    const [reservation] = await db.execute(`
      SELECT resource_type, resource_id, resource_date, fencing_token
      FROM inventory_reservations WHERE id = ?
    `, [reservationId]);

    if (reservation.length === 0) return false;

    const res = reservation[0];

    // Check if inventory fencing token matches ours
    const [inventory] = await db.execute(`
      SELECT fencing_token FROM inventory
      WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
    `, [res.resource_type, res.resource_id, res.resource_date]);

    // If our fencing token is still the latest, no conflict occurred
    return inventory[0]?.fencing_token === res.fencing_token;
  }
}
```

> **Common Mistake: Treating Timeout as Success**
> An earlier version of `waitForGlobalConsensus` resolved the timeout as `{ success: true }`, assuming that no conflict notification within 2 seconds meant consensus was achieved. This is dangerous: during a network partition, the conflict notification from another region might simply not arrive. The correct behavior is to treat timeout as ambiguous and verify by checking whether our fencing token is still the latest in the database.

### 13.3 Conflict Detection Consumer

```typescript
// ============================================
// Kafka Consumer for Cross-Region Conflict Detection
// ============================================

export class ConflictDetectionConsumer {
  private readonly region = process.env.REGION;

  async start(): Promise<void> {
    await kafka.subscribe({
      topic: 'inventory-reservations-global',
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        const sourceRegion = message.headers['source-region'].toString();

        // Skip events from our own region
        if (sourceRegion === this.region) return;

        // Check for conflicting local reservation
        const localReservation = await this.findLocalReservation(
          event.resourceType, event.resourceId, event.resourceDate
        );

        if (!localReservation) return; // No conflict

        // Conflict resolution: higher fencing token wins
        if (event.fencingToken > localReservation.fencingToken) {
          // Remote wins -- rollback local
          await this.rollbackReservation(localReservation.id);

          // Notify local process that its reservation lost
          await redis.publish(
            `conflicts:${localReservation.id}`,
            JSON.stringify({
              region: sourceRegion,
              reservationId: event.reservationId,
              fencingToken: event.fencingToken
            })
          );
        } else {
          // Local wins -- notify remote region to rollback
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

### 13.4 Regional Partitioning Strategy

To minimize cross-region conflicts, each resource has a "home region" where most inventory decisions are routed:

```typescript
export const inventoryPartitioningStrategy = {

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
      // User in home region -- reserve locally
      return await inventoryService.reserveInventory(params);
    } else {
      // Forward to home region for reduced conflict probability
      return await this.forwardToHomeRegion(homeRegion, params);
    }
  }
};
```

### Key Takeaways

- The system chooses AP (Availability + Partition tolerance) over strict consistency, meaning each region can accept bookings independently even during network partitions, with conflicts resolved asynchronously within a 2-3 second window.
- Conflict resolution is deterministic: the reservation with the higher fencing token always wins. This eliminates ambiguity and ensures all regions converge to the same outcome regardless of message ordering.
- Treating a consensus timeout as success is a critical mistake. A network partition can silently prevent conflict notifications from arriving. The correct approach is to treat timeout as ambiguous and verify by checking the database for the latest fencing token.
- Regional partitioning (assigning each resource a "home region" via `resourceId % 4`) reduces conflict probability by routing most inventory decisions to a single region, falling back to cross-region coordination only when the user is not in the home region.
- The conflict detection consumer skips events from its own region (`if (sourceRegion === this.region) return`), since intra-region conflicts are already handled by the local distributed lock.

### Review Questions

1. The system uses an AP design where a 2-3 second double-booking window exists. Under what business conditions would this tradeoff be unacceptable? If you needed to switch to a CP design, which components would change and what availability would you sacrifice?
2. In the `ConflictDetectionConsumer`, the conflict resolution rule is "higher fencing token wins." Why is this deterministic? Could two regions ever produce the same fencing token for the same resource, and if so, how would you break the tie?
3. Read the `verifyNoConflictExists` method. It checks whether the inventory table's `fencing_token` still matches the reservation's token. Explain a scenario where this check returns `false` even though no actual double-booking occurred (a false positive). What is the consequence of a false positive versus a false negative?

### Hands-On Exercise

**Exercise: Simulate Cross-Region Conflict Detection**

Build a simplified simulation of two regions competing for the same resource. Create two instances of a `RegionSimulator` class, each with its own in-memory inventory table and a shared message bus (use an EventEmitter). Each region should: (1) reserve inventory locally with a fencing token, (2) publish the reservation to the shared bus, and (3) listen for reservations from the other region. When a conflict is detected, the lower fencing token loses and rolls back. Run the simulation 100 times with randomized timing and assert that exactly one reservation survives in every run. Log the winning region and fencing token for each run.

---

## 14. Outbox Pattern & Reliable Messaging

> **Learning Objectives**
> - Identify the dual-write problem in event-driven architectures and explain why publishing to Kafka after a database commit is unsafe.
> - Describe how the outbox pattern eliminates the dual-write problem by writing events to an outbox table within the same database transaction as business data.
> - Read and understand the polling-based outbox publisher, including its use of `FOR UPDATE SKIP LOCKED` for concurrent publisher instances.
> - Explain the cleanup and retry strategies that prevent the outbox table from growing indefinitely and recover from transient publish failures.

**Why:** The biggest reliability gap in event-driven architectures is the dual-write problem. If we commit to the database and then publish to Kafka, the application might crash between the two operations -- the database has the data but Kafka never gets the event. The Outbox Pattern solves this by writing events to an outbox table in the same database transaction as the business data, then publishing them to Kafka asynchronously.

### 14.1 How the Outbox Pattern Works

```
Without Outbox (dangerous):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)      -- DB commit succeeds
  3. COMMIT
  4. kafka.send('booking.created')   -- App crashes here = Event LOST

With Outbox (safe):
  1. BEGIN TRANSACTION
  2. INSERT INTO bookings (...)
  3. INSERT INTO outbox_events (...)  -- Written in SAME transaction
  4. COMMIT                          -- Both succeed or both fail
  5. [Outbox Publisher reads outbox_events and publishes to Kafka]
  6. [Publisher marks event as 'published']
```

### 14.2 Outbox Publisher Service

```typescript
// ============================================
// Outbox Publisher - Polling-based CDC
// ============================================

export class OutboxPublisherService {
  private readonly pollIntervalMs = 100; // Poll every 100ms
  private readonly batchSize = 100;
  private running = false;

  async start(): Promise<void> {
    this.running = true;

    while (this.running) {
      const published = await this.publishBatch();

      if (published === 0) {
        // No events to publish -- wait before next poll
        await this.sleep(this.pollIntervalMs);
      }
      // If we published events, immediately check for more
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async publishBatch(): Promise<number> {
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Select pending events with row-level locking
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
        await connection.rollback();
        return 0;
      }

      // Build Kafka messages grouped by topic
      const messagesByTopic = new Map<string, any[]>();

      for (const event of events) {
        if (!messagesByTopic.has(event.topic)) {
          messagesByTopic.set(event.topic, []);
        }
        messagesByTopic.get(event.topic).push({
          key: event.partition_key,
          value: JSON.stringify({
            eventId: event.id,
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

      // Publish to Kafka
      for (const [topic, messages] of messagesByTopic) {
        await kafka.send({ topic, messages });
      }

      // Mark events as published
      const eventIds = events.map(e => e.id);
      await connection.execute(`
        UPDATE outbox_events
        SET status = 'published', published_at = NOW()
        WHERE id IN (${eventIds.map(() => '?').join(',')})
      `, eventIds);

      await connection.commit();
      return events.length;

    } catch (error) {
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

### 14.3 Outbox Cleanup Job

```sql
-- Clean up published events older than 7 days
CREATE EVENT cleanup_outbox_events
ON SCHEDULE EVERY 1 HOUR
DO
  DELETE FROM outbox_events
  WHERE status = 'published'
  AND published_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
  LIMIT 10000;

-- Retry failed events (up to max_retries)
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

### Key Takeaways

- The dual-write problem is the most common reliability gap in event-driven architectures: if the application crashes between committing to the database and publishing to Kafka, the event is lost permanently.
- The outbox pattern eliminates this gap by writing both the business data and the event into the same database transaction. The event is stored in an `outbox_events` table and published asynchronously by a separate polling process.
- `FOR UPDATE SKIP LOCKED` allows multiple outbox publisher instances to run concurrently without blocking each other -- each instance picks up a different batch of pending events.
- The cleanup job prevents unbounded table growth by deleting published events older than 7 days, and the retry job recovers from transient failures by resetting failed events back to `pending` with exponential backoff.

### Review Questions

1. In the `publishBatch` method, the publisher selects events, publishes to Kafka, and then marks them as published -- all within a single database transaction. What happens if the Kafka publish succeeds but the database `UPDATE` (marking as published) fails due to a connection error? Will the event be published twice? How does the consumer handle this?
2. The cleanup job uses `LIMIT 10000` when deleting old events. Why is a limit necessary for a DELETE operation? What could happen to the database if the limit were removed and millions of rows matched the WHERE clause?
3. Compare the outbox pattern with Change Data Capture (CDC) using a tool like Debezium. What are the tradeoffs? In what scenarios would you prefer CDC over the polling-based outbox publisher shown here?

### Hands-On Exercise

**Exercise: Implement a Minimal Outbox Publisher**

Using SQLite (or any embedded database) and a mock Kafka producer (a simple array that collects messages), implement the outbox pattern end-to-end. Create a `createBooking` function that inserts a booking row and an outbox event row in the same transaction. Create an `OutboxPublisher` that polls the outbox table every 500ms, reads pending events, pushes them to your mock Kafka array, and marks them as published. Write a test that: (1) creates 10 bookings, (2) starts the publisher, (3) waits 2 seconds, and (4) asserts that the mock Kafka array contains exactly 10 events and the outbox table has 10 rows with status `published`. Then simulate a crash by having the publisher throw an error after publishing but before marking as published -- verify that the events are re-published on the next poll cycle (demonstrating at-least-once delivery).

---

## 15. Saga Pattern & Distributed Transactions

> **Learning Objectives**
> - Explain why traditional ACID transactions cannot span multiple services and why the saga pattern is the standard alternative.
> - Read the saga state machine diagram and trace the compensation path when a step fails (e.g., payment fails after inventory is held).
> - Understand the orchestrator implementation: how it executes steps sequentially, persists saga state for crash recovery, and runs compensating transactions in reverse order.
> - Identify what happens when a compensation itself fails and how the dead letter queue provides a manual resolution path.

**Why:** The booking flow spans multiple services (inventory, payment, notification). Traditional ACID transactions can't span services. The Saga pattern breaks a distributed transaction into local transactions, each with a compensating action that undoes its effect if a later step fails.

### 15.1 Booking Saga State Machine

```
                    +------------------+
                    |  SAGA_STARTED    |
                    +--------+---------+
                             |
                    +--------v---------+     +-------------------+
                    | INVENTORY_HELD   |---->| INVENTORY_FAILED  |
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+     +-------------------+
                    | PAYMENT_CHARGED  |---->|  PAYMENT_FAILED   |--> Release Hold
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+     +-------------------+
                    |BOOKING_CONFIRMED |---->| BOOKING_FAILED    |--> Refund + Release
                    +--------+---------+     +-------------------+
                             |
                    +--------v---------+
                    |  SAGA_COMPLETE   |
                    +------------------+
```

### 15.2 Saga Orchestrator

```typescript
// ============================================
// Booking Saga Orchestrator
// ============================================

interface SagaStep {
  name: string;
  execute: (context: SagaContext) => Promise<void>;
  compensate: (context: SagaContext) => Promise<void>;
}

interface SagaContext {
  bookingDto: CreateBookingDto;
  holdId?: bigint;
  paymentId?: bigint;
  bookingId?: bigint;
  sagaId: string;
  currentStep: number;
  status: string;
}

export class BookingSagaOrchestrator {

  private readonly steps: SagaStep[] = [
    {
      name: 'HOLD_INVENTORY',
      execute: async (ctx) => {
        const hold = await this.inventoryService.createHold({
          resourceType: ctx.bookingDto.resourceType,
          resourceId: ctx.bookingDto.resourceId,
          resourceDate: ctx.bookingDto.date,
          quantity: ctx.bookingDto.quantity,
          userId: ctx.bookingDto.userId,
          sessionId: ctx.bookingDto.sessionId,
          ttlSeconds: 600
        });
        ctx.holdId = hold.id;
      },
      compensate: async (ctx) => {
        if (ctx.holdId) {
          await this.inventoryService.releaseHold(
            ctx.holdId, 'Saga compensation', 'saga-orchestrator'
          );
        }
      }
    },
    {
      name: 'PROCESS_PAYMENT',
      execute: async (ctx) => {
        // NOTE: At this stage the booking doesn't exist yet -- the payment
        // is authorized against the *holdId* (not a bookingId). The booking
        // record will be created in the CONFIRM_BOOKING step below.
        const payment = await this.paymentService.processPayment({
          userId: ctx.bookingDto.userId,
          amount: ctx.bookingDto.totalAmount,
          currency: ctx.bookingDto.currency,
          paymentMethod: ctx.bookingDto.paymentMethod,
          holdId: ctx.holdId  // Reference the hold, not a booking
        });
        ctx.paymentId = payment.transactionId;
      },
      compensate: async (ctx) => {
        if (ctx.paymentId) {
          await this.paymentService.refundPayment(ctx.paymentId, 'Saga rollback');
        }
      }
    },
    {
      name: 'CONFIRM_BOOKING',
      execute: async (ctx) => {
        const booking = await this.bookingService.createAndConfirmBooking(
          ctx.bookingDto, ctx.paymentId
        );
        ctx.bookingId = booking.id;
        await this.inventoryService.confirmHold(ctx.holdId, booking.id);
      },
      compensate: async (ctx) => {
        if (ctx.bookingId) {
          await this.bookingService.cancelBooking(ctx.bookingId, 'Saga rollback');
        }
      }
    }
  ];

  async executeSaga(dto: CreateBookingDto): Promise<SagaResult> {
    const context: SagaContext = {
      bookingDto: dto,
      sagaId: randomUUID(),
      currentStep: 0,
      status: 'STARTED'
    };

    // Persist saga state for recovery
    await this.saveSagaState(context);

    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      context.currentStep = i;
      context.status = step.name;
      await this.saveSagaState(context);

      try {
        await step.execute(context);
      } catch (error) {
        // Step failed -- run compensating transactions in reverse
        context.status = `${step.name}_FAILED`;
        await this.saveSagaState(context);

        await this.compensate(context, i);

        return {
          success: false,
          sagaId: context.sagaId,
          failedStep: step.name,
          error: error.message
        };
      }
    }

    context.status = 'COMPLETED';
    await this.saveSagaState(context);

    return {
      success: true,
      sagaId: context.sagaId,
      bookingId: context.bookingId
    };
  }

  /**
   * Run compensating transactions in reverse order,
   * starting from the step before the one that failed.
   */
  private async compensate(context: SagaContext, failedStep: number): Promise<void> {
    for (let i = failedStep - 1; i >= 0; i--) {
      const step = this.steps[i];

      try {
        await step.compensate(context);
        context.status = `${step.name}_COMPENSATED`;
        await this.saveSagaState(context);
      } catch (compensationError) {
        // Compensation failure -- log and alert for manual intervention
        console.error(
          `Saga ${context.sagaId}: Compensation failed for step ${step.name}`,
          compensationError
        );
        context.status = `${step.name}_COMPENSATION_FAILED`;
        await this.saveSagaState(context);

        // Write to dead letter queue for manual resolution (Section 21)
        await this.writeToDLQ(context, step.name, compensationError);
      }
    }
  }

  private async saveSagaState(context: SagaContext): Promise<void> {
    await db.execute(`
      INSERT INTO saga_state (saga_id, status, context_data, updated_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE status = ?, context_data = ?, updated_at = NOW()
    `, [
      context.sagaId, context.status, JSON.stringify(context),
      context.status, JSON.stringify(context)
    ]);
  }
}
```

### Key Takeaways

- The saga pattern replaces a single distributed ACID transaction with a sequence of local transactions, each paired with a compensating action. If step N fails, steps N-1 through 1 are compensated in reverse order.
- Saga state is persisted to the database at every step transition (`saveSagaState`). This enables crash recovery: if the orchestrator crashes mid-saga, a recovery process can read the last known state and resume compensation from where it left off.
- Compensation is not the same as rollback. A compensating action (e.g., refunding a payment) is a new forward action that semantically undoes the effect of the original step. Unlike a database rollback, it may leave audit trails, trigger notifications, and have its own failure modes.
- When compensation itself fails, the saga enters a `COMPENSATION_FAILED` state and writes to a dead letter queue for manual intervention. This is the correct approach -- retrying indefinitely could cause further damage (e.g., double-refunding).
- The payment step authorizes against the `holdId`, not a `bookingId`, because the booking record does not exist yet. This ordering (hold inventory, charge payment, create booking) ensures that money is only charged after inventory is secured.

### Review Questions

1. In the `compensate` method, the loop starts at `failedStep - 1` and iterates down to 0. Why does it start at `failedStep - 1` rather than `failedStep`? What would happen if compensation started at the failed step itself?
2. The `PROCESS_PAYMENT` step references `ctx.holdId` (set by the previous step). If the orchestrator crashes after `HOLD_INVENTORY` succeeds but before `PROCESS_PAYMENT` begins, how does the system recover? Trace through the recovery path using the persisted saga state.
3. Consider a scenario where `CONFIRM_BOOKING` fails. The compensator refunds the payment and releases the inventory hold. But what if the user sees a "booking confirmed" notification (sent by a downstream event consumer) before the compensation completes? How would you design the system to handle this user-facing inconsistency?

### Hands-On Exercise

**Exercise: Build a Mini Saga Orchestrator**

Implement a simplified saga orchestrator with three steps: (1) `reserveItem` -- decrements a counter in an in-memory store, (2) `chargePayment` -- appends a charge record to an array, and (3) `confirmOrder` -- sets an order status to "confirmed." Each step has a compensating action (increment counter, append refund record, set status to "cancelled"). Write the orchestrator so that it executes steps in order and compensates in reverse on failure. Test three scenarios: (a) all steps succeed -- verify the final state, (b) step 2 fails -- verify that step 1 is compensated and no charge record exists, (c) step 3 fails -- verify that both step 2 and step 1 are compensated (refund record exists, counter is restored). Log the saga state transitions for each scenario.

---

## 16. CQRS Pattern

> **Learning Objectives**
> - Articulate why separating read and write models is necessary at high throughput (100,000 bookings/minute) and how reads and writes have fundamentally different consistency and performance requirements.
> - Read the CQRS architecture diagram and identify the data flow from MySQL (write model) through outbox events to Elasticsearch (read model).
> - Understand how event-driven projections keep the read model eventually consistent by consuming Kafka events and updating Elasticsearch indices.
> - Compare the query patterns available in the read model (full-text search, geo-search, filtered aggregations) with what would be feasible using the write model alone.

**Why:** At 100,000 bookings/minute, reads and writes have fundamentally different characteristics. Writes need strong consistency (MySQL with fencing tokens), while reads need speed (sub-200ms search results). CQRS separates the write model (commands) from the read model (queries), allowing each to be optimized independently.

### 16.1 CQRS Architecture

```
Commands (Writes):                    Queries (Reads):
  +---------------+                    +---------------+
  |  Booking API  |                    |  Search API   |
  +-------+-------+                    +-------+-------+
          |                                    |
  +-------v-------+                    +-------v-------+
  |    MySQL      |---- Outbox ---->   | Elasticsearch |
  |   (Primary)   |     Events         | (Read Model)  |
  +---------------+                    +---------------+
          |                                    |
    Strong consistency              Sub-200ms queries
    Fencing tokens                  Geo-search
    ACID transactions               Full-text search
```

### 16.2 Event-Driven Read Model Projections

```typescript
// ============================================
// CQRS Read Model Projector
// ============================================

export class BookingReadModelProjector {

  async start(): Promise<void> {
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events', 'payment-events'],
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'booking.created':
            await this.projectBookingCreated(event.payload);
            break;
          case 'booking.confirmed':
            await this.projectBookingConfirmed(event.payload);
            break;
          case 'booking.cancelled':
            await this.projectBookingCancelled(event.payload);
            break;
          case 'inventory.updated':
            await this.projectInventoryUpdated(event.payload);
            break;
        }
      }
    });
  }

  private async projectBookingCreated(payload: any): Promise<void> {
    // Update Elasticsearch with denormalized booking data
    await elasticsearch.index({
      index: 'bookings',
      id: payload.bookingId.toString(),
      body: {
        bookingId: payload.bookingId,
        userId: payload.userId,
        bookingType: payload.bookingType,
        status: 'pending',
        totalAmount: payload.totalAmount,
        currency: payload.currency,
        createdAt: payload.timestamp,
        // Denormalized: include hotel/flight details for fast queries
        resourceName: payload.resourceName,
        location: payload.location,
        dates: {
          checkIn: payload.checkIn,
          checkOut: payload.checkOut
        }
      }
    });
  }

  private async projectInventoryUpdated(payload: any): Promise<void> {
    // Update availability in search index
    await elasticsearch.update({
      index: 'hotels',
      id: payload.resourceId.toString(),
      body: {
        doc: {
          available_rooms: payload.availableQuantity,
          price_per_night: payload.basePrice,
          updated_at: new Date().toISOString()
        }
      }
    });
  }
}
```

### 16.3 Query Service

```typescript
// ============================================
// CQRS Query Service -- Reads from Elasticsearch
// ============================================

export class BookingQueryService {

  // Fast read from denormalized read model
  async getUserBookings(userId: bigint, filters: BookingFilters): Promise<BookingList> {
    const { body } = await elasticsearch.search({
      index: 'bookings',
      body: {
        query: {
          bool: {
            must: [
              { term: { userId: userId.toString() } },
              ...(filters.status ? [{ term: { status: filters.status } }] : []),
              ...(filters.bookingType ?
                [{ term: { bookingType: filters.bookingType } }] : [])
            ],
            filter: [
              ...(filters.dateFrom ? [{
                range: { 'dates.checkIn': { gte: filters.dateFrom } }
              }] : [])
            ]
          }
        },
        sort: [{ createdAt: 'desc' }],
        from: filters.offset || 0,
        size: filters.limit || 20
      }
    });

    return {
      bookings: body.hits.hits.map(hit => hit._source),
      total: body.hits.total.value
    };
  }
}
```

### Key Takeaways

- CQRS separates the write path (MySQL with ACID transactions and fencing tokens) from the read path (Elasticsearch with denormalized, search-optimized indices). This allows each side to scale independently and use the storage technology best suited to its access patterns.
- The read model is eventually consistent with the write model. Events flow from MySQL through the outbox table to Kafka, and projectors consume those events to update Elasticsearch. The propagation delay is typically sub-second but can grow during high load or consumer lag.
- Projections are denormalized: the `projectBookingCreated` method stores hotel names, locations, and dates directly in the booking document, eliminating the need for joins at query time. This is the fundamental tradeoff -- storage duplication in exchange for query speed.
- The query service constructs Elasticsearch bool queries with `must` (scored matching) and `filter` (unscored, cacheable filtering) clauses. This distinction matters for performance: filter clauses are cached by Elasticsearch and skip scoring, making them significantly faster for exact-match fields like `status` and `bookingType`.

### Review Questions

1. The `BookingReadModelProjector` subscribes to three Kafka topics (`booking-events`, `inventory-events`, `payment-events`). What happens if the projector crashes and restarts? How does Kafka's consumer group offset tracking ensure that no events are missed or double-processed? What role does idempotency (Section 12) play here?
2. In the `projectBookingCreated` method, the booking is indexed with `status: 'pending'`. When the booking is later confirmed, a separate `booking.confirmed` event updates the status. What does the user see if they query their bookings in the brief window between the `booking.created` and `booking.confirmed` projections? Is this acceptable?
3. The query uses `bool.must` for `userId` and `bool.filter` for `dateFrom`. Why is `userId` in `must` rather than `filter`? Would moving it to `filter` change the results? Would it change performance?

### Hands-On Exercise

**Exercise: Build a Read Model Projector**

Create a simple CQRS system using an in-memory write store (a Map of bookings) and an in-memory read store (a separate Map optimized for search). Implement a `createBooking` command that writes to the write store and publishes an event to an event array. Implement a `ReadModelProjector` that processes events from the array and builds a denormalized read model that supports querying by userId, status, and date range. Write a `QueryService` that searches the read model. Test the following: (1) create 5 bookings for 2 different users, (2) run the projector, (3) query bookings for user 1 -- verify only their bookings are returned, (4) query bookings with status "confirmed" -- verify filtering works, (5) create a new booking *without* running the projector and verify the query does not return it (demonstrating eventual consistency).

---
# PART IV: RESILIENCE & RELIABILITY

Modern distributed systems do not fail cleanly. They degrade. A payment gateway starts responding in 12 seconds instead of 200 milliseconds. A supplier API returns HTTP 503 for 40% of requests while the other 60% succeed. A Redis node runs out of memory and silently drops cache entries. A database replica falls 30 seconds behind the primary. These are not hypothetical scenarios -- they are Tuesday afternoon in a system processing 1,666 bookings per second across multiple continents. This part teaches you how to build a system that survives these failures without losing bookings, corrupting data, or waking up the on-call engineer at 3 AM.

Part III prevented data corruption -- ensuring that concurrent writes, distributed transactions, and cross-shard operations maintain consistency even under contention. This part prevents cascading failures, thundering herds, and cache stampedes. Where Part III asked "is the data correct?", Part IV asks "is the system still standing?" The patterns here -- circuit breakers, bulkheads, rate limiters, retry budgets, cache stampede prevention, dead letter queues, and read/write splitting -- form the defensive armor of a production system. Each pattern addresses a specific failure mode, and together they create layers of protection that keep the booking pipeline operational even when individual components are struggling.

You will notice a recurring theme: every pattern in this part exists because the naive approach causes more harm than the original failure. Retrying without backoff creates thundering herds. Caching without stampede prevention turns a cache miss into a database avalanche. Processing without dead letter queues means lost bookings. Reading without replica lag detection means stale data and overbooking. The "why" matters as much as the "how" -- understanding the failure mode is the only way to understand why the solution is shaped the way it is.

---

## 17. Circuit Breaker & Bulkhead Patterns

> **Learning Objectives**
>
> - Understand how a single slow downstream dependency can cascade into a system-wide outage
> - Describe the three states of a circuit breaker (CLOSED, OPEN, HALF_OPEN) and the transitions between them
> - Implement a circuit breaker with a correct fallback signature using the opossum library
> - Explain why bulkheads isolate failure domains and how they complement circuit breakers
> - Configure separate resource pools per downstream service to prevent resource starvation

**Why:** In a globally distributed booking system that fans out requests to dozens of downstream supplier APIs, payment gateways, and inventory services, any single downstream failure can cascade upward. Without isolation, a slow or unresponsive supplier can exhaust thread pools, saturate connection limits, and bring down the entire booking pipeline. Circuit breakers detect failure thresholds and short-circuit requests before they pile up. Bulkheads isolate failure domains so that one misbehaving dependency cannot consume all available resources and starve healthy services.

### Circuit Breaker with Opossum

The circuit breaker transitions through three states:

1. **CLOSED** -- Normal operation. Requests pass through. Failures are counted.
2. **OPEN** -- Failure threshold exceeded. All requests are immediately rejected or routed to a fallback. A timer begins.
3. **HALF_OPEN** -- After the reset timeout, a single probe request is allowed through. If it succeeds the breaker closes; if it fails the breaker reopens.

```
                    success
            ┌──────────────────┐
            │                  │
            ▼                  │
     ┌────────────┐    ┌──────────────┐
     │   CLOSED   │───▶│    OPEN      │
     └────────────┘    └──────────────┘
            ▲           failure threshold    │
            │           exceeded             │
            │                                │
            │          reset timeout         │
            │          expires               ▼
            │                         ┌──────────────┐
            └─────────────────────────│  HALF_OPEN   │
                  probe succeeds      └──────────────┘
                                           │
                                           │ probe fails
                                           └──▶ back to OPEN
```

```typescript
// Circuit Breaker with corrected fallback
import CircuitBreaker from 'opossum';

interface BookRoomParams {
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  guestInfo: GuestInfo;
  paymentToken: string;
}

interface BookingResult {
  status: 'confirmed' | 'pending' | 'failed';
  bookingId?: string;
  message?: string;
  queueId?: string;
}

class SupplierAPIClient {
  private circuitBreaker: CircuitBreaker;

  constructor(private supplierName: string) {
    this.circuitBreaker = new CircuitBreaker(
      this.callSupplierAPI.bind(this),
      {
        timeout: 5000,                   // Trip if call takes longer than 5s
        errorThresholdPercentage: 50,    // Open after 50% failures
        resetTimeout: 30000,             // Try again after 30s
        volumeThreshold: 10              // Minimum calls before evaluating
      }
    );

    // Fallback receives the SAME arguments as the original function, plus the error
    this.circuitBreaker.fallback(this.handleFallback.bind(this));

    this.circuitBreaker.on('open', () => {
      console.error(`Circuit breaker OPEN for ${this.supplierName}`);
      metrics.circuitBreakerState.set({ supplier: this.supplierName, state: 'open' }, 1);
    });

    this.circuitBreaker.on('halfOpen', () => {
      console.warn(`Circuit breaker HALF-OPEN for ${this.supplierName}`);
    });

    this.circuitBreaker.on('close', () => {
      console.log(`Circuit breaker CLOSED for ${this.supplierName}`);
      metrics.circuitBreakerState.set({ supplier: this.supplierName, state: 'closed' }, 1);
    });
  }

  async bookRoom(params: BookRoomParams): Promise<BookingResult> {
    return await this.circuitBreaker.fire(params);
  }

  private async callSupplierAPI(params: BookRoomParams): Promise<BookingResult> {
    const response = await axios.post(
      `${this.getSupplierEndpoint()}/book`,
      params,
      { timeout: 5000 }
    );
    return response.data;
  }

  // FIXED: params is now properly received from opossum's fallback chain
  private handleFallback(params: BookRoomParams, error: Error): BookingResult {
    console.error(`Fallback triggered for ${this.supplierName}:`, error.message);
    return {
      status: 'pending',
      message: 'Supplier temporarily unavailable. Request queued.',
      queueId: this.queueRequest(params)  // params is now in scope
    };
  }

  private queueRequest(params: BookRoomParams): string {
    const queueId = generateUUID();
    // Push to a persistent queue (e.g., SQS, RabbitMQ) for later processing
    messageQueue.send('supplier-retry-queue', {
      queueId,
      supplier: this.supplierName,
      params,
      enqueuedAt: new Date().toISOString()
    });
    return queueId;
  }

  private getSupplierEndpoint(): string {
    return config.suppliers[this.supplierName].endpoint;
  }
}
```

> **Common Mistake: Undeclared `params` in Fallback**
>
> An earlier version declared `handleFallback(error: Error)` but referenced `this.queueRequest(params)` inside the method body -- `params` was never in scope. In opossum, the fallback function receives the **same arguments** as the protected function, followed by the error as the final argument. The correct signature is `handleFallback(params: BookRoomParams, error: Error)`. If your protected function accepted multiple arguments, all of them would appear before the error in the fallback signature. Failing to account for this causes a `ReferenceError` at runtime -- exactly when you need the fallback to work most.

### Bulkhead Pattern

**Why:** Even with circuit breakers, a single service consuming all available connections or threads can starve other healthy services. The bulkhead pattern partitions resources into isolated pools -- just as bulkheads in a ship prevent a single hull breach from sinking the entire vessel.

```typescript
// Bulkhead: Separate connection pools per downstream service
export class BulkheadRejectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkheadRejectError';
  }
}

export class BulkheadManager {
  private readonly pools = new Map<string, {
    maxConcurrent: number;
    currentActive: number;
    queue: Array<{ resolve: Function; reject: Function; fn: Function }>;
    maxQueueSize: number;
  }>();

  register(serviceName: string, maxConcurrent: number, maxQueueSize: number = 100) {
    this.pools.set(serviceName, {
      maxConcurrent,
      currentActive: 0,
      queue: [],
      maxQueueSize
    });
  }

  async execute<T>(serviceName: string, fn: () => Promise<T>): Promise<T> {
    const pool = this.pools.get(serviceName);
    if (!pool) throw new Error(`No bulkhead registered for ${serviceName}`);

    if (pool.currentActive >= pool.maxConcurrent) {
      if (pool.queue.length >= pool.maxQueueSize) {
        throw new BulkheadRejectError(`Bulkhead full for ${serviceName}`);
      }

      return new Promise((resolve, reject) => {
        pool.queue.push({ resolve, reject, fn });
      });
    }

    pool.currentActive++;
    try {
      const result = await fn();
      return result;
    } finally {
      pool.currentActive--;
      this.processQueue(serviceName);
    }
  }

  private processQueue(serviceName: string) {
    const pool = this.pools.get(serviceName);
    if (!pool || pool.queue.length === 0) return;
    if (pool.currentActive >= pool.maxConcurrent) return;

    const { resolve, reject, fn } = pool.queue.shift()!;
    pool.currentActive++;

    fn().then(resolve).catch(reject).finally(() => {
      pool.currentActive--;
      this.processQueue(serviceName);
    });
  }
}

// Usage: each downstream service has its own isolated pool
const bulkhead = new BulkheadManager();
bulkhead.register('payment-service', 50, 200);    // Max 50 concurrent, 200 queued
bulkhead.register('inventory-service', 100, 500);  // Max 100 concurrent, 500 queued
bulkhead.register('supplier-api', 20, 50);          // Max 20 concurrent, 50 queued

// Wrapping a call with bulkhead isolation
async function chargePayment(paymentData: PaymentData): Promise<PaymentResult> {
  return bulkhead.execute('payment-service', async () => {
    return paymentGateway.charge(paymentData);
  });
}
```

### Key Takeaways

- A circuit breaker protects your system from wasting resources on calls that are likely to fail. It transitions through CLOSED, OPEN, and HALF_OPEN states based on failure thresholds, and the `volumeThreshold` setting prevents the breaker from tripping on a small number of initial requests.
- The fallback function in opossum receives the same arguments as the protected function, followed by the error. Getting this signature wrong causes a `ReferenceError` at the exact moment you need the fallback to work -- under failure conditions.
- The bulkhead pattern complements circuit breakers by isolating resource pools per downstream service, so that a misbehaving dependency cannot starve healthy services of connections or threads.
- Circuit breakers and bulkheads work at different granularities: circuit breakers protect individual call paths, while bulkheads protect shared resources (connection pools, thread pools) across all call paths to a given service.
- Always emit metrics on circuit breaker state transitions (open, halfOpen, close) so dashboards and alerts can track which suppliers are degraded.

### Review Questions

1. **Conceptual:** Why does the circuit breaker require a `volumeThreshold` of 10 before evaluating the error percentage? What would happen if it evaluated the error rate after only 1 or 2 requests?

2. **Code Reading:** In the `BulkheadManager.execute` method, what happens when `pool.currentActive >= pool.maxConcurrent` and `pool.queue.length >= pool.maxQueueSize`? Trace the behavior from the caller's perspective and explain why this is preferable to unbounded queuing.

3. **Conceptual:** The circuit breaker's HALF_OPEN state allows a single probe request through. Why only one? What failure scenario would occur if HALF_OPEN allowed all pending requests through simultaneously?

### Hands-On Exercise

**Build a Combined Circuit Breaker + Bulkhead Wrapper**

Create a `ResilientServiceCaller` class that wraps a downstream service call with both a circuit breaker and a bulkhead. The class should:

1. Accept a service name, max concurrency, and circuit breaker options in the constructor.
2. Expose an `execute<T>(fn: () => Promise<T>): Promise<T>` method that first checks the bulkhead for available capacity, then routes through the circuit breaker.
3. Include a fallback that returns a default value (passed in the constructor) when both the primary call and the bulkhead are exhausted.
4. Emit console logs for each state transition and each bulkhead rejection.

Test it by simulating a downstream service that fails 60% of the time and observe the circuit breaker opening, the bulkhead rejecting excess concurrent calls, and the fallback activating.

---

## 18. Rate Limiting

> **Learning Objectives**
>
> - Explain why rate limiting is essential for protecting a globally distributed booking system from abuse and overload
> - Compare the sliding window counter and token bucket algorithms and identify when each is appropriate
> - Read and understand Redis Lua scripts that implement atomic rate limiting logic
> - Configure tiered rate limits based on user roles (guest, user, premium, admin)
> - Implement rate limit middleware that sets standard HTTP headers for client self-regulation

**Why:** Protect backend services from traffic spikes, bot attacks, and abusive clients. A global booking system is an attractive target for scrapers, price-monitoring bots, and denial-of-service attacks. Rate limiting ensures fair resource allocation across tenants, prevents any single user or IP from monopolizing capacity, and provides a safety net against runaway internal services. Without it, a misbehaving client can exhaust database connections, degrade search latency for everyone, and inflate infrastructure costs.

### Sliding Window Counter Algorithm

The sliding window counter provides a smoother rate limiting experience than fixed windows by avoiding the "boundary burst" problem where a client can send 2x the limit by timing requests at the boundary of two fixed windows.

```typescript
// Sliding Window Counter (Redis Lua Script)
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
  limit: number;
  windowSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly luaScript = `
    local key = KEYS[1]
    local window = tonumber(ARGV[1])
    local limit = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local window_start = now - window

    -- Remove expired entries
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count current entries
    local count = redis.call('ZCARD', key)

    if count < limit then
      -- Add new entry
      redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
      redis.call('EXPIRE', key, window)
      return {1, limit - count - 1, 0}  -- allowed, remaining, retry_after
    else
      -- Get oldest entry to calculate retry time
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local retry_after = window - (now - tonumber(oldest[2]))
      return {0, 0, retry_after}  -- denied, remaining, retry_after
    end
  `;

  async checkRateLimit(params: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const [allowed, remaining, retryAfter] = await redis.eval(
      this.luaScript, 1, params.key,
      params.windowSeconds, params.maxRequests, now
    ) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining,
      retryAfter: retryAfter > 0 ? retryAfter : undefined,
      limit: params.maxRequests,
      windowSeconds: params.windowSeconds
    };
  }
}
```

### Token Bucket Algorithm

**Why:** The token bucket complements the sliding window by allowing controlled bursts. A client can accumulate tokens over idle periods and spend them in a burst, which is useful for legitimate use cases like a travel agent submitting a batch of bookings.

```typescript
export class TokenBucketRateLimiter {
  private readonly luaScript = `
    local key = KEYS[1]
    local capacity = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(bucket[1]) or capacity
    local last_refill = tonumber(bucket[2]) or now

    -- Refill tokens
    local elapsed = now - last_refill
    tokens = math.min(capacity, tokens + (elapsed * refill_rate))

    if tokens >= requested then
      tokens = tokens - requested
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {1, tokens}
    else
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(capacity / refill_rate) * 2)
      return {0, tokens}
    end
  `;

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    tokens: number = 1
  ): Promise<{ allowed: boolean; remainingTokens: number }> {
    const now = Date.now() / 1000;
    const [allowed, remaining] = await redis.eval(
      this.luaScript, 1, key, capacity, refillRate, now, tokens
    ) as [number, number];

    return { allowed: allowed === 1, remainingTokens: remaining };
  }
}
```

### Rate Limit Tiers

Different user roles receive different rate limits. Guests see the most restrictive limits, while admin accounts used for operational tooling receive generous allowances.

```typescript
export const rateLimitTiers = {
  guest: {
    search:  { windowSeconds: 60, maxRequests: 30 },
    general: { windowSeconds: 60, maxRequests: 60 }
  },
  user: {
    search:  { windowSeconds: 60, maxRequests: 100 },
    booking: { windowSeconds: 60, maxRequests: 10 },
    general: { windowSeconds: 60, maxRequests: 200 }
  },
  premium: {
    search:  { windowSeconds: 60, maxRequests: 300 },
    booking: { windowSeconds: 60, maxRequests: 30 },
    general: { windowSeconds: 60, maxRequests: 500 }
  },
  admin: {
    search:  { windowSeconds: 60, maxRequests: 1000 },
    booking: { windowSeconds: 60, maxRequests: 100 },
    general: { windowSeconds: 60, maxRequests: 2000 }
  }
};
```

### Rate Limit Middleware

```typescript
export class RateLimitMiddleware {
  private readonly limiter = new SlidingWindowRateLimiter();

  async handle(req: Request, res: Response, next: NextFunction) {
    const userRole = req.user?.role || 'guest';
    const endpoint = this.categorizeEndpoint(req.path);
    const tier = rateLimitTiers[userRole]?.[endpoint] || rateLimitTiers[userRole]?.general;

    if (!tier) return next();

    const key = `ratelimit:${userRole}:${req.user?.id || req.ip}:${endpoint}`;
    const result = await this.limiter.checkRateLimit({ key, ...tier });

    // Always set rate limit headers so clients can self-regulate
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter || 60);
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests',
        retryAfter: result.retryAfter
      });
    }

    next();
  }

  private categorizeEndpoint(path: string): string {
    if (path.includes('/search')) return 'search';
    if (path.includes('/bookings') && path === '/api/v1/bookings') return 'booking';
    return 'general';
  }
}
```

### Key Takeaways

- The sliding window counter avoids the "boundary burst" problem of fixed windows by using a Redis sorted set and removing expired entries before counting. This ensures a client cannot send 2x the limit by timing requests at a window boundary.
- The token bucket algorithm complements the sliding window by allowing controlled bursts -- useful for legitimate batch operations like a travel agent submitting multiple bookings. It refills tokens at a steady rate, letting idle clients accumulate burst capacity.
- Both algorithms use Redis Lua scripts for atomicity. Without atomic execution, a race condition between the "check count" and "increment count" steps would allow clients to exceed their limits under concurrent requests.
- Tiered rate limits ensure that guests, regular users, premium users, and admins each receive appropriate allowances. The middleware always sets `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers so well-behaved clients can self-regulate before hitting the limit.

### Review Questions

1. **Conceptual:** Explain the "boundary burst" problem with fixed-window rate limiting. How does the sliding window counter solve it, and what is the trade-off in terms of Redis memory usage?

2. **Code Reading:** In the sliding window Lua script, the line `redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))` appends a random number to the member value. Why is this random suffix necessary? What would happen if the member value were just `now`?

3. **Conceptual:** The `rateLimitTiers` configuration gives guests 30 search requests per minute but does not define a `booking` tier for guests. Looking at the middleware code, what happens when an unauthenticated guest attempts to hit a booking endpoint? Which tier is applied?

### Hands-On Exercise

**Implement a Dual-Algorithm Rate Limiter**

Build a rate limiter that uses the sliding window counter for the `/search` endpoint and the token bucket for the `/bookings` endpoint. Your implementation should:

1. Create an Express middleware that selects the algorithm based on the request path.
2. For `/search`, enforce a strict 100-requests-per-minute limit with no burst allowance.
3. For `/bookings`, use a token bucket with capacity 10, refill rate of 1 token per 6 seconds, allowing a burst of up to 5 bookings at once.
4. Return proper `429` responses with `Retry-After` headers and log each rejection with the client IP and endpoint.

Verify your implementation by writing a test script that sends 15 booking requests in rapid succession and confirms that only the first 10 succeed (the bucket's capacity), the next 5 are rejected, and after waiting 30 seconds, 5 more tokens have accumulated.

---

## 19. Retry & Backoff Strategies

> **Learning Objectives**
>
> - Explain why naive retries (immediate, unbounded) amplify failures in distributed systems rather than recovering from them
> - Implement exponential backoff with full jitter and understand why jitter prevents the thundering herd problem
> - Distinguish between retryable errors (transient network issues, 503, 429) and non-retryable errors (business logic failures, 4xx client errors)
> - Design a retry budget that caps the system-wide ratio of retries to original requests
> - Combine retry logic with a budget so that the system fails fast when retries would cause more harm than good

**Why:** Transient failures are normal in distributed systems. Network partitions heal, overloaded services recover, and cloud provider control planes experience brief hiccups. Smart retry with exponential backoff and jitter prevents the "thundering herd" problem -- where all clients retry simultaneously and re-overload a recovering service -- while still recovering from temporary errors. However, retries must be bounded; unbounded retries amplify load on a failing system and can turn a partial outage into a total one.

### Exponential Backoff with Full Jitter

```typescript
interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

export class RetryService {
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const {
      maxRetries = 3,
      baseDelayMs = 200,
      maxDelayMs = 10000,
      retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', '503', '429'],
      onRetry
    } = options;

    let lastError: Error;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === maxRetries) break;
        if (!this.isRetryable(error, retryableErrors)) break;

        // Exponential backoff with full jitter
        // Full jitter: uniform random between 0 and the exponential cap
        const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));
        const jitteredDelay = Math.random() * exponentialDelay;

        if (onRetry) onRetry(attempt + 1, jitteredDelay, error);

        await this.sleep(jitteredDelay);
      }
    }

    throw lastError!;
  }

  private isRetryable(error: any, retryableErrors: string[]): boolean {
    // Never retry client errors (except 429 Too Many Requests)
    if (error.response?.status >= 400 &&
        error.response?.status < 500 &&
        error.response?.status !== 429) {
      return false;
    }

    // Never retry business logic errors -- these will not succeed on retry
    if (error instanceof InsufficientInventoryError) return false;
    if (error instanceof FraudBlockedError) return false;
    if (error instanceof PaymentDeclinedError) return false;

    const errorCode = error.code || error.response?.status?.toString();
    return retryableErrors.includes(errorCode);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Retry Budget

**Why:** Individual retry policies are not enough. If every caller retries 3 times, a service receiving 1,000 requests/second under partial failure could see 3,000 retry requests/second on top of the original traffic. A retry budget caps the total ratio of retries to original requests across the entire system, preventing retry amplification.

```typescript
export class RetryBudget {
  private windowMs: number;
  private maxRetryRatio: number;
  private requests: number[] = [];
  private retries: number[] = [];

  constructor(windowMs: number = 60000, maxRetryRatio: number = 0.1) {
    this.windowMs = windowMs;
    this.maxRetryRatio = maxRetryRatio;
  }

  recordRequest(): void {
    this.requests.push(Date.now());
    this.cleanup();
  }

  canRetry(): boolean {
    this.cleanup();
    const totalRequests = this.requests.length;
    const totalRetries = this.retries.length;

    if (totalRequests === 0) return true;
    return (totalRetries / totalRequests) < this.maxRetryRatio;
  }

  recordRetry(): void {
    this.retries.push(Date.now());
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    this.requests = this.requests.filter(t => t > cutoff);
    this.retries = this.retries.filter(t => t > cutoff);
  }
}
```

### Combining Retry with Budget

```typescript
// Usage: retry only if the budget allows
const retryService = new RetryService();
const retryBudget = new RetryBudget(60000, 0.1); // Max 10% retries in 60s

async function bookWithRetry(params: BookRoomParams): Promise<BookingResult> {
  retryBudget.recordRequest();

  return retryService.executeWithRetry(
    () => supplierClient.bookRoom(params),
    {
      maxRetries: 3,
      onRetry: (attempt, delay, error) => {
        if (!retryBudget.canRetry()) {
          throw new Error('Retry budget exhausted -- failing fast');
        }
        retryBudget.recordRetry();
        console.warn(
          `Retry attempt ${attempt} after ${delay.toFixed(0)}ms: ${error.message}`
        );
      }
    }
  );
}
```

### Key Takeaways

- Exponential backoff with full jitter spreads retries uniformly across the delay window (`0` to `min(maxDelay, baseDelay * 2^attempt)`), preventing the thundering herd problem where all clients retry at the same instant and re-overload a recovering service.
- Not all errors are retryable. Business logic failures (`InsufficientInventoryError`, `FraudBlockedError`, `PaymentDeclinedError`) and most 4xx HTTP errors will never succeed on retry -- retrying them wastes resources and delays the error response to the user.
- A retry budget caps the system-wide retry ratio (e.g., 10% of total requests in a 60-second window). Without it, every caller independently retrying 3 times can turn 1,000 requests/second into 4,000 requests/second under partial failure -- exactly when the downstream can least afford it.
- The `onRetry` callback is the integration point between the retry service and the retry budget. By checking `canRetry()` inside `onRetry`, the system fails fast when the budget is exhausted rather than piling on more retries.
- Always log retry attempts with the attempt number, delay, and error message. These logs are essential for diagnosing whether retries are helping (transient errors recovering) or hurting (budget exhaustion under sustained failure).

### Review Questions

1. **Conceptual:** What is the difference between "full jitter" and "equal jitter" in exponential backoff? Why does this codebase use full jitter (`Math.random() * exponentialDelay`) rather than equal jitter (`exponentialDelay / 2 + Math.random() * exponentialDelay / 2`)?

2. **Code Reading:** In the `isRetryable` method, HTTP 429 (Too Many Requests) is explicitly allowed as retryable even though it is a 4xx status code. Why does this make sense? What would happen if 429 were treated as a non-retryable client error?

3. **Conceptual:** The `RetryBudget` uses an array of timestamps and filters out entries older than `windowMs`. What is the memory implication of this approach under 1,000 requests/second? How would you redesign the budget to use constant memory?

### Hands-On Exercise

**Simulate Retry Amplification and Budget Protection**

Write a simulation that demonstrates retry amplification and how a retry budget mitigates it:

1. Create a mock downstream service that fails 70% of requests for 30 seconds, then recovers.
2. Simulate 100 concurrent callers, each making 1 request per second, with `maxRetries: 3` and `baseDelayMs: 200`.
3. First, run the simulation without a retry budget and log the total number of requests hitting the downstream per second (original + retries). Observe how the load spikes to 3-4x during the failure window.
4. Then, run the same simulation with a `RetryBudget(60000, 0.1)` and observe how the total downstream load is capped at approximately 1.1x.
5. Print a summary comparing the two runs: total requests sent, total failures seen by callers, and time to recovery after the downstream heals.

---

## 20. Cache Strategy & Invalidation

> **Learning Objectives**
>
> - Explain why caching is critical for a booking system handling 3,888 read queries/second and how stale cache data leads to overbooking
> - Implement cache-aside with distributed lock-based stampede prevention and probabilistic early expiry
> - Understand why cache invalidation uses SCAN (never KEYS) to avoid blocking Redis in production
> - Design event-driven cache invalidation via Kafka to purge stale entries as soon as the source of truth changes
> - Configure TTL strategies that reflect the volatility of different data types (flight prices vs. country codes)

**Why:** Caching reduces database load and improves response times. At 1,666 bookings/second with a 70/30 read/write ratio, the read path generates approximately 3,888 queries/second. Without caching, every search, availability check, and profile lookup hits the database directly. A well-designed caching layer handles the majority of these reads without touching the database, reducing p99 latency from hundreds of milliseconds to single-digit milliseconds. However, caching introduces a consistency challenge: stale data can lead to overbooking, incorrect pricing, or phantom inventory. The strategies below balance freshness with performance.

### Cache-Aside with Stampede Prevention

```typescript
interface CacheOptions {
  earlyExpiry?: boolean;
  preventStampede?: boolean;
}

export class CacheService {
  private readonly defaultTTL = 3600; // 1 hour

  // Cache-aside: read from cache, fallback to DB
  async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number = this.defaultTTL,
    options: CacheOptions = {}
  ): Promise<T> {
    // Try cache first
    const cached = await redis.get(`cache:${key}`);

    if (cached) {
      const parsed = JSON.parse(cached);

      // Probabilistic early expiry to prevent stampede
      if (options.earlyExpiry) {
        const ttl = await redis.ttl(`cache:${key}`);
        const expiryWindow = ttlSeconds * 0.1; // 10% of TTL
        if (ttl < expiryWindow && Math.random() < 0.1) {
          // 10% chance to refresh early -- prevents all instances refreshing at once
          this.refreshInBackground(key, fetchFn, ttlSeconds);
        }
      }

      return parsed;
    }

    // Prevent cache stampede with distributed lock
    if (options.preventStampede) {
      return await this.fetchWithLock(key, fetchFn, ttlSeconds);
    }

    // Standard cache miss: fetch and store
    const value = await fetchFn();
    await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
    return value;
  }

  private async fetchWithLock<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    const lockKey = `cache:lock:${key}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');

    if (!acquired) {
      // Another instance is refreshing -- wait briefly and retry from cache
      await new Promise(resolve => setTimeout(resolve, 100));
      const cached = await redis.get(`cache:${key}`);
      if (cached) return JSON.parse(cached);
      return await fetchFn();  // Give up waiting, fetch directly
    }

    try {
      const value = await fetchFn();
      await redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
      return value;
    } finally {
      await redis.del(lockKey);
    }
  }

  // Event-driven invalidation (uses SCAN, never KEYS, to avoid blocking Redis)
  async invalidate(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `cache:${pattern}`, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== '0');
  }

  private refreshInBackground<T>(
    key: string,
    fetchFn: () => Promise<T>,
    ttlSeconds: number
  ): void {
    fetchFn().then(value => {
      redis.setex(`cache:${key}`, ttlSeconds, JSON.stringify(value));
    }).catch(err => {
      console.warn(`Background cache refresh failed for ${key}:`, err.message);
    });
  }
}
```

### Event-Driven Cache Invalidation via Kafka

**Why:** Time-based TTL expiry alone is insufficient for a booking system. When inventory is reserved or a price changes, stale cache entries can cause overbooking or display incorrect prices. Event-driven invalidation ensures caches are purged as soon as the source of truth changes.

```typescript
// Kafka consumer for cache invalidation
export class CacheInvalidationConsumer {
  async start(): Promise<void> {
    await kafka.subscribe({
      topics: ['booking-events', 'inventory-events'],
      fromBeginning: false
    });

    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());

        switch (event.eventType) {
          case 'inventory.updated':
          case 'inventory.reserved':
            await cacheService.invalidate(`inventory:${event.payload.resourceId}:*`);
            await cacheService.invalidate(`search:*`);  // Invalidate search cache
            break;

          case 'booking.created':
          case 'booking.cancelled':
            await cacheService.invalidate(`booking:${event.payload.bookingId}`);
            await cacheService.invalidate(`user:${event.payload.userId}:bookings`);
            break;

          case 'price.updated':
            await cacheService.invalidate(`pricing:${event.payload.resourceId}:*`);
            break;
        }
      }
    });
  }
}
```

### Cache TTL Strategy

Different data types have different volatility. Flight prices change by the minute; country codes change once a year. TTLs must reflect this reality.

```typescript
export const cacheTTLStrategy = {
  search: {
    hotelSearch: 300,        // 5 minutes -- changes frequently
    flightSearch: 120,       // 2 minutes -- very dynamic pricing
    carSearch: 600           // 10 minutes -- less volatile
  },
  inventory: {
    availability: 30,        // 30 seconds -- near real-time
    pricing: 300,            // 5 minutes
    hotelDetails: 3600       // 1 hour -- rarely changes
  },
  user: {
    profile: 1800,           // 30 minutes
    bookingHistory: 600,     // 10 minutes
    preferences: 3600        // 1 hour
  },
  static: {
    currencies: 86400,       // 24 hours
    countries: 86400,        // 24 hours
    bookingTypes: 86400      // 24 hours
  }
};
```

### Key Takeaways

- Cache-aside with stampede prevention uses a distributed lock (`SET lockKey '1' EX 5 NX`) so that only one instance fetches from the database on a cache miss. Without this, hundreds of concurrent requests for the same expired key would all hit the database simultaneously -- a cache stampede.
- Probabilistic early expiry (10% chance to refresh when TTL is within 10% of expiration) spreads cache refreshes over time, preventing the "cliff edge" where all cached entries expire at the same instant and flood the database.
- The `invalidate` method uses `SCAN` with `COUNT 100` instead of `KEYS` to find matching cache entries. `KEYS` blocks the entire Redis instance for the duration of the scan, which can cause multi-second pauses in production. `SCAN` is cursor-based and non-blocking.
- Event-driven invalidation via Kafka ensures caches are purged within seconds of the source of truth changing. This is essential for inventory and pricing data where stale cache entries directly cause overbooking or incorrect prices.
- TTL values must reflect data volatility: 30 seconds for availability (near real-time), 2 minutes for flight prices (dynamic), and 24 hours for static reference data (currencies, countries).

### Review Questions

1. **Conceptual:** The `fetchWithLock` method waits 100ms and retries from cache if the lock is not acquired. What happens if the instance holding the lock crashes before releasing it? How does the `EX 5` parameter on the lock mitigate this?

2. **Code Reading:** In the `invalidate` method, the SCAN loop uses `'COUNT', 100`. This does not mean exactly 100 keys are returned per iteration. What does `COUNT` actually control in Redis SCAN, and why is 100 a reasonable value for a production system?

3. **Conceptual:** The `CacheInvalidationConsumer` invalidates `search:*` whenever inventory changes. This is a broad invalidation that purges all cached search results. What is the trade-off here? How would you design a more targeted invalidation strategy for search results?

### Hands-On Exercise

**Build a Cache Stampede Detector**

Create a monitoring tool that detects cache stampedes in real time:

1. Instrument the `CacheService.getOrSet` method to emit a metric every time a cache miss occurs, tagged with the cache key prefix (e.g., `inventory`, `search`, `user`).
2. Build a `StampedeDetector` class that tracks the rate of cache misses per key prefix over a 5-second sliding window.
3. If more than 50 cache misses occur for the same key prefix within 5 seconds, log a warning: `"Potential cache stampede detected for prefix: {prefix}, miss rate: {rate}/s"`.
4. Test it by simulating 200 concurrent requests for the same uncached key (with stampede prevention disabled) and verify the detector fires. Then enable stampede prevention and verify the detector stays silent.

---

## 21. Dead Letter Queue Handling

> **Learning Objectives**
>
> - Explain why dead letter queues are the safety net that prevents failed messages (bookings, payments) from silently disappearing
> - Design a retry topic chain with graduated delays (1s, 10s, 1min, 5min, 1hr) that avoids hammering a struggling downstream
> - Trace the lifecycle of a failed message from the main topic through retry levels to the DLQ
> - Implement DLQ inspection and selective replay so operations teams can recover failed messages after fixing the root cause
> - Understand why DLQ messages are not garbage -- they represent real user actions that require human attention

**Why:** Not all messages can be processed successfully. Network glitches, data format issues, unexpected payloads, or downstream failures can cause message processing to fail even after multiple retries. Without a Dead Letter Queue (DLQ), failed messages are lost forever or block the main processing pipeline. DLQs capture these failed messages in a separate topic for later investigation, alerting, and selective reprocessing. They are the "safety net" that ensures no booking request, payment confirmation, or inventory update silently disappears.

### Retry Topic Chain with Graduated Delays

Rather than retrying immediately (which hammers an already-struggling downstream), each retry level introduces a longer delay. After all retry levels are exhausted, the message moves to the DLQ.

```
  Main Topic
      │
      ▼ (failure)
  retry-1  (1 second delay)
      │
      ▼ (failure)
  retry-2  (10 second delay)
      │
      ▼ (failure)
  retry-3  (1 minute delay)
      │
      ▼ (failure)
  retry-4  (5 minute delay)
      │
      ▼ (failure)
  retry-5  (1 hour delay -- final retry)
      │
      ▼ (failure)
  dlq-{topic}  (dead letter queue)
```

```typescript
export class RetryTopicChain {
  private readonly retryTopics = [
    { topic: 'retry-1', delayMs: 1000 },      // 1 second
    { topic: 'retry-2', delayMs: 10000 },     // 10 seconds
    { topic: 'retry-3', delayMs: 60000 },     // 1 minute
    { topic: 'retry-4', delayMs: 300000 },    // 5 minutes
    { topic: 'retry-5', delayMs: 3600000 }    // 1 hour (final retry)
  ];

  async handleFailedMessage(
    originalTopic: string,
    message: any,
    error: Error,
    retryCount: number = 0
  ): Promise<void> {
    if (retryCount >= this.retryTopics.length) {
      // All retries exhausted -- send to DLQ
      await this.sendToDLQ(originalTopic, message, error, retryCount);
      return;
    }

    const retryConfig = this.retryTopics[retryCount];

    await kafka.send({
      topic: retryConfig.topic,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          originalTopic,
          originalMessage: message,
          retryCount: retryCount + 1,
          error: { message: error.message, stack: error.stack },
          scheduledFor: Date.now() + retryConfig.delayMs,
          firstFailedAt: message.firstFailedAt || new Date().toISOString()
        }),
        headers: {
          'retry-count': (retryCount + 1).toString(),
          'original-topic': originalTopic,
          'error-type': error.constructor.name
        }
      }]
    });

    metrics.messageRetries.inc({
      topic: originalTopic,
      retry_level: retryCount + 1
    });
  }

  private async sendToDLQ(
    originalTopic: string,
    message: any,
    error: Error,
    retryCount: number
  ): Promise<void> {
    await kafka.send({
      topic: `dlq-${originalTopic}`,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          originalTopic,
          originalMessage: message,
          totalRetries: retryCount,
          error: { message: error.message, stack: error.stack },
          firstFailedAt: message.firstFailedAt,
          sentToDLQAt: new Date().toISOString()
        })
      }]
    });

    metrics.dlqMessages.inc({ topic: originalTopic });

    // Alert if DLQ grows too large
    console.error(`Message sent to DLQ for topic ${originalTopic}`, {
      error: error.message,
      retries: retryCount
    });
  }
}
```

### DLQ Consumer: Inspection and Replay

**Why:** Messages in the DLQ are not garbage -- they represent real user actions (bookings, payments) that failed. Operations teams need to inspect these messages, understand why they failed, and selectively replay them once the root cause is fixed.

```typescript
interface DLQMessage {
  originalTopic: string;
  originalMessage: any;
  totalRetries: number;
  error: { message: string; stack?: string };
  firstFailedAt: string;
  sentToDLQAt: string;
}

export class DLQConsumer {
  async inspectDLQ(topic: string, limit: number = 100): Promise<DLQMessage[]> {
    const consumer = kafka.consumer({ groupId: `dlq-inspector-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: `dlq-${topic}`, fromBeginning: true });

    const messages: DLQMessage[] = [];

    await consumer.run({
      eachMessage: async ({ message }) => {
        if (messages.length >= limit) return;
        messages.push(JSON.parse(message.value.toString()));
      }
    });

    // Wait briefly for messages to arrive then disconnect
    await new Promise(resolve => setTimeout(resolve, 2000));
    await consumer.disconnect();

    return messages;
  }

  async replayMessage(dlqMessage: DLQMessage): Promise<void> {
    await kafka.send({
      topic: dlqMessage.originalTopic,
      messages: [{
        key: dlqMessage.originalMessage.key,
        value: JSON.stringify(dlqMessage.originalMessage),
        headers: {
          'replayed-from-dlq': 'true',
          'original-error': dlqMessage.error.message
        }
      }]
    });
  }

  async replayAll(topic: string): Promise<{ replayed: number; failed: number }> {
    const messages = await this.inspectDLQ(topic, 1000);
    let replayed = 0, failed = 0;

    for (const msg of messages) {
      try {
        await this.replayMessage(msg);
        replayed++;
      } catch (error) {
        failed++;
      }
    }

    return { replayed, failed };
  }
}
```

### Key Takeaways

- A retry topic chain with graduated delays (1s, 10s, 1min, 5min, 1hr) gives the downstream service progressively more time to recover between attempts, avoiding the pile-on effect of immediate retries that hammer an already-struggling service.
- Each retry message preserves the full context: the original topic, the original message payload, the retry count, the error details, and the timestamp of the first failure. This metadata is essential for debugging and for the DLQ consumer to understand what went wrong.
- The DLQ is not a graveyard -- it is a staging area for human review. Messages in the DLQ represent real user actions (bookings, payments, inventory updates) that failed after all retry attempts. The `replayMessage` method allows operations teams to selectively reprocess messages after the root cause is fixed.
- The `replayAll` method should be used with caution. Replaying thousands of messages at once can re-overload a recently recovered service. In practice, replay should be throttled and monitored.
- Alerting on DLQ growth is critical. A steadily growing DLQ indicates that the root cause has not been resolved and that real user requests are accumulating unprocessed.

### Review Questions

1. **Conceptual:** Why does the retry topic chain use separate Kafka topics (`retry-1`, `retry-2`, ...) instead of re-publishing to the original topic with a delay header? What advantage does the separate-topic approach provide for monitoring and operations?

2. **Code Reading:** In the `inspectDLQ` method, a new consumer group is created with `groupId: dlq-inspector-${Date.now()}`. Why does each inspection call create a unique consumer group? What would happen if a fixed group ID like `dlq-inspector` were used instead?

3. **Conceptual:** The `replayMessage` method adds a `'replayed-from-dlq': 'true'` header to replayed messages. How should the original consumer use this header? What safeguards should be in place to prevent a replayed message from entering an infinite retry-DLQ-replay loop?

### Hands-On Exercise

**Build a DLQ Dashboard**

Create a command-line dashboard that provides operational visibility into your dead letter queues:

1. Write a `DLQDashboard` class that periodically (every 10 seconds) calls `inspectDLQ` for a list of monitored topics (e.g., `booking-events`, `inventory-events`, `payment-events`).
2. For each topic, display: the total number of messages in the DLQ, a breakdown of error types (grouped by `error.message`), the oldest `firstFailedAt` timestamp, and the most recent `sentToDLQAt` timestamp.
3. Add a `replayByErrorType` method that replays only messages matching a specific error pattern (e.g., replay all messages that failed with `"ECONNREFUSED"` but leave messages that failed with `"ValidationError"` in the DLQ).
4. Test it by producing 20 messages to a DLQ topic -- 10 with a network error and 10 with a validation error -- and verify that `replayByErrorType('ECONNREFUSED')` replays exactly 10 messages.

---

## 22. Database Read/Write Splitting

> **Learning Objectives**
>
> - Explain why read/write splitting is necessary for a system with 1 primary + 4 read replicas per shard
> - Implement connection routing that directs writes to the primary and reads to healthy replicas using round-robin selection
> - Understand how replication lag detection prevents stale reads from lagging replicas and when to fall back to the primary
> - Design a two-level routing hierarchy: shard router (data locality by user ID) above read/write splitter (query type routing)
> - Implement scatter-gather for cross-shard queries used in admin reporting

**Why:** With 1 primary + 4 read replicas per shard, directing read queries to replicas distributes load across multiple database nodes. The primary handles only writes and critical reads that require the absolute latest data (e.g., checking inventory before confirming a booking). Read replicas handle the bulk of traffic: search results, booking history, user profiles, and reporting queries. This architecture allows the system to scale read capacity horizontally by adding replicas, while the primary remains focused on maintaining write consistency. Replication lag detection ensures that stale replicas are automatically bypassed.

### Connection Routing Based on Query Type

```typescript
interface QueryOptions {
  requirePrimary?: boolean;
  maxLagSeconds?: number;
}

interface ShardConfig {
  shardNumber: number;
  primaryHost: string;
  replicaHosts: string[];
  primaryPoolSize?: number;
  replicaPoolSize?: number;
}

export class ReadWriteSplitter {
  private primaryPool: ConnectionPool;
  private replicaPools: ConnectionPool[];
  private currentReplicaIndex = 0;

  constructor(shardConfig: ShardConfig) {
    this.primaryPool = createPool({
      host: shardConfig.primaryHost,
      port: 3306,
      connectionLimit: shardConfig.primaryPoolSize || 200
    });

    this.replicaPools = shardConfig.replicaHosts.map(host =>
      createPool({
        host,
        port: 3306,
        connectionLimit: shardConfig.replicaPoolSize || 500
      })
    );
  }

  async query(sql: string, params: any[], options: QueryOptions = {}): Promise<any> {
    const isWrite = this.isWriteQuery(sql);

    if (isWrite || options.requirePrimary) {
      return this.primaryPool.execute(sql, params);
    }

    // Check replication lag before using replica
    const replica = await this.getHealthyReplica(options.maxLagSeconds || 5);

    if (!replica) {
      // All replicas have excessive lag -- fall back to primary
      console.warn('All replicas lagging, falling back to primary for read');
      return this.primaryPool.execute(sql, params);
    }

    return replica.execute(sql, params);
  }

  private isWriteQuery(sql: string): boolean {
    const writePatterns = /^\s*(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE)/i;
    return writePatterns.test(sql);
  }

  private async getHealthyReplica(maxLagSeconds: number): Promise<ConnectionPool | null> {
    // Round-robin through replicas, skipping unhealthy ones
    for (let i = 0; i < this.replicaPools.length; i++) {
      const index = (this.currentReplicaIndex + i) % this.replicaPools.length;
      const pool = this.replicaPools[index];

      try {
        const [rows] = await pool.execute('SHOW SLAVE STATUS');
        const lag = rows[0]?.Seconds_Behind_Master;

        if (lag !== null && lag <= maxLagSeconds) {
          this.currentReplicaIndex = (index + 1) % this.replicaPools.length;
          return pool;
        }
      } catch (error) {
        // Replica unreachable, try next
        continue;
      }
    }

    return null;
  }

  // For operations that need read-after-write consistency
  async queryAfterWrite(sql: string, params: any[]): Promise<any> {
    return this.query(sql, params, { requirePrimary: true });
  }
}
```

### Shard Router

**Why:** The shard router sits above the read/write splitter and directs queries to the correct shard based on user ID. Combined with read/write splitting within each shard, this creates a two-level routing hierarchy: first by shard (data locality), then by query type (read vs. write).

```typescript
export class ShardRouter {
  private shards: Map<number, ReadWriteSplitter> = new Map();

  constructor(shardConfigs: ShardConfig[]) {
    for (const config of shardConfigs) {
      this.shards.set(config.shardNumber, new ReadWriteSplitter(config));
    }
  }

  getShardForUser(userId: bigint): ReadWriteSplitter {
    const shardNumber = Number(userId % 16n);
    const shard = this.shards.get(shardNumber);
    if (!shard) throw new Error(`Shard ${shardNumber} not configured`);
    return shard;
  }

  async queryForUser(
    userId: bigint,
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<any> {
    const shard = this.getShardForUser(userId);
    return shard.query(sql, params, options);
  }

  // Scatter-gather for cross-shard queries (e.g., admin reports)
  async queryAllShards(
    sql: string,
    params: any[],
    options?: QueryOptions
  ): Promise<Map<number, any>> {
    const results = new Map<number, any>();

    await Promise.all(
      Array.from(this.shards.entries()).map(async ([shardNum, splitter]) => {
        const result = await splitter.query(sql, params, options);
        results.set(shardNum, result);
      })
    );

    return results;
  }
}
```

### Key Takeaways

- Read/write splitting directs the bulk of read traffic (search results, booking history, user profiles) to replicas, keeping the primary focused on writes and critical reads that require the absolute latest data. This is essential for horizontal read scalability.
- Replication lag detection (`SHOW SLAVE STATUS` and `Seconds_Behind_Master`) prevents the system from serving stale data from a lagging replica. When all replicas exceed the lag threshold, the splitter falls back to the primary -- accepting higher primary load rather than returning stale results that could cause overbooking.
- The `queryAfterWrite` method is a convenience wrapper for operations that need read-after-write consistency (e.g., reading a booking immediately after creating it). It forces the query to the primary, bypassing replicas entirely.
- The two-level routing hierarchy -- shard router above read/write splitter -- cleanly separates data locality (which shard holds this user's data) from query routing (should this query go to the primary or a replica). Each level has a single responsibility.
- Scatter-gather (`queryAllShards`) is an expensive operation that queries every shard in parallel. It is appropriate for admin reports and aggregate analytics, but should never be used in the hot booking path. Monitor its usage and set alerts if it appears in latency-sensitive endpoints.

### Review Questions

1. **Conceptual:** The `isWriteQuery` method uses a regex that checks the beginning of the SQL string for write keywords. What types of queries would this regex misclassify? Give an example of a read query that would be incorrectly routed to the primary, and a write query that would be incorrectly routed to a replica.

2. **Code Reading:** In `getHealthyReplica`, the method executes `SHOW SLAVE STATUS` on each replica to check lag. This means every read query incurs an additional round-trip to check replication status. What performance concern does this raise, and how would you redesign the lag check to avoid this per-query overhead?

3. **Conceptual:** The shard router uses `userId % 16n` to determine the shard number. What happens when the system needs to grow from 16 shards to 32? How does this modulo-based approach complicate shard expansion, and what alternative sharding strategies would make expansion smoother?

### Hands-On Exercise

**Build a Lag-Aware Read Router with Caching**

Extend the `ReadWriteSplitter` to avoid the per-query `SHOW SLAVE STATUS` overhead:

1. Create a `ReplicaHealthMonitor` class that runs a background loop every 2 seconds, checking `SHOW SLAVE STATUS` on each replica and caching the results in memory.
2. Modify `getHealthyReplica` to read from the cached lag values instead of executing a query on every call.
3. Add a `replicaHealth()` method that returns the current health status of all replicas: host, lag in seconds, last checked timestamp, and whether the replica is marked healthy.
4. Add a weighted round-robin strategy where replicas with lower lag receive proportionally more traffic (e.g., a replica with 0s lag gets 4x the traffic of a replica with 4s lag when `maxLagSeconds` is 5).
5. Write a test that simulates 4 replicas with lags of 0s, 1s, 3s, and 10s (above threshold), verifies that the 10s replica receives zero traffic, and confirms that the 0s replica receives the most requests.

---
# PART V: SECURITY & COMPLIANCE

Security is not a feature you bolt on at the end -- it is a foundation you build from day one. A global booking platform handles sensitive personal data (names, emails, passport numbers), processes financial transactions across multiple payment providers, and must comply with regional privacy regulations like GDPR, CCPA, and PCI-DSS. A single breach can destroy customer trust overnight and trigger regulatory fines that threaten the business.

This part covers three pillars of platform security. First, Section 23 introduces a layered security architecture: network-level controls (mTLS, Kubernetes network policies), application-level defenses (input validation, rate limiting, security headers), and data-level protections (encryption, secret management). Second, Section 24 tackles fraud detection -- because a booking platform that processes payments is a magnet for stolen credit cards, account takeovers, and bot attacks. You will study a real-time risk scoring engine that evaluates transactions before they reach the payment gateway. Third, Section 25 addresses GDPR and data privacy compliance, including the technically challenging "right to be forgotten" workflow that must purge user data from databases, caches, and audit logs while preserving legally required records.

Throughout these sections, the guiding principle is defense in depth: no single layer is sufficient, and every layer assumes the others may fail. Authentication stops unauthorized access, but input validation catches malicious payloads that slip through. Rate limiting slows attackers, but fraud detection catches the ones who stay under the rate limit. Encryption protects data at rest and in transit, but GDPR compliance ensures you do not hold data longer than necessary.

---

## 23. Security Architecture

> **Learning Objectives**
> - Understand why security in a booking platform must be layered across network, application, and data levels.
> - Identify the role of Helmet.js, rate limiting, and input sanitization as application-level defenses.
> - Read and interpret a Kubernetes NetworkPolicy that restricts inter-service communication.
> - Explain how secret management with caching reduces both latency and exposure risk.
> - Recognize OWASP Top 10 considerations specific to booking and payment systems.

**Why:** A booking platform processes financial transactions and personal data across regions. Security must be layered: network-level (mTLS, network policies), application-level (input validation, output encoding), and data-level (encryption, tokenization).

### Security Middleware Stack

- Input validation and sanitization middleware
- SQL injection prevention (parameterized queries everywhere)
- XSS prevention with output encoding
- Secret management with AWS Secrets Manager / Vault
- mTLS between services (Istio handles this)
- Network policies (Kubernetes)
- Helmet.js security headers
- OWASP Top 10 considerations for booking systems

```typescript
// Security middleware stack
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function configureSecurityMiddleware(app: Express) {
  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"]
      }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));

  // Request size limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Rate limiting per API endpoint category
  app.use('/api/bookings', rateLimit({
    windowMs: 60 * 1000,       // 1-minute window
    max: 100,                   // 100 booking requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many booking requests, please try again later' }
  }));

  app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,  // 15-minute window
    max: 20,                    // 20 auth attempts per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts' }
  }));
}
```

### Input Validation

```typescript
export class InputSanitizer {
  static sanitizeString(input: string): string {
    return input
      .replace(/[<>]/g, '')          // Remove angle brackets
      .replace(/javascript:/gi, '')   // Remove JS protocol
      .replace(/on\w+=/gi, '')       // Remove event handlers
      .trim()
      .substring(0, 10000);          // Max length
  }

  static validateBookingInput(dto: CreateBookingDto): ValidationResult {
    const errors: string[] = [];

    // Validate amounts are positive and within range
    if (dto.totalAmount <= 0 || dto.totalAmount > 1000000) {
      errors.push('Total amount must be between 0 and 1,000,000');
    }

    // Validate currency is an allowed ISO code
    const allowedCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'];
    if (!allowedCurrencies.includes(dto.currency)) {
      errors.push(`Invalid currency: ${dto.currency}`);
    }

    // Validate dates
    const checkIn = new Date(dto.checkIn);
    const checkOut = new Date(dto.checkOut);
    if (checkIn >= checkOut) {
      errors.push('Check-in must be before check-out');
    }
    if (checkIn < new Date()) {
      errors.push('Check-in cannot be in the past');
    }

    return { valid: errors.length === 0, errors };
  }
}
```

### Secret Management

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export class SecretManager {
  private readonly client = new SecretsManagerClient({ region: process.env.REGION });
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly cacheTTL = 300000; // 5 minutes

  async getSecret(secretName: string): Promise<string> {
    const cached = this.cache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);
    const value = response.SecretString!;

    this.cache.set(secretName, {
      value,
      expiresAt: Date.now() + this.cacheTTL
    });

    return value;
  }
}
```

### Network Policy

```yaml
# Kubernetes Network Policy -- only allow booking-service to talk to inventory/payment
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: booking-service-netpol
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: booking-service
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: inventory-service
        - podSelector:
            matchLabels:
              app: payment-service
        - podSelector:
            matchLabels:
              app: notification-service
      ports:
        - protocol: TCP
          port: 3000
    - to:  # Allow DNS
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
```

### Key Takeaways

- Security must be layered: network-level (mTLS, NetworkPolicy), application-level (Helmet.js, rate limiting, input validation), and data-level (encryption, secret management). No single layer is sufficient on its own.
- Rate limiting should be tuned per endpoint category -- authentication endpoints need much stricter limits (20 per 15 minutes) than booking endpoints (100 per minute) because brute-force attacks target auth flows.
- Kubernetes NetworkPolicies enforce zero-trust networking by explicitly whitelisting which pods can communicate, preventing lateral movement if one service is compromised.
- Secrets should never be stored in environment variables or code. Use a managed secret store (AWS Secrets Manager, HashiCorp Vault) with a short-lived cache to balance security and performance.

### Review Questions

1. In the `configureSecurityMiddleware` function, the `/api/auth` endpoint has a 15-minute window with a max of 20 requests, while `/api/bookings` has a 1-minute window with a max of 100. Why are these limits configured so differently? What attack vector does each limit address?
2. The `InputSanitizer.sanitizeString` method removes angle brackets, `javascript:` protocol strings, and event handler attributes. Which specific OWASP Top 10 vulnerability does this mitigate, and can you think of an edge case this sanitizer might miss?
3. Examine the Kubernetes NetworkPolicy YAML. Why does the egress section include a separate rule allowing UDP port 53 to all namespaces? What would happen if this rule were removed?

### Hands-On Exercise

Extend the `configureSecurityMiddleware` function to add a third rate limiter for a `/api/search` endpoint. Search is read-heavy and tolerates higher throughput, but an attacker could abuse it to scrape inventory data. Choose a window size and max request count that balances usability with protection. Then write a brief justification (3-4 sentences) for your chosen values, explaining the trade-offs compared to the booking and auth limits.

---

## 24. Fraud Detection

> **Learning Objectives**
> - Explain why booking platforms are high-value targets for fraud (stolen cards, account takeover, bot attacks).
> - Trace the flow of a transaction through a multi-rule risk scoring engine and understand how individual rule scores combine into a final decision.
> - Distinguish between the four fraud statuses (passed, flagged, under_review, blocked) and the thresholds that trigger each.
> - Read the database schema for fraud checks and device fingerprints to understand how fraud data is stored and queried.

**Why:** Booking platforms are targets for fraud: stolen credit cards, account takeover, and bot attacks. Real-time scoring catches suspicious transactions before payment processing.

### Fraud Detection Service with Risk Scoring

```typescript
export class FraudDetectionService {
  async checkTransaction(params: {
    userId: bigint;
    amount: number;
    ipAddress: string;
    deviceFingerprint: string;
    email: string;
    cardBIN: string;
  }): Promise<FraudCheckResult> {
    let riskScore = 0;
    const triggeredRules: string[] = [];

    // 1. IP Country Mismatch (30 points)
    const ipCountry = await this.getCountryFromIP(params.ipAddress);
    const billingCountry = await this.getBillingCountry(params.userId);
    if (ipCountry !== billingCountry) {
      riskScore += 30;
      triggeredRules.push('ip_country_mismatch');
    }

    // 2. Velocity Check -- bookings per hour (40 points)
    const recentBookings = await this.getRecentBookings(params.userId, 60);
    if (recentBookings.length >= 5) {
      riskScore += 40;
      triggeredRules.push('high_velocity');
    }

    // 3. Amount Threshold (45 points)
    if (params.amount > 5000) {
      riskScore += 45;
      triggeredRules.push('high_amount');
    }

    // 4. Device Reputation
    const deviceRisk = await this.checkDeviceReputation(params.deviceFingerprint);
    riskScore += deviceRisk.score;
    if (deviceRisk.score > 0) triggeredRules.push('device_risk');

    // 5. Email Reputation
    const emailRisk = await this.checkEmailReputation(params.email);
    riskScore += emailRisk.score;
    if (emailRisk.score > 0) triggeredRules.push('email_risk');

    // 6. BIN Lookup
    const binRisk = await this.checkCardBIN(params.cardBIN);
    riskScore += binRisk.score;
    if (binRisk.score > 0) triggeredRules.push('bin_risk');

    // Determine status based on score thresholds
    let status: FraudStatus;
    if (riskScore >= 80) status = 'blocked';
    else if (riskScore >= 50) status = 'under_review';
    else if (riskScore >= 25) status = 'flagged';
    else status = 'passed';

    // Save fraud check record
    await this.saveFraudCheck({
      userId: params.userId,
      riskScore,
      triggeredRules,
      status,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    // Alert fraud team for high-risk transactions
    if (status === 'blocked' || status === 'under_review') {
      await this.alertFraudTeam(params.userId, riskScore, triggeredRules);
    }

    return { status, riskScore, triggeredRules, canProceed: status !== 'blocked' };
  }
}
```

### Fraud Check Database Tables

```sql
CREATE TABLE fraud_checks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    booking_id BIGINT,

    risk_score SMALLINT NOT NULL,
    status ENUM('passed', 'flagged', 'under_review', 'blocked') NOT NULL,
    triggered_rules JSON NOT NULL,

    ip_address VARCHAR(45),
    user_agent TEXT,
    device_fingerprint VARCHAR(64),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    reviewed_by BIGINT,
    review_notes TEXT,

    INDEX idx_user (user_id, created_at),
    INDEX idx_status (status, created_at),
    INDEX idx_score (risk_score)
);

CREATE TABLE device_fingerprints (
    fingerprint_hash VARCHAR(64) PRIMARY KEY,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    seen_count INT DEFAULT 1,
    associated_users JSON,
    risk_level ENUM('low', 'medium', 'high') DEFAULT 'low',

    INDEX idx_risk (risk_level)
);
```

### Key Takeaways

- Fraud detection must happen in real time, before the payment is processed -- not after the money has left the account. The scoring engine runs inline with the booking flow.
- A cumulative scoring approach is more robust than hard binary rules. A single signal (e.g., IP mismatch) may have an innocent explanation, but multiple weak signals together (IP mismatch + high amount + new device) paint a clear picture.
- The four-tier status system (passed, flagged, under_review, blocked) provides graduated responses. Only "blocked" prevents the transaction entirely; "under_review" allows processing while queuing a human review, which reduces false positives that frustrate legitimate customers.
- Storing fraud check records with triggered rules and scores creates an audit trail that lets the fraud team tune thresholds over time based on actual false-positive and false-negative rates.
- The `device_fingerprints` table tracks device reputation across users, which is critical for detecting when a single device is used to create multiple fraudulent accounts.

### Review Questions

1. A transaction triggers `ip_country_mismatch` (30 points) and `high_amount` (45 points) but no other rules. What status does it receive? Would the transaction proceed? Walk through the threshold logic.
2. The velocity check awards 40 points if a user has made 5 or more bookings in the past 60 minutes. Why might a legitimate business traveler or travel agent trigger this rule? How could the system reduce false positives for known high-volume users without weakening the rule for new accounts?
3. Looking at the `fraud_checks` table schema, three indexes are defined: `idx_user`, `idx_status`, and `idx_score`. Explain one concrete query that each index is optimized for.

### Hands-On Exercise

Design a seventh fraud rule called `new_account_high_value`. This rule should add risk points when a newly created account (less than 24 hours old) attempts a booking above a configurable dollar threshold. Write the TypeScript code for this rule following the pattern established by the existing six rules. Choose a point value and justify it relative to the existing rule weights, explaining how it interacts with the threshold boundaries (25, 50, 80).

---

## 25. GDPR & Data Privacy

> **Learning Objectives**
> - Articulate the legal requirements behind GDPR's "right to be forgotten" and why non-compliance carries fines up to 4% of global revenue.
> - Trace the deletion workflow through database transactions, Redis session cleanup, and audit logging.
> - Explain why `SCAN` is used instead of `KEYS` for Redis cleanup in production, and the performance implications of each.
> - Distinguish between hard deletion, soft deletion, and anonymization, and identify when each is appropriate.
> - Understand how PII hashing with a salt preserves audit integrity without retaining identifiable data.

**Why:** European regulations require data portability, right to be forgotten, and consent tracking. Non-compliance carries fines up to 4% of global revenue.

### Right to Be Forgotten Implementation

- Right to be forgotten implementation
- Data anonymization
- PII hashing
- Deletion request audit log

```typescript
export class GDPRService {
  async deleteUserData(userId: bigint, email: string): Promise<DeletionResult> {
    const connection = await db.getConnection();
    const deletedTables: string[] = [];

    try {
      await connection.beginTransaction();

      // Create deletion request audit record
      const [reqResult] = await connection.execute(`
        INSERT INTO gdpr_deletion_requests (user_id, email_hash, status)
        VALUES (?, ?, 'processing')
      `, [userId, this.hashPII(email, 'email')]);

      const requestId = reqResult.insertId;

      // Delete device fingerprints associated with user
      await connection.execute(`
        DELETE FROM device_fingerprints
        WHERE fingerprint_hash IN (
          SELECT DISTINCT device_fingerprint
          FROM fraud_checks WHERE user_id = ?
        )
      `, [userId]);
      deletedTables.push('device_fingerprints');

      // Anonymize fraud data (keep aggregate stats)
      await connection.execute(`
        UPDATE fraud_checks
        SET ip_address = '0.0.0.0',
            user_agent = 'ANONYMIZED',
            device_fingerprint = 'DELETED'
        WHERE user_id = ?
      `, [userId]);
      deletedTables.push('fraud_checks');

      // Soft-delete bookings (keep for legal/accounting obligations)
      await connection.execute(`
        UPDATE bookings
        SET deleted_at = NOW()
        WHERE user_id = ? AND deleted_at IS NULL
      `, [userId]);
      deletedTables.push('bookings');

      // Clear user sessions from Redis using SCAN (never use KEYS in production)
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
        cursor = nextCursor;
        for (const key of keys) {
          const session = await redis.get(key);
          if (session) {
            const parsed = JSON.parse(session);
            if (parsed.userId === userId.toString()) {
              await redis.del(key);
            }
          }
        }
      } while (cursor !== '0');

      // Mark request as completed
      await connection.execute(`
        UPDATE gdpr_deletion_requests
        SET processed_at = NOW(), status = 'completed', deleted_tables = ?
        WHERE id = ?
      `, [JSON.stringify(deletedTables), requestId]);

      await connection.commit();

      return { success: true, deletedTables, requestId };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private hashPII(data: string, category: string): string {
    const salt = process.env.PII_SALT;
    if (!salt) {
      throw new Error('PII_SALT environment variable is required for GDPR hashing');
    }
    return createHash('sha256')
      .update(`${category}:${salt}:${data.toLowerCase()}`)
      .digest('hex');
  }
}
```

### GDPR Deletion Request Table

```sql
CREATE TABLE gdpr_deletion_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    email_hash VARCHAR(64) NOT NULL,

    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',

    deleted_tables JSON,
    error_message TEXT,

    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,

    INDEX idx_user (user_id),
    INDEX idx_status (status)
);
```

### Key Takeaways

- GDPR deletion is not a simple `DELETE FROM users WHERE id = ?`. Different data categories require different treatment: personal identifiers are removed, fraud analytics are anonymized (to preserve aggregate security data), and bookings are soft-deleted (because financial records have legal retention requirements).
- The Redis session cleanup uses `SCAN` with a cursor-based approach instead of `KEYS` because `KEYS` blocks the Redis event loop and can cause a full production outage on large datasets. `SCAN` iterates incrementally with minimal performance impact.
- The audit trail itself must not contain PII. The `email_hash` field stores a salted SHA-256 hash of the email, which proves the deletion was performed for a specific user without retaining the actual email address.
- Wrapping the entire operation in a database transaction ensures atomicity: if any step fails, the partial deletion is rolled back and the request is not marked as completed, preventing a state where some data is deleted but the audit record says the operation never happened.
- The `hashPII` method uses a category prefix (`email:`, etc.) in the hash input to prevent cross-category hash collisions, and lowercases the input to ensure consistent hashing regardless of how the user originally entered their data.

### Review Questions

1. In the `deleteUserData` method, bookings are soft-deleted (`SET deleted_at = NOW()`) while device fingerprints are hard-deleted (`DELETE FROM`). Why the different treatment? Under what legal or business obligation might you need to retain booking records even after a GDPR deletion request?
2. The Redis session cleanup loop uses `SCAN` with `COUNT 100`. What does the `COUNT` parameter control, and what would happen if you set it to `COUNT 1000000`? Would it defeat the purpose of using `SCAN` over `KEYS`?
3. If the `PII_SALT` environment variable is not set, the `hashPII` method throws an error rather than falling back to unsalted hashing. Why is this an explicit failure the correct design choice?

### Hands-On Exercise

The current `deleteUserData` implementation handles `device_fingerprints`, `fraud_checks`, `bookings`, and Redis sessions. But a real platform also stores user data in notification preferences, saved payment methods, and search history tables. Extend the method to handle two additional tables: `notification_preferences` (should be hard-deleted) and `saved_payment_methods` (should be anonymized by replacing card details with `'REDACTED'` while keeping the record for chargeback reference). Write the SQL statements and add them to the transaction in the appropriate order.

---

# PART VI: OBSERVABILITY & OPERATIONS

You can't fix what you can't see. In a distributed system processing 100,000 bookings per minute across multiple regions, a problem in one service can cascade through the entire platform in seconds. By the time a user reports a failed booking, hundreds or thousands more may have already failed. Proactive observability -- the ability to understand the internal state of your system from its external outputs -- is the difference between a 30-second detection and a 30-minute outage.

This part covers the three pillars of observability and the operational processes that use them. Section 26 introduces metrics and alerting with Prometheus, including a tiered alert system that distinguishes between critical incidents (page the on-call engineer immediately), warnings (investigate within the hour), and informational signals (review during business hours). Section 27 covers distributed tracing with OpenTelemetry, which lets you follow a single booking request as it traverses the API gateway, booking service, inventory service, and payment service -- pinpointing exactly where latency spikes or errors occur. Section 28 formalizes Service Level Objectives (SLOs) and error budgets, giving teams a shared language for reliability targets.

Sections 29 and 30 shift from detection to response. Section 29 defines a structured incident response process with severity levels, escalation paths, and blameless post-mortems, because detecting a problem is only half the battle -- resolving it quickly and learning from it is the other half. Section 30 covers disaster recovery: RPO/RTO targets, multi-region failover procedures, and a testing schedule that ensures your disaster recovery plan actually works when you need it. Together, these sections transform observability data into operational action.

---

## 26. Monitoring & Alerting

> **Learning Objectives**
> - Understand the three pillars of observability (metrics, logs, traces) and why metrics are the first line of defense for proactive monitoring.
> - Read and interpret Prometheus metric definitions including Histograms, Counters, and Gauges, and know when to use each type.
> - Analyze a 3-tier alert rule configuration and explain why different severities require different response times and escalation paths.
> - Explain how histogram buckets are chosen and why the bucket boundaries for booking creation time differ from those for payment latency.
> - Identify the purpose of the `/metrics` endpoint in a Prometheus-based monitoring architecture.

**Why:** At 100,000 bookings/minute, you can't wait for users to report problems. Proactive monitoring catches issues before they impact customers. The three pillars of observability -- metrics, logs, and traces -- provide different lenses into system health.

### Prometheus Metrics

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

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', MetricsService.registry.contentType);
  res.end(await MetricsService.getMetrics());
});
```

### 3-Tier Alert Rules (Critical, Warning, Info)

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

### Key Takeaways

- Prometheus metric types serve different purposes: Counters track cumulative totals (bookings, revenue), Histograms capture latency distributions with configurable buckets, and Gauges represent current values that can go up or down (failure rates, circuit breaker state).
- The 3-tier alert system prevents alert fatigue. Critical alerts (booking success rate below 99.5%, oversell detected, infrastructure down) page engineers immediately. Warning alerts (high latency, replication lag) require investigation but not a 3 AM wake-up. Info alerts (volume spikes) provide situational awareness.
- The `InventoryOversellDetected` alert has `for: '0s'` -- it fires instantly on any single occurrence because even one oversell is a data integrity violation that demands immediate attention. Contrast this with `PaymentLatencyHigh` which requires the condition to persist for 5 minutes, filtering out transient spikes.
- The `/metrics` endpoint exposes all registered metrics in Prometheus exposition format, which Prometheus scrapes at a configured interval (typically 15-30 seconds). This pull-based model means the application does not need to know where the monitoring system lives.

### Review Questions

1. The `bookingCreationTime` histogram uses buckets `[0.1, 0.25, 0.5, 1, 2, 5, 10, 30]` while the `paymentLatency` histogram uses `[0.5, 1, 2, 5, 10]`. Why are the bucket boundaries different? What does this tell you about the expected latency profiles of these two operations?
2. The `BookingSuccessRateCritical` alert uses `rate(...[5m])` with a `for: '2m'` duration. What would happen if you changed the rate window to `[1m]`? How would that affect alert sensitivity and false-positive rates?
3. The `circuitBreakerState` metric uses a Gauge with values 0, 0.5, and 1. Why is a Gauge appropriate here instead of a Counter? How would you write a PromQL query to find all services with open circuit breakers?

### Hands-On Exercise

Add a new set of metrics to the `MetricsService` class for tracking GDPR deletion requests. Define: (1) a Counter for total deletion requests with labels for `status` (success, failure), (2) a Histogram for deletion processing duration with buckets appropriate for an operation that involves database transactions and Redis scans, and (3) a Gauge for pending deletion requests in the queue. Then write one critical alert rule and one warning alert rule that use these new metrics.

---

## 27. Distributed Tracing

> **Learning Objectives**
> - Explain why distributed tracing is essential when a single booking request touches 5 or more services.
> - Read OpenTelemetry span creation code and understand the parent-child relationship between spans.
> - Identify how span attributes (booking type, user ID, payment provider) enable filtering and debugging in a tracing UI like Jaeger.
> - Understand the OpenTelemetry SDK setup, including resource attributes, trace exporters, and automatic instrumentation.

**Why:** When a booking request touches 5+ services, you need to trace the full request path to identify bottlenecks and failures. Distributed tracing connects spans across service boundaries.

### Traced Booking Service

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
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not available' });
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
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }
}
```

### OpenTelemetry Setup

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
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger.monitoring:4318/v1/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

sdk.start();
```

### Key Takeaways

- Distributed tracing connects the dots across service boundaries. A single trace ID follows a booking request from the API gateway through the booking service, inventory service, and payment service, so you can see the full picture in one view.
- The parent-child span relationship is established through context propagation. The `createBooking` span is the parent; `checkAvailability` and `processPayment` are child spans. This hierarchy shows you exactly how time is spent within a request.
- Span attributes like `booking.type`, `payment.provider`, and `booking.id` are critical for debugging. They let you filter traces in Jaeger or Grafana Tempo by specific booking types, payment providers, or individual booking IDs to isolate production issues.
- The `finally` block ensures `span.end()` is always called, even when exceptions occur. An unclosed span leaks memory and produces incomplete traces that are harder to debug.
- Automatic instrumentation (`HttpInstrumentation`, `ExpressInstrumentation`) captures HTTP-level spans without code changes, while manual spans (like `checkAvailability` and `processPayment`) provide business-level context that automatic instrumentation cannot infer.

### Review Questions

1. In the `TracedBookingService`, the `availSpan` is created with `tracer.startSpan('checkAvailability')` without explicitly setting a parent. How does OpenTelemetry know that this span is a child of the `createBooking` span? What role does the `context.with(...)` call play?
2. If the `processPayment` call throws an exception, `paySpan.end()` is never called (it is on the line after the await). What problem does this create, and how would you fix it?
3. The OpenTelemetry SDK setup includes `HttpInstrumentation` and `ExpressInstrumentation`. What additional instrumentation libraries would you add for a service that also uses MySQL and Redis? Why is automatic instrumentation for these data stores valuable?

### Hands-On Exercise

The current `TracedBookingService` has child spans for `checkAvailability` and `processPayment`, but the `createBookingRecord` call has no dedicated span. Add a child span for `createBookingRecord` that includes attributes for the database operation (e.g., `db.system`, `db.operation`, `db.statement`). Then add error handling so that if the database insert fails, the span captures the exception and sets an error status before the error propagates to the parent span.

---

## 28. SLO/SLI Definitions

> **Learning Objectives**
> - Define SLI (Service Level Indicator), SLO (Service Level Objective), and error budget, and explain the relationship between them.
> - Read PromQL expressions that measure SLIs and understand what each query computes.
> - Calculate error budgets in minutes for a given SLO target over monthly, quarterly, and yearly windows.
> - Explain the difference between fast-burn and slow-burn error budget alerts and why both are necessary.
> - Understand why inventory accuracy has a stricter SLO (99.999%) than availability (99.99%).

**Why:** Service Level Objectives (SLOs) define the reliability targets. Service Level Indicators (SLIs) are the metrics that measure them. Error budgets determine how much unreliability is acceptable.

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
    measurement: 'rate(http_responses_total{status!~"5.."}[30d]) / rate(http_responses_total[30d])'
  },

  bookingLatency: {
    sli: 'P99 latency for successful booking creation',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.99, rate(booking_creation_duration_seconds_bucket{status="success"}[5m]))'
  },

  paymentLatency: {
    sli: 'P95 latency for payment processing',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.95, rate(payment_duration_seconds_bucket[5m]))'
  },

  searchLatency: {
    sli: 'P99 latency for search queries',
    slo: 0.5,  // 500ms
    measurement: 'histogram_quantile(0.99, rate(search_duration_seconds_bucket[5m]))'
  },

  inventoryAccuracy: {
    sli: 'Percentage of bookings without oversell incidents',
    slo: 0.99999,  // 99.999%
    measurement: '1 - (rate(inventory_oversell_attempts_total[30d]) / rate(bookings_total[30d]))'
  },

  dataFreshness: {
    sli: 'Maximum replication lag across all database replicas',
    slo: 5,  // 5 seconds
    measurement: 'max(mysql_slave_lag_seconds)'
  }
};

// Error budget burn rate alerts
export const burnRateAlerts = [
  {
    name: 'ErrorBudgetFastBurn',
    description: '2% of monthly error budget consumed in 1 hour',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[1h]) / rate(http_responses_total[1h])) > 14.4 * (1 - 0.9999)',
    severity: 'critical',
    window: '1h'
  },
  {
    name: 'ErrorBudgetSlowBurn',
    description: '5% of monthly error budget consumed in 6 hours',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[6h]) / rate(http_responses_total[6h])) > 6 * (1 - 0.9999)',
    severity: 'warning',
    window: '6h'
  }
];
```

### Key Takeaways

- SLOs translate business expectations into measurable engineering targets. A 99.99% availability SLO means the team has 4.32 minutes of error budget per month -- enough for a brief deployment hiccup but not enough for a prolonged outage.
- Different SLIs have different SLO targets because they carry different business impact. Inventory accuracy is set at 99.999% (stricter than availability) because an oversell means a customer arrives at a hotel with no room -- a far worse experience than a momentary API error.
- Burn rate alerts catch error budget consumption at two speeds. The fast-burn alert (2% of budget in 1 hour) catches sudden outages and pages immediately. The slow-burn alert (5% of budget in 6 hours) catches gradual degradation that might go unnoticed until the entire budget is exhausted.
- The PromQL measurement expressions are the single source of truth for SLI calculation. Every team member, from the on-call engineer to the VP of Engineering, can look at the same dashboard and agree on whether the SLO is being met.

### Review Questions

1. The availability SLO is 99.99%, which gives an error budget of 4.32 minutes per month. If a deployment causes 5xx errors for 3 minutes, what percentage of the monthly error budget has been consumed? Should the team proceed with further deployments that week?
2. The `ErrorBudgetFastBurn` alert multiplies `(1 - 0.9999)` by 14.4. Where does the number 14.4 come from? (Hint: think about the relationship between the 1-hour window, the monthly budget, and the 2% consumption threshold.)
3. The `bookingLatency` SLI uses P99 while `paymentLatency` uses P95. What is the practical difference? Why might the team choose a stricter percentile for booking latency than for payment latency?

### Hands-On Exercise

Your team wants to add an SLO for notification delivery: "99.9% of booking confirmation emails must be delivered within 60 seconds of booking completion." Define this SLO in the same format as the existing `sloDefinitions` object, including the `sli` description, `slo` target, `errorBudget` (calculate monthly/quarterly/yearly minutes), and a `measurement` PromQL expression. Then write a corresponding burn rate alert for fast-burn detection.

---

## 29. Incident Response

> **Learning Objectives**
> - Distinguish between P0, P1, P2, and P3 severity levels and articulate the escalation path for each.
> - Explain why blameless post-mortems focus on systemic failures rather than individual mistakes.
> - Read the `IncidentManager` code and trace the notification flow from incident declaration to channel-specific alerts.
> - Understand the purpose of response time targets and update frequency requirements at each severity level.

**Why:** When things go wrong at scale (and they will), a structured incident response process minimizes impact. Severity levels determine who gets paged and how quickly.

### Incident Response Plan

```typescript
export const incidentResponsePlan = {
  severityLevels: {
    P0: {
      description: 'Complete service outage or data loss',
      examples: ['All bookings failing', 'Database corruption', 'Payment double-charging'],
      responseTime: '5 minutes',
      notifyChannels: ['PagerDuty', 'Phone Tree', 'Executive Slack'],
      teamRequired: ['On-call engineer', 'Tech Lead', 'VP Engineering'],
      updateFrequency: 'Every 15 minutes'
    },
    P1: {
      description: 'Major feature degradation affecting >10% of users',
      examples: ['One region down', 'Payment provider failing', 'Search errors'],
      responseTime: '15 minutes',
      notifyChannels: ['PagerDuty', 'Slack #incidents'],
      teamRequired: ['On-call engineer', 'Tech Lead'],
      updateFrequency: 'Every 30 minutes'
    },
    P2: {
      description: 'Minor feature degradation affecting <10% of users',
      examples: ['Elevated error rates', 'Slow responses', 'One shard degraded'],
      responseTime: '1 hour',
      notifyChannels: ['Slack #incidents'],
      teamRequired: ['On-call engineer'],
      updateFrequency: 'Every 2 hours'
    },
    P3: {
      description: 'Non-urgent issue with workaround available',
      examples: ['Monitoring gaps', 'Non-critical alert noise'],
      responseTime: 'Next business day',
      notifyChannels: ['Slack #platform'],
      teamRequired: ['Assigned engineer'],
      updateFrequency: 'Daily'
    }
  },

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
};
```

### Incident Communication

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

### Key Takeaways

- Severity levels are not about how bad the bug is -- they are about customer impact and urgency. A P0 (complete outage, data loss, double-charging) requires VP-level involvement and 5-minute response because every second of delay affects all users. A P3 (monitoring gap) can wait until the next business day because users are not impacted.
- The escalation path widens with severity: P2 involves only the on-call engineer, P1 adds the Tech Lead, and P0 adds the VP of Engineering and triggers a phone tree. This ensures the right people are involved without over-mobilizing for minor issues.
- Blameless post-mortems are a deliberate cultural choice. Blaming individuals discourages reporting and honest analysis. Focusing on systemic failures (missing tests, inadequate monitoring, unclear runbooks) produces action items that prevent recurrence.
- The 48-hour deadline for post-mortems ensures lessons are captured while the incident is fresh. Without a deadline, post-mortems get deprioritized and the team loses the opportunity to learn.
- Update frequency requirements keep stakeholders informed and prevent the "what's happening?" interruptions that slow down the responders.

### Review Questions

1. A payment provider starts returning errors for 15% of transactions in the EU region, but the US and Asia regions are unaffected. Based on the severity level definitions, is this a P0, P1, or P2? Justify your answer by referencing the specific thresholds in the plan.
2. The `IncidentManager.declareIncident` method stores `affected_services` as a JSON string. Why is this stored as JSON rather than in a separate join table? What are the trade-offs of this approach for querying and reporting?
3. The post-mortem template includes both "What Went Well" and "What Went Wrong." Why is the "What Went Well" section important in a post-mortem? What would happen if the template only focused on failures?

### Hands-On Exercise

Write a method `escalateIncident` for the `IncidentManager` class that upgrades an incident's severity (e.g., from P2 to P1). The method should: (1) update the severity in the database, (2) determine the new notification channels by comparing the old and new severity configurations, (3) notify only the channels that are new (e.g., if escalating from P2 to P1, notify PagerDuty since P2 only uses Slack), and (4) log the escalation with a timestamp and reason. Include the TypeScript method signature, SQL update, and notification logic.

---

## 30. Disaster Recovery

> **Learning Objectives**
> - Define RPO (Recovery Point Objective) and RTO (Recovery Time Objective) and explain their relationship to business requirements.
> - Trace the automatic failover sequence from health check failure to DNS rotation removal to traffic absorption.
> - Understand the data replication strategies for each storage tier (database, Kafka, Redis) and why they differ.
> - Explain the difference between automatic and manual failover and when each is appropriate.
> - Read the CloudFormation YAML for Route53 health checks and weighted DNS records.

**Why:** Regional failures (AWS outage, natural disaster) can take down an entire datacenter. Active-active multi-region deployment with automated failover ensures bookings continue even during regional outages.

### Disaster Recovery Plan

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

  testingSchedule: {
    tableTopExercise: 'Monthly',
    failoverDrill: 'Quarterly',
    fullRegionFailover: 'Annually',
    chaosEngineering: 'Weekly (non-production), Monthly (production)'
  }
};
```

### DNS Failover Configuration

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

### Key Takeaways

- RPO and RTO are business-driven targets, not just technical metrics. An RPO of less than 1 second means the business cannot tolerate losing even a single booking's data. An RTO of less than 5 minutes means the business can survive a brief interruption but not a prolonged one.
- The automatic failover sequence is designed for speed: health check failure detection (30 seconds) followed by DNS rotation removal (30 seconds) followed by traffic absorption (2-3 minutes). Each step is timed and automated because human response at 3 AM takes too long.
- Different storage tiers have different replication strategies because they have different consistency requirements. The database uses synchronous replication within a region (strong consistency for bookings) and asynchronous cross-region (eventual consistency with sub-second lag). Redis uses application-level rebuild from the database cross-region because cache data is expendable -- it can be regenerated.
- A disaster recovery plan that is never tested is not a plan -- it is a wish. The testing schedule escalates from tabletop exercises (monthly) through failover drills (quarterly) to full region failover (annually), building confidence that the plan actually works under real conditions.
- The gradual traffic restoration in manual failover (10% to 50% to 100%) prevents overwhelming a recovering region, which could cause a secondary outage.

### Review Questions

1. The RPO target is "less than 1 second" but the worst case is "less than 5 seconds." What causes this gap? Under what specific conditions would the system experience the worst-case RPO rather than the target?
2. In the CloudFormation YAML, the health check has `RequestInterval: 10` and `FailureThreshold: 3`. How many seconds, at minimum, will pass between a real failure occurring and Route53 removing the region from rotation? Walk through the timing.
3. Redis replication cross-region is described as "application-level rebuild from database" rather than using Redis's own cross-region replication. What are the advantages and disadvantages of this approach compared to running a cross-region Redis replication cluster?

### Hands-On Exercise

The current disaster recovery plan covers the failover procedure but does not address the "failback" procedure -- bringing a recovered region back into rotation after a failure has been resolved. Write a `failbackProcedure` object (in the same TypeScript format as `failoverProcedure`) that includes: (1) pre-conditions that must be met before restoring traffic (health checks, data sync verification, capacity confirmation), (2) a gradual traffic restoration sequence with specific percentage steps and monitoring checkpoints, and (3) a rollback plan in case the recovered region shows problems during failback. Reference the existing DR plan's concepts (Route53 weights, health check thresholds) in your design.
# PART VII: INFRASTRUCTURE & DEPLOYMENT

Moving from architecture and application design to the physical infrastructure that runs the Global Booking System, this part addresses the operational realities of deploying and maintaining a system that processes 1,666 bookings per second across four geographic regions. Capacity planning, Kubernetes orchestration, CI/CD pipelines, Infrastructure as Code, and local development environments are not afterthoughts -- they are first-class engineering concerns that determine whether the system survives its first traffic spike or collapses under load.

The sections that follow take a "why before how" approach to infrastructure. Section 31 begins with capacity planning and cost analysis, because sizing decisions made before a single line of Terraform is written determine whether the system over-spends on idle resources or under-provisions and suffers outages. Section 32 covers Kubernetes deployment manifests that encode production-hardened patterns -- init containers, pod anti-affinity, disruption budgets -- that distinguish a weekend project from a production-grade platform. Section 33 walks through the CI/CD pipeline that gates every deployment with tests, builds, and smoke checks, because at this scale a broken deploy across 132 nodes can cost millions in lost bookings.

Section 34 introduces Infrastructure as Code with Terraform and Helm, ensuring that every resource is version-controlled and reproducible -- if a region is destroyed, it can be recreated from code. Finally, Section 35 covers local development setup with Docker Compose, because developers who cannot run the system locally cannot iterate quickly. Together, these five sections bridge the gap between "the architecture works on a whiteboard" and "the architecture works in production under real traffic."

---

## 31. Capacity Planning & Cost Analysis

> **Learning Objectives**
> - Understand how to model traffic patterns including peak load, geographic distribution, and seasonal variation
> - Learn how to size database, Redis, Kafka, and Kubernetes clusters based on throughput requirements
> - Recognize why KRaft mode replaces ZooKeeper in modern Kafka deployments and the cost savings it provides
> - Calculate per-booking infrastructure cost and total system cost across multiple regions
> - Evaluate trade-offs between over-provisioning (wasted spend) and under-provisioning (outage risk)

**Why:** Understanding infrastructure costs and capacity limits is essential for budget planning and ensuring the system can handle peak loads without over-provisioning. Without this analysis, teams either over-spend on idle resources or under-provision and suffer outages during peak traffic. Every dollar of infrastructure cost must be justified by the traffic it serves.

### Traffic Model

```typescript
export const trafficModel = {
  peak: {
    bookingsPerSecond: 1666,
    bookingsPerMinute: 100000,
    bookingsPerHour: 6000000
  },
  average: {
    bookingsPerSecond: 800,
    bookingsPerMinute: 48000,
    bookingsPerHour: 2880000
  },
  readWriteRatio: { reads: 0.70, writes: 0.30 },
  geographic: {
    'us-east-1': 0.35,
    'eu-west-1': 0.30,
    'ap-southeast-1': 0.25,
    'sa-east-1': 0.10
  },
  seasonal: {
    highSeason: { months: [6, 7, 8, 12], multiplier: 1.8 },
    lowSeason: { months: [1, 2, 3, 9, 10, 11], multiplier: 0.8 }
  },
  bookingTypes: {
    hotel: 0.45, flight: 0.35, car: 0.15, package: 0.05
  }
};
```

### Database Capacity

**Why:** The database is the most expensive and hardest-to-scale component. Sizing it correctly avoids both wasted spend and emergency migrations under load.

```typescript
export const databaseCapacity = {
  shards: 16,
  instanceType: 'db.r6g.4xlarge',
  specs: {
    vcpus: 16,
    memory: '128 GB',
    network: '10 Gbps',
    storage: {
      type: 'io2',
      size: '3 TB per shard',
      iops: 64000
    }
  },
  replication: {
    readReplicas: 4,       // per shard
    crossRegionReplicas: 1 // per shard
  },
  capacity: {
    writesPerSecond: 4000, // per shard
    readsPerSecond: 16000, // per shard (across replicas)
    totalWritesPerSecond: 64000,
    totalReadsPerSecond: 256000
  },
  monthlyCost: {
    primaryInstances: 16 * 2400,      // $38,400
    readReplicas: 16 * 4 * 2400,      // $153,600
    crossRegionReplicas: 16 * 3200,   // $51,200
    storage: 16 * 5 * 1000,           // $80,000
    iops: 16 * 5 * 640,              // $51,200
    backups: 16 * 800,               // $12,800
    dataTransfer: 16 * 7300,         // $116,800
    total: 504000                     // ~$504,000/month
  }
};
```

### Redis Capacity

**Why:** Redis serves multiple distinct workloads (sessions, locks, caching, rate limiting). Isolating them into separate clusters prevents a cache stampede from affecting distributed locking.

```typescript
export const redisCapacity = {
  clusters: {
    sessions: {
      nodeType: 'cache.r6g.xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200
    },
    fencing: {
      nodeType: 'cache.r6g.xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200
    },
    cache: {
      nodeType: 'cache.r6g.2xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 5400
    },
    rateLimiting: {
      nodeType: 'cache.r6g.large',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 3600
    }
  },
  totalMonthlyCost: 17400  // ~$17,400/month
};
```

### Kafka Capacity (KRaft Mode)

**Why:** Kafka is the backbone of event-driven communication between services. Correct broker sizing determines whether events flow in real time or back up during peak load. Using KRaft mode (Kafka 3.3+) eliminates the operational overhead of maintaining a separate ZooKeeper ensemble.

```typescript
export const kafkaCapacity = {
  brokers: {
    count: 15,
    instanceType: 'kafka.m5.2xlarge',
    specs: {
      cpu: '8 vCPUs per broker',
      memory: '32 GB per broker',
      storage: { type: 'gp3', size: '4 TB per broker', iops: 16000 }
    },
    configuration: {
      'num.network.threads': 8,
      'num.io.threads': 16,
      'log.retention.hours': 720,
      'compression.type': 'lz4',
      'min.insync.replicas': 2
    }
  },

  // KRaft mode -- NO ZooKeeper needed (Kafka 3.3+)
  controller: {
    mode: 'KRaft',
    description: 'Kafka Raft consensus replaces ZooKeeper for metadata management',
    controllerNodes: 3,  // Dedicated controller nodes
    configuration: {
      'process.roles': 'controller',
      'controller.quorum.voters': '1@controller-1:9093,2@controller-2:9093,3@controller-3:9093',
      'controller.listener.names': 'CONTROLLER',
      'listeners': 'CONTROLLER://:9093'
    },
    benefits: [
      'Eliminates ZooKeeper operational overhead',
      'Faster metadata operations',
      'Simpler deployment (no separate ensemble)',
      'Better partition scalability (millions vs hundreds of thousands)',
      'Reduced infrastructure cost (-$1,500/month)'
    ]
  },

  topics: {
    'booking-events': { partitions: 200, replicationFactor: 3, retentionDays: 30 },
    'payment-events': { partitions: 100, replicationFactor: 3, retentionDays: 90 },
    'inventory-events': { partitions: 150, replicationFactor: 3, retentionDays: 7 },
    'inventory-reservations-global': { partitions: 100, replicationFactor: 3, retentionDays: 1 },
    'notification-events': { partitions: 80, replicationFactor: 3, retentionDays: 3 }
  },

  monthlyCost: {
    brokers: 15000,
    controllers: 900,      // 3 KRaft controllers (much cheaper than ZooKeeper)
    storage: 12000,
    dataTransfer: 5000,
    total: 32900            // Saved $600/month vs ZooKeeper
  }
};
```

> **Common Mistake: Using ZooKeeper with Kafka 3.3+**
> An earlier version of this architecture specified a 5-node ZooKeeper ensemble for Kafka metadata management. Since Kafka 3.3+ (and production-ready in 3.5+), ZooKeeper has been deprecated in favor of KRaft (Kafka Raft) mode. KRaft eliminates the operational overhead of maintaining a separate ZooKeeper cluster, provides faster metadata operations, and reduces infrastructure cost. Always use KRaft mode for new deployments.

### Kubernetes Capacity

**Why:** K8s node sizing determines how many pods can be scheduled per node. Under-sizing leads to scheduling failures during scale-up events; over-sizing wastes money on idle CPU.

```typescript
export const k8sCapacity = {
  nodesPerRegion: {
    workerNodes: {
      instanceType: 'c6i.4xlarge',
      count: 30,
      specs: { cpu: 16, memory: '32 GB' }
    },
    systemNodes: {
      instanceType: 'm6i.2xlarge',
      count: 3,
      specs: { cpu: 8, memory: '32 GB' }
    }
  },
  regions: 4,
  totalNodes: 33 * 4,  // 132 nodes across 4 regions
  monthlyCost: {
    workerNodes: 30 * 4 * 500,   // $60,000
    systemNodes: 3 * 4 * 350,    // $4,200
    loadBalancers: 4 * 500,      // $2,000
    natGateways: 4 * 400,        // $1,600
    ebs: 4 * 1200,               // $4,800
    total: 72500                  // ~$72,500/month
  }
};
```

### Total System Cost Summary

**Why:** Knowing the total cost per booking lets the business set pricing floors and evaluate the ROI of infrastructure investments.

```typescript
export const totalSystemCost = {
  monthly: {
    database: 504000,
    redis: 17400,
    kafka: 32900,        // KRaft mode (no ZooKeeper -- saved $1,500/month)
    kubernetes: 72500,
    cdn: 25000,
    monitoring: 15000,
    logging: 12000,
    dns: 2000,
    secrets: 1000,
    cicd: 3000,
    support: 15000,
    miscellaneous: 10000,
    reserveBuffer: 150000,

    subtotal: 859800,
    regions: 4,
    multiRegionMultiplier: 1.7,  // Not all services replicate fully

    total: 1470000               // ~$1.47M/month
  },

  perBooking: {
    monthlyBookings: 70000000,   // ~70M bookings/month
    costPerBooking: 0.021        // ~$0.021 per booking
  },

  annualTotal: 17640000          // ~$17.6M/year
};
```

### Key Takeaways

- The database is the single largest cost center (~$504K/month), driven by 16 shards with 4 read replicas each and cross-region replication. Sizing it correctly is the highest-leverage cost decision.
- Isolating Redis into four purpose-specific clusters (sessions, fencing, cache, rate limiting) costs marginally more than a single cluster but prevents catastrophic cross-workload interference.
- KRaft mode eliminates ZooKeeper entirely for Kafka 3.3+ deployments, reducing both operational complexity and infrastructure cost by ~$1,500/month.
- The total system cost of ~$1.47M/month yields a per-booking cost of $0.021 -- a number the business needs to set pricing floors and evaluate infrastructure ROI.
- The 1.7x multi-region multiplier reflects the reality that not all services replicate fully across all four regions; some resources (CDN, DNS) are inherently global.

### Review Questions

1. **Conceptual:** Why are Redis workloads (sessions, fencing, cache, rate limiting) separated into distinct clusters rather than served by a single large cluster? What failure scenario does this isolation prevent?
2. **Code Reading:** In the `trafficModel` configuration, the seasonal high-season multiplier is 1.8 and the peak bookings-per-second is 1,666. What is the effective peak bookings-per-second during high season, and how should this number influence your capacity planning?
3. **Conceptual:** The `multiRegionMultiplier` is 1.7 rather than 4.0 (the number of regions). Explain why total cost does not scale linearly with the number of regions.

### Hands-On Exercise

**Exercise: Build a Capacity Cost Calculator.** Using the `totalSystemCost` configuration as your baseline, write a TypeScript function `estimateMonthlyCost(bookingsPerMonth: number, regions: number): { totalCost: number, costPerBooking: number }` that scales each infrastructure component proportionally to the number of bookings (relative to the 70M baseline) and the number of regions (using the 1.7x multiplier logic). Test it with inputs of 35M bookings / 2 regions and 140M bookings / 4 regions, and verify that the per-booking cost changes non-linearly due to fixed costs like DNS and support.

---

## 32. Kubernetes Deployment

> **Learning Objectives**
> - Understand the purpose of each component in a production Kubernetes manifest: Deployment, Service, HPA, and PodDisruptionBudget
> - Learn how init containers, liveness/readiness probes, and preStop hooks ensure safe deployments and graceful shutdowns
> - Recognize why pod anti-affinity rules distribute replicas across nodes for fault tolerance
> - Understand HPA scaling behavior configuration including stabilization windows
> - Read and interpret resource requests and limits for CPU and memory

**Why:** Kubernetes provides declarative infrastructure, auto-scaling, self-healing, and rolling deployments. Each microservice runs as a Deployment with HPA for automatic scaling. The manifests below encode production-hardened patterns: init containers for migrations, anti-affinity for fault tolerance, graceful shutdown via preStop hooks, and pod disruption budgets for safe node maintenance.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: production
spec:
  replicas: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 5
      maxUnavailable: 2
  selector:
    matchLabels:
      app: booking-service
  template:
    metadata:
      labels:
        app: booking-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
    spec:
      serviceAccountName: booking-service
      initContainers:
        - name: db-migrations
          image: registry.company.com/booking-service:${VERSION}
          command: ['npm', 'run', 'migrate']
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:${VERSION}
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3000"
            - name: REGION
              value: "us-east-1"
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: [booking-service]
                topologyKey: kubernetes.io/hostname
---
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  selector:
    app: booking-service
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: booking-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: booking-service
  minReplicas: 15
  maxReplicas: 40
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
    scaleUp:
      stabilizationWindowSeconds: 0
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: booking-service-pdb
  namespace: production
spec:
  minAvailable: "75%"
  selector:
    matchLabels:
      app: booking-service
```

### Key Takeaways

- The `preStop` hook with `sleep 15` gives in-flight requests time to complete before the pod is terminated, preventing dropped connections during rolling updates.
- Pod anti-affinity with `topologyKey: kubernetes.io/hostname` ensures that booking-service replicas are spread across different nodes, so a single node failure does not take down multiple replicas.
- The HPA uses asymmetric stabilization windows -- scale-up is immediate (`0` seconds) to respond to traffic spikes, while scale-down waits 300 seconds to avoid thrashing during fluctuating load.
- The PodDisruptionBudget guarantees that at least 75% of pods remain available during voluntary disruptions (node drains, cluster upgrades), preventing maintenance operations from causing outages.
- Init containers run database migrations before the main container starts, ensuring the application never boots against an outdated schema.

### Review Questions

1. **Code Reading:** The Deployment specifies `maxSurge: 5` and `maxUnavailable: 2` with `replicas: 20`. During a rolling update, what is the maximum number of pods that can exist simultaneously, and what is the minimum number that will be serving traffic?
2. **Conceptual:** Why does the readiness probe use a different path (`/ready`) than the liveness probe (`/health`)? What is the operational difference between a pod that fails its readiness probe versus one that fails its liveness probe?
3. **Conceptual:** The HPA's `scaleDown.stabilizationWindowSeconds` is 300 but `scaleUp.stabilizationWindowSeconds` is 0. Why is this asymmetry intentional, and what problem would symmetric scale-down at 0 seconds cause?

### Hands-On Exercise

**Exercise: Add a Memory-Based HPA Metric.** Extend the HorizontalPodAutoscaler manifest to include a second metric that scales based on memory utilization at 80%. Then add a new `topologySpreadConstraints` section to the Deployment that enforces a `maxSkew` of 1 across availability zones (using `topology.kubernetes.io/zone` as the topology key). Write out the complete modified YAML and explain how the two scaling metrics interact -- specifically, which metric "wins" when CPU is below threshold but memory is above.

---

## 33. CI/CD Pipeline

> **Learning Objectives**
> - Understand the four-stage CI/CD pipeline structure: test, build, deploy-staging, deploy-production
> - Learn why blue-green deployment with manual production gates is essential at scale
> - Recognize the role of smoke tests in validating a deployment before traffic switching
> - Understand how container image tagging by commit SHA ensures traceability from deployment back to source code
> - Evaluate the cost of a broken deployment across 132 nodes and 4 regions

**Why:** Continuous integration catches bugs early. Continuous deployment gets fixes to production quickly. At this scale, every deployment must be safe, reversible, and observable. A broken deploy to 132 nodes across 4 regions can cost millions in lost bookings, so the pipeline enforces gates at every stage.

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build
  - deploy-staging
  - deploy-production

test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run lint
    - npm run test:unit
    - npm run test:integration
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'

build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build -t $REGISTRY/booking-service:$CI_COMMIT_SHA .
    - docker push $REGISTRY/booking-service:$CI_COMMIT_SHA
  only:
    - main
    - develop

deploy-staging:
  stage: deploy-staging
  script:
    - kubectl set image deployment/booking-service booking-service=$REGISTRY/booking-service:$CI_COMMIT_SHA -n staging
    - kubectl rollout status deployment/booking-service -n staging
  only:
    - develop

deploy-production:
  stage: deploy-production
  script:
    - kubectl apply -f k8s/booking-service-green.yaml
    - ./scripts/run-smoke-tests.sh green
    - kubectl patch service booking-service -p '{"spec":{"selector":{"version":"green"}}}'
  when: manual
  only:
    - main
```

### Key Takeaways

- Tagging container images with `$CI_COMMIT_SHA` instead of `latest` creates a direct link from any running pod back to the exact source commit, making debugging and rollback trivial.
- The production deployment uses a blue-green strategy: the "green" version is deployed and smoke-tested before traffic is switched, so a failed smoke test never reaches real users.
- The `when: manual` gate on production deployment ensures a human reviews staging results before production rollout -- automation handles execution, but a human owns the decision.
- The test stage runs linting, unit tests, and integration tests in sequence; a failure at any step blocks the build, preventing known-broken code from being containerized.
- Staging deployment uses `kubectl rollout status` to block the pipeline until the rollout completes or fails, providing immediate feedback rather than silent failures.

### Review Questions

1. **Code Reading:** The `build` stage runs on both `main` and `develop` branches, but `deploy-staging` only runs on `develop` and `deploy-production` only on `main`. Trace the path a feature takes from a developer's branch to production -- what are all the gates it must pass?
2. **Conceptual:** Why does the production deployment apply a separate `booking-service-green.yaml` manifest and run smoke tests before patching the service selector, rather than using `kubectl set image` directly as the staging deployment does?
3. **Conceptual:** If the smoke tests fail after `kubectl apply -f k8s/booking-service-green.yaml` but before `kubectl patch service`, what is the state of the system? Is production affected? How would you clean up the failed green deployment?

### Hands-On Exercise

**Exercise: Add a Canary Stage.** Insert a `deploy-canary` stage between `deploy-staging` and `deploy-production` in the GitLab CI pipeline. The canary stage should: (1) deploy the new version to 5% of production pods using a separate canary Deployment, (2) run a 10-minute observation window checking error rate and p99 latency via a `./scripts/check-canary-metrics.sh` script, and (3) automatically roll back the canary if metrics exceed thresholds. Write the complete YAML for this new stage and explain how it reduces the blast radius of a bad deployment compared to the current blue-green approach.

---

## 34. Infrastructure as Code

> **Learning Objectives**
> - Understand why all infrastructure must be defined in code for reproducibility, version control, and disaster recovery
> - Learn how Terraform modules encapsulate reusable infrastructure patterns like database shards with replicas
> - Read Terraform HCL and understand resource relationships, variables, and parameter groups
> - Understand how Helm chart values externalize Kubernetes configuration for environment-specific overrides
> - Recognize the relationship between Terraform (infrastructure provisioning) and Helm (application deployment)

**Why:** All infrastructure should be defined in code for reproducibility, version control, and disaster recovery. If a region is destroyed, we should be able to recreate it from code. Manual infrastructure changes are forbidden -- every resource is managed by Terraform and every application configuration by Helm.

### Terraform Module: MySQL Shard

```hcl
# terraform/modules/mysql-shard/main.tf

variable "shard_number" {
  type = number
}

variable "region" {
  type = string
}

variable "instance_class" {
  type    = string
  default = "db.r6g.4xlarge"
}

resource "aws_db_instance" "primary" {
  identifier     = "booking-shard-${var.shard_number}-primary"
  engine         = "mysql"
  engine_version = "8.0"
  instance_class = var.instance_class

  allocated_storage     = 3000
  max_allocated_storage = 6000
  storage_type          = "io2"
  iops                  = 64000

  db_name  = "booking_shard_${var.shard_number}"
  username = "booking_admin"
  password = data.aws_secretsmanager_secret_version.db_password.secret_string

  multi_az               = true
  backup_retention_period = 35

  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.db.name

  parameter_group_name = aws_db_parameter_group.booking.name

  tags = {
    Environment = "production"
    Shard       = var.shard_number
    Region      = var.region
    ManagedBy   = "terraform"
  }
}

resource "aws_db_instance" "replica" {
  count = 4

  identifier          = "booking-shard-${var.shard_number}-replica-${count.index + 1}"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.instance_class

  tags = {
    Environment = "production"
    Shard       = var.shard_number
    Role        = "replica"
    ReplicaIndex = count.index + 1
  }
}

resource "aws_db_parameter_group" "booking" {
  family = "mysql8.0"
  name   = "booking-shard-${var.shard_number}"

  parameter {
    name  = "innodb_buffer_pool_size"
    value = "107374182400"  # 100GB
  }

  parameter {
    name  = "max_connections"
    value = "5000"
  }

  parameter {
    name  = "innodb_flush_log_at_trx_commit"
    value = "1"
  }
}
```

### Helm Chart Values

```yaml
# helm/booking-service/values.yaml
replicaCount: 20

image:
  repository: registry.company.com/booking-service
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 3000

resources:
  requests:
    cpu: 1000m
    memory: 2Gi
  limits:
    cpu: 2000m
    memory: 4Gi

autoscaling:
  enabled: true
  minReplicas: 15
  maxReplicas: 40
  targetCPUUtilizationPercentage: 70

env:
  NODE_ENV: production
  PORT: "3000"

secrets:
  - name: DATABASE_URL
    secretName: booking-service-secrets
    key: database-url
  - name: REDIS_URL
    secretName: booking-service-secrets
    key: redis-url

probes:
  liveness:
    path: /health
    initialDelaySeconds: 30
  readiness:
    path: /ready
    initialDelaySeconds: 10
```

### Key Takeaways

- The Terraform module creates one primary instance and four replicas per shard using `count = 4`, matching the capacity plan from Section 31. Changing `count` to 6 would add replicas across all 16 shards simultaneously.
- The `innodb_buffer_pool_size` is set to 100GB (out of 128GB total memory) because InnoDB performance is directly proportional to how much of the working set fits in the buffer pool. This leaves 28GB for OS, connections, and other MySQL internals.
- `innodb_flush_log_at_trx_commit = 1` ensures every committed transaction is flushed to disk, trading throughput for durability -- the correct trade-off for a financial booking system.
- Helm values externalize environment-specific configuration (replica counts, resource limits, image tags) so the same chart can deploy to staging with 3 replicas and production with 20.
- The `ManagedBy = "terraform"` tag acts as a guard: if anyone manually modifies a resource in the AWS console, the tag mismatch makes the drift immediately visible during `terraform plan`.

### Review Questions

1. **Code Reading:** The Terraform module sets `max_allocated_storage = 6000` and `allocated_storage = 3000`. What does this achieve in AWS RDS, and why is it preferable to setting `allocated_storage = 6000` from the start?
2. **Conceptual:** The Helm values file sets `pullPolicy: IfNotPresent` but the CI/CD pipeline tags images with `$CI_COMMIT_SHA`. Why does this combination work correctly, and what would go wrong if images were tagged with `latest` instead?
3. **Code Reading:** The parameter group sets `max_connections = 5000`. Given that each shard has 1 primary + 4 replicas, and the booking service has up to 40 pods connecting to each shard, is 5000 connections sufficient? Show your reasoning.

### Hands-On Exercise

**Exercise: Write a Terraform Module for Redis Clusters.** Using the `redisCapacity` configuration from Section 31 as your specification, write a Terraform module (`terraform/modules/redis-cluster/main.tf`) that creates an ElastiCache Redis cluster. The module should accept variables for `cluster_name`, `node_type`, `num_shards`, `replicas_per_shard`, and `region`. Include a `aws_elasticache_replication_group` resource with automatic failover enabled and encryption at rest. Then write a `main.tf` that calls this module four times (once for each Redis workload: sessions, fencing, cache, rate limiting) with the appropriate values from Section 31.

---

## 35. Local Development Setup

> **Learning Objectives**
> - Understand why a local development environment must mirror production dependencies (MySQL, Redis, Kafka, Elasticsearch, Jaeger)
> - Learn how Docker Compose provides a single-command setup for all service dependencies
> - Recognize the use of KRaft mode in local Kafka configuration (no ZooKeeper container needed)
> - Understand the role of seed data scripts in ensuring consistent, reproducible development environments
> - Evaluate how volume mounts and init scripts automate database initialization

**Why:** Developers need a fast, consistent local environment that mirrors production. Docker Compose provides all dependencies locally so engineers can develop and test without cloud access. A developer should be able to clone the repo and run `docker-compose up` to have a working system in under two minutes.

```yaml
# docker-compose.yml
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpassword
      MYSQL_DATABASE: booking_dev
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    command: --default-authentication-plugin=mysql_native_password

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_LOG_DIRS: /tmp/kraft-combined-logs
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'
    ports:
      - "9092:9092"

  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"

  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"
      - "4318:4318"

volumes:
  mysql_data:
```

### Seed Data Script

**Why:** Every developer needs realistic test data to work with. A seed script ensures everyone starts from the same baseline, and new engineers can immediately see the system working end-to-end.

```typescript
// scripts/seed-dev-data.ts

async function seedDevelopmentData() {
  console.log('Seeding development database...');

  // Create lookup tables
  await db.execute(`
    INSERT INTO booking_types (code, name) VALUES
    ('hotel', 'Hotel'), ('flight', 'Flight'), ('car', 'Car Rental')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  await db.execute(`
    INSERT INTO currencies (code, name, symbol) VALUES
    ('USD', 'US Dollar', '$'), ('EUR', 'Euro', '€'),
    ('GBP', 'British Pound', '£'), ('JPY', 'Japanese Yen', '¥')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  await db.execute(`
    INSERT INTO payment_providers (code, name, is_active) VALUES
    ('stripe', 'Stripe', TRUE), ('paypal', 'PayPal', TRUE)
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  // Create sample inventory
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    await db.execute(`
      INSERT INTO inventory (resource_type, resource_id, resource_date, total_quantity, available_quantity, base_price, currency)
      VALUES ('hotel_room', 1, ?, 20, 20, 150.00, 'USD')
      ON DUPLICATE KEY UPDATE total_quantity = 20
    `, [dateStr]);
  }

  console.log('Seed data complete.');
}
```

### Key Takeaways

- The local Kafka container uses KRaft mode (`KAFKA_PROCESS_ROLES: broker,controller`) just like production, so developers work with the same architecture they will deploy to. There is no ZooKeeper container.
- MySQL uses a volume mount (`mysql_data`) for data persistence across container restarts, and an init script (`init-db.sql`) mounted into `/docker-entrypoint-initdb.d/` for automatic schema creation on first run.
- The seed script uses `ON DUPLICATE KEY UPDATE` for idempotency -- running it multiple times does not create duplicate data, which means developers can re-seed safely after schema changes.
- Elasticsearch runs in single-node mode with security disabled for local development simplicity. This is acceptable locally but must never be replicated in production configuration.
- Jaeger provides local distributed tracing on port 16686, allowing developers to visualize request flows across services without deploying a full observability stack.

### Review Questions

1. **Code Reading:** The Kafka container sets `KAFKA_PROCESS_ROLES: broker,controller` while production uses separate controller nodes with `process.roles: controller`. Why is combining broker and controller roles acceptable for local development but not for production?
2. **Conceptual:** The seed script creates 30 days of inventory data starting from "today." What problem does this create for automated tests that run on different dates, and how would you modify the script to make tests deterministic?
3. **Code Reading:** The Docker Compose file maps port `4318` for Jaeger. Looking at the OpenTelemetry standard, what protocol does this port serve, and how would the booking service be configured to send traces to this endpoint?

### Hands-On Exercise

**Exercise: Add a Health Check and Dependency Ordering.** Modify the Docker Compose file to add `healthcheck` definitions for MySQL (using `mysqladmin ping`) and Redis (using `redis-cli ping`). Then add `depends_on` with `condition: service_healthy` to the Kafka service (depends on nothing) and create a new `booking-service` container entry that depends on all four infrastructure services being healthy. Write the complete modified `docker-compose.yml` and test that `docker-compose up` starts services in the correct order.

---

# PART VIII: DEVELOPER REFERENCE

This part collects the reference material that engineers will reach for during day-to-day development: API documentation, code standards, testing strategies, event schema contracts, and a glossary of system-specific terminology. Unlike the preceding parts, which build knowledge sequentially from architecture through implementation to deployment, the sections here are designed for day-to-day reference, not sequential reading.

Section 36 documents the API surface -- endpoints, request/response formats, and error codes -- so that frontend teams and integration partners can work against a contract rather than reading source code. Section 37 codifies the development guidelines and code standards that keep a monorepo with six services consistent: project structure, dependency injection patterns, DTO validation, and error handling conventions. Section 38 covers the testing strategy at three levels (unit, integration, load), because at 1,666 bookings per second, a single untested edge case can corrupt inventory or double-charge customers.

Section 39 addresses schema registry and event contracts -- the rules that govern how producers and consumers agree on message formats and how schemas evolve without breaking downstream services. Finally, Section 40 provides a glossary of system-specific terminology and curated learning resources for deeper study. When a senior engineer says "fencing token" and a junior engineer hears "authentication token," the glossary resolves the ambiguity. Together, these five sections ensure that every engineer on the team has a shared vocabulary, shared standards, and a shared understanding of the system's external contracts.

---

## 36. API Documentation

> **Learning Objectives**
> - Understand the structure of the booking API including authentication, idempotency keys, and content types
> - Learn how to read HTTP request/response documentation and map it to client implementation
> - Recognize the full error code taxonomy and the HTTP status codes each maps to
> - Understand why idempotency keys are required for booking creation endpoints
> - Evaluate how clear API documentation reduces integration friction and support burden

**Why:** Clear API documentation reduces integration friction and support burden. Every endpoint documents its inputs, outputs, error codes, and authentication requirements. If a frontend or partner team has to read your source code to understand your API, you have failed at documentation.

### Create Booking

```http
POST /api/v1/bookings
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <unique-key>

{
  "bookingType": "hotel",
  "hotelId": 12345,
  "roomTypeId": 678,
  "checkIn": "2026-03-15",
  "checkOut": "2026-03-20",
  "roomsCount": 2,
  "guestsCount": 4,
  "rooms": [
    { "adultsCount": 2, "childrenCount": 0, "bedType": "king" },
    { "adultsCount": 1, "childrenCount": 1, "bedType": "queen" }
  ],
  "subtotal": 800.00,
  "taxAmount": 80.00,
  "discountAmount": 0.00,
  "totalAmount": 880.00,
  "currency": "USD",
  "paymentMethod": {
    "type": "credit_card",
    "provider": "stripe",
    "token": "tok_visa"
  }
}
```

#### Response (201 Created)

```json
{
  "success": true,
  "data": {
    "bookingId": 9876543210,
    "referenceCode": "HT-20260215-000042",
    "status": "confirmed",
    "totalAmount": 880.00,
    "currency": "USD",
    "createdAt": "2026-02-15T10:30:00Z"
  }
}
```

### Check Availability

```http
GET /api/v1/inventory/availability?resourceType=hotel_room&resourceId=12345&checkIn=2026-03-15&checkOut=2026-03-20&quantity=2
```

### Cancel Booking

```http
POST /api/v1/bookings/:id/cancel
Authorization: Bearer <token>

{ "reason": "user_cancelled", "reasonNotes": "Change of plans" }
```

### Error Codes

| Error Code | HTTP Status | Description |
|---|---|---|
| `INSUFFICIENT_INVENTORY` | 409 | Requested quantity exceeds available inventory |
| `PAYMENT_DECLINED` | 402 | Payment provider declined the transaction |
| `FRAUD_BLOCKED` | 403 | Booking blocked by fraud detection system |
| `INVALID_REQUEST` | 400 | Request body failed validation |
| `BOOKING_NOT_FOUND` | 404 | Booking ID does not exist |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Authenticated user lacks permission |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests; retry after cooldown |

### Key Takeaways

- The `Idempotency-Key` header is required on booking creation to prevent duplicate bookings from network retries. The server caches the result keyed by this value and returns the cached response for repeated requests.
- The cancellation endpoint uses `POST` rather than `DELETE` because cancellation is a business operation with a payload (reason, notes), not a simple resource deletion. The booking record is preserved for auditing.
- Error codes are domain-specific strings (`INSUFFICIENT_INVENTORY`, `FRAUD_BLOCKED`) rather than generic HTTP status codes, giving clients enough detail to display meaningful user-facing messages and implement retry logic.
- The `referenceCode` in the response follows a pattern (`HT-20260215-000042`) that encodes booking type, date, and sequence number, making it human-readable for customer support interactions.
- The availability check is a `GET` request with query parameters, making it cacheable by CDNs and browser caches -- a deliberate design choice given the 70/30 read/write ratio.

### Review Questions

1. **Conceptual:** Why does `INSUFFICIENT_INVENTORY` return HTTP 409 (Conflict) rather than 400 (Bad Request) or 422 (Unprocessable Entity)? What does 409 communicate to the client that the other codes do not?
2. **Code Reading:** The Create Booking request includes both `subtotal`, `taxAmount`, `discountAmount`, and `totalAmount`. Why does the API accept all four values from the client rather than computing `totalAmount` server-side? What validation should the server perform on these values?
3. **Conceptual:** Both `FRAUD_BLOCKED` and `FORBIDDEN` return HTTP 403. How should a client distinguish between these two error conditions, and why is it important to handle them differently?

### Hands-On Exercise

**Exercise: Design the Booking Modification API.** The current API supports Create, Cancel, and Check Availability but lacks a Modify Booking endpoint. Design a `PATCH /api/v1/bookings/:id` endpoint that allows changing dates and room count. Document: (1) the request format with only the fields that can be modified, (2) the response format including the updated totals, (3) at least three new error codes specific to modification (e.g., `MODIFICATION_WINDOW_CLOSED`, `PRICE_CHANGED`), and (4) the idempotency behavior. Write the complete HTTP documentation in the same style as the existing endpoints above.

---

## 37. Development Guidelines & Code Standards

> **Learning Objectives**
> - Understand the monorepo structure and how apps, libs, infra, and tests are organized
> - Learn why NestJS dependency injection makes services testable and enforces separation of concerns
> - Recognize how DTO validation with class-validator decorators prevents invalid data from reaching business logic
> - Understand the Result pattern as an alternative to exceptions for expected failure cases
> - Learn how custom exception classes carry domain-specific context for precise error messages

**Why:** Consistent code structure across services reduces onboarding time and makes code reviews efficient. These patterns are conventions, not suggestions. When every service follows the same structure, any engineer can jump into any service and be productive within hours instead of days.

### Monorepo Structure

```
booking-platform/
├── apps/
│   ├── api-gateway/
│   ├── booking-service/
│   ├── inventory-service/
│   ├── payment-service/
│   ├── fraud-service/
│   └── notification-service/
├── libs/
│   ├── database/
│   ├── kafka/
│   ├── redis/
│   ├── monitoring/
│   └── common/
├── infra/
│   ├── terraform/
│   ├── kubernetes/
│   └── docker/
├── scripts/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### NestJS Dependency Injection

**Why:** Dependency injection makes services testable by allowing mock implementations in tests. It also enforces separation of concerns -- each class declares what it needs, and the framework wires everything together.

```typescript
// Dependency injection
@Injectable()
export class BookingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly logger: Logger
  ) {}
}
```

### DTO Validation

**Why:** Validating inputs at the boundary prevents garbage data from reaching business logic. Using decorators keeps validation co-located with the data structure it validates.

```typescript
// DTO validation with class-validator
export class CreateBookingDto {
  @IsNotEmpty()
  @IsEnum(BookingType)
  bookingType: BookingType;

  @IsPositive()
  resourceId: number;

  @IsISO8601()
  checkIn: string;

  @IsISO8601()
  checkOut: string;

  @ValidateNested()
  @Type(() => PaymentMethodDto)
  paymentMethod: PaymentMethodDto;
}
```

### Result Pattern for Error Handling

**Why:** Throwing exceptions for expected outcomes (like "inventory unavailable") makes control flow hard to follow. The Result pattern makes success and failure explicit in the type system, forcing callers to handle both cases.

```typescript
// Result pattern
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: Error };
```

### Custom Exception Classes

**Why:** Custom exceptions carry context that generic errors cannot. When an `InsufficientInventoryError` reaches the error handler, it knows exactly what resource was requested, how many were wanted, and how many were available -- enabling precise error messages and debugging.

```typescript
// Custom exceptions
export class InsufficientInventoryError extends Error {
  constructor(
    public readonly resourceType: string,
    public readonly resourceId: bigint,
    public readonly requested: number,
    public readonly available: number
  ) {
    super(`Insufficient inventory for ${resourceType}:${resourceId}`);
    this.name = 'InsufficientInventoryError';
  }
}
```

### Key Takeaways

- The monorepo separates `apps/` (deployable services), `libs/` (shared code), `infra/` (Terraform/K8s/Docker), and `tests/` (test suites). Shared libraries in `libs/` prevent code duplication across services while keeping deployment units independent.
- NestJS dependency injection via constructor parameters means that unit tests can replace `DatabaseService` with a mock, `InventoryService` with a stub, and `Logger` with a no-op -- testing pure business logic without infrastructure.
- The Result pattern (`{ success: true; data: T } | { success: false; error: Error }`) is used for expected failure cases (inventory unavailable, payment declined), while exceptions are reserved for unexpected errors (database connection lost, null pointer). This distinction keeps control flow readable.
- DTO validation decorators like `@IsISO8601()` and `@ValidateNested()` run automatically in the NestJS validation pipe, rejecting malformed requests before they reach the service layer. This is boundary validation, not business validation.
- Custom exception classes like `InsufficientInventoryError` carry structured fields (`resourceType`, `requested`, `available`) that error handlers use to construct precise API error responses and structured log entries.

### Review Questions

1. **Code Reading:** The `BookingService` constructor declares four dependencies: `DatabaseService`, `InventoryService`, `PaymentService`, and `Logger`. In a unit test, which of these would you mock and which (if any) could you use as real implementations? Why?
2. **Conceptual:** The Result pattern and custom exceptions both handle errors. When should `BookingService.createBooking()` return `{ success: false, error: ... }` versus throwing an `InsufficientInventoryError`? What principle governs this decision?
3. **Code Reading:** The `CreateBookingDto` uses `@IsISO8601()` for `checkIn` and `checkOut`. What value would fail this validation, and what additional business validation (not captured by the decorator) must the service layer still perform on these dates?

### Hands-On Exercise

**Exercise: Create a PaymentDeclinedError Class and Result-Based Handler.** Write a `PaymentDeclinedError` custom exception class that includes fields for `provider`, `declineCode`, `declineReason`, and `retryable: boolean`. Then write a `processBookingPayment()` function that calls `paymentService.charge()`, catches any `PaymentDeclinedError`, and returns a `Result<PaymentConfirmation>` instead of throwing. Include a unit test that verifies: (1) a successful charge returns `{ success: true, data: ... }`, (2) a retryable decline returns `{ success: false, error: ... }` with `retryable: true`, and (3) an unexpected error (e.g., network timeout) is re-thrown rather than wrapped in a Result.

---

## 38. Testing Strategy

> **Learning Objectives**
> - Understand the three-tier testing strategy: unit tests, integration tests, and load tests
> - Learn how to structure unit tests with mocked dependencies to isolate business logic
> - Recognize how integration tests verify real service communication including HTTP, database, and Kafka interactions
> - Understand load test phase design (warmup, ramp, peak, cooldown) and scenario weighting
> - Evaluate why each testing tier catches different categories of bugs that the others miss

**Why:** At production scale, untested code is a liability. Unit tests verify logic. Integration tests verify service interactions. Load tests verify capacity. A single untested edge case in the booking flow can silently corrupt inventory or double-charge customers at 1,666 bookings per second.

### Unit Tests

**Why:** Unit tests run in milliseconds and catch logic errors before code reaches CI. They mock all external dependencies so failures point to the code under test, not infrastructure.

```typescript
// Unit Test
describe('BookingService', () => {
  let bookingService: BookingService;
  let inventoryService: jest.Mocked<InventoryService>;
  let paymentService: jest.Mocked<PaymentService>;

  beforeEach(() => {
    inventoryService = {
      checkAvailability: jest.fn(),
      createHold: jest.fn(),
      confirmHold: jest.fn(),
      releaseHold: jest.fn()
    } as any;

    paymentService = {
      processPayment: jest.fn()
    } as any;

    bookingService = new BookingService(inventoryService, paymentService);
  });

  it('should create booking successfully', async () => {
    inventoryService.checkAvailability.mockResolvedValue(true);
    inventoryService.createHold.mockResolvedValue({ id: 1n });
    paymentService.processPayment.mockResolvedValue({ id: 2n });

    const result = await bookingService.createBooking(mockDto);

    expect(result.status).toBe('confirmed');
    expect(inventoryService.createHold).toHaveBeenCalledTimes(1);
  });

  it('should rollback hold if payment fails', async () => {
    inventoryService.checkAvailability.mockResolvedValue(true);
    inventoryService.createHold.mockResolvedValue({ id: 1n });
    paymentService.processPayment.mockRejectedValue(new PaymentDeclinedError('Declined'));

    await expect(bookingService.createBooking(mockDto)).rejects.toThrow();
    expect(inventoryService.releaseHold).toHaveBeenCalledWith(1n, expect.any(String), expect.any(String));
  });
});
```

### Integration Tests

**Why:** Integration tests verify that real services communicate correctly -- that HTTP endpoints accept the right payloads, that database queries return expected results, and that Kafka messages are consumed. They catch issues that unit tests miss: serialization bugs, query errors, and configuration problems.

```typescript
// Integration Test
describe('Booking Flow Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  it('should complete full booking flow', async () => {
    // Check availability
    const avail = await request(app.getHttpServer())
      .get('/api/v1/inventory/availability')
      .query({ resourceType: 'hotel_room', resourceId: 12345 })
      .expect(200);

    expect(avail.body.data.available).toBe(true);

    // Create booking
    const booking = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test_token')
      .set('Idempotency-Key', 'test_key_123')
      .send({ bookingType: 'hotel', hotelId: 12345 })
      .expect(201);

    expect(booking.body.data.bookingId).toBeDefined();
  });
});
```

### Load Testing Strategy

**Why:** Load tests are the only way to validate that the system actually handles 1,666 bookings/second before real users hit it. They reveal bottlenecks that do not appear at low concurrency: connection pool exhaustion, lock contention, and GC pauses.

```typescript
export const loadTestPlan = {
  phases: [
    { duration: '5m', arrivalRate: 10, name: 'Warmup' },
    { duration: '10m', arrivalRate: 100, name: 'Ramp up' },
    { duration: '30m', arrivalRate: 1666, name: 'Peak load' },
    { duration: '10m', arrivalRate: 500, name: 'Cool down' }
  ],
  scenarios: {
    searchAndBook: {
      weight: 60,
      flow: ['searchHotels', 'viewDetails', 'checkAvailability', 'createBooking']
    },
    searchOnly: {
      weight: 30,
      flow: ['searchHotels', 'viewDetails']
    },
    manageBooking: {
      weight: 10,
      flow: ['getBooking', 'cancelBooking']
    }
  }
};
```

### Key Takeaways

- The unit test for "rollback hold if payment fails" verifies the saga compensation pattern: when payment is declined after inventory is held, the hold must be released. This is the most critical edge case in the booking flow.
- Integration tests use `Test.createTestingModule` to boot the full NestJS application with real modules, catching issues that mocks hide: serialization mismatches, middleware ordering, and guard configuration.
- The load test plan uses a realistic scenario mix (60% search-and-book, 30% search-only, 10% manage-booking) rather than hammering a single endpoint, because production traffic is heterogeneous and bottlenecks shift depending on the request mix.
- The 5-minute warmup phase at 10 requests/second allows JIT compilation, connection pool initialization, and cache warming before the system is measured at peak load. Skipping warmup produces misleadingly bad results.
- Load tests must run for at least 30 minutes at peak to surface time-dependent issues like memory leaks, connection pool exhaustion, and log rotation failures that do not appear in short bursts.

### Review Questions

1. **Code Reading:** In the unit test, `inventoryService.releaseHold` is called with `(1n, expect.any(String), expect.any(String))`. What do the two `String` arguments likely represent, and why does the test use `expect.any(String)` rather than exact values?
2. **Conceptual:** The integration test sets `Idempotency-Key: 'test_key_123'`. What happens if this test runs twice without database cleanup between runs? How should integration tests handle idempotency keys to remain repeatable?
3. **Code Reading:** The load test scenario weights sum to 100 (60 + 30 + 10). At peak load of 1,666 requests/second, how many `createBooking` calls per second does the system receive? (Hint: the `searchAndBook` flow has 4 steps, only one of which is `createBooking`.)

### Hands-On Exercise

**Exercise: Write a Concurrency Unit Test.** The existing unit tests verify sequential behavior but do not test what happens when two bookings compete for the last available room. Write a unit test that: (1) mocks `inventoryService.checkAvailability` to return `true` for both calls, (2) mocks `inventoryService.createHold` to succeed the first time and throw `InsufficientInventoryError` the second time, (3) runs two `bookingService.createBooking()` calls concurrently using `Promise.all`, and (4) asserts that exactly one booking succeeds and one fails. This test verifies that the service correctly handles the race condition at the unit level.

---

## 39. Schema Registry & Event Contracts

> **Learning Objectives**
> - Understand why schema registries are essential in event-driven architectures to prevent breaking changes
> - Learn the distinction between allowed schema evolutions (adding optional fields) and forbidden ones (removing required fields)
> - Recognize how JSON Schema definitions enforce event structure at publish time
> - Understand the SchemaValidator middleware pattern for catching malformed events before they reach Kafka
> - Evaluate the process requirements for schema changes including PR review and backward compatibility

**Why:** In an event-driven system, producers and consumers must agree on message formats. Schema evolution rules prevent breaking changes from corrupting downstream services. Without a schema registry, a producer adding a field or changing a type can silently break every consumer, and the errors only surface at runtime -- potentially corrupting data before anyone notices.

### Event Schema Definitions

```typescript
// Event schema definitions using JSON Schema
export const eventSchemas = {
  'booking.created': {
    version: 1,
    schema: {
      type: 'object',
      required: ['bookingId', 'userId', 'bookingType', 'totalAmount', 'currency', 'timestamp'],
      properties: {
        bookingId: { type: 'integer' },
        userId: { type: 'integer' },
        bookingType: { type: 'string', enum: ['hotel', 'flight', 'car'] },
        totalAmount: { type: 'number', minimum: 0 },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        timestamp: { type: 'string', format: 'date-time' }
      },
      additionalProperties: false
    }
  },

  'inventory.reserved': {
    version: 1,
    schema: {
      type: 'object',
      required: ['resourceType', 'resourceId', 'quantity', 'fencingToken', 'region'],
      properties: {
        resourceType: { type: 'string', enum: ['hotel_room', 'flight_seat', 'car'] },
        resourceId: { type: 'integer' },
        quantity: { type: 'integer', minimum: 1 },
        fencingToken: { type: 'integer' },
        region: { type: 'string' }
      }
    }
  }
};
```

### Schema Evolution Rules

```typescript
// Schema evolution rules
export const schemaEvolutionRules = {
  allowed: [
    'Add optional fields',
    'Add new enum values at the end',
    'Widen numeric types (int → long)',
    'Add new event types'
  ],
  forbidden: [
    'Remove required fields',
    'Rename fields',
    'Change field types',
    'Remove enum values',
    'Change field from optional to required'
  ],
  process: [
    'All schema changes require PR review from platform team',
    'New versions must be backward compatible',
    'Consumers must handle unknown fields gracefully',
    'Breaking changes require new topic + migration plan'
  ]
};
```

### Schema Validator Middleware

**Why:** Validating every event at publish time catches schema violations before they reach Kafka. A malformed event caught at the producer is a log line; a malformed event caught at the consumer is a production incident.

```typescript
// Schema validator middleware
export class SchemaValidator {
  async validate(eventType: string, payload: any): Promise<ValidationResult> {
    const schema = eventSchemas[eventType];
    if (!schema) {
      return { valid: false, errors: [`Unknown event type: ${eventType}`] };
    }

    const ajv = new Ajv();
    const validate = ajv.compile(schema.schema);
    const valid = validate(payload);

    return {
      valid: valid as boolean,
      errors: validate.errors?.map(e => e.message!) || []
    };
  }
}
```

### Key Takeaways

- The `booking.created` schema sets `additionalProperties: false`, which rejects events with unexpected fields. This strict mode catches typos and unintended data leakage at publish time. The `inventory.reserved` schema omits this constraint, allowing forward-compatible extensions.
- Schema evolution rules draw a clear line: adding optional fields and new enum values is safe; removing fields, renaming fields, or changing types requires a new topic and a migration plan. This distinction protects consumers from silent breakage.
- The `SchemaValidator` middleware uses AJV (Another JSON Validator) to compile and validate schemas at runtime. Creating a new `Ajv()` instance per validation is correct for clarity but should be cached in production for performance.
- The `fencingToken` field in the `inventory.reserved` schema is typed as `integer`, connecting the event contract back to the distributed locking mechanism from Section 11. Consumers use this token to reject stale reservation events.
- The process rules require platform team review for all schema changes, ensuring that a single service team cannot unilaterally break downstream consumers by modifying a shared event contract.

### Review Questions

1. **Code Reading:** The `booking.created` schema marks `additionalProperties: false` but `inventory.reserved` does not. What practical difference does this create for schema evolution? Which approach is more restrictive, and when would you choose each?
2. **Conceptual:** The evolution rules allow "Add new enum values at the end" but forbid "Remove enum values." Why is adding safe but removing dangerous? What happens to a consumer that receives an enum value it does not recognize?
3. **Code Reading:** The `SchemaValidator.validate()` method creates a new `Ajv()` instance on every call. What performance problem does this create at 1,666 events/second, and how would you refactor the class to avoid it while still supporting dynamic schema registration?

### Hands-On Exercise

**Exercise: Implement Schema Version Migration.** The `booking.created` schema is at version 1. Design and implement a version 2 that adds an optional `loyaltyPoints: { type: 'integer', minimum: 0 }` field and a new enum value `'package'` to `bookingType`. Write: (1) the new schema definition, (2) a `SchemaRegistry` class that stores multiple versions and resolves the correct schema by event type and version, (3) a migration function that upgrades a v1 event to v2 format (setting `loyaltyPoints` to 0 as default), and (4) a unit test that validates a v1 event against the v1 schema and a v2 event against the v2 schema. Verify that a v1 event also passes v2 validation (backward compatibility).

---

## 40. Glossary & Learning Resources

> **Learning Objectives**
> - Build a shared vocabulary of system-specific terminology used throughout the Global Booking System architecture
> - Understand how each glossary term connects to the section where it is defined and used in depth
> - Identify curated learning resources for deeper study of distributed systems, microservices, and infrastructure
> - Recognize why a shared vocabulary prevents miscommunication between senior and junior engineers

**Why:** A shared vocabulary prevents miscommunication. These definitions are specific to this system's usage of industry terms. When a senior engineer says "fencing token" and a junior engineer hears "authentication token," bugs happen. This glossary is the single source of truth.

### Glossary

| Term | Definition |
|---|---|
| **Fencing Token** | Monotonically increasing number issued with each lock acquisition. The database rejects writes carrying a token lower than the currently stored one. (Section 11) |
| **Idempotency Key** | A deterministic hash of request parameters. Repeated requests with the same key return the cached result instead of creating duplicates. (Section 12) |
| **Outbox Pattern** | Writing events to a database table within the same transaction as business data. A publisher process reads and forwards to Kafka. Guarantees at-least-once delivery. (Section 14) |
| **Saga** | A sequence of local transactions where each step has a compensating action that undoes it. Used for distributed transactions across services. (Section 15) |
| **CQRS** | Command Query Responsibility Segregation. Separating write operations (MySQL) from read operations (Elasticsearch). (Section 16) |
| **Circuit Breaker** | A proxy that monitors failure rates and stops sending requests to a failing service, allowing it to recover. States: Closed -> Open -> Half-Open. (Section 17) |
| **Bulkhead** | Isolating service connections into separate pools so one failing service cannot exhaust resources needed by others. (Section 17) |
| **Event Sourcing** | Storing all state changes as immutable events rather than overwriting current state. Enables audit trails and time-travel debugging. (Section 3) |
| **Double-Entry Accounting** | Every financial transaction creates balanced journal entries (debits = credits). Enforced by database triggers. (Section 9) |
| **KRaft** | Kafka Raft consensus protocol that replaces ZooKeeper for Kafka metadata management. Production-ready since Kafka 3.5. (Section 31) |
| **DLQ (Dead Letter Queue)** | A queue for messages that failed processing after all retry attempts. Preserved for investigation and manual replay. (Section 21) |
| **SLO/SLI** | Service Level Objective (target) and Service Level Indicator (measurement). SLOs define how reliable we aim to be. (Section 28) |

### Learning Resources

**Books:**
- *Designing Data-Intensive Applications* by Martin Kleppmann -- Chapters on replication, partitioning, and transactions
- *Building Microservices* by Sam Newman -- Service decomposition and communication patterns
- *Release It!* by Michael Nygard -- Circuit breakers, bulkheads, and production resilience

**Distributed Systems:**
- Fencing tokens and distributed locking: Martin Kleppmann's blog "How to do distributed locking"
- CAP theorem: Brewer's original paper and its practical implications
- Saga pattern: Chris Richardson's microservices.io

**Infrastructure:**
- Kubernetes documentation: kubernetes.io
- Kafka documentation: kafka.apache.org (focus on KRaft mode)
- Terraform: HashiCorp Learn tutorials

### Key Takeaways

- Every glossary term includes a section reference (e.g., "Section 11", "Section 15") that links back to the detailed explanation, making the glossary a navigation tool as well as a definitions list.
- The glossary is scoped to this system's usage of industry terms. "Fencing token" here means specifically the monotonically increasing number used with distributed locks and database writes -- not a generic security token.
- The learning resources are curated, not exhaustive. Each book and reference is chosen because it directly explains a pattern used in this architecture: Kleppmann for data fundamentals, Newman for service decomposition, Nygard for production resilience.
- Terms like KRaft and DLQ reflect operational decisions documented earlier in the architecture. The glossary ensures that these acronyms have unambiguous definitions when used in incident reports, design reviews, and onboarding materials.
- This glossary should be treated as a living document. As new patterns are adopted (e.g., if the system adds GraphQL federation or gRPC), corresponding terms should be added with section references.
# BACK MATTER

---

## Appendix A: Common Mistakes Reference

This appendix collects all seven **Common Mistake** callouts from the book into one place. Each entry describes a bug that looks correct during code review but fails in production. Use this as a checklist during design reviews and pull requests.

---

### Mistake 1: Hardcoded Service Endpoints
**Section:** 2 (Core Technology Stack)
**Category:** Infrastructure / Service Discovery

**The Bug:** An earlier version listed three specific pod IP addresses and implemented manual round-robin load balancing across them.

**Why It Fails:** In Kubernetes, pods are ephemeral. When a pod restarts, crashes, or gets rescheduled, its IP address changes. Hardcoded addresses become stale, and requests start failing with connection timeouts. This failure mode is particularly insidious because it works perfectly in testing (where pods rarely restart) and only manifests under real operational conditions.

**The Fix:** Always use Kubernetes service DNS names (`service-name.namespace.svc.cluster.local`) and let the kube-proxy or service mesh handle load balancing. The service abstraction provides a stable virtual IP that automatically routes to healthy pods.

**Lesson:** Never couple application code to infrastructure-level details that are designed to be dynamic.

---

### Mistake 2: DECLARE After IF in MySQL Triggers
**Section:** 9 (Financial Ledger & Double-Entry Accounting)
**Category:** Database / SQL Syntax

**The Bug:** A MySQL trigger placed `DECLARE` statements after an `IF` conditional block inside the `BEGIN...END` body.

**Why It Fails:** MySQL's stored program grammar requires all `DECLARE` statements to appear at the very top of a `BEGIN` block, before any executable statements including `IF`. Placing `DECLARE` after `IF` causes a syntax error during trigger creation -- the trigger simply never gets installed, and the protection it was supposed to provide silently disappears.

**The Fix:** Always place all `DECLARE` statements immediately after `BEGIN`, before any logic:

```sql
BEGIN
  DECLARE v_is_posted TINYINT;    -- DECLARE first
  DECLARE v_entry_number VARCHAR(20);

  IF some_condition THEN           -- Logic second
    -- ...
  END IF;
END
```

**Lesson:** Know the syntactic rules of your database's stored program language. A silent failure during trigger creation is worse than a loud error because you lose the protection without knowing it.

---

### Mistake 3: Mixing Revenue and Cost in One Journal Entry
**Section:** 9 (Financial Ledger & Double-Entry Accounting)
**Category:** Financial / Accounting Principles

**The Bug:** An earlier version combined revenue recognition and cost accrual into a single 4-line journal entry. The entry was technically balanced (total debits equaled total credits).

**Why It Fails:** While mathematically correct, this violates the accounting principle of separating distinct economic events. Revenue recognition (transferring a customer deposit to revenue) and cost accrual (recording an expense owed to a supplier) are independent transactions. They may occur at different times, involve different approval workflows, and need to be auditable separately. Combining them makes it impossible to reverse one without affecting the other, creates incorrect financial reports if one event's timing changes, and fails audit scrutiny.

**The Fix:** Create separate journal entries for each distinct economic event, even if they relate to the same booking. Each entry should be independently balanced and independently reversible.

**Lesson:** In financial systems, mathematical correctness is necessary but not sufficient. Business semantics matter -- the structure of your data must reflect the structure of the real-world events it represents.

---

### Mistake 4: SQL Injection in Date Filtering
**Section:** 9 (Financial Ledger & Double-Entry Accounting)
**Category:** Security / Input Validation

**The Bug:** An earlier version of `getAccountBalance` interpolated a date directly into the SQL string using template literals:
```typescript
// DANGEROUS: SQL injection vulnerability
`AND ae.entry_date <= '${format(asOfDate, 'yyyy-MM-dd')}'`
```

**Why It Fails:** Even though `asOfDate` appears to be a Date object processed through a formatting function, the value ultimately comes from user input (an API parameter). An attacker can craft a malicious date string that, after formatting, contains SQL injection payload. The injection could extract financial data, modify account balances, or drop tables entirely.

**The Fix:** Always use parameterized queries with placeholder syntax:
```typescript
// SAFE: Parameterized query
`AND ae.entry_date <= ?`, [format(asOfDate, 'yyyy-MM-dd')]
```

**Lesson:** Never interpolate any dynamic value into SQL, regardless of how "safe" the value appears. Parameterized queries are a non-negotiable baseline. This includes dates, numeric IDs, and enum values -- not just obvious string inputs.

---

### Mistake 5: Treating Timeout as Success
**Section:** 13 (Multi-Region Conflict Resolution)
**Category:** Distributed Systems / Consensus

**The Bug:** An earlier version of `waitForGlobalConsensus` resolved the timeout case as `{ success: true }`, reasoning that if no conflict notification arrived within 2 seconds, consensus must have been achieved.

**Why It Fails:** During a network partition between regions, the conflict notification from another region might simply not arrive -- not because there is no conflict, but because the network is partitioned. Treating "no news" as "good news" can lead to two regions both believing they hold valid locks on the same inventory, resulting in double-bookings.

**The Fix:** Treat timeout as *ambiguous*, not successful. After a timeout, actively verify consensus by checking whether your fencing token is still the latest in the database:

```typescript
// WRONG: Assuming no news is good news
setTimeout(() => resolve({ success: true }), 2000);

// RIGHT: Treating timeout as ambiguous and verifying
setTimeout(async () => {
  const isStillValid = await verifyFencingToken(token);
  resolve({ success: isStillValid });
}, 2000);
```

**Lesson:** In distributed systems, silence is ambiguous. A missing response could mean success, failure, or network partition. Design your protocols to distinguish between these cases, and when in doubt, verify actively rather than assuming.

---

### Mistake 6: Undeclared `params` in Fallback
**Section:** 17 (Circuit Breaker & Bulkhead)
**Category:** Resilience / Error Handling

**The Bug:** A circuit breaker fallback function was declared as `handleFallback(error: Error)` but referenced `this.queueRequest(params)` inside the method body. The variable `params` was never in scope.

**Why It Fails:** In the opossum circuit breaker library, the fallback function receives the **same arguments** as the protected function, followed by the error as the final argument. If the protected function signature is `bookRoom(params: BookRoomParams)`, the fallback signature must be `handleFallback(params: BookRoomParams, error: Error)`. The original code threw a `ReferenceError: params is not defined` at runtime -- precisely when the circuit was open and the fallback was most needed, converting a graceful degradation into a hard crash.

**The Fix:** Match the fallback signature to the protected function's parameters plus the trailing error:
```typescript
// WRONG: Missing params in scope
handleFallback(error: Error) {
  this.queueRequest(params); // ReferenceError!
}

// RIGHT: Same args as protected function + error
handleFallback(params: BookRoomParams, error: Error) {
  this.queueRequest(params); // params is in scope
}
```

**Lesson:** Fallback functions are the last line of defense. A fallback that crashes is worse than no fallback at all because it creates a false sense of security. Always test fallbacks by intentionally triggering circuit breaker openings, not just by inspecting the code.

---

### Mistake 7: Using ZooKeeper with Kafka 3.3+
**Section:** 31 (Capacity Planning & Cost Analysis)
**Category:** Infrastructure / Kafka Operations

**The Bug:** An earlier version of the infrastructure specification included a 5-node ZooKeeper ensemble for Kafka metadata management alongside a modern Kafka 3.3+ deployment.

**Why It Fails:** Since Kafka 3.3 (and production-ready in 3.5+), ZooKeeper has been deprecated in favor of **KRaft (Kafka Raft)** mode. Running ZooKeeper alongside modern Kafka creates unnecessary operational overhead: a separate cluster to monitor, patch, and capacity-plan. ZooKeeper also has slower metadata operations and controller failover compared to KRaft, and it will be fully removed in future Kafka versions (targeted for Kafka 4.0).

**The Fix:** Use KRaft mode for all new Kafka deployments. For existing clusters, plan a migration from ZooKeeper to KRaft:

```yaml
# KRaft mode configuration (no ZooKeeper)
KAFKA_PROCESS_ROLES: 'broker,controller'
KAFKA_CONTROLLER_QUORUM_VOTERS: '0@kafka-0:9093,1@kafka-1:9093,2@kafka-2:9093'
KAFKA_NODE_ID: 0
```

**Lesson:** Architectural documentation must evolve with the ecosystem. A decision that was correct two years ago (ZooKeeper for Kafka metadata) can become technical debt when the ecosystem provides a better built-in alternative.

---

### Quick Reference Checklist

Use this checklist during code reviews and design sessions:

| # | Check | Section |
|---|-------|---------|
| 1 | Are service endpoints resolved via DNS, not hardcoded IPs? | 2 |
| 2 | Are all `DECLARE` statements at the top of MySQL `BEGIN` blocks? | 9 |
| 3 | Are distinct economic events recorded as separate journal entries? | 9 |
| 4 | Are all SQL queries parameterized, including dates and "safe" values? | 9 |
| 5 | Does timeout handling verify state rather than assuming success? | 13 |
| 6 | Do circuit breaker fallbacks declare the correct parameter signature? | 17 |
| 7 | Is Kafka running in KRaft mode (not ZooKeeper) for version 3.3+? | 31 |

---

## Appendix B: Capstone Project

### Build a Complete Booking Flow

This capstone project ties together concepts from all 40 sections. You will build a working subset of the Global Booking System that handles the end-to-end flow from search to confirmation, including failure scenarios.

### Project Scope

Build a simplified booking platform with the following components:

1. **API Gateway** (Section 4) -- A single Express.js entry point with JWT authentication (Section 5)
2. **Search Service** (Section 6) -- Query available rooms from a local Elasticsearch instance
3. **Inventory Service** (Section 7) -- Hold rooms with fencing tokens (Section 11) and idempotency keys (Section 12)
4. **Booking Service** (Section 8) -- Orchestrate the booking saga (Section 15)
5. **Financial Ledger** (Section 9) -- Record double-entry journal entries for the completed booking
6. **Notification Service** (Section 10) -- Send a confirmation email via an event-driven outbox (Section 14)

### Architecture

```
┌──────────┐     ┌──────────┐     ┌───────────┐
│  Client   │────▶│   API    │────▶│  Search   │
│ (curl/    │     │ Gateway  │     │  Service  │
│  Postman) │     │ (JWT)    │     │ (ES)      │
└──────────┘     └────┬─────┘     └───────────┘
                      │
              ┌───────▼───────┐
              │   Booking     │
              │   Service     │
              │  (Saga Orch.) │
              └──┬────────┬───┘
                 │        │
          ┌──────▼──┐  ┌──▼─────────┐
          │Inventory │  │ Financial  │
          │ Service  │  │  Ledger    │
          │(Fencing) │  │(Dbl-Entry) │
          └──────┬──┘  └────────────┘
                 │
          ┌──────▼──────┐
          │ Notification │
          │   Service    │
          │  (Outbox)    │
          └─────────────┘
```

### Implementation Steps

#### Step 1: Set Up Infrastructure
Use the Docker Compose configuration from Section 35 to launch:
- MySQL 8.0 (single instance, no sharding needed for the capstone)
- Redis (for distributed locks and caching)
- Kafka in KRaft mode (for event streaming)
- Elasticsearch (for search)

#### Step 2: Create the Database Schema
Implement the schemas from Section 3:
- `properties` and `room_types` tables
- `bookings` and `booking_events` tables (event sourcing)
- `inventory_holds` table with `fencing_token` column (Section 7, 11)
- `journal_entries` and `account_entries` tables (Section 9)
- `outbox_events` table (Section 14)
- Add the immutability triggers from Section 9

#### Step 3: Implement the Inventory Hold with Fencing Tokens
Build the `InventoryHoldService` from Section 7:
- Acquire a Redis distributed lock before modifying inventory
- Use `SELECT ... WHERE fencing_token < ? FOR UPDATE` to validate the token
- Implement the hold state machine: `PENDING` -> `CONFIRMED` / `EXPIRED` / `RELEASED`
- Write an idempotency wrapper (Section 12)

#### Step 4: Build the Booking Saga
Implement the `BookingSagaOrchestrator` from Section 15:
- Define saga steps: Hold Inventory -> Process Payment (mock) -> Record in Ledger -> Confirm Booking
- Implement compensating actions for each step: Release Hold, Refund Payment, Reverse Journal Entry, Cancel Booking
- Handle partial failures by running compensations in reverse order
- Persist saga state to the database for crash recovery

#### Step 5: Add the Financial Ledger
Implement the `AccountingService` from Section 9:
- `createJournalEntry` with balance validation (debits must equal credits)
- `generateEntryNumber` with the atomic sequence table
- Create entries for: Guest Deposit, Revenue Recognition, Cost Accrual
- Verify immutability triggers prevent modification of posted entries

#### Step 6: Implement the Outbox Pattern
Build the outbox publisher from Section 14:
- Insert events into the `outbox_events` table within the same transaction as business data
- Build a polling process that reads unpublished events and sends them to Kafka
- Mark events as published after successful Kafka acknowledgment
- Handle the notification consumer that reads from Kafka and logs "email sent"

#### Step 7: Add Resilience
Apply patterns from Part IV:
- Wrap external calls with circuit breakers (Section 17)
- Add retry with exponential backoff for transient failures (Section 18)
- Implement a rate limiter on the API Gateway (Section 23)

#### Step 8: Add Observability
Apply patterns from Part VI:
- Add Prometheus metrics: booking counter, saga duration histogram, error rate (Section 26)
- Add structured logging with correlation IDs (Section 27)
- Create a `/health` endpoint that checks all downstream dependencies

### Testing Your Implementation

1. **Happy Path:** Create a booking from search to confirmation. Verify:
   - The inventory hold transitions through `PENDING` -> `CONFIRMED`
   - A balanced journal entry exists in the ledger
   - A `booking.confirmed` event appears in Kafka
   - The booking record has a valid `confirmation_number`

2. **Fencing Token Conflict:** Simulate two concurrent booking attempts for the same room:
   - Start two saga instances simultaneously
   - Verify that exactly one succeeds and the other's hold is rejected by the fencing token check
   - Verify the failed saga runs its compensating actions

3. **Saga Failure and Compensation:** Force a failure in the payment step:
   - Mock the payment service to return an error
   - Verify the saga runs compensations: inventory hold is released, no journal entry is created
   - Verify the saga state is persisted as `COMPENSATED`

4. **Circuit Breaker:** Force a downstream service to fail repeatedly:
   - Stop the inventory service container
   - Send booking requests and verify the circuit opens after the threshold
   - Verify the fallback response is returned
   - Restart the container and verify the circuit transitions through `HALF_OPEN` to `CLOSED`

5. **Idempotency:** Send the same booking request twice with the same idempotency key:
   - Verify only one booking is created
   - Verify the second request returns the cached result from the first

### Evaluation Criteria

When you complete the capstone, review your implementation against these criteria:

| Criteria | What to Check |
|----------|--------------|
| **Correctness** | Does the fencing token prevent double-bookings? Do journal entries balance? |
| **Resilience** | Does the saga compensate correctly on failure? Does the circuit breaker protect the system? |
| **Consistency** | Is the outbox pattern used (not direct Kafka writes from business transactions)? |
| **Idempotency** | Can requests be safely retried without creating duplicates? |
| **Observability** | Can you trace a booking through all services using a correlation ID? |
| **Code Quality** | Does the code follow the patterns from Section 37 (DI, DTOs, Result pattern)? |

### Extension Challenges

Once the core capstone is complete, try these extensions:

1. **Multi-Region Simulation** (Section 13): Run two instances of the booking service on different ports, simulating two regions. Implement conflict detection via Kafka and verify that fencing tokens resolve conflicts correctly.

2. **CQRS Read Model** (Section 16): Build a search projector that consumes `booking.confirmed` events from Kafka and updates Elasticsearch. Verify that the search results reflect confirmed bookings.

3. **Cache Stampede Prevention** (Section 20): Implement the probabilistic early refresh pattern from Section 20 on the room availability endpoint. Use a load testing tool to simulate a cache expiry under high concurrency and verify that only one request hits the database.

4. **GDPR Data Deletion** (Section 25): Implement the `GDPRService.processErasureRequest` method that anonymizes a guest's personal data across all tables using the `SCAN`-based Redis cleanup (not `KEYS`).

---

## Appendix C: Section Cross-Reference Index

This index maps key concepts to the sections where they are discussed in depth.

| Concept | Primary Section | Also Referenced In |
|---------|----------------|-------------------|
| API Gateway & Routing | 4 | 23, 32 |
| Authentication (JWT) | 5 | 4, 23 |
| Booking Events (Event Sourcing) | 3 | 8, 14, 16 |
| Bulkhead Pattern | 17 | 22 |
| Cache Stampede Prevention | 20 | 22, 35 |
| Capacity Planning | 31 | 32, 34 |
| CI/CD Pipeline | 33 | 38 |
| Circuit Breaker | 17 | 15, 22 |
| CQRS (Command Query Separation) | 16 | 6, 14 |
| Database Sharding | 3 | 7, 31 |
| Dead Letter Queue (DLQ) | 21 | 14, 15 |
| Distributed Locking (Redis) | 11 | 7, 13 |
| Distributed Tracing | 27 | 26, 29 |
| Docker Compose (Local Dev) | 35 | 31, 34 |
| Double-Entry Accounting | 9 | 15 |
| Fencing Tokens | 11 | 7, 13 |
| Financial Ledger | 9 | 8, 15 |
| Fraud Detection | 24 | 5, 8 |
| GDPR / Data Privacy | 25 | 23, 36 |
| Health Checks | 30 | 22, 32 |
| Idempotency Keys | 12 | 8, 18 |
| Incident Response | 29 | 26, 28 |
| Infrastructure as Code (Terraform) | 34 | 31, 32 |
| Inventory Holds | 7 | 11, 15 |
| Kafka (KRaft mode) | 31 | 14, 21, 39 |
| Kubernetes Deployment | 32 | 31, 33, 34 |
| Monitoring & Alerting | 26 | 28, 29 |
| Multi-Region Conflict Resolution | 13 | 11, 30 |
| Notification Service | 10 | 14, 21 |
| Outbox Pattern | 14 | 10, 16 |
| Payment Processing | 9 | 8, 15 |
| Rate Limiting | 23 | 4, 22 |
| Retry with Backoff | 18 | 17, 21 |
| Saga Pattern (Orchestration) | 15 | 8, 9, 14 |
| Schema Registry & Events | 39 | 14, 16 |
| Search Service (Elasticsearch) | 6 | 16, 35 |
| SLO/SLI Definitions | 28 | 26, 29 |
| Testing Strategy | 38 | 33, 37 |
| Thundering Herd Protection | 22 | 20, 30 |
| Timeout & Retry | 18 | 13, 17 |

---

## Colophon

**Building a Global Booking System**
*A Practical Guide to Designing Systems at 100,000 Bookings Per Minute*

Version 3.0

This book was written as a continuous architecture document where every code sample, schema, and configuration belongs to a single system. Cross-references between sections reflect the real dependencies between components in a production booking platform.

**Technology Stack Referenced:**
- TypeScript / Node.js (v20+ LTS)
- MySQL 8.0 (16 shards, InnoDB)
- Redis Cluster (distributed locks, caching)
- Apache Kafka 3.5+ (KRaft mode, 15 brokers)
- Elasticsearch 8.x (search and CQRS read model)
- Kubernetes 1.28+ (container orchestration)
- Terraform (infrastructure as code)
- Prometheus + Grafana (monitoring)
- Jaeger (distributed tracing)

---

*End of Book*
