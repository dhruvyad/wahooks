#!/usr/bin/env bash
# Build the gateway and install or upgrade it on a box over SSH.
#
#   gateway/deploy/install.sh <ssh-host> [--prefix 2001:db8:1:2::/64] [--listen 127.0.0.1:3000] [--sink] [--no-start]
#
# - Builds linux/amd64 (or GOARCH=arm64 for CAX boxes), static, no cgo.
# - Creates the wagw user, /opt/wagw, /var/lib/wagw, /etc/wagw.
# - Writes /etc/wagw/wagw.env only if it does not exist. The API key is generated on the box and never printed.
# - Installs and (re)starts wagw.service; --sink also installs the test webhook receiver on 127.0.0.1:3999.
set -euo pipefail
cd "$(dirname "$0")/.."
host=${1:?usage: install.sh <ssh-host> [--prefix P] [--listen A] [--sink]}
shift
prefix="" listen="127.0.0.1:3000" sink=0 start=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix=$2; shift 2 ;;
    --listen) listen=$2; shift 2 ;;
    --sink) sink=1; shift ;;
    --no-start) start=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
arch=${GOARCH:-amd64}
echo "building linux/$arch"
# build.sh applies whatsmeow-patches/ to the pinned whatsmeow (and stops if a patch no longer applies).
CGO_ENABLED=0 GOOS=linux GOARCH=$arch ./build.sh build -trimpath -ldflags "-s -w" -o bin/gateway-linux-$arch
scp -q bin/gateway-linux-$arch "$host":/tmp/wagw-gateway.new
scp -q deploy/wagw.service deploy/wagw-sink.service "$host":/tmp/
ssh "$host" "PREFIX='$prefix' LISTEN='$listen' SINK=$sink START=$start bash -s" <<'REMOTE'
set -euo pipefail
id wagw >/dev/null 2>&1 || useradd --system --home /var/lib/wagw --shell /usr/sbin/nologin wagw
install -d -m 0755 /opt/wagw
install -d -m 0700 -o wagw -g wagw /var/lib/wagw
install -d -m 0750 -o root -g wagw /etc/wagw
if [ ! -f /etc/wagw/wagw.env ]; then
  umask 027
  key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  {
    echo "WAGW_API_KEY=$key"
    echo "WAGW_LISTEN=$LISTEN"
    echo "WAGW_DB=sqlite:///var/lib/wagw/wagw.db"
    echo "WAGW_MEDIA_DIR=/var/lib/wagw/media"
    echo "WAGW_BASE_URL=http://localhost:3000"
    echo "WAGW_BOX_ID=$(hostname)"
    [ -n "$PREFIX" ] && echo "WAGW_IPV6_PREFIX=$PREFIX"
    echo "WAGW_LOG=INFO"
    echo "WAGW_WA_LOG=WARN"
  } > /etc/wagw/wagw.env
  chgrp wagw /etc/wagw/wagw.env
  echo "wrote /etc/wagw/wagw.env (API key generated on the box)"
fi
# Go soft memory limit at ~78 % of this box's RAM (kept if already set; the unit's default is 2800MiB for a CX23).
if ! grep -q '^GOMEMLIMIT=' /etc/wagw/wagw.env; then
  mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  echo "GOMEMLIMIT=$((mem_kb * 78 / 100 / 1024))MiB" >> /etc/wagw/wagw.env
  echo "set GOMEMLIMIT=$((mem_kb * 78 / 100 / 1024))MiB in /etc/wagw/wagw.env"
fi
mv /tmp/wagw-gateway.new /opt/wagw/gateway && chmod 755 /opt/wagw/gateway
mv /tmp/wagw.service /etc/systemd/system/wagw.service
if [ "$SINK" = 1 ]; then mv /tmp/wagw-sink.service /etc/systemd/system/wagw-sink.service; else rm -f /tmp/wagw-sink.service; fi
systemctl daemon-reload
if [ "$SINK" = 1 ]; then systemctl enable -q --now wagw-sink; systemctl restart wagw-sink; fi
systemctl enable -q wagw
if [ "$START" = 1 ]; then
  systemctl restart wagw
  sleep 2
  systemctl is-active wagw
else
  echo "installed; not started (--no-start)"
fi
REMOTE
