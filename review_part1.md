# Technical Review Report: Global Booking System E-Book (Chapters 8-18)

**Reviewer**: Technical Review Agent
**Date**: 2026-02-15
**Scope**: Chapters 8 through 18 (11 chapters)
**Review Dimensions**: Code correctness, Educational quality, Consistency, Missing content, Misleading information

---

## Executive Summary

Chapters 8-18 cover the backend services layer of the Global Booking System, spanning API gateway design, authentication, search, inventory, booking orchestration, financial ledger, notifications, distributed locking, idempotency, multi-region conflict resolution, and the outbox pattern. The writing is consistently strong in its mentorship tone, with effective analogies and war stories that ground abstract distributed systems concepts in practical scenarios.

The most significant systemic issue is **database engine inconsistency**: Chapters 8-13 and 16 use MySQL syntax throughout (AUTO_INCREMENT, ENUM, JSON, ON UPDATE CURRENT_TIMESTAMP), while Chapters 14, 15, and 18 switch to PostgreSQL syntax (BIGSERIAL, TIMESTAMPTZ, JSONB, gen_random_uuid(), pg_advisory_xact_lock) without explanation. This will confuse readers who are following the book sequentially and expect a single database technology.

Six of eleven chapters lack the chapter summary table that appears in the other five. This should be standardized.

**Overall quality**: Strong. Most chapters score B+ or above. Three chapters score A or A-. One chapter (Ch14) has enough issues to warrant a rewrite pass.

---

## Cross-Chapter Issues

These issues affect multiple chapters and should be addressed holistically before per-chapter fixes.

### Issue 1: MySQL vs PostgreSQL Inconsistency (CRITICAL)

| Chapter | Database Syntax Used |
|---------|---------------------|
| Ch 8 (API Gateway) | MySQL |
| Ch 9 (Auth) | MySQL |
| Ch 10 (Search) | MySQL |
| Ch 11 (Inventory) | MySQL |
| Ch 12 (Booking) | MySQL |
| Ch 13 (Financial Ledger) | MySQL |
| Ch 14 (Notifications) | **PostgreSQL** |
| Ch 15 (Distributed Locking) | **PostgreSQL** |
| Ch 16 (Idempotency) | MySQL |
| Ch 17 (Multi-Region) | MySQL |
| Ch 18 (Outbox Pattern) | **PostgreSQL** |

Chapters 14, 15, and 18 use PostgreSQL-specific syntax (BIGSERIAL, TIMESTAMPTZ, JSONB, WAL, pgoutput, `::interval` casts, `gen_random_uuid()`, `pg_advisory_xact_lock`). Their Prisma schemas also use PostgreSQL-specific annotations (`@db.Timestamptz()`, `@db.JsonB`). Meanwhile all SQL examples in Chapters 8-13 use MySQL AUTO_INCREMENT, ENUM types, and MySQL-specific date functions.

**Recommendation**: Pick one database engine for the entire book and standardize. If the book intentionally uses both (e.g., MySQL for core booking, PostgreSQL for analytics), add an explicit note at the start of each chapter that uses a different engine, explaining why.

### Issue 2: Redlock Implementation Duplication

Chapter 11 (Inventory Management) contains a full Redlock implementation with quorum logic, sequential lock acquisition across nodes, and clock drift compensation. Chapter 15 (Distributed Locking) contains another full Redlock implementation covering the same algorithm with only minor differences in variable names.

**Recommendation**: Present the full Redlock implementation in Chapter 15 only. In Chapter 11, reference the algorithm conceptually and forward-reference Chapter 15 for the implementation details. Alternatively, extract the Redlock code into a shared utility chapter.

### Issue 3: Inconsistent Chapter Summary Tables

| Chapter | Has Summary Table? |
|---------|--------------------|
| Ch 8 | No |
| Ch 9 | No |
| Ch 10 | Yes |
| Ch 11 | No |
| Ch 12 | No |
| Ch 13 | No |
| Ch 14 | No |
| Ch 15 | Yes |
| Ch 16 | Yes |
| Ch 17 | Yes |
| Ch 18 | Yes |

