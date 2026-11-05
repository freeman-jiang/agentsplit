# Cutover runbook: from the current app on Coolify to v2 on Workers

Status: **ready for Freeman's review** (2026-11-05). Freeman approves this runbook, the maintenance window, and each gated step before it runs.

## Gates before the window

- Met 2026-11-05: receipt uploads through MCP are merged into `v2` (5b0f4f4) and passed the full flow on the preview.
- Write CPU: an MCP expense write costs about 40 ms at p50 (BASELINE.md). A branch that removes duplicate statements is in progress; Freeman decides whether it merges, and whether writes need more.
- Met 2026-11-05: the nightly backup (dots#56) is live on the dev box. `agentsplit-backup.timer` is enabled, with its first run on 2026-11-06 at 03:31 PST, and the alert "AgentSplit backup failed" is applied. Agents now have root on the box through `devbox-root` (dots#60), audited in Cloud Audit Logs.
- CI is green on `v2`, and every parity item is covered, changed with a reason, or deferred with Freeman's agreement.
- Every production step below (preparation steps 2 to 5, and the window) starts with a new verified backup: `agentsplit-backup coolify` with its test restore passing. A failed backup stops the step.

## Facts this runbook depends on

- `agentsplit.freemanjiang.com` has no DNS record of its own. The wildcard `*.freemanjiang.com` (unproxied A record to Oracle, `192.9.147.79`, in `infra/cloudflare/dns_freemanjiang_com.tf`) serves it. A Worker custom domain for that one hostname takes precedence over the wildcard, and removing it sends traffic back to Oracle.
- Stored receipt URLs are absolute Garage URLs, such as `https://agentsplit-receipts.freemanjiang.com/<bucket>/<key>.png`. Browsers already read receipts through the authenticated `/api/receipts` endpoint, never from the storage host. v2 keeps the URL strings as identifiers and stores each object in R2 under the same key.
- Production's 11 receipt URLs use two key forms: `receipts/<id>.png` and an older `document-<time>-<id>.png`. Until 2026-11-05, v2 read only the first form, so the three older documents would have answered 404 after the cutover. `receiptKey` now takes the key after the storage prefix, as the current app does, and step 6 of the window checks every stored URL.
- The OAuth signing key in `Jwks` is encrypted with the production `BETTER_AUTH_SECRET`. v2 uses the same secret, so issued tokens and refresh tokens keep working.
- The Google OAuth client keeps its redirect URI, because the domain does not change.

## Preparation (before the window)

1. Confirm that every item in PLAN.md's "Done" list except the cutover itself is true: the parity checklist passes, CI is green, and the preview passed browser, agent and CPU checks.
2. Create the production database and identities: `app-db create agentsplit`. Apply the migrations as `agentsplit_owner`: `scripts/with-apps-pg.sh agentsplit bun db/migrate.ts`.
3. Create the production Hyperdrive from `app-db url agentsplit`, piped through `jq` into the Cloudflare API, never printed. Caching off.
4. Deploy the production Worker as `agentsplit` on `workers.dev` only, bound to the production Hyperdrive and the `agentsplit-receipts` bucket. Add an `env.production` block to `v2/wrangler.jsonc` first: `name: agentsplit`, the production Hyperdrive ID, the `agentsplit-receipts` bucket, `BASE_URL: https://agentsplit.freemanjiang.com`, the same cron and `ENABLE_EXPENSE_DOCUMENTS`. Deploy with `wrangler deploy --env production`.
5. Copy the production secrets from Coolify into the Worker with `wrangler secret put`, piped, never printed: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_BOOTSTRAP_EMAIL`, `AUTH_BOOTSTRAP_LEGACY_USER_ID`. Production sets no `DEFAULT_CURRENCY_CODE` (checked 2026-11-05), so its default currency is the code default, USD, as in v2.
6. Rehearse steps 2 to 6 of the window against a fresh copy of the latest nightly backup in a scratch database, and record the timings.
7. Prepare the OpenTofu change that adds the Worker custom domain `agentsplit.freemanjiang.com`, as a saved plan for Freeman to review. Done: draft PR https://github.com/freeman-jiang/dots/pull/58, whose plan on 2026-11-05 was 1 to add, 0 to change, 0 to destroy. It stays a draft until the window, because `main` must match what is live. In the window, merge it, plan again, read the plan, and apply it.

## The window (Freeman approves the start)

1. **Freeze writes.** Turn on Coolify maintenance mode for the AgentSplit application, or stop only the `app` container. Postgres and Garage keep running. Confirm that a write fails.
2. **Final backup.** Run `agentsplit-backup coolify` and confirm that its test restore passes.
3. **Restore locally.** Restore the final dump into a scratch database on the dev box (`agentsplit_cutover_test`).
4. **Import.** Run `scripts/import-legacy.ts` from the scratch database into the empty production database (through `scripts/with-apps-pg.sh agentsplit`). It runs in one transaction; any problem stops it with the row ID.
5. **Copy receipts.** Run `bun scripts/copy-receipts.ts <final backup>/receipts.jsonl agentsplit-receipts` from `v2/`. It writes each object under its original key, reads it back, and compares its size; any mismatch stops it. The shared dev Cloudflare token cannot write R2 objects (403, code 10000, checked 2026-11-05), so this one command runs under `sops exec-env ~/projects/dots/secrets/admin.env`, as the rules allow for a single command. Rehearsed on 2026-11-05 against `agentsplit-receipts-preview` with synthetic images, including a `document-<time>-<id>.png` key; the test objects were deleted after.
6. **Verify.** Run `test/legacy/verify-import.ts` from the scratch database against production, with `RECEIPTS_JSONL=<final backup>/receipts.jsonl`: the same IDs in every table, every balance per group and currency to the cent, every expense field by field and share by share, and every stored receipt URL mapped by v2's key rule to a backed-up object. On the 2026-11-05 backup: 11 receipt URLs, 13 objects, all mapped.
7. **Switch DNS** (Freeman approves the saved plan). The dots thread merges https://github.com/freeman-jiang/dots/pull/58, plans again, shows Freeman the plan, applies it, and confirms a clean replan.
8. **Smoke checks.** In the browser: sign in with Google, open the Macademia group (balances, expenses, a receipt), add and delete a test expense in the production test group (below), and check the Log. Agents: connect Claude Code through OAuth, list groups, make one write in the production test group, and call with an existing API key. Confirm that an existing agent connection keeps working through a token refresh. Freeman chose this check over a Google sign-in on the preview (2026-11-05), so it is the first run of a real Claude Code client against v2: connect, read, write, and keep working more than 5 minutes later, through a refresh (docs/v2/OAUTH-CLAUDE-CODE.md).
9. **Announce** that AgentSplit is back.

### The production test group

Freeman decided (2026-11-05) to keep one persistent group in production for checks: **AgentSplit test**, with only Freeman in it. Create it in step 8 of the first window through the v2 UI, as Freeman. Every later production check (browser, Claude Code, MCP writes) writes only there, and never in a household group. Production has no hard deletes, so its Log keeps every test expense, marked deleted.

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

- **Before the DNS switch:** turn the old app back on. Nothing changed for users.
- **After the DNS switch:** remove the custom domain (the saved rollback plan), so the wildcard serves Oracle again, and turn the old app back on. Writes made in v2 after the switch are not in the old database: export them from v2 first (`activities` since the switch) and re-enter them by hand, or decide with Freeman.
- Keep the old Coolify stack stopped but intact until Freeman says otherwise. Do not delete its volumes.

## After the cutover

1. Change the nightly backup's source from `coolify` to `apps-pg` (a dots change; it backs up the production database through the proxy and copies R2 objects with a read-only R2 token, which needs an OpenTofu-managed token and Freeman's approval).
2. Update README.md, MCP.md, AUTH.md, DEPLOYMENT.md and PRIVACY.md for v2.
3. Remove the current app from the repository and move v2 to the root, on a branch Freeman approves.
