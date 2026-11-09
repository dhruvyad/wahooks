# WAHA wire-shapes reference (NOWEB first, GOWS notes)

## Sources
- **WAHA:** commit `c42f68a`, 2026-10-28. `VERSION.version = "2026.10.1"` (`src/version.ts:50-57`).
- **Plus code is not in the clone.** The clone holds only Core source; `src/plus/` is absent, and `main.ts:64` loads `./plus/app.module.plus` when it exists. Anything the Plus build overrides cannot be seen here: the session manager, persistence, and S3/PSQL media. The shared code read here (engines, DTOs, webhook, controllers) is what Plus builds on.
- **Baileys:** the fork `devlikeapro/Baileys#fork-master-2026-04-28` (`package.json` v7.0.0-rc14), fetched read-only. It was used only to confirm object shapes and serialization.
- **Path abbreviations:**
  - `N:` = `src/core/engines/noweb/session.noweb.core.ts`
  - `G:` = `src/core/engines/gows/session.gows.core.ts`
  - `A:` = `src/core/abc/session.abc.ts`
  - `B:` = Baileys fork `src/…`
  - All other paths are relative to `waha/src/`.

---

## 0. Serialization rules (apply everywhere)

| Rule | Detail | Source |
|---|---|---|
| Key order | JS insertion order, shown in every example below. `undefined` keys are **omitted**; `null` is kept | — |
| Webhook body | `JSON.stringify(envelope)`, compact, no replacer. The HMAC covers exactly these bytes | `modules/waha-webhook/WebhookPlugin.sender.ts:65-71` |
| HTTP body | A global interceptor runs `JSON.parse(JSON.stringify(data, BufferJSON.replacer))`. A Node Buffer becomes `{"type":"Buffer","data":"<base64>"}` | `nestjs/BufferJsonReplacerInterceptor.ts:13-33`, `core/app.module.core.ts:220` |
| protobuf instances | Serialized by protobufjs `toJSON`, i.e. `toObject(longs:String, enums:String, bytes:String)`: **uint64 → decimal string**, **enum → name string**, **bytes → base64 string**, empty repeated fields omitted, unset optionals omitted. Proto field order applies | Baileys `WAProto/index.js` (`WebMessageInfo.prototype.toJSON`) |
| Buffers inside plain objects (webhooks) | `{"type":"Buffer","data":[1,2,…]}`, a number array, because there is no replacer | Node `Buffer.toJSON` |
| `Date` | ISO string | — |

Which values are proto instances (this matters for byte-compat):
1. **Send result:** whatever Baileys `sendMessage` returns is a `proto.WebMessageInfo.fromObject(...)` instance (`B: Utils/messages.ts:786-798`). It is returned by the `/api/send*` HTTP calls and echoed as `_data` of the API-sent `message.any`. So `messageTimestamp` is `"1731150000"` (a string) and `status` is `"PENDING"`.
2. **Received messages:** `_data` is a **plain object** (`B: Utils/decode-wa-message.ts:228-255`). `messageTimestamp` is a number and `status` is a number (WAHA sets it to 3). Its `_data.message` is a `proto.Message` instance, so it goes through `toJSON`.
3. **Store reads:** messages and chats read from the NOWEB store (HTTP GET) are plain objects. Longs become numbers (`replaceLongsWithNumber`), enums stay numbers, and Buffers are revived and sent as `{"type":"Buffer","data":"<b64>"}` (`core/engines/noweb/store/sqlite3/NOWEBSqlite3KVRepository.ts:15-27`, `psql/NOWEBPsqlKVRepository.ts:20-35`).

JID helpers:
- **`toCusFormat`** (`core/utils/jids.ts:149-172`) is used for all outward ids:

  | Input | Output |
  |---|---|
  | `x@s.whatsapp.net`, `x:dev@s.whatsapp.net` | `x@c.us` |
  | `x:dev@lid` | `x@lid` (device stripped; `@lid` stays `@lid`) |
  | `@g.us`, `@broadcast`, `@newsletter`, `"me"` | unchanged |
  | `undefined` | `undefined` |
  | `''` | `''` |

- **Inward conversion** (`modules/waha-wid-suffix/WidEnsureSuffixPlugin.ts`, `modules/waha-wid-jid/WidToJIDPlugin.ts`, `core/utils/jids.ts:60-78`):
  1. A bare number gets `@c.us` appended.
  2. `@c.us` becomes `@s.whatsapp.net`; `@lid`, `@g.us`, `@broadcast`, `@newsletter` and `@meta.ai` are kept.
  3. `:device` is stripped.

---

## A. Webhooks

### A.1 Envelope

`populateSessionInfo` (`core/abc/manager.abc.ts:246-269`). `id` and `timestamp` are stamped when the event is produced (`A:288-292`).

| Field | Type | Value |
|---|---|---|
| `id` | string | `"evt_" + ulid().toLowerCase()`, 26 chars after the prefix, e.g. `evt_01jcd8x3m4k2v9r7q5t1n6b8yz` (`utils/ids.ts:8-10`) |
| `timestamp` | number | **ms** since epoch (`Date.now()`) |
| `event` | string | the event name |
| `session` | string | session name |
| `metadata` | object | `config.metadata`. **Key omitted** when unset |
| `me` | object\|null | `getSessionMeInfo()` (see C.2 MeInfo). `null` before creds exist |
| `payload` | object | event-specific |
| `engine` | string | `"NOWEB"` |
| `environment` | object | `{version, engine, tier, browser, platform, worker:{id}}` (`version.ts:50-57`) |

```json
{"id":"evt_01jcd8x3m4k2v9r7q5t1n6b8yz","timestamp":1731150000123,"event":"message","session":"u_1_s_2",
 "metadata":{"user.id":"1"},
 "me":{"id":"15550000000@c.us","pushName":"Acme","lid":"123456789012345@lid","reachoutTimelock":null,"messageCapping":null},
 "payload":{…},"engine":"NOWEB",
 "environment":{"version":"2026.10.1","engine":"NOWEB","tier":"PLUS","browser":null,"platform":"linux/x64","worker":{"id":null}}}
```

`worker.id` comes from `WAHA_WORKER_ID` and is `null` when unset (`version.ts:35-37`).

### A.2 Delivery (`modules/waha-webhook/WebhookPlugin.sender.ts`)

| Item | Behaviour | Line |
|---|---|---|
| Method / URL | `POST webhook.url`. Body is compact `JSON.stringify` | 65-82 |
| Headers set on the axios instance | `content-type: application/json`, `User-Agent: WAHA/<version>`, then each `customHeaders[] {name,value}`. Custom headers can override the first two | 108-117 |
| Headers set per request (override the instance) | `content-type: application/json`; `X-Webhook-Request-Id: uniqid()` (≈18 lowercase alphanumerics, the same across retries); `X-Webhook-Timestamp: String(envelope.timestamp)` (ms) | 160-168 |
| HMAC | Only if `hmac.key` is non-empty: `X-Webhook-Hmac = hex(HMAC-SHA512(key, bodyString))` and `X-Webhook-Hmac-Algorithm: sha512` | 148-179 |
| Retries | axios-retry: `retries = retries.attempts ?? 15`; `delaySeconds ?? 2`; `retryCondition: () => true`, so **every** failure (network error or any non-2xx) is retried. Total requests = attempts + 1 | 20-21, 119-144 |
| Policy | `constant` (also the default when `policy` is null or unknown): `max(delay, Retry-After)`<br>`linear`: `n·delay` (axios-retry `linearDelay`)<br>`exponential`: `2^n·delay + 0–20 % jitter`<br>`delaySeconds: 0` means no delay | 24-41, 181-207 |
| TLS / timeout | `rejectUnauthorized:false` (cert errors ignored); keep-alive agents; no axios timeout | 44-47, 127-131 |
| Concurrency | Fire-and-forget, one `setImmediate` per event per webhook. No ordering guarantee; failures are only logged | `WebhookPlugin.ts:55-62` |
| Targets | `session.config.webhooks[]` plus the global env webhook (`WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS` comma list, `WHATSAPP_HOOK_HMAC_KEY`, `WHATSAPP_HOOK_RETRIES_{POLICY,DELAY_SECONDS,ATTEMPTS}`, `WHATSAPP_HOOK_CUSTOM_HEADERS="k:v;k2:v2"`) | `WebhookPlugin.ts:27-34`, `webhook.config.ts:13-176` |

