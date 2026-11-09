// Generates a synthetic, genuine WAHA NOWEB `auth` table with the Baileys build WAHA ships
// (devlikeapro/Baileys f6bf3cf, 7.0.0-rc14, libsignal 6.0.0), plus messages that peers send
// AFTER the snapshot, so the Go tests can check a converted store keeps decrypting.
//
// Nothing here connects to WhatsApp. All identities are invented: phone numbers are in the
// fictional 555-01xx range, LIDs are 1000000000000xx, every key is freshly random.
//
// Usage: node gen.mjs <outdir>

import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { B, BufferJSON, WahaAuthRows, b64, logger, makeAuthState, makePeer, proto } from './lib.mjs'

const out = process.argv[2]
if (!out) throw new Error('usage: node gen.mjs <outdir>')
mkdirSync(out, { recursive: true })

const { Curve, generateSignalPubKey } = B

// ---- identities --------------------------------------------------------------------------
const ME_PN = '15555550123'
const ME_LID = '100000000000001'
const ME_DEVICE = 23
const ME_JID = `${ME_PN}:${ME_DEVICE}@s.whatsapp.net`
const ME_LID_JID = `${ME_LID}:${ME_DEVICE}@lid`
const GROUP = '120363000000000001@g.us'

const ALICE_PN = '15555550101@s.whatsapp.net'
const ALICE_LID = '100000000000101@lid'
const BOB_LID = '100000000000102@lid'
const CAROL_PN = '15555550103:2@s.whatsapp.net'
const DAVE_PN = '15555550104@s.whatsapp.net'
const PHONE = `${ME_PN}@s.whatsapp.net` // the account's own primary device (device 0)
const ERIN_PN = '15555550105@s.whatsapp.net'
const FRANK_PN = '15555550106@s.whatsapp.net'
const FRANK_LID = '100000000000106@lid'

// ---- pair our companion device exactly as Baileys does ----------------------------------
const rows = new WahaAuthRows()
const creds = B.initAuthCreds()

// The primary device's identity key is the account signature key.
const phoneIdentity = Curve.generateKeyPair()
const deviceIdentityDetails = proto.ADVDeviceIdentity.encode({
	rawId: 424242,
	timestamp: Math.floor(Date.now() / 1000) - 86400 * 30,
	keyIndex: 7
}).finish()
const accountSignature = Curve.sign(
	phoneIdentity.private,
	Buffer.concat([B.WA_ADV_ACCOUNT_SIG_PREFIX, deviceIdentityDetails, creds.signedIdentityKey.public])
)
const signedDeviceIdentity = proto.ADVSignedDeviceIdentity.encode({
	details: deviceIdentityDetails,
	accountSignatureKey: phoneIdentity.public,
	accountSignature
}).finish()
const hmac = createHmac('sha256', Buffer.from(creds.advSecretKey, 'base64')).update(signedDeviceIdentity).digest()
const container = proto.ADVSignedDeviceIdentityHMAC.encode({ details: signedDeviceIdentity, hmac }).finish()

const pairStanza = {
	tag: 'iq',
	attrs: { id: 'pair-1', from: 's.whatsapp.net', type: 'set' },
	content: [
		{
			tag: 'pair-success',
			attrs: {},
			content: [
				{ tag: 'device-identity', attrs: { 'key-index': '7' }, content: Buffer.from(container) },
				{ tag: 'platform', attrs: { name: 'android' } },
				{ tag: 'device', attrs: { jid: ME_JID, lid: ME_LID_JID } }
			]
		}
	]
}
const paired = B.configureSuccessfulPairing(pairStanza, creds)
Object.assign(creds, paired.creds)

// What a long-running WAHA session accumulates after pairing.
creds.me = { ...creds.me, name: 'Fixture Push Name' }
creds.routingInfo = randomBytes(12)
creds.lastPropHash = '3R8a1p'
creds.accountSyncCounter = 1
creds.lastAccountSyncTimestamp = Math.floor(Date.now() / 1000) - 3600
creds.processedHistoryMessages = [
	{ key: { remoteJid: ME_JID, fromMe: true, id: '3EB0AAAAAAAAAAAAAAAA' }, messageTimestamp: 1731000000 }
]

