// Package convert writes a WAHA NOWEB (Baileys) device into a whatsmeow sqlstore.
package convert

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"go.mau.fi/util/dbutil"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/store/sqlstore/upgrades"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/keys"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/migrate/internal/wahaauth"
)

// Drop reasons that are expected in healthy data (see ExpectedDrop).
const (
	ReasonSuperseded     = "superseded by the LID-addressed row Baileys uses"
	ReasonStaleIdentity  = "stale: identity changed"
	ReasonNoOpenSession  = "no open session (unusable in Baileys too)"
	ReasonNoSendingChain = "no sending chain (unusable in Baileys too)"
)

// ExpectedDrop reports whether a dropped key is expected in healthy WAHA data: rows Baileys
// itself no longer uses, and kinds whatsmeow has no place for. Anything else means something
// that matters did not convert.
func ExpectedDrop(category, reason string) bool {
	switch category {
	case "device-list", "sender-key-memory":
		return true
	case "tctoken":
		return reason == "Baileys index row" || reason == "cleared token" || reason == "no timestamp (expired for Baileys)"
	case "session":
		return reason == ReasonSuperseded || reason == ReasonStaleIdentity || reason == ReasonNoOpenSession || reason == ReasonNoSendingChain
	case "identity-key", "sender-key":
		return reason == ReasonSuperseded
	case "lid_map (store)":
		return reason == "already known from auth rows"
	case "contact (store)":
		return reason == "not a user JID" // groups and broadcast lists also live in WAHA's contacts table
	}
	return false
}

// Options select what to convert.
type Options struct {
	// Replace deletes an existing device with the same JID in the target first.
	Replace bool
	// SkipSessions drops Signal sessions and identities (peers re-establish them through
	// retry receipts). SkipSenderKeys drops group sender keys.
	SkipSessions   bool
	SkipSenderKeys bool
	// AppStateKeysOnly imports app-state sync keys but not collection versions, so the
	// gateway does a full app-state resync instead of continuing from WAHA's LTHash.
	AppStateKeysOnly bool
	// SkipMainDeviceSession drops the session with our own primary device (<me>.0), which
	// WAHA never reads back (NoWebPsqlAuth.isMyMainSession) — mirror WAHA if needed.
	SkipMainDeviceSession bool
	// PushName / BusinessName override creds.me.name.
	PushName     string
	BusinessName string
	// ShowIDs prints JIDs unmasked in the report.
	ShowIDs bool
	Log     waLog.Logger
}

// Category counts one kind of key.
type Category struct {
	Found     int            `json:"found"`
	Converted int            `json:"converted"`
	Dropped   int            `json:"dropped"`
	Reasons   map[string]int `json:"reasons,omitempty"`
}

func (c *Category) drop(reason string) {
	c.Dropped++
	if c.Reasons == nil {
		c.Reasons = map[string]int{}
	}
	c.Reasons[reason]++
}

// Report describes a conversion. It never contains key material.
type Report struct {
	JID            string               `json:"jid"`
	LID            string               `json:"lid"`
	Platform       string               `json:"platform"`
	PushNameSet    bool                 `json:"push_name_set"`
	RegistrationID uint32               `json:"registration_id"`
	SignedPreKeyID uint32               `json:"signed_pre_key_id"`
	NextPreKeyID   uint32               `json:"next_pre_key_id"`
	Rows           int                  `json:"rows"`
	Categories     map[string]*Category `json:"categories"`
	Warnings       []string             `json:"warnings,omitempty"`
}

func (r *Report) cat(name string) *Category {
	c, ok := r.Categories[name]
	if !ok {
		c = &Category{}
		r.Categories[name] = c
	}
	return c
}

func (r *Report) warnf(format string, args ...any) {
	r.Warnings = append(r.Warnings, fmt.Sprintf(format, args...))
}

// Target is an opened whatsmeow store.
type Target struct {
	DB        *dbutil.Database
	Container *sqlstore.Container
}

// OpenTarget opens (and creates or upgrades) a whatsmeow store. Dialect is "sqlite" or
// "postgres"; the caller registers the driver.
func OpenTarget(ctx context.Context, driver, dialect, dsn string, log waLog.Logger) (*Target, error) {
	raw, err := sql.Open(driver, dsn)
	if err != nil {
		return nil, err
	}
	return wrapTarget(ctx, raw, dialect, log)
}

