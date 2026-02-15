# Part 9: Infrastructure & Deployment

---

# Chapter 35: Capacity Planning — How Much Server Do We Need?

## The Question Nobody Asks Until It Is Too Late

You have been developing on your laptop. Your entire application runs on `localhost:3000`. Maybe you deployed to a $5 VPS on DigitalOcean or a free Railway instance, ran `npm start`, and called it production. That works for your side project with 50 users.

Now imagine you are launching a global booking platform that needs to handle **100,000 bookings per minute**. How many servers do you need? How much RAM? How many database instances? How much will it all cost?

This is **capacity planning**, and it is one of the most important skills you will develop as you move from "I can build features" to "I can build systems." It is not glamorous. It is math. But skipping it means either spending ten times what you need or watching your system collapse on launch day.

> **Key Term:** **Capacity planning** — The process of determining what infrastructure resources (CPU, RAM, storage, network) your system needs to handle expected traffic, both at average load and at peak spikes. It is the bridge between "it works on my machine" and "it works for a million users."

## Back-of-Envelope Math: Start Here Every Time

Before you open any cloud pricing calculator, grab a napkin (or a text editor) and do the arithmetic. Seriously. Senior engineers do this constantly. It takes two minutes and saves you from wildly wrong assumptions.

Our target: **100,000 bookings per minute** at peak.

```
100,000 bookings / 60 seconds = 1,667 bookings per second
```

That is our peak number. But systems do not run at peak all day. Our average is about half of peak:

```
Average: ~800 bookings per second
Peak:    ~1,667 bookings per second
```

Now, each booking is not just one operation. Think about what happens when someone clicks "Book Now":

1. An HTTP request hits the API Gateway (~2 ms)
2. JWT token gets verified (~1 ms)
3. Inventory Service checks availability (~5 ms)
4. A Redis distributed lock is acquired (~2 ms)
5. Payment Service charges the card (~200 ms -- external API call)
6. A database write happens (~5 ms)
7. A Kafka event is published (~3 ms)
8. A response is sent back (~1 ms)

Each booking needs roughly **220 ms of wall-clock time** and touches at least 4 services. Each request in flight holds some memory -- the request body, database result sets, payment API responses. Call it roughly **2 MB of RAM per in-flight request** across all services.

At 1,667 bookings per second with 220 ms average processing time:

```
Concurrent in-flight requests = 1,667 * 0.22 = ~367

Memory for in-flight requests = 367 * 2 MB = ~734 MB
```

That is just for the booking flow. The system also handles search queries (70% of all traffic), user profile lookups, admin dashboard requests, and background jobs. The booking flow is the write-heavy critical path, but reads outnumber writes roughly 2.3 to 1.

> **Analogy:** Capacity planning is like figuring out how many cashiers a grocery store needs. You count the average customers per hour, estimate how long each checkout takes, and figure out how many lanes to open. Too few lanes and the queue wraps around the store. Too many and you are paying cashiers to stand idle. The math is the same for servers.

## The Traffic Model

Here is the full traffic model for our system. Every number in this model drives a decision downstream -- how many database shards, how many Redis nodes, how many Kafka brokers.

```typescript
export const trafficModel = {
  peak: {
    bookingsPerSecond: 1666,
    bookingsPerMinute: 100000,
    bookingsPerHour: 6000000
  },
  average: {
    bookingsPerSecond: 800,
    bookingsPerMinute: 48000,
    bookingsPerHour: 2880000
  },
  readWriteRatio: { reads: 0.70, writes: 0.30 },
  geographic: {
    'us-east-1': 0.35,      // 35% of traffic from North America
    'eu-west-1': 0.30,      // 30% from Europe
    'ap-southeast-1': 0.25, // 25% from Asia-Pacific
    'sa-east-1': 0.10       // 10% from South America
  },
  seasonal: {
    highSeason: { months: [6, 7, 8, 12], multiplier: 1.8 },
    lowSeason: { months: [1, 2, 3, 9, 10, 11], multiplier: 0.8 }
  },
  bookingTypes: {
    hotel: 0.45,    // Hotels are 45% of all bookings
    flight: 0.35,   // Flights are 35%
    car: 0.15,      // Car rentals are 15%
    package: 0.05   // Bundle packages are 5%
  }
};
```

Let me walk through the pieces you might not immediately understand:

**`readWriteRatio`**: For every 10 requests, 7 are reads (searching, browsing, checking availability) and 3 are writes (creating bookings, processing payments). This ratio determines how we split database capacity between primary instances (which handle writes) and read replicas (which handle reads).

**`geographic`**: Traffic is not evenly distributed. More people book from North America and Europe than from South America. We deploy servers in four AWS regions so that a user in Tokyo gets routed to `ap-southeast-1` instead of crossing the Pacific to `us-east-1`. Each region gets capacity proportional to its traffic share.

**`seasonal`**: Travel booking has seasons. Summer months (June-August) and December see 1.8x normal traffic. January through March is quieter at 0.8x. This means our peak of 100,000/minute during high season corresponds to ~44,000/minute during low season. We need auto-scaling to avoid paying for summer capacity in February.

> **Checkpoint:** If our peak is 1,667 bookings per second and the read-to-write ratio is 70/30, how many read operations per second do we need to handle at peak? Answer: 1,667 / 0.30 * 0.70 = ~3,889 reads/second. (The total request volume is 1,667 / 0.30 = ~5,556 requests/second, of which 70% are reads.) If that calculation made sense, you are thinking about capacity correctly.

## Database Capacity: The Most Expensive Component

The database is almost always the hardest thing to scale and the most expensive line item on your cloud bill. Here is why: CPU and memory are stateless -- you can add more application servers trivially. But the database holds *state*. Every booking, every payment record, every inventory count lives there. You cannot just "add another one" without solving data distribution, replication lag, and consistency.

We shard across **16 MySQL instances**. Each shard handles a subset of data (for example, bookings with IDs hashing to shard 0-15).

> **Key Term:** **Sharding** — The practice of splitting a database into multiple smaller databases (called shards), each holding a subset of the data. Requests are routed to the correct shard using a hash of a key (like booking ID). Sharding enables horizontal scaling of databases that would otherwise hit the limits of a single server.

```typescript
export const databaseCapacity = {
  shards: 16,
  instanceType: 'db.r6g.4xlarge',  // AWS RDS instance type
  specs: {
    vcpus: 16,
    memory: '128 GB',
    network: '10 Gbps',
    storage: {
      type: 'io2',          // High-performance SSD
      size: '3 TB per shard',
      iops: 64000            // I/O operations per second
    }
  },
  replication: {
    readReplicas: 4,         // 4 read replicas per shard
    crossRegionReplicas: 1   // 1 cross-region replica per shard
  },
  capacity: {
    writesPerSecond: 4000,   // per shard
    readsPerSecond: 16000,   // per shard (across all replicas)
    totalWritesPerSecond: 64000,  // 16 shards * 4,000
    totalReadsPerSecond: 256000   // 16 shards * 16,000
  },
  monthlyCost: {
    primaryInstances: 16 * 2400,     // $38,400
    readReplicas: 16 * 4 * 2400,     // $153,600
    crossRegionReplicas: 16 * 3200,  // $51,200
    storage: 16 * 5 * 1000,          // $80,000
    iops: 16 * 5 * 640,              // $51,200
    backups: 16 * 800,               // $12,800
    dataTransfer: 16 * 7300,         // $116,800
    total: 504000                     // ~$504,000/month
  }
};
```

Yes, you read that right. **Half a million dollars per month** just for the database layer. Let me explain why each piece exists:

**16 shards**: At 1,667 write operations per second (peak bookings), a single MySQL instance would choke. Each shard handles 4,000 writes/second, giving us 64,000 total -- well above our peak with headroom for spikes.

**4 read replicas per shard**: Remember the 70/30 read-write ratio. Those search queries and availability checks hit read replicas, keeping the primary instance free for writes. Four replicas per shard give us 16,000 reads/second per shard, or 256,000 total.

**`io2` storage with 64,000 IOPS**: IOPS stands for "input/output operations per second." Think of it as how many times per second the disk can read or write a chunk of data. Standard SSDs give you maybe 3,000 IOPS. At our write volume, we need premium storage.

**Cross-region replicas**: If `us-east-1` goes down entirely (it has happened -- ask anyone who was on call during the 2017 S3 outage), the cross-region replica in `eu-west-1` can be promoted to primary. This is disaster recovery.

