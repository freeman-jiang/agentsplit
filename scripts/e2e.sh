#!/usr/bin/env bash
#
# Runs the Playwright suite against an isolated app + postgres stack built from
# this checkout (see scripts/app-stack.sh). CI calls the same subcommands, so
# local and CI runs are identical. Run it inside the dev shell:
# `direnv exec . ./scripts/e2e.sh`.
#
#   ./scripts/e2e.sh                  build, start, test, tear down
#   ./scripts/e2e.sh up               start and leave running
#   ./scripts/e2e.sh test --ui        run tests against an already-running stack
#   ./scripts/e2e.sh logs             dump server logs
#   ./scripts/e2e.sh down             stop and delete the database
#
# Env:
#   E2E_HOST_PORT    app port (default 3000)
#   SKIP_BUILD       set to 1 to reuse the existing .next build
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/app-stack.sh

E2E_DB=spliit_e2e
# Keep the port at 3000: next.config.mjs pins
# experimental.serverActions.allowedOrigins to 'localhost:3000'.
E2E_HOST_PORT="${E2E_HOST_PORT:-3000}"
export E2E_HOST_PORT
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:${E2E_HOST_PORT}}"
# The specs seed accounts and sessions directly in this database.
POSTGRES_PRISMA_URL=$(stack_db_url "$E2E_DB")
export POSTGRES_PRISMA_URL
export POSTGRES_URL_NON_POOLING="$POSTGRES_PRISMA_URL"
export BETTER_AUTH_SECRET="local-e2e-only-012345678901234567890123456789"

up() {
  stack_up e2e "$E2E_HOST_PORT" "$E2E_DB" \
    BASE_URL="$E2E_BASE_URL" \
    GOOGLE_CLIENT_ID=test-client \
    GOOGLE_CLIENT_SECRET=test-secret \
    BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
    BETTER_AUTH_TELEMETRY=0
}

down() { stack_down e2e "$E2E_DB"; }

logs() { stack_logs e2e; }

case "${1:-all}" in
up) up ;;
down) down ;;
logs) logs ;;
test)
  shift
  bunx playwright test "$@"
  ;;
all)
  # Drop an explicit leading "all" so it is not forwarded as a test filter.
  # Spelled as an if, not `[ ... ] && shift`: under `set -e` a false test as the
  # last command in the branch would abort the script.
  if [ $# -gt 0 ]; then shift; fi
  trap 'status=$?; if [ $status -ne 0 ]; then logs || true; fi; down || true; exit $status' EXIT
  up
  bunx playwright test "$@"
  ;;
*)
  echo "usage: $0 [all|up|test|down|logs]" >&2
  exit 2
  ;;
esac
