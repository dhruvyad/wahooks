package convert_test

// Tests against genuine WAHA NOWEB auth rows produced by the Baileys build WAHA ships
// (fixturegen/gen.mjs), exported through real psql/pg_dump (fixturegen/export-formats.sh).
//
// The decisive checks use whatsmeow's own Signal code paths on the converted store:
// peers' messages sent AFTER the snapshot must decrypt, and (when Node is available) what
// whatsmeow encrypts must decrypt in Baileys, with replies flowing back.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"go.mau.fi/libsignal/groups"
	groupRecord "go.mau.fi/libsignal/groups/state/record"
	"go.mau.fi/libsignal/protocol"
	"go.mau.fi/libsignal/session"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waServerSync"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/dhruvyad/wahooks/migrate/internal/convert"
	"github.com/dhruvyad/wahooks/migrate/internal/verify"
	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

const fixtureDir = "../../testdata/baileys"

type expectFile struct {
	JID            string `json:"jid"`
	LID            string `json:"lid"`
	RegistrationID uint32 `json:"registrationId"`
	Platform       string `json:"platform"`
	PushName       string `json:"pushName"`
	NoisePub       string `json:"noisePub"`
	IdentityPub    string `json:"identityPub"`
	SignedPreKey   struct {
		ID  uint32 `json:"id"`
		Pub string `json:"pub"`
		Sig string `json:"sig"`
	} `json:"signedPreKey"`
	AccountSignatureKey string            `json:"accountSignatureKey"`
	PreKeys             map[string]string `json:"preKeys"`
	NextPreKeyID        uint32            `json:"nextPreKeyId"`
	AppStateKeyID       string            `json:"appStateKeyId"`
	AppStateVersions    map[string]uint64 `json:"appStateVersions"`
	Sessions            []string          `json:"sessions"`
	DroppedSessions     map[string]string `json:"droppedSessions"`
	SenderKeys          []string          `json:"senderKeys"`
	SenderKeyStates     map[string]int    `json:"senderKeyStates"`
	LIDMappings         map[string]string `json:"lidMappings"`
}

type afterFile struct {
	DMs []struct {
		From       string `json:"from"`
		Addr       string `json:"addr"`
		PNAddr     string `json:"pnAddr"` // set when whatsmeow would first migrate a PN session to this LID address
		Type       string `json:"type"`
		Ciphertext string `json:"ciphertext"`
		Plaintext  string `json:"plaintext"`
	} `json:"dms"`
	Groups []struct {
		Group      string `json:"group"`
		From       string `json:"from"`
		Addr       string `json:"addr"`
		Ciphertext string `json:"ciphertext"`
		Plaintext  string `json:"plaintext"`
	} `json:"groups"`
	AppState []struct {
		Name        string `json:"name"`
		Patch       string `json:"patch"`
		FromVersion uint64 `json:"fromVersion"`
		ToVersion   uint64 `json:"toVersion"`
		Expect      struct {
			Index    []string `json:"index"`
			Archived bool     `json:"archived"`
		} `json:"expect"`
	} `json:"appState"`
}

func readJSON(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func b64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func loadFixture(t *testing.T, name string) *wahaauth.AuthState {
	t.Helper()
	rows, err := wahaauth.ReadFile(filepath.Join(fixtureDir, name), wahaauth.FormatAuto)
	if err != nil {
		t.Fatal(err)
	}
	st, err := wahaauth.Parse(rows)
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Problems) > 0 {
		t.Fatalf("unreadable rows: %+v", st.Problems)
	}
	return st
}

func openSQLite(t *testing.T) *convert.Target {
	t.Helper()
	path := filepath.Join(t.TempDir(), "whatsmeow.db")
	tg, err := convert.OpenTarget(context.Background(), "sqlite", "sqlite3", "file:"+path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tg.Close() })
	return tg
}

