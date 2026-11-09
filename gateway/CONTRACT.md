# Gateway contract

What the gateway must implement so the WAHooks API (`wahooks/apps/api/src`), customers' webhook handlers and
the WAHooks channel (`wahooks/sdks/channel`) see no change when a session moves from WAHA Plus (NOWEB engine) to
the gateway. Derived from the API source at `wahooks` main `3c0920e` (read-only) and WAHA's source
(`devlikeapro/waha` `c42f68a`, 2026-10-28). Where NOWEB and GOWS differ, the gateway matches NOWEB, because that
is what customers receive today.

Status of each item in the gateway is tracked in [GAPS.md](GAPS.md).

## 1. Transport

| | |
|---|---|
| Base URL | `http://<worker.internalIp>:3000` — scheme and port are hard-coded in `waha.service.ts` (`buildUrl`), so the gateway listens on port 3000 (bind address configurable). |
| Auth | Header `X-Api-Key: <key>` on every call (one key shared by all workers; the API sends `worker.apiKeyEnc`). WAHA also accepts `?x-api-key=`. |
| Body | JSON, `Content-Type: application/json`. |
| Timeouts | The API aborts a call after 30 s (3 s for the LID lookup, which sits on the event path). |
| Errors | The API reads the body as JSON and uses `exception.message ?? message ?? error` as the reason. A non-2xx status becomes a 400 (4xx) or 502 (5xx) for the API's caller. A 500 whose text matches `remaining connection slots are reserved|too many clients already` is retried after 1/3/8/15 s; the gateway must not produce that text for other reasons. |
| Empty body | A 2xx with an empty body is fine (`undefined`). |
| Probe | Kubernetes probed `GET /api/server/version` with the key. The gateway serves it, plus `GET /health` and `GET /metrics`. |

## 2. Session names and status

- Names are `u_{12 hex}_s_{12 hex}` (≤ 54 chars, WAHA's limit). WAHA Plus runs many per process; Core mode
  (`default`) is not used.
- Status values: `STOPPED`, `STARTING`, `SCAN_QR_CODE`, `WORKING`, `FAILED`. The API maps them:

| WAHA status | API DB status | What the API does (health cron every 3 min, `health.service.ts`) |
|---|---|---|
| `WORKING` | `working` | Clears recovery counters; fetches `GET /api/sessions/{name}/me` to fill the phone number if missing (`me.id` with `@c.us` stripped). |
| `SCAN_QR_CODE` | `scan_qr` | Retires (stop, row `failed`) after 30 min unscanned if the row has a phone number (was linked), 2 h if never linked. Implies an unscanned session keeps minting QR codes indefinitely rather than going FAILED on its own. |
| `FAILED` | — | `POST /restart` up to 5 times per API pod lifetime, then `POST /stop` (auth must be preserved by stop). |
| `STOPPED` | — | `POST /start` (from persisted auth, no logout) unless the row is `stopped`/`failed`. |
| `STARTING` | — | Nothing (transitional). |
| missing from list | — | `POST /api/sessions` (create) then `POST /start`; row → `scan_qr`. So the list must include every session the gateway knows, stopped ones too (`all=true`). |

- A session in the gateway's list that no non-stopped DB row names is an orphan: the API `DELETE`s it (≤ 25 per
  poll per worker).
- `session.status` events update the DB within ~100 ms (`events.controller.ts` `applySessionStatus`): only
  `WORKING`→`working`, `SCAN_QR_CODE`→`scan_qr`, `FAILED`→`failed`; `STOPPED` is ignored. It reads
  `payload.status`, `me.id` (envelope) or `payload.me.id`, and `payload.statuses` (last 5 kept as evidence).

## 3. Endpoints the API calls

All paths are under the base URL. `{session}` is URL-encoded. Response fields listed are the ones the API (or a
consumer through it) reads; everything else is passed through to customers as-is in some routes, so it should
still match WAHA.

### Sessions

| Method, path | Body / query | Response read by the API |
|---|---|---|
| `POST /api/sessions` | `{name, config: {noweb: {store: {enabled: true, fullSync: true}}, webhooks: [{url, events: ['*']}]}}` (no `start` field → WAHA default `start: true`) | SessionInfo (unused) |
| `POST /api/sessions/{name}/start` | — | — (called right after create; must not fail when create already started it) |
| `POST /api/sessions/{name}/stop` | — | — (keeps auth) |
| `POST /api/sessions/{name}/restart` | — | — (keeps auth) |
| `POST /api/sessions/{name}/logout` | — | — (removes auth; the API calls it after `stop`, so it must work on a stopped session) |
| `DELETE /api/sessions/{name}` | — | — (the API always calls stop → logout → delete; delete removes everything) |
| `GET /api/sessions/{name}` | — | `status` (any 2xx means "exists"; non-2xx means "doesn't") |
| `GET /api/sessions?all=true` | — | `[{name, status}]` |
| `GET /api/sessions/{name}/me` | — | `{id: "<digits>@c.us", pushName}` |

