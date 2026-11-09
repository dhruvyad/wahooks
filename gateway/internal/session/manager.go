// Package session runs many WhatsApp accounts (whatsmeow clients) in one process, with WAHA's lifecycle and
// status model. Per account it adds no goroutines or timers of its own beyond whatsmeow's: periodic work
// (QR rotation, lease renewal, retention, metrics) runs on one shared ticker in the manager.
package session

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/store"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/netx"
	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

var (
	ErrNotFound   = errors.New("session not found")
	ErrExists     = errors.New("session already exists")
	ErrNotWorking = errors.New("session is not working")
)

// ErrLeased means another gateway box owns the account; starting it here would run two clients on one login.
type ErrLeased struct{ Owner string }

func (e ErrLeased) Error() string { return "session is owned by another gateway box: " + e.Owner }

type Manager struct {
	Cfg   *config.Config
	DB    *gwstore.DB
	Hooks *webhook.Dispatcher
	Log   *slog.Logger
	wa    *logx.WA

	mu       sync.RWMutex
	sessions map[string]*Session

	shared   *http.Transport // used by every account when no IPv6 prefix is set
	wsTarget *url.URL

	Media *MediaCache
	pics  *ttlCache
	sent  *ttlCache // ids sent through the API in the last 10 min (NOWEB's source "api")
	acks  *ttlCache // message.ack dedup, as NOWEB: same session, id, ack and participant within 60 s
	seen  *ttlCache // message dedup, as NOWEB: same session, fromMe and id within 60 s

	Counters Counters
	startSem chan struct{}
	histSem  chan struct{} // bounds concurrent history-sync processing (WAGW_HISTORY_CONCURRENCY)
	ctx      context.Context
	cancel   context.CancelFunc
	closing  atomic.Bool
}

// Counters are process-wide event counters for /metrics.
type Counters struct {
	mu     sync.Mutex
	events map[string]int64
	Total  atomic.Int64
	// Connection health, for comparing with WAHA's socket drops per session per day.
	Connects, Disconnects, LoggedOut, StreamReplaced, Bans atomic.Int64
	Rate                                                   atomic.Value // float64 events/s over the last tick window
	last                                                   int64
	lastAt                                                 time.Time
}

func (c *Counters) Inc(event string) {
	c.Total.Add(1)
	c.mu.Lock()
	if c.events == nil {
		c.events = map[string]int64{}
	}
	c.events[event]++
	c.mu.Unlock()
}

func (c *Counters) Snapshot() map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int64, len(c.events))
	for k, v := range c.events {
		out[k] = v
	}
	return out
}

func (c *Counters) tick(now time.Time) {
	total := c.Total.Load()
	if !c.lastAt.IsZero() {
		if dt := now.Sub(c.lastAt).Seconds(); dt > 0 {
			c.Rate.Store(float64(total-c.last) / dt)
		}
	}
	c.last, c.lastAt = total, now
}

func NewManager(cfg *config.Config, db *gwstore.DB, hooks *webhook.Dispatcher, log *slog.Logger, wa *logx.WA) (*Manager, error) {
	m := &Manager{
		Cfg: cfg, DB: db, Hooks: hooks, Log: log, wa: wa,
		sessions: map[string]*Session{},
		pics:     newTTLCache(50000),
		sent:     newTTLCache(100000),
		acks:     newTTLCache(200000),
		seen:     newTTLCache(200000),
		startSem: make(chan struct{}, max(1, cfg.StartConcurrency)),
		histSem:  make(chan struct{}, max(1, cfg.HistoryConcurrency)),
	}
	m.ctx, m.cancel = context.WithCancel(context.Background())
	m.Counters.Rate.Store(0.0)
	if cfg.WSURL != "" {
		u, err := url.Parse(cfg.WSURL)
		if err != nil {
			return nil, fmt.Errorf("WAGW_WS_URL: %w", err)
		}
		m.wsTarget = u
	}
	if !cfg.IPv6Prefix.IsValid() {
		m.shared = netx.NewTransport(netip.Addr{})
		m.shared.MaxIdleConns, m.shared.MaxIdleConnsPerHost = 64, 16
	}
	media, err := NewMediaCache(cfg.MediaDir, cfg.MediaCacheTTL)
	if err != nil {
		return nil, err
	}
	m.Media = media
	configureDeviceProps(cfg)
	return m, nil
}

