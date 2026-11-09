package store

import (
	"context"
	"database/sql"
	"errors"

	"go.mau.fi/whatsmeow/types"
)

// Contact reads go straight to whatsmeow_contacts. whatsmeow's own ContactStore (GetAllContacts, GetContact) copies
// every row it returns into a per-device cache that is never evicted: one contacts listing added ~430 KB to an
// account with 1,122 contacts for the life of the process (bench/density/RESULTS.md §7), 6.5x its idle footprint.

type ContactRow struct {
	JID  types.JID
	Info types.ContactInfo
}

const contactCols = `their_jid, first_name, full_name, push_name, business_name, redacted_phone`

func scanContact(sc interface{ Scan(...any) error }) (*ContactRow, error) {
	var jid string
	var first, full, push, business, redacted sql.NullString
	if err := sc.Scan(&jid, &first, &full, &push, &business, &redacted); err != nil {
		return nil, err
	}
	j, err := types.ParseJID(jid)
	if err != nil {
		return nil, err
	}
	return &ContactRow{JID: j, Info: types.ContactInfo{
		Found: true, FirstName: first.String, FullName: full.String, PushName: push.String,
		BusinessName: business.String, RedactedPhone: redacted.String,
	}}, nil
}

// ListContacts returns one device's contacts ordered by JID string (byte order, like sorting JID.String()).
// limit <= 0 means all.
func (s *DB) ListContacts(ctx context.Context, device types.JID, limit, offset int) ([]*ContactRow, error) {
	order := "their_jid"
	if s.Dialect == "postgres" {
		order = `their_jid COLLATE "C"`
	}
	if limit <= 0 {
		limit = 1 << 30
	}
	if offset < 0 {
		offset = 0
	}
	rows, err := s.SQL.QueryContext(ctx, `SELECT `+contactCols+` FROM whatsmeow_contacts WHERE our_jid=$1 ORDER BY `+order+` LIMIT $2 OFFSET $3`,
		device.String(), limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ContactRow
	for rows.Next() {
		c, err := scanContact(rows)
		if err != nil {
			continue // a malformed JID in the table: skip it rather than fail the listing
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetContact returns one contact of a device; Found is false when there is no row.
func (s *DB) GetContact(ctx context.Context, device, contact types.JID) (types.ContactInfo, error) {
	c, err := scanContact(s.SQL.QueryRowContext(ctx, `SELECT `+contactCols+` FROM whatsmeow_contacts WHERE our_jid=$1 AND their_jid=$2`,
		device.String(), contact.String()))
	if errors.Is(err, sql.ErrNoRows) {
		return types.ContactInfo{}, nil
	} else if err != nil {
		return types.ContactInfo{}, err
	}
	return c.Info, nil
}