**Recommendation**: Add chapter summary tables to Chapters 8, 9, 11, 12, 13, and 14. The format used in Chapters 16-18 (two-column table with Concept and Key Point) is the clearest and most useful version.

---

## Per-Chapter Reviews

---

### Chapter 8: API Gateway — Quality Score: B+

**File**: `e:/Global Booking System/enhanced_ch08.md` (~1363 lines)

**Strengths**:
- Clear progression from "why do you need a gateway" through rate limiting algorithms (token bucket, sliding window log, sliding window counter) to load balancing and request validation
- Effective analogies throughout (hotel lobby security desk, nightclub bouncer)
- Rate limiting algorithm comparison table is excellent for quick reference
- AJV request validation section is practical and immediately usable

**Issues**:

1. **Code Correctness — Kong request-transformer syntax** (Line ~180-190)
   The Kong declarative config includes a `request-transformer` plugin with `add.headers` containing `$(date +%s)`. This is shell variable expansion syntax, not valid Kong configuration. Kong does not execute shell commands in its declarative YAML.
   ```yaml
   # INCORRECT
   add.headers:
     - "X-Request-Start:$(date +%s)"
   ```
   **Fix**: Remove this header or note that it must be added at the NGINX/reverse proxy layer, not in Kong declarative config. Kong supports Lua-based custom plugins for dynamic header injection.

2. **Missing Content — No chapter summary table**
   Chapter ends without the summary table format used in later chapters.

3. **Educational Quality — Minor**
   The sliding window counter algorithm explanation could benefit from a worked numerical example showing how the weighted count is calculated at a specific point in time.

---

### Chapter 9: Authentication and Authorization — Quality Score: B

**File**: `e:/Global Booking System/enhanced_ch09.md` (~1478 lines)

**Strengths**:
- Thorough JWT coverage including RS256 vs HS256 vs ES256 comparison
- Key rotation with JWKS endpoint is production-relevant and rarely covered in tutorials
- argon2id password hashing with correct parameters
- OAuth 2.0 PKCE flow diagram is clear

**Issues**:

1. **Code Correctness — Dead code in ClientCredentialsService** (Line ~950-960)
   ```typescript
   async registerClient(dto: RegisterClientDto): Promise<ServiceClient> {
     const clientId = `svc_${randomBytes(16).toString('hex')}`;
     const clientSecret = `secret_${randomBytes(32).toString('hex')}`;
     const secretHash = await argon2.hash(clientSecret); // ← created but NEVER USED

     const client = await this.prisma.serviceClient.create({
       data: {
         clientId,
         clientSecret,  // ← stores PLAINTEXT secret, not the hash
         // ...
       },
     });
   ```
   The `secretHash` variable is computed but never stored. The plaintext `clientSecret` is saved to the database instead. This defeats the purpose of hashing and is a security vulnerability if it reaches production code that a reader copies.
   **Fix**: Store `secretHash` in the database column (rename `clientSecret` column to `clientSecretHash`), and return the plaintext secret only in the registration response.

2. **Code Correctness — Missing dependency injection in OAuthService** (Line ~1100-1120)
   The `OAuthService` class references `this.authService` in its methods but the constructor does not inject an `AuthService` dependency. This would cause a runtime `TypeError: Cannot read properties of undefined`.
   **Fix**: Add `private readonly authService: AuthService` to the constructor parameters.

3. **Missing Content — No chapter summary table**

---

### Chapter 10: Search with Elasticsearch — Quality Score: A

**File**: `e:/Global Booking System/enhanced_ch10.md` (~2118 lines)

**Strengths**:
- Exceptionally well-structured progression: inverted index fundamentals, mapping design, custom analyzers, geo-distance queries, faceted search, autocomplete (edge n-gram + completion suggester), relevance scoring, bulk indexing, CDC sync, monitoring
- The "book index" analogy for inverted indexes is perfectly calibrated for the target audience
- Practical code throughout — the `SearchService` class is production-ready
- CDC sync section bridges nicely to Chapter 18 (Outbox Pattern)
- Has chapter summary table

