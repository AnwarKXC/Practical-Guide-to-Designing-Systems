# PART II: THE BOOKING FLOW

Welcome to the heart of the Global Booking System. In Part I you learned the foundational building blocks -- the database schemas, the infrastructure topology, the guiding principles. Now you will follow a single booking request from the moment it hits the API Gateway to the moment inventory is held for a customer. Every service you encounter here exists because of a concrete problem: authentication must happen before anything else, search must be fast enough to keep users engaged, and inventory must be protected against concurrent access.

This part covers four critical layers in order. First, the API Gateway receives and routes the request while enforcing security headers and rate limits. Second, the authentication and authorization layer verifies who the user is and what they are allowed to do. Third, the Search Service translates user intent (dates, location, budget) into sub-200ms query results using Elasticsearch. Fourth, the Inventory Management service places a temporary hold on the requested resource, using fencing tokens and a state machine to prevent double-booking.

This is the happy path. Parts III and IV handle what happens when things go wrong -- payment failures, partial saga rollbacks, network partitions between regions, and all the edge cases that make distributed systems genuinely difficult. For now, assume every call succeeds, every service responds, and the user completes their booking without interruption. Understanding the happy path thoroughly is a prerequisite for understanding failure handling.

---

## 4. API Gateway & Request Routing

> **Learning Objectives**
> - Understand why a single entry point (API Gateway) exists and what cross-cutting concerns it absorbs from downstream services.
> - Read and interpret a declarative Kong Gateway configuration including services, routes, and plugins.
> - Explain the difference between liveness and readiness health checks and why both are necessary.
> - Identify which security headers the gateway injects and why each one matters.
> - Describe how the gateway routes requests to internal Kubernetes services using cluster-local DNS.

**Why:** The API Gateway is the single entry point for all client requests. It handles cross-cutting concerns -- authentication, rate limiting, request logging, CORS -- so individual microservices don't have to. Without a gateway, every service would need to implement these independently, leading to inconsistency and security gaps.

### 4.1 Kong Gateway Configuration

```yaml
# kong.yml - Declarative configuration
_format_version: "3.0"

services:
  - name: booking-service
    url: http://booking-service.production.svc.cluster.local:3000
    routes:
      - name: booking-routes
        paths:
          - /api/v1/bookings
        methods:
          - GET
          - POST
        strip_path: false

  - name: inventory-service
    url: http://inventory-service.production.svc.cluster.local:3000
    routes:
      - name: inventory-routes
        paths:
          - /api/v1/inventory
        methods:
          - GET
        strip_path: false

  - name: payment-service
    url: http://payment-service.production.svc.cluster.local:3000
    routes:
      - name: payment-routes
        paths:
          - /api/v1/payments
        methods:
          - POST
        strip_path: false

  - name: search-service
    url: http://search-service.production.svc.cluster.local:3000
    routes:
      - name: search-routes
        paths:
          - /api/v1/search
        methods:
          - GET
        strip_path: false

plugins:
  - name: cors
    config:
      origins:
        - "https://www.bookingplatform.com"
        - "https://app.bookingplatform.com"
      methods:
        - GET
        - POST
        - PUT
        - DELETE
        - OPTIONS
      headers:
        - Authorization
        - Content-Type
        - Idempotency-Key
        - X-Request-ID
      max_age: 3600
      credentials: true

  - name: request-transformer
    config:
      add:
        headers:
          - "X-Gateway-Region:us-east-1"
          - "X-Gateway-Timestamp:$(date +%s)"

  - name: response-transformer
    config:
      add:
        headers:
          - "Strict-Transport-Security:max-age=31536000; includeSubDomains"
          - "X-Content-Type-Options:nosniff"
          - "X-Frame-Options:DENY"
          - "Content-Security-Policy:default-src 'self'"
```

### 4.2 Health Check Endpoints

```typescript
// Every service exposes standardized health endpoints

// Liveness: Is the process alive?
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: Can the service accept traffic?
app.get('/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});
```

### Key Takeaways