func convertFixture(t *testing.T, tg *convert.Target, opt convert.Options) (*wahaauth.AuthState, *store.Device, *convert.Report) {
	t.Helper()
	ctx := context.Background()
	st := loadFixture(t, "rows.json")
	rep, err := convert.Convert(ctx, st, tg, opt)
	if err != nil {
		t.Fatal(err)
	}
	res, err := verify.Store(ctx, st, tg, opt)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range res.Checks {
		if !c.OK {
			t.Errorf("verify: %s failed (%s)", c.Name, c.Detail)
		}
	}
	jid, _ := types.ParseJID(st.Creds.Me.ID)
	dev, err := tg.Container.GetDevice(ctx, jid)
	if err != nil || dev == nil {
		t.Fatalf("device not loadable: %v", err)
	}
	return st, dev, rep
}

// Every export path must yield the same rows.
func TestExportFormatsAgree(t *testing.T) {
	var canonical []wahaauth.Row
	readJSON(t, "rows.json", &canonical)
	want := map[string]string{}
	for _, r := range canonical {
		want[r.ID] = r.Data
	}
	for _, name := range []string{"auth.csv", "auth.json", "auth.pgdump.sql"} {
		t.Run(name, func(t *testing.T) {
			rows, err := wahaauth.ReadFile(filepath.Join(fixtureDir, name), wahaauth.FormatAuto)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != len(want) {
				t.Fatalf("%d rows, want %d", len(rows), len(want))
			}
			for _, r := range rows {
				if want[r.ID] != r.Data {
					t.Fatalf("row %s differs from rows.json", r.ID)
				}
			}
		})
	}
}

func TestConvertMatchesBaileys(t *testing.T) {
	var exp expectFile
	readJSON(t, "expect.json", &exp)
	st, dev, rep := convertFixture(t, openSQLite(t), convert.Options{})
	_ = st

	if dev.ID.String() != exp.JID || dev.LID.String() != exp.LID {
		t.Errorf("jid %s lid %s", dev.ID, dev.LID)
	}
	if dev.RegistrationID != exp.RegistrationID || dev.Platform != exp.Platform || dev.PushName != exp.PushName {
		t.Errorf("registration id %d platform %q push name %q", dev.RegistrationID, dev.Platform, dev.PushName)
	}
	if !bytes.Equal(dev.NoiseKey.Pub[:], b64(t, exp.NoisePub)) || !bytes.Equal(dev.IdentityKey.Pub[:], b64(t, exp.IdentityPub)) {
		t.Error("noise or identity public key differs")
	}
	if dev.SignedPreKey.KeyID != exp.SignedPreKey.ID || !bytes.Equal(dev.SignedPreKey.Pub[:], b64(t, exp.SignedPreKey.Pub)) ||
		!bytes.Equal(dev.SignedPreKey.Signature[:], b64(t, exp.SignedPreKey.Sig)) {
		t.Error("signed pre-key differs")
	}
	if !bytes.Equal(dev.Account.AccountSignatureKey, b64(t, exp.AccountSignatureKey)) {
		t.Error("account signature key differs")
	}
	ctx := context.Background()
	for id, pub := range exp.PreKeys {
		var n uint32
		for _, c := range id {
			n = n*10 + uint32(c-'0')
		}
		pk, err := dev.PreKeys.GetPreKey(ctx, n)
		if err != nil || pk == nil || !bytes.Equal(pk.Pub[:], b64(t, pub)) {
			t.Errorf("pre-key %s", id)
		}
	}
	// whatsmeow must continue numbering where Baileys stopped.
	next, err := dev.PreKeys.GenOnePreKey(ctx)
	if err != nil || next.KeyID != exp.NextPreKeyID {
		t.Errorf("next generated pre-key id %v, want %d (%v)", next, exp.NextPreKeyID, err)
	}
	for name, v := range exp.AppStateVersions {
		ver, _, err := dev.AppState.GetAppStateVersion(ctx, name)
		if err != nil || ver != v {
			t.Errorf("app state %s version %d, want %d", name, ver, v)
		}
	}
	latest, _ := dev.AppStateKeys.GetLatestAppStateSyncKeyID(ctx)
	if !bytes.Equal(latest, b64(t, exp.AppStateKeyID)) {
		t.Error("latest app state key id")
	}
	for _, addr := range exp.Sessions {
		m, _ := convert.SignalAddress(addr)
		if has, _ := dev.Sessions.HasSession(ctx, m); !has {
			t.Errorf("session %s missing", addr)
		}
	}
	for pn, lid := range exp.LIDMappings {
		got, _ := dev.LIDs.GetLIDForPN(ctx, types.JID{User: pn, Server: types.DefaultUserServer})
		if got.User != lid {
			t.Errorf("lid for %s = %q", pn, got.User)
		}
	}
	if c := rep.Categories["session"]; c.Converted != len(exp.Sessions) {
		t.Errorf("sessions converted %d", c.Converted)
	}
	for addr, reason := range exp.DroppedSessions {
		m, _ := convert.SignalAddress(addr)
		if has, _ := dev.Sessions.HasSession(ctx, m); has {
			t.Errorf("stale session %s was converted", addr)
		}
		if rep.Categories["session"].Reasons[reason] == 0 {
			t.Errorf("no session dropped for %q", reason)
		}
	}
	for name, n := range exp.SenderKeyStates {
		group, sender, _ := convert.SenderKeyName(name)
		raw, err := dev.SenderKeys.GetSenderKey(ctx, group, sender)
		if err != nil || raw == nil {
			t.Fatalf("sender key %s: %v", name, err)
		}
		rec, err := groupRecord.NewSenderKeyFromBytes(raw, pb.SenderKeyRecord, pb.SenderKeyState)
		if err != nil || len(rec.Structure().SenderKeyStates) != n {
			t.Errorf("sender key %s: %d states, want %d (%v)", name, len(rec.Structure().SenderKeyStates), n, err)
		}
	}
	if c := rep.Categories["sender-key"]; c.Converted != len(exp.SenderKeys) {
		t.Errorf("sender keys converted %d", c.Converted)
	}
}

