# Technical Review: Chapters 40-44 — Global Booking System E-Book

**Reviewer:** Technical Review Agent
**Date:** 2026-02-15
**Scope:** Chapters 40-44 (`enhanced_ch40.md` through `enhanced_ch44.md`)
**Review Criteria:** Code correctness, educational quality, consistency, missing content, misleading information

> **Note on chapter topic mismatch:** The file-to-topic mapping provided with the review request does not match the actual chapter contents. The actual topics are:
> - Ch40: API Documentation (described as "Testing Strategy")
> - Ch41: Development Guidelines & Code Standards (described as "Documentation")
> - Ch42: Testing Strategy (described as "Team Workflows & Code Review")
> - Ch43: Schema Registry & Event Contracts (described as "Cost Optimization")
> - Ch44: Glossary, Resources & Your Next Steps (matches description)
>
> This review uses the **actual** chapter topics.

---

## Chapter 40: API Documentation — Grade: A-

### Code Correctness

**ISSUE 1 (HIGH) -- Monetary values use `format: double`, contradicting best practice taught elsewhere**

The OpenAPI spec (lines 487-498, 556-558, 605-606, 657-658) defines all monetary fields as:

```yaml
totalAmount:
  type: number
  format: double
```

The example values use floating-point numbers like `880.00`, `450.00`, `80.0`. However, Chapter 41 of this very book explicitly warns (line 416):

> "Storing monetary values as DECIMAL or FLOAT. Floating-point arithmetic produces rounding errors: 0.1 + 0.2 = 0.30000000000000004. Always store money as integer cents."

And the Ch41 database schema uses `total_price_cents BIGINT`. The OpenAPI spec should use `type: integer` with a description noting the value is in cents, or at minimum the discrepancy should be acknowledged and explained as a deliberate API-layer transformation. As written, a reader who follows Ch41 for storage and Ch40 for API design will have conflicting mental models with no bridging explanation.

The NestJS DTO (line 1302-1304) compounds this by using:

```typescript
@IsNumber()
@Min(0.01)
totalAmount: number;
```

This validates a floating-point dollar amount, reinforcing the contradiction with the integer-cents approach in Ch41.

**ISSUE 2 (LOW) -- Deprecated `req.connection.remoteAddress`**

Line 1987:
```typescript
const clientIp = req.ip || req.connection.remoteAddress;
```

`req.connection` is deprecated in Node.js since v13.0.0 (replaced by `req.socket`). In a book teaching modern best practices, this should use `req.socket.remoteAddress`. The fallback chain should be `req.ip || req.socket?.remoteAddress`.

**ISSUE 3 (LOW) -- IP-based security check is naive**

Lines 1988-1990: The internal-network check (`clientIp.startsWith('10.')`) does not account for IPv6, proxy headers (`X-Forwarded-For`), or Kubernetes pod networking where all IPs may be in `10.x.x.x` ranges. The text below (line 1998) does warn about leaving Swagger open, which partially mitigates the educational risk, but the code itself could mislead a reader into implementing this pattern verbatim.

### Educational Quality

Excellent. The restaurant-menu analogy (line 13) is immediately intuitive. The "Time to First Successful API Call" metric (line 25) with concrete cost math ($12,000 for one service) makes a compelling business case. The three-audience framework (internal, partner, future-you) at line 39-43 is practical and memorable.

The progression from raw OpenAPI YAML to NestJS decorators to generated SDKs follows a logical build-up. The error standardization section is particularly strong, giving a full error-code table with recommended consumer actions.

The changelog management section (lines ~2300-2400) with the semver-aligned deprecation timeline and "brownout" strategy is a sophisticated and rarely-covered topic that adds real value.

### Consistency

- **Key Term boxes:** Present (OpenAPI Specification, Developer Experience, Idempotency-Key). Sufficient coverage.
- **Analogy boxes:** Present (restaurant menu analogy, library catalog analogy). Well-placed.
- **Checkpoint boxes:** Present (final checkpoint at line 2614 with four self-test questions).
- **What If You Skip This boxes:** Present (lines 37, 211).
- **Chapter summary table:** Present (lines 2593-2613). Complete and well-structured.

### Missing Content

- No discussion of OpenAPI 3.1 (which aligns with JSON Schema draft 2020-12) vs. 3.0.3 used here. A brief note on the evolution would help readers who encounter 3.1 specs in the wild.
- No mention of API mocking tools (Prism, WireMock) for consumer-side development -- these are natural companions to the SDK generation section.

