package session

import (
	"context"
	"encoding/base64"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"

	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// BadRequest is an error caused by the caller's input (HTTP 400/422).
type BadRequest struct{ Msg string }

func (e BadRequest) Error() string { return e.Msg }

func badf(f string, a ...any) error { return BadRequest{Msg: fmt.Sprintf(f, a...)} }

// ---- sending ----

// Send delivers msg to chatID and records it like NOWEB does for API sends: message.any (source "api", ack
// PENDING), then message.ack SERVER once WhatsApp's server has accepted it.
func (s *Session) Send(ctx context.Context, chatID string, msg *waE2E.Message) (*waha.Msg, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	to, err := ParseChatID(chatID)
	if err != nil {
		return nil, badf("invalid chatId: %s", err.Error())
	}
	resp, err := cli.SendMessage(ctx, to, msg)
	if err != nil {
		return nil, fmt.Errorf("send failed: %w", err)
	}
	s.m.markSent(resp.ID)
	sender := types.EmptyJID
	if cli.Store.ID != nil {
		sender = *cli.Store.ID
	}
	m := &waha.Msg{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: to.ToNonAD(), Sender: sender, IsFromMe: true, IsGroup: to.Server == types.GroupServer},
			ID:            resp.ID,
			Timestamp:     resp.Timestamp,
			PushName:      cli.Store.PushName,
		},
		Message: msg,
		Ack:     waha.AckPending,
		Source:  "api",
	}
	if m.Info.Timestamp.IsZero() {
		m.Info.Timestamp = time.Now()
	}
	// Reactions, edits and revokes are not new messages: no history row, no message.any echo.
	if waha.IsSkippable(msg) || msg.GetReactionMessage() != nil || msg.GetProtocolMessage() != nil || msg.GetEditedMessage() != nil {
		return m, nil
	}
	stored := *m
	stored.Ack = waha.AckServer
	s.storeMessage(ctx, &stored)
	s.emit("message.any", waha.Message(m, s.renderOpts(cli, true)))
	ack := waha.Ack(to.ToNonAD(), resp.ID, waha.AckServer)
	if m.Info.IsGroup {
		ack.To = waha.CUs(to)
	}
	if s.m.firstAck(s.Name, resp.ID, waha.AckServer, "") {
		s.emit("message.ack", ack)
	}
	return m, nil
}

