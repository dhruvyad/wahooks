package wahaauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestBytesShapes(t *testing.T) {
	want := []byte{1, 2, 250}
	for _, in := range []string{
		`{"type":"Buffer","data":"AQL6"}`,
		`{"type":"Buffer","data":[1,2,250]}`,
		`{"0":1,"1":2,"2":250}`,
		`"AQL6"`,
		`[1,2,250]`,
	} {
		var b Bytes
		if err := json.Unmarshal([]byte(in), &b); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if string(b) != string(want) {
			t.Fatalf("%s: got %v", in, []byte(b))
		}
	}
	var b Bytes
	if err := json.Unmarshal([]byte(`null`), &b); err != nil || b != nil {
		t.Fatalf("null: %v %v", b, err)
	}
	if err := json.Unmarshal([]byte(`{"0":1,"2":3}`), &b); err == nil {
		t.Fatal("sparse index object accepted")
	}
	if err := json.Unmarshal([]byte(`[1,256]`), &b); err == nil {
		t.Fatal("out of range byte accepted")
	}
}

func TestInt64Shapes(t *testing.T) {
	for in, want := range map[string]int64{`"1794098647665"`: 1794098647665, `1731000000`: 1731000000, `{"low":5,"high":1,"unsigned":false}`: 1<<32 | 5, `null`: 0, `""`: 0} {
		var n Int64
		if err := json.Unmarshal([]byte(in), &n); err != nil || int64(n) != want {
			t.Fatalf("%s: %d %v", in, n, err)
		}
	}
}

func TestSplitID(t *testing.T) {
	cases := map[string][2]string{
		"creds":                               {"creds", ""},
		"pre-key-12":                          {"pre-key", "12"},
		"session-123_1.0":                     {"session", "123_1.0"},
		"sender-key-123@g.us::456_1::0":       {"sender-key", "123@g.us::456_1::0"},
		"sender-key-memory-123@g.us":          {"sender-key-memory", "123@g.us"},
		"app-state-sync-key-AAAA/w==":         {"app-state-sync-key", "AAAA/w=="},
		"app-state-sync-version-regular_low":  {"app-state-sync-version", "regular_low"},
		"lid-mapping-15555550101":             {"lid-mapping", "15555550101"},
		"lid-mapping-100000000000101_reverse": {"lid-mapping", "100000000000101_reverse"},
		"identity-key-15555550103.2":          {"identity-key", "15555550103.2"},
		"tctoken-100000000000101@lid":         {"tctoken", "100000000000101@lid"},
		"device-list-15555550101":             {"device-list", "15555550101"},
		"something-new-x":                     {"something", "new-x"},
	}
	for id, want := range cases {
		c, k := SplitID(id)
		if c != want[0] || k != want[1] {
			t.Errorf("%s: %q %q", id, c, k)
		}
	}
}

func TestUnescapeCopy(t *testing.T) {
	for in, want := range map[string]string{
		`plain`:        "plain",
		`a\tb\nc\\d`:   "a\tb\nc\\d",
		`\x41\101\N`:   "AAN",
		`\N`:           "",
		`{"a":"\\\\"}`: `{"a":"\\"}`,
	} {
		got, err := unescapeCopy(in)
		if err != nil || got != want {
			t.Errorf("%q: %q %v", in, got, err)
		}
	}
}

func TestReadersEdgeCases(t *testing.T) {
	dir := t.TempDir()
	// psql CSV with quotes and an embedded newline inside data.
	csv := "id,data\ncreds,\"{\"\"id\"\":\"\"creds\"\",\"\"data\"\":{\"\"x\"\":\"\"a\nb\"\"}}\"\n"
	p := filepath.Join(dir, "a.csv")
	if err := os.WriteFile(p, []byte(csv), 0o600); err != nil {
		t.Fatal(err)
	}
	rows, err := ReadFile(p, FormatAuto)
	if err != nil || len(rows) != 1 || rows[0].ID != "creds" || rows[0].Data != "{\"id\":\"creds\",\"data\":{\"x\":\"a\nb\"}}" {
		t.Fatalf("%+v %v", rows, err)
	}
	// JSONL with data already parsed.
	p = filepath.Join(dir, "b.jsonl")
	if err := os.WriteFile(p, []byte(`{"id":"lid-mapping-1","data":{"id":"lid-mapping-1","data":"2"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rows, err = ReadFile(p, FormatAuto)
	if err != nil || len(rows) != 1 {
		t.Fatal(err)
	}
	v, err := unwrap(rows[0])
	if err != nil || string(v) != `"2"` {
		t.Fatalf("unwrap: %s %v", v, err)
	}
	// A value written without WAHA's envelope.
	v, err = unwrap(Row{ID: "lid-mapping-1", Data: `"2"`})
	if err != nil || string(v) != `"2"` {
		t.Fatalf("bare: %s %v", v, err)
	}
	// Duplicate ids mean two sessions were mixed up.
	if _, err := Parse([]Row{{ID: "creds", Data: "{}"}, {ID: "creds", Data: "{}"}}); err == nil {
		t.Fatal("duplicate ids accepted")
	}
	if _, err := Parse([]Row{{ID: "pre-key-1", Data: `{"id":"pre-key-1","data":{}}`}}); err == nil {
		t.Fatal("missing creds accepted")
	}
}

func TestSessionChainOrderIsKept(t *testing.T) {
	raw := `{"_sessions":{"BQ==":{"registrationId":7,"currentRatchet":{},"indexInfo":{"closed":-1},
		"_chains":{"zzz=":{"chainKey":{"counter":0},"chainType":2,"messageKeys":{}},
		           "aaa=":{"chainKey":{"counter":1,"key":"AA=="},"chainType":2,"messageKeys":{"10":"AA==","2":"AA=="}}}}},"version":"v1"}`
	rec, err := ParseNodeSessionRecord(json.RawMessage(raw))
	if err != nil {
		t.Fatal(err)
	}
	ch := rec.Entries[0].Chains
	if len(ch) != 2 || string(ch[0].RatchetKey) != string(mustB64("zzz=")) {
		t.Fatalf("chain order not preserved")
	}
	if got := ch[1].MessageKeyCounters(); len(got) != 2 || got[0] != 2 || got[1] != 10 {
		t.Fatalf("counters %v", got)
	}
}

func mustB64(s string) []byte {
	b, err := decodeBase64(s)
	if err != nil {
		panic(err)
	}
	return b
}