### Misleading Information

- The `format: double` for monetary fields is actively misleading when read alongside Ch41. See Issue 1 above.

---

## Chapter 41: Development Guidelines & Code Standards — Grade: B+

### Code Correctness

**ISSUE 1 (MEDIUM) -- Deprecated ESLint rule**

Line 107:
```javascript
'@typescript-eslint/interface-name-prefix': 'off',
```

The `interface-name-prefix` rule was removed in `@typescript-eslint` v4 (2020). Including it in a modern ESLint configuration will produce an "unknown rule" error or warning depending on the ESLint version. This should be removed, with a comment noting that TypeScript convention no longer uses `I` prefixes (a point already made in prose at line 295).

**ISSUE 2 (MEDIUM) -- TypeORM used here, Prisma used in Ch42**

The entity examples (lines 391-413) use TypeORM decorators (`@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@CreateDateColumn`, `@UpdateDateColumn`), while Chapter 42 (Testing Strategy) uses Prisma throughout. The book has previously established Prisma as the ORM (Ch10, Ch9). Using TypeORM decorators here without explanation creates confusion about which ORM the project actually uses.

If this chapter intends to show conventions that apply regardless of the ORM, a brief note saying "we show TypeORM here to demonstrate the naming-mapping concept; our project uses Prisma, where the mapping is handled in `schema.prisma`" would resolve the disconnect.

**ISSUE 3 (LOW) -- `AppLogger` class missing verbose level**

The `AppLogger` class (lines 840-883) implements `LoggerService` but only defines `log`, `warn`, `error`, and `debug`. NestJS's `LoggerService` interface also expects a `verbose` method. While this will not cause a TypeScript compilation error (due to how NestJS defines LoggerService), it means verbose-level logs from NestJS internals will throw at runtime if NestJS calls `logger.verbose()`. Adding `verbose(message: string, context?: LogContext): void` would complete the implementation.

**ISSUE 4 (LOW) -- Database schema uses PostgreSQL syntax, book uses MySQL**

Lines 362-386 use `GENERATED ALWAYS AS IDENTITY` and `TIMESTAMPTZ` -- these are PostgreSQL data types. The comment at line 362 says "This follows PostgreSQL conventions." However, the book's system uses MySQL (established in Chapter 10). The schema example should either use MySQL syntax (`AUTO_INCREMENT`, `TIMESTAMP`) or explicitly note that PostgreSQL syntax is shown for illustration with MySQL equivalents.

### Educational Quality

Strong overall. The surgery-room analogy (line 9) for coding standards is vivid and effective. The three-layer separation explanation (Controller -> Service -> Repository) is clearly articulated.

The commit message comparison showing BAD vs. GOOD examples (lines 982-1013) is one of the strongest sections -- the "explains WHY not WHAT" principle is demonstrated concretely with the Stripe timeout example.

The DI best practices section (lines 1370-1494) is practical and avoids over-abstraction. Rule 3 (avoid circular dependencies) with the event-based resolution pattern is particularly valuable.

However, the chapter feels like it ends abruptly. After the DI section, the file simply stops at line 1495 with `---`. There is no concluding paragraph and no summary table.

### Consistency

- **Key Term boxes:** Present (Code Convention, Static Analysis, Exception Hierarchy, Conventional Commits, Correlation ID, Dependency Injection Container).
- **Analogy boxes:** Present (building inspector/interior designer for ESLint/Prettier, hospital surgery room, police report, pilot checklist). Strong set.
- **Checkpoint boxes:** Present (lines 134, 537, 1493).
- **What If You Skip This boxes:** Present (lines 20, 211, 535, 811, 1366).
- **Chapter summary table:** **MISSING.** Every other chapter in this batch (40, 42) includes a summary table. Chapter 41 ends without one. This is the most significant consistency gap.

### Missing Content

- **Missing chapter summary table** -- critical consistency gap.
- No section on code documentation standards (JSDoc/TSDoc conventions, when to write inline comments vs. when to let code speak for itself). For a chapter on "Development Guidelines & Code Standards," this is a notable omission.
- No section on environment-specific configuration management (e.g., `.env` files, NestJS ConfigModule, validation of env vars at startup). This is mentioned briefly in passing but not given its own treatment.

### Misleading Information

