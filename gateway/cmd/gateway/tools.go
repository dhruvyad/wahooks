package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	qrcode "github.com/skip2/go-qrcode"
	"io"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// sink is a webhook receiver for tests on a box: it appends each POST body as one JSON line to a root-only file.
// It never prints bodies (they hold message content and phone numbers).
func sink(args []string) {
	fs := flag.NewFlagSet("sink", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:3999", "address to listen on")
	out := fs.String("out", "/var/lib/wagw/sink.jsonl", "file to append events to")
	_ = fs.Parse(args)
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var mu sync.Mutex
	n := 0
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		var env struct {
			Event string `json:"event"`
		}
		_ = json.Unmarshal(b, &env)
		line, _ := json.Marshal(map[string]any{"at": time.Now().UnixMilli(), "headers": map[string]string{
			"content-type": r.Header.Get("Content-Type"), "x-webhook-request-id": r.Header.Get("X-Webhook-Request-Id"),
			"x-webhook-timestamp": r.Header.Get("X-Webhook-Timestamp"), "x-webhook-hmac-algorithm": r.Header.Get("X-Webhook-Hmac-Algorithm"),
		}, "body": json.RawMessage(b)})
		mu.Lock()
		_, _ = f.Write(append(line, '\n'))
		n++
		c := n
		mu.Unlock()
		fmt.Printf("event #%d %s (%d bytes)\n", c, env.Event, len(b))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"received":true}`))
	})
	fmt.Println("sink listening on", *listen)
	if err := http.ListenAndServe(*listen, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

var (
	jidLike   = regexp.MustCompile(`^(true_|false_)?([^@_]+)@([a-z.]+)(.*)$`)
	safeKeys  = map[string]bool{"status": true, "event": true, "ackName": true, "source": true, "engine": true, "mimetype": true, "type": true, "addressingMode": true, "policy": true, "tier": true, "error": true, "lastKnownPresence": true, "content-type": true, "x-webhook-hmac-algorithm": true, "statusCode": true, "message": false, "version": true, "role": true}
	safeNums  = map[string]bool{"timestamp": true, "ack": true, "status": true, "messageTimestamp": true, "fileLength": true, "count": true, "statusCode": true, "at": true, "conversationTimestamp": true, "unreadCount": true, "uptimeSeconds": true, "seconds": true}
	digitsRun = regexp.MustCompile(`[0-9]{6,}`)
)

func redactString(key, s string) string {
	if safeKeys[key] {
		return digitsRun.ReplaceAllString(s, "<n>")
	}
	if m := jidLike.FindStringSubmatch(s); m != nil && !strings.Contains(s, " ") {
		rest := m[4]
		if rest != "" {
			rest = "<…>"
		}
		return m[1] + "<user>@" + m[3] + rest
	}
	if strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") {
		if i := strings.Index(s[8:], "/"); i >= 0 {
			return s[:8+i] + "/<path>"
		}
		return s
	}
	return fmt.Sprintf("<str:%d>", len([]rune(s)))
}

func redactValue(key string, v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = redactValue(k, x)
		}
		return out
	case []any:
		if len(t) > 3 {
			return []any{redactValue(key, t[0]), fmt.Sprintf("<…%d more>", len(t)-1)}
		}
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = redactValue(key, x)
		}
		return out
	case string:
		return redactString(key, t)
	case float64:
		if safeNums[key] {
			return t
		}
		return "<num>"
	default:
		return t
	}
}

// redact prints JSON from stdin (one document, or JSON lines) with every value that could be personal masked:
// strings become <str:len>, JIDs keep only their server (<user>@c.us), numbers only for known numeric fields.
// Keys and structure stay, which is what payload comparison needs.
func redact(args []string) {
	fs := flag.NewFlagSet("redact", flag.ExitOnError)
	keysOnly := fs.Bool("keys", false, "print only the sorted set of key paths")
	_ = fs.Parse(args)
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 16<<20), 16<<20)
	var all strings.Builder
	for sc.Scan() {
		all.WriteString(sc.Text())
		all.WriteByte('\n')
	}
	dec := json.NewDecoder(strings.NewReader(all.String()))
	paths := map[string]bool{}
	for {
		var v any
		if err := dec.Decode(&v); err != nil {
			if err != io.EOF {
				fmt.Println("<not json>")
			}
			break
		}
		if *keysOnly {
			collect("", v, paths)
			continue
		}
		b, _ := json.MarshalIndent(redactValue("", v), "", "  ")
		fmt.Println(string(b))
	}
	if *keysOnly {
		ks := make([]string, 0, len(paths))
		for k := range paths {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			fmt.Println(k)
		}
	}
}

func collect(prefix string, v any, out map[string]bool) {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			p := prefix + "." + k
			out[p] = true
			collect(p, x, out)
		}
	case []any:
		for _, x := range t {
			collect(prefix+"[]", x, out)
		}
	}
}

// showQR prints a session's QR code in the terminal as it rotates, until the session is WORKING. Run on the box
// (it reads the API key from the environment file), e.g. ssh -t box sudo /opt/wagw/gateway show-qr my-session.
func showQR(args []string) {
	fs := flag.NewFlagSet("show-qr", flag.ExitOnError)
	envFile := fs.String("env", "/etc/wagw/wagw.env", "gateway environment file (for the API key and listen address)")
	base := fs.String("url", "", "gateway base URL (default from WAGW_LISTEN)")
	create := fs.Bool("create", true, "create the session if it does not exist (webhooks to the local test sink)")
	_ = fs.Parse(args)
	if fs.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: gateway show-qr [-create=false] <session>")
		os.Exit(2)
	}
	name := fs.Arg(0)
	env := map[string]string{}
	if b, err := os.ReadFile(*envFile); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if k, v, ok := strings.Cut(strings.TrimSpace(l), "="); ok {
				env[k] = v
			}
		}
	}
	key := env["WAGW_API_KEY"]
	if *base == "" {
		listen := env["WAGW_LISTEN"]
		if listen == "" || strings.HasPrefix(listen, ":") {
			listen = "127.0.0.1" + listen
			if listen == "127.0.0.1" {
				listen = "127.0.0.1:3000"
			}
		}
		*base = "http://" + listen
	}
	do := func(method, path, body string) (int, []byte) {
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		req, _ := http.NewRequest(method, *base+path, rd)
		req.Header.Set("X-Api-Key", key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, []byte(err.Error())
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	status := func() string {
		code, b := do("GET", "/api/sessions/"+name, "")
		if code != 200 {
			return fmt.Sprintf("HTTP %d", code)
		}
		var s struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(b, &s)
		return s.Status
	}
	st := status()
	if st == "HTTP 404" && *create {
		code, b := do("POST", "/api/sessions", `{"name":"`+name+`","start":true,"config":{"webhooks":[{"url":"http://127.0.0.1:3999/hook","events":["*"]}]}}`)
		fmt.Printf("created session %s (HTTP %d)\n", name, code)
		if code >= 300 {
			fmt.Println(string(b))
			os.Exit(1)
		}
	} else if st == "STOPPED" || st == "FAILED" {
		code, _ := do("POST", "/api/sessions/"+name+"/restart", "")
		fmt.Printf("session was %s, restarted (HTTP %d)\n", st, code)
	}
	last := ""
	for {
		st = status()
		switch st {
		case "WORKING":
			fmt.Printf("\nsession %s is WORKING\n", name)
			return
		case "FAILED":
			fmt.Printf("\nsession %s is FAILED (QR expired?). Run again to get a new QR.\n", name)
			os.Exit(1)
		case "SCAN_QR_CODE":
			code, b := do("GET", "/api/"+name+"/auth/qr?format=raw", "")
			if code == 200 {
				var v struct {
					Value string `json:"value"`
				}
				_ = json.Unmarshal(b, &v)
				if v.Value != "" && v.Value != last {
					last = v.Value
					q, err := qrcode.New(v.Value, qrcode.Low)
					if err == nil {
						fmt.Print("\033[2J\033[H")
						fmt.Println(q.ToSmallString(false))
						fmt.Printf("Scan with WhatsApp > Linked devices > Link a device. Session %s, %s UTC. Codes rotate every 20 s.\n", name, time.Now().UTC().Format("15:04:05"))
					}
				}
			}
		default:
			fmt.Printf("\rstatus: %-14s", st)
		}
		time.Sleep(time.Second)
	}
}
