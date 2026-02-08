# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAHooks is a SaaS platform that lets users deploy cloud-hosted WAHA (WhatsApp HTTP API) instances and configure webhooks through a managed interface. The platform handles:

- Provisioning and managing WAHA containers per customer
- Maintaining persistent WhatsApp session connections
- Webhook configuration and event routing
- Auto-scaling WAHA nodes as connection count grows

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

- `pnpm install` — install all dependencies
- `pnpm turbo run build` — build all packages
- `pnpm turbo run dev` — start all apps in dev mode
- `pnpm turbo run lint` — lint all packages
- `pnpm --filter @wahooks/api dev` — run only the API
- `pnpm --filter @wahooks/web dev` — run only the web app
- `pnpm --filter @wahooks/db db:generate` — generate Drizzle migrations
- `pnpm --filter @wahooks/db db:migrate` — run Drizzle migrations
- `pnpm --filter @wahooks/db db:push` — push schema to DB (dev only)

## Conventions

### Commit Messages
Use conventional commits with these prefixes:
- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code restructuring without behavior change
- `docs:` — documentation changes
- `chore:` — build config, deps, tooling
- `test:` — adding or updating tests
- `style:` — formatting, whitespace, etc.

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

## Technology Stack (Decided)

| Area | Decision |
|------|----------|
| WAHA Edition | WAHA Plus (NOWEB engine) — multi-session, ~50 sessions per CX22 VM |
| API Framework | TypeScript + NestJS |
| Frontend | Next.js + React + Tailwind CSS + shadcn/ui |
| Database + Auth | Supabase (Postgres + Auth) + Drizzle ORM |
| Container Orchestration | Hetzner Cloud VMs + Docker |
| Message Queue | BullMQ + Upstash Redis |
| Billing | Stripe — pure usage-based, hourly resolution |
| Repo | Turborepo + pnpm workspaces |
| Deployment | Hetzner (API + WAHA), Vercel (web), Supabase (DB+Auth), Upstash (Redis) |

## Billing Model

Pure usage-based pricing with hourly resolution:
- **$0.25 per connection per month**, prorated hourly (~$0.000347/connection/hour)
- No base subscription — users only pay for what they use
- Connection-hours tracked: each session's active time (status=working) is metered
- Stripe metered billing: periodic usage record reporting
- Half a month of one connection = $0.125

## WAHA Context

WAHA is a Dockerized NestJS app that wraps WhatsApp Web into a REST API. Key concepts:

- **Sessions**: Each WhatsApp account connection is a "session" managed by a `SessionManager`. Sessions have states: REMOVED, STOPPED, RUNNING.
- **Engines**: WAHA supports NOWEB (our choice), WebJS, GoWS behind a common `WhatsAppSession` abstraction.
- **Webhooks**: Events flow via RxJS observables from sessions to a `WebhookConductor` that delivers them to HTTP endpoints.
- **API**: RESTful endpoints at `/api/sessions` for lifecycle ops, plus controllers for messaging, contacts, groups, media. Auth via `X-Api-Key` header.
- **Scaling**: NOWEB engine — 50 sessions ≈ 150% CPU, 4GB RAM. 500 sessions ≈ 300% CPU, 30GB RAM. Sessions are stateful and require sticky routing. Use `WAHA_WORKER_ID` for isolating storage.

## Database Schema

Tables in `packages/db/src/schema/`:
- **users** — synced from Supabase Auth, has `stripe_customer_id`
- **waha_workers** — Hetzner VMs: `hetzner_server_id`, `internal_ip`, `api_key_enc` (encrypted), `status`, `max_sessions`, `current_sessions`
- **waha_sessions** — user↔worker mapping: `session_name`, `phone_number`, `status`, `engine`
- **webhook_configs** — per-session webhook: `url`, `events[]`, `signing_secret`, `active`
- **webhook_event_logs** — delivery tracking: `event_type`, `payload` (JSONB), `status`, `attempts`

## Architecture

1. **Dashboard (Next.js)** — manages connections, webhook configs, usage logs
2. **API Server (NestJS)** — auth (Supabase JWT), CRUD, proxies to WAHA workers
3. **Orchestration Layer** — provisions Hetzner VMs via API, cloud-init bootstraps Docker + WAHA
4. **WAHA Workers** — WAHA Plus containers on private network, no public exposure
5. **Event Router (BullMQ)** — ingests WAHA webhooks, fans out to customer endpoints with retry + DLQ
6. **Supabase** — Postgres (app data + WAHA session persistence) + Auth

## Key Design Considerations

- WAHA workers accessible only via Hetzner Private Network; API server proxies all calls
- Each worker gets a unique `WAHA_API_KEY`, stored encrypted, never exposed to users
- WAHA session auth state persisted in Supabase Postgres (survives VM replacement)
- Health monitoring: WAHA webhook events → polling fallback (60s) → Docker health checks
- Scale up: any worker >80% capacity. Scale down: all workers <30% for 10min (never zero)
- Outbound webhooks signed with HMAC-SHA256 (`X-WAHooks-Signature` header)
