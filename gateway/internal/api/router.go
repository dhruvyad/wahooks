// Package api serves the WAHA-compatible HTTP API on top of the session manager.
package api

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"strings"
)

// router matches "METHOD /seg/{param}/seg" patterns segment by segment, first registered match wins. Go's
// ServeMux refuses WAHA's route set (/api/{session}/chats overlaps /api/sessions/{session}).
type router struct {
	routes []route
}

type route struct {
	method string
	segs   []string
	h      func(w http.ResponseWriter, r *http.Request, p params)
}

type params map[string]string

func (rt *router) handle(method, pattern string, h func(w http.ResponseWriter, r *http.Request, p params)) {
	rt.routes = append(rt.routes, route{method: method, segs: strings.Split(strings.Trim(pattern, "/"), "/"), h: h})
}

func splitPath(r *http.Request) []string {
	raw := strings.Trim(r.URL.EscapedPath(), "/")
	parts := strings.Split(raw, "/")
	for i, p := range parts {
		if u, err := url.PathUnescape(p); err == nil {
			parts[i] = u
		}
	}
	return parts
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	segs := splitPath(r)
	methodMismatch := false
	for _, ro := range rt.routes {
		if len(ro.segs) != len(segs) {
			continue
		}
		p := params{}
		ok := true
		for i, s := range ro.segs {
			if strings.HasPrefix(s, "{") {
				p[s[1:len(s)-1]] = segs[i]
			} else if s != segs[i] {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		if ro.method != r.Method {
			methodMismatch = true
			continue
		}
		ro.h(w, r, p)
		return
	}
	if methodMismatch {
		writeErr(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	writeErr(w, http.StatusNotFound, "Cannot "+r.Method+" "+r.URL.Path)
}

// auth requires X-Api-Key (or ?x-api-key=) on everything except /health and /metrics.
func auth(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if key != "" && r.URL.Path != "/health" && r.URL.Path != "/metrics" && r.URL.Path != "/ping" {
			got := r.Header.Get("X-Api-Key")
			if got == "" {
				got = r.URL.Query().Get("x-api-key")
			}
			if subtle.ConstantTimeCompare([]byte(got), []byte(key)) != 1 {
				writeErr(w, http.StatusUnauthorized, "Unauthorized")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
