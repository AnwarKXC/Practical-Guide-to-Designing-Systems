# Chapter 39: Local Development Setup — Running Everything on Your Laptop

## The Challenge: A Microservices Ecosystem on One Machine

You have just joined the team. You have cloned the monorepo. You open `README.md`, and it says the Global Booking System consists of seven microservices, three databases, a message broker, a search engine, a cache, and a distributed tracing system. Your laptop has 16 GB of RAM and a growing sense of dread.

In the monolith days, `npm install && npm start` got you a working system. Those days are over. The Booking Service depends on MySQL, Redis, and Kafka. The Search Service depends on Elasticsearch. The Payment Service depends on Stripe's API. The Notification Service depends on an email provider. The Inventory Service depends on Redis for distributed locks. Every service depends on Jaeger for tracing. Without all of these running and correctly configured, services crash on startup with connection errors, timeout exceptions, and cryptic messages about unreachable brokers.

Here is what a new developer faces without a proper local setup:

| Dependency | Native Install Pain | Time to Configure |
|------------|-------------------|-------------------|
| MySQL 8.0 | Installer, path setup, root password | 10 minutes |
| Redis 7 | Homebrew/apt, service management | 5 minutes |
| Kafka (KRaft) | Java dependency, 47+ config properties | 30+ minutes |
| Elasticsearch 8 | JVM tuning, security certificates | 20 minutes |
| Jaeger | Binary download, port configuration | 10 minutes |
| 7 NestJS services | Node versions, dependencies, env files | 20 minutes |
| **Total** | **Debugging version mismatches** | **2+ hours** |

Two hours—if nothing goes wrong. And something always goes wrong. Your Java version is incompatible with Kafka. Elasticsearch refuses to start because `vm.max_map_count` is too low. Redis conflicts with a stale process from last month.

> **Analogy:** Imagine opening a restaurant where every chef must personally grow their own wheat, raise their own cattle, and distill their own olive oil before they can start cooking. That is native local development with microservices. Docker Compose is the commercial kitchen supply company that delivers pre-portioned, ready-to-use ingredients every morning. Your chefs just cook.

We are going to solve this problem in layers. Docker Compose handles infrastructure. Volume mounts enable hot reloading. Seed scripts provide realistic data. Mock services replace external APIs. And a `Makefile` ties it all together into a two-minute onboarding experience.

> **Key Term:** **Local Development Environment** — The complete set of tools, services, databases, and configurations running on a developer's machine that replicate the production system closely enough to build and test features with confidence. The goal is maximum fidelity to production with minimum friction to set up.

---

## Docker Compose: The Complete Stack in One File

Here is the full `docker-compose.yml` for the Global Booking System. Every infrastructure service, every application service, every network, and every volume—in one declarative file. I will walk through every section after showing you the complete picture.

```yaml
# docker-compose.yml
# Global Booking System — Local Development Stack
# Usage: docker compose up -d
# Docs:  See Chapter 39 of the architecture guide

version: '3.8'

x-nestjs-common: &nestjs-common
  build:
    context: .
    dockerfile: Dockerfile.dev
  restart: unless-stopped
  depends_on:
    mysql:
      condition: service_healthy
    redis:
      condition: service_healthy
    kafka:
      condition: service_started
  networks:
    - booking-network
  env_file:
    - .env.development

services:
  # ============================================
  # INFRASTRUCTURE SERVICES
  # ============================================

  mysql:
    image: mysql:8.0
    container_name: gbs-mysql
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:-rootpassword}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-booking_dev}
      MYSQL_USER: ${MYSQL_USER:-booking_user}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:-booking_pass}
    ports:
      - "${MYSQL_PORT:-3306}:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - ./scripts/seed-data.sql:/docker-entrypoint-initdb.d/02-seed.sql
      - ./scripts/mysql-conf.d:/etc/mysql/conf.d
    command: >
      --default-authentication-plugin=mysql_native_password
      --max-connections=200
      --innodb-buffer-pool-size=256M
      --slow-query-log=ON
      --slow-query-log-file=/var/log/mysql/slow.log
      --long-query-time=1
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p${MYSQL_ROOT_PASSWORD:-rootpassword}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - booking-network

  redis:
    image: redis:7-alpine
    container_name: gbs-redis
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - ./config/redis.conf:/usr/local/etc/redis/redis.conf
    command: redis-server /usr/local/etc/redis/redis.conf
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - booking-network

  kafka:
    image: confluentinc/cp-kafka:7.5.0
    container_name: gbs-kafka
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093,EXTERNAL://0.0.0.0:9094
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,EXTERNAL://localhost:9094
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,EXTERNAL:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_LOG_DIRS: /tmp/kraft-combined-logs
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
      KAFKA_NUM_PARTITIONS: 3
      KAFKA_DEFAULT_REPLICATION_FACTOR: 1
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'
    ports:
      - "${KAFKA_PORT:-9094}:9094"
    volumes:
      - kafka_data:/tmp/kraft-combined-logs
    networks:
      - booking-network

  kafka-ui:
    image: provectuslabs/kafka-ui:latest
    container_name: gbs-kafka-ui
    ports:
      - "8090:8080"
    environment:
      KAFKA_CLUSTERS_0_NAME: local
      KAFKA_CLUSTERS_0_BOOTSTRAPSERVERS: kafka:9092
    depends_on:
      - kafka
    networks:
      - booking-network

  elasticsearch:
    image: elasticsearch:8.11.0
    container_name: gbs-elasticsearch
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - xpack.security.enrollment.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
      - cluster.name=gbs-dev
    ports:
      - "${ES_PORT:-9200}:9200"
    volumes:
      - es_data:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:9200/_cluster/health || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 45s
    networks:
      - booking-network
    deploy:
      resources:
        limits:
          memory: 1G

  jaeger:
    image: jaegertracing/all-in-one:1.50
    container_name: gbs-jaeger
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    ports:
      - "16686:16686"    # Jaeger UI
      - "4318:4318"      # OTLP HTTP
      - "4317:4317"      # OTLP gRPC
      - "14268:14268"    # Jaeger HTTP collector
    networks:
      - booking-network

  # ============================================
  # APPLICATION SERVICES (with hot reload)
  # ============================================

  booking-service:
    <<: *nestjs-common
    container_name: gbs-booking-service
    ports:
      - "3001:3000"
      - "9229:9229"      # Node.js debugger
    volumes:
      - ./services/booking-service/src:/app/services/booking-service/src
      - ./services/booking-service/test:/app/services/booking-service/test
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: booking-service
      SERVICE_PORT: 3000
      DB_HOST: mysql
      DB_PORT: 3306
      DB_NAME: booking_dev
      DB_USER: booking_user
      DB_PASSWORD: booking_pass
      REDIS_HOST: redis
      REDIS_PORT: 6379
      KAFKA_BROKERS: kafka:9092
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development
      LOG_LEVEL: debug

  inventory-service:
    <<: *nestjs-common
    container_name: gbs-inventory-service
    ports:
      - "3002:3000"
      - "9230:9229"
    volumes:
      - ./services/inventory-service/src:/app/services/inventory-service/src
      - ./services/inventory-service/test:/app/services/inventory-service/test
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: inventory-service
      SERVICE_PORT: 3000
      DB_HOST: mysql
      DB_PORT: 3306
      DB_NAME: booking_dev
      DB_USER: booking_user
      DB_PASSWORD: booking_pass
      REDIS_HOST: redis
      REDIS_PORT: 6379
      KAFKA_BROKERS: kafka:9092
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development

  payment-service:
    <<: *nestjs-common
    container_name: gbs-payment-service
    ports:
      - "3003:3000"
      - "9231:9229"
    volumes:
      - ./services/payment-service/src:/app/services/payment-service/src
      - ./services/payment-service/test:/app/services/payment-service/test
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: payment-service
      SERVICE_PORT: 3000
      PAYMENT_PROVIDER: mock
      STRIPE_API_KEY: ${STRIPE_TEST_KEY:-sk_test_mock_key}
      KAFKA_BROKERS: kafka:9092
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development

  notification-service:
    <<: *nestjs-common
    container_name: gbs-notification-service
    ports:
      - "3004:3000"
    volumes:
      - ./services/notification-service/src:/app/services/notification-service/src
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: notification-service
      SERVICE_PORT: 3000
      EMAIL_PROVIDER: mock
      SMS_PROVIDER: mock
      KAFKA_BROKERS: kafka:9092
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development

  search-service:
    <<: *nestjs-common
    container_name: gbs-search-service
    ports:
      - "3005:3000"
    volumes:
      - ./services/search-service/src:/app/services/search-service/src
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: search-service
      SERVICE_PORT: 3000
      ELASTICSEARCH_URL: http://elasticsearch:9200
      KAFKA_BROKERS: kafka:9092
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development
    depends_on:
      elasticsearch:
        condition: service_healthy

  user-service:
    <<: *nestjs-common
    container_name: gbs-user-service
    ports:
      - "3006:3000"
    volumes:
      - ./services/user-service/src:/app/services/user-service/src
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: user-service
      SERVICE_PORT: 3000
      DB_HOST: mysql
      DB_PORT: 3306
      DB_NAME: booking_dev
      DB_USER: booking_user
      DB_PASSWORD: booking_pass
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: ${JWT_SECRET:-dev-secret-do-not-use-in-production}
      JAEGER_ENDPOINT: http://jaeger:4318/v1/traces
      NODE_ENV: development

  api-gateway:
    <<: *nestjs-common
    container_name: gbs-api-gateway
    ports:
      - "3000:3000"
      - "9232:9229"
    volumes:
      - ./services/api-gateway/src:/app/services/api-gateway/src
      - ./libs:/app/libs
    environment:
      SERVICE_NAME: api-gateway
      SERVICE_PORT: 3000
      BOOKING_SERVICE_URL: http://booking-service:3000
      INVENTORY_SERVICE_URL: http://inventory-service:3000
      PAYMENT_SERVICE_URL: http://payment-service:3000
      NOTIFICATION_SERVICE_URL: http://notification-service:3000
      SEARCH_SERVICE_URL: http://search-service:3000
      USER_SERVICE_URL: http://user-service:3000
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_SECRET: ${JWT_SECRET:-dev-secret-do-not-use-in-production}
      RATE_LIMIT_MAX: 1000
      NODE_ENV: development

# ============================================
# NETWORKS & VOLUMES
# ============================================

networks:
  booking-network:
    driver: bridge
    name: gbs-network

volumes:
  mysql_data:
    name: gbs-mysql-data
  kafka_data:
    name: gbs-kafka-data
  es_data:
    name: gbs-es-data
```

