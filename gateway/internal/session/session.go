package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/dhruvyad/wahooks/gateway/internal/netx"
	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

type Status string

const (
	StatusStopped  Status = "STOPPED"
	StatusStarting Status = "STARTING"
	StatusScanQR   Status = "SCAN_QR_CODE"
	StatusWorking  Status = "WORKING"
	StatusFailed   Status = "FAILED"
)

type StatusChange struct {
	Status    Status `json:"status"`
	Timestamp int64  `json:"timestamp"`
}

// Session is one WhatsApp account. opMu serialises lifecycle operations (start/stop/logout), which may block on
// the network; mu guards state and is only held briefly, so event handlers never wait on a lifecycle call.
type Session struct {
	m    *Manager
	Name string

	opMu sync.Mutex
	mu   sync.Mutex
	// connMu serialises whatsmeow Connect with Disconnect. whatsmeow's Connect clears the "expected disconnect"
	// flag, so a Disconnect that lands before an in-flight Connect starts would be undone and leave an orphan client
	// connected next to its replacement (WhatsApp then kicks one with "stream replaced").
	connMu sync.Mutex

	row      gwstore.SessionRow
	cfgRaw   json.RawMessage
	targets  []*webhook.Target
	metadata map[string]string
	ignore   ignoreCfg
	src      netip.Addr

	cli      *whatsmeow.Client
	cctx     context.Context    // the client's generation context: cancelled before every disconnect so neither
	cancel   context.CancelFunc // whatsmeow's auto-reconnect nor its post-pairing (515) reconnect can redial
	gen      atomic.Uint64
	status   Status
	history  []StatusChange
	reason   string
	qr       []string
	qrAt     time.Time
	qrShown  int
	qrCycles int
	rotating bool

	onlineAt time.Time
}

// ignoreCfg is WAHA's config.ignore: drop message events from status, groups, channels or broadcast lists.
type ignoreCfg struct {
	Status    *bool `json:"status"`
	Groups    *bool `json:"groups"`
	Channels  *bool `json:"channels"`
	Broadcast *bool `json:"broadcast"`
}

func (s *Session) parseConfig(raw json.RawMessage) {
	var c struct {
		Webhooks []*webhook.Target `json:"webhooks"`
		Metadata map[string]string `json:"metadata"`
		Ignore   ignoreCfg         `json:"ignore"`
	}
	_ = json.Unmarshal(raw, &c)
	s.cfgRaw = raw
	s.targets = c.Webhooks
	s.metadata = c.Metadata
	s.ignore = c.Ignore
}

func isTrue(b *bool) bool { return b != nil && *b }

// ignored applies config.ignore to a chat.
func (s *Session) ignored(chat types.JID) bool {
	s.mu.Lock()
	ig := s.ignore
	s.mu.Unlock()
	switch chat.Server {
	case types.BroadcastServer:
		if chat.User == "status" {
			return isTrue(ig.Status)
		}
		return isTrue(ig.Broadcast)
	case types.GroupServer:
		return isTrue(ig.Groups)
	case types.NewsletterServer:
		return isTrue(ig.Channels)
	}
	return false
}

func (s *Session) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Session) Config() json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfgRaw
}

func (s *Session) Metadata() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.metadata
}

func (s *Session) SourceIP() string {
	if s.src.IsValid() {
		return s.src.String()
	}
	return ""
}

func (s *Session) deviceJID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.row.DeviceJID
}

func (s *Session) Statuses() []StatusChange {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]StatusChange(nil), s.history...)
}

// Client returns the running client when the session is WORKING.
func (s *Session) Client() (*whatsmeow.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cli == nil || s.status != StatusWorking {
		return nil, fmt.Errorf("%w: session status is %s", ErrNotWorking, s.status)
	}
	return s.cli, nil
}

// AnyClient returns the running client in any state (for QR pairing).
func (s *Session) AnyClient() *whatsmeow.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cli
}

// Me is the logged-in account (NOWEB MeInfo), nil when not linked.
func (s *Session) Me() *waha.Me {
	s.mu.Lock()
	cli := s.cli
	jid := s.row.DeviceJID
	s.mu.Unlock()
	var dev *store.Device
	if cli != nil {
		dev = cli.Store
	}
	if dev == nil || dev.ID == nil {
		if jid == "" {
			return nil
		}
		j, err := types.ParseJID(jid)
		if err != nil {
			return nil
		}
		return &waha.Me{ID: waha.CUs(j.ToNonAD()), JID: j.String()}
	}
	me := &waha.Me{ID: waha.CUs(dev.ID.ToNonAD()), PushName: dev.PushName, JID: dev.ID.String()}
	if !dev.LID.IsEmpty() {
		me.LID = dev.LID.ToNonAD().String()
	}
	return me
}

