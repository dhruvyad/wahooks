package convert

import (
	"fmt"
	"strconv"
	"strings"

	"go.mau.fi/whatsmeow/types"
)

// SignalAddress converts a Baileys/libsignal-node address ("user[_domain].device", see
// ProtocolAddress.toString and jidToSignalProtocolAddress in Baileys) to whatsmeow's
// ("user[_agent]:device", JID.SignalAddress().String()). The user part, including the
// domain suffix (_1 LID, _128 hosted, _129 hosted LID), is identical in both libraries.
func SignalAddress(baileys string) (string, error) {
	i := strings.LastIndexByte(baileys, '.')
	if i <= 0 || i == len(baileys)-1 {
		return "", fmt.Errorf("signal address %q: no device part", baileys)
	}
	user, dev := baileys[:i], baileys[i+1:]
	if _, err := strconv.ParseUint(dev, 10, 16); err != nil {
		return "", fmt.Errorf("signal address %q: device %q is not a number", baileys, dev)
	}
	if err := checkSignalUser(user); err != nil {
		return "", fmt.Errorf("signal address %q: %w", baileys, err)
	}
	return user + ":" + dev, nil
}

func checkSignalUser(user string) error {
	name, domain, hasDomain := strings.Cut(user, "_")
	if name == "" {
		return fmt.Errorf("empty user")
	}
	for _, c := range name {
		if c < '0' || c > '9' {
			return fmt.Errorf("user %q is not numeric", name)
		}
	}
	if hasDomain {
		switch domain {
		case "1", "128", "129":
		default:
			return fmt.Errorf("unknown domain suffix _%s", domain)
		}
	}
	return nil
}

// SenderKeyName splits Baileys' SenderKeyName.serialize() ("group::user[_domain]::device")
// into whatsmeow's (chat_id, sender_id) columns.
func SenderKeyName(baileys string) (group, sender string, err error) {
	parts := strings.Split(baileys, "::")
	if len(parts) < 3 {
		return "", "", fmt.Errorf("sender key name %q: want group::user::device", baileys)
	}
	dev := parts[len(parts)-1]
	user := parts[len(parts)-2]
	group = strings.Join(parts[:len(parts)-2], "::")
	if group == "" {
		return "", "", fmt.Errorf("sender key name %q: empty group", baileys)
	}
	if _, err := strconv.ParseUint(dev, 10, 16); err != nil {
		return "", "", fmt.Errorf("sender key name %q: bad device", baileys)
	}
	if err := checkSignalUser(user); err != nil {
		return "", "", fmt.Errorf("sender key name %q: %w", baileys, err)
	}
	return group, user + ":" + dev, nil
}

// Mask hides all but the last four digits of every number run, so reports and logs can be
// shared without exposing phone numbers or LIDs.
func Mask(s string) string {
	var b strings.Builder
	run := 0
	flush := func(digits string) {
		if len(digits) <= 4 {
			b.WriteString(digits)
			return
		}
		b.WriteString(strings.Repeat("•", len(digits)-4))
		b.WriteString(digits[len(digits)-4:])
	}
	var cur strings.Builder
	for _, c := range s {
		if c >= '0' && c <= '9' {
			cur.WriteRune(c)
			run++
			continue
		}
		if run > 0 {
			flush(cur.String())
			cur.Reset()
			run = 0
		}
		b.WriteRune(c)
	}
	if run > 0 {
		flush(cur.String())
	}
	return b.String()
}

// parseUserJID parses a JID string from Baileys (me.id, me.lid, tctoken keys).
func parseUserJID(s string) (types.JID, error) {
	j, err := types.ParseJID(s)
	if err != nil {
		return types.JID{}, err
	}
	if j.User == "" {
		return types.JID{}, fmt.Errorf("%q has no user part", s)
	}
	return j, nil
}

// LIDAddress returns the LID address Baileys reads instead of a phone-number address once it
// knows the user's LID (resolveLIDSignalAddress in Baileys' Signal/libsignal.ts), or "" when
// the address is not phone-number based or no mapping is known. "user.dev" → "lid_1.dev",
// hosted "user_128.dev" → "lid_129.dev".
func LIDAddress(baileys string, lidForPN map[string]string) string {
	i := strings.LastIndexByte(baileys, '.')
	if i <= 0 {
		return ""
	}
	user, dev := baileys[:i], baileys[i+1:]
	name, domain, hasDomain := strings.Cut(user, "_")
	suffix := "_1"
	if hasDomain {
		if domain != "128" {
			return ""
		}
		suffix = "_129"
	}
	lid, ok := lidForPN[name]
	if !ok || lid == "" {
		return ""
	}
	return lid + suffix + "." + dev
}

// lidSenderKeyName is LIDAddress for a sender key name ("group::user::dev").
func lidSenderKeyName(name string, lidForPN map[string]string) string {
	parts := strings.Split(name, "::")
	if len(parts) < 3 {
		return ""
	}
	n := len(parts)
	lid := LIDAddress(parts[n-2]+"."+parts[n-1], lidForPN)
	if lid == "" {
		return ""
	}
	i := strings.LastIndexByte(lid, '.')
	return strings.Join(parts[:n-2], "::") + "::" + lid[:i] + "::" + lid[i+1:]
}
