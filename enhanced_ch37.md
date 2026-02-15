# Chapter 37: CI/CD Pipeline — From Code to Production

## Why CI/CD Matters: The True Cost of Manual Deployments

Let me paint a picture you have probably lived through. It is Friday at 4:47 PM. A critical hotfix needs to go out. The one developer who knows the deploy process is on vacation. You SSH into the production server, run `git pull`, hold your breath, and type `pm2 restart all`. The site goes down for three minutes. Customers see 500 errors. The CEO sends an all-hands email. You spend the weekend debugging.

This is what deployment looks like without CI/CD. Here is the manual deploy checklist that many teams still use:

1. Finish a feature on your laptop.
2. Push to GitHub.
3. SSH into the server.
4. Run `git pull`.
5. Run `npm install` (and pray nothing changed).
6. Run `npm run build`.
7. Restart the server with `pm2 restart all`.
8. Refresh the browser and hope it works.

This process has at least seven things fatally wrong with it:

- **No tests run before deploy.** You are shipping untested code to real users. Bugs reach production minutes after being written.
- **No consistency.** The server might have a different Node version, different npm packages, stale environment variables, or leftover files from a previous deploy.
- **No rollback.** If step 7 breaks the app, you manually figure out which commit was last working, revert, and redeploy -- while the site is down.
- **One person is a bottleneck.** Only the person with SSH access can deploy. If they are sick, on vacation, or asleep, nobody deploys.
- **It does not scale.** Try doing this across 4 regions, 12 microservices, and 132 Kubernetes nodes. It is physically impossible.
- **No audit trail.** Who deployed what, when? Nobody knows. There is no log, no record, no accountability.
- **No security checks.** Dependencies with known vulnerabilities, leaked secrets in code, SQL injection patterns -- none of these are caught before reaching production.

Let me quantify the cost. A study by DORA (DevOps Research and Assessment) found that elite-performing teams deploy **973 times more frequently** than low performers, with **6,570 times faster lead time** from commit to production. Manual deployment is not just inconvenient -- it is a competitive disadvantage that compounds daily.

> **Analogy:** Manual deployment is like hand-delivering every letter in a city. One postman, one bicycle, one letter at a time. CI/CD is the postal system: automated sorting, trucks running scheduled routes, tracking numbers on every package, and guaranteed delivery times. You would never hand-deliver mail at scale. You should never hand-deliver code at scale either.

> **Key Term:** **CI (Continuous Integration)** — The practice of automatically building and testing code every time a developer pushes changes. The goal: catch bugs within minutes of introduction, not days later. Every push triggers a pipeline that compiles, lints, and tests the code in a clean, reproducible environment.
>
> **CD (Continuous Delivery)** — The practice of automatically preparing code for release to production after it passes all automated checks. Every commit that passes the pipeline is a release candidate.
>
> **CD (Continuous Deployment)** — An extension of Continuous Delivery where code is automatically deployed to production without human intervention. The distinction matters: Delivery means *ready* to ship; Deployment means *actually* shipped.

> **What If You Skip This?** At 100K bookings per minute, a single bad deploy without automated rollback can cost $47,000 per minute in lost revenue (based on average booking value of $0.47 per transaction). A 15-minute outage costs $705,000. The entire CI/CD infrastructure for a year costs less than one bad deploy. The math is not even close.

---

## Git Workflow: Trunk-Based Development vs. GitFlow

Before you build a pipeline, you need to decide how code flows through your team. The two dominant strategies are **GitFlow** and **trunk-based development**. For a microservices architecture handling 100K bookings per minute, this choice has real consequences.

### GitFlow: The Traditional Approach

GitFlow uses long-lived branches with a formal release process:

```
main ─────────────────────────────────────────────────── (production)
  │
  └── develop ──────────────────────────────────────── (integration)
        │          │           │
        └── feature/search     └── feature/payments
                               │
                          release/2.4 ── hotfix/booking-crash
```

**How it works:**
- `main` always reflects production.
- `develop` is the integration branch where features merge.
- Feature branches are created from `develop` and merged back via pull request.
- Release branches are cut from `develop` when preparing a release.
- Hotfix branches are created from `main` for emergency fixes.

**The problem at scale:** With 12 microservices and 8 teams, GitFlow creates merge hell. Feature branches live for days or weeks, diverging from `develop`. Merge conflicts multiply. Release branches require dedicated release managers. The feedback loop from "code written" to "code in production" stretches to weeks.

### Trunk-Based Development: The Microservices Standard

Trunk-based development uses a single `main` branch with short-lived feature branches:

```
main ──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●── (always deployable)
       │     │        │           │     │
       └─fb──┘        └──fb──────┘     └─fb──┘
     (hours, not weeks)
```

**How it works:**
- `main` is always in a deployable state.
- Feature branches live for **hours**, not days or weeks. The maximum is one to two days.
- Developers push small, incremental changes. Each commit is independently deployable.
- Feature flags hide incomplete work from users (more on this later).
- Every merge to `main` triggers the full CI/CD pipeline.

**Why we chose trunk-based for the Global Booking System:**

| Factor | GitFlow | Trunk-Based |
|--------|---------|-------------|
| Branch lifetime | Days to weeks | Hours to 1-2 days |
| Merge conflicts | Frequent and painful | Rare and small |
| Deploy frequency | Weekly or biweekly | Multiple times per day |
| Feedback loop | Slow (days) | Fast (minutes) |
| Release management | Dedicated release manager | Automated pipeline |
| Works with microservices | Poorly (too much coordination) | Excellently (independent services) |
| Risk per deploy | High (big batch of changes) | Low (small, incremental changes) |

> **Key Term:** **Trunk-based development** — A branching strategy where all developers commit to a single main branch (the "trunk") through short-lived feature branches. The trunk is always kept in a deployable state. This strategy enables continuous deployment because every commit is small, tested, and independently releasable.

> **Common Mistake:** Teams adopt GitFlow because it *feels* more controlled. "We have a formal release process! We have release managers!" But the formality creates bottlenecks. With microservices, each service should deploy independently, multiple times per day. GitFlow's ceremony fights against this. If you catch yourself spending more than 30 minutes on merge conflicts, your branching strategy is working against you.

---

## GitHub Actions: Full Workflow for a NestJS Microservice

Here is the complete GitHub Actions workflow for our Booking Service. I will explain every line, because in production, every line matters.

```yaml
# .github/workflows/ci-cd.yml
name: Booking Service CI/CD Pipeline

on:
  push:
    branches: [main]
    paths:
      - 'services/booking-service/**'
      - '.github/workflows/ci-cd.yml'
  pull_request:
    branches: [main]
    paths:
      - 'services/booking-service/**'

# Cancel in-progress runs for the same branch
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '20.11.0'
  REGISTRY: 012345678901.dkr.ecr.us-east-1.amazonaws.com
  IMAGE_NAME: booking-service
  HELM_CHART_PATH: helm/booking-service

permissions:
  contents: read
  id-token: write   # For OIDC authentication to AWS
  pull-requests: write  # For posting test coverage comments

jobs:
  # ─────────────────────────────────────────────────────────
  # JOB 1: LINT AND FORMAT CHECK
  # ─────────────────────────────────────────────────────────
  lint:
    name: Lint & Format
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/booking-service
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: services/booking-service/package-lock.json

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run ESLint
        run: npx eslint 'src/**/*.ts' --max-warnings 0 --format json --output-file eslint-report.json || true

      - name: Check ESLint results
        run: |
          if [ -s eslint-report.json ]; then
            ERRORS=$(cat eslint-report.json | jq '[.[] | .errorCount] | add')
            WARNINGS=$(cat eslint-report.json | jq '[.[] | .warningCount] | add')
            echo "ESLint found $ERRORS errors and $WARNINGS warnings"
            if [ "$ERRORS" -gt 0 ] || [ "$WARNINGS" -gt 0 ]; then
              npx eslint 'src/**/*.ts' --max-warnings 0
              exit 1
            fi
          fi

      - name: Check Prettier formatting
        run: npx prettier --check 'src/**/*.ts' 'test/**/*.ts'

      - name: Check for TypeScript errors
        run: npx tsc --noEmit --pretty

  # ─────────────────────────────────────────────────────────
  # JOB 2: UNIT TESTS
  # ─────────────────────────────────────────────────────────
  unit-tests:
    name: Unit Tests
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/booking-service
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: services/booking-service/package-lock.json

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run unit tests with coverage
        run: npm run test:unit -- --coverage --coverageReporters=text --coverageReporters=lcov
        env:
          NODE_ENV: test

      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: unit-coverage
          path: services/booking-service/coverage/lcov.info

      - name: Post coverage comment on PR
        if: github.event_name == 'pull_request'
        uses: romeovs/lcov-reporter-action@v0.4.0
        with:
          lcov-file: services/booking-service/coverage/lcov.info
          github-token: ${{ secrets.GITHUB_TOKEN }}
          filter-changed-files: true

  # ─────────────────────────────────────────────────────────
  # JOB 3: INTEGRATION TESTS
  # ─────────────────────────────────────────────────────────
  integration-tests:
    name: Integration Tests
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/booking-service

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_password
          POSTGRES_DB: booking_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd="pg_isready -U test_user"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd="redis-cli ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5

      kafka:
        image: confluentinc/cp-kafka:7.5.0
        ports:
          - 9092:9092
        env:
          KAFKA_BROKER_ID: 1
          KAFKA_ZOOKEEPER_CONNECT: localhost:9092 # Using KRaft mode (no ZooKeeper needed)
          KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
```

Let me pause here and explain what we have built so far in this YAML.

**The `on` block** defines when this pipeline runs. Notice the `paths` filter -- this pipeline only triggers when files inside `services/booking-service/` change. In a monorepo with 12 microservices, this prevents the Booking Service pipeline from running when someone updates the Payment Service. Without path filtering, every push would trigger all 12 pipelines, wasting compute and slowing feedback.

**The `concurrency` block** is critical and often overlooked. If a developer pushes three commits in rapid succession, we do not want three pipelines running simultaneously. `cancel-in-progress: true` cancels the older runs, keeping only the latest. This saves CI minutes and prevents race conditions during deployment.

**The `services` block** in the integration test job spins up real PostgreSQL, Redis, and Kafka containers alongside the test runner. These are not mocks. The integration tests execute real SQL queries against a real Postgres database, publish real events to a real Kafka broker, and cache real data in a real Redis instance. This is how you catch bugs that mocks would hide.

> **Analogy:** Unit tests are like checking that each brick is correctly shaped. Integration tests are like assembling a wall from those bricks and confirming it stands up. You need both. A perfectly shaped brick is useless if it does not bond with the mortar. A function that passes unit tests is useless if it sends the wrong event to Kafka.

---

## Build Stage: TypeScript Compilation, Linting, and Formatting

The build stage is your first quality gate. It answers three questions: Does the code compile? Does it follow team standards? Is it formatted consistently?

### TypeScript Compilation

```json
// tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "removeComments": false,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  },
  "exclude": ["node_modules", "dist", "test", "**/*.spec.ts"]
}
```

Every flag here earns its place:

- **`strict: true`** — Enables all strict type-checking options. This catches `null` pointer errors, implicit `any` types, and type coercion bugs at compile time rather than in production at 3 AM.
- **`noUnusedLocals` and `noUnusedParameters`** — Dead code is a maintenance burden and a source of confusion. If a variable is declared but never used, it is either a bug or clutter. Either way, it should not ship.
- **`noImplicitReturns`** — Every code path in a function must explicitly return a value. This prevents subtle bugs where a function returns `undefined` on one code path because the developer forgot a `return` statement.
- **`declaration: true`** — Generates `.d.ts` type declaration files. Other services that depend on shared libraries from this service can use these for type checking.

### ESLint Configuration

