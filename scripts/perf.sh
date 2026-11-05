#!/usr/bin/env bash
#
# Runs the performance suite against an isolated app + postgres stack built from
# this checkout (see scripts/app-stack.sh). CI calls the same subcommands, so
# local and CI runs are identical. Run it inside the dev shell:
# `direnv exec . ./scripts/perf.sh`.
#
#   ./scripts/perf.sh                 build, start, seed, benchmark, tear down
#   ./scripts/perf.sh up              start and leave running
#   ./scripts/perf.sh seed            (re)seed the database of a running stack
#   ./scripts/perf.sh bench           benchmark an already-running, already-seeded stack
#   ./scripts/perf.sh logs            dump server logs
#   ./scripts/perf.sh down            stop and delete the database
#
# Env:
#   PERF_HOST_PORT   app port (default 3100)
#   SKIP_BUILD       set to 1 to reuse the existing .next build
#   PERF_GROUPS, PERF_LARGE_GROUP_EXPENSES, ...  dataset sizing, see perf/config.ts
#   PERF_ITERATIONS, PERF_WARMUP                 sampling, see perf/config.ts
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/app-stack.sh

PERF_DB=spliit_perf
PERF_HOST_PORT="${PERF_HOST_PORT:-3100}"
PERF_DATABASE_URL=$(stack_db_url "$PERF_DB")
export PERF_HOST_PORT PERF_DATABASE_URL

up() { stack_up perf "$PERF_HOST_PORT" "$PERF_DB" PERF_INSTRUMENTATION=1; }

down() { stack_down perf "$PERF_DB"; }

logs() { stack_logs perf; }

seed() { bun perf/seed.ts; }

bench() {
  shift || true
  bun perf/run.ts "$@"
}

case "${1:-all}" in
up) up ;;
down) down ;;
logs) logs ;;
seed) seed ;;
bench) bench "$@" ;;
all)
  # Drop an explicit leading "all" so it is not forwarded as an argument.
  # Spelled as an if, not `[ ... ] && shift`: under `set -e` a false test as the
  # last command in the branch would abort the script.
  if [ $# -gt 0 ]; then shift; fi
  trap 'status=$?; if [ $status -ne 0 ]; then logs || true; fi; down || true; exit $status' EXIT
  up
  seed
  bun perf/run.ts "$@"
  ;;
*)
  echo "usage: $0 [all|up|seed|bench|down|logs]" >&2
  exit 2
  ;;
esac