const { state, repo } = makeAuthState(rows, creds)

// ---- pre-keys: an initial upload of 30, then a top-up of 10 --------------------------------
let r = await B.getNextPreKeys(state, 30)
Object.assign(creds, r.update)
r = await B.getNextPreKeys(state, 10)
Object.assign(creds, r.update)

const ourBundle = preKeyId => {
	const pk = rows.load('pre-key', String(preKeyId))
	return {
		registrationId: creds.registrationId,
		identityKey: generateSignalPubKey(creds.signedIdentityKey.public),
		signedPreKey: {
			keyId: creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(creds.signedPreKey.keyPair.public),
			signature: creds.signedPreKey.signature
		},
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(pk.public) }
	}
}
const peerBundle = async peer => {
	const preKey = Curve.generateKeyPair()
	await peer.state.keys.set({ 'pre-key': { 1: preKey } })
	return {
		registrationId: peer.state.creds.registrationId,
		identityKey: generateSignalPubKey(peer.state.creds.signedIdentityKey.public),
		signedPreKey: {
			keyId: peer.state.creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(peer.state.creds.signedPreKey.keyPair.public),
			signature: peer.state.creds.signedPreKey.signature
		},
		preKey: { keyId: 1, publicKey: generateSignalPubKey(preKey.public) }
	}
}

const text = s => Buffer.from(s, 'utf-8')
const check = (got, want, what) => {
	if (Buffer.compare(Buffer.from(got), Buffer.from(want)) !== 0) throw new Error(`fixture self-check failed: ${what}`)
}

// LID mapping known to us for Alice (Baileys then stores her session under her LID address).
await repo.lidMapping.storeLIDPNMappings([{ lid: ALICE_LID, pn: ALICE_PN }])

// ---- peers --------------------------------------------------------------------------------
const alice = makePeer('alice', ALICE_LID)
const bob = makePeer('bob', BOB_LID)
const carol = makePeer('carol', CAROL_PN)
const dave = makePeer('dave', DAVE_PN)
const phone = makePeer('phone', PHONE)
const erin = makePeer('erin', ERIN_PN)
const frank = makePeer('frank', FRANK_PN)
// The phone's Signal identity is the account identity that signed our device.
phone.state.creds.signedIdentityKey = phoneIdentity

const after = { dms: [], groups: [], appState: [] }

// Alice → us (pkmsg), us → Alice, Alice → us on a new ratchet, with one message held back.
await alice.repo.injectE2ESession({ jid: ME_LID_JID, session: ourBundle(1) })
let m = await alice.repo.encryptMessage({ jid: ME_LID_JID, data: text('alice 1') })
check(await repo.decryptMessage({ jid: ALICE_PN, type: m.type, ciphertext: m.ciphertext }), text('alice 1'), 'alice 1')
m = await repo.encryptMessage({ jid: ALICE_PN, data: text('to alice 1') })
check(await alice.repo.decryptMessage({ jid: ME_LID_JID, type: m.type, ciphertext: m.ciphertext }), text('to alice 1'), 'to alice 1')
m = await alice.repo.encryptMessage({ jid: ME_LID_JID, data: text('alice 2') })
check(await repo.decryptMessage({ jid: ALICE_PN, type: m.type, ciphertext: m.ciphertext }), text('alice 2'), 'alice 2')
const aliceLate = await alice.repo.encryptMessage({ jid: ME_LID_JID, data: text('alice 3 (delayed)') })
m = await alice.repo.encryptMessage({ jid: ME_LID_JID, data: text('alice 4') })
check(await repo.decryptMessage({ jid: ALICE_PN, type: m.type, ciphertext: m.ciphertext }), text('alice 4'), 'alice 4')

// We start a session with Bob (LID). He has not answered: our session keeps its pending pre-key.
await repo.injectE2ESession({ jid: BOB_LID, session: await peerBundle(bob) })
m = await repo.encryptMessage({ jid: BOB_LID, data: text('to bob 1') })
if (m.type !== 'pkmsg') throw new Error('expected pkmsg to bob')
check(await bob.repo.decryptMessage({ jid: ME_LID_JID, type: m.type, ciphertext: m.ciphertext }), text('to bob 1'), 'to bob 1')

