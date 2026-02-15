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

> **Key Term:** **API Gateway** -- A server that acts as the single entry point for all client requests to a microservices architecture. It handles cross-cutting concerns like routing, authentication, rate limiting, and TLS termination so individual services do not have to.

Here is the architectural position of the gateway in our system:

```
                        ┌─────────────────────────────────────────┐
                        │            INTERNET (Public)            │
                        └────────────────┬────────────────────────┘
                                         │
                                    HTTPS (TLS)
                                         │
                        ┌────────────────▼────────────────────────┐
                        │         API GATEWAY (Kong/NGINX)        │
                        │  ┌──────────────────────────────────┐   │
                        │  │  TLS Termination                 │   │
                        │  │  CORS Enforcement                │   │
                        │  │  Rate Limiting                   │   │
                        │  │  JWT Validation                  │   │
                        │  │  Request Transformation          │   │
                        │  │  Circuit Breaker                 │   │
                        │  │  Load Balancing                  │   │
                        │  │  Response Transformation         │   │
                        │  └──────────────────────────────────┘   │
                        └───┬─────────┬──────────┬──────────┬─────┘
                            │         │          │          │
                     HTTP (plain)     │          │          │
                            │         │          │          │
                  ┌─────────▼──┐ ┌────▼───┐ ┌───▼────┐ ┌──▼──────┐
                  │  Booking   │ │ Search │ │Payment │ │  Auth   │
                  │  Service   │ │Service │ │Service │ │ Service │
                  │  :3003     │ │ :3002  │ │ :3005  │ │ :3001   │
                  └────────────┘ └────────┘ └────────┘ └─────────┘
                        PRIVATE NETWORK (Kubernetes Cluster)
```

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

> **Key Term:** **TLS Termination** -- The practice of decrypting HTTPS traffic at the gateway so that internal service-to-service communication can use plain HTTP. The gateway holds the TLS certificate and handles the computationally expensive encryption/decryption so individual services do not have to.

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

Our system uses Kong, a popular open-source API Gateway built on top of NGINX. Let us walk through the actual production configuration file. If you have never seen a declarative gateway config, do not worry -- it is simpler than it looks.

```yaml
# kong.yml - Declarative configuration for the Global Booking System
# This file tells Kong: "Here are my services, their routes, and their plugins."
_format_version: "3.0"  # Kong declarative config schema version

# ──────────────────────────────────────────────────────────
# SERVICES: Each entry represents one backend microservice.
# Kong will forward matching requests to the URL specified.
# ──────────────────────────────────────────────────────────
services:

  # ── Booking Service ──────────────────────────────────────
  - name: booking-service                  # Internal name for Kong's reference
    url: http://booking-service.production.svc.cluster.local:3000
    #     ^protocol  ^K8s DNS name                            ^port
    # Kubernetes DNS format: <service>.<namespace>.svc.cluster.local
    # We NEVER use hardcoded IPs. Pods come and go; DNS stays stable.

    connect_timeout: 10000    # 10s to establish TCP connection
    write_timeout: 30000      # 30s for the upstream to accept request body
    read_timeout: 60000       # 60s for the upstream to send the response
    retries: 2                # Retry failed requests up to 2 times

    routes:
      - name: booking-routes
        paths:
          - /api/v1/bookings        # Any request starting with this path
        methods:
          - GET                      # List bookings, get booking by ID
          - POST                     # Create new booking
          - PUT                      # Update booking
          - PATCH                    # Partial update
        strip_path: false            # Keep the full path when forwarding
        preserve_host: true          # Forward the original Host header

  # ── Search Service ───────────────────────────────────────
  - name: search-service
    url: http://search-service.production.svc.cluster.local:3000
    connect_timeout: 5000     # Search should connect fast
    read_timeout: 15000       # Search queries should not take > 15s
    retries: 3                # Search is idempotent, safe to retry

    routes:
      - name: search-routes
        paths:
          - /api/v1/search
        methods:
          - GET                      # Search is read-only
        strip_path: false

  # ── Inventory Service ────────────────────────────────────
  - name: inventory-service
    url: http://inventory-service.production.svc.cluster.local:3000
    connect_timeout: 10000
    read_timeout: 30000
    retries: 2

    routes:
      - name: inventory-routes
        paths:
          - /api/v1/inventory
        methods:
          - GET                      # Check availability
        strip_path: false

  # ── Payment Service ──────────────────────────────────────
  - name: payment-service
    url: http://payment-service.production.svc.cluster.local:3000
    connect_timeout: 10000
    write_timeout: 60000      # Payments may involve external provider calls
    read_timeout: 60000       # Stripe/PayPal can be slow under load
    retries: 0                # NEVER retry payments -- risk of double charge

    routes:
      - name: payment-routes
        paths:
          - /api/v1/payments
        methods:
          - POST                     # Charge, refund
        strip_path: false
```

Let us break this down block by block.

