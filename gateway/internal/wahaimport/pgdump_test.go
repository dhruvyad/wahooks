package wahaimport

import (
	"encoding/csv"
	"os"
	"testing"
)

// The archives are real pg_dump 17 output (fixturegen/export-history.sh): default gzip and -Z0.
func TestReadDumpMatchesCSV(t *testing.T) {
	f, err := os.Open("testdata/messages.csv")
	if err != nil {
		t.Fatal(err)
	}
	recs, err := csv.NewReader(f).ReadAll()
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	for _, r := range recs[1:] {
		want[r[1]] = r[3]
	}
	for _, name := range []string{"testdata/waha-session.dump", "testdata/waha-session-z0.dump"} {
		tabs, err := ReadDump(name, "messages", "chats", "auth")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		m := tabs["messages"]
		if len(m.Rows) != len(want) || len(tabs["chats"].Rows) != 3 || len(tabs["auth"].Rows) == 0 {
			t.Fatalf("%s: %d messages, %d chats, %d auth rows", name, len(m.Rows), len(tabs["chats"].Rows), len(tabs["auth"].Rows))
		}
		for i := range m.Rows {
			if want[m.Col(i, "id")] != m.Col(i, "data") {
				t.Fatalf("%s: row %s differs from the CSV export", name, m.Col(i, "id"))
			}
		}
		if m.Columns[2] != "messageTimestamp" {
			t.Fatalf("columns %v", m.Columns)
		}
	}
	if _, err := ReadDump("testdata/messages.csv", "messages"); err == nil {
		t.Fatal("a CSV file was accepted as an archive")
	}
}
