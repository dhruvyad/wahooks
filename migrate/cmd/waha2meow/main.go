// Command waha2meow converts one WAHA NOWEB session's auth rows (Baileys) into a whatsmeow
// store, so a whatsmeow client can connect as the same linked device without a new QR scan.
//
// It never talks to WhatsApp and only reads its input file.
//
//	waha2meow inspect -in auth.csv
//	waha2meow convert -in auth.csv -out sqlite:./gateway.db
//	waha2meow convert -in auth.csv -out 'postgres://user:pass@host/db?sslmode=require'
//	waha2meow verify  -in auth.csv -out sqlite:./gateway.db
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"github.com/dhruvyad/wahooks/migrate/internal/convert"
	"github.com/dhruvyad/wahooks/migrate/internal/verify"
	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "inspect":
		err = runInspect(os.Args[2:])
	case "convert":
		err = runConvert(os.Args[2:], false)
	case "verify":
		err = runConvert(os.Args[2:], true)
	case "check":
		err = runCheck(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `waha2meow: move a WAHA NOWEB (Baileys) linked device into a whatsmeow store.

  waha2meow inspect -in <export>                 summarise an export, write nothing
  waha2meow convert -in <export> -out <target>   write the device, then verify it
  waha2meow verify  -in <export> -out <target>   verify a store converted earlier
  waha2meow check   -session <name> [-db URL]    read one session straight from Postgres (read-only),
                                                 convert in memory, print counts and PASS/FAIL only

<export>  the session's auth table: psql CSV (id,data), JSON array, JSONL, or pg_dump plain.
<target>  sqlite:<path> | sqlite://<path> | <path>.db | postgres://… (whatsmeow's schema is created if missing)

Run any command with -h for its flags.
`)
}

func load(in, format string) (*wahaauth.AuthState, error) {
	if in == "" {
		return nil, errors.New("-in is required")
	}
	rows, err := wahaauth.ReadFile(in, wahaauth.Format(format))
	if err != nil {
		return nil, err
	}
	return wahaauth.Parse(rows)
}

func runInspect(args []string) error {
	fs := flag.NewFlagSet("inspect", flag.ExitOnError)
	in := fs.String("in", "", "export file")
	format := fs.String("format", "", "csv | json | jsonl | pgdump (default: from extension/content)")
	showIDs := fs.Bool("show-ids", false, "print JIDs unmasked")
	_ = fs.Parse(args)
	st, err := load(*in, *format)
	if err != nil {
		return err
	}
	mask := convert.Mask
	if *showIDs {
		mask = func(s string) string { return s }
	}
	c := st.Creds
	fmt.Printf("rows: %d\n", st.RowCount)
	if c.Me != nil {
		fmt.Printf("me.id: %s\nme.lid: %s\npush name set: %t\n", mask(c.Me.ID), mask(c.Me.LID), c.Me.Name != "")
	}
	fmt.Printf("platform: %s\nregistration id: %d\nsigned pre-key id: %d\npre-key ids: next %d, first un-uploaded %d\n",
		c.Platform, c.RegistrationID, c.SignedPreKey.KeyID, c.NextPreKeyID, c.FirstUnuploadedPreKeyID)
	counts := map[string]int{
		"pre-key": len(st.PreKeys), "session": len(st.Sessions), "sender-key": len(st.SenderKeys),
		"app-state-sync-key": len(st.AppStateSyncKeys), "app-state-sync-version": len(st.AppStateVersions),
		"lid-mapping (pairs)": len(st.LIDForPN), "identity-key": len(st.IdentityKeys), "tctoken": len(st.TCTokens),
		"device-list": len(st.DeviceLists), "sender-key-memory": len(st.SenderKeyMemory),
	}
	for k, v := range st.Unknown {
		counts["unknown:"+k] = v
	}
	for _, k := range sortedKeys(counts) {
		fmt.Printf("  %-24s %d\n", k, counts[k])
	}
	for _, p := range st.Problems {
		fmt.Printf("unreadable row %s: %v\n", mask(p.ID), p.Err)
	}
	if _, err := convert.DeviceFromCreds(c); err != nil {
		return fmt.Errorf("creds will not convert: %w", err)
	}
	fmt.Println("creds: valid (keys match, signatures verify)")
	return nil
}