// QR returns the code to show now, if any.
func (s *Session) QR() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status != StatusScanQR || len(s.qr) == 0 {
		return "", false
	}
	i := qrIndex(time.Since(s.qrAt))
	if i >= len(s.qr) {
		return "", false
	}
	return s.qr[i], true
}

// WhatsApp's first code lives 60 s, the following ones 20 s each.
func qrIndex(elapsed time.Duration) int {
	if elapsed < 60*time.Second {
		return 0
	}
	return 1 + int((elapsed-60*time.Second)/(20*time.Second))
}

func (s *Session) setStatus(st Status, reason string, emit bool) {
	s.setStatusIf(0, st, reason, emit)
}

// setStatusIf sets the status only while the session is still at generation gen (0 = always), so a lifecycle call
// that came in between (stop, restart) keeps its own status.
func (s *Session) setStatusIf(gen uint64, st Status, reason string, emit bool) {
	s.mu.Lock()
	if gen != 0 && s.gen.Load() != gen {
		s.mu.Unlock()
		return
	}
	if s.status == st && s.reason == reason {
		s.mu.Unlock()
		return
	}
	s.status, s.reason = st, reason
	s.history = append(s.history, StatusChange{Status: st, Timestamp: time.Now().UnixMilli()})
	if len(s.history) > 3 {
		s.history = s.history[len(s.history)-3:]
	}
	hist := append([]StatusChange(nil), s.history...)
	s.mu.Unlock()
	if reason != "" {
		s.m.Log.Info("session status", "session", s.Name, "status", string(st), "reason", reason)
	} else {
		s.m.Log.Info("session status", "session", s.Name, "status", string(st))
	}
	if emit {
		s.emitStatus(st, hist)
	}
}

// emitStatus sends session.status: {name, status, statuses (last 3), data}.
func (s *Session) emitStatus(st Status, hist []StatusChange) {
	s.emit("session.status", waha.OM{{K: "name", V: s.Name}, {K: "status", V: st}, {K: "statuses", V: hist}, {K: "data", V: nil}})
}

// Start connects the account. Idempotent: a running session is left as it is.
func (s *Session) Start(ctx context.Context) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.startLocked(ctx)
}

func (s *Session) startLocked(ctx context.Context) error {
	s.mu.Lock()
	running := s.cli != nil
	s.mu.Unlock()
	if running {
		return nil
	}
	ok, owner, err := s.m.DB.AcquireLease(ctx, s.Name, s.m.Cfg.BoxID, s.m.Cfg.LeaseTTL)
	if err != nil {
		return err
	}
	if !ok {
		return ErrLeased{Owner: owner}
	}
	if err := s.m.DB.UpdateSession(ctx, s.Name, map[string]any{"desired": "running"}); err != nil {
		return err
	}
	dev, err := s.loadDevice(ctx)
	if err != nil {
		return err
	}
	cli := whatsmeow.NewClient(dev, s.m.wa.With(s.Name))
	s.m.configureClient(cli, s.src)
	// A linked device keeps retrying a failed first connect in the background (STARTING); an unlinked one fails
	// fast instead of sitting in STARTING forever (whatsmeow's auto-reconnect skips devices without an ID).
	cli.InitialAutoReconnect = dev.ID != nil
	cctx, cancel := context.WithCancel(s.m.ctx)
	cli.BackgroundEventCtx = cctx
	gen := s.gen.Add(1)
	cli.AddEventHandler(func(evt any) { s.handle(gen, cli, evt) })
	s.mu.Lock()
	s.cli, s.cctx, s.cancel = cli, cctx, cancel
	s.qr, s.qrCycles, s.rotating = nil, 0, false
	s.mu.Unlock()
	s.setStatus(StatusStarting, "", true)
	go s.connect(gen, cli, cctx)
	return nil
}

// detach takes the running client out of the session (next generation) and returns it with its cancel func.
func (s *Session) detach() (*whatsmeow.Client, context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cli, cancel := s.cli, s.cancel
	s.cli, s.cctx, s.cancel = nil, nil, nil
	s.qr = nil
	s.gen.Add(1)
	return cli, cancel
}