- The PostgreSQL syntax presented as the database standard (while the project uses MySQL) could mislead readers who copy the SQL directly. See Issue 4.

---

## Chapter 42: Testing Strategy — Grade: B+

### Code Correctness

**ISSUE 1 (CRITICAL) -- Broken Prisma transaction rollback pattern**

Lines 498-504:
```typescript
let rollbackTransaction: any;

beforeEach(async () => {
  rollbackTransaction = await prisma.$transaction(async (tx) => {
    // Return the transactional client for use in the test
    return tx;
  });
});
```

This code is fundamentally broken. `prisma.$transaction(async (tx) => { return tx; })` executes the callback, and the callback immediately returns `tx`. The transaction commits (or completes) as soon as the callback resolves. The returned value (`rollbackTransaction`) is a stale transactional client that is no longer inside an active transaction.

The intended pattern -- wrapping each test in a transaction and rolling it back -- is not achievable this way with Prisma's interactive transactions. Prisma does not support manually rolling back interactive transactions from outside the callback.

The `afterEach` block (lines 507-515) actually uses `deleteMany()` to clean up, which is the correct approach. But lines 498-504 present broken code that a reader will try to use. The commentary at line 508 ("Prisma does not natively support manual rollback") partially acknowledges this, but the code at 500-504 is still presented as if it works, creating confusion.

**Recommended fix:** Remove the `beforeEach` block entirely or replace it with a note explaining that Prisma does not support the "wrap in transaction and rollback" pattern that is common in other ORMs (like TypeORM or Knex). Show only the `deleteMany` cleanup approach.

**ISSUE 2 (MEDIUM) -- Stryker configuration error**

Lines 1817-1819:
```javascript
mutator: {
  // Which mutations to apply
  plugins: ['@stryker-mutator/typescript-checker'],
  excludedMutations: [
    'StringLiteral',
  ],
},
```

The `plugins` key does not belong inside `mutator`. In Stryker's configuration schema, `mutator` accepts `excludedMutations` and `plugins` is not a valid key within it. The TypeScript checker should be configured at the top level:

```javascript
checkers: ['@stryker-mutator/typescript-checker'],
```

Or in older Stryker versions:
```javascript
plugins: ['@stryker-mutator/typescript-checker'],  // at top level, not inside mutator
```

As written, Stryker will either ignore the `plugins` key silently or produce a configuration warning. The TypeScript checker will not be activated, meaning mutation testing runs without type-checking -- which defeats the purpose of using a TypeScript checker.

**ISSUE 3 (LOW) -- `istanbul-merge` glob pattern may not work cross-platform**

The CI pipeline references merging coverage from sharded test runs. On GitHub Actions (Ubuntu), the glob patterns used with `istanbul-merge` may need explicit quoting or `find`-based expansion depending on the version.

### Educational Quality

Very strong. The testing pyramid explanation is thorough, and the chapter builds in logical order from unit tests to mutation testing. The Testcontainers integration testing section is particularly well done -- showing how to spin up real MySQL and Kafka instances for tests fills a genuine gap in most testing guides.

The mutation testing section (lines 1777-1872) is a standout. The analogy at line 1874 ("coverage is checking the guard walks past every door; mutation testing is checking whether the guard would notice if a door were unlocked") is one of the best analogies in the entire batch of chapters.

The anti-patterns section at the end provides actionable warnings about over-mocking, implementation coupling, and slow test suites.

### Consistency

- **Key Term boxes:** Present (Unit Test, Integration Test, Contract Test, Mutation Testing, Test Double).
- **Analogy boxes:** Present (testing pyramid, security guard/mutation testing). Both effective.
- **Checkpoint boxes:** Present (final checkpoint at line 2175 with two self-test questions).
- **What If You Skip This boxes:** Present (line 2154).
- **Chapter summary table:** Present (lines 2158-2173). Comprehensive with 12 rows covering all testing types.

### Missing Content

- No discussion of test parallelism configuration in Jest (e.g., `--maxWorkers`, `--runInBand` for integration tests that share database state).
- The contract testing section uses Pact but does not mention its limitations with event-driven architectures (Pact is HTTP-focused; Pact Messages exists but is not shown). Given that Ch43 covers event schemas extensively, a bridging note here would be valuable.

### Misleading Information