// Carol (PN, device 2, no LID known): a session, then she rebuilds it, so our record also
// holds a closed previous session.
await carol.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(2) })
m = await carol.repo.encryptMessage({ jid: ME_JID, data: text('carol 1') })
check(await repo.decryptMessage({ jid: CAROL_PN, type: m.type, ciphertext: m.ciphertext }), text('carol 1'), 'carol 1')
m = await repo.encryptMessage({ jid: CAROL_PN, data: text('to carol 1') })
check(await carol.repo.decryptMessage({ jid: ME_JID, type: m.type, ciphertext: m.ciphertext }), text('to carol 1'), 'to carol 1')
await carol.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(4) })
m = await carol.repo.encryptMessage({ jid: ME_JID, data: text('carol 2 (new session)') })
check(await repo.decryptMessage({ jid: CAROL_PN, type: m.type, ciphertext: m.ciphertext }), text('carol 2 (new session)'), 'carol 2')

// The account's own phone (device 0) → us.
await phone.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(3) })
m = await phone.repo.encryptMessage({ jid: ME_JID, data: text('phone 1') })
check(await repo.decryptMessage({ jid: PHONE, type: m.type, ciphertext: m.ciphertext }), text('phone 1'), 'phone 1')

// Frank: a phone-number session first; later we learn his LID and Baileys migrates the
// session (migrateSession writes the LID row and "deletes" the PN row, which WAHA ignores).
// Then a DH ratchet step happens on the LID row only, so the PN row is stale.
await frank.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(5) })
m = await frank.repo.encryptMessage({ jid: ME_JID, data: text('frank 1') })
check(await repo.decryptMessage({ jid: FRANK_PN, type: m.type, ciphertext: m.ciphertext }), text('frank 1'), 'frank 1')
m = await repo.encryptMessage({ jid: FRANK_PN, data: text('to frank 1') })
check(await frank.repo.decryptMessage({ jid: ME_JID, type: m.type, ciphertext: m.ciphertext }), text('to frank 1'), 'to frank 1')
await state.keys.set({ 'device-list': { '15555550106': ['0'] } })
await repo.lidMapping.storeLIDPNMappings([{ lid: FRANK_LID, pn: FRANK_PN }])
const migrated = await repo.migrateSession(FRANK_PN, FRANK_LID)
if (migrated.migrated !== 1) throw new Error(`frank migration: ${JSON.stringify(migrated)}`)
if (!rows.rows.has('session-15555550106.0') || !rows.rows.has('session-100000000000106_1.0')) throw new Error('expected both frank rows')
m = await frank.repo.encryptMessage({ jid: ME_JID, data: text('frank 2') })
check(await repo.decryptMessage({ jid: FRANK_PN, type: m.type, ciphertext: m.ciphertext }), text('frank 2'), 'frank 2')
m = await repo.encryptMessage({ jid: FRANK_PN, data: text('to frank 2') })
check(await frank.repo.decryptMessage({ jid: ME_JID, type: m.type, ciphertext: m.ciphertext }), text('to frank 2'), 'to frank 2')
m = await frank.repo.encryptMessage({ jid: ME_JID, data: text('frank 3') })
check(await repo.decryptMessage({ jid: FRANK_PN, type: m.type, ciphertext: m.ciphertext }), text('frank 3'), 'frank 3')

// Erin: a long back-and-forth, so our record holds more receiving chains than go-libsignal's 5.
await erin.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(6) })
let erinLate
for (let i = 1; i <= 8; i++) {
	m = await erin.repo.encryptMessage({ jid: ME_JID, data: text(`erin ${i}`) })
	check(await repo.decryptMessage({ jid: ERIN_PN, type: m.type, ciphertext: m.ciphertext }), text(`erin ${i}`), `erin ${i}`)
	// On the last round one message is held back: it lives on our NEWEST receiving chain.
	if (i === 8) erinLate = await erin.repo.encryptMessage({ jid: ME_JID, data: text('erin 8 (delayed)') })
	m = await repo.encryptMessage({ jid: ERIN_PN, data: text(`to erin ${i}`) })
	check(await erin.repo.decryptMessage({ jid: ME_JID, type: m.type, ciphertext: m.ciphertext }), text(`to erin ${i}`), `to erin ${i}`)
}

