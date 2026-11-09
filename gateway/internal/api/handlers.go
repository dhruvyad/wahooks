package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow/types"

	"github.com/dhruvyad/wahooks/gateway/internal/session"
	gwstore "github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

const Version = "2026.11.3-wagw" // 2026.11.3: POST /api/sessions/{session}/load; .2: copy-store, lease heartbeat; .1: import-history

type Server struct {
	M       *session.Manager
	Log     *slog.Logger
	Started time.Time
	Metrics http.Handler
}

func (s *Server) Handler(apiKey string) http.Handler {
	rt := &router{}
	// ops
	rt.handle("GET", "/health", s.health)
	rt.handle("GET", "/ping", func(w http.ResponseWriter, r *http.Request, _ params) {
		writeJSON(w, 200, map[string]string{"message": "pong"})
	})
	rt.handle("GET", "/metrics", func(w http.ResponseWriter, r *http.Request, _ params) { s.Metrics.ServeHTTP(w, r) })
	rt.handle("GET", "/api/server/version", s.version)
	rt.handle("GET", "/api/version", s.version)
	rt.handle("GET", "/api/server/status", s.serverStatus)
	// sessions
	rt.handle("GET", "/api/sessions", s.listSessions)
	rt.handle("POST", "/api/sessions", s.createSession)
	rt.handle("POST", "/api/sessions/start", s.legacyAction("start"))
	rt.handle("POST", "/api/sessions/stop", s.legacyAction("stop"))
	rt.handle("POST", "/api/sessions/logout", s.legacyAction("logout"))
	rt.handle("GET", "/api/sessions/{session}", s.getSession)
	rt.handle("PUT", "/api/sessions/{session}", s.updateSession)
	rt.handle("DELETE", "/api/sessions/{session}", s.deleteSession)
	rt.handle("GET", "/api/sessions/{session}/me", s.me)
	rt.handle("POST", "/api/sessions/{session}/start", s.action("start"))
	rt.handle("POST", "/api/sessions/{session}/stop", s.action("stop"))
	rt.handle("POST", "/api/sessions/{session}/restart", s.action("restart"))
	rt.handle("POST", "/api/sessions/{session}/logout", s.action("logout"))
	// gateway extension: load a session `gateway adopt-device` wrote while this gateway runs
	rt.handle("POST", "/api/sessions/{session}/load", s.loadSession)
	// auth
	rt.handle("GET", "/api/{session}/auth/qr", s.qr)
	rt.handle("POST", "/api/{session}/auth/request-code", s.requestCode)
	// chats & messages
	rt.handle("GET", "/api/{session}/chats", s.chats)
	rt.handle("GET", "/api/{session}/chats/overview", s.chatsOverview)
	rt.handle("POST", "/api/{session}/chats/overview", s.chatsOverview)
	rt.handle("GET", "/api/{session}/chats/{chatId}/messages", s.messages)
	rt.handle("GET", "/api/{session}/chats/{chatId}/messages/{messageId}", s.message)
	rt.handle("PUT", "/api/{session}/chats/{chatId}/messages/{messageId}", s.editMessage)
	rt.handle("POST", "/api/{session}/chats/{chatId}/messages/read", s.readMessages)
	// contacts & identities
	rt.handle("GET", "/api/contacts/all", s.contacts)
	rt.handle("GET", "/api/contacts", s.contact)
	rt.handle("GET", "/api/contacts/check-exists", s.checkExists)
	rt.handle("GET", "/api/checkNumberStatus", s.checkExists)
	rt.handle("GET", "/api/contacts/profile-picture", s.profilePicture)
	rt.handle("GET", "/api/{session}/lids", s.lidList)
	rt.handle("GET", "/api/{session}/lids/count", s.lidCount)
	rt.handle("GET", "/api/{session}/lids/pn/{pn}", s.lidByPN)
	rt.handle("GET", "/api/{session}/lids/{lid}", s.lid)
	// sending
	rt.handle("POST", "/api/sendText", s.sendText)
	rt.handle("POST", "/api/sendImage", s.sendMedia("image"))
	rt.handle("POST", "/api/sendFile", s.sendMedia("file"))
	rt.handle("POST", "/api/sendVideo", s.sendMedia("video"))
	rt.handle("POST", "/api/sendVoice", s.sendMedia("voice"))
	rt.handle("POST", "/api/sendLocation", s.sendLocation)
	rt.handle("POST", "/api/sendContactVcard", s.sendContacts)
	rt.handle("PUT", "/api/reaction", s.reaction)
	rt.handle("POST", "/api/sendSeen", s.sendSeen)
	rt.handle("POST", "/api/startTyping", s.typing(true))
	rt.handle("POST", "/api/stopTyping", s.typing(false))
	// files
	rt.handle("GET", "/api/files/{session}/{filename}", s.file)
	if s.M.Cfg.Pprof {
		mountPprof(rt)
	}
	return auth(apiKey, recoverer(s.Log, rt))
}

