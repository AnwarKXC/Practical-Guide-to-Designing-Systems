# PART V: SECURITY & COMPLIANCE

Security is not a feature you bolt on at the end -- it is a foundation you build from day one. A global booking platform handles sensitive personal data (names, emails, passport numbers), processes financial transactions across multiple payment providers, and must comply with regional privacy regulations like GDPR, CCPA, and PCI-DSS. A single breach can destroy customer trust overnight and trigger regulatory fines that threaten the business.

This part covers three pillars of platform security. First, Section 23 introduces a layered security architecture: network-level controls (mTLS, Kubernetes network policies), application-level defenses (input validation, rate limiting, security headers), and data-level protections (encryption, secret management). Second, Section 24 tackles fraud detection -- because a booking platform that processes payments is a magnet for stolen credit cards, account takeovers, and bot attacks. You will study a real-time risk scoring engine that evaluates transactions before they reach the payment gateway. Third, Section 25 addresses GDPR and data privacy compliance, including the technically challenging "right to be forgotten" workflow that must purge user data from databases, caches, and audit logs while preserving legally required records.

Throughout these sections, the guiding principle is defense in depth: no single layer is sufficient, and every layer assumes the others may fail. Authentication stops unauthorized access, but input validation catches malicious payloads that slip through. Rate limiting slows attackers, but fraud detection catches the ones who stay under the rate limit. Encryption protects data at rest and in transit, but GDPR compliance ensures you do not hold data longer than necessary.

---

## 23. Security Architecture

> **Learning Objectives**
> - Understand why security in a booking platform must be layered across network, application, and data levels.
> - Identify the role of Helmet.js, rate limiting, and input sanitization as application-level defenses.
> - Read and interpret a Kubernetes NetworkPolicy that restricts inter-service communication.
> - Explain how secret management with caching reduces both latency and exposure risk.
> - Recognize OWASP Top 10 considerations specific to booking and payment systems.

**Why:** A booking platform processes financial transactions and personal data across regions. Security must be layered: network-level (mTLS, network policies), application-level (input validation, output encoding), and data-level (encryption, tokenization).

### Security Middleware Stack

- Input validation and sanitization middleware
- SQL injection prevention (parameterized queries everywhere)
- XSS prevention with output encoding
- Secret management with AWS Secrets Manager / Vault
- mTLS between services (Istio handles this)
- Network policies (Kubernetes)
- Helmet.js security headers
- OWASP Top 10 considerations for booking systems

