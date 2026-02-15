# Chapter 41: Development Guidelines & Code Standards — Writing Code Like a Team

## Why Coding Standards Matter in Microservices Teams

You are about to enter a world where six, ten, or thirty developers work on the same platform simultaneously. Each developer has preferences — how they name variables, where they put files, how they handle errors, how they format their code. In a solo project, none of that matters. In a microservices platform handling 100,000 bookings per minute, inconsistency is a slow-acting poison that kills velocity, breeds bugs, and turns on-call rotations into nightmares.

Consider what happens without coding standards. Developer A writes a booking service with `PascalCase` method names, puts business logic inside controllers, and throws raw `Error` objects. Developer B writes the payment service with `camelCase` methods, separates logic into service classes, and returns null on failure. Developer C writes the inventory service with `snake_case` everywhere, uses a custom Result type, and logs with `console.log`. Each approach works in isolation. But when Developer D is paged at 3 AM and has to trace a failed booking across all three services, they must mentally context-switch between three different paradigms, three different error handling strategies, and three different logging formats. The time to resolution doubles — or triples.

> **Analogy:** Imagine a hospital where each surgeon uses different labels for surgical instruments. One calls a scalpel a "blade," another calls it a "cutter," a third calls it "tool-7." In their own operating rooms, everyone manages fine. But when a nurse moves between rooms, or when an emergency requires two surgeons to collaborate on the same patient, the inconsistent terminology causes delays — and delays in surgery cost lives. Coding standards are the shared vocabulary that lets your team operate at speed without miscommunication.

In microservices architectures, this problem is amplified:

- **Cross-service debugging** requires reading code you did not write, in services you have never touched. If every service follows the same patterns, you can navigate unfamiliar code in minutes.
- **Code reviews** become efficient when reviewers do not have to debate formatting, naming, or project structure — those questions are already answered by the standard.
- **Onboarding** shrinks from weeks to days. A new engineer learns the conventions once and can contribute to any service.
- **Automated tooling** (linters, formatters, CI checks) can enforce rules mechanically, freeing human reviewers to focus on logic and design.

> **Key Term:** **Code Convention** — An agreed-upon set of rules for how code is structured, named, formatted, and organized within a team or project. Conventions reduce cognitive load by making code predictable across every service, regardless of who wrote it.

> **What If You Skip This?** Without shared conventions, every microservice becomes a snowflake. Pull requests devolve into style debates. Onboarding takes weeks. Cross-service debugging during incidents becomes archaeology. The cost is invisible at first — a few minutes here, an hour there — but it compounds into thousands of hours of lost productivity per year across a 30-person team.

This chapter establishes the complete development guidelines for our Global Booking System. These are not suggestions. They are the rules every service, every developer, and every pull request must follow. We will cover everything from how your editor formats code to how you write commit messages to how you name database columns.

---

## ESLint Configuration: Catching Bugs Before They Run

ESLint is your first line of defense against bugs, inconsistencies, and bad patterns. It analyzes your TypeScript code statically — without running it — and flags problems ranging from unused variables to unsafe type assertions. In a microservices team, ESLint enforces rules that no human reviewer should have to check manually.

> **Key Term:** **Static Analysis** — Examining code without executing it, typically using tools like ESLint or the TypeScript compiler. Static analysis catches entire categories of bugs (type errors, unreachable code, unsafe patterns) before a single test runs.

Here is the complete `.eslintrc.js` configuration for our NestJS TypeScript services:

```javascript
// .eslintrc.js — Root ESLint configuration for the monorepo
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  plugins: [
    '@typescript-eslint',
    'import',
    'unused-imports',
    'sonarjs',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:sonarjs/recommended',
    'plugin:import/typescript',
    'prettier', // Must be LAST — disables ESLint rules that conflict with Prettier
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.js', '!.eslintrc.js'],
  rules: {
    // ── TypeScript Strictness ──────────────────────────────────────
    '@typescript-eslint/no-explicit-any': 'error',        // Ban 'any' — use 'unknown'
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',                            // Allow _unusedParam
      varsIgnorePattern: '^_',
    }],
    '@typescript-eslint/explicit-function-return-type': ['error', {
      allowExpressions: true,                             // Allow inline arrow fns
      allowTypedFunctionExpressions: true,
    }],
    '@typescript-eslint/no-floating-promises': 'error',   // Must await or .catch()
    '@typescript-eslint/no-misused-promises': 'error',    // No promises in if()
    '@typescript-eslint/strict-boolean-expressions': 'error', // No truthy checks on non-bools
    '@typescript-eslint/no-non-null-assertion': 'error',  // Ban the ! operator
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/prefer-optional-chain': 'error',

    // ── Import Organization ────────────────────────────────────────
    'import/order': ['error', {
      groups: [
        'builtin',        // Node.js built-in modules (fs, path)
        'external',       // npm packages (@nestjs/common, rxjs)
        'internal',       // Monorepo libs (@libs/database)
        'parent',         // Parent directory imports (../)
        'sibling',        // Same directory imports (./)
        'index',          // Index file imports
      ],
      'newlines-between': 'always',
      alphabetize: { order: 'asc', caseInsensitive: true },
    }],
    'import/no-duplicates': 'error',
    'unused-imports/no-unused-imports': 'error',

    // ── Code Quality ───────────────────────────────────────────────
    'no-console': 'error',                                // Use Logger, not console.log
    'no-return-await': 'off',                             // Defer to TS rule below
    '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    'sonarjs/cognitive-complexity': ['error', 15],         // Max complexity per function
    'sonarjs/no-duplicate-string': ['error', { threshold: 3 }],
    'sonarjs/no-identical-functions': 'error',

    // ── NestJS Specific ────────────────────────────────────────────
    // Note: interface-name-prefix was removed in @typescript-eslint v4+. No I-prefix convention needed.
    '@typescript-eslint/no-empty-interface': 'off',       // Needed for marker interfaces
  },
  overrides: [
    {
      // Relaxed rules for test files
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'warn',     // Tests sometimes need 'any'
        'sonarjs/no-duplicate-string': 'off',             // Test data repeats strings
        '@typescript-eslint/no-floating-promises': 'off',
      },
    },
  ],
};
```

Let us walk through the most important rules and why each one exists:

**`@typescript-eslint/no-explicit-any: 'error'`** — The `any` type defeats the purpose of TypeScript. When you use `any`, the compiler stops checking that value entirely. Bugs that TypeScript was designed to catch sail through undetected. Use `unknown` instead and narrow the type with type guards.

**`@typescript-eslint/no-floating-promises: 'error'`** — A "floating promise" is an async function call where you forget to `await` the result or attach `.catch()`. The promise runs, but if it rejects, the error vanishes silently. In a booking system, this means a payment might fail without anyone knowing. This single rule has prevented more production bugs than any other in our configuration.

