# migrate: WAHA NOWEB → whatsmeow, without a new QR scan

`waha2meow` reads one WAHA NOWEB session's `auth` table (Baileys' auth state) from an export file and writes
that linked device into a whatsmeow store (SQLite file or Postgres). A whatsmeow client then connects as the
**same companion device**: same device JID, same Noise key, same Signal identity, same ADV signature from the
phone. The phone sees no new linked device and nobody is asked to re-scan.

It never talks to WhatsApp and only reads its input file. `meowcheck` is a separate, deliberately small tool:
it connects one converted device and reports whether messages keep decrypting.

The one rule when moving a real connection: **never run two clients on the device.** Stop the WAHA session (stop,
not logout or delete) and make sure nothing restarts it before the converted device connects.


```sh
cd migrate && go build -o bin/ ./cmd/...
bin/waha2meow inspect -in auth.csv                          # summary, writes nothing
bin/waha2meow convert -in auth.csv -out sqlite:gateway.db   # write, then reload through whatsmeow and verify
bin/waha2meow convert -in auth.csv -out 'postgres://…'      # same, into the gateway's Postgres
bin/waha2meow verify  -in auth.csv -out sqlite:gateway.db   # re-check later
bin/waha2meow check   -session u_…_s_…                      # read-only from Postgres ($WAHA_DB_URL), in memory, counts + PASS/FAIL only
```

`-in -` reads the export from stdin (e.g. streamed over ssh, so the export never lands on disk). `-contacts` and `-lid-map` take exports
of WAHA's `contacts` and `lid_map` tables (same per-session database) so the migrated account's whatsmeow
contact table and LID map are not empty: whatsmeow fills them from app-state snapshots, which a converted
device does not refetch. `check` prints no values, only counts, skip reasons and check names, and exits 0 only
when every skip is one expected in healthy data (`convert.ExpectedDrop`). Static linux/amd64 build:
`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o bin/linux-amd64/ ./cmd/...`.

Flags: `-replace` (overwrite the same device), `-skip-sessions`, `-skip-sender-keys`, `-app-state-keys-only`
(force a full app-state resync), `-skip-main-device-session` (do what WAHA does with the session to our own
phone), `-push-name`, `-show-ids` (unmask JIDs in output), `-report file.json`. Output masks phone numbers and
LIDs to their last four digits and never prints key material.

Versions: whatsmeow `v0.0.0-20261107160454-79dc2a8c33df` (the commit `native/` pins; the gateway branch has no
`go.mod` yet, see DECISIONS.md), go.mau.fi/libsignal v0.2.2. Source side: WAHA (Plus) NOWEB on Baileys
`devlikeapro/Baileys` `f6bf3cf` (7.0.0-rc14, branch `fork-master-2026-04-28`) with npm `libsignal@6.0.0`,
taken from WAHA's `yarn.lock` at commit `c42f68a` (2026-10-28).

## 1. Source format: what WAHA stores

### Where
WAHA Plus with `WHATSAPP_SESSIONS_POSTGRESQL_URL` keeps each session in its own database
`waha_noweb_<slug>` (slug = session name lower-cased, every character outside `[a-z0-9-]` replaced by `_`;
`PsqlStore.getSessionDbName`). Auth is the table:

```sql
CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, data TEXT)   -- noweb/store/psql/schemas.ts
```

The same database holds the message store (`chats`, `contacts`, `groups`, `labels`, `labelAssociations`,
`lid_map`, `messages`); the converter does not need it. The registry is the separate database `waha_noweb`
(`session_config`, `session_worker`, `me`).

### Rows
`NoWebPsqlAuth` + `PsqlNowebAuthRepository` (WAHA `src/core/engines/noweb/store/psql/`):

- `id` = `creds`, or `<category>-<key>` for Signal keys (category names contain hyphens, so the converter
  splits on the longest known category prefix).
- `data` = `JSON.stringify({ id, data: value }, BufferJSON.replacer)`: the whole entity, not just the value.
- `set()` with a null value is **ignored**: WAHA never deletes a key. Consumed pre-keys, sessions Baileys
  "deleted" and superseded rows all remain.
- `get('session', ['<me>.0'])` returns nothing: WAHA never reads back the session with the account's own
  primary device ("Always reset my session").

