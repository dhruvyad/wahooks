package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dhruvyad/wahooks/gateway/internal/session"
)

func TestRouter(t *testing.T) {
	rt := &router{}
	var got string
	rt.handle("GET", "/api/sessions/{session}", func(w http.ResponseWriter, r *http.Request, p params) { got = "info:" + p["session"] })
	rt.handle("GET", "/api/{session}/chats", func(w http.ResponseWriter, r *http.Request, p params) { got = "chats:" + p["session"] })
	rt.handle("GET", "/api/{session}/chats/{chatId}/messages", func(w http.ResponseWriter, r *http.Request, p params) { got = "msgs:" + p["chatId"] })
	for path, want := range map[string]string{
		"/api/sessions/u_1_s_2":                         "info:u_1_s_2",
		"/api/u_1_s_2/chats":                            "chats:u_1_s_2",
		"/api/u_1_s_2/chats/123%40c.us/messages":        "msgs:123@c.us",
		"/api/u_1_s_2/chats/120363%40g.us/messages?x=1": "msgs:120363@g.us",
	} {
		got = ""
		rt.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", path, nil))
		if got != want {
			t.Errorf("%s: got %q want %q", path, got, want)
		}
	}
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, httptest.NewRequest("POST", "/api/u_1_s_2/chats", nil))
	if rec.Code != 405 {
		t.Fatal(rec.Code)
	}
}

func TestAuth(t *testing.T) {
	h := auth("k", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions", nil))
	if rec.Code != 401 {
		t.Fatal(rec.Code)
	}
	req := httptest.NewRequest("GET", "/api/sessions", nil)
	req.Header.Set("X-Api-Key", "k")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 204 {
		t.Fatal(rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	if rec.Code != 204 {
		t.Fatal(rec.Code)
	}
}

func TestGroupRoutes(t *testing.T) {
	rt := &router{}
	var got string
	h := func(name string) func(http.ResponseWriter, *http.Request, params) {
		return func(w http.ResponseWriter, r *http.Request, p params) {
			got = name + ":" + p["session"] + ":" + p["id"]
		}
	}
	// Registered as in Handler, alongside the routes they could be confused with.
	rt.handle("POST", "/api/sessions/{session}/start", h("start"))
	rt.handle("GET", "/api/{session}/chats/{chatId}/messages/{messageId}", h("message"))
	rt.handle("POST", "/api/{session}/groups", h("create"))
	rt.handle("GET", "/api/{session}/groups/{id}", h("get"))
	rt.handle("POST", "/api/{session}/groups/{id}/participants/add", h("add"))
	rt.handle("POST", "/api/{session}/groups/{id}/participants/remove", h("remove"))
	rt.handle("POST", "/api/{session}/groups/{id}/leave", h("leave"))
	for req, want := range map[string]string{
		"POST /api/u_1_s_2/groups":                                   "create:u_1_s_2:",
		"GET /api/u_1_s_2/groups/120363%40g.us":                      "get:u_1_s_2:120363@g.us",
		"GET /api/u_1_s_2/groups/120363@g.us":                        "get:u_1_s_2:120363@g.us",
		"POST /api/u_1_s_2/groups/120363%40g.us/participants/add":    "add:u_1_s_2:120363@g.us",
		"POST /api/u_1_s_2/groups/120363%40g.us/participants/remove": "remove:u_1_s_2:120363@g.us",
		"POST /api/u_1_s_2/groups/120363%40g.us/leave":               "leave:u_1_s_2:120363@g.us",
		"POST /api/sessions/u_1_s_2/start":                           "start:u_1_s_2:",
	} {
		got = ""
		m, path, _ := strings.Cut(req, " ")
		rt.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(m, path, nil))
		if got != want {
			t.Errorf("%s: got %q want %q", req, got, want)
		}
	}
}

func TestParticipantIDs(t *testing.T) {
	var b struct {
		Participants participantIDs `json:"participants"`
	}
	if err := json.Unmarshal([]byte(`{"participants":[{"id":"1@c.us"},"2@c.us"]}`), &b); err != nil || len(b.Participants) != 2 ||
		b.Participants[0] != "1@c.us" || b.Participants[1] != "2@c.us" {
		t.Fatalf("%v %v", err, b.Participants)
	}
	var bad session.BadRequest
	if err := json.Unmarshal([]byte(`{"participants":[{"name":"x"}]}`), &b); !errors.As(err, &bad) {
		t.Fatalf("want BadRequest, got %v", err)
	}
}

func TestFailStatusError(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	s.fail(rec, httptest.NewRequest("GET", "/api/x/groups/1@g.us", nil), nil, session.StatusError{Code: 404, Msg: "Group not found"})
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), `"message":"Group not found"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}
