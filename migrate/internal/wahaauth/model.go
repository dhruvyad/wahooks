package wahaauth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Baileys 7 (devlikeapro fork f6bf3cf) AuthenticationCreds, as stored in the `creds` row.
type Creds struct {
	NoiseKey                KeyPair                  `json:"noiseKey"`
	PairingEphemeralKeyPair KeyPair                  `json:"pairingEphemeralKeyPair"`
	SignedIdentityKey       KeyPair                  `json:"signedIdentityKey"`
	SignedPreKey            SignedKeyPair            `json:"signedPreKey"`
	RegistrationID          uint32                   `json:"registrationId"`
	AdvSecretKey            string                   `json:"advSecretKey"`
	Me                      *Contact                 `json:"me"`
	Account                 *ADVSignedDeviceIdentity `json:"account"`
	SignalIdentities        []SignalIdentity         `json:"signalIdentities"`
	MyAppStateKeyID         string                   `json:"myAppStateKeyId"`
	FirstUnuploadedPreKeyID uint32                   `json:"firstUnuploadedPreKeyId"`
	NextPreKeyID            uint32                   `json:"nextPreKeyId"`
	LastAccountSyncTS       Int64                    `json:"lastAccountSyncTimestamp"`
	Platform                string                   `json:"platform"`
	AccountSyncCounter      int                      `json:"accountSyncCounter"`
	Registered              bool                     `json:"registered"`
	PairingCode             *string                  `json:"pairingCode"`
	LastPropHash            *string                  `json:"lastPropHash"`
	RoutingInfo             Bytes                    `json:"routingInfo"`
	ProcessedHistory        json.RawMessage          `json:"processedHistoryMessages"`
	AccountSettings         json.RawMessage          `json:"accountSettings"`
	AdditionalData          json.RawMessage          `json:"additionalData"`
}

type KeyPair struct {
	Private Bytes `json:"private"`
	Public  Bytes `json:"public"`
}

type SignedKeyPair struct {
	KeyPair   KeyPair `json:"keyPair"`
	Signature Bytes   `json:"signature"`
	KeyID     uint32  `json:"keyId"`
}

type Contact struct {
	ID           string `json:"id"`
	LID          string `json:"lid"`
	Name         string `json:"name"`
	Notify       string `json:"notify"`
	VerifiedName string `json:"verifiedName"`
}

// ADVSignedDeviceIdentity is stored through protobufjs toJSON, so its fields are base64 strings.
type ADVSignedDeviceIdentity struct {
	Details             Bytes `json:"details"`
	AccountSignatureKey Bytes `json:"accountSignatureKey"`
	AccountSignature    Bytes `json:"accountSignature"`
	DeviceSignature     Bytes `json:"deviceSignature"`
}

type SignalIdentity struct {
	Identifier struct {
		Name     string `json:"name"`
		DeviceID int    `json:"deviceId"`
	} `json:"identifier"`
	IdentifierKey Bytes `json:"identifierKey"`
}

// SenderKeyState is Baileys' SenderKeyStateStructure (src/Signal/Group/sender-key-state.ts).
type SenderKeyState struct {
	SenderKeyID    uint32 `json:"senderKeyId"`
	SenderChainKey struct {
		Iteration uint32 `json:"iteration"`
		Seed      Bytes  `json:"seed"`
	} `json:"senderChainKey"`
	SenderSigningKey struct {
		Public  Bytes `json:"public"`
		Private Bytes `json:"private"`
	} `json:"senderSigningKey"`
	SenderMessageKeys []struct {
		Iteration uint32 `json:"iteration"`
		Seed      Bytes  `json:"seed"`
	} `json:"senderMessageKeys"`
}

// AppStateSyncKey is proto AppStateSyncKeyData after protobufjs toJSON.
type AppStateSyncKey struct {
	KeyData     Bytes `json:"keyData"`
	Fingerprint *struct {
		RawID         uint32   `json:"rawId"`
		CurrentIndex  uint32   `json:"currentIndex"`
		DeviceIndexes []uint32 `json:"deviceIndexes"`
	} `json:"fingerprint"`
	Timestamp Int64 `json:"timestamp"`
}

// LTHashState is Baileys' app-state-sync-version value.
type LTHashState struct {
	Version       Int64 `json:"version"`
	Hash          Bytes `json:"hash"`
	IndexValueMap map[string]struct {
		ValueMac Bytes `json:"valueMac"`
	} `json:"indexValueMap"`
}

// TCToken is a trusted-contact (privacy) token.
type TCToken struct {
	Token           Bytes `json:"token"`
	Timestamp       Int64 `json:"timestamp"`
	SenderTimestamp Int64 `json:"senderTimestamp"`
}

// Problem is a row that could not be read.
type Problem struct {
	ID       string
	Category string
	Err      error
}

