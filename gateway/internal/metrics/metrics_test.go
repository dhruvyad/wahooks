package metrics

import (
	"runtime"
	"testing"
)

func TestLiveHeap(t *testing.T) {
	keep := make([]byte, 8<<20)
	runtime.GC()
	if v := liveHeap(); v < 8<<20 {
		t.Fatalf("live heap %d, want >= 8 MiB", v)
	}
	runtime.KeepAlive(keep)
}