```javascript
// .eslintrc.js
module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin', 'import', 'security'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:security/recommended-legacy',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',  // Must be last -- disables ESLint rules that conflict with Prettier
  ],
  root: true,
  env: { node: true, jest: true },
  rules: {
    // Catch real bugs
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'warn',

    // Import ordering for readability
    'import/order': ['error', {
      groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
      'newlines-between': 'always',
      alphabetize: { order: 'asc' },
    }],

    // Security rules
    'security/detect-object-injection': 'warn',
    'security/detect-non-literal-regexp': 'warn',
    'security/detect-possible-timing-attacks': 'error',

    // No console.log in production code (use structured logger)
    'no-console': ['error', { allow: ['warn', 'error'] }],
  },
  overrides: [
    {
      files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
      rules: {
        // Relax rules for test files
        '@typescript-eslint/no-unsafe-assignment': 'off',
        'security/detect-object-injection': 'off',
      },
    },
  ],
};
```

Three rules deserve special attention:

- **`@typescript-eslint/no-floating-promises: 'error'`** — This is the single most important linting rule for a Node.js backend. A floating promise is an async function call without `await` or `.catch()`. If that promise rejects, the error disappears silently. In a booking system, this could mean a payment is charged but the booking is never created. This rule catches that at lint time.

- **`security/detect-possible-timing-attacks: 'error'`** — String comparisons using `===` on secrets (API keys, tokens) are vulnerable to timing attacks. This rule flags direct comparisons and suggests using `crypto.timingSafeEqual()` instead.

- **`'no-console': 'error'`** — At 100K bookings per minute, `console.log` is dangerously slow (it is synchronous I/O) and produces unstructured output that cannot be searched in log aggregation tools. All production logging must go through a structured logger like Pino or Winston.

### Prettier Configuration

```json
// .prettierrc
{
  "semi": true,
  "trailingComma": "all",
  "singleQuote": true,
  "printWidth": 100,
  "tabWidth": 2,
  "endOfLine": "lf",
  "arrowParens": "always",
  "bracketSpacing": true
}
```

Prettier is not about personal preference. It is about eliminating an entire category of code review comments. "Can you change this to single quotes?" "Add a trailing comma here." These comments waste everyone's time. Prettier enforces one style, automatically, and the pipeline rejects code that does not match.

> **What If You Skip This?** A team of 30 developers without automated formatting produces code that looks like it was written by 30 different people -- because it was. Code reviews devolve into style debates. New developers spend hours learning unwritten formatting rules. Prettier eliminates all of this for zero ongoing cost.

> **Checkpoint:** Look at the ESLint configuration above. Can you explain why `no-floating-promises` is set to `'error'` instead of `'warn'`? Can you describe a real scenario where a floating promise causes data loss in a booking system? If you can, you understand why linting is not about aesthetics -- it is about correctness.

---

## GitHub Actions: Completing the Pipeline

Now let me show you the remaining jobs in our workflow. Remember, jobs 1 (Lint) and 2 (Unit Tests) can run in parallel because they have no dependencies on each other. The integration test job, the security scan, and the Docker build are where things get interesting.

### Integration Test Steps (Continued)

Here is the rest of the integration test job, picking up where we left off:

```yaml
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: services/booking-service/package-lock.json

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Wait for services to be ready
        run: |
          echo "Waiting for PostgreSQL..."
          until pg_isready -h localhost -p 5432 -U test_user; do
            sleep 2
          done
          echo "Waiting for Redis..."
          until redis-cli -h localhost ping | grep -q PONG; do
            sleep 2
          done
          echo "Waiting for Kafka..."
          until kafka-topics --bootstrap-server localhost:9092 --list 2>/dev/null; do
            sleep 2
          done
          echo "All services ready."

      - name: Run database migrations
        run: npx prisma migrate deploy
        env:
          DATABASE_URL: mysql://test_user:test_password@localhost:3306/booking_test

      - name: Seed test data
        run: npx prisma db seed
        env:
          DATABASE_URL: mysql://test_user:test_password@localhost:3306/booking_test

      - name: Run integration tests
        run: npm run test:integration -- --coverage --forceExit --detectOpenHandles
        env:
          DATABASE_URL: mysql://test_user:test_password@localhost:3306/booking_test
          REDIS_URL: redis://localhost:6379
          KAFKA_BROKERS: localhost:9092
          NODE_ENV: test
        timeout-minutes: 10

      - name: Upload integration test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: integration-test-results
          path: |
            services/booking-service/coverage/
            services/booking-service/test-results/
```

Let me walk through the pieces that matter most.

**The "Wait for services" step** is something every CI/CD beginner gets wrong. Just because GitHub Actions started the PostgreSQL container does not mean the database is accepting connections. The container needs a few seconds to initialize, create the database, and start listening on the port. The `until` loop polls until the service responds. Without this, your tests will fail with `ECONNREFUSED` on every other run -- a flaky pipeline that nobody trusts.

**`npx prisma migrate deploy`** applies all pending database migrations to the test database. This is not `prisma migrate dev` (which generates new migrations interactively). `migrate deploy` is the CI/CD-safe command: it applies existing migration files without prompting, and it fails if any migration has issues. We will cover this in depth in the database migration section below.

**`--forceExit --detectOpenHandles`** are Jest flags that prevent the test process from hanging. In integration tests, you open database connections, Kafka producers, and Redis clients. If any of these are not properly closed in `afterAll()` hooks, Jest will wait forever. `--detectOpenHandles` identifies the culprit; `--forceExit` kills the process after tests complete. In CI/CD, a hanging process means a stuck pipeline and wasted compute minutes.

**`timeout-minutes: 10`** is a hard ceiling on the job. If integration tests take longer than 10 minutes, something is wrong -- either a test is stuck or the infrastructure is not responding. Without a timeout, a stuck job can run for 6 hours (GitHub Actions default) and consume your entire monthly CI minutes budget.

> **Common Mistake:** Developers often skip the "wait for services" step and instead add a blanket `sleep 30` before running tests. This is fragile and wastes time. If the service starts in 3 seconds, you waited 27 seconds for nothing. If it needs 35 seconds (cold start, slow CI runners), you get flaky failures. Always poll for readiness, never rely on fixed sleeps.

### Job 4: Security Scanning

```yaml
  # ─────────────────────────────────────────────────────────
  # JOB 4: SECURITY SCAN
  # ─────────────────────────────────────────────────────────
  security-scan:
    name: Security Scan
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/booking-service
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'
          cache-dependency-path: services/booking-service/package-lock.json

      - name: Install dependencies
        run: npm ci --prefer-offline

      - name: Run npm audit (critical and high only)
        run: npm audit --audit-level=high --omit=dev
        continue-on-error: false

      - name: Run Snyk security scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: >-
            --severity-threshold=high
            --file=services/booking-service/package.json
            --policy-path=services/booking-service/.snyk

      - name: Scan for secrets in code
        uses: trufflesecurity/trufflehog@main
        with:
          extra_args: --only-verified --results=verified

      - name: Run SAST (static analysis)
        uses: returntocorp/semgrep-action@v1
        with:
          config: >-
            p/nodejs
            p/typescript
            p/owasp-top-ten
            p/security-audit
          publishToken: ${{ secrets.SEMGREP_TOKEN }}

      - name: Check for outdated dependencies
        run: |
          npx npm-check-updates --target minor --errorLevel 2 || echo "::warning::Some dependencies have available updates"
```

This job runs four distinct security checks. Let me explain why you need all four -- they catch different categories of problems.

**`npm audit`** checks your `node_modules` against the GitHub Advisory Database. It finds known vulnerabilities in your dependencies. The `--audit-level=high` flag means only critical and high-severity vulnerabilities fail the build. Low and moderate severity issues generate warnings but do not block deploys. The `--omit=dev` flag excludes dev dependencies (test frameworks, linters) because those never run in production.

**Snyk** provides deeper security analysis than `npm audit`. It understands dependency trees, so it can flag a transitive dependency (a dependency of a dependency) that introduces a vulnerability even if your direct dependency is fine. Snyk also suggests fix versions and can create automated pull requests.

**TruffleHog** scans your code for leaked secrets -- API keys, database passwords, AWS access keys accidentally committed to the repository. The `--only-verified` flag means it actually tests whether detected secrets are valid (by attempting to authenticate with the respective service). A leaked, valid AWS key in your repo is a critical incident.

**Semgrep** performs static application security testing (SAST). It analyzes your code patterns -- not just dependencies -- for vulnerabilities. It can detect SQL injection patterns, cross-site scripting risks, insecure use of cryptographic functions, and OWASP Top Ten violations. This is like having a security-focused code reviewer on every PR.

> **Production War Story:** In 2023, a well-known SaaS company discovered that a developer had committed an AWS access key in a test file three months earlier. Automated scanners on the public repository detected it within minutes and began spinning up cryptocurrency mining instances. The bill exceeded $50,000 before the key was rotated. TruffleHog would have caught this in the CI pipeline, before the commit ever reached the main branch.

> **Key Term:** **SAST (Static Application Security Testing)** -- Automated analysis of source code to find security vulnerabilities without executing the program. Unlike dynamic testing (DAST), which tests running applications, SAST examines the code itself for patterns known to cause security issues.

### Job 5: Docker Build and Push

```yaml
  # ─────────────────────────────────────────────────────────
  # JOB 5: DOCKER BUILD & PUSH
  # ─────────────────────────────────────────────────────────
  docker-build:
    name: Build & Push Docker Image
    runs-on: ubuntu-latest
    needs: [lint, unit-tests, integration-tests, security-scan]
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    outputs:
      image-tag: ${{ steps.meta.outputs.tags }}
      image-digest: ${{ steps.build.outputs.digest }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::012345678901:role/github-actions-ecr
          aws-region: us-east-1

      - name: Login to Amazon ECR
        id: ecr-login
        uses: aws-actions/amazon-ecr-login@v2

      - name: Extract Docker metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=,format=long
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push Docker image
        id: build
        uses: docker/build-push-action@v5
        with:
          context: services/booking-service
          file: services/booking-service/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            NODE_VERSION=${{ env.NODE_VERSION }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
            GIT_SHA=${{ github.sha }}
            GIT_REF=${{ github.ref_name }}
          platforms: linux/amd64

      - name: Run Trivy vulnerability scan on image
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'

      - name: Upload Trivy scan results
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Sign Docker image with Cosign
        uses: sigstore/cosign-installer@v3
      - run: |
          cosign sign --yes \
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ steps.build.outputs.digest }}
```

This is the densest job in the pipeline, and every piece is load-bearing. Let me decode it.

**`needs: [lint, unit-tests, integration-tests, security-scan]`** -- This job only runs after all four prior jobs succeed. If any test fails, any lint error exists, or any security vulnerability is found, we never build a Docker image. Think of it as the quality gate: only code that passes every check gets packaged.

**OIDC authentication** -- Notice we do not use long-lived AWS access keys stored as GitHub Secrets. Instead, we use OIDC (OpenID Connect) to assume an AWS IAM role. GitHub Actions generates a short-lived token, presents it to AWS, and receives temporary credentials that expire after 1 hour. This eliminates the risk of leaked AWS keys in your CI system.

**Docker metadata** -- The `metadata-action` generates multiple tags for the image: the full git SHA (`a1b2c3d4e5...`), the branch name (`main`), the semantic version if one exists, and `latest`. Multiple tags let you reference the same image in different ways -- by exact commit for traceability, by branch for convenience.

**Buildx with GitHub Actions cache** -- `cache-from: type=gha` and `cache-to: type=gha,mode=max` use GitHub's built-in cache to store Docker build layers. The first build might take 90 seconds. Subsequent builds, if only the application code changed (not the dependencies), take 15 seconds because the `npm ci` layer is cached. We will examine this in detail in the Docker multi-stage build section.

**Trivy vulnerability scan** -- After building the image, we scan it for vulnerabilities in the base OS packages and application dependencies. Trivy examines every layer of the Docker image. If it finds a critical or high vulnerability, the pipeline fails. This catches vulnerabilities introduced by the base image (`node:20-slim`) that `npm audit` would miss because they exist in the OS layer, not in npm packages.

