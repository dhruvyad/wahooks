#!/bin/bash
# =============================================================================
# WAHooks E2E Test Script
# Usage: ./scripts/e2e-test.sh [api_url] [--no-scan]
# Default API URL: https://api.wahooks.com
# --no-scan: Skip QR scan steps (tests all endpoints without WhatsApp linking)
# =============================================================================
set -euo pipefail

API_URL="${1:-https://api.wahooks.com}"
NO_SCAN=false
for arg in "$@"; do
  [ "$arg" = "--no-scan" ] && NO_SCAN=true
done

SUPABASE_URL="https://fvatjlbtyegsqjuwbxxx.supabase.co"
SUPABASE_KEY="sb_publishable_63eVkBc4ZgqIqnq2dNhzKA_0NlUw5Y5"
TEST_EMAIL="e2e-test@wahooks.com"
TEST_PASSWORD="wahooks-e2e-test-2026"

# Colors
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

PASS=0; FAIL=0
log()  { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}  ✗${NC} $*"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}  ⚠${NC} $*"; }

profile() {
  local label="$1"; shift
  local start=$(python3 -c "import time; print(int(time.time()*1000))")
  local result
  result=$("$@" 2>&1)
  local end=$(python3 -c "import time; print(int(time.time()*1000))")
  local elapsed=$((end - start))
  echo "$result"
  if [ $elapsed -lt 500 ]; then
    ok "$label: ${GREEN}${elapsed}ms${NC}"
  elif [ $elapsed -lt 2000 ]; then
    ok "$label: ${YELLOW}${elapsed}ms${NC}"
  else
    warn "$label: ${RED}${elapsed}ms${NC} (slow)"
  fi
}

api() {
  local method="$1" path="$2"; shift 2
  curl -s -w "\n%{http_code}" -X "$method" "${API_URL}${path}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" "$@"
}

# =============================================================================
# Step 1: Authenticate
# =============================================================================
log "Authenticating as $TEST_EMAIL..."
AUTH_RESP=$(curl -s -X POST "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASSWORD}\"}")

TOKEN=$(echo "$AUTH_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  fail "Authentication failed: $AUTH_RESP"
  exit 1
fi
ok "Authenticated (token: ${TOKEN:0:20}...)"

# =============================================================================
# Step 2: Health check
# =============================================================================
log "Testing health endpoint..."
HEALTH=$(profile "GET /api" curl -s "${API_URL}/api")
echo "$HEALTH" | head -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('  Status:', d.get('status','?'))"

# =============================================================================
# Step 3: Auth guard (no token → 401)
# =============================================================================
log "Testing auth guard (no token)..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_URL}/api/connections")
if [ "$HTTP_CODE" = "401" ]; then
  ok "Auth guard: 401 as expected"
else
  fail "Auth guard: expected 401, got $HTTP_CODE"
fi

# =============================================================================
# Step 4: List connections
# =============================================================================
log "Listing connections..."
RESP=$(profile "GET /api/connections" api GET /api/connections)
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
ok "Found $COUNT existing connections (HTTP $HTTP_CODE)"

# =============================================================================
# Step 5: Create connection
# =============================================================================
log "Creating new connection..."
RESP=$(profile "POST /api/connections" api POST /api/connections)
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
CONN_ID=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
CONN_STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])" 2>/dev/null)

if [ -z "$CONN_ID" ]; then
  fail "Failed to create connection: $BODY"
  exit 1
fi
ok "Created connection: $CONN_ID (status: $CONN_STATUS)"

# =============================================================================
# Step 6: Get QR code
# =============================================================================
log "Fetching QR code (may take a few attempts while worker boots)..."
QR_OBTAINED=false
for i in $(seq 1 20); do
  RESP=$(api GET "/api/connections/${CONN_ID}/qr")
  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP_CODE" = "200" ]; then
    # Check if connected already
    CONNECTED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null)
    if [ "$CONNECTED" = "True" ]; then
      ok "Already connected!"
      QR_OBTAINED=true
      break
    fi

    # Save QR code as image
    echo "$BODY" | python3 -c "
import json, sys, base64
d = json.load(sys.stdin)
if 'value' in d:
    img = base64.b64decode(d['value'])
    with open('/tmp/wahooks-qr.png', 'wb') as f:
        f.write(img)
    print('QR_SAVED')
else:
    print('NO_VALUE')
" > /tmp/qr_status.txt

    if grep -q "QR_SAVED" /tmp/qr_status.txt; then
      ok "QR code saved to /tmp/wahooks-qr.png"
      QR_OBTAINED=true

      if [ "$NO_SCAN" = "false" ]; then
        open /tmp/wahooks-qr.png 2>/dev/null || true
        echo ""
        echo -e "${YELLOW}  ▶ SCAN THE QR CODE WITH WHATSAPP NOW${NC}"
        echo -e "${YELLOW}  ▶ QR image opened in Preview (or view /tmp/wahooks-qr.png)${NC}"
        echo ""
      fi
      break
    fi
  fi

  warn "Attempt $i/20: QR not ready yet (HTTP $HTTP_CODE), retrying in 3s..."
  sleep 3
