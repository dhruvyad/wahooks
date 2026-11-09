package waha

import (
	"mime"
	"strconv"
	"strings"
	"time"
	"unicode"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
)

// WAHA's ack values (Baileys status − 1).
const (
	AckError   = -1
	AckPending = 0
	AckServer  = 1
	AckDevice  = 2
	AckRead    = 3
	AckPlayed  = 4
)

var ackNames = map[int]string{-1: "ERROR", 0: "PENDING", 1: "SERVER", 2: "DEVICE", 3: "READ", 4: "PLAYED"}

func AckName(a int) string {
	if n, ok := ackNames[a]; ok {
		return n
	}
	return "UNKNOWN"
}

// AckByName accepts a WAHA ack name (filter.ack).
func AckByName(s string) (int, bool) {
	for k, v := range ackNames {
		if strings.EqualFold(v, s) {
			return k, true
		}
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n, true
	}
	return 0, false
}

// AckFromReceipt maps a receipt to WAHA's message.ack value for a DM (NOWEB). 0 with ok=false means "no event".
func AckFromReceipt(t types.ReceiptType) (int, bool) {
	switch t {
	case types.ReceiptTypeDelivered:
		return AckDevice, true
	case types.ReceiptTypeRead:
		return AckRead, true
	case types.ReceiptTypePlayed:
		return AckPlayed, true
	case types.ReceiptTypeSender:
		return AckServer, true
	case types.ReceiptTypeServerError:
		return AckError, true
	}
	return 0, false
}

// AckFromReceiptGroup maps a group receipt to message.ack.group's value: NOWEB reports delivered as 1 (SERVER)
// and both read and played as 3.
func AckFromReceiptGroup(t types.ReceiptType) (int, bool) {
	switch t {
	case types.ReceiptTypeDelivered:
		return AckServer, true
	case types.ReceiptTypeRead, types.ReceiptTypePlayed:
		return AckRead, true
	}
	return 0, false
}

// AckFromWebStatus maps a history-sync status; unset statuses get NOWEB's defaults (2 incoming, 1 from me).
func AckFromWebStatus(s waWeb.WebMessageInfo_Status, fromMe bool) int {
	a := int(s) - 1
	if a < AckServer {
		if fromMe {
			return AckServer
		}
		return AckDevice
	}
	return a
}

// Msg is a message as the gateway holds it: whatsmeow's info plus the (unwrapped) content.
type Msg struct {
	Info    types.MessageInfo
	Message *waE2E.Message
	Ack     int
	Source  string // "app" (phone/other device or received), "api" (sent through the gateway)
}

// Opts carries what rendering needs beyond the message.
type Opts struct {
	BaseURL       string
	Session       string
	Me            types.JID
	MeLID         types.JID
	DownloadMedia bool
	Enc           Enc // EncWebhook for events, EncStore for HTTP reads
}

// MediaInfo is WAHA's WAMedia (key order url, filename, mimetype).
type MediaInfo struct {
	URL      *string `json:"url"`
	Filename *string `json:"filename"`
	Mimetype string  `json:"mimetype"`
	Error    any     `json:"error,omitempty"`
}

type Location struct {
	Live        bool   `json:"live"`
	Latitude    string `json:"latitude"`
	Longitude   string `json:"longitude"`
	Name        string `json:"name,omitempty"`
	Address     string `json:"address,omitempty"`
	URL         string `json:"url,omitempty"`
	Description string `json:"description,omitempty"`
	Thumbnail   string `json:"thumbnail,omitempty"`
}

type ReplyTo struct {
	ID          string     `json:"id"`
	Participant string     `json:"participant,omitempty"`
	Body        *string    `json:"body"`
	HasMedia    bool       `json:"hasMedia"`
	Media       *MediaInfo `json:"media"`
	Data        any        `json:"_data"`
}