Reset (used by get-or-create, restart and QR recovery) is: stop → logout → delete → create → start, each error
ignored except create/start.

### Auth / QR

| Method, path | Response |
|---|---|
| `GET /api/{session}/auth/qr` | Raw PNG by default (`content-type: image/png`); the API base64s it. Non-2xx when there is no QR (the API then reads the session status and returns `{connected: true}` if WORKING, or resets a FAILED/STOPPED one). WAHA also supports `?format=raw` → `{value}` and `Accept: application/json` → `{mimetype, data}`. |
| `POST /api/{session}/auth/request-code` | Not called by the API today; WAHA's pairing-code endpoint (`{phoneNumber}` → `{code}`). Implemented for completeness. |

### Chats and messages

| Method, path | Query / body | Fields read |
|---|---|---|
| `GET /api/{session}/chats` | `limit=20&sortBy=conversationTimestamp&sortOrder=desc` | `id, name, timestamp, lastMessage{body,timestamp,fromMe}` (typed but unused by routes) |
| `GET /api/{session}/chats/overview` | `limit, offset` | `id, name, lastMessage{body, timestamp, fromMe}, _chat.markedAsUnread, _chat.unreadMentionCount` |
| `GET /api/{session}/chats/{chatId}/messages` | `limit, offset, downloadMedia` (true/false) | Newest first. Per message: `id, from, timestamp, fromMe, body, hasMedia, media{url,mimetype,filename,size}, location, vCards, replyTo (string or {id}), _data.participant, _data.key.participant, _data.pushName, _data.notifyName, _data.message.{documentWithCaptionMessage.message,documentMessage,imageMessage,videoMessage,audioMessage,stickerMessage}.{mimetype,fileName,fileLength}`. A page shorter than `limit` means "start of history". |
| `GET /api/{session}/chats/{chatId}/messages/{messageId}` | `downloadMedia=true` | Same message shape; `hasMedia` and `media.url` are required for the media route. |
| `PUT /api/{session}/chats/{chatId}/messages/{messageId}` | `{text}` | — (edit; non-2xx → "can only edit within 15 minutes") |

### Contacts and identities

| Method, path | Fields read |
|---|---|
| `GET /api/contacts/all?session=&limit=&offset=` | `id, name, phoneNumber` (`phoneNumber` may be a JID; the API strips `@…`; if absent and `id` ends `@c.us` the digits are used) |
| `GET /api/contacts/check-exists?phone=<digits>&session=` | `{numberExists, chatId}` — `chatId` is the canonical routable id (used to rewrite every send target, cached 1 h) |
| `GET /api/contacts/profile-picture?contactId=&session=` | `{profilePictureURL}` (errors → null) |
| `GET /api/{session}/lids/{lid}` | `{lid, pn}` — `pn` is `<digits>@c.us` or null. 3 s timeout, on the event path. |

### Sending

All take `session` and `chatId` in the body. Before each send the API (unless `skipPresence`) calls `sendSeen`,
`startTyping`, waits 1–8 s, then `stopTyping`, ignoring errors, so those three must be cheap and tolerant.

