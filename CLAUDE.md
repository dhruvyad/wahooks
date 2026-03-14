# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAHooks is a SaaS platform that lets users deploy cloud-hosted WAHA (WhatsApp HTTP API) instances and configure webhooks through a managed interface. All 5 implementation phases are complete: scaffolding, auth + core API, WAHA orchestration, event routing, and billing.

## Monorepo Structure

```
wahooks/
  apps/
    api/          -- NestJS API server (port 3001)
    web/          -- Next.js + Tailwind CSS dashboard (port 3000)
  packages/
    config/       -- Shared ESLint + TypeScript configs
    shared-types/ -- Domain types shared across apps
    db/           -- Drizzle ORM schema + migrations (Supabase Postgres)
  turbo.json
  pnpm-workspace.yaml
```

## Commands

- `pnpm install` -- install all dependencies
- `pnpm build` -- build all packages (via Turborepo)
- `pnpm dev` -- start all apps in dev mode
- `pnpm lint` -- lint all packages
- `pnpm --filter @wahooks/api dev` -- run only the API
- `pnpm --filter @wahooks/web dev` -- run only the web app
- `pnpm --filter @wahooks/api test` -- run API tests (Jest)
- `pnpm --filter @wahooks/db db:generate` -- generate Drizzle migrations
- `pnpm --filter @wahooks/db db:migrate` -- run Drizzle migrations
- `pnpm --filter @wahooks/db db:push` -- push schema to DB (dev only)

## Module Summary

### API (`apps/api/src/`)

| Module | Purpose |
|--------|---------|
| `auth/` | Supabase JWT verification guard (`AuthGuard`) + `@CurrentUser()` decorator |
| `database/` | Global Drizzle ORM provider (`DRIZZLE_TOKEN`) connected to Supabase Postgres |
| `connections/` | CRUD for WhatsApp connections; provisions WAHA sessions on workers, QR code flow |
| `workers/` | Worker pool management: find/provision workers, assign/unassign sessions, auto-scaling (80% up, 30% down) |
| `orchestration/` | `ContainerOrchestrator` interface + K8s (prod) / Hetzner (legacy) / Mock (dev) implementations. Lazy factory — only selected orchestrator is instantiated. |
| `waha/` | HTTP client for the WAHA REST API (sessions, QR codes, start/stop/restart) |
| `health/` | Cron jobs: 1-min worker health poll (syncs WAHA status to DB, auto-restarts failed sessions), 5-min scaling check |
| `webhooks/` | Webhook config CRUD (url, events filter, signing secret) + event log queries |
| `events/` | WAHA event ingestion endpoint + BullMQ `webhook-delivery` queue + delivery processor with HMAC-SHA256 signing |
| `billing/` | Stripe checkout/portal, hourly usage metering (`UsageService` cron), Stripe webhook handler |

### Web (`apps/web/src/`)
Next.js 15 app router with Supabase Auth SSR integration and Tailwind CSS.

### Packages
- `@wahooks/db` -- Drizzle schema: `users`, `waha_workers`, `waha_sessions`, `webhook_configs`, `webhook_event_logs`, `usage_records`
- `@wahooks/shared-types` -- TypeScript domain types shared between apps
- `@wahooks/config` -- Shared ESLint + TypeScript config

## Key API Endpoints

