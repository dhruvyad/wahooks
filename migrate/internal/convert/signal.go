package convert

import (
	"bytes"
	"errors"
	"fmt"
	"sort"

	"go.mau.fi/libsignal/groups/ratchet"
	groupRecord "go.mau.fi/libsignal/groups/state/record"
	"go.mau.fi/libsignal/kdf"
	"go.mau.fi/libsignal/keys/chain"
	"go.mau.fi/libsignal/keys/message"
	"go.mau.fi/libsignal/state/record"
	"go.mau.fi/libsignal/util/optional"
	"go.mau.fi/whatsmeow/store"

	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

// Limits from go.mau.fi/libsignal (state/record SessionRecord.go, SessionState.go,
// groups/state/record SenderKeyRecord.go, SenderKeyState.go).
const (
	maxPreviousStates  = 40
	maxReceiverChains  = 5
	maxMessageKeys     = 2000
	maxSenderKeyStates = 5
	maxSenderMsgKeys   = 2000
)

var serializer = store.SignalProtobufSerializer

// Structural reasons a libsignal-node record cannot be used (by either library).
var (
	ErrNoOpenSession  = errors.New("no open session")
	ErrNoSendingChain = errors.New("no sending chain")
)

// SessionResult is the outcome of converting one libsignal-node SessionRecord.
type SessionResult struct {
	Serialized     []byte
	RemoteIdentity []byte // 33 bytes, from the open session
	PreviousStates int
	DroppedEntries int
	DroppedChains  int
}

// ConvertSession maps a libsignal-node SessionRecord (one "session-<addr>" row) onto
// go.mau.fi/libsignal's SessionStructure, which whatsmeow stores (JSON-serialised).
//
//	libsignal-node SessionEntry              go-libsignal StateStructure
//	registrationId                           RemoteRegistrationID
//	currentRatchet.rootKey                   RootKey
//	currentRatchet.previousCounter           PreviousCounter (clamped at 0)
//	currentRatchet.ephemeralKeyPair          SenderChain.SenderRatchetKey{Public,Private}
//	_chains[ephemeral pub] (SENDING)         SenderChain.ChainKey {Index: counter+1, Key}
//	_chains[*] (RECEIVING), in order         ReceiverChains (last 5), ChainKey {counter+1, Key}
//	_chains[*].messageKeys[n] (seed)         MessageKeys[n] = HKDF(seed, "WhisperMessageKeys")
//	indexInfo.baseKey                        SenderBaseKey (Alice's base key on both sides)
//	indexInfo.remoteIdentityKey              RemoteIdentityPublic
//	pendingPreKey {preKeyId,signedKeyId,baseKey} PendingPreKey
//	(our creds)                              LocalIdentityPublic, LocalRegistrationID
//	indexInfo.closed == -1                   SessionState; closed entries → PreviousStates
//
// libsignal-node's chain counter is the index of the last derived key (-1 = none), while
// go-libsignal's chain key index is the next one, hence counter+1.
func ConvertSession(rec *wahaauth.NodeSessionRecord, localIdentity33 []byte, localRegID uint32) (*SessionResult, error) {
	if len(rec.Entries) == 0 {
		return nil, fmt.Errorf("record has no sessions")
	}
	res := &SessionResult{}
	var open *wahaauth.NodeSessionEntry
	var closed []*wahaauth.NodeSessionEntry
	for _, e := range rec.Entries {
		if e.IsOpen() {
			if open == nil || e.IndexInfo.Used > open.IndexInfo.Used {
				if open != nil {
					closed = append(closed, open)
				}
				open = e
				continue
			}
		}
		closed = append(closed, e)
	}
	if open == nil {
		return nil, ErrNoOpenSession
	}
	// go-libsignal keeps previous states newest first.
	sort.SliceStable(closed, func(i, j int) bool {
		a, b := closed[i].IndexInfo, closed[j].IndexInfo
		if a.Used != b.Used {
			return a.Used > b.Used
		}
		return a.Closed > b.Closed
	})

	legacyRegID := rec.RegistrationID
	cur, droppedChains, err := convertEntry(open, localIdentity33, localRegID, legacyRegID)
	if err != nil {
		return nil, fmt.Errorf("open session: %w", err)
	}
	res.DroppedChains += droppedChains
	structure := &record.SessionStructure{SessionState: cur}
	for _, e := range closed {
		if len(structure.PreviousStates) == maxPreviousStates {
			res.DroppedEntries++
			continue
		}
		st, dc, err := convertEntry(e, localIdentity33, localRegID, legacyRegID)
		if err != nil {
			// A broken old session only matters for very late messages; keep the rest.
			res.DroppedEntries++
			continue
		}
		res.DroppedChains += dc
		structure.PreviousStates = append(structure.PreviousStates, st)
	}
	sess, err := record.NewSessionFromStructure(structure, serializer.Session, serializer.State)
	if err != nil {
		return nil, fmt.Errorf("go-libsignal rejected the converted session: %w", err)
	}
	res.Serialized = sess.Serialize()
	res.PreviousStates = len(structure.PreviousStates)
	res.RemoteIdentity = cur.RemoteIdentityPublic
	// Round-trip once more, as whatsmeow will on load.
	if _, err := record.NewSessionFromBytes(res.Serialized, serializer.Session, serializer.State); err != nil {
		return nil, fmt.Errorf("converted session does not deserialize: %w", err)
	}
	return res, nil
}

func convertEntry(e *wahaauth.NodeSessionEntry, localIdentity33 []byte, localRegID uint32, legacyRegID *uint32) (*record.StateStructure, int, error) {
	r := e.CurrentRatchet
	ourPub, err := r.EphemeralKeyPair.PubKey.PublicKey33("currentRatchet.ephemeralKeyPair.pubKey")
	if err != nil {
		return nil, 0, err
	}
	if len(r.EphemeralKeyPair.PrivKey) != 32 {
		return nil, 0, fmt.Errorf("currentRatchet.ephemeralKeyPair.privKey: want 32 bytes")
	}
	if len(r.RootKey) != 32 {
		return nil, 0, fmt.Errorf("currentRatchet.rootKey: want 32 bytes")
	}
	remoteIdentity, err := e.IndexInfo.RemoteIdentityKey.PublicKey33("indexInfo.remoteIdentityKey")
	if err != nil {
		return nil, 0, err
	}
	baseKey, err := e.IndexInfo.BaseKey.PublicKey33("indexInfo.baseKey")
	if err != nil {
		return nil, 0, err
	}
	var remoteReg uint32
	switch {
	case e.RegistrationID != nil:
		remoteReg = *e.RegistrationID
	case legacyRegID != nil:
		remoteReg = *legacyRegID
	default:
		return nil, 0, fmt.Errorf("no remote registration id")
	}

	st := &record.StateStructure{
		LocalIdentityPublic:  localIdentity33,
		LocalRegistrationID:  localRegID,
		RemoteIdentityPublic: remoteIdentity,
		RemoteRegistrationID: remoteReg,
		RootKey:              bytes.Clone(r.RootKey),
		PreviousCounter:      uint32(max(r.PreviousCounter, 0)),
		SenderBaseKey:        baseKey,
		SessionVersion:       3,
	}

	var receiving []*wahaauth.NodeChain
	for _, c := range e.Chains {
		switch c.ChainType {
		case wahaauth.ChainSending:
			if st.SenderChain != nil || !bytes.Equal(normalise33(c.RatchetKey), ourPub) {
				// libsignal-node deletes old sending chains; a stray one is unusable.
				continue
			}
			ch, err := convertChain(c, r.EphemeralKeyPair.PrivKey)
			if err != nil {
				return nil, 0, fmt.Errorf("sending chain: %w", err)
			}
			st.SenderChain = ch
		case wahaauth.ChainReceiving:
			receiving = append(receiving, c)
		}
	}
	if st.SenderChain == nil {
		return nil, 0, ErrNoSendingChain
	}
	dropped := 0
	if len(receiving) > maxReceiverChains {
		dropped = len(receiving) - maxReceiverChains
		receiving = receiving[dropped:]
	}
	for _, c := range receiving {
		ch, err := convertChain(c, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("receiving chain: %w", err)
		}
		st.ReceiverChains = append(st.ReceiverChains, ch)
	}

	if p := e.PendingPreKey; p != nil {
		pb, err := p.BaseKey.PublicKey33("pendingPreKey.baseKey")
		if err != nil {
			return nil, 0, err
		}
		if p.SignedKeyID == nil {
			return nil, 0, fmt.Errorf("pendingPreKey without signedKeyId")
		}
		pp := &record.PendingPreKeyStructure{SignedPreKeyID: *p.SignedKeyID, BaseKey: pb, PreKeyID: optional.NewEmptyUint32()}
		if p.PreKeyID != nil {
			pp.PreKeyID = optional.NewOptionalUint32(*p.PreKeyID)
		}
		st.PendingPreKey = pp
	}
	return st, dropped, nil
}

func convertChain(c *wahaauth.NodeChain, priv []byte) (*record.ChainStructure, error) {
	pub := normalise33(c.RatchetKey)
	if len(pub) != 33 {
		return nil, fmt.Errorf("ratchet key: want 33 bytes, got %d", len(c.RatchetKey))
	}
	if c.ChainKey.Counter < -1 {
		return nil, fmt.Errorf("chain counter %d", c.ChainKey.Counter)
	}
	ch := &record.ChainStructure{
		SenderRatchetKeyPublic:  pub,
		SenderRatchetKeyPrivate: bytes.Clone(priv),
		ChainKey: &chain.KeyStructure{
			Key:   bytes.Clone(c.ChainKey.Key), // empty for a chain libsignal-node closed
			Index: uint32(c.ChainKey.Counter + 1),
		},
	}
	counters := c.MessageKeyCounters()
	if len(counters) > maxMessageKeys {
		counters = counters[len(counters)-maxMessageKeys:]
	}
	for _, n := range counters {
		mk, err := deriveMessageKeys(c.MessageKeys[n], n)
		if err != nil {
			return nil, err
		}
		ch.MessageKeys = append(ch.MessageKeys, mk)
	}
	return ch, nil
}

// deriveMessageKeys expands libsignal-node's stored message key seed the same way both
// libraries do before use: HKDF(seed, zero salt, "WhisperMessageKeys") → cipher, MAC, IV.
func deriveMessageKeys(seed []byte, index uint32) (*message.KeysStructure, error) {
	if len(seed) != 32 {
		return nil, fmt.Errorf("message key %d: want a 32-byte seed", index)
	}
	m, err := kdf.DeriveSecrets(seed, nil, []byte(message.KdfSalt), message.DerivedSecretsSize)
	if err != nil {
		return nil, err
	}
	return &message.KeysStructure{CipherKey: m[:32], MacKey: m[32:64], IV: m[64:80], Index: index}, nil
}

func normalise33(k []byte) []byte {
	switch {
	case len(k) == 33 && k[0] == 0x05:
		return k
	case len(k) == 32:
		return append([]byte{0x05}, k...)
	}
	return k
}

// ConvertSenderKey maps Baileys' SenderKeyRecord states onto go-libsignal's.
// Baileys keeps the newest state last; go-libsignal keeps it first.
func ConvertSenderKey(states []wahaauth.SenderKeyState) ([]byte, error) {
	if len(states) == 0 {
		return nil, fmt.Errorf("no sender key states")
	}
	if len(states) > maxSenderKeyStates {
		states = states[len(states)-maxSenderKeyStates:]
	}
	structure := &groupRecord.SenderKeyStructure{}
	for i := len(states) - 1; i >= 0; i-- {
		s := states[i]
		pub, err := s.SenderSigningKey.Public.PublicKey33("senderSigningKey.public")
		if err != nil {
			return nil, err
		}
		if n := len(s.SenderSigningKey.Private); n != 0 && n != 32 {
			return nil, fmt.Errorf("senderSigningKey.private: want 0 or 32 bytes, got %d", n)
		}
		if len(s.SenderChainKey.Seed) != 32 {
			return nil, fmt.Errorf("senderChainKey.seed: want 32 bytes")
		}
		st := &groupRecord.SenderKeyStateStructure{
			KeyID:             s.SenderKeyID,
			SenderChainKey:    &ratchet.SenderChainKeyStructure{Iteration: s.SenderChainKey.Iteration, ChainKey: bytes.Clone(s.SenderChainKey.Seed)},
			SigningKeyPublic:  pub,
			SigningKeyPrivate: bytes.Clone(s.SenderSigningKey.Private),
		}
		mks := s.SenderMessageKeys
		if len(mks) > maxSenderMsgKeys {
			mks = mks[len(mks)-maxSenderMsgKeys:]
		}
		for _, mk := range mks {
			if len(mk.Seed) != 32 {
				return nil, fmt.Errorf("sender message key %d: want a 32-byte seed", mk.Iteration)
			}
			k, err := ratchet.NewSenderMessageKey(mk.Iteration, bytes.Clone(mk.Seed))
			if err != nil {
				return nil, err
			}
			st.Keys = append(st.Keys, ratchet.NewStructFromSenderMessageKey(k))
		}
		structure.SenderKeyStates = append(structure.SenderKeyStates, st)
	}
	rec, err := groupRecord.NewSenderKeyFromStruct(structure, serializer.SenderKeyRecord, serializer.SenderKeyState)
	if err != nil {
		return nil, fmt.Errorf("go-libsignal rejected the converted sender key: %w", err)
	}
	out := rec.Serialize()
	if _, err := groupRecord.NewSenderKeyFromBytes(out, serializer.SenderKeyRecord, serializer.SenderKeyState); err != nil {
		return nil, fmt.Errorf("converted sender key does not deserialize: %w", err)
	}
	return out, nil
}