```typescript
// Security middleware stack
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export function configureSecurityMiddleware(app: Express) {
  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'none'"],
        frameSrc: ["'none'"]
      }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  }));

  // Request size limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Rate limiting per API endpoint category
  app.use('/api/bookings', rateLimit({
    windowMs: 60 * 1000,       // 1-minute window
    max: 100,                   // 100 booking requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
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

### Input Validation

```typescript
export class InputSanitizer {
  static sanitizeString(input: string): string {
    return input
      .replace(/[<>]/g, '')          // Remove angle brackets
      .replace(/javascript:/gi, '')   // Remove JS protocol
      .replace(/on\w+=/gi, '')       // Remove event handlers
      .trim()
      .substring(0, 10000);          // Max length
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

### Secret Management

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export class SecretManager {
  private readonly client = new SecretsManagerClient({ region: process.env.REGION });
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly cacheTTL = 300000; // 5 minutes

  async getSecret(secretName: string): Promise<string> {
    const cached = this.cache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await this.client.send(command);
    const value = response.SecretString!;

    this.cache.set(secretName, {
      value,
      expiresAt: Date.now() + this.cacheTTL
    });

    return value;
  }
}
```

### Network Policy

```yaml
# Kubernetes Network Policy -- only allow booking-service to talk to inventory/payment
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: booking-service-netpol
  namespace: production
spec:
  podSelector:
    matchLabels:
      app: booking-service
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: api-gateway
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: inventory-service
        - podSelector:
            matchLabels:
              app: payment-service
        - podSelector:
            matchLabels:
              app: notification-service
      ports:
        - protocol: TCP
          port: 3000
    - to:  # Allow DNS
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
```

### Key Takeaways

- Security must be layered: network-level (mTLS, NetworkPolicy), application-level (Helmet.js, rate limiting, input validation), and data-level (encryption, secret management). No single layer is sufficient on its own.
- Rate limiting should be tuned per endpoint category -- authentication endpoints need much stricter limits (20 per 15 minutes) than booking endpoints (100 per minute) because brute-force attacks target auth flows.
- Kubernetes NetworkPolicies enforce zero-trust networking by explicitly whitelisting which pods can communicate, preventing lateral movement if one service is compromised.
- Secrets should never be stored in environment variables or code. Use a managed secret store (AWS Secrets Manager, HashiCorp Vault) with a short-lived cache to balance security and performance.

### Review Questions

1. In the `configureSecurityMiddleware` function, the `/api/auth` endpoint has a 15-minute window with a max of 20 requests, while `/api/bookings` has a 1-minute window with a max of 100. Why are these limits configured so differently? What attack vector does each limit address?
2. The `InputSanitizer.sanitizeString` method removes angle brackets, `javascript:` protocol strings, and event handler attributes. Which specific OWASP Top 10 vulnerability does this mitigate, and can you think of an edge case this sanitizer might miss?
3. Examine the Kubernetes NetworkPolicy YAML. Why does the egress section include a separate rule allowing UDP port 53 to all namespaces? What would happen if this rule were removed?

### Hands-On Exercise

Extend the `configureSecurityMiddleware` function to add a third rate limiter for a `/api/search` endpoint. Search is read-heavy and tolerates higher throughput, but an attacker could abuse it to scrape inventory data. Choose a window size and max request count that balances usability with protection. Then write a brief justification (3-4 sentences) for your chosen values, explaining the trade-offs compared to the booking and auth limits.

---

## 24. Fraud Detection

> **Learning Objectives**
> - Explain why booking platforms are high-value targets for fraud (stolen cards, account takeover, bot attacks).
> - Trace the flow of a transaction through a multi-rule risk scoring engine and understand how individual rule scores combine into a final decision.
> - Distinguish between the four fraud statuses (passed, flagged, under_review, blocked) and the thresholds that trigger each.
> - Read the database schema for fraud checks and device fingerprints to understand how fraud data is stored and queried.

**Why:** Booking platforms are targets for fraud: stolen credit cards, account takeover, and bot attacks. Real-time scoring catches suspicious transactions before payment processing.

### Fraud Detection Service with Risk Scoring

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

    // 1. IP Country Mismatch (30 points)
    const ipCountry = await this.getCountryFromIP(params.ipAddress);
    const billingCountry = await this.getBillingCountry(params.userId);
    if (ipCountry !== billingCountry) {
      riskScore += 30;
      triggeredRules.push('ip_country_mismatch');
    }

    // 2. Velocity Check -- bookings per hour (40 points)
    const recentBookings = await this.getRecentBookings(params.userId, 60);
    if (recentBookings.length >= 5) {
      riskScore += 40;
      triggeredRules.push('high_velocity');
    }

    // 3. Amount Threshold (45 points)
    if (params.amount > 5000) {
      riskScore += 45;
      triggeredRules.push('high_amount');
    }

    // 4. Device Reputation
    const deviceRisk = await this.checkDeviceReputation(params.deviceFingerprint);
    riskScore += deviceRisk.score;
    if (deviceRisk.score > 0) triggeredRules.push('device_risk');

    // 5. Email Reputation
    const emailRisk = await this.checkEmailReputation(params.email);
    riskScore += emailRisk.score;
    if (emailRisk.score > 0) triggeredRules.push('email_risk');

    // 6. BIN Lookup
    const binRisk = await this.checkCardBIN(params.cardBIN);
    riskScore += binRisk.score;
    if (binRisk.score > 0) triggeredRules.push('bin_risk');

    // Determine status based on score thresholds
    let status: FraudStatus;
    if (riskScore >= 80) status = 'blocked';
    else if (riskScore >= 50) status = 'under_review';
    else if (riskScore >= 25) status = 'flagged';
    else status = 'passed';

    // Save fraud check record
    await this.saveFraudCheck({
      userId: params.userId,
      riskScore,
      triggeredRules,
      status,
      ipAddress: params.ipAddress,
      deviceFingerprint: params.deviceFingerprint
    });

    // Alert fraud team for high-risk transactions
    if (status === 'blocked' || status === 'under_review') {
      await this.alertFraudTeam(params.userId, riskScore, triggeredRules);
    }

    return { status, riskScore, triggeredRules, canProceed: status !== 'blocked' };
  }
}
```

### Fraud Check Database Tables

```sql
CREATE TABLE fraud_checks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    booking_id BIGINT,

    risk_score SMALLINT NOT NULL,
    status ENUM('passed', 'flagged', 'under_review', 'blocked') NOT NULL,
    triggered_rules JSON NOT NULL,

    ip_address VARCHAR(45),
    user_agent TEXT,
    device_fingerprint VARCHAR(64),

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    reviewed_by BIGINT,
    review_notes TEXT,

    INDEX idx_user (user_id, created_at),
    INDEX idx_status (status, created_at),
    INDEX idx_score (risk_score)
);

CREATE TABLE device_fingerprints (
    fingerprint_hash VARCHAR(64) PRIMARY KEY,
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    seen_count INT DEFAULT 1,
    associated_users JSON,
    risk_level ENUM('low', 'medium', 'high') DEFAULT 'low',

    INDEX idx_risk (risk_level)
);
```

### Key Takeaways

- Fraud detection must happen in real time, before the payment is processed -- not after the money has left the account. The scoring engine runs inline with the booking flow.
- A cumulative scoring approach is more robust than hard binary rules. A single signal (e.g., IP mismatch) may have an innocent explanation, but multiple weak signals together (IP mismatch + high amount + new device) paint a clear picture.
- The four-tier status system (passed, flagged, under_review, blocked) provides graduated responses. Only "blocked" prevents the transaction entirely; "under_review" allows processing while queuing a human review, which reduces false positives that frustrate legitimate customers.
- Storing fraud check records with triggered rules and scores creates an audit trail that lets the fraud team tune thresholds over time based on actual false-positive and false-negative rates.
- The `device_fingerprints` table tracks device reputation across users, which is critical for detecting when a single device is used to create multiple fraudulent accounts.

### Review Questions

1. A transaction triggers `ip_country_mismatch` (30 points) and `high_amount` (45 points) but no other rules. What status does it receive? Would the transaction proceed? Walk through the threshold logic.
2. The velocity check awards 40 points if a user has made 5 or more bookings in the past 60 minutes. Why might a legitimate business traveler or travel agent trigger this rule? How could the system reduce false positives for known high-volume users without weakening the rule for new accounts?
3. Looking at the `fraud_checks` table schema, three indexes are defined: `idx_user`, `idx_status`, and `idx_score`. Explain one concrete query that each index is optimized for.

### Hands-On Exercise

Design a seventh fraud rule called `new_account_high_value`. This rule should add risk points when a newly created account (less than 24 hours old) attempts a booking above a configurable dollar threshold. Write the TypeScript code for this rule following the pattern established by the existing six rules. Choose a point value and justify it relative to the existing rule weights, explaining how it interacts with the threshold boundaries (25, 50, 80).

---

## 25. GDPR & Data Privacy

> **Learning Objectives**
> - Articulate the legal requirements behind GDPR's "right to be forgotten" and why non-compliance carries fines up to 4% of global revenue.
> - Trace the deletion workflow through database transactions, Redis session cleanup, and audit logging.
> - Explain why `SCAN` is used instead of `KEYS` for Redis cleanup in production, and the performance implications of each.
> - Distinguish between hard deletion, soft deletion, and anonymization, and identify when each is appropriate.
> - Understand how PII hashing with a salt preserves audit integrity without retaining identifiable data.

**Why:** European regulations require data portability, right to be forgotten, and consent tracking. Non-compliance carries fines up to 4% of global revenue.

### Right to Be Forgotten Implementation

- Right to be forgotten implementation
- Data anonymization
- PII hashing
- Deletion request audit log

```typescript
export class GDPRService {
  async deleteUserData(userId: bigint, email: string): Promise<DeletionResult> {
    const connection = await db.getConnection();
    const deletedTables: string[] = [];

    try {
      await connection.beginTransaction();

      // Create deletion request audit record
      const [reqResult] = await connection.execute(`
        INSERT INTO gdpr_deletion_requests (user_id, email_hash, status)
        VALUES (?, ?, 'processing')
      `, [userId, this.hashPII(email, 'email')]);

      const requestId = reqResult.insertId;

      // Delete device fingerprints associated with user
      await connection.execute(`
        DELETE FROM device_fingerprints
        WHERE fingerprint_hash IN (
          SELECT DISTINCT device_fingerprint
          FROM fraud_checks WHERE user_id = ?
        )
      `, [userId]);
      deletedTables.push('device_fingerprints');

      // Anonymize fraud data (keep aggregate stats)
      await connection.execute(`
        UPDATE fraud_checks
        SET ip_address = '0.0.0.0',
            user_agent = 'ANONYMIZED',
            device_fingerprint = 'DELETED'
        WHERE user_id = ?
      `, [userId]);
      deletedTables.push('fraud_checks');

      // Soft-delete bookings (keep for legal/accounting obligations)
      await connection.execute(`
        UPDATE bookings
        SET deleted_at = NOW()
        WHERE user_id = ? AND deleted_at IS NULL
      `, [userId]);
      deletedTables.push('bookings');

      // Clear user sessions from Redis using SCAN (never use KEYS in production)
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'session:*', 'COUNT', 100);
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

      // Mark request as completed
      await connection.execute(`
        UPDATE gdpr_deletion_requests
        SET processed_at = NOW(), status = 'completed', deleted_tables = ?
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

### GDPR Deletion Request Table

```sql
CREATE TABLE gdpr_deletion_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    email_hash VARCHAR(64) NOT NULL,

    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',

    deleted_tables JSON,
    error_message TEXT,

    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,

    INDEX idx_user (user_id),
    INDEX idx_status (status)
);
```

### Key Takeaways

- GDPR deletion is not a simple `DELETE FROM users WHERE id = ?`. Different data categories require different treatment: personal identifiers are removed, fraud analytics are anonymized (to preserve aggregate security data), and bookings are soft-deleted (because financial records have legal retention requirements).
- The Redis session cleanup uses `SCAN` with a cursor-based approach instead of `KEYS` because `KEYS` blocks the Redis event loop and can cause a full production outage on large datasets. `SCAN` iterates incrementally with minimal performance impact.
- The audit trail itself must not contain PII. The `email_hash` field stores a salted SHA-256 hash of the email, which proves the deletion was performed for a specific user without retaining the actual email address.
- Wrapping the entire operation in a database transaction ensures atomicity: if any step fails, the partial deletion is rolled back and the request is not marked as completed, preventing a state where some data is deleted but the audit record says the operation never happened.
- The `hashPII` method uses a category prefix (`email:`, etc.) in the hash input to prevent cross-category hash collisions, and lowercases the input to ensure consistent hashing regardless of how the user originally entered their data.

### Review Questions

1. In the `deleteUserData` method, bookings are soft-deleted (`SET deleted_at = NOW()`) while device fingerprints are hard-deleted (`DELETE FROM`). Why the different treatment? Under what legal or business obligation might you need to retain booking records even after a GDPR deletion request?
2. The Redis session cleanup loop uses `SCAN` with `COUNT 100`. What does the `COUNT` parameter control, and what would happen if you set it to `COUNT 1000000`? Would it defeat the purpose of using `SCAN` over `KEYS`?
3. If the `PII_SALT` environment variable is not set, the `hashPII` method throws an error rather than falling back to unsalted hashing. Why is this an explicit failure the correct design choice?

### Hands-On Exercise

The current `deleteUserData` implementation handles `device_fingerprints`, `fraud_checks`, `bookings`, and Redis sessions. But a real platform also stores user data in notification preferences, saved payment methods, and search history tables. Extend the method to handle two additional tables: `notification_preferences` (should be hard-deleted) and `saved_payment_methods` (should be anonymized by replacing card details with `'REDACTED'` while keeping the record for chargeback reference). Write the SQL statements and add them to the transaction in the appropriate order.

---

# PART VI: OBSERVABILITY & OPERATIONS

You can't fix what you can't see. In a distributed system processing 100,000 bookings per minute across multiple regions, a problem in one service can cascade through the entire platform in seconds. By the time a user reports a failed booking, hundreds or thousands more may have already failed. Proactive observability -- the ability to understand the internal state of your system from its external outputs -- is the difference between a 30-second detection and a 30-minute outage.

This part covers the three pillars of observability and the operational processes that use them. Section 26 introduces metrics and alerting with Prometheus, including a tiered alert system that distinguishes between critical incidents (page the on-call engineer immediately), warnings (investigate within the hour), and informational signals (review during business hours). Section 27 covers distributed tracing with OpenTelemetry, which lets you follow a single booking request as it traverses the API gateway, booking service, inventory service, and payment service -- pinpointing exactly where latency spikes or errors occur. Section 28 formalizes Service Level Objectives (SLOs) and error budgets, giving teams a shared language for reliability targets.

Sections 29 and 30 shift from detection to response. Section 29 defines a structured incident response process with severity levels, escalation paths, and blameless post-mortems, because detecting a problem is only half the battle -- resolving it quickly and learning from it is the other half. Section 30 covers disaster recovery: RPO/RTO targets, multi-region failover procedures, and a testing schedule that ensures your disaster recovery plan actually works when you need it. Together, these sections transform observability data into operational action.

---

## 26. Monitoring & Alerting

> **Learning Objectives**
> - Understand the three pillars of observability (metrics, logs, traces) and why metrics are the first line of defense for proactive monitoring.
> - Read and interpret Prometheus metric definitions including Histograms, Counters, and Gauges, and know when to use each type.
> - Analyze a 3-tier alert rule configuration and explain why different severities require different response times and escalation paths.
> - Explain how histogram buckets are chosen and why the bucket boundaries for booking creation time differ from those for payment latency.
> - Identify the purpose of the `/metrics` endpoint in a Prometheus-based monitoring architecture.

**Why:** At 100,000 bookings/minute, you can't wait for users to report problems. Proactive monitoring catches issues before they impact customers. The three pillars of observability -- metrics, logs, and traces -- provide different lenses into system health.

### Prometheus Metrics

```typescript
import promClient from 'prom-client';

export class MetricsService {
  private static registry = new promClient.Registry();

  // Booking metrics
  static bookingCreationTime = new promClient.Histogram({
    name: 'booking_creation_duration_seconds',
    help: 'Time to create booking',
    labelNames: ['booking_type', 'status', 'region'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30]
  });

  static bookingCounter = new promClient.Counter({
    name: 'bookings_total',
    help: 'Total bookings',
    labelNames: ['booking_type', 'status', 'region']
  });

  static bookingRevenue = new promClient.Counter({
    name: 'booking_revenue_total',
    help: 'Total booking revenue',
    labelNames: ['booking_type', 'currency']
  });

  // Inventory metrics
  static inventoryOversellCounter = new promClient.Counter({
    name: 'inventory_oversell_attempts_total',
    help: 'Oversell attempts prevented',
    labelNames: ['resource_type']
  });

  static lockContentionCounter = new promClient.Counter({
    name: 'lock_contention_total',
    help: 'Lock acquisition failures',
    labelNames: ['resource_type']
  });

  // Payment metrics
  static paymentLatency = new promClient.Histogram({
    name: 'payment_duration_seconds',
    help: 'Payment processing time',
    labelNames: ['provider', 'status'],
    buckets: [0.5, 1, 2, 5, 10]
  });

  static paymentFailureRate = new promClient.Gauge({
    name: 'payment_failure_rate',
    help: 'Payment failure rate (rolling 5 min)',
    labelNames: ['provider']
  });

  // Circuit breaker metrics
  static circuitBreakerState = new promClient.Gauge({
    name: 'circuit_breaker_state',
    help: 'Circuit breaker state (0=closed, 1=open, 0.5=half-open)',
    labelNames: ['service', 'supplier']
  });

  static {
    this.registry.registerMetric(this.bookingCreationTime);
    this.registry.registerMetric(this.bookingCounter);
    this.registry.registerMetric(this.bookingRevenue);
    this.registry.registerMetric(this.inventoryOversellCounter);
    this.registry.registerMetric(this.lockContentionCounter);
    this.registry.registerMetric(this.paymentLatency);
    this.registry.registerMetric(this.paymentFailureRate);
    this.registry.registerMetric(this.circuitBreakerState);

    promClient.collectDefaultMetrics({ register: this.registry });
  }

  static async getMetrics(): Promise<string> {
    return await this.registry.metrics();
  }
}

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', MetricsService.registry.contentType);
  res.end(await MetricsService.getMetrics());
});
```

### 3-Tier Alert Rules (Critical, Warning, Info)

```typescript
export const alertRules = {
  critical: [
    {
      name: 'BookingSuccessRateCritical',
      expr: 'rate(bookings_total{status="success"}[5m]) / rate(bookings_total[5m]) < 0.995',
      for: '2m',
      severity: 'critical',
      annotations: {
        summary: 'Booking success rate below 99.5%',
        runbook: 'https://runbooks.company.com/booking-failures'
      }
    },
    {
      name: 'InventoryOversellDetected',
      expr: 'increase(inventory_oversell_attempts_total[1m]) > 0',
      for: '0s',
      severity: 'critical',
      annotations: { summary: 'Inventory oversell detected' }
    },
    {
      name: 'PaymentGatewayDown',
      expr: 'up{job="payment-gateway"} == 0',
      for: '1m',
      severity: 'critical'
    },
    {
      name: 'DatabasePrimaryDown',
      expr: 'mysql_up{role="primary"} == 0',
      for: '30s',
      severity: 'critical'
    },
    {
      name: 'KafkaBrokerDown',
      expr: 'kafka_broker_online{} == 0',
      for: '2m',
      severity: 'critical'
    }
  ],
  warning: [
    {
      name: 'PaymentLatencyHigh',
      expr: 'histogram_quantile(0.95, rate(payment_duration_seconds_bucket[5m])) > 2',
      for: '5m',
      severity: 'warning'
    },
    {
      name: 'LockContentionHigh',
      expr: 'rate(lock_contention_total[5m]) > 100',
      for: '10m',
      severity: 'warning'
    },
    {
      name: 'DatabaseReplicationLag',
      expr: 'mysql_slave_lag_seconds > 30',
      for: '3m',
      severity: 'warning'
    }
  ],
  info: [
    {
      name: 'BookingVolumeSpike',
      expr: 'rate(bookings_total[5m]) > avg_over_time(rate(bookings_total[5m])[1h]) * 1.5',
      for: '10m',
      severity: 'info'
    }
  ]
};
```

### Key Takeaways

- Prometheus metric types serve different purposes: Counters track cumulative totals (bookings, revenue), Histograms capture latency distributions with configurable buckets, and Gauges represent current values that can go up or down (failure rates, circuit breaker state).
- The 3-tier alert system prevents alert fatigue. Critical alerts (booking success rate below 99.5%, oversell detected, infrastructure down) page engineers immediately. Warning alerts (high latency, replication lag) require investigation but not a 3 AM wake-up. Info alerts (volume spikes) provide situational awareness.
- The `InventoryOversellDetected` alert has `for: '0s'` -- it fires instantly on any single occurrence because even one oversell is a data integrity violation that demands immediate attention. Contrast this with `PaymentLatencyHigh` which requires the condition to persist for 5 minutes, filtering out transient spikes.
- The `/metrics` endpoint exposes all registered metrics in Prometheus exposition format, which Prometheus scrapes at a configured interval (typically 15-30 seconds). This pull-based model means the application does not need to know where the monitoring system lives.

### Review Questions

1. The `bookingCreationTime` histogram uses buckets `[0.1, 0.25, 0.5, 1, 2, 5, 10, 30]` while the `paymentLatency` histogram uses `[0.5, 1, 2, 5, 10]`. Why are the bucket boundaries different? What does this tell you about the expected latency profiles of these two operations?
2. The `BookingSuccessRateCritical` alert uses `rate(...[5m])` with a `for: '2m'` duration. What would happen if you changed the rate window to `[1m]`? How would that affect alert sensitivity and false-positive rates?
3. The `circuitBreakerState` metric uses a Gauge with values 0, 0.5, and 1. Why is a Gauge appropriate here instead of a Counter? How would you write a PromQL query to find all services with open circuit breakers?

### Hands-On Exercise

Add a new set of metrics to the `MetricsService` class for tracking GDPR deletion requests. Define: (1) a Counter for total deletion requests with labels for `status` (success, failure), (2) a Histogram for deletion processing duration with buckets appropriate for an operation that involves database transactions and Redis scans, and (3) a Gauge for pending deletion requests in the queue. Then write one critical alert rule and one warning alert rule that use these new metrics.

---

## 27. Distributed Tracing

> **Learning Objectives**
> - Explain why distributed tracing is essential when a single booking request touches 5 or more services.
> - Read OpenTelemetry span creation code and understand the parent-child relationship between spans.
> - Identify how span attributes (booking type, user ID, payment provider) enable filtering and debugging in a tracing UI like Jaeger.
> - Understand the OpenTelemetry SDK setup, including resource attributes, trace exporters, and automatic instrumentation.

**Why:** When a booking request touches 5+ services, you need to trace the full request path to identify bottlenecks and failures. Distributed tracing connects spans across service boundaries.

### Traced Booking Service

```typescript
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('booking-service', '1.0.0');

export class TracedBookingService {
  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    const span = tracer.startSpan('createBooking', {
      attributes: {
        'booking.type': dto.bookingType,
        'booking.user_id': dto.userId.toString(),
        'booking.amount': dto.totalAmount
      }
    });

    try {
      return await context.with(
        trace.setSpan(context.active(), span),
        async () => {
          // Child span: Check availability
          const availSpan = tracer.startSpan('checkAvailability');
          const available = await this.inventoryService.checkAvailability(dto);
          availSpan.end();

          if (!available) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not available' });
            throw new InsufficientInventoryError();
          }

          // Child span: Process payment
          const paySpan = tracer.startSpan('processPayment', {
            attributes: {
              'payment.provider': dto.paymentProvider,
              'payment.amount': dto.totalAmount
            }
          });
          const payment = await this.paymentService.processPayment(dto);
          paySpan.end();

          // Create booking
          const booking = await this.createBookingRecord(dto, payment.id);
          span.setAttribute('booking.id', booking.id.toString());
          span.setStatus({ code: SpanStatusCode.OK });

          return booking;
        }
      );
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  }
}
```

### OpenTelemetry Setup

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'booking-service',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger.monitoring:4318/v1/traces'
  }),
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

