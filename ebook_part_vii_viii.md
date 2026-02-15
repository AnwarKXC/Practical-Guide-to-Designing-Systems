# PART VII: INFRASTRUCTURE & DEPLOYMENT

Moving from architecture and application design to the physical infrastructure that runs the Global Booking System, this part addresses the operational realities of deploying and maintaining a system that processes 1,666 bookings per second across four geographic regions. Capacity planning, Kubernetes orchestration, CI/CD pipelines, Infrastructure as Code, and local development environments are not afterthoughts -- they are first-class engineering concerns that determine whether the system survives its first traffic spike or collapses under load.

The sections that follow take a "why before how" approach to infrastructure. Section 31 begins with capacity planning and cost analysis, because sizing decisions made before a single line of Terraform is written determine whether the system over-spends on idle resources or under-provisions and suffers outages. Section 32 covers Kubernetes deployment manifests that encode production-hardened patterns -- init containers, pod anti-affinity, disruption budgets -- that distinguish a weekend project from a production-grade platform. Section 33 walks through the CI/CD pipeline that gates every deployment with tests, builds, and smoke checks, because at this scale a broken deploy across 132 nodes can cost millions in lost bookings.

Section 34 introduces Infrastructure as Code with Terraform and Helm, ensuring that every resource is version-controlled and reproducible -- if a region is destroyed, it can be recreated from code. Finally, Section 35 covers local development setup with Docker Compose, because developers who cannot run the system locally cannot iterate quickly. Together, these five sections bridge the gap between "the architecture works on a whiteboard" and "the architecture works in production under real traffic."

---

## 31. Capacity Planning & Cost Analysis

> **Learning Objectives**
> - Understand how to model traffic patterns including peak load, geographic distribution, and seasonal variation
> - Learn how to size database, Redis, Kafka, and Kubernetes clusters based on throughput requirements
> - Recognize why KRaft mode replaces ZooKeeper in modern Kafka deployments and the cost savings it provides
> - Calculate per-booking infrastructure cost and total system cost across multiple regions
> - Evaluate trade-offs between over-provisioning (wasted spend) and under-provisioning (outage risk)

**Why:** Understanding infrastructure costs and capacity limits is essential for budget planning and ensuring the system can handle peak loads without over-provisioning. Without this analysis, teams either over-spend on idle resources or under-provision and suffer outages during peak traffic. Every dollar of infrastructure cost must be justified by the traffic it serves.

### Traffic Model

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
    'us-east-1': 0.35,
    'eu-west-1': 0.30,
    'ap-southeast-1': 0.25,
    'sa-east-1': 0.10
  },
  seasonal: {
    highSeason: { months: [6, 7, 8, 12], multiplier: 1.8 },
    lowSeason: { months: [1, 2, 3, 9, 10, 11], multiplier: 0.8 }
  },
  bookingTypes: {
    hotel: 0.45, flight: 0.35, car: 0.15, package: 0.05
  }
};
```

### Database Capacity

**Why:** The database is the most expensive and hardest-to-scale component. Sizing it correctly avoids both wasted spend and emergency migrations under load.

```typescript
export const databaseCapacity = {
  shards: 16,
  instanceType: 'db.r6g.4xlarge',
  specs: {
    vcpus: 16,
    memory: '128 GB',
    network: '10 Gbps',
    storage: {
      type: 'io2',
      size: '3 TB per shard',
      iops: 64000
    }
  },
  replication: {
    readReplicas: 4,       // per shard
    crossRegionReplicas: 1 // per shard
  },
  capacity: {
    writesPerSecond: 4000, // per shard
    readsPerSecond: 16000, // per shard (across replicas)
    totalWritesPerSecond: 64000,
    totalReadsPerSecond: 256000
  },
  monthlyCost: {
    primaryInstances: 16 * 2400,      // $38,400
    readReplicas: 16 * 4 * 2400,      // $153,600
    crossRegionReplicas: 16 * 3200,   // $51,200
    storage: 16 * 5 * 1000,           // $80,000
    iops: 16 * 5 * 640,              // $51,200
    backups: 16 * 800,               // $12,800
    dataTransfer: 16 * 7300,         // $116,800
    total: 504000                     // ~$504,000/month
  }
};
```

### Redis Capacity

**Why:** Redis serves multiple distinct workloads (sessions, locks, caching, rate limiting). Isolating them into separate clusters prevents a cache stampede from affecting distributed locking.

```typescript
export const redisCapacity = {
  clusters: {
    sessions: {
      nodeType: 'cache.r6g.xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200
    },
    fencing: {
      nodeType: 'cache.r6g.xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 4200
    },
    cache: {
      nodeType: 'cache.r6g.2xlarge',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 5400
    },
    rateLimiting: {
      nodeType: 'cache.r6g.large',
      nodes: 6,
      shards: 3,
      replicasPerShard: 1,
      maxConnections: 65000,
      monthlyCost: 3600
    }
  },
  totalMonthlyCost: 17400  // ~$17,400/month
};
```

### Kafka Capacity (KRaft Mode)

**Why:** Kafka is the backbone of event-driven communication between services. Correct broker sizing determines whether events flow in real time or back up during peak load. Using KRaft mode (Kafka 3.3+) eliminates the operational overhead of maintaining a separate ZooKeeper ensemble.

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
      'log.retention.hours': 720,
      'compression.type': 'lz4',
      'min.insync.replicas': 2
    }
  },

  // KRaft mode -- NO ZooKeeper needed (Kafka 3.3+)
  controller: {
    mode: 'KRaft',
    description: 'Kafka Raft consensus replaces ZooKeeper for metadata management',
    controllerNodes: 3,  // Dedicated controller nodes
    configuration: {
      'process.roles': 'controller',
      'controller.quorum.voters': '1@controller-1:9093,2@controller-2:9093,3@controller-3:9093',
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
    'booking-events': { partitions: 200, replicationFactor: 3, retentionDays: 30 },
    'payment-events': { partitions: 100, replicationFactor: 3, retentionDays: 90 },
    'inventory-events': { partitions: 150, replicationFactor: 3, retentionDays: 7 },
    'inventory-reservations-global': { partitions: 100, replicationFactor: 3, retentionDays: 1 },
    'notification-events': { partitions: 80, replicationFactor: 3, retentionDays: 3 }
  },

  monthlyCost: {
    brokers: 15000,
    controllers: 900,      // 3 KRaft controllers (much cheaper than ZooKeeper)
    storage: 12000,
    dataTransfer: 5000,
    total: 32900            // Saved $600/month vs ZooKeeper
  }
};
```

