# Chapter 38: Infrastructure as Code — Servers as Configuration Files

## The Problem With Clicking Buttons

If you have used AWS, you have probably created resources through the web console. Click "Create Database," fill out a form, choose an instance type, set the password, click "Create." It works. The database exists. You move on.

Now do that 16 times for 16 MySQL shards. Now add 4 read replicas to each (64 more databases). Now add a Redis cluster with 6 nodes, a Kafka cluster with 15 brokers, a VPC with 12 subnets, an EKS cluster with 3 node groups, and a dozen security groups tying them all together. Now replicate all of that across 4 AWS regions: `us-east-1`, `eu-west-1`, `ap-southeast-1`, and `sa-east-1`. Now do it again in 6 months when you need to change a parameter across all of them. Now imagine someone accidentally deletes a security group through the console and you need to recreate it with the exact same rules.

This is where clicking breaks down. It does not scale. It is not repeatable. It is not versioned. And it introduces **configuration drift** -- the gradual, silent divergence between what your infrastructure should look like and what it actually looks like because someone changed a setting in one region but forgot the other three.

Our Global Booking System has approximately **430 individual cloud resources per region**. Across 4 regions, that is over 1,700 resources. Managing them through a web console is not just impractical -- it is reckless.

> **Analogy:** Imagine the difference between cooking from a recipe and cooking from memory. With a recipe (Infrastructure as Code), you get the exact same dish every time, anyone can make it, and you can hand the recipe to a new chef when you go on vacation. Cooking from memory (clicking in the console) works once, but you cannot reproduce it exactly, you definitely cannot explain every step to someone else, and six months later you have forgotten half the seasoning. Now imagine you are running 4 kitchens in 4 cities, each needing to serve the identical dish. "From memory" becomes outright dangerous.

---

## The Three Pillars of Infrastructure as Code

Before we touch any tools, you need to understand the philosophy driving IaC. It rests on three pillars.

### Pillar 1: Reproducibility

Every environment -- development, staging, production, disaster recovery -- is built from the same source code. You do not have a "special" production environment that was hand-tuned over two years by someone who has since left the company. You have a Git repository, and any engineer can spin up an exact replica of production by running a single command.

This is not theoretical. When AWS `us-east-1` experienced a major outage in December 2021, companies with IaC spun up replacement infrastructure in `us-west-2` within hours. Companies without IaC scrambled for days, trying to remember security group rules, database parameter settings, and subnet CIDR blocks from memory.

### Pillar 2: Version Control

Infrastructure changes go through the same process as code changes: branch, pull request, code review, merge, deploy. This means you have a complete history of every infrastructure change, who made it, when, and why. When something breaks, you can `git log` your way to the exact commit that caused the problem and `git revert` to fix it.

```
commit 3f7a9b1 (HEAD -> main)
Author: Sarah Chen <sarah@company.com>
Date:   Tue Feb 10 14:32:11 2026 +0000

    chore(infra): increase RDS max_connections from 5000 to 8000

    Booking service connection pools exhausting under peak load.
    CloudWatch alerted on connection_count > 4500 at 14:15 UTC.
    Increasing headroom to 8000 across all 16 shards.

    Reviewed-by: Marcus Johnson <marcus@company.com>
```

Compare this to "someone changed something in the console last Tuesday and now connections are timing out."

### Pillar 3: Drift Detection

Even with IaC, humans sometimes make manual changes through the console -- a quick security group rule addition during an incident, a parameter tweak to test a theory. Drift detection compares the actual state of your infrastructure against the declared state in your code and alerts you when they diverge. This is your safety net against "temporary" manual changes that become permanent, undocumented landmines.

> **Key Term:** **Infrastructure as Code (IaC)** — The practice of defining all infrastructure (servers, databases, networks, DNS records, IAM policies) in version-controlled configuration files rather than creating them manually through web consoles or CLI commands. The configuration file *is* the infrastructure specification. If it is not in the code, it does not exist.

> **Key Term:** **Configuration drift** — When the actual state of your infrastructure diverges from the intended state, usually because someone made a manual change that was not reflected in the configuration files. It leads to "works in staging but not production" bugs, makes disaster recovery unreliable, and creates security vulnerabilities that auditors will find before you do.

> **What If You Skip This?** Without IaC, recreating your infrastructure after a disaster (region outage, accidental deletion, security breach requiring full rebuild) takes days or weeks of manual work -- if you can even remember all the settings. With Terraform, you run `terraform apply` from a fresh environment and your entire infrastructure is rebuilt in minutes. This is not hypothetical: AWS regions have experienced outages; companies with IaC recovered in hours; companies without IaC suffered outages lasting days.

---

## Terraform: The Infrastructure Recipe Book

**Terraform** is a tool by HashiCorp that lets you write infrastructure specifications in a language called **HCL** (HashiCorp Configuration Language). You describe *what* you want (declarative), and Terraform figures out *how* to create it, update it, or destroy it.

Here is the fundamental workflow:

```
1. You write:       "I want a MySQL database with 128 GB RAM"  (in HCL)
2. terraform init:  Downloads provider plugins (aws, kubernetes, etc.)
3. terraform plan:  "Here's what I'll create/change/destroy. OK?"
4. terraform apply: "Done. The database exists now."
5. The state is saved: Terraform remembers what it created
6. You change the file: "Actually, 256 GB RAM"
7. terraform plan:   "I'll modify the existing database's RAM. OK?"
8. terraform apply:  "Done. RAM is now 256 GB."
```

The magic of step 7 is that Terraform knows the database already exists (because it tracks **state**). It does not try to create a second one. It modifies the existing one. This is the fundamental difference between imperative ("create a database") and declarative ("a database should exist with these properties") infrastructure management.

> **Analogy:** Think of Terraform like a GPS navigation system. You tell it where you want to be (the destination), and it figures out how to get there from where you currently are. If you take a wrong turn (manual drift), it recalculates. If you are already at the destination, it says "you have arrived." You never need to give turn-by-turn instructions -- you just declare the destination.

### The Four Core Concepts

Before we write any code, you need to understand four concepts that everything else builds on.

**1. Providers** — Plugins that let Terraform talk to cloud APIs. The `aws` provider knows how to create RDS instances, VPCs, and EKS clusters. The `kubernetes` provider knows how to create namespaces, deployments, and services. You can use multiple providers in the same project.

```hcl
# terraform/providers.tf

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "global-booking-system"
      Environment = var.environment
      ManagedBy   = "terraform"
      Team        = "platform-engineering"
    }
  }
}
```

The `default_tags` block is a production best practice. Every resource Terraform creates automatically gets tagged with the project name, environment, and the fact that Terraform manages it. When someone browses the AWS console and sees `ManagedBy: terraform`, they know not to modify it manually.

**2. Resources** — The actual infrastructure components: a database, a VPC, a security group. Each resource block declares one piece of infrastructure.

```hcl
resource "aws_db_instance" "primary" {
  identifier     = "booking-shard-1-primary"
  engine         = "mysql"
  instance_class = "db.r6g.4xlarge"
  # ... more configuration
}
```

**3. Modules** — Reusable groups of resources. Instead of copy-pasting 16 database configurations, you write a module once and call it 16 times with different parameters. Modules are to Terraform what functions are to programming.

**4. State** — A JSON file that maps your HCL declarations to real cloud resources. When you declare `aws_db_instance.primary`, Terraform creates it and records the real AWS resource ID (like `db-ABC123DEF456`) in the state file. On the next `terraform plan`, Terraform checks whether `db-ABC123DEF456` still exists and whether its properties still match your declaration.

> **Key Term:** **HCL (HashiCorp Configuration Language)** — Terraform's domain-specific language. It is declarative (you describe the desired end state, not the steps to get there), supports variables, loops, conditionals, and string interpolation. If you know JSON and have used template literals in JavaScript, HCL will feel familiar within an hour.

> **Key Term:** **Terraform state** — A JSON file that records the mapping between your declared resources and the actual cloud resources they correspond to. Without state, Terraform would not know whether a resource already exists or needs to be created. Losing your state file is like losing the address book for your entire infrastructure -- Terraform no longer knows what it owns.

---

## Reading Our Terraform Code

Let me walk through the Terraform configuration that builds our Global Booking System's infrastructure. We will start with the foundation -- networking -- and build up to databases, caching, and messaging.

