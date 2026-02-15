# Chapter 29: GDPR & Data Privacy — The Law Meets Code

## It Is Not Just a Cookie Banner

If you have heard of GDPR, you probably think it means slapping a cookie consent popup on your website. That popup is the tip of the iceberg — the part the user sees. Underneath, GDPR imposes deep, structural requirements on how you collect, store, process, share, and delete personal data in every layer of your backend.

GDPR (General Data Protection Regulation) is a European Union regulation that took effect on May 25, 2018. But its reach is global: it applies to **any company** that processes data of EU residents — regardless of where the company is headquartered or where its servers run. If a user in Berlin books a hotel through your platform, and your servers are in Ohio, GDPR applies to you. Violations carry fines up to **4% of global annual revenue** or 20 million euros, whichever is higher. Not profit — revenue.

Let that sink in. For a company making $500 million per year, that is a potential $20 million fine. Per incident. In January 2023, Meta was fined $414 million for GDPR violations related to its legal basis for processing personal data in targeted advertising. In 2024, the cumulative total of GDPR fines exceeded $4.5 billion.

This chapter is not legal advice. But it is a comprehensive engineering guide to the backend systems you need to build to comply with GDPR's most technically demanding requirements — in a distributed system handling 100,000 bookings per minute across multiple regions and data stores.

---

## The Seven Principles of GDPR

Before writing a single line of code, you need to understand the seven principles that underpin the entire regulation. Every technical decision you make should trace back to one or more of these principles.

### 1. Lawfulness, Fairness, and Transparency

You must have a **legal reason** to process personal data (we will cover the six lawful bases shortly). You must process it fairly (no hidden agendas). And you must tell users exactly what you are doing with their data in plain language — not buried in a 47-page Terms of Service document.

### 2. Purpose Limitation

You can only collect data for a **specific, stated purpose**. If you collect an email address to send booking confirmations, you cannot later use it for marketing without separate consent. Every field in every database table should map to a documented purpose.

### 3. Data Minimization

Collect only what you **actually need**. If your booking flow works without a user's date of birth, do not ask for it. Every additional field you collect is more data to protect, more data to delete on request, and more data that can leak in a breach. Less is more.

> **Analogy:** Data minimization is like packing for a trip. Every item you add to your suitcase is something you have to carry, keep track of, and potentially lose. If you do not need a winter coat in July, leave it at home. If you do not need a user's middle name to process their booking, do not collect it.

### 4. Accuracy

Personal data must be **accurate and kept up to date**. If a user changes their email address, your records should reflect that. Inaccurate data leads to wrong decisions — imagine sending a booking confirmation to an old email address that now belongs to a different person.

### 5. Storage Limitation

Do not keep personal data **longer than necessary** for its stated purpose. Once the purpose is fulfilled, delete it or anonymize it. We will build automated retention policies later in this chapter.

### 6. Integrity and Confidentiality

You must protect personal data against **unauthorized access, accidental loss, destruction, or damage**. This means encryption at rest and in transit, access controls, audit trails, and all the security measures we will implement in this chapter.

### 7. Accountability

You must be able to **demonstrate compliance**, not just claim it. This is why we build audit logs, consent records, and deletion certificates. If a regulator asks "prove you deleted this user's data," you need the receipts.

> **Key Term:** **Data Controller vs. Data Processor** — The **controller** decides why and how personal data is processed (that is you, the booking platform). The **processor** processes data on behalf of the controller (your cloud provider, payment gateway, email service). Both have GDPR obligations, but the controller bears primary responsibility. You must have a Data Processing Agreement (DPA) with every processor.

---

## The Six Lawful Bases for Processing

GDPR does not say you cannot process personal data. It says you need one of six legal justifications. For our booking system, we rely on four of them:

| Lawful Basis | Description | Booking System Example |
|---|---|---|
| **Consent** | The user explicitly agreed | Marketing emails, analytics cookies |
| **Contract** | Processing is necessary to fulfill a contract | Storing booking details to complete a reservation |
| **Legal Obligation** | Required by law | Retaining financial records for tax compliance (7 years) |
| **Legitimate Interest** | Processing is necessary for a legitimate business interest, balanced against user rights | Fraud detection, system security logging |
| **Vital Interest** | Necessary to protect someone's life | Emergency contact information |
| **Public Task** | Necessary for a task in the public interest | Not applicable to our system |

The lawful basis matters because it determines what you must do when a user objects. If you process data based on **consent**, the user can withdraw it at any time — and you must stop immediately. If you process based on **contract**, the user cannot object while the contract is active (you need their email to send the booking confirmation). If you process based on **legal obligation**, the user cannot override the law (you must keep tax records even if they want deletion).

```typescript
// privacy-service/src/types/lawful-basis.ts

export enum LawfulBasis {
  CONSENT = 'consent',
  CONTRACT = 'contract',
  LEGAL_OBLIGATION = 'legal_obligation',
  LEGITIMATE_INTEREST = 'legitimate_interest',
  VITAL_INTEREST = 'vital_interest',
  PUBLIC_TASK = 'public_task',
}

/**
 * Maps each data field to its lawful basis for processing.
 * This mapping is required for accountability (Principle 7)
 * and reviewed during DPIAs.
 */
export const DATA_FIELD_LEGAL_BASIS: Record<string, {
  basis: LawfulBasis;
  purpose: string;
  retentionDays: number | null; // null = until user requests deletion
}> = {
  'user.email': {
    basis: LawfulBasis.CONTRACT,
    purpose: 'Send booking confirmations and receipts',
    retentionDays: null,
  },
  'user.name': {
    basis: LawfulBasis.CONTRACT,
    purpose: 'identify guest for hotel check-in',
    retentionDays: null,
  },
  'user.phone': {
    basis: LawfulBasis.CONTRACT,
    purpose: 'Contact guest about booking changes',
    retentionDays: null,
  },
  'booking.payment_method': {
    basis: LawfulBasis.CONTRACT,
    purpose: 'Process payment for reservation',
    retentionDays: 2555, // ~7 years, financial regulation
  },
  'user.marketing_email': {
    basis: LawfulBasis.CONSENT,
    purpose: 'Send promotional offers and newsletters',
    retentionDays: null, // until consent withdrawn
  },
  'fraud_check.ip_address': {
    basis: LawfulBasis.LEGITIMATE_INTEREST,
    purpose: 'Detect and prevent fraudulent bookings',
    retentionDays: 730, // 2 years
  },
  'fraud_check.device_fingerprint': {
    basis: LawfulBasis.LEGITIMATE_INTEREST,
    purpose: 'Detect device-based fraud patterns',
    retentionDays: 730,
  },
  'booking.financial_record': {
    basis: LawfulBasis.LEGAL_OBLIGATION,
    purpose: 'Tax and accounting compliance',
    retentionDays: 2555,
  },
};
```

> **What If You Skip This?** If you cannot articulate the lawful basis for every piece of personal data you process, you are already non-compliant. A regulator's first question will be "under what basis do you process this data?" The answer "we just... store it" is a fine waiting to happen.

---

## Right to Access: Building a Data Subject Access Request (DSAR) Pipeline

Article 15 of GDPR gives every user the right to request a copy of **all personal data** you hold about them. This is called a Data Subject Access Request (DSAR). You have 30 days to respond — and you must provide the data in a structured, machine-readable format.

In a monolith with one database, this is a single SQL query. In our distributed booking system with data across PostgreSQL shards, Redis, Elasticsearch, Kafka events, and third-party integrations, this is an engineering project.

### The DSAR Data Collection Problem

Our user's data is scattered across:

| Data Store | What Lives There | Format |
|---|---|---|
| PostgreSQL (User Shard) | Profile, preferences, consent records | Relational rows |
| PostgreSQL (Booking Shard) | Booking history, payment references | Relational rows |
| Redis | Active sessions, cached preferences | Key-value pairs |
| Elasticsearch | Indexed booking data, search history | JSON documents |
| Kafka | Event history (booking.created, user.updated) | Avro/JSON events |
| Email Service (SendGrid) | Sent email log | Third-party API |
| Payment Gateway (Stripe) | Payment history, card tokens | Third-party API |

A DSAR response must include data from **all** of these sources.

### The DSAR Export Pipeline

