package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/dhruvyad/wahooks/migrate/internal/convert"
	"github.com/dhruvyad/wahooks/migrate/internal/verify"
	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

// runCheck reads one session's auth rows straight from Postgres in a read-only transaction,
// converts them into an in-memory store, verifies, and prints only counts and pass/fail.
// It writes nothing anywhere and prints no key material, JIDs or phone numbers.
// Exit 0 only when everything that matters converted.
func runCheck(args []string) error {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	dbURL := fs.String("db", os.Getenv("WAHA_DB_URL"), "Postgres URL of the WAHA server (default $WAHA_DB_URL)")
	dbName := fs.String("dbname", "", "per-session database to read (overrides the URL's database)")
	session := fs.String("session", "", "WAHA session name; the database is waha_noweb_<slug>, cut to 63 bytes")
	storeTables := fs.Bool("store-tables", false, "also read the contacts and lid_map tables (counts only)")
	timeout := fs.Duration("timeout", 2*time.Minute, "overall time limit")
	_ = fs.Parse(args)

	if *dbURL == "" {
		return errors.New("-db (or $WAHA_DB_URL) is required")
	}
	name := *dbName
	if name == "" && *session != "" {
		name = SessionDBName(*session)
	}
	if name == "" {
		return errors.New("-dbname or -session is required")
	}
	dsn, err := withDatabase(*dbURL, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	rows, contacts, lidMap, err := readSession(ctx, dsn, *storeTables)
	if err != nil {
		return fmt.Errorf("read: %s", scrub(err.Error(), *dbURL))
	}
	fmt.Printf("read %d auth rows from the session database (read-only transaction)\n", len(rows))
	st, err := wahaauth.Parse(rows)
	if err != nil {
		fmt.Println("RESULT: FAIL")
		return fmt.Errorf("parse: %s", fieldOnly(err))
	}
	if *storeTables {
		var p1, p2 []wahaauth.Problem
		st.StoreContacts, p1 = wahaauth.ParseContacts(contacts)
		if st.StoreContacts == nil {
			st.StoreContacts = []wahaauth.StoreContact{}
		}
		st.StoreLIDForPN, p2 = wahaauth.ParseLIDMap(lidMap)
		st.Problems = append(append(st.Problems, p1...), p2...)
	}

	var fails []string
	if _, err := convert.DeviceFromCreds(st.Creds); err != nil {
		// Only the field name: a malformed value could otherwise be echoed.
		fmt.Printf("creds: FAIL (%s)\n", fieldOnly(err))
		fmt.Println("RESULT: FAIL")
		return errors.New("creds would not convert")
	}
	t, err := convert.OpenMemoryTarget(ctx)
	if err != nil {
		return err
	}
	defer t.Close()
	rep, err := convert.Convert(ctx, st, t, convert.Options{})
	if err != nil {
		fmt.Println("RESULT: FAIL")
		return fmt.Errorf("convert: %s", fieldOnly(err))
	}
	res, err := verify.Store(ctx, st, t, convert.Options{})
	if err != nil {
		fmt.Println("RESULT: FAIL")
		return fmt.Errorf("verify: %s", fieldOnly(err))
	}

	unreadable := map[string]int{}
	for _, p := range st.Problems {
		unreadable[p.Category]++
	}
	fmt.Printf("\n%-28s %6s %9s %7s  %s\n", "category", "rows", "converted", "skipped", "why skipped")
	for _, k := range sortedKeys(rep.Categories) {
		c := rep.Categories[k]
		var why []string
		for _, reason := range sortedKeys(c.Reasons) {
			mark := ""
			if !convert.ExpectedDrop(k, reason) {
				mark = " [!]"
				fails = append(fails, fmt.Sprintf("%s: %d %s", k, c.Reasons[reason], reason))
			}
			why = append(why, fmt.Sprintf("%s ×%d%s", reason, c.Reasons[reason], mark))
		}
		fmt.Printf("%-28s %6d %9d %7d  %s\n", k, c.Found, c.Converted, c.Dropped, strings.Join(why, "; "))
	}
	for cat, n := range unreadable {
		if cat == "device-list" || cat == "sender-key-memory" {
			continue
		}
		if !strings.HasPrefix(cat, "unknown") {
			fails = append(fails, fmt.Sprintf("%s: %d unreadable rows", cat, n))
		}
	}
	for cat, n := range st.Unknown {
		fails = append(fails, fmt.Sprintf("unknown category %q: %d rows", cat, n))
	}

	fmt.Println("\nchecks (device reloaded through whatsmeow from the in-memory store):")
	for _, c := range res.Checks {
		mark := "ok  "
		switch {
		case !c.OK && c.Warn:
			mark = "warn"
		case !c.OK:
			mark = "FAIL"
			fails = append(fails, "check failed: "+c.Name)
		}
		fmt.Printf("  %s %s\n", mark, c.Name)
	}
	fmt.Printf("\npush name present: %t; platform: %s; LID present: %t\n", rep.PushNameSet, safeWord(rep.Platform), !strings.HasPrefix(rep.LID, "@") && rep.LID != "")
	if len(fails) > 0 {
		fmt.Println("\nRESULT: FAIL")
		for _, f := range fails {
			fmt.Println("  -", f)
		}
		return errors.New("not everything that matters converted")
	}
	fmt.Println("\nRESULT: PASS (everything that matters converted; nothing was written)")
	return nil
}

// SessionDBName is WAHA's PsqlStore.getSessionDbName for NOWEB, cut to Postgres' 63-byte
// identifier limit (CREATE DATABASE truncated longer names).
func SessionDBName(session string) string {
	slug := regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(strings.ToLower(session), "_")
	name := "waha_noweb_" + slug
	if len(name) > 63 {
		name = name[:63]
	}
	return name
}

func withDatabase(raw, db string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("-db must be a postgres:// URL")
	}
	u.Path = "/" + db
	u.RawPath = ""
	return u.String(), nil
}

