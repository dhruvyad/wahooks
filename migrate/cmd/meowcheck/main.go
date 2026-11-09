// Command meowcheck connects ONE converted device to WhatsApp with whatsmeow and reports
// whether it is the same linked device and whether messages keep decrypting. It is the
// fallback for the migration runbook when the gateway is not ready; it is not a gateway.
//
// Safety rules (see migrate/README.md):
//
//   - it refuses to run unless -waha-stopped names the WAHA session that was stopped;
//
//   - it never reconnects after StreamReplaced (another client holds the device), a
//     logout, a connect failure, an outdated-client error or a temporary ban: it exits;
//
//   - it never sets presence, never marks anything read, and never logs message content;
//
//   - it acks a message only after handling it (SynchronousAck), so a crash means redelivery.
//
//     meowcheck -store sqlite:./gateway.db -waha-stopped u_…_s_… [-duration 30m]
//     [-send-to 1555…@s.whatsapp.net -text "migration test"]
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/util/dbutil"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/store/sqlstore/upgrades"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"

	"github.com/dhruvyad/wahooks/migrate/internal/convert"
)

// Exit codes.
const (
	exitOK          = 0
	exitUsage       = 2
	exitReplaced    = 3 // another client connected as this device: stop everything, investigate
	exitLoggedOut   = 4 // the device link is gone (whatsmeow deleted it from the store)
	exitConnectFail = 5
	exitOutdated    = 6 // bump whatsmeow
	exitTempBan     = 7
)

type counters struct {
	sync.Mutex
	dm, group, fromMe, status       int
	undecryptable, unavailable      int
	undecryptableBy                 map[string]int
	receipts, appState, appStateErr int
	historySyncs                    int
	offlinePreview, offlineDone     int
}

