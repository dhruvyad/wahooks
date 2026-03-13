#!/bin/bash
# =============================================================================
# WAHooks CLI — interactive client for the WAHooks API
# Usage: ./scripts/wahooks-cli.sh [api_url]
# Default API URL: http://localhost:3001
# =============================================================================
set -euo pipefail

API_URL="${1:-http://localhost:3001}"
TOKEN=""
CONN_ID=""

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

# ── Supabase config ─────────────────────────────────────────────────────────
SUPABASE_URL="https://fvatjlbtyegsqjuwbxxx.supabase.co"
SUPABASE_KEY="sb_publishable_63eVkBc4ZgqIqnq2dNhzKA_0NlUw5Y5"

# ── Helpers ──────────────────────────────────────────────────────────────────
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1" 2>/dev/null; }

api() {
  local method="$1" path="$2"; shift 2
  local args=(-s -w "\n%{http_code}" -X "$method" "${API_URL}${path}")
  [ -n "$TOKEN" ] && args+=(-H "Authorization: Bearer $TOKEN")
  args+=(-H "Content-Type: application/json" "$@")
  curl "${args[@]}"
}

api_call() {
  local method="$1" path="$2"; shift 2
  local start=$(python3 -c "import time; print(int(time.time()*1000))")
  local resp
  resp=$(api "$method" "$path" "$@")
  local end=$(python3 -c "import time; print(int(time.time()*1000))")
  local elapsed=$((end - start))
  local http_code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')

  if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
    echo -e "${DIM}${elapsed}ms${NC} ${GREEN}HTTP ${http_code}${NC}"
  else
    echo -e "${DIM}${elapsed}ms${NC} ${RED}HTTP ${http_code}${NC}"
  fi
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
}

require_auth() {
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Not authenticated. Run 'login' first.${NC}"
    return 1
  fi
}

require_connection() {
  require_auth || return 1
  if [ -z "$CONN_ID" ]; then
    echo -e "${RED}No connection selected. Run 'use <id>' or 'create' first.${NC}"
    return 1
  fi
}

print_help() {
  cat <<'HELP'

  WAHooks CLI Commands
  ════════════════════════════════════════════════════════════

  Auth
    login [email] [password]    Authenticate with Supabase
    whoami                      Show current auth status

  Connections
    ls                          List connections
    create                      Create a new connection
    get [id]                    Get connection details
    use <id>                    Select a connection for subsequent commands
    qr                          Get QR code for selected connection
    me                          Get WhatsApp profile
    chats                       Get recent chats
    restart                     Restart selected connection
    rm [id]                     Delete a connection

  Webhooks
    wh ls                       List webhooks for selected connection
    wh create <url> [events]    Create webhook (events: comma-separated, default: *)
    wh update <id> [--url X] [--events X] [--active true/false]
    wh rm <id>                  Delete a webhook
    wh logs <id>                Get delivery logs for a webhook

  Billing
    billing status              Get billing status
    billing usage               Get usage summary
    billing checkout            Create Stripe checkout session
    billing portal              Create Stripe portal session

  Other
    health                      Health check (no auth required)
    help                        Show this help
    env                         Show current API URL and auth state
    exit / quit / q             Exit

HELP
}

# ── Commands ─────────────────────────────────────────────────────────────────
cmd_login() {
  local email="${1:-}"
  local password="${2:-}"

  if [ -z "$email" ]; then
    echo -n "Email: "; read -r email
  fi
  if [ -z "$password" ]; then
    echo -n "Password: "; read -rs password; echo
  fi

  echo -e "${DIM}Authenticating...${NC}"
  local resp
  resp=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${password}\"}")

  TOKEN=$(echo "$resp" | json "print(d.get('access_token',''))")
  if [ -z "$TOKEN" ]; then
    echo -e "${RED}Login failed${NC}"
    echo "$resp" | json "print(d.get('error_description', d.get('msg', 'Unknown error')))"
    return 1
  fi

  local user_id=$(echo "$resp" | json "print(d['user']['id'])")
  local user_email=$(echo "$resp" | json "print(d['user']['email'])")
  echo -e "${GREEN}Logged in as ${user_email} (${user_id})${NC}"
}