**The `services` section** defines each backend microservice. Every entry has a `name` (for Kong's internal reference) and a `url` (the actual address of the service inside the Kubernetes cluster). Notice the URLs use Kubernetes DNS names like `booking-service.production.svc.cluster.local` -- not hardcoded IP addresses. We covered why in Chapter 4: pods come and go, IP addresses change, but DNS names stay stable.

**The timeout values** (`connect_timeout`, `write_timeout`, `read_timeout`) are critical and vary per service. The Payment Service gets 60 seconds for reads because it talks to external providers (Stripe, PayPal) that can be slow. The Search Service gets only 15 seconds because if a search takes that long, something is seriously wrong and the user has already abandoned the page.

**The `retries` setting** deserves special attention. Notice that the Payment Service has `retries: 0`. Why? Because if you retry a payment and the first request actually succeeded (but the response was lost due to a network blip), you will charge the customer twice. Search, on the other hand, is idempotent -- repeating a search query is harmless -- so `retries: 3` is safe.

> **Common Mistake:** Setting the same timeout and retry values for every service. A junior developer might set `read_timeout: 60000` and `retries: 3` globally. This means a search request could take up to 4 minutes (60s x 4 attempts) to return an error, and a payment could be attempted 4 times. Always tune timeouts and retries per service based on the nature of the operation.

**The `routes` section** nested inside each service tells Kong which incoming URL paths should be forwarded to that service. When a request arrives at the gateway for `/api/v1/bookings`, Kong forwards it to the Booking Service. When a request comes in for `/api/v1/search`, it goes to the Search Service.

**The `methods` array** restricts which HTTP methods are allowed. The Search and Inventory services only accept `GET` -- you cannot `POST` to them through the gateway. The Payment Service only accepts `POST`. This is an important security measure: even if an attacker discovers the path, they can only use the methods you explicitly allow.

**The `strip_path` setting** controls whether Kong removes the matched path prefix before forwarding. When set to `false`, the Booking Service receives the full path `/api/v1/bookings`. If it were `true`, Kong would strip `/api/v1/bookings` and forward just `/`. We keep it `false` so services can use the full path for their own routing logic.

**The `preserve_host` setting** controls whether Kong forwards the original `Host` header from the client (`api.bookingplatform.com`) or replaces it with the upstream service's host (`booking-service.production.svc.cluster.local`). We set it to `true` so services can make decisions based on the public hostname -- useful for multi-tenant setups.

---

## NGINX Configuration -- The Engine Under Kong's Hood

Kong runs on top of NGINX, and for many teams, using NGINX directly as a reverse proxy is the starting point. Understanding the NGINX configuration helps you understand what Kong is doing underneath. Here is a production-tuned NGINX configuration for our gateway:

```nginx
# /etc/nginx/nginx.conf -- Production API Gateway Configuration

# ──────────────────────────────────────────────────────────
# GLOBAL: Worker processes and event handling
# ──────────────────────────────────────────────────────────
worker_processes auto;          # One worker per CPU core (auto-detect)
worker_rlimit_nofile 65535;     # Max open file descriptors per worker
                                # Each connection = 2 file descriptors (client + upstream)
                                # 65535 / 2 = ~32K concurrent connections per worker

error_log /var/log/nginx/error.log warn;  # Log warnings and above
pid       /var/run/nginx.pid;

events {
    worker_connections 16384;    # Max simultaneous connections per worker
    multi_accept on;             # Accept as many connections as possible at once
    use epoll;                   # Linux-optimized event model (10x faster than select/poll)
}

http {
    # ──────────────────────────────────────────────────────
    # PERFORMANCE: Connection pooling and keep-alive
    # ──────────────────────────────────────────────────────
    sendfile on;                 # Bypass userspace -- kernel sends file directly
    tcp_nopush on;               # Buffer headers and body, send in one TCP packet
    tcp_nodelay on;              # Disable Nagle's algorithm -- send data immediately
    keepalive_timeout 65;        # Keep client connections open for 65 seconds
    keepalive_requests 1000;     # Max requests per keep-alive connection

    # ──────────────────────────────────────────────────────
    # BUFFERS: Size tuning for request/response handling
    # ──────────────────────────────────────────────────────
    client_body_buffer_size 16k;       # Buffer for request bodies (most JSON is < 16KB)
    client_max_body_size 10m;          # Max upload size (reject anything > 10MB)
    large_client_header_buffers 4 32k; # 4 buffers of 32KB each for large headers (JWTs!)

    # ──────────────────────────────────────────────────────
    # UPSTREAMS: Backend service pools with load balancing
    # ──────────────────────────────────────────────────────
    upstream booking_backend {
        least_conn;              # Send to the server with fewest active connections
        keepalive 32;            # Maintain 32 persistent connections to this upstream

        server booking-service-1:3000 weight=5;   # Primary: gets 5x more traffic
        server booking-service-2:3000 weight=3;   # Secondary: gets 3x traffic
        server booking-service-3:3000 weight=2;   # Tertiary: gets 2x traffic
        server booking-service-4:3000 backup;      # Only used if all above are down
    }

    upstream search_backend {
        least_conn;
        keepalive 64;            # More keepalive connections -- search is high-throughput

        server search-service-1:3000;
        server search-service-2:3000;
        server search-service-3:3000;
    }

    upstream payment_backend {
        ip_hash;                 # Same client IP always goes to same server
                                 # Important for payment sessions
        keepalive 16;

        server payment-service-1:3000;
        server payment-service-2:3000;
    }

    # ──────────────────────────────────────────────────────
    # RATE LIMITING: Define rate limit zones in shared memory
    # ──────────────────────────────────────────────────────
    limit_req_zone $binary_remote_addr zone=global:10m rate=100r/s;
    #              ^key (client IP)      ^name  ^size  ^100 requests/sec
    # 10m of shared memory holds ~160,000 unique IP addresses

    limit_req_zone $binary_remote_addr zone=search:10m rate=50r/s;
    limit_req_zone $binary_remote_addr zone=payments:5m rate=10r/s;

    # ──────────────────────────────────────────────────────
    # SERVER: TLS termination and routing
    # ──────────────────────────────────────────────────────
    server {
        listen 443 ssl http2;    # HTTPS on port 443, HTTP/2 enabled
        server_name api.bookingplatform.com;

        # TLS Configuration
        ssl_certificate     /etc/ssl/certs/api.bookingplatform.com.crt;
        ssl_certificate_key /etc/ssl/private/api.bookingplatform.com.key;
        ssl_protocols       TLSv1.2 TLSv1.3;        # Only modern TLS versions
        ssl_ciphers         HIGH:!aNULL:!MD5;         # Strong ciphers only
        ssl_session_cache   shared:SSL:10m;           # Cache TLS sessions (faster reconnect)
        ssl_session_timeout 10m;

        # Security headers (applied to ALL responses)
        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Content-Security-Policy "default-src 'self'" always;

        # ── Booking Routes ─────────────────────────────
        location /api/v1/bookings {
            limit_req zone=global burst=50 nodelay;
            #                      ^allow burst of 50 above the rate
            #                              ^reject immediately, don't queue

            proxy_pass http://booking_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Gateway-Region "us-east-1";

            proxy_connect_timeout 10s;
            proxy_read_timeout 60s;
            proxy_send_timeout 30s;
        }

        # ── Search Routes ──────────────────────────────
        location /api/v1/search {
            limit_req zone=search burst=100 nodelay;

            proxy_pass http://search_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Gateway-Region "us-east-1";

            proxy_connect_timeout 5s;
            proxy_read_timeout 15s;       # Search should be fast
        }

        # ── Payment Routes ─────────────────────────────
        location /api/v1/payments {
            limit_req zone=payments burst=5 nodelay;

            # Only allow POST
            limit_except POST {
                deny all;
            }

            proxy_pass http://payment_backend;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

            proxy_connect_timeout 10s;
            proxy_read_timeout 60s;
            proxy_next_upstream off;       # NEVER retry payments
        }

        # ── Health Check ───────────────────────────────
        location /health {
            access_log off;               # Don't log health checks (too noisy)
            return 200 '{"status":"ok"}';
            add_header Content-Type application/json;
        }
    }

    # ── Redirect HTTP to HTTPS ─────────────────────────
    server {
        listen 80;
        server_name api.bookingplatform.com;
        return 301 https://$server_name$request_uri;
    }
}
```

Let us highlight what matters here:

**`worker_processes auto`** tells NGINX to spawn one worker process per CPU core. Each worker handles connections independently, which means NGINX scales naturally with your hardware. On an 8-core machine, you get 8 workers, each handling up to 16,384 connections -- a theoretical maximum of 131,072 simultaneous connections.

**`use epoll`** is the Linux kernel's event notification mechanism. It is how NGINX handles tens of thousands of connections without creating a thread per connection. Compare this to your Express app, which uses Node.js's `libuv` event loop for the same purpose.

**The `upstream` blocks** define pools of backend servers. This is where load balancing lives. Notice that each pool uses a different strategy: `least_conn` for booking and search (send to the server with the fewest active connections), `ip_hash` for payments (same client always reaches the same server, important for payment session stickiness).

**`proxy_next_upstream off`** on the payment route is critical. This tells NGINX: "If the upstream returns an error, do NOT try the next server." For payments, retrying is dangerous because the first attempt might have succeeded.

> **Why Not NGINX Alone?** NGINX is an excellent reverse proxy and load balancer, but it lacks the plugin ecosystem and management API that Kong provides. Kong adds rate limiting, JWT validation, OAuth, request transformation, and dozens of other plugins out of the box. With raw NGINX, you implement these features yourself in Lua or C modules. For small teams, Kong saves months of development. For teams that need absolute control and minimal overhead, raw NGINX is leaner and faster.

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
- **`credentials: true`** allows the browser to send cookies along with requests.

> **Key Term:** **CORS (Cross-Origin Resource Sharing)** -- A browser security policy that restricts web pages from making requests to a different domain than the one that served the page. The server must explicitly opt in by sending the correct response headers.

### Request Transformation -- Adding Gateway Metadata

```yaml
  - name: request-transformer
    config:
      add:
        headers:
          - "X-Gateway-Region:us-east-1"
          - "X-Gateway-Timestamp:$(date +%s)"
          - "X-Request-Start:$(date +%s%3N)"
      remove:
        headers:
          - "X-Internal-Debug"
      rename:
        headers:
          - "Authorization:X-Original-Authorization"
```

This plugin modifies requests *before* forwarding them to the downstream service. Let us walk through each operation:

- **`add`** injects new headers. `X-Gateway-Region` tells the service which region the request entered. `X-Request-Start` records the timestamp in milliseconds -- the service can subtract this from its own timestamp to calculate gateway latency.
- **`remove`** strips headers that should not reach backend services. `X-Internal-Debug` might be used by the gateway itself but should never leak to services.
- **`rename`** changes header names. Renaming `Authorization` to `X-Original-Authorization` is a pattern used when the gateway validates the JWT and then replaces the Authorization header with an internal token.

In Express terms, this is equivalent to:

```typescript
app.use((req, res, next) => {
  // Add
  req.headers['x-gateway-region'] = 'us-east-1';
  req.headers['x-request-start'] = Date.now().toString();

  // Remove
  delete req.headers['x-internal-debug'];

  // Rename
  if (req.headers['authorization']) {
    req.headers['x-original-authorization'] = req.headers['authorization'];
  }

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
          - "Referrer-Policy:strict-origin-when-cross-origin"
          - "Permissions-Policy:camera=(), microphone=(), geolocation=()"
```

These headers protect your users against common web attacks:

- **`Strict-Transport-Security`** (HSTS) tells the browser, "For the next year, only connect over HTTPS. Even if the user types `http://`, upgrade it automatically." This prevents downgrade attacks.
- **`X-Content-Type-Options: nosniff`** tells the browser, "Trust the Content-Type header, do not guess." Prevents MIME-type confusion attacks.
- **`X-Frame-Options: DENY`** prevents your site from being embedded in an `<iframe>`, blocking clickjacking attacks.
- **`Content-Security-Policy`** restricts where the browser can load resources from.
- **`Referrer-Policy`** controls how much URL information is sent in the `Referer` header when navigating away.
- **`Permissions-Policy`** blocks access to browser APIs (camera, microphone, geolocation) that a booking API has no business using.

If you have ever used the `helmet` npm package in Express, these are the same headers that `helmet()` adds. Kong handles them at the gateway level so every service benefits automatically.

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

That is a fixed window counter. It works. But at the scale of 100,000 bookings per minute, you need to understand the *algorithms* behind rate limiting -- because they have different trade-offs, and choosing the wrong one will either let abuse through or reject legitimate traffic.

> **Key Term:** **Rate Limiting** -- Restricting the number of requests a client can make within a time window. At the gateway level, this protects all downstream services from traffic spikes, abuse, and denial-of-service attacks.

### Algorithm 1: Token Bucket

The Token Bucket is the most widely used rate-limiting algorithm in production systems. Amazon API Gateway, NGINX, and Kong all use variants of it.

> **Analogy:** Imagine a bucket that holds tokens. Every second, someone drops a new token into the bucket (up to the bucket's maximum capacity). Every time you make an API request, you must take a token from the bucket. If the bucket is empty, your request is rejected. If you have been quiet for a while, the bucket fills up, and you can make a burst of requests. This naturally allows short bursts of traffic while enforcing a long-term average rate.

Here is the full implementation:

```typescript
// rate-limiters/token-bucket.ts

/**
 * Token Bucket Rate Limiter
 *
 * Properties:
 * - Allows bursts up to bucket capacity
 * - Enforces a steady average rate
 * - Memory efficient: stores only 3 values per client
 * - Used by: AWS API Gateway, NGINX, Kong
 */
class TokenBucket {
  private tokens: number;                  // Current token count
  private lastRefillTimestamp: number;     // Last time we added tokens
  private readonly maxTokens: number;     // Bucket capacity (max burst size)
  private readonly refillRate: number;    // Tokens added per second

  constructor(maxTokens: number, refillRate: number) {
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
    this.tokens = maxTokens;               // Start with a full bucket
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Attempt to consume a token for an incoming request.
   * Returns true if the request is allowed, false if rate-limited.
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;   // Request allowed
    }

    return false;      // Rate limited -- bucket is empty
  }

  /**
   * Add tokens based on elapsed time since the last refill.
   * This is where the "steady rate" comes from.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTimestamp;
    const elapsedSeconds = elapsedMs / 1000;

    // Calculate how many tokens to add based on elapsed time
    const tokensToAdd = elapsedSeconds * this.refillRate;

    // Cap at bucket capacity -- tokens cannot exceed maxTokens
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefillTimestamp = now;
  }

  /** How many tokens remain right now */
  getRemainingTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

// ── Usage in Express middleware ──────────────────────────

// One bucket per client IP, stored in a Map
const buckets = new Map<string, TokenBucket>();

function tokenBucketMiddleware(maxTokens: number, refillRate: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    // Get or create a bucket for this client
    if (!buckets.has(clientIp)) {
      buckets.set(clientIp, new TokenBucket(maxTokens, refillRate));
    }

    const bucket = buckets.get(clientIp)!;

    if (bucket.tryConsume()) {
      // Request allowed -- set informational headers
      res.setHeader('X-RateLimit-Remaining', bucket.getRemainingTokens());
      res.setHeader('X-RateLimit-Limit', maxTokens);
      next();
    } else {
      // Rate limited
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Max ${refillRate} requests/second.`,
        retryAfter: Math.ceil(1 / refillRate),  // Seconds until next token
      });
    }
  };
}