- The API Gateway centralizes cross-cutting concerns (CORS, security headers, request transformation) so that individual microservices remain focused on business logic.
- Kong's declarative YAML configuration maps external URL paths to internal Kubernetes service addresses, with `strip_path: false` preserving the original path for downstream routing.
- Security headers like `Strict-Transport-Security`, `X-Content-Type-Options`, and `Content-Security-Policy` are injected at the gateway level, guaranteeing every response includes them regardless of which service handled the request.
- Liveness checks (`/health`) tell the orchestrator whether to restart a container; readiness checks (`/ready`) tell the load balancer whether to send traffic. Conflating the two causes either unnecessary restarts or traffic routed to broken instances.

### Review Questions

1. **Conceptual:** Why does the gateway configuration set `strip_path: false` on all routes? What would happen if it were set to `true` and the downstream service expected the full `/api/v1/bookings` path?
2. **Code-reading:** Look at the readiness endpoint. It checks both `db.query('SELECT 1')` and `redis.ping()`. If Redis is down but the database is up, the service reports `not_ready`. Is this the right behavior for a service that could technically serve some requests without Redis? What trade-off is being made?
3. **Conceptual:** The `Idempotency-Key` header is listed in the CORS allowed headers. Why would a booking platform need clients to send idempotency keys, and what problems does this prevent at the gateway level?

### Hands-On Exercise

**Add a new service route to the Kong configuration.** Suppose you are introducing a `notification-service` that listens on `http://notification-service.production.svc.cluster.local:3000` and should be reachable at `/api/v1/notifications` for both `GET` and `POST` methods. Write the YAML block that adds this service and its route to the existing `kong.yml`. Then add a rate-limiting plugin scoped only to this new service (not globally) that limits requests to 100 per minute per consumer. Refer to the Kong plugin documentation format used by the `cors` plugin as a structural guide.

---

## 5. Authentication & Authorization

> **Learning Objectives**
> - Understand the separation between authentication (who you are) and authorization (what you can do) and why both are necessary in a booking platform.
> - Trace the lifecycle of a JWT token pair from generation through verification to revocation.
> - Explain how Redis-backed session storage enables token revocation without waiting for token expiry.
> - Read and interpret an RBAC (Role-Based Access Control) permission model and its application via decorators.
> - Describe why service-to-service authentication uses a different mechanism (mTLS + API keys) than user-facing authentication (JWT).

**Why:** A booking platform handles financial transactions and personal data. Authentication verifies identity; authorization ensures users can only access their own bookings. Service-to-service communication needs its own auth to prevent unauthorized internal access.

### 5.1 JWT Token Structure

```typescript
// ============================================
// JWT Token Service
// ============================================

import jwt from 'jsonwebtoken';

interface TokenPayload {
  userId: string;       // Use string to avoid BigInt JSON serialization issues
  email: string;
  roles: string[];
  region: string;
  sessionId: string;
}

export class AuthService {
  private readonly accessTokenSecret = process.env.JWT_ACCESS_SECRET;
  private readonly refreshTokenSecret = process.env.JWT_REFRESH_SECRET;

  async generateTokenPair(user: User): Promise<TokenPair> {
    const payload: TokenPayload = {
      userId: user.id.toString(),  // Convert BigInt to string for JSON safety
      email: user.email,
      roles: user.roles,
      region: process.env.REGION,
      sessionId: randomUUID()
    };

    const accessToken = jwt.sign(payload, this.accessTokenSecret, {
      expiresIn: '15m',
      issuer: 'booking-platform',
      audience: 'booking-api'
    });

    const refreshToken = jwt.sign(
      { userId: user.id, sessionId: payload.sessionId },
      this.refreshTokenSecret,
      { expiresIn: '7d' }
    );

    // Store session in Redis for revocation support
    await redis.setex(
      `session:${payload.sessionId}`,
      7 * 24 * 60 * 60, // 7 days
      JSON.stringify({ userId: user.id, createdAt: Date.now() })
    );

    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    const payload = jwt.verify(token, this.accessTokenSecret) as TokenPayload;

    // Check if session has been revoked
    const session = await redis.get(`session:${payload.sessionId}`);
    if (!session) {
      throw new UnauthorizedError('Session has been revoked');
    }

    return payload;
  }
}
```

### 5.2 RBAC Roles