- The Prisma transaction rollback pattern (Issue 1) is actively misleading. A reader will implement this, discover it does not work, and waste significant debugging time.
- The Stryker config (Issue 2) will silently fail to enable the TypeScript checker. A reader following this config verbatim gets mutation testing without type safety, which is worse than getting an error.

---

## Chapter 43: Schema Registry & Event Contracts — Grade: B

### Code Correctness

**ISSUE 1 (CRITICAL) -- `reprocessDeadLetters` creates Kafka client with empty brokers array**

Line 2264:
```typescript
const kafka = new Kafka({ clientId: 'dlq-reprocessor', brokers: [] });
```

This will crash at runtime. KafkaJS requires at least one broker address. An empty `brokers` array causes a connection failure immediately on `consumer.connect()` (line 2267). This is a clear copy-paste oversight -- the brokers should be injected from configuration or passed as a parameter.

**ISSUE 2 (CRITICAL) -- `reprocessDeadLetters` returns before consuming messages**

Lines 2273-2316:
```typescript
await consumer.run({
  eachMessage: async ({ message }) => {
    // ... processing logic ...
  },
});

await consumer.disconnect();
return { processed, failed };
```

`consumer.run()` is non-blocking -- it starts the consumer and resolves the promise immediately. It does not wait for all messages to be consumed. This means line 2315 (`consumer.disconnect()`) executes immediately after `run()` resolves, disconnecting the consumer before it has a chance to process any messages. The function returns `{ processed: 0, failed: 0 }` every time.

The correct pattern for batch reprocessing would be to use the `consumer.run()` with an explicit condition to stop (e.g., a timeout, reaching end-of-partition, or hitting `maxMessages`), and to `disconnect()` only after confirming all messages are processed. Alternatively, use the `eachBatch` handler with manual partition seeking and offset tracking.

**ISSUE 3 (MEDIUM) -- `additionalProperties: false` contradicts forward-compatibility advice**

Line 598:
```json
"additionalProperties": false
```

This is set in the JSON Schema example for `booking.created`. However, the chapter itself teaches that schemas should be forward-compatible -- meaning consumers should ignore unknown fields. Setting `additionalProperties: false` causes validation to reject any message with extra fields, which is the opposite of forward compatibility. When a producer adds a new optional field (as explicitly described in the backward-compatibility section), consumers using this schema with `additionalProperties: false` will reject the message.

This should be either `"additionalProperties": true` or omitted entirely (the default is `true`).

**ISSUE 4 (MEDIUM) -- Potential naming conflict with `@OnEvent` decorator**

The chapter defines a custom `@OnEvent` decorator for Kafka event handling. NestJS has a built-in `@OnEvent` decorator from `@nestjs/event-emitter` (for in-process events). If a service uses both in-process events and Kafka events, importing `@OnEvent` becomes ambiguous. The custom decorator should be named distinctively, e.g., `@OnKafkaEvent` or `@KafkaHandler`, to avoid collision.

**ISSUE 5 (LOW) -- `message.value!` non-null assertion**

Line 2276:
```typescript
const entry: DeadLetterEntry = JSON.parse(
  message.value!.toString()
);
```

The non-null assertion operator (`!`) on `message.value` contradicts Chapter 41's ESLint rule `@typescript-eslint/no-non-null-assertion: 'error'`. Kafka messages can have null values (tombstone records). This should either check for null first or use optional chaining with a guard.

### Educational Quality

The chapter provides an excellent conceptual foundation for schema registries and event evolution. The three-format comparison (Avro vs. JSON Schema vs. Protobuf) with a decision matrix is well structured and gives readers a practical framework for choosing.

The compatibility matrix (backward, forward, full, none) is clearly explained with concrete examples showing when each mode applies.

The Dead Letter Queue section is conceptually strong (the "undeliverable mail" analogy at line 2332 is effective), but the critical code bugs in the reprocessing function undermine its practical value.

The AsyncAPI specification section near the end is a valuable addition -- few introductory texts cover AsyncAPI, and it fills a real gap for event-driven architectures.

### Consistency

- **Key Term boxes:** Present (Schema Registry, Schema Evolution, Dead Letter Queue, AsyncAPI, Event Catalog). Good coverage.
- **Analogy boxes:** Present (library card catalog for schema registry, post office for DLQ). Clear and effective.
- **Checkpoint boxes:** Present (at least one mid-chapter and one at the end).
- **What If You Skip This boxes:** Present.
- **Chapter summary table:** **MISSING.** The chapter ends at line 2839 after the AsyncAPI CLI commands and Key Term box, with no summary table. This is a consistency gap shared with Chapter 41.

