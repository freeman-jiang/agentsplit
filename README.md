# AgentSplit

Self-hosted shared expenses for people and their agents.

AgentSplit is a fork of [Spliit](https://github.com/spliit-app/spliit). People sign in with Google and keep private groups. Each group has expenses, payments, balances per currency, recurring expenses, receipts, statistics, an activity history and CSV or JSON exports. Expenses without a group are private to the people in them. An expense can have several payers. Agents use the same ledger through the [MCP API](MCP.md).

- [MCP.md](MCP.md): the agent API.
- [AUTH.md](AUTH.md): sign-in, API keys and OAuth.
- [DEPLOYMENT.md](DEPLOYMENT.md): production on Coolify, backups and rollback.
- [PRIVACY.md](PRIVACY.md): what is stored, where, and who can see it.

## Repository layout

The app is a rewrite (v2) of the Next.js and Prisma app it replaced in production on 2026-11-05 at 18:00:48 UTC ([docs/v2/CUTOVER.md](docs/v2/CUTOVER.md)). The old app is in the Git history before the move of v2 to the root.

- `src/shared/`: the Effect Schema contract and the pure money, split and balance rules.
- `src/server/`: the server. `app.ts` routes every request; `server.ts` is the Bun process.
- `src/client/`: the React single-page app.
- `db/`: the Drizzle schema, the SQL migrations and the invariant triggers.
- `docs/v2/`: the plan, design, decisions, parity records and the cutover record.

## Stack

- Bun runs the server (`Bun.serve`) and the tests. Bun's S3 client reads and writes receipts.
- Effect RPC (`/api/rpc`) connects the client to the server, with Effect Schema as the shared contract.
- TanStack Router and TanStack Query run the client, built with Vite and React.
- Drizzle and PostgreSQL 18 store the ledger. Money is integer minor units. Database triggers check that shares and payers add up to the amount and that history stays append-only.
- Garage stores the receipts. The app serves them only through `/api/receipts`.
- Better Auth handles Google sign-in, API keys and the OAuth provider for agents.

## Develop

Run each command from the repository root, inside the dev shell (`direnv exec .`).

The dev shell runs one PostgreSQL 18 server for the machine at `127.0.0.1:5437`. Start it from the main checkout (`~/projects/agentsplit`) with `db-start`. Do not start a second server in a worktree.

1. Install the dependencies: `direnv exec . bun install --frozen-lockfile`.
2. Create a dev database: `direnv exec . db-reset agentsplit_dev_<area>`.
3. Apply the migrations: `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area> direnv exec . bun db/migrate.ts`.
4. Write `.env.local` (Git ignores it) with these settings:
   - `DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_dev_<area>`
   - `PORT=<api-port>`
   - `BASE_URL=http://localhost:<vite-port>`
   - `BETTER_AUTH_SECRET`: a random 64-character hex string (`openssl rand -hex 32`).
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: any placeholders.
   - `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_KEY` and `S3_UPLOAD_SECRET`: a local Garage. `scripts/e2e.sh` shows how to start one from the Compose file.
5. Start the API server: `direnv exec . bun run dev:server`.
6. In a second terminal, start Vite: `API_PORT=<api-port> direnv exec . bun run dev -- --port <vite-port> --strictPort`.
7. Open `http://localhost:<vite-port>`.

Vite serves the client and sends `/api/`, `/.well-known/`, `/robots.txt`, `/sitemap.xml` and the export paths to the API server. To sign in without Google, follow "Local database" in [docs/v2/BUILDING.md](docs/v2/BUILDING.md). Use synthetic data only (`scripts/seed-synthetic.ts`). Never copy the production backups.

## Test and build

| Task | Command |
| --- | --- |
| Production build (client, server bundle, migrations) | `direnv exec . bun run build` |
| Bundle budget (after the build) | `direnv exec . bun scripts/check-bundle.ts` |
| Type check (after the build, which generates the route tree) | `direnv exec . bun run check-types` |
| Unit and database tests | `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5437/agentsplit_test_<area> direnv exec . bun run test` |
| End-to-end tests on the built server | `direnv exec . ./scripts/e2e.sh` |
| End-to-end tests on the image and the Coolify stack | `direnv exec . ./scripts/e2e.sh --compose` |
| Image | `docker build -t agentsplit .` |
| New SQL migration | `direnv exec . bunx drizzle-kit generate --name <name>` (add `--custom` for triggers) |

- The test database name must contain `test`. Create it with `direnv exec . db-reset agentsplit_test_<area>`.
- The end-to-end tests start Garage (and, with `--compose`, the image and PostgreSQL 18) through `docker-compose` on the Podman socket. Each run uses new test-only secrets and removes its containers and volumes. Set `E2E_PORT` to run more than one suite at a time.
- The GitHub workflow `.github/workflows/ci.yml` runs the same checks.

The rules for adding to the app are in [docs/v2/BUILDING.md](docs/v2/BUILDING.md).

## License

MIT, see [LICENSE](./LICENSE). Spliit's attribution and license are kept.
