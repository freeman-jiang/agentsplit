#!/usr/bin/env bash
# Runs the Playwright suite against the production build of v2, served by
# `wrangler dev` from the built Worker, with a fresh database and test-only
# secrets. Run it inside the dev shell, with the shared PostgreSQL running:
#   direnv exec .. ./scripts/e2e.sh [playwright args...]
# Env: E2E_PORT (default 5190), SKIP_BUILD=1 to reuse dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

port="${E2E_PORT:-5190}"
db="agentsplit_e2e_v2_${port}"
work="$(mktemp -d)"
server=""
cleanup() {
  status=$?
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  if [ $status -ne 0 ] && [ -f "$work/server.log" ]; then tail -40 "$work/server.log" >&2; fi
  rm -rf "$work"
  dropdb --if-exists --force "$db" > /dev/null 2>&1 || true
  exit $status
}
trap cleanup EXIT

db-reset "$db" > /dev/null
export E2E_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${db}"
DATABASE_URL="$E2E_DATABASE_URL" bun db/migrate.ts > /dev/null

if [ "${SKIP_BUILD:-}" != "1" ]; then bunx vite build > "$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }; fi
# The Vite plugin copies the developer's .dev.vars into the build; the tests use their own values.
rm -f dist/worker/.dev.vars

E2E_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export E2E_SECRET
export E2E_BASE_URL="http://localhost:${port}"
umask 077
printf 'BETTER_AUTH_SECRET=%s\nGOOGLE_CLIENT_ID=e2e-client\nGOOGLE_CLIENT_SECRET=e2e-secret\n' "$E2E_SECRET" > "$work/.env.e2e"
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://postgres:local-trust-auth@127.0.0.1:${PGPORT}/${db}" \
  bunx wrangler dev -c dist/worker/wrangler.json --port "$port" --env-file "$work/.env.e2e" --var "BASE_URL:${E2E_BASE_URL}" > "$work/server.log" 2>&1 &
server=$!
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health" 2>/dev/null && break
  kill -0 "$server" 2>/dev/null || { echo "e2e: the server exited" >&2; exit 1; }
  sleep 1
done
curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health"

bunx playwright test "$@"