> **Common Mistake: Using ZooKeeper with Kafka 3.3+**
> An earlier version of this architecture specified a 5-node ZooKeeper ensemble for Kafka metadata management. Since Kafka 3.3+ (and production-ready in 3.5+), ZooKeeper has been deprecated in favor of KRaft (Kafka Raft) mode. KRaft eliminates the operational overhead of maintaining a separate ZooKeeper cluster, provides faster metadata operations, and reduces infrastructure cost. Always use KRaft mode for new deployments.

### Kubernetes Capacity

**Why:** K8s node sizing determines how many pods can be scheduled per node. Under-sizing leads to scheduling failures during scale-up events; over-sizing wastes money on idle CPU.

```typescript
export const k8sCapacity = {
  nodesPerRegion: {
    workerNodes: {
      instanceType: 'c6i.4xlarge',
      count: 30,
      specs: { cpu: 16, memory: '32 GB' }
    },
    systemNodes: {
      instanceType: 'm6i.2xlarge',
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

### Total System Cost Summary

**Why:** Knowing the total cost per booking lets the business set pricing floors and evaluate the ROI of infrastructure investments.

```typescript
export const totalSystemCost = {
  monthly: {
    database: 504000,
    redis: 17400,
    kafka: 32900,        // KRaft mode (no ZooKeeper -- saved $1,500/month)
    kubernetes: 72500,
    cdn: 25000,
    monitoring: 15000,
    logging: 12000,
    dns: 2000,
    secrets: 1000,
    cicd: 3000,
    support: 15000,
    miscellaneous: 10000,
    reserveBuffer: 150000,

    subtotal: 859800,
    regions: 4,
    multiRegionMultiplier: 1.7,  // Not all services replicate fully

    total: 1470000               // ~$1.47M/month
  },

  perBooking: {
    monthlyBookings: 70000000,   // ~70M bookings/month
    costPerBooking: 0.021        // ~$0.021 per booking
  },

  annualTotal: 17640000          // ~$17.6M/year
};
```

### Key Takeaways

- The database is the single largest cost center (~$504K/month), driven by 16 shards with 4 read replicas each and cross-region replication. Sizing it correctly is the highest-leverage cost decision.
- Isolating Redis into four purpose-specific clusters (sessions, fencing, cache, rate limiting) costs marginally more than a single cluster but prevents catastrophic cross-workload interference.
- KRaft mode eliminates ZooKeeper entirely for Kafka 3.3+ deployments, reducing both operational complexity and infrastructure cost by ~$1,500/month.
- The total system cost of ~$1.47M/month yields a per-booking cost of $0.021 -- a number the business needs to set pricing floors and evaluate infrastructure ROI.
- The 1.7x multi-region multiplier reflects the reality that not all services replicate fully across all four regions; some resources (CDN, DNS) are inherently global.

### Review Questions

1. **Conceptual:** Why are Redis workloads (sessions, fencing, cache, rate limiting) separated into distinct clusters rather than served by a single large cluster? What failure scenario does this isolation prevent?
2. **Code Reading:** In the `trafficModel` configuration, the seasonal high-season multiplier is 1.8 and the peak bookings-per-second is 1,666. What is the effective peak bookings-per-second during high season, and how should this number influence your capacity planning?
3. **Conceptual:** The `multiRegionMultiplier` is 1.7 rather than 4.0 (the number of regions). Explain why total cost does not scale linearly with the number of regions.

### Hands-On Exercise

**Exercise: Build a Capacity Cost Calculator.** Using the `totalSystemCost` configuration as your baseline, write a TypeScript function `estimateMonthlyCost(bookingsPerMonth: number, regions: number): { totalCost: number, costPerBooking: number }` that scales each infrastructure component proportionally to the number of bookings (relative to the 70M baseline) and the number of regions (using the 1.7x multiplier logic). Test it with inputs of 35M bookings / 2 regions and 140M bookings / 4 regions, and verify that the per-booking cost changes non-linearly due to fixed costs like DNS and support.

---

## 32. Kubernetes Deployment

> **Learning Objectives**
> - Understand the purpose of each component in a production Kubernetes manifest: Deployment, Service, HPA, and PodDisruptionBudget
> - Learn how init containers, liveness/readiness probes, and preStop hooks ensure safe deployments and graceful shutdowns
> - Recognize why pod anti-affinity rules distribute replicas across nodes for fault tolerance
> - Understand HPA scaling behavior configuration including stabilization windows
> - Read and interpret resource requests and limits for CPU and memory

**Why:** Kubernetes provides declarative infrastructure, auto-scaling, self-healing, and rolling deployments. Each microservice runs as a Deployment with HPA for automatic scaling. The manifests below encode production-hardened patterns: init containers for migrations, anti-affinity for fault tolerance, graceful shutdown via preStop hooks, and pod disruption budgets for safe node maintenance.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: production
spec:
  replicas: 20
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 5
      maxUnavailable: 2
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
---
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
---
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
---
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

### Key Takeaways

- The `preStop` hook with `sleep 15` gives in-flight requests time to complete before the pod is terminated, preventing dropped connections during rolling updates.
- Pod anti-affinity with `topologyKey: kubernetes.io/hostname` ensures that booking-service replicas are spread across different nodes, so a single node failure does not take down multiple replicas.
- The HPA uses asymmetric stabilization windows -- scale-up is immediate (`0` seconds) to respond to traffic spikes, while scale-down waits 300 seconds to avoid thrashing during fluctuating load.
- The PodDisruptionBudget guarantees that at least 75% of pods remain available during voluntary disruptions (node drains, cluster upgrades), preventing maintenance operations from causing outages.
- Init containers run database migrations before the main container starts, ensuring the application never boots against an outdated schema.

### Review Questions

1. **Code Reading:** The Deployment specifies `maxSurge: 5` and `maxUnavailable: 2` with `replicas: 20`. During a rolling update, what is the maximum number of pods that can exist simultaneously, and what is the minimum number that will be serving traffic?
2. **Conceptual:** Why does the readiness probe use a different path (`/ready`) than the liveness probe (`/health`)? What is the operational difference between a pod that fails its readiness probe versus one that fails its liveness probe?
3. **Conceptual:** The HPA's `scaleDown.stabilizationWindowSeconds` is 300 but `scaleUp.stabilizationWindowSeconds` is 0. Why is this asymmetry intentional, and what problem would symmetric scale-down at 0 seconds cause?

### Hands-On Exercise

**Exercise: Add a Memory-Based HPA Metric.** Extend the HorizontalPodAutoscaler manifest to include a second metric that scales based on memory utilization at 80%. Then add a new `topologySpreadConstraints` section to the Deployment that enforces a `maxSkew` of 1 across availability zones (using `topology.kubernetes.io/zone` as the topology key). Write out the complete modified YAML and explain how the two scaling metrics interact -- specifically, which metric "wins" when CPU is below threshold but memory is above.

---

## 33. CI/CD Pipeline

> **Learning Objectives**
> - Understand the four-stage CI/CD pipeline structure: test, build, deploy-staging, deploy-production
> - Learn why blue-green deployment with manual production gates is essential at scale
> - Recognize the role of smoke tests in validating a deployment before traffic switching
> - Understand how container image tagging by commit SHA ensures traceability from deployment back to source code
> - Evaluate the cost of a broken deployment across 132 nodes and 4 regions

**Why:** Continuous integration catches bugs early. Continuous deployment gets fixes to production quickly. At this scale, every deployment must be safe, reversible, and observable. A broken deploy to 132 nodes across 4 regions can cost millions in lost bookings, so the pipeline enforces gates at every stage.

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build
  - deploy-staging
  - deploy-production

test:
  stage: test
  image: node:20
  script:
    - npm ci
    - npm run lint
    - npm run test:unit
    - npm run test:integration
  coverage: '/Lines\s*:\s*(\d+\.\d+)%/'

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

deploy-staging:
  stage: deploy-staging
  script:
    - kubectl set image deployment/booking-service booking-service=$REGISTRY/booking-service:$CI_COMMIT_SHA -n staging
    - kubectl rollout status deployment/booking-service -n staging
  only:
    - develop

deploy-production:
  stage: deploy-production
  script:
    - kubectl apply -f k8s/booking-service-green.yaml
    - ./scripts/run-smoke-tests.sh green
    - kubectl patch service booking-service -p '{"spec":{"selector":{"version":"green"}}}'
  when: manual
  only:
    - main
```

