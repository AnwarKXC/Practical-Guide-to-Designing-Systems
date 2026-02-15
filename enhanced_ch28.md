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

## Common Fraud Patterns in Booking Systems

Before we build detection, we need to understand what we are detecting. In seven years of operating a booking platform at scale, we have cataloged six major fraud patterns. Every rule, every model, every alert we build traces back to one or more of these.

### Pattern 1: Stolen Card Testing (Card Cracking)

**How it works:** A fraudster buys a batch of stolen card numbers from a dark web marketplace. They do not know which cards are still active. So they write a script that submits small bookings — typically $10-$50 — through your API. Cards that succeed are "verified" and sold at a premium. Your platform is a free validation service.

**What it looks like in your logs:**
- Dozens of booking attempts from a single IP address within minutes
- Small, uniform amounts ($10, $15, $25)
- Different card numbers on every attempt
- High failure rate (most stolen cards are already cancelled)
- Disposable or randomly generated email addresses

```typescript
// What card testing traffic looks like in raw data
const suspiciousPattern = {
  sourceIp: '185.220.101.42',
  timeWindow: '5 minutes',
  attempts: 47,
  uniqueCards: 47,          // One card per attempt — testing
  successRate: 0.08,        // 8% — most cards are dead
  averageAmount: 15.00,     // Small amounts to avoid detection
  uniqueEmails: 47,         // throwaway1@tempmail.com, throwaway2@...
};
```

> **Key Term:** **Card Cracking** — The automated process of testing stolen credit card numbers against a merchant's payment system to determine which cards are still active. Also called "carding" or "card stuffing." It is the single most common fraud pattern in e-commerce and booking platforms.

### Pattern 2: Promo Code Abuse

**How it works:** Your marketing team launches a "first booking free" promotion with code `WELCOME50`. The promotion is intended for new customers. A fraudster creates 200 accounts with different email addresses and uses the code on every single one. They book hotel rooms at a 50% discount and resell the confirmations.

**What it looks like in your logs:**
- Many new accounts created within a short period
- All accounts use the same promo code
- Same device fingerprint across all accounts
- Similar IP addresses (same VPN exit node or residential proxy)
- Bookings are for resellable inventory (hotels, flights — not personalized services)

```typescript
// Promo abuse detection signals
interface PromoAbuseSignals {
  promoCode: string;
  redemptionCount: number;          // How many times this code was used
  uniqueDeviceFingerprints: number; // How many distinct devices used it
  fingerprint_to_account_ratio: number; // 200 accounts from 3 devices = 66.7
  accountAgeAtRedemption: number;   // Minutes since account creation
  averageAccountAge: number;        // If all accounts are < 5 min old, that is a signal
}
```

### Pattern 3: Account Takeover (ATO)

**How it works:** A fraudster obtains a legitimate user's login credentials — through phishing, credential stuffing (trying leaked passwords from other breaches), or social engineering. They log into the real user's account, change the email address, and start making bookings with the stored payment methods.

**What it looks like in your logs:**
- Sudden login from an unfamiliar IP address or country
- Email or password change immediately after login
- Booking activity from a user who has been dormant for months
- Device fingerprint that has never been associated with this account
- Multiple high-value bookings in quick succession

```typescript
// Account takeover detection signals
interface ATOSignals {
  loginFromNewDevice: boolean;         // Never seen this device for this user
  loginFromNewCountry: boolean;        // User has only logged in from US, now from Romania
  passwordChangedRecently: boolean;    // Changed within last hour
  emailChangedRecently: boolean;       // Changed within last hour
  timeSinceLastActivity: number;       // Account dormant for 90 days, suddenly active
  bookingVelocitySpikeRatio: number;   // 0 bookings/month -> 8 bookings/hour
}
```

> **What If You Skip This?** Account takeover is the most damaging fraud pattern because the fraudster has access to a real, trusted account. Your velocity checks see a legitimate account with years of history. Your device fingerprinting sees a "new device" but that happens when users get new phones. Without ATO-specific detection (monitoring for credential changes + behavioral shifts), these attacks slip through every other layer of defense.

### Pattern 4: Friendly Fraud (Chargeback Fraud)

**How it works:** A real customer makes a legitimate booking, stays at the hotel, and then calls their bank to dispute the charge. "I never made this booking," they say. The bank issues a chargeback. The customer gets their money back. They also got the hotel stay. This is not an external attacker — it is your own customer stealing from you.

**What it looks like in your logs:**
- The booking itself looks completely normal — no fraud signals at all
- The chargeback arrives 30-90 days after the stay
- The same user has filed chargebacks before (repeat offender)
- The user's account history shows check-ins and activity during the disputed stay

```typescript
// Friendly fraud is detected retroactively, not in real time
interface FriendlyFraudSignals {
  previousChargebacks: number;       // Has this user filed chargebacks before?
  chargebackToBookingRatio: number;  // 3 chargebacks out of 10 bookings = 0.3
  checkinConfirmed: boolean;         // Did they actually check in?
  reviewPosted: boolean;             // Did they post a review of the stay?
  supportTickets: number;            // Did they complain before the chargeback?
}
```

### Pattern 5: Triangulation Fraud

**How it works:** A fraudster sets up a fake travel agency website offering rooms at impossibly low prices. A real customer finds the fake site, pays with their own card (to the fraudster, not to you). The fraudster then books the room on your platform using a *different* stolen card. The real customer gets a valid confirmation. When the stolen card's owner files a chargeback, you eat the loss. The fraudster keeps the customer's payment.

**What it looks like in your logs:**
- Booking details (guest name, check-in date) do not match the cardholder's name
- The booking email is different from the payment card's registered email
- Multiple bookings with different cards but similar guest details
- Bookings always for third parties ("I'm booking for my friend")

### Pattern 6: Refund Fraud

**How it works:** A fraudster books a fully refundable room using a stolen card. They then call customer support and ask for the refund to be sent to a *different* card or as a bank transfer — claiming "the original card was lost." If your refund policy allows this, the fraudster launders stolen card funds through your platform.

**What it looks like in your logs:**
- Booking made with Card A, refund requested to Card B
- Refund requested before the check-in date (they never intended to stay)
- Short time between booking and cancellation
- High-value bookings with immediate cancellation

---

## Rule-Based Detection: The Configurable Rules Engine

The simplest fraud detection approach is rule-based: you define a set of rules, each one checking for a specific suspicious behavior. If the behavior is detected, you add points to a **risk score**. The higher the score, the more suspicious the transaction.

But here is the critical insight: hard-coding rules is a mistake. Fraud patterns change weekly. Your fraud team needs to adjust thresholds, enable new rules, and disable rules that generate too many false positives — *without deploying new code*. This requires a configurable rules engine.

```typescript
// fraud/rules/fraud-rule.interface.ts
// Every rule implements this interface. That is what makes them pluggable.
export interface FraudRule {
  /** Unique identifier for this rule */
  readonly name: string;

  /** Human-readable description for the fraud dashboard */
  readonly description: string;

  /** Maximum points this rule can contribute */
  readonly maxScore: number;

  /** Whether this rule is currently active (toggled via admin UI) */
  enabled: boolean;

  /**
   * Evaluate the transaction and return a score.
   * Returns 0 if the rule does not trigger.
   * Returns up to maxScore if it does.
   */
  evaluate(context: FraudContext): Promise<RuleResult>;
}

// The context object passed to every rule — it contains everything
// the rule might need to make a decision.
export interface FraudContext {
  userId: string;
  bookingId: string;
  amount: number;
  currency: string;
  ipAddress: string;
  deviceFingerprint: string;
  email: string;
  cardBIN: string;              // First 6-8 digits of card
  cardLastFour: string;
  billingCountry: string;
  userAgent: string;
  sessionId: string;
  timestamp: Date;
  metadata: Record<string, unknown>; // Extensible — add signals without changing the interface
}

export interface RuleResult {
  triggered: boolean;
  score: number;
  reason: string;              // Human-readable explanation
  details: Record<string, unknown>; // Machine-readable details for logging
}
```

Now here is the engine that runs all registered rules:

```typescript
// fraud/engine/fraud-engine.ts
import { Injectable, Logger } from '@nestjs/common';
import { FraudRule, FraudContext, RuleResult } from '../rules/fraud-rule.interface';

export interface FraudVerdict {
  status: 'passed' | 'flagged' | 'under_review' | 'blocked';
  riskScore: number;
  maxPossibleScore: number;
  triggeredRules: Array<{ name: string; score: number; reason: string }>;
  canProceed: boolean;
  requiresReview: boolean;
  evaluationTimeMs: number;
}

@Injectable()
export class FraudEngine {
  private readonly logger = new Logger(FraudEngine.name);
  private rules: FraudRule[] = [];

  // Thresholds — loaded from database or config service.
  // Changing these does not require a code deploy.
  private thresholds = {
    passed: 0,          // 0-24: clean
    flagged: 25,        // 25-49: log it, proceed
    underReview: 50,    // 50-79: hold for human review
    blocked: 80,        // 80+: reject immediately
  };

  registerRule(rule: FraudRule): void {
    this.rules.push(rule);
    this.logger.log(`Registered fraud rule: ${rule.name} (max: ${rule.maxScore})`);
  }

  async evaluate(context: FraudContext): Promise<FraudVerdict> {
    const startTime = Date.now();
    let totalScore = 0;
    const triggeredRules: FraudVerdict['triggeredRules'] = [];
    const maxPossibleScore = this.rules
      .filter(r => r.enabled)
      .reduce((sum, r) => sum + r.maxScore, 0);

    // Run all enabled rules. We run them in parallel because
    // each rule is independent (no rule depends on another rule's output).
    const enabledRules = this.rules.filter(r => r.enabled);
    const results = await Promise.allSettled(
      enabledRules.map(async (rule): Promise<{ rule: FraudRule; result: RuleResult }> => {
        try {
          const result = await rule.evaluate(context);
          return { rule, result };
        } catch (error) {
          // A failing rule must not crash the entire pipeline.
          // Log the error, assign zero score, and move on.
          this.logger.error(
            `Rule "${rule.name}" threw an error: ${error.message}`,
            error.stack,
          );
          return {
            rule,
            result: { triggered: false, score: 0, reason: 'rule_error', details: { error: error.message } },
          };
        }
      }),
    );

    // Collect results
    for (const outcome of results) {
      if (outcome.status === 'fulfilled') {
        const { rule, result } = outcome.value;
        if (result.triggered) {
          // Cap the score at the rule's maxScore — a defensive measure
          // to prevent a misconfigured rule from dominating the total.
          const cappedScore = Math.min(result.score, rule.maxScore);
          totalScore += cappedScore;
          triggeredRules.push({
            name: rule.name,
            score: cappedScore,
            reason: result.reason,
          });
        }
      }
    }

    // Determine verdict
    let status: FraudVerdict['status'];
    if (totalScore >= this.thresholds.blocked) status = 'blocked';
    else if (totalScore >= this.thresholds.underReview) status = 'under_review';
    else if (totalScore >= this.thresholds.flagged) status = 'flagged';
    else status = 'passed';

    const evaluationTimeMs = Date.now() - startTime;

    const verdict: FraudVerdict = {
      status,
      riskScore: totalScore,
      maxPossibleScore,
      triggeredRules,
      canProceed: status !== 'blocked',
      requiresReview: status === 'under_review',
      evaluationTimeMs,
    };

    this.logger.log(
      `Fraud check for booking ${context.bookingId}: ` +
      `score=${totalScore}/${maxPossibleScore}, status=${status}, ` +
      `rules=${triggeredRules.map(r => r.name).join(',')||'none'}, ` +
      `time=${evaluationTimeMs}ms`,
    );

    return verdict;
  }

  updateThresholds(newThresholds: Partial<typeof this.thresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    this.logger.warn(`Fraud thresholds updated: ${JSON.stringify(this.thresholds)}`);
  }
}
```

