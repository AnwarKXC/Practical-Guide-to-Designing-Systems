# Chapter 43: Schema Registry & Event Contracts — Agreeing on the Message Format

## The Problem You Have Never Thought About

In earlier chapters, you saw services communicate by publishing and consuming events through Kafka. The Booking Service publishes `booking.created`. The Payment Service, Notification Service, and Search Service each consume it and do their own thing. This works beautifully — until someone changes the shape of the event.

Let us make it concrete. You originally defined `booking.created` like this:

```typescript
// Version 1: the original event shape
{
  bookingId: 9876543210,
  userId: 42,
  bookingType: 'hotel',
  totalAmount: 880.00,
  currency: 'USD',
  timestamp: '2026-02-15T10:30:00Z'
}
```

Six months later, a product manager says "we need to track which marketing campaign led to the booking." A developer on the Booking Service team adds a required `campaignId` field:

```typescript
// Version 2: a developer adds campaignId as REQUIRED
{
  bookingId: 9876543210,
  userId: 42,
  bookingType: 'hotel',
  totalAmount: 880.00,
  currency: 'USD',
  timestamp: '2026-02-15T10:30:00Z',
  campaignId: 'SUMMER2026'       // <- new required field
}
```

Now the Booking Service publishes events with `campaignId`. But the Payment Service — maintained by a different team — still runs the old consumer code. It receives events with a field it does not expect. Depending on how it parses events, one of three things happens:

1. **Best case:** It ignores the unknown field and keeps working. No harm done.
2. **Medium case:** Its JSON schema validation rejects the event because of `additionalProperties: false`. The event goes to the dead letter queue. Payments stop processing.
3. **Worst case:** The consumer crashes. It restarts, reads the same event, crashes again. The consumer is stuck in a crash loop. Bookings accumulate in Kafka, unprocessed.

And it gets worse. What if instead of adding a field, the developer renames `totalAmount` to `total`? Or changes `bookingId` from a number to a string? Every consumer breaks silently. They read the field, get `undefined`, and pass garbage data downstream.

> **Analogy:** Imagine a company where departments communicate by paper memo. The Shipping department sends a memo with fields: "Order ID, Customer Name, Address." The Billing department reads these memos and processes invoices. One day, Shipping renames "Customer Name" to "Client Name" without telling Billing. Billing reads the memo, sees no "Customer Name" field, and either crashes (throws the memo away) or creates an invoice with a blank name. A schema registry is the company policy that says: "Before you change the memo format, you must register it with the central office, and the central office checks that your change will not break any department that reads your memos."

> **Key Term:** **Schema Registry** — A centralized service that stores, versions, and validates the schema (shape) of every event type in the system. It enforces compatibility rules that prevent producers from publishing breaking changes. Think of it as a gatekeeper that stands between your code and Kafka, refusing to let malformed or incompatible schemas through.

> **Key Term:** **Event Contract** — A formal agreement between a producer and its consumers about the exact structure, types, and semantics of the events exchanged. It is the API surface of asynchronous communication, just as an OpenAPI spec is the API surface of synchronous REST calls.

---

## Why Event Schemas Matter in Microservices

In a monolithic application, if you change a data structure, the compiler catches every place that depends on it. You rename a field, and the TypeScript compiler immediately shows you every file that references the old name. You fix them all, run the tests, and deploy one artifact. Done.

Microservices shatter this safety net. Each service is its own codebase, its own deployment, its own team. When the Booking Service changes an event, the compiler has no idea that the Payment Service — running in a separate container, maintained by a separate team, deployed on a separate schedule — depends on the old shape. There is no compile-time link between producer and consumer.

This creates what is known as **producer-consumer coupling**. Without schemas, the coupling is implicit and invisible:

```
┌──────────────────────────────────────────────────────────┐
│            IMPLICIT COUPLING (dangerous)                  │
│                                                           │
│   Booking Service          Kafka           Payment Svc    │
│   ┌──────────────┐    ┌────────────┐    ┌──────────────┐ │
│   │ Publishes:   │    │            │    │ Expects:     │ │
│   │ {            │───>│  Topic:    │───>│ {            │ │
│   │   bookingId  │    │  booking.  │    │   bookingId  │ │
│   │   total      │    │  created   │    │   totalAmount│ │ <- MISMATCH!
│   │   ...        │    │            │    │   ...        │ │
│   │ }            │    │            │    │ }            │ │
│   └──────────────┘    └────────────┘    └──────────────┘ │
│                                                           │
│   No mechanism catches this mismatch until runtime.       │
└──────────────────────────────────────────────────────────┘
```

With a schema registry, the coupling becomes explicit and enforced:

```
┌──────────────────────────────────────────────────────────┐
│            EXPLICIT COUPLING (safe)                       │
│                                                           │
│   Booking Service    Schema Registry       Payment Svc    │
│   ┌──────────────┐  ┌───────────────┐  ┌──────────────┐ │
│   │ Publishes v2 │─>│ Is v2 compat  │  │ Reads with   │ │
│   │ with schema  │  │ with v1?      │  │ v1 schema    │ │
│   │              │  │               │  │              │ │
│   │              │  │ YES: allow    │─>│ Deserialize  │ │
│   │              │  │ NO:  reject   │  │ safely       │ │
│   └──────────────┘  └───────────────┘  └──────────────┘ │
│                                                           │
│   Breaking change is caught BEFORE it reaches Kafka.      │
└──────────────────────────────────────────────────────────┘
```

The benefits multiply as your system grows:

| # of Services | # of Event Types | Possible Coupling Points | Without Schema Registry | With Schema Registry |
|---|---|---|---|---|
| 5 | 10 | 50 | Manageable (barely) | Overkill? No — start early |
| 20 | 60 | 1,200 | Incidents weekly | Automated safety |
| 50 | 200 | 10,000 | Chaos | Essential infrastructure |
| 100+ | 500+ | 50,000+ | Impossible to manage | The only way it works |

Our Global Booking System, processing 100K bookings per minute, has 47 services producing 183 event types consumed by an average of 4.2 consumers each. That is 769 coupling points. Without a schema registry, every one of these is a potential production incident waiting to happen.

> **What If You Skip This?** In the first month, nothing bad happens. Your team is small, everyone knows the event shapes, and changes are communicated on Slack. By month six, you have 20 developers across 4 teams. A developer on the analytics team changes an event "to make it cleaner," and three services break in production. The incident takes 14 hours to resolve because nobody knows which events are consumed by which services. By month twelve, your on-call engineers spend 40% of their time debugging event format mismatches. A schema registry costs a few days to set up. Skipping it costs you hundreds of engineering hours over the life of the system.

---

## Schema Evolution: Backward, Forward, and Full Compatibility

Not all schema changes are created equal. The schema registry enforces **compatibility rules** that determine which changes are safe. There are three levels of compatibility, and understanding them is critical.

### Backward Compatibility

**Definition:** A new schema (v2) is **backward compatible** if consumers using the new schema can still read data produced with the old schema (v1).

This is the most common and most important compatibility mode. It answers the question: "If I deploy the new consumer code, can it still process old events sitting in Kafka?"

```
Backward Compatible:
  New consumer (v2 code) reads old event (v1 data) → MUST work
  Old consumer (v1 code) reads new event (v2 data) → Not guaranteed

Rules:
  ✅ You CAN add optional fields (with defaults)
  ✅ You CAN delete optional fields
  ❌ You CANNOT delete required fields
  ❌ You CANNOT change field types
  ❌ You CANNOT rename fields
```

```typescript
// BACKWARD COMPATIBLE EXAMPLE

// Schema v1 (original)
interface BookingCreatedV1 {
  bookingId: number;
  userId: number;
  totalAmount: number;
  currency: string;
  timestamp: string;
}

// Schema v2 (backward compatible — new consumers can read v1 data)
interface BookingCreatedV2 {
  bookingId: number;
  userId: number;
  totalAmount: number;
  currency: string;
  timestamp: string;
  guestEmail?: string;    // Added as OPTIONAL — v1 events just won't have it
  loyaltyTier?: string;   // Added as OPTIONAL with known default
}

// Consumer v2 handles both old and new events:
function processBooking(event: BookingCreatedV1 | BookingCreatedV2) {
  const email = ('guestEmail' in event && event.guestEmail)
    ? event.guestEmail
    : null; // Gracefully handles v1 events without guestEmail

  const tier = ('loyaltyTier' in event && event.loyaltyTier)
    ? event.loyaltyTier
    : 'standard'; // Default for v1 events
}
```

### Forward Compatibility

**Definition:** A new schema (v2) is **forward compatible** if consumers using the old schema (v1) can still read data produced with the new schema (v2).

This is the reverse perspective. It answers the question: "If I deploy the new producer code, will old consumers that haven't upgraded yet still work?"

```
Forward Compatible:
  Old consumer (v1 code) reads new event (v2 data) → MUST work
  New consumer (v2 code) reads old event (v1 data) → Not guaranteed

Rules:
  ✅ You CAN add fields (old consumers ignore them)
  ✅ You CAN delete optional fields
  ❌ You CANNOT delete fields that old consumers require
  ❌ You CANNOT change field types
```

```typescript
// FORWARD COMPATIBLE EXAMPLE
// Old consumer code encounters new event shape

// Old consumer expects v1:
interface BookingCreatedV1 {
  bookingId: number;
  userId: number;
  totalAmount: number;
  currency: string;
  timestamp: string;
}

// New producer sends v2 (with extra fields):
const v2Event = {
  bookingId: 9876543210,
  userId: 42,
  totalAmount: 880.00,
  currency: 'USD',
  timestamp: '2026-02-15T10:30:00Z',
  guestEmail: 'alice@example.com',  // Old consumer ignores this
  loyaltyTier: 'gold',              // Old consumer ignores this
};

// Old consumer (v1 code) processes v2 event:
// It reads bookingId, userId, totalAmount, currency, timestamp — all present.
// It ignores guestEmail and loyaltyTier — they are unknown but harmless.
// KEY REQUIREMENT: consumer must NOT use `additionalProperties: false`
// in its local validation, or it will reject the unknown fields.
```

### Full Compatibility

**Definition:** A schema change is **fully compatible** if it is BOTH backward AND forward compatible. Consumers using any version of the schema can read data produced with any other version.

```
Full Compatible:
  New consumer (v2 code) reads old event (v1 data) → MUST work
  Old consumer (v1 code) reads new event (v2 data) → MUST work

Rules:
  ✅ You CAN add optional fields with defaults
  ❌ You CANNOT delete any fields
  ❌ You CANNOT change field types
  ❌ You CANNOT add required fields
  ❌ You CANNOT rename fields
```

This is the strictest mode, and it is what we use for our Global Booking System. Here is why: at 100K bookings per minute, we cannot coordinate simultaneous deployment of all 47 services. At any given moment, some services run v1 consumers and some run v2 consumers. We need both to work simultaneously.

```typescript
// Compatibility mode comparison
const compatibilityModes = {
  BACKWARD: {
    description: 'New consumers can read old data',
    use_when: 'You control consumer deployment order',
    our_system: false,
  },
  FORWARD: {
    description: 'Old consumers can read new data',
    use_when: 'You control producer deployment order',
    our_system: false,
  },
  FULL: {
    description: 'Any consumer reads any producer version',
    use_when: 'You cannot coordinate deployment order',
    our_system: true, // <-- This is what we use
  },
  NONE: {
    description: 'No compatibility checking',
    use_when: 'Never in production. Only for development/testing',
    our_system: false,
  },
};
```