```typescript
export enum Role {
  GUEST = 'guest',           // Can search, view prices
  USER = 'user',             // Can book, view own bookings
  PREMIUM_USER = 'premium',  // Higher rate limits, priority support
  ADMIN = 'admin',           // Manage bookings, view reports
  SUPER_ADMIN = 'super_admin' // System configuration, user management
}

// Permission guard decorator for NestJS
export const RequireRoles = (...roles: Role[]) => {
  return SetMetadata('roles', roles);
};

// Usage in controllers
@Post('/bookings')
@RequireRoles(Role.USER, Role.PREMIUM_USER, Role.ADMIN)
async createBooking(@Body() dto: CreateBookingDto) {
  // Only authenticated users with appropriate roles
}

@Get('/admin/reports')
@RequireRoles(Role.ADMIN, Role.SUPER_ADMIN)
async getReports() {
  // Admin-only endpoint
}
```

### 5.3 Service-to-Service Authentication

```typescript
// Internal services authenticate via mTLS (handled by Istio)
// plus API key validation for defense in depth

export class ServiceAuthMiddleware {
  async validate(req: Request, res: Response, next: NextFunction) {
    const serviceKey = req.headers['x-service-key'];
    const serviceName = req.headers['x-service'];

    if (!serviceKey || !serviceName) {
      return res.status(401).json({ error: 'Missing service credentials' });
    }

    const validKey = await redis.get(`service-key:${serviceName}`);
    if (validKey !== serviceKey) {
      return res.status(403).json({ error: 'Invalid service key' });
    }

    next();
  }
}
```

### Key Takeaways

- Access tokens are short-lived (15 minutes) to limit the damage window if a token is leaked; refresh tokens are long-lived (7 days) and paired with a Redis-backed session store that allows instant revocation.
- The `userId` field is stored as a string in the JWT payload because JavaScript's `JSON.stringify` cannot safely serialize BigInt values -- a subtle but important detail when your database uses 64-bit identifiers.
- RBAC is enforced via decorators (`@RequireRoles`) that attach metadata to route handlers, keeping authorization logic declarative and co-located with the endpoint definition rather than buried in middleware.
- Service-to-service authentication uses a layered defense: mTLS at the network level (handled by the Istio service mesh) plus application-level API key validation. Either layer alone is insufficient -- mTLS can be bypassed if the mesh is misconfigured, and API keys can be leaked.

### Review Questions

1. **Code-reading:** In `generateTokenPair`, the access token includes `email`, `roles`, and `region`, but the refresh token only includes `userId` and `sessionId`. Why is the refresh token's payload deliberately minimal? What would go wrong if the refresh token also contained roles?
2. **Conceptual:** The `verifyAccessToken` method checks Redis on every request to confirm the session has not been revoked. This adds a network round-trip to every authenticated API call. What is the trade-off being made here, and can you think of an alternative approach that avoids hitting Redis on every request while still supporting revocation?
3. **Code-reading:** In the `ServiceAuthMiddleware`, the code returns HTTP 401 for missing credentials but HTTP 403 for invalid credentials. What is the semantic difference between these two status codes, and why is it important to use the correct one?

### Hands-On Exercise

**Implement a token refresh endpoint.** Using the `AuthService` class as a starting point, write a `refreshAccessToken(refreshToken: string): Promise<TokenPair>` method. It should: (a) verify the refresh token using `this.refreshTokenSecret`, (b) check that the session still exists in Redis, (c) look up the current user from the database to get their latest roles (since roles may have changed since the original token was issued), and (d) generate and return a new token pair. Make sure to invalidate the old session and create a new one so that refresh tokens are single-use. Write out the full method implementation with error handling.

---

## 6. Search Service

> **Learning Objectives**
> - Understand why a dedicated search engine (Elasticsearch) is used instead of querying the primary MySQL database for read-heavy operations.
> - Identify this as the **read** side of the CQRS pattern and explain how it stays in sync with the write side.
> - Read and interpret a compound Elasticsearch query that combines geo-distance filtering, date range checks, price filtering, and amenity matching.
> - Explain how the search index is updated asynchronously via Kafka events from the transactional outbox.
> - Understand the pagination model (`from`/`size`) and its limitations at scale.