Two design decisions matter here:

1. **Rules run in parallel.** Each rule is independent. Running them sequentially would mean waiting for IP geolocation, then device lookup, then BIN check — one after another. Running them in parallel means the total time is the time of the *slowest* rule, not the *sum*. For our production system, this reduced fraud check latency from ~320ms to ~85ms.

2. **Failing rules do not crash the pipeline.** If the IP geolocation API is down, the IP mismatch rule returns zero and logs an error. The remaining five rules still run. This is a critical property — a fraud check that crashes on every request is worse than a fraud check that skips one signal.

> **Analogy:** Think of the rules engine like a panel of judges at a talent show. Each judge scores independently. If one judge falls asleep (rule error), the show continues with the remaining judges. No single judge determines the outcome — it is the aggregate score. And the producers (fraud team) can add or remove judges between seasons (deploy cycles) without changing the show format (engine code).

---

## Concrete Rule Implementations

With the engine in place, let us build the individual rules. Each one checks for a specific fraud signal and returns a score. These are the rules that catch the patterns we described earlier.

### Rule 1: Velocity Check

This is your first line of defense against card testing. If someone submits 20 booking attempts in five minutes, that is not a busy traveler — that is a bot.

```typescript
// fraud/rules/velocity-check.rule.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FraudRule, FraudContext, RuleResult } from './fraud-rule.interface';

@Injectable()
export class VelocityCheckRule implements FraudRule {
  readonly name = 'velocity_check';
  readonly description = 'Detects unusually high booking attempt rates from a single source';
  readonly maxScore = 30;
  enabled = true;

  // Configurable thresholds — loaded from database in production
  private thresholds = {
    ipAttemptsPerMinute: 5,
    ipAttemptsPerHour: 20,
    userAttemptsPerMinute: 3,
    userAttemptsPerHour: 10,
    cardAttemptsPerDay: 5,
    deviceAttemptsPerHour: 15,
  };

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(context: FraudContext): Promise<RuleResult> {
    const now = context.timestamp;
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const oneHourAgo = new Date(now.getTime() - 3_600_000);
    const oneDayAgo = new Date(now.getTime() - 86_400_000);

    // Run all velocity checks in parallel — they are independent queries
    const [
      ipPerMinute,
      ipPerHour,
      userPerMinute,
      userPerHour,
      cardPerDay,
      devicePerHour,
    ] = await Promise.all([
      this.countAttempts({ ipAddress: context.ipAddress }, oneMinuteAgo, now),
      this.countAttempts({ ipAddress: context.ipAddress }, oneHourAgo, now),
      this.countAttempts({ userId: context.userId }, oneMinuteAgo, now),
      this.countAttempts({ userId: context.userId }, oneHourAgo, now),
      this.countAttempts({ cardBin: context.cardBIN, cardLastFour: context.cardLastFour }, oneDayAgo, now),
      this.countAttempts({ deviceFingerprint: context.deviceFingerprint }, oneHourAgo, now),
    ]);

    let score = 0;
    const violations: string[] = [];

    if (ipPerMinute > this.thresholds.ipAttemptsPerMinute) {
      score += 15;
      violations.push(`IP ${context.ipAddress}: ${ipPerMinute} attempts/min (limit: ${this.thresholds.ipAttemptsPerMinute})`);
    }
    if (ipPerHour > this.thresholds.ipAttemptsPerHour) {
      score += 10;
      violations.push(`IP ${context.ipAddress}: ${ipPerHour} attempts/hour (limit: ${this.thresholds.ipAttemptsPerHour})`);
    }
    if (userPerMinute > this.thresholds.userAttemptsPerMinute) {
      score += 10;
      violations.push(`User ${context.userId}: ${userPerMinute} attempts/min (limit: ${this.thresholds.userAttemptsPerMinute})`);
    }
    if (cardPerDay > this.thresholds.cardAttemptsPerDay) {
      score += 15;
      violations.push(`Card *${context.cardLastFour}: ${cardPerDay} attempts/day (limit: ${this.thresholds.cardAttemptsPerDay})`);
    }
    if (devicePerHour > this.thresholds.deviceAttemptsPerHour) {
      score += 10;
      violations.push(`Device: ${devicePerHour} attempts/hour (limit: ${this.thresholds.deviceAttemptsPerHour})`);
    }

    // Cap at maxScore
    score = Math.min(score, this.maxScore);

    return {
      triggered: score > 0,
      score,
      reason: violations.length > 0
        ? `Velocity violations: ${violations.join('; ')}`
        : 'No velocity anomalies detected',
      details: {
        ipPerMinute, ipPerHour, userPerMinute,
        userPerHour, cardPerDay, devicePerHour,
        violations,
      },
    };
  }

  private async countAttempts(
    where: Record<string, string>,
    from: Date,
    to: Date,
  ): Promise<number> {
    return this.prisma.fraudEvent.count({
      where: {
        ...where,
        createdAt: { gte: from, lte: to },
      },
    });
  }
}
```

> **Why These Specific Thresholds?** The numbers above (5 attempts per minute per IP, 3 per minute per user) are starting points based on patterns we observed in production. Your numbers will be different. The key is that they are configurable — stored in the database, editable through an admin UI, and changeable without a deploy. Start strict, then relax thresholds for specific rules that generate too many false positives.

### Rule 2: Geographic Anomaly Detection

When a user who has only ever logged in from Chicago suddenly makes a booking from a Romanian IP address, that is a signal. Not proof — people travel — but a signal worth scoring.

```typescript
// fraud/rules/geo-anomaly.rule.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FraudRule, FraudContext, RuleResult } from './fraud-rule.interface';
import { GeoIpService } from '../../services/geo-ip.service';

@Injectable()
export class GeoAnomalyRule implements FraudRule {
  readonly name = 'geo_anomaly';
  readonly description = 'Detects geographic location mismatches between user history and current session';
  readonly maxScore = 25;
  enabled = true;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoIp: GeoIpService,
  ) {}

  async evaluate(context: FraudContext): Promise<RuleResult> {
    let score = 0;
    const reasons: string[] = [];

    // Step 1: Look up the IP's country
    const currentGeo = await this.geoIp.lookup(context.ipAddress);
    if (!currentGeo) {
      // Cannot geolocate this IP (e.g., Tor exit node). That is suspicious.
      return {
        triggered: true,
        score: 10,
        reason: 'IP address could not be geolocated (possible Tor/VPN)',
        details: { ipAddress: context.ipAddress, geoResult: null },
      };
    }

    // Step 2: Compare with the user's historical login locations
    const recentLogins = await this.prisma.loginHistory.findMany({
      where: { userId: context.userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const historicalCountries = [...new Set(recentLogins.map(l => l.country))];

    // Step 3: Check for country mismatch
    if (historicalCountries.length > 0 && !historicalCountries.includes(currentGeo.country)) {
      score += 15;
      reasons.push(
        `Login from ${currentGeo.country} but user history only shows: ${historicalCountries.join(', ')}`,
      );
    }

    // Step 4: Compare IP country with card's billing country
    if (context.billingCountry && currentGeo.country !== context.billingCountry) {
      score += 10;
      reasons.push(
        `IP country (${currentGeo.country}) does not match billing country (${context.billingCountry})`,
      );
    }

    // Step 5: Check for high-risk countries (configurable list)
    const highRiskCountries = await this.getHighRiskCountries();
    if (highRiskCountries.includes(currentGeo.country)) {
      score += 5;
      reasons.push(`IP originates from high-risk country: ${currentGeo.country}`);
    }

    score = Math.min(score, this.maxScore);

    return {
      triggered: score > 0,
      score,
      reason: reasons.join('; ') || 'No geographic anomalies',
      details: {
        currentCountry: currentGeo.country,
        historicalCountries,
        billingCountry: context.billingCountry,
        isHighRisk: highRiskCountries.includes(currentGeo.country),
      },
    };
  }

  private async getHighRiskCountries(): Promise<string[]> {
    const config = await this.prisma.fraudConfig.findUnique({
      where: { key: 'high_risk_countries' },
    });
    return config ? JSON.parse(config.value) : [];
  }
}
```

### Rule 3: Amount Threshold Analysis

