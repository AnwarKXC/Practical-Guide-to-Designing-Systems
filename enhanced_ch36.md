# Chapter 36: Kubernetes Deployment — Your App in the Cloud

## Beyond `npm start`

Up to now, if someone asked you "how do you deploy your app?", your answer was probably one of these:

- "I push to GitHub, and Heroku/Railway auto-deploys."
- "I SSH into the server and run `git pull && npm start`."
- "I use pm2 to keep it running."

These work for a single service. But we have ten microservices, each needing multiple instances, automatic restarts when they crash, rolling updates with zero downtime, and the ability to scale from 5 instances to 40 instances in sixty seconds. None of those deployment methods can do all of that.

Enter **Kubernetes** (often abbreviated **K8s** -- "K", eight letters, "s").

> **Analogy:** Think of Docker containers as shipping containers -- standardized boxes that hold your application and everything it needs. Now imagine a massive shipping port with cranes, scheduling systems, and logistics. Docker gives you the container. Kubernetes is the entire port. It decides which ship (server) each container goes on, moves containers to new ships if one sinks, and can bring in more cranes when holiday season traffic picks up. You tell the port "I need 20 of these containers running at all times," and it handles the rest.

---

## Kubernetes Concepts: The Building Blocks

Before we dive into YAML files, you need a mental map of every Kubernetes resource we will use in this chapter. If you already know pods from deployments, skim this section -- but do not skip it entirely, because we define these terms precisely in the context of our booking system.

### Pods

> **Key Term:** **Pod** — The smallest deployable unit in Kubernetes. A pod is one or more containers that share networking and storage. In practice, most pods contain exactly one container (your application). Think of a pod as a lightweight VM that runs your `npm start` process.

A pod gets its own IP address inside the cluster. When the pod dies, that IP address is gone forever -- Kubernetes assigns a new IP to the replacement pod. This is why you never hardcode pod IPs. A pod is ephemeral by design.

### Deployments

> **Key Term:** **Deployment** — A controller that manages a set of identical pods. You tell a Deployment "run 20 copies of this container image," and it creates 20 pods, monitors their health, and replaces any that fail. When you push a new version, the Deployment rolls it out gradually.

Deployments are the workhorse of Kubernetes. Every one of our microservices -- Booking, Inventory, Payment, Notification, Search, Fraud Detection, Analytics, Event Store, User, and API Gateway -- runs as a Deployment.

### Services

> **Key Term:** **Service** — A stable network endpoint that load-balances traffic across a set of pods. Pods come and go, but a Service provides a fixed DNS name (`booking-service.production.svc.cluster.local`) that never changes.

Without a Service, you would need to track which of your 20 pods is alive and at what IP. A Service does that for you.

### Ingress

> **Key Term:** **Ingress** — A resource that manages external HTTP/HTTPS access to Services inside the cluster. It acts as a reverse proxy, routing requests based on hostname or URL path to the correct Service.

Our API Gateway receives traffic from an Ingress controller (NGINX Ingress or AWS ALB Ingress). No other microservice is exposed to the outside world.

### ConfigMaps

> **Key Term:** **ConfigMap** — A key-value store for non-sensitive configuration. Environment variables like `NODE_ENV=production`, `LOG_LEVEL=info`, and `REGION=us-east-1` belong in ConfigMaps, not baked into Docker images.

ConfigMaps let you change configuration without rebuilding or redeploying your container image. Change the log level from `info` to `debug`, apply the ConfigMap, and restart the pods.

### Secrets

> **Key Term:** **Secret** — Like a ConfigMap, but for sensitive data: database passwords, API keys, TLS certificates. Secrets are base64-encoded (not encrypted by default -- you need tools like Sealed Secrets or AWS Secrets Manager for encryption at rest).

A critical rule: never put secrets in your Deployment YAML. Never commit them to Git. Always reference them from a Secret resource, and manage that Secret through a secure pipeline.

---

## Our Kubernetes Architecture

Our Global Booking System runs on a multi-region Kubernetes cluster using Amazon EKS (Elastic Kubernetes Service). Here is the physical layout.

### Cluster Topology

```
4 Regions: us-east-1, eu-west-1, ap-southeast-1, ap-northeast-1

Per Region:
  30 Worker Nodes  (c6i.4xlarge: 16 vCPU, 32 GB RAM each)
   3 System Nodes  (m6i.2xlarge:  8 vCPU, 32 GB RAM each)
  ─────────────────────────────────────────────────────
  33 Nodes / Region  x  4 Regions  =  132 Nodes Total

Monthly Cost: ~$72,500 for Kubernetes infrastructure alone
```

Worker nodes run our application pods. System nodes run cluster-critical components: the Kubernetes control plane add-ons, monitoring (Prometheus, Grafana), logging (Fluentd, Elasticsearch), and the Istio service mesh control plane. Separating these prevents a monitoring spike from evicting your booking pods.

### Namespace Layout

Namespaces are logical partitions within a cluster. We use them to isolate environments, enforce resource quotas, and apply security policies.

```
Cluster Namespaces:
├── production          # Live traffic. All 10 microservices.
├── staging             # Pre-production mirror. Same manifests, fewer replicas.
├── development         # Shared dev environment for integration testing.
├── monitoring          # Prometheus, Grafana, Alertmanager, Loki.
├── logging             # Fluentd, Elasticsearch, Kibana (EFK stack).
├── istio-system        # Istio control plane (istiod, ingress gateway).
├── cert-manager        # Automated TLS certificate management.
├── kafka               # Kafka brokers and KRaft controllers.
└── kube-system         # Kubernetes internals (CoreDNS, kube-proxy, etc).
```

> **What If You Skip This?** Without namespace separation, a runaway load test in development can consume cluster resources and starve production pods. We have seen this happen. A developer ran a stress test that spun up 200 pods in a shared namespace. Production pods got evicted because the cluster ran out of memory. Namespace resource quotas prevent this.

### Resource Quotas Per Namespace

Resource quotas put hard limits on what each namespace can consume. Here is the quota for our production namespace.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: production-quota
  namespace: production
spec:
  hard:
    requests.cpu: "200"           # 200 CPU cores total
    requests.memory: 400Gi        # 400 GB RAM total
    limits.cpu: "400"             # burst ceiling
    limits.memory: 800Gi
    pods: "500"                   # max 500 pods in production
    services: "50"
    persistentvolumeclaims: "100"
```

And a much tighter quota for staging:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: staging-quota
  namespace: staging
spec:
  hard:
    requests.cpu: "40"
    requests.memory: 80Gi
    limits.cpu: "80"
    limits.memory: 160Gi
    pods: "100"
```

> **Key Term:** **ResourceQuota** — A Kubernetes resource that limits the total amount of compute, storage, and object count within a namespace. If a Deployment tries to create a pod that would exceed the quota, the creation fails with an error. Quotas prevent any single namespace from monopolizing cluster resources.

---

## The Full Deployment Manifest: Line by Line

Now let us walk through the complete, production-grade Deployment manifest for the Booking Service. This is the actual YAML our CI/CD pipeline applies to the cluster. I will explain every line.

```yaml
# ============================================================
# Booking Service — Production Deployment
# Applied by CI/CD pipeline on every merge to main
# ============================================================
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service
  namespace: production
  labels:
    app: booking-service
    team: booking
    version: v1
    tier: backend
  annotations:
    deployment.kubernetes.io/revision: "1"
    meta.helm.sh/release-name: booking-service
spec:
  replicas: 20
  revisionHistoryLimit: 5
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
        team: booking
        version: v1
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
        sidecar.istio.io/inject: "true"
    spec:
      serviceAccountName: booking-service
      terminationGracePeriodSeconds: 45

      # --- Init Container: Database Migrations ---
      initContainers:
        - name: db-migrations
          image: registry.company.com/booking-service:${VERSION}
          command: ['npm', 'run', 'migrate']
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 1000m
              memory: 1Gi
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url

      # --- Main Application Container ---
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:${VERSION}
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP

          # --- Resource Requests and Limits ---
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi

          # --- Environment Variables from ConfigMap ---
          envFrom:
            - configMapRef:
                name: booking-service-config

          # --- Sensitive Environment Variables from Secrets ---
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: database-url
            - name: REDIS_URL
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: redis-url
            - name: KAFKA_BROKERS
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: kafka-brokers
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: booking-service-secrets
                  key: jwt-secret

          # --- Startup Probe ---
          startupProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 5
            failureThreshold: 30

          # --- Liveness Probe ---
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 0
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
            successThreshold: 1

          # --- Readiness Probe ---
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 0
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
            successThreshold: 1

          # --- Graceful Shutdown ---
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 15"]

      # --- Pod Anti-Affinity ---
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
            - weight: 50
              podAffinityTerm:
                labelSelector:
                  matchExpressions:
                    - key: app
                      operator: In
                      values: [booking-service]
                topologyKey: topology.kubernetes.io/zone

      # --- Topology Spread Constraints ---
      topologySpreadConstraints:
        - maxSkew: 2
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: booking-service
```