That is 250 lines of YAML. Let me break down every design decision in this file, because you will be modifying it for the next year.

---

## Service-by-Service Configuration Explained

### The YAML Anchor: Eliminating Repetition

At the top of the file, the `x-nestjs-common` block uses a YAML anchor (`&nestjs-common`):

```yaml
x-nestjs-common: &nestjs-common
  build:
    context: .
    dockerfile: Dockerfile.dev
  restart: unless-stopped
  depends_on:
    mysql:
      condition: service_healthy
    redis:
      condition: service_healthy
    kafka:
      condition: service_started
```

Every application service references this anchor with `<<: *nestjs-common`, which merges the common properties into the service definition. Without this, you would copy-paste the same `build`, `restart`, and `depends_on` blocks seven times. When you need to change the Dockerfile path, you change it in one place.

> **Key Term:** **YAML Anchor** — A reuse mechanism in YAML where `&name` defines an anchor and `*name` references it. The `<<:` merge key inserts all properties from the anchor into the current mapping, reducing duplication in configuration files.

### Health Checks: Why Services Wait

Notice the `depends_on` block uses `condition: service_healthy`, not just `depends_on: mysql`. The difference is critical.

Without health checks, Docker Compose starts services in dependency order but does not wait for them to be *ready*. MySQL's container starts in 2 seconds, but MySQL the database engine takes 15-30 seconds to initialize, create the schema, and accept connections. If the Booking Service starts 3 seconds after MySQL's container launches, it tries to connect to a database that is not ready yet, and crashes.

```yaml
healthcheck:
  test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-prootpassword"]
  interval: 10s      # Check every 10 seconds
  timeout: 5s        # Fail if check takes longer than 5 seconds
  retries: 5         # Mark unhealthy after 5 consecutive failures
  start_period: 30s  # Grace period: don't count failures during first 30 seconds
```

This health check runs `mysqladmin ping` every 10 seconds. Docker marks the container as "healthy" only after the command succeeds. The `start_period` of 30 seconds is generous—it gives MySQL time to initialize without counting early failures.

> **What If You Skip This?** Without health checks, your services will crash on startup approximately 40% of the time. You will develop a habit of running `docker compose up`, waiting 30 seconds, then running `docker compose restart booking-service`. This wastes 30 seconds of your life every single startup. Health checks eliminate this entirely.

### Kafka: Two Listeners, Two Audiences

The Kafka configuration has the most subtle networking setup:

```yaml
KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093,EXTERNAL://0.0.0.0:9094
KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092,EXTERNAL://localhost:9094
```

There are two audiences for Kafka connections:

1. **Other containers** (like the Booking Service running inside Docker): They connect via the Docker network using `kafka:9092`. The hostname `kafka` resolves to the container's IP address inside the `booking-network`.

2. **Your laptop** (when you run a service outside Docker, or use a Kafka CLI tool): It connects via `localhost:9094`. This is the `EXTERNAL` listener, mapped to your host machine.

Why two separate listeners? Because `kafka:9092` is not reachable from your laptop (that hostname does not exist outside Docker), and `localhost:9094` is meaningless inside a container (it would point to the container itself, not the Kafka container).

```
┌─────────────────────────────────────────────────────────┐
│  Docker Network (booking-network)                       │
│                                                         │
│  ┌──────────────┐     kafka:9092     ┌──────────────┐   │
│  │   Booking     │ ──────────────► │    Kafka       │   │
│  │   Service     │                  │    Broker      │   │
│  └──────────────┘                   └───────┬────────┘   │
│                                              │           │
└──────────────────────────────────────────────┼───────────┘
                                               │ :9094
                                               ▼
                                     ┌──────────────────┐
                                     │   Your Laptop    │
                                     │  localhost:9094   │
                                     └──────────────────┘
```

### Kafka UI: Seeing Your Events

The Kafka UI service (`provectuslabs/kafka-ui`) provides a browser-based interface at `http://localhost:8090`. You can see topics, partitions, consumer groups, and individual messages. When you publish a `booking.created` event and want to verify it arrived, you open Kafka UI instead of running CLI commands.

### Elasticsearch: Memory Guard

```yaml
deploy:
  resources:
    limits:
      memory: 1G
```