Fraudsters tend toward two extremes: very small amounts (card testing) or very large amounts (maximize the haul before the card is cancelled). Both are signals.

```typescript
// fraud/rules/amount-threshold.rule.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { FraudRule, FraudContext, RuleResult } from './fraud-rule.interface';

@Injectable()
export class AmountThresholdRule implements FraudRule {
  readonly name = 'amount_threshold';
  readonly description = 'Flags transactions with unusually small or large amounts';
  readonly maxScore = 20;
  enabled = true;

  constructor(private readonly prisma: PrismaService) {}

  async evaluate(context: FraudContext): Promise<RuleResult> {
    let score = 0;
    const reasons: string[] = [];

    // Micro-transaction detection (card testing signal)
    if (context.amount < 15) {
      score += 10;
      reasons.push(`Amount $${context.amount} is below micro-transaction threshold ($15)`);
    }

    // Large transaction detection
    if (context.amount > 5000) {
      score += 10;
      reasons.push(`Amount $${context.amount} exceeds high-value threshold ($5000)`);
    }

    // Compare to user's historical average
    const userAvg = await this.prisma.booking.aggregate({
      where: { userId: context.userId, status: 'COMPLETED' },
      _avg: { totalAmount: true },
      _count: true,
    });

    if (userAvg._count > 3 && userAvg._avg.totalAmount) {
      const ratio = context.amount / userAvg._avg.totalAmount;
      if (ratio > 5) {
        // This booking is 5x the user's average — suspicious
        score += 10;
        reasons.push(
          `Amount $${context.amount} is ${ratio.toFixed(1)}x user's average ($${userAvg._avg.totalAmount.toFixed(2)})`,
        );
      }
    }

    score = Math.min(score, this.maxScore);

    return {
      triggered: score > 0,
      score,
      reason: reasons.join('; ') || 'Amount within normal range',
      details: {
        amount: context.amount,
        userAverageAmount: userAvg._avg.totalAmount,
        userBookingCount: userAvg._count,
      },
    };
  }
}
```

> **Mentor's Note:** Notice how every rule follows the same pattern: query for data, compare to thresholds, accumulate a score, return the result. This consistency is not an accident. When your fraud team needs to add a new rule six months from now — and they will — the pattern is clear. Copy an existing rule, change the query and the comparison, register it with the engine. Five minutes of work, no architecture changes.

---

## ML-Based Fraud Scoring: Feature Engineering

Rules catch known patterns. But what about patterns you have not seen yet? What about combinations of signals that individually look normal but together are suspicious? This is where machine learning enters the picture.

> **Important Caveat:** You do not need ML on day one. Start with rules. Build your labeled dataset (every chargeback is a confirmed fraud label; every completed stay is a confirmed legitimate label). Once you have 10,000+ labeled examples, ML becomes valuable. Before that, you are training a model on noise.

The most important part of ML-based fraud detection is not the model — it is the **features**. Feature engineering is where domain expertise matters more than algorithm choice.

```typescript
// fraud/ml/feature-engineering.ts
// This module extracts features from raw booking data for the ML model.
// Each feature is a number — models cannot process raw strings or objects.

export interface FraudFeatureVector {
  // Transaction features
  amountUsd: number;                    // Normalized to USD
  amountToUserAvgRatio: number;         // Current amount / user's historical average
  isRoundAmount: number;                // 1 if amount is exactly $100, $200, etc; 0 otherwise
  hourOfDay: number;                    // 0-23; fraud peaks at 2-5 AM local time
  dayOfWeek: number;                    // 0-6; weekday patterns differ from weekend

  // Velocity features
  attemptsLastHour: number;             // Number of booking attempts by this user in last hour
  attemptsLastDay: number;              // Number of booking attempts by this user in last 24h
  uniqueCardsLastDay: number;           // How many different cards this user tried today
  uniqueIpsLastDay: number;             // How many different IPs this user used today

  // Account features
  accountAgeDays: number;               // Accounts < 1 day old are 8x more likely to be fraud
  daysSinceLastBooking: number;         // Dormant accounts suddenly active = ATO signal
  totalPreviousBookings: number;        // Established accounts are lower risk
  previousChargebacks: number;          // History of chargebacks = massive signal
  emailDomainRiskScore: number;         // tempmail.com = high; gmail.com = low

  // Geographic features
  ipCountryMatchesBilling: number;      // 1 if match, 0 if mismatch
  ipCountryMatchesHistory: number;      // 1 if IP country is in user's historical countries
  distanceFromLastLoginKm: number;      // Physical distance from last known location
  isVpnOrProxy: number;                 // 1 if IP is a known VPN/proxy/Tor exit node

  // Device features
  deviceAge: number;                    // How long this device has been seen in our system
  deviceAccountCount: number;           // How many accounts use this device fingerprint
  browserLanguageMatchesCountry: number; // Chrome language 'ro' but IP is in US = suspicious

  // Booking-specific features
  daysUntilCheckIn: number;             // Same-day bookings have different fraud profiles
  stayDurationNights: number;           // Unusually long or short stays
  isRefundable: number;                 // Refundable bookings are preferred by fraudsters
  guestNameMatchesCardHolder: number;   // Name mismatch = triangulation signal
}

export class FeatureExtractor {
  async extract(context: FraudContext, prisma: PrismaService): Promise<FraudFeatureVector> {
    const user = await prisma.user.findUnique({
      where: { id: context.userId },
      include: { bookings: { select: { totalAmount: true, status: true } } },
    });

    const completedBookings = user?.bookings.filter(b => b.status === 'COMPLETED') ?? [];
    const avgAmount = completedBookings.length > 0
      ? completedBookings.reduce((sum, b) => sum + b.totalAmount, 0) / completedBookings.length
      : 0;

    const previousChargebacks = await prisma.chargeback.count({
      where: { userId: context.userId },
    });

    const recentAttempts = await prisma.fraudEvent.count({
      where: {
        userId: context.userId,
        createdAt: { gte: new Date(Date.now() - 3_600_000) },
      },
    });

    // ... additional feature extraction queries omitted for brevity ...

    return {
      amountUsd: context.amount,
      amountToUserAvgRatio: avgAmount > 0 ? context.amount / avgAmount : 0,
      isRoundAmount: context.amount % 100 === 0 ? 1 : 0,
      hourOfDay: context.timestamp.getUTCHours(),
      dayOfWeek: context.timestamp.getUTCDay(),
      attemptsLastHour: recentAttempts,
      attemptsLastDay: 0,           // Populated by additional query
      uniqueCardsLastDay: 0,        // Populated by additional query
      uniqueIpsLastDay: 0,          // Populated by additional query
      accountAgeDays: user
        ? (Date.now() - user.createdAt.getTime()) / 86_400_000
        : 0,
      daysSinceLastBooking: 0,      // Populated by additional query
      totalPreviousBookings: completedBookings.length,
      previousChargebacks,
      emailDomainRiskScore: this.scoreEmailDomain(context.email),
      ipCountryMatchesBilling: 0,   // Populated by geo lookup
      ipCountryMatchesHistory: 0,   // Populated by geo lookup
      distanceFromLastLoginKm: 0,   // Populated by geo calculation
      isVpnOrProxy: 0,              // Populated by IP reputation service
      deviceAge: 0,                 // Populated by device service
      deviceAccountCount: 0,        // Populated by device service
      browserLanguageMatchesCountry: 0,
      daysUntilCheckIn: 0,          // Populated from booking details
      stayDurationNights: 0,        // Populated from booking details
      isRefundable: 0,              // Populated from booking details
      guestNameMatchesCardHolder: 0, // Populated from name comparison
    };
  }

