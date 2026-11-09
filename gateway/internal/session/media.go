package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"

	"github.com/dhruvyad/wahooks/gateway/internal/waha"
)

// MediaCache downloads media from WhatsApp on demand into files (never whole in memory) and keeps them for a
// short TTL, so an event's media.url fetched right after the event costs one download.
type MediaCache struct {
	dir string
	ttl time.Duration
	sf  singleflight.Group
	mu  sync.Mutex
}

func NewMediaCache(dir string, ttl time.Duration) (*MediaCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("media dir: %w", err)
	}
	// Leftovers of a previous run are stale.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(dir, e.Name()))
	}
	return &MediaCache{dir: dir, ttl: ttl}, nil
}

func safeName(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		}
		return '_'
	}, s)
}

func (c *MediaCache) path(session, file string) string {
	return filepath.Join(c.dir, safeName(session), safeName(file))
}

// Sweep removes cached files older than the TTL.
func (c *MediaCache) Sweep(now time.Time) {
	_ = filepath.Walk(c.dir, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if now.Sub(info.ModTime()) > c.ttl {
			_ = os.Remove(p)
		}
		return nil
	})
}

func (c *MediaCache) DropSession(session string) {
	_ = os.RemoveAll(filepath.Join(c.dir, safeName(session)))
}

// TempFile returns a new temporary file in the media dir (uploads).
func (c *MediaCache) TempFile() (*os.File, error) {
	return os.CreateTemp(c.dir, "up-*")
}

// ErrNoMedia means the message has nothing downloadable.
var ErrNoMedia = errors.New("message has no media")

// MediaFile returns a local file holding the media of message id (filename is "<id>.<ext>"), downloading it
// from WhatsApp if needed. The caller must not delete it; Sweep does.
func (s *Session) MediaFile(ctx context.Context, filename string) (path, mimetype string, err error) {
	id := filename
	if i := strings.IndexByte(id, '.'); i > 0 {
		id = id[:i]
	}
	row, err := s.m.DB.GetMessage(ctx, s.Name, nil, id)
	if err != nil {
		return "", "", ErrNoMedia
	}
	var msg waE2E.Message
	if err := proto.Unmarshal(row.Msg, &msg); err != nil {
		return "", "", ErrNoMedia
	}
	dl, mime := waha.Downloadable(&msg)
	if dl == nil {
		return "", "", ErrNoMedia
	}
	c := s.m.Media
	p := c.path(s.Name, filename)
	if st, err := os.Stat(p); err == nil && st.Size() > 0 {
		now := time.Now()
		_ = os.Chtimes(p, now, now)
		return p, mime, nil
	}
	cli, err := s.Client()
	if err != nil {
		return "", "", err
	}
	_, err, _ = c.sf.Do(p, func() (any, error) {
		if _, err := os.Stat(p); err == nil {
			return nil, nil
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			return nil, err
		}
		f, err := os.CreateTemp(filepath.Dir(p), ".dl-*")
		if err != nil {
			return nil, err
		}
		tmp := f.Name()
		dctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		err = cli.DownloadToFile(dctx, dl, f)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(tmp)
			if errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) || errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410) {
				return nil, fmt.Errorf("%w: expired on WhatsApp's servers", ErrNoMedia)
			}
			return nil, err
		}
		return nil, os.Rename(tmp, p)
	})
	if err != nil {
		return "", "", err
	}
	return p, mime, nil
}

// fetchToFile downloads url (or decodes base64 data) into a temp file, at most max bytes.
func (s *Session) fetchToFile(ctx context.Context, url string, data []byte, max int64) (*os.File, string, error) {
	f, err := s.m.Media.TempFile()
	if err != nil {
		return nil, "", err
	}
	cleanup := func() { _ = f.Close(); _ = os.Remove(f.Name()) }
	var ctype string
	if data != nil {
		if _, err := f.Write(data); err != nil {
			cleanup()
			return nil, "", err
		}
	} else {
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			cleanup()
			return nil, "", fmt.Errorf("file.url must be http(s)")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			cleanup()
			return nil, "", fmt.Errorf("bad file.url: %w", err)
		}
		resp, err := mediaFetchClient.Do(req)
		if err != nil {
			cleanup()
			return nil, "", fmt.Errorf("fetching file.url failed: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			cleanup()
			return nil, "", fmt.Errorf("fetching file.url returned HTTP %d", resp.StatusCode)
		}
		ctype = resp.Header.Get("Content-Type")
		n, err := io.Copy(f, io.LimitReader(resp.Body, max+1))
		if err != nil {
			cleanup()
			return nil, "", fmt.Errorf("fetching file.url failed: %w", err)
		}
		if n > max {
			cleanup()
			return nil, "", fmt.Errorf("file is larger than %d MB", max>>20)
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return nil, "", err
	}
	return f, ctype, nil
}
