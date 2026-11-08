# Building AgentSplit v2

This guide is for every person or agent who adds to v2. Read [PLAN.md](PLAN.md), [DESIGN.md](DESIGN.md) and [DECISIONS.md](DECISIONS.md) first. The parity checklist is [PARITY.md](PARITY.md).

## Commands

Run every command inside the dev shell, from the repository root: `direnv exec . <command>`.

| Task | Command |
| --- | --- |
| Install the dependencies | `bun install --frozen-lockfile` |
| Production build (client, server bundle, migrations) | `bun run build` |
| Bundle budget and no Effect in the client (after the build) | `bun scripts/check-bundle.ts` |
| Type check (after the build, which generates the route tree) | `bun run check-types` |
| Unit and database tests | `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_test_<area> bun run test` |
| End-to-end tests, built server | `./scripts/e2e.sh` |
| End-to-end tests, the image and the Coolify stack | `./scripts/e2e.sh --compose` |
| Image | `docker build -t agentsplit .` |
| Apply migrations locally | `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/<db> bun db/migrate.ts` |
| New SQL migration | `bunx drizzle-kit generate --name <name>`, or `--custom` for triggers. Declare every table and CHECK in `db/schema/`, so `drizzle-kit generate` reports no changes afterwards (CI checks it). |

- The test database name must contain `test` and have at most 53 characters. Without `TEST_DATABASE_URL`, the tests use `agentsplit_test` on the dev shell's PostgreSQL. The tests migrate that database once and give each test file its own copy (`<name>__<8 hex digits>`), so the files run in parallel; the run drops the copies at the end.
- The end-to-end tests start Garage (and, with `--compose`, the app image and PostgreSQL 18) through `docker-compose` on the Podman socket. Each run uses new test-only secrets and removes its containers and volumes. Set `E2E_PORT` to run more than one suite at a time.
- The GitHub workflow `.github/workflows/ci.yml` runs these checks in the same dev shell (`nix develop`), and three more: `scripts/check-bun-version.ts` must find one Bun version in the dev shell, the Dockerfile images and `@types/bun` (Dependabot leaves Bun alone, so bump the three together), `drizzle-kit generate` must find no change between `db/schema` and the migrations, and `scripts/gen-auth-schema.ts` must leave `db/schema/auth.ts` as it is.

## Local database

- One PostgreSQL 18 server runs for the whole machine at `127.0.0.1:5437`, started with `db-start` from the main checkout (`~/projects/agentsplit`). Do not run `db-start` in a worktree: a second server would fight for the port. If it is not running, report that.
- Use your own database names, so parallel work does not collide: `agentsplit_test_<area>` for tests (the name must contain `test`) and `agentsplit_dev_<area>` for a dev server.
- `db-reset <name>` drops and recreates a database whose name contains `test`, `e2e`, `perf` or `dev`.
- Never touch `agentsplit_dev` or `agentsplit_restore_test`; the lead uses them. `db/local-databases.json` lists them with the disposable name parts, and `db-reset`, the test kit and `scripts/seed-synthetic.ts` refuse them (`test/local-databases.test.ts`). A new database to protect goes there.
- Use synthetic data only (`scripts/seed-synthetic.ts`, or the test kit in `test/kit/`). Never copy the production backups.

## Dev server

The dev server is two processes: Vite serves the client and sends the server's paths (`SERVER_PATHS` in `src/shared/paths.ts`: `/api/`, `/.well-known/`, `/robots.txt`, `/sitemap.xml` and the exports) to the API server on `API_PORT`.

1. Create a dev database: `db-reset agentsplit_dev_<area>`.
2. Apply the migrations: `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area> bun db/migrate.ts`.
3. Write `.env.local` (Git ignores it, and Bun reads it) with these settings:
   - `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area>`
   - `PORT=<api-port>`
   - `BASE_URL=http://localhost:<vite-port>`
   - `BETTER_AUTH_SECRET`: a random 64-character hex string (`openssl rand -hex 32`).
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: any placeholders.
   - `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_KEY` and `S3_UPLOAD_SECRET`: a local Garage. `scripts/e2e.sh` shows how to start one from the Compose file.
4. Start the API server: `bun run dev:server`.
5. In a second terminal, start Vite: `API_PORT=<api-port> bun run dev -- --port <vite-port> --strictPort`.
6. To sign in without Google, seed the dev database: `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area> bun scripts/seed-synthetic.ts <cookie-file>`. It adds a synthetic household with a year of expenses and writes the session cookie of `alice@example.com` to `<cookie-file>`, signed with the `BETTER_AUTH_SECRET` of `.env.local` for its `BASE_URL`. Send the file's text as the `Cookie` header, or set the cookie in the browser.
7. Open `http://localhost:<vite-port>`.

