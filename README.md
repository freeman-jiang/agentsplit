# AgentSplit

Self-hosted shared expenses for people and their agents.

AgentSplit is a fork of [Spliit](https://github.com/spliit-app/spliit). People sign in with Google and keep private groups. Each group has expenses, payments, balances per currency, recurring expenses, receipts, statistics, an activity history and CSV or JSON exports. Expenses without a group are private to the people in them. An expense can have several payers. Agents use the same ledger through the [MCP API](MCP.md).

- [MCP.md](MCP.md): the agent API.
- [AUTH.md](AUTH.md): sign-in, API keys and OAuth.
- [DEPLOYMENT.md](DEPLOYMENT.md): production on Coolify, backups and rollback, and the NixOS host that replaces Coolify.
- [PRIVACY.md](PRIVACY.md): what is stored, where, and who can see it.

## Repository layout

The app is a rewrite (v2) of the Next.js and Prisma app it replaced in production on 2026-11-05 at 18:00:48 UTC ([docs/v2/CUTOVER.md](docs/v2/CUTOVER.md)). The old app is in the Git history before the move of v2 to the root.

- `src/shared/`: the value lists (`vocabulary.ts`), every limit (`limits.ts`), the Effect Schema contract (`api/`), and the pure money, split and balance rules.
- `src/server/`: the server. `main/app.ts` routes every request; `main/server.ts` is the Bun process.
- `src/client/`: the React single-page app.
- `db/`: the Drizzle schema, the SQL migrations and the invariant triggers.
- `docs/v2/`: the plan, design, decisions, parity records and the cutover record.

## Stack

- Bun runs the server (`Bun.serve`), the build and the scripts. Bun's S3 client reads and writes receipts. Vitest and Playwright run on Node, so the unit and database tests run the server code on Node; the end-to-end tests run the built server on Bun.
- Effect RPC (`/api/rpc`) connects the client to the server, with Effect Schema as the shared contract.
- TanStack Router and TanStack Query run the client, built with Vite and React.
- Drizzle and PostgreSQL 18 store the ledger. Money is integer minor units. Database triggers check that shares and payers add up to the amount and that history stays append-only.
- Garage stores the receipts. The app serves them only through `/api/receipts`, which checks access on every request. With `RECEIPT_DOWNLOADS=redirect` it then redirects to a presigned storage URL (DEPLOYMENT.md).
- Better Auth handles Google sign-in, API keys and the OAuth provider for agents.

## Develop

[docs/v2/BUILDING.md](docs/v2/BUILDING.md) holds the commands (install, build, type check, tests, end-to-end tests, image, migrations), the local database, the dev server with synthetic sign-in, and the rules for adding to the app. Every command runs inside the flake's dev shell (`direnv exec .`). Use synthetic data only. Never copy the production backups.

## License

MIT, see [LICENSE](./LICENSE). Spliit's attribution and license are kept.
