# Chapter 40: API Documentation — Writing Docs That Developers Actually Read

## You Have Written READMEs. This Is Different.

You have probably written a `README.md` for a personal project. It says something like "clone the repo, run `npm install`, then `npm start`." Maybe it describes what the project does in a paragraph. That is fine for a solo project on GitHub.

API documentation is a completely different animal.

Here is why: your microservices do not exist in isolation. The Booking Service needs the Inventory Service. The frontend team needs all of them. A partner hotel chain wants to integrate with your booking API. A mobile developer on a different continent, whom you have never met, needs to send a request to your endpoint at 2 AM their time and get it right on the first try — without messaging you on Slack.

If that developer has to read your source code to figure out how your API works, you have failed.

> **Analogy:** Think of API documentation like the menu at a restaurant. The kitchen (your service) knows how to cook everything. But the customer (the developer consuming your API) should not need to walk into the kitchen and read the recipe book. They need a menu that lists every dish (endpoint), what is in it (request body), what it looks like when it arrives (response), and what happens if the kitchen is out of an ingredient (error codes). A restaurant without a menu is chaos. An API without documentation is the same.

> **Key Term:** **API Documentation** — A structured description of every endpoint your service exposes, including the HTTP method, URL path, required headers, request body format, response format, and error codes. It is the contract between your service and everyone who calls it.

---

## Why API Docs Matter: Developer Experience as a Product Feature

Most backend engineers think of documentation as something they do after the "real work" is done. This is backwards. In a system processing 100,000 bookings per minute, your API is consumed by dozens of teams: the web frontend team, the mobile team, the partner integrations team, the data analytics pipeline, the QA automation suite, and external hotel chain developers. Every one of those consumers is a customer of your API.

Developer experience (DX) is a product feature, not a chore. Here is the business case:

**Time to First Successful API Call (TTFSC).** This is the single most important metric for API adoption. If a developer can go from "I have never seen this API" to "I just made a successful booking" in under 15 minutes, your documentation is excellent. If it takes two hours and three Slack messages, your documentation is costing the company real money.

Let us do the math for our system:

- 40 internal developers consume the Booking API.
- Each developer integrates with an average of 6 endpoints.
- Poor documentation adds 30 minutes of confusion per endpoint.
- That is 40 x 6 x 0.5 = 120 hours of wasted developer time.
- At a fully loaded cost of $100/hour, that is $12,000 lost to bad docs — for one service.

Now multiply that across 15 microservices. You are looking at six figures of engineering time burned because someone did not document their error codes.

> **What If You Skip This?** Without comprehensive API documentation, every integration becomes a synchronous, human-dependent process. Developer A messages Developer B on Slack. Developer B is in a meeting. Developer A is blocked for two hours. Developer B misremembers a field name. Developer A debugs for another hour. This pattern repeats hundreds of times across the organization. Good documentation replaces synchronous human communication with asynchronous self-service. It is the difference between a library with a catalog and a library where you have to ask the librarian for every book.

**The Three Audiences of Your Documentation:**

1. **Internal developers** — Your teammates building the frontend, mobile apps, and other microservices. They need accurate, up-to-date reference docs with working examples.
2. **Partner developers** — External companies integrating with your booking platform (hotel chains, travel aggregators, corporate travel tools). They need onboarding guides, authentication walkthroughs, and sandbox environments.
3. **Future you** — The developer who returns to this service in six months and cannot remember why the cancellation endpoint accepts a `compensationStrategy` field. That developer is always you.

---

## OpenAPI/Swagger: The Full Specification for Our Booking API

Writing documentation in Markdown works for small projects, but at enterprise scale you need a machine-readable specification that tools can consume. That specification is OpenAPI.

> **Key Term:** **OpenAPI Specification (OAS)** — A language-agnostic, machine-readable format (YAML or JSON) for describing REST APIs. Originally called Swagger, the specification was donated to the Linux Foundation and renamed OpenAPI in 2015. Version 3.0+ is the current standard. The name "Swagger" now refers to the tooling ecosystem (Swagger UI, Swagger Editor, Swagger Codegen) rather than the specification itself.

Here is the complete OpenAPI 3.0 specification for the core endpoints of our Global Booking System. This is not a simplified example — this is production-grade:

