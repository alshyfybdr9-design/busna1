#!/usr/bin/env bash
# Runs the Busna migrations + seed + tests against a throw-away database.
# Usage: PGHOST=/tmp PGPORT=54329 PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB="busna_test_$$"
export PGHOST="${PGHOST:-/tmp}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -d "$DB")

cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Supabase roles are cluster-wide; create them once.
psql -X -q -d postgres -tAc "select 1 from pg_roles where rolname='authenticated'" | grep -q 1 || \
  psql -X -q -d postgres -c "create role anon nologin noinherit; create role authenticated nologin noinherit; create role service_role nologin noinherit bypassrls;"

createdb "$DB"
# Stub minus the role creation (already done above).
grep -v '^create role' tests/00_supabase_stub.sql | "${PSQL[@]}"

for f in migrations/*.sql; do
  echo "• applying $f"
  "${PSQL[@]}" -f "$f"
done
echo "• seeding"
"${PSQL[@]}" -f seed.sql >/dev/null
echo "• running tests"
"${PSQL[@]}" -f tests/10_security_and_trip_flow.sql
