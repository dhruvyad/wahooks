// Generates WAHA NOWEB `messages` and `chats` rows exactly as WAHA's NOWEBPsqlKVRepository stores
// them (protobufjs WAMessage → convertProtobufToPlainObject → replaceLongsWithNumber →
// JSON.stringify(BufferJSON.replacer)), with the Baileys build WAHA ships. Offline; every
// identity and key is invented. Also writes, per message, the protobuf wire bytes of its
// content: what whatsmeow would have received live, for the gateway-side comparison.
//
// Usage: node history.mjs <outdir>

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { B, BufferJSON, proto } from './lib.mjs'

const out = process.argv[2]
if (!out) throw new Error('usage: node history.mjs <outdir>')
mkdirSync(out, { recursive: true })

// ---- WAHA src/core/engines/noweb/utils.ts and NOWEBPsqlKVRepository.ts, verbatim logic ----
function convertProtobufToPlainObject(obj) {
	if (typeof obj !== 'object' || obj === null) return obj
	if (Buffer.isBuffer(obj) || obj?.type == 'Buffer' || obj instanceof Uint8Array) return obj
	if (Array.isArray(obj) && obj.length === 0) return undefined
	if (Array.isArray(obj)) return obj.map(item => convertProtobufToPlainObject(item))
	const plainObject = {}
	Object.keys(obj).forEach(key => {
		plainObject[key] = convertProtobufToPlainObject(obj[key])
	})
	return { ...plainObject }
}
const isObjectALong = v => v && typeof v === 'object' && 'low' in v && 'high' in v && 'unsigned' in v
const toNumber = ({ low, high, unsigned }) => (unsigned ? low >>> 0 : low + high * 0x100000000)
function replaceLongsWithNumber(obj) {
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			if (isObjectALong(obj[key])) obj[key] = toNumber(obj[key])
			else if (typeof obj[key] === 'object' && obj[key] !== null) replaceLongsWithNumber(obj[key])
		}
	}
}
const stringify = data => JSON.stringify(data, BufferJSON.replacer).replace(/\u0000/g, '')
const dump = entity => {
	const raw = convertProtobufToPlainObject(entity)
	replaceLongsWithNumber(raw)
	return raw
}

// ---- identities (fictional) -----------------------------------------------------------------
const ME_PN = '15555550123'
const ALICE = '15555550101@s.whatsapp.net'
const BOB_LID = '100000000000102@lid'
const BOB_PN = '15555550102@s.whatsapp.net'
const LID_CHAT = '100000000000107@lid'
const LID_CHAT_PN = '15555550107@s.whatsapp.net'
const GROUP = '120363000000000001@g.us'
const T0 = 1794100000 // 2026-11-08; tests pass an explicit retention cutoff
const S = proto.WebMessageInfo.Status

const media = len => ({
	url: 'https://mmg.whatsapp.net/v/t62.7118-24/fixture.enc',
	mimetype: 'image/jpeg',
	caption: 'a picture',
	fileSha256: createHash('sha256').update('plain').digest(),
	fileLength: len,
	height: 640,
	width: 480,
	mediaKey: randomBytes(32),
	fileEncSha256: createHash('sha256').update('enc').digest(),
	directPath: '/v/t62.7118-24/fixture.enc?ccb=11-4',
	mediaKeyTimestamp: T0 - 100,
	jpegThumbnail: randomBytes(64)
})