That is 160 lines of YAML. Let me break down the sections we have not covered in earlier chapters.

### Labels and Annotations

```yaml
  labels:
    app: booking-service       # Which application
    team: booking              # Which team owns it
    version: v1                # For blue-green deployments
    tier: backend              # Frontend, backend, or data
```

Labels are queryable. You can run `kubectl get pods -l team=booking` to see every pod owned by the booking team. Annotations are not queryable but carry metadata for tools. The Prometheus annotations tell the monitoring system where to scrape metrics. The Istio annotation enables the service mesh sidecar.

### Revision History Limit

```yaml
  revisionHistoryLimit: 5
```

Kubernetes keeps old ReplicaSets around so you can roll back. The default is 10, but each old ReplicaSet consumes etcd storage. We keep 5 -- enough to roll back through the last five deployments if a bad release makes it past staging.

### Termination Grace Period

```yaml
      terminationGracePeriodSeconds: 45
```

When Kubernetes decides to kill a pod (during scaling down, a new deployment, or node drain), it sends SIGTERM and waits this many seconds before sending SIGKILL. Our NestJS application catches SIGTERM, stops accepting new connections, finishes in-flight requests, closes database connections, and exits cleanly. The 15-second `preStop` sleep plus up to 30 seconds of graceful shutdown gives us 45 seconds total.

### Topology Spread Constraints

```yaml
      topologySpreadConstraints:
        - maxSkew: 2
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
```

Anti-affinity says "try not to put two pods on the same node." Topology spread constraints go further: "distribute pods evenly across availability zones." With `maxSkew: 2`, no zone can have more than 2 extra pods compared to the least-populated zone. If us-east-1a has 7 pods and us-east-1b has 5, the skew is 2 -- at the limit. A new pod must go to us-east-1b or us-east-1c.

> **What If You Skip This?** Without topology spread constraints, the Kubernetes scheduler might put 15 of your 20 pods in one availability zone. When that zone goes down (and it will -- AWS has had zone failures), you lose 75% of your capacity instantly. Spreading pods across zones is not optional for a system handling 100,000 bookings per minute.

---

## The ConfigMap: Non-Sensitive Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: booking-service-config
  namespace: production
data:
  NODE_ENV: "production"
  PORT: "3000"
  LOG_LEVEL: "info"
  REGION: "us-east-1"
  MAX_CONNECTIONS: "100"
  REQUEST_TIMEOUT_MS: "5000"
  CIRCUIT_BREAKER_THRESHOLD: "5"
  CIRCUIT_BREAKER_TIMEOUT_MS: "30000"
  KAFKA_CONSUMER_GROUP: "booking-service-group"
  CACHE_TTL_SECONDS: "300"
  ENABLE_OVERBOOKING: "true"
  OVERBOOKING_LIMIT_PERCENT: "5"
```

Every value is a string (Kubernetes ConfigMaps only store strings). Your application parses them: `parseInt(process.env.MAX_CONNECTIONS, 10)`. The advantage of a ConfigMap over hardcoded environment variables in the Deployment YAML is reusability. Multiple Deployments can reference the same ConfigMap, and you can update a ConfigMap without touching the Deployment manifest.

> **Analogy:** A ConfigMap is like a restaurant's specials board. The kitchen (your application) reads it every shift. The manager can change the specials without remodeling the kitchen. The menu (Docker image) stays the same; only the daily configuration changes.

---

## The Secret: Sensitive Configuration

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: booking-service-secrets
  namespace: production
type: Opaque
data:
  database-url: cG9zdGdyZXNxbDovL2Jvb2tpbmc6c2VjcmV0QGRiLmludGVybmFsOjU0MzIvYm9va2luZ3M=
  redis-url: cmVkaXM6Ly86cGFzc3dvcmRAcmVkaXMuaW50ZXJuYWw6NjM3OQ==
  kafka-brokers: a2Fma2EtMC5pbnRlcm5hbDo5MDkyLGthZmthLTEuaW50ZXJuYWw6OTA5Mg==
  jwt-secret: c3VwZXItc2VjcmV0LWp3dC1rZXktdGhhdC1zaG91bGQtYmUtbG9uZw==
```

Those values are base64-encoded, not encrypted. Anyone with `kubectl get secret -o yaml` access can decode them. In production, we use **Sealed Secrets** (Bitnami) or **External Secrets Operator** (which pulls secrets from AWS Secrets Manager or HashiCorp Vault). The Secret YAML above never goes into Git -- only the Sealed Secret version does.

> **What If You Skip This?** In 2023, a major fintech startup had their Kubernetes Secrets committed to a public GitHub repository. Database credentials, API keys, everything. Bots scan GitHub for base64-encoded strings in YAML files. Within 4 hours, their production database was compromised. Never commit plain Secrets to version control. Ever.

---

## Pod Spec Deep Dive: The NestJS Booking Microservice

The Deployment manifest above shows the broad structure. Now let us zoom into the **Pod spec** -- the `template.spec` section -- and examine a complete, annotated configuration for our NestJS booking microservice. This is the spec that runs in production today.

```yaml
# ============================================================
# Pod Specification — Booking Service (NestJS)
# This template is embedded inside the Deployment's spec.template
# ============================================================
apiVersion: v1
kind: Pod
metadata:
  name: booking-service-manual-debug    # Only used for ad-hoc debugging pods
  namespace: production
  labels:
    app: booking-service
    team: booking
    version: v1
    tier: backend
    managed-by: helm
    part-of: global-booking-platform
  annotations:
    # --- Prometheus Monitoring ---
    prometheus.io/scrape: "true"
    prometheus.io/port: "3000"
    prometheus.io/path: "/metrics"

    # --- Istio Service Mesh ---
    sidecar.istio.io/inject: "true"
    sidecar.istio.io/proxyCPU: "100m"
    sidecar.istio.io/proxyMemory: "128Mi"
    proxy.istio.io/config: |
      holdApplicationUntilProxyStarts: true
      tracing:
        zipkin:
          address: zipkin.monitoring:9411
        sampling: 10.0

    # --- Datadog APM (if using Datadog instead of Jaeger) ---
    ad.datadoghq.com/booking-service.logs: '[{"source":"nodejs","service":"booking-service"}]'

    # --- Cost Allocation ---
    cost-center: "engineering/booking-team"
    environment: "production"
spec:
  serviceAccountName: booking-service           # RBAC-bound service account
  automountServiceAccountToken: false           # Security: don't mount token unless needed
  terminationGracePeriodSeconds: 45

  # --- Security Context (Pod Level) ---
  securityContext:
    runAsNonRoot: true                          # Container must not run as root
    runAsUser: 1000                             # Node.js user UID
    runAsGroup: 1000
    fsGroup: 1000                               # Group for volume mounts
    seccompProfile:
      type: RuntimeDefault                      # Use default seccomp profile

  # --- DNS Configuration ---
  dnsPolicy: ClusterFirst
  dnsConfig:
    options:
      - name: ndots
        value: "2"                              # Reduce DNS lookup chains
      - name: single-request-reopen
        value: ""                               # Avoid DNS race condition on Linux

  # --- Init Containers ---
  initContainers:
    # 1. Wait for database to be reachable
    - name: wait-for-db
      image: busybox:1.36
      command:
        - sh
        - -c
        - |
          echo "Waiting for MySQL to be reachable..."
          until nc -z mysql-primary.production.svc.cluster.local 3306; do
            echo "MySQL not ready, retrying in 2s..."
            sleep 2
          done
          echo "MySQL is reachable."
      resources:
        requests:
          cpu: 50m
          memory: 32Mi
        limits:
          cpu: 100m
          memory: 64Mi

    # 2. Run database migrations
    - name: db-migrations
      image: registry.company.com/booking-service:v2.14.3
      command: ['node', 'dist/migrations/run.js']
      env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: booking-service-secrets
              key: database-url
      resources:
        requests:
          cpu: 500m
          memory: 512Mi
        limits:
          cpu: 1000m
          memory: 1Gi

  # --- Main Containers ---
  containers:
    - name: booking-service
      image: registry.company.com/booking-service:v2.14.3
      imagePullPolicy: IfNotPresent

      ports:
        - name: http
          containerPort: 3000
          protocol: TCP
        - name: grpc
          containerPort: 50051
          protocol: TCP
        - name: metrics
          containerPort: 9090
          protocol: TCP

      # --- Container Security Context ---
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true            # Immutable filesystem
        capabilities:
          drop:
            - ALL                               # Drop all Linux capabilities

      # --- Resource Management ---
      resources:
        requests:
          cpu: 1000m                            # 1 full CPU core guaranteed
          memory: 2Gi                           # 2 GB RAM guaranteed
        limits:
          cpu: 2000m                            # Can burst to 2 cores
          memory: 4Gi                           # Hard cap at 4 GB (OOMKilled above this)

      # --- Volume Mounts ---
      volumeMounts:
        - name: tmp-dir
          mountPath: /tmp                       # Writable tmp (since root fs is read-only)
        - name: config-volume
          mountPath: /app/config
          readOnly: true
        - name: tls-certs
          mountPath: /app/certs
          readOnly: true

      # --- Full Environment Configuration ---
      envFrom:
        - configMapRef:
            name: booking-service-config
      env:
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name          # Inject pod name for logging
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName          # Which physical node this runs on
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: booking-service-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: booking-service-secrets
              key: redis-url

      # --- Health Probes ---
      startupProbe:
        httpGet:
          path: /health/startup
          port: 3000
        initialDelaySeconds: 5
        periodSeconds: 5
        failureThreshold: 30                    # 5 + (30 * 5) = 155s max startup time
      livenessProbe:
        httpGet:
          path: /health/live
          port: 3000
        periodSeconds: 10
        timeoutSeconds: 3
        failureThreshold: 3
      readinessProbe:
        httpGet:
          path: /health/ready
          port: 3000
        periodSeconds: 5
        timeoutSeconds: 3
        failureThreshold: 2

      # --- Graceful Shutdown Hook ---
      lifecycle:
        preStop:
          exec:
            command:
              - /bin/sh
              - -c
              - |
                echo "PreStop hook: waiting for load balancer drain..."
                sleep 15
                echo "PreStop hook: signaling application shutdown..."
                curl -s -X POST http://localhost:3000/admin/shutdown || true

  # --- Volumes ---
  volumes:
    - name: tmp-dir
      emptyDir:
        sizeLimit: 100Mi                        # Ephemeral storage limit
    - name: config-volume
      configMap:
        name: booking-service-config
    - name: tls-certs
      secret:
        secretName: booking-service-tls
        defaultMode: 0440                       # Read-only for owner and group

  # --- Pod Scheduling ---
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values: [booking-service]
          topologyKey: kubernetes.io/hostname    # Never two pods on same node
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: node-role
                operator: In
                values: [worker]                # Only schedule on worker nodes
              - key: topology.kubernetes.io/zone
                operator: In
                values: [us-east-1a, us-east-1b, us-east-1c]
  topologySpreadConstraints:
    - maxSkew: 2
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: booking-service
```

