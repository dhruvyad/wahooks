package session

// Imported WAHA history must be indistinguishable from the same messages received live.
// The source is a real pg_dump archive of a WAHA NOWEB session database holding messages made by
// the Baileys build WAHA ships (migrate/fixturegen/history.mjs, export-history.sh); the live
// reference is whatsmeow receiving the same protobuf bytes, through onMessage → StoreLive.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
	"github.com/dhruvyad/wahooks/gateway/internal/wahaimport"
)

type histExpect struct {
	Me struct {
		PN  string `json:"pn"`
		LID string `json:"lid"`
	} `json:"me"`
	Messages []histMsg `json:"messages"`
}

type histMsg struct {
	Name        string  `json:"name"`
	ID          string  `json:"id"`
	Chat        string  `json:"chat"`
	FromMe      bool    `json:"fromMe"`
	Participant string  `json:"participant"`
	Alt         string  `json:"alt"`
	TS          int64   `json:"ts"`
	PushName    string  `json:"pushName"`
	Status      int     `json:"status"`
	Skip        *string `json:"skip"`
	Wire        string  `json:"wire"`
	MediaKey    string  `json:"mediaKey"`
}

const histDir = "../wahaimport/testdata/"

func loadHistExpect(t *testing.T) *histExpect {
	t.Helper()
	b, err := os.ReadFile(histDir + "expect.json")
	if err != nil {
		t.Fatal(err)
	}
	var e histExpect
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	return &e
}

// account sets the converted device's own JIDs on the harness client (ParseWebMessage needs them).
func account(t *testing.T, cli *whatsmeow.Client, e *histExpect) {
	pn, err1 := types.ParseJID(e.Me.PN)
	lid, err2 := types.ParseJID(e.Me.LID)
	if err1 != nil || err2 != nil {
		t.Fatal("bad own JIDs")
	}
	cli.Store.ID = &pn
	cli.Store.LID = lid
}

// liveEvent is what whatsmeow hands the gateway when it receives the message itself.
func liveEvent(t *testing.T, cli *whatsmeow.Client, x histMsg) *events.Message {
	t.Helper()
	wire, _ := base64.StdEncoding.DecodeString(x.Wire)
	var raw waE2E.Message
	if err := proto.Unmarshal(wire, &raw); err != nil {
		t.Fatal(err)
	}
	chat, _ := types.ParseJID(x.Chat)
	info := types.MessageInfo{
		MessageSource: types.MessageSource{Chat: chat, IsFromMe: x.FromMe, IsGroup: chat.Server == types.GroupServer},
		ID:            x.ID, PushName: x.PushName, Timestamp: time.Unix(x.TS, 0),
	}
	var alt types.JID
	if x.Alt != "" {
		alt, _ = types.ParseJID(x.Alt)
	}
	switch {
	case x.FromMe && chat.Server == types.HiddenUserServer:
		info.Sender = cli.Store.GetLID().ToNonAD()
		info.RecipientAlt = alt
	case x.FromMe:
		info.Sender = cli.Store.GetJID().ToNonAD()
		info.RecipientAlt = alt
	case info.IsGroup:
		info.Sender, _ = types.ParseJID(x.Participant)
		info.SenderAlt = alt
	default:
		info.Sender = chat
		info.SenderAlt = alt
	}
	evt := &events.Message{Info: info, RawMessage: &raw}
	evt.UnwrapRaw()
	return evt
}

