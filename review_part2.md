# Technical Review: Chapters 19-29

**Reviewer:** Technical Review Agent
**Date:** 2026-02-15
**Scope:** Chapters 19 through 29 of the Global Booking System e-book
**Review Dimensions:** Code correctness, educational quality, consistency, missing content, misleading information

---

## Cross-Chapter Issues

Before scoring individual chapters, three systemic issues affect multiple chapters and should be addressed at the book level.

### Issue 1: Database Engine Inconsistency

The book alternates between MySQL and PostgreSQL syntax without acknowledging the switch or explaining why. This will confuse readers who follow the book sequentially.

| Chapter | Database Used | Evidence |
|---------|--------------|---------|
| Ch19 (Saga) | MySQL | `ENGINE=InnoDB`, `AUTO_INCREMENT`, `BIGINT UNSIGNED` |
| Ch20 (CQRS) | MySQL | `ENGINE=InnoDB`, `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP` |
| Ch21 (Circuit Breaker) | PostgreSQL | `TIMESTAMPTZ`, `JSONB`, `TEXT PRIMARY KEY` |
| Ch22 (Rate Limiting) | MySQL | `ENGINE=InnoDB` |
| Ch23 (Retry) | MySQL | `BIGINT UNSIGNED`, MySQL-style queries |
| Ch24 (Cache) | MySQL | `AUTO_INCREMENT`, `ENGINE=InnoDB` |
| Ch25 (DLQ) | PostgreSQL | `gen_random_uuid()`, `TIMESTAMPTZ`, `JSONB`, PostgreSQL enums |
| Ch26 (Read/Write Splitting) | MySQL | Consistent throughout (appropriate for the replication topic) |
| Ch27 (Security) | PostgreSQL | `CREATE USER ... WITH PASSWORD`, `GRANT USAGE ON SEQUENCE` |
| Ch28 (Fraud Detection) | PostgreSQL (implied) | `@default(uuid())`, no MySQL raw SQL |
| Ch29 (GDPR) | PostgreSQL | `gen_random_uuid()::text`, `TIMESTAMPTZ`, `ctid` |

**Recommendation:** Pick one database engine (PostgreSQL is the more common choice for new NestJS projects) and use it consistently. If MySQL is needed for Ch26 (Read/Write Splitting), add an explicit note explaining the switch. Alternatively, add a preface section stating which database each chapter targets.

### Issue 2: Incorrect "Next Chapter" Previews

Four chapters end with cross-references that do not match the actual next chapter. These are factual errors that will confuse readers navigating the book.

| Chapter | States Next Chapter Is About | Actual Next Chapter Content |
|---------|-----------------------------|-----------------------------|
| Ch21 (line 1880) | "Chapter 22: **Service Mesh** (Istio/Linkerd)" | Ch22 is about **Rate Limiting** |
| Ch24 (line 2366) | "Chapter 25: **Rate Limiting and Throttling**" | Ch25 is about **Dead Letter Queues** |
| Ch27 (line 1660) | "Chapter 28: compliance frameworks -- GDPR, PCI DSS, and SOC 2" | Ch28 is about **Fraud Detection** |
| Ch28 (line 2199) | "Chapter 29: Logging and Observability" | Ch29 is about **GDPR & Data Privacy** |

**Recommendation:** Fix all four cross-references to match actual chapter content. This appears to indicate the chapter order was rearranged at some point without updating the transition text.

### Issue 3: Deprecated Package Usage

Two chapters recommend deprecated packages without noting their status:

1. **Ch27** (line 935-952): Uses `csurf` for CSRF protection. The `csurf` package was deprecated in September 2022 due to architectural concerns with how it handled token validation. The maintainers recommend alternatives such as `csrf-csrf` or `lusca`, or using framework-native CSRF protection.

2. **Ch23** (line 1182-1204): Uses the RxJS `retryWhen` operator. This operator was deprecated in RxJS v7.x in favor of the `retry` operator with a `delay` configuration function. Since NestJS 9+ ships with RxJS 7, readers following along will see deprecation warnings.

**Recommendation:** Replace `csurf` with a maintained alternative and update the RxJS interceptor to use the modern `retry({ count, delay })` API.

---

## Chapter-by-Chapter Review

---

### Chapter 19: Saga Pattern -- Distributed Transactions Without a Safety Net

**Quality Score: A-**

**Code Correctness:**

