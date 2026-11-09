// Package metrics renders Prometheus text exposition without a client library: sessions by status, process
// memory, goroutines, event counters and rate, webhook delivery counters.
package metrics

import (
	"fmt"
	"net/http"
	"os"
	"runtime"
	rtmetrics "runtime/metrics"
	"sort"
	"strconv"
	"strings"

	"github.com/dhruvyad/wahooks/gateway/internal/session"
	"github.com/dhruvyad/wahooks/gateway/internal/store"
	"github.com/dhruvyad/wahooks/gateway/internal/webhook"
)

type Handler struct {
	M     *session.Manager
	Hooks *webhook.Dispatcher
}

var liveSample = []rtmetrics.Sample{{Name: "/gc/heap/live:bytes"}}

func liveHeap() uint64 {
	s := make([]rtmetrics.Sample, 1)
	copy(s, liveSample)
	rtmetrics.Read(s)
	if s[0].Value.Kind() != rtmetrics.KindUint64 {
		return 0
	}
	return s[0].Value.Uint64()
}

// RSSBytes reads VmRSS from /proc (Linux); -1 elsewhere.
func RSSBytes() int64 {
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return -1
	}
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "VmRSS:") {
			f := strings.Fields(l)
			if len(f) >= 2 {
				n, _ := strconv.ParseInt(f[1], 10, 64)
				return n * 1024
			}
		}
	}
	return -1
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var b strings.Builder
	g := func(name, help string, v any) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n%s %v\n", name, help, name, name, v)
	}
	b.WriteString("# HELP wagw_sessions Sessions by WAHA status.\n# TYPE wagw_sessions gauge\n")
	counts := h.M.CountByStatus()
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, string(k))
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "wagw_sessions{status=%q} %d\n", k, counts[session.Status(k)])
	}
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	g("wagw_process_rss_bytes", "Resident set size.", RSSBytes())
	g("wagw_go_heap_inuse_bytes", "Go heap in use.", ms.HeapInuse)
	g("wagw_go_heap_alloc_bytes", "Go heap allocated objects.", ms.HeapAlloc)
	// Live heap as of the last GC: what the accounts really hold. RSS and heap_alloc include garbage and GC headroom,
	// which under message bursts can be 2x the live heap (bench/density/RESULTS.md §9).
	g("wagw_go_heap_live_bytes", "Go heap live after the last GC (runtime/metrics /gc/heap/live:bytes).", liveHeap())
	g("wagw_go_stack_bytes", "Goroutine stacks in use.", ms.StackInuse)
	g("wagw_go_gc_cycles_total", "Completed GC cycles.", ms.NumGC)
	g("wagw_go_sys_bytes", "Memory obtained from the OS by the Go runtime.", ms.Sys)
	g("wagw_goroutines", "Goroutines.", runtime.NumGoroutine())
	if fds, err := os.ReadDir("/proc/self/fd"); err == nil {
		g("wagw_open_fds", "Open file descriptors.", len(fds))
	}
	g("wagw_events_per_second", "WhatsApp events per second over the last 5 s.", h.M.Counters.Rate.Load())
	b.WriteString("# HELP wagw_events_total Events emitted, by WAHA event name.\n# TYPE wagw_events_total counter\n")
	ev := h.M.Counters.Snapshot()
	names := make([]string, 0, len(ev))
	for k := range ev {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		fmt.Fprintf(&b, "wagw_events_total{event=%q} %d\n", k, ev[k])
	}
	c := &h.M.Counters
	b.WriteString("# HELP wagw_connections_total WhatsApp connection events across all sessions.\n# TYPE wagw_connections_total counter\n")
	fmt.Fprintf(&b, "wagw_connections_total{kind=\"connected\"} %d\n", c.Connects.Load())
	fmt.Fprintf(&b, "wagw_connections_total{kind=\"disconnected\"} %d\n", c.Disconnects.Load())
	fmt.Fprintf(&b, "wagw_connections_total{kind=\"logged_out\"} %d\n", c.LoggedOut.Load())
	fmt.Fprintf(&b, "wagw_connections_total{kind=\"stream_replaced\"} %d\n", c.StreamReplaced.Load())
	fmt.Fprintf(&b, "wagw_connections_total{kind=\"temporary_ban\"} %d\n", c.Bans.Load())
	st := &h.Hooks.Stats
	b.WriteString("# HELP wagw_webhook_deliveries_total Webhook deliveries by result.\n# TYPE wagw_webhook_deliveries_total counter\n")
	fmt.Fprintf(&b, "wagw_webhook_deliveries_total{result=\"delivered\"} %d\n", st.Delivered.Load())
	fmt.Fprintf(&b, "wagw_webhook_deliveries_total{result=\"retried\"} %d\n", st.Retried.Load())
	fmt.Fprintf(&b, "wagw_webhook_deliveries_total{result=\"failed\"} %d\n", st.Failed.Load())
	fmt.Fprintf(&b, "wagw_webhook_deliveries_total{result=\"dropped\"} %d\n", st.Dropped.Load())
	g("wagw_webhook_queue_depth", "Deliveries waiting, including scheduled retries.", h.Hooks.QueueDepth())
	if db := h.M.DB.SQL.Stats(); true {
		g("wagw_db_open_connections", "Open database connections.", db.OpenConnections)
		g("wagw_db_in_use_connections", "Database connections in use.", db.InUse)
		g("wagw_db_wait_count", "Total waits for a database connection.", db.WaitCount)
	}
	if b, ok := h.M.DB.LIDs.(*store.BoundedLIDMap); ok {
		g("wagw_lid_cache_entries", "Entries in the bounded PN/LID cache.", b.Len())
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(b.String()))
}