> **Analogy:** Think of compatibility like language evolution. Backward compatibility is like adding new slang to a language — young people (new consumers) understand both old formal speech and new slang. Forward compatibility is like making sure old speakers still understand the gist of what young people say, even if they do not know every new word. Full compatibility means everyone — old and young — can communicate perfectly regardless of which "version" of the language they speak. That is the gold standard, and it requires discipline.

> **Common Mistake:** Teams often set their schema registry to `BACKWARD` compatibility and assume that is enough. But consider this: you deploy the new producer (v2 events) at 10:00 AM. The consumer team deploys their v2-compatible consumer at 2:00 PM. For four hours, the old consumer (v1 code) processes new events (v2 data). If your change is only backward compatible (not forward compatible), those four hours produce silent data corruption. Always use `FULL` compatibility unless you have a specific reason not to and can guarantee deployment order.

---

## Confluent Schema Registry: Setup and Configuration

The Confluent Schema Registry is the industry standard for managing event schemas with Kafka. It runs as a separate service alongside your Kafka brokers, storing schemas in a special Kafka topic (`_schemas`) for durability.

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    Production Setup                         │
│                                                             │
│  ┌─────────────┐     ┌──────────────────┐     ┌─────────┐ │
│  │  Producer    │────>│  Schema Registry  │<────│Consumer │ │
│  │  (Booking    │     │  (3 instances,    │     │(Payment │ │
│  │   Service)   │     │   HA cluster)     │     │ Service)│ │
│  └──────┬───────┘     └────────┬─────────┘     └────┬────┘ │
│         │                      │                     │      │
│         v                      v                     v      │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Kafka Cluster (5 brokers)                  │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐ │ │
│  │  │ booking. │  │ payment. │  │ _schemas (internal   │ │ │
│  │  │ created  │  │ processed│  │  topic for registry) │ │ │
│  │  └──────────┘  └──────────┘  └──────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### Docker Compose Configuration

```yaml
# docker-compose.schema-registry.yml
version: '3.8'
services:
  schema-registry:
    image: confluentinc/cp-schema-registry:7.6.0
    hostname: schema-registry
    container_name: schema-registry
    depends_on:
      - kafka-broker-1
      - kafka-broker-2
      - kafka-broker-3
    ports:
      - "8081:8081"
    environment:
      # Where to find Kafka brokers
      SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: >-
        kafka-broker-1:9092,kafka-broker-2:9092,kafka-broker-3:9092

      # Host name for this instance
      SCHEMA_REGISTRY_HOST_NAME: schema-registry

      # Listener configuration
      SCHEMA_REGISTRY_LISTENERS: http://0.0.0.0:8081

      # DEFAULT compatibility mode for all subjects
      # FULL means both backward AND forward compatible
      SCHEMA_REGISTRY_SCHEMA_COMPATIBILITY_LEVEL: FULL

      # Use Avro as the default schema type
      # (can be overridden per subject)
      SCHEMA_REGISTRY_SCHEMA_PROVIDERS: avro,json,protobuf

      # Authentication (REQUIRED in production)
      SCHEMA_REGISTRY_AUTHENTICATION_METHOD: BASIC
      SCHEMA_REGISTRY_AUTHENTICATION_ROLES: admin,developer,readonly
      SCHEMA_REGISTRY_AUTHENTICATION_REALM: SchemaRegistry

      # Heap size — tune based on number of schemas
      SCHEMA_REGISTRY_HEAP_OPTS: "-Xms512m -Xmx512m"

      # Leader election — only one instance writes to _schemas
      SCHEMA_REGISTRY_LEADER_ELIGIBILITY: "true"

    # Health check: the registry exposes a REST API
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/subjects"]
      interval: 10s
      timeout: 5s
      retries: 5

    # Resource limits for production
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 1G
        reservations:
          cpus: '0.5'
          memory: 512M
```

### Production Configuration (Kubernetes)

```yaml
# k8s/schema-registry-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: schema-registry
  namespace: kafka-platform
  labels:
    app: schema-registry
    tier: infrastructure
spec:
  replicas: 3  # HA: 3 instances, only 1 is leader
  selector:
    matchLabels:
      app: schema-registry
  template:
    metadata:
      labels:
        app: schema-registry
    spec:
      # Anti-affinity: spread across availability zones
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchExpressions:
                  - key: app
                    operator: In
                    values: [schema-registry]
              topologyKey: topology.kubernetes.io/zone
      containers:
        - name: schema-registry
          image: confluentinc/cp-schema-registry:7.6.0
          ports:
            - containerPort: 8081
          env:
            - name: SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS
              valueFrom:
                configMapKeyRef:
                  name: kafka-config
                  key: bootstrap.servers
            - name: SCHEMA_REGISTRY_SCHEMA_COMPATIBILITY_LEVEL
              value: "FULL"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /subjects
              port: 8081
            initialDelaySeconds: 15
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /subjects
              port: 8081
            initialDelaySeconds: 30
            periodSeconds: 15
```

### REST API Basics

The Schema Registry exposes a REST API for managing schemas:

```bash
# List all registered subjects (schema names)
curl http://schema-registry:8081/subjects
# Response: ["booking.created-value", "payment.processed-value", ...]

# Register a new schema for a subject
curl -X POST http://schema-registry:8081/subjects/booking.created-value/versions \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"BookingCreated\",\"fields\":[...]}"}'
# Response: {"id": 1}

# Get the latest schema for a subject
curl http://schema-registry:8081/subjects/booking.created-value/versions/latest
# Response: {"subject":"booking.created-value","version":2,"id":1,"schema":"..."}

# Test compatibility of a new schema against the latest version
curl -X POST http://schema-registry:8081/compatibility/subjects/booking.created-value/versions/latest \
  -H "Content-Type: application/vnd.schemaregistry.v1+json" \
  -d '{"schema": "{\"type\":\"record\",\"name\":\"BookingCreated\",\"fields\":[...]}"}'
# Response: {"is_compatible": true}  or  {"is_compatible": false}

# Get the compatibility level for a subject
curl http://schema-registry:8081/config/booking.created-value
# Response: {"compatibilityLevel": "FULL"}
```

> **Key Term:** **Subject** — In the Schema Registry, a subject is the scope under which schemas are registered. By default, subjects follow the naming convention `<topic-name>-value` for the message value and `<topic-name>-key` for the message key. The subject `booking.created-value` contains all versions of the schema for events on the `booking.created` topic.

---

## Avro vs JSON Schema vs Protobuf: Choosing Your Schema Format

The Schema Registry supports three schema formats. Each has tradeoffs. Here is an honest comparison based on our experience running all three in different parts of the Global Booking System.

### Side-by-Side Comparison

| Criteria | Avro | JSON Schema | Protobuf |
|---|---|---|---|
| **Binary size** | Compact (no field names in payload) | Large (full JSON with field names) | Very compact (field tags, varint encoding) |
| **Schema evolution** | Excellent (built-in) | Good (with discipline) | Excellent (built-in) |
| **Human readability** | Requires deserialization | Readable as-is (it is JSON) | Requires deserialization |
| **TypeScript support** | Fair (avsc library) | Excellent (native JSON) | Good (protobufjs, ts-proto) |
| **Debugging ease** | Hard (binary on the wire) | Easy (read raw Kafka messages) | Hard (binary on the wire) |
| **Schema Registry support** | First-class | Full support | Full support |
| **Performance (ser/deser)** | Fast | Slow (JSON parsing) | Fastest |
| **Kafka ecosystem fit** | Best (Confluent default) | Good | Good |
| **Learning curve** | Medium | Low | Medium-High |
| **Our recommendation** | Core booking events | API-facing events, debugging | Cross-language gRPC services |

### Avro: The Kafka-Native Choice

Avro is Confluent's default and the most popular choice for Kafka event schemas. It was designed for data serialization with schema evolution in mind.

```json
{
  "type": "record",
  "name": "BookingCreated",
  "namespace": "com.globalbooking.events",
  "doc": "Emitted when a new booking is successfully created",
  "fields": [
    {
      "name": "bookingId",
      "type": "long",
      "doc": "Unique identifier for the booking"
    },
    {
      "name": "userId",
      "type": "long",
      "doc": "ID of the user who created the booking"
    },
    {
      "name": "bookingType",
      "type": {
        "type": "enum",
        "name": "BookingType",
        "symbols": ["HOTEL", "FLIGHT", "CAR"]
      },
      "doc": "Type of booking"
    },
    {
      "name": "totalAmount",
      "type": {
        "type": "bytes",
        "logicalType": "decimal",
        "precision": 10,
        "scale": 2
      },
      "doc": "Total amount in minor currency units"
    },
    {
      "name": "currency",
      "type": "string",
      "doc": "ISO 4217 currency code"
    },
    {
      "name": "timestamp",
      "type": {
        "type": "long",
        "logicalType": "timestamp-millis"
      },
      "doc": "When the booking was created (epoch millis)"
    },
    {
      "name": "guestEmail",
      "type": ["null", "string"],
      "default": null,
      "doc": "Optional guest email for notifications"
    }
  ]
}
```

**Why Avro works well for Kafka:**
- The schema is stored in the registry, not in every message. Each Kafka message carries only a 5-byte header (magic byte + 4-byte schema ID) followed by the compact binary payload. At 100K messages per minute, this saves gigabytes of bandwidth daily.
- Schema evolution rules (backward, forward, full) are built into the Avro specification, not bolted on.
- The union type `["null", "string"]` elegantly expresses optional fields with explicit defaults.

### JSON Schema: The Readable Choice

JSON Schema describes the structure of JSON documents. Since Kafka messages are often JSON, this is a natural fit for teams that prioritize debugging and readability.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://globalbooking.com/schemas/booking-created.v1.json",
  "title": "BookingCreated",
  "description": "Emitted when a new booking is successfully created",
  "type": "object",
  "required": ["bookingId", "userId", "bookingType", "totalAmount",
               "currency", "timestamp"],
  "properties": {
    "bookingId": {
      "type": "integer",
      "minimum": 1,
      "description": "Unique identifier for the booking"
    },
    "userId": {
      "type": "integer",
      "minimum": 1,
      "description": "ID of the user who created the booking"
    },
    "bookingType": {
      "type": "string",
      "enum": ["hotel", "flight", "car"],
      "description": "Type of booking"
    },
    "totalAmount": {
      "type": "number",
      "minimum": 0,
      "description": "Total booking amount"
    },
    "currency": {
      "type": "string",
      "pattern": "^[A-Z]{3}$",
      "description": "ISO 4217 currency code"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of booking creation"
    },
    "guestEmail": {
      "type": "string",
      "format": "email",
      "description": "Optional guest email for notifications"
    }
  },
  "additionalProperties": true  // IMPORTANT: must be true for forward compatibility
}
```

**Why JSON Schema is useful:**
- You can read raw Kafka messages without any deserialization tool. When debugging a production incident at 3 AM, this matters enormously.
- Every developer already knows JSON. No learning curve.
- Rich validation: `pattern`, `format`, `minimum`, `maximum`, `minLength`, `enum`. These catch bad data that Avro and Protobuf schemas cannot express.

**The downside:** Every message includes field names as strings. A `bookingId` field costs 11 bytes per message (the string `"bookingId":`) versus 0 bytes in Avro (field identified by position) or 1-2 bytes in Protobuf (field identified by tag number). At 100K messages per minute, this adds roughly 100 MB per hour of unnecessary bandwidth for a single field name across a single event type.

### Protobuf: The Performance Choice

Protocol Buffers (Protobuf) by Google offer the best serialization performance and the most compact binary format.

```protobuf
syntax = "proto3";