This Docker resource limit caps Elasticsearch at 1 GB of RAM. Combined with the JVM heap settings (`-Xms512m -Xmx512m`), this prevents Elasticsearch from consuming your laptop's memory. Without this limit, a runaway search indexing job can push Elasticsearch to 3+ GB, causing your IDE to freeze and your system to swap.

### Container Naming Convention

Every container uses a `gbs-` prefix (`gbs-mysql`, `gbs-kafka`, `gbs-booking-service`). This prevents collisions with other Docker projects on your machine. If you are also working on a side project that uses MySQL, `docker ps` clearly distinguishes between `gbs-mysql` and `sideproject-mysql`.

---

## Hot Reloading: Edit Code, See Changes Instantly

The single most important productivity feature in local development is hot reloading. You save a file, and within two seconds, the running service restarts with your changes. Without it, you rebuild the Docker image, restart the container, and wait 30-60 seconds. Multiply that by the 200 saves you make per day and you lose over an hour to waiting.

### The Development Dockerfile

The production Dockerfile compiles TypeScript to JavaScript and runs the output. The development Dockerfile does not compile at all — it runs TypeScript directly with `ts-node` and watches for file changes with `nodemon`.

```dockerfile
# Dockerfile.dev
# Development-only Dockerfile with hot reloading
# DO NOT use this in production — ts-node is slower than compiled JS

FROM node:20-alpine

# Install nodemon globally for file watching
RUN npm install -g nodemon ts-node

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json package-lock.json tsconfig.json ./
COPY libs/package.json ./libs/

# Install ALL dependencies (including devDependencies)
RUN npm ci

# Copy shared libraries (these change less frequently)
COPY libs/ ./libs/

# Copy Prisma schema for database client generation
COPY prisma/ ./prisma/
RUN npx prisma generate

# Source code is NOT copied — it is mounted as a volume
# This is the key to hot reloading

# Expose application port and debugger port
EXPOSE 3000 9229

# Use nodemon to watch for changes and restart
CMD ["nodemon", \
     "--watch", "services/${SERVICE_NAME}/src", \
     "--watch", "libs", \
     "--ext", "ts,json", \
     "--exec", "node --inspect=0.0.0.0:9229 -r ts-node/register services/${SERVICE_NAME}/src/main.ts"]
```

> **Key Term:** **Volume Mount** — A Docker mechanism that maps a directory on your host machine into the container's filesystem. Changes to files on the host are immediately visible inside the container, and vice versa. This is how hot reloading works: nodemon inside the container sees your host file changes.

### How Volume Mounts Enable Live Reload

Look at the Booking Service volumes in the Compose file:

```yaml
volumes:
  - ./services/booking-service/src:/app/services/booking-service/src
  - ./services/booking-service/test:/app/services/booking-service/test
  - ./libs:/app/libs
```

This creates a live link between your laptop and the container:

```
Your Laptop                          Docker Container
─────────────────                    ─────────────────
./services/booking-service/src/  ──► /app/services/booking-service/src/
./services/booking-service/test/ ──► /app/services/booking-service/test/
./libs/                          ──► /app/libs/
```

When you edit `./services/booking-service/src/booking.controller.ts` in VS Code, the file at `/app/services/booking-service/src/booking.controller.ts` inside the container changes at the same instant. Nodemon detects the change and restarts the Node.js process. Total time from save to running: 1-3 seconds.

### The Nodemon Configuration

For finer control, each service includes a `nodemon.json` configuration file:

```json
// services/booking-service/nodemon.json
{
  "watch": ["src", "../../libs"],
  "ext": "ts,json",
  "ignore": [
    "src/**/*.spec.ts",
    "src/**/*.test.ts",
    "node_modules"
  ],
  "execMap": {
    "ts": "node --inspect=0.0.0.0:9229 -r ts-node/register"
  },
  "delay": "500",
  "env": {
    "NODE_ENV": "development"
  }
}
```

The `ignore` patterns prevent restarts when you save test files — you do not want the server restarting while you are writing tests. The `delay` of 500 milliseconds batches rapid saves (like when your IDE auto-formats on save and writes twice in quick succession).

> **What If You Skip This?** Without the delay, saving a file while auto-format is enabled triggers two restarts in rapid succession. The first restart begins, then gets killed by the second restart. Occasionally the second restart fails because the first one still holds the port. You see `EADDRINUSE` errors that disappear on the next save. It is maddening to debug because it is intermittent.

### What NOT to Mount

Notice that `node_modules` is never mounted from the host into the container. This is deliberate:

```yaml
# WRONG — never do this
volumes:
  - ./services/booking-service:/app/services/booking-service  # Includes node_modules!

# RIGHT — mount only source code
volumes:
  - ./services/booking-service/src:/app/services/booking-service/src
  - ./services/booking-service/test:/app/services/booking-service/test
```

Mounting `node_modules` from your host into the container causes three problems. First, native modules compiled on macOS or Windows will not work inside the Linux container. Second, the sheer number of files in `node_modules` (often 50,000+) overwhelms Docker's file-watching system on macOS and Windows, where file events must cross the VM boundary. Third, if you run `npm install` on the host, it corrupts the container's `node_modules`, and vice versa.

---

## Database Seeding: Prisma Scripts with Realistic Test Data

An empty database is almost as useless as no database. You need realistic data to develop against — hotels with rooms, users with bookings, inventory with availability. The seed script creates this data consistently and repeatably.

### The Prisma Schema Foundation

The Global Booking System uses Prisma as its ORM. The schema defines every table:

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  passwordHash  String    @map("password_hash")
  firstName     String    @map("first_name")
  lastName      String    @map("last_name")
  role          UserRole  @default(GUEST)
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")
  bookings      Booking[]

  @@map("users")
}

model Hotel {
  id            String    @id @default(uuid())
  name          String
  description   String    @db.Text
  address       String
  city          String
  country       String
  starRating    Int       @map("star_rating")
  latitude      Decimal   @db.Decimal(10, 8)
  longitude     Decimal   @db.Decimal(11, 8)
  amenities     Json
  createdAt     DateTime  @default(now()) @map("created_at")
  rooms         Room[]

  @@map("hotels")
}

model Room {
  id            String    @id @default(uuid())
  hotelId       String    @map("hotel_id")
  type          RoomType
  name          String
  description   String    @db.Text
  basePrice     Decimal   @db.Decimal(10, 2) @map("base_price")
  maxOccupancy  Int       @map("max_occupancy")
  amenities     Json
  hotel         Hotel     @relation(fields: [hotelId], references: [id])
  inventory     Inventory[]
  bookings      Booking[]

  @@map("rooms")
}

model Booking {
  id            String        @id @default(uuid())
  userId        String        @map("user_id")
  roomId        String        @map("room_id")
  checkIn       DateTime      @map("check_in")
  checkOut      DateTime      @map("check_out")
  totalPrice    Decimal       @db.Decimal(10, 2) @map("total_price")
  status        BookingStatus @default(PENDING)
  guestCount    Int           @map("guest_count")
  specialReqs   String?       @db.Text @map("special_requests")
  createdAt     DateTime      @default(now()) @map("created_at")
  updatedAt     DateTime      @updatedAt @map("updated_at")
  user          User          @relation(fields: [userId], references: [id])
  room          Room          @relation(fields: [roomId], references: [id])
  payment       Payment?

  @@map("bookings")
}