// AuthState is a parsed `auth` table.
type AuthState struct {
	Creds            *Creds
	PreKeys          map[uint32]KeyPair
	Sessions         map[string]*NodeSessionRecord // Baileys signal address ("user[_domain].device") → record
	SenderKeys       map[string][]SenderKeyState   // "group::user[_domain]::device" → states
	AppStateSyncKeys map[string]AppStateSyncKey    // base64 key id → key
	AppStateVersions map[string]LTHashState        // collection name → state
	LIDForPN         map[string]string             // PN user → LID user
	PNForLID         map[string]string             // LID user → PN user (the "_reverse" rows)
	IdentityKeys     map[string]Bytes              // Baileys signal address → identity public key
	TCTokens         map[string]TCToken            // JID → token
	DeviceLists      map[string][]string           // user → device ids
	SenderKeyMemory  map[string]json.RawMessage    // group → {jid: true}
	Unknown          map[string]int                // unknown category → row count
	Problems         []Problem
	RowCount         int

	// Optional, from WAHA's message store (store.go); nil unless given.
	StoreContacts []StoreContact
	StoreLIDForPN map[string]string
}

// Categories in Baileys' SignalDataTypeMap. Order matters: longest prefix first.
var categories = []string{
	"app-state-sync-version",
	"app-state-sync-key",
	"sender-key-memory",
	"sender-key",
	"pre-key",
	"session",
	"lid-mapping",
	"device-list",
	"identity-key",
	"tctoken",
}

// SplitID splits a row id into its category and key ("creds" has an empty key).
func SplitID(id string) (category, key string) {
	if id == "creds" {
		return "creds", ""
	}
	for _, c := range categories {
		if strings.HasPrefix(id, c+"-") {
			return c, id[len(c)+1:]
		}
	}
	if i := strings.Index(id, "-"); i > 0 {
		return id[:i], id[i+1:]
	}
	return id, ""
}

// unwrap returns the stored value from WAHA's `{"id":…,"data":…}` envelope. A value
// written by another exporter without the envelope is returned as is.
func unwrap(row Row) (json.RawMessage, error) {
	var env map[string]json.RawMessage
	raw := []byte(row.Data)
	if err := json.Unmarshal(raw, &env); err != nil {
		// Not an object: a bare value (e.g. a lid-mapping string written without envelope).
		var v json.RawMessage
		if err2 := json.Unmarshal(raw, &v); err2 != nil {
			return nil, fmt.Errorf("data is not JSON: %w", err)
		}
		return v, nil
	}
	d, hasData := env["data"]
	idRaw, hasID := env["id"]
	if hasData && hasID {
		var id string
		_ = json.Unmarshal(idRaw, &id)
		if id == row.ID || len(env) == 2 {
			return d, nil
		}
	}
	return raw, nil
}

// Parse reads every row. A row that fails to parse is recorded in Problems and skipped;
// only a missing or unreadable creds row is an error.
func Parse(rows []Row) (*AuthState, error) {
	st := &AuthState{
		PreKeys:          map[uint32]KeyPair{},
		Sessions:         map[string]*NodeSessionRecord{},
		SenderKeys:       map[string][]SenderKeyState{},
		AppStateSyncKeys: map[string]AppStateSyncKey{},
		AppStateVersions: map[string]LTHashState{},
		LIDForPN:         map[string]string{},
		PNForLID:         map[string]string{},
		IdentityKeys:     map[string]Bytes{},
		TCTokens:         map[string]TCToken{},
		DeviceLists:      map[string][]string{},
		SenderKeyMemory:  map[string]json.RawMessage{},
		Unknown:          map[string]int{},
		RowCount:         len(rows),
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if seen[row.ID] {
			return nil, fmt.Errorf("duplicate row id %q: the export is not one session's auth table", row.ID)
		}
		seen[row.ID] = true
		cat, key := SplitID(row.ID)
		if err := st.parseRow(row, cat, key); err != nil {
			if cat == "creds" {
				return nil, fmt.Errorf("creds row: %w", err)
			}
			st.Problems = append(st.Problems, Problem{ID: row.ID, Category: cat, Err: err})
		}
	}
	if st.Creds == nil {
		return nil, fmt.Errorf("no creds row: this is not a NOWEB auth table, or the export is incomplete")
	}
	return st, nil
}