// MessagePayload is WAHA's WAMessage, in NOWEB's key order.
type MessagePayload struct {
	ID          string     `json:"id"`
	Timestamp   int64      `json:"timestamp"`
	From        string     `json:"from"`
	FromMe      bool       `json:"fromMe"`
	Source      string     `json:"source"`
	Body        *string    `json:"body"`
	To          string     `json:"to,omitempty"`
	Participant string     `json:"participant,omitempty"`
	HasMedia    bool       `json:"hasMedia"`
	Media       *MediaInfo `json:"media"`
	Ack         int        `json:"ack"`
	AckName     string     `json:"ackName"`
	Location    *Location  `json:"location"`
	VCards      []string   `json:"vCards"`
	ReplyTo     *ReplyTo   `json:"replyTo"`
	Data        any        `json:"_data"`
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Body extracts NOWEB's body: text, caption, edited text, button/list replies.
func Body(m *waE2E.Message) string {
	if m == nil {
		return ""
	}
	switch {
	case m.Conversation != nil:
		return m.GetConversation()
	case m.ExtendedTextMessage != nil:
		return m.GetExtendedTextMessage().GetText()
	case m.ImageMessage != nil:
		return m.GetImageMessage().GetCaption()
	case m.VideoMessage != nil:
		return m.GetVideoMessage().GetCaption()
	case m.PtvMessage != nil:
		return m.GetPtvMessage().GetCaption()
	case m.DocumentMessage != nil:
		return m.GetDocumentMessage().GetCaption()
	case m.DocumentWithCaptionMessage != nil:
		return Body(m.GetDocumentWithCaptionMessage().GetMessage())
	case m.ProtocolMessage != nil && m.GetProtocolMessage().GetEditedMessage() != nil:
		return Body(m.GetProtocolMessage().GetEditedMessage())
	case m.AssociatedChildMessage != nil:
		return Body(m.GetAssociatedChildMessage().GetMessage())
	case m.ButtonsResponseMessage != nil:
		return m.GetButtonsResponseMessage().GetSelectedDisplayText()
	case m.TemplateButtonReplyMessage != nil:
		return m.GetTemplateButtonReplyMessage().GetSelectedDisplayText()
	case m.ListResponseMessage != nil:
		l := m.GetListResponseMessage()
		parts := []string{}
		if l.GetTitle() != "" {
			parts = append(parts, l.GetTitle())
		}
		if l.GetDescription() != "" {
			parts = append(parts, l.GetDescription())
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// unwrap returns the inner message of wrappers whatsmeow leaves in place (document with caption).
func unwrap(m *waE2E.Message) *waE2E.Message {
	if m == nil {
		return nil
	}
	if d := m.GetDocumentWithCaptionMessage(); d != nil && d.GetMessage() != nil {
		return d.GetMessage()
	}
	return m
}

// Downloadable returns the media part of a message and its mimetype.
func Downloadable(m *waE2E.Message) (whatsmeow.DownloadableMessage, string) {
	m = unwrap(m)
	if m == nil {
		return nil, ""
	}
	switch {
	case m.ImageMessage != nil:
		return m.ImageMessage, m.ImageMessage.GetMimetype()
	case m.VideoMessage != nil:
		return m.VideoMessage, m.VideoMessage.GetMimetype()
	case m.AudioMessage != nil:
		return m.AudioMessage, m.AudioMessage.GetMimetype()
	case m.DocumentMessage != nil:
		return m.DocumentMessage, m.DocumentMessage.GetMimetype()
	case m.StickerMessage != nil:
		return m.StickerMessage, m.StickerMessage.GetMimetype()
	case m.PtvMessage != nil:
		return m.PtvMessage, m.PtvMessage.GetMimetype()
	}
	return nil, ""
}

func mediaFilename(m *waE2E.Message) string {
	m = unwrap(m)
	if d := m.GetDocumentMessage(); d != nil {
		return d.GetFileName()
	}
	return ""
}

// Ext picks a file extension for a mimetype like WAHA (mime.extension): jpeg, png, webp, mp4, oga, pdf…
func Ext(mt string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(mt, ";")[0]))
	switch base {
	case "image/jpeg":
		return "jpeg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "video/mp4":
		return "mp4"
	case "audio/ogg":
		return "oga"
	case "audio/mpeg":
		return "mp3"
	case "audio/mp4":
		return "m4a"
	case "audio/aac":
		return "aac"
	case "application/pdf":
		return "pdf"
	case "application/was":
		return "zip"
	case "text/plain":
		return "txt"
	}
	if exts, err := mime.ExtensionsByType(base); err == nil && len(exts) > 0 {
		return strings.TrimPrefix(exts[0], ".")
	}
	if i := strings.IndexByte(base, '/'); i > 0 && i < len(base)-1 {
		sub := base[i+1:]
		if strings.IndexFunc(sub, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) < 0 {
			return sub
		}
	}
	return "bin"
}

// keyParticipant is NOWEB's key.participant: the sender in groups (except messages sent through the API, where
// Baileys leaves it unset), empty in DMs.
func keyParticipant(m *Msg) types.JID {
	if m.Info.IsGroup && m.Source != "api" {
		return m.Info.Sender
	}
	return types.EmptyJID
}

// MessageID is the WAHA id of a message.
func MessageID(m *Msg) string {
	return SerializeID(m.Info.IsFromMe, m.Info.Chat, m.Info.ID, keyParticipant(m))
}

func mediaInfo(msg *waE2E.Message, o *Opts, id string) *MediaInfo {
	dl, mt := Downloadable(msg)
	if dl == nil {
		return nil
	}
	mi := &MediaInfo{Mimetype: mt, Filename: strp(mediaFilename(msg))}
	if o != nil && o.DownloadMedia {
		url := o.BaseURL + "/api/files/" + o.Session + "/" + id + "." + Ext(mt)
		mi.URL = &url
	}
	return mi
}

func fmtCoord(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// Message renders a WAMessage.
func Message(m *Msg, o *Opts) *MessagePayload {
	info := &m.Info
	p := &MessagePayload{
		ID:        MessageID(m),
		Timestamp: info.Timestamp.Unix(),
		From:      CUs(info.Chat),
		FromMe:    info.IsFromMe,
		Source:    m.Source,
		Body:      strp(Body(m.Message)),
		Ack:       m.Ack,
		AckName:   AckName(m.Ack),
	}
	if p.Source == "" {
		p.Source = "app"
	}
	if info.IsGroup {
		p.To = CUs(info.Chat)
		if !info.Sender.IsEmpty() {
			p.Participant = CUs(info.Sender)
		}
	}
	if mi := mediaInfo(m.Message, o, info.ID); mi != nil {
		p.HasMedia = true
		p.Media = mi
	}
	top := m.Message
	if l := top.GetLocationMessage(); l != nil {
		p.Location = &Location{Latitude: fmtCoord(l.GetDegreesLatitude()), Longitude: fmtCoord(l.GetDegreesLongitude()), Name: l.GetName(), Address: l.GetAddress(), URL: l.GetURL(), Description: l.GetComment()}
	} else if l := top.GetLiveLocationMessage(); l != nil {
		p.Location = &Location{Live: true, Latitude: fmtCoord(l.GetDegreesLatitude()), Longitude: fmtCoord(l.GetDegreesLongitude()), Description: l.GetCaption()}
	}
	if c := top.GetContactMessage(); c != nil {
		p.VCards = []string{c.GetVcard()}
	} else if ca := top.GetContactsArrayMessage(); ca != nil {
		for _, c := range ca.GetContacts() {
			p.VCards = append(p.VCards, c.GetVcard())
		}
	}
	enc := EncWebhook
	if o != nil {
		enc = o.Enc
	}
	if ci := contextInfo(unwrap(m.Message)); ci != nil && ci.GetStanzaID() != "" {
		q := ci.GetQuotedMessage()
		rt := &ReplyTo{ID: ci.GetStanzaID(), Body: strp(Body(q))}
		if pj := ci.GetParticipant(); pj != "" {
			if j, err := types.ParseJID(pj); err == nil {
				rt.Participant = CUs(j)
			}
		}
		if q != nil {
			if dl, mt := Downloadable(q); dl != nil {
				rt.HasMedia = true
				_ = mt
			}
			rt.Data = ProtoJSON(q, enc)
		}
		p.ReplyTo = rt
	}
	p.Data = WebMessageData(m, enc)
	return p
}

// contextInfo finds the ContextInfo of whichever content the message carries.
func contextInfo(m *waE2E.Message) *waE2E.ContextInfo {
	if m == nil {
		return nil
	}
	var found *waE2E.ContextInfo
	m.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		if fd.Message() == nil || fd.IsList() || fd.IsMap() {
			return true
		}
		sub := v.Message()
		f := sub.Descriptor().Fields().ByName("contextInfo")
		if f == nil || !sub.Has(f) {
			return true
		}
		if ci, ok := sub.Get(f).Message().Interface().(*waE2E.ContextInfo); ok {
			found = ci
			return false
		}
		return true
	})
	return found
}

// dataKey is Baileys' WAMessageKey as NOWEB delivers it for received messages.
type dataKey struct {
	RemoteJid      string `json:"remoteJid"`
	RemoteJidAlt   string `json:"remoteJidAlt,omitempty"`
	FromMe         bool   `json:"fromMe"`
	ID             string `json:"id"`
	Participant    string `json:"participant"`
	ParticipantAlt string `json:"participantAlt,omitempty"`
	AddressingMode string `json:"addressingMode,omitempty"`
}

// sentKey is the key of a message sent through the API (proto WebMessageInfo, no participant).
type sentKey struct {
	RemoteJid string `json:"remoteJid"`
	FromMe    bool   `json:"fromMe"`
	ID        string `json:"id"`
}

func addressingMode(info *types.MessageInfo) string {
	switch {
	case info.AddressingMode != "":
		return string(info.AddressingMode)
	case info.Chat.Server == types.HiddenUserServer, info.Sender.Server == types.HiddenUserServer:
		return "lid"
	case info.Chat.Server == types.DefaultUserServer || info.IsGroup:
		return "pn"
	}
	return ""
}

func receivedKey(m *Msg) dataKey {
	info := &m.Info
	k := dataKey{RemoteJid: SWA(info.Chat), FromMe: info.IsFromMe, ID: info.ID, AddressingMode: addressingMode(info)}
	if info.IsGroup {
		k.Participant = SWA(info.Sender)
		if !info.SenderAlt.IsEmpty() {
			k.ParticipantAlt = SWA(info.SenderAlt)
		}
	} else {
		alt := info.SenderAlt
		if info.IsFromMe {
			alt = info.RecipientAlt
		}
		if !alt.IsEmpty() && alt.Server != info.Chat.Server {
			k.RemoteJidAlt = SWA(alt)
		}
	}
	return k
}

// statusName is Baileys' WebMessageInfo.Status name for a WAHA ack.
func statusName(ack int) string {
	return waWeb.WebMessageInfo_Status(int32(ack + 1)).String()
}

// WebMessageData builds NOWEB's _data. A message sent through the API is a proto WebMessageInfo in webhook
// encoding (messageTimestamp as a string, status "PENDING"); everything else is Baileys' plain object.
func WebMessageData(m *Msg, enc Enc) OM {
	info := &m.Info
	if m.Source == "api" && enc == EncWebhook {
		d := OM{
			{"key", sentKey{RemoteJid: SWA(info.Chat), FromMe: true, ID: info.ID}},
			{"message", ProtoJSON(m.Message, enc)},
			{"messageTimestamp", strconv.FormatInt(info.Timestamp.Unix(), 10)},
			{"status", statusName(m.Ack)},
		}
		if info.IsGroup && !info.Sender.IsEmpty() {
			d = append(d, KV{"participant", info.Sender.String()})
		}
		return d
	}
	var key any = receivedKey(m)
	if m.Source == "api" {
		key = sentKey{RemoteJid: SWA(info.Chat), FromMe: true, ID: info.ID}
	}
	d := OM{
		{"key", key},
		{"messageTimestamp", info.Timestamp.Unix()},
		{"pushName", info.PushName},
		{"broadcast", info.Chat.Server == types.BroadcastServer},
	}
	if info.VerifiedName != nil && info.VerifiedName.Details != nil && info.VerifiedName.Details.GetVerifiedName() != "" {
		d = append(d, KV{"verifiedBizName", info.VerifiedName.Details.GetVerifiedName()})
	}
	if info.IsFromMe {
		d = append(d, KV{"status", m.Ack + 1}, KV{"message", ProtoJSON(m.Message, enc)})
	} else {
		d = append(d, KV{"message", ProtoJSON(m.Message, enc)}, KV{"status", m.Ack + 1})
	}
	return d
}

// SendResult renders what NOWEB returns from send endpoints: the Baileys proto WebMessageInfo of the sent
// message (webhook encoding, no top-level id).
func SendResult(m *Msg) OM {
	if m == nil {
		return OM{}
	}
	c := *m
	c.Source = "api"
	c.Ack = AckPending
	return WebMessageData(&c, EncWebhook)
}

// IsSkippable reports content NOWEB doesn't surface as a message (bare key distribution, empty stubs).
func IsSkippable(m *waE2E.Message) bool {
	if m == nil {
		return true
	}
	c := proto.Clone(m).(*waE2E.Message)
	c.SenderKeyDistributionMessage = nil
	c.MessageContextInfo = nil
	return proto.Size(c) == 0
}

// StripForStorage drops what the history tables don't need (key distribution, thumbnails).
func StripForStorage(m *waE2E.Message) *waE2E.Message {
	if m == nil {
		return nil
	}
	c := proto.Clone(m).(*waE2E.Message)
	c.SenderKeyDistributionMessage = nil
	if mci := c.GetMessageContextInfo(); mci != nil {
		mci.DeviceListMetadata = nil
	}
	in := unwrap(c)
	if x := in.GetImageMessage(); x != nil {
		x.JPEGThumbnail = nil
	}
	if x := in.GetVideoMessage(); x != nil {
		x.JPEGThumbnail = nil
	}
	if x := in.GetDocumentMessage(); x != nil {
		x.JPEGThumbnail = nil
	}
	if x := in.GetExtendedTextMessage(); x != nil {
		x.JPEGThumbnail = nil
	}
	if x := in.GetLocationMessage(); x != nil {
		x.JPEGThumbnail = nil
	}
	if x := in.GetStickerMessage(); x != nil {
		x.PngThumbnail = nil
	}
	return c
}

// Kind is a coarse type for the history table.
func Kind(m *waE2E.Message) string {
	in := unwrap(m)
	switch {
	case in.GetImageMessage() != nil:
		return "image"
	case in.GetVideoMessage() != nil, in.GetPtvMessage() != nil:
		return "video"
	case in.GetAudioMessage() != nil:
		return "audio"
	case in.GetDocumentMessage() != nil:
		return "document"
	case in.GetStickerMessage() != nil:
		return "sticker"
	case in.GetLocationMessage() != nil, in.GetLiveLocationMessage() != nil:
		return "location"
	case in.GetContactMessage() != nil, in.GetContactsArrayMessage() != nil:
		return "contact"
	case in.GetPollCreationMessage() != nil, in.GetPollCreationMessageV3() != nil:
		return "poll"
	}
	return "text"
}

// ToRow converts a message for storage.
func ToRow(session string, m *Msg) (*gwstore.MessageRow, error) {
	b, err := proto.Marshal(StripForStorage(m.Message))
	if err != nil {
		return nil, err
	}
	info := &m.Info
	r := &gwstore.MessageRow{
		Session:  session,
		Chat:     info.Chat.ToNonAD().String(),
		ID:       info.ID,
		Sender:   info.Sender.ToNonAD().String(),
		FromMe:   info.IsFromMe,
		TS:       info.Timestamp.Unix(),
		PushName: info.PushName,
		Kind:     Kind(m.Message),
		Ack:      m.Ack,
		Source:   m.Source,
		Msg:      b,
	}
	if info.IsGroup {
		if !info.SenderAlt.IsEmpty() {
			r.SenderAlt = info.SenderAlt.ToNonAD().String()
		}
	} else {
		alt := info.SenderAlt
		if info.IsFromMe {
			alt = info.RecipientAlt
		}
		if !alt.IsEmpty() {
			r.ChatAlt = alt.ToNonAD().String()
		}
	}
	return r, nil
}

// FromRow rebuilds a stored message.
func FromRow(r *gwstore.MessageRow) (*Msg, error) {
	var msg waE2E.Message
	if err := proto.Unmarshal(r.Msg, &msg); err != nil {
		return nil, err
	}
	chat, _ := types.ParseJID(r.Chat)
	sender, _ := types.ParseJID(r.Sender)
	m := &Msg{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsFromMe: r.FromMe, IsGroup: chat.Server == types.GroupServer || chat.Server == types.BroadcastServer},
			ID:            r.ID,
			PushName:      r.PushName,
			Timestamp:     time.Unix(r.TS, 0),
		},
		Message: &msg,
		Ack:     r.Ack,
		Source:  r.Source,
	}
	if m.Source == "history" {
		m.Source = "app"
	}
	if r.SenderAlt != "" {
		m.Info.SenderAlt, _ = types.ParseJID(r.SenderAlt)
	}
	if r.ChatAlt != "" {
		alt, _ := types.ParseJID(r.ChatAlt)
		if r.FromMe {
			m.Info.RecipientAlt = alt
		} else {
			m.Info.SenderAlt = alt
		}
	}
	return m, nil
}
