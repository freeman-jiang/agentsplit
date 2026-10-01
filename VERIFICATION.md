# AgentSplit verification

## Preserved expense revisions

One complete snapshot per create/edit revision is stored in Activity. Deletion
keeps the expense and previous revisions while excluding it from current
expenses, balances/statistics, and exports. The authoritative backend validates
inputs and performs the write plus history inside a locked group transaction;
recurring and normal creation share the same backend writer. Database guards
reject expense hard deletion, Activity edits/deletions/truncation, invalid
revision changes, and expense commits without their event.

- 564 Jest tests passed in 48 suites across both configured timezones, plus
  TypeScript, formatting, lint (zero errors, 20 inherited warnings), and the
  production webpack build.
- Eighteen real database integration scenarios passed on an isolated local
  PostgreSQL 18 database, including a pre-migration data upgrade, all split
  modes, simultaneous edits, intentional history-insert failure/rollback,
  legacy baselines, deletion, rename/currency preservation, cascade protection,
  receipt pointer retention, MCP scoping/read-only behavior, and CSV/JSON exports.
  The runner is `bun run test:integration:audit`, guarded to allow only a
  dedicated loopback database whose name ends in `_audit_test`.
- The migration and database guards also passed on an isolated PostgreSQL
  17.11 container using the exact image digest from the Coolify deployment.
  Production data was not used in that test.
- The built application was verified in the local browser against real test
  data. Deleted expenses still display their saved revision; a changed split
  displays both the previous and current allocations. Console warnings/errors
  were empty. A screenshot is saved locally as
  `/private/tmp/agentsplit-audit-history.png`.
- A private pre-migration backup of the scoped AgentSplit database was created
  on the deployment host.

### Live rollout

Commit `97d2a7b` deployed successfully through the scoped Coolify application
`6xpohwok1yiguyk3syzqgumj`. The default Docker/Turbopack build completed, the
audit migration applied on PostgreSQL 17.11, and application/database/Garage
containers returned healthy. The private pre-migration database backup remains
on the deployment host with mode 0600.

`scripts/verify-live-audit.ts` exercised the actual tRPC and authenticated MCP
endpoints. It only operates with explicit write opt-in and an existing group
named `AgentSplit deployment test`. One new synthetic expense was created,
edited (amount and shares), and soft-deleted. Its three revisions are readable
through MCP, previous values and receipt URL references survive deletion, all
eleven tools are advertised, and the original active expenses and balances
compare identical before/after. Only those synthetic verification records were
added; original expense data was not edited. The verification runner also makes
an attempted synthetic expense deletion in its `finally` cleanup path.

The local preview remains running for user review. Local tests used disposable
PostgreSQL 18 databases; the isolated PostgreSQL 17.11 migration-test container
on the deployment host can be removed independently of the live application.

No dependency was added or updated. MCP remains read-only. Actor names in the
account-free web application are explicitly unverified, legacy summaries cannot
recover old values, and database administrators can disable safeguards. See
`AUDIT.md` for the write path, retention policy, and operational boundaries.

## Composable expense history

The catalog now has eleven selected read-only tools. `list_month_expenses` was
removed from MCP; `list_expenses` now combines pagination, title search, and
optional inclusive `from`/`to` expense dates. The web statistics page retains
its existing month query. Tool output contracts now cover the selected registry
instead of requiring a separate contract for every backend query.

- 560 Jest tests passed in 46 suites across both configured timezones.
- Type checking, formatting, diff checks, lint, and the production webpack
  build passed; the same 20 inherited lint warnings remain.
- New regressions cover invalid/reversed dates, leap dates, open-ended and
  inclusive date boundaries, combined title/date filtering before pagination,
  full-history reads, reimbursements, and denial of the removed tool.
- Date predicates use UTC midnight against the database's date-only column;
  an ID tie breaker gives deterministic ordering for tied dates/timestamps.

These changes are locally verified. Deployment is still pending renewed
Tailscale SSH authentication; live and actual-agent evidence below applies to
the previous seven-tool deployment.

## MCP HTTP hardening baseline

Commit `868bfa5` initially mapped twelve existing tRPC queries, including group
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

# Decimal money and per-expense currencies — local working changes

The current local currency/decimal work passes 662 Jest tests across the two
configured time zones, type checking, formatting, and a production Webpack
build. Oxlint reports zero errors and six inherited warnings. No packages were
installed for this change.

The real PostgreSQL runner passes 24 scenarios, including face-value USD/JPY
round trips, separate currency buckets, filtering before pagination, exact
CAD 0.1 + 0.2 totals, currency-specific settlement, audited denomination edits,
unchanged old expenses after group-default changes, and invalid writes leaving
expense/activity counts unchanged. The database is disposable and loopback-only.

A single browser check of the rebuilt expense form showed amount `6000` with
USD selected and two $3,000 shares. There were no captured console errors or
framework error overlays. The original edit tab was left untouched because
automatic approval review rejected reloading it as a risk to unsaved input;
verification used a separate temporary tab. Screenshot:
`/private/tmp/agentsplit-decimal-preview.png`.

These are local pre-deployment results. The approved precision policy rejects
finer amounts instead of rounding inputs. The payer receives the first rounding
remainder; explicit splits remain unchanged. CI is configured to run these PostgreSQL
integration checks against the exact pinned PostgreSQL 17 image used in
production. See `MONEY.md` for the contract and authorized beta-ledger reset scope.