- SQL and Prisma code is syntactically correct.
- Saga orchestrator logic properly handles forward execution and compensation.
- One naming collision: the Prisma model `SagaStep` (the database table) shares its name with the TypeScript interface `SagaStep` used in the orchestrator. When both are imported in the same file, this creates ambiguity. Renaming the interface to `SagaStepDefinition` or the model to `SagaStepRecord` would resolve it.

**Educational Quality:**

- Excellent opening that builds from single-database transactions to distributed transactions.
- The 2PC explanation before introducing sagas gives proper context.
- The wedding planning analogy for compensating transactions is effective.
- Step-by-step saga execution with timeline diagrams makes the flow concrete.

**Consistency:**

- Uses all required mentorship boxes: Key Term, Analogy, Checkpoint, What If You Skip This.
- Chapter summary table present.
- War story included.

**Missing Content:**

- No discussion of saga timeout handling. What happens if a step neither succeeds nor fails within a reasonable time?
- Does not mention the Saga Execution Coordinator (SEC) pattern common in enterprise implementations.

**Misleading Information:**

- None identified.

---

### Chapter 20: CQRS -- Separating Reads from Writes

**Quality Score: B+**

**Code Correctness:**

- Critical DDD misuse at lines 1047-1063: `BookingCreatedEvent` extends `AggregateRoot` from `@nestjs/cqrs`. In Domain-Driven Design, **events do not extend AggregateRoot** -- aggregates do. An event is a value object that records something that happened. An `AggregateRoot` is an entity with identity and domain methods. This code works because `AggregateRoot` provides the `apply()` and `commit()` methods, but the pattern is architecturally incorrect and will mislead readers about DDD concepts.
  - The correct approach: Create a `BookingAggregate extends AggregateRoot` class, have the aggregate apply events, and use `EventPublisher.mergeObjectContext()` on the aggregate, not the event.
  - Notably, `BookingCancelledEvent` (line 1070-1077) does NOT extend `AggregateRoot`, creating an inconsistency within the same chapter.

- Line 1026-1027: `this.publisher.mergeObjectContext(event); event.commit();` -- calling `mergeObjectContext` on an event object rather than an aggregate is an unusual pattern that works but misrepresents the NestJS CQRS architecture.

**Educational Quality:**

- The sprinter vs. marathon runner analogy for read/write workload differences is excellent.
- The dual-store diagram (MySQL write + Elasticsearch read) is clear and well-explained.
- The projector pattern is thoroughly documented with both Elasticsearch and MySQL read model examples.
- The "When to Use CQRS" decision framework is practical and honest about tradeoffs.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present.

**Missing Content:**

- No discussion of handling projector failures or rebuilding read models from scratch (event replay).
- Does not address schema evolution in the Elasticsearch index.

**Misleading Information:**

- The `BookingCreatedEvent extends AggregateRoot` pattern teaches incorrect DDD modeling. A junior developer reading this will conflate events with aggregates.

---

### Chapter 21: Circuit Breaker & Bulkhead -- Containing the Blast

**Quality Score: A-**

**Code Correctness:**

- Circuit breaker state machine implementation is correct.
- Bulkhead semaphore implementation is correct.
- Uses PostgreSQL syntax (`TIMESTAMPTZ`, `JSONB`, `TEXT PRIMARY KEY`) for Prisma schema and raw SQL, inconsistent with the MySQL used in adjacent chapters (Ch20, Ch22).

**Educational Quality:**

- The cascading failure timeline (T+0s through T+120s) is one of the best explanations in the book. It makes the problem viscerally concrete.
- The electrical circuit breaker analogy is apt and well-developed.
- The "Resilient Call Stack" section showing how Circuit Breaker, Bulkhead, Retry, and Timeout layer together is excellent architecture guidance.
- Chaos testing with `nock` gives readers a practical testing approach.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present at lines 1865-1878.
- War story present.

**Missing Content:**

- No discussion of half-open state strategies when the downstream service requires warmup (e.g., cold JVM, cache warming).

**Misleading Information:**

- Line 1880: "Next chapter" preview incorrectly states Ch22 covers "Service Mesh (Istio/Linkerd)" when Ch22 is actually Rate Limiting.

---

### Chapter 22: Rate Limiting -- Protecting Your Castle Gates

**Quality Score: A**

**Code Correctness:**

