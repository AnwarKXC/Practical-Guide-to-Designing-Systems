# Chapter 34: Disaster Recovery — Preparing for the Worst

## The Day Everything Went Dark

At 2:47 AM on a Tuesday, a senior engineer at a major travel platform received an alert that would define the next 72 hours of her life. An entire AWS region -- US-East-1, carrying 40% of global traffic -- had lost connectivity. Not a single pod failing. Not a slow query. The entire region, dark.

Within 90 seconds, 66,000 bookings per minute stopped processing. Customer-facing APIs returned connection timeouts. The payment service froze mid-transaction for 11,000 in-flight bookings. The mobile app showed a blank screen for millions of users across North America.

This is not hypothetical. This is what happens when disaster recovery is an afterthought.

In 2017, an Amazon S3 outage in US-East-1 took down a significant portion of the internet for several hours. In 2021, a Facebook configuration change made their DNS unreachable globally for six hours, costing an estimated $100 million in revenue. In 2023, a Microsoft Azure outage knocked out services across the southeastern United States. In 2024, a CrowdStrike update bricked 8.5 million Windows machines worldwide, grounding flights and shutting down hospitals.

Data centers lose power. Fiber optic cables get cut by construction crews. Natural disasters flood server rooms. Software updates corrupt configurations. Ransomware encrypts databases.

If your entire booking platform runs in one data center and that data center goes dark, your system is down. Completely. For everyone. Until the data center comes back. You cannot deploy a fix. You cannot restart pods. You cannot do anything except wait -- and explain to your customers why their confirmed bookings have vanished.

Disaster recovery is the plan for that scenario. It is not about preventing the disaster -- you cannot prevent an earthquake. It is about ensuring your system **survives** the disaster with minimal data loss and minimal downtime.

> **Analogy:** Think of disaster recovery like fire safety in a skyscraper. You cannot guarantee a fire will never happen. But you install fire exits on every floor, sprinkler systems in every room, fire alarms on every wall, and backup generators in the basement. You run fire drills quarterly so every employee knows exactly which stairwell to use. You store backup copies of critical documents in a vault across town. The goal is not "fires never happen" but "when a fire happens, everyone gets out safely and operations resume from the backup site within hours."

---

## Two Numbers That Define Every DR Plan

Every disaster recovery plan orbits around two numbers. These two metrics determine how much you invest in backups, replication, and failover infrastructure. They drive every architectural decision in this chapter.

### RPO: Recovery Point Objective

> **Key Term:** **RPO (Recovery Point Objective)** -- How much data can you afford to lose, measured in time. An RPO of zero means you lose nothing, ever. An RPO of 1 hour means that in the worst case, you lose the last hour of transactions. RPO determines your backup and replication strategy.

Think of RPO as the answer to this question: "When we recover from a disaster, how far back in time will we rewind?"

If you take database backups every 6 hours, your RPO is 6 hours. If the disaster strikes 5 hours and 59 minutes after the last backup, you lose nearly 6 hours of data. Every booking confirmed in that window, every payment processed, every cancellation recorded -- gone.

For a system processing 100,000 bookings per minute, losing 6 hours means losing up to **36 million bookings**. Customers who were told "your booking is confirmed" suddenly have no booking. Hotels that turned away other guests because a room was "reserved" now have phantom reservations. The financial reconciliation alone could take weeks.

### RTO: Recovery Time Objective

> **Key Term:** **RTO (Recovery Time Objective)** -- How long can your system be down before recovery, measured in time. An RTO of 5 minutes means your system must be serving requests again within 5 minutes of the disaster. An RTO of 24 hours means you have a day to get back online. RTO determines your failover strategy.

Think of RTO as the answer to: "How long will our users stare at an error page?"

At 100,000 bookings per minute, every minute of downtime represents 100,000 missed bookings. A 5-minute outage means 500,000 missed bookings. A 1-hour outage means 6 million. An 8-hour outage during peak season could cost tens of millions in revenue and permanently damage customer trust.

### Determining Your RPO and RTO

How do you decide what RPO and RTO your system needs? This is not a purely technical question -- it is a business question with technical implications. Here is the framework:

**Step 1: Quantify the cost of data loss.**

```
Data Loss Cost Analysis:
  Per booking revenue:        $150 average
  Bookings per minute:        100,000
  Revenue per minute:         $15,000,000

  RPO = 1 hour:
    Potential lost bookings:   6,000,000
    Revenue at risk:           $900,000,000
    Customer trust impact:     Catastrophic
    Regulatory exposure:       PCI-DSS violations, GDPR complaints

  RPO = 1 minute:
    Potential lost bookings:   100,000
    Revenue at risk:           $15,000,000
    Customer trust impact:     Significant
    Regulatory exposure:       Manageable

  RPO = 1 second:
    Potential lost bookings:   ~1,667
    Revenue at risk:           $250,000
    Customer trust impact:     Minimal (most users unaware)
    Regulatory exposure:       Low
```

**Step 2: Quantify the cost of downtime.**

```
Downtime Cost Analysis:
  Direct revenue loss:         $15,000,000/minute
  Customer support surge:      $500,000/hour (staffing + refunds)
  Brand reputation damage:     Hard to quantify, but real
  SLA penalty payments:        Contract-dependent
  Competitive displacement:    Users switch to competitors permanently

  RTO = 24 hours:
    Total direct cost:         $21.6 billion (unacceptable)

  RTO = 1 hour:
    Total direct cost:         $900 million (devastating)

  RTO = 5 minutes:
    Total direct cost:         $75 million (painful but survivable)

  RTO = 1 minute:
    Total direct cost:         $15 million (the target)
```

**Step 3: Compare against DR infrastructure cost.**

| RPO Target | Replication Strategy | Annual Cost |
|---|---|---|
| 0 seconds | Synchronous multi-region replication | $2.4M+ |
| < 1 second | Async replication with sub-second lag | $1.2M |
| < 1 hour | Hourly snapshots + WAL shipping | $200K |
| < 24 hours | Daily backups to S3 | $50K |

| RTO Target | Failover Strategy | Annual Cost |
|---|---|---|
| < 1 minute | Multi-site active-active | $3.6M+ |
| < 5 minutes | Warm standby with auto-failover | $1.8M |
| < 1 hour | Pilot light with manual scaling | $600K |
| < 24 hours | Backup/restore to new infra | $120K |

**Step 4: Choose your targets.**

For our booking platform, the math is clear. Losing even 5 seconds of booking data means confirmed reservations vanish. Five minutes of downtime at 100,000 bookings per minute means 500,000 missed bookings. The cost of DR infrastructure is a rounding error compared to the cost of a prolonged outage.

Our targets:

```typescript
export const drTargets = {
  rpo: {
    target: '< 1 second',
    justification: 'At 100K bookings/min, 1 second = ~1,667 bookings at risk',
    acceptable_worst_case: '< 5 seconds during cross-region replication lag spikes'
  },
  rto: {
    target: '< 5 minutes',
    justification: 'Active-active architecture enables traffic shift, not cold start',
    acceptable_worst_case: '< 15 minutes for cascading failures requiring manual intervention'
  }
};
```

> **What If You Skip This?** Without explicitly defining RPO and RTO, your disaster recovery plan has no measurable targets. You cannot test what you have not defined. You cannot invest appropriately when you do not know what "appropriate" means. Teams without RPO/RTO targets discover their actual recovery capabilities only during real disasters -- and the numbers are always worse than they assumed.

---

## The Spectrum of DR Strategies

Not every system needs active-active multi-region architecture. DR strategies exist on a spectrum from cheap-and-slow to expensive-and-fast. Understanding the full spectrum helps you choose the right strategy for each component of your system.

### Strategy 1: Backup and Restore

```
┌─────────────────────────────────────────────────────────┐
│              BACKUP AND RESTORE                         │
│                                                         │
│  ┌──────────────┐         ┌──────────────────────┐      │
│  │              │ Backup  │                      │      │
│  │  Production  │────────►│   S3 / Cold Storage  │      │
│  │   Region     │  Daily  │   (another region)   │      │
│  │              │         │                      │      │
│  └──────────────┘         └──────────────────────┘      │
│                                                         │
│  On disaster:                                           │
│  1. Provision new infrastructure (30-60 min)             │
│  2. Restore from backup (1-4 hours)                     │
│  3. Validate and go live (30-60 min)                    │
│                                                         │
│  RPO: Hours to days    RTO: Hours to days               │
│  Cost: $                                                │
└─────────────────────────────────────────────────────────┘
```

**How it works.** You take periodic backups of your databases, configuration, and application state. You store them in a different region or provider. When disaster strikes, you provision new infrastructure and restore from the latest backup.

**When to use it.** Internal tools, batch processing systems, non-customer-facing services where hours of downtime are acceptable.

**Why not for us.** Restoring a multi-terabyte database from cold storage takes hours. At 100,000 bookings per minute, hours of downtime are catastrophic.

### Strategy 2: Pilot Light

```
┌─────────────────────────────────────────────────────────┐
│                   PILOT LIGHT                           │
│                                                         │
│  ┌──────────────┐         ┌──────────────────────┐      │
│  │              │  Async  │  Minimal Infra:      │      │
│  │  Production  │────────►│  - DB replica (on)   │      │
│  │   Region     │  Repl.  │  - App servers (off) │      │
│  │  (Active)    │         │  - LB (configured)   │      │
│  └──────────────┘         └──────────────────────┘      │
│                                                         │
│  On disaster:                                           │
│  1. Scale up app servers (5-15 min)                     │
│  2. Switch DNS to DR region (2-5 min)                   │
│  3. Validate and absorb traffic (5-10 min)              │
│                                                         │
│  RPO: Seconds to minutes   RTO: 15-30 minutes           │
│  Cost: $$                                               │
└─────────────────────────────────────────────────────────┘
```

**How it works.** A minimal version of your infrastructure runs in a secondary region. The database replica stays synchronized, but application servers are stopped. Like a pilot light on a gas furnace -- a tiny flame that can ignite the full burner quickly.

**When to use it.** Systems where 15-30 minutes of downtime is acceptable and you want a balance between cost and recovery speed.

**Why not for us.** Spinning up and warming application servers takes time. Cold caches mean performance degradation. Fifteen minutes of downtime at our scale is 1.5 million missed bookings.

### Strategy 3: Warm Standby

```
┌─────────────────────────────────────────────────────────┐
│                 WARM STANDBY                            │
│                                                         │
│  ┌──────────────┐         ┌──────────────────────┐      │
│  │              │  Async  │  Scaled-down Infra:  │      │
│  │  Production  │────────►│  - DB replica (on)   │      │
│  │   Region     │  Repl.  │  - App servers (on,  │      │
│  │  (Active)    │         │    reduced capacity) │      │
│  └──────────────┘         │  - Cache (warm)      │      │
│                           └──────────────────────┘      │
│                                                         │
│  On disaster:                                           │
│  1. Scale up app servers (2-5 min via auto-scale)       │
│  2. Switch DNS (1-2 min)                                │
│  3. Full capacity reached (3-5 min)                     │
│                                                         │
│  RPO: Seconds    RTO: 5-10 minutes                      │
│  Cost: $$$                                              │
└─────────────────────────────────────────────────────────┘
```

