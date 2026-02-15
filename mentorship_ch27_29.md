# Part 7: Security & Compliance

---

# Chapter 27: Security Architecture — Thinking Like an Attacker

## You Already Lock the Front Door

You know how to hash a password with `bcrypt`. You know that HTTPS encrypts traffic between the browser and the server. Good. That puts you ahead of a surprising number of developers who ship production code with passwords stored in plaintext and APIs served over bare HTTP.

But here is the uncomfortable truth: hashing passwords and enabling HTTPS is like locking the front door of your house and calling it a day. A determined burglar does not use the front door. They try the windows. They check the garage. They look for the spare key under the mat. They might even come in through the neighbor's adjoining wall.

Security in a distributed booking system works the same way. You are not defending against one type of attack. You are defending against dozens, and the attacker only has to find one weakness. You have to get all of them right.

This chapter teaches you how to think like an attacker — so you can build like a defender.

---

## Defense in Depth: Walls Within Walls

> **Analogy:** Picture a medieval castle. The outer wall is tall and thick — that is your HTTPS layer. But inside, there is a moat (rate limiting), a gatehouse with guards checking papers (authentication and input validation), inner walls separating the keep from the courtyard (network policies), guards at every doorway (authorization checks), and a vault in the deepest chamber with its own lock (encryption at rest). If an attacker breaches the outer wall, they still face the moat. If they cross the moat, the gatehouse stops them. If they bluff past the gatehouse, the inner walls contain them. No single layer is perfect, but together, they make a breach astronomically harder.

This principle is called **defense in depth**, and it is the single most important concept in security architecture. You never rely on one protection. You stack them.

> **Key Term:** **Defense in Depth** — A security strategy that layers multiple independent protections so that the failure of any single layer does not compromise the entire system. If your input validation has a bug, your parameterized queries still prevent SQL injection. If your parameterized queries somehow fail, your database permissions limit the damage.

Here is how those layers map to our booking platform:

| Layer | What It Does | Example |
|---|---|---|
| **Network** | Controls which services can talk to each other | Kubernetes network policies, mTLS |
| **Transport** | Encrypts data in transit | HTTPS/TLS, mTLS between services |
| **Application** | Validates and sanitizes all input | Helmet.js headers, input validation, CSRF tokens |
| **Data** | Protects data at rest and in use | Encryption, tokenization, secret management |
| **Monitoring** | Detects breaches after they happen | Audit logs, anomaly detection, alerts |

We are going to walk through each of these layers. By the end of this chapter, you will have a complete security middleware stack that you understand line by line.

---

## The Security Middleware Stack

In Express or NestJS, middleware runs before your route handlers. Think of it as a series of checkpoints that every incoming request must pass through. If the request fails any checkpoint, it gets rejected before touching your business logic.

Here is the full security middleware stack for our booking platform. We will go through every piece afterward.

```typescript
// security/middleware-stack.ts
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function configureSecurityMiddleware(app: Express) {
  // === Layer 1: Security Headers (Helmet) ===
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],         // Only load resources from our own domain
        scriptSrc: ["'self'"],          // No inline scripts, no external scripts
        styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles (CSS-in-JS)
        imgSrc: ["'self'", 'data:', 'https:'],   // Images from us, data URIs, or HTTPS
        connectSrc: ["'self'"],         // AJAX/fetch only to our own domain
        fontSrc: ["'self'"],            // Fonts from our domain only
        objectSrc: ["'none'"],          // No Flash, no Java applets (yes, they still exist)
        mediaSrc: ["'none'"],           // No audio/video embeds
        frameSrc: ["'none'"]            // No iframes — prevents clickjacking
      }
    },
    hsts: {
      maxAge: 31536000,                 // Tell browsers to use HTTPS for 1 year
      includeSubDomains: true,          // Apply to all subdomains too
      preload: true                     // Submit to browser preload lists
    },
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin'  // Limit info leaked in Referer header
    }
  }));

  // === Layer 2: Request Size Limits ===
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // === Layer 3: Rate Limiting ===
  app.use('/api/bookings', rateLimit({
    windowMs: 60 * 1000,       // 1-minute window
    max: 100,                   // 100 booking requests per minute per IP
    standardHeaders: true,      // Send rate limit info in RateLimit-* headers
    legacyHeaders: false,       // Don't send X-RateLimit-* headers (deprecated)
    message: { error: 'Too many booking requests, please try again later' }
  }));

  app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,  // 15-minute window
    max: 20,                    // 20 auth attempts per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts' }
  }));
}
```

That is a lot of configuration. Let us break down what each piece defends against — and what happens if you leave it out.

---

## Helmet: The Headers You Do Not Think About

When your Express server sends a response, it includes HTTP headers. Some of these headers tell the browser what it is and is not allowed to do. Without Helmet, you are sending no security headers at all, which means the browser applies its most permissive defaults.

Helmet sets around a dozen headers in one line of code. Here are the ones that matter most:

### Content-Security-Policy (CSP)

CSP tells the browser: "Only execute scripts that come from these sources." If an attacker injects a `<script>` tag into your page (via an XSS vulnerability we will discuss shortly), the browser will refuse to run it because it did not come from an allowed source.

```
Content-Security-Policy: default-src 'self'; script-src 'self'
```

This single header prevents the vast majority of XSS attacks. The browser becomes your last line of defense.

### Strict-Transport-Security (HSTS)

HSTS tells the browser: "For the next year, only connect to this domain over HTTPS. Even if the user types `http://`, upgrade to `https://` automatically."

Without HSTS, an attacker on a public Wi-Fi network can intercept the initial HTTP request (before the redirect to HTTPS) and redirect the user to a fake version of your site. This is called an **SSL stripping attack**.

### X-Frame-Options / frameSrc

This prevents other websites from embedding your site inside an iframe. Without it, an attacker can create a page with an invisible iframe pointing to your booking form, trick the user into clicking, and the click actually hits *your* button. This is called **clickjacking**.

> **What If You Skip This?** Without Helmet, your responses are missing security headers that every modern browser knows how to enforce. You are giving up free protection. It takes one line of code: `app.use(helmet())`. There is no reason to skip it.

---

## Request Size Limits: The Quiet Bodyguard

```typescript
app.use(express.json({ limit: '1mb' }));
```

This line looks boring. It might be the most important line in your security stack.

Without a size limit, an attacker can send a 500 MB JSON body to your API. Your server will faithfully try to parse it, consume all available memory, and crash. This is called a **denial-of-service (DoS) attack**, and it requires zero sophistication — just a `curl` command.

Your booking API never needs to receive more than a few kilobytes of data per request. Setting a 1 MB limit is already generous. For APIs that only accept IDs and dates, you could set it to 10 KB.

---

## Rate Limiting: The Bouncer

Rate limiting caps how many requests a single client (identified by IP address) can make within a time window. Look at the two rate limiters in our stack:

```typescript
// Bookings: 100 requests/minute
app.use('/api/bookings', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
}));

// Auth: 20 requests/15 minutes
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
}));
```

Why different limits for different routes? Because the threat models are different:

- **Booking endpoints** need to handle bursts from legitimate users (someone comparing options, going back and forth). 100 per minute is generous for real users, but it stops a bot from hammering your API with thousands of fake bookings.
- **Auth endpoints** are the target of **brute-force attacks** — someone trying thousands of password combinations. 20 attempts in 15 minutes is plenty for a real user who mistyped their password. It is nowhere near enough for an attacker running a dictionary attack.

> **Key Term:** **Rate Limiting** — Restricting the number of requests a client can make within a time window. It prevents abuse without blocking legitimate users. In production, you should use a distributed rate limiter backed by Redis so that limits apply across all instances of your service, not just one.

---

## Input Validation: Trust Nobody

You probably already validate input. You check that `email` looks like an email, that `checkIn` is a date, maybe that `name` is not empty. Good. But security-focused input validation goes further.

Here is our input sanitizer:

```typescript
export class InputSanitizer {
  static sanitizeString(input: string): string {
    return input
      .replace(/[<>]/g, '')          // Remove angle brackets (prevents HTML injection)
      .replace(/javascript:/gi, '')   // Remove JS protocol (prevents script execution)
      .replace(/on\w+=/gi, '')       // Remove event handlers (onclick=, onerror=, etc.)
      .trim()
      .substring(0, 10000);          // Hard length cap — no 1 million character names
  }

  static validateBookingInput(dto: CreateBookingDto): ValidationResult {
    const errors: string[] = [];

    // Validate amounts are positive and within range
    if (dto.totalAmount <= 0 || dto.totalAmount > 1000000) {
      errors.push('Total amount must be between 0 and 1,000,000');
    }

    // Validate currency is an allowed ISO code
    const allowedCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD'];
    if (!allowedCurrencies.includes(dto.currency)) {
      errors.push(`Invalid currency: ${dto.currency}`);
    }

    // Validate dates
    const checkIn = new Date(dto.checkIn);
    const checkOut = new Date(dto.checkOut);
    if (checkIn >= checkOut) {
      errors.push('Check-in must be before check-out');
    }
    if (checkIn < new Date()) {
      errors.push('Check-in cannot be in the past');
    }

    return { valid: errors.length === 0, errors };
  }
}
```

Let us walk through why each sanitization step exists:

**`replace(/[<>]/g, '')`** — This removes angle brackets, which are the building blocks of HTML tags. If an attacker sends a name like `<script>alert('hacked')</script>`, the angle brackets are stripped and the result is harmless text: `scriptalert('hacked')/script`. This is your first line of defense against Cross-Site Scripting.

**`replace(/javascript:/gi, '')`** — Some XSS attacks do not use `<script>` tags. They use the `javascript:` protocol in links: `<a href="javascript:stealCookies()">`. This strips it.

**`replace(/on\w+=/gi, '')`** — Event handler attributes like `onclick=`, `onerror=`, and `onload=` can execute JavaScript when attached to HTML elements. This regex catches all of them.

**`.substring(0, 10000)`** — A hard cap on string length. No legitimate user name is 10,000 characters. But an attacker might send a string with millions of characters to consume memory or exploit a regex vulnerability (called **ReDoS** — Regular Expression Denial of Service).

> **Analogy:** Input validation is like airport security. You check every bag (every input field), no matter who the passenger is (even authenticated users). The 80-year-old grandmother gets checked, and so does the airline pilot. It is not about distrust — it is about procedure. One day, the "trusted" input will be the one carrying the exploit.

---

## The Big Four Attacks You Must Understand

You have heard these acronyms. Let us make sure you really understand what they do and how to stop them.

### 1. SQL Injection

You already use parameterized queries, right? Let us make sure you understand *why*.

```typescript
// VULNERABLE: String concatenation builds the query
const query = `SELECT * FROM users WHERE email = '${email}'`;
// If email is: ' OR '1'='1
// The query becomes: SELECT * FROM users WHERE email = '' OR '1'='1'
// This returns EVERY user in your database.

// SAFE: Parameterized query — the database treats $1 as a value, never as SQL
const query = `SELECT * FROM users WHERE email = $1`;
await db.query(query, [email]);
// Even if email is ' OR '1'='1, the database searches for a user
// whose email is literally the string: ' OR '1'='1
// It finds nothing. Your data is safe.
```

The key insight: with parameterized queries, user input is never interpreted as SQL code. It is always treated as data. The database engine itself enforces this boundary. Even if your input validation has a bug, parameterized queries still protect you. That is defense in depth in action.

### 2. Cross-Site Scripting (XSS)

XSS happens when an attacker injects JavaScript into your page that runs in other users' browsers. There are two flavors:

**Stored XSS:** The attacker saves malicious JavaScript in your database (for example, as a hotel review). When another user views that review, the script runs in their browser, potentially stealing their session cookie.

**Reflected XSS:** The attacker crafts a URL with a malicious query parameter. When someone clicks the link, the server reflects that parameter into the page, and the script runs.

Your defenses:
1. **Input sanitization** (the `InputSanitizer` class above) strips dangerous characters on the way in
2. **Output encoding** converts special characters to HTML entities on the way out (`<` becomes `&lt;`)
3. **Content-Security-Policy** tells the browser to reject any script not from your domain

### 3. Cross-Site Request Forgery (CSRF)

CSRF tricks a logged-in user's browser into making a request to your API without the user knowing.

Imagine a user is logged into your booking platform. They visit a malicious website that contains a hidden form that submits `POST /api/bookings` to *your* server. Because the user's browser automatically includes your session cookie, the request looks legitimate. The booking goes through, charged to the victim's card.

Your defenses:
1. **CSRF tokens** — a random value embedded in forms that the attacker cannot guess
2. **SameSite cookies** — tell the browser not to send your cookies with cross-origin requests
3. **Checking the `Origin` header** — reject requests that did not originate from your domain

### 4. CORS (Cross-Origin Resource Sharing)

CORS is not an attack — it is a defense. By default, browsers block web pages from making requests to a different domain. CORS headers tell the browser which domains are allowed.

```typescript
// Only allow requests from your frontend domains
app.use(cors({
  origin: ['https://booking.example.com', 'https://admin.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true  // Allow cookies to be sent
}));
```

If you set `origin: '*'` (allow everything), you have effectively disabled CORS protection. Any website can make requests to your API. Do not do this in production.

> **What If You Skip This?** Without CORS configuration, browsers apply the default same-origin policy, which is safe but means your legitimate frontend cannot talk to your API if they are on different domains. If you slap on `origin: '*'` to "fix" it, you open your API to the entire internet. Configure it properly: whitelist your specific domains.

### Summary of the Big Four