| Method, path | Body | Response read |
|---|---|---|
| `POST /api/sendText` | `{chatId, text, session, reply_to?}` | NOWEB's raw message: `key{remoteJid, fromMe, id}`, `messageTimestamp`. The API adds `id = "{fromMe}_{remoteJid→c.us}_{key.id}"`; everything else is returned to the caller. |
| `POST /api/sendImage` | `{chatId, session, file{url}|file{data, mimetype}, caption?}` | passed through |
| `POST /api/sendFile` | `{chatId, session, file{url|data, mimetype?, filename?}, caption?}` | passed through |
| `POST /api/sendVideo` | `{chatId, session, file, caption?}` | passed through |
| `POST /api/sendVoice` | `{chatId, session, file}` | passed through |
| `POST /api/sendLocation` | `{chatId, session, latitude, longitude, title?, address?}` | passed through |
| `POST /api/sendContactVcard` | `{chatId, session, contacts: [{vcard}]}` | passed through |
| `PUT /api/reaction` | `{messageId, reaction, session}` (`messageId` is WAHA's serialized id; `""` removes) | — |
| `POST /api/sendSeen` | `{chatId, session}` (no message ids) | — |
| `POST /api/startTyping`, `/api/stopTyping` | `{chatId, session}` | — |

`file.data` is base64 (the API decodes `data:` URLs itself). `file.url` is fetched by the worker.

### Files

| Method, path | |
|---|---|
| `GET /api/files/{session}/{filename}` | Streams a media file. The API builds this from the last path segment of any `media.url` it saw (in events or message listings), so `media.url`'s last segment must be enough to find the file again. The API streams it (never buffers) and forwards `content-type` and `content-length`. 404 → "Media not found". |

## 4. Webhook events

Sessions are created with `webhooks: [{url: "${API_URL}/api/events/waha", events: ["*"]}]`; no HMAC, retries or
custom headers are configured by the API. The API (`POST /api/events/waha`) then:

- looks the session up by `event.session` (the full name) and ignores unknown ones;
- on `session.status` applies the status (section 2);
- rewrites `payload.media.url` to `${API_URL}/api/connections/{id}/media/{last segment}`;
- for any payload with a string `from`, adds `senderPhone`: from `_data.key.participantAlt`, `_data.key.remoteJidAlt`,
  `participant`, `from` (first that is `<digits>[:dev]@c.us|s.whatsapp.net`); otherwise, if the writer
  (`participant || _data.key.participant || from`) ends with `@lid` and `fromMe` is false, it asks
  `GET /api/{session}/lids/{lid}`;
- adds `connectionId`, stores the whole envelope in `webhook_event_logs`, and fans it out (HMAC-signed by the API)
  to customer webhooks whose `events` include `*` or the event name.

So every field of the envelope and payload reaches customers verbatim. The channel (`sdks/channel/src/index.ts`)
reads, from `message` events only: `payload.fromMe, from, participant, body, hasMedia, media{url,mimetype,filename},
id, replyTo{participant, body, hasMedia}, _data.message.*Message.{mimetype,fileName}`.

Payload shapes per event are in section 5.

## 5. Payload shapes (WAHA NOWEB)

The field-by-field reference, with WAHA source lines and the NOWEB/GOWS differences, is
[WAHA-SHAPES.md](WAHA-SHAPES.md). What matters most, and what the gateway does:

### Envelope (every webhook)

`{id: "evt_<lowercase ulid>", timestamp: <ms>, event, session, metadata?, me: MeInfo|null, payload, engine: "NOWEB",
environment: {version, engine, tier: "PLUS", browser: null, platform, worker: {id}}}`. `metadata` is omitted when
the session has none. Headers: `Content-Type: application/json`, `User-Agent: WAHA/<version>`,
`X-Webhook-Request-Id` (18 lowercase alphanumerics, the same across retries), `X-Webhook-Timestamp` (the envelope's
ms), and when `hmac.key` is set `X-Webhook-Hmac` = hex HMAC-SHA512 of the exact body plus
`X-Webhook-Hmac-Algorithm: sha512`. Retries: `retries.attempts` (default 15) after the first try, `delaySeconds`
(default 2), policy constant (≥ Retry-After) / linear / exponential (+0–20 % jitter); every failure is retried.

### MeInfo

`{id: "<digits>@c.us", pushName, lid: "<id>@lid" or "", reachoutTimelock: null, messageCapping: null}`; NOWEB has no
`jid`.

### Events

| Event | Payload | Notes |
|---|---|---|
| `session.status` | `{name, status, statuses: [last 3 {status, timestamp ms}], data: null}` | One per transition, plus one per QR rotation while SCAN_QR_CODE. |
| `message` | WAMessage | Incoming only (not fromMe). |
| `message.any` | WAMessage | Incoming, sent from the phone (source `app`, ack 1) and sent through the API (source `api`, ack 0, `_data` = proto WebMessageInfo with string `messageTimestamp` and `status: "PENDING"`). |
| `message.ack` | `{id, from, to?, participant?, fromMe: true, ack, ackName}` (no `_data`) | DMs: delivered 2, read 3, played 4, own-device `sender` receipt 1, server error -1; the server's ack of an API send is 1. Deduplicated per id+ack+participant for 60 s. |
| `message.ack.group` | `{id: …_<me>, from: group, to: group, participant: reader, fromMe: true, ack, ackName, _data: {key, receipt: {userJid, receiptTimestamp|readTimestamp}}}` | Groups only: delivered is 1 (NOWEB quirk), read and played are 3. |
| `message.reaction` | `{id, timestamp, from, fromMe, source, to?, participant?, reaction: {text, messageId}}` | `messageId` is turned to our perspective like Baileys; `text` `""` removes. No `_data`. |
| `message.revoked` | `{after: WAMessage of the revoke (body null), before: null, revokedMessageId, _data}` | |
| `message.edited` | WAMessage of the edit with `body` = new text, plus `editedMessageId` | |
| `presence.update` | `{id, presences: [{participant, lastKnownPresence: online|offline|typing|recording|paused, lastSeen}]}` | |
| `group.v2.join/leave/participants/update` | as WAHA-SHAPES.md B.9 (timestamps in ms, raw Baileys flags) | |
| `call.received/accepted/rejected` | `{id, from, timestamp, isVideo, isGroup, _data}` | |
| `poll.vote`, `label.*`, `group.v2.participants.join-request`, `engine.event`, `state.change` | not emitted yet | See GAPS.md. |

### WAMessage

Keys in NOWEB's order: `id, timestamp, from, fromMe, source, body, to?, participant?, hasMedia, media, ack, ackName,
location, vCards, replyTo, _data`.

- `id` = `{fromMe}_{chat}_{waId}`, plus `_{participant}` when the message has a key participant (received group
  messages, including our own sent from the phone; not group messages sent through the API).
- `from` is always the chat, `@c.us` for phone numbers and `@lid` kept as is. DMs omit `to` and `participant`;
  groups set `to` to the group and `participant` to the sender.
- `body` is `null` when empty. `location` coordinates are strings. `vCards` and `replyTo` are `null` when absent.
- `media` is `null` without media, otherwise `{url, filename, mimetype}`; `url` is
  `{WAGW_BASE_URL}/api/files/{session}/{waId}.{ext}` or `null` with `downloadMedia=false`.
- `_data` is Baileys' WebMessageInfo: `key {remoteJid (@s.whatsapp.net/@lid/@g.us), remoteJidAlt?, fromMe, id,
  participant ("" in DMs), participantAlt?, addressingMode}`, `messageTimestamp`, `pushName`, `broadcast`, `message`,
  `status` (ack + 1). The phone number of a LID sender is only in `remoteJidAlt` / `participantAlt`, which is what
  the API's `senderPhone` reads.
- Two encodings of `_data.message` (and `replyTo._data`): webhooks use protobufjs toJSON (int64 as strings, enums as
  names, bytes as base64); HTTP reads use NOWEB's store form (int64 as numbers, enums as numbers, bytes as
  `{"type":"Buffer","data":"<base64>"}`). Field names are WhatsApp's (`url`, `fileSha256`, `stanzaId`), not
  whatsmeow's (`URL`, `fileSHA256`, `stanzaID`).

### HTTP specifics the gateway matches

- Every POST answers 201 (start/stop/restart/logout/send*/sendSeen/typing); GET/PUT/DELETE 200. `DELETE` has an
  empty body.
- `POST /api/sessions` starts the session only with `start: true`; an existing name is 422.
- `GET /api/sessions?all=true` lists stopped sessions too and has no `engine`; `GET /api/sessions/{name}` adds
  `engine: {engine: "NOWEB"}` (or `{}` when stopped). A stopped session shows its last `me`.
- Session routes for a missing session: 404 `{"message":"Session not found","error":"Not Found","statusCode":404}`.
  Routes that need WORKING: missing → 422 `{"error":"Session \"x\" does not exist","session":"x"}`; not WORKING →
  422 `{"error":"Session status is not as expected. Try again later or restart the session","session","status",
  "expected":["WORKING"]}` (after waiting up to 10 s while STARTING). Missing `session` in a send body → 422
  `{"error":"Session name is required"}`.
- `/me` is 404 when the session isn't running and an empty 200 when it isn't linked.
- `/chats` returns raw conversations (`@s.whatsapp.net` ids, no `unreadCount`); `/chats/overview` returns
  `{id (@c.us), name, picture, lastMessage, _chat}` without broadcasts or newsletters.
- Send responses are the proto WebMessageInfo (`key`, `message`, `messageTimestamp` string, `status: "PENDING"`, and
  `participant` for groups); there is no top-level `id`.
- `sendSeen` without ids answers `{"ids": [...]}`; with ids an empty 201. `startTyping`/`stopTyping` answer
  `{"result": true}`.
- `check-exists` answers `{numberExists: true, chatId: "<digits>@c.us"}` or `{numberExists: false}`.
- `/lids/{lid}` rejects anything not ending in `@lid` with 422.
- `/api/files/...` 404 body: `{"error":{"code":404,"key":"FILE_NOT_FOUND","message":"File not found","details":…}}`.

### Status model (NOWEB)

| Trigger | Status |
|---|---|
| start | STARTING → (unlinked) SCAN_QR_CODE, (linked) WORKING |
| QR series runs out unscanned (~160 s: one 60 s code then 20 s codes) | FAILED; restart for a new QR |
| scanned | WORKING (after whatsmeow's post-pairing reconnect) |
| connection lost | STARTING, then WORKING after the automatic reconnect |
| logged out from the phone, stream replaced, temporary ban, client outdated, connect failure | FAILED, no reconnect |
| stop | STOPPED (auth kept) |
| logout | credentials removed; a running session restarts into SCAN_QR_CODE, a stopped one stays STOPPED |
