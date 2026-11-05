# Cutover runbook: from the current app on Coolify to v2 on Workers

Status: **draft**. Freeman approves this runbook, the maintenance window, and each gated step before it runs.

## Facts this runbook depends on

- `agentsplit.freemanjiang.com` has no DNS record of its own. The wildcard `*.freemanjiang.com` (unproxied A record to Oracle, `192.9.147.79`, in `infra/cloudflare/dns_freemanjiang_com.tf`) serves it. A Worker custom domain for that one hostname takes precedence over the wildcard, and removing it sends traffic back to Oracle.
- Stored receipt URLs are absolute Garage URLs, such as `https://agentsplit-receipts.freemanjiang.com/<bucket>/<key>.png`. Browsers already read receipts through the authenticated `/api/receipts` endpoint, never from the storage host. v2 keeps the URL strings as identifiers and stores each object in R2 under the same key.
- The OAuth signing key in `Jwks` is encrypted with the production `BETTER_AUTH_SECRET`. v2 uses the same secret, so issued tokens and refresh tokens keep working.
- The Google OAuth client keeps its redirect URI, because the domain does not change.

## Preparation (before the window)

1. Confirm that every item in PLAN.md's "Done" list except the cutover itself is true: the parity checklist passes, CI is green, and the preview passed browser, agent and CPU checks.
2. Create the production database and identities: `app-db create agentsplit`. Apply the migrations as `agentsplit_owner`: `scripts/with-apps-pg.sh agentsplit bun db/migrate.ts`.
3. Create the production Hyperdrive from `app-db url agentsplit`, piped through `jq` into the Cloudflare API, never printed. Caching off.
4. Deploy the production Worker as `agentsplit` on `workers.dev` only, bound to the production Hyperdrive and the `agentsplit-receipts` bucket.
5. Copy the production secrets from Coolify into the Worker with `wrangler secret put`, piped, never printed: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_BOOTSTRAP_EMAIL`.
6. Rehearse steps 2 to 6 of the window against a fresh copy of the latest nightly backup in a scratch database, and record the timings.
7. Prepare the OpenTofu change that adds the Worker custom domain `agentsplit.freemanjiang.com`, as a saved plan for Freeman to review.

## The window (Freeman approves the start)

1. **Freeze writes.** Turn on Coolify maintenance mode for the AgentSplit application, or stop only the `app` container. Postgres and Garage keep running. Confirm that a write fails.
2. **Final backup.** Run `agentsplit-backup coolify` and confirm that its test restore passes.
3. **Restore locally.** Restore the final dump into a scratch database on the dev box (`agentsplit_cutover_test`).
4. **Import.** Run `scripts/import-legacy.ts` from the scratch database into the empty production database (through `scripts/with-apps-pg.sh agentsplit`). It runs in one transaction; any problem stops it with the row ID.
5. **Copy receipts.** Upload every object from the final backup's `receipts.jsonl` to `agentsplit-receipts` under its original key, and compare the count and the byte size of each object. The shared dev Cloudflare token cannot write R2 objects (403, code 10000, checked 2026-11-05), so this one step runs under `sops exec-env secrets/admin.env` with `wrangler r2 object put`, as the rules allow for a single command.
6. **Verify.** Run `test/legacy/verify-import.ts` from the scratch database against production: the same IDs in every table, every balance per group and currency to the cent, and every expense field by field and share by share. Compare the receipt list with the database rows.
7. **Switch DNS** (Freeman approves the saved plan). Apply the custom-domain plan, and confirm a clean replan.
8. **Smoke checks.** In the browser: sign in with Google, open the Macademia group (balances, expenses, a receipt), add and delete a test expense in a synthetic group only, and check the Log. Agents: connect Claude Code through OAuth, list groups, make one write in a synthetic group, and call with an existing API key. Confirm that an existing agent connection keeps working through a token refresh.
9. **Announce** that AgentSplit is back.

## Rollback

- **Before the DNS switch:** turn the old app back on. Nothing changed for users.
- **After the DNS switch:** remove the custom domain (the saved rollback plan), so the wildcard serves Oracle again, and turn the old app back on. Writes made in v2 after the switch are not in the old database: export them from v2 first (`activities` since the switch) and re-enter them by hand, or decide with Freeman.
- Keep the old Coolify stack stopped but intact until Freeman says otherwise. Do not delete its volumes.

## After the cutover

1. Change the nightly backup's source from `coolify` to `apps-pg` (a dots change; it backs up the production database through the proxy and copies R2 objects with a read-only R2 token, which needs an OpenTofu-managed token and Freeman's approval).
2. Update README.md, MCP.md, AUTH.md, DEPLOYMENT.md and PRIVACY.md for v2.
3. Remove the current app from the repository and move v2 to the root, on a branch Freeman approves.
