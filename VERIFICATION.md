# AgentSplit verification

## Complete read-query MCP surface and HTTP hardening

The reviewed catalog now maps all twelve existing tRPC queries, including group
details, balances across group/participant pairs, and all three statistics views.
This change has passed local verification; live deployment remains pending a
renewed Tailscale SSH authentication check. The previously deployed seven-tool
release and its actual-agent results below are separate evidence.

- 536 Jest tests passed in 46 suites across both configured timezones.
- TypeScript, formatting, diff checks, and Oxlint passed (zero errors, the same
  20 inherited warnings).
- Production compilation, static generation, and build tracing passed with
  `bun --env-file=scripts/build.env run build --webpack`, using the non-secret
  build fixture used by the Docker build. The default local Turbopack build was
  blocked by this Mac's sandbox denying its CSS worker port; this does not
  establish that the default Docker/Turbopack build passed for this revision.
- SDK HTTP integration tests discover twelve tools with input/output schemas,
  serve legacy 2025 and modern 2026-07-28 requests, and reject standard-header
  mismatches with JSON-RPC `HeaderMismatch` (`-32020`).
- New tool results validate against wire contracts checked against tRPC types;
  malformed database results produce generic errors without parser diagnostics.
- Statistical totals, date-filtered drilldowns, minor units, user isolation,
  and cross-group denial are exercised. A mixed authorized/unauthorized balance
  request is rejected before any expense query.
- All MCP expense/statistics/balance paths suppress recurrence materialization;
  web recurring-expense behavior remains covered separately.
- The per-process token bucket rejects excess requests with HTTP 429 before
  dispatch, shares a user's budget across keys, isolates other users, and refills.

No dependencies were added or updated. OAuth, account/invitation/key-management
UI, an immutable audit ledger, and writes remain outside this read-only release.
The limiter must use shared storage before deploying multiple app processes.

Checked September 30, 2026. The live deployment was running commit `2a07b92`
on the Oracle server. Verification used only synthetic data in the existing
AgentSplit deployment test group.

## Verified on the live deployment

- Application, PostgreSQL 17.11, and Garage 2.4.1 containers report healthy.
- The public readiness endpoint confirms application/database connectivity.
- A synthetic PNG uploaded through the application to Garage, displayed as a
  thumbnail and full-size image, saved to an expense, and loaded after reopening.
  A direct object read returned exactly the uploaded bytes.
- Editing the test expense from $30 to $60 persisted. Balances recomputed to
  Alice +$40, Bob -$20, and Carol -$20. Statistics reflected the $60 total and
  $20 shares; the activity feed recorded the edits.
- JSON export returns a downloadable response containing the expected expense,
  participants, and activity entries. The CSV endpoint returns a downloadable
  response, but its payer balance calculation had the inherited upstream bug
  documented in `UPSTREAM_FOLLOWUPS.md`.
- Unsigned object upload and anonymous bucket listing returned HTTP 403. Upload
  CORS permits the application origin and does not grant an unrelated origin.
- Runtime environment disables Next.js/Prisma telemetry, analytics, and built-in
  AI features, while enabling receipt attachments. This verifies configuration,
  not an exhaustive network-egress audit.
- PostgreSQL and Garage data/metadata use persistent volumes; Garage's config
  mount is read-only. The PWA manifest and service-worker endpoints respond.
- No browser warnings/errors were captured during the verified flows, and recent
  application container logs contained no errors.

## Verified locally after the CSV correction

- TypeScript, formatting, production build, and diff checks passed.
- Jest: 442 tests passed in 38 suites across the two configured projects.
- Oxlint: zero errors and 20 inherited warnings.
- Four new route-level regressions cover payer credit, an excluded payer,
  minor-unit rounding, and reimbursements. They failed before the correction.

## Remaining boundaries

Backup restore, JPEG/oversized-file checks, and an exhaustive browser E2E suite
have not been completed in this verification run. No remote CI results were
reported for the draft PR. Existing group-link sharing remains
Spliit's account-free bearer-link model; receipt URLs also grant read access.

## MCP deployment and actual-agent verification

The MCP implementation was deployed as commit `d3238b4` through the scoped
AgentSplit Coolify resource. The application, PostgreSQL, and Garage were
recreated and returned healthy with their data intact. The previously uploaded
PNG remained byte-for-byte unchanged. Live CSV output now gives Alice +$40,
Bob -$20, and Carol -$20 for the saved $60 expense.

The live `/api/mcp` endpoint passed initialization, discovery of all seven
read-only tools, permitted group discovery, expense/receipt reads, and balances.
Invalid keys returned HTTP 401. A foreign-group request with a forged `userId`
was denied, and a mutation-tool request was rejected. Server configuration
contains key hashes and separate user-access records; keys inherit user access.

An ephemeral Codex CLI 0.154.0 agent completed eight MCP calls across six tools:
`list_groups`, `get_group`, `list_expenses`, `get_balances`, `get_expense`, and
three paginated `list_activity` calls. It discovered the test group without
supplied IDs, converted 6000 USD minor units to $60, reported two receipt
attachments, and correctly concluded Bob/Carol owe Alice $20 each. It retrieved
all three activity records and recognized that the endpoint has no write tools
and the legacy feed lacks immutable snapshots and verified actors.

The installed CLI rejected the user's configured `gpt-6.1-sol` before running
tools. The successful isolated test used the CLI-advertised `gpt-5.5`; the user's
global model preference was not changed. Other configured MCPs were disabled
only for this ephemeral test. The agent made no shell/tool calls outside
AgentSplit. Database row counts and total expense amount were identical before
and after the deployment, protocol checks, and actual-agent run. No bearer key
appeared in the captured agent events or final response.

The local Codex connection is configured persistently in the private user
configuration. Its credential file is mode 0600 and excluded from Git/build
context; no live keys are in this repository. User/account invitation and
self-service key UI remain a design proposal in `IDENTITY_DESIGN.md`.