  private scoreEmailDomain(email: string): number {
    const domain = email.split('@')[1]?.toLowerCase();
    const disposableDomains = [
      'tempmail.com', 'throwaway.email', 'guerrillamail.com',
      'mailinator.com', 'yopmail.com', '10minutemail.com',
    ];
    if (disposableDomains.includes(domain)) return 1.0;
    const freeProviders = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];
    if (freeProviders.includes(domain)) return 0.2;
    return 0.1; // Corporate/custom domains are lowest risk
  }
}
```

> **Key Term:** **Feature Engineering** — The process of transforming raw data (timestamps, IP addresses, amounts) into numeric values that a machine learning model can use as inputs. In fraud detection, feature engineering is where 80% of the model's predictive power comes from. The model itself (logistic regression, random forest, neural network) accounts for the other 20%. Invest your time accordingly.

---

## Real-Time vs Batch Fraud Analysis

Not all fraud detection needs to happen in the critical path of a booking request. Some checks must be real-time (blocking the transaction before it completes). Others can happen asynchronously (analyzing patterns across the day's transactions).

Here is how to think about the split:

| Analysis Type | When It Runs | Latency Budget | What It Catches |
|---|---|---|---|
| **Real-time** | During booking request | < 200ms | Card testing, velocity spikes, known blocked users, geo mismatches |
| **Near-real-time** | Within 1-5 minutes via queue | < 5 min | Cross-user pattern analysis, device fingerprint clustering, promo abuse rings |
| **Batch** | Hourly or daily cron job | Hours | ML model retraining, chargeback pattern analysis, fraud ring detection, reporting |

```typescript
// fraud/processors/batch-fraud-analyzer.ts
// This runs as a scheduled job, not in the request path.
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class BatchFraudAnalyzer {
  private readonly logger = new Logger(BatchFraudAnalyzer.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async analyzeRecentBookings(): Promise<void> {
    this.logger.log('Starting hourly batch fraud analysis...');

    // Pattern 1: Find users who used multiple cards today
    // This is too slow for real-time but critical for catching card testing.
    const multiCardUsers = await this.prisma.$queryRaw<Array<{
      userId: string;
      cardCount: number;
    }>>`
      SELECT "userId", COUNT(DISTINCT "cardLastFour") as "cardCount"
      FROM fraud_events
      WHERE "createdAt" > NOW() - INTERVAL '24 hours'
      GROUP BY "userId"
      HAVING COUNT(DISTINCT "cardLastFour") > 3
    `;

    for (const user of multiCardUsers) {
      this.logger.warn(
        `User ${user.userId} used ${user.cardCount} different cards in 24h`,
      );
      await this.flagUserForReview(user.userId, 'multi_card_usage', {
        cardCount: user.cardCount,
      });
    }

    // Prisma Client equivalent of the above raw query:
    // const multiCardUsers = await this.prisma.fraudEvent.groupBy({
    //   by: ['userId'],
    //   where: {
    //     createdAt: { gte: new Date(Date.now() - 86_400_000) },
    //   },
    //   _count: { cardLastFour: true },
    //   having: {
    //     cardLastFour: { _count: { gt: 3 } },
    //   },
    // });

    // Pattern 2: Find device fingerprints shared across many accounts
    const sharedDevices = await this.prisma.$queryRaw<Array<{
      deviceFingerprint: string;
      accountCount: number;
    }>>`
      SELECT "deviceFingerprint", COUNT(DISTINCT "userId") as "accountCount"
      FROM fraud_events
      WHERE "createdAt" > NOW() - INTERVAL '7 days'
        AND "deviceFingerprint" IS NOT NULL
      GROUP BY "deviceFingerprint"
      HAVING COUNT(DISTINCT "userId") > 5
    `;

    // Prisma Client equivalent:
    // const sharedDevices = await this.prisma.fraudEvent.groupBy({
    //   by: ['deviceFingerprint'],
    //   where: {
    //     createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
    //     deviceFingerprint: { not: null },
    //   },
    //   _count: { userId: true },
    //   having: {
    //     userId: { _count: { gt: 5 } },
    //   },
    // });

    for (const device of sharedDevices) {
      this.logger.warn(
        `Device ${device.deviceFingerprint} is associated with ${device.accountCount} accounts`,
      );
      // This is likely a promo abuse ring — one person, many fake accounts
      await this.flagDeviceForReview(device.deviceFingerprint, 'multi_account_device', {
        accountCount: device.accountCount,
      });
    }

    this.logger.log('Batch fraud analysis complete.');
  }

  private async flagUserForReview(
    userId: string,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.fraudReviewItem.upsert({
      where: { userId_reason: { userId, reason } },
      create: { userId, reason, details, status: 'PENDING' },
      update: { details, updatedAt: new Date() },
    });
  }

  private async flagDeviceForReview(
    deviceFingerprint: string,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.fraudReviewItem.create({
      data: { deviceFingerprint, reason, details, status: 'PENDING' },
    });
  }
}
```

> **What If You Skip Batch Analysis?** Real-time rules catch individual bad transactions. Batch analysis catches *coordinated* attacks — a fraud ring using 50 accounts with 50 different IPs but the same device fingerprint. These patterns are invisible when you look at one transaction at a time. Without batch analysis, you will miss organized fraud that costs 10x more than individual attacks.

---

## Device Fingerprinting and Browser Analysis

IP addresses change. Email addresses are free. But devices leave a signature — a combination of browser version, installed fonts, screen resolution, timezone, WebGL renderer, and dozens of other attributes that together create a nearly unique identifier. This is called a **device fingerprint**, and it is one of the most powerful fraud signals available.

> **Key Term:** **Device Fingerprinting** — A technique that collects attributes from a user's browser or device (screen size, installed plugins, timezone, language, hardware characteristics) and hashes them into a unique identifier. Unlike cookies, a fingerprint cannot be cleared by the user. Unlike IP addresses, it does not change when they switch networks.

```typescript
// fraud/device/device-fingerprint.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface DeviceSignals {
  fingerprint: string;          // The computed fingerprint hash
  userAgent: string;
  screenResolution: string;     // "1920x1080"
  timezone: string;             // "America/Chicago"
  language: string;             // "en-US"
  platform: string;             // "MacIntel"
  colorDepth: number;           // 24
  hardwareConcurrency: number;  // 8 (CPU cores)
  webglRenderer: string;        // "ANGLE (NVIDIA GeForce GTX 1080)"
  canvasHash: string;           // Hash of a drawn canvas — unique per GPU
  installedFonts: string[];     // List of detected fonts
  touchSupport: boolean;        // Mobile devices have touch
  cookiesEnabled: boolean;
  doNotTrack: boolean;
}

@Injectable()
export class DeviceFingerprintService {
  private readonly logger = new Logger(DeviceFingerprintService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Analyze device signals and return fraud-relevant insights.
   * This is called during every booking attempt.
   */
  async analyzeDevice(
    userId: string,
    signals: DeviceSignals,
  ): Promise<DeviceAnalysisResult> {
    // Step 1: Look up this fingerprint's history
    const existingDevice = await this.prisma.deviceFingerprint.findUnique({
      where: { fingerprint: signals.fingerprint },
      include: {
        associatedUsers: true,
      },
    });

    // Step 2: How many accounts use this device?
    const accountCount = existingDevice?.associatedUsers.length ?? 0;

    // Step 3: Is this a new device for this user?
    const isNewDevice = !existingDevice?.associatedUsers.some(
      (u) => u.userId === userId,
    );

    // Step 4: Detect browser spoofing
    // If the user agent says "iPhone" but the platform says "Win32",
    // someone is lying about their device.
    const isSpoofed = this.detectSpoofing(signals);

    // Step 5: Detect headless browsers (bots)
    const isHeadless = this.detectHeadlessBrowser(signals);

    // Step 6: Record the association
    if (isNewDevice || !existingDevice) {
      await this.prisma.deviceFingerprint.upsert({
        where: { fingerprint: signals.fingerprint },
        create: {
          fingerprint: signals.fingerprint,
          userAgent: signals.userAgent,
          platform: signals.platform,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          associatedUsers: {
            create: { userId },
          },
        },
        update: {
          lastSeenAt: new Date(),
          associatedUsers: {
            connectOrCreate: {
              where: {
                fingerprintId_userId: {
                  fingerprintId: signals.fingerprint,
                  userId,
                },
              },
              create: { userId },
            },
          },
        },
      });
    }

    return {
      fingerprint: signals.fingerprint,
      accountCount,
      isNewDevice,
      isSpoofed,
      isHeadless,
      riskScore: this.calculateDeviceRiskScore({
        accountCount, isNewDevice, isSpoofed, isHeadless,
      }),
    };
  }

  private detectSpoofing(signals: DeviceSignals): boolean {
    // Check 1: Mobile user agent but desktop screen resolution
    const mobileUa = /iPhone|iPad|Android|Mobile/i.test(signals.userAgent);
    const desktopResolution = parseInt(signals.screenResolution.split('x')[0]) > 1400;
    if (mobileUa && desktopResolution) return true;

    // Check 2: User agent says Mac but platform says Win
    const macUa = /Macintosh/i.test(signals.userAgent);
    const winPlatform = /Win/i.test(signals.platform);
    if (macUa && winPlatform) return true;

    // Check 3: Touch support claimed but no mobile signals
    if (signals.touchSupport && !mobileUa && signals.hardwareConcurrency > 4) return true;

    return false;
  }

  private detectHeadlessBrowser(signals: DeviceSignals): boolean {
    // Headless Chrome has telltale signs
    if (/HeadlessChrome/i.test(signals.userAgent)) return true;

    // Puppeteer and Playwright set specific WebGL renderers
    if (signals.webglRenderer === 'Google SwiftShader') return true;

    // Zero installed fonts is a strong headless signal
    if (signals.installedFonts.length === 0) return true;

    // Missing or very low hardware concurrency
    if (signals.hardwareConcurrency <= 1) return true;

    return false;
  }

  private calculateDeviceRiskScore(factors: {
    accountCount: number;
    isNewDevice: boolean;
    isSpoofed: boolean;
    isHeadless: boolean;
  }): number {
    let score = 0;
    if (factors.accountCount > 5) score += 20;
    else if (factors.accountCount > 2) score += 10;
    if (factors.isNewDevice) score += 5;
    if (factors.isSpoofed) score += 25;
    if (factors.isHeadless) score += 30;
    return Math.min(score, 40); // Cap device risk contribution
  }
}

interface DeviceAnalysisResult {
  fingerprint: string;
  accountCount: number;
  isNewDevice: boolean;
  isSpoofed: boolean;
  isHeadless: boolean;
  riskScore: number;
}
```

> **Analogy:** Device fingerprinting is like a detective examining tire tracks at a crime scene. The tread pattern, tire width, wear marks, and mud composition — individually, each one is common. But the *combination* narrows down the vehicle to one in a million. Even if the driver changes license plates (IP address) or wears a disguise (different email), the tire tracks (device fingerprint) link the scenes together.

---

## 3D Secure Integration for High-Risk Transactions

When your fraud engine flags a transaction as medium-risk (score 50-79, "under review"), you have a choice: block it and lose a potentially legitimate customer, or let it through and risk a chargeback. 3D Secure (3DS) gives you a third option: **shift the liability to the card issuer**.

3DS adds an extra authentication step where the cardholder's bank verifies the transaction — typically through an SMS code, banking app notification, or biometric check. If the bank approves it and it still turns out to be fraud, the chargeback liability shifts from you (the merchant) to the issuing bank.

```typescript
// fraud/three-d-secure/three-d-secure.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { FraudVerdict } from '../engine/fraud-engine';
import Stripe from 'stripe';

export interface ThreeDSecureDecision {
  requiresAuthentication: boolean;
  reason: string;
  paymentIntentUpdate: Partial<Stripe.PaymentIntentCreateParams>;
}

@Injectable()
export class ThreeDSecureService {
  private readonly logger = new Logger(ThreeDSecureService.name);

