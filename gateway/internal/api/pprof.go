package api

import (
	"net/http"
	"net/http/pprof"
)

// mountPprof exposes Go's profiler behind the API key (WAGW_PPROF=1), for density benchmarks.
func mountPprof(rt *router) {
	h := func(f http.HandlerFunc) func(http.ResponseWriter, *http.Request, params) {
		return func(w http.ResponseWriter, r *http.Request, _ params) { f(w, r) }
	}
	rt.handle("GET", "/debug/pprof", h(pprof.Index))
	rt.handle("GET", "/debug/pprof/profile", h(pprof.Profile))
	rt.handle("GET", "/debug/pprof/trace", h(pprof.Trace))
	for _, n := range []string{"heap", "goroutine", "allocs", "block", "mutex", "threadcreate"} {
		rt.handle("GET", "/debug/pprof/"+n, h(pprof.Handler(n).ServeHTTP))
	}
}