> **What If You Skip This?** If you undersize your database and launch, you will hit connection limits or IOPS ceilings under real traffic. The symptoms look like random 500 errors, queries that used to take 5 ms now taking 5 seconds, and eventually the database refusing new connections entirely. Scaling a database *while it is under production load* is one of the most stressful operations in infrastructure. Size it right before launch day.

## Redis Capacity: Four Clusters, Not One

When you used Redis on your side project, you probably ran one instance that did everything -- caching, sessions, maybe some rate limiting. That works at small scale. At our scale, we split Redis into **four separate clusters**, each dedicated to a specific workload.

Why? Because a sudden cache stampede (thousands of cache misses at once) would spike Redis CPU. If your session store and your distributed locks live on that same Redis instance, suddenly users cannot log in and inventory locks fail. Isolation prevents one workload from poisoning another.

```typescript
export const redisCapacity = {
  clusters: {
    sessions: {
      nodeType: 'cache.r6g.xlarge',  // Optimized for memory
      nodes: 6,                       // 3 shards, 1 replica each
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200               // $4,200/month
    },
    fencing: {
      nodeType: 'cache.r6g.xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200               // $4,200/month -- distributed locks
    },
    cache: {
      nodeType: 'cache.r6g.2xlarge',  // Larger: caches hold more data
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 5400               // $5,400/month
    },
    rateLimiting: {
      nodeType: 'cache.r6g.large',    // Smaller: counters are tiny
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 3600               // $3,600/month
    }
  },
  totalMonthlyCost: 17400  // ~$17,400/month
};
```

Here is why each cluster exists:

| Cluster | What It Stores | Why Separate? |
|---------|---------------|---------------|
| **Sessions** | User login sessions, JWT refresh tokens | Must be rock-solid; a session outage logs out every user |
| **Fencing** | Distributed locks for inventory reservations | Lock failures cause double-bookings; cannot share CPU with cache |
| **Cache** | Search results, frequently accessed data | Cache stampedes spike CPU; isolate so they do not affect locks |
| **Rate Limiting** | Request counters per client with TTL | Lightweight but must be fast; its own cluster avoids contention |

> **Key Term:** **Cache stampede** — When many cache entries expire at the same time, causing a flood of requests to the database. If Redis is also handling your locks and sessions on the same instance, the CPU spike from the stampede degrades everything. Isolating workloads into separate clusters prevents this cascade.

## Kafka Capacity: The Event Backbone

Kafka carries every event between services. When a booking is created, confirmed, cancelled, or paid for, that event flows through Kafka. If Kafka slows down, the entire system's asynchronous communication backs up.

```typescript
export const kafkaCapacity = {
  brokers: {
    count: 15,
    instanceType: 'kafka.m5.2xlarge',
    specs: {
      cpu: '8 vCPUs per broker',
      memory: '32 GB per broker',
      storage: { type: 'gp3', size: '4 TB per broker', iops: 16000 }
    },
    configuration: {
      'num.network.threads': 8,
      'num.io.threads': 16,
      'log.retention.hours': 720,    // Keep events for 30 days
      'compression.type': 'lz4',     // Fast compression
      'min.insync.replicas': 2       // At least 2 replicas must confirm
    }
  },

  // KRaft mode -- NO ZooKeeper needed (Kafka 3.3+)
  controller: {
    mode: 'KRaft',
    description: 'Kafka Raft consensus replaces ZooKeeper for metadata management',
    controllerNodes: 3,
    configuration: {
      'process.roles': 'controller',
      'controller.quorum.voters':
        '1@controller-1:9093,2@controller-2:9093,3@controller-3:9093',
      'controller.listener.names': 'CONTROLLER',
      'listeners': 'CONTROLLER://:9093'
    },
    benefits: [
      'Eliminates ZooKeeper operational overhead',
      'Faster metadata operations',
      'Simpler deployment (no separate ensemble)',
      'Better partition scalability (millions vs hundreds of thousands)',
      'Reduced infrastructure cost (-$1,500/month)'
    ]
  },

  topics: {
    'booking-events':
      { partitions: 200, replicationFactor: 3, retentionDays: 30 },
    'payment-events':
      { partitions: 100, replicationFactor: 3, retentionDays: 90 },
    'inventory-events':
      { partitions: 150, replicationFactor: 3, retentionDays: 7 },
    'inventory-reservations-global':
      { partitions: 100, replicationFactor: 3, retentionDays: 1 },
    'notification-events':
      { partitions: 80, replicationFactor: 3, retentionDays: 3 }
  },

  monthlyCost: {
    brokers: 15000,
    controllers: 900,      // 3 KRaft controllers
    storage: 12000,
    dataTransfer: 5000,
    total: 32900            // ~$32,900/month
  }
};
```

Let me unpack the important parts:

**15 brokers**: A Kafka broker is a server that stores and serves event data. With 1,667 bookings per second, each generating multiple events (booking.created, payment.processed, notification.send), we are looking at roughly 5,000-8,000 events per second. Fifteen brokers distribute this load comfortably.

**Partitions**: A topic like `booking-events` has 200 partitions. Think of partitions as parallel lanes on a highway. More partitions means more consumers can read in parallel. Booking events get the most partitions (200) because they are the highest-volume topic.

**`replicationFactor: 3`**: Every event is copied to 3 brokers. If one broker's disk dies, the event still exists on two others. Combined with `min.insync.replicas: 2`, Kafka will not acknowledge a write unless at least 2 replicas have it. This prevents data loss.

**`log.retention.hours: 720`**: Kafka keeps events for 30 days. This means if a consumer goes down for a weekend, it can catch up on Monday by replaying events from where it left off. Payment events are kept for 90 days (auditing requirements), while notification events only need 3 days.

> **Common Mistake: Using ZooKeeper with Kafka 3.3+**
>
> If you are reading older tutorials or blog posts about Kafka, they all mention ZooKeeper -- a separate service that Kafka used to depend on for storing metadata (which brokers are alive, which topics exist, who leads each partition). Starting with Kafka 3.3 (and production-ready in 3.5+), Kafka replaced ZooKeeper with **KRaft** (Kafka Raft), a built-in consensus protocol.
>
> KRaft means Kafka manages its own metadata internally. No separate ZooKeeper cluster to deploy, monitor, upgrade, and debug. It is simpler, faster, and cheaper. **Always use KRaft mode for new deployments.** If you see a tutorial telling you to set up ZooKeeper alongside Kafka, that tutorial is outdated.

> **Key Term:** **KRaft (Kafka Raft)** — Kafka's built-in consensus protocol that replaced ZooKeeper for metadata management. It uses the Raft consensus algorithm (the same one used by etcd in Kubernetes) to elect leaders and replicate metadata across controller nodes. "KRaft" is a portmanteau of "Kafka" and "Raft."

## Kubernetes Node Capacity

Kubernetes runs all our application containers. We need to size the nodes (the actual servers) that Kubernetes schedules pods onto.

```typescript
export const k8sCapacity = {
  nodesPerRegion: {
    workerNodes: {
      instanceType: 'c6i.4xlarge',   // Compute-optimized
      count: 30,
      specs: { cpu: 16, memory: '32 GB' }
    },
    systemNodes: {
      instanceType: 'm6i.2xlarge',   // General purpose
      count: 3,
      specs: { cpu: 8, memory: '32 GB' }
    }
  },
  regions: 4,
  totalNodes: 33 * 4,  // 132 nodes across 4 regions
  monthlyCost: {
    workerNodes: 30 * 4 * 500,   // $60,000
    systemNodes: 3 * 4 * 350,    // $4,200
    loadBalancers: 4 * 500,      // $2,000
    natGateways: 4 * 400,        // $1,600
    ebs: 4 * 1200,               // $4,800
    total: 72500                  // ~$72,500/month
  }
};
```

**Worker nodes vs. system nodes**: Worker nodes run your application pods (Booking Service, Payment Service, etc.). System nodes run Kubernetes itself -- the control plane components, monitoring agents, log collectors. You separate them so that a misbehaving application pod cannot starve the system of resources.

**30 worker nodes per region with 16 CPUs each**: That is 480 vCPUs per region. If each Booking Service pod requests 1 CPU (as we will see in the next chapter), you can run up to 480 pods per region (in practice less, because you leave headroom and other services also need CPUs).