### Missing Content

- **Missing chapter summary table** -- critical consistency gap.
- No discussion of schema registry high availability or what happens if the registry is down (can producers still publish? are schemas cached locally?).
- No coverage of how to handle schema evolution across multiple Kafka consumer groups at different versions simultaneously -- a practical challenge in real deployments.

### Misleading Information

- The `brokers: []` in the DLQ reprocessor (Issue 1) will crash. A reader copying this code gets a runtime error on first use.
- The `additionalProperties: false` in the JSON Schema (Issue 3) teaches the exact opposite of the forward-compatibility principle the same chapter advocates. This is the most pedagogically harmful issue -- a reader learns the rule and the example simultaneously contradicts it.

---

## Chapter 44: Glossary, Resources & Your Next Steps — Grade: A-

### Code Correctness

No executable code in this chapter. N/A.

### Educational Quality

Excellent reference material. The glossary entries follow a consistent and useful structure: term, definition, example in context (tied to the Global Booking System), and chapter reference. This three-part structure makes each entry both a reminder and a mini-lesson.

The resource guide is well-curated and opinionated (a strength). Each book/course/project has a "Why It Matters" note and a "When to Read" recommendation, which prevents the common problem of overwhelming readers with undifferentiated reading lists.

The four-stage learning path (Solidify, Deepen, Broaden, Master) with week-by-week activities in Stage 1 is actionable and avoids the vague "keep learning" advice most books end with.

The "Where to Go from Here" section (geo-distribution, ML integration, edge computing, FinTech, platform engineering) provides five concrete next-step areas with specific technologies to explore.

### Consistency

This chapter is a glossary/reference and reasonably omits the standard mentorship boxes (Key Term, Analogy, Checkpoint, What If You Skip This). The format is inherently different from teaching chapters, and forcing those boxes in would feel artificial. The existing structure serves the chapter's reference purpose well.

- **Chapter summary table:** Not present, but not expected for a glossary/reference chapter.

### Missing Content

- No glossary entry for several terms used extensively in the book: **Testcontainers**, **Pact** (contract testing), **Stryker** (mutation testing), **AsyncAPI**, **Debezium** (mentioned only in CDC entry), **BullMQ**.
- The "Open-Source Projects to Study" table does not include Debezium, despite CDC being a significant pattern in the book (Ch18, Ch20).

### Misleading Information

**ISSUE 1 (MEDIUM) -- Cross-reference errors in glossary entries**

Several chapter references do not match actual chapter topics:

- **KRaft entry** (line 327): References "Chapter 42 (Future-Proofing)" but Chapter 42 is actually "Testing Strategy." There is no "Future-Proofing" chapter in the reviewed batch.
- Several entries reference chapter topics that may not match the actual chapter numbers across the full book. While I can only verify Ch40-44, the KRaft reference is demonstrably wrong.

**ISSUE 2 (LOW) -- Typos**

- Line 321: "ata combined throughput" should be "at a combined throughput."
- Line 422: "the service writes the event to an 'outbox' table... Insert the booking row" -- "Insert" should be lowercase "inserts" to maintain grammatical consistency with the rest of the sentence.

---

## Scorecard

| Chapter | Topic | Code Correctness | Educational Quality | Consistency | Missing Content | Misleading Info | Overall Grade |
|---------|-------|-----------------|--------------------:|-------------|----------------|----------------|---------------|
| 40 | API Documentation | B+ (double-float money) | A (strong analogies, business case) | A (all boxes + summary) | B+ (no OAS 3.1, no mocking tools) | B+ (float vs cents conflict) | **A-** |
| 41 | Dev Guidelines & Code Standards | B (deprecated ESLint rule, ORM mismatch) | A- (strong examples, ends abruptly) | B (missing summary table) | B (no JSDoc section, no env config) | B+ (PostgreSQL syntax for MySQL project) | **B+** |
| 42 | Testing Strategy | C+ (broken Prisma rollback, Stryker config) | A (mutation testing analogy, Testcontainers) | A (all boxes + summary) | B+ (no Jest parallelism, no Pact Messages) | C+ (two code blocks teach broken patterns) | **B+** |
| 43 | Schema Registry & Event Contracts | D (two critical runtime bugs, contradictory schema) | A- (strong schema evolution coverage) | B (missing summary table) | B+ (no HA discussion, no multi-version consumers) | C (additionalProperties contradicts own teaching) | **B** |
| 44 | Glossary & Resources | A (no code) | A (actionable learning path, curated resources) | A- (format appropriate for glossary) | B+ (missing glossary entries) | B+ (cross-ref errors, typos) | **A-** |

