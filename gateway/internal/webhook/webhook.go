// Package webhook delivers WAHA-shaped events to each session's configured webhook URLs: a shared worker pool,
// a single scheduler for retries (no goroutine or timer per event or per account), HMAC when configured.
package webhook

import (
	"bytes"
	"container/heap"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha512"
	"encoding/hex"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dhruvyad/wahooks/gateway/internal/netx"
)

// Retries mirrors WAHA's config.webhooks[].retries.
type Retries struct {
	Policy       string `json:"policy,omitempty"` // constant | linear | exponential
	DelaySeconds *int   `json:"delaySeconds,omitempty"`
	Attempts     *int   `json:"attempts,omitempty"`
}

type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type HMAC struct {
	Key string `json:"key,omitempty"`
}

// Target mirrors one entry of WAHA's config.webhooks.
type Target struct {
	URL           string   `json:"url"`
	Events        []string `json:"events"`
	HMAC          *HMAC    `json:"hmac,omitempty"`
	Retries       *Retries `json:"retries,omitempty"`
	CustomHeaders []Header `json:"customHeaders,omitempty"`
}

// Wants reports whether the target subscribes to event ("*" or the exact name).
func (t *Target) Wants(event string) bool {
	for _, e := range t.Events {
		if e == "*" || e == event {
			return true
		}
	}
	return false
}

type job struct {
	t          *Target
	body       []byte
	reqID      string
	ts         int64
	session    string
	event      string
	attempt    int
	retryAfter time.Duration
	due        time.Time
}

type Stats struct {
	Delivered, Retried, Failed, Dropped atomic.Int64
}

type Dispatcher struct {
	client *http.Client
	queue  chan *job
	log    *slog.Logger
	Stats  Stats

	mu      sync.Mutex
	delayed jobHeap
	wake    chan struct{}
	closed  atomic.Bool
	wg      sync.WaitGroup
	stop    chan struct{}
}

