package waha

import (
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
)

// AckPayload is message.ack for DMs (NOWEB: no _data).
type AckPayload struct {
	ID          string `json:"id"`
	From        string `json:"from"`
	To          string `json:"to,omitempty"`
	Participant string `json:"participant,omitempty"`
	FromMe      bool   `json:"fromMe"`
	Ack         int    `json:"ack"`
	AckName     string `json:"ackName"`
}

// Ack renders message.ack for one of our messages in a DM.
func Ack(chat types.JID, id string, ack int) *AckPayload {
	return &AckPayload{ID: SerializeID(true, chat, id, types.EmptyJID), From: CUs(chat), FromMe: true, Ack: ack, AckName: AckName(ack)}
}

// AckGroup renders message.ack.group: one reader's receipt for our message in a group.
func AckGroup(e *events.Receipt, id string, ack int, me types.JID) OM {
	receipt := OM{{"userJid", SWA(e.Sender)}}
	if ack == AckServer {
		receipt = append(receipt, KV{"receiptTimestamp", e.Timestamp.Unix()})
	} else {
		receipt = append(receipt, KV{"readTimestamp", e.Timestamp.Unix()})
	}
	return OM{
		{"id", SerializeID(true, e.Chat, id, me)},
		{"from", CUs(e.Chat)},
		{"to", CUs(e.Chat)},
		{"participant", CUs(e.Sender)},
		{"fromMe", true},
		{"ack", ack},
		{"ackName", AckName(ack)},
		{"_data", OM{
			{"key", OM{{"remoteJid", SWA(e.Chat)}, {"id", id}, {"fromMe", true}, {"participant", SWA(e.Sender)}}},
			{"receipt", receipt},
		}},
	}
}

func isMe(j, me, meLID types.JID) bool {
	return !j.IsEmpty() && ((!me.IsEmpty() && j.User == me.User && j.Server == me.Server) || (!meLID.IsEmpty() && j.User == meLID.User && j.Server == meLID.Server))
}

// Reaction renders message.reaction. The reacted message's key is turned to our perspective as Baileys does.
func Reaction(info *types.MessageInfo, r *waE2E.ReactionMessage, me, meLID types.JID) OM {
	key := r.GetKey()
	fromMe := key.GetFromMe()
	var part types.JID
	if p := key.GetParticipant(); p != "" {
		part, _ = types.ParseJID(p)
	}
	if !info.IsFromMe {
		if fromMe {
			fromMe = false
		} else {
			author := part
			if author.IsEmpty() {
				author, _ = types.ParseJID(key.GetRemoteJID())
			}
			fromMe = isMe(author, me, meLID)
		}
		if part.IsEmpty() && info.IsGroup {
			part = info.Sender
		}
	}
	if !info.IsGroup {
		part = types.EmptyJID
	}
	var ownPart types.JID
	if info.IsGroup {
		ownPart = info.Sender
	}
	out := OM{
		{"id", SerializeID(info.IsFromMe, info.Chat, info.ID, ownPart)},
		{"timestamp", info.Timestamp.Unix()},
		{"from", CUs(info.Chat)},
		{"fromMe", info.IsFromMe},
		{"source", "app"},
	}
	if info.IsGroup {
		out = append(out, KV{"to", CUs(info.Chat)}, KV{"participant", CUs(info.Sender)})
	}
	out = append(out, KV{"reaction", OM{{"text", r.GetText()}, {"messageId", SerializeID(fromMe, info.Chat, key.GetID(), part)}}})
	return out
}

// Revoked renders message.revoked: the revoke message itself as "after", the revoked id, the raw data.
func Revoked(info *types.MessageInfo, msg *waE2E.Message, pm *waE2E.ProtocolMessage, o *Opts) OM {
	m := &Msg{Info: *info, Message: msg, Source: "app", Ack: AckDevice}
	if info.IsFromMe {
		m.Ack = AckServer
	}
	after := Message(m, o)
	after.Body = nil
	return OM{
		{"after", after},
		{"before", nil},
		{"revokedMessageId", pm.GetKey().GetID()},
		{"_data", after.Data},
	}
}