func runConvert(args []string, verifyOnly bool) error {
	name := "convert"
	if verifyOnly {
		name = "verify"
	}
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	in := fs.String("in", "", "export file")
	format := fs.String("format", "", "csv | json | jsonl | pgdump (default: from extension/content)")
	out := fs.String("out", "", "target: sqlite:<path>, <path>.db, postgres://… or env:<VAR> (read the target from a variable)")
	var opt convert.Options
	fs.BoolVar(&opt.Replace, "replace", false, "overwrite a device with the same JID already in the target")
	fs.BoolVar(&opt.SkipSessions, "skip-sessions", false, "do not convert Signal sessions or identities")
	fs.BoolVar(&opt.SkipSenderKeys, "skip-sender-keys", false, "do not convert group sender keys")
	fs.BoolVar(&opt.AppStateKeysOnly, "app-state-keys-only", false, "import app-state keys but not versions (forces a full app-state resync)")
	fs.BoolVar(&opt.SkipMainDeviceSession, "skip-main-device-session", false, "drop the session with our own phone (WAHA never reads it back)")
	fs.StringVar(&opt.PushName, "push-name", "", "push name to store (default: creds.me.name)")
	fs.StringVar(&opt.BusinessName, "business-name", "", "business name to store")
	fs.BoolVar(&opt.ShowIDs, "show-ids", false, "print JIDs unmasked")
	reportPath := fs.String("report", "", "also write the report as JSON to this file")
	contactsIn := fs.String("contacts", "", "optional: export of the session's contacts table (id,data) to fill whatsmeow's contact names")
	lidMapIn := fs.String("lid-map", "", "optional: export of the session's lid_map table (id,data) to complete whatsmeow's LID map")
	_ = fs.Parse(args)

	st, err := load(*in, *format)
	if err != nil {
		return err
	}
	if *contactsIn != "" {
		rows, err := wahaauth.ReadFile(*contactsIn, wahaauth.Format(*format))
		if err != nil {
			return fmt.Errorf("-contacts: %w", err)
		}
		var problems []wahaauth.Problem
		st.StoreContacts, problems = wahaauth.ParseContacts(rows)
		st.Problems = append(st.Problems, problems...)
		if st.StoreContacts == nil {
			st.StoreContacts = []wahaauth.StoreContact{}
		}
	}
	if *lidMapIn != "" {
		rows, err := wahaauth.ReadFile(*lidMapIn, wahaauth.Format(*format))
		if err != nil {
			return fmt.Errorf("-lid-map: %w", err)
		}
		var problems []wahaauth.Problem
		st.StoreLIDForPN, problems = wahaauth.ParseLIDMap(rows)
		st.Problems = append(st.Problems, problems...)
	}
	driver, dialect, dsn, err := target(*out)
	if err != nil {
		return err
	}
	ctx := context.Background()
	t, err := convert.OpenTarget(ctx, driver, dialect, dsn, nil)
	if err != nil {
		return err
	}
	defer t.Close()

	var rep *convert.Report
	if !verifyOnly {
		rep, err = convert.Convert(ctx, st, t, opt)
		if err != nil {
			return err
		}
		printReport(rep)
	}
	res, err := verify.Store(ctx, st, t, opt)
	if err != nil {
		return err
	}
	fmt.Println("\nverification (store reloaded through whatsmeow):")
	for _, c := range res.Checks {
		mark := "ok  "
		switch {
		case !c.OK && c.Warn:
			mark = "warn"
		case !c.OK:
			mark = "FAIL"
		}
		detail := ""
		if c.Detail != "" {
			detail = " (" + c.Detail + ")"
		}
		fmt.Printf("  %s %s%s\n", mark, c.Name, detail)
	}
	if *reportPath != "" {
		b, _ := json.MarshalIndent(map[string]any{"conversion": rep, "verification": res}, "", "  ")
		if err := os.WriteFile(*reportPath, append(b, '\n'), 0o600); err != nil {
			return err
		}
	}
	if !res.OK() {
		return fmt.Errorf("%d verification checks failed", len(res.Failed()))
	}
	fmt.Println("\nall checks passed")
	return nil
}

func printReport(r *convert.Report) {
	fmt.Printf("device %s (lid %s), platform %q, registration id %d, signed pre-key %d, push name set: %t\n",
		r.JID, r.LID, r.Platform, r.RegistrationID, r.SignedPreKeyID, r.PushNameSet)
	fmt.Printf("%-30s %6s %9s %7s  %s\n", "category", "found", "converted", "dropped", "why dropped")
	for _, k := range sortedKeys(r.Categories) {
		c := r.Categories[k]
		var why []string
		for _, reason := range sortedKeys(c.Reasons) {
			why = append(why, fmt.Sprintf("%s ×%d", reason, c.Reasons[reason]))
		}
		fmt.Printf("%-30s %6d %9d %7d  %s\n", k, c.Found, c.Converted, c.Dropped, strings.Join(why, "; "))
	}
	for _, w := range r.Warnings {
		fmt.Println("warning:", w)
	}
}

func target(out string) (driver, dialect, dsn string, err error) {
	// env:<NAME> reads the target from an environment variable (e.g. env:WAGW_DB), so a database password
	// never appears in the process list.
	if name, ok := strings.CutPrefix(out, "env:"); ok {
		if out = os.Getenv(name); out == "" {
			return "", "", "", fmt.Errorf("-out env:%s: the variable is empty", name)
		}
	}
	switch {
	case out == "":
		return "", "", "", errors.New("-out is required")
	case strings.HasPrefix(out, "postgres://"), strings.HasPrefix(out, "postgresql://"):
		return "pgx", "postgres", out, nil
	case strings.HasPrefix(out, "sqlite:"), strings.HasPrefix(out, "file:"):
		// sqlite:<path>, sqlite://<path> (the gateway's WAGW_DB form) or file:<path>
		out = strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(out, "sqlite:"), "file:"), "//")
		if i := strings.IndexByte(out, '?'); i >= 0 {
			out = out[:i]
		}
		fallthrough
	case strings.HasSuffix(out, ".db"), strings.HasSuffix(out, ".sqlite"):
		abs, err := filepath.Abs(out)
		if err != nil {
			return "", "", "", err
		}
		return "sqlite", "sqlite3", "file:" + abs + "?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)", nil
	}
	return "", "", "", fmt.Errorf("unrecognised -out %q: use sqlite:<path> or postgres://…", out)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