`WebhookConfig` (`structures/webhooks.config.dto.ts:72-118`):

```json
{"url":"https://x","events":["*"],"hmac":{"key":"s3cr3t"},
 "retries":{"policy":"constant|linear|exponential","delaySeconds":2,"attempts":15},
 "customHeaders":[{"name":"X-A","value":"b"}]}
```

- A webhook with a missing `url` or with `events: []` is skipped (`WebhookPlugin.ts:47`).

### A.3 Event filter (`utils/events.ts:15-45`, `structures/enums.dto.ts:3-44`)
- **`"*"`** expands to every `WAHAEvents` value **except `state.change` and `engine.event`**. Those two must be listed explicitly.
- **Prefix wildcards** (`"message.*"`) are implemented, but the DTO validator `@IsIn(AllEvents)` (`webhooks.config.dto.ts:90`) rejects them at session create/update with a 400. So in practice only exact names and `*` are accepted.
- Duplicates are removed. Unknown names are logged and ignored.
- Full list: `session.status, message, message.reaction, message.any, message.ack, message.ack.group, message.waiting, message.revoked, message.edited, state.change, group.join, group.leave, group.v2.join, group.v2.leave, group.v2.update, group.v2.participants, group.v2.participants.join-request, group.v2.participants.tag, presence.update, poll.vote, poll.vote.failed, chat.archive, call.received, call.accepted, call.rejected, label.upsert, label.deleted, label.chat.added, label.chat.deleted, event.response, event.response.failed, engine.event`.

---

## B. Event payloads (NOWEB)

### B.0 What NOWEB emits (`N:2886-3239`)