**4 regions**: Our traffic model says 35% from US, 30% from EU, 25% from Asia, 10% from South America. We deploy in all four so users get low-latency responses. A user in Singapore should not have their request travel to Virginia and back -- that adds 200+ ms of network latency.

## Total Cost Summary

Here is where it all comes together. Brace yourself.

```typescript
export const totalSystemCost = {
  monthly: {
    database: 504000,        // The big one
    redis: 17400,
    kafka: 32900,            // KRaft mode (saved $1,500/month vs ZooKeeper)
    kubernetes: 72500,
    cdn: 25000,              // Content delivery network
    monitoring: 15000,       // Prometheus, Grafana, Datadog, etc.
    logging: 12000,          // Centralized log storage
    dns: 2000,               // Route53 or equivalent
    secrets: 1000,           // AWS Secrets Manager / Vault
    cicd: 3000,              // GitLab runners, artifact storage
    support: 15000,          // AWS Enterprise Support
    miscellaneous: 10000,    // The stuff you forgot to budget for
    reserveBuffer: 150000,   // 20% buffer for surprises

    subtotal: 859800,
    regions: 4,
    multiRegionMultiplier: 1.7,  // Not everything replicates 4x

    total: 1470000               // ~$1.47M/month
  },

  perBooking: {
    monthlyBookings: 70000000,   // ~70M bookings/month
    costPerBooking: 0.021        // ~$0.021 per booking
  },

  annualTotal: 17640000          // ~$17.6M/year
};
```

**$1.47 million per month.** That number is shocking if you have never done capacity planning before. But look at the per-booking cost: **$0.021 -- about two cents per booking**. If the average booking generates $15 in revenue, the infrastructure cost is 0.14% of revenue. That is extremely efficient.

The `multiRegionMultiplier` of 1.7 deserves explanation. Not every service is fully replicated in every region. The database has cross-region replicas, but they are smaller. Some services (like the admin dashboard) only run in one region. So the total is not 4x the single-region cost, but roughly 1.7x.

The **reserve buffer of $150,000/month** is critical. Something will go wrong. You will discover you need more database IOPS. A traffic spike will exceed projections. A vendor will raise prices. The buffer absorbs these surprises without requiring an emergency budget request.

| Component | Monthly Cost | % of Total |
|-----------|-------------|------------|
| Database (MySQL) | $504,000 | 34% |
| Reserve Buffer | $150,000 | 10% |
| Kubernetes | $72,500 | 5% |
| Kafka | $32,900 | 2% |
| CDN | $25,000 | 2% |
| Redis | $17,400 | 1% |
| Monitoring + Logging | $27,000 | 2% |
| Everything Else | $31,000 | 2% |
| **Multi-Region Total** | **$1,470,000** | **100%** |

> **What If You Skip This?** If you skip capacity planning and launch with "we'll figure it out," one of two things happens. Either you massively over-provision (launching with $2M/month of infrastructure for 10,000 users) and burn through your budget before finding product-market fit, or you under-provision and your system falls over during the first marketing campaign. Both outcomes can kill a company. The two hours you spend on back-of-envelope math are the cheapest insurance you will ever buy.

> **Checkpoint:** Without scrolling, can you answer: (1) What is the most expensive infrastructure component and roughly what percentage of the total does it represent? (2) Why do we use four separate Redis clusters instead of one? (3) What is KRaft and why does it matter for new Kafka deployments? If you can answer all three, you understand capacity planning at a practical level.

## Chapter 35 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Back-of-envelope math | Start every capacity exercise by converting your target (100K/min) to per-second numbers and estimating CPU/RAM per request. |
| Traffic model | Captures peak vs. average load, geographic distribution, read/write ratio, and seasonal multipliers. |
| Database sizing | The most expensive component; shard across multiple instances with read replicas to handle write and read throughput separately. |
| Redis isolation | Separate clusters for sessions, locks, cache, and rate limiting prevent one workload from degrading another. |
| Kafka with KRaft | Always use KRaft mode for new Kafka deployments; ZooKeeper is deprecated as of Kafka 3.3+. |
| Kubernetes nodes | Size worker nodes for application pods and system nodes for K8s internals; deploy across regions proportional to traffic. |
| Cost per booking | At $1.47M/month for 70M bookings, each booking costs ~$0.021 -- infrastructure is a tiny fraction of revenue. |

---

# Chapter 36: Kubernetes Deployment — Your App in the Cloud

## Beyond `npm start`

Up to now, if someone asked you "how do you deploy your app?", your answer was probably one of these:

- "I push to GitHub, and Heroku/Railway auto-deploys."
- "I SSH into the server and run `git pull && npm start`."
- "I use pm2 to keep it running."

These work for a single service. But we have seven microservices, each needing multiple instances, automatic restarts when they crash, rolling updates with zero downtime, and the ability to scale from 5 instances to 40 instances in sixty seconds. None of those deployment methods can do all of that.

Enter **Kubernetes** (often abbreviated **K8s** -- "K", eight letters, "s").

> **Analogy:** Think of Docker containers as shipping containers -- standardized boxes that hold your application and everything it needs. Now imagine a massive shipping port with cranes, scheduling systems, and logistics. Docker gives you the container. Kubernetes is the entire port. It decides which ship (server) each container goes on, moves containers to new ships if one sinks, and can bring in more cranes when holiday season traffic picks up. You tell the port "I need 20 of these containers running at all times," and it handles the rest.

> **Key Term:** **Kubernetes (K8s)** — An open-source container orchestration platform. You describe your desired state ("run 20 instances of the Booking Service"), and Kubernetes continuously works to make actual state match desired state. If a container crashes, K8s restarts it. If a server goes down, K8s reschedules the containers to healthy servers.

## The Deployment Manifest: Your System in a YAML File

In Kubernetes, you describe what you want in YAML files called **manifests**. The Kubernetes control plane reads these manifests and makes them reality. Let me walk you through a production-grade deployment for our Booking Service, line by line.

### The Deployment Resource

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: production
```

- **`apiVersion: apps/v1`**: Tells Kubernetes which API to use. Think of it like an import statement. `apps/v1` is the stable API for Deployments.
- **`kind: Deployment`**: The type of resource. A Deployment manages a set of identical pods (think: "this is a recipe for running X copies of my app").
- **`name: booking-service`**: The name Kubernetes uses to identify this Deployment. Other resources reference it by this name.
- **`namespace: production`**: Namespaces are like folders. You might have `production`, `staging`, and `development` namespaces in the same cluster. Resources in different namespaces are isolated from each other.

> **Key Term:** **Pod** — The smallest deployable unit in Kubernetes. A pod is one or more containers that share networking and storage. In practice, most pods contain exactly one container (your application). Think of a pod as a lightweight VM that runs your `npm start` process.

### Replicas and Update Strategy

```yaml
spec:
  replicas: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 5
      maxUnavailable: 2
```

- **`replicas: 20`**: Run 20 identical copies of the Booking Service simultaneously. Why 20? Because at peak load (1,667 bookings/second), each instance handles roughly 80-90 requests/second at comfortable CPU utilization. 20 replicas give us capacity with headroom.
- **`strategy: RollingUpdate`**: When you deploy a new version, Kubernetes does not kill all 20 pods and start 20 new ones (that would cause downtime). Instead, it rolls the update out gradually.
- **`maxSurge: 5`**: During an update, Kubernetes can create up to 5 extra pods (total of 25) to speed up the rollout.
- **`maxUnavailable: 2`**: At most 2 pods can be down at any moment during the update. This means at least 18 pods are always serving traffic -- users never notice the deployment happening.

> **Analogy:** Imagine a restaurant replacing its entire wait staff mid-dinner service. A bad approach: fire everyone at once, hire new staff, reopen. Customers leave. A rolling update: bring in one new waiter, train them, then let one old waiter go. Repeat. Customers always have waiters. `maxSurge` is how many extra waiters you can have temporarily. `maxUnavailable` is how many stations can be empty at once.

### Selectors and Labels

```yaml
  selector:
    matchLabels:
      app: booking-service
  template:
    metadata:
      labels:
        app: booking-service
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
```

- **`selector.matchLabels`**: Tells the Deployment which pods belong to it. "I manage all pods that have the label `app: booking-service`."
- **`template.metadata.labels`**: The label applied to every pod this Deployment creates. The selector and the template labels must match -- otherwise Kubernetes does not know which pods the Deployment owns.
- **`annotations`**: Metadata that does not affect scheduling but is used by other tools. Here, Prometheus (our monitoring system) knows to scrape metrics from port 3000 of every Booking Service pod.

### Init Containers: Run Before Your App Starts

```yaml
    spec:
      serviceAccountName: booking-service
      initContainers:
        - name: db-migrations
          image: registry.company.com/booking-service:${VERSION}
          command: ['npm', 'run', 'migrate']
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url
```

- **`serviceAccountName`**: Kubernetes identity for this pod. Controls what AWS/GCP resources the pod can access. Like a user account, but for software.
- **`initContainers`**: Containers that run to completion *before* the main container starts. Here, we run database migrations before the Booking Service boots up. This ensures the database schema is up to date before the application tries to use it.
- **`secretKeyRef`**: The database URL (with password) is stored in a Kubernetes Secret, not in the YAML file. Never put passwords in code or config files that go into version control.

> **What If You Skip This?** Without init containers for migrations, you would need to run migrations manually before every deployment, or hope the application handles missing columns gracefully (it will not). Init containers guarantee that migrations complete before any traffic hits the new version.

### The Application Container

```yaml
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:${VERSION}
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3000"
            - name: REGION
              value: "us-east-1"
