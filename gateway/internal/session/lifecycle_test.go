package session

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

// blackhole accepts TCP connections and never answers (a WhatsApp that hangs during the websocket upgrade).
func blackhole(t *testing.T) (string, *atomic.Int32) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var n atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n.Add(1)
			go func() { _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().String(), &n
}

func lifecycleManager(t *testing.T, wsURL string) *Manager {
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	wa := logx.NewWA(log, "ERROR")
	db, err := store.Open(ctx, "sqlite", filepath.Join(t.TempDir(), "t.db"), 0, wa)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{BoxID: "test", BaseURL: "http://gw", StoreMessages: true, MediaDir: t.TempDir(), MediaCacheTTL: time.Minute,
		LeaseTTL: time.Minute, StartConcurrency: 1, QRMaxCycles: 1, WSURL: wsURL}
	m, err := NewManager(cfg, db, webhook.New(1, 10, time.Second, nil, log), log, wa)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestStopDuringHangingConnect(t *testing.T) {
	addr, accepts := blackhole(t)
	m := lifecycleManager(t, "ws://"+addr+"/ws/chat")
	ctx := context.Background()
	s, err := m.Create(ctx, "u_l_s_1", json.RawMessage(`{}`), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 750 && accepts.Load() == 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if accepts.Load() == 0 {
		t.Fatal("never dialed the override")
	}
	t0 := time.Now()
	s.Stop(ctx, true)
	if d := time.Since(t0); d > 3*time.Second {
		t.Fatalf("stop waited %v for a hanging connect", d)
	}
	if st := s.Status(); st != StatusStopped {
		t.Fatalf("status %s", st)
	}
	n := accepts.Load()
	time.Sleep(1500 * time.Millisecond)
	if accepts.Load() != n {
		t.Fatal("a stopped client dialed again")
	}
	// Restart twice in a row: only the newest client may remain.
	_ = s.Start(ctx)
	_ = s.Restart(ctx)
	_ = s.Restart(ctx)
	s.Stop(ctx, true)
	n = accepts.Load()
	time.Sleep(1500 * time.Millisecond)
	if accepts.Load() != n || s.Status() != StatusStopped {
		t.Fatalf("after restarts: dials %d→%d, status %s", n, accepts.Load(), s.Status())
	}
}

func TestUnlinkedConnectFailureIsFailed(t *testing.T) {
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close() // nothing listens: connection refused
	m := lifecycleManager(t, "ws://"+addr+"/ws/chat")
	ctx := context.Background()
	s, _ := m.Create(ctx, "u_l_s_2", json.RawMessage(`{}`), "")
	if err := s.Start(ctx); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200 && s.Status() != StatusFailed; i++ {
		time.Sleep(25 * time.Millisecond)
	}
	if s.Status() != StatusFailed {
		t.Fatalf("an unlinked session whose connect fails must be FAILED, got %s", s.Status())
	}
	// restart from FAILED tries again
	if err := s.Restart(ctx); err != nil {
		t.Fatal(err)
	}
	s.Stop(ctx, true)
	if s.Status() != StatusStopped {
		t.Fatal(s.Status())
	}
}
