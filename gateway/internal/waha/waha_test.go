package waha

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func jid(s string) types.JID { j, _ := types.ParseJID(s); return j }

func TestBaileysKey(t *testing.T) {
	cases := map[string]string{
		"URL": "url", "fileSHA256": "fileSha256", "fileEncSHA256": "fileEncSha256", "stanzaID": "stanzaId",
		"remoteJID": "remoteJid", "JPEGThumbnail": "jpegThumbnail", "PTT": "ptt", "mentionedJID": "mentionedJid",
		"mimetype": "mimetype", "fileLength": "fileLength", "contextInfo": "contextInfo", "canonicalURL": "canonicalUrl",
		"thumbnailSHA256": "thumbnailSha256", "directPath": "directPath",
	}
	for in, want := range cases {
		if got := BaileysKey(in); got != want {
			t.Errorf("BaileysKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSerializeAndParseID(t *testing.T) {
	id := SerializeID(false, jid("120363000000000001@g.us"), "ABC", jid("111111111111111@lid"))
	if id != "false_120363000000000001@g.us_ABC_111111111111111@lid" {
		t.Fatal(id)
	}
	k := ParseMessageID(id)
	if k.FromMe || k.ID != "ABC" || k.Chat.Server != "g.us" || k.Participant.Server != "lid" {
		t.Fatalf("%+v", k)
	}
	k = ParseMessageID("true_15550000000@c.us_XYZ")
	if !k.FromMe || k.Chat.Server != types.DefaultUserServer || k.ID != "XYZ" {
		t.Fatalf("%+v", k)
	}
	if ParseMessageID("XYZ").ID != "XYZ" {
		t.Fatal("bare id")
	}
}

func encode(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestIncomingDM(t *testing.T) {
	m := &Msg{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: jid("111111111111111@lid"), Sender: jid("111111111111111@lid"), SenderAlt: jid("15551234567@s.whatsapp.net"), AddressingMode: types.AddressingModeLID},
			ID:            "3A1B", Timestamp: time.Unix(1731150000, 0), PushName: "Bob",
		},
		Message: &waE2E.Message{Conversation: proto.String("hello")},
		Ack:     AckDevice, Source: "app",
	}
	p := encode(t, Message(m, &Opts{BaseURL: "http://x:3000", Session: "s", Enc: EncWebhook}))
	if p["id"] != "false_111111111111111@lid_3A1B" || p["from"] != "111111111111111@lid" || p["body"] != "hello" {
		t.Fatalf("%v", p)
	}
	if _, ok := p["to"]; ok {
		t.Fatal("DM must omit to")
	}
	if _, ok := p["participant"]; ok {
		t.Fatal("DM must omit participant")
	}
	if p["ack"].(float64) != 2 || p["ackName"] != "DEVICE" || p["media"] != nil || p["vCards"] != nil {
		t.Fatalf("%v", p)
	}
	d := p["_data"].(map[string]any)
	k := d["key"].(map[string]any)
	if k["remoteJidAlt"] != "15551234567@s.whatsapp.net" || k["participant"] != "" || k["addressingMode"] != "lid" {
		t.Fatalf("%v", k)
	}
	if d["status"].(float64) != 3 || d["messageTimestamp"].(float64) != 1731150000 {
		t.Fatalf("%v", d)
	}
	if d["message"].(map[string]any)["conversation"] != "hello" {
		t.Fatalf("%v", d)
	}
}

func TestGroupMediaAndEncodings(t *testing.T) {
	img := &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), FileLength: proto.Uint64(1234), FileSHA256: []byte{1, 2, 3}, URL: proto.String("https://mmg"), Caption: proto.String("")}
	m := &Msg{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: jid("120363000000000001@g.us"), Sender: jid("15551234567@s.whatsapp.net"), IsGroup: true},
			ID:            "IMG1", Timestamp: time.Unix(1731150000, 0),
		},
		Message: &waE2E.Message{ImageMessage: img},
		Ack:     AckDevice,
	}
	p := encode(t, Message(m, &Opts{BaseURL: "http://x:3000", Session: "s", DownloadMedia: true, Enc: EncWebhook}))
	if p["id"] != "false_120363000000000001@g.us_IMG1_15551234567@c.us" || p["to"] != "120363000000000001@g.us" || p["participant"] != "15551234567@c.us" {
		t.Fatalf("%v", p)
	}
	if p["body"] != nil || p["hasMedia"] != true {
		t.Fatalf("body/hasMedia %v", p)
	}
	media := p["media"].(map[string]any)
	if media["url"] != "http://x:3000/api/files/s/IMG1.jpeg" || media["mimetype"] != "image/jpeg" || media["filename"] != nil {
		t.Fatalf("%v", media)
	}
	im := p["_data"].(map[string]any)["message"].(map[string]any)["imageMessage"].(map[string]any)
	if im["fileLength"] != "1234" || im["fileSha256"] != "AQID" || im["url"] != "https://mmg" {
		t.Fatalf("webhook encoding %v", im)
	}
	p = encode(t, Message(m, &Opts{BaseURL: "http://x:3000", Session: "s", DownloadMedia: false, Enc: EncStore}))
	if p["media"].(map[string]any)["url"] != nil {
		t.Fatal("downloadMedia=false must give url null")
	}
	im = p["_data"].(map[string]any)["message"].(map[string]any)["imageMessage"].(map[string]any)
	if im["fileLength"].(float64) != 1234 {
		t.Fatalf("store encoding %v", im)
	}
	if buf := im["fileSha256"].(map[string]any); buf["type"] != "Buffer" || buf["data"] != "AQID" {
		t.Fatalf("store bytes %v", im)
	}
}