```

- **`image`**: The Docker image to run. `${VERSION}` is replaced during deployment with the git commit SHA (more on that in the CI/CD chapter).
- **`containerPort: 3000`**: The port your NestJS application listens on.
- **`resources.requests`**: The minimum resources Kubernetes guarantees this pod. `1000m` means 1 full CPU core (m = millicores; 1000m = 1 core). `2Gi` means 2 gibibytes of RAM. Kubernetes uses these values to decide which node to schedule the pod on -- it will not place the pod on a node that cannot provide at least these resources.
- **`resources.limits`**: The maximum resources the pod can use. If the Booking Service tries to use more than 4 Gi of RAM, Kubernetes kills the pod (OOMKilled). If it tries to use more than 2 CPUs, it gets throttled. Limits prevent a single runaway pod from consuming an entire node.

> **Key Term:** **Millicores (m)** — Kubernetes measures CPU in "millicores." 1000m = 1 full CPU core. 500m = half a core. 250m = a quarter of a core. A Node.js application typically needs 500m-1000m for moderate traffic. This granularity lets you pack pods efficiently onto nodes.

### Health Checks: Is Your App Actually Working?

```yaml
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
```

These are two different kinds of health checks, and understanding the difference is critical:

**Liveness Probe** -- "Is the process alive?" Kubernetes sends a GET request to `/health` every 10 seconds. If it fails 3 consecutive times, Kubernetes **kills and restarts the pod**. This catches situations where the Node.js process is running but stuck (deadlocked, unresponsive, infinite loop). The `initialDelaySeconds: 30` gives the application time to start up before Kubernetes begins checking.

**Readiness Probe** -- "Is the process ready to receive traffic?" Kubernetes sends a GET request to `/ready` every 5 seconds. If it fails, Kubernetes **removes the pod from the load balancer** but does not restart it. The pod stays alive but stops receiving new requests. This is used during startup (the app is alive but still connecting to the database) or during graceful shutdown.

| Probe | What It Asks | On Failure | Use Case |
|-------|-------------|------------|----------|
| Liveness | "Are you alive?" | Kill and restart the pod | Detect stuck processes |
| Readiness | "Can you serve traffic?" | Stop sending traffic | Startup warmup, graceful shutdown |

> **What If You Skip This?** Without liveness probes, a stuck pod sits there forever, silently dropping requests. Without readiness probes, Kubernetes sends traffic to pods that are still starting up, causing errors for users. Both probes are non-negotiable in production.

### Graceful Shutdown and Anti-Affinity

```yaml
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: [booking-service]
                topologyKey: kubernetes.io/hostname
```

- **`preStop: sleep 15`**: Before Kubernetes kills a pod (during scaling down or deployment), it runs this hook. The 15-second sleep gives in-flight requests time to complete. Without it, requests that started 1 second before shutdown would get abruptly terminated.

- **`podAntiAffinity`**: "Try not to put two Booking Service pods on the same physical server." If a server fails, you want to lose at most one pod, not five. Anti-affinity spreads pods across different machines for fault tolerance.

> **Analogy:** Anti-affinity is like not putting all your eggs in one basket. If you have 20 eggs and only 4 baskets, you put 5 in each. If one basket falls, you lose 5 eggs, not 20. Kubernetes anti-affinity does this with your application pods across physical servers.

## The Service Resource: Creating a Stable Address

```yaml
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  selector:
    app: booking-service
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
  type: ClusterIP
```

A Kubernetes Service gives your 20 pods a single, stable DNS name: `booking-service.production.svc.cluster.local` (or just `booking-service` within the same namespace). When another service makes an HTTP call to `http://booking-service:3000`, Kubernetes automatically load-balances across all 20 pods. Pods come and go, but the Service DNS name stays the same.

**`type: ClusterIP`** means this Service is only accessible inside the cluster. External traffic comes through the API Gateway and Ingress, not directly to microservices.

## Horizontal Pod Autoscaler (HPA): Automatic Scaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: booking-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: booking-service
  minReplicas: 15
  maxReplicas: 40
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
    scaleUp:
      stabilizationWindowSeconds: 0
```

The HPA watches CPU utilization across all Booking Service pods. Here is what each field means:

- **`minReplicas: 15`**: Never go below 15 pods, even during quiet hours. This is our floor -- enough to handle baseline traffic without delay.
- **`maxReplicas: 40`**: Never go above 40, even during a massive spike. This is a cost safety net.
- **`averageUtilization: 70`**: If the average CPU usage across all pods exceeds 70%, add more pods. If it drops well below 70%, remove pods.
- **`scaleDown.stabilizationWindowSeconds: 300`**: Wait 5 minutes before scaling down. This prevents "flapping" -- rapidly scaling up and down as traffic oscillates. Scaling down too fast means you might remove pods that you need 30 seconds later.
- **`scaleUp.stabilizationWindowSeconds: 0`**: Scale up immediately. When traffic spikes, you cannot afford to wait 5 minutes. Every second of under-capacity means dropped requests.

> **Key Term:** **Horizontal Pod Autoscaler (HPA)** — A Kubernetes resource that automatically adjusts the number of pod replicas based on observed metrics (CPU, memory, or custom metrics). "Horizontal" scaling means adding more instances (as opposed to "vertical" scaling, which means giving a single instance more CPU/RAM).

## Pod Disruption Budget (PDB): Safe Maintenance

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: booking-service-pdb
  namespace: production
spec:
  minAvailable: "75%"
  selector:
    matchLabels:
      app: booking-service
```

When Kubernetes needs to drain a node (for OS updates, hardware maintenance, or scaling down the cluster), it evicts pods from that node. The PDB says: "You can evict Booking Service pods, but at least 75% of them must remain running at all times."

With 20 replicas, 75% means at least 15 must stay up. Kubernetes can evict at most 5 at a time. If draining a node would violate this constraint, Kubernetes waits.

> **What If You Skip This?** Without a PDB, a cluster upgrade could evict all 20 Booking Service pods from a node simultaneously during maintenance. For a brief window, you have zero capacity. Users see 503 errors. The PDB guarantees graceful degradation during infrastructure operations.

> **Checkpoint:** Can you explain the difference between a liveness probe and a readiness probe? Can you explain what `maxSurge` and `maxUnavailable` control during a rolling update? And can you explain why `scaleUp.stabilizationWindowSeconds` is 0 but `scaleDown.stabilizationWindowSeconds` is 300? If all three answers come easily, you understand Kubernetes deployments at a production level.

## Chapter 36 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Kubernetes | Container orchestration platform that manages deployment, scaling, and self-healing of your applications. |
| Deployment | A YAML manifest that declares "run N replicas of this container image with these resources." |
| Rolling Update | Gradually replace old pods with new ones so that users never experience downtime during deployments. |
| Resource requests/limits | Requests guarantee minimum CPU/RAM; limits cap maximum usage to prevent runaway pods. |
| Liveness probe | "Are you alive?" -- restart the pod if it becomes unresponsive. |
| Readiness probe | "Can you serve traffic?" -- remove from load balancer if not ready. |
| HPA | Automatically scales pod count based on CPU (or custom metrics) within min/max bounds. |
| PDB | Guarantees a minimum number of available pods during voluntary disruptions like node maintenance. |
| Anti-affinity | Spreads pods across different physical servers so a single server failure does not take out all replicas. |

