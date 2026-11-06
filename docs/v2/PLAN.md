# AgentSplit v2 plan

Rebuild AgentSplit as v2 on the standard dev-box stack and move production to it without losing or changing any real data.

## Context

- The repository is a public fork of Spliit. Never change its visibility. Never commit secrets or real household data.
- Production runs Next.js and Prisma on Coolify (Oracle), application `6xpohwok1yiguyk3syzqgumj`, at https://agentsplit.freemanjiang.com. It has its own PostgreSQL 17 and Garage, and it holds real household data. The Macademia group (`/macademia`) is the most important.
- Read these first: `DEPLOYMENT.md` (data-preservation rules), `MCP.md`, `AUTH.md`, `PRIVACY.md`, and `~/dots/devbox/NEW-APP.md`.
- Verified backups from 2026-11-04 are in `~/backups/agentsplit/2026-11-04/` (pg_dump, Garage volumes, all 13 receipt objects). Take a new verified backup before every production step.
- The uncommitted `tooling` branch has a working flake (Node 26, Bun, PostgreSQL 17 in UTC, Nix Chromium) and these test findings:
  - The integration scripts need a PostgreSQL server in UTC, fake auth configuration (`BASE_URL`, Google test client, `BETTER_AUTH_SECRET`), and `scripts/package.json` with `"type": "module"`.
  - The OAuth authorize test must send `sec-fetch-mode: navigate`, as a browser does.
  - The MCP server has 20 tools, not 17.
  - CI has never run on this fork, because GitHub disables workflows on forks until they are enabled.
- Reuse what v2 needs from that branch. Drop the Next.js-specific Docker changes.

## Target stack

- Vite and a React SPA with TanStack Router.
- Effect, with Effect Schema as the shared contract, and `@effect/rpc`.
- Drizzle.
- Better Auth. Keep its OAuth provider, dynamic client registration (DCR), CIMD, and API keys.
- MCP served by the same server, through the same domain services as the UI.
- Coolify on the Oracle host, in the same Compose stack as today: the v2 server, a new PostgreSQL 18 service beside the current database, and the existing Garage bucket for receipts. Freeman changed this from a Cloudflare Worker on 2026-11-05, after writes stayed about 3 times over the Workers Free CPU limit (DECISIONS.md).
- Keep the domain and the `/api/receipts` URL scheme. The domain already routes to Coolify, so the cutover changes no DNS.

## Invariants

Enforce each invariant in Effect Schema, in pure domain functions, and in the database:

1. Money is integer minor units, with an exhaustive currency registry. The API uses exact decimal strings.
2. Shares sum exactly to the amount. With multiple payers, payments also sum exactly to the amount. Remainders are placed deterministically, and a deferred constraint trigger checks the sums.
3. Balances are derived from the ledger and sum to zero per group and currency.
4. Currencies never mix. A conversion is an explicit entry that stores its rate.
5. The ledger is append-only, with revisions and tombstones. Triggers protect history.
6. Every edit names the version it changes.
7. Every write takes an idempotency key.
8. Participant IDs are stable. A participant with a balance or references cannot be removed.
9. Expense dates are calendar dates. Times use `timestamptz`.
10. One server-side membership check serves the UI and MCP.

Add property tests that prove conservation.

## Parity or better

1. Before writing v2 code, inventory the current app into a parity checklist. Include every route and screen, every setting, every MCP tool with its inputs and outputs, every behavior in `README.md`, `MCP.md` and `AUTH.md`, every Playwright spec in `e2e/`, and every integration script in `scripts/`.
2. Give each item a v2 test.
3. v2 must pass every item before cutover. No regressions are allowed. If an item changes on purpose, record the reason and get Freeman's approval.

## New features

- Multiple payers per expense.
- Sorting of group expenses by expense date and by last edited or added, with filters.
- A fix for the Claude Code OAuth bug that Krish reported. Reproduce it with a real Claude Code client before fixing it, and verify the fix with the same client.
- Agent instructions, and the field descriptions of create and update, that say:
  - Record the full payment, including the payer's own share.
  - Include the payer in paidFor with their share, unless the payer paid only for other people.
  - Put the full calculation in notes, so that a person can recalculate every number. Keep the title short.

Decisions on the current app's doubtful behavior are in [DECISIONS.md](DECISIONS.md). v2 is English only.

## Speed

1. Measure the current app's signed-in pages first.
2. Set budgets for bundle size, requests per screen, and server time per route.
3. Show that v2 meets the budgets and beats the current app.

## Data safety

- Run a nightly backup outside GCP: `pg_dump` and the receipt objects, copied to the dev box, where restic covers them.
- Run an automated test restore after each backup. It checks that every balance matches.

## Migration

1. Write an importer from the old PostgreSQL and Garage.
2. Rehearse it on restored copies until these checks pass:
   - Every group balance per currency matches the old app to the cent.
   - Every expense, split, participant ID, revision and receipt maps across.
3. Preserve users, Google accounts, hashed API keys, OAuth clients and refresh tokens, so that agents do not need to reconnect. One reconnect is the accepted fallback.
   - The `Jwks` table holds the OAuth signing key, encrypted with the production `BETTER_AUTH_SECRET`. v2 must use the same secret, copied from Coolify straight into `wrangler secret put` without printing it. Otherwise every issued token fails and the JWKS must be regenerated.
4. Use previews only on `agentsplit_preview`, with synthetic data.
5. Verify UI in the T3 browser.

## Approval gates

Ask Freeman before each of these:

- Any production write or deploy.
- A merge into a branch that deploys.
- Any OpenTofu plan that changes DNS, IAM or access. Show the saved plan.
- The cutover. Bring a runbook with the maintenance window, the final backup, the import, the verification checklist, and the rollback.
- Stopping or deleting the old Coolify stack. Keep it stopped and intact for rollback until Freeman says otherwise.

Report each failure exactly, and stop the steps that depend on it.

## Done

All of these are true:

- v2 serves https://agentsplit.freemanjiang.com.
- The parity checklist passes in full.
- The cutover checks pass: row counts, balances to the cent, receipts that open, the Macademia group checked in the browser, and agents connected through OAuth and API keys, including Claude Code. Freeman waived the Claude Code run on 2026-11-06 ([DECISIONS.md](DECISIONS.md)); Krish may run it later.
- The nightly backup and test restore run.
- CI is green.
- `README.md`, `MCP.md`, `AUTH.md`, `DEPLOYMENT.md` and `PRIVACY.md` describe v2.
- Freeman has approved the cutover.