// Apply: 100 token capacity, refills at 50 tokens/second
app.use('/api/v1/bookings', tokenBucketMiddleware(100, 50));
```

**Why Token Bucket works well:** It handles bursty traffic gracefully. A user who has been idle accumulates tokens and can make a burst of requests. But the refill rate ensures no client can sustain more than `refillRate` requests per second over time. This matches real user behavior -- people search in bursts, not at a constant rate.

### Algorithm 2: Sliding Window Log

The Sliding Window Log is the most precise rate-limiting algorithm, but also the most memory-intensive. Instead of counters, it stores the timestamp of every request.

> **Analogy:** Imagine you are a bouncer at a club with a "max 100 people per hour" rule. Instead of resetting your count every hour on the dot, you keep a list of exactly when each person entered. When someone new arrives, you look at your list and count how many people entered in the last 60 minutes from right now. If it is 99, they get in. If it is 100, they wait. The window slides with time -- it is always "the last 60 minutes from this moment."

```typescript
// rate-limiters/sliding-window-log.ts

/**
 * Sliding Window Log Rate Limiter
 *
 * Properties:
 * - Most accurate -- no boundary-burst problem
 * - High memory usage: stores every request timestamp
 * - Best for: low-volume, high-value endpoints (payments, auth)
 * - NOT suitable for high-throughput endpoints
 */
