# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WAHooks is a SaaS platform that lets users deploy cloud-hosted WAHA (WhatsApp HTTP API) instances and configure webhooks through a managed interface. The platform handles:

- Provisioning and managing WAHA containers per customer
- Maintaining persistent WhatsApp session connections
- Webhook configuration and event routing
- Auto-scaling WAHA nodes as connection count grows

## WAHA Context

WAHA is a Dockerized NestJS app that wraps WhatsApp Web into a REST API. Key concepts:

- **Sessions**: Each WhatsApp account connection is a "session" managed by a `SessionManager`. Sessions have states: REMOVED, STOPPED, RUNNING.
- **Engines**: WAHA supports multiple WhatsApp integration backends (WebJS, NoWeb, GoWS) behind a common `WhatsAppSession` abstraction.
- **Webhooks**: Events (message received, status change, etc.) flow via RxJS observables from sessions to a `WebhookConductor` that delivers them to HTTP endpoints.
- **API**: RESTful endpoints at `/api/sessions` for lifecycle ops (create/start/stop/restart/logout), plus controllers for messaging, contacts, groups, media. Auth via `X-Api-Key` header.
- **Scaling**: WAHA Core supports one session per container. WAHA Plus supports multiple sessions per container. Our platform must orchestrate multiple containers regardless.

## Architecture (planned)

The system will need these layers:

1. **Web App / Dashboard** - User-facing UI for managing WhatsApp connections, viewing webhook logs, configuring endpoints
2. **API Server** - Handles user auth, billing, CRUD for connections/webhooks, proxies to WAHA instances
3. **Orchestration Layer** - Provisions WAHA containers (likely Kubernetes or Docker Swarm), monitors health, handles scaling decisions
4. **WAHA Instances** - The actual WAHA containers running WhatsApp sessions
5. **Event Router** - Receives webhook events from WAHA instances and fans out to customer-configured endpoints
6. **Database** - Stores user accounts, connection configs, webhook configs, event logs, billing state

## Key Design Considerations

- Each WAHA container needs persistent storage for session auth data (QR code login state survives restarts)
- WAHA sessions can disconnect; the platform must detect and auto-reconnect
- Webhook delivery should be reliable (retry logic, dead-letter queue)
- Container scaling should be based on session count per node, not just CPU/memory
- WAHA API key management: each container gets a unique API key, stored securely
