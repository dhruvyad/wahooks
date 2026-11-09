// Package verify checks a converted whatsmeow store against the WAHA auth rows it came from.
package verify

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"sort"

	"go.mau.fi/libsignal/ecc"
	"go.mau.fi/libsignal/protocol"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/migrate/internal/convert"
	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

// Check is one verification result. Detail never holds key material.
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Warn   bool   `json:"warn,omitempty"` // informational: does not fail the run
	Detail string `json:"detail,omitempty"`
}

// Result of a verification run.
type Result struct {
	Checks []Check `json:"checks"`
}

func (r *Result) add(name string, ok bool, format string, args ...any) {
	r.Checks = append(r.Checks, Check{Name: name, OK: ok, Detail: fmt.Sprintf(format, args...)})
}

func (r *Result) warn(name string, ok bool, format string, args ...any) {
	r.Checks = append(r.Checks, Check{Name: name, OK: ok, Warn: true, Detail: fmt.Sprintf(format, args...)})
}

// OK reports whether every check passed (warnings excluded).
func (r *Result) OK() bool { return len(r.Failed()) == 0 }

// Failed lists failed checks (warnings excluded).
func (r *Result) Failed() []Check {
	var out []Check
	for _, c := range r.Checks {
		if !c.OK && !c.Warn {
			out = append(out, c)
		}
	}
	return out
}