**How it works.** A scaled-down but fully functional copy of your system runs in a secondary region. It handles a small percentage of traffic (or synthetic traffic to keep caches warm). On failover, you scale it up and shift DNS.

**When to use it.** Systems that need faster recovery than pilot light but cannot justify the cost of full active-active.

### Strategy 4: Multi-Site Active-Active (Our Choice)

```
┌─────────────────────────────────────────────────────────┐
│           MULTI-SITE ACTIVE-ACTIVE                      │
│                                                         │
│  ┌──────────────┐   Bi-directional   ┌──────────────┐  │
│  │              │◄──── Async Repl ───►│              │  │
│  │  US-East-1   │                     │  EU-West-1   │  │
│  │  (Active)    │                     │  (Active)    │  │
│  │  35% traffic │                     │  35% traffic │  │
│  └──────┬───────┘                     └──────┬───────┘  │
│         │          ┌──────────────┐          │          │
│         │          │              │          │          │
│         └─────────►│ AP-South-1   │◄─────────┘          │
│       Bi-dir Repl  │  (Active)    │  Bi-dir Repl        │
│                    │  30% traffic │                      │
│                    └──────────────┘                      │
│                                                         │
│  On disaster (one region fails):                        │
│  1. DNS auto-removes failed region (30s)                │
│  2. Remaining two regions absorb traffic (2-3 min)      │
│  3. Zero cold-start -- already serving live traffic     │
│                                                         │
│  RPO: < 1 second   RTO: < 5 minutes                    │
│  Cost: $$$$                                             │
└─────────────────────────────────────────────────────────┘
```

**How it works.** Every region is fully active, handling real production traffic at all times. Data replicates bidirectionally between regions. When one region fails, DNS health checks detect the failure and route all traffic to the surviving regions. There is no cold start because every region is already warm, already scaled, already serving users.

**Why this is our choice.** For a system handling 100,000 bookings per minute across global users, active-active is the only strategy that meets our RPO and RTO targets. The surviving regions are already running at capacity and only need to scale up incrementally -- not boot from cold.

> **Analogy:** Consider the difference between a hospital with one operating room and a hospital with three. If the single operating room floods, all surgeries stop until it is repaired. But if one of three operating rooms floods, the other two absorb the surgical schedule. They are already staffed, equipped, and operational. The "recovery" is not building a new operating room -- it is rescheduling patients across the surviving rooms.

Here is a comparison summary:

| Strategy | RPO | RTO | Cost (relative) | Best For |
|---|---|---|---|---|
| Backup/Restore | Hours-Days | Hours-Days | $ | Internal tools, dev environments |
| Pilot Light | Seconds-Minutes | 15-30 min | $$ | Medium-criticality services |
| Warm Standby | Seconds | 5-10 min | $$$ | High-criticality with budget constraints |
| Active-Active | < 1 second | < 5 min | $$$$ | Mission-critical, global-scale systems |

> **Checkpoint:** Your CTO asks you to justify the cost of active-active DR over warm standby. How would you frame the argument in terms of RPO, RTO, and business impact at 100,000 bookings per minute? What is the dollar cost of the 10-minute RTO difference between the two strategies?

---

## Backup Strategies for MySQL Shards

Even with active-active replication, backups remain essential. Replication protects you from hardware failure. Backups protect you from **logical corruption** -- a bad migration that deletes half your booking records, a ransomware attack that encrypts your data, an engineer who accidentally runs `DROP TABLE` on production. Replication faithfully copies all of these disasters to every replica.

You need backups that let you rewind to a point before the corruption happened. For a sharded MySQL deployment, three strategies exist: full, incremental, and differential. Each has tradeoffs in storage cost, backup speed, and restore speed.

### Full Backups

A full backup captures the complete state of every database shard at a single point in time.

```
Full Backup Timeline:
  Sunday    Monday    Tuesday   Wednesday  Thursday  Friday    Saturday
  [FULL]    ...       ...       ...        ...       ...       [FULL]
  ~500GB    ...       ...       ...        ...       ...       ~520GB

  Restore from any full backup:
  1. Pick the backup → Restore it → Done
  Time: 2-4 hours depending on size
  Data loss: Everything since that backup
```

```typescript
// backup-service/full-backup.ts
import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'fs';

const execAsync = promisify(exec);

interface ShardConfig {
  shardId: string;
  host: string;
  port: number;
  databases: string[];
}

@Injectable()
export class FullBackupService {
  private readonly logger = new Logger(FullBackupService.name);

  constructor(
    private readonly s3Client: S3Client,
    private readonly shardRegistry: ShardRegistryService,
    private readonly metrics: MetricsService,
    private readonly alerting: AlertingService,
  ) {}

  /**
   * Executes a full backup for all MySQL shards.
   *
   * Why mysqldump with --single-transaction?
   * It starts a transaction before dumping, giving you a consistent
   * snapshot without locking tables. Critical for a live booking
   * system -- you cannot lock the bookings table for 30 minutes
   * while a backup runs.
   */
  async executeFullBackup(): Promise<BackupResult[]> {
    const shards = await this.shardRegistry.getAllShards();
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results: BackupResult[] = [];

    for (const shard of shards) {
      const timer = this.metrics.startTimer('backup_duration_seconds', {
        type: 'full',
        shard: shard.shardId,
      });

      try {
        this.logger.log(
          `Starting full backup for shard ${shard.shardId}`,
        );

        const localPath = `/tmp/backup-${shard.shardId}-${backupTimestamp}.sql.gz`;

        // --single-transaction: consistent snapshot without table locks
        // --routines: include stored procedures
        // --triggers: include triggers
        // --set-gtid-purged=ON: preserve GTID info for replication setup
        const dumpCommand = [
          'mysqldump',
          `--host=${shard.host}`,
          `--port=${shard.port}`,
          '--user=$MYSQL_BACKUP_USER',
          '--password=$MYSQL_BACKUP_PASSWORD',
          '--single-transaction',
          '--routines',
          '--triggers',
          '--set-gtid-purged=ON',
          '--all-databases',
          `| gzip > ${localPath}`,
        ].join(' ');

        await execAsync(dumpCommand, { timeout: 3600000 }); // 1 hour timeout

        // Upload to S3 with server-side encryption
        const s3Key = `backups/full/${backupTimestamp}/${shard.shardId}.sql.gz`;
        await this.uploadToS3(localPath, s3Key);

        // Calculate and verify checksum
        const { stdout: checksum } = await execAsync(
          `sha256sum ${localPath} | awk '{print $1}'`,
        );

        // Clean up local file
        await execAsync(`rm -f ${localPath}`);

        const result: BackupResult = {
          shardId: shard.shardId,
          type: 'full',
          timestamp: new Date(),
          s3Key,
          checksum: checksum.trim(),
          sizeBytes: await this.getS3ObjectSize(s3Key),
          success: true,
        };

        results.push(result);
        timer.end({ status: 'success' });

        this.logger.log(
          `Full backup completed for shard ${shard.shardId}: ${s3Key}`,
        );

      } catch (error) {
        timer.end({ status: 'failure' });
        this.logger.error(
          `Full backup FAILED for shard ${shard.shardId}: ${error.message}`,
        );
        this.alerting.critical(
          `Backup failure on shard ${shard.shardId}`,
          { error: error.message },
        );
        results.push({
          shardId: shard.shardId,
          type: 'full',
          timestamp: new Date(),
          success: false,
          errorMessage: error.message,
        });
      }
    }

    return results;
  }
}
```

> **Why This Matters:** A full backup is your last line of defense. If every replica is corrupted, if every incremental chain is broken, the full backup is the foundation you restore from. Guard it with encryption, verify it with checksums, and store it in a separate cloud provider if your paranoia budget allows.

### Incremental Backups

An incremental backup captures only the data that changed since the **last backup of any type** (full or incremental). This makes each individual backup small and fast, but restoring requires replaying the entire chain.

```
Incremental Backup Timeline:
  Sunday    Monday    Tuesday   Wednesday  Thursday  Friday    Saturday
  [FULL]    [INC]     [INC]     [INC]      [INC]     [INC]     [FULL]
  500GB     2GB       3GB       1.5GB      2.5GB     2GB       520GB

  Restore to Wednesday state:
  1. Restore Sunday's FULL backup
  2. Apply Monday's incremental
  3. Apply Tuesday's incremental
  4. Apply Wednesday's incremental
  Time: 3-5 hours (longer restore, but less storage)

  Danger: If Tuesday's incremental is corrupted,
          Wednesday's cannot be applied. The chain is broken.
```

```typescript
// backup-service/incremental-backup.ts

/**
 * Incremental backups using MySQL binary logs.
 *
 * How binary logs work: MySQL records every write operation (INSERT,
 * UPDATE, DELETE) in binary log files. These logs ARE the incremental
 * backup -- they contain exactly what changed since the last backup.
 *
 * By capturing binary logs between full backups, we can replay
 * the exact sequence of changes to restore to any point in time.
 * This is called Point-in-Time Recovery (PITR).
 */
@Injectable()
export class IncrementalBackupService {
  async captureIncrementalBackup(
    shard: ShardConfig,
  ): Promise<BackupResult> {
    // Flush logs to start a new binary log file
    // This cleanly separates "already backed up" from "new changes"
    await this.mysqlQuery(shard, 'FLUSH BINARY LOGS');

    // Get list of binary log files since last backup
    const lastBackup = await this.getLastBackupPosition(shard.shardId);
    const currentPosition = await this.getCurrentBinlogPosition(shard);

    const binlogFiles = await this.getBinlogFilesBetween(
      shard,
      lastBackup.binlogFile,
      lastBackup.binlogPosition,
      currentPosition.binlogFile,
      currentPosition.binlogPosition,
    );

    // Copy binary logs to backup storage
    for (const binlog of binlogFiles) {
      const s3Key = `backups/incremental/${shard.shardId}/${binlog.fileName}`;
      await this.uploadBinlogToS3(shard, binlog, s3Key);
    }

    // Record the new backup position
    await this.recordBackupPosition(shard.shardId, currentPosition);

    return {
      shardId: shard.shardId,
      type: 'incremental',
      timestamp: new Date(),
      binlogStart: lastBackup,
      binlogEnd: currentPosition,
      filesCount: binlogFiles.length,
      success: true,
    };
  }

  /**
   * Point-in-Time Recovery: restore to an exact moment.
   *
   * This is how you recover from "an engineer ran a bad DELETE
   * at 3:42 PM." You restore the full backup, then replay
   * binary logs up to 3:41 PM -- one minute before the mistake.
   */
  async restoreToPointInTime(
    shard: ShardConfig,
    targetTime: Date,
  ): Promise<void> {
    // 1. Find the most recent full backup before targetTime
    const fullBackup = await this.findFullBackupBefore(
      shard.shardId,
      targetTime,
    );

    // 2. Restore the full backup
    await this.restoreFullBackup(shard, fullBackup);

    // 3. Find all incremental backups between full backup and target
    const incrementals = await this.findIncrementalsBetween(
      shard.shardId,
      fullBackup.timestamp,
      targetTime,
    );

    // 4. Replay binary logs up to the exact target time
    for (const inc of incrementals) {
      await this.replayBinlog(shard, inc, {
        stopDateTime: targetTime,
      });
    }
  }
}
```

