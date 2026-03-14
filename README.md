# WAHooks — WhatsApp Webhooks, Instant Setup

<p align="center">
  <img src="assets/banner.webp" alt="WAHooks Banner" />
</p>

<p align="center">
  <strong>Connect WhatsApp numbers, receive real-time webhooks, and send messages — all through a simple API.</strong><br>
  No infrastructure to manage. Fully open source.
</p>

<p align="center">
  <a href="https://wahooks.com"><img src="https://img.shields.io/badge/Website-wahooks.com-25D366" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@wahooks/sdk"><img src="https://img.shields.io/npm/v/@wahooks/sdk.svg" alt="npm version"></a>
  <a href="https://pypi.org/project/wahooks/"><img src="https://img.shields.io/pypi/v/wahooks.svg" alt="PyPI version"></a>
  <a href="https://discord.gg/B2XNf97Vby"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://x.com/dhruvyad"><img src="https://img.shields.io/twitter/follow/dhruvyad?style=social" alt="Twitter"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License"></a>
  <a href="https://github.com/dhruvyad/wahooks/actions"><img src="https://img.shields.io/github/actions/workflow/status/dhruvyad/wahooks/deploy-api.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://deepwiki.com/dhruvyad/wahooks"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="center">
  <a href="https://wahooks.com/docs">Documentation</a> &middot;
  <a href="https://wahooks.com/signup">Get Started</a> &middot;
  <a href="https://discord.gg/B2XNf97Vby">Discord</a> &middot;
  <a href="https://x.com/dhruvyad">Twitter</a>
</p>

---

## Why WAHooks?

Building WhatsApp integrations shouldn't require managing WAHA containers, configuring Kubernetes, or wiring up webhook delivery pipelines. WAHooks handles all of that so you can focus on your application.

- **Zero infrastructure** — we run the WhatsApp sessions, you receive the webhooks
- **Simple API** — REST API, TypeScript SDK, Python SDK, CLI, and MCP server
- **$0.99/month per connection** — no minimums, no hidden fees
- **Open source** — MIT licensed, self-host if you prefer

## Quick Start

### Install the CLI

```bash
curl -fsSL wahooks.com/install | bash
```

Or via npm:

```bash
npm install -g wahooks
```

### Connect WhatsApp in 30 seconds

```bash
wahooks login
wahooks connections create
wahooks connections qr <id> --poll   # Scan with WhatsApp
```

### Receive webhooks

```bash
wahooks webhooks create <connection-id> --url https://your-app.com/webhook
```

Every WhatsApp message, status change, and event is delivered to your endpoint with HMAC-SHA256 signatures and automatic retries.

### Send messages

```bash
wahooks send <connection-id> --to 1234567890@s.whatsapp.net --text "Hello from WAHooks"
```

## SDKs

### TypeScript

```bash
npm install @wahooks/sdk
```

```typescript
import { WAHooks } from '@wahooks/sdk';

const client = new WAHooks({ apiKey: 'wh_...' });
const connections = await client.connections.list();
await client.messages.send(connectionId, {
  chatId: '1234567890@s.whatsapp.net',
  text: 'Hello!',
});
```

### Python

```bash
pip install wahooks
```

```python
from wahooks import WAHooks

client = WAHooks(api_key="wh_...")
connections = client.connections.list()
client.messages.send(connection_id, chat_id="1234567890@s.whatsapp.net", text="Hello!")
```

### MCP Server

Connect WAHooks to Claude, Cursor, Windsurf, and other AI assistants:

```json
{
  "mcpServers": {
    "wahooks": {
      "type": "http",
      "url": "https://api.wahooks.com/mcp"
    }
  }
}
```

## Features

- **Managed WhatsApp Sessions** — Cloud-hosted WAHA containers with automatic scaling and health monitoring
- **Persistent Sessions** — Auth state persisted in Postgres, survives restarts and node replacements
- **Webhook Delivery** — HMAC-SHA256 signed payloads, 5 retries with exponential backoff, dead-letter queue
- **Real-time Events** — Messages, status changes, presence updates, delivered via BullMQ
- **SDKs & CLI** — TypeScript and Python SDKs, Go CLI, MCP server for AI assistants
- **Chat Viewer** — Built-in dashboard to view chats, send messages, and manage connections
- **OAuth & API Tokens** — Supabase Auth with JWT, API tokens with `wh_` prefix for programmatic access
- **Auto-scaling** — Kubernetes-based scaling with proactive provisioning (buffer at 10 remaining slots)
- **Open Source** — MIT licensed, self-hostable, fully documented

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
                         ├── Redis (BullMQ + AOF persistence)
                         └── Cluster Autoscaler
                                │
                                ▼
                         Customer Webhook
                         Endpoints (HMAC-signed)