package com.globalbooking.events;

// Emitted when a new booking is successfully created
message BookingCreated {
  int64 booking_id = 1;        // Field tag 1
  int64 user_id = 2;           // Field tag 2
  BookingType booking_type = 3; // Field tag 3
  int64 total_amount_cents = 4; // Amount in cents to avoid float
  string currency = 5;          // ISO 4217
  int64 timestamp_ms = 6;       // Epoch milliseconds
  optional string guest_email = 7; // Optional in proto3

  enum BookingType {
    BOOKING_TYPE_UNSPECIFIED = 0;
    HOTEL = 1;
    FLIGHT = 2;
    CAR = 3;
  }
}
```

**Why Protobuf excels:**
- Fastest serialization and deserialization of the three formats.
- Smallest wire size thanks to varint encoding and field tags.
- Excellent cross-language code generation (Go, Java, Python, TypeScript).
- If you already use gRPC between services, Protobuf for events creates consistency.

**The downside:** Requires code generation from `.proto` files. Adds a build step. Debugging raw binary messages requires `protoc --decode` or similar tooling.

### Our Decision for the Global Booking System

We use a pragmatic mix:

```typescript
const schemaFormatDecisions = {
  // Core high-volume events: Avro for compact binary + native evolution
  'booking.created': 'avro',
  'booking.confirmed': 'avro',
  'booking.cancelled': 'avro',
  'payment.processed': 'avro',
  'inventory.reserved': 'avro',

  // Analytics/reporting events: JSON Schema for readability
  'analytics.page_view': 'json-schema',
  'analytics.search_performed': 'json-schema',
  'audit.action_logged': 'json-schema',

  // Cross-service RPC-style events: Protobuf for performance + gRPC alignment
  'pricing.quote_requested': 'protobuf',
  'pricing.quote_calculated': 'protobuf',
};
```

> **Checkpoint:** Before proceeding, make sure you can answer: "Why would you choose Avro over JSON Schema for a topic that processes 50K events per second?" The answer: Avro's binary encoding omits field names from the payload, reducing message size by 40-60%. At 50K events/sec, this translates to gigabytes of saved bandwidth per hour and measurably lower Kafka broker disk and network utilization.

---

## Defining Event Schemas for Booking Events

Our Global Booking System has four core booking lifecycle events. Each represents a state transition in the booking saga (see Chapter 28). Let us define complete Avro schemas for all four.

### booking.created

```json
{
  "type": "record",
  "name": "BookingCreated",
  "namespace": "com.globalbooking.events.booking",
  "doc": "Emitted by the Booking Service when a new booking is persisted. Triggers inventory reservation, payment processing, and notification workflows.",
  "fields": [
    {
      "name": "eventId",
      "type": "string",
      "doc": "Unique event identifier (UUID v4) for idempotency"
    },
    {
      "name": "eventVersion",
      "type": "int",
      "default": 1,
      "doc": "Schema version for this event type"
    },
    {
      "name": "bookingId",
      "type": "long",
      "doc": "Globally unique booking identifier"
    },
    {
      "name": "userId",
      "type": "long",
      "doc": "ID of the user who initiated the booking"
    },
    {
      "name": "bookingType",
      "type": {
        "type": "enum",
        "name": "BookingType",
        "symbols": ["HOTEL", "FLIGHT", "CAR"]
      }
    },
    {
      "name": "totalAmountCents",
      "type": "long",
      "doc": "Total amount in the smallest currency unit (cents for USD)"
    },
    {
      "name": "currency",
      "type": "string",
      "doc": "ISO 4217 currency code (e.g., USD, EUR, JPY)"
    },
    {
      "name": "region",
      "type": "string",
      "doc": "Geographic region for shard routing (e.g., us-east-1)"
    },
    {
      "name": "createdAt",
      "type": { "type": "long", "logicalType": "timestamp-millis" },
      "doc": "Epoch milliseconds when the booking was created"
    },
    {
      "name": "checkIn",
      "type": ["null", "string"],
      "default": null,
      "doc": "Check-in date (ISO 8601) for hotel bookings, null for others"
    },
    {
      "name": "checkOut",
      "type": ["null", "string"],
      "default": null,
      "doc": "Check-out date (ISO 8601) for hotel bookings, null for others"
    },
    {
      "name": "guestEmail",
      "type": ["null", "string"],
      "default": null,
      "doc": "Guest email for sending confirmation (optional)"
    },
    {
      "name": "correlationId",
      "type": "string",
      "doc": "Distributed tracing correlation ID for end-to-end observability"
    }
  ]
}
```

### booking.confirmed

```json
{
  "type": "record",
  "name": "BookingConfirmed",
  "namespace": "com.globalbooking.events.booking",
  "doc": "Emitted when payment is verified and inventory is confirmed. The booking is now guaranteed.",
  "fields": [
    {
      "name": "eventId",
      "type": "string"
    },
    {
      "name": "eventVersion",
      "type": "int",
      "default": 1
    },
    {
      "name": "bookingId",
      "type": "long",
      "doc": "References the booking from BookingCreated"
    },
    {
      "name": "userId",
      "type": "long"
    },
    {
      "name": "paymentTransactionId",
      "type": "string",
      "doc": "ID of the successful payment transaction"
    },
    {
      "name": "inventoryFencingToken",
      "type": "long",
      "doc": "Fencing token proving inventory was reserved (see Chapter 15)"
    },
    {
      "name": "confirmedAt",
      "type": { "type": "long", "logicalType": "timestamp-millis" }
    },
    {
      "name": "estimatedFulfillmentAt",
      "type": ["null", { "type": "long", "logicalType": "timestamp-millis" }],
      "default": null,
      "doc": "When the booking is expected to be fulfilled (check-in, departure, etc.)"
    },
    {
      "name": "correlationId",
      "type": "string"
    }
  ]
}
```

### booking.cancelled

```json
{
  "type": "record",
  "name": "BookingCancelled",
  "namespace": "com.globalbooking.events.booking",
  "doc": "Emitted when a booking is cancelled by the user, system timeout, or payment failure. Triggers refund and inventory release.",
  "fields": [
    {
      "name": "eventId",
      "type": "string"
    },
    {
      "name": "eventVersion",
      "type": "int",
      "default": 1
    },
    {
      "name": "bookingId",
      "type": "long"
    },
    {
      "name": "userId",
      "type": "long"
    },
    {
      "name": "cancellationReason",
      "type": {
        "type": "enum",
        "name": "CancellationReason",
        "symbols": [
          "USER_REQUESTED",
          "PAYMENT_FAILED",
          "INVENTORY_UNAVAILABLE",
          "SYSTEM_TIMEOUT",
          "FRAUD_DETECTED",
          "DUPLICATE_BOOKING"
        ]
      },
      "doc": "Why the booking was cancelled"
    },
    {
      "name": "cancelledBy",
      "type": {
        "type": "enum",
        "name": "CancellationActor",
        "symbols": ["USER", "SYSTEM", "ADMIN"]
      },
      "doc": "Who initiated the cancellation"
    },
    {
      "name": "refundAmountCents",
      "type": "long",
      "doc": "Refund amount in smallest currency unit (may be partial)"
    },
    {
      "name": "currency",
      "type": "string"
    },
    {
      "name": "cancelledAt",
      "type": { "type": "long", "logicalType": "timestamp-millis" }
    },
    {
      "name": "correlationId",
      "type": "string"
    }
  ]
}
```

### booking.modified

```json
{
  "type": "record",
  "name": "BookingModified",
  "namespace": "com.globalbooking.events.booking",
  "doc": "Emitted when a confirmed booking is modified (date change, room upgrade, etc.). Triggers re-validation of inventory and potential price adjustment.",
  "fields": [
    {
      "name": "eventId",
      "type": "string"
    },
    {
      "name": "eventVersion",
      "type": "int",
      "default": 1
    },
    {
      "name": "bookingId",
      "type": "long"
    },
    {
      "name": "userId",
      "type": "long"
    },
    {
      "name": "modificationType",
      "type": {
        "type": "enum",
        "name": "ModificationType",
        "symbols": [
          "DATE_CHANGE",
          "ROOM_UPGRADE",
          "GUEST_COUNT_CHANGE",
          "ADD_ON_SERVICE",
          "SPECIAL_REQUEST"
        ]
      }
    },
    {
      "name": "previousAmountCents",
      "type": "long",
      "doc": "Amount before modification"
    },
    {
      "name": "newAmountCents",
      "type": "long",
      "doc": "Amount after modification"
    },
    {
      "name": "currency",
      "type": "string"
    },
    {
      "name": "changeDescription",
      "type": "string",
      "doc": "Human-readable description of what changed"
    },
    {
      "name": "modifiedAt",
      "type": { "type": "long", "logicalType": "timestamp-millis" }
    },
    {
      "name": "requiresPaymentAdjustment",
      "type": "boolean",
      "doc": "True if the modification changes the total amount"
    },
    {
      "name": "correlationId",
      "type": "string"
    }
  ]
}
```

Notice the patterns across all four schemas:

1. **Every event has an `eventId`** — a UUID that enables idempotent processing. If a consumer receives the same event twice (Kafka guarantees at-least-once delivery), it can detect the duplicate.
2. **Every event has an `eventVersion`** — an integer that tells consumers which version of the schema produced this event.
3. **Every event has a `correlationId`** — a distributed tracing ID that lets you follow a booking's journey across all services (see Chapter 38).
4. **Money is always in cents** (`totalAmountCents`, not `totalAmount: 8.80`) — this avoids floating-point precision errors that plague financial systems.
5. **Enums are explicit** — `CancellationReason`, `ModificationType`, `BookingType` are all closed sets. This prevents garbage values from entering the system.

> **Common Mistake:** Defining money as a floating-point number (`"type": "number"`) instead of an integer representing cents. JavaScript's `0.1 + 0.2 === 0.30000000000000004`. In a system processing 100K bookings per minute, floating-point errors compound. After a million transactions, your accounting is off by thousands of dollars. Always use integers for money: `88000` cents instead of `880.00` dollars.

---

## Schema Validation in Kafka Producers and Consumers

Schemas are only useful if they are enforced. Validation must happen in two places: before the producer publishes (to prevent bad data from entering Kafka) and after the consumer reads (to protect against corruption that bypasses the producer).

### Producer-Side Validation (The Primary Gate)

```typescript
import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

