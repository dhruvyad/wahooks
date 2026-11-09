package session

import (
	"context"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"

	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// handle receives every whatsmeow event of one client. Events of a replaced client (older gen) are ignored.
func (s *Session) handle(gen uint64, cli *whatsmeow.Client, evt any) {
	if s.gen.Load() != gen {
		return
	}
	defer recoverLog(s.m.Log, s.Name, "event")
	ctx := context.Background()
	switch e := evt.(type) {
	case *events.QR:
		s.mu.Lock()
		s.qr = append([]string(nil), e.Codes...)
		s.qrAt = time.Now()
		s.qrShown = 0
		s.rotating = false
		s.mu.Unlock()
		s.setStatus(StatusScanQR, "", true)
	case *events.PairSuccess:
		s.setDeviceJID(ctx, e.ID.String())
		s.m.Log.Info("device linked", "session", s.Name, "platform", e.Platform)
		// Scanned: WhatsApp restarts the stream and whatsmeow reconnects; NOWEB shows STARTING until WORKING.
		s.mu.Lock()
		s.qr = nil
		s.mu.Unlock()
		s.setStatus(StatusStarting, "", true)
	case *events.PairError:
		s.m.Log.Warn("pairing failed", "session", s.Name, "err", e.Error.Error())
	case *events.Connected:
		if cli.Store.ID != nil && s.deviceJID() != cli.Store.ID.String() {
			s.setDeviceJID(ctx, cli.Store.ID.String())
		}
		s.m.Counters.Connects.Add(1)
		s.mu.Lock()
		s.qr = nil
		s.mu.Unlock()
		s.setStatus(StatusWorking, "", true)
		if s.m.Cfg.MarkOnline {
			go s.markOnline(cli, true)
		}
	case *events.Disconnected:
		s.m.Counters.Disconnects.Add(1)
		if s.Status() == StatusWorking {
			s.setStatus(StatusStarting, "reconnecting", true)
		}
	case *events.KeepAliveTimeout:
		if e.ErrorCount >= 3 {
			s.m.Log.Info("keepalive timeouts", "session", s.Name, "count", e.ErrorCount)
		}
	case *events.LoggedOut:
		s.m.Counters.LoggedOut.Add(1)
		s.m.Log.Warn("logged out by WhatsApp", "session", s.Name, "reason", e.Reason.String(), "on_connect", e.OnConnect)
		s.setDeviceJID(ctx, "")
		s.fail(gen, "logged out")
	case *events.StreamReplaced:
		// Another client connected with the same credentials. Reconnecting would fight it, so stop here.
		s.m.Counters.StreamReplaced.Add(1)
		s.fail(gen, "replaced by another client")
	case *events.TemporaryBan:
		s.m.Counters.Bans.Add(1)
		s.m.Log.Warn("temporary ban", "session", s.Name, "code", int(e.Code), "expire_s", int(e.Expire.Seconds()))
		s.fail(gen, "temporary ban")
	case *events.ConnectFailure:
		s.m.Log.Warn("connect failure", "session", s.Name, "reason", int(e.Reason))
		s.fail(gen, "connect failure")
	case *events.ClientOutdated:
		s.m.Log.Error("WhatsApp rejected the client version (405): bump whatsmeow", "session", s.Name)
		s.fail(gen, "client outdated")
	case *events.StreamError:
		s.m.Log.Warn("stream error", "session", s.Name, "code", e.Code)
	case *events.Message:
		s.onMessage(ctx, cli, e, "app")
	case *events.Receipt:
		s.onReceipt(ctx, cli, e)
	case *events.ChatPresence:
		s.emit("presence.update", waha.ChatPresence(e))
	case *events.Presence:
		s.emit("presence.update", waha.Presence(e))
	case *events.HistorySync:
		s.onHistory(ctx, cli, e)
	case *events.JoinedGroup:
		s.emit("group.v2.join", waha.GroupJoin(&e.GroupInfo))
	case *events.GroupInfo:
		s.onGroupInfo(cli, e)
	case *events.CallOffer:
		s.emit("call.received", waha.Call(e.CallID, e.From, e.Timestamp, isVideoCall(e.Data), isGroupCall(e.GroupJID), "offer"))
	case *events.CallAccept:
		s.emit("call.accepted", waha.Call(e.CallID, e.From, e.Timestamp, isVideoCall(e.Data), isGroupCall(e.GroupJID), "accept"))
	case *events.CallReject:
		s.emit("call.rejected", waha.Call(e.CallID, e.From, e.Timestamp, false, isGroupCall(e.GroupJID), "reject"))
	case *events.CallTerminate:
		if !strings.HasSuffix(e.Reason, "_elsewhere") && e.Reason != "accepted" {
			s.emit("call.rejected", waha.Call(e.CallID, e.From, e.Timestamp, false, isGroupCall(e.GroupJID), "terminate"))
		}
	case *events.Archive:
		if e.Action != nil {
			s.updateArchive(ctx, e)
		}
	}
}

func isGroupCall(j types.JID) bool { return !j.IsEmpty() }

func isVideoCall(n *waBinary.Node) bool {
	if n == nil {
		return false
	}
	for _, c := range n.GetChildren() {
		if c.Tag == "video" {
			return true
		}
	}
	return false
}

// updateArchive keeps the chat's archived flag (NOWEB emits no chat.archive event).
func (s *Session) updateArchive(ctx context.Context, e *events.Archive) {
	if !s.m.Cfg.StoreMessages {
		return
	}
	_, _ = s.m.DB.SQL.ExecContext(ctx, `UPDATE gw_chats SET archived=$1 WHERE session=$2 AND chat=$3`, b2i(e.Action.GetArchived()), s.Name, e.JID.ToNonAD().String())
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Session) markOnline(cli *whatsmeow.Client, force bool) {
	defer recoverLog(s.m.Log, s.Name, "presence")
	s.mu.Lock()
	recent := time.Since(s.onlineAt) < 4*time.Minute
	s.mu.Unlock()
	if recent && !force {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := cli.SendPresence(ctx, types.PresenceAvailable); err == nil {
		s.mu.Lock()
		s.onlineAt = time.Now()
		s.mu.Unlock()
	}
}

// onMessage stores a live message and emits NOWEB's events for it.
func (s *Session) onMessage(ctx context.Context, cli *whatsmeow.Client, e *events.Message, source string) {
	msg := e.Message
	if msg == nil {
		return
	}
	me, meLID := ownJID(cli), ownLID(cli)
	// Reactions, revokes and edits are their own events in WAHA, not new messages.
	if r := msg.GetReactionMessage(); r != nil {
		s.emit("message.reaction", waha.Reaction(&e.Info, r, me, meLID))
		return
	}
	if pm := msg.GetProtocolMessage(); pm != nil {
		switch pm.GetType() {
		case waE2E.ProtocolMessage_REVOKE:
			s.emit("message.revoked", waha.Revoked(&e.Info, msg, pm, s.renderOpts(cli, false)))
			return
		case waE2E.ProtocolMessage_MESSAGE_EDIT:
			if edited := pm.GetEditedMessage(); edited != nil {
				s.storeEdit(ctx, e, pm, edited)
				s.emit("message.edited", waha.Edited(&e.Info, msg, pm, s.renderOpts(cli, false)))
			}
			return
		default:
			return // app state keys, history notifications, ephemeral settings and the like
		}
	}
	if msg.GetPollUpdateMessage() != nil {
		s.onPollVote(ctx, cli, e)
		return
	}
	if msg.GetEncReactionMessage() != nil || msg.GetKeepInChatMessage() != nil {
		return
	}
	if s.ignored(e.Info.Chat) {
		return // config.ignore: status, groups, channels, broadcast (WAHA's JidFilter)
	}
	if waha.IsSkippable(msg) {
		return
	}
	// NOWEB drops a message seen again within 60 s (whatsmeow can redeliver after a retry receipt).
	if !s.m.firstSeen(s.Name, e.Info.IsFromMe, e.Info.ID) {
		return
	}
	m := &waha.Msg{Info: e.Info, Message: msg, Source: source, Ack: waha.AckDevice}
	if e.Info.IsFromMe {
		m.Ack = waha.AckServer
		if s.m.sentRecently(e.Info.ID) {
			m.Source = "api"
		}
	}
	s.storeMessage(ctx, m)
	payload := waha.Message(m, s.renderOpts(cli, true))
	if !e.Info.IsFromMe {
		s.emit("message", payload)
	}
	s.emit("message.any", payload)
}

// onPollVote decrypts a vote and emits poll.vote with the chosen option names (poll.vote.failed when the vote
// can't be decrypted or the poll isn't in history).
func (s *Session) onPollVote(ctx context.Context, cli *whatsmeow.Client, e *events.Message) {
	pu := e.Message.GetPollUpdateMessage()
	key := pu.GetPollCreationMessageKey()
	me, meLID := ownJID(cli), ownLID(cli)
	selected := []string{}
	failed := true
	if vote, err := cli.DecryptPollVote(ctx, e); err == nil {
		if row, err := s.m.DB.GetMessage(ctx, s.Name, s.ChatAliases(ctx, e.Info.Chat), key.GetID()); err == nil {
			if pm, err := waha.FromRow(row); err == nil {
				names := waha.PollOptions(pm.Message)
				hashes := whatsmeow.HashPollOptions(names)
				for _, sel := range vote.GetSelectedOptions() {
					for i, h := range hashes {
						if string(h) == string(sel) {
							selected = append(selected, names[i])
						}
					}
				}
				failed = false
			}
		}
	}
	event := "poll.vote"
	if failed {
		event = "poll.vote.failed"
	}
	s.emit(event, waha.PollVote(&e.Info, key, selected, failed, me, meLID))
}

func ownLID(cli *whatsmeow.Client) types.JID {
	if cli == nil || cli.Store == nil {
		return types.EmptyJID
	}
	return cli.Store.LID.ToNonAD()
}

func ownJID(cli *whatsmeow.Client) types.JID {
	if cli == nil || cli.Store == nil || cli.Store.ID == nil {
		return types.EmptyJID
	}
	return cli.Store.ID.ToNonAD()
}

// renderOpts is for webhook payloads (protobufjs toJSON encoding).
func (s *Session) renderOpts(cli *whatsmeow.Client, downloadMedia bool) *waha.Opts {
	return &waha.Opts{
		BaseURL:       s.m.Cfg.BaseURL,
		Session:       s.Name,
		Me:            ownJID(cli),
		MeLID:         ownLID(cli),
		DownloadMedia: downloadMedia,
		Enc:           waha.EncWebhook,
	}
}

func (s *Session) storeMessage(ctx context.Context, m *waha.Msg) {
	if !s.m.Cfg.StoreMessages {
		return
	}
	row, err := waha.ToRow(s.Name, m)
	if err != nil {
		return
	}
	if err := s.m.DB.StoreLive(ctx, row, !m.Info.IsFromMe); err != nil {
		s.m.Log.Warn("storing message failed", "session", s.Name, "err", err.Error())
	}
}

func (s *Session) storeEdit(ctx context.Context, e *events.Message, pm *waE2E.ProtocolMessage, edited *waE2E.Message) {
	if !s.m.Cfg.StoreMessages {
		return
	}
	id := pm.GetKey().GetID()
	if id == "" {
		return
	}
	b, err := proto.Marshal(waha.StripForStorage(edited))
	if err != nil {
		return
	}
	_ = s.m.DB.UpdateMessageBody(ctx, s.Name, s.ChatAliases(ctx, e.Info.Chat), id, b)
}

// onReceipt turns receipts for our messages into message.ack (DMs) or message.ack.group (one per reader).
func (s *Session) onReceipt(ctx context.Context, cli *whatsmeow.Client, e *events.Receipt) {
	if e.IsGroup {
		if e.IsFromMe {
			return
		}
		ack, ok := waha.AckFromReceiptGroup(e.Type)
		if !ok {
			return
		}
		me := ownJID(cli)
		for _, id := range e.MessageIDs {
			if s.m.firstAck(s.Name, id, ack, e.Sender.ToNonAD().String()) {
				s.emit("message.ack.group", waha.AckGroup(e, id, ack, me))
			}
		}
		return
	}
	ack, ok := waha.AckFromReceipt(e.Type)
	if !ok {
		return
	}
	// A receipt from someone else, or from our own device ("sender"), for one of our messages.
	if e.IsFromMe && e.Type != types.ReceiptTypeSender {
		return // our own read/played on another device
	}
	if s.m.Cfg.StoreMessages && ack > 0 {
		_ = s.m.DB.RaiseAck(ctx, s.Name, s.ChatAliases(ctx, e.Chat), e.MessageIDs, ack)
	}
	for _, id := range e.MessageIDs {
		if s.m.firstAck(s.Name, id, ack, "") {
			s.emit("message.ack", waha.Ack(e.Chat, id, ack))
		}
	}
}

// onHistory stores what a history sync sends: chats and their newest messages (bounded). No events are emitted
// for history, as in WAHA.
func (s *Session) onHistory(ctx context.Context, cli *whatsmeow.Client, e *events.HistorySync) {
	if !s.m.Cfg.StoreMessages || e.Data == nil {
		return
	}
	// At most a few history syncs are turned into rows at once, box-wide: many accounts linking together must not
	// each hold a parsed history plus its rows in memory at the same time. (whatsmeow's own download and parse of
	// the blob happens before this event, one at a time per account.)
	s.m.histSem <- struct{}{}
	defer func() { <-s.m.histSem }()
	perChat := s.m.Cfg.HistoryPerChat
	cutoff := time.Now().Add(-s.m.Cfg.MessageRetention).Unix()
	var rows []*gwstore.MessageRow
	for _, conv := range e.Data.GetConversations() {
		chat, err := types.ParseJID(conv.GetID())
		if err != nil || chat.Server == types.BroadcastServer {
			continue
		}
		c := &gwstore.ChatRow{
			Session:      s.Name,
			Chat:         chat.ToNonAD().String(),
			Name:         conv.GetName(),
			LastTS:       int64(conv.GetConversationTimestamp()),
			Unread:       int(conv.GetUnreadCount()),
			MarkedUnread: conv.GetMarkedAsUnread(),
			Archived:     conv.GetArchived(),
		}
		n := 0
		var newest *gwstore.MessageRow
		for _, hm := range conv.GetMessages() {
			if perChat > 0 && n >= perChat {
				break
			}
			evt, err := cli.ParseWebMessage(chat, hm.GetMessage())
			if err != nil || evt.Message == nil {
				continue
			}
			if evt.Message.GetProtocolMessage() != nil || evt.Message.GetReactionMessage() != nil || waha.IsSkippable(evt.Message) {
				continue
			}
			if evt.Info.Timestamp.Unix() < cutoff {
				continue
			}
			m := &waha.Msg{Info: evt.Info, Message: evt.Message, Ack: waha.AckFromWebStatus(hm.GetMessage().GetStatus(), evt.Info.IsFromMe), Source: "app"}
			row, err := waha.ToRow(s.Name, m)
			if err != nil {
				continue
			}
			row.Source = "history"
			rows = append(rows, row)
			n++
			if newest == nil || row.TS > newest.TS {
				newest = row
			}
		}
		if newest != nil {
			if c.LastTS < newest.TS {
				c.LastTS = newest.TS
			}
			c.LastID = newest.ID
		}
		if err := s.m.DB.PutChatMeta(ctx, c); err != nil {
			s.m.Log.Warn("history chat failed", "session", s.Name, "err", err.Error())
		}
		if len(rows) >= 500 {
			if err := s.m.DB.PutMessages(ctx, rows); err != nil {
				s.m.Log.Warn("history messages failed", "session", s.Name, "err", err.Error())
			}
			rows = rows[:0]
		}
	}
	if err := s.m.DB.PutMessages(ctx, rows); err != nil {
		s.m.Log.Warn("history messages failed", "session", s.Name, "err", err.Error())
	}
	s.m.Log.Info("history sync stored", "session", s.Name, "type", e.Data.GetSyncType().String(), "chats", len(e.Data.GetConversations()))
}

func (s *Session) onGroupInfo(cli *whatsmeow.Client, e *events.GroupInfo) {
	if len(e.Join) > 0 {
		s.emit("group.v2.participants", waha.GroupParticipants(e, "join", e.Join))
	}
	if len(e.Leave) > 0 {
		me := ownJID(cli)
		meLID := ownLID(cli)
		for _, j := range e.Leave {
			if j.User == me.User || (!meLID.IsEmpty() && j.User == meLID.User) {
				s.emit("group.v2.leave", waha.GroupLeave(e))
			}
		}
		s.emit("group.v2.participants", waha.GroupParticipants(e, "leave", e.Leave))
	}
	if len(e.Promote) > 0 {
		s.emit("group.v2.participants", waha.GroupParticipants(e, "promote", e.Promote))
	}
	if len(e.Demote) > 0 {
		s.emit("group.v2.participants", waha.GroupParticipants(e, "demote", e.Demote))
	}
	if e.Name != nil || e.Topic != nil || e.Announce != nil {
		s.emit("group.v2.update", waha.GroupUpdate(e))
	}
}

// ChatAliases lists the JIDs one chat is stored under: its phone-number JID and its LID, when known.
func (s *Session) ChatAliases(ctx context.Context, chat types.JID) []string {
	chat = chat.ToNonAD()
	out := []string{chat.String()}
	lids := s.m.DB.LIDs
	switch chat.Server {
	case types.DefaultUserServer:
		if lid, err := lids.GetLIDForPN(ctx, chat); err == nil && !lid.IsEmpty() {
			out = append(out, lid.String())
		}
	case types.HiddenUserServer:
		if pn, err := lids.GetPNForLID(ctx, chat); err == nil && !pn.IsEmpty() {
			out = append(out, pn.String())
		}
	}
	return out
}

// ParseChatID accepts WAHA chat ids (digits@c.us, @s.whatsapp.net, @g.us, @lid, @newsletter, bare digits).
func ParseChatID(id string) (types.JID, error) {
	id = strings.TrimSpace(id)
	if !strings.Contains(id, "@") {
		id = strings.TrimPrefix(id, "+") + "@" + types.DefaultUserServer
	}
	id = strings.Replace(id, "@c.us", "@"+types.DefaultUserServer, 1)
	return types.ParseJID(id)
}