```typescript
// privacy-service/src/dsar/dsar-export.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ElasticsearchService } from '../elasticsearch/elasticsearch.service';
import { StorageService } from '../storage/storage.service';
import { EncryptionService } from '../encryption/encryption.service';

interface DSARExportResult {
  requestId: string;
  downloadUrl: string;
  expiresAt: Date;
  dataSources: string[];
  totalRecords: number;
}

@Injectable()
export class DSARExportService {
  private readonly logger = new Logger(DSARExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly elasticsearch: ElasticsearchService,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Processes a DSAR request by collecting data from all stores,
   * packaging it as encrypted JSON, and providing a secure download link.
   */
  async processAccessRequest(userId: string): Promise<DSARExportResult> {
    // Step 1: Create audit record for this DSAR
    const request = await this.prisma.dsarRequest.create({
      data: {
        userId,
        type: 'ACCESS',
        status: 'PROCESSING',
        requestedAt: new Date(),
      },
    });

    this.logger.log(`Processing DSAR access request ${request.id} for user ${userId}`);

    try {
      // Step 2: Collect data from all sources in parallel
      const [
        profileData,
        bookingData,
        consentData,
        sessionData,
        searchHistory,
        auditTrail,
      ] = await Promise.allSettled([
        this.collectProfileData(userId),
        this.collectBookingData(userId),
        this.collectConsentHistory(userId),
        this.collectSessionData(userId),
        this.collectSearchHistory(userId),
        this.collectAuditTrail(userId),
      ]);

      // Step 3: Assemble the export
      const exportData = {
        exportedAt: new Date().toISOString(),
        dataSubject: userId,
        sections: {
          profile: this.extractSettled(profileData, 'profile'),
          bookings: this.extractSettled(bookingData, 'bookings'),
          consent: this.extractSettled(consentData, 'consent'),
          sessions: this.extractSettled(sessionData, 'sessions'),
          searchHistory: this.extractSettled(searchHistory, 'searchHistory'),
          auditTrail: this.extractSettled(auditTrail, 'auditTrail'),
        },
        metadata: {
          dataSources: [
            'postgresql_user_shard',
            'postgresql_booking_shard',
            'redis_sessions',
            'elasticsearch_search_history',
          ],
          legalBasis: 'GDPR Article 15 - Right of Access',
          generatedBy: 'privacy-service v2.4.0',
        },
      };

      // Step 4: Encrypt the export file
      const jsonPayload = JSON.stringify(exportData, null, 2);
      const encryptedPayload = await this.encryption.encryptForUser(
        userId,
        Buffer.from(jsonPayload, 'utf-8'),
      );

      // Step 5: Upload to secure, time-limited storage
      const downloadUrl = await this.storage.uploadWithExpiry(
        `dsar-exports/${request.id}.json.enc`,
        encryptedPayload,
        { expiresInHours: 72 }, // Link expires in 72 hours
      );

      // Step 6: Update the DSAR request record
      await this.prisma.dsarRequest.update({
        where: { id: request.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          downloadUrl,
          downloadExpiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      });

      const totalRecords = this.countRecords(exportData.sections);

      this.logger.log(
        `DSAR ${request.id} completed: ${totalRecords} records from ` +
        `${exportData.metadata.dataSources.length} sources`,
      );

      return {
        requestId: request.id,
        downloadUrl,
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        dataSources: exportData.metadata.dataSources,
        totalRecords,
      };
    } catch (error) {
      await this.prisma.dsarRequest.update({
        where: { id: request.id },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      });
      throw error;
    }
  }

  /**
   * Collects profile data from the user shard.
   */
  private async collectProfileData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        createdAt: true,
        updatedAt: true,
        preferences: true,
        // Exclude internal fields: passwordHash, internalFlags
      },
    });

    return {
      source: 'postgresql_user_shard',
      data: user,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Collects booking history including payment references (but not full
   * card numbers — we never store those).
   */
  private async collectBookingData(userId: string) {
    const bookings = await this.prisma.booking.findMany({
      where: { userId, deletedAt: null },
      include: {
        payments: {
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            createdAt: true,
            // maskedCardNumber is already masked (e.g., ****1234)
            maskedCardNumber: true,
          },
        },
        hotel: {
          select: { name: true, city: true, country: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      source: 'postgresql_booking_shard',
      recordCount: bookings.length,
      data: bookings,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Collects the full consent history — every grant and withdrawal.
   */
  private async collectConsentHistory(userId: string) {
    const consents = await this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      source: 'postgresql_user_shard',
      recordCount: consents.length,
      data: consents,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Collects active session data from Redis using SCAN (never KEYS).
   */
  private async collectSessionData(userId: string) {
    const sessions: Array<{ sessionId: string; createdAt: string; lastActive: string }> = [];
    let cursor = '0';

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', `session:${userId}:*`, 'COUNT', 100,
      );
      cursor = nextCursor;

      for (const key of keys) {
        const session = await this.redis.get(key);
        if (session) {
          const parsed = JSON.parse(session);
          sessions.push({
            sessionId: key.replace(`session:${userId}:`, ''),
            createdAt: parsed.createdAt,
            lastActive: parsed.lastActive,
            // Exclude: session token, CSRF token (security-sensitive)
          });
        }
      }
    } while (cursor !== '0');

    return {
      source: 'redis_sessions',
      recordCount: sessions.length,
      data: sessions,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Collects search history from Elasticsearch.
   */
  private async collectSearchHistory(userId: string) {
    const result = await this.elasticsearch.search({
      index: 'search_history',
      body: {
        query: { term: { user_id: userId } },
        sort: [{ timestamp: 'desc' }],
        size: 10000, // Reasonable upper bound
      },
    });

    return {
      source: 'elasticsearch_search_history',
      recordCount: result.hits.hits.length,
      data: result.hits.hits.map((hit: any) => hit._source),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Collects the audit trail of who accessed this user's data.
   */
  private async collectAuditTrail(userId: string) {
    const logs = await this.prisma.dataAccessLog.findMany({
      where: { subjectUserId: userId },
      orderBy: { accessedAt: 'desc' },
      take: 1000,
    });

    return {
      source: 'postgresql_audit',
      recordCount: logs.length,
      data: logs,
      collectedAt: new Date().toISOString(),
    };
  }

  private extractSettled(result: PromiseSettledResult<any>, section: string) {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    this.logger.error(`Failed to collect ${section}: ${result.reason}`);
    return { source: section, error: 'Collection failed', data: null };
  }

  private countRecords(sections: Record<string, any>): number {
    return Object.values(sections).reduce((total, section) => {
      return total + (section?.recordCount || (section?.data ? 1 : 0));
    }, 0);
  }
}
```

There is a lot happening in this service. Let us break down the key design decisions.

**Why `Promise.allSettled` instead of `Promise.all`?** If Elasticsearch is temporarily down, we still want to export the data we can collect from PostgreSQL and Redis. `Promise.all` would fail the entire export if any single source errors. `Promise.allSettled` collects what it can and reports which sources failed — the DSAR response can include a note saying "search history temporarily unavailable, will be provided in a follow-up."

**Why encrypt the export?** The DSAR export contains every piece of personal data we hold about the user. If the download link leaks, the user's entire data profile is exposed. We encrypt with a per-user key so only the authenticated user can decrypt it.

**Why a 72-hour expiry?** We do not want DSAR exports sitting on a storage bucket forever. The user should download it promptly. If they miss the window, they can submit a new request.

> **Key Term:** **DSAR (Data Subject Access Request)** — A formal request by an individual to obtain a copy of all personal data an organization holds about them. Under GDPR Article 15, you must respond within 30 calendar days. The response must be in a structured, commonly used, machine-readable format (JSON, CSV, or XML). You cannot charge a fee for the first request, but you can charge a "reasonable fee" for manifestly unfounded or excessive requests.

> **What If You Skip This?** If you cannot produce a complete DSAR export within 30 days, the user can complain to their national Data Protection Authority. The DPA can investigate, and if your systems genuinely cannot locate all user data across your services, that itself is a compliance failure — it means you do not know where personal data lives. This was one of the findings in the British Airways breach investigation that led to a 20 million pound fine.

---

## Right to Erasure: The "Right to Be Forgotten"

Article 17 of GDPR gives users the right to request deletion of their personal data. But — and this is where engineers and lawyers must sit in the same room — this right is **not absolute**. Certain data must be retained for legal reasons even after a user requests deletion.

This tension creates one of the hardest engineering problems in GDPR compliance: you must delete everything you can, provably retain what you must, and document the difference.

### What Must Be Deleted vs. What Must Be Retained

| Data Category | Delete on Request? | Reason |
|---|---|---|
| User profile (name, email, phone) | Yes | No legal retention requirement |
| Marketing preferences | Yes | Consent-based processing ends |
| Search and browsing history | Yes | Legitimate interest — user right overrides |
| Active session data (Redis) | Yes | No purpose after account deletion |
| Elasticsearch indexes | Yes | Derived data, no independent legal basis |
| Completed booking records | **Partially** | Financial records retained for tax law (7 years) |
| Payment transaction logs | **No** | Legal obligation — tax and anti-money-laundering |
| Fraud detection records | **No** (for 2 years) | Legitimate interest — active investigation window |
| Legal hold data | **No** | Litigation — deletion would be spoliation |
| Anonymized analytics | **No** | No longer personal data after anonymization |

> **Analogy:** Think of erasure like moving out of an apartment. You take all your personal belongings (profile, preferences, search history). But you cannot take the lease agreement — the landlord must keep it for legal records. And if there is a dispute about damage to the property, the photos from the move-in inspection stay until the dispute is resolved. The right to erasure removes *you* from the data — it does not erase the *legal obligations* created by your tenancy.

### The Erasure Service