  /**
   * Based on the fraud verdict, decide whether to require 3D Secure.
   *
   * The logic:
   * - passed (score 0-24): Do NOT require 3DS. These are trusted transactions.
   *   Adding friction to good customers costs revenue.
   * - flagged (score 25-49): Request 3DS but do not mandate it.
   *   Stripe will attempt 3DS if the card supports it.
   * - under_review (score 50-79): REQUIRE 3DS. The transaction is suspicious
   *   enough that we need the issuer's verification.
   * - blocked (score 80+): Reject outright. Do not even attempt 3DS.
   */
  decide(verdict: FraudVerdict): ThreeDSecureDecision {
    switch (verdict.status) {
      case 'passed':
        return {
          requiresAuthentication: false,
          reason: 'Low risk — 3DS not required',
          paymentIntentUpdate: {
            payment_method_options: {
              card: {
                request_three_d_secure: 'automatic', // Let Stripe decide
              },
            },
          },
        };

      case 'flagged':
        return {
          requiresAuthentication: false,
          reason: `Medium-low risk (score: ${verdict.riskScore}) — 3DS requested if available`,
          paymentIntentUpdate: {
            payment_method_options: {
              card: {
                request_three_d_secure: 'automatic',
              },
            },
            metadata: {
              fraud_score: String(verdict.riskScore),
              fraud_rules: verdict.triggeredRules.map(r => r.name).join(','),
            },
          },
        };

      case 'under_review':
        this.logger.warn(
          `Requiring 3DS for transaction with risk score ${verdict.riskScore}`,
        );
        return {
          requiresAuthentication: true,
          reason: `High risk (score: ${verdict.riskScore}) — 3DS mandatory`,
          paymentIntentUpdate: {
            payment_method_options: {
              card: {
                request_three_d_secure: 'any', // Force 3DS
              },
            },
            metadata: {
              fraud_score: String(verdict.riskScore),
              fraud_rules: verdict.triggeredRules.map(r => r.name).join(','),
              requires_review: 'true',
            },
          },
        };

      case 'blocked':
        return {
          requiresAuthentication: false,
          reason: `Blocked (score: ${verdict.riskScore}) — transaction rejected`,
          paymentIntentUpdate: {},
        };
    }
  }
}
```

> **Why Not Require 3DS for Everything?** Because it kills conversion. Every extra authentication step causes 10-15% of legitimate customers to abandon their booking. They do not have their phone handy, their bank's app is slow, or they simply do not want the hassle. Use 3DS surgically — only when the fraud risk justifies the conversion loss.

---

## Chargeback Handling Workflow

A chargeback happens when a cardholder disputes a transaction with their bank. The bank pulls the money back from you. You have a limited window (usually 7-14 days) to respond with evidence that the transaction was legitimate. If you fail to respond or your evidence is weak, you lose the money *and* pay a chargeback fee ($15-$25 per incident).

```typescript
// fraud/chargebacks/chargeback.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import Stripe from 'stripe';
import { EventEmitter2 } from '@nestjs/event-emitter';

export enum ChargebackStatus {
  RECEIVED = 'RECEIVED',
  EVIDENCE_GATHERING = 'EVIDENCE_GATHERING',
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  WON = 'WON',
  LOST = 'LOST',
  EXPIRED = 'EXPIRED',
}

@Injectable()
export class ChargebackService {
  private readonly logger = new Logger(ChargebackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: Stripe,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Called when Stripe sends a `charge.dispute.created` webhook.
   * This kicks off the entire chargeback response workflow.
   */
  async handleDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    this.logger.warn(
      `Chargeback received for charge ${dispute.charge} — amount: $${dispute.amount / 100}`,
    );

    // Step 1: Record the chargeback in our database
    const chargeback = await this.prisma.chargeback.create({
      data: {
        stripeDisputeId: dispute.id,
        stripeChargeId: dispute.charge as string,
        amount: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: ChargebackStatus.RECEIVED,
        evidenceDeadline: new Date(dispute.evidence_details.due_by * 1000),
      },
    });

    // Step 2: Find the associated booking
    const payment = await this.prisma.payment.findFirst({
      where: { stripeChargeId: dispute.charge as string },
      include: { booking: { include: { user: true } } },
    });

    if (payment) {
      // Link the chargeback to the booking and user
      await this.prisma.chargeback.update({
        where: { id: chargeback.id },
        data: {
          bookingId: payment.booking.id,
          userId: payment.booking.userId,
        },
      });

      // Step 3: Increment the user's chargeback count
      // This feeds back into the fraud rules engine
      await this.prisma.user.update({
        where: { id: payment.booking.userId },
        data: { chargebackCount: { increment: 1 } },
      });

      // Step 4: Auto-block repeat offenders
      const user = await this.prisma.user.findUnique({
        where: { id: payment.booking.userId },
      });

      if (user && user.chargebackCount >= 3) {
        await this.blockUser(user.id, 'Exceeded chargeback threshold (3+)');
      }
    }

    // Step 5: Gather evidence automatically
    await this.gatherEvidence(chargeback.id, dispute);

    // Step 6: Notify the fraud team
    this.eventEmitter.emit('chargeback.received', {
      chargebackId: chargeback.id,
      amount: dispute.amount,
      reason: dispute.reason,
      deadline: dispute.evidence_details.due_by,
    });
  }

  /**
   * Automatically gather evidence for the dispute response.
   * The more evidence you provide, the higher your win rate.
   */
  private async gatherEvidence(
    chargebackId: string,
    dispute: Stripe.Dispute,
  ): Promise<void> {
    const chargeback = await this.prisma.chargeback.findUnique({
      where: { id: chargebackId },
      include: {
        booking: {
          include: {
            user: true,
            checkins: true,
            reviews: true,
          },
        },
      },
    });

    if (!chargeback?.booking) return;

    const booking = chargeback.booking;
    const evidence: Stripe.DisputeUpdateParams.Evidence = {};

    // Evidence 1: Customer communication (emails, support tickets)
    const supportTickets = await this.prisma.supportTicket.findMany({
      where: { userId: booking.userId, bookingId: booking.id },
      orderBy: { createdAt: 'asc' },
    });

    if (supportTickets.length > 0) {
      evidence.customer_communication = supportTickets
        .map(t => `[${t.createdAt.toISOString()}] ${t.subject}: ${t.body}`)
        .join('\n---\n');
    }

    // Evidence 2: Check-in records (proof the guest actually stayed)
    if (booking.checkins.length > 0) {
      evidence.service_date = booking.checkins[0].checkinDate
        .toISOString()
        .split('T')[0];
      evidence.service_documentation =
        `Guest checked in on ${booking.checkins[0].checkinDate.toISOString()}. ` +
        `Check-in confirmed by hotel staff.`;
    }

    // Evidence 3: IP address and device info from the original booking
    const fraudEvent = await this.prisma.fraudEvent.findFirst({
      where: { bookingId: booking.id },
    });

    if (fraudEvent) {
      evidence.access_activity_log =
        `Booking created at ${fraudEvent.createdAt.toISOString()} ` +
        `from IP ${fraudEvent.ipAddress}, ` +
        `device: ${fraudEvent.userAgent}`;
    }

    // Evidence 4: Review posted by the user (strong proof they used the service)
    if (booking.reviews.length > 0) {
      evidence.service_documentation +=
        `\n\nGuest posted a review: "${booking.reviews[0].content}" ` +
        `(Rating: ${booking.reviews[0].rating}/5)`;
    }

    // Submit the evidence to Stripe
    await this.stripe.disputes.update(dispute.id, { evidence });

    await this.prisma.chargeback.update({
      where: { id: chargebackId },
      data: { status: ChargebackStatus.EVIDENCE_SUBMITTED },
    });

    this.logger.log(`Evidence submitted for chargeback ${chargebackId}`);
  }