**`no-console: 'error'`** — In a microservices platform, `console.log` is useless. It produces unstructured text that cannot be searched, filtered, or correlated. We enforce the use of NestJS's `Logger` class, which produces structured JSON logs with timestamps, service names, and correlation IDs. We will cover this in detail in the Logging Standards section.

**`sonarjs/cognitive-complexity: ['error', 15]`** — Cognitive complexity measures how hard a function is to understand. Deeply nested `if/else` chains, multiple loops, and scattered return statements drive it up. A limit of 15 forces developers to extract helper functions, which makes code more readable and testable.

> **Checkpoint:** Before moving on, make sure you understand why `no-floating-promises` is set to `'error'`. Write a three-line async function that calls another async function without `await`. What happens if the inner function throws? The answer: the error is swallowed silently. This is one of the most common sources of production bugs in Node.js applications.

---

## Prettier Configuration: Ending Formatting Debates Forever

Prettier is an opinionated code formatter. Unlike ESLint, which checks for logical issues, Prettier handles visual formatting: indentation, line length, quote style, trailing commas. The key word is "opinionated" — Prettier does not offer many options on purpose. The fewer options you have, the fewer debates your team can have about formatting.

> **Analogy:** ESLint is the building inspector who checks that the wiring is safe and the structure is sound. Prettier is the interior designer who decides where the furniture goes. You need both, but they solve different problems.

Here is the complete `.prettierrc` configuration:

```json
{
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "semi": true,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf",
  "quoteProps": "as-needed",
  "jsxSingleQuote": false,
  "bracketSameLine": false
}
```

And the `.prettierignore` file to skip generated files:

```
dist/
node_modules/
coverage/
*.generated.ts
*.d.ts
docker-compose*.yml
```

**Format-on-save setup for VS Code** — Every developer must configure their editor to format on save. This eliminates formatting-only diffs in pull requests and means code is always formatted before it reaches version control.

Add the following to `.vscode/settings.json` in the repository root:

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit",
    "source.organizeImports": "never"
  },
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "[json]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  },
  "typescript.preferences.importModuleSpecifier": "non-relative",
  "editor.rulers": [100],
  "files.eol": "\n"
}
```

The recommended extensions file `.vscode/extensions.json` ensures every team member has the right tools:

```json
{
  "recommendations": [
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "ms-vscode.vscode-typescript-next",
    "firsttris.vscode-jest-runner",
    "streetsidesoftware.code-spell-checker"
  ]
}
```

> **What If You Skip This?** Without format-on-save, developers format code manually — or forget. Pull requests contain hundreds of lines of whitespace changes mixed in with actual logic changes. Reviewers cannot distinguish meaningful changes from noise. "Can you remove the formatting changes and resubmit?" becomes a recurring comment that wastes everyone's time.

To enforce formatting in CI, add this to your pipeline:

```bash
# In your CI pipeline (e.g., .github/workflows/ci.yml)
- name: Check formatting
  run: npx prettier --check "apps/**/*.ts" "libs/**/*.ts"

- name: Lint
  run: npx eslint "apps/**/*.ts" "libs/**/*.ts" --max-warnings 0
```

The `--check` flag makes Prettier exit with a non-zero code if any file is not formatted correctly. The `--max-warnings 0` flag treats ESLint warnings as errors in CI, ensuring that warnings are addressed — not ignored.

---

## Naming Conventions: The Most Underrated Form of Documentation

Names are the most-read documentation in your codebase. A developer reads variable names, function names, file names, and class names hundreds of times a day. Consistent naming conventions mean that names communicate intent without requiring the reader to open a file and study its contents.

Here is the complete naming standard for the Global Booking System:

### File Naming

All files use `kebab-case` (lowercase words separated by hyphens). Every file includes a suffix that describes its role:

```
booking.controller.ts          # HTTP request handler
booking.service.ts             # Business logic
booking.repository.ts          # Database access layer
booking.module.ts              # NestJS module definition
booking.entity.ts              # Prisma model / database entity
booking.dto.ts                 # Data Transfer Objects (can split into create-booking.dto.ts)
booking.interface.ts           # TypeScript interfaces
booking.constants.ts           # Named constants and enums
booking.guard.ts               # Authentication/authorization guard
booking.interceptor.ts         # Request/response interceptor
booking.pipe.ts                # Transformation/validation pipe
booking.decorator.ts           # Custom decorators
booking.filter.ts              # Exception filter
booking.subscriber.ts          # Event/message subscriber
booking.factory.ts             # Test data factory
booking.fixture.ts             # Test fixture data
booking.service.spec.ts        # Unit test for booking.service.ts
booking.controller.e2e-spec.ts # End-to-end test
```

The suffix convention means you can instantly identify a file's role from its name in a file explorer, a search result, or an import statement. When you see `booking.repository.ts` in a stack trace, you know the bug is in the database layer — before you even open the file.

### Class, Interface, and Type Naming

Classes, interfaces, and types use `PascalCase`. The class name mirrors the file name with the suffix:

```typescript
// File: booking.service.ts
export class BookingService { }

// File: booking.controller.ts
export class BookingController { }

// File: booking.repository.ts
export class BookingRepository { }

// File: create-booking.dto.ts
export class CreateBookingDto { }

// File: update-booking.dto.ts
export class UpdateBookingDto { }

// File: booking-response.dto.ts
export class BookingResponseDto { }

// File: booking.entity.ts
export class BookingEntity { }

// File: booking.interface.ts
export interface BookingConfig { }
export interface BookingSearchCriteria { }

// File: insufficient-inventory.error.ts
export class InsufficientInventoryError extends Error { }
```

Do not prefix interfaces with `I` (e.g., `IBookingService`). This is a C# convention that clutters TypeScript code. If you need to distinguish an interface from its implementation, name the interface after the capability (`BookingCreator`) and the implementation after the mechanism (`HttpBookingCreator` or `KafkaBookingCreator`).

### Function and Method Naming

Functions and methods use `camelCase`. Names should be verb-first and describe what the function does, not how it does it:

```typescript
// GOOD — verb-first, descriptive
async createBooking(dto: CreateBookingDto): Promise<BookingEntity> { }
async findBookingById(id: string): Promise<BookingEntity | null> { }
async cancelBooking(bookingId: string, reason: CancelReason): Promise<void> { }
async validateAvailability(resourceId: string, dates: DateRange): Promise<boolean> { }
function calculateTotalPrice(lineItems: LineItem[]): Money { }
function formatBookingConfirmation(booking: BookingEntity): string { }

