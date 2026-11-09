package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Runs against SQLite always, and against Postgres when WAGW_TEST_PG is a DSN.
func backends(t *testing.T) map[string]*DB {
	ctx := context.Background()
	out := map[string]*DB{}
	db, err := Open(ctx, "sqlite", filepath.Join(t.TempDir(), "t.db"), 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	out["sqlite"] = db
	if dsn := os.Getenv("WAGW_TEST_PG"); dsn != "" {
		pg, err := Open(ctx, "postgres", dsn, 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, q := range []string{"DELETE FROM gw_messages", "DELETE FROM gw_chats", "DELETE FROM gw_sessions"} {
			_, _ = pg.SQL.Exec(q)
		}
		out["postgres"] = pg
	}
	return out
}

func TestStore(t *testing.T) {
	ctx := context.Background()
	for name, db := range backends(t) {
		t.Run(name, func(t *testing.T) {
			defer db.Close()
			r := &SessionRow{Name: "u_1_s_1", Config: `{"webhooks":[]}`, Desired: "stopped"}
			if err := db.InsertSession(ctx, r); err != nil {
				t.Fatal(err)
			}
			if err := db.InsertSession(ctx, r); err != ErrExists {
				t.Fatalf("dup: %v", err)
			}
			ok, _, err := db.AcquireLease(ctx, "u_1_s_1", "box-a", time.Minute)
			if err != nil || !ok {
				t.Fatal("lease a", err)
			}
			ok, owner, _ := db.AcquireLease(ctx, "u_1_s_1", "box-b", time.Minute)
			if ok || owner != "box-a" {
				t.Fatal("lease b must fail", owner)
			}
			if err := db.UpdateSession(ctx, "u_1_s_1", map[string]any{"desired": "running", "device_jid": "1:2@s.whatsapp.net"}); err != nil {
				t.Fatal(err)
			}
			got, err := db.GetSession(ctx, "u_1_s_1")
			if err != nil || got.Desired != "running" || got.DeviceJID != "1:2@s.whatsapp.net" {
				t.Fatalf("%+v %v", got, err)
			}
			now := time.Now().Unix()
			for i, id := range []string{"A", "B", "C"} {
				m := &MessageRow{Session: "u_1_s_1", Chat: "9@s.whatsapp.net", ID: id, Sender: "9@s.whatsapp.net", TS: now + int64(i), Msg: []byte{1}, Ack: 2}
				if err := db.PutMessage(ctx, m, true); err != nil {
					t.Fatal(err)
				}
				if err := db.TouchChat(ctx, "u_1_s_1", m.Chat, m.TS, id, true); err != nil {
					t.Fatal(err)
				}
			}
			old := &MessageRow{Session: "u_1_s_1", Chat: "9@s.whatsapp.net", ID: "OLD", TS: now - 100*86400, Msg: []byte{1}}
			if err := db.PutMessages(ctx, []*MessageRow{old}); err != nil {
				t.Fatal(err)
			}
			ms, err := db.ListMessages(ctx, "u_1_s_1", []string{"9@s.whatsapp.net", "123@lid"}, MessageFilter{Limit: 10})
			if err != nil || len(ms) != 4 || ms[0].ID != "C" {
				t.Fatalf("list %d %v", len(ms), err)
			}
			if err := db.RaiseAck(ctx, "u_1_s_1", []string{"9@s.whatsapp.net"}, []string{"A"}, 3); err != nil {
				t.Fatal(err)
			}
			a, _ := db.GetMessage(ctx, "u_1_s_1", nil, "A")
			if a.Ack != 3 {
				t.Fatal("ack", a.Ack)
			}
			chats, err := db.ListChats(ctx, "u_1_s_1", 10, 0, false)
			if err != nil || len(chats) != 1 || chats[0].LastID != "C" || chats[0].Unread != 3 {
				t.Fatalf("chats %+v %v", chats, err)
			}
			if err := db.MarkChatRead(ctx, "u_1_s_1", []string{"9@s.whatsapp.net"}, now+5); err != nil {
				t.Fatal(err)
			}
			un, _ := db.UnreadIncoming(ctx, "u_1_s_1", []string{"9@s.whatsapp.net"}, now+5, 30)
			if len(un) != 0 {
				t.Fatal("unread after read", len(un))
			}
			n, err := db.Prune(ctx, time.Now().Add(-30*24*time.Hour), 2)
			if err != nil || n != 2 {
				t.Fatalf("prune %d %v", n, err)
			}
			if err := db.DeleteSession(ctx, "u_1_s_1"); err != nil {
				t.Fatal(err)
			}
			if _, err := db.GetSession(ctx, "u_1_s_1"); err != ErrNotFound {
				t.Fatal("deleted", err)
			}
		})
	}
}

func TestStoreLive(t *testing.T) {
	ctx := context.Background()
	for name, db := range backends(t) {
		t.Run(name, func(t *testing.T) {
			defer db.Close()
			chat := "8@s.whatsapp.net"
			now := time.Now().Unix()
			for i, id := range []string{"L1", "L2"} {
				m := &MessageRow{Session: "u_live", Chat: chat, ID: id, Sender: chat, TS: now + int64(i), Msg: []byte{1}, Ack: 2}
				if err := db.StoreLive(ctx, m, true); err != nil {
					t.Fatal(err)
				}
			}
			// an edit-style replace of L1 must not move the chat back or double count
			if err := db.StoreLive(ctx, &MessageRow{Session: "u_live", Chat: chat, ID: "L1", Sender: chat, TS: now, Msg: []byte{2}}, false); err != nil {
				t.Fatal(err)
			}
			c, err := db.GetChat(ctx, "u_live", []string{chat})
			if err != nil || c.LastID != "L2" || c.Unread != 0 {
				t.Fatalf("chat %+v %v (outgoing resets unread like TouchChat)", c, err)
			}
			if r, err := db.GetMessage(ctx, "u_live", []string{chat}, "L1"); err != nil || r.Msg[0] != 2 {
				t.Fatalf("message not replaced: %v", err)
			}
			if err := db.StoreLive(ctx, &MessageRow{Session: "u_live", Chat: chat, ID: "L3", Sender: chat, TS: now + 5, Msg: []byte{1}}, true); err != nil {
				t.Fatal(err)
			}
			if c, _ := db.GetChat(ctx, "u_live", []string{chat}); c.LastID != "L3" || c.Unread != 1 {
				t.Fatalf("incoming: %+v", c)
			}
		})
	}
}