### Byte strings
| Shape in the JSON | Where it comes from | Where it appears |
|---|---|---|
| `{"type":"Buffer","data":"<base64>"}` | `BufferJSON.replacer` | almost every key and value |
| `"<base64>"` | protobufjs `toJSON` (`bytes: String`) | `creds.account.*`, `app-state-sync-key.keyData` |
| `"<base64>"` | libsignal-node's own `serialize()` | everything inside a `session` record |
| `{"type":"Buffer","data":[1,2,…]}` and `{"0":1,"1":2,…}` | `JSON.stringify` without the replacer | inside `sender-key` records |
| `"1794098647665"` | protobufjs `toJSON` (`longs: String`) | `app-state-sync-key.timestamp` |

### Categories (Baileys `SignalDataTypeMap`)
| Row id | Value |
|---|---|
| `creds` | `AuthenticationCreds` (below) |
| `pre-key-<n>` | `{private, public}` X25519 pair (public without the 0x05 prefix) |
| `session-<user[_domain]>.<device>` | libsignal-node `SessionRecord.serialize()`: `{_sessions: {<b64 base key>: SessionEntry}, version: "v1"}` |
| `sender-key-<group>::<user[_domain]>::<device>` | a Buffer holding UTF-8 JSON of `SenderKeyStateStructure[]` |
| `sender-key-memory-<group>` | `{<jid>: true}`: devices we gave our sender key |
| `app-state-sync-key-<b64 key id>` | `AppStateSyncKeyData` (`keyData`, `fingerprint`, `timestamp`) |
| `app-state-sync-version-<collection>` | `LTHashState` `{version, hash (128 bytes), indexValueMap: {<b64 index MAC>: {valueMac}}}` |
| `lid-mapping-<pn user>` / `lid-mapping-<lid user>_reverse` | the other user part, as a string |
| `identity-key-<address>` | the peer's 33-byte identity key |
| `tctoken-<jid>` | `{token, timestamp, senderTimestamp?}`; `tctoken-__index` is Baileys bookkeeping |
| `device-list-<user>` | `["0","2",…]` |

Address domains: `_1` LID, `_128` hosted, `_129` hosted LID (none for phone numbers), identical in whatsmeow.

### libsignal-node session entry
`registrationId`, `currentRatchet {ephemeralKeyPair {pubKey, privKey}, lastRemoteEphemeralKey,
previousCounter, rootKey}`, `indexInfo {baseKey, baseKeyType (1 ours / 2 theirs), closed (-1 = open), used,
created, remoteIdentityKey}`, `_chains {<b64 ratchet key>: {chainKey {counter, key?}, chainType (1 sending /
2 receiving), messageKeys {<counter>: <seed>}}}`, `pendingPreKey {signedKeyId, baseKey, preKeyId?}`. Chain
order is creation order (JavaScript insertion order, which `JSON.stringify` keeps); the converter decodes
objects in order.

### Compared with production (structure only, one live session, read by the coordinator 2026-11-09 02:50 UTC)
Same envelope (`{data, id}`), same creds fields (`registered`, no `pairingCode`/`additionalData`), same
`me`/`account`/key shapes, the same 11 categories and no others (1,625 pre-keys, 22 sessions, 11 identity keys,
39 sender keys of ~16 KB each, 38 lid-mapping rows, 14 sender-key-memory, 12 tctoken, 9 device-list, 6
app-state keys, 5 collections). Two shapes the first fixtures lacked, now handled and tested: tctoken
`{token}` / `{token, senderTimestamp}` without a `timestamp` (expired for Baileys, so dropped rather than
stamped fresh) and sender-key-memory keys with device suffixes (`<n>:24@lid`; the category is dropped whole).
Fewer identity keys than sessions is expected: older sessions get their identity from the session record.

## 2. Target format: whatsmeow's store
whatsmeow's `sqlstore` schema v16 (`store/sqlstore/upgrades/00-latest-schema.sql`): `whatsmeow_device`,
`whatsmeow_identity_keys`, `whatsmeow_pre_keys`, `whatsmeow_sessions`, `whatsmeow_sender_keys`,
`whatsmeow_app_state_sync_keys`, `whatsmeow_app_state_version`, `whatsmeow_app_state_mutation_macs`,
`whatsmeow_contacts`, `whatsmeow_chat_settings`, `whatsmeow_message_secrets`, `whatsmeow_privacy_tokens`,
`whatsmeow_nct_salt`, `whatsmeow_lid_map`, `whatsmeow_event_buffer`, `whatsmeow_retry_buffer`. One set of tables
holds every account. Private keys are stored alone (32 bytes) and whatsmeow derives the public halves.
Sessions and sender keys are **JSON** of go.mau.fi/libsignal's `SessionStructure` / `SenderKeyStructure` (its
`ProtoBufSerializer` uses JSON for records), so the converter builds those structs and lets libsignal serialise
them. Everything is written through whatsmeow's own store API inside one transaction, except pre-keys with
explicit ids (one `INSERT`, the only raw SQL). The schema is created or upgraded first.