// Store compares the device in t (loaded back through whatsmeow's own code) with st.
func Store(ctx context.Context, st *wahaauth.AuthState, t *convert.Target, opt convert.Options) (*Result, error) {
	f, err := convert.DeviceFromCreds(st.Creds)
	if err != nil {
		return nil, err
	}
	dev, err := t.Container.GetDevice(ctx, f.ID)
	if err != nil {
		return nil, fmt.Errorf("load device: %w", err)
	}
	r := &Result{}
	if dev == nil {
		r.add("device present", false, "no device with this JID in the target")
		return r, nil
	}
	r.add("device present", true, "")
	r.add("JID (user, device)", dev.ID != nil && *dev.ID == f.ID, "device %d", f.ID.Device)
	r.add("LID", dev.LID == f.LID, "")
	r.add("registration id", dev.RegistrationID == st.Creds.RegistrationID, "%d", dev.RegistrationID)

	// Public keys, derived by whatsmeow from the stored private keys, must equal Baileys'.
	pubEq := func(name string, got *[32]byte, want wahaauth.Bytes) {
		w, err := want.PublicKey32(name)
		r.add(name+" public key derives identically", err == nil && got != nil && *got == *w, "")
	}
	pubEq("noise key", dev.NoiseKey.Pub, st.Creds.NoiseKey.Public)
	pubEq("identity key", dev.IdentityKey.Pub, st.Creds.SignedIdentityKey.Public)
	pubEq("signed pre-key", dev.SignedPreKey.Pub, st.Creds.SignedPreKey.KeyPair.Public)
	r.add("signed pre-key id", dev.SignedPreKey.KeyID == st.Creds.SignedPreKey.KeyID, "%d", dev.SignedPreKey.KeyID)
	r.add("signed pre-key signature verifies",
		ecc.VerifySignature(ecc.NewDjbECPublicKey(*dev.IdentityKey.Pub), append([]byte{ecc.DjbType}, dev.SignedPreKey.Pub[:]...), *dev.SignedPreKey.Signature), "")
	adv, _ := base64.StdEncoding.DecodeString(st.Creds.AdvSecretKey)
	r.add("ADV secret key", bytes.Equal(dev.AdvSecretKey, adv), "")
	var details waAdv.ADVDeviceIdentity
	derr := proto.Unmarshal(dev.Account.GetDetails(), &details)
	r.add("ADV device identity details parse", derr == nil, "key index %d", details.GetKeyIndex())
	if derr == nil {
		err := convert.VerifyAccount(dev.Account, &details, dev.IdentityKey)
		r.add("ADV account + device signatures verify", err == nil, "%v", errOrEmpty(err))
	}
	r.add("ADV account fields byte-identical",
		bytes.Equal(dev.Account.Details, st.Creds.Account.Details) &&
			bytes.Equal(dev.Account.AccountSignatureKey, st.Creds.Account.AccountSignatureKey) &&
			bytes.Equal(dev.Account.AccountSignature, st.Creds.Account.AccountSignature) &&
			bytes.Equal(dev.Account.DeviceSignature, st.Creds.Account.DeviceSignature), "")
	r.add("platform", dev.Platform == st.Creds.Platform, "%q", dev.Platform)
	wantPush := st.Creds.Me.Name
	if opt.PushName != "" {
		wantPush = opt.PushName
	}
	r.add("push name", dev.PushName == wantPush, "set=%t", dev.PushName != "")

	// The login payload whatsmeow will send: username and device must be ours.
	payload := dev.GetClientPayload()
	r.add("login payload identifies this device",
		payload.GetUsername() == f.ID.UserInt() && payload.GetDevice() == uint32(f.ID.Device) && payload.GetPassive() && payload.GetPull(),
		"passive=%t pull=%t", payload.GetPassive(), payload.GetPull())

	if !f.LID.IsEmpty() {
		pn, err := dev.LIDs.GetPNForLID(ctx, f.LID.ToNonAD())
		r.add("own LID ↔ PN mapping", err == nil && pn.User == f.ID.User, "")
		main := f.LID.ToNonAD()
		ok, err := dev.Identities.IsTrustedIdentity(ctx, main.SignalAddress().String(), *(*[32]byte)(st.Creds.Account.AccountSignatureKey))
		r.add("primary device identity stored", err == nil && ok, "")
	}

	// Pre-keys.
	ids := make([]uint32, 0, len(st.PreKeys))
	for id := range st.PreKeys {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	bad := 0
	for _, id := range ids {
		pk, err := dev.PreKeys.GetPreKey(ctx, id)
		want, werr := st.PreKeys[id].Public.PublicKey32("pre-key")
		if err != nil || pk == nil || werr != nil || *pk.Pub != *want {
			bad++
		}
	}
	r.add("pre-keys load with identical public keys", bad == 0, "%d of %d", len(ids)-bad, len(ids))
	uploaded, err := dev.PreKeys.UploadedPreKeyCount(ctx)
	r.add("pre-keys marked uploaded", err == nil, "%d", uploaded)

	// Sessions: each must load through whatsmeow's Device (libsignal SessionStore).
	if !opt.SkipSessions {
		loaded, failed, missing := 0, 0, 0
		for addr, rec := range st.Sessions {
			maddr, err := convert.SignalAddress(addr)
			if err != nil {
				continue
			}
			has, _ := dev.Sessions.HasSession(ctx, maddr)
			if !has {
				missing++ // dropped on purpose; the conversion report says why
				continue
			}
			name, devID := splitAddr(maddr)
			sess, err := dev.LoadSession(ctx, protocol.NewSignalAddress(name, devID))
			if err != nil || sess == nil || sess.IsFresh() {
				failed++
				continue
			}
			state := sess.SessionState()
			var open *wahaauth.NodeSessionEntry
			for _, e := range rec.Entries {
				if e.IsOpen() && (open == nil || e.IndexInfo.Used > open.IndexInfo.Used) {
					open = e
				}
			}
			if open == nil || !bytes.Equal(state.RootKey().Bytes(), open.CurrentRatchet.RootKey) ||
				state.RemoteRegistrationID() != regID(open, rec) || !state.HasSenderChain() {
				failed++
				continue
			}
			loaded++
		}
		r.add("sessions load in whatsmeow with the same root key and registration id", failed == 0, "%d loaded, %d dropped by the converter", loaded, missing)
	}

	if !opt.SkipSenderKeys {
		loaded, failed := 0, 0
		for name, states := range st.SenderKeys {
			group, sender, err := convert.SenderKeyName(name)
			if err != nil {
				continue
			}
			n, d := splitAddr(sender)
			rec, err := dev.LoadSenderKey(ctx, protocol.NewSenderKeyName(group, protocol.NewSignalAddress(n, d)))
			if err != nil || rec == nil || rec.IsEmpty() {
				failed++
				continue
			}
			cur, err := rec.SenderKeyState()
			newest := states[len(states)-1]
			if err != nil || cur.KeyID() != newest.SenderKeyID || cur.SenderChainKey().Iteration() != newest.SenderChainKey.Iteration {
				failed++
				continue
			}
			loaded++
		}
		r.add("sender keys load with the same key id and iteration", failed == 0, "%d loaded", loaded)
	}

	if !opt.AppStateKeysOnly {
		bad := 0
		for name, v := range st.AppStateVersions {
			ver, hash, err := dev.AppState.GetAppStateVersion(ctx, name)
			if err != nil || ver != uint64(v.Version) || !bytes.Equal(hash[:], v.Hash) {
				bad++
				continue
			}
			for idx, val := range v.IndexValueMap {
				im, _ := base64.StdEncoding.DecodeString(idx)
				mac, err := dev.AppState.GetAppStateMutationMAC(ctx, name, im)
				if err != nil || !bytes.Equal(mac, val.ValueMac) {
					bad++
					break
				}
			}
		}
		r.add("app state versions, LTHash and value MACs", bad == 0, "%d collections", len(st.AppStateVersions))
	}
	akBad := 0
	for id, k := range st.AppStateSyncKeys {
		raw, _ := base64.StdEncoding.DecodeString(id)
		got, err := dev.AppStateKeys.GetAppStateSyncKey(ctx, raw)
		if err != nil || got == nil || !bytes.Equal(got.Data, k.KeyData) {
			akBad++
		}
	}
	r.add("app state sync keys", akBad == 0, "%d keys", len(st.AppStateSyncKeys))
	if st.Creds.MyAppStateKeyID != "" {
		latest, err := dev.AppStateKeys.GetLatestAppStateSyncKeyID(ctx)
		want, _ := base64.StdEncoding.DecodeString(st.Creds.MyAppStateKeyID)
		// whatsmeow picks the newest key by timestamp to encode its own patches; Baileys used the
		// last key it received. A difference does not affect connecting or decrypting.
		r.warn("newest app state key = creds.myAppStateKeyId", err == nil && bytes.Equal(latest, want), "")
	}

	lidBad := 0
	for pn, lid := range st.LIDForPN {
		got, err := dev.LIDs.GetLIDForPN(ctx, types.JID{User: pn, Server: types.DefaultUserServer})
		if err != nil || got.User != lid {
			lidBad++
		}
	}
	r.add("LID mappings", lidBad == 0, "%d", len(st.LIDForPN))
	if st.StoreContacts != nil {
		missing := 0
		for _, c := range st.StoreContacts {
			j, err := types.ParseJID(c.ID)
			if err != nil || c.Name == "" || (j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer) {
				continue
			}
			info, err := dev.Contacts.GetContact(ctx, j.ToNonAD())
			if err != nil || info.FullName != c.Name {
				missing++
			}
		}
		r.add("contact names from WAHA's store", missing == 0, "%d contacts", len(st.StoreContacts))
	}
	return r, nil
}

func regID(e *wahaauth.NodeSessionEntry, rec *wahaauth.NodeSessionRecord) uint32 {
	if e.RegistrationID != nil {
		return *e.RegistrationID
	}
	if rec.RegistrationID != nil {
		return *rec.RegistrationID
	}
	return 0
}

func splitAddr(a string) (string, uint32) {
	for i := len(a) - 1; i >= 0; i-- {
		if a[i] == ':' {
			var d uint32
			fmt.Sscanf(a[i+1:], "%d", &d)
			return a[:i], d
		}
	}
	return a, 0
}

func errOrEmpty(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