// Each case: the Baileys WAMessage as WAHA receives it, plus Baileys-only key fields
// (remoteJidAlt, participantAlt, addressingMode are not protobuf fields).
const cases = [
	{ name: 'text', skip: null, key: { remoteJid: ALICE, fromMe: false, id: '3EB0TEXT0001' }, ts: T0 - 600, pushName: 'alice', status: S.DELIVERY_ACK,
		message: { conversation: 'hello from alice' } },
	{ name: 'reply (fromMe, quoted)', skip: null, key: { remoteJid: ALICE, fromMe: true, id: '3EB0REPLY002' }, ts: T0 - 500, status: S.READ,
		message: { extendedTextMessage: { text: 'hi alice', contextInfo: { stanzaId: '3EB0TEXT0001', participant: ALICE, quotedMessage: { conversation: 'hello from alice' } } } } },
	{ name: 'image with media keys', skip: null, key: { remoteJid: ALICE, fromMe: false, id: '3EB0IMAGE003' }, ts: T0 - 400, pushName: 'alice', status: S.DELIVERY_ACK,
		message: { imageMessage: media(54321) } },
	{ name: 'reaction', skip: 'reaction', key: { remoteJid: ALICE, fromMe: false, id: '3EB0REACT004' }, ts: T0 - 300, pushName: 'alice',
		message: { reactionMessage: { key: { remoteJid: ALICE, fromMe: false, id: '3EB0TEXT0001' }, text: '👍', senderTimestampMs: (T0 - 300) * 1000 } } },
	{ name: 'group message (LID participant)', skip: null, key: { remoteJid: GROUP, fromMe: false, id: '3EB0GROUP005', participant: BOB_LID, participantAlt: BOB_PN, addressingMode: 'lid' },
		ts: T0 - 200, pushName: 'bob', status: S.DELIVERY_ACK, message: { conversation: 'group hello' } },
	{ name: 'LID-addressed chat, incoming', skip: null, key: { remoteJid: LID_CHAT, fromMe: false, id: '3EB0LIDIN006', remoteJidAlt: LID_CHAT_PN, addressingMode: 'lid' },
		ts: T0 - 150, pushName: 'gina', status: S.DELIVERY_ACK, message: { conversation: 'lid hello' } },
	{ name: 'LID-addressed chat, fromMe', skip: null, key: { remoteJid: LID_CHAT, fromMe: true, id: '3EB0LIDME007', remoteJidAlt: LID_CHAT_PN, addressingMode: 'lid' },
		ts: T0 - 100, status: S.SERVER_ACK, message: { conversation: 'lid reply' } },
	{ name: 'disappearing (ephemeral wrapper)', skip: null, key: { remoteJid: ALICE, fromMe: false, id: '3EB0EPHEM008' }, ts: T0 - 50, pushName: 'alice', status: S.DELIVERY_ACK,
		message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'this disappears', contextInfo: { expiration: 604800 } } } } } },
	{ name: 'document', skip: null, key: { remoteJid: ALICE, fromMe: false, id: '3EB0DOCUM010' }, ts: T0 - 45, pushName: 'alice', status: S.DELIVERY_ACK,
		message: { documentMessage: { url: 'https://mmg.whatsapp.net/d/f/doc.enc', mimetype: 'application/pdf', title: 'report', fileSha256: randomBytes(32), fileLength: 12345678, pageCount: 3, // < 2^32: WAHA keeps only the low 32 bits of unsigned 64-bit values (utils.ts toNumber)
			mediaKey: randomBytes(32), fileName: 'report.pdf', fileEncSha256: randomBytes(32), directPath: '/v/t62.7119-24/doc.enc', mediaKeyTimestamp: T0 - 46, jpegThumbnail: randomBytes(16) } } },
	{ name: 'voice note', skip: null, key: { remoteJid: ALICE, fromMe: true, id: '3EB0AUDIO011' }, ts: T0 - 44, status: S.PLAYED,
		message: { audioMessage: { url: 'https://mmg.whatsapp.net/a.enc', mimetype: 'audio/ogg; codecs=opus', fileSha256: randomBytes(32), fileLength: 4096, seconds: 7, ptt: true,
			mediaKey: randomBytes(32), fileEncSha256: randomBytes(32), directPath: '/v/t62.7117-24/a.enc', mediaKeyTimestamp: T0 - 45, waveform: randomBytes(64) } } },
	{ name: 'video', skip: null, key: { remoteJid: GROUP, fromMe: false, id: '3EB0VIDEO012', participant: BOB_LID, participantAlt: BOB_PN, addressingMode: 'lid' }, ts: T0 - 43, pushName: 'bob', status: S.DELIVERY_ACK,
		message: { videoMessage: { url: 'https://mmg.whatsapp.net/v.enc', mimetype: 'video/mp4', fileSha256: randomBytes(32), fileLength: 2000000, seconds: 12, mediaKey: randomBytes(32),
			caption: 'clip', gifPlayback: false, height: 720, width: 1280, fileEncSha256: randomBytes(32), directPath: '/v/t62.7161-24/v.enc', mediaKeyTimestamp: T0 - 44, jpegThumbnail: randomBytes(16) } } },
	{ name: 'sticker', skip: null, key: { remoteJid: ALICE, fromMe: false, id: '3EB0STICK013' }, ts: T0 - 42, pushName: 'alice', status: S.DELIVERY_ACK,
		message: { stickerMessage: { url: 'https://mmg.whatsapp.net/s.enc', fileSha256: randomBytes(32), fileEncSha256: randomBytes(32), mediaKey: randomBytes(32), mimetype: 'image/webp',
			height: 512, width: 512, directPath: '/v/t62.15575-24/s.enc', fileLength: 20000, mediaKeyTimestamp: T0 - 43, isAnimated: false, pngThumbnail: randomBytes(8) } } },
	{ name: 'location', skip: null, key: { remoteJid: LID_CHAT, fromMe: false, id: '3EB0LOCAT014', remoteJidAlt: LID_CHAT_PN, addressingMode: 'lid' }, ts: T0 - 41, pushName: 'gina', status: S.DELIVERY_ACK,
		message: { locationMessage: { degreesLatitude: 52.520008, degreesLongitude: 13.404954, name: 'Somewhere', address: 'A street 1', jpegThumbnail: randomBytes(8) } } },
	{ name: 'contact card', skip: null, key: { remoteJid: ALICE, fromMe: true, id: '3EB0VCARD015' }, ts: T0 - 40, status: S.SERVER_ACK,
		message: { contactMessage: { displayName: 'Someone', vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Someone\nTEL;type=CELL:+1 555 555 0199\nEND:VCARD' } } },
	{ name: 'poll', skip: null, key: { remoteJid: GROUP, fromMe: true, id: '3EB0POLLS016' }, ts: T0 - 39, status: S.SERVER_ACK,
		message: { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'yes' }, { optionName: 'no' }], selectableOptionsCount: 1 },
			messageContextInfo: { messageSecret: randomBytes(32) } } },
	{ name: 'group text with mention', skip: null, key: { remoteJid: GROUP, fromMe: false, id: '3EB0MENTN017', participant: BOB_LID, participantAlt: BOB_PN, addressingMode: 'lid' }, ts: T0 - 38, pushName: 'bob', status: S.READ,
		message: { extendedTextMessage: { text: 'hey @100000000000001', contextInfo: { mentionedJid: ['100000000000001@lid'] } } } },
	{ name: 'older than retention', skip: 'retention', key: { remoteJid: ALICE, fromMe: false, id: '3EB0OLDOLD09' }, ts: T0 - 60 * 86400, pushName: 'alice', status: S.READ,
		message: { conversation: 'two months ago' } }
]