export class ProducerSchemaValidator {
  private ajv: Ajv;
  private validators: Map<string, ValidateFunction> = new Map();

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,        // Report ALL errors, not just the first
      strict: true,           // Strict mode catches more issues
      coerceTypes: false,     // Never silently convert types
      removeAdditional: false // Never silently strip unknown fields
    });
    addFormats(this.ajv);     // Add support for 'date-time', 'email', etc.
  }

  /**
   * Register a schema for a given event type.
   * Called at service startup to pre-compile validators.
   */
  registerSchema(eventType: string, jsonSchema: object): void {
    const validate = this.ajv.compile(jsonSchema);
    this.validators.set(eventType, validate);
  }

  /**
   * Validate an event payload before publishing.
   * Returns detailed errors if validation fails.
   */
  validate(eventType: string, payload: unknown): ValidationResult {
    const validate = this.validators.get(eventType);

    if (!validate) {
      return {
        valid: false,
        errors: [{
          field: 'eventType',
          message: `No schema registered for event type: ${eventType}`,
          value: eventType,
        }],
      };
    }

    const valid = validate(payload);

    if (valid) {
      return { valid: true, errors: [] };
    }

    // Transform AJV errors into our domain-specific error format
    const errors = (validate.errors || []).map(err => ({
      field: err.instancePath || err.schemaPath,
      message: err.message || 'Unknown validation error',
      value: err.data,
      keyword: err.keyword, // e.g., 'required', 'type', 'enum'
    }));

    return { valid: false, errors };
  }
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
  keyword?: string;
}
```

### Consumer-Side Validation (The Safety Net)

Even with producer validation, consumers should validate too. Why? Because:
1. A bug in the producer could bypass validation.
2. Someone could publish directly to Kafka using the CLI (bypassing the application layer).
3. A schema might have been registered incorrectly.
4. Data corruption can occur in transit (rare but possible).

```typescript
export class ConsumerSchemaValidator {
  private validator: ProducerSchemaValidator;
  private deadLetterProducer: KafkaProducer;
  private metrics: MetricsClient;

  constructor(
    validator: ProducerSchemaValidator,
    deadLetterProducer: KafkaProducer,
    metrics: MetricsClient,
  ) {
    this.validator = validator;
    this.deadLetterProducer = deadLetterProducer;
    this.metrics = metrics;
  }

  /**
   * Validate a consumed message. If invalid, route to dead letter topic.
   * Returns the parsed payload if valid, null if invalid.
   */
  async validateConsumedMessage(
    topic: string,
    message: KafkaMessage,
  ): Promise<{ payload: unknown; valid: boolean }> {
    let payload: unknown;

    // STEP 1: Parse the raw message
    try {
      payload = JSON.parse(message.value!.toString());
    } catch (parseError) {
      // Message is not valid JSON — cannot recover
      await this.routeToDeadLetter(topic, message, [{
        field: 'root',
        message: `JSON parse error: ${(parseError as Error).message}`,
      }]);
      this.metrics.increment('consumer.schema.parse_error', { topic });
      return { payload: null, valid: false };
    }

    // STEP 2: Validate against schema
    const result = this.validator.validate(topic, payload);

    if (result.valid) {
      this.metrics.increment('consumer.schema.valid', { topic });
      return { payload, valid: true };
    }

    // STEP 3: Validation failed — route to dead letter
    await this.routeToDeadLetter(topic, message, result.errors);
    this.metrics.increment('consumer.schema.invalid', { topic });

    return { payload, valid: false };
  }

  private async routeToDeadLetter(
    originalTopic: string,
    message: KafkaMessage,
    errors: ValidationError[],
  ): Promise<void> {
    await this.deadLetterProducer.send({
      topic: `${originalTopic}.dlq`,
      messages: [{
        key: message.key,
        value: JSON.stringify({
          originalTopic,
          originalPartition: message.partition,
          originalOffset: message.offset,
          originalTimestamp: message.timestamp,
          originalPayload: message.value?.toString(),
          validationErrors: errors,
          routedAt: new Date().toISOString(),
          routeReason: 'SCHEMA_VALIDATION_FAILURE',
        }),
        headers: {
          'x-original-topic': originalTopic,
          'x-error-type': 'schema-validation',
          'x-routed-at': new Date().toISOString(),
        },
      }],
    });
  }
}
```

The critical insight bears repeating: **catching a malformed event at the producer is a log line. Catching it at the consumer is a production incident.** Producer-side validation is the primary gate. Consumer-side validation is the safety net that catches what slips through.

> **Analogy:** Producer validation is like airport security before boarding — catch the problem before the passenger is on the plane. Consumer validation is like the marshal on the plane — a last line of defense that should rarely need to act, but must be there for the cases where security fails.

---

## Full TypeScript Implementation: Schema Registry Client

Now let us build a production-grade Schema Registry client that communicates with the Confluent Schema Registry REST API. This client handles schema registration, retrieval, caching, and compatibility checking.

```typescript
// src/schema-registry/schema-registry-client.ts
import axios, { AxiosInstance, AxiosError } from 'axios';
import { LRUCache } from 'lru-cache';

export interface SchemaMetadata {
  id: number;           // Global schema ID assigned by the registry
  version: number;      // Version within the subject
  subject: string;      // Subject name (e.g., 'booking.created-value')
  schema: string;       // The schema definition as a JSON string
  schemaType: 'AVRO' | 'JSON' | 'PROTOBUF';
}

export interface CompatibilityResult {
  isCompatible: boolean;
  messages?: string[];   // Reasons if not compatible
}

export class SchemaRegistryClient {
  private http: AxiosInstance;
  private schemaCache: LRUCache<number, string>;      // schema ID -> schema
  private idCache: LRUCache<string, number>;           // subject+schema -> ID
  private versionCache: LRUCache<string, SchemaMetadata>; // subject -> latest

  constructor(
    private readonly registryUrl: string,
    private readonly options: {
      auth?: { username: string; password: string };
      cacheMaxSize?: number;
      cacheTtlMs?: number;
      timeoutMs?: number;
      retries?: number;
    } = {},
  ) {
    this.http = axios.create({
      baseURL: registryUrl,
      timeout: options.timeoutMs || 5000,
      headers: { 'Content-Type': 'application/vnd.schemaregistry.v1+json' },
      auth: options.auth,
    });

    const cacheOptions = {
      max: options.cacheMaxSize || 1000,
      ttl: options.cacheTtlMs || 5 * 60 * 1000, // 5 minutes default
    };

    this.schemaCache = new LRUCache<number, string>(cacheOptions);
    this.idCache = new LRUCache<string, number>(cacheOptions);
    this.versionCache = new LRUCache<string, SchemaMetadata>(cacheOptions);
  }

  /**
   * Register a schema for a subject. Returns the global schema ID.
   * If the schema already exists, returns the existing ID (idempotent).
   */
  async registerSchema(
    subject: string,
    schema: string,
    schemaType: 'AVRO' | 'JSON' | 'PROTOBUF' = 'AVRO',
  ): Promise<number> {
    // Check cache first
    const cacheKey = `${subject}:${schema}`;
    const cachedId = this.idCache.get(cacheKey);
    if (cachedId !== undefined) {
      return cachedId;
    }

    const response = await this.withRetry(async () => {
      return this.http.post(`/subjects/${subject}/versions`, {
        schema,
        schemaType,
      });
    });

    const schemaId = response.data.id;

    // Cache the result
    this.idCache.set(cacheKey, schemaId);
    this.schemaCache.set(schemaId, schema);

    return schemaId;
  }

  /**
   * Get a schema by its global ID.
   * Used by consumers to deserialize messages.
   */
  async getSchemaById(schemaId: number): Promise<string> {
    // Check cache first
    const cached = this.schemaCache.get(schemaId);
    if (cached) {
      return cached;
    }

    const response = await this.withRetry(async () => {
      return this.http.get(`/schemas/ids/${schemaId}`);
    });

    const schema = response.data.schema;
    this.schemaCache.set(schemaId, schema);

    return schema;
  }

  /**
   * Get the latest schema version for a subject.
   */
  async getLatestSchema(subject: string): Promise<SchemaMetadata> {
    const cached = this.versionCache.get(subject);
    if (cached) {
      return cached;
    }

    const response = await this.withRetry(async () => {
      return this.http.get(`/subjects/${subject}/versions/latest`);
    });

    const metadata: SchemaMetadata = {
      id: response.data.id,
      version: response.data.version,
      subject: response.data.subject,
      schema: response.data.schema,
      schemaType: response.data.schemaType || 'AVRO',
    };

    this.versionCache.set(subject, metadata);
    return metadata;
  }

  /**
   * Check if a new schema is compatible with the latest version.
   * CALL THIS BEFORE registerSchema to avoid rejected registrations.
   */
  async checkCompatibility(
    subject: string,
    schema: string,
    schemaType: 'AVRO' | 'JSON' | 'PROTOBUF' = 'AVRO',
  ): Promise<CompatibilityResult> {
    try {
      const response = await this.http.post(
        `/compatibility/subjects/${subject}/versions/latest`,
        { schema, schemaType },
      );
      return {
        isCompatible: response.data.is_compatible,
        messages: response.data.messages,
      };
    } catch (error) {
      if ((error as AxiosError).response?.status === 404) {
        // Subject does not exist yet — first schema is always compatible
        return { isCompatible: true };
      }
      throw error;
    }
  }

  /**
   * List all registered subjects.
   */
  async listSubjects(): Promise<string[]> {
    const response = await this.withRetry(async () => {
      return this.http.get('/subjects');
    });
    return response.data;
  }

  /**
   * Get or set the compatibility level for a subject.
   */
  async getCompatibilityLevel(subject: string): Promise<string> {
    const response = await this.http.get(`/config/${subject}`);
    return response.data.compatibilityLevel;
  }

  async setCompatibilityLevel(
    subject: string,
    level: 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE',
  ): Promise<void> {
    await this.http.put(`/config/${subject}`, {
      compatibility: level,
    });
  }

  /**
   * Retry wrapper for transient failures (network, 5xx, etc.)
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    retries: number = this.options.retries || 3,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        const status = (error as AxiosError).response?.status;

        // Don't retry client errors (4xx) — they won't succeed on retry
        if (status && status >= 400 && status < 500) {
          throw error;
        }

        // Exponential backoff with jitter
        if (attempt < retries) {
          const delay = Math.min(
            1000 * Math.pow(2, attempt) + Math.random() * 1000,
            10000,
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}
```

### Serializer and Deserializer

The serializer wraps messages with the schema ID header (Confluent wire format), and the deserializer extracts the schema ID to look up the correct schema for deserialization.

```typescript
// src/schema-registry/avro-serializer.ts
import avro from 'avsc';

// Confluent wire format:
// Byte 0:     Magic byte (0x00)
// Bytes 1-4:  Schema ID (big-endian 32-bit integer)
// Bytes 5+:   Avro-encoded payload

const MAGIC_BYTE = 0x00;

export class AvroSerializer {
  private registryClient: SchemaRegistryClient;
  private typeCache: Map<number, avro.Type> = new Map();

  constructor(registryClient: SchemaRegistryClient) {
    this.registryClient = registryClient;
  }

  /**
   * Serialize a payload using the registered Avro schema.
   * Returns a Buffer in Confluent wire format.
   */
  async serialize(
    subject: string,
    payload: Record<string, unknown>,
    schema: string,
  ): Promise<Buffer> {
    // Step 1: Register the schema (idempotent — returns existing ID if found)
    const schemaId = await this.registryClient.registerSchema(
      subject, schema, 'AVRO'
    );

    // Step 2: Compile the Avro type
    const avroType = this.getOrCompileType(schemaId, schema);

    // Step 3: Encode the payload as Avro binary
    const avroBuffer = avroType.toBuffer(payload);

    // Step 4: Prepend the Confluent wire format header
    const header = Buffer.alloc(5);
    header.writeUInt8(MAGIC_BYTE, 0);
    header.writeUInt32BE(schemaId, 1);

    return Buffer.concat([header, avroBuffer]);
  }