All routes prefixed with `/api`. Auth = Supabase JWT in `Authorization: Bearer` header.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api` | No | Health check |
| `GET` | `/api/connections` | Yes | List user's connections |
| `POST` | `/api/connections` | Yes | Create connection (provisions WAHA session) |
| `GET` | `/api/connections/:id` | Yes | Get connection detail |
| `GET` | `/api/connections/:id/qr` | Yes | Get QR code for WhatsApp linking |
| `GET` | `/api/connections/:id/chats` | Yes | Get recent WhatsApp chats (max 20) |
| `GET` | `/api/connections/:id/me` | Yes | Get WhatsApp profile info |
| `POST` | `/api/connections/:id/restart` | Yes | Restart WAHA session |
| `DELETE` | `/api/connections/:id` | Yes | Stop and remove connection |
| `GET` | `/api/connections/:cid/webhooks` | Yes | List webhook configs |
| `POST` | `/api/connections/:cid/webhooks` | Yes | Create webhook config |
| `PUT` | `/api/webhooks/:id` | Yes | Update webhook config |
| `DELETE` | `/api/webhooks/:id` | Yes | Delete webhook config |
| `GET` | `/api/webhooks/:id/logs` | Yes | Get delivery logs (last 100) |
| `POST` | `/api/events/waha` | No | WAHA event ingestion (internal) |
| `GET` | `/api/billing/status` | Yes | Billing status + usage |
| `GET` | `/api/billing/usage` | Yes | Usage summary |
| `POST` | `/api/billing/checkout` | Yes | Stripe Checkout session |
| `POST` | `/api/billing/portal` | Yes | Stripe Customer Portal |
| `POST` | `/api/stripe/webhook` | Stripe sig | Stripe webhook receiver |

## Architecture

1. **Dashboard (Next.js)** -- manages connections, webhook configs, usage/billing (Vercel)
2. **API Server (NestJS)** -- Kubernetes Deployment, validates Supabase JWTs, CRUD operations, proxies to WAHA pods. Stateless — rolling updates on every push to main via CI/CD.
3. **Orchestration Layer** -- `K8sOrchestrator` scales WAHA StatefulSet replicas via Kubernetes API. Also supports `HetznerOrchestrator` (legacy) and `MockOrchestrator` (dev). Selected via `ORCHESTRATOR` env var.
4. **WAHA Workers** -- StatefulSet pods running `devlikeapro/waha` (WAHA Core, 1 session per pod). Accessible only within the cluster via headless service. Session name always `default` in Core mode.
5. **Event Router (BullMQ)** -- ingests WAHA webhook POSTs, fans out to customer endpoints with HMAC-SHA256 signing, exponential backoff (5 attempts), failed jobs retained as DLQ
6. **Supabase** -- Postgres (app data + WAHA session persistence) + Auth (JWT). Accessed via socat IPv4→IPv6 proxy (Supabase has IPv6-only DNS).
7. **Stripe** -- usage-based billing, connection-hours metered hourly (not yet configured)

## Conventions

### Commit Messages
Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`, `style:`

### Code Style
- TypeScript strict mode everywhere
- NestJS app uses CommonJS (required for `emitDecoratorMetadata`)
- `packages/db` and `packages/shared-types` use Node16 module resolution
- Next.js app uses bundler module resolution
- `.js` extensions in relative imports for Node16 packages
- No default exports (except Next.js pages/layouts)

### Naming
- Session names: `u_{userId}_s_{sessionId}` format for tenant isolation
- Database columns: snake_case
- TypeScript: camelCase for variables/functions, PascalCase for types/classes

## Technology Stack

| Area | Decision |
|------|----------|
| WAHA Edition | WAHA Core (free, 1 session/pod) — upgrade to Plus (~50 sessions/pod) when ready |
| API Framework | TypeScript + NestJS |
| Frontend | Next.js + React + Tailwind CSS + shadcn/ui |
| Database + Auth | Supabase (Postgres + Auth) + Drizzle ORM |
| Container Orchestration | Kubernetes (k3s on Hetzner Cloud via kube-hetzner Terraform module) |
| Message Queue | BullMQ + Redis (in-cluster Deployment) |
| Billing | Stripe — pure usage-based, monthly billing ($0.99/connection/month). Not yet configured. |
| Repo | Turborepo + pnpm workspaces |
| CI/CD | GitHub Actions: build Docker image → run migrations in-cluster → rolling deploy |
| Deployment | Hetzner k3s cluster (API + Redis + WAHA), Vercel (web), Supabase (DB+Auth) |
| CLI | Go CLI (`cli/`) — Cobra-based, manages connections, runs E2E tests |

## Database Schema

Tables in `packages/db/src/schema/`:
- **users** -- synced from Supabase Auth, has `stripe_customer_id`
- **waha_workers** -- k8s pods: `pod_name`, `internal_ip`, `api_key_enc` (encrypted), `status`, `max_sessions`, `current_sessions`
- **waha_sessions** -- user-to-worker mapping: `session_name`, `phone_number`, `status`, `engine`
- **webhook_configs** -- per-session webhook: `url`, `events[]`, `signing_secret`, `active`
- **webhook_event_logs** -- delivery tracking: `event_type`, `payload` (JSONB), `status`, `attempts`
- **usage_records** -- hourly connection-hour buckets: `session_id`, `period_start`, `period_end`, `connection_hours`, `reported_to_stripe`

## Key Design Details