**Issues**:
- No significant issues found. This is the cleanest chapter in the reviewed range.
- **Minor**: The Elasticsearch version is not explicitly stated. Given the mapping syntax and API calls used, it appears to target ES 7.x or 8.x. A brief note about version compatibility would be helpful.

---

### Chapter 11: Inventory Management — Quality Score: B

**File**: `e:/Global Booking System/enhanced_ch11.md` (~1572 lines)

**Strengths**:
- Excellent progression from naive concurrent access through pessimistic locking, optimistic locking, and fencing tokens
- Hold pattern (tentative reservation with expiry) is well-explained with clear state machine
- DLQ handling for expired holds is practical
- Overbooking strategy section is a nice real-world touch

**Issues**:

1. **Code Correctness — Logically redundant CHECK constraint** (Line ~120-125)
   ```sql
   CONSTRAINT chk_no_negative CHECK (
     available_quantity >= 0 OR available_quantity >= -5
   )
   ```
   This constraint is always satisfied when `available_quantity >= -5` because `>= 0` is a subset of `>= -5`. The OR makes the `>= 0` clause irrelevant. The constraint effectively only enforces `available_quantity >= -5`.
   **Fix**: If the intent is to allow up to 5 overbookings, the constraint should be simply `available_quantity >= -5`. If the intent is to prevent negatives, it should be `available_quantity >= 0`. The OR of both is logically equivalent to just the weaker condition.

2. **Consistency — Redlock duplication with Chapter 15**
   Lines ~680-780 contain a full Redlock implementation (quorum acquisition across N Redis nodes, clock drift factor, sequential locking). Chapter 15 presents the same algorithm in greater detail. Having two implementations creates maintenance burden and risks divergence.
   **Recommendation**: Replace the full implementation in Chapter 11 with a conceptual description and a forward reference to Chapter 15.

3. **Missing Content — No chapter summary table**

---

### Chapter 12: Booking Service Orchestration — Quality Score: B-

**File**: `e:/Global Booking System/enhanced_ch12.md` (~1551 lines)

**Strengths**:
- Orchestrator pattern is well-motivated with comparison to choreography
- Booking state machine with 7 states covers the full lifecycle
- Business rules engine pattern is practical and extensible
- Good integration with outbox pattern concepts

**Issues**:

1. **Code Correctness — Dual AUTO_INCREMENT columns (CRITICAL)** (Line ~280-310)
   ```sql
   CREATE TABLE outbox_events (
     id              BIGINT AUTO_INCREMENT PRIMARY KEY,
     -- ...
     sequence_number BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
     -- ...
   );
   ```
   MySQL does NOT allow two AUTO_INCREMENT columns in the same table. This DDL will fail with: `ERROR 1075 (42000): Incorrect table definition; there can be only one auto column and it must be defined as a key`. A reader who copies this SQL will get an immediate error.
   **Fix**: Remove AUTO_INCREMENT from `sequence_number`. Use a database sequence (PostgreSQL) or a trigger-based incrementing value if a separate sequence number is needed alongside the primary key.

2. **Code Correctness — State machine inconsistency** (Line ~400-450)
   The ASCII state diagram shows a `modify` self-loop on the CONFIRMED state (CONFIRMED -> CONFIRMED via modify). However, the `VALID_TRANSITIONS` map defines:
   ```typescript
   [BookingStatus.CONFIRMED]: [BookingStatus.CHECKED_IN, BookingStatus.CANCELLED],
   ```
   There is no `CONFIRMED -> CONFIRMED` transition in the code. The diagram and code disagree.
   **Fix**: Either add `BookingStatus.CONFIRMED` to the allowed transitions from CONFIRMED (to support modification), or remove the `modify` arrow from the state diagram.