// BAD — vague, noun-first, or misleading
async booking(dto: any): Promise<any> { }          // Noun, not verb. What does this do?
async getBooking(id: string): Promise<any> { }     // "get" is vague — from DB? Cache? API?
async process(data: object): Promise<void> { }     // Process what? How?
function data(items: any[]): any { }               // Meaningless name
```

For boolean-returning functions, use prefixes like `is`, `has`, `can`, `should`:

```typescript
function isBookingCancellable(booking: BookingEntity): boolean { }
function hasAvailableInventory(resourceId: string): Promise<boolean> { }
function canUserModifyBooking(user: User, booking: BookingEntity): boolean { }
function shouldRetryPayment(error: PaymentError): boolean { }
```

### Variable and Constant Naming

Variables use `camelCase`. Constants use `UPPER_SNAKE_CASE`. Enum values use `PascalCase`:

```typescript
// Variables — camelCase
const bookingCount = await this.repository.count();
const isPeakSeason = this.seasonService.isPeak(date);
const retryDelayMs = 1000;

// Constants — UPPER_SNAKE_CASE
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 20;
const BOOKING_CACHE_TTL_SECONDS = 300;
const KAFKA_TOPIC_BOOKING_CREATED = 'booking.events.created';

// Enums — PascalCase keys
enum BookingStatus {
  Pending = 'PENDING',
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
  CheckedIn = 'CHECKED_IN',
  Completed = 'COMPLETED',
  Refunded = 'REFUNDED',
}

enum BookingType {
  Hotel = 'HOTEL',
  Flight = 'FLIGHT',
  CarRental = 'CAR_RENTAL',
  Experience = 'EXPERIENCE',
}
```

### Database Column and Table Naming

Database tables and columns use `snake_case`. This follows PostgreSQL conventions and avoids quoting issues:

```sql
-- Table names: plural, snake_case
CREATE TABLE bookings (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_reference  VARCHAR(20) NOT NULL UNIQUE,
  booking_type       VARCHAR(20) NOT NULL,
  booking_status     VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  user_id            BIGINT NOT NULL REFERENCES users(id),
  resource_id        BIGINT NOT NULL,
  check_in_date      DATE NOT NULL,
  check_out_date     DATE NOT NULL,
  total_price_cents  BIGINT NOT NULL,          -- Store money as cents, never decimals
  currency_code      CHAR(3) NOT NULL,         -- ISO 4217 (USD, EUR, GBP)
  created_at         DATETIME(6) NOT NULL DEFAULT NOW(6),
  updated_at         DATETIME(6) NOT NULL DEFAULT NOW(6),
  cancelled_at       DATETIME(6),
  cancellation_reason TEXT
);

-- Index names: idx_{table}_{columns}
CREATE INDEX idx_bookings_user_id ON bookings(user_id);
CREATE INDEX idx_bookings_status_created ON bookings(booking_status, created_at);
```

In Prisma models, use the `@map` attribute to map `camelCase` TypeScript properties to `snake_case` database columns:

```typescript
@Entity('bookings')
export class BookingEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint' })
  id: string; // BigInt returned as string by pg driver

  @Column({ name: 'booking_reference', type: 'varchar', length: 20, unique: true })
  bookingReference: string;

  @Column({ name: 'booking_status', type: 'varchar', length: 20, default: 'PENDING' })
  bookingStatus: BookingStatus;

  @Column({ name: 'total_price_cents', type: 'bigint' })
  totalPriceCents: string;

  @Column({ name: 'currency_code', type: 'char', length: 3 })
  currencyCode: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

> **Common Mistake:** Storing monetary values as `DECIMAL` or `FLOAT`. Floating-point arithmetic produces rounding errors: `0.1 + 0.2 = 0.30000000000000004`. Always store money as integer cents (e.g., `$19.99` becomes `1999`). Perform arithmetic on integers, and convert to dollars only for display. This is not a theoretical risk — financial bugs from floating-point arithmetic have caused real monetary discrepancies in production booking systems.

---

## NestJS Project Structure: Module Organization and Barrel Exports

Every microservice in the monorepo follows the same internal structure. When you open any service — booking, payment, inventory, notification — the folder layout is identical. This predictability is the entire point of conventions.

### Service Internal Structure

```
apps/booking-service/
├── src/
│   ├── main.ts                           # Bootstrap file
│   ├── app.module.ts                     # Root module
│   ├── booking/                          # Feature module: booking
│   │   ├── booking.module.ts
│   │   ├── booking.controller.ts
│   │   ├── booking.service.ts
│   │   ├── booking.repository.ts
│   │   ├── booking.entity.ts
│   │   ├── dto/
│   │   │   ├── index.ts                  # Barrel export
│   │   │   ├── create-booking.dto.ts
│   │   │   ├── update-booking.dto.ts
│   │   │   ├── booking-response.dto.ts
│   │   │   └── booking-search.dto.ts
│   │   ├── errors/
│   │   │   ├── index.ts                  # Barrel export
│   │   │   ├── booking-not-found.error.ts
│   │   │   ├── booking-conflict.error.ts
│   │   │   └── insufficient-inventory.error.ts
│   │   ├── interfaces/
│   │   │   ├── index.ts                  # Barrel export
│   │   │   └── booking-search-criteria.interface.ts
│   │   ├── constants/
│   │   │   └── booking.constants.ts
│   │   └── subscribers/
│   │       └── booking-event.subscriber.ts
│   ├── health/                           # Feature module: health check
│   │   ├── health.module.ts
│   │   └── health.controller.ts
│   └── config/                           # App configuration
│       ├── app.config.ts
│       └── database.config.ts
├── test/
│   ├── unit/
│   │   ├── booking.service.spec.ts
│   │   └── booking.repository.spec.ts
│   ├── integration/
│   │   └── booking.repository.integration.spec.ts
│   └── e2e/
│       └── booking.controller.e2e-spec.ts
├── Dockerfile
├── tsconfig.app.json
└── jest.config.ts
```

### The Module Pattern

Each feature is a NestJS module. The module file declares the controller, service, repository, and any imports the feature needs:

```typescript
// booking.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';

import { KafkaModule } from '@libs/kafka';
import { RedisModule } from '@libs/redis';

import { BookingController } from './booking.controller';
import { BookingEntity } from './booking.entity';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingEventSubscriber } from './subscribers/booking-event.subscriber';

@Module({
  imports: [
    PrismaModule,
    KafkaModule,
    RedisModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingRepository, BookingEventSubscriber],
  exports: [BookingService], // Only export what other modules need
})
export class BookingModule {}
```

The rule is: **export the minimum surface area.** If only `BookingService` is needed by other modules, do not export `BookingRepository`. This keeps modules loosely coupled and makes it clear which classes are the public API of a module.

### Barrel Exports

A barrel export is an `index.ts` file that re-exports everything from a directory. This simplifies imports and creates a single entry point:

```typescript
// dto/index.ts — Barrel export for booking DTOs
export { CreateBookingDto } from './create-booking.dto';
export { UpdateBookingDto } from './update-booking.dto';
export { BookingResponseDto } from './booking-response.dto';
export { BookingSearchDto } from './booking-search.dto';
```

Without barrel exports, importing multiple DTOs requires multiple lines with long paths:

```typescript
// WITHOUT barrel exports — verbose and fragile
import { CreateBookingDto } from './dto/create-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { BookingResponseDto } from './dto/booking-response.dto';
```