**Cosign image signing** -- The final step cryptographically signs the Docker image using Sigstore's keyless signing. This proves the image was built by this specific GitHub Actions workflow, from this specific commit, in this specific repository. When Kubernetes pulls the image, admission controllers can verify the signature and reject unsigned images. This prevents supply chain attacks where an attacker pushes a malicious image to your registry.

> **Analogy:** Think of Docker image signing like a tamper-evident seal on a medicine bottle. Anyone can put pills in a bottle. The seal proves *this specific pharmacy* filled this bottle. Without it, you cannot distinguish a legitimate image from one injected by an attacker who compromised your registry credentials.

---

## Docker Multi-Stage Builds: Small, Secure, Fast

Your Dockerfile is not just a recipe for building a container. It is a security boundary, a performance optimization, and a dependency manifest rolled into one. A badly written Dockerfile produces images that are 1.5 GB, contain your source code and dev tools, and take 3 minutes to build on every push. A well-written one produces images that are 150 MB, contain only the compiled application, and rebuild in 15 seconds thanks to layer caching.

Here is our production Dockerfile:

```dockerfile
# ──────────────────────────────────────────────────────────
# Stage 1: Install dependencies (cached aggressively)
# ──────────────────────────────────────────────────────────
FROM node:20.11.0-slim AS deps

WORKDIR /app

# Copy ONLY package files first (layer caching trick)
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev --prefer-offline \
    && npx prisma generate \
    && npm cache clean --force

# ──────────────────────────────────────────────────────────
# Stage 2: Build the application
# ──────────────────────────────────────────────────────────
FROM node:20.11.0-slim AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY prisma/ ./prisma/

# Install ALL dependencies (including dev) for building
RUN npm ci --prefer-offline

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build \
    && npx prisma generate

# ──────────────────────────────────────────────────────────
# Stage 3: Production image (minimal)
# ──────────────────────────────────────────────────────────
FROM node:20.11.0-slim AS production

# Build arguments for labels
ARG BUILD_DATE
ARG GIT_SHA
ARG GIT_REF

# OCI image labels
LABEL org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.ref.name="${GIT_REF}" \
      org.opencontainers.image.title="booking-service" \
      org.opencontainers.image.vendor="GlobalBooking"

# Security: run as non-root user
RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /bin/false --create-home appuser

# Install security updates and tini (PID 1 process manager)
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production dependencies from deps stage
COPY --from=deps --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=appuser:nodejs /app/package.json ./

# Copy compiled code from builder stage
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/prisma ./prisma

# Copy migration files for init containers
COPY --from=builder --chown=appuser:nodejs /app/node_modules/.prisma ./node_modules/.prisma

# Switch to non-root user
USER appuser

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Use tini as PID 1
ENTRYPOINT ["tini", "--"]

# Start the application
CMD ["node", "dist/main.js"]

EXPOSE 3000
```

This Dockerfile uses three stages. Let me explain *why* three stages, not one, and *why* the order matters so much.

### Stage 1: Dependencies (`deps`)

This stage copies only `package.json` and `package-lock.json`, then runs `npm ci`. Here is the key insight: **Docker caches each layer.** If `package.json` has not changed since the last build, Docker reuses the cached `node_modules` layer entirely. Since `npm ci` is the slowest step (30-60 seconds), skipping it on most builds saves enormous time.

The `--omit=dev` flag excludes development dependencies (Jest, ESLint, TypeScript, Prettier). These are needed for compiling and testing but not for running the production application. Excluding them cuts the `node_modules` size by 40-60%.

### Stage 2: Builder

This stage installs all dependencies (including dev) because we need TypeScript to compile the source code. It copies `src/` and runs `npm run build`, which transpiles TypeScript to JavaScript in the `dist/` directory.

Notice: the source code (`src/`) is copied *after* `npm ci`. This means changing a `.ts` file does not invalidate the dependency cache. Only changing `package.json` or `package-lock.json` triggers a fresh `npm ci`. This is the most important Docker layer caching optimization for Node.js projects.

### Stage 3: Production

The final stage starts fresh from `node:20.11.0-slim` and copies only what is needed to run:

1. `node_modules` from the `deps` stage (production dependencies only)
2. `dist/` from the `builder` stage (compiled JavaScript only)
3. `prisma/` directory (schema and migration files)

The source code, TypeScript compiler, test files, ESLint config -- none of these exist in the final image. An attacker who gains access to the running container cannot read your source code.

**Security hardening in the production stage:**

- **Non-root user**: The `appuser` with UID 1001 has no shell access (`/bin/false`). If an attacker exploits a vulnerability in your application, they get the permissions of `appuser`, not `root`. They cannot install packages, modify system files, or escalate privileges.
- **Tini as PID 1**: Node.js was not designed to run as PID 1 (the init process) in a container. Without tini, zombie processes accumulate, and `SIGTERM` signals are not properly forwarded to your Node process. Tini handles this correctly, ensuring graceful shutdown works.
- **Minimal OS packages**: `apt-get install` installs only `tini` and `curl` (for health checks). No compilers, no debuggers, no shells beyond the minimum. Fewer packages means fewer potential vulnerabilities.

> **Common Mistake:** Many developers use `node:20` (the full image) instead of `node:20-slim` for their production stage. The full image contains build tools, Python, and hundreds of system packages you do not need. It is 900+ MB vs ~200 MB for slim. Every extra package is a potential vulnerability. Always use `slim` or `alpine` for production images.

### Layer Cache Efficiency

Here is how layer caching works in practice:

```
Scenario 1: Only TypeScript code changed
  - Stage 1 (deps):    100% cache hit  --> 0 seconds
  - Stage 2 (builder): Cache hit until COPY src/ --> npm run build (5 seconds)
  - Stage 3 (prod):    COPY from cached stages --> 2 seconds
  - Total: ~7 seconds

Scenario 2: A new npm package was added
  - Stage 1 (deps):    Cache miss at COPY package.json --> npm ci (45 seconds)
  - Stage 2 (builder): Cache miss at npm ci --> build (50 seconds)
  - Stage 3 (prod):    COPY from new stages --> 3 seconds
  - Total: ~98 seconds

Scenario 3: Base image updated (node:20.11.0 --> 20.12.0)
  - Everything rebuilds from scratch
  - Total: ~120 seconds
```

The difference between 7 seconds and 120 seconds on every push is why layer ordering matters. Put the things that change least often (base image, dependencies) at the top. Put the things that change most often (your code) at the bottom.

> **Key Term:** **Docker layer caching** -- Docker images are built in layers, one per instruction. If an instruction and all instructions above it have not changed, Docker reuses the cached result instead of re-executing. This makes subsequent builds dramatically faster, but only if you order your Dockerfile to put stable instructions before volatile ones.

---

## Database Migration Pipeline

Database migrations are the most dangerous part of any deployment. A bad code deploy can be rolled back in seconds by switching to the previous Docker image. A bad migration can corrupt your database, orphan foreign keys, or lock tables for minutes while millions of rows are being updated.

### Prisma Migrate in CI/CD

We use Prisma as our ORM, and its migration system integrates directly into our CI/CD pipeline. Here is how migrations flow through environments:

```
Developer writes migration locally
    |
    v
prisma migrate dev          (generates SQL migration file)
    |
    v
Committed to Git            (migration file is version-controlled)
    |
    v
CI Pipeline runs            (prisma migrate deploy in test job)
    |
    v
Staging deployment          (prisma migrate deploy against staging DB)
    |
    v
Production deployment       (prisma migrate deploy against production DB)
```

The critical distinction: **`prisma migrate dev`** is used only on a developer's laptop. It generates migration files, applies them, and can reset the database. **`prisma migrate deploy`** is used in CI/CD. It applies pending migrations without generating new ones, making it safe for automated environments.

```typescript
// scripts/run-migrations.ts
import { execSync } from 'child_process';

interface MigrationConfig {
  maxRetries: number;
  retryDelayMs: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

const config: MigrationConfig = {
  maxRetries: 3,
  retryDelayMs: 5000,
  lockTimeoutMs: 30000,      // 30 seconds to acquire lock
  statementTimeoutMs: 300000, // 5 minutes per statement max
};

async function runMigrations(): Promise<void> {
  console.log('Starting database migrations...');

  // Set connection-level timeouts to prevent long-running migrations
  // from blocking the deployment pipeline indefinitely
  process.env.DATABASE_URL = addTimeoutParams(
    process.env.DATABASE_URL!,
    config.lockTimeoutMs,
    config.statementTimeoutMs
  );

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      console.log(`Migration attempt ${attempt}/${config.maxRetries}`);

      // Check for pending migrations first
      const status = execSync('npx prisma migrate status', {
        encoding: 'utf-8',
      });
      console.log('Migration status:', status);

      if (status.includes('Database schema is up to date')) {
        console.log('No pending migrations. Skipping.');
        return;
      }

      // Apply pending migrations
      execSync('npx prisma migrate deploy', {
        stdio: 'inherit',
        timeout: 600000, // 10 minute hard timeout
      });

      console.log('Migrations completed successfully.');
      return;
    } catch (error) {
      console.error(`Migration attempt ${attempt} failed:`, error);

      if (attempt === config.maxRetries) {
        console.error('All migration attempts exhausted. Failing deployment.');
        process.exit(1);
      }

      console.log(`Retrying in ${config.retryDelayMs}ms...`);
      await new Promise((r) => setTimeout(r, config.retryDelayMs));
    }
  }
}

function addTimeoutParams(
  url: string,
  lockTimeout: number,
  statementTimeout: number
): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}lock_timeout=${lockTimeout}&statement_timeout=${statementTimeout}`;
}

runMigrations();
```

Let me explain the design decisions:

**Retry logic**: Database migrations can fail for transient reasons -- a brief network blip, a temporary lock contention from a concurrent query. The retry loop (3 attempts with 5-second delays) handles these gracefully. But notice the hard limit: after 3 failures, the script exits with code 1, which fails the deployment. We do not retry forever.

**Lock timeout (30 seconds)**: When a migration runs `ALTER TABLE`, the database needs to acquire an exclusive lock on the table. If another transaction is holding a lock (a long-running query, for example), the migration waits. Without a timeout, it could wait indefinitely, blocking the deployment pipeline. The 30-second timeout says "if you cannot get the lock in 30 seconds, fail instead of waiting."

**Statement timeout (5 minutes)**: A single migration statement that runs for more than 5 minutes is either operating on a massive table without proper safeguards or has a bug. The timeout prevents a runaway migration from locking tables for an hour.

**`prisma migrate status` before deploy**: This check prevents unnecessary work. If there are no pending migrations, we skip the deploy entirely. This is important because `prisma migrate deploy` acquires a migration lock, and unnecessary lock acquisition can cause contention when multiple services are deploying simultaneously.

### Migration Safety Rules

Here are the rules our team enforces for database migrations. Break any of them and you will have a bad day.

```typescript
// docs/migration-safety-rules.ts
// These rules are enforced in code review and by CI checks.