3. **Code Correctness — `this` binding bug in validation rules** (Line ~900-920)
   ```typescript
   class BookingValidationService {
     private readonly rules = [
       this.checkDatesAreInFuture,      // ← method reference, 'this' context lost
       this.checkCheckoutAfterCheckin,
       this.checkMaxStayDuration,
       // ...
     ];

     async validate(dto: CreateBookingDto): Promise<ValidationResult> {
       for (const rule of this.rules) {
         const result = await rule(dto);  // ← called without 'this' context
       }
     }
   }
   ```
   When methods are stored in an array and called via `rule(dto)`, they lose their `this` context. If any rule method accesses `this.someProperty`, it will throw `TypeError: Cannot read properties of undefined`.
   **Fix**: Use arrow functions in the array: `this.checkDatesAreInFuture.bind(this)` or `(dto) => this.checkDatesAreInFuture(dto)`.

4. **Missing Content — No chapter summary table**

---

### Chapter 13: Financial Ledger — Quality Score: B+

**File**: `e:/Global Booking System/enhanced_ch13.md` (~1485 lines)

**Strengths**:
- Excellent double-entry accounting explanation accessible to developers without accounting background
- Chart of accounts with 1000-5999 code convention is practical
- Immutability trigger preventing journal entry mutation after posting is production-critical
- Revenue recognition section bridges accounting and engineering well
- Refund flow (full and partial) with reversal entries is thorough

**Issues**:

1. **Code Correctness — Date.now() defeats idempotency (CRITICAL)** (Line ~1200-1210)
   ```typescript
   const idempotencyKey = `refund_partial_${params.bookingId}_${Date.now()}`;
   ```
   Using `Date.now()` in the idempotency key means every invocation produces a different key, even for retries of the same refund request. If a partial refund fails mid-execution and is retried, the new `Date.now()` value creates a new idempotency key, allowing a duplicate refund to be processed.
   **Fix**: Derive the idempotency key from stable inputs only:
   ```typescript
   const idempotencyKey = `refund_partial_${params.bookingId}_${params.amount}_${params.reason}`;
   ```
   Or accept an idempotency key from the caller.

2. **Code Correctness — Inconsistent database access patterns** (Line ~800-850)
   The `LedgerService` class uses Prisma Client for most operations but switches to raw `db.execute` for `generateEntryNumber`. Mixing database access patterns within a single service class makes it harder to maintain and test.
   **Fix**: Use Prisma's `$queryRaw` consistently, or extract the raw SQL operations into a separate repository class.

3. **Missing Content — No chapter summary table**

---

### Chapter 14: Notification Service — Quality Score: C+

**File**: `e:/Global Booking System/enhanced_ch14.md` (~1722 lines)

This is the weakest chapter in the reviewed range. It has multiple code issues and appears to be cut off.

**Strengths**:
- Event-driven architecture with Kafka consumers is well-motivated
- Multi-channel provider pattern (SendGrid, Twilio, Firebase, WebSocket) is practical
- Handlebars template system with i18n is a nice touch

**Issues**:

1. **Code Correctness — Invalid Prisma syntax** (Line ~950)
   ```typescript
   const notifications = await this.prisma.notification.findMany({
     where: {
       status: 'FAILED',
       retryCount: { lt: prisma.raw('max_attempts') },
     },
   });
   ```
   `prisma.raw('max_attempts')` is not valid Prisma Client syntax. `prisma.raw` does not exist as a method. To compare a column against another column in the same row, you need `$queryRaw` or a Prisma `FieldRef` (Prisma 5.16+).
   **Fix**: Use `$queryRaw` for this query:
   ```typescript
   const notifications = await this.prisma.$queryRaw`
     SELECT * FROM notifications
     WHERE status = 'FAILED' AND retry_count < max_attempts
   `;
   ```

2. **Code Correctness — No-op string replacement** (Line ~1100)
   ```typescript
   renderSubject(eventType: string): string {
     return eventType.replace('.', '.');
   }
   ```
   This replaces a dot with a dot, producing no change. It appears to be a placeholder that was never completed.
   **Fix**: Implement the intended transformation (e.g., `eventType.replace('.', ' - ')` or `eventType.split('.').map(capitalize).join(' ')`).