With barrel exports, a single import line suffices:

```typescript
// WITH barrel exports — clean and maintainable
import { CreateBookingDto, UpdateBookingDto, BookingResponseDto } from './dto';
```

> **What If You Skip This?** Without barrel exports, imports become long chains of file paths. When you rename or move a file, you must update every import individually. Barrel exports provide a layer of indirection — consumers import from the directory, and only the `index.ts` needs updating when files move.

> **Checkpoint:** Look at the service structure above. Can you identify which layer handles HTTP concerns, which handles business logic, and which handles database access? The answer: Controller handles HTTP (request parsing, response formatting). Service handles business logic (validation, orchestration, rules). Repository handles database access (queries, transactions). This three-layer separation is not optional — it is how every service is organized.

---

## Error Handling Patterns: Custom Exception Classes and Global Exception Filters

In a microservices platform processing 100,000 bookings per minute, errors are not exceptional — they are routine. Rooms sell out, payments decline, users submit invalid data, external services go down. How you handle these errors determines whether your system fails gracefully with helpful messages or crashes with cryptic stack traces.

### The Error Hierarchy

Our system distinguishes between two categories of errors, and this distinction shapes the entire error handling strategy:

1. **Expected business errors** — A room is sold out, a flight is overbooked, a payment is declined. These are normal business outcomes. They happen thousands of times per day and require specific, user-friendly responses.
2. **Unexpected system errors** — A database connection drops, a Kafka broker is unreachable, a null pointer dereference occurs. These are bugs or infrastructure failures. They require logging, alerting, and generic error responses.

> **Key Term:** **Exception Hierarchy** — A set of custom error classes organized in an inheritance tree, where each class carries specific context about what went wrong. The hierarchy allows error handlers to catch errors at the appropriate level of specificity.

Here is the complete custom exception hierarchy for the booking platform:

```typescript
// libs/common/errors/base.error.ts
export abstract class DomainError extends Error {
  abstract readonly code: string;           // Machine-readable error code
  abstract readonly httpStatus: number;     // HTTP status code to return
  readonly timestamp: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date().toISOString();
    // Preserve proper stack trace in V8 engines
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Convert to a JSON-safe object for API responses.
   * Subclasses override to add specific fields.
   */
  toResponse(): Record<string, unknown> {
    return {
      error: this.code,
      message: this.message,
      timestamp: this.timestamp,
    };
  }
}

// libs/common/errors/not-found.error.ts
export class ResourceNotFoundError extends DomainError {
  readonly code = 'RESOURCE_NOT_FOUND';
  readonly httpStatus = 404;

  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
  ) {
    super(`${resourceType} with id '${resourceId}' not found`);
  }

  override toResponse(): Record<string, unknown> {
    return {
      ...super.toResponse(),
      resourceType: this.resourceType,
      resourceId: this.resourceId,
    };
  }
}

// libs/common/errors/conflict.error.ts
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;

  constructor(
    public readonly resourceType: string,
    public readonly conflictReason: string,
  ) {
    super(`Conflict on ${resourceType}: ${conflictReason}`);
  }
}

// libs/common/errors/insufficient-inventory.error.ts
export class InsufficientInventoryError extends DomainError {
  readonly code = 'INSUFFICIENT_INVENTORY';
  readonly httpStatus = 409;

  constructor(
    public readonly resourceType: string,
    public readonly resourceId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      `Insufficient inventory for ${resourceType}:${resourceId}. ` +
      `Requested: ${requested}, Available: ${available}`,
    );
  }

  override toResponse(): Record<string, unknown> {
    return {
      ...super.toResponse(),
      resourceType: this.resourceType,
      resourceId: this.resourceId,
      requested: this.requested,
      available: this.available,
    };
  }
}

// libs/common/errors/validation.error.ts
export class BusinessValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 422;

  constructor(
    public readonly field: string,
    public readonly constraint: string,
  ) {
    super(`Validation failed: ${field} — ${constraint}`);
  }
}

// libs/common/errors/payment.error.ts
export class PaymentFailedError extends DomainError {
  readonly code = 'PAYMENT_FAILED';
  readonly httpStatus = 402;

  constructor(
    public readonly paymentId: string,
    public readonly declineCode: string,
    public readonly declineMessage: string,
  ) {
    super(`Payment ${paymentId} declined: ${declineCode}`);
  }
}

// libs/common/errors/rate-limit.error.ts
export class RateLimitExceededError extends DomainError {
  readonly code = 'RATE_LIMIT_EXCEEDED';
  readonly httpStatus = 429;

  constructor(
    public readonly retryAfterSeconds: number,
  ) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`);
  }
}
```

Every custom error carries structured context. When `InsufficientInventoryError` is thrown, the error handler knows exactly what resource type, what resource ID, how many were requested, and how many were available. Compare that to `throw new Error('insufficient inventory')` — which tells you nothing actionable.

### Global Exception Filter

NestJS supports global exception filters that catch every unhandled error before it reaches the client. This is where we convert our domain errors into consistent API responses and log every failure:

```typescript
// libs/common/filters/global-exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