func main() {
	storeArg := flag.String("store", "", "whatsmeow store: sqlite:<path> or postgres://…")
	jidArg := flag.String("jid", "", "device JID to use (default: the only device in the store)")
	wahaStopped := flag.String("waha-stopped", "", "the WAHA session name you stopped (required; a speed bump against two clients)")
	duration := flag.Duration("duration", 30*time.Minute, "how long to stay connected")
	sendTo := flag.String("send-to", "", "optional: send one text message to this JID after the offline sync")
	text := flag.String("text", "WAHooks migration test", "text for -send-to")
	dryRun := flag.Bool("dry-run", false, "load the device and build the client, but do not connect")
	logLevel := flag.String("log", "WARN", "whatsmeow log level (DEBUG shows retry receipts; never shows content at WARN)")
	flag.Parse()

	if *storeArg == "" || (*wahaStopped == "" && !*dryRun) {
		fmt.Fprintln(os.Stderr, "usage: meowcheck -store <target> -waha-stopped <session> [-duration 30m] [-send-to <jid> -text …]")
		os.Exit(exitUsage)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	container, err := open(ctx, *storeArg)
	if err != nil {
		fail(exitUsage, "open store: %v", err)
	}
	devices, err := container.GetAllDevices(ctx)
	if err != nil {
		fail(exitUsage, "list devices: %v", err)
	}
	var dev = devices
	if *jidArg != "" {
		j, err := types.ParseJID(*jidArg)
		if err != nil {
			fail(exitUsage, "-jid: %v", err)
		}
		d, err := container.GetDevice(ctx, j)
		if err != nil || d == nil {
			fail(exitUsage, "device %s not in store", convert.Mask(*jidArg))
		}
		dev = dev[:0]
		dev = append(dev, d)
	}
	if len(dev) != 1 {
		fail(exitUsage, "the store has %d devices; pass -jid", len(dev))
	}
	device := dev[0]
	logf("device %s (lid %s), registration id %d", convert.Mask(device.ID.String()), convert.Mask(device.LID.String()), device.RegistrationID)

	cli := whatsmeow.NewClient(device, waLog.Stdout("whatsmeow", *logLevel, false))
	cli.EnableAutoReconnect = true // only for network drops; conflict-type errors exit below
	cli.SynchronousAck = true
	cli.AutomaticMessageRerequestFromPhone = true
	cli.EmitAppStateEventsOnFullSync = false

	c := &counters{undecryptableBy: map[string]int{}}
	exit := make(chan int, 1)
	stop := func(code int, format string, args ...any) {
		logf(format, args...)
		select {
		case exit <- code:
		default:
		}
	}
	offlineDone := make(chan struct{}, 1)
	cli.AddEventHandler(func(evt any) {
		switch v := evt.(type) {
		case *events.Connected:
			logf("connected as the converted device")
		case *events.Disconnected:
			logf("disconnected (auto-reconnect for network drops only)")
		case *events.StreamReplaced:
			cli.EnableAutoReconnect = false
			stop(exitReplaced, "STREAM REPLACED: another client connected as this device. Not reconnecting. Make sure WAHA is stopped before anything else.")
		case *events.LoggedOut:
			cli.EnableAutoReconnect = false
			stop(exitLoggedOut, "LOGGED OUT (on connect: %t, reason %s): WhatsApp no longer accepts this device", v.OnConnect, v.Reason)
		case *events.ConnectFailure:
			cli.EnableAutoReconnect = false
			stop(exitConnectFail, "connect failure: %s %s", v.Reason, v.Message)
		case *events.ClientOutdated:
			cli.EnableAutoReconnect = false
			stop(exitOutdated, "client outdated (405): bump whatsmeow and retry")
		case *events.TemporaryBan:
			cli.EnableAutoReconnect = false
			stop(exitTempBan, "temporary ban: %s", v)
		case *events.OfflineSyncPreview:
			c.Lock()
			c.offlinePreview = v.Total
			c.Unlock()
			logf("offline queue: %d items (%d messages, %d receipts, %d notifications)", v.Total, v.Messages, v.Receipts, v.Notifications)
		case *events.OfflineSyncCompleted:
			c.Lock()
			c.offlineDone = v.Count
			c.Unlock()
			logf("offline sync completed: %d items", v.Count)
			select {
			case offlineDone <- struct{}{}:
			default:
			}
		case *events.Message:
			c.Lock()
			switch {
			case v.Info.Chat == types.StatusBroadcastJID:
				c.status++
			case v.Info.IsGroup:
				c.group++
			default:
				c.dm++
			}
			if v.Info.IsFromMe {
				c.fromMe++
			}
			c.Unlock()
		case *events.UndecryptableMessage:
			c.Lock()
			if v.IsUnavailable {
				c.unavailable++
			} else {
				c.undecryptable++
			}
			kind := "dm"
			if v.Info.IsGroup {
				kind = "group"
			}
			if v.Info.IsFromMe {
				kind += "/from-me"
			}
			c.undecryptableBy[kind+" "+string(v.DecryptFailMode)]++
			c.Unlock()
		case *events.Receipt:
			c.Lock()
			c.receipts++
			c.Unlock()
		case *events.HistorySync:
			c.Lock()
			c.historySyncs++
			c.Unlock()
		case *events.AppStateSyncError:
			c.Lock()
			c.appStateErr++
			c.Unlock()
			logf("app state %s sync error (full sync %t): %v", v.Name, v.FullSync, v.Error)
		case *events.Archive, *events.Mute, *events.Pin, *events.Star, *events.PushNameSetting, *events.Contact, *events.MarkChatAsRead, *events.DeleteChat:
			c.Lock()
			c.appState++
			c.Unlock()
		}
	})

	if *dryRun {
		logf("dry run: device loaded and client built; not connecting")
		return
	}
	logf("WAHA session %q must be STOPPED and its WAHooks row failed. Connecting in 5 s (Ctrl-C to abort)…", *wahaStopped)
	select {
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
		return
	}
	if err := cli.Connect(); err != nil {
		fail(exitConnectFail, "connect: %v", err)
	}
	defer cli.Disconnect()

	if *sendTo != "" {
		go func() {
			select {
			case <-offlineDone:
			case <-time.After(2 * time.Minute):
			case <-ctx.Done():
				return
			}
			to, err := types.ParseJID(*sendTo)
			if err != nil {
				logf("-send-to: %v", err)
				return
			}
			resp, err := cli.SendMessage(ctx, to, &waE2E.Message{Conversation: proto.String(*text)})
			if err != nil {
				logf("send to %s failed: %v", convert.Mask(to.String()), err)
				return
			}
			logf("sent test message %s to %s (check it arrives and shows one/two ticks)", resp.ID, convert.Mask(to.String()))
		}()
	}

	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	deadline := time.After(*duration)
	code := exitOK
loop:
	for {
		select {
		case code = <-exit:
			break loop
		case <-deadline:
			break loop
		case <-ctx.Done():
			break loop
		case <-tick.C:
			report(c)
		}
	}
	report(c)
	cli.Disconnect()
	os.Exit(code)
}

func report(c *counters) {
	c.Lock()
	defer c.Unlock()
	var by []string
	for k, n := range c.undecryptableBy {
		by = append(by, fmt.Sprintf("%s ×%d", k, n))
	}
	logf("decrypted: dm %d, group %d, status %d (from me %d) | undecryptable %d, unavailable %d [%s] | receipts %d | app-state events %d, errors %d | history syncs %d | offline %d/%d",
		c.dm, c.group, c.status, c.fromMe, c.undecryptable, c.unavailable, strings.Join(by, ", "), c.receipts, c.appState, c.appStateErr, c.historySyncs, c.offlineDone, c.offlinePreview)
}

func open(ctx context.Context, arg string) (*sqlstore.Container, error) {
	driver, dialect, dsn := "", "", ""
	switch {
	case strings.HasPrefix(arg, "postgres://"), strings.HasPrefix(arg, "postgresql://"):
		driver, dialect, dsn = "pgx", "postgres", arg
	default:
		p := strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(arg, "sqlite:"), "file:"), "//")
		if i := strings.IndexByte(p, '?'); i >= 0 {
			p = p[:i]
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(abs); err != nil {
			return nil, err
		}
		driver, dialect, dsn = "sqlite", "sqlite3", "file:"+abs+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)"
	}
	raw, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	db, err := dbutil.NewWithDB(raw, dialect)
	if err != nil {
		return nil, err
	}
	db.UpgradeTable = upgrades.Table
	db.VersionTable = "whatsmeow_version"
	c := sqlstore.NewWithWrappedDB(db, waLog.Noop)
	return c, c.Upgrade(ctx)
}

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "%s meowcheck: %s\n", time.Now().UTC().Format("15:04:05Z"), fmt.Sprintf(format, args...))
}

func fail(code int, format string, args ...any) {
	logf(format, args...)
	os.Exit(code)
}