// ---- a LID-addressed group ----------------------------------------------------------------
let g = await alice.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice 1') })
await repo.processSenderKeyDistributionMessage({
	item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: g.senderKeyDistributionMessage },
	authorJid: ALICE_LID
})
check(await repo.decryptGroupMessage({ group: GROUP, authorJid: ALICE_LID, msg: g.ciphertext }), text('group alice 1'), 'group 1')
const groupLate = await alice.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice 2 (delayed)') })
g = await alice.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice 3') })
check(await repo.decryptGroupMessage({ group: GROUP, authorJid: ALICE_LID, msg: g.ciphertext }), text('group alice 3'), 'group 3')

// Alice reinstalls: a new sender key id for the same sender. Our record now has two states.
const alice2 = makePeer('alice2', ALICE_LID)
g = await alice2.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice (new install) 1') })
await repo.processSenderKeyDistributionMessage({
	item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: g.senderKeyDistributionMessage },
	authorJid: ALICE_LID
})
check(await repo.decryptGroupMessage({ group: GROUP, authorJid: ALICE_LID, msg: g.ciphertext }), text('group alice (new install) 1'), 'group alice2 1')

// Our own sender key in that group, already distributed to Alice.
g = await repo.encryptGroupMessage({ group: GROUP, meId: ME_LID_JID, data: text('group me 1') })
await alice.repo.processSenderKeyDistributionMessage({
	item: { groupId: GROUP, axolotlSenderKeyDistributionMessage: g.senderKeyDistributionMessage },
	authorJid: ME_LID_JID
})
check(await alice.repo.decryptGroupMessage({ group: GROUP, authorJid: ME_LID_JID, msg: g.ciphertext }), text('group me 1'), 'group me 1')
// What the socket records after distributing our key (WAHA keeps it; whatsmeow has no equivalent).
await state.keys.set({ 'sender-key-memory': { [GROUP]: { [`${ME_LID}:${ME_DEVICE}@lid`]: true, [ALICE_LID]: true } } })

// ---- app state: a sync key shared by the phone, and three applied patches ---------------
const keyId = randomBytes(6)
const strKeyId = keyId.toString('base64')
const keyData = proto.Message.AppStateSyncKeyData.decode(
	proto.Message.AppStateSyncKeyData.encode({
		keyData: randomBytes(32),
		fingerprint: { rawId: 424242, currentIndex: 2, deviceIndexes: [0, ME_DEVICE] },
		timestamp: Date.now() - 86400_000
	}).finish()
)
await state.keys.set({ 'app-state-sync-key': { [strKeyId]: keyData } })
creds.myAppStateKeyId = strKeyId
const getAppStateSyncKey = async id => (await state.keys.get('app-state-sync-key', [id]))[id]

const SET = proto.SyncdMutation.SyncdOperation.SET
const chatX = ALICE_PN
const chatY = '15555550199@s.whatsapp.net'
let lt = B.newLTHashState()
const patches = [
	{ index: ['archive', chatX], syncAction: { timestamp: 1731000001, archiveChatAction: { archived: true } }, apiVersion: 3 },
	{ index: ['mute', chatY], syncAction: { timestamp: 1731000002, muteAction: { muted: true, muteEndTimestamp: 1999999999 } }, apiVersion: 2 },
	{ index: ['pin_v1', chatY], syncAction: { timestamp: 1731000003, pinAction: { pinned: true } }, apiVersion: 5 }
]
for (const p of patches) {
	const res = await B.encodeSyncdPatch({ type: 'regular_low', ...p, operation: SET }, strKeyId, lt, getAppStateSyncKey)
	lt = res.state
}
await state.keys.set({ 'app-state-sync-version': { regular_low: lt } })

