package session

import (
	"context"
	"errors"
	"testing"

	"github.com/dhruvyad/wahooks/gateway/internal/store"
)

// A session adopted into the store by another process becomes visible to a running gateway on load,
// once; a session assigned to another box or missing from the store is refused.
func TestLoadAdopted(t *testing.T) {
	m, _, _, _ := setup(t)
	ctx := context.Background()
	if err := m.DB.InsertSession(ctx, &store.SessionRow{Name: "u_t_s_2", Box: "test", Config: `{}`, Desired: "stopped"}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Get("u_t_s_2"); !errors.Is(err, ErrNotFound) {
		t.Fatal("visible before load")
	}
	s, err := m.LoadAdopted(ctx, "u_t_s_2")
	if err != nil || s == nil || s.Status() != StatusStopped {
		t.Fatalf("load: %v", err)
	}
	if got, err := m.Get("u_t_s_2"); err != nil || got != s {
		t.Fatal("not registered after load")
	}
	if _, err := m.LoadAdopted(ctx, "u_t_s_2"); !errors.Is(err, ErrExists) {
		t.Fatalf("second load: %v, want ErrExists", err)
	}
	if err := m.DB.InsertSession(ctx, &store.SessionRow{Name: "u_t_s_3", Box: "other-box", Config: `{}`, Desired: "running"}); err != nil {
		t.Fatal(err)
	}
	var bad BadRequest
	if _, err := m.LoadAdopted(ctx, "u_t_s_3"); !errors.As(err, &bad) {
		t.Fatalf("other box: %v, want BadRequest", err)
	}
	if _, err := m.Get("u_t_s_3"); !errors.Is(err, ErrNotFound) {
		t.Fatal("another box's session was registered")
	}
	if _, err := m.LoadAdopted(ctx, "u_t_s_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}
