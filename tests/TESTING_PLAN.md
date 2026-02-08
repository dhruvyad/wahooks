# WAHooks Testing Plan

This document defines the full testing strategy for the WAHooks platform, covering
unit tests, integration tests, end-to-end tests, and stress/scale tests.

---

## Quick Reference: Running Tests

```bash
# Unit & integration tests (apps/api)
pnpm --filter @wahooks/api test            # run once
pnpm --filter @wahooks/api test:watch      # watch mode
pnpm --filter @wahooks/api test:cov        # with coverage report
pnpm --filter @wahooks/api test:e2e        # E2E tests

# Stress / scale tests (when Phase 3 is ready)
API_URL=http://localhost:3001 TEST_JWT_TOKEN=<token> npx tsx tests/stress/scale-test.ts

# Load tests (k6 — when scripts are written)
k6 run tests/load/baseline.js
k6 run tests/load/growth.js
k6 run tests/load/spike.js
k6 run tests/load/endurance.js
```

### Required devDependencies (add when ready to implement)

```bash
# For apps/api:
pnpm --filter @wahooks/api add -D \
  jest @types/jest ts-jest \
  @nestjs/testing supertest @types/supertest

# For load testing (repo root):
# Install k6 via brew: brew install k6
# Or use artillery: pnpm add -D artillery
```

