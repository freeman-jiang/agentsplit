# Cutover runbook: from the current app to v2, both on Coolify

Status: **draft for Coolify** (2026-11-05). Freeman moved v2 hosting from Cloudflare Workers to Coolify on 2026-11-05 (DECISIONS.md), so this runbook replaces the Workers version. Freeman approves this runbook, the maintenance window, and each gated step before it runs.

## Gates before the window

- Met 2026-11-05: receipt uploads through MCP are merged into `v2` (5b0f4f4).
- Met 2026-11-05: the nightly backup (dots#56) is live on the dev box. `agentsplit-backup.timer` is enabled, with its first run on 2026-11-06 at 03:31 PST, and the alert "AgentSplit backup failed" is applied. Agents have root on the box through `devbox-root` (dots#60).
- The v2 server runs on Coolify's Compose build: branch `t3/v2-coolify` (in progress) adds the server, the Garage S3 client, `v2/Dockerfile` and `compose.v2.coolify.yaml`, and passes e2e against that stack locally. It is merged into `v2`.
- A Coolify preview of v2 (a separate application from branch `v2`, synthetic data, its own Postgres and Garage) passes the browser, agent, receipt and upload checks. Freeman approved creating it on 2026-11-05.
- CI is green on `v2`, and every parity item is covered, changed with a reason, or deferred with Freeman's agreement.
- Every production step below starts with a new verified backup: `agentsplit-backup coolify` with its test restore passing. A failed backup stops the step.

## Facts this runbook depends on

- Coolify builds the AgentSplit application from `main` with `compose.coolify.yaml`: services `app` (the current Next.js app), `db` (postgres:17, volume `postgres-data`) and `garage` (bucket `agentsplit-receipts`, volumes `garage-meta` and `garage-data`). `main` is push-to-deploy, so merging into `main` is the deploy.
- The domain `agentsplit.freemanjiang.com` already routes to that application. The cutover changes no DNS; dots#58 (a Workers custom domain) is no longer needed.
- Receipts stay in Garage. Stored receipt URLs are absolute Garage URLs, and the objects sit under the keys that v2's `receiptKey` derives, including the three older `document-<time>-<id>.png` keys. So no receipt is copied.
- The OAuth signing key in `Jwks` is encrypted with the production `BETTER_AUTH_SECRET`. v2 uses the same secret, so issued tokens and refresh tokens keep working.
- The Google OAuth client keeps its redirect URI, because the domain does not change.

## Preparation (before the window)

1. Confirm the gates above.
2. In Coolify, switch the AgentSplit application's Compose file to `compose.v2.coolify.yaml` only in the window (step 5 below); before it, add the new variables from `coolify.v2.env.example` (the `db2` password) to the application, without printing values.
3. Rehearse the window against the Coolify preview: import the latest nightly backup into the preview's `db2`, verify, and record the timings.

## The window (Freeman approves the start)

1. **Freeze writes.** Stop only the `app` container (or turn on Coolify maintenance mode). `db` and `garage` keep running. Confirm that a write fails.
2. **Final backup.** Run `agentsplit-backup coolify` and confirm that its test restore passes.
3. **Start `db2`.** Deploy the new Compose file with only `db2` started, or start it as a one-off service, so v2's empty PostgreSQL 18 database exists beside `db`.
4. **Import and verify.** From the dev box, open SSH tunnels to `db` and `db2` on the Oracle host's internal `backend` network. Apply the migrations to `db2`. Run `scripts/import-legacy.ts` from `db` into `db2`: one transaction, and any problem stops it with the row ID. Then run `test/legacy/verify-import.ts` with `RECEIPTS_JSONL=<final backup>/receipts.jsonl`: the same IDs in every table, every balance to the cent, every expense field by field, and every receipt URL mapped to a backed-up object.
5. **Deploy v2** (Freeman approves the merge into `main`). Merge `v2` into `main` with `compose.v2.coolify.yaml` as the application's Compose file. Coolify builds and starts the v2 `app` against `db2` and the same `garage`. Wait for the health check.
6. **Smoke checks.** In the browser: sign in with Google, open the Maple group (balances, expenses, a receipt), add and delete a test expense in the production test group (below), and check the Log. Agents: connect Claude Code through OAuth, list groups, make one write in the production test group, and call with an existing API key. Confirm that an existing agent connection keeps working through a token refresh. Freeman chose this check over a Google sign-in on the preview (2026-11-05), so it is the first run of a real Claude Code client against v2: connect, read, write, and keep working more than 5 minutes later, through a refresh (docs/v2/OAUTH-CLAUDE-CODE.md).
7. **Announce** that AgentSplit is back.

### The production test group

Freeman decided (2026-11-05) to keep one persistent group in production for checks: **AgentSplit test**, with only Freeman in it. Create it in step 6 of the first window through the v2 UI, as Freeman. Every later production check (browser, Claude Code, MCP writes) writes only there, and never in a household group. Production has no hard deletes, so its Log keeps every test expense, marked deleted.

## Rehearsal record

### 2026-11-05, local, all 8 migrations

The source was the nightly backup of 2026-11-05 (`~/backups/agentsplit/2026-11-05/agentsplit.dump`), restored into a local scratch database. The target was an empty local database with migrations 0000 to 0007.

| Step | Time |
| --- | --- |
| Restore the dump | 84 ms |
| Apply the migrations | 154 ms |
| Import | 355 ms |
| Verify | 223 ms |

The import wrote 2 groups, 6 participants, 4 memberships, 3 invitations, 48 expenses, 146 activities, 11 receipts and 11 documents. The verifier found the same IDs in every table, the same balances to the cent, and the same expenses field by field and share by share.

Production has no recurring and no ungrouped expenses today. So a second run added synthetic rows to the scratch source: a monthly expense on 31 October with its recurring link, and an ungrouped expense between the first user and an email-only friend. The import wrote 1 recurring link with `anchor_day` 31 and 1 private context with 2 people, and the verifier passed again.

### 2026-11-05, `apps-pg`, all 8 migrations

Freeman approved a scratch database on `apps-pg` for this run. The admin IAM user created `agentsplit_rehearsal` with `CREATE DATABASE`, without `app-db create`, so no role or service account was made. The source was the same backup, restored locally. The target was reached through `cloud-sql-proxy` from the dev box, as in the window.

| Step | Time |
| --- | --- |
| Apply the migrations | 528 ms |
| Import | 1,589 ms |
| Verify | 307 ms |

The verifier passed: the same IDs, balances and expenses as the local run. Then `agentsplit_rehearsal` was dropped, and `app-db list` no longer shows it. With the freeze, the final backup and the DNS switch, the window needs minutes, not hours.

## Rollback

- **Before step 5:** start the old `app` container again. Nothing changed for users, and `db` was only read.
- **After step 5:** set the application's Compose file back to `compose.coolify.yaml` and deploy the previous `main` commit, so the old `app` runs on the untouched `db` again. Writes made in v2 after the switch are only in `db2`: export them first (`activities` since the switch) and re-enter them by hand, or decide with Freeman.
- Keep `db`, `postgres-data` and the old Compose file intact until Freeman says otherwise. Do not delete volumes.

## After the cutover

1. Change the nightly backup's source to `db2` (a dots change through the dots thread). Receipts stay in Garage, which the backup already copies.
2. Watch the v2 container's errors and memory for a week.
3. Remove the unused Cloudflare resources with Freeman's approval: the `agentsplit-preview` Worker, its Hyperdrive config, the R2 buckets `agentsplit-receipts` and `agentsplit-receipts-preview` (OpenTofu, through the dots thread), and close dots#58.
4. Update README.md, MCP.md, AUTH.md, DEPLOYMENT.md and PRIVACY.md for v2.
5. Remove the current app from the repository and move v2 to the root, on a branch Freeman approves.