func New(workers, queueSize int, timeout time.Duration, resolve map[string]string, log *slog.Logger) *Dispatcher {
	tr := &http.Transport{
		DialContext:         netx.ResolveDialer(resolve),
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	d := &Dispatcher{
		client: &http.Client{Transport: tr, Timeout: timeout},
		queue:  make(chan *job, queueSize),
		log:    log,
		wake:   make(chan struct{}, 1),
		stop:   make(chan struct{}),
	}
	for i := 0; i < workers; i++ {
		d.wg.Add(1)
		go d.worker()
	}
	go d.scheduler()
	return d
}

// QueueDepth is the number of deliveries waiting (immediate + scheduled retries).
func (d *Dispatcher) QueueDepth() int {
	d.mu.Lock()
	n := len(d.delayed)
	d.mu.Unlock()
	return n + len(d.queue)
}

// UserAgent is sent with every delivery, as WAHA does.
var UserAgent = "WAHA/2026.10.1"

const idChars = "0123456789abcdefghijklmnopqrstuvwxyz"

// requestID mimics WAHA's uniqid(): 18 lowercase alphanumerics, the same across retries of one delivery.
func requestID() string {
	var b [18]byte
	_, _ = rand.Read(b[:])
	for i := range b {
		b[i] = idChars[int(b[i])%len(idChars)]
	}
	return string(b[:])
}

// Send queues body (an encoded WAHA envelope with timestamp ts in ms) for every target that wants event.
// Never blocks.
func (d *Dispatcher) Send(session, event string, ts int64, body []byte, targets []*Target) {
	if d.closed.Load() {
		return
	}
	for _, t := range targets {
		if t == nil || t.URL == "" || len(t.Events) == 0 || !t.Wants(event) {
			continue
		}
		j := &job{t: t, body: body, reqID: requestID(), ts: ts, session: session, event: event}
		select {
		case d.queue <- j:
		default:
			d.Stats.Dropped.Add(1)
			d.log.Warn("webhook queue full, event dropped", "session", session, "event", event)
		}
	}
}

func (d *Dispatcher) worker() {
	defer d.wg.Done()
	for {
		select {
		case j := <-d.queue:
			d.deliver(j)
		case <-d.stop:
			// Drain what is already queued, then exit.
			for {
				select {
				case j := <-d.queue:
					d.deliver(j)
				default:
					return
				}
			}
		}
	}
}

func (d *Dispatcher) deliver(j *job) {
	defer func() {
		if r := recover(); r != nil {
			d.log.Error("webhook delivery panicked", "session", j.session, "panic", r)
		}
	}()
	ok, status := d.post(j)
	if ok {
		d.Stats.Delivered.Add(1)
		return
	}
	retries, delay := retryPlan(j.t.Retries, j.attempt, j.retryAfter)
	j.attempt++
	if j.attempt > retries || d.closed.Load() {
		d.Stats.Failed.Add(1)
		d.log.Warn("webhook delivery failed", "session", j.session, "event", j.event, "status", status, "attempts", j.attempt)
		return
	}
	d.Stats.Retried.Add(1)
	j.due = time.Now().Add(delay)
	d.mu.Lock()
	if len(d.delayed) >= cap(d.queue) {
		d.mu.Unlock()
		d.Stats.Dropped.Add(1)
		return
	}
	heap.Push(&d.delayed, j)
	d.mu.Unlock()
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// retryPlan returns how many retries are allowed and the wait before the next one, after attempt (0-based)
// failed. WAHA's defaults: 15 retries, 2 s apart, constant policy, every failure retried; constant waits at
// least Retry-After; exponential adds up to 20 % jitter.
func retryPlan(r *Retries, attempt int, retryAfter time.Duration) (int, time.Duration) {
	retries, delay, policy := 15, 2, "constant"
	if r != nil {
		if r.Attempts != nil {
			retries = *r.Attempts
		}
		if r.DelaySeconds != nil {
			delay = *r.DelaySeconds
		}
		if r.Policy != "" {
			policy = r.Policy
		}
	}
	base := time.Duration(delay) * time.Second
	switch policy {
	case "linear":
		return retries, base * time.Duration(attempt+1)
	case "exponential":
		f := math.Pow(2, float64(attempt))
		if f > 1024 {
			f = 1024
		}
		w := time.Duration(float64(base) * f)
		var j [1]byte
		_, _ = rand.Read(j[:])
		return retries, w + time.Duration(float64(w)*0.2*float64(j[0])/255)
	default:
		if retryAfter > base {
			return retries, retryAfter
		}
		return retries, base
	}
}

func (d *Dispatcher) post(j *job) (bool, int) {
	ctx, cancel := context.WithTimeout(context.Background(), d.client.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, j.t.URL, bytes.NewReader(j.body))
	if err != nil {
		return false, 0
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", UserAgent)
	for _, h := range j.t.CustomHeaders {
		if h.Name != "" {
			req.Header.Set(h.Name, h.Value)
		}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Webhook-Request-Id", j.reqID)
	req.Header.Set("X-Webhook-Timestamp", strconv.FormatInt(j.ts, 10))
	if j.t.HMAC != nil && j.t.HMAC.Key != "" {
		m := hmac.New(sha512.New, []byte(j.t.HMAC.Key))
		m.Write(j.body)
		req.Header.Set("X-Webhook-Hmac", hex.EncodeToString(m.Sum(nil)))
		req.Header.Set("X-Webhook-Hmac-Algorithm", "sha512")
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return false, 0
	}
	j.retryAfter = 0
	if ra := resp.Header.Get("Retry-After"); ra != "" {
		if n, err := strconv.Atoi(ra); err == nil && n > 0 && n < 3600 {
			j.retryAfter = time.Duration(n) * time.Second
		}
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp.StatusCode >= 200 && resp.StatusCode < 300, resp.StatusCode
}

func (d *Dispatcher) scheduler() {
	t := time.NewTimer(time.Hour)
	defer t.Stop()
	for {
		d.mu.Lock()
		now := time.Now()
		var due []*job
		for len(d.delayed) > 0 && !d.delayed[0].due.After(now) {
			due = append(due, heap.Pop(&d.delayed).(*job))
		}
		next := time.Hour
		if len(d.delayed) > 0 {
			next = time.Until(d.delayed[0].due)
		}
		d.mu.Unlock()
		for _, j := range due {
			if d.closed.Load() {
				d.Stats.Failed.Add(1)
				continue
			}
			select {
			case d.queue <- j:
			default:
				d.Stats.Dropped.Add(1)
			}
		}
		t.Reset(next)
		select {
		case <-t.C:
		case <-d.wake:
			if !t.Stop() {
				select {
				case <-t.C:
				default:
				}
			}
		case <-d.stop:
			return
		}
	}
}

// Close stops accepting events and waits up to grace for queued deliveries (retries are abandoned).
func (d *Dispatcher) Close(grace time.Duration) {
	if d.closed.Swap(true) {
		return
	}
	close(d.stop)
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(grace):
	}
}

type jobHeap []*job

func (h jobHeap) Len() int           { return len(h) }
func (h jobHeap) Less(i, j int) bool { return h[i].due.Before(h[j].due) }
func (h jobHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *jobHeap) Push(x any)        { *h = append(*h, x.(*job)) }
func (h *jobHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
