package store

import (
	"context"
	"fmt"
	"testing"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

func TestBoundedLIDMap(t *testing.T) {
	ctx := context.Background()
	for name, db := range backends(t) {
		t.Run(name, func(t *testing.T) {
			defer db.Close()
			_, _ = db.SQL.Exec(`DELETE FROM whatsmeow_lid_map`)
			b := db.UseBoundedLIDMap(1000)
			lid := func(u string) types.JID { return types.NewJID(u, types.HiddenUserServer) }
			pn := func(u string) types.JID { return types.NewJID(u, types.DefaultUserServer) }
			if err := b.PutLIDMapping(ctx, lid("900"), pn("100")); err != nil {
				t.Fatal(err)
			}
			if got, _ := b.GetPNForLID(ctx, lid("900")); got.User != "100" {
				t.Fatal("pn for lid", got)
			}
			// The phone number moves to a new LID: the old row goes, both directions follow.
			if err := b.PutLIDMapping(ctx, lid("901"), pn("100")); err != nil {
				t.Fatal(err)
			}
			if got, _ := b.GetLIDForPN(ctx, pn("100")); got.User != "901" {
				t.Fatal("lid for pn after move", got)
			}
			if got, _ := b.GetPNForLID(ctx, lid("900")); !got.IsEmpty() {
				t.Fatal("stale reverse entry", got)
			}
			var n int
			_ = db.SQL.QueryRow(`SELECT COUNT(*) FROM whatsmeow_lid_map WHERE pn='100'`).Scan(&n)
			if n != 1 {
				t.Fatal("rows for pn", n)
			}
			// Many mappings: cache stays bounded, lookups still answer from the database.
			var ms []store.LIDMapping
			for i := 0; i < 3000; i++ {
				ms = append(ms, store.LIDMapping{LID: lid(fmt.Sprint(10000 + i)), PN: pn(fmt.Sprint(20000 + i))})
			}
			if err := b.PutManyLIDMappings(ctx, ms); err != nil {
				t.Fatal(err)
			}
			if b.Len() > 2200 {
				t.Fatal("cache not bounded", b.Len())
			}
			if got, _ := b.GetPNForLID(ctx, lid("10000")); got.User != "20000" {
				t.Fatal("evicted entry not reloaded", got)
			}
			many, err := b.GetManyLIDsForPNs(ctx, []types.JID{pn("20001"), pn("20002"), pn("1")})
			if err != nil || len(many) != 2 || many[pn("20002")].User != "10002" {
				t.Fatal("many", many, err)
			}
			if got, _ := b.GetLIDForPN(ctx, pn("unknown")); !got.IsEmpty() {
				t.Fatal("miss", got)
			}
		})
	}
}