// WaitClient waits up to 10 s for a STARTING session to become WORKING, as WAHA does for send/read routes.
func (s *Session) WaitClient(ctx context.Context) (*whatsmeow.Client, error) {
	deadline := time.Now().Add(10 * time.Second)
	for {
		cli, err := s.Client()
		if err == nil {
			return cli, nil
		}
		st := s.Status()
		if st != StatusStarting || time.Now().After(deadline) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// QuotedContext builds the reply context for a WAHA reply_to id, using the stored message when we have it.
func (s *Session) QuotedContext(ctx context.Context, replyTo string) *waE2E.ContextInfo {
	if replyTo == "" {
		return nil
	}
	k := waha.ParseMessageID(replyTo)
	ci := &waE2E.ContextInfo{StanzaID: proto.String(k.ID)}
	var chats []string
	if !k.Chat.IsEmpty() {
		chats = s.ChatAliases(ctx, k.Chat)
	}
	if row, err := s.m.DB.GetMessage(ctx, s.Name, chats, k.ID); err == nil {
		var q waE2E.Message
		if proto.Unmarshal(row.Msg, &q) == nil {
			ci.QuotedMessage = &q
		}
		if row.Sender != "" {
			ci.Participant = proto.String(row.Sender)
		}
		if strings.HasSuffix(row.Chat, "@g.us") {
			ci.RemoteJID = proto.String(row.Chat)
		}
	} else if !k.Participant.IsEmpty() {
		ci.Participant = proto.String(k.Participant.String())
	} else if !k.Chat.IsEmpty() && k.Chat.Server != types.GroupServer {
		if k.FromMe {
			if cli := s.AnyClient(); cli != nil {
				ci.Participant = proto.String(ownJID(cli).String())
			}
		} else {
			ci.Participant = proto.String(k.Chat.ToNonAD().String())
		}
	}
	if ci.QuotedMessage == nil {
		ci.QuotedMessage = &waE2E.Message{Conversation: proto.String("")}
	}
	return ci
}

func mentionsContext(ci *waE2E.ContextInfo, mentions []string) *waE2E.ContextInfo {
	if len(mentions) == 0 {
		return ci
	}
	if ci == nil {
		ci = &waE2E.ContextInfo{}
	}
	for _, m := range mentions {
		if j, err := ParseChatID(m); err == nil {
			ci.MentionedJID = append(ci.MentionedJID, j.String())
		}
	}
	return ci
}

func (s *Session) SendText(ctx context.Context, chatID, text, replyTo string, mentions []string, linkPreview *bool) (*waha.Msg, error) {
	ci := mentionsContext(s.QuotedContext(ctx, replyTo), mentions)
	// Baileys sends every text as an extendedTextMessage.
	ext := &waE2E.ExtendedTextMessage{Text: proto.String(text), ContextInfo: ci}
	if s.m.Cfg.LinkPreview && (linkPreview == nil || *linkPreview) {
		if p := fetchPreview(ctx, text); p != nil {
			ext.MatchedText = proto.String(p.URL)
			ext.Title = proto.String(p.Title)
			ext.Description = proto.String(p.Description)
			ext.PreviewType = waE2E.ExtendedTextMessage_NONE.Enum()
			if len(p.Thumb) > 0 {
				ext.JPEGThumbnail = p.Thumb
				ext.ThumbnailWidth, ext.ThumbnailHeight = proto.Uint32(uint32(p.ThumbW)), proto.Uint32(uint32(p.ThumbH))
			}
		}
	}
	return s.Send(ctx, chatID, &waE2E.Message{ExtendedTextMessage: ext})
}

// FileInput mirrors WAHA's file object.
type FileInput struct {
	URL      string `json:"url,omitempty"`
	Data     string `json:"data,omitempty"`
	Mimetype string `json:"mimetype,omitempty"`
	Filename string `json:"filename,omitempty"`
}

// SendMedia uploads the file and sends it as kind: image, video, voice or file.
func (s *Session) SendMedia(ctx context.Context, kind, chatID string, file FileInput, caption, replyTo string) (*waha.Msg, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	if file.URL == "" && file.Data == "" {
		return nil, badf("file.url or file.data is required")
	}
	var data []byte
	if file.Data != "" {
		data, err = base64.StdEncoding.DecodeString(strings.TrimSpace(file.Data))
		if err != nil {
			return nil, badf("file.data is not valid base64")
		}
		if int64(len(data)) > s.m.Cfg.MediaMaxBytes {
			return nil, badf("file is larger than %d MB", s.m.Cfg.MediaMaxBytes>>20)
		}
	}
	f, ctype, err := s.fetchToFile(ctx, file.URL, data, s.m.Cfg.MediaMaxBytes)
	if err != nil {
		return nil, badf("%s", err.Error())
	}
	defer func() { _ = f.Close(); _ = os.Remove(f.Name()) }()
	mime := file.Mimetype
	if mime == "" {
		mime = strings.TrimSpace(strings.Split(ctype, ";")[0])
	}
	if mime == "" || mime == "application/octet-stream" {
		head := make([]byte, 512)
		n, _ := f.Read(head)
		mime = http.DetectContentType(head[:n])
		_, _ = f.Seek(0, 0)
	}
	mt := whatsmeow.MediaDocument
	switch kind {
	case "image":
		mt = whatsmeow.MediaImage
	case "video":
		mt = whatsmeow.MediaVideo
	case "voice":
		mt = whatsmeow.MediaAudio
		if mime == "" || strings.HasPrefix(mime, "audio/ogg") || mime == "application/ogg" {
			mime = "audio/ogg; codecs=opus"
		}
	}
	var width, height uint32
	var thumb []byte
	if kind == "image" {
		if c, _, err := image.DecodeConfig(f); err == nil {
			width, height = uint32(c.Width), uint32(c.Height)
		}
		_, _ = f.Seek(0, 0)
		// A small JPEG thumbnail, as Baileys sends, so the chat shows the picture before it downloads.
		thumb, _, _ = jpegThumbnail(f, 64)
		_, _ = f.Seek(0, 0)
	}
	up, err := cli.UploadReader(ctx, f, nil, mt)
	if err != nil {
		return nil, fmt.Errorf("upload failed: %w", err)
	}
	ci := s.QuotedContext(ctx, replyTo)
	msg := &waE2E.Message{}
	switch kind {
	case "image":
		msg.ImageMessage = &waE2E.ImageMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(mime), ContextInfo: ci,
		}
		if width > 0 && height > 0 {
			msg.ImageMessage.Width, msg.ImageMessage.Height = proto.Uint32(width), proto.Uint32(height)
		}
		if len(thumb) > 0 {
			msg.ImageMessage.JPEGThumbnail = thumb
		}
		if caption != "" {
			msg.ImageMessage.Caption = proto.String(caption)
		}
	case "video":
		msg.VideoMessage = &waE2E.VideoMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(mime), ContextInfo: ci,
		}
		if caption != "" {
			msg.VideoMessage.Caption = proto.String(caption)
		}
	case "voice":
		msg.AudioMessage = &waE2E.AudioMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(mime), PTT: proto.Bool(true), ContextInfo: ci,
		}
	default:
		name := file.Filename
		if name == "" {
			name = "file"
		}
		doc := &waE2E.DocumentMessage{
			URL: proto.String(up.URL), DirectPath: proto.String(up.DirectPath), MediaKey: up.MediaKey,
			FileEncSHA256: up.FileEncSHA256, FileSHA256: up.FileSHA256, FileLength: proto.Uint64(up.FileLength),
			Mimetype: proto.String(mime), FileName: proto.String(name), Title: proto.String(name), ContextInfo: ci,
		}
		if caption != "" {
			doc.Caption = proto.String(caption)
			msg.DocumentWithCaptionMessage = &waE2E.FutureProofMessage{Message: &waE2E.Message{DocumentMessage: doc}}
		} else {
			msg.DocumentMessage = doc
		}
	}
	return s.Send(ctx, chatID, msg)
}

