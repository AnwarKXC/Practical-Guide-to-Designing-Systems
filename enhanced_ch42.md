# Chapter 42: Testing Strategy — Proving Your Code Works

## Beyond "It Works on My Machine"

You have probably written a few Jest tests. Maybe you tested a utility function that adds two numbers, or a controller that returns a hardcoded list. Those are good starts. But testing a distributed system with multiple services, databases, message queues, and external payment APIs is a fundamentally different challenge.

In a monolith, a bug affects one process. In microservices, a bug in the Inventory Service can cascade: the Booking Service gets wrong availability data, the Payment Service charges for a room that does not exist, and the Notification Service sends a confirmation for a phantom booking. One untested edge case in the booking flow can silently corrupt inventory or double-charge customers at 1,666 bookings per second. At that rate, you create about 100,000 invalid records in a minute before anyone notices.

Testing is not about proving your code works. It is about proving it does not break in ways that cost money.

> **Analogy:** Think of testing like pre-flight checks for an airplane. A pilot does not skip the checklist because "the plane flew fine yesterday." They check the engines (unit tests), the instruments (integration tests), and the full takeoff-and-landing sequence (end-to-end tests) — every single time. But a good airline also runs wind-tunnel simulations (load tests), injects faults into training simulators (chaos tests), and verifies every bolt matches the blueprint (contract tests). The testing pyramid is your pre-flight checklist. Skipping a level does not save time; it creates risk that compounds at scale.

> **What If You Skip This?** Without a comprehensive testing strategy, your team makes changes with fear. Developers avoid refactoring because "it might break something." Deployments happen on Fridays only when the senior engineer is available. Bug reports come from customers, not from CI. Your system becomes a minefield where every commit is a gamble. At 100,000 bookings per minute, every gamble has six-figure consequences.

---

## The Testing Pyramid: How Many of Each?

The testing pyramid is a model for how many tests you should have at each level. The base (widest part) is unit tests — you want lots of these. The middle is integration tests — fewer, but critical. The top (narrowest part) is end-to-end tests — a handful that validate the full flow.

```
            /\
           /  \           End-to-End Tests
          / E2E\          5-15 tests | Minutes to run
         /------\
        /        \        Integration Tests
       / Integr.  \      50-150 tests | Seconds each
      /------------\
     /              \     Unit Tests
    / Unit Tests     \   500-2000+ tests | Milliseconds each
   /__________________\
```

> **Key Term:** **Testing Pyramid** — A strategy that recommends many fast unit tests, fewer integration tests, and very few end-to-end tests. The pyramid shape reflects both the quantity and the speed: unit tests are fast and numerous; E2E tests are slow and few. The ratios matter: for every E2E test, you should have roughly 10 integration tests and 100 unit tests.

### Concrete Numbers for Our Booking System

Here is what a well-tested Global Booking System looks like in practice:

| Level | Count | Speed | What It Tests | Cost of Failure | Example |
|---|---|---|---|---|---|
| Unit | 1,200+ | 2-5 ms each | A single function or class in isolation | Low — caught before code review | `BookingService.calculatePrice()` returns correct total |
| Integration | 80-120 | 1-5 sec each | Two or more components working together | Medium — caught in CI pipeline | POST `/api/v1/bookings` writes correct row to PostgreSQL |
| E2E | 8-12 | 30-120 sec each | The complete user journey across services | High — caught late, closest to production | Search -> Book -> Pay -> Confirm -> Email sent |
| Contract | 30-50 | 1-2 sec each | API shape agreements between services | Medium — prevents integration failures | Booking Service expects `{ available: boolean }` from Inventory |
| Load | 3-5 | 30-60 min each | System behavior under peak throughput | Critical — capacity planning depends on this | 1,666 req/sec sustained for 30 minutes |
| Chaos | 5-10 | 5-15 min each | Resilience when components fail | Critical — validates fault tolerance | Kill one Kafka broker during peak load |

If you invert the pyramid (few unit tests, many E2E tests), your CI pipeline takes 45 minutes, tests fail intermittently because of network flakiness, and developers stop trusting the test suite. They start ignoring failures. That is worse than having no tests at all.

### Why This Shape?

The pyramid shape is not arbitrary. It is driven by three economic forces:

1. **Feedback speed.** A unit test tells you about a bug in 5 milliseconds. An E2E test tells you in 2 minutes. When a developer has to wait 2 minutes to learn they made a typo, they stop running tests.

2. **Failure isolation.** When a unit test fails, you know exactly which function broke. When an E2E test fails, it could be the API Gateway, the Booking Service, the database schema, the Kafka topic, or a DNS resolution timeout. Debugging takes 10x longer.

3. **Maintenance cost.** Unit tests rarely break when you refactor a different service. E2E tests break when anyone changes anything. A team spending 30% of their time fixing flaky E2E tests is a team that ships slowly.

> **Common Mistake:** Teams often build an "ice cream cone" — many E2E tests, few unit tests, and almost no integration tests. This happens because E2E tests feel reassuring ("we tested the whole thing!") while unit tests feel trivial ("who cares if `add(2,3)` returns 5?"). The truth is the opposite. The trivial-seeming unit test that verifies your compensating transaction logic prevents a production incident worth $200,000. The reassuring E2E test that takes 3 minutes to run teaches developers to push code without running tests first.

---

## Level 1: Unit Tests — Fast, Isolated, Numerous

A unit test verifies one function or one class in isolation. All external dependencies (database, HTTP clients, Kafka) are replaced with mocks. If a unit test fails, you know exactly which piece of logic is broken.

### Mocking Dependencies in NestJS

NestJS uses dependency injection, which makes mocking straightforward. The key principle is: you never test the database or HTTP layer in a unit test. You test the **business logic decisions** your code makes.

Here is the pattern for creating a testable NestJS module:

```typescript
// booking.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { BookingService } from './booking.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentService } from '../payment/payment.service';
import { PrismaService } from '../prisma/prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { BookingStatus } from '@prisma/client';

describe('BookingService', () => {
  // STEP 1: Declare the service under test and ALL its dependencies.
  // In a real service, BookingService depends on 4 external systems.
  // In a unit test, every single one is a mock.
  let service: BookingService;
  let inventoryService: jest.Mocked<InventoryService>;
  let paymentService: jest.Mocked<PaymentService>;
  let prisma: jest.Mocked<PrismaService>;
  let kafkaProducer: jest.Mocked<KafkaProducerService>;

  beforeEach(async () => {
    // STEP 2: Create mock implementations for each dependency.
    // jest.fn() creates a spy that records calls and returns undefined
    // by default. We program specific return values per test.
    const mockInventory = {
      checkAvailability: jest.fn(),
      createHold: jest.fn(),
      confirmHold: jest.fn(),
      releaseHold: jest.fn(),
    };

    const mockPayment = {
      processPayment: jest.fn(),
      refundPayment: jest.fn(),
    };

    const mockPrisma = {
      booking: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrisma)),
    };

    const mockKafka = {
      emit: jest.fn(),
    };

    // STEP 3: Use NestJS Test utilities for proper DI wiring.
    // This creates a real NestJS module but with mock providers.
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        { provide: InventoryService, useValue: mockInventory },
        { provide: PaymentService, useValue: mockPayment },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: KafkaProducerService, useValue: mockKafka },
      ],
    }).compile();

    service = module.get<BookingService>(BookingService);
    inventoryService = module.get(InventoryService);
    paymentService = module.get(PaymentService);
    prisma = module.get(PrismaService);
    kafkaProducer = module.get(KafkaProducerService);
  });

  // --- Happy Path Tests ---

  describe('createBooking - happy path', () => {
    const mockDto = {
      userId: 'user-123',
      resourceType: 'hotel_room',
      resourceId: 'room-456',
      checkIn: new Date('2026-03-01'),
      checkOut: new Date('2026-03-05'),
      guestCount: 2,
      idempotencyKey: 'idem-key-789',
    };

    it('should create a confirmed booking when all steps succeed', async () => {
      // Program mocks to simulate the happy path
      inventoryService.checkAvailability.mockResolvedValue(true);
      inventoryService.createHold.mockResolvedValue({
        holdId: 'hold-001',
        expiresAt: new Date(Date.now() + 600_000),
      });
      paymentService.processPayment.mockResolvedValue({
        paymentId: 'pay-001',
        status: 'captured',
        amount: 800_00, // $800.00 in cents
      });
      prisma.booking.create.mockResolvedValue({
        id: 'booking-001',
        status: BookingStatus.CONFIRMED,
        userId: 'user-123',
        totalAmount: 800_00,
      });

      const result = await service.createBooking(mockDto);

      // Verify the result
      expect(result.status).toBe('confirmed');
      expect(result.bookingId).toBe('booking-001');

      // Verify the orchestration sequence
      expect(inventoryService.checkAvailability).toHaveBeenCalledWith(
        'hotel_room',
        'room-456',
        mockDto.checkIn,
        mockDto.checkOut,
      );
      expect(inventoryService.createHold).toHaveBeenCalledTimes(1);
      expect(paymentService.processPayment).toHaveBeenCalledTimes(1);
      expect(prisma.booking.create).toHaveBeenCalledTimes(1);

      // Verify domain event was published
      expect(kafkaProducer.emit).toHaveBeenCalledWith(
        'booking.confirmed',
        expect.objectContaining({
          bookingId: 'booking-001',
          userId: 'user-123',
        }),
      );
    });
  });

  // --- Failure Path Tests (the ones that actually prevent production incidents) ---

  describe('createBooking - failure paths', () => {
    const mockDto = {
      userId: 'user-123',
      resourceType: 'hotel_room',
      resourceId: 'room-456',
      checkIn: new Date('2026-03-01'),
      checkOut: new Date('2026-03-05'),
      guestCount: 2,
      idempotencyKey: 'idem-key-789',
    };

    it('should throw when room is not available', async () => {
      // The room is sold out
      inventoryService.checkAvailability.mockResolvedValue(false);

      await expect(service.createBooking(mockDto)).rejects.toThrow(
        'Resource not available for the requested dates',
      );

      // Verify NO downstream calls were made
      expect(inventoryService.createHold).not.toHaveBeenCalled();
      expect(paymentService.processPayment).not.toHaveBeenCalled();
      expect(prisma.booking.create).not.toHaveBeenCalled();
      // This assertion is critical. If the service accidentally calls
      // processPayment when inventory is unavailable, we charge the
      // customer for a room that does not exist.
    });

    it('should release hold when payment fails', async () => {
      // Inventory succeeds, payment fails
      inventoryService.checkAvailability.mockResolvedValue(true);
      inventoryService.createHold.mockResolvedValue({
        holdId: 'hold-001',
        expiresAt: new Date(Date.now() + 600_000),
      });
      paymentService.processPayment.mockRejectedValue(
        new Error('Card declined'),
      );

      await expect(service.createBooking(mockDto)).rejects.toThrow(
        'Card declined',
      );

      // THE CRITICAL ASSERTION: the hold must be released
      expect(inventoryService.releaseHold).toHaveBeenCalledWith('hold-001');
      // Without this test, a payment failure could leave inventory
      // locked forever. At 1,666 bookings/second, hundreds of rooms
      // become phantom-locked within minutes.
    });

    it('should still release hold even if releaseHold itself throws', async () => {
      // This tests a double-failure scenario:
      // 1. Payment fails (primary error)
      // 2. releaseHold also fails (secondary error)
      // The service must still propagate the payment error to the caller.
      inventoryService.checkAvailability.mockResolvedValue(true);
      inventoryService.createHold.mockResolvedValue({
        holdId: 'hold-001',
        expiresAt: new Date(Date.now() + 600_000),
      });
      paymentService.processPayment.mockRejectedValue(
        new Error('Card declined'),
      );
      inventoryService.releaseHold.mockRejectedValue(
        new Error('Inventory service timeout'),
      );

      // The original error (Card declined) must still propagate
      await expect(service.createBooking(mockDto)).rejects.toThrow(
        'Card declined',
      );

      // releaseHold was attempted (even though it failed)
      expect(inventoryService.releaseHold).toHaveBeenCalledWith('hold-001');
      // The orphaned hold must be logged for manual cleanup.
      // In production, a background reconciliation job picks these up.
    });

    it('should handle idempotent duplicate requests', async () => {
      // Simulate a duplicate request (same idempotency key)
      prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-001',
        idempotencyKey: 'idem-key-789',
        status: BookingStatus.CONFIRMED,
        totalAmount: 800_00,
      });

      const result = await service.createBooking(mockDto);

      // Should return the existing booking, not create a new one
      expect(result.bookingId).toBe('booking-001');
      expect(inventoryService.checkAvailability).not.toHaveBeenCalled();
      expect(paymentService.processPayment).not.toHaveBeenCalled();
      // Without this test, a network retry from the client could
      // double-book and double-charge the customer.
    });
  });
});
```

