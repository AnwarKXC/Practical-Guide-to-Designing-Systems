# Chapter 33: Incident Response — When Things Go Wrong at 3 AM

## A Story

It is 3:07 AM on a Tuesday. Your phone buzzes on the nightstand — not once, but three times in rapid succession. You fumble for it, squinting at the screen through sleep-crusted eyes. The PagerDuty notification reads:

> **CRITICAL: BookingSuccessRateCritical — Booking success rate below 95%. Firing for 3 minutes. Affected: booking-service, us-east-1.**

Your heart rate jumps from resting to racing. You are the on-call engineer this week. At 100,000 bookings per minute, a 5% failure rate means **5,000 failed bookings every minute** you lie in bed. Each failed booking is a customer — a family trying to book a vacation, a business traveler needing a hotel for tomorrow, someone on the other side of the world trying to confirm a flight. Real money. Real frustration. And the clock is ticking.

What do you do?

If you have never been in this situation, your instinct might be: "I will figure it out." You SSH into a server, stare at logs scrolling past, try things. Maybe restart something. Maybe run a query against production. That approach works for a side project with twelve users. For a production system handling real money and real customers across six continents, it is chaos. You waste seven minutes deciding what to check first. You forget to tell anyone what is happening. Your manager wakes up to a flood of customer complaints with no context. You accidentally make things worse because you are half asleep and typing commands from muscle memory that worked last time but not this time.

Incident response is not about heroics. The 10x engineer is not the one who single-handedly debugs a catastrophic failure at 3 AM through sheer brilliance. It is the engineer who **follows the playbook**, coordinates with the team, communicates clearly, and gets the system stable — even with sleep-deprived judgment, even when the adrenaline is telling them to skip steps.

This chapter is about building that playbook. We will cover how to classify incidents, who responds and when, how to run a war room, how to communicate during the chaos, how to write postmortems that actually prevent recurrence, and how to build tooling that automates the grind. By the end, a 3 AM page will not be a panic — it will be a procedure.

---

## 33.1 Severity Levels: Not All Fires Are the Same

The first thing you do when an alert fires is determine how bad it is. Not every incident is a "wake the CEO" situation. A missing dashboard panel and a complete booking outage require fundamentally different responses. Treating them the same wastes people's time on minor issues and under-resources critical ones.

Our Global Booking System defines four severity levels, SEV1 through SEV4. We use the "SEV" naming convention because it is the industry standard at companies like Google, Meta, and Stripe. Some teams use P0-P3. The mapping is straightforward: SEV1 equals P0, SEV2 equals P1, and so on. Use whichever naming your organization adopts, but be consistent.

```typescript
// src/incident/severity.config.ts

export enum Severity {
  SEV1 = 'SEV1',
  SEV2 = 'SEV2',
  SEV3 = 'SEV3',
  SEV4 = 'SEV4',
}

export interface SeverityConfig {
  level: Severity;
  description: string;
  examples: string[];
  responseTime: string;
  acknowledgementWindow: string;
  notifyChannels: string[];
  teamRequired: string[];
  updateFrequency: string;
  customerCommsRequired: boolean;
  executiveNotification: boolean;
  autoEscalationAfter: string;
}

export const SEVERITY_DEFINITIONS: Record<Severity, SeverityConfig> = {
  [Severity.SEV1]: {
    level: Severity.SEV1,
    description: 'Complete service outage, data loss, or security breach',
    examples: [
      'All bookings failing globally (0% success rate)',
      'Database corruption — confirmed data loss',
      'Payment system double-charging customers',
      'Security breach — unauthorized data access',
      'Complete loss of a production database cluster',
    ],
    responseTime: '5 minutes',
    acknowledgementWindow: '2 minutes',
    notifyChannels: ['PagerDuty (phone call)', 'SMS', '#incident-war-room', '#executive-alerts'],
    teamRequired: [
      'Primary on-call engineer',
      'Secondary on-call engineer',
      'Incident Commander (Engineering Manager rotation)',
      'VP of Engineering',
      'Customer Support Lead',
    ],
    updateFrequency: 'Every 15 minutes',
    customerCommsRequired: true,
    executiveNotification: true,
    autoEscalationAfter: '5 minutes without acknowledgement',
  },

  [Severity.SEV2]: {
    level: Severity.SEV2,
    description: 'Major feature degradation affecting >10% of users',
    examples: [
      'One region completely down (US-East offline, others healthy)',
      'Primary payment provider failing (Stripe down, PayPal backup working)',
      'Search returning errors for one booking type (flights broken, hotels fine)',
      'Booking confirmation emails not sending',
      'Authentication service degraded — 30% of logins failing',
    ],
    responseTime: '15 minutes',
    acknowledgementWindow: '5 minutes',
    notifyChannels: ['PagerDuty (push notification)', '#incident-active', '#engineering'],
    teamRequired: [
      'Primary on-call engineer',
      'Incident Commander (senior engineer rotation)',
      'Owning team lead',
    ],
    updateFrequency: 'Every 30 minutes',
    customerCommsRequired: true,
    executiveNotification: false,
    autoEscalationAfter: '15 minutes without acknowledgement',
  },

  [Severity.SEV3]: {
    level: Severity.SEV3,
    description: 'Minor feature degradation affecting <10% of users',
    examples: [
      'Elevated error rates (1-3%) on one service',
      'P95 latency doubled but still under SLA',
      'One database shard degraded (affecting ~6% of users)',
      'Email confirmations delayed by 15 minutes',
      'Mobile app push notifications intermittent',
    ],
    responseTime: '1 hour',
    acknowledgementWindow: '30 minutes',
    notifyChannels: ['PagerDuty (push notification)', '#incident-active'],
    teamRequired: ['Primary on-call engineer'],
    updateFrequency: 'Every 2 hours',
    customerCommsRequired: false,
    executiveNotification: false,
    autoEscalationAfter: '1 hour without acknowledgement',
  },

  [Severity.SEV4]: {
    level: Severity.SEV4,
    description: 'Minor issue with workaround, or non-customer-facing problem',
    examples: [
      'Monitoring dashboard missing a panel',
      'Non-critical alert firing spuriously',
      'Log aggregator pipeline 30 minutes behind',
      'Internal admin tool slow but functional',
      'Non-production environment issue',
    ],
    responseTime: 'Next business day',
    acknowledgementWindow: '4 hours',
    notifyChannels: ['#platform-alerts', '#engineering'],
    teamRequired: ['Assigned engineer (during business hours)'],
    updateFrequency: 'Daily standup',
    customerCommsRequired: false,
    executiveNotification: false,
    autoEscalationAfter: '24 hours without acknowledgement',
  },
};
```

Let us walk through each level in detail.

### SEV1 — Total Outage: The Building Is on Fire

**SEV1 is the nuclear option.** The entire system is down, or data is being corrupted, or customers are being actively harmed — double-charged, their personal data exposed, their confirmed bookings lost. This is the "all hands on deck, cancel your evening plans" scenario.

The on-call engineer must **acknowledge within 2 minutes** and begin investigating within 5. The Incident Commander — a rotating role among engineering managers — is paged by phone call, not Slack. The VP of Engineering is notified. Customer support is looped in because the complaints are already rolling in.

Status updates go out every 15 minutes, even if the update is "still investigating, no new information." Silence during a SEV1 is terrifying to everyone watching the channel. An update that says "still working on it" is infinitely better than no update at all.

Real examples from production systems: the primary PostgreSQL cluster crashed and all bookings return 500 errors; a bad migration dropped a column that the payment service depends on; a misconfigured rate limiter is rejecting 100% of traffic from the API gateway; a dependency (Stripe, AWS) is experiencing a major outage that cascades to your system.

### SEV2 — Major Degradation: One Limb Is Broken

A significant part of the system is not working, but it is not everything. More than 10% of users are affected, but the system is not completely down. There is some partial functionality — maybe other regions are fine, maybe a backup payment provider is handling load.

The on-call engineer must respond within 15 minutes. The Incident Commander joins (at SEV2, this is a senior engineer from the on-call rotation, not a manager). The owning team's lead is notified in case domain expertise is needed.

Real examples: all bookings in US-East are failing because an availability zone is down, but Europe and Asia-Pacific are handling traffic; the Stripe integration is returning errors, but PayPal failover is processing 70% of payments; search is returning empty results for flights, but hotel and car rental search work fine.

### SEV3 — Minor Degradation: A Bruise

Something is off, but the vast majority of users are unaffected or experiencing only minor impact. Error rates are elevated but below 10%. Latencies are higher than normal but within SLA boundaries. One component is degraded but the system is self-healing or the impact is contained.

The on-call engineer handles this alone, with a 1-hour response window. No need to wake up additional people. Updates go to the incident channel every 2 hours.

Real examples: one out of sixteen database shards is running slow, affecting 6% of bookings with elevated latency; payment confirmation webhooks are delayed by 10 minutes but eventually processing; a canary deployment is showing elevated errors but the canary only receives 2% of traffic.

### SEV4 — Minor Issue: A Paper Cut

There is a known issue, but there is a workaround and no customer is actively suffering. Handle it during normal working hours. Create a ticket, assign it, fix it in the next sprint.

Real examples: a Grafana dashboard is missing a panel that was accidentally deleted during a refactor; a log shipping pipeline is 30 minutes behind, meaning recent logs are not yet searchable; an internal admin dashboard loads slowly; a non-critical alert is firing every hour because the threshold needs tuning.

### How to Assign Severity: The Decision Tree

Back to our 3 AM scenario. The alert says booking success rate dropped below 95%. Is that a SEV1 or a SEV2?

Do not guess. Walk the decision tree:

```
                    Is there confirmed data loss,
                  security breach, or financial harm?
                         /              \
                       YES               NO
                        |                 |
                      SEV1         Are ALL bookings failing
                                   (complete outage)?
                                      /         \
                                    YES          NO
                                     |            |
                                   SEV1    Are >10% of users
                                           affected?
                                             /       \
                                           YES        NO
                                            |          |
                                          SEV2    Is the issue
                                                  customer-facing?
                                                    /       \
                                                  YES        NO
                                                   |          |
                                                 SEV3       SEV4
```

