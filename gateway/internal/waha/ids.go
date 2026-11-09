// Package waha renders whatsmeow data in WAHA's JSON shapes (NOWEB engine), as WAHooks customers receive them
// today. See CONTRACT.md for the field-by-field reference.
package waha

import (
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// Engine is reported in envelopes and session info. The gateway mimics NOWEB's payloads, so it says NOWEB.
var Engine = "NOWEB"

// Version is WAHA's environment.version reported in envelopes.
var Version = "2026.10.1"

// CUs renders a JID the way WAHA does: users as <digits>@c.us, everything else unchanged, device suffix dropped.
func CUs(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	j = j.ToNonAD()
	if j.Server == types.DefaultUserServer {
		return j.User + "@c.us"
	}
	return j.String()
}

// SWA renders a JID as Baileys keeps it in _data (s.whatsapp.net, not c.us).
func SWA(j types.JID) string {
	if j.IsEmpty() {
		return ""
	}
	return j.ToNonAD().String()
}

// MessageKey is a parsed WAHA message id.
type MessageKey struct {
	FromMe      bool
	Chat        types.JID
	ID          string
	Participant types.JID
}

// SerializeID builds WAHA's NOWEB message id: {fromMe}_{chat}_{id}[_{participant}].
func SerializeID(fromMe bool, chat types.JID, id string, participant types.JID) string {
	b := strings.Builder{}
	if fromMe {
		b.WriteString("true_")
	} else {
		b.WriteString("false_")
	}
	b.WriteString(CUs(chat))
	b.WriteByte('_')
	b.WriteString(id)
	if !participant.IsEmpty() {
		b.WriteByte('_')
		b.WriteString(CUs(participant))
	}
	return b.String()
}

// ParseMessageID accepts a serialized WAHA id or a bare WhatsApp message id.
func ParseMessageID(s string) MessageKey {
	parts := strings.Split(s, "_")
	if len(parts) >= 3 && (parts[0] == "true" || parts[0] == "false") {
		k := MessageKey{FromMe: parts[0] == "true", ID: parts[2]}
		if j, err := types.ParseJID(strings.Replace(parts[1], "@c.us", "@"+types.DefaultUserServer, 1)); err == nil {
			k.Chat = j
		}
		if len(parts) >= 4 {
			if j, err := types.ParseJID(strings.Replace(parts[3], "@c.us", "@"+types.DefaultUserServer, 1)); err == nil {
				k.Participant = j
			}
		}
		return k
	}
	return MessageKey{ID: s}
}

// Me is NOWEB's MeInfo: id, pushName, lid ("" when unknown), reachoutTimelock, messageCapping. JID is kept for
// the gateway's own use and not serialized (NOWEB has no jid).
type Me struct {
	ID               string `json:"id"`
	PushName         string `json:"pushName"`
	LID              string `json:"lid"`
	ReachoutTimelock any    `json:"reachoutTimelock"`
	MessageCapping   any    `json:"messageCapping"`
	JID              string `json:"-"`
}

// WorkerID is environment.worker.id (the box name).
var WorkerID any

// Envelope encodes a webhook body in WAHA's shape and returns it with its id and timestamp (ms).
func Envelope(event, session string, me *Me, metadata map[string]string, payload any) ([]byte, string, int64, error) {
	id := "evt_" + strings.ToLower(newULID())
	ts := time.Now().UnixMilli()
	env := struct {
		ID          string            `json:"id"`
		Timestamp   int64             `json:"timestamp"`
		Event       string            `json:"event"`
		Session     string            `json:"session"`
		Metadata    map[string]string `json:"metadata,omitempty"`
		Me          *Me               `json:"me"`
		Payload     any               `json:"payload"`
		Engine      string            `json:"engine"`
		Environment OM                `json:"environment"`
	}{
		ID: id, Timestamp: ts, Event: event, Session: session, Metadata: metadata, Me: me,
		Payload: payload, Engine: Engine,
		Environment: OM{{"version", Version}, {"engine", Engine}, {"tier", "PLUS"}, {"browser", nil}, {"platform", "linux/x64"}, {"worker", OM{{"id", WorkerID}}}},
	}
	b, err := json.Marshal(env)
	return b, id, ts, err
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newULID returns a 26-character ULID (time-ordered, random tail), as WAHA's event ids are.
func newULID() string {
	var b [16]byte
	ms := uint64(time.Now().UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	_, _ = rand.Read(b[6:])
	out := make([]byte, 26)
	// 128 bits -> 26 base32 chars (first char holds 3 bits)
	var acc uint64
	bits := 0
	idx := 25
	for i := 15; i >= 0; i-- {
		acc |= uint64(b[i]) << bits
		bits += 8
		for bits >= 5 && idx >= 0 {
			out[idx] = crockford[acc&31]
			acc >>= 5
			bits -= 5
			idx--
		}
	}
	for idx >= 0 {
		out[idx] = crockford[acc&31]
		acc >>= 5
		idx--
	}
	return string(out)
}
