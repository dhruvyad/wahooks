/**
 * cloud-init user-data for a gateway box: the first boot does what
 * gateway/deploy/install.sh does over SSH, with a released binary instead of a
 * local build. The box learns its private address and IPv6 /64 from Hetzner's
 * metadata service, so the API needs neither before it creates the server.
 */

/** gateway/deploy/wagw.service, verbatim (a spec compares it with the file). */
export const WAGW_SERVICE = `# systemd unit for the WAHooks WhatsApp gateway. Installed by deploy/install.sh.
[Unit]
Description=WAHooks WhatsApp gateway (whatsmeow, WAHA-compatible API)
After=network-online.target
Wants=network-online.target

[Service]
# GC: GOGC=50 trims ~10-20 % of RSS under traffic at no measured CPU cost; GOMEMLIMIT is a soft ceiling at ~78 % of
# a CX23's RAM (install.sh writes a box-specific value into wagw.env, which overrides these). See
# bench/density/RESULTS.md §6 and §10. Never set GOMEMLIMIT near the process's steady footprint (GC thrashes).
Environment=GOGC=50
Environment=GOMEMLIMIT=2800MiB
EnvironmentFile=/etc/wagw/wagw.env
# AnyIP: every address of the box's /64 can be a source address (one per account).
ExecStartPre=+/usr/sbin/sysctl -qw net.ipv6.ip_nonlocal_bind=1
ExecStartPre=+/bin/sh -c 'if [ -n "$WAGW_IPV6_PREFIX" ]; then ip -6 route replace local "$WAGW_IPV6_PREFIX" dev lo; fi'
ExecStart=/opt/wagw/gateway
User=wagw
Group=wagw
Restart=always
RestartSec=3
# Shutdown disconnects every account (no logout); give it time.
TimeoutStopSec=40
KillSignal=SIGTERM
LimitNOFILE=1048576
StateDirectory=wagw
StateDirectoryMode=0700
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/wagw

[Install]
WantedBy=multi-user.target
`;

export interface GatewayBoxSpec {
  /** Server name; also WAGW_BOX_ID, the owner of the box's sessions in the shared store. */
  name: string;
  apiKey: string;
  networkId: number;
  binaryUrl: string;
  binarySha256: string;
  dbUrl: string;
  dbMaxConns: number;
  /** WAGW_WEBHOOK_RESOLVE, for a box that can't resolve the API's name itself. */
  webhookResolve?: string;
}

const BOOTSTRAP_DIR = '/root/wagw-bootstrap';

/**
 * Prints the box's address on the API's private network (`private <network id>`)
 * or its routed IPv6 /64 (`ipv6`). PyYAML ships with cloud-init.
 */
const ADDRS_PY = `#!/usr/bin/env python3
"""Addresses for wagw.env, from Hetzner's metadata service."""
import ipaddress, json, subprocess, sys, urllib.request

import yaml

MD = "http://169.254.169.254/hetzner/v1/metadata"


def fetch(path=""):
    with urllib.request.urlopen(MD + path, timeout=5) as r:
        return yaml.safe_load(r.read())


def private_ip(network_id):
    for net in fetch("/private-networks") or []:
        if str(net.get("network_id")) == network_id and net.get("ip"):
            return net["ip"]
    return ""


def slash64(addr):
    return str(ipaddress.ip_network(addr.split("/")[0] + "/64", strict=False))


def ipv6_prefix():
    try:
        for iface in ((fetch() or {}).get("network-config") or {}).get("config") or []:
            for subnet in iface.get("subnets") or []:
                addr = str(subnet.get("address") or "")
                if ":" in addr:
                    return slash64(addr)
    except Exception:
        pass
    # Fallback: the public interface's global address.
    out = subprocess.run(["ip", "-j", "-6", "addr", "show", "scope", "global"], capture_output=True, text=True).stdout
    for link in json.loads(out or "[]"):
        for a in link.get("addr_info") or []:
            if a.get("family") == "inet6" and not a.get("local", "").startswith(("fc", "fd")):
                return slash64(a["local"])
    return ""


if __name__ == "__main__":
    print(private_ip(sys.argv[2]) if sys.argv[1] == "private" else ipv6_prefix())
`;