class SlidingWindowLog {
  private readonly windowMs: number;     // Window size in milliseconds
  private readonly maxRequests: number;  // Max requests per window
  private timestamps: number[];          // Sorted list of request timestamps

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.timestamps = [];
  }

  tryConsume(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Remove timestamps that have fallen outside the window.
    // Because timestamps are in order, we can binary search or
    // simply filter. For correctness and clarity, we filter:
    this.timestamps = this.timestamps.filter(ts => ts > windowStart);

    if (this.timestamps.length < this.maxRequests) {
      // Under the limit -- record this request and allow it
      this.timestamps.push(now);
      return true;
    }

    return false;  // At the limit -- reject
  }

  getRemaining(): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const activeCount = this.timestamps.filter(ts => ts > windowStart).length;
    return Math.max(0, this.maxRequests - activeCount);
  }
}

// ── Usage ────────────────────────────────────────────────
// For the payment endpoint: max 10 requests per 60 seconds
const paymentLimiter = new SlidingWindowLog(60_000, 10);

app.post('/api/v1/payments', (req, res, next) => {
  if (paymentLimiter.tryConsume()) {
    next();
  } else {
    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Payment rate limit: max 10 per minute.',
    });
  }
});
```

**The boundary-burst problem:** A fixed window counter resets at the boundary. If your window is "100 requests per minute" and resets at :00, a client can make 100 requests at :59 and another 100 at :00 -- 200 requests in 2 seconds. The Sliding Window Log does not have this problem because the window slides continuously.

**The memory problem:** At scale, storing every timestamp is expensive. If you have 1 million clients each making 100 requests per minute, that is 100 million timestamps in memory. For high-throughput endpoints (search, inventory checks), this is impractical. Use Token Bucket instead. Reserve the Sliding Window Log for low-volume, high-value endpoints like payments and authentication.

### Algorithm 3: Sliding Window Counter

The Sliding Window Counter is a hybrid that combines the accuracy of the Sliding Window Log with the memory efficiency of the Fixed Window Counter. It uses two adjacent fixed windows and interpolates between them.

> **Analogy:** Imagine you are tracking taxis at a stand. You know that between 2:00 and 3:00, 70 taxis arrived. Between 3:00 and 4:00 (so far, at 3:15), 15 taxis have arrived. If someone asks "how many taxis arrived in the last hour (from 2:15 to 3:15)?", you estimate: 75% of the 2:00-3:00 window (because 45 minutes of that hour falls in our range) = 52.5, plus 100% of the 3:00-3:15 window = 15. Total estimate: 67.5 taxis. Not exact, but very close and uses almost no memory.

```typescript
// rate-limiters/sliding-window-counter.ts