// EditedPayload is message.edited: WAMessage of the edit plus editedMessageId.
type EditedPayload struct {
	*MessagePayload
	EditedMessageID string `json:"editedMessageId"`
}

// Edited renders message.edited.
func Edited(info *types.MessageInfo, msg *waE2E.Message, pm *waE2E.ProtocolMessage, o *Opts) *EditedPayload {
	m := &Msg{Info: *info, Message: msg, Source: "app", Ack: AckDevice}
	if info.IsFromMe {
		m.Ack = AckServer
	}
	p := Message(m, o)
	body := Body(pm.GetEditedMessage())
	p.Body = &body
	return &EditedPayload{MessagePayload: p, EditedMessageID: pm.GetKey().GetID()}
}

// ChatPresence renders presence.update for typing/recording/paused.
func ChatPresence(e *events.ChatPresence) OM {
	state := "paused"
	if e.State == types.ChatPresenceComposing {
		state = "typing"
		if e.Media == types.ChatPresenceMediaAudio {
			state = "recording"
		}
	}
	return OM{
		{"id", CUs(e.Chat)},
		{"presences", []OM{{{"participant", CUs(e.Sender)}, {"lastKnownPresence", state}, {"lastSeen", nil}}}},
	}
}

// Presence renders presence.update for online/offline.
func Presence(e *events.Presence) OM {
	state := "online"
	var lastSeen any
	if e.Unavailable {
		state = "offline"
		if !e.LastSeen.IsZero() {
			lastSeen = e.LastSeen.Unix()
		}
	}
	return OM{
		{"id", CUs(e.From)},
		{"presences", []OM{{{"participant", CUs(e.From)}, {"lastKnownPresence", state}, {"lastSeen", lastSeen}}}},
	}
}

func groupParticipant(id types.JID, pn types.JID, role string) OM {
	var pnv any
	if !pn.IsEmpty() {
		pnv = CUs(pn)
	} else if id.Server == types.DefaultUserServer {
		pnv = CUs(id)
	}
	return OM{{"id", CUs(id)}, {"pn", pnv}, {"role", role}}
}

func groupInfo(g *types.GroupInfo) OM {
	parts := make([]OM, 0, len(g.Participants))
	for _, p := range g.Participants {
		role := "participant"
		if p.IsSuperAdmin {
			role = "superadmin"
		} else if p.IsAdmin {
			role = "admin"
		}
		parts = append(parts, groupParticipant(p.JID, p.PhoneNumber, role))
	}
	// NOWEB passes Baileys' raw flags through: memberAddMode, announce, joinApprovalMode.
	addMode := g.MemberAddMode != types.GroupMemberAddModeAdmin
	joinMode := g.IsJoinApprovalRequired
	return OM{
		{"id", g.JID.String()},
		{"subject", g.Name},
		{"description", g.Topic},
		{"participants", parts},
		{"membersCanAddNewMember", addMode},
		{"membersCanSendMessages", g.IsAnnounce},
		{"newMembersApprovalRequired", joinMode},
	}
}

// GroupJoin renders group.v2.join.
func GroupJoin(g *types.GroupInfo) OM {
	return OM{{"timestamp", time.Now().UnixMilli()}, {"group", groupInfo(g)}, {"_data", OM{{"id", g.JID.String()}, {"subject", g.Name}}}}
}

// GroupParticipants renders group.v2.participants (NOWEB roles: join→participant, leave→left, promote and
// demote→admin).
func GroupParticipants(e *events.GroupInfo, typ string, jids []types.JID) OM {
	role := map[string]string{"join": "participant", "leave": "left", "promote": "admin", "demote": "admin"}[typ]
	parts := make([]OM, 0, len(jids))
	raw := make([]string, 0, len(jids))
	for _, j := range jids {
		parts = append(parts, groupParticipant(j, types.EmptyJID, role))
		raw = append(raw, SWA(j))
	}
	action := map[string]string{"join": "add", "leave": "remove", "promote": "promote", "demote": "demote"}[typ]
	var author any
	if e.Sender != nil {
		author = SWA(*e.Sender)
	}
	return OM{
		{"group", OM{{"id", e.JID.String()}}},
		{"type", typ},
		{"timestamp", time.Now().UnixMilli()},
		{"participants", parts},
		{"_data", OM{{"id", e.JID.String()}, {"author", author}, {"participants", raw}, {"action", action}}},
	}
}

