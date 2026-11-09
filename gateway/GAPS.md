# Known gaps against the contract

Ordered by how much they matter for moving WAHooks onto the gateway. "API" means the WAHooks API calls or reads it;
"customer" means it only reaches customers through webhooks or pass-through responses.

## Needs work before production traffic

| Gap | Who notices | Notes |
|---|---|---|
| Existing NOWEB sessions move with a converter, not tested at scale | every customer | [`../migrate`](../migrate) converts WAHA's stored Baileys credentials into the gateway's store without a re-scan. It is tested offline; production moves start with one connection. |
| WAHooks API changes not made | — | Register boxes as workers (private IP, shared key, capacity); `workers/` scaling assumes the WAHA StatefulSet. No code changes are needed in `waha.service.ts`. |
| `poll.vote` untested live | customer | Implemented (whatsmeow `DecryptPollVote`, option names from the stored poll; `poll.vote.failed` when the poll isn't in history or can't be decrypted), but no poll has been voted on in a live test yet. |
| Link previews only from pages reachable over the box's network | customer | Implemented (title, description, og:image thumbnail), but an IPv6-only box can't fetch IPv4-only sites, which then get no preview. `linkPreviewHighQuality` (uploaded full-size preview image) is not implemented. |
| `sendVoice` `convert`, `sendVideo` `convert`/`asNote`, GIF playback; video thumbnails | customer | Voice must already be OGG/Opus; video gets no duration or thumbnail. Images do get a thumbnail. |
| Media isn't downloaded before the event; `media.error` is never set | customer | By design (DECISIONS 15): the URL downloads on demand. A file WhatsApp no longer has gives 404 at fetch time instead of `media.error` in the event. `downloadMediaMimetypes` is ignored. |
| IPv6-only boxes can't fetch IPv4-only `file.url`s | customer | WAHA's pods are dual-stack. Fix with NAT64/DNS64 on the box, a dual-stack egress proxy for `file.url`, or the API sending `file.data`. Webhooks to the API need `WAGW_WEBHOOK_RESOLVE` until it has an AAAA record. |
| Lease has no fencing, and losing it doesn't stop the client | ops | Boxes only load their own rows and refuse to start, log out or delete an account another box holds; but a box whose lease renewal fails keeps its clients running, and two boxes could overlap for one renewal interval if clocks or the database misbehave. Fine while the API assigns each account to one box; add a fencing token and stop-on-lost-lease before automatic failover. |
| A panic inside whatsmeow's own goroutines ends the process | ops | All of the box's accounts reconnect (~1 s each, 8 at a time). Mitigations: canary box, two processes per box. |
| whatsmeow's shared LID map cache is unbounded by default | density | Every PN↔LID pair (and miss) any account has seen stays in memory. `WAGW_LID_CACHE_MAX` swaps in a bounded store with whatsmeow's SQL (tested on SQLite and Postgres); left off by default until the density benchmark shows it matters. |
| Abuse controls from the plan (rate limits to non-contacts, fan-out limits, quarantine on 402) | ops | Not started. |

## Smaller differences

| Gap | Notes |
|---|---|
| `mentions: ["all"]`, custom message `id` in send bodies, `linkPreviewHighQuality` | Ignored. Mentions of specific JIDs work. |
| `/chats` `sortBy=id|name`, `merge`; `/chats/overview` `ids` filter | Sorted by last activity only; LID and PN chats of one person stay separate rows (reads by either id find both). |
| `picture` in `/chats/overview` | Only from the profile-picture cache (filled by `/api/contacts/profile-picture`), else `null`; NOWEB fetches each one. The API doesn't read it. |
| History | Only what the phone sends at link time (7 days, ≤ 50 per chat by default) plus live traffic. No on-demand fetch of older messages. Sessions adopted from the native harness have no history before the move. |
| `me.reachoutTimelock`, `me.messageCapping`, `session.status` `data` | Always `null`. |
| `config.proxy`, `config.client.deviceName`, `apps`, `noweb.markOnline` | Stored and echoed, not applied (device name and mark-online are box-wide settings). `config.ignore` (status, groups, channels, broadcast) is applied. |
| Events not emitted | `label.*`, `group.v2.participants.join-request`, `group.v2.participants.tag`, legacy `group.join`, `engine.event`, `state.change`. (`chat.archive`, `group.leave`, `message.waiting` aren't emitted by NOWEB either.) |
| API-sent reactions and edits | Not echoed as events; NOWEB's handling of its own sends isn't certain from the Core source. |
| NOWEB's synthetic `available` presence after a typing sender's message; the 2 s delay of a WORKING without `pushName` | Not reproduced. |
| Webhook `_data` Buffers outside `message` | Base64 strings rather than `{"type":"Buffer","data":[…]}`; no field the API or channel reads. |
| WAHA routes the API doesn't call | Groups, labels, channels, status, profile, presence subscription, `/api/screenshot`, global env webhooks (`WHATSAPP_HOOK_URL`) are not implemented. |
| 500 error body | Has `statusCode`, `timestamp`, `exception {message, name}`, `request`, `version`; no stack trace or echoed body. |
| `presence` in SessionInfo | `online` only with `WAGW_MARK_ONLINE=1`, else `offline`; `timestamps.activity` is always `null`. |