**Why:** Users need to find hotels, flights, and cars quickly with complex filters (location, dates, price range, amenities). The primary database (MySQL) is optimized for transactions, not full-text search or geo-queries. A dedicated search engine provides sub-200ms results. This is the **read** side of the CQRS pattern (Section 8) -- writes go to MySQL, reads are served from Elasticsearch.

### 6.1 Elasticsearch Integration

```typescript
// ============================================
// Search Service
// ============================================

import { Client } from '@elastic/elasticsearch';

export class SearchService {
  private readonly esClient = new Client({
    node: process.env.ELASTICSEARCH_URL,
    auth: { apiKey: process.env.ELASTICSEARCH_API_KEY }
  });

  async searchHotels(params: HotelSearchParams): Promise<SearchResult> {
    const { body } = await this.esClient.search({
      index: 'hotels',
      body: {
        query: {
          bool: {
            must: [
              // Geo-distance filter
              {
                geo_distance: {
                  distance: `${params.radiusKm || 50}km`,
                  location: {
                    lat: params.latitude,
                    lon: params.longitude
                  }
                }
              },
              // Date availability
              {
                range: {
                  available_from: { lte: params.checkIn }
                }
              },
              {
                range: {
                  available_to: { gte: params.checkOut }
                }
              }
            ],
            filter: [
              // Price range
              ...(params.minPrice || params.maxPrice ? [{
                range: {
                  price_per_night: {
                    ...(params.minPrice && { gte: params.minPrice }),
                    ...(params.maxPrice && { lte: params.maxPrice })
                  }
                }
              }] : []),
              // Star rating
              ...(params.minStars ? [{
                range: { star_rating: { gte: params.minStars } }
              }] : []),
              // Amenities
              ...(params.amenities?.length ? [{
                terms: { amenities: params.amenities }
              }] : [])
            ]
          }
        },
        sort: [
          { _score: 'desc' },
          { popularity_score: 'desc' },
          { price_per_night: params.sortByPrice || 'asc' }
        ],
        from: params.offset || 0,
        size: params.limit || 20
      }
    });

    return {
      results: body.hits.hits.map(hit => hit._source),
      total: body.hits.total.value,
      took: body.took
    };
  }

  // Index updates triggered by Kafka events from outbox
  async updateHotelIndex(event: HotelUpdatedEvent): Promise<void> {
    await this.esClient.update({
      index: 'hotels',
      id: event.hotelId.toString(),
      body: {
        doc: {
          price_per_night: event.basePrice,
          available_rooms: event.availableQuantity,
          updated_at: new Date().toISOString()
        }
      }
    });
  }
}
```

### Key Takeaways

- The Search Service exists because MySQL cannot efficiently handle geo-distance queries, full-text search, and complex faceted filtering at the latency targets a booking platform requires (sub-200ms).
- The Elasticsearch query uses a `bool` query with `must` clauses for hard requirements (location proximity, date availability) and `filter` clauses for optional narrowing (price range, star rating, amenities). Filters in the `filter` context are not scored, which makes them faster.
- Index updates are triggered asynchronously by Kafka events originating from the transactional outbox, meaning the search index is eventually consistent with the primary database -- not immediately consistent. A user who just changed a hotel's price may see the old price in search results for a brief window.
- The `from`/`size` pagination approach works for typical user-facing pages but degrades past ~10,000 results. For deep pagination, Elasticsearch's `search_after` API would be needed.
- The `updateHotelIndex` method demonstrates a partial document update (`doc`), which is more efficient than re-indexing the entire hotel document when only price or availability changes.

### Review Questions

1. **Conceptual:** The search query places the `geo_distance` check in the `must` clause, but the price range filter in the `filter` clause. Both are required constraints. What is the practical difference between `must` and `filter` in Elasticsearch, and why is the price range in `filter` instead of `must`?
2. **Code-reading:** The `updateHotelIndex` method updates `price_per_night`, `available_rooms`, and `updated_at`. But the search query filters on `available_from` and `available_to`, not `available_rooms`. How might a zero-room scenario (all rooms booked) be handled to prevent showing sold-out hotels in search results?
3. **Conceptual:** This section states that the search index is the read side of a CQRS pattern (Section 8). What guarantees does eventual consistency provide, and what user-visible anomalies could occur during the window between a write to MySQL and the index update in Elasticsearch?