| Attack | What It Does | Primary Defense | Backup Defense |
|---|---|---|---|
| SQL Injection | Executes attacker's SQL in your database | Parameterized queries | Input validation, least-privilege DB users |
| XSS | Runs attacker's JavaScript in users' browsers | Output encoding | Input sanitization, Content-Security-Policy |
| CSRF | Tricks user's browser into making unwanted requests | CSRF tokens, SameSite cookies | Origin header checks |
| CORS misconfiguration | Allows any website to call your API | Whitelist specific origins | Do not use `origin: '*'` |

---

## Secret Management: No Secrets in Code

You have probably seen `.env` files in tutorials. They work fine for local development. They are a disaster in production. Here is why: `.env` files get committed to Git (accidentally or on purpose), shared in Slack, and copied between servers manually. One data breach later, every API key, database password, and encryption key is public.

In production, use a dedicated secret manager. Our platform uses AWS Secrets Manager (HashiCorp Vault is another excellent choice).

```typescript
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager';

export class SecretManager {
  private readonly client = new SecretsManagerClient({
    region: process.env.REGION   // The ONLY env var you need
  });
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly cacheTTL = 300000; // 5 minutes

  async getSecret(secretName: string): Promise<string> {
    // Check cache first — avoid hitting AWS on every request
    const cached = this.cache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // Fetch from AWS Secrets Manager
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);
    const value = response.SecretString!;

    // Cache it for 5 minutes
    this.cache.set(secretName, {
      value,
      expiresAt: Date.now() + this.cacheTTL
    });

    return value;
  }
}
```

Let us walk through this code:

1. **The `SecretManager` class wraps AWS Secrets Manager.** Instead of reading `process.env.DB_PASSWORD` everywhere, services call `secretManager.getSecret('booking-service/db-password')`.
2. **Secrets are cached for 5 minutes.** Without caching, every database connection would trigger an API call to AWS, adding latency and cost. With caching, the first call fetches the secret, and subsequent calls use the in-memory copy.
3. **The cache TTL is 5 minutes, not infinite.** This means if you rotate a secret in AWS (change a database password), all services pick up the new value within 5 minutes — without a restart.
4. **The only environment variable is `REGION`.** The actual secrets live in AWS, never in your code, never in environment variables, never in config files.

> **Key Term:** **Secret Rotation** — The practice of periodically changing credentials (database passwords, API keys, encryption keys). A secret manager makes rotation painless because services fetch the current secret on each cache miss. Without a secret manager, rotation requires redeploying every service that uses the credential.

---

## Network Policies: The Inner Walls

In a castle, even after an intruder gets past the outer wall, inner walls restrict where they can go. Kubernetes network policies do the same thing for your services.

By default, every pod in a Kubernetes cluster can talk to every other pod. That is convenient for development and dangerous in production. If an attacker compromises the Notification Service, they can reach the Payment Service directly. Network policies prevent this.

```yaml
# Kubernetes Network Policy — restrict booking-service communication
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: booking-service-netpol
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: booking-service       # This policy applies to booking-service pods
  policyTypes:
    - Ingress                     # Control incoming traffic
    - Egress                      # Control outgoing traffic
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway   # ONLY the API Gateway can send requests IN
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: inventory-service   # Booking can call Inventory
        - podSelector:
            matchLabels:
              app: payment-service     # Booking can call Payment
        - podSelector:
            matchLabels:
              app: notification-service # Booking can call Notification
      ports:
        - protocol: TCP
          port: 3000
    - to:                              # Allow DNS lookups (required for K8s)
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
```

Read this policy like a bouncer's instructions:

- **Ingress (incoming):** Only accept requests from pods labeled `api-gateway`. If the Search Service or any other pod tries to call the Booking Service directly, the request is dropped at the network level — it never reaches the application.
- **Egress (outgoing):** The Booking Service can only call `inventory-service`, `payment-service`, and `notification-service`. It cannot reach the database directly (that is handled by connection strings within the pod). It cannot reach the internet. It cannot reach other namespaces.
- **DNS exception:** Without the DNS egress rule, the pod cannot resolve Kubernetes service names. This is a common gotcha — your policy blocks everything, including DNS, and suddenly nothing can find anything.

> **What If You Skip This?** Without network policies, a compromised service has unrestricted access to your entire cluster. An attacker who exploits a vulnerability in your Notification Service (maybe through a malicious email template) can pivot to your Payment Service and exfiltrate credit card data. Network policies contain the blast radius.

---

## mTLS: Every Service Proves Its Identity

In standard HTTPS, only the server proves its identity to the client (the server presents its certificate, the client verifies it). In **mutual TLS (mTLS)**, both sides prove their identity. The client also presents a certificate, and the server verifies it.

In our platform, Istio (the service mesh) handles mTLS automatically. Every service-to-service call is encrypted, and both sides verify each other's identity. You do not need to write any code for this — Istio injects sidecar proxies that handle TLS termination and certificate rotation.

Why does this matter? Without mTLS, an attacker who gains access to the Kubernetes network can impersonate any service. They can send requests that look like they come from the API Gateway but actually come from a rogue pod. With mTLS, every request proves its origin cryptographically.

> **Key Term:** **mTLS (Mutual TLS)** — A protocol where both the client and server authenticate each other using certificates. In a microservices architecture, mTLS ensures that only authorized services can communicate with each other, even within the cluster's internal network.

---

## The OWASP Top 10 for Booking Systems

The Open Web Application Security Project (OWASP) publishes a list of the ten most critical web application security risks. Here is how each one applies to our booking platform and where our defenses address it:

| OWASP Risk | Booking System Example | Our Defense |
|---|---|---|
| Broken Access Control | User modifies booking ID in URL to view someone else's booking | Authorization checks on every endpoint |
| Cryptographic Failures | Storing credit card numbers in plaintext | Tokenization via Stripe, encryption at rest |
| Injection | SQL injection in search queries | Parameterized queries everywhere |
| Insecure Design | No rate limiting on password reset | Rate limiting middleware, account lockout |
| Security Misconfiguration | Default database credentials in production | Secret Manager, no defaults |
| Vulnerable Components | Outdated npm packages with known CVEs | Automated dependency scanning (Dependabot) |
| Auth Failures | No brute-force protection on login | Rate limiting on auth endpoints |
| Data Integrity Failures | Unsigned JWTs that can be tampered with | RS256-signed JWTs, verified on every request |
| Logging Failures | No audit trail for admin actions | Structured logging, audit log table |
| SSRF | User-submitted URL fetched by the server | URL allowlisting, no arbitrary URL fetching |

---

## Chapter 27 Summary

