package session

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/gateway/internal/config"
	"github.com/dhruvyad/wahooks/gateway/internal/logx"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

type sink struct {
	mu     sync.Mutex
	events []map[string]any
}

func (s *sink) handler(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	s.mu.Lock()
	s.events = append(s.events, m)
	s.mu.Unlock()
}

func (s *sink) byEvent(name string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []map[string]any
	for _, e := range s.events {
		if e["event"] == name {
			out = append(out, e)
		}
	}
	return out
}

func setup(t *testing.T) (*Manager, *Session, *whatsmeow.Client, *sink) {
	t.Helper()
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	wa := logx.NewWA(log, "ERROR")
	db, err := store.Open(ctx, "sqlite", filepath.Join(t.TempDir(), "t.db"), 0, wa)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{BoxID: "test", BaseURL: "http://gw:3000", StoreMessages: true, MessageRetention: 30 * 24 * time.Hour,
		HistoryPerChat: 50, MediaDir: t.TempDir(), MediaCacheTTL: time.Minute, LeaseTTL: time.Minute, StartConcurrency: 1, QRMaxCycles: 1}
	hooks := webhook.New(2, 100, 5*time.Second, nil, log)
	m, err := NewManager(cfg, db, hooks, log, wa)
	if err != nil {
		t.Fatal(err)
	}
	sk := &sink{}
	srv := httptest.NewServer(http.HandlerFunc(sk.handler))
	t.Cleanup(srv.Close)
	s, err := m.Create(ctx, "u_t_s_1", json.RawMessage(`{"webhooks":[{"url":"`+srv.URL+`","events":["*"]}]}`), "")
	if err != nil {
		t.Fatal(err)
	}
	dev := db.Container.NewDevice()
	dev.ID = &types.JID{User: "15550000000", Device: 7, Server: types.DefaultUserServer}
	dev.PushName = "Me"
	cli := whatsmeow.NewClient(dev, nil)
	return m, s, cli, sk
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 750; i++ {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func TestHistorySyncStored(t *testing.T) {
	m, s, cli, _ := setup(t)
	ctx := context.Background()
	now := uint64(time.Now().Unix())
	chat := "15551234567@s.whatsapp.net"
	hs := &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID: proto.String(chat), Name: proto.String("Bob"), ConversationTimestamp: proto.Uint64(now), UnreadCount: proto.Uint32(1),
			Messages: []*waHistorySync.HistorySyncMsg{
				{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{RemoteJID: proto.String(chat), FromMe: proto.Bool(false), ID: proto.String("H1")},
					MessageTimestamp: proto.Uint64(now - 60), Message: &waE2E.Message{Conversation: proto.String("old hello")}}},
				{Message: &waWeb.WebMessageInfo{Key: &waCommon.MessageKey{RemoteJID: proto.String(chat), FromMe: proto.Bool(true), ID: proto.String("H2")},
					MessageTimestamp: proto.Uint64(now - 30), Message: &waE2E.Message{Conversation: proto.String("old reply")}, Status: waWeb.WebMessageInfo_READ.Enum()}},
			},
		}},
	}
	s.onHistory(ctx, cli, &events.HistorySync{Data: hs})
	chats, err := m.DB.ListChats(ctx, s.Name, 10, 0, false)
	if err != nil || len(chats) != 1 || chats[0].Name != "Bob" || chats[0].LastID != "H2" {
		t.Fatalf("chats %+v %v", chats, err)
	}
	msgs, err := s.Messages(ctx, "15551234567@c.us", store.MessageFilter{Limit: 10})
	if err != nil || len(msgs) != 2 {
		t.Fatalf("messages %d %v", len(msgs), err)
	}
	if msgs[0].Info.ID != "H2" || !msgs[0].Info.IsFromMe || msgs[0].Ack != 3 || msgs[1].Ack != 2 {
		t.Fatalf("order/acks %+v %+v", msgs[0], msgs[1])
	}
}