func (s *Session) SendLocation(ctx context.Context, chatID string, lat, lng float64, title, address, replyTo string) (*waha.Msg, error) {
	loc := &waE2E.LocationMessage{DegreesLatitude: proto.Float64(lat), DegreesLongitude: proto.Float64(lng), ContextInfo: s.QuotedContext(ctx, replyTo)}
	if title != "" {
		loc.Name = proto.String(title)
	}
	if address != "" {
		loc.Address = proto.String(address)
	}
	return s.Send(ctx, chatID, &waE2E.Message{LocationMessage: loc})
}

// VCard is one entry of WAHA's contacts array: a raw vcard, or the fields to build one.
type VCard struct {
	Vcard        string `json:"vcard,omitempty"`
	FullName     string `json:"fullName,omitempty"`
	Organization string `json:"organization,omitempty"`
	PhoneNumber  string `json:"phoneNumber,omitempty"`
	WhatsappID   string `json:"whatsappId,omitempty"`
}

func (v VCard) text() (name, card string) {
	if v.Vcard != "" {
		name = v.FullName
		for _, l := range strings.Split(v.Vcard, "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(l, "FN:") && name == "" {
				name = strings.TrimPrefix(l, "FN:")
			}
		}
		return name, v.Vcard
	}
	wa := v.WhatsappID
	if wa == "" {
		wa = strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, v.PhoneNumber)
	}
	lines := []string{"BEGIN:VCARD", "VERSION:3.0", "FN:" + v.FullName}
	if v.Organization != "" {
		lines = append(lines, "ORG:"+v.Organization+";")
	}
	lines = append(lines, fmt.Sprintf("TEL;type=CELL;type=VOICE;waid=%s:%s", wa, v.PhoneNumber), "END:VCARD")
	return v.FullName, strings.Join(lines, "\n")
}