func signalAddr(t *testing.T, baileys string) *protocol.SignalAddress {
	t.Helper()
	m, err := convert.SignalAddress(baileys)
	if err != nil {
		t.Fatal(err)
	}
	i := strings.LastIndexByte(m, ':')
	var d uint32
	for _, c := range m[i+1:] {
		d = d*10 + uint32(c-'0')
	}
	return protocol.NewSignalAddress(m[:i], d)
}

var pb = store.SignalProtobufSerializer

// decryptDM mirrors whatsmeow's Client.decryptDM (message.go) minus the event buffer.
func decryptDM(ctx context.Context, dev *store.Device, addr *protocol.SignalAddress, typ string, ct []byte) ([]byte, error) {
	builder := session.NewBuilderFromSignal(dev, addr, pb)
	cipher := session.NewCipher(builder, addr)
	if typ == "pkmsg" {
		msg, err := protocol.NewPreKeySignalMessageFromBytes(ct, pb.PreKeySignalMessage, pb.SignalMessage)
		if err != nil {
			return nil, err
		}
		return cipher.DecryptMessage(ctx, msg)
	}
	msg, err := protocol.NewSignalMessageFromBytes(ct, pb.SignalMessage)
	if err != nil {
		return nil, err
	}
	return cipher.Decrypt(ctx, msg)
}

// decryptGroup mirrors whatsmeow's Client.decryptGroupMsg.
func decryptGroup(ctx context.Context, dev *store.Device, group string, addr *protocol.SignalAddress, ct []byte) ([]byte, error) {
	name := protocol.NewSenderKeyName(group, addr)
	builder := groups.NewGroupSessionBuilder(dev, pb)
	cipher := groups.NewGroupCipher(builder, name, dev)
	msg, err := protocol.NewSenderKeyMessageFromBytes(ct, pb.SenderKeyMessage)
	if err != nil {
		return nil, err
	}
	return cipher.Decrypt(ctx, msg)
}