### Differential Backups

A differential backup captures all data that changed since the **last full backup**. Unlike incrementals, each differential is self-contained relative to the last full -- you never need more than the full plus one differential.

```
Differential Backup Timeline:
  Sunday    Monday    Tuesday   Wednesday  Thursday  Friday    Saturday
  [FULL]    [DIFF]    [DIFF]    [DIFF]     [DIFF]    [DIFF]    [FULL]
  500GB     2GB       5GB       6.5GB      9GB       11GB      520GB
                      ↑ Grows each day because it includes ALL
                        changes since Sunday's full backup

  Restore to Wednesday state:
  1. Restore Sunday's FULL backup
  2. Apply Wednesday's differential (contains Mon+Tue+Wed changes)
  Time: 2-4 hours (faster restore than incremental chain)

  Advantage: No chain dependency. Tuesday's differential being
             corrupted does NOT affect Wednesday's restore.
```

**Choosing your backup strategy is about tradeoffs:**

| Factor | Full Only | Full + Incremental | Full + Differential |
|---|---|---|---|
| Backup speed | Slow (hours) | Fast (minutes) | Medium (grows daily) |
| Storage cost | High | Low | Medium |
| Restore speed | Fast | Slow (chain replay) | Medium |
| Restore complexity | Simple | Complex (chain ordering) | Simple |
| Chain break risk | None | High (one bad link) | None |
| Our recommendation | Weekly | Hourly binlog capture | Daily |

For our booking platform, we use a **combination**: weekly full backups, daily differentials, and continuous binary log capture for point-in-time recovery. This gives us the safety of full backups, the speed of differentials, and the precision of PITR.

> **Mentor's Note:** I have seen teams rely exclusively on incremental chains spanning 30 days. When they needed to restore, they discovered that one incremental from day 12 had a checksum mismatch. Every incremental after day 12 was useless. The restore went back to the most recent full backup -- which was 30 days old. Thirty days of bookings, gone. Use a layered strategy. Full backups are your foundation. Everything else builds on top.

---

## Cross-Region Replication

Backups protect against data corruption. Replication protects against infrastructure failure. The distinction matters: a backup is a snapshot frozen in time; a replica is a living copy that stays in sync with the primary.

For our booking platform, we need data available in multiple geographic regions simultaneously. Two architectures dominate: active-passive and active-active.

### Active-Passive Replication

In active-passive, one region handles all writes. The other region maintains read replicas that stay synchronized.

```
┌────────────────────────────────────────────────────────────┐
│              ACTIVE-PASSIVE REPLICATION                      │
│                                                              │
│  US-East-1 (PRIMARY)              EU-West-1 (STANDBY)       │
│  ┌──────────────────┐             ┌──────────────────┐       │
│  │  MySQL Primary   │────────────►│  MySQL Replica    │       │
│  │  (reads+writes)  │  Async      │  (reads only)     │       │
│  │                  │  Repl.      │                    │       │
│  │  Shard 1 Primary │  ~200ms    │  Shard 1 Replica   │       │
│  │  Shard 2 Primary │  lag       │  Shard 2 Replica   │       │
│  │  Shard 3 Primary │            │  Shard 3 Replica   │       │
│  └──────────────────┘             └──────────────────┘       │
│                                                              │
│  Failover process:                                           │
│  1. Detect primary failure (health checks, 30s)              │
│  2. Stop replication on standby                              │
│  3. Promote replica to primary (STOP REPLICA; RESET REPLICA ALL) │
│  4. Update DNS to point to new primary                       │
│  5. Application reconnects to new primary                    │
│                                                              │
│  Risk: Transactions in-flight during the ~200ms replication  │
│  lag window are lost. At 100K bookings/min, ~200ms = ~333    │
│  bookings potentially lost.                                  │
└────────────────────────────────────────────────────────────┘
```

```typescript
// replication/active-passive-monitor.ts
@Injectable()
export class ReplicationMonitorService {
  private readonly MAX_ACCEPTABLE_LAG_MS = 1000;
  private readonly CRITICAL_LAG_MS = 5000;

  /**
   * Monitors replication lag between primary and standby regions.
   *
   * Why replication lag matters: In async replication, the standby
   * is always slightly behind the primary. If the primary dies,
   * any transactions that were committed on the primary but not
   * yet replicated to the standby are lost forever.
   *
   * Replication lag = RPO. If lag is 500ms, your actual RPO is 500ms,
   * regardless of what your DR plan says.
   */
  @Cron('*/5 * * * * *') // Every 5 seconds
  async checkReplicationLag(): Promise<void> {
    const shards = await this.shardRegistry.getAllShards();

    for (const shard of shards) {
      const lagResult = await this.mysqlQuery(
        shard.replica,
        'SHOW REPLICA STATUS',
      );

      const lagSeconds = lagResult[0]?.Seconds_Behind_Source;

      if (lagSeconds === null) {
        // Replication is broken -- not lagging, BROKEN
        this.alerting.critical(
          `Replication BROKEN on shard ${shard.shardId}`,
          {
            message: 'Seconds_Behind_Source is NULL',
            lastError: lagResult[0]?.Last_Error,
          },
        );
        continue;
      }

      const lagMs = lagSeconds * 1000;

      this.metrics.gauge('replication_lag_ms', lagMs, {
        shard: shard.shardId,
      });

      if (lagMs > this.CRITICAL_LAG_MS) {
        this.alerting.critical(
          `Replication lag critical: ${lagMs}ms on shard ${shard.shardId}`,
          { lagMs, threshold: this.CRITICAL_LAG_MS },
        );
      } else if (lagMs > this.MAX_ACCEPTABLE_LAG_MS) {
        this.alerting.warning(
          `Replication lag elevated: ${lagMs}ms on shard ${shard.shardId}`,
          { lagMs, threshold: this.MAX_ACCEPTABLE_LAG_MS },
        );
      }
    }
  }
}
```

### Active-Active Replication

In active-active, both regions accept writes. This eliminates the single-point-of-failure for writes but introduces the hardest problem in distributed systems: **conflict resolution**.

```
┌──────────────────────────────────────────────────────────────────┐
│             ACTIVE-ACTIVE REPLICATION                             │
│                                                                    │
│  US-East-1                                EU-West-1                │
│  ┌──────────────────┐                    ┌──────────────────┐      │
│  │  MySQL Primary   │◄──── Bi-dir ──────►│  MySQL Primary   │      │
│  │  (reads+writes)  │     Async Repl     │  (reads+writes)  │      │
│  │                  │                    │                    │      │
│  │  Writes for      │                    │  Writes for        │      │
│  │  US/SA users     │                    │  EU/AF/ME users    │      │
│  └──────────────────┘                    └──────────────────┘      │
│         ▲                                         ▲                │
│         │         ┌──────────────────┐             │                │
│         └────────►│  AP-South-1      │◄────────────┘                │
│       Bi-dir      │  MySQL Primary   │  Bi-dir                     │
│       Async       │  (reads+writes)  │  Async                      │
│                   │  Writes for      │                              │
│                   │  APAC users      │                              │
│                   └──────────────────┘                              │
│                                                                    │
│  Conflict Resolution Strategy:                                     │
│  - Each region "owns" a shard range (geographic partitioning)      │
│  - Booking IDs include region prefix: US-BK-xxxxx, EU-BK-xxxxx    │
│  - Cross-region reads are eventual consistent                      │
│  - Same-region reads are strongly consistent                       │
│  - Conflicting writes resolved by timestamp (last-write-wins)      │
│    with conflict log for manual review                             │
└──────────────────────────────────────────────────────────────────┘
```

```typescript
// replication/conflict-resolver.ts

/**
 * Handles write conflicts in active-active replication.
 *
 * Why conflicts happen: User in US modifies booking BK-12345.
 * Simultaneously, a support agent in EU modifies the same booking.
 * Both writes succeed locally. When replication delivers the US
 * write to EU and the EU write to US, there is a conflict.
 *
 * Our strategy: geographic partitioning minimizes conflicts (each
 * booking is "owned" by the region where it was created), but
 * cross-region modifications still happen (customer calls EU
 * support center about a US booking).
 */
@Injectable()
export class ConflictResolverService {
  async resolveConflict(
    localRecord: BookingRecord,
    remoteRecord: BookingRecord,
  ): Promise<BookingRecord> {
    // Strategy 1: If one record is a tombstone (deletion), deletion wins.
    // Rationale: A cancellation should always propagate.
    if (localRecord.deletedAt || remoteRecord.deletedAt) {
      this.logger.warn(
        `Conflict resolved by deletion-wins for booking ${localRecord.id}`,
      );
      const winner = localRecord.deletedAt ? localRecord : remoteRecord;
      await this.logConflict(localRecord, remoteRecord, winner, 'deletion-wins');
      return winner;
    }

    // Strategy 2: If modifications are to different fields, merge them.
    const conflictingFields = this.findConflictingFields(
      localRecord,
      remoteRecord,
    );

    if (conflictingFields.length === 0) {
      const merged = this.mergeNonConflicting(localRecord, remoteRecord);
      await this.logConflict(localRecord, remoteRecord, merged, 'field-merge');
      return merged;
    }

    // Strategy 3: For same-field conflicts, last-write-wins by timestamp.
    const winner =
      localRecord.updatedAt > remoteRecord.updatedAt
        ? localRecord
        : remoteRecord;

    await this.logConflict(localRecord, remoteRecord, winner, 'last-write-wins');

    // Strategy 4: Flag for human review if the conflict involves
    // financial fields (price, payment status, refund amount).
    if (this.involvesFinancialFields(conflictingFields)) {
      await this.flagForHumanReview(localRecord, remoteRecord, winner);
    }

    return winner;
  }
}
```

> **Why Not Synchronous Replication?** Synchronous replication guarantees zero data loss -- every write is confirmed on both regions before the application receives a success response. But the cost is latency. A write that takes 5ms locally takes 5ms + network round-trip (80-200ms cross-region) synchronously. For a booking system processing 100,000 writes per minute, adding 100ms to every write is unacceptable. Users would see lag on every confirmation. Throughput would plummet. Async replication with sub-second lag is the practical choice.

---

## Failover Automation

When a region fails, humans are too slow. By the time an on-call engineer wakes up, reads the alert, logs into the VPN, assesses the situation, and initiates failover, 15-30 minutes have passed. At 100,000 bookings per minute, that is 1.5 to 3 million bookings lost.

Failover must be automated with human oversight. The system detects the failure, initiates failover, and pages the on-call team to **confirm and monitor** -- not to initiate.

### DNS-Based Failover