### The Project Structure

```
terraform/
├── main.tf                    # Root module entry point
├── providers.tf               # Provider configuration
├── variables.tf               # Input variables
├── outputs.tf                 # Output values
├── terraform.tfvars           # Variable values (NOT committed)
├── backend.tf                 # Remote state configuration
├── versions.tf                # Terraform version constraints
│
├── environments/
│   ├── dev.tfvars             # Development overrides
│   ├── staging.tfvars         # Staging overrides
│   └── prod.tfvars            # Production values
│
└── modules/
    ├── vpc/                   # Networking module
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── eks/                   # Kubernetes cluster module
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── mysql-shard/           # Database shard module
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    ├── redis-cluster/         # Redis cluster module
    │   ├── main.tf
    │   ├── variables.tf
    │   └── outputs.tf
    └── kafka/                 # MSK (Kafka) module
        ├── main.tf
        ├── variables.tf
        └── outputs.tf
```

Each module has the same three files: `main.tf` (the resources), `variables.tf` (the inputs), and `outputs.tf` (the values other modules can reference). This convention is universal in the Terraform world.

### Variables: The Root Configuration

```hcl
# terraform/variables.tf

variable "aws_region" {
  description = "Primary AWS region for this deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be dev, staging, or prod."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "mysql_shard_count" {
  description = "Number of MySQL shards"
  type        = number
  default     = 16
}

variable "mysql_replica_count" {
  description = "Read replicas per shard"
  type        = number
  default     = 4
}

variable "mysql_instance_class" {
  description = "RDS instance type for MySQL shards"
  type        = string
  default     = "db.r6g.4xlarge"
}

variable "redis_node_type" {
  description = "ElastiCache node type for Redis clusters"
  type        = string
  default     = "cache.r6g.2xlarge"
}

variable "kafka_broker_count" {
  description = "Number of Kafka brokers in the MSK cluster"
  type        = number
  default     = 15
}

variable "kafka_instance_type" {
  description = "MSK broker instance type"
  type        = string
  default     = "kafka.m5.4xlarge"
}
```

The `validation` block on `environment` prevents typos. If someone runs `terraform apply -var="environment=prodd"`, Terraform rejects it before touching any cloud resources. Fail fast, fail loudly.

### The Root Module: Wiring Everything Together

```hcl
# terraform/main.tf — The orchestrator

# ─── NETWORKING ────────────────────────────────────────────────
module "vpc" {
  source = "./modules/vpc"

  environment = var.environment
  vpc_cidr    = var.vpc_cidr
  aws_region  = var.aws_region
}

# ─── KUBERNETES ────────────────────────────────────────────────
module "eks" {
  source = "./modules/eks"

  environment    = var.environment
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  cluster_name   = "booking-${var.environment}"
}

# ─── DATABASE SHARDS ──────────────────────────────────────────
module "mysql_shards" {
  source   = "./modules/mysql-shard"
  count    = var.mysql_shard_count

  shard_number    = count.index
  environment     = var.environment
  region          = var.aws_region
  instance_class  = var.mysql_instance_class
  replica_count   = var.mysql_replica_count
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.database_subnet_ids
  allowed_sg_ids  = [module.eks.node_security_group_id]
}

# ─── REDIS CLUSTERS ───────────────────────────────────────────
module "redis_sessions" {
  source = "./modules/redis-cluster"

  cluster_name = "sessions-${var.environment}"
  node_type    = var.redis_node_type
  num_shards   = 3
  replicas     = 2
  vpc_id       = module.vpc.vpc_id
  subnet_ids   = module.vpc.database_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}

module "redis_fencing" {
  source = "./modules/redis-cluster"

  cluster_name = "fencing-${var.environment}"
  node_type    = var.redis_node_type
  num_shards   = 3
  replicas     = 2
  vpc_id       = module.vpc.vpc_id
  subnet_ids   = module.vpc.database_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}

module "redis_cache" {
  source = "./modules/redis-cluster"

  cluster_name = "cache-${var.environment}"
  node_type    = var.redis_node_type
  num_shards   = 6
  replicas     = 2
  vpc_id       = module.vpc.vpc_id
  subnet_ids   = module.vpc.database_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}

module "redis_rate_limiting" {
  source = "./modules/redis-cluster"

  cluster_name = "ratelimit-${var.environment}"
  node_type    = "cache.r6g.xlarge"
  num_shards   = 2
  replicas     = 1
  vpc_id       = module.vpc.vpc_id
  subnet_ids   = module.vpc.database_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
}

# ─── KAFKA (MSK) ──────────────────────────────────────────────
module "kafka" {
  source = "./modules/kafka"

  cluster_name   = "events-${var.environment}"
  broker_count   = var.kafka_broker_count
  instance_type  = var.kafka_instance_type
  vpc_id         = module.vpc.vpc_id
  subnet_ids     = module.vpc.private_subnet_ids
  allowed_sg_ids = [module.eks.node_security_group_id]
  environment    = var.environment
}
```

Notice the dependency chain. The VPC creates first (networking). Then EKS and the databases can create in parallel (they both depend on the VPC but not on each other). Terraform builds a **dependency graph** and parallelizes wherever possible. A full `terraform apply` for a new region takes about 35-45 minutes -- most of that time is AWS provisioning the EKS cluster and RDS instances.

Also notice how we use the same `redis-cluster` module four times with different parameters. That is the power of modules: one definition, four instantiations. If we need to change the Redis engine version, we change it in one place.

> **Key Term:** **Terraform module** — A reusable, self-contained group of Terraform resources. Think of it as a function: it accepts inputs (variables), creates resources, and exposes outputs. You define it once and call it as many times as needed with different parameters.

> **Checkpoint:** Look at the `main.tf` file above. Can you identify which resources depend on the VPC module? Can you explain why `module.vpc.vpc_id` appears in nearly every other module call? Can you explain why the Redis cache module has 6 shards while the rate-limiting module has only 2? If you can answer all three, you understand Terraform's module composition model.

---

## The Modules in Detail

Now let us walk through each module. These are the building blocks that the root `main.tf` wires together. Understanding them means understanding exactly what infrastructure our Global Booking System runs on.

### Module 1: VPC — The Network Foundation

Every resource lives inside a Virtual Private Cloud. The VPC module creates the network topology: subnets across multiple availability zones, route tables, NAT gateways for outbound internet access, and the isolation boundaries between public-facing load balancers, private application pods, and strictly private databases.

```hcl
# terraform/modules/vpc/variables.tf

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
}

variable "aws_region" {
  description = "AWS region"
  type        = string
}

variable "availability_zones" {
  description = "List of AZs to use (defaults to 3)"
  type        = list(string)
  default     = []
}
```

```hcl
# terraform/modules/vpc/main.tf

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = length(var.availability_zones) > 0 ? var.availability_zones : slice(
    data.aws_availability_zones.available.names, 0, 3
  )
  az_count = length(local.azs)
}

# ─── THE VPC ITSELF ──────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "booking-${var.environment}-vpc"
  }
}

# ─── SUBNETS ─────────────────────────────────────────────────
# Three tiers: public (ALBs), private (EKS pods), database (RDS/Redis)
# Each tier spans 3 availability zones for high availability.

resource "aws_subnet" "public" {
  count             = local.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone = local.azs[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name                                           = "booking-${var.environment}-public-${local.azs[count.index]}"
    "kubernetes.io/role/elb"                       = "1"
    "kubernetes.io/cluster/booking-${var.environment}" = "shared"
  }
}

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 4)
  availability_zone = local.azs[count.index]

  tags = {
    Name                                           = "booking-${var.environment}-private-${local.azs[count.index]}"
    "kubernetes.io/role/internal-elb"              = "1"
    "kubernetes.io/cluster/booking-${var.environment}" = "shared"
  }
}

resource "aws_subnet" "database" {
  count             = local.az_count
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 200)
  availability_zone = local.azs[count.index]

  tags = {
    Name = "booking-${var.environment}-database-${local.azs[count.index]}"
  }
}

# ─── INTERNET GATEWAY & NAT ─────────────────────────────────

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "booking-${var.environment}-igw" }
}

resource "aws_eip" "nat" {
  count  = local.az_count
  domain = "vpc"
  tags   = { Name = "booking-${var.environment}-nat-eip-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = local.az_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "booking-${var.environment}-nat-${count.index}" }

  depends_on = [aws_internet_gateway.main]
}

# ─── ROUTE TABLES ────────────────────────────────────────────

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "booking-${var.environment}-public-rt" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.main.id
  tags   = { Name = "booking-${var.environment}-private-rt-${count.index}" }
}

resource "aws_route" "private_nat" {
  count                  = local.az_count
  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[count.index].id
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# ─── VPC FLOW LOGS (for security auditing) ───────────────────

resource "aws_flow_log" "main" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.vpc_flow.arn
  iam_role_arn         = aws_iam_role.vpc_flow_log.arn
}

resource "aws_cloudwatch_log_group" "vpc_flow" {
  name              = "/aws/vpc/flow-logs/booking-${var.environment}"
  retention_in_days = var.environment == "prod" ? 90 : 14
}
```