Let us unpack what makes this valuable:

1. **Speed.** Every test runs in under 10 milliseconds. No database, no network, no Kafka. Just JavaScript logic in memory. The entire suite of 20+ tests finishes in under a second.

2. **Precision.** If a test fails, you know the bug is in `BookingService.createBooking()`, not in PostgreSQL, not in Stripe, not in Kafka. The blast radius of failure is exactly one function.

3. **Saga verification.** The failure path tests verify compensating transactions — that when payment fails, the inventory hold is released. This is the kind of edge case that causes real production incidents if left untested.

4. **Double-failure handling.** The test that verifies behavior when both payment AND hold-release fail catches a class of bugs that only appear under extreme conditions — exactly the conditions a 100K-bookings/minute system will encounter.

> **Key Term:** **Test Double** — A generic term for any object that replaces a real dependency in a test. The four types are: **stub** (returns canned data), **mock** (records calls for verification), **spy** (wraps the real object and records calls), and **fake** (a working but simplified implementation, like an in-memory database). Jest's `jest.fn()` creates objects that are both stubs and mocks simultaneously.

### What to Test vs. What Not to Test

A common question: "Should I write unit tests for every method?" No. Focus on:

**Test these aggressively:**
- Business logic with branching (if/else, switch, error handling)
- Compensating transactions (saga rollbacks)
- Data transformations (DTOs to entities, price calculations)
- Edge cases (empty arrays, null values, boundary dates, negative amounts)
- Idempotency logic
- Retry logic (exponential backoff boundaries)

**Skip these in unit tests (test them in integration instead):**
- Simple CRUD pass-throughs that just call `prisma.booking.create(data)`
- Controller methods that only delegate to a service
- Configuration files
- Type definitions

> **Checkpoint:** Before moving on, count your service's constructor dependencies. Each one becomes a mock in your unit tests. If `BookingService` has 8 constructor parameters, you need 8 mocks. If that feels like a lot, it is a code smell — your service might be doing too much. Consider splitting it. Testability is a design signal.

---
## Testing Prisma Queries — The Layer Between Logic and Data

Unit tests mock Prisma entirely. That is fine for testing business logic. But at some point, you need to verify that your Prisma queries actually produce the correct SQL, that your `where` clauses filter correctly, and that your `include` relations load the right nested data. This is where Prisma-specific testing comes in.

There are two approaches: mocking with `jest-mock-extended` for speed, and testing against a real database with transaction rollback for accuracy.

### Approach 1: Mock Prisma with jest-mock-extended

The `jest-mock-extended` library generates a fully typed mock of any interface or class. Unlike hand-written mocks where you might forget a method, this library creates stubs for every single method on the Prisma client.

```typescript
// booking.repository.spec.ts
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient, Booking, BookingStatus } from '@prisma/client';
import { BookingRepository } from './booking.repository';

describe('BookingRepository', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let repository: BookingRepository;

  beforeEach(() => {
    // mockDeep creates a mock with EVERY method on PrismaClient,
    // including nested properties like prisma.booking.findMany.
    // Hand-writing this would take 200+ lines. mockDeep does it in one.
    prisma = mockDeep<PrismaClient>();
    repository = new BookingRepository(prisma);
  });

  describe('findBookingsByUser', () => {
    it('should query with correct filters and include relations', async () => {
      const mockBookings: Booking[] = [
        {
          id: 'booking-001',
          userId: 'user-123',
          status: BookingStatus.CONFIRMED,
          resourceType: 'hotel_room',
          resourceId: 'room-456',
          checkIn: new Date('2026-03-01'),
          checkOut: new Date('2026-03-05'),
          totalAmount: 80000,
          currency: 'USD',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      // Program the mock to return our test data
      prisma.booking.findMany.mockResolvedValue(mockBookings);

      const result = await repository.findBookingsByUser('user-123', {
        status: BookingStatus.CONFIRMED,
        fromDate: new Date('2026-01-01'),
      });

      // THE KEY ASSERTION: verify the exact query shape Prisma receives.
      // This catches bugs where the WHERE clause is wrong, the ORDER BY
      // is missing, or the include relations are incomplete.
      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          status: BookingStatus.CONFIRMED,
          checkIn: { gte: new Date('2026-01-01') },
        },
        include: {
          payments: true,
          room: { include: { hotel: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('booking-001');
    });

    it('should apply pagination correctly', async () => {
      prisma.booking.findMany.mockResolvedValue([]);

      await repository.findBookingsByUser('user-123', {
        page: 3,
        pageSize: 20,
      });

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 40,   // (page 3 - 1) * 20
          take: 20,
        }),
      );
    });
  });

  describe('createBookingWithPayment', () => {
    it('should use a transaction for booking + payment creation', async () => {
      // Verify that the repository wraps both writes in a transaction.
      // If it does not, a crash between the two writes would leave
      // a booking without a payment record — a billing nightmare.
      prisma.$transaction.mockImplementation(async (callback) => {
        return callback(prisma);
      });

      prisma.booking.create.mockResolvedValue({
        id: 'booking-001',
        status: BookingStatus.PENDING,
      } as any);

      prisma.payment.create.mockResolvedValue({
        id: 'payment-001',
        bookingId: 'booking-001',
      } as any);

      await repository.createBookingWithPayment({
        userId: 'user-123',
        totalAmount: 80000,
        paymentToken: 'tok_visa',
      });

      // Both creates must happen inside $transaction
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.booking.create).toHaveBeenCalledTimes(1);
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });
  });
});
```

> **Common Mistake:** Mocking Prisma without verifying the query shape. Developers often mock `prisma.booking.findMany` to return test data and then only assert on the return value. This proves nothing about the query itself. The real value is asserting what arguments `findMany` received. If your WHERE clause is `{ userId: userId }` instead of `{ userId: userId, deletedAt: null }`, you are returning soft-deleted bookings. The mock-based assertion catches this.

### Approach 2: Real Database with Transaction Rollback

Mock-based tests verify query shapes but not query results. They cannot catch Prisma schema mismatches, incorrect JOIN behavior, or database-level constraints. For that, you need a real database.

The transaction rollback pattern runs each test inside a database transaction that is rolled back after the test completes. The database is never modified, so tests do not interfere with each other.