const migrationSafetyRules = {
  // RULE 1: Never drop a column in the same deploy as the code change
  // that stops using it. Always do it in two deploys:
  //   Deploy 1: Remove column usage from code (keep column in DB)
  //   Deploy 2: Drop the column (code no longer references it)
  neverDropColumnWithCodeChange: true,

  // RULE 2: Never rename a column. Instead:
  //   Deploy 1: Add new column, dual-write to both
  //   Deploy 2: Migrate reads to new column
  //   Deploy 3: Stop writing to old column
  //   Deploy 4: Drop old column
  neverRenameColumn: true,

  // RULE 3: Always add new columns as nullable OR with a default value.
  // A NOT NULL column without a default requires rewriting the entire table,
  // which locks it for the duration of the rewrite.
  newColumnsNullableOrDefaulted: true,

  // RULE 4: Add indexes CONCURRENTLY. A regular CREATE INDEX locks the table
  // for writes. On a table with 500M rows, this can take 30+ minutes.
  // CREATE INDEX CONCURRENTLY takes longer but does not lock.
  indexesConcurrently: true,

  // RULE 5: Large data migrations run as background jobs, not in migration files.
  // Backfilling 500M rows in a migration will time out.
  largeDataMigrationsAreBackgroundJobs: true,

  // RULE 6: Every migration must be backward-compatible with the previous
  // code version. During a rolling update, old and new code run simultaneously.
  // The database must work with both.
  backwardCompatible: true,
};
```

> **Production War Story:** A team once added a `NOT NULL` column without a default value to a table with 200 million rows. The `ALTER TABLE` statement locked the table for 47 minutes while PostgreSQL rewrote every row. During those 47 minutes, no bookings could be created. The fix was simple: add the column as nullable, backfill the data in a background job, then add the `NOT NULL` constraint after all rows have values. Three deploys instead of one, but zero downtime.

> **Analogy:** Database migrations are like renovating a restaurant while it is open for business. You cannot tear down a wall during dinner service (dropping a column while code references it). You build the new wall first (add the new column), move the kitchen equipment (migrate the data), and then remove the old wall (drop the old column) during a quiet period. The patron never notices the renovation happening around them.

### Rollback Strategies for Migrations

Not all migrations can be rolled back with a simple `prisma migrate reset`. Here is our tiered rollback approach:

```typescript
// scripts/migration-rollback.ts

type RollbackStrategy = 'auto-revert' | 'manual-sql' | 'restore-backup' | 'forward-fix';

interface MigrationRollbackPlan {
  migrationId: string;
  strategy: RollbackStrategy;
  estimatedDowntime: string;
  rollbackSql?: string;
  requiresDba: boolean;
  testedInStaging: boolean;
}

// Every migration MUST have a rollback plan documented before it is approved
const rollbackPlans: MigrationRollbackPlan[] = [
  {
    // Adding a nullable column is trivially reversible
    migrationId: '20260215_add_loyalty_tier',
    strategy: 'auto-revert',
    estimatedDowntime: '0 seconds',
    rollbackSql: 'ALTER TABLE users DROP COLUMN loyalty_tier;',
    requiresDba: false,
    testedInStaging: true,
  },
  {
    // Data transformation migrations cannot be automatically reversed
    migrationId: '20260220_split_name_fields',
    strategy: 'manual-sql',
    estimatedDowntime: '0 seconds (backward compatible)',
    rollbackSql: `
      -- Reverse: merge first_name and last_name back into full_name
      UPDATE users SET full_name = CONCAT(first_name, ' ', last_name)
      WHERE full_name IS NULL AND first_name IS NOT NULL;
    `,
    requiresDba: true,
    testedInStaging: true,
  },
  {
    // Destructive migrations (column drops) require backup restore
    migrationId: '20260301_drop_legacy_address',
    strategy: 'restore-backup',
    estimatedDowntime: '15-30 minutes',
    requiresDba: true,
    testedInStaging: true,
  },
];
```

The four strategies, from least to most drastic:

1. **Auto-revert**: The migration has a clean inverse operation. Adding a column is reversed by dropping it. Adding an index is reversed by dropping it. These are safe and instant.

2. **Manual SQL**: The migration transformed data in a way that requires custom SQL to reverse. A DBA reviews and executes the rollback script. This takes minutes, not seconds, but does not require downtime.

3. **Restore from backup**: The migration was destructive (dropped data, truncated a table). The only recovery is restoring from a pre-migration backup. This causes downtime proportional to the database size.

4. **Forward-fix**: Rolling back is impossible or more dangerous than fixing forward. Example: a migration that restructures the primary key. In this case, you fix the bug in the code and deploy again. This is why you test every migration in staging first.

> **Common Mistake:** Teams write migrations but never test the rollback. "We will figure it out if something goes wrong." At 3 AM, with the database locked and customers unable to book, "figuring it out" takes much longer than you think. Every migration should have a tested rollback plan *before* it reaches production.

---

## Progressive Delivery: Canary, Blue-Green, and Feature Flags

Deploying code to production is only half the problem. The other half is *how* you expose that code to users. Progressive delivery is a set of strategies for gradually rolling out changes, monitoring their impact, and automatically rolling back if something goes wrong.

### Blue-Green Deployment (Deep Dive)

We introduced blue-green deployment earlier in the pipeline. Now let me show you the full implementation, including the Kubernetes manifests and the traffic switching logic.

```yaml
# k8s/booking-service-blue.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: booking-service-blue
  namespace: production
  labels:
    app: booking-service
    version: blue
spec:
  replicas: 20
  selector:
    matchLabels:
      app: booking-service
      version: blue
  template:
    metadata:
      labels:
        app: booking-service
        version: blue
    spec:
      containers:
        - name: booking-service
          image: registry.company.com/booking-service:abc123def
          ports:
            - containerPort: 3000
          resources:
            requests:
              cpu: 1000m
              memory: 2Gi
            limits:
              cpu: 2000m
              memory: 4Gi
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10

---
# The Service selector determines which deployment receives traffic
apiVersion: v1
kind: Service
metadata:
  name: booking-service
  namespace: production
spec:
  selector:
    app: booking-service
    version: blue    # <-- This is the switch. Change to "green" to flip traffic.
  ports:
    - port: 3000
      targetPort: 3000
      protocol: TCP
  type: ClusterIP
```

The traffic switch is a single line: `version: blue` in the Service selector. Here is the deployment script that orchestrates the full blue-green swap:

```bash
#!/bin/bash
# scripts/blue-green-deploy.sh

set -euo pipefail

NEW_VERSION=$1  # The Docker image tag to deploy
NAMESPACE="production"
SERVICE="booking-service"

# Step 1: Determine current active color
CURRENT_COLOR=$(kubectl get service $SERVICE -n $NAMESPACE \
  -o jsonpath='{.spec.selector.version}')

if [ "$CURRENT_COLOR" == "blue" ]; then
  NEW_COLOR="green"
else
  NEW_COLOR="blue"
fi

echo "Current: $CURRENT_COLOR | Deploying to: $NEW_COLOR"

# Step 2: Deploy new version to inactive color
kubectl set image deployment/${SERVICE}-${NEW_COLOR} \
  ${SERVICE}=${REGISTRY}/${SERVICE}:${NEW_VERSION} \
  -n $NAMESPACE

# Step 3: Scale up the new deployment
kubectl scale deployment/${SERVICE}-${NEW_COLOR} \
  --replicas=20 -n $NAMESPACE

# Step 4: Wait for all pods to be ready
echo "Waiting for $NEW_COLOR deployment to be ready..."
kubectl rollout status deployment/${SERVICE}-${NEW_COLOR} \
  -n $NAMESPACE --timeout=300s

# Step 5: Run smoke tests against the new deployment directly
echo "Running smoke tests against $NEW_COLOR..."
NEW_POD=$(kubectl get pods -n $NAMESPACE \
  -l app=$SERVICE,version=$NEW_COLOR \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec $NEW_POD -n $NAMESPACE -- \
  curl -sf http://localhost:3000/health || {
    echo "SMOKE TEST FAILED. Aborting deployment."
    kubectl scale deployment/${SERVICE}-${NEW_COLOR} \
      --replicas=0 -n $NAMESPACE
    exit 1
  }

# Step 6: Switch traffic to new color
echo "Switching traffic from $CURRENT_COLOR to $NEW_COLOR..."
kubectl patch service $SERVICE -n $NAMESPACE \
  -p "{\"spec\":{\"selector\":{\"version\":\"$NEW_COLOR\"}}}"

# Step 7: Wait and monitor error rates
echo "Monitoring error rates for 5 minutes..."
sleep 300

ERROR_RATE=$(curl -s "http://prometheus:9090/api/v1/query?query=\
  rate(http_requests_total{service='$SERVICE',status=~'5..'}[5m])/\
  rate(http_requests_total{service='$SERVICE'}[5m])*100" \
  | jq '.data.result[0].value[1]' -r)

if (( $(echo "$ERROR_RATE > 1.0" | bc -l) )); then
  echo "ERROR RATE $ERROR_RATE% exceeds threshold! Rolling back..."
  kubectl patch service $SERVICE -n $NAMESPACE \
    -p "{\"spec\":{\"selector\":{\"version\":\"$CURRENT_COLOR\"}}}"
  echo "ROLLBACK COMPLETE. Traffic restored to $CURRENT_COLOR."
  exit 1
fi

# Step 8: Scale down old deployment
echo "Deployment successful. Scaling down $CURRENT_COLOR..."
kubectl scale deployment/${SERVICE}-${CURRENT_COLOR} \
  --replicas=0 -n $NAMESPACE

echo "Blue-green deployment complete. Active: $NEW_COLOR"
```

Let me walk through the critical steps:

**Step 4 (Wait for readiness)**: `kubectl rollout status` blocks until all 20 pods in the new deployment pass their readiness probes. If a pod crashes or fails to start, this command times out after 300 seconds and the script aborts. No traffic is switched.

**Step 5 (Smoke tests)**: We test the new deployment directly, not through the Service. We `kubectl exec` into a pod and hit the health endpoint. This confirms the application is actually running, not just that the container started. More sophisticated smoke tests would test the booking flow end-to-end.

**Step 7 (Error rate monitoring)**: After switching traffic, we query Prometheus for the 5xx error rate over the past 5 minutes. If it exceeds 1%, we automatically roll back by switching the Service selector back to the old color. The old deployment is still running at full scale, so the rollback is instantaneous.

**Step 8 (Scale down)**: Only after confirming the new deployment is healthy do we scale down the old one. Until this step, both deployments are running, consuming double the resources. This is the cost of zero-downtime deployment.

> **What If You Skip This?** Without blue-green deployment, rolling back means redeploying the previous Docker image, waiting for pods to start, and hoping nothing goes wrong during the rollback itself. With blue-green, rollback is changing one line in a Kubernetes Service. It takes less than a second.

### Canary Deployments with Istio

Blue-green is binary: all traffic goes to blue or all goes to green. Canary deployment is more granular: you send a small percentage of traffic to the new version and gradually increase it.

```yaml
# k8s/istio-canary.yaml
apiVersion: networking.istio.io/v1beta1
kind: VirtualService
metadata:
  name: booking-service
  namespace: production
spec:
  hosts:
    - booking-service
  http:
    - route:
        - destination:
            host: booking-service
            subset: stable
          weight: 95
        - destination:
            host: booking-service
            subset: canary
          weight: 5

---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: booking-service
  namespace: production
spec:
  host: booking-service
  subsets:
    - name: stable
      labels:
        version: stable
    - name: canary
      labels:
        version: canary
```

This Istio configuration sends 95% of traffic to the stable version and 5% to the canary. Here is what that means in practice:

At 1,667 bookings per second, the canary handles roughly 83 bookings per second. That is enough to detect issues (network errors, database query failures, increased latency) but small enough that a bug affects only 5% of users. If the canary's error rate is normal after 15 minutes, you increase the weight: 10%, 25%, 50%, 100%.

```typescript
// scripts/canary-promotion.ts
// Automated canary promotion based on metrics

interface CanaryStage {
  weight: number;        // Percentage of traffic to canary
  durationMinutes: number; // How long to observe at this weight
  successCriteria: {
    maxErrorRate: number;      // Maximum 5xx error rate (%)
    maxP99Latency: number;     // Maximum p99 latency (ms)
    minSuccessRate: number;    // Minimum success rate (%)
  };
}