func recoverer(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Error("handler panicked", "path", r.URL.Path, "panic", v)
				writeErr(w, 500, "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// ---- responses ----

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

// writeEmpty answers with no body, as NestJS does when a handler returns nothing.
func writeEmpty(w http.ResponseWriter, code int) { w.WriteHeader(code) }

// writeErr uses NestJS's HttpException body: {message, error, statusCode}.
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, waha.OM{{K: "message", V: msg}, {K: "error", V: http.StatusText(code)}, {K: "statusCode", V: code}})
}

func sessionNotFound(w http.ResponseWriter) { writeErr(w, 404, "Session not found") }

// WAHA's 422 bodies for routes that need a WORKING session.
func sessionMissing(w http.ResponseWriter, name string) {
	writeJSON(w, 422, waha.OM{{K: "error", V: "Session \"" + name + "\" does not exist"}, {K: "session", V: name}})
}

func notWorking(w http.ResponseWriter, name string, st session.Status) {
	writeJSON(w, 422, waha.OM{{K: "error", V: "Session status is not as expected. Try again later or restart the session"}, {K: "session", V: name}, {K: "status", V: st}, {K: "expected", V: []string{"WORKING"}}})
}

// internalErr is NestJS's AllExceptionsFilter body; the WAHooks API reads exception.message.
func internalErr(w http.ResponseWriter, r *http.Request, code int, msg string) {
	writeJSON(w, code, waha.OM{
		{K: "statusCode", V: code},
		{K: "timestamp", V: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")},
		{K: "exception", V: waha.OM{{K: "message", V: msg}, {K: "name", V: "Error"}}},
		{K: "request", V: waha.OM{{K: "path", V: r.URL.Path}, {K: "method", V: r.Method}}},
		{K: "version", V: waha.OM{{K: "version", V: waha.Version}, {K: "engine", V: waha.Engine}, {K: "tier", V: "PLUS"}}},
	})
}

func (s *Server) fail(w http.ResponseWriter, r *http.Request, ss *session.Session, err error) {
	var leased session.ErrLeased
	var bad session.BadRequest
	switch {
	case errors.Is(err, session.ErrNotFound):
		sessionNotFound(w)
	case errors.Is(err, gwstore.ErrNotFound):
		writeErr(w, 404, "Not found")
	case errors.Is(err, session.ErrExists):
		writeErr(w, 422, err.Error())
	case errors.Is(err, session.ErrNotWorking) && ss != nil:
		notWorking(w, ss.Name, ss.Status())
	case errors.As(err, &leased):
		writeErr(w, 409, err.Error())
	case errors.As(err, &bad):
		writeErr(w, 400, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		internalErr(w, r, 500, "timed out")
	default:
		internalErr(w, r, 500, err.Error())
	}
}

func decode(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	// Base64 of the largest allowed file (WAGW_MEDIA_MAX_MB, default 100) is a third larger.
	b, err := io.ReadAll(io.LimitReader(r.Body, 160<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return session.BadRequest{Msg: "invalid JSON body: " + err.Error()}
	}
	return nil
}

func qint(r *http.Request, k string, d int) int {
	if v := r.URL.Query().Get(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return d
}

func qbool(r *http.Request, k string, d bool) bool {
	if v := r.URL.Query().Get(k); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return d
}

// sess finds a session for the session-management routes (404 "Session not found").
func (s *Server) sess(w http.ResponseWriter, name string) *session.Session {
	ss, err := s.M.Get(name)
	if err != nil {
		sessionNotFound(w)
		return nil
	}
	return ss
}

// sessW finds a session for routes that need it WORKING (422 bodies as WAHA).
func (s *Server) sessW(w http.ResponseWriter, name string) *session.Session {
	if name == "" {
		writeJSON(w, 422, waha.OM{{K: "error", V: "Session name is required"}})
		return nil
	}
	ss, err := s.M.Get(name)
	if err != nil {
		sessionMissing(w, name)
		return nil
	}
	return ss
}

func ctx(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// ---- ops ----

func (s *Server) health(w http.ResponseWriter, r *http.Request, _ params) {
	counts := s.M.CountByStatus()
	if err := s.M.DB.SQL.PingContext(r.Context()); err != nil {
		writeJSON(w, 503, map[string]any{"status": "error", "database": "unreachable", "sessions": counts})
		return
	}
	writeJSON(w, 200, map[string]any{"status": "ok", "sessions": counts, "uptimeSeconds": int(time.Since(s.Started).Seconds()), "version": Version})
}

func (s *Server) version(w http.ResponseWriter, r *http.Request, _ params) {
	writeJSON(w, 200, waha.OM{{K: "version", V: waha.Version}, {K: "engine", V: waha.Engine}, {K: "tier", V: "PLUS"}, {K: "browser", V: nil}, {K: "gateway", V: Version}})
}

func (s *Server) serverStatus(w http.ResponseWriter, r *http.Request, _ params) {
	writeJSON(w, 200, map[string]any{"startTimestamp": s.Started.UnixMilli(), "uptime": time.Since(s.Started).Milliseconds(), "worker": map[string]any{"id": s.M.Cfg.BoxID}})
}

// ---- sessions ----

// sessionInfo is WAHA's SessionInfo; withEngine adds engine as GET /api/sessions/{name} does.
func (s *Server) sessionInfo(ss *session.Session, withEngine bool) waha.OM {
	st := ss.Status()
	var me any
	if m := ss.Me(); m != nil {
		me = m
	}
	var presence any
	if st == session.StatusWorking {
		if s.M.Cfg.MarkOnline {
			presence = "online"
		} else {
			presence = "offline"
		}
	}
	out := waha.OM{
		{K: "name", V: ss.Name},
		{K: "status", V: st},
		{K: "config", V: json.RawMessage(ss.Config())},
		{K: "me", V: me},
		{K: "presence", V: presence},
		{K: "timestamps", V: waha.OM{{K: "activity", V: nil}}},
	}
	if withEngine {
		if st == session.StatusStopped {
			out = append(out, waha.KV{K: "engine", V: struct{}{}})
		} else {
			out = append(out, waha.KV{K: "engine", V: waha.OM{{K: "engine", V: waha.Engine}}})
		}
	}
	return out
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request, _ params) {
	all := qbool(r, "all", false)
	out := []waha.OM{}
	for _, ss := range s.M.List() {
		if !all && ss.Status() == session.StatusStopped {
			continue
		}
		out = append(out, s.sessionInfo(ss, false))
	}
	writeJSON(w, 200, out)
}

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,54}$`)

func (s *Server) createSession(w http.ResponseWriter, r *http.Request, _ params) {
	var body struct {
		Name   string          `json:"name"`
		Config json.RawMessage `json:"config"`
		Start  bool            `json:"start"`
		// Gateway extension: pin the source address (importing a device that already dials from one).
		SourceIP string `json:"x-gateway-source-ip"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	if body.Name == "" {
		body.Name = "session_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	if !nameRe.MatchString(body.Name) {
		writeJSON(w, 400, waha.OM{{K: "message", V: []string{"name must match /^[a-zA-Z0-9_-]*$/ and be at most 54 characters"}}, {K: "error", V: "Bad Request"}, {K: "statusCode", V: 400}})
		return
	}
	c, cancel := ctx(r, 20*time.Second)
	defer cancel()
	ss, err := s.M.Create(c, body.Name, body.Config, body.SourceIP)
	if err != nil {
		if errors.Is(err, session.ErrExists) {
			writeErr(w, 422, "Session '"+body.Name+"' already exists. Use PUT to update it.")
			return
		}
		s.fail(w, r, nil, err)
		return
	}
	// WAHA starts the session only when "start": true is sent.
	if body.Start {
		if err := ss.Start(c); err != nil {
			s.fail(w, r, ss, err)
			return
		}
	}
	writeJSON(w, 201, s.sessionInfo(ss, true))
}

// loadSession registers and starts a session adopted into the store by another process (`gateway adopt-device`)
// without restarting the gateway. 422 if this gateway already holds it.
func (s *Server) loadSession(w http.ResponseWriter, r *http.Request, p params) {
	c, cancel := ctx(r, 60*time.Second)
	defer cancel()
	ss, err := s.M.LoadAdopted(c, p["session"])
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 201, s.sessionInfo(ss, true))
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request, p params) {
	if ss := s.sess(w, p["session"]); ss != nil {
		writeJSON(w, 200, s.sessionInfo(ss, true))
	}
}

func (s *Server) updateSession(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sess(w, p["session"])
	if ss == nil {
		return
	}
	var body struct {
		Config json.RawMessage `json:"config"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	c, cancel := ctx(r, 20*time.Second)
	defer cancel()
	if err := ss.UpdateConfig(c, body.Config); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 200, s.sessionInfo(ss, true))
}

func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request, p params) {
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	if err := s.M.Delete(c, p["session"]); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	writeEmpty(w, 200)
}

func (s *Server) action(what string) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, p params) {
		ss := s.sess(w, p["session"])
		if ss == nil {
			return
		}
		s.do(w, r, ss, what)
	}
}

func (s *Server) do(w http.ResponseWriter, r *http.Request, ss *session.Session, what string) {
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	var err error
	switch what {
	case "start":
		err = ss.Start(c)
	case "stop":
		ss.Stop(c, true)
	case "restart":
		err = ss.Restart(c)
	case "logout":
		err = ss.Logout(c)
	}
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 201, s.sessionInfo(ss, true))
}

func (s *Server) legacyAction(what string) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, _ params) {
		var body struct {
			Name   string          `json:"name"`
			Config json.RawMessage `json:"config"`
		}
		if err := decode(r, &body); err != nil {
			s.fail(w, r, nil, err)
			return
		}
		if body.Name == "" {
			body.Name = "default"
		}
		ss, err := s.M.Get(body.Name)
		if err != nil && what == "start" {
			ss, err = s.M.Create(r.Context(), body.Name, body.Config, "")
		}
		if err != nil {
			s.fail(w, r, nil, err)
			return
		}
		s.do(w, r, ss, what)
	}
}

func (s *Server) me(w http.ResponseWriter, r *http.Request, p params) {
	ss, err := s.M.Get(p["session"])
	if err != nil || ss.Status() == session.StatusStopped {
		writeErr(w, 404, "We didn't find a session with name '"+p["session"]+"'.\nPlease start it first by using POST /api/sessions/"+p["session"]+"/start request")
		return
	}
	me := ss.Me()
	if me == nil {
		writeEmpty(w, 200)
		return
	}
	writeJSON(w, 200, me)
}

// ---- auth ----

// waitStatus waits up to d for the session to reach want (WAHA waits ≤10 s on the QR routes).
func waitStatus(c context.Context, ss *session.Session, want session.Status, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		st := ss.Status()
		if st == want {
			return true
		}
		if (st != session.StatusStarting && st != want) || time.Now().After(deadline) {
			return false
		}
		select {
		case <-c.Done():
			return false
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Server) qr(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 12*time.Second)
	defer cancel()
	waitStatus(c, ss, session.StatusScanQR, 10*time.Second)
	code, ok := ss.QR()
	if !ok {
		writeJSON(w, 422, waha.OM{{K: "error", V: "Session status is not as expected. Try again later or restart the session"}, {K: "session", V: ss.Name}, {K: "status", V: ss.Status()}, {K: "expected", V: []string{"SCAN_QR_CODE"}}})
		return
	}
	if r.URL.Query().Get("format") == "raw" {
		writeJSON(w, 200, map[string]string{"value": code})
		return
	}
	png, err := qrcode.Encode(code, qrcode.Medium, 512)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if r.Header.Get("Accept") == "application/json" {
		writeJSON(w, 200, waha.OM{{K: "mimetype", V: "image/png"}, {K: "data", V: base64.StdEncoding.EncodeToString(png)}})
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Content-Length", strconv.Itoa(len(png)))
	_, _ = w.Write(png)
}

func (s *Server) requestCode(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	var body struct {
		PhoneNumber string  `json:"phoneNumber"`
		Method      *string `json:"method"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if body.Method != nil {
		writeErr(w, 422, "method is not supported")
		return
	}
	digits := strings.Map(func(c rune) rune {
		if c >= '0' && c <= '9' {
			return c
		}
		return -1
	}, body.PhoneNumber)
	if digits == "" {
		writeJSON(w, 400, waha.OM{{K: "message", V: []string{"phoneNumber must be a string"}}, {K: "error", V: "Bad Request"}, {K: "statusCode", V: 400}})
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	waitStatus(c, ss, session.StatusScanQR, 10*time.Second)
	if st := ss.Status(); st != session.StatusScanQR {
		writeErr(w, 422, "Can request code only in SCAN_QR_CODE status. The current status is "+string(st))
		return
	}
	code, err := ss.RequestCode(c, digits)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 201, map[string]string{"code": code})
}

// ---- chats & messages ----

func notListed(j types.JID) bool {
	return j.Server == types.BroadcastServer || j.Server == types.NewsletterServer
}

func (s *Server) chats(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	asc := strings.EqualFold(r.URL.Query().Get("sortOrder"), "asc")
	views, err := ss.ChatRows(c, qint(r, "limit", 20), qint(r, "offset", 0), asc)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	out := make([]waha.OM, 0, len(views))
	for _, v := range views {
		if v.Row.LastTS == 0 {
			continue
		}
		out = append(out, waha.ChatSummary(v))
	}
	writeJSON(w, 200, out)
}

func (s *Server) chatsOverview(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	limit, offset := qint(r, "limit", 20), qint(r, "offset", 0)
	o := ss.RenderOpts(false)
	out := []waha.OM{}
	// Broadcasts and newsletters are not listed; page past them.
	for len(out) < limit {
		views, err := ss.ChatRows(c, limit, offset, false)
		if err != nil {
			s.fail(w, r, ss, err)
			return
		}
		for _, v := range views {
			if notListed(v.JID) || len(out) >= limit {
				continue
			}
			out = append(out, waha.ChatOverview(v, o))
		}
		if len(views) < limit {
			break
		}
		offset += limit
	}
	writeJSON(w, 200, out)
}

func (s *Server) messages(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	q := r.URL.Query()
	f := gwstore.MessageFilter{Limit: qint(r, "limit", 10), Offset: qint(r, "offset", 0)}
	if f.Limit <= 0 {
		f.Limit = 10
	}
	if f.Limit > 1000 {
		f.Limit = 1000
	}
	if v := q.Get("filter.timestamp.gte"); v != "" {
		f.TSGte, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := q.Get("filter.timestamp.lte"); v != "" {
		f.TSLte, _ = strconv.ParseInt(v, 10, 64)
	}
	if v := q.Get("filter.fromMe"); v != "" {
		b, _ := strconv.ParseBool(v)
		f.FromMe = &b
	}
	if v := q.Get("filter.ack"); v != "" {
		if n, ok := waha.AckByName(v); ok {
			f.Ack = &n
		}
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	msgs, err := ss.Messages(c, p["chatId"], f)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if strings.EqualFold(q.Get("sortOrder"), "asc") {
		sort.SliceStable(msgs, func(i, j int) bool { return msgs[i].Info.Timestamp.Before(msgs[j].Info.Timestamp) })
	}
	o := ss.RenderOpts(qbool(r, "downloadMedia", true))
	out := make([]any, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, waha.Message(m, o))
	}
	writeJSON(w, 200, out)
}

func (s *Server) message(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	m, err := ss.Message(c, p["chatId"], p["messageId"])
	if err != nil {
		if errors.Is(err, gwstore.ErrNotFound) {
			writeErr(w, 404, "Message not found")
			return
		}
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 200, waha.Message(m, ss.RenderOpts(qbool(r, "downloadMedia", true))))
}

func (s *Server) editMessage(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := decode(r, &body); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	m, err := ss.Edit(c, p["chatId"], p["messageId"], body.Text)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 200, waha.SendResult(m))
}

func (s *Server) readMessages(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	ids, err := ss.Seen(c, p["chatId"], nil, "")
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, 201, map[string]any{"ids": ids})
}

// ---- contacts ----

func (s *Server) contacts(w http.ResponseWriter, r *http.Request, _ params) {
	ss := s.sessW(w, r.URL.Query().Get("session"))
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	views, err := ss.Contacts(c, qint(r, "limit", 0), qint(r, "offset", 0))
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	out := make([]waha.OM, 0, len(views))
	for _, v := range views {
		out = append(out, waha.Contact(v))
	}
	writeJSON(w, 200, out)
}

func (s *Server) contact(w http.ResponseWriter, r *http.Request, _ params) {
	ss := s.sessW(w, r.URL.Query().Get("session"))
	if ss == nil {
		return
	}
	j, err := session.ParseChatID(r.URL.Query().Get("contactId"))
	if err != nil {
		writeJSON(w, 400, waha.OM{{K: "message", V: []string{"contactId must be a string"}}, {K: "error", V: "Bad Request"}, {K: "statusCode", V: 400}})
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	views, err := ss.Contacts(c, 0, 0)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	for _, v := range views {
		if v.JID.ToNonAD() == j.ToNonAD() {
			writeJSON(w, 200, waha.Contact(v))
			return
		}
	}
	writeEmpty(w, 200)
}

func (s *Server) checkExists(w http.ResponseWriter, r *http.Request, _ params) {
	ss := s.sessW(w, r.URL.Query().Get("session"))
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	ok, jid, err := ss.CheckExists(c, r.URL.Query().Get("phone"))
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if !ok {
		writeJSON(w, 200, map[string]any{"numberExists": false})
		return
	}
	writeJSON(w, 200, waha.OM{{K: "numberExists", V: true}, {K: "chatId", V: waha.CUs(jid)}})
}

func (s *Server) profilePicture(w http.ResponseWriter, r *http.Request, _ params) {
	ss := s.sessW(w, r.URL.Query().Get("session"))
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	url, err := ss.ProfilePicture(c, r.URL.Query().Get("contactId"), qbool(r, "refresh", false))
	if err != nil && errors.Is(err, session.ErrNotWorking) {
		s.fail(w, r, ss, err)
		return
	}
	var v any
	if url != "" && err == nil {
		v = url
	}
	writeJSON(w, 200, map[string]any{"profilePictureURL": v})
}

func (s *Server) lid(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	arg := p["lid"]
	if !strings.Contains(arg, "@") {
		arg += "@lid"
	}
	if !strings.HasSuffix(arg, "@lid") {
		writeErr(w, 422, "Invalid LID - it must end with @lid")
		return
	}
	c, cancel := ctx(r, 5*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	lid, pn, _ := ss.LIDPair(c, arg)
	if lid.IsEmpty() {
		lid, _ = types.ParseJID(arg)
	}
	writeJSON(w, 200, waha.LIDPair(lid, pn))
}

func (s *Server) lidByPN(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	arg := p["pn"]
	c, cancel := ctx(r, 5*time.Second)
	defer cancel()
	if _, err := ss.WaitClient(c); err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if strings.HasSuffix(arg, "@lid") {
		l, _ := types.ParseJID(arg)
		writeJSON(w, 200, waha.LIDPair(l, types.EmptyJID))
		return
	}
	if !strings.Contains(arg, "@") {
		arg += "@c.us"
	}
	lid, pn, _ := ss.LIDPair(c, arg)
	if pn.IsEmpty() {
		pn, _ = session.ParseChatID(arg)
	}
	writeJSON(w, 200, waha.LIDPair(lid, pn))
}

func (s *Server) lidPairs(w http.ResponseWriter, r *http.Request, ss *session.Session) ([]waha.OM, bool) {
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	views, err := ss.Contacts(c, 0, 0)
	if err != nil {
		s.fail(w, r, ss, err)
		return nil, false
	}
	type pair struct{ lid, pn types.JID }
	seen := map[string]bool{}
	var pairs []pair
	for _, v := range views {
		if v.LID.IsEmpty() || v.PN.IsEmpty() || seen[v.LID.User] {
			continue
		}
		seen[v.LID.User] = true
		pairs = append(pairs, pair{v.LID, v.PN})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].lid.String() < pairs[j].lid.String() })
	out := make([]waha.OM, 0, len(pairs))
	for _, p := range pairs {
		out = append(out, waha.LIDPair(p.lid, p.pn))
	}
	return out, true
}

func (s *Server) lidList(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	out, ok := s.lidPairs(w, r, ss)
	if !ok {
		return
	}
	off, lim := qint(r, "offset", 0), qint(r, "limit", 100)
	if off > len(out) {
		off = len(out)
	}
	out = out[off:]
	if lim > 0 && lim < len(out) {
		out = out[:lim]
	}
	writeJSON(w, 200, out)
}

func (s *Server) lidCount(w http.ResponseWriter, r *http.Request, p params) {
	ss := s.sessW(w, p["session"])
	if ss == nil {
		return
	}
	out, ok := s.lidPairs(w, r, ss)
	if !ok {
		return
	}
	writeJSON(w, 200, map[string]int{"count": len(out)})
}

// ---- sending ----

type sendBase struct {
	Session string `json:"session"`
	ChatID  string `json:"chatId"`
	ReplyTo string `json:"reply_to"`
}

func (s *Server) sendSession(w http.ResponseWriter, b *sendBase) *session.Session {
	ss := s.sessW(w, b.Session)
	if ss == nil {
		return nil
	}
	if b.ChatID == "" {
		writeJSON(w, 400, waha.OM{{K: "message", V: []string{"chatId should not be empty"}}, {K: "error", V: "Bad Request"}, {K: "statusCode", V: 400}})
		return nil
	}
	return ss
}

func (s *Server) sent(w http.ResponseWriter, r *http.Request, ss *session.Session, m *waha.Msg, err error) {
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 201, waha.SendResult(m))
}

func (s *Server) sendText(w http.ResponseWriter, r *http.Request, _ params) {
	var b struct {
		sendBase
		Text        string   `json:"text"`
		Mentions    []string `json:"mentions"`
		LinkPreview *bool    `json:"linkPreview"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	ss := s.sendSession(w, &b.sendBase)
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	m, err := ss.SendText(c, b.ChatID, b.Text, b.ReplyTo, b.Mentions, b.LinkPreview)
	s.sent(w, r, ss, m, err)
}

func (s *Server) sendMedia(kind string) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, _ params) {
		var b struct {
			sendBase
			File    session.FileInput `json:"file"`
			Caption string            `json:"caption"`
		}
		if err := decode(r, &b); err != nil {
			s.fail(w, r, nil, err)
			return
		}
		ss := s.sendSession(w, &b.sendBase)
		if ss == nil {
			return
		}
		c, cancel := ctx(r, 5*time.Minute)
		defer cancel()
		m, err := ss.SendMedia(c, kind, b.ChatID, b.File, b.Caption, b.ReplyTo)
		s.sent(w, r, ss, m, err)
	}
}

func (s *Server) sendLocation(w http.ResponseWriter, r *http.Request, _ params) {
	var b struct {
		sendBase
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
		Title     string  `json:"title"`
		Address   string  `json:"address"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	ss := s.sendSession(w, &b.sendBase)
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	m, err := ss.SendLocation(c, b.ChatID, b.Latitude, b.Longitude, b.Title, b.Address, b.ReplyTo)
	s.sent(w, r, ss, m, err)
}

func (s *Server) sendContacts(w http.ResponseWriter, r *http.Request, _ params) {
	var b struct {
		sendBase
		Contacts []session.VCard `json:"contacts"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	ss := s.sendSession(w, &b.sendBase)
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	m, err := ss.SendContacts(c, b.ChatID, b.Contacts, b.ReplyTo)
	s.sent(w, r, ss, m, err)
}

func (s *Server) reaction(w http.ResponseWriter, r *http.Request, _ params) {
	var b struct {
		Session   string `json:"session"`
		MessageID string `json:"messageId"`
		Reaction  string `json:"reaction"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	ss := s.sessW(w, b.Session)
	if ss == nil {
		return
	}
	c, cancel := ctx(r, 28*time.Second)
	defer cancel()
	m, err := ss.React(c, b.MessageID, b.Reaction)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	writeJSON(w, 200, waha.SendResult(m))
}

func (s *Server) sendSeen(w http.ResponseWriter, r *http.Request, _ params) {
	var b struct {
		sendBase
		MessageID   string   `json:"messageId"`
		MessageIDs  []string `json:"messageIds"`
		Participant string   `json:"participant"`
	}
	if err := decode(r, &b); err != nil {
		s.fail(w, r, nil, err)
		return
	}
	ss := s.sendSession(w, &b.sendBase)
	if ss == nil {
		return
	}
	ids := b.MessageIDs
	if b.MessageID != "" {
		ids = append(ids, b.MessageID)
	}
	c, cancel := ctx(r, 25*time.Second)
	defer cancel()
	marked, err := ss.Seen(c, b.ChatID, ids, b.Participant)
	if err != nil {
		s.fail(w, r, ss, err)
		return
	}
	if len(ids) > 0 {
		writeEmpty(w, 201)
		return
	}
	if marked == nil {
		marked = []string{}
	}
	writeJSON(w, 201, map[string]any{"ids": marked})
}

func (s *Server) typing(on bool) func(http.ResponseWriter, *http.Request, params) {
	return func(w http.ResponseWriter, r *http.Request, _ params) {
		var b sendBase
		if err := decode(r, &b); err != nil {
			s.fail(w, r, nil, err)
			return
		}
		ss := s.sendSession(w, &b)
		if ss == nil {
			return
		}
		c, cancel := ctx(r, 20*time.Second)
		defer cancel()
		if err := ss.Typing(c, b.ChatID, on); err != nil {
			s.fail(w, r, ss, err)
			return
		}
		writeJSON(w, 201, map[string]any{"result": true})
	}
}

// ---- files ----

func fileNotFound(w http.ResponseWriter) {
	writeJSON(w, 404, map[string]any{"error": waha.OM{{K: "code", V: 404}, {K: "key", V: "FILE_NOT_FOUND"}, {K: "message", V: "File not found"}, {K: "details", V: "File not found or no longer available"}}})
}

func (s *Server) file(w http.ResponseWriter, r *http.Request, p params) {
	name := p["filename"]
	ss, err := s.M.Get(p["session"])
	if err != nil || name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		fileNotFound(w)
		return
	}
	c, cancel := ctx(r, 5*time.Minute)
	defer cancel()
	path, mt, err := ss.MediaFile(c, name)
	if err != nil {
		if errors.Is(err, session.ErrNoMedia) || errors.Is(err, session.ErrNotWorking) {
			fileNotFound(w)
			return
		}
		s.fail(w, r, ss, err)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		fileNotFound(w)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	ctype := mime.TypeByExtension(filepath.Ext(name))
	if ctype == "" {
		ctype = mt
	}
	if ctype != "" {
		w.Header().Set("Content-Type", ctype)
	}
	http.ServeContent(w, r, name, st.ModTime(), f)
}
