package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
)

// copyStore copies a whole store into the one WAGW_DB names, e.g. a box's SQLite file into the shared
// Postgres store:
//
//	systemctl stop wagw
//	gateway copy-store -from sqlite:///var/lib/wagw/wagw.db     # destination: WAGW_DB from the environment
//
// One destination transaction (all or nothing); a row already in the destination fails the copy
// instead of being overwritten. The source must not change meanwhile: stop the gateway first. The
// destination URL comes from the environment, so it never appears in the process list.
func copyStore(args []string) {
	fs := flag.NewFlagSet("copy-store", flag.ExitOnError)
	from := fs.String("from", "", "source store URL (sqlite://<path> or postgres://…)")
	_ = fs.Parse(args)
	if *from == "" {
		fmt.Fprintln(os.Stderr, "usage: gateway copy-store -from <store URL>   (destination: WAGW_DB)")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	sd, sdsn, err := config.ParseDB(*from)
	if err != nil {
		fmt.Fprintln(os.Stderr, "-from:", err)
		os.Exit(2)
	}
	if sd == cfg.DBDialect && sdsn == cfg.DBDSN {
		fmt.Fprintln(os.Stderr, "-from and WAGW_DB are the same store")
		os.Exit(2)
	}
	ctx := context.Background()
	wl := logx.NewWA(logx.New("WARN"), "WARN")
	src, err := store.Open(ctx, sd, sdsn, 2, wl)
	if err != nil {
		fmt.Fprintln(os.Stderr, "source:", err)
		os.Exit(1)
	}
	defer src.Close()
	dst, err := store.Open(ctx, cfg.DBDialect, cfg.DBDSN, 2, wl)
	if err != nil {
		fmt.Fprintln(os.Stderr, "destination:", err)
		os.Exit(1)
	}
	defer dst.Close()
	rep, err := store.CopyInto(ctx, src, dst)
	if err != nil {
		fmt.Fprintln(os.Stderr, "copy failed, nothing written:", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(rep)
}
