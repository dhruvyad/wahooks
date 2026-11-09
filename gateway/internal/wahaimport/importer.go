package wahaimport

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"

	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// Source is WAHA NOWEB's history for one session, streamed row by row:
//
//	messages (jid TEXT, id TEXT, "messageTimestamp" INTEGER, data TEXT)  data = Baileys WAMessage
//	chats    (id TEXT, "conversationTimestamp" INTEGER, data TEXT)      data = Baileys Chat
//
// (src/core/engines/noweb/store/schemas.ts; data as NOWEBPsqlKVRepository writes it.)
type Source struct {
	messages func(func(col func(string) string) error) error
	chats    func(func(col func(string) string) error) error
}

func getter(cols []string, row []*string) func(string) string {
	return func(name string) string {
		for i, c := range cols {
			if c == name && i < len(row) && row[i] != nil {
				return *row[i]
			}
		}
		return ""
	}
}

// FromDump streams both tables from the session database's pg_dump custom-format archive.
func FromDump(path string) (*Source, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	magic := make([]byte, 5)
	_, err = io.ReadFull(f, magic)
	f.Close()
	if err != nil || string(magic) != "PGDMP" {
		return nil, fmt.Errorf("not a pg_dump custom-format archive (want PGDMP)")
	}
	scan := func(table string) func(func(func(string) string) error) error {
		return func(fn func(func(string) string) error) error {
			return ScanDump(path, []string{table}, func(_ string, cols []string, row []*string) error {
				return fn(getter(cols, row))
			})
		}
	}
	return &Source{messages: scan("messages"), chats: scan("chats")}, nil
}

// FromCSV streams psql \copy CSV exports (with header) of the two tables; chats may be "".
func FromCSV(messages, chats string) (*Source, error) {
	for _, p := range []string{messages, chats} {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err != nil {
			return nil, err
		}
	}
	scan := func(path string) func(func(func(string) string) error) error {
		return func(fn func(func(string) string) error) error {
			if path == "" {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			defer f.Close()
			r := csv.NewReader(bufio.NewReaderSize(f, 1<<20))
			r.ReuseRecord = false
			header, err := r.Read()
			if errors.Is(err, io.EOF) {
				return nil
			} else if err != nil {
				return err
			}
			for {
				rec, err := r.Read()
				if errors.Is(err, io.EOF) {
					return nil
				} else if err != nil {
					return err
				}
				row := make([]*string, len(rec))
				for i := range rec {
					row[i] = &rec[i]
				}
				if err := fn(getter(header, row)); err != nil {
					return err
				}
			}
		}
	}
	return &Source{messages: scan(messages), chats: scan(chats)}, nil
}

// Options bound what is imported, as the gateway bounds what it keeps.
type Options struct {
	Session string
	// Cutoff: messages older are not imported (the gateway's WAGW_MESSAGE_RETENTION; its janitor
	// would delete them on its next run). Zero imports everything.
	Cutoff time.Time
	// PerChat keeps the newest N per chat (the janitor's WAGW_MESSAGES_PER_CHAT_MAX). 0 = no cap.
	PerChat int
}

// Report counts what happened. It holds no content or identifiers.
type Report struct {
	MessagesRead     int            `json:"messages_read"`
	MessagesReady    int            `json:"messages_ready"`
	MessagesImported int            `json:"messages_imported"`
	MessagesExisting int            `json:"messages_already_stored"`
	Skipped          map[string]int `json:"skipped"`
	ChatsRead        int            `json:"chats_read"`
	ChatsWritten     int            `json:"chats_written"`
	UnknownFields    map[string]int `json:"unknown_fields,omitempty"` // Baileys fields the proto lacks (expected: key.remoteJidAlt, …)
}

func (r *Report) skip(reason string) { r.Skipped[reason]++ }

// Build converts the source into gateway rows without writing anything. cli supplies the
// account's own JIDs to whatsmeow's ParseWebMessage (it need not be connected). Messages past the
// cutoff are dropped from their timestamp column before any decoding, so memory is bounded by
// what will be imported.
func Build(cli *whatsmeow.Client, src *Source, opt Options) ([]*gwstore.MessageRow, []*gwstore.ChatRow, *Report, error) {
	rep := &Report{Skipped: map[string]int{}, UnknownFields: map[string]int{}}
	byChat := map[string][]*gwstore.MessageRow{}
	cut := int64(0)
	if !opt.Cutoff.IsZero() {
		cut = opt.Cutoff.Unix()
	}
	err := src.messages(func(col func(string) string) error {
		rep.MessagesRead++
		if ts, err := strconv.ParseInt(col("messageTimestamp"), 10, 64); err == nil && cut > 0 && ts > 0 && ts < cut {
			rep.skip("older than the retention cutoff")
			return nil
		}
		row, reason := buildMessage(cli, col("data"), opt, rep)
		if row == nil {
			rep.skip(reason)
			return nil
		}
		byChat[row.Chat] = append(byChat[row.Chat], row)
		return nil
	})
	if err != nil {
		return nil, nil, rep, fmt.Errorf("messages: %w", err)
	}
	var rows []*gwstore.MessageRow
	newest := map[string]*gwstore.MessageRow{}
	for chat, ms := range byChat {
		sort.SliceStable(ms, func(i, j int) bool { return ms[i].TS > ms[j].TS })
		if opt.PerChat > 0 && len(ms) > opt.PerChat {
			rep.Skipped["over the per-chat cap"] += len(ms) - opt.PerChat
			ms = ms[:opt.PerChat]
		}
		newest[chat] = ms[0]
		rows = append(rows, ms...)
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].TS < rows[j].TS })
	rep.MessagesReady = len(rows)

	chats := map[string]*gwstore.ChatRow{}
	err = src.chats(func(col func(string) string) error {
		rep.ChatsRead++
		var conv waHistorySync.Conversation
		unknown, err := Decode([]byte(col("data")), &conv)
		if err != nil {
			rep.skip("chat unreadable")
			return nil
		}
		for _, u := range unknown {
			rep.UnknownFields["chat."+u]++
		}
		id := conv.GetID()
		if id == "" {
			id = col("id")
		}
		j, err := types.ParseJID(id)
		if err != nil || j.Server == types.BroadcastServer {
			rep.skip("chat: status/broadcast or bad id")
			return nil
		}
		c := &gwstore.ChatRow{
			Session: opt.Session, Chat: j.ToNonAD().String(), Name: conv.GetName(),
			LastTS: int64(conv.GetConversationTimestamp()), Unread: int(conv.GetUnreadCount()),
			MarkedUnread: conv.GetMarkedAsUnread(), Archived: conv.GetArchived(),
		}
		chats[c.Chat] = c
		return nil
	})
	if err != nil {
		return nil, nil, rep, fmt.Errorf("chats: %w", err)
	}
	// As the gateway's onHistory: a chat's last message is the newest stored one.
	for chat, n := range newest {
		c := chats[chat]
		if c == nil {
			c = &gwstore.ChatRow{Session: opt.Session, Chat: chat}
			chats[chat] = c
		}
		if c.LastTS < n.TS {
			c.LastTS = n.TS
		}
		c.LastID = n.ID
	}
	out := make([]*gwstore.ChatRow, 0, len(chats))
	for _, k := range sortedKeys(chats) {
		out = append(out, chats[k])
	}
	return rows, out, rep, nil
}

