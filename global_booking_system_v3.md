# Global Booking System - Complete Architecture Document

**Project:** Enterprise Booking Platform
**Scale Target:** 100,000 bookings/minute globally
**Version:** 3.0
**Last Updated:** February 15, 2026

---

## Table of Contents

**PART I: FOUNDATIONS**
1. [Executive Summary & Design Philosophy](#1-executive-summary--design-philosophy)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Database Design & Sharding](#3-database-design--sharding)

**PART II: THE BOOKING FLOW**
4. [API Gateway & Request Routing](#4-api-gateway--request-routing)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [Search Service](#6-search-service)
7. [Inventory Management](#7-inventory-management)
8. [Booking Service & Orchestration](#8-booking-service--orchestration)
9. [Payment & Accounting System](#9-payment--accounting-system)
10. [Notification Service](#10-notification-service)

**PART III: DISTRIBUTED SYSTEMS PATTERNS**
11. [Distributed Locking & Fencing Tokens](#11-distributed-locking--fencing-tokens)
12. [Idempotency & Exactly-Once Processing](#12-idempotency--exactly-once-processing)
13. [Multi-Region Conflict Resolution](#13-multi-region-conflict-resolution)
14. [Outbox Pattern & Reliable Messaging](#14-outbox-pattern--reliable-messaging)
15. [Saga Pattern & Distributed Transactions](#15-saga-pattern--distributed-transactions)
16. [CQRS Pattern](#16-cqrs-pattern)

**PART IV: RESILIENCE & RELIABILITY**
17. [Circuit Breaker & Bulkhead Patterns](#17-circuit-breaker--bulkhead-patterns)
18. [Rate Limiting](#18-rate-limiting)
19. [Retry & Backoff Strategies](#19-retry--backoff-strategies)
20. [Cache Strategy & Invalidation](#20-cache-strategy--invalidation)
21. [Dead Letter Queue Handling](#21-dead-letter-queue-handling)
22. [Database Read/Write Splitting](#22-database-readwrite-splitting)

**PART V: SECURITY & COMPLIANCE**
23. [Security Architecture](#23-security-architecture)
24. [Fraud Detection](#24-fraud-detection)
25. [GDPR & Data Privacy](#25-gdpr--data-privacy)

**PART VI: OBSERVABILITY & OPERATIONS**
26. [Monitoring & Alerting](#26-monitoring--alerting)
27. [Distributed Tracing](#27-distributed-tracing)
28. [SLO/SLI Definitions](#28-sloli-definitions)
29. [Incident Response](#29-incident-response)
30. [Disaster Recovery](#30-disaster-recovery)

**PART VII: INFRASTRUCTURE & DEPLOYMENT**
31. [Capacity Planning & Cost Analysis](#31-capacity-planning--cost-analysis)
32. [Kubernetes Deployment](#32-kubernetes-deployment)
33. [CI/CD Pipeline](#33-cicd-pipeline)
34. [Infrastructure as Code](#34-infrastructure-as-code)
35. [Local Development Setup](#35-local-development-setup)

**PART VIII: DEVELOPER REFERENCE**
36. [API Documentation](#36-api-documentation)
37. [Development Guidelines & Code Standards](#37-development-guidelines--code-standards)
38. [Testing Strategy](#38-testing-strategy)
39. [Schema Registry & Event Contracts](#39-schema-registry--event-contracts)
40. [Glossary & Learning Resources](#40-glossary--learning-resources)

---

# PART I: FOUNDATIONS

---

## 1. Executive Summary & Design Philosophy

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

---

## 2. System Architecture Overview

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

---

## 3. Database Design & Sharding

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

---

# PART II: THE BOOKING FLOW

---

## 4. API Gateway & Request Routing

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

---

## 5. Authentication & Authorization

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

---

## 6. Search Service

**Why:** Users need to find hotels, flights, and cars quickly with complex filters (location, dates, price range, amenities). The primary database (MySQL) is optimized for transactions, not full-text search or geo-queries. A dedicated search engine provides sub-200ms results. This is the **read** side of the CQRS pattern (Section 8) — writes go to MySQL, reads are served from Elasticsearch.

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

---

## 7. Inventory Management

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

---

## 8. Booking Service & Orchestration

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

---

## 9. Payment & Accounting System

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

---

## 10. Notification Service

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

---

# PART III: DISTRIBUTED SYSTEMS PATTERNS

---

## 11. Distributed Locking & Fencing Tokens

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
           [--- resumes, writes to DB at T=12s ---] ← STALE WRITE!

Service B:              [--- acquires same lock at T=10s ---]
                        [--- writes to DB at T=11s ---]

With fencing tokens:
Service A gets token=42, Service B gets token=43

At T=11s: DB has fencing_token=43 (from Service B)
At T=12s: Service A tries to write with token=42
          WHERE fencing_token < 42 → FALSE (43 is not < 42)
          affectedRows = 0 → Write rejected safely
```

---

## 12. Idempotency & Exactly-Once Processing

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

---

## 13. Multi-Region Conflict Resolution

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

---

## 14. Outbox Pattern & Reliable Messaging

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

---

## 15. Saga Pattern & Distributed Transactions

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

---

## 16. CQRS Pattern

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

---

# PART IV: RESILIENCE & RELIABILITY

---

## 17. Circuit Breaker & Bulkhead Patterns

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

---

## 18. Rate Limiting

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

---

## 19. Retry & Backoff Strategies

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

---

## 20. Cache Strategy & Invalidation

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

---

## 21. Dead Letter Queue Handling

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

---

## 22. Database Read/Write Splitting

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

---
# PART V: SECURITY & COMPLIANCE

---

## 23. Security Architecture

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

---

## 24. Fraud Detection

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

---

## 25. GDPR & Data Privacy

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

---

# PART VI: OBSERVABILITY & OPERATIONS

---

## 26. Monitoring & Alerting

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

---

## 27. Distributed Tracing

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

---

## 28. SLO/SLI Definitions

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

---

## 29. Incident Response

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

---

## 30. Disaster Recovery

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
# PART VII: INFRASTRUCTURE & DEPLOYMENT

---

## 31. Capacity Planning & Cost Analysis

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

---

## 32. Kubernetes Deployment

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

---

## 33. CI/CD Pipeline

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

---

## 34. Infrastructure as Code

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

---

## 35. Local Development Setup

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

---

# PART VIII: DEVELOPER REFERENCE

---

## 36. API Documentation

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

---

## 37. Development Guidelines & Code Standards

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

---

## 38. Testing Strategy

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

---

## 39. Schema Registry & Event Contracts

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

---

## 40. Glossary & Learning Resources

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