- WAHA pods accessible only within the k3s cluster via headless service; API proxies all calls
- All WAHA pods share a single `WAHA_API_KEY` (stored encrypted in DB, injected via k8s Secret)
- WAHA session auth state persisted in Supabase Postgres (survives pod replacement)
- Health monitoring: 1-min cron polls WAHA sessions, auto-restarts failed/stopped sessions
- Scale up: only when NO worker has available capacity AND pending sessions exist. Scale down: all workers <30% for sustained period (never to zero)
- WAHA Core mode: `WAHA_MAX_SESSIONS=1`, session name always resolves to `default`
- Outbound webhooks signed with HMAC-SHA256 (`X-WAHooks-Signature` header)
- Webhook delivery: BullMQ with 5 attempts, exponential backoff (5s base), last 1000 failed jobs retained
- Usage metering: hourly cron records connection-hours, separate cron reports to Stripe
- Supabase DB connectivity: socat DaemonSet bridges IPv4→IPv6 (Supabase has IPv6-only DNS, k3s pods can't route IPv6)

## Production Deployment

| Component | URL / Location | Infrastructure |
|-----------|----------------|----------------|
| Dashboard | `https://wahooks.com` | Vercel (project: `noclick/wahooks`) |
| API | `https://api.wahooks.com` | k3s Deployment (Hetzner CX23 control-plane node) |
| WAHA Workers | Cluster-internal only | k3s StatefulSet (Hetzner autoscaled worker nodes, 1-10) |
| Redis | `redis.default.svc.cluster.local:6379` | k3s Deployment |
| Database | `db.fvatjlbtyegsqjuwbxxx.supabase.co` | Supabase Postgres (via socat IPv4→IPv6 proxy) |
| Ingress | Hetzner Load Balancer → Traefik | TLS via cert-manager + Let's Encrypt |

### Kubernetes Cluster
- Provisioned by Terraform (`terraform/`) using kube-hetzner module v2.15.3
- k3s with Flannel CNI, Traefik ingress, cert-manager, metrics-server
- 1 control-plane node (CX23, Nuremberg) — runs API + Redis
- 1-10 autoscaled worker nodes (CX23) — run WAHA pods
- Kubeconfig: `terraform/wahooks_kubeconfig.yaml` (gitignored)
- See `terraform/README.md` for full setup and `terraform.tfvars` template

### CI/CD Pipeline
GitHub Actions (`.github/workflows/deploy-api.yml`) — triggers on push to `main` touching `apps/api/`, `packages/db/`, or `packages/shared-types/`:

1. **Build**: Docker image pushed to GHCR (`:latest` + `:sha` tags)
2. **Migrate**: Drizzle migrations run in-cluster via `kubectl run` pod (reads DATABASE_URL from k8s secret, routes through socat proxy)
3. **Deploy**: `kubectl set image` triggers rolling update — new pod starts, health check passes, old pod terminates. Zero downtime.

Required GitHub Actions secrets:
- `DEPLOY_KUBECONFIG`: base64-encoded kubeconfig

### Web Deployment
- Auto-deploys from GitHub via Vercel, or manually: `vercel --prod`

### Known Issues / Notes
- WAHA Core mode (`WAHA_MAX_SESSIONS=1`) uses session name `default` regardless of DB session name
- List connections endpoint filters out `stopped` connections (soft-deleted)
- GHCR packages are private by default even for public repos — `ghcr-secret` k8s Secret required
- Traefik pinned to v27.0.2 (v28+ broke schema)
- Stripe billing not yet configured — `StripeService` boots with placeholder key

## CLI (`cli/`)

Go CLI built with Cobra. Config persisted at `~/.wahooks.json`.

```bash
cd cli && go build -o wahooks .

# Setup
wahooks config api-url https://api.wahooks.com
wahooks login $E2E_TEST_EMAIL -p $E2E_TEST_PASSWORD
wahooks status

# Connection management
wahooks connections list
wahooks connections create
wahooks connections qr <id> --poll
wahooks connections me <id>
wahooks connections chats <id>
wahooks connections restart <id>
wahooks connections delete <id>

# E2E test (all endpoints)
wahooks connections e2e --no-scan
```

## E2E Testing

### Test Account
- Set `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` env vars (see `.env.secrets`)
- Created in Supabase Auth, email confirmed

### What the E2E Tests
1. Health check (`GET /api`)
2. Auth guard (no token → 401)
3. List connections
4. Create connection
5. Fetch QR code (polls until worker boots)
6. Profile endpoint
7. Chats endpoint
8. Restart connection
9. Delete connection
10. Verify cleanup (list should exclude stopped)
