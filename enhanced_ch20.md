# Chapter 20: CQRS — Separating Reads from Writes

## You Already Do This (You Just Don't Know It)

Open any application you have built. Find the code that creates a booking. Now find the code that lists bookings. Look at them side by side. They share a database table, but that is where the similarity ends.

The write path validates input, enforces business rules, acquires locks, runs inside a transaction, and returns a single confirmation. The read path filters across dozens of fields, sorts by user preference, paginates, joins three tables, and returns a list of shaped results. They want completely different things from the database. Forcing them to share one table, one schema, one set of indexes is like asking a sprinter and a marathon runner to share the same pair of shoes.

At small scale, this compromise is invisible. At 100,000 bookings per minute with millions of concurrent search queries, it becomes the bottleneck that brings your system down.

```typescript
// This is the compromise you are making right now.
// Same table. Same connection pool. Same indexes.

// Writing: optimized for correctness
await db.query(
  `INSERT INTO bookings (user_id, hotel_id, room_id, check_in, check_out, status, total_price)
   VALUES ($1, $2, $3, $4, $5, 'confirmed', $6)`,
  [userId, hotelId, roomId, checkIn, checkOut, totalPrice]
);

// Reading: optimized for discovery
const result = await db.query(
  `SELECT b.id, b.status, b.total_price, b.check_in, b.check_out,
          h.name AS hotel_name, h.city, h.star_rating,
          r.room_type, r.amenities,
          u.full_name, u.email
   FROM bookings b
   JOIN hotels h ON b.hotel_id = h.id
   JOIN rooms r ON b.room_id = r.id
   JOIN users u ON b.user_id = u.id
   WHERE b.user_id = $1
     AND b.status = ANY($2)
     AND b.check_in >= $3
   ORDER BY b.created_at DESC
   LIMIT 20 OFFSET $4`,
  [userId, statusFilters, dateFrom, offset]
);
```

That `INSERT` needs few indexes (the fewer, the faster). That `SELECT` needs many indexes (on `user_id`, `status`, `check_in`, `created_at`, plus foreign keys for the JOINs). Every index you add for the read path slows down the write path, because every `INSERT` must update every index. Every index you remove for the write path slows down the read path, because the `SELECT` falls back to sequential scans.

This is not a tuning problem. It is a fundamental architectural conflict.

## Why Reads and Writes Have Fundamentally Different Needs

Let us be precise about what each side requires.

**Writes demand correctness above all else.** When the last room at the Hilton Tokyo is being booked, the system must guarantee that exactly one customer gets it. This means ACID transactions, row-level locks, foreign key constraints, and serializable isolation where necessary. These mechanisms are inherently slow -- they coordinate, they wait, they verify. That is the price of correctness. You cannot tune your way out of it.

**Reads demand speed and flexibility above all else.** When a user searches for "hotels in Tokyo under $200 with a pool, sorted by guest rating, within 2 km of Shibuya station," they expect results in under 200 milliseconds. They need full-text search, geo-distance calculations, faceted filtering, and relevance scoring. They do not care if the results are 2 seconds stale. They care that the experience is instant.

Here is the conflict laid out in a table:

| Dimension | Write Requirements | Read Requirements |
|-----------|-------------------|-------------------|
| **Consistency** | Strong (ACID, locks, fencing tokens) | Eventual (seconds-old data is fine) |
| **Schema** | Normalized (3NF, no duplication) | Denormalized (flatten for speed) |
| **Indexes** | Minimal (every index slows writes) | Extensive (every query needs one) |
| **Query pattern** | Single-row inserts/updates by PK | Multi-table joins, aggregations, full-text |
| **Concurrency** | Pessimistic locking for safety | Lock-free reads for throughput |
| **Scaling** | Vertical (bigger machine) | Horizontal (more replicas, more nodes) |
| **Optimization** | Write-ahead log, buffer pool, minimal I/O | Caching, materialized views, inverted indexes |

When both workloads hit the same database, they fight. Write transactions acquire row locks; read queries queue behind those locks. Read queries scan large result sets, consuming I/O bandwidth that write transactions need for fsync. You add read replicas, but the query complexity -- geo-search, full-text, faceted aggregations -- exceeds what MySQL can efficiently handle regardless of how many replicas you add.

> **Analogy:** Think about a physical store. The **catalog** is how customers browse products -- it has beautiful photos, detailed descriptions, filters by category and price, and it is optimized for discovery. The **order form** is how customers buy products -- it has precise fields for quantity, shipping address, and payment details, and it is optimized for accuracy. Nobody expects the catalog and the order form to be the same document. You would never hand a customer a raw inventory spreadsheet and say "here, find what you want and also fill out your order on row 4,327." Yet that is exactly what we do when we use one database table for both reading and writing. CQRS says: separate the catalog from the order form.

---

## CQRS Theory: Command Side vs Query Side

> **Key Term:** **CQRS (Command Query Responsibility Segregation)** — An architectural pattern that uses separate models, data stores, or services for reading data (queries) and writing data (commands). The write model is optimized for consistency and correctness. The read model is optimized for query performance and flexibility. Data flows from the write side to the read side through events or change data capture.

The name comes from Bertrand Meyer's *Command-Query Separation* (CQS) principle: every method should either be a **command** (changes state, returns nothing) or a **query** (returns data, changes nothing). CQRS takes this principle from the method level to the architectural level. Instead of separating methods, you separate entire subsystems.

### The Command Side

The command side handles all state-changing operations: creating a booking, canceling a reservation, updating a price, processing a payment. Commands are imperative -- they tell the system to *do* something.