## 3. Field mapping

### Device (`creds` → `whatsmeow_device`)
| Baileys `creds` | whatsmeow | Check |
|---|---|---|
| `me.id` `user:device@s.whatsapp.net` | `jid` (`Device.ID`) | device ≠ 0, server s.whatsapp.net |
| `me.lid` `user:device@lid` | `lid` | same device number as `me.id` |
| `registrationId` | `registration_id` | |
| `noiseKey.private` | `noise_key` | derived public key = stored public key |
| `signedIdentityKey.private` | `identity_key` | derived public = stored |
| `signedPreKey.keyPair.private`, `.keyId`, `.signature` | `signed_pre_key`, `signed_pre_key_id`, `signed_pre_key_sig` | derived public = stored; signature verifies under the identity key |
| `advSecretKey` (base64) | `adv_key` | 32 bytes |
| `account.details` | `adv_details` | parses as `ADVDeviceIdentity` |
| `account.accountSignatureKey` | `adv_account_sig_key` | the primary device's identity key |
| `account.accountSignature` | `adv_account_sig` | verifies: `[6,0] ‖ details ‖ our identity key` |
| `account.deviceSignature` | `adv_device_sig` | verifies: `[6,1] ‖ details ‖ our identity key ‖ account key` |
| `platform` (from pair-success, e.g. `android`, `smba`) | `platform` | |
| `me.name` (push name, kept current from app state) | `push_name` | `-push-name` overrides |
| — | `business_name` | not recoverable: Baileys overwrites `me.name` (see DECISIONS) |
| — | `lid_migration_ts`, `facebook_uuid`, `companion_meta_nonce` | 0 / null / empty, as after a fresh whatsmeow pairing |

Also written, as whatsmeow's own pairing does: our PN↔LID mapping, and the primary device's identity
(`accountSignatureKey`) under `<lid user>_1:0`.

### Keys
| Baileys | whatsmeow | Conversion |
|---|---|---|
| `pre-key-<n>` | `whatsmeow_pre_keys (key_id n, key, uploaded)` | `uploaded = n < firstUnuploadedPreKeyId`; public key checked. whatsmeow numbers new keys `MAX(key_id)+1`, so it continues at `nextPreKeyId`; if rows are missing a reserved filler key keeps that true |
| `session-<addr>` | `whatsmeow_sessions (their_id = addr with ':' before the device)` | see below |
| `identity-key-<addr>` | `whatsmeow_identity_keys` | 0x05 prefix stripped; filled from the session's `remoteIdentityKey` when Baileys wrote no row |
| `sender-key-<g>::<u>::<d>` | `whatsmeow_sender_keys (chat_id g, sender_id u:d)` | states reversed (Baileys newest last, go-libsignal newest first); message keys rebuilt from seeds |
| `app-state-sync-key-<id>` | `whatsmeow_app_state_sync_keys` | `key_id` = base64-decoded id; `fingerprint` = marshalled `AppStateSyncKeyFingerprint` |
| `app-state-sync-version-<name>` | `whatsmeow_app_state_version` + `_mutation_macs` | version and 128-byte LTHash copied; each `indexValueMap` entry becomes a MAC row at the collection version |
| `lid-mapping-*` | `whatsmeow_lid_map` | forward and `_reverse` rows merged into PN↔LID pairs |
| `tctoken-<jid>` | `whatsmeow_privacy_tokens` | JID normalised to non-AD; timestamps in seconds |

