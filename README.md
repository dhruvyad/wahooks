# WAHooks

Open-source platform for deploying cloud-hosted [WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API) instances with managed webhooks and usage-based billing.

Connect a WhatsApp number, configure webhook endpoints, and receive real-time events — without managing infrastructure.

## Architecture

```
Browser ──► Next.js Dashboard (Vercel)
                │
                ▼
            NestJS API ◄──── Stripe (billing webhooks)
            │       │
     ┌──────┘       └──────┐
     ▼                      ▼
  Supabase               k3s Cluster (Hetzner Cloud)
  (Postgres + Auth)      ├── WAHA StatefulSet (autoscaled 1–10 nodes)
                         ├── Redis (BullMQ)
                         └── Cluster Autoscaler
                                │
                                ▼
                         Customer Webhook
                         Endpoints (HMAC-signed)
```

| Component | Tech | Hosting |
|-----------|------|---------|
| Dashboard | Next.js 15, React 19, Tailwind CSS 4, shadcn/ui | Vercel |
| API | NestJS 11, TypeScript | k3s on Hetzner Cloud |
| WhatsApp Engine | WAHA Plus (NOWEB engine) | k3s StatefulSet, autoscaled |
| Database + Auth | Supabase (Postgres + Auth + JWTs) | Supabase Cloud |
| Message Queue | BullMQ + Redis 7 | k3s Deployment |
| Billing | Stripe usage-based metering | Stripe |
| Infrastructure | Terraform + kube-hetzner module | Hetzner Cloud |
| Monorepo | Turborepo + pnpm workspaces | — |

## Project Structure

```
wahooks/
├── apps/
│   ├── api/              NestJS API server (port 3001)
│   │   └── src/
│   │       ├── auth/           Supabase JWT guard + user decorator
│   │       ├── billing/        Stripe checkout, portal, usage metering
│   │       ├── connections/    WhatsApp connection CRUD + QR code flow
│   │       ├── database/       Drizzle ORM provider (global module)
│   │       ├── events/         WAHA event ingestion + webhook delivery queue
│   │       ├── health/         Cron-based health polling + scaling checks
│   │       ├── orchestration/  K8s / Hetzner / Mock orchestrator interface
│   │       ├── waha/           WAHA REST API client
│   │       ├── webhooks/       Webhook config CRUD + delivery logs
│   │       └── workers/        Worker pool management + autoscaling
│   └── web/              Next.js dashboard (port 3000)
├── packages/
│   ├── db/               Drizzle ORM schema + migrations (Supabase Postgres)
│   ├── shared-types/     TypeScript domain types
│   └── config/           Shared ESLint + TypeScript configs
├── terraform/            Declarative k3s cluster provisioning
│   └── extra-manifests/  K8s manifests (StatefulSet, RBAC, Redis, secrets)
├── k8s/                  Reference k8s manifests + migration docs
└── scripts/              E2E test scripts
```

## Getting Started

### Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/) 9+
- A [Supabase](https://supabase.com/) project (Postgres + Auth)
- Docker (for local WAHA testing)

### Local Development

```bash
# Install dependencies
pnpm install

# Copy env files and fill in values
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# Push schema to DB (dev only)
pnpm db:push

# Start all apps (API on :3001, Web on :3000)
pnpm dev
```

### Database

```bash
pnpm db:generate    # Generate migrations after schema changes
pnpm db:migrate     # Run migrations
pnpm db:push        # Push schema directly (dev only)
pnpm db:studio      # Open Drizzle Studio
```

### Tests

```bash
# API unit tests
pnpm test

# E2E test against a running API
./scripts/e2e-test.sh http://localhost:3001
./scripts/e2e-test.sh https://api.wahooks.com --no-scan
```

## Deployment

Infrastructure is fully declarative via Terraform using the [kube-hetzner](https://github.com/kube-hetzner/terraform-hcloud-kube-hetzner) module. One `terraform apply` provisions the k3s cluster, configures the autoscaler, and deploys all application manifests.

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars
# Fill in secrets

terraform init
terraform plan
terraform apply
```

The Terraform config provisions:
- **3-node HA control plane** (CX22) with embedded etcd
- **Autoscaling 1–10 CX23 worker nodes** for WAHA pods via Kubernetes Cluster Autoscaler
- **All k8s resources**: WAHA StatefulSet, API Deployment, Redis, RBAC, secrets

See [k8s/README.md](k8s/README.md) for full deployment instructions and prerequisites.

### CI/CD

GitHub Actions (`.github/workflows/deploy-api.yml`):
1. Build + push API Docker image to GHCR
2. Run Drizzle migrations against production DB
3. Rolling update via `kubectl set image`

## API

All routes prefixed with `/api`. Auth via Supabase JWT in `Authorization: Bearer` header.

### Connections

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/connections` | Yes | List user's connections |
| `POST` | `/api/connections` | Yes | Create connection (provisions WAHA session) |
| `GET` | `/api/connections/:id` | Yes | Get connection detail |
| `GET` | `/api/connections/:id/qr` | Yes | Get QR code for WhatsApp linking |
| `GET` | `/api/connections/:id/chats` | Yes | Get recent WhatsApp chats |
| `GET` | `/api/connections/:id/me` | Yes | Get WhatsApp profile info |
| `POST` | `/api/connections/:id/restart` | Yes | Restart WAHA session |
| `DELETE` | `/api/connections/:id` | Yes | Stop and remove connection |

### Webhooks

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/connections/:cid/webhooks` | Yes | List webhook configs |
| `POST` | `/api/connections/:cid/webhooks` | Yes | Create webhook config |
| `PUT` | `/api/webhooks/:id` | Yes | Update webhook config |
| `DELETE` | `/api/webhooks/:id` | Yes | Delete webhook config |
| `GET` | `/api/webhooks/:id/logs` | Yes | Get delivery logs (last 100) |

### Billing

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/billing/status` | Yes | Billing status + usage |
| `POST` | `/api/billing/checkout` | Yes | Stripe Checkout session |
| `POST` | `/api/billing/portal` | Yes | Stripe Customer Portal |

### Internal

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api` | No | Health check |
| `POST` | `/api/events/waha` | No | WAHA event ingestion (from workers) |
| `POST` | `/api/stripe/webhook` | Stripe sig | Stripe webhook receiver |

## Key Design Decisions

- **WAHA Plus with NOWEB engine** — multi-session support, ~50 sessions per node, Postgres session persistence across pod restarts
- **Kubernetes StatefulSet** — stable pod identity (`waha-0`, `waha-1`, ...) with per-pod DNS via headless Service for sticky session routing
- **Cluster Autoscaler** — provisions/drains Hetzner worker nodes based on pod scheduling pressure, with 10-minute cooldowns
- **Scale-down safety** — always drains highest-ordinal pod first (k8s StatefulSet ordering), with session migration before removal
- **Webhook delivery** — BullMQ with 5 retries, exponential backoff, HMAC-SHA256 signing (`X-WAHooks-Signature`), dead letter queue for failed jobs
- **Usage-based billing** — $0.25/connection/month, hourly metering via Stripe

## Environment Variables

See [`apps/api/.env.example`](apps/api/.env.example) for the full list. Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase Postgres connection string |
| `SUPABASE_URL` | Supabase project URL (JWT verification via JWKS) |
| `ORCHESTRATOR` | `k8s` (production), `hetzner` (legacy), `mock` (dev) |
| `WAHA_API_KEY` | Shared WAHA API key for all pods |
| `REDIS_URL` | Redis connection string for BullMQ |
| `STRIPE_SECRET_KEY` | Stripe secret API key |
| `STRIPE_PRICE_ID` | Stripe metered price ID |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

## License

[MIT](LICENSE)