The reset was also applied to an isolated, network-disabled PostgreSQL 17.11
container restored from the scoped deployment backup. It preserved the one
group and three participants, cleared the two expense/six activity rows, created
`NUMERIC(30,12)` money fields, and restored both truncate guards. The temporary
container was removed. The production backup is
`/home/ubuntu/agentsplit-backups/20260930-pre-decimal-money.dump` (mode 0600).

## Live currency deployment

Coolify deployment `uytrv8qq5iqcur8smufda0yt` finished at application commit
`15e503e7b534ce76b6ee87b8f1add1b6e0566b85`. The application, PostgreSQL and
Garage containers are healthy. The scoped beta ledger reset preserved the group
and participants as intended.

The live MCP verifier passed with all eleven tools. Synthetic create/edit/delete
operations retained three ordered audit revisions; USD and JPY amounts round
tripped as face-value strings; currency buckets and pre-pagination filtering
worked; the payer received the first rounding remainder; and a fractional JPY
write was rejected. The verifier soft-deleted its synthetic records and confirmed
that the original active expense list and balances were unchanged. Receipt
reference copying was not tested live in this run because the reset group had no
active receipts; the real-PostgreSQL suite covers pointer retention.

The original OAuth push was rejected for lacking workflow-file scope. The
authorized existing GitHub SSH identity successfully pushed the same commit;
no OAuth scopes or global Git settings were changed. The live image and API
behavior both confirm the application commit, rather than relying on deployment
metadata alone.

The deployed web form also showed Bob receiving $3.34 while Alice and Carol
each received $3.33 from a $10 split. No browser console errors were captured.
That synthetic preview was not submitted. Screenshot:
`/private/tmp/agentsplit-live-payer-rounding.png`.

GitHub Actions reports zero workflow runs so far, despite repository Actions
being enabled and the CI workflow including a direct work-branch push trigger.
The CI definition is committed, but no remote CI pass is claimed. Local checks,
the portable Node integration entry point, and live application verification
have all passed.

# Complete MCP API — release verification

The deployed release exposes 17 resource-oriented tools with input/output schemas,
read/write/destructive/idempotency annotations and explicit actor attribution.
Agent-facing writes use `group`, `expense` and `changes` objects. Browser-only
fields and claimed actor labels are excluded from the MCP input surface.

Local verification passes 678 Jest tests in two time zones, TypeScript and
formatting; lint has zero errors and the six inherited UI warnings. The real
PostgreSQL suites pass 24 audit/currency scenarios plus 11 full-MCP scenarios
through the SDK HTTP handler. They cover persistent membership and multi-key
inheritance, share-link joins, leave/revocation, foreign-group/participant denial,
canonical writes, partial edits, stale/missing revisions, no-op edits, payments,
filtered pagination, export, actor attribution, deletion history and scoped
recurrence processing without duplicate frames.

The real Garage service also passed signed PUT with size binding, ownership
metadata, conditional reads, image validation and permanent-object storage.
Only temporary synthetic images were used and were removed after the check.
The end-to-end live expense/attachment verifier is `scripts/verify-live-mcp.ts`.
Client connection examples and operational recovery guidance are in `MCP.md`.

## Production deployment and real clients — 2026-10-01

Commit `0ee30f87bb4e531057d49f1abf840e509cb88ff4` deployed successfully through
Coolify deployment `uxtdv2v4a4h32r87mfyqnzrj`. The application image matches that
commit, and the app, PostgreSQL and Garage containers report healthy. A scoped
PostgreSQL backup was taken before the additive membership/revision migration.

The live server reports version `0.2.0` and 17 tools. The HTTP verifier passed
discovery and output schemas; expense creation; a real signed Garage PUT;
attachment finalization and exact image-byte retrieval; optimistic revision
conflicts; verified actor attribution; payer-first rounding; USD-to-JPY currency
selection without conversion; JSON export; soft deletion; and retained receipt
access through immutable audit history. Active expenses and balances exactly
matched their pre-test baseline afterward.

Two real installed clients independently used the production MCP:

- **Codex:** discovered the group and participants, created one USD `"10"`
  expense, read it, updated notes with the expected revision, deleted it, and
  verified the three audit revisions. All tool calls succeeded.
- **Claude Code:** completed the same workflow, including reading back its edit
  and checking that a caller-selected ID was unused before creation. Two optional
  reads (`list_expenses` and `get_spending_stats`) were denied by the smoke test's
  client-side allowlist; they were not server failures. Its reported $3.34 payer
  share was inferred from the documented rule; the independent live verifier
  checked the actual accounting result.

An independent read-back confirmed both clients' create/update/delete audit
trails and verified actor IDs, with no test expense left in the active ledger.
The probes used the existing owner connection key through private, temporary
client configuration; no credentials or persistent client settings were changed.
Synthetic deleted revisions and the verifier's tiny receipt remain intentionally
available in history. Unauthenticated requests return 401 and foreign-Origin
requests return 403. Every discovered tool has input/output schemas, descriptions
and read/write annotations.

Compatibility is verified for MCP Streamable HTTP with bearer authentication.
OAuth-only clients are outside this release. GitHub Actions still reports zero
runs; all automated-check claims above are local results, not a remote CI pass.
