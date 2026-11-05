# Cutover runbook: from the current app to v2, both on Coolify

Status: **done** (2026-11-05). Freeman approved the window; v2 is live since 18:00:48 UTC. Freeman moved v2 hosting from Cloudflare Workers to Coolify on 2026-11-05 (DECISIONS.md), so this runbook replaces the Workers version. Freeman approves this runbook, the maintenance window, and each gated step before it runs.

## Gates before the window

- Met 2026-11-05: receipt uploads through MCP are merged into `v2` (5b0f4f4).
- Met 2026-11-05: the nightly backup (dots#56) is live on the dev box. `agentsplit-backup.timer` is enabled, with its first run on 2026-11-06 at 03:31 PST, and the alert "AgentSplit backup failed" is applied. Agents have root on the box through `devbox-root` (dots#60).
- Met 2026-11-05: the v2 server runs on Coolify's Compose build (bc6d82c): a Bun server, Bun's S3 client for Garage, `v2/Dockerfile` and `compose.v2.coolify.yaml`. e2e passes against that stack locally.
- Met 2026-11-05: the Coolify preview (`AgentSplit v2 preview`, https://agentsplit-v2-preview.freemanjiang.com, `compose.v2.preview.yaml`, 192 synthetic expenses) passed:
  - browser: the group page, titles, the balance rail, the expense editor, the expense log, and a receipt image from Garage;
  - agents: all 20 tools, an upload PUT (a second PUT refused), attach, download with the API key, and writes. Round trips from the dev box: 142 ms p50 for a 30-row list, 114 ms for a write.
- CI is green on `v2`, and every parity item is covered, changed with a reason, or deferred with Freeman's agreement.
- Every production step below starts with a new verified backup: `agentsplit-backup coolify` with its test restore passing. A failed backup stops the step.

## Facts this runbook depends on

- Coolify builds the AgentSplit application from `main` with `compose.coolify.yaml`: services `app` (the current Next.js app), `db` (postgres:17, volume `postgres-data`) and `garage` (bucket `agentsplit-receipts`, volumes `garage-meta` and `garage-data`). `main` is push-to-deploy, so merging into `main` is the deploy.
- The domain `agentsplit.freemanjiang.com` already routes to that application. The cutover changes no DNS; dots#58 (a Workers custom domain) is no longer needed.
- Receipts stay in Garage. Stored receipt URLs are absolute Garage URLs, and the objects sit under the keys that v2's `receiptKey` derives, including the three older `document-<time>-<id>.png` keys. So no receipt is copied.
- Lessons from the preview, applied:
  - Coolify keeps `/etc/garage.toml` as a file storage of the resource. The existing AgentSplit resource already has it, so the cutover keeps that resource and changes only its Compose file. A new resource would get a directory there, and Garage would not start.
  - The app is on its stack's `backend` network and on Coolify's shared `coolify` network. A plain service name such as `garage` can resolve to another stack there: on the preview it reached production's Garage, which refused the unknown key. The app now reaches `db2` and Garage only by unique aliases (`agentsplit-db2`, `agentsplit-garage`).
  - The v2 container applies the migrations at start, so `db2` is migrated and empty before the import.
- The OAuth signing key in `Jwks` is encrypted with the production `BETTER_AUTH_SECRET`. v2 uses the same secret, so issued tokens and refresh tokens keep working.
- The Google OAuth client keeps its redirect URI, because the domain does not change.

## Preparation (before the window)

1. Confirm the gates above.
2. In Coolify, switch the AgentSplit application's Compose file to `compose.v2.coolify.yaml` only in the window (step 5 below); before it, add the new variables from `coolify.v2.env.example` (the `db2` password) to the application, without printing values.
3. Rehearse the window against the Coolify preview: import the latest nightly backup into the preview's `db2`, verify, and record the timings.

## The window (Freeman approves the start)

1. **Freeze writes.** Set `AGENTSPLIT_MAINTENANCE=1` on the AgentSplit application in Coolify (it has no effect on the current app). Then stop only the current `app` container over SSH (`sudo docker stop <app container>`); `db` and `garage` keep running. The domain answers 502 until step 3. Confirm that a write fails. Coolify's API cannot toggle its own maintenance mode, so v2 carries the switch (tested on the preview on 2026-11-05: pages, RPC and MCP answered 503, `/api/health` 200, the container healthy).
2. **Final backup.** Run `agentsplit-backup coolify` and confirm that its test restore passes.
3. **Deploy v2 behind maintenance** (Freeman approves the merge into `main`). Merge `v2` into `main`, set the application's Compose file to `/compose.v2.coolify.yaml`, and deploy. Coolify builds the v2 `app`, starts `db2` beside the unchanged `db`, and keeps `garage` with its volumes. The v2 container migrates the empty `db2` at start and, with the switch on, answers 503 with a maintenance page to everything but `/api/health`. Its hourly job is paused.
4. **Import and verify.** From the dev box, open SSH tunnels to `db` and `db2` on the Oracle host. Run `scripts/import-legacy.ts` from `db` into `db2`: one transaction, and any problem stops it with the row ID. Then run `test/legacy/verify-import.ts` with `RECEIPTS_JSONL=<final backup>/receipts.jsonl`: the same IDs in every table, every balance to the cent, every expense field by field, and every receipt URL mapped to a backed-up object. A failure here means rollback.
5. **Open v2.** Clear `AGENTSPLIT_MAINTENANCE` and deploy again (31 seconds on the preview). Check `/api/health` and the home page.
6. **Smoke checks.** In the browser: sign in with Google, open the Macademia group (balances, expenses, a receipt), add and delete a test expense in the production test group (below), and check the Log. Agents: connect Claude Code through OAuth, list groups, make one write in the production test group, and call with an existing API key. Confirm that an existing agent connection keeps working through a token refresh. Freeman chose this check over a Google sign-in on the preview (2026-11-05), so it is the first run of a real Claude Code client against v2: connect, read, write, and keep working more than 5 minutes later, through a refresh (docs/v2/OAUTH-CLAUDE-CODE.md).
7. **Announce** that AgentSplit is back.

### The production test group

Freeman decided (2026-11-05) to keep one persistent group in production for checks: **AgentSplit test**, with only Freeman in it. Create it in step 6 of the first window through the v2 UI, as Freeman. Every later production check (browser, Claude Code, MCP writes) writes only there, and never in a household group. Production has no hard deletes, so its Log keeps every test expense, marked deleted.

## Cutover record (2026-11-05)

| Step | Time (UTC) | Result |
| --- | --- | --- |
| Prepare | 17:56 | Merge commit `a464eb2` built locally. Coolify: Compose file `/compose.v2.coolify.yaml`, post-deployment command cleared (it ran `node`, which the v2 image does not have), `DB2_PASSWORD` and `AGENTSPLIT_MAINTENANCE=1` added. |
| 1. Freeze | 17:56:57 | The current `app` container stopped. The page answered 502, a write 503. |
| 2. Final backup | 17:58 | The first run failed: `agentsplit-backup: production containers not found`, because the script runs `node` in the `app` container to copy receipts. A helper container from the old image (`backend` network only, no Traefik labels, `sleep`) gave it a container to run in; it was removed after. Result: `ok (2\|48\|3\|146, 13 receipt objects)`, test restore passed. |
| 3. Deploy v2 behind maintenance | 17:58:39 | `main` pushed (`a464eb2`), deployed through the API (pushes do not deploy). `db`, `garage` kept their volumes from 2026-09-30; `postgres18-data` new. v2 migrated `db2` (9 migrations) and answered 503 to pages and RPC, 200 to `/api/health`. |
| 4. Import and verify | 17:59 | Import in 21.9 s. The verifier: the same IDs in every table (48 expenses, 146 activities, 14 sessions, 308 OAuth refresh tokens, 3 API keys, 4 OAuth connections), balances to the cent, every expense field by field, 11 receipt URLs mapped to 13 backed-up objects. |
| 5. Open v2 | 18:00:48 | Maintenance cleared and deployed. Page and `/api/health` 200; the MCP 401 asks for `agentsplit:read agentsplit:write offline_access`. All 11 stored receipt URLs exist in Garage under v2's key. |
| 6. Smoke checks | pending | Freeman: Google sign-in, Macademia, a receipt, the production test group, Claude Code connect, write and refresh. |

Downtime: about 4 minutes (17:56:57 to 18:00:48).

The final pre-cutover backup (the current app's schema, taken after the freeze) is `~/backups/agentsplit/2026-11-05.175807/`: the v2 backup job moved it aside when it ran on the same day, so `~/backups/agentsplit/2026-11-05/` now holds the first v2 backup. Keep the pre-cutover backup until Freeman says otherwise.

Follow-up: the nightly backup dumped the old `db` and copied receipts with `node`, which v2's `app` does not have. dots#62 (Freeman approved it on 2026-11-05) makes it dump `db2` and copy receipts with Bun; its first run against production passed (2 groups, 48 expenses, 146 activities, 13 receipt objects). It is merged as dots `d046b9b` and live: the installed unit ran at 18:38 UTC with `Result=success` (`ok (2|48|146|48, 13 receipt objects)`), and the timer runs nightly between 03:30 and 03:40 PST.

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

- **Before step 5:** set the application's Compose file back to `/compose.coolify.yaml` and deploy the previous `main` commit (start the old `app` container again if the failure came before step 3). The old `app` runs on `db`, which the import only read. Nothing changed for users.
- **After step 5:** the same steps. Writes made in v2 after step 5 are only in `db2`: export them first (`activities` since step 5) and re-enter them by hand, or decide with Freeman.
- Keep `db`, `postgres-data` and the old Compose file intact until Freeman says otherwise. Do not delete volumes.

## After the cutover

1. Change the nightly backup's source to `db2` (a dots change through the dots thread). Receipts stay in Garage, which the backup already copies.
2. Watch the v2 container's errors and memory for a week.
3. Remove the unused Cloudflare resources with Freeman's approval: the `agentsplit-preview` Worker, its Hyperdrive config, the R2 buckets `agentsplit-receipts` and `agentsplit-receipts-preview` (OpenTofu, through the dots thread), and close dots#58.
4. Update README.md, MCP.md, AUTH.md, DEPLOYMENT.md and PRIVACY.md for v2.
5. Remove the current app from the repository and move v2 to the root, on a branch Freeman approves.