func TestSendResultAndAPIEcho(t *testing.T) {
	m := &Msg{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: jid("15551234567@s.whatsapp.net"), Sender: jid("15550000000:12@s.whatsapp.net"), IsFromMe: true},
			ID:            "3EB0", Timestamp: time.Unix(1731150000, 0),
		},
		Message: &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("Hi")}},
		Ack:     AckPending, Source: "api",
	}
	r := encode(t, SendResult(m))
	k := r["key"].(map[string]any)
	if k["remoteJid"] != "15551234567@s.whatsapp.net" || k["fromMe"] != true || k["id"] != "3EB0" {
		t.Fatalf("%v", r)
	}
	if r["messageTimestamp"] != "1731150000" || r["status"] != "PENDING" {
		t.Fatalf("%v", r)
	}
	if _, ok := r["id"]; ok {
		t.Fatal("no top-level id")
	}
	p := encode(t, Message(m, &Opts{Enc: EncWebhook}))
	if p["id"] != "true_15551234567@c.us_3EB0" || p["source"] != "api" || p["ack"].(float64) != 0 || p["from"] != "15551234567@c.us" {
		t.Fatalf("%v", p)
	}
}

func TestReactionPerspective(t *testing.T) {
	me := jid("15550000000@s.whatsapp.net")
	// Bob reacts in a DM to a message of ours: from his side the key is fromMe=false, remoteJid=me.
	info := &types.MessageInfo{MessageSource: types.MessageSource{Chat: jid("15551234567@s.whatsapp.net"), Sender: jid("15551234567@s.whatsapp.net")}, ID: "R1", Timestamp: time.Unix(1, 0)}
	r := &waE2E.ReactionMessage{Key: &waCommon.MessageKey{RemoteJID: proto.String(me.String()), FromMe: proto.Bool(false), ID: proto.String("M1")}, Text: proto.String("👍")}
	p := encode(t, Reaction(info, r, me, types.EmptyJID))
	if p["reaction"].(map[string]any)["messageId"] != "true_15551234567@c.us_M1" {
		t.Fatalf("%v", p)
	}
	if _, ok := p["_data"]; ok {
		t.Fatal("reaction has no _data")
	}
}

func TestLocationStrings(t *testing.T) {
	m := &Msg{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: jid("1@s.whatsapp.net")}, ID: "L", Timestamp: time.Unix(1, 0)},
		Message: &waE2E.Message{LocationMessage: &waE2E.LocationMessage{DegreesLatitude: proto.Float64(52.52), DegreesLongitude: proto.Float64(13.405), Name: proto.String("x")}}}
	p := encode(t, Message(m, &Opts{}))
	loc := p["location"].(map[string]any)
	if loc["latitude"] != "52.52" || loc["longitude"] != "13.405" || loc["live"] != false {
		t.Fatalf("%v", loc)
	}
}

