# BACK MATTER

---

## Appendix A: Common Mistakes Reference

This appendix collects all seven **Common Mistake** callouts from the book into one place. Each entry describes a bug that looks correct during code review but fails in production. Use this as a checklist during design reviews and pull requests.

---

### Mistake 1: Hardcoded Service Endpoints
**Chapter:** 6 (System Architecture Deep Dive)
**Category:** Infrastructure / Service Discovery

**The Bug:** An earlier version listed three specific pod IP addresses and implemented manual round-robin load balancing across them.

**Why It Fails:** In Kubernetes, pods are ephemeral. When a pod restarts, crashes, or gets rescheduled, its IP address changes. Hardcoded addresses become stale, and requests start failing with connection timeouts. This failure mode is particularly insidious because it works perfectly in testing (where pods rarely restart) and only manifests under real operational conditions.

**The Fix:** Always use Kubernetes service DNS names (`service-name.namespace.svc.cluster.local`) and let the kube-proxy or service mesh handle load balancing. The service abstraction provides a stable virtual IP that automatically routes to healthy pods.

**Lesson:** Never couple application code to infrastructure-level details that are designed to be dynamic.

---

### Mistake 2: DECLARE After IF in MySQL Triggers
**Chapter:** 13 (Financial Ledger & Double-Entry Accounting)
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
**Chapter:** 13 (Financial Ledger & Double-Entry Accounting)
**Category:** Financial / Accounting Principles

**The Bug:** An earlier version combined revenue recognition and cost accrual into a single 4-line journal entry. The entry was technically balanced (total debits equaled total credits).

**Why It Fails:** While mathematically correct, this violates the accounting principle of separating distinct economic events. Revenue recognition (transferring a customer deposit to revenue) and cost accrual (recording an expense owed to a supplier) are independent transactions. They may occur at different times, involve different approval workflows, and need to be auditable separately. Combining them makes it impossible to reverse one without affecting the other, creates incorrect financial reports if one event's timing changes, and fails audit scrutiny.

**The Fix:** Create separate journal entries for each distinct economic event, even if they relate to the same booking. Each entry should be independently balanced and independently reversible.

**Lesson:** In financial systems, mathematical correctness is necessary but not sufficient. Business semantics matter -- the structure of your data must reflect the structure of the real-world events it represents.

---

### Mistake 4: SQL Injection in Date Filtering
**Chapter:** 13 (Financial Ledger & Double-Entry Accounting)
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
**Chapter:** 17 (Multi-Region Conflict Resolution)
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
**Chapter:** 21 (Circuit Breaker & Bulkhead)
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
**Chapter:** 35 (Capacity Planning)
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

| # | Check | Chapter |
|---|-------|---------|
| 1 | Are service endpoints resolved via DNS, not hardcoded IPs? | 6 |
| 2 | Are all `DECLARE` statements at the top of MySQL `BEGIN` blocks? | 13 |
| 3 | Are distinct economic events recorded as separate journal entries? | 13 |
| 4 | Are all SQL queries parameterized, including dates and "safe" values? | 13 |
| 5 | Does timeout handling verify state rather than assuming success? | 17 |
| 6 | Do circuit breaker fallbacks declare the correct parameter signature? | 21 |
| 7 | Is Kafka running in KRaft mode (not ZooKeeper) for version 3.3+? | 35 |

---

## Appendix B: Capstone Project

### Build a Complete Booking Flow

This capstone project ties together concepts from all 44 chapters. You will build a working subset of the Global Booking System that handles the end-to-end flow from search to confirmation, including failure scenarios.

### Project Scope

Build a simplified booking platform with the following components:

1. **API Gateway** (Chapter 8) -- A single Express.js entry point with JWT authentication (Chapter 9)
2. **Search Service** (Chapter 10) -- Query available rooms from a local Elasticsearch instance
3. **Inventory Service** (Chapter 11) -- Hold rooms with fencing tokens (Chapter 15) and idempotency keys (Chapter 16)
4. **Booking Service** (Chapter 12) -- Orchestrate the booking saga (Chapter 19)
5. **Financial Ledger** (Chapter 13) -- Record double-entry journal entries for the completed booking
6. **Notification Service** (Chapter 14) -- Send a confirmation email via an event-driven outbox (Chapter 18)

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
Use the Docker Compose configuration from Chapter 39 to launch:
- MySQL 8.0 (single instance, no sharding needed for the capstone)
- Redis (for distributed locks and caching)
- Kafka in KRaft mode (for event streaming)
- Elasticsearch (for search)

#### Step 2: Create the Database Schema
Implement the schemas from Chapter 7:
- `properties` and `room_types` tables
- `bookings` and `booking_events` tables (event sourcing)
- `inventory_holds` table with `fencing_token` column (Chapters 11, 15)
- `journal_entries` and `account_entries` tables (Chapter 13)
- `outbox_events` table (Chapter 18)
- Add the immutability triggers from Chapter 13

#### Step 3: Implement the Inventory Hold with Fencing Tokens
Build the `InventoryHoldService` from Chapter 11:
- Acquire a Redis distributed lock before modifying inventory
- Use `SELECT ... WHERE fencing_token < ? FOR UPDATE` to validate the token
- Implement the hold state machine: `PENDING` -> `CONFIRMED` / `EXPIRED` / `RELEASED`
- Write an idempotency wrapper (Chapter 16)