---

# Chapter 37: CI/CD Pipeline — From Code to Production

## The Manual Deployment Nightmare

Here is how many developers deploy early in their careers:

1. Finish a feature on your laptop.
2. Push to GitHub.
3. SSH into the server.
4. Run `git pull`.
5. Run `npm install` (and pray nothing changed).
6. Run `npm run build`.
7. Restart the server with `pm2 restart all`.
8. Refresh the browser and hope it works.

This process has at least five things wrong with it:

- **No tests run before deploy.** You might be shipping a bug.
- **No consistency.** The server might have different Node version, different npm packages, or stale environment variables.
- **No rollback.** If step 7 breaks the app, you have to manually figure out which commit was last working and roll back.
- **One person is a bottleneck.** Only the person with SSH access can deploy.
- **It does not scale.** Try doing this across 4 regions, 7 services, and 132 Kubernetes nodes. It is physically impossible.

CI/CD (Continuous Integration / Continuous Deployment) automates all of this into a pipeline that runs every time someone pushes code.

> **Analogy:** Think of CI/CD as a factory assembly line for your code. Raw materials (your code changes) enter one end. The assembly line runs quality checks (tests, linting), builds the product (Docker image), tests it in a staging environment, and if everything passes, delivers it to the customer (production). No human touches the product between raw material and delivery. Every step is automated, repeatable, and logged.

> **Key Term:** **CI (Continuous Integration)** — The practice of automatically building and testing code every time a developer pushes changes. The goal: catch bugs within minutes of introduction, not days later.
>
> **CD (Continuous Deployment)** — The practice of automatically deploying code to production after it passes all automated checks. The goal: ship features and fixes to users in hours, not weeks.

## The Pipeline: Stage by Stage

Here is the GitLab CI configuration for our Booking Service. I will walk through every stage.

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build
  - deploy-staging
  - deploy-production
```

These four stages run **sequentially**. If any stage fails, the pipeline stops. Code never reaches production without passing every prior stage. Think of them as quality gates:

```
 Push code ──> [TEST] ──> [BUILD] ──> [DEPLOY STAGING] ──> [DEPLOY PRODUCTION]
                 |           |              |                       |
              Fail? STOP  Fail? STOP    Fail? STOP           Manual trigger
```

### Stage 1: Test

```yaml
test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run lint
    - npm run test:unit
    - npm run test:integration
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'
```

This stage runs in a fresh Docker container (`node:20`) every time. Here is what each command does:

- **`npm ci`**: Like `npm install`, but stricter. It uses the exact versions from `package-lock.json` and fails if the lock file is out of sync with `package.json`. This guarantees that the CI environment installs the same packages you have locally. (`ci` stands for "clean install.")
- **`npm run lint`**: Runs ESLint to catch code style issues, potential bugs (unused variables, implicit any types), and formatting inconsistencies. If linting fails, the pipeline stops. This is not about aesthetics -- linting catches real bugs.
- **`npm run test:unit`**: Runs unit tests. These test individual functions and classes in isolation, with external dependencies mocked. They should run in under 30 seconds.
- **`npm run test:integration`**: Runs integration tests. These spin up test databases and actually test service interactions. They take longer (1-3 minutes) but catch problems that unit tests miss, like incorrect SQL queries or wrong Kafka message formats.
- **`coverage`**: Extracts the test coverage percentage from the output. GitLab displays this on the merge request so reviewers can see if the change reduced coverage.

> **What If You Skip This?** Without automated tests in CI, bugs reach production. At our scale (132 nodes, 4 regions), a production bug affects millions of users and costs real money. The test stage catches most bugs for the cost of 2-3 minutes of compute time. That is the best bargain in software engineering.

### Stage 2: Build

```yaml
build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build -t $REGISTRY/booking-service:$CI_COMMIT_SHA .
    - docker push $REGISTRY/booking-service:$CI_COMMIT_SHA
  only:
    - main
    - develop
```

This stage creates a Docker image and pushes it to our container registry. Let me break it down:

- **`image: docker:24`**: The build itself runs inside a Docker container. Yes, we are building Docker images *inside* Docker. That is what `docker:24-dind` (Docker-in-Docker) enables.
- **`$CI_COMMIT_SHA`**: The full git commit hash (e.g., `a1b2c3d4e5f6...`). Every image is tagged with the exact commit that produced it. This means you can always trace a running container back to the specific code change that created it. No ambiguity.
- **`docker build`**: Reads the `Dockerfile` in the project root, installs dependencies, compiles TypeScript, and packages everything into a container image.
- **`docker push`**: Uploads the image to the container registry (like Docker Hub or AWS ECR), where Kubernetes can pull it during deployment.
- **`only: main, develop`**: Only build images for the `main` and `develop` branches. Feature branches run tests but do not create deployable images -- there is no point building a Docker image for a branch that is not going to be deployed.

> **Key Term:** **Container registry** — A server that stores Docker images, like a library for container images. When Kubernetes needs to run the Booking Service, it pulls the image from the registry. AWS ECR, Google Container Registry, and Docker Hub are common registries.

### Stage 3: Deploy to Staging

```yaml
deploy-staging:
  stage: deploy-staging
  script:
    - kubectl set image deployment/booking-service
        booking-service=$REGISTRY/booking-service:$CI_COMMIT_SHA -n staging
    - kubectl rollout status deployment/booking-service -n staging
  only:
    - develop
```

Staging is a copy of production that receives real-ish traffic (or synthetic traffic) but does not affect real users. Here is what happens:

- **`kubectl set image`**: Tells Kubernetes "update the Booking Service deployment in the `staging` namespace to use the image we just built." Kubernetes begins a rolling update.
- **`kubectl rollout status`**: Waits for the rolling update to complete successfully. If the new pods crash on startup (bad config, missing env var, database migration failure), this command exits with an error, and the pipeline fails. The broken image never reaches production.
- **`only: develop`**: Only the `develop` branch deploys to staging. This is where QA tests new features before they are merged to `main`.

### Stage 4: Deploy to Production

```yaml
deploy-production:
  stage: deploy-production
  script:
    - kubectl apply -f k8s/booking-service-green.yaml
    - ./scripts/run-smoke-tests.sh green
    - kubectl patch service booking-service
        -p '{"spec":{"selector":{"version":"green"}}}'
  when: manual
  only:
    - main
```

Production deployment uses a **blue-green** strategy. This is the most cautious approach:

- **`kubectl apply -f k8s/booking-service-green.yaml`**: Deploy the new version as a separate "green" deployment alongside the existing "blue" one. At this point, both versions are running, but only "blue" receives user traffic.
- **`./scripts/run-smoke-tests.sh green`**: Run smoke tests against the "green" deployment directly. These are a handful of critical-path tests: can it create a booking? Can it process a payment? Can it respond to a health check? If any fail, the pipeline stops. The "green" deployment is deleted. Users never saw it.
- **`kubectl patch service`**: If smoke tests pass, switch the Kubernetes Service selector from `version: blue` to `version: green`. Traffic now flows to the new version. The old "blue" deployment stays running for a few minutes as a rollback target.
- **`when: manual`**: This stage requires a human to click "Deploy" in the GitLab UI. Fully automated production deployments are possible, but at this scale, having a human confirm the deploy adds a safety net.

> **Analogy:** Blue-green deployment is like a theater with two stages. While the audience watches the show on Stage A (blue), the crew sets up the next scene on Stage B (green). When Stage B is ready and tested, the spotlight swings to Stage B. If something goes wrong on Stage B, the spotlight can swing back to Stage A in seconds. The audience barely notices.

> **Key Term:** **Blue-green deployment** — A deployment strategy where two identical environments (blue and green) exist. One serves live traffic while the other receives the new version. After validation, traffic is switched. Rollback is instant: just switch back.

## The Full Pipeline in Action

Here is what happens when a developer pushes a commit:

```
09:01  Developer pushes commit a1b2c3d to `develop` branch
09:01  GitLab detects the push, starts the pipeline
09:01  [TEST] Stage begins
09:02    npm ci completes (cached dependencies: 15 seconds)
09:02    npm run lint passes (8 seconds)
09:03    npm run test:unit passes (22 seconds, 847 tests, 94% coverage)
09:04    npm run test:integration passes (68 seconds, 124 tests)
09:04  [TEST] Stage passes (total: ~3 minutes)