```typescript
// privacy-service/src/erasure/erasure.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ElasticsearchService } from '../elasticsearch/elasticsearch.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

interface ErasureResult {
  requestId: string;
  userId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  deletedSources: string[];
  retainedSources: { source: string; reason: string; retainUntil: Date }[];
  anonymizedSources: string[];
  completedAt: Date;
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly elasticsearch: ElasticsearchService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Processes an erasure request following a strict order:
   * 1. Identify all data locations
   * 2. Check legal holds and retention requirements
   * 3. Anonymize data that must be retained
   * 4. Delete data that can be fully removed
   * 5. Generate a deletion certificate
   */
  async processErasureRequest(userId: string): Promise<ErasureResult> {
    const request = await this.prisma.erasureRequest.create({
      data: {
        userId,
        status: 'PROCESSING',
        requestedAt: new Date(),
      },
    });

    this.logger.log(`Processing erasure request ${request.id} for user ${userId}`);

    const deletedSources: string[] = [];
    const retainedSources: { source: string; reason: string; retainUntil: Date }[] = [];
    const anonymizedSources: string[] = [];

    try {
      // Step 1: Check for legal holds
      const legalHold = await this.prisma.legalHold.findFirst({
        where: { userId, releasedAt: null },
      });

      if (legalHold) {
        this.logger.warn(
          `User ${userId} is under legal hold ${legalHold.id}. ` +
          `Erasure limited to non-held data.`,
        );
      }

      // Step 2: Anonymize booking records (retain for tax compliance)
      const bookingsAnonymized = await this.anonymizeBookingRecords(userId);
      if (bookingsAnonymized > 0) {
        anonymizedSources.push('postgresql_booking_shard');
        retainedSources.push({
          source: 'booking_financial_records',
          reason: 'Legal obligation: tax compliance (7 years)',
          retainUntil: new Date(Date.now() + 7 * 365 * 24 * 60 * 60 * 1000),
        });
      }

      // Step 3: Delete user profile (unless under legal hold)
      if (!legalHold) {
        await this.prisma.user.delete({ where: { id: userId } });
        deletedSources.push('postgresql_user_profile');
      } else {
        // Under legal hold: anonymize but do not delete
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            email: `erased-${userId}@deleted.local`,
            name: '[ERASED]',
            phone: null,
            deletedAt: new Date(),
          },
        });
        anonymizedSources.push('postgresql_user_profile');
      }

      // Step 4: Delete consent records (the consent itself, not audit trail)
      await this.prisma.consentRecord.updateMany({
        where: { userId },
        data: { withdrawnAt: new Date(), withdrawnReason: 'account_erasure' },
      });
      deletedSources.push('consent_active_records');

      // Step 5: Purge Redis sessions
      await this.purgeRedisSessions(userId);
      deletedSources.push('redis_sessions');

      // Step 6: Delete Elasticsearch documents
      await this.elasticsearch.deleteByQuery({
        index: 'search_history',
        body: { query: { term: { user_id: userId } } },
      });
      deletedSources.push('elasticsearch_search_history');

      // Step 7: Emit event so downstream services can clean up
      this.events.emit('user.erased', {
        userId,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });

      // Step 8: Generate deletion certificate
      const result: ErasureResult = {
        requestId: request.id,
        userId,
        status: retainedSources.length > 0 ? 'PARTIAL' : 'COMPLETED',
        deletedSources,
        retainedSources,
        anonymizedSources,
        completedAt: new Date(),
      };

      await this.prisma.erasureRequest.update({
        where: { id: request.id },
        data: {
          status: result.status,
          completedAt: result.completedAt,
          deletionCertificate: JSON.stringify(result),
        },
      });

      this.logger.log(
        `Erasure ${request.id}: deleted ${deletedSources.length} sources, ` +
        `anonymized ${anonymizedSources.length}, retained ${retainedSources.length}`,
      );

      return result;
    } catch (error) {
      await this.prisma.erasureRequest.update({
        where: { id: request.id },
        data: { status: 'FAILED', errorMessage: error.message },
      });
      throw error;
    }
  }

  /**
   * Anonymizes booking records: replaces PII with anonymous placeholders
   * while keeping the financial data intact for tax compliance.
   */
  private async anonymizeBookingRecords(userId: string): Promise<number> {
    const result = await this.prisma.booking.updateMany({
      where: { userId },
      data: {
        guestName: '[ANONYMIZED]',
        guestEmail: `anon-${Date.now()}@anonymized.local`,
        guestPhone: null,
        specialRequests: null,
        // Keep: amount, currency, bookingDate, hotelId, paymentRef
        anonymizedAt: new Date(),
      },
    });

    return result.count;
  }

  private async purgeRedisSessions(userId: string): Promise<void> {
    let cursor = '0';
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor, 'MATCH', `session:${userId}:*`, 'COUNT', 100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redis.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== '0');

    this.logger.log(`Purged ${deletedCount} Redis sessions for user ${userId}`);
  }
}
```

**Why "PARTIAL" status?** Most erasure requests will result in PARTIAL completion because financial records must be retained. The deletion certificate documents exactly what was deleted, what was anonymized, and what was retained with the legal justification. If a regulator asks, you hand them the certificate.

**Why emit an event?** In a microservices architecture, other services may hold copies of user data — a notification service might cache the user's name, or an analytics service might have denormalized records. The `user.erased` event tells all services to clean up their copies. This is why a data inventory (knowing where every piece of PII lives) is prerequisite to GDPR compliance.

> **What If You Skip This?** If you implement a "delete" button that only soft-deletes the user profile but leaves their data intact in Elasticsearch, Redis, backup tapes, and third-party services, you have not complied with the erasure request. When the user submits a DSAR six months later to verify deletion and finds their data still in your search index, you face both a complaint and reputational damage.

---

## Data Anonymization vs. Pseudonymization

These two terms sound similar but have profoundly different legal consequences. Understanding the distinction is critical because **anonymized data is not personal data** (GDPR does not apply), while **pseudonymized data is still personal data** (GDPR still applies).

### Pseudonymization

Pseudonymization replaces direct identifiers with artificial ones (pseudonyms), but the data can still be linked back to the individual using a separate "key mapping." Think of it as a code name — if someone has the decoder ring, they know who "Agent X7" really is.

```typescript
// privacy-service/src/anonymization/pseudonymization.service.ts

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PseudonymizationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pseudonymizes a user ID by creating a deterministic but
   * non-reversible token. The mapping is stored securely
   * so we CAN re-identify if legally required.
   *
   * IMPORTANT: The key mapping table must be stored in a
   * separate database with restricted access.
   */
  async pseudonymize(userId: string): Promise<string> {
    // Check for existing pseudonym
    const existing = await this.prisma.pseudonymMapping.findUnique({
      where: { userId },
    });
    if (existing) return existing.pseudonym;

    // Generate a new pseudonym
    const salt = randomBytes(16).toString('hex');
    const pseudonym = createHash('sha256')
      .update(`${userId}:${salt}`)
      .digest('hex')
      .substring(0, 16);

    const prefixedPseudonym = `PSE-${pseudonym}`;

    // Store the mapping in a restricted-access table
    await this.prisma.pseudonymMapping.create({
      data: {
        userId,
        pseudonym: prefixedPseudonym,
        salt,
        createdAt: new Date(),
      },
    });

    return prefixedPseudonym;
  }

  /**
   * Re-identifies a pseudonym back to the original user ID.
   * This requires elevated permissions and produces an audit log entry.
   */
  async reidentify(pseudonym: string, accessorId: string, reason: string): Promise<string | null> {
    const mapping = await this.prisma.pseudonymMapping.findUnique({
      where: { pseudonym },
    });

    if (!mapping) return null;

    // Log the re-identification for audit purposes
    await this.prisma.dataAccessLog.create({
      data: {
        subjectUserId: mapping.userId,
        accessedBy: accessorId,
        action: 'RE_IDENTIFICATION',
        reason,
        accessedAt: new Date(),
      },
    });

    return mapping.userId;
  }
}
```

**Prisma schema for pseudonym mapping:**

```prisma
// prisma/schema.prisma (additions)

model PseudonymMapping {
  id        String   @id @default(cuid())
  userId    String   @unique @map("user_id")
  pseudonym String   @unique
  salt      String
  createdAt DateTime @default(now()) @map("created_at")

  @@map("pseudonym_mappings")
  @@index([pseudonym])
}
```

### Anonymization

Anonymization permanently removes the ability to identify the individual — **no decoder ring exists**. Once data is truly anonymized, it falls outside GDPR entirely. But genuine anonymization is harder than most engineers think.