// The next patch the server would send: un-archive chat X. It overwrites an index we
// already hold, so applying it needs the imported value MAC as well as the LTHash.
{
	const res = await B.encodeSyncdPatch(
		{
			type: 'regular_low',
			index: ['archive', chatX],
			syncAction: { timestamp: 1731000004, archiveChatAction: { archived: false } },
			apiVersion: 3,
			operation: SET
		},
		strKeyId,
		lt,
		getAppStateSyncKey
	)
	const patch = { ...res.patch, version: { version: res.state.version } }
	after.appState.push({
		name: 'regular_low',
		patch: b64(proto.SyncdPatch.encode(patch).finish()),
		fromVersion: lt.version,
		toVersion: res.state.version,
		expect: { index: ['archive', chatX], archived: false }
	})
}

// ---- other key types ---------------------------------------------------------------------
const nowS = Math.floor(Date.now() / 1000)
await state.keys.set({
	tctoken: {
		[ALICE_LID]: { token: randomBytes(24), timestamp: String(nowS - 600) },
		[DAVE_PN]: { token: Buffer.alloc(0), senderTimestamp: nowS - 60 }, // a cleared token
		__index: { token: Buffer.from(JSON.stringify([ALICE_LID, DAVE_PN])) }
	},
	'device-list': { '15555550101': ['0', '2'], '100000000000101': ['0'] }
})

// ---- snapshot: this is what `auth` holds when WAHA stops the session ---------------------
rows.save('creds', '', creds)
const snapshot = rows.toJSONRows()

// ---- after the snapshot: peers keep sending, the Go side must decrypt -------------------
after.dms.push({ from: 'alice', addr: '100000000000101_1.0', ...enc(aliceLate), plaintext: b64(text('alice 3 (delayed)')) })
m = await alice.repo.encryptMessage({ jid: ME_LID_JID, data: text('alice 5') })
after.dms.push({ from: 'alice', addr: '100000000000101_1.0', ...enc(m), plaintext: b64(text('alice 5')) })

m = await carol.repo.encryptMessage({ jid: ME_JID, data: text('carol 3') })
after.dms.push({ from: 'carol', addr: '15555550103.2', ...enc(m), plaintext: b64(text('carol 3')) })

m = await phone.repo.encryptMessage({ jid: ME_JID, data: text('phone 2') })
after.dms.push({ from: 'phone', addr: `${ME_PN}.0`, ...enc(m), plaintext: b64(text('phone 2')) })

// A new contact, using one of our uploaded pre-keys nobody has consumed yet.
await dave.repo.injectE2ESession({ jid: ME_JID, session: ourBundle(35) })
m = await dave.repo.encryptMessage({ jid: ME_JID, data: text('dave 1') })
after.dms.push({ from: 'dave', addr: '15555550104.0', ...enc(m), plaintext: b64(text('dave 1')) })

m = await frank.repo.encryptMessage({ jid: ME_JID, data: text('frank 4') })
after.dms.push({ from: 'frank', addr: '100000000000106_1.0', pnAddr: '15555550106.0', ...enc(m), plaintext: b64(text('frank 4')) })

after.dms.push({ from: 'erin', addr: '15555550105.0', ...enc(erinLate), plaintext: b64(text('erin 8 (delayed)')) })
m = await erin.repo.encryptMessage({ jid: ME_JID, data: text('erin 9') })
after.dms.push({ from: 'erin', addr: '15555550105.0', ...enc(m), plaintext: b64(text('erin 9')) })

g = await alice2.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice (new install) 2') })
after.groups.push({ group: GROUP, from: 'alice2', addr: '100000000000101_1.0', ciphertext: b64(g.ciphertext), plaintext: b64(text('group alice (new install) 2')) })

after.groups.push({ group: GROUP, from: 'alice', addr: '100000000000101_1.0', ciphertext: b64(groupLate.ciphertext), plaintext: b64(text('group alice 2 (delayed)')) })
g = await alice.repo.encryptGroupMessage({ group: GROUP, meId: ALICE_LID, data: text('group alice 4') })
after.groups.push({ group: GROUP, from: 'alice', addr: '100000000000101_1.0', ciphertext: b64(g.ciphertext), plaintext: b64(text('group alice 4')) })

function enc(msg) {
	return { type: msg.type, ciphertext: b64(msg.ciphertext) }
}