- All five rate limiting algorithms (Fixed Window, Sliding Window Log, Token Bucket, Sliding Window Counter, Leaky Bucket) are implemented correctly.
- Redis Lua scripts are syntactically correct and atomic.
- NestJS guard and decorator integration is clean.
- Uses MySQL consistently (matching adjacent chapters).

**Educational Quality:**

- The "castle gates" metaphor works well and is sustained throughout.
- Each algorithm gets a visual diagram, code implementation, and tradeoff analysis.
- The comparison table of all five algorithms is a strong reference artifact.
- Practical: shows how to set different limits for different user tiers.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present.

**Missing Content:**

- No discussion of distributed rate limiting across multiple application instances (Redis handles this implicitly in the Lua scripts, but the distributed aspect is not called out explicitly).

**Misleading Information:**

- None identified.

---

### Chapter 23: Retry & Backoff -- When to Try Again

**Quality Score: B+**

**Code Correctness:**

- Lines 1182-1204: The NestJS interceptor uses the deprecated RxJS `retryWhen` operator. In RxJS 7.x (shipped with NestJS 9+), `retryWhen` is deprecated in favor of `retry({ count, delay })`. Readers following along will see deprecation warnings in their IDE and at build time.
  - Modern replacement:
    ```typescript
    return next.handle().pipe(
      retry({
        count: this.config.maxAttempts,
        delay: (error, retryCount) => {
          // classification + delay logic here
          return timer(delayMs);
        },
      }),
    );
    ```

- The exponential backoff formula and all three jitter strategies (full, equal, decorrelated) are mathematically correct.
- The retry budget implementation follows the Google SRE 10% model correctly.
- Idempotency key implementation is correct and well-explained.

**Educational Quality:**

- The restaurant phone call opening analogy is memorable and sets up the chapter perfectly.
- The transient vs. permanent failure classification table is a high-value reference.
- The backoff formula derivation with concrete number examples is excellent pedagogy.
- The circuit breaker + retry integration section shows mature architectural thinking.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present (Black Friday incident).

**Missing Content:**

- Does not discuss retry storms in the context of service-to-service calls where both caller and callee retry.
- No mention of hedged requests (sending a second request before the first times out) as an alternative to retries for latency-sensitive paths.

**Misleading Information:**

- The deprecated `retryWhen` usage will cause confusion when readers' IDEs flag it.

---

### Chapter 24: Cache Strategy & Invalidation -- The Hardest Problem

**Quality Score: A**

**Code Correctness:**

- Cache-aside, write-through, and write-behind implementations are all correct.
- Stampede prevention with distributed locking uses `SET NX EX` correctly for atomic lock acquisition.
- Probabilistic Early Refresh (PER) formula implementation is correct.
- Consistent hashing with virtual nodes is implemented correctly, including binary search for node lookup.
- Multi-layer cache with L1 (LRU) + L2 (Redis) properly handles promotion and cross-instance invalidation via Pub/Sub.
- Cache warming service properly uses `OnApplicationBootstrap` for pre-traffic warming.
- Uses MySQL syntax for Prisma schema, consistent with Ch22 and Ch20.

**Educational Quality:**

- The librarian/whiteboard analogy is one of the strongest in the book.
- The student exam analogy for multi-layer caching (memory -> notes -> textbook) is effective.
- The latency comparison table (with vs. without caching) makes the case for caching with hard numbers.
- The three invalidation strategy comparison table is a high-value reference.
- The stale price incident war story is highly relevant and instructive.
- Best in class: the "Common Mistakes" section covers six real-world pitfalls with before/after code.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present and comprehensive.
- War story present with detailed timeline.

**Missing Content:**

- No discussion of cache serialization overhead (JSON.stringify/parse cost at high throughput).
- Does not mention Redis Cluster vs. Redis Sentinel for production Redis deployments.

**Misleading Information:**

- Line 2366: "Next chapter" preview incorrectly states Ch25 covers "Rate Limiting and Throttling" when Ch25 is about Dead Letter Queues.

---

### Chapter 25: Dead Letter Queue -- Where Failed Messages Go

**Quality Score: A-**

**Code Correctness:**

- Graduated retry chain (retry-1, retry-2, retry-3, DLQ) implementation is correct.
- Poison pill detection logic properly identifies non-transient failures.
- DLQ admin replay tooling with selective replay is well-implemented.
- Uses PostgreSQL syntax (`gen_random_uuid()`, `TIMESTAMPTZ`, `JSONB`), inconsistent with MySQL chapters.