```
Commands are verbs:
  CreateBookingCommand
  CancelBookingCommand
  ConfirmPaymentCommand
  UpdateInventoryCommand
```

Each command passes through a **Command Handler** that validates the request, enforces business rules, writes to the database, and publishes events. The command handler is the gatekeeper of your domain logic.

### The Query Side

The query side handles all data retrieval operations: searching hotels, listing bookings, generating reports, populating dashboards. Queries are questions -- they ask the system for information without changing it.

```
Queries are questions:
  GetUserBookingsQuery
  SearchHotelsQuery
  GetBookingDetailsQuery
  GetDashboardMetricsQuery
```

Each query is handled by a **Query Handler** that reads from a store optimized for that specific query pattern. The query handler has zero business logic -- it is pure data retrieval.

### The Architecture

```
                         ┌──────────────────────────────────────────────┐
                         │              Global Booking System           │
                         │                                              │
  ┌──────────┐           │  ┌─────────────────┐   ┌─────────────────┐  │
  │  Client   │───CMD───▶│  │ Command Handler │   │  Query Handler  │◀─┼───QUERY── ┌──────────┐
  │  (Web /   │           │  │                 │   │                 │  │           │  Client   │
  │  Mobile)  │           │  │ • Validate      │   │ • No business   │  │           │  (Web /   │
  └──────────┘           │  │ • Apply rules   │   │   logic         │  │           │  Mobile)  │
                         │  │ • Write to DB   │   │ • Read from     │  │           └──────────┘
                         │  │ • Publish event │   │   read store    │  │
                         │  └────────┬────────┘   └────────▲────────┘  │
                         │           │                     │            │
                         │  ┌────────▼────────┐   ┌───────┴─────────┐  │
                         │  │    MySQL         │   │  Elasticsearch  │  │
                         │  │  (Write Store)   │──▶│  (Read Store)   │  │
                         │  │                 │   │                 │  │
                         │  │  Normalized     │   │  Denormalized   │  │
                         │  │  ACID           │   │  Fast queries   │  │
                         │  │  Source of truth │   │  Eventually     │  │
                         │  │                 │   │  consistent     │  │
                         │  └─────────────────┘   └─────────────────┘  │
                         │            │                    ▲            │
                         │            │     ┌──────────┐   │            │
                         │            └────▶│  Kafka   │───┘            │
                         │                  │ (Events) │                │
                         │                  └──────────┘                │
                         └──────────────────────────────────────────────┘
```

The arrow from MySQL to Elasticsearch does not mean MySQL pushes data directly. It means: when a write happens in MySQL, an event is published to Kafka (via the Transactional Outbox pattern from Chapter 19), and a **projector** consumes that event and writes a denormalized copy to Elasticsearch.

### When to Use CQRS

CQRS is not free. It adds a second data store, an event pipeline, eventual consistency semantics, and operational complexity. Here is the decision framework:

**Use CQRS when:**

- Read and write workloads have fundamentally different performance profiles (our case: 100K writes/min vs millions of search queries/min)
- Read patterns require capabilities your write store cannot provide (full-text search, geo-queries, faceted filtering, graph traversals)
- You need to scale reads and writes independently
- You already have event-driven architecture in place (Kafka, RabbitMQ)
- You serve multiple read-optimized views of the same data (search index, analytics warehouse, admin dashboard)

**Do NOT use CQRS when:**

- A single database handles both workloads without strain
- Your read patterns are simple `SELECT ... WHERE id = ?` queries
- Strong consistency is required for every read (e.g., a banking ledger where the displayed balance must always match the actual balance)
- Your team lacks the operational maturity to run multiple data stores and an event pipeline
- Your application is a straightforward CRUD app with fewer than 1,000 concurrent users

> **What If You Skip This?** Without CQRS, your MySQL database must serve both write-heavy transactional traffic and read-heavy analytical/search traffic. At 100,000 bookings per minute, write locks block read queries. Index maintenance from heavy writes degrades read performance. Complex search queries (geo-distance, full-text, faceted) consume I/O that starves write transactions. You cannot scale reads without also scaling writes. Your database becomes a bottleneck for everything, and no amount of hardware can fix an architectural mismatch.

---

## Event Sourcing + CQRS: The Relationship

You will often hear CQRS and Event Sourcing mentioned together, as if they are the same thing. They are not. They are two distinct patterns that happen to complement each other well.

**Event Sourcing** is a data storage pattern: instead of storing the current state of an entity (e.g., "Booking #42 is confirmed"), you store the sequence of events that led to that state (e.g., "BookingCreated, PaymentReceived, BookingConfirmed"). The current state is derived by replaying the events.

**CQRS** is an architectural pattern: separate the write model from the read model.

You can use either one without the other:

| Combination | Description | When It Makes Sense |
|-------------|-------------|-------------------|
| **CQRS without Event Sourcing** | Write to normalized MySQL, project to Elasticsearch. No event log. | You need read optimization but do not need an audit trail or temporal queries. **This is what we use in our booking system.** |
| **Event Sourcing without CQRS** | Store events as the source of truth, but read directly from the event store (or a derived state table). Same store for reads and writes. | You need full audit history but your read patterns are simple. |
| **CQRS + Event Sourcing** | Store events as the source of truth. Project events into one or more read-optimized stores. | You need both full audit history AND complex read optimization. Common in financial systems, compliance-heavy domains. |
| **Neither** | Traditional CRUD with a single database. | Small to medium applications with straightforward requirements. |

