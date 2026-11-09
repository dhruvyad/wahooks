// The peers' half of the round trip: decrypt what whatsmeow encrypted with the converted
// store, then reply, so the Go test can decrypt the replies too (a full DH ratchet step on
// both libraries). Offline; reads the peer states gen.mjs saved.
//
// Usage: node reverse.mjs <fixture dir> <request.json>   (writes the response to stdout)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64, fromB64, makePeer } from './lib.mjs'

const [dir, reqPath] = process.argv.slice(2)
const fixture = JSON.parse(readFileSync(join(dir, 'peers.json'), 'utf-8'))
const req = JSON.parse(readFileSync(reqPath, 'utf-8'))
const peers = Object.fromEntries(fixture.peers.map(p => [p.name, { ...p, peer: makePeer(p.name, p.jid, p) }]))

const res = { dms: [], groups: [] }
for (const dm of req.dms ?? []) {
	const p = peers[dm.to]
	const out = { to: dm.to }
	try {
		out.plaintext = b64(await p.peer.repo.decryptMessage({ jid: p.ourJid, type: dm.type, ciphertext: fromB64(dm.ciphertext) }))
		const reply = await p.peer.repo.encryptMessage({ jid: p.ourJid, data: Buffer.from(`reply from ${dm.to}`) })
		out.reply = { type: reply.type, ciphertext: b64(reply.ciphertext), plaintext: b64(Buffer.from(`reply from ${dm.to}`)) }
	} catch (err) {
		out.error = String(err?.stack ?? err)
	}
	res.dms.push(out)
}
for (const g of req.groups ?? []) {
	const p = peers[g.to]
	const out = { to: g.to }
	try {
		out.plaintext = b64(
			await p.peer.repo.decryptGroupMessage({ group: fixture.me.group, authorJid: fixture.me.lid, msg: fromB64(g.ciphertext) })
		)
	} catch (err) {
		out.error = String(err?.stack ?? err)
	}
	res.groups.push(out)
}
process.stdout.write(JSON.stringify(res) + '\n')
