#!/usr/bin/env bash
# Build or test the gateway against the patched whatsmeow (whatsmeow-patches/). Use this, not plain `go build`.
#   ./build.sh build [-o out] [go build flags...]     (default output bin/gateway)
#   ./build.sh test [go test flags/packages...]       (default ./...)
#   ./build.sh vet  [packages...]
set -euo pipefail
cd "$(dirname "$0")"
export GOTOOLCHAIN=${GOTOOLCHAIN:-go1.26.10}
whatsmeow-patches/apply.sh
mod="-modfile=$PWD/.build/go.mod"
cmd=${1:-build}; shift || true
case "$cmd" in
  build) [ $# -eq 0 ] && set -- -o bin/gateway; go build "$mod" "$@" ./cmd/gateway ;;
  test)  [ $# -eq 0 ] && set -- ./...; go test "$mod" "$@"; (cd .build/whatsmeow && go test -run 'NodeQueue' . >/dev/null) && echo "ok  patched whatsmeow nodeQueue" ;;
  vet)   [ $# -eq 0 ] && set -- ./...; go vet "$mod" "$@" ;;
  *) echo "usage: build.sh build|test|vet" >&2; exit 2 ;;
esac