### Key Takeaways

- Tagging container images with `$CI_COMMIT_SHA` instead of `latest` creates a direct link from any running pod back to the exact source commit, making debugging and rollback trivial.
- The production deployment uses a blue-green strategy: the "green" version is deployed and smoke-tested before traffic is switched, so a failed smoke test never reaches real users.
- The `when: manual` gate on production deployment ensures a human reviews staging results before production rollout -- automation handles execution, but a human owns the decision.
- The test stage runs linting, unit tests, and integration tests in sequence; a failure at any step blocks the build, preventing known-broken code from being containerized.
- Staging deployment uses `kubectl rollout status` to block the pipeline until the rollout completes or fails, providing immediate feedback rather than silent failures.

### Review Questions

1. **Code Reading:** The `build` stage runs on both `main` and `develop` branches, but `deploy-staging` only runs on `develop` and `deploy-production` only on `main`. Trace the path a feature takes from a developer's branch to production -- what are all the gates it must pass?
2. **Conceptual:** Why does the production deployment apply a separate `booking-service-green.yaml` manifest and run smoke tests before patching the service selector, rather than using `kubectl set image` directly as the staging deployment does?
3. **Conceptual:** If the smoke tests fail after `kubectl apply -f k8s/booking-service-green.yaml` but before `kubectl patch service`, what is the state of the system? Is production affected? How would you clean up the failed green deployment?

### Hands-On Exercise

**Exercise: Add a Canary Stage.** Insert a `deploy-canary` stage between `deploy-staging` and `deploy-production` in the GitLab CI pipeline. The canary stage should: (1) deploy the new version to 5% of production pods using a separate canary Deployment, (2) run a 10-minute observation window checking error rate and p99 latency via a `./scripts/check-canary-metrics.sh` script, and (3) automatically roll back the canary if metrics exceed thresholds. Write the complete YAML for this new stage and explain how it reduces the blast radius of a bad deployment compared to the current blue-green approach.

---

## 34. Infrastructure as Code

> **Learning Objectives**
> - Understand why all infrastructure must be defined in code for reproducibility, version control, and disaster recovery
> - Learn how Terraform modules encapsulate reusable infrastructure patterns like database shards with replicas
> - Read Terraform HCL and understand resource relationships, variables, and parameter groups
> - Understand how Helm chart values externalize Kubernetes configuration for environment-specific overrides
> - Recognize the relationship between Terraform (infrastructure provisioning) and Helm (application deployment)

**Why:** All infrastructure should be defined in code for reproducibility, version control, and disaster recovery. If a region is destroyed, we should be able to recreate it from code. Manual infrastructure changes are forbidden -- every resource is managed by Terraform and every application configuration by Helm.

### Terraform Module: MySQL Shard

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

