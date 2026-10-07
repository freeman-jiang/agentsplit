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

# AgentSplit branding and Japandi UI — 2026-10-01

The interface now uses warm neutral surfaces, olive accents, square corners and
serif headings, with the selected Diagonal split banknote mark. Branding covers
the application chrome, translated product names, metadata, sharing text, export
filenames, installable-app icons, offline page and social banner. Upstream Spliit
attribution and its license remain intact. Vector source lives in
`public/brand-mark.svg`; `scripts/generate-brand-assets.mjs` renders the icons.

The expense form keeps its existing accounting handlers and exposes all split
modes directly. Amount/currency controls are adjacent, participants show their
calculated shares, and optional notes/receipts/settings use disclosures that
retain values and open for existing content or errors. Error-state verification
found and fixed a missing field-state subscription: invalid amounts now show
their inline errors reliably. The empty multi-currency ledger also has explicit
empty-state text.

Release checks: 678 Jest tests across two time zones; TypeScript; formatting;
Oxlint with zero errors and six inherited warnings; production Webpack build;
and 18 Playwright scenarios against the production build and a separate local
PostgreSQL database. Browser scenarios cover group creation, all four split
modes, payer rounding, validation errors, editing/deletion, payments, collapsed
notes retention, mobile currency selection, failed-create retry, service-worker
registration, offline fallback and exclusion of API responses from caches.

Visual inspection covers 1280px desktop and narrow 320px mobile layouts in both
light and dark modes, including open optional sections and dropdown padding.
Every group page (expenses, balances, information, stats, activity and settings)
loaded without captured JavaScript errors. No schema migration or new dependency
is required for this release.

The UI release at `1efb4791b388fe2d6e047486e6cd862109e79006` deployed through
Coolify deployment `5mxu3ayvk80v2lgbdbggft7d`; application, PostgreSQL and Garage
were healthy. The live browser created a synthetic expense, uploaded a PNG to
Garage, checked invalid-amount feedback, edited the expense while preserving
its notes and receipt, and soft-deleted it. MCP read-back confirmed the audit
history, retained receipt and original active ledger/balances. The browser
captured no JavaScript errors and passed a 320px dark-mode overflow check.

The complete live MCP verifier also passed discovery, schemas, signed upload,
attachment finalization, revision conflicts, actor attribution, rounding,
currency changes, export and cleanup on this deployment. A final visual polish
replaces the legacy rounded receipt-thumbnail class with square corners.

The final polish commit `48d4a3410aa35a69bc56313b50f97b05d092a380` deployed in
`8s6c3pncu6sjsig57jbsazoi`. All three services were healthy. The complete live
browser receipt/create/edit/delete workflow passed again, now also asserting
zero thumbnail border radius. MCP audit read-back and original-ledger/balance
restoration passed, with zero captured browser errors at 320px in dark mode.

# Responsive forms, simpler selectors and agent setup

The reported settings overlap was reproduced on production at 488px: the group
name input shrank to 26px while the page itself did not overflow. An unconditional
two-column span created an implicit second column in a single-column grid.
The information field now spans the declared grid, and children can shrink
within their intended tracks. Regression checks assert field widths, positions
and separation on create/settings pages at 320, 375, 488, 639, 640, 768 and 1280px.

Currency and category use controlled native selects instead of responsive
drawers/popovers. The participant prompt uses the same compact dialog on mobile
and desktop. Expense/activity date headings use theme colors, and search/date
headings/expense rows share an inset. Search has an accessible clear button.
Group currency help now correctly describes a default for new expenses, with a
browser check confirming that changing it preserves existing expense amounts
and currencies.

The landing page has only the groups and agent-setup calls to action. `/agents`
provides this instance's runtime MCP endpoint, copyable Codex/Claude Code configs
and agent instructions, and explicitly explains host-issued keys and the absence
of a self-service key screen. GitHub links were removed from the public landing
page; plain-text upstream credit is retained.