| Concept | One-Sentence Summary |
|---|---|
| Defense in Depth | Layer multiple independent security controls so no single failure is catastrophic. |
| Helmet.js | Sets security headers (CSP, HSTS, X-Frame-Options) with one line of middleware. |
| Rate Limiting | Caps requests per client to prevent brute-force and DoS attacks. |
| Input Validation | Sanitize and validate every input, even from authenticated users. |
| SQL Injection | Use parameterized queries so user input is never interpreted as SQL code. |
| XSS | Sanitize input, encode output, and set Content-Security-Policy headers. |
| CSRF | Use CSRF tokens and SameSite cookies to prevent cross-origin form submissions. |
| CORS | Whitelist specific frontend domains; never use `origin: '*'` in production. |
| Secret Management | Store secrets in AWS Secrets Manager or Vault, never in code or `.env` files. |
| Network Policies | Restrict pod-to-pod communication so compromised services cannot reach everything. |
| mTLS | Mutual certificate verification between services, automated by Istio. |

> **Checkpoint:** Can you explain defense in depth to a colleague without using the term itself? Try describing the castle analogy — outer wall, moat, gatehouse, inner walls, vault — and mapping each layer to a security technology. If you can name at least four layers and the technology for each, you have internalized this chapter. Also, can you explain why parameterized queries protect against SQL injection even if your input validation has a bug? That is the essence of layered defense.

---

---

# Chapter 28: Fraud Detection — Catching the Bad Guys

## The Day You Realize People Are Terrible

You have built your booking API. It validates input. It has rate limiting. Helmet is in place. You feel good about security. Then Monday morning rolls around, and your customer support inbox has thirty complaints from people who say they never made a booking — but their credit cards were charged.

Welcome to fraud.

Someone obtained a list of stolen credit card numbers (they are sold in bulk on the dark web for as little as $5 per card). They wrote a script that hits your booking API, one card after another, making small hotel reservations. They are testing which cards are still active. The ones that succeed get sold to bigger criminals. Your platform is the testing ground.

Or perhaps someone uses a single stolen card to book 50 hotel rooms across different cities. They resell the confirmation codes on a shady website for half price. The real cardholder files a chargeback. You refund the money. The scammer keeps the difference. Your hotel partners are furious.

Or maybe there is no stolen card at all. A bot is running through credit card numbers sequentially — 4111 1111 1111 0001, 4111 1111 1111 0002, 4111 1111 1111 0003 — trying to find valid combinations. This is called **card enumeration**, and it happens millions of times per day across the internet.

These are not hypothetical scenarios. They are Tuesday for any platform that processes payments.

---

## Why Input Validation Is Not Enough

You might think, "My input validation will catch this. The card number must be a valid format, the CVV must be three digits, the expiry must be in the future." And you are right — format validation catches typos. But it does not catch a valid stolen card. The card number is real. The CVV is correct. The expiry date is valid. Everything checks out.

Fraud detection is not about whether the data *looks* right. It is about whether the *behavior* looks right.

> **Analogy:** Imagine you run a nightclub. The bouncer at the door checks IDs — that is input validation. The ID is real, the photo matches, the person is 21. They get in. But inside the club, the bartender notices something strange: this person ordered 50 drinks in 10 minutes, paid with five different credit cards, and the cards are all registered to different people in different states. The ID is valid, but the behavior is not. Fraud detection is the bartender, not the bouncer.

---

## Rule-Based Detection: The First Line

The simplest fraud detection approach is rule-based: you define a set of rules, each one checking for a specific suspicious behavior. If the behavior is detected, you add points to a **risk score**. The higher the score, the more suspicious the transaction.

Let us look at the rules our booking platform uses.

### Rule 1: IP-Country Mismatch (30 points)

A user's billing address says they live in Germany, but their booking request comes from an IP address in Nigeria. This does not mean they are a fraudster — they could be traveling. But it is a signal. We add 30 points to their risk score.

```typescript
// The user says they live in Germany. Their IP is in Nigeria.
// That is suspicious but not conclusive.
const ipCountry = await this.getCountryFromIP(params.ipAddress);
const billingCountry = await this.getBillingCountry(params.userId);
if (ipCountry !== billingCountry) {
  riskScore += 30;
  triggeredRules.push('ip_country_mismatch');
}
```

### Rule 2: Velocity Check (40 points)

How many bookings has this user made in the last hour? One or two is normal. Five or more is suspicious. Real humans do not book five hotel rooms in sixty minutes — but bots do, and fraudsters testing stolen cards do.

```typescript
// Five or more bookings in 60 minutes? Smells like a bot.
const recentBookings = await this.getRecentBookings(params.userId, 60);
if (recentBookings.length >= 5) {
  riskScore += 40;
  triggeredRules.push('high_velocity');
}
```

> **Key Term:** **Velocity Check** — A fraud detection rule that counts how many times an action occurs within a time window. High velocity (many actions in a short period) is a strong indicator of automated fraud. In our system, we check bookings per hour, but you could also check payment attempts per minute or account creations per day.

### Rule 3: Amount Threshold (45 points)

A $5,000 booking is inherently riskier than a $100 booking — the potential loss is higher, and fraudsters prefer high-value transactions to maximize stolen card value.

```typescript
// A large transaction carries more risk.
if (params.amount > 5000) {
  riskScore += 45;
  triggeredRules.push('high_amount');
}
```

### Rule 4: Device Reputation

Every browser has a fingerprint — a combination of screen resolution, installed fonts, timezone, and browser version that is nearly unique. If we have seen this device fingerprint associated with previous fraud, its reputation score goes up.

```typescript
// Has this device been involved in fraud before?
const deviceRisk = await this.checkDeviceReputation(params.deviceFingerprint);
riskScore += deviceRisk.score;
if (deviceRisk.score > 0) triggeredRules.push('device_risk');
```

### Rule 5: Email Reputation

A freshly created email address from a disposable email provider (like `temp-mail.org`) used to make a $3,000 booking? That is suspicious. An email that has been associated with the user's account for three years? That is low risk.

```typescript
// Is this email address trustworthy?
const emailRisk = await this.checkEmailReputation(params.email);
riskScore += emailRisk.score;
if (emailRisk.score > 0) triggeredRules.push('email_risk');
```

### Rule 6: BIN Lookup

The first six digits of a credit card number are called the **Bank Identification Number (BIN)**. They tell you which bank issued the card and in which country. If the BIN says the card was issued in Brazil but the user's account, IP, and billing address are all in Japan, that is a signal.

```typescript
// Does the card's issuing country match the user's profile?
const binRisk = await this.checkCardBIN(params.cardBIN);
riskScore += binRisk.score;
if (binRisk.score > 0) triggeredRules.push('bin_risk');
```

> **Key Term:** **BIN (Bank Identification Number)** — The first six to eight digits of a payment card number. They identify the issuing bank, card type (credit/debit), and country of issuance. BIN lookups are a low-cost, high-signal fraud detection tool.

---

## Risk Scoring: Adding It All Up

No single rule is conclusive. An IP-country mismatch alone does not mean fraud — legitimate travelers trigger it constantly. A high-value booking alone is not fraud — wealthy customers exist. But an IP-country mismatch *plus* a high-value booking *plus* a device fingerprint associated with previous fraud? That is a pattern.

Risk scoring combines all the signals into a single number and uses thresholds to decide the outcome:

```typescript
// Determine status based on score thresholds
let status: FraudStatus;
if (riskScore >= 80) status = 'blocked';      // Too risky — reject immediately
else if (riskScore >= 50) status = 'under_review'; // Suspicious — hold for human review
else if (riskScore >= 25) status = 'flagged';  // Worth noting — proceed but log
else status = 'passed';                         // Looks clean — proceed normally
```

Let us make this concrete with examples:

| Scenario | Rules Triggered | Score | Status |
|---|---|---|---|
| Regular user, local IP, $200 booking | None | 0 | passed |
| Business traveler abroad, $800 booking | IP mismatch (30) | 30 | flagged |
| New device, high-value booking, IP mismatch | IP mismatch (30) + high amount (45) | 75 | under_review |
| Bot testing cards: 10 bookings in 5 minutes, disposable email | Velocity (40) + email risk (20) + IP mismatch (30) | 90 | blocked |

Notice that the system is not making a binary decision ("fraud" or "not fraud"). It is expressing confidence. A score of 30 says, "This is probably fine, but record it." A score of 90 says, "This is almost certainly fraud. Block it and alert the team."

> **Analogy:** Think of risk scoring like a doctor's assessment. A single symptom (cough) might be nothing. Two symptoms (cough and fever) warrant attention. Four symptoms (cough, fever, shortness of breath, and chest pain) trigger immediate action. No single symptom is conclusive, but the combination tells a story. Fraud scoring works the same way — individual signals are ambiguous, but the aggregate is powerful.

---

## The Full Fraud Detection Pipeline

Now let us look at the complete `FraudDetectionService` class. Every rule we discussed above runs in sequence, the scores are summed, and the result determines whether the transaction proceeds.

```typescript
export class FraudDetectionService {
  async checkTransaction(params: {
    userId: bigint;
    amount: number;
    ipAddress: string;
    deviceFingerprint: string;
    email: string;
    cardBIN: string;
  }): Promise<FraudCheckResult> {
    let riskScore = 0;
    const triggeredRules: string[] = [];

    // === Rule 1: IP-Country Mismatch (30 points) ===
    const ipCountry = await this.getCountryFromIP(params.ipAddress);
    const billingCountry = await this.getBillingCountry(params.userId);
    if (ipCountry !== billingCountry) {
      riskScore += 30;
      triggeredRules.push('ip_country_mismatch');
    }

    // === Rule 2: Velocity Check (40 points) ===
    const recentBookings = await this.getRecentBookings(params.userId, 60);
    if (recentBookings.length >= 5) {
      riskScore += 40;
      triggeredRules.push('high_velocity');
    }

    // === Rule 3: Amount Threshold (45 points) ===
    if (params.amount > 5000) {
      riskScore += 45;
      triggeredRules.push('high_amount');
    }

    // === Rule 4: Device Reputation ===
    const deviceRisk = await this.checkDeviceReputation(params.deviceFingerprint);
    riskScore += deviceRisk.score;
    if (deviceRisk.score > 0) triggeredRules.push('device_risk');

    // === Rule 5: Email Reputation ===
    const emailRisk = await this.checkEmailReputation(params.email);
    riskScore += emailRisk.score;
    if (emailRisk.score > 0) triggeredRules.push('email_risk');

    // === Rule 6: BIN Lookup ===
    const binRisk = await this.checkCardBIN(params.cardBIN);
    riskScore += binRisk.score;
    if (binRisk.score > 0) triggeredRules.push('bin_risk');

    // === Determine Status ===
    let status: FraudStatus;
    if (riskScore >= 80) status = 'blocked';
    else if (riskScore >= 50) status = 'under_review';
    else if (riskScore >= 25) status = 'flagged';
    else status = 'passed';

    // === Persist the Fraud Check Record ===
    await this.saveFraudCheck({
      userId: params.userId,
      riskScore,
      triggeredRules,
      status,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    // === Alert the Fraud Team for High-Risk Transactions ===
    if (status === 'blocked' || status === 'under_review') {
      await this.alertFraudTeam(params.userId, riskScore, triggeredRules);
    }

    return {
      status,
      riskScore,
      triggeredRules,
      canProceed: status !== 'blocked'
    };
  }
}
```

Two important steps happen after the score is calculated:

1. **Every fraud check is saved to the database** — even the ones that pass. This creates an audit trail. When you get a chargeback three months later, you can look up exactly what signals were present at the time of the transaction.

2. **High-risk transactions trigger an alert.** For `blocked` and `under_review` statuses, the fraud team gets notified (via Slack, email, or a dashboard). For `under_review`, a human analyst makes the final call.

---

## The Database: What We Record and Why

The fraud detection system stores its data in two tables. Let us look at each one.

### The `fraud_checks` Table

Every transaction that hits the fraud pipeline gets a row in this table — even clean transactions.

```sql
CREATE TABLE fraud_checks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    booking_id BIGINT,

    risk_score SMALLINT NOT NULL,             -- The computed score (0-200+)
    status ENUM('passed', 'flagged',
                'under_review', 'blocked') NOT NULL,
    triggered_rules JSON NOT NULL,            -- ["ip_country_mismatch", "high_velocity"]

    ip_address VARCHAR(45),                   -- IPv4 or IPv6 (IPv6 can be 45 chars)
    user_agent TEXT,                           -- Browser/device info
    device_fingerprint VARCHAR(64),           -- SHA-256 hash of device attributes

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,               -- When a human reviewed it (if applicable)
    reviewed_by BIGINT,                       -- Which analyst reviewed it
    review_notes TEXT,                         -- Analyst's notes

    INDEX idx_user (user_id, created_at),     -- Find all checks for a user
    INDEX idx_status (status, created_at),    -- Find all pending reviews
    INDEX idx_score (risk_score)              -- Find highest-risk transactions
);
```

Notice the indexes. They are not random. Each one supports a specific fraud team workflow:

- **`idx_user`**: "Show me all fraud checks for user U-881, newest first." This is what you query when investigating a specific account.
- **`idx_status`**: "Show me all `under_review` transactions, oldest first." This is the analyst's work queue.
- **`idx_score`**: "Show me the highest-risk transactions across all users." This is the dashboard view.

### The `device_fingerprints` Table

This table builds a reputation history for devices over time.

```sql
CREATE TABLE device_fingerprints (
    fingerprint_hash VARCHAR(64) PRIMARY KEY,        -- SHA-256 of device attributes
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
    seen_count INT DEFAULT 1,                         -- How many times we have seen this device
    associated_users JSON,                            -- ["U-881", "U-992", "U-1103"]
    risk_level ENUM('low', 'medium', 'high') DEFAULT 'low',

    INDEX idx_risk (risk_level)
);
```

The `associated_users` field is the key. If a single device fingerprint is associated with 50 different user accounts, that is a strong fraud signal. Legitimate users do not share devices at that scale. Card-testing bots do.

