package convert

// Synthetic Baileys creds built in Go, independently of the Node fixture: real curve25519
// keys, an ADV identity signed by a made-up primary device, serialised the way WAHA does.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"go.mau.fi/libsignal/ecc"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	"google.golang.org/protobuf/proto"

	_ "modernc.org/sqlite"

	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

func buf(b []byte) map[string]any {
	return map[string]any{"type": "Buffer", "data": base64.StdEncoding.EncodeToString(b)}
}

func kp(k *keys.KeyPair) map[string]any {
	return map[string]any{"private": buf(k.Priv[:]), "public": buf(k.Pub[:])}
}

type synth struct {
	noise, identity, account *keys.KeyPair
	spk                      *keys.PreKey
	adv                      []byte
	details                  []byte
	accSig, devSig           []byte
	me                       map[string]any
}

func newSynth() *synth {
	s := &synth{noise: keys.NewKeyPair(), identity: keys.NewKeyPair(), account: keys.NewKeyPair()}
	s.spk = s.identity.CreateSignedPreKey(1)
	s.adv = make([]byte, 32)
	copy(s.adv, "synthetic-adv-secret-key-32bytes")
	s.details, _ = proto.Marshal(&waAdv.ADVDeviceIdentity{RawID: proto.Uint32(9), Timestamp: proto.Uint64(1731000000), KeyIndex: proto.Uint32(3)})
	sig := ecc.CalculateSignature(ecc.NewDjbECPrivateKey(*s.account.Priv), concat(advAccountSigPrefix, s.details, s.identity.Pub[:]))
	s.accSig = sig[:]
	dsig := ecc.CalculateSignature(ecc.NewDjbECPrivateKey(*s.identity.Priv), concat(advDeviceSigPrefix, s.details, s.identity.Pub[:], s.account.Pub[:]))
	s.devSig = dsig[:]
	s.me = map[string]any{"id": "15555550188:4@s.whatsapp.net", "lid": "100000000000188:4@lid", "name": "Synth"}
	return s
}

func (s *synth) rows(t *testing.T, mutate func(c map[string]any)) []wahaauth.Row {
	t.Helper()
	c := map[string]any{
		"noiseKey":          kp(s.noise),
		"signedIdentityKey": kp(s.identity),
		"signedPreKey":      map[string]any{"keyPair": kp(&s.spk.KeyPair), "signature": buf(s.spk.Signature[:]), "keyId": s.spk.KeyID},
		"registrationId":    1234,
		"advSecretKey":      base64.StdEncoding.EncodeToString(s.adv),
		"me":                s.me,
		"account": map[string]any{
			"details":             base64.StdEncoding.EncodeToString(s.details),
			"accountSignatureKey": base64.StdEncoding.EncodeToString(s.account.Pub[:]),
			"accountSignature":    base64.StdEncoding.EncodeToString(s.accSig),
			"deviceSignature":     base64.StdEncoding.EncodeToString(s.devSig),
		},
		"platform":                "smba",
		"nextPreKeyId":            31,
		"firstUnuploadedPreKeyId": 31,
	}
	if mutate != nil {
		mutate(c)
	}
	data, _ := json.Marshal(map[string]any{"id": "creds", "data": c})
	rows := []wahaauth.Row{{ID: "creds", Data: string(data)}}
	// A few pre-keys, one past the uploaded range.
	for i := 1; i <= 31; i++ {
		if i == 7 {
			continue // a missing row
		}
		pk := keys.NewKeyPair()
		d, _ := json.Marshal(map[string]any{"id": "x", "data": kp(pk)})
		rows = append(rows, wahaauth.Row{ID: "pre-key-" + itoa(i), Data: strings.Replace(string(d), `"id":"x"`, `"id":"pre-key-`+itoa(i)+`"`, 1)})
	}
	return rows
}

func itoa(i int) string { return strconv.Itoa(i) }