const canaryStages: CanaryStage[] = [
  {
    weight: 5,
    durationMinutes: 15,
    successCriteria: {
      maxErrorRate: 0.5,
      maxP99Latency: 500,
      minSuccessRate: 99.5,
    },
  },
  {
    weight: 25,
    durationMinutes: 15,
    successCriteria: {
      maxErrorRate: 0.5,
      maxP99Latency: 500,
      minSuccessRate: 99.5,
    },
  },
  {
    weight: 50,
    durationMinutes: 15,
    successCriteria: {
      maxErrorRate: 0.5,
      maxP99Latency: 450,
      minSuccessRate: 99.5,
    },
  },
  {
    weight: 100,
    durationMinutes: 30,
    successCriteria: {
      maxErrorRate: 0.3,
      maxP99Latency: 400,
      minSuccessRate: 99.7,
    },
  },
];

async function promoteCanary(): Promise<void> {
  for (const stage of canaryStages) {
    console.log(`Setting canary weight to ${stage.weight}%...`);
    await updateIstioWeight(stage.weight);

    console.log(`Observing for ${stage.durationMinutes} minutes...`);
    await sleep(stage.durationMinutes * 60 * 1000);

    const metrics = await getCanaryMetrics();
    console.log(`Canary metrics:`, metrics);

    if (metrics.errorRate > stage.successCriteria.maxErrorRate) {
      console.error(`Error rate ${metrics.errorRate}% exceeds threshold ${stage.successCriteria.maxErrorRate}%`);
      await rollbackCanary();
      return;
    }

    if (metrics.p99Latency > stage.successCriteria.maxP99Latency) {
      console.error(`P99 latency ${metrics.p99Latency}ms exceeds threshold ${stage.successCriteria.maxP99Latency}ms`);
      await rollbackCanary();
      return;
    }

    if (metrics.successRate < stage.successCriteria.minSuccessRate) {
      console.error(`Success rate ${metrics.successRate}% below threshold ${stage.successCriteria.minSuccessRate}%`);
      await rollbackCanary();
      return;
    }

    console.log(`Stage ${stage.weight}% passed. Promoting...`);
  }

  console.log('Canary promotion complete. New version is now stable.');
  await promoteCanaryToStable();
}
```

The beauty of canary deployment is the graduated exposure. At 5%, even a catastrophic bug (100% error rate) only affects 5% of users. And the automated promotion script catches it within 15 minutes and rolls back automatically. The alternative -- deploying to 100% of traffic and hoping for the best -- is gambling with your users' experience.

> **Analogy:** Canary deployment gets its name from the coal mining practice of bringing a canary into the mine. If the canary stops singing (or dies), the miners know there is toxic gas and evacuate. The canary version of your application is the early warning system. If it starts failing, you pull the new code out before the "toxic gas" reaches the rest of your users.

### Feature Flags: Ship Code Without Shipping Features

Feature flags (also called feature toggles) let you deploy code to production but hide it from users until you are ready. This is the enabler for trunk-based development: you can merge incomplete features to `main` as long as they are behind a flag.

```typescript
// src/feature-flags/feature-flag.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface FeatureFlag {
  name: string;
  enabled: boolean;
  rolloutPercentage: number;   // 0-100: gradual rollout
  allowedUserIds: string[];    // Specific users for beta testing
  allowedRegions: string[];    // Region-specific rollouts
  enabledSince?: Date;
  description: string;
}

@Injectable()
export class FeatureFlagService implements OnModuleInit {
  private flags: Map<string, FeatureFlag> = new Map();
  private refreshIntervalMs = 30_000; // Refresh every 30 seconds

  constructor(
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadFlags();
    // Periodically refresh flags from the config source
    setInterval(() => this.loadFlags(), this.refreshIntervalMs);
  }

  private async loadFlags(): Promise<void> {
    // In production, this reads from a database or config service
    // like LaunchDarkly, Unleash, or a simple Redis hash
    const flagDefinitions: FeatureFlag[] = [
      {
        name: 'new-search-algorithm',
        enabled: true,
        rolloutPercentage: 25,
        allowedUserIds: [],
        allowedRegions: ['us-east-1'],
        description: 'New Elasticsearch-based search with improved relevance scoring',
      },
      {
        name: 'loyalty-points-v2',
        enabled: true,
        rolloutPercentage: 10,
        allowedUserIds: ['user-123', 'user-456'],  // Internal testers
        allowedRegions: [],
        description: 'Revamped loyalty points calculation with tiered multipliers',
      },
      {
        name: 'instant-refunds',
        enabled: false,
        rolloutPercentage: 0,
        allowedUserIds: [],
        allowedRegions: [],
        description: 'Instant refund processing (pending legal review)',
      },
    ];

    this.flags.clear();
    for (const flag of flagDefinitions) {
      this.flags.set(flag.name, flag);
    }
  }

  isEnabled(flagName: string, context?: {
    userId?: string;
    region?: string;
  }): boolean {
    const flag = this.flags.get(flagName);
    if (!flag || !flag.enabled) {
      return false;
    }

    // Check if user is in the explicit allow list (beta testers)
    if (context?.userId && flag.allowedUserIds.includes(context.userId)) {
      return true;
    }

    // Check region-specific rollout
    if (flag.allowedRegions.length > 0 && context?.region) {
      if (!flag.allowedRegions.includes(context.region)) {
        return false;
      }
    }

    // Percentage-based rollout using consistent hashing
    // The same userId always gets the same result (no flickering)
    if (context?.userId && flag.rolloutPercentage < 100) {
      const hash = this.consistentHash(context.userId, flagName);
      return hash < flag.rolloutPercentage;
    }

    return flag.rolloutPercentage === 100;
  }