Notice the `cidrsubnet` function: it automatically carves up the VPC's IP address space into non-overlapping ranges for each subnet tier. No manual IP math required. The Kubernetes-specific tags on the subnets tell the AWS Load Balancer Controller which subnets to place load balancers in -- without those tags, your Kubernetes `Service` objects of type `LoadBalancer` will fail to provision.

> **Why three NAT gateways?** Each AZ gets its own NAT gateway. If AZ-a goes down, pods in AZ-b and AZ-c still have outbound internet access through their own NAT gateways. A single NAT gateway would be a cross-AZ single point of failure.

```hcl
# terraform/modules/vpc/outputs.tf

output "vpc_id" {
  description = "ID of the created VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of private subnets (for EKS nodes)"
  value       = aws_subnet.private[*].id
}

output "database_subnet_ids" {
  description = "IDs of database subnets (for RDS, ElastiCache)"
  value       = aws_subnet.database[*].id
}
```

The outputs are the module's public API. Other modules reference `module.vpc.vpc_id` and `module.vpc.private_subnet_ids` to place their resources into this network.

### Module 2: EKS — The Kubernetes Cluster

Our NestJS microservices run on Kubernetes, hosted by AWS Elastic Kubernetes Service. The EKS module creates the control plane, configures node groups for different workload types, and sets up the OIDC provider needed for IAM Roles for Service Accounts (IRSA).

```hcl
# terraform/modules/eks/main.tf

resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  version  = "1.29"
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.environment == "dev" ? true : false
    security_group_ids      = [aws_security_group.cluster.id]
  }

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks.arn
    }
    resources = ["secrets"]
  }

  enabled_cluster_log_types = [
    "api", "audit", "authenticator", "controllerManager", "scheduler"
  ]

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_iam_role_policy_attachment.cluster_vpc_controller,
  ]
}

# ─── NODE GROUPS ─────────────────────────────────────────────
# We separate workloads into different node groups:
#   - "general" for stateless API pods
#   - "memory-optimized" for Redis-heavy and caching workloads
#   - "compute-optimized" for booking engine calculations

resource "aws_eks_node_group" "general" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "general-${var.environment}"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = ["m6i.2xlarge"]

  scaling_config {
    desired_size = var.environment == "prod" ? 12 : 3
    min_size     = var.environment == "prod" ? 6 : 2
    max_size     = var.environment == "prod" ? 30 : 6
  }

  update_config {
    max_unavailable_percentage = 25
  }

  labels = {
    workload-type = "general"
    environment   = var.environment
  }

  tags = { Name = "booking-${var.environment}-general-node" }
}

resource "aws_eks_node_group" "memory_optimized" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "memory-opt-${var.environment}"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = ["r6i.2xlarge"]

  scaling_config {
    desired_size = var.environment == "prod" ? 6 : 2
    min_size     = var.environment == "prod" ? 3 : 1
    max_size     = var.environment == "prod" ? 15 : 4
  }

  labels = {
    workload-type = "memory-optimized"
  }

  taint {
    key    = "workload-type"
    value  = "memory-optimized"
    effect = "NO_SCHEDULE"
  }
}

resource "aws_eks_node_group" "compute_optimized" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "compute-opt-${var.environment}"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.subnet_ids
  instance_types  = ["c6i.4xlarge"]

  scaling_config {
    desired_size = var.environment == "prod" ? 8 : 2
    min_size     = var.environment == "prod" ? 4 : 1
    max_size     = var.environment == "prod" ? 20 : 4
  }

  labels = {
    workload-type = "compute-optimized"
  }

  taint {
    key    = "workload-type"
    value  = "compute-optimized"
    effect = "NO_SCHEDULE"
  }
}

# ─── OIDC PROVIDER FOR IRSA ─────────────────────────────────
# This lets Kubernetes service accounts assume AWS IAM roles,
# so pods can access AWS resources without static credentials.

data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}
```

The `taint` blocks on the memory-optimized and compute-optimized node groups are critical. A taint says "do not schedule any pod on me unless that pod explicitly tolerates this taint." This prevents generic pods from landing on expensive specialized nodes. Only pods with a matching `toleration` in their Kubernetes spec will be scheduled there.

> **Why separate node groups?** Cost optimization. General API pods run on balanced `m6i` instances. The booking engine, which does heavy date range calculations and availability checks, runs on compute-optimized `c6i` instances with higher clock speeds. Caching services that need large amounts of RAM run on memory-optimized `r6i` instances. Mixing workloads on a single node type means you either overpay for RAM (for CPU-bound workloads) or underprovision CPU (for memory-bound workloads).

### Module 3: MySQL Shards — The Database Layer

This is where the chapter's theme becomes concrete. Instead of clicking "Create Database" 16 times in the AWS console and then clicking "Create Read Replica" 64 times, we define it once and use Terraform's `count` parameter.

```hcl
# terraform/modules/mysql-shard/main.tf

resource "aws_db_subnet_group" "shard" {
  name       = "booking-${var.environment}-shard-${var.shard_number}"
  subnet_ids = var.subnet_ids

  tags = { Name = "booking-shard-${var.shard_number}-subnet-group" }
}

resource "aws_security_group" "shard" {
  name_prefix = "booking-shard-${var.shard_number}-"
  vpc_id      = var.vpc_id
  description = "Security group for MySQL shard ${var.shard_number}"

  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = var.allowed_sg_ids
    description     = "MySQL access from EKS nodes"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_parameter_group" "shard" {
  family = "mysql8.0"
  name        = "booking-${var.environment}-shard-${var.shard_number}"
  description = "Parameters for booking shard ${var.shard_number}"

  parameter {
    name  = "max_connections"
    value = var.environment == "prod" ? "8000" : "500"
  }

  parameter {
    name  = "innodb_buffer_pool_size"
    value = "{DBInstanceClassMemory*3/4}"
  }

  parameter {
    name  = "slow_query_log"
    value = "1"
  }

  parameter {
    name  = "long_query_time"
    value = "0.5"
  }

  parameter {
    name  = "binlog_format"
    value = "ROW"
  }

  parameter {
    name         = "character_set_server"
    value        = "utf8mb4"
    apply_method = "pending-reboot"
  }
}

# ─── PRIMARY INSTANCE ────────────────────────────────────────

resource "aws_db_instance" "primary" {
  identifier     = "booking-${var.environment}-shard-${var.shard_number}-primary"
  engine         = "mysql"
  engine_version = "8.0.36"
  instance_class = var.instance_class

  allocated_storage     = 500
  max_allocated_storage = 2000
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn

  db_name  = "booking_shard_${var.shard_number}"
  username = "admin"
  password = var.master_password  # From AWS Secrets Manager

  db_subnet_group_name   = aws_db_subnet_group.shard.name
  vpc_security_group_ids = [aws_security_group.shard.id]
  parameter_group_name   = aws_db_parameter_group.shard.name

  multi_az                     = var.environment == "prod" ? true : false
  backup_retention_period      = var.environment == "prod" ? 35 : 7
  backup_window                = "03:00-04:00"
  maintenance_window           = "sun:04:00-sun:05:00"
  auto_minor_version_upgrade   = true
  deletion_protection          = var.environment == "prod" ? true : false
  skip_final_snapshot          = var.environment == "prod" ? false : true
  final_snapshot_identifier    = "booking-shard-${var.shard_number}-final-${formatdate("YYYY-MM-DD", timestamp())}"
  copy_tags_to_snapshot        = true

  performance_insights_enabled = true
  monitoring_interval          = 30
  monitoring_role_arn          = var.monitoring_role_arn

  tags = {
    Name        = "booking-shard-${var.shard_number}-primary"
    ShardIndex  = var.shard_number
    Role        = "primary"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ─── READ REPLICAS ───────────────────────────────────────────

resource "aws_db_instance" "replica" {
  count               = var.replica_count
  identifier          = "booking-${var.environment}-shard-${var.shard_number}-replica-${count.index}"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.instance_class

  storage_encrypted    = true
  kms_key_id           = var.kms_key_arn
  skip_final_snapshot  = true

  performance_insights_enabled = true
  monitoring_interval          = 30
  monitoring_role_arn          = var.monitoring_role_arn

  tags = {
    Name        = "booking-shard-${var.shard_number}-replica-${count.index}"
    ShardIndex  = var.shard_number
    Role        = "replica"
    ReplicaIndex = count.index
  }
}
```