Verification passes 31 production-build browser scenarios, 678 Jest tests,
types, formatting and the production build. Lint has zero errors and two
remaining inherited warnings. Light/dark screenshots of settings, expenses,
agent setup and the landing page were inspected at the reported intermediate
width, with no captured JavaScript errors. The setup test verifies that the
endpoint copy button actually places the instance endpoint on the clipboard.

Deployed commit `4ce1444c0597399aecabdfee8734d84a0b4f9359` through Coolify run
`ssgwruohmvbvrepl2pwc9rjy`; app, database and storage are healthy. Live verification
passed the homepage/setup/clipboard flow, eight create/settings layout checks,
native currency/category selection without a drawer, and a complete synthetic
receipt/create/edit/delete lifecycle. MCP read-back confirmed preserved history
and restored active expenses/balances. No browser JavaScript errors were captured.

The expense-row hover state was subsequently checked with personal balances
visible at 320, 488 and 1280px. Rows now have 12px horizontal padding, with no
icon flush against the hover surface or viewport overflow. A regression checks
the inner insets as well as outer alignment. Workspace navigation now labels
Your groups and Agent setup explicitly on mobile; the brand links to the groups
workspace. Four focused production-build browser checks, types, formatting,
lint and the build passed for this spacing/navigation adjustment.

Commit `475044a7f78cbffeb9075b25841cd27f115d068f` deployed through
`yvwrrl9brm5fis9ypihyctlh`. Live hover checks confirmed 12px left/right padding
and icon inset at 320, 488 and 1280px without viewport overflow. The temporary
test expense was soft-deleted and the original active expense list restored.

## Private accounts candidate — 2026-10-01

- Google-only Better Auth 1.7.6; verified identities, private group membership,
  admin/member roles, email-bound 7-day invitations and self-service agent keys.
- 678 Jest tests / 58 suites pass across both configured time zones.
- 29 new private-account PostgreSQL checks pass: genuine signed sessions and
  API-key plugin calls, cross-group rejection, invitation expiry/revocation,
  last-admin protection, actor attribution, receipt/export gates, MCP discovery,
  bootstrap capture boundary and revoked legacy keys not reappearing.
- Existing 24 audit/currency and 11 full-MCP PostgreSQL scenarios pass after
  updating fixtures to use authenticated accounts and email-bound invitations.
- Browser suite: 53/55 passed in the broad run; the remaining recurrence selector
  and lost-response recovery scenarios then passed in an 11/11 focused run.
  New account/key and invitation screens are checked at 320, 488 and 1280 pixels.
  All tested scenarios now pass; no browser tests were skipped to get this result.
- Fixed authenticated expense deletion to submit expectedRevision. A lost create
  response now reads its stable ID and opens the saved expense rather than
  minting a second expense. Updated obsolete conversion tests to verify separate
  currencies, face-value decimal input and same-currency repayment instead.
- Production build, type checking, formatting, and diff checks pass. Oxlint has
  only the two previously documented warnings (RHF/React Compiler and the group
  layout effect dependencies). Hosted GitHub CI has not been claimed.
- Scoped pre-cutover PostgreSQL backup saved on Oracle, mode 0600. This is a
  rollback precaution on the same host, not off-host disaster recovery.
- Google Auth Platform publishing status was observed as In production after
  explicit approval. App deployment/live Google round-trip verification follows.

### Private accounts — live verification

- Coolify deployment `s4fiykorekfaerhrkb9tkty8` finished on application commit
  `0c37ec01d8d99327c894a85f7b7d35d593c9d8db`, scoped to the existing AgentSplit resource.
- Real Google authorization-code/PKCE round trip completed on the production
  origin. The owner saw both pre-existing groups and the imported owner-codex
  key in Account & keys. Google publishing status is In production.
- Live signed-out group pages redirect to sign-in. Underlying tRPC reads and
  JSON/CSV exports return 401; the old anonymous S3 signer returns 410.
- Live MCP discovered all 17 tools and passed its schema/write/revision/rounding/
  currency/export checks. Signed Garage upload/finalization passed. Anonymous
  storage reads returned 403; app receipt reads returned 401 without credentials
  and the exact uploaded bytes with the owner key. Test ledger baseline restored.
