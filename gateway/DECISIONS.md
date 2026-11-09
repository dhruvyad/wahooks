# Gateway decisions

Design calls made while building the gateway (2026-11), so they can be reviewed. Each says what was decided, why, and
how to change it.

## Compatibility

1. **NOWEB shapes, not GOWS.** Production runs WAHA Plus on NOWEB, so payloads, ids and error bodies copy NOWEB where
   the two engines differ (DM `to`/`participant` omitted, `message.ack.group`, no `jid` in MeInfo, send responses as
   the Baileys proto). Reference: [WAHA-SHAPES.md](WAHA-SHAPES.md), from WAHA `c42f68a`; WAHA Plus's own code is not
   public, so anything Plus overrides could not be checked.
2. **The gateway says `engine: "NOWEB"`** in envelopes, session info and `/api/server/version`, because its payloads
   are NOWEB's and customers may branch on it. Change `waha.Engine` if we would rather be honest about it.
3. **`_data` is rebuilt in Baileys' form from whatsmeow's data**, including WhatsApp's own field names (`fileSha256`,
   not whatsmeow's `fileSHA256`) and NOWEB's two encodings (webhook vs store reads). Bytes inside webhook `_data`
   are base64 strings; NOWEB would give `{"type":"Buffer","data":[…]}` for the few Buffer fields that live outside
   `message` (none that the API or channel read).
4. **QR timeout → FAILED after one series (~160 s), as NOWEB.** The WAHooks health cron restarts FAILED sessions and
   the QR route resets them, so this is what the API is built around. `WAGW_QR_MAX_CYCLES=0` keeps minting QR codes
   instead (WAHooks then retires the session after 30 min / 2 h).
5. **`POST /api/sessions` starts only with `start: true`** (NOWEB's code, despite WAHA's docs). The API always calls
   `/start` after create.
6. **`start` on a FAILED session starts it** (NOWEB: no-op, `restart` needed). More useful, and the API uses
   `restart` for FAILED anyway.
7. **Logout of a stopped session briefly connects to unlink the device from the phone** (≤ 15 s), then deletes the
   credentials; WAHA only deletes them locally, which leaves a ghost entry in the phone's linked-devices list (max
   4). If the connect fails, the credentials are deleted locally as WAHA does. The API's reset (stop → logout →
   delete → create → start) therefore unlinks properly.
8. **`DELETE` = stop + logout + drop the gateway's rows** (history, chats, config), as WAHA's delete.
9. **No auto-retry after FAILED** (as NOWEB); the API's health cron owns recovery.
10. **Sessions are listed with `?all=true` from the gateway's table**, so a session survives gateway restarts and
    the API never re-creates it by mistake.
11. **Webhook TLS verification stays on** (WAHA turns it off). WAHooks posts only to its own API with a real
    certificate.
12. **`markOnline` off by default** (NOWEB's default is on). Being "online" all the time stops the phone's
    notifications, which matters for personal accounts. `startTyping` sends "available" first (WhatsApp ignores chat
    state otherwise), at most every 4 minutes. `WAGW_MARK_ONLINE=1` restores NOWEB's behaviour.
13. **Text is sent as `extendedTextMessage`** like Baileys, with a link preview for the first URL (title,
    description, a ≤ 300 px JPEG of `og:image`) unless `linkPreview: false`, as NOWEB. Preview fetches go only to
    public addresses (checked after DNS, including NAT64-embedded IPv4), 6 s and 512 KB / 3 MB caps; any failure
    sends the text without a preview. `WAGW_LINK_PREVIEW=0` turns previews off box-wide.
14a. **Status updates (`status@broadcast`) are `message` events**, as NOWEB emits them unless `config.ignore.status`
    is set; `config.ignore` is honoured for status, groups, channels and broadcast lists. Message events are
    deduplicated per `{fromMe}_{id}` for 60 s, as NOWEB does.
14. **message.ack after an API send**: the server's acceptance is emitted as ack 1 (NOWEB emits it from Baileys'
    server-ack update); further acks come from receipts. Duplicates are dropped for 60 s as NOWEB does.

## Media

15. **On-demand, not before the event.** NOWEB downloads every file before emitting the event and deletes it after
    180 s. The gateway puts `{WAGW_BASE_URL}/api/files/{session}/{waId}.{ext}` in the event and downloads from
    WhatsApp when that URL is fetched (whatsmeow `DownloadToFile` into a temp file, never whole in memory), caching
    the file on disk for `WAGW_MEDIA_CACHE_TTL` (10 min). Events go out faster and the URL keeps working as long as the
    message is in history and WhatsApp still has the file (weeks), instead of 180 s. The API only uses the last path
    segment, which is `<waId>.<ext>`.