sdk.start();
```

### Key Takeaways

- Distributed tracing connects the dots across service boundaries. A single trace ID follows a booking request from the API gateway through the booking service, inventory service, and payment service, so you can see the full picture in one view.
- The parent-child span relationship is established through context propagation. The `createBooking` span is the parent; `checkAvailability` and `processPayment` are child spans. This hierarchy shows you exactly how time is spent within a request.
- Span attributes like `booking.type`, `payment.provider`, and `booking.id` are critical for debugging. They let you filter traces in Jaeger or Grafana Tempo by specific booking types, payment providers, or individual booking IDs to isolate production issues.
- The `finally` block ensures `span.end()` is always called, even when exceptions occur. An unclosed span leaks memory and produces incomplete traces that are harder to debug.
- Automatic instrumentation (`HttpInstrumentation`, `ExpressInstrumentation`) captures HTTP-level spans without code changes, while manual spans (like `checkAvailability` and `processPayment`) provide business-level context that automatic instrumentation cannot infer.

### Review Questions

1. In the `TracedBookingService`, the `availSpan` is created with `tracer.startSpan('checkAvailability')` without explicitly setting a parent. How does OpenTelemetry know that this span is a child of the `createBooking` span? What role does the `context.with(...)` call play?
2. If the `processPayment` call throws an exception, `paySpan.end()` is never called (it is on the line after the await). What problem does this create, and how would you fix it?
3. The OpenTelemetry SDK setup includes `HttpInstrumentation` and `ExpressInstrumentation`. What additional instrumentation libraries would you add for a service that also uses MySQL and Redis? Why is automatic instrumentation for these data stores valuable?

### Hands-On Exercise

The current `TracedBookingService` has child spans for `checkAvailability` and `processPayment`, but the `createBookingRecord` call has no dedicated span. Add a child span for `createBookingRecord` that includes attributes for the database operation (e.g., `db.system`, `db.operation`, `db.statement`). Then add error handling so that if the database insert fails, the span captures the exception and sets an error status before the error propagates to the parent span.

---

## 28. SLO/SLI Definitions

> **Learning Objectives**
> - Define SLI (Service Level Indicator), SLO (Service Level Objective), and error budget, and explain the relationship between them.
> - Read PromQL expressions that measure SLIs and understand what each query computes.
> - Calculate error budgets in minutes for a given SLO target over monthly, quarterly, and yearly windows.
> - Explain the difference between fast-burn and slow-burn error budget alerts and why both are necessary.
> - Understand why inventory accuracy has a stricter SLO (99.999%) than availability (99.99%).

**Why:** Service Level Objectives (SLOs) define the reliability targets. Service Level Indicators (SLIs) are the metrics that measure them. Error budgets determine how much unreliability is acceptable.

```typescript
export const sloDefinitions = {
  availability: {
    sli: 'Percentage of successful HTTP responses (non-5xx) over total requests',
    slo: 0.9999,  // 99.99%
    errorBudget: {
      monthly: 4.32,        // minutes
      quarterly: 12.96,     // minutes
      yearly: 52.56         // minutes
    },
    measurement: 'rate(http_responses_total{status!~"5.."}[30d]) / rate(http_responses_total[30d])'
  },

  bookingLatency: {
    sli: 'P99 latency for successful booking creation',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.99, rate(booking_creation_duration_seconds_bucket{status="success"}[5m]))'
  },

  paymentLatency: {
    sli: 'P95 latency for payment processing',
    slo: 2.0,  // 2 seconds
    measurement: 'histogram_quantile(0.95, rate(payment_duration_seconds_bucket[5m]))'
  },

  searchLatency: {
    sli: 'P99 latency for search queries',
    slo: 0.5,  // 500ms
    measurement: 'histogram_quantile(0.99, rate(search_duration_seconds_bucket[5m]))'
  },

  inventoryAccuracy: {
    sli: 'Percentage of bookings without oversell incidents',
    slo: 0.99999,  // 99.999%
    measurement: '1 - (rate(inventory_oversell_attempts_total[30d]) / rate(bookings_total[30d]))'
  },

  dataFreshness: {
    sli: 'Maximum replication lag across all database replicas',
    slo: 5,  // 5 seconds
    measurement: 'max(mysql_slave_lag_seconds)'
  }
};