```yaml
openapi: 3.0.3
info:
  title: Global Booking Platform API
  description: |
    Enterprise booking platform supporting hotel, flight, and car rental
    reservations at 100K bookings/minute throughput. This API serves
    internal frontends, mobile applications, and partner integrations.

    ## Rate Limits
    - Standard tier: 100 requests/minute per API key
    - Premium tier: 1,000 requests/minute per API key
    - Enterprise tier: 10,000 requests/minute per API key

    ## Environments
    | Environment | Base URL |
    |---|---|
    | Production | https://api.globalbooking.com |
    | Staging | https://staging-api.globalbooking.com |
    | Sandbox | https://sandbox-api.globalbooking.com |

  version: 1.0.0
  contact:
    name: Platform Engineering Team
    email: platform-api@globalbooking.com
  license:
    name: Proprietary
    url: https://globalbooking.com/api-terms

servers:
  - url: https://api.globalbooking.com
    description: Production
  - url: https://staging-api.globalbooking.com
    description: Staging
  - url: https://sandbox-api.globalbooking.com
    description: Sandbox (safe to test with fake data)

tags:
  - name: Bookings
    description: Create, retrieve, modify, and cancel bookings
  - name: Inventory
    description: Check availability and manage room/seat inventory
  - name: Payments
    description: Process payments and refunds
  - name: Users
    description: User account management and authentication
  - name: Webhooks
    description: Configure and manage webhook subscriptions

security:
  - bearerAuth: []
  - apiKeyAuth: []

paths:
  /api/v1/bookings:
    post:
      tags:
        - Bookings
      summary: Create a new booking
      description: |
        Creates a new hotel, flight, or car rental booking. This endpoint
        is idempotent when an Idempotency-Key header is provided — if
        a request with the same key has already been processed, the
        original response is returned without creating a duplicate.

        **Required permissions:** `bookings:create`

        **Throughput:** This endpoint handles up to 100K requests/minute
        across all consumers.
      operationId: createBooking
      security:
        - bearerAuth: []
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          description: |
            A unique UUID generated by the client. If the network drops
            and the client retries, the server uses this key to detect
            the duplicate and return the original result. Keys expire
            after 24 hours.
          schema:
            type: string
            format: uuid
            example: "550e8400-e29b-41d4-a716-446655440000"
        - name: X-Request-Id
          in: header
          required: false
          description: Optional correlation ID for distributed tracing.
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateBookingRequest'
            examples:
              hotelBooking:
                summary: Standard hotel booking
                value:
                  bookingType: "hotel"
                  hotelId: 12345
                  roomTypeId: 678
                  checkIn: "2026-03-15"
                  checkOut: "2026-03-20"
                  roomsCount: 2
                  guestsCount: 4
                  rooms:
                    - adultsCount: 2
                      childrenCount: 0
                      bedType: "king"
                    - adultsCount: 1
                      childrenCount: 1
                      bedType: "queen"
                  subtotal: 800.00
                  taxAmount: 80.00
                  discountAmount: 0.00
                  totalAmount: 880.00
                  currency: "USD"
                  paymentMethod:
                    type: "credit_card"
                    provider: "stripe"
                    token: "tok_visa"
              flightBooking:
                summary: Flight booking example
                value:
                  bookingType: "flight"
                  flightId: 98765
                  departureDate: "2026-04-10"
                  passengers:
                    - firstName: "Jane"
                      lastName: "Doe"
                      seatClass: "economy"
                  totalAmount: 450.00
                  currency: "USD"
                  paymentMethod:
                    type: "credit_card"
                    provider: "stripe"
                    token: "tok_visa"
      responses:
        '201':
          description: Booking created successfully
          headers:
            X-Request-Id:
              description: Correlation ID for tracing this request
              schema:
                type: string
            X-RateLimit-Remaining:
              description: Number of requests remaining in current window
              schema:
                type: integer
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BookingResponse'
              example:
                success: true
                data:
                  bookingId: 9876543210
                  referenceCode: "HT-20260215-000042"
                  status: "confirmed"
                  totalAmount: 880.00
                  currency: "USD"
                  createdAt: "2026-02-15T10:30:00Z"
                  expiresAt: "2026-02-15T11:00:00Z"
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '402':
          $ref: '#/components/responses/PaymentRequired'
        '409':
          $ref: '#/components/responses/Conflict'
        '429':
          $ref: '#/components/responses/RateLimitExceeded'
        '500':
          $ref: '#/components/responses/InternalError'

    get:
      tags:
        - Bookings
      summary: List bookings for the authenticated user
      description: |
        Retrieves a paginated list of bookings belonging to the
        authenticated user. Supports filtering by status, date
        range, and booking type.

        **Required permissions:** `bookings:read`
      operationId: listBookings
      parameters:
        - name: status
          in: query
          required: false
          description: Filter by booking status
          schema:
            type: string
            enum: [confirmed, pending, cancelled, completed]
        - name: bookingType
          in: query
          required: false
          schema:
            type: string
            enum: [hotel, flight, car_rental]
        - name: fromDate
          in: query
          required: false
          description: Filter bookings created on or after this date
          schema:
            type: string
            format: date
        - name: toDate
          in: query
          required: false
          description: Filter bookings created on or before this date
          schema:
            type: string
            format: date
        - name: page
          in: query
          required: false
          schema:
            type: integer
            minimum: 1
            default: 1
        - name: limit
          in: query
          required: false
          schema:
            type: integer
            minimum: 1
            maximum: 100
            default: 20
        - name: sortBy
          in: query
          required: false
          schema:
            type: string
            enum: [createdAt, checkIn, totalAmount]
            default: createdAt
        - name: sortOrder
          in: query
          required: false
          schema:
            type: string
            enum: [asc, desc]
            default: desc
      responses:
        '200':
          description: List of bookings
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BookingListResponse'
        '401':
          $ref: '#/components/responses/Unauthorized'

  /api/v1/bookings/{bookingId}:
    get:
      tags:
        - Bookings
      summary: Retrieve a single booking by ID
      operationId: getBooking
      parameters:
        - name: bookingId
          in: path
          required: true
          schema:
            type: integer
            format: int64
      responses:
        '200':
          description: Booking details
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BookingResponse'
        '404':
          $ref: '#/components/responses/NotFound'

  /api/v1/bookings/{bookingId}/cancel:
    post:
      tags:
        - Bookings
      summary: Cancel an existing booking
      description: |
        Cancels a confirmed booking and triggers compensating
        transactions: payment refund, inventory release, and
        notification emails. This is a POST rather than DELETE
        because cancellation is a business operation with side
        effects, not a simple resource deletion.

        **Required permissions:** `bookings:cancel`
      operationId: cancelBooking
      parameters:
        - name: bookingId
          in: path
          required: true
          schema:
            type: integer
            format: int64
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CancelBookingRequest'
      responses:
        '200':
          description: Booking cancelled successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CancelBookingResponse'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          description: Booking cannot be cancelled (already completed or checked in)

  /api/v1/inventory/availability:
    get:
      tags:
        - Inventory
      summary: Check resource availability
      description: |
        Checks whether the requested quantity of a resource
        (hotel rooms, flight seats, rental cars) is available
        for the given date range. This is a read-only,
        cacheable endpoint.

        **Caching:** Responses include `Cache-Control` headers.
        Availability data is accurate to within 30 seconds.
      operationId: checkAvailability
      parameters:
        - name: resourceType
          in: query
          required: true
          schema:
            type: string
            enum: [hotel_room, flight_seat, rental_car]
        - name: resourceId
          in: query
          required: true
          schema:
            type: integer
        - name: checkIn
          in: query
          required: true
          schema:
            type: string
            format: date
        - name: checkOut
          in: query
          required: true
          schema:
            type: string
            format: date
        - name: quantity
          in: query
          required: true
          schema:
            type: integer
            minimum: 1
      responses:
        '200':
          description: Availability result
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AvailabilityResponse'

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: |
        JWT token obtained from the /api/v1/auth/login endpoint.
        Include in the Authorization header as: Bearer <token>.
        Tokens expire after 1 hour. Use the refresh token endpoint
        to obtain a new access token without re-authenticating.
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
      description: |
        API key for server-to-server integrations. Issued via the
        developer portal. API keys do not expire but can be
        revoked. Each key is scoped to specific permissions.

  schemas:
    CreateBookingRequest:
      type: object
      required:
        - bookingType
        - totalAmount
        - currency
        - paymentMethod
      properties:
        bookingType:
          type: string
          enum: [hotel, flight, car_rental]
          description: The type of reservation being created
        hotelId:
          type: integer
          description: Required for hotel bookings
        roomTypeId:
          type: integer
          description: Required for hotel bookings
        checkIn:
          type: string
          format: date
          description: Check-in date (YYYY-MM-DD format, UTC)
        checkOut:
          type: string
          format: date
          description: Check-out date (YYYY-MM-DD format, UTC)
        roomsCount:
          type: integer
          minimum: 1
          maximum: 10
        guestsCount:
          type: integer
          minimum: 1
          maximum: 20
        rooms:
          type: array
          items:
            $ref: '#/components/schemas/RoomAllocation'
        subtotal:
          type: number
          format: double
          description: Price before tax and discounts
        taxAmount:
          type: number
          format: double
        discountAmount:
          type: number
          format: double
        totalAmount:
          type: number
          format: double
          description: Final amount to charge (subtotal + tax - discount)
        currency:
          type: string
          pattern: '^[A-Z]{3}$'
          description: ISO 4217 currency code (e.g., USD, EUR, GBP)
        paymentMethod:
          $ref: '#/components/schemas/PaymentMethod'

    RoomAllocation:
      type: object
      properties:
        adultsCount:
          type: integer
          minimum: 1
        childrenCount:
          type: integer
          minimum: 0
        bedType:
          type: string
          enum: [king, queen, double, twin, suite]

    PaymentMethod:
      type: object
      required:
        - type
        - provider
        - token
      properties:
        type:
          type: string
          enum: [credit_card, debit_card, bank_transfer, wallet]
        provider:
          type: string
          enum: [stripe, adyen, paypal]
        token:
          type: string
          description: |
            Tokenized payment credential from the provider.
            Never send raw card numbers to this endpoint.

    BookingResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: object
          properties:
            bookingId:
              type: integer
              format: int64
            referenceCode:
              type: string
              description: Human-readable reference for support calls
            status:
              type: string
              enum: [confirmed, pending, cancelled, completed]
            totalAmount:
              type: number
              format: double
            currency:
              type: string
            createdAt:
              type: string
              format: date-time
            expiresAt:
              type: string
              format: date-time
              description: |
                For pending bookings, the deadline to confirm.
                Null for confirmed bookings.

    CancelBookingRequest:
      type: object
      required:
        - reason
      properties:
        reason:
          type: string
          enum:
            - user_cancelled
            - fraud_detected
            - provider_cancelled
            - duplicate_booking
            - force_majeure
          description: Machine-readable cancellation reason for policy engine
        reasonNotes:
          type: string
          maxLength: 500
          description: Free-text explanation (optional, for audit trail)

    CancelBookingResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: object
          properties:
            bookingId:
              type: integer
              format: int64
            status:
              type: string
              example: "cancelled"
            refundAmount:
              type: number
              format: double
            refundStatus:
              type: string
              enum: [processed, pending, denied]
            cancellationPolicy:
              type: string
              description: Which policy was applied (e.g., "full_refund", "50_percent")

    BookingListResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: array
          items:
            $ref: '#/components/schemas/BookingResponse'
        pagination:
          $ref: '#/components/schemas/Pagination'

    Pagination:
      type: object
      properties:
        currentPage:
          type: integer
        totalPages:
          type: integer
        totalItems:
          type: integer
        itemsPerPage:
          type: integer

    AvailabilityResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: object
          properties:
            available:
              type: boolean
            resourceType:
              type: string
            resourceId:
              type: integer
            requestedQuantity:
              type: integer
            availableQuantity:
              type: integer
            pricePerUnit:
              type: number
              format: double
            currency:
              type: string
            validUntil:
              type: string
              format: date-time
              description: |
                This availability quote is guaranteed until this
                timestamp. After this time, re-check availability.

    ErrorResponse:
      type: object
      required:
        - success
        - error
      properties:
        success:
          type: boolean
          example: false
        error:
          type: object
          required:
            - code
            - message
          properties:
            code:
              type: string
              description: Machine-readable error code
              example: "INSUFFICIENT_INVENTORY"
            message:
              type: string
              description: Human-readable error description
              example: "Requested room type is not available for the selected dates"
            details:
              type: array
              items:
                type: object
                properties:
                  field:
                    type: string
                  reason:
                    type: string
              description: Field-level validation errors (for 400 responses)
            traceId:
              type: string
              description: Distributed tracing ID for debugging with support

  responses:
    BadRequest:
      description: Request body failed validation
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "INVALID_REQUEST"
              message: "Request validation failed"
              details:
                - field: "checkOut"
                  reason: "checkOut must be after checkIn"
                - field: "totalAmount"
                  reason: "totalAmount must be a positive number"
              traceId: "abc-123-def-456"

    Unauthorized:
      description: Missing or invalid authentication token
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "UNAUTHORIZED"
              message: "Authentication token is missing or expired"
              traceId: "abc-123-def-456"

    PaymentRequired:
      description: Payment provider declined the transaction
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "PAYMENT_DECLINED"
              message: "The payment method was declined by the provider"
              traceId: "abc-123-def-456"

    NotFound:
      description: Requested resource does not exist
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "BOOKING_NOT_FOUND"
              message: "No booking found with the specified ID"
              traceId: "abc-123-def-456"

    Conflict:
      description: Resource conflict (e.g., insufficient inventory)
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "INSUFFICIENT_INVENTORY"
              message: "Requested quantity exceeds available inventory"
              traceId: "abc-123-def-456"

    RateLimitExceeded:
      description: Too many requests
      headers:
        Retry-After:
          description: Seconds to wait before retrying
          schema:
            type: integer
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "RATE_LIMIT_EXCEEDED"
              message: "Rate limit exceeded. Retry after 30 seconds."
              traceId: "abc-123-def-456"

    InternalError:
      description: Unexpected server error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
          example:
            success: false
            error:
              code: "INTERNAL_ERROR"
              message: "An unexpected error occurred. Contact support with the traceId."
              traceId: "abc-123-def-456"
```

That is a large spec, and it is meant to be. Let us break down the key structural decisions.

**The `info` section** is not just metadata — it contains the rate limits and environment URLs that every consumer needs on day one. Burying this information in a separate wiki page guarantees that half your consumers will hit production endpoints during testing.

**The `tags` grouping** organizes endpoints by business domain, not by HTTP method. A developer looking for "how do I cancel a booking" navigates to the "Bookings" tag, not to "POST endpoints."

**The `components/schemas` section** defines reusable data models. The `CreateBookingRequest` schema is referenced by the endpoint definition, and it is also used by validation middleware and SDK generators. Define once, use everywhere.

**The `components/responses` section** standardizes error responses. Every `401` across the entire API returns the same shape — the `ErrorResponse` schema with a machine-readable `code`, a human-readable `message`, and a `traceId` for debugging.

