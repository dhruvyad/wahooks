package netx

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"
)

func TestDeriveIPv6(t *testing.T) {
	p := netip.MustParsePrefix("2001:db8:1:2::/64")
	a := DeriveIPv6(p, "wagw", "u_abc_s_def")
	b := DeriveIPv6(p, "wagw", "u_abc_s_def")
	if a != b || !p.Contains(a) {
		t.Fatalf("not stable or outside prefix: %v %v", a, b)
	}
	if c := DeriveIPv6(p, "wagw", "u_abc_s_deg"); c == a {
		t.Fatal("different names must differ")
	}
	raw := a.As16()
	if raw[8] == 0 && raw[9] == 0 && raw[10] == 0 && raw[11] == 0 && raw[12] == 0 && raw[13] == 0 {
		t.Fatal("reserved low range")
	}
	if d := DeriveIPv6(netip.MustParsePrefix("2001:db8::/48"), "wagw", "x"); !netip.MustParsePrefix("2001:db8::/48").Contains(d) {
		t.Fatal("/48 containment")
	}
}

func TestRewriteRT(t *testing.T) {
	var gotPath, gotHost string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotHost = r.URL.Path, r.Host
		w.WriteHeader(204)
	}))
	defer srv.Close()
	target, _ := url.Parse("ws://" + srv.Listener.Addr().String() + "/mock/ws")
	c := &http.Client{Transport: RewriteRT{Base: http.DefaultTransport, Target: target}}
	resp, err := c.Get("https://web.whatsapp.com/ws/chat")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotPath != "/mock/ws" || gotHost != srv.Listener.Addr().String() || resp.StatusCode != 204 {
		t.Fatalf("path %q host %q status %d", gotPath, gotHost, resp.StatusCode)
	}
}

func TestResolveDialer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(201) }))
	defer srv.Close()
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	c := &http.Client{Transport: &http.Transport{DialContext: ResolveDialer(map[string]string{"api.example.invalid:" + port: "127.0.0.1"})}}
	resp, err := c.Get("http://api.example.invalid:" + port + "/api/events/waha")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}
}
