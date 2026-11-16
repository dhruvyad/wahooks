package session

import (
	"context"
	"errors"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func TestParseGroupID(t *testing.T) {
	for in, want := range map[string]string{
		"120363000000000001@g.us": "120363000000000001@g.us",
		" 120363000000000001 ":    "120363000000000001@g.us",
	} {
		j, err := ParseGroupID(in)
		if err != nil || j.String() != want {
			t.Errorf("%q: %v %v", in, j, err)
		}
	}
	for _, in := range []string{"", "15550000000@c.us", "abc@lid", "@g.us"} {
		var bad BadRequest
		if _, err := ParseGroupID(in); !errors.As(err, &bad) {
			t.Errorf("%q: want BadRequest, got %v", in, err)
		}
	}
}

func TestParseMembers(t *testing.T) {
	got, err := parseMembers(nil, []string{
		"+1 (555) 010-0001", "15550100001@c.us", "15550100002@s.whatsapp.net", "15550100003:7@s.whatsapp.net", "123456789@lid",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"15550100001@s.whatsapp.net", "15550100002@s.whatsapp.net", "15550100003@s.whatsapp.net", "123456789@lid"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i, w := range want {
		if got[i].String() != w {
			t.Errorf("%d: got %s want %s", i, got[i], w)
		}
	}
	for _, in := range []string{"120363000000000001@g.us", "abc@c.us", "", "status@broadcast"} {
		var bad BadRequest
		if _, err := parseMembers(nil, []string{in}); !errors.As(err, &bad) {
			t.Errorf("%q: want BadRequest, got %v", in, err)
		}
	}
}

func TestCanonicalMembers(t *testing.T) {
	pn := func(u string) types.JID { return types.NewJID(u, types.DefaultUserServer) }
	lid := types.NewJID("123456789", types.HiddenUserServer)
	lookup := func(_ context.Context, phones []string) ([]types.IsOnWhatsAppResponse, error) {
		if len(phones) != 3 {
			t.Fatalf("one query for the phone numbers only, got %v", phones)
		}
		return []types.IsOnWhatsAppResponse{
			// Brazil: asked with the extra 9, WhatsApp knows it without; the canonical id is a LID.
			{Query: "+5511912345678", IsIn: true, JID: types.NewJID("999", types.HiddenUserServer), PhoneNumber: pn("551112345678")},
			{Query: "+15550100001", IsIn: true, JID: pn("15550100001")},
			{Query: "+15550100009", IsIn: false},
		}, nil
	}
	keep, missing := canonicalMembers(context.Background(), lookup, []types.JID{pn("5511912345678"), pn("15550100001"), lid, pn("15550100009")})
	if len(keep) != 3 || keep[0] != pn("551112345678") || keep[1] != pn("15550100001") || keep[2] != lid {
		t.Fatalf("keep %v", keep)
	}
	if len(missing) != 1 || missing[0] != pn("15550100009") {
		t.Fatalf("missing %v", missing)
	}
	failing := func(context.Context, []string) ([]types.IsOnWhatsAppResponse, error) {
		return nil, errors.New("timeout")
	}
	in := []types.JID{pn("15550100001"), lid}
	if keep, missing := canonicalMembers(context.Background(), failing, in); len(keep) != 2 || missing != nil {
		t.Fatalf("a failed check keeps everyone: %v %v", keep, missing)
	}
}

func TestAsListed(t *testing.T) {
	pn := types.NewJID("15550100001", types.DefaultUserServer)
	lid := types.NewJID("123456789", types.HiddenUserServer)
	other := types.NewJID("15550100002", types.DefaultUserServer)
	g := &types.GroupInfo{Participants: []types.GroupParticipant{{JID: lid, LID: lid, PhoneNumber: pn}}}
	got := asListed(g, []types.JID{pn, lid, other})
	if len(got) != 2 || got[0] != lid || got[1] != other {
		t.Fatalf("got %v", got)
	}
}

func TestGroupErr(t *testing.T) {
	for err, code := range map[error]int{
		whatsmeow.ErrGroupNotFound:   404,
		whatsmeow.ErrIQNotFound:      404,
		whatsmeow.ErrNotInGroup:      403,
		whatsmeow.ErrIQForbidden:     403,
		whatsmeow.ErrIQNotAcceptable: 400,
		whatsmeow.ErrIQRateOverLimit: 429,
	} {
		var se StatusError
		if !errors.As(groupErr(err), &se) || se.Code != code {
			t.Errorf("%v: got %v", err, groupErr(err))
		}
	}
	if groupErr(nil) != nil {
		t.Fatal("nil stays nil")
	}
	other := errors.New("boom")
	if groupErr(other) != other {
		t.Fatal("unknown errors pass through")
	}
}