> **Mentor's Note:** That pod spec is long. And in production, every line matters. The `readOnlyRootFilesystem` prevents attackers who exploit a vulnerability from writing malware to disk. The `automountServiceAccountToken: false` prevents a compromised pod from talking to the Kubernetes API. The `ndots: 2` DNS setting reduces unnecessary DNS queries -- in a cluster with thousands of pods, this saves measurable latency. I know it feels like over-engineering, but these settings are the difference between "we have a Kubernetes cluster" and "we have a secure, production-grade Kubernetes cluster."

---

## Resource Requests and Limits: The Sizing Table

Getting resource requests and limits right is one of the hardest parts of Kubernetes. Set requests too high, and you waste expensive cloud resources. Set them too low, and pods get evicted under load. Set limits too tight, and pods get OOMKilled during traffic spikes.

Here is our sizing table for every microservice, refined over 18 months of production data.

```
┌─────────────────────┬────────────┬────────────┬────────────┬────────────┬──────────┐
│ Service             │ CPU Req    │ CPU Limit  │ Mem Req    │ Mem Limit  │ Replicas │
├─────────────────────┼────────────┼────────────┼────────────┼────────────┼──────────┤
│ API Gateway         │ 500m       │ 1000m      │ 512Mi      │ 1Gi        │ 10       │
│ Booking Service     │ 1000m      │ 2000m      │ 2Gi        │ 4Gi        │ 20       │
│ Inventory Service   │ 750m       │ 1500m      │ 1Gi        │ 2Gi        │ 15       │
│ Payment Service     │ 500m       │ 1000m      │ 1Gi        │ 2Gi        │ 10       │
│ Search Service      │ 2000m      │ 4000m      │ 4Gi        │ 8Gi        │ 12       │
│ Notification Svc    │ 250m       │ 500m       │ 512Mi      │ 1Gi        │ 5        │
│ Fraud Detection     │ 1500m      │ 3000m      │ 3Gi        │ 6Gi        │ 8        │
│ Analytics Service   │ 1000m      │ 2000m      │ 2Gi        │ 4Gi        │ 6        │
│ Event Store         │ 500m       │ 1000m      │ 1Gi        │ 2Gi        │ 6        │
│ User Service        │ 500m       │ 1000m      │ 512Mi      │ 1Gi        │ 8        │
├─────────────────────┼────────────┼────────────┼────────────┼────────────┼──────────┤
│ TOTALS (all pods)   │ 82.75 CPU  │ 165.5 CPU  │ 148.5 Gi   │ 297 Gi     │ 100      │
└─────────────────────┴────────────┴────────────┴────────────┴────────────┴──────────┘
```

### How We Arrived at These Numbers

**Step 1: Start with Load Testing.** We ran each service in isolation under simulated production load (100,000 requests per minute) and measured actual CPU and memory consumption using Prometheus metrics.

**Step 2: Set Requests to P95 Usage.** If the Booking Service used 800m CPU at P95 during load testing, we set the request to 1000m (25% headroom). The request is a guarantee -- the scheduler reserves this much for your pod.

**Step 3: Set Limits to 2x Requests.** This allows pods to burst during traffic spikes without being throttled or killed. The 2x multiplier works well for Node.js services because V8 garbage collection can cause temporary CPU spikes.

**Step 4: Monitor and Adjust Quarterly.** Every quarter, we review Grafana dashboards showing actual vs. requested resources. If actual usage is consistently below 50% of the request, we reduce it. If pods are hitting limits, we increase them.

> **Key Term:** **Requests vs. Limits** — A request is a guaranteed reservation. If a pod requests 1 CPU, the scheduler only places it on a node with at least 1 CPU available. A limit is a ceiling. If a pod tries to use more CPU than its limit, it gets throttled (CPU) or killed (memory). Always set requests. Always set memory limits. CPU limits are debatable -- some teams skip them to avoid throttling.

> **What If You Skip This?** Without resource requests, the Kubernetes scheduler treats your pods as "best effort." They are the first to be evicted when nodes run low on resources. During a Black Friday traffic spike, your booking pods would be killed to make room for system pods. Your customers see 503 errors. Your revenue stops. Set your requests.

---

## Horizontal Pod Autoscaler (HPA)

Static replica counts are wasteful. At 3 AM, the Booking Service does not need 20 replicas. At noon on Black Friday, it might need 80. The Horizontal Pod Autoscaler watches metrics and adjusts the replica count automatically.

### Basic HPA: CPU-Based Scaling

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
  minReplicas: 10                               # Never go below 10 (overnight minimum)
  maxReplicas: 80                               # Never go above 80 (cost ceiling)
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60            # Wait 60s before scaling up again
      policies:
        - type: Pods
          value: 10                             # Add at most 10 pods per minute
          periodSeconds: 60
        - type: Percent
          value: 50                             # Or add at most 50% more pods
          periodSeconds: 60
      selectPolicy: Max                         # Use whichever policy allows more pods
    scaleDown:
      stabilizationWindowSeconds: 300           # Wait 5 minutes before scaling down
      policies:
        - type: Pods
          value: 5                              # Remove at most 5 pods per 2 minutes
          periodSeconds: 120
      selectPolicy: Min                         # Use whichever policy removes fewer pods
  metrics:
    # --- Primary: CPU Utilization ---
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65                # Target 65% average CPU across all pods
    # --- Secondary: Memory Utilization ---
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
```

### Advanced HPA: Custom Metrics with Prometheus Adapter

CPU utilization alone is a lagging indicator. By the time CPU spikes, your response times are already degraded. We use **custom metrics** from Prometheus to scale on business-relevant signals.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: booking-service-hpa-custom
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: booking-service
  minReplicas: 10
  maxReplicas: 80
  metrics:
    # --- Custom Metric: Request Rate per Pod ---
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "500"                   # Scale when each pod handles > 500 req/s

    # --- Custom Metric: P99 Latency ---
    - type: Object
      object:
        metric:
          name: http_request_duration_p99_ms
        describedObject:
          apiVersion: v1
          kind: Service
          name: booking-service
        target:
          type: Value
          value: "200"                          # Scale when P99 exceeds 200ms

    # --- Custom Metric: Kafka Consumer Lag ---
    - type: External
      external:
        metric:
          name: kafka_consumer_lag
          selector:
            matchLabels:
              consumer_group: booking-service-group
              topic: booking-events
        target:
          type: Value
          value: "10000"                        # Scale when lag exceeds 10,000 messages

    # --- Standard: CPU as a fallback ---
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

> **How It Works in Practice:** At 2 AM, traffic is low. The HPA sees 200 req/s per pod (below 500 target), P99 at 45ms (below 200ms target), and no Kafka lag. It scales down to 10 replicas. At 10 AM, morning traffic pushes each pod to 480 req/s. Still fine. At 11:30 AM, a flash sale is announced. Request rate jumps to 700 req/s per pod. The HPA adds 10 pods within 60 seconds. P99 drops back to 80ms. The HPA holds steady. By midnight, it scales back to 12 replicas.

> **Mentor's Tip:** Scale-down is more dangerous than scale-up. If you scale down too aggressively, the remaining pods get overwhelmed, which triggers an immediate scale-up, which triggers another scale-down -- a thrashing loop. That 300-second stabilization window on scale-down and the conservative "remove at most 5 pods" policy prevent this. Be generous scaling up and conservative scaling down.

---

## Deployment Strategies: Rolling, Blue-Green, Canary

How you ship new code determines whether your users notice deployments. Let us walk through each strategy and when to use it.

### Strategy 1: Rolling Update (Default)

A rolling update gradually replaces old pods with new ones. It is the default strategy in Kubernetes and works well for most deployments.

```yaml
spec:
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%           # Create up to 25% extra pods during rollout
      maxUnavailable: 25%     # Allow up to 25% of pods to be unavailable