In our scenario: the success rate is 95%, meaning 5% of bookings are failing. That is more than 10% of... wait. Five percent failure rate means 5% of *bookings* are failing, not 5% of *users*. But each failing user will retry, and many users attempt multiple bookings. The user impact is probably larger than 5%. Additionally, at 100,000 bookings per minute, 5% means 5,000 failures per minute — that is significant revenue impact.

This is a **SEV2**. Major degradation, significant user impact, but not a total outage. If the rate drops further — below 80% — you escalate to SEV1.

> **Key Term:** **Severity level** — A classification assigned to an incident that determines the response urgency, team composition, communication cadence, and escalation path. Severity is not static: it can be escalated or de-escalated as the situation evolves.

The critical insight: **severity is not permanent**. You assign an initial severity based on available information, then adjust as you learn more. A SEV3 that you discover is actually affecting 25% of users gets escalated to SEV2. A SEV1 that turns out to be a monitoring false alarm gets downgraded to SEV4. Document every severity change in the incident timeline.

> **Analogy:** Think of incident response like a hospital emergency room. When a patient arrives, the first thing that happens is triage — a nurse assesses severity. A cardiac arrest (SEV1) gets the entire trauma team immediately. An open fracture (SEV2) gets seen within minutes by an available surgeon. A sprained ankle (SEV3) waits an hour. A mild headache (SEV4) is directed to schedule a regular appointment. The ER does not treat every patient the same way — and neither should your incident response. The severity determines the speed, the team size, and the communication cadence.

---

## 33.2 On-Call Rotation: Who Gets Paged and When

Having severity levels is useless if there is nobody to respond. The on-call rotation is the backbone of incident response. It answers a single question: **at any moment, day or night, who is responsible for responding to production alerts?**

### Designing the Rotation Schedule

A healthy on-call rotation has these properties:

1. **At least two tiers.** The primary on-call is the first responder. If they do not acknowledge within the escalation window, the secondary on-call is paged automatically. If neither responds, the engineering manager is paged.

2. **One-week rotations.** Shorter rotations (like daily) create too much context-switching. Longer rotations (like monthly) cause burnout. One week strikes the balance: long enough to develop a rhythm, short enough that the burden is shared.

3. **Minimum team size of five.** With five engineers in the rotation, each person is on-call for one week out of five — once per month. Fewer than five people makes the rotation unsustainable. If your team has three engineers, merge rotations with another team or hire.

4. **Follow-the-sun for global teams.** If you have engineers in New York, London, and Singapore, each covers roughly eight hours. Nobody gets woken up at 3 AM because someone in another timezone is awake and handling it.

```typescript
// src/incident/oncall-rotation.config.ts

export interface OnCallSchedule {
  teamName: string;
  rotationType: 'weekly' | 'daily' | 'follow-the-sun';
  rotationLength: string;
  members: OnCallMember[];
  escalationPolicy: EscalationTier[];
  handoffDay: string;
  handoffTime: string;
  handoffTimezone: string;
  overridePolicy: string;
}

export interface OnCallMember {
  name: string;
  email: string;
  phone: string;
  timezone: string;
  slackId: string;
  pagerDutyId: string;
  maxConsecutiveWeeks: number;
}

export interface EscalationTier {
  tier: number;
  role: string;
  contactMethod: string;
  escalateAfter: string;
}

export const BOOKING_TEAM_ONCALL: OnCallSchedule = {
  teamName: 'Booking Platform',
  rotationType: 'weekly',
  rotationLength: '7 days',
  members: [
    {
      name: 'Alice Chen',
      email: 'alice@company.com',
      phone: '+1-555-0101',
      timezone: 'America/New_York',
      slackId: 'U01ABC123',
      pagerDutyId: 'PALICE',
      maxConsecutiveWeeks: 2,
    },
    {
      name: 'Bob Kumar',
      email: 'bob@company.com',
      phone: '+1-555-0102',
      timezone: 'America/Chicago',
      slackId: 'U01DEF456',
      pagerDutyId: 'PBOB',
      maxConsecutiveWeeks: 2,
    },
    {
      name: 'Carla Reyes',
      email: 'carla@company.com',
      phone: '+44-20-5550103',
      timezone: 'Europe/London',
      slackId: 'U01GHI789',
      pagerDutyId: 'PCARLA',
      maxConsecutiveWeeks: 2,
    },
    {
      name: 'David Park',
      email: 'david@company.com',
      phone: '+65-5550104',
      timezone: 'Asia/Singapore',
      slackId: 'U01JKL012',
      pagerDutyId: 'PDAVID',
      maxConsecutiveWeeks: 2,
    },
    {
      name: 'Elena Volkov',
      email: 'elena@company.com',
      phone: '+1-555-0105',
      timezone: 'America/Los_Angeles',
      slackId: 'U01MNO345',
      pagerDutyId: 'PELENA',
      maxConsecutiveWeeks: 2,
    },
  ],

  escalationPolicy: [
    {
      tier: 1,
      role: 'Primary On-Call Engineer',
      contactMethod: 'PagerDuty push + SMS',
      escalateAfter: '5 minutes without acknowledgement',
    },
    {
      tier: 2,
      role: 'Secondary On-Call Engineer',
      contactMethod: 'PagerDuty phone call',
      escalateAfter: '10 minutes without acknowledgement',
    },
    {
      tier: 3,
      role: 'Engineering Manager',
      contactMethod: 'Phone call + SMS',
      escalateAfter: '15 minutes without acknowledgement',
    },
    {
      tier: 4,
      role: 'VP of Engineering',
      contactMethod: 'Phone call',
      escalateAfter: '20 minutes without acknowledgement',
    },
  ],

  handoffDay: 'Monday',
  handoffTime: '10:00',
  handoffTimezone: 'America/New_York',
  overridePolicy: 'Swap via PagerDuty at least 24 hours in advance. '
    + 'Both engineers must confirm. Manager approval needed '
    + 'for same-day swaps.',
};
```

### The Handoff: Monday at 10 AM

A sloppy handoff is where incidents fall through the cracks. Every Monday at 10 AM Eastern, the outgoing on-call engineer meets with the incoming engineer for a 15-minute handoff. This is not optional. This is not an email. It is a synchronous conversation, over video call or in person, covering:

1. **Active issues.** Are there any ongoing incidents, even minor ones? Any alerts that are flapping? Any servers in a degraded state?
2. **Recent changes.** What was deployed last week? Any configuration changes, infrastructure updates, or database migrations that might cause delayed effects?
3. **Known risks.** Is a big customer doing a load test this week? Is there a planned marketing campaign that might spike traffic? Is a cloud provider maintenance window scheduled?
4. **Alert status.** Are there any alerts that are silenced? Any that need threshold tuning? Any new alerts that were added?
5. **Runbook updates.** Were any runbooks updated or found to be insufficient during the previous rotation?

```typescript
// src/incident/handoff.template.ts

export interface OnCallHandoff {
  outgoingEngineer: string;
  incomingEngineer: string;
  handoffDate: string;
  activeIncidents: ActiveIncident[];
  recentDeployments: Deployment[];
  knownRisks: string[];
  silencedAlerts: SilencedAlert[];
  runbookUpdates: string[];
  additionalNotes: string;
}

export const HANDOFF_TEMPLATE: OnCallHandoff = {
  outgoingEngineer: 'Alice Chen',
  incomingEngineer: 'Bob Kumar',
  handoffDate: '2025-01-20T10:00:00-05:00',
  activeIncidents: [
    {
      id: 'INC-4502',
      severity: 'SEV4',
      title: 'Grafana booking dashboard missing latency panel',
      status: 'open',
      notes: 'Ticket BK-1234 created. Low priority, fix this week.',
    },
  ],
  recentDeployments: [
    {
      service: 'booking-service',
      version: 'v2.14.3',
      deployedAt: '2025-01-17T14:30:00Z',
      deployedBy: 'CI/CD (merged by Carla)',
      notes: 'Added circuit breaker to inventory calls. Monitor for behavior changes.',
    },
    {
      service: 'payment-service',
      version: 'v3.8.1',
      deployedAt: '2025-01-16T09:15:00Z',
      deployedBy: 'CI/CD (merged by Alice)',
      notes: 'Upgraded Stripe SDK. No issues observed.',
    },
  ],
  knownRisks: [
    'AWS us-east-1 maintenance window Wednesday 02:00-06:00 UTC',
    'Marketing campaign launching Thursday — expect 2x normal traffic',
    'Payment provider switching from v2 to v3 API next week — feature flag ready',
  ],
  silencedAlerts: [
    {
      alertName: 'KafkaConsumerLagHigh',
      reason: 'Known issue with analytics consumer. Being addressed in BK-1198.',
      silencedUntil: '2025-01-22T00:00:00Z',
    },
  ],
  runbookUpdates: [
    'Updated "Database Failover" runbook — added step for verifying replication lag before promoting replica',
  ],
  additionalNotes: 'Quiet week overall. One SEV3 on Tuesday (shard 7 slow queries) '
    + 'resolved by adding an index. Postmortem written.',
};
```

> **What If You Skip This?** Without structured handoffs, the incoming on-call engineer starts their week blind. They do not know about the deployment that happened Friday afternoon that might cause Monday morning issues. They do not know about the silenced alert that is masking a real problem. They do not know that a marketing campaign is about to triple traffic on Thursday. When the alert fires, they waste twenty minutes building the context that a five-minute handoff would have provided.

### Escalation: When You Need Help

The escalation policy is not about punishment — it is about getting the right people involved at the right time. If the primary on-call does not acknowledge within five minutes, paging the secondary is not a judgment on the primary. Maybe their phone died. Maybe they are in a subway tunnel. Maybe they are dealing with a family emergency. The escalation policy ensures that **no alert goes unacknowledged**, regardless of individual circumstances.

```
Time 0:00  — Alert fires → Primary on-call paged (push + SMS)
Time 0:05  — No ACK      → Secondary on-call paged (phone call)
Time 0:10  — No ACK      → Engineering Manager paged (phone call + SMS)
Time 0:15  — No ACK      → VP Engineering paged (phone call)
Time 0:20  — No ACK      → CTO paged (phone call) — this should NEVER happen
```

If the escalation reaches the CTO, something is deeply wrong with your process, not just with the incident. It means four people in a row failed to respond. That is a systemic problem that needs its own postmortem.

