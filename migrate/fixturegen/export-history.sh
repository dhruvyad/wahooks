#!/usr/bin/env bash
# Loads the history fixture (history.mjs) into a throwaway local Postgres with WAHA's exact NOWEB
# DDL, next to the auth fixture, and writes what the runbook produces on the box: a pg_dump
# custom-format archive of the session database (default gzip, and -Z0) and CSVs.
# Needs Docker and pg_dump >= the container's major version. Local only.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$here/../gateway/internal/wahaimport/testdata"
name="waha2meow-history-pg-$$"
port=55498
docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=fixture -p "127.0.0.1:$port:5432" "${PG_IMAGE:-postgres:15}" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 1
db=waha_noweb_fixture
psql() { docker exec -i "$name" psql -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
psql -c "CREATE DATABASE $db"
# WAHA noweb/store/psql/schemas.ts (auth) and noweb/store/schemas.ts Migrations (store tables)
psql -d $db <<'SQL'
CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, data TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS auth_id_index ON auth (id);
CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, "conversationTimestamp" INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS "chats_conversationTimestamp_index" ON chats ("conversationTimestamp");
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS messages (jid TEXT, id TEXT, "messageTimestamp" INTEGER, data TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS messages_id_index ON messages (id);
CREATE INDEX IF NOT EXISTS messages_jid_timestamp_index ON messages (jid, "messageTimestamp");
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS "labelAssociations" (id TEXT PRIMARY KEY, type TEXT, "labelId" TEXT, "chatId" TEXT, "messageId" TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS lid_map (id TEXT PRIMARY KEY, pn TEXT, data TEXT);
SQL
node -e '
const q = s => { if (String(s).includes("$q$")) throw new Error("quote marker"); return `$q$${s}$q$` };
for (const r of require(process.argv[1])) process.stdout.write(`INSERT INTO auth VALUES (${q(r.id)}, ${q(r.data)});\n`);
for (const r of require(process.argv[2])) process.stdout.write(`INSERT INTO messages VALUES (${q(r.jid)}, ${q(r.id)}, ${r.messageTimestamp}, ${q(r.data)});\n`);
for (const r of require(process.argv[3])) process.stdout.write(`INSERT INTO chats VALUES (${q(r.id)}, ${r.conversationTimestamp}, ${q(r.data)});\n`);
' "$here/testdata/baileys/rows.json" "$dir/messages.json" "$dir/chats.json" | psql -d $db
url="postgres://postgres:fixture@127.0.0.1:$port/$db?sslmode=disable"
pg_dump -Fc --no-owner -d "$url" -f "$dir/waha-session.dump"
pg_dump -Fc -Z0 --no-owner -d "$url" -f "$dir/waha-session-z0.dump"
command psql "$url" -X -q -c "\\copy (SELECT jid, id, \"messageTimestamp\", data FROM messages ORDER BY \"messageTimestamp\") TO STDOUT WITH (FORMAT csv, HEADER)" >"$dir/messages.csv"
command psql "$url" -X -q -c "\\copy (SELECT id, \"conversationTimestamp\", data FROM chats ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)" >"$dir/chats.csv"
ls -l "$dir"