func decryptAfterSnapshot(t *testing.T, dev *store.Device) {
	t.Helper()
	var after afterFile
	readJSON(t, "after.json", &after)
	ctx := context.Background()
	for _, m := range after.DMs {
		if m.PNAddr != "" {
			// whatsmeow moves PN-addressed state to the LID address the first time it sees the
			// contact (message.go migrateSessionStore → MigratePNToLID, ON CONFLICT DO UPDATE).
			pn := signalAddr(t, m.PNAddr)
			lid := signalAddr(t, m.Addr)
			pnJID := types.JID{User: pn.Name(), Server: types.DefaultUserServer}
			lidJID := types.JID{User: strings.TrimSuffix(lid.Name(), "_1"), Server: types.HiddenUserServer}
			if err := dev.Sessions.MigratePNToLID(ctx, pnJID, lidJID); err != nil {
				t.Fatalf("MigratePNToLID: %v", err)
			}
		}
		pt, err := decryptDM(ctx, dev, signalAddr(t, m.Addr), m.Type, b64(t, m.Ciphertext))
		if err != nil {
			t.Errorf("%s %s: %v", m.From, m.Type, err)
			continue
		}
		if !bytes.Equal(pt, b64(t, m.Plaintext)) {
			t.Errorf("%s: plaintext %q", m.From, pt)
		}
	}
	for _, g := range after.Groups {
		pt, err := decryptGroup(ctx, dev, g.Group, signalAddr(t, g.Addr), b64(t, g.Ciphertext))
		if err != nil {
			t.Errorf("group from %s: %v", g.From, err)
			continue
		}
		if !bytes.Equal(pt, b64(t, g.Plaintext)) {
			t.Errorf("group from %s: plaintext %q", g.From, pt)
		}
	}
}

// Messages peers send after WAHA stopped must decrypt in whatsmeow: a delayed message
// (stored message key), a message on the current chain, a session with a closed previous
// state, our own phone, a brand-new contact using one of our uploaded pre-keys, and
// group messages including one whose sender message key was stored.
func TestPeersMessagesAfterSnapshotDecrypt(t *testing.T) {
	_, dev, _ := convertFixture(t, openSQLite(t), convert.Options{})
	decryptAfterSnapshot(t, dev)
}

// The next app-state patch from the server applies on top of the imported LTHash state,
// with MAC validation on. It overwrites an index we hold, so the old value MAC is needed.
func TestAppStatePatchAppliesOnImportedState(t *testing.T) {
	_, dev, _ := convertFixture(t, openSQLite(t), convert.Options{})
	var after afterFile
	readJSON(t, "after.json", &after)
	ctx := context.Background()
	for _, a := range after.AppState {
		var patch waServerSync.SyncdPatch
		if err := proto.Unmarshal(b64(t, a.Patch), &patch); err != nil {
			t.Fatal(err)
		}
		ver, hash, err := dev.AppState.GetAppStateVersion(ctx, a.Name)
		if err != nil || ver != a.FromVersion {
			t.Fatalf("version %d, want %d (%v)", ver, a.FromVersion, err)
		}
		proc := appstate.NewProcessor(dev, nil)
		muts, state, err := proc.DecodePatches(ctx, &appstate.PatchList{Name: appstate.WAPatchName(a.Name), Patches: []*waServerSync.SyncdPatch{&patch}},
			appstate.HashState{Version: ver, Hash: hash}, true)
		if err != nil {
			t.Fatalf("whatsmeow rejected the next patch: %v", err)
		}
		if state.Version != a.ToVersion || len(muts) != 1 {
			t.Fatalf("state v%d, %d mutations", state.Version, len(muts))
		}
		got := muts[0]
		if strings.Join(got.Index, ",") != strings.Join(a.Expect.Index, ",") || got.Action.GetArchiveChatAction().GetArchived() != a.Expect.Archived {
			t.Fatalf("mutation %v archived=%v", got.Index, got.Action.GetArchiveChatAction().GetArchived())
		}
	}
}