3. **Consistency — PostgreSQL syntax in a MySQL-context book**
   Uses `UUID` (PostgreSQL default type), `TIMESTAMPTZ`, `gen_random_uuid()`, and `JSONB` throughout. The Prisma schema uses `@db.Timestamptz()` and `@db.JsonB` (PostgreSQL-specific). This is inconsistent with Chapters 8-13.

4. **Missing Content — Chapter appears cut off**
   The chapter ends abruptly without a conclusion, summary table, or bridge to the next chapter. Other chapters end with a summary table and a "What Comes Next" preview.

5. **Missing Content — No chapter summary table**

---

### Chapter 15: Distributed Locking — Quality Score: A-

**File**: `e:/Global Booking System/enhanced_ch15.md` (~1853 lines)

**Strengths**:
- Masterful progression from SETNX through TTL, ownership tokens, Redlock, watchdog renewal, and fencing tokens
- Each concept builds on the failure of the previous one, creating a compelling narrative
- The `withLock` higher-order function pattern is production-ready
- Lock audit trail section is often overlooked in other resources
- Fallback strategies (graceful degradation, queue-based) when Redis is down
- Has chapter summary table

**Issues**:

1. **Consistency — PostgreSQL syntax**
   Lock audit trail table uses `UUID DEFAULT gen_random_uuid()`, `TIMESTAMPTZ`, and `pg_advisory_xact_lock`. These are PostgreSQL-specific, inconsistent with the MySQL syntax used in Chapters 8-13.

2. **Consistency — Redlock duplication with Chapter 11**
   See cross-chapter Issue 2 above.

3. **Educational Quality — Minor**
   The Redlock section could benefit from a brief discussion of Martin Kleppmann's critique of the algorithm ("How to do distributed locking", 2016) and Salvatore Sanfilippo's response. This is well-known context that the target audience may encounter and should understand.

---

### Chapter 16: Idempotency — Quality Score: A-

**File**: `e:/Global Booking System/enhanced_ch16.md` (~1880 lines)

**Strengths**:
- Opening with the mathematical definition f(f(x)) = f(x) sets the right tone
- Stripe's idempotency approach as a case study is excellent and relevant
- NestJS interceptor pattern makes the concept immediately applicable
- Kafka consumer idempotency (both tracked and naturally idempotent operations) is thorough
- War story ($2.3M double-charge) is compelling
- Common mistakes table with 10 specific antipatterns is very useful
- Has chapter summary table

**Issues**:

1. **Code Correctness — UUID v4 validation conflicts with deterministic keys** (Line ~600-650)
   The `IdempotencyInterceptor` validates all idempotency keys against UUID v4 format:
   ```typescript
   private validateIdempotencyKey(key: string): boolean {
     const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
     return uuidV4Regex.test(key);
   }
   ```
   But earlier in the chapter, `generateDeterministicKey` produces SHA-256 hex strings:
   ```typescript
   function generateDeterministicKey(userId: string, action: string, ...params: string[]): string {
     return crypto.createHash('sha256').update(`${userId}:${action}:${params.join(':')}`).digest('hex');
   }
   ```
   A SHA-256 hex string (64 hex characters, no hyphens) will fail UUID v4 validation. The two approaches are incompatible as written.
   **Fix**: Either (a) relax the validation to accept both formats, (b) format the deterministic key as a UUID v5 (which uses SHA-1 and produces a valid UUID), or (c) clarify that UUID v4 keys are for client-generated keys while deterministic keys bypass the interceptor.

2. **Code Correctness — Async function in RxJS catchError** (Line ~700-720)
   ```typescript
   catchError(async (error) => {
     await this.markFailed(idempotencyKey);
     return throwError(() => error);
   })
   ```
   Using an `async` function inside RxJS `catchError` returns a `Promise<Observable>` rather than an `Observable`. RxJS does not unwrap Promises from `catchError` handlers. This can cause the error to be swallowed or produce unexpected behavior.
   **Fix**: Use `from()` to convert the async operation:
   ```typescript
   catchError((error) => {
     return from(this.markFailed(idempotencyKey)).pipe(
       switchMap(() => throwError(() => error))
     );
   })
   ```

---

### Chapter 17: Multi-Region Conflict Resolution — Quality Score: A