For our Global Booking System, we use **CQRS without full Event Sourcing**. We publish events to Kafka for projecting into read models, but MySQL stores the current state of bookings, not the full event history. This gives us the read optimization benefits of CQRS without the complexity of replaying thousands of events to reconstruct entity state.

> **Key Term:** **Event Sourcing** — A data storage pattern where the source of truth is an immutable, append-only log of domain events. The current state of any entity is derived by replaying its events from the beginning. This provides a complete audit trail and enables temporal queries ("What was the state of booking #42 at 3:00 PM yesterday?").

> **Analogy:** Think about a bank account. Event Sourcing is like keeping every transaction receipt (deposit $100, withdraw $30, deposit $200). Your balance ($270) is calculated by replaying all receipts. CQRS is like having a separate ATM screen that shows your balance instantly, without recalculating from every transaction. The receipts (events) are the source of truth; the ATM screen (read model) is a pre-computed view. You can have receipts without the ATM screen (Event Sourcing without CQRS), and you can have the ATM screen without keeping every receipt (CQRS without Event Sourcing).

---

## The Write Model: Normalized MySQL Tables

The write side of our booking system uses normalized MySQL tables optimized for data integrity, transactional consistency, and minimal duplication. Here are the core tables:

```sql
-- The write model: normalized, ACID-compliant, source of truth.
-- Every table enforces referential integrity through foreign keys.

CREATE TABLE bookings (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    hotel_id        BIGINT UNSIGNED NOT NULL,
    room_id         BIGINT UNSIGNED NOT NULL,
    booking_type    ENUM('hotel', 'flight', 'car_rental') NOT NULL DEFAULT 'hotel',
    status          ENUM('pending', 'confirmed', 'cancelled', 'completed', 'refunded') NOT NULL DEFAULT 'pending',
    check_in        DATE NOT NULL,
    check_out       DATE NOT NULL,
    total_price     DECIMAL(12, 2) NOT NULL,
    currency        CHAR(3) NOT NULL DEFAULT 'USD',
    guest_count     TINYINT UNSIGNED NOT NULL DEFAULT 1,
    special_requests TEXT,
    fencing_token   BIGINT UNSIGNED NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Foreign keys: the write model enforces referential integrity
    CONSTRAINT fk_booking_user  FOREIGN KEY (user_id)  REFERENCES users(id),
    CONSTRAINT fk_booking_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
    CONSTRAINT fk_booking_room  FOREIGN KEY (room_id)  REFERENCES rooms(id),

    -- Indexes: minimal. Only what is needed for writes and lookups by PK.
    INDEX idx_bookings_user_id (user_id),
    INDEX idx_bookings_status (status),
    INDEX idx_bookings_fencing (fencing_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE booking_events_outbox (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    booking_id      BIGINT UNSIGNED NOT NULL,
    event_type      VARCHAR(50) NOT NULL,       -- 'booking.created', 'booking.confirmed', etc.
    payload         JSON NOT NULL,              -- Full event payload
    published       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_outbox_unpublished (published, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE hotels (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    city            VARCHAR(100) NOT NULL,
    country         CHAR(2) NOT NULL,
    star_rating     TINYINT UNSIGNED NOT NULL,
    latitude        DECIMAL(10, 7) NOT NULL,
    longitude       DECIMAL(10, 7) NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_hotels_city (city)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE rooms (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hotel_id        BIGINT UNSIGNED NOT NULL,
    room_type       VARCHAR(50) NOT NULL,       -- 'standard', 'deluxe', 'suite'
    price_per_night DECIMAL(10, 2) NOT NULL,
    max_guests      TINYINT UNSIGNED NOT NULL DEFAULT 2,
    amenities       JSON,                       -- ["wifi", "pool", "gym"]
    available_count INT UNSIGNED NOT NULL DEFAULT 1,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_room_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
    INDEX idx_rooms_hotel (hotel_id),
    INDEX idx_rooms_type (room_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Notice the design choices:

- **Normalized schema.** Hotel information lives in `hotels`, room information in `rooms`, booking information in `bookings`. No duplication.
- **Foreign keys enforced.** Every booking must reference a valid user, hotel, and room. The database rejects invalid references.
- **Minimal indexes.** The write model has indexes only for foreign key lookups and the outbox polling query. No full-text indexes, no composite search indexes, no geo-spatial indexes. Every missing index is a write that completes faster.
- **Outbox table.** The `booking_events_outbox` table implements the Transactional Outbox pattern (Chapter 19). When a booking is created, both the `bookings` row and the `booking_events_outbox` row are inserted in the same transaction. A separate publisher polls the outbox and sends events to Kafka.

### Prisma Schema for the Write Model

Every raw SQL table gets a corresponding Prisma schema. This is what your NestJS services interact with:

```prisma
// prisma/schema.prisma — Write model

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Booking {
  id              BigInt          @id @default(autoincrement()) @db.UnsignedBigInt
  userId          BigInt          @map("user_id") @db.UnsignedBigInt
  hotelId         BigInt          @map("hotel_id") @db.UnsignedBigInt
  roomId          BigInt          @map("room_id") @db.UnsignedBigInt
  bookingType     BookingType     @default(hotel) @map("booking_type")
  status          BookingStatus   @default(pending)
  checkIn         DateTime        @map("check_in") @db.Date
  checkOut        DateTime        @map("check_out") @db.Date
  totalPrice      Decimal         @map("total_price") @db.Decimal(12, 2)
  currency        String          @default("USD") @db.Char(3)
  guestCount      Int             @default(1) @map("guest_count") @db.UnsignedTinyInt
  specialRequests String?         @map("special_requests") @db.Text
  fencingToken    BigInt          @map("fencing_token") @db.UnsignedBigInt
  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @updatedAt @map("updated_at")

  user            User            @relation(fields: [userId], references: [id])
  hotel           Hotel           @relation(fields: [hotelId], references: [id])
  room            Room            @relation(fields: [roomId], references: [id])

  @@index([userId], map: "idx_bookings_user_id")
  @@index([status], map: "idx_bookings_status")
  @@index([fencingToken], map: "idx_bookings_fencing")
  @@map("bookings")
}