// shutdownClient stops a detached client for good: cancel its context first (no redial), then disconnect.
func (s *Session) shutdownClient(cli *whatsmeow.Client, cancel context.CancelFunc) {
	if cancel != nil {
		cancel()
	}
	if cli != nil {
		s.connMu.Lock()
		cli.Disconnect()
		s.connMu.Unlock()
	}
}

func (s *Session) loadDevice(ctx context.Context) (*store.Device, error) {
	s.mu.Lock()
	jid := s.row.DeviceJID
	s.mu.Unlock()
	if jid != "" {
		j, err := types.ParseJID(jid)
		if err == nil {
			dev, err := s.m.DB.Container.GetDevice(ctx, j)
			if err != nil {
				return nil, err
			}
			if dev != nil {
				dev.LIDs = s.m.DB.LIDs
				// Skip whatsmeow's per-message rewrite of unchanged identity keys (1 of its 2 writes per message).
				// A device linked in this run gets it on its next start.
				gwstore.UseIdentityCache(dev, 128)
				return dev, nil
			}
		}
		// The device is gone from the store (logged out elsewhere): start fresh with a QR.
		s.setDeviceJID(ctx, "")
	}
	dev := s.m.DB.Container.NewDevice()
	dev.LIDs = s.m.DB.LIDs
	return dev, nil
}

func (s *Session) setDeviceJID(ctx context.Context, jid string) {
	s.mu.Lock()
	s.row.DeviceJID = jid
	s.mu.Unlock()
	if err := s.m.DB.UpdateSession(ctx, s.Name, map[string]any{"device_jid": jid}); err != nil {
		s.m.Log.Warn("saving device failed", "session", s.Name, "err", err.Error())
	}
}

func (s *Session) connect(gen uint64, cli *whatsmeow.Client, ctx context.Context) {
	defer recoverLog(s.m.Log, s.Name, "connect")
	s.connMu.Lock()
	if s.gen.Load() != gen || ctx.Err() != nil {
		s.connMu.Unlock()
		return // stopped or replaced before we got to connect
	}
	err := cli.ConnectContext(ctx)
	s.connMu.Unlock()
	if err == nil || s.gen.Load() != gen {
		return
	}
	s.m.Log.Warn("connect failed", "session", s.Name, "err", err.Error())
	s.fail(gen, "connect failed")
}

// The session stays "running" in the DB after a drop, so a restart or reboot tries again, as WAHA does with FAILED
// sessions.

// fail drops the client of generation gen and sets FAILED, unless another lifecycle call got there first.
func (s *Session) fail(gen uint64, reason string) {
	if next, ok := s.drop(gen); ok {
		s.setStatusIf(next, StatusFailed, reason, true)
	}
}

func (s *Session) drop(gen uint64) (uint64, bool) {
	s.mu.Lock()
	if s.gen.Load() != gen || s.cli == nil {
		s.mu.Unlock()
		return 0, false
	}
	// Check and detach under one hold, so a concurrent Stop either wins (we return false) or comes after.
	cli, cancel := s.cli, s.cancel
	s.cli, s.cctx, s.cancel = nil, nil, nil
	s.qr = nil
	next := s.gen.Add(1)
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	go func() {
		defer recoverLog(s.m.Log, s.Name, "disconnect")
		s.connMu.Lock()
		defer s.connMu.Unlock()
		cli.Disconnect()
	}()
	return next, true
}

// Stop disconnects without logging out. persist=true records that the session should stay stopped (API stop);
// persist=false is used by shutdown and restart.
func (s *Session) Stop(ctx context.Context, persist bool) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.stopLocked(ctx, persist)
}

func (s *Session) stopLocked(ctx context.Context, persist bool) {
	cli, cancel := s.detach()
	s.shutdownClient(cli, cancel)
	if persist {
		_ = s.m.DB.UpdateSession(ctx, s.Name, map[string]any{"desired": "stopped"})
		_ = s.m.DB.ReleaseLease(ctx, s.Name, s.m.Cfg.BoxID)
	}
	s.setStatus(StatusStopped, "", persist)
}

// Restart reconnects from the stored credentials.
func (s *Session) Restart(ctx context.Context) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.stopLocked(ctx, false)
	return s.startLocked(ctx)
}

