package store

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/types"
)

func TestContactsDirect(t *testing.T) {
	ctx := context.Background()
	for name, db := range backends(t) {
		t.Run(name, func(t *testing.T) {
			defer db.Close()
			dev := db.Container.NewDevice()
			id := types.JID{User: "99800000001", Device: 3, Server: types.DefaultUserServer}
			dev.ID = &id
			dev.Account = &waAdv.ADVSignedDeviceIdentity{Details: []byte{1}, AccountSignatureKey: make([]byte, 32), AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64)}
			if err := dev.Save(ctx); err != nil {
				t.Fatal(err)
			}
			defer db.Container.DeleteDevice(ctx, dev) //nolint:errcheck
			// Out of order on purpose; one PN, one LID, one with only a push name.
			for _, c := range []struct{ jid, first, full, push string }{
				{"99700000003@s.whatsapp.net", "C", "Carol C", ""},
				{"99700000001@s.whatsapp.net", "A", "Alice A", "ali"},
				{"123456789@lid", "", "", "lidpush"},
			} {
				_, err := db.SQL.ExecContext(ctx, `INSERT INTO whatsmeow_contacts (our_jid, their_jid, first_name, full_name, push_name) VALUES ($1,$2,$3,$4,$5)`,
					id.String(), c.jid, c.first, c.full, c.push)
				if err != nil {
					t.Fatal(err)
				}
			}
			all, err := db.ListContacts(ctx, id, 0, 0)
			if err != nil || len(all) != 3 {
				t.Fatalf("ListContacts: %v %d", err, len(all))
			}
			want := []string{"123456789@lid", "99700000001@s.whatsapp.net", "99700000003@s.whatsapp.net"}
			for i, w := range want {
				if all[i].JID.String() != w || !all[i].Info.Found {
					t.Fatalf("order: got %s at %d, want %s", all[i].JID, i, w)
				}
			}
			if all[1].Info.FullName != "Alice A" || all[1].Info.PushName != "ali" || all[0].Info.PushName != "lidpush" {
				t.Fatalf("fields: %+v %+v", all[1].Info, all[0].Info)
			}
			page, _ := db.ListContacts(ctx, id, 1, 1)
			if len(page) != 1 || page[0].JID.String() != want[1] {
				t.Fatalf("page: %+v", page)
			}
			c, err := db.GetContact(ctx, id, types.NewJID("99700000003", types.DefaultUserServer))
			if err != nil || !c.Found || c.FirstName != "C" {
				t.Fatalf("GetContact: %v %+v", err, c)
			}
			c, err = db.GetContact(ctx, id, types.NewJID("99700000009", types.DefaultUserServer))
			if err != nil || c.Found {
				t.Fatalf("GetContact missing: %v %+v", err, c)
			}
			other := types.JID{User: "99800000002", Device: 1, Server: types.DefaultUserServer}
			if none, _ := db.ListContacts(ctx, other, 0, 0); len(none) != 0 {
				t.Fatalf("other device sees %d contacts", len(none))
			}
		})
	}
}
