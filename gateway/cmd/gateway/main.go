// Command gateway is the WAHooks WhatsApp gateway: many whatsmeow accounts in one process behind a
// WAHA-compatible HTTP API. Configuration is by environment (see README.md).
//
//	gateway                      run the server
//	gateway adopt-device ...     attach a device already in the store to a new session (see -h)
//	gateway derive-ip <session>  print the source address a session gets
//	gateway sink ...             test webhook receiver (appends events to a file, prints only event names)
//	gateway redact [-keys]       mask personal values in JSON from stdin (for inspecting payloads safely)
//	gateway show-qr <session>    print a session's QR in the terminal until it is linked (run on the box)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dhruvyad/wahooks/gateway/internal/api"
	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/metrics"
	"github.com/dhruvyad/wahooks/gateway/internal/netx"
	"github.com/dhruvyad/wahooks/gateway/internal/session"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "adopt-device":
			adopt(os.Args[2:])
			return
		case "import-history":
			importHistory(os.Args[2:])
			return
		case "copy-store":
			copyStore(os.Args[2:])
			return
		case "derive-ip":
			deriveIP(os.Args[2:])
			return
		case "sink":
			sink(os.Args[2:])
			return
		case "redact":
			redact(os.Args[2:])
			return
		case "show-qr":
			showQR(os.Args[2:])
			return
		case "version", "-v", "--version":
			fmt.Println(api.Version)
			return
		default:
			// The service runs with no arguments. Starting the full gateway for a subcommand this
			// build doesn't know (an older binary given a newer runbook's command) would open a
			// second WhatsApp client on the live device, so refuse instead.
			fmt.Fprintf(os.Stderr, "unknown subcommand %q (this build: %s)\n", os.Args[1], api.Version)
			os.Exit(2)
		}
	}
	serve()
}

func serve() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	log := logx.New(cfg.LogLevel)
	wa := logx.NewWA(log, cfg.WhatsmeowLogLevel)
	ctx := context.Background()
	db, err := store.Open(ctx, cfg.DBDialect, cfg.DBDSN, cfg.DBMaxConn, wa.Sub("Store"))
	if err != nil {
		log.Error("database", "err", err.Error())
		os.Exit(1)
	}
	if cfg.LIDCacheMax > 0 {
		db.UseBoundedLIDMap(cfg.LIDCacheMax)
	}
	waha.WorkerID = cfg.BoxID
	webhook.UserAgent = "WAHA/" + waha.Version
	hooks := webhook.New(cfg.WebhookWorkers, cfg.WebhookQueue, cfg.WebhookTimeout, cfg.WebhookResolve, log)
	m, err := session.NewManager(cfg, db, hooks, log, wa)
	if err != nil {
		log.Error("manager", "err", err.Error())
		os.Exit(1)
	}
	toStart, err := m.Load(ctx)
	if err != nil {
		log.Error("loading sessions", "err", err.Error())
		os.Exit(1)
	}
	go m.Run()

	srv := &api.Server{M: m, Log: log, Started: time.Now(), Metrics: &metrics.Handler{M: m, Hooks: hooks}}
	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(cfg.APIKey),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server", "err", err.Error())
			os.Exit(1)
		}
	}()
	prefix := ""
	if cfg.IPv6Prefix.IsValid() {
		prefix = cfg.IPv6Prefix.String()
		// Every account dials from its own address in the prefix: check that the box lets us bind one (AnyIP route
		// or ip_nonlocal_bind), or every connection would fail.
		probe := netx.DeriveIPv6(cfg.IPv6Prefix, cfg.IPv6Salt, "wagw-selftest")
		if pc, err := net.ListenPacket("udp6", net.JoinHostPort(probe.String(), "0")); err != nil {
			log.Error("cannot bind an address in WAGW_IPV6_PREFIX; set up AnyIP (ip -6 route add local <prefix> dev lo) or net.ipv6.ip_nonlocal_bind=1", "prefix", prefix, "err", err.Error())
		} else {
			_ = pc.Close()
		}
	}
	log.Info("gateway started", "version", api.Version, "listen", cfg.Listen, "db", cfg.DBDialect, "sessions", len(m.List()), "starting", len(toStart), "ipv6_prefix", prefix, "box", cfg.BoxID, "ws_override", cfg.WSURL != "")
	m.Boot(toStart)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	s := <-sig
	log.Info("shutting down", "signal", s.String())
	sctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(sctx)
	m.Shutdown(sctx)
	hooks.Close(5 * time.Second)
	_ = db.Close()
	log.Info("stopped")
}

// adopt attaches a whatsmeow device that is already in the store (e.g. a copied harness database) to a new
// gateway session, so it reconnects without a new QR scan.
func adopt(args []string) {
	fs := flag.NewFlagSet("adopt-device", flag.ExitOnError)
	name := fs.String("session", "", "session name to create")
	jid := fs.String("jid", "", "device JID (default: the only device not attached to a session)")
	src := fs.String("src-ip", "", "pin this source address instead of the derived one (keep a device's existing address)")
	cfgJSON := fs.String("config", `{}`, "WAHA session config JSON (webhooks, metadata)")
	start := fs.Bool("start", true, "mark the session to start on the next boot")
	_ = fs.Parse(args)
	if *name == "" {
		fmt.Fprintln(os.Stderr, "-session is required")
		os.Exit(2)
	}
	if !json.Valid([]byte(*cfgJSON)) {
		fmt.Fprintln(os.Stderr, "-config is not valid JSON")
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
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
	devs, err := db.Container.GetAllDevices(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "devices:", err)
		os.Exit(1)
	}
	rows, _ := db.ListSessions(ctx)
	taken := map[string]bool{}
	for _, r := range rows {
		taken[r.DeviceJID] = true
	}
	var pick string
	for _, d := range devs {
		if d.ID == nil || taken[d.ID.String()] {
			continue
		}
		if *jid == "" || *jid == d.ID.String() {
			if pick != "" && *jid == "" {
				fmt.Fprintln(os.Stderr, "several unattached devices; pass -jid")
				os.Exit(1)
			}
			pick = d.ID.String()
		}
	}
	if pick == "" {
		fmt.Fprintln(os.Stderr, "no unattached device found")
		os.Exit(1)
	}
	ip := *src
	if ip == "" && cfg.IPv6Prefix.IsValid() {
		ip = netx.DeriveIPv6(cfg.IPv6Prefix, cfg.IPv6Salt, *name).String()
	}
	desired := "stopped"
	if *start {
		desired = "running"
	}
	r := &store.SessionRow{Name: *name, Box: cfg.BoxID, Config: *cfgJSON, DeviceJID: pick, SrcIP: ip, Desired: desired}
	if err := db.InsertSession(ctx, r); err != nil {
		fmt.Fprintln(os.Stderr, "insert:", err)
		os.Exit(1)
	}
	fmt.Printf("session %s adopted a device (source address %q, desired %s)\n", *name, ip, desired)
}

func deriveIP(args []string) {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: gateway derive-ip <session>")
		os.Exit(2)
	}
	os.Setenv("WAGW_INSECURE_NO_AUTH", "1")
	cfg, err := config.Load()
	if err != nil || !cfg.IPv6Prefix.IsValid() {
		fmt.Fprintln(os.Stderr, "set WAGW_IPV6_PREFIX")
		os.Exit(2)
	}
	fmt.Println(netx.DeriveIPv6(cfg.IPv6Prefix, cfg.IPv6Salt, args[0]))
}