16. **Sending fetches `file.url` from the box's default route**, not the account's address (the same as WAHA's pod),
    and **only from public addresses** (checked after DNS; WAHA has no such check), so a customer URL can't reach the
    private network, the metadata service or the gateway itself. An IPv6-only box can't fetch IPv4-only URLs; see
    GAPS.md.
17. **Thumbnails without ffmpeg.** Images get width/height and a 64 px JPEG thumbnail (PNG, JPEG, GIF; ≤ 25 MP decoded);
    voice is sent as given with `ptt: true` (WAHA's `convert` is not implemented); video gets no duration or
    thumbnail.

## State

18. **SQLite and Postgres behind one store.** The first test box ran SQLite; the Postgres path is tested with the
    same code (Docker, Postgres 16). `WAGW_DB=postgres://…` switches.
19. **One database for whatsmeow and the gateway.** whatsmeow's `sqlstore` keeps every account in one set of tables;
    the gateway adds `gw_sessions` (config, device JID, source address, desired state, lease), `gw_messages` and
    `gw_chats`. Contacts and the LID map are read from whatsmeow's own tables, not duplicated.
20. **History kept 30 days and at most 1,000 messages per chat** (`WAGW_MESSAGE_RETENTION`,
    `WAGW_MESSAGES_PER_CHAT_MAX`), pruned hourly. Stored copies drop thumbnails and device-list metadata.
21. **History sync asks for little**: 7 days, 20 MB, ≤ 50 messages per chat (`WAGW_HISTORY_DAYS`, `_SIZE_MB`,
    `_MSGS_PER_CHAT`), no full sync, no call log. These are sent when a device links, so they only affect new links.
    History never produces webhook events (as WAHA).
22. **Chats are keyed by the JID WhatsApp used** (PN or LID); reads by chat id also look up the other alias through
    whatsmeow's LID map, so `GET /chats/<digits>@c.us/messages` finds messages that arrived on the LID.
23. **One box per account.** Each row records the box the API created it on (`box` = `WAGW_BOX_ID`); a box loads
    only its own rows, so boxes can share one database. On top of that, **a lease in `gw_sessions`** (`owner`, `lease_until`, 3-minute TTL, renewed for all of a
    box's sessions by one UPDATE a minute). Starting, logging out or deleting a session another box holds answers 409. A box restart keeps its
    leases (same `WAGW_BOX_ID`), so another box can only take an account after 3 minutes.

## Network identity

24. **Source address = first 64 bits of SHA-256(`WAGW_IPV6_SALT` NUL session name) inside `WAGW_IPV6_PREFIX`**,
    stored in `gw_sessions.src_ip` at create and never changed. Interface ids below `0x10000` are skipped (kept for the
    box's own addresses such as `::1` and `::b1`). Unset prefix → default routing, one shared transport.
25. **An adopted device keeps the address it was linked from** (`adopt-device -src-ip`): changing it would look like a
    new location to WhatsApp for no gain.
26. **Every connection of an account uses its address**: websocket and media (one `http.Transport` per account, small
    idle pools). Webhook delivery and `file.url` fetches use the box's default route.

## Process

27. **Port 3000, bind address configurable** (`WAGW_LISTEN`); by default `127.0.0.1:3000` (reach it with an
    SSH tunnel). In production bind the private-network address.
28. **API key required** (`WAGW_API_KEY`, `X-Api-Key` header or `?x-api-key=`), generated on the box by the install
    script and never printed. `/health`, `/ping` and `/metrics` need no key (counts only, nothing personal). pprof
    only with `WAGW_PPROF=1`, behind the key.
29. **No per-account goroutines or timers of the gateway's own**: QR rotation, leases, retention, cache sweeps and the
    events/s rate run on one 5-second ticker; webhooks use a shared worker pool and one retry scheduler. whatsmeow's
    own per-client goroutines (read loop, keepalive, handler queue) remain.
30. **Panic isolation:** whatsmeow recovers panics in event handlers; the gateway recovers its own goroutines and HTTP
    handlers. A panic inside whatsmeow's internal goroutines would still end the process: systemd restarts it and
    linked sessions reconnect (8 at a time, 50 ms apart, linked first; ~0.3–1.5 s each measured on a test box).
31. **Logs are JSON (slog)** with session names only. whatsmeow's lines pass through a redactor that masks JIDs and
    runs of 7+ digits. Message content, phone numbers and keys are never logged by the gateway.
32. **Shutdown disconnects every account without logging out**, waits for webhook queues ≤ 5 s, then closes the DB.
33. **Device name on the phone: "WAHooks"** (platform Chrome). `WAGW_DEVICE_NAME` changes it for new links.
34. **WebSocket override for benchmarks** is a RoundTripper that rewrites the URL (`WAGW_WS_URL`,
    `WAGW_WS_INSECURE_TLS`), because whatsmeow's `socket.URL` is a constant, and setting `MessengerConfig` would switch
    whatsmeow into Messenger mode.
35. **whatsmeow pinned at `v0.0.0-20261107160454-79dc2a8c33df`** (the latest on 2026-11-09, same as the native
    harness). Go 1.26.

37. **Bounded LID cache is opt-in** (`WAGW_LID_CACHE_MAX`). whatsmeow's cache is shared by all accounts and never
    evicts; the replacement uses the same SQL and write semantics through whatsmeow's `dbutil` wrapper, so its writes
    join whatsmeow's transactions (a separate connection would wait on SQLite's write lock). Off by default because
    whatsmeow's decryption depends on this map and the first real-account tests ran with whatsmeow's own.

38. **Client lifecycle is fenced three ways**, after an independent review found that whatsmeow's own reconnects
    (auto-reconnect, the post-pairing 515 reconnect) clear its "expected disconnect" flag: every client generation
    has its own context, cancelled before any disconnect (no redial is possible after that, and a hanging dial is
    abandoned at once); `Connect` and `Disconnect` are serialised per session; events and status changes of an older
    generation are ignored. Unlinked devices don't retry a failed first connect in the background.

39. **Leases renew one heartbeat row per box, not every session row** (`gw_boxes`). A session is held while its own
    `lease_until` (set when a box takes it, 3 minutes) or its owner box's heartbeat is in the future. Before this,
    renewal rewrote every session row a box owned once a minute: ~333 row updates/s on a 20,000-account box, ~1,700/s
    across 100k accounts, several times the message writes. Now it is one upsert per box per minute. Boxes sharing a
    database must be upgraded together, since an older box only reads `lease_until`.
