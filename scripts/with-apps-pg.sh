#!/usr/bin/env bash
# Runs a command against an apps-pg database as its owner role, through
# cloud-sql-proxy with IAM authentication (the caller's identity), as app-db does.
# The command gets DATABASE_URL and DB_ROLE; db/migrate.ts and the seed script
# run SET ROLE on every connection.
#   scripts/with-apps-pg.sh agentsplit_preview bun db/migrate.ts
set -euo pipefail
cd "$(dirname "$0")/.."
db="${1:?usage: with-apps-pg.sh <database> <command...>}"
shift
case "$db" in agentsplit | agentsplit_preview) ;; *) echo "unexpected database $db" >&2; exit 2 ;; esac
instance="${APP_DB_INSTANCE:-freeman-dev-infra:us-west1:apps-pg}"
caller="$(gcloud config get-value account 2>/dev/null)"
iam_user="${caller%.gserviceaccount.com}"
port=$((20000 + RANDOM % 20000))
cloud-sql-proxy --auto-iam-authn --address 127.0.0.1 --port "$port" --quiet "$instance" &
proxy=$!
trap 'kill "$proxy" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do pg_isready -q -h 127.0.0.1 -p "$port" && break; sleep 0.2; done
DATABASE_URL="postgresql://${iam_user/@/%40}@127.0.0.1:${port}/${db}" DB_ROLE="${db}_owner" "$@"