  /**
   * Deserialize a Confluent wire format message back into an object.
   * Uses the embedded schema ID to fetch the correct schema.
   */
  async deserialize(buffer: Buffer): Promise<{
    schemaId: number;
    payload: Record<string, unknown>;
  }> {
    // Step 1: Validate magic byte
    if (buffer[0] !== MAGIC_BYTE) {
      throw new Error(
        `Invalid magic byte: expected ${MAGIC_BYTE}, got ${buffer[0]}. ` +
        'This message was not serialized with the Confluent wire format.'
      );
    }

    // Step 2: Extract schema ID from bytes 1-4
    const schemaId = buffer.readUInt32BE(1);

    // Step 3: Fetch the schema from the registry
    const schemaStr = await this.registryClient.getSchemaById(schemaId);
    const avroType = this.getOrCompileType(schemaId, schemaStr);

    // Step 4: Decode the Avro payload (bytes 5+)
    const payload = avroType.fromBuffer(buffer.subarray(5));

    return { schemaId, payload };
  }

  private getOrCompileType(schemaId: number, schema: string): avro.Type {
    let type = this.typeCache.get(schemaId);
    if (!type) {
      type = avro.Type.forSchema(JSON.parse(schema));
      this.typeCache.set(schemaId, type);
    }
    return type;
  }
}
```

### Usage Example: Publishing a Booking Event

```typescript
// Putting it all together: publishing a booking.created event
const registryClient = new SchemaRegistryClient(
  'http://schema-registry:8081',
  {
    auth: { username: 'booking-service', password: process.env.SR_PASSWORD! },
    cacheMaxSize: 500,
    cacheTtlMs: 5 * 60 * 1000,
  },
);

const serializer = new AvroSerializer(registryClient);