model Inventory {
  id            String    @id @default(uuid())
  roomId        String    @map("room_id")
  date          DateTime  @db.Date
  totalUnits    Int       @map("total_units")
  bookedUnits   Int       @default(0) @map("booked_units")
  price         Decimal   @db.Decimal(10, 2)
  room          Room      @relation(fields: [roomId], references: [id])

  @@unique([roomId, date])
  @@map("inventory")
}

model Payment {
  id              String        @id @default(uuid())
  bookingId       String        @unique @map("booking_id")
  amount          Decimal       @db.Decimal(10, 2)
  currency        String        @default("USD") @db.VarChar(3)
  status          PaymentStatus @default(PENDING)
  provider        String
  providerTxnId   String?       @map("provider_txn_id")
  createdAt       DateTime      @default(now()) @map("created_at")
  booking         Booking       @relation(fields: [bookingId], references: [id])

  @@map("payments")
}

enum UserRole {
  GUEST
  HOST
  ADMIN
}

enum RoomType {
  STANDARD
  DELUXE
  SUITE
  PENTHOUSE
}

enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
  COMPLETED
  NO_SHOW
}

enum PaymentStatus {
  PENDING
  COMPLETED
  FAILED
  REFUNDED
}
```

### The Seed Script

```typescript
// prisma/seed.ts
import { PrismaClient, UserRole, RoomType, BookingStatus, PaymentStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // ──────────────────────────────────────────
  // USERS: Create test accounts with known passwords
  // ──────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 10);

  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: 'admin@gbs.dev' },
      update: {},
      create: {
        email: 'admin@gbs.dev',
        passwordHash,
        firstName: 'Admin',
        lastName: 'User',
        role: UserRole.ADMIN,
      },
    }),
    prisma.user.upsert({
      where: { email: 'host@gbs.dev' },
      update: {},
      create: {
        email: 'host@gbs.dev',
        passwordHash,
        firstName: 'Hotel',
        lastName: 'Manager',
        role: UserRole.HOST,
      },
    }),
    prisma.user.upsert({
      where: { email: 'guest@gbs.dev' },
      update: {},
      create: {
        email: 'guest@gbs.dev',
        passwordHash,
        firstName: 'Test',
        lastName: 'Guest',
        role: UserRole.GUEST,
      },
    }),
    // Create 10 additional guest users for load testing
    ...Array.from({ length: 10 }, (_, i) =>
      prisma.user.upsert({
        where: { email: `guest${i + 1}@gbs.dev` },
        update: {},
        create: {
          email: `guest${i + 1}@gbs.dev`,
          passwordHash,
          firstName: `Guest`,
          lastName: `User${i + 1}`,
          role: UserRole.GUEST,
        },
      })
    ),
  ]);

  console.log(`Created ${users.length} users`);

  // ──────────────────────────────────────────
  // HOTELS: Realistic properties across cities
  // ──────────────────────────────────────────
  const hotelsData = [
    {
      name: 'The Grand Metropolitan',
      description: 'Luxury five-star hotel in the heart of Manhattan with skyline views.',
      address: '455 Madison Avenue',
      city: 'New York',
      country: 'US',
      starRating: 5,
      latitude: 40.7614,
      longitude: -73.9776,
      amenities: JSON.stringify(['pool', 'spa', 'gym', 'restaurant', 'bar', 'concierge', 'valet']),
    },
    {
      name: 'Harbour View Inn',
      description: 'Boutique waterfront hotel with panoramic harbour views and farm-to-table dining.',
      address: '12 Circular Quay West',
      city: 'Sydney',
      country: 'AU',
      starRating: 4,
      latitude: -33.8568,
      longitude: 151.2153,
      amenities: JSON.stringify(['pool', 'restaurant', 'bar', 'gym', 'wifi']),
    },
    {
      name: 'Sakura Garden Hotel',
      description: 'Traditional Japanese hospitality meets modern comfort in central Tokyo.',
      address: '2-1-1 Nihonbashi',
      city: 'Tokyo',
      country: 'JP',
      starRating: 4,
      latitude: 35.6838,
      longitude: 139.7744,
      amenities: JSON.stringify(['onsen', 'restaurant', 'garden', 'wifi', 'tea_ceremony']),
    },
    {
      name: 'Berlin Central Suites',
      description: 'Contemporary all-suite hotel steps from Brandenburg Gate.',
      address: 'Unter den Linden 77',
      city: 'Berlin',
      country: 'DE',
      starRating: 4,
      latitude: 52.5163,
      longitude: 13.3777,
      amenities: JSON.stringify(['gym', 'restaurant', 'bar', 'sauna', 'wifi', 'bikes']),
    },
    {
      name: 'Budget Stay Express',
      description: 'Clean, affordable rooms near the airport. Perfect for layovers.',
      address: '100 Airport Boulevard',
      city: 'Chicago',
      country: 'US',
      starRating: 2,
      latitude: 41.9742,
      longitude: -87.9073,
      amenities: JSON.stringify(['wifi', 'parking', 'shuttle']),
    },
  ];

  const hotels = await Promise.all(
    hotelsData.map((h) => prisma.hotel.create({ data: h }))
  );

  console.log(`Created ${hotels.length} hotels`);

  // ──────────────────────────────────────────
  // ROOMS: Multiple room types per hotel
  // ──────────────────────────────────────────
  const roomConfigs: Array<{
    type: RoomType;
    name: string;
    description: string;
    basePrice: number;
    maxOccupancy: number;
    amenities: string[];
  }> = [
    {
      type: RoomType.STANDARD,
      name: 'Standard Room',
      description: 'Comfortable room with queen bed and city views.',
      basePrice: 150,
      maxOccupancy: 2,
      amenities: ['wifi', 'tv', 'minibar', 'safe'],
    },
    {
      type: RoomType.DELUXE,
      name: 'Deluxe Room',
      description: 'Spacious room with king bed, sitting area, and premium amenities.',
      basePrice: 280,
      maxOccupancy: 3,
      amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathrobe', 'nespresso'],
    },
    {
      type: RoomType.SUITE,
      name: 'Executive Suite',
      description: 'Separate living area, work desk, and panoramic views.',
      basePrice: 450,
      maxOccupancy: 4,
      amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathrobe', 'nespresso', 'lounge_access'],
    },
    {
      type: RoomType.PENTHOUSE,
      name: 'Penthouse Suite',
      description: 'Top-floor luxury with private terrace and butler service.',
      basePrice: 1200,
      maxOccupancy: 4,
      amenities: ['wifi', 'tv', 'minibar', 'safe', 'bathrobe', 'butler', 'terrace', 'jacuzzi'],
    },
  ];

  const rooms = [];
  for (const hotel of hotels) {
    // Budget hotels get fewer room types
    const roomTypesForHotel = hotel.starRating <= 2
      ? roomConfigs.slice(0, 2)
      : roomConfigs;

    for (const config of roomTypesForHotel) {
      // Adjust price based on hotel star rating
      const priceMultiplier = hotel.starRating / 3;
      const room = await prisma.room.create({
        data: {
          hotelId: hotel.id,
          type: config.type,
          name: config.name,
          description: config.description,
          basePrice: Math.round(config.basePrice * priceMultiplier),
          maxOccupancy: config.maxOccupancy,
          amenities: JSON.stringify(config.amenities),
        },
      });
      rooms.push(room);
    }
  }

  console.log(`Created ${rooms.length} rooms`);

  // ──────────────────────────────────────────
  // INVENTORY: 90 days of availability
  // ──────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let inventoryCount = 0;
  for (const room of rooms) {
    const inventoryRecords = [];
    for (let dayOffset = 0; dayOffset < 90; dayOffset++) {
      const date = new Date(today);
      date.setDate(date.getDate() + dayOffset);

      // Weekend pricing: 20% premium
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const price = isWeekend
        ? Number(room.basePrice) * 1.2
        : Number(room.basePrice);

      inventoryRecords.push({
        roomId: room.id,
        date,
        totalUnits: room.type === 'PENTHOUSE' ? 1 : 5,
        bookedUnits: 0,
        price,
      });
    }

    await prisma.inventory.createMany({ data: inventoryRecords });
    inventoryCount += inventoryRecords.length;
  }

  console.log(`Created ${inventoryCount} inventory records`);

  // ──────────────────────────────────────────
  // BOOKINGS: Sample bookings in various states
  // ──────────────────────────────────────────
  const guestUser = users.find((u) => u.email === 'guest@gbs.dev')!;
  const sampleBookings = [
    {
      userId: guestUser.id,
      roomId: rooms[0].id,
      checkIn: new Date(today.getTime() + 7 * 86400000),
      checkOut: new Date(today.getTime() + 10 * 86400000),
      totalPrice: Number(rooms[0].basePrice) * 3,
      status: BookingStatus.CONFIRMED,
      guestCount: 2,
      specialReqs: 'Late check-in, arriving around 11 PM',
    },
    {
      userId: guestUser.id,
      roomId: rooms[4].id,
      checkIn: new Date(today.getTime() + 14 * 86400000),
      checkOut: new Date(today.getTime() + 16 * 86400000),
      totalPrice: Number(rooms[4].basePrice) * 2,
      status: BookingStatus.PENDING,
      guestCount: 1,
    },
    {
      userId: guestUser.id,
      roomId: rooms[2].id,
      checkIn: new Date(today.getTime() - 10 * 86400000),
      checkOut: new Date(today.getTime() - 7 * 86400000),
      totalPrice: Number(rooms[2].basePrice) * 3,
      status: BookingStatus.COMPLETED,
      guestCount: 2,
    },
  ];

  const bookings = await Promise.all(
    sampleBookings.map((b) => prisma.booking.create({ data: b }))
  );

  console.log(`Created ${bookings.length} bookings`);

  // ──────────────────────────────────────────
  // PAYMENTS: Payment records for bookings
  // ──────────────────────────────────────────
  await prisma.payment.create({
    data: {
      bookingId: bookings[0].id,
      amount: bookings[0].totalPrice,
      currency: 'USD',
      status: PaymentStatus.COMPLETED,
      provider: 'stripe',
      providerTxnId: 'txn_mock_001_confirmed',
    },
  });

  await prisma.payment.create({
    data: {
      bookingId: bookings[2].id,
      amount: bookings[2].totalPrice,
      currency: 'USD',
      status: PaymentStatus.COMPLETED,
      provider: 'stripe',
      providerTxnId: 'txn_mock_002_completed',
    },
  });

  console.log('Created payment records');
  console.log('Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

### Running the Seed Script

Add the seed command to `package.json`:

```json
{
  "prisma": {
    "seed": "ts-node prisma/seed.ts"
  },
  "scripts": {
    "db:seed": "npx prisma db seed",
    "db:reset": "npx prisma migrate reset --force",
    "db:migrate": "npx prisma migrate dev",
    "db:studio": "npx prisma studio"
  }
}
```

Now seeding is a single command: `npx prisma db seed`. The `db:reset` command drops all tables, re-runs migrations, and re-seeds — a nuclear option for when your data gets corrupted during testing.

> **Why `upsert` Instead of `create`?** The seed script uses `upsert` for users (create if not exists, skip if exists). This makes the script idempotent — you can run it multiple times without getting duplicate key errors. For hotels and rooms it uses `create` behind a `migrate reset`, which wipes tables first. Choose the strategy based on whether you expect the seed to run on a fresh or existing database.

---

## Mock Services: WireMock for External Dependencies

The Payment Service calls Stripe. The Notification Service calls SendGrid for email and Twilio for SMS. In development, you do not want to charge real credit cards or send real emails. Mock services simulate these external APIs and return predictable, configurable responses.

### WireMock: A Programmable HTTP Stub Server

WireMock is a standalone server that accepts HTTP requests and returns pre-configured responses. You define mappings — "when you receive this request, return this response" — and WireMock handles the rest.

```yaml
# Add to docker-compose.yml under services:

  wiremock:
    image: wiremock/wiremock:3.3.1
    container_name: gbs-wiremock
    ports:
      - "8089:8080"
    volumes:
      - ./mocks/wiremock/mappings:/home/wiremock/mappings
      - ./mocks/wiremock/__files:/home/wiremock/__files
    command: >
      --verbose
      --global-response-templating
    networks:
      - booking-network
```

### Stripe Payment Mocks

```json
// mocks/wiremock/mappings/stripe-charge-success.json
{
  "request": {
    "method": "POST",
    "urlPathPattern": "/v1/charges",
    "bodyPatterns": [
      {
        "matchesJsonPath": "$.amount"
      }
    ]
  },
  "response": {
    "status": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "jsonBody": {
      "id": "ch_mock_{{randomValue type='UUID'}}",
      "object": "charge",
      "amount": "{{jsonPath request.body '$.amount'}}",
      "currency": "{{jsonPath request.body '$.currency'}}",
      "status": "succeeded",
      "paid": true,
      "created": "{{now format='unix'}}",
      "livemode": false,
      "source": {
        "id": "card_mock_visa",
        "brand": "visa",
        "last4": "4242"
      }
    }
  }
}
```

```json
// mocks/wiremock/mappings/stripe-charge-failure.json
// Triggered when the amount ends in 99 (e.g., $19.99 = 1999 cents)
{
  "request": {
    "method": "POST",
    "urlPathPattern": "/v1/charges",
    "bodyPatterns": [
      {
        "matchesJsonPath": {
          "expression": "$.amount",
          "matches": ".*99$"
        }
      }
    ]
  },
  "response": {
    "status": 402,
    "headers": {
      "Content-Type": "application/json"
    },
    "jsonBody": {
      "error": {
        "type": "card_error",
        "code": "card_declined",
        "message": "Your card was declined. (mock)",
        "charge": "ch_mock_failed_{{randomValue type='UUID'}}"
      }
    }
  },
  "priority": 1
}
```

> **Design Pattern:** The failure mock uses a convention: amounts ending in 99 cents trigger a declined card. This lets developers test error flows deterministically. Charge $100.00 and it succeeds. Charge $99.99 and the card is declined. No randomness, no guessing — you control the outcome through the input.

### Email Service Mocks

```json
// mocks/wiremock/mappings/sendgrid-send-email.json
{
  "request": {
    "method": "POST",
    "urlPathPattern": "/v3/mail/send"
  },
  "response": {
    "status": 202,
    "headers": {
      "Content-Type": "application/json",
      "X-Message-Id": "mock-{{randomValue type='UUID'}}"
    },
    "jsonBody": {
      "message": "Email accepted for delivery (mock)"
    }
  }
}
```

### Configuring Services to Use Mocks

The Payment Service checks the `PAYMENT_PROVIDER` environment variable:

```typescript
// services/payment-service/src/payment.provider.factory.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeProvider } from './providers/stripe.provider';
import { MockPaymentProvider } from './providers/mock.provider';
import { PaymentProvider } from './interfaces/payment-provider.interface';

@Injectable()
export class PaymentProviderFactory {
  constructor(private configService: ConfigService) {}

  create(): PaymentProvider {
    const provider = this.configService.get<string>('PAYMENT_PROVIDER');

    switch (provider) {
      case 'stripe':
        return new StripeProvider({
          apiKey: this.configService.getOrThrow('STRIPE_API_KEY'),
          // In development with WireMock, override the base URL
          apiBase: this.configService.get('STRIPE_API_BASE', 'https://api.stripe.com'),
        });

      case 'mock':
        return new MockPaymentProvider();

      default:
        throw new Error(`Unknown payment provider: ${provider}`);
    }
  }
}
```

In `docker-compose.yml`, the Payment Service has `PAYMENT_PROVIDER: mock`. When you need to test with WireMock instead (for more realistic HTTP behavior), change it to `stripe` and add `STRIPE_API_BASE: http://wiremock:8080`:

```yaml
payment-service:
  environment:
    PAYMENT_PROVIDER: stripe
    STRIPE_API_KEY: sk_test_mock_key
    STRIPE_API_BASE: http://wiremock:8080   # Redirect Stripe calls to WireMock
```

> **Analogy:** Mock services are like flight simulators. A pilot trains in a simulator that looks and feels like a real cockpit, but the "outside" is a projection. WireMock projects realistic API responses. Your code cannot tell the difference between WireMock and the real Stripe API — the HTTP requests and responses look identical. But no credit cards are charged, no emails are sent, and you can simulate any scenario including network failures.

---

## Environment Variables: The .env Configuration Layer

Every service needs configuration: database URLs, API keys, feature flags, log levels. Hardcoding these values is a security risk and prevents you from running the same code in different environments. The `.env` file pattern solves this cleanly.

### The .env File Structure

The project uses three environment files with a clear hierarchy:

```bash
# .env.example — Checked into git. Documents every variable.
# .env.development — Checked into git. Safe defaults for local dev.
# .env.local — NOT checked into git. Personal overrides.
# .env — NOT checked into git. Active configuration (copied from .env.development).
```

```bash
# .env.development
# Global Booking System — Local Development Configuration
# Copy this to .env before running: cp .env.development .env

# ──────────────────────────────────────────
# DATABASE
# ──────────────────────────────────────────
DATABASE_URL=mysql://booking_user:booking_pass@localhost:3306/booking_dev
MYSQL_ROOT_PASSWORD=rootpassword
MYSQL_DATABASE=booking_dev
MYSQL_USER=booking_user
MYSQL_PASSWORD=booking_pass
MYSQL_PORT=3306

# ──────────────────────────────────────────
# REDIS
# ──────────────────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# ──────────────────────────────────────────
# KAFKA
# ──────────────────────────────────────────
KAFKA_BROKERS=localhost:9094
KAFKA_CLIENT_ID=gbs-dev
KAFKA_GROUP_ID=gbs-dev-group

# ──────────────────────────────────────────
# ELASTICSEARCH
# ──────────────────────────────────────────
ELASTICSEARCH_URL=http://localhost:9200
ES_PORT=9200

# ──────────────────────────────────────────
# AUTHENTICATION
# ──────────────────────────────────────────
JWT_SECRET=dev-secret-do-not-use-in-production
JWT_EXPIRATION=3600
BCRYPT_ROUNDS=10

# ──────────────────────────────────────────
# EXTERNAL SERVICES
# ──────────────────────────────────────────
PAYMENT_PROVIDER=mock
STRIPE_TEST_KEY=sk_test_mock_key
STRIPE_API_BASE=http://localhost:8089
EMAIL_PROVIDER=mock
SENDGRID_API_KEY=SG.mock_key
SMS_PROVIDER=mock
TWILIO_ACCOUNT_SID=AC_mock
TWILIO_AUTH_TOKEN=mock_token

# ──────────────────────────────────────────
# OBSERVABILITY
# ──────────────────────────────────────────
JAEGER_ENDPOINT=http://localhost:4318/v1/traces
LOG_LEVEL=debug
LOG_FORMAT=pretty

# ──────────────────────────────────────────
# APPLICATION
# ──────────────────────────────────────────
NODE_ENV=development
API_PORT=3000
RATE_LIMIT_MAX=1000
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

### The Configuration Module

Each NestJS service loads environment variables through a validated configuration module:

```typescript
// libs/config/src/app-config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        '.env.local',        // Highest priority: personal overrides
        '.env',              // Standard config
        '.env.development',  // Fallback defaults
      ],
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'test', 'staging', 'production')
          .default('development'),
        SERVICE_NAME: Joi.string().required(),
        SERVICE_PORT: Joi.number().default(3000),
        DB_HOST: Joi.string().default('localhost'),
        DB_PORT: Joi.number().default(3306),
        DB_NAME: Joi.string().default('booking_dev'),
        DB_USER: Joi.string().default('booking_user'),
        DB_PASSWORD: Joi.string().default('booking_pass'),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        KAFKA_BROKERS: Joi.string().default('localhost:9094'),
        JWT_SECRET: Joi.string().required(),
        LOG_LEVEL: Joi.string()
          .valid('error', 'warn', 'info', 'debug', 'verbose')
          .default('info'),
      }),
      validationOptions: {
        allowUnknown: true,      // Don't fail on extra variables
        abortEarly: false,       // Report ALL validation errors, not just the first
      },
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
```

> **Why Joi Validation?** Without validation, a missing environment variable causes a runtime error deep in your code — "Cannot read property 'host' of undefined" when the database client initializes. With Joi, the service fails on startup with a clear message: `"JWT_SECRET" is required`. You find out immediately, not ten minutes into debugging a connection error.

### The .gitignore Rules

```gitignore
# .gitignore — Environment file rules
.env
.env.local
.env.*.local

