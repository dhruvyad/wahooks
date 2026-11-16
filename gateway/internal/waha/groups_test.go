package waha

import (
	"encoding/json"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

func TestGroupMetadata(t *testing.T) {
	pn := types.NewJID("15550100001", types.DefaultUserServer)
	lid := types.NewJID("123456789", types.HiddenUserServer)
	me := types.NewJID("15550100000", types.DefaultUserServer)
	g := &types.GroupInfo{
		JID:            types.NewJID("120363000000000001", types.GroupServer),
		OwnerJID:       me,
		GroupName:      types.GroupName{Name: "Team"},
		GroupTopic:     types.GroupTopic{Topic: "plans", TopicID: "T1", TopicSetAt: time.Unix(1700000100, 0)},
		AddressingMode: types.AddressingModeLID,
		GroupCreated:   time.Unix(1700000000, 0),
		MemberAddMode:  types.GroupMemberAddModeAllMember,
		Participants: []types.GroupParticipant{
			{JID: me, PhoneNumber: me, IsAdmin: true, IsSuperAdmin: true},
			{JID: lid, LID: lid, PhoneNumber: pn},
			{JID: types.NewJID("15550100009", types.DefaultUserServer), Error: 403,
				AddRequest: &types.GroupParticipantAddRequest{Code: "abc", Expiration: time.Unix(1700600000, 0)}},
		},
	}
	names := map[types.JID]MemberName{pn: {Name: "Alice"}, lid: {Notify: "ali"}}
	b, _ := json.Marshal(GroupMetadata(g, names, me, types.NewJID("42", types.HiddenUserServer)))
	want := `{"id":"120363000000000001@g.us","addressingMode":"lid","subject":"Team","size":2,"creation":1700000000,` +
		`"owner":"15550100000@s.whatsapp.net","desc":"plans","descId":"T1","descTime":1700000100,` +
		`"restrict":false,"announce":false,"isCommunity":false,"isCommunityAnnounce":false,"joinApprovalMode":false,"memberAddMode":true,` +
		`"participants":[{"id":"15550100000@s.whatsapp.net","admin":"superadmin","isMe":true},` +
		`{"id":"123456789@lid","phoneNumber":"15550100001@s.whatsapp.net","admin":null,"name":"Alice","notify":"ali"},` +
		`{"id":"15550100009@s.whatsapp.net","admin":null,"error":403,"addRequest":{"code":"abc","expiration":1700600000}}]}`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}

func TestGroupParticipantResults(t *testing.T) {
	b, _ := json.Marshal(GroupParticipantResults([]types.GroupParticipant{
		{JID: types.NewJID("15550100001", types.DefaultUserServer), LID: types.NewJID("1", types.HiddenUserServer)},
		{JID: types.NewJID("15550100002", types.DefaultUserServer), Error: 409},
	}))
	want := `[{"status":"200","jid":"15550100001@s.whatsapp.net","lid":"1@lid"},{"status":"409","jid":"15550100002@s.whatsapp.net"}]`
	if string(b) != want {
		t.Fatalf("got  %s\nwant %s", b, want)
	}
}