resource "aws_db_instance" "primary" {
  identifier     = "booking-shard-${var.shard_number}-primary"
  engine         = "mysql"
  engine_version = "8.0"
  instance_class = var.instance_class

  allocated_storage     = 3000
  max_allocated_storage = 6000
  storage_type          = "io2"
  iops                  = 64000

  db_name  = "booking_shard_${var.shard_number}"
  username = "booking_admin"
  password = data.aws_secretsmanager_secret_version.db_password.secret_string

  multi_az               = true
  backup_retention_period = 35

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

resource "aws_db_instance" "replica" {
  count = 4

  identifier          = "booking-shard-${var.shard_number}-replica-${count.index + 1}"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.instance_class

  tags = {
    Environment = "production"
    Shard       = var.shard_number
    Role        = "replica"
    ReplicaIndex = count.index + 1
  }
}

resource "aws_db_parameter_group" "booking" {
  family = "mysql8.0"
  name   = "booking-shard-${var.shard_number}"

  parameter {
    name  = "innodb_buffer_pool_size"
    value = "107374182400"  # 100GB
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

### Helm Chart Values

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

### Key Takeaways

- The Terraform module creates one primary instance and four replicas per shard using `count = 4`, matching the capacity plan from Section 31. Changing `count` to 6 would add replicas across all 16 shards simultaneously.
- The `innodb_buffer_pool_size` is set to 100GB (out of 128GB total memory) because InnoDB performance is directly proportional to how much of the working set fits in the buffer pool. This leaves 28GB for OS, connections, and other MySQL internals.
- `innodb_flush_log_at_trx_commit = 1` ensures every committed transaction is flushed to disk, trading throughput for durability -- the correct trade-off for a financial booking system.
- Helm values externalize environment-specific configuration (replica counts, resource limits, image tags) so the same chart can deploy to staging with 3 replicas and production with 20.
- The `ManagedBy = "terraform"` tag acts as a guard: if anyone manually modifies a resource in the AWS console, the tag mismatch makes the drift immediately visible during `terraform plan`.

### Review Questions

1. **Code Reading:** The Terraform module sets `max_allocated_storage = 6000` and `allocated_storage = 3000`. What does this achieve in AWS RDS, and why is it preferable to setting `allocated_storage = 6000` from the start?
2. **Conceptual:** The Helm values file sets `pullPolicy: IfNotPresent` but the CI/CD pipeline tags images with `$CI_COMMIT_SHA`. Why does this combination work correctly, and what would go wrong if images were tagged with `latest` instead?
3. **Code Reading:** The parameter group sets `max_connections = 5000`. Given that each shard has 1 primary + 4 replicas, and the booking service has up to 40 pods connecting to each shard, is 5000 connections sufficient? Show your reasoning.

### Hands-On Exercise

**Exercise: Write a Terraform Module for Redis Clusters.** Using the `redisCapacity` configuration from Section 31 as your specification, write a Terraform module (`terraform/modules/redis-cluster/main.tf`) that creates an ElastiCache Redis cluster. The module should accept variables for `cluster_name`, `node_type`, `num_shards`, `replicas_per_shard`, and `region`. Include a `aws_elasticache_replication_group` resource with automatic failover enabled and encryption at rest. Then write a `main.tf` that calls this module four times (once for each Redis workload: sessions, fencing, cache, rate limiting) with the appropriate values from Section 31.

---

## 35. Local Development Setup

> **Learning Objectives**
> - Understand why a local development environment must mirror production dependencies (MySQL, Redis, Kafka, Elasticsearch, Jaeger)
> - Learn how Docker Compose provides a single-command setup for all service dependencies
> - Recognize the use of KRaft mode in local Kafka configuration (no ZooKeeper container needed)
> - Understand the role of seed data scripts in ensuring consistent, reproducible development environments
> - Evaluate how volume mounts and init scripts automate database initialization

**Why:** Developers need a fast, consistent local environment that mirrors production. Docker Compose provides all dependencies locally so engineers can develop and test without cloud access. A developer should be able to clone the repo and run `docker-compose up` to have a working system in under two minutes.

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

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

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

  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"

  jaeger:
    image: jaegertracing/all-in-one:1.50
    ports:
      - "16686:16686"
      - "4318:4318"

volumes:
  mysql_data:
```

### Seed Data Script

**Why:** Every developer needs realistic test data to work with. A seed script ensures everyone starts from the same baseline, and new engineers can immediately see the system working end-to-end.

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
    ('USD', 'US Dollar', '$'), ('EUR', 'Euro', '€'),
    ('GBP', 'British Pound', '£'), ('JPY', 'Japanese Yen', '¥')
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  await db.execute(`
    INSERT INTO payment_providers (code, name, is_active) VALUES
    ('stripe', 'Stripe', TRUE), ('paypal', 'PayPal', TRUE)
    ON DUPLICATE KEY UPDATE name = VALUES(name)
  `);

  // Create sample inventory
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];

    await db.execute(`
      INSERT INTO inventory (resource_type, resource_id, resource_date, total_quantity, available_quantity, base_price, currency)
      VALUES ('hotel_room', 1, ?, 20, 20, 150.00, 'USD')
      ON DUPLICATE KEY UPDATE total_quantity = 20
    `, [dateStr]);
  }

  console.log('Seed data complete.');
}
```

### Key Takeaways

- The local Kafka container uses KRaft mode (`KAFKA_PROCESS_ROLES: broker,controller`) just like production, so developers work with the same architecture they will deploy to. There is no ZooKeeper container.
- MySQL uses a volume mount (`mysql_data`) for data persistence across container restarts, and an init script (`init-db.sql`) mounted into `/docker-entrypoint-initdb.d/` for automatic schema creation on first run.
- The seed script uses `ON DUPLICATE KEY UPDATE` for idempotency -- running it multiple times does not create duplicate data, which means developers can re-seed safely after schema changes.
- Elasticsearch runs in single-node mode with security disabled for local development simplicity. This is acceptable locally but must never be replicated in production configuration.
- Jaeger provides local distributed tracing on port 16686, allowing developers to visualize request flows across services without deploying a full observability stack.

### Review Questions

1. **Code Reading:** The Kafka container sets `KAFKA_PROCESS_ROLES: broker,controller` while production uses separate controller nodes with `process.roles: controller`. Why is combining broker and controller roles acceptable for local development but not for production?
2. **Conceptual:** The seed script creates 30 days of inventory data starting from "today." What problem does this create for automated tests that run on different dates, and how would you modify the script to make tests deterministic?
3. **Code Reading:** The Docker Compose file maps port `4318` for Jaeger. Looking at the OpenTelemetry standard, what protocol does this port serve, and how would the booking service be configured to send traces to this endpoint?

### Hands-On Exercise

**Exercise: Add a Health Check and Dependency Ordering.** Modify the Docker Compose file to add `healthcheck` definitions for MySQL (using `mysqladmin ping`) and Redis (using `redis-cli ping`). Then add `depends_on` with `condition: service_healthy` to the Kafka service (depends on nothing) and create a new `booking-service` container entry that depends on all four infrastructure services being healthy. Write the complete modified `docker-compose.yml` and test that `docker-compose up` starts services in the correct order.

---

# PART VIII: DEVELOPER REFERENCE

This part collects the reference material that engineers will reach for during day-to-day development: API documentation, code standards, testing strategies, event schema contracts, and a glossary of system-specific terminology. Unlike the preceding parts, which build knowledge sequentially from architecture through implementation to deployment, the sections here are designed for day-to-day reference, not sequential reading.

Section 36 documents the API surface -- endpoints, request/response formats, and error codes -- so that frontend teams and integration partners can work against a contract rather than reading source code. Section 37 codifies the development guidelines and code standards that keep a monorepo with six services consistent: project structure, dependency injection patterns, DTO validation, and error handling conventions. Section 38 covers the testing strategy at three levels (unit, integration, load), because at 1,666 bookings per second, a single untested edge case can corrupt inventory or double-charge customers.

Section 39 addresses schema registry and event contracts -- the rules that govern how producers and consumers agree on message formats and how schemas evolve without breaking downstream services. Finally, Section 40 provides a glossary of system-specific terminology and curated learning resources for deeper study. When a senior engineer says "fencing token" and a junior engineer hears "authentication token," the glossary resolves the ambiguity. Together, these five sections ensure that every engineer on the team has a shared vocabulary, shared standards, and a shared understanding of the system's external contracts.

---

## 36. API Documentation

> **Learning Objectives**
> - Understand the structure of the booking API including authentication, idempotency keys, and content types
> - Learn how to read HTTP request/response documentation and map it to client implementation
> - Recognize the full error code taxonomy and the HTTP status codes each maps to
> - Understand why idempotency keys are required for booking creation endpoints
> - Evaluate how clear API documentation reduces integration friction and support burden

**Why:** Clear API documentation reduces integration friction and support burden. Every endpoint documents its inputs, outputs, error codes, and authentication requirements. If a frontend or partner team has to read your source code to understand your API, you have failed at documentation.

### Create Booking

```http
POST /api/v1/bookings
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <unique-key>

{
  "bookingType": "hotel",
  "hotelId": 12345,
  "roomTypeId": 678,
  "checkIn": "2026-03-15",
  "checkOut": "2026-03-20",
  "roomsCount": 2,
  "guestsCount": 4,
  "rooms": [
    { "adultsCount": 2, "childrenCount": 0, "bedType": "king" },
    { "adultsCount": 1, "childrenCount": 1, "bedType": "queen" }
  ],
  "subtotal": 800.00,
  "taxAmount": 80.00,
  "discountAmount": 0.00,
  "totalAmount": 880.00,
  "currency": "USD",
  "paymentMethod": {
    "type": "credit_card",
    "provider": "stripe",
    "token": "tok_visa"
  }
}
```

#### Response (201 Created)

```json
{
  "success": true,
  "data": {
    "bookingId": 9876543210,
    "referenceCode": "HT-20260215-000042",
    "status": "confirmed",
    "totalAmount": 880.00,
    "currency": "USD",
    "createdAt": "2026-02-15T10:30:00Z"
  }
}
```

### Check Availability

```http
GET /api/v1/inventory/availability?resourceType=hotel_room&resourceId=12345&checkIn=2026-03-15&checkOut=2026-03-20&quantity=2
```

### Cancel Booking

```http
POST /api/v1/bookings/:id/cancel
Authorization: Bearer <token>

{ "reason": "user_cancelled", "reasonNotes": "Change of plans" }
```

### Error Codes

| Error Code | HTTP Status | Description |
|---|---|---|
| `INSUFFICIENT_INVENTORY` | 409 | Requested quantity exceeds available inventory |
| `PAYMENT_DECLINED` | 402 | Payment provider declined the transaction |
| `FRAUD_BLOCKED` | 403 | Booking blocked by fraud detection system |
| `INVALID_REQUEST` | 400 | Request body failed validation |
| `BOOKING_NOT_FOUND` | 404 | Booking ID does not exist |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Authenticated user lacks permission |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests; retry after cooldown |

### Key Takeaways

- The `Idempotency-Key` header is required on booking creation to prevent duplicate bookings from network retries. The server caches the result keyed by this value and returns the cached response for repeated requests.
- The cancellation endpoint uses `POST` rather than `DELETE` because cancellation is a business operation with a payload (reason, notes), not a simple resource deletion. The booking record is preserved for auditing.
- Error codes are domain-specific strings (`INSUFFICIENT_INVENTORY`, `FRAUD_BLOCKED`) rather than generic HTTP status codes, giving clients enough detail to display meaningful user-facing messages and implement retry logic.
- The `referenceCode` in the response follows a pattern (`HT-20260215-000042`) that encodes booking type, date, and sequence number, making it human-readable for customer support interactions.
- The availability check is a `GET` request with query parameters, making it cacheable by CDNs and browser caches -- a deliberate design choice given the 70/30 read/write ratio.

### Review Questions

1. **Conceptual:** Why does `INSUFFICIENT_INVENTORY` return HTTP 409 (Conflict) rather than 400 (Bad Request) or 422 (Unprocessable Entity)? What does 409 communicate to the client that the other codes do not?
2. **Code Reading:** The Create Booking request includes both `subtotal`, `taxAmount`, `discountAmount`, and `totalAmount`. Why does the API accept all four values from the client rather than computing `totalAmount` server-side? What validation should the server perform on these values?
3. **Conceptual:** Both `FRAUD_BLOCKED` and `FORBIDDEN` return HTTP 403. How should a client distinguish between these two error conditions, and why is it important to handle them differently?

### Hands-On Exercise

**Exercise: Design the Booking Modification API.** The current API supports Create, Cancel, and Check Availability but lacks a Modify Booking endpoint. Design a `PATCH /api/v1/bookings/:id` endpoint that allows changing dates and room count. Document: (1) the request format with only the fields that can be modified, (2) the response format including the updated totals, (3) at least three new error codes specific to modification (e.g., `MODIFICATION_WINDOW_CLOSED`, `PRICE_CHANGED`), and (4) the idempotency behavior. Write the complete HTTP documentation in the same style as the existing endpoints above.

---

## 37. Development Guidelines & Code Standards

> **Learning Objectives**
> - Understand the monorepo structure and how apps, libs, infra, and tests are organized
> - Learn why NestJS dependency injection makes services testable and enforces separation of concerns
> - Recognize how DTO validation with class-validator decorators prevents invalid data from reaching business logic
> - Understand the Result pattern as an alternative to exceptions for expected failure cases
> - Learn how custom exception classes carry domain-specific context for precise error messages

**Why:** Consistent code structure across services reduces onboarding time and makes code reviews efficient. These patterns are conventions, not suggestions. When every service follows the same structure, any engineer can jump into any service and be productive within hours instead of days.

### Monorepo Structure

```
booking-platform/
├── apps/
│   ├── api-gateway/
│   ├── booking-service/
│   ├── inventory-service/
│   ├── payment-service/
│   ├── fraud-service/
│   └── notification-service/
├── libs/
│   ├── database/
│   ├── kafka/
│   ├── redis/
│   ├── monitoring/
│   └── common/
├── infra/
│   ├── terraform/
│   ├── kubernetes/
│   └── docker/
├── scripts/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

### NestJS Dependency Injection

**Why:** Dependency injection makes services testable by allowing mock implementations in tests. It also enforces separation of concerns -- each class declares what it needs, and the framework wires everything together.

```typescript
// Dependency injection
@Injectable()
export class BookingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly inventoryService: InventoryService,
    private readonly paymentService: PaymentService,
    private readonly logger: Logger
  ) {}
}
```

### DTO Validation

**Why:** Validating inputs at the boundary prevents garbage data from reaching business logic. Using decorators keeps validation co-located with the data structure it validates.

```typescript
// DTO validation with class-validator
export class CreateBookingDto {
  @IsNotEmpty()
  @IsEnum(BookingType)
  bookingType: BookingType;

  @IsPositive()
  resourceId: number;

  @IsISO8601()
  checkIn: string;

  @IsISO8601()
  checkOut: string;

  @ValidateNested()
  @Type(() => PaymentMethodDto)
  paymentMethod: PaymentMethodDto;
}
```

### Result Pattern for Error Handling

**Why:** Throwing exceptions for expected outcomes (like "inventory unavailable") makes control flow hard to follow. The Result pattern makes success and failure explicit in the type system, forcing callers to handle both cases.

```typescript
// Result pattern
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: Error };
```

### Custom Exception Classes

**Why:** Custom exceptions carry context that generic errors cannot. When an `InsufficientInventoryError` reaches the error handler, it knows exactly what resource was requested, how many were wanted, and how many were available -- enabling precise error messages and debugging.

```typescript
// Custom exceptions
export class InsufficientInventoryError extends Error {
  constructor(
    public readonly resourceType: string,
    public readonly resourceId: bigint,
    public readonly requested: number,
    public readonly available: number
  ) {
    super(`Insufficient inventory for ${resourceType}:${resourceId}`);
    this.name = 'InsufficientInventoryError';
  }
}
```

### Key Takeaways

- The monorepo separates `apps/` (deployable services), `libs/` (shared code), `infra/` (Terraform/K8s/Docker), and `tests/` (test suites). Shared libraries in `libs/` prevent code duplication across services while keeping deployment units independent.
- NestJS dependency injection via constructor parameters means that unit tests can replace `DatabaseService` with a mock, `InventoryService` with a stub, and `Logger` with a no-op -- testing pure business logic without infrastructure.
- The Result pattern (`{ success: true; data: T } | { success: false; error: Error }`) is used for expected failure cases (inventory unavailable, payment declined), while exceptions are reserved for unexpected errors (database connection lost, null pointer). This distinction keeps control flow readable.
- DTO validation decorators like `@IsISO8601()` and `@ValidateNested()` run automatically in the NestJS validation pipe, rejecting malformed requests before they reach the service layer. This is boundary validation, not business validation.
- Custom exception classes like `InsufficientInventoryError` carry structured fields (`resourceType`, `requested`, `available`) that error handlers use to construct precise API error responses and structured log entries.

### Review Questions

1. **Code Reading:** The `BookingService` constructor declares four dependencies: `DatabaseService`, `InventoryService`, `PaymentService`, and `Logger`. In a unit test, which of these would you mock and which (if any) could you use as real implementations? Why?
2. **Conceptual:** The Result pattern and custom exceptions both handle errors. When should `BookingService.createBooking()` return `{ success: false, error: ... }` versus throwing an `InsufficientInventoryError`? What principle governs this decision?
3. **Code Reading:** The `CreateBookingDto` uses `@IsISO8601()` for `checkIn` and `checkOut`. What value would fail this validation, and what additional business validation (not captured by the decorator) must the service layer still perform on these dates?

### Hands-On Exercise

**Exercise: Create a PaymentDeclinedError Class and Result-Based Handler.** Write a `PaymentDeclinedError` custom exception class that includes fields for `provider`, `declineCode`, `declineReason`, and `retryable: boolean`. Then write a `processBookingPayment()` function that calls `paymentService.charge()`, catches any `PaymentDeclinedError`, and returns a `Result<PaymentConfirmation>` instead of throwing. Include a unit test that verifies: (1) a successful charge returns `{ success: true, data: ... }`, (2) a retryable decline returns `{ success: false, error: ... }` with `retryable: true`, and (3) an unexpected error (e.g., network timeout) is re-thrown rather than wrapped in a Result.

---

## 38. Testing Strategy

> **Learning Objectives**
> - Understand the three-tier testing strategy: unit tests, integration tests, and load tests
> - Learn how to structure unit tests with mocked dependencies to isolate business logic
> - Recognize how integration tests verify real service communication including HTTP, database, and Kafka interactions
> - Understand load test phase design (warmup, ramp, peak, cooldown) and scenario weighting
> - Evaluate why each testing tier catches different categories of bugs that the others miss

**Why:** At production scale, untested code is a liability. Unit tests verify logic. Integration tests verify service interactions. Load tests verify capacity. A single untested edge case in the booking flow can silently corrupt inventory or double-charge customers at 1,666 bookings per second.

### Unit Tests

**Why:** Unit tests run in milliseconds and catch logic errors before code reaches CI. They mock all external dependencies so failures point to the code under test, not infrastructure.

```typescript
// Unit Test
describe('BookingService', () => {
  let bookingService: BookingService;
  let inventoryService: jest.Mocked<InventoryService>;
  let paymentService: jest.Mocked<PaymentService>;

  beforeEach(() => {
    inventoryService = {
      checkAvailability: jest.fn(),
      createHold: jest.fn(),
      confirmHold: jest.fn(),
      releaseHold: jest.fn()
    } as any;

    paymentService = {
      processPayment: jest.fn()
    } as any;

    bookingService = new BookingService(inventoryService, paymentService);
  });

  it('should create booking successfully', async () => {
    inventoryService.checkAvailability.mockResolvedValue(true);
    inventoryService.createHold.mockResolvedValue({ id: 1n });
    paymentService.processPayment.mockResolvedValue({ id: 2n });

    const result = await bookingService.createBooking(mockDto);

    expect(result.status).toBe('confirmed');
    expect(inventoryService.createHold).toHaveBeenCalledTimes(1);
  });

  it('should rollback hold if payment fails', async () => {
    inventoryService.checkAvailability.mockResolvedValue(true);
    inventoryService.createHold.mockResolvedValue({ id: 1n });
    paymentService.processPayment.mockRejectedValue(new PaymentDeclinedError('Declined'));

    await expect(bookingService.createBooking(mockDto)).rejects.toThrow();
    expect(inventoryService.releaseHold).toHaveBeenCalledWith(1n, expect.any(String), expect.any(String));
  });
});
```

### Integration Tests

**Why:** Integration tests verify that real services communicate correctly -- that HTTP endpoints accept the right payloads, that database queries return expected results, and that Kafka messages are consumed. They catch issues that unit tests miss: serialization bugs, query errors, and configuration problems.

```typescript
// Integration Test
describe('Booking Flow Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  it('should complete full booking flow', async () => {
    // Check availability
    const avail = await request(app.getHttpServer())
      .get('/api/v1/inventory/availability')
      .query({ resourceType: 'hotel_room', resourceId: 12345 })
      .expect(200);

    expect(avail.body.data.available).toBe(true);

    // Create booking
    const booking = await request(app.getHttpServer())
      .post('/api/v1/bookings')
      .set('Authorization', 'Bearer test_token')
      .set('Idempotency-Key', 'test_key_123')
      .send({ bookingType: 'hotel', hotelId: 12345 })
      .expect(201);

    expect(booking.body.data.bookingId).toBeDefined();
  });
});
```

### Load Testing Strategy

**Why:** Load tests are the only way to validate that the system actually handles 1,666 bookings/second before real users hit it. They reveal bottlenecks that do not appear at low concurrency: connection pool exhaustion, lock contention, and GC pauses.

```typescript
export const loadTestPlan = {
  phases: [
    { duration: '5m', arrivalRate: 10, name: 'Warmup' },
    { duration: '10m', arrivalRate: 100, name: 'Ramp up' },
    { duration: '30m', arrivalRate: 1666, name: 'Peak load' },
    { duration: '10m', arrivalRate: 500, name: 'Cool down' }
  ],
  scenarios: {
    searchAndBook: {
      weight: 60,
      flow: ['searchHotels', 'viewDetails', 'checkAvailability', 'createBooking']
    },
    searchOnly: {
      weight: 30,
      flow: ['searchHotels', 'viewDetails']
    },
    manageBooking: {
      weight: 10,
      flow: ['getBooking', 'cancelBooking']
    }
  }
};
```

### Key Takeaways

- The unit test for "rollback hold if payment fails" verifies the saga compensation pattern: when payment is declined after inventory is held, the hold must be released. This is the most critical edge case in the booking flow.
- Integration tests use `Test.createTestingModule` to boot the full NestJS application with real modules, catching issues that mocks hide: serialization mismatches, middleware ordering, and guard configuration.
- The load test plan uses a realistic scenario mix (60% search-and-book, 30% search-only, 10% manage-booking) rather than hammering a single endpoint, because production traffic is heterogeneous and bottlenecks shift depending on the request mix.
- The 5-minute warmup phase at 10 requests/second allows JIT compilation, connection pool initialization, and cache warming before the system is measured at peak load. Skipping warmup produces misleadingly bad results.
- Load tests must run for at least 30 minutes at peak to surface time-dependent issues like memory leaks, connection pool exhaustion, and log rotation failures that do not appear in short bursts.

### Review Questions

1. **Code Reading:** In the unit test, `inventoryService.releaseHold` is called with `(1n, expect.any(String), expect.any(String))`. What do the two `String` arguments likely represent, and why does the test use `expect.any(String)` rather than exact values?
2. **Conceptual:** The integration test sets `Idempotency-Key: 'test_key_123'`. What happens if this test runs twice without database cleanup between runs? How should integration tests handle idempotency keys to remain repeatable?
3. **Code Reading:** The load test scenario weights sum to 100 (60 + 30 + 10). At peak load of 1,666 requests/second, how many `createBooking` calls per second does the system receive? (Hint: the `searchAndBook` flow has 4 steps, only one of which is `createBooking`.)

### Hands-On Exercise

**Exercise: Write a Concurrency Unit Test.** The existing unit tests verify sequential behavior but do not test what happens when two bookings compete for the last available room. Write a unit test that: (1) mocks `inventoryService.checkAvailability` to return `true` for both calls, (2) mocks `inventoryService.createHold` to succeed the first time and throw `InsufficientInventoryError` the second time, (3) runs two `bookingService.createBooking()` calls concurrently using `Promise.all`, and (4) asserts that exactly one booking succeeds and one fails. This test verifies that the service correctly handles the race condition at the unit level.

---

## 39. Schema Registry & Event Contracts

> **Learning Objectives**
> - Understand why schema registries are essential in event-driven architectures to prevent breaking changes
> - Learn the distinction between allowed schema evolutions (adding optional fields) and forbidden ones (removing required fields)
> - Recognize how JSON Schema definitions enforce event structure at publish time
> - Understand the SchemaValidator middleware pattern for catching malformed events before they reach Kafka
> - Evaluate the process requirements for schema changes including PR review and backward compatibility

**Why:** In an event-driven system, producers and consumers must agree on message formats. Schema evolution rules prevent breaking changes from corrupting downstream services. Without a schema registry, a producer adding a field or changing a type can silently break every consumer, and the errors only surface at runtime -- potentially corrupting data before anyone notices.

### Event Schema Definitions

```typescript
// Event schema definitions using JSON Schema
export const eventSchemas = {
  'booking.created': {
    version: 1,
    schema: {
      type: 'object',
      required: ['bookingId', 'userId', 'bookingType', 'totalAmount', 'currency', 'timestamp'],
      properties: {
        bookingId: { type: 'integer' },
        userId: { type: 'integer' },
        bookingType: { type: 'string', enum: ['hotel', 'flight', 'car'] },
        totalAmount: { type: 'number', minimum: 0 },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        timestamp: { type: 'string', format: 'date-time' }
      },
      additionalProperties: false
    }
  },

  'inventory.reserved': {
    version: 1,
    schema: {
      type: 'object',
      required: ['resourceType', 'resourceId', 'quantity', 'fencingToken', 'region'],
      properties: {
        resourceType: { type: 'string', enum: ['hotel_room', 'flight_seat', 'car'] },
        resourceId: { type: 'integer' },
        quantity: { type: 'integer', minimum: 1 },
        fencingToken: { type: 'integer' },
        region: { type: 'string' }
      }
    }
  }
};
```

### Schema Evolution Rules

```typescript
// Schema evolution rules
export const schemaEvolutionRules = {
  allowed: [
    'Add optional fields',
    'Add new enum values at the end',
    'Widen numeric types (int → long)',
    'Add new event types'
  ],
  forbidden: [
    'Remove required fields',
    'Rename fields',
    'Change field types',
    'Remove enum values',
    'Change field from optional to required'
  ],
  process: [
    'All schema changes require PR review from platform team',
    'New versions must be backward compatible',
    'Consumers must handle unknown fields gracefully',
    'Breaking changes require new topic + migration plan'
  ]
};
```

### Schema Validator Middleware

**Why:** Validating every event at publish time catches schema violations before they reach Kafka. A malformed event caught at the producer is a log line; a malformed event caught at the consumer is a production incident.

```typescript
// Schema validator middleware
export class SchemaValidator {
  async validate(eventType: string, payload: any): Promise<ValidationResult> {
    const schema = eventSchemas[eventType];
    if (!schema) {
      return { valid: false, errors: [`Unknown event type: ${eventType}`] };
    }

    const ajv = new Ajv();
    const validate = ajv.compile(schema.schema);
    const valid = validate(payload);

    return {
      valid: valid as boolean,
      errors: validate.errors?.map(e => e.message!) || []
    };
  }
}
```

### Key Takeaways

- The `booking.created` schema sets `additionalProperties: false`, which rejects events with unexpected fields. This strict mode catches typos and unintended data leakage at publish time. The `inventory.reserved` schema omits this constraint, allowing forward-compatible extensions.
- Schema evolution rules draw a clear line: adding optional fields and new enum values is safe; removing fields, renaming fields, or changing types requires a new topic and a migration plan. This distinction protects consumers from silent breakage.
- The `SchemaValidator` middleware uses AJV (Another JSON Validator) to compile and validate schemas at runtime. Creating a new `Ajv()` instance per validation is correct for clarity but should be cached in production for performance.
- The `fencingToken` field in the `inventory.reserved` schema is typed as `integer`, connecting the event contract back to the distributed locking mechanism from Section 11. Consumers use this token to reject stale reservation events.
- The process rules require platform team review for all schema changes, ensuring that a single service team cannot unilaterally break downstream consumers by modifying a shared event contract.

### Review Questions

1. **Code Reading:** The `booking.created` schema marks `additionalProperties: false` but `inventory.reserved` does not. What practical difference does this create for schema evolution? Which approach is more restrictive, and when would you choose each?
2. **Conceptual:** The evolution rules allow "Add new enum values at the end" but forbid "Remove enum values." Why is adding safe but removing dangerous? What happens to a consumer that receives an enum value it does not recognize?
3. **Code Reading:** The `SchemaValidator.validate()` method creates a new `Ajv()` instance on every call. What performance problem does this create at 1,666 events/second, and how would you refactor the class to avoid it while still supporting dynamic schema registration?

### Hands-On Exercise

**Exercise: Implement Schema Version Migration.** The `booking.created` schema is at version 1. Design and implement a version 2 that adds an optional `loyaltyPoints: { type: 'integer', minimum: 0 }` field and a new enum value `'package'` to `bookingType`. Write: (1) the new schema definition, (2) a `SchemaRegistry` class that stores multiple versions and resolves the correct schema by event type and version, (3) a migration function that upgrades a v1 event to v2 format (setting `loyaltyPoints` to 0 as default), and (4) a unit test that validates a v1 event against the v1 schema and a v2 event against the v2 schema. Verify that a v1 event also passes v2 validation (backward compatibility).

---

## 40. Glossary & Learning Resources

> **Learning Objectives**
> - Build a shared vocabulary of system-specific terminology used throughout the Global Booking System architecture
> - Understand how each glossary term connects to the section where it is defined and used in depth
> - Identify curated learning resources for deeper study of distributed systems, microservices, and infrastructure
> - Recognize why a shared vocabulary prevents miscommunication between senior and junior engineers

**Why:** A shared vocabulary prevents miscommunication. These definitions are specific to this system's usage of industry terms. When a senior engineer says "fencing token" and a junior engineer hears "authentication token," bugs happen. This glossary is the single source of truth.

### Glossary

| Term | Definition |
|---|---|
| **Fencing Token** | Monotonically increasing number issued with each lock acquisition. The database rejects writes carrying a token lower than the currently stored one. (Section 11) |
| **Idempotency Key** | A deterministic hash of request parameters. Repeated requests with the same key return the cached result instead of creating duplicates. (Section 12) |
| **Outbox Pattern** | Writing events to a database table within the same transaction as business data. A publisher process reads and forwards to Kafka. Guarantees at-least-once delivery. (Section 14) |
| **Saga** | A sequence of local transactions where each step has a compensating action that undoes it. Used for distributed transactions across services. (Section 15) |
| **CQRS** | Command Query Responsibility Segregation. Separating write operations (MySQL) from read operations (Elasticsearch). (Section 16) |
| **Circuit Breaker** | A proxy that monitors failure rates and stops sending requests to a failing service, allowing it to recover. States: Closed -> Open -> Half-Open. (Section 17) |
| **Bulkhead** | Isolating service connections into separate pools so one failing service cannot exhaust resources needed by others. (Section 17) |
| **Event Sourcing** | Storing all state changes as immutable events rather than overwriting current state. Enables audit trails and time-travel debugging. (Section 3) |
| **Double-Entry Accounting** | Every financial transaction creates balanced journal entries (debits = credits). Enforced by database triggers. (Section 9) |
| **KRaft** | Kafka Raft consensus protocol that replaces ZooKeeper for Kafka metadata management. Production-ready since Kafka 3.5. (Section 31) |
| **DLQ (Dead Letter Queue)** | A queue for messages that failed processing after all retry attempts. Preserved for investigation and manual replay. (Section 21) |
| **SLO/SLI** | Service Level Objective (target) and Service Level Indicator (measurement). SLOs define how reliable we aim to be. (Section 28) |

### Learning Resources

**Books:**
- *Designing Data-Intensive Applications* by Martin Kleppmann -- Chapters on replication, partitioning, and transactions
- *Building Microservices* by Sam Newman -- Service decomposition and communication patterns
- *Release It!* by Michael Nygard -- Circuit breakers, bulkheads, and production resilience

**Distributed Systems:**
- Fencing tokens and distributed locking: Martin Kleppmann's blog "How to do distributed locking"
- CAP theorem: Brewer's original paper and its practical implications
- Saga pattern: Chris Richardson's microservices.io

**Infrastructure:**
- Kubernetes documentation: kubernetes.io
- Kafka documentation: kafka.apache.org (focus on KRaft mode)
- Terraform: HashiCorp Learn tutorials

### Key Takeaways

- Every glossary term includes a section reference (e.g., "Section 11", "Section 15") that links back to the detailed explanation, making the glossary a navigation tool as well as a definitions list.
- The glossary is scoped to this system's usage of industry terms. "Fencing token" here means specifically the monotonically increasing number used with distributed locks and database writes -- not a generic security token.
- The learning resources are curated, not exhaustive. Each book and reference is chosen because it directly explains a pattern used in this architecture: Kleppmann for data fundamentals, Newman for service decomposition, Nygard for production resilience.
- Terms like KRaft and DLQ reflect operational decisions documented earlier in the architecture. The glossary ensures that these acronyms have unambiguous definitions when used in incident reports, design reviews, and onboarding materials.
- This glossary should be treated as a living document. As new patterns are adopted (e.g., if the system adds GraphQL federation or gRPC), corresponding terms should be added with section references.