---

## Top Priority Fixes

These are the issues that should be resolved before publication, listed in order of severity.

### 1. CRITICAL: DLQ Reprocessor with Empty Brokers (Ch43, line 2264)

```typescript
const kafka = new Kafka({ clientId: 'dlq-reprocessor', brokers: [] });
```

**Problem:** Crashes at runtime. An empty brokers array means no Kafka connection is possible.
**Fix:** Accept broker configuration as a parameter or inject it from the module's config, e.g., `brokers: this.kafkaConfig.brokers`.

### 2. CRITICAL: DLQ Reprocessor Returns Before Consuming (Ch43, lines 2273-2316)

**Problem:** `consumer.run()` is non-blocking. The function disconnects and returns `{ processed: 0, failed: 0 }` before any messages are consumed.
**Fix:** Redesign as a batch consumer that reads to end-of-partition or uses a message count limit with an explicit completion signal (e.g., `consumer.seek` to end + process until caught up, then disconnect).

### 3. CRITICAL: Broken Prisma Transaction Rollback Pattern (Ch42, lines 498-504)

**Problem:** `prisma.$transaction(async (tx) => { return tx; })` completes the transaction immediately. The returned `tx` is a stale client.
**Fix:** Remove the `beforeEach` block. Keep only the `afterEach` cleanup with `deleteMany()`. Add a note explaining that Prisma does not support the "wrap in transaction and rollback" pattern common in other ORMs.

### 4. HIGH: Monetary Values as `format: double` (Ch40, lines 487-498)

**Problem:** Directly contradicts Ch41's integer-cents best practice. Readers get conflicting guidance.
**Fix:** Either change the OpenAPI spec to use `type: integer` with "amount in cents" descriptions, or add an explicit note explaining that the API exposes dollar amounts while the database stores cents, with the conversion happening in the DTO/serialization layer.

### 5. MEDIUM: `additionalProperties: false` Contradicts Forward Compatibility (Ch43, line 598)

**Problem:** The JSON Schema example sets `additionalProperties: false`, which rejects messages with new fields -- the opposite of the forward-compatibility principle taught in the same chapter.
**Fix:** Remove `additionalProperties: false` or change to `true`, and add a comment explaining why openness to additional properties is essential for schema evolution.

### 6. MEDIUM: Stryker Config Error (Ch42, lines 1817-1819)

**Problem:** `plugins` inside `mutator` is not a valid Stryker configuration key. The TypeScript checker will not activate.
**Fix:** Move to top-level `checkers: ['@stryker-mutator/typescript-checker']` and remove the `plugins` key from `mutator`.

### 7. MEDIUM: Missing Chapter Summary Tables (Ch41, Ch43)

**Problem:** Chapters 40 and 42 both include summary tables. Chapters 41 and 43 do not. This breaks the established chapter structure.
**Fix:** Add summary tables to both chapters following the same format used in Ch40 (Concept | One-Sentence Summary) or Ch42 (Concept | What It Tests | When to Use | Key Tool).

### 8. MEDIUM: Deprecated ESLint Rule (Ch41, line 107)

**Problem:** `@typescript-eslint/interface-name-prefix` was removed in `@typescript-eslint` v4+. Including it causes an unknown-rule error.
**Fix:** Remove the line. The prose at line 295 already explains the no-I-prefix convention.

### 9. MEDIUM: TypeORM/Prisma Inconsistency (Ch41, lines 391-413)

**Problem:** Ch41 uses TypeORM entity decorators while the rest of the book uses Prisma.
**Fix:** Either convert examples to Prisma schema syntax or add an explicit note explaining why TypeORM decorators are shown here.

### 10. MEDIUM: Cross-Reference Error (Ch44, line 327)

**Problem:** KRaft entry references "Chapter 42 (Future-Proofing)" but Ch42 is "Testing Strategy."
**Fix:** Verify all chapter references in the glossary against actual chapter titles. Correct the KRaft entry and audit all other references.

---

*End of Review — Chapters 40-44*