func readSession(ctx context.Context, dsn string, storeTables bool) (auth, contacts, lidMap []wahaauth.Row, err error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, nil, nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, nil, nil, err
	}
	defer tx.Rollback() //nolint:errcheck // read-only
	read := func(q string) ([]wahaauth.Row, error) {
		rs, err := tx.QueryContext(ctx, q)
		if err != nil {
			return nil, err
		}
		defer rs.Close()
		var out []wahaauth.Row
		for rs.Next() {
			var r wahaauth.Row
			var data sql.NullString
			if err := rs.Scan(&r.ID, &data); err != nil {
				return nil, err
			}
			r.Data = data.String
			out = append(out, r)
		}
		return out, rs.Err()
	}
	if auth, err = read(`SELECT id, data FROM auth ORDER BY id`); err != nil {
		return nil, nil, nil, err
	}
	if storeTables {
		if contacts, err = read(`SELECT id, data FROM contacts ORDER BY id`); err != nil {
			return nil, nil, nil, err
		}
		if lidMap, err = read(`SELECT id, data FROM lid_map ORDER BY id`); err != nil {
			return nil, nil, nil, err
		}
	}
	return auth, contacts, lidMap, nil
}

// scrub removes the connection URL (and its password) from driver errors.
func scrub(msg, dbURL string) string {
	if u, err := url.Parse(dbURL); err == nil {
		if p, ok := u.User.Password(); ok && p != "" {
			msg = strings.ReplaceAll(msg, p, "***")
		}
		msg = strings.ReplaceAll(msg, u.Host, "<db host>")
	}
	return msg
}

func safeWord(s string) string {
	if regexp.MustCompile(`^[a-z0-9_]{0,16}$`).MatchString(s) {
		return s
	}
	return "?"
}

// fieldOnly keeps an error's text up to its first ':' (the field or step), dropping values.
func fieldOnly(err error) string {
	msg := err.Error()
	if i := strings.IndexByte(msg, ':'); i > 0 {
		return msg[:i]
	}
	if len(msg) > 80 {
		return msg[:80]
	}
	return msg
}