**Educational Quality:**

- The post office Dead Letter Office analogy is historically accurate and immediately clarifying.
- The conveyor belt opening metaphor effectively sets up the problem.
- The distinction between lost messages vs. blocking messages clearly frames why DLQs are needed.
- Topic naming conventions section is practical operational guidance rarely seen in educational material.
- Monitoring and alerting configuration is production-grade.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present ("Ghost Bookings" -- 4,200 unreplayed messages causing $2.3M loss).

**Missing Content:**

- No discussion of DLQ message ordering guarantees (or lack thereof) when messages are replayed.
- Does not address DLQ retention policies (how long do messages stay in the DLQ before being permanently discarded?).

**Misleading Information:**

- None identified.

---

### Chapter 26: Read/Write Splitting -- Two Doors, One Room

**Quality Score: A**

**Code Correctness:**

- MySQL replication internals (binary log, I/O thread, SQL thread, relay log) are described accurately.
- Semi-synchronous replication implementation with `rpl_semi_sync_master_wait_point = AFTER_SYNC` is correct for MySQL 5.7+.
- ProxySQL configuration for query routing is correct.
- Read-after-write consistency solution (session binding + replication lag check) is well-implemented.
- Failover orchestration with fencing (STONITH) is production-accurate.
- Uses MySQL consistently throughout, which is appropriate for this topic.

**Educational Quality:**

- The library desk analogy (one desk for returns, four for research) is immediately comprehensible.
- The replication internals section with binary log format comparison (STATEMENT vs. ROW vs. MIXED) is unusually thorough for a chapter in an application-level book.
- The "Phantom Double-Booking" war story from replication lag is a genuine production scenario.
- The failover orchestration section is some of the most practical DBA-level content in the book.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present.

**Missing Content:**

- No discussion of read replica auto-scaling (common in cloud-managed databases like AWS Aurora or GCP Cloud SQL).
- Does not mention GTID-based replication, which is the modern MySQL replication standard.

**Misleading Information:**

- None identified.

---

### Chapter 27: Security Architecture -- Thinking Like an Attacker

**Quality Score: B+**

**Code Correctness:**

- Lines 935-952: Uses the deprecated `csurf` package for CSRF protection. `csurf` was deprecated in September 2022. The npm page explicitly warns against its use. Readers installing it will see deprecation warnings, and the package may not receive security patches.
  - Recommended replacement: `csrf-csrf` package, or use the `SameSite=Strict` cookie attribute with JWT in Authorization headers (which the chapter itself mentions as an alternative at the bottom of the CSRF section).

- SQL injection, XSS, and CSRF attack/defense examples are all technically correct.
- Helmet.js configuration is accurate and comprehensive.
- NestJS `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true` is the recommended configuration.
- Secret management section (HashiCorp Vault, AWS Secrets Manager) is accurate.
- Security event logging with auto-blocking is well-implemented.
- Uses PostgreSQL syntax for raw SQL (`CREATE USER ... WITH PASSWORD`, `GRANT USAGE ON SEQUENCE`), inconsistent with MySQL-based chapters.

**Educational Quality:**

- The medieval castle analogy for defense in depth is vivid and accurate.
- The hotel key card analogy for least privilege is immediately relatable.
- Walking through the complete OWASP Top 10 with booking-system-specific attack scenarios is excellent.
- The side-by-side unsafe/safe code comparisons are highly effective for learning.
- The IDOR war story (847,293 bookings exposed) is impactful and drives home authorization checks.
- The NestJS middleware stack ordering explanation (Helmet -> CORS -> compression -> body limits -> validation -> filters -> guards) is valuable operational knowledge.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present.

**Missing Content:**

- No discussion of Content Security Policy (CSP) reporting (the `report-uri` or `report-to` directives).
- No mention of Subresource Integrity (SRI) for CDN-hosted scripts.
- Missing coverage of API key rotation strategies.

**Misleading Information:**

- Line 1660: "Next chapter" preview says Ch28 covers "compliance frameworks -- GDPR, PCI DSS, and SOC 2" when Ch28 is actually about Fraud Detection.
- Recommending `csurf` without noting its deprecation status could lead readers to build on an unmaintained dependency.

---

### Chapter 28: Fraud Detection -- Catching the Bad Guys

**Quality Score: A**

**Code Correctness:**

