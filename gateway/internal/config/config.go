// Package config reads the gateway's settings from the environment (WAGW_*).
package config

import (
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Listen  string // WAGW_LISTEN, default ":3000" (the WAHooks API hard-codes port 3000)
	APIKey  string // WAGW_API_KEY, required unless WAGW_INSECURE_NO_AUTH=1
	NoAuth  bool
	BoxID   string // WAGW_BOX_ID, default hostname; owner of session leases
	BaseURL string // WAGW_BASE_URL, base of media.url in payloads, default http://localhost:3000

	DBDialect string // derived from WAGW_DB: "sqlite" or "postgres"
	DBDSN     string
	DBMaxConn int // WAGW_DB_MAX_CONNS

	IPv6Prefix netip.Prefix // WAGW_IPV6_PREFIX, a /64 routed to the box (AnyIP); unset = default routing
	IPv6Salt   string       // WAGW_IPV6_SALT, mixed into the address hash (default "wagw")

	WSURL       string // WAGW_WS_URL overrides wss://web.whatsapp.com/ws/chat (benchmarks against a mock)
	InsecureTLS bool   // WAGW_WS_INSECURE_TLS=1 skips TLS verification for the overridden URL

	DeviceName string // WAGW_DEVICE_NAME, shown on the phone's linked-devices list

	HistoryDays        uint32 // WAGW_HISTORY_DAYS: history sync requested at link time
	HistorySizeMB      uint32 // WAGW_HISTORY_SIZE_MB
	HistoryPerChat     int    // WAGW_HISTORY_MSGS_PER_CHAT: messages kept per chat from a history sync
	StoreMessages      bool   // WAGW_STORE_MESSAGES (default on): keep message history for chats/messages endpoints
	MessageRetention   time.Duration
	MessagesPerChat    int // WAGW_MESSAGES_PER_CHAT_MAX: newest kept per chat by the janitor (0 = no cap)
	MarkOnline         bool
	LinkPreview        bool          // WAGW_LINK_PREVIEW (default on): previews for URLs in sendText, as NOWEB
	StartConcurrency   int           // WAGW_START_CONCURRENCY: boot reconnects in parallel
	HistoryConcurrency int           // WAGW_HISTORY_CONCURRENCY: history syncs stored at once, box-wide
	StartInterval      time.Duration // WAGW_START_INTERVAL: delay between boot starts
	QRMaxCycles        int           // WAGW_QR_MAX_CYCLES: QR series (~160 s each) before an unscanned session goes FAILED, as NOWEB does after one (0 = forever)
	WebhookWorkers     int
	WebhookQueue       int
	WebhookTimeout     time.Duration
	WebhookResolve     map[string]string // WAGW_WEBHOOK_RESOLVE: "host:port:addr,..." like curl --resolve
	MediaDir           string            // WAGW_MEDIA_DIR: temp/cache dir for downloads and uploads
	MediaCacheTTL      time.Duration
	MediaMaxBytes      int64
	ProfilePicTTL      time.Duration
	LeaseTTL           time.Duration
	LIDCacheMax        int    // WAGW_LID_CACHE_MAX: >0 bounds the shared PN↔LID cache (entries per direction); 0 = whatsmeow's unbounded cache
	WhatsmeowLogLevel  string // WAGW_WA_LOG: DEBUG/INFO/WARN/ERROR
	LogLevel           string // WAGW_LOG
	Pprof              bool
}

func env(k, d string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func envBool(k string, d bool) bool {
	if v := os.Getenv(k); v != "" {
		b, err := strconv.ParseBool(v)
		if err == nil {
			return b
		}
	}
	return d
}

func envDur(k string, d time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if x, err := time.ParseDuration(v); err == nil {
			return x
		}
	}
	return d
}

