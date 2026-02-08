# WAHooks

WAHooks is a SaaS platform that lets users deploy cloud-hosted [WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API) instances and configure webhooks through a managed interface. Users connect their WhatsApp accounts, set up webhook endpoints, and receive real-time events (messages, status changes, etc.) delivered to their servers with HMAC-signed payloads.

## Architecture

```
                                ┌─────────────────┐
                                │   Next.js Web    │
                                │   Dashboard      │
                                │   (Vercel)       │
                                └────────┬─────────┘
                                         │ Supabase Auth JWT
                                         ▼
┌──────────────┐  Stripe     ┌───────────────────────┐  WAHA API   ┌─────────────────┐
│   Stripe     │◄───────────►│   NestJS API Server   │◄───────────►│  WAHA Workers   │
│   Billing    │  webhooks   │   (Hetzner VM)        │  (private   │  (Hetzner VMs)  │
└──────────────┘             └───────────┬───────────┘   network)   └─────────────────┘
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼          ▼
                         ┌────────┐ ┌────────┐ ┌────────┐
                         │Supabase│ │ Redis  │ │Customer│
                         │Postgres│ │(BullMQ)│ │Webhook │
                         │  + Auth│ │        │ │Endpoints│
                         └────────┘ └────────┘ └────────┘
```

**Monorepo** managed by Turborepo + pnpm workspaces:

- **API Server** (NestJS) -- handles auth, connection CRUD, proxies to WAHA workers, event routing, billing
- **Web Dashboard** (Next.js) -- user-facing UI for managing connections, webhooks, and billing
- **WAHA Workers** -- Hetzner Cloud VMs running WAHA Plus containers on a private network
- **Event Router** -- BullMQ queue processes WAHA events and fans out HMAC-signed webhook deliveries with exponential backoff retry
- **Billing** -- Stripe usage-based billing with hourly connection-hour metering

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict mode) |
| API Server | NestJS 11 |
| Web Dashboard | Next.js 15 + React 19 + Tailwind CSS 4 |
| Auth | Supabase Auth (JWT) |
| Database | Supabase Postgres + Drizzle ORM |
| Message Queue | BullMQ + Redis (Upstash) |
| Billing | Stripe (metered usage-based) |
| Infrastructure | Hetzner Cloud VMs + Docker |
| Monorepo | Turborepo + pnpm workspaces |

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9+
- A Supabase project (Postgres + Auth)
- Redis instance (local or Upstash)
- Stripe account (for billing features)
- Hetzner Cloud API token (for WAHA worker provisioning)

### Setup

```bash
# Clone and install dependencies
pnpm install

# Copy environment files and fill in your values
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# Push the database schema (development)
pnpm --filter @wahooks/db db:push

# Or generate and run migrations (production)
pnpm --filter @wahooks/db db:generate
pnpm --filter @wahooks/db db:migrate

# Build all packages
pnpm build

# Start development servers (API on :3001, Web on :3000)
pnpm dev
```

## Project Structure

```
wahooks/
  apps/
    api/                NestJS API server (port 3001)
      src/
        auth/           Supabase JWT guard + user decorator
        billing/        Stripe checkout, portal, usage metering, webhooks
        connections/    WhatsApp connection CRUD + WAHA session lifecycle
        database/       Drizzle ORM provider (global module)
        events/         WAHA event ingestion + BullMQ webhook delivery
        health/         Cron-based worker health polling + auto-scaling
        orchestration/  Container provisioning interface + Hetzner implementation
        waha/           WAHA REST API client (sessions, QR codes)
        webhooks/       Webhook config CRUD + event log queries
        workers/        Worker pool management (assign/unassign/scale)
    web/                Next.js dashboard (port 3000)
      src/
        app/            App router pages + layouts
        lib/            Supabase client helpers
  packages/
    db/                 Drizzle ORM schema + migrations
      src/schema/       Table definitions (users, waha_sessions, etc.)
    shared-types/       Domain types shared across apps
    config/             Shared ESLint + TypeScript configs
```

## API Endpoints

All API routes are prefixed with `/api`. Auth-protected routes require a `Bearer <supabase_jwt>` in the `Authorization` header.