09:04  [BUILD] Stage begins
09:05    docker build completes (multi-stage build, 52 seconds)
09:05    docker push completes (14 seconds, layer caching helps)
09:06  [BUILD] Stage passes (total: ~2 minutes)

09:06  [DEPLOY STAGING] Stage begins
09:06    kubectl set image triggers rolling update
09:07    New pods start, pass readiness probes
09:08    kubectl rollout status confirms all pods healthy
09:08  [DEPLOY STAGING] Stage passes (total: ~2 minutes)

09:08  Pipeline complete. Total: ~7 minutes from push to staging.

---  Later that day, after QA approves ---

14:30  Code is merged to `main` branch
14:30  Pipeline runs TEST and BUILD stages again (same steps)
14:37  [DEPLOY PRODUCTION] Stage is pending (manual trigger)
14:45  Tech lead clicks "Deploy" in GitLab UI
14:46  Green deployment created alongside blue
14:48  Smoke tests pass against green
14:48  Traffic switched from blue to green
14:50  Production deployment complete. Total: ~5 minutes from click.
```

> **Checkpoint:** Can you explain why the test stage uses `npm ci` instead of `npm install`? Can you describe the difference between the staging deployment strategy (rolling update) and the production deployment strategy (blue-green)? And can you explain why production deployment is `when: manual` while staging is automatic? If you can articulate all three, you understand CI/CD pipelines at a professional level.

## Chapter 37 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| CI (Continuous Integration) | Automatically run tests and linting on every push to catch bugs within minutes. |
| CD (Continuous Deployment) | Automatically build, package, and deploy passing code to staging and production. |
| Pipeline stages | Sequential quality gates (test, build, deploy-staging, deploy-production) where failure at any stage halts the pipeline. |
| Docker image tagging | Every image is tagged with the git commit SHA for perfect traceability from running container to source code. |
| Blue-green deployment | Run the new version alongside the old, validate it, then switch traffic; rollback is instant. |
| Manual production gate | A human confirms production deployments as a safety net at scale. |
| Smoke tests | A small set of critical-path tests run against the new version before it receives real traffic. |

---

# Chapter 38: Infrastructure as Code — Servers as Configuration Files

## The Problem With Clicking Buttons

If you have used AWS, you have probably created resources through the web console. Click "Create Database", fill out a form, choose an instance type, set the password, click "Create." It works. The database exists. You move on.

Now do that 16 times for 16 MySQL shards. Now add 4 read replicas to each (64 more databases). Now do it in 4 AWS regions. Now do it again in 6 months when you need to change a parameter across all of them. Now imagine someone accidentally deletes one through the console and you need to recreate it with the exact same settings.

This is where clicking breaks down. It does not scale. It is not repeatable. It is not versioned. It introduces **configuration drift** -- the gradual divergence between what your infrastructure should look like and what it actually looks like because someone changed a setting in one region but forgot the other three.

> **Analogy:** Imagine the difference between cooking from a recipe and cooking from memory. With a recipe (Infrastructure as Code), you get the exact same dish every time, anyone can make it, and you can hand the recipe to a new chef when you go on vacation. Cooking from memory (clicking in the console) works once, but you cannot reproduce it exactly, you definitely cannot explain every step to someone else, and six months later you have forgotten half the seasoning.

> **Key Term:** **Infrastructure as Code (IaC)** — The practice of defining all infrastructure (servers, databases, networks, DNS records) in version-controlled configuration files rather than creating them manually through web consoles or CLI commands. The configuration file *is* the infrastructure specification.

> **Key Term:** **Configuration drift** — When the actual state of your infrastructure diverges from the intended state, usually because someone made a manual change that was not reflected in the configuration files. It leads to "works in staging but not production" bugs and makes disaster recovery unreliable.

## Terraform: The Infrastructure Recipe Book

**Terraform** is a tool by HashiCorp that lets you write infrastructure specifications in a language called **HCL** (HashiCorp Configuration Language). You describe what you want, and Terraform figures out how to create it, update it, or destroy it.

Here is the workflow:

```
1. You write:     "I want a MySQL database with 128 GB RAM"  (in HCL)
2. `terraform plan`:  "Here's what I'll create/change/destroy. OK?"
3. `terraform apply`: "Done. The database exists now."
4. The state is saved: Terraform remembers what it created
5. You change the file: "Actually, 256 GB RAM"
6. `terraform plan`:   "I'll modify the existing database's RAM. OK?"
7. `terraform apply`:  "Done. RAM is now 256 GB."
```

The magic of step 6 is that Terraform knows the database already exists (because it tracks **state**). It does not try to create a second one. It modifies the existing one.

> **What If You Skip This?** Without IaC, recreating your infrastructure after a disaster (region outage, accidental deletion, security breach requiring full rebuild) takes days or weeks of manual work -- if you can even remember all the settings. With Terraform, you run `terraform apply` from a fresh environment and your entire infrastructure is rebuilt in minutes. This is not hypothetical. AWS regions have gone down. Companies that had IaC recovered in hours. Companies that did not suffered outages lasting days.

## Reading the Terraform Code

Let me walk through our Terraform module for creating a MySQL shard. This is real HCL code, and I will explain every block.

### Variables: The Inputs

```hcl
# terraform/modules/mysql-shard/main.tf

variable "shard_number" {
  type = number
}

variable "region" {
  type = string
}

variable "instance_class" {
  type    = string
  default = "db.r6g.4xlarge"
}
```

Variables are like function parameters. When we call this module, we pass in a shard number and a region. The instance class has a default but can be overridden.

Think of this module as a function:

```typescript
// Pseudo-code equivalent
function createMySQLShard(
  shardNumber: number,
  region: string,
  instanceClass: string = "db.r6g.4xlarge"
) { ... }
```

We call this module 16 times (once per shard) with different shard numbers. Same recipe, different ingredients.

### The Primary Database

```hcl
resource "aws_db_instance" "primary" {
  identifier     = "booking-shard-${var.shard_number}-primary"
  engine         = "mysql"
  engine_version = "8.0"
  instance_class = var.instance_class

  allocated_storage     = 3000    # 3 TB
  max_allocated_storage = 6000    # Can grow to 6 TB automatically
  storage_type          = "io2"   # High-performance SSD
  iops                  = 64000   # 64,000 I/O operations per second

  db_name  = "booking_shard_${var.shard_number}"
  username = "booking_admin"
  password = data.aws_secretsmanager_secret_version.db_password.secret_string

  multi_az               = true   # Automatic failover to another AZ
  backup_retention_period = 35    # Keep backups for 35 days

  vpc_security_group_ids = [aws_security_group.db.id]
  db_subnet_group_name   = aws_db_subnet_group.db.name

  parameter_group_name = aws_db_parameter_group.booking.name

  tags = {
    Environment = "production"
    Shard       = var.shard_number
    Region      = var.region
    ManagedBy   = "terraform"
  }
}
```

Let me decode the important pieces:

- **`identifier`**: A unique name for this database instance. Terraform uses string interpolation (`${var.shard_number}`) just like JavaScript template literals. Shard 5 becomes `booking-shard-5-primary`.
- **`allocated_storage` / `max_allocated_storage`**: Start with 3 TB, auto-grow up to 6 TB. RDS (AWS Relational Database Service) handles the growth automatically when you are running low. You do not get paged at 3 AM because the disk is full.
- **`multi_az: true`**: AWS runs a standby copy in a different Availability Zone (a separate data center within the same region). If the primary data center loses power, AWS automatically promotes the standby. This is your first line of defense against hardware failure.
- **`backup_retention_period: 35`**: AWS automatically takes daily snapshots and keeps them for 35 days. If you discover a data corruption today that happened two weeks ago, you can restore from a backup.
- **`password`**: Note that the password comes from `aws_secretsmanager_secret_version`, not a hardcoded string. Secrets never appear in Terraform files.
- **`tags.ManagedBy = "terraform"`**: This tag tells everyone (and automated tools) that this resource was created by Terraform. If someone tries to modify it manually through the AWS console, they know they should modify the Terraform code instead.

### Read Replicas

```hcl
resource "aws_db_instance" "replica" {
  count = 4

  identifier          = "booking-shard-${var.shard_number}-replica-${count.index + 1}"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.instance_class

  tags = {
    Environment  = "production"
    Shard        = var.shard_number
    Role         = "replica"
    ReplicaIndex = count.index + 1
  }
}
```

- **`count = 4`**: Create 4 replicas. This single line creates 4 database instances. If you need to change to 6 replicas, you change `4` to `6`, run `terraform apply`, and Terraform creates 2 more. Try doing that through the AWS console for 16 shards.
- **`replicate_source_db`**: Points to the primary instance. AWS automatically sets up replication -- data written to the primary is asynchronously copied to all 4 replicas.
- **`count.index`**: Like the index in a `for` loop, starting at 0. The `+ 1` makes replica names 1-indexed (replica-1, replica-2, etc.).

### Database Parameter Group

```hcl
resource "aws_db_parameter_group" "booking" {
  family = "mysql8.0"
  name   = "booking-shard-${var.shard_number}"

  parameter {
    name  = "innodb_buffer_pool_size"
    value = "107374182400"  # 100 GB
  }

  parameter {
    name  = "max_connections"
    value = "5000"
  }

  parameter {
    name  = "innodb_flush_log_at_trx_commit"
    value = "1"
  }
}
```

These are MySQL configuration settings that you would normally set in `my.cnf`:

- **`innodb_buffer_pool_size = 100 GB`**: InnoDB (MySQL's storage engine) keeps frequently accessed data in RAM. With 128 GB of instance RAM, we dedicate 100 GB to this buffer. More buffer pool means more data served from memory instead of disk = faster queries.
- **`max_connections = 5000`**: Allow up to 5,000 simultaneous database connections. Each microservice instance holds a connection pool; with 20+ pods talking to each shard, we need this headroom.
- **`innodb_flush_log_at_trx_commit = 1`**: The most durable setting. Every transaction is flushed to disk immediately upon commit. Slower than the alternatives (0 or 2), but guarantees zero data loss on crash. For a payment system, this is non-negotiable.

## Helm Chart Values: Kubernetes Configuration

While Terraform manages cloud infrastructure (databases, networks, load balancers), **Helm** manages Kubernetes application configurations. Think of Helm as "Terraform for Kubernetes resources."

```yaml
# helm/booking-service/values.yaml
replicaCount: 20

