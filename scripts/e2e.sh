#!/usr/bin/env bash
# Runs the Playwright suite against the production build of v2, with a fresh
# database, a throwaway Garage for receipts, and test-only secrets. Run it
# inside the dev shell, with the shared PostgreSQL running:
#   direnv exec . ./scripts/e2e.sh [--compose] [playwright args...]
# Default: the built server (bun dist/server/server.js) on the shared
# PostgreSQL, with Garage from compose.coolify.yaml.
# --compose: the image and the whole stack of compose.coolify.yaml (app,
# db2 on PostgreSQL 18, Garage), as Coolify runs it, with scripts/compose.e2e.yaml.
# Env: E2E_PORT (default 5190; the database and Garage take the next two
# ports), SKIP_BUILD=1 to reuse dist/ or the image.
set -euo pipefail
cd "$(dirname "$0")/.."

mode=local
if [ "${1:-}" = "--compose" ]; then
  mode=compose
  shift
fi

port="${E2E_PORT:-5190}"
export E2E_PORT="$port" E2E_DB_PORT=$((port + 1)) E2E_S3_PORT=$((port + 2))
project="agentsplit-v2-e2e-${port}"
db="agentsplit_e2e_v2_${port}"
work="$(mktemp -d)"
server=""
# The dev shell has docker-compose; CI runners have the docker compose plugin.
if command -v docker-compose >/dev/null; then compose_cmd=(docker-compose); else compose_cmd=(docker compose); fi
compose() { "${compose_cmd[@]}" -p "$project" --project-directory . -f compose.coolify.yaml -f scripts/compose.e2e.yaml "$@"; }
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
cleanup() {
  status=$?
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  if [ $status -ne 0 ]; then
    if [ -f "$work/server.log" ]; then tail -40 "$work/server.log" >&2; fi
    compose logs --tail 40 app garage >&2 2>/dev/null || true
  fi
  compose down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$work"
  [ "$mode" = local ] && { dropdb --if-exists --force "$db" > /dev/null 2>&1 || true; }
  exit $status
}
trap cleanup EXIT

# Test-only secrets, new for each run. Garage wants a GK-prefixed key ID.
E2E_SECRET="$(hex 32)"
export E2E_SECRET
export BASE_URL="http://localhost:${port}" E2E_BASE_URL="http://localhost:${port}"
export BETTER_AUTH_SECRET="$E2E_SECRET" GOOGLE_CLIENT_ID=e2e-client GOOGLE_CLIENT_SECRET=e2e-secret
export DB2_PASSWORD="$(hex 16)" POSTGRES_PASSWORD=unused GARAGE_RPC_SECRET="$(hex 32)"
export S3_UPLOAD_KEY="GK$(hex 12)" S3_UPLOAD_SECRET="$(hex 32)"

if [ "$mode" = compose ]; then
  if [ "${SKIP_BUILD:-}" != "1" ]; then compose build app > "$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }; fi
  # The app applies the migrations itself at start (MIGRATIONS_DIR in the image).
  compose up -d --wait app > "$work/up.log" 2>&1 || { cat "$work/up.log" >&2; exit 1; }
  export E2E_DATABASE_URL="postgresql://postgres:${DB2_PASSWORD}@127.0.0.1:${E2E_DB_PORT}/agentsplit_e2e"
else
  db-reset "$db" > /dev/null
  export E2E_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${db}"
  DATABASE_URL="$E2E_DATABASE_URL" bun db/migrate.ts > /dev/null
  if [ "${SKIP_BUILD:-}" != "1" ]; then bun run build > "$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }; fi
  compose up -d --wait garage > "$work/up.log" 2>&1 || { cat "$work/up.log" >&2; exit 1; }
  DATABASE_URL="$E2E_DATABASE_URL" PORT="$port" HOST=127.0.0.1 \
    S3_UPLOAD_ENDPOINT="http://127.0.0.1:${E2E_S3_PORT}" \
    bun dist/server/server.js > "$work/server.log" 2>&1 &
  server=$!
fi

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health" 2>/dev/null && break
  [ -z "$server" ] || kill -0 "$server" 2>/dev/null || { echo "e2e: the server exited" >&2; exit 1; }
  sleep 1
done
curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health"

bunx playwright test "$@"

# The receipt tests must have stored their images in Garage, not anywhere else.
S3_ENDPOINT="http://127.0.0.1:${E2E_S3_PORT}" bun -e '
  const client = new Bun.S3Client({ endpoint: process.env.S3_ENDPOINT, region: "garage", bucket: "agentsplit-receipts", accessKeyId: process.env.S3_UPLOAD_KEY, secretAccessKey: process.env.S3_UPLOAD_SECRET })
  const { contents = [] } = await client.list({ prefix: "receipts/" })
  console.log(`Garage holds ${contents.length} receipt objects`)
  if (!contents.length) process.exit(1)
'