| WAHA event | Baileys source | Converter |
|---|---|---|
| `session.status` | status setter | `A:299-355` |
| `message` | `messages.upsert` where `!key.fromMe`, after `shouldProcessIncomingMessage`, deduplicated | `N:2904-2927`, `N:3482-3558` |
| `message.any` | `messages.upsert` (both directions) | `N:2926-2928` |
| `message.revoked` | upsert of `protocolMessage.type==REVOKE` | `N:2930-2949` |
| `message.edited` | upsert of edit protocolMessage / `secretEncryptedMessage` edit | `N:2952-2980` |
| `message.reaction` | upsert with `reactionMessage` | `N:2995-2999`, `N:3265-3292` |
| `message.ack` | `messages.update` with `update.status!=null`, key.fromMe only | `N:3013-3017`, `N:3594-3609` |
| `message.ack.group` | `message-receipt.update`, key.fromMe only | `N:3026-3036`, `N:3611-3643` |
| `presence.update` | `presence.update` (plus a synthetic `available` after a "typing" sender's message) | `N:3102-3108`, `N:891-921` |
| `poll.vote` / `poll.vote.failed` | `messages.update.pollUpdates` / an upsert whose poll creation message is unknown | `N:3113-3128`, `N:3645-3726` |
| `group.join` (legacy) | `groups.upsert`; payload = raw Baileys `GroupMetadata` | `N:3066` |
| `group.v2.join/update/participants/leave/participants.join-request` | `groups.upsert` / `groups.update` / `group-participants.update` / `group.join-request` | `N:3068-3100`, `noweb/groups.noweb.ts` |
| `group.v2.participants.tag` | upsert of a member-tag message | `N:2983-2990` |
| `call.received/accepted/rejected` | `call` with status `offer` / `accept` / `reject`\|`terminate` | `N:3134-3182` |
| `label.upsert/deleted`, `label.chat.added/deleted` | `labels.edit` / `labels.association` | `N:3188-3238` |
| `state.change` | raw `connection.update` | `N:3041-3043` |
| `engine.event` | every Baileys event: `{event:"<baileys name>", data:<raw>}` | `N:2890-2899` |
| **Never emitted by NOWEB** | `group.leave`, `chat.archive`, `message.waiting`, `event.response*` | (no source) |

All message-type streams are filtered by the `config.ignore` JidFilter on `key.remoteJid` (`core/utils/jids.ts:88-111`).

### B.1 `session.status` (`A:299-355`, `structures/webhooks.dto.ts:114-143`)

```json
{"name":"u_1_s_2","status":"WORKING",
 "statuses":[{"status":"STARTING","timestamp":1731150000000},{"status":"SCAN_QR_CODE","timestamp":1731150001000},{"status":"WORKING","timestamp":1731150030000}],
 "data":null}
```

- **`statuses`:** the last ≤3 transitions of **this session object**, oldest first, timestamps in ms. A restart creates a new object, so the history resets.
- **`data`:** `null` for most statuses. While WORKING it can be `{"reachoutTimelock":{enforcementType,isActive,timeEnforcementEnds}}` and/or `{"messageCapping":{cappingStatus,totalQuota,usedQuota,cycleStart,cycleEnd,mvStatus,oteStatus}}` (`A:389-419`).
- **Delayed WORKING:** a WORKING without `me.pushName` or `me.id` is delayed by 2 s. Because the stream uses `switchMap`, a newer status inside that window **replaces** it (`A:304-313`).
- **WORKING re-issue:** a WORKING with the same `data` as the previous WORKING is dropped. A WORKING with new data (e.g. capping fetched just after connect) is emitted again, so expect **1–2 WORKING events per connect** (`A:259-275`, `N:615-622`).

### B.2 WAMessage (`message`, `message.any`, and HTTP GET messages)

`toWAMessage` `N:3526-3558`, then `media` and `replyTo.media` are filled in `processIncomingMessage` `N:3482-3514`.

| # | Field | NOWEB value |
|---|---|---|
| 1 | `id` | `buildMessageId(key)` = `` `${fromMe}_${toCusFormat(remoteJid)}_${key.id}` ``, plus `` `_${toCusFormat(key.participant)}` `` **when `key.participant` is non-empty** (`noweb/utils.ts:10-22`). That covers received group messages, including your own messages sent from the phone, and status@broadcast. **API-sent group messages have no suffix**, because Baileys sets only the top-level `participant`, not `key.participant` |
| 2 | `timestamp` | `messageTimestamp` → number, **seconds** |
| 3 | `from` | `toCusFormat(key.remoteJid)`: **always the chat**, including fromMe DMs (the recipient) (`N:4002-4016`) |
| 4 | `fromMe` | `key.fromMe`. Forced to `true` if `key.participant === me.lid` (`N:756-760`) |
| 5 | `source` | `"api"` if `key.id` was generated by a send call in the last 10 min (in-memory cache), otherwise `"app"`. Set on **every** message, incoming too (`modules/waha-message-source/MessageSourceCachePlugin.ts:15-47`, `N:3801-3802`, `N:3852-3856`) |
| 6 | `body` | `extractBody` (`N:4051-4100`), in order: `conversation` → `extendedTextMessage.text` → media `caption` → edited text → `associatedChildMessage` → template/button reply `selectedDisplayText` → list title/description joined by `\n`. Falsy → `null` |
| 7 | `to` | Group: the **group JID**. DM: **key omitted** (undefined), not "me" |
| 8 | `participant` | Group: `toCusFormat(key.participant)` (`…@c.us` or `…@lid`). DM: **omitted** |
| 9 | `hasMedia` | `!!extractMediaContent` (document / image / video / audio / ptv / sticker / template headers / associatedChild) (`noweb/utils.ts:24-50`) |
| 10 | `media` | `null` when there is no media; otherwise see below |
| — | `mediaUrl` | always undefined, so **omitted** |
| 11 | `ack` | `StatusToAck(status)` = `status − 1`. Received → status forced to 3 → **2**. fromMe from the phone → status 2 → **1**. API-sent echo → status 1 → **0** (`N:750-755`, `core/utils/acks.ts:3-9`) |
| 12 | `ackName` | `ERROR(-1) PENDING(0) SERVER(1) DEVICE(2) READ(3) PLAYED(4)`; anything else → `"UNKNOWN"` (`structures/enums.dto.ts:71-89`) |
| 13 | `location` | `null`, or `{live:false, latitude:"<string>", longitude:"<string>", name?, address?, url?, description?(=comment), thumbnail?(b64)}`. Live: `{live:true, latitude, longitude, description(=caption), thumbnail}`. Only the **top-level** `message.locationMessage` is read; an ephemeral wrapper gives `null` (`core/engines/waproto/locaiton.ts:6-34`) |
| 14 | `vCards` | `null`, `[contactMessage.vcard]`, or `contactsArrayMessage.contacts[].vcard` (`core/engines/waproto/vcards.ts`) |
| 15 | `replyTo` | `null`, or `{id: contextInfo.stanzaId /*bare WA id, NOT serialized*/, participant: toCusFormat(contextInfo.participant), body, hasMedia, media:null\|WAMedia, _data: quotedMessage /*proto.Message → toJSON*/}` (`N:3560-3583`) |
| 16 | `_data` | the raw Baileys `WAMessage` (described below) |

There is no `author` field in NOWEB.

**`media`** (`core/media/MediaManager.ts:112-157`, `local/MediaLocalStorage.ts:49-53,91-93`, `local/MediaLocalStorageConfig.ts:7-28`, `config.service.ts:33-41,64-100`):

| Case | Value |
|---|---|
| Downloaded | `{"url":"<base>/api/files/<session>/<key.id>.<ext>","filename":"<doc fileName>"\|null,"mimetype":"image/jpeg"}`. Key order is url, filename, mimetype (`s3` is appended in Plus S3 mode) |
| Not downloaded (disabled or mimetype filtered) | `{"url":null,"filename":…,"mimetype":…}` |
| Error | the same object plus `"error":{…}`. That is the Error JSON-serialized: own enumerable props only, i.e. `details` (the stack string), Boom's `data`/`isBoom`/`isServer`/`output`, and `nonRetriable` |

- **File name:** `<key.id>` is the **bare** WhatsApp id. `ext = mime.extension(mimetype)`: jpeg, png, webp, mp4, oga (for `audio/ogg; codecs=opus`), pdf, …; `application/was` → zip.
- **Base URL:** `<base>` = `WAHA_BASE_URL` (trailing `/` stripped), otherwise `${WHATSAPP_API_SCHEMA||http}://${WHATSAPP_API_HOSTNAME||localhost}:${PORT||WHATSAPP_API_PORT||3000}`.
- **Storage:** files go to `WHATSAPP_FILES_FOLDER` (default `/tmp/whatsapp-files`) and are deleted after `WHATSAPP_FILES_LIFETIME` s (**default 180**; 0 means keep).
- **Media is downloaded before the event is emitted:** the webhook waits for the download (`MediaManager` retries 5× at 1–3 s, then gives up with `error`).
- **Events toggle:** `WAHA_EVENTS_DOWNLOAD_MEDIA`, then `WHATSAPP_DOWNLOAD_MEDIA` (default `true`). Mimetype filter: `WAHA_EVENTS_DOWNLOAD_MEDIA_MIMETYPES`, then `WHATSAPP_FILES_MIMETYPES` (comma-separated prefixes).
- **API toggle:** `WAHA_API_DOWNLOAD_MEDIA[_MIMETYPES]`, overridden per request by `downloadMedia` / `downloadMediaMimetypes`.

**`_data` for a received message.** It is a plain object from Baileys `decodeMessageNode` (`B: Utils/decode-wa-message.ts:228-255,271-291,339-367`), then `cleanMessage` (`B: Utils/process-message.ts:119-137`), then WAHA `fixMessages`:

```json
{"key":{"remoteJid":"123456789012345@lid","remoteJidAlt":"15551234567@s.whatsapp.net","fromMe":false,"id":"3A1B2C3D4E5F60718293",
        "participant":"","addressingMode":"lid"},
 "messageTimestamp":1731150000,"pushName":"Bob","broadcast":false,
 "message":{"conversation":"hello","messageContextInfo":{"deviceListMetadata":{"senderKeyHash":"q83vEjRW","senderTimestamp":"1731000000","recipientKeyHash":"…","recipientTimestamp":"1731000001"},"deviceListMetadataVersion":2,"messageSecret":"base64…"}},
 "status":3}
```

| Key | Notes |
|---|---|
| `key.remoteJid` | normalized: no device; `@s.whatsapp.net` / `@lid` / `@g.us` |
| `key.remoteJidAlt` | DMs only: the other identity (PN for a LID chat, LID for a PN chat) when WhatsApp sends it |
| `key.remoteJidUsername` | optional |
| `key.fromMe` | — |
| `key.id` | — |
| `key.participant` | `""` (**empty string**) in DMs; sender JID in groups |
| `key.participantAlt` | groups only: the sender's alternate identity |
| `key.participantUsername` | optional |
| `key.addressingMode` | `"pn"` \| `"lid"` |
| `key.server_id` | newsletter only |
| `key.isViewOnce` | only if burned view-once |
| `category` | stanza attr, often absent |
| `messageTimestamp` | number |
| `pushName` | — |
| `broadcast` | bool |
| `verifiedBizName` | optional |
| `retryCount` | optional |
| `status` | `2` for fromMe (set at decode, sits before `message`); WAHA sets `3` for incoming, **appended last** |
| `message` | proto JSON: camelCase, longs as strings, bytes as base64, enums as names |
| `messageStubType` / `messageStubParameters` | on decrypt failure. Content-less messages are dropped (`N:3300`) |

- **`_data` for the API-sent echo** (`message.any`, fromMe, `source:"api"`) is the proto `WebMessageInfo` shown in C.5. Example: `{"key":{"remoteJid":"…@s.whatsapp.net","fromMe":true,"id":"3EB0…"},"message":{…},"messageTimestamp":"1731150000","status":"PENDING"[,"participant":"15550000000:12@s.whatsapp.net" (groups)]}`.
- **PN for LID senders.** `from` and `participant` stay `@lid`. The phone number is only in `_data.key.remoteJidAlt` (DM) or `_data.key.participantAlt` (group), as `@s.whatsapp.net`. It can also be looked up with `/lids/{lid}` (`core/utils/jids.ts:118-144`).

**Not emitted as `message`/`message.any`** (`N:3294-3345`):
- reactions, poll votes, calls
- REVOKE, edits, secret-encrypted edits
- history-sync notifications, `EPHEMERAL_SYNC_RESPONSE`, `PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE`
- `deviceSentMessage`
- content-less sender-key distributions

Burned view-once messages (no content) **are** emitted.

**Deduplication:** by `` `${fromMe}_${bareId}` `` over a 60 s window (`core/utils/reactive.ts:44-50`).

Group incoming example (payload only):

```json
{"id":"false_120363012345678901@g.us_3A1B2C3D4E5F60718293_123456789012345@lid","timestamp":1731150000,
 "from":"120363012345678901@g.us","fromMe":false,"source":"app","body":"hi all",
 "to":"120363012345678901@g.us","participant":"123456789012345@lid",
 "hasMedia":false,"media":null,"ack":2,"ackName":"DEVICE","location":null,"vCards":null,"replyTo":null,
 "_data":{"key":{"remoteJid":"120363012345678901@g.us","fromMe":false,"id":"3A1B2C3D4E5F60718293","participant":"123456789012345@lid","participantAlt":"15551234567@s.whatsapp.net","addressingMode":"lid"},"messageTimestamp":1731150000,"pushName":"Bob","broadcast":false,"message":{"conversation":"hi all"},"status":3}}
```

DM incoming: `{"id":"false_15551234567@c.us_3A1B…","timestamp":…,"from":"15551234567@c.us","fromMe":false,"source":"app","body":"hello","hasMedia":false,"media":null,"ack":2,"ackName":"DEVICE","location":null,"vCards":null,"replyTo":null,"_data":{…}}`. There are no `to` or `participant` keys.

### B.3 `message.ack` / `message.ack.group`

**`message.ack`** comes from `messages.update` (`N:3594-3609`). Deduplicated by `${id}-${ack}-${participant}` over 60 s (`core/utils/reactive.ts:6-12`). Keys in order: `id, from, to?, participant?, fromMe, ack, ackName`. **No `_data`.**

```json
{"id":"true_15551234567@c.us_3EB0A1B2C3D4E5F6A7B8","from":"15551234567@c.us","fromMe":true,"ack":3,"ackName":"READ"}
```

The ack value comes from the receipt type (`B: Socket/messages-recv.ts:1468-1523`, `B: Utils/generics.ts:337-354`):

| Receipt | Baileys status | WAHA ack |
|---|---|---|
| DM, no type (delivered) | 3 | **2 DEVICE** |
| `read` | 4 | **3 READ** |
| `played` | 5 | **4 PLAYED** |
| `sender` (own device) | 2 | 1 SERVER |
| `inactive` / unknown types | — | dropped |
| Server error ack (e.g. 463) | 0 (`B:1928-1936`) | **-1 ERROR** |

- **Groups:** errors and `sender` receipts for groups also arrive here. In that case `to` is the group and `participant` is `key.participant`.

**`message.ack.group`** comes from `message-receipt.update`, i.e. group and status receipts per reader (`N:3611-3643`):
- delivered (`receiptTimestamp`) → **ack 1 "SERVER"**. This is a WAHA quirk: it is not 2.
- read or played (`readTimestamp`) → **3 READ**. PLAYED never occurs.
- `id` gets the suffix `_${me.id}` (fromMe) or `_${userJid}`.

```json
{"id":"true_120363012345678901@g.us_3EB0A1B2_15550000000@c.us","from":"120363012345678901@g.us","to":"120363012345678901@g.us",
 "participant":"123456789012345@lid","fromMe":true,"ack":3,"ackName":"READ",
 "_data":{"key":{"remoteJid":"120363012345678901@g.us","id":"3EB0A1B2","fromMe":true,"participant":"123456789012345@lid"},"receipt":{"userJid":"123456789012345@lid","readTimestamp":1731150100}}}
```

### B.4 `message.reaction` (`N:3265-3292`)

```json
{"id":"false_15551234567@c.us_3A9F…","timestamp":1731150000,"from":"15551234567@c.us","fromMe":false,"source":"app",
 "reaction":{"text":"👍","messageId":"true_15551234567@c.us_3EB0…"}}
```

- `to` and `participant` are omitted in DMs. In groups they are the group JID and the reactor.
- `text` is `""` when the reaction is removed.
- `messageId` = `buildMessageId(reactionMessage.key)`, after Baileys normalizes the key to our perspective (`B: Utils/process-message.ts:139-166`).
- There is no `_data`.

### B.5 `message.revoked` (`N:2930-2949`)

`{"after":WAMessage(of the revoke protocol msg: its own id, body null),"before":null,"revokedMessageId":"<bare id of revoked msg>","_data":<raw WAMessage>}`

### B.6 `message.edited` (`N:2952-2980`)

`{...WAMessage(of the edit protocol msg: own id), "body":"<new text>|''", "editedMessageId":"<bare original id>", "_data":<raw>}`

- `body` is overwritten in its original position, and `_data` is reassigned in place.

### B.7 `presence.update` (`N:3743-3765`, `B: Socket/chats.ts:870-896`)

```json
{"id":"15551234567@c.us","presences":[{"participant":"15551234567@c.us","lastKnownPresence":"typing","lastSeen":null}]}
```

- `lastKnownPresence` is one of `offline` (unavailable), `online` (available), `typing` (composing), `recording` (composing with media=audio), `paused`.
- `lastSeen` is in seconds or `null`.
- In groups, `id` is the group JID and there is one entry per participant in the update.

### B.8 `poll.vote` (`N:3645-3693`, `getDestination` `N:4018-4049`)

```json
{"vote":{"id":"false_15551234567@c.us_3A…","to":"me","from":"15551234567@c.us","fromMe":false,"selectedOptions":["Yes"],"timestamp":1731150000123},
 "poll":{"id":"true_15551234567@c.us_3EB0…","to":"15551234567@c.us","from":"me","fromMe":true}}
```

- **DM sides:** the "me" side of a DM is the literal string `"me"`. In groups, `from` = participant and `to` = group.
- **Timestamps:** `vote.timestamp` is in **ms**. For `poll.vote.failed` it is `messageTimestamp` (seconds) and `selectedOptions` is `[]`.
- There is no `_data` and no `participant`.

### B.9 Groups (`noweb/groups.noweb.ts`)

All group timestamps are `Date.now()`, in **ms**.

| Event | Payload |
|---|---|
| `group.v2.join` | `{timestamp, group: GroupInfo, _data: GroupMetadata}`. `GroupInfo` = `{id, subject, description, invite: "https://chat.whatsapp.com/<code>"\|undefined, participants:[{id, pn, role}]\|undefined, membersCanAddNewMember, membersCanSendMessages, newMembersApprovalRequired}`, where the last three are the **raw** Baileys `memberAddMode`, `announce`, `joinApprovalMode` (`:31-54`) |
| `group.v2.update` | `{timestamp, group: GroupInfo(partial; unset keys omitted), _data}` (`:165-173`) |
| `group.v2.participants` | `{group:{id}, type:"join"\|"leave"\|"promote"\|"demote", timestamp, participants:[{id: toCusFormat, pn: c.us\|null, role}], _data:{id, author, participants, action}}`. Roles: add→`participant`, remove→`left`, promote→`admin`, **demote→`admin`** (`:121-163`) |
| `group.v2.leave` | `{timestamp, group:{id}, _data}`. Only on `remove` when me.id or me.lid is among the participants (`:258-279`) |
| `group.v2.participants.join-request` | `{group:{id}, action:"created"\|"rejected"\|"revoked", requesterId, requesterPn\|null, requestMethod, timestamp, _data}` (`:238-256`) |
| `group.join` | raw Baileys `GroupMetadata` |

### B.10 Calls (`N:3728-3741`)

`{"id":"<call id>","from":"15551234567@c.us","timestamp":1731150000,"isVideo":false,"isGroup":false,"_data":{chatId, from, id, date:"ISO", offline, status:"offer"|…, isVideo, isGroup, groupJid?, …}}`

- `call.rejected` fires on `reject` or `terminate`. It is skipped if the call was accepted, and debounced 1 s per call id.

### B.11 Labels, engine and state

- **`label.upsert` / `label.deleted`:** `{id, name, color:<int>, colorHex:"#RRGGBB", type?, isActive?}` (`N:2002-2012`).
- **`label.chat.added` / `label.chat.deleted`:** `{labelId, chatId: c.us, label: Label|null}`.
- **`engine.event`:** `{event, data}`.
- **`state.change`:** raw `connection.update`.

---

## C. HTTP API (NOWEB)

### C.0 Conventions
- **Auth:** the `X-Api-Key` header (or `?x-api-key=`) on all `/api/*` routes, including `/api/files`.
- **Status codes:** NestJS defaults. **Every POST answers `201`**, even start/stop/sendSeen; GET, PUT and DELETE answer `200`. A handler returning `null`/`undefined` gives an empty body.
- **Validation of `/api/send*`, `/api/sendSeen`, `/api/startTyping`, `/api/reaction`:** there is no validation pipe (`api/chatting.controller.ts:77-282`). DTO defaults (`session="default"`, `text`, `linkPreview`) are **not** applied, so `session` must be sent. If it is missing → 422 `{"error":"Session name is required"}`.
- **Validation elsewhere:** the sessions, chats, contacts/all and lids routes use ValidationPipe with transform and whitelist, so query defaults apply.
- **Session must be WORKING** for send / chats / contacts / lids. `waitUntilStatus` waits up to 5 s for it to be running, then 10 s for the status (`core/abc/manager.abc.ts:168-220`).

Error bodies (`nestjs/AllExceptionsFilter.ts:29-80`; for HttpException the body is `exception.getResponse()`):

| Case | Code | Body |
|---|---|---|
| Not running / wrong status | 422 | `{"error":"Session status is not as expected. Try again later or restart the session","session":"x","status":"STARTING","expected":["WORKING"]}`. When not running, `status` is `"STOPPED"` |
| Missing session (WORKING routes) | 422 | `{"error":"Session \"x\" does not exist","session":"x"}` |
| Not running (any-status routes: `/me`, request-code) | 404 | `{"message":"We didn't find a session with name 'x'.\nPlease start it first by using POST /api/sessions/x/start request","error":"Not Found","statusCode":404}` (`core/manager.core.ts:490-499`) |
| Session info, start, restart, logout, update of a missing session | 404 | `{"message":"Session not found","error":"Not Found","statusCode":404}` |
| String `UnprocessableEntityException` | 422 | `{"message":"<text>","error":"Unprocessable Entity","statusCode":422}` |
| DTO validation | 400 | `{"message":["<constraint msg>",…],"error":"Bad Request","statusCode":400}` |
| Not implemented by engine | 501 | `{"message":"The method is not implemented by 'NOWEB' engine. Check the docs …","error":"Not Implemented","statusCode":501}` |
| Any other throw (Baileys Boom, network, …) | 500 | `{"statusCode":500,"timestamp":"ISO","exception":{"message":"…","name":"Error",…ownProps,"stack":"…"},"request":{"path","method","body","query"},"version":{…VERSION}}` |
| Missing file | 404 | `{"error":{"code":404,"key":"FILE_NOT_FOUND","message":"File not found","details":"File not found or no longer available"}}` |

### C.1 Sessions (`api/sessions.controller.ts`, `core/services/SessionService.ts`, `core/manager.core.ts`)

**Create: `POST /api/sessions` → 201 SessionDetailedInfo**

```json
{"name":"u_1_s_2","start":false,
 "config":{"webhooks":[{"url":"https://h/x","events":["*"]}],"metadata":{"k":"v"},
           "noweb":{"store":{"enabled":true,"fullSync":true},"markOnline":true},
           "proxy":null,"debug":false,"ignore":{"status":null,"groups":null,"channels":null,"broadcast":null},
           "client":{"deviceName":"MacOS","browserName":"Firefox"}},
 "apps":null}
```

- **`name`:** `^[a-zA-Z0-9_-]*$`, max 54 (`nestjs/validation/SessionName.ts`). If missing, a `session_<ulid>` name is generated.
- **`start`:** starts the session **only if `start===true`**. Swagger says default true, but the code is `if (request.start)`, so omitting it means not started (`SessionService.ts:64`).
- **Existing name:** 422 `"Session 'x' already exists. Use PUT to update it."`
- **Stored config:** the validated class instance, so class defaults are materialized (`noweb.markOnline:true`, `store.enabled/fullSync:false` if a partial `store` is given).
- **Lifecycle routes:**
  - `PUT /api/sessions/{name}` with `{config, apps?}` stops, saves and restarts if it was running → 200.
  - `POST …/start` → 201 info (STARTING). It is idempotent: a running session, including a FAILED one, is **not** restarted.
  - `POST …/stop` → 201 info (STOPPED).
  - `POST …/restart` → 201 (stop then start) (`core/abc/manager.abc.ts:112-122`).
  - `POST …/logout` (body optional `{apps:{purge:bool}}`) → unpair, stop, wipe auth and me, restart if it was running → 201 info.
  - `DELETE …` → unpair, stop, wipe, delete → **200 empty**.

**SessionInfo:**
- **Runtime session** (`modules/waha-session-runtime-info/SessionRuntimeInfoPlugin.ts:11-23`, `MaintainOnlineStatusPlugin.ts:26-33`): `{"name","status","config","me":MeInfo|null,"presence":"online"|"offline"|null,"timestamps":{"activity":<ms of last API activity>|null}}`.
- **Stopped session, read from the DB** (`core/manager.core.ts:521-545`): `{name, status:"STOPPED", config|null, me:<last persisted me>|null, presence:null, timestamps:{activity:null}}`. `me` is persisted from every `session.status` event that has `me` (`manager.core.ts:222-231`).

| Endpoint | Shape |
|---|---|
| `GET /api/sessions?all=true` | `SessionInfo[]`, each with `assignedWorker` (omitted if none) and **no `engine`**. Without `all` only running sessions are listed (`manager.core.ts:547-569`) |
| `GET /api/sessions/{name}` and the start/stop/restart/logout/create responses | SessionInfo + `"engine":{"engine":"NOWEB"}` when running, `"engine":{}` when stopped. NOWEB has no `getEngineInfo` (`manager.core.ts:571-622`) |
| `GET /api/sessions/{name}/me` | MeInfo, or an empty 200 body; 404 if not running |

```json
{"name":"u_1_s_2","status":"WORKING","config":{…},
 "me":{"id":"15550000000@c.us","pushName":"Acme","lid":"123456789012345@lid","reachoutTimelock":null,"messageCapping":{"cappingStatus":"NONE","totalQuota":-1,"usedQuota":0,"cycleStart":null,"cycleEnd":null,"mvStatus":null,"oteStatus":null}},
 "presence":"online","timestamps":{"activity":1731150000123},"engine":{"engine":"NOWEB"}}
```

**MeInfo** (NOWEB `N:965-978`): `{id: toCusFormat(creds.me.id), pushName: creds.me.name, lid: jidNormalizedUser(creds.me.lid) /* "" if none */, reachoutTimelock, messageCapping}`. NOWEB has **no `jid`**.

### C.2 Auth (`api/auth.controller.ts`)

**`GET /api/{s}/auth/qr`** requires status SCAN_QR_CODE (waits ≤10 s, otherwise 422 as in C.0). Response depends on the request:

| Request | Response |
|---|---|
| default | raw PNG, `Content-Type: image/png` |
| header `Accept: application/json` (exact string) | `{"mimetype":"image/png","data":"<base64 png>"}` (`nestjs/BufferResponseInterceptor.ts:42-66`) |
| `?format=raw` | `{"value":"2@AbC…,…"}` |

**`POST /api/{s}/auth/request-code`** with `{"phoneNumber":"15551234567","method":null}`:
- Any `method` → 422.
- If STARTING, it waits for the first QR; if not SCAN_QR_CODE afterwards → 422 `"Can request code only in SCAN_QR_CODE status. The current status is X"`.
- Success → 201 `{"code":"ABCD-EFGH"}` (`N:991-1018`).

**`GET /api/screenshot?session=`:** NOWEB returns the QR PNG while in SCAN_QR_CODE (sent with `Content-Type: image/jpeg`). Otherwise 422 (`N:1020-1034`, `api/screenshot.controller.ts:36`).

### C.3 Chats and messages (`api/chats.controller.ts`; ValidationPipe with transform)

**`GET /api/{s}/chats?limit=20&offset&sortBy=conversationTimestamp|id|name&sortOrder=desc|asc&merge=true`**
- Defaults: limit 20, sort `conversationTimestamp desc`.
- Returns **raw store Conversation objects minus `unreadCount`**, with **no id conversion**: `id` is `…@s.whatsapp.net`, `…@g.us` or `…@lid` (`N:1801-1807`).
- With `merge=true`, LID and PN rows are deduplicated and `id` is replaced by the PN JID when mapped (`store/sql/SqlChatMethods.ts:10-63`).
- Only chats with a non-null `conversationTimestamp` are returned; `@broadcast` and `@newsletter` are included in `/chats`.
- Fields are whatever Baileys/history gave: `id, conversationTimestamp(number s), name?, archived?, pinned?, muteEndTime?, ephemeralExpiration?, pnJid?, lidJid?, readOnly?, notSpam?, tcToken?{type,data}, …`.

```json
[{"id":"15551234567@s.whatsapp.net","conversationTimestamp":1731150000,"name":"Bob"}]
```

**`GET /api/{s}/chats/overview?limit=20&offset=0&ids=a,b&merge=true`** (also `POST …/overview` with `{pagination, filter:{ids}}`):
- Returns `[{"id":"15551234567@c.us","name":"Bob"|null,"picture":"https://pps.whatsapp.net/…"|null,"lastMessage":WAMessage|null,"_chat":{raw chat}}]` (`N:1809-1872`). Broadcasts and newsletters are excluded.
- `name` = chat.name, otherwise contact `name`, otherwise `notify`.
- `picture` is fetched from WhatsApp and cached 24 h.
- `lastMessage` is fetched with `downloadMedia:false`.

**`GET /api/{s}/chats/{chatId}/messages`**
- Query: `limit=10`, `offset`, `sortOrder=desc`, `downloadMedia`, `downloadMediaMimetypes=a,b`, `merge=true`, `filter.timestamp.lte`/`gte` (seconds), `filter.fromMe=true|false`, `filter.ack=ERROR|PENDING|SERVER|DEVICE|READ|PLAYED` (matched against stored `status = ack+1`).
- Results are always sorted by `messageTimestamp` (`sortBy` is ignored by the store; `store/NowebPersistentStore.ts:708-717`).
- Returns `WAMessage[]` as in B.2, but `_data` is the stored plain object: numbers, not strings, and Buffers as `{"type":"Buffer","data":"b64"}`. Media is downloaded synchronously when enabled.
- Reactions, protocol messages and the like are filtered out (`N:1664-1691`).

**`GET /api/{s}/chats/{chatId}/messages/{messageId}?downloadMedia=&merge=`**
- `messageId` may be serialized or bare; only its bare id is used.
- Returns a WAMessage, or 404 `{"message":"Message not found","error":"Not Found","statusCode":404}` (`api/chats.controller.ts:161-177`, `N:1701-1717`).

**`PUT /api/{s}/chats/{chatId}/messages/{messageId}`** with `{"text":"new","mentions":["…@c.us"],"linkPreview":true,"linkPreviewHighQuality":false}`:
- `messageId` must be serialized (3–4 parts), otherwise 500.
- Returns 200 with the raw proto `WebMessageInfo` of the edit message (C.5 shape; `message.protocolMessage{key, type:"MESSAGE_EDIT", editedMessage, timestampMs}`) (`N:1169-1234`).

### C.4 Contacts and LIDs

**`GET /api/contacts/all?session=&limit&offset&sortBy=id|name&sortOrder`** (no default limit) returns raw Baileys store contacts (`N:2075-2078,3585-3592`):

```json
[{"id":"15551234567@c.us","lid":"123456789012345@lid","name":"Bob Saved","pushname":"Bob"},
 {"id":"987654321098765@lid","phoneNumber":"15557654321@s.whatsapp.net","pushname":"Ann","imgUrl":null}]
```

- Possible keys (`B: Types/Contact.ts`): `id` (toCusFormat; may be `@lid`), `lid`, `phoneNumber` (**raw `@s.whatsapp.net`**), `name`, `username`, `verifiedName`, `imgUrl`, `status`, `pushname` (renamed from `notify`, appended last, omitted if undefined).
- **No** `number`, `shortName`, `isMe`, `isUser`, `isGroup`, `isWAContact`, `isMyContact` or `isBusiness` (those are WEBJS fields).
- `GET /api/contacts?contactId=&session=` returns one such object, or an empty body.

**`GET /api/contacts/check-exists?phone=&session=`** (`N:1105-1118`): `phone` has `@…` and `+` stripped.
- Exists → `{"numberExists":true,"chatId":"15551234567@c.us"}`.
- Does not exist → `{"numberExists":false}`; there is no `chatId` and no `pn` key.

**`GET /api/contacts/profile-picture?contactId=&session=&refresh=false`** → `{"profilePictureURL":"https://pps.whatsapp.net/v/…"|null}`.
- `null` covers no picture, privacy restrictions and fetch errors.
- The URL is cached 24 h per id (`A:917-954`, `api/contacts.controller.ts:84-99`).

**LIDs** (`api/lids.controller.ts:40-112`, `N:2111-2147`):

| Endpoint | Response |
|---|---|
| `GET /api/{s}/lids?limit=100&offset=0` | `[{"lid":"123@lid","pn":"15551234567@c.us"}]`, sorted by lid ascending |
| `GET /api/{s}/lids/count` | `{"count":N}` |
| `GET /api/{s}/lids/{lid}` | `{"lid":"123@lid","pn":"15551234567@c.us"|null}`. Bare digits get `@lid` appended; anything else not ending in `@lid` → 422 `"Invalid LID - it must end with @lid"` |
| `GET /api/{s}/lids/pn/{pn}` | `{"lid":"123@lid"|null,"pn":"15551234567@c.us"}`. If `{pn}` is an `@lid`, the response is `{"lid":"<it>","pn":null}` |

### C.5 Sending (NOWEB returns the raw Baileys proto; `api/chatting.controller.ts`)

Shared body fields: `session` (required), `chatId` (`123`, `123@c.us`, `…@lid`, `…@g.us`), `reply_to` (a serialized or bare id; the quoted message is loaded from the store), and `id` (optional custom message id). `mentions: ["all"]` expands to every participant except me. It is accepted only on sendText / sendImage / sendFile / sendVideo with a group chatId; otherwise 422 (`core/utils/mentions.all.ts:6-20`).

| Endpoint | Body | Baileys content (`N:` line) |
|---|---|---|
| `POST /api/sendText` | `{chatId,text,reply_to?,linkPreview?,linkPreviewHighQuality?,mentions?}`. `linkPreview:false` disables the preview; anything else lets Baileys generate one | `{text,mentions,linkPreview}` → `extendedTextMessage` (1131-1152, 3836-3850) |
| `POST /api/sendImage` | `{chatId,file:{mimetype,filename?,url\|data},caption?,mentions?,reply_to?}` | `imageMessage` (1288-1323) |
| `POST /api/sendFile` | same as sendImage | `documentMessage{fileName,mimetype (sniffed if missing),caption}` (1326-1348) |
| `POST /api/sendVoice` | `{chatId,file,convert?,reply_to?}` | `audioMessage{ptt:true,mimetype default "audio/ogg; codecs=opus"}`; `convert:true` transcodes with ffmpeg (1351-1364) |
| `POST /api/sendVideo` | `{chatId,file,caption?,asNote?,convert?,mentions?,reply_to?}` | `videoMessage{seconds,gifPlayback? (if image/gif),ptv:asNote}` (1367-1404) |
| `POST /api/sendLocation` | `{chatId,latitude:number,longitude:number,title?,reply_to?}` | `locationMessage{degreesLatitude,degreesLongitude,name}` (1578-1592) |
| `POST /api/sendContactVcard` | `{chatId,contacts:[{vcard}\|{fullName,organization,phoneNumber,whatsappId}],reply_to?}` | `contacts:{contacts:[{vcard}]}`; 1 → `contactMessage`, more → `contactsArrayMessage` (1237-1246) |
| `PUT /api/reaction` (200) | `{session,messageId:<serialized, 3–4 parts>,reaction:"👍"\|""}` | `reactionMessage{key,text}` (1750-1780) |

- **`file`:** `url` is fetched by WAHA; `data` is base64 (`N:1500-1523`).

Response (all of the above) = `proto.WebMessageInfo` JSON:

```json
{"key":{"remoteJid":"15551234567@s.whatsapp.net","fromMe":true,"id":"3EB0A1B2C3D4E5F6A7B8C9"},
 "message":{"extendedTextMessage":{"text":"Hi there!"}},
 "messageTimestamp":"1731150000","status":"PENDING"}
```

- **`key.remoteJid`** is the engine JID (`@s.whatsapp.net` / `@lid` / `@g.us`).
- **There is no top-level `id`.** Callers must build `true_<toCusFormat(remoteJid)>_<key.id>` themselves.
- **Groups** add `"participant":"15550000000:12@s.whatsapp.net"`, with the device suffix.
- **Reply / ephemeral:** a reply adds `…contextInfo{stanzaId,participant,quotedMessage[,remoteJid]}`; an ephemeral chat adds `contextInfo.expiration` (`B: Utils/messages.ts:730-783`).
- **Media fields:** `url, mimetype, caption?, fileSha256(b64), fileLength:"<string>", height?, width?, mediaKey(b64), fileName?, fileEncSha256(b64), directPath, mediaKeyTimestamp:"<string>", jpegThumbnail?(b64), seconds?, ptt?`.

Other send-side endpoints:
- **`POST /api/sendSeen`** with `{session, chatId, messageIds?:[serialized], messageId?, participant?}` (`api/chatting.controller.ts:243-257`, `N:1629-1644`, `core/utils/convertors.ts:12-42`):
  - With ids: `fromMe` ids are skipped, then `readMessages` → **201 empty body**. Non-serialized ids throw → 500.
  - Without ids: reads unread incoming messages from the last 7 days (limit 30 for DMs; 100 for groups or when `messages` is given) → 201 `{"ids":["false_…",…]}`.
- **`POST /api/startTyping`** and **`/api/stopTyping`** with `{session, chatId}` send presence `composing` / `paused` → 201 `{"result":true}` (`N:1647-1662`).
- **`GET /api/files/{session}/{bareMsgId}.{ext}`** is served from disk by `@nestjs/serve-static`, with the mime type taken from the extension (`core/media/local/media.local.storage.module.ts`).

---

## D. Session status model (NOWEB)

- **Statuses:** `STOPPED`, `STARTING`, `SCAN_QR_CODE`, `WORKING`, `FAILED`. Also `PASSKEY_REQUIRED` / `PASSKEY_CONFIRMATION_REQUIRED`, which only GOWS sets (`structures/enums.dto.ts:46-54`).
- **Every `setStatus` emits `session.status`,** with these exceptions:
  - a duplicate WORKING carrying identical `data`;
  - anything except STOPPED while unpairing (logout/delete);
  - anything after the event streams are completed. `failed()` and `stop()` call `stopEvents()`, so after FAILED **no further webhooks**, not even STOPPED, come from that session object (`A:389-419`, `utils/reactive/SwitchObservable.ts`).

| Trigger | Transition | Source |
|---|---|---|
| `start()` | → STARTING. `buildClient` throwing → FAILED, then retried after 2 s (→ STARTING) | `N:381-389` |
| QR emitted (first after ~0 s, then each refresh: 60 s, then 20 s × ~5) | → SCAN_QR_CODE. **A webhook fires on each refresh** | `N:677-682`, `B: Socket/socket.ts:901-922` |
| QR scanned (`isNewLogin`) / `restartRequired` (515) | after 2 s: end + start → STARTING → WORKING | `N:604-606,633-638,574-592` |
| `connection:'open'` | → WORKING; QR cleared; timelock and capping fetched (may re-emit WORKING with `data`) | `N:606-627` |
| QR timed out (408, "QR refs attempts ended") while SCAN_QR_CODE | → **FAILED**; socket ended; events completed; no auto-retry | `N:649-656` |
| close with `loggedOut` (401, e.g. unlinked from the phone) | → **FAILED**; auth is **kept** (call logout to wipe) | `N:658-674` |
| any other close (network, 428/440/500/503, …) | status stays as it was for 2 s, then end + start → STARTING → WORKING | `N:658-668` |
| 60 consecutive STARTINGs without another status | → FAILED (stuck guard) | `N:640-647`, `utils/StatusTracker.ts:3-24` |
| `stop()` | creds saved → STOPPED (emitted) → events completed. GET then shows STOPPED from the DB | `N:686-705` |
| `logout` / `DELETE` | `unpair()` → `sock.logout()`; FAILED is suppressed; stop → STOPPED; auth wiped; logout restarts → STARTING → SCAN_QR_CODE | `N:391-395`, `SessionService.ts:105-154` |
| `restart` | stop (STOPPED on the old object) → new object STARTING… | `core/abc/manager.abc.ts:112-122` |

- **A FAILED session stays "running":** it is still in the runtime map. `POST start` is a no-op for it; use `restart`, or `stop` then `start`.
- **There is no auto-restart from FAILED** in Core (`manager.core.ts:329-406`).

---

## E. GOWS (whatsmeow) mapping notes

Paths below are relative to `core/engines/gows/`; `G:` = `session.gows.core.ts`.

### E.1 Transport and events
- **Stream format:** the sidecar streams `{session, event:"<Go type name>", data:"<json string>"}` (`GowsEventStreamObservable.ts:87-93`). Event names are in enum `WhatsMeowEvent` (`G:254-299`).
- **Never streamed:** `events.AppState*`, `HistorySync`, `Contact` (`G:402-408`).

| whatsmeow event | WAHA |
|---|---|
| `gows.ConnectedEventData` | WORKING, sets `me` (`G:430-439`) |
| `events.Disconnected`, `KeepAliveTimeout` | STARTING (if it isn't already) (`G:441-452`) |
| `KeepAliveRestored` | WORKING |
| `whatsmeow.QRChannelItem` | `code` → SCAN_QR_CODE (each rotation); `passkey-*` → PASSKEY_*; `timeout` / `err-*` → FAILED (`G:458-507`) |
| `LoggedOut`, `TemporaryBan`, `ClientOutdated`, `ConnectFailure`, `CATRefreshError`, `StreamReplaced` | `setStatus(FAILED, {reason:{…data, event}})`, no restart (`G:511-546`) |
| `events.Message` | message / message.any / revoked / edited / reaction / member-tag (`G:633-758`) |
| `events.Receipt` | `receiptToMessageAck` (`G:3371-3420`) |
| `events.Presence`, `ChatPresence` | presence.update (`G:558-583`, `G:2315-2361`) |
| `CallOffer(+Notice)` / `CallAccept` / `CallReject`+`CallTerminate` | call.received / accepted / rejected; debounced 1 s; `*_elsewhere` reasons skipped (`G:784-804`, `G:3237-3274`) |
| `JoinedGroup`, `GroupInfo`, `gows.GroupJoinRequestEvent` | group.v2.join, leave/participants/update, join-request (`groups.gows.ts:31-248`) |
| `LabelEdit`, `LabelAssociationChat` | label.* (`labels.gows.ts:9-31`) |
| `gows.PollVoteEvent` | poll.vote or poll.vote.failed (decrypted by the sidecar) (`G:881-896,3190-3221`) |
| any event | engine.event `{session, event:"events.Message", data}` (`G:631`) |

### E.2 GOWS `toWAMessage` (`G:3143-3188`)

| Field | Rule |
|---|---|
| `Status` (pre-set) | fromMe → 2, otherwise 3 (`G:640-656`) |
| `id` | `${IsFromMe}_${toCusFormat(Chat)}_${ID}`, plus `_${toCusFormat(Sender)}` **whenever `Info.IsGroup`**, own messages included (`G:3637-3645`) |
| `timestamp` | `floor(Date(Info.Timestamp)/1000)`; a `0001-…` timestamp → null |
| `from` | `toCusFormat(Info.Chat)` |
| `to` / `participant` | group: Sender; DM: **`null`** (`G:3618-3626`) |
| `source` | fromMe and Sender device == `me.jid` device → `"api"`, otherwise `"app"` (`G:3307-3316`) |
| `ack` | `Status−1`; ERROR is turned into `null`/`"UNKNOWN"` (`helpers.ts:26-42`) |
| `location` / `vCards` | from `GoToJSWAProto(Message)` (`waproto.ts:18-23`) |
| key order | `…, ack, location, vCards, ackName, replyTo, _data` |
| `replyTo` | `{id: contextInfo.stanzaID, participant, body, hasMedia, media, _data}` (`G:3318-3338`) |

**`_data`** is the raw whatsmeow `events.Message` as Go JSON, plus `Status`:

```json
{"Info":{"Chat":"111@s.whatsapp.net","Sender":"111:3@s.whatsapp.net","IsFromMe":false,"IsGroup":false,"AddressingMode":"","SenderAlt":"","RecipientAlt":"","BroadcastListOwner":"","BroadcastRecipients":null,"ID":"3EB0…","ServerID":0,"Type":"text","PushName":"Bob","Timestamp":"2026-11-09T10:00:00Z","Category":"","Multicast":false,"MediaType":"","Edit":"","VerifiedName":null,"DeviceSentMeta":null},
 "Message":{"conversation":"hi","messageContextInfo":{…}},"IsEphemeral":false,"IsViewOnce":false,"IsEdit":false,"RetryCount":0,"Status":3}
```

- Inside `Message` the casing is whatsmeow's protojson-like camelCase, but with Go-style acronyms (`remoteJID`, `stanzaID`, `URL`). Enums are numbers.

### E.3 GOWS acks (`G:3371-3420`)

| `Receipt.Type` | ack |
|---|---|
| `""` / `inactive` / `active` | 2 DEVICE |
| `read` | 3 |
| `played` | 4 |
| `server-error` | -1 |
| `sender`, `retry`, `read-self`, `played-self`, `peer_msg`, `hist_sync` | dropped |

- One event per `MessageIDs[]` entry.
- `id` = built with `IsFromMe: !receipt.IsFromMe` and `Sender: MessageSender||me.id`.
- Groups go **only** to `message.ack.group`.
- `_data` = the flat Receipt JSON.

### E.4 NOWEB vs GOWS differences (production is NOWEB: copy the NOWEB column)

| Item | NOWEB | GOWS |
|---|---|---|
| Group msg `to` | group JID | sender JID |
| DM `to` / `participant` | **omitted** | `null` |
| Group id suffix on own API-sent msgs | **none** | always `_me` |
| `_data` | Baileys `WAMessage` (`key{remoteJid,remoteJidAlt,participant,participantAlt,addressingMode}`, `messageTimestamp`, `pushName`, `message`) | whatsmeow `{Info{Chat,Sender,SenderAlt,RecipientAlt,…},Message,…}` |
| PN of a LID sender | `_data.key.remoteJidAlt` / `participantAlt` | `_data.Info.SenderAlt` / `RecipientAlt` |
| `message.ack` | from `messages.update`: DMs plus group errors; can be 1 SERVER; **no `_data`**. `.ack.group`: delivered = **1 SERVER**, read = 3 | receipts only; groups → `.ack.group`; delivered = 2; always `_data` |
| `source` | id cache of API sends | device-id compare |
| Send response | raw proto `{key,message,messageTimestamp:"str",status:"PENDING"}` | `{id, _data:{Info,Message}}` |
| `me` | no `jid`; `lid` `""` if unknown | has `jid` (`…:dev@s.whatsapp.net`) |
| FAILED `data` | `null` | `{reason:{…}}` |
| Auto-reconnect | WAHA restarts the socket (STARTING → WORKING) | whatsmeow reconnects (Disconnected → STARTING → WORKING) |
| check-exists | `{numberExists,chatId?}` | `{numberExists,chatId,pn}` |
| contacts | raw Baileys contact (`id,lid?,phoneNumber?,name?,pushname?…`) | `{id,name,pushname}` |
| chats | raw Conversation, ids `@s.whatsapp.net` | `{id,name,conversationTimestamp}` |
| request-code | `"ABCD-EFGH"` | as the sidecar formats it |
| `group.v2.participants` demote role | `admin` | `participant` |
| `group.v2.*` `membersCanSendMessages` | raw `announce` | `!IsAnnounce` (update) |
| `group.v2.*` invite | full `https://chat.whatsapp.com/…` link | raw link value |
| `engine.event` | `{event,data}` | `{session,event,data}` |
| legacy `group.join` | emitted | not emitted |
| `edited` secret-encrypted edits | decoded | not decoded |

**For a whatsmeow implementation targeting NOWEB shapes:**
- Map `events.Message` to a Baileys-like `_data`:
  - `key.remoteJid` = Chat with no device, `@s.whatsapp.net`, or `@lid`
  - `key.remoteJidAlt` = SenderAlt (DM)
  - `key.participant` = `""` in DMs, Sender in groups
  - `key.participantAlt` = SenderAlt (group)
  - `key.addressingMode` = `"lid"` \| `"pn"`
  - `messageTimestamp` = Unix seconds as a number
  - `pushName`
  - `broadcast`
  - `message` = the proto encoded protobufjs-JSON style: lowerCamel field names, int64 as strings, bytes as base64, enum names
  - `status` = 3 incoming / 2 fromMe-from-phone
- Ack from receipts as in B.3:
  - DM: delivered → 2, read → 3, played → 4, sender → 1, server error → -1, on `message.ack` with no `_data`.
  - Group: delivered → 1, read/played → 3, on `message.ack.group` with `_data:{key,receipt:{userJid, receiptTimestamp|readTimestamp}}`.
- Send responses must mimic `WebMessageInfo.toJSON`.