func (s *Session) SendContacts(ctx context.Context, chatID string, cards []VCard, replyTo string) (*waha.Msg, error) {
	if len(cards) == 0 {
		return nil, badf("contacts is required")
	}
	ci := s.QuotedContext(ctx, replyTo)
	if len(cards) == 1 {
		name, card := cards[0].text()
		return s.Send(ctx, chatID, &waE2E.Message{ContactMessage: &waE2E.ContactMessage{DisplayName: proto.String(name), Vcard: proto.String(card), ContextInfo: ci}})
	}
	arr := &waE2E.ContactsArrayMessage{DisplayName: proto.String(fmt.Sprintf("%d contacts", len(cards))), ContextInfo: ci}
	for _, c := range cards {
		name, card := c.text()
		arr.Contacts = append(arr.Contacts, &waE2E.ContactMessage{DisplayName: proto.String(name), Vcard: proto.String(card)})
	}
	return s.Send(ctx, chatID, &waE2E.Message{ContactsArrayMessage: arr})
}

// React sets (or with "" removes) our reaction on a message given by WAHA id.
func (s *Session) React(ctx context.Context, messageID, reaction string) (*waha.Msg, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	k := waha.ParseMessageID(messageID)
	if k.Chat.IsEmpty() || k.ID == "" {
		return nil, badf("messageId must be a full WAHA message id ({fromMe}_{chatId}_{id})")
	}
	sender := k.Participant
	if sender.IsEmpty() {
		if k.FromMe {
			sender = ownJID(cli)
		} else {
			sender = k.Chat
		}
	}
	return s.Send(ctx, waha.CUs(k.Chat), cli.BuildReaction(k.Chat, sender, k.ID, reaction))
}

// Edit replaces the text of one of our messages; returns the edit message (NOWEB returns its WebMessageInfo).
func (s *Session) Edit(ctx context.Context, chatID, messageID, text string) (*waha.Msg, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	chat, err := ParseChatID(chatID)
	if err != nil {
		return nil, badf("invalid chatId")
	}
	k := waha.ParseMessageID(messageID)
	if !k.Chat.IsEmpty() {
		chat = k.Chat
	}
	edit := cli.BuildEdit(chat, k.ID, &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text)}})
	m, err := s.Send(ctx, waha.CUs(chat), edit)
	if err != nil {
		return nil, err
	}
	b, _ := proto.Marshal(&waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(text)}})
	_ = s.m.DB.UpdateMessageBody(ctx, s.Name, s.ChatAliases(ctx, chat), k.ID, b)
	return m, nil
}