> **What If You Skip This?** Without fraud detection, your platform becomes a magnet for card testing. Fraudsters share lists of "easy" targets — platforms with no velocity checks, no BIN validation, no device fingerprinting. Once you are on that list, you will see hundreds of fraudulent transactions per day, each one generating a chargeback fee ($15-$100 per chargeback depending on your payment processor). The financial losses can be significant, but the real damage is to your reputation with payment processors. Get too many chargebacks and your processor will drop you entirely.

---

## Where Does Fraud Detection Fit in the Booking Flow?

Fraud detection runs *before* payment processing. Here is where it sits in the flow you learned in Chapters 3 and 4:

```
1. User clicks "Book Now"
2. API Gateway validates request format and JWT
3. Booking Service receives the request
4. Inventory Service reserves the room (temporary hold)
5. >>> FRAUD DETECTION runs here <<<
6. If blocked: release inventory, reject booking
7. If passed/flagged: proceed to Payment Service
8. Payment Service charges the card
9. Booking confirmed
```

If the fraud check blocks the transaction, we release the inventory hold and return an error to the user. We never charge a card that fails fraud detection. This ordering is critical — charging first and fraud-checking later means you have to refund blocked transactions, which costs money and creates a poor customer experience.

---

## Chapter 28 Summary

| Concept | One-Sentence Summary |
|---|---|
| Card Testing | Fraudsters test stolen card numbers against your API to find valid ones. |
| Velocity Check | Count actions per time window; bots move faster than humans. |
| IP-Country Mismatch | Compare the request's origin country to the user's billing country. |
| BIN Lookup | Verify the card's issuing bank and country match the user's profile. |
| Device Fingerprinting | Track unique browser/device attributes to identify repeat offenders. |
| Risk Scoring | Combine multiple weak signals into a single confidence score. |
| Thresholds | Use score ranges (passed/flagged/under_review/blocked) instead of binary decisions. |
| Audit Trail | Record every fraud check, even clean ones, for chargeback investigations. |
| Pipeline Placement | Run fraud detection after inventory hold but before payment processing. |

> **Checkpoint:** Can you explain the difference between input validation and fraud detection? Here is the test: input validation checks whether the data is *correctly formatted*. Fraud detection checks whether the *behavior is suspicious*. A perfectly formatted booking request with a valid card, valid dates, and a valid currency can still be fraudulent. If you can articulate this distinction — and explain why velocity checks catch what input validation cannot — you are ready for Chapter 29.

---

---

# Chapter 29: GDPR & Data Privacy — The Law Meets Code

## It Is Not Just a Cookie Banner

If you have heard of GDPR, you probably think it means showing a cookie consent popup on your website. That popup is the tip of the iceberg — the part the user sees. Underneath, GDPR imposes deep, structural requirements on how you store, process, and delete personal data in your backend systems.

GDPR (General Data Protection Regulation) is a European Union law, but it applies to any company that processes data of EU residents — regardless of where the company is based. If a user in Berlin books a hotel through your platform, and your servers are in Ohio, GDPR still applies to you. Violations carry fines up to 4% of global annual revenue — not profit, revenue.

Let that sink in. For a company making $100 million per year, that is a potential $4 million fine. Per incident.

This chapter is not legal advice. But it is an engineering guide to the backend systems you need to build to comply with GDPR's most technically demanding requirements.

---

## What GDPR Actually Requires From Your Backend

GDPR gives users specific rights over their personal data. Three of these rights have major backend implications:

### 1. Right to Erasure ("Right to Be Forgotten")

A user can request that you delete all their personal data. Not anonymize it. Not archive it. Delete it. You have 30 days to comply.

In a monolith with one database, this is straightforward: `DELETE FROM users WHERE id = 42`. In a microservices system with data spread across MySQL, Redis, Elasticsearch, and Kafka topics? This is an engineering project.

### 2. Right to Data Portability

A user can request a copy of all their personal data in a machine-readable format (like JSON or CSV). You must provide it. This means you need to know exactly where a user's data lives across all your services and databases.

### 3. Consent Management

You must track what the user consented to (marketing emails? data analytics? third-party sharing?), when they consented, and allow them to withdraw consent at any time. "Consent" is not a boolean flag. It is a timestamped, categorized, auditable record.

> **Key Term:** **PII (Personally Identifiable Information)** — Any data that can identify a specific person: name, email, phone number, IP address, device fingerprint, and even booking history (because patterns of travel can identify someone). GDPR requires you to protect all PII and delete it on request.

---

## The Hardest Part: Right to Erasure

Let us be honest: deletion in a distributed system is hard. Your user's data is not in one place. It is in:

- **MySQL** — user profile, bookings, payment records, fraud checks
- **Redis** — sessions, cached search results, rate limiter counters
- **Elasticsearch** — indexed booking data, search history
- **Kafka** — event logs containing user actions

You need to find and delete (or anonymize) personal data in all of these systems. Miss one, and you are non-compliant.

> **Analogy:** Deleting a user's data from a microservices system is like removing someone from a group photo that has been printed, framed, photocopied, emailed, posted on social media, and backed up to three cloud drives. You cannot just delete the original photo — you have to track down every copy. That is what data erasure feels like across MySQL, Redis, Elasticsearch, and Kafka.

---

## The Deletion Flow: Step by Step

Here is the `GDPRService` class that handles user data deletion. We will walk through every section.

```typescript
export class GDPRService {
  async deleteUserData(
    userId: bigint,
    email: string
  ): Promise<DeletionResult> {
    const connection = await db.getConnection();
    const deletedTables: string[] = [];

    try {
      await connection.beginTransaction();

      // === Step 1: Create an Audit Record ===
      const [reqResult] = await connection.execute(`
        INSERT INTO gdpr_deletion_requests (user_id, email_hash, status)
        VALUES (?, ?, 'processing')
      `, [userId, this.hashPII(email, 'email')]);

      const requestId = reqResult.insertId;
```

Before deleting anything, we create an audit record. This might seem paradoxical — "you're storing data about deleting data?" — but it is a legal requirement. You must be able to prove that you processed the deletion request. Notice that we store the `email_hash`, not the raw email. The user asked us to delete their data, so we cannot keep the email itself, but we keep a hash so we can verify the deletion was completed.

```typescript
      // === Step 2: Delete Device Fingerprints ===
      await connection.execute(`
        DELETE FROM device_fingerprints
        WHERE fingerprint_hash IN (
          SELECT DISTINCT device_fingerprint
          FROM fraud_checks WHERE user_id = ?
        )
      `, [userId]);
      deletedTables.push('device_fingerprints');
```

Device fingerprints associated with the user are fully deleted — not anonymized, deleted. This is because device fingerprints are PII (they can be linked back to the user).

```typescript
      // === Step 3: Anonymize Fraud Records ===
      await connection.execute(`
        UPDATE fraud_checks
        SET ip_address = '0.0.0.0',
            user_agent = 'ANONYMIZED',
            device_fingerprint = 'DELETED'
        WHERE user_id = ?
      `, [userId]);
      deletedTables.push('fraud_checks');
```