### Health

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api` | No | Health check (returns `{ status: "ok" }`) |

### Connections (WhatsApp Sessions)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/connections` | Yes | List all connections for the authenticated user |
| `POST` | `/api/connections` | Yes | Create a new WhatsApp connection (provisions WAHA session) |
| `GET` | `/api/connections/:id` | Yes | Get a specific connection by ID |
| `GET` | `/api/connections/:id/qr` | Yes | Get the QR code for linking WhatsApp |
| `POST` | `/api/connections/:id/restart` | Yes | Restart a connection's WAHA session |
| `DELETE` | `/api/connections/:id` | Yes | Stop and delete a connection |

### Webhooks

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/connections/:connectionId/webhooks` | Yes | List webhook configs for a connection |
| `POST` | `/api/connections/:connectionId/webhooks` | Yes | Create a webhook config (url, events filter) |
| `PUT` | `/api/webhooks/:id` | Yes | Update a webhook config (url, events, active) |
| `DELETE` | `/api/webhooks/:id` | Yes | Delete a webhook config |
| `GET` | `/api/webhooks/:id/logs` | Yes | Get delivery logs for a webhook (last 100) |

### Events (Internal)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/events/waha` | No | WAHA event ingestion endpoint (internal, from workers) |

### Billing

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `GET` | `/api/billing/status` | Yes | Get billing status (subscription, usage summary) |
| `GET` | `/api/billing/usage` | Yes | Get usage summary (connection-hours, estimated cost) |
| `POST` | `/api/billing/checkout` | Yes | Create a Stripe Checkout session |
| `POST` | `/api/billing/portal` | Yes | Create a Stripe Customer Portal session |

### Stripe (Internal)

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| `POST` | `/api/stripe/webhook` | Stripe signature | Stripe webhook receiver (subscription lifecycle events) |

## Environment Variables

### API (`apps/api/.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase Postgres connection string |
| `SUPABASE_URL` | Supabase project URL (JWTs verified via JWKS) |
| `REDIS_URL` | Redis connection string for BullMQ |
| `HETZNER_API_TOKEN` | Hetzner Cloud API token for VM provisioning |
| `HETZNER_NETWORK_ID` | Hetzner private network ID |
| `STRIPE_SECRET_KEY` | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_ID` | Stripe metered price ID for connection-hours |
| `API_URL` | Public URL of the API server |
| `FRONTEND_URL` | Public URL of the web dashboard |
| `PORT` | API server port (default: 3001) |

### Web (`apps/web/.env`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_...`) |
| `NEXT_PUBLIC_API_URL` | Public URL of the API server |

See the `.env.example` files in each app for full reference.

## Development

```bash
# Start all apps in watch mode
pnpm dev

# Start only the API
pnpm --filter @wahooks/api dev

# Start only the web dashboard
pnpm --filter @wahooks/web dev

# Build all packages
pnpm build

# Run tests (API)
pnpm --filter @wahooks/api test

# Run tests in watch mode
pnpm --filter @wahooks/api test:watch

# Lint all packages
pnpm lint

# Generate Drizzle migrations
pnpm --filter @wahooks/db db:generate

# Run Drizzle migrations
pnpm --filter @wahooks/db db:migrate

# Push schema to DB (dev only)
pnpm --filter @wahooks/db db:push
```

## Webhook Delivery

When a WAHA event is received, the API:

1. Looks up the session by `sessionName`
2. Finds all active webhook configs whose event filter matches
3. Creates an event log entry and enqueues a BullMQ delivery job
4. The delivery processor sends the payload as a `POST` request to the configured URL
5. Outbound requests include HMAC-SHA256 signatures:
   - `X-WAHooks-Signature: sha256=<hex>` -- HMAC of the JSON body using the webhook's signing secret
   - `X-WAHooks-Timestamp` -- delivery timestamp
   - `X-WAHooks-Event` -- event type (e.g., `message`, `session.status`)
6. Failed deliveries retry with exponential backoff (5s, 10s, 20s, 40s, 80s) up to 5 attempts

## Billing Model

Pure usage-based pricing with hourly resolution:

- **$0.25 per connection per month**, prorated hourly (~$0.000347/connection/hour)
- No base subscription -- users only pay for active connection time
- Connection-hours are recorded every hour for sessions in `working` status
- Usage is reported to Stripe metered billing periodically

## License

Private / Proprietary