/**
 * Sliding Window Counter Rate Limiter
 *
 * Properties:
 * - Memory efficient: 2 counters per client (not N timestamps)
 * - Approximate but very close to the Sliding Window Log
 * - Great balance of accuracy and performance
 * - Used by: Redis-based rate limiters, Cloudflare
 */
class SlidingWindowCounter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private previousWindowCount: number;
  private currentWindowCount: number;
  private currentWindowStart: number;

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.previousWindowCount = 0;
    this.currentWindowCount = 0;
    this.currentWindowStart = this.getCurrentWindowStart();
  }

  tryConsume(): boolean {
    const now = Date.now();
    this.advanceWindow(now);

    // How far into the current window are we? (0.0 to 1.0)
    const elapsed = now - this.currentWindowStart;
    const windowProgress = elapsed / this.windowMs;

    // Weighted estimate: blend the previous window's count with the current
    // If we are 25% into the current window, we weight:
    //   75% of the previous window + 100% of the current window
    const previousWeight = 1 - windowProgress;
    const estimatedCount =
      (this.previousWindowCount * previousWeight) + this.currentWindowCount;

    if (estimatedCount < this.maxRequests) {
      this.currentWindowCount++;
      return true;
    }

    return false;  // Estimated rate exceeds limit
  }

  private advanceWindow(now: number): void {
    const windowStart = this.getCurrentWindowStart();

    if (windowStart !== this.currentWindowStart) {
      // We have moved to a new window
      if (windowStart - this.currentWindowStart >= this.windowMs * 2) {
        // Two or more windows have passed -- both windows are stale
        this.previousWindowCount = 0;
        this.currentWindowCount = 0;
      } else {
        // One window has passed -- rotate
        this.previousWindowCount = this.currentWindowCount;
        this.currentWindowCount = 0;
      }
      this.currentWindowStart = windowStart;
    }
  }

  private getCurrentWindowStart(): number {
    const now = Date.now();
    return now - (now % this.windowMs);
  }

  getEstimatedCount(): number {
    const now = Date.now();
    this.advanceWindow(now);
    const elapsed = now - this.currentWindowStart;
    const previousWeight = 1 - (elapsed / this.windowMs);
    return (this.previousWindowCount * previousWeight) + this.currentWindowCount;
  }
}

// ── Redis-backed Sliding Window Counter for distributed systems ──

import Redis from 'ioredis';

