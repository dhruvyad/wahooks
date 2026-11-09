// Package store opens the gateway's database (SQLite or Postgres, chosen by DSN) and holds the gateway's own
// tables next to whatsmeow's: session config, message history and chats. whatsmeow's sqlstore keeps every
// account's Signal state, contacts and LID map in one set of shared tables.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/util/dbutil"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/store/sqlstore/upgrades"
	waLog "go.mau.fi/whatsmeow/util/log"
	_ "modernc.org/sqlite"
)

type DB struct {
	SQL       *sql.DB
	Dialect   string // "sqlite" or "postgres"
	Container *sqlstore.Container
	Wrapped   *dbutil.Database // whatsmeow's wrapper of SQL (transactions travel in contexts)
	// LIDs is the PN↔LID store every device uses: whatsmeow's unbounded cache, or a BoundedLIDMap.
	LIDs store.LIDStore
}

// UseBoundedLIDMap swaps whatsmeow's shared LID cache for one holding about max entries per direction.
func (s *DB) UseBoundedLIDMap(max int) *BoundedLIDMap {
	b := NewBoundedLIDMap(s.Wrapped, max)
	s.LIDs = b
	return b
}

var ErrNotFound = errors.New("not found")
var ErrExists = errors.New("already exists")

// Open connects, runs whatsmeow's migrations and then the gateway's.
func Open(ctx context.Context, dialect, dsn string, maxConns int, log waLog.Logger) (*DB, error) {
	var (
		db  *sql.DB
		err error
	)
	switch dialect {
	case "sqlite":
		path := dsn
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		path = "file:" + path + sep + "_pragma=foreign_keys(1)&_pragma=busy_timeout(15000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_txlock=immediate"
		db, err = sql.Open("sqlite", path)
		if maxConns <= 0 {
			maxConns = 4
		}
	case "postgres":
		db, err = sql.Open("pgx", dsn)
		if maxConns <= 0 {
			// Reconnect storms are store-bound (a prekey count and a privacy-token sweep per login): 16 made a
			// 10,000-account restart 2.6x faster than database/sql's default pool (bench/density/RESULTS.md §4).
			maxConns = 16
		}
	default:
		return nil, fmt.Errorf("unknown dialect %q", dialect)
	}
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(maxConns)
	db.SetMaxIdleConns(maxConns)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("database unreachable: %w", err)
	}
	waDialect := "sqlite3"
	if dialect == "postgres" {
		waDialect = "postgres"
	}
	wrapped, err := dbutil.NewWithDB(db, waDialect)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	wrapped.UpgradeTable = upgrades.Table
	wrapped.VersionTable = "whatsmeow_version"
	container := sqlstore.NewWithWrappedDB(wrapped, log)
	if err := container.Upgrade(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("whatsmeow schema upgrade: %w", err)
	}
	s := &DB{SQL: db, Dialect: dialect, Container: container, Wrapped: wrapped, LIDs: container.LIDMap}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("gateway schema: %w", err)
	}
	return s, nil
}

func (s *DB) blob() string {
	if s.Dialect == "postgres" {
		return "BYTEA"
	}
	return "BLOB"
}