// GroupLeave renders group.v2.leave.
func GroupLeave(e *events.GroupInfo) OM {
	return OM{{"timestamp", time.Now().UnixMilli()}, {"group", OM{{"id", e.JID.String()}}}, {"_data", OM{{"id", e.JID.String()}, {"action", "remove"}}}}
}

// GroupUpdate renders group.v2.update (only the changed keys).
func GroupUpdate(e *events.GroupInfo) OM {
	g := OM{{"id", e.JID.String()}}
	if e.Name != nil {
		g = append(g, KV{"subject", e.Name.Name})
	}
	if e.Topic != nil {
		g = append(g, KV{"description", e.Topic.Topic})
	}
	if e.Announce != nil {
		g = append(g, KV{"membersCanSendMessages", e.Announce.IsAnnounce})
	}
	return OM{{"timestamp", time.Now().UnixMilli()}, {"group", g}, {"_data", OM{{"id", e.JID.String()}}}}
}

// Call renders call.received / call.accepted / call.rejected.
func Call(id string, from types.JID, ts time.Time, video, group bool, status string) OM {
	return OM{
		{"id", id}, {"from", CUs(from)}, {"timestamp", ts.Unix()}, {"isVideo", video}, {"isGroup", group},
		{"_data", OM{{"chatId", SWA(from)}, {"from", SWA(from)}, {"id", id}, {"date", ts.UTC().Format(time.RFC3339Nano)}, {"offline", false}, {"status", status}, {"isVideo", video}, {"isGroup", group}}},
	}
}

// ---- chats ----

// ChatView is a stored chat with what rendering needs.
type ChatView struct {
	Row     *gwstore.ChatRow
	JID     types.JID
	Name    string
	Picture string
	Last    *Msg
}

// rawChat is NOWEB's stored Conversation object (ids as WhatsApp's JIDs, not c.us).
func rawChat(v *ChatView, withUnread bool) OM {
	c := OM{{"id", v.Row.Chat}, {"conversationTimestamp", v.Row.LastTS}}
	if withUnread {
		c = append(c, KV{"unreadCount", v.Row.Unread})
	}
	if v.Name != "" {
		c = append(c, KV{"name", v.Name})
	}
	if v.Row.Archived {
		c = append(c, KV{"archived", true})
	}
	if v.Row.MarkedUnread {
		c = append(c, KV{"markedAsUnread", true})
	}
	return c
}

// ChatSummary renders GET /api/{session}/chats (raw conversations, without unreadCount).
func ChatSummary(v *ChatView) OM { return rawChat(v, false) }

// ChatOverview renders GET /api/{session}/chats/overview.
func ChatOverview(v *ChatView, o *Opts) OM {
	var last any
	if v.Last != nil {
		lo := *o
		lo.DownloadMedia = false
		last = Message(v.Last, &lo)
	}
	id := v.Row.Chat
	if !v.JID.IsEmpty() {
		id = CUs(v.JID)
	}
	var name, pic any
	if v.Name != "" {
		name = v.Name
	}
	if v.Picture != "" {
		pic = v.Picture
	}
	return OM{{"id", id}, {"name", name}, {"picture", pic}, {"lastMessage", last}, {"_chat", rawChat(v, true)}}
}

// ---- contacts ----

type ContactView struct {
	JID  types.JID
	PN   types.JID
	LID  types.JID
	Info types.ContactInfo
}