image:
  repository: registry.company.com/booking-service
  tag: latest
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 3000

resources:
  requests:
    cpu: 1000m
    memory: 2Gi
  limits:
    cpu: 2000m
    memory: 4Gi

autoscaling:
  enabled: true
  minReplicas: 15
  maxReplicas: 40
  targetCPUUtilizationPercentage: 70

env:
  NODE_ENV: production
  PORT: "3000"

secrets:
  - name: DATABASE_URL
    secretName: booking-service-secrets
    key: database-url
  - name: REDIS_URL
    secretName: booking-service-secrets
    key: redis-url

probes:
  liveness:
    path: /health
    initialDelaySeconds: 30
  readiness:
    path: /ready
    initialDelaySeconds: 10
```

This values file feeds into a Helm **chart** (a template). The chart generates the Kubernetes YAML we saw in Chapter 36 -- the Deployment, Service, HPA, and PDB -- but parameterized. You can override any value for different environments:

```bash
# Deploy to staging with fewer replicas and smaller resources
helm install booking-service ./helm/booking-service \
  --set replicaCount=3 \
  --set resources.requests.cpu=500m \
  --set autoscaling.enabled=false \
  -n staging

# Deploy to production with the full configuration
helm install booking-service ./helm/booking-service \
  -f helm/booking-service/values.yaml \
  -n production
```

> **Key Term:** **Helm** — A package manager for Kubernetes. Helm charts are reusable templates that generate Kubernetes manifests from parameterized values. Instead of maintaining separate YAML files for staging and production, you maintain one chart with different value files.

> **Checkpoint:** Can you explain the difference between Terraform and Helm? (Hint: one manages cloud infrastructure, the other manages Kubernetes resources.) Can you explain why `innodb_flush_log_at_trx_commit = 1` matters for a payment system? And can you explain what the `ManagedBy: terraform` tag communicates to other engineers? If you can answer all three, you understand Infrastructure as Code at a practical level.

## Chapter 38 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Infrastructure as Code | Define all infrastructure in version-controlled files, not through manual console clicks. |
| Configuration drift | The enemy of reliability: when actual infrastructure diverges from intended infrastructure. |
| Terraform | Declare what cloud resources you want (databases, networks, etc.) and Terraform creates/updates/destroys them. |
| Terraform state | Terraform tracks what it has created so it can update existing resources instead of duplicating them. |
| Terraform modules | Reusable infrastructure templates, like functions; call the same module 16 times for 16 database shards. |
| Helm | A templating system for Kubernetes manifests; one chart, different values for different environments. |
| Parameter groups | Database configuration (buffer pool size, max connections) managed as code, not set manually. |
| Disaster recovery | With IaC, you can rebuild an entire region from code; without it, you are reconstructing from memory. |

---

# Chapter 39: Local Development Setup — Running Everything on Your Laptop

## The Goal: Two Minutes to a Working System

You have just joined the team. You have cloned the repository. Now what?

In the old monolith days, you would run `npm install && npm start` and you were done. In our microservices world, the Booking Service depends on MySQL, Redis, Kafka, Elasticsearch, and Jaeger (for tracing). Without all of these running, the service crashes on startup with connection errors.

You could install each of these on your laptop natively. MySQL installer, Redis from Homebrew, Kafka with its 47 configuration files... an hour later, you are still debugging why Kafka will not start because your Java version is wrong.

Or you could use **Docker Compose**, which starts everything with a single command. That is what we are going to do.

> **Analogy:** Docker Compose is like a recipe card that says "For this meal, you need: an oven preheated to 375, a skillet on medium heat, a blender, and a stand mixer." Instead of buying and installing each appliance yourself, Docker Compose provisions all of them from a shared warehouse (Docker Hub), configures them, and starts them up. When you are done, it cleans everything up. Your kitchen stays clean.

> **Key Term:** **Docker Compose** — A tool for defining and running multi-container Docker applications. You write a `docker-compose.yml` file listing all the services your application depends on, and `docker-compose up` starts all of them with the correct configuration, networking, and storage.

## The Docker Compose File: Every Service Explained

Here is our complete `docker-compose.yml`. I will walk through every service definition because you will be reading and modifying this file daily.

```yaml
# docker-compose.yml
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: rootpassword
      MYSQL_DATABASE: booking_dev
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./scripts/init-db.sql:/docker-entrypoint-initdb.d/init.sql
    command: --default-authentication-plugin=mysql_native_password
```

**MySQL** -- Our main database.

- **`image: mysql:8.0`**: Pull the official MySQL 8.0 image from Docker Hub. This is the same MySQL version we run in production.
- **`MYSQL_ROOT_PASSWORD: rootpassword`**: Sets the root password. In local development, simplicity wins. Do not use "rootpassword" anywhere except your laptop.
- **`MYSQL_DATABASE: booking_dev`**: Automatically creates a database called `booking_dev` on first start.
- **`ports: "3306:3306"`**: Map port 3306 on your laptop to port 3306 in the container. This lets you connect with any MySQL client (DataGrip, TablePlus, `mysql` CLI) using `localhost:3306`.
- **`volumes: mysql_data:/var/lib/mysql`**: A named volume that persists your data between container restarts. Without this, every `docker-compose down && docker-compose up` would wipe your database.
- **`volumes: ./scripts/init-db.sql`**: A SQL file that runs automatically on first startup. It creates the tables, indexes, and initial data. The path `/docker-entrypoint-initdb.d/` is a special directory that MySQL's Docker image scans on initialization.
- **`command: --default-authentication-plugin=mysql_native_password`**: MySQL 8.0 defaults to a new authentication plugin (`caching_sha2_password`) that some client libraries do not support. This flag switches back to the compatible one.

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

**Redis** -- Our cache and session store.

- **`redis:7-alpine`**: The Alpine variant is a tiny Linux image (~5 MB vs ~50 MB for the full image). It contains the same Redis, just on a smaller base OS. Faster to download, less disk space.
- **`ports: "6379:6379"`**: You can connect with `redis-cli` or Redis Insight using `localhost:6379`.

Notice there is no volume for Redis. In local development, we do not need Redis data to survive restarts. If you restart Redis, the cache is empty, and that is fine -- the services will repopulate it.

```yaml
  kafka:
    image: confluentinc/cp-kafka:7.5.0
    environment:
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:29093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_LOG_DIRS: /tmp/kraft-combined-logs
      CLUSTER_ID: 'MkU3OEVBNTcwNTJENDM2Qk'
    ports:
      - "9092:9092"
