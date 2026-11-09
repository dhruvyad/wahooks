// Shared helpers for the fixture generator and the reverse checker.
//
// Everything here runs offline. Nothing opens a socket: Baileys is used only for its
// key handling, pairing verification, Signal (libsignal-node) and app-state code.

import * as B from 'baileys'
import { makeLibSignalRepository } from 'baileys/lib/Signal/libsignal.js'

export { B, makeLibSignalRepository }
export const { BufferJSON, proto } = B

// libsignal-node logs session open/close with console.info; keep the output readable.
console.info = () => {}
console.warn = () => {}

export const logger = {
	level: 'silent',
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error(...a) {
		process.stderr.write(`[baileys error] ${JSON.stringify(a)}\n`)
	},
	child() {
		return logger
	}
}

/**
 * The same storage semantics as WAHA's NoWebPsqlAuth + PsqlNowebAuthRepository
 * (src/core/engines/noweb/store/psql/, WAHA commit c42f68a):
 *  - one row per key, id = `${category}-${id}` (or `creds`),
 *  - data TEXT = JSON.stringify({ id, data: value }, BufferJSON.replacer),
 *  - a set() with a null/undefined value is ignored (WAHA never deletes keys),
 *  - get('session', ['<me>.0']) returns nothing (WAHA "always resets" the session with
 *    the account's own primary device),
 *  - app-state-sync-key values are revived with AppStateSyncKeyData.fromObject.
 */
export class WahaAuthRows {
	constructor(rows = new Map()) {
		this.rows = rows
	}

	static dbId(category, id) {
		return id ? `${category}-${id}` : category
	}

	save(category, id, value) {
		const dbId = WahaAuthRows.dbId(category, id)
		this.rows.set(dbId, JSON.stringify({ id: dbId, data: value }, BufferJSON.replacer))
	}

	load(category, id) {
		const text = this.rows.get(WahaAuthRows.dbId(category, id))
		if (!text) return undefined
		return JSON.parse(text, BufferJSON.reviver)?.data
	}

	/** SignalKeyStore exactly as NoWebPsqlAuth.methods().state.keys behaves. */
	keyStore(getCreds, { wahaMainSessionReset = true } = {}) {
		return {
			get: async (type, ids) => {
				const data = {}
				for (const id of ids) {
					if (wahaMainSessionReset && type === 'session' && isMyMainSession(getCreds(), id)) continue
					let value = this.load(type, id)
					if (type === 'app-state-sync-key' && value) {
						value = proto.Message.AppStateSyncKeyData.fromObject(value)
					}
					data[id] = value
				}
				return data
			},
			set: async data => {
				for (const category of Object.keys(data)) {
					for (const id of Object.keys(data[category])) {
						const value = data[category][id]
						const hasValue = !!value || value?.length === 0
						if (hasValue) this.save(category, id, value)
					}
				}
			}
		}
	}

	toJSONRows() {
		return [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, data]) => ({ id, data }))
	}

	static fromJSONRows(list) {
		return new WahaAuthRows(new Map(list.map(r => [r.id, r.data])))
	}
}

function isMyMainSession(creds, id) {
	if (!creds?.me?.id) return false
	const { user } = B.jidDecode(creds.me.id)
	return id === `${user}.0`
}

/** A Baileys auth state wired the way WAHA wires it (cacheable store + transactions). */
export function makeAuthState(rows, creds, opts) {
	const state = { creds }
	let keys = rows.keyStore(() => state.creds, opts)
	keys = B.makeCacheableSignalKeyStore(keys, logger)
	keys = B.addTransactionCapability(keys, logger, { maxCommitRetries: 2, delayBetweenTriesMs: 1 })
	state.keys = keys
	const repo = makeLibSignalRepository(state, logger, async () => undefined)
	return { state, repo }
}

/** A simulated WhatsApp peer: its own Baileys auth state and Signal repository. */
export function makePeer(name, jid, existing) {
	const rows = existing ? WahaAuthRows.fromJSONRows(existing.rows) : new WahaAuthRows()
	const creds = existing ? JSON.parse(existing.creds, BufferJSON.reviver) : B.initAuthCreds()
	const { state, repo } = makeAuthState(rows, creds, { wahaMainSessionReset: false })
	return {
		name,
		jid,
		rows,
		state,
		repo,
		dump() {
			return { name, jid, creds: JSON.stringify(state.creds, BufferJSON.replacer), rows: rows.toJSONRows() }
		}
	}
}

export const b64 = buf => Buffer.from(buf).toString('base64')
export const fromB64 = s => Buffer.from(s, 'base64')