### Hands-On Exercise

**Extend the search query with a text-based filter.** Suppose hotel documents in the `hotels` index also contain a `description` field (free-text) and a `name` field. Add a `keyword` parameter to `HotelSearchParams` that, when provided, performs a `multi_match` query across both `name` (boosted 3x) and `description`. Place this clause in the correct position within the `bool` query so that it contributes to relevance scoring. Write the modified query section and explain why you placed the clause where you did.

---

## 7. Inventory Management

> **Learning Objectives**
> - Understand why inventory is the most contention-prone part of a booking system and what mechanisms protect it from double-booking.
> - Read and trace the hold state machine through all valid transitions: creation, extension, confirmation, expiry, release, and cancellation.
> - Follow the `createHold` method line-by-line to understand how fencing tokens, transactional boundaries, and outbox events work together.
> - Explain how expired holds are cleaned up safely using a stored procedure with temporary tables and `FOR UPDATE` locking.
> - Interpret overbooking policies and understand the business reasoning behind different limits for different resource types and tiers.

**Why:** Inventory is the most contention-prone part of the system. Multiple users may try to book the last available room simultaneously. The inventory service uses fencing tokens (Section 11), temporary holds with a state machine, and overbooking policies to manage this safely. When a booking is confirmed, the hold flows into the Saga Orchestrator (Section 13) and triggers a double-entry accounting record (Section 9).

### 7.1 Hold State Machine

```
                 +--------+
                 | (none) |
                 +---+----+
                     |
                  createHold
                     |
                 +---v----+
            +--->| active |<---+
            |    +---+----+    |
            |        |         |
       extend TTL    |    hold still valid
            |        |
            +--------+----+--------+--------+
                     |    |        |        |
                 confirm expire  release  cancel
                     |    |        |        |
              +------v-+  +--v---+ +--v----+ +---v-----+
              |confirmed|  |expired| |released| |cancelled|
              +--------+  +------+ +-------+ +---------+
```

### 7.2 Inventory Hold Service

