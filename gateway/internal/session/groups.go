package session

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"

	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// groupInfoTTL is how long GroupInfo serves a group's metadata from memory. WhatsApp's own group events and this
// gateway's changes drop the cached copy sooner, so the TTL only bounds staleness from changes we never hear about.
const groupInfoTTL = time.Minute

// StatusError is an error with the HTTP status the API should answer with.
type StatusError struct {
	Code int
	Msg  string
}

func (e StatusError) Error() string { return e.Msg }

// groupErr turns WhatsApp's answers to group queries into errors the API can report.
func groupErr(err error) error {
	switch {
	case errors.Is(err, whatsmeow.ErrGroupNotFound), errors.Is(err, whatsmeow.ErrIQNotFound):
		return StatusError{404, "Group not found"}
	case errors.Is(err, whatsmeow.ErrNotInGroup):
		return StatusError{403, "This account is not in the group"}
	case errors.Is(err, whatsmeow.ErrIQForbidden), errors.Is(err, whatsmeow.ErrIQNotAuthorized), errors.Is(err, whatsmeow.ErrIQNotAllowed):
		return StatusError{403, "WhatsApp refused: this account is not an admin of the group, or not in it"}
	case errors.Is(err, whatsmeow.ErrIQNotAcceptable), errors.Is(err, whatsmeow.ErrIQBadRequest):
		return StatusError{400, "WhatsApp rejected the request (" + err.Error() + ")"}
	case errors.Is(err, whatsmeow.ErrIQRateOverLimit):
		return StatusError{429, "WhatsApp is rate-limiting this account's group changes; try again later"}
	}
	return err
}

// ParseGroupID accepts a group id with or without its @g.us suffix.
func ParseGroupID(id string) (types.JID, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return types.EmptyJID, badf("group id is required")
	}
	if !strings.Contains(id, "@") {
		id += "@" + types.GroupServer
	}
	j, err := types.ParseJID(id)
	if err != nil || j.Server != types.GroupServer || j.User == "" {
		return types.EmptyJID, badf("invalid group id %q: it must end with @g.us", id)
	}
	return j, nil
}