Two critical `lifecycle` blocks to notice. On the primary database: `prevent_destroy = true`. This means Terraform will refuse to destroy this resource, even if you ask it to. You must explicitly remove this protection before decommissioning a shard. On the security group: `create_before_destroy = true`. When updating a security group, Terraform creates the replacement first, switches the reference, then destroys the old one, avoiding a window where there is no security group at all.

> **Key Term:** **`lifecycle` block** -- Terraform meta-argument that controls how resources are created, updated, and destroyed. `prevent_destroy` is your safety net against accidental deletion of stateful resources like databases. `create_before_destroy` ensures zero-downtime replacements. `ignore_changes` tells Terraform not to revert manually changed attributes (use sparingly, as it creates hidden drift).

### Module 4: Redis Cluster — Caching and Session Storage

```hcl
# terraform/modules/redis-cluster/main.tf

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.cluster_name}-subnet-group"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.cluster_name}-redis-"
  vpc_id      = var.vpc_id
  description = "Security group for Redis cluster ${var.cluster_name}"

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = var.allowed_sg_ids
    description     = "Redis access from EKS nodes"
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = var.cluster_name
  description          = "Redis cluster for ${var.cluster_name}"
  node_type            = var.node_type
  port                 = 6379

  num_node_groups         = var.num_shards
  replicas_per_node_group = var.replicas

  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = var.auth_token

  subnet_group_name  = aws_elasticache_subnet_group.redis.name
  security_group_ids = [aws_security_group.redis.id]

  snapshot_retention_limit = var.environment == "prod" ? 7 : 1
  snapshot_window          = "02:00-03:00"
  maintenance_window       = "sun:03:00-sun:04:00"

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis_slow.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = {
    Name = var.cluster_name
  }
}

resource "aws_cloudwatch_log_group" "redis_slow" {
  name              = "/aws/elasticache/${var.cluster_name}/slow-log"
  retention_in_days = 14
}
```

Notice that `transit_encryption_enabled = true` and `auth_token` are set. In production, all Redis traffic is encrypted in transit (TLS) and requires authentication. This is non-negotiable for a system handling booking data. The `num_node_groups` parameter controls Redis Cluster sharding -- 6 shards for the cache cluster, 3 for sessions and fencing, 2 for rate limiting. Each shard has its own primary and replicas.

### Module 5: MSK (Kafka) — The Event Backbone

```hcl
# terraform/modules/kafka/main.tf

resource "aws_msk_cluster" "main" {
  cluster_name           = var.cluster_name
  kafka_version          = "3.6.0"
  number_of_broker_nodes = var.broker_count

  broker_node_group_info {
    instance_type   = var.instance_type
    client_subnets  = var.subnet_ids
    security_groups = [aws_security_group.kafka.id]

    storage_info {
      ebs_storage_info {
        volume_size = 1000  # 1 TB per broker
        provisioned_throughput {
          enabled           = true
          volume_throughput  = 250  # MB/s
        }
      }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
    encryption_at_rest_kms_key_arn = var.kms_key_arn
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.kafka.name
      }
    }
  }

  tags = { Name = var.cluster_name }
}

resource "aws_msk_configuration" "main" {
  name              = "${var.cluster_name}-config"
  kafka_versions    = ["3.6.0"]

  server_properties = <<-PROPERTIES
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    num.partitions=12
    log.retention.hours=168
    log.retention.bytes=107374182400
    message.max.bytes=10485760
    replica.lag.time.max.ms=30000
    unclean.leader.election.enable=false
    PROPERTIES
}

resource "aws_security_group" "kafka" {
  name_prefix = "${var.cluster_name}-kafka-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    security_groups = var.allowed_sg_ids
    description     = "Kafka TLS access from EKS"
  }

  ingress {
    from_port       = 9094
    to_port         = 9094
    protocol        = "tcp"
    self            = true
    description     = "Inter-broker communication"
  }
}

resource "aws_cloudwatch_log_group" "kafka" {
  name              = "/aws/msk/${var.cluster_name}"
  retention_in_days = 30
}
```

Two Kafka settings deserve special attention. `auto.create.topics.enable=false` prevents accidental topic creation -- every topic in our system must be explicitly declared and reviewed. `unclean.leader.election.enable=false` prevents a broker with stale data from becoming the leader, which could cause data loss. We would rather have a partition be temporarily unavailable than serve stale booking events.

> **Checkpoint:** We have now defined 5 modules: VPC, EKS, MySQL shards, Redis clusters, and MSK Kafka. Go back to the root `main.tf` and trace how data flows: the VPC creates subnet IDs, which flow into EKS and MySQL and Redis and Kafka. EKS creates a node security group ID, which flows into MySQL, Redis, and Kafka as the "allowed" security group for ingress rules. This is the dependency graph that Terraform builds automatically from your references. Draw it on paper if that helps.

---

## Terraform State: The Source of Truth

We declared all these resources in HCL, but Terraform needs to know what actually exists in AWS. That mapping -- "resource `aws_db_instance.primary` in my code corresponds to AWS resource `db-ABC123DEF456`" -- lives in the **state file**.

By default, state is stored locally in a file called `terraform.tfstate`. This is fine for learning. It is catastrophic for teams.

Here is why: if two engineers run `terraform apply` at the same time with a local state file, they will overwrite each other's changes. Engineer A creates a database, writes the state. Engineer B, still using the old state, creates a conflicting resource. Now reality does not match either state file. You are in state corruption territory.

The solution is a **remote backend** with **state locking**.

```hcl
# terraform/backend.tf

terraform {
  backend "s3" {
    bucket         = "booking-system-terraform-state"
    key            = "global-booking/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "terraform-state-locks"

    # Prevent accidental deletion of the state bucket
    # This bucket has versioning enabled so we can recover
    # from state file corruption.
  }
}
```

```hcl
# This is a SEPARATE Terraform project that creates the backend itself.
# You cannot use a backend before it exists (chicken-and-egg problem).
# terraform/bootstrap/main.tf

resource "aws_s3_bucket" "terraform_state" {
  bucket = "booking-system-terraform-state"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "terraform_locks" {
  name         = "terraform-state-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
```

The DynamoDB table provides **locking**. When Engineer A runs `terraform apply`, Terraform writes a lock entry to DynamoDB. If Engineer B tries to run `terraform apply` at the same time, Terraform sees the lock and says: "Error: state is locked by Engineer A. Please wait or force-unlock." This prevents concurrent state modifications.

S3 bucket versioning is your recovery mechanism. If the state file ever gets corrupted, you can restore a previous version from S3's version history.

> **Key Term:** **Remote backend** -- Storing Terraform state in a shared, remote location (S3, Azure Blob Storage, Google Cloud Storage) instead of locally. This enables team collaboration, state locking, and state file recovery. The combination of S3 (storage) + DynamoDB (locking) is the standard pattern for AWS-based Terraform workflows.

> **What If You Skip This?** If you use local state and lose the file (laptop crash, accidental deletion, switching machines), Terraform no longer knows what it created. Running `terraform apply` will try to create everything again, causing conflicts with existing resources. You will spend hours running `terraform import` to manually rebuild the state, one resource at a time. For 430 resources per region, that would take days.

---

## Environment Management: Keeping Dev, Staging, and Prod Apart

You have one set of Terraform modules, but you need three (or more) environments: development, staging, and production. Each environment should have the same *shape* of infrastructure but different *sizes* and *settings*. Dev gets 2 Kafka brokers; production gets 15. Dev databases skip final snapshots; production databases keep 35 days of backups.

