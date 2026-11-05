# Building AgentSplit v2

This guide is for every person or agent who adds to v2. Read [PLAN.md](PLAN.md), [DESIGN.md](DESIGN.md) and [DECISIONS.md](DECISIONS.md) first. The parity checklist is [PARITY.md](PARITY.md).

## Commands

Run every command inside the dev shell, from `v2/`: `direnv exec .. <command>`.

| Task | Command |
| --- | --- |
| Type check | `bun run check-types` |
| Unit and database tests | `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_test_<area> bun run test` |
| Production build (client, server bundle, migrations) | `bun run build` |
| Bundle budget | `bun scripts/check-bundle.ts` (after the build) |
| Dev server | `bun run dev:server` with `PORT=<api-port>`, and `API_PORT=<api-port> bunx vite dev --port <port> --strictPort` |
| End-to-end tests, built server | `./scripts/e2e.sh` |
| End-to-end tests, the image and the Coolify stack | `./scripts/e2e.sh --compose` |
| Image | `docker build -t agentsplit-v2 .` |
| Apply migrations locally | `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/<db> bun db/migrate.ts` |
| New SQL migration | `bunx drizzle-kit generate --name <name>`, or `--custom` for triggers |

## Local database

- One PostgreSQL 18 server runs for the whole machine at `127.0.0.1:5437`, started from the main checkout (`~/projects/agentsplit`). Do not run `db-start` in a worktree: a second server would fight for the port. If it is not running, report that.
- Use your own database names, so parallel work does not collide: `agentsplit_test_<area>` for tests (the name must contain `test`) and `agentsplit_dev_<area>` for a dev server.
- `db-reset <name>` drops and recreates a database whose name contains `test`, `e2e`, `perf` or `dev`.
- Never touch `agentsplit_dev`, `agentsplit_restore_test` or `agentsplit_import_test`; the lead uses them.
- The dev server is two processes: Vite serves the client and sends the server's paths (`/api/`, `/.well-known/`, the exports) to `bun run dev:server` on `API_PORT`. Bun reads `v2/.env.local` (it is gitignored). Put the dev settings there: `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area>`, `PORT=<api-port>`, `BASE_URL=http://localhost:<vite-port>`, `BETTER_AUTH_SECRET` (a random 64-character hex string), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (any placeholders), and the S3 settings of a local Garage (`S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET`). `scripts/e2e.sh` shows how to start one Garage from the compose file.
- The end-to-end tests start Garage (and, with `--compose`, the app image and PostgreSQL 18) through `docker-compose` on the Podman socket. Each run uses new test-only secrets and removes its containers and volumes.
- To sign in on a dev server without Google, insert a `session` row for a synthetic user and set the cookie `better-auth.session_token=<token>.<signature>`, signed with `serializeSignedCookie` from `better-call` and the dev `BETTER_AUTH_SECRET` (see `test/db/session.test.ts`).
- Use synthetic data only (`scripts/seed-synthetic.ts`, or your own test fixtures). Never copy the production backups.

## Adding an area

Each area owns its own files, so areas can be built in parallel:

1. **Contract:** `src/shared/api/<area>.ts` defines an `RpcGroup` of the area's procedures with Effect Schema payloads, outputs and errors. Reuse `Id`, `IdempotencyKey`, `CalendarDate`, `ReadError`, `WriteError` and the error classes from `src/shared/api/core.ts`. Outputs use `DecimalOutput` and plain strings; inputs use the checked `DecimalString` and `CalendarDate`.
2. **Register the contract:** add the group to the `CoreApi.merge(...)` call in `src/shared/api.ts` and re-export it. This is a one-line edit.
3. **Domain service:** `src/server/<area>.ts` holds the functions. Each takes `(db, { principal, ... })`, checks access itself, and throws the shared domain errors (`Forbidden`, `NotFound`, `Conflict`, `Invalid`).
4. **Handlers:** `src/server/handlers/<area>.ts` exports a layer of `Api.toLayerHandler(tag, ...)` calls built with `read` and `write` from `src/server/rpc.ts`. Add it to `Layer.mergeAll` in `src/server/handlers.ts` (a one-line edit).
5. **Client:** queries in `src/client/queries/<area>.ts` (`queryOptions` and `infiniteQueryOptions`), screens as TanStack Router file routes under `src/client/routes/`. Replace the placeholder route of your screen.
6. **Tests:** `test/db/<area>.test.ts` for services against a real database, and `test/legacy/<area>.test.ts` for differential tests against the current app's code in `../src`.
7. **Parity record:** `docs/v2/parity/<area>.md` lists every PARITY.md item you covered, with the test that proves it, and every item you could not cover, with the reason.

## Rules

### Correctness

- Every write runs through `write` (one SERIALIZABLE transaction) and takes an `idempotencyKey`. Every edit or delete takes `expectedRevision` and throws `Conflict` on a mismatch.
- Every change to a group or an expense writes its activity row in the same transaction. Expense revisions need their snapshot (`schemaVersion: 2`).
- Money is minor units (`bigint`) inside, exact decimal strings outside. Use `parseMinor`, `formatMinor`, `resolveShares` and `validateExpense`. Never use floats for money.
- Expense dates are `YYYY-MM-DD` strings. Times are `timestamptz` and ISO strings in the API.
- The membership check happens on the server for every read and write: `requireMember`, or a membership CTE in the same statement.
- The database triggers are the last line of defense. Never disable them, and never write migrations that weaken them.

### Speed

The Workers Free CPU limit no longer applies (DECISIONS.md, "Hosting changes to Coolify"), but the rules stay: they keep the pages fast on one small host.

- One SQL statement per screen read where possible. Let PostgreSQL build nested results as JSON (`json_agg`, `json_build_object`), with minor units as text. See `getGroup` and `selectExpenses` in `src/server/ledger.ts`.
- Do not call Better Auth on the RPC path. The session is already resolved by the middleware.
- Load large libraries only where they are needed, with a dynamic `import()`.
- Keep the client fast: route-level code splitting (automatic), data preloaded on hover (`defaultPreload: 'intent'`), and no full page loads inside the app.
- Never import `effect` at runtime in `src/client/`: use `import type` from the contract, and call the server through `rpc()` from `src/client/rpc.ts`. Route options (`validateSearch`, `beforeLoad`) stay in the main chunk, so keep them free of large libraries. Contract outputs must be JSON-identical (no `Date` or `bigint` transforms); `src/client/rpc.ts` checks this at compile time. CI fails when the up-front JavaScript exceeds 150 KB gzip (`scripts/check-bundle.ts`).

### Behavior

- Parity with the current app or better, as PARITY.md lists, with the changes in DECISIONS.md. Port screens from the current app's code in `../src/app` and `../src/components`: the same fields, labels, order, empty states and access rules.
- English only. Use the English text from `../messages/en-US.json` for screens that the current app translates.
- Use the UI kit in `src/client/ui/`, `cn` from `src/client/cn.ts`, and `money()` from `src/client/components/money.ts`.
- Group pages render inside the shared layout in `src/client/routes/$group.tsx`. Never recreate the balance rail in a tab.

### Code

- The strictest TypeScript settings; no `any`, and no `unknown` without a reason in a comment. Named object parameters for functions with more than one argument.
- Match the surrounding style. Comments explain why, in short sentences.
- Commit each finished change with a message that says what changed and why. Do not add AI attribution.

## What only the lead does

Deploying, anything on Coolify, the Oracle host or `apps-pg`, Cloudflare or GitHub settings, production, and merging branches.