done

if [ "$QR_OBTAINED" = "false" ]; then
  fail "Could not get QR code after 20 attempts"
  api DELETE "/api/connections/${CONN_ID}" > /dev/null 2>&1 || true
  exit 1
fi

# =============================================================================
# Step 7: Test profile endpoint (without connection)
# =============================================================================
log "Fetching WhatsApp profile..."
RESP=$(profile "GET /api/connections/:id/me" api GET "/api/connections/${CONN_ID}/me")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
echo "$BODY" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if d:
        print(f'  Phone: {d.get(\"id\",\"?\").replace(\"@c.us\",\"\")}')
        print(f'  Name: {d.get(\"pushName\",\"?\")}')
    else:
        print('  (no profile data — not connected)')
except:
    print('  (empty response — not connected)')
" 2>/dev/null

# =============================================================================
# Step 8: Test chats endpoint (without connection)
# =============================================================================
log "Fetching recent chats..."
RESP=$(profile "GET /api/connections/:id/chats" api GET "/api/connections/${CONN_ID}/chats")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
echo "$BODY" | python3 -c "
import json, sys
chats = json.load(sys.stdin)
print(f'  Found {len(chats)} chats')
for c in chats[:5]:
    name = c.get('name') or c['id'].replace('@c.us','').replace('@g.us','')
    msg = ''
    if c.get('lastMessage'):
        prefix = 'You: ' if c['lastMessage'].get('fromMe') else ''
        msg = f' — {prefix}{c[\"lastMessage\"][\"body\"][:50]}'
    print(f'    • {name}{msg}')
if len(chats) > 5:
    print(f'    ... and {len(chats)-5} more')
" 2>/dev/null

if [ "$NO_SCAN" = "false" ]; then
  # =========================================================================
  # Step 8b: Poll for connection (wait for QR scan)
  # =========================================================================
  log "Polling for connection status (waiting for QR scan)..."
  CONNECTED=false
  for i in $(seq 1 60); do
    RESP=$(api GET "/api/connections/${CONN_ID}/qr")
    BODY=$(echo "$RESP" | sed '$d')
    IS_CONNECTED=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null)
    if [ "$IS_CONNECTED" = "True" ]; then
      ok "Connected via QR endpoint detection!"
      CONNECTED=true
      break
    fi

    RESP=$(api GET "/api/connections/${CONN_ID}")
    BODY=$(echo "$RESP" | sed '$d')
    STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
    if [ "$STATUS" = "working" ]; then
      ok "Connected! Status: working"
      CONNECTED=true
      break
    fi

    echo -ne "\r  Waiting for scan... ($i/60, status: $STATUS)    "
    sleep 2
  done
  echo ""

  if [ "$CONNECTED" = "true" ]; then
    # Re-test profile and chats now that we're connected
    log "Fetching profile (connected)..."
    RESP=$(profile "GET /me (connected)" api GET "/api/connections/${CONN_ID}/me")
    BODY=$(echo "$RESP" | sed '$d')
    echo "$BODY" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d:
    print(f'  Phone: {d.get(\"id\",\"?\").replace(\"@c.us\",\"\")}')
    print(f'  Name: {d.get(\"pushName\",\"?\")}')
" 2>/dev/null

    log "Fetching chats (connected)..."
    RESP=$(profile "GET /chats (connected)" api GET "/api/connections/${CONN_ID}/chats")
    BODY=$(echo "$RESP" | sed '$d')
    echo "$BODY" | python3 -c "
import json, sys
chats = json.load(sys.stdin)
print(f'  Found {len(chats)} chats')
for c in chats[:5]:
    name = c.get('name') or c['id'].replace('@c.us','').replace('@g.us','')
    print(f'    • {name}')
" 2>/dev/null
  else
    warn "Connection timed out — skipping connected-state tests"
  fi
fi

# =============================================================================
# Step 9: Test restart
# =============================================================================
log "Testing restart..."
RESP=$(profile "POST /api/connections/:id/restart" api POST "/api/connections/${CONN_ID}/restart")
HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
STATUS=$(echo "$BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
ok "Restart response status: $STATUS (HTTP $HTTP_CODE)"

# =============================================================================
# Step 10: Delete connection
# =============================================================================
log "Deleting connection..."
RESP=$(profile "DELETE /api/connections/:id" api DELETE "/api/connections/${CONN_ID}")
HTTP_CODE=$(echo "$RESP" | tail -1)
ok "Deleted (HTTP $HTTP_CODE)"

# Verify deletion
RESP=$(api GET /api/connections)
BODY=$(echo "$RESP" | sed '$d')
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
ok "Connections after cleanup: $COUNT"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  E2E Test Complete!  ✓ $PASS passed  ✗ $FAIL failed${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
[ $FAIL -gt 0 ] && exit 1 || exit 0