There are two dominant strategies: **workspaces** and **directory-based separation**. We use directory-based separation, and I will explain why.

### Strategy 1: Terraform Workspaces (and Why We Avoid Them)

Terraform workspaces let you maintain multiple state files for the same configuration. You switch between them like Git branches:

```bash
terraform workspace new staging
terraform workspace new prod
terraform workspace select staging
terraform apply -var-file="environments/staging.tfvars"
```

The problem is that workspaces share the same backend configuration and the same code. If an engineer runs `terraform apply` without checking which workspace they are in, they can apply staging variables to production infrastructure. The workspace name is invisible in the code -- it is runtime state, not declared state. For a booking system handling real money, this ambiguity is unacceptable.

### Strategy 2: Directory-Based Separation (Our Approach)

Each environment gets its own directory with its own backend configuration. The modules are shared, but the entry points are separate:

```
terraform/
├── modules/                 # Shared modules (VPC, EKS, MySQL, etc.)
│   ├── vpc/
│   ├── eks/
│   ├── mysql-shard/
│   ├── redis-cluster/
│   └── kafka/
│
├── environments/
│   ├── dev/
│   │   ├── main.tf          # Calls shared modules with dev params
│   │   ├── backend.tf       # State: s3://.../.../dev/terraform.tfstate
│   │   ├── variables.tf
│   │   └── terraform.tfvars
│   ├── staging/
│   │   ├── main.tf
│   │   ├── backend.tf       # State: s3://.../.../staging/terraform.tfstate
│   │   ├── variables.tf
│   │   └── terraform.tfvars
│   └── prod/
│       ├── main.tf
│       ├── backend.tf       # State: s3://.../.../prod/terraform.tfstate
│       ├── variables.tf
│       └── terraform.tfvars
```

```hcl
# terraform/environments/dev/terraform.tfvars

environment        = "dev"
aws_region         = "us-east-1"
vpc_cidr           = "10.10.0.0/16"
mysql_shard_count  = 2            # Only 2 shards in dev
mysql_replica_count = 1           # Only 1 replica in dev
mysql_instance_class = "db.t3.medium"  # Smallest viable instance
redis_node_type    = "cache.t3.medium"
kafka_broker_count = 3
kafka_instance_type = "kafka.t3.small"
```

```hcl
# terraform/environments/prod/terraform.tfvars

environment         = "prod"
aws_region          = "us-east-1"
vpc_cidr            = "10.0.0.0/16"
mysql_shard_count   = 16
mysql_replica_count = 4
mysql_instance_class = "db.r6g.4xlarge"
redis_node_type     = "cache.r6g.2xlarge"
kafka_broker_count  = 15
kafka_instance_type = "kafka.m5.4xlarge"
```

Now the workflow is unambiguous. To deploy to dev, you `cd terraform/environments/dev && terraform apply`. To deploy to prod, you `cd terraform/environments/prod && terraform apply`. There is no workspace to forget to switch. The directory you are in *is* the environment. The backend configuration points to a completely separate state file. You cannot accidentally mix them.

> **Analogy:** Workspaces are like having one kitchen with a sign on the door that says "staging" or "production." Directory-based separation is like having physically separate kitchens in different buildings. You cannot accidentally cook a staging meal in the production kitchen because you are literally in a different building.

---

## Pulumi: The TypeScript Alternative

Some teams find HCL limiting. It is a domain-specific language: you cannot import NPM packages, write unit tests with Jest, or use the same language your application is written in. **Pulumi** solves this by letting you define infrastructure using general-purpose programming languages -- including TypeScript, which our NestJS engineers already know.

Here is the same VPC module in Pulumi TypeScript:

```typescript
// pulumi/vpc.ts
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

interface VpcArgs {
  environment: string;
  vpcCidr: string;
  azCount: number;
}

export class BookingVpc extends pulumi.ComponentResource {
  public readonly vpcId: pulumi.Output<string>;
  public readonly privateSubnetIds: pulumi.Output<string>[];
  public readonly databaseSubnetIds: pulumi.Output<string>[];

  constructor(name: string, args: VpcArgs, opts?: pulumi.ComponentResourceOptions) {
    super('booking:network:Vpc', name, {}, opts);

    const vpc = new aws.ec2.Vpc(`${name}-vpc`, {
      cidrBlock: args.vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `booking-${args.environment}-vpc` },
    }, { parent: this });

    this.vpcId = vpc.id;

    // Create subnets programmatically with TypeScript loops
    const publicSubnets: aws.ec2.Subnet[] = [];
    const privateSubnets: aws.ec2.Subnet[] = [];
    const databaseSubnets: aws.ec2.Subnet[] = [];

    const azs = aws.getAvailabilityZones({ state: 'available' });

    for (let i = 0; i < args.azCount; i++) {
      const az = azs.then(a => a.names[i]);

      publicSubnets.push(new aws.ec2.Subnet(`${name}-public-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i}.0/24`,
        availabilityZone: az,
        mapPublicIpOnLaunch: true,
        tags: {
          Name: `booking-${args.environment}-public-${i}`,
          'kubernetes.io/role/elb': '1',
        },
      }, { parent: this }));

      privateSubnets.push(new aws.ec2.Subnet(`${name}-private-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 16}.0/20`,
        availabilityZone: az,
        tags: {
          Name: `booking-${args.environment}-private-${i}`,
          'kubernetes.io/role/internal-elb': '1',
        },
      }, { parent: this }));

      databaseSubnets.push(new aws.ec2.Subnet(`${name}-database-${i}`, {
        vpcId: vpc.id,
        cidrBlock: `10.0.${i + 200}.0/24`,
        availabilityZone: az,
        tags: { Name: `booking-${args.environment}-database-${i}` },
      }, { parent: this }));
    }

    this.privateSubnetIds = privateSubnets.map(s => s.id);
    this.databaseSubnetIds = databaseSubnets.map(s => s.id);

    this.registerOutputs({
      vpcId: this.vpcId,
      privateSubnetIds: this.privateSubnetIds,
      databaseSubnetIds: this.databaseSubnetIds,
    });
  }
}
```

### Terraform vs. Pulumi: Honest Comparison

| Aspect | Terraform (HCL) | Pulumi (TypeScript) |
|--------|-----------------|---------------------|
| **Language** | HCL (domain-specific) | TypeScript, Python, Go, C# |
| **Learning curve for NestJS team** | New language to learn | Same language they already use |
| **Testing** | `terraform validate`, Terratest (Go) | Jest, standard TypeScript testing |
| **IDE support** | Basic (VS Code extension) | Full TypeScript intellisense, autocomplete |
| **Community and ecosystem** | Massive, mature | Growing, strong but smaller |
| **State management** | S3 + DynamoDB (self-managed) | Pulumi Cloud (managed) or self-managed |
| **Provider coverage** | Most comprehensive | Uses Terraform providers via bridge |
| **Hiring** | Most DevOps engineers know Terraform | Fewer candidates with Pulumi experience |
| **Complex logic** | Awkward (HCL loops, conditionals) | Natural (full programming language) |
| **Blast radius** | Less powerful = less footgun risk | More powerful = more footgun risk |

We chose Terraform for the Global Booking System because of its ecosystem maturity and because most infrastructure engineers on the market know HCL. But Pulumi is a legitimate choice, especially for teams where all engineers are full-stack TypeScript developers and there is no dedicated infrastructure team.