```typescript
// privacy-service/src/anonymization/anonymization.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnonymizationService {
  private readonly logger = new Logger(AnonymizationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Anonymizes booking records for analytics use.
   * After this transformation, the data CANNOT be linked
   * back to any individual — it is no longer personal data.
   *
   * We apply five anonymization techniques:
   * 1. Generalization — reduce precision (exact date -> month)
   * 2. Suppression — remove the field entirely
   * 3. Noise addition — add random variance to numeric values
   * 4. Aggregation — combine individual records into groups
   * 5. K-anonymity — ensure each record is indistinguishable
   *    from at least k-1 other records
   */
  async anonymizeForAnalytics(bookingIds: string[]): Promise<number> {
    let anonymizedCount = 0;

    for (const bookingId of bookingIds) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
      });

      if (!booking) continue;

      await this.prisma.anonymizedBookingAnalytics.create({
        data: {
          // Generalization: exact date -> year-month only
          bookingMonth: new Date(
            booking.checkInDate.getFullYear(),
            booking.checkInDate.getMonth(),
            1,
          ),
          // Generalization: exact price -> price bucket
          priceBucket: this.toPriceBucket(booking.totalAmount),
          // Noise addition: stay duration +/- 1 day
          stayDurationDays: booking.nightCount + this.randomNoise(),
          // Generalization: specific hotel -> city-level only
          city: booking.hotelCity,
          country: booking.hotelCountry,
          // Suppression: remove guestName, email, phone entirely
          // Suppression: remove exact hotelId
          // Aggregation: room type category only
          roomCategory: booking.roomType,
          // Generalization: exact guest count -> range
          guestCountRange: this.toGuestRange(booking.guestCount),
        },
      });

      anonymizedCount++;
    }

    this.logger.log(`Anonymized ${anonymizedCount} bookings for analytics`);
    return anonymizedCount;
  }

  private toPriceBucket(amount: number): string {
    if (amount < 50) return '0-49';
    if (amount < 100) return '50-99';
    if (amount < 200) return '100-199';
    if (amount < 500) return '200-499';
    return '500+';
  }

  private toGuestRange(count: number): string {
    if (count <= 1) return '1';
    if (count <= 2) return '2';
    if (count <= 4) return '3-4';
    return '5+';
  }

  private randomNoise(): number {
    // Returns -1, 0, or 1 with equal probability
    return Math.floor(Math.random() * 3) - 1;
  }
}
```

> **Key Term:** **K-Anonymity** — A property of a dataset where each combination of identifying attributes appears in at least *k* records. If k=5, then for any row in the dataset, there are at least 4 other rows with the same generalized attributes (city, price bucket, month, etc.), making it impossible to single out one individual. Higher k means better anonymization but less analytical precision.

> **Analogy:** Pseudonymization is like wearing a name tag that says "Guest #42" instead of your real name at a hotel — the front desk still has the guest registry linking #42 to your passport. Anonymization is like being part of a crowd in a stadium photo — no one can pick you out, and no registry exists to identify you.

---

## Consent Management: Tracking Every "Yes" and "No"

For any data processing based on the **consent** lawful basis (marketing emails, analytics cookies, personalization), you must track consent with forensic precision. GDPR requires that consent be:

- **Freely given** — not bundled with other agreements
- **Specific** — for a particular purpose
- **Informed** — the user knows what they are consenting to
- **Unambiguous** — an affirmative action (no pre-ticked boxes)

And critically: you must be able to **prove** that consent was given. "We think the user opted in" is not proof. You need a timestamped, immutable audit trail.

### The Consent Record Schema

```prisma
// prisma/schema.prisma (additions)

model ConsentRecord {
  id             String         @id @default(cuid())
  userId         String         @map("user_id")
  consentType    ConsentType    @map("consent_type")
  status         ConsentStatus
  version        String         // Version of the privacy policy consented to
  ipAddress      String?        @map("ip_address")
  userAgent      String?        @map("user_agent")
  consentText    String         @map("consent_text") // Exact text shown to user
  grantedAt      DateTime?      @map("granted_at")
  withdrawnAt    DateTime?      @map("withdrawn_at")
  withdrawnReason String?       @map("withdrawn_reason")
  createdAt      DateTime       @default(now()) @map("created_at")

  user           User           @relation(fields: [userId], references: [id])

  @@map("consent_records")
  @@index([userId, consentType])
  @@index([consentType, status])
}

enum ConsentType {
  MARKETING_EMAIL
  MARKETING_SMS
  ANALYTICS_COOKIES
  PERSONALIZATION
  THIRD_PARTY_SHARING
  LOCATION_TRACKING
}

enum ConsentStatus {
  GRANTED
  WITHDRAWN
  EXPIRED
}
```

**Equivalent raw SQL (for those coming from a SQL background):**

```sql
CREATE TABLE consent_records (
    id           CHAR(36) PRIMARY KEY -- UUID generated by application,
    user_id      TEXT NOT NULL REFERENCES users(id),
    consent_type TEXT NOT NULL CHECK (consent_type IN (
        'MARKETING_EMAIL', 'MARKETING_SMS', 'ANALYTICS_COOKIES',
        'PERSONALIZATION', 'THIRD_PARTY_SHARING', 'LOCATION_TRACKING'
    )),
    status       TEXT NOT NULL CHECK (status IN ('GRANTED', 'WITHDRAWN', 'EXPIRED')),
    version      TEXT NOT NULL,
    ip_address   TEXT,
    user_agent   TEXT,
    consent_text TEXT NOT NULL,
    granted_at   DATETIME(6),
    withdrawn_at DATETIME(6),
    withdrawn_reason TEXT,
    created_at   DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_consent_user_type ON consent_records(user_id, consent_type);
CREATE INDEX idx_consent_type_status ON consent_records(consent_type, status);
```

**Prisma Client usage — granting consent:**

```typescript
const consent = await prisma.consentRecord.create({
  data: {
    userId: 'user_abc123',
    consentType: 'MARKETING_EMAIL',
    status: 'GRANTED',
    version: 'privacy-policy-v2.3',
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    consentText: 'I agree to receive promotional emails about travel deals and offers.',
    grantedAt: new Date(),
  },
});
```

**Prisma Client usage — withdrawing consent:**

```typescript
await prisma.consentRecord.update({
  where: { id: existingConsentId },
  data: {
    status: 'WITHDRAWN',
    withdrawnAt: new Date(),
    withdrawnReason: 'user_requested',
  },
});

// Also create a NEW record to show full trail
await prisma.consentRecord.create({
  data: {
    userId: 'user_abc123',
    consentType: 'MARKETING_EMAIL',
    status: 'WITHDRAWN',
    version: 'privacy-policy-v2.3',
    consentText: 'I agree to receive promotional emails about travel deals and offers.',
    withdrawnAt: new Date(),
    withdrawnReason: 'user_requested',
  },
});
```

### The Consent Manager Service

```typescript
// privacy-service/src/consent/consent-manager.service.ts

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConsentManagerService {
  private readonly logger = new Logger(ConsentManagerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grants consent for a specific purpose. Creates an immutable
   * audit trail entry — consent records are append-only.
   */
  async grantConsent(params: {
    userId: string;
    consentType: string;
    policyVersion: string;
    consentText: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    // Check if consent is already active
    const existing = await this.prisma.consentRecord.findFirst({
      where: {
        userId: params.userId,
        consentType: params.consentType as any,
        status: 'GRANTED',
        withdrawnAt: null,
      },
    });

    if (existing) {
      this.logger.warn(
        `User ${params.userId} already has active consent for ${params.consentType}`,
      );
      return; // Idempotent — do not create duplicates
    }

    await this.prisma.consentRecord.create({
      data: {
        userId: params.userId,
        consentType: params.consentType as any,
        status: 'GRANTED',
        version: params.policyVersion,
        consentText: params.consentText,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        grantedAt: new Date(),
      },
    });

    this.logger.log(
      `Consent GRANTED: user=${params.userId} type=${params.consentType} ` +
      `version=${params.policyVersion}`,
    );
  }

  /**
   * Withdraws consent. Does NOT delete the original grant record —
   * we need that for the audit trail. Instead, marks it as withdrawn
   * and creates a new withdrawal record.
   */
  async withdrawConsent(params: {
    userId: string;
    consentType: string;
    reason?: string;
  }): Promise<void> {
    const activeConsent = await this.prisma.consentRecord.findFirst({
      where: {
        userId: params.userId,
        consentType: params.consentType as any,
        status: 'GRANTED',
        withdrawnAt: null,
      },
    });

    if (!activeConsent) {
      throw new BadRequestException(
        `No active consent found for type ${params.consentType}`,
      );
    }

    // Mark the existing record as withdrawn
    await this.prisma.consentRecord.update({
      where: { id: activeConsent.id },
      data: {
        status: 'WITHDRAWN',
        withdrawnAt: new Date(),
        withdrawnReason: params.reason || 'user_requested',
      },
    });

    this.logger.log(
      `Consent WITHDRAWN: user=${params.userId} type=${params.consentType} ` +
      `reason=${params.reason || 'user_requested'}`,
    );

    // Trigger downstream effects (e.g., unsubscribe from marketing)
    await this.enforceWithdrawal(params.userId, params.consentType);
  }

  /**
   * Checks if a user has active consent for a specific purpose.
   * This is called before any consent-dependent processing.
   */
  async hasActiveConsent(userId: string, consentType: string): Promise<boolean> {
    const consent = await this.prisma.consentRecord.findFirst({
      where: {
        userId,
        consentType: consentType as any,
        status: 'GRANTED',
        withdrawnAt: null,
      },
    });

    return consent !== null;
  }

  /**
   * Returns the full consent history for a user — used in DSAR exports
   * and for demonstrating compliance to regulators.
   */
  async getConsentHistory(userId: string) {
    return this.prisma.consentRecord.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * When consent is withdrawn, enforce the consequences immediately.
   */
  private async enforceWithdrawal(userId: string, consentType: string): Promise<void> {
    switch (consentType) {
      case 'MARKETING_EMAIL':
        // Remove from email marketing lists
        await this.prisma.marketingSubscription.deleteMany({
          where: { userId },
        });
        break;
      case 'ANALYTICS_COOKIES':
        // Flag user for cookie cleanup on next page load
        await this.prisma.user.update({
          where: { id: userId },
          data: { analyticsOptOut: true },
        });
        break;
      case 'PERSONALIZATION':
        // Delete personalization profile
        await this.prisma.userPreferenceProfile.deleteMany({
          where: { userId },
        });
        break;
    }
  }
}
```

