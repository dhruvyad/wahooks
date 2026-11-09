package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// fakeIdentities behaves like sqlstore's identity table and counts writes.
type fakeIdentities struct {
	rows    map[string][32]byte
	writes  int
	trusted int
	failPut bool
}

func (f *fakeIdentities) PutIdentity(_ context.Context, a string, k [32]byte) error {
	if f.failPut {
		return errors.New("db down")
	}
	f.writes++
	f.rows[a] = k
	return nil
}
func (f *fakeIdentities) DeleteAllIdentities(_ context.Context, phone string) error {
	for a := range f.rows {
		if len(a) > len(phone) && a[:len(phone)+1] == phone+":" {
			delete(f.rows, a)
		}
	}
	return nil
}
func (f *fakeIdentities) DeleteIdentity(_ context.Context, a string) error { delete(f.rows, a); return nil }
func (f *fakeIdentities) IsTrustedIdentity(_ context.Context, a string, k [32]byte) (bool, error) {
	f.trusted++
	cur, ok := f.rows[a]
	return !ok || cur == k, nil
}

type fakeSessions struct {
	store.SessionStore
	ids *fakeIdentities
}

func (f fakeSessions) MigratePNToLID(_ context.Context, pn, lid types.JID) error {
	// like sqlstore: copy the PN's identity rows to the LID address (overwriting), then delete the PN rows
	for a, k := range f.ids.rows {
		if len(a) > len(pn.User) && a[:len(pn.User)+1] == pn.User+":" {
			f.ids.rows[lid.User+a[len(pn.User):]] = k
			delete(f.ids.rows, a)
		}
	}
	return nil
}

func TestIdentityCache(t *testing.T) {
	ctx := context.Background()
	inner := &fakeIdentities{rows: map[string][32]byte{}}
	c := NewIdentityCache(inner, 4)
	k1, k2 := [32]byte{1}, [32]byte{2}
	a := "111_1:0"

	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.PutIdentity(ctx, a, k1))
	must(c.PutIdentity(ctx, a, k1))
	if inner.writes != 1 {
		t.Fatalf("unchanged key written again: %d writes", inner.writes)
	}
	must(c.PutIdentity(ctx, a, k2))
	if inner.writes != 2 || inner.rows[a] != k2 {
		t.Fatalf("changed key not written: %d", inner.writes)
	}

	// Trust checks go to the store, exactly as before.
	for _, tc := range []struct {
		k    [32]byte
		want bool
	}{{k2, true}, {k1, false}} {
		got, err := c.IsTrustedIdentity(ctx, a, tc.k)
		if err != nil || got != tc.want {
			t.Fatalf("IsTrustedIdentity = %v, %v; want %v", got, err, tc.want)
		}
	}
	if ok, _ := c.IsTrustedIdentity(ctx, "unknown:0", k1); !ok || inner.trusted != 3 {
		t.Fatalf("unknown address must be trusted (TOFU) via the store")
	}

	// Delete invalidates: the next save of the same key writes.
	must(c.DeleteIdentity(ctx, a))
	must(c.PutIdentity(ctx, a, k2))
	if inner.writes != 3 || inner.rows[a] != k2 {
		t.Fatalf("save after delete skipped")
	}

	// DeleteAll for the user invalidates its addresses only.
	b := "222_1:3"
	must(c.PutIdentity(ctx, b, k1))
	must(c.DeleteAllIdentities(ctx, "111_1"))
	w := inner.writes
	must(c.PutIdentity(ctx, a, k2))
	must(c.PutIdentity(ctx, b, k1))
	if inner.writes != w+1 {
		t.Fatalf("delete-all: want exactly one rewrite (a), got %d", inner.writes-w)
	}

	// A failed write is not cached.
	inner.failPut = true
	if err := c.PutIdentity(ctx, "333:0", k1); err == nil {
		t.Fatal("expected error")
	}
	inner.failPut = false
	w = inner.writes
	must(c.PutIdentity(ctx, "333:0", k1))
	if inner.writes != w+1 {
		t.Fatal("failed write was cached")
	}

	// Bounded.
	for i := 0; i < 50; i++ {
		must(c.PutIdentity(ctx, fmt.Sprintf("u%d:0", i), k1))
	}
	if c.Len() > 4 {
		t.Fatalf("cache unbounded: %d", c.Len())
	}
	for i := 0; i < 50; i++ { // evicted or not, the store always ends up with the right key
		must(c.PutIdentity(ctx, fmt.Sprintf("u%d:0", i), k2))
		if inner.rows[fmt.Sprintf("u%d:0", i)] != k2 {
			t.Fatalf("u%d not updated", i)
		}
	}
}

func TestIdentityCacheMigration(t *testing.T) {
	ctx := context.Background()
	inner := &fakeIdentities{rows: map[string][32]byte{}}
	dev := &store.Device{Identities: inner, Sessions: fakeSessions{ids: inner}}
	c := UseIdentityCache(dev, 16)
	pn := types.NewJID("555", types.DefaultUserServer)
	lid := types.NewJID("777", types.HiddenUserServer)
	kOld, kPN := [32]byte{9}, [32]byte{5}
	// The LID address was saved with kOld; then the PN address with kPN; migration overwrites the LID row with kPN.
	if err := dev.Identities.PutIdentity(ctx, "777:0", kOld); err != nil {
		t.Fatal(err)
	}
	if err := dev.Identities.PutIdentity(ctx, "555:0", kPN); err != nil {
		t.Fatal(err)
	}
	if err := dev.Sessions.MigratePNToLID(ctx, pn, lid); err != nil {
		t.Fatal(err)
	}
	if inner.rows["777:0"] != kPN {
		t.Fatal("fake migration did not overwrite")
	}
	// Saving kOld again must reach the database (the cache was invalidated by the migration).
	if err := dev.Identities.PutIdentity(ctx, "777:0", kOld); err != nil {
		t.Fatal(err)
	}
	if inner.rows["777:0"] != kOld {
		t.Fatal("stale cache skipped a needed write after MigratePNToLID")
	}
	if c.Len() == 0 {
		t.Fatal("cache not repopulated")
	}
}