// OpenMemoryTarget is a throwaway in-memory SQLite store (nothing touches the disk).
func OpenMemoryTarget(ctx context.Context) (*Target, error) {
	raw, err := sql.Open("sqlite", "file:waha2meow-check?mode=memory&cache=shared&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	raw.SetMaxOpenConns(1) // one connection keeps the one in-memory database alive
	return wrapTarget(ctx, raw, "sqlite3", nil)
}

func wrapTarget(ctx context.Context, raw *sql.DB, dialect string, log waLog.Logger) (*Target, error) {
	db, err := dbutil.NewWithDB(raw, dialect)
	if err != nil {
		return nil, err
	}
	db.UpgradeTable = upgrades.Table
	db.VersionTable = "whatsmeow_version"
	if log == nil {
		log = waLog.Noop
	}
	c := sqlstore.NewWithWrappedDB(db, log)
	if err := c.Upgrade(ctx); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("upgrade whatsmeow schema: %w", err)
	}
	return &Target{DB: db, Container: c}, nil
}

func (t *Target) Close() error { return t.Container.Close() }

// ErrDeviceExists is returned when the target already holds this device.
var ErrDeviceExists = errors.New("the target store already has this device (use --replace to overwrite it)")

// Convert writes the device and its keys in one transaction.
func Convert(ctx context.Context, st *wahaauth.AuthState, t *Target, opt Options) (*Report, error) {
	mask := Mask
	if opt.ShowIDs {
		mask = func(s string) string { return s }
	}
	f, err := DeviceFromCreds(st.Creds)
	if err != nil {
		return nil, err
	}
	if opt.PushName != "" {
		f.PushName = opt.PushName
	}
	if opt.BusinessName != "" {
		f.BusinessName = opt.BusinessName
	}
	rep := &Report{
		JID:            mask(f.ID.String()),
		LID:            mask(f.LID.String()),
		Platform:       f.Platform,
		PushNameSet:    f.PushName != "",
		RegistrationID: f.RegistrationID,
		SignedPreKeyID: f.SignedPreKey.KeyID,
		NextPreKeyID:   st.Creds.NextPreKeyID,
		Rows:           st.RowCount,
		Categories:     map[string]*Category{},
	}
	if f.LID.IsEmpty() {
		rep.warnf("creds.me.lid is empty; whatsmeow learns the LID on connect, but LID-addressed groups will not work until then")
	}
	if f.PushName == "" {
		rep.warnf("no push name in creds.me.name: pass --push-name, or presence updates will fail until app state delivers it")
	}
	for _, p := range st.Problems {
		rep.cat(p.Category).Found++
		rep.cat(p.Category).drop("unreadable row")
		rep.warnf("row %s unreadable: %v", mask(p.ID), p.Err)
	}

	existing, err := t.Container.GetDevice(ctx, f.ID)
	if err != nil {
		return nil, fmt.Errorf("check target for existing device: %w", err)
	}
	if existing != nil && !opt.Replace {
		return nil, ErrDeviceExists
	}

	err = t.DB.DoTxn(ctx, nil, func(ctx context.Context) error {
		if existing != nil {
			if err := t.Container.DeleteDevice(ctx, existing); err != nil {
				return fmt.Errorf("delete existing device: %w", err)
			}
		}
		dev := t.Container.NewDevice()
		f.Apply(dev)
		if err := t.Container.PutDevice(ctx, dev); err != nil {
			return fmt.Errorf("write device: %w", err)
		}
		return writeKeys(ctx, st, f, dev, t, opt, rep, mask)
	})
	if err != nil {
		return nil, err
	}
	return rep, nil
}