**File**: `e:/Global Booking System/enhanced_ch17.md` (~2394 lines)

**Strengths**:
- The most comprehensive chapter in the reviewed range
- CAP theorem explanation with the married couple analogy is one of the best I have seen
- Conflict detection progression (LWW, version vectors, vector clocks) builds understanding systematically
- CRDTs (G-Counter, PN-Counter) with inventory tracking application is practical
- MySQL multi-region replication config is production-grade with thorough annotations
- Data sovereignty implementation (GDPR, APPI, LGPD routing) is rarely covered and critical
- Three war stories are all excellent and teach different lessons
- Docker Compose local testing setup is a valuable tool
- Has chapter summary table

**Issues**:

1. **Code Correctness — Docker Compose missing ZooKeeper services** (Line ~2128-2250)
   The Kafka containers reference ZooKeeper instances (`KAFKA_ZOOKEEPER_CONNECT: zk-us-east-1:2181`) but no ZooKeeper services are defined in the Docker Compose file. The compose file will start Kafka containers that fail to connect.
   **Fix**: Add ZooKeeper service definitions for each region, or switch to KRaft mode (Kafka 3.3+) which eliminates the ZooKeeper dependency.

2. **Code Correctness — Network shaper only affects its own interface** (Line ~2267-2284)
   The `network-shaper` container runs `tc qdisc add dev eth0 root netem delay 80ms` on its own network interface. This only adds latency to traffic entering and leaving the network-shaper container itself. It does NOT add latency between the MySQL, Kafka, or application containers.
   **Fix**: To simulate cross-region latency, run `tc` commands on each container's WAN-facing interface. This requires either (a) custom entrypoint scripts with `NET_ADMIN` capability on each service container, or (b) a tool like `pumba` or `toxiproxy` designed for network fault injection in Docker environments.

3. **Code Correctness — Deprecated Docker Compose version field** (Line ~2072)
   ```yaml
   version: "3.8"
   ```
   Docker Compose v2 (the current standard) does not require a `version` field. Including it generates a deprecation warning. Minor but easily fixed.

4. **Educational Quality — Minor**
   The CAP theorem ASCII art triangle (Lines ~186-210) places "CA Systems (single data center)" in a position that might suggest CA is a viable distributed architecture option. The text correctly explains why CA is impossible in distributed systems, but the diagram could reinforce the impossibility more clearly.

---

### Chapter 18: Outbox Pattern — Quality Score: B+

**File**: `e:/Global Booking System/enhanced_ch18.md` (~1726 lines)

**Strengths**:
- Opening scenario (dual-write problem with four possible outcomes) is one of the best explanations of this concept available
- "Why just retry does not fix it" section proactively addresses the reader's first instinct
- FOR UPDATE SKIP LOCKED explanation with parallel publisher diagram is crystal clear
- Polling vs CDC (Debezium) decision table is balanced and practical
- Ordering guarantees section (sequential IDs, partition keys, per-aggregate publishing) is thorough
- Three cleanup strategies with "start simple, scale up" advice
- Black Friday war story is compelling
- Exactly-once delivery section with both tracked and naturally idempotent strategies
- Has chapter summary table

**Issues**:

1. **Consistency — PostgreSQL syntax in a MySQL-context book (SIGNIFICANT)**
   The outbox table DDL uses PostgreSQL-specific syntax throughout:
   - `BIGSERIAL` (PostgreSQL) instead of `BIGINT AUTO_INCREMENT` (MySQL)
   - `TIMESTAMPTZ` (PostgreSQL) instead of `TIMESTAMP` (MySQL)
   - `JSONB` (PostgreSQL) instead of `JSON` (MySQL)
   - WAL and `pgoutput` in the Debezium section (PostgreSQL-specific)
   - `(POWER(2, retry_count) || ' seconds')::interval` uses PostgreSQL `::` cast syntax

   The Prisma schema uses `@db.Timestamptz()` and `@db.JsonB` which are PostgreSQL-specific.

   A reader following from Chapters 8-13 (all MySQL) will be confused by the switch.

