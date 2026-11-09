package wahaimport

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waHistorySync"
)

// Baileys stores "marked unread on the phone" as unreadCount -1. It must not wrap to 4294967295.
func TestDecodeMarkedUnread(t *testing.T) {
	for _, tc := range []struct {
		in     string
		unread uint32
		marked bool
	}{
		{`{"id":"15550000001@s.whatsapp.net","unreadCount":-1,"markedAsUnread":false}`, 0, true},
		{`{"id":"15550000001@s.whatsapp.net","unreadCount":"-1"}`, 0, true},
		{`{"id":"15550000001@s.whatsapp.net","unreadCount":3}`, 3, false},
		{`{"id":"15550000001@s.whatsapp.net","unreadCount":0,"markedAsUnread":true}`, 0, true},
	} {
		var c waHistorySync.Conversation
		if _, err := Decode([]byte(tc.in), &c); err != nil {
			t.Fatalf("%s: %v", tc.in, err)
		}
		if c.GetUnreadCount() != tc.unread || c.GetMarkedAsUnread() != tc.marked {
			t.Fatalf("%s: unread %d marked %v", tc.in, c.GetUnreadCount(), c.GetMarkedAsUnread())
		}
	}
	// Any other negative value in an unsigned field is an error, not a wrapped number.
	var c waHistorySync.Conversation
	if _, err := Decode([]byte(`{"id":"15550000001@s.whatsapp.net","unreadMentionCount":-2}`), &c); err == nil {
		t.Fatalf("negative unreadMentionCount decoded as %d", c.GetUnreadMentionCount())
	}
}
