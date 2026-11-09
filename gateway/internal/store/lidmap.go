package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"

	"go.mau.fi/util/dbutil"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

// BoundedLIDMap is whatsmeow's PN↔LID store with a bounded cache. whatsmeow's CachedLIDMap is shared by every
// account in the container and keeps every pair (and every miss) in memory forever, which grows with the number of
// accounts times their contacts. This one keeps at most about max entries per direction in two generations: when the
// current one is full it becomes the old one and a fresh one starts; hits in the old one move back. The SQL and the
// write semantics are whatsmeow's, through the same dbutil wrapper, so writes join whatsmeow's transactions.
type BoundedLIDMap struct {
	db  *dbutil.Database
	max int

	mu                sync.Mutex
	pn2lid, pn2lidOld map[string]string
	lid2pn, lid2pnOld map[string]string
}

var _ store.LIDStore = (*BoundedLIDMap)(nil)

func NewBoundedLIDMap(db *dbutil.Database, max int) *BoundedLIDMap {
	if max < 1000 {
		max = 1000
	}
	return &BoundedLIDMap{db: db, max: max, pn2lid: map[string]string{}, lid2pn: map[string]string{}}
}

// get looks a key up in both generations, promoting an old hit. Caller holds mu.
func get(cur, old *map[string]string, k string) (string, bool) {
	if v, ok := (*cur)[k]; ok {
		return v, true
	}
	if v, ok := (*old)[k]; ok {
		(*cur)[k] = v
		return v, true
	}
	return "", false
}

// set stores k=v, rotating generations when full. Caller holds mu.
func (s *BoundedLIDMap) set(cur, old *map[string]string, k, v string) {
	if len(*cur) >= s.max/2 {
		*old = *cur
		*cur = make(map[string]string, s.max/4)
	}
	(*cur)[k] = v
}

func (s *BoundedLIDMap) del(cur, old *map[string]string, k string) {
	delete(*cur, k)
	if *old != nil {
		delete(*old, k)
	}
}

// Len is the number of cached entries (both directions, both generations), for metrics.
func (s *BoundedLIDMap) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pn2lid) + len(s.pn2lidOld) + len(s.lid2pn) + len(s.lid2pnOld)
}

func (s *BoundedLIDMap) lookup(ctx context.Context, src types.JID, targetServer, query string, toLID bool) (types.JID, error) {
	s.mu.Lock()
	var v string
	var ok bool
	if toLID {
		v, ok = get(&s.pn2lid, &s.pn2lidOld, src.User)
	} else {
		v, ok = get(&s.lid2pn, &s.lid2pnOld, src.User)
	}
	s.mu.Unlock()
	if !ok {
		err := s.db.QueryRow(ctx, query, src.User).Scan(&v)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return types.JID{}, err
		}
		s.mu.Lock()
		// A concurrent Put may have cached a fresher answer while we queried: keep it.
		if toLID {
			if cached, ok := get(&s.pn2lid, &s.pn2lidOld, src.User); ok {
				v = cached
			} else {
				s.set(&s.pn2lid, &s.pn2lidOld, src.User, v)
				if v != "" {
					s.set(&s.lid2pn, &s.lid2pnOld, v, src.User)
				}
			}
		} else {
			if cached, ok := get(&s.lid2pn, &s.lid2pnOld, src.User); ok {
				v = cached
			} else {
				s.set(&s.lid2pn, &s.lid2pnOld, src.User, v)
				if v != "" {
					s.set(&s.pn2lid, &s.pn2lidOld, v, src.User)
				}
			}
		}
		s.mu.Unlock()
	}
	if v == "" {
		return types.JID{}, nil
	}
	return types.JID{User: v, Device: src.Device, Server: targetServer}, nil
}