// buildMessage mirrors the gateway: onHistory's parse and filters (whatsmeow ParseWebMessage,
// then the same skips onMessage applies to live traffic), waha.ToRow, source "history". On top
// of what history sync carries it restores the LID/PN alternates Baileys kept on the key, which
// the live path fills from the message stanza.
func buildMessage(cli *whatsmeow.Client, data string, opt Options, rep *Report) (*gwstore.MessageRow, string) {
	var wmi waWeb.WebMessageInfo
	unknown, err := Decode([]byte(data), &wmi)
	if err != nil {
		return nil, "unreadable"
	}
	for _, u := range unknown {
		rep.UnknownFields[u]++
	}
	var extra struct {
		Key struct {
			RemoteJidAlt   string `json:"remoteJidAlt"`
			ParticipantAlt string `json:"participantAlt"`
		} `json:"key"`
	}
	_ = json.Unmarshal([]byte(data), &extra)

	chat, err := types.ParseJID(wmi.GetKey().GetRemoteJID())
	if err != nil || chat.User == "" {
		return nil, "bad chat id"
	}
	if chat.Server == types.BroadcastServer {
		return nil, "status/broadcast"
	}
	evt, err := cli.ParseWebMessage(chat, &wmi)
	if err != nil || evt.Message == nil {
		return nil, "no content"
	}
	msg := evt.Message
	switch {
	case msg.GetProtocolMessage() != nil:
		return nil, "protocol message"
	case msg.GetReactionMessage() != nil:
		return nil, "reaction (an event, not a stored message)"
	case msg.GetPollUpdateMessage() != nil, msg.GetEncReactionMessage() != nil, msg.GetKeepInChatMessage() != nil:
		return nil, "vote/encrypted reaction/keep"
	case waha.IsSkippable(msg):
		return nil, "empty"
	}
	if !opt.Cutoff.IsZero() && evt.Info.Timestamp.Before(opt.Cutoff) {
		return nil, "older than the retention cutoff"
	}
	if chat.Server == types.GroupServer {
		if alt, err := types.ParseJID(extra.Key.ParticipantAlt); err == nil && extra.Key.ParticipantAlt != "" {
			evt.Info.SenderAlt = alt
		}
	} else if alt, err := types.ParseJID(extra.Key.RemoteJidAlt); err == nil && extra.Key.RemoteJidAlt != "" {
		if evt.Info.IsFromMe {
			evt.Info.RecipientAlt = alt
		} else {
			evt.Info.SenderAlt = alt
		}
	}
	m := &waha.Msg{Info: evt.Info, Message: msg, Ack: waha.AckFromWebStatus(wmi.GetStatus(), evt.Info.IsFromMe), Source: "app"}
	row, err := waha.ToRow(opt.Session, m)
	if err != nil {
		return nil, "unencodable"
	}
	row.Source = "history"
	return row, ""
}

// Import builds the rows and writes them: messages only where absent (never replacing a row the
// gateway stored itself), chats without moving them back in time or overwriting live state.
// Safe to run while the gateway serves the session.
func Import(ctx context.Context, db *gwstore.DB, cli *whatsmeow.Client, src *Source, opt Options) (*Report, error) {
	rows, chats, rep, err := Build(cli, src, opt)
	if err != nil {
		return rep, err
	}
	n, err := db.ImportMessages(ctx, rows)
	rep.MessagesImported = n
	rep.MessagesExisting = len(rows) - n
	if err != nil {
		return rep, err
	}
	for _, c := range chats {
		if err := db.ImportChat(ctx, c); err != nil {
			return rep, err
		}
		rep.ChatsWritten++
	}
	return rep, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
