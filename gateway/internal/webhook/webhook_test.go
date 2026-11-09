package webhook

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func intp(i int) *int { return &i }

func TestDeliveryHMACAndRetry(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	var ids []string
	var gotSig, gotAlg, gotTS, ua, custom string
	body := []byte(`{"event":"message","timestamp":123}`)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if string(b) != string(body) {
			t.Errorf("body changed")
		}
		mu.Lock()
		ids = append(ids, r.Header.Get("X-Webhook-Request-Id"))
		gotSig, gotAlg, gotTS = r.Header.Get("X-Webhook-Hmac"), r.Header.Get("X-Webhook-Hmac-Algorithm"), r.Header.Get("X-Webhook-Timestamp")
		ua, custom = r.Header.Get("User-Agent"), r.Header.Get("X-Custom")
		mu.Unlock()
		if calls.Add(1) < 3 {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()
	d := New(2, 10, 5*time.Second, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer d.Close(time.Second)
	tg := &Target{URL: srv.URL, Events: []string{"message"}, HMAC: &HMAC{Key: "s3cr3t"},
		Retries: &Retries{DelaySeconds: intp(0), Attempts: intp(5)}, CustomHeaders: []Header{{Name: "X-Custom", Value: "v"}}}
	d.Send("s", "message", 123, body, []*Target{tg})
	d.Send("s", "message.any", 123, body, []*Target{tg}) // not subscribed
	for i := 0; i < 200 && d.Stats.Delivered.Load() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if d.Stats.Delivered.Load() != 1 || calls.Load() != 3 || d.Stats.Retried.Load() != 2 {
		t.Fatalf("delivered=%d calls=%d retried=%d", d.Stats.Delivered.Load(), calls.Load(), d.Stats.Retried.Load())
	}
	m := hmac.New(sha512.New, []byte("s3cr3t"))
	m.Write(body)
	mu.Lock()
	defer mu.Unlock()
	if gotSig != hex.EncodeToString(m.Sum(nil)) || gotAlg != "sha512" || gotTS != "123" || custom != "v" || ua == "" {
		t.Fatalf("headers sig=%v alg=%q ts=%q custom=%q ua=%q", gotSig != "", gotAlg, gotTS, custom, ua)
	}
	if len(ids[0]) != 18 || ids[0] != ids[1] || ids[1] != ids[2] {
		t.Fatalf("request id must be 18 chars and stable across retries: %v", ids)
	}
}

func TestNoRetryWhenAttemptsZero(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(503)
	}))
	defer srv.Close()
	d := New(1, 10, 5*time.Second, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer d.Close(time.Second)
	d.Send("s", "x", 1, []byte(`{}`), []*Target{{URL: srv.URL, Events: []string{"*"}, Retries: &Retries{Attempts: intp(0)}}})
	for i := 0; i < 200 && d.Stats.Failed.Load() == 0; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if calls.Load() != 1 || d.Stats.Failed.Load() != 1 {
		t.Fatalf("calls=%d failed=%d", calls.Load(), d.Stats.Failed.Load())
	}
}

func TestRetryPlan(t *testing.T) {
	if n, w := retryPlan(nil, 0, 0); n != 15 || w != 2*time.Second {
		t.Fatal(n, w)
	}
	if _, w := retryPlan(nil, 0, 7*time.Second); w != 7*time.Second {
		t.Fatal("Retry-After", w)
	}
	if _, w := retryPlan(&Retries{Policy: "linear", DelaySeconds: intp(3)}, 2, 0); w != 9*time.Second {
		t.Fatal("linear", w)
	}
	if _, w := retryPlan(&Retries{Policy: "exponential", DelaySeconds: intp(1)}, 3, 0); w < 8*time.Second || w > 10*time.Second {
		t.Fatal("exponential", w)
	}
}