```

**Kafka** -- Our event streaming platform. This is the most configuration-heavy service, so let me decode every environment variable.

- **`KAFKA_NODE_ID: 1`**: Each Kafka node needs a unique ID. We only have one node locally.
- **`KAFKA_PROCESS_ROLES: broker,controller`**: In production, brokers and controllers are separate servers (Chapter 35). Locally, we combine them into a single node for simplicity. This node acts as both the event storage (broker) and the metadata manager (controller).
- **`KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093`**: The list of controller nodes. In production, this is three nodes. Locally, it is just this one node voting for itself.
- **`KAFKA_LISTENERS`**: The network interfaces Kafka listens on. `PLAINTEXT://0.0.0.0:9092` handles normal client connections. `CONTROLLER://0.0.0.0:29093` handles internal controller communication.
- **`KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092`**: The address Kafka tells clients to connect to. Because your NestJS service runs on your laptop (not inside Docker), it needs to reach Kafka at `localhost:9092`.
- **`CLUSTER_ID`**: A pre-generated ID for the KRaft cluster. In production, you generate this once with `kafka-storage.sh random-uuid`. Locally, we hardcode it so the cluster initializes consistently.

Notice: **no ZooKeeper**. This is KRaft mode. One fewer service to run locally.

> **What If You Skip This?** If you forget to set `KAFKA_ADVERTISED_LISTENERS` correctly, your NestJS service will try to connect to Kafka at the container's internal address (which is not reachable from your laptop). You will see `Connection refused` errors and spend an hour debugging. The advertised listener is the single most common Kafka configuration mistake in local development.

```yaml
  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
```

**Elasticsearch** -- Our search engine.

- **`discovery.type=single-node`**: In production, Elasticsearch runs as a multi-node cluster for redundancy. Locally, one node is enough.
- **`xpack.security.enabled=false`**: Disable authentication. In local development, you do not want to deal with usernames and passwords for every search query.
- **`ES_JAVA_OPTS=-Xms512m -Xmx512m`**: Elasticsearch runs on the JVM and is notoriously memory-hungry. This limits it to 512 MB of heap. Without this limit, Elasticsearch would happily consume 2+ GB of your laptop's RAM.

```yaml
  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"
      - "4318:4318"
```

**Jaeger** -- Our distributed tracing tool.

- **Port 16686**: The Jaeger UI. Open `http://localhost:16686` in your browser to see traces -- the full journey of a request across services.
- **Port 4318**: The OpenTelemetry collector endpoint. Your NestJS services send trace data here.

Jaeger is invaluable for debugging microservices. When a booking request takes 5 seconds instead of 200 ms, you open Jaeger, find the trace, and see exactly which service call took 4.8 seconds. Without it, you are reading log files from four different services trying to correlate timestamps.

```yaml
volumes:
  mysql_data:
```

**Named volumes**: This declares a Docker-managed volume called `mysql_data`. Docker stores it somewhere on your filesystem (you do not need to know where). It survives `docker-compose down` (which stops and removes containers) but is deleted by `docker-compose down -v` (the `-v` flag explicitly removes volumes).

## Starting the Environment

Open a terminal and run:

```bash
docker-compose up -d
```

The `-d` flag runs everything in the background (detached mode). Without it, your terminal is consumed by log output from all five services.

The first time, Docker downloads all the images. This takes 2-5 minutes depending on your internet connection. Subsequent starts take under 10 seconds because the images are cached.

To check that everything is running:

```bash
docker-compose ps
```

You should see all five services with state `Up`. If any say `Restarting` or `Exit`, check the logs:

```bash
docker-compose logs kafka     # Check Kafka logs specifically
docker-compose logs --tail 50 # Last 50 lines from all services
```

To stop everything:

```bash
docker-compose down           # Stop and remove containers (data preserved)
docker-compose down -v        # Stop, remove containers, AND delete data
```

## The Seed Script: Realistic Test Data

An empty database is useless for development. You cannot test a booking flow if there are no hotels, no rooms, and no inventory. The seed script populates the database with realistic test data.

```typescript
// scripts/seed-dev-data.ts

async function seedDevelopmentData() {
  console.log('Seeding development database...');

  // Create lookup tables
  await db.execute(`
    INSERT INTO booking_types (code, name) VALUES
    ('hotel', 'Hotel'), ('flight', 'Flight'), ('car', 'Car Rental')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  await db.execute(`
    INSERT INTO currencies (code, name, symbol) VALUES
    ('USD', 'US Dollar', '$'), ('EUR', 'Euro', '\u20AC'),
    ('GBP', 'British Pound', '\u00A3'), ('JPY', 'Japanese Yen', '\u00A5')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  await db.execute(`
    INSERT INTO payment_providers (code, name, is_active) VALUES
    ('stripe', 'Stripe', TRUE), ('paypal', 'PayPal', TRUE)
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  // Create sample inventory for the next 30 days
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    await db.execute(`
      INSERT INTO inventory (
        resource_type, resource_id, resource_date,
        total_quantity, available_quantity, base_price, currency
      )
      VALUES ('hotel_room', 1, ?, 20, 20, 150.00, 'USD')
      ON DUPLICATE KEY UPDATE total_quantity = 20
    `, [dateStr]);
  }

  console.log('Seed data complete.');
}
```

Let me walk through what this creates:

**Lookup tables**: Booking types (hotel, flight, car), currencies (USD, EUR, GBP, JPY), and payment providers (Stripe, PayPal). The `ON DUPLICATE KEY UPDATE` clause is important -- it means you can run the seed script multiple times without errors. If the data already exists, it updates it instead of failing with a duplicate key error. This is called **idempotency**, and it is a pattern you will use everywhere in distributed systems.

**Inventory data**: Creates 30 days of hotel room inventory starting from today. Each day has 20 rooms available at $150/night. This gives you enough data to test search, availability checks, and booking flows without manually inserting rows.

Run the seed script after Docker Compose is up:

```bash
npx ts-node scripts/seed-dev-data.ts
```

## Verifying Everything Works

After `docker-compose up -d` and running the seed script, verify each service:

| Service | How to Verify | Expected Result |
|---------|--------------|-----------------|
| **MySQL** | `mysql -h localhost -u root -prootpassword -e "SHOW DATABASES;"` | See `booking_dev` in the list |
| **Redis** | `redis-cli ping` | `PONG` |
| **Kafka** | `docker-compose exec kafka kafka-topics --list --bootstrap-server localhost:9092` | Empty list (topics created by services on startup) |
| **Elasticsearch** | Open `http://localhost:9200` in browser | JSON with cluster name and version |
| **Jaeger** | Open `http://localhost:16686` in browser | Jaeger UI with empty trace list |

Once all five are verified, start your NestJS services:

```bash
# In separate terminals (or use a tool like concurrently)
cd booking-service && npm run start:dev
cd inventory-service && npm run start:dev
cd payment-service && npm run start:dev
```

Your services will connect to the Docker Compose infrastructure automatically (they are configured to use `localhost` with the default ports).

> **What If You Skip This?** If you skip the local development setup, every code change requires deploying to a shared staging environment. Deployments take minutes, and you are competing with other developers for the same staging resources. Debugging is harder because you cannot set breakpoints or inspect local state. Docker Compose gives you a private, isolated copy of the entire system on your laptop. Use it.

> **Checkpoint:** Can you explain why Kafka's `KAFKA_ADVERTISED_LISTENERS` is set to `localhost:9092` in Docker Compose? Can you explain what `ON DUPLICATE KEY UPDATE` does in the seed script and why it matters? And can you list all five infrastructure services and what port each one listens on? If you can, you are ready to start developing against this system.

## Chapter 39 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| Docker Compose | Defines and runs all infrastructure dependencies (MySQL, Redis, Kafka, Elasticsearch, Jaeger) with one command. |
| Named volumes | Persist database data across container restarts so you do not lose your test data. |
| KRaft mode locally | Kafka runs without ZooKeeper in local development, matching the production configuration. |
| Advertised listeners | Critical Kafka setting: tells clients (your services on localhost) how to connect to the broker. |
| Seed script | Populates the database with realistic test data; idempotent so it can be safely re-run. |
| Verification checklist | After startup, verify each service responds on its expected port before starting application services. |
| Single-node everything | Local development uses single instances of every dependency; production uses clusters. The code does not change. |
