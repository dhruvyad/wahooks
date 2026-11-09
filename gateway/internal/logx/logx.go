// Package logx sets up structured JSON logs and adapts whatsmeow's logger to them. whatsmeow's own lines can
// carry JIDs (phone numbers), so they are redacted before they are written. The gateway's own log lines never
// include message content, phone numbers, JIDs or secrets; they identify an account by session name.
package logx

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"

	waLog "go.mau.fi/whatsmeow/util/log"
)

func New(level string) *slog.Logger {
	var l slog.Level
	switch strings.ToUpper(level) {
	case "DEBUG":
		l = slog.LevelDebug
	case "WARN":
		l = slog.LevelWarn
	case "ERROR":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l}))
}

var (
	jidRe    = regexp.MustCompile(`[0-9]{5,}(?:[.:][0-9]+)*@(?:s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter|hosted|hosted\.lid)`)
	digitsRe = regexp.MustCompile(`\+?[0-9]{7,}`)
)

// Redact hides JIDs and long digit runs (phone numbers) in a free-form line.
func Redact(s string) string {
	s = jidRe.ReplaceAllStringFunc(s, func(m string) string {
		if i := strings.IndexByte(m, '@'); i >= 0 {
			return "<jid>" + m[i:]
		}
		return "<jid>"
	})
	return digitsRe.ReplaceAllString(s, "<n>")
}

// WA adapts slog to whatsmeow's waLog.Logger, with redaction and a minimum level.
type WA struct {
	l      *slog.Logger
	min    int
	module string
}

var levels = map[string]int{"DEBUG": 0, "INFO": 1, "WARN": 2, "ERROR": 3}

func NewWA(l *slog.Logger, minLevel string) *WA {
	m, ok := levels[strings.ToUpper(minLevel)]
	if !ok {
		m = 2
	}
	return &WA{l: l, min: m}
}

func (w *WA) Sub(module string) waLog.Logger {
	mod := module
	if w.module != "" {
		mod = w.module + "/" + module
	}
	return &WA{l: w.l, min: w.min, module: mod}
}

// With returns a logger that tags every line with the session name.
func (w *WA) With(session string) waLog.Logger {
	return &WA{l: w.l.With("session", session), min: w.min, module: w.module}
}

func (w *WA) out(lvl int, sl slog.Level, msg string, args []any) {
	if lvl < w.min {
		return
	}
	w.l.Log(context.Background(), sl, Redact(fmt.Sprintf(msg, args...)), "src", "whatsmeow", "module", w.module)
}

func (w *WA) Debugf(msg string, args ...any) { w.out(0, slog.LevelDebug, msg, args) }
func (w *WA) Infof(msg string, args ...any)  { w.out(1, slog.LevelInfo, msg, args) }
func (w *WA) Warnf(msg string, args ...any)  { w.out(2, slog.LevelWarn, msg, args) }
func (w *WA) Errorf(msg string, args ...any) { w.out(3, slog.LevelError, msg, args) }