DNS failover is the outermost layer. Global load balancers (AWS Route 53, Cloudflare, etc.) health-check each region and remove unhealthy regions from DNS resolution.

```
┌─────────────────────────────────────────────────────────────┐
│               DNS HEALTH CHECK FAILOVER                      │
│                                                               │
│  Route 53 Weighted Routing                                    │
│  api.bookings.com                                             │
│    ├── US-East-1:  35% weight  ── Health Check: /health ──►  │
│    ├── EU-West-1:  35% weight  ── Health Check: /health ──►  │
│    └── AP-South-1: 30% weight  ── Health Check: /health ──►  │
│                                                               │
│  Health check config:                                         │
│    Protocol: HTTPS                                            │
│    Path: /health/deep                                         │
│    Interval: 10 seconds                                       │
│    Failure threshold: 3 consecutive failures                  │
│    Success threshold: 2 consecutive successes                 │
│    Regions checking: US, EU, AP (cross-region validation)     │
│                                                               │
│  When US-East-1 fails:                                        │
│    T+0s:   First health check fails                           │
│    T+10s:  Second health check fails                          │
│    T+20s:  Third health check fails → REGION REMOVED          │
│    T+20s:  DNS updated: EU-West-1: 55%, AP-South-1: 45%      │
│    T+30s:  DNS TTL expires, clients resolve to healthy regions │
│                                                               │
│  Total detection + DNS propagation: ~30 seconds               │
└─────────────────────────────────────────────────────────────┘
```

```typescript
// health/deep-health-check.controller.ts

/**
 * The /health/deep endpoint that Route 53 hits every 10 seconds.
 *
 * This is NOT a simple "return 200" liveness check. It verifies
 * that the region can actually process bookings. If the MySQL
 * primary is unreachable, or Redis is down, or Kafka is
 * unresponsive, this endpoint returns 503 -- which triggers
 * Route 53 to remove this region from DNS.
 *
 * Every dependency must be checked. A region that returns 200
 * but cannot write to the database will accept bookings and
 * silently lose them.
 */
@Controller('health')
export class DeepHealthCheckController {
  @Get('deep')
  async deepHealthCheck(): Promise<HealthCheckResult> {
    const checks: HealthCheck[] = [
      {
        name: 'mysql-primary',
        check: () => this.checkMySQL(),
        critical: true,
      },
      {
        name: 'redis-cluster',
        check: () => this.checkRedis(),
        critical: true,
      },
      {
        name: 'kafka-brokers',
        check: () => this.checkKafka(),
        critical: true,
      },
      {
        name: 'payment-gateway',
        check: () => this.checkPaymentGateway(),
        critical: false, // degraded mode acceptable
      },
    ];

    const results = await Promise.allSettled(
      checks.map(async (c) => ({
        name: c.name,
        critical: c.critical,
        status: await c.check(),
      })),
    );

    const failures = results
      .filter((r) => r.status === 'rejected' || !r.value.status.healthy)
      .map((r) => r.status === 'rejected' ? r.reason : r.value);

    const criticalFailures = failures.filter((f) => f.critical);

    if (criticalFailures.length > 0) {
      // Return 503 -- tells Route 53 this region is unhealthy
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        criticalFailures: criticalFailures.map((f) => f.name),
        message: 'Region cannot process bookings',
      });
    }

    return { status: 'healthy', checks: results };
  }

  private async checkMySQL(): Promise<{ healthy: boolean }> {
    try {
      // Do not just SELECT 1 -- actually test write capability
      await this.prisma.$executeRaw`
        INSERT INTO health_checks (checked_at, region)
        VALUES (NOW(), ${this.region})
        ON DUPLICATE KEY UPDATE checked_at = NOW()
      `;
      return { healthy: true };
    } catch {
      return { healthy: false };
    }
  }
}
```

### Database Promotion Scripts

When the primary MySQL instance fails, a replica must be promoted to primary. This is the most critical and dangerous step in the failover sequence.

```typescript
// failover/database-promotion.service.ts
@Injectable()
export class DatabasePromotionService {
  /**
   * Promotes a MySQL replica to primary.
   *
   * This is a one-way operation. Once promoted, the old primary
   * (when it recovers) CANNOT simply rejoin as primary. It must
   * be rebuilt as a replica of the new primary. Getting this wrong
   * causes split-brain: two nodes both accepting writes, diverging
   * data, unrecoverable conflicts.
   */
  async promoteReplica(
    shardId: string,
    replicaHost: string,
  ): Promise<PromotionResult> {
    this.logger.warn(
      `INITIATING REPLICA PROMOTION for shard ${shardId} on ${replicaHost}`,
    );

    // Step 1: Verify the primary is actually unreachable.
    // NEVER promote if the primary might still be alive.
    const primaryReachable = await this.checkPrimaryReachable(shardId);
    if (primaryReachable) {
      throw new Error(
        `ABORTING PROMOTION: Primary for shard ${shardId} is still reachable. ` +
        `Promoting now would cause split-brain.`,
      );
    }

    // Step 2: Wait for the replica to apply all pending relay logs.
    // The replica may have received binary logs it has not yet applied.
    await this.mysqlQuery(replicaHost, `STOP REPLICA IO_THREAD`);
    await this.waitForRelayLogApplied(replicaHost);

    // Step 3: Stop replication entirely and reset slave configuration.
    await this.mysqlQuery(replicaHost, `STOP REPLICA`);
    await this.mysqlQuery(replicaHost, `RESET REPLICA ALL`);

    // Step 4: Set the replica to read-write mode.
    await this.mysqlQuery(replicaHost, `SET GLOBAL read_only = OFF`);
    await this.mysqlQuery(replicaHost, `SET GLOBAL super_read_only = OFF`);

    // Step 5: Verify the promoted replica can accept writes.
    await this.mysqlQuery(
      replicaHost,
      `INSERT INTO promotion_log (shard_id, promoted_at, promoted_by)
       VALUES ('${shardId}', NOW(), 'automated-failover')`,
    );

    // Step 6: Update the service registry so application servers
    // connect to the new primary.
    await this.serviceRegistry.updatePrimary(shardId, replicaHost);

    // Step 7: Notify. Every promotion is an incident.
    await this.alerting.critical(
      `DATABASE PROMOTED: Shard ${shardId} new primary is ${replicaHost}`,
      {
        action: 'replica-promotion',
        previousPrimary: await this.getPreviousPrimary(shardId),
        newPrimary: replicaHost,
      },
    );

    return {
      shardId,
      newPrimary: replicaHost,
      promotedAt: new Date(),
      replicationLagAtPromotion: await this.getLastKnownLag(shardId),
    };
  }
}
```

> **Warning About Split-Brain:** Split-brain occurs when two database nodes both believe they are the primary and both accept writes. The data diverges, and merging the two datasets afterward is often impossible without data loss. Every promotion script must include a "fencing" step that guarantees the old primary cannot accept writes. In cloud environments, this means revoking its security group access or powering down the instance. Never rely solely on application-level checks -- the old primary might recover and start accepting writes from cached connection pools before your application-level check runs.

---

## Data Center Failure Scenarios and Response Procedures

Disasters do not announce themselves politely. They arrive in categories, each demanding a different response. Preparing for disaster means cataloging the scenarios you will face and building a response procedure for each one.

### Scenario 1: Single Availability Zone Failure

**What happens:** One AZ within a region loses power or network. Services running in that AZ become unreachable, but the region's other AZs remain healthy.

```
┌──────────────────────────────────────────────────────────┐
│         SINGLE AZ FAILURE WITHIN US-EAST-1                │
│                                                            │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐           │
│  │  AZ-1a     │  │  AZ-1b     │  │  AZ-1c     │           │
│  │  ██████    │  │  ✓ Healthy │  │  ✓ Healthy │           │
│  │  OFFLINE   │  │  3 pods    │  │  3 pods    │           │
│  │  3 pods    │  │  1 DB node │  │  1 DB node │           │
│  │  1 DB node │  │  2 Redis   │  │  2 Redis   │           │
│  │  2 Redis   │  │            │  │            │           │
│  └────────────┘  └────────────┘  └────────────┘           │
│                                                            │
│  Impact: ~33% capacity loss in region                      │
│  Response: Auto-scaling replaces pods in healthy AZs       │
│  Data impact: None if DB uses multi-AZ replication         │
│  Recovery time: 2-5 minutes (Kubernetes rescheduling)      │
└──────────────────────────────────────────────────────────┘
```

**Response Procedure:**
1. Kubernetes automatically reschedules pods from the failed AZ to healthy AZs
2. Auto-scaler detects increased load on surviving pods, scales up
3. Database failover to replica in healthy AZ (RDS Multi-AZ handles this)
4. Monitor for cascading failures due to reduced capacity
5. Page on-call only if auto-recovery does not complete within 5 minutes

### Scenario 2: Full Region Failure

**What happens:** An entire AWS/GCP/Azure region becomes unreachable. All AZs, all services, all data within that region are offline.

```
┌──────────────────────────────────────────────────────────────┐
│              FULL REGION FAILURE                               │
│                                                                │
│  ┌────────────────┐    ┌────────────────┐                      │
│  │  US-East-1     │    │  EU-West-1     │                      │
│  │  ██████████    │    │  ✓ HEALTHY     │                      │
│  │  ENTIRE REGION │    │  Absorbing     │                      │
│  │  OFFLINE       │    │  US traffic    │                      │
│  │                │    │  Scaling up    │                      │
│  └────────────────┘    └────────────────┘                      │
│          ×                      ▲                              │
│          │              ┌──────┴────────┐                      │
│     DNS removes    ┌────┤  AP-South-1   │                      │
│     US-East-1      │    │  ✓ HEALTHY    │                      │
│                    │    │  Absorbing    │                      │
│                    │    │  US traffic   │                      │
│                    │    └───────────────┘                      │
│                    │                                           │
│  Impact: 35% global capacity lost                             │
│  Response: DNS failover + auto-scaling in surviving regions   │
│  Data impact: Up to replication lag (~200ms = ~333 bookings)  │
│  Recovery time: 2-5 minutes for traffic shift                 │
└──────────────────────────────────────────────────────────────┘
```

**Response Procedure:**
1. Route 53 health checks detect failure (30 seconds)
2. DNS removes failed region, redistributes weight to survivors
3. Surviving regions auto-scale to absorb additional load
4. On-call engineer validates: are surviving regions healthy under load?
5. Communicate to stakeholders: "Region X is offline, DR is active"
6. Monitor replication lag -- the failed region's last transactions may be lost
7. When region recovers: rebuild as replica, verify data consistency, gradually restore traffic

### Scenario 3: Correlated Multi-Region Failure

**What happens:** A cloud provider issue (e.g., a control plane bug, a global DNS failure, or a cascading configuration error) impacts multiple regions simultaneously.

This is the nightmare scenario. It is rare, but it happens -- the 2017 S3 outage and the 2024 CrowdStrike incident both had multi-region impact.