func (s *BoundedLIDMap) GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error) {
	if pn.Server != types.DefaultUserServer {
		return types.JID{}, fmt.Errorf("invalid GetLIDForPN call with non-PN JID %s", pn)
	}
	return s.lookup(ctx, pn, types.HiddenUserServer, `SELECT lid FROM whatsmeow_lid_map WHERE pn=$1`, true)
}

func (s *BoundedLIDMap) GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error) {
	if lid.Server != types.HiddenUserServer {
		return types.JID{}, fmt.Errorf("invalid GetPNForLID call with non-LID JID %s", lid)
	}
	return s.lookup(ctx, lid, types.DefaultUserServer, `SELECT pn FROM whatsmeow_lid_map WHERE lid=$1`, false)
}

func (s *BoundedLIDMap) GetManyLIDsForPNs(ctx context.Context, pns []types.JID) (map[types.JID]types.JID, error) {
	if len(pns) == 0 {
		return nil, nil
	}
	out := make(map[types.JID]types.JID, len(pns))
	for _, pn := range pns {
		if pn.Server != types.DefaultUserServer {
			continue
		}
		lid, err := s.GetLIDForPN(ctx, pn)
		if err != nil {
			return out, err
		}
		if !lid.IsEmpty() {
			out[pn] = lid
		}
	}
	return out, nil
}

func (s *BoundedLIDMap) PutLIDMapping(ctx context.Context, lid, pn types.JID) error {
	return s.PutManyLIDMappings(ctx, []store.LIDMapping{{LID: lid, PN: pn}})
}

func (s *BoundedLIDMap) PutManyLIDMappings(ctx context.Context, mappings []store.LIDMapping) error {
	var todo []store.LIDMapping
	seen := map[string]int{}
	s.mu.Lock()
	for _, m := range mappings {
		if m.LID.Server != types.HiddenUserServer || m.PN.Server != types.DefaultUserServer {
			continue
		}
		if v, ok := get(&s.pn2lid, &s.pn2lidOld, m.PN.User); ok && v == m.LID.User {
			continue
		}
		if i, ok := seen[m.PN.User]; ok {
			todo[i] = m // the last one wins, as whatsmeow's DeduplicateUnsortedOverwrite
			continue
		}
		seen[m.PN.User] = len(todo)
		todo = append(todo, m)
	}
	s.mu.Unlock()
	if len(todo) == 0 {
		return nil
	}
	err := s.db.DoTxn(ctx, nil, func(ctx context.Context) error {
		for _, m := range todo {
			if _, err := s.db.Exec(ctx, `DELETE FROM whatsmeow_lid_map WHERE (lid<>$1 AND pn=$2)`, m.LID.User, m.PN.User); err != nil {
				return err
			}
			if _, err := s.db.Exec(ctx, `INSERT INTO whatsmeow_lid_map (lid, pn) VALUES ($1, $2)
				ON CONFLICT (lid) DO UPDATE SET pn=excluded.pn WHERE whatsmeow_lid_map.pn<>excluded.pn`, m.LID.User, m.PN.User); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.mu.Lock()
	for _, m := range todo {
		oldLID, _ := get(&s.pn2lid, &s.pn2lidOld, m.PN.User)
		oldPN, _ := get(&s.lid2pn, &s.lid2pnOld, m.LID.User)
		s.set(&s.pn2lid, &s.pn2lidOld, m.PN.User, m.LID.User)
		s.set(&s.lid2pn, &s.lid2pnOld, m.LID.User, m.PN.User)
		if oldPN != "" && oldPN != m.PN.User {
			if v, _ := get(&s.pn2lid, &s.pn2lidOld, oldPN); v == m.LID.User {
				s.del(&s.pn2lid, &s.pn2lidOld, oldPN)
			}
		}
		if oldLID != "" && oldLID != m.LID.User {
			if v, _ := get(&s.lid2pn, &s.lid2pnOld, oldLID); v == m.PN.User {
				s.del(&s.lid2pn, &s.lid2pnOld, oldLID)
			}
		}
	}
	s.mu.Unlock()
	return nil
}