  private async blockUser(userId: string, reason: string): Promise<void> {
    await this.prisma.blockedUser.create({
      data: {
        userId,
        reason,
        blockedAt: new Date(),
        blockedBy: 'SYSTEM_AUTO',
      },
    });
    this.logger.warn(`User ${userId} blocked: ${reason}`);
  }
}
```

> **Mentor's Note:** Your chargeback win rate is a key metric. The industry average is around 30%. With automated evidence gathering (IP logs, check-in records, guest reviews), we pushed ours to 58%. The evidence is already in your database — it just needs to be compiled and submitted before the deadline. Automate this or you will miss deadlines and lose disputes by default.

---

## Full NestJS FraudDetectionService Implementation

Now let us tie everything together into a single service that the booking endpoint calls. This is the integration point — it orchestrates the rules engine, device analysis, 3DS decision, and event logging.

```typescript
// fraud/fraud-detection.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FraudEngine, FraudVerdict } from './engine/fraud-engine';
import { DeviceFingerprintService, DeviceSignals } from './device/device-fingerprint.service';
import { ThreeDSecureService, ThreeDSecureDecision } from './three-d-secure/three-d-secure.service';
import { FraudContext } from './rules/fraud-rule.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';

export interface FraudCheckRequest {
  userId: string;
  bookingId: string;
  amount: number;
  currency: string;
  ipAddress: string;
  email: string;
  cardBIN: string;
  cardLastFour: string;
  billingCountry: string;
  userAgent: string;
  sessionId: string;
  deviceSignals: DeviceSignals;
  guestName?: string;
  checkInDate?: Date;
  checkOutDate?: Date;
  isRefundable?: boolean;
}

export interface FraudCheckResult {
  verdict: FraudVerdict;
  deviceAnalysis: {
    fingerprint: string;
    isNewDevice: boolean;
    isSpoofed: boolean;
    isHeadless: boolean;
    accountCount: number;
  };
  threeDSecure: ThreeDSecureDecision;
  shouldProceed: boolean;
  eventId: string; // Reference to the stored fraud event
}

@Injectable()
export class FraudDetectionService {
  private readonly logger = new Logger(FraudDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fraudEngine: FraudEngine,
    private readonly deviceService: DeviceFingerprintService,
    private readonly threeDSecure: ThreeDSecureService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The main entry point. Called by the booking controller
   * before processing payment.
   *
   * Returns a result that tells the controller:
   * 1. Whether to proceed with the booking
   * 2. Whether to require 3D Secure
   * 3. The full fraud analysis for logging
   */
  async checkTransaction(request: FraudCheckRequest): Promise<FraudCheckResult> {
    const startTime = Date.now();

    // Step 1: Check if this user is on the blocklist
    const isBlocked = await this.isUserBlocked(request.userId);
    if (isBlocked) {
      this.logger.warn(`Blocked user ${request.userId} attempted a booking`);
      const blockEvent = await this.recordFraudEvent(request, {
        status: 'blocked',
        riskScore: 100,
        maxPossibleScore: 100,
        triggeredRules: [{ name: 'blocklist', score: 100, reason: 'User is on the blocklist' }],
        canProceed: false,
        requiresReview: false,
        evaluationTimeMs: Date.now() - startTime,
      });

      return {
        verdict: {
          status: 'blocked',
          riskScore: 100,
          maxPossibleScore: 100,
          triggeredRules: [{ name: 'blocklist', score: 100, reason: 'User is blocked' }],
          canProceed: false,
          requiresReview: false,
          evaluationTimeMs: Date.now() - startTime,
        },
        deviceAnalysis: {
          fingerprint: request.deviceSignals.fingerprint,
          isNewDevice: false,
          isSpoofed: false,
          isHeadless: false,
          accountCount: 0,
        },
        threeDSecure: {
          requiresAuthentication: false,
          reason: 'Blocked user',
          paymentIntentUpdate: {},
        },
        shouldProceed: false,
        eventId: blockEvent.id,
      };
    }

    // Step 2: Run device analysis and fraud rules in parallel
    const [deviceAnalysis, verdict] = await Promise.all([
      this.deviceService.analyzeDevice(request.userId, request.deviceSignals),
      this.fraudEngine.evaluate(this.buildContext(request)),
    ]);

    // Step 3: Combine device risk with rules engine score
    // The device score augments, not replaces, the rules engine score
    const combinedScore = Math.min(
      verdict.riskScore + deviceAnalysis.riskScore,
      100,
    );
    const adjustedVerdict: FraudVerdict = {
      ...verdict,
      riskScore: combinedScore,
      triggeredRules: [
        ...verdict.triggeredRules,
        ...(deviceAnalysis.riskScore > 0
          ? [{
              name: 'device_analysis',
              score: deviceAnalysis.riskScore,
              reason: [
                deviceAnalysis.isSpoofed && 'Browser spoofing detected',
                deviceAnalysis.isHeadless && 'Headless browser detected',
                deviceAnalysis.accountCount > 5 && `Device shared by ${deviceAnalysis.accountCount} accounts`,
              ].filter(Boolean).join('; '),
            }]
          : []),
      ],
      status: combinedScore >= 80 ? 'blocked'
        : combinedScore >= 50 ? 'under_review'
        : combinedScore >= 25 ? 'flagged'
        : 'passed',
      canProceed: combinedScore < 80,
      requiresReview: combinedScore >= 50 && combinedScore < 80,
    };

    // Step 4: Determine 3D Secure requirement
    const threeDSecureDecision = this.threeDSecure.decide(adjustedVerdict);

    // Step 5: Record the fraud event for auditing and ML training
    const fraudEvent = await this.recordFraudEvent(request, adjustedVerdict);

    // Step 6: Emit events for downstream consumers
    if (adjustedVerdict.requiresReview) {
      this.eventEmitter.emit('fraud.review_required', {
        eventId: fraudEvent.id,
        bookingId: request.bookingId,
        riskScore: adjustedVerdict.riskScore,
        triggeredRules: adjustedVerdict.triggeredRules,
      });
    }

    if (adjustedVerdict.status === 'blocked') {
      this.eventEmitter.emit('fraud.transaction_blocked', {
        eventId: fraudEvent.id,
        bookingId: request.bookingId,
        userId: request.userId,
        riskScore: adjustedVerdict.riskScore,
      });
    }

    const totalTime = Date.now() - startTime;
    this.logger.log(
      `Fraud check completed in ${totalTime}ms: ` +
      `score=${adjustedVerdict.riskScore}, status=${adjustedVerdict.status}, ` +
      `3ds=${threeDSecureDecision.requiresAuthentication}`,
    );

    return {
      verdict: adjustedVerdict,
      deviceAnalysis: {
        fingerprint: deviceAnalysis.fingerprint,
        isNewDevice: deviceAnalysis.isNewDevice,
        isSpoofed: deviceAnalysis.isSpoofed,
        isHeadless: deviceAnalysis.isHeadless,
        accountCount: deviceAnalysis.accountCount,
      },
      threeDSecure: threeDSecureDecision,
      shouldProceed: adjustedVerdict.canProceed,
      eventId: fraudEvent.id,
    };
  }

  private buildContext(request: FraudCheckRequest): FraudContext {
    return {
      userId: request.userId,
      bookingId: request.bookingId,
      amount: request.amount,
      currency: request.currency,
      ipAddress: request.ipAddress,
      deviceFingerprint: request.deviceSignals.fingerprint,
      email: request.email,
      cardBIN: request.cardBIN,
      cardLastFour: request.cardLastFour,
      billingCountry: request.billingCountry,
      userAgent: request.userAgent,
      sessionId: request.sessionId,
      timestamp: new Date(),
      metadata: {
        guestName: request.guestName,
        checkInDate: request.checkInDate,
        checkOutDate: request.checkOutDate,
        isRefundable: request.isRefundable,
      },
    };
  }

  private async isUserBlocked(userId: string): Promise<boolean> {
    const blocked = await this.prisma.blockedUser.findFirst({
      where: {
        userId,
        unblockedAt: null, // Still active block
      },
    });
    return blocked !== null;
  }

  private async recordFraudEvent(
    request: FraudCheckRequest,
    verdict: FraudVerdict,
  ) {
    return this.prisma.fraudEvent.create({
      data: {
        bookingId: request.bookingId,
        userId: request.userId,
        ipAddress: request.ipAddress,
        deviceFingerprint: request.deviceSignals.fingerprint,
        userAgent: request.userAgent,
        cardBin: request.cardBIN,
        cardLastFour: request.cardLastFour,
        amount: request.amount,
        currency: request.currency,
        riskScore: verdict.riskScore,
        status: verdict.status,
        triggeredRules: verdict.triggeredRules,
        canProceed: verdict.canProceed,
        requiresReview: verdict.requiresReview,
        evaluationTimeMs: verdict.evaluationTimeMs,
      },
    });
  }
}
```

Here is how the booking controller uses the fraud detection service:

```typescript
// bookings/bookings.controller.ts (relevant excerpt)
@Post()
async createBooking(
  @Body() dto: CreateBookingDto,
  @Req() req: Request,
  @CurrentUser() user: AuthenticatedUser,
): Promise<BookingResponse> {
  // Step 1: Run fraud check BEFORE processing payment
  const fraudResult = await this.fraudDetection.checkTransaction({
    userId: user.id,
    bookingId: generateId(), // Pre-generated ID
    amount: dto.totalAmount,
    currency: dto.currency,
    ipAddress: req.ip,
    email: user.email,
    cardBIN: dto.paymentMethod.cardBin,
    cardLastFour: dto.paymentMethod.lastFour,
    billingCountry: dto.paymentMethod.billingCountry,
    userAgent: req.headers['user-agent'] || '',
    sessionId: req.session?.id || '',
    deviceSignals: dto.deviceSignals,
    guestName: dto.guestName,
    checkInDate: dto.checkInDate,
    checkOutDate: dto.checkOutDate,
    isRefundable: dto.isRefundable,
  });

  // Step 2: Act on the verdict
  if (!fraudResult.shouldProceed) {
    // Do NOT tell the fraudster why they were blocked.
    // A generic error prevents them from learning your rules.
    throw new BadRequestException(
      'Unable to process this booking. Please contact support.',
    );
  }

  // Step 3: Create the booking, applying 3DS if needed
  const booking = await this.bookingService.create(dto, {
    paymentIntentOptions: fraudResult.threeDSecure.paymentIntentUpdate,
    fraudEventId: fraudResult.eventId,
    requiresReview: fraudResult.verdict.requiresReview,
  });

  return booking;
}
```

> **What If You Skip This?** Without a central `FraudDetectionService`, fraud checks get sprinkled across controllers, middleware, and payment services. Each one checks a different thing. None of them share context. When the fraud team asks "what percentage of blocked transactions were false positives last month?" — nobody can answer because the data is scattered across six different log formats. Centralization is not about elegance; it is about operational necessity.

---

## Prisma Schema for Fraud Detection

Every service above depends on database tables. Here is the complete Prisma schema for the fraud detection system. Notice how every table has a purpose — fraud events for real-time logging, fraud rules for configuration, blocked users for enforcement, and review items for the human-in-the-loop queue.

```prisma
// prisma/schema.prisma (fraud-related models)

model FraudEvent {
  id                String   @id @default(uuid())
  bookingId         String?
  userId            String
  ipAddress         String
  deviceFingerprint String?
  userAgent         String?
  cardBin           String?  // First 6-8 digits — identifies issuing bank
  cardLastFour      String?
  amount            Float
  currency          String   @default("USD")
  riskScore         Int
  status            String   // 'passed', 'flagged', 'under_review', 'blocked'
  triggeredRules    Json     // Array of { name, score, reason }
  canProceed        Boolean
  requiresReview    Boolean  @default(false)
  evaluationTimeMs  Int?
  resolvedBy        String?  // Analyst who reviewed this event
  resolvedAt        DateTime?
  resolution        String?  // 'confirmed_fraud', 'false_positive', 'inconclusive'
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  // Relations
  booking           Booking?  @relation(fields: [bookingId], references: [id])
  user              User      @relation(fields: [userId], references: [id])

  // Indexes for the velocity queries — without these, every fraud check
  // triggers a full table scan. That takes 800ms instead of 2ms.
  @@index([ipAddress, createdAt])
  @@index([userId, createdAt])
  @@index([deviceFingerprint, createdAt])
  @@index([cardBin, cardLastFour, createdAt])
  @@index([status, createdAt])
  @@index([requiresReview, resolvedAt])

  @@map("fraud_events")
}

model FraudRule {
  id          String   @id @default(uuid())
  name        String   @unique         // 'velocity_check', 'geo_anomaly', etc.
  description String
  maxScore    Int
  enabled     Boolean  @default(true)
  config      Json     // Rule-specific configuration (thresholds, lists, etc.)
  version     Int      @default(1)     // Track configuration changes
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  updatedBy   String?                  // Who changed this rule last

  @@map("fraud_rules")
}

model BlockedUser {
  id          String    @id @default(uuid())
  userId      String
  reason      String
  blockedAt   DateTime  @default(now())
  blockedBy   String    // 'SYSTEM_AUTO' or analyst's user ID
  unblockedAt DateTime? // Null = still blocked
  unblockedBy String?
  notes       String?

  user        User      @relation(fields: [userId], references: [id])

  @@index([userId, unblockedAt])
  @@map("blocked_users")
}

model FraudReviewItem {
  id                String   @id @default(uuid())
  userId            String?
  deviceFingerprint String?
  bookingId         String?
  fraudEventId      String?
  reason            String   // 'multi_card_usage', 'multi_account_device', etc.
  details           Json     // Context for the reviewer
  status            String   @default("PENDING") // 'PENDING', 'APPROVED', 'REJECTED'
  priority          Int      @default(0)         // Higher = more urgent
  assignedTo        String?  // Analyst ID
  reviewedAt        DateTime?
  reviewNotes       String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([userId, reason])
  @@index([status, priority, createdAt])
  @@map("fraud_review_items")
}

model Chargeback {
  id               String    @id @default(uuid())
  stripeDisputeId  String    @unique
  stripeChargeId   String
  bookingId        String?
  userId           String?
  amount           Int       // In cents
  currency         String
  reason           String    // Stripe dispute reason code
  status           String    // ChargebackStatus enum values
  evidenceDeadline DateTime
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  booking          Booking?  @relation(fields: [bookingId], references: [id])
  user             User?     @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([status])
  @@index([evidenceDeadline])
  @@map("chargebacks")
}

model DeviceFingerprint {
  fingerprint     String   @id
  userAgent       String?
  platform        String?
  firstSeenAt     DateTime @default(now())
  lastSeenAt      DateTime @default(now())

  associatedUsers DeviceUserAssociation[]

  @@map("device_fingerprints")
}

model DeviceUserAssociation {
  id            String   @id @default(uuid())
  fingerprintId String
  userId        String
  firstSeenAt   DateTime @default(now())
  lastSeenAt    DateTime @default(now())

  fingerprint   DeviceFingerprint @relation(fields: [fingerprintId], references: [fingerprint])
  user          User              @relation(fields: [userId], references: [id])

  @@unique([fingerprintId, userId])
  @@map("device_user_associations")
}

model FraudConfig {
  key       String   @id
  value     String   // JSON string — parsed at read time
  updatedAt DateTime @updatedAt
  updatedBy String?

  @@map("fraud_config")
}

model LoginHistory {
  id        String   @id @default(uuid())
  userId    String
  ipAddress String
  country   String?
  userAgent String?
  createdAt DateTime @default(now())

  user      User     @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@map("login_history")
}
```

> **Why So Many Indexes?** The velocity check rule runs six queries per booking attempt. Without indexes on `(ipAddress, createdAt)`, `(userId, createdAt)`, and `(deviceFingerprint, createdAt)`, each query scans the entire `fraud_events` table. At 100,000 events per day, that is a full table scan six times per booking — roughly 800ms per fraud check. With the indexes, each query is an index seek: 1-3ms. The indexes cost ~15% more disk space and slightly slower writes. That trade-off is not even close.

---

## Balancing False Positives vs False Negatives

This is the hardest part of fraud detection. Not the code — the *calibration*.

- **False Positive (Type I Error):** You block a legitimate customer. They get an error message, cannot complete their booking, and call support angry — or worse, they go to a competitor. Every false positive costs you revenue and customer trust.

- **False Negative (Type II Error):** You let a fraudulent transaction through. You process the payment, the fraudster gets what they want, and you eat the chargeback 60 days later. Every false negative costs you money directly.

The tension is real and unavoidable. If you make your rules strict (low thresholds), you catch more fraud but also block more legitimate customers. If you make them lenient (high thresholds), fewer good customers are blocked but more fraud gets through.

> **Analogy:** Imagine airport security. If the metal detector is set to maximum sensitivity, it beeps for belt buckles, coins, and hip replacements — massive queues, angry travelers, and no real security improvement. If it is set to minimum sensitivity, a knife gets through. The right setting detects weapons without flagging wallets. Finding that setting requires data, testing, and constant adjustment.

Here is how to think about the trade-off quantitatively:

```typescript
// fraud/metrics/fraud-metrics.service.ts
// This service calculates key fraud metrics weekly.
// These numbers drive threshold adjustments.

interface FraudMetrics {
  // Core rates
  fraudRate: number;              // Confirmed fraud / total transactions
  falsePositiveRate: number;      // Blocked but legitimate / total blocked
  falseNegativeRate: number;      // Missed fraud / total fraud
  blockRate: number;              // Total blocked / total transactions