func writeKeys(ctx context.Context, st *wahaauth.AuthState, f *DeviceFields, dev *store.Device, t *Target, opt Options, rep *Report, mask func(string) string) error {
	jid := f.ID.String()

	// ---- our own account: what whatsmeow's handlePair stores --------------------------
	if !f.LID.IsEmpty() {
		if err := dev.LIDs.PutLIDMapping(ctx, f.LID.ToNonAD(), f.ID.ToNonAD()); err != nil {
			return fmt.Errorf("own LID mapping: %w", err)
		}
		mainLID := f.LID.ToNonAD()
		if err := dev.Identities.PutIdentity(ctx, mainLID.SignalAddress().String(), *(*[32]byte)(f.Account.AccountSignatureKey)); err != nil {
			return fmt.Errorf("primary device identity: %w", err)
		}
	}

	// ---- pre-keys --------------------------------------------------------------------
	pk := rep.cat("pre-key")
	ids := make([]uint32, 0, len(st.PreKeys))
	for id := range st.PreKeys {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	var maxID uint32
	for _, id := range ids {
		pk.Found++
		if id == 0 || id >= 1<<24 {
			pk.drop("id out of range")
			continue
		}
		kp, err := keyPair(st.PreKeys[id], "pre-key")
		if err != nil {
			pk.drop("bad key")
			rep.warnf("pre-key %d: %v", id, err)
			continue
		}
		// Baileys uploads every key below firstUnuploadedPreKeyId (Utils/signal.ts getNextPreKeys).
		uploaded := id < st.Creds.FirstUnuploadedPreKeyID
		if _, err := t.DB.Exec(ctx, `INSERT INTO whatsmeow_pre_keys (jid, key_id, key, uploaded) VALUES ($1, $2, $3, $4)`, jid, id, kp.Priv[:], uploaded); err != nil {
			return fmt.Errorf("pre-key %d: %w", id, err)
		}
		pk.Converted++
		maxID = max(maxID, id)
	}
	// whatsmeow numbers new pre-keys MAX(key_id)+1. Make sure that never reuses an id Baileys
	// already handed to the server (rows can be missing, e.g. after a failed write).
	if next := st.Creds.NextPreKeyID; next > 1 && maxID < next-1 && next-1 < 1<<24 {
		filler := keys.NewKeyPair()
		if _, err := t.DB.Exec(ctx, `INSERT INTO whatsmeow_pre_keys (jid, key_id, key, uploaded) VALUES ($1, $2, $3, true)`, jid, next-1, filler.Priv[:]); err != nil {
			return fmt.Errorf("pre-key id floor: %w", err)
		}
		rep.warnf("pre-keys %d..%d are missing from the export; reserved id %d so whatsmeow continues at %d", maxID+1, next-1, next-1, next)
	}

	// ---- identities and sessions -----------------------------------------------------
	// Once Baileys knows a user's LID it reads and writes only the LID-addressed rows
	// (resolveLIDSignalAddress); its migrateSession "deletes" the phone-number row, which WAHA
	// ignores. Such a stale row must not survive: whatsmeow's MigratePNToLID would copy it over
	// the live LID row (ON CONFLICT DO UPDATE) the first time it meets that contact.
	lidForPN := LIDPairs(st)
	if !f.LID.IsEmpty() {
		lidForPN[f.ID.User] = f.LID.User
	}
	const superseded = ReasonSuperseded
	local33 := append([]byte{0x05}, f.IdentityKey.Pub[:]...)
	idc := rep.cat("identity-key")
	identities := map[string][32]byte{}
	for addr, key := range st.IdentityKeys {
		idc.Found++
		if opt.SkipSessions {
			idc.drop("skipped by option")
			continue
		}
		if lid := LIDAddress(addr, lidForPN); lid != "" {
			if _, ok := st.IdentityKeys[lid]; ok {
				idc.drop(superseded)
				continue
			}
		}
		maddr, err := SignalAddress(addr)
		if err != nil {
			idc.drop("bad address")
			continue
		}
		k, err := key.PublicKey32("identity-key")
		if err != nil {
			idc.drop("bad key")
			continue
		}
		identities[maddr] = *k
	}
	sc := rep.cat("session")
	mainSession := ""
	if opt.SkipMainDeviceSession {
		mainSession = f.ID.User + ".0"
	}
	sessions := map[string][]byte{}
	derived := map[string]bool{}
	addrs := sortedKeys(st.Sessions)
	for _, addr := range addrs {
		rec := st.Sessions[addr]
		sc.Found++
		if opt.SkipSessions {
			sc.drop("skipped by option")
			continue
		}
		if addr == mainSession {
			sc.drop("own primary device (skipped by option)")
			continue
		}
		if lid := LIDAddress(addr, lidForPN); lid != "" {
			if _, ok := st.Sessions[lid]; ok {
				sc.drop(superseded)
				continue
			}
		}
		maddr, err := SignalAddress(addr)
		if err != nil {
			sc.drop("bad address")
			continue
		}
		res, err := ConvertSession(rec, local33, f.RegistrationID)
		if err != nil {
			switch {
			case errors.Is(err, ErrNoOpenSession):
				sc.drop(ReasonNoOpenSession)
			case errors.Is(err, ErrNoSendingChain):
				sc.drop(ReasonNoSendingChain)
			default:
				sc.drop(firstWords(err.Error()))
			}
			rep.warnf("session %s dropped: %v", mask(addr), err)
			continue
		}
		remote := *(*[32]byte)(res.RemoteIdentity[1:])
		if known, ok := identities[maddr]; ok && known != remote {
			// Baileys saw a new identity and cleared the session, but WAHA ignores deletes,
			// so the stale row survived. Keep the identity, drop the session.
			sc.drop(ReasonStaleIdentity)
			continue
		}
		if _, ok := identities[maddr]; !ok {
			// No identity-key row (older Baileys did not write them): take it from the session.
			identities[maddr] = remote
			derived[maddr] = true
		}
		sessions[maddr] = res.Serialized
		if res.DroppedChains > 0 || res.DroppedEntries > 0 {
			rep.warnf("session %s: kept %d previous states, dropped %d old states and %d old receiving chains (go-libsignal limits)",
				mask(addr), res.PreviousStates, res.DroppedEntries, res.DroppedChains)
		}
		sc.Converted++
	}
	if len(sessions) > 0 {
		if err := dev.Sessions.PutManySessions(ctx, sessions); err != nil {
			return fmt.Errorf("sessions: %w", err)
		}
	}
	for _, addr := range sortedKeys(identities) {
		if err := dev.Identities.PutIdentity(ctx, addr, identities[addr]); err != nil {
			return fmt.Errorf("identity %s: %w", mask(addr), err)
		}
		if derived[addr] {
			d := rep.cat("identity-key (from session)")
			d.Found++
			d.Converted++
		} else {
			idc.Converted++
		}
	}

	// ---- sender keys -----------------------------------------------------------------
	skc := rep.cat("sender-key")
	for _, name := range sortedKeys(st.SenderKeys) {
		skc.Found++
		if opt.SkipSenderKeys {
			skc.drop("skipped by option")
			continue
		}
		group, sender, err := SenderKeyName(name)
		if err != nil {
			skc.drop("bad name")
			continue
		}
		if lid := lidSenderKeyName(name, lidForPN); lid != "" {
			if _, ok := st.SenderKeys[lid]; ok {
				skc.drop(superseded)
				continue
			}
		}
		out, err := ConvertSenderKey(st.SenderKeys[name])
		if err != nil {
			skc.drop(firstWords(err.Error()))
			rep.warnf("sender key %s dropped: %v", mask(name), err)
			continue
		}
		if err := dev.SenderKeys.PutSenderKey(ctx, group, sender, out); err != nil {
			return fmt.Errorf("sender key: %w", err)
		}
		skc.Converted++
	}

	// ---- app state -------------------------------------------------------------------
	akc := rep.cat("app-state-sync-key")
	for _, id := range sortedKeys(st.AppStateSyncKeys) {
		k := st.AppStateSyncKeys[id]
		akc.Found++
		keyID, err := base64.StdEncoding.DecodeString(id)
		if err != nil || len(keyID) == 0 {
			akc.drop("bad key id")
			continue
		}
		if len(k.KeyData) != 32 {
			akc.drop("bad key data")
			continue
		}
		var fp []byte
		if k.Fingerprint != nil {
			fp, err = proto.Marshal(&waE2E.AppStateSyncKeyFingerprint{
				RawID:         proto.Uint32(k.Fingerprint.RawID),
				CurrentIndex:  proto.Uint32(k.Fingerprint.CurrentIndex),
				DeviceIndexes: k.Fingerprint.DeviceIndexes,
			})
			if err != nil {
				return err
			}
		}
		if err := dev.AppStateKeys.PutAppStateSyncKey(ctx, keyID, store.AppStateSyncKey{Data: k.KeyData, Fingerprint: fp, Timestamp: int64(k.Timestamp)}); err != nil {
			return fmt.Errorf("app state key: %w", err)
		}
		akc.Converted++
	}
	avc := rep.cat("app-state-sync-version")
	for _, name := range sortedKeys(st.AppStateVersions) {
		v := st.AppStateVersions[name]
		avc.Found++
		if opt.AppStateKeysOnly {
			avc.drop("skipped by option (full resync)")
			continue
		}
		if len(v.Hash) != 128 || v.Version <= 0 {
			avc.drop("bad hash or version")
			rep.warnf("app state %s: hash %d bytes, version %d; it will resync from scratch", name, len(v.Hash), v.Version)
			continue
		}
		macs := make([]store.AppStateMutationMAC, 0, len(v.IndexValueMap))
		bad := false
		for idx, val := range v.IndexValueMap {
			im, err := base64.StdEncoding.DecodeString(idx)
			if err != nil || len(im) != 32 || len(val.ValueMac) != 32 {
				bad = true
				break
			}
			macs = append(macs, store.AppStateMutationMAC{IndexMAC: im, ValueMAC: val.ValueMac})
		}
		if bad {
			avc.drop("bad mutation MACs")
			rep.warnf("app state %s: unreadable mutation MACs; it will resync from scratch", name)
			continue
		}
		version := uint64(v.Version)
		if err := dev.AppState.PutAppStateVersion(ctx, name, version, *(*[128]byte)(v.Hash)); err != nil {
			return fmt.Errorf("app state version %s: %w", name, err)
		}
		// Baileys does not record which patch set each value MAC; the collection version is
		// what whatsmeow orders by, and any version ≤ current is equivalent for lookups.
		for i := 0; i < len(macs); i += 500 {
			end := min(i+500, len(macs))
			if err := dev.AppState.PutAppStateMutationMACs(ctx, name, version, macs[i:end]); err != nil {
				return fmt.Errorf("app state MACs %s: %w", name, err)
			}
		}
		avc.Converted++
	}

	// ---- LID mappings ----------------------------------------------------------------
	lc := rep.cat("lid-mapping")
	pairs := LIDPairs(st)
	lc.Found = len(pairs)
	if len(st.StoreLIDForPN) > 0 {
		// WAHA's store keeps every mapping it saw (contact syncs, messages); the auth rows only
		// those Baileys' signal layer needed. Auth rows win; the store fills gaps, one-to-one.
		sc := rep.cat("lid_map (store)")
		usedLID := map[string]bool{}
		for _, lid := range pairs {
			usedLID[lid] = true
		}
		for _, pn := range sortedKeys(st.StoreLIDForPN) {
			lid := st.StoreLIDForPN[pn]
			sc.Found++
			if _, ok := pairs[pn]; ok || usedLID[lid] {
				sc.drop("already known from auth rows")
				continue
			}
			pairs[pn] = lid
			usedLID[lid] = true
			sc.Converted++
		}
	} // counted in PN↔LID pairs; each pair is two Baileys rows
	var mappings []store.LIDMapping
	for _, pn := range sortedKeys(pairs) {
		lid := pairs[pn]
		if !isDigits(pn) || !isDigits(lid) {
			lc.drop("not a user mapping")
			continue
		}
		mappings = append(mappings, store.LIDMapping{
			LID: types.JID{User: lid, Server: types.HiddenUserServer},
			PN:  types.JID{User: pn, Server: types.DefaultUserServer},
		})
	}
	if len(mappings) > 0 {
		if err := dev.LIDs.PutManyLIDMappings(ctx, mappings); err != nil {
			return fmt.Errorf("lid mappings: %w", err)
		}
	}
	lc.Converted = len(mappings)
	if st.StoreLIDForPN != nil {
		lc.Converted -= rep.cat("lid_map (store)").Converted
	}

	// ---- contacts (optional, from WAHA's store) -------------------------------------------
	if err := writeContacts(ctx, st, dev, rep); err != nil {
		return err
	}

	// ---- privacy tokens --------------------------------------------------------------
	tc := rep.cat("tctoken")
	var tokens []store.PrivacyToken
	for _, key := range sortedKeys(st.TCTokens) {
		tok := st.TCTokens[key]
		tc.Found++
		if key == "__index" {
			tc.drop("Baileys index row")
			continue
		}
		if len(tok.Token) == 0 {
			tc.drop("cleared token")
			continue
		}
		user, err := parseUserJID(key)
		if err != nil {
			tc.drop("bad jid")
			continue
		}
		if tok.Timestamp <= 0 {
			// Baileys' isTcTokenExpired(undefined) is true: it never sends such a token.
			tc.drop("no timestamp (expired for Baileys)")
			continue
		}
		pt := store.PrivacyToken{User: user.ToNonAD(), Token: tok.Token, Timestamp: unixish(int64(tok.Timestamp))}
		if tok.SenderTimestamp > 0 {
			pt.SenderTimestamp = unixish(int64(tok.SenderTimestamp))
		}
		tokens = append(tokens, pt)
		tc.Converted++
	}
	if len(tokens) > 0 {
		if err := dev.PrivacyTokens.PutPrivacyTokens(ctx, tokens...); err != nil {
			return fmt.Errorf("privacy tokens: %w", err)
		}
	}

	// ---- no whatsmeow equivalent ------------------------------------------------------
	for range st.DeviceLists {
		rep.cat("device-list").Found++
		rep.cat("device-list").drop("no whatsmeow equivalent (fetched by usync)")
	}
	for range st.SenderKeyMemory {
		rep.cat("sender-key-memory").Found++
		rep.cat("sender-key-memory").drop("no whatsmeow equivalent (it sends the SKDM with every group message)")
	}
	for cat, n := range st.Unknown {
		c := rep.cat(cat)
		c.Found += n
		for i := 0; i < n; i++ {
			c.drop("unknown category")
		}
	}
	return nil
}

func unixish(v int64) time.Time {
	switch {
	case v <= 0:
		return time.Time{}
	case v > 1e12:
		return time.UnixMilli(v)
	}
	return time.Unix(v, 0)
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func firstWords(s string) string {
	if i := strings.IndexByte(s, ':'); i > 0 {
		return s[:i]
	}
	return s
}

// LIDPairs merges Baileys' forward ("lid-mapping-<pn>") and reverse ("…_reverse") rows into
// one-to-one PN → LID pairs. WAHA never deletes a row, so after a mapping changes both rows may
// disagree: the forward row is what Baileys reads (getLIDForPN), so it wins, and a reverse row
// only fills in when neither its PN nor its LID is already taken.
func LIDPairs(st *wahaauth.AuthState) map[string]string {
	pairs := map[string]string{}
	usedLID := map[string]bool{}
	for pn, lid := range st.LIDForPN {
		pairs[pn] = lid
		usedLID[lid] = true
	}
	for _, lid := range sortedKeys(st.PNForLID) {
		pn := st.PNForLID[lid]
		if _, ok := pairs[pn]; ok || usedLID[lid] {
			continue
		}
		pairs[pn] = lid
		usedLID[lid] = true
	}
	return pairs
}

// writeContacts puts address-book names, push names and business names into whatsmeow's
// contact table. A contact known by LID with a phone number (or the reverse) is written under
// both JIDs. Duplicate JIDs are merged first: one Postgres INSERT … ON CONFLICT cannot touch a
// row twice.
func writeContacts(ctx context.Context, st *wahaauth.AuthState, dev *store.Device, rep *Report) error {
	if st.StoreContacts == nil {
		return nil
	}
	cc := rep.cat("contact (store)")
	type names struct{ full, push, biz string }
	byJID := map[types.JID]*names{}
	var order []types.JID
	add := func(raw string, c wahaauth.StoreContact, primary bool) {
		if raw == "" {
			return
		}
		j, err := types.ParseJID(raw)
		if err != nil || j.User == "" || (j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer) {
			return
		}
		j = j.ToNonAD()
		n, ok := byJID[j]
		if !ok {
			n = &names{}
			byJID[j] = n
			order = append(order, j)
		}
		// The row keyed by this JID wins over names copied from its LID/PN twin.
		if c.Name != "" && (primary || n.full == "") {
			n.full = c.Name
		}
		if c.Notify != "" && (primary || n.push == "") {
			n.push = c.Notify
		}
		if c.VerifiedName != "" && (primary || n.biz == "") {
			n.biz = c.VerifiedName
		}
	}
	for _, c := range st.StoreContacts {
		cc.Found++
		if j, err := types.ParseJID(c.ID); err != nil || j.User == "" || (j.Server != types.DefaultUserServer && j.Server != types.HiddenUserServer) {
			cc.drop("not a user JID")
			continue
		}
		add(c.ID, c, true)
		add(c.LID, c, false)
		add(c.PhoneNumber, c, false)
		cc.Converted++
	}
	var entries []store.ContactEntry
	for _, j := range order {
		n := byJID[j]
		if n.full != "" {
			entries = append(entries, store.ContactEntry{JID: j, FullName: n.full})
		}
	}
	if len(entries) > 0 {
		if err := dev.Contacts.PutAllContactNames(ctx, entries); err != nil {
			return fmt.Errorf("contact names: %w", err)
		}
	}
	for _, j := range order {
		n := byJID[j]
		if n.push != "" {
			if _, _, err := dev.Contacts.PutPushName(ctx, j, n.push); err != nil {
				return fmt.Errorf("push name: %w", err)
			}
		}
		if n.biz != "" {
			if _, _, err := dev.Contacts.PutBusinessName(ctx, j, n.biz); err != nil {
				return fmt.Errorf("business name: %w", err)
			}
		}
	}
	return nil
}