cmd_whoami() {
  if [ -z "$TOKEN" ]; then
    echo "Not authenticated"
  else
    # Decode JWT payload
    echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f\"  User: {d.get('sub', '?')}\")
print(f\"  Email: {d.get('email', '?')}\")
import datetime
exp = datetime.datetime.fromtimestamp(d.get('exp', 0))
print(f\"  Expires: {exp.strftime('%Y-%m-%d %H:%M:%S')}\")
" 2>/dev/null || echo "  Token: ${TOKEN:0:20}..."
  fi
}

cmd_health() {
  api_call GET /api
}

cmd_ls() {
  require_auth || return
  api_call GET /api/connections
}

cmd_create() {
  require_auth || return
  local resp
  resp=$(api POST /api/connections)
  local http_code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')
  local id=$(echo "$body" | json "print(d['id'])")
  local status=$(echo "$body" | json "print(d['status'])")

  if [ -n "$id" ]; then
    CONN_ID="$id"
    echo -e "${GREEN}Created connection ${id} (status: ${status})${NC}"
    echo -e "${DIM}Auto-selected as active connection${NC}"
  else
    echo -e "${RED}Failed to create connection${NC}"
    echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
  fi
}

cmd_use() {
  local id="${1:-}"
  if [ -z "$id" ]; then
    echo -e "${RED}Usage: use <connection_id>${NC}"
    return 1
  fi
  CONN_ID="$id"
  echo -e "${GREEN}Selected connection: ${CONN_ID}${NC}"
}

cmd_get() {
  require_auth || return
  local id="${1:-$CONN_ID}"
  if [ -z "$id" ]; then
    echo -e "${RED}Usage: get <connection_id>${NC}"
    return 1
  fi
  api_call GET "/api/connections/${id}"
}

cmd_qr() {
  require_connection || return
  echo -e "${DIM}Fetching QR code...${NC}"
  local resp
  resp=$(api GET "/api/connections/${CONN_ID}/qr")
  local http_code=$(echo "$resp" | tail -1)
  local body=$(echo "$resp" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo -e "${RED}HTTP ${http_code}${NC}"
    echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
    return
  fi

  # Check if already connected
  local connected=$(echo "$body" | json "print(d.get('connected', False))")
  if [ "$connected" = "True" ]; then
    echo -e "${GREEN}Already connected!${NC}"
    return
  fi

  # Try to save and display QR
  echo "$body" | python3 -c "
import json, sys, base64
d = json.load(sys.stdin)
if 'value' in d:
    img = base64.b64decode(d['value'])
    with open('/tmp/wahooks-qr.png', 'wb') as f:
        f.write(img)
    print('QR saved to /tmp/wahooks-qr.png')
else:
    print(json.dumps(d, indent=2))
" 2>/dev/null

  # Try to open the QR
  open /tmp/wahooks-qr.png 2>/dev/null && echo -e "${YELLOW}Scan the QR code with WhatsApp${NC}" || true
}

cmd_me() {
  require_connection || return
  api_call GET "/api/connections/${CONN_ID}/me"
}

cmd_chats() {
  require_connection || return
  api_call GET "/api/connections/${CONN_ID}/chats"
}

cmd_restart() {
  require_connection || return
  api_call POST "/api/connections/${CONN_ID}/restart"
}

cmd_rm() {
  require_auth || return
  local id="${1:-$CONN_ID}"
  if [ -z "$id" ]; then
    echo -e "${RED}Usage: rm <connection_id>${NC}"
    return 1
  fi
  api_call DELETE "/api/connections/${id}"
  if [ "$id" = "$CONN_ID" ]; then
    CONN_ID=""
  fi
}

cmd_wh() {
  require_auth || return
  local subcmd="${1:-}"; shift 2>/dev/null || true

  case "$subcmd" in
    ls)
      require_connection || return
      api_call GET "/api/connections/${CONN_ID}/webhooks"
      ;;
    create)
      require_connection || return
      local url="${1:-}"
      local events="${2:-*}"
      if [ -z "$url" ]; then
        echo -e "${RED}Usage: wh create <url> [events]${NC}"
        echo -e "${DIM}  events: comma-separated list or * for all (default: *)${NC}"
        return 1
      fi
      # Convert comma-separated events to JSON array
      local events_json=$(echo "$events" | python3 -c "
import sys
events = sys.stdin.read().strip().split(',')
import json
print(json.dumps(events))
")
      api_call POST "/api/connections/${CONN_ID}/webhooks" \
        -d "{\"url\":\"${url}\",\"events\":${events_json}}"
      ;;
    update)
      local wh_id="${1:-}"
      if [ -z "$wh_id" ]; then
        echo -e "${RED}Usage: wh update <webhook_id> [--url X] [--events X] [--active true/false]${NC}"
        return 1
      fi
      shift
      local payload="{"
      local first=true
      while [ $# -gt 0 ]; do
        case "$1" in
          --url)
            [ "$first" = false ] && payload+=","
            payload+="\"url\":\"$2\""; first=false; shift 2 ;;
          --events)
            [ "$first" = false ] && payload+=","
            local ej=$(echo "$2" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip().split(',')))")
            payload+="\"events\":${ej}"; first=false; shift 2 ;;
          --active)
            [ "$first" = false ] && payload+=","
            payload+="\"active\":$2"; first=false; shift 2 ;;
          *) shift ;;
        esac
      done
      payload+="}"
      api_call PUT "/api/webhooks/${wh_id}" -d "$payload"
      ;;
    rm)
      local wh_id="${1:-}"
      if [ -z "$wh_id" ]; then
        echo -e "${RED}Usage: wh rm <webhook_id>${NC}"
        return 1
      fi
      api_call DELETE "/api/webhooks/${wh_id}"
      ;;
    logs)
      local wh_id="${1:-}"
      if [ -z "$wh_id" ]; then
        echo -e "${RED}Usage: wh logs <webhook_id>${NC}"
        return 1
      fi
      api_call GET "/api/webhooks/${wh_id}/logs"
      ;;
    *)
      echo -e "${RED}Unknown webhook command: ${subcmd}${NC}"
      echo "  Available: ls, create, update, rm, logs"
      ;;
  esac
}

