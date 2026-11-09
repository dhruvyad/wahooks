# WAHooks WhatsApp gateway (`wagw`)

One Go process that holds many WhatsApp accounts (whatsmeow), serves the HTTP API the WAHooks API already calls on
WAHA, and POSTs webhook events in WAHA's (NOWEB) payload shapes. The WAHooks API, customers' webhook handlers and the
WAHooks channel see no change. What it must match: [CONTRACT.md](CONTRACT.md). Why it is the way it is:
[DECISIONS.md](DECISIONS.md). What's missing: [GAPS.md](GAPS.md). WAHA's wire shapes: [WAHA-SHAPES.md](WAHA-SHAPES.md).
Moving existing WAHA (NOWEB) sessions over without a re-scan: [`../migrate`](../migrate).

```
cmd/gateway/        main: server, adopt-device, derive-ip, show-qr, sink, redact
internal/session/   multi-account manager: lifecycle, WAHA status model, events → webhooks, sends, reads, media
internal/waha/      whatsmeow → WAHA JSON (envelope, WAMessage, _data in Baileys form, acks, groups, chats, contacts)
internal/store/     SQLite (modernc) / Postgres (pgx) by DSN: whatsmeow's sqlstore + gw_sessions, gw_messages, gw_chats
internal/webhook/   delivery: shared workers, one retry scheduler, HMAC-SHA512, WAHA's headers and retry policy
internal/api/       WAHA routes, NestJS-style errors, auth
internal/netx/      per-account IPv6 source address, transports, resolve override
internal/metrics/   Prometheus text: sessions by status, RSS, heap, goroutines, events/s, webhooks, DB pool
deploy/             systemd units, install.sh, verify.py
```

## Build and test

```bash
cd gateway
./build.sh build                                            # bin/gateway, with whatsmeow-patches/ applied (Go 1.26)
./build.sh test                                             # go test ./... on the patched whatsmeow; SQLite always
docker run -d --name wagw-pg -e POSTGRES_PASSWORD=wagwtest -e POSTGRES_DB=wagw -p 127.0.0.1:15432:5432 postgres:16-alpine
WAGW_TEST_PG='postgres://postgres:wagwtest@127.0.0.1:15432/wagw?sslmode=disable' ./build.sh test ./internal/store/
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 ./build.sh build -trimpath -ldflags "-s -w" -o bin/gateway-linux-amd64   # or arm64 for CAX
# whatsmeow-patches/: two small patches (lazy sent-message cache, ordered growable handler queue) applied to the
# pinned whatsmeow in .build/ and selected with -modfile; a patch that stops applying fails the build. Plain
# `go build` still works but builds stock whatsmeow (~2x the memory per account).
```

## Run locally