  // Financial impact
  fraudLosses: number;            // $ lost to fraud that got through
  revenueBlockedByFP: number;     // $ of legitimate bookings we accidentally blocked
  chargebackRate: number;         // Chargebacks / total charges (Visa/MC threshold: 1%)
  chargebackWinRate: number;      // Disputes won / total disputes

  // Operational
  reviewQueueSize: number;        // How many items waiting for human review
  avgReviewTimeMinutes: number;   // How long items sit in queue
  rulesTriggeredDistribution: Record<string, number>; // Which rules fire most
}

// The key insight: track the COST of each type of error.
// A false positive on a $2000 booking costs more than a
// false positive on a $50 booking.
//
// Expected cost of false positive = (false positive rate) * (avg booking value) * (margin)
// Expected cost of false negative = (false negative rate) * (avg fraud amount) * (1 + chargeback fee %)
//
// Optimize thresholds to minimize TOTAL cost, not just one rate.
```

In practice, most booking platforms aim for these targets:

| Metric | Target | Danger Zone |
|---|---|---|
| Fraud rate | < 0.1% of transactions | > 0.5% |
| False positive rate | < 5% of blocked transactions | > 20% |
| Block rate | < 2% of total transactions | > 5% |
| Chargeback rate | < 0.5% of charges | > 1% (Visa/MC penalty threshold) |
| Review queue time | < 4 hours avg | > 24 hours |

> **Mentor's Note:** When you launch fraud detection for the first time, set your blocking threshold high (conservative — block less). Use the first two weeks to observe what gets flagged and what gets blocked. Check every blocked transaction manually. Adjust thresholds based on what you find. The data will tell you where the boundary is. Your intuition will not.

---

## The Fraud Review Queue: Human-in-the-Loop

Automated rules handle the clear cases — obviously legitimate (score 0-24) and obviously fraudulent (score 80+). But the middle ground (score 25-79) requires human judgment. This is the fraud review queue: a dashboard where trained analysts examine flagged transactions and decide whether to approve or reject them.

```typescript
// fraud/review/fraud-review.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FraudReviewService {
  private readonly logger = new Logger(FraudReviewService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get the next batch of review items for an analyst.
   * Items are prioritized by risk score (highest first)
   * and age (oldest first within the same priority).
   */
  async getReviewQueue(
    analystId: string,
    limit: number = 20,
  ): Promise<ReviewQueueItem[]> {
    const items = await this.prisma.fraudReviewItem.findMany({
      where: {
        status: 'PENDING',
        OR: [
          { assignedTo: null },       // Unassigned items
          { assignedTo: analystId },  // Items already assigned to this analyst
        ],
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'asc' },
      ],
      take: limit,
      include: {
        // The Prisma schema does not have direct relations here,
        // so we fetch related data separately below
      },
    });

    // Enrich each item with context that helps the analyst decide
    const enriched = await Promise.all(
      items.map(async (item) => {
        const context = await this.buildReviewContext(item);
        return { ...item, context };
      }),
    );

    // Assign unassigned items to this analyst
    const unassigned = items.filter(i => !i.assignedTo);
    if (unassigned.length > 0) {
      await this.prisma.fraudReviewItem.updateMany({
        where: { id: { in: unassigned.map(i => i.id) } },
        data: { assignedTo: analystId },
      });
    }

    return enriched;
  }

  /**
   * Record the analyst's decision.
   * This decision feeds back into the ML training dataset.
   */
  async resolveReviewItem(
    itemId: string,
    analystId: string,
    decision: 'APPROVED' | 'REJECTED',
    notes: string,
  ): Promise<void> {
    // Update the review item
    await this.prisma.fraudReviewItem.update({
      where: { id: itemId },
      data: {
        status: decision,
        reviewedAt: new Date(),
        reviewNotes: notes,
      },
    });

    // Also update the associated fraud event with the analyst's resolution
    const item = await this.prisma.fraudReviewItem.findUnique({
      where: { id: itemId },
    });

    if (item?.fraudEventId) {
      await this.prisma.fraudEvent.update({
        where: { id: item.fraudEventId },
        data: {
          resolvedBy: analystId,
          resolvedAt: new Date(),
          resolution: decision === 'APPROVED' ? 'false_positive' : 'confirmed_fraud',
        },
      });
    }

    // If rejected (confirmed fraud) and there is a userId, consider blocking
    if (decision === 'REJECTED' && item?.userId) {
      const recentFraud = await this.prisma.fraudEvent.count({
        where: {
          userId: item.userId,
          resolution: 'confirmed_fraud',
          resolvedAt: { gte: new Date(Date.now() - 90 * 86_400_000) }, // Last 90 days
        },
      });

      if (recentFraud >= 2) {
        await this.prisma.blockedUser.create({
          data: {
            userId: item.userId,
            reason: `${recentFraud} confirmed fraud events in 90 days`,
            blockedBy: analystId,
          },
        });
        this.logger.warn(
          `User ${item.userId} auto-blocked after ${recentFraud} confirmed fraud events`,
        );
      }
    }

    this.logger.log(
      `Review item ${itemId} resolved as ${decision} by ${analystId}`,
    );
  }

