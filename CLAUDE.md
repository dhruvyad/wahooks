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
  gateway/        -- Go WhatsApp gateway (whatsmeow), WAHA-compatible API; build with gateway/build.sh (applies whatsmeow-patches/)
  migrate/        -- Go converter: WAHA NOWEB auth state -> whatsmeow store (no re-scan)
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
| `auth/` | Supabase JWT verification guard (`AuthGuard`) + `@CurrentUser()` decorator. Rate limits (`caller-throttler.guard.ts`, per route per minute): `default` 60 per caller (bearer-token hash, else IP) and connection (`:connectionId`/`:id`), `caller` 1,000 per caller; `@SkipThrottle(NO_RATE_LIMIT)` skips both (health, events, Stripe) |
| `database/` | Global Drizzle ORM provider (`DRIZZLE_TOKEN`) connected to Supabase Postgres |
| `connections/` | CRUD for WhatsApp connections; provisions WAHA sessions on workers, QR code flow |
| `workers/` | Worker pool management per worker kind (see Worker kinds): find/provision workers (a ready pod or box nobody registered is adopted first, matched by name or internal IP), assign/unassign sessions, auto-scaling (WAHA: 80% up, 30% down, scale-down only drains the highest-ordinal pod, to zero once new connections go to gateways; gateway: a box added at `GATEWAY_SCALE_UP_AT`, never removed automatically). A failing scale-up is logged as an ERROR and exposed as `scaleUpFailure` on `GET /api/infrastructure` and `checks.scaleUp` on `GET /api/health`. `GatewayResourcesService` adds `resources` (CPU from Hetzner metrics, memory from the box's `/metrics` RSS, connections from the row) to each active gateway there, cached ~60 s; servers are matched by private IP |
| `orchestration/` | `ContainerOrchestrator` interface, one per worker kind (`WORKER_ORCHESTRATORS_TOKEN`). WAHA: K8s (prod) / Hetzner (legacy) / Mock (dev) by `ORCHESTRATOR`, lazily. Gateway: `GatewayOrchestrator` (Hetzner Cloud boxes set up by cloud-init) only when its env is set, else none. |
| `waha/` | HTTP client for the WAHA REST API (sessions, QR codes, start/stop/restart). Every send shows seen → typing → delay first (`simulatePresence`) unless `skipPresence`; `TypingStateService` (Redis, the webhook queue's connection) credits typing a caller started via `POST /connections/:id/typing` toward that delay, only in chats that messaged the session in the last 24 h (`wahooks:inbound:*`, set on `message` events), keeps it alive every 10 s for up to 2 min, and clears it on stop-typing or any send |
| `health/` | Cron jobs: 3-min worker health poll (syncs WAHA status to DB; restarts a FAILED session from persisted auth up to 5× per pod lifetime, then STOPS it — auth kept, row `failed`; a FAILED gateway session the listing shows without `me` (logged out on the phone, or its QR codes ran out) is never restarted: row `failed` with `status_reason.reason` `logged_out`/`qr_expired` (returned as `failureReason`), then stopped; retires a session left in SCAN_QR_CODE after 30 min if it was ever linked, 2 h if never; an unreachable worker only gets its `pending` sessions created; on a gateway it never re-creates a session that was ever linked, deletes only sessions whose row is `stopped`, adds the events secret to live sessions' webhook config, and records reachability for `checks.gateways`), 5-min scaling check |
| `webhooks/` | Webhook config CRUD (url, events filter, signing secret) + event log queries |
| `events/` | WAHA event ingestion endpoint (with `EVENTS_SECRET` set, gateway sessions must send `X-WAHooks-Events-Secret` and a sent one must match) + BullMQ `webhook-delivery` queue + delivery processor with HMAC-SHA256 signing. `EventMetricsService` counts events received and delivery outcomes per minute in Redis for `GET /api/infrastructure/events` (see Key Design Details) |
| `billing/` | Stripe checkout/portal, hourly usage metering (`UsageService` cron), Stripe webhook handler |

### Web (`apps/web/src/`)
Next.js 15 app router with Supabase Auth SSR integration and Tailwind CSS.

### Packages
- `@wahooks/db` -- Drizzle schema: `users`, `waha_workers`, `waha_sessions`, `webhook_configs`, `webhook_event_logs`, `usage_records`
- `@wahooks/shared-types` -- TypeScript domain types shared between apps
- `@wahooks/config` -- Shared ESLint + TypeScript config

## Worker kinds

A `waha_workers` row is a WAHA pod (`kind = 'waha'`: StatefulSet `waha`, shared `WAHA_API_KEY`) or a gateway box
(`kind = 'gateway'`: the Go gateway in `gateway/`, WAHA-compatible API, thousands of accounts per box, its own API key,
all boxes sharing one Postgres store). The API talks to both the same way (`http://<internal_ip>:3000`, `X-Api-Key`).

- **Placement:** new connections go to the least-loaded active worker of kind `NEW_CONNECTION_WORKER_KIND` with
  `current_sessions < max_sessions`, else a new one of that kind is provisioned. A row with `max_sessions 0` is pinned
  (takes no new connections) and counts for neither load nor room in scaling.
- **WAHA scaling:** the rules above, over WAHA rows only; a WAHA pod is added only while new connections go to WAHA.
  **To zero:** with `NEW_CONNECTION_WORKER_KIND=gateway` and no non-stopped session on any WAHA worker, each scaling check
  drains the highest-ordinal pod, and the last one is removed too (`destroyWorker(…, { allowLast })`).
- **Gateway scaling:** a box is provisioned when gateway used/capacity ≥ `GATEWAY_SCALE_UP_AT` (or when there is no gateway
  room while new connections go to gateways). One provision per kind at a time. Boxes are never removed automatically:
  a drained, empty gateway row is only logged (delete the box by hand, then mark the row `stopped`).
- **GatewayOrchestrator:** creates an Ubuntu 24.04 server labelled `role=wagw`, named `wagw-<8 hex>` (also its
  `WAGW_BOX_ID`), on `GATEWAY_NETWORK_ID`, with `GATEWAY_FIREWALL_ID` / `GATEWAY_SSH_KEYS`, public IPv4 and IPv6. Its
  cloud-init (`orchestration/gateway-cloud-init.ts`) does what `gateway/deploy/install.sh` does: downloads
  `GATEWAY_BINARY_URL` and installs it only if it matches `GATEWAY_BINARY_SHA256`, installs `wagw.service` verbatim, reads
  the box's private IP and IPv6 /64 from Hetzner's metadata service, and writes `/etc/wagw/wagw.env` (0640 root:wagw).
  The key is random per box. The row is written as `provisioning` (with the key) as soon as the server exists, and
  becomes `active` once `/health` answers (~5 min timeout). A box that doesn't answer stays up for inspection and blocks
  new boxes until it answers or is deleted; the next scaling check adopts it when it comes up.
- **Health poll on a gateway:** a gateway's DELETE logs the account out (unlinks the device), so a session is deleted
  only if its `waha_sessions` row exists and is `stopped`; unknown names are logged, never deleted. A linked session
  missing from the box is not re-created (warned instead). With `EVENTS_SECRET` set, live sessions whose WAHooks webhook
  lacks the header get it through `PUT /api/sessions/{name}` (applied live, no restart), at boot and on every poll.
- **Events auth:** with `EVENTS_SECRET` set, `POST /api/events/waha` refuses (401) a gateway session's event without
  `X-WAHooks-Events-Secret`, and any event with a wrong one (constant-time compare). WAHA sessions are still accepted
  without it. The worker kind comes from an in-memory cache (60 s), not a query per event.
- **`GET /api/health`:** `checks.gateways` lists each active gateway and whether the last poll reached it (status
  `error`, and overall `degraded`, when one didn't; `unknown` before the first poll).

| Env | Default | Meaning |
|-----|---------|---------|
| `NEW_CONNECTION_WORKER_KIND` | `waha` | Where new connections go: `waha` or `gateway` |
| `GATEWAY_MAX_SESSIONS` | `5000` | `max_sessions` of a newly registered gateway row |
| `GATEWAY_SCALE_UP_AT` | `0.8` | Gateway used/capacity at which a box is added |
| `EVENTS_SECRET` | unset | Secret for `X-WAHooks-Events-Secret`; unset = no events auth (warned at boot) |
| `HETZNER_API_TOKEN` | — | Required for gateway provisioning (the legacy HetznerOrchestrator's name) |
| `GATEWAY_NETWORK_ID` | — | Required: the Hetzner network the API reaches boxes on |
| `GATEWAY_BINARY_URL` / `GATEWAY_BINARY_SHA256` | — | Required: https URL of the linux/amd64 gateway binary, and its SHA-256 |
| `GATEWAY_DB_URL` | — | Required: the boxes' shared store, `postgres://…?search_path=wagw&sslmode=require` |
| `GATEWAY_DB_MAX_CONNS` | `4` | `WAGW_DB_MAX_CONNS` per box |
| `GATEWAY_FIREWALL_ID` / `GATEWAY_SSH_KEYS` | none | Firewall ID; comma-separated SSH key names |
| `GATEWAY_SERVER_TYPE` / `GATEWAY_LOCATION` | `cx23` / `fsn1` | Server type and location |
| `GATEWAY_WEBHOOK_RESOLVE` | unset | Passed through as `WAGW_WEBHOOK_RESOLVE` |

Without the required gateway env no box is created (a partial set is logged as an error and disables it too); rows
registered by hand still work. Secrets and IDs go in `wahooks-api-secret`; the plain values are in
`k8s/api-deployment.yaml`.

### Testing gateway scaling

- **Unit:** `pnpm --filter @wahooks/api test -- workers gateway`. `gatewayScaleDecision` is a pure function, and the
  specs drive `checkScaling` with a small `GATEWAY_MAX_SESSIONS` (2/2 sessions → a box is provisioned).
- **Live, away from production:** use a separate Hetzner project (its own token, network and a scratch gateway store) and
  run the API on a server attached to that network (it must reach the boxes' private IPs on :3000), against a scratch
  database, with `ORCHESTRATOR=mock`, `NEW_CONNECTION_WORKER_KIND=gateway` and `GATEWAY_MAX_SESSIONS=1`. The first scaling
  check (or `POST /api/connections`) provisions box 1 (cap 1); once a connection holds it, the next scaling check
  (every 5 min) provisions box 2. Watch `GET /api/infrastructure` (rows go `provisioning` → `active`)
  and `GET /api/health` (`checks.gateways`, `checks.scaleUp`). Delete the boxes (label `role=wagw`) afterwards.

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
| `GET` | `/api/infrastructure` | Admin | Workers, capacity, gateway utilization, webhook queue counts (`failed` stops at `failedKept`; `failedLast24h` from the event counters) |
| `GET` | `/api/infrastructure/events?range=1h\|24h\|7d` | Admin | Events received + webhook deliveries over time: buckets `{t, received, messages, delivered, failed, retried}` (1 min / 5 min / 1 h), totals, `ratePerMinute`, `byType` |
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
- **waha_workers** -- WAHA pods and gateway boxes: `pod_name`, `internal_ip`, `api_key_enc` (encrypted), `status`, `kind` (`waha` | `gateway`), `max_sessions`, `current_sessions`
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
- Webhook delivery: BullMQ with 5 attempts, exponential backoff (5s base), last 1000 failed jobs retained; a webhook whose every delivery fails all retries for 3 days is paused (`active` false, `paused_reason` 'failing'; `failing_since` starts at the first given-up delivery and any success clears it; resume via PUT active=true or re-registering the URL) (so the queue's failed count saturates at 1,000: a retention window, not a backlog)
- Event volume counters (`events/event-metrics.ts`): one Redis hash per UTC hour, `wahooks:events:<YYYY-MM-DDTHH>`, with `<mm>:<counter>` per minute and a `<counter>` hourly rollup (what the 7-day range reads), plus `<hash>:types` by event type; all expire 8 days after their last write. Counters: `received` (events accepted for a known connection), `messages` (`message` events), `delivered`, `failed` (final attempt), `retried`. One pipelined round trip per event or delivery attempt on the queue's Redis connection, fire-and-forget: a failure never fails ingestion or delivery and is logged at most once a minute
- Delivery log (`webhook_event_logs`): the processor writes a row when a delivery's first attempt ends (the id is fixed at enqueue), and `WebhookLogRetentionService` keeps the newest 100 per webhook (every 5 min for webhooks with new deliveries, daily sweep). Unbounded, it had grown to 8.5 GB of the database by 2026-11-09
- Usage metering: hourly cron records connection-hours, separate cron reports to Stripe
- Supabase DB connectivity: `supabase-db` → PgBouncer (`k8s/pgbouncer.yaml`, session mode, 2 replicas × 35 server connections) → `supabase-db-direct` → socat DaemonSet bridging IPv4→IPv6 (Supabase has IPv6-only DNS, k3s pods can't route IPv6) → Postgres (`max_connections` 90). WAHA opens up to 10 connections per session store (hard-coded), so without the cap bursts failed every write with "remaining connection slots are reserved". The `postgres` role has `idle_session_timeout` 15min: socat never closes a dead pod's connections by itself

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
