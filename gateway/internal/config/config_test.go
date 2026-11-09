package config

import "testing"

func TestLoadResolveAndPrefix(t *testing.T) {
	t.Setenv("WAGW_API_KEY", "k")
	t.Setenv("WAGW_DB", "postgres://u:p@h/db")
	t.Setenv("WAGW_IPV6_PREFIX", "2001:db8:1:2::1/64")
	t.Setenv("WAGW_WEBHOOK_RESOLVE", "api.wahooks.com:443:[2001:db8::1], other.example:8443:203.0.113.5")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.DBDialect != "postgres" || c.IPv6Prefix.String() != "2001:db8:1:2::/64" {
		t.Fatal(c.DBDialect, c.IPv6Prefix)
	}
	if c.WebhookResolve["api.wahooks.com:443"] != "2001:db8::1" || c.WebhookResolve["other.example:8443"] != "203.0.113.5" {
		t.Fatal(c.WebhookResolve)
	}
	if c.QRMaxCycles != 1 || c.Listen != ":3000" || !c.LinkPreview || c.MarkOnline {
		t.Fatal("defaults changed")
	}
}

func TestLoadRejects(t *testing.T) {
	t.Setenv("WAGW_API_KEY", "")
	if _, err := Load(); err == nil {
		t.Fatal("missing key must fail")
	}
	t.Setenv("WAGW_API_KEY", "k")
	t.Setenv("WAGW_IPV6_PREFIX", "10.0.0.0/8")
	if _, err := Load(); err == nil {
		t.Fatal("IPv4 prefix must fail")
	}
	t.Setenv("WAGW_IPV6_PREFIX", "")
	t.Setenv("WAGW_DB", "mysql://x")
	if _, err := Load(); err == nil {
		t.Fatal("unknown DB must fail")
	}
}