> **Key Term:** **Pulumi** -- An infrastructure as code platform that lets you use general-purpose programming languages (TypeScript, Python, Go, C#) instead of domain-specific languages. Resources are defined as objects, infrastructure is code you can test with standard testing frameworks, and you get full IDE support. The tradeoff is a smaller community and the risk of overengineering infrastructure with complex programming patterns.

---

## Secret Management in IaC

There is one thing you must never put in your Terraform files: secrets. No database passwords, no API keys, no TLS certificates. The Terraform state file stores resource attributes in plaintext, and even though your state file is encrypted at rest in S3, anyone with read access to the state can see every password.

### The Problem

```hcl
# NEVER DO THIS
resource "aws_db_instance" "primary" {
  username = "admin"
  password = "SuperSecret123!"  # This ends up in state file in plaintext
}
```

### The Solution: AWS Secrets Manager + Data Sources

```hcl
# Generate a random password and store it in Secrets Manager
resource "random_password" "db_master" {
  length  = 32
  special = true
}

resource "aws_secretsmanager_secret" "db_password" {
  name                    = "booking/${var.environment}/db-master-password"
  recovery_window_in_days = var.environment == "prod" ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db_master.result
}

# Reference the secret in the database resource
resource "aws_db_instance" "primary" {
  username = "admin"
  password = random_password.db_master.result
  # The password is still in state, but it was never in your code.
  # State is encrypted in S3 and access-controlled via IAM.
}
```

### HashiCorp Vault Integration

For teams that need centralized secret management beyond AWS-native services, HashiCorp Vault provides a unified secrets engine. The Terraform Vault provider can both read secrets from Vault and manage Vault's own configuration:

```hcl
# Read database credentials from Vault's dynamic secrets engine
data "vault_generic_secret" "db_creds" {
  path = "database/creds/booking-${var.environment}"
}

resource "aws_db_instance" "primary" {
  username = data.vault_generic_secret.db_creds.data["username"]
  password = data.vault_generic_secret.db_creds.data["password"]
}
```

Vault's dynamic secrets engine generates *temporary* database credentials that automatically expire. Instead of a static password that lives forever (and can be leaked), each Terraform run gets fresh credentials with a configurable TTL. When the TTL expires, Vault revokes the credentials automatically. This is significantly more secure than static passwords, even encrypted ones.

> **Key Term:** **Dynamic secrets** -- Credentials generated on-demand with an automatic expiration time. Vault creates a new database user/password pair for each request, and revokes them after the TTL expires. Unlike static secrets (which live until someone remembers to rotate them), dynamic secrets limit the blast radius of a credential leak to the TTL window.

---

## GitOps for Infrastructure

So far, we have described how to run Terraform locally. But in a production workflow, no engineer should run `terraform apply` from their laptop. Infrastructure changes should follow the same path as application code: commit, pull request, CI/CD pipeline, automated apply.

This is **GitOps**: Git is the single source of truth, and automated systems reconcile the actual state with the desired state declared in Git.

### The GitOps Infrastructure Pipeline

```yaml
# .github/workflows/terraform.yml

name: Terraform Infrastructure Pipeline

on:
  pull_request:
    paths: ['terraform/**']
  push:
    branches: [main]
    paths: ['terraform/**']

permissions:
  id-token: write    # For OIDC authentication to AWS
  contents: read
  pull-requests: write  # For posting plan output as PR comment

jobs:
  plan:
    name: Terraform Plan
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    strategy:
      matrix:
        environment: [dev, staging, prod]

    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.7.0

      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::role/terraform-plan
          aws-region: us-east-1

      - name: Terraform Init
        working-directory: terraform/environments/${{ matrix.environment }}
        run: terraform init

      - name: Terraform Plan
        working-directory: terraform/environments/${{ matrix.environment }}
        run: terraform plan -out=tfplan -no-color
        continue-on-error: true

      - name: Post Plan to PR
        uses: actions/github-script@v7
        with:
          script: |
            const plan = `#### Environment: \`${{ matrix.environment }}\`
            \`\`\`
            ${process.env.PLAN_OUTPUT}
            \`\`\``;
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: plan,
            });

  apply:
    name: Terraform Apply
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    environment: production  # Requires manual approval in GitHub
    strategy:
      matrix:
        environment: [dev, staging, prod]
      max-parallel: 1  # Apply environments sequentially

    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3

      - name: Configure AWS Credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::role/terraform-apply
          aws-region: us-east-1

      - name: Terraform Init & Apply
        working-directory: terraform/environments/${{ matrix.environment }}
        run: |
          terraform init
          terraform apply -auto-approve
```

Key design decisions in this pipeline:

1. **OIDC authentication** instead of static AWS access keys. The GitHub Actions runner assumes an IAM role via OpenID Connect. No long-lived credentials to leak.

2. **Separate plan and apply roles.** The plan role has read-only access to AWS. The apply role has write access. This means a compromised PR cannot modify infrastructure -- only merged code on `main` can.

3. **Sequential environment deployment** (`max-parallel: 1`). Dev applies first. If it fails, staging and prod do not apply. This is your canary for infrastructure changes.

4. **Manual approval gate** for production (`environment: production` in GitHub). Even after code merges to main, a human must click "Approve" before Terraform applies to production.

### ArgoCD and Flux for Kubernetes Resources

While Terraform manages cloud infrastructure (VPCs, databases, clusters), Kubernetes resources (deployments, services, config maps) are often managed by **ArgoCD** or **Flux**. These tools continuously watch a Git repository for changes to Kubernetes manifests and automatically apply them to the cluster.

The division of responsibility:

```
Terraform manages:          ArgoCD/Flux manages:
├── VPCs                    ├── Deployments
├── EKS clusters            ├── Services
├── RDS databases           ├── ConfigMaps
├── ElastiCache clusters    ├── Secrets (sealed)
├── MSK clusters            ├── Ingress rules
├── IAM roles               ├── HPA/VPA configs
├── Security groups         ├── NetworkPolicies
└── DNS records             └── ServiceMonitors
```

This separation exists because Terraform and ArgoCD have different reconciliation models. Terraform applies on demand (when you run `terraform apply`). ArgoCD continuously reconciles -- it checks every 3 minutes whether the cluster state matches the Git state, and corrects any drift automatically. For application-level Kubernetes resources that change frequently (scaling, config updates, feature flags), continuous reconciliation is the right model. For infrastructure that changes rarely and has high blast radius (databases, networking), on-demand application with explicit approval is safer.

> **Key Term:** **GitOps** -- An operational model where Git repositories are the single source of truth for both application code and infrastructure configuration. Automated systems watch the repository and reconcile the actual state with the declared state. Changes are made exclusively through Git commits, providing a complete audit trail and enabling rollback through `git revert`.

---

## Cost Estimation: Infracost in CI

Infrastructure changes have cost implications. Doubling the Kafka broker count from 15 to 30 does not just affect performance -- it roughly doubles your MSK bill. Teams should see cost impact *before* merging infrastructure changes, not on next month's AWS invoice.

**Infracost** is an open-source tool that estimates the cost of Terraform changes and posts the estimate as a PR comment.

```yaml
# Addition to the Terraform pipeline
  cost-estimate:
    name: Infracost Cost Estimate
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'

    steps:
      - uses: actions/checkout@v4

      - name: Setup Infracost
        uses: infracost/actions/setup@v3
        with:
          api-key: ${{ secrets.INFRACOST_API_KEY }}

      - name: Generate cost diff
        run: |
          infracost diff \
            --path=terraform/environments/prod \
            --format=json \
            --out-file=/tmp/infracost.json

      - name: Post cost estimate to PR
        uses: infracost/actions/comment@v3
        with:
          path: /tmp/infracost.json
          behavior: update
```

A typical Infracost PR comment looks like this:

```
💰 Monthly cost will increase by $2,340 (12%)

Project                        Previous   New        Diff
────────────────────────────────────────────────────────────
booking-prod                   $19,500    $21,840    +$2,340

Changed resources:
  + aws_eks_node_group.general   $0 → $4,320  (scaling max from 20 to 30)
  ~ aws_msk_cluster.main         $8,100 → $10,440  (instance upgrade)

15 resources unchanged.
```

Engineers and reviewers see the dollar impact of every infrastructure PR. No more surprise bills. This is especially valuable for our scale: at over $19,000/month baseline in a single region, an accidental instance type upgrade across 16 shards could add tens of thousands of dollars per month.

> **Checkpoint:** Consider the full GitOps workflow we have described. An engineer changes a Terraform variable, opens a PR. The CI pipeline runs `terraform plan` and posts the diff as a comment. Infracost estimates the cost change. A peer reviews both the code diff and the plan output. After approval and merge, the pipeline runs `terraform apply` sequentially: dev first, then staging, then prod (with manual approval). At any point, `git revert` rolls back the change. This entire workflow -- from intent to infrastructure -- is auditable, reversible, and collaborative. Compare this to someone making changes through the AWS console at 2 AM during an incident.

---

## Disaster Recovery With IaC: Rebuilding From Code

The ultimate test of your IaC practice is this: if an entire AWS region becomes unavailable, can you rebuild your infrastructure in another region from your Git repository alone?

For the Global Booking System, the answer is yes. And it has been tested.

### The DR Playbook

```bash
# Disaster Recovery: Spin up infrastructure in a new region
# This assumes the S3 state bucket is in a different region than the one failing.