  private async buildReviewContext(item: any): Promise<ReviewContext> {
    const context: ReviewContext = {
      userHistory: null,
      recentFraudEvents: [],
      relatedBookings: [],
    };

    if (item.userId) {
      // Get the user's complete history for the analyst
      context.userHistory = await this.prisma.user.findUnique({
        where: { id: item.userId },
        select: {
          id: true,
          email: true,
          createdAt: true,
          chargebackCount: true,
          _count: { select: { bookings: true } },
        },
      });

      context.recentFraudEvents = await this.prisma.fraudEvent.findMany({
        where: { userId: item.userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    }

    return context;
  }
}

interface ReviewQueueItem {
  id: string;
  reason: string;
  details: any;
  priority: number;
  createdAt: Date;
  context: ReviewContext;
}

interface ReviewContext {
  userHistory: any;
  recentFraudEvents: any[];
  relatedBookings: any[];
}
```

> **Key Term:** **Human-in-the-Loop** — A system design where automated processes handle clear-cut decisions, but ambiguous cases are routed to a human expert for judgment. In fraud detection, the "loop" means the analyst's decisions feed back into the system — false positives cause threshold adjustments, confirmed fraud cases become training data for the ML model. The human is not just making one-off decisions; they are teaching the system.

---

## Production War Story: The Promo Code Fraud Ring

This one is real. Names and numbers have been changed, but the incident happened.

Our marketing team launched a "WINTER40" promo code — 40% off any hotel booking, capped at $200 per use, limited to "new accounts only." The idea was to acquire new customers during a slow season.

Within 72 hours, 847 new accounts were created. All used the WINTER40 code. Total discount value: $114,380. The bookings were at premium hotels in Miami, Las Vegas, and New York — all for dates three to six months in the future. Our fraud rules did not flag any of them. Why?

1. **Velocity checks passed.** The accounts were created at a pace of ~12 per hour, spread over three days. Our threshold was 20 per hour per IP. They used residential proxies, so each account came from a different IP address.

2. **Amount thresholds passed.** Each booking was $400-$600 after the discount — well within normal range.

3. **Device fingerprinting was not deployed yet.** This was the gap. If we had device fingerprints, we would have seen that all 847 accounts shared three device fingerprints. Three devices. Eight hundred and forty-seven accounts.

4. **The email addresses looked real.** They were not `throwaway123@tempmail.com`. They were `sarah.mitchell.2024@gmail.com`, `j.rivera.booking@outlook.com` — real-looking addresses created in bulk.

The fraud was discovered when a hotel partner called to report 30 reservations from different "guests" who never checked in and all requested refunds to the same bank account. That was the pattern — book with the promo, cancel before check-in, collect the refund.

**What we fixed:**

1. Deployed device fingerprinting within two weeks.
2. Added a rule: if a promo code is redeemed more than N times by accounts sharing a device fingerprint, block all accounts linked to that fingerprint.
3. Changed refund policy: refunds go back to the original payment method only. No transfers to different accounts.
4. Added a "promo code velocity" rule: if any single promo code sees more than 50 redemptions in 24 hours, pause it and alert the fraud team.
5. Required email verification for promo code eligibility — the account must have a verified email at least 48 hours before the promo can be used.

**Total cost:** $114,380 in fraudulent discounts, plus ~$30,000 in engineering time to build and deploy the fixes, plus an unmeasurable amount of trust lost with hotel partners.

**The lesson:** Fraud does not only come from stolen cards. Promo abuse is a distinct attack vector, and it requires distinct defenses. Your rules engine needs marketing-aware rules, not just payment-aware rules.

---

## Common Mistakes

### Mistake 1: Telling the Fraudster Why They Were Blocked

```typescript
// WRONG — You are training the adversary
throw new BadRequestException(
  'Transaction blocked: velocity check exceeded. Too many attempts from this IP address.'
);

// RIGHT — Generic error, log details internally
throw new BadRequestException(
  'Unable to process this booking. Please contact support if this continues.'
);
// Internal log: { reason: 'velocity_check', ip: '185.220.101.42', attempts: 47 }
```

When you tell a fraudster exactly which rule caught them, they adjust their script and retry. A card tester who learns you have a velocity check will simply slow down to 4 attempts per minute instead of 50. A generic error message gives them nothing to work with. Log the details for your fraud team, but never expose them in the API response.

### Mistake 2: Hard-Coding Thresholds in Source Code

```typescript
// WRONG — requires a deploy to change
if (attemptsPerMinute > 5) {
  score += 15;
}

// RIGHT — load from database, changeable via admin UI
const threshold = await this.getThreshold('ip_attempts_per_minute'); // Reads from fraud_rules
if (attemptsPerMinute > threshold) {
  score += this.getScore('ip_velocity_exceeded');
}
```

Fraud patterns change faster than your deploy cycle. If your threshold is hard-coded, changing it from 5 to 3 requires a code change, a PR review, a CI build, a staging test, and a production deploy. By the time that completes, the fraudster has made 500 more attempts. Database-driven thresholds can be adjusted in seconds through an admin panel.

### Mistake 3: Running Fraud Checks After Payment

```typescript
// WRONG — you already charged the card
const paymentResult = await this.stripe.paymentIntents.create({ ... });
const fraudCheck = await this.fraudDetection.checkTransaction(context);
if (!fraudCheck.shouldProceed) {
  await this.stripe.refunds.create({ payment_intent: paymentResult.id });
  // Now you have a charge AND a refund on the customer's statement.
  // The chargeback liability is already created.
}

// RIGHT — check before charging
const fraudCheck = await this.fraudDetection.checkTransaction(context);
if (!fraudCheck.shouldProceed) {
  throw new BadRequestException('Unable to process this booking.');
}
const paymentResult = await this.stripe.paymentIntents.create({
  ...paymentOptions,
  ...fraudCheck.threeDSecure.paymentIntentUpdate,
});
```

Running fraud checks after payment creates two problems: (1) you have already created a charge on a potentially stolen card, which means the real cardholder may see it and file a chargeback even if you refund immediately, and (2) refunds take 5-10 business days to appear, causing customer confusion.

### Mistake 4: Not Indexing Your Fraud Tables

Every velocity check rule runs multiple COUNT queries with time-range filters. Without the right indexes, these queries scan the entire table. At 50,000 fraud events per day, a `COUNT(*) WHERE ipAddress = '...' AND createdAt > NOW() - INTERVAL '1 hour'` takes 400ms without an index and 2ms with a composite index on `(ipAddress, createdAt)`. Multiply by six queries per fraud check, and you have added 2.4 seconds to every booking request. Always add composite indexes that match your query patterns.

### Mistake 5: Ignoring the Feedback Loop

If your fraud review queue resolves cases as "false positive" but that information never feeds back into threshold adjustments or ML model retraining, your system never improves. Every false positive resolution should be logged as a training signal. Every confirmed fraud should be a positive label. Schedule monthly reviews of your false positive rate and adjust thresholds accordingly.

---

## Chapter Summary

| Topic | Key Concept | Implementation |
|---|---|---|
| **Fraud Patterns** | Six major patterns: card testing, promo abuse, ATO, friendly fraud, triangulation, refund fraud | Each pattern has distinct signals — build detection for all six, not just card testing |
| **Rules Engine** | Configurable, pluggable rules that run in parallel and score independently | `FraudEngine` with `FraudRule` interface; rules loaded from database; thresholds adjustable without deploy |
| **Velocity Checks** | Count attempts per time window per source (IP, user, card, device) | `VelocityCheckRule` with six parallel COUNT queries against indexed `fraud_events` table |
| **Geo-Anomaly Detection** | Compare current IP location with user history and billing country | `GeoAnomalyRule` using IP geolocation service + `login_history` table |
| **Amount Analysis** | Flag micro-transactions (card testing) and amounts far above user's average | `AmountThresholdRule` comparing against `booking` aggregate stats |
| **ML Scoring** | Feature engineering is 80% of the model's value; algorithm is 20% | `FeatureExtractor` converting 25+ raw signals into numeric feature vector |
| **Real-Time vs Batch** | Real-time for individual transactions (< 200ms); batch for cross-user patterns (hourly/daily) | `BatchFraudAnalyzer` with `@Cron` for device clustering and multi-card detection |
| **Device Fingerprinting** | Browser/device attributes combined into a unique hash; detects multi-account fraud | `DeviceFingerprintService` with spoofing detection and headless browser detection |
| **3D Secure** | Shift liability to card issuer for medium-risk transactions; avoid for low-risk (kills conversion) | `ThreeDSecureService` mapping fraud verdict to Stripe `request_three_d_secure` parameter |
| **Chargebacks** | Automate evidence gathering; respond before deadline; auto-block repeat offenders | `ChargebackService` handling Stripe `charge.dispute.created` webhook |
| **FraudDetectionService** | Central orchestrator: blocklist check, parallel rules + device analysis, 3DS decision, event logging | Single entry point called by booking controller before payment processing |
| **Prisma Schema** | Seven models: `FraudEvent`, `FraudRule`, `BlockedUser`, `FraudReviewItem`, `Chargeback`, `DeviceFingerprint`, `FraudConfig` | Composite indexes on every column used in velocity queries |
| **False Positives** | Track cost of false positives (lost revenue) vs false negatives (fraud losses); optimize for total cost | Start conservative (block less), measure for two weeks, adjust thresholds based on data |
| **Review Queue** | Human-in-the-loop for ambiguous cases (score 25-79); decisions feed back into ML training | `FraudReviewService` with priority queue, analyst assignment, and feedback loop |
| **Error Messages** | Never reveal which rule blocked a transaction — generic errors only | `'Unable to process this booking. Please contact support.'` — log details internally |

---

> **Final Mentor's Note:** Fraud detection is an arms race. You build a rule; the fraudster adapts. You deploy a model; they find the blind spot. The system you build today will not catch the attacks of six months from now. That is normal. What matters is that your architecture supports rapid iteration — new rules in minutes, threshold changes in seconds, feedback loops that make the system smarter over time. The code in this chapter gives you that foundation. The rest is vigilance.

---

*Next Chapter: Chapter 29 — GDPR & Data Privacy: The Law Meets Code*
