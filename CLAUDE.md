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
| `orchestration/` | `ContainerOrchestrator` interface + Hetzner Cloud implementation + mock for dev/testing |
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

1. **Dashboard (Next.js)** -- manages connections, webhook configs, usage/billing
2. **API Server (NestJS)** -- validates Supabase JWTs, CRUD operations, proxies to WAHA workers via private network
3. **Orchestration Layer** -- provisions/destroys Hetzner VMs via cloud API, cloud-init bootstraps Docker + WAHA
4. **WAHA Workers** -- WAHA Plus containers (NOWEB engine) on Hetzner private network, no public exposure
5. **Event Router (BullMQ)** -- ingests WAHA webhook POSTs, fans out to customer endpoints with HMAC-SHA256 signing, exponential backoff (5 attempts), failed jobs retained as DLQ
6. **Supabase** -- Postgres (app data + WAHA session persistence) + Auth (JWT)
7. **Stripe** -- usage-based billing, connection-hours metered hourly

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
| WAHA Edition | WAHA Plus (NOWEB engine) -- multi-session, ~50 sessions per CX22 VM |
| API Framework | TypeScript + NestJS |
| Frontend | Next.js + React + Tailwind CSS + shadcn/ui |
| Database + Auth | Supabase (Postgres + Auth) + Drizzle ORM |
| Container Orchestration | Hetzner Cloud VMs + Docker |
| Message Queue | BullMQ + Upstash Redis |
| Billing | Stripe -- pure usage-based, hourly resolution ($0.25/connection/month) |
| Repo | Turborepo + pnpm workspaces |
| Deployment | Hetzner (API + WAHA), Vercel (web), Supabase (DB+Auth), Upstash (Redis) |

## Database Schema

Tables in `packages/db/src/schema/`:
- **users** -- synced from Supabase Auth, has `stripe_customer_id`
- **waha_workers** -- Hetzner VMs: `hetzner_server_id`, `internal_ip`, `api_key_enc` (encrypted), `status`, `max_sessions`, `current_sessions`
- **waha_sessions** -- user-to-worker mapping: `session_name`, `phone_number`, `status`, `engine`
- **webhook_configs** -- per-session webhook: `url`, `events[]`, `signing_secret`, `active`
- **webhook_event_logs** -- delivery tracking: `event_type`, `payload` (JSONB), `status`, `attempts`
- **usage_records** -- hourly connection-hour buckets: `session_id`, `period_start`, `period_end`, `connection_hours`, `reported_to_stripe`

## Key Design Details

- WAHA workers accessible only via Hetzner Private Network; API server proxies all calls
- Each worker gets a unique `WAHA_API_KEY`, stored encrypted, never exposed to users
- WAHA session auth state persisted in Supabase Postgres (survives VM replacement)
- Health monitoring: 1-min cron polls WAHA sessions, auto-restarts failed/stopped sessions
- Scale up: any worker >80% capacity. Scale down: all workers <30% for sustained period (never zero)
- Outbound webhooks signed with HMAC-SHA256 (`X-WAHooks-Signature` header)
- Webhook delivery: BullMQ with 5 attempts, exponential backoff (5s base), last 1000 failed jobs retained
- Usage metering: hourly cron records connection-hours, separate cron reports to Stripe