# These ARE committed (safe defaults, no real secrets):
# .env.development
# .env.example
# .env.test
```

The rule is simple: if it contains real secrets, it does not go into git. Development defaults with fake passwords like `booking_pass` are safe to commit because they only work against a local Docker database that is not accessible from the internet.

> **What If You Skip This?** Without validated config, new developers will spend 30 minutes figuring out which environment variables they are missing. The service crashes with a generic error, they grep the source code for `process.env`, they find 40 different variable references, and they have no idea which ones are required versus optional. Joi validation with `.env.example` eliminates this entirely.

---

## Local Debugging: VS Code launch.json for Containers

`console.log` debugging works until it does not. When you need to step through code line by line, inspect variable values, and understand control flow, you need a proper debugger. VS Code can attach to Node.js processes running inside Docker containers.

### The Debug Configuration

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Booking Service",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "address": "localhost",
      "localRoot": "${workspaceFolder}/services/booking-service",
      "remoteRoot": "/app/services/booking-service",
      "restart": true,
      "sourceMaps": true,
      "skipFiles": [
        "<node_internals>/**",
        "**/node_modules/**"
      ],
      "outFiles": [],
      "timeout": 30000
    },
    {
      "name": "Debug Inventory Service",
      "type": "node",
      "request": "attach",
      "port": 9230,
      "address": "localhost",
      "localRoot": "${workspaceFolder}/services/inventory-service",
      "remoteRoot": "/app/services/inventory-service",
      "restart": true,
      "sourceMaps": true,
      "skipFiles": [
        "<node_internals>/**",
        "**/node_modules/**"
      ]
    },
    {
      "name": "Debug Payment Service",
      "type": "node",
      "request": "attach",
      "port": 9231,
      "address": "localhost",
      "localRoot": "${workspaceFolder}/services/payment-service",
      "remoteRoot": "/app/services/payment-service",
      "restart": true,
      "sourceMaps": true,
      "skipFiles": [
        "<node_internals>/**",
        "**/node_modules/**"
      ]
    },
    {
      "name": "Debug API Gateway",
      "type": "node",
      "request": "attach",
      "port": 9232,
      "address": "localhost",
      "localRoot": "${workspaceFolder}/services/api-gateway",
      "remoteRoot": "/app/services/api-gateway",
      "restart": true,
      "sourceMaps": true,
      "skipFiles": [
        "<node_internals>/**",
        "**/node_modules/**"
      ]
    },
    {
      "name": "Debug Current Jest Test",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "npx",
      "runtimeArgs": [
        "jest",
        "--runInBand",
        "--no-cache",
        "${relativeFile}"
      ],
      "console": "integratedTerminal",
      "sourceMaps": true,
      "skipFiles": [
        "<node_internals>/**",
        "**/node_modules/**"
      ]
    }
  ],
  "compounds": [
    {
      "name": "Debug All Services",
      "configurations": [
        "Debug Booking Service",
        "Debug Inventory Service",
        "Debug Payment Service",
        "Debug API Gateway"
      ]
    }
  ]
}
```