> **What If You Skip This?** In 2019, Google was fined 50 million euros by the French data protection authority (CNIL) partly because consent was "not sufficiently informed" — users did not see clear information about what they were consenting to before granting it. If you store consent without the exact text the user saw, the version of your policy, and the timestamp, you cannot prove the consent was valid.

---

## Data Retention Policies: Automated Cleanup Schedules

GDPR Principle 5 — Storage Limitation — requires that you do not keep personal data longer than necessary. In practice, this means you need an automated system that identifies expired data and either deletes or anonymizes it on a schedule. You cannot rely on engineers remembering to clean up old records. You need a machine that does it.

### The Retention Policy Configuration

```typescript
// privacy-service/src/retention/retention-config.ts

export interface RetentionPolicy {
  dataCategory: string;
  table: string;
  dateColumn: string;
  retentionDays: number;
  action: 'DELETE' | 'ANONYMIZE';
  legalBasis: string;
  description: string;
}

export const RETENTION_POLICIES: RetentionPolicy[] = [
  {
    dataCategory: 'search_history',
    table: 'search_history',
    dateColumn: 'searched_at',
    retentionDays: 90,
    action: 'DELETE',
    legalBasis: 'Legitimate interest — 90-day window for personalization',
    description: 'User search queries and results',
  },
  {
    dataCategory: 'session_logs',
    table: 'session_logs',
    dateColumn: 'created_at',
    retentionDays: 30,
    action: 'DELETE',
    legalBasis: 'Legitimate interest — security monitoring window',
    description: 'User login sessions and IP addresses',
  },
  {
    dataCategory: 'fraud_signals',
    table: 'fraud_check_results',
    dateColumn: 'checked_at',
    retentionDays: 730,
    action: 'ANONYMIZE',
    legalBasis: 'Legitimate interest — fraud investigation window (2 years)',
    description: 'Fraud detection signals and device fingerprints',
  },
  {
    dataCategory: 'completed_bookings',
    table: 'bookings',
    dateColumn: 'completed_at',
    retentionDays: 2555,
    action: 'ANONYMIZE',
    legalBasis: 'Legal obligation — financial record retention (7 years)',
    description: 'Booking records with guest PII',
  },
  {
    dataCategory: 'support_tickets',
    table: 'support_tickets',
    dateColumn: 'resolved_at',
    retentionDays: 365,
    action: 'ANONYMIZE',
    legalBasis: 'Legitimate interest — quality assurance and dispute resolution',
    description: 'Customer support conversations',
  },
  {
    dataCategory: 'notification_logs',
    table: 'notification_logs',
    dateColumn: 'sent_at',
    retentionDays: 180,
    action: 'DELETE',
    legalBasis: 'Contract — delivery confirmation window',
    description: 'Email, SMS, and push notification delivery records',
  },
];
```

### The Retention Scheduler

```typescript
// privacy-service/src/retention/retention-scheduler.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RETENTION_POLICIES, RetentionPolicy } from './retention-config';

@Injectable()
export class RetentionSchedulerService {
  private readonly logger = new Logger(RetentionSchedulerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs nightly at 2 AM UTC. Processes all retention policies,
   * deleting or anonymizing data that has exceeded its retention period.
   *
   * Why 2 AM? It is the lowest-traffic window for a global booking
   * platform. Retention jobs do table scans and bulk updates —
   * we do not want that competing with peak booking traffic.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async executeRetentionPolicies(): Promise<void> {
    this.logger.log('Starting nightly retention policy execution');

    const results: { policy: string; affected: number; action: string }[] = [];

    for (const policy of RETENTION_POLICIES) {
      try {
        const affected = await this.executePolicy(policy);
        results.push({
          policy: policy.dataCategory,
          affected,
          action: policy.action,
        });
      } catch (error) {
        this.logger.error(
          `Retention policy failed for ${policy.dataCategory}: ${error.message}`,
        );
        // Continue with other policies — do not let one failure block all
      }
    }

    // Log the summary
    const totalAffected = results.reduce((sum, r) => sum + r.affected, 0);
    this.logger.log(
      `Retention execution complete: ${totalAffected} records processed ` +
      `across ${results.length} policies`,
    );

    // Store execution record for audit
    await this.prisma.retentionExecutionLog.create({
      data: {
        executedAt: new Date(),
        policiesProcessed: results.length,
        totalRecordsAffected: totalAffected,
        details: JSON.stringify(results),
      },
    });
  }

  private async executePolicy(policy: RetentionPolicy): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - policy.retentionDays);

    this.logger.log(
      `Executing retention for ${policy.dataCategory}: ` +
      `${policy.action} records older than ${cutoffDate.toISOString()}`,
    );

    if (policy.action === 'DELETE') {
      return this.deleteExpiredRecords(policy, cutoffDate);
    } else {
      return this.anonymizeExpiredRecords(policy, cutoffDate);
    }
  }

  /**
   * Deletes records in batches to avoid locking the table for too long.
   * Each batch is a separate transaction — if the job is interrupted,
   * we have still made progress.
   */
  private async deleteExpiredRecords(
    policy: RetentionPolicy,
    cutoffDate: Date,
  ): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;
    let batchDeleted: number;

    do {
      // Using raw query for dynamic table/column names
      // Prisma does not support dynamic table references
      const result = await this.prisma.$executeRawUnsafe(`
        DELETE FROM "${policy.table}"
        WHERE "${policy.dateColumn}" < $1
        AND ctid IN (
          SELECT ctid FROM "${policy.table}"
          WHERE "${policy.dateColumn}" < $1
          LIMIT ${BATCH_SIZE}
        )
      `, cutoffDate);

      batchDeleted = result;
      totalDeleted += batchDeleted;

      if (batchDeleted > 0) {
        this.logger.debug(
          `${policy.dataCategory}: deleted batch of ${batchDeleted} (total: ${totalDeleted})`,
        );
        // Brief pause between batches to reduce database load
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } while (batchDeleted === BATCH_SIZE);

    return totalDeleted;
  }

  /**
   * Anonymizes records by replacing PII fields with placeholders.
   * The anonymization strategy depends on the data category.
   */
  private async anonymizeExpiredRecords(
    policy: RetentionPolicy,
    cutoffDate: Date,
  ): Promise<number> {
    if (policy.table === 'bookings') {
      const result = await this.prisma.booking.updateMany({
        where: {
          completedAt: { lt: cutoffDate },
          anonymizedAt: null,
        },
        data: {
          guestName: '[RETENTION_ANONYMIZED]',
          guestEmail: '[RETENTION_ANONYMIZED]',
          guestPhone: null,
          specialRequests: null,
          anonymizedAt: new Date(),
        },
      });
      return result.count;
    }

    if (policy.table === 'fraud_check_results') {
      const result = await this.prisma.fraudCheckResult.updateMany({
        where: {
          checkedAt: { lt: cutoffDate },
          anonymizedAt: null,
        },
        data: {
          ipAddress: '0.0.0.0',
          deviceFingerprint: '[RETENTION_ANONYMIZED]',
          userAgent: null,
          anonymizedAt: new Date(),
        },
      });
      return result.count;
    }

    return 0;
  }
}
```

**Prisma schema for retention audit logging:**

```prisma
// prisma/schema.prisma (additions)

model RetentionExecutionLog {
  id                    String   @id @default(cuid())
  executedAt            DateTime @map("executed_at")
  policiesProcessed     Int      @map("policies_processed")
  totalRecordsAffected  Int      @map("total_records_affected")
  details               String   // JSON string of per-policy results
  createdAt             DateTime @default(now()) @map("created_at")

  @@map("retention_execution_logs")
  @@index([executedAt])
}
```

**Equivalent raw SQL:**

```sql
CREATE TABLE retention_execution_logs (
    id                     CHAR(36) PRIMARY KEY -- UUID generated by application,
    executed_at            DATETIME(6) NOT NULL,
    policies_processed     INTEGER NOT NULL,
    total_records_affected INTEGER NOT NULL,
    details                TEXT NOT NULL,
    created_at             DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_retention_log_date ON retention_execution_logs(executed_at);
```

**Prisma Client query — checking recent retention runs:**

```typescript
const recentRuns = await prisma.retentionExecutionLog.findMany({
  where: {
    executedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
  },
  orderBy: { executedAt: 'desc' },
});
```

> **What If You Skip This?** Without automated retention, data accumulates indefinitely. Three years later, you have 200 million search history records you never needed to keep. When a breach happens — and statistically, breaches happen — the compromised dataset is far larger than it needed to be. The regulator will ask: "Why did you still have three-year-old browsing history?" The answer "we forgot to delete it" amplifies the fine.