### Recommended package.json scripts for `apps/api/package.json`

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:cov": "jest --coverage",
    "test:e2e": "jest --config jest.e2e.config.ts"
  }
}
```

---

## 1. Unit Tests

All unit tests live alongside source files using the `*.spec.ts` naming convention.

### 1.1 Auth Guard (`src/auth/auth.guard.spec.ts`)

The `AuthGuard` performs manual JWT verification using HMAC-SHA256. These tests
cover all token validation branches.

| # | Test Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | Valid JWT with correct signature and non-expired `exp` | `canActivate` returns `true`, `request.user` is set to decoded payload |
| 2 | Expired JWT (`exp` in the past) | Throws `UnauthorizedException` with "Token has expired" |
| 3 | Missing `Authorization` header entirely | Throws `UnauthorizedException` with "Missing or invalid Authorization header" |
| 4 | `Authorization` header without `Bearer ` prefix (e.g., `Basic ...`) | Throws `UnauthorizedException` with "Missing or invalid Authorization header" |
| 5 | Malformed token (not three dot-separated parts) | Throws `UnauthorizedException` with "Invalid token format" |
| 6 | Token signed with wrong secret | Throws `UnauthorizedException` with "Invalid token signature" |
| 7 | Token with no `exp` claim (no expiration) | `canActivate` returns `true` (expiration check is skipped) |
| 8 | Token with future `exp` | `canActivate` returns `true` |
| 9 | `Bearer ` prefix with empty token string | Throws `UnauthorizedException` with "Invalid token format" |

**Mocking strategy**: Create a mock `ConfigService` that returns a known JWT secret.
Build a mock `ExecutionContext` with a fake HTTP request containing the `authorization`
header. Use Node's `crypto.createHmac` to construct valid/invalid test tokens.

### 1.2 Connections Controller (`src/connections/connections.controller.spec.ts`)

> Note: This controller does not exist yet (Phase 2). Tests are planned for when it is built.

| # | Test Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | `POST /connections` — creates a new connection | Returns 201 with session info, DB has new `waha_sessions` row, `session_name` follows `u_{userId}_s_{id}` format |
| 2 | `GET /connections` — lists user's connections | Returns only connections belonging to the authenticated user, not other users' |
| 3 | `GET /connections` — empty list for new user | Returns 200 with empty array |
| 4 | `GET /connections/:id` — get by ID | Returns 200 with connection details |
| 5 | `GET /connections/:id` — connection owned by another user | Returns 403 Forbidden |
| 6 | `GET /connections/:id` — nonexistent ID | Returns 404 Not Found |
| 7 | `DELETE /connections/:id` — soft delete | Returns 200, sets status to "stopped", does not remove DB row |
| 8 | `DELETE /connections/:id` — connection owned by another user | Returns 403 Forbidden |

**Mocking strategy**: Mock the Drizzle database injection token (`DATABASE`) with an
in-memory store. Mock the orchestration service to avoid real worker provisioning.

### 1.3 Database Module (`src/database/database.module.spec.ts`)

| # | Test Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | Module provides `DATABASE` token when `DATABASE_URL` is set | `DRIZZLE_TOKEN` resolves to a Drizzle instance |
| 2 | Module throws when `DATABASE_URL` is missing | `ConfigService.getOrThrow` throws |
| 3 | Drizzle instance has schema tables registered | Schema object contains `users`, `wahaSessions`, `wahaWorkers`, `webhookConfigs`, `webhookEventLogs`, `usageRecords` |

**Mocking strategy**: Use `Test.createTestingModule` with a mocked `ConfigService`.
For test 1, provide a mock `DATABASE_URL`. Verify the factory runs without throwing.
For test 2, have `getOrThrow` throw to confirm the error propagates.

### 1.4 Billing Calculations (`packages/shared-types/src/billing.spec.ts`)

> Tests for the `BILLING` constants and related proration logic.

| # | Test Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | `PRICE_PER_CONNECTION_MONTH` equals `0.25` | Exact match |
| 2 | `HOURS_PER_MONTH` equals `720` | Exact match (30 days * 24 hours) |
| 3 | `PRICE_PER_CONNECTION_HOUR` equals `0.25 / 720` | Approximately `0.000347222...` |
| 4 | 1 full month (720 hours) of 1 connection costs $0.25 | `720 * PRICE_PER_CONNECTION_HOUR === 0.25` |
| 5 | Half month (360 hours) of 1 connection costs $0.125 | `360 * PRICE_PER_CONNECTION_HOUR === 0.125` |
| 6 | 1 hour of 1 connection cost | `1 * PRICE_PER_CONNECTION_HOUR ~= 0.000347` |
| 7 | 10 connections for a full month | `10 * 720 * PRICE_PER_CONNECTION_HOUR === 2.50` |
| 8 | Partial hour (0.5 hours) | `0.5 * PRICE_PER_CONNECTION_HOUR ~= 0.000174` |
| 9 | Edge: 0 hours = $0.00 | `0 * PRICE_PER_CONNECTION_HOUR === 0` |
| 10 | Edge: 744 hours (31-day month) exceeds standard month | `744 * PRICE_PER_CONNECTION_HOUR > 0.25` — verifies proration is per-hour not per-month |

### 1.5 Schema Validation (`packages/db/src/schema/schema.spec.ts`)

> These tests verify that the Drizzle schema exports compile and have the expected shape.

| # | Test Case | Expected Behavior |
|---|-----------|-------------------|
| 1 | `users` table has columns: `id`, `email`, `name`, `stripeCustomerId`, `createdAt`, `updatedAt` | All columns exist on the exported table object |
| 2 | `wahaWorkers` table has columns: `id`, `hetznerServerId`, `internalIp`, `apiKeyEnc`, `status`, `maxSessions`, `currentSessions`, `createdAt`, `updatedAt` | All columns present |
| 3 | `wahaSessions` table has columns: `id`, `userId`, `workerId`, `sessionName`, `phoneNumber`, `status`, `engine`, `createdAt`, `updatedAt` | All columns present |
| 4 | `webhookConfigs` table has columns: `id`, `userId`, `sessionId`, `url`, `events`, `signingSecret`, `active`, `createdAt`, `updatedAt` | All columns present |
| 5 | `webhookEventLogs` table has columns: `id`, `webhookConfigId`, `eventType`, `payload`, `status`, `attempts`, `deliveredAt`, `createdAt` | All columns present |
| 6 | `usageRecords` table has columns: `id`, `sessionId`, `periodStart`, `periodEnd`, `connectionHours`, `reportedToStripe`, `createdAt` | All columns present |
| 7 | `wahaSessions.status` enum contains exactly `["pending", "scan_qr", "working", "failed", "stopped"]` | Matches the domain model |
| 8 | `wahaWorkers.status` enum contains exactly `["provisioning", "active", "draining", "stopped"]` | Matches the domain model |

---

## 2. Integration Tests

Integration tests verify module interactions with real (or near-real) dependencies.
They live in `apps/api/test/` and use the `*.integration-spec.ts` suffix.

### 2.1 Auth Flow (`test/auth-flow.integration-spec.ts`)

> Requires a Supabase test project. Uses the Supabase JS client to create a real user
> and get a real JWT, then calls protected API endpoints.

| # | Test Case | Steps |
|---|-----------|-------|
| 1 | Full auth flow | Sign up via Supabase Auth -> extract JWT from session -> `GET /connections` with JWT -> verify 200 response |
| 2 | Expired token rejected | Take a valid JWT -> modify `exp` to the past -> resign (if using test secret) -> verify 401 |
| 3 | Cross-project token rejected | Use a JWT from a different Supabase project -> verify 401 (wrong signing secret) |

### 2.2 Connection Lifecycle (`test/connection-lifecycle.integration-spec.ts`)

> Requires running API + test database. No WAHA workers needed (mock the orchestration layer).

| # | Test Case | Steps |
|---|-----------|-------|
| 1 | Create connection | `POST /connections` -> verify 201 -> verify DB row exists with status "pending" |
| 2 | List connections | Create 3 connections -> `GET /connections` -> verify returns exactly 3 |
| 3 | Get by ID | Create connection -> `GET /connections/:id` -> verify response matches |
| 4 | Delete (soft) | Create connection -> `DELETE /connections/:id` -> verify status changed to "stopped" -> `GET /connections` still includes it (but with stopped status) |
| 5 | Idempotent delete | Delete same connection twice -> second delete returns 200 (not 404) |

### 2.3 Multi-Tenant Isolation (`test/multi-tenant.integration-spec.ts`)

| # | Test Case | Steps |
|---|-----------|-------|
| 1 | User B cannot see User A's connections | User A creates connection -> User B calls `GET /connections` -> result is empty |
| 2 | User B cannot get User A's connection by ID | User A creates connection -> User B calls `GET /connections/:id` -> 403 |
| 3 | User B cannot delete User A's connection | User A creates connection -> User B calls `DELETE /connections/:id` -> 403 -> verify connection still exists |
| 4 | User B cannot update User A's webhook config | User A creates webhook config -> User B calls `PATCH /webhooks/:id` -> 403 |

### 2.4 Webhook Config CRUD (`test/webhook-config.integration-spec.ts`)

| # | Test Case | Steps |
|---|-----------|-------|
| 1 | Create webhook config | Create connection -> `POST /webhooks` with `{ sessionId, url, events }` -> verify 201 -> verify DB row |
| 2 | Update events list | Create config -> `PATCH /webhooks/:id` with `{ events: ["message"] }` -> verify updated |
| 3 | Toggle active flag | Create config -> `PATCH /webhooks/:id` with `{ active: false }` -> verify deactivated -> toggle back -> verify reactivated |
| 4 | Delete webhook config | Create config -> `DELETE /webhooks/:id` -> verify removed from DB |
| 5 | Cannot create config for another user's session | User B tries to create webhook for User A's session -> 403 |

---

## 3. End-to-End Tests (Phase 3+)

These tests require the full system running: API, WAHA workers, BullMQ event router,
Stripe test mode. They are planned but not yet implementable.

### 3.1 Full Connection Flow (`test/e2e/full-connection-flow.e2e-spec.ts`)

| # | Step | Verification |
|---|------|-------------|
| 1 | Sign up via Supabase Auth | User created, JWT obtained |
| 2 | `POST /connections` | Connection created with status "pending" |
| 3 | `GET /connections/:id/qr` | QR code PNG/SVG returned |
| 4 | Scan QR code (simulated or manual) | Session status transitions to "working" |
| 5 | Webhook fires `session.status` event | Customer endpoint receives the event with valid HMAC signature |

### 3.2 Webhook Delivery (`test/e2e/webhook-delivery.e2e-spec.ts`)

| # | Step | Verification |
|---|------|-------------|
| 1 | Configure webhook endpoint (use a test receiver like webhook.site or local mock server) | Config saved in DB |
| 2 | Trigger a message event (send a test WhatsApp message) | Event appears in `webhook_event_logs` |
| 3 | Verify delivery to endpoint | HTTP POST received with correct payload |
| 4 | Verify `X-WAHooks-Signature` header | HMAC-SHA256 of payload matches signing secret |
| 5 | Simulate endpoint failure (return 500) | Event retried up to max attempts |
| 6 | Verify DLQ | After max retries, event status is "failed" in logs |

### 3.3 Billing Metering (`test/e2e/billing-metering.e2e-spec.ts`)

| # | Step | Verification |
|---|------|-------------|
| 1 | Create connection, wait for it to become "working" | `usage_records` table starts accumulating hourly rows |
| 2 | Wait for at least 1 full hour (or simulate with time manipulation) | `connection_hours` value is close to 1.0 |
| 3 | Verify Stripe usage record | Stripe API shows the reported usage for this customer's subscription item |
| 4 | Stop the connection | Usage accumulation stops, partial hour is recorded |
| 5 | Verify final billing | Total usage matches actual active time |

---

## 4. Stress / Scale Tests

These tests validate the platform's behavior under load and during failure scenarios.
The skeleton implementation is in `tests/stress/scale-test.ts`.

### 4.1 Scale-Up Trigger

- **Goal**: Verify auto-provisioning of new WAHA workers when capacity exceeds 80%.
- **Method**: Create connections until a worker's `current_sessions / max_sessions > 0.80`.
- **Expected**: A new worker is provisioned within 5 minutes. New connections are routed to it.

### 4.2 Scale-Down Trigger

- **Goal**: Verify worker consolidation when all workers are below 30% capacity for 10+ minutes.
- **Method**: Delete connections until all workers are below threshold. Wait 12 minutes.
- **Expected**: Sessions are migrated off one worker, that worker is drained and removed.
  Minimum 1 worker always remains.

### 4.3 Connection Storm

- **Goal**: Verify the system handles rapid concurrent connection creation.
- **Method**: Create 100 connections simultaneously via `Promise.all`.
- **Expected**: All connections are created and assigned to workers. Zero orphaned sessions.

### 4.4 Webhook Throughput

- **Goal**: Measure webhook delivery performance under high event volume.
- **Method**: Inject 1000 events/second into the BullMQ queue for 60 seconds.
- **Metrics**: Queue depth, delivery latency (p50, p95, p99), failure rate.
- **Threshold**: Failure rate < 1%, p95 latency < 5 seconds.

### 4.5 Worker Failure Recovery

- **Goal**: Verify automatic session recovery when a WAHA worker dies.
- **Method**: Create a working session, then kill the worker process/VM.
- **Expected**: Session detected as "failed" within 2 minutes. Session reassigned and
  reconnected on a replacement worker within 5 minutes.

### 4.6 Session Persistence

- **Goal**: Verify sessions survive worker restarts (auth state persisted in Postgres).
- **Method**: Create a working session, restart the worker VM.
- **Expected**: Session restores to "working" status without requiring QR re-scan.

### 4.7 Concurrent Modifications

- **Goal**: Verify no race conditions when multiple API requests modify the same resource.
- **Method**: Fire 20 simultaneous PATCH requests to the same connection.
- **Expected**: All requests either succeed or fail gracefully (no data corruption,
  no 500 errors). Final state is consistent.

---

## 5. Load Test Configuration

Load tests use [k6](https://k6.io/) (recommended) or [Artillery](https://www.artillery.io/).
Scripts will live in `tests/load/`.

### 5.1 Baseline

```
Scenario:   10 concurrent virtual users
Connections: 100 total (10 per user)
Duration:   5 minutes
Goal:       Establish baseline response times and error rates
Thresholds:
  - p95 response time < 500ms for reads
  - p95 response time < 2000ms for creates
  - Error rate < 0.1%
