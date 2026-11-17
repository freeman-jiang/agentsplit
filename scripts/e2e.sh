#!/usr/bin/env bash
# Runs the Playwright suite against the production build of v2, with a fresh
# database, a throwaway Garage for receipts, and test-only secrets. Run it
# inside the dev shell, with the shared PostgreSQL running:
#   direnv exec . ./scripts/e2e.sh [playwright args...]
# The built server (bun dist/server/server.js) runs on the shared PostgreSQL.
# Garage, the S3 store of the tests, runs from the dev shell on loopback ports.
# Receipt downloads redirect to Garage (RECEIPT_DOWNLOADS=redirect), as on the
# NixOS host, where they redirect to R2.
# Env: E2E_PORT (default 5190; Garage takes the next two ports), SKIP_BUILD=1
# to reuse dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

port="${E2E_PORT:-5190}"
s3_port=$((port + 1))
db="agentsplit_e2e_v2_${port}"
work="$(mktemp -d)"
server=""
garage=""
cleanup() {
  status=$?
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  [ -n "$garage" ] && kill "$garage" 2>/dev/null || true
  if [ $status -ne 0 ]; then
    for log in server garage; do
      if [ -f "$work/$log.log" ]; then echo "--- $log.log" >&2; tail -40 "$work/$log.log" >&2; fi
    done
  fi
  wait 2>/dev/null || true
  rm -rf "$work"
  dropdb --if-exists --force "$db" > /dev/null 2>&1 || true
  exit $status
}
trap cleanup EXIT

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Test-only secrets, new for each run. Garage wants a GK-prefixed key ID.
E2E_SECRET="$(hex 32)"
export E2E_SECRET
export BASE_URL="http://localhost:${port}" E2E_BASE_URL="http://localhost:${port}"
export BETTER_AUTH_SECRET="$E2E_SECRET" GOOGLE_CLIENT_ID=e2e-client GOOGLE_CLIENT_SECRET=e2e-secret
export GARAGE_RPC_SECRET="$(hex 32)" S3_UPLOAD_KEY="GK$(hex 12)" S3_UPLOAD_SECRET="$(hex 32)"

# A single-node Garage with its data in the work directory. --default-bucket
# creates the bucket and the key from the GARAGE_DEFAULT_* variables.
cat > "$work/garage.toml" <<EOF
metadata_dir = "$work/garage/meta"
data_dir = "$work/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "127.0.0.1:$((port + 2))"
rpc_public_addr = "127.0.0.1:$((port + 2))"

[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:${s3_port}"
EOF
GARAGE_DEFAULT_ACCESS_KEY="$S3_UPLOAD_KEY" GARAGE_DEFAULT_SECRET_KEY="$S3_UPLOAD_SECRET" GARAGE_DEFAULT_BUCKET=agentsplit-receipts \
  garage -c "$work/garage.toml" server --single-node --default-bucket > "$work/garage.log" 2>&1 &
garage=$!

db-reset "$db" > /dev/null
export E2E_DATABASE_URL="postgresql://postgres@127.0.0.1:${PGPORT}/${db}"
DATABASE_URL="$E2E_DATABASE_URL" bun db/migrate.ts > /dev/null
if [ "${SKIP_BUILD:-}" != "1" ]; then bun run build > "$work/build.log" 2>&1 || { cat "$work/build.log" >&2; exit 1; }; fi

for _ in $(seq 1 30); do
  garage -c "$work/garage.toml" bucket info agentsplit-receipts > /dev/null 2>&1 && break
  kill -0 "$garage" 2>/dev/null || { echo "e2e: Garage exited" >&2; exit 1; }
  sleep 1
done
garage -c "$work/garage.toml" bucket info agentsplit-receipts > /dev/null

DATABASE_URL="$E2E_DATABASE_URL" PORT="$port" HOST=127.0.0.1 \
  S3_UPLOAD_ENDPOINT="http://127.0.0.1:${s3_port}" S3_UPLOAD_BUCKET=agentsplit-receipts S3_UPLOAD_REGION=garage \
  RECEIPT_DOWNLOADS=redirect \
  bun dist/server/server.js > "$work/server.log" 2>&1 &
server=$!

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health" 2>/dev/null && break
  kill -0 "$server" 2>/dev/null || { echo "e2e: the server exited" >&2; exit 1; }
  sleep 1
done
curl -fsS -o /dev/null "${E2E_BASE_URL}/api/health"

bunx playwright test "$@"

# The receipt tests must have stored their images in Garage, not anywhere else.
S3_ENDPOINT="http://127.0.0.1:${s3_port}" bun -e '
  const client = new Bun.S3Client({ endpoint: process.env.S3_ENDPOINT, region: "garage", bucket: "agentsplit-receipts", accessKeyId: process.env.S3_UPLOAD_KEY, secretAccessKey: process.env.S3_UPLOAD_SECRET })
  const { contents = [] } = await client.list({ prefix: "receipts/" })
  console.log(`Garage holds ${contents.length} receipt objects`)
  if (!contents.length) process.exit(1)
'
