# Shared by scripts/e2e.sh and scripts/perf.sh: an isolated app + database built
# from this checkout. Source it from inside the dev shell (`direnv exec .`), which
# provides Postgres and db-start/db-reset.
#
# The app runs as the Next.js standalone server, the same entry point as the
# production image (scripts/container-entrypoint.sh), against a fresh database
# that is dropped again on `stack_down`.
#
#   stack_up <name> <port> <database> [VAR=value ...]
#   stack_down <name> <database>
#   stack_logs <name>
#
# Set SKIP_BUILD=1 to reuse an existing .next build.

STACK_DIR=.stack

stack_db_url() { echo "postgresql://postgres@127.0.0.1:${PGPORT}/$1"; }

stack_build() {
  # The production build needs placeholder values for every variable that is
  # read at build time, as in the Dockerfile. A subshell keeps them out of the
  # app's runtime environment.
  (
    set -a
    # shellcheck source=build.env
    . scripts/build.env
    set +a
    bun run build
  )
  # The standalone server does not copy these itself; the Dockerfile does the same.
  rm -rf .next/standalone/.env .next/standalone/.next/static .next/standalone/public
  cp -r .next/static .next/standalone/.next/static
  cp -r public .next/standalone/public
}

stack_up() {
  local name=$1 port=$2 database=$3
  shift 3
  local url pid
  url=$(stack_db_url "$database")
  mkdir -p "$STACK_DIR"

  db-start
  db-reset "$database"
  POSTGRES_PRISMA_URL="$url" POSTGRES_URL_NON_POOLING="$url" bun run db:migrate

  if [ "${SKIP_BUILD:-}" != "1" ]; then
    stack_build
  fi

  env NODE_ENV=production HOSTNAME=127.0.0.1 PORT="$port" \
    POSTGRES_PRISMA_URL="$url" POSTGRES_URL_NON_POOLING="$url" \
    "$@" node .next/standalone/server.js >"$STACK_DIR/$name.log" 2>&1 &
  pid=$!
  echo "$pid" >"$STACK_DIR/$name.pid"

  # /api/health/readiness runs `SELECT 1`, so a 200 means the app is serving.
  for _ in $(seq 1 120); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "app-stack: $name server exited during startup" >&2
      return 1
    fi
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health/readiness"; then
      return 0
    fi
    sleep 1
  done
  echo "app-stack: $name server not ready after 120s" >&2
  return 1
}

stack_down() {
  local name=$1 database=$2 pidfile="$STACK_DIR/$1.pid"
  if [ -f "$pidfile" ]; then
    kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
  fi
  if pg_isready -q; then
    dropdb --if-exists --force "$database"
  fi
}

stack_logs() { cat "$STACK_DIR/$1.log"; }