```typescript
// booking.repository.integration.spec.ts
import { PrismaClient } from '@prisma/client';

describe('BookingRepository (real database)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // Connect to a dedicated test database.
    // NEVER use the production or development database for tests.
    prisma = new PrismaClient({
      datasources: {
        db: { url: process.env.TEST_DATABASE_URL },
      },
    });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // IMPORTANT: Unlike TypeORM or Knex, Prisma does NOT support the
  // "wrap each test in a transaction and rollback" pattern. Prisma's
  // interactive transactions ($transaction) commit or rollback within
  // the callback — you cannot extract the transactional client and
  // use it outside the callback. The transaction completes as soon
  // as the callback resolves.
  //
  // Instead, use explicit cleanup after each test:
  afterEach(async () => {
    // Delete in reverse order of foreign key dependencies
    await prisma.payment.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.user.deleteMany({});
  });

  it('should enforce unique idempotency key constraint', async () => {
    // Seed a user for the foreign key
    const user = await prisma.user.create({
      data: { id: 'user-001', email: 'alice@example.com', name: 'Alice' },
    });

    // Create the first booking
    await prisma.booking.create({
      data: {
        userId: user.id,
        idempotencyKey: 'idem-key-001',
        status: 'CONFIRMED',
        resourceType: 'hotel_room',
        resourceId: 'room-100',
        totalAmount: 80000,
        currency: 'USD',
        checkIn: new Date('2026-03-01'),
        checkOut: new Date('2026-03-05'),
      },
    });

    // Attempt a duplicate — the database UNIQUE constraint must reject it
    await expect(
      prisma.booking.create({
        data: {
          userId: user.id,
          idempotencyKey: 'idem-key-001', // same key
          status: 'CONFIRMED',
          resourceType: 'hotel_room',
          resourceId: 'room-200',
          totalAmount: 60000,
          currency: 'USD',
          checkIn: new Date('2026-04-01'),
          checkOut: new Date('2026-04-05'),
        },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    // This test verifies that your Prisma schema has the correct
    // @@unique([idempotencyKey]) annotation. A mock cannot catch this.
  });

  it('should cascade delete payments when booking is deleted', async () => {
    const user = await prisma.user.create({
      data: { id: 'user-002', email: 'bob@example.com', name: 'Bob' },
    });

    const booking = await prisma.booking.create({
      data: {
        userId: user.id,
        idempotencyKey: 'idem-key-002',
        status: 'CONFIRMED',
        resourceType: 'hotel_room',
        resourceId: 'room-300',
        totalAmount: 120000,
        currency: 'USD',
        checkIn: new Date('2026-05-01'),
        checkOut: new Date('2026-05-07'),
        payments: {
          create: {
            amount: 120000,
            currency: 'USD',
            status: 'CAPTURED',
            provider: 'stripe',
            providerPaymentId: 'pi_test_001',
          },
        },
      },
    });

    await prisma.booking.delete({ where: { id: booking.id } });

    const orphanedPayments = await prisma.payment.findMany({
      where: { bookingId: booking.id },
    });

    expect(orphanedPayments).toHaveLength(0);
    // If the cascade is not configured in the Prisma schema,
    // this delete would either fail with a foreign key violation
    // or leave orphaned payment records in the database.
  });
});
```

> **Analogy:** Think of mock-based Prisma tests like checking your GPS route before driving. You verify the directions look correct. Real-database tests are like actually driving the route. The GPS might say "turn left on Main Street," but only driving it reveals that Main Street is one-way in the wrong direction. Both checks are valuable, but they catch different classes of problems.

---

## Level 2: Integration Testing with Testcontainers

Integration tests need real infrastructure: a MySQL database, a Redis cache, a Kafka broker, an Elasticsearch cluster. Spinning these up manually is tedious and error-prone. Testcontainers solves this by launching real Docker containers programmatically during your test run.

### What Are Testcontainers?

Testcontainers is a library that starts Docker containers from your test code, waits for them to be ready, and tears them down when tests finish. Each test run gets fresh, isolated containers.

```typescript
// testcontainers.setup.ts
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

export class TestInfrastructure {
  private mysqlContainer: StartedTestContainer;
  private redisContainer: StartedTestContainer;
  private kafkaContainer: StartedTestContainer;
  private elasticContainer: StartedTestContainer;

  async startAll(): Promise<void> {
    // Start all containers IN PARALLEL.
    // Sequential startup takes 60+ seconds.
    // Parallel startup takes ~20 seconds (bounded by the slowest container).
    const [mysql, redis, kafka, elastic] = await Promise.all([
      this.startMySQL(),
      this.startRedis(),
      this.startKafka(),
      this.startElasticsearch(),
    ]);

    this.mysqlContainer = mysql;
    this.redisContainer = redis;
    this.kafkaContainer = kafka;
    this.elasticContainer = elastic;
  }

  private async startMySQL(): Promise<StartedTestContainer> {
    return new GenericContainer('mysql:8.0')
      .withEnvironment({
        MYSQL_ROOT_PASSWORD: 'test_password',
        MYSQL_DATABASE: 'booking_test',
      })
      .withExposedPorts(3306)
      // Wait for MySQL to actually accept connections, not just start.
      // Without this, tests begin before the database is ready and fail
      // with "Connection refused."
      .withWaitStrategy(
        Wait.forLogMessage(/ready for connections.*port: 3306/)
      )
      .withStartupTimeout(60_000)
      .start();
  }

  private async startRedis(): Promise<StartedTestContainer> {
    return new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
  }

  private async startKafka(): Promise<StartedTestContainer> {
    // Kafka requires careful configuration for container mode.
    // KRaft mode (no ZooKeeper) simplifies this significantly.
    return new GenericContainer('confluentinc/cp-kafka:7.5.0')
      .withEnvironment({
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_LISTENERS:
          'PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        CLUSTER_ID: 'test-cluster-id-00001',
      })
      .withExposedPorts(9092)
      .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
      .withStartupTimeout(90_000)
      .start();
  }

  private async startElasticsearch(): Promise<StartedTestContainer> {
    return new GenericContainer('elasticsearch:8.11.0')
      .withEnvironment({
        'discovery.type': 'single-node',
        'xpack.security.enabled': 'false',
        ES_JAVA_OPTS: '-Xms512m -Xmx512m',
      })
      .withExposedPorts(9200)
      .withWaitStrategy(Wait.forHttp('/_cluster/health', 9200))
      .withStartupTimeout(120_000)
      .start();
  }

  // Expose connection URLs for the test NestJS app to use
  getMySQLUrl(): string {
    const host = this.mysqlContainer.getHost();
    const port = this.mysqlContainer.getMappedPort(3306);
    return `mysql://root:test_password@${host}:${port}/booking_test`;
  }

  getRedisUrl(): string {
    const host = this.redisContainer.getHost();
    const port = this.redisContainer.getMappedPort(6379);
    return `redis://${host}:${port}`;
  }

  getKafkaBroker(): string {
    const host = this.kafkaContainer.getHost();
    const port = this.kafkaContainer.getMappedPort(9092);
    return `${host}:${port}`;
  }

  getElasticsearchUrl(): string {
    const host = this.elasticContainer.getHost();
    const port = this.elasticContainer.getMappedPort(9200);
    return `http://${host}:${port}`;
  }

  async stopAll(): Promise<void> {
    await Promise.all([
      this.mysqlContainer?.stop(),
      this.redisContainer?.stop(),
      this.kafkaContainer?.stop(),
      this.elasticContainer?.stop(),
    ]);
  }
}
```

### Full NestJS Integration Test with Testcontainers

Now wire the containers into a real NestJS application test:

```typescript
// booking-flow.integration.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { TestInfrastructure } from './testcontainers.setup';