---

## Cross-Border Data Transfers and Standard Contractual Clauses

GDPR restricts the transfer of personal data outside the European Economic Area (EEA) unless the destination country provides an "adequate" level of data protection. The European Commission maintains a list of countries with adequacy decisions (as of 2025: Andorra, Argentina, Canada for commercial organizations, Faroe Islands, Guernsey, Israel, Isle of Man, Japan, Jersey, New Zealand, Republic of Korea, Switzerland, the United Kingdom, Uruguay, and the United States under the EU-US Data Privacy Framework).

For our globally distributed booking system, this matters because:

- We have PostgreSQL read replicas in US-East, EU-West, and AP-Southeast
- Our CDN caches responses globally
- Third-party processors (Stripe, SendGrid, Datadog) may process data outside the EEA
- A hotel in Tokyo receiving a booking from a Berlin user is a cross-border transfer

### Transfer Mechanisms

| Mechanism | When to Use | Our System Uses |
|---|---|---|
| **Adequacy Decision** | Destination country is on the approved list | US transfers (under EU-US Data Privacy Framework) |
| **Standard Contractual Clauses (SCCs)** | No adequacy decision; need a contract-based safeguard | Third-party processors in non-adequate countries |
| **Binding Corporate Rules** | Intra-group transfers within a multinational company | If our company has subsidiaries outside EEA |
| **Explicit Consent** | User explicitly agrees to the transfer | Last resort — not practical at scale |
| **Derogations** | Contract performance requires the transfer | Hotel in non-EEA country needs guest name for check-in |

### Transfer Impact Assessment (TIA) in Code

```typescript
// privacy-service/src/transfers/transfer-guard.service.ts

import { Injectable, Logger, ForbiddenException } from '@nestjs/common';

interface TransferAssessment {
  allowed: boolean;
  mechanism: string;
  requiresEncryption: boolean;
  dataCategories: string[];
  destination: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

@Injectable()
export class TransferGuardService {
  private readonly logger = new Logger(TransferGuardService.name);

  // Countries with EU adequacy decisions (as of 2025)
  private readonly adequateCountries = new Set([
    'AD', 'AR', 'CA', 'FO', 'GG', 'IL', 'IM', 'JP',
    'JE', 'NZ', 'KR', 'CH', 'GB', 'UY', 'US',
    // All EEA countries are inherently adequate
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE',
    'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT',
    'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL',
    'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  ]);

  // Countries requiring additional safeguards
  private readonly highRiskCountries = new Set([
    'CN', 'RU', 'IN', 'BR', 'ZA',
  ]);

  /**
   * Evaluates whether a data transfer to a specific country is
   * permitted under GDPR and returns the appropriate mechanism.
   */
  assessTransfer(params: {
    destinationCountry: string;
    dataCategories: string[];
    purpose: string;
    recipientType: 'PROCESSOR' | 'CONTROLLER' | 'HOTEL_PARTNER';
  }): TransferAssessment {
    const { destinationCountry, dataCategories, recipientType } = params;

    // EEA-internal transfers: always allowed
    if (this.isEEA(destinationCountry)) {
      return {
        allowed: true,
        mechanism: 'EEA_INTERNAL',
        requiresEncryption: false,
        dataCategories,
        destination: destinationCountry,
        riskLevel: 'LOW',
      };
    }

    // Adequacy decision countries
    if (this.adequateCountries.has(destinationCountry)) {
      return {
        allowed: true,
        mechanism: 'ADEQUACY_DECISION',
        requiresEncryption: false,
        dataCategories,
        destination: destinationCountry,
        riskLevel: 'LOW',
      };
    }

    // Hotel partners in non-adequate countries: derogation for contract
    if (recipientType === 'HOTEL_PARTNER') {
      return {
        allowed: true,
        mechanism: 'CONTRACT_DEROGATION_ART49',
        requiresEncryption: true,
        dataCategories: this.minimizeForHotel(dataCategories),
        destination: destinationCountry,
        riskLevel: this.highRiskCountries.has(destinationCountry) ? 'HIGH' : 'MEDIUM',
      };
    }

    // Processors in non-adequate countries: require SCCs
    if (recipientType === 'PROCESSOR') {
      return {
        allowed: true,
        mechanism: 'STANDARD_CONTRACTUAL_CLAUSES',
        requiresEncryption: true,
        dataCategories,
        destination: destinationCountry,
        riskLevel: this.highRiskCountries.has(destinationCountry) ? 'HIGH' : 'MEDIUM',
      };
    }

    // Default: deny transfer
    this.logger.warn(
      `Transfer to ${destinationCountry} denied — no valid mechanism`,
    );
    return {
      allowed: false,
      mechanism: 'NONE',
      requiresEncryption: true,
      dataCategories,
      destination: destinationCountry,
      riskLevel: 'HIGH',
    };
  }

  /**
   * When sending data to a hotel partner, minimize to only what
   * they need: guest name, check-in date, room type.
   * They do NOT need email, phone, payment details, or preferences.
   */
  private minimizeForHotel(categories: string[]): string[] {
    const hotelMinimum = ['guest_name', 'check_in_date', 'check_out_date', 'room_type', 'guest_count'];
    return categories.filter(c => hotelMinimum.includes(c));
  }

  private isEEA(country: string): boolean {
    const eea = new Set([
      'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE',
      'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT',
      'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL',
      'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    ]);
    return eea.has(country);
  }
}
```

> **Key Term:** **Standard Contractual Clauses (SCCs)** — Pre-approved contract templates issued by the European Commission that provide adequate data protection safeguards for international transfers. When you sign an SCC with a third-party processor, you are both legally bound to protect the data to GDPR standards regardless of local law in the destination country. The 2021 updated SCCs require a Transfer Impact Assessment (TIA) for each transfer.

---

## Privacy by Design: Baking Privacy into Every Feature

Privacy by Design is not a GDPR requirement you bolt on after shipping — it is enshrined in Article 25 as a legal obligation. It means that every new feature, every database migration, every API endpoint must consider privacy implications **before code is written**.

### The Privacy Checklist for New Features

Before any pull request that touches personal data is merged, the team must answer these questions:

1. **What personal data does this feature collect?** List every field.
2. **What is the lawful basis?** Map each field to one of the six bases.
3. **Is this the minimum data needed?** Could the feature work with less?
4. **How long will the data be retained?** Define the retention policy.
5. **Who will access this data?** Define access controls.
6. **Will data cross borders?** Identify transfer mechanisms.
7. **How will this data be included in DSARs?** Update the export pipeline.
8. **How will this data be erased?** Update the erasure service.
9. **Is the data encrypted at rest?** PII must be encrypted.
10. **Has the DPO reviewed this?** Required for high-risk processing.

### Privacy Guard Middleware

```typescript
// privacy-service/src/middleware/privacy-guard.middleware.ts

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrivacyGuardMiddleware implements NestMiddleware {
  private readonly logger = new Logger(PrivacyGuardMiddleware.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Intercepts every API request that accesses personal data
   * and creates an audit log entry. This satisfies the
   * accountability principle — we can prove who accessed what.
   */
  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = this.extractTargetUserId(req);
    const accessorId = (req as any).user?.id || 'anonymous';

    if (userId && this.isPersonalDataEndpoint(req.path)) {
      await this.prisma.dataAccessLog.create({
        data: {
          subjectUserId: userId,
          accessedBy: accessorId,
          action: req.method,
          resource: req.path,
          ipAddress: req.ip,
          reason: req.headers['x-access-reason'] as string || 'api_request',
          accessedAt: new Date(),
        },
      });
    }

    next();
  }

  private extractTargetUserId(req: Request): string | null {
    return req.params.userId || req.query.userId as string || null;
  }

  private isPersonalDataEndpoint(path: string): boolean {
    const personalDataPaths = [
      '/api/users/',
      '/api/bookings/',
      '/api/profile/',
      '/api/consent/',
      '/api/payments/',
    ];
    return personalDataPaths.some(p => path.startsWith(p));
  }
}
```

**Prisma schema for the data access log:**

```prisma
// prisma/schema.prisma (additions)

model DataAccessLog {
  id            String   @id @default(cuid())
  subjectUserId String   @map("subject_user_id")
  accessedBy    String   @map("accessed_by")
  action        String   // HTTP method or operation type
  resource      String   // API path or data category
  ipAddress     String?  @map("ip_address")
  reason        String   // Why this access was performed
  accessedAt    DateTime @map("accessed_at")
  createdAt     DateTime @default(now()) @map("created_at")

  @@map("data_access_logs")
  @@index([subjectUserId, accessedAt])
  @@index([accessedBy, accessedAt])
}
```

**Equivalent raw SQL:**