2. **Code Correctness — Mixed PostgreSQL and MySQL SQL syntax** (Line ~941-947)
   ```sql
   DELETE FROM outbox_events
   WHERE status = 'PUBLISHED'
     AND published_at < NOW() - INTERVAL '7 days'
   LIMIT 10000;
   ```
   `DELETE ... LIMIT` is MySQL syntax. PostgreSQL does not support `LIMIT` on DELETE statements. But the table itself uses PostgreSQL types (BIGSERIAL, TIMESTAMPTZ). The SQL is invalid in BOTH databases as written.
   **Fix**: For PostgreSQL:
   ```sql
   DELETE FROM outbox_events
   WHERE id IN (
     SELECT id FROM outbox_events
     WHERE status = 'PUBLISHED'
       AND published_at < NOW() - INTERVAL '7 days'
     LIMIT 10000
   );
   ```

3. **Code Correctness — PostgreSQL-specific interval syntax** (Line ~510)
   ```sql
   next_retry_at = NOW() + (POWER(2, retry_count) || ' seconds')::interval
   ```
   The `::interval` cast and string concatenation with `||` are PostgreSQL-specific. MySQL equivalent would use `INTERVAL` with `POWER()`:
   ```sql
   next_retry_at = NOW() + INTERVAL POWER(2, retry_count) SECOND
   ```

---

## Summary Scorecard

| Chapter | Title | Score | Critical Issues | Key Strength |
|---------|-------|-------|-----------------|--------------|
| Ch 8 | API Gateway | B+ | Kong syntax error | Rate limiting algorithm comparison |
| Ch 9 | Authentication | B | Dead code, missing DI | JWT + key rotation coverage |
| Ch 10 | Search / Elasticsearch | A | None | Most complete and cleanest chapter |
| Ch 11 | Inventory Management | B | Redundant CHECK constraint | Hold pattern with state machine |
| Ch 12 | Booking Orchestration | B- | Dual AUTO_INCREMENT, state mismatch, this binding | Orchestrator pattern narrative |
| Ch 13 | Financial Ledger | B+ | Date.now() idempotency bug | Double-entry accounting for engineers |
| Ch 14 | Notification Service | C+ | Invalid Prisma, no-op replace, cut off | Multi-channel provider pattern |
| Ch 15 | Distributed Locking | A- | Redlock duplication with Ch 11 | Progressive failure-driven design |
| Ch 16 | Idempotency | A- | UUID validation vs deterministic keys | Math foundation + Stripe case study |
| Ch 17 | Multi-Region | A | Docker Compose network issues | Most comprehensive chapter overall |
| Ch 18 | Outbox Pattern | B+ | DB syntax inconsistency | Dual-write problem explanation |

---

## Priority Recommendations

### Priority 1 (Must Fix Before Publication)

1. **Standardize database engine** across all chapters. The MySQL/PostgreSQL inconsistency is the single largest issue in the reviewed range.
2. **Fix the dual AUTO_INCREMENT bug** in Chapter 12. This is invalid SQL that will error immediately.
3. **Fix the Date.now() idempotency bug** in Chapter 13. This silently allows duplicate refunds.
4. **Fix the dead code / plaintext secret storage** in Chapter 9. A reader copying this code stores plaintext secrets in the database.

### Priority 2 (Should Fix)

5. **Rewrite Chapter 14** to fix invalid Prisma syntax, the no-op replace, and add a proper conclusion with summary table.
6. **Fix the UUID v4 / deterministic key conflict** in Chapter 16.
7. **Fix the `this` binding bug** in Chapter 12's validation rules array.
8. **Deduplicate the Redlock implementation** between Chapters 11 and 15.

### Priority 3 (Nice to Have)

9. **Add chapter summary tables** to Chapters 8, 9, 11, 12, and 13.
10. **Fix Docker Compose** in Chapter 17: add ZooKeeper services, fix network shaper.
11. **Add Kleppmann/Antirez Redlock debate reference** in Chapter 15.
12. **Fix the async/catchError RxJS issue** in Chapter 16.

---

*End of Review Report*