func (s *DB) migrate(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS gw_sessions (
			name        TEXT PRIMARY KEY,
			config      TEXT NOT NULL DEFAULT '{}',
			device_jid  TEXT NOT NULL DEFAULT '',
			src_ip      TEXT NOT NULL DEFAULT '',
			desired     TEXT NOT NULL DEFAULT 'stopped',
			owner       TEXT NOT NULL DEFAULT '',
			lease_until BIGINT NOT NULL DEFAULT 0,
			created_at  BIGINT NOT NULL,
			updated_at  BIGINT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS gw_messages (
			session    TEXT NOT NULL,
			chat       TEXT NOT NULL,
			id         TEXT NOT NULL,
			sender     TEXT NOT NULL DEFAULT '',
			sender_alt TEXT NOT NULL DEFAULT '',
			chat_alt   TEXT NOT NULL DEFAULT '',
			from_me    INTEGER NOT NULL DEFAULT 0,
			ts         BIGINT NOT NULL,
			push_name  TEXT NOT NULL DEFAULT '',
			kind       TEXT NOT NULL DEFAULT '',
			ack        INTEGER NOT NULL DEFAULT 0,
			source     TEXT NOT NULL DEFAULT '',
			msg        ` + s.blob() + `,
			PRIMARY KEY (session, chat, id)
		)`,
		`CREATE INDEX IF NOT EXISTS gw_messages_chat_ts ON gw_messages (session, chat, ts)`,
		`CREATE INDEX IF NOT EXISTS gw_messages_id ON gw_messages (session, id)`,
		`CREATE INDEX IF NOT EXISTS gw_messages_ts ON gw_messages (ts)`,
		`CREATE TABLE IF NOT EXISTS gw_chats (
			session       TEXT NOT NULL,
			chat          TEXT NOT NULL,
			name          TEXT NOT NULL DEFAULT '',
			last_ts       BIGINT NOT NULL DEFAULT 0,
			last_id       TEXT NOT NULL DEFAULT '',
			unread        INTEGER NOT NULL DEFAULT 0,
			read_upto     BIGINT NOT NULL DEFAULT 0,
			marked_unread INTEGER NOT NULL DEFAULT 0,
			archived      INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (session, chat)
		)`,
		`CREATE INDEX IF NOT EXISTS gw_chats_ts ON gw_chats (session, last_ts)`,
	}
	for _, q := range stmts {
		if _, err := s.SQL.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
	for _, c := range []struct{ table, col, def string }{
		{"gw_sessions", "box", "TEXT NOT NULL DEFAULT ''"},
	} {
		if ok, err := s.hasColumn(ctx, c.table, c.col); err != nil {
			return err
		} else if !ok {
			if _, err := s.SQL.ExecContext(ctx, "ALTER TABLE "+c.table+" ADD COLUMN "+c.col+" "+c.def); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *DB) hasColumn(ctx context.Context, table, col string) (bool, error) {
	var n int
	var err error
	if s.Dialect == "postgres" {
		err = s.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name=$1 AND column_name=$2`, table, col).Scan(&n)
	} else {
		err = s.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_info($1) WHERE name=$2`, table, col).Scan(&n)
	}
	return n > 0, err
}

func (s *DB) Close() error { return s.SQL.Close() }

// ---- sessions ----

type SessionRow struct {
	Name       string
	Box        string // the gateway box the API assigned it to (WAGW_BOX_ID); "" = any
	Config     string // WAHA session config JSON, as given at create
	DeviceJID  string // whatsmeow device JID once linked
	SrcIP      string // stable source address (empty = default routing)
	Desired    string // "running" or "stopped"
	Owner      string
	LeaseUntil int64
	CreatedAt  int64
	UpdatedAt  int64
}

const sessionCols = `name, config, device_jid, src_ip, desired, owner, lease_until, created_at, updated_at, box`

func scanSession(sc interface{ Scan(...any) error }) (*SessionRow, error) {
	var r SessionRow
	err := sc.Scan(&r.Name, &r.Config, &r.DeviceJID, &r.SrcIP, &r.Desired, &r.Owner, &r.LeaseUntil, &r.CreatedAt, &r.UpdatedAt, &r.Box)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &r, err
}

func (s *DB) ListSessions(ctx context.Context) ([]*SessionRow, error) {
	rows, err := s.SQL.QueryContext(ctx, `SELECT `+sessionCols+` FROM gw_sessions ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SessionRow
	for rows.Next() {
		r, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *DB) GetSession(ctx context.Context, name string) (*SessionRow, error) {
	return scanSession(s.SQL.QueryRowContext(ctx, `SELECT `+sessionCols+` FROM gw_sessions WHERE name=$1`, name))
}

func (s *DB) InsertSession(ctx context.Context, r *SessionRow) error {
	now := time.Now().Unix()
	r.CreatedAt, r.UpdatedAt = now, now
	res, err := s.SQL.ExecContext(ctx, `INSERT INTO gw_sessions (`+sessionCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (name) DO NOTHING`,
		r.Name, r.Config, r.DeviceJID, r.SrcIP, r.Desired, r.Owner, r.LeaseUntil, r.CreatedAt, r.UpdatedAt, r.Box)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrExists
	}
	return nil
}

func (s *DB) UpdateSession(ctx context.Context, name string, set map[string]any) error {
	if len(set) == 0 {
		return nil
	}
	var parts []string
	var args []any
	i := 1
	for k, v := range set {
		parts = append(parts, fmt.Sprintf("%s=$%d", k, i))
		args = append(args, v)
		i++
	}
	parts = append(parts, fmt.Sprintf("updated_at=$%d", i))
	args = append(args, time.Now().Unix(), name)
	_, err := s.SQL.ExecContext(ctx, `UPDATE gw_sessions SET `+strings.Join(parts, ", ")+fmt.Sprintf(` WHERE name=$%d`, i+1), args...)
	return err
}

func (s *DB) DeleteSession(ctx context.Context, name string) error {
	for _, q := range []string{
		`DELETE FROM gw_messages WHERE session=$1`,
		`DELETE FROM gw_chats WHERE session=$1`,
		`DELETE FROM gw_sessions WHERE name=$1`,
	} {
		if _, err := s.SQL.ExecContext(ctx, q, name); err != nil {
			return err
		}
	}
	return nil
}

// AcquireLease makes box the session's owner unless another box holds an unexpired lease.
func (s *DB) AcquireLease(ctx context.Context, name, box string, ttl time.Duration) (bool, string, error) {
	now := time.Now()
	res, err := s.SQL.ExecContext(ctx, `UPDATE gw_sessions SET owner=$1, lease_until=$2 WHERE name=$3 AND (owner='' OR owner=$1 OR lease_until < $4)`,
		box, now.Add(ttl).Unix(), name, now.Unix())
	if err != nil {
		return false, "", err
	}
	if n, _ := res.RowsAffected(); n == 1 {
		return true, box, nil
	}
	var owner string
	_ = s.SQL.QueryRowContext(ctx, `SELECT owner FROM gw_sessions WHERE name=$1`, name).Scan(&owner)
	return false, owner, nil
}

// RenewLeases extends every lease this box holds in one statement.
func (s *DB) RenewLeases(ctx context.Context, box string, ttl time.Duration) error {
	_, err := s.SQL.ExecContext(ctx, `UPDATE gw_sessions SET lease_until=$1 WHERE owner=$2`, time.Now().Add(ttl).Unix(), box)
	return err
}

func (s *DB) ReleaseLease(ctx context.Context, name, box string) error {
	_, err := s.SQL.ExecContext(ctx, `UPDATE gw_sessions SET owner='', lease_until=0 WHERE name=$1 AND owner=$2`, name, box)
	return err
}

// ---- messages ----

type MessageRow struct {
	Session   string
	Chat      string
	ID        string
	Sender    string
	SenderAlt string
	ChatAlt   string
	FromMe    bool
	TS        int64
	PushName  string
	Kind      string
	Ack       int
	Source    string
	Msg       []byte
}

const msgCols = `session, chat, id, sender, sender_alt, chat_alt, from_me, ts, push_name, kind, ack, source, msg`

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// PutMessage stores a message. replace=false keeps an existing row (history sync re-sending what we have).
func (s *DB) PutMessage(ctx context.Context, m *MessageRow, replace bool) error {
	q := `INSERT INTO gw_messages (` + msgCols + `) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (session, chat, id) DO `
	if replace {
		q += `UPDATE SET msg=excluded.msg, kind=excluded.kind, push_name=excluded.push_name, sender_alt=excluded.sender_alt, chat_alt=excluded.chat_alt`
	} else {
		q += `NOTHING`
	}
	_, err := s.SQL.ExecContext(ctx, q, m.Session, m.Chat, m.ID, m.Sender, m.SenderAlt, m.ChatAlt, b2i(m.FromMe), m.TS, m.PushName, m.Kind, m.Ack, m.Source, m.Msg)
	return err
}

func (s *DB) PutMessages(ctx context.Context, ms []*MessageRow) error {
	if len(ms) == 0 {
		return nil
	}
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO gw_messages (`+msgCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (session, chat, id) DO NOTHING`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, m := range ms {
		if _, err := stmt.ExecContext(ctx, m.Session, m.Chat, m.ID, m.Sender, m.SenderAlt, m.ChatAlt, b2i(m.FromMe), m.TS, m.PushName, m.Kind, m.Ack, m.Source, m.Msg); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpdateMessageBody replaces the stored content of a message (edits).
func (s *DB) UpdateMessageBody(ctx context.Context, session string, chats []string, id string, msg []byte) error {
	q, args := inClause(`UPDATE gw_messages SET msg=$1 WHERE session=$2 AND id=$3 AND chat IN (%s)`, 4, chats)
	_, err := s.SQL.ExecContext(ctx, q, append([]any{msg, session, id}, args...)...)
	return err
}

// RaiseAck sets ack for the given ids where it is lower.
func (s *DB) RaiseAck(ctx context.Context, session string, chats []string, ids []string, ack int) error {
	for _, id := range ids {
		q, args := inClause(`UPDATE gw_messages SET ack=$1 WHERE session=$2 AND id=$3 AND ack < $1 AND chat IN (%s)`, 4, chats)
		if _, err := s.SQL.ExecContext(ctx, q, append([]any{ack, session, id}, args...)...); err != nil {
			return err
		}
	}
	return nil
}

func inClause(q string, start int, vals []string) (string, []any) {
	ph := make([]string, len(vals))
	args := make([]any, len(vals))
	for i, v := range vals {
		ph[i] = fmt.Sprintf("$%d", start+i)
		args[i] = v
	}
	return fmt.Sprintf(q, strings.Join(ph, ",")), args
}

func scanMsg(sc interface{ Scan(...any) error }) (*MessageRow, error) {
	var m MessageRow
	var fromMe int
	err := sc.Scan(&m.Session, &m.Chat, &m.ID, &m.Sender, &m.SenderAlt, &m.ChatAlt, &fromMe, &m.TS, &m.PushName, &m.Kind, &m.Ack, &m.Source, &m.Msg)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	m.FromMe = fromMe == 1
	return &m, err
}

type MessageFilter struct {
	Limit, Offset int
	TSGte, TSLte  int64 // 0 = unset
	FromMe        *bool
	Ack           *int
}

// ListMessages returns a chat's messages newest first. chats lists the chat's equivalent JIDs (PN and LID).
func (s *DB) ListMessages(ctx context.Context, session string, chats []string, f MessageFilter) ([]*MessageRow, error) {
	q, args := inClause(`SELECT `+msgCols+` FROM gw_messages WHERE session=$1 AND chat IN (%s)`, 2, chats)
	args = append([]any{session}, args...)
	n := len(args) + 1
	if f.TSGte > 0 {
		q += fmt.Sprintf(" AND ts >= $%d", n)
		args = append(args, f.TSGte)
		n++
	}
	if f.TSLte > 0 {
		q += fmt.Sprintf(" AND ts <= $%d", n)
		args = append(args, f.TSLte)
		n++
	}
	if f.FromMe != nil {
		q += fmt.Sprintf(" AND from_me = $%d", n)
		args = append(args, b2i(*f.FromMe))
		n++
	}
	if f.Ack != nil {
		q += fmt.Sprintf(" AND ack = $%d", n)
		args = append(args, *f.Ack)
		n++
	}
	q += fmt.Sprintf(" ORDER BY ts DESC, id DESC LIMIT $%d OFFSET $%d", n, n+1)
	args = append(args, f.Limit, f.Offset)
	rows, err := s.SQL.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*MessageRow
	for rows.Next() {
		m, err := scanMsg(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetMessage finds a message by id, in the given chats if any.
func (s *DB) GetMessage(ctx context.Context, session string, chats []string, id string) (*MessageRow, error) {
	if len(chats) == 0 {
		return scanMsg(s.SQL.QueryRowContext(ctx, `SELECT `+msgCols+` FROM gw_messages WHERE session=$1 AND id=$2 ORDER BY ts DESC LIMIT 1`, session, id))
	}
	q, args := inClause(`SELECT `+msgCols+` FROM gw_messages WHERE session=$1 AND id=$2 AND chat IN (%s) ORDER BY ts DESC LIMIT 1`, 3, chats)
	return scanMsg(s.SQL.QueryRowContext(ctx, q, append([]any{session, id}, args...)...))
}

// UnreadIncoming lists incoming messages after the chat's read marker (for sendSeen without ids).
func (s *DB) UnreadIncoming(ctx context.Context, session string, chats []string, after int64, limit int) ([]*MessageRow, error) {
	q, args := inClause(`SELECT `+msgCols+` FROM gw_messages WHERE session=$1 AND from_me=0 AND ts > $2 AND chat IN (%s) ORDER BY ts DESC LIMIT `+fmt.Sprint(limit), 3, chats)
	rows, err := s.SQL.QueryContext(ctx, q, append([]any{session, after}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*MessageRow
	for rows.Next() {
		m, err := scanMsg(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// ---- chats ----

type ChatRow struct {
	Session      string
	Chat         string
	Name         string
	LastTS       int64
	LastID       string
	Unread       int
	ReadUpto     int64
	MarkedUnread bool
	Archived     bool
}

// TouchChat records a message in its chat: newer timestamps move last_ts/last_id; incoming ones count unread.
func (s *DB) TouchChat(ctx context.Context, session, chat string, ts int64, id string, incoming bool) error {
	inc := 0
	if incoming {
		inc = 1
	}
	_, err := s.SQL.ExecContext(ctx, touchChatQuery, session, chat, ts, id, inc)
	return err
}

const touchChatQuery = `INSERT INTO gw_chats (session, chat, last_ts, last_id, unread) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (session, chat) DO UPDATE SET
			last_id = CASE WHEN excluded.last_ts >= gw_chats.last_ts THEN excluded.last_id ELSE gw_chats.last_id END,
			last_ts = CASE WHEN excluded.last_ts >= gw_chats.last_ts THEN excluded.last_ts ELSE gw_chats.last_ts END,
			unread = CASE WHEN $5 = 1 AND excluded.last_ts > gw_chats.read_upto THEN gw_chats.unread + 1 WHEN $5 = 0 THEN 0 ELSE gw_chats.unread END`

// StoreLive writes a live message and moves its chat in one transaction: one commit per message instead of two
// (each commit is a WAL flush and, on Supabase, a network round trip).
func (s *DB) StoreLive(ctx context.Context, m *MessageRow, incoming bool) error {
	tx, err := s.SQL.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck
	if _, err := tx.ExecContext(ctx, `INSERT INTO gw_messages (`+msgCols+`) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		ON CONFLICT (session, chat, id) DO UPDATE SET msg=excluded.msg, kind=excluded.kind, push_name=excluded.push_name, sender_alt=excluded.sender_alt, chat_alt=excluded.chat_alt`,
		m.Session, m.Chat, m.ID, m.Sender, m.SenderAlt, m.ChatAlt, b2i(m.FromMe), m.TS, m.PushName, m.Kind, m.Ack, m.Source, m.Msg); err != nil {
		return fmt.Errorf("message: %w", err)
	}
	if _, err := tx.ExecContext(ctx, touchChatQuery, m.Session, m.Chat, m.TS, m.ID, b2i(incoming)); err != nil {
		return fmt.Errorf("chat: %w", err)
	}
	return tx.Commit()
}

// PutChatMeta stores what a history sync says of a chat without moving it back in time.
func (s *DB) PutChatMeta(ctx context.Context, c *ChatRow) error {
	_, err := s.SQL.ExecContext(ctx, `INSERT INTO gw_chats (session, chat, name, last_ts, last_id, unread, marked_unread, archived) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (session, chat) DO UPDATE SET
			name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE gw_chats.name END,
			last_id = CASE WHEN excluded.last_ts > gw_chats.last_ts THEN excluded.last_id ELSE gw_chats.last_id END,
			last_ts = CASE WHEN excluded.last_ts > gw_chats.last_ts THEN excluded.last_ts ELSE gw_chats.last_ts END,
			unread = excluded.unread, marked_unread = excluded.marked_unread, archived = excluded.archived`,
		c.Session, c.Chat, c.Name, c.LastTS, c.LastID, c.Unread, b2i(c.MarkedUnread), b2i(c.Archived))
	return err
}

func (s *DB) SetChatName(ctx context.Context, session, chat, name string) error {
	_, err := s.SQL.ExecContext(ctx, `INSERT INTO gw_chats (session, chat, name) VALUES ($1,$2,$3) ON CONFLICT (session, chat) DO UPDATE SET name=excluded.name`, session, chat, name)
	return err
}

func (s *DB) MarkChatRead(ctx context.Context, session string, chats []string, upto int64) error {
	q, args := inClause(`UPDATE gw_chats SET unread=0, marked_unread=0, read_upto=CASE WHEN read_upto < $2 THEN $2 ELSE read_upto END WHERE session=$1 AND chat IN (%s)`, 3, chats)
	_, err := s.SQL.ExecContext(ctx, q, append([]any{session, upto}, args...)...)
	return err
}

func (s *DB) GetChat(ctx context.Context, session string, chats []string) (*ChatRow, error) {
	q, args := inClause(`SELECT session, chat, name, last_ts, last_id, unread, read_upto, marked_unread, archived FROM gw_chats WHERE session=$1 AND chat IN (%s) ORDER BY last_ts DESC LIMIT 1`, 2, chats)
	return scanChat(s.SQL.QueryRowContext(ctx, q, append([]any{session}, args...)...))
}

func scanChat(sc interface{ Scan(...any) error }) (*ChatRow, error) {
	var c ChatRow
	var mu, ar int
	err := sc.Scan(&c.Session, &c.Chat, &c.Name, &c.LastTS, &c.LastID, &c.Unread, &c.ReadUpto, &mu, &ar)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	c.MarkedUnread, c.Archived = mu == 1, ar == 1
	return &c, err
}

// ListChats returns chats newest first, with the last message when stored.
func (s *DB) ListChats(ctx context.Context, session string, limit, offset int, asc bool) ([]*ChatRow, error) {
	order := "DESC"
	if asc {
		order = "ASC"
	}
	rows, err := s.SQL.QueryContext(ctx, `SELECT session, chat, name, last_ts, last_id, unread, read_upto, marked_unread, archived FROM gw_chats WHERE session=$1 ORDER BY last_ts `+order+`, chat LIMIT $2 OFFSET $3`, session, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ChatRow
	for rows.Next() {
		c, err := scanChat(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ---- retention ----

// Prune deletes messages older than cutoff (one indexed delete) and, if perChat > 0, all but the newest perChat of
// each chat over the cap, chat by chat so no single statement holds SQLite's write lock for long.
func (s *DB) Prune(ctx context.Context, cutoff time.Time, perChat int) (int64, error) {
	res, err := s.SQL.ExecContext(ctx, `DELETE FROM gw_messages WHERE ts < $1`, cutoff.Unix())
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if perChat <= 0 {
		return n, nil
	}
	rows, err := s.SQL.QueryContext(ctx, `SELECT session, chat FROM gw_messages GROUP BY session, chat HAVING COUNT(*) > $1`, perChat)
	if err != nil {
		return n, err
	}
	type key struct{ session, chat string }
	var over []key
	for rows.Next() {
		var k key
		if err := rows.Scan(&k.session, &k.chat); err != nil {
			rows.Close()
			return n, err
		}
		over = append(over, k)
	}
	rows.Close()
	for _, k := range over {
		res, err := s.SQL.ExecContext(ctx, `DELETE FROM gw_messages WHERE session=$1 AND chat=$2 AND ts < (
			SELECT ts FROM gw_messages WHERE session=$1 AND chat=$2 ORDER BY ts DESC LIMIT 1 OFFSET $3)`, k.session, k.chat, perChat-1)
		if err != nil {
			return n, err
		}
		m, _ := res.RowsAffected()
		n += m
	}
	return n, nil
}