// parseMembers turns participant ids (digits, <digits>@c.us, @s.whatsapp.net or @lid) into user JIDs, without
// duplicates or the account itself (WhatsApp adds the creator on its own).
func parseMembers(cli *whatsmeow.Client, ids []string) ([]types.JID, error) {
	me, meLID := ownJID(cli), ownLID(cli)
	seen := map[types.JID]bool{}
	out := make([]types.JID, 0, len(ids))
	for _, id := range ids {
		raw := strings.TrimSpace(id)
		if !strings.Contains(raw, "@") {
			// A phone number as people write it: "+1 (555) 010-0000".
			raw = strings.Map(func(r rune) rune {
				if r >= '0' && r <= '9' {
					return r
				}
				return -1
			}, raw)
		}
		j, err := ParseChatID(raw)
		ok := err == nil && j.User != "" && (j.Server == types.HiddenUserServer || (j.Server == types.DefaultUserServer && allDigits(j.User)))
		if !ok {
			return nil, badf("invalid participant %q: use a phone number, <number>@c.us or <id>@lid", id)
		}
		j = j.ToNonAD()
		if j == me || j == meLID || seen[j] {
			continue
		}
		seen[j] = true
		out = append(out, j)
	}
	return out, nil
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// canonicalMembers checks phone-number members with WhatsApp in one query, as the send routes do one by one: a
// number WhatsApp knows under another form (Brazil's extra 9) is replaced by that form, and numbers that aren't on
// WhatsApp are split off. If the check itself fails, every member is kept as given.
func canonicalMembers(ctx context.Context, lookup func(context.Context, []string) ([]types.IsOnWhatsAppResponse, error), members []types.JID) (keep, missing []types.JID) {
	var phones []string
	for _, j := range members {
		if j.Server == types.DefaultUserServer {
			phones = append(phones, "+"+j.User)
		}
	}
	if len(phones) == 0 {
		return members, nil
	}
	res, err := lookup(ctx, phones)
	if len(res) == 0 && err != nil {
		return members, nil
	}
	found := map[string]types.JID{}
	answered := map[string]bool{}
	for _, r := range res {
		q := strings.TrimPrefix(r.Query, "+")
		answered[q] = true
		if !r.IsIn {
			continue
		}
		switch {
		case !r.PhoneNumber.IsEmpty():
			found[q] = r.PhoneNumber.ToNonAD()
		case r.JID.Server == types.DefaultUserServer:
			found[q] = r.JID.ToNonAD()
		}
	}
	seen := map[types.JID]bool{}
	for _, j := range members {
		if j.Server == types.DefaultUserServer {
			if c, ok := found[j.User]; ok {
				j = c
			} else if answered[j.User] {
				missing = append(missing, j)
				continue
			}
		}
		if !seen[j] {
			seen[j] = true
			keep = append(keep, j)
		}
	}
	return keep, missing
}

// notOnWhatsApp reports members WhatsApp says have no account the way it reports other failed adds: error 404.
func notOnWhatsApp(js []types.JID) []types.GroupParticipant {
	out := make([]types.GroupParticipant, 0, len(js))
	for _, j := range js {
		out = append(out, types.GroupParticipant{JID: j, PhoneNumber: j, Error: 404})
	}
	return out
}

func (s *Session) groupKey(j types.JID) string { return s.Name + "|" + j.String() }

// forgetGroup drops the cached metadata of one group (on group events and after this gateway changes it).
func (s *Session) forgetGroup(j types.JID) { s.m.groups.del(s.groupKey(j)) }

// GroupInfo returns a group's metadata from WhatsApp, cached for a minute; refresh skips the cache. The result is
// shared: callers must not change it.
func (s *Session) GroupInfo(ctx context.Context, groupID string, refresh bool) (*types.GroupInfo, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	j, err := ParseGroupID(groupID)
	if err != nil {
		return nil, err
	}
	if !refresh {
		if g, ok := s.m.groups.get(s.groupKey(j)); ok {
			return g, nil
		}
	}
	g, err := cli.GetGroupInfo(ctx, j)
	if err != nil {
		return nil, groupErr(err)
	}
	s.m.groups.set(s.groupKey(j), g, groupInfoTTL)
	return g, nil
}

// OwnIDs is the account's phone-number JID and LID (empty when unknown).
func (s *Session) OwnIDs() []types.JID {
	cli := s.AnyClient()
	return []types.JID{ownJID(cli), ownLID(cli)}
}

// MemberNames looks up the account's names for a group's members (contact name and push name), under their phone
// number and LID. Best effort: a failed lookup returns what it has.
func (s *Session) MemberNames(ctx context.Context, g *types.GroupInfo) map[types.JID]waha.MemberName {
	cli := s.AnyClient()
	if cli == nil || cli.Store == nil || cli.Store.ID == nil || len(g.Participants) == 0 {
		return nil
	}
	jids := make([]types.JID, 0, 2*len(g.Participants))
	for _, p := range g.Participants {
		for _, j := range []types.JID{p.JID, p.PhoneNumber, p.LID} {
			if !j.IsEmpty() {
				jids = append(jids, j.ToNonAD())
			}
		}
	}
	rows, err := s.m.DB.GetContacts(ctx, *cli.Store.ID, jids)
	if err != nil {
		s.m.Log.Warn("group member names failed", "session", s.Name, "err", err.Error())
	}
	out := make(map[types.JID]waha.MemberName, len(rows))
	for j, c := range rows {
		name := c.FullName
		if name == "" {
			name = c.FirstName
		}
		if name == "" {
			name = c.BusinessName
		}
		out[j] = waha.MemberName{Name: name, Notify: c.PushName}
	}
	return out
}

// CreateGroup creates a group with this account as its owner. Members WhatsApp didn't add come back in the
// participant list with an error code (and an invite code when their privacy settings stopped it); numbers that
// aren't on WhatsApp are listed the same way with error 404.
func (s *Session) CreateGroup(ctx context.Context, name string, participants []string) (*types.GroupInfo, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, badf("name is required")
	}
	members, err := parseMembers(cli, participants)
	if err != nil {
		return nil, err
	}
	members, missing := canonicalMembers(ctx, cli.IsOnWhatsApp, members)
	g, err := cli.CreateGroup(ctx, whatsmeow.ReqCreateGroup{Name: name, Participants: members})
	if err != nil {
		return nil, groupErr(err)
	}
	g.Participants = append(g.Participants, notOnWhatsApp(missing)...)
	return g, nil
}