```sql
CREATE TABLE data_access_logs (
    id               CHAR(36) PRIMARY KEY -- UUID generated by application,
    subject_user_id  TEXT NOT NULL,
    accessed_by      TEXT NOT NULL,
    action           TEXT NOT NULL,
    resource         TEXT NOT NULL,
    ip_address       TEXT,
    reason           TEXT NOT NULL,
    accessed_at      DATETIME(6) NOT NULL,
    created_at       DATETIME(6) NOT NULL DEFAULT NOW(6)
);

CREATE INDEX idx_access_log_subject ON data_access_logs(subject_user_id, accessed_at);
CREATE INDEX idx_access_log_accessor ON data_access_logs(accessed_by, accessed_at);
```

**Prisma Client query — auditing who accessed a user's data:**

```typescript
const accessHistory = await prisma.dataAccessLog.findMany({
  where: {
    subjectUserId: 'user_abc123',
    accessedAt: {
      gte: new Date('2025-01-01'),
      lte: new Date('2025-12-31'),
    },
  },
  orderBy: { accessedAt: 'desc' },
  take: 100,
});
```

---

## Full NestJS PrivacyModule

Now let us wire all the services together into a single, cohesive NestJS module:

```typescript
// privacy-service/src/privacy.module.ts

import { Module, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { ElasticsearchModule } from './elasticsearch/elasticsearch.module';
import { StorageModule } from './storage/storage.module';
import { EncryptionModule } from './encryption/encryption.module';

// DSAR
import { DSARExportService } from './dsar/dsar-export.service';
import { DSARController } from './dsar/dsar.controller';

// Erasure
import { ErasureService } from './erasure/erasure.service';
import { ErasureController } from './erasure/erasure.controller';

// Consent
import { ConsentManagerService } from './consent/consent-manager.service';
import { ConsentController } from './consent/consent.controller';

// Anonymization
import { AnonymizationService } from './anonymization/anonymization.service';
import { PseudonymizationService } from './anonymization/pseudonymization.service';

// Retention
import { RetentionSchedulerService } from './retention/retention-scheduler.service';

// Transfer Guard
import { TransferGuardService } from './transfers/transfer-guard.service';

// Encryption
import { ColumnEncryptionService } from './encryption/column-encryption.service';

// Middleware
import { PrivacyGuardMiddleware } from './middleware/privacy-guard.middleware';

@Module({
  imports: [
    PrismaModule,
    RedisModule,
    ElasticsearchModule,
    StorageModule,
    EncryptionModule,
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
  ],
  controllers: [
    DSARController,
    ErasureController,
    ConsentController,
  ],
  providers: [
    DSARExportService,
    ErasureService,
    ConsentManagerService,
    AnonymizationService,
    PseudonymizationService,
    RetentionSchedulerService,
    TransferGuardService,
    ColumnEncryptionService,
  ],
  exports: [
    DSARExportService,
    ErasureService,
    ConsentManagerService,
    AnonymizationService,
    TransferGuardService,
    ColumnEncryptionService,
  ],
})
export class PrivacyModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(PrivacyGuardMiddleware)
      .forRoutes(
        { path: 'api/users/*', method: RequestMethod.ALL },
        { path: 'api/bookings/*', method: RequestMethod.ALL },
        { path: 'api/profile/*', method: RequestMethod.ALL },
        { path: 'api/payments/*', method: RequestMethod.ALL },
      );
  }
}
```

---

## Prisma Schema: The Complete Privacy Data Model

Here is the consolidated Prisma schema for all privacy-related tables. This is the single source of truth that the DSAR exporter, erasure service, consent manager, and retention scheduler all operate against.

```prisma
// prisma/schema.prisma — Privacy Tables (consolidated)

model DsarRequest {
  id                String    @id @default(cuid())
  userId            String    @map("user_id")
  type              String    // 'ACCESS' | 'PORTABILITY'
  status            String    // 'PROCESSING' | 'COMPLETED' | 'FAILED'
  requestedAt       DateTime  @map("requested_at")
  completedAt       DateTime? @map("completed_at")
  downloadUrl       String?   @map("download_url")
  downloadExpiresAt DateTime? @map("download_expires_at")
  errorMessage      String?   @map("error_message")
  createdAt         DateTime  @default(now()) @map("created_at")

  @@map("dsar_requests")
  @@index([userId, requestedAt])
  @@index([status])
}

model ErasureRequest {
  id                  String    @id @default(cuid())
  userId              String    @map("user_id")
  status              String    // 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED'
  requestedAt         DateTime  @map("requested_at")
  completedAt         DateTime? @map("completed_at")
  deletionCertificate String?   @map("deletion_certificate") // JSON
  errorMessage        String?   @map("error_message")
  createdAt           DateTime  @default(now()) @map("created_at")

  @@map("erasure_requests")
  @@index([userId, requestedAt])
  @@index([status])
}

model LegalHold {
  id         String    @id @default(cuid())
  userId     String    @map("user_id")
  reason     String
  issuedBy   String    @map("issued_by")
  issuedAt   DateTime  @map("issued_at")
  releasedAt DateTime? @map("released_at")
  releasedBy String?   @map("released_by")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@map("legal_holds")
  @@index([userId, releasedAt])
}
```

**Equivalent raw SQL for the complete privacy tables:**

```sql
CREATE TABLE dsar_requests (
    id                 CHAR(36) PRIMARY KEY -- UUID generated by application,
    user_id            TEXT NOT NULL,
    type               TEXT NOT NULL,
    status             TEXT NOT NULL,
    requested_at       DATETIME(6) NOT NULL,
    completed_at       DATETIME(6),
    download_url       TEXT,
    download_expires_at DATETIME(6),
    error_message      TEXT,
    created_at         DATETIME(6) NOT NULL DEFAULT NOW(6)
);
CREATE INDEX idx_dsar_user ON dsar_requests(user_id, requested_at);
CREATE INDEX idx_dsar_status ON dsar_requests(status);

CREATE TABLE erasure_requests (
    id                   CHAR(36) PRIMARY KEY -- UUID generated by application,
    user_id              TEXT NOT NULL,
    status               TEXT NOT NULL,
    requested_at         DATETIME(6) NOT NULL,
    completed_at         DATETIME(6),
    deletion_certificate TEXT,
    error_message        TEXT,
    created_at           DATETIME(6) NOT NULL DEFAULT NOW(6)
);
CREATE INDEX idx_erasure_user ON erasure_requests(user_id, requested_at);
CREATE INDEX idx_erasure_status ON erasure_requests(status);

CREATE TABLE legal_holds (
    id          CHAR(36) PRIMARY KEY -- UUID generated by application,
    user_id     TEXT NOT NULL,
    reason      TEXT NOT NULL,
    issued_by   TEXT NOT NULL,
    issued_at   DATETIME(6) NOT NULL,
    released_at DATETIME(6),
    released_by TEXT,
    created_at  DATETIME(6) NOT NULL DEFAULT NOW(6)
);
CREATE INDEX idx_legal_hold_user ON legal_holds(user_id, released_at);
```

**Prisma Client usage — checking for legal holds before erasure:**

```typescript
const activeHold = await prisma.legalHold.findFirst({
  where: {
    userId: 'user_abc123',
    releasedAt: null,
  },
});

if (activeHold) {
  console.log(`Cannot fully erase: legal hold ${activeHold.id} active since ${activeHold.issuedAt}`);
}
```

---

## Encryption at Rest: Column-Level Encryption for PII

GDPR Principle 6 (Integrity and Confidentiality) requires appropriate technical measures to protect personal data. Database-level encryption (Transparent Data Encryption or TDE) protects against stolen disk drives, but it does not protect against a compromised application server or a SQL injection that dumps the database. **Column-level encryption** adds a layer: even if an attacker gets the raw data, PII fields are encrypted with keys they do not have.

```typescript
// privacy-service/src/encryption/column-encryption.service.ts

import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

@Injectable()
export class ColumnEncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly masterKey: Buffer;

  constructor() {
    // In production, this comes from AWS KMS, Azure Key Vault,
    // or HashiCorp Vault — NEVER from an environment variable.
    const keyMaterial = process.env.COLUMN_ENCRYPTION_KEY!;
    this.masterKey = scryptSync(keyMaterial, 'gdpr-column-encryption', 32);
  }

  /**
   * Encrypts a PII value for storage. Returns a string in the format:
   * "enc:v1:<iv>:<authTag>:<ciphertext>"
   *
   * The "enc:v1:" prefix lets us identify encrypted values and
   * support key rotation (v2, v3, etc.) in the future.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.masterKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }

  /**
   * Decrypts a PII value. Returns null if the value is not
   * in the expected encrypted format (backwards compatibility
   * with pre-encryption data).
   */
  decrypt(encryptedValue: string): string | null {
    if (!encryptedValue.startsWith('enc:v1:')) {
      // Not encrypted — return as-is (migration period)
      return encryptedValue;
    }

    const parts = encryptedValue.split(':');
    // Format: enc:v1:<iv>:<authTag>:<ciphertext>
    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const ciphertext = parts[4];

    const decipher = createDecipheriv(this.algorithm, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Checks if a value is encrypted.
   * Useful during migration when some rows are encrypted and some are not.
   */
  isEncrypted(value: string): boolean {
    return value.startsWith('enc:v1:');
  }
}
```

**Usage with Prisma middleware for transparent encryption/decryption:**