# 1. Create a new environment targeting the DR region
cp -r terraform/environments/prod terraform/environments/dr-us-west-2

# 2. Update the backend to use a new state key
# (edit dr-us-west-2/backend.tf to use key "dr-us-west-2/terraform.tfstate")

# 3. Update the region variable
# (edit dr-us-west-2/terraform.tfvars: aws_region = "us-west-2")

# 4. Initialize and apply
cd terraform/environments/dr-us-west-2
terraform init
terraform apply

# Time: ~35-45 minutes for full infrastructure creation
# After apply: VPC + EKS + 16 MySQL shards + 4 Redis clusters + MSK = running
```

Thirty-five to forty-five minutes from "region is down" to "infrastructure is running in a new region." The databases will be empty (data replication is a separate concern covered in the database chapters), but the infrastructure *shape* is identical. Compare this to the alternative: an engineer frantically clicking through the AWS console, trying to remember CIDR blocks, security group rules, database parameter groups, and Kafka configurations from memory.

### Multi-Region From Day One

Our Global Booking System actually runs in 4 regions simultaneously, not as DR but as primary infrastructure. Each region has its own directory:

```
terraform/environments/
├── prod-us-east-1/
├── prod-eu-west-1/
├── prod-ap-southeast-1/
└── prod-sa-east-1/
```

Each uses the exact same modules, with only region-specific overrides (like VPC CIDR blocks to avoid overlap if we peer the VPCs). This is IaC at its most powerful: the same recipe, four kitchens, identical meals.

> **What If You Skip This?** Without IaC-based DR, your recovery time objective (RTO) is measured in days, not minutes. Every manual step is a potential error. Every forgotten configuration is a production bug waiting to surface under the worst possible circumstances -- when you are already dealing with a regional outage and your team is under maximum stress.

---

## NestJS App Configuration From IaC-Provisioned Resources

Terraform creates the infrastructure. Your NestJS application needs to *connect* to it. The bridge between IaC and application code is **Terraform outputs** feeding into **Kubernetes ConfigMaps and Secrets**, which the NestJS application reads as environment variables.

### Step 1: Terraform Outputs

```hcl
# terraform/outputs.tf

output "mysql_shard_endpoints" {
  description = "Connection endpoints for all MySQL shards"
  value = {
    for i, shard in module.mysql_shards :
    "shard_${i}" => {
      primary_endpoint  = shard.primary_endpoint
      replica_endpoints = shard.replica_endpoints
      database_name     = shard.database_name
      port              = 3306
    }
  }
  sensitive = true
}

output "redis_endpoints" {
  description = "Redis cluster configuration endpoints"
  value = {
    sessions     = module.redis_sessions.configuration_endpoint
    fencing      = module.redis_fencing.configuration_endpoint
    cache        = module.redis_cache.configuration_endpoint
    rate_limiting = module.redis_rate_limiting.configuration_endpoint
  }
}

output "kafka_bootstrap_brokers" {
  description = "MSK bootstrap broker connection string"
  value       = module.kafka.bootstrap_brokers_tls
}
```

### Step 2: Kubernetes ConfigMap (Generated by CI/CD)

```yaml
# k8s/configmap.yaml (generated from Terraform outputs)
apiVersion: v1
kind: ConfigMap
metadata:
  name: booking-infrastructure
  namespace: booking-system
data:
  MYSQL_SHARD_COUNT: "16"
  MYSQL_SHARD_0_HOST: "booking-prod-shard-0-primary.abc123.us-east-1.rds.amazonaws.com"
  MYSQL_SHARD_0_PORT: "3306"
  MYSQL_SHARD_0_DATABASE: "booking_shard_0"
  # ... shard 1 through 15 ...
  REDIS_SESSIONS_ENDPOINT: "sessions-prod.abc123.clustercfg.use1.cache.amazonaws.com:6379"
  REDIS_FENCING_ENDPOINT: "fencing-prod.abc123.clustercfg.use1.cache.amazonaws.com:6379"
  REDIS_CACHE_ENDPOINT: "cache-prod.abc123.clustercfg.use1.cache.amazonaws.com:6379"
  REDIS_RATELIMIT_ENDPOINT: "ratelimit-prod.abc123.clustercfg.use1.cache.amazonaws.com:6379"
  KAFKA_BROKERS: "b-1.events-prod.abc123.kafka.us-east-1.amazonaws.com:9094,b-2.events-prod..."
```

### Step 3: NestJS Configuration Service

```typescript
// src/config/infrastructure.config.ts

import { registerAs } from '@nestjs/config';

interface ShardConfig {
  host: string;
  port: number;
  database: string;
}