// UpdateGroupParticipants adds or removes members. For a removal, a member named by phone number is matched to the
// id the group lists them under (LID-addressed groups list LIDs).
func (s *Session) UpdateGroupParticipants(ctx context.Context, groupID string, participants []string, action whatsmeow.ParticipantChange) ([]types.GroupParticipant, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return nil, err
	}
	j, err := ParseGroupID(groupID)
	if err != nil {
		return nil, err
	}
	members, err := parseMembers(cli, participants)
	if err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return nil, badf("participants is required (other than this account; use leave to remove it)")
	}
	var missing []types.JID
	if action == whatsmeow.ParticipantChangeAdd {
		members, missing = canonicalMembers(ctx, cli.IsOnWhatsApp, members)
	} else if g, err := s.GroupInfo(ctx, j.String(), false); err == nil {
		members = asListed(g, members)
	}
	defer s.forgetGroup(j)
	var res []types.GroupParticipant
	if len(members) > 0 {
		if res, err = cli.UpdateGroupParticipants(ctx, j, members, action); err != nil {
			return nil, groupErr(err)
		}
	}
	return append(res, notOnWhatsApp(missing)...), nil
}

// asListed maps each member to the JID the group lists them under, matching phone number or LID.
func asListed(g *types.GroupInfo, members []types.JID) []types.JID {
	by := map[types.JID]types.JID{}
	for _, p := range g.Participants {
		for _, alt := range []types.JID{p.JID, p.PhoneNumber, p.LID} {
			if !alt.IsEmpty() {
				by[alt.ToNonAD()] = p.JID
			}
		}
	}
	out := make([]types.JID, 0, len(members))
	seen := map[types.JID]bool{}
	for _, m := range members {
		if listed, ok := by[m]; ok {
			m = listed
		}
		if !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

// LeaveGroup makes this account leave a group.
func (s *Session) LeaveGroup(ctx context.Context, groupID string) error {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return err
	}
	j, err := ParseGroupID(groupID)
	if err != nil {
		return err
	}
	defer s.forgetGroup(j)
	return groupErr(cli.LeaveGroup(ctx, j))
}

// SetGroupSubject renames a group.
func (s *Session) SetGroupSubject(ctx context.Context, groupID, subject string) error {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return err
	}
	j, err := ParseGroupID(groupID)
	if err != nil {
		return err
	}
	subject = strings.TrimSpace(subject)
	if subject == "" {
		return badf("subject is required")
	}
	defer s.forgetGroup(j)
	return groupErr(cli.SetGroupName(ctx, j, subject))
}

// GroupInviteLink returns the group's invite link (https://chat.whatsapp.com/<code>); revoke makes a new one.
func (s *Session) GroupInviteLink(ctx context.Context, groupID string, revoke bool) (string, error) {
	cli, err := s.WaitClient(ctx)
	if err != nil {
		return "", err
	}
	j, err := ParseGroupID(groupID)
	if err != nil {
		return "", err
	}
	link, err := cli.GetGroupInviteLink(ctx, j, revoke)
	if errors.Is(err, whatsmeow.ErrGroupInviteLinkUnauthorized) {
		return "", StatusError{403, "Only group admins can get the invite link"}
	}
	if err != nil {
		return "", groupErr(err)
	}
	return link, nil
}