// configureDeviceProps sets what the phone shows for the linked device and how much history it sends.
func configureDeviceProps(cfg *config.Config) {
	store.SetOSInfo(cfg.DeviceName, [3]uint32{1, 0, 0})
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_CHROME.Enum()
	store.DeviceProps.RequireFullSync = proto.Bool(false)
	h := store.DeviceProps.HistorySyncConfig
	if cfg.HistoryDays > 0 {
		h.FullSyncDaysLimit = proto.Uint32(cfg.HistoryDays)
		h.RecentSyncDaysLimit = proto.Uint32(cfg.HistoryDays)
	}
	if cfg.HistorySizeMB > 0 {
		h.FullSyncSizeMbLimit = proto.Uint32(cfg.HistorySizeMB)
		h.StorageQuotaMb = proto.Uint32(max(cfg.HistorySizeMB, 64))
	}
	h.ThumbnailSyncDaysLimit = proto.Uint32(0)
	h.SupportCallLogHistory = proto.Bool(false)
	if cfg.HistoryPerChat > 0 {
		h.InitialSyncMaxMessagesPerChat = proto.Uint32(uint32(cfg.HistoryPerChat))
	}
}

// Load reads every session from the database; Boot then starts the ones that should run.
func (m *Manager) Load(ctx context.Context) ([]*Session, error) {
	rows, err := m.DB.ListSessions(ctx)
	if err != nil {
		return nil, err
	}
	var run []*Session
	m.mu.Lock()
	for _, r := range rows {
		if r.Box != "" && r.Box != m.Cfg.BoxID {
			continue // assigned to another box sharing this database
		}
		s := m.newSession(r)
		m.sessions[r.Name] = s
		if r.Desired == "running" {
			run = append(run, s)
		}
	}
	m.mu.Unlock()
	return run, nil
}

// Boot starts sessions with bounded concurrency and spacing, linked ones first.
func (m *Manager) Boot(sessions []*Session) {
	sort.SliceStable(sessions, func(i, j int) bool {
		return sessions[i].deviceJID() != "" && sessions[j].deviceJID() == ""
	})
	go func() {
		for _, s := range sessions {
			if m.closing.Load() {
				return
			}
			m.startSem <- struct{}{}
			go func(s *Session) {
				defer func() { <-m.startSem }()
				defer recoverLog(m.Log, s.Name, "boot start")
				if err := s.Start(m.ctx); err != nil {
					m.Log.Warn("boot start failed", "session", s.Name, "err", err.Error())
				}
			}(s)
			time.Sleep(m.Cfg.StartInterval)
		}
		m.Log.Info("boot starts dispatched", "sessions", len(sessions))
	}()
}

func (m *Manager) newSession(r *gwstore.SessionRow) *Session {
	s := &Session{m: m, Name: r.Name, status: StatusStopped, row: *r}
	s.parseConfig(json.RawMessage(r.Config))
	if r.SrcIP != "" {
		if a, err := netip.ParseAddr(r.SrcIP); err == nil {
			s.src = a
		}
	}
	return s
}

func (m *Manager) Get(name string) (*Session, error) {
	m.mu.RLock()
	s := m.sessions[name]
	m.mu.RUnlock()
	if s == nil {
		return nil, ErrNotFound
	}
	return s, nil
}

func (m *Manager) List() []*Session {
	m.mu.RLock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s)
	}
	m.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// CountByStatus is for metrics.
func (m *Manager) CountByStatus() map[Status]int {
	out := map[Status]int{StatusStopped: 0, StatusStarting: 0, StatusScanQR: 0, StatusWorking: 0, StatusFailed: 0}
	for _, s := range m.List() {
		out[s.Status()]++
	}
	return out
}

// Create registers a session. srcIP overrides the derived address (used to import an existing device).
func (m *Manager) Create(ctx context.Context, name string, cfgRaw json.RawMessage, srcIP string) (*Session, error) {
	if len(cfgRaw) == 0 || string(cfgRaw) == "null" {
		cfgRaw = json.RawMessage(`{}`)
	}
	if srcIP == "" && m.Cfg.IPv6Prefix.IsValid() {
		srcIP = netx.DeriveIPv6(m.Cfg.IPv6Prefix, m.Cfg.IPv6Salt, name).String()
	}
	r := &gwstore.SessionRow{Name: name, Box: m.Cfg.BoxID, Config: string(cfgRaw), SrcIP: srcIP, Desired: "stopped"}
	m.mu.Lock()
	if _, ok := m.sessions[name]; ok {
		m.mu.Unlock()
		return nil, ErrExists
	}
	if err := m.DB.InsertSession(ctx, r); err != nil {
		m.mu.Unlock()
		if errors.Is(err, gwstore.ErrExists) {
			return nil, ErrExists
		}
		return nil, err
	}
	s := m.newSession(r)
	m.sessions[name] = s
	m.mu.Unlock()
	m.Log.Info("session created", "session", name)
	return s, nil
}