#### Step 4: Build the Booking Saga
Implement the `BookingSagaOrchestrator` from Chapter 19:
- Define saga steps: Hold Inventory -> Process Payment (mock) -> Record in Ledger -> Confirm Booking
- Implement compensating actions for each step: Release Hold, Refund Payment, Reverse Journal Entry, Cancel Booking
- Handle partial failures by running compensations in reverse order
- Persist saga state to the database for crash recovery

#### Step 5: Add the Financial Ledger
Implement the `AccountingService` from Chapter 13:
- `createJournalEntry` with balance validation (debits must equal credits)
- `generateEntryNumber` with the atomic sequence table
- Create entries for: Guest Deposit, Revenue Recognition, Cost Accrual
- Verify immutability triggers prevent modification of posted entries

#### Step 6: Implement the Outbox Pattern
Build the outbox publisher from Chapter 18:
- Insert events into the `outbox_events` table within the same transaction as business data
- Build a polling process that reads unpublished events and sends them to Kafka
- Mark events as published after successful Kafka acknowledgment
- Handle the notification consumer that reads from Kafka and logs "email sent"

#### Step 7: Add Resilience
Apply patterns from Part IV:
- Wrap external calls with circuit breakers (Chapter 21)
- Add retry with exponential backoff for transient failures (Chapter 23)
- Implement a rate limiter on the API Gateway (Chapter 22)

#### Step 8: Add Observability
Apply patterns from Part VI:
- Add Prometheus metrics: booking counter, saga duration histogram, error rate (Chapter 30)
- Add structured logging with correlation IDs (Chapter 31)
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
| **Code Quality** | Does the code follow the patterns from Chapter 41 (DI, DTOs, Result pattern)? |

### Extension Challenges

Once the core capstone is complete, try these extensions:

1. **Multi-Region Simulation** (Chapter 17): Run two instances of the booking service on different ports, simulating two regions. Implement conflict detection via Kafka and verify that fencing tokens resolve conflicts correctly.

2. **CQRS Read Model** (Chapter 20): Build a search projector that consumes `booking.confirmed` events from Kafka and updates Elasticsearch. Verify that the search results reflect confirmed bookings.

3. **Cache Stampede Prevention** (Chapter 24): Implement the probabilistic early refresh pattern from Chapter 24 on the room availability endpoint. Use a load testing tool to simulate a cache expiry under high concurrency and verify that only one request hits the database.

4. **GDPR Data Deletion** (Chapter 29): Implement the `GDPRService.processErasureRequest` method that anonymizes a guest's personal data across all tables using the `SCAN`-based Redis cleanup (not `KEYS`).

---

## Appendix C: Chapter Cross-Reference Index

This index maps key concepts to the chapters where they are discussed in depth.

| Concept | Primary Chapter | Also Referenced In |
|---------|----------------|-------------------|
| API Gateway & Routing | 8 | 27, 36 |
| Authentication (JWT) | 9 | 8, 27 |
| Booking Events (Event Sourcing) | 7 | 12, 18, 20 |
| Bulkhead Pattern | 21 | 26 |
| Cache Stampede Prevention | 24 | 26, 39 |
| Capacity Planning | 35 | 36, 38 |
| CI/CD Pipeline | 37 | 42 |
| Circuit Breaker | 21 | 19, 26 |
| CQRS (Command Query Separation) | 20 | 10, 18 |
| Database Sharding | 7 | 11, 35 |
| Dead Letter Queue (DLQ) | 25 | 18, 19 |
| Distributed Locking (Redis) | 15 | 11, 17 |
| Distributed Tracing | 31 | 30, 33 |
| Docker Compose (Local Dev) | 39 | 35, 38 |
| Double-Entry Accounting | 13 | 19 |
| Fencing Tokens | 15 | 11, 17 |
| Financial Ledger | 13 | 12, 19 |
| Fraud Detection | 28 | 9, 12 |
| GDPR / Data Privacy | 29 | 27, 40 |
| Health Checks | 34 | 26, 36 |
| Idempotency Keys | 16 | 12, 22 |
| Incident Response | 33 | 30, 32 |
| Infrastructure as Code (Terraform) | 38 | 35, 36 |
| Inventory Holds | 11 | 15, 19 |
| Kafka (KRaft mode) | 35 | 18, 25, 43 |
| Kubernetes Deployment | 36 | 35, 37, 38 |
| Monitoring & Alerting | 30 | 32, 33 |
| Multi-Region Conflict Resolution | 17 | 15, 34 |
| Notification Service | 14 | 18, 25 |
| Outbox Pattern | 18 | 14, 20 |
| Payment Processing | 13 | 12, 19 |
| Rate Limiting | 27 | 8, 26 |
| Retry with Backoff | 22 | 21, 25 |
| Saga Pattern (Orchestration) | 19 | 12, 13, 18 |
| Schema Registry & Events | 43 | 18, 20 |
| Search Service (Elasticsearch) | 10 | 20, 39 |
| SLO/SLI Definitions | 32 | 30, 33 |
| Testing Strategy | 42 | 37, 41 |
| Thundering Herd Protection | 26 | 24, 34 |
| Timeout & Retry | 22 | 17, 21 |

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