export default registerAs('infrastructure', () => {
  const shardCount = parseInt(process.env.MYSQL_SHARD_COUNT || '16', 10);

  const mysqlShards: ShardConfig[] = [];
  for (let i = 0; i < shardCount; i++) {
    mysqlShards.push({
      host: process.env[`MYSQL_SHARD_${i}_HOST`]
        || `localhost`,
      port: parseInt(process.env[`MYSQL_SHARD_${i}_PORT`] || '3306', 10),
      database: process.env[`MYSQL_SHARD_${i}_DATABASE`]
        || `booking_shard_${i}`,
    });
  }

  return {
    mysql: {
      shardCount,
      shards: mysqlShards,
    },
    redis: {
      sessions: process.env.REDIS_SESSIONS_ENDPOINT || 'localhost:6379',
      fencing: process.env.REDIS_FENCING_ENDPOINT || 'localhost:6379',
      cache: process.env.REDIS_CACHE_ENDPOINT || 'localhost:6379',
      rateLimiting: process.env.REDIS_RATELIMIT_ENDPOINT || 'localhost:6379',
    },
    kafka: {
      brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    },
  };
});
```

```typescript
// src/database/shard-manager.service.ts

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class ShardManagerService implements OnModuleInit {
  private shards: Map<number, PrismaClient> = new Map();

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    const infraConfig = this.config.get('infrastructure');
    const shardCount = infraConfig.mysql.shardCount;

    for (let i = 0; i < shardCount; i++) {
      const shard = infraConfig.mysql.shards[i];
      const prismaClient = new PrismaClient({
        datasources: {
          db: {
            url: `mysql://${process.env.MYSQL_USERNAME}:${process.env.MYSQL_PASSWORD}@${shard.host}:${shard.port}/${shard.database}?connection_limit=50&connect_timeout=5`,
          },
        },
      });

      await prismaClient.$connect();
      this.shards.set(i, prismaClient);
    }
  }

  getShardForBooking(bookingId: string): PrismaClient {
    const shardIndex = this.hashToShard(bookingId);
    const shard = this.shards.get(shardIndex);
    if (!shard) {
      throw new Error(`Shard ${shardIndex} not initialized`);
    }
    return shard;
  }

  private hashToShard(bookingId: string): number {
    const shardCount = this.config.get('infrastructure.mysql.shardCount');
    let hash = 0;
    for (let i = 0; i < bookingId.length; i++) {
      hash = ((hash << 5) - hash + bookingId.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % shardCount;
  }
}
```

The critical insight here: the NestJS application does not know or care that its MySQL endpoints were created by Terraform. It reads environment variables. The infrastructure could have been created by Terraform, Pulumi, CloudFormation, or a human clicking buttons. The application is decoupled from the provisioning tool. Terraform outputs flow into Kubernetes ConfigMaps, which flow into environment variables, which the NestJS `ConfigService` reads. Each layer only knows about the layer immediately adjacent to it.

> **Checkpoint:** Trace the full path: Terraform creates an RDS instance and outputs its endpoint. The CI pipeline reads the Terraform output and writes it to a Kubernetes ConfigMap. The NestJS pod mounts the ConfigMap as environment variables. The `ConfigService` reads the environment variable. The `ShardManagerService` connects to the database. At no point does application code reference Terraform, and at no point does Terraform reference NestJS. The two are coupled only through environment variables -- the thinnest possible interface.

---

## Production War Story: The Day Someone Ran `terraform destroy` in Production

It was a Tuesday afternoon. A junior infrastructure engineer was cleaning up an abandoned staging environment. The command was simple:

```bash
terraform destroy -auto-approve
```

The problem: they were in the wrong directory.

They were not in `terraform/environments/staging`. They were in `terraform/environments/prod`. The `-auto-approve` flag skipped the confirmation prompt where Terraform would have shown them exactly what it was about to destroy -- including 16 production MySQL shards, 4 Redis clusters, an MSK cluster, and an EKS cluster serving live booking traffic.

Terraform dutifully began destroying resources. Within 90 seconds, the security groups were gone. Database connections started failing. The booking service returned 500 errors. Revenue stopped flowing.

### How We Recovered

1. **Immediate detection.** Our monitoring (PagerDuty) alerted within 30 seconds of the first failed health check. The on-call engineer opened the AWS console and saw resources disappearing in real time.

2. **Terraform state told us what was lost.** Because our state file was versioned in S3, we could see the exact "before" state -- every resource ID, every configuration parameter. We restored the state file from S3's version history.

3. **Re-apply from code.** We ran `terraform apply` from the production directory. Terraform saw that resources in the state file no longer existed in AWS and began recreating them.

4. **Database recovery from snapshots.** The RDS instances had automated daily snapshots and point-in-time recovery. We restored each shard from the most recent snapshot. Data loss: approximately 47 minutes of bookings (the time between the last snapshot and the destroy).

5. **Total downtime: 2 hours 14 minutes.** Without IaC, this recovery would have taken days.

### What We Changed

After the incident, we implemented multiple layers of protection:

```hcl
# 1. prevent_destroy on ALL stateful resources (already shown above)
lifecycle {
  prevent_destroy = true
}

# 2. S3 bucket policy that denies state deletion
# 3. IAM policy: terraform-apply role CANNOT terraform destroy
# 4. CI/CD pipeline: destroy command is not available at all
```

We also added an organizational rule: the `terraform destroy` command is never run by humans. Only an automated decommissioning pipeline, triggered by a ticket approved by two senior engineers, can destroy production resources. The human never types the command. The human approves the ticket. The pipeline types the command.

> **Lesson:** IaC does not just help you build infrastructure. It helps you recover from the worst day of your career. The fact that we restored a complete production environment in 2 hours instead of 2 days is the single strongest argument for Infrastructure as Code. The 47 minutes of lost booking data still cost the company significant revenue and required manual reconciliation with affected customers. But without IaC, we would have lost days of data and potentially the trust of major hotel partners.

---

## Common Mistakes With Infrastructure as Code

After years of running Terraform at scale, these are the mistakes I see most often -- especially from teams new to IaC.

### Mistake 1: Not Using Remote State From Day One

"We'll switch to remote state later." You will not. By the time you have 50 resources, migrating state is terrifying. Start with S3 + DynamoDB on your first `terraform init`.

### Mistake 2: Putting Secrets in Terraform Variables Files

```hcl
# terraform.tfvars -- DO NOT DO THIS
database_password = "Production-P@ssw0rd-2026!"
```

Even if this file is `.gitignored`, it exists on someone's laptop. Use AWS Secrets Manager or Vault from the beginning.

### Mistake 3: Monolithic State

All 430 resources in a single state file means every `terraform plan` takes 10 minutes (it queries AWS for the current state of all 430 resources). And if something goes wrong with one resource during `terraform apply`, it can block changes to all other resources. Split state by environment (separate directories) and, for very large deployments, by layer (networking, compute, data).

### Mistake 4: No `lifecycle` Blocks on Stateful Resources

Forgetting `prevent_destroy` on databases and `create_before_destroy` on security groups. These are not optional for production. They are mandatory guardrails.

### Mistake 5: Clicking in the Console "Just This Once"

Every manual console change is drift that will bite you later. If you must make an emergency change through the console, immediately open a PR to reconcile the Terraform code. Run `terraform plan` to confirm the drift. Update the code to match reality or revert reality to match the code. Do this *before* you go home for the day. "I'll fix it tomorrow" never happens.

### Mistake 6: Not Running `terraform plan` Before `terraform apply`

Always run `plan` first. Read the output. Every line. If it says "1 to destroy" and you did not expect that, stop. Investigate. A `plan` output that says "16 to destroy, 16 to create" for your database shards usually means you changed the resource identifier, and Terraform thinks these are new resources, not modifications. That path leads to data loss.

### Mistake 7: Ignoring Provider Version Constraints

```hcl
# Bad: no version constraint
provider "aws" {}

# Good: pinned major.minor, flexible patch
required_providers {
  aws = {
    source  = "hashicorp/aws"
    version = "~> 5.40"  # Allows 5.40.x, 5.41.x, etc. but not 6.0
  }
}
```

Without version pinning, `terraform init` downloads the latest provider, which may have breaking changes. Pin your versions and upgrade deliberately with tested PRs, not accidentally.

### Mistake 8: Treating Terraform Like a Programming Language

HCL is intentionally limited. If you find yourself writing complex conditional logic, deeply nested for loops, or trying to implement algorithms in HCL, step back. Either simplify your infrastructure design, move the complexity into a Pulumi TypeScript program, or use `templatefile()` for complex string generation. Clever Terraform is unmaintainable Terraform.

---

## Chapter Summary

| Concept | What It Is | Why It Matters for Global Booking System |
|---------|-----------|------------------------------------------|
| **Infrastructure as Code** | Defining all infrastructure in version-controlled configuration files | 430 resources per region x 4 regions = 1,700+ resources. Manual management is impossible at this scale |
| **Terraform** | Declarative IaC tool using HCL, manages state, supports all major clouds | Industry standard; largest community and provider ecosystem; well-understood by hiring candidates |
| **Providers** | Plugins connecting Terraform to cloud APIs (AWS, Kubernetes, Helm) | Enable multi-service infrastructure: VPC + EKS + RDS + ElastiCache + MSK in one codebase |
| **Modules** | Reusable, parameterized groups of resources | Write the MySQL shard config once, deploy it 16 times. Change engine version in one place |
| **State** | JSON mapping of declared resources to actual cloud resource IDs | Without state, Terraform cannot track what exists. Remote state (S3 + DynamoDB) enables team collaboration |
| **Remote backend** | Shared state storage with locking (S3 + DynamoDB) | Prevents concurrent modifications; enables state recovery from versioned S3 backups |
| **Environment separation** | Directory-based isolation of dev/staging/prod | Eliminates risk of applying wrong environment's config; separate state files per environment |
| **Pulumi** | TypeScript-native IaC alternative to Terraform | Full programming language; same language as NestJS codebase; better IDE support; smaller community |
| **Secret management** | AWS Secrets Manager / Vault for sensitive values | Database passwords never appear in code or version control; dynamic secrets limit breach exposure |
| **GitOps** | Git as single source of truth with automated reconciliation | Infrastructure changes follow PR workflow; automated plan/apply; manual approval gates for prod |
| **ArgoCD / Flux** | Continuous GitOps reconciliation for Kubernetes resources | Manages application-level K8s resources; auto-corrects drift every 3 minutes |
| **Infracost** | Cost estimation tool integrated into CI | Engineers see dollar impact of changes before merging; prevents surprise AWS bills |
| **Disaster recovery** | Rebuilding infrastructure from code in a new region | Full infrastructure rebuild in 35-45 minutes from `terraform apply`; tested, not theoretical |
| **`prevent_destroy`** | Lifecycle rule blocking resource deletion | Blocks accidental `terraform destroy` on databases and other stateful resources |
| **Drift detection** | Comparing actual state against declared state | Catches manual console changes; maintains infrastructure consistency across regions |

> **Final Checkpoint:** You now understand how to define an entire cloud infrastructure -- networking, compute, databases, caching, messaging -- in version-controlled configuration files. You understand how Terraform's state mechanism tracks real resources, how remote backends enable team collaboration, and how GitOps pipelines automate the plan-review-apply workflow. You have seen how NestJS applications consume IaC-provisioned resources through environment variables, creating a clean separation between infrastructure and application concerns. Most importantly, you understand *why* this matters: reproducibility across regions, disaster recovery measured in minutes not days, and the ability to review every infrastructure change with the same rigor as a code change. In the next chapter, we will build on this foundation by exploring how to observe and monitor the infrastructure we have just defined.