const messageRows = []
const expect = []
for (const c of cases) {
	const protoKey = { remoteJid: c.key.remoteJid, fromMe: c.key.fromMe, id: c.key.id, participant: c.key.participant }
	// A real protobufjs instance, Longs and all, as Baileys hands it to WAHA's store.
	const wmi = proto.WebMessageInfo.decode(
		proto.WebMessageInfo.encode({ key: protoKey, message: c.message, messageTimestamp: c.ts, pushName: c.pushName, status: c.status }).finish()
	)
	// Baileys 7 adds the alt fields to the key object at runtime.
	for (const f of ['remoteJidAlt', 'participantAlt', 'addressingMode']) if (c.key[f]) wmi.key[f] = c.key[f]
	const entity = dump(wmi)
	messageRows.push({ jid: c.key.remoteJid, id: c.key.id, messageTimestamp: c.ts, data: stringify(entity) })
	expect.push({
		name: c.name,
		id: c.key.id,
		chat: c.key.remoteJid,
		fromMe: c.key.fromMe,
		participant: c.key.participant || '',
		alt: c.key.remoteJidAlt || c.key.participantAlt || '',
		ts: c.ts,
		pushName: c.pushName || '',
		status: c.status ?? 0,
		skip: c.skip,
		// the content whatsmeow would have received live, as protobuf wire bytes
		wire: Buffer.from(proto.Message.encode(proto.Message.fromObject(c.message)).finish()).toString('base64'),
		mediaKey: c.message.imageMessage ? Buffer.from(wmi.message.imageMessage.mediaKey).toString('base64') : undefined
	})
}

// Chats, as Baileys' chats.upsert gives them (Conversation fields; WAHA keeps conversationTimestamp
// as a column too and drops `messages`).
const chats = [
	{ id: ALICE, name: 'Alice Fixture', conversationTimestamp: T0 - 50, unreadCount: 2 },
	{ id: GROUP, name: 'Fixture Group', conversationTimestamp: T0 - 200, unreadCount: 0, archived: true },
	{ id: LID_CHAT, conversationTimestamp: T0 - 100, unreadCount: 0, markedAsUnread: true }
]
const chatRows = chats.map(ch => {
	const conv = proto.Conversation.decode(proto.Conversation.encode(ch).finish())
	const entity = dump(conv)
	return { id: ch.id, conversationTimestamp: ch.conversationTimestamp, data: stringify(entity) }
})

const write = (name, data) => writeFileSync(join(out, name), JSON.stringify(data, null, '\t') + '\n')
write('messages.json', messageRows)
write('chats.json', chatRows)
write('expect.json', { me: { pn: `${ME_PN}:23@s.whatsapp.net`, lid: '100000000000001:23@lid' }, chats, messages: expect })
process.stderr.write(`wrote ${messageRows.length} messages and ${chatRows.length} chats to ${out}\n`)
