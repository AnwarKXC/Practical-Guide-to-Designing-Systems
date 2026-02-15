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