> **Checkpoint:** You are the primary on-call engineer. Your phone buzzes with a SEV2 alert at 2:30 AM. You see the notification, but you are feeling sick and cannot respond effectively. What do you do? Answer: you acknowledge the alert immediately (to stop escalation), then contact the secondary on-call engineer and ask them to take over. You do NOT ignore the alert and let it escalate silently. Communication, even to say "I need someone else to handle this," is always the right first step.

---

## 33.3 The Incident Commander: Coordination, Not Heroics

When a SEV1 or SEV2 fires, multiple engineers join the response. Someone is looking at database metrics. Someone is checking recent deployments. Someone is tailing logs. Without coordination, you get three engineers silently investigating the same thing while nobody checks the most obvious cause.

The **Incident Commander** (IC) solves this. The IC does not debug. The IC does not write code. The IC does not SSH into servers. The IC **coordinates**. They are the air traffic controller in a busy airport — they do not fly the planes, but without them, planes crash into each other.

### What the Incident Commander Does

```typescript
// src/incident/incident-commander.ts

export interface IncidentCommanderResponsibilities {
  phase: string;
  actions: string[];
}

export const IC_RESPONSIBILITIES: IncidentCommanderResponsibilities[] = [
  {
    phase: 'First 5 Minutes',
    actions: [
      'Acknowledge the page and join the war room channel',
      'Confirm incident severity based on available data',
      'Ensure the right people are paged (check escalation policy)',
      'Create the incident channel: #inc-YYYY-MM-DD-short-description',
      'Post the first status update: what we know, what we do not know',
      'Assign roles: who is investigating what',
    ],
  },
  {
    phase: 'During the Incident',
    actions: [
      'Keep the timeline updated in the incident channel',
      'Ensure no two people are investigating the same thing',
      'Make go/no-go decisions on mitigation actions (rollback, failover)',
      'Post status updates at the defined cadence (every 15 min for SEV1)',
      'Shield investigators from interruptions (redirect questions)',
      'Escalate severity if the situation is worse than initially assessed',
      'Coordinate with Customer Support for external communications',
    ],
  },
  {
    phase: 'After Mitigation',
    actions: [
      'Confirm the system is stable and metrics have recovered',
      'Decide whether to continue investigating root cause now or defer',
      'Post the "all clear" message with a summary of what happened',
      'Schedule the postmortem within 48 hours',
      'Ensure the incident record is complete: timeline, actions, outcomes',
      'Thank everyone involved — recognition matters at 4 AM',
    ],
  },
];
```

### The IC Is Not the Most Senior Person

A common mistake: the most senior engineer in the room takes over because everyone defers to them. This is wrong. The IC should be the person **trained in incident coordination**, not the person with the most years of experience. A senior principal engineer is more valuable debugging the database than coordinating Slack threads.

At our Global Booking System, the IC rotation is separate from the on-call engineering rotation. Engineering managers and senior engineers rotate through IC duty on a weekly basis. Every IC has completed a training exercise — a "game day" simulation where they practice coordinating a mock SEV1.

```typescript
// src/incident/ic-rotation.config.ts

export interface ICRotation {
  rotationName: string;
  eligibleRoles: string[];
  trainingRequired: string[];
  rotationLength: string;
  currentIC: string;
  backupIC: string;
}

export const IC_ROTATION_CONFIG: ICRotation = {
  rotationName: 'Incident Commander Rotation',
  eligibleRoles: ['Engineering Manager', 'Staff Engineer', 'Senior Engineer (IC-trained)'],
  trainingRequired: [
    'Completed IC training workshop (4 hours)',
    'Shadowed at least 2 real incidents as IC-in-training',
    'Led at least 1 game day exercise as IC',
    'Reviewed 5 past postmortems and can explain lessons learned',
  ],
  rotationLength: '1 week',
  currentIC: 'Marcus Johnson (Engineering Manager, Platform)',
  backupIC: 'Priya Sharma (Staff Engineer, Booking)',
};
```

> **Analogy:** Think of the Incident Commander like a film director. The director does not operate the camera, does not act, does not hold the boom mic. But without the director, you have talented people working at cross purposes, and the result is chaos. The IC's job is to ensure that every person's effort is directed toward the same goal — restoring service.

### IC Communication Pattern: The Cadence Update

Every 15 minutes during a SEV1 (30 minutes for SEV2), the IC posts a structured update. This is not free-form. It follows a template:

```markdown
## Incident Update — INC-2025-0120-booking-failures
**Time:** 2025-01-20 03:45 UTC
**Severity:** SEV2
**Status:** Investigating
**IC:** Marcus Johnson
**Duration:** 38 minutes

### What We Know
- Booking success rate dropped to 91% at 03:07 UTC
- Root cause identified: connection pool exhaustion on booking-db-primary
- The pool is configured for 100 connections; current usage is 100/100
- Long-running queries from the analytics batch job are holding connections

### What We Are Doing
- Alice is killing the analytics batch job queries (ETA: 2 minutes)
- Bob is preparing a connection pool increase from 100 to 200 as a safety measure
- Carla is verifying that no data corruption occurred during the degradation

### Customer Impact
- ~9% of booking attempts are failing with timeout errors
- Affected users see "Something went wrong, please try again" message
- Retries are succeeding for most users on second attempt

### Next Update
- 04:00 UTC or sooner if status changes
```

This template is not bureaucracy — it is **survival communication**. Everyone watching the channel knows exactly what is happening without interrupting the people doing the work. The VP of Engineering can read the update and decide whether to escalate further. Customer Support can draft external communications based on the impact section. The product manager who just woke up can understand the situation in thirty seconds.

---

## 33.4 Communication During Incidents: Templates That Save Time

At 3 AM, you do not want to compose prose. You want templates. Every minute you spend wordsmithing a status update is a minute you are not fixing the problem.

### Internal Communication: Slack Templates

```typescript
// src/incident/communication-templates.ts

export const INCIDENT_TEMPLATES = {
  declaration: `
:rotating_light: **INCIDENT DECLARED**
**ID:** {incidentId}
**Severity:** {severity}
**Title:** {title}
**IC:** {incidentCommander}
**Channel:** {channelName}
**Time:** {timestamp}

**Initial Assessment:**
{initialAssessment}

**Who is needed:**
{requiredPersonnel}

All updates will be posted in {channelName}. Please do not DM investigators directly.
  `,

  statusUpdate: `
**Incident Update — {incidentId}**
**Time:** {timestamp} | **Severity:** {severity} | **Status:** {status} | **Duration:** {duration}

**What changed since last update:**
{changesSinceLastUpdate}

**Current actions:**
{currentActions}

**Customer impact:**
{customerImpact}

**Next update:** {nextUpdateTime}
  `,

  mitigated: `
:large_green_circle: **INCIDENT MITIGATED — {incidentId}**
**Time:** {timestamp}
**Duration:** {totalDuration}
**Severity:** {severity}

**What happened:**
{summary}

**How it was mitigated:**
{mitigationSteps}

**Remaining work:**
{remainingWork}

**Postmortem scheduled:** {postmortemDate}

The system is stable. On-call engineer will continue monitoring for the next 2 hours.
  `,

  resolved: `
:white_check_mark: **INCIDENT RESOLVED — {incidentId}**
**Time:** {timestamp}
**Total Duration:** {totalDuration}

**Root Cause:** {rootCause}
**Permanent Fix:** {permanentFix}

Postmortem document: {postmortemLink}
Thank you to everyone who responded.
  `,
};
```

### External Communication: Status Page Updates

Your customers should never learn about an outage from Twitter before your status page. The status page is your contract with users — it says "we know, we are working on it, here is what to expect."

```typescript
// src/incident/status-page.templates.ts

export const STATUS_PAGE_TEMPLATES = {
  investigating: {
    title: 'Investigating Booking Issues',
    body: 'We are currently investigating reports of booking failures '
      + 'affecting some users. Our engineering team has been engaged '
      + 'and is actively working to identify and resolve the issue. '
      + 'We will provide an update within {nextUpdateMinutes} minutes.',
    components: [
      { name: 'Booking Service', status: 'degraded_performance' },
    ],
  },

  identified: {
    title: 'Booking Issue Identified',
    body: 'We have identified the cause of the booking failures. '
      + '{rootCauseSummary}. Our team is implementing a fix. '
      + 'We expect the issue to be resolved within {etaMinutes} minutes. '
      + 'Bookings made through {workaround} are not affected.',
    components: [
      { name: 'Booking Service', status: 'partial_outage' },
    ],
  },

  monitoring: {
    title: 'Fix Implemented — Monitoring',
    body: 'A fix has been implemented for the booking issues. '
      + 'We are monitoring the system to ensure stability. '
      + 'If you continue to experience issues, please contact '
      + 'support@company.com. We apologize for the inconvenience.',
    components: [
      { name: 'Booking Service', status: 'degraded_performance' },
    ],
  },

  resolved: {
    title: 'Booking Issues Resolved',
    body: 'The booking issues reported earlier today have been fully resolved. '
      + 'All systems are operating normally. The incident lasted {duration}. '
      + '{affectedBookingsNote}. '
      + 'We will publish a detailed postmortem within 48 hours.',
    components: [
      { name: 'Booking Service', status: 'operational' },
    ],
  },
};
```

### Stakeholder Notification Matrix

Different people need different information at different times. Do not blast the same message to everyone.

```
Stakeholder            | When to Notify        | What They Need to Know           | Channel
-----------------------|-----------------------|----------------------------------|------------------
On-call engineer       | Immediately           | Full technical details            | PagerDuty + Slack
Incident Commander     | SEV1/SEV2 immediately | Severity, initial assessment      | PagerDuty phone
Engineering team       | Within 5 min          | Incident declared, channel link   | #engineering Slack
Customer Support       | Within 10 min         | Customer impact, talking points   | #cs-incidents Slack
Product Manager        | Within 15 min         | Business impact, ETA              | Slack DM
VP Engineering         | SEV1 only             | Summary, business impact          | Phone call + SMS
Executive team         | SEV1 > 30 min         | Business impact, customer comms   | Email + SMS
Customers              | SEV1/SEV2 confirmed   | Status page update, ETA           | Status page + email
Partner integrations   | If API affected       | Technical impact, workarounds     | Partner Slack/email
```