// Load reads the configuration. It never logs secret values.
func Load() (*Config, error) {
	host, _ := os.Hostname()
	c := &Config{
		Listen:             env("WAGW_LISTEN", ":3000"),
		APIKey:             os.Getenv("WAGW_API_KEY"),
		NoAuth:             envBool("WAGW_INSECURE_NO_AUTH", false),
		BoxID:              env("WAGW_BOX_ID", host),
		BaseURL:            strings.TrimRight(env("WAGW_BASE_URL", "http://localhost:3000"), "/"),
		DBMaxConn:          envInt("WAGW_DB_MAX_CONNS", 0),
		IPv6Salt:           env("WAGW_IPV6_SALT", "wagw"),
		WSURL:              os.Getenv("WAGW_WS_URL"),
		InsecureTLS:        envBool("WAGW_WS_INSECURE_TLS", false),
		DeviceName:         env("WAGW_DEVICE_NAME", "WAHooks"),
		HistoryDays:        uint32(envInt("WAGW_HISTORY_DAYS", 7)),
		HistorySizeMB:      uint32(envInt("WAGW_HISTORY_SIZE_MB", 20)),
		HistoryPerChat:     envInt("WAGW_HISTORY_MSGS_PER_CHAT", 50),
		StoreMessages:      envBool("WAGW_STORE_MESSAGES", true),
		MessageRetention:   envDur("WAGW_MESSAGE_RETENTION", 30*24*time.Hour),
		MessagesPerChat:    envInt("WAGW_MESSAGES_PER_CHAT_MAX", 1000),
		MarkOnline:         envBool("WAGW_MARK_ONLINE", false),
		LinkPreview:        envBool("WAGW_LINK_PREVIEW", true),
		StartConcurrency:   envInt("WAGW_START_CONCURRENCY", 64),
		HistoryConcurrency: envInt("WAGW_HISTORY_CONCURRENCY", 2),
		StartInterval:      envDur("WAGW_START_INTERVAL", time.Millisecond),
		QRMaxCycles:        envInt("WAGW_QR_MAX_CYCLES", 1),
		WebhookWorkers:     envInt("WAGW_WEBHOOK_WORKERS", 16),
		WebhookQueue:       envInt("WAGW_WEBHOOK_QUEUE", 20000),
		WebhookTimeout:     envDur("WAGW_WEBHOOK_TIMEOUT", 15*time.Second),
		MediaDir:           env("WAGW_MEDIA_DIR", os.TempDir()+"/wagw-media"),
		MediaCacheTTL:      envDur("WAGW_MEDIA_CACHE_TTL", 10*time.Minute),
		MediaMaxBytes:      int64(envInt("WAGW_MEDIA_MAX_MB", 100)) << 20,
		ProfilePicTTL:      envDur("WAGW_PROFILE_PIC_TTL", 6*time.Hour),
		LeaseTTL:           envDur("WAGW_LEASE_TTL", 3*time.Minute),
		LIDCacheMax:        envInt("WAGW_LID_CACHE_MAX", 0),
		WhatsmeowLogLevel:  strings.ToUpper(env("WAGW_WA_LOG", "WARN")),
		LogLevel:           strings.ToUpper(env("WAGW_LOG", "INFO")),
		Pprof:              envBool("WAGW_PPROF", false),
	}
	if c.APIKey == "" && !c.NoAuth {
		return nil, fmt.Errorf("WAGW_API_KEY is required (or set WAGW_INSECURE_NO_AUTH=1 for local tests)")
	}
	db := env("WAGW_DB", "sqlite:///var/lib/wagw/wagw.db")
	switch {
	case strings.HasPrefix(db, "postgres://"), strings.HasPrefix(db, "postgresql://"):
		c.DBDialect, c.DBDSN = "postgres", db
	case strings.HasPrefix(db, "sqlite://"):
		c.DBDialect, c.DBDSN = "sqlite", strings.TrimPrefix(db, "sqlite://")
	case strings.HasPrefix(db, "file:"):
		c.DBDialect, c.DBDSN = "sqlite", strings.TrimPrefix(db, "file:")
	default:
		return nil, fmt.Errorf("WAGW_DB must start with postgres://, postgresql://, sqlite:// or file:")
	}
	if p := os.Getenv("WAGW_IPV6_PREFIX"); p != "" {
		pfx, err := netip.ParsePrefix(p)
		if err != nil || !pfx.Addr().Is6() || pfx.Bits() > 64 {
			return nil, fmt.Errorf("WAGW_IPV6_PREFIX must be an IPv6 prefix of /64 or shorter, got %q", p)
		}
		c.IPv6Prefix = pfx.Masked()
	}
	if r := os.Getenv("WAGW_WEBHOOK_RESOLVE"); r != "" {
		c.WebhookResolve = map[string]string{}
		for _, ent := range strings.Split(r, ",") {
			ent = strings.TrimSpace(ent)
			// host:port:addr, addr may be [v6]
			i := strings.Index(ent, ":")
			if i < 0 {
				return nil, fmt.Errorf("WAGW_WEBHOOK_RESOLVE entry %q is not host:port:addr", ent)
			}
			j := strings.Index(ent[i+1:], ":")
			if j < 0 {
				return nil, fmt.Errorf("WAGW_WEBHOOK_RESOLVE entry %q is not host:port:addr", ent)
			}
			hostPort := ent[:i+1+j]
			addr := strings.Trim(ent[i+1+j+1:], "[]")
			if _, err := netip.ParseAddr(addr); err != nil {
				return nil, fmt.Errorf("WAGW_WEBHOOK_RESOLVE entry %q: bad address", ent)
			}
			c.WebhookResolve[hostPort] = addr
		}
	}
	return c, nil
}