function setupSh(spec: GatewayBoxSpec): string {
  return `#!/bin/bash
# First boot of a WAHooks gateway box (gateway/deploy/install.sh, done by cloud-init).
set -euo pipefail
NETWORK_ID='${spec.networkId}'
BINARY_URL='${spec.binaryUrl}'
BINARY_SHA256='${spec.binarySha256}'
B=${BOOTSTRAP_DIR}
log() { echo "wagw-bootstrap: $*"; }

id wagw >/dev/null 2>&1 || useradd --system --home /var/lib/wagw --shell /usr/sbin/nologin wagw
install -d -m 0755 /opt/wagw
install -d -m 0700 -o wagw -g wagw /var/lib/wagw
install -d -m 0750 -o root -g wagw /etc/wagw

# The gateway binary, installed only when its SHA-256 matches.
curl -fsSL --retry 10 --retry-delay 3 --retry-all-errors -o /opt/wagw/gateway.download "$BINARY_URL"
if ! echo "$BINARY_SHA256  /opt/wagw/gateway.download" | sha256sum -c --quiet -; then
  log "the binary's SHA-256 doesn't match GATEWAY_BINARY_SHA256; not installing it"
  exit 1
fi
chmod 755 /opt/wagw/gateway.download
mv -f /opt/wagw/gateway.download /opt/wagw/gateway

# The address Hetzner gave this box on the API's network, once it is up on an interface.
ip4=""
for _ in $(seq 1 90); do
  ip4=$(python3 -I "$B/addrs.py" private "$NETWORK_ID" 2>/dev/null || true)
  if [ -n "$ip4" ] && ip -4 -o addr show | grep -qF " $ip4/"; then break; fi
  ip4=""
  sleep 2
done
if [ -z "$ip4" ]; then
  log "no address on network $NETWORK_ID after 3 minutes"
  exit 1
fi
# The box's routed /64: each account dials from its own address in it (AnyIP).
prefix=$(python3 -I "$B/addrs.py" ipv6 2>/dev/null || true)
if [ -z "$prefix" ]; then log "no IPv6 /64 found; accounts will share the box's default address"; fi
mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)

umask 027
{
  cat "$B/wagw.env.static"
  echo "WAGW_LISTEN=$ip4:3000"
  if [ -n "$prefix" ]; then echo "WAGW_IPV6_PREFIX=$prefix"; fi
  # Go soft memory limit at ~78 % of this box's RAM, as install.sh sets it.
  echo "GOMEMLIMIT=$((mem_kb * 78 / 100 / 1024))MiB"
} > /etc/wagw/wagw.env.new
chown root:wagw /etc/wagw/wagw.env.new
chmod 0640 /etc/wagw/wagw.env.new
mv -f /etc/wagw/wagw.env.new /etc/wagw/wagw.env
rm -f "$B/wagw.env.static"

systemctl daemon-reload
systemctl enable -q --now wagw
log "wagw started on $ip4:3000"
`;
}

/** The env lines known before boot; setup.sh adds WAGW_LISTEN, WAGW_IPV6_PREFIX and GOMEMLIMIT. */
export function staticEnvLines(spec: GatewayBoxSpec): string[] {
  return [
    `WAGW_API_KEY=${spec.apiKey}`,
    `WAGW_DB=${spec.dbUrl}`,
    `WAGW_DB_MAX_CONNS=${spec.dbMaxConns}`,
    `WAGW_BOX_ID=${spec.name}`,
    'WAGW_MEDIA_DIR=/var/lib/wagw/media',
    'WAGW_BASE_URL=http://localhost:3000',
    'WAGW_LOG=INFO',
    'WAGW_WA_LOG=WARN',
    ...(spec.webhookResolve ? [`WAGW_WEBHOOK_RESOLVE=${spec.webhookResolve}`] : []),
  ];
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line ? pad + line : ''))
    .join('\n');
}

export function buildGatewayUserData(spec: GatewayBoxSpec): string {
  const file = (path: string, permissions: string, content: string) =>
    `  - path: ${path}\n    permissions: '${permissions}'\n    content: |\n${indent(content, 6)}\n`;
  return (
    '#cloud-config\n' +
    `# WAHooks gateway box ${spec.name}, created by the WAHooks API.\n` +
    'write_files:\n' +
    file('/etc/systemd/system/wagw.service', '0644', WAGW_SERVICE) +
    file(`${BOOTSTRAP_DIR}/wagw.env.static`, '0600', staticEnvLines(spec).join('\n')) +
    file(`${BOOTSTRAP_DIR}/addrs.py`, '0700', ADDRS_PY) +
    file(`${BOOTSTRAP_DIR}/setup.sh`, '0700', setupSh(spec)) +
    'runcmd:\n' +
    `  - [${BOOTSTRAP_DIR}/setup.sh]\n`
  );
}