> **What If You Skip This?** Without a communication matrix, one of two things happens. Either nobody communicates (customer support gets blindsided by angry customers with zero context) or everybody communicates (the IC spends more time answering Slack DMs than coordinating the response). Both are failures. The matrix ensures the right person gets the right information at the right time through the right channel.

---

## 33.5 The Incident Timeline: From Detection to Postmortem

Every incident follows a lifecycle. Understanding this lifecycle helps you recognize where you are and what to do next.

```
Detection → Triage → Mitigation → Resolution → Postmortem
   |           |          |             |             |
 Alert     Assess      Stop the     Fix the root   Learn and
 fires     severity    bleeding     cause fully    prevent
           and scope                               recurrence
```

### Phase 1: Detection (Time 0)

Something triggered an alert. It might be automatic (a Prometheus alerting rule, a synthetic monitor, a customer-facing error rate threshold) or manual (a customer complaint, an engineer noticing something odd in dashboards).

**Goal:** Ensure the right alert reaches the right person.

**Time target:** Automatic detection should fire within 2 minutes of the problem starting. If your detection takes longer than 5 minutes, your monitoring has gaps.

### Phase 2: Triage (Minutes 0-10)

The on-call engineer assesses the situation. What is the severity? What is affected? Who needs to be paged? Is this a genuine incident or a false alarm?

**Goal:** Assign severity, page the right people, create the incident channel.

**Time target:** Triage should complete within 10 minutes of the alert. If you are still trying to figure out whether this is real after 15 minutes, escalate — you need more eyes.

```typescript
// src/incident/triage-checklist.ts

export const TRIAGE_CHECKLIST = [
  {
    step: 1,
    action: 'Acknowledge the alert in PagerDuty',
    why: 'Stops the escalation timer and signals you are responding',
    timeLimit: '2 minutes',
  },
  {
    step: 2,
    action: 'Open the monitoring dashboards (Grafana booking overview)',
    why: 'Get a visual picture of what is happening across all services',
    timeLimit: '1 minute',
  },
  {
    step: 3,
    action: 'Check: Is this a real incident or a monitoring false alarm?',
    why: 'Compare multiple data sources — metrics, logs, synthetic checks',
    timeLimit: '3 minutes',
  },
  {
    step: 4,
    action: 'Assign severity using the decision tree (Section 33.1)',
    why: 'Severity determines who gets paged and response cadence',
    timeLimit: '1 minute',
  },
  {
    step: 5,
    action: 'Create incident channel and post declaration message',
    why: 'Central place for all communication during this incident',
    timeLimit: '2 minutes',
  },
  {
    step: 6,
    action: 'Page the Incident Commander if SEV1 or SEV2',
    why: 'IC coordinates response so you can focus on investigation',
    timeLimit: '1 minute',
  },
];
```

### Phase 3: Mitigation (Minutes 10-60+)

This is where you **stop the bleeding**. Mitigation is not about finding root cause — it is about reducing customer impact as fast as possible. The difference between mitigation and resolution is critical:

- **Mitigation:** "We rolled back the bad deployment and bookings are succeeding again."
- **Resolution:** "We found the bug in the database query, wrote a fix, added a test, and deployed the corrected version."

Mitigation comes first. Always. You can spend three hours finding the elegant root cause fix, or you can roll back in two minutes and stop 5,000 bookings per minute from failing. Roll back first. Debug later.

```typescript
// src/incident/mitigation-strategies.ts

export const MITIGATION_PLAYBOOK = {
  'deployment-related': {
    description: 'Issue started shortly after a deployment',
    steps: [
      'Confirm timing: did the issue start within 30 minutes of a deploy?',
      'Check the deployment diff: what changed?',
      'Roll back to the previous known-good version',
      'Verify metrics recover after rollback',
      'If metrics do not recover, the deploy was not the cause — continue investigating',
    ],
    estimatedTime: '5-10 minutes',
  },

  'database-related': {
    description: 'Database is slow, unreachable, or returning errors',
    steps: [
      'Check database connection pool utilization',
      'Look for long-running queries (pg_stat_activity)',
      'Check replication lag on read replicas',
      'If connection pool exhausted: kill long-running queries, increase pool size',
      'If primary is down: initiate failover to standby (follow DB failover runbook)',
      'If replication lag > 30s: redirect reads to primary temporarily',
    ],
    estimatedTime: '5-30 minutes',
  },

  'dependency-outage': {
    description: 'External dependency (Stripe, AWS, etc.) is down',
    steps: [
      'Confirm on the dependency status page (status.stripe.com, etc.)',
      'Activate fallback/backup provider if available',
      'Enable circuit breaker to fail fast instead of timing out',
      'If no fallback: queue requests for retry when dependency recovers',
      'Notify customers that the specific feature is temporarily unavailable',
    ],
    estimatedTime: '5-15 minutes',
  },

  'traffic-spike': {
    description: 'Unexpected traffic surge overwhelming the system',
    steps: [
      'Confirm traffic is legitimate (not a DDoS attack)',
      'Scale up auto-scaling group immediately (set desired count higher)',
      'Enable rate limiting on non-critical endpoints',
      'Activate CDN caching for static/semi-static responses',
      'If DDoS: enable WAF rules, contact cloud provider support',
    ],
    estimatedTime: '5-20 minutes',
  },
};
```

### Phase 4: Resolution (Hours to Days)

After the system is stable, you find and fix the actual root cause. This might happen immediately after mitigation (if the fix is straightforward) or over the next few days (if it requires architectural changes).

**Goal:** Ensure this specific failure mode cannot recur.

### Phase 5: Postmortem (Within 48 Hours)

Every SEV1 and SEV2 gets a written postmortem. No exceptions. SEV3 incidents get postmortems if there is something interesting to learn. We cover postmortems in detail in Section 33.8.

> **Key Term:** **Mitigation vs. Resolution** — Mitigation reduces or eliminates customer impact. Resolution addresses the root cause permanently. Mitigation is urgent; resolution is important. Never delay mitigation while searching for root cause. A rolled-back deployment that stops the bleeding in 2 minutes is infinitely better than a perfect root cause analysis that takes 45 minutes while customers suffer.

---

## 33.6 Incident Response Runbook: Common Booking System Failures

A runbook is a step-by-step guide for diagnosing and resolving a specific type of failure. It is written in advance — when you are calm, well-rested, and thinking clearly — so that at 3 AM, you do not need to think. You follow the steps.

Every experienced engineer has mental runbooks. The problem is that mental runbooks are trapped in one person's head. When that person is on vacation, sick, or has left the company, the runbook is gone. Written runbooks are organizational knowledge. They survive personnel changes, they can be improved iteratively, and they can be followed by a junior engineer who has never seen this failure before.

### Runbook: Booking Success Rate Drop

```yaml
# runbooks/booking-success-rate-drop.yaml

name: Booking Success Rate Drop
trigger: BookingSuccessRateCritical or BookingSuccessRateWarning alert
severity_guidance: >
  Below 95% = SEV2 (major degradation)
  Below 80% = SEV1 (critical outage)
  Below 99% but above 95% = SEV3 (minor degradation)

steps:
  - step: 1
    title: Identify the scope
    commands:
      - description: Check which booking types are affected
        command: |
          curl -s http://grafana:3000/api/datasources/proxy/1/api/v1/query \
            --data-urlencode 'query=sum(rate(bookings_total{status="error"}[5m])) by (booking_type)'
      - description: Check which regions are affected
        command: |
          curl -s http://grafana:3000/api/datasources/proxy/1/api/v1/query \
            --data-urlencode 'query=sum(rate(bookings_total{status="error"}[5m])) by (region)'
    decision: >
      If one booking type or one region: likely a specific service issue.
      If all types and all regions: likely infrastructure (DB, network, deployment).

  - step: 2
    title: Check for recent deployments
    commands:
      - description: List deployments in the last 2 hours
        command: kubectl get deployments -n booking --sort-by=.metadata.creationTimestamp
      - description: Check ArgoCD deployment history
        command: argocd app history booking-service --output json | jq '.[-3:]'
    decision: >
      If a deployment happened within 30 minutes of the issue starting,
      proceed to Step 3 (rollback). If not, skip to Step 4.

  - step: 3
    title: Rollback the deployment
    commands:
      - description: Roll back to previous version
        command: kubectl rollout undo deployment/booking-service -n booking
      - description: Verify rollback completed
        command: kubectl rollout status deployment/booking-service -n booking --timeout=120s
      - description: Wait 2 minutes then check metrics
        command: sleep 120 && curl -s 'http://prometheus:9090/api/v1/query?query=booking_success_rate'
    decision: >
      If metrics recover after rollback: the deployment was the cause.
      Write up the finding and investigate the deployment diff.
      If metrics do NOT recover: the deployment was not the cause. Continue to Step 4.

  - step: 4
    title: Check database health
    commands:
      - description: Check connection pool utilization
        command: |
          PGPASSWORD=$DB_PASS psql -h booking-db-primary -U monitor -d bookings -c \
            "SELECT count(*) as active, max_conn FROM pg_stat_activity
             CROSS JOIN (SELECT setting::int as max_conn FROM pg_settings
             WHERE name='max_connections') mc GROUP BY max_conn;"
      - description: Check for long-running queries
        command: |
          PGPASSWORD=$DB_PASS psql -h booking-db-primary -U monitor -d bookings -c \
            "SELECT pid, now() - query_start AS duration, state, left(query, 100)
             FROM pg_stat_activity WHERE state != 'idle'
             ORDER BY duration DESC LIMIT 10;"
      - description: Check replication lag
        command: |
          PGPASSWORD=$DB_PASS psql -h booking-db-primary -U monitor -d bookings -c \
            "SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
             (sent_lsn - replay_lsn) AS replication_lag
             FROM pg_stat_replication;"
    decision: >
      If connection pool is full: kill long-running queries and increase pool size.
      If replication lag is high: redirect reads to primary temporarily.
      If database is unreachable: initiate failover (see database-failover runbook).

  - step: 5
    title: Check external dependencies
    commands:
      - description: Check Stripe API health
        command: curl -s -o /dev/null -w '%{http_code}' https://api.stripe.com/v1/charges -H "Authorization:Bearer $STRIPE_KEY"
      - description: Check inventory service health
        command: curl -s http://inventory-service:8080/health
      - description: Check circuit breaker states
        command: curl -s http://booking-service:8080/actuator/circuitbreakers | jq '.circuitBreakers'
    decision: >
      If a dependency is down: activate circuit breaker, enable fallback provider.
      If circuit breakers are already open: the system is protecting itself,
      but user impact depends on fallback quality.

  - step: 6
    title: Check for traffic anomalies
    commands:
      - description: Compare current RPS to normal baseline
        command: |
          curl -s 'http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total[5m]))'
      - description: Check for sudden traffic spikes
        command: |
          curl -s 'http://prometheus:9090/api/v1/query?query=sum(rate(http_requests_total[5m]))/sum(rate(http_requests_total[5m] offset 1h))'
    decision: >
      If traffic is 2x+ normal: scale up infrastructure, enable rate limiting.
      If traffic is normal: the issue is not load-related — continue debugging.
```