### How Remote Debugging Works

The Dockerfile.dev starts Node.js with `--inspect=0.0.0.0:9229`. This enables the V8 Inspector Protocol on port 9229 inside the container. The `docker-compose.yml` maps each service's debug port to a unique host port:

```
Container Port 9229  ────►  Host Port 9229  (Booking Service)
Container Port 9229  ────►  Host Port 9230  (Inventory Service)
Container Port 9229  ────►  Host Port 9231  (Payment Service)
Container Port 9229  ────►  Host Port 9232  (API Gateway)
```

Each VS Code debug configuration specifies which port to attach to. The `localRoot` and `remoteRoot` properties tell VS Code how to map file paths between your laptop and the container. When the debugger stops at `/app/services/booking-service/src/booking.service.ts:42` inside the container, VS Code opens `${workspaceFolder}/services/booking-service/src/booking.service.ts` at line 42 on your laptop.

The `restart: true` setting is essential for hot reloading compatibility. When nodemon restarts the Node.js process after a file change, the debug connection drops. With `restart: true`, VS Code automatically reconnects to the new process. Without it, you have to manually click "Attach" again after every file save.

> **Key Term:** **V8 Inspector Protocol** — The debugging protocol built into Node.js (via the V8 JavaScript engine). When you start Node.js with `--inspect`, it exposes a WebSocket endpoint that debuggers like VS Code, Chrome DevTools, and WebStorm can connect to for setting breakpoints, stepping through code, and inspecting variables.