import { DomainError } from '../errors/base.error';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const correlationId = request.headers['x-correlation-id'] as string;

    if (exception instanceof DomainError) {
      // Expected business error — log at WARN level, return structured response
      this.logger.warn({
        message: exception.message,
        errorCode: exception.code,
        correlationId,
        path: request.url,
        method: request.method,
        stack: exception.stack,
      });

      response.status(exception.httpStatus).json({
        ...exception.toResponse(),
        correlationId,
        path: request.url,
      });
      return;
    }

    if (exception instanceof HttpException) {
      // NestJS built-in HTTP exception (e.g., from ValidationPipe)
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      this.logger.warn({
        message: exception.message,
        correlationId,
        path: request.url,
        method: request.method,
        response: exceptionResponse,
      });

      response.status(status).json({
        error: 'HTTP_ERROR',
        statusCode: status,
        message: exception.message,
        ...(typeof exceptionResponse === 'object' ? exceptionResponse : {}),
        correlationId,
        path: request.url,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Unexpected error — log at ERROR level, return generic 500
    const unexpectedError = exception instanceof Error
      ? exception
      : new Error(String(exception));

    this.logger.error({
      message: 'Unhandled exception',
      error: unexpectedError.message,
      correlationId,
      path: request.url,
      method: request.method,
      stack: unexpectedError.stack,
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred. Please try again later.',
      correlationId,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
```

Register the filter globally in your bootstrap file:

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';

import { GlobalExceptionFilter } from '@libs/common/filters/global-exception.filter';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,            // Strip properties not in the DTO
    forbidNonWhitelisted: true, // Throw error if extra properties are sent
    transform: true,            // Auto-transform payloads to DTO instances
  }));

  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(3000);
}
void bootstrap();
```

> **What If You Skip This?** Without a global exception filter, unhandled errors produce NestJS's default error response — or worse, leak stack traces to clients. Each controller handles errors differently. Some return `{ error: 'Not found' }`, others return `{ message: 'Not found' }`, others return `{ msg: 'not found', success: false }`. API consumers cannot parse errors reliably. The global filter guarantees that every error — from every service — follows the same response format.

---

## Logging Standards: Structured Logging with Correlation IDs

`console.log('booking created')` is not logging. It is printing. In a microservices platform where dozens of service instances handle thousands of requests per second, unstructured text output is useless. You cannot search it, filter it, correlate it across services, or alert on it.

Structured logging means every log entry is a JSON object with consistent fields. Log aggregation tools (Elasticsearch, Datadog, Grafana Loki) can parse, index, and query structured logs. Unstructured text? They just store it as a blob.

> **Analogy:** Imagine a city where every police report is written as a free-form essay. One officer writes "Robbery at Main St, 3pm." Another writes "At approximately fifteen-hundred hours, a criminal act was perpetrated at the intersection of Main and Fifth." Searching for all robberies on Main Street requires reading every report. Now imagine every report is a structured form: Date, Time, Location, Crime Type, Suspect Description. Searching becomes a database query. Structured logging is the form-based report for your services.

### The Logging Service

```typescript
// libs/monitoring/logger/app-logger.service.ts
import { Injectable, LoggerService, Scope } from '@nestjs/common';

export interface LogContext {
  correlationId?: string;
  userId?: string;
  bookingId?: string;
  service?: string;
  method?: string;
  duration?: number;
  [key: string]: unknown;
}

@Injectable({ scope: Scope.TRANSIENT }) // Each injection gets its own instance
export class AppLogger implements LoggerService {
  private context = '';
  private defaultMeta: LogContext = {};

  setContext(context: string): void {
    this.context = context;
  }

  setDefaultMeta(meta: LogContext): void {
    this.defaultMeta = { ...this.defaultMeta, ...meta };
  }

  log(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }

  error(message: string, trace?: string, context?: LogContext): void {
    this.emit('error', message, { ...context, stackTrace: trace });
  }

  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }

  private emit(level: string, message: string, context?: LogContext): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.context,
      ...this.defaultMeta,
      ...context,
    };

    // In production, this writes to stdout as JSON.
    // The container runtime (Docker/K8s) captures stdout
    // and ships to log aggregation.
    process.stdout.write(JSON.stringify(logEntry) + '\n');
  }
}
```

### Correlation IDs: Tracing Requests Across Services

A correlation ID is a unique identifier that follows a request through every service it touches. When the API gateway receives an HTTP request, it generates a correlation ID (or reads one from the `X-Correlation-Id` header) and passes it to every downstream service via headers or Kafka message metadata. Every log entry includes this ID.

```typescript
// libs/common/middleware/correlation-id.middleware.ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId =
      (req.headers['x-correlation-id'] as string) || randomUUID();

    // Attach to request for downstream use
    req.headers['x-correlation-id'] = correlationId;

    // Include in response headers so clients can reference it
    res.setHeader('x-correlation-id', correlationId);

    next();
  }
}
```

When a booking fails, you search your log aggregation tool for the correlation ID and see the complete journey:

```json
{"timestamp":"2025-11-20T14:32:01.123Z","level":"info","service":"api-gateway","correlationId":"abc-123","message":"POST /bookings received","userId":"user-789"}
{"timestamp":"2025-11-20T14:32:01.145Z","level":"info","service":"booking-service","correlationId":"abc-123","message":"Checking inventory","resourceId":"hotel-456"}
{"timestamp":"2025-11-20T14:32:01.198Z","level":"info","service":"inventory-service","correlationId":"abc-123","message":"Inventory check passed","available":3}
{"timestamp":"2025-11-20T14:32:01.250Z","level":"info","service":"payment-service","correlationId":"abc-123","message":"Processing payment","amount":29900,"currency":"USD"}
{"timestamp":"2025-11-20T14:32:02.100Z","level":"warn","service":"payment-service","correlationId":"abc-123","message":"Payment declined","declineCode":"insufficient_funds"}
{"timestamp":"2025-11-20T14:32:02.110Z","level":"info","service":"booking-service","correlationId":"abc-123","message":"Booking failed: payment declined","bookingId":"bk-001"}
```

Six log entries across four services, all linked by `abc-123`. Without correlation IDs, these entries are scattered across separate log streams with no connection.

> **Key Term:** **Correlation ID** — A unique identifier (typically a UUID) that accompanies a request through every service and message queue it touches. By including the correlation ID in every log entry, you can reconstruct the complete lifecycle of a request across a distributed system.

### What to Log (and What Not to Log)

**Always log:**
- Request received (method, path, user ID, correlation ID)
- Business decisions (inventory check result, payment result, booking status transitions)
- External service calls (service name, duration, success/failure)
- Error details (error code, message, context — but not stack traces for expected errors)
- Performance data (query duration, message processing time)

**Never log:**
- Passwords, tokens, API keys, or secrets
- Full credit card numbers (log last four digits at most)
- Personal Identifiable Information (PII) like social security numbers or passport numbers
- Request/response bodies in full (they may contain sensitive data)
- Stack traces for expected business errors (they clutter logs)

> **Common Mistake:** Logging full request bodies "for debugging." In a booking system, request bodies contain names, email addresses, payment information, and dates of travel. Logging this data creates a compliance nightmare under GDPR, PCI-DSS, and other regulations. Log only the fields you need, and redact sensitive values.

---

## Git Conventions: Commit Messages, Branch Naming, and PR Templates

Git is not just a version control tool — it is the historical record of every decision, every bug fix, and every feature your team has ever built. A clean git history is searchable, reviewable, and invaluable during incident investigations. A messy git history ("fix stuff", "wip", "asdfgh") is a liability.

### Commit Message Format

We follow the Conventional Commits specification. Every commit message has a structured format:

```
<type>(<scope>): <short description>

<optional body — explain WHY, not WHAT>

<optional footer — breaking changes, ticket references>
```

**Types:**

| Type | When to Use | Example |
|------|-------------|---------|
| `feat` | New feature or capability | `feat(booking): add multi-room booking support` |
| `fix` | Bug fix | `fix(payment): handle null currency code in refund flow` |
| `refactor` | Code restructuring without behavior change | `refactor(inventory): extract availability check to separate service` |
| `perf` | Performance improvement | `perf(search): add database index for date range queries` |
| `test` | Adding or updating tests | `test(booking): add edge case tests for cancellation window` |
| `docs` | Documentation changes | `docs(api): update OpenAPI spec for booking endpoints` |
| `chore` | Build, tooling, or dependency updates | `chore(deps): upgrade @nestjs/core to 10.3.0` |
| `ci` | CI/CD pipeline changes | `ci: add integration test stage to GitHub Actions` |
| `style` | Formatting only (no logic change) | `style: apply prettier formatting to payment module` |

**Scopes** correspond to the service or module being changed: `booking`, `payment`, `inventory`, `gateway`, `notification`, `kafka`, `redis`, `infra`.

Real examples of good versus bad commit messages:

```
# BAD — meaningless, no context
fix bug
update code
wip
changes
misc fixes
it works now

# GOOD — precise, searchable, explains intent
feat(booking): support partial cancellation with per-item refunds

When a multi-item booking is partially cancelled, calculate refund
amounts per line item instead of refunding the full booking total.
This prevents over-refunding when only one room out of three is
cancelled.

Closes #1247
```

```
# BAD — explains WHAT (which is obvious from the diff), not WHY
fix(payment): change timeout from 5000 to 10000

# GOOD — explains WHY the change was made
fix(payment): increase Stripe API timeout to prevent false failures

The default 5-second timeout was causing 2% of payment requests to
fail during peak hours when Stripe's p99 latency reaches 7 seconds.
Increasing to 10 seconds reduces false failures while still detecting
actual outages within a reasonable window.
```

> **Key Term:** **Conventional Commits** — A specification for writing standardized commit messages using structured prefixes (feat, fix, refactor, etc.). Conventional Commits enable automated changelog generation, semantic versioning, and meaningful git history searches.

### Branch Naming

Branches follow the pattern `<type>/<ticket-id>-<short-description>`:

```
feat/BOOK-1247-multi-room-booking
fix/PAY-892-null-currency-refund
refactor/INV-445-extract-availability-service
chore/OPS-210-upgrade-nestjs-10
hotfix/BOOK-1300-double-charge-prevention
```

Rules:
- Always include the ticket ID so the branch links to the issue tracker
- Use lowercase `kebab-case` for the description
- Keep descriptions short (3-5 words)
- Use `hotfix/` prefix for production emergency fixes that bypass normal review

### Pull Request Template

Every repository includes a `.github/pull_request_template.md` that structures PR descriptions:

```markdown
## What does this PR do?

<!-- Describe the change in 2-3 sentences. Link the ticket. -->

Closes #TICKET_ID

## Why is this change needed?

<!-- Explain the business context or technical problem this solves. -->

## What changed?

<!-- Bulleted list of specific changes, grouped by file or module. -->

- [ ] Change 1
- [ ] Change 2

## How was this tested?

<!-- Describe the testing approach: unit tests, integration tests, manual testing. -->

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] Manual testing completed
- [ ] Tested in staging environment

## Database changes?

<!-- If yes, describe the migration and rollback strategy. -->

- [ ] No database changes
- [ ] Migration included (up + down)
- [ ] Data backfill required

## Breaking changes?

<!-- If yes, describe the impact and migration path for consumers. -->

- [ ] No breaking changes
- [ ] Breaking change (describe below)

## Screenshots / API examples

<!-- If applicable, show before/after or example request/response. -->

## Checklist

- [ ] Code follows project conventions
- [ ] Self-review completed
- [ ] No `console.log` or debug code left
- [ ] Error handling follows domain error pattern
- [ ] Structured logging added for key operations
- [ ] New environment variables documented
- [ ] API documentation updated (if applicable)
```

> **What If You Skip This?** Without a PR template, developers describe changes inconsistently. Some write three words. Others write three paragraphs about the wrong things. Reviewers spend time asking "what does this do?" and "how do I test it?" instead of reviewing the actual code. The template ensures every PR answers the questions reviewers need answered.

---

## Code Review Checklist: What Reviewers Should Look For

Code review is not proofreading. It is a structured process where a reviewer evaluates whether a change is correct, maintainable, secure, and consistent with team standards. A good review catches bugs that tests miss, identifies design flaws before they ossify, and spreads knowledge across the team.

Here is what every reviewer checks, organized by priority:

### 1. Correctness

- Does the code actually do what the PR description says it does?
- Are edge cases handled? (null inputs, empty arrays, boundary values, concurrent access)
- Are error paths tested, not just the happy path?
- Does the code handle partial failures? (What if step 2 of 3 fails — is step 1 rolled back?)
- Are database queries correct? (Joins, WHERE clauses, GROUP BY semantics)

### 2. Security

- Is user input validated before use? (DTO validation, parameterized queries)
- Are authorization checks in place? (Can a user access only their own bookings?)
- Are secrets hardcoded anywhere? (API keys, database passwords, tokens)
- Are SQL queries parameterized? (Never use string interpolation in queries)
- Does the API expose more data than necessary? (Over-fetching user data in responses)

### 3. Architecture and Design

- Does the change follow the three-layer pattern? (Controller -> Service -> Repository)
- Is business logic in the service layer, not in the controller?
- Are new dependencies justified? (Does this npm package solve a real problem, or is it a 2-line utility?)
- Does the change increase coupling between modules? (Does module A now depend on module B's internals?)
- Is the change backward-compatible? (Will existing API consumers break?)

### 4. Conventions and Consistency

- Does the code follow naming conventions? (File names, class names, function names)
- Are custom domain errors used instead of generic `Error` or NestJS `HttpException`?
- Is structured logging used instead of `console.log`?
- Are imports organized according to ESLint rules?
- Is the code formatted by Prettier? (CI should catch this, but reviewers double-check)

### 5. Performance

- Are database queries efficient? (Missing indexes, N+1 queries, full table scans)
- Are expensive operations cached when appropriate?
- Does the change introduce unnecessary memory allocations? (Loading all records when only one is needed)
- Are Kafka messages reasonably sized? (Not sending entire database rows as events)

### 6. Testing

- Are there tests for the new behavior?
- Do tests cover edge cases, not just the happy path?
- Are tests deterministic? (No dependency on time, random values, or external services)
- Do test names describe the behavior being tested?
- Are test data factories used instead of inline object literals?

> **Analogy:** A code review checklist is like a pilot's pre-flight checklist. Pilots do not skip items because "I have been flying for 20 years and I know this plane." The checklist exists because human memory is fallible, and the consequences of missing something are severe. Code review checklists work the same way — even experienced developers benefit from a systematic check.

> **Checkpoint:** Pick a recent pull request you have submitted or reviewed. Walk through the six categories above. How many of these areas did the review actually cover? Most reviews focus only on correctness and skip security, performance, and conventions entirely. The checklist ensures nothing is missed.

---

## Testing Standards: What to Test, Naming Test Files, and Test Data Factories

Testing is not optional. In a system processing 100,000 bookings per minute, a single untested edge case can cascade into thousands of failed transactions. But "write more tests" is not a standard — it is a wish. This section defines exactly what to test, how to name tests, and how to generate test data consistently.

### What to Test

Not everything needs a test, and not everything needs the same kind of test. Here is the decision framework:

| Layer | What to Test | Test Type | Priority |
|-------|-------------|-----------|----------|
| Service (business logic) | All business rules, edge cases, error conditions | Unit test | Highest |
| Repository (data access) | Complex queries, transaction behavior | Integration test | High |
| Controller (HTTP layer) | Request/response mapping, validation | E2E test | Medium |
| DTOs (validation) | Validation rules, edge cases for each field | Unit test | Medium |
| Custom errors | Error construction, `toResponse()` output | Unit test | Low |
| Configuration | Config loading, env var parsing | Unit test | Low |

The guideline is: **test behavior, not implementation.** A unit test for `BookingService.createBooking()` should verify that a booking is created when inventory is available, that it fails when inventory is exhausted, and that payment is charged the correct amount. It should not verify the internal order of method calls or that specific private methods were invoked.

### Naming Test Files and Test Cases

Test files are named after the file they test, with a `.spec.ts` suffix for unit tests and `.e2e-spec.ts` for end-to-end tests:

```
booking.service.spec.ts             # Unit tests for BookingService
booking.repository.integration.spec.ts  # Integration tests for BookingRepository
booking.controller.e2e-spec.ts      # E2E tests for BookingController
```

Test cases follow the `describe`/`it` pattern with descriptive names that read as sentences:

```typescript
describe('BookingService', () => {
  describe('createBooking', () => {
    it('should create a confirmed booking when inventory is available', async () => {
      // ...
    });

    it('should throw InsufficientInventoryError when no rooms are available', async () => {
      // ...
    });

    it('should throw PaymentFailedError when payment is declined', async () => {
      // ...
    });

    it('should release held inventory when payment fails', async () => {
      // ...
    });

    it('should generate a unique booking reference', async () => {
      // ...
    });
  });

  describe('cancelBooking', () => {
    it('should set status to Cancelled and record the cancellation reason', async () => {
      // ...
    });

    it('should throw ResourceNotFoundError when booking does not exist', async () => {
      // ...
    });

    it('should throw BusinessValidationError when booking is already cancelled', async () => {
      // ...
    });

    it('should calculate partial refund when outside free cancellation window', async () => {
      // ...
    });
  });
});
```

When a test fails, the output reads as a sentence: `BookingService > createBooking > should throw InsufficientInventoryError when no rooms are available`. You know exactly what broke and where to look.

### Test Data Factories

Inline test data is a maintenance nightmare. When you repeat `{ bookingType: 'HOTEL', status: 'CONFIRMED', userId: 'user-123', ... }` across 50 test files and then add a new required field to the DTO, you must update all 50 files. Test data factories solve this:

```typescript
// test/factories/booking.factory.ts
import { BookingEntity } from '../../src/booking/booking.entity';
import { BookingStatus, BookingType } from '../../src/booking/constants/booking.constants';

let sequenceCounter = 0;

export function createBookingEntity(
  overrides: Partial<BookingEntity> = {},
): BookingEntity {
  sequenceCounter++;
  const booking = new BookingEntity();

  booking.id = overrides.id ?? String(sequenceCounter);
  booking.bookingReference = overrides.bookingReference ?? `BK-${String(sequenceCounter).padStart(6, '0')}`;
  booking.bookingType = overrides.bookingType ?? BookingType.Hotel;
  booking.bookingStatus = overrides.bookingStatus ?? BookingStatus.Confirmed;
  booking.totalPriceCents = overrides.totalPriceCents ?? '29900';
  booking.currencyCode = overrides.currencyCode ?? 'USD';
  booking.createdAt = overrides.createdAt ?? new Date('2025-06-15T10:00:00Z');
  booking.updatedAt = overrides.updatedAt ?? new Date('2025-06-15T10:00:00Z');

  return Object.assign(booking, overrides);
}

// Usage in tests:
const confirmedBooking = createBookingEntity();
const cancelledBooking = createBookingEntity({
  bookingStatus: BookingStatus.Cancelled,
});
const expensiveBooking = createBookingEntity({
  totalPriceCents: '1500000',
  currencyCode: 'EUR',
});
```

```typescript
// test/factories/dto.factory.ts
import { CreateBookingDto } from '../../src/booking/dto';
import { BookingType } from '../../src/booking/constants/booking.constants';

export function createBookingDto(
  overrides: Partial<CreateBookingDto> = {},
): CreateBookingDto {
  const dto = new CreateBookingDto();

  dto.bookingType = overrides.bookingType ?? BookingType.Hotel;
  dto.resourceId = overrides.resourceId ?? 12345;
  dto.checkIn = overrides.checkIn ?? '2025-07-01';
  dto.checkOut = overrides.checkOut ?? '2025-07-05';

  return Object.assign(dto, overrides);
}
```

When you add a new required field to `BookingEntity`, you update the factory once, and all 50 tests continue working. The factory provides sensible defaults, and individual tests override only the fields relevant to the behavior they are testing.

> **Common Mistake:** Writing tests that depend on the exact order of operations inside a function. These tests break when you refactor the internals, even though the behavior is unchanged. Test the outputs and side effects, not the internal steps.

---

## TypeScript Strict Mode: Why and Which Flags to Enable

TypeScript's type system only protects you if you turn on strict mode. Without it, TypeScript is merely "JavaScript with optional type annotations" — you still get null reference errors, implicit `any` types, and unchecked assumptions.

Here is the complete `tsconfig.json` for our services, with every strict flag explained:

```json
{
  "compilerOptions": {
    // ── Strict Type Checking ──────────────────────────────────
    "strict": true,                        // Enables ALL strict flags below
    "strictNullChecks": true,              // null and undefined are distinct types
    "strictFunctionTypes": true,           // Stricter function parameter checking
    "strictBindCallApply": true,           // Check bind/call/apply arguments
    "strictPropertyInitialization": true,  // Class properties must be initialized
    "noImplicitAny": true,                 // Error on implicit 'any' type
    "noImplicitReturns": true,             // Error if function can return undefined implicitly
    "noImplicitThis": true,               // Error on 'this' with implicit any type
    "noUncheckedIndexedAccess": true,      // Array/object index access returns T | undefined
    "noFallthroughCasesInSwitch": true,    // Error on switch fallthrough without break
    "forceConsistentCasingInFileNames": true, // Prevent casing mismatch in imports
    "exactOptionalPropertyTypes": true,    // Distinguish between missing and undefined

    // ── Module Resolution ──────────────────────────────────────
    "module": "commonjs",
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "esModuleInterop": true,

    // ── Output ─────────────────────────────────────────────────
    "target": "ES2022",
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "incremental": true,

    // ── Decorators (required for NestJS) ───────────────────────
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,

    // ── Path Aliases ───────────────────────────────────────────
    "baseUrl": ".",
    "paths": {
      "@libs/*": ["libs/*/src"]
    },

    // ── Additional Checks ──────────────────────────────────────
    "skipLibCheck": true
  },
  "include": ["apps/**/*.ts", "libs/**/*.ts"],
  "exclude": ["node_modules", "dist", "coverage"]
}
```

The most impactful flags and why they matter:

**`strictNullChecks`** — Without this flag, every type implicitly includes `null` and `undefined`. A variable typed as `string` could actually be `null`, and TypeScript will not warn you. With this flag enabled, `string` means "definitely a string" and `string | null` means "might be null — you must check." This single flag eliminates the most common runtime error in JavaScript: "Cannot read properties of null."

**`noUncheckedIndexedAccess`** — When you access `array[0]` or `object['key']`, TypeScript normally assumes the value exists. With this flag, the return type includes `| undefined`, forcing you to handle the case where the index or key does not exist. This catches out-of-bounds array access and missing object properties at compile time.

**`noImplicitAny`** — Without this flag, untyped function parameters default to `any`, and the compiler skips type checking entirely. With this flag, every parameter must have an explicit type. If you cannot determine a type, use `unknown` and narrow it with type guards.

**`exactOptionalPropertyTypes`** — This flag distinguishes between a property that is missing and a property that is explicitly set to `undefined`. The difference matters for database operations where you want to update only the fields that are present in a partial update DTO.

> **What If You Skip This?** Without strict mode, TypeScript gives you a false sense of safety. You see type annotations and assume the compiler is checking them thoroughly. But without strict flags, the compiler silently allows patterns that produce runtime errors — null dereferences, implicit `any` types, unchecked array access. You get the verbosity of types without the protection.

---

## Dependency Injection Best Practices in NestJS

Dependency injection (DI) is the backbone of NestJS applications. Used well, it makes code testable, modular, and flexible. Used poorly, it creates invisible coupling, circular dependencies, and services that are impossible to instantiate in tests.

### Rule 1: Depend on Abstractions, Not Implementations

When a service depends on an external system (database, message queue, cache), inject an abstraction — not the concrete implementation:

```typescript
// GOOD — depends on an interface
export interface PaymentGateway {
  charge(amount: number, currency: string, token: string): Promise<PaymentResult>;
  refund(paymentId: string, amount: number): Promise<RefundResult>;
}

@Injectable()
export class BookingService {
  constructor(
    @Inject('PAYMENT_GATEWAY')
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async createBooking(dto: CreateBookingDto): Promise<BookingEntity> {
    // Uses this.paymentGateway — does not know or care if it is Stripe, Adyen, or a mock
    const payment = await this.paymentGateway.charge(
      dto.totalPriceCents,
      dto.currencyCode,
      dto.paymentToken,
    );
    // ...
  }
}
```

In the module, you bind the abstraction to the concrete implementation:

```typescript
// booking.module.ts
@Module({
  providers: [
    BookingService,
    {
      provide: 'PAYMENT_GATEWAY',
      useClass: StripePaymentGateway, // In production, use Stripe
    },
  ],
})
export class BookingModule {}
```

In tests, you bind the abstraction to a mock:

```typescript
const module = await Test.createTestingModule({
  providers: [
    BookingService,
    {
      provide: 'PAYMENT_GATEWAY',
      useValue: {
        charge: jest.fn().mockResolvedValue({ id: 'pay_123', status: 'succeeded' }),
        refund: jest.fn().mockResolvedValue({ id: 'ref_456', status: 'succeeded' }),
      },
    },
  ],
}).compile();
```

### Rule 2: Keep Providers Focused

Each injectable class should have a single, well-defined responsibility. If a service class has 20 methods touching bookings, payments, inventory, and notifications, it is doing too much. Split it:

```typescript
// BAD — one god-service that does everything
@Injectable()
export class BookingService {
  async createBooking() { /* ... */ }
  async processPayment() { /* ... */ }    // Should be in PaymentService
  async checkInventory() { /* ... */ }    // Should be in InventoryService
  async sendConfirmation() { /* ... */ }  // Should be in NotificationService
  async generateReport() { /* ... */ }    // Should be in ReportService
}

// GOOD — focused services that collaborate
@Injectable()
export class BookingService {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly inventoryService: InventoryService,
    private readonly notificationService: NotificationService,
  ) {}

  async createBooking(dto: CreateBookingDto): Promise<BookingEntity> {
    await this.inventoryService.reserve(dto.resourceId, dto.dates);
    const payment = await this.paymentService.charge(dto.paymentDetails);
    const booking = await this.repository.save(/* ... */);
    await this.notificationService.sendConfirmation(booking);
    return booking;
  }
}
```

### Rule 3: Avoid Circular Dependencies

Circular dependencies occur when Service A depends on Service B, and Service B depends on Service A. NestJS will throw a runtime error when it detects this. The solution is to extract the shared logic into a third service or use events:

```typescript
// BAD — circular dependency
// BookingService depends on PaymentService
// PaymentService depends on BookingService (to update booking status after payment)

// GOOD — break the circle with events
// BookingService publishes 'booking.created' event
// PaymentService listens for 'booking.created' and processes payment
// PaymentService publishes 'payment.completed' event
// BookingService listens for 'payment.completed' and updates booking status
```

### Rule 4: Use `forwardRef()` Only as a Last Resort

NestJS provides `forwardRef()` to work around circular dependencies. Do not use it as a first solution — it is a band-aid that hides a design problem. If you find yourself reaching for `forwardRef()`, step back and redesign the dependency graph.

> **Key Term:** **Dependency Injection Container** — The component of a framework (like NestJS) that manages the creation, wiring, and lifecycle of injectable services. The container reads `@Injectable()` decorators and constructor parameters to automatically instantiate classes and inject their dependencies.

> **Checkpoint:** Look at a service class in your codebase. Count the number of constructor parameters. If it has more than five dependencies, the class is likely doing too much. Consider splitting it into smaller, focused services that each have two or three dependencies.


## Chapter Summary

| Concept | Key Takeaway |
|---------|-------------|
| **ESLint + Prettier** | ESLint catches logic bugs; Prettier handles formatting. Run both in CI so no human debates style. |
| **Three-Layer Architecture** | Controller → Service → Repository. Each layer has one job. Never let controllers talk to the database directly. |
| **Naming Conventions** | camelCase for variables/functions, PascalCase for classes/interfaces, UPPER_SNAKE for constants. Consistency matters more than preference. |
| **Error Handling** | Create a domain exception hierarchy. Map domain exceptions to HTTP status codes in a single exception filter. Never expose stack traces. |
| **Logging Standards** | Structured JSON logs with correlation IDs. Log at boundaries (incoming requests, outgoing calls, errors). Never log secrets or PII. |
| **Commit Messages** | Use Conventional Commits (feat/fix/chore). Explain WHY, not WHAT. Keep the subject under 72 characters. |
| **Code Review** | Review for correctness, security, and maintainability. Use a checklist. Keep PRs under 400 lines. |
| **Dependency Injection** | Let NestJS manage object creation. Program to interfaces. Avoid circular dependencies with events or mediators. |


> **Checkpoint:** Can you write an ESLint rule that enforces your team's naming convention? Can you create a custom exception filter that maps domain errors to HTTP responses? If yes, you have internalized this chapter.

---