func TestImportedHistoryMatchesLive(t *testing.T) {
	ctx := context.Background()
	e := loadHistExpect(t)
	cutoff := time.Unix(e.Messages[0].TS-30*86400, 0) // the gateway's default 30-day retention, at fixture time

	// Imported: from the session database's pg_dump archive.
	mImp, sImp, cliImp, _ := setup(t)
	account(t, cliImp, e)
	src, err := wahaimport.FromDump(histDir + "waha-session.dump")
	if err != nil {
		t.Fatal(err)
	}
	rep, err := wahaimport.Import(ctx, mImp.DB, cliImp, src, wahaimport.Options{Session: sImp.Name, Cutoff: cutoff})
	if err != nil {
		t.Fatal(err)
	}
	// Live: the same content arriving through whatsmeow.
	mLive, sLive, cliLive, _ := setup(t)
	account(t, cliLive, e)

	wantImported := 0
	for _, x := range e.Messages {
		if x.Skip == nil {
			wantImported++
			sLive.onMessage(ctx, cliLive, liveEvent(t, cliLive, x), "app")
		}
	}
	if rep.MessagesImported != wantImported || rep.MessagesRead != len(e.Messages) {
		t.Fatalf("report %+v, want %d imported", rep, wantImported)
	}
	if rep.Skipped["reaction (an event, not a stored message)"] != 1 || rep.Skipped["older than the retention cutoff"] != 1 {
		t.Fatalf("skips %+v", rep.Skipped)
	}
	// Only Baileys' runtime key fields have no protobuf counterpart.
	for f := range rep.UnknownFields {
		if f != "key.remoteJidAlt" && f != "key.participantAlt" && f != "key.addressingMode" {
			t.Errorf("unmapped Baileys field %q", f)
		}
	}

	render := func(s *Session, m *waha.Msg) string {
		b, _ := json.Marshal(waha.Message(m, s.RenderOpts(true)))
		return string(b)
	}
	for _, x := range e.Messages {
		chat, _ := types.ParseJID(x.Chat)
		imp, errI := mImp.DB.GetMessage(ctx, sImp.Name, []string{chat.String()}, x.ID)
		live, errL := mLive.DB.GetMessage(ctx, sLive.Name, []string{chat.String()}, x.ID)
		if x.Skip != nil {
			if errI == nil {
				t.Errorf("%s: imported although it should be skipped", x.Name)
			}
			continue
		}
		if errI != nil || errL != nil {
			t.Fatalf("%s: imported %v, live %v", x.Name, errI, errL)
		}
		// Row columns: identical except provenance (history vs app, which reads as app) and the ack,
		// which live would have raised to the same status through receipts.
		if imp.Chat != live.Chat || imp.Sender != live.Sender || imp.SenderAlt != live.SenderAlt || imp.ChatAlt != live.ChatAlt ||
			imp.FromMe != live.FromMe || imp.TS != live.TS || imp.PushName != live.PushName || imp.Kind != live.Kind {
			t.Errorf("%s: row differs\nimported %+v\nlive     %+v", x.Name, *imp, *live)
		}
		if imp.Source != "history" || imp.Ack != waha.AckFromWebStatus(waWebStatus(x.Status), x.FromMe) {
			t.Errorf("%s: source %q ack %d", x.Name, imp.Source, imp.Ack)
		}
		var mi, ml waE2E.Message
		_ = proto.Unmarshal(imp.Msg, &mi)
		_ = proto.Unmarshal(live.Msg, &ml)
		if !proto.Equal(&mi, &ml) {
			t.Errorf("%s: stored content differs\nimported %v\nlive     %v", x.Name, &mi, &ml)
		}
		// API rendering (GET …/messages/{id} and the list) with the ack aligned.
		live.Ack = imp.Ack
		ri, _ := waha.FromRow(imp)
		rl, _ := waha.FromRow(live)
		if a, b := render(sImp, ri), render(sLive, rl); a != b {
			t.Errorf("%s: rendering differs\nimported %s\nlive     %s", x.Name, a, b)
		}
		// GET /api/{session}/chats/{chat}/messages/{id}, by the WAHA message id the API uses.
		wid := waha.Message(ri, sImp.RenderOpts(false)).ID
		if got, err := sImp.Message(ctx, x.Chat, wid); err != nil || got.Info.ID != x.ID {
			t.Errorf("%s: GET by id %q: %v", x.Name, wid, err)
		}
		// On-demand media must work from the imported keys.
		if x.MediaKey != "" {
			img := mi.GetImageMessage()
			want, _ := base64.StdEncoding.DecodeString(x.MediaKey)
			if img == nil || string(img.GetMediaKey()) != string(want) || img.GetDirectPath() == "" || len(img.GetFileEncSHA256()) != 32 ||
				len(img.GetFileSHA256()) != 32 || img.GetFileLength() != 54321 || img.GetMimetype() != "image/jpeg" || img.GetJPEGThumbnail() != nil {
				t.Errorf("%s: media fields %v", x.Name, img)
			}
			if !strings.Contains(render(sImp, ri), `"hasMedia":true`) {
				t.Errorf("%s: not rendered as media", x.Name)
			}
		}
	}

	// GET /api/{session}/chats/{chat}/messages: same messages, same order, for every chat,
	// including a LID chat read by its phone-number alias once the LID map knows the pair.
	chats := map[string]bool{}
	for _, x := range e.Messages {
		if x.Skip == nil {
			chats[x.Chat] = true
		}
	}
	for chat := range chats {
		a, err1 := sImp.Messages(ctx, chat, store.MessageFilter{Limit: 50})
		b, err2 := sLive.Messages(ctx, chat, store.MessageFilter{Limit: 50})
		if err1 != nil || err2 != nil || len(a) != len(b) || len(a) == 0 {
			t.Fatalf("%s: %d vs %d messages (%v %v)", chat, len(a), len(b), err1, err2)
		}
		for i := range a {
			if a[i].Info.ID != b[i].Info.ID {
				t.Errorf("%s: order differs at %d", chat, i)
			}
		}
	}

	// /chats/overview: every chat present, newest message as "last", WAHA's names and flags kept.
	views, err := sImp.ChatRows(ctx, 50, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	byChat := map[string]*waha.ChatView{}
	for _, v := range views {
		byChat[v.Row.Chat] = v
	}
	lastByChat := map[string]string{}
	newestTS := map[string]int64{}
	for _, x := range e.Messages {
		if x.Skip == nil && x.TS > newestTS[x.Chat] {
			newestTS[x.Chat], lastByChat[x.Chat] = x.TS, x.ID
		}
	}
	for chat, id := range lastByChat {
		v := byChat[chat]
		if v == nil || v.Row.LastID != id || v.Last == nil || v.Last.Info.ID != id {
			t.Errorf("overview %s: %+v", chat, v)
		}
	}
	if v := byChat["120363000000000001@g.us"]; v == nil || v.Row.Name != "Fixture Group" || !v.Row.Archived {
		t.Errorf("group chat meta %+v", v)
	}
	if v := byChat["15555550101@s.whatsapp.net"]; v == nil || v.Row.Unread != 2 {
		t.Errorf("unread %+v", v)
	}
	keys := make([]string, 0, len(byChat))
	for k := range byChat {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) != 3 {
		t.Errorf("chats %v", keys)
	}
}

func waWebStatus(n int) waWeb.WebMessageInfo_Status { return waWeb.WebMessageInfo_Status(n) }

// Re-running is a no-op, and imported history never overwrites what the gateway stored or
// knows live (message rows, unread counts, chat names, newer last messages).
func TestImportIdempotentAndNonClobbering(t *testing.T) {
	ctx := context.Background()
	e := loadHistExpect(t)
	m, s, cli, _ := setup(t)
	account(t, cli, e)
	// The gateway already has the text message live, edited, and a newer message in that chat.
	for _, x := range e.Messages {
		if x.ID == "3EB0TEXT0001" {
			evt := liveEvent(t, cli, x)
			evt.Message = &waE2E.Message{Conversation: proto.String("edited live")}
			s.onMessage(ctx, cli, evt, "app")
			later := liveEvent(t, cli, x)
			later.Info.ID, later.Info.Timestamp = "LIVE0000NEWEST", time.Unix(x.TS+86400, 0)
			s.onMessage(ctx, cli, later, "app")
		}
	}
	_ = m.DB.SetChatName(ctx, s.Name, "15555550101@s.whatsapp.net", "Name from live")
	src, err := wahaimport.FromCSV(histDir+"messages.csv", histDir+"chats.csv")
	if err != nil {
		t.Fatal(err)
	}
	opt := wahaimport.Options{Session: s.Name, Cutoff: time.Unix(e.Messages[0].TS-30*86400, 0)}
	r1, err := wahaimport.Import(ctx, m.DB, cli, src, opt)
	if err != nil {
		t.Fatal(err)
	}
	r2, err := wahaimport.Import(ctx, m.DB, cli, src, opt)
	if err != nil {
		t.Fatal(err)
	}
	if r1.MessagesExisting != 1 || r2.MessagesImported != 0 || r2.MessagesExisting != r1.MessagesReady {
		t.Fatalf("first %+v second %+v", r1, r2)
	}
	row, err := m.DB.GetMessage(ctx, s.Name, []string{"15555550101@s.whatsapp.net"}, "3EB0TEXT0001")
	if err != nil {
		t.Fatal(err)
	}
	var msg waE2E.Message
	_ = proto.Unmarshal(row.Msg, &msg)
	if msg.GetConversation() != "edited live" || row.Source != "app" {
		t.Fatalf("live row overwritten: %q %q", msg.GetConversation(), row.Source)
	}
	c, err := m.DB.GetChat(ctx, s.Name, []string{"15555550101@s.whatsapp.net"})
	if err != nil || c.Name != "Name from live" || c.LastID != "LIVE0000NEWEST" || c.Unread != 2 {
		t.Fatalf("chat %+v %v (live: 2 unread, newest LIVE0000NEWEST)", c, err)
	}
}