### Runbook: Payment Processing Failures

```yaml
# runbooks/payment-processing-failures.yaml

name: Payment Processing Failures
trigger: PaymentFailureRateHigh alert
severity_guidance: >
  Payment failures affect revenue directly. Treat these as SEV2 minimum.
  Double-charging = immediate SEV1.

steps:
  - step: 1
    title: Determine the failure type
    commands:
      - description: Check payment error breakdown
        command: |
          curl -s 'http://prometheus:9090/api/v1/query' \
            --data-urlencode 'query=sum(rate(payment_errors_total[5m])) by (error_type, provider)'
    decision: >
      timeout errors: likely provider or network issue (Step 2)
      validation errors: likely bad request data (Step 3)
      duplicate charge alerts: IMMEDIATE SEV1 — go to double-charge runbook

  - step: 2
    title: Check payment provider status
    commands:
      - description: Check Stripe status page
        command: curl -s https://status.stripe.com/api/v2/status.json | jq '.status'
      - description: Check PayPal status
        command: curl -s https://www.paypal-status.com/api/v2/status.json | jq '.status'
      - description: Test payment provider connectivity
        command: |
          curl -s -w '\nHTTP_CODE:%{http_code}\nTIME_TOTAL:%{time_total}\n' \
            https://api.stripe.com/v1/payment_intents \
            -u "$STRIPE_SECRET_KEY:" -d amount=100 -d currency=usd \
            -d 'payment_method_types[]=card' -d confirm=false
    decision: >
      If provider is reporting issues: switch to backup provider via feature flag.
      If provider is healthy but slow: increase timeout, check network path.

  - step: 3
    title: Switch to backup payment provider
    commands:
      - description: Enable PayPal as primary via feature flag
        command: |
          curl -X PUT http://feature-flag-service:8080/api/flags/payment-provider-primary \
            -H 'Content-Type: application/json' \
            -d '{"value": "paypal", "reason": "Stripe outage — INC-XXXX"}'
      - description: Verify payments are processing through PayPal
        command: |
          sleep 60 && curl -s 'http://prometheus:9090/api/v1/query' \
            --data-urlencode 'query=sum(rate(payment_success_total{provider="paypal"}[1m]))'
    decision: >
      If PayPal is processing successfully: monitor for stability.
      If PayPal also failing: escalate to SEV1 — both providers down.
```

> **What If You Skip This?** Without runbooks, every incident is handled from scratch. The on-call engineer at 3 AM must remember the right psql command to check replication lag, the right kubectl command to rollback, the right feature flag name to switch payment providers. They will forget things. They will make typos. They will spend 10 minutes looking up a command that a runbook would have given them in 10 seconds. Runbooks are the difference between a 15-minute incident and a 90-minute incident.

---

## 33.7 War Room Protocols: Coordinating Under Pressure

When a SEV1 or SEV2 fires, the incident channel becomes the **war room**. This is not a metaphor — it is a structured environment with specific rules designed to minimize chaos and maximize effective response.

### Who Gets Paged and When

```typescript
// src/incident/war-room.config.ts

export interface WarRoomConfig {
  severity: string;
  autoPageRoles: string[];
  toolsToOpen: string[];
  slackChannelNaming: string;
  videoCallRequired: boolean;
  communicationRules: string[];
}

export const WAR_ROOM_CONFIGS: Record<string, WarRoomConfig> = {
  SEV1: {
    severity: 'SEV1',
    autoPageRoles: [
      'Primary on-call engineer',
      'Secondary on-call engineer',
      'Incident Commander (manager rotation)',
      'VP Engineering',
      'Customer Support Lead',
      'Database on-call (if DB-related)',
      'Infrastructure on-call (if infra-related)',
    ],
    toolsToOpen: [
      'Grafana — Booking Overview Dashboard',
      'Grafana — Database Health Dashboard',
      'Grafana — Payment Processing Dashboard',
      'Kibana/Datadog — Error log stream filtered to booking-service',
      'PagerDuty — Incident timeline',
      'AWS Console — ECS/EKS cluster health',
      'Statuspage.io — Draft status update',
    ],
    slackChannelNaming: '#inc-YYYY-MM-DD-short-description',
    videoCallRequired: true,
    communicationRules: [
      'All discussion happens in the incident channel — no side DMs',
      'IC posts structured updates every 15 minutes',
      'Prefix messages with your role: [IC], [INVESTIGATOR], [COMMS]',
      'Do not speculate about root cause in the channel — state facts',
      'If you are investigating something, say what before you go silent',
      'If you need to step away, tell the IC and hand off your thread',
    ],
  },

  SEV2: {
    severity: 'SEV2',
    autoPageRoles: [
      'Primary on-call engineer',
      'Incident Commander (senior engineer rotation)',
      'Owning team lead',
    ],
    toolsToOpen: [
      'Grafana — Booking Overview Dashboard',
      'Grafana — relevant service dashboard',
      'Kibana/Datadog — Error log stream',
      'PagerDuty — Incident timeline',
    ],
    slackChannelNaming: '#inc-YYYY-MM-DD-short-description',
    videoCallRequired: false,
    communicationRules: [
      'All discussion in incident channel',
      'IC posts structured updates every 30 minutes',
      'Keep updates factual and concise',
      'Tag people when you need their input — do not assume they are watching',
    ],
  },
};
```

### The First Five Minutes Checklist

The IC's first five minutes set the tone for the entire incident. Here is the exact sequence:

1. **Join the incident channel** (or create it: `#inc-2025-01-20-booking-failures`).
2. **Post the incident declaration** using the template from Section 33.4.
3. **Start the video call** (for SEV1 only — screen sharing is essential for collaborative debugging).
4. **Assign investigation threads.** "Alice, check recent deployments. Bob, check database health. Carla, check external dependencies. Report back in 5 minutes."
5. **Set a timer for the first status update.** Fifteen minutes for SEV1, thirty for SEV2.
6. **Notify Customer Support** with the initial impact assessment and talking points.

### War Room Anti-Patterns

These behaviors actively harm incident response. If you see them, the IC should intervene:

**The Silent Investigator.** An engineer goes dark for 20 minutes, digging into something without telling anyone. Meanwhile, two other engineers start investigating the same thing. Fix: require everyone to announce what they are looking at before going heads-down.

**The Blame Game.** "Who deployed this? Who approved this PR? Who wrote this query?" This shuts people down and makes them defensive instead of collaborative. Fix: focus on *what* happened, not *who* caused it. Blame has a place — it is called the postmortem, and even then we practice blameless culture.

**The Drive-By Expert.** A senior engineer who is not part of the incident response drops into the channel, posts "have you tried restarting the service?" with no context, and disappears. Fix: the IC redirects casual observers to watch the channel quietly. If they want to help, they coordinate through the IC.

**The Kitchen Sink.** Everyone tries every fix simultaneously — restarting services, rolling back deployments, scaling up, modifying configs — all at once. When the system recovers, nobody knows which action fixed it. Fix: the IC sequences actions and ensures only one change happens at a time (unless the situation is so dire that shotgunning is justified).

> **Checkpoint:** You are the IC for a SEV1 incident. Two engineers are both investigating the database without knowing the other is doing the same thing. A third engineer is restarting a service without telling anyone. A VP keeps asking for ETAs in the channel. What do you do? Answer: (1) Tell the two database investigators to coordinate — one checks connection pools, the other checks replication. (2) Ask the third engineer what they restarted and whether it changed anything. (3) Tell the VP you will include an ETA in the next structured update and ask them to hold questions until then. Your job is to impose order on chaos.

---

## 33.8 Postmortem: Learning Without Blame

The postmortem is the most important part of incident response. The incident itself is a crisis — the postmortem is where you turn that crisis into organizational learning. Without postmortems, you are doomed to repeat the same failures.

### Blameless Culture: The Foundation

A blameless postmortem does not mean nobody is accountable. It means that the human who made the mistake is not punished for making it. Instead, we ask: **what about the system made this mistake possible, likely, or inevitable?**

If an engineer deploys a bad config change that takes down production, the question is not "why did this engineer make a mistake?" The question is:

- Why did the deployment pipeline not catch the bad config?
- Why was there no canary deployment that would have limited the blast radius?
- Why did the monitoring not alert sooner?
- Why was there no automated rollback when error rates spiked?

The engineer made a mistake because engineers are humans and humans make mistakes. That is not a finding — that is a law of nature. The finding is the set of systemic improvements that make the mistake either impossible or harmless.

> **Analogy:** Aviation has the best safety record of any transportation industry, and it achieves this through blameless postmortems (called "accident investigations"). When a plane crashes, investigators do not look for someone to fire. They look for systemic factors: Was the checklist inadequate? Was the instrument panel confusing? Was the maintenance schedule insufficient? Every finding becomes a systemic improvement — a new checklist step, a redesigned instrument, a revised maintenance schedule. The result: flying is extraordinarily safe despite being operated by fallible humans. That is the model for engineering postmortems.

### The Postmortem Template

