# 🌍 Global Booking System - Complete Application Documentation

**Project:** Enterprise Booking Platform  
**Scale Target:** 100,000 bookings/minute globally  
**Version:** 1.0  
**Last Updated:** February 15, 2026

---

## 📋 Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Database Design](#3-database-design)
4. [Microservices Architecture](#4-microservices-architecture)
5. [Distributed Systems & Concurrency](#5-distributed-systems--concurrency)
6. [Payment & Accounting System](#6-payment--accounting-system)
7. [Security & Compliance](#7-security--compliance)
8. [Monitoring & Observability](#8-monitoring--observability)
9. [Capacity Planning & Infrastructure](#9-capacity-planning--infrastructure)
10. [Deployment Strategy](#10-deployment-strategy)
11. [API Documentation](#11-api-documentation)
12. [Development Guidelines](#12-development-guidelines)

---

## 1. Executive Summary

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

### 1.3 Technology Stack

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
  Technology: Apache Kafka
  Brokers: 15 nodes
  Partitions: 500+ total

Container Orchestration:
  Platform: Kubernetes (EKS/GKE)
  Service Mesh: Istio
  
Search:
  Engine: Algolia / Elasticsearch

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

```
                        ┌─────────────────┐
                        │   Global CDN    │
                        │  (CloudFront)   │
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │  API Gateway    │
                        │  (Kong/NGINX)   │
                        └────────┬────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
   ┌────▼─────┐         ┌───────▼──────┐        ┌───────▼──────┐
   │ Booking  │         │  Inventory   │        │   Payment    │
   │ Service  │◄───────►│   Service    │◄──────►│   Service    │
   └────┬─────┘         └───────┬──────┘        └───────┬──────┘
        │                       │                        │
        │                ┌──────▼──────┐                 │
        │                │    Redis    │                 │
        │                │   Cluster   │                 │
        │                └─────────────┘                 │
        │                                                │
        └────────────────────┬───────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Kafka Event Bus │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼─────┐      ┌──────▼──────┐     ┌──────▼──────┐
   │  Fraud   │      │Notification │     │  Analytics  │
   │ Service  │      │  Service    │     │   Service   │
   └──────────┘      └─────────────┘     └─────────────┘
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
User Request → API Gateway → Service → Database
                   │              │
                   │              └──→ Kafka Event
                   │                      │
                   │                      ├──→ Notification Service
                   │                      ├──→ Analytics Service
                   │                      └──→ Audit Log
                   │
                   └──→ Redis Cache
```

---

## 3. Database Design

### 3.1 Sharding Strategy

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

#### **Bookings Table**

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
    FOREIGN KEY (booking_type) REFERENCES booking_types(code),
    FOREIGN KEY (currency) REFERENCES currencies(code),
    
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

#### **Inventory Table**

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

#### **Inventory Holds Table**

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
    INDEX idx_status (status, created_at)
);
```

#### **Transactions Table**

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

#### **Payment Ledger (Immutable)**

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

-- Triggers to prevent updates/deletes (immutability)
CREATE TRIGGER prevent_ledger_update
BEFORE UPDATE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Updates not allowed.';
END;

CREATE TRIGGER prevent_ledger_delete
BEFORE DELETE ON payment_ledger
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000'
    SET MESSAGE_TEXT = 'Payment ledger is immutable. Deletes not allowed.';
END;
```

#### **Booking Events (Event Store)**

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
- `inventory_holds` - Temporary reservations
- `inventory_locks` - Lock records (audit)
- `inventory_snapshots` - Daily snapshots

**Payments:**
- `transactions` - Payment transactions
- `payment_ledger` - Immutable financial log
- `accounting_entries` - Double-entry journal
- `accounting_entry_lines` - Journal line items
- `chart_of_accounts` - Account definitions

**Events:**
- `booking_events` - Event sourcing store
- `booking_snapshots` - Aggregate snapshots

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

## 4. Microservices Architecture

### 4.1 Service Communication Pattern

```typescript
// ============================================
// Inter-Service Communication
// ============================================

/**
 * Synchronous: REST/gRPC for request-response
 * Asynchronous: Kafka for events
 * Cache: Redis for shared state
 */

// Example: Booking Creation Flow
async function createBooking(dto: CreateBookingDto) {
  
  // 1. Synchronous: Check inventory availability
  const available = await inventoryService.checkAvailability({
    resourceType: dto.resourceType,
    resourceId: dto.resourceId,
    date: dto.date
  });
  
  if (!available) {
    throw new InsufficientInventoryError();
  }
  
  // 2. Synchronous: Reserve inventory
  const hold = await inventoryService.createHold({
    ...dto,
    ttlSeconds: 600  // 10 minutes
  });
  
  try {
    // 3. Synchronous: Process payment
    const payment = await paymentService.processPayment({
      amount: dto.totalAmount,
      currency: dto.currency,
      paymentMethod: dto.paymentMethod
    });
    
    // 4. Create booking record
    const booking = await this.createBookingRecord(dto, payment.id);
    
    // 5. Confirm hold
    await inventoryService.confirmHold(hold.id, booking.id);
    
    // 6. Asynchronous: Publish events
    await this.publishBookingCreatedEvent(booking);
    
    return booking;
    
  } catch (error) {
    // Rollback: Release hold
    await inventoryService.releaseHold(hold.id);
    throw error;
  }
}
```

### 4.2 Service Discovery & Load Balancing

```yaml
# Kubernetes Service Discovery
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  selector:
    app: booking-service
  ports:
    - name: http
      port: 3000
      targetPort: 3000
    - name: grpc
      port: 50051
      targetPort: 50051
  type: ClusterIP
  sessionAffinity: ClientIP
```

```typescript
// Service Client with Load Balancing
import { loadBalancerRoundRobin } from './loadBalancer';

class InventoryServiceClient {
  private readonly endpoints = [
    'http://inventory-service-1.production.svc.cluster.local:3000',
    'http://inventory-service-2.production.svc.cluster.local:3000',
    'http://inventory-service-3.production.svc.cluster.local:3000'
  ];
  
  async checkAvailability(params: any): Promise<boolean> {
    const endpoint = loadBalancerRoundRobin.next(this.endpoints);
    
    return await axios.post(`${endpoint}/api/inventory/check`, params, {
      timeout: 2000,
      headers: {
        'X-Request-ID': randomUUID(),
        'X-Service': 'booking-service'
      }
    });
  }
}
```

### 4.3 Circuit Breaker Pattern

```typescript
// ============================================
// Circuit Breaker for External Services
// ============================================

import CircuitBreaker from 'opossum';

class SupplierAPIClient {
  
  private circuitBreaker: CircuitBreaker;
  
  constructor(private supplierName: string) {
    
    this.circuitBreaker = new CircuitBreaker(
      this.callSupplierAPI.bind(this),
      {
        timeout: 5000,        // 5 seconds
        errorThresholdPercentage: 50,
        resetTimeout: 30000,  // 30 seconds
        volumeThreshold: 10,  // Min requests to trip
        
        // Fallback function
        fallback: (error) => this.handleFallback(error)
      }
    );
    
    // Event listeners
    this.circuitBreaker.on('open', () => {
      console.error(`Circuit breaker OPEN for ${this.supplierName}`);
      this.alertCircuitBreakerOpen();
    });
    
    this.circuitBreaker.on('halfOpen', () => {
      console.warn(`Circuit breaker HALF-OPEN for ${this.supplierName}`);
    });
    
    this.circuitBreaker.on('close', () => {
      console.log(`Circuit breaker CLOSED for ${this.supplierName}`);
    });
  }
  
  async bookRoom(params: any): Promise<any> {
    return await this.circuitBreaker.fire(params);
  }
  
  private async callSupplierAPI(params: any): Promise<any> {
    const response = await axios.post(
      `${this.getSupplierEndpoint()}/book`,
      params,
      { timeout: 5000 }
    );
    
    return response.data;
  }
  
  private handleFallback(error: Error): any {
    console.error(`Fallback triggered for ${this.supplierName}:`, error);
    
    // Return cached response or queue for later
    return {
      status: 'pending',
      message: 'Supplier temporarily unavailable. Request queued.',
      queueId: this.queueRequest(params)
    };
  }
}
```

---

## 5. Distributed Systems & Concurrency

### 5.1 Distributed Locking with Fencing Tokens

**Problem:** Prevent race conditions in inventory reservations across multiple servers.

**Solution:** Redlock algorithm with fencing tokens

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
    // Multiple Redis instances for quorum
    const redisClients = [
      new Redis({ host: 'redis1.example.com', port: 6379 }),
      new Redis({ host: 'redis2.example.com', port: 6379 }),
      new Redis({ host: 'redis3.example.com', port: 6379 })
    ];
    
    this.redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200
    });
    
    this.fencingCounter = new Redis({ host: 'redis-fencing.example.com' });
  }
  
  /**
   * Acquire lock with monotonically increasing fencing token
   */
  async acquireLockWithFencing(
    resourceKey: string,
    ttlMs: number = 10000
  ): Promise<{ lock: Redlock.Lock; fencingToken: number } | null> {
    
    try {
      // Step 1: Acquire distributed lock
      const lock = await this.redlock.acquire([resourceKey], ttlMs);
      
      // Step 2: Get fencing token (atomic increment)
      const fencingToken = await this.fencingCounter.incr(`fence:${resourceKey}`);
      
      // Step 3: Store active token
      await this.fencingCounter.set(
        `fence:active:${resourceKey}`,
        fencingToken,
        'EX',
        Math.ceil(ttlMs / 1000)
      );
      
      return { lock, fencingToken };
      
    } catch (error) {
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
    
    // Verify token is still valid
    const currentToken = await this.fencingCounter.get(`fence:active:${resourceKey}`);
    
    if (currentToken && parseInt(currentToken) !== fencingToken) {
      console.warn(`Fencing token mismatch. Lock may have been superseded.`);
      return false;
    }
    
    await lock.release();
    return true;
  }
}
```

**Database Integration:**

```sql
-- Inventory updates with fencing token
UPDATE inventory
SET available_quantity = available_quantity - ?,
    reserved_quantity = reserved_quantity + ?,
    fencing_token = ?,  -- New token
    updated_at = NOW()
WHERE resource_type = ?
AND resource_id = ?
AND resource_date = ?
AND available_quantity >= ?
AND (fencing_token IS NULL OR fencing_token < ?);  -- Only accept higher tokens
```

### 5.2 Idempotency Keys

**Problem:** User clicks "Book" button twice, creates duplicate bookings.

**Solution:** Idempotency keys

```typescript
// ============================================
// Idempotent Booking Creation
// ============================================

export class BookingService {
  
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    
    // Generate or use provided idempotency key
    const idempotencyKey = dto.idempotencyKey || this.generateIdempotencyKey(dto);
    
    // Check if booking already exists
    const existingBooking = await this.findByIdempotencyKey(
      dto.userId,
      idempotencyKey
    );
    
    if (existingBooking) {
      // Return existing booking (idempotent)
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
        dto.userId,
        dto.bookingType,
        this.generateReferenceCode(dto.bookingType),
        idempotencyKey,
        dto.subtotal,
        dto.taxAmount,
        dto.discountAmount,
        dto.totalAmount,
        dto.currency
      ]);
      
      const bookingId = result.insertId;
      
      // Create sub-type record
      await this.createSubTypeRecord(connection, bookingId, dto);
      
      await connection.commit();
      
      return this.getBookingById(bookingId);
      
    } catch (error) {
      await connection.rollback();
      
      // Handle duplicate key error gracefully
      if (error.code === 'ER_DUP_ENTRY') {
        // Race condition: another request created it
        return this.findByIdempotencyKey(dto.userId, idempotencyKey);
      }
      
      throw error;
      
    } finally {
      connection.release();
    }
  }
  
  private generateIdempotencyKey(dto: CreateBookingDto): string {
    // Hash critical booking parameters
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

### 5.3 Multi-Region Conflict Resolution

**Problem:** Same room booked in two regions simultaneously.

**Solution:** Global event stream with fencing token conflict resolution

```typescript
// ============================================
// Multi-Region Inventory Synchronization
// ============================================

export class MultiRegionInventoryService {
  private readonly region = process.env.REGION;
  
  async reserveInventory(params: ReservationParams): Promise<ReservationResult> {
    
    // Step 1: Acquire local lock with fencing token
    const lockResult = await this.fencedLockService.acquireLockWithFencing(
      this.getInventoryLockKey(params),
      10000
    );
    
    if (!lockResult) {
      throw new ConflictError('Resource is locked');
    }
    
    const { lock, fencingToken } = lockResult;
    
    try {
      // Step 2: Reserve locally
      const localReservation = await this.reserveLocally(params, fencingToken);
      
      // Step 3: Publish to global Kafka topic
      await kafka.send({
        topic: 'inventory-reservations-global',
        messages: [{
          key: `${params.resourceType}:${params.resourceId}:${params.resourceDate}`,
          value: JSON.stringify({
            reservationId: localReservation.id,
            region: this.region,
            fencingToken,
            ...params,
            timestamp: Date.now()
          }),
          headers: {
            'source-region': this.region,
            'fencing-token': fencingToken.toString()
          }
        }]
      });
      
      // Step 4: Wait for global consensus (2 seconds)
      const consensus = await this.waitForGlobalConsensus(
        localReservation.id,
        2000
      );
      
      if (!consensus.success) {
        // Conflict detected - rollback
        await this.rollbackReservation(localReservation.id);
        
        return {
          success: false,
          reason: 'multi_region_conflict',
          conflictingRegion: consensus.conflictingRegion
        };
      }
      
      return localReservation;
      
    } finally {
      await this.fencedLockService.releaseLock(lockKey, lock, fencingToken);
    }
  }
  
  /**
   * Kafka consumer for conflict detection
   */
  async startConflictDetectionConsumer(): Promise<void> {
    
    await kafka.subscribe({
      topic: 'inventory-reservations-global',
      fromBeginning: false
    });
    
    await kafka.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        const sourceRegion = message.headers['source-region'].toString();
        
        // Skip our own events
        if (sourceRegion === this.region) {
          return;
        }
        
        // Check for local conflicting reservation
        const localReservation = await this.findLocalReservation(
          event.resourceType,
          event.resourceId,
          event.resourceDate
        );
        
        if (!localReservation) {
          return;  // No conflict
        }
        
        // Conflict detected - resolve using fencing token
        if (event.fencingToken > localReservation.fencingToken) {
          // Remote wins - rollback local
          console.warn(
            `Conflict: Remote region ${sourceRegion} wins. ` +
            `Rolling back local reservation ${localReservation.id}`
          );
          
          await this.rollbackReservation(localReservation.id);
          
          // Notify local process
          await redis.publish(
            `conflicts:${localReservation.id}`,
            JSON.stringify({
              region: sourceRegion,
              reservationId: event.reservationId
            })
          );
          
        } else {
          // Local wins - notify remote to rollback
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

---

## 6. Payment & Accounting System

### 6.1 Double-Entry Accounting

**Why:** Financial audit compliance, accurate bookkeeping

**Implementation:**

```sql
-- Chart of Accounts
CREATE TABLE chart_of_accounts (
    account_code VARCHAR(50) PRIMARY KEY,
    account_name VARCHAR(255) NOT NULL,
    account_type ENUM('asset', 'liability', 'revenue', 'expense', 'equity') NOT NULL,
    is_system_account BOOLEAN DEFAULT FALSE
);

-- Example accounts
INSERT INTO chart_of_accounts VALUES
('1000', 'Cash', 'asset', TRUE),
('1210', 'Stripe Clearing', 'asset', TRUE),
('2100', 'Customer Deposits', 'liability', TRUE),
('4110', 'Hotel Booking Revenue', 'revenue', TRUE),
('5110', 'Hotel Supplier Costs', 'expense', TRUE),
('2210', 'Hotel Suppliers Payable', 'liability', TRUE);

-- Accounting Entries (Journal)
CREATE TABLE accounting_entries (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_number VARCHAR(50) NOT NULL UNIQUE,
    entry_date DATE NOT NULL,
    booking_id BIGINT,
    description TEXT,
    is_posted BOOLEAN DEFAULT FALSE,
    posted_at TIMESTAMP NULL
);

-- Entry Lines (Debits & Credits)
CREATE TABLE accounting_entry_lines (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT NOT NULL,
    line_number SMALLINT NOT NULL,
    account_code VARCHAR(50) NOT NULL,
    
    debit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    credit_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    
    description TEXT,
    
    FOREIGN KEY (entry_id) REFERENCES accounting_entries(id),
    FOREIGN KEY (account_code) REFERENCES chart_of_accounts(account_code),
    
    -- Only debit OR credit, not both
    CONSTRAINT chk_debit_or_credit CHECK (
        (debit_amount > 0 AND credit_amount = 0) OR
        (debit_amount = 0 AND credit_amount > 0)
    )
);

-- Trigger: Ensure balanced entries (Debits = Credits)
CREATE TRIGGER validate_balanced_entry
BEFORE UPDATE ON accounting_entries
FOR EACH ROW
BEGIN
    IF NEW.is_posted = TRUE AND OLD.is_posted = FALSE THEN
        DECLARE v_debits DECIMAL(12,2);
        DECLARE v_credits DECIMAL(12,2);
        
        SELECT SUM(debit_amount), SUM(credit_amount)
        INTO v_debits, v_credits
        FROM accounting_entry_lines
        WHERE entry_id = NEW.id;
        
        IF v_debits != v_credits THEN
            SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Entry not balanced. Debits must equal credits.';
        END IF;
    END IF;
END;
```

**Example Transaction:**

```typescript
// Customer pays $100 for hotel booking
async recordCustomerPayment(bookingId: bigint, amount: number) {
  
  const entry = await this.createEntry(bookingId, 'Customer payment received');
  
  // Debit: Stripe Clearing (Asset increases)
  await this.addLine(entry.id, 1, '1210', amount, 0, 'Payment via Stripe');
  
  // Credit: Customer Deposits (Liability increases)
  await this.addLine(entry.id, 2, '2100', 0, amount, 'Customer deposit');
  
  // Post entry (makes it immutable)
  await this.postEntry(entry.id);
}
```

### 6.2 Payment Processing Flow

```typescript
// ============================================
// Payment Service
// ============================================

export class PaymentService {
  
  async processPayment(params: PaymentParams): Promise<PaymentResult> {
    
    // Step 1: Fraud check
    const fraudCheck = await fraudService.checkTransaction({
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
    
    // Step 3: Record in ledger
    await ledgerService.recordAuthorization(
      params.bookingId,
      authorization.transactionId,
      params.amount,
      params.currency,
      params.provider,
      authorization.providerTxnId
    );
    
    // Step 4: Capture (actually charge)
    const capture = await this.capturePayment(authorization.providerTxnId, params.amount);
    
    if (!capture.success) {
      // Void authorization
      await this.voidAuthorization(authorization.providerTxnId);
      throw new PaymentCaptureError(capture.reason);
    }
    
    // Step 5: Record capture in ledger
    await ledgerService.recordCapture(
      params.bookingId,
      authorization.transactionId,
      params.amount,
      params.currency
    );
    
    // Step 6: Update accounting
    await accountingService.recordCustomerPayment({
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
    
    // Call payment gateway (Stripe example)
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
      return {
        success: false,
        reason: error.message
      };
    }
  }
  
  private async capturePayment(providerTxnId: string, amount: number): Promise<any> {
    
    try {
      await stripe.paymentIntents.capture(providerTxnId, {
        amount_to_capture: Math.round(amount * 100)
      });
      
      return { success: true };
      
    } catch (error) {
      return {
        success: false,
        reason: error.message
      };
    }
  }
}
```

---

## 7. Security & Compliance

### 7.1 GDPR Compliance

**Right to be Forgotten:**

```typescript
// ============================================
// GDPR Data Deletion Service
// ============================================

export class GDPRService {
  
  async deleteUserData(userId: bigint, email: string): Promise<void> {
    
    const connection = await db.getConnection();
    const deletedTables: string[] = [];
    
    try {
      await connection.beginTransaction();
      
      // Create deletion request
      const [reqResult] = await connection.execute(`
        INSERT INTO gdpr_deletion_requests (user_id, email, status)
        VALUES (?, ?, 'processing')
      `, [userId, email]);
      
      const requestId = reqResult.insertId;
      
      // Hash identifiers
      const emailHash = this.hashPII(email, 'email');
      
      // Delete PII
      await connection.execute(`
        DELETE FROM device_fingerprints
        WHERE fingerprint_hash IN (
          SELECT DISTINCT device_fingerprint
          FROM fraud_checks
          WHERE user_id = ?
        )
      `, [userId]);
      deletedTables.push('device_fingerprints');
      
      // Anonymize fraud data (keep stats)
      await connection.execute(`
        UPDATE email_reputation
        SET email_hash = ?,
            status = 'anonymized'
        WHERE email_hash = ?
      `, [randomBytes(32).toString('hex'), emailHash]);
      deletedTables.push('email_reputation');
      
      // Anonymize fraud checks
      await connection.execute(`
        UPDATE fraud_checks
        SET ip_address = '0.0.0.0',
            user_agent = 'ANONYMIZED',
            device_fingerprint = 'DELETED'
        WHERE user_id = ?
      `, [userId]);
      deletedTables.push('fraud_checks');
      
      // Soft delete bookings (keep for legal/accounting)
      await connection.execute(`
        UPDATE bookings
        SET deleted_at = NOW()
        WHERE user_id = ?
        AND deleted_at IS NULL
      `, [userId]);
      deletedTables.push('bookings');
      
      // Mark request as complete
      await connection.execute(`
        UPDATE gdpr_deletion_requests
        SET processed_at = NOW(),
            status = 'completed',
            deleted_tables = ?
        WHERE id = ?
      `, [JSON.stringify(deletedTables), requestId]);
      
      await connection.commit();
      
      console.log(`GDPR deletion completed for user ${userId}`);
      
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  
  private hashPII(data: string, category: string): string {
    const salt = process.env.PII_SALT;
    
    return createHash('sha256')
      .update(`${category}:${salt}:${data.toLowerCase()}`)
      .digest('hex');
  }
}
```

### 7.2 Fraud Detection

```typescript
// ============================================
// Fraud Detection Service
// ============================================

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
    
    // 1. IP Country Mismatch
    const ipCountry = await this.getCountryFromIP(params.ipAddress);
    const billingCountry = await this.getBillingCountry(params.userId);
    
    if (ipCountry !== billingCountry) {
      riskScore += 30;
      triggeredRules.push('ip_country_mismatch');
    }
    
    // 2. Velocity Check (bookings per hour)
    const recentBookings = await this.getRecentBookings(params.userId, 60);
    if (recentBookings.length >= 5) {
      riskScore += 40;
      triggeredRules.push('high_velocity');
    }
    
    // 3. Amount Threshold
    if (params.amount > 5000) {
      riskScore += 45;
      triggeredRules.push('high_amount');
    }
    
    // 4. Device Reputation
    const deviceRisk = await this.checkDeviceReputation(params.deviceFingerprint);
    riskScore += deviceRisk.score;
    if (deviceRisk.score > 0) {
      triggeredRules.push('device_risk');
    }
    
    // 5. Email Reputation
    const emailRisk = await this.checkEmailReputation(params.email);
    riskScore += emailRisk.score;
    if (emailRisk.score > 0) {
      triggeredRules.push('email_risk');
    }
    
    // 6. BIN Lookup
    const binRisk = await this.checkCardBIN(params.cardBIN);
    riskScore += binRisk.score;
    if (binRisk.score > 0) {
      triggeredRules.push('bin_risk');
    }
    
    // Determine status
    let status: FraudStatus;
    if (riskScore >= 80) {
      status = 'blocked';
    } else if (riskScore >= 50) {
      status = 'under_review';
    } else if (riskScore >= 25) {
      status = 'flagged';
    } else {
      status = 'passed';
    }
    
    // Save fraud check
    await this.saveFraudCheck({
      userId: params.userId,
      riskScore,
      triggeredRules,
      status
    });
    
    // Alert if high risk
    if (status === 'blocked' || status === 'under_review') {
      await this.alertFraudTeam(params.userId, riskScore, triggeredRules);
    }
    
    return {
      status,
      riskScore,
      triggeredRules,
      canProceed: status !== 'blocked'
    };
  }
}
```

---

## 8. Monitoring & Observability

### 8.1 Prometheus Metrics

```typescript
// ============================================
// Metrics Collection
// ============================================

import promClient from 'prom-client';

export class MetricsService {
  
  private static registry = new promClient.Registry();
  
  // Booking metrics
  static bookingCreationTime = new promClient.Histogram({
    name: 'booking_creation_duration_seconds',
    help: 'Time to create booking',
    labelNames: ['booking_type', 'status'],
    buckets: [0.5, 1, 2, 5, 10, 30]
  });
  
  static bookingCounter = new promClient.Counter({
    name: 'bookings_total',
    help: 'Total bookings',
    labelNames: ['booking_type', 'status']
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
  
  static {
    // Register all metrics
    this.registry.registerMetric(this.bookingCreationTime);
    this.registry.registerMetric(this.bookingCounter);
    this.registry.registerMetric(this.inventoryOversellCounter);
    this.registry.registerMetric(this.lockContentionCounter);
    this.registry.registerMetric(this.paymentLatency);
    this.registry.registerMetric(this.paymentFailureRate);
    
    // Default metrics
    promClient.collectDefaultMetrics({ register: this.registry });
  }
  
  static async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }
}

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await MetricsService.getMetrics());
});
```

### 8.2 Alert Rules

```yaml
# prometheus-alerts.yml
groups:
  - name: booking_alerts
    interval: 30s
    rules:
      # Critical: Low booking success rate
      - alert: BookingSuccessRateCritical
        expr: |
          rate(bookings_total{status="success"}[5m]) / 
          rate(bookings_total[5m]) < 0.995
        for: 2m
        labels:
          severity: critical
          team: platform
        annotations:
          summary: "Booking success rate below 99.5%"
          description: "Only {{ $value | humanizePercentage }} bookings succeeding"
          
      # Critical: Oversell detected
      - alert: InventoryOversellDetected
        expr: increase(inventory_oversell_attempts_total[1m]) > 0
        for: 0s
        labels:
          severity: critical
          team: inventory
        annotations:
          summary: "Inventory oversell detected"
          description: "{{ $value }} oversell attempts in last minute"
          
      # Warning: High payment latency
      - alert: PaymentLatencyHigh
        expr: |
          histogram_quantile(0.95, 
            rate(payment_duration_seconds_bucket[5m])
          ) > 2
        for: 5m
        labels:
          severity: warning
          team: payments
        annotations:
          summary: "Payment latency is high"
          description: "P95 latency: {{ $value }}s (threshold: 2s)"
```

### 8.3 Distributed Tracing

```typescript
// ============================================
// OpenTelemetry Tracing
// ============================================

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

const tracer = trace.getTracer('booking-service', '1.0.0');

export class BookingService {
  
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    
    // Start span
    const span = tracer.startSpan('createBooking', {
      attributes: {
        'booking.type': dto.bookingType,
        'booking.user_id': dto.userId,
        'booking.amount': dto.totalAmount
      }
    });
    
    try {
      // Set current span in context
      return await context.with(trace.setSpan(context.active(), span), async () => {
        
        // Child span: Check availability
        const availabilitySpan = tracer.startSpan('checkAvailability', {
          parent: span
        });
        const available = await inventoryService.checkAvailability(dto);
        availabilitySpan.end();
        
        if (!available) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not available' });
          throw new InsufficientInventoryError();
        }
        
        // Child span: Process payment
        const paymentSpan = tracer.startSpan('processPayment', {
          parent: span,
          attributes: {
            'payment.provider': dto.paymentProvider,
            'payment.amount': dto.totalAmount
          }
        });
        const payment = await paymentService.processPayment(dto);
        paymentSpan.end();
        
        // Create booking
        const booking = await this.createBookingRecord(dto, payment.id);
        
        span.setAttribute('booking.id', booking.id);
        span.setStatus({ code: SpanStatusCode.OK });
        
        return booking;
      });
      
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

---

## 9. Capacity Planning & Infrastructure

### 9.1 Traffic Model

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
  
  geographic: {
    'us-east-1': 0.35,
    'eu-west-1': 0.30,
    'ap-southeast-1': 0.25,
    'sa-east-1': 0.10
  },
  
  bookingTypes: {
    hotel: 0.45,
    flight: 0.35,
    car: 0.15,
    package: 0.05
  }
};
```

### 9.2 Infrastructure Sizing

**Database (MySQL):**
- 16 shards
- 1 primary + 4 read replicas per shard
- db.r6g.4xlarge (16 vCPUs, 128 GB RAM)
- 3 TB io2 storage per shard
- **Cost:** ~$504k/month

**Redis Clusters:**
- Sessions: 6 nodes (3 masters + 3 replicas)
- Fencing: 6 nodes
- Cache: 9 nodes
- Rate Limiting: 3 nodes
- **Cost:** ~$17.4k/month

**Kafka:**
- 15 brokers
- kafka.m5.2xlarge (8 vCPUs, 32 GB RAM)
- 4 TB storage per broker
- 500+ partitions total
- **Cost:** ~$33.5k/month

**Kubernetes:**
- 33 nodes per region × 4 regions
- Mix of general, memory, and compute node types
- **Cost:** ~$72.5k/month

**Total Infrastructure Cost:** ~$1.47M/month

### 9.3 Deployment Regions

```yaml
regions:
  - name: us-east-1
    type: primary
    traffic_share: 35%
    availability_zones: 3
    
  - name: eu-west-1
    type: primary
    traffic_share: 30%
    availability_zones: 3
    
  - name: ap-southeast-1
    type: primary
    traffic_share: 25%
    availability_zones: 3
    
  - name: sa-east-1
    type: secondary
    traffic_share: 10%
    availability_zones: 2
```

---

## 10. Deployment Strategy

### 10.1 CI/CD Pipeline

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build
  - deploy-staging
  - deploy-production

variables:
  DOCKER_REGISTRY: registry.company.com
  KUBERNETES_NAMESPACE: production

# Test stage
test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run lint
    - npm run test:unit
    - npm run test:integration
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage/cobertura-coverage.xml

# Build stage
build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker login -u $CI_REGISTRY_USER -p $CI_REGISTRY_PASSWORD $DOCKER_REGISTRY
    - docker build -t $DOCKER_REGISTRY/booking-service:$CI_COMMIT_SHA .
    - docker push $DOCKER_REGISTRY/booking-service:$CI_COMMIT_SHA
  only:
    - main
    - develop

# Deploy to staging
deploy-staging:
  stage: deploy-staging
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context staging
    - kubectl set image deployment/booking-service 
        booking-service=$DOCKER_REGISTRY/booking-service:$CI_COMMIT_SHA
        -n staging
    - kubectl rollout status deployment/booking-service -n staging
  environment:
    name: staging
    url: https://staging-api.company.com
  only:
    - develop

# Deploy to production (manual approval)
deploy-production:
  stage: deploy-production
  image: bitnami/kubectl:latest
  script:
    - kubectl config use-context production
    # Blue-green deployment
    - kubectl apply -f k8s/booking-service-green.yaml
    - ./scripts/run-smoke-tests.sh green
    - kubectl patch service booking-service -p '{"spec":{"selector":{"version":"green"}}}'
    - sleep 300  # Monitor for 5 minutes
    - kubectl delete deployment booking-service-blue
  environment:
    name: production
    url: https://api.company.com
  when: manual
  only:
    - main
```

### 10.2 Kubernetes Deployment

```yaml
# k8s/booking-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: production
  labels:
    app: booking-service
    version: v1
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
        version: v1
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: booking-service
      
      # Init container for migrations
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
              name: http
              protocol: TCP
          
          # Resource limits
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          
          # Environment variables
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3000"
            - name: REGION
              value: "us-east-1"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: redis-url
            - name: KAFKA_BROKERS
              valueFrom:
                configMapKeyRef:
                  name: booking-service-config
                  key: kafka-brokers
          
          # Health checks
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
          
          # Graceful shutdown
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
      
      # Pod disruption budget
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values:
                        - booking-service
                topologyKey: kubernetes.io/hostname

---
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  type: ClusterIP
  sessionAffinity: ClientIP
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
      name: http
  selector:
    app: booking-service

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
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Percent
          value: 50
          periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
```

### 10.3 Migration Plan

```markdown
# Production Migration Plan

## Phase 1: Foundation (Weeks 1-4)
✅ Week 1: Infrastructure setup
  - VPC & networking
  - Database shards
  - Redis clusters
  
✅ Week 2: Kubernetes setup
  - EKS clusters
  - Service mesh (Istio)
  - Ingress controllers
  
✅ Week 3: Kafka deployment
  - Broker cluster
  - Topic creation
  - Schema registry
  
✅ Week 4: Monitoring stack
  - Prometheus
  - Grafana
  - ELK Stack
  - PagerDuty integration

## Phase 2: Core Services (Weeks 5-8)
✅ Week 5-6: Deploy services
  - Booking service
  - Inventory service
  - Payment service
  
✅ Week 7: Integrations
  - Stripe integration
  - Supplier APIs
  - Email/SMS providers
  
✅ Week 8: Testing
  - Integration tests
  - End-to-end tests

## Phase 3: Advanced Features (Weeks 9-12)
✅ Week 9: Fraud detection
✅ Week 10: Analytics pipeline
✅ Week 11: Search integration (Algolia)
✅ Week 12: Admin dashboard

## Phase 4: Load Testing (Weeks 13-16)
✅ Week 13: Baseline tests (10k/min)
✅ Week 14: Ramp up (50k/min)
✅ Week 15: Peak load (100k/min)
✅ Week 16: Chaos engineering

## Phase 5: Production Launch (Week 17+)
✅ Week 17: Soft launch (10% traffic)
✅ Week 18: Gradual rollout (50% traffic)
✅ Week 19: Full production (100% traffic)
✅ Week 20+: Monitoring & optimization
```

---

## 11. API Documentation

### 11.1 REST API Endpoints

#### **Create Booking**

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
    {
      "adultsCount": 2,
      "childrenCount": 0,
      "bedType": "king"
    },
    {
      "adultsCount": 1,
      "childrenCount": 1,
      "bedType": "queen"
    }
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

**Response:**

```json
{
  "success": true,
  "data": {
    "bookingId": 9876543210,
    "referenceCode": "HT-20260215-000042",
    "status": "confirmed",
    "totalAmount": 880.00,
    "currency": "USD",
    "hotel": {
      "name": "Grand Hotel",
      "address": "123 Main St, New York, NY"
    },
    "checkIn": "2026-03-15T15:00:00Z",
    "checkOut": "2026-03-20T11:00:00Z",
    "confirmationNumber": "GH-20260315-42",
    "createdAt": "2026-02-15T10:30:00Z"
  }
}
```

#### **Check Availability**

```http
GET /api/v1/inventory/availability
  ?resourceType=hotel_room
  &resourceId=12345
  &checkIn=2026-03-15
  &checkOut=2026-03-20
  &quantity=2
```

**Response:**

```json
{
  "success": true,
  "data": {
    "available": true,
    "availableQuantity": 15,
    "totalQuantity": 20,
    "price": {
      "basePrice": 200.00,
      "currency": "USD",
      "perNight": true
    }
  }
}
```

#### **Get Booking Details**

```http
GET /api/v1/bookings/:id
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 9876543210,
    "referenceCode": "HT-20260215-000042",
    "bookingType": "hotel",
    "status": "confirmed",
    "hotel": {
      "id": 12345,
      "name": "Grand Hotel",
      "address": "123 Main St, New York, NY",
      "phone": "+1-555-0100"
    },
    "checkIn": "2026-03-15T15:00:00Z",
    "checkOut": "2026-03-20T11:00:00Z",
    "nights": 5,
    "rooms": [
      {
        "roomNumber": "501",
        "adultsCount": 2,
        "childrenCount": 0,
        "bedType": "king"
      }
    ],
    "pricing": {
      "subtotal": 800.00,
      "taxAmount": 80.00,
      "discountAmount": 0.00,
      "totalAmount": 880.00,
      "currency": "USD"
    },
    "payment": {
      "status": "completed",
      "method": "credit_card",
      "last4": "4242"
    },
    "createdAt": "2026-02-15T10:30:00Z",
    "confirmedAt": "2026-02-15T10:30:15Z"
  }
}
```

#### **Cancel Booking**

```http
POST /api/v1/bookings/:id/cancel
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "user_cancelled",
  "reasonNotes": "Change of plans"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "bookingId": 9876543210,
    "status": "cancelled",
    "cancellationFee": 100.00,
    "refundAmount": 780.00,
    "refundStatus": "processing",
    "estimatedRefundDate": "2026-02-22",
    "cancelledAt": "2026-02-15T14:20:00Z"
  }
}
```

### 11.2 Error Responses

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "The requested room is no longer available",
    "details": {
      "resourceType": "hotel_room",
      "resourceId": 12345,
      "requestedQuantity": 2,
      "availableQuantity": 0
    },
    "timestamp": "2026-02-15T10:30:00Z",
    "requestId": "req_abc123xyz"
  }
}
```

**Error Codes:**

- `INSUFFICIENT_INVENTORY` - Resource not available
- `PAYMENT_DECLINED` - Payment failed
- `FRAUD_BLOCKED` - Transaction blocked by fraud detection
- `INVALID_REQUEST` - Validation error
- `BOOKING_NOT_FOUND` - Booking doesn't exist
- `UNAUTHORIZED` - Authentication required
- `FORBIDDEN` - Insufficient permissions
- `RATE_LIMIT_EXCEEDED` - Too many requests

---

## 12. Development Guidelines

### 12.1 Code Structure

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
├── docs/
├── scripts/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### 12.2 Coding Standards

```typescript
// ============================================
// Example: Clean Code Structure
// ============================================

// 1. Use dependency injection
@Injectable()
export class BookingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly eventStore: EventStoreService,
    private readonly logger: Logger
  ) {}
}

// 2. Use DTOs for validation
export class CreateBookingDto {
  @IsNotEmpty()
  @IsEnum(BookingType)
  bookingType: BookingType;
  
  @IsPositive()
  @IsNumber()
  resourceId: number;
  
  @IsISO8601()
  checkIn: string;
  
  @IsISO8601()
  checkOut: string;
  
  @ValidateNested()
  @Type(() => PaymentMethodDto)
  paymentMethod: PaymentMethodDto;
}

// 3. Use Result pattern for error handling
type Result<T> = 
  | { success: true; data: T }
  | { success: false; error: Error };

async function createBooking(dto: CreateBookingDto): Promise<Result<Booking>> {
  try {
    const booking = await this.bookingService.create(dto);
    return { success: true, data: booking };
  } catch (error) {
    this.logger.error('Booking creation failed', error);
    return { success: false, error };
  }
}

// 4. Use custom exceptions
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

### 12.3 Testing Strategy

```typescript
// ============================================
// Unit Test Example
// ============================================

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
    
    bookingService = new BookingService(
      inventoryService,
      paymentService,
      // ... other dependencies
    );
  });
  
  describe('createBooking', () => {
    it('should create booking successfully', async () => {
      // Arrange
      const dto: CreateBookingDto = {
        bookingType: 'hotel',
        resourceId: 12345,
        // ... other fields
      };
      
      inventoryService.checkAvailability.mockResolvedValue(true);
      inventoryService.createHold.mockResolvedValue({ id: 1, /* ... */ });
      paymentService.processPayment.mockResolvedValue({ id: 2, /* ... */ });
      
      // Act
      const result = await bookingService.createBooking(dto);
      
      // Assert
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('confirmed');
      expect(inventoryService.createHold).toHaveBeenCalledTimes(1);
      expect(paymentService.processPayment).toHaveBeenCalledTimes(1);
    });
    
    it('should rollback hold if payment fails', async () => {
      // Arrange
      inventoryService.checkAvailability.mockResolvedValue(true);
      inventoryService.createHold.mockResolvedValue({ id: 1, /* ... */ });
      paymentService.processPayment.mockRejectedValue(
        new PaymentDeclinedError('Card declined')
      );
      
      // Act
      const result = await bookingService.createBooking(dto);
      
      // Assert
      expect(result.success).toBe(false);
      expect(inventoryService.releaseHold).toHaveBeenCalledWith(1);
    });
  });
});
```

```typescript
// ============================================
// Integration Test Example
// ============================================

describe('Booking Flow Integration', () => {
  let app: INestApplication;
  let db: DatabaseService;
  
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();
    
    app = moduleRef.createNestApplication();
    await app.init();
    
    db = moduleRef.get(DatabaseService);
  });
  
  afterAll(async () => {
    await db.close();
    await app.close();
  });
  
  it('should complete full booking flow', async () => {
    // 1. Check availability
    const availabilityResponse = await request(app.getHttpServer())
      .get('/api/v1/inventory/availability')
      .query({
        resourceType: 'hotel_room',
        resourceId: 12345,
        checkIn: '2026-03-15',
        checkOut: '2026-03-20',
        quantity: 1
      })
      .expect(200);
    
    expect(availabilityResponse.body.data.available).toBe(true);
    
    // 2. Create booking
    const bookingResponse = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test_token')
      .set('Idempotency-Key', 'test_key_123')
      .send({
        bookingType: 'hotel',
        hotelId: 12345,
        checkIn: '2026-03-15',
        checkOut: '2026-03-20',
        // ... other fields
      })
      .expect(201);
    
    const bookingId = bookingResponse.body.data.bookingId;
    expect(bookingId).toBeDefined();
    
    // 3. Verify booking in database
    const booking = await db.query(
      'SELECT * FROM bookings WHERE id = ?',
      [bookingId]
    );
    
    expect(booking[0].status).toBe('confirmed');
    
    // 4. Verify inventory updated
    const inventory = await db.query(
      'SELECT * FROM inventory WHERE resource_id = ?',
      [12345]
    );
    
    expect(inventory[0].reserved_quantity).toBeGreaterThan(0);
  });
});
```

### 12.4 Environment Variables

```bash
# .env.example

# Application
NODE_ENV=production
PORT=3000
REGION=us-east-1

# Database
DATABASE_HOST=booking-db-shard-01.us-east-1.rds.amazonaws.com
DATABASE_PORT=3306
DATABASE_NAME=booking_production
DATABASE_USER=booking_app
DATABASE_PASSWORD=<secret>
DATABASE_POOL_MIN=50
DATABASE_POOL_MAX=200

# Redis
REDIS_SESSIONS_URL=redis://sessions-cluster.us-east-1.cache.amazonaws.com:6379
REDIS_FENCING_URL=redis://fencing-cluster.us-east-1.cache.amazonaws.com:6379
REDIS_CACHE_URL=redis://cache-cluster.us-east-1.cache.amazonaws.com:6379

# Kafka
KAFKA_BROKERS=kafka-1.us-east-1:9092,kafka-2.us-east-1:9092,kafka-3.us-east-1:9092
KAFKA_CLIENT_ID=booking-service
KAFKA_GROUP_ID=booking-service-consumer

# Payment
STRIPE_API_KEY=sk_live_<secret>
STRIPE_WEBHOOK_SECRET=whsec_<secret>

# Monitoring
DATADOG_API_KEY=<secret>
SENTRY_DSN=https://<key>@sentry.io/<project>

# Feature Flags
ENABLE_FRAUD_DETECTION=true
ENABLE_MULTI_REGION_SYNC=true
```

---

## 📚 Appendix

### A. Glossary

- **Fencing Token:** Monotonically increasing number used to order distributed operations
- **Idempotency Key:** Unique identifier to prevent duplicate operations
- **Event Sourcing:** Storing all changes as a sequence of events
- **CQRS:** Command Query Responsibility Segregation
- **Circuit Breaker:** Pattern to prevent cascading failures
- **Saga Pattern:** Managing distributed transactions

### B. Related Documentation

- Database Schema Reference
- API Reference (OpenAPI/Swagger)
- Runbooks for Common Issues
- Disaster Recovery Procedures
- Security Best Practices
- Performance Tuning Guide

### C. Contact & Support

- **Engineering Team:** platform@company.com
- **On-Call:** PagerDuty escalation
- **Documentation:** https://docs.company.com
- **Internal Wiki:** https://wiki.company.com

---

**Document Version:** 1.0  
**Last Updated:** February 15, 2026  
**Maintained By:** Platform Engineering Team  
**Review Cycle:** Quarterly

---

## 🎯 Quick Start for Developers

```bash
# 1. Clone repository
git clone https://github.com/company/booking-platform.git
cd booking-platform

# 2. Install dependencies
npm install

# 3. Setup environment
cp .env.example .env.local
# Edit .env.local with your credentials

# 4. Start local database
docker-compose up -d mysql redis kafka

# 5. Run migrations
npm run migrate

# 6. Start development server
npm run dev

# 7. Run tests
npm test

# 8. Build for production
npm run build
```

**You're ready to build! 🚀**