- Live browser created a synthetic expense only in AgentSplit deployment test,
  uploaded a 24x32 PNG, saved/reopened it, and loaded the authenticated thumbnail.
  Browser deletion succeeded. MCP readback confirmed a verified web actor,
  retained receipt and deleted revision; the active test ledger returned to empty.
- Final focused browser rerun: all 11 recurrence/split cases pass, including the
  two broad-run failures. Together with the broad run, all 55 scenarios pass.
- The final follow-up commit changes verification tooling/documentation only;
  the deployed application code remains the tested commit above.

## Simplified login and profile navigation — 2026-10-01

The signed-out landing page now has one Log In action opening Google directly.
Workspace navigation and profile controls render only for a verified session;
the signed-in landing page redirects to groups. Agent setup requires login.
A top-right initials avatar opens settings directly, with theme and language
preferences moved there. Header identity is rendered from the server session
without flashing signed-out navigation during hydration.

Production build, TypeScript, formatting and diff checks pass. Lint retains the
two existing warnings. Seven focused browser scenarios pass across the initial
and focused reruns: login request/error handling, invitation callback preservation,
protected agent setup, avatar navigation, persistent theme preferences, existing
key/invitation flows and responsive layouts at 320, 488 and 1280 pixels. The local
signed-out page was also visually inspected.

Deployed application commit `93789a9b3215dfcf487d98446ca9e29321d70bc5` through
Coolify run `xgkvcto8qck6afvzk6el346b`. Live signed-out HTML has exactly one Log In
button and no workspace/profile controls; `/agents` redirects to login. In the
existing signed-in browser, the top-right FJ avatar opened settings and the
Preferences section showed theme/language controls. The deployed layout was
visually inspected; the owner key remained present.

## Agent historical reads — 2026-10-01

The existing MCP expense reads and balances now accept recorded-time or exact
activity boundaries; get_expense also accepts revision. Activity supports precise
timestamps and chronological order. Historical calculations reuse the existing
exact splitter. Missing legacy snapshots are reported and block historical balance
claims. Current group membership remains authoritative for every historical read.

Validation: 678 Jest cases pass; 23 new historical-query PostgreSQL scenarios,
24 existing audit/currency scenarios and 11 full-MCP PostgreSQL scenarios pass.
Four focused production-build web regressions pass (current create/balance,
edit, delete and activity). Build, type, format and diff checks pass; lint retains
the two existing warnings. No new dependencies. The activity-order migration
was applied successfully to both disposable local databases. A production DB
backup and hashes of pre-existing audit contents were saved before rollout.

A migration-specific regression additionally applies the exact SQL to an isolated
schema containing equal-timestamp revisions in reverse ID order. It verifies
create/edit/delete revision order, unchanged prior contents, the next sequence
value and restored append-only protection. Both disposable databases were aligned
with the corrected unreleased backfill, with pre/post content hashes matching;
the 23 historical-query scenarios pass on that ordering as well.

Live deployment `2jdpfvuhxqvgg9xnkdhdfldy` finished on application commit
`5c55eee9e312122cf0c77a51dada2920bea7879a`. The read-only production probe used an
already-deleted synthetic expense and passed direct revision, timestamp,
historical ledger/balance, deletion-marker and chronological-history checks.
All 41 pre-existing production audit records matched their pre-migration content
hashes exactly (new ordering metadata excluded). Both append-only and no-truncate
triggers remained enabled. No ledger changes were made by this live verifier.

## Paste API keys as-is; Codex app first — 2026-10-02

MCP, authenticated exports and receipt downloads now accept the raw copied key
in X-API-Key. Standard Authorization clients remain compatible. A shared parser
rejects malformed, duplicate/comma-joined and conflicting credentials; explicit
invalid key headers never fall back to an unrelated browser session.

The Agents guide now leads with Codex desktop app instructions matching the
Plugins/MCPs form: URL, X-API-Key header name and raw key value, with environment
fields left empty. CLI/environment-file configurations are optional disclosures.
No supplied screenshot or credential is embedded in source or documentation.
Official Codex docs confirmed static and environment-backed custom headers.