// The Avro schema for booking.created (loaded from file or constant)
const bookingCreatedSchema = JSON.stringify({
  type: 'record',
  name: 'BookingCreated',
  namespace: 'com.globalbooking.events.booking',
  fields: [
    { name: 'eventId', type: 'string' },
    { name: 'bookingId', type: 'long' },
    { name: 'userId', type: 'long' },
    { name: 'totalAmountCents', type: 'long' },
    { name: 'currency', type: 'string' },
    { name: 'createdAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
    { name: 'correlationId', type: 'string' },
  ],
});

async function publishBookingCreated(booking: Booking): Promise<void> {
  const payload = {
    eventId: crypto.randomUUID(),
    bookingId: booking.id,
    userId: booking.userId,
    totalAmountCents: booking.totalAmountCents,
    currency: booking.currency,
    createdAt: Date.now(),
    correlationId: getCorrelationId(), // From request context
  };

  // Serialize with Avro + wire format
  const buffer = await serializer.serialize(
    'booking.created-value',
    payload,
    bookingCreatedSchema,
  );

  // Publish to Kafka
  await kafkaProducer.send({
    topic: 'booking.created',
    messages: [{
      key: String(booking.id), // Partition by booking ID
      value: buffer,
    }],
  });
}
```

> **What If You Skip This?** Without a proper serializer/deserializer, teams serialize events with `JSON.stringify()` and deserialize with `JSON.parse()`. This works until someone changes a field type. `JSON.parse` happily returns whatever was in the message — no validation, no type checking, no warning. The first sign of trouble is a `TypeError: Cannot read property 'amount' of undefined` in the consumer, which could be hours after the malformed event was published. A proper Avro serializer catches type mismatches at serialization time.

---

## NestJS Kafka Module with Schema Validation Middleware

In the Global Booking System, we use NestJS as our application framework. Here is a complete module that integrates Kafka with schema validation, so every service gets validation out of the box without writing boilerplate.

### The Schema-Validated Kafka Module

```typescript
// src/kafka/schema-validated-kafka.module.ts
import { Module, DynamicModule, Global } from '@nestjs/common';
import { SchemaRegistryClient } from '../schema-registry/schema-registry-client';
import { AvroSerializer } from '../schema-registry/avro-serializer';
import { SchemaValidatedProducer } from './schema-validated-producer';
import { SchemaValidatedConsumer } from './schema-validated-consumer';

export interface KafkaModuleOptions {
  brokers: string[];
  schemaRegistryUrl: string;
  schemaRegistryAuth?: { username: string; password: string };
  clientId: string;
  groupId: string;
  compatibilityLevel?: 'BACKWARD' | 'FORWARD' | 'FULL' | 'NONE';
}

@Global()
@Module({})
export class SchemaValidatedKafkaModule {
  static forRoot(options: KafkaModuleOptions): DynamicModule {
    const registryClientProvider = {
      provide: 'SCHEMA_REGISTRY_CLIENT',
      useFactory: () => {
        return new SchemaRegistryClient(options.schemaRegistryUrl, {
          auth: options.schemaRegistryAuth,
          cacheMaxSize: 500,
          cacheTtlMs: 5 * 60 * 1000,
          timeoutMs: 5000,
          retries: 3,
        });
      },
    };

    const serializerProvider = {
      provide: 'AVRO_SERIALIZER',
      useFactory: (registryClient: SchemaRegistryClient) => {
        return new AvroSerializer(registryClient);
      },
      inject: ['SCHEMA_REGISTRY_CLIENT'],
    };

    const producerProvider = {
      provide: SchemaValidatedProducer,
      useFactory: (
        registryClient: SchemaRegistryClient,
        serializer: AvroSerializer,
      ) => {
        return new SchemaValidatedProducer(
          options.brokers,
          options.clientId,
          registryClient,
          serializer,
        );
      },
      inject: ['SCHEMA_REGISTRY_CLIENT', 'AVRO_SERIALIZER'],
    };

    return {
      module: SchemaValidatedKafkaModule,
      providers: [
        registryClientProvider,
        serializerProvider,
        producerProvider,
      ],
      exports: [
        SchemaValidatedProducer,
        'SCHEMA_REGISTRY_CLIENT',
        'AVRO_SERIALIZER',
      ],
    };
  }
}
```

### The Schema-Validated Producer

```typescript
// src/kafka/schema-validated-producer.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { SchemaRegistryClient } from '../schema-registry/schema-registry-client';
import { AvroSerializer } from '../schema-registry/avro-serializer';

interface SchemaDefinition {
  subject: string;
  schema: string;
  schemaType: 'AVRO' | 'JSON' | 'PROTOBUF';
}

@Injectable()
export class SchemaValidatedProducer implements OnModuleInit, OnModuleDestroy {
  private producer: Producer;
  private schemas: Map<string, SchemaDefinition> = new Map();
  private readonly logger = new Logger(SchemaValidatedProducer.name);

  constructor(
    brokers: string[],
    clientId: string,
    private readonly registryClient: SchemaRegistryClient,
    private readonly serializer: AvroSerializer,
  ) {
    const kafka = new Kafka({ clientId, brokers });
    this.producer = kafka.producer({
      idempotent: true,                   // Exactly-once semantics
      maxInFlightRequests: 5,             // Max concurrent requests
      transactionTimeout: 30000,          // 30 seconds
    });
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.logger.log('Schema-validated Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    this.logger.log('Schema-validated Kafka producer disconnected');
  }

  /**
   * Register an event schema. Call this at startup for each event type
   * the service produces.
   */
  registerEventSchema(
    eventType: string,
    schema: string,
    schemaType: 'AVRO' | 'JSON' | 'PROTOBUF' = 'AVRO',
  ): void {
    this.schemas.set(eventType, {
      subject: `${eventType}-value`,
      schema,
      schemaType,
    });
    this.logger.log(`Registered schema for event type: ${eventType}`);
  }

  /**
   * Publish an event with full schema validation.
   * Throws if the schema is not registered or the payload is invalid.
   */
  async publish<T extends Record<string, unknown>>(
    eventType: string,
    payload: T,
    key?: string,
  ): Promise<void> {
    const schemaDef = this.schemas.get(eventType);
    if (!schemaDef) {
      throw new Error(
        `No schema registered for event type: ${eventType}. ` +
        `Call registerEventSchema() first. Registered types: ` +
        `${Array.from(this.schemas.keys()).join(', ')}`,
      );
    }

    // Step 1: Check compatibility with registry (cached, fast path)
    // This is done lazily on first publish, not on registration
    const compat = await this.registryClient.checkCompatibility(
      schemaDef.subject,
      schemaDef.schema,
      schemaDef.schemaType,
    );

    if (!compat.isCompatible) {
      throw new Error(
        `Schema for ${eventType} is not compatible with the registry. ` +
        `Reasons: ${compat.messages?.join(', ')}`,
      );
    }

    // Step 2: Serialize with Avro (includes schema ID in wire format)
    const value = await this.serializer.serialize(
      schemaDef.subject,
      payload,
      schemaDef.schema,
    );

    // Step 3: Publish to Kafka
    await this.producer.send({
      topic: eventType,
      compression: CompressionTypes.LZ4,     // Compress for throughput
      messages: [{
        key: key || null,
        value,
        headers: {
          'x-event-type': eventType,
          'x-schema-version': String(
            (await this.registryClient.getLatestSchema(schemaDef.subject)).version
          ),
          'x-produced-at': new Date().toISOString(),
        },
      }],
    });

    this.logger.debug(`Published ${eventType} event`, { key });
  }
}
```

### The Schema-Validated Consumer Decorator

```typescript
// src/kafka/schema-validated-consumer.decorator.ts
import { SetMetadata } from '@nestjs/common';

export interface EventHandlerOptions {
  topic: string;
  schemaSubject: string;          // Subject in the registry
  groupId?: string;               // Override the module-level group ID
  fromBeginning?: boolean;        // Start from earliest offset
  maxRetries?: number;            // Retries before dead-lettering
  deadLetterTopic?: string;       // Override default DLQ topic
}

export const EVENT_HANDLER_METADATA = 'EVENT_HANDLER_METADATA';

// Decorator: marks a method as a schema-validated event handler
export function OnEvent(options: EventHandlerOptions): MethodDecorator {
  return SetMetadata(EVENT_HANDLER_METADATA, options);
}

// Usage in a service:
// @OnEvent({
//   topic: 'booking.created',
//   schemaSubject: 'booking.created-value',
//   maxRetries: 3,
// })
// async handleBookingCreated(event: BookingCreatedEvent): Promise<void> {
//   // The event is already validated and deserialized
//   await this.processBooking(event);
// }
```

### Middleware: Schema Validation Interceptor

```typescript
// src/kafka/schema-validation.interceptor.ts
import { Injectable, Logger } from '@nestjs/common';
import { AvroSerializer } from '../schema-registry/avro-serializer';

@Injectable()
export class SchemaValidationInterceptor {
  private readonly logger = new Logger(SchemaValidationInterceptor.name);

  constructor(
    private readonly serializer: AvroSerializer,
    private readonly deadLetterProducer: SchemaValidatedProducer,
  ) {}

  /**
   * Interceptor that wraps every consumer message handler.
   * Deserializes, validates, and routes failures to DLQ.
   */
  async intercept(
    topic: string,
    message: KafkaMessage,
    handler: (payload: unknown) => Promise<void>,
    options: { maxRetries: number; deadLetterTopic: string },
  ): Promise<void> {
    let payload: unknown;

    // STEP 1: Deserialize the message using the schema from the registry
    try {
      const result = await this.serializer.deserialize(
        message.value as Buffer,
      );
      payload = result.payload;
    } catch (deserializationError) {
      this.logger.error(
        `Deserialization failed for message on topic ${topic}`,
        {
          error: (deserializationError as Error).message,
          partition: message.partition,
          offset: message.offset,
        },
      );

      await this.routeToDeadLetter(
        topic,
        message,
        'DESERIALIZATION_FAILURE',
        (deserializationError as Error).message,
        options.deadLetterTopic,
      );
      return;
    }

    // STEP 2: Call the handler with the deserialized payload
    let attempts = 0;
    while (attempts <= options.maxRetries) {
      try {
        await handler(payload);
        return; // Success — exit the retry loop
      } catch (handlerError) {
        attempts++;
        this.logger.warn(
          `Handler failed for ${topic} (attempt ${attempts}/${options.maxRetries + 1})`,
          { error: (handlerError as Error).message },
        );

        if (attempts > options.maxRetries) {
          // Exhausted retries — route to dead letter
          await this.routeToDeadLetter(
            topic,
            message,
            'HANDLER_FAILURE',
            (handlerError as Error).message,
            options.deadLetterTopic,
          );
        } else {
          // Exponential backoff before retry
          await new Promise(r =>
            setTimeout(r, Math.pow(2, attempts) * 1000)
          );
        }
      }
    }
  }

  private async routeToDeadLetter(
    originalTopic: string,
    message: KafkaMessage,
    reason: string,
    errorMessage: string,
    deadLetterTopic: string,
  ): Promise<void> {
    await this.deadLetterProducer.publish(
      deadLetterTopic || `${originalTopic}.dlq`,
      {
        originalTopic,
        originalOffset: message.offset,
        originalPartition: message.partition,
        originalValue: message.value?.toString('base64'),
        errorReason: reason,
        errorMessage,
        routedAt: Date.now(),
      },
    );
  }
}
```

### Registering the Module in a Service

```typescript
// src/app.module.ts (in the Booking Service)
import { Module } from '@nestjs/common';
import { SchemaValidatedKafkaModule } from './kafka/schema-validated-kafka.module';

@Module({
  imports: [
    SchemaValidatedKafkaModule.forRoot({
      brokers: ['kafka-1:9092', 'kafka-2:9092', 'kafka-3:9092'],
      schemaRegistryUrl: 'http://schema-registry:8081',
      schemaRegistryAuth: {
        username: 'booking-service',
        password: process.env.SCHEMA_REGISTRY_PASSWORD!,
      },
      clientId: 'booking-service',
      groupId: 'booking-service-group',
      compatibilityLevel: 'FULL',
    }),
    // ... other modules
  ],
})
export class AppModule {}
```

> **Key Term:** **Wire Format** — The binary encoding used to transmit messages over a network. The Confluent wire format prepends a 5-byte header (1 magic byte + 4-byte schema ID) to every Kafka message. This allows consumers to look up the exact schema used to serialize the message, even if the schema has evolved since the message was produced. Without this header, consumers would have to guess which schema version to use.

---

## Versioning Events: v1 to v2 Migration Without Breaking Consumers

This is where theory meets reality. Let us walk through a real migration scenario step by step. The product team wants to add a `loyaltyTier` field and a `promoCode` field to `booking.created`. The loyalty team needs `loyaltyTier` to determine point multipliers, and the marketing team needs `promoCode` for attribution.

### Step 1: Assess the Change

```typescript
// Current schema (v1) — what is in production today
const bookingCreatedV1 = {
  type: 'record',
  name: 'BookingCreated',
  namespace: 'com.globalbooking.events.booking',
  fields: [
    { name: 'eventId', type: 'string' },
    { name: 'eventVersion', type: 'int', default: 1 },
    { name: 'bookingId', type: 'long' },
    { name: 'userId', type: 'long' },
    { name: 'totalAmountCents', type: 'long' },
    { name: 'currency', type: 'string' },
    { name: 'createdAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
    { name: 'correlationId', type: 'string' },
  ],
};

// Proposed schema (v2) — adding loyaltyTier and promoCode
const bookingCreatedV2 = {
  type: 'record',
  name: 'BookingCreated',
  namespace: 'com.globalbooking.events.booking',
  fields: [
    // All existing fields remain EXACTLY as they are
    { name: 'eventId', type: 'string' },
    { name: 'eventVersion', type: 'int', default: 2 },  // Default updated
    { name: 'bookingId', type: 'long' },
    { name: 'userId', type: 'long' },
    { name: 'totalAmountCents', type: 'long' },
    { name: 'currency', type: 'string' },
    { name: 'createdAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
    { name: 'correlationId', type: 'string' },

    // NEW fields — MUST be optional with defaults for FULL compatibility
    {
      name: 'loyaltyTier',
      type: ['null', 'string'],
      default: null,    // <-- CRITICAL: default value makes it backward compatible
      doc: 'Loyalty tier of the booking user (e.g., gold, platinum)'
    },
    {
      name: 'promoCode',
      type: ['null', 'string'],
      default: null,    // <-- CRITICAL: default value makes it forward compatible
      doc: 'Promotional code applied to this booking'
    },
  ],
};
```

### Step 2: Validate Compatibility Programmatically

```typescript
// Run this in a CI/CD pipeline to catch incompatible changes before merge
async function validateSchemaEvolution(): Promise<void> {
  const registry = new SchemaRegistryClient('http://schema-registry:8081');

  const subject = 'booking.created-value';
  const newSchema = JSON.stringify(bookingCreatedV2);

  // Check compatibility against the latest registered version
  const result = await registry.checkCompatibility(subject, newSchema, 'AVRO');

  if (!result.isCompatible) {
    console.error('SCHEMA EVOLUTION CHECK FAILED');
    console.error('Incompatible changes detected:');
    result.messages?.forEach(msg => console.error(`  - ${msg}`));
    process.exit(1);  // Fail the CI pipeline
  }

  console.log('Schema evolution check passed — change is FULL compatible');
}
```

### Step 3: Deploy in the Correct Order

```
Timeline for safe v1 → v2 migration:
═══════════════════════════════════════════════════════════════

Day 1: Register v2 schema in the registry
        └── The registry validates FULL compatibility
        └── No running code is affected yet

Day 2: Deploy consumers that handle BOTH v1 and v2
        └── Payment Service: ignores loyaltyTier and promoCode
        └── Loyalty Service: reads loyaltyTier, defaults to null
        └── Notification Service: reads promoCode, defaults to null
        └── All consumers still process v1 events perfectly

Day 3: Deploy the Booking Service producer with v2 schema
        └── New events now include loyaltyTier and promoCode
        └── v1 consumers (if any stragglers remain) ignore new fields
        └── v2 consumers use the new fields

Day 4: Verify in production
        └── Monitor DLQ for schema validation failures: should be zero
        └── Check consumer lag: should be stable
        └── Verify loyalty points are being calculated
        └── Verify promo attribution is working

Day 7: Old v1 events age out of Kafka retention (7-day default)
        └── All events in Kafka are now v2
        └── Full migration complete
```

### Step 4: Consumer Code That Handles Both Versions

```typescript
// In the Loyalty Service — must work with both v1 and v2 events

interface BookingCreatedV1 {
  eventId: string;
  eventVersion: number;
  bookingId: number;
  userId: number;
  totalAmountCents: number;
  currency: string;
  createdAt: number;
  correlationId: string;
}

interface BookingCreatedV2 extends BookingCreatedV1 {
  loyaltyTier: string | null;
  promoCode: string | null;
}

type BookingCreatedEvent = BookingCreatedV1 | BookingCreatedV2;

class LoyaltyPointsHandler {
  async handleBookingCreated(event: BookingCreatedEvent): Promise<void> {
    // Safely extract v2 fields with defaults for v1 events
    const loyaltyTier = 'loyaltyTier' in event && event.loyaltyTier
      ? event.loyaltyTier
      : 'standard'; // Default: if we don't know the tier, use standard

    const promoCode = 'promoCode' in event && event.promoCode
      ? event.promoCode
      : null; // Default: no promo

    // Calculate points based on tier
    const multiplier = this.getTierMultiplier(loyaltyTier);
    const basePoints = Math.floor(event.totalAmountCents / 100);
    const totalPoints = basePoints * multiplier;

    // Apply promo bonus if applicable
    const promoBonus = promoCode
      ? await this.getPromoBonus(promoCode)
      : 0;

    await this.creditPoints(event.userId, totalPoints + promoBonus, {
      bookingId: event.bookingId,
      correlationId: event.correlationId,
    });

    this.logger.log('Loyalty points credited', {
      userId: event.userId,
      bookingId: event.bookingId,
      tier: loyaltyTier,
      points: totalPoints + promoBonus,
      eventVersion: event.eventVersion,
    });
  }

  private getTierMultiplier(tier: string): number {
    const multipliers: Record<string, number> = {
      standard: 1,
      silver: 1.5,
      gold: 2,
      platinum: 3,
    };
    return multipliers[tier] || 1; // Unknown tier = standard fallback
  }
}
```

> **Common Mistake:** Deploying the producer before the consumers. If you deploy the v2 producer first, it starts publishing events with new fields. If any consumer uses `additionalProperties: false` in its local validation (or has a strict deserialization step), those events are rejected. Always deploy consumers first — they should already handle unknown fields gracefully. Then deploy the producer.

---

## Dead Letter Routing for Schema Validation Failures

When a consumer encounters a message it cannot deserialize or validate, it has two options: crash (and block all subsequent messages on that partition) or skip the message and move on. Neither is acceptable. Crashing creates a cascade failure. Skipping loses data silently.

The solution is a **dead letter queue (DLQ)**: a separate Kafka topic where invalid messages are routed for later investigation and reprocessing.

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 Dead Letter Queue Architecture                   │
│                                                                  │
│  booking.created topic                                           │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐                    │
│  │ msg1 │ msg2 │ BAD  │ msg4 │ BAD  │ msg6 │                    │
│  │  ✓   │  ✓   │  ✗   │  ✓   │  ✗   │  ✓   │                    │
│  └──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴──┬───┘                    │
│     │      │      │      │      │      │                         │
│     v      v      │      v      │      v                         │
│  ┌──────────────┐ │  ┌────────┐ │  ┌────────┐                   │
│  │   Payment    │ │  │Loyalty │ │  │Notific.│                    │
│  │   Service    │ │  │Service │ │  │Service │                    │
│  └──────────────┘ │  └────────┘ │  └────────┘                   │
│                   │             │                                 │
│                   v             v                                 │
│  booking.created.dlq topic                                       │
│  ┌──────────────────────────────────────────────────┐            │
│  │ { originalMsg: BAD, errors: [...], routedAt: T } │            │
│  │ { originalMsg: BAD, errors: [...], routedAt: T } │            │
│  └────────────────────────┬─────────────────────────┘            │
│                           │                                      │
│                    ┌──────v─────────┐                             │
│                    │  DLQ Dashboard │                             │
│                    │  - Inspect     │                             │
│                    │  - Reprocess   │                             │
│                    │  - Discard     │                             │
│                    └────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Dead Letter Queue Service

```typescript
// src/kafka/dead-letter-queue.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Kafka, Producer, Consumer, KafkaMessage } from 'kafkajs';

interface DeadLetterEntry {
  // Original message metadata
  originalTopic: string;
  originalPartition: number;
  originalOffset: string;
  originalKey: string | null;
  originalTimestamp: string;
  originalHeaders: Record<string, string>;

  // The original message value (base64 for binary, string for JSON)
  originalValue: string;
  originalValueEncoding: 'base64' | 'utf8';

  // Error information
  errorType: 'DESERIALIZATION' | 'SCHEMA_VALIDATION' | 'HANDLER_EXCEPTION';
  errorMessage: string;
  errorDetails: unknown;

  // Routing metadata
  routedAt: string;
  consumerGroupId: string;
  consumerServiceName: string;
  retryCount: number;
}

@Injectable()
export class DeadLetterQueueService {
  private producer: Producer;
  private readonly logger = new Logger(DeadLetterQueueService.name);

  constructor(brokers: string[], clientId: string) {
    const kafka = new Kafka({ clientId: `${clientId}-dlq`, brokers });
    this.producer = kafka.producer();
  }

  async initialize(): Promise<void> {
    await this.producer.connect();
  }

  /**
   * Route a failed message to its dead letter topic.
   */
  async routeToDeadLetter(
    originalTopic: string,
    message: KafkaMessage,
    error: {
      type: DeadLetterEntry['errorType'];
      message: string;
      details?: unknown;
    },
    context: {
      consumerGroupId: string;
      serviceName: string;
      retryCount: number;
    },
  ): Promise<void> {
    const dlqTopic = `${originalTopic}.dlq`;

    const entry: DeadLetterEntry = {
      originalTopic,
      originalPartition: message.partition,
      originalOffset: message.offset,
      originalKey: message.key?.toString() || null,
      originalTimestamp: message.timestamp,
      originalHeaders: this.headersToRecord(message.headers),
      originalValue: message.value
        ? message.value.toString('base64')
        : '',
      originalValueEncoding: 'base64',
      errorType: error.type,
      errorMessage: error.message,
      errorDetails: error.details,
      routedAt: new Date().toISOString(),
      consumerGroupId: context.consumerGroupId,
      consumerServiceName: context.serviceName,
      retryCount: context.retryCount,
    };

    await this.producer.send({
      topic: dlqTopic,
      messages: [{
        key: message.key,
        value: JSON.stringify(entry),
        headers: {
          'x-dlq-reason': error.type,
          'x-original-topic': originalTopic,
          'x-routed-at': entry.routedAt,
          'x-retry-count': String(context.retryCount),
        },
      }],
    });

    this.logger.warn('Message routed to dead letter queue', {
      dlqTopic,
      originalTopic,
      originalOffset: message.offset,
      errorType: error.type,
      errorMessage: error.message,
    });

    // Emit metric for monitoring
    // Grafana alerts fire when DLQ rate exceeds threshold
  }

  /**
   * Reprocess messages from a dead letter topic.
   * Used by operators to retry after fixing the root cause.
   */
  async reprocessDeadLetters(
    dlqTopic: string,
    filter?: {
      errorType?: DeadLetterEntry['errorType'];
      since?: Date;
      maxMessages?: number;
    },
  ): Promise<{ processed: number; failed: number }> {
    const kafka = new Kafka({ clientId: 'dlq-reprocessor', brokers: brokerUrls }); // brokerUrls injected from config
    const consumer = kafka.consumer({ groupId: 'dlq-reprocessor' });

    await consumer.connect();
    await consumer.subscribe({ topic: dlqTopic, fromBeginning: true });

    let processed = 0;
    let failed = 0;

    // IMPORTANT: consumer.run() is non-blocking -- it starts consuming and
    // resolves its promise immediately. If we called consumer.disconnect()
    // right after, we would disconnect before processing any messages.
    // Instead, we wrap consumption in a Promise that resolves once we've
    // drained all available messages (detected via an idle timeout).
    const maxMessages = filter?.maxMessages ?? 10000;
    const idleTimeoutMs = 5000; // Stop after 5 seconds of no new messages

    await new Promise<void>((resolve) => {
      let idleTimer: NodeJS.Timeout;

      const stopConsuming = async () => {
        clearTimeout(idleTimer);
        await consumer.disconnect();
        resolve();
      };

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(stopConsuming, idleTimeoutMs);
      };

      // Start the idle timer -- if no messages arrive within idleTimeoutMs,
      // we assume the DLQ has been fully drained.
      resetIdleTimer();

      consumer.run({
        eachMessage: async ({ message }) => {
          resetIdleTimer();

          if (!message.value) return;
          if (processed + failed >= maxMessages) {
            await stopConsuming();
            return;
          }

          const entry: DeadLetterEntry = JSON.parse(
            message.value.toString()
          );

          // Apply filters
          if (filter?.errorType && entry.errorType !== filter.errorType) return;
          if (filter?.since && new Date(entry.routedAt) < filter.since) return;

          // Re-publish to the original topic
          try {
            const originalValue = Buffer.from(
              entry.originalValue,
              entry.originalValueEncoding === 'base64' ? 'base64' : 'utf8',
            );

            await this.producer.send({
              topic: entry.originalTopic,
              messages: [{
                key: entry.originalKey ? Buffer.from(entry.originalKey) : null,
                value: originalValue,
                headers: {
                  ...entry.originalHeaders,
                  'x-reprocessed-from-dlq': 'true',
                  'x-reprocessed-at': new Date().toISOString(),
                },
              }],
            });

            processed++;
          } catch (err) {
            failed++;
            this.logger.error('Failed to reprocess DLQ message', {
              error: (err as Error).message,
              originalTopic: entry.originalTopic,
            });
          }
        },
      });
    });

    return { processed, failed };
  }

  private headersToRecord(
    headers?: Record<string, Buffer | string | undefined>,
  ): Record<string, string> {
    if (!headers) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      result[key] = value ? value.toString() : '';
    }
    return result;
  }
}
```

> **Analogy:** A dead letter queue is like the "undeliverable mail" office at the post office. When a letter has an invalid address, missing stamp, or damaged envelope, the postal worker does not throw it away (data loss) or leave it blocking the sorting machine (pipeline block). They route it to a special department where someone investigates and either fixes the address and re-sends it or contacts the sender.

---

## Event Catalog: Documenting All Events in the System

As your system grows, knowing which events exist, who produces them, and who consumes them becomes critical. An **event catalog** is a living document — or better yet, a service — that answers these questions.

### Static Event Catalog

For our Global Booking System, we maintain a structured catalog of all events:

```typescript
// src/event-catalog/catalog.ts

export interface EventDefinition {
  name: string;                      // e.g., 'booking.created'
  version: number;                   // Current schema version
  description: string;               // What this event represents
  producer: string;                  // Which service publishes it
  consumers: string[];               // Which services consume it
  topic: string;                     // Kafka topic name
  schemaSubject: string;             // Schema Registry subject
  schemaType: 'AVRO' | 'JSON' | 'PROTOBUF';
  partitionKey: string;              // How the topic is partitioned
  retentionDays: number;             // How long events are kept
  throughput: string;                // Expected volume
  sla: string;                       // Processing SLA
  owner: string;                     // Team responsible
  documentationUrl: string;          // Link to detailed docs
  tags: string[];                    // Categorization tags
}

export const eventCatalog: EventDefinition[] = [
  {
    name: 'booking.created',
    version: 2,
    description: 'Emitted when a new booking is persisted in the Booking Service database. Initiates the booking saga: inventory reservation, payment processing, and guest notification.',
    producer: 'booking-service',
    consumers: [
      'payment-service',        // Processes payment
      'inventory-service',      // Reserves room/seat/car
      'notification-service',   // Sends confirmation email
      'analytics-service',      // Tracks conversion metrics
      'search-service',         // Updates availability index
      'loyalty-service',        // Credits loyalty points
    ],
    topic: 'booking.created',
    schemaSubject: 'booking.created-value',
    schemaType: 'AVRO',
    partitionKey: 'bookingId',
    retentionDays: 30,
    throughput: '~100K events/min at peak',
    sla: 'Consumers must process within 5 seconds',
    owner: 'booking-platform-team',
    documentationUrl: 'https://wiki.internal/events/booking-created',
    tags: ['core', 'saga-trigger', 'high-volume'],
  },
  {
    name: 'booking.confirmed',
    version: 1,
    description: 'Emitted when both payment and inventory are confirmed. The booking is now guaranteed and the guest can depend on it.',
    producer: 'booking-service',
    consumers: [
      'notification-service',   // Sends confirmation to guest
      'analytics-service',      // Records confirmed booking
      'partner-service',        // Notifies hotel/airline/car partner
      'loyalty-service',        // Finalizes point credit
    ],
    topic: 'booking.confirmed',
    schemaSubject: 'booking.confirmed-value',
    schemaType: 'AVRO',
    partitionKey: 'bookingId',
    retentionDays: 30,
    throughput: '~80K events/min at peak',
    sla: 'Consumers must process within 10 seconds',
    owner: 'booking-platform-team',
    documentationUrl: 'https://wiki.internal/events/booking-confirmed',
    tags: ['core', 'saga-completion', 'high-volume'],
  },
  {
    name: 'booking.cancelled',
    version: 1,
    description: 'Emitted when a booking is cancelled for any reason. Triggers compensating transactions: refund, inventory release, notification.',
    producer: 'booking-service',
    consumers: [
      'payment-service',        // Processes refund
      'inventory-service',      // Releases reserved inventory
      'notification-service',   // Sends cancellation notice
      'analytics-service',      // Tracks cancellation rate
      'search-service',         // Re-opens availability
    ],
    topic: 'booking.cancelled',
    schemaSubject: 'booking.cancelled-value',
    schemaType: 'AVRO',
    partitionKey: 'bookingId',
    retentionDays: 90,           // Longer retention for audit trail
    throughput: '~15K events/min at peak',
    sla: 'Refund must initiate within 30 seconds',
    owner: 'booking-platform-team',
    documentationUrl: 'https://wiki.internal/events/booking-cancelled',
    tags: ['core', 'saga-compensation', 'financial'],
  },
  {
    name: 'booking.modified',
    version: 1,
    description: 'Emitted when a confirmed booking is modified by the guest or admin. May trigger price adjustment and inventory revalidation.',
    producer: 'booking-service',
    consumers: [
      'payment-service',        // Handles price difference
      'inventory-service',      // Validates new dates/room
      'notification-service',   // Sends modification confirmation
      'analytics-service',      // Tracks modification patterns
    ],
    topic: 'booking.modified',
    schemaSubject: 'booking.modified-value',
    schemaType: 'AVRO',
    partitionKey: 'bookingId',
    retentionDays: 30,
    throughput: '~5K events/min at peak',
    sla: 'Consumers must process within 10 seconds',
    owner: 'booking-platform-team',
    documentationUrl: 'https://wiki.internal/events/booking-modified',
    tags: ['core', 'modification-flow'],
  },
];

// Helper function: given a service name, list all events it consumes
export function getEventsConsumedBy(serviceName: string): EventDefinition[] {
  return eventCatalog.filter(e => e.consumers.includes(serviceName));
}

// Helper function: given a service name, list all events it produces
export function getEventsProducedBy(serviceName: string): EventDefinition[] {
  return eventCatalog.filter(e => e.producer === serviceName);
}
```

> **What If You Skip This?** Without an event catalog, developers rely on tribal knowledge: "I think the Payment Service consumes booking.created, but I am not sure." When a new developer joins, they spend days reading code across multiple repositories to understand the event flow. When an incident occurs, the on-call engineer wastes precious time figuring out which services are affected by a broken event. An event catalog turns a 30-minute investigation into a 30-second lookup.

---

## AsyncAPI Specification for Event-Driven APIs

Just as OpenAPI (Swagger) documents REST APIs, **AsyncAPI** documents event-driven APIs. It provides a standard machine-readable specification for your events, enabling automated documentation, code generation, and validation.

### AsyncAPI Document for the Booking Service

```yaml
# asyncapi/booking-service.yaml
asyncapi: '2.6.0'
info:
  title: Global Booking System - Booking Service Events
  version: '2.0.0'
  description: |
    Event-driven API for the Booking Service.
    This service is the primary producer of booking lifecycle events
    consumed by 6+ downstream services.
  contact:
    name: Booking Platform Team
    email: booking-platform@globalbooking.com
  license:
    name: Internal Use Only

# Connection details
servers:
  production:
    url: kafka-1:9092,kafka-2:9092,kafka-3:9092
    protocol: kafka
    description: Production Kafka cluster (5 brokers, 3 AZs)
    security:
      - saslAuth: []
  staging:
    url: kafka-staging:9092
    protocol: kafka
    description: Staging Kafka (single broker)

# Default content type for all messages
defaultContentType: application/avro

# Event channels (topics)
channels:
  booking.created:
    description: |
      New booking created. Triggers the booking saga:
      inventory reservation, payment, notification.
    subscribe:
      operationId: onBookingCreated
      summary: Receive new booking events
      message:
        $ref: '#/components/messages/BookingCreated'
      bindings:
        kafka:
          groupId:
            type: string
            description: Consumer group ID (unique per consuming service)
    publish:
      operationId: publishBookingCreated
      summary: Publish a new booking event
      message:
        $ref: '#/components/messages/BookingCreated'
      bindings:
        kafka:
          key:
            type: string
            description: Booking ID (used for partition assignment)

  booking.confirmed:
    description: Booking confirmed after payment and inventory verification.
    subscribe:
      operationId: onBookingConfirmed
      message:
        $ref: '#/components/messages/BookingConfirmed'
    publish:
      operationId: publishBookingConfirmed
      message:
        $ref: '#/components/messages/BookingConfirmed'

  booking.cancelled:
    description: Booking cancelled. Triggers compensating transactions.
    subscribe:
      operationId: onBookingCancelled
      message:
        $ref: '#/components/messages/BookingCancelled'
    publish:
      operationId: publishBookingCancelled
      message:
        $ref: '#/components/messages/BookingCancelled'

  booking.modified:
    description: Confirmed booking modified by guest or admin.
    subscribe:
      operationId: onBookingModified
      message:
        $ref: '#/components/messages/BookingModified'
    publish:
      operationId: publishBookingModified
      message:
        $ref: '#/components/messages/BookingModified'

# Message definitions
components:
  messages:
    BookingCreated:
      name: BookingCreated
      title: Booking Created Event
      summary: A new booking has been created and persisted
      contentType: application/avro
      schemaFormat: application/vnd.apache.avro+json;version=1.9.0
      traits:
        - $ref: '#/components/messageTraits/commonHeaders'
      payload:
        $ref: '#/components/schemas/BookingCreatedPayload'
      examples:
        - name: Hotel booking
          summary: Standard hotel booking creation
          payload:
            eventId: "550e8400-e29b-41d4-a716-446655440000"
            eventVersion: 2
            bookingId: 9876543210
            userId: 42
            bookingType: "HOTEL"
            totalAmountCents: 88000
            currency: "USD"
            region: "us-east-1"
            createdAt: 1739612400000
            correlationId: "trace-abc-123"
            loyaltyTier: "gold"
            promoCode: null

    BookingConfirmed:
      name: BookingConfirmed
      title: Booking Confirmed Event
      summary: Payment verified and inventory confirmed
      contentType: application/avro
      schemaFormat: application/vnd.apache.avro+json;version=1.9.0
      traits:
        - $ref: '#/components/messageTraits/commonHeaders'
      payload:
        $ref: '#/components/schemas/BookingConfirmedPayload'

    BookingCancelled:
      name: BookingCancelled
      title: Booking Cancelled Event
      summary: Booking cancelled — triggers refund and inventory release
      contentType: application/avro
      schemaFormat: application/vnd.apache.avro+json;version=1.9.0
      traits:
        - $ref: '#/components/messageTraits/commonHeaders'
      payload:
        $ref: '#/components/schemas/BookingCancelledPayload'

    BookingModified:
      name: BookingModified
      title: Booking Modified Event
      summary: Confirmed booking modified by guest or admin
      contentType: application/avro
      schemaFormat: application/vnd.apache.avro+json;version=1.9.0
      traits:
        - $ref: '#/components/messageTraits/commonHeaders'
      payload:
        $ref: '#/components/schemas/BookingModifiedPayload'

  messageTraits:
    commonHeaders:
      headers:
        type: object
        properties:
          x-event-type:
            type: string
            description: Event type name
          x-schema-version:
            type: string
            description: Schema version used for serialization
          x-produced-at:
            type: string
            format: date-time
            description: ISO 8601 timestamp of production
          x-correlation-id:
            type: string
            description: Distributed tracing correlation ID

  schemas:
    BookingCreatedPayload:
      type: object
      required:
        - eventId
        - bookingId
        - userId
        - bookingType
        - totalAmountCents
        - currency
        - region
        - createdAt
        - correlationId
      properties:
        eventId:
          type: string
          format: uuid
        eventVersion:
          type: integer
          default: 2
        bookingId:
          type: integer
          format: int64
        userId:
          type: integer
          format: int64
        bookingType:
          type: string
          enum: [HOTEL, FLIGHT, CAR]
        totalAmountCents:
          type: integer
          format: int64
          minimum: 0
        currency:
          type: string
          pattern: '^[A-Z]{3}$'
        region:
          type: string
        createdAt:
          type: integer
          format: int64
          description: Epoch milliseconds
        loyaltyTier:
          type: string
          nullable: true
        promoCode:
          type: string
          nullable: true
        correlationId:
          type: string

    BookingConfirmedPayload:
      type: object
      required:
        - eventId
        - bookingId
        - userId
        - paymentTransactionId
        - confirmedAt
        - correlationId
      properties:
        eventId:
          type: string
          format: uuid
        bookingId:
          type: integer
          format: int64
        paymentTransactionId:
          type: string
        inventoryFencingToken:
          type: integer
          format: int64
        confirmedAt:
          type: integer
          format: int64
        correlationId:
          type: string

    BookingCancelledPayload:
      type: object
      required:
        - eventId
        - bookingId
        - userId
        - cancellationReason
        - cancelledBy
        - refundAmountCents
        - currency
        - cancelledAt
        - correlationId
      properties:
        eventId:
          type: string
          format: uuid
        bookingId:
          type: integer
          format: int64
        cancellationReason:
          type: string
          enum: [USER_REQUESTED, PAYMENT_FAILED, INVENTORY_UNAVAILABLE,
                 SYSTEM_TIMEOUT, FRAUD_DETECTED, DUPLICATE_BOOKING]
        cancelledBy:
          type: string
          enum: [USER, SYSTEM, ADMIN]
        refundAmountCents:
          type: integer
          format: int64
        currency:
          type: string
        cancelledAt:
          type: integer
          format: int64
        correlationId:
          type: string

    BookingModifiedPayload:
      type: object
      required:
        - eventId
        - bookingId
        - userId
        - modificationType
        - previousAmountCents
        - newAmountCents
        - currency
        - changeDescription
        - modifiedAt
        - requiresPaymentAdjustment
        - correlationId
      properties:
        eventId:
          type: string
          format: uuid
        bookingId:
          type: integer
          format: int64
        modificationType:
          type: string
          enum: [DATE_CHANGE, ROOM_UPGRADE, GUEST_COUNT_CHANGE,
                 ADD_ON_SERVICE, SPECIAL_REQUEST]
        previousAmountCents:
          type: integer
          format: int64
        newAmountCents:
          type: integer
          format: int64
        currency:
          type: string
        changeDescription:
          type: string
        modifiedAt:
          type: integer
          format: int64
        requiresPaymentAdjustment:
          type: boolean
        correlationId:
          type: string

  securitySchemes:
    saslAuth:
      type: plain
      description: SASL/PLAIN authentication for Kafka brokers
```

### Generating Documentation from AsyncAPI

```bash
# Install the AsyncAPI CLI
npm install -g @asyncapi/cli

# Generate HTML documentation
asyncapi generate fromTemplate asyncapi/booking-service.yaml \
  @asyncapi/html-template -o docs/events/

# Generate TypeScript types from the specification
asyncapi generate fromTemplate asyncapi/booking-service.yaml \
  @asyncapi/typescript-nats-template -o src/generated/events/

# Validate the specification
asyncapi validate asyncapi/booking-service.yaml
```

> **Key Term:** **AsyncAPI** — An open-source specification for defining event-driven APIs, analogous to OpenAPI for REST APIs. It describes channels (topics), messages, schemas, and server connection details in a machine-readable format (YAML or JSON). Tools can generate documentation, client code, and server stubs from an AsyncAPI specification.


---

## Chapter Summary

| Concept | Key Takeaway |
|---------|-------------|
| Schema Registry | A centralized store (Confluent Schema Registry) that versions every event schema so producers and consumers agree on message structure. |
| Schema Evolution | Changing event schemas over time without breaking existing consumers. Requires understanding backward, forward, and full compatibility modes. |
| Backward Compatibility | New schema can read data written by the old schema. Achieved by only adding optional fields and never removing or renaming required fields. |
| Forward Compatibility | Old schema can read data written by the new schema. Achieved by keeping `additionalProperties: true` so unknown fields are ignored, not rejected. |
| Avro vs JSON Schema vs Protobuf | Avro excels at schema evolution with compact binary encoding; JSON Schema is human-readable and familiar; Protobuf is fast with strong typing. Choose based on team expertise and performance needs. |
| Dead Letter Queue (DLQ) | A dedicated topic where messages that fail processing are sent instead of being lost. Enables later inspection, reprocessing, and alerting. |
| Event Versioning | Use a `schemaVersion` field in every event so consumers can branch logic based on the version they receive. |
| AsyncAPI | An OpenAPI-equivalent specification for event-driven APIs. Documents topics, message schemas, and bindings in a machine-readable format. |
| Event Catalog | A discovery tool that indexes all events across services, showing ownership, schemas, and consumer relationships in a searchable UI. |
| Contract Testing for Events | Verify that producers emit events matching the registered schema and consumers can parse them, using Pact or schema-registry validation. |

> **Checkpoint:** Can you (1) explain the difference between backward and forward compatibility, (2) set up a Dead Letter Queue for a Kafka consumer, (3) register a schema with the Confluent Schema Registry, and (4) describe when you would choose Avro over JSON Schema?

