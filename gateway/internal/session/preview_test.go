package session

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestPublicAddr(t *testing.T) {
	for a, want := range map[string]bool{
		"10.1.2.3": false, "192.168.1.2": false, "127.0.0.1": false, "100.68.1.1": false, "169.254.1.1": false,
		"::1": false, "fd00::1": false, "fe80::1": false, "64:ff9b::a00:1": false,
		"2606:4700:4700::1111": true, "8.8.8.8": true, "64:ff9b::808:808": true,
	} {
		if got := publicAddr(netip.MustParseAddr(a)); got != want {
			t.Errorf("%s: %v", a, got)
		}
	}
}

func TestFetchPreview(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 640, 320))
	for x := 0; x < 640; x++ {
		img.Set(x, 10, color.RGBA{255, 0, 0, 255})
	}
	var pngb bytes.Buffer
	_ = png.Encode(&pngb, img)
	mux := http.NewServeMux()
	mux.HandleFunc("/img.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(pngb.Bytes())
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<html><head><title>Fallback</title><meta property="og:title" content="Hello &amp; welcome"><meta name="description" content="A page"><meta property="og:image" content="/img.png"></head><body>x</body></html>`)
	})
	old := allowAddr
	allowAddr = func(netip.Addr) bool { return true }
	defer func() { allowAddr = old }()
	p := fetchPreview(context.Background(), "see "+srv.URL+"/page.")
	if p == nil || p.Title != "Hello & welcome" || p.Description != "A page" || p.URL != srv.URL+"/page" {
		t.Fatalf("%+v", p)
	}
	if len(p.Thumb) == 0 || p.ThumbW != 300 || p.ThumbH != 150 {
		t.Fatalf("thumb %d %dx%d", len(p.Thumb), p.ThumbW, p.ThumbH)
	}
	allowAddr = publicAddr
	publicClient.CloseIdleConnections() // the check runs at dial time; drop the connection the test allowed
	if p := fetchPreview(context.Background(), srv.URL+"/page"); p != nil {
		t.Fatal("loopback must be refused")
	}
	if p := fetchPreview(context.Background(), "no links here"); p != nil {
		t.Fatal("no url")
	}
}