  private consistentHash(userId: string, flagName: string): number {
    // Simple hash that produces consistent results for the same input
    const str = `${userId}:${flagName}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash) % 100;
  }
}
```

Here is how you use feature flags in your business logic:

```typescript
// src/booking/booking.service.ts

@Injectable()
export class BookingService {
  constructor(
    private readonly featureFlags: FeatureFlagService,
    private readonly searchService: SearchService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  async searchAvailability(query: SearchQuery, userId: string): Promise<SearchResult[]> {
    const context = { userId, region: process.env.REGION };

    if (this.featureFlags.isEnabled('new-search-algorithm', context)) {
      // New code path: Elasticsearch with improved relevance
      return this.searchService.searchWithNewAlgorithm(query);
    }

    // Old code path: existing search logic
    return this.searchService.searchLegacy(query);
  }

  async calculateLoyaltyPoints(booking: Booking, userId: string): Promise<number> {
    const context = { userId, region: process.env.REGION };

    if (this.featureFlags.isEnabled('loyalty-points-v2', context)) {
      return this.loyaltyService.calculateV2(booking);
    }

    return this.loyaltyService.calculateV1(booking);
  }
}
```

There are several important patterns in this implementation:

**Consistent hashing for percentage rollouts**: When `rolloutPercentage` is 25%, we need to ensure the same user always sees the same version. If user A gets the new search algorithm on their first query, they should get it on every subsequent query. Random assignment would cause users to see the feature flickering on and off. The `consistentHash` function produces a deterministic result based on the user ID and flag name.

**Region-specific flags**: The `new-search-algorithm` flag is only enabled in `us-east-1`. This lets you test a new feature in one region before rolling it out globally. If the new search algorithm has a bug that only manifests under European date formats, you catch it in `us-east-1` before it reaches `eu-west-1`.

**Periodic refresh**: Flags are reloaded every 30 seconds. This means you can enable or disable a feature in your config store and see the change take effect across all pods within 30 seconds -- without redeploying anything. This is your emergency kill switch: if a feature is causing problems, flip the flag off and all pods stop using the new code path.

> **Common Mistake:** Some teams implement feature flags as environment variables. This requires a redeploy to change a flag. The entire point of feature flags is that they can be changed *without* deploying. If toggling a flag requires a deploy, you have not built a feature flag system -- you have built a config file with extra steps. Use a dynamic config source (database, Redis, external service like LaunchDarkly or Unleash).

> **Key Term:** **Feature flag (feature toggle)** -- A mechanism to enable or disable application features at runtime without deploying new code. Feature flags decouple deployment (putting code in production) from release (making it available to users). This enables trunk-based development, canary releases, and instant rollback of features without code changes.

---

## GitOps with ArgoCD: The Declarative Deployment Model

So far, our CI/CD pipeline builds Docker images and pushes them to a registry. But who tells Kubernetes to pull those images and deploy? In a traditional pipeline, the CI system (GitHub Actions) has `kubectl` access and directly modifies the cluster. This works but creates a problem: your CI system has root-level access to production Kubernetes. If GitHub Actions is compromised, an attacker has full control over your production cluster.

**GitOps** flips this model. Instead of the CI system pushing changes to the cluster, the cluster *pulls* changes from a Git repository. The Git repository becomes the single source of truth for what should be running in production.

```
Traditional CI/CD:
  GitHub Actions --kubectl apply--> Kubernetes Cluster
  (CI pushes to cluster -- CI needs cluster credentials)

GitOps:
  GitHub Actions --push image tag--> Git Repository (k8s manifests)
  ArgoCD (in cluster) --watches--> Git Repository
  ArgoCD --applies changes--> Kubernetes Cluster
  (CI never touches the cluster directly)
```

### ArgoCD Application Configuration

```yaml
# argocd/booking-service.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: booking-service
  namespace: argocd
  annotations:
    notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
    notifications.argoproj.io/subscribe.on-sync-failed.slack: deployments-alerts
spec:
  project: production
  source:
    repoURL: https://github.com/company/booking-platform-k8s.git
    targetRevision: main
    path: environments/production/booking-service
    helm:
      valueFiles:
        - values.yaml
        - values-production.yaml
      parameters:
        - name: image.tag
          value: latest   # Updated by CI pipeline via PR

  destination:
    server: https://kubernetes.default.svc
    namespace: production

  syncPolicy:
    automated:
      prune: true           # Delete resources removed from Git
      selfHeal: true         # Revert manual changes to match Git
      allowEmpty: false      # Never sync if source is empty (safety)
    syncOptions:
      - CreateNamespace=true
      - PrunePropagationPolicy=foreground
      - PruneLast=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m

  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers:
        - /spec/replicas   # HPA manages replicas, not Git
```

Let me decode the important fields:

**`source.repoURL`** -- ArgoCD watches a separate Git repository that contains only Kubernetes manifests. This is not the application source code repository. Separating application code from deployment configuration is a GitOps best practice. The application code repo holds TypeScript and tests. The deployment repo holds Helm charts and environment-specific values.

**`syncPolicy.automated.selfHeal: true`** -- If someone manually changes something in Kubernetes (scales a deployment, modifies a ConfigMap), ArgoCD will detect the drift and *automatically revert it* to match the Git repository. This is powerful: Git is always the source of truth, and unauthorized or accidental changes are undone within minutes.

**`syncPolicy.automated.prune: true`** -- If you remove a resource from Git (delete a Deployment YAML file), ArgoCD deletes the corresponding resource from Kubernetes. Without this, unused resources accumulate in the cluster.

**`ignoreDifferences` for replicas** -- The Horizontal Pod Autoscaler (HPA) adjusts the number of replicas dynamically. If Git says `replicas: 20` but the HPA has scaled to 35, we do not want ArgoCD to scale back down to 20. The `ignoreDifferences` directive tells ArgoCD to ignore the replica count and let the HPA manage it.

**Notifications** -- The annotations at the top configure Slack notifications. When a sync succeeds, the `deployments` channel is notified. When a sync fails, the `deployments-alerts` channel gets an immediate alert. This closes the feedback loop: the team knows about every deployment without watching the ArgoCD dashboard.

### How CI/CD Triggers GitOps Deployment

The CI pipeline does not deploy directly. Instead, it updates the image tag in the deployment Git repository and opens a pull request:

```yaml
  # Job 6 in our GitHub Actions pipeline (continued from earlier)
  update-manifests:
    name: Update Deployment Manifests
    runs-on: ubuntu-latest
    needs: [docker-build]
    steps:
      - name: Checkout deployment repo
        uses: actions/checkout@v4
        with:
          repository: company/booking-platform-k8s
          token: ${{ secrets.DEPLOY_REPO_TOKEN }}
          path: deploy-repo

      - name: Update image tag
        run: |
          cd deploy-repo
          # Update the image tag in the Helm values file
          yq eval '.image.tag = "${{ github.sha }}"' -i \
            environments/production/booking-service/values.yaml

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v6
        with:
          path: deploy-repo
          token: ${{ secrets.DEPLOY_REPO_TOKEN }}
          commit-message: "deploy: booking-service ${{ github.sha }}"
          title: "Deploy booking-service @ ${{ github.sha }}"
          body: |
            Automated deployment PR for booking-service.

            **Image:** `${{ needs.docker-build.outputs.image-tag }}`
            **Commit:** ${{ github.sha }}
            **Author:** ${{ github.actor }}
            **Tests:** All passed
            **Security scan:** Clean
          branch: deploy/booking-service-${{ github.sha }}
          base: main
```

The flow is now:

1. Developer merges code to `main` in the application repo
2. CI pipeline runs tests, builds Docker image, pushes to ECR
3. CI pipeline opens a PR in the deployment repo, changing the image tag
4. A team lead reviews and merges the PR (or it auto-merges for staging)
5. ArgoCD detects the change in the deployment repo
6. ArgoCD applies the updated Helm chart, triggering a rolling update in Kubernetes

Every deployment is a Git commit. Every rollback is a `git revert`. The entire deployment history is in the Git log. You can answer "what was running in production on February 3rd at 14:00?" by looking at the Git history.

> **Analogy:** GitOps is like a thermostat for your infrastructure. You set the desired temperature (the desired state in Git). The thermostat (ArgoCD) continuously checks the actual temperature (actual cluster state) and adjusts the heating/cooling (applies/removes resources) to match. You never manually turn the furnace on and off -- you just change the desired temperature and the thermostat handles the rest.

> **Key Term:** **GitOps** -- An operational model where the desired state of infrastructure and applications is stored in a Git repository. An agent running inside the cluster (like ArgoCD or Flux) continuously reconciles the actual state with the desired state. Deployments happen by changing Git, not by running `kubectl` commands.

---

## Automated Testing Gates

A pipeline is only as strong as its weakest gate. Let me show you the full testing hierarchy we enforce before code reaches production.

### The Testing Pyramid in CI/CD

```
                    ┌─────────┐
                    │  Load   │  Pre-production only
                    │  Tests  │  (weekly or before major releases)
                   ─┴─────────┴─
                  ┌─────────────┐
                  │   E2E Tests  │  Staging environment
                  │  (Cypress)   │  (runs against deployed service)
                 ─┴─────────────┴─
                ┌─────────────────┐
                │ Integration Tests│  CI pipeline (real DB, Redis, Kafka)
                │  (Jest + Docker) │
               ─┴─────────────────┴─
              ┌─────────────────────┐
              │     Unit Tests       │  CI pipeline (fast, isolated)
              │     (Jest + mocks)   │
             ─┴─────────────────────┴─
```

Each layer catches different categories of bugs:

| Layer | What It Catches | Speed | Coverage |
|-------|----------------|-------|----------|
| Unit Tests | Logic bugs, edge cases, algorithms | 30 seconds | 94% line coverage |
| Integration Tests | Database queries, event schemas, API contracts | 3 minutes | Key flows |
| E2E Tests | User-visible bugs, UI regressions, full workflow | 10 minutes | Critical paths |
| Load Tests | Performance regressions, scalability issues | 30 minutes | Peak traffic simulation |

### E2E Tests in the Pipeline

```yaml
  # Job in a separate workflow, triggered after staging deployment
  e2e-tests:
    name: End-to-End Tests
    runs-on: ubuntu-latest
    needs: [deploy-staging]
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ env.NODE_VERSION }}

      - name: Install test dependencies
        run: |
          cd e2e-tests
          npm ci

      - name: Run E2E tests against staging
        run: |
          cd e2e-tests
          npx playwright test --project=api-tests
        env:
          BASE_URL: https://staging-api.booking.company.com
          TEST_USER_EMAIL: e2e-test@booking.company.com
          TEST_USER_PASSWORD: ${{ secrets.E2E_TEST_PASSWORD }}
        timeout-minutes: 15

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-results
          path: e2e-tests/test-results/
```

E2E tests run against the deployed staging environment, not against local containers. They exercise the full stack: API Gateway, load balancers, actual DNS routing, real Kubernetes services, and real databases. These tests catch integration issues that exist only in a real deployment -- misconfigured environment variables, wrong service DNS names, missing CORS headers, expired TLS certificates.

### Load Tests: The Final Gate Before Production

```typescript
// load-tests/booking-flow.ts
// Using k6 for load testing (runs as a CI job before major releases)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const bookingDuration = new Trend('booking_duration');

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp up to 100 virtual users
    { duration: '5m', target: 500 },   // Ramp up to 500
    { duration: '5m', target: 1000 },  // Ramp up to 1000
    { duration: '5m', target: 1000 },  // Sustain 1000 for 5 minutes
    { duration: '3m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],  // 95% under 500ms
    errors: ['rate<0.01'],                             // Less than 1% errors
    booking_duration: ['p(95)<2000'],                  // Booking flow under 2s
  },
};

export default function () {
  // Step 1: Search for availability
  const searchRes = http.post(
    `${__ENV.BASE_URL}/api/v1/search`,
    JSON.stringify({
      type: 'hotel',
      destination: 'new-york',
      checkIn: '2026-03-15',
      checkOut: '2026-03-18',
      guests: 2,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(searchRes, {
    'search returns 200': (r) => r.status === 200,
    'search returns results': (r) => JSON.parse(r.body).length > 0,
  });

  errorRate.add(searchRes.status !== 200);

  // Step 2: Create a booking
  const startBooking = Date.now();
  const bookingRes = http.post(
    `${__ENV.BASE_URL}/api/v1/bookings`,
    JSON.stringify({
      propertyId: 'prop-001',
      roomType: 'standard',
      checkIn: '2026-03-15',
      checkOut: '2026-03-18',
      guests: 2,
      paymentToken: 'tok_test_visa',
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.TEST_TOKEN}`,
      },
    }
  );

  bookingDuration.add(Date.now() - startBooking);

  check(bookingRes, {
    'booking returns 201': (r) => r.status === 201,
    'booking has confirmation': (r) => JSON.parse(r.body).confirmationId !== undefined,
  });

  errorRate.add(bookingRes.status !== 201);

  sleep(1); // Think time between requests
}
```

The load test simulates the real booking flow at scale: search, then book. The `thresholds` are the pass/fail criteria:

- **p95 latency under 500ms**: 95% of all requests must complete within 500ms. If a code change introduces a slow query, this threshold catches it.
- **Error rate under 1%**: No more than 1% of requests can fail. This catches bugs that only appear under concurrency (race conditions, connection pool exhaustion, deadlocks).
- **Booking flow under 2 seconds**: The complete booking flow (search + create booking) must finish within 2 seconds for 95% of virtual users.

If any threshold is breached, the load test fails, and the deployment to production is blocked.

> **What If You Skip This?** Without load testing, you discover performance regressions when real users complain. By then, thousands of users have experienced slow page loads and failed bookings. Load tests in the pipeline catch these regressions before they reach production.

---

## Secret Management in CI/CD

Secrets -- API keys, database passwords, encryption keys, OAuth client secrets -- are the most sensitive data in your pipeline. A leaked secret can lead to data breaches, financial loss, and regulatory penalties. Here is how we manage secrets safely across environments.

### The Problem with GitHub Secrets

GitHub Actions Secrets are encrypted and masked in logs. They are a reasonable starting point, but they have limitations at scale:

- **No versioning**: You cannot see the history of a secret's values. If someone changes the database password, the old value is gone.
- **No audit trail**: GitHub does not log who read or changed a secret, only who has access.
- **No dynamic secrets**: Every secret is static. A database password lives forever until manually rotated.
- **Cross-environment management**: Managing different secrets for dev, staging, and production across 12 services requires discipline that manual processes cannot sustain.

### HashiCorp Vault: Production-Grade Secret Management

```typescript
// src/config/vault.config.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import Vault from 'node-vault';

interface VaultSecrets {
  databaseUrl: string;
  redisUrl: string;
  stripeSecretKey: string;
  jwtSigningKey: string;
  kafkaSaslPassword: string;
}

@Injectable()
export class VaultConfigService implements OnModuleInit {
  private readonly logger = new Logger(VaultConfigService.name);
  private client: Vault.client;
  private secrets: VaultSecrets;
  private leaseId: string;

  async onModuleInit(): Promise<void> {
    this.client = Vault({
      endpoint: process.env.VAULT_ADDR,
      token: process.env.VAULT_TOKEN,
    });

    await this.loadSecrets();
    this.startLeaseRenewal();
  }

  private async loadSecrets(): Promise<void> {
    try {
      // Read secrets from Vault's KV v2 engine
      const result = await this.client.read(
        'secret/data/booking-service/production'
      );

      this.secrets = {
        databaseUrl: result.data.data.DATABASE_URL,
        redisUrl: result.data.data.REDIS_URL,
        stripeSecretKey: result.data.data.STRIPE_SECRET_KEY,
        jwtSigningKey: result.data.data.JWT_SIGNING_KEY,
        kafkaSaslPassword: result.data.data.KAFKA_SASL_PASSWORD,
      };

      this.leaseId = result.lease_id;
      this.logger.log('Secrets loaded from Vault successfully');
    } catch (error) {
      this.logger.error('Failed to load secrets from Vault', error);
      throw error; // Crash on startup if secrets are unavailable
    }
  }

  private startLeaseRenewal(): void {
    // Renew the lease every 12 hours (secrets expire after 24 hours)
    setInterval(async () => {
      try {
        await this.client.write(`sys/leases/renew`, {
          lease_id: this.leaseId,
          increment: 86400, // 24 hours
        });
        this.logger.log('Vault lease renewed');
      } catch (error) {
        this.logger.error('Failed to renew Vault lease', error);
        // Reload secrets entirely on renewal failure
        await this.loadSecrets();
      }
    }, 12 * 60 * 60 * 1000);
  }

  getDatabaseUrl(): string { return this.secrets.databaseUrl; }
  getRedisUrl(): string { return this.secrets.redisUrl; }
  getStripeKey(): string { return this.secrets.stripeSecretKey; }
  getJwtKey(): string { return this.secrets.jwtSigningKey; }
}
```

Key concepts in this implementation:

**Lease-based secrets**: Vault secrets have a time-to-live (TTL). After the lease expires, the application must renew or re-fetch the secret. This means a leaked secret is only valid for a limited time. If someone exfiltrates your database password, it expires in 24 hours.

**Crash on startup if Vault is unreachable**: Notice the `throw error` in `loadSecrets()`. If the application cannot reach Vault, it refuses to start. This is intentional. Running without secrets means running with broken database connections and failed payments. It is better to crash loudly than to run in a degraded state that silently drops transactions.

**Separation of secrets by environment**: The Vault path `secret/data/booking-service/production` is namespaced by service and environment. Staging has its own path (`secret/data/booking-service/staging`). A developer with access to staging secrets cannot read production secrets unless explicitly granted.

### Sealed Secrets for Kubernetes

For secrets that Kubernetes needs (not just the application), we use Sealed Secrets. These let you store encrypted secrets in Git -- safe to commit because they can only be decrypted by the Sealed Secrets controller inside the cluster.

```yaml
# k8s/sealed-secrets/booking-service-secrets.yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: booking-service-secrets
  namespace: production
spec:
  encryptedData:
    database-url: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq...  # Encrypted
    redis-url: AgCtr87HJQWK+LsPkRbJjs82hGDmq1...        # Encrypted
    stripe-key: AgDw2k8PMSXQ+NvTlUYZZB3pR21bHDqz...     # Encrypted
  template:
    metadata:
      name: booking-service-secrets
      namespace: production
    type: Opaque