// Seen marks messages read: the given ids (our own skipped), or else the chat's unread incoming messages of the
// last 7 days (30 for a DM, 100 for a group). Returns the WAHA ids it marked when it chose them itself.
func (s *Session) Seen(ctx context.Context, chatID string, messageIDs []string, participant string) ([]string, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	chat, err := ParseChatID(chatID)
	if err != nil {
		return nil, badf("invalid chatId")
	}
	aliases := s.ChatAliases(ctx, chat)
	type item struct {
		id     string
		sender types.JID
		ts     int64
	}
	var items []item
	var marked []string
	if len(messageIDs) > 0 {
		var part types.JID
		if participant != "" {
			part, _ = ParseChatID(participant)
		}
		for _, raw := range messageIDs {
			k := waha.ParseMessageID(raw)
			if k.FromMe {
				continue
			}
			sender := k.Participant
			if sender.IsEmpty() {
				sender = part
			}
			if sender.IsEmpty() && chat.Server != types.GroupServer {
				sender = chat
			}
			items = append(items, item{id: k.ID, sender: sender, ts: time.Now().Unix()})
		}
	} else if s.m.Cfg.StoreMessages {
		var after int64
		if c, err := s.m.DB.GetChat(ctx, s.Name, aliases); err == nil {
			after = c.ReadUpto
		}
		week := time.Now().Add(-7 * 24 * time.Hour).Unix()
		if after < week {
			after = week
		}
		limit := 30
		if chat.Server == types.GroupServer {
			limit = 100
		}
		rows, err := s.m.DB.UnreadIncoming(ctx, s.Name, aliases, after, limit)
		if err != nil {
			return nil, err
		}
		marked = []string{}
		for _, r := range rows {
			sender, _ := types.ParseJID(r.Sender)
			items = append(items, item{id: r.ID, sender: sender, ts: r.TS})
			if m, err := waha.FromRow(r); err == nil {
				marked = append(marked, waha.MessageID(m))
			}
		}
	}
	if len(items) == 0 {
		return marked, nil
	}
	// One receipt per sender (groups have many).
	bySender := map[types.JID][]types.MessageID{}
	var newest int64
	for _, it := range items {
		bySender[it.sender] = append(bySender[it.sender], it.id)
		if it.ts > newest {
			newest = it.ts
		}
	}
	for sender, ids := range bySender {
		if chat.Server != types.GroupServer {
			sender = types.EmptyJID
		}
		if err := cli.MarkRead(ctx, ids, time.Now(), chat, sender); err != nil {
			return nil, err
		}
	}
	if s.m.Cfg.StoreMessages {
		_ = s.m.DB.MarkChatRead(ctx, s.Name, aliases, newest)
	}
	return marked, nil
}

// Typing sends composing or paused for a chat.
func (s *Session) Typing(ctx context.Context, chatID string, on bool) error {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return err
	}
	chat, err := ParseChatID(chatID)
	if err != nil {
		return badf("invalid chatId")
	}
	if on {
		// WhatsApp only relays chat state from a client that is "available".
		s.markOnline(cli, false)
		return cli.SendChatPresence(ctx, chat, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	}
	return cli.SendChatPresence(ctx, chat, types.ChatPresencePaused, types.ChatPresenceMediaText)
}

// ---- reading ----

func (s *Session) contactName(ctx context.Context, cli *whatsmeow.Client, j types.JID) string {
	if cli == nil || cli.Store == nil || cli.Store.ID == nil {
		return ""
	}
	// Read the table directly: whatsmeow's GetContact caches every looked-up contact for the process's life.
	c, err := s.m.DB.GetContact(ctx, *cli.Store.ID, j)
	if err != nil || !c.Found {
		return ""
	}
	switch {
	case c.FullName != "":
		return c.FullName
	case c.FirstName != "":
		return c.FirstName
	case c.BusinessName != "":
		return c.BusinessName
	default:
		return c.PushName
	}
}

// chatName finds a display name: stored chat name (groups), the contact book, or the group's info.
func (s *Session) chatName(ctx context.Context, cli *whatsmeow.Client, c *gwstore.ChatRow) string {
	if c.Name != "" {
		return c.Name
	}
	j, err := types.ParseJID(c.Chat)
	if err != nil {
		return ""
	}
	if j.Server == types.GroupServer {
		if cli != nil && cli.IsLoggedIn() {
			gctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if name, err := groupSubject(gctx, cli, j); err == nil && name != "" {
				_ = s.m.DB.SetChatName(ctx, s.Name, c.Chat, name)
				return name
			}
		}
		return ""
	}
	if n := s.contactName(ctx, cli, j); n != "" {
		return n
	}
	if j.Server == types.HiddenUserServer {
		if pn, err := s.m.DB.LIDs.GetPNForLID(ctx, j); err == nil && !pn.IsEmpty() {
			return s.contactName(ctx, cli, pn)
		}
	}
	return ""
}