Checks: 700 Jest executions / 60 suites pass across both time zones, 31 real
private-account integration scenarios pass, and four focused browser scenarios
pass (guide, copy controls, key management, membership and layout). Build,
TypeScript, formatting and diff checks pass; lint retains two existing warnings.

Live rollout completed after the owner renewed Tailscale SSH access. Deployment
`6fjntply9xida3kpshn5kiws` runs application commit
`86a9a4c8ab2ce70b84292a4a2f4d4a297ed61fc3`. The live raw-key verifier passed MCP
17-tool discovery, identical identity/membership versus the existing client,
private CSV/JSON exports and receipt reads, anonymous receipt denial, and
conflicting-key rejection. The live Agents page was visually inspected: Codex
app instructions come first, and the normal guide has no bearer/env-field text.
CLI/configuration examples remain collapsed and optional. No ledger writes were
performed by this live verification.

## Fixed member identities and personal expense rows — 2026-10-02

New groups add their authenticated creator as a participant automatically. Each
membership binds one account to one participant; invitations reserve an email,
participant ID and recorded name. Acceptance checks the verified email. Database
uniqueness, same-group foreign keys and an immutable-binding trigger prevent
reassignment. Existing memberships require explicit admin linking; old unbound
invitations must be reissued. This additive migration changes no existing ledger
IDs, expense amounts, splits or audit snapshots.

The web UI no longer reads browser storage to select an identity. Personal rows
show you paid / you lent / you borrowed, with separate settlement/refund labels,
and retain authenticated Added by / Edited by attribution independently of payer.
MCP exposes the same bindings and attribution; historical expense attribution
stops at the requested revision. Unbound groups are explicitly disclosed in
personal-total responses and UI rather than being presented as settled.

Local validation: 718 Jest executions in 62 suites across two time zones;
11 fixed-identity, 31 private-account, 23 history-query and 11 full-MCP PostgreSQL
scenarios passed. Forty browser scenarios were covered, including the corrected
refund assertion and the final two-account invitation test. Screenshots were
inspected at 320 and 1280 pixels; overflow checks also passed at 488 and 768.
Production build, type, formatting and diff checks pass. Lint retains the two
existing warnings. No dependencies were added. Tests use disposable loopback
databases and synthetic verified accounts/sessions, not the owner's Google login.

A fresh scoped production backup and ledger/audit fingerprints were captured
before rollout. Production now contains real household data: no reset, destructive
migration, or deletion of real records is permitted for testing or deployment.

Live deployment `yn4ook3qyz0ctoac37pjvk36` finished on application commit
`9d62026900f7596ee76c8fb3e6c737bb79f20597`. All 17 live tools advertise the updated
contracts. The confirmed owner was linked to the existing household participant
through the audited access API; no other membership was guessed. Live list/detail
attribution and account-derived personal balances passed. The household export
retained all 4 expenses, 3 participant identities and 12 prior group audit events
exactly. Database-wide comparison retained all 18 expense records, 54 split rows,
6 participants and all 50 prior audit records unchanged. One new identity-binding
audit event was appended. Both audit protection triggers remain enabled. The live
expense list was visually inspected with authenticated you paid / you lent and
Added by / Edited by labels. No real expense was edited or deleted by verification.

## Custom group URLs and optional vendors — 2026-10-06

Local implementation adds nullable unique group slugs and nullable expense
vendors through the additive `20261007040000_group_slug_expense_vendor` migration.
The shared backend, UI and existing MCP tools expose these fields. Optional
vendors are separate from title, formatted as `Vendor — title`, and retained in
search, recurrence, exports and new snapshots. Older titles and immutable
snapshots are left intact. Short URLs reuse existing group pages and membership
checks; original ID links continue to work. Admin slug updates require the current
revision and serialize competing claims before the unique-index write.

Verification:

- Production build and TypeScript pass; 744 Jest executions in 64 suites pass.
- `scripts/test-slug-vendor.ts` passes on a new disposable loopback database:
  slug normalization/reservation, competing concurrent claims, current revisions,
  canonical links, vendor create/edit/clear/omission, current/historical filters,
  old snapshot compatibility, recurrence, CSV formula escaping, JSON export and
  admin-only settings. Existing MCP and audit suites pass 11 and 24 PostgreSQL
  scenarios respectively. These two suites must run serially on a shared test
  database because the audit suite checks global before/after row counts.
