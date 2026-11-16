package waha

import (
	"strconv"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// MemberName is what the account knows a group member as: the address-book name and the WhatsApp push name.
type MemberName struct {
	Name   string // contact name (full, first, or business name)
	Notify string // push name
}

// GroupMetadata renders a group as NOWEB's GET/POST /api/{session}/groups routes return it: Baileys' GroupMetadata,
// with raw @s.whatsapp.net / @lid ids and times in seconds. Each participant is {id, phoneNumber?, lid?, admin}; the
// gateway adds Baileys Contact's optional name/notify from the account's contacts, and error/addRequest on a
// participant WhatsApp didn't add (create only), and isMe: true on the account's own entry (me = its PN and LID).
func GroupMetadata(g *types.GroupInfo, names map[types.JID]MemberName, me ...types.JID) OM {
	parts := make([]OM, 0, len(g.Participants))
	for _, p := range g.Participants {
		o := groupMember(p, names)
		if isOwn(p, me) {
			o = append(o, KV{"isMe", true})
		}
		parts = append(parts, o)
	}
	size := g.ParticipantCount
	if size == 0 {
		for _, p := range g.Participants {
			if p.Error == 0 {
				size++
			}
		}
	}
	o := OM{{"id", g.JID.String()}}
	if g.AddressingMode != "" {
		o = append(o, KV{"addressingMode", string(g.AddressingMode)})
	}
	o = append(o, KV{"subject", g.Name})
	o = appendJID(o, "subjectOwner", g.NameSetBy)
	o = appendJID(o, "subjectOwnerPn", g.NameSetByPN)
	o = appendTime(o, "subjectTime", g.NameSetAt)
	o = append(o, KV{"size", size})
	o = appendTime(o, "creation", g.GroupCreated)
	o = appendJID(o, "owner", g.OwnerJID)
	o = appendJID(o, "ownerPn", g.OwnerPN)
	if g.CreatorCountryCode != "" {
		o = append(o, KV{"owner_country_code", g.CreatorCountryCode})
	}
	if g.Topic != "" {
		o = append(o, KV{"desc", g.Topic})
		o = appendJID(o, "descOwner", g.TopicSetBy)
		o = appendJID(o, "descOwnerPn", g.TopicSetByPN)
		if g.TopicID != "" {
			o = append(o, KV{"descId", g.TopicID})
		}
		o = appendTime(o, "descTime", g.TopicSetAt)
	}
	o = appendJID(o, "linkedParent", g.LinkedParentJID)
	o = append(o,
		KV{"restrict", g.IsLocked},
		KV{"announce", g.IsAnnounce},
		KV{"isCommunity", g.IsParent},
		KV{"isCommunityAnnounce", g.IsDefaultSubGroup},
		KV{"joinApprovalMode", g.IsJoinApprovalRequired},
		KV{"memberAddMode", g.MemberAddMode == types.GroupMemberAddModeAllMember},
		KV{"participants", parts},
	)
	if g.IsEphemeral {
		o = append(o, KV{"ephemeralDuration", g.DisappearingTimer})
	}
	return o
}

func groupMember(p types.GroupParticipant, names map[types.JID]MemberName) OM {
	o := OM{{"id", SWA(p.JID)}}
	if p.JID.Server == types.HiddenUserServer && !p.PhoneNumber.IsEmpty() {
		o = append(o, KV{"phoneNumber", SWA(p.PhoneNumber)})
	}
	if p.JID.Server == types.DefaultUserServer && !p.LID.IsEmpty() {
		o = append(o, KV{"lid", SWA(p.LID)})
	}
	var admin any
	if p.IsSuperAdmin {
		admin = "superadmin"
	} else if p.IsAdmin {
		admin = "admin"
	}
	o = append(o, KV{"admin", admin})
	if n, ok := memberName(p, names); ok {
		if n.Name != "" {
			o = append(o, KV{"name", n.Name})
		}
		if n.Notify != "" {
			o = append(o, KV{"notify", n.Notify})
		}
	}
	if p.Error != 0 {
		o = append(o, KV{"error", p.Error})
		o = appendAddRequest(o, p.AddRequest)
	}
	return o
}

func isOwn(p types.GroupParticipant, me []types.JID) bool {
	for _, m := range me {
		if m.IsEmpty() {
			continue
		}
		for _, j := range []types.JID{p.JID, p.PhoneNumber, p.LID} {
			if !j.IsEmpty() && j.ToNonAD() == m.ToNonAD() {
				return true
			}
		}
	}
	return false
}

// memberName merges what's stored under the member's phone number and LID (push names are often under the LID).
func memberName(p types.GroupParticipant, names map[types.JID]MemberName) (MemberName, bool) {
	var out MemberName
	for _, j := range []types.JID{p.PhoneNumber, p.LID, p.JID} {
		n, ok := names[j.ToNonAD()]
		if j.IsEmpty() || !ok {
			continue
		}
		if out.Name == "" {
			out.Name = n.Name
		}
		if out.Notify == "" {
			out.Notify = n.Notify
		}
	}
	return out, out.Name != "" || out.Notify != ""
}

// GroupParticipantResults renders an add/remove result as Baileys' groupParticipantsUpdate does, [{status, jid}],
// status "200" on success and WhatsApp's error code otherwise (403 privacy, 404 not on WhatsApp or not a member,
// 408 left recently, 409 already a member). The gateway adds phoneNumber/lid when WhatsApp names both, and
// addRequest {code, expiration} for the one-person invite WhatsApp issues with a 403.
func GroupParticipantResults(ps []types.GroupParticipant) []OM {
	out := make([]OM, 0, len(ps))
	for _, p := range ps {
		status := 200
		if p.Error != 0 {
			status = p.Error
		}
		o := OM{{"status", strconv.Itoa(status)}, {"jid", SWA(p.JID)}}
		if p.JID.Server == types.HiddenUserServer && !p.PhoneNumber.IsEmpty() {
			o = append(o, KV{"phoneNumber", SWA(p.PhoneNumber)})
		}
		if p.JID.Server == types.DefaultUserServer && !p.LID.IsEmpty() {
			o = append(o, KV{"lid", SWA(p.LID)})
		}
		out = append(out, appendAddRequest(o, p.AddRequest))
	}
	return out
}

func appendAddRequest(o OM, r *types.GroupParticipantAddRequest) OM {
	if r == nil || r.Code == "" {
		return o
	}
	var exp any
	if !r.Expiration.IsZero() {
		exp = r.Expiration.Unix()
	}
	return append(o, KV{"addRequest", OM{{"code", r.Code}, {"expiration", exp}}})
}

func appendJID(o OM, k string, j types.JID) OM {
	if j.IsEmpty() {
		return o
	}
	return append(o, KV{k, SWA(j)})
}

func appendTime(o OM, k string, t time.Time) OM {
	if t.IsZero() {
		return o
	}
	return append(o, KV{k, t.Unix()})
}