describe('Booking Flow (Integration)', () => {
  let app: INestApplication;
  let infra: TestInfrastructure;

  beforeAll(async () => {
    // Step 1: Start real infrastructure containers
    infra = new TestInfrastructure();
    await infra.startAll();

    // Step 2: Override environment variables to point at the containers
    process.env.DATABASE_URL = infra.getMySQLUrl();
    process.env.REDIS_URL = infra.getRedisUrl();
    process.env.KAFKA_BROKERS = infra.getKafkaBroker();
    process.env.ELASTICSEARCH_URL = infra.getElasticsearchUrl();

    // Step 3: Boot the full NestJS application
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Step 4: Run database migrations against the test container
    // This verifies that your migrations work on a clean database.
    // Executes: npx prisma migrate deploy
  }, 120_000); // 2-minute timeout for container startup

  afterAll(async () => {
    await app?.close();
    await infra?.stopAll();
  });

  it('should complete the full booking lifecycle', async () => {
    // 1. Check availability
    const availResponse = await request(app.getHttpServer())
      .get('/api/v1/inventory/availability')
      .query({
        resourceType: 'hotel_room',
        resourceId: 'room-456',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
      })
      .expect(200);

    expect(availResponse.body.data.available).toBe(true);

    // 2. Create booking
    const bookingResponse = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test-jwt-token')
      .set('Idempotency-Key', 'integration-test-key-001')
      .send({
        bookingType: 'hotel',
        resourceType: 'hotel_room',
        resourceId: 'room-456',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
        guestCount: 2,
        totalAmount: 80000,
        currency: 'USD',
      })
      .expect(201);

    const bookingId = bookingResponse.body.data.bookingId;
    expect(bookingId).toBeDefined();

    // 3. Verify the booking exists in the database
    const getResponse = await request(app.getHttpServer())
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', 'Bearer test-jwt-token')
      .expect(200);

    expect(getResponse.body.data.status).toBe('confirmed');

    // 4. Verify inventory was decremented
    const postBookAvail = await request(app.getHttpServer())
      .get('/api/v1/inventory/availability')
      .query({
        resourceType: 'hotel_room',
        resourceId: 'room-456',
        checkIn: '2026-03-01',
        checkOut: '2026-03-05',
      })
      .expect(200);

    // If only one room existed, it should now be unavailable
    // This verifies the database write from the booking service
    // actually affected the inventory table.
  });

  it('should reject duplicate idempotency keys', async () => {
    const idempotencyKey = 'duplicate-test-key-001';

    // First request succeeds
    await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test-jwt-token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ /* booking details */ })
      .expect(201);

    // Second request with same key returns the same result, not a new booking
    const duplicateResponse = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test-jwt-token')
      .set('Idempotency-Key', idempotencyKey)
      .send({ /* same booking details */ })
      .expect(200); // 200, not 201 — it was not created again

    // Both responses should reference the same bookingId
  });
});
```

> **What If You Skip This?** Without integration tests using real containers, you discover infrastructure bugs in staging or production. The Redis serialization format changed between versions. The Kafka topic auto-creation setting is wrong. The Elasticsearch mapping does not match your Prisma schema. These are not logic bugs; they are wiring bugs. Unit tests cannot catch them because unit tests do not use real infrastructure. Testcontainers catch them in CI, before the code ever leaves the developer's branch.

---

## Contract Testing with Pact

Integration tests verify that your service works with its own database. Contract tests verify that two services agree on what they send and receive from each other. This is critical in microservices where different teams own different services and deploy independently.

### The Problem

The Booking Service calls the Inventory Service's `/api/v1/inventory/availability` endpoint. The Booking team writes integration tests that mock the Inventory response. The Inventory team writes integration tests for their own endpoint. Both pass. But what happens when the Inventory team changes the response from `{ available: true }` to `{ isAvailable: true }`? The Inventory tests pass (they test the new shape). The Booking tests pass (they mock the old shape). Production breaks.

Contract testing prevents this by creating a shared agreement between the consumer and the provider.

### Consumer-Driven Contracts with Pact

```typescript
// booking-service/tests/contracts/inventory.consumer.pact.spec.ts
import { PactV3, MatchersV3 } from '@pact-foundation/pact';
import { InventoryClient } from '../../src/clients/inventory.client';

const { like, boolean, string, integer } = MatchersV3;

describe('Booking Service <-> Inventory Service Contract', () => {
  const provider = new PactV3({
    consumer: 'BookingService',
    provider: 'InventoryService',
    dir: './pacts', // Where the contract file is saved
  });

  describe('checkAvailability', () => {
    it('should return availability status for a hotel room', async () => {
      // STEP 1: Define what the consumer EXPECTS from the provider.
      // This is the "contract" — the provider must fulfill it.
      await provider
        .given('room-456 is available for 2026-03-01 to 2026-03-05')
        .uponReceiving('a request to check room availability')
        .withRequest({
          method: 'GET',
          path: '/api/v1/inventory/availability',
          query: {
            resourceType: 'hotel_room',
            resourceId: 'room-456',
            checkIn: '2026-03-01',
            checkOut: '2026-03-05',
          },
        })
        .willRespondWith({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: {
            success: boolean(true),
            data: {
              available: boolean(true),
              resourceType: string('hotel_room'),
              resourceId: string('room-456'),
              remainingQuantity: integer(5),
            },
          },
        });

      // STEP 2: Run the consumer code against the Pact mock server.
      // Pact starts a local HTTP server that behaves like the Inventory
      // Service according to the contract above.
      await provider.executeTest(async (mockServer) => {
        const client = new InventoryClient(mockServer.url);
        const result = await client.checkAvailability(
          'hotel_room', 'room-456', '2026-03-01', '2026-03-05'
        );

        expect(result.available).toBe(true);
        expect(result.remainingQuantity).toBeGreaterThan(0);
      });

      // STEP 3: Pact generates a contract file (a JSON "pact").
      // This file is shared with the Inventory Service team.
      // They run it against their REAL API to verify compliance.
    });

    it('should return unavailable when room is sold out', async () => {
      await provider
        .given('room-789 is sold out for 2026-03-10 to 2026-03-12')
        .uponReceiving('a request for a sold-out room')
        .withRequest({
          method: 'GET',
          path: '/api/v1/inventory/availability',
          query: {
            resourceType: 'hotel_room',
            resourceId: 'room-789',
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
          },
        })
        .willRespondWith({
          status: 200,
          body: {
            success: boolean(true),
            data: {
              available: boolean(false),
              resourceType: string('hotel_room'),
              resourceId: string('room-789'),
              remainingQuantity: integer(0),
            },
          },
        });

      await provider.executeTest(async (mockServer) => {
        const client = new InventoryClient(mockServer.url);
        const result = await client.checkAvailability(
          'hotel_room', 'room-789', '2026-03-10', '2026-03-12'
        );
        expect(result.available).toBe(false);
      });
    });
  });
});
```

### Provider Verification

The Inventory Service team runs the generated pact against their real API:

```typescript
// inventory-service/tests/contracts/inventory.provider.pact.spec.ts
import { Verifier } from '@pact-foundation/pact';

describe('Inventory Service Provider Verification', () => {
  it('should fulfill the BookingService contract', async () => {
    const verifier = new Verifier({
      providerBaseUrl: 'http://localhost:3001',
      pactUrls: ['./pacts/BookingService-InventoryService.json'],
      // OR: fetch from a Pact Broker (a shared contract repository)
      // pactBrokerUrl: 'https://pact-broker.internal.company.com',

      stateHandlers: {
        // Pact sends the "given" state from the consumer contract.
        // The provider sets up the database to match that state.
        'room-456 is available for 2026-03-01 to 2026-03-05': async () => {
          await seedInventory('room-456', {
            available: true,
            quantity: 5,
            checkIn: '2026-03-01',
            checkOut: '2026-03-05',
          });
        },
        'room-789 is sold out for 2026-03-10 to 2026-03-12': async () => {
          await seedInventory('room-789', {
            available: false,
            quantity: 0,
            checkIn: '2026-03-10',
            checkOut: '2026-03-12',
          });
        },
      },
    });

    await verifier.verifyProvider();
    // If the Inventory Service response does not match the contract
    // (e.g., field "available" was renamed to "isAvailable"),
    // this verification FAILS, and the Inventory team knows they
    // are about to break the Booking Service.
  });
});
```

> **Analogy:** Contract testing is like a lease agreement between a landlord and a tenant. The tenant (consumer) writes down what they expect: "The apartment will have running water, electricity, and a working lock on the front door." The landlord (provider) signs the lease, agreeing to provide exactly those things. If the landlord removes the lock, the lease is violated — even if the landlord thinks "nobody uses that lock anyway." The contract file is the lease. The Pact Broker is the property management company that holds copies for both parties.

---

## Level 3: E2E Testing the Booking Flow

End-to-end tests simulate real user journeys across the entire system. They are the most expensive tests to write and maintain, so you write very few of them. Each one should cover a critical business flow that, if broken, would cost the company money or customer trust.

### The Full Booking Lifecycle Test

```typescript
// tests/e2e/booking-lifecycle.e2e.spec.ts
import * as request from 'supertest';