// Error budget burn rate alerts
export const burnRateAlerts = [
  {
    name: 'ErrorBudgetFastBurn',
    description: '2% of monthly error budget consumed in 1 hour',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[1h]) / rate(http_responses_total[1h])) > 14.4 * (1 - 0.9999)',
    severity: 'critical',
    window: '1h'
  },
  {
    name: 'ErrorBudgetSlowBurn',
    description: '5% of monthly error budget consumed in 6 hours',
    expr: '1 - (rate(http_responses_total{status!~"5.."}[6h]) / rate(http_responses_total[6h])) > 6 * (1 - 0.9999)',
    severity: 'warning',
    window: '6h'
  }
];
```

### Key Takeaways

- SLOs translate business expectations into measurable engineering targets. A 99.99% availability SLO means the team has 4.32 minutes of error budget per month -- enough for a brief deployment hiccup but not enough for a prolonged outage.
- Different SLIs have different SLO targets because they carry different business impact. Inventory accuracy is set at 99.999% (stricter than availability) because an oversell means a customer arrives at a hotel with no room -- a far worse experience than a momentary API error.
- Burn rate alerts catch error budget consumption at two speeds. The fast-burn alert (2% of budget in 1 hour) catches sudden outages and pages immediately. The slow-burn alert (5% of budget in 6 hours) catches gradual degradation that might go unnoticed until the entire budget is exhausted.
- The PromQL measurement expressions are the single source of truth for SLI calculation. Every team member, from the on-call engineer to the VP of Engineering, can look at the same dashboard and agree on whether the SLO is being met.

### Review Questions

1. The availability SLO is 99.99%, which gives an error budget of 4.32 minutes per month. If a deployment causes 5xx errors for 3 minutes, what percentage of the monthly error budget has been consumed? Should the team proceed with further deployments that week?
2. The `ErrorBudgetFastBurn` alert multiplies `(1 - 0.9999)` by 14.4. Where does the number 14.4 come from? (Hint: think about the relationship between the 1-hour window, the monthly budget, and the 2% consumption threshold.)
3. The `bookingLatency` SLI uses P99 while `paymentLatency` uses P95. What is the practical difference? Why might the team choose a stricter percentile for booking latency than for payment latency?

### Hands-On Exercise

Your team wants to add an SLO for notification delivery: "99.9% of booking confirmation emails must be delivered within 60 seconds of booking completion." Define this SLO in the same format as the existing `sloDefinitions` object, including the `sli` description, `slo` target, `errorBudget` (calculate monthly/quarterly/yearly minutes), and a `measurement` PromQL expression. Then write a corresponding burn rate alert for fast-burn detection.

---

## 29. Incident Response

> **Learning Objectives**
> - Distinguish between P0, P1, P2, and P3 severity levels and articulate the escalation path for each.
> - Explain why blameless post-mortems focus on systemic failures rather than individual mistakes.
> - Read the `IncidentManager` code and trace the notification flow from incident declaration to channel-specific alerts.
> - Understand the purpose of response time targets and update frequency requirements at each severity level.

**Why:** When things go wrong at scale (and they will), a structured incident response process minimizes impact. Severity levels determine who gets paged and how quickly.

### Incident Response Plan

```typescript
export const incidentResponsePlan = {
  severityLevels: {
    P0: {
      description: 'Complete service outage or data loss',
      examples: ['All bookings failing', 'Database corruption', 'Payment double-charging'],
      responseTime: '5 minutes',
      notifyChannels: ['PagerDuty', 'Phone Tree', 'Executive Slack'],
      teamRequired: ['On-call engineer', 'Tech Lead', 'VP Engineering'],
      updateFrequency: 'Every 15 minutes'
    },
    P1: {
      description: 'Major feature degradation affecting >10% of users',
      examples: ['One region down', 'Payment provider failing', 'Search errors'],
      responseTime: '15 minutes',
      notifyChannels: ['PagerDuty', 'Slack #incidents'],
      teamRequired: ['On-call engineer', 'Tech Lead'],
      updateFrequency: 'Every 30 minutes'
    },
    P2: {
      description: 'Minor feature degradation affecting <10% of users',
      examples: ['Elevated error rates', 'Slow responses', 'One shard degraded'],
      responseTime: '1 hour',
      notifyChannels: ['Slack #incidents'],
      teamRequired: ['On-call engineer'],
      updateFrequency: 'Every 2 hours'
    },
    P3: {
      description: 'Non-urgent issue with workaround available',
      examples: ['Monitoring gaps', 'Non-critical alert noise'],
      responseTime: 'Next business day',
      notifyChannels: ['Slack #platform'],
      teamRequired: ['Assigned engineer'],
      updateFrequency: 'Daily'
    }
  },

  postMortemTemplate: {
    sections: [
      'Incident Summary',
      'Timeline of Events',
      'Root Cause Analysis',
      'Impact Assessment',
      'What Went Well',
      'What Went Wrong',
      'Action Items (with owners and due dates)',
      'Lessons Learned'
    ],
    rules: [
      'Blameless -- focus on systems, not people',
      'Must be completed within 48 hours of resolution',
      'Action items must have owners and deadlines',
      'Reviewed by the team in a group meeting'
    ]
  }
};
```

### Incident Communication

```typescript
export class IncidentManager {
  async declareIncident(params: {
    severity: 'P0' | 'P1' | 'P2' | 'P3';
    title: string;
    description: string;
    affectedServices: string[];
    declaredBy: string;
  }): Promise<Incident> {
    const incident = await db.execute(`
      INSERT INTO incidents (
        severity, title, description, affected_services,
        declared_by, status, declared_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NOW())
    `, [
      params.severity, params.title, params.description,
      JSON.stringify(params.affectedServices), params.declaredBy
    ]);

    const config = incidentResponsePlan.severityLevels[params.severity];

    // Notify appropriate channels
    for (const channel of config.notifyChannels) {
      await this.notify(channel, {
        severity: params.severity,
        title: params.title,
        description: params.description,
        responseTime: config.responseTime
      });
    }

    return { id: incident.insertId, ...params };
  }
}
```

### Key Takeaways

- Severity levels are not about how bad the bug is -- they are about customer impact and urgency. A P0 (complete outage, data loss, double-charging) requires VP-level involvement and 5-minute response because every second of delay affects all users. A P3 (monitoring gap) can wait until the next business day because users are not impacted.
- The escalation path widens with severity: P2 involves only the on-call engineer, P1 adds the Tech Lead, and P0 adds the VP of Engineering and triggers a phone tree. This ensures the right people are involved without over-mobilizing for minor issues.
- Blameless post-mortems are a deliberate cultural choice. Blaming individuals discourages reporting and honest analysis. Focusing on systemic failures (missing tests, inadequate monitoring, unclear runbooks) produces action items that prevent recurrence.
- The 48-hour deadline for post-mortems ensures lessons are captured while the incident is fresh. Without a deadline, post-mortems get deprioritized and the team loses the opportunity to learn.
- Update frequency requirements keep stakeholders informed and prevent the "what's happening?" interruptions that slow down the responders.

### Review Questions

1. A payment provider starts returning errors for 15% of transactions in the EU region, but the US and Asia regions are unaffected. Based on the severity level definitions, is this a P0, P1, or P2? Justify your answer by referencing the specific thresholds in the plan.
2. The `IncidentManager.declareIncident` method stores `affected_services` as a JSON string. Why is this stored as JSON rather than in a separate join table? What are the trade-offs of this approach for querying and reporting?
3. The post-mortem template includes both "What Went Well" and "What Went Wrong." Why is the "What Went Well" section important in a post-mortem? What would happen if the template only focused on failures?

### Hands-On Exercise

Write a method `escalateIncident` for the `IncidentManager` class that upgrades an incident's severity (e.g., from P2 to P1). The method should: (1) update the severity in the database, (2) determine the new notification channels by comparing the old and new severity configurations, (3) notify only the channels that are new (e.g., if escalating from P2 to P1, notify PagerDuty since P2 only uses Slack), and (4) log the escalation with a timestamp and reason. Include the TypeScript method signature, SQL update, and notification logic.

---

## 30. Disaster Recovery

> **Learning Objectives**
> - Define RPO (Recovery Point Objective) and RTO (Recovery Time Objective) and explain their relationship to business requirements.
> - Trace the automatic failover sequence from health check failure to DNS rotation removal to traffic absorption.
> - Understand the data replication strategies for each storage tier (database, Kafka, Redis) and why they differ.
> - Explain the difference between automatic and manual failover and when each is appropriate.
> - Read the CloudFormation YAML for Route53 health checks and weighted DNS records.

**Why:** Regional failures (AWS outage, natural disaster) can take down an entire datacenter. Active-active multi-region deployment with automated failover ensures bookings continue even during regional outages.

### Disaster Recovery Plan

```typescript
export const disasterRecoveryPlan = {
  rpo: {
    target: '< 1 second',
    achieved_via: 'Synchronous replication within AZ, async cross-region',
    worst_case: '< 5 seconds (async replication lag)'
  },

  rto: {
    target: '< 5 minutes',
    achieved_via: 'Active-active multi-region with automatic failover',
    steps: [
      'DNS failover detects region health check failure (30s)',
      'Route53 removes unhealthy region from rotation (30s)',
      'Remaining regions absorb traffic (auto-scaled) (2-3 min)',
      'Alert team for investigation'
    ]
  },

  failoverProcedure: {
    automatic: {
      trigger: 'Route53 health check failure for 3 consecutive checks',
      action: 'Remove region from DNS rotation',
      rollback: 'Re-add region when health checks pass for 5 consecutive checks'
    },

    manual: {
      trigger: 'Operator decision during partial degradation',
      steps: [
        'Assess impact and confirm failover is necessary',
        'Update Route53 weights to shift traffic',
        'Monitor receiving regions for capacity',
        'Investigate and remediate failed region',
        'Gradual traffic restoration (10% -> 50% -> 100%)'
      ]
    }
  },

  dataReplication: {
    database: {
      withinRegion: 'Synchronous (primary -> replica)',
      crossRegion: 'Asynchronous (< 1s typical lag)',
      conflictResolution: 'Fencing token ordering (Section 13)'
    },
    kafka: {
      withinRegion: 'min.insync.replicas = 2',
      crossRegion: 'MirrorMaker 2 for topic replication'
    },
    redis: {
      withinRegion: 'Redis Cluster replication',
      crossRegion: 'Application-level rebuild from database'
    }
  },

  testingSchedule: {
    tableTopExercise: 'Monthly',
    failoverDrill: 'Quarterly',
    fullRegionFailover: 'Annually',
    chaosEngineering: 'Weekly (non-production), Monthly (production)'
  }
};
```

### DNS Failover Configuration

```yaml
# Route53 Health Check and Failover
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  RegionHealthCheck:
    Type: AWS::Route53::HealthCheck
    Properties:
      HealthCheckConfig:
        FullyQualifiedDomainName: api-us-east-1.bookingplatform.com
        Port: 443
        Type: HTTPS
        ResourcePath: /health
        RequestInterval: 10
        FailureThreshold: 3

  PrimaryDNSRecord:
    Type: AWS::Route53::RecordSet
    Properties:
      HostedZoneId: !Ref HostedZone
      Name: api.bookingplatform.com
      Type: A
      SetIdentifier: us-east-1
      Weight: 35
      HealthCheckId: !Ref RegionHealthCheck
      AliasTarget:
        DNSName: !GetAtt USEastALB.DNSName
        HostedZoneId: !GetAtt USEastALB.CanonicalHostedZoneID