```bash
WAGW_API_KEY=dev WAGW_DB=sqlite://$PWD/wagw.db WAGW_LISTEN=127.0.0.1:3000 ./bin/gateway
curl -s -H 'X-Api-Key: dev' -H 'Content-Type: application/json' localhost:3000/api/sessions \
  -d '{"name":"u_test_s_1","start":true,"config":{"webhooks":[{"url":"http://127.0.0.1:3999/hook","events":["*"]}]}}'
curl -s -H 'X-Api-Key: dev' localhost:3000/api/u_test_s_1/auth/qr > qr.png      # or ?format=raw
```

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `WAGW_API_KEY` | (required) | Shared key, sent as `X-Api-Key` (the API's `WAHA_API_KEY`). `WAGW_INSECURE_NO_AUTH=1` disables auth for local tests. |
| `WAGW_LISTEN` | `:3000` | Bind address. The API calls `http://<internalIp>:3000`. Bind the private-network address in production. |
| `WAGW_DB` | `sqlite:///var/lib/wagw/wagw.db` | `sqlite://<path>`, `file:<path>` or `postgres://…` (Supabase direct endpoint works from IPv6-only boxes). |
| `WAGW_DB_MAX_CONNS` | 4 (SQLite) / 16 (Postgres) | Database pool size for the whole box (idle = open). |
| `WAGW_BOX_ID` | hostname | Owner name for session leases and `environment.worker.id`. |
| `WAGW_BASE_URL` | `http://localhost:3000` | Base of `media.url` (the API keeps only the last path segment). |
| `WAGW_IPV6_PREFIX` | unset | The box's routed /64 (AnyIP). Each session dials from a stable address derived from its name; unset = default routing. |
| `WAGW_IPV6_SALT` | `wagw` | Mixed into the address hash. Never change it on a running fleet. |
| `WAGW_WEBHOOK_RESOLVE` | unset | `host:port:addr[,…]` like `curl --resolve`, e.g. `api.example.com:443:[2001:db8::1]` for an IPv6-only box whose webhook target has no AAAA record. |
| `WAGW_WEBHOOK_WORKERS` / `_QUEUE` / `_TIMEOUT` | 16 / 20000 / 15s | Delivery pool, queue cap (overflow is dropped and counted), per-request timeout. |
| `WAGW_STORE_MESSAGES` | `true` | Keep message history for the chats/messages/media endpoints. |
| `WAGW_MESSAGE_RETENTION` | `720h` | History kept this long. |
| `WAGW_MESSAGES_PER_CHAT_MAX` | 1000 | Newest messages kept per chat (0 = no cap). |
| `WAGW_HISTORY_DAYS` / `_SIZE_MB` / `_MSGS_PER_CHAT` | 7 / 20 / 50 | History sync requested when a device links, and how much of it is stored. |
| `WAGW_MEDIA_DIR` / `_CACHE_TTL` / `_MAX_MB` | `$TMPDIR/wagw-media` / 10m / 100 | Download cache and upload temp files; send size limit. |
| `WAGW_PROFILE_PIC_TTL` | 6h | Profile picture URL cache (shared). |
| `WAGW_QR_MAX_CYCLES` | 1 | QR series (~160 s each) before an unscanned session goes FAILED, as NOWEB. 0 = forever. |
| `WAGW_LINK_PREVIEW` | `true` | Link previews for URLs in `sendText` (public addresses only), as NOWEB. |
| `WAGW_MARK_ONLINE` | `false` | Send "available" on connect (NOWEB's default is true; it silences the phone's notifications). |
| `WAGW_START_CONCURRENCY` / `_INTERVAL` | 64 / 1ms | Boot reconnects in parallel and spacing (10,000 accounts back in ~23 s; 8 / 50ms took N/20 s). |
| `WAGW_HISTORY_CONCURRENCY` | 2 | History syncs turned into stored rows at once, box-wide (bounds memory when many accounts link together). |
| `WAGW_LEASE_TTL` | 3m | Session lease (one box per account). |
| `WAGW_DEVICE_NAME` | `WAHooks` | Name shown in the phone's linked devices (new links only). |
| `WAGW_WS_URL` | unset | Override `wss://web.whatsapp.com/ws/chat` (mock server for density benchmarks). `WAGW_WS_INSECURE_TLS=1` skips TLS checks for it. |
| `WAGW_LID_CACHE_MAX` | 0 | > 0 replaces whatsmeow's shared, unbounded PN↔LID cache with one of about this many entries per direction (`wagw_lid_cache_entries`). For density runs; 0 keeps whatsmeow's. |
| `WAGW_LOG` / `WAGW_WA_LOG` | `INFO` / `WARN` | Gateway and whatsmeow log levels. |
| `WAGW_PPROF` | `false` | Mount `/debug/pprof/*` (behind the key). |

## Endpoints

All of [CONTRACT.md](CONTRACT.md) section 3, plus `GET /api/sessions` without `all`, `PUT /api/sessions/{name}`,
`POST /api/{session}/auth/request-code` (pairing code), `GET /api/contacts?contactId=`, `/api/{session}/lids`,
`/lids/count`, `/lids/pn/{pn}`, `POST /api/{session}/chats/overview`, `POST /api/{session}/chats/{chatId}/messages/read`,
the legacy `POST /api/sessions/start|stop|logout`, `/api/checkNumberStatus`, and:

| Path | Auth | |
|---|---|---|
| `GET /health` | no | `{"status":"ok","sessions":{…by status},"uptimeSeconds","version"}`; 503 when the database is unreachable |
| `GET /metrics` | no | Prometheus text: `wagw_sessions{status}`, `wagw_process_rss_bytes`, `wagw_go_heap_inuse_bytes`, `wagw_go_heap_live_bytes` (live after the last GC: the number to track per account), `wagw_goroutines`, `wagw_open_fds`, `wagw_events_per_second`, `wagw_events_total{event}`, `wagw_connections_total{kind=connected|disconnected|logged_out|stream_replaced|temporary_ban}`, `wagw_webhook_deliveries_total{result}`, `wagw_webhook_queue_depth`, `wagw_db_*` |
| `GET /api/server/version` | yes | WAHA's version body (Kubernetes probed it) |

Gateway extension on create: `"x-gateway-source-ip": "<addr>"` pins a session's source address.

## Postgres / Supabase

- Use the direct endpoint (`db.<ref>.supabase.co:5432`, IPv6, which IPv6-only boxes reach natively) or Supavisor in
  **session** mode. In transaction mode, add `default_query_exec_mode=simple_protocol` to the DSN, because pgx caches
  prepared statements per connection.
- Keep the gateway's tables out of the app's schema: `CREATE SCHEMA wagw;` then
  `WAGW_DB=postgres://…/postgres?search_path=wagw&sslmode=require`. whatsmeow's tables (`whatsmeow_*`) and the
  gateway's (`gw_*`) are created on first start (tested on Postgres 16). Caveat: whatsmeow's migration checks
  `information_schema.tables` by name without a schema, so no other schema in that database may hold `whatsmeow_*`
  tables, or it will think they exist and fail.
- Pool size is per box (`WAGW_DB_MAX_CONNS`, default 16 on Postgres), not per account.

## Deploy to a box

Prerequisites: Debian/Ubuntu, systemd, a routed IPv6 /64 (Hetzner gives one per server), inbound port 3000 only from
the API (private network).

```bash
gateway/deploy/install.sh <ssh-host> --prefix <the box's /64> [--listen <private-ip>:3000] [--sink] [--no-start]
```

It builds a static binary, creates the `wagw` user, `/opt/wagw/gateway`, `/var/lib/wagw` (database, media cache),
`/etc/wagw/wagw.env` (only if missing; the API key is generated on the box and never printed) and `wagw.service`,
then restarts the service. `--sink` adds `wagw-sink.service`, a test webhook receiver on `127.0.0.1:3999` that appends
events to `/var/lib/wagw-sink/sink.jsonl`. Upgrades: run it again; linked sessions reconnect in about a second.

`wagw.service` sets `net.ipv6.ip_nonlocal_bind=1` and `ip -6 route replace local <prefix> dev lo` before start (AnyIP),
runs as `wagw` with a read-only system, `Restart=always`, 40 s stop timeout.

Useful on the box:

```bash
systemctl status wagw; journalctl -u wagw -f                   # logs (JSON, no content or numbers)
curl -s localhost:3000/health; curl -s localhost:3000/metrics
sudo /opt/wagw/gateway show-qr <session>                        # link a phone: QR in the terminal until WORKING
sudo python3 -I /opt/wagw/verify.py read <session>              # endpoint checks, output redacted
sudo -u wagw env $(sudo cat /etc/wagw/wagw.env | xargs) /opt/wagw/gateway adopt-device -session <name> [-jid …] [-src-ip …]
```

From a laptop: `ssh -N -L 13000:127.0.0.1:3000 <box>`, then `http://localhost:13000` with the key from
`sudo grep WAGW_API_KEY /etc/wagw/wagw.env` on the box.

## Pointing WAHooks at a gateway

- Register the box as a worker row (`internal_ip` = its private address, `api_key_enc` = the shared key,
  `max_sessions` = the box's capacity). The API's `waha.service.ts` needs no change: same paths, port and key.
- On an IPv6-only box, set `WAGW_WEBHOOK_RESOLVE` if the API's hostname has no AAAA record.
- Existing NOWEB sessions move without a re-scan with the converter in [`../migrate`](../migrate).

## Density notes

Per account the gateway adds no goroutines; whatsmeow keeps a few per connected client. Caches that grow with
accounts: whatsmeow's shared LID map cache (every PN↔LID pair and miss seen, unbounded unless `WAGW_LID_CACHE_MAX`
is set), the profile-picture cache (capped at 50k entries), the sent-id, ack and message dedup caches (capped,
10 min / 60 s). Measure with `/metrics` and `WAGW_PPROF=1`;
the benchmark in `bench/density` drives it through `WAGW_WS_URL`.

## License

The gateway's own code is MIT, like the rest of this repository. It links
[whatsmeow](https://github.com/tulir/whatsmeow) (MPL-2.0) and, through it, `go.mau.fi/libsignal` (GPL-3.0), so a
built gateway binary as a whole is covered by the GPL-3.0. Running it as a hosted service is fine; distributing the
binary means distributing its source under the GPL-3.0. The files in `whatsmeow-patches/` modify MPL-2.0 files of
whatsmeow and are themselves MPL-2.0.