```

### 5.2 Growth

```
Scenario:   Ramp from 10 to 100 virtual users over 15 minutes
Duration:   15 minutes (ramp) + 5 minutes (sustain at 100)
Goal:       Identify performance degradation as load increases
Thresholds:
  - p95 response time < 1000ms at all stages
  - No 5xx errors
  - Database connection pool does not exhaust
```

### 5.3 Spike

```
Scenario:   Sudden burst of 500 connection creates in 30 seconds
Duration:   30 seconds burst + 5 minutes observation
Goal:       Verify the system handles sudden load without cascading failures
Thresholds:
  - All 500 connections eventually created (within 2 minutes)
  - API remains responsive during spike (health check < 1s)
  - No worker provisioning deadlocks
```

### 5.4 Endurance

```
Scenario:   50 virtual users sustained for 1 hour
Duration:   1 hour
Goal:       Detect memory leaks, connection pool exhaustion, log rotation issues
Thresholds:
  - Memory usage does not grow more than 20% from start
  - Response times remain stable (p95 variance < 10%)
  - No OOM kills
  - Database connection count stays within pool limits
```

---

## 6. Test File Locations

```
wahooks/
  apps/
    api/
      jest.config.ts                          # Unit test config
      src/
        auth/
          auth.guard.spec.ts                  # Auth guard unit tests
        connections/
          connections.controller.spec.ts       # Connections controller unit tests (Phase 2)
        database/
          database.module.spec.ts             # Database module unit tests
      test/
        app.e2e-spec.ts                       # Health endpoint E2E test
        auth-flow.integration-spec.ts         # Auth integration tests
        connection-lifecycle.integration-spec.ts
        multi-tenant.integration-spec.ts
        webhook-config.integration-spec.ts
    web/
      # No tests yet — planned for Phase 4 (React Testing Library + Playwright)
  packages/
    shared-types/
      src/
        billing.spec.ts                       # Billing constant unit tests
    db/
      src/
        schema/
          schema.spec.ts                      # Schema shape validation tests
  tests/
    TESTING_PLAN.md                           # This document
    stress/
      scale-test.ts                           # Scale/stress test skeleton
    load/
      baseline.js                             # k6 baseline script (planned)
      growth.js                               # k6 growth ramp script (planned)
      spike.js                                # k6 spike script (planned)
      endurance.js                            # k6 endurance script (planned)