// Logout unlinks the device from the phone and removes its credentials. A session that was running starts again
// and shows a new QR; a stopped one stays stopped (WAHA's behaviour).
func (s *Session) Logout(ctx context.Context) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	return s.logoutLocked(ctx, true)
}

// checkOwner refuses to act on an account another box holds a live lease on.
func (s *Session) checkOwner(ctx context.Context) error {
	r, err := s.m.DB.GetSession(ctx, s.Name)
	if err != nil {
		return nil
	}
	if r.Owner != "" && r.Owner != s.m.Cfg.BoxID && r.LeaseUntil > time.Now().Unix() {
		return ErrLeased{Owner: r.Owner}
	}
	return nil
}

func (s *Session) logoutLocked(ctx context.Context, restart bool) error {
	if err := s.checkOwner(ctx); err != nil {
		return err
	}
	s.mu.Lock()
	jid := s.row.DeviceJID
	s.mu.Unlock()
	cli, cancel := s.detach()
	wasRunning := cli != nil
	if cli != nil {
		s.connMu.Lock()
		if cli.IsLoggedIn() {
			lctx, lcancel := context.WithTimeout(ctx, 15*time.Second)
			err := cli.Logout(lctx) // unlinks, disconnects and deletes the credentials
			lcancel()
			if err != nil {
				s.m.Log.Warn("remote logout failed, removing credentials locally", "session", s.Name, "err", err.Error())
				cli.Disconnect()
				if cli.Store.ID != nil {
					_ = cli.Store.Delete(ctx)
				}
			}
			jid = ""
		} else {
			// Not connected right now (e.g. reconnecting): unlink through a short separate connection below.
			cli.Disconnect()
			if cli.Store.ID != nil {
				jid = cli.Store.ID.String()
			} else {
				jid = ""
			}
		}
		s.connMu.Unlock()
		if cancel != nil {
			cancel()
		}
	}
	if jid != "" {
		s.offlineLogout(ctx, jid)
	}
	s.setDeviceJID(ctx, "")
	s.m.Log.Info("session logged out", "session", s.Name)
	if wasRunning && restart {
		return s.startLocked(ctx)
	}
	s.setStatus(StatusStopped, "", true)
	return nil
}

// Remove stops and logs the session out in one locked step, so no Start can slip in between (Delete).
func (s *Session) Remove(ctx context.Context) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.checkOwner(ctx); err != nil {
		return err
	}
	s.stopLocked(ctx, true)
	return s.logoutLocked(ctx, false)
}

// offlineLogout briefly connects a stopped session's device to tell WhatsApp it is unlinked, so it doesn't stay
// on the phone's linked-devices list (which allows only 4). If that fails the credentials are deleted locally.
func (s *Session) offlineLogout(ctx context.Context, jid string) {
	j, err := types.ParseJID(jid)
	if err != nil {
		return
	}
	dev, err := s.m.DB.Container.GetDevice(ctx, j)
	if err != nil || dev == nil {
		return
	}
	dev.LIDs = s.m.DB.LIDs
	cli := whatsmeow.NewClient(dev, s.m.wa.With(s.Name))
	s.m.configureClient(cli, s.src)
	cli.EnableAutoReconnect = false
	ready := make(chan struct{}, 1)
	cli.AddEventHandler(func(evt any) {
		switch evt.(type) {
		case *events.Connected, *events.LoggedOut:
			select {
			case ready <- struct{}{}:
			default:
			}
		}
	})
	done := false
	cctx, ccancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer ccancel()
	cli.BackgroundEventCtx = cctx
	if err := cli.ConnectContext(cctx); err == nil {
		select {
		case <-ready:
			if cli.IsLoggedIn() {
				lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				done = cli.Logout(lctx) == nil
				cancel()
			}
		case <-time.After(15 * time.Second):
		}
	}
	if !done {
		cli.Disconnect()
		if !dev.Deleted {
			_ = dev.Delete(ctx)
		}
	}
}

// RequestCode asks WhatsApp for a pairing code for phone (digits only), as an alternative to the QR.
func (s *Session) RequestCode(ctx context.Context, phone string) (string, error) {
	s.mu.Lock()
	cli := s.cli
	st := s.status
	s.mu.Unlock()
	if cli == nil || st != StatusScanQR {
		return "", fmt.Errorf("%w: session status is %s, expected SCAN_QR_CODE", ErrNotWorking, st)
	}
	return cli.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
}