```

**How it works with 20 replicas:**
1. Kubernetes creates 5 new pods (25% surge) with the new image.
2. The 5 new pods pass startup and readiness probes.
3. Kubernetes terminates 5 old pods.
4. Repeat until all 20 pods are on the new version.
5. Total time: ~3-5 minutes for our booking service.

**When to use it:** Day-to-day releases. Backward-compatible changes. Config updates.

**When NOT to use it:** Database schema changes that break the old version. Major API changes. Changes that require instant rollback.

### Strategy 2: Blue-Green Deployment

Blue-green runs two complete environments (blue = current, green = new). Traffic switches instantly from blue to green. If something breaks, you switch back.

```yaml
# Blue deployment (currently receiving traffic)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service-blue
  namespace: production
  labels:
    app: booking-service
    slot: blue
spec:
  replicas: 20
  selector:
    matchLabels:
      app: booking-service
      slot: blue
  template:
    metadata:
      labels:
        app: booking-service
        slot: blue
    spec:
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:v2.14.3
          # ... (same pod spec as before)
---
# Green deployment (new version, standing by)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service-green
  namespace: production
  labels:
    app: booking-service
    slot: green
spec:
  replicas: 20
  selector:
    matchLabels:
      app: booking-service
      slot: green
  template:
    metadata:
      labels:
        app: booking-service
        slot: green
    spec:
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:v2.15.0
          # ... (same pod spec, new image)
---
# Service that controls which slot receives traffic
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  selector:
    app: booking-service
    slot: blue              # <--- Change to "green" to switch traffic
  ports:
    - port: 80
      targetPort: 3000
```

**The cutover:** Change the Service selector from `slot: blue` to `slot: green`. Traffic shifts within seconds. If the green deployment has issues, change it back to `slot: blue`.

**When to use it:** Major releases. Breaking database migrations (where you must upgrade atomically). Releases that need instant rollback capability.

**Downside:** You need double the resources during the transition. With 20 replicas, you are running 40 pods temporarily.

### Strategy 3: Canary Deployment with Argo Rollouts

A canary deployment sends a small percentage of traffic to the new version. If metrics look good, you gradually increase the percentage. If metrics degrade, you roll back automatically.

We use **Argo Rollouts** for canary deployments because the built-in Kubernetes Deployment does not support traffic-percentage-based canary releases.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: booking-service
  namespace: production
spec:
  replicas: 20
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: booking-service
  template:
    metadata:
      labels:
        app: booking-service
    spec:
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:v2.15.0
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
  strategy:
    canary:
      # --- Traffic Splitting via Istio ---
      trafficRouting:
        istio:
          virtualServices:
            - name: booking-service-vsvc
              routes:
                - primary
          destinationRule:
            name: booking-service-destrule
            canarySubsetName: canary
            stableSubsetName: stable

      # --- Analysis: Automated Metric Checks ---
      analysis:
        templates:
          - templateName: booking-success-rate
          - templateName: booking-latency-p99
        startingStep: 2                         # Start analysis at step 2
        args:
          - name: service-name
            value: booking-service

      # --- Canary Steps ---
      steps:
        - setWeight: 5                          # Step 1: 5% traffic to canary
        - pause: { duration: 5m }               # Wait 5 minutes
        - setWeight: 10                         # Step 2: 10% traffic (analysis begins)
        - pause: { duration: 10m }
        - setWeight: 25                         # Step 3: 25% traffic
        - pause: { duration: 10m }
        - setWeight: 50                         # Step 4: 50% traffic
        - pause: { duration: 15m }
        - setWeight: 75                         # Step 5: 75% traffic
        - pause: { duration: 10m }
        - setWeight: 100                        # Step 6: 100% traffic — full rollout

---
# Analysis Template: checks success rate
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: booking-success-rate
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 2m
      successCondition: result[0] >= 0.995      # 99.5% success rate required
      failureLimit: 3                           # Rollback after 3 failed checks
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            sum(rate(http_requests_total{
              service="{{args.service-name}}",
              status=~"2.."
            }[5m])) /
            sum(rate(http_requests_total{
              service="{{args.service-name}}"
            }[5m]))

---
# Analysis Template: checks P99 latency
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: booking-latency-p99
  namespace: production
spec:
  args:
    - name: service-name
  metrics:
    - name: latency-p99
      interval: 2m
      successCondition: result[0] <= 250        # P99 must stay under 250ms
      failureLimit: 3
      provider:
        prometheus:
          address: http://prometheus.monitoring:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(http_request_duration_seconds_bucket{
                service="{{args.service-name}}"
              }[5m])) by (le)
            ) * 1000
```

> **How the Canary Works in Practice:** You push v2.15.0. Argo Rollouts sends 5% of traffic to one new pod. After 5 minutes, it bumps to 10% and starts running Prometheus queries every 2 minutes. If the success rate drops below 99.5% or P99 latency exceeds 250ms for three consecutive checks, the rollout automatically aborts and sends 100% of traffic back to the stable version. No human intervention needed. If all checks pass through every step, the full rollout completes in about 55 minutes.

> **Mentor's Tip:** Use rolling updates for 90% of your deployments. Use canary for risky changes -- new payment integrations, database driver upgrades, refactored core logic. Use blue-green for planned major releases where you want a single instant cutover. Having all three strategies available is a sign of deployment maturity.

---

## ConfigMaps and Secrets Management at Scale

We introduced ConfigMaps and Secrets earlier, but managing them across ten microservices, four regions, and three environments requires more than individual YAML files. Here is how we organize configuration at scale.

### Per-Service, Per-Environment ConfigMaps

```yaml
# ============================================================
# ConfigMap hierarchy: base -> environment -> region overrides
# ============================================================

# Base configuration (shared across all environments)
apiVersion: v1
kind: ConfigMap
metadata:
  name: booking-service-config-base
  namespace: production
data:
  PORT: "3000"
  CIRCUIT_BREAKER_THRESHOLD: "5"
  CIRCUIT_BREAKER_TIMEOUT_MS: "30000"
  CACHE_TTL_SECONDS: "300"

---
# Environment-specific overrides
apiVersion: v1
kind: ConfigMap
metadata:
  name: booking-service-config-production
  namespace: production
data:
  NODE_ENV: "production"
  LOG_LEVEL: "warn"
  LOG_FORMAT: "json"
  MAX_CONNECTIONS: "100"
  REQUEST_TIMEOUT_MS: "5000"
  ENABLE_DEBUG_ROUTES: "false"
  RATE_LIMIT_PER_MINUTE: "1000"

---
# Region-specific overrides (injected via Helm values)
apiVersion: v1
kind: ConfigMap
metadata:
  name: booking-service-config-region
  namespace: production
data:
  REGION: "us-east-1"
  AVAILABILITY_ZONES: "us-east-1a,us-east-1b,us-east-1c"
  CDN_ENDPOINT: "https://cdn-us.bookingsystem.com"
  NEAREST_CACHE_CLUSTER: "redis-us-east.internal"
```

### External Secrets Operator: Pulling from AWS Secrets Manager

Plain Kubernetes Secrets are base64-encoded, not encrypted. In production, we use the **External Secrets Operator** to pull secrets from AWS Secrets Manager and create Kubernetes Secrets automatically.

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: booking-service-secrets
  namespace: production