class DistributedSlidingWindowCounter {
  private redis: Redis;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(redis: Redis, windowMs: number, maxRequests: number) {
    this.redis = redis;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  /**
   * Check and increment atomically using a Lua script.
   * This ensures correctness even with multiple gateway instances.
   */
  async tryConsume(clientId: string): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    const previousWindow = currentWindow - 1;
    const windowProgress = (now % this.windowMs) / this.windowMs;

    const currentKey = `ratelimit:${clientId}:${currentWindow}`;
    const previousKey = `ratelimit:${clientId}:${previousWindow}`;

    // Lua script runs atomically on Redis -- no race conditions
    const luaScript = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
      local weight = tonumber(ARGV[1])
      local limit = tonumber(ARGV[2])
      local window_seconds = tonumber(ARGV[3])

      local estimated = previous * weight + current

      if estimated < limit then
        redis.call('INCR', KEYS[1])
        redis.call('EXPIRE', KEYS[1], window_seconds * 2)
        return {1, limit - estimated - 1}
      else
        return {0, 0}
      end
    `;

    const result = await this.redis.eval(
      luaScript,
      2,                                     // Number of KEYS
      currentKey,                            // KEYS[1]
      previousKey,                           // KEYS[2]
      (1 - windowProgress).toFixed(4),       // ARGV[1]: previous window weight
      this.maxRequests.toString(),           // ARGV[2]: limit
      Math.ceil(this.windowMs / 1000).toString()  // ARGV[3]: window in seconds
    ) as [number, number];

    return {
      allowed: result[0] === 1,
      remaining: result[1],
    };
  }
}

// ── Usage with Redis (production) ────────────────────────
const redis = new Redis({ host: 'redis-cluster', port: 6379 });
const rateLimiter = new DistributedSlidingWindowCounter(redis, 60_000, 1000);

app.use(async (req, res, next) => {
  const clientId = req.ip || 'unknown';
  const { allowed, remaining } = await rateLimiter.tryConsume(clientId);

  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Limit', 1000);

  if (allowed) {
    next();
  } else {
    res.status(429).json({ error: 'Rate limit exceeded' });
  }
});
```

### Comparing the Three Algorithms

| Algorithm | Memory per Client | Accuracy | Burst Handling | Best For |
|---|---|---|---|---|
| Token Bucket | 3 numbers (tokens, timestamp, capacity) | Good -- allows controlled bursts | Built-in burst support | General-purpose rate limiting |
| Sliding Window Log | N timestamps (one per request) | Exact | No special burst handling | Low-volume, high-value endpoints |
| Sliding Window Counter | 2 counters + 1 timestamp | Very good (approximate) | No special burst handling | High-throughput distributed systems |

> **Checkpoint:** A client makes 95 requests in one minute, then goes quiet for 30 seconds, then makes 120 requests in the next 30 seconds. Which algorithm would allow the burst of 120? (Answer: The Token Bucket, if configured with a capacity of 120+ tokens and a refill rate of 100 tokens/minute. The bucket would have accumulated ~50 extra tokens during the quiet period, allowing a burst above the per-minute average. The Sliding Window algorithms would reject requests once the count exceeds the limit.)

---

## Request Validation at the Gateway Level

Most developers validate requests inside their service handlers. That works, but it means malformed requests travel through the gateway, through the load balancer, through the network, to the service, only to be rejected. At 100,000 requests per minute, rejecting garbage at the front door saves enormous resources downstream.

### The Naive Approach

```typescript
// ❌ Validation only inside the service
app.post('/api/v1/bookings', async (req, res) => {
  const { hotelId, checkIn, checkOut, guests } = req.body;

  if (!hotelId) return res.status(400).json({ error: 'hotelId is required' });
  if (!checkIn) return res.status(400).json({ error: 'checkIn is required' });
  // ... more validation ...

  // By the time we get here, the request has already consumed
  // gateway bandwidth, network hops, and a connection slot.
});
```

### Why It Breaks at Scale

A bot sends 50,000 malformed requests per second. Every single one reaches your Booking Service, consumes a connection from the pool, triggers validation logic, and returns a 400 error. Your service is spending half its CPU validating junk instead of creating bookings.

### The Correct Approach: Validate at the Gateway

```typescript
// gateway/middleware/request-validator.ts

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
addFormats(ajv);  // Adds 'date', 'email', 'uri', etc.

// ── JSON Schema for the Create Booking endpoint ──────────
const createBookingSchema = {
  type: 'object',
  required: ['hotelId', 'checkIn', 'checkOut', 'guests'],
  properties: {
    hotelId: {
      type: 'string',
      pattern: '^[A-Z]{2,5}-\\d{3,6}$',  // e.g., "TOKYO-042"
      description: 'Hotel identifier in REGION-NUMBER format',
    },
    checkIn: {
      type: 'string',
      format: 'date',  // ISO 8601 date (YYYY-MM-DD)
    },
    checkOut: {
      type: 'string',
      format: 'date',
    },
    guests: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
    },
    roomType: {
      type: 'string',
      enum: ['standard', 'deluxe', 'suite', 'penthouse'],
    },
    specialRequests: {
      type: 'string',
      maxLength: 500,  // Prevent payload abuse
    },
  },
  additionalProperties: false,  // Reject unknown fields
};

const validateCreateBooking = ajv.compile(createBookingSchema);

// ── Schema registry: map of route -> method -> validator ──
const schemaRegistry = new Map<string, Map<string, ReturnType<typeof ajv.compile>>>();

// Register: POST /api/v1/bookings
const bookingSchemas = new Map();
bookingSchemas.set('POST', validateCreateBooking);
schemaRegistry.set('/api/v1/bookings', bookingSchemas);

// ── Gateway middleware ───────────────────────────────────
function requestValidationMiddleware(req: Request, res: Response, next: NextFunction) {
  // Only validate requests with a body
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
    return next();
  }

  // Find the validator for this route + method
  const routeSchemas = schemaRegistry.get(req.path);
  if (!routeSchemas) return next();  // No schema registered -- pass through

  const validator = routeSchemas.get(req.method);
  if (!validator) return next();

  // Validate
  const valid = validator(req.body);

  if (!valid) {
    return res.status(400).json({
      error: 'Validation Failed',
      message: 'The request body does not match the expected schema.',
      details: validator.errors?.map(err => ({
        field: err.instancePath || err.params?.missingProperty || 'unknown',
        message: err.message,
        value: err.data,
      })),
    });
  }

  next();  // Validation passed -- forward to the service
}

// Apply BEFORE routing to services
app.use(requestValidationMiddleware);
```

Now malformed requests never leave the gateway. They get a 400 response in microseconds, and your downstream services only receive well-formed, schema-compliant payloads.

> **What If You Skip This?** Without gateway-level validation, every malformed request consumes resources across your entire stack -- network bandwidth, connection pool slots, CPU for parsing and validation. A single misbehaving client or a bot attack can degrade service performance for all users, even though none of the garbage requests would ever succeed.

### Prisma Schema for Rate Limit Tracking

For persistent rate-limit tracking (e.g., per-user daily limits that survive gateway restarts), you can store rate-limit state in the database:

**SQL:**
```sql
CREATE TABLE rate_limit_records (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(255) NOT NULL,
    endpoint VARCHAR(255) NOT NULL,
    window_start TIMESTAMP NOT NULL,
    request_count INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_client_window (client_id, endpoint, window_start),
    INDEX idx_window (window_start),
    INDEX idx_client (client_id)
);
```

**Prisma Schema:**
```prisma
model RateLimitRecord {
  id           BigInt   @id @default(autoincrement())
  clientId     String   @map("client_id") @db.VarChar(255)
  endpoint     String   @db.VarChar(255)
  windowStart  DateTime @map("window_start")
  requestCount Int      @default(1) @map("request_count")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  @@unique([clientId, endpoint, windowStart])
  @@index([windowStart])
  @@index([clientId])
  @@map("rate_limit_records")
}
```

**Prisma Client Usage:**
```typescript
// Increment the counter for the current window (upsert pattern)
const windowStart = new Date(Date.now() - (Date.now() % 60_000)); // Current minute

const record = await prisma.rateLimitRecord.upsert({
  where: {
    clientId_endpoint_windowStart: {
      clientId: clientIp,
      endpoint: '/api/v1/bookings',
      windowStart,
    },
  },
  update: {
    requestCount: { increment: 1 },
  },
  create: {
    clientId: clientIp,
    endpoint: '/api/v1/bookings',
    windowStart,
    requestCount: 1,
  },
});

if (record.requestCount > MAX_REQUESTS_PER_MINUTE) {
  // Rate limited
}
```

---

## Load Balancing Strategies -- Distributing Traffic Across Instances

When you have three instances of the Booking Service, someone needs to decide which instance handles each request. That "someone" is the load balancer, and there are four primary algorithms. Each makes a different trade-off.

### Strategy 1: Round Robin

The simplest algorithm. Requests go to servers in rotation: A, B, C, A, B, C, A...

```typescript
// load-balancers/round-robin.ts

class RoundRobinBalancer {
  private servers: string[];
  private currentIndex: number;

  constructor(servers: string[]) {
    this.servers = servers;
    this.currentIndex = 0;
  }

  getNextServer(): string {
    const server = this.servers[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.servers.length;
    return server;
  }

  /** Remove a failed server from the pool */
  removeServer(server: string): void {
    this.servers = this.servers.filter(s => s !== server);
    if (this.currentIndex >= this.servers.length) {
      this.currentIndex = 0;
    }
  }

  /** Add a recovered server back to the pool */
  addServer(server: string): void {
    if (!this.servers.includes(server)) {
      this.servers.push(server);
    }
  }
}

// Usage
const balancer = new RoundRobinBalancer([
  'booking-service-1:3000',
  'booking-service-2:3000',
  'booking-service-3:3000',
]);

app.use('/api/v1/bookings', (req, res) => {
  const target = balancer.getNextServer();
  // Forward request to target...
});
```

**Pros:** Dead simple. No state to track. Zero overhead.

**Cons:** Assumes all servers are equally powerful and all requests are equally expensive. A complex booking creation (heavy DB query) gets the same weight as a simple status check. If Server B is a weaker machine, it gets overwhelmed while A and C have spare capacity.

### Strategy 2: Weighted Round Robin

Each server gets a weight. Higher weight = more traffic. This accounts for heterogeneous hardware.

```typescript
// load-balancers/weighted-round-robin.ts

interface WeightedServer {
  address: string;
  weight: number;        // Higher = more traffic
}

class WeightedRoundRobinBalancer {
  private servers: WeightedServer[];
  private currentWeights: number[];
  private totalWeight: number;

  constructor(servers: WeightedServer[]) {
    this.servers = servers;
    this.currentWeights = servers.map(() => 0);
    this.totalWeight = servers.reduce((sum, s) => sum + s.weight, 0);
  }

  /**
   * Smooth Weighted Round Robin (NGINX algorithm)
   * Distributes load evenly over time, avoiding bursts to any single server.
   */
  getNextServer(): string {
    // Step 1: Add each server's weight to its current weight
    for (let i = 0; i < this.servers.length; i++) {
      this.currentWeights[i] += this.servers[i].weight;
    }

    // Step 2: Pick the server with the highest current weight
    let maxIndex = 0;
    for (let i = 1; i < this.currentWeights.length; i++) {
      if (this.currentWeights[i] > this.currentWeights[maxIndex]) {
        maxIndex = i;
      }
    }

    // Step 3: Subtract the total weight from the selected server
    this.currentWeights[maxIndex] -= this.totalWeight;

    return this.servers[maxIndex].address;
  }
}

// Usage: Server 1 gets 5x more traffic than Server 3
const balancer = new WeightedRoundRobinBalancer([
  { address: 'booking-1:3000', weight: 5 },  // 50% of traffic
  { address: 'booking-2:3000', weight: 3 },  // 30% of traffic
  { address: 'booking-3:3000', weight: 2 },  // 20% of traffic
]);
```

**Pros:** Accounts for different server capacities. The NGINX smooth weighted algorithm distributes requests evenly (not "5 to A, then 3 to B, then 2 to C" -- it interleaves them).

**Cons:** Weights are static. If a server slows down due to garbage collection or a noisy neighbor, the weight does not adapt.

### Strategy 3: Least Connections

Send each request to the server with the fewest active (in-flight) connections. This naturally adapts to servers that are slow or fast.

```typescript
// load-balancers/least-connections.ts

interface ServerState {
  address: string;
  activeConnections: number;
}

class LeastConnectionsBalancer {
  private servers: ServerState[];

  constructor(addresses: string[]) {
    this.servers = addresses.map(address => ({
      address,
      activeConnections: 0,
    }));
  }

  getNextServer(): string {
    // Find the server with the fewest active connections
    let minServer = this.servers[0];
    for (const server of this.servers) {
      if (server.activeConnections < minServer.activeConnections) {
        minServer = server;
      }
    }

    minServer.activeConnections++;
    return minServer.address;
  }

  /** Call this when a request completes (success or error) */
  releaseConnection(address: string): void {
    const server = this.servers.find(s => s.address === address);
    if (server && server.activeConnections > 0) {
      server.activeConnections--;
    }
  }
}

// Usage
const balancer = new LeastConnectionsBalancer([
  'booking-1:3000',
  'booking-2:3000',
  'booking-3:3000',
]);

app.use('/api/v1/bookings', async (req, res) => {
  const target = balancer.getNextServer();
  try {
    const response = await forwardRequest(target, req);
    res.json(response);
  } finally {
    balancer.releaseConnection(target);  // Always release, even on error
  }
});
```

**Pros:** Self-adapting. Slow servers naturally accumulate connections and get fewer new requests. No manual tuning required.

**Cons:** Requires tracking connection state. Slightly more overhead than Round Robin. Can be fooled by keep-alive connections that are idle but counted as "active."

### Strategy 4: IP Hash

Hash the client's IP address to determine which server handles the request. The same client always goes to the same server (sticky sessions).

```typescript
// load-balancers/ip-hash.ts

class IpHashBalancer {
  private servers: string[];

  constructor(servers: string[]) {
    this.servers = servers;
  }

  getNextServer(clientIp: string): string {
    const hash = this.hashIp(clientIp);
    const index = hash % this.servers.length;
    return this.servers[index];
  }

  /**
   * DJB2 hash function -- fast, good distribution.
   * Used by NGINX for ip_hash directive.
   */
  private hashIp(ip: string): number {
    let hash = 5381;
    for (let i = 0; i < ip.length; i++) {
      hash = ((hash << 5) + hash) + ip.charCodeAt(i);  // hash * 33 + char
      hash = hash & hash;  // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

// Usage: same client IP always reaches the same server
const balancer = new IpHashBalancer([
  'payment-1:3000',
  'payment-2:3000',
]);

app.use('/api/v1/payments', (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || '0.0.0.0';
  const target = balancer.getNextServer(clientIp);
  // Forward request to target...
});
```

**Pros:** Session affinity without cookies or external state. Good for payment flows where multi-step processes benefit from hitting the same server.

**Cons:** Poor distribution if many clients share the same IP (e.g., users behind a corporate proxy). Adding or removing a server rehashes almost all clients, causing cache misses and session disruption.

### Load Balancing Comparison

| Strategy | Complexity | Adaptiveness | Session Affinity | Best For |
|---|---|---|---|---|
| Round Robin | Lowest | None | No | Stateless, homogeneous servers |
| Weighted Round Robin | Low | None (static weights) | No | Heterogeneous server hardware |
| Least Connections | Medium | Self-adapting | No | Variable request processing times |
| IP Hash | Low | None | Yes (by IP) | Payment sessions, stateful workflows |

> **Analogy:** Round Robin is like dealing cards -- everyone gets one in turn regardless of who has the most. Weighted Round Robin is like dealing more cards to players with bigger hands. Least Connections is like sending the next customer to whichever cashier has the shortest line. IP Hash is like assigning each customer a "personal banker" based on their account number -- they always go to the same person.

---