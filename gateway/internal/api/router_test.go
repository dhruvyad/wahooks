package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