```markdown
# Postmortem: INC-2025-0120 — Booking Success Rate Degradation

## Metadata
| Field                  | Value                                               |
|------------------------|-----------------------------------------------------|
| **Incident ID**        | INC-2025-0120                                       |
| **Date**               | 2025-01-20                                          |
| **Severity**           | SEV2                                                |
| **Duration**           | 47 minutes (03:07 — 03:54 UTC)                      |
| **Incident Commander** | Marcus Johnson                                      |
| **Author**             | Alice Chen                                          |
| **Reviewers**          | Bob Kumar, Priya Sharma                             |
| **Status**             | Complete — action items tracked in JIRA              |

## Executive Summary
On January 20, 2025, at 03:07 UTC, the booking success rate dropped from 99.7% to
91.2%, affecting approximately 9% of booking attempts for 47 minutes. The root cause
was connection pool exhaustion on the primary database, triggered by a long-running
analytics batch job that acquired and held 43 database connections for over 20 minutes.
The issue was mitigated by killing the batch job queries and increasing the connection
pool size. Total customer impact: approximately 23,500 failed booking attempts, of
which ~18,000 succeeded on retry.

## Timeline (All Times UTC)
| Time  | Event                                                                    |
|-------|--------------------------------------------------------------------------|
| 02:45 | Analytics batch job starts (scheduled cron job)                          |
| 02:52 | Batch job begins executing complex aggregation queries                   |
| 03:03 | Database connection pool reaches 95% utilization                         |
| 03:05 | Connection pool warning alert fires (acknowledged by monitoring bot)     |
| 03:07 | Connection pool reaches 100% — new booking queries begin timing out      |
| 03:07 | BookingSuccessRateCritical alert fires — Alice paged                     |
| 03:09 | Alice acknowledges alert, begins triage                                  |
| 03:12 | Alice confirms SEV2, creates #inc-2025-0120-booking-pool                 |
| 03:14 | IC Marcus joins, assigns investigation threads                           |
| 03:18 | Alice identifies connection pool exhaustion via pg_stat_activity          |
| 03:22 | Alice identifies analytics batch job as the connection holder            |
| 03:25 | Decision: kill batch job queries (IC approved)                           |
| 03:27 | Batch job queries terminated — connection pool drops to 61%              |
| 03:30 | Booking success rate recovers to 98.5%                                   |
| 03:35 | Bob increases connection pool from 100 to 200 as safety measure          |
| 03:45 | Booking success rate stable at 99.6% — incident mitigated               |
| 03:54 | All-clear posted after 15 minutes of stable metrics                      |

## Root Cause Analysis
The analytics batch job runs nightly at 02:45 UTC to generate booking trend reports.
On January 20, the data volume was 3x normal because of a holiday weekend backlog.
The batch job executed 43 parallel aggregation queries, each holding a database
connection for 20+ minutes.

The booking database connection pool is configured for 100 connections. Under normal
conditions, the booking service uses 40-60 connections. The batch job consumed 43,
leaving only 17 available for booking traffic. At peak load (~800 queries/second),
17 connections were insufficient, causing connection timeouts.

**Contributing factors:**
1. The batch job runs against the primary database, not a read replica.
2. The batch job has no connection limit — it opens as many connections as it has
   parallel queries.
3. The connection pool warning alert (95%) was acknowledged by a bot but not by
   a human, so the issue was not caught before it became critical.
4. The connection pool size (100) had not been reviewed since the service was
   handling 40% of current traffic.

## Impact
- **Duration:** 47 minutes
- **Customer impact:** ~23,500 booking attempts failed with timeout errors
- **Retry success:** ~18,000 of those bookings succeeded on automatic or manual retry
- **Unrecovered failures:** ~5,500 bookings where the customer abandoned the attempt
- **Revenue impact:** Estimated $82,500 in potentially lost bookings (5,500 x $15 avg)
- **SLA impact:** Monthly booking success rate SLA is 99.5%. January running average
  dropped from 99.72% to 99.58% — still above SLA.

## What Went Well
- Alert fired within 2 minutes of the issue starting
- On-call engineer acknowledged within 2 minutes
- Root cause identified within 13 minutes
- Mitigation applied within 20 minutes of alert
- Communication cadence was maintained throughout
- No data corruption or incorrect charges

## What Went Wrong
- The batch job runs against primary instead of a read replica
- Connection pool warning was auto-acknowledged, bypassing human review
- Connection pool size had not been capacity-planned for current traffic volume
- The batch job has no safeguards against consuming too many connections

## Action Items
| ID   | Action                                               | Owner       | Priority | Due Date   |
|------|------------------------------------------------------|-------------|----------|------------|
| AI-1 | Move analytics batch job to read replica              | Alice Chen  | P1       | 2025-01-27 |
| AI-2 | Add connection limit (max 10) to batch job config     | Alice Chen  | P1       | 2025-01-24 |
| AI-3 | Increase default connection pool to 200               | Bob Kumar   | P2       | 2025-01-24 |
| AI-4 | Fix connection pool warning alert to require human ACK | Carla Reyes | P2       | 2025-01-27 |
| AI-5 | Add quarterly capacity review for all database pools  | Marcus J.   | P3       | 2025-02-15 |
| AI-6 | Add circuit breaker between batch jobs and primary DB | David Park  | P2       | 2025-02-01 |

## Lessons Learned
1. Batch jobs and online traffic should use separate database resources. A read replica
   costs far less than a 47-minute partial outage.
2. Alerts that are auto-acknowledged by bots can mask escalating issues. Critical
   resource alerts (CPU, memory, connections) should always require human acknowledgement.
3. Connection pool sizes set during initial deployment become stale as traffic grows.
   Capacity planning must be a recurring activity.
```

### Postmortem Review Meeting

The postmortem document is reviewed in a 30-60 minute meeting within 48 hours of the incident. The meeting is attended by all responders, the affected team, and the engineering manager. The meeting follows this agenda:

1. **Read-through** (10 min): Everyone reads the document silently. This ensures everyone has context, even if they were not involved.
2. **Timeline review** (10 min): Walk through the timeline. Are there any gaps? Any corrections? Any moments where a different decision would have changed the outcome?
3. **Root cause discussion** (10 min): Do we agree on the root cause? Are there deeper contributing factors we have not identified?
4. **Action items** (15 min): Review each action item. Is it correctly scoped? Is the priority right? Is the owner committed? Is the deadline realistic?
5. **Process improvements** (5 min): Did the incident process itself work? Were there communication gaps? Were runbooks helpful? What would we change about how we responded?

> **What If You Skip This?** Without postmortems, every incident exists in isolation. You fix the immediate issue and move on. Six months later, a nearly identical incident occurs because nobody documented what went wrong or implemented preventive measures. The organization learns nothing. Worse, without blameless culture, engineers learn to hide their mistakes instead of surfacing them — and hidden mistakes are the ones that cause catastrophic failures.

---

## 33.9 Automating Incident Response: Let the Machines Handle the Grind

Humans are bad at repetitive tasks under stress. We forget steps. We make typos. We take six minutes to do what a script does in six seconds. The goal of incident automation is not to replace human judgment — it is to eliminate the mechanical work so humans can focus on the judgment calls.

### PagerDuty Workflow Automation

PagerDuty (and OpsGenie) support event-driven workflows that trigger automatically when incidents are created or escalated. Here are the automations every booking system should have:

```typescript
// src/incident/pagerduty-automation.config.ts

export interface PagerDutyWorkflow {
  name: string;
  trigger: string;
  actions: WorkflowAction[];
}

export const PAGERDUTY_WORKFLOWS: PagerDutyWorkflow[] = [
  {
    name: 'SEV1 Auto-Response',
    trigger: 'Incident created with priority P1 (SEV1)',
    actions: [
      {
        type: 'create_slack_channel',
        config: {
          channelName: '#inc-{date}-{incident_title_slug}',
          inviteUsers: ['on-call-primary', 'on-call-secondary', 'ic-rotation'],
          pinMessage: 'Incident declared. IC: please assign investigation threads.',
        },
      },
      {
        type: 'start_video_call',
        config: {
          provider: 'zoom',
          title: 'SEV1 War Room — {incident_title}',
          postLinkTo: '#inc-{date}-{incident_title_slug}',
        },
      },
      {
        type: 'post_status_page_update',
        config: {
          status: 'investigating',
          template: 'investigating',
          components: ['Booking Service'],
        },
      },
      {
        type: 'notify_stakeholders',
        config: {
          channels: ['#engineering', '#customer-support'],
          message: 'SEV1 incident declared: {incident_title}. '
            + 'Follow updates in #inc-{date}-{incident_title_slug}.',
        },
      },
      {
        type: 'run_diagnostic_script',
        config: {
          script: 'scripts/auto-diagnostics.sh',
          postResultsTo: '#inc-{date}-{incident_title_slug}',
          timeout: '60s',
        },
      },
    ],
  },
  {
    name: 'Auto-Rollback on Error Spike',
    trigger: 'Alert: ErrorRateSpike AND recent deployment within 30 minutes',
    actions: [
      {
        type: 'run_script',
        config: {
          script: 'scripts/safe-rollback.sh',
          args: ['--service', '{affected_service}', '--wait-for-healthy', '120'],
          requireApproval: false,
          postResultsTo: '#deployments',
        },
      },
      {
        type: 'create_incident',
        config: {
          title: 'Auto-rollback triggered for {affected_service}',
          priority: 'P3',
          notes: 'Automatic rollback was performed. '
            + 'Please investigate the deployment that caused the error spike.',
        },
      },
    ],
  },
  {
    name: 'Auto-Scale on Traffic Surge',
    trigger: 'Alert: TrafficSurge — RPS > 2x baseline for 5 minutes',
    actions: [
      {
        type: 'run_script',
        config: {
          script: 'scripts/scale-up.sh',
          args: [
            '--service', '{affected_service}',
            '--scale-factor', '2',
            '--max-instances', '50',
          ],
          requireApproval: false,
        },
      },
      {
        type: 'notify',
        config: {
          channel: '#platform-alerts',
          message: 'Auto-scaled {affected_service} to handle traffic surge. '
            + 'Current RPS: {current_rps}, Baseline: {baseline_rps}.',
        },
      },
    ],
  },
];
```

### Auto-Diagnostics Script

When an incident is created, an automated diagnostics script runs and posts the results to the incident channel. This gives the on-call engineer a head start — by the time they open their laptop, the basic diagnostic information is already waiting for them.

