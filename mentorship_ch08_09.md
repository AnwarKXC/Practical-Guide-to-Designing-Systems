# Part 2: The Booking Flow

---

# Chapter 8: API Gateway — The Front Door

## Starting from What You Know

In your Express applications, you probably have a single `server.ts` file that wires up all your routes. Maybe it looks something like this:

```typescript
// Your typical Express app
const app = express();
app.use(cors());
app.use(express.json());
app.use(authMiddleware);

app.use('/api/users', userRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);

app.listen(3000);
```

One server, one process, one port. Every request comes in through the same door, and your middleware stack runs top to bottom before hitting the route handler. Simple. Predictable. You can reason about the entire request lifecycle by reading one file.

Now imagine you have split that monolith into four separate services, each running on its own port, its own machine, maybe even its own data center. The Booking Service lives at `booking-service:3003`. The Payment Service lives at `payment-service:3005`. The Search Service lives at `search-service:3002`. The Auth Service lives at `auth-service:3001`.

Here is the question that should immediately bother you: **who does the client talk to?**

Does the browser send requests directly to each service? Does your React frontend need to know about four different URLs? What happens when you add a fifth service -- does every client need an update?

The answer to all of these is no. That is what an API Gateway solves.

---

## What Is an API Gateway?

An API Gateway is a single server that sits between the outside world and all of your internal microservices. Every request from every client -- browser, mobile app, third-party integration -- hits the gateway first. The gateway decides where to route it, applies security policies, and forwards it to the right service.

> **Analogy:** Imagine a large corporate office building. There is one front door. Behind that door sits a receptionist. You do not walk through the building trying random doors until you find the accounting department. You tell the receptionist, "I have a meeting with accounting," and they check your ID badge, log your visit, and direct you to the third floor. If you do not have a badge, you do not get past the desk. If you show up too many times in one hour, the receptionist politely asks you to slow down. The receptionist never *does* accounting -- they just make sure the right people reach the right department safely.
>
> Your API Gateway is that receptionist. It never books a hotel or charges a credit card. It routes, validates, rate-limits, and protects. Every cross-cutting concern that would otherwise need to be duplicated across every service lives here instead.

> **Key Term:** **API Gateway** — A server that acts as the single entry point for all client requests to a microservices architecture. It handles cross-cutting concerns like routing, authentication, rate limiting, and TLS termination so individual services do not have to.

---

## Why You Cannot Just Expose Services Directly

You might be thinking, "Can't I just give the client the URL for each service? My React app already knows how to call different endpoints." Let us walk through why that breaks down.

### Problem 1: Security Surface Area

Every service you expose to the internet is an attack surface. A payment service exposed directly means attackers can probe its endpoints, attempt brute-force authentication, and exploit any vulnerability. Instead of defending one door, you are defending four, five, or twenty doors. With a gateway, you have exactly one public-facing endpoint. Internal services are invisible to the outside world -- they live inside a private network that the internet cannot reach.

### Problem 2: Cross-Cutting Logic Duplication

Rate limiting. CORS headers. JWT validation. Request logging. Without a gateway, every service implements these independently. Service A might rate-limit at 1,000 requests per second; Service B forgets to rate-limit entirely. Service C validates JWTs with library version 2.0; Service D uses version 1.3 with a known vulnerability. Inconsistency is not just messy -- it is dangerous.

### Problem 3: Client Coupling

If the client knows about `booking-service:3003`, what happens when you split the Booking Service into two services -- one for creation and one for management? Every client needs to update its URLs. Every mobile app needs a new release. With a gateway, you change the routing rules in one place, and clients never know the difference.

### Problem 4: Protocol Translation

Your clients speak HTTPS. Your internal services might speak plain HTTP (because encryption is handled at the gateway), gRPC (for high-performance inter-service calls), or WebSockets (for real-time updates). The gateway translates between what clients speak and what services speak.

> **What If You Skip This?** Without an API Gateway, every microservice becomes a public-facing server. You will duplicate authentication logic across services, forget rate limiting on at least one, and create a maintenance nightmare where changing an internal URL requires coordinating releases across every client application. Teams that skip the gateway almost always end up building one later -- the hard way, after an incident.

---

## TLS Termination -- What Actually Happens with HTTPS

You know that HTTPS means "encrypted." You have probably set up an SSL certificate with Let's Encrypt. But what actually happens under the hood, and why does the gateway handle it?

When your browser connects to `https://api.bookingplatform.com`, here is the sequence:

1. **The browser sends a "Client Hello"** -- it tells the server which encryption algorithms it supports.
2. **The server sends its TLS certificate** -- a file that proves "I am really api.bookingplatform.com." The certificate is signed by a Certificate Authority (like Let's Encrypt) that the browser trusts.
3. **The browser verifies the certificate** -- checks the signature, checks the expiration date, checks that the domain matches.
4. **Both sides negotiate a session key** -- a shared secret used to encrypt all subsequent traffic. This negotiation uses asymmetric cryptography (public/private keys) to securely exchange the symmetric key.
5. **All traffic is now encrypted** -- every request and response is scrambled so nobody between the browser and server can read it.

This process is called the **TLS handshake**, and it adds 1-2 round trips of latency to every new connection.

> **Key Term:** **TLS Termination** — The practice of decrypting HTTPS traffic at the gateway so that internal service-to-service communication can use plain HTTP. The gateway holds the TLS certificate and handles the computationally expensive encryption/decryption so individual services do not have to.

Here is why the gateway handles TLS termination instead of each service:

- **Performance.** TLS encryption and decryption uses CPU. Doing it once at the gateway is cheaper than doing it at every service.
- **Certificate management.** You manage one certificate in one place, not one per service. When it expires or needs rotation, you update it once.
- **Internal trust.** Inside your Kubernetes cluster, traffic flows over a private network. Services trust each other because the network itself is isolated. Adding TLS between internal services is sometimes done (via mTLS, which we cover in Chapter 9), but it is a separate concern from client-facing HTTPS.

```
Browser ── HTTPS (encrypted) ──> API Gateway ── HTTP (plain) ──> Booking Service
                                     ^
                          TLS certificate lives here.
                          Decrypts incoming, encrypts outgoing.
                          Internal services never touch TLS.
```

> **Analogy:** Think of an armored truck delivering cash to a bank. The cash is locked in a vault during transit (TLS encryption over the internet). When the truck arrives at the bank's loading dock (the API Gateway), the vault is opened in a secure room. From there, the cash moves through the bank's internal corridors without the vault -- because the bank itself is a secure building. TLS termination is opening the vault at the loading dock so the internal staff can work with the contents efficiently.

---

## Kong Gateway Configuration -- Line by Line

Our system uses Kong, a popular open-source API Gateway. Let us walk through the actual configuration file. If you have never seen a declarative gateway config, do not worry -- it is simpler than it looks.

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
```

Let us break this down block by block.

**The `services` section** defines each backend microservice. Every entry has a `name` (for Kong's internal reference) and a `url` (the actual address of the service inside the Kubernetes cluster). Notice the URLs use Kubernetes DNS names like `booking-service.production.svc.cluster.local` -- not hardcoded IP addresses. We covered why in Chapter 4: pods come and go, IP addresses change, but DNS names stay stable.

**The `routes` section** nested inside each service tells Kong which incoming URL paths should be forwarded to that service. When a request arrives at the gateway for `/api/v1/bookings`, Kong forwards it to the Booking Service. When a request comes in for `/api/v1/search`, it goes to the Search Service. This is the "receptionist directing you to the right department."

**The `methods` array** restricts which HTTP methods are allowed. The Inventory Service only accepts `GET` -- you cannot `POST` to it through the gateway. The Payment Service only accepts `POST`. This is an important security measure: even if an attacker discovers the path, they can only use the methods you explicitly allow.

**The `strip_path` setting** controls whether Kong removes the matched path prefix before forwarding. When set to `false`, the Booking Service receives the full path `/api/v1/bookings`. If it were `true`, Kong would strip `/api/v1/bookings` and forward just `/`. We keep it `false` so services can use the full path for their own routing logic.

Think of it like your Express `app.use('/api', router)` -- the router either sees `/api/users` or just `/users` depending on how you mount it. Same concept.

---

## Plugins -- The Middleware of the Gateway World

In Express, you add behavior with middleware: `app.use(cors())`, `app.use(helmet())`, `app.use(rateLimit())`. In Kong, the equivalent is **plugins**. Plugins are middleware that runs on every request passing through the gateway.

### CORS -- Letting Browsers Talk to Your API

```yaml
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
```

You have probably fought with CORS errors before. "Access to XMLHttpRequest at ... has been blocked by CORS policy." Sound familiar?

CORS (Cross-Origin Resource Sharing) is a browser security mechanism. When your React app at `https://www.bookingplatform.com` tries to call your API at `https://api.bookingplatform.com`, the browser says, "Wait, those are different origins. Let me ask the API if it is okay with this." The browser sends a preflight `OPTIONS` request, and the server must respond with headers saying, "Yes, allow requests from that origin."

In this config:

- **`origins`** lists the domains allowed to call our API. Only our official web app and our mobile-web app. Random websites cannot call our endpoints from the browser.
- **`headers`** lists which custom headers clients can send. `Authorization` carries the JWT. `Idempotency-Key` prevents duplicate payments (we cover this in the payment chapters). `X-Request-ID` tracks requests across services for debugging.
- **`max_age: 3600`** tells the browser, "Cache this permission for one hour. Do not send a preflight request for every single API call."
- **`credentials: true`** allows the browser to send cookies along with requests. This matters for session-based auth scenarios.

> **Key Term:** **CORS (Cross-Origin Resource Sharing)** — A browser security policy that restricts web pages from making requests to a different domain than the one that served the page. The server must explicitly opt in by sending the correct response headers.

### Request Transformation -- Adding Gateway Metadata

```yaml
  - name: request-transformer
    config:
      add:
        headers:
          - "X-Gateway-Region:us-east-1"
          - "X-Gateway-Timestamp:$(date +%s)"
```

This plugin adds headers to every request *before* forwarding it to the downstream service. The service receiving the request can read `X-Gateway-Region` to know which gateway region handled it -- useful when you run gateways in multiple data centers. `X-Gateway-Timestamp` records when the request entered the gateway, which helps with latency debugging.

In Express terms, this is equivalent to:

```typescript
app.use((req, res, next) => {
  req.headers['x-gateway-region'] = 'us-east-1';
  req.headers['x-gateway-timestamp'] = Date.now().toString();
  next();
});
```

### Response Security Headers -- Hardening the Outgoing Response

```yaml
  - name: response-transformer
    config:
      add:
        headers:
          - "Strict-Transport-Security:max-age=31536000; includeSubDomains"
          - "X-Content-Type-Options:nosniff"
          - "X-Frame-Options:DENY"
          - "Content-Security-Policy:default-src 'self'"
```

These headers protect your users against common web attacks. Let us go through each one:

- **`Strict-Transport-Security`** (HSTS) tells the browser, "For the next year (31,536,000 seconds), only connect to this domain over HTTPS. Even if the user types `http://`, upgrade it automatically." This prevents downgrade attacks where an attacker tricks the browser into using unencrypted HTTP.
- **`X-Content-Type-Options: nosniff`** tells the browser, "Trust the `Content-Type` header I send. Do not try to guess (sniff) the content type yourself." Without this, a browser might interpret a JSON response as HTML, opening the door to XSS attacks.
- **`X-Frame-Options: DENY`** tells the browser, "Do not allow this page to be embedded inside an `<iframe>`." This prevents clickjacking attacks where a malicious site overlays an invisible frame of your app and tricks users into clicking buttons they did not intend to click.
- **`Content-Security-Policy`** restricts where the browser can load resources from. `default-src 'self'` means "only load scripts, styles, and images from our own domain." This is a powerful defense against XSS injection.

If you have ever used the `helmet` npm package in Express, these are the same headers that `helmet()` adds by default. Kong just handles them at the gateway level so every service benefits automatically.

---

## Health Check Endpoints -- How Kubernetes Knows You Are Alive

When you run an Express app on your laptop, you know it is working because you can see the console output. In production with Kubernetes, your service is one of dozens of containers running across multiple machines. Kubernetes needs a way to ask each container, "Are you alive? Can you take traffic?"

That is what health check endpoints are for.

```typescript
// Every service exposes standardized health endpoints

// Liveness: Is the process alive?
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: Can the service accept traffic?
app.get('/ready', async (req, res) => {
  try {
    await db.query('SELECT 1');       // Can we reach the database?
    await redis.ping();               // Can we reach Redis?
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});
```

There are two distinct probes, and the difference matters:

**Liveness probe (`/health`)**: Kubernetes asks, "Is this process alive and not deadlocked?" If this endpoint stops responding, Kubernetes kills the container and starts a new one. It is a heartbeat check. Notice how simple it is -- just return `200 OK`. You do not check databases or external dependencies here. Why? Because if your database is down, restarting your application will not fix the database. You would enter a crash loop where Kubernetes keeps restarting a perfectly healthy process because its database happens to be offline.

**Readiness probe (`/ready`)**: Kubernetes asks, "Can this container accept traffic right now?" This endpoint checks whether the service can actually do its job -- can it reach the database? Can it reach Redis? If `/ready` returns `503`, Kubernetes stops sending traffic to that container but does *not* kill it. It just removes it from the load balancer temporarily. When the database comes back and `/ready` returns `200` again, Kubernetes resumes sending traffic.

> **Analogy:** A liveness check is asking, "Is Terry still breathing?" If no, call an ambulance (restart the container). A readiness check is asking, "Can Terry take customer calls right now?" If Terry is alive but in the middle of a system update and cannot access his tools, do not send customers to Terry. Send them to his colleagues instead. When Terry finishes the update, route customers back to him.

> **What If You Skip This?** Without health checks, Kubernetes cannot distinguish between a crashed service and a healthy one that is temporarily overloaded. It will either send traffic to dead containers (users get errors) or blindly restart containers that just need a moment to reconnect to their database (causing more disruption). Health checks are not optional in production Kubernetes deployments.

---

## Rate Limiting -- Protecting the Gateway

In your Express app, you might have used the `express-rate-limit` package:

```typescript
// What you might have in Express
import rateLimit from 'express-rate-limit';

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 100,                   // limit each IP to 100 requests per window
}));
```

At the gateway level, rate limiting does the same thing but for the *entire system*. Kong and similar gateways offer rate limiting as a built-in plugin. The configuration typically specifies limits per client, per route, or both.

Why does rate limiting matter in a microservices architecture specifically? Because without it, a single misbehaving client can overwhelm your entire platform. One user running a script that hammers your search API sends thousands of requests per second. Those requests flow through the gateway to the Search Service, which queries Elasticsearch, which consumes CPU and memory. The Search Service slows down. Other users' searches start timing out. The misbehaving client has effectively performed a denial-of-service attack -- possibly unintentionally.

Rate limiting at the gateway catches this at the front door. The overactive client gets a `429 Too Many Requests` response, and legitimate users never feel the impact.

> **Key Term:** **Rate Limiting** — Restricting the number of requests a client can make within a time window. At the gateway level, this protects all downstream services from traffic spikes, abuse, and denial-of-service attacks.

---

## Putting It All Together: A Request Through the Gateway

Let us trace a single request through every layer of the gateway to make this concrete.

```
1. Browser sends: POST https://api.bookingplatform.com/api/v1/bookings
   Headers: Authorization: Bearer eyJhbG..., Content-Type: application/json
   Body: { "hotelId": "TOKYO-042", "checkIn": "2026-03-15", ... }

2. TLS TERMINATION
   The gateway decrypts the HTTPS request using its TLS certificate.
   From this point on, internal traffic is plain HTTP.

3. CORS CHECK
   Is the request origin in the allowed list? If yes, proceed.
   If no, return 403 Forbidden.

4. RATE LIMIT CHECK
   Has this client exceeded 1,000 requests/second?
   If yes, return 429 Too Many Requests.
   If no, proceed.

5. REQUEST TRANSFORMATION
   Gateway adds X-Gateway-Region and X-Gateway-Timestamp headers.

6. ROUTE MATCHING
   Path /api/v1/bookings matches the booking-service route.
   Method POST is in the allowed methods list.

7. FORWARD TO SERVICE
   Gateway sends the request (now plain HTTP, with added headers)
   to http://booking-service.production.svc.cluster.local:3000/api/v1/bookings

8. RESPONSE TRANSFORMATION
   When the Booking Service responds, the gateway adds security headers
   (HSTS, X-Frame-Options, CSP, etc.) to the response.

9. TLS ENCRYPTION
   The gateway encrypts the response and sends it back to the browser
   over HTTPS.
```

Every request goes through this exact pipeline. Every single one. That is the power of centralizing cross-cutting concerns: you configure them once, and they apply everywhere.

---

## Chapter 8 Summary

| Concept | One-Sentence Summary |
|---|---|
| API Gateway | A single entry point that routes client requests to the correct internal service and handles cross-cutting concerns. |
| TLS Termination | Decrypting HTTPS at the gateway so internal services communicate over plain HTTP, reducing certificate management and CPU overhead. |
| Kong Configuration | A declarative YAML file that maps URL paths to backend services, defines allowed HTTP methods, and registers plugins. |
| CORS | A browser security mechanism that requires the server to explicitly allow cross-origin requests via response headers. |
| Request/Response Transformation | Adding metadata headers to requests (region, timestamp) and security headers to responses (HSTS, CSP) at the gateway level. |
| Health Checks | Liveness probes confirm a process is alive; readiness probes confirm it can accept traffic. Kubernetes uses both to manage containers. |
| Rate Limiting | Restricting request volume per client at the gateway to protect all downstream services from abuse or traffic spikes. |
| Security Headers | HTTP response headers (HSTS, X-Frame-Options, CSP, X-Content-Type-Options) that instruct browsers to enforce security policies. |

> **Checkpoint:** Can you explain the difference between a liveness probe and a readiness probe? Imagine your Booking Service is running, but the MySQL database is temporarily unreachable. Which probe should fail? What would Kubernetes do in response? If your answer is "the readiness probe should return 503, and Kubernetes should stop routing traffic to that pod but not restart it," you have internalized the distinction. Now ask yourself: what would happen if you accidentally put the database check in the liveness probe instead? (Answer: Kubernetes would kill and restart the pod in a loop, even though the pod itself is perfectly healthy. That is called a crash loop, and it makes a bad situation worse.)

---

---

# Chapter 9: Authentication & Authorization — The Bouncer

## Starting from What You Know

You have used `bcrypt` to hash passwords. Maybe you have used `passport.js` with a `LocalStrategy` for form-based login. Your middleware probably looked something like this:

```typescript
// Your typical Express auth middleware
app.post('/login', async (req, res) => {
  const user = await db.findUserByEmail(req.body.email);
  const valid = await bcrypt.compare(req.body.password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  // Set a session cookie
  req.session.userId = user.id;
  res.json({ message: 'Logged in' });
});

// Protect routes
function authMiddleware(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

app.get('/api/profile', authMiddleware, (req, res) => { ... });
```

This works in a monolith. The session lives in server memory (or Redis if you are using `connect-redis`). Every request carries a session cookie, the server looks up the session, and you know who the user is.

But in microservices, there is a fundamental problem: **sessions are server-specific**. If the user's login request hits Server A and creates a session, but their next request hits Server B (because the load balancer round-robins), Server B has no idea who they are. You could use sticky sessions (force users to always hit the same server), but that defeats the purpose of load balancing. You could store sessions in Redis (and we do use Redis for session storage), but now every single request to every single service must call Redis to look up the session. At 100,000 requests per minute, that is a lot of Redis round trips.

There is a better way: tokens that carry their own identity. That is JWT.

---

## JWT in Depth -- What Is Actually Inside That Token?

> **Key Term:** **JWT (JSON Web Token)** — A compact, URL-safe token format that encodes a set of claims as a JSON object. The token is digitally signed so the recipient can verify that it was issued by a trusted party and has not been tampered with. JWTs are self-contained -- the server does not need to look up a database or call another service to validate the token, because the claims and signature are all inside the token itself.

A JWT (JSON Web Token) is a string that looks like this:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJVLTg4MSIsImVtYWlsIjoiamFuZUBleGFtcGxlLmNvbSIsInJvbGVzIjpbInVzZXIiXSwicmVnaW9uIjoidXMtZWFzdC0xIiwic2Vzc2lvbklkIjoiYTFiMmMzZDQiLCJpYXQiOjE3MDkxMjM0NTYsImV4cCI6MTcwOTEyNDM1NiwiYXVkIjoiYm9va2luZy1hcGkiLCJpc3MiOiJib29raW5nLXBsYXRmb3JtIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

Intimidating? It is not. That string has exactly three parts, separated by dots (`.`). Let us pull them apart.

### Part 1: The Header

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

This is Base64URL-encoded (not encrypted -- just encoded, like translating English to Pig Latin). It tells you two things:

- **`alg`**: The algorithm used to create the signature. `HS256` means HMAC-SHA256 -- a symmetric algorithm where the same secret key signs and verifies the token. Production systems often use `RS256` (RSA with SHA-256), an asymmetric algorithm where a private key signs and a public key verifies. We will use `HS256` for simplicity.
- **`typ`**: The type of token. Always `JWT`.

### Part 2: The Payload

```json
{
  "userId": "U-881",
  "email": "jane@example.com",
  "roles": ["user"],
  "region": "us-east-1",
  "sessionId": "a1b2c3d4",
  "iat": 1709123456,
  "exp": 1709124356,
  "aud": "booking-api",
  "iss": "booking-platform"
}
```

This is also Base64URL-encoded. It carries the **claims** -- pieces of information about the user and the token itself. Let us go through each one:

- **`userId`**: The user's unique identifier. Every service that receives this token knows who the request is from without calling the Auth Service again.
- **`email`**: The user's email. Useful for logging, personalization, or notification triggers.
- **`roles`**: An array of roles this user has. This drives authorization decisions (can this user access admin endpoints?).
- **`region`**: Which region this token was issued from. Helps with multi-region routing.
- **`sessionId`**: A unique ID for this login session. We store this in Redis so we can revoke the session (log the user out) without waiting for the token to expire.
- **`iat`** (Issued At): Unix timestamp when the token was created. 1709123456 means "February 28, 2024, at some specific time."
- **`exp`** (Expiration): Unix timestamp when the token expires. If `exp` is in the past, the token is rejected. No exceptions.
- **`aud`** (Audience): Who this token is intended for. If a token meant for `booking-api` shows up at `admin-api`, it should be rejected.
- **`iss`** (Issuer): Who created this token. Any token not issued by `booking-platform` is immediately suspicious.

> **Key Term:** **Claims** — Key-value pairs inside a JWT payload that carry information about the user and the token. Standard claims (`iat`, `exp`, `iss`, `aud`) are defined by the JWT specification. Custom claims (`userId`, `roles`, `region`) are whatever your application needs.

**Critical point: the payload is NOT encrypted.** Anyone can decode a JWT payload -- it is just Base64. Go to [jwt.io](https://jwt.io), paste a token, and you will see the payload in plain text. Never put sensitive data in a JWT. No passwords, no credit card numbers, no social security numbers. The payload is readable by anyone who intercepts the token.

### Part 3: The Signature

This is the part that makes JWTs trustworthy. The signature is created by taking the encoded header, the encoded payload, and a secret key, then running them through the specified algorithm:

```
HMAC-SHA256(
  base64UrlEncode(header) + "." + base64UrlEncode(payload),
  secretKey
)
```

The signature guarantees two things:

1. **Integrity.** If anyone modifies the payload (changes `"roles": ["user"]` to `"roles": ["admin"]`), the signature will not match. The token is rejected instantly.
2. **Authenticity.** Only someone who knows the secret key can create a valid signature. If you receive a token with a valid signature, you know it was created by your Auth Service (which is the only service that knows the secret).

> **Analogy:** Think of a JWT like a government-issued ID card. The card has your photo and personal details printed on it (the payload -- visible to anyone who looks). On the back, there is a holographic seal embedded during manufacturing (the signature -- only the government can create it). A bouncer at a club can read your name and birthdate without calling the government (self-contained). If someone tries to alter the birthdate, the holographic seal will not match, and the bouncer rejects the ID. But the bouncer does not need to call the ID office for every single customer -- the seal itself proves the card is legitimate. That is exactly how JWT verification works: the service checks the signature locally, without calling the Auth Service.

> **What If You Skip This?** If you skip understanding JWT structure and just copy-paste token code from Stack Overflow, you will eventually make a security mistake. Common ones: storing sensitive data in the payload (it is readable!), using weak or hardcoded secrets (attackers can forge tokens), not validating `exp` (tokens never expire), not validating `iss` and `aud` (tokens from other systems are accepted). Each of these is a real vulnerability that has caused real breaches.

---

## Access Tokens vs. Refresh Tokens -- Why Two Tokens?

Here is a dilemma. You want your JWTs to last a long time so users do not have to log in constantly. But you also want them to expire quickly so that if a token is stolen, the attacker has a limited window. You cannot have both... unless you use two tokens.

**Access Token**: Short-lived (15 minutes in our system). This is the token that goes in the `Authorization` header of every API request. If it is stolen, the attacker has at most 15 minutes before it expires and becomes useless.

**Refresh Token**: Long-lived (7 days in our system). This token is stored securely (usually in an HTTP-only cookie or secure storage) and is *only* used to get a new access token when the old one expires. It never goes in API request headers.

Here is the flow:

```
1. User logs in with email + password.
2. Auth Service validates credentials, generates BOTH tokens:
   - Access Token  (15 min expiry)
   - Refresh Token (7-day expiry)
3. Client stores both tokens.
4. Client sends API requests with: Authorization: Bearer <accessToken>
5. After 15 minutes, the access token expires.
6. Client sends the refresh token to: POST /auth/refresh
7. Auth Service validates the refresh token, issues a NEW access token.
8. Client continues using the new access token.
9. After 7 days, the refresh token expires. User must log in again.
```

Why not just make the access token last 7 days? Because access tokens travel with *every request*. They are in HTTP headers. They are in server logs. They are in debugging tools. The more they travel, the more likely they are to leak. A 15-minute window limits the damage of a leak.

Refresh tokens, by contrast, only travel to one endpoint (`/auth/refresh`). They are used infrequently (once every 15 minutes) and can be stored more securely.

> **Key Term:** **Refresh Token** — A long-lived credential used solely to obtain new access tokens. It never accompanies regular API requests, reducing its exposure to interception. If compromised, it can be revoked server-side by deleting its session from Redis.

---

## The Token Service -- Implementation Deep Dive

Now let us look at the actual implementation. This is the AuthService class that generates and verifies tokens.

```typescript
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
    // Build the payload from the user record
    const payload: TokenPayload = {
      userId: user.id.toString(),  // Convert BigInt to string for JSON safety
      email: user.email,
      roles: user.roles,           // e.g., ['user'] or ['admin', 'user']
      region: process.env.REGION,  // Which data center issued this token
      sessionId: randomUUID()      // Unique ID for this login session
    };

    // Sign the access token -- short-lived, carries full user context
    const accessToken = jwt.sign(payload, this.accessTokenSecret, {
      expiresIn: '15m',            // Expires in 15 minutes
      issuer: 'booking-platform',  // Who created this token
      audience: 'booking-api'      // Who should accept this token
    });

    // Sign the refresh token -- long-lived, carries minimal data
    const refreshToken = jwt.sign(
      { userId: user.id, sessionId: payload.sessionId },
      this.refreshTokenSecret,     // DIFFERENT secret from access token
      { expiresIn: '7d' }          // Expires in 7 days
    );

    // Store session in Redis for revocation support
    await redis.setex(
      `session:${payload.sessionId}`,  // Key: session:<uuid>
      7 * 24 * 60 * 60,               // TTL: 7 days in seconds (604,800)
      JSON.stringify({ userId: user.id, createdAt: Date.now() })
    );

    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    // Step 1: Verify the signature and check expiration
    const payload = jwt.verify(token, this.accessTokenSecret) as TokenPayload;

    // Step 2: Check if the session has been revoked
    const session = await redis.get(`session:${payload.sessionId}`);
    if (!session) {
      throw new UnauthorizedError('Session has been revoked');
    }

    return payload;
  }
}
```

Let us walk through the critical design decisions in this code.

**Why two different secrets?** The access token uses `JWT_ACCESS_SECRET` and the refresh token uses `JWT_REFRESH_SECRET`. If an attacker somehow obtains the access token secret, they can forge access tokens -- bad, but those expire in 15 minutes. They still cannot forge refresh tokens because those use a completely different secret. Defense in depth.

**Why store the session in Redis?** JWTs are stateless by design -- the server does not need to store anything. So why do we store a session? One word: **revocation**. Without server-side session tracking, you cannot log a user out before their token expires. If a user reports their account as compromised, you need to invalidate their token *right now*, not in 15 minutes. By storing the `sessionId` in Redis, you can delete the key, and the next time that token is used, the `verifyAccessToken` method will check Redis, find nothing, and reject the token.

**Why `userId` is a string, not a number.** The comment in the code says "avoid BigInt JSON serialization issues," and this is a real gotcha. JavaScript's `JSON.stringify` cannot handle `BigInt` values -- it throws a `TypeError`. If your database uses `BIGINT` primary keys (which MySQL 8.0 often does), converting to string before putting the value in a JWT is the safe choice.

**Why the refresh token has a minimal payload.** The access token carries everything (`email`, `roles`, `region`) because services need that context to make authorization decisions. The refresh token only carries `userId` and `sessionId` because it is only used for one thing: generating a new access token. Minimal data means minimal exposure if the refresh token is ever leaked.

**Why `redis.setex` instead of `redis.set`?** The `setex` command sets a key with an automatic time-to-live (TTL). After 604,800 seconds (7 days), Redis deletes the key automatically. This means you never have stale sessions sitting around forever -- they clean themselves up, matching the refresh token's 7-day expiry.

> **What If You Skip This?** If you skip session storage in Redis, you have no way to revoke tokens. A user's account gets compromised, and you tell them "sorry, we can't log you out -- just wait 15 minutes." For a financial platform handling hotel bookings and credit card charges, that is unacceptable. Session storage is the escape hatch that makes JWTs practical in security-sensitive systems.

---

## RBAC -- Role-Based Access Control

Authentication answers "Who are you?" Authorization answers "What are you allowed to do?" RBAC is the most common model for authorization, and it works by assigning **roles** to users, then defining which roles can access which resources.

Here is our role hierarchy:

```typescript
export enum Role {
  GUEST = 'guest',           // Can search, view prices
  USER = 'user',             // Can book, view own bookings
  PREMIUM_USER = 'premium',  // Higher rate limits, priority support
  ADMIN = 'admin',           // Manage bookings, view reports
  SUPER_ADMIN = 'super_admin' // System configuration, user management
}
```

Let us unpack what each role can do and why the hierarchy exists.

**`GUEST`**: A visitor who has not logged in. They can search for hotels and view prices -- these are read-only, public operations. They cannot book anything because booking requires knowing who is booking (and storing their payment information).

**`USER`**: A logged-in customer. They can create bookings, view their own booking history, and manage their profile. They cannot view other users' bookings or access any admin functionality.

**`PREMIUM_USER`**: A USER with extra perks. In our system, premium users get higher rate limits (more API calls per minute), priority customer support routing, and access to exclusive deals. The role inherits everything USER can do and adds on top.

**`ADMIN`**: An internal staff member. Admins can manage any booking (cancel, modify, refund), view business reports, and handle customer escalations. They should not be able to change system-level configuration.

**`SUPER_ADMIN`**: A system administrator. They can do everything an ADMIN can do, plus manage user accounts, change system configuration, rotate API keys, and perform destructive operations. Very few people should have this role.

> **Analogy:** Think of a hotel. A **guest** can walk through the lobby and look at the room prices on the display board. A **registered guest** (USER) can check in, access their room, and use the pool. A **VIP guest** (PREMIUM_USER) gets all of that plus the executive lounge and late checkout. A **hotel manager** (ADMIN) can access any room, process refunds, and view occupancy reports. The **hotel owner** (SUPER_ADMIN) can do all of that plus hire/fire managers and renovate the building. Each role inherits the privileges of the roles below it and adds new ones.

### The NestJS Role Guard

In NestJS, we enforce roles using a **custom decorator** and a **guard**. Here is how it works:

```typescript
// Permission guard decorator for NestJS
export const RequireRoles = (...roles: Role[]) => {
  return SetMetadata('roles', roles);
};
```

This decorator is syntactic sugar. When you write `@RequireRoles(Role.USER, Role.ADMIN)`, NestJS attaches metadata to that route handler saying, "These roles are allowed." The decorator itself does not enforce anything -- it just labels the endpoint.

The enforcement happens in the guard (which is NestJS's version of Express middleware for authorization):

```typescript
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Read the roles metadata that @RequireRoles attached
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles are required, allow access (public endpoint)
    if (!requiredRoles) {
      return true;
    }

    // Get the user from the request (set by JWT middleware earlier)
    const { user } = context.switchToHttp().getRequest();

    // Check if the user has at least one of the required roles
    return requiredRoles.some((role) => user.roles?.includes(role));
  }
}
```

Now you apply it to controllers:

```typescript
// Usage in controllers
@Post('/bookings')
@RequireRoles(Role.USER, Role.PREMIUM_USER, Role.ADMIN)
async createBooking(@Body() dto: CreateBookingDto) {
  // Only authenticated users with USER, PREMIUM_USER, or ADMIN role
  // can reach this code. Everyone else gets 403 Forbidden.
}

@Get('/admin/reports')
@RequireRoles(Role.ADMIN, Role.SUPER_ADMIN)
async getReports() {
  // Only admins and super admins can access reports.
  // A regular USER hitting this endpoint gets 403 Forbidden.
}
```

In your Express app, you might have done something like:

```typescript
// Express equivalent
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

app.get('/admin/reports', authMiddleware, requireRole('admin'), handler);
```

The NestJS decorator pattern is the same concept, just expressed with decorators instead of middleware chaining. The metadata approach is cleaner when you have many endpoints because you can see the required roles right above the method definition, not buried in a middleware chain.

> **Key Term:** **RBAC (Role-Based Access Control)** — An authorization model where permissions are assigned to roles, and users are assigned roles. A user's effective permissions are the union of all permissions granted by their roles. RBAC is simpler than attribute-based access control (ABAC) but covers the vast majority of real-world authorization needs.

---

## Service-to-Service Authentication -- Trust Inside the Walls

So far, we have talked about authenticating *users* -- people with email addresses and passwords who use the browser. But what about services talking to each other? When the Booking Service calls the Inventory Service, how does Inventory know the request is genuinely from Booking and not from an attacker who somehow got inside the network?

This is **service-to-service authentication**, and it is a separate problem from user authentication.

```typescript
// Internal services authenticate via mTLS (handled by Istio service mesh)
// plus API key validation for defense in depth

export class ServiceAuthMiddleware {
  async validate(req: Request, res: Response, next: NextFunction) {
    // Step 1: Read the service identity headers
    const serviceKey = req.headers['x-service-key'];
    const serviceName = req.headers['x-service'];

    // Step 2: Reject if headers are missing
    if (!serviceKey || !serviceName) {
      return res.status(401).json({ error: 'Missing service credentials' });
    }

    // Step 3: Look up the expected key for this service name in Redis
    const validKey = await redis.get(`service-key:${serviceName}`);

    // Step 4: Compare. If the key doesn't match, reject.
    if (validKey !== serviceKey) {
      return res.status(403).json({ error: 'Invalid service key' });
    }

    // Step 5: Credentials valid. Let the request through.
    next();
  }
}
```

Let us walk through every line of this middleware.

**Step 1**: When the Booking Service calls the Inventory Service, it includes two custom headers: `X-Service-Key` (a secret API key unique to the Booking Service) and `X-Service` (the name "booking-service"). This is how the caller identifies itself.

**Step 2**: If either header is missing, the request is immediately rejected with `401 Unauthorized`. This catches accidental calls from tools, scripts, or misconfigured services that forgot to include credentials.

**Step 3**: The middleware looks up the expected API key for the given service name in Redis. For example, Redis stores `service-key:booking-service` with a value like `sk_live_abc123xyz...`. This means API keys are centrally managed -- you can rotate them by updating a single Redis entry.

**Step 4**: If the provided key does not match the stored key, the request is rejected with `403 Forbidden`. The service is not who it claims to be.

**Step 5**: If everything checks out, `next()` passes the request to the actual route handler.

The comment at the top mentions **mTLS (mutual TLS)**, which is an additional layer handled by the Istio service mesh.

> **Key Term:** **mTLS (Mutual TLS)** — An extension of standard TLS where both sides of a connection verify each other's identity using certificates. In regular TLS, only the client verifies the server. In mTLS, the server also verifies the client. This ensures that both ends of an internal service-to-service connection are who they claim to be. Istio automates mTLS by injecting sidecar proxies that handle certificate issuance, rotation, and verification transparently.

In regular TLS (what your browser does), only the client verifies the server's identity. In mutual TLS, *both sides* verify each other. The Booking Service proves its identity to the Inventory Service, and the Inventory Service proves its identity to the Booking Service. Istio handles this transparently -- it injects a sidecar proxy into every pod that automatically encrypts and authenticates all inter-service traffic.

The API key middleware is a **defense-in-depth** measure. Even if mTLS is somehow bypassed (unlikely but possible in edge cases), the API key layer provides a second check. Security-sensitive systems always use multiple layers of defense.

> **Analogy:** Imagine a hospital. The building has a locked front door with a badge reader (mTLS -- you need a valid employee badge to enter). But inside the building, the pharmacy has its own keypad lock (API key -- even authorized employees need a specific code to access controlled substances). Two layers of security. If someone manages to clone a badge and enter the building, they still cannot access the pharmacy without the code. That is defense in depth.

> **What If You Skip This?** Without service-to-service authentication, any process running inside your Kubernetes cluster can call any internal service. A compromised pod (from a dependency vulnerability, a supply chain attack, or a misconfiguration) could call the Payment Service directly and initiate fraudulent charges. Internal network access should never be treated as implicit trust.

---

## Token Expiry -- Why Tokens Must Die

You might wonder: why not just create a token that never expires? Then users never have to log in again. Convenient, right?

Here is why that is dangerous:

1. **Leaked tokens live forever.** If an access token with no expiry is logged in a server access log, committed to a Git repository, or intercepted by a man-in-the-middle attack, the attacker has permanent access. With a 15-minute expiry, the window of vulnerability is 15 minutes at most.

2. **Permissions become stale.** A user is an admin today. Tomorrow, they leave the company, and you remove their admin role from the database. But their token still says `"roles": ["admin"]`. Without expiry, that token grants admin access forever. With short-lived tokens, the user's next token refresh hits the Auth Service, which reads the updated roles from the database and issues a token without the admin role.

3. **Sessions cannot be cleaned up.** Without expiry, your Redis session store grows indefinitely. Every login creates a session entry that never expires. Over months, you accumulate millions of stale sessions consuming memory.

The 15-minute access token and 7-day refresh token represent a practical balance:

- **15 minutes** is short enough that a leaked access token is minimally dangerous.
- **15 minutes** is long enough that users do not experience constant re-authentication.
- **7 days** for the refresh token means users stay logged in for a week of normal usage.
- **7 days** is short enough that old devices and forgotten sessions clean themselves up.

For our booking platform specifically, financial transactions (charging credit cards, processing refunds) happen through the Payment Service, which validates the user's JWT. A token that never expires means a stolen token could be used to make fraudulent bookings indefinitely. The 15-minute window drastically limits this damage.

---

## The Full Authentication Flow -- Tying It All Together

Let us trace a complete authentication journey from login to booking.

```
1. LOGIN
   Browser sends: POST /auth/login
   Body: { "email": "jane@example.com", "password": "s3cureP@ss" }

   Auth Service:
   - Finds user by email in database
   - Compares password with bcrypt hash
   - Generates access token (15 min) + refresh token (7 days)
   - Stores session in Redis with TTL
   - Returns both tokens to browser

2. MAKING A BOOKING (10 minutes later)
   Browser sends: POST /api/v1/bookings
   Headers: { Authorization: "Bearer eyJhbG..." }

   API Gateway:
   - Extracts JWT from Authorization header
   - Calls Auth Service to verify (or verifies locally with shared public key)
   - Auth returns: { userId: "U-881", roles: ["user"], valid: true }
   - Forwards request to Booking Service with user context

   Booking Service:
   - Reads user context from request headers
   - RolesGuard checks: does "user" role allow POST /bookings? Yes.
   - Processes the booking.

3. TOKEN REFRESH (16 minutes after login)
   Browser sends: POST /auth/refresh
   Body: { "refreshToken": "eyJhbG..." }

   Auth Service:
   - Verifies the refresh token signature
   - Checks that the session exists in Redis (not revoked)
   - Reads the latest user roles from the database
   - Generates a NEW access token with updated claims
   - Returns the new access token

4. LOGOUT
   Browser sends: POST /auth/logout
   Body: { "refreshToken": "eyJhbG..." }

   Auth Service:
   - Extracts sessionId from the refresh token
   - Deletes "session:<sessionId>" from Redis
   - Now, even if the old access token hasn't expired yet,
     the next verification will fail at the Redis check.
```

Notice step 3 carefully. When the access token expires and the client uses the refresh token to get a new one, the Auth Service reads the user's **current** roles from the database -- not from the old token. This is how permission changes propagate. If an admin revoked the user's `premium` role 10 minutes ago, the new access token will reflect that change.

---

## Security Implications Summary

Every design decision in this chapter has security implications. Here is a consolidated view:

| Decision | If Done Correctly | If Skipped or Done Wrong |
|---|---|---|
| Short-lived access tokens | Leaked tokens expire quickly (15 min) | Leaked tokens grant permanent access |
| Separate refresh tokens | Only used for token renewal; less exposure | Access tokens must be long-lived, increasing risk |
| Two different JWT secrets | Compromising one secret does not compromise the other | One leaked secret compromises the entire auth system |
| Redis session storage | Tokens can be revoked instantly | No way to force logout or invalidate stolen tokens |
| RBAC with role guard | Endpoints are protected per-role; privilege escalation is prevented | Users can access endpoints they should not; data leaks |
| Service-to-service API keys | Only authorized services can call internal endpoints | Any pod in the cluster can call any service; lateral movement is easy |
| mTLS via Istio | All inter-service traffic is encrypted and mutually authenticated | Internal traffic is plaintext; attackers on the network can sniff data |
| `iss` and `aud` validation | Tokens from other systems or other environments are rejected | A token from staging works in production; cross-environment attacks |

---

## Chapter 9 Summary

| Concept | One-Sentence Summary |
|---|---|
| JWT Structure | A JWT has three Base64-encoded parts: header (algorithm), payload (claims about the user), and signature (cryptographic proof of integrity). |
| Claims | Key-value pairs in the JWT payload; standard claims (`exp`, `iat`, `iss`, `aud`) are defined by the spec; custom claims (`userId`, `roles`) are application-specific. |
| Access Token | A short-lived (15 min) JWT sent with every API request to prove the user's identity and permissions. |
| Refresh Token | A long-lived (7 days) JWT used exclusively to obtain new access tokens, reducing exposure of credentials. |
| Session Revocation | Storing a `sessionId` in Redis allows immediate token invalidation by deleting the session key, solving JWT's statelessness limitation. |
| RBAC | Assigning roles (guest, user, admin) to users and checking those roles at each endpoint to enforce authorization. |
| RolesGuard | A NestJS guard that reads role metadata from decorators and rejects requests from users without the required role. |
| Service-to-Service Auth | Internal services authenticate via API keys in headers and mTLS for encrypted mutual verification, providing defense in depth. |
| Token Expiry | Tokens must expire to limit damage from leaks, propagate permission changes, and allow session cleanup. |

> **Checkpoint:** A user logs in and gets an access token with `"roles": ["admin"]`. Five minutes later, a Super Admin removes their admin role from the database. The user's current access token still says `"roles": ["admin"]`. Can they still access admin endpoints? For how long? What happens when their access token expires and they use the refresh token? Walk through each step. If your answer is "yes, they can access admin endpoints for up to 15 minutes until the access token expires; when they refresh, the Auth Service reads the updated roles from the database and the new access token will not include 'admin'; from that point forward, admin endpoints return 403 Forbidden" -- you understand the access/refresh token lifecycle and its security trade-offs.