```typescript
// ============================================
// Inventory Hold Service
// ============================================

export class InventoryHoldService {

  async createHold(params: {
    resourceType: string;
    resourceId: bigint;
    resourceDate: Date;
    quantity: number;
    userId: bigint;
    sessionId: string;
    ttlSeconds: number;
  }): Promise<InventoryHold> {

    const holdUuid = randomUUID();
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
    const fencingToken = await this.getNextFencingToken(
      params.resourceType, params.resourceId, params.resourceDate
    );

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Check if user already has active hold for this resource
      const [existing] = await connection.execute(`
        SELECT id FROM inventory_holds
        WHERE user_id = ? AND session_id = ?
        AND resource_type = ? AND resource_id = ? AND resource_date = ?
        AND status = 'active'
      `, [params.userId, params.sessionId, params.resourceType,
          params.resourceId, params.resourceDate]);

      if (existing.length > 0) {
        // Extend existing hold
        await connection.execute(
          'UPDATE inventory_holds SET expires_at = ? WHERE id = ?',
          [expiresAt, existing[0].id]
        );
        await connection.commit();
        return this.getHoldById(existing[0].id);
      }

      // Reserve inventory with fencing token check (Section 11)
      const [result] = await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity + ?,
            available_quantity = available_quantity - ?,
            fencing_token = ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
        AND available_quantity >= ?
        AND (fencing_token IS NULL OR fencing_token < ?)
      `, [params.quantity, params.quantity, fencingToken,
          params.resourceType, params.resourceId, params.resourceDate,
          params.quantity, fencingToken]);

      if (result.affectedRows === 0) {
        throw new InsufficientInventoryError('Not enough inventory available');
      }

      // Create hold record
      const [holdResult] = await connection.execute(`
        INSERT INTO inventory_holds (
          hold_uuid, resource_type, resource_id, resource_date,
          quantity, user_id, session_id, fencing_token,
          region, status, expires_at, hold_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'user_booking')
      `, [holdUuid, params.resourceType, params.resourceId,
          params.resourceDate, params.quantity, params.userId,
          params.sessionId, fencingToken, process.env.REGION, expiresAt]);

      const holdId = holdResult.insertId;

      // Log state transition
      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'none', 'active', 'Hold created by user', ?)
      `, [holdId, `user:${params.userId}`]);

      // Write to outbox for multi-region sync (Section 14)
      await connection.execute(`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, topic, partition_key
        ) VALUES ('inventory_hold', ?, 'inventory.hold_created', ?, 'inventory-events', ?)
      `, [holdId, JSON.stringify({ holdId, holdUuid, ...params, fencingToken, expiresAt }),
          `${params.resourceType}:${params.resourceId}`]);

      await connection.commit();
      return this.getHoldById(holdId);

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async confirmHold(holdId: bigint, bookingId: bigint): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [result] = await connection.execute(`
        UPDATE inventory_holds
        SET status = 'confirmed', booking_id = ?, confirmed_at = NOW()
        WHERE id = ? AND status = 'active' AND expires_at > NOW()
      `, [bookingId, holdId]);

      if (result.affectedRows === 0) {
        throw new InvalidHoldStateError('Hold is not active or has expired');
      }

      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'confirmed', 'Booking confirmed', ?)
      `, [holdId, `booking:${bookingId}`]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async releaseHold(holdId: bigint, reason: string, releasedBy: string): Promise<void> {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [holds] = await connection.execute(`
        SELECT resource_type, resource_id, resource_date, quantity, status
        FROM inventory_holds WHERE id = ? FOR UPDATE
      `, [holdId]);

      if (holds.length === 0) throw new NotFoundError('Hold not found');
      if (holds[0].status !== 'active') {
        throw new InvalidHoldStateError(`Cannot release hold in status: ${holds[0].status}`);
      }

      const hold = holds[0];

      await connection.execute(`
        UPDATE inventory_holds
        SET status = 'released', released_at = NOW(), released_by = ?
        WHERE id = ?
      `, [releasedBy, holdId]);

      await connection.execute(`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ?,
            available_quantity = available_quantity + ?, updated_at = NOW()
        WHERE resource_type = ? AND resource_id = ? AND resource_date = ?
      `, [hold.quantity, hold.quantity, hold.resource_type,
          hold.resource_id, hold.resource_date]);

      await connection.execute(`
        INSERT INTO inventory_hold_transitions (
          hold_id, from_status, to_status, transition_reason, transitioned_by
        ) VALUES (?, 'active', 'released', ?, ?)
      `, [holdId, reason, releasedBy]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
```

### 7.3 Expired Holds Cleanup

```sql
-- Stored procedure for safe hold release (runs every 30 seconds)
DELIMITER //

CREATE PROCEDURE release_expired_holds()
BEGIN
    DECLARE v_expired_count INT DEFAULT 0;
    DECLARE v_released_quantity INT DEFAULT 0;

    CREATE TEMPORARY TABLE IF NOT EXISTS temp_expired_holds (
        hold_id BIGINT,
        resource_type VARCHAR(20),
        resource_id BIGINT,
        resource_date DATE,
        quantity SMALLINT,
        fencing_token BIGINT
    );

    START TRANSACTION;

    INSERT INTO temp_expired_holds
    SELECT id, resource_type, resource_id, resource_date, quantity, fencing_token
    FROM inventory_holds
    WHERE status = 'active' AND expires_at < NOW()
    FOR UPDATE;

    UPDATE inventory_holds
    SET status = 'expired', released_at = NOW(), released_by = 'system_cron'
    WHERE id IN (SELECT hold_id FROM temp_expired_holds);

    SET v_expired_count = ROW_COUNT();

    UPDATE inventory i
    INNER JOIN temp_expired_holds h ON
        i.resource_type = h.resource_type AND
        i.resource_id = h.resource_id AND
        i.resource_date = h.resource_date
    SET i.reserved_quantity = i.reserved_quantity - h.quantity,
        i.available_quantity = i.available_quantity + h.quantity,
        i.updated_at = NOW()
    WHERE i.fencing_token < h.fencing_token;

    INSERT INTO inventory_hold_transitions (hold_id, from_status, to_status, transition_reason, transitioned_by)
    SELECT hold_id, 'active', 'expired', 'Automatic expiry by cron job', 'system_cron'
    FROM temp_expired_holds;

    COMMIT;

    DROP TEMPORARY TABLE IF EXISTS temp_expired_holds;

    SELECT v_expired_count as expired_holds, NOW() as processed_at;
END//

DELIMITER ;

CREATE EVENT release_expired_holds_event
ON SCHEDULE EVERY 30 SECOND
DO CALL release_expired_holds();
```

### 7.4 Overbooking Policies

```typescript
export const overbookingPolicies = {
  flight: {
    economy: 0.10,      // 10% overbooking allowed
    business: 0.05,     // 5%
    first: 0.00,        // No overbooking for first class
    compensation: {
      voluntary: 400,
      involuntary: 800
    }
  },
  hotel: {
    standard: 0.02,     // 2% overbooking allowed
    premium: 0.00,      // No overbooking for premium rooms
    compensation: {
      upgradeSameHotel: true,
      alternativeHotel: true,
      refundAmount: 1.5  // 1.5x room rate
    }
  },
  car: {
    overbookingLimit: 0.00,
    compensation: {
      upgradeCategory: true,
      refundAmount: 2.0
    }
  }
};
```

### Key Takeaways

- The hold state machine enforces a strict lifecycle: a hold can only be confirmed, expired, released, or cancelled from the `active` state. Every transition is logged in the `inventory_hold_transitions` table, creating a complete audit trail.
- The `createHold` method is idempotent per user-session-resource combination: if a user already has an active hold for the same resource, the method extends the TTL instead of creating a duplicate hold. This prevents inventory leaks from retried requests.
- Fencing tokens prevent stale writes. The `UPDATE inventory ... AND (fencing_token IS NULL OR fencing_token < ?)` clause ensures that if two concurrent requests race, only the one with the higher token succeeds. This is the same pattern detailed in Section 11.
- The expired holds cleanup procedure uses `FOR UPDATE` locking and a temporary table to batch-process expirations safely. Running every 30 seconds means a hold may remain in `active` state up to 30 seconds past its `expires_at` timestamp -- this is acceptable because the `confirmHold` method independently checks `expires_at > NOW()`.
- Overbooking policies are tiered by both resource type and tier (economy vs. first class, standard vs. premium). Higher-tier resources have zero overbooking tolerance, reflecting the business reality that premium customers have less tolerance for displacement.

### Review Questions

1. **Code-reading:** In the `createHold` method, the outbox event is written inside the same database transaction as the inventory update and hold creation. Why is this critical? What would happen if the outbox insert were done after the transaction committed, in a separate operation?
2. **Conceptual:** The expired holds cleanup procedure includes `WHERE i.fencing_token < h.fencing_token` in the inventory restoration UPDATE. Why is this fencing token check necessary during cleanup? What scenario would cause inventory to be incorrectly restored without it?
3. **Code-reading:** The `releaseHold` method uses `SELECT ... FOR UPDATE` to lock the hold row before checking its status. The `confirmHold` method does not -- it relies on the `WHERE status = 'active' AND expires_at > NOW()` clause in the UPDATE itself. Both approaches prevent invalid state transitions. What is the trade-off between these two locking strategies?

### Hands-On Exercise

**Implement the `cancelHold` transition.** Looking at the state machine diagram, `cancel` is a valid transition from `active` to `cancelled`. Write a `cancelHold(holdId: bigint, cancelledBy: string, reason: string): Promise<void>` method for the `InventoryHoldService` class. It should: (a) acquire a row-level lock on the hold, (b) verify the hold is in `active` status, (c) update the hold status to `cancelled`, (d) restore the reserved/available quantities in the `inventory` table, (e) log the transition in `inventory_hold_transitions`, and (f) write an outbox event for multi-region sync. Model your implementation on the `releaseHold` method, but use the appropriate status values and event type for cancellation. Wrap everything in a single transaction with proper error handling and connection cleanup.

---