type reverseReq struct {
	DMs    []reverseDM    `json:"dms"`
	Groups []reverseGroup `json:"groups"`
}
type reverseDM struct {
	To         string `json:"to"`
	Type       string `json:"type"`
	Ciphertext string `json:"ciphertext"`
}
type reverseGroup struct {
	To         string `json:"to"`
	Ciphertext string `json:"ciphertext"`
}
type reverseRes struct {
	DMs []struct {
		To        string `json:"to"`
		Plaintext string `json:"plaintext"`
		Error     string `json:"error"`
		Reply     *struct {
			Type       string `json:"type"`
			Ciphertext string `json:"ciphertext"`
			Plaintext  string `json:"plaintext"`
		} `json:"reply"`
	} `json:"dms"`
	Groups []struct {
		To        string `json:"to"`
		Plaintext string `json:"plaintext"`
		Error     string `json:"error"`
	} `json:"groups"`
}

// The other direction: whatsmeow encrypts with converted sessions and our converted own
// sender key, Baileys (libsignal-node) decrypts, peers reply, whatsmeow decrypts the replies.
// Needs Node and fixturegen/node_modules (npm ci in fixturegen); skipped otherwise.
func TestRoundTripWithBaileys(t *testing.T) {
	node, err := exec.LookPath("node")
	gen, _ := filepath.Abs("../../fixturegen")
	if err != nil {
		t.Skip("node not installed")
	}
	if _, err := os.Stat(filepath.Join(gen, "node_modules", "baileys")); err != nil {
		t.Skip("fixturegen/node_modules missing (run npm ci in migrate/fixturegen)")
	}
	_, dev, _ := convertFixture(t, openSQLite(t), convert.Options{})
	decryptAfterSnapshot(t, dev) // the gateway would have processed these first
	ctx := context.Background()

	// How whatsmeow addresses each peer (the converted session addresses).
	peers := map[string]string{
		"alice": "100000000000101_1.0", // PN contact whose session Baileys keyed by LID
		"bob":   "100000000000102_1.0", // we initiated; still a pending pre-key session
		"carol": "15555550103.2",       // record with a closed previous state
		"phone": "15555550123.0",       // our own primary device
		"dave":  "15555550104.0",       // session created in whatsmeow from his pkmsg
		"erin":  "15555550105.0",       // long conversation: receiving chains trimmed to 5
		"frank": "100000000000106_1.0", // PN session Baileys migrated to his LID; stale PN row dropped
	}
	var req reverseReq
	wantType := map[string]string{"bob": "pkmsg"}
	names := make([]string, 0, len(peers))
	for n := range peers {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		addr := signalAddr(t, peers[name])
		cipher := session.NewCipher(session.NewBuilderFromSignal(dev, addr, pb), addr)
		msg, err := cipher.Encrypt(ctx, []byte("from whatsmeow to "+name))
		if err != nil {
			t.Fatalf("encrypt to %s: %v", name, err)
		}
		typ := "msg"
		if msg.Type() == protocol.PREKEY_TYPE {
			typ = "pkmsg"
		}
		if w := wantType[name]; w != "" && typ != w {
			t.Errorf("to %s: %s, want %s (pending pre-key lost?)", name, typ, w)
		}
		req.DMs = append(req.DMs, reverseDM{To: name, Type: typ, Ciphertext: base64.StdEncoding.EncodeToString(msg.Serialize())})
	}
	// A group message with our converted own sender key (whatsmeow uses our LID address).
	own := dev.GetLID()
	gname := protocol.NewSenderKeyName("120363000000000001@g.us", own.SignalAddress())
	gcipher := groups.NewGroupCipher(groups.NewGroupSessionBuilder(dev, pb), gname, dev)
	gmsg, err := gcipher.Encrypt(ctx, []byte("group from whatsmeow"))
	if err != nil {
		t.Fatalf("group encrypt: %v", err)
	}
	req.Groups = append(req.Groups, reverseGroup{To: "alice", Ciphertext: base64.StdEncoding.EncodeToString(gmsg.SignedSerialize())})

	reqPath := filepath.Join(t.TempDir(), "req.json")
	b, _ := json.Marshal(req)
	if err := os.WriteFile(reqPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	fixture, _ := filepath.Abs(fixtureDir)
	cmd := exec.Command(node, filepath.Join(gen, "reverse.mjs"), fixture, reqPath)
	cmd.Dir = gen
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			t.Fatalf("reverse.mjs: %v\n%s", err, ee.Stderr)
		}
		t.Fatal(err)
	}
	var res reverseRes
	if err := json.Unmarshal(out, &res); err != nil {
		t.Fatalf("reverse.mjs output: %v\n%s", err, out)
	}
	for _, d := range res.DMs {
		if d.Error != "" {
			t.Errorf("Baileys could not decrypt whatsmeow's message to %s: %s", d.To, d.Error)
			continue
		}
		if string(b64(t, d.Plaintext)) != "from whatsmeow to "+d.To {
			t.Errorf("%s decrypted %q", d.To, b64(t, d.Plaintext))
		}
		pt, err := decryptDM(ctx, dev, signalAddr(t, peers[d.To]), d.Reply.Type, b64(t, d.Reply.Ciphertext))
		if err != nil {
			t.Errorf("reply from %s (%s): %v", d.To, d.Reply.Type, err)
			continue
		}
		if !bytes.Equal(pt, b64(t, d.Reply.Plaintext)) {
			t.Errorf("reply from %s: %q", d.To, pt)
		}
	}
	for _, g := range res.Groups {
		if g.Error != "" {
			t.Errorf("Baileys could not decrypt whatsmeow's group message: %s", g.Error)
		} else if string(b64(t, g.Plaintext)) != "group from whatsmeow" {
			t.Errorf("group decrypted %q", b64(t, g.Plaintext))
		}
	}
	if len(res.DMs) != len(peers) || len(res.Groups) != 1 {
		t.Fatalf("reverse returned %d dms, %d groups", len(res.DMs), len(res.Groups))
	}
}