// Delete stops, logs out (best effort) and removes everything the gateway holds for the session. Idempotent.
func (m *Manager) Delete(ctx context.Context, name string) error {
	s, err := m.Get(name)
	if err != nil {
		return nil
	}
	if err := s.Remove(ctx); err != nil {
		var leased ErrLeased
		if errors.As(err, &leased) {
			return err
		}
	}
	m.mu.Lock()
	delete(m.sessions, name)
	m.mu.Unlock()
	if err := m.DB.DeleteSession(ctx, name); err != nil {
		return err
	}
	m.Media.DropSession(name)
	m.Log.Info("session deleted", "session", name)
	return nil
}

// Run is the shared scheduler: QR rotation, lease renewal, metrics rate, media and message retention.
func (m *Manager) Run() {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	var lastLease, lastPrune, lastMedia time.Time
	for {
		select {
		case <-m.ctx.Done():
			return
		case now := <-tick.C:
			func() {
				defer recoverLog(m.Log, "", "scheduler")
				m.Counters.tick(now)
				for _, s := range m.List() {
					s.tick(now)
				}
				if now.Sub(lastLease) > m.Cfg.LeaseTTL/3 {
					lastLease = now
					if err := m.DB.RenewLeases(m.ctx, m.Cfg.BoxID, m.Cfg.LeaseTTL); err != nil {
						m.Log.Warn("lease renewal failed", "err", err.Error())
					}
				}
				if now.Sub(lastMedia) > time.Minute {
					lastMedia = now
					m.Media.Sweep(now)
					m.pics.sweep(now)
					m.sent.sweep(now)
					m.acks.sweep(now)
					m.seen.sweep(now)
				}
				if m.Cfg.StoreMessages && now.Sub(lastPrune) > time.Hour {
					lastPrune = now
					go func() {
						defer recoverLog(m.Log, "", "prune")
						n, err := m.DB.Prune(m.ctx, now.Add(-m.Cfg.MessageRetention), m.Cfg.MessagesPerChat)
						if err != nil {
							m.Log.Warn("message retention failed", "err", err.Error())
						} else if n > 0 {
							m.Log.Info("message retention", "deleted", n)
						}
					}()
				}
			}()
		}
	}
}

// Shutdown disconnects every account without logging out; sessions resume on the next boot.
func (m *Manager) Shutdown(ctx context.Context) {
	m.closing.Store(true)
	var wg sync.WaitGroup
	sem := make(chan struct{}, 64)
	for _, s := range m.List() {
		wg.Add(1)
		sem <- struct{}{}
		go func(s *Session) {
			defer wg.Done()
			defer func() { <-sem }()
			defer recoverLog(m.Log, s.Name, "shutdown")
			s.Stop(ctx, false)
		}(s)
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
	m.cancel()
}

func recoverLog(log *slog.Logger, session, where string) {
	if r := recover(); r != nil {
		log.Error("recovered panic", "session", session, "where", where, "panic", fmt.Sprint(r))
	}
}

// ---- small TTL cache (profile pictures), shared by every account ----

type ttlEntry struct {
	v   string
	exp time.Time
}

type ttlCache struct {
	mu  sync.Mutex
	m   map[string]ttlEntry
	max int
}

func newTTLCache(maxEntries int) *ttlCache {
	return &ttlCache{m: map[string]ttlEntry{}, max: maxEntries}
}

func (c *ttlCache) get(k string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[k]
	if !ok || time.Now().After(e.exp) {
		return "", false
	}
	return e.v, true
}

func (c *ttlCache) set(k, v string, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) >= c.max {
		c.m = map[string]ttlEntry{}
	}
	c.m[k] = ttlEntry{v: v, exp: time.Now().Add(ttl)}
}

func (c *ttlCache) sweep(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.m {
		if now.After(e.exp) {
			delete(c.m, k)
		}
	}
}

func (m *Manager) markSent(id string) { m.sent.set(id, "", 10*time.Minute) }

func (m *Manager) sentRecently(id string) bool {
	_, ok := m.sent.get(id)
	return ok
}

// firstAck reports whether this (session, id, ack, participant) hasn't been emitted in the last 60 s.
func (m *Manager) firstAck(session, id string, ack int, participant string) bool {
	k := session + "|" + id + "|" + strconv.Itoa(ack) + "|" + participant
	if _, ok := m.acks.get(k); ok {
		return false
	}
	m.acks.set(k, "", time.Minute)
	return true
}

// firstSeen reports whether this message (session, fromMe, id) hasn't been emitted in the last 60 s.
func (m *Manager) firstSeen(session string, fromMe bool, id string) bool {
	k := session + "|" + strconv.FormatBool(fromMe) + "|" + id
	if _, ok := m.seen.get(k); ok {
		return false
	}
	m.seen.set(k, "", time.Minute)
	return true
}