- Eight existing group/expense browser regressions passed; both new slug/vendor
  browser scenarios pass on the final build. They verify short root/subpage URLs,
  ID-link compatibility, create/edit/remove slug, optional vendor persistence and
  removal, duplicate/reserved URL errors, history, JSON export, and signed-out/
  nonmember access denial. Screenshots of the vendor form and expense list were
  visually inspected. Tests used installed Chrome and synthetic local accounts.
- A rewrite re-entry guard fixes the redirect loop found during browser testing.
  Its header controls routing only; destination authorization remains mandatory.
- No dependencies were added. Lint retains the two existing warnings.

The production backup was explicitly authorized. A private scoped database dump was saved on
Oracle at `/home/ubuntu/agentsplit-backups/slug-vendor-01a1143b/database.dump`
(69,111 bytes), alongside a preservation snapshot covering 2 groups, 31 expense
records, 6 participants, 89 split rows and 86 audit records. After explicit
production authorization, Coolify deployment `rsoaiyvtgbyyitfekqpdpdjp` deployed
application commit `cb05bbb149203e15f4a678657cb28e9c6daadf72`. App, database and
Garage are healthy. Every prior ledger/audit record matched the backup after
rollout, and both audit-protection triggers remain enabled. The admin API set
Macademia to `macademia` at group revision 4. Live browser checks verified the
short root URL, settings, expense navigation and the optional vendor input;
all 17 MCP tools advertise the new fields. A synthetic expense in the existing
deployment-test group passed create/read/search/clear/historical-read/delete
checks, and its starting balances were restored.

At the user's explicit request, all 17 current household expenses were manually
migrated to separate vendor/title fields through revision-checked, audited API
edits. Every expense retained its amounts, allocations, date, notes, receipt
references and original author. Prior title revisions remain readable, and
before/after balances are identical. A fresh private backup exists at
`/home/ubuntu/agentsplit-backups/vendor-backfill-01a1143b/database.dump`.

## Expense-page balance summary — 2026-10-06

The expense page now shows a sticky right-hand group-balance panel on desktop,
with the viewer's net balance, each participant's net and suggested payments.
Mobile presents a compact sticky summary with expandable details. Currencies
stay separate; expense search does not change the displayed group totals.
Balances refresh on entry/focus, after create/edit/delete, or through the panel's
refresh button. The existing balance endpoint and exact-decimal calculations are
reused. Group pages have more horizontal room for the sidebar. Vendor input now
uses the example placeholder `eg. Costco`.

Production build, types and formatting pass. All 104 focused balance/expense-row/
totals unit executions pass. Three focused browser scenarios pass, covering the
new panel, net figures after another participant pays, refresh after edits,
search independence, mobile expansion/no horizontal overflow, optional vendor,
and custom URL behavior. Desktop/mobile screenshots were inspected. A final
browser rerun verifies the no-matching-expenses search message and refreshed
screenshots. No dependencies were added. Before this UI rollout, a private dump
was saved at `/home/ubuntu/agentsplit-backups/balance-sidebar-01a1143b/database.dump`
(71,118 bytes; 32 expense records and 107 audit records, including retained test
history). Live rollout verification follows.

Live sidebar deployment `rethc5b1jfpv4v00ao9wacbz` finished on application commit
`7081b59ee3707c016e3e53d13bae7b1dc0a900dd`. App, database and Garage are healthy.
The post-rollout comparison preserved all 2 groups, 32 expense records,
6 participants, 92 split rows and 107 audit records exactly; both audit protection
triggers remain enabled. The final local browser scenario passed on the final
build. The signed-in production browser verified the right-hand net-balance
summary and suggested payments against the live MCP balances, confirmed the
panel stays sticky at 24px while scrolling, and checked the migrated vendor/title
and `eg. Costco` placeholder. The existing expense-review chat was informed of
the live contracts and completed vendor migration.