```

### Key Takeaways

- RPO and RTO are business-driven targets, not just technical metrics. An RPO of less than 1 second means the business cannot tolerate losing even a single booking's data. An RTO of less than 5 minutes means the business can survive a brief interruption but not a prolonged one.
- The automatic failover sequence is designed for speed: health check failure detection (30 seconds) followed by DNS rotation removal (30 seconds) followed by traffic absorption (2-3 minutes). Each step is timed and automated because human response at 3 AM takes too long.
- Different storage tiers have different replication strategies because they have different consistency requirements. The database uses synchronous replication within a region (strong consistency for bookings) and asynchronous cross-region (eventual consistency with sub-second lag). Redis uses application-level rebuild from the database cross-region because cache data is expendable -- it can be regenerated.
- A disaster recovery plan that is never tested is not a plan -- it is a wish. The testing schedule escalates from tabletop exercises (monthly) through failover drills (quarterly) to full region failover (annually), building confidence that the plan actually works under real conditions.
- The gradual traffic restoration in manual failover (10% to 50% to 100%) prevents overwhelming a recovering region, which could cause a secondary outage.

### Review Questions

1. The RPO target is "less than 1 second" but the worst case is "less than 5 seconds." What causes this gap? Under what specific conditions would the system experience the worst-case RPO rather than the target?
2. In the CloudFormation YAML, the health check has `RequestInterval: 10` and `FailureThreshold: 3`. How many seconds, at minimum, will pass between a real failure occurring and Route53 removing the region from rotation? Walk through the timing.
3. Redis replication cross-region is described as "application-level rebuild from database" rather than using Redis's own cross-region replication. What are the advantages and disadvantages of this approach compared to running a cross-region Redis replication cluster?

### Hands-On Exercise

The current disaster recovery plan covers the failover procedure but does not address the "failback" procedure -- bringing a recovered region back into rotation after a failure has been resolved. Write a `failbackProcedure` object (in the same TypeScript format as `failoverProcedure`) that includes: (1) pre-conditions that must be met before restoring traffic (health checks, data sync verification, capacity confirmation), (2) a gradual traffic restoration sequence with specific percentage steps and monitoring checkpoints, and (3) a rollback plan in case the recovered region shows problems during failback. Reference the existing DR plan's concepts (Route53 weights, health check thresholds) in your design.