spec:
  refreshInterval: 5m                           # Re-sync every 5 minutes
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: booking-service-secrets               # K8s Secret name to create
    creationPolicy: Owner
    template:
      type: Opaque
      metadata:
        labels:
          app: booking-service
  data:
    - secretKey: database-url
      remoteRef:
        key: production/booking-service/database
        property: url
    - secretKey: redis-url
      remoteRef:
        key: production/booking-service/redis
        property: url
    - secretKey: kafka-brokers
      remoteRef:
        key: production/shared/kafka
        property: brokers
    - secretKey: jwt-secret
      remoteRef:
        key: production/shared/auth
        property: jwt-signing-key

---
# ClusterSecretStore: connects to AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: aws-secrets-manager
spec:
  provider:
    aws:
      service: SecretsManager
      region: us-east-1
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-sa
            namespace: external-secrets
```

> **Mentor's Note:** With External Secrets Operator, your Git repository contains zero actual secrets. The ExternalSecret manifest says "go fetch the value from AWS Secrets Manager at this path." When a developer runs `kubectl get secret booking-service-secrets -o yaml`, they see the actual secret values -- but only if they have RBAC permissions. The secret values live in AWS Secrets Manager, where they are encrypted at rest with KMS, audited via CloudTrail, and rotatable without redeploying your application. This is how secrets management should work.

---

## Persistent Volumes for MySQL and Redis

Stateless services (our NestJS microservices) restart without losing anything. Stateful services (MySQL, Redis) must retain data across pod restarts and rescheduling. Kubernetes uses **PersistentVolumes (PV)** and **PersistentVolumeClaims (PVC)** to manage durable storage.

### MySQL: StatefulSet with Persistent Storage

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql-primary
  namespace: production
spec:
  serviceName: mysql-primary
  replicas: 3                                   # 1 primary + 2 read replicas
  selector:
    matchLabels:
      app: mysql
      role: primary
  template:
    metadata:
      labels:
        app: mysql
        role: primary
    spec:
      terminationGracePeriodSeconds: 120        # MySQL needs time for clean shutdown
      containers:
        - name: mysql
          image: mysql:8.0.35
          ports:
            - containerPort: 3306
              name: mysql
          resources:
            requests:
              cpu: 2000m
              memory: 8Gi
            limits:
              cpu: 4000m
              memory: 16Gi
          env:
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-secrets
                  key: root-password
          volumeMounts:
            - name: mysql-data
              mountPath: /var/lib/mysql
            - name: mysql-config
              mountPath: /etc/mysql/conf.d
          livenessProbe:
            exec:
              command:
                - mysqladmin
                - ping
                - -h
                - localhost
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            exec:
              command:
                - mysql
                - -h
                - localhost
                - -u
                - root
                - -p${MYSQL_ROOT_PASSWORD}
                - -e
                - "SELECT 1"
            periodSeconds: 5
            failureThreshold: 3
      volumes:
        - name: mysql-config
          configMap:
            name: mysql-config

  # --- Persistent Volume Claim Template ---
  volumeClaimTemplates:
    - metadata:
        name: mysql-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted          # AWS EBS gp3 with encryption
        resources:
          requests:
            storage: 500Gi                       # 500 GB per MySQL instance

---
# Storage Class for encrypted gp3 volumes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-encrypted
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"                                  # Provisioned IOPS
  throughput: "400"                             # MB/s throughput
  encrypted: "true"
  kmsKeyId: arn:aws:kms:us-east-1:123456789:key/mrk-abc123
reclaimPolicy: Retain                           # Never auto-delete database volumes
volumeBindingMode: WaitForFirstConsumer         # Bind in the correct AZ
allowVolumeExpansion: true                      # Allow online volume resizing
```

### Redis: StatefulSet with Persistence

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis-cluster
  namespace: production
spec:
  serviceName: redis-cluster
  replicas: 6                                   # 3 primary + 3 replica (Redis Cluster mode)
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7.2-alpine
          ports:
            - containerPort: 6379
              name: redis
            - containerPort: 16379
              name: gossip
          command:
            - redis-server
            - /etc/redis/redis.conf
            - --cluster-enabled
            - "yes"
            - --cluster-config-file
            - /data/nodes.conf
          resources:
            requests:
              cpu: 1000m
              memory: 4Gi
            limits:
              cpu: 2000m
              memory: 8Gi                       # Redis must never OOM -- set limit high
          volumeMounts:
            - name: redis-data
              mountPath: /data
            - name: redis-config
              mountPath: /etc/redis
          readinessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 5
          livenessProbe:
            exec:
              command: ["redis-cli", "ping"]
            periodSeconds: 10
      volumes:
        - name: redis-config
          configMap:
            name: redis-config
  volumeClaimTemplates:
    - metadata:
        name: redis-data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: gp3-encrypted
        resources:
          requests:
            storage: 100Gi
```

> **Key Term:** **StatefulSet vs. Deployment** -- A Deployment treats all pods as interchangeable. Pod names are random (`booking-service-7f8d9-xk2p4`). A StatefulSet gives each pod a stable, predictable name (`mysql-primary-0`, `mysql-primary-1`, `mysql-primary-2`), a stable network identity, and dedicated persistent storage. When `mysql-primary-1` is rescheduled to a new node, it reattaches to the same 500 GB EBS volume. Use Deployments for stateless services. Use StatefulSets for databases, caches, and anything that stores data.

> **What If You Skip This?** Without persistent volumes, your MySQL data lives on the node's local disk. When Kubernetes reschedules the pod to a different node (which it will -- during node upgrades, scaling events, or zone rebalancing), all your data is gone. We have seen a team lose 48 hours of booking data because they ran MySQL in a Deployment with emptyDir storage. Use PersistentVolumeClaims. Always.

---

## Service Mesh with Istio: Traffic Management and mTLS

A service mesh adds a sidecar proxy to every pod. This proxy intercepts all network traffic and provides mutual TLS encryption, traffic routing, retries, circuit breaking, and observability -- without changing your application code.

We use **Istio** as our service mesh. Here is how it is configured for the booking platform.

### Enabling Istio Injection

```yaml
# Label the namespace to auto-inject Istio sidecars
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    istio-injection: enabled                    # Every pod gets an Envoy sidecar
```

With this label, every pod in the `production` namespace automatically gets an Envoy sidecar proxy. The application does not know it is there.

### PeerAuthentication: Enforcing mTLS

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: production
spec:
  mtls:
    mode: STRICT                                # All traffic must be mTLS-encrypted
```

**STRICT** means every service-to-service call within the mesh is encrypted with mutual TLS. The Booking Service calling the Inventory Service? Encrypted. Inventory calling Redis? If Redis is in the mesh, encrypted. No configuration needed in your Node.js code. The Envoy sidecar handles TLS termination and certificate rotation automatically.

### VirtualService: Traffic Routing Rules

```yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: booking-service-vsvc
  namespace: production
spec:
  hosts:
    - booking-service
  http:
    # --- Route: Canary traffic (managed by Argo Rollouts) ---
    - name: primary
      route:
        - destination:
            host: booking-service
            subset: stable
          weight: 95
        - destination:
            host: booking-service
            subset: canary
          weight: 5

      # --- Retry Policy ---
      retries:
        attempts: 3
        perTryTimeout: 2s
        retryOn: "5xx,reset,connect-failure,refused-stream"

      # --- Timeout ---
      timeout: 10s

      # --- Fault Injection (for chaos testing) ---
      # Uncomment to inject 5% failures in staging:
      # fault:
      #   abort:
      #     percentage:
      #       value: 5.0
      #     httpStatus: 503

---
# DestinationRule: defines subsets and circuit breaker
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: booking-service-destrule
  namespace: production
spec:
  host: booking-service
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 1000
      http:
        h2UpgradePolicy: DEFAULT
        http1MaxPendingRequests: 500
        http2MaxRequests: 1000
        maxRequestsPerConnection: 100
    outlierDetection:
      consecutive5xxErrors: 5                   # Eject pod after 5 consecutive 5xx
      interval: 10s
      baseEjectionTime: 30s                     # Eject for 30 seconds
      maxEjectionPercent: 30                    # Never eject more than 30% of pods
  subsets:
    - name: stable
      labels:
        app: booking-service
    - name: canary
      labels:
        app: booking-service
```

> **Analogy:** Imagine every microservice is a building in a campus. Without a service mesh, people walk between buildings on open sidewalks -- anyone can eavesdrop, there are no guards, and if one building is on fire, people keep walking toward it. A service mesh adds enclosed, encrypted walkways between every building, security checkpoints that verify identity, and smart routing that redirects people away from buildings that are on fire. Your application code (the people in the buildings) does not change at all. The infrastructure handles everything.

---

