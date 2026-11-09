package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// Link previews for sendText, as NOWEB attaches them unless linkPreview is false: the first http(s) URL's title,
// description and a small JPEG of its og:image. Fetches only public addresses (no SSRF into the box's private
// network), with short timeouts and size caps; any failure just sends the text without a preview.

var urlRe = regexp.MustCompile(`https?://[^\s<>"']+`)

type linkPreview struct {
	URL, Title, Description string
	Thumb                   []byte
	ThumbW, ThumbH          int
}

var errPrivate = errors.New("refusing to fetch a non-public address")

var (
	cgnat = netip.MustParsePrefix("100.64.0.0/10")
	nat64 = netip.MustParsePrefix("64:ff9b::/96")
)

func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if nat64.Contains(a) {
		// NAT64 (an IPv6-only box reaching IPv4 sites): judge the embedded IPv4 address.
		b := a.As16()
		a = netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]})
	}
	return a.IsGlobalUnicast() && !a.IsPrivate() && !a.IsLoopback() && !a.IsLinkLocalUnicast() && !cgnat.Contains(a)
}

// allowAddr decides which resolved addresses previews may connect to (replaced in tests).
var allowAddr = publicAddr

// publicDial connects only to public unicast addresses, checked after DNS resolution (no SSRF into the box's
// private network, metadata service or the gateway itself).
func publicDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: 4 * time.Second}
	var last error = errPrivate
	for _, ip := range ips {
		if !allowAddr(ip) {
			continue
		}
		c, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err == nil {
			return c, nil
		}
		last = err
	}
	return nil, last
}

func checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) >= 4 {
		return errors.New("too many redirects")
	}
	if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
		return errors.New("bad redirect scheme")
	}
	return nil
}

// publicClient fetches link previews.
var publicClient = &http.Client{
	Timeout:       6 * time.Second,
	CheckRedirect: checkRedirect,
	Transport: &http.Transport{
		DialContext:           publicDial,
		TLSHandshakeTimeout:   4 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          8,
		IdleConnTimeout:       30 * time.Second,
	},
}

// mediaFetchClient fetches file.url for sends, with the same public-addresses-only dialer.
var mediaFetchClient = &http.Client{
	Timeout:       2 * time.Minute,
	CheckRedirect: checkRedirect,
	Transport: &http.Transport{
		DialContext:           publicDial,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
	},
}

func fetchLimited(ctx context.Context, u string, max int64, accept string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; WhatsApp link preview)")
	req.Header.Set("Accept", accept)
	resp, err := publicClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max))
	return b, resp.Header.Get("Content-Type"), err
}

// fetchPreview builds a preview for the first URL in text, or nil.
func fetchPreview(ctx context.Context, text string) *linkPreview {
	m := urlRe.FindString(text)
	if m == "" {
		return nil
	}
	m = strings.TrimRight(m, ".,;:!?)]}")
	u, err := url.Parse(m)
	if err != nil || u.Host == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	body, ctype, err := fetchLimited(ctx, u.String(), 512<<10, "text/html,application/xhtml+xml")
	if err != nil || !strings.Contains(strings.ToLower(ctype), "html") {
		return nil
	}
	p := &linkPreview{URL: m}
	var img string
	r, err := charset.NewReader(bytes.NewReader(body), ctype)
	if err != nil {
		r = bytes.NewReader(body)
	}
	z := html.NewTokenizer(r)
	var inTitle bool
	var docTitle string
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		tok := z.Token()
		switch tt {
		case html.StartTagToken, html.SelfClosingTagToken:
			switch tok.Data {
			case "meta":
				var key, content string
				for _, a := range tok.Attr {
					switch strings.ToLower(a.Key) {
					case "property", "name":
						key = strings.ToLower(a.Val)
					case "content":
						content = strings.TrimSpace(a.Val)
					}
				}
				switch key {
				case "og:title", "twitter:title":
					if p.Title == "" {
						p.Title = content
					}
				case "og:description", "twitter:description", "description":
					if p.Description == "" {
						p.Description = content
					}
				case "og:image", "og:image:url", "twitter:image":
					if img == "" {
						img = content
					}
				}
			case "title":
				inTitle = true
			case "body":
				goto done
			}
		case html.TextToken:
			if inTitle && docTitle == "" {
				docTitle = strings.TrimSpace(tok.Data)
			}
		case html.EndTagToken:
			if tok.Data == "title" {
				inTitle = false
			}
		}
	}
done:
	if p.Title == "" {
		p.Title = docTitle
	}
	if p.Title == "" && p.Description == "" {
		return nil
	}
	if len(p.Description) > 300 {
		p.Description = p.Description[:300]
	}
	if img != "" {
		if iu, err := u.Parse(img); err == nil && (iu.Scheme == "http" || iu.Scheme == "https") {
			if b, _, err := fetchLimited(ctx, iu.String(), 3<<20, "image/*"); err == nil {
				p.Thumb, p.ThumbW, p.ThumbH = jpegThumbnail(bytes.NewReader(b), 300)
			}
		}
	}
	return p
}

// jpegThumbnail decodes an image (PNG, JPEG, GIF) and returns a JPEG no larger than max on its long side, or nil.
// Images over 25 megapixels are skipped to bound memory.
func jpegThumbnail(r io.ReadSeeker, max int) ([]byte, int, int) {
	cfg, _, err := image.DecodeConfig(r)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > 25_000_000 {
		return nil, 0, 0
	}
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, 0, 0
	}
	src, _, err := image.Decode(r)
	if err != nil {
		return nil, 0, 0
	}
	w, h := cfg.Width, cfg.Height
	if w > max || h > max {
		if w >= h {
			h = h * max / w
			w = max
		} else {
			w = w * max / h
			h = max
		}
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	b := src.Bounds()
	// Box filter: average the source pixels that fall into each destination pixel.
	for y := 0; y < h; y++ {
		y0 := b.Min.Y + y*b.Dy()/h
		y1 := b.Min.Y + (y+1)*b.Dy()/h
		if y1 <= y0 {
			y1 = y0 + 1
		}
		for x := 0; x < w; x++ {
			x0 := b.Min.X + x*b.Dx()/w
			x1 := b.Min.X + (x+1)*b.Dx()/w
			if x1 <= x0 {
				x1 = x0 + 1
			}
			var rs, gs, bs, n uint64
			stepY := max1((y1 - y0) / 4)
			stepX := max1((x1 - x0) / 4)
			for sy := y0; sy < y1; sy += stepY {
				for sx := x0; sx < x1; sx += stepX {
					cr, cg, cb, _ := src.At(sx, sy).RGBA()
					rs, gs, bs, n = rs+uint64(cr), gs+uint64(cg), bs+uint64(cb), n+1
				}
			}
			dst.SetRGBA(x, y, color.RGBA{uint8(rs / n >> 8), uint8(gs / n >> 8), uint8(bs / n >> 8), 255})
		}
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 70}); err != nil {
		return nil, 0, 0
	}
	return out.Bytes(), w, h
}

func max1(n int) int {
	if n < 1 {
		return 1
	}
	return n
}