// Contact renders a NOWEB (Baileys store) contact: id, lid?, phoneNumber?, name?, verifiedName?, pushname?.
func Contact(v *ContactView) OM {
	out := OM{{"id", CUs(v.JID)}}
	if v.JID.Server == types.DefaultUserServer && !v.LID.IsEmpty() {
		out = append(out, KV{"lid", v.LID.ToNonAD().String()})
	}
	if v.JID.Server == types.HiddenUserServer && !v.PN.IsEmpty() {
		out = append(out, KV{"phoneNumber", SWA(v.PN)})
	}
	name := v.Info.FullName
	if name == "" {
		name = v.Info.FirstName
	}
	if name != "" {
		out = append(out, KV{"name", name})
	}
	if v.Info.BusinessName != "" {
		out = append(out, KV{"verifiedName", v.Info.BusinessName})
	}
	if v.Info.PushName != "" {
		out = append(out, KV{"pushname", v.Info.PushName})
	}
	return out
}

// LIDPair renders {lid, pn} with nulls for unknown sides.
func LIDPair(lid, pn types.JID) OM {
	var l, p any
	if !lid.IsEmpty() {
		l = lid.ToNonAD().String()
	}
	if !pn.IsEmpty() {
		p = CUs(pn)
	}
	return OM{{"lid", l}, {"pn", p}}
}

// PollOptions returns the option names of a poll creation message (any version).
func PollOptions(m *waE2E.Message) []string {
	var pc *waE2E.PollCreationMessage
	switch {
	case m.GetPollCreationMessage() != nil:
		pc = m.GetPollCreationMessage()
	case m.GetPollCreationMessageV2() != nil:
		pc = m.GetPollCreationMessageV2()
	case m.GetPollCreationMessageV3() != nil:
		pc = m.GetPollCreationMessageV3()
	}
	var out []string
	for _, o := range pc.GetOptions() {
		out = append(out, o.GetOptionName())
	}
	return out
}

// PollVote renders poll.vote / poll.vote.failed (NOWEB): the "me" side of a DM is the literal "me"; in groups from is
// the participant and to the group. vote.timestamp is in ms (seconds for poll.vote.failed). No _data.
func PollVote(info *types.MessageInfo, pollKey *waCommon.MessageKey, selected []string, failed bool, me, meLID types.JID) OM {
	side := func(fromMe bool, participant types.JID) (from, to string) {
		if info.IsGroup {
			if fromMe {
				return CUs(me), CUs(info.Chat)
			}
			return CUs(participant), CUs(info.Chat)
		}
		if fromMe {
			return "me", CUs(info.Chat)
		}
		return CUs(info.Chat), "me"
	}
	var voterPart types.JID
	if info.IsGroup {
		voterPart = info.Sender
	}
	vFrom, vTo := side(info.IsFromMe, info.Sender)
	ts := info.Timestamp.UnixMilli()
	if failed {
		ts = info.Timestamp.Unix()
	}
	// The poll's key, from our perspective (as for reactions).
	pollFromMe := pollKey.GetFromMe()
	var pollPart types.JID
	if p := pollKey.GetParticipant(); p != "" {
		pollPart, _ = types.ParseJID(p)
	}
	if !info.IsFromMe {
		if pollFromMe {
			pollFromMe = false
		} else {
			author := pollPart
			if author.IsEmpty() {
				author, _ = types.ParseJID(pollKey.GetRemoteJID())
			}
			pollFromMe = isMe(author, me, meLID)
		}
	}
	if !info.IsGroup {
		pollPart = types.EmptyJID
	}
	pFrom, pTo := side(pollFromMe, pollPart)
	return OM{
		{"vote", OM{{"id", SerializeID(info.IsFromMe, info.Chat, info.ID, voterPart)}, {"to", vTo}, {"from", vFrom}, {"fromMe", info.IsFromMe}, {"selectedOptions", selected}, {"timestamp", ts}}},
		{"poll", OM{{"id", SerializeID(pollFromMe, info.Chat, pollKey.GetID(), pollPart)}, {"to", pTo}, {"from", pFrom}, {"fromMe", pollFromMe}}},
	}
}