func TestRefusesExistingDeviceUnlessReplace(t *testing.T) {
	tg := openSQLite(t)
	convertFixture(t, tg, convert.Options{})
	st := loadFixture(t, "rows.json")
	if _, err := convert.Convert(context.Background(), st, tg, convert.Options{}); !errors.Is(err, convert.ErrDeviceExists) {
		t.Fatalf("second convert: %v, want ErrDeviceExists", err)
	}
	if _, err := convert.Convert(context.Background(), st, tg, convert.Options{Replace: true}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	res, err := verify.Store(context.Background(), st, tg, convert.Options{})
	if err != nil || !res.OK() {
		t.Fatalf("verify after replace: %v %+v", err, res.Failed())
	}
}

func TestOptionsDropWhatTheySay(t *testing.T) {
	opt := convert.Options{SkipSessions: true, SkipSenderKeys: true, AppStateKeysOnly: true, PushName: "Override"}
	_, dev, rep := convertFixture(t, openSQLite(t), opt)
	ctx := context.Background()
	if c := rep.Categories["session"]; c.Converted != 0 || c.Dropped != c.Found {
		t.Errorf("sessions %+v", c)
	}
	if c := rep.Categories["sender-key"]; c.Converted != 0 {
		t.Errorf("sender keys %+v", c)
	}
	if v, _, _ := dev.AppState.GetAppStateVersion(ctx, "regular_low"); v != 0 {
		t.Errorf("app state version %d with keys-only", v)
	}
	if dev.PushName != "Override" {
		t.Errorf("push name %q", dev.PushName)
	}
	// Without sessions a peer's pkmsg still works (new session), which is how WhatsApp
	// recovers after a retry receipt.
	var after afterFile
	readJSON(t, "after.json", &after)
	for _, m := range after.DMs {
		if m.From != "dave" {
			continue
		}
		if _, err := decryptDM(ctx, dev, signalAddr(t, m.Addr), m.Type, b64(t, m.Ciphertext)); err != nil {
			t.Errorf("new-contact pkmsg without imported sessions: %v", err)
		}
	}
}

// With WAHA2MEOW_TEST_POSTGRES=postgres://… the same conversion runs against Postgres
// (whatsmeow's production backend in the gateway plan).
func TestPostgresTarget(t *testing.T) {
	dsn := os.Getenv("WAHA2MEOW_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("WAHA2MEOW_TEST_POSTGRES not set")
	}
	ctx := context.Background()
	tg, err := convert.OpenTarget(ctx, "pgx", "postgres", dsn, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tg.Close()
	_, dev, _ := convertFixture(t, tg, convert.Options{Replace: true})
	decryptAfterSnapshot(t, dev)
}

// Optional extras from WAHA's message store: contact names and the full LID map.
func TestStoreContactsAndLIDMap(t *testing.T) {
	var exp struct {
		StoreLidMappings map[string]string `json:"storeLidMappings"`
		LidMappings      map[string]string `json:"lidMappings"`
		StoreContacts    map[string]struct {
			Full, Push, Business string
		} `json:"storeContacts"`
	}
	readJSON(t, "expect.json", &exp)
	st := loadFixture(t, "rows.json")
	crows, err := wahaauth.ReadFile(filepath.Join(fixtureDir, "contacts.csv"), wahaauth.FormatAuto)
	if err != nil {
		t.Fatal(err)
	}
	var problems []wahaauth.Problem
	st.StoreContacts, problems = wahaauth.ParseContacts(crows)
	lrows, err := wahaauth.ReadFile(filepath.Join(fixtureDir, "lid_map.csv"), wahaauth.FormatAuto)
	if err != nil {
		t.Fatal(err)
	}
	var p2 []wahaauth.Problem
	st.StoreLIDForPN, p2 = wahaauth.ParseLIDMap(lrows)
	if len(problems)+len(p2) > 0 {
		t.Fatalf("problems %v %v", problems, p2)
	}
	ctx := context.Background()
	tg := openSQLite(t)
	rep, err := convert.Convert(ctx, st, tg, convert.Options{})
	if err != nil {
		t.Fatal(err)
	}
	res, err := verify.Store(ctx, st, tg, convert.Options{})
	if err != nil || !res.OK() {
		t.Fatalf("verify: %v %+v", err, res.Failed())
	}
	if c := rep.Categories["contact (store)"]; c.Converted != 4 || c.Reasons["not a user JID"] != 1 {
		t.Errorf("contacts %+v", c)
	}
	jid, _ := types.ParseJID(st.Creds.Me.ID)
	dev, _ := tg.Container.GetDevice(ctx, jid)
	for raw, want := range exp.StoreContacts {
		j, _ := types.ParseJID(raw)
		got, err := dev.Contacts.GetContact(ctx, j)
		if err != nil || got.FullName != want.Full || got.PushName != want.Push || got.BusinessName != want.Business {
			t.Errorf("contact %s: %+v (%v)", raw, got, err)
		}
	}
	for pn, lid := range exp.StoreLidMappings {
		got, _ := dev.LIDs.GetLIDForPN(ctx, types.JID{User: pn, Server: types.DefaultUserServer})
		if got.User != lid {
			t.Errorf("store lid for %s = %q", pn, got.User)
		}
	}
	for pn, lid := range exp.LidMappings { // auth rows still win
		got, _ := dev.LIDs.GetLIDForPN(ctx, types.JID{User: pn, Server: types.DefaultUserServer})
		if got.User != lid {
			t.Errorf("auth lid for %s = %q", pn, got.User)
		}
	}
}
