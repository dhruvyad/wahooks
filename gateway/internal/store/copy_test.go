package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"
)

// A box moving from its SQLite file to a shared store: every account's keys, sessions and history
// arrive, booleans and bytes survive the dialect change, and a second copy can't overwrite anything.
func TestCopyInto(t *testing.T) {
	ctx := context.Background()
	src, err := Open(ctx, "sqlite", filepath.Join(t.TempDir(), "src.db"), 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	id := types.JID{User: "99800000077", Device: 4, Server: types.DefaultUserServer}
	dev := src.Container.NewDevice()
	dev.ID = &id
	dev.PushName = "Copy Test"
	dev.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{1, 2}, AccountSignatureKey: make([]byte, 32), AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64)}
	if err := dev.Save(ctx); err != nil {
		t.Fatal(err)
	}
	pks, err := dev.PreKeys.GetOrGenPreKeys(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	if err := dev.PreKeys.MarkPreKeysAsUploaded(ctx, pks[2].KeyID); err != nil {
		t.Fatal(err)
	}
	if err := dev.Identities.PutIdentity(ctx, "99700000001.0", [32]byte{7}); err != nil {
		t.Fatal(err)
	}
	if err := dev.Sessions.PutSession(ctx, "99700000001.0", []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	if err := src.InsertSession(ctx, &SessionRow{Name: "u_copy_s_1", Config: `{"x":1}`, DeviceJID: id.String(), Desired: "running", Owner: "box-a", CreatedAt: 1, UpdatedAt: 2}); err != nil {
		t.Fatal(err)
	}
	if err := src.PutMessage(ctx, &MessageRow{Session: "u_copy_s_1", Chat: "99700000001@s.whatsapp.net", ID: "M1", FromMe: true, TS: 100, Kind: "text", Msg: []byte{9, 8}}, false); err != nil {
		t.Fatal(err)
	}
	if err := src.RenewLeases(ctx, "box-a", 60e9); err != nil {
		t.Fatal(err)
	}
	wantUploaded, _ := dev.PreKeys.UploadedPreKeyCount(ctx)

	dsts := map[string]*DB{}
	sq, err := Open(ctx, "sqlite", filepath.Join(t.TempDir(), "dst.db"), 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	dsts["sqlite"] = sq
	if dsn := os.Getenv("WAGW_TEST_PG"); dsn != "" {
		pg, err := Open(ctx, "postgres", dsn, 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range []string{"DELETE FROM whatsmeow_device WHERE jid = '" + id.String() + "'", "DELETE FROM gw_messages WHERE session = 'u_copy_s_1'", "DELETE FROM gw_sessions WHERE name = 'u_copy_s_1'"} {
			if _, err := pg.SQL.ExecContext(ctx, q); err != nil {
				t.Fatal(err)
			}
		}
		dsts["postgres"] = pg
	}
	for name, dst := range dsts {
		t.Run(name, func(t *testing.T) {
			defer dst.Close()
			rep, err := CopyInto(ctx, src, dst)
			if err != nil {
				t.Fatal(err)
			}
			if rep.Tables["whatsmeow_device"] != 1 || rep.Tables["whatsmeow_pre_keys"] != 5 || rep.Tables["gw_sessions"] != 1 || rep.Tables["gw_messages"] != 1 {
				t.Fatalf("report %+v", rep.Tables)
			}
			if len(rep.Skipped) != 2 {
				t.Fatalf("skipped %v, want the version table and gw_boxes", rep.Skipped)
			}
			got, err := dst.Container.GetDevice(ctx, id)
			if err != nil || got == nil {
				t.Fatalf("device not in destination: %v", err)
			}
			if *got.IdentityKey.Pub != *dev.IdentityKey.Pub || *got.NoiseKey.Pub != *dev.NoiseKey.Pub || got.RegistrationID != dev.RegistrationID || got.PushName != "Copy Test" {
				t.Fatal("device keys differ after the copy")
			}
			if n, _ := got.PreKeys.UploadedPreKeyCount(ctx); n != wantUploaded {
				t.Fatalf("uploaded pre-keys %d, want %d (boolean column)", n, wantUploaded)
			}
			if s, err := got.Sessions.GetSession(ctx, "99700000001.0"); err != nil || len(s) != 3 {
				t.Fatalf("signal session: %v %v", s, err)
			}
			if ok, err := got.Identities.IsTrustedIdentity(ctx, "99700000001.0", [32]byte{7}); err != nil || !ok {
				t.Fatalf("identity: %v %v", ok, err)
			}
			r, err := dst.GetSession(ctx, "u_copy_s_1")
			if err != nil || r == nil || r.Config != `{"x":1}` || r.DeviceJID != id.String() || r.Owner != "box-a" {
				t.Fatalf("gw session %+v %v", r, err)
			}
			m, err := dst.GetMessage(ctx, "u_copy_s_1", []string{"99700000001@s.whatsapp.net"}, "M1")
			if err != nil || m == nil || !m.FromMe || len(m.Msg) != 2 {
				t.Fatalf("message %+v %v", m, err)
			}
			// Copying again must fail as a whole and change nothing.
			if _, err := CopyInto(ctx, src, dst); err == nil {
				t.Fatal("second copy succeeded; it must refuse to overwrite")
			}
			var n int
			if err := dst.SQL.QueryRowContext(ctx, `SELECT count(*) FROM gw_messages WHERE session = 'u_copy_s_1'`).Scan(&n); err != nil || n != 1 {
				t.Fatalf("after the refused copy: %d messages, %v", n, err)
			}
			if name == "postgres" {
				_ = dst.Container.DeleteDevice(ctx, got)
				_, _ = dst.SQL.ExecContext(ctx, "DELETE FROM gw_messages WHERE session = 'u_copy_s_1'")
				_, _ = dst.SQL.ExecContext(ctx, "DELETE FROM gw_sessions WHERE name = 'u_copy_s_1'")
			}
		})
	}
}