func (st *AuthState) parseRow(row Row, cat, key string) error {
	val, err := unwrap(row)
	if err != nil {
		return err
	}
	if string(bytes.TrimSpace(val)) == "null" {
		return nil
	}
	switch cat {
	case "creds":
		var c Creds
		if err := json.Unmarshal(val, &c); err != nil {
			return err
		}
		st.Creds = &c
	case "pre-key":
		id, err := strconv.ParseUint(key, 10, 32)
		if err != nil {
			return fmt.Errorf("pre-key id %q: %w", key, err)
		}
		var kp KeyPair
		if err := json.Unmarshal(val, &kp); err != nil {
			return err
		}
		st.PreKeys[uint32(id)] = kp
	case "session":
		rec, err := ParseNodeSessionRecord(val)
		if err != nil {
			return err
		}
		st.Sessions[key] = rec
	case "sender-key":
		states, err := parseSenderKey(val)
		if err != nil {
			return err
		}
		st.SenderKeys[key] = states
	case "sender-key-memory":
		st.SenderKeyMemory[key] = val
	case "app-state-sync-key":
		var k AppStateSyncKey
		if err := json.Unmarshal(val, &k); err != nil {
			return err
		}
		st.AppStateSyncKeys[key] = k
	case "app-state-sync-version":
		var s LTHashState
		if err := json.Unmarshal(val, &s); err != nil {
			return err
		}
		st.AppStateVersions[key] = s
	case "lid-mapping":
		var v string
		if err := json.Unmarshal(val, &v); err != nil {
			return err
		}
		if strings.HasSuffix(key, "_reverse") {
			st.PNForLID[strings.TrimSuffix(key, "_reverse")] = v
		} else {
			st.LIDForPN[key] = v
		}
	case "identity-key":
		var b Bytes
		if err := json.Unmarshal(val, &b); err != nil {
			return err
		}
		st.IdentityKeys[key] = b
	case "tctoken":
		var t TCToken
		if err := json.Unmarshal(val, &t); err != nil {
			return err
		}
		st.TCTokens[key] = t
	case "device-list":
		var l []string
		if err := json.Unmarshal(val, &l); err != nil {
			return err
		}
		st.DeviceLists[key] = l
	default:
		st.Unknown[cat]++
	}
	return nil
}

// parseSenderKey decodes Baileys' sender-key value: a Buffer holding the UTF-8 JSON of
// SenderKeyRecord.serialize() (src/Signal/libsignal.ts storeSenderKey). Older Baileys
// stored the array itself.
func parseSenderKey(val json.RawMessage) ([]SenderKeyState, error) {
	t := bytes.TrimSpace(val)
	inner := []byte(t)
	if len(t) > 0 && t[0] != '[' {
		var b Bytes
		if err := json.Unmarshal(t, &b); err != nil {
			return nil, err
		}
		inner = b
	}
	var states []SenderKeyState
	if err := json.Unmarshal(inner, &states); err != nil {
		return nil, fmt.Errorf("sender key record: %w", err)
	}
	return states, nil
}

// ---- libsignal-node SessionRecord (libsignal@6.0.0 src/session_record.js) -----------------

type NodeSessionRecord struct {
	Version string
	// Legacy (pre-"v1") records kept the registration id on the record.
	RegistrationID *uint32
	Entries        []*NodeSessionEntry // in stored order
}

type NodeSessionEntry struct {
	MapKey         string // base64 of the base key
	RegistrationID *uint32
	CurrentRatchet struct {
		EphemeralKeyPair struct {
			PubKey  Bytes `json:"pubKey"`
			PrivKey Bytes `json:"privKey"`
		} `json:"ephemeralKeyPair"`
		LastRemoteEphemeralKey Bytes `json:"lastRemoteEphemeralKey"`
		PreviousCounter        int64 `json:"previousCounter"`
		RootKey                Bytes `json:"rootKey"`
	}
	IndexInfo struct {
		BaseKey           Bytes `json:"baseKey"`
		BaseKeyType       int   `json:"baseKeyType"` // 1 ours (we initiated), 2 theirs
		Closed            int64 `json:"closed"`      // -1 = open, else ms timestamp
		Used              int64 `json:"used"`
		Created           int64 `json:"created"`
		RemoteIdentityKey Bytes `json:"remoteIdentityKey"`
	}
	Chains        []*NodeChain // in creation order
	PendingPreKey *struct {
		SignedKeyID *uint32 `json:"signedKeyId"`
		BaseKey     Bytes   `json:"baseKey"`
		PreKeyID    *uint32 `json:"preKeyId"`
	}
}

const (
	ChainSending   = 1
	ChainReceiving = 2
	BaseKeyOurs    = 1
	BaseKeyTheirs  = 2
)

type NodeChain struct {
	RatchetKey Bytes // the map key, decoded: 33-byte ratchet public key
	ChainKey   struct {
		Counter int64 `json:"counter"`
		Key     Bytes `json:"key"` // absent once the chain is closed
	}
	ChainType   int
	MessageKeys map[uint32]Bytes // counter → message key seed (HMAC(chainKey, 0x01))
}

// IsOpen reports whether libsignal-node considers the entry open.
func (e *NodeSessionEntry) IsOpen() bool { return e.IndexInfo.Closed == -1 }