Here is where it gets nuanced. We do not delete fraud records entirely — we **anonymize** them. Why? Because aggregate fraud data ("what percentage of transactions from IP range X are fraudulent?") has legitimate business value that is not tied to the individual. GDPR allows you to retain anonymized data that cannot be linked back to a person. We replace the IP address with `0.0.0.0`, the user agent with `ANONYMIZED`, and the device fingerprint with `DELETED`. The risk score and triggered rules remain — they are statistical, not personal.

> **Key Term:** **Data Anonymization** — Transforming personal data so that the individual is no longer identifiable. Anonymized data falls outside GDPR's scope because it is no longer "personal data." The test: can you, or anyone, use this data to figure out who the person is? If yes, it is not truly anonymized.

```typescript
      // === Step 4: Soft-Delete Bookings ===
      await connection.execute(`
        UPDATE bookings
        SET deleted_at = NOW()
        WHERE user_id = ? AND deleted_at IS NULL
      `, [userId]);
      deletedTables.push('bookings');
```

Bookings are **soft-deleted** (marked with a `deleted_at` timestamp) rather than hard-deleted. Why? Because financial and tax regulations in most countries require you to retain transaction records for 5-7 years. This creates a conflict: GDPR says "delete my data" but tax law says "keep the receipt for 7 years." The resolution is that GDPR includes exceptions for legal obligations. You can retain booking records for accounting compliance, but you must remove the PII (name, email) from them and keep only the financial data (amounts, dates, tax IDs).

> **What If You Skip This?** If you fully delete booking records to comply with GDPR, you may violate tax and accounting regulations. If you keep booking records with PII to comply with tax law, you violate GDPR. The solution is anonymization: keep the financial facts, strip the personal identity. This is not a theoretical problem — companies have been fined for errors in both directions.

---

## Cleaning Redis: Why `KEYS` Will Get You Fired

Your user has sessions stored in Redis. You need to find and delete them. Your first instinct might be:

```typescript
// DO NOT DO THIS
const keys = await redis.keys(`session:*`);
// filter for this user, then delete
```

This will work in development. It will cause a production outage.

The `KEYS` command scans every single key in Redis in a single operation. If Redis has 10 million keys, this command blocks the Redis server for seconds — during which no other operation can run. Every service that depends on Redis (sessions, caching, rate limiting, distributed locks) is frozen. Your entire platform hangs.

The correct approach is `SCAN`, which iterates through keys in small batches:

```typescript
      // === Step 5: Clear User Sessions from Redis ===
      // Using SCAN — processes keys in small batches, never blocks Redis
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(
          cursor,      // Current position in the keyspace
          'MATCH',     // Filter pattern
          'session:*', // Only look at session keys
          'COUNT',     // Batch size hint
          100          // Process ~100 keys per iteration
        );
        cursor = nextCursor;

        for (const key of keys) {
          const session = await redis.get(key);
          if (session) {
            const parsed = JSON.parse(session);
            if (parsed.userId === userId.toString()) {
              await redis.del(key);
            }
          }
        }
      } while (cursor !== '0');
      // When cursor returns to '0', we have scanned the entire keyspace
```

Let us break down how `SCAN` works:

1. **You start with cursor `'0'`**, meaning "start from the beginning."
2. **Redis returns two things**: a new cursor position and a batch of matching keys. The batch contains approximately `COUNT` keys (100 in our case), but this is a hint, not a guarantee.
3. **You process the batch**: for each session key, check if it belongs to the target user and delete it.
4. **You call SCAN again with the new cursor**, getting the next batch.
5. **When the cursor returns to `'0'`**, you have completed a full scan.

The critical difference: `KEYS` blocks Redis for the entire scan. `SCAN` yields control back to Redis between batches, so other operations continue normally. It takes longer overall, but it does not freeze your system.

> **Key Term:** **SCAN vs. KEYS** — Redis's `KEYS` command retrieves all matching keys in one blocking call. At scale, this blocks the Redis server for seconds or more. `SCAN` iterates in non-blocking batches. In production, always use `SCAN`. Treat `KEYS` as a development-only command.

---

## Cleaning Elasticsearch

Your user's booking data is also indexed in Elasticsearch for the search feature. You need to remove it:

```typescript
// Delete user's data from Elasticsearch
await elasticsearchClient.deleteByQuery({
  index: 'bookings',
  body: {
    query: {
      term: { user_id: userId.toString() }
    }
  }
});
```

Elasticsearch's `deleteByQuery` is designed for this use case. Unlike Redis, it handles bulk deletion efficiently without blocking the cluster.

---

## Handling Kafka: The Immutable Log Problem

Kafka is an append-only log. Once an event is published, you cannot delete it. This seems like an impossible contradiction with GDPR's right to erasure. How do you delete data from a system that is designed to never delete data?

There are three approaches:

### 1. Kafka Topic Retention

Set Kafka topics to automatically delete messages after a certain period (for example, 30 days). After retention expires, the data is gone.

```
# kafka topic configuration
retention.ms=2592000000   # 30 days in milliseconds
```

This is the simplest approach but imprecise — you cannot delete one user's events without deleting everyone's events from that time period.

### 2. Crypto Shredding

Encrypt each user's events with a per-user encryption key. When the user requests deletion, you delete the key. The events are still in Kafka, but they are now indecipherable gibberish — effectively deleted.

> **Key Term:** **Crypto Shredding** — A data deletion technique where data is encrypted with a per-user key, and deletion is achieved by destroying the key rather than the data itself. The encrypted data remains but is permanently indecipherable without the key, making it effectively deleted. This is particularly useful for immutable logs like Kafka where direct deletion is impossible.

### 3. Tombstone Events

Publish a special "deletion" event for the user. Consumers that process this event remove the user's data from their local stores. The original events remain in Kafka but become stale — no downstream system acts on them after the tombstone.

> **Analogy:** Imagine Kafka is a newspaper archive. You cannot go back and remove an article from last month's papers. But you can (1) set the library to shred papers older than 30 days (retention), (2) print the article in a cipher and then destroy the decoder ring (crypto shredding), or (3) publish a correction in today's paper telling everyone to disregard the original article (tombstone).

---

## Completing the Deletion and Audit

After cleaning all data stores, we finalize the audit record:

```typescript
      // === Step 6: Mark Deletion as Complete ===
      await connection.execute(`
        UPDATE gdpr_deletion_requests
        SET processed_at = NOW(),
            status = 'completed',
            deleted_tables = ?
        WHERE id = ?
      `, [JSON.stringify(deletedTables), requestId]);

      await connection.commit();

      return { success: true, deletedTables, requestId };

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
```

If any step fails, the entire transaction rolls back, and the status remains `processing`. This means you can retry the deletion without risking partial state — either everything is deleted or nothing is. The `deletedTables` array records exactly which tables were cleaned, providing a complete audit trail for compliance reviews.

### PII Hashing