model BookingEventsOutbox {
  id         BigInt   @id @default(autoincrement()) @db.UnsignedBigInt
  bookingId  BigInt   @map("booking_id") @db.UnsignedBigInt
  eventType  String   @map("event_type") @db.VarChar(50)
  payload    Json
  published  Boolean  @default(false)
  createdAt  DateTime @default(now()) @map("created_at")

  @@index([published, createdAt], map: "idx_outbox_unpublished")
  @@map("booking_events_outbox")
}

model Hotel {
  id          BigInt    @id @default(autoincrement()) @db.UnsignedBigInt
  name        String    @db.VarChar(255)
  city        String    @db.VarChar(100)
  country     String    @db.Char(2)
  starRating  Int       @map("star_rating") @db.UnsignedTinyInt
  latitude    Decimal   @db.Decimal(10, 7)
  longitude   Decimal   @db.Decimal(10, 7)
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  rooms       Room[]
  bookings    Booking[]

  @@index([city], map: "idx_hotels_city")
  @@map("hotels")
}

model Room {
  id              BigInt    @id @default(autoincrement()) @db.UnsignedBigInt
  hotelId         BigInt    @map("hotel_id") @db.UnsignedBigInt
  roomType        String    @map("room_type") @db.VarChar(50)
  pricePerNight   Decimal   @map("price_per_night") @db.Decimal(10, 2)
  maxGuests       Int       @default(2) @map("max_guests") @db.UnsignedTinyInt
  amenities       Json?
  availableCount  Int       @default(1) @map("available_count") @db.UnsignedInt
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  hotel           Hotel     @relation(fields: [hotelId], references: [id])
  bookings        Booking[]

  @@index([hotelId], map: "idx_rooms_hotel")
  @@index([roomType], map: "idx_rooms_type")
  @@map("rooms")
}

enum BookingType {
  hotel
  flight
  car_rental
}

enum BookingStatus {
  pending
  confirmed
  cancelled
  completed
  refunded
}
```

### Writing a Booking with Prisma (Transactional Outbox)

Here is how the command side creates a booking, using Prisma's interactive transaction to atomically insert both the booking and the outbox event:

```typescript
// src/booking/commands/handlers/create-booking.handler.ts

async createBooking(command: CreateBookingCommand): Promise<Booking> {
  const { userId, hotelId, roomId, checkIn, checkOut, totalPrice, currency } = command;

  // Prisma interactive transaction: both writes succeed or both fail.
  // This is the Transactional Outbox pattern from Chapter 19.
  const booking = await this.prisma.$transaction(async (tx) => {
    // 1. Create the booking
    const newBooking = await tx.booking.create({
      data: {
        userId:       BigInt(userId),
        hotelId:      BigInt(hotelId),
        roomId:       BigInt(roomId),
        bookingType:  'hotel',
        status:       'pending',
        checkIn:      new Date(checkIn),
        checkOut:     new Date(checkOut),
        totalPrice:   totalPrice,
        currency:     currency,
        guestCount:   command.guestCount ?? 1,
        fencingToken: await this.fencingService.nextToken(),
      },
    });

    // 2. Write the event to the outbox (same transaction)
    await tx.bookingEventsOutbox.create({
      data: {
        bookingId:  newBooking.id,
        eventType:  'booking.created',
        payload: {
          bookingId:    newBooking.id.toString(),
          userId:       userId.toString(),
          hotelId:      hotelId.toString(),
          roomId:       roomId.toString(),
          bookingType:  'hotel',
          status:       'pending',
          checkIn:      checkIn,
          checkOut:     checkOut,
          totalPrice:   totalPrice,
          currency:     currency,
          timestamp:    new Date().toISOString(),
        },
        published: false,
      },
    });

    return newBooking;
  });

  return booking;
}
```

Both the booking and the outbox event are created in the same database transaction. If either fails, both roll back. The outbox publisher (a separate process) polls for `published = false` rows and sends them to Kafka. This guarantees that every booking write produces exactly one event, even if the application crashes between the write and the publish.

> **Checkpoint:** Before continuing, make sure you can answer these:
>
> 1. Why does the write model use minimal indexes?
> 2. What is the purpose of the `booking_events_outbox` table?
> 3. Why are the booking and the outbox event in the same transaction?
>
> If any of these are unclear, re-read the section above. The outbox pattern is the glue that connects the write model to the read model.

---

## The Read Model: Denormalized Elasticsearch

The read side is the opposite of the write side in every way. Where MySQL normalizes, Elasticsearch denormalizes. Where MySQL enforces constraints, Elasticsearch optimizes for speed. Where MySQL uses B-tree indexes for exact lookups, Elasticsearch uses inverted indexes for full-text search, geo-spatial queries, and faceted filtering.

Here is the Elasticsearch mapping for our booking read model:

```json
// Elasticsearch index mapping: bookings_read
// This is the "catalog" -- a flat, denormalized, query-optimized document.
{
  "mappings": {
    "properties": {
      "bookingId":      { "type": "keyword" },
      "userId":         { "type": "keyword" },
      "bookingType":    { "type": "keyword" },
      "status":         { "type": "keyword" },
      "totalAmount":    { "type": "scaled_float", "scaling_factor": 100 },
      "currency":       { "type": "keyword" },
      "createdAt":      { "type": "date" },
      "updatedAt":      { "type": "date" },

      "hotelName":      { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "hotelCity":      { "type": "keyword" },
      "hotelCountry":   { "type": "keyword" },
      "starRating":     { "type": "byte" },
      "roomType":       { "type": "keyword" },
      "amenities":      { "type": "keyword" },
      "guestCount":     { "type": "byte" },

      "location":       { "type": "geo_point" },

      "dates": {
        "properties": {
          "checkIn":    { "type": "date", "format": "yyyy-MM-dd" },
          "checkOut":   { "type": "date", "format": "yyyy-MM-dd" },
          "nights":     { "type": "short" }
        }
      },

      "guestName":      { "type": "text" },
      "guestEmail":     { "type": "keyword" },

      "pricePerNight":  { "type": "scaled_float", "scaling_factor": 100 }
    }
  },
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 2,
    "refresh_interval": "1s"
  }
}
```

Notice what happened: data that lives in four separate MySQL tables (`bookings`, `hotels`, `rooms`, `users`) is flattened into a single Elasticsearch document. The hotel name, city, location, room type, amenities, and guest name are all embedded directly in the booking document. This means a query like "show me all confirmed hotel bookings in Tokyo for user #42" hits a single index with zero joins.

Is data duplicated? Absolutely. The hotel name "Hilton Tokyo" appears in every booking document for that hotel, not just once in a `hotels` table. This is the deliberate trade: we trade storage efficiency for query speed. At scale, disk is cheap; latency is expensive.

### Read Model as a MySQL Denormalized Table (Alternative)

Not every read model needs Elasticsearch. For simpler query patterns -- like an admin dashboard that lists recent bookings with filtering -- a denormalized MySQL table works fine and keeps your operational complexity lower:

```sql
-- Alternative read model: a denormalized MySQL table
-- Use this for admin dashboards, reports, and simple filtered lists.