```bash
#!/bin/bash
# scripts/auto-diagnostics.sh
# Runs automatically when a SEV1/SEV2 incident is created
# Posts results to the incident Slack channel

SERVICE=${1:-booking-service}
OUTPUT=""

OUTPUT+="=== AUTO-DIAGNOSTICS REPORT ===\n"
OUTPUT+="Generated at: $(date -u)\n"
OUTPUT+="Service: $SERVICE\n\n"

# Recent deployments
OUTPUT+="--- RECENT DEPLOYMENTS (last 2 hours) ---\n"
OUTPUT+="$(kubectl get replicasets -n booking --sort-by=.metadata.creationTimestamp \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp,REPLICAS:.status.replicas' \
  | tail -5)\n\n"

# Pod health
OUTPUT+="--- POD HEALTH ---\n"
OUTPUT+="$(kubectl get pods -n booking -l app=$SERVICE \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp')\n\n"

# Error rate (last 5 min)
OUTPUT+="--- ERROR RATE (5 min) ---\n"
OUTPUT+="$(curl -s 'http://prometheus:9090/api/v1/query' \
  --data-urlencode "query=sum(rate(http_requests_total{service=\"$SERVICE\",status=~\"5..\"}[5m])) / sum(rate(http_requests_total{service=\"$SERVICE\"}[5m])) * 100" \
  | jq -r '.data.result[0].value[1]')% errors\n\n"

# Database connection pool
OUTPUT+="--- DATABASE CONNECTION POOL ---\n"
OUTPUT+="$(curl -s "http://$SERVICE:8080/metrics" | grep 'db_pool' | head -5)\n\n"

# Circuit breaker states
OUTPUT+="--- CIRCUIT BREAKERS ---\n"
OUTPUT+="$(curl -s "http://$SERVICE:8080/health/detailed" | jq '.circuitBreakers // "N/A"')\n\n"

# Recent error logs (last 5 minutes)
OUTPUT+="--- RECENT ERRORS (last 5 min, top 5 unique) ---\n"
OUTPUT+="$(kubectl logs -n booking -l app=$SERVICE --since=5m 2>/dev/null \
  | grep -i 'error\|exception\|fatal' | sort | uniq -c | sort -rn | head -5)\n"

echo -e "$OUTPUT"
```

---

## 33.10 NestJS Health Check and Incident Detection Service

Our Global Booking System uses NestJS for its microservices. The health check module is the first line of defense — it exposes endpoints that monitoring tools and load balancers query to determine whether a service instance is healthy.

```typescript
// src/incident/health/health.module.ts

import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HttpModule } from '@nestjs/axios';
import { HealthController } from './health.controller';
import { BookingHealthIndicator } from './indicators/booking-health.indicator';
import { DatabaseHealthIndicator } from './indicators/database-health.indicator';
import { PaymentHealthIndicator } from './indicators/payment-health.indicator';
import { IncidentDetectionService } from './incident-detection.service';

@Module({
  imports: [TerminusModule, HttpModule],
  controllers: [HealthController],
  providers: [
    BookingHealthIndicator,
    DatabaseHealthIndicator,
    PaymentHealthIndicator,
    IncidentDetectionService,
  ],
  exports: [IncidentDetectionService],
})
export class HealthModule {}
```

```typescript
// src/incident/health/health.controller.ts

import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';
import { BookingHealthIndicator } from './indicators/booking-health.indicator';
import { DatabaseHealthIndicator } from './indicators/database-health.indicator';
import { PaymentHealthIndicator } from './indicators/payment-health.indicator';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: PrismaHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
    private bookingHealth: BookingHealthIndicator,
    private databaseHealth: DatabaseHealthIndicator,
    private paymentHealth: PaymentHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      // Basic liveness — is the process running?
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024), // 300MB
      () => this.memory.checkRSS('memory_rss', 512 * 1024 * 1024),  // 512MB

      // Database connectivity — can we reach the DB?
      () => this.db.pingCheck('database', { timeout: 3000 }),

      // Booking-specific health — is the booking flow working?
      () => this.bookingHealth.isHealthy('booking_flow'),

      // Database pool health — do we have available connections?
      () => this.databaseHealth.isHealthy('database_pool'),

      // Payment provider health — can we process payments?
      () => this.paymentHealth.isHealthy('payment_provider'),
    ]);
  }

  @Get('liveness')
  @HealthCheck()
  liveness() {
    // Kubernetes liveness probe — is the process alive?
    // Keep this lightweight. If this fails, K8s restarts the pod.
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
    ]);
  }

  @Get('readiness')
  @HealthCheck()
  readiness() {
    // Kubernetes readiness probe — can this pod serve traffic?
    // If this fails, K8s removes the pod from the load balancer.
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 3000 }),
      () => this.databaseHealth.isHealthy('database_pool'),
      () => this.paymentHealth.isHealthy('payment_provider'),
    ]);
  }
}
```

```typescript
// src/incident/health/incident-detection.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrometheusService } from '../metrics/prometheus.service';
import { PagerDutyService } from '../integrations/pagerduty.service';
import { Severity } from '../severity.config';

interface HealthMetric {
  name: string;
  currentValue: number;
  warningThreshold: number;
  criticalThreshold: number;
  comparison: 'above' | 'below';
}

@Injectable()
export class IncidentDetectionService {
  private readonly logger = new Logger(IncidentDetectionService.name);
  private readonly metrics: HealthMetric[] = [
    {
      name: 'booking_success_rate',
      currentValue: 0,
      warningThreshold: 99,
      criticalThreshold: 95,
      comparison: 'below',
    },
    {
      name: 'payment_success_rate',
      currentValue: 0,
      warningThreshold: 98,
      criticalThreshold: 90,
      comparison: 'below',
    },
    {
      name: 'p99_latency_ms',
      currentValue: 0,
      warningThreshold: 2000,
      criticalThreshold: 5000,
      comparison: 'above',
    },
    {
      name: 'db_connection_pool_usage_percent',
      currentValue: 0,
      warningThreshold: 80,
      criticalThreshold: 95,
      comparison: 'above',
    },
    {
      name: 'error_rate_percent',
      currentValue: 0,
      warningThreshold: 1,
      criticalThreshold: 5,
      comparison: 'above',
    },
  ];

  constructor(
    private readonly prometheus: PrometheusService,
    private readonly pagerduty: PagerDutyService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async evaluateHealthMetrics(): Promise<void> {
    for (const metric of this.metrics) {
      try {
        metric.currentValue = await this.prometheus.queryCurrentValue(metric.name);
        const severity = this.evaluateMetric(metric);

        if (severity) {
          await this.triggerAlert(metric, severity);
        }
      } catch (error) {
        this.logger.error(
          `Failed to evaluate metric ${metric.name}: ${error.message}`,
        );
      }
    }
  }

  private evaluateMetric(metric: HealthMetric): Severity | null {
    const { currentValue, warningThreshold, criticalThreshold, comparison } = metric;

    if (comparison === 'below') {
      if (currentValue < criticalThreshold) return Severity.SEV1;
      if (currentValue < warningThreshold) return Severity.SEV3;
    } else {
      if (currentValue > criticalThreshold) return Severity.SEV1;
      if (currentValue > warningThreshold) return Severity.SEV3;
    }

    return null;
  }

  private async triggerAlert(metric: HealthMetric, severity: Severity): Promise<void> {
    this.logger.warn(
      `Health metric ${metric.name} breached ${severity} threshold: `
        + `current=${metric.currentValue}`,
    );

    await this.pagerduty.createIncident({
      title: `${metric.name} ${severity} threshold breached`,
      severity,
      details: {
        metric: metric.name,
        currentValue: metric.currentValue,
        warningThreshold: metric.warningThreshold,
        criticalThreshold: metric.criticalThreshold,
        detectedAt: new Date().toISOString(),
      },
    });
  }
}
```

---

## 33.11 Prisma Schema: Tracking Incidents in the Database

Incidents are not just Slack threads and PagerDuty records. They need to be tracked in your own database for reporting, trend analysis, and compliance. Here is the Prisma schema for our incident tracking system:

```prisma
// prisma/schema.prisma (incident tracking models)

model Incident {
  id                String             @id @default(cuid())
  incidentNumber    String             @unique // e.g. "INC-2025-0120"
  title             String
  description       String?
  severity          IncidentSeverity
  status            IncidentStatus     @default(DETECTED)
  detectedAt        DateTime
  acknowledgedAt    DateTime?
  mitigatedAt       DateTime?
  resolvedAt        DateTime?
  closedAt          DateTime?
  durationMinutes   Int?
  customerImpact    String?
  revenueImpact     Decimal?           @db.Decimal(12, 2)
  affectedServices  String[]
  affectedRegions   String[]
  rootCause         String?
  mitigationSteps   String?
  incidentCommander String?
  primaryOnCall     String
  triggerSource     String             // "pagerduty", "manual", "automated"
  pagerdutyId       String?
  slackChannel      String?

  updates           IncidentUpdate[]
  postmortem        Postmortem?
  actionItems       ActionItem[]
  tags              IncidentTag[]

  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt

  @@index([severity, status])
  @@index([detectedAt])
  @@index([status])
  @@map("incidents")
}

model IncidentUpdate {
  id              String           @id @default(cuid())
  incidentId      String
  incident        Incident         @relation(fields: [incidentId], references: [id])
  updateType      UpdateType       // STATUS_CHANGE, INVESTIGATION, COMMUNICATION, ESCALATION
  message         String
  author          String
  previousStatus  IncidentStatus?
  newStatus       IncidentStatus?
  isPublic        Boolean          @default(false) // Posted to status page?
  createdAt       DateTime         @default(now())

  @@index([incidentId, createdAt])
  @@map("incident_updates")
}

model Postmortem {
  id                String        @id @default(cuid())
  incidentId        String        @unique
  incident          Incident      @relation(fields: [incidentId], references: [id])
  author            String
  reviewers         String[]
  executiveSummary  String
  timeline          Json          // Array of {time, event} objects
  rootCauseAnalysis String
  contributingFactors String[]
  whatWentWell      String[]
  whatWentWrong     String[]
  lessonsLearned    String[]
  status            PostmortemStatus @default(DRAFT)
  reviewedAt        DateTime?
  publishedAt       DateTime?
  documentUrl       String?       // Link to full postmortem doc

  actionItems       ActionItem[]

  createdAt         DateTime      @default(now())
  updatedAt         DateTime      @updatedAt

  @@map("postmortems")
}

model ActionItem {
  id              String           @id @default(cuid())
  incidentId      String
  incident        Incident         @relation(fields: [incidentId], references: [id])
  postmortemId    String?
  postmortem      Postmortem?      @relation(fields: [postmortemId], references: [id])
  title           String
  description     String?
  owner           String
  priority        ActionPriority
  status          ActionItemStatus @default(OPEN)
  dueDate         DateTime?
  completedAt     DateTime?
  jiraTicket      String?          // Link to tracking ticket

  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  @@index([incidentId])
  @@index([owner, status])
  @@index([dueDate])
  @@map("action_items")
}

model IncidentTag {
  id          String   @id @default(cuid())
  incidentId  String
  incident    Incident @relation(fields: [incidentId], references: [id])
  tag         String   // e.g., "database", "deployment", "external-dependency"

  @@unique([incidentId, tag])
  @@map("incident_tags")
}

enum IncidentSeverity {
  SEV1
  SEV2
  SEV3
  SEV4
}

enum IncidentStatus {
  DETECTED
  ACKNOWLEDGED
  INVESTIGATING
  MITIGATED
  RESOLVED
  CLOSED
}

enum UpdateType {
  STATUS_CHANGE
  INVESTIGATION
  COMMUNICATION
  ESCALATION
  MITIGATION
  RESOLUTION
}

enum PostmortemStatus {
  DRAFT
  IN_REVIEW
  PUBLISHED
}

enum ActionPriority {
  P1
  P2
  P3
  P4
}

enum ActionItemStatus {
  OPEN
  IN_PROGRESS
  COMPLETED
  WONT_FIX
}
```