## Ingress Controller: The API Gateway Entry Point

All external traffic enters the cluster through an **Ingress Controller**. We use the **NGINX Ingress Controller** in front of our API Gateway service.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-gateway-ingress
  namespace: production
  annotations:
    # --- NGINX configuration ---
    nginx.ingress.kubernetes.io/proxy-body-size: "10m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-connect-timeout: "10"

    # --- Rate Limiting ---
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "5"

    # --- SSL / TLS ---
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    cert-manager.io/cluster-issuer: letsencrypt-prod

    # --- CORS ---
    nginx.ingress.kubernetes.io/enable-cors: "true"
    nginx.ingress.kubernetes.io/cors-allow-origin: "https://bookingsystem.com,https://admin.bookingsystem.com"
    nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    nginx.ingress.kubernetes.io/cors-allow-headers: "Authorization, Content-Type, X-Request-ID"

    # --- Security Headers ---
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_set_headers "X-Frame-Options: DENY";
      more_set_headers "X-Content-Type-Options: nosniff";
      more_set_headers "X-XSS-Protection: 1; mode=block";
      more_set_headers "Strict-Transport-Security: max-age=31536000; includeSubDomains";
      more_set_headers "Referrer-Policy: strict-origin-when-cross-origin";
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - api.bookingsystem.com
        - api-v2.bookingsystem.com
      secretName: api-tls-cert                  # Managed by cert-manager
  rules:
    - host: api.bookingsystem.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-gateway
                port:
                  number: 80
    - host: api-v2.bookingsystem.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-gateway-v2
                port:
                  number: 80
```

> **Mentor's Note:** The Ingress is the front door to your entire platform. Every security header, rate limit, and TLS setting matters. The `limit-rps: 100` annotation means each client IP can make 100 requests per second before getting 429 responses. The `proxy-body-size: 10m` prevents clients from uploading massive payloads. The security headers prevent clickjacking, MIME sniffing, and XSS. Think of the Ingress configuration as your application's immune system -- the first line of defense against malicious traffic.

---

## Namespace Organization: Per-Environment and Per-Team

As the platform grows, namespace organization becomes critical. Here is our full namespace strategy.

```
Cluster Namespace Strategy:
├── Environments
│   ├── production              # Live traffic. Strict RBAC. No dev access.
│   ├── staging                 # Pre-prod. Same manifests, 1/4 replicas.
│   ├── development             # Shared integration environment.
│   ├── load-testing            # Isolated namespace for performance tests.
│   └── preview-*               # Ephemeral namespaces per pull request.
│
├── Infrastructure
│   ├── istio-system            # Istio control plane.
│   ├── monitoring              # Prometheus, Grafana, Alertmanager.
│   ├── logging                 # EFK stack.
│   ├── cert-manager            # TLS certificate automation.
│   ├── external-secrets        # External Secrets Operator.
│   ├── argo-rollouts           # Argo Rollouts controller.
│   └── ingress-nginx           # NGINX Ingress controller.
│
├── Data
│   ├── kafka                   # Kafka brokers.
│   ├── mysql                   # MySQL StatefulSets.
│   └── redis                   # Redis clusters.
│
└── System
    └── kube-system             # Kubernetes internals.
```

### RBAC: Who Can Access What

```yaml
# Developers can view production, but cannot modify
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: production-viewer
  namespace: production
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]                              # Can read logs
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: []                                   # CANNOT read secrets

---
# SRE team has full access to production
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: production-admin
  namespace: production
rules:
  - apiGroups: ["*"]
    resources: ["*"]
    verbs: ["*"]

---
# Bind the developer role to the engineering group
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: engineering-production-viewer
  namespace: production
subjects:
  - kind: Group
    name: engineering                           # From your identity provider (Okta, etc.)
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: production-viewer
  apiGroup: rbac.authorization.k8s.io
```

> **What If You Skip This?** Without RBAC, every developer has full cluster admin access. A junior developer accidentally runs `kubectl delete namespace production` -- yes, this has happened at real companies. RBAC ensures that only the SRE team can modify production resources, while developers can view logs and pod status for debugging.

---

## Pod Disruption Budgets: Zero-Downtime Maintenance

When Kubernetes needs to drain a node (for OS patching, cluster upgrades, or instance replacement), it evicts pods. A **PodDisruptionBudget (PDB)** tells Kubernetes how many pods can be unavailable at the same time.

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: booking-service-pdb
  namespace: production
spec:
  minAvailable: "80%"                           # At least 80% of pods must be running
  selector:
    matchLabels:
      app: booking-service

---
# Alternative: maxUnavailable (sometimes clearer)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: payment-service-pdb
  namespace: production
spec:
  maxUnavailable: 2                             # At most 2 pods can be down at once
  selector:
    matchLabels:
      app: payment-service

---
# Critical: MySQL PDB (never evict more than 1 at a time)
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: mysql-pdb
  namespace: production
spec:
  maxUnavailable: 1                             # Only 1 MySQL pod can be down at once
  selector:
    matchLabels:
      app: mysql
```

**How it works:** A cluster admin runs `kubectl drain node-5` to patch the OS. Node-5 has 3 booking pods and 1 MySQL pod. The PDB says at least 80% of booking pods (16 out of 20) must remain available. If draining node-5 would bring the count below 16, Kubernetes waits until pods are rescheduled to other nodes first. For MySQL, it will only evict one pod at a time, waiting for the replica to catch up before evicting the next one.

> **Key Term:** **PodDisruptionBudget** -- A safety net that limits how many pods of a particular application can be voluntarily disrupted (evicted) at any given time. Voluntary disruptions include node drains, cluster upgrades, and autoscaler scale-downs. Involuntary disruptions (node crashes, OOM kills) are NOT governed by PDBs.

> **Mentor's Tip:** Every production Deployment should have a PDB. No exceptions. A cluster upgrade without PDBs can simultaneously evict all 20 booking pods while new ones are starting up. For those 45 seconds, you have zero booking capacity. With a PDB, the drain process evicts a few pods at a time, waits for replacements to become ready, then continues. Your users never notice.

---

## Helm Charts: Packaging the Entire Booking Platform

Managing raw YAML for ten microservices across four regions and three environments means thousands of YAML files with subtle per-environment differences. **Helm** is the package manager for Kubernetes. It lets you template your manifests and deploy the entire platform with a single command.

### Chart Structure

```
booking-platform/
├── Chart.yaml                    # Chart metadata
├── values.yaml                   # Default values
├── values-production.yaml        # Production overrides
├── values-staging.yaml           # Staging overrides
├── values-us-east-1.yaml         # Region overrides
├── templates/
│   ├── _helpers.tpl              # Shared template functions
│   ├── deployment.yaml           # Templated Deployment
│   ├── service.yaml              # Templated Service
│   ├── hpa.yaml                  # Templated HPA
│   ├── pdb.yaml                  # Templated PDB
│   ├── configmap.yaml            # Templated ConfigMap
│   ├── external-secret.yaml      # Templated ExternalSecret
│   ├── ingress.yaml              # Templated Ingress
│   └── serviceaccount.yaml       # Templated ServiceAccount
└── charts/                       # Sub-charts (dependencies)
    ├── mysql/
    ├── redis/
    └── kafka/
```

### Chart.yaml

```yaml
apiVersion: v2
name: booking-platform
description: Global Booking System — all microservices and infrastructure
type: application
version: 2.14.3                                # Chart version (SemVer)
appVersion: "2.14.3"                           # Application version
dependencies:
  - name: mysql
    version: 9.14.0
    repository: https://charts.bitnami.com/bitnami
    condition: mysql.enabled
  - name: redis
    version: 18.4.0
    repository: https://charts.bitnami.com/bitnami
    condition: redis.enabled
```

### values.yaml (Default Values)

```yaml
# ============================================================
# Default values for the booking-platform Helm chart.
# Override per environment with values-production.yaml, etc.
# ============================================================

global:
  imageRegistry: registry.company.com
  imagePullSecrets:
    - name: registry-credentials
  environment: development
  region: us-east-1

# --- Booking Service ---
bookingService:
  enabled: true
  replicaCount: 3
  image:
    repository: booking-service
    tag: latest
    pullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 500m
      memory: 512Mi
    limits:
      cpu: 1000m
      memory: 1Gi
  autoscaling:
    enabled: false
    minReplicas: 3
    maxReplicas: 10
    targetCPUUtilization: 70
  config:
    logLevel: debug
    port: 3000
    requestTimeoutMs: 5000
  pdb:
    enabled: true
    minAvailable: "50%"

# --- Inventory Service ---
inventoryService:
  enabled: true
  replicaCount: 2
  image:
    repository: inventory-service
    tag: latest
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi

# --- (Similar blocks for all 10 services) ---

# --- Infrastructure ---
mysql:
  enabled: true
redis:
  enabled: true
```