## Adding an area

Each area owns its own files, so areas can be built in parallel:

1. **Contract:** `src/shared/api/<area>.ts` defines an `RpcGroup` of the area's procedures with Effect Schema payloads, outputs and errors. Reuse `Id`, `IdempotencyKey`, `CalendarDate`, the vocabulary schemas (`ExpenseKindSchema`, `RecurrenceSchema` and others), `ReadError`, `WriteError` and the error classes from `src/shared/api/core.ts`. What each error means to a caller (its RPC log level, MCP code, recovery, HTTP status and text) is one table in `src/shared/errors.ts`; a new `NotFound` entity or `Invalid` reason goes there. Outputs use `DecimalOutput` and plain strings; inputs use the checked `DecimalString` and `CalendarDate`.
2. **Register the contract:** add the group to the `CoreApi.merge(...)` call in `src/shared/api/index.ts` and re-export it. `test/api-contract.test.ts` fails when an exported group is not merged or repeats a tag.
3. **Domain service:** `src/server/<area>.ts` holds the functions. Each takes `(db, { principal, groupId, ... })`, where `groupId` is the caller's group reference (an ID or a slug), checks access itself, and returns values or throws the shared domain errors (`Forbidden`, `NotFound`, `Conflict`, `Invalid`). It never builds an HTTP response.
4. **Handlers:** `src/server/handlers/<area>.ts` exports a layer of `Api.toLayerHandler(tag, ...)` calls built with `read`, `write` and `publicRead` from `src/server/rpc.ts`. Add it to `Layer.mergeAll` in `src/server/main/app.ts` (a one-line edit).
5. **Client:** queries in `src/client/queries/<area>.ts` (`queryOptions` and `infiniteQueryOptions`) with keys from `queries/keys.ts`, screens as TanStack Router file routes under `src/client/routes/`. Replace the placeholder route of your screen.
6. **Tests:** `test/db/<area>.test.ts` for services against a real database, and the parity record below. Build the data with the test kit (`test/kit/`: the database copy and its transaction, principals, web and MCP drafts, images, uploads, session cookies, groups written as `createGroup` writes them (`seedGroup`), ID counters and the MCP client), and reach the app through `test/db/harness.ts` (`startHarness`, `testApp`, and the calls `checked` for MCP and `webRpc` for RPC), which serves every request through `createApp`. Each test makes its own rows, so it passes alone and in any order (`bun run test -- --sequence.shuffle.tests`).
7. **Parity record:** `docs/v2/parity/<area>.md` lists every PARITY.md item you covered, with the test that proves it, and every item you could not cover, with the reason.

## Server modules

The folders of `src/server/` depend in one direction only: `main/` → `handlers/` and `mcp/` → the area services in `src/server/` → `auth/` → `core/`. A module never imports a folder to its left.

- `core/`: what everything else builds on. `db.ts` (the pool and transactions), `ids.ts`, `config.ts` (every setting, read and checked once at start by `main/server.ts`), `errors.ts` (the domain errors and their JSON answers on plain HTTP routes) and `access.ts` (`Principal`, `requireMember` and `memberCte`, the one group membership check, and `groupRef`, which denies a group reference that PostgreSQL text cannot hold).
- `main/`: the composition root. `app.ts` routes every request; `server.ts` is the Bun process (the pool, the server, the hourly job).

The area services build on these modules in `src/server/`. Use them instead of writing their SQL again:

- `expense-read.ts`: the expense read model (`expenseColumns`, `toExpense`, `loadExpenses`), what a read adds to it (`ExpenseParts`: names, receipts, attribution events), the list filter (`ExpenseFilter`) with each filter's rule for the live list (SQL) and the historical one (saved revisions), the expense row's fields (`EXPENSE_FIELDS`), the newest-first orders of expense lists with their page keys (`EXPENSE_ORDERS`), and the receipt rows and states.
- `activity.ts`: the activity writer, the snapshots, the access-change text, attribution and the system actor.
- `balances.ts`: what a balance counts (`ledgerParts`), group balances, the caller's nets and totals across groups, and balances at a recorded change.
- `invitations.ts`: invitation tokens, expiry, creation, revocation, and when an invitation is open or usable.
- `people.ts`: display names (`participantsJson` lists a group's people in every current view) and the contacts a caller may add to an ungrouped expense.
- `idempotency.ts`, `private-context.ts` and `sql.ts`: idempotency keys, the private write rules, and small SQL helpers.

The platform around them:

- `calls.ts`: the one call runner of RPC (`rpc.ts`) and MCP (`mcp/server.ts`). `runRead` reads on the request's connection. `runWrite` takes the fair-use write budget, then runs one SERIALIZABLE transaction with retries and an after-commit list. Both turn every failure into a declared error: a database rule (23514, 23503, 23505) or a date or time that PostgreSQL cannot read (22007, 22008) becomes `Invalid`, anything else is logged and becomes `Unavailable`, whose text never names the cause.
- `auth/`: sessions, Better Auth, API keys, OAuth tokens and agent connections (`oauth-connections.ts`), the owner's first sign-in (`owner-bootstrap.ts`), the MCP challenges, the reader of plain HTTP downloads (`httpReader`) and the one origin rule (`origin.ts`). It depends only on `core/`.
- `mcp/`: the MCP endpoint (`endpoint.ts`, `server.ts`) and the tools in `mcp/tools/`: `defineTool` and the error body (`registry.ts`), the server instructions (`instructions.ts`), and the tools, listed once in `index.ts`. A tool is a thin adapter: it decodes v1's argument names with schemas from the contract and the limits (`tools/inputs.ts`), calls the same service as the RPC handler, and maps the result with `tools/wire.ts`, the one module of output schemas and wire mappers. When an agent needs a filter or a field, add it to the service; a tool has no SQL of its own, and a tool file imports no other tool file.
- The plain HTTP routes that `main/app.ts` serves: `receipt-routes.ts` and `export-routes.ts`. Their paths, and every link to them, come from `src/shared/paths.ts`, which builds and matches each path outside the SPA's routes (the RPC and auth endpoints, receipts, upload targets, group downloads, invitation links, robots.txt and the sitemap). Its `SERVER_PATHS` is the list that Vite's dev proxy sends to the server, so a new server path outside `/api/` goes there too. `headers.ts`, `public-pages.ts`, `perf.ts` and `maintenance.ts` hold the response headers, robots.txt, the sitemap and health checks, the performance headers and the maintenance answer.

## Client modules

The client reaches the server only through `rpc()` (`src/client/rpc.ts`), which rejects with an `RpcError`: a declared error of the contract, or an `RpcFailure` when no declared answer came back. Use these modules instead of writing their logic again:

- `queries/keys.ts`: every query key, and `afterWrite({ scope, groupId })`, the one rule for what a write makes stale. A group's keys start with its ID, never its URL slug, so one write refreshes the group's pages, the dashboard, the directory and the `/expenses` pages. `scope: 'account'` (the display name, a receipt deleted for good) refreshes everything, and `scope: 'left'` drops a group the caller left. `reloadEntry` reads one entry again after a revision conflict. Never call `invalidateQueries` or `removeQueries` outside `keys.ts`.
- Group pages read the group's ID from the route context (`Route.useRouteContext().groupId`), which `routes/$group.tsx` resolves from the URL segment; the URL segment (`params.group`) is only for links.
- `errors.ts`: `describeError`, the one text for a failed call, from the error table in `src/shared/errors.ts`.
- `components/entry-write.ts`: saving and deleting an expense or a payment. A target (`useGroupTarget`, `usePageTarget`, or one with its own `save`) says where the entry lives and where the form goes afterwards; the hook keeps one idempotency key per draft and treats a failed create whose entry exists as already saved. `useOpenedEntry` keeps the saved entry as the editor opened it: a refetch never replaces an open draft, so a save after someone else's change answers with the conflict text, and only "Load the latest version" opens the newer revision. Group settings on the Settings tab follow the same rule.
- `components/expense-row/` (the one expense row, its figures and attribution line), `components/attribution.tsx` (who added and last edited an entry, above both editors), `components/balance/` (net labels and tones, the totals, the balance chart and the settlement lists), `components/log/` (the revision panel and the expense log), and `editor-link.ts` (the typed link to an entry's editor).
- `dates.ts` (the viewer's calendar day, the formatters, the first day of the week; the UTC day is `todayUtc` in `src/shared/dates.ts`), `search.ts` (search-param parsers for `validateSearch`), `queries/session.ts` (`meQuery`, `requireSignedIn`, `signOut`), `theme.ts` (the typed side of `public/theme.js`, which stores the theme and applies it before the first paint) and `hooks.ts` (`useDebounced`, `useInfiniteScroll`).
- `ui/`: the UI kit, including `CurrencySelect`, `ChoiceSelect` (a select of fixed choices that returns its typed value), `Segmented`, `CopyButton` and `DisclosureSummary`. Confirm a destructive action with `components/delete-dialog.tsx`, never `window.confirm`.
- A route's own parts sit beside it in files that start with `-`, such as `routes/$group/-stats-dialog.tsx`; the router ignores them.

## Rules

### Correctness

- Every write runs through `runWrite` in `src/server/calls.ts` (`write` on RPC, a `write` tool on MCP) and takes an `idempotencyKey`. Every edit or delete takes `expectedRevision` and throws `Conflict` on a mismatch.
- Every change to a group or an expense writes its activity row in the same transaction, through `recordExpenseEvent` or `recordGroupEvent` in `src/server/activity.ts`. That module also owns the snapshots (`schemaVersion: 2`, checked with `satisfies` against the readers in `src/shared/snapshots.ts`), the access-change text and the system actor.
- Money is minor units (`bigint`) inside, exact decimal strings outside. Use `minorOrNull`, `formatMinor`, `resolveShares` and `validateExpense`. Never use floats for money.
- Value lists (kinds, split modes, recurrences, roles, group kinds, activity types and sources, upload states, receipt types, and v1's names for them) live only in `src/shared/vocabulary.ts`. Every limit (field lengths, people per group, page sizes, times, rates and the fair-use limits) lives only in `src/shared/limits.ts`. The contract, the Drizzle enums and CHECKs, the MCP schemas and descriptions, the rule messages and the client derive from these two modules; `test/db/database-rules.test.ts` compares the database's CHECKs with them. A new list or limit goes there, not into a schema.
- Expense dates are `YYYY-MM-DD` strings. Times are `timestamptz` and ISO strings in the API.
- The membership check happens on the server for every read and write, through `src/server/core/access.ts`: `requireMember`, or `memberCte` as the first CTE of the same statement, and `myMemberships` for a read across groups. Both resolve a group reference with `agentsplit_group_id` (an ID, a current slug in any case, or a retired slug), so never match `id` or `slug` by hand. Pass a reference that a caller sent through `groupIdOfInput` or `groupRef`.
- The database triggers and CHECKs are the last line of defense. Never disable them. A migration may replace a rule only with one that refuses at least as much, or with one that lets through what an owner decision allows (as 0017 and 0019 do for a refund split by amount), and may drop a rule only when what it protects is gone; DECISIONS.md section H records each such change.

### Speed

The Workers Free CPU limit no longer applies (DECISIONS.md, "Hosting changes to Coolify"), but the rules stay: they keep the pages fast on one small host.

- One SQL statement per screen read where possible. Let PostgreSQL build nested results as JSON (`json_agg`, `json_build_object`), with minor units as text. Read expenses with `expenseColumns` and `toExpense` from `src/server/expense-read.ts`, the one expense read model; see `getGroup` and `listExpenses` in `src/server/ledger.ts`.
- Do not call Better Auth on the RPC path. The session is already resolved by the middleware.
- Load large libraries only where they are needed, with a dynamic `import()`.
- Keep the client fast: route-level code splitting (automatic), data preloaded on hover (`defaultPreload: 'intent'`), and no full page loads inside the app.
- Never import `effect` at runtime in `src/client/`, directly or through `src/shared`: the modules the client imports (`vocabulary`, `limits`, `errors`, `dates`, `minor`, `split`, `expense-rules`, `history`, `stats`, `groups`, `account`, `ids`, `currencies`, `mcp`, `paths`) stay Effect-free, and the Schema parts live beside them (`money.ts`, `snapshots.ts`, `api/`). Use `import type` from the contract, and call the server through `rpc()` from `src/client/rpc.ts`. Route options (`validateSearch`, `beforeLoad`) stay in the main chunk, so keep them free of large libraries. Contract outputs must be JSON-identical (no `Date` or `bigint` transforms); `src/client/rpc.ts` checks this at compile time. CI fails when the up-front JavaScript exceeds 150 KB gzip, or when any client chunk, a lazy route's included, holds Effect's runtime (`scripts/check-bundle.ts`).

### Behavior

- Parity with v1 or better, as PARITY.md lists, with the changes in DECISIONS.md. Port screens from v1's code, which Git keeps in the commit before the move of v2 to the root (`git show 746ec00^:src/app/<path>`, and `src/components`): the same fields, labels, order, empty states and access rules.
- English only. Use the English text of v1's `messages/en-US.json` (`git show 746ec00^:messages/en-US.json`) for screens that v1 translates.
- Use the UI kit in `src/client/ui/`, `cn` from `src/client/cn.ts`, and `money()` from `src/client/components/money.ts`. The color, radius and font tokens and the Tailwind theme that reads them live together in `src/client/styles.css`; there is no Tailwind config file.
- Group pages render inside the shared layout in `src/client/routes/$group.tsx`. Never recreate the balance rail in a tab.

### Code

- The strictest TypeScript settings; no `any`, and no `unknown` without a reason in a comment. Named object parameters for functions with more than one argument.
- Match the surrounding style. Comments explain why, in short sentences.
- Commit each finished change with a message that says what changed and why. Do not add AI attribution.

## What only the lead does

Deploying, anything on Coolify or the Oracle host, Cloudflare or GitHub settings, production, and merging branches.
