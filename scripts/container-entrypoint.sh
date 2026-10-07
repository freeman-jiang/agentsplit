#!/bin/bash

set -euxo pipefail

# Enforce the opt-outs before running migrations or starting the app.
export NEXT_TELEMETRY_DISABLED=1
export CHECKPOINT_DISABLE=1

# Invoke the Prisma CLI by path: the standalone image has no package.json
# scripts and no .bin on PATH, so `npx prisma` would try to fetch it.
node node_modules/prisma/build/index.js migrate deploy

# The standalone build's own server entry point, in place of `next start`.
exec node server.js