describe('Booking Lifecycle (E2E)', () => {
  const API_BASE = process.env.E2E_API_URL || 'http://localhost:3000';
  let authToken: string;
  let bookingId: string;
  let referenceCode: string;

  beforeAll(async () => {
    // Authenticate a test user and get a JWT
    const loginResponse = await request(API_BASE)
      .post('/api/v1/auth/login')
      .send({
        email: 'e2e-test-user@example.com',
        password: 'E2E_Test_Password_123!',
      })
      .expect(200);

    authToken = loginResponse.body.data.accessToken;
  });

  it('Step 1: Search for available hotels', async () => {
    const response = await request(API_BASE)
      .get('/api/v1/search/hotels')
      .query({
        destination: 'New York',
        checkIn: '2026-06-01',
        checkOut: '2026-06-05',
        guests: 2,
        rooms: 1,
      })
      .expect(200);

    expect(response.body.data.hotels.length).toBeGreaterThan(0);
    expect(response.body.data.hotels[0]).toHaveProperty('hotelId');
    expect(response.body.data.hotels[0]).toHaveProperty('pricePerNight');
    expect(response.body.data.hotels[0]).toHaveProperty('available', true);
  });

  it('Step 2: Check specific room availability', async () => {
    const response = await request(API_BASE)
      .get('/api/v1/inventory/availability')
      .query({
        resourceType: 'hotel_room',
        resourceId: 'e2e-room-001',
        checkIn: '2026-06-01',
        checkOut: '2026-06-05',
      })
      .expect(200);

    expect(response.body.data.available).toBe(true);
  });

  it('Step 3: Create a booking', async () => {
    const response = await request(API_BASE)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${authToken}`)
      .set('Idempotency-Key', `e2e-test-${Date.now()}`)
      .send({
        bookingType: 'hotel',
        resourceType: 'hotel_room',
        resourceId: 'e2e-room-001',
        checkIn: '2026-06-01',
        checkOut: '2026-06-05',
        guestCount: 2,
        totalAmount: 120000,
        currency: 'USD',
        paymentMethod: {
          type: 'credit_card',
          provider: 'stripe',
          token: 'tok_visa_e2e_test',
        },
      })
      .expect(201);

    bookingId = response.body.data.bookingId;
    referenceCode = response.body.data.referenceCode;

    expect(bookingId).toBeDefined();
    expect(referenceCode).toMatch(/^HT-\d{8}-\d+$/);
    expect(response.body.data.status).toBe('confirmed');
  });

  it('Step 4: Verify booking confirmation', async () => {
    const response = await request(API_BASE)
      .get(`/api/v1/bookings/${bookingId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .expect(200);

    expect(response.body.data.status).toBe('confirmed');
    expect(response.body.data.totalAmount).toBe(120000);
    expect(response.body.data.checkIn).toBe('2026-06-01');
    expect(response.body.data.checkOut).toBe('2026-06-05');
  });

  it('Step 5: Cancel the booking', async () => {
    const response = await request(API_BASE)
      .post(`/api/v1/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        reason: 'user_cancelled',
        reasonNotes: 'E2E test cleanup',
      })
      .expect(200);

    expect(response.body.data.status).toBe('cancelled');
    expect(response.body.data.refund).toBeDefined();
    expect(response.body.data.refund.amount).toBe(120000);
  });

  it('Step 6: Verify inventory is restored after cancellation', async () => {
    // Wait briefly for async inventory release to propagate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const response = await request(API_BASE)
      .get('/api/v1/inventory/availability')
      .query({
        resourceType: 'hotel_room',
        resourceId: 'e2e-room-001',
        checkIn: '2026-06-01',
        checkOut: '2026-06-05',
      })
      .expect(200);

    expect(response.body.data.available).toBe(true);
    // The room should be available again because the booking was cancelled.
    // This verifies the compensating transaction (inventory release)
    // that runs when a booking is cancelled. If this fails, cancelled
    // bookings permanently reduce inventory — a silent revenue leak.
  });
});
```

> **Production War Story:** A travel platform skipped the "verify inventory is restored after cancellation" step in their E2E tests. Everything else passed. Six months later, they discovered that 3% of cancelled bookings were not releasing inventory. Over those months, approximately 2,100 room-nights became phantom-locked. The hotel partners could not sell those rooms. The fix was a one-line bug in the saga's compensating transaction. The cost was six months of lost revenue for partner hotels and a damaged business relationship. One additional E2E assertion would have caught this on day one.

---

## Load Testing with k6

Functional tests prove correctness. Load tests prove the system can handle the target throughput of 100,000 bookings per minute (1,666 per second) without degrading.

### Why k6?

k6 is an open-source load testing tool that uses JavaScript for test scripts, produces real-time metrics, and handles high concurrency efficiently. Unlike JMeter (GUI-heavy, XML-based), k6 scripts live in your codebase and run in CI.

### The Booking Endpoint Load Test

```javascript
// tests/load/booking-load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics for business-level monitoring
const bookingSuccessRate = new Rate('booking_success_rate');
const bookingDuration = new Trend('booking_duration_ms');

export const options = {
  // Ramp-up pattern that simulates realistic traffic growth
  stages: [
    { duration: '2m', target: 50 },     // Warmup: 0 to 50 VUs
    { duration: '5m', target: 200 },    // Ramp: 50 to 200 VUs
    { duration: '10m', target: 1000 },  // Peak: 200 to 1000 VUs
    { duration: '15m', target: 1666 },  // Full load: 1666 concurrent users
    { duration: '5m', target: 500 },    // Cool down: back to 500
    { duration: '3m', target: 0 },      // Wind down: to zero
  ],

  thresholds: {
    // These thresholds are pass/fail criteria.
    // If any threshold is breached, k6 exits with a non-zero code,
    // which fails the CI pipeline.
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    // 95th percentile under 500ms, 99th under 1500ms.
    // If 5% of requests take longer than 500ms under peak load,
    // the system fails the load test.

    booking_success_rate: ['rate>0.995'],
    // 99.5% of bookings must succeed.
    // At 1,666/sec, 0.5% failure = ~8 failed bookings per second.
    // That is acceptable. Below 99.5% means something is breaking.

    http_req_failed: ['rate<0.01'],
    // Less than 1% HTTP errors (5xx responses).
  },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';

export default function () {
  // Each virtual user (VU) executes this function in a loop.
  // The function simulates one complete booking flow.

  // Step 1: Search for hotels (read-heavy, cacheable)
  const searchRes = http.get(
    `${BASE_URL}/api/v1/search/hotels?destination=NYC&checkIn=2026-06-01&checkOut=2026-06-05`,
    { tags: { operation: 'search' } }
  );

  check(searchRes, {
    'search returns 200': (r) => r.status === 200,
    'search returns hotels': (r) => JSON.parse(r.body).data.hotels.length > 0,
  });

  sleep(1); // Simulate user thinking time (1 second)

  // Step 2: Check availability (read, specific resource)
  const availRes = http.get(
    `${BASE_URL}/api/v1/inventory/availability?resourceType=hotel_room&resourceId=room-${Math.floor(Math.random() * 1000)}&checkIn=2026-06-01&checkOut=2026-06-05`,
    { tags: { operation: 'availability' } }
  );

  check(availRes, {
    'availability returns 200': (r) => r.status === 200,
  });

  sleep(0.5);

  // Step 3: Create a booking (write, most critical)
  const bookingPayload = JSON.stringify({
    bookingType: 'hotel',
    resourceType: 'hotel_room',
    resourceId: `room-${Math.floor(Math.random() * 1000)}`,
    checkIn: '2026-06-01',
    checkOut: '2026-06-05',
    guestCount: 2,
    totalAmount: 80000 + Math.floor(Math.random() * 40000),
    currency: 'USD',
  });

  const startTime = Date.now();

  const bookingRes = http.post(
    `${BASE_URL}/api/v1/bookings`,
    bookingPayload,
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer load-test-token',
        'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}`,
      },
      tags: { operation: 'booking' },
    }
  );

  const duration = Date.now() - startTime;
  bookingDuration.add(duration);

  const bookingSucceeded = bookingRes.status === 201;
  bookingSuccessRate.add(bookingSucceeded);

  check(bookingRes, {
    'booking returns 201': (r) => r.status === 201,
    'booking has ID': (r) => {
      try {
        return JSON.parse(r.body).data.bookingId !== undefined;
      } catch {
        return false;
      }
    },
    'booking under 500ms': () => duration < 500,
  });

  sleep(2); // Simulate user reviewing confirmation
}
```

### Interpreting k6 Results

```
  scenarios: (100.00%) 1 scenario, 1666 max VUs, 40m30s max duration

  ✓ booking_success_rate.....: 99.72%  ✓ 148231  ✗ 412
  ✓ http_req_duration........: avg=187ms  p(95)=423ms  p(99)=1102ms
  ✓ http_req_failed..........: 0.27%   ✓ 412     ✗ 148643
    booking_duration_ms.......: avg=203ms  p(95)=456ms  p(99)=1180ms

    iterations................: 148643  61.93/s
```

Reading this output: the system handled ~62 booking iterations per second with a 99.72% success rate. The 95th percentile response time was 423ms (under the 500ms threshold). This passes all three thresholds.

> **Common Mistake:** Running load tests against a single application instance while production uses 12 replicas behind a load balancer. Your test proves that one instance handles 200 requests/second, but it tells you nothing about connection pooling across replicas, Redis lock contention at scale, or Kafka consumer group rebalancing under load. Always load test a production-like environment, not a laptop.

---

## Chaos Testing — Breaking Things on Purpose

Functional tests verify correct behavior. Load tests verify behavior under pressure. Chaos tests verify behavior when infrastructure fails. In a distributed system, failure is not a question of if but when: network partitions happen, disks fill up, containers get OOM-killed, DNS stops resolving.

### Fault Injection with Chaos Monkey Principles

```typescript
// tests/chaos/chaos-scenarios.ts
export const chaosScenarios = [
  {
    name: 'Kill one Kafka broker during peak traffic',
    description: `
      Our Kafka cluster has 3 brokers. This test kills one broker
      while the system processes 1,000 bookings/second. Expected
      behavior: Kafka reassigns partitions to surviving brokers,
      producers receive temporary errors and retry, no messages
      are lost, and throughput recovers within 30 seconds.
    `,
    inject: async () => {
      // kubectl delete pod kafka-broker-2 --grace-period=0
      await execCommand('kubectl delete pod kafka-broker-2 --grace-period=0');
    },
    verify: async () => {
      // After 60 seconds, check:
      // 1. No messages were lost (consumer lag is zero)
      // 2. Booking success rate stayed above 99%
      // 3. The killed broker was replaced by Kubernetes
      const consumerLag = await getKafkaConsumerLag('booking-events');
      expect(consumerLag).toBe(0);
    },
    rollback: async () => {
      // Kubernetes automatically restarts the pod.
      // Wait for it to rejoin the cluster.
      await waitForKafkaBrokerCount(3, 120_000);
    },
  },

  {
    name: 'Simulate Redis connection failure',
    description: `
      Redis is used for distributed locks and caching. This test
      blocks network access to Redis for 30 seconds. Expected
      behavior: the circuit breaker opens, requests that need
      Redis fall back to database-based locking (slower but
      functional), and when Redis recovers, the circuit breaker
      closes and normal operation resumes.
    `,
    inject: async () => {
      // Use iptables to block traffic to Redis port
      await execCommand(
        'kubectl exec booking-service-pod -- iptables -A OUTPUT -p tcp --dport 6379 -j DROP'
      );
    },
    verify: async () => {
      // During the outage:
      // - Bookings should still succeed (using fallback)
      // - Latency increases (database locks are slower than Redis)
      // - Circuit breaker metrics show OPEN state
      await sleep(5000);
      const metrics = await getServiceMetrics('booking-service');
      expect(metrics.circuitBreaker.redis.state).toBe('OPEN');
      expect(metrics.bookingSuccessRate).toBeGreaterThan(0.95);
    },
    rollback: async () => {
      await execCommand(
        'kubectl exec booking-service-pod -- iptables -D OUTPUT -p tcp --dport 6379 -j DROP'
      );
      await sleep(10000); // Wait for circuit breaker to close
    },
  },

  {
    name: 'Simulate database failover',
    description: `
      MySQL runs with a primary and two replicas. This test kills
      the primary. Expected behavior: the MySQL orchestrator
      promotes a replica to primary, the application reconnects
      within 15 seconds, and no committed transactions are lost.
    `,
    inject: async () => {
      await execCommand('kubectl delete pod mysql-primary-0 --grace-period=0');
    },
    verify: async () => {
      // Allow 30 seconds for failover
      await sleep(30_000);
      // Verify the new primary accepts writes
      const healthCheck = await httpGet('http://booking-service/health');
      expect(healthCheck.database).toBe('connected');
      // Verify no data was lost by querying the last known booking
      const lastBooking = await httpGet(
        'http://booking-service/api/v1/bookings/last-known-id'
      );
      expect(lastBooking.status).toBeDefined();
    },
    rollback: async () => {
      // Kubernetes restarts the pod, MySQL replication resynchronizes
      await waitForMySQLReplicaCount(2, 300_000);
    },
  },
];
```

> **What If You Skip This?** Without chaos testing, your first real infrastructure failure is an unplanned test in production. You learn that your circuit breaker configuration has a bug only when Redis actually goes down on Black Friday. You discover that Kafka partition reassignment takes 5 minutes (not the 30 seconds you assumed) when a broker dies during peak booking season. Chaos testing converts "unknown unknowns" into "known and handled" scenarios.

---

## Testing Event-Driven Flows

In our system, many critical operations are asynchronous. When a booking is confirmed, the Booking Service publishes a `booking.confirmed` event to Kafka. The Notification Service consumes it and sends an email. The Search Service consumes it and updates the Elasticsearch index. Testing these asynchronous flows requires a different approach than testing synchronous HTTP calls.

### Kafka Message Verification

```typescript
// tests/integration/event-flow.spec.ts
import { KafkaConsumer } from '../helpers/test-kafka-consumer';

describe('Booking Event Flow', () => {
  let testConsumer: KafkaConsumer;

  beforeAll(async () => {
    // Create a test consumer that subscribes to the booking events topic.
    // This consumer collects messages for assertion.
    testConsumer = new KafkaConsumer({
      brokers: [process.env.KAFKA_BROKER],
      groupId: 'test-consumer-group',
      topics: ['booking.confirmed', 'booking.cancelled'],
    });
    await testConsumer.connect();
  });

  afterAll(async () => {
    await testConsumer.disconnect();
  });

  it('should publish booking.confirmed event with correct schema', async () => {
    // Step 1: Create a booking via the HTTP API
    const bookingResponse = await createBookingViaAPI({
      resourceId: 'room-event-test-001',
      totalAmount: 95000,
    });
    const bookingId = bookingResponse.bookingId;

    // Step 2: Wait for the event to appear on Kafka
    // This is the key challenge with async testing: you must WAIT
    // for the event, but not forever. A 10-second timeout is reasonable.
    const event = await testConsumer.waitForMessage(
      'booking.confirmed',
      (msg) => msg.bookingId === bookingId,
      10_000  // timeout in ms
    );

    // Step 3: Verify the event payload matches the schema contract
    expect(event).toBeDefined();
    expect(event.bookingId).toBe(bookingId);
    expect(event.userId).toBeDefined();
    expect(event.totalAmount).toBe(95000);
    expect(event.currency).toBe('USD');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Every field that downstream consumers depend on must be verified.
    // If the Booking Service accidentally omits 'currency', the
    // Notification Service sends an email saying "You paid $950.00 null."
  });

  it('should publish booking.cancelled event when booking is cancelled', async () => {
    const booking = await createBookingViaAPI({
      resourceId: 'room-event-test-002',
    });

    await cancelBookingViaAPI(booking.bookingId, 'user_cancelled');

    const cancelEvent = await testConsumer.waitForMessage(
      'booking.cancelled',
      (msg) => msg.bookingId === booking.bookingId,
      10_000
    );

    expect(cancelEvent.reason).toBe('user_cancelled');
    expect(cancelEvent.refundAmount).toBeDefined();
  });
});
```

### Dead Letter Queue Testing

When a consumer fails to process a message after all retries, the message goes to the Dead Letter Queue (DLQ). Testing the DLQ ensures that poison messages do not block healthy ones.

```typescript
describe('Dead Letter Queue Handling', () => {
  it('should route malformed events to the DLQ after 3 retries', async () => {
    // Publish a deliberately malformed event
    await publishToKafka('booking.confirmed', {
      bookingId: null,        // Missing required field
      totalAmount: 'not-a-number',  // Wrong type
    });

    // The consumer should fail to process this event.
    // After 3 retry attempts (with exponential backoff), it should
    // land in the DLQ topic.

    const dlqMessage = await testConsumer.waitForMessage(
      'booking.confirmed.dlq',
      (msg) => msg.originalPayload?.totalAmount === 'not-a-number',
      30_000  // Longer timeout: 3 retries with backoff take time
    );

    expect(dlqMessage).toBeDefined();
    expect(dlqMessage.retryCount).toBe(3);
    expect(dlqMessage.lastError).toContain('validation');
    // The DLQ message should include the original payload,
    // the error message, and the retry count — everything an
    // on-call engineer needs to diagnose the problem.
  });

  it('should continue processing healthy messages after a poison message', async () => {
    // Publish a poison message followed by a healthy one
    await publishToKafka('booking.confirmed', { bookingId: null });
    await publishToKafka('booking.confirmed', {
      bookingId: 'healthy-booking-001',
      totalAmount: 50000,
      currency: 'USD',
      timestamp: new Date().toISOString(),
    });

    // The healthy message should be processed successfully
    // even though the poison message failed.
    const processedEvent = await waitForProcessedBooking('healthy-booking-001');
    expect(processedEvent).toBeDefined();
    // If the consumer is blocking (processing messages sequentially
    // without DLQ routing), the poison message blocks everything
    // behind it. This test catches that design flaw.
  });
});
```

> **Analogy:** Think of Kafka consumers like a mail sorting machine. Most letters go through fine. Occasionally, a crumpled, oversized, or illegible letter jams the machine. Without a DLQ, the machine stops entirely until someone manually removes the jam. With a DLQ, the machine ejects the problematic letter into a special bin, logs what went wrong, and keeps processing the rest of the mail. The DLQ test verifies that the ejection mechanism works.

---

## Test Data Factories and Fixtures

As your test suite grows, you will find yourself writing the same booking objects over and over: `{ userId: 'user-123', resourceType: 'hotel_room', checkIn: new Date('2026-03-01'), ... }`. Copy-pasting leads to inconsistencies, and changing a field name requires updating hundreds of tests.

Factories solve this by generating realistic test data with sensible defaults.

### The Factory Pattern

```typescript
// tests/factories/booking.factory.ts
import { faker } from '@faker-js/faker';
import { BookingStatus } from '@prisma/client';

interface BookingOverrides {
  userId?: string;
  status?: BookingStatus;
  resourceType?: string;
  resourceId?: string;
  checkIn?: Date;
  checkOut?: Date;
  totalAmount?: number;
  currency?: string;
  idempotencyKey?: string;
}

export function buildBookingDto(overrides: BookingOverrides = {}) {
  const checkIn = overrides.checkIn || faker.date.future({ years: 1 });
  const checkOut = overrides.checkOut ||
    new Date(checkIn.getTime() + faker.number.int({ min: 1, max: 14 }) * 86_400_000);

  return {
    userId: overrides.userId || faker.string.uuid(),
    resourceType: overrides.resourceType || 'hotel_room',
    resourceId: overrides.resourceId || `room-${faker.number.int({ min: 100, max: 999 })}`,
    checkIn,
    checkOut,
    guestCount: faker.number.int({ min: 1, max: 4 }),
    totalAmount: overrides.totalAmount ||
      faker.number.int({ min: 5000, max: 200000 }),
    currency: overrides.currency || 'USD',
    idempotencyKey: overrides.idempotencyKey || faker.string.uuid(),
  };
}

export function buildBookingEntity(overrides: BookingOverrides = {}) {
  return {
    id: faker.string.uuid(),
    ...buildBookingDto(overrides),
    status: overrides.status || BookingStatus.CONFIRMED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// Specialized factories for common test scenarios
export function buildExpiredBooking() {
  return buildBookingEntity({
    checkIn: faker.date.past({ years: 1 }),
    checkOut: faker.date.past({ years: 1 }),
    status: BookingStatus.COMPLETED,
  });
}

export function buildPendingBooking() {
  return buildBookingEntity({
    status: BookingStatus.PENDING,
  });
}

export function buildHighValueBooking() {
  return buildBookingEntity({
    totalAmount: faker.number.int({ min: 500000, max: 2000000 }),
    // High-value bookings trigger fraud detection checks.
    // Having a factory for these makes fraud-related tests readable.
  });
}
```

### Using Factories in Tests

```typescript
describe('BookingService.cancelBooking', () => {
  it('should allow cancellation of a confirmed booking', async () => {
    // ONE LINE to create test data instead of 15 lines of raw object
    const booking = buildBookingEntity({ status: BookingStatus.CONFIRMED });
    prisma.booking.findUnique.mockResolvedValue(booking);

    const result = await service.cancelBooking(booking.id, 'user_cancelled');
    expect(result.status).toBe('cancelled');
  });

  it('should reject cancellation of an already cancelled booking', async () => {
    const booking = buildBookingEntity({ status: BookingStatus.CANCELLED });
    prisma.booking.findUnique.mockResolvedValue(booking);

    await expect(
      service.cancelBooking(booking.id, 'user_cancelled')
    ).rejects.toThrow('Booking is already cancelled');
  });

  it('should apply different refund policies based on timing', async () => {
    // Full refund: cancel 7+ days before check-in
    const farFutureBooking = buildBookingEntity({
      checkIn: new Date(Date.now() + 14 * 86_400_000), // 14 days away
      totalAmount: 100000,
    });
    prisma.booking.findUnique.mockResolvedValue(farFutureBooking);

    const result = await service.cancelBooking(farFutureBooking.id, 'user_cancelled');
    expect(result.refundAmount).toBe(100000); // Full refund

    // Partial refund: cancel 1-6 days before check-in
    const nearFutureBooking = buildBookingEntity({
      checkIn: new Date(Date.now() + 3 * 86_400_000), // 3 days away
      totalAmount: 100000,
    });
    prisma.booking.findUnique.mockResolvedValue(nearFutureBooking);

    const result2 = await service.cancelBooking(nearFutureBooking.id, 'user_cancelled');
    expect(result2.refundAmount).toBe(50000); // 50% refund
  });
});
```

> **Common Mistake:** Using hardcoded test data everywhere. When you write `userId: 'user-123'` in 80 tests and then your schema adds a UUID format validation, you have 80 tests to update. Factories centralize the data construction so you change it once. They also prevent "magic values" — when a test uses `totalAmount: 80000`, is that number significant or arbitrary? A factory makes it clear: `buildHighValueBooking()` versus `buildBookingDto({ totalAmount: 80000 })`.

---

## Database Testing Strategies

### Migration Testing

Database migrations are code too. A migration that works on your laptop might fail in production because of data that exists only in production.

```typescript
// tests/database/migration.spec.ts
describe('Database Migrations', () => {
  it('should apply all migrations to a fresh database', async () => {
    // Start with an empty database (Testcontainers)
    const freshPrisma = new PrismaClient({
      datasources: { db: { url: freshMySQLContainer.getUrl() } },
    });

    // Run all migrations from zero
    // This is equivalent to: npx prisma migrate deploy
    const result = await execCommand(
      `DATABASE_URL="${freshMySQLContainer.getUrl()}" npx prisma migrate deploy`
    );

    expect(result.exitCode).toBe(0);
    // If any migration has a syntax error, a dependency on a
    // non-existent table, or an invalid default value, this fails.

    // Verify the final schema is correct
    const tables = await freshPrisma.$queryRaw`SHOW TABLES`;
    expect(tables).toContainEqual({ Tables_in_booking_test: 'bookings' });
    expect(tables).toContainEqual({ Tables_in_booking_test: 'payments' });
    expect(tables).toContainEqual({ Tables_in_booking_test: 'users' });
  });

  it('should handle migration rollback safely', async () => {
    // Apply migrations, then roll back the last one.
    // Verify the database is in a consistent state.
    // This protects against migrations that are easy to apply
    // but impossible to reverse (like dropping a column with data).
  });
});
```

### Seed Data for Testing

```typescript
// tests/database/seed.ts
export async function seedTestDatabase(prisma: PrismaClient) {
  // Create test users
  await prisma.user.createMany({
    data: [
      { id: 'seed-user-001', email: 'alice@test.com', name: 'Alice Test' },
      { id: 'seed-user-002', email: 'bob@test.com', name: 'Bob Test' },
    ],
  });

  // Create test inventory
  await prisma.inventory.createMany({
    data: [
      {
        resourceType: 'hotel_room',
        resourceId: 'room-seed-001',
        totalQuantity: 10,
        availableQuantity: 10,
        region: 'us-east-1',
      },
      {
        resourceType: 'hotel_room',
        resourceId: 'room-seed-002',
        totalQuantity: 5,
        availableQuantity: 0, // Sold out for testing unavailability
        region: 'us-east-1',
      },
    ],
  });
}

export async function cleanTestDatabase(prisma: PrismaClient) {
  // Delete in reverse order of foreign key dependencies.
  // If you delete users before bookings, FK constraints fail.
  await prisma.payment.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.inventory.deleteMany({});
  await prisma.user.deleteMany({});
}
```

> **What If You Skip This?** Without proper database cleanup between tests, tests depend on each other's side effects. Test A creates a booking. Test B happens to run after Test A and accidentally relies on that booking existing. When you run Test B alone, it fails. When you run the full suite, it passes. This is the definition of a flaky test, and it erodes developer trust in the entire test suite.

---

## Mutation Testing with Stryker

Code coverage tells you which lines of code your tests touch. Mutation testing tells you whether your tests would actually catch a bug in those lines. These are very different things.

### The Problem with Code Coverage

```typescript
// 100% line coverage does NOT mean your tests are good.
// Consider this function:
function calculateRefundAmount(totalAmount: number, daysBeforeCheckIn: number): number {
  if (daysBeforeCheckIn >= 7) {
    return totalAmount;        // Full refund
  } else if (daysBeforeCheckIn >= 1) {
    return totalAmount * 0.5;  // 50% refund
  } else {
    return 0;                  // No refund (same-day cancel)
  }
}

// This test achieves 100% line coverage:
it('should calculate refund', () => {
  expect(calculateRefundAmount(100000, 10)).toBe(100000);
  expect(calculateRefundAmount(100000, 3)).toBe(50000);
  expect(calculateRefundAmount(100000, 0)).toBe(0);
});

// But what if a developer changes `>= 7` to `> 7`?
// The day-7 boundary case is untested!
// The tests still pass, but customers cancelling exactly 7 days
// before check-in now get 50% instead of 100%.
```

### How Mutation Testing Works

Stryker modifies your source code automatically (creates "mutants") and runs your tests against each mutant. If a test fails, the mutant is "killed" (good). If all tests pass, the mutant "survived" (bad — your tests missed the bug).

```javascript
// stryker.conf.js
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
module.exports = {
  checkers: ['@stryker-mutator/typescript-checker'], // Must be at top level, NOT inside mutator
  mutator: {
    // Which mutations to apply
    excludedMutations: [
      'StringLiteral',  // Skip mutating log messages
    ],
  },
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'progress'],
  testRunner: 'jest',
  jest: {
    configFile: 'jest.config.ts',
  },
  coverageAnalysis: 'perTest',
  // Only mutate business logic, not test files or configs
  mutate: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
  ],
  thresholds: {
    high: 80,   // Mutation score above 80% is excellent
    low: 60,    // Below 60% means tests are weak
    break: 50,  // Below 50% fails the build entirely
  },
};
```

### Reading Stryker Output

```
Mutation testing  [======================] 100% (elapsed: 3m, remaining: 0s)

  #1. [Survived] ConditionalExpression
  src/services/booking.service.ts:45:8
  -   if (daysBeforeCheckIn >= 7) {
  +   if (daysBeforeCheckIn > 7) {
  Tests run: 12 | Passed: 12

  This mutant SURVIVED. Your tests accept both >= 7 and > 7.
  The boundary case (exactly 7 days) is not tested.
  FIX: Add a test with daysBeforeCheckIn = 7.

  #2. [Killed] ArithmeticOperator
  src/services/booking.service.ts:48:30
  -   return totalAmount * 0.5;
  +   return totalAmount / 0.5;
  Tests run: 12 | Failed: 1

  This mutant was KILLED. Your tests correctly detect when
  multiplication is changed to division.

  Mutation score: 78.4% (killed 127 of 162 mutants)
  Survived: 35 | Timeout: 0 | No coverage: 0
```

> **Analogy:** Code coverage is like checking that a security guard walks past every door in the building. Mutation testing is like checking whether the guard would actually notice if a door were unlocked. A guard who walks past every door but never checks the locks has 100% coverage and 0% effectiveness. Mutation testing reveals the difference.

---

## CI Integration — Making Tests Part of Every Commit

Tests are only valuable if they run on every commit. A test that lives in the repository but is not executed in CI is a test that will rot.

### The CI Pipeline

```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        # Test sharding: split unit tests across 4 parallel runners.
        # Each runner gets ~300 tests instead of 1200.
        # Total wall-clock time drops from 45s to ~12s.
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx jest --shard=${{ matrix.shard }}/4 --ci --coverage
        env:
          NODE_ENV: test
      - name: Upload coverage
        uses: actions/upload-artifact@v4
        with:
          name: coverage-shard-${{ matrix.shard }}
          path: coverage/

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests  # Only run if unit tests pass
    services:
      # GitHub Actions can spin up service containers
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: test
          MYSQL_DATABASE: booking_test
        ports:
          - 3306:3306
        options: >-
          --health-cmd="mysqladmin ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx prisma migrate deploy
        env:
          DATABASE_URL: mysql://root:test@localhost:3306/booking_test
      - run: npx jest --config jest.integration.config.ts --ci
        env:
          DATABASE_URL: mysql://root:test@localhost:3306/booking_test
          REDIS_URL: redis://localhost:6379

  contract-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npx jest --config jest.contract.config.ts --ci
      - name: Publish pacts to broker
        if: github.ref == 'refs/heads/main'
        run: npx pact-broker publish ./pacts --consumer-app-version=${{ github.sha }}

  coverage-gate:
    runs-on: ubuntu-latest
    needs: [unit-tests, integration-tests]
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: coverage-shard-*
          merge-multiple: true
      - name: Merge and check coverage
        run: |
          npx istanbul-merge --out combined-coverage.json coverage-shard-*/coverage-final.json
          npx istanbul check-coverage --statements 80 --branches 75 --functions 80 --lines 80
        # Coverage gates: the build FAILS if coverage drops below thresholds.
        # statements 80% | branches 75% | functions 80% | lines 80%
        # These are not aspirational. They are enforced. A PR that drops
        # coverage below 80% cannot be merged.

  e2e-tests:
    runs-on: ubuntu-latest
    needs: [integration-tests, contract-tests]
    # E2E tests only run on main branch merges, not on every PR.
    # They are too slow for PR feedback loops.
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to staging
        run: ./scripts/deploy-staging.sh
      - name: Run E2E suite
        run: npx jest --config jest.e2e.config.ts --ci
        timeout-minutes: 15
```

### Test Reporting

```typescript
// jest.config.ts — reporting configuration
export default {
  reporters: [
    'default',
    [
      'jest-junit',
      {
        outputDirectory: './test-results',
        outputName: 'junit.xml',
        // JUnit XML format is understood by every CI system:
        // GitHub Actions, GitLab CI, Jenkins, CircleCI.
        // It produces the test result badges and failure summaries.
      },
    ],
    [
      'jest-html-reporter',
      {
        outputPath: './test-results/report.html',
        pageTitle: 'Booking System Test Report',
        includeFailureMsg: true,
        includeSuiteFailure: true,
      },
    ],
  ],
};
```

> **Common Mistake:** Setting coverage thresholds too high initially. Teams set 90% coverage on day one, realize they cannot meet it, and disable the check "temporarily." It never gets re-enabled. Start with 70% and increase by 2% per quarter. The goal is a ratchet that only moves up, never down. Each PR must not decrease coverage below the current threshold.

---

## Production War Stories

These are based on patterns seen in real production systems. They illustrate why specific test practices matter.

### War Story 1: Tests Passed, Production Broke

> **Production War Story:** A payments team had 95% unit test coverage and every test was green. They deployed a new version that changed the date format from `YYYY-MM-DD` to `MM/DD/YYYY` in the payment confirmation response. All unit tests passed because they mocked the date formatting library. All integration tests passed because they only checked that the response contained a date field, not its format. The mobile app, which parsed `YYYY-MM-DD` with a hardcoded format string, crashed for every user who received a payment confirmation. 47,000 users saw a blank screen. The fix was a one-line format string change. The lesson: unit tests with mocks do not test the contract between services. A single contract test asserting `expect(response.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)` would have prevented the outage.

### War Story 2: The Flaky Test Nightmare

> **Production War Story:** A booking platform had a test that checked whether a Kafka event was published within 5 seconds of a booking creation. On the developer's laptop, Kafka responded in 200ms. In CI, the shared Kafka instance was sometimes slow, and the test failed 1 out of every 20 runs. The team added a retry to the test: "if it fails, wait 5 more seconds and try again." This masked the real problem — a memory leak in the Kafka producer that caused it to slow down after processing 10,000 messages. The leak eventually caused a production outage when the producer ran for 8 hours straight. The fix was not retrying the test; it was fixing the memory leak and setting the timeout to a value that would fail consistently when the producer was unhealthy.

### War Story 3: The Missing Integration Test

> **Production War Story:** A team refactored their database schema, renaming the `check_in` column to `checkIn` for consistency with their TypeScript code. They updated all Prisma models, all DTOs, and all unit tests. Coverage stayed at 92%. Every test passed. In production, a raw SQL query in an analytics reporting job still referenced `check_in`. The job ran once daily at midnight. At 12:01 AM, the analytics dashboard went blank. The daily revenue report emailed to executives showed $0. It took 4 hours to diagnose because the error was buried in a cron job log that nobody monitored. An integration test that ran the analytics query against a real database would have caught the stale column reference immediately.

---

## Testing Anti-Patterns

### Anti-Pattern 1: Over-Mocking

```typescript
// BAD: This test mocks so much that it tests nothing
it('should process booking', async () => {
  const mockBooking = { id: 'b-1', status: 'confirmed' };
  jest.spyOn(service, 'validateInput').mockReturnValue(true);
  jest.spyOn(service, 'checkAvailability').mockResolvedValue(true);
  jest.spyOn(service, 'processPayment').mockResolvedValue({ id: 'p-1' });
  jest.spyOn(service, 'saveBooking').mockResolvedValue(mockBooking);
  jest.spyOn(service, 'publishEvent').mockResolvedValue(undefined);

  const result = await service.createBooking(dto);

  expect(result).toEqual(mockBooking);
  // What does this test prove? That the service calls its own methods
  // in order and returns what you told it to return. That is a tautology.
  // You are testing your mocks, not your code.
});

// GOOD: Mock only external dependencies, test real internal logic
it('should process booking', async () => {
  // Only mock the boundaries: database, HTTP clients, message queue
  inventoryClient.checkAvailability.mockResolvedValue(true);
  paymentClient.charge.mockResolvedValue({ id: 'p-1' });
  prisma.booking.create.mockResolvedValue({ id: 'b-1', status: 'confirmed' });

  const result = await service.createBooking(dto);

  // Assert on behavior, not on internal method calls
  expect(result.status).toBe('confirmed');
  expect(paymentClient.charge).toHaveBeenCalledWith(
    expect.objectContaining({ amount: dto.totalAmount })
  );
});
```

### Anti-Pattern 2: Testing Implementation Details

```typescript
// BAD: Tests the internal structure of the code
it('should call private method _calculateTax', async () => {
  const spy = jest.spyOn(service as any, '_calculateTax');
  await service.createBooking(dto);
  expect(spy).toHaveBeenCalledWith(80000, 'US');
  // If you rename _calculateTax to _computeTax, this test breaks
  // even though the behavior is identical. The test is coupled to
  // the implementation, not the behavior.
});

// GOOD: Tests the observable behavior
it('should include tax in the total amount', async () => {
  const dto = buildBookingDto({ totalAmount: 80000 });
  const result = await service.createBooking(dto);
  // Tax for US is 10%, so final amount should be 88000
  expect(result.totalWithTax).toBe(88000);
  // You can refactor the internals freely. As long as the tax
  // calculation is correct, this test passes.
});
```

### Anti-Pattern 3: Slow Test Suites

```typescript
// BAD: Each test boots a fresh NestJS app (3-5 seconds per test)
describe('BookingController', () => {
  it('test 1', async () => {
    const app = await createTestApp(); // 3 seconds
    // ... test ... (50ms)
    await app.close();
  });

  it('test 2', async () => {
    const app = await createTestApp(); // 3 seconds
    // ... test ... (50ms)
    await app.close();
  });
  // 20 tests x 3 seconds = 60 seconds just for app startup
});

// GOOD: Boot the app once, share it across tests
describe('BookingController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp(); // 3 seconds, once
  });

  afterAll(async () => {
    await app.close();
  });

  it('test 1', async () => { /* 50ms */ });
  it('test 2', async () => { /* 50ms */ });
  // 3 seconds + (20 tests x 50ms) = 4 seconds total
});
```

> **What If You Skip This?** Anti-patterns compound. Over-mocked tests give false confidence. Implementation-coupled tests break on every refactor, making developers afraid to improve code. Slow tests make developers skip running them locally. Together, these anti-patterns produce a codebase where nobody trusts the tests, nobody runs them voluntarily, and bugs ship to production regularly. The test suite becomes a tax instead of an asset.

---

## Chapter 42 Summary Table

| Concept | What It Tests | When to Use | Key Tool |
|---|---|---|---|
| Unit tests (mocked Prisma) | Query shape, business logic around data access | Every PR, every commit | jest-mock-extended |
| Unit tests (real DB, rollback) | Actual query results, constraints, cascades | Critical data paths | Testcontainers + Prisma |
| Integration tests | Full HTTP request through NestJS to real infrastructure | Every PR (CI) | Testcontainers, supertest |
| Contract tests (Pact) | API agreement between consumer and provider services | Every PR on either service | Pact, Pact Broker |
| E2E tests | Full user journey: search, book, confirm, cancel | Merge to main, nightly | supertest, staging env |
| Load tests (k6) | Throughput, latency percentiles, error rates at scale | Weekly, pre-release | k6 |
| Chaos tests | Resilience to infrastructure failure (broker death, network partition) | Monthly, before major releases | Chaos Monkey, kubectl |
| Event-driven flow tests | Kafka message schema, DLQ routing, event ordering | Every PR with event changes | Test consumer, Testcontainers |
| Test data factories | Consistent, realistic test data | Every test file | faker.js, factory functions |
| Database migration tests | Migrations apply cleanly, rollback safely | Every migration change | Testcontainers |
| Mutation testing (Stryker) | Whether tests actually detect bugs, not just cover lines | Weekly, on critical modules | Stryker |
| CI pipeline | Automated execution, sharding, coverage gates, reporting | Every commit | GitHub Actions |

> **Checkpoint:** At this point, you should be able to answer these questions from memory. First, what is the difference between code coverage and mutation testing, and why does a team with 95% coverage still ship bugs? The answer is that coverage measures which lines are executed, while mutation testing measures whether your assertions would catch a change to those lines. Second, why are contract tests necessary when you already have integration tests? The answer is that integration tests mock the other service, so they cannot detect when the other service changes its response format. Contract tests verify the agreement between both sides independently. If you can explain both of these, you understand testing at the level required for a production system handling 100,000 bookings per minute.

---