func ParseNodeSessionRecord(raw json.RawMessage) (*NodeSessionRecord, error) {
	var top struct {
		Sessions       json.RawMessage `json:"_sessions"`
		Version        string          `json:"version"`
		RegistrationID *uint32         `json:"registrationId"`
	}
	t := bytes.TrimSpace(raw)
	if len(t) > 0 && t[0] == '{' {
		// A record serialised as a Buffer (not what libsignal-node does, but tolerate it).
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(t, &probe); err == nil {
			if typ, ok := probe["type"]; ok && string(typ) == `"Buffer"` {
				var b Bytes
				if err := json.Unmarshal(t, &b); err != nil {
					return nil, err
				}
				t = b
			}
		}
	}
	if err := json.Unmarshal(t, &top); err != nil {
		return nil, fmt.Errorf("session record: %w", err)
	}
	rec := &NodeSessionRecord{Version: top.Version, RegistrationID: top.RegistrationID}
	if len(top.Sessions) == 0 {
		return rec, nil
	}
	entries, err := orderedObject(top.Sessions)
	if err != nil {
		return nil, fmt.Errorf("session record _sessions: %w", err)
	}
	for _, kv := range entries {
		e, err := parseNodeEntry(kv.Key, kv.Value)
		if err != nil {
			return nil, fmt.Errorf("session entry %s: %w", kv.Key, err)
		}
		rec.Entries = append(rec.Entries, e)
	}
	return rec, nil
}

func parseNodeEntry(key string, raw json.RawMessage) (*NodeSessionEntry, error) {
	var tmp struct {
		RegistrationID *uint32         `json:"registrationId"`
		CurrentRatchet json.RawMessage `json:"currentRatchet"`
		IndexInfo      json.RawMessage `json:"indexInfo"`
		Chains         json.RawMessage `json:"_chains"`
		PendingPreKey  json.RawMessage `json:"pendingPreKey"`
	}
	if err := json.Unmarshal(raw, &tmp); err != nil {
		return nil, err
	}
	e := &NodeSessionEntry{MapKey: key, RegistrationID: tmp.RegistrationID}
	if err := json.Unmarshal(tmp.CurrentRatchet, &e.CurrentRatchet); err != nil {
		return nil, fmt.Errorf("currentRatchet: %w", err)
	}
	if err := json.Unmarshal(tmp.IndexInfo, &e.IndexInfo); err != nil {
		return nil, fmt.Errorf("indexInfo: %w", err)
	}
	if len(tmp.PendingPreKey) > 0 && string(tmp.PendingPreKey) != "null" {
		if err := json.Unmarshal(tmp.PendingPreKey, &e.PendingPreKey); err != nil {
			return nil, fmt.Errorf("pendingPreKey: %w", err)
		}
	}
	if len(tmp.Chains) > 0 {
		chains, err := orderedObject(tmp.Chains)
		if err != nil {
			return nil, fmt.Errorf("_chains: %w", err)
		}
		for _, kv := range chains {
			var c struct {
				ChainKey struct {
					Counter int64 `json:"counter"`
					Key     Bytes `json:"key"`
				} `json:"chainKey"`
				ChainType   int              `json:"chainType"`
				MessageKeys map[string]Bytes `json:"messageKeys"`
			}
			if err := json.Unmarshal(kv.Value, &c); err != nil {
				return nil, fmt.Errorf("chain %s: %w", kv.Key, err)
			}
			rk, err := decodeBase64(kv.Key)
			if err != nil {
				return nil, fmt.Errorf("chain key %q: %w", kv.Key, err)
			}
			ch := &NodeChain{RatchetKey: rk, ChainType: c.ChainType, MessageKeys: map[uint32]Bytes{}}
			ch.ChainKey.Counter = c.ChainKey.Counter
			ch.ChainKey.Key = c.ChainKey.Key
			for idx, mk := range c.MessageKeys {
				n, err := strconv.ParseUint(idx, 10, 32)
				if err != nil {
					return nil, fmt.Errorf("message key index %q: %w", idx, err)
				}
				ch.MessageKeys[uint32(n)] = mk
			}
			e.Chains = append(e.Chains, ch)
		}
	}
	return e, nil
}

// MessageKeyCounters returns the chain's stored message key counters in ascending order.
func (c *NodeChain) MessageKeyCounters() []uint32 {
	out := make([]uint32, 0, len(c.MessageKeys))
	for k := range c.MessageKeys {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

type kv struct {
	Key   string
	Value json.RawMessage
}

// orderedObject decodes a JSON object keeping its key order. libsignal-node relies on
// JavaScript's insertion order for chains, and JSON.stringify preserves it.
func orderedObject(raw json.RawMessage) ([]kv, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, fmt.Errorf("want an object")
	}
	var out []kv
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("want a string key")
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out = append(out, kv{Key: k, Value: v})
	}
	return out, nil
}