### Session record (`ConvertSession`)
| libsignal-node | go-libsignal `StateStructure` |
|---|---|
| entry with `indexInfo.closed == -1` (most recently used if several) | `SessionState` |
| other entries, most recently used first, up to 40 | `PreviousStates` |
| `registrationId` (or the legacy record-level one) | `RemoteRegistrationID` |
| our `registrationId`, our identity key with 0x05 | `LocalRegistrationID`, `LocalIdentityPublic` |
| `indexInfo.remoteIdentityKey` | `RemoteIdentityPublic` |
| `indexInfo.baseKey` (Alice's base key on both sides) | `SenderBaseKey` |
| `currentRatchet.rootKey` | `RootKey` |
| `currentRatchet.previousCounter` | `PreviousCounter` (−1 → 0) |
| `currentRatchet.ephemeralKeyPair` + its SENDING chain | `SenderChain` (ratchet key pair, chain key) |
| RECEIVING chains, last 5 in creation order | `ReceiverChains` |
| `chainKey {counter, key}` | `ChainKey {Index: counter+1, Key}` (node keeps the last used index, Go the next) |
| `messageKeys[n]` = HMAC(chainKey, 0x01) seed | `MessageKeys[n]` = HKDF(seed, zero salt, "WhisperMessageKeys", 80) → cipher 0–32, MAC 32–64, IV 64–80 |
| `pendingPreKey {preKeyId?, signedKeyId, baseKey}` | `PendingPreKey` |
| — | `SessionVersion` 3 |

## 4. What is converted, what is dropped, and why

| Data | Result | Why / what happens |
|---|---|---|
| Device identity, keys, ADV account, platform, push name | **converted, verified** | This is the link. Every public key is re-derived and every signature checked; any mismatch aborts. |
| Pre-keys (including consumed ones WAHA never deleted) | **converted** | A contact who fetched one of our pre-keys before the switch sends a `pkmsg` naming it; whatsmeow must hold it. Consumed ones are harmless. |
| 1:1 Signal sessions | **converted** | Without them every peer's next message fails to decrypt and recovers only through a retry receipt (see below). |
| Closed previous session states (≤ 40), receiving chains (last 5), skipped-message keys (≤ 2000 per chain) | **converted** | Late and out-of-order messages still decrypt. Older chains beyond go-libsignal's limits are dropped; libsignal-node would have kept them, so only very late messages on very old chains are affected. |
| Phone-number session, identity key or sender key whose LID-addressed counterpart exists | dropped (counted) | Once Baileys knows a contact's LID it only reads the LID row (`resolveLIDSignalAddress`); its `migrateSession` "deletes" the phone-number row, which WAHA ignores. Kept, the stale row would be copied over the live LID session by whatsmeow's `MigratePNToLID` (`ON CONFLICT DO UPDATE`) the first time it meets the contact. Phone-number rows with no LID counterpart are kept; whatsmeow migrates them itself. |
| Session whose remote identity differs from the stored identity key | dropped (counted) | Baileys saw a new identity and deleted the session, but WAHA ignored the delete. The stale state could not decrypt anything anyway. |
| Session record with no open entry, or no sending chain | dropped (counted) | Not usable for sending in either library; whatsmeow builds a fresh session on the next message. |
| Identity keys | **converted** | Avoids a needless "untrusted identity" reset on first contact. |
| Group sender keys (others' and ours) | **converted** | Others' keys are what let us read group messages; senders do not resend their key unless asked. Ours lets recipients keep decrypting our group messages without a new key (whatsmeow also re-sends it with every group message). |
| App-state sync keys | **converted** | Needed to decrypt app-state patches (archive, mute, pin, contacts, push name). |
| App-state versions + LTHash + value MACs | **converted** (or `-app-state-keys-only`) | whatsmeow continues incrementally. If a hash ever mismatches, whatsmeow reports `AppStateSyncError`; a full resync (version 0) recovers. |
| LID ↔ PN mappings | **converted** | whatsmeow's own LID map, shared by all accounts in the store. |
| Privacy (tc) tokens | **converted** (cleared ones and `__index` skipped) | Needed for some sends to contacts that require a token. |
| `device-list` | dropped | whatsmeow keeps device lists in memory and fetches them by usync when it sends. |
| `sender-key-memory` | dropped | whatsmeow re-sends our sender key distribution message to every participant device on every group send (`send.go sendGroup`), so it needs no memory. |
| `creds.routingInfo` | dropped | whatsmeow has no edge-routing support; it only picks the edge server, and the server sends fresh routing info. |
| `creds.pairingEphemeralKeyPair`, `pairingCode` | dropped | Only for pairing-code linking, already done. |
| `creds.processedHistoryMessages`, `accountSyncCounter`, `lastAccountSyncTimestamp`, `accountSettings`, `lastPropHash`, `myAppStateKeyId`, `additionalData` | dropped | Baileys bookkeeping. whatsmeow does no initial history sync for an existing device, refetches props, and picks the latest app-state key by timestamp (the verifier checks it equals `myAppStateKeyId`). |
| Business name | not recoverable | Baileys keeps only `me.name`, which the push name overwrites; pass `-business-name` for a business account if it matters. |
| WAHA's `contacts` and `lid_map` tables (optional `-contacts`, `-lid-map`) | **converted** | Address-book names, push names and business names into `whatsmeow_contacts` (under both LID and PN when known); every LID↔PN pair WAHA saw into `whatsmeow_lid_map` (auth rows win). Groups in `contacts` are skipped. |
| WAHA's message store (`messages`, `chats`, …) | out of scope | whatsmeow keeps no history. The gateway's own message tables need a separate import if the API's chats/messages endpoints must show pre-migration history. |

**If sessions were dropped** (`-skip-sessions`, or any session the report lists): the first message from that
peer arrives as a `msg` whatsmeow cannot decrypt. whatsmeow emits `UndecryptableMessage` and sends a retry
receipt; the sender's app then fetches our pre-key bundle and resends as a `pkmsg`, which decrypts. Delay is
seconds when the sender is online, longer if they are not; `AutomaticMessageRerequestFromPhone` also asks our
own phone for the plaintext. Group messages recover the same way (the sender adds its key). Nothing is lost
if the sender's app is healthy, but every contact goes through one retry, which is noise for WhatsApp's abuse
heuristics on an account that just changed client, hence converting them is preferred.

## 5. Looking like the same client

The companion's identity to WhatsApp is fixed at pairing: device JID, Noise key, registration id, identity and
signed pre-key, ADV signatures, and the `DeviceProps` (WAHA sends `os: "Ubuntu"`, `platformType: CHROME`,
`requireFullSync: true`, version 10.15.7; `browser = ["Ubuntu","Chrome","22.0.4"]` because WAHooks sets no
`WAHA_CLIENT_*`). `DeviceProps` are only sent when registering a new device, never at login, so the name and
icon on the phone's Linked devices list stay as they are.

At login the two libraries send nearly the same `ClientPayload`:

| Field | Baileys (WAHA) | whatsmeow default |
|---|---|---|
| userAgent.platform / releaseChannel | WEB / RELEASE | WEB / RELEASE |
| userAgent.appVersion | WA Web version WAHA tracks | WA Web version whatsmeow pins (bump weekly) |
| osVersion / osBuildNumber / device | `0.1` / `0.1` / `Desktop` | `0.1` / `0.1` / `Desktop` |
| mcc / mnc / locale | `000` / `000` / `en`-`US` | `000` / `000` / `en`-`US` |
| manufacturer | unset | `""` |
| webInfo.webSubPlatform | WEB_BROWSER | WEB_BROWSER |
| connectType / connectReason | WIFI_UNKNOWN / USER_ACTIVATED | WIFI_UNKNOWN / USER_ACTIVATED |
| passive, pull, lidDbMigrated, lc | true, true, true, 1 | true, true, true, 1 |
| username / device | from `me.id` | from the converted JID |

So the gateway should keep whatsmeow's defaults: **do not call `store.SetOSInfo`** (it changes `osVersion`
and `osBuildNumber` in every login payload). For new pairings, setting `store.DeviceProps.Os = "Ubuntu"` and
`PlatformType = CHROME` would match how WAHA-linked devices appear, if that is wanted.

Switching clients on one companion has no protocol-level marker beyond the payload above; WhatsApp sees a
reconnect of the same device. What it does see: a different IP if the gateway box differs from the WAHA node,
the WA Web version whatsmeow reports, and any behaviour differences (presence, receipts, retry patterns). The
known way to get a device logged out is two clients holding it at once, which a move must
prevent. I found no reports of WhatsApp reacting to a library switch as such; the one public tool for this
(`wa-store-migrate` on npm, v0.1, new) drops skipped-message keys and older sender-key states and is untested
by us.

## 6. Tests
`go test ./...` (no network). Fixtures in `testdata/baileys/` are genuine: `fixturegen/gen.mjs` runs the exact
Baileys build WAHA ships, offline, pairs a device through Baileys' own `configureSuccessfulPairing` with an ADV
identity signed by a simulated phone, and has five simulated peers exchange real Signal traffic with it:

- Alice: a phone-number contact whose session Baileys keyed by her LID, a DH ratchet step, one delayed message.
- Bob: we started the session; he never replied, so it holds a pending pre-key.
- Carol: a second device (`.2`) that rebuilt her session, leaving a closed previous state.
- the account's own phone (device 0); Dave: a new contact after the switch, on an unused uploaded pre-key.
- Erin: eight rounds of back-and-forth, so our record holds eight receiving chains (go-libsignal keeps five);
  one message on the newest chain is delayed.
- Frank: a phone-number session; then Baileys learns his LID and runs its own `migrateSession`, then a DH
  ratchet step on the LID row, leaving a stale phone-number row as WAHA would.
- a LID-addressed group with Alice's sender key (one message delayed), a second state after Alice reinstalls,
  and our own key; an app-state sync key and three patches; LID mappings, tc tokens, device lists.

Rows are stored with WAHA's own semantics (envelope, never-delete, main-session reset) and exported through a
real Postgres with WAHA's DDL by `fixturegen/export-formats.sh` (psql CSV, `json_agg`, `pg_dump`).

| Test | Proves |
|---|---|
| `TestExportFormatsAgree` | the CSV, JSON and pg_dump readers return identical rows |
| `TestConvertMatchesBaileys` | JID, LID, registration id, every public key, signatures, pre-keys, next pre-key id, app-state versions and key id, sessions (and the stale one dropped), sender key state counts, LID map equal Baileys' values |
| `TestPeersMessagesAfterSnapshotDecrypt` | messages peers sent **after** WAHA stopped decrypt in whatsmeow's own code path (delayed message via a stored key, closed previous state, own phone, new contact `pkmsg`, the newest of eight receiving chains, Frank after whatsmeow's own `MigratePNToLID`, delayed and new group messages under both of Alice's sender key states) |
| `TestAppStatePatchAppliesOnImportedState` | whatsmeow's appstate processor applies the next server patch on the imported LTHash with MAC validation, overwriting an existing index (needs the imported value MAC) |
| `TestRoundTripWithBaileys` | whatsmeow encrypts to every peer and to the group with the converted state; Baileys decrypts; peers reply; whatsmeow decrypts the replies (a DH ratchet step on both sides). Bob's message is still a `pkmsg` |
| `TestRefusesExistingDeviceUnlessReplace`, `TestOptionsDropWhatTheySay` | safety and options |
| `TestSyntheticCredsConvert`, `TestSyntheticCredsRefused` | creds built in Go, independently of Baileys; tampered keys or signatures, device 0, unlinked or half-paired sessions are refused |
| `TestPostgresTarget` | with `WAHA2MEOW_TEST_POSTGRES=postgres://…` the same conversion into Postgres decrypts the same messages (run against a local Postgres 15 container) |

Eight deliberately injected converter bugs each fail these tests with a specific error: chain index off by
one, skipped-message keys dropped, pending pre-key dropped, sender message keys dropped, wrong IV slice, stale
phone-number rows kept, sender key states not reversed, the oldest five receiving chains kept instead of the
newest.

Regenerate fixtures (Node ≥ 20, Docker):

```sh
cd fixturegen && npm ci && node gen.mjs ../testdata/baileys && ./export-formats.sh
```

## 7. For the gateway
Convert into the gateway's store, then attach the device with `gateway adopt-device`: the converter's output
and the gateway's tables (`gw_sessions`, `gw_messages`, `gw_chats`) share one store. Both pin whatsmeow `79dc2a8c33df`.

- Open the store with whatsmeow's `sqlstore` at the same commit; the converter creates or upgrades schema v16.
- One owner per device: hold a lease before `Connect()` (RISKS R1).
- Never reconnect after `events.StreamReplaced` (whatsmeow does not by default, keep it that way); alert.
- `events.LoggedOut` makes whatsmeow delete the device from the store; keep the WAHA export until the device
  has been stable for a while, so a conversion can be repeated if needed.
- Set `SynchronousAck = true` while migrating (crash ⇒ redelivery, not loss) and
  `AutomaticMessageRerequestFromPhone = true`.
- Do not call `store.SetOSInfo`.
- The same converter output would also seed a WAHA **GOWS** session (WAHA's whatsmeow engine), if its store
  layout is the plain sqlstore schema. Unverified: GOWS is closed source.