**Response Procedure:**
1. Activate the "war room" communication channel immediately
2. If any region is partially functional, route all traffic there
3. If the entire cloud provider is down, activate multi-cloud failover (if available)
4. Enable "degraded mode" -- serve cached responses, queue bookings for later processing
5. Communicate proactively to customers: status page, social media, email
6. Document every action with timestamps for the post-incident review

```typescript
// failover/degraded-mode.service.ts

/**
 * Degraded mode: when the database is unreachable, serve what
 * you can from cache and queue the rest.
 *
 * This is NOT "business as usual." It is damage control. Users
 * can search for availability (cached data), but new bookings
 * are queued locally and processed when the database returns.
 * The booking confirmation becomes "pending" rather than
 * "confirmed." Honest degradation is better than silent failure.
 */
@Injectable()
export class DegradedModeService {
  private isDegraded = false;

  async activateDegradedMode(reason: string): Promise<void> {
    this.isDegraded = true;
    this.logger.warn(`DEGRADED MODE ACTIVATED: ${reason}`);

    // Switch to read-only cache for availability searches
    await this.cacheService.setReadOnlyMode(true);

    // Queue new bookings to local disk instead of database
    await this.bookingQueue.switchToLocalDiskQueue();

    // Update status page
    await this.statusPage.updateStatus({
      component: 'booking-engine',
      status: 'degraded_performance',
      message: 'Bookings are being accepted but confirmations may be delayed.',
    });

    // Notify all regions
    await this.interRegionMessaging.broadcast({
      type: 'DEGRADED_MODE_ACTIVE',
      reason,
      activatedAt: new Date(),
    });
  }

  async deactivateDegradedMode(): Promise<void> {
    this.isDegraded = false;

    // Process queued bookings
    const queuedCount = await this.bookingQueue.processLocalDiskQueue();
    this.logger.log(`Processed ${queuedCount} queued bookings from degraded mode`);

    // Restore normal operations
    await this.cacheService.setReadOnlyMode(false);
    await this.statusPage.updateStatus({
      component: 'booking-engine',
      status: 'operational',
      message: 'All systems operational.',
    });
  }
}
```

> **Analogy:** Degraded mode is like a hospital running on generator power during a blackout. The operating rooms stay lit. The ICU monitors keep running. But elective procedures are postponed, the cafeteria closes, and non-essential lights are turned off. The hospital keeps functioning for critical needs while operating at reduced capacity. Your booking system should do the same -- search works, active bookings are protected, but new bookings enter a queue rather than being lost entirely.

---

## Testing DR: Game Day Exercises and Chaos Engineering

A disaster recovery plan that has never been tested is not a plan. It is a wish. The only way to know if your DR works is to trigger it deliberately, under controlled conditions, and observe what breaks.

### Game Day Exercises

A "game day" is a scheduled, announced exercise where you simulate a disaster and execute your DR plan. The entire team knows it is happening. The goal is not to surprise people -- it is to find gaps in the plan.

```
┌──────────────────────────────────────────────────────────────┐
│               GAME DAY EXERCISE TEMPLATE                      │
│                                                                │
│  Pre-Exercise (1 week before):                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Define scenario: "US-East-1 region failure"          │   │
│  │ 2. Identify participants: SRE, DB team, app team, PM   │   │
│  │ 3. Set success criteria:                                │   │
│  │    - RTO < 5 minutes                                    │   │
│  │    - RPO < 1 second                                     │   │
│  │    - No booking data loss                               │   │
│  │    - Customer-facing errors < 0.1% during transition    │   │
│  │ 4. Prepare rollback plan (abort exercise if unsafe)     │   │
│  │ 5. Schedule during low-traffic window                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  During Exercise:                                              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ T+0:00  Inject failure (block region traffic)           │   │
│  │ T+0:30  Verify: health checks detect failure            │   │
│  │ T+1:00  Verify: DNS removes failed region               │   │
│  │ T+2:00  Verify: traffic shifts to surviving regions     │   │
│  │ T+3:00  Verify: auto-scaling activates                  │   │
│  │ T+5:00  Verify: all bookings processing normally        │   │
│  │ T+10:00 Monitor: error rates, latency, throughput       │   │
│  │ T+30:00 Restore: bring failed region back online        │   │
│  │ T+45:00 Verify: region rejoins, data syncs              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  Post-Exercise:                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Measure actual RTO and RPO achieved                  │   │
│  │ 2. Document every issue encountered                     │   │
│  │ 3. Create action items for gaps found                   │   │
│  │ 4. Update runbooks based on learnings                   │   │
│  │ 5. Schedule next exercise (quarterly minimum)           │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Chaos Engineering

Chaos engineering goes beyond scheduled exercises. It introduces failures **continuously and randomly** into production to build confidence that the system handles them gracefully. Netflix pioneered this with Chaos Monkey, which randomly terminates production instances.

```typescript
// chaos/chaos-engine.service.ts

/**
 * Chaos engineering for the booking platform.
 *
 * IMPORTANT: Chaos experiments run in production, but with
 * blast-radius controls. We never kill more than one instance
 * at a time. We never target the database primary directly.
 * We have automatic abort conditions that stop the experiment
 * if error rates exceed thresholds.
 */
@Injectable()
export class ChaosEngineService {
  private readonly experiments: ChaosExperiment[] = [
    {
      name: 'pod-termination',
      description: 'Kill a random booking-service pod',
      frequency: 'daily',
      blastRadius: 'single-pod',
      abortCondition: 'error_rate > 1%',
      execute: async () => {
        const pods = await this.k8s.listPods('booking-service');
        const target = pods[Math.floor(Math.random() * pods.length)];
        await this.k8s.deletePod(target.name, target.namespace);
        return { killed: target.name };
      },
    },
    {
      name: 'redis-node-failure',
      description: 'Simulate a Redis cluster node going offline',
      frequency: 'weekly',
      blastRadius: 'single-redis-node',
      abortCondition: 'cache_miss_rate > 50% || error_rate > 2%',
      execute: async () => {
        const nodes = await this.redis.getClusterNodes();
        const replica = nodes.find((n) => n.role === 'replica');
        await this.network.blockTraffic(replica.host, replica.port);
        // Auto-restore after 5 minutes
        setTimeout(() => {
          this.network.unblockTraffic(replica.host, replica.port);
        }, 300_000);
        return { blocked: replica.host };
      },
    },
    {
      name: 'network-latency-injection',
      description: 'Add 500ms latency to cross-region calls',
      frequency: 'weekly',
      blastRadius: 'cross-region-traffic',
      abortCondition: 'p99_latency > 5000ms',
      execute: async () => {
        await this.network.injectLatency({
          target: 'cross-region',
          latencyMs: 500,
          durationMinutes: 10,
        });
        return { injected: '500ms latency for 10 minutes' };
      },
    },
    {
      name: 'az-drain',
      description: 'Drain all pods from one availability zone',
      frequency: 'monthly',
      blastRadius: 'single-az',
      abortCondition: 'error_rate > 5% || booking_throughput < 50%',
      execute: async () => {
        const targetAz = 'us-east-1a';
        await this.k8s.cordonNodesInAz(targetAz);
        await this.k8s.drainNodesInAz(targetAz);
        // Auto-restore after 15 minutes
        setTimeout(() => {
          this.k8s.uncordonNodesInAz(targetAz);
        }, 900_000);
        return { drained: targetAz };
      },
    },
  ];