// tick runs on the manager's shared scheduler: it announces each new QR code (NOWEB emits SCAN_QR_CODE on every
// refresh) and ends an unscanned series (NOWEB: FAILED; with WAGW_QR_MAX_CYCLES > 1 or 0 a new series instead).
func (s *Session) tick(now time.Time) {
	s.mu.Lock()
	if s.status != StatusScanQR || s.cli == nil || s.rotating || len(s.qr) == 0 {
		s.mu.Unlock()
		return
	}
	idx := qrIndex(now.Sub(s.qrAt))
	if idx < len(s.qr) {
		if idx > s.qrShown {
			s.qrShown = idx
			s.history = append(s.history, StatusChange{Status: StatusScanQR, Timestamp: now.UnixMilli()})
			if len(s.history) > 3 {
				s.history = s.history[len(s.history)-3:]
			}
			hist := append([]StatusChange(nil), s.history...)
			s.mu.Unlock()
			s.emitStatus(StatusScanQR, hist)
			return
		}
		s.mu.Unlock()
		return
	}
	// Every code of this series expired unscanned.
	s.qrCycles++
	cycles := s.qrCycles
	cli := s.cli
	cctx := s.cctx
	gen := s.gen.Load()
	s.rotating = true
	s.qr = nil
	s.mu.Unlock()
	if max := s.m.Cfg.QRMaxCycles; max > 0 && cycles >= max {
		s.fail(gen, "QR code not scanned")
		return
	}
	go func() {
		defer recoverLog(s.m.Log, s.Name, "qr rotate")
		s.connMu.Lock()
		if s.gen.Load() != gen || cctx == nil || cctx.Err() != nil {
			s.connMu.Unlock()
			return
		}
		cli.Disconnect()
		err := cli.ConnectContext(cctx)
		s.connMu.Unlock()
		if err != nil && s.gen.Load() == gen {
			s.fail(gen, "connect failed")
		}
		s.mu.Lock()
		s.rotating = false
		s.mu.Unlock()
	}()
}

// emit sends one WAHA event to the session's webhooks.
func (s *Session) emit(event string, payload any) {
	s.m.Counters.Inc(event)
	s.mu.Lock()
	targets := s.targets
	meta := s.metadata
	s.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	wanted := false
	for _, t := range targets {
		if t.Wants(event) {
			wanted = true
			break
		}
	}
	if !wanted {
		return
	}
	body, _, ts, err := waha.Envelope(event, s.Name, s.Me(), meta, payload)
	if err != nil {
		s.m.Log.Warn("event encode failed", "session", s.Name, "event", event, "err", err.Error())
		return
	}
	s.m.Hooks.Send(s.Name, event, ts, body, targets)
}

// configureClient applies the gateway's settings to a new whatsmeow client: source address, websocket override,
// small caches, history-sync limits.
func (m *Manager) configureClient(cli *whatsmeow.Client, src netip.Addr) {
	var base http.RoundTripper
	if src.IsValid() {
		base = netx.NewTransport(src)
	} else {
		base = m.shared
	}
	cli.SetMediaHTTPClient(&http.Client{Transport: base})
	ws := &http.Client{Transport: base}
	if m.wsTarget != nil {
		t := base.(*http.Transport).Clone()
		if m.Cfg.InsecureTLS {
			t.TLSClientConfig = netx.InsecureTLS()
		}
		ws = &http.Client{Transport: netx.RewriteRT{Base: t, Target: m.wsTarget}}
	}
	cli.SetWebsocketHTTPClient(ws)
	cli.SetPreLoginHTTPClient(ws)
	cli.EnableAutoReconnect = true
	cli.InitialAutoReconnect = true
	cli.AutoTrustIdentity = true
	cli.EmitAppStateEventsOnFullSync = false
	cli.AutomaticMessageRerequestFromPhone = true
}

// UpdateConfig replaces the session's WAHA config (webhooks, metadata). A running session keeps running.
func (s *Session) UpdateConfig(ctx context.Context, raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(`{}`)
	}
	if err := s.m.DB.UpdateSession(ctx, s.Name, map[string]any{"config": string(raw)}); err != nil {
		return err
	}
	s.mu.Lock()
	s.parseConfig(raw)
	s.row.Config = string(raw)
	s.mu.Unlock()
	return nil
}