This schema gives you the ability to query incident history, track postmortem action items to completion (critical for preventing recurrence), and generate reports like "how many SEV1 incidents did we have this quarter?" and "what percentage of action items are completed on time?"

> **Key Term:** **Action item completion rate** — The percentage of postmortem action items that are completed by their due date. This is one of the most important indicators of incident response maturity. If you write postmortems but never complete the action items, the postmortems are theater — they make people feel better without actually preventing future incidents. Mature organizations track action item completion rate as a team-level metric and aim for >90%.

---

## 33.12 Production War Story: The Black Friday Cascading Failure

*This section describes a fictionalized incident based on patterns observed across multiple real production systems.*

It was the Friday after Thanksgiving — Black Friday — and the Global Booking System was bracing for the biggest traffic day of the year. The team had prepared: extra capacity provisioned, additional on-call engineers scheduled, war room pre-staged in Slack. Everything looked ready.

At 08:47 EST, traffic began ramping. By 09:15, the system was handling 3.2x normal load — within the provisioned capacity of 4x. Dashboards were green. The team was cautiously optimistic.

At 09:23, the Elasticsearch cluster used for search autocomplete started falling behind. Search autocomplete latency climbed from 50ms to 800ms. The search service, which had a 2-second timeout for Elasticsearch calls, started queuing requests. This was a SEV3 — autocomplete was slow, but search results still worked.

At 09:31, the search service's request queue filled up. Incoming HTTP requests to the search endpoint started timing out. The API gateway, which proxied search requests, held connections open waiting for responses. Each held connection consumed a thread in the gateway's thread pool.

At 09:38, the API gateway's thread pool was 90% consumed by search requests waiting for timeouts. This affected **all** endpoints routed through the gateway — including bookings, payments, and user authentication. The booking success rate dropped from 99.8% to 72% in three minutes. The alert fired. SEV1 declared.

**What went wrong was not the Elasticsearch slowdown.** That was a minor issue. What went wrong was a **cascading failure**: the search service did not have a circuit breaker, the API gateway did not have per-route thread pool isolation, and the timeout on the search service was too long (2 seconds instead of 200ms for an autocomplete call).

The IC, Priya, made a critical decision at 09:42: instead of trying to fix Elasticsearch, she ordered the search service to be **removed from the API gateway entirely**. Search autocomplete would be down, but bookings, payments, and authentication would recover immediately.

At 09:44, the search route was removed from the gateway config. At 09:47, the gateway's thread pool drained. At 09:49, booking success rate was back to 99.5%. Total SEV1 duration: 11 minutes.

The postmortem identified three action items that each would have prevented the cascading failure:

1. **Circuit breaker on the search-to-Elasticsearch connection** (completed 1 week later). If the circuit breaker had been in place, the search service would have failed fast instead of queuing.
2. **Bulkhead pattern on the API gateway** — separate thread pools per route (completed 3 weeks later). Even if search consumed all its threads, booking and payment endpoints would have been unaffected.
3. **Aggressive timeouts for non-critical calls** — autocomplete should timeout at 200ms, not 2 seconds (completed 2 days later). A slow autocomplete is better than one that holds resources for 2 seconds.

**The lesson:** the dangerous failures are not the ones where a service crashes (those are obvious and well-handled). The dangerous failures are the ones where a service **degrades slowly**, consuming shared resources until everything collapses. Circuit breakers, bulkheads, and aggressive timeouts are the engineering defenses against cascading failures. And the hardest decision in an incident is often not "how do I fix this?" but "what do I sacrifice to save the rest?"

> **What the Senior Engineer Knows:** In a cascading failure, the instinct is to fix the root cause (Elasticsearch). The experienced response is to **isolate the blast radius** first (remove the search route). Fixing Elasticsearch might take 30 minutes. Removing the route takes 2 minutes. Every additional minute of a SEV1 at 3.2x traffic means thousands of failed bookings. Sacrifice the non-critical feature to save the critical path.

---

## Common Mistakes

1. **Treating every alert as a SEV1.** If everything is critical, nothing is critical. Engineers develop alert fatigue and start ignoring pages. Use severity levels correctly — most alerts are SEV3 or SEV4. Reserve SEV1 for genuine emergencies.

2. **No on-call rotation — the same person always responds.** This leads to burnout, single points of failure, and an engineer who eventually quits. Distribute on-call burden fairly across the team with a minimum of five people in the rotation.

3. **Debugging before mitigating.** Spending 30 minutes finding the root cause while customers suffer is the wrong priority. Roll back, failover, or disable the failing feature first. Debug after the system is stable.

4. **No Incident Commander.** Without an IC, three engineers investigate the same thing, nobody posts status updates, and the VP of Engineering starts asking questions in the incident channel that distract responders. The IC role exists to prevent coordination failure.

5. **Blame-first postmortems.** "Who did this?" kills psychological safety. Engineers stop deploying on Fridays, stop taking risks, and stop reporting near-misses. Blameless postmortems ask "what about the system allowed this?" and produce systemic improvements.

6. **Writing postmortems but never completing action items.** If only 30% of your action items get done, you are generating paperwork, not learning. Track action item completion rate. Review overdue items in team standups. Hold owners accountable to deadlines.

7. **No runbooks.** Every incident is handled ad-hoc by whoever happens to be on call. The senior engineer resolves it in 10 minutes because they have seen it before. The junior engineer takes 90 minutes because they are figuring it out from scratch. Runbooks encode institutional knowledge and make response times consistent.

8. **Communication blackouts during incidents.** The on-call engineer goes heads-down for 45 minutes without posting a single update. Customer support has no idea what to tell angry customers. The VP of Engineering starts paging additional people because they assume nobody is working on it. Status updates every 15 minutes (even if the update is "still investigating") prevent panic.

9. **Not testing incident response.** You would not deploy code without testing it. Why would you deploy an incident response process without testing it? Run quarterly "game day" exercises where you simulate a SEV1 and practice the full response — paging, triage, war room, communication, mitigation. The first real SEV1 should not be the first time your team runs the playbook.

10. **Manual incident creation and tracking.** If declaring an incident requires filling out a form, creating a Slack channel, paging the IC, posting a status page update, and notifying stakeholders — all manually — it takes 10 minutes before anyone starts investigating. Automate the administrative overhead so the on-call engineer can focus on the technical problem.

---

## Chapter Summary

| Topic                       | Key Concept                                                                                         |
|-----------------------------|-----------------------------------------------------------------------------------------------------|
| **Severity Levels**         | SEV1-SEV4 classification determines response urgency, team composition, and communication cadence    |
| **On-Call Rotation**        | Weekly rotation with at least 5 engineers, structured handoffs, and tiered escalation policies       |
| **Incident Commander**      | Dedicated coordinator who does not debug — they assign tasks, post updates, and make decisions       |
| **Communication**           | Templates for internal updates, status page posts, and stakeholder notifications eliminate ad-hoc prose |
| **Incident Timeline**       | Five phases: Detection, Triage, Mitigation, Resolution, Postmortem — each with clear goals and time targets |
| **Runbooks**                | Pre-written step-by-step guides for common failures — written when calm, followed when panicked      |
| **War Room Protocols**      | Structured environment with assigned roles, communication rules, and anti-patterns to avoid          |
| **Postmortems**             | Blameless analysis asking "what about the system allowed this?" with tracked action items             |
| **Automation**              | PagerDuty workflows, auto-diagnostics, auto-rollback, and auto-scaling reduce manual toil            |
| **Health Checks (NestJS)**  | Liveness, readiness, and deep health endpoints that feed monitoring and load balancer decisions       |
| **Incident Data (Prisma)**  | Database schema for incidents, updates, postmortems, and action items enables reporting and tracking  |
| **Cascading Failures**      | The most dangerous outages are slow degradations that consume shared resources — circuit breakers and bulkheads prevent them |
| **Mitigation vs. Resolution** | Stop the bleeding first (roll back, failover, disable). Find and fix root cause second.             |
| **Action Item Tracking**    | Postmortems without completed action items are theater. Track completion rate and aim for >90%.      |

---

> **Final Checkpoint:** You are building incident response for a new team. What are the first three things you set up? Answer: (1) An on-call rotation with PagerDuty or OpsGenie — because without it, alerts go nowhere. (2) Severity definitions that the whole team agrees on — because without shared severity understanding, every incident triggers a different response. (3) A postmortem template and the commitment to use it — because without postmortems, you learn nothing from your failures. Everything else — runbooks, automation, war room protocols — builds on these three foundations.