CREATE TABLE bookings_read_model (
    booking_id      BIGINT UNSIGNED PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    user_name       VARCHAR(255) NOT NULL,            -- denormalized from users table
    user_email      VARCHAR(255) NOT NULL,            -- denormalized from users table
    hotel_id        BIGINT UNSIGNED NOT NULL,
    hotel_name      VARCHAR(255) NOT NULL,            -- denormalized from hotels table
    hotel_city      VARCHAR(100) NOT NULL,            -- denormalized from hotels table
    hotel_country   CHAR(2) NOT NULL,                 -- denormalized from hotels table
    star_rating     TINYINT UNSIGNED NOT NULL,        -- denormalized from hotels table
    room_type       VARCHAR(50) NOT NULL,             -- denormalized from rooms table
    price_per_night DECIMAL(10, 2) NOT NULL,          -- denormalized from rooms table
    booking_type    ENUM('hotel', 'flight', 'car_rental') NOT NULL,
    status          ENUM('pending', 'confirmed', 'cancelled', 'completed', 'refunded') NOT NULL,
    check_in        DATE NOT NULL,
    check_out       DATE NOT NULL,
    nights          SMALLINT UNSIGNED NOT NULL,
    total_price     DECIMAL(12, 2) NOT NULL,
    currency        CHAR(3) NOT NULL,
    guest_count     TINYINT UNSIGNED NOT NULL,
    created_at      TIMESTAMP NOT NULL,
    updated_at      TIMESTAMP NOT NULL,

    -- Heavy indexes: optimize for every query the dashboard needs
    INDEX idx_read_user (user_id),
    INDEX idx_read_status (status),
    INDEX idx_read_city (hotel_city),
    INDEX idx_read_dates (check_in, check_out),
    INDEX idx_read_created (created_at),
    INDEX idx_read_hotel (hotel_id),
    FULLTEXT INDEX idx_read_hotel_name (hotel_name),
    INDEX idx_read_composite (status, hotel_city, check_in)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### Prisma Schema for the Read Model

```prisma
// prisma/schema-read.prisma — Read model (separate Prisma client)

datasource readDb {
  provider = "mysql"
  url      = env("READ_DATABASE_URL")
}

generator readClient {
  provider = "prisma-client-js"
  output   = "../generated/read-client"
}

model BookingReadModel {
  bookingId     BigInt          @id @map("booking_id") @db.UnsignedBigInt
  userId        BigInt          @map("user_id") @db.UnsignedBigInt
  userName      String          @map("user_name") @db.VarChar(255)
  userEmail     String          @map("user_email") @db.VarChar(255)
  hotelId       BigInt          @map("hotel_id") @db.UnsignedBigInt
  hotelName     String          @map("hotel_name") @db.VarChar(255)
  hotelCity     String          @map("hotel_city") @db.VarChar(100)
  hotelCountry  String          @map("hotel_country") @db.Char(2)
  starRating    Int             @map("star_rating") @db.UnsignedTinyInt
  roomType      String          @map("room_type") @db.VarChar(50)
  pricePerNight Decimal         @map("price_per_night") @db.Decimal(10, 2)
  bookingType   BookingType     @map("booking_type")
  status        BookingStatus
  checkIn       DateTime        @map("check_in") @db.Date
  checkOut      DateTime        @map("check_out") @db.Date
  nights        Int             @db.UnsignedSmallInt
  totalPrice    Decimal         @map("total_price") @db.Decimal(12, 2)
  currency      String          @db.Char(3)
  guestCount    Int             @map("guest_count") @db.UnsignedTinyInt
  createdAt     DateTime        @map("created_at")
  updatedAt     DateTime        @map("updated_at")

  @@index([userId], map: "idx_read_user")
  @@index([status], map: "idx_read_status")
  @@index([hotelCity], map: "idx_read_city")
  @@index([checkIn, checkOut], map: "idx_read_dates")
  @@index([createdAt], map: "idx_read_created")
  @@index([hotelId], map: "idx_read_hotel")
  @@index([status, hotelCity, checkIn], map: "idx_read_composite")
  @@map("bookings_read_model")
}

enum BookingType {
  hotel
  flight
  car_rental
}

enum BookingStatus {
  pending
  confirmed
  cancelled
  completed
  refunded
}
```

> **Key Term:** **Read Model** — A denormalized, query-optimized representation of the data. Unlike the write model (normalized MySQL tables), the read model stores data in exactly the shape that queries need, even if that means duplicating information across documents or rows. This eliminates expensive JOINs and enables sub-millisecond lookups.

---

## Projecting Events into Read Models: The Kafka Consumer

The **Event Projector** is the bridge between the write world and the read world. It consumes events from Kafka and transforms them into documents optimized for queries. Think of it as a translator: it takes the normalized, transactional language of MySQL and converts it into the denormalized, speed-optimized language of Elasticsearch.

```typescript
// src/projectors/booking-read-model.projector.ts

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { PrismaService } from '../prisma/prisma.service';
import { Kafka, Consumer, EachMessagePayload } from 'kafkajs';

@Injectable()
export class BookingReadModelProjector implements OnModuleInit {
  private readonly logger = new Logger(BookingReadModelProjector.name);
  private consumer: Consumer;

  constructor(
    private readonly elasticsearch: ElasticsearchService,
    private readonly prismaRead: PrismaService,   // Read model Prisma client
    private readonly prismaWrite: PrismaService,  // Write model Prisma client (for enrichment)
  ) {
    const kafka = new Kafka({
      clientId: 'booking-projector',
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    });
    this.consumer = kafka.consumer({ groupId: 'booking-read-model-projector' });
  }

  async onModuleInit(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: ['booking-events', 'inventory-events', 'payment-events'],
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        try {
          await this.handleMessage(payload);
        } catch (error) {
          this.logger.error(
            `Failed to project event: ${error.message}`,
            error.stack,
          );
          // In production, send to a dead letter queue (Chapter 21)
        }
      },
    });

    this.logger.log('Booking read model projector started');
  }

  private async handleMessage({ topic, message }: EachMessagePayload): Promise<void> {
    const event = JSON.parse(message.value.toString());
    const startTime = Date.now();

    switch (event.eventType) {
      case 'booking.created':
        await this.projectBookingCreated(event.payload);
        break;
      case 'booking.confirmed':
        await this.projectBookingStatusChanged(event.payload, 'confirmed');
        break;
      case 'booking.cancelled':
        await this.projectBookingStatusChanged(event.payload, 'cancelled');
        break;
      case 'booking.completed':
        await this.projectBookingStatusChanged(event.payload, 'completed');
        break;
      case 'inventory.updated':
        await this.projectInventoryUpdated(event.payload);
        break;
      case 'payment.completed':
        await this.projectPaymentCompleted(event.payload);
        break;
      default:
        this.logger.warn(`Unknown event type: ${event.eventType}`);
    }

    const duration = Date.now() - startTime;
    this.logger.debug(`Projected ${event.eventType} in ${duration}ms`);
  }

  // --- Individual projection handlers ---

  private async projectBookingCreated(payload: any): Promise<void> {
    // Enrich the event with data from the write model.
    // The event payload has IDs; we need names, locations, etc.
    const hotel = await this.prismaWrite.hotel.findUnique({
      where: { id: BigInt(payload.hotelId) },
    });
    const room = await this.prismaWrite.room.findUnique({
      where: { id: BigInt(payload.roomId) },
    });
    const user = await this.prismaWrite.user.findUnique({
      where: { id: BigInt(payload.userId) },
    });

    const checkIn = new Date(payload.checkIn);
    const checkOut = new Date(payload.checkOut);
    const nights = Math.ceil(
      (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24)
    );

    // 1. Write to Elasticsearch (for search queries)
    await this.elasticsearch.index({
      index: 'bookings',
      id: payload.bookingId.toString(),
      body: {
        bookingId:     payload.bookingId,
        userId:        payload.userId,
        bookingType:   payload.bookingType || 'hotel',
        status:        'pending',
        totalAmount:   payload.totalPrice,
        currency:      payload.currency || 'USD',
        createdAt:     payload.timestamp,
        updatedAt:     payload.timestamp,
        hotelName:     hotel?.name || 'Unknown Hotel',
        hotelCity:     hotel?.city || 'Unknown',
        hotelCountry:  hotel?.country || 'XX',
        starRating:    hotel?.starRating || 0,
        roomType:      room?.roomType || 'standard',
        amenities:     room?.amenities || [],
        guestCount:    payload.guestCount || 1,
        location: hotel ? {
          lat: parseFloat(hotel.latitude.toString()),
          lon: parseFloat(hotel.longitude.toString()),
        } : null,
        dates: {
          checkIn:  payload.checkIn,
          checkOut: payload.checkOut,
          nights:   nights,
        },
        guestName:     user?.fullName || 'Unknown Guest',
        guestEmail:    user?.email || '',
        pricePerNight: room?.pricePerNight || 0,
      },
    });

    // 2. Write to MySQL read model (for admin dashboards)
    await this.prismaRead.bookingReadModel.upsert({
      where: { bookingId: BigInt(payload.bookingId) },
      create: {
        bookingId:     BigInt(payload.bookingId),
        userId:        BigInt(payload.userId),
        userName:      user?.fullName || 'Unknown Guest',
        userEmail:     user?.email || '',
        hotelId:       BigInt(payload.hotelId),
        hotelName:     hotel?.name || 'Unknown Hotel',
        hotelCity:     hotel?.city || 'Unknown',
        hotelCountry:  hotel?.country || 'XX',
        starRating:    hotel?.starRating || 0,
        roomType:      room?.roomType || 'standard',
        pricePerNight: room?.pricePerNight || 0,
        bookingType:   'hotel',
        status:        'pending',
        checkIn:       checkIn,
        checkOut:      checkOut,
        nights:        nights,
        totalPrice:    payload.totalPrice,
        currency:      payload.currency || 'USD',
        guestCount:    payload.guestCount || 1,
        createdAt:     new Date(payload.timestamp),
        updatedAt:     new Date(payload.timestamp),
      },
      update: {}, // No update on conflict -- this is a create event
    });
  }

  private async projectBookingStatusChanged(
    payload: any,
    newStatus: string,
  ): Promise<void> {
    const now = new Date().toISOString();

    // Update Elasticsearch
    await this.elasticsearch.update({
      index: 'bookings',
      id: payload.bookingId.toString(),
      body: {
        doc: {
          status:    newStatus,
          updatedAt: now,
        },
      },
    });

    // Update MySQL read model
    await this.prismaRead.bookingReadModel.update({
      where: { bookingId: BigInt(payload.bookingId) },
      data: {
        status:    newStatus as any,
        updatedAt: new Date(now),
      },
    });
  }

  private async projectInventoryUpdated(payload: any): Promise<void> {
    // Update hotel search index with current availability
    await this.elasticsearch.update({
      index: 'hotels',
      id: payload.resourceId.toString(),
      body: {
        doc: {
          availableRooms: payload.availableQuantity,
          pricePerNight:  payload.basePrice,
          updatedAt:      new Date().toISOString(),
        },
      },
    });
  }

  private async projectPaymentCompleted(payload: any): Promise<void> {
    // When payment is confirmed, update the booking status
    await this.projectBookingStatusChanged(
      { bookingId: payload.bookingId },
      'confirmed',
    );
  }
}
```

> **Key Term:** **Event Projector** (also called a **Projection Handler**) — A component that listens for events from the write side and transforms them into documents in the read store. It "projects" the write model's data into the read model's format. The projector is stateless -- if it crashes, it can resume from its last Kafka offset and reprocess any missed events.

Notice the projector writes to **two** read models simultaneously: Elasticsearch (for search queries) and a MySQL denormalized table (for admin dashboards). This is a key benefit of CQRS: you can maintain multiple read models, each optimized for a different access pattern, all fed from the same stream of events.

---

## Full NestJS CQRS Implementation

NestJS provides a first-party CQRS module (`@nestjs/cqrs`) that gives you a structured way to implement commands, queries, events, and their handlers. Let us wire up the complete implementation.

### Installing the Module

```bash
npm install @nestjs/cqrs
```

### Module Setup

```typescript
// src/booking/booking.module.ts

import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { BookingController } from './booking.controller';
import { CreateBookingHandler } from './commands/handlers/create-booking.handler';
import { CancelBookingHandler } from './commands/handlers/cancel-booking.handler';
import { BookingCreatedHandler } from './events/handlers/booking-created.handler';
import { BookingCancelledHandler } from './events/handlers/booking-cancelled.handler';
import { GetUserBookingsHandler } from './queries/handlers/get-user-bookings.handler';
import { GetBookingDetailsHandler } from './queries/handlers/get-booking-details.handler';
import { PrismaModule } from '../prisma/prisma.module';
import { ElasticsearchModule } from '@nestjs/elasticsearch';

const CommandHandlers = [CreateBookingHandler, CancelBookingHandler];
const EventHandlers = [BookingCreatedHandler, BookingCancelledHandler];
const QueryHandlers = [GetUserBookingsHandler, GetBookingDetailsHandler];

@Module({
  imports: [
    CqrsModule,             // Provides CommandBus, QueryBus, EventBus
    PrismaModule,
    ElasticsearchModule.register({
      node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
    }),
  ],
  controllers: [BookingController],
  providers: [
    ...CommandHandlers,
    ...EventHandlers,
    ...QueryHandlers,
  ],
})
export class BookingModule {}
```

### Commands and Command Handlers

A **command** is a simple class that carries the data needed to perform a write operation. A **command handler** receives the command, executes the business logic, writes to the database, and publishes domain events.

```typescript
// src/booking/commands/impl/create-booking.command.ts

export class CreateBookingCommand {
  constructor(
    public readonly userId: string,
    public readonly hotelId: string,
    public readonly roomId: string,
    public readonly checkIn: string,      // "2026-03-15"
    public readonly checkOut: string,     // "2026-03-17"
    public readonly totalPrice: number,
    public readonly currency: string,
    public readonly guestCount: number,
  ) {}
}
```

```typescript
// src/booking/commands/impl/cancel-booking.command.ts

export class CancelBookingCommand {
  constructor(
    public readonly bookingId: string,
    public readonly userId: string,
    public readonly reason: string,
  ) {}
}
```

```typescript
// src/booking/commands/handlers/create-booking.handler.ts

import { CommandHandler, ICommandHandler, EventPublisher } from '@nestjs/cqrs';
import { CreateBookingCommand } from '../impl/create-booking.command';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingCreatedEvent } from '../../events/impl/booking-created.event';
import { Logger } from '@nestjs/common';

@CommandHandler(CreateBookingCommand)
export class CreateBookingHandler implements ICommandHandler<CreateBookingCommand> {
  private readonly logger = new Logger(CreateBookingHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: EventPublisher,
  ) {}

  async execute(command: CreateBookingCommand): Promise<any> {
    const { userId, hotelId, roomId, checkIn, checkOut, totalPrice, currency, guestCount } = command;

    this.logger.log(`Creating booking for user ${userId} at hotel ${hotelId}`);

    // 1. Validate: check room availability (strong consistency read from MySQL)
    const room = await this.prisma.room.findUnique({
      where: { id: BigInt(roomId) },
    });

    if (!room || room.availableCount <= 0) {
      throw new Error(`Room ${roomId} is not available`);
    }

    // 2. Write: create booking + outbox event in a single transaction
    const booking = await this.prisma.$transaction(async (tx) => {
      // Decrement room availability
      await tx.room.update({
        where: { id: BigInt(roomId) },
        data: { availableCount: { decrement: 1 } },
      });

      // Create the booking
      const newBooking = await tx.booking.create({
        data: {
          userId:       BigInt(userId),
          hotelId:      BigInt(hotelId),
          roomId:       BigInt(roomId),
          bookingType:  'hotel',
          status:       'pending',
          checkIn:      new Date(checkIn),
          checkOut:     new Date(checkOut),
          totalPrice:   totalPrice,
          currency:     currency,
          guestCount:   guestCount,
          fencingToken: Date.now(),  // Simplified; use a proper fencing service in production
        },
      });

      // Write to outbox (Transactional Outbox pattern)
      await tx.bookingEventsOutbox.create({
        data: {
          bookingId: newBooking.id,
          eventType: 'booking.created',
          payload: {
            bookingId:   newBooking.id.toString(),
            userId:      userId,
            hotelId:     hotelId,
            roomId:      roomId,
            bookingType: 'hotel',
            status:      'pending',
            checkIn:     checkIn,
            checkOut:    checkOut,
            totalPrice:  totalPrice,
            currency:    currency,
            guestCount:  guestCount,
            timestamp:   new Date().toISOString(),
          },
          published: false,
        },
      });

      return newBooking;
    });

    // 3. Publish in-process event (for NestJS event handlers)
    //    The Kafka event is published separately by the outbox publisher.
    const event = new BookingCreatedEvent(
      booking.id.toString(),
      userId,
      hotelId,
      roomId,
      checkIn,
      checkOut,
      totalPrice,
      currency,
    );

    // EventPublisher merges the event into the event bus
    this.publisher.mergeObjectContext(event);
    event.commit();

    this.logger.log(`Booking ${booking.id} created successfully`);
    return {
      bookingId: booking.id.toString(),
      status: 'pending',
      totalPrice: totalPrice,
      currency: currency,
    };
  }
}
```

### Events and Event Handlers

**Events** record that something happened. They are past-tense: `BookingCreatedEvent`, not `CreateBookingEvent`. **Event handlers** react to events -- they can update read models, send notifications, trigger workflows, or publish to external systems.

```typescript
// src/booking/events/impl/booking-created.event.ts
//
// NOTE: In DDD, events are simple value objects — they record that something
// happened. Only the Aggregate (e.g., Booking) should extend AggregateRoot,
// because the aggregate is the entity that applies and commits events.
// An event extending AggregateRoot is a common anti-pattern in NestJS CQRS
// tutorials. The correct approach is shown below: the event is a plain class,
// and the command handler uses EventBus.publish() to dispatch it.

import { IEvent } from '@nestjs/cqrs';

export class BookingCreatedEvent implements IEvent {
  constructor(
    public readonly bookingId: string,
    public readonly userId: string,
    public readonly hotelId: string,
    public readonly roomId: string,
    public readonly checkIn: string,
    public readonly checkOut: string,
    public readonly totalPrice: number,
    public readonly currency: string,
  ) {}
}
```

```typescript
// src/booking/events/impl/booking-cancelled.event.ts

export class BookingCancelledEvent {
  constructor(
    public readonly bookingId: string,
    public readonly userId: string,
    public readonly reason: string,
    public readonly cancelledAt: string,
  ) {}
}
```

```typescript
// src/booking/events/handlers/booking-created.handler.ts

import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { BookingCreatedEvent } from '../impl/booking-created.event';
import { Logger } from '@nestjs/common';

@EventsHandler(BookingCreatedEvent)
export class BookingCreatedHandler implements IEventHandler<BookingCreatedEvent> {
  private readonly logger = new Logger(BookingCreatedHandler.name);

  async handle(event: BookingCreatedEvent): Promise<void> {
    this.logger.log(`Handling BookingCreatedEvent for booking ${event.bookingId}`);

    // In-process side effects:
    // 1. Send confirmation email (or dispatch to a notification service)
    // 2. Update in-memory caches
    // 3. Emit WebSocket notification to the user's connected clients
    // 4. Track analytics

    // NOTE: The Kafka event projection (write → read model sync) happens
    // separately via the BookingReadModelProjector, NOT here.
    // This handler is for in-process side effects only.
  }
}
```