func TestIncomingMessageEvents(t *testing.T) {
	_, s, cli, sk := setup(t)
	ctx := context.Background()
	info := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: types.NewJID("111111111111111", types.HiddenUserServer), Sender: types.NewJID("111111111111111", types.HiddenUserServer), SenderAlt: types.NewJID("15551234567", types.DefaultUserServer)},
		ID:            "IN1", Timestamp: time.Now(), PushName: "Bob",
	}
	s.onMessage(ctx, cli, &events.Message{Info: info, Message: &waE2E.Message{Conversation: proto.String("hi")}}, "app")
	waitFor(t, func() bool { return len(sk.byEvent("message")) == 1 && len(sk.byEvent("message.any")) == 1 })
	p := sk.byEvent("message")[0]["payload"].(map[string]any)
	if p["id"] != "false_111111111111111@lid_IN1" || p["from"] != "111111111111111@lid" || p["ack"].(float64) != 2 {
		t.Fatalf("%v", p)
	}
	k := p["_data"].(map[string]any)["key"].(map[string]any)
	if k["remoteJidAlt"] != "15551234567@s.whatsapp.net" {
		t.Fatalf("alt %v", k)
	}
	// Stored, and readable by its PN alias once the LID map knows the pair.
	_ = s.m.DB.Container.LIDMap.PutLIDMapping(ctx, info.Chat, info.SenderAlt)
	msgs, err := s.Messages(ctx, "15551234567@c.us", store.MessageFilter{Limit: 5})
	if err != nil || len(msgs) != 1 {
		t.Fatalf("alias read %d %v", len(msgs), err)
	}
	// A reaction is message.reaction only; a revoke is message.revoked.
	s.onMessage(ctx, cli, &events.Message{Info: types.MessageInfo{MessageSource: info.MessageSource, ID: "R1", Timestamp: time.Now()},
		Message: &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String("15550000000@s.whatsapp.net"), FromMe: proto.Bool(false), ID: proto.String("MINE")}, Text: proto.String("👍")}}}, "app")
	s.onMessage(ctx, cli, &events.Message{Info: types.MessageInfo{MessageSource: info.MessageSource, ID: "X1", Timestamp: time.Now()},
		Message: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("IN1")}}}}, "app")
	waitFor(t, func() bool {
		return len(sk.byEvent("message.reaction")) == 1 && len(sk.byEvent("message.revoked")) == 1
	})
	r := sk.byEvent("message.reaction")[0]["payload"].(map[string]any)["reaction"].(map[string]any)
	if r["messageId"] != "true_111111111111111@lid_MINE" {
		t.Fatalf("reaction target %v", r)
	}
	if n := len(sk.byEvent("message")); n != 1 {
		t.Fatalf("reaction/revoke must not be message events, got %d", n)
	}
	rv := sk.byEvent("message.revoked")[0]["payload"].(map[string]any)
	if rv["revokedMessageId"] != "IN1" {
		t.Fatalf("%v", rv)
	}
}

func TestReceiptAcksDedup(t *testing.T) {
	_, s, cli, sk := setup(t)
	ctx := context.Background()
	chat := types.NewJID("15551234567", types.DefaultUserServer)
	rc := &events.Receipt{MessageSource: types.MessageSource{Chat: chat, Sender: chat}, MessageIDs: []types.MessageID{"OUT1"}, Timestamp: time.Now(), Type: types.ReceiptTypeRead}
	s.onReceipt(ctx, cli, rc)
	s.onReceipt(ctx, cli, rc)
	waitFor(t, func() bool { return len(sk.byEvent("message.ack")) >= 1 })
	time.Sleep(100 * time.Millisecond)
	acks := sk.byEvent("message.ack")
	if len(acks) != 1 {
		t.Fatalf("dedup: %d", len(acks))
	}
	p := acks[0]["payload"].(map[string]any)
	if p["id"] != "true_15551234567@c.us_OUT1" || p["ack"].(float64) != 3 || p["ackName"] != "READ" {
		t.Fatalf("%v", p)
	}
	if _, ok := p["_data"]; ok {
		t.Fatal("DM ack has no _data")
	}
	group := types.NewJID("120363000000000001", types.GroupServer)
	s.onReceipt(ctx, cli, &events.Receipt{MessageSource: types.MessageSource{Chat: group, Sender: chat, IsGroup: true}, MessageIDs: []types.MessageID{"G1"}, Timestamp: time.Now(), Type: types.ReceiptTypeDelivered})
	waitFor(t, func() bool { return len(sk.byEvent("message.ack.group")) == 1 })
	g := sk.byEvent("message.ack.group")[0]["payload"].(map[string]any)
	if g["ack"].(float64) != 1 || g["id"] != "true_120363000000000001@g.us_G1_15550000000@c.us" {
		t.Fatalf("%v", g)
	}
}