// ---- what the converter must reproduce ----------------------------------------------------
const expect = {
	jid: ME_JID,
	lid: ME_LID_JID,
	registrationId: creds.registrationId,
	platform: 'android',
	pushName: 'Fixture Push Name',
	noisePub: b64(creds.noiseKey.public),
	identityPub: b64(creds.signedIdentityKey.public),
	signedPreKey: { id: creds.signedPreKey.keyId, pub: b64(creds.signedPreKey.keyPair.public), sig: b64(creds.signedPreKey.signature) },
	accountSignatureKey: b64(phoneIdentity.public),
	preKeys: Object.fromEntries(
		[...Array(creds.nextPreKeyId - 1).keys()].map(i => [i + 1, b64(rows.load('pre-key', String(i + 1)).public)])
	),
	nextPreKeyId: creds.nextPreKeyId,
	appStateKeyId: b64(keyId),
	appStateVersions: { regular_low: lt.version },
	// converted; frank's phone-number row is stale (Baileys migrated it to his LID) and must be dropped
	sessions: ['100000000000101_1.0', '100000000000102_1.0', '15555550103.2', `${ME_PN}.0`, '100000000000106_1.0', '15555550105.0'],
	droppedSessions: { '15555550106.0': 'superseded by the LID-addressed row Baileys uses' },
	senderKeyStates: { [`${GROUP}::100000000000101_1::0`]: 2, [`${GROUP}::${ME_LID}_1::${ME_DEVICE}`]: 1 },
	senderKeys: [`${GROUP}::100000000000101_1::0`, `${GROUP}::${ME_LID}_1::${ME_DEVICE}`],
	lidMappings: { '15555550101': '100000000000101', '15555550106': '100000000000106' },
	storeLidMappings: { '15555550107': '100000000000107' },
	storeContacts: {
		[ALICE_PN]: { full: 'Alice Fixture', push: 'alice' },
		[ALICE_LID]: { full: 'Alice Fixture', push: 'alice' },
		[BOB_LID]: { full: 'Bob Fixture', push: 'bob' },
		'15555550102@s.whatsapp.net': { full: 'Bob Fixture', push: 'bob' },
		'15555550103@s.whatsapp.net': { full: 'Carol Fixture' },
		'15555550110@s.whatsapp.net': { push: 'shop', business: 'Fixture Shop' }
	}
}

// ---- WAHA's message store: contacts and lid_map (NOWEBPsqlKVRepository: data = JSON of the entity) ----
const storeContacts = [
	{ id: ALICE_PN, lid: ALICE_LID, name: 'Alice Fixture', notify: 'alice' },
	{ id: BOB_LID, phoneNumber: '15555550102@s.whatsapp.net', name: 'Bob Fixture', notify: 'bob' },
	{ id: '15555550103@s.whatsapp.net', name: 'Carol Fixture' },
	{ id: '15555550110@s.whatsapp.net', notify: 'shop', verifiedName: 'Fixture Shop' },
	{ id: GROUP, name: 'a group is not a contact' }
]
const storeLidMap = [
	{ id: ALICE_LID, pn: ALICE_PN },
	{ id: FRANK_LID, pn: FRANK_PN },
	{ id: '100000000000107@lid', pn: '15555550107@s.whatsapp.net' } // only known to the store
]

const write = (name, data) => writeFileSync(join(out, name), typeof data === 'string' ? data : JSON.stringify(data, null, '\t') + '\n')
write('rows.json', snapshot)
write('store.contacts.json', storeContacts.map(c => ({ id: c.id, data: JSON.stringify(c, BufferJSON.replacer) })))
write('store.lid_map.json', storeLidMap.map(m => ({ id: m.id, pn: m.pn, data: JSON.stringify(m) })))
write('expect.json', expect)
write('after.json', after)
// How each peer addresses our device (their session with us is keyed by it).
const ourJidFor = { alice: ME_LID_JID, bob: ME_LID_JID, carol: ME_JID, dave: ME_JID, phone: ME_JID, erin: ME_JID, frank: ME_JID }
write('peers.json', {
	me: { jid: ME_JID, lid: ME_LID_JID, group: GROUP },
	peers: [alice, bob, carol, dave, phone, erin, frank].map(p => ({ ...p.dump(), ourJid: ourJidFor[p.name] }))
})
process.stderr.write(`wrote ${snapshot.length} auth rows to ${out}\n`)