> **Checkpoint:** Open the YAML spec above and trace the `$ref` links. When the `POST /api/v1/bookings` endpoint references `$ref: '#/components/schemas/CreateBookingRequest'`, can you find where that schema is defined? Can you identify all the fields that are marked `required`? This ability to navigate a spec is essential for debugging documentation issues.

---

## NestJS Swagger Integration: Code-First Documentation

In our Global Booking System, we use NestJS, which provides first-class support for generating OpenAPI specifications directly from your code using decorators. This is the code-first approach — your TypeScript code is the single source of truth, and the documentation is generated from it.

> **Key Term:** **Code-First Documentation** — An approach where the API specification is generated from source code annotations (decorators, attributes, docstrings) rather than maintained as a separate YAML/JSON file. The code is the source of truth, and the spec is a build artifact.

### Setting Up @nestjs/swagger

First, install the package and configure it in your application bootstrap:

```typescript
// main.ts — Application bootstrap with Swagger setup
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation pipe ensures DTOs are validated
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('Global Booking Platform API')
    .setDescription(`
      Enterprise booking platform supporting hotel, flight, and car rental
      reservations at 100K bookings/minute throughput.

      ## Authentication
      All endpoints require either a Bearer JWT token or an API key.

      ## Rate Limits
      - Standard: 100 req/min
      - Premium: 1,000 req/min
      - Enterprise: 10,000 req/min
    `)
    .setVersion('1.0.0')
    .setContact(
      'Platform Engineering Team',
      'https://globalbooking.com/docs',
      'platform-api@globalbooking.com',
    )
    .addServer('https://api.globalbooking.com', 'Production')
    .addServer('https://staging-api.globalbooking.com', 'Staging')
    .addServer('https://sandbox-api.globalbooking.com', 'Sandbox')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Enter your JWT token from /api/v1/auth/login',
      },
      'bearer-auth', // This name is referenced in @ApiBearerAuth()
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for server-to-server integrations',
      },
      'api-key', // This name is referenced in @ApiSecurity()
    )
    .addTag('Bookings', 'Create, retrieve, modify, and cancel bookings')
    .addTag('Inventory', 'Check availability and manage inventory')
    .addTag('Payments', 'Process payments and refunds')
    .addTag('Auth', 'Authentication and token management')
    .addTag('Webhooks', 'Webhook subscription management')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Serve Swagger UI at /docs
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true, // Keeps the token between page reloads
      tagsSorter: 'alpha',
      operationsSorter: 'method',
      docExpansion: 'list',
      filter: true,
      showRequestDuration: true,
    },
    customSiteTitle: 'Global Booking API Docs',
    customfavIcon: '/favicon.ico',
    customCss: '.swagger-ui .topbar { display: none }',
  });

  await app.listen(3000);
}
bootstrap();
```

### Decorating Controllers

Now let us see how the decorators transform a plain NestJS controller into self-documenting code. Every decorator you add becomes part of the generated OpenAPI spec:

```typescript
// bookings.controller.ts
import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { BookingResponseDto } from './dto/booking-response.dto';
import { ErrorResponseDto } from '../common/dto/error-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { BookingsService } from './bookings.service';

@ApiTags('Bookings')
@ApiBearerAuth('bearer-auth')
@UseGuards(JwtAuthGuard)
@Controller('api/v1/bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new booking',
    description: `
      Creates a new hotel, flight, or car rental booking. This endpoint
      is idempotent when an Idempotency-Key header is provided.

      **Required permissions:** \`bookings:create\`

      **Throughput:** Handles up to 100K requests/minute across all consumers.

      **Idempotency:** If a request with the same Idempotency-Key has already
      been processed, the original response is returned without creating
      a duplicate booking. Keys expire after 24 hours.
    `,
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique UUID to ensure idempotent processing',
    schema: { type: 'string', format: 'uuid' },
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiHeader({
    name: 'X-Request-Id',
    required: false,
    description: 'Optional correlation ID for distributed tracing',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiBody({
    type: CreateBookingDto,
    description: 'Booking details including room allocation and payment',
    examples: {
      hotelBooking: {
        summary: 'Standard hotel booking',
        value: {
          bookingType: 'hotel',
          hotelId: 12345,
          roomTypeId: 678,
          checkIn: '2026-03-15',
          checkOut: '2026-03-20',
          roomsCount: 2,
          guestsCount: 4,
          rooms: [
            { adultsCount: 2, childrenCount: 0, bedType: 'king' },
            { adultsCount: 1, childrenCount: 1, bedType: 'queen' },
          ],
          subtotal: 800.0,
          taxAmount: 80.0,
          discountAmount: 0.0,
          totalAmount: 880.0,
          currency: 'USD',
          paymentMethod: {
            type: 'credit_card',
            provider: 'stripe',
            token: 'tok_visa',
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Booking created successfully',
    type: BookingResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Request body failed validation',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid authentication token',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 402,
    description: 'Payment provider declined the transaction',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'Insufficient inventory for the requested dates',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded',
    type: ErrorResponseDto,
  })
  async createBooking(
    @Headers('Idempotency-Key') idempotencyKey: string,
    @Body() createBookingDto: CreateBookingDto,
  ): Promise<BookingResponseDto> {
    return this.bookingsService.create(createBookingDto, idempotencyKey);
  }

  @Get()
  @ApiOperation({
    summary: 'List bookings for the authenticated user',
    description: `
      Retrieves a paginated list of bookings belonging to the
      authenticated user. Supports filtering by status, date
      range, and booking type.

      **Required permissions:** \`bookings:read\`
    `,
  })
  @ApiQuery({ name: 'status', required: false, enum: ['confirmed', 'pending', 'cancelled', 'completed'] })
  @ApiQuery({ name: 'bookingType', required: false, enum: ['hotel', 'flight', 'car_rental'] })
  @ApiQuery({ name: 'fromDate', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'toDate', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 20, max: 100)' })
  @ApiResponse({ status: 200, description: 'Paginated list of bookings' })
  @ApiResponse({ status: 401, description: 'Unauthorized', type: ErrorResponseDto })
  async listBookings(@Query() query: PaginationQueryDto) {
    return this.bookingsService.findAll(query);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: 'Retrieve a single booking by ID' })
  @ApiParam({
    name: 'bookingId',
    type: Number,
    description: 'The unique numeric booking identifier',
    example: 9876543210,
  })
  @ApiResponse({ status: 200, description: 'Booking details', type: BookingResponseDto })
  @ApiResponse({ status: 404, description: 'Booking not found', type: ErrorResponseDto })
  async getBooking(@Param('bookingId') bookingId: number): Promise<BookingResponseDto> {
    return this.bookingsService.findOne(bookingId);
  }

  @Post(':bookingId/cancel')
  @ApiOperation({
    summary: 'Cancel an existing booking',
    description: `
      Cancels a confirmed booking and triggers compensating transactions:
      payment refund, inventory release, and notification emails.

      **Why POST instead of DELETE?** Cancellation is a business operation
      with side effects (refund, inventory release, email), not a simple
      resource deletion.

      **Required permissions:** \`bookings:cancel\`
    `,
  })
  @ApiParam({ name: 'bookingId', type: Number })
  @ApiResponse({ status: 200, description: 'Booking cancelled and refund initiated' })
  @ApiResponse({ status: 404, description: 'Booking not found', type: ErrorResponseDto })
  @ApiResponse({ status: 409, description: 'Booking cannot be cancelled (already completed)' })
  async cancelBooking(
    @Param('bookingId') bookingId: number,
    @Body() cancelBookingDto: CancelBookingDto,
  ) {
    return this.bookingsService.cancel(bookingId, cancelBookingDto);
  }
}
```

### The DTO Layer: Where Schema Meets Validation

The DTOs (Data Transfer Objects) serve double duty — they validate incoming data at runtime and generate the schema in the OpenAPI spec. Every `@ApiProperty()` decorator becomes a field in the generated schema:

```typescript
// dto/create-booking.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsDateString,
  IsNumber,
  IsString,
  IsArray,
  IsOptional,
  Min,
  Max,
  Matches,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RoomAllocationDto {
  @ApiProperty({
    description: 'Number of adult guests in this room',
    minimum: 1,
    example: 2,
  })
  @IsInt()
  @Min(1)
  adultsCount: number;

  @ApiProperty({
    description: 'Number of children in this room',
    minimum: 0,
    example: 0,
  })
  @IsInt()
  @Min(0)
  childrenCount: number;

  @ApiProperty({
    description: 'Preferred bed configuration',
    enum: ['king', 'queen', 'double', 'twin', 'suite'],
    example: 'king',
  })
  @IsEnum(['king', 'queen', 'double', 'twin', 'suite'])
  bedType: string;
}

export class PaymentMethodDto {
  @ApiProperty({
    description: 'Payment instrument type',
    enum: ['credit_card', 'debit_card', 'bank_transfer', 'wallet'],
    example: 'credit_card',
  })
  @IsEnum(['credit_card', 'debit_card', 'bank_transfer', 'wallet'])
  type: string;

  @ApiProperty({
    description: 'Payment processor',
    enum: ['stripe', 'adyen', 'paypal'],
    example: 'stripe',
  })
  @IsEnum(['stripe', 'adyen', 'paypal'])
  provider: string;

  @ApiProperty({
    description: 'Tokenized payment credential from the provider. NEVER send raw card numbers.',
    example: 'tok_visa',
  })
  @IsString()
  token: string;
}

export class CreateBookingDto {
  @ApiProperty({
    description: 'The type of reservation being created',
    enum: ['hotel', 'flight', 'car_rental'],
    example: 'hotel',
  })
  @IsEnum(['hotel', 'flight', 'car_rental'])
  bookingType: string;

  @ApiPropertyOptional({
    description: 'Hotel identifier (required for hotel bookings)',
    example: 12345,
  })
  @IsOptional()
  @IsInt()
  hotelId?: number;

  @ApiPropertyOptional({
    description: 'Room type identifier (required for hotel bookings)',
    example: 678,
  })
  @IsOptional()
  @IsInt()
  roomTypeId?: number;

  @ApiProperty({
    description: 'Check-in date in YYYY-MM-DD format (UTC)',
    example: '2026-03-15',
  })
  @IsDateString()
  checkIn: string;

  @ApiProperty({
    description: 'Check-out date in YYYY-MM-DD format (UTC)',
    example: '2026-03-20',
  })
  @IsDateString()
  checkOut: string;

  @ApiPropertyOptional({
    description: 'Number of rooms to reserve',
    minimum: 1,
    maximum: 10,
    example: 2,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  roomsCount?: number;

  @ApiPropertyOptional({
    description: 'Total number of guests across all rooms',
    minimum: 1,
    maximum: 20,
    example: 4,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  guestsCount?: number;

  @ApiPropertyOptional({
    description: 'Per-room guest allocation and bed preferences',
    type: [RoomAllocationDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RoomAllocationDto)
  rooms?: RoomAllocationDto[];

  @ApiPropertyOptional({ description: 'Price before tax and discounts', example: 800.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  subtotal?: number;

  @ApiPropertyOptional({ description: 'Tax amount', example: 80.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @ApiPropertyOptional({ description: 'Discount amount', example: 0.0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @ApiProperty({
    description: 'Final amount to charge (subtotal + tax - discount)',
    example: 880.0,
  })
  @IsNumber()
  @Min(0.01)
  totalAmount: number;

  @ApiProperty({
    description: 'ISO 4217 currency code',
    example: 'USD',
    pattern: '^[A-Z]{3}$',
  })
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ApiProperty({
    description: 'Payment details (tokenized — never raw card numbers)',
    type: PaymentMethodDto,
  })
  @ValidateNested()
  @Type(() => PaymentMethodDto)
  paymentMethod: PaymentMethodDto;
}
```

Notice how each field has both validation decorators (`@IsInt()`, `@Min()`) and documentation decorators (`@ApiProperty()`). When a consumer sends an invalid request, the validation pipe rejects it with a clear error message. When a consumer reads the docs, the `@ApiProperty()` descriptions and examples tell them exactly what to send.

> **Analogy:** Think of DTOs as the contract stamped at both ends. On the way in, they validate. On the way out (to Swagger UI), they document. A single class serves both purposes. If you change a field, both the validation and the documentation update together. This is the core advantage of code-first documentation — there is no separate document to forget about.

---

## Authentication Documentation: Bearer Tokens and API Keys

Authentication is the number one source of integration friction. If a developer cannot authenticate within five minutes of reading your docs, they will move on to a competitor's API or escalate to your team lead. Your authentication documentation must be painfully explicit.

### Bearer Token (JWT) Authentication

Our system uses JWT tokens for user-facing authentication (web app, mobile app). Here is exactly what the documentation should show:

**Step 1: Obtain a token**

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "developer@example.com",
  "password": "your-password"
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOjQyLCJlbWFpbCI6ImRldkBleGFtcGxlLmNvbSIsInJvbGUiOiJ1c2VyIiwiaWF0IjoxNzA4MDAwMDAwLCJleHAiOjE3MDgwMDM2MDB9.signature",
    "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
    "expiresIn": 3600,
    "tokenType": "Bearer"
  }
}
```

**Step 2: Use the token in subsequent requests**

```http
GET /api/v1/bookings
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Step 3: Refresh when expired**

```http
POST /api/v1/auth/refresh
Content-Type: application/json

{
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4..."
}
```

**Critical details that must be documented:**

- **Token lifetime:** Access tokens expire after 1 hour (3600 seconds). The frontend must implement a refresh flow.
- **Clock skew tolerance:** The server accepts tokens up to 30 seconds past expiration to account for clock differences.
- **Token format:** RS256-signed JWT. The public key for validation is available at `/.well-known/jwks.json`.
- **Revocation:** Logging out invalidates all refresh tokens for that user. Access tokens remain valid until expiration (this is a stateless JWT trade-off — document it so consumers understand).

### API Key Authentication

For server-to-server integrations (partner hotel chains, analytics pipelines), we use API keys instead of JWTs:

```http
GET /api/v1/bookings?status=confirmed
X-API-Key: gbp_live_sk_a1b2c3d4e5f6g7h8i9j0
```

**API key documentation must include:**

| Property | Value |
|---|---|
| Header name | `X-API-Key` |
| Key format | `gbp_{environment}_sk_{32 hex chars}` |
| Environments | `live` (production), `test` (sandbox) |
| Expiration | Keys do not expire but can be revoked |
| Rate limit | Determined by your subscription tier |
| Permissions | Scoped to specific endpoints at key creation |
| Rotation | Generate a new key, update your integration, then revoke the old key |

**Test keys vs. live keys:**

```
gbp_test_sk_a1b2c3d4e5f6g7h8i9j0   ← Sandbox only, no real charges
gbp_live_sk_x9y8z7w6v5u4t3s2r1q0   ← Production, real bookings and charges
```

> **Common Mistake:** Documenting authentication with a sentence like "Include your token in the Authorization header." That is technically correct but practically useless. Show the full HTTP request. Show the exact header format. Show what a 401 response looks like. Show how to refresh. Show what happens when the token expires. The developer reading your docs at 2 AM needs a recipe, not a hint.

---

## Error Response Documentation: A Standard Format Across All Services

In a microservices architecture with 15+ services, error consistency is not optional — it is structural. If the Booking Service returns `{ "error": "not found" }`, the Payment Service returns `{ "message": "Not Found", "statusCode": 404 }`, and the Inventory Service returns `{ "err": { "msg": "404" } }`, the frontend team has to write three different error parsers. That is absurd. Every service must return errors in the same shape.

### The Standard Error Envelope

Here is the error format we enforce across every microservice in the Global Booking System:

```typescript
// common/dto/error-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ValidationErrorDetail {
  @ApiProperty({
    description: 'The field that failed validation',
    example: 'checkOut',
  })
  field: string;

  @ApiProperty({
    description: 'Why the field failed validation',
    example: 'checkOut must be after checkIn',
  })
  reason: string;
}

export class ErrorBody {
  @ApiProperty({
    description: 'Machine-readable error code (use this for programmatic handling)',
    example: 'INSUFFICIENT_INVENTORY',
    enum: [
      'INVALID_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'BOOKING_NOT_FOUND',
      'INSUFFICIENT_INVENTORY',
      'PAYMENT_DECLINED',
      'FRAUD_BLOCKED',
      'RATE_LIMIT_EXCEEDED',
      'DUPLICATE_BOOKING',
      'BOOKING_EXPIRED',
      'CANCELLATION_WINDOW_CLOSED',
      'PROVIDER_UNAVAILABLE',
      'INTERNAL_ERROR',
    ],
  })
  code: string;

  @ApiProperty({
    description: 'Human-readable error message (display this to users or log it)',
    example: 'Requested room type is not available for the selected dates',
  })
  message: string;

  @ApiPropertyOptional({
    description: 'Field-level validation errors (only present for 400 responses)',
    type: [ValidationErrorDetail],
  })
  details?: ValidationErrorDetail[];

  @ApiProperty({
    description: 'Distributed tracing ID — include this when contacting support',
    example: 'trace-abc-123-def-456',
  })
  traceId: string;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ type: ErrorBody })
  error: ErrorBody;
}
```

### The Complete Error Codes Table

Every error code must be documented with enough context for the consumer to handle it without contacting your team:

| Error Code | HTTP Status | When It Occurs | Consumer Action |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | Request body or query params fail validation | Read the `details` array. Fix the flagged fields and retry. |
| `UNAUTHORIZED` | 401 | No token, expired token, or malformed token | Re-authenticate via `/api/v1/auth/login`. If using API key, verify it is not revoked. |
| `FORBIDDEN` | 403 | Valid token but insufficient permissions | The user/key does not have the required scope. Contact your admin. |
| `BOOKING_NOT_FOUND` | 404 | No booking exists with the given ID | Verify the ID. Check if the booking was created in a different environment (sandbox vs. production). |
| `INSUFFICIENT_INVENTORY` | 409 | Requested quantity exceeds what is available | Show "sold out" or suggest alternative dates. Do NOT retry — inventory will not magically appear. |
| `PAYMENT_DECLINED` | 402 | The payment provider rejected the charge | Ask the user to try a different payment method. Do NOT retry with the same card. |
| `FRAUD_BLOCKED` | 403 | Fraud detection blocked this transaction | Show a generic "unable to process" message. NEVER reveal fraud detection details to the user. |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests in the current window | Read the `Retry-After` header. Implement exponential backoff. Do NOT retry immediately. |
| `DUPLICATE_BOOKING` | 409 | A booking with the same Idempotency-Key already exists | The original booking was already created. Fetch it with `GET /api/v1/bookings/{id}`. |
| `BOOKING_EXPIRED` | 410 | A pending booking was not confirmed before its deadline | Create a new booking from scratch. The inventory has been released. |
| `CANCELLATION_WINDOW_CLOSED` | 409 | The cancellation deadline has passed | The booking cannot be cancelled via API. Escalate to customer support. |
| `PROVIDER_UNAVAILABLE` | 503 | A downstream provider (hotel chain, payment gateway) is unreachable | Retry with exponential backoff. Check the status page for outage updates. |
| `INTERNAL_ERROR` | 500 | An unexpected server error | Include the `traceId` when contacting support. This is a bug on our side. |

### Error Response Examples

**Validation Error (400):**

```json
{
  "success": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request validation failed",
    "details": [
      {
        "field": "checkOut",
        "reason": "checkOut must be after checkIn"
      },
      {
        "field": "rooms[1].adultsCount",
        "reason": "adultsCount must be at least 1"
      },
      {
        "field": "currency",
        "reason": "currency must match pattern ^[A-Z]{3}$"
      }
    ],
    "traceId": "trace-7f8a9b0c-1d2e-3f4g-5h6i-7j8k9l0m1n2o"
  }
}
```

**Inventory Conflict (409):**

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_INVENTORY",
    "message": "Only 1 king room available for March 15-20, but 2 were requested",
    "traceId": "trace-a1b2c3d4-e5f6-7g8h-9i0j-k1l2m3n4o5p6"
  }
}
```

**Rate Limit (429):**

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded. You have used 100/100 requests in the current 60-second window.",
    "traceId": "trace-q7r8s9t0-u1v2-w3x4-y5z6-a7b8c9d0e1f2"
  }
}
```

Notice that every error includes a `traceId`. This is the distributed tracing correlation ID from OpenTelemetry (which we configured in Chapter 38). When a partner developer contacts support and says "I got error trace-a1b2c3d4...," your support team can search the tracing system and see exactly which microservice failed and why — without asking the developer to reproduce the issue.

> **What If You Skip This?** Without standardized errors, debugging partner integrations becomes a nightmare. The partner says "I got a 500 error." You ask "Which service?" They say "I do not know." You ask "What was the response body?" They say "It was empty" or "It said 'Internal Server Error'" — a message so generic it tells you nothing. A standardized `traceId` in every error response turns a 2-hour debugging session into a 2-minute log search.

---

## Versioning Documentation: How to Document API Versions

API versioning is not just a routing strategy — it is a communication contract. When you release v2 of an endpoint, every consumer of v1 needs to know three things: (1) what changed, (2) when v1 will be deprecated, and (3) how to migrate.

### URL-Based Versioning (Our Approach)

We use URL path versioning because it is the most visible and least error-prone approach:

```
/api/v1/bookings    ← Current stable version
/api/v2/bookings    ← New version with breaking changes
```

In NestJS, this is configured at the application level:

```typescript
// main.ts — API versioning setup
import { VersioningType } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableVersioning({
    type: VersioningType.URI,
    prefix: 'api/v',
    defaultVersion: '1',
  });

  // ... rest of bootstrap
}
```

And at the controller level:

```typescript
// bookings-v2.controller.ts
import { Controller, Version } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Bookings v2')
@Controller('bookings')
@Version('2')
export class BookingsV2Controller {
  // v2 endpoints that change the rooms → roomAllocations field
}
```

### Version Lifecycle Documentation

Every API version must document its lifecycle stage clearly:

| Version | Status | Released | Deprecated | Sunset | Notes |
|---|---|---|---|---|---|
| v1 | **Stable** | 2025-01-15 | 2026-06-01 (planned) | 2027-01-01 (planned) | Current recommended version |
| v2 | **Beta** | 2026-02-01 | — | — | `rooms` renamed to `roomAllocations`; new `loyaltyPoints` field |

> **Key Term:** **API Sunset** — The date after which an API version is no longer available. After sunset, requests to that version return `410 Gone`. This is different from deprecation (which means "still works but stop using it"). Sunset means "it is gone."

### Version Headers in Responses

Every response should include version metadata so consumers can verify they are hitting the right version and plan migrations:

```http
HTTP/1.1 200 OK
X-API-Version: 1
X-API-Deprecated: true
X-API-Sunset-Date: 2027-01-01
Link: <https://api.globalbooking.com/api/v2/bookings>; rel="successor-version"
```

Document these headers so consumers can build automated migration warnings:

```typescript
// Example: a consumer's middleware that warns about deprecated APIs
function checkDeprecation(response: AxiosResponse) {
  if (response.headers['x-api-deprecated'] === 'true') {
    const sunsetDate = response.headers['x-api-sunset-date'];
    console.warn(
      `WARNING: API v${response.headers['x-api-version']} is deprecated. ` +
      `It will be removed on ${sunsetDate}. ` +
      `Migrate to the version at: ${response.headers['link']}`
    );
  }
  return response;
}
```

### Multi-Version OpenAPI Specs

When you maintain multiple API versions, generate separate OpenAPI specs for each:

```typescript
// main.ts — Multiple Swagger documents for multiple versions
const v1Config = new DocumentBuilder()
  .setTitle('Global Booking Platform API')
  .setVersion('1.0.0')
  .setDescription('Stable version. Deprecated on 2026-06-01.')
  .build();

const v2Config = new DocumentBuilder()
  .setTitle('Global Booking Platform API')
  .setVersion('2.0.0-beta')
  .setDescription('Beta version. Breaking changes from v1 documented below.')
  .build();

const v1Document = SwaggerModule.createDocument(app, v1Config, {
  include: [BookingsV1Module, InventoryV1Module, PaymentsV1Module],
});

const v2Document = SwaggerModule.createDocument(app, v2Config, {
  include: [BookingsV2Module, InventoryV1Module, PaymentsV1Module],
});

SwaggerModule.setup('docs/v1', app, v1Document);
SwaggerModule.setup('docs/v2', app, v2Document);
```

Now consumers can visit `/docs/v1` for the current stable documentation and `/docs/v2` for the beta documentation. Each spec only includes the modules relevant to that version.

> **Checkpoint:** Can you explain the difference between "deprecated" and "sunset" for an API version? If a consumer sees the `X-API-Deprecated: true` header, what should they do? If they see a `410 Gone` response, what has happened?

---

## Code-First vs. Spec-First API Documentation

There are two philosophical approaches to API documentation, and you will encounter strong opinions about both. Let us examine each honestly.

### Code-First: Write Code, Generate Spec

This is what we have been demonstrating with NestJS and `@nestjs/swagger`. You write your controllers and DTOs, add decorators, and the OpenAPI spec is generated automatically.

**How it works in practice:**

```
Developer writes TypeScript code
    ↓
@ApiProperty, @ApiOperation decorators added to code
    ↓
NestJS Swagger plugin generates openapi.json at build time
    ↓
Swagger UI renders the spec as interactive docs
    ↓
SDK generators consume the spec to produce client libraries
```

**Advantages:**

- **Single source of truth.** The code IS the documentation. If you change a field type from `string` to `number`, the spec updates automatically. Documentation drift is impossible.
- **Lower overhead.** Developers do not maintain a separate YAML file. The decorators live right next to the business logic.
- **Compile-time safety.** If a DTO field is removed but an `@ApiProperty` still references it, TypeScript catches the inconsistency.
- **Natural workflow.** Developers write code first anyway. Adding decorators is an incremental cost, not a separate workflow.

**Disadvantages:**

- **Design happens in code.** You start implementing before the API design is reviewed. By the time someone notices a poorly named field, it is already in the codebase.
- **Framework coupling.** Your documentation is tied to NestJS decorators. Migrating to a different framework means rewriting all documentation annotations.
- **Less readable for non-developers.** Product managers and partner integration managers cannot review a TypeScript file as easily as a YAML spec.

### Spec-First: Write Spec, Generate Code

In this approach, you write the OpenAPI specification first (in YAML or JSON), review and approve it, and then generate server stubs and client code from it.

**How it works in practice:**

```
API design team writes OpenAPI YAML spec
    ↓
Spec is reviewed in a pull request (like code review for API design)
    ↓
Code generators produce server stubs (NestJS controllers, DTOs)
    ↓
Developers fill in business logic inside the generated stubs
    ↓
CI/CD validates that the implementation matches the spec
```

**Advantages:**

- **Design review before implementation.** The team agrees on the API shape before anyone writes a line of business logic. This catches naming issues, missing fields, and inconsistencies early.
- **Language-agnostic.** The spec is not tied to any framework or language. A Python team and a TypeScript team can review the same YAML file.
- **Consumer-driven.** You design the API from the consumer's perspective ("what does the frontend need?") rather than the producer's perspective ("what is easy to implement?").
- **Contract testing.** The spec becomes a contract that CI/CD enforces. If the implementation diverges from the spec, the build fails.

**Disadvantages:**

- **Maintenance burden.** You must keep the spec and code in sync manually (or with tooling). If a developer adds a field to the code but forgets to update the spec, they diverge.
- **Generated code is often ugly.** Code generators produce verbose, unidiomatic code that experienced developers find frustrating to work with.
- **Workflow friction.** Developers have to switch between YAML editing and TypeScript coding. The context switch slows them down.

### Our Recommendation: Code-First with Guardrails

For the Global Booking System, we use **code-first with guardrails**:

1. **Code-first for development speed.** Decorators in NestJS make it natural to document as you code.
2. **Generated spec as a build artifact.** The CI pipeline generates the OpenAPI spec from code and commits it to the repository.
3. **Spec diffing in pull requests.** Every PR that changes an API endpoint includes the OpenAPI spec diff. Reviewers can see exactly how the API surface changed.
4. **Breaking change detection.** A CI check compares the new spec against the previous version and flags breaking changes (removed fields, changed types, new required parameters).

```yaml
# .github/workflows/api-spec.yml
name: API Spec Validation
on: [pull_request]

jobs:
  validate-spec:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate OpenAPI spec from code
        run: npm run generate:openapi

      - name: Detect breaking changes
        uses: oasdiff/oasdiff-action@v1
        with:
          base: main
          revision: HEAD
          fail-on: ERR   # Fail on breaking changes
          format: text

      - name: Upload spec artifact
        uses: actions/upload-artifact@v4
        with:
          name: openapi-spec
          path: ./openapi.json
```

This gives you the productivity of code-first with the safety of spec-first. The spec is always generated from code (no drift), but breaking changes are caught before they merge.

> **Analogy:** Code-first with guardrails is like writing a novel (code) and having an editor automatically generate a table of contents (spec). You do not write the table of contents by hand — it is derived from the chapters you wrote. But a reviewer compares the new table of contents with the old one to catch any chapters that were removed or renamed without warning.

---

## Interactive API Explorer: Swagger UI and Redoc Configuration

A static documentation page is useful. An interactive API explorer where developers can make real requests is transformative. It reduces the Time to First Successful API Call from hours to minutes.

### Swagger UI: The Industry Standard

We already configured Swagger UI in the NestJS bootstrap section. Let us look at the advanced configuration options that make it production-ready:

```typescript
// main.ts — Production-grade Swagger UI configuration
SwaggerModule.setup('docs', app, document, {
  swaggerOptions: {
    // Authentication persistence — keeps the JWT between page reloads
    persistAuthorization: true,

    // Sort tags alphabetically for consistent navigation
    tagsSorter: 'alpha',

    // Sort operations by HTTP method within each tag
    // GET → POST → PUT → PATCH → DELETE
    operationsSorter: 'method',

    // Start with operations collapsed (list view)
    // Options: 'list' | 'full' | 'none'
    docExpansion: 'list',

    // Enable the filter/search box in the top bar
    filter: true,

    // Show how long each request took (useful for perf debugging)
    showRequestDuration: true,

    // Deep linking — each operation gets a unique URL fragment
    // Allows sharing links like /docs#/Bookings/createBooking
    deepLinking: true,

    // Display the request URL after execution
    displayRequestDuration: true,

    // Default models expansion depth (how deep to show nested objects)
    defaultModelsExpandDepth: 3,

    // Show the "Try it out" button by default
    tryItOutEnabled: true,
  },

  // Custom branding
  customSiteTitle: 'Global Booking API — Interactive Documentation',
  customfavIcon: '/assets/favicon.ico',

  // Hide the default Swagger top bar (cleaner look)
  customCss: `
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info { margin: 20px 0; }
    .swagger-ui .scheme-container { padding: 15px 0; }
  `,

  // Add custom JavaScript (e.g., analytics tracking)
  customJs: '/assets/docs-analytics.js',
});
```

### Redoc: The Beautiful Alternative

Swagger UI is interactive but can look cluttered for large APIs. Redoc provides a cleaner, three-panel layout that many teams prefer for external-facing documentation:

```typescript
// main.ts — Serving both Swagger UI and Redoc
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as expressBasicAuth from 'express-basic-auth';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Global Booking Platform API')
    .setVersion('1.0.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  // Swagger UI at /docs — interactive, for internal developers
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // Serve the raw OpenAPI JSON spec
  app.use('/docs/openapi.json', (req, res) => {
    res.json(document);
  });

  // Redoc at /redoc — beautiful, for partner developers
  app.use('/redoc', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Global Booking API Reference</title>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet">
          <style>body { margin: 0; padding: 0; }</style>
        </head>
        <body>
          <redoc
            spec-url="/docs/openapi.json"
            theme='{
              "colors": {
                "primary": { "main": "#1a73e8" }
              },
              "typography": {
                "fontSize": "15px",
                "fontFamily": "Roboto, sans-serif",
                "headings": { "fontFamily": "Montserrat, sans-serif" }
              },
              "sidebar": {
                "width": "260px",
                "backgroundColor": "#fafafa"
              },
              "rightPanel": {
                "backgroundColor": "#263238"
              }
            }'
            expand-responses="200,201"
            hide-download-button="false"
            required-props-first="true"
            sort-props-alphabetically="false"
            path-in-middle-panel="true"
            hide-loading="true"
          ></redoc>
          <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>
        </body>
      </html>
    `);
  });

  await app.listen(3000);
}
```

### When to Use Which

| Feature | Swagger UI | Redoc |
|---|---|---|
| **Interactive "Try it out"** | Yes — developers can execute real API calls | No — read-only documentation |
| **Layout** | Single-panel, vertical scroll | Three-panel (nav, content, code samples) |
| **Best for** | Internal developers who need to test quickly | Partner developers who need a reference guide |
| **Performance** | Slower with large specs (100+ endpoints) | Fast even with very large specs |
| **Search** | Basic tag/operation filter | Full-text search across all content |
| **Customization** | Limited styling options | Extensive theming with JSON config |
| **Authentication testing** | Built-in auth forms | Not available (use Postman instead) |

Our recommendation: serve both. Swagger UI at `/docs` for internal use, Redoc at `/redoc` for external partners. They consume the same OpenAPI spec, so there is zero duplication.

### Protecting Your Documentation

In production, you probably do not want the entire internet browsing your internal API docs. Protect them:

```typescript
// Protect /docs with basic auth in production
if (process.env.NODE_ENV === 'production') {
  app.use(
    ['/docs', '/docs-json'],
    expressBasicAuth({
      challenge: true,
      users: {
        [process.env.DOCS_USERNAME]: process.env.DOCS_PASSWORD,
      },
    }),
  );
}

// Or restrict to internal network only
app.use('/docs', (req, res, next) => {
  const clientIp = req.ip || req.connection.remoteAddress;
  const isInternal = clientIp.startsWith('10.') ||
                     clientIp.startsWith('192.168.') ||
                     clientIp === '127.0.0.1';
  if (!isInternal && process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Documentation is internal only' });
  }
  next();
});
```

> **Common Mistake:** Leaving Swagger UI open on production without any protection. Your API documentation reveals every endpoint, every field, every error code, and every authentication mechanism. For a system handling financial transactions (hotel payments), this is a security exposure. At minimum, require authentication. Ideally, gate it to your VPN or internal network.

---

## SDK Generation from OpenAPI Specs

Once you have a well-structured OpenAPI specification, you can automatically generate client libraries (SDKs) for any programming language. This means the frontend team, mobile team, and partner developers never write raw `fetch` calls — they use type-safe, auto-generated client code.

### TypeScript Client Generation

The most common generator is `openapi-generator-cli`. Here is how to set it up:

```bash
# Install the generator
npm install -D @openapitools/openapi-generator-cli

# Generate a TypeScript/Axios client
npx openapi-generator-cli generate \
  -i ./openapi.json \
  -g typescript-axios \
  -o ./generated/booking-client \
  --additional-properties=supportsES6=true,npmName=@globalbooking/api-client,npmVersion=1.0.0
```

This produces a fully typed TypeScript client:

```typescript
// Using the generated TypeScript client
import { BookingsApi, Configuration } from '@globalbooking/api-client';

const config = new Configuration({
  basePath: 'https://api.globalbooking.com',
  accessToken: 'your-jwt-token',
});

const bookingsApi = new BookingsApi(config);

// Fully typed — IDE autocomplete shows all available fields
const booking = await bookingsApi.createBooking(
  '550e8400-e29b-41d4-a716-446655440000', // idempotencyKey
  {
    bookingType: 'hotel',
    hotelId: 12345,
    roomTypeId: 678,
    checkIn: '2026-03-15',
    checkOut: '2026-03-20',
    roomsCount: 2,
    guestsCount: 4,
    rooms: [
      { adultsCount: 2, childrenCount: 0, bedType: 'king' },
    ],
    totalAmount: 880.0,
    currency: 'USD',
    paymentMethod: {
      type: 'credit_card',
      provider: 'stripe',
      token: 'tok_visa',
    },
  },
);

// The return type is fully typed — booking.data.bookingId is number
console.log(`Booking created: ${booking.data.data.referenceCode}`);
```

### Python Client Generation

For data science teams and backend integrations written in Python:

```bash
npx openapi-generator-cli generate \
  -i ./openapi.json \
  -g python \
  -o ./generated/booking-client-python \
  --additional-properties=packageName=globalbooking,projectName=globalbooking-client
```

```python
# Using the generated Python client
from globalbooking import ApiClient, Configuration
from globalbooking.api import BookingsApi
from globalbooking.models import CreateBookingRequest, PaymentMethod

config = Configuration(
    host="https://api.globalbooking.com",
    access_token="your-jwt-token"
)

with ApiClient(config) as client:
    bookings_api = BookingsApi(client)

    request = CreateBookingRequest(
        booking_type="hotel",
        hotel_id=12345,
        check_in="2026-03-15",
        check_out="2026-03-20",
        total_amount=880.00,
        currency="USD",
        payment_method=PaymentMethod(
            type="credit_card",
            provider="stripe",
            token="tok_visa"
        )
    )

    response = bookings_api.create_booking(
        idempotency_key="550e8400-e29b-41d4-a716-446655440000",
        create_booking_request=request
    )

    print(f"Booking created: {response.data.reference_code}")
```

### Automating SDK Generation in CI/CD

To keep SDKs in sync with the API, automate generation in your CI pipeline:

```yaml
# .github/workflows/sdk-generation.yml
name: Generate and Publish SDKs
on:
  push:
    branches: [main]
    paths:
      - 'openapi.json'

jobs:
  generate-sdks:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        language:
          - { gen: typescript-axios, dir: ts, registry: npm }
          - { gen: python, dir: python, registry: pypi }
    steps:
      - uses: actions/checkout@v4

      - name: Generate ${{ matrix.language.gen }} client
        run: |
          npx @openapitools/openapi-generator-cli generate \
            -i ./openapi.json \
            -g ${{ matrix.language.gen }} \
            -o ./sdk/${{ matrix.language.dir }}

      - name: Run generated client tests
        run: |
          cd ./sdk/${{ matrix.language.dir }}
          npm test  # or pytest for Python

      - name: Publish to registry
        if: github.ref == 'refs/heads/main'
        run: |
          cd ./sdk/${{ matrix.language.dir }}
          # Publish to npm or PyPI
          npm publish --access public
```

> **Key Term:** **SDK (Software Development Kit)** — A pre-built client library that wraps your API calls in language-native functions. Instead of constructing HTTP requests manually, consumers call `bookingsApi.createBooking(...)`. SDKs reduce integration errors, provide type safety, and improve developer experience.

---

## Postman and Insomnia Collection Generation

Not every developer wants a full SDK. Many prefer testing APIs with Postman or Insomnia — GUI tools that let you construct requests, save them in collections, and share them with teammates.

### Generating a Postman Collection from OpenAPI

You can convert your OpenAPI spec directly to a Postman collection:

```bash
# Install the converter
npm install -D openapi-to-postmanv2

# Convert
npx openapi2postmanv2 \
  -s ./openapi.json \
  -o ./postman/Global_Booking_API.postman_collection.json \
  -p
```

Or use the programmatic API to customize the output:

```typescript
// scripts/generate-postman.ts
import * as Converter from 'openapi-to-postmanv2';
import * as fs from 'fs';

const openApiSpec = fs.readFileSync('./openapi.json', 'utf-8');

Converter.convert(
  { type: 'string', data: openApiSpec },
  {
    folderStrategy: 'Tags',    // Group by API tags
    requestParametersResolution: 'Example', // Use example values
    exampleParametersResolution: 'Example',
    optimizeConversion: true,
    stackLimit: 50,
  },
  (err, result) => {
    if (err) {
      console.error('Conversion failed:', err);
      return;
    }

    if (!result.result) {
      console.error('Conversion unsuccessful:', result.reason);
      return;
    }

    // Write the Postman collection
    fs.writeFileSync(
      './postman/Global_Booking_API.postman_collection.json',
      JSON.stringify(result.output[0].data, null, 2),
    );

    console.log('Postman collection generated successfully');
  },
);
```

### Postman Environment Variables

Generate a companion environment file so developers can switch between sandbox and production:

```json
{
  "name": "Global Booking - Sandbox",
  "values": [
    {
      "key": "base_url",
      "value": "https://sandbox-api.globalbooking.com",
      "enabled": true
    },
    {
      "key": "auth_token",
      "value": "",
      "enabled": true,
      "description": "JWT from POST /api/v1/auth/login"
    },
    {
      "key": "api_key",
      "value": "gbp_test_sk_your_sandbox_key_here",
      "enabled": true
    },
    {
      "key": "idempotency_key",
      "value": "{{$guid}}",
      "enabled": true,
      "description": "Auto-generates a unique UUID for each request"
    }
  ]
}
```

### Pre-Request Scripts for Automatic Authentication

Add a collection-level pre-request script that automatically fetches and refreshes tokens:

```javascript
// Postman pre-request script (runs before every request in the collection)
const tokenExpiry = pm.collectionVariables.get('token_expiry');
const now = Math.floor(Date.now() / 1000);

if (!tokenExpiry || now > parseInt(tokenExpiry) - 60) {
  // Token expired or will expire within 60 seconds — refresh it
  pm.sendRequest({
    url: pm.environment.get('base_url') + '/api/v1/auth/login',
    method: 'POST',
    header: { 'Content-Type': 'application/json' },
    body: {
      mode: 'raw',
      raw: JSON.stringify({
        email: pm.environment.get('test_email'),
        password: pm.environment.get('test_password'),
      }),
    },
  }, (err, response) => {
    if (err) {
      console.error('Auth failed:', err);
      return;
    }

    const data = response.json();
    pm.environment.set('auth_token', data.data.accessToken);
    pm.collectionVariables.set(
      'token_expiry',
      String(now + data.data.expiresIn)
    );
  });
}
```

### Insomnia Import

Insomnia natively imports OpenAPI specs. No conversion is needed:

1. Open Insomnia.
2. Click **Create** then **Import**.
3. Select your `openapi.json` file.
4. Insomnia creates a request collection organized by tags.

For CI/CD environments, you can also use Insomnia's CLI tool (`inso`) to run API tests:

```bash
# Run tests defined in an Insomnia collection
npx insomnia-inso run test "Global Booking API Tests" \
  --src ./openapi.json \
  --env "Sandbox"
```

> **Checkpoint:** Can you describe the difference between an SDK and a Postman collection? When would a developer prefer one over the other? Think about the frontend developer who needs type-safe integration versus the QA engineer who needs to manually test edge cases.

---

## Changelog Management: How to Communicate Breaking Changes

APIs evolve. Fields get renamed. Endpoints get deprecated. New required parameters appear. The question is not whether you will make breaking changes — it is how you communicate them so your consumers are not blindsided.

### What Counts as a Breaking Change?

Not all API changes are equal. Here is a definitive classification:

| Change Type | Breaking? | Example | Action Required |
|---|---|---|---|
| Adding a new optional field to a request | No | Added `loyaltyMemberId` to CreateBookingRequest | No consumer action needed |
| Adding a new field to a response | No | Added `loyaltyPointsEarned` to BookingResponse | No consumer action (if consumers ignore unknown fields) |
| Adding a new endpoint | No | Added `GET /api/v1/bookings/{id}/receipt` | No consumer action needed |
| Adding a new enum value | Caution | Added `crypto` to PaymentMethod.type | Non-breaking if consumers handle unknown enum values gracefully |
| Removing a field from a response | **Yes** | Removed `expiresAt` from BookingResponse | Consumers relying on this field will break |
| Renaming a field | **Yes** | Changed `rooms` to `roomAllocations` | All consumers must update their parsing code |
| Changing a field type | **Yes** | Changed `bookingId` from `number` to `string` | All consumers must update their type expectations |
| Making an optional field required | **Yes** | `guestsCount` is now required | Consumers not sending this field get 400 errors |
| Changing the URL path | **Yes** | `/api/v1/bookings` becomes `/api/v1/reservations` | All consumers must update their URLs |
| Changing an error code | **Yes** | `INVENTORY_EXHAUSTED` replaces `INSUFFICIENT_INVENTORY` | Consumers matching on the old code miss this error |
| Changing authentication mechanism | **Yes** | Switching from API key to OAuth2 | All consumers must re-implement authentication |

### The Changelog Format

Maintain a `CHANGELOG.md` in your API repository that follows a consistent format:

```markdown
# API Changelog

All notable changes to the Global Booking API are documented here.
This changelog follows [Keep a Changelog](https://keepachangelog.com/).

## [1.5.0] - 2026-03-01

### Added
- `GET /api/v1/bookings/{id}/receipt` — Retrieve a PDF receipt for a confirmed booking
- `loyaltyPointsEarned` field added to BookingResponse (non-breaking)
- `loyaltyMemberId` optional field added to CreateBookingRequest (non-breaking)

### Changed
- `GET /api/v1/bookings` now supports `sortBy` parameter with values: `createdAt`, `checkIn`, `totalAmount`
- Rate limit for Standard tier increased from 60 to 100 requests/minute

### Deprecated
- `GET /api/v1/bookings/{id}/invoice` — Use `/receipt` instead. Will be removed in v1.7.0 (2026-06-01).

### Fixed
- `INSUFFICIENT_INVENTORY` error now returns the actual available quantity in the message
- Pagination `totalItems` count was off by one for filtered queries

---

## [1.4.0] - 2026-02-01

### Added
- `force_majeure` added to CancelBookingRequest reason enum
- `BOOKING_EXPIRED` error code for pending bookings past their deadline

### Breaking Changes
- **`rooms` field renamed to `roomAllocations`** in CreateBookingRequest (v2 only)
  - Migration: Replace `rooms: [...]` with `roomAllocations: [...]` in your request body
  - v1 endpoints continue to accept `rooms` — this change only affects `/api/v2/bookings`
  - Deadline: v1 support ends 2027-01-01

### Security
- API keys now require TLS 1.3 minimum. Connections using TLS 1.2 are rejected.
```

### Automated Changelog Notifications

Do not rely on developers reading a changelog file. Push changes to them:

```typescript
// scripts/notify-changelog.ts — Send changelog updates to consumers
import axios from 'axios';
import * as fs from 'fs';

interface WebhookSubscription {
  url: string;
  events: string[]; // ['breaking_change', 'deprecation', 'new_feature']
}

async function notifyConsumers(
  changeType: string,
  summary: string,
  details: string,
) {
  // Fetch all registered webhook subscribers
  const subscribers: WebhookSubscription[] = await getSubscribers();

  const notification = {
    type: changeType,
    apiVersion: '1.5.0',
    timestamp: new Date().toISOString(),
    summary,
    details,
    changelogUrl: 'https://docs.globalbooking.com/changelog',
    migrationGuideUrl: changeType === 'breaking_change'
      ? 'https://docs.globalbooking.com/migration/v1-to-v2'
      : undefined,
  };

  for (const subscriber of subscribers) {
    if (subscriber.events.includes(changeType)) {
      try {
        await axios.post(subscriber.url, notification, {
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Signature': generateSignature(notification),
          },
          timeout: 5000,
        });
      } catch (err) {
        console.error(`Failed to notify ${subscriber.url}:`, err.message);
      }
    }
  }
}

// Trigger on release
notifyConsumers(
  'deprecation',
  'GET /api/v1/bookings/{id}/invoice is deprecated',
  'Use GET /api/v1/bookings/{id}/receipt instead. Invoice endpoint will be removed on 2026-06-01.',
);
```

### Deprecation Timeline

Every breaking change must follow a defined timeline:

```
1. Announcement (T-6 months)
   └── Changelog entry, email to registered developers, banner in Swagger UI

2. Deprecation Warning (T-3 months)
   └── X-API-Deprecated header added to responses
   └── Warning log entries when deprecated endpoints are called
   └── Dashboard showing which consumers still use deprecated features

3. Migration Support (T-2 months)
   └── Migration guide published
   └── New version available in sandbox for testing
   └── Office hours for integration questions

4. Brownout Period (T-1 month)
   └── Deprecated endpoint returns 503 for 5 minutes every Monday
   └── Forces consumers to notice and migrate

5. Sunset (T-0)
   └── Deprecated endpoint returns 410 Gone permanently
   └── Logs show which consumers were still calling it (for outreach)
```

> **Key Term:** **Brownout** — A planned, temporary disruption of a deprecated API endpoint to force consumers to migrate. Unlike a permanent shutdown (sunset), a brownout is short (minutes to hours) and happens on a predictable schedule. It is the API equivalent of a fire drill — uncomfortable, but it ensures everyone knows the exits.

---

## Production War Story: The $200K Documentation Failure

This happened at a hotel booking platform (not ours, but one that learned these lessons the hard way).

**The Setup:**

A major hotel chain — let us call them Grandview Hotels, with 400 properties — signed a deal to integrate directly with the booking platform's API. The integration was worth $2 million annually. The hotel chain's development team received access to the API documentation and began building their integration.

**The Problem:**

The API documentation for the `POST /bookings` endpoint showed this example response:

```json
{
  "id": 12345,
  "status": "confirmed",
  "total": 500.00
}
```

What the documentation did NOT show was that the `total` field could sometimes be `null` — specifically, for bookings where the price was "request-based" (luxury suites with variable pricing). The actual response in production:

```json
{
  "id": 12345,
  "status": "confirmed",
  "total": null
}
```

Grandview Hotels' integration team wrote their code assuming `total` was always a number. Their system multiplied the booking total by the local tax rate to calculate the final charge: `finalCharge = booking.total * taxRate`. When `total` was `null`, JavaScript silently computed `null * 0.12 = 0`. The hotel chain charged guests zero dollars for luxury suite bookings.

**The Fallout:**

- 847 luxury suite bookings over 6 weeks were charged $0.
- The total revenue loss was approximately $200,000.
- The hotel chain discovered the bug only during their monthly reconciliation.
- Recovering the money required contacting 847 guests individually — most of whom had already checked out.
- Grandview Hotels threatened to terminate the $2M/year contract.
- The fix was a one-line change: `total: number | null` in the OpenAPI spec, plus adding a note: "Total is null for request-based pricing. The consuming system must handle this case."

**The Lesson:**

The API was correct. The code worked exactly as designed. The failure was entirely in the documentation. A nullable field was documented as if it were always present. One missing `| null` annotation cost $200,000 in direct revenue and nearly destroyed a $2M partnership.

**What Should Have Been Done:**

1. The OpenAPI spec should have marked `total` as `nullable: true`.
2. The response examples should have included a null-total case.
3. The DTO should have used `@ApiPropertyOptional()` instead of `@ApiProperty()`.
4. The generated TypeScript SDK would have typed `total` as `number | null`, and the hotel chain's code would not have compiled without a null check.

> **Production War Story:** Documentation is not just developer convenience — it is a financial contract. When your API serves partners who build business logic on top of your responses, every undocumented edge case is a potential lawsuit. The cost of documenting a nullable field is 30 seconds. The cost of not documenting it was $200,000 and a relationship crisis. Document your nulls. Document your edge cases. Document everything.

---

## Common Mistakes with API Documentation

Over years of building and maintaining APIs at scale, these are the mistakes we see most often. Each one has cost real teams real time and money.

> **Common Mistake:** **Documenting only the happy path.** You show the 200 response but not the 400, 401, 402, 409, or 429 responses. The developer integrating your API spends 80% of their time handling errors, not successes. If you only document the success case, you have documented 20% of what they need.

> **Common Mistake:** **Stale examples.** Your docs show `"bookingType": "hotel"` but the code now requires `"bookingType": "hotel_room"`. This happens when examples are written once and never updated. The fix: generate examples from your test suite, not from a static document.

> **Common Mistake:** **Missing field descriptions for nested objects.** You document the top-level `paymentMethod` field but not its nested `type`, `provider`, and `token` fields. The developer has to guess what `token` means — is it a credit card number? A Stripe token? A session ID? Every field, at every nesting level, needs a description.

> **Common Mistake:** **No curl examples.** Developers copy-paste before they read. If your docs do not include a `curl` command that works, the developer writes their own — and gets it wrong. Here is the gold standard:

```bash
# Create a hotel booking
curl -X POST https://sandbox-api.globalbooking.com/api/v1/bookings \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "bookingType": "hotel",
    "hotelId": 12345,
    "roomTypeId": 678,
    "checkIn": "2026-03-15",
    "checkOut": "2026-03-20",
    "roomsCount": 1,
    "guestsCount": 2,
    "rooms": [{ "adultsCount": 2, "childrenCount": 0, "bedType": "king" }],
    "totalAmount": 440.00,
    "currency": "USD",
    "paymentMethod": {
      "type": "credit_card",
      "provider": "stripe",
      "token": "tok_visa"
    }
  }'
```

> **Common Mistake:** **Documentation in a wiki, not the repo.** Confluence pages, Notion docs, and Google Docs for API documentation guarantee drift. The code changes in a pull request, but the wiki is updated "later" — which means never. Keep your OpenAPI spec in the same repository as your service code. If the spec is not updated in the same PR as the code change, the CI check should fail.

> **Common Mistake:** **No sandbox environment.** Your docs say "try this endpoint" but the only environment is production. No developer wants to create real bookings and charge real credit cards just to test their integration. A sandbox environment with fake data and no real charges is not optional — it is a prerequisite for partner integrations.

> **Common Mistake:** **Assuming consumers parse responses strictly.** Your v1 response has 5 fields. Your v2 adds a 6th. A consumer using a strict JSON parser that rejects unknown fields now breaks on v1 responses (because v2 is behind a feature flag that leaked a new field). Document your compatibility guarantees: "Consumers MUST ignore unknown fields in responses. New fields may be added without a version bump."

> **Common Mistake:** **Not documenting rate limits per endpoint.** Your docs say "100 requests per minute." But is that per endpoint? Per API key? Per user? Globally? The answer matters enormously. A consumer might make 50 booking requests and 50 availability checks and hit a global limit they did not know existed. Document the rate limit scope explicitly.

---

## Practical Tips for Documentation That Gets Read

1. **Include working `curl` examples for every endpoint.** Developers copy-paste before they read schemas. Make the first thing they try actually work.

2. **Document the unhappy paths more thoroughly than the happy paths.** Showing a successful 201 response is easy. Showing what happens when the card is declined, when the room is sold out, when the token is expired, when the idempotency key is reused — that is what developers actually need.

3. **Version your docs with your API.** If `/api/v1/bookings` and `/api/v2/bookings` coexist, the documentation for both versions must coexist too. A developer should never wonder "is this doc for v1 or v2?"

4. **Keep docs next to code.** Documentation in a separate wiki drifts out of sync within weeks. OpenAPI specs in the same repository as the service code get updated in the same pull request.

5. **Include a "Getting Started" section that is under 5 minutes.** The developer who just received API access should be able to authenticate and make their first successful request in under 5 minutes. Time it yourself. If it takes longer, simplify.

6. **Show timestamps in ISO 8601.** Do not document a date field as "the booking date" — document it as "ISO 8601 date-time in UTC (e.g., `2026-03-15T10:30:00Z`). No timezones — all timestamps are UTC."

7. **Document idempotency behavior explicitly.** Do not just say "this endpoint is idempotent." Say "If you send the same `Idempotency-Key` twice, the second request returns the original response with a `200` status (not `201`). The key expires after 24 hours."

8. **Add a "What's New" banner to your docs.** When you release a new feature, make it visible. A dated banner at the top of your docs — "February 2026: Added loyalty points support" — tells consumers that the docs are actively maintained.

---

## Chapter 40 Summary

| Concept | One-Sentence Summary |
|---|---|
| Developer experience (DX) | API documentation is a product feature, not a chore — it directly affects integration speed and partner satisfaction. |
| Time to First Successful API Call | The most important DX metric: how fast can a developer go from zero to one successful request. |
| OpenAPI Specification | A machine-readable YAML/JSON format that describes your entire API and enables tooling automation. |
| NestJS Swagger integration | Decorators like `@ApiTags`, `@ApiOperation`, `@ApiResponse`, and `@ApiProperty` generate the OpenAPI spec from code. |
| DTO documentation | DTOs with both validation (`class-validator`) and documentation (`@nestjs/swagger`) decorators serve as both contract enforcers and specification generators. |
| Authentication docs | Document every step: obtain token, use token, refresh token. Show full HTTP requests, not hints. |
| Error standardization | Every microservice must return errors in the same envelope: `{ success: false, error: { code, message, details, traceId } }`. |
| Error codes table | List every error code with HTTP status, description, and recommended consumer action — including "do NOT retry." |
| API versioning | Use URL-based versioning (`/api/v1/`, `/api/v2/`), document the lifecycle (stable, deprecated, sunset), and include version headers. |
| Code-first vs. spec-first | Code-first with guardrails gives you development speed plus breaking-change detection in CI. |
| Swagger UI | Interactive API explorer for internal developers — protectable with auth or network restrictions. |
| Redoc | Beautiful three-panel read-only documentation for partner developers and external consumers. |
| SDK generation | Auto-generate TypeScript, Python, and other client libraries from your OpenAPI spec using `openapi-generator-cli`. |
| Postman collections | Convert OpenAPI specs to Postman/Insomnia collections for manual testing and QA workflows. |
| Changelog management | Maintain a structured changelog, classify changes as breaking/non-breaking, and follow a deprecation timeline with brownout periods. |
| Documentation security | Protect internal docs with auth or network restrictions — your API spec reveals your entire attack surface. |

> **Checkpoint:** Can you explain why the "Create Booking" endpoint uses an `Idempotency-Key` header and why cancellation is a `POST` rather than a `DELETE`? Can you name at least six error codes from memory and describe when each occurs? Can you describe the deprecation timeline from announcement to sunset? Can you explain the trade-offs between code-first and spec-first documentation? If yes, you understand API documentation well enough to build and maintain it at enterprise scale. If not, re-read the sections that felt unclear — these patterns appear throughout every chapter that follows.

---