### Recommended VS Code Extensions

```json
// .vscode/extensions.json
{
  "recommendations": [
    "dbaeumer.vscode-eslint",
    "esbenp.prettier-vscode",
    "prisma.prisma",
    "ms-azuretools.vscode-docker",
    "humao.rest-client",
    "streetsidesoftware.code-spell-checker",
    "eamodio.gitlens",
    "ms-vscode.vscode-typescript-next",
    "firsttris.vscode-jest-runner"
  ]
}
```

When a new developer opens the project in VS Code, they see a prompt: "This workspace has extension recommendations. Would you like to install them?" One click, and they have the exact same development environment as the rest of the team.

---

## Makefile: One Command to Rule Them All

Nobody wants to remember `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --build --remove-orphans`. A `Makefile` wraps these long commands into short, memorable targets.

```makefile
# Makefile — Global Booking System Development Commands
# Usage: make <target>
# Run 'make help' to see all available commands.

.PHONY: help start stop restart build logs seed reset test lint clean nuke status

# Default target
.DEFAULT_GOAL := help

# Colors for help output
BLUE := \033[36m
RESET := \033[0m

help: ## Show this help message
	@echo "Global Booking System — Development Commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(BLUE)%-15s$(RESET) %s\n", $$1, $$2}'

# ──────────────────────────────────────────
# LIFECYCLE
# ──────────────────────────────────────────

start: ## Start all services (infrastructure + applications)
	docker compose up -d
	@echo ""
	@echo "Services starting. Run 'make status' to check health."
	@echo "API Gateway:     http://localhost:3000"
	@echo "Kafka UI:        http://localhost:8090"
	@echo "Jaeger UI:       http://localhost:16686"
	@echo "Elasticsearch:   http://localhost:9200"
	@echo "WireMock:        http://localhost:8089/__admin"

stop: ## Stop all services (preserves data volumes)
	docker compose stop

down: ## Stop and remove all containers (preserves data volumes)
	docker compose down

restart: ## Restart all services
	docker compose restart

restart-service: ## Restart a single service (usage: make restart-service SVC=booking-service)
	docker compose restart $(SVC)

build: ## Rebuild all Docker images (use after Dockerfile changes)
	docker compose build --no-cache

build-service: ## Rebuild a single service (usage: make build-service SVC=booking-service)
	docker compose build --no-cache $(SVC)

# ──────────────────────────────────────────
# DATABASE
# ──────────────────────────────────────────

seed: ## Seed the database with test data
	docker compose exec booking-service npx prisma db seed
	@echo "Database seeded successfully."

migrate: ## Run database migrations
	docker compose exec booking-service npx prisma migrate dev
	@echo "Migrations applied."

reset: ## Reset database: drop all tables, re-migrate, re-seed
	docker compose exec booking-service npx prisma migrate reset --force
	@echo "Database reset and re-seeded."

studio: ## Open Prisma Studio (database GUI) on http://localhost:5555
	docker compose exec booking-service npx prisma studio

# ──────────────────────────────────────────
# TESTING
# ──────────────────────────────────────────

test: ## Run all unit tests
	docker compose exec booking-service npm run test
	docker compose exec inventory-service npm run test
	docker compose exec payment-service npm run test

test-service: ## Run tests for a single service (usage: make test-service SVC=booking-service)
	docker compose exec $(SVC) npm run test

test-e2e: ## Run end-to-end tests
	docker compose exec api-gateway npm run test:e2e

test-coverage: ## Run tests with coverage report
	docker compose exec booking-service npm run test:cov

# ──────────────────────────────────────────
# QUALITY
# ──────────────────────────────────────────

lint: ## Run ESLint across all services
	docker compose exec booking-service npm run lint

lint-fix: ## Run ESLint with auto-fix
	docker compose exec booking-service npm run lint -- --fix

format: ## Run Prettier to format code
	npx prettier --write "services/**/*.ts" "libs/**/*.ts"

# ──────────────────────────────────────────
# LOGS & STATUS
# ──────────────────────────────────────────

logs: ## Tail logs from all services
	docker compose logs -f --tail=100

logs-service: ## Tail logs from one service (usage: make logs-service SVC=booking-service)
	docker compose logs -f --tail=100 $(SVC)

logs-infra: ## Tail logs from infrastructure only (MySQL, Redis, Kafka, ES)
	docker compose logs -f --tail=50 mysql redis kafka elasticsearch

status: ## Show status of all containers with health info
	@echo "Container Status:"
	@docker compose ps
	@echo ""
	@echo "Health Checks:"
	@docker inspect --format='{{.Name}}: {{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' $$(docker compose ps -q) 2>/dev/null || true

# ──────────────────────────────────────────
# CLEANUP
# ──────────────────────────────────────────

clean: ## Remove containers, networks (preserve volumes/data)
	docker compose down --remove-orphans

nuke: ## DANGER: Remove everything including data volumes
	@echo "WARNING: This will delete all data (database, Kafka topics, ES indices)."
	@read -p "Are you sure? [y/N] " confirm && [ "$$confirm" = "y" ] || exit 1
	docker compose down -v --remove-orphans
	@echo "All containers, networks, and volumes removed."

prune: ## Remove unused Docker resources (dangling images, stopped containers)
	docker system prune -f
	@echo "Unused Docker resources cleaned up."

# ──────────────────────────────────────────
# SHORTCUTS
# ──────────────────────────────────────────

up: start ## Alias for 'start'
s: status ## Alias for 'status'
l: logs ## Alias for 'logs'

# ──────────────────────────────────────────
# SETUP (first-time only)
# ──────────────────────────────────────────

setup: ## First-time setup: copy env files, build images, start services, seed data
	@test -f .env || cp .env.development .env
	@echo "Environment file ready."
	docker compose build
	docker compose up -d
	@echo "Waiting for services to become healthy..."
	@sleep 30
	docker compose exec booking-service npx prisma migrate dev
	docker compose exec booking-service npx prisma db seed
	@echo ""
	@echo "Setup complete! The Global Booking System is running."
	@echo "Run 'make status' to verify all services are healthy."
```