### values-production.yaml (Production Overrides)

```yaml
global:
  environment: production

bookingService:
  replicaCount: 20
  image:
    tag: v2.14.3
    pullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 1000m
      memory: 2Gi
    limits:
      cpu: 2000m
      memory: 4Gi
  autoscaling:
    enabled: true
    minReplicas: 10
    maxReplicas: 80
    targetCPUUtilization: 65
  config:
    logLevel: warn
    requestTimeoutMs: 5000
  pdb:
    enabled: true
    minAvailable: "80%"

inventoryService:
  replicaCount: 15
  image:
    tag: v2.14.3
  resources:
    requests:
      cpu: 750m
      memory: 1Gi
    limits:
      cpu: 1500m
      memory: 2Gi
```

### Templated Deployment (templates/deployment.yaml)

```yaml
{{- range $name, $svc := .Values }}
{{- if and (kindIs "map" $svc) ($svc.enabled) ($svc.image) }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name | kebabcase }}
  namespace: {{ $.Release.Namespace }}
  labels:
    app: {{ $name | kebabcase }}
    chart: {{ $.Chart.Name }}-{{ $.Chart.Version }}
    release: {{ $.Release.Name }}
    environment: {{ $.Values.global.environment }}
spec:
  replicas: {{ $svc.replicaCount }}
  selector:
    matchLabels:
      app: {{ $name | kebabcase }}
  template:
    metadata:
      labels:
        app: {{ $name | kebabcase }}
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: {{ $svc.config.port | default "3000" | quote }}
    spec:
      containers:
        - name: {{ $name | kebabcase }}
          image: "{{ $.Values.global.imageRegistry }}/{{ $svc.image.repository }}:{{ $svc.image.tag }}"
          ports:
            - containerPort: {{ $svc.config.port | default 3000 }}
          resources:
            {{- toYaml $svc.resources | nindent 12 }}
          envFrom:
            - configMapRef:
                name: {{ $name | kebabcase }}-config
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ $name | kebabcase }}-secrets
                  key: database-url
{{- end }}
{{- end }}
```

### Deploying the Platform

```bash
# Deploy to staging
helm upgrade --install booking-platform ./booking-platform \
  --namespace staging \
  --values booking-platform/values.yaml \
  --values booking-platform/values-staging.yaml \
  --values booking-platform/values-us-east-1.yaml \
  --set global.region=us-east-1 \
  --wait --timeout 10m

# Deploy to production (us-east-1)
helm upgrade --install booking-platform ./booking-platform \
  --namespace production \
  --values booking-platform/values.yaml \
  --values booking-platform/values-production.yaml \
  --values booking-platform/values-us-east-1.yaml \
  --set global.region=us-east-1 \
  --wait --timeout 15m

# Rollback to previous release
helm rollback booking-platform 1 --namespace production

# View release history
helm history booking-platform --namespace production
```

> **Analogy:** Raw YAML files are like writing every letter by hand. Helm is like having a mail merge template. You write the template once, and for each environment (production, staging, development) you provide different data. The template + data = a complete set of Kubernetes manifests, customized for that environment.

---

## kubectl Cheat Sheet for Daily Operations

You will use `kubectl` every day. Here are the commands our SRE team runs most often, organized by task.

### Viewing Resources

```bash
# List all pods in production (with wide output including node info)
kubectl get pods -n production -o wide

# List pods for a specific service
kubectl get pods -n production -l app=booking-service

# Watch pods in real-time (updates every 2 seconds)
kubectl get pods -n production -l app=booking-service -w

# Get detailed info about a specific pod
kubectl describe pod booking-service-7f8d9-xk2p4 -n production

# View resource usage (CPU/memory) for all pods
kubectl top pods -n production --sort-by=memory

# View node resource usage
kubectl top nodes

# List all services
kubectl get svc -n production

# List all HPAs with current metrics
kubectl get hpa -n production

# List all PDBs
kubectl get pdb -n production

# View events (sorted by time -- invaluable for debugging)
kubectl get events -n production --sort-by='.lastTimestamp' | tail -20
```

### Debugging

```bash
# View logs for a pod (last 100 lines)
kubectl logs booking-service-7f8d9-xk2p4 -n production --tail=100

# Follow logs in real-time
kubectl logs -f booking-service-7f8d9-xk2p4 -n production

# View logs for a pod that crashed (previous instance)
kubectl logs booking-service-7f8d9-xk2p4 -n production --previous

# View logs for all pods of a service
kubectl logs -l app=booking-service -n production --tail=50

# Open a shell inside a running pod
kubectl exec -it booking-service-7f8d9-xk2p4 -n production -- /bin/sh

# Run a one-off debug pod with network tools
kubectl run debug --rm -it --image=nicolaka/netshoot -n production -- /bin/bash

# Port-forward a service to your local machine
kubectl port-forward svc/booking-service 3000:80 -n production

# Copy files from a pod to your local machine
kubectl cp production/booking-service-7f8d9-xk2p4:/tmp/heapdump.json ./heapdump.json
```

### Deployments and Scaling

```bash
# View rollout status
kubectl rollout status deployment/booking-service -n production

# View rollout history
kubectl rollout history deployment/booking-service -n production

# Rollback to previous version
kubectl rollout undo deployment/booking-service -n production

# Rollback to a specific revision
kubectl rollout undo deployment/booking-service -n production --to-revision=3

# Scale manually (overrides HPA temporarily)
kubectl scale deployment/booking-service -n production --replicas=30

# Restart all pods (rolling restart)
kubectl rollout restart deployment/booking-service -n production

# Pause a rollout (during a canary, if you need to investigate)
kubectl rollout pause deployment/booking-service -n production

# Resume a paused rollout
kubectl rollout resume deployment/booking-service -n production
```

### Node Operations

```bash
# Drain a node (evict all pods, respecting PDBs)
kubectl drain node-5 --ignore-daemonsets --delete-emptydir-data

# Cordon a node (prevent new pods, but don't evict existing ones)
kubectl cordon node-5

# Uncordon a node (allow scheduling again)
kubectl uncordon node-5
```

> **Mentor's Tip:** Print this cheat sheet. Tape it next to your monitor. In the first three months of working with Kubernetes, you will run these commands hundreds of times. After that, they become muscle memory. The most important ones to internalize: `kubectl get events` for debugging, `kubectl logs --previous` for crash investigations, and `kubectl rollout undo` for emergency rollbacks.

---

## Production War Story: The Thanksgiving Day Memory Limit Disaster

**November 2024. Thanksgiving week. The biggest booking period of the year.**

We had been running the platform on Kubernetes for eight months. Everything was stable. Monitoring was green. The team was confident. Too confident.

On Wednesday morning -- the day before Thanksgiving -- traffic started climbing as expected. The HPA scaled the Booking Service from 20 replicas to 35. Then 45. Then 55. All normal. The dashboards showed CPU at 60%, memory at 72%. Healthy.

At 2:17 PM, the Fraud Detection Service started OOMKilling. One pod. Then three. Then all eight.

**The root cause:** Three months earlier, a developer had updated the Fraud Detection Service to load a new machine learning model for detecting fraudulent bookings. The model was 1.2 GB in memory. The service's memory limit was set to 3 GB. Under normal load, the model plus the application used about 2.4 GB. But on Thanksgiving, the request volume tripled. Each request allocated temporary buffers for ML inference. Memory usage climbed to 3.1 GB, and Kubernetes killed the pod. The replacement pod loaded the model, hit the same traffic, and got killed again. An OOMKill loop.

**What we did wrong:**

1. **No load testing with the new model.** The developer tested the model's accuracy, but never stress-tested memory consumption under peak load. The resource limits were copy-pasted from the previous version.

2. **No memory-based HPA.** Our HPA only scaled on CPU and request rate. Memory was climbing, but we were not scaling on it. More replicas would have distributed the load and kept per-pod memory below the limit.

3. **No alert on memory approaching limits.** We had alerts for CPU, error rate, and latency. But no alert for "memory usage above 80% of the limit." The problem built gradually over hours with no warning.

**The cascading failure:** Without Fraud Detection, the Booking Service's circuit breaker kicked in and started bypassing fraud checks. This was by design -- we had decided that losing revenue from blocked bookings was worse than letting a few fraudulent bookings through. But the circuit breaker's fallback path had a bug: it logged a warning for every bypassed fraud check. At 50,000 bookings per minute, this produced 50,000 log lines per minute per pod. The logging volume overwhelmed Fluentd, which started dropping logs from ALL services. We lost observability at the worst possible moment.

**The fix (in order):**

1. **Immediate (5 minutes):** Increased the Fraud Detection memory limit from 3 Gi to 6 Gi via `kubectl edit deployment`. Pods restarted with the new limit and stabilized.