cmd_billing() {
  require_auth || return
  local subcmd="${1:-status}"

  case "$subcmd" in
    status)   api_call GET /api/billing/status ;;
    usage)    api_call GET /api/billing/usage ;;
    checkout) api_call POST /api/billing/checkout ;;
    portal)   api_call POST /api/billing/portal ;;
    *)
      echo -e "${RED}Unknown billing command: ${subcmd}${NC}"
      echo "  Available: status, usage, checkout, portal"
      ;;
  esac
}

cmd_env() {
  echo "  API URL:    $API_URL"
  if [ -n "$TOKEN" ]; then
    echo "  Auth:       authenticated"
  else
    echo "  Auth:       not authenticated"
  fi
  if [ -n "$CONN_ID" ]; then
    echo "  Connection: $CONN_ID"
  else
    echo "  Connection: none selected"
  fi
}

# ── REPL ─────────────────────────────────────────────────────────────────────
echo -e "${BOLD}WAHooks CLI${NC} — ${DIM}${API_URL}${NC}"
echo -e "${DIM}Type 'help' for available commands${NC}"
echo ""

while true; do
  # Build prompt
  prompt="${CYAN}wahooks"
  [ -n "$CONN_ID" ] && prompt+="${DIM}:${CONN_ID:0:8}"
  prompt+="${NC}> "

  echo -ne "$prompt"
  read -r line || break
  [ -z "$line" ] && continue

  # Parse command and args
  cmd=$(echo "$line" | awk '{print $1}')
  args=$(echo "$line" | sed 's/^[^ ]* *//')
  [ "$args" = "$cmd" ] && args=""

  case "$cmd" in
    login)    cmd_login $args ;;
    whoami)   cmd_whoami ;;
    health)   cmd_health ;;
    ls)       cmd_ls ;;
    create)   cmd_create ;;
    use)      cmd_use $args ;;
    get)      cmd_get $args ;;
    qr)       cmd_qr ;;
    me)       cmd_me ;;
    chats)    cmd_chats ;;
    restart)  cmd_restart ;;
    rm)       cmd_rm $args ;;
    wh)       cmd_wh $args ;;
    billing)  cmd_billing $args ;;
    env)      cmd_env ;;
    help|"?") print_help ;;
    exit|quit|q) echo "Bye!"; exit 0 ;;
    *)
      echo -e "${RED}Unknown command: ${cmd}${NC}. Type 'help' for commands."
      ;;
  esac
  echo ""
done
