#!/usr/bin/env bash
# Materialise the patched whatsmeow the gateway is built and tested with, and the -modfile that selects it.
#
#   whatsmeow-patches/apply.sh          -> .build/whatsmeow (pinned module + *.patch), .build/go.mod, .build/go.sum
#   go build -modfile=.build/go.mod ./cmd/gateway      (build.sh and deploy/install.sh do this)
#
# The patches (see the header of each) cut ~70 KB of whatsmeow's ~105 KB live heap per connected account
# (bench/density/RESULTS.md §2, §12). They are applied to the exact version pinned in go.mod; a patch that no longer
# applies stops the build here (patch --forward --batch exits non-zero), so a whatsmeow bump must refresh them.
set -euo pipefail
cd "$(dirname "$0")/.."
here=$PWD
ver=$(awk '$1=="go.mau.fi/whatsmeow"{print $2; exit}' go.mod)
src=$(GOFLAGS=-mod=mod go list -m -f '{{.Dir}}' go.mau.fi/whatsmeow)
[ -n "$src" ] && [ -d "$src" ] || { echo "whatsmeow $ver not in the module cache (run go mod download)" >&2; exit 1; }
stamp="$ver $(cat whatsmeow-patches/*.patch | shasum -a 256 | cut -c1-16)"
if [ -f .build/whatsmeow/.patched ] && [ "$(cat .build/whatsmeow/.patched)" = "$stamp" ] && [ -f .build/go.mod ]; then
  exit 0 # up to date
fi
rm -rf .build/whatsmeow && mkdir -p .build && cp -R "$src" .build/whatsmeow && chmod -R u+w .build/whatsmeow
for p in whatsmeow-patches/*.patch; do
  if ! (cd .build/whatsmeow && patch --forward --batch --silent -p1 < "$here/$p"); then
    echo "FAILED: $p does not apply to whatsmeow $ver; refresh the patch before building" >&2
    rm -rf .build/whatsmeow
    exit 1
  fi
done
find .build/whatsmeow -name '*.orig' -delete
echo "$stamp" > .build/whatsmeow/.patched
cp go.mod .build/go.mod && cp go.sum .build/go.sum
printf '\nreplace go.mau.fi/whatsmeow => ./.build/whatsmeow\n' >> .build/go.mod
echo "patched whatsmeow $ver ($(ls whatsmeow-patches/*.patch | wc -l | tr -d ' ') patches) in .build/whatsmeow"