### Why a Makefile Instead of npm Scripts?

You might ask: why not put everything in `package.json` scripts? Three reasons.

First, Makefiles support targets with descriptions. Running `make help` prints a formatted list of every command with its purpose. npm scripts require you to open `package.json` and read through them.

Second, Makefiles handle multi-line commands naturally. A Docker Compose command with flags, pipes, and conditional logic looks clean in a Makefile but becomes an unreadable one-liner in `package.json`.

Third, Makefiles are universal. They work on macOS, Linux, and Windows (with WSL or Git Bash). Every developer, regardless of whether they are a Node.js expert, knows `make start` and `make stop`. It is the lowest common denominator of build tools.

> **What If You Skip This?** Without a Makefile, your README contains 25 different Docker Compose commands. Developers bookmark the README, Ctrl+F for the command they need, copy-paste it, and sometimes make typos. One developer types `docker compose down -v` when they meant `docker compose down`, accidentally deleting all database data. The Makefile's `nuke` target at least asks for confirmation.

---

## Common Local Development Problems and Solutions

Every team encounters the same problems when running microservices locally. Here are the ones you will hit, roughly in the order you will hit them, with solutions.

### Problem 1: Port Conflicts

**Symptom:** `Bind for 0.0.0.0:3306 failed: port is already allocated`

**Cause:** Another process (often a native MySQL installation or another Docker project) is using port 3306.

**Solution:** Find and stop the conflicting process, or change the port in `.env`:

```bash
# Find what is using port 3306
# macOS / Linux:
lsof -i :3306

# Windows:
netstat -ano | findstr :3306

# Option 1: Stop the conflicting process
# Option 2: Change the port in .env
MYSQL_PORT=3307
```

The Docker Compose file uses `${MYSQL_PORT:-3306}:3306`, which means it reads the host port from the environment variable but always maps to 3306 inside the container. Changing `MYSQL_PORT` to 3307 means your laptop connects on 3307, but the services inside Docker still connect on 3306 via the Docker network.

### Problem 2: Docker Desktop Memory Limits

**Symptom:** Containers exit with code 137 (OOM killed), Elasticsearch refuses to start, or everything is extremely slow.

**Cause:** Docker Desktop defaults to 2 GB of RAM on macOS and Windows. The Global Booking System stack needs at least 4 GB.

**Solution:** Increase Docker Desktop memory allocation:

```
Docker Desktop → Settings → Resources → Memory → Set to 6 GB minimum
```

```
Recommended resource allocation for the Global Booking System:

┌──────────────────────┬──────────────┬────────────────────┐
│ Component            │ Memory (MB)  │ Notes              │
├──────────────────────┼──────────────┼────────────────────┤
│ MySQL                │ 256-512      │ innodb-buffer-pool  │
│ Redis                │ 50-100       │ Minimal in dev     │
│ Kafka                │ 512-768      │ JVM heap           │
│ Elasticsearch        │ 512-1024     │ Capped by compose  │
│ Jaeger               │ 128-256      │ In-memory storage  │
│ 7 NestJS services    │ 7 × 150      │ ~1050 total        │
│ Docker overhead      │ 256-512      │ Engine + networking│
├──────────────────────┼──────────────┼────────────────────┤
│ TOTAL                │ ~3-4 GB      │ 6 GB recommended   │
└──────────────────────┴──────────────┴────────────────────┘
```

### Problem 3: Docker DNS Resolution Failures

**Symptom:** Services cannot find each other. Errors like `getaddrinfo ENOTFOUND kafka` or `connect ECONNREFUSED mysql`.

**Cause:** The service is trying to connect to `kafka` or `mysql` as a hostname, but DNS resolution inside the Docker network is failing. This usually happens when a container starts before the target container is on the network.

**Solution:** Ensure all services are on the same Docker network and use health checks:

```yaml
# Verify all services share the network:
networks:
  - booking-network

# Add health-check-based dependencies:
depends_on:
  mysql:
    condition: service_healthy
  redis:
    condition: service_healthy
```

If DNS still fails, restart the Docker daemon. Docker's embedded DNS server occasionally corrupts its cache:

```bash
# Restart Docker Desktop (macOS/Windows)
# or restart the Docker daemon (Linux):
sudo systemctl restart docker
```

### Problem 4: File Watching Not Working (macOS/Windows)

**Symptom:** You save a file but the service does not reload. Hot reloading works on one machine but not another.

**Cause:** Docker Desktop on macOS and Windows uses a VM to run Linux containers. File system events from the host must cross the VM boundary. Older or misconfigured setups use polling instead of native events, which can be slow or miss changes entirely.

**Solution:** Enable the VirtioFS file sharing backend in Docker Desktop settings, which provides near-native performance for file system events:

```
Docker Desktop → Settings → General → "Use VirtioFS" → Enable
```

If that is not available, configure nodemon to use polling as a fallback:

```json
// nodemon.json — polling fallback
{
  "legacyWatch": true,
  "pollingInterval": 1000
}
```

Polling checks every second instead of relying on file system events. It uses more CPU but works reliably everywhere.

### Problem 5: "no space left on device" Errors

**Symptom:** Docker build fails with "no space left on device" even though your hard drive has plenty of space.

**Cause:** Docker Desktop stores images, containers, and volumes in a virtual disk file that has a size limit (typically 60 GB). Old images, stopped containers, and unused volumes accumulate over time.

**Solution:**

```bash
# See what is using space
docker system df

# Remove unused resources
make prune

# Nuclear option: remove all unused images, containers, volumes, and networks
docker system prune -a --volumes
```

> **Preventive Measure:** Add `make prune` to your weekly routine. Docker images for different Node.js versions, Elasticsearch versions, and failed builds accumulate. A team member who has been on the project for six months may have 40 GB of Docker data.