```

---

## 7. apps/web Testing (Planned)

Frontend testing for the Next.js dashboard is planned for Phase 4 and will include:

- **Unit tests**: React Testing Library for individual components (connection cards,
  webhook config forms, QR code display, usage charts)
- **Integration tests**: Testing page-level data fetching and state management
  with MSW (Mock Service Worker) to mock API responses
- **E2E tests**: Playwright for critical user flows (login, create connection,
  configure webhook, view usage)
- **Visual regression**: Chromatic or Percy for catching unintended UI changes

Test config will use the Next.js built-in Jest support or Vitest.

---

## 8. CI/CD Integration (Planned)

```yaml
# .github/workflows/test.yml (planned)
# Triggers: push to main, pull requests
# Steps:
#   1. Install dependencies (pnpm install --frozen-lockfile)
#   2. Build packages (pnpm turbo run build)
#   3. Run unit tests (pnpm --filter @wahooks/api test)
#   4. Run integration tests (requires test DB)
#   5. Upload coverage reports
```

---

## 9. Implementation Priority

| Priority | Category | Status |
|----------|----------|--------|
| P0 | Auth guard unit tests | Ready to implement |
| P0 | Health endpoint E2E | Ready to implement |
| P0 | Billing calculation unit tests | Ready to implement |
| P0 | Schema validation unit tests | Ready to implement |
| P1 | Database module unit tests | Ready to implement |
| P1 | Connections controller unit tests | Blocked on Phase 2 (controller not built) |
| P1 | Connection lifecycle integration | Blocked on Phase 2 |
| P1 | Multi-tenant isolation integration | Blocked on Phase 2 |
| P1 | Webhook config CRUD integration | Blocked on Phase 2 |
| P2 | Auth flow integration | Needs Supabase test project |
| P3 | Full connection flow E2E | Blocked on Phase 3 (orchestration) |
| P3 | Webhook delivery E2E | Blocked on Phase 3 (event router) |
| P3 | Billing metering E2E | Blocked on Phase 3 (Stripe integration) |
| P3 | Scale/stress tests | Blocked on Phase 3 (orchestration) |
| P4 | Load tests (k6) | Blocked on Phase 3 |
| P4 | Frontend tests | Blocked on Phase 4 (dashboard components) |