```

The encrypted values can be committed to Git safely. Only the Sealed Secrets controller (which holds the private key) can decrypt them. When ArgoCD syncs this manifest, the controller decrypts it into a standard Kubernetes Secret that your pods can reference.

```bash
# How to create a sealed secret
echo -n "mysql://user:password@db:3306/booking" \
  | kubectl create secret generic booking-service-secrets \
    --dry-run=client \
    --from-file=database-url=/dev/stdin \
    -o yaml \
  | kubeseal --format yaml > booking-service-secrets.yaml
```

> **Production War Story:** A team stored database credentials as plain Kubernetes Secrets and committed the base64-encoded YAML to their Git repository. "Base64 is encryption, right?" No. Base64 is encoding, not encryption. Anyone who clones the repo can decode the secret with `echo "dGVzdA==" | base64 -d`. The credentials were exposed in the Git history for 8 months before someone noticed. Sealed Secrets prevents this entirely -- the YAML in Git is genuinely encrypted and cannot be reversed without the cluster's private key.

> **Common Mistake:** Treating base64 as encryption. In Kubernetes, Secrets are stored as base64-encoded strings. `base64` is **not encryption** -- it is a reversible encoding. Anyone with access to the YAML file can decode it instantly. Never commit unencrypted Kubernetes Secrets to Git. Use Sealed Secrets, SOPS, or an external secrets manager.

---

## Rollback Automation: When Things Go Wrong

No matter how many tests you run, bad deploys happen. A query that performs perfectly in staging takes 30 seconds in production because the production database is 100x larger. A third-party API changes its response format without warning. A timing-dependent bug only manifests under real concurrent traffic. When these happen, you need to rollback fast -- ideally automatically.

### Automated Rollback Based on Error Rate

```typescript
// scripts/auto-rollback-monitor.ts
import { PrometheusClient } from './prometheus-client';
import { KubernetesClient } from './kubernetes-client';
import { SlackNotifier } from './slack-notifier';

interface RollbackConfig {
  serviceName: string;
  namespace: string;
  errorRateThreshold: number;     // Percentage (e.g., 2.0 for 2%)
  latencyP99Threshold: number;    // Milliseconds
  evaluationWindow: string;        // Prometheus duration (e.g., '5m')
  cooldownMinutes: number;         // Minimum time between rollbacks
  consecutiveFailures: number;     // How many check failures before rollback
}

const config: RollbackConfig = {
  serviceName: 'booking-service',
  namespace: 'production',
  errorRateThreshold: 2.0,
  latencyP99Threshold: 1000,
  evaluationWindow: '5m',
  cooldownMinutes: 30,
  consecutiveFailures: 3,   // 3 consecutive checks (15 seconds apart) to avoid flapping
};

class AutoRollbackMonitor {
  private consecutiveFailureCount = 0;
  private lastRollbackTime: Date | null = null;

  constructor(
    private prometheus: PrometheusClient,
    private k8s: KubernetesClient,
    private slack: SlackNotifier,
  ) {}

  async checkAndRollback(): Promise<void> {
    // Query current error rate from Prometheus
    const errorRate = await this.prometheus.query(`
      rate(http_requests_total{
        service="${config.serviceName}",
        status=~"5.."
      }[${config.evaluationWindow}])
      /
      rate(http_requests_total{
        service="${config.serviceName}"
      }[${config.evaluationWindow}])
      * 100
    `);

    // Query p99 latency
    const p99Latency = await this.prometheus.query(`
      histogram_quantile(0.99,
        rate(http_request_duration_seconds_bucket{
          service="${config.serviceName}"
        }[${config.evaluationWindow}])
      ) * 1000
    `);

    const isHealthy =
      errorRate < config.errorRateThreshold &&
      p99Latency < config.latencyP99Threshold;

    if (isHealthy) {
      this.consecutiveFailureCount = 0;
      return;
    }

    this.consecutiveFailureCount++;
    console.warn(
      `Health check failed (${this.consecutiveFailureCount}/${config.consecutiveFailures}):`,
      `error_rate=${errorRate.toFixed(2)}%, p99=${p99Latency.toFixed(0)}ms`
    );

    // Only rollback after consecutive failures (prevents flapping)
    if (this.consecutiveFailureCount < config.consecutiveFailures) {
      return;
    }

    // Check cooldown period
    if (this.lastRollbackTime) {
      const minutesSinceLastRollback =
        (Date.now() - this.lastRollbackTime.getTime()) / 60000;
      if (minutesSinceLastRollback < config.cooldownMinutes) {
        console.warn(
          `Rollback cooldown active (${minutesSinceLastRollback.toFixed(0)}m / ${config.cooldownMinutes}m). Skipping.`
        );
        return;
      }
    }

    // Execute rollback
    await this.executeRollback(errorRate, p99Latency);
  }

  private async executeRollback(
    errorRate: number,
    p99Latency: number
  ): Promise<void> {
    console.error('INITIATING AUTOMATIC ROLLBACK');

    // Get the previous revision
    const previousRevision = await this.k8s.getPreviousRevision(
      config.serviceName,
      config.namespace
    );

    // Notify the team BEFORE rolling back
    await this.slack.sendAlert({
      channel: '#deployments-alerts',
      title: 'AUTOMATIC ROLLBACK INITIATED',
      message: [
        `Service: ${config.serviceName}`,
        `Error rate: ${errorRate.toFixed(2)}% (threshold: ${config.errorRateThreshold}%)`,
        `P99 latency: ${p99Latency.toFixed(0)}ms (threshold: ${config.latencyP99Threshold}ms)`,
        `Rolling back to revision: ${previousRevision}`,
        `Action required: Investigate and fix the issue before redeploying.`,
      ].join('\n'),
      severity: 'critical',
    });

    // Execute the rollback
    await this.k8s.rollbackDeployment(
      config.serviceName,
      config.namespace,
      previousRevision
    );

    this.lastRollbackTime = new Date();
    this.consecutiveFailureCount = 0;

    // Verify the rollback worked
    await new Promise((r) => setTimeout(r, 60000)); // Wait 1 minute
    const postRollbackErrorRate = await this.prometheus.query(`
      rate(http_requests_total{
        service="${config.serviceName}",
        status=~"5.."
      }[1m])
      /
      rate(http_requests_total{
        service="${config.serviceName}"
      }[1m])
      * 100
    `);

    if (postRollbackErrorRate < config.errorRateThreshold) {
      await this.slack.sendAlert({
        channel: '#deployments-alerts',
        title: 'ROLLBACK SUCCESSFUL',
        message: `Error rate after rollback: ${postRollbackErrorRate.toFixed(2)}%. Service is healthy.`,
        severity: 'info',
      });
    } else {
      await this.slack.sendAlert({
        channel: '#deployments-alerts',
        title: 'ROLLBACK DID NOT RESOLVE THE ISSUE',
        message: `Error rate after rollback: ${postRollbackErrorRate.toFixed(2)}%. Manual investigation required IMMEDIATELY.`,
        severity: 'critical',
      });
    }
  }
}

// Run the monitor every 5 seconds
const monitor = new AutoRollbackMonitor(
  new PrometheusClient(process.env.PROMETHEUS_URL!),
  new KubernetesClient(),
  new SlackNotifier(process.env.SLACK_WEBHOOK_URL!)
);

setInterval(() => monitor.checkAndRollback(), 5000);
```

Let me explain the design decisions that prevent this from causing more harm than good:

**Consecutive failure check (3 failures)**: A single elevated error rate reading could be a transient spike -- a burst of invalid requests, a brief network hiccup. Requiring 3 consecutive failures (spaced 5 seconds apart, so 15 seconds total) filters out noise and only triggers on sustained degradation.

**Cooldown period (30 minutes)**: Without a cooldown, a flapping service could trigger rollbacks every few minutes, thrashing between versions. The 30-minute cooldown ensures we rollback at most once per half hour and gives the team time to investigate.

**Notify before rollback**: The Slack alert goes out *before* the rollback command is issued. This way, even if the rollback itself fails (Kubernetes API is unreachable, for example), the team knows something is wrong and can intervene manually.

**Post-rollback verification**: After rolling back, we wait 60 seconds and re-check the error rate. If the error rate is still high, the problem was not the deployment -- it could be a database issue, an external API outage, or a networking problem. The second alert tells the team "rollback did not fix it, investigate further."

> **Production War Story:** A fintech company deployed a change that introduced an N+1 query -- a database query inside a loop. In staging (100 test bookings), it was imperceptible. In production (10 million bookings), each page load executed 4,000 queries instead of 4. The database CPU hit 100%, queries timed out, and the error rate spiked to 35%. Their automatic rollback triggered in 18 seconds, switching back to the previous version. Total customer impact: less than 30 seconds of degraded service. Without auto-rollback, the incident would have lasted 15+ minutes while someone noticed, paged the on-call engineer, and manually rolled back.

---

## Pipeline Monitoring and Notifications

A pipeline you do not monitor is a pipeline you do not trust. Here is how we ensure every deployment is visible to the entire team.

### Slack Integration for Pipeline Events

```typescript
// scripts/pipeline-notifications.ts

interface DeploymentNotification {
  service: string;
  environment: string;
  version: string;
  commitSha: string;
  commitMessage: string;
  author: string;
  pipelineDuration: string;
  testResults: {
    unit: { passed: number; failed: number; coverage: number };
    integration: { passed: number; failed: number };
    security: { vulnerabilities: number; secrets: number };
  };
  status: 'success' | 'failure' | 'rollback';
}

function formatSlackMessage(notification: DeploymentNotification): object {
  const statusEmoji = {
    success: ':white_check_mark:',
    failure: ':x:',
    rollback: ':rotating_light:',
  };

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${statusEmoji[notification.status]} Deploy: ${notification.service} → ${notification.environment}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Version:*\n\`${notification.version.slice(0, 12)}\`` },
          { type: 'mrkdwn', text: `*Author:*\n${notification.author}` },
          { type: 'mrkdwn', text: `*Duration:*\n${notification.pipelineDuration}` },
          { type: 'mrkdwn', text: `*Environment:*\n${notification.environment}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Commit:*\n${notification.commitMessage}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Tests:* ${notification.testResults.unit.passed} unit ` +
              `(${notification.testResults.unit.coverage}% coverage), ` +
              `${notification.testResults.integration.passed} integration`,
            `*Security:* ${notification.testResults.security.vulnerabilities} vulnerabilities, ` +
              `${notification.testResults.security.secrets} secrets detected`,
          ].join('\n'),
        },
      },
    ],
  };
}
```

### Deployment Dashboard Metrics

Beyond Slack, we track pipeline health metrics in Grafana:

```typescript
// metrics/pipeline-metrics.ts

