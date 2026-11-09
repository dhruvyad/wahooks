#!/usr/bin/env bash
# Loads testdata rows into a throwaway local Postgres with WAHA's exact `auth` DDL and
# exports them the ways the runbook does (psql CSV, pg_dump plain, json_agg), so the
# converter's readers are tested against real psql/pg_dump output.
#
# Local Docker only. Never point this at a real database.
set -euo pipefail
dir="$(cd "$(dirname "$0")/.." && pwd)/testdata/baileys"
name="waha2meow-fixture-pg-$$"
image="${PG_IMAGE:-postgres:15}"

docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=fixture "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
	docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
	sleep 1
done
sleep 1

psql() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres "$@"; }
psql -q -c 'CREATE DATABASE waha_noweb_fixture'
# WAHA src/core/engines/noweb/store/psql/schemas.ts SqlAuthMigrations
psql -q -d waha_noweb_fixture -c 'CREATE TABLE IF NOT EXISTS auth (id TEXT PRIMARY KEY, data TEXT)' \
	-c 'CREATE UNIQUE INDEX IF NOT EXISTS auth_id_index ON auth (id)'
node -e '
const rows = require(process.argv[1]);
for (const r of rows) {
	if (r.data.includes("$q$")) throw new Error("unexpected quote marker");
	process.stdout.write(`INSERT INTO auth (id, data) VALUES ($q$${r.id}$q$, $q$${r.data}$q$);\n`);
}' "$dir/rows.json" | psql -q -d waha_noweb_fixture

# WAHA's message-store tables the converter can also read (noweb/store/schemas.ts).
psql -q -d waha_noweb_fixture -c 'CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, data TEXT)' \
	-c 'CREATE TABLE IF NOT EXISTS lid_map (id TEXT, pn TEXT, data TEXT)'
node -e '
for (const r of require(process.argv[1])) process.stdout.write(`INSERT INTO contacts VALUES ($q$${r.id}$q$, $q$${r.data}$q$);\n`);
for (const r of require(process.argv[2])) process.stdout.write(`INSERT INTO lid_map VALUES ($q$${r.id}$q$, $q$${r.pn}$q$, $q$${r.data}$q$);\n`);
' "$dir/store.contacts.json" "$dir/store.lid_map.json" | psql -q -d waha_noweb_fixture
psql -d waha_noweb_fixture -c "\\copy (SELECT id, data FROM contacts ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)" >"$dir/contacts.csv"
psql -d waha_noweb_fixture -c "\\copy (SELECT id, data FROM lid_map ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)" >"$dir/lid_map.csv"

# The runbook's export commands, verbatim apart from the database name.
psql -d waha_noweb_fixture -c "\\copy (SELECT id, data FROM auth ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)" >"$dir/auth.csv"
psql -d waha_noweb_fixture -At -c "SELECT json_agg(json_build_object('id', id, 'data', data) ORDER BY id) FROM auth" >"$dir/auth.json"
docker exec "$name" pg_dump -U postgres --no-owner --table=auth waha_noweb_fixture >"$dir/auth.pgdump.sql"
echo "exported $(($(wc -l <"$dir/auth.csv") - 1)) rows to $dir"