- Configurable rules engine with `FraudRule` interface is well-designed. The parallel execution with `Promise.allSettled` and individual error isolation is correct and production-appropriate.
- All three concrete rules (velocity check, geo-anomaly, amount threshold) are syntactically correct and logically sound.
- Device fingerprinting service with spoofing detection (mobile UA + desktop resolution, Mac UA + Win platform) and headless browser detection (HeadlessChrome, Google SwiftShader WebGL renderer, zero fonts) uses real-world signals.
- 3D Secure integration correctly maps fraud verdict status to Stripe's `request_three_d_secure` parameter values (`automatic` vs. `any`).
- Chargeback handling workflow correctly processes Stripe `charge.dispute.created` webhooks and auto-gathers evidence.
- FraudDetectionService correctly runs device analysis and rules engine in parallel, then combines scores.

- Minor issue: `FraudReviewItem` model has `@@unique([userId, reason])` (line 1747). This prevents creating multiple review items for the same user with the same reason. If a user triggers the same fraud pattern on two different days, the second review item would fail with a unique constraint violation. The `upsert` in `BatchFraudAnalyzer.flagUserForReview` handles this by updating instead of creating, but this design means historical review items are overwritten rather than accumulated.

**Educational Quality:**

- The six fraud patterns section is outstanding. Each pattern gets a clear explanation of how it works, what it looks like in logs, and a TypeScript interface capturing the signals. This is rare practical knowledge.
- The nightclub bouncer vs. bartender analogy (input validation vs. behavior analysis) is memorable.
- The talent show judges analogy for the rules engine is effective.
- The detective tire tracks analogy for device fingerprinting is creative and accurate.
- The promo code fraud ring war story ($114K loss) is a genuine, detailed incident with specific remediation steps.
- The false positive vs. false negative calibration section with target metrics table is actionable.
- The "Common Mistakes" section (especially "never tell the fraudster why they were blocked") is critical operational advice.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present and comprehensive.
- War story present with detailed timeline and dollar amounts.

**Missing Content:**

- No discussion of IP reputation services (MaxMind, IPQualityScore) beyond basic geo-IP lookup.
- Does not mention BIN-level risk scoring (some BIN ranges are associated with higher fraud rates).
- No discussion of fraud model monitoring for concept drift (fraud patterns evolve, model performance degrades over time).

**Misleading Information:**

- Line 2199: "Next chapter" preview says Ch29 is "Logging and Observability" when Ch29 is actually about GDPR and Data Privacy.

---

### Chapter 29: GDPR & Data Privacy -- The Law Meets Code

**Quality Score: B+**

**Code Correctness:**

- Lines 2005-2009: Self-contradicting code and comment in `ColumnEncryptionService`. The comment at line 2007 states "NEVER from an environment variable" but line 2008 reads the key directly from `process.env.COLUMN_ENCRYPTION_KEY!`. This directly contradicts the stated best practice and will confuse readers. Either the comment should say "In this example, we use an environment variable for simplicity; in production, use KMS" or the code should actually use a KMS client.

- Lines 1369-1377: The retention scheduler's `deleteExpiredRecords` method uses `$executeRawUnsafe` with template literals for table and column names (`"${policy.table}"`, `"${policy.dateColumn}"`). While these values come from an internal config object (not user input), this contradicts Ch27's own advice about `$queryRawUnsafe` being dangerous (Ch27 line 786-788). The code should include a validation step (whitelist of allowed table/column names) or an explicit comment acknowledging the risk and why it is acceptable here.

- DSAR export pipeline correctly aggregates data from PostgreSQL, Redis, Elasticsearch, and Kafka.
- Right to erasure with legal hold checks is correctly implemented.
- Anonymization vs. pseudonymization distinction is technically accurate, and the k-anonymity implementation is correct.
- Consent management with append-only audit trail is well-designed.
- AES-256-GCM encryption implementation is cryptographically correct (proper IV generation, auth tag handling, versioned format).
- Prisma middleware for transparent encrypt/decrypt is a clean integration pattern.
- Uses PostgreSQL syntax throughout (`gen_random_uuid()::text`, `TIMESTAMPTZ`, `ctid`), inconsistent with MySQL chapters but consistent within the chapter itself.

**Educational Quality:**