func parseRows(t *testing.T, rows []wahaauth.Row) *wahaauth.AuthState {
	t.Helper()
	st, err := wahaauth.Parse(rows)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestSyntheticCredsConvert(t *testing.T) {
	s := newSynth()
	st := parseRows(t, s.rows(t, nil))
	f, err := DeviceFromCreds(st.Creds)
	if err != nil {
		t.Fatal(err)
	}
	if f.ID.String() != "15555550188:4@s.whatsapp.net" || f.LID.String() != "100000000000188:4@lid" || f.Platform != "smba" {
		t.Fatalf("%s %s %s", f.ID, f.LID, f.Platform)
	}
	path := filepath.Join(t.TempDir(), "s.db")
	tg, err := OpenTarget(context.Background(), "sqlite", "sqlite3", "file:"+path+"?_pragma=foreign_keys(1)", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tg.Close()
	rep, err := Convert(context.Background(), st, tg, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if c := rep.Categories["pre-key"]; c.Converted != 30 {
		t.Fatalf("pre-keys %+v", c)
	}
	dev, err := tg.Container.GetDevice(context.Background(), f.ID)
	if err != nil || dev == nil {
		t.Fatal(err)
	}
	// id 31 is not uploaded yet: whatsmeow must upload it first, then continue at 32.
	ctx := context.Background()
	n, _ := dev.PreKeys.UploadedPreKeyCount(ctx)
	if n != 29 {
		t.Fatalf("uploaded count %d, want 29", n)
	}
	got, err := dev.PreKeys.GetOrGenPreKeys(ctx, 2)
	if err != nil || len(got) != 2 || got[0].KeyID != 31 || got[1].KeyID != 32 {
		t.Fatalf("next pre-keys %v %v", got, err)
	}
}

func TestSyntheticCredsRefused(t *testing.T) {
	s := newSynth()
	other := keys.NewKeyPair()
	cases := map[string]func(c map[string]any){
		"public key does not match": func(c map[string]any) {
			c["noiseKey"].(map[string]any)["public"] = buf(other.Pub[:])
		},
		"accountSignature does not verify": func(c map[string]any) {
			c["account"].(map[string]any)["accountSignatureKey"] = base64.StdEncoding.EncodeToString(other.Pub[:])
		},
		"deviceSignature does not verify": func(c map[string]any) {
			c["account"].(map[string]any)["deviceSignature"] = base64.StdEncoding.EncodeToString(s.accSig)
		},
		"signedPreKey.signature does not verify": func(c map[string]any) {
			c["signedPreKey"].(map[string]any)["signature"] = buf(s.accSig)
		},
		"device 0": func(c map[string]any) {
			c["me"] = map[string]any{"id": "15555550188@s.whatsapp.net"}
		},
		"never linked":            func(c map[string]any) { delete(c, "me") },
		"never completed pairing": func(c map[string]any) { delete(c, "account") },
		"lid device": func(c map[string]any) {
			c["me"] = map[string]any{"id": "15555550188:4@s.whatsapp.net", "lid": "100000000000188:5@lid"}
		},
	}
	for want, mutate := range cases {
		st := parseRows(t, s.rows(t, mutate))
		_, err := DeviceFromCreds(st.Creds)
		if err == nil || !strings.Contains(err.Error(), strings.Split(want, " ")[0]) {
			t.Errorf("%s: got %v", want, err)
		}
	}
}

func TestAddresses(t *testing.T) {
	for in, want := range map[string]string{
		"15555550103.2":       "15555550103:2",
		"100000000000101_1.0": "100000000000101_1:0",
		"123_128.99":          "123_128:99",
	} {
		got, err := SignalAddress(in)
		if err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "123", "abc.0", "123_7.0", "123.x"} {
		if _, err := SignalAddress(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	g, s, err := SenderKeyName("120363000000000001@g.us::100000000000101_1::0")
	if err != nil || g != "120363000000000001@g.us" || s != "100000000000101_1:0" {
		t.Errorf("sender key name: %q %q %v", g, s, err)
	}
	if g, s, err := SenderKeyName("status@broadcast::15555550101::0"); err != nil || g != "status@broadcast" || s != "15555550101:0" {
		t.Errorf("status broadcast: %q %q %v", g, s, err)
	}
	if got := Mask("15555550123:23@s.whatsapp.net"); got != "•••••••0123:23@s.whatsapp.net" {
		t.Errorf("mask %q", got)
	}
}

func TestLIDPairsPreferForwardRows(t *testing.T) {
	st := &wahaauth.AuthState{
		LIDForPN: map[string]string{"111": "901", "222": "902"},
		// stale reverse rows: 901 once belonged to 333; 903 ↔ 444 is only known in reverse
		PNForLID: map[string]string{"901": "333", "902": "222", "903": "444"},
	}
	got := LIDPairs(st)
	want := map[string]string{"111": "901", "222": "902", "444": "903"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for pn, lid := range want {
		if got[pn] != lid {
			t.Fatalf("%v", got)
		}
	}
}

// The four tctoken shapes seen in production: {token}, {token, timestamp},
// {token, senderTimestamp}, {token, senderTimestamp, timestamp}; plus the cleared form.
func TestTCTokenShapes(t *testing.T) {
	s := newSynth()
	rows := s.rows(t, nil)
	tok := base64.StdEncoding.EncodeToString([]byte("tok"))
	for id, v := range map[string]string{
		"tctoken-__index":                    `{"token":{"type":"Buffer","data":"WyJ4Il0="}}`,
		"tctoken-111@lid":                    `{"token":{"type":"Buffer","data":"` + tok + `"}}`,
		"tctoken-222@lid":                    `{"token":{"type":"Buffer","data":"` + tok + `"},"timestamp":"1794184447"}`,
		"tctoken-333@lid":                    `{"token":{"type":"Buffer","data":"` + tok + `"},"senderTimestamp":1794184987}`,
		"tctoken-444@lid":                    `{"token":{"type":"Buffer","data":"` + tok + `"},"senderTimestamp":1794184987,"timestamp":"1794184447"}`,
		"tctoken-15555550555@s.whatsapp.net": `{"token":{"type":"Buffer","data":""},"senderTimestamp":1794184987}`,
	} {
		rows = append(rows, wahaauth.Row{ID: id, Data: `{"id":"` + id + `","data":` + v + `}`})
	}
	st := parseRows(t, rows)
	tg, err := OpenTarget(context.Background(), "sqlite", "sqlite3", "file:"+filepath.Join(t.TempDir(), "t.db")+"?_pragma=foreign_keys(1)", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tg.Close()
	rep, err := Convert(context.Background(), st, tg, Options{})
	if err != nil {
		t.Fatal(err)
	}
	c := rep.Categories["tctoken"]
	if c.Found != 6 || c.Converted != 2 || c.Reasons["no timestamp (expired for Baileys)"] != 2 || c.Reasons["cleared token"] != 1 || c.Reasons["Baileys index row"] != 1 {
		t.Fatalf("%+v", c)
	}
	f, _ := DeviceFromCreds(st.Creds)
	dev, _ := tg.Container.GetDevice(context.Background(), f.ID)
	pt, err := dev.PrivacyTokens.GetPrivacyToken(context.Background(), types.JID{User: "444", Server: types.HiddenUserServer})
	if err != nil || pt == nil || pt.Timestamp.Unix() != 1794184447 || pt.SenderTimestamp.Unix() != 1794184987 {
		t.Fatalf("token 444: %+v %v", pt, err)
	}
}