  @Cron('0 14 * * 1-5') // Weekdays at 2 PM (during business hours!)
  async runScheduledExperiment(): Promise<void> {
    // Only run if system is healthy -- do not chaos test during an incident
    const systemHealthy = await this.healthService.isSystemHealthy();
    if (!systemHealthy) {
      this.logger.log('Skipping chaos experiment: system not healthy');
      return;
    }

    const dueExperiments = this.experiments.filter((e) =>
      this.isDue(e.frequency),
    );

    if (dueExperiments.length === 0) return;

    const experiment = dueExperiments[0];
    this.logger.warn(`CHAOS EXPERIMENT STARTING: ${experiment.name}`);

    // Start monitoring abort conditions
    const abortMonitor = this.startAbortMonitor(experiment.abortCondition);

    try {
      const result = await experiment.execute();
      this.logger.log(`Chaos experiment completed: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error(`Chaos experiment failed: ${error.message}`);
    } finally {
      abortMonitor.stop();
    }
  }
}
```

> **Why Run Chaos During Business Hours?** This sounds counterintuitive. Would it not be safer to run chaos experiments at 3 AM when traffic is low? No. The point of chaos engineering is to build confidence that your system handles failures **when it matters**. Low-traffic failures are easy to survive. You need to know your system survives failures under real load. Additionally, running during business hours means engineers are awake, available, and can respond immediately if the experiment reveals a real problem. Running chaos at 3 AM means an engineer gets paged from sleep to deal with a self-inflicted incident -- that is not chaos engineering, that is cruelty.

---

## Backup Verification: Automated Restore Testing

A backup you have never restored is not a backup. It is a file taking up storage space. You do not know if it is corrupted. You do not know if it is complete. You do not know if your restore process actually works. The only way to verify a backup is to restore it and validate the data.

```typescript
// backup-verification/restore-test.service.ts
@Injectable()
export class BackupVerificationService {
  /**
   * Weekly automated restore test.
   *
   * This service restores the latest backup to an isolated test
   * environment and runs validation queries to confirm the data
   * is complete and consistent.
   *
   * Why automate this? Because manual restore tests do not happen.
   * Teams plan to test restores quarterly. Then Q1 is busy. Then
   * Q2 has a reorg. Then Q3 someone is on vacation. Then Q4 is
   * code freeze. A year passes. The backups have never been tested.
   * Then the disaster hits. Automate it so it happens regardless
   * of human schedules and priorities.
   */
  @Cron('0 2 * * 0') // Sunday at 2 AM
  async weeklyRestoreTest(): Promise<void> {
    const testId = `restore-test-${Date.now()}`;
    this.logger.log(`Starting automated restore test: ${testId}`);

    let testInstance: DatabaseInstance | null = null;

    try {
      // Step 1: Find the latest backup
      const latestBackup = await this.backupCatalog.getLatestFullBackup();
      if (!latestBackup) {
        throw new Error('No full backup found in catalog');
      }

      // Step 2: Provision an isolated test database instance
      testInstance = await this.provisioner.createTestInstance({
        instanceType: 'db.r6g.large', // Smaller than prod
        identifier: `restore-test-${testId}`,
        securityGroup: 'restore-test-isolated', // No prod access
      });

      // Step 3: Download and restore the backup
      const restoreStart = Date.now();
      await this.restoreEngine.restoreFromS3(
        latestBackup.s3Key,
        testInstance,
      );
      const restoreDurationMs = Date.now() - restoreStart;

      // Step 4: Run validation queries
      const validationResults = await this.validateRestoredData(
        testInstance,
        latestBackup,
      );

      // Step 5: Record results
      await this.recordTestResult({
        testId,
        backupKey: latestBackup.s3Key,
        backupTimestamp: latestBackup.timestamp,
        restoreDurationMs,
        validationResults,
        success: validationResults.every((v) => v.passed),
      });

      if (validationResults.some((v) => !v.passed)) {
        await this.alerting.critical(
          `BACKUP RESTORE TEST FAILED: ${testId}`,
          { failures: validationResults.filter((v) => !v.passed) },
        );
      } else {
        this.logger.log(
          `Restore test PASSED: ${testId} (${restoreDurationMs}ms)`,
        );
      }

    } finally {
      // Always clean up the test instance
      if (testInstance) {
        await this.provisioner.deleteInstance(testInstance.identifier);
      }
    }
  }

  private async validateRestoredData(
    instance: DatabaseInstance,
    backup: BackupRecord,
  ): Promise<ValidationResult[]> {
    const conn = await this.connectToInstance(instance);

    return [
      // Check 1: Row counts match expected ranges
      {
        name: 'booking-count',
        passed: await this.checkRowCount(conn, 'bookings', 1_000_000),
        details: 'Bookings table has expected minimum row count',
      },
      // Check 2: No orphaned records
      {
        name: 'referential-integrity',
        passed: await this.checkReferentialIntegrity(conn),
        details: 'All foreign keys resolve to existing parent records',
      },
      // Check 3: Latest data timestamp matches expected window
      {
        name: 'data-freshness',
        passed: await this.checkDataFreshness(conn, backup.timestamp),
        details: 'Most recent record timestamp is within expected range',
      },
      // Check 4: Checksums on critical tables
      {
        name: 'table-checksums',
        passed: await this.checkTableChecksums(conn, backup.checksums),
        details: 'CHECKSUM TABLE matches recorded values',
      },
      // Check 5: Stored procedures and triggers exist
      {
        name: 'schema-completeness',
        passed: await this.checkSchemaCompleteness(conn),
        details: 'All expected tables, procedures, and triggers exist',
      },
    ];
  }
}
```

> **Mentor's Note:** I once worked with a team that had been running daily backups for two years. When they finally needed to restore, they discovered the backup user's permissions had been changed six months earlier. The backups had been running but only capturing the schema -- no data. Two years of "backups" contained empty tables. Automated restore testing would have caught this on the first weekly test after the permission change.

---

## The Complete Disaster Recovery Runbook

A runbook is a step-by-step operational procedure that anyone on the team can follow during an incident. It is not a design document. It is not a wiki page with best practices. It is a checklist, written for an engineer who is sleep-deprived, stressed, and operating at 3 AM with executives asking "when will it be back?"

```
╔══════════════════════════════════════════════════════════════════╗
║          DISASTER RECOVERY RUNBOOK — BOOKING PLATFORM            ║
║          Document version: 3.2 | Last tested: 2025-12-15        ║
║          Owner: SRE Team | Escalation: VP Engineering            ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  STEP 0: ASSESS THE SITUATION (< 2 minutes)                       ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ What is down? (Single AZ / Full region / Multi-region)    │  ║
║  │ □ When did it start? (Check first alert timestamp)          │  ║
║  │ □ Is auto-failover in progress? (Check Route 53 dashboard) │  ║
║  │ □ What is the blast radius? (Which services affected)       │  ║
║  │ □ Is data at risk? (Check replication lag at time of fail)  │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
║  STEP 1: CONFIRM FAILOVER STATUS (< 1 minute)                     ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ DNS health checks have removed the failed region          │  ║
║  │   Command: dig api.bookings.com +short                      │  ║
║  │   Expected: Only healthy region IPs returned                │  ║
║  │                                                              │  ║
║  │ □ Surviving regions are receiving traffic                    │  ║
║  │   Dashboard: grafana.internal/d/global-traffic              │  ║
║  │   Expected: 50-100% increase in surviving region traffic    │  ║
║  │                                                              │  ║
║  │ □ If auto-failover has NOT triggered:                       │  ║
║  │   Manual DNS override:                                       │  ║
║  │   aws route53 change-resource-record-sets \                 │  ║
║  │     --hosted-zone-id $ZONE_ID \                              │  ║
║  │     --change-batch file://failover-remove-region.json       │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
║  STEP 2: VERIFY DATA INTEGRITY (< 5 minutes)                      ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ Check replication lag at moment of failure                 │  ║
║  │   Query: SELECT * FROM replication_lag_log                   │  ║
║  │          WHERE region = 'failed-region'                      │  ║
║  │          ORDER BY recorded_at DESC LIMIT 10;                 │  ║
║  │                                                              │  ║
║  │ □ Identify potentially lost transactions                    │  ║
║  │   If lag was < 1 second: minimal concern                     │  ║
║  │   If lag was > 1 second: query booking_events table for      │  ║
║  │   events created in the lag window                           │  ║
║  │                                                              │  ║
║  │ □ Cross-reference with payment gateway                      │  ║
║  │   Any payment captured but booking not replicated =          │  ║
║  │   a booking that needs manual restoration                   │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
║  STEP 3: SCALE SURVIVING REGIONS (< 5 minutes)                    ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ Verify auto-scaling is active                              │  ║
║  │   kubectl get hpa -n booking-service                         │  ║
║  │   Expected: replicas increasing                              │  ║
║  │                                                              │  ║
║  │ □ If auto-scaling is insufficient, manually scale:          │  ║
║  │   kubectl scale deployment booking-service \                │  ║
║  │     --replicas=50 -n production                              │  ║
║  │                                                              │  ║
║  │ □ Monitor resource utilization                               │  ║
║  │   CPU should stabilize below 70% after scaling              │  ║
║  │   Memory should remain below 80%                             │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
║  STEP 4: COMMUNICATE (ongoing)                                     ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ Update status page: statuspage.bookings.com               │  ║
║  │ □ Notify leadership: #incident-command Slack channel        │  ║
║  │ □ Customer communication: every 30 minutes until resolved   │  ║
║  │ □ Partner API notification: notify B2B partners of          │  ║
║  │   potential latency increase                                │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
║  STEP 5: RECOVERY — WHEN THE FAILED REGION RETURNS (hours-days)   ║
║  ┌──────────────────────────────────────────────────────────────┐  ║
║  │ □ Do NOT immediately route traffic back                     │  ║
║  │ □ Rebuild replication from current primary to recovered     │  ║
║  │   region (it is now the replica, not the primary)           │  ║
║  │ □ Wait for replication to fully catch up (verify lag = 0)   │  ║
║  │ □ Run data consistency checks between regions               │  ║
║  │ □ Gradually increase traffic to recovered region:           │  ║
║  │   5% → 10% → 25% → 35% (normal), over 2 hours            │  ║
║  │ □ Monitor error rates at each traffic increase step         │  ║
║  └──────────────────────────────────────────────────────────────┘  ║
║                                                                    ║
╚══════════════════════════════════════════════════════════════════╝
```

> **Why Checklists Work:** The aviation industry adopted checklists after a test flight crash in 1935 killed two experienced pilots. The aircraft was not defective -- the pilots had simply forgotten one of seventeen pre-flight steps. Modern aviation has the safest transportation record in history, and checklists are a core reason. Your DR runbook is your pre-flight checklist. Follow it every time, even when you think you remember the steps. Especially when you think you remember the steps. Memory is unreliable under stress.

---

## Redis Cluster Recovery and Data Reconstruction

Redis serves as the caching and session layer for our booking platform. Unlike MySQL, Redis is typically not the source of truth -- the database is. But losing Redis is not painless. Cold caches mean every request hits the database directly, potentially overwhelming it. Session data loss means every logged-in user gets logged out. Rate limiting state disappears, exposing the system to traffic spikes.

### Redis Cluster Failure Modes

```
┌──────────────────────────────────────────────────────────────┐
│              REDIS CLUSTER ARCHITECTURE                        │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ Master 1 │  │ Master 2 │  │ Master 3 │                     │
│  │ Slots    │  │ Slots    │  │ Slots    │                     │
│  │ 0-5460   │  │ 5461-    │  │ 10923-   │                     │
│  │          │  │ 10922    │  │ 16383    │                     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                     │
│       │             │             │                            │
│  ┌────▼─────┐  ┌────▼─────┐  ┌────▼─────┐                     │
│  │ Replica  │  │ Replica  │  │ Replica  │                     │
│  │ 1a       │  │ 2a       │  │ 3a       │                     │
│  └──────────┘  └──────────┘  └──────────┘                     │
│                                                                │
│  Failure Mode 1: Single master fails                           │
│  → Replica auto-promotes (CLUSTER FAILOVER)                   │
│  → 5-15 second interruption for that slot range               │
│  → No data loss (async replication lag minimal for cache)      │
│                                                                │
│  Failure Mode 2: Master + its replica both fail                │
│  → Slots 0-5460 become unavailable                            │
│  → Cluster enters FAIL state if cluster-require-full-coverage │
│  → Entire cluster may reject commands                          │
│                                                                │
│  Failure Mode 3: Entire cluster lost (region failure)          │
│  → All cached data gone                                        │
│  → Must rebuild from scratch or restore from RDB snapshot      │
└──────────────────────────────────────────────────────────────┘
```

### Redis Recovery Service

```typescript
// recovery/redis-recovery.service.ts
@Injectable()
export class RedisRecoveryService {
  /**
   * Recovers Redis after a cluster-level failure.
   *
   * Redis is a cache, not the source of truth. The recovery
   * strategy prioritizes getting the cluster operational over
   * data completeness. The cache will warm naturally as traffic
   * flows through the system.
   *
   * However, some Redis data IS critical: distributed locks,
   * rate limiter state, and idempotency keys. Losing these
   * requires special handling.
   */
  async recoverRedisCluster(region: string): Promise<RecoveryResult> {
    // Step 1: Deploy fresh Redis cluster nodes
    this.logger.warn(`Deploying new Redis cluster in ${region}`);
    const nodes = await this.k8s.deployRedisCluster({
      region,
      masters: 3,
      replicasPerMaster: 1,
      memoryPerNode: '32Gi',
    });

    // Step 2: Initialize cluster with slot assignment
    await this.redis.createCluster(nodes);

    // Step 3: Optionally restore from RDB snapshot for faster warm-up
    const latestSnapshot = await this.findLatestRdbSnapshot(region);
    if (latestSnapshot) {
      this.logger.log(`Restoring from RDB snapshot: ${latestSnapshot.key}`);
      await this.restoreRdbSnapshot(nodes, latestSnapshot);
    }

    // Step 4: Rebuild critical non-cache data
    await this.rebuildCriticalData(region);

    // Step 5: Enable traffic gradually to warm caches
    await this.enableGradualCacheWarming(region);

    return {
      region,
      nodesDeployed: nodes.length,
      snapshotRestored: !!latestSnapshot,
      criticalDataRebuilt: true,
    };
  }

  /**
   * Rebuilds data that Redis held beyond simple caching.
   *
   * Distributed locks: These expire naturally. But any in-flight
   * booking that held a lock now thinks it still has it, while
   * the new Redis has no record. We must invalidate all in-flight
   * lock holders by bumping the lock epoch.
   *
   * Rate limiter state: Losing this temporarily removes rate
   * limiting. We accept this risk for the few minutes of recovery
   * rather than blocking legitimate traffic with zero state.
   *
   * Idempotency keys: These prevent duplicate booking creation.
   * After Redis loss, we fall back to database-level uniqueness
   * constraints as the safety net.
   */
  private async rebuildCriticalData(region: string): Promise<void> {
    // Bump lock epoch to invalidate all existing lock holders
    await this.redis.set(`lock:epoch:${region}`, Date.now().toString());

    // Rebuild active session data from the session database table
    const activeSessions = await this.prisma.session.findMany({
      where: {
        expiresAt: { gt: new Date() },
        region,
      },
    });
    for (const session of activeSessions) {
      await this.redis.setex(
        `session:${session.id}`,
        session.ttlSeconds,
        JSON.stringify(session.data),
      );
    }

    this.logger.log(
      `Rebuilt ${activeSessions.length} active sessions in Redis`,
    );
  }

  /**
   * Gradual cache warming prevents the "thundering herd" problem.
   *
   * If all traffic hits the new empty cache simultaneously, every
   * request will be a cache miss and hit the database. The database,
   * already under stress from the disaster, could be overwhelmed.
   *
   * Instead, we route a small percentage of traffic through the
   * new cache, letting it warm gradually while the majority of
   * requests continue to hit the database or the other region.
   */
  private async enableGradualCacheWarming(region: string): Promise<void> {
    const warmupSteps = [5, 15, 30, 50, 75, 100]; // percentage of traffic

    for (const percent of warmupSteps) {
      await this.loadBalancer.setCacheTrafficPercent(region, percent);
      this.logger.log(
        `Cache warming: ${percent}% traffic routed through Redis in ${region}`,
      );
      // Wait 5 minutes between steps to let the cache fill
      await this.sleep(300_000);

      // Check cache hit rate -- only proceed if it is improving
      const hitRate = await this.redis.getCacheHitRate(region);
      if (hitRate < 0.3 && percent > 30) {
        this.logger.warn(
          `Cache hit rate low (${hitRate}), pausing warmup at ${percent}%`,
        );
        break;
      }
    }
  }
}
```

---

## Kafka Cluster Recovery and Message Replay

Kafka is the event backbone of the booking platform. Every booking event, payment notification, and inventory update flows through Kafka topics. Losing Kafka does not lose data (the database has it), but it breaks the event-driven flows that coordinate between services.

### Kafka Recovery Strategy

```typescript
// recovery/kafka-recovery.service.ts
@Injectable()
export class KafkaRecoveryService {
  /**
   * Kafka recovery after a broker failure or full cluster loss.
   *
   * Kafka's durability depends on its replication factor. With
   * replication factor 3, data survives the loss of two brokers.
   * But a full region loss means all replicas are gone.
   *
   * Recovery approach:
   * 1. Deploy new Kafka cluster
   * 2. Recreate topics with correct configurations
   * 3. Replay events from the source of truth (database)
   *    to rebuild downstream consumer state
   */
  async recoverKafkaCluster(region: string): Promise<void> {
    // Step 1: Deploy new Kafka brokers
    const brokers = await this.k8s.deployKafkaCluster({
      region,
      brokerCount: 6,
      replicationFactor: 3,
      minInsyncReplicas: 2,
    });

    // Step 2: Recreate topics from configuration
    const topicConfigs = await this.getTopicConfigurations();
    for (const topic of topicConfigs) {
      await this.kafka.admin().createTopics({
        topics: [{
          topic: topic.name,
          numPartitions: topic.partitions,
          replicationFactor: topic.replicationFactor,
          configEntries: topic.configEntries,
        }],
      });
    }

    // Step 3: Replay critical events from database
    await this.replayBookingEvents(region);
    await this.replayPaymentEvents(region);
    await this.replayInventoryEvents(region);
  }

  /**
   * Event replay from the database.
   *
   * Why we can do this: Every event that Kafka processes originates
   * from a database write. The booking_events table is the source
   * of truth. If Kafka loses an event, we regenerate it from the
   * database record.
   *
   * The trick is knowing WHICH events need replaying. We track
   * consumer offsets in the database (not just in Kafka) so we
   * know exactly where each consumer left off.
   */
  private async replayBookingEvents(region: string): Promise<void> {
    // Find the last successfully processed event for each consumer group
    const consumerGroups = await this.getConsumerGroups('booking-events');

    for (const group of consumerGroups) {
      const lastProcessedId = await this.prisma.kafkaConsumerOffset.findFirst({
        where: {
          consumerGroup: group.name,
          topic: 'booking-events',
          region,
        },
        orderBy: { eventId: 'desc' },
      });

      // Query all events after the last processed one
      const unprocessedEvents = await this.prisma.bookingEvent.findMany({
        where: {
          id: { gt: lastProcessedId?.eventId ?? 0 },
          region,
        },
        orderBy: { id: 'asc' },
        take: 10000, // Batch to avoid memory issues
      });

      // Republish to Kafka
      for (const event of unprocessedEvents) {
        await this.kafka.producer().send({
          topic: 'booking-events',
          messages: [{
            key: event.bookingId,
            value: JSON.stringify(event),
            headers: { 'x-replayed': 'true' },
          }],
        });
      }

      this.logger.log(
        `Replayed ${unprocessedEvents.length} events for consumer ${group.name}`,
      );
    }
  }
}
```

> **Why the 'x-replayed' Header?** Consumers must be idempotent -- they must handle receiving the same event twice without creating duplicate side effects. The `x-replayed` header signals to consumers that this event is a replay, not a live event. Some consumers may skip certain actions on replay (e.g., do not re-send a confirmation email for a replayed booking-confirmed event). Designing for replay from day one saves you during recovery.

---

## NestJS Graceful Shutdown and Startup Procedures

When a region fails over, some NestJS application instances die mid-request. Others start cold in the surviving regions. Both transitions must be handled carefully to avoid lost bookings and corrupted state.

### Graceful Shutdown

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /**
   * Graceful shutdown: when Kubernetes sends SIGTERM, the pod
   * has 30 seconds (default terminationGracePeriodSeconds) to
   * finish in-flight requests and clean up before being killed.
   *
   * What "graceful" means for a booking service:
   * 1. Stop accepting NEW requests (remove from load balancer)
   * 2. Finish processing IN-FLIGHT requests (complete or rollback)
   * 3. Close database connections cleanly
   * 4. Flush any buffered metrics or logs
   * 5. Commit or rollback any pending Kafka transactions
   */
  app.enableShutdownHooks();

  const shutdownService = app.get(GracefulShutdownService);
  await shutdownService.register(app);

  await app.listen(3000);
}
bootstrap();

// lifecycle/graceful-shutdown.service.ts
@Injectable()
export class GracefulShutdownService implements OnApplicationShutdown {
  private isShuttingDown = false;
  private inFlightRequests = 0;

  onApplicationShutdown(signal?: string): Promise<void> {
    return new Promise(async (resolve) => {
      this.logger.warn(`Shutdown signal received: ${signal}`);
      this.isShuttingDown = true;

      // Step 1: Mark unhealthy so load balancer stops sending traffic
      this.healthStatus = 'shutting_down';

      // Step 2: Wait for in-flight requests to complete (max 25 seconds)
      const deadline = Date.now() + 25_000;
      while (this.inFlightRequests > 0 && Date.now() < deadline) {
        this.logger.log(
          `Waiting for ${this.inFlightRequests} in-flight requests...`,
        );
        await this.sleep(1000);
      }

      if (this.inFlightRequests > 0) {
        this.logger.error(
          `FORCE SHUTDOWN: ${this.inFlightRequests} requests still in flight`,
        );
        // These requests will fail -- but that is better than the
        // alternative (pod killed with SIGKILL, no cleanup at all)
      }

      // Step 3: Close Kafka producer/consumer connections
      await this.kafkaService.disconnect();

      // Step 4: Close database connections
      await this.prisma.$disconnect();

      // Step 5: Flush metrics buffer
      await this.metricsService.flush();

      this.logger.log('Graceful shutdown complete');
      resolve();
    });
  }

  /**
   * Middleware that tracks in-flight requests and rejects
   * new requests during shutdown.
   */
  @Middleware()
  trackRequests(req: Request, res: Response, next: NextFunction) {
    if (this.isShuttingDown) {
      // Return 503 with Retry-After header so clients retry
      // on a healthy instance
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        error: 'Service is shutting down',
        retryAfter: 5,
      });
      return;
    }

    this.inFlightRequests++;
    res.on('finish', () => {
      this.inFlightRequests--;
    });
    next();
  }
}
```

### Startup Health Gating

```typescript
// lifecycle/startup.service.ts
@Injectable()
export class StartupService implements OnModuleInit {
  /**
   * Startup gating: do NOT accept traffic until all dependencies
   * are verified as reachable.
   *
   * Why this matters: Kubernetes marks a pod as "Ready" based on
   * the readiness probe. If we return healthy before the database
   * connection pool is initialized, the load balancer sends traffic
   * to a pod that cannot serve it. Every request fails.
   *
   * We use a startup probe (Kubernetes 1.18+) that allows the pod
   * extra time to initialize before readiness checks begin.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Starting dependency verification...');

    // Wait for database connection pool
    await this.waitForDependency('MySQL', async () => {
      await this.prisma.$queryRaw`SELECT 1`;
    });

    // Wait for Redis cluster
    await this.waitForDependency('Redis', async () => {
      await this.redis.ping();
    });

    // Wait for Kafka connectivity
    await this.waitForDependency('Kafka', async () => {
      const admin = this.kafka.admin();
      await admin.connect();
      await admin.disconnect();
    });

    // Pre-warm critical caches
    await this.cacheWarmer.warmCriticalCaches();

    this.logger.log('All dependencies verified. Ready to accept traffic.');
    this.isReady = true;
  }

  private async waitForDependency(
    name: string,
    check: () => Promise<void>,
    maxRetries = 30,
    delayMs = 2000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await check();
        this.logger.log(`${name}: connected (attempt ${attempt})`);
        return;
      } catch (error) {
        this.logger.warn(
          `${name}: not ready (attempt ${attempt}/${maxRetries}): ${error.message}`,
        );
        if (attempt === maxRetries) {
          throw new Error(
            `${name} not available after ${maxRetries} attempts. Aborting startup.`,
          );
        }
        await this.sleep(delayMs);
      }
    }
  }
}
```

---

## Prisma Schema for DR Testing and Backup Logging

Disaster recovery operations must be tracked in the database. When did we last run a backup? Did it succeed? When was the last restore test? What was the result? These records are how you prove to auditors, management, and yourself that your DR plan is active and tested.

```prisma
// prisma/schema.prisma (DR-related models)

/// Tracks every backup execution across all shards and types.
/// This is the audit trail that proves backups are running and
/// succeeding. If this table shows a gap, something is broken.
model BackupLog {
  id            String   @id @default(uuid())
  shardId       String   @map("shard_id")
  backupType    String   @map("backup_type")  // 'full', 'incremental', 'differential'
  status        String   // 'started', 'completed', 'failed', 'verified'
  s3Key         String?  @map("s3_key")
  sizeBytes     BigInt?  @map("size_bytes")
  checksum      String?  // SHA-256 of the backup file
  durationMs    Int?     @map("duration_ms")
  errorMessage  String?  @map("error_message") @db.Text
  binlogFile    String?  @map("binlog_file")   // For incremental: start position
  binlogPos     Int?     @map("binlog_pos")
  region        String
  startedAt     DateTime @map("started_at")
  completedAt   DateTime? @map("completed_at")
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([shardId, backupType, startedAt])
  @@index([status, startedAt])
  @@index([region, backupType])
  @@map("backup_logs")
}

/// Records every DR test execution and its results.
/// This is your evidence that the DR plan works. Auditors ask
/// "when did you last test your disaster recovery?" and you
/// point to this table.
model DrTest {
  id              String   @id @default(uuid())
  testType        String   @map("test_type")
  // 'restore-test', 'failover-drill', 'game-day', 'chaos-experiment'
  scenario        String   // Description of what was tested
  status          String   // 'scheduled', 'running', 'passed', 'failed', 'aborted'
  rtoAchievedMs   Int?     @map("rto_achieved_ms")  // Actual recovery time
  rpoAchievedMs   Int?     @map("rpo_achieved_ms")  // Actual data loss window
  rtoTargetMs     Int      @map("rto_target_ms")     // Target recovery time
  rpoTargetMs     Int      @map("rpo_target_ms")     // Target data loss window
  rtoPassed       Boolean? @map("rto_passed")
  rpoPassed       Boolean? @map("rpo_passed")
  participants    String?  @db.Text  // JSON array of team members
  findings        String?  @db.Text  // JSON array of issues found
  actionItems     String?  @map("action_items") @db.Text  // JSON array of follow-ups
  region          String
  scheduledAt     DateTime @map("scheduled_at")
  startedAt       DateTime? @map("started_at")
  completedAt     DateTime? @map("completed_at")
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@index([testType, status])
  @@index([scheduledAt])
  @@index([region, testType])
  @@map("dr_tests")
}

/// Tracks replication lag over time for historical analysis.
/// During a post-incident review, you need to know what the
/// replication lag was at the exact moment of failure to
/// determine how much data was lost.
model ReplicationLagLog {
  id          String   @id @default(uuid())
  shardId     String   @map("shard_id")
  sourceRegion String  @map("source_region")
  targetRegion String  @map("target_region")
  lagMs       Int      @map("lag_ms")
  recordedAt  DateTime @map("recorded_at")

  @@index([shardId, recordedAt])
  @@index([sourceRegion, targetRegion, recordedAt])
  @@map("replication_lag_log")
}

/// Records conflict resolution decisions during active-active
/// replication. Every conflict is logged for audit and review.
model ReplicationConflict {
  id              String   @id @default(uuid())
  tableName       String   @map("table_name")
  recordId        String   @map("record_id")
  localRegion     String   @map("local_region")
  remoteRegion    String   @map("remote_region")
  conflictType    String   @map("conflict_type")
  // 'update-update', 'update-delete', 'insert-insert'
  resolution      String   // 'last-write-wins', 'deletion-wins', 'field-merge', 'manual'
  localValue      String?  @map("local_value") @db.Text
  remoteValue     String?  @map("remote_value") @db.Text
  resolvedValue   String?  @map("resolved_value") @db.Text
  requiresReview  Boolean  @default(false) @map("requires_review")
  reviewedBy      String?  @map("reviewed_by")
  reviewedAt      DateTime? @map("reviewed_at")
  createdAt       DateTime @default(now()) @map("created_at")

  @@index([tableName, recordId])
  @@index([requiresReview, createdAt])
  @@index([conflictType, createdAt])
  @@map("replication_conflicts")
}
```

---

## Production War Story: The Cascading Data Center Failure

> **What happened:** A major hotel booking platform ran its entire operation across two data centers -- a primary in Virginia and a secondary in Oregon. They had a DR plan. They had backups. They had replication. What they did not have was a tested failover process.
>
> On a Friday evening at 6:23 PM ET, an electrical fire in the Virginia data center triggered the fire suppression system. The servers were fine. But the fire suppression system used a halon gas replacement that, when deployed, required all personnel to evacuate. The cooling systems, staffed by on-site technicians, lost human oversight. Within 40 minutes, the server room temperature exceeded safe operating limits and thermal shutdowns cascaded through the racks.
>
> The on-call engineer received the first alert at 6:31 PM. She looked at the Oregon replica: replication lag was 47 seconds. Not the sub-second they expected. They had never monitored replication lag alerting -- the monitoring was configured but the alert threshold was set to 5 minutes, a value left over from initial testing.
>
> At 6:52 PM, they decided to fail over to Oregon. The runbook said "promote the Oregon replica to primary." The DBA ran the promotion script. It failed. The script referenced an IAM role that had been rotated three months earlier. No one had updated the script.
>
> At 7:15 PM, the DBA manually promoted the replica. It worked. But the application configuration in Oregon still pointed to the Virginia database endpoint. The configuration was managed through a service discovery system that itself ran in Virginia.
>
> At 7:38 PM, the team hardcoded the Oregon database IP in the application config and deployed. The applications came up but Redis was empty -- the Oregon Redis cluster had been "cost-optimized" to a single node six months earlier, and that node had been silently failing health checks for two weeks.
>
> At 8:12 PM, after deploying a fresh Redis instance, the booking platform was operational in Oregon. Total downtime: 1 hour and 49 minutes. During that window, approximately 11 million booking attempts were lost. The 47 seconds of replication lag meant 78,000 confirmed bookings existed in the Virginia database but not in Oregon. Those customers had confirmation emails but no actual bookings.
>
> The reconciliation process took two full weeks. The cost: $4.2 million in refunds, $800K in customer support overtime, and an immeasurable amount of trust.
>
> **The lesson is not "disasters happen." The lesson is that every single failure in this story was preventable with testing.** The replication lag alert threshold would have been caught in a game day. The stale IAM credential would have been caught in a monthly failover drill. The cost-optimized Redis would have been caught in chaos testing. The hardcoded service discovery dependency would have been caught in any regional failover test. They had all the infrastructure. They had none of the practice.

---

## Common Mistakes with Disaster Recovery

> **Mistake 1: "We have backups, so we have disaster recovery."**
> Backups are step one. DR is the entire plan: backups, replication, failover, testing, runbooks, communication, and recovery. A backup sitting in S3 does nothing if nobody knows how to restore it, if the restore takes 8 hours, or if the restored data is missing the last 6 hours of transactions. Backups without tested restore procedures are wishful thinking.

> **Mistake 2: "We tested failover once during initial setup."**
> Infrastructure changes every day. Configuration drifts. Credentials rotate. Team members leave and join. A failover test from 18 months ago proves nothing about today's system. DR testing must be continuous -- monthly at minimum, with quarterly full-scale game days.

> **Mistake 3: "Our cloud provider handles DR for us."**
> Your cloud provider guarantees the availability of their infrastructure, not your application. AWS promises that EC2 will be available, not that your booking service running on EC2 will failover correctly. Multi-AZ RDS handles database failover within a region, but you are responsible for cross-region failover, application-level failover, and data consistency.

> **Mistake 4: "We will figure it out when it happens."**
> Improvisation under pressure with millions of dollars on the line and executives watching over your shoulder is not a strategy. DR runbooks exist because human judgment degrades under stress. Steps get skipped. Decisions take too long. Mistakes cascade. A written, tested runbook is the guardrail that keeps the recovery on track.

> **Mistake 5: "RPO of zero is too expensive, so we will just accept data loss."**
> There is a massive difference between accepting 1 second of data loss (a design decision with a known cost) and discovering you actually lose 47 seconds because nobody monitors replication lag. Choosing an RPO is fine. Not monitoring whether you actually achieve it is negligent.

> **Mistake 6: "Our DR site is in the same building as production."**
> A "disaster recovery" site in the same building, same campus, or same city as production is not disaster recovery. It is redundancy for hardware failure, not for building fires, natural disasters, power grid failures, or fiber cuts. DR sites must be geographically separated -- different city at minimum, different region preferred.

> **Mistake 7: "We will fail back to the original region as soon as it recovers."**
> Failing back is more dangerous than failing over. The original region's data is stale. It needs to be reconstructed as a replica, fully synchronized, and validated before receiving any traffic. Rushing to fail back "because it is the primary" has caused more data loss incidents than the original failures they were recovering from.

> **Mistake 8: "Our DR plan is confidential -- only the SRE lead knows it."**
> What happens when the SRE lead is on vacation during the disaster? Or unreachable because the disaster also knocked out their home internet? DR plans must be accessible to every on-call engineer. Multiple people must be trained. The runbook must be self-contained -- no steps that require "ask John, he knows how."

---

## Chapter Summary

| Topic | Key Takeaway |
|---|---|
| RPO (Recovery Point Objective) | How much data you can lose. Our target: < 1 second. Determines backup and replication strategy. |
| RTO (Recovery Time Objective) | How long your system can be down. Our target: < 5 minutes. Determines failover strategy. |
| Full Backups | Complete database snapshot. Slow but simple to restore. Foundation of backup strategy. Weekly. |
| Incremental Backups | Only changes since last backup. Fast but chain-dependent. Use for binary log capture. Hourly. |
| Differential Backups | All changes since last full. No chain risk, moderate size. Daily. |
| Active-Passive Replication | One region writes, other reads. Simple but has failover delay and single write region. |
| Active-Active Replication | All regions write. Eliminates write bottleneck but requires conflict resolution. Our choice. |
| DNS Failover | Route 53 health checks remove unhealthy regions in ~30 seconds. Outermost failover layer. |
| Database Promotion | Promoting replica to primary. One-way operation. Must fence old primary to prevent split-brain. |
| Degraded Mode | Serve cached reads, queue writes. Honest degradation beats silent failure during disasters. |
| Game Day Exercises | Scheduled disaster simulations. Test the full DR plan quarterly. Find gaps before real disasters do. |
| Chaos Engineering | Continuous random failure injection in production. Build confidence that auto-recovery works. |
| Backup Verification | Automated weekly restore tests. The only proof that backups are valid and restorable. |
| DR Runbook | Step-by-step checklist for disaster response. Written for 3 AM engineers under stress. |
| Redis Recovery | Deploy fresh cluster, restore RDB snapshot, rebuild critical data, warm caches gradually. |
| Kafka Recovery | Deploy fresh cluster, recreate topics, replay events from database source of truth. |
| Graceful Shutdown | Stop accepting requests, finish in-flight work, close connections cleanly. 25-second budget. |
| Startup Gating | Verify all dependencies before accepting traffic. Prevents serving errors from cold pods. |
| DR Logging (Prisma) | backup_logs: audit trail for every backup. dr_tests: evidence that DR is tested. |

> **What Comes Next:** In Chapter 35, we move from surviving disasters to preventing performance degradation. We will explore capacity planning -- how to predict when your system will hit its limits, how to model growth trajectories, and how to plan infrastructure investments before you need them. Because the best disaster recovery is the one you never have to use.