- The seven GDPR principles are clearly explained with practical implications for each.
- The suitcase packing analogy for data minimization is effective.
- The DSAR pipeline implementation across multiple data stores is genuinely useful reference architecture.
- The erasure workflow with legal holds and deletion certificates is thorough.
- The cross-border transfer assessment with adequacy decision country lists is practical.
- The Privacy by Design checklist (10 questions) is a high-value artifact for development teams.
- The war story about incomplete erasure (single-table DELETE vs. distributed data) with a 2.3M euro fine is a powerful motivator.

**Consistency:**

- All required mentorship boxes present.
- Chapter summary table present.
- War story present with regulatory outcome.

**Missing Content:**

- No discussion of GDPR's Article 20 (data portability) -- the DSAR export covers access requests but does not mention the machine-readable portability requirement specifically.
- No mention of Data Protection Impact Assessments (DPIAs), which are mandatory for high-risk processing.
- Does not address cookie consent implementation (mentioned in the opening as "not just a cookie banner" but cookies are never addressed).

**Misleading Information:**

- The `ColumnEncryptionService` comment/code contradiction (says "NEVER from env var" while using env var) will confuse readers about key management best practices.
- Using `$executeRawUnsafe` without input validation goes against the book's own security advice from Ch27.

---

## Summary Scorecard

| Chapter | Title | Score | Critical Issues |
|---------|-------|-------|-----------------|
| Ch19 | Saga Pattern | **A-** | Minor naming collision (SagaStep model vs. interface) |
| Ch20 | CQRS | **B+** | `BookingCreatedEvent extends AggregateRoot` misrepresents DDD |
| Ch21 | Circuit Breaker & Bulkhead | **A-** | Incorrect "next chapter" preview; PostgreSQL inconsistency |
| Ch22 | Rate Limiting | **A** | No critical issues |
| Ch23 | Retry & Backoff | **B+** | Deprecated `retryWhen` operator |
| Ch24 | Cache Strategy & Invalidation | **A** | Incorrect "next chapter" preview (non-code issue) |
| Ch25 | Dead Letter Queue | **A-** | PostgreSQL inconsistency |
| Ch26 | Read/Write Splitting | **A** | No critical issues |
| Ch27 | Security Architecture | **B+** | Deprecated `csurf`; incorrect "next chapter" preview |
| Ch28 | Fraud Detection | **A** | Incorrect "next chapter" preview (non-code issue) |
| Ch29 | GDPR & Data Privacy | **B+** | Self-contradicting encryption key comment; `$executeRawUnsafe` usage |

---

## Top Priority Fixes

1. **Fix all four incorrect "next chapter" cross-references** (Ch21, Ch24, Ch27, Ch28). These are factual errors that break the reading flow.

2. **Fix `BookingCreatedEvent extends AggregateRoot` in Ch20** (lines 1047-1063). This teaches incorrect DDD patterns. Create a `BookingAggregate extends AggregateRoot` and have the command handler apply events through the aggregate.

3. **Replace deprecated `csurf` in Ch27** (lines 935-952). Use `csrf-csrf` or recommend SameSite cookies + JWT in Authorization header as the primary approach.

4. **Replace deprecated `retryWhen` in Ch23** (lines 1182-1204). Use the modern `retry({ count, delay })` API from RxJS 7.

5. **Fix the self-contradicting comment in Ch29's `ColumnEncryptionService`** (lines 2005-2009). Either update the comment to acknowledge the env var usage or update the code to actually use a KMS client.

6. **Standardize on one database engine** across all chapters, or add explicit notes when switching between MySQL and PostgreSQL.

---

## Overall Assessment

Chapters 19-29 represent the strongest section of the book. The architecture patterns (Saga, CQRS, Circuit Breaker, DLQ, Read/Write Splitting) are explained with unusual depth and practical relevance. The security and compliance chapters (27-29) cover topics that most backend books skip entirely, and do so with genuine production insight.

The war stories throughout these chapters are a standout feature. Each one feels authentic, includes specific dollar amounts and timelines, and connects directly to the technical lesson. The promo code fraud ring story (Ch28), the stale price incident (Ch24), and the incomplete erasure story (Ch29) are the kind of knowledge that typically takes years of production experience to acquire.

The primary weaknesses are consistency issues (database engine switching, incorrect cross-references) and two deprecated package recommendations. These are straightforward to fix and do not undermine the fundamental quality of the technical content. The `BookingCreatedEvent extends AggregateRoot` issue in Ch20 is the most architecturally significant problem and should be addressed first, as it teaches an incorrect pattern that readers may propagate into their own codebases.
