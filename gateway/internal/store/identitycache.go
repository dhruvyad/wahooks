package store

import (
	"context"
	"strings"
	"sync"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// IdentityCache wraps one device's whatsmeow IdentityStore so that saving an identity key that is already stored
// writes nothing. libsignal calls SaveIdentity on every decrypted message and whatsmeow upserts the unchanged
// 32-byte key each time: half of whatsmeow's store writes per received message (bench/density/RESULTS.md §3).
//
// Exactness: an entry is only added after the inner write succeeds, and it is dropped by DeleteIdentity,
// DeleteAllIdentities and (through WrapSessions) MigratePNToLID, the one whatsmeow path that rewrites identity rows
// without going through this store. A cached entry therefore always equals the row in the database, so skipping
// the write leaves the database exactly as before. IsTrustedIdentity is passed through unchanged.
// The cache is per device, allocated on first write and bounded (an arbitrary entry is evicted when full).
type IdentityCache struct {
	store.IdentityStore
	mu   sync.Mutex
	max  int
	keys map[string][32]byte
}

func NewIdentityCache(inner store.IdentityStore, max int) *IdentityCache {
	if max <= 0 {
		max = 128
	}
	return &IdentityCache{IdentityStore: inner, max: max}
}

func (c *IdentityCache) PutIdentity(ctx context.Context, address string, key [32]byte) error {
	// The lock covers the write too, so two concurrent saves of different keys cannot leave the cache disagreeing
	// with the database. Identity writes per device are rare once deduplicated.
	c.mu.Lock()
	defer c.mu.Unlock()
	if k, ok := c.keys[address]; ok && k == key {
		return nil
	}
	if err := c.IdentityStore.PutIdentity(ctx, address, key); err != nil {
		delete(c.keys, address)
		return err
	}
	if c.keys == nil {
		c.keys = make(map[string][32]byte)
	}
	if _, ok := c.keys[address]; !ok && len(c.keys) >= c.max {
		for k := range c.keys {
			delete(c.keys, k)
			break
		}
	}
	c.keys[address] = key
	return nil
}

func (c *IdentityCache) DeleteIdentity(ctx context.Context, address string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.keys, address)
	return c.IdentityStore.DeleteIdentity(ctx, address)
}

func (c *IdentityCache) DeleteAllIdentities(ctx context.Context, phone string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropUserLocked(phone)
	return c.IdentityStore.DeleteAllIdentities(ctx, phone)
}

// dropUserLocked forgets every address of a Signal user ("user:device" addresses, as sqlstore matches them).
func (c *IdentityCache) dropUserLocked(user string) {
	for k := range c.keys {
		if strings.HasPrefix(k, user+":") {
			delete(c.keys, k)
		}
	}
}

// Forget drops everything (used when whatsmeow rewrites identity rows behind the store).
func (c *IdentityCache) Forget() {
	c.mu.Lock()
	c.keys = nil
	c.mu.Unlock()
}

// Len is the number of cached entries (tests, metrics).
func (c *IdentityCache) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.keys)
}

// sessionsWithIdentityCache invalidates the identity cache when whatsmeow migrates a contact's Signal state from
// its phone-number address to its LID address (sqlstore rewrites identity rows directly in that migration).
type sessionsWithIdentityCache struct {
	store.SessionStore
	ids *IdentityCache
}

func (s sessionsWithIdentityCache) MigratePNToLID(ctx context.Context, pn, lid types.JID) error {
	err := s.SessionStore.MigratePNToLID(ctx, pn, lid)
	s.ids.Forget()
	return err
}

// UseIdentityCache installs an IdentityCache on an initialised device (call before the client connects).
func UseIdentityCache(dev *store.Device, max int) *IdentityCache {
	if dev == nil || dev.Identities == nil || dev.Sessions == nil {
		return nil
	}
	c := NewIdentityCache(dev.Identities, max)
	dev.Identities = c
	dev.Sessions = sessionsWithIdentityCache{SessionStore: dev.Sessions, ids: c}
	return c
}
