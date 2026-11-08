# AgentSplit

Self-hosted shared expenses for people and their agents.

AgentSplit is a fork of [Spliit](https://github.com/spliit-app/spliit). People sign in with Google and keep private groups. Each group has expenses, payments, balances per currency, recurring expenses, receipts, statistics, an activity history and CSV or JSON exports. Expenses without a group are private to the people in them. An expense can have several payers. Agents use the same ledger through the [MCP API](MCP.md).

- [MCP.md](MCP.md): the agent API.
- [AUTH.md](AUTH.md): sign-in, API keys and OAuth.
- [DEPLOYMENT.md](DEPLOYMENT.md): production on the NixOS host, deploys, backups, and the Coolify stack kept for a rollback.
- [PRIVACY.md](PRIVACY.md): what is stored, where, and who can see it.

## Repository layout

The app is a rewrite (v2) of the Next.js and Prisma app it replaced in production on 2026-11-05 at 18:00:48 UTC ([docs/history/v2/CUTOVER.md](docs/history/v2/CUTOVER.md)). The old app is in the Git history before the move of v2 to the root.

- `src/shared/`: the value lists (`vocabulary.ts`), every limit (`limits.ts`), the Effect Schema contract (`api/`), and the pure money, split and balance rules.
- `src/server/`: the server. `main/app.ts` routes every request; `main/server.ts` is the Bun process.
- `src/client/`: the React single-page app.
- `db/`: the Drizzle schema, the SQL migrations and the invariant triggers.
- `docs/`: [BUILDING.md](docs/BUILDING.md), the guide to changing the app, and [history/](docs/history/README.md), the record of how v2 was planned and checked against the old app.

## Stack

- Bun runs the server (`Bun.serve`), the build and the scripts. Bun's S3 client reads and writes receipts. Vitest and Playwright run on Node, so the unit and database tests run the server code on Node; the end-to-end tests run the built server on Bun.
- Effect RPC (`/api/rpc`) connects the client to the server, with Effect Schema as the shared contract.
- TanStack Router and TanStack Query run the client, built with Vite and React.
- Drizzle and PostgreSQL 18 store the ledger. Money is integer minor units. Database triggers check that shares and payers add up to the amount and that history stays append-only.
- An S3 bucket stores the receipts: Cloudflare R2 in production, Garage in the end-to-end tests. The app serves them only through `/api/receipts`, which checks access on every request. With `RECEIPT_DOWNLOADS=redirect` it then redirects to a presigned storage URL (DEPLOYMENT.md).
- Better Auth handles Google sign-in, API keys and the OAuth provider for agents.

## Develop

You need Linux (x86_64 or aarch64) with [Nix](https://nixos.org/download/) and flakes. The dev shell of `flake.nix` holds Bun, Node.js, PostgreSQL 18 and Chromium. It does not build on macOS, because nixpkgs has no Chromium for macOS. The end-to-end tests also need Docker or Podman, which run Garage.

From a fresh clone:

```sh
nix develop                     # or use direnv: direnv allow
bun install --frozen-lockfile
db-start                        # PostgreSQL 18 on 127.0.0.1:5437, data in .pg/
bun run build                   # also generates the route tree that the type check needs
bun run check-types
bun run test                    # makes its own test database, agentsplit_test
./scripts/e2e.sh                # needs Docker or Podman
db-stop
```

[docs/BUILDING.md](docs/BUILDING.md) holds the commands (install, build, type check, tests, end-to-end tests, image, migrations), the local database, the dev server with synthetic sign-in, and the rules for adding to the app. Every command runs inside the flake's dev shell (`nix develop`, or `direnv exec .`). Use synthetic data only. Never copy the production backups.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says. Do not open a public issue for it.

## License

MIT, see [LICENSE](./LICENSE). Spliit's attribution and license are kept.