// groupSubject asks WhatsApp for a group's subject. It sends the same query as cli.GetGroupInfo but skips that
// method's side effect: GetGroupInfo keeps the full member list of every group it fetched in a per-client cache
// for the life of the connection (100 groups x 200 members is ~800 KB on one account), and the chats listing would
// fill it for every unnamed group. The name is stored in gw_chats after the first lookup.
func groupSubject(ctx context.Context, cli *whatsmeow.Client, j types.JID) (string, error) {
	//nolint:staticcheck // DangerousInternals is the only way to send this IQ without the caching wrapper.
	res, err := cli.DangerousInternals().SendGroupIQ(ctx, "get", j, waBinary.Node{Tag: "query", Attrs: waBinary.Attrs{"request": "interactive"}})
	if err != nil {
		return "", err
	}
	g, ok := res.GetOptionalChildByTag("group")
	if !ok {
		return "", fmt.Errorf("no group in response")
	}
	return g.AttrGetter().OptionalString("subject"), nil
}

// ChatRows returns stored chats with resolved names and last messages.
func (s *Session) ChatRows(ctx context.Context, limit, offset int, asc bool) ([]*waha.ChatView, error) {
	rows, err := s.m.DB.ListChats(ctx, s.Name, limit, offset, asc)
	if err != nil {
		return nil, err
	}
	cli := s.AnyClient()
	out := make([]*waha.ChatView, 0, len(rows))
	for _, c := range rows {
		v := &waha.ChatView{Row: c, Name: s.chatName(ctx, cli, c)}
		if j, err := types.ParseJID(c.Chat); err == nil {
			v.JID = j
			if pic, ok := s.m.pics.get(s.Name + "|" + c.Chat); ok {
				v.Picture = pic
			}
		}
		if c.LastID != "" {
			if r, err := s.m.DB.GetMessage(ctx, s.Name, []string{c.Chat}, c.LastID); err == nil {
				if m, err := waha.FromRow(r); err == nil {
					v.Last = m
				}
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// Messages lists a chat's stored messages, newest first.
func (s *Session) Messages(ctx context.Context, chatID string, f gwstore.MessageFilter) ([]*waha.Msg, error) {
	chat, err := ParseChatID(chatID)
	if err != nil {
		return nil, badf("invalid chatId")
	}
	rows, err := s.m.DB.ListMessages(ctx, s.Name, s.ChatAliases(ctx, chat), f)
	if err != nil {
		return nil, err
	}
	out := make([]*waha.Msg, 0, len(rows))
	for _, r := range rows {
		if m, err := waha.FromRow(r); err == nil {
			out = append(out, m)
		}
	}
	return out, nil
}

func (s *Session) Message(ctx context.Context, chatID, messageID string) (*waha.Msg, error) {
	k := waha.ParseMessageID(messageID)
	var chats []string
	if chatID != "" {
		if chat, err := ParseChatID(chatID); err == nil {
			chats = s.ChatAliases(ctx, chat)
		}
	}
	r, err := s.m.DB.GetMessage(ctx, s.Name, chats, k.ID)
	if err != nil {
		return nil, err
	}
	return waha.FromRow(r)
}

// RenderOpts is for HTTP reads of stored messages (NOWEB store encoding).
func (s *Session) RenderOpts(downloadMedia bool) *waha.Opts {
	o := s.renderOpts(s.AnyClient(), downloadMedia)
	o.Enc = waha.EncStore
	return o
}

// Contacts lists the account's address book and push names, sorted by id.
func (s *Session) Contacts(ctx context.Context, limit, offset int) ([]*waha.ContactView, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	if cli.Store.ID == nil {
		return nil, whatsmeow.ErrNotLoggedIn
	}
	// SQL, not cli.Store.Contacts.GetAllContacts: that copies every contact into whatsmeow's per-device cache
	// forever (+~430 KB per listed account at 1,122 contacts).
	rows, err := s.m.DB.ListContacts(ctx, *cli.Store.ID, limit, offset)
	if err != nil {
		return nil, err
	}
	out := make([]*waha.ContactView, 0, len(rows))
	var lids []types.JID
	for _, r := range rows {
		if r.JID.Server == types.DefaultUserServer {
			lids = append(lids, r.JID)
		}
	}
	pnToLID, _ := s.m.DB.LIDs.GetManyLIDsForPNs(ctx, lids)
	for _, r := range rows {
		j := r.JID
		v := &waha.ContactView{JID: j, Info: r.Info}
		switch j.Server {
		case types.DefaultUserServer:
			v.PN = j
			v.LID = pnToLID[j]
		case types.HiddenUserServer:
			v.LID = j
			if pn, err := s.m.DB.LIDs.GetPNForLID(ctx, j); err == nil {
				v.PN = pn
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// CheckExists asks WhatsApp whether phone (digits) has an account.
func (s *Session) CheckExists(ctx context.Context, phone string) (bool, types.JID, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return false, types.EmptyJID, err
	}
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.Split(phone, "@")[0])
	if digits == "" {
		return false, types.EmptyJID, badf("phone is required")
	}
	res, err := cli.IsOnWhatsApp(ctx, []string{"+" + digits})
	if err != nil {
		return false, types.EmptyJID, err
	}
	for _, r := range res {
		if !r.IsIn {
			continue
		}
		// NOWEB answers with the phone-number chat id; whatsmeow's canonical JID can be the LID.
		if !r.PhoneNumber.IsEmpty() {
			return true, r.PhoneNumber, nil
		}
		if r.JID.Server == types.HiddenUserServer {
			if pn, err := s.m.DB.LIDs.GetPNForLID(ctx, r.JID); err == nil && !pn.IsEmpty() {
				return true, pn, nil
			}
			return true, types.NewJID(digits, types.DefaultUserServer), nil
		}
		return true, r.JID, nil
	}
	return false, types.EmptyJID, nil
}

// ProfilePicture returns the contact's picture URL ("" when hidden or none), cached for a few hours.
func (s *Session) ProfilePicture(ctx context.Context, contactID string, refresh bool) (string, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return "", err
	}
	j, err := ParseChatID(contactID)
	if err != nil {
		return "", badf("invalid contactId")
	}
	key := s.Name + "|" + j.ToNonAD().String()
	if v, ok := s.m.pics.get(key); ok && !refresh {
		return v, nil
	}
	info, err := cli.GetProfilePictureInfo(ctx, j.ToNonAD(), &whatsmeow.GetProfilePictureParams{Preview: false})
	url := ""
	if err == nil && info != nil {
		url = info.URL
	} else if err != nil && err != whatsmeow.ErrProfilePictureUnauthorized && err != whatsmeow.ErrProfilePictureNotSet {
		return "", err
	}
	s.m.pics.set(key, url, s.m.Cfg.ProfilePicTTL)
	return url, nil
}

// LIDPair returns the (lid, pn) pair for either side; empty when unknown.
func (s *Session) LIDPair(ctx context.Context, id string) (lid, pn types.JID, err error) {
	if !strings.Contains(id, "@") {
		id += "@lid"
	}
	j, err := ParseChatID(id)
	if err != nil {
		return types.EmptyJID, types.EmptyJID, badf("invalid id")
	}
	j = j.ToNonAD()
	m := s.m.DB.LIDs
	if j.Server == types.HiddenUserServer {
		p, err := m.GetPNForLID(ctx, j)
		return j, p, err
	}
	l, err := m.GetLIDForPN(ctx, j)
	return l, j, err
}