```

| Component | Tech | Hosting |
|-----------|------|---------|
| Dashboard | Next.js 15, React 19, Tailwind CSS 4 | Vercel |
| API | NestJS 11, TypeScript | k3s on Hetzner Cloud |
| WhatsApp Engine | WAHA Plus (NOWEB, ~50 sessions/pod) | k3s StatefulSet |
| Database + Auth | Supabase (Postgres + Auth + JWTs) | Supabase Cloud |
| Message Queue | BullMQ + Redis 7 (AOF persistence) | k3s Deployment |
| Billing | Stripe prepaid slots ($0.99/connection/month) | Stripe |
| Infrastructure | Terraform + kube-hetzner | Hetzner Cloud |
| Monorepo | Turborepo + pnpm workspaces | — |

## API Reference

All routes prefixed with `/api`. Auth via Supabase JWT or API token in `Authorization: Bearer` header.

### Connections

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/connections` | List connections |
| `POST` | `/api/connections` | Create connection |
| `GET` | `/api/connections/:id` | Get connection detail |
| `GET` | `/api/connections/:id/qr` | Get QR code |
| `GET` | `/api/connections/:id/chats` | Get recent chats |
| `GET` | `/api/connections/:id/me` | Get WhatsApp profile |
| `POST` | `/api/connections/:id/restart` | Restart session |
| `DELETE` | `/api/connections/:id` | Delete connection |

### Webhooks

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/connections/:cid/webhooks` | List webhook configs |
| `POST` | `/api/connections/:cid/webhooks` | Create webhook |
| `PUT` | `/api/webhooks/:id` | Update webhook |
| `DELETE` | `/api/webhooks/:id` | Delete webhook |
| `GET` | `/api/webhooks/:id/logs` | Delivery logs |

### Billing

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/billing/status` | Subscription status |
| `POST` | `/api/billing/checkout` | Create checkout session |
| `POST` | `/api/billing/portal` | Stripe customer portal |

Full API documentation: [wahooks.com/docs](https://wahooks.com/docs)

## Self-Hosting

### Prerequisites

- Node.js 20+, [pnpm](https://pnpm.io/) 9+
- [Supabase](https://supabase.com/) project (Postgres + Auth)
- Docker (for local WAHA)

### Local Development

```bash
git clone https://github.com/dhruvyad/wahooks.git
cd wahooks

pnpm install

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
# Fill in your Supabase + Stripe credentials

pnpm db:push    # Push schema to DB
pnpm dev        # Start API (:3001) + Web (:3000)
```

### Production Deployment

Infrastructure is fully declarative via Terraform using [kube-hetzner](https://github.com/kube-hetzner/terraform-hcloud-kube-hetzner):

```bash
cd terraform/
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform apply
```

This provisions:
- k3s control plane on Hetzner Cloud
- Autoscaling 1–10 worker nodes for WAHA pods
- Redis, RBAC, secrets, and all k8s resources

CI/CD via GitHub Actions: build Docker image → run migrations → rolling deploy.

See [k8s/README.md](k8s/README.md) for full deployment docs.

## Project Structure

```
wahooks/
├── apps/
│   ├── api/              NestJS API server
│   └── web/              Next.js dashboard + docs (Fumadocs)
├── packages/
│   ├── db/               Drizzle ORM schema + migrations
│   ├── shared-types/     TypeScript domain types
│   └── config/           Shared ESLint + TypeScript configs
├── sdks/
│   ├── python/           Python SDK (PyPI: wahooks)
│   ├── typescript/       TypeScript SDK (npm: wahooks)
│   └── mcp/              MCP server (OAuth via Supabase)
├── cli/                  Go CLI (Cobra)
├── terraform/            k3s cluster provisioning
└── k8s/                  Kubernetes manifests
```

## Contributing

Contributions welcome! See the [docs](https://wahooks.com/docs) for architecture details.

1. Fork the repo
2. Create a branch (`git checkout -b feat/my-feature`)
3. Commit with conventional commits (`feat:`, `fix:`, etc.)
4. Open a PR

Join our [Discord](https://discord.gg/B2XNf97Vby) to discuss ideas and get help.

## License

[MIT](LICENSE)

---