Throughout the deletion process, we reference a `hashPII` helper. Here is how it works:

```typescript
  private hashPII(data: string, category: string): string {
    const salt = process.env.PII_SALT;
    if (!salt) {
      throw new Error('PII_SALT environment variable is required for GDPR hashing');
    }
    return createHash('sha256')
      .update(`${category}:${salt}:${data.toLowerCase()}`)
      .digest('hex');
  }
}
```

This function creates a one-way hash of personal data. The hash includes:
- **The data itself** (the email address, lowercased for consistency)
- **A category prefix** (`email`, `phone`, etc.) to prevent different data types from producing the same hash
- **A salt** (a secret random string) to prevent rainbow table attacks — precomputed tables that map common emails to their SHA-256 hashes

The hash is one-way: you cannot recover the original email from it. But if someone claims "I requested deletion and you did not do it," you can hash the email they provide and look it up in the `gdpr_deletion_requests` table. If a `completed` record exists with that hash, you have proof of compliance.

---

## The GDPR Deletion Request Table

Every deletion request — pending, in-progress, completed, or failed — lives in this table.

```sql
CREATE TABLE gdpr_deletion_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    email_hash VARCHAR(64) NOT NULL,        -- SHA-256 hash, not the raw email

    status ENUM('pending', 'processing',
                'completed', 'failed') DEFAULT 'pending',

    deleted_tables JSON,                     -- ["device_fingerprints", "fraud_checks", ...]
    error_message TEXT,                      -- If status is 'failed', why

    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,            -- When we finished (or failed)

    INDEX idx_user (user_id),               -- Find requests for a specific user
    INDEX idx_status (status)               -- Find all pending/failed requests
);
```

Two index choices worth noting:

- **`idx_status`** supports a daily reconciliation job that checks for `failed` or `pending` requests that have aged out. If a deletion request has been `pending` for more than 24 hours, something went wrong — the job alerts the engineering team.
- **`idx_user`** lets you quickly answer regulation inquiries: "Did we process the deletion request for user U-881?" One query, sub-millisecond response.

---

## Data Retention Policies: What You Keep and For How Long

GDPR does not say "delete everything." It says "do not keep personal data longer than necessary." Different categories of data have different retention requirements, often driven by other regulations:

| Data Category | Retention Period | Reason | What Happens After |
|---|---|---|---|
| User profile | Until deletion request | GDPR right to erasure | Full deletion |
| Active session tokens | 24 hours | Security best practice | Auto-expire in Redis |
| Booking records | 7 years (anonymized) | Tax/accounting law | PII stripped, financials kept |
| Payment transaction logs | 7 years | Financial regulations | Stored with masked card numbers |
| Fraud check records | 2 years (anonymized) | Fraud pattern analysis | PII wiped, scores kept |
| Server access logs | 90 days | Security monitoring | Auto-rotated, then deleted |
| Search history | 30 days | UX personalization | Deleted or anonymized |
| Kafka events | 30 days | Event replay capability | Auto-deleted by retention policy |

The key insight: retention is not one policy. It is a matrix. Each data category has its own requirements, often dictated by different regulations (GDPR, tax law, PCI-DSS for payment data). Your engineering team and legal team must agree on this matrix before you write any deletion code.

---

## Consent Management: More Than a Boolean

Consent is not a single `acceptedTerms: true` flag. Under GDPR, consent must be:

- **Specific**: "I consent to receiving marketing emails" is different from "I consent to data analytics"
- **Informed**: The user must understand what they are consenting to
- **Freely given**: Not bundled with the service ("consent to marketing or you cannot book")
- **Withdrawable**: The user can change their mind at any time

In your backend, this means a consent table with categories, timestamps, and history:

```typescript
interface UserConsent {
  userId: bigint;
  category: 'marketing_email' | 'analytics' | 'third_party_sharing' | 'personalization';
  granted: boolean;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  ipAddress: string;       // Where consent was given (proof of intent)
  consentVersion: string;  // Which version of the privacy policy they agreed to
}
```

Every time a user toggles a consent switch in your UI, you create a new record (not update an existing one). This creates an immutable history: "User U-881 consented to marketing emails on 2025-03-15, then withdrew consent on 2025-06-22, then re-consented on 2025-09-01." Auditors want to see this timeline.

> **What If You Skip This?** If a user complains to a Data Protection Authority that they never consented to marketing emails, and you cannot produce a timestamped consent record proving otherwise, you are liable. "We had a checkbox on the signup form" is not enough — you need to prove *this specific user* checked *this specific checkbox* at *this specific time*.

---

## Putting It All Together: The GDPR Compliance Checklist

| Requirement | Implementation | Where in Our System |
|---|---|---|
| Right to Erasure | `GDPRService.deleteUserData()` | MySQL, Redis (SCAN), Elasticsearch, Kafka (retention/tombstone) |
| Right to Data Portability | Export endpoint returning JSON of all user data | `/api/users/:id/export` |
| Consent Management | Per-category consent records with timestamps | `user_consents` table |
| Data Minimization | Only collect what you need | Schema design reviews |
| Breach Notification | Alert within 72 hours | Monitoring + incident playbook |
| Privacy by Design | Encryption at rest, PII hashing | SecretManager, `hashPII()` |
| Data Retention | Automated cleanup jobs per category | Cron jobs + retention matrix |
| Audit Trail | Deletion request logs, consent history | `gdpr_deletion_requests` table |

---

## Chapter 29 Summary

| Concept | One-Sentence Summary |
|---|---|
| GDPR Scope | Applies to any company processing EU residents' data, regardless of server location. |
| Right to Erasure | Users can demand full deletion of their personal data within 30 days. |
| Data Portability | Users can request a machine-readable export of all their personal data. |
| Anonymization vs. Deletion | Anonymized data (no PII) can be retained; only truly anonymized data is outside GDPR scope. |
| SCAN vs. KEYS | Use Redis SCAN for production key iteration; KEYS blocks the server and causes outages. |
| Kafka Data Deletion | Use retention policies, crypto shredding, or tombstone events — Kafka does not support direct deletion. |
| PII Hashing | One-way hash with salt to prove compliance without retaining the original personal data. |
| Soft-Delete for Legal Requirements | Some records (bookings, payments) must be retained for tax law; strip PII but keep financials. |
| Consent Management | Track per-category, timestamped, versioned consent records — not a single boolean. |
| Retention Matrix | Different data categories have different retention periods driven by different regulations. |

> **Checkpoint:** Can you explain why deleting a user from a distributed system is harder than `DELETE FROM users WHERE id = 42`? Try listing at least four data stores you would need to clean (hint: MySQL, Redis, Elasticsearch, Kafka). Can you explain the difference between `KEYS` and `SCAN` in Redis, and why using the wrong one could take your entire platform offline? Finally, can you explain why we anonymize fraud records instead of deleting them? If you can answer all three, you understand the engineering reality of GDPR compliance. Welcome to the intersection of law and code.
