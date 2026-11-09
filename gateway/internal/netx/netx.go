// Package netx holds the per-account network identity: a stable IPv6 source address derived from the session
// name inside the box's routed prefix, and the HTTP transports that dial from it.
package netx

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"time"
)

// DeriveIPv6 returns the address for name inside prefix (a /64 or shorter). The interface identifier is the
// first 64 bits of SHA-256(salt "\x00" name), so it is the same on every box with the same prefix and salt, and
// never changes for a name. Identifiers below 0x10000 are reserved for the box itself (::1, ::b1 and the like)
// and skipped by re-hashing.
func DeriveIPv6(prefix netip.Prefix, salt, name string) netip.Addr {
	base := prefix.Masked().Addr().As16()
	h := sha256.Sum256([]byte(salt + "\x00" + name))
	for i := 0; ; i++ {
		iid := binary.BigEndian.Uint64(h[:8])
		if iid >= 0x10000 {
			var out [16]byte
			copy(out[:8], base[:8])
			binary.BigEndian.PutUint64(out[8:], iid)
			// Respect prefixes shorter than /64: keep the prefix bits, take the rest from the hash.
			if bits := prefix.Bits(); bits < 64 {
				hi := binary.BigEndian.Uint64(base[:8])
				mask := ^uint64(0) << (64 - bits)
				binary.BigEndian.PutUint64(out[:8], (hi&mask)|(binary.BigEndian.Uint64(h[8:16])&^mask))
			}
			return netip.AddrFrom16(out)
		}
		h = sha256.Sum256(h[:])
	}
}

// SourceDialer dials TCP from a fixed local address. Implements golang.org/x/net/proxy.ContextDialer.
type SourceDialer struct{ D net.Dialer }

func NewSourceDialer(src netip.Addr) *SourceDialer {
	d := &SourceDialer{D: net.Dialer{Timeout: 20 * time.Second, KeepAlive: 30 * time.Second}}
	if src.IsValid() {
		d.D.LocalAddr = &net.TCPAddr{IP: src.AsSlice()}
	}
	return d
}

func (s *SourceDialer) Dial(network, addr string) (net.Conn, error) {
	return s.DialContext(context.Background(), network, addr)
}

func (s *SourceDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	if s.D.LocalAddr != nil {
		network = "tcp6"
	}
	return s.D.DialContext(ctx, network, addr)
}

// NewTransport is a lean transport for one account: all of its WhatsApp traffic (websocket and media) goes
// through it. Idle pools are kept small because each account talks to few hosts.
func NewTransport(src netip.Addr) *http.Transport {
	t := &http.Transport{
		Proxy:                 nil,
		DialContext:           NewSourceDialer(src).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          4,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	return t
}

// RewriteRT sends every request to a fixed URL's scheme and host (the mock WhatsApp server in benchmarks).
type RewriteRT struct {
	Base   http.RoundTripper
	Target *url.URL
}

func (r RewriteRT) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	switch r.Target.Scheme {
	case "ws":
		req.URL.Scheme = "http"
	case "wss":
		req.URL.Scheme = "https"
	default:
		req.URL.Scheme = r.Target.Scheme
	}
	req.URL.Host = r.Target.Host
	if r.Target.Path != "" {
		req.URL.Path = r.Target.Path
	}
	req.Host = r.Target.Host
	return r.Base.RoundTrip(req)
}

// InsecureTLS returns a client TLS config that skips verification (only for the mock override).
func InsecureTLS() *tls.Config { return &tls.Config{InsecureSkipVerify: true} } //nolint:gosec

// ResolveDialer returns a DialContext that sends host:port listed in overrides to a fixed address (like curl
// --resolve), so an IPv6-only box can reach an API whose name has no AAAA record.
func ResolveDialer(overrides map[string]string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if ip, ok := overrides[addr]; ok {
			_, port, _ := net.SplitHostPort(addr)
			addr = net.JoinHostPort(ip, port)
		}
		return d.DialContext(ctx, network, addr)
	}
}