2. **Same day:** Added a memory-based metric to the HPA. Added Prometheus alerts for memory usage above 75% and 90% of limits.

3. **Next sprint:** Rearchitected the ML inference pipeline to stream predictions instead of loading the entire model into each pod. Memory usage dropped from 2.4 GB to 800 MB.

4. **Quarterly process:** Instituted mandatory load testing with updated resource profiles before any deployment that changes memory consumption patterns.

**The lesson:** Resource limits are not set-and-forget. Every change to your application's memory profile -- a new ML model, a larger cache, a different serialization library -- requires reviewing and potentially updating your resource limits. The Kubernetes scheduler and OOMKiller do not care about your Thanksgiving traffic. They enforce limits mechanically. You must ensure those limits match reality.

> **Mentor's Note:** I am sharing this story because every team learns this lesson the hard way. The temptation is to set generous limits and forget about them. But generous limits waste money (you are reserving cloud resources you do not use), and they mask problems (you do not notice that your application's memory footprint doubled). Set limits based on data. Review them when your code changes. And always, always load test before major traffic events.

---

## Common Mistakes with Kubernetes Deployments

After running our booking platform on Kubernetes for two years and consulting with other teams, here are the mistakes we see most often.

### Mistake 1: No Resource Requests or Limits

**What happens:** Pods are scheduled on overcommitted nodes. Under load, the kubelet starts evicting pods based on QoS class. Pods without requests are "BestEffort" -- they are evicted first. Your application goes down during traffic spikes.

**Fix:** Set resource requests and limits for every container. No exceptions. Use Prometheus data to size them accurately.

### Mistake 2: Liveness Probe That Checks Dependencies

```yaml
# BAD: Liveness probe checks database connectivity
livenessProbe:
  httpGet:
    path: /health          # This endpoint queries MySQL
    port: 3000
```

**What happens:** MySQL has a 30-second blip. The liveness probe fails. Kubernetes restarts the pod. But MySQL is still down, so the new pod also fails the liveness check. Kubernetes restarts it again. Now you have a restart loop for ALL 20 pods, even though the application code is perfectly fine. When MySQL recovers, all 20 pods are in CrashLoopBackOff with exponential backoff delays. Recovery takes 5-10 minutes instead of 30 seconds.

**Fix:** Liveness probes should only check the application process itself. Readiness probes check dependencies.

```yaml
# GOOD: Liveness checks the process, readiness checks dependencies
livenessProbe:
  httpGet:
    path: /health/live     # Returns 200 if the Node.js process is running
    port: 3000
readinessProbe:
  httpGet:
    path: /health/ready    # Returns 200 if MySQL + Redis are reachable
    port: 3000
```

### Mistake 3: Not Setting terminationGracePeriodSeconds

**What happens:** Default is 30 seconds. Your application takes 45 seconds to drain connections and finish in-flight requests. Kubernetes sends SIGKILL after 30 seconds. In-flight requests are aborted. Customers see 502 errors during every deployment.

**Fix:** Set `terminationGracePeriodSeconds` to at least 1.5x your application's drain time. If draining takes 30 seconds, set it to 45.

### Mistake 4: Using `latest` Tag in Production

```yaml
# BAD: Which version is "latest"? When was it built? Can you roll back?
image: registry.company.com/booking-service:latest
```

**What happens:** You cannot tell which version is running. You cannot roll back to a specific version. Two nodes might pull `latest` at different times and run different versions simultaneously.

**Fix:** Always use immutable, version-specific tags. Use the Git commit SHA or SemVer.

```yaml
# GOOD: Exact version, traceable to a Git commit
image: registry.company.com/booking-service:v2.14.3
```

### Mistake 5: No Pod Disruption Budget

**What happens:** A cluster upgrade drains 5 nodes simultaneously. All 20 booking pods happen to be on those 5 nodes (because you also skipped topology spread constraints). For 60 seconds, you have zero booking capacity.

**Fix:** Create a PDB for every production Deployment. `minAvailable: "80%"` is a sensible default.

### Mistake 6: Storing State in Pods Without PersistentVolumes

**What happens:** A developer runs MySQL in a Deployment with `emptyDir` storage. It works in development. In production, a node reboot wipes out all data. The backup system was backing up the PersistentVolume -- but there was no PersistentVolume.

**Fix:** Use StatefulSets with PersistentVolumeClaims for any workload that stores data. Set `reclaimPolicy: Retain` on the StorageClass so volumes survive even if the claim is deleted.

### Mistake 7: Not Using Namespaces for Isolation

**What happens:** Development, staging, and production all run in the `default` namespace. A developer accidentally applies a production-intended ConfigMap to the shared namespace. Staging is now running with production database credentials. Or worse -- a load test in development consumes all cluster resources and starves production.

**Fix:** Separate namespaces with ResourceQuotas. Never use the `default` namespace for anything.

### Mistake 8: Ignoring the Istio Sidecar's Resource Consumption

**What happens:** You size your pods for 1 CPU and 2 GB. Istio injects a sidecar that uses 100m CPU and 128 Mi memory. Your pod now needs 1.1 CPU and 2.1 GB, but the node only reserved 1 CPU and 2 GB. Under load, the sidecar's overhead pushes the pod over its memory limit.

**Fix:** Account for sidecar resources in your sizing. Set `sidecar.istio.io/proxyCPU` and `sidecar.istio.io/proxyMemory` annotations, and add those values to your pod's resource requests.

---

## Chapter Summary

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                  CHAPTER 36 SUMMARY: KUBERNETES DEPLOYMENT                  │
├──────────────────────────┬───────────────────────────────────────────────────┤
│ Concept                  │ What You Learned                                 │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Pods                     │ Smallest deployable unit. One container per pod   │
│                          │ in most cases. Ephemeral by design.              │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Deployments              │ Manage identical pod replicas. Handle rolling     │
│                          │ updates, rollbacks, and scaling.                  │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Pod Spec                 │ Security contexts, init containers, probes,       │
│                          │ affinity rules, DNS config, volume mounts.        │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Resource Sizing          │ Requests = guaranteed reservation (set to P95).   │
│                          │ Limits = ceiling (set to 2x requests). Review     │
│                          │ quarterly with production metrics.                │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ HPA                      │ Auto-scale on CPU, memory, custom Prometheus      │
│                          │ metrics (request rate, P99 latency, Kafka lag).   │
│                          │ Scale up fast, scale down conservatively.          │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Deployment Strategies    │ Rolling update (daily releases). Blue-green       │
│                          │ (instant cutover). Canary with Argo Rollouts      │
│                          │ (automated metric verification).                  │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ ConfigMaps & Secrets     │ ConfigMaps for non-sensitive config. External     │
│                          │ Secrets Operator for pulling from AWS Secrets     │
│                          │ Manager. Never commit plain secrets to Git.       │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Persistent Volumes       │ StatefulSets for MySQL and Redis with PVCs.       │
│                          │ gp3-encrypted StorageClass with Retain policy.    │
│                          │ Never use emptyDir for databases.                 │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Istio Service Mesh       │ Automatic mTLS between services. Traffic          │
│                          │ routing with VirtualServices. Circuit breaking    │
│                          │ with DestinationRules. Outlier detection.         │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Ingress Controller       │ NGINX Ingress with rate limiting, TLS via         │
│                          │ cert-manager, security headers, CORS. Single      │
│                          │ entry point for all external traffic.             │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Namespaces & RBAC        │ Per-environment namespaces with ResourceQuotas.   │
│                          │ Developers get read-only production access.       │
│                          │ SRE team gets full admin access.                  │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Pod Disruption Budgets   │ minAvailable 80% for app services.               │
│                          │ maxUnavailable 1 for databases. Required for      │
│                          │ zero-downtime cluster maintenance.                │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Helm Charts              │ Template manifests with values per environment.   │
│                          │ Single command deploys entire platform.           │
│                          │ Rollback with helm rollback.                      │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ Key Numbers              │ 132 nodes across 4 regions. 100 pods baseline.    │
│                          │ 80 max booking replicas. 45s grace period.        │
│                          │ 55-minute canary rollout. ~$72,500/month infra.   │
├──────────────────────────┼───────────────────────────────────────────────────┤
│ War Story Lesson         │ Resource limits must be updated when app memory   │
│                          │ profile changes. Load test before peak events.    │
│                          │ Alert on memory approaching limits, not just CPU. │
└──────────────────────────┴───────────────────────────────────────────────────┘
```

> **What Comes Next:** In Chapter 37, we move from deploying individual services to building the CI/CD pipeline that automates everything you saw in this chapter. You will see how a `git push` triggers image builds, runs tests, applies Helm charts, executes canary analysis, and promotes releases across regions -- all without human intervention. Kubernetes is the destination. CI/CD is the road that gets your code there.