```typescript
// privacy-service/src/prisma/encryption.middleware.ts

import { Prisma } from '@prisma/client';
import { ColumnEncryptionService } from '../encryption/column-encryption.service';

const PII_FIELDS: Record<string, string[]> = {
  User: ['email', 'name', 'phone'],
  Booking: ['guestEmail', 'guestPhone'],
};

export function encryptionMiddleware(
  encryption: ColumnEncryptionService,
): Prisma.Middleware {
  return async (params, next) => {
    const model = params.model as string;
    const piiFields = PII_FIELDS[model];

    // Encrypt on write
    if (piiFields && params.args?.data) {
      for (const field of piiFields) {
        if (params.args.data[field] && typeof params.args.data[field] === 'string') {
          params.args.data[field] = encryption.encrypt(params.args.data[field]);
        }
      }
    }

    const result = await next(params);

    // Decrypt on read
    if (piiFields && result) {
      const decryptRecord = (record: any) => {
        for (const field of piiFields) {
          if (record[field] && typeof record[field] === 'string') {
            record[field] = encryption.decrypt(record[field]);
          }
        }
        return record;
      };

      if (Array.isArray(result)) {
        return result.map(decryptRecord);
      } else if (typeof result === 'object') {
        return decryptRecord(result);
      }
    }

    return result;
  };
}
```

> **Key Term:** **AES-256-GCM** — Advanced Encryption Standard with 256-bit keys in Galois/Counter Mode. GCM provides both confidentiality (encryption) and integrity (authentication tag). The authentication tag ensures that if even one bit of the ciphertext is tampered with, decryption will fail — you will know the data has been modified. This is why we use GCM instead of CBC mode.

> **What If You Skip This?** If your database is compromised through SQL injection and all PII is stored in plaintext, every user's email, phone number, and name is immediately exposed. With column-level encryption, the attacker gets ciphertext — useless without the encryption key, which is stored separately in a key management service. This is the difference between a "data breach affecting 10 million users" headline and a "security incident with no data exposure" disclosure.

---

## Production War Story: The Erasure Request That Exposed Everything

*A mid-sized European travel platform — let us call them WanderBook — received a routine DSAR erasure request from a user. Their system had a "Delete Account" button that developers had implemented as a single `DELETE FROM users WHERE id = ?` query. The ticket was closed. Compliance checked the box.*

*Three months later, the same user submitted a DSAR access request — this time to verify their data had been deleted. The DSAR export came back with 247 records.*

*The user's profile was gone from the users table. But their data was everywhere else:*

- *43 booking records with full name, email, and phone number*
- *18 email delivery logs in SendGrid with subject lines like "Your booking at Grand Hotel Paris"*
- *92 Elasticsearch documents indexing their search queries*
- *67 Kafka events containing their complete booking payloads*
- *15 analytics dashboard rows with their pseudonymized ID — but the pseudonym table still had the mapping*
- *12 customer support tickets with their full conversation history*

*The user filed a complaint with the Austrian DPA. The investigation revealed that WanderBook had never conducted a data inventory. They did not know where personal data lived beyond the primary users table. Their "data mapping" was a napkin sketch from a two-year-old meeting.*

*The fine was 2.3 million euros. But the real cost was the remediation: six months of engineering time to build a proper data inventory, implement DSAR and erasure pipelines across all systems, retrain the entire team, and hire a dedicated DPO. The total cost exceeded 4 million euros.*

*The lesson: GDPR compliance is not a feature you ship once. It is an architectural property of your entire system. If you cannot answer "where does user X's data live?" within minutes, you are not compliant — you just have not been caught yet.*

> **Mentor's Note:** This story is composited from real enforcement actions, including the Austrian DPA's approach to erasure verification. The pattern — deleting from one table while forgetting six other data stores — is the single most common GDPR engineering failure I have seen. The fix is always the same: a comprehensive data inventory that maps every PII field to every system where it exists. Build the inventory before you build the erasure pipeline, or the pipeline will miss half the data.

---

## Common Mistakes

1. **Treating GDPR as a one-time project.** Teams build the cookie banner, write a privacy policy, and declare victory. GDPR compliance is an ongoing process — every new feature, every new third-party integration, every new data store must be evaluated. Assign a DPO or privacy engineer who reviews every sprint.

2. **Confusing pseudonymization with anonymization.** If a mapping table exists that links pseudonyms back to real identities, the data is pseudonymized, not anonymized. GDPR still applies in full. Teams often think hashing an email address makes it anonymous — it does not, because the hash is deterministic and can be reversed with a lookup table.

3. **Implementing erasure as a single DELETE query.** In a microservices architecture, user data lives in dozens of stores. Deleting from the primary database and forgetting Redis, Elasticsearch, Kafka topics, third-party APIs, backup tapes, and log aggregators means the data still exists. Build an erasure checklist that covers every data store.

4. **Not recording the consent text.** Storing a boolean `marketing_opt_in = true` is not proof of consent. You must store the exact text the user saw, the version of your privacy policy, the timestamp, the IP address, and the user agent. When a regulator asks "what did the user consent to?" you need a screenshot-equivalent answer.

5. **Ignoring data in backups.** If you delete a user's data from the live database, but your nightly backup from two days ago still contains it, the data has not been fully erased. You need a backup exclusion strategy: either encrypt backups with per-user keys (so you can destroy the key) or maintain a "tombstone" list of erased users that is applied when restoring backups.

6. **Mixing lawful bases.** Processing the same data field under consent for one purpose and legitimate interest for another creates confusion. When the user withdraws consent, do you stop processing? If you also have a legitimate interest basis, maybe not — but you need clear documentation of which basis applies to which purpose, and you must tell the user.

7. **Hardcoding retention periods.** Burying `WHERE created_at < NOW() - INTERVAL '90 days'` in a cron job means the retention policy is invisible to legal, compliance, and product teams. Retention policies should be declared as configuration (as we did with `RETENTION_POLICIES`), version-controlled, and reviewed by legal annually.

8. **Forgetting cross-border transfers to third-party SaaS.** Your error monitoring tool (Sentry), your email service (SendGrid), your analytics platform (Mixpanel) — each of these is a data processor receiving personal data. If they process data outside the EEA, you need SCCs or an adequacy mechanism. Many teams discover this only during a DPIA or audit.

---

## Chapter Summary

| Topic | Key Concept | Implementation |
|---|---|---|
| **Seven GDPR Principles** | Lawfulness, purpose limitation, data minimization, accuracy, storage limitation, security, accountability | `DATA_FIELD_LEGAL_BASIS` mapping every field to a lawful basis and retention period |
| **Lawful Bases** | Six legal justifications for processing; consent, contract, and legal obligation are most common | `LawfulBasis` enum; lawful basis determines user rights (consent can be withdrawn; legal obligation cannot be overridden) |
| **Right to Access (DSAR)** | Users can request a copy of all their data; 30-day response deadline | `DSARExportService` collects from PostgreSQL, Redis, Elasticsearch; encrypted download with 72-hour expiry |
| **Right to Erasure** | Users can request deletion; some data must be retained for legal reasons | `ErasureService` with legal hold checks, anonymization for financial records, deletion certificates |
| **Anonymization vs. Pseudonymization** | Anonymized data is no longer personal data; pseudonymized data still is | `AnonymizationService` with k-anonymity, generalization, suppression; `PseudonymizationService` with audit-logged re-identification |
| **Consent Management** | Consent must be freely given, specific, informed, unambiguous, and provable | `ConsentManagerService` with append-only audit trail; stores exact consent text, policy version, IP, user agent |
| **Data Retention** | Do not keep data longer than needed; automate cleanup | `RetentionSchedulerService` runs nightly; batch deletes and anonymizes based on configurable policies |
| **Cross-Border Transfers** | Data leaving the EEA requires legal mechanisms | `TransferGuardService` checks adequacy decisions, applies SCCs, minimizes data for hotel partners |
| **Privacy by Design** | Privacy is an architectural requirement, not a feature | `PrivacyGuardMiddleware` creates audit trail for all personal data access; privacy checklist for new features |
| **NestJS PrivacyModule** | All privacy services wired into a cohesive module | Single module exports DSAR, Erasure, Consent, Anonymization, Transfer Guard, and Column Encryption services |
| **Prisma Privacy Schema** | Complete data model for GDPR compliance tracking | `DsarRequest`, `ErasureRequest`, `ConsentRecord`, `DataAccessLog`, `LegalHold`, `PseudonymMapping`, `RetentionExecutionLog` |
| **Column-Level Encryption** | PII encrypted in the database, transparent to application code | `ColumnEncryptionService` with AES-256-GCM; Prisma middleware for automatic encrypt/decrypt |
| **Production War Story** | Single-table DELETE is not erasure in a distributed system | Data inventory is prerequisite; erasure must cover every data store; verify with follow-up DSAR |

---

**Next Chapter Preview:** In Chapter 30, we move from protecting user data to protecting the system itself. We will build a comprehensive observability and monitoring stack — structured logging with correlation IDs, distributed tracing across microservices, metrics dashboards, alerting pipelines, and the on-call practices that keep a 100,000-bookings-per-minute platform running at 99.99% availability.
