package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"

	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/wahaimport"
)

// importHistory copies a migrated session's WAHA NOWEB history (its messages and chats tables)
// into gw_messages / gw_chats, as if the gateway had received those messages itself.
//
//	gateway import-history -session <name> -dump /var/lib/wagw/migrate/waha-session.dump
//	gateway import-history -session <name> -messages messages.csv [-chats chats.csv]
//
// Safe while the gateway runs: messages are only inserted where absent, chats only move forward
// and keep their live name, unread count and flags; re-running imports nothing new. Bounded by
// the gateway's own retention (WAGW_MESSAGE_RETENTION) and per-chat cap
// (WAGW_MESSAGES_PER_CHAT_MAX), so the janitor has nothing to undo. Prints counts only.
func importHistory(args []string) {
	fs := flag.NewFlagSet("import-history", flag.ExitOnError)
	name := fs.String("session", "", "session whose history to import (must be adopted already)")
	dump := fs.String("dump", "", "pg_dump custom-format archive (-Fc) of the WAHA session database")
	msgs := fs.String("messages", "", "or: CSV export of WAHA's messages table (jid,id,messageTimestamp,data)")
	chats := fs.String("chats", "", "with -messages: CSV export of WAHA's chats table (id,conversationTimestamp,data)")
	dryRun := fs.Bool("dry-run", false, "build the rows and report, write nothing")
	_ = fs.Parse(args)
	if *name == "" || (*dump == "") == (*msgs == "") {
		fmt.Fprintln(os.Stderr, "usage: gateway import-history -session <name> (-dump <file> | -messages <csv> [-chats <csv>]) [-dry-run]")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if !cfg.StoreMessages {
		fmt.Fprintln(os.Stderr, "WAGW_STORE_MESSAGES is off: the gateway keeps no history to import into")
		os.Exit(2)
	}
	log := logx.New("WARN")
	ctx := context.Background()
	db, err := store.Open(ctx, cfg.DBDialect, cfg.DBDSN, cfg.DBMaxConn, logx.NewWA(log, "WARN"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "database:", err)
		os.Exit(1)
	}
	defer db.Close()
	row, err := db.GetSession(ctx, *name)
	if err != nil || row == nil || row.DeviceJID == "" {
		fmt.Fprintln(os.Stderr, "session not found or has no device: adopt it first")
		os.Exit(1)
	}
	jid, err := types.ParseJID(row.DeviceJID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "bad device JID in gw_sessions")
		os.Exit(1)
	}
	dev, err := db.Container.GetDevice(ctx, jid)
	if err != nil || dev == nil {
		fmt.Fprintln(os.Stderr, "the session's device is not in the store")
		os.Exit(1)
	}
	// Only for its own JIDs (ParseWebMessage attributes our own messages); never connected.
	cli := whatsmeow.NewClient(dev, nil)

	var src *wahaimport.Source
	if *dump != "" {
		src, err = wahaimport.FromDump(*dump)
	} else {
		src, err = wahaimport.FromCSV(*msgs, *chats)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	opt := wahaimport.Options{Session: *name, PerChat: cfg.MessagesPerChat}
	if cfg.MessageRetention > 0 {
		opt.Cutoff = time.Now().Add(-cfg.MessageRetention)
	}
	var rep *wahaimport.Report
	if *dryRun {
		_, _, rep, err = wahaimport.Build(cli, src, opt)
	} else {
		rep, err = wahaimport.Import(ctx, db, cli, src, opt)
	}
	b, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(b))
	if err != nil {
		fmt.Fprintln(os.Stderr, "import:", err)
		os.Exit(1)
	}
}