func TestEnvelope(t *testing.T) {
	b, id, ts, err := Envelope("message", "s", nil, nil, map[string]any{"a": 1})
	if err != nil || !strings.HasPrefix(id, "evt_") || len(id) != 30 || ts == 0 {
		t.Fatal(id, err)
	}
	if strings.ToLower(id) != id {
		t.Fatal("ulid must be lowercase")
	}
	var env map[string]any
	_ = json.Unmarshal(b, &env)
	if _, ok := env["metadata"]; ok {
		t.Fatal("metadata omitted when unset")
	}
	if v, ok := env["me"]; !ok || v != nil {
		t.Fatal("me must be null")
	}
}

func TestRenderManyTypes(t *testing.T) {
	doc := &waE2E.DocumentMessage{Mimetype: proto.String("application/pdf"), FileName: proto.String("a.pdf"), FileLength: proto.Uint64(10), Caption: proto.String("cap")}
	cases := map[string]*waE2E.Message{
		"docCaption": {DocumentWithCaptionMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{DocumentMessage: doc}}},
		"voice":      {AudioMessage: &waE2E.AudioMessage{Mimetype: proto.String("audio/ogg; codecs=opus"), PTT: proto.Bool(true), Seconds: proto.Uint32(3)}},
		"sticker":    {StickerMessage: &waE2E.StickerMessage{Mimetype: proto.String("image/webp")}},
		"video":      {VideoMessage: &waE2E.VideoMessage{Mimetype: proto.String("video/mp4"), Caption: proto.String("v")}},
		"contacts":   {ContactsArrayMessage: &waE2E.ContactsArrayMessage{Contacts: []*waE2E.ContactMessage{{Vcard: proto.String("BEGIN:VCARD")}, {Vcard: proto.String("BEGIN:VCARD")}}}},
		"live":       {LiveLocationMessage: &waE2E.LiveLocationMessage{DegreesLatitude: proto.Float64(1.5), DegreesLongitude: proto.Float64(2.5), Caption: proto.String("here")}},
		"poll":       {PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Q"), Options: []*waE2E.PollCreationMessage_Option{{OptionName: proto.String("A")}}}},
		"reply": {ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("r"), ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("Q1"), Participant: proto.String("1@s.whatsapp.net"),
			QuotedMessage: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), Caption: proto.String("qc")}}}}},
	}
	for name, msg := range cases {
		for _, enc := range []Enc{EncWebhook, EncStore} {
			m := &Msg{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: jid("1@s.whatsapp.net"), Sender: jid("1@s.whatsapp.net")}, ID: "X", Timestamp: time.Unix(5, 0)}, Message: msg, Ack: AckDevice}
			p := encode(t, Message(m, &Opts{BaseURL: "http://gw", Session: "s", DownloadMedia: true, Enc: enc}))
			switch name {
			case "docCaption":
				if p["body"] != "cap" || p["media"].(map[string]any)["filename"] != "a.pdf" || !strings.HasSuffix(p["media"].(map[string]any)["url"].(string), "X.pdf") {
					t.Errorf("%s %v", name, p)
				}
			case "voice":
				if !strings.HasSuffix(p["media"].(map[string]any)["url"].(string), "X.oga") {
					t.Errorf("%s %v", name, p["media"])
				}
			case "contacts":
				if len(p["vCards"].([]any)) != 2 {
					t.Errorf("%s", name)
				}
			case "live":
				if l := p["location"].(map[string]any); l["live"] != true || l["latitude"] != "1.5" {
					t.Errorf("%s %v", name, l)
				}
			case "reply":
				r := p["replyTo"].(map[string]any)
				if r["id"] != "Q1" || r["participant"] != "1@c.us" || r["body"] != "qc" || r["hasMedia"] != true {
					t.Errorf("%s %v", name, r)
				}
			}
			if p["_data"] == nil {
				t.Errorf("%s: no _data", name)
			}
		}
	}
	if Kind(cases["poll"]) != "poll" || len(PollOptions(cases["poll"])) != 1 {
		t.Error("poll kind/options")
	}
}