const pipelineMetrics = {
  // How long from push to production?
  leadTime: {
    query: 'deployment_lead_time_seconds',
    target: '< 900',           // Under 15 minutes
    description: 'Time from commit push to production deploy',
  },

  // How often do we deploy?
  deployFrequency: {
    query: 'deployments_total',
    target: '> 5 per day',
    description: 'Number of production deployments per day',
  },

  // How often do deploys fail?
  changeFailureRate: {
    query: 'deployment_failures_total / deployments_total * 100',
    target: '< 5%',
    description: 'Percentage of deployments that cause an incident',
  },

  // How fast do we recover from failures?
  mttr: {
    query: 'mean_time_to_recovery_seconds',
    target: '< 300',           // Under 5 minutes
    description: 'Mean time from incident detection to resolution',
  },

  // Pipeline-specific metrics
  pipelineDuration: {
    query: 'pipeline_duration_seconds',
    target: '< 600',           // Under 10 minutes
    description: 'Total time for the full CI/CD pipeline',
  },

  flakyTestRate: {
    query: 'flaky_test_failures_total / test_runs_total * 100',
    target: '< 1%',
    description: 'Percentage of test runs that fail due to flaky tests',
  },
};
```

These are the **DORA metrics** (DevOps Research and Assessment) -- the four key indicators that correlate with software delivery performance:

1. **Lead time**: How long from commit to production. Elite teams: under 1 hour. We target 15 minutes.
2. **Deploy frequency**: How often you deploy. Elite teams: multiple times per day. We deploy 5+ times daily across all services.
3. **Change failure rate**: What percentage of deploys cause incidents. Elite teams: under 15%. We target under 5%.
4. **Mean time to recovery (MTTR)**: How fast you recover from a failure. Elite teams: under 1 hour. With automatic rollback, we target under 5 minutes.

> **What If You Skip This?** Without pipeline metrics, you have no idea if your CI/CD system is helping or hindering. "It feels slow" is not actionable. "Lead time increased from 8 minutes to 23 minutes over the last month because integration tests added 15 minutes" is actionable. Measure your pipeline like you measure your application.

---

## Environment Promotion: Dev to Staging to Production

Code flows through three environments before reaching real users. Each environment has a specific purpose, different data, and different permission levels.

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   DEVELOPMENT   │───>│    STAGING       │───>│   PRODUCTION    │
│                 │    │                 │    │                 │
│ Every push to   │    │ Every merge to  │    │ Manual trigger  │
│ feature branch  │    │ main (auto)     │    │ after staging   │
│                 │    │                 │    │ validation      │
│ Synthetic data  │    │ Anonymized      │    │ Real customer   │
│ 1 replica       │    │ production data │    │ data            │
│ Relaxed limits  │    │ 3 replicas      │    │ 20 replicas     │
│                 │    │ Same K8s config │    │ Full HA config  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Environment-Specific Configuration

```yaml
# helm/booking-service/values-development.yaml
replicaCount: 1
resources:
  requests:
    cpu: 250m
    memory: 512Mi
  limits:
    cpu: 500m
    memory: 1Gi
autoscaling:
  enabled: false
env:
  LOG_LEVEL: debug
  ENABLE_SWAGGER: "true"
  RATE_LIMIT_ENABLED: "false"

---
# helm/booking-service/values-staging.yaml
replicaCount: 3
resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 1000m
    memory: 2Gi
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
env:
  LOG_LEVEL: info
  ENABLE_SWAGGER: "true"
  RATE_LIMIT_ENABLED: "true"

---
# helm/booking-service/values-production.yaml
replicaCount: 20
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
env:
  LOG_LEVEL: warn
  ENABLE_SWAGGER: "false"
  RATE_LIMIT_ENABLED: "true"
```

Notice the differences:

- **Development** runs a single replica with minimal resources. Swagger is enabled for API exploration. Rate limiting is off so you can hammer the API during development. Log level is `debug` for maximum visibility.
- **Staging** mimics production configuration but at smaller scale (3 replicas instead of 20). Swagger is still enabled for QA testing. Rate limiting is on to catch issues that only appear with rate limits.
- **Production** runs at full scale. Swagger is disabled (you do not want external users discovering your API documentation endpoint). Log level is `warn` to reduce log volume and cost. Rate limiting is enforced.

> **Common Mistake:** Teams make staging identical to development instead of identical to production. Then features work in staging but break in production because the configuration is different. Staging should mirror production in everything except scale and data. Same environment variables, same health checks, same security settings, same rate limits. The only difference should be the number of replicas and the size of the database.

---

## Production War Stories

These are real incidents (anonymized) that shaped the CI/CD practices described in this chapter. Each one taught a lesson that became a pipeline rule.

### War Story 1: The Deploy That Wiped the Cache

A developer changed the Redis key format from `booking:{id}` to `bookings:v2:{id}`. The code change was deployed to production with a rolling update. For 8 minutes, old pods looked for `booking:{id}` while new pods wrote to `bookings:v2:{id}`. Neither version could find the other's data. Cache hit rate dropped from 94% to 0%. All requests hit the database. The database could not handle the load. Response times exceeded 30 seconds. Bookings failed.

**The lesson**: Key format changes require a phased rollout. Deploy 1: read from both old and new key formats. Deploy 2: write to new format only. Deploy 3: remove old format reads. This is the same pattern as database column renames.

**The pipeline fix**: We added integration tests that verify backward compatibility of cache keys. If a test writes a value with the current code and reads it with the previous release's code, any format change is caught.

### War Story 2: The Rollback That Failed

A deploy introduced a database migration that added a new column. The code used this column. When the deploy showed errors and the team rolled back the code, the old code did not handle the new column and crashed with `Unknown column` errors. They could not roll back the migration either because the new column already had data.

**The lesson**: Migrations must be backward-compatible. The old code must work with the new schema. This is Migration Safety Rule number 6 from our list above.

**The pipeline fix**: We added a CI check that deploys the new migration against a test database, then runs the *previous version's* test suite against it. If the old tests pass with the new schema, the migration is backward-compatible.

### War Story 3: The Secret That Leaked

An engineer debugging a production issue added `console.log(process.env)` to print environment variables. This was meant for local debugging but accidentally made it into a PR. The PR was merged (the reviewer missed it). The log output -- containing database passwords, API keys, and JWT secrets -- was shipped to Datadog, where it was visible to the entire engineering team.

**The lesson**: Never log environment variables. The `no-console` ESLint rule prevents `console.log` in production code, but `process.env` access is a separate concern.

**The pipeline fix**: We added a Semgrep rule that flags any access to `process.env` outside the configuration module. All environment variable access must go through the `ConfigService`, which redacts sensitive values from logs.

---

## Common Mistakes and Anti-Patterns

Here is a condensed list of the most frequent CI/CD mistakes I see teams make, and how to avoid each one.

| Mistake | Why It Is Dangerous | What To Do Instead |
|---------|--------------------|--------------------|
| No path filtering in monorepo | Every push triggers all pipelines; wastes CI minutes | Use `paths:` in GitHub Actions to scope pipelines per service |
| Using `npm install` in CI | Non-deterministic; might install different versions | Always use `npm ci` for deterministic, lockfile-based installs |
| No timeout on CI jobs | A stuck test runs for 6 hours, consuming your CI budget | Set `timeout-minutes` on every job |
| Storing secrets in Git | Anyone who clones the repo has your production passwords | Use Vault, Sealed Secrets, or external secrets managers |
| No image scanning | Vulnerabilities in base OS packages reach production | Scan every image with Trivy before pushing to the registry |
| Manual production deploys via SSH | No audit trail, no rollback, no consistency | Automate through CI/CD with mandatory quality gates |
| Identical dev and staging configs | Bugs that only appear with production settings slip through | Make staging mirror production (same env vars, same limits) |
| No rollback plan | Rolling back requires "figuring it out" under pressure | Document and test rollback for every deployment |
| Not monitoring the pipeline | Slow pipelines go unnoticed until developers stop running them | Track DORA metrics; alert on pipeline duration regressions |
| Feature branches that live for weeks | Merge conflicts, integration pain, "big bang" deploys | Trunk-based development with short-lived branches (hours) |
| Testing only happy paths | Edge cases and error conditions are untested | Require both success and failure test cases in CI |
| Skipping security scans "just this once" | That one time creates the vulnerability that gets exploited | Make security scans non-skippable; no exceptions |

> **Common Mistake:** The most insidious anti-pattern is the "works on my machine" deploy. A developer runs `npm run build` on their laptop, copies the artifact to the server, and it works. But it only works because the developer has Node 20.11.0, macOS, and a specific set of environment variables. In CI/CD, the build runs in a clean container with explicit dependencies. If it works in CI, it works everywhere. "Works on my machine" is not a deployment strategy.

---

## The Full Pipeline in Action

Here is the complete timeline of a deployment, from a developer's keyboard to serving real traffic:

```
09:00  Developer pushes commit a1b2c3d to feature branch
09:00  GitHub Actions detects the push; pipeline begins

09:00  [JOB 1: Lint]          Running in parallel...
09:00  [JOB 2: Unit Tests]    Running in parallel...
09:00  [JOB 3: Integration]   Running in parallel...
09:00  [JOB 4: Security]      Running in parallel...

09:02  Lint passes (ESLint clean, Prettier formatted, TypeScript compiles)
09:03  Unit tests pass (847 tests, 94.2% coverage, 28 seconds)
09:05  Integration tests pass (124 tests, real DB/Redis/Kafka, 3 minutes)
09:04  Security scan clean (0 high/critical vulns, 0 leaked secrets)

09:05  All 4 jobs passed. Developer opens Pull Request.
09:10  Code review completed. PR merged to main.

09:10  Pipeline triggers again on main branch.
09:10  [JOBS 1-4 re-run and pass]
09:15  [JOB 5: Docker Build]  Multi-stage build starts
09:16    Image built (cache hit on dependencies: 12 seconds)
09:16    Image pushed to ECR
09:17    Trivy scan: 0 critical/high vulnerabilities
09:17    Image signed with Cosign
09:17  [JOB 5 passes]

09:17  [JOB 6: Update Manifests]
09:17    Deployment repo PR created with new image tag
09:18    Auto-merged (staging environment)

09:18  ArgoCD detects change in deployment repo
09:18  ArgoCD begins sync to staging cluster
09:19  Rolling update: new pods start, pass readiness probes
09:20  Staging deployment complete

09:20  [E2E Tests] triggered against staging
09:28  E2E tests pass (42 tests, 8 minutes)

09:28  All gates passed. Deployment PR for production created.
09:45  Tech lead reviews and approves production PR
09:45  ArgoCD syncs production cluster

09:45  Canary deployment begins (5% traffic)
10:00  Canary metrics healthy. Promoting to 25%.
10:15  Still healthy. Promoting to 50%.
10:30  Still healthy. Promoting to 100%.
11:00  Stable version updated. Deployment complete.

Total: ~2 hours from push to full production rollout.
Actual human involvement: ~15 minutes (code review + production approval).
```

> **Checkpoint:** Can you trace the path of a single line of code from a developer's editor to serving real traffic? Can you name every quality gate it passes through? Can you explain at which point an automatic rollback would trigger and what happens to user traffic? If you can walk through the entire flow without referring to this diagram, you have internalized CI/CD at a production level.

---

## Chapter 37 Summary

| Concept | One-Sentence Summary |
|---------|---------------------|
| CI (Continuous Integration) | Automatically build, lint, and test code on every push to catch bugs within minutes. |
| CD (Continuous Deployment) | Automatically deploy passing code through staging and production with quality gates at each stage. |
| Trunk-based development | Use short-lived feature branches (hours, not weeks) to enable frequent, low-risk deployments. |
| GitHub Actions workflow | A YAML-defined pipeline with parallel jobs for linting, testing, security scanning, and Docker building. |
| Docker multi-stage builds | Three stages (deps, builder, production) for small, secure images with aggressive layer caching. |
| Database migrations | Use `prisma migrate deploy` in CI/CD with retry logic, lock timeouts, and mandatory rollback plans. |
| Blue-green deployment | Run new and old versions simultaneously; switch traffic instantly; rollback in seconds. |
| Canary deployment | Gradually increase traffic to the new version (5% to 25% to 50% to 100%) while monitoring metrics. |
| Feature flags | Deploy code without exposing features; toggle at runtime; enable percentage-based rollouts. |
| GitOps with ArgoCD | Git is the source of truth for cluster state; ArgoCD reconciles desired vs. actual continuously. |
| Security scanning | Four layers: npm audit, Snyk, TruffleHog (secrets), and Semgrep (SAST) catch different vulnerability types. |
| Secret management | Use Vault for dynamic, lease-based secrets and Sealed Secrets for encrypted Kubernetes secrets in Git. |
| Automatic rollback | Monitor error rates and p99 latency post-deploy; auto-rollback after 3 consecutive threshold breaches. |
| DORA metrics | Track lead time, deploy frequency, change failure rate, and MTTR to measure pipeline health. |
| Environment promotion | Dev (synthetic data, 1 replica) to staging (anonymized data, production config) to production (full scale). |
| Pipeline notifications | Alert on every deploy via Slack; include test results, coverage, security scan status, and author. |
