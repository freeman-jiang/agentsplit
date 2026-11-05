# AgentSplit v2 design

This document records the design decisions for v2 and the reasons for them. The plan and the approval gates are in [PLAN.md](PLAN.md).

## Layout

- v2 lives in `v2/` until cutover. The current app stays in the repository root on the same branch, so that the importer and the parity tests can run the current code for comparison. At cutover, the current app is removed and v2 moves to the root.
- `v2/src/shared/`: the Effect Schema contract and the pure domain rules (money, splits, balances). The client and the server both import it.
- `v2/src/server/`: the server. One `fetch` handler in `app.ts` serves `/api/rpc`, `/api/auth/*`, `/api/mcp`, `/api/receipts/*`, `/.well-known/*`, the exports, and the static files with the SPA page. See "Runtime" below.
- `v2/src/client/`: the React SPA with TanStack Router.
- `v2/db/`: the Drizzle schema, the SQL migrations, and the invariant triggers.
- `v2/test/legacy/`: tests that compare v2 with the current code in `../src`. They are excluded from the strict type check and are removed with the current app.

## Runtime

v2 runs on Coolify on the Oracle host, as the current app does (DECISIONS.md, "Hosting changes to Coolify"). `compose.v2.coolify.yaml` at the repository root builds `v2/Dockerfile`.

- **Bun, not Node.** `Bun.serve` takes the web `Request` and gives back the web `Response` that the handler already uses, so the Worker's handler runs without an adapter. Bun also has an S3 client built in, so storage needs no package. The dev shell, the tests and the image use the same Bun version.
- **One code path.** `src/server/app.ts` holds the routing and calls the domain code. It reaches the platform only through its `Platform` argument: the settings, one pooled database connection, the bucket, and the static files. `src/server/server.ts` is the platform: it reads the environment, opens the pool, starts the server and the hourly job, and stops them on SIGTERM.
- **Database.** One `pg.Pool` for the process (`DATABASE_URL`, at most `DATABASE_POOL_SIZE` connections, default 10). Each request takes one connection and returns it after its response body is complete, as the Worker did with one connection per request. The RPC middleware finds the connection through the request ID header, as before. A request that throws closes its connection instead of returning it to the pool, so a connection with an open transaction is never reused.
- **Receipts.** `src/server/bucket.ts` is the small bucket surface that receipts and agent uploads use: `get` with an optional byte range, `put` from bytes or a stream, and `delete`. `src/server/s3.ts` implements it on Garage's S3 API with Bun's `S3Client` (region `garage`, path-style URLs). A streamed body larger than one part goes up as a multipart upload. v2 reads the current app's receipts in place: the bucket and the keys are the same, and `receiptKey` derives the key from both URL forms.
- **Static files.** `src/server/assets.ts` reads `dist/client` into memory at start. Files under `/assets/` have hashed names and are cached for a year (`immutable`). Every other file and the SPA page are `no-cache` with an ETag, so a deploy reaches every browser on its next load. A path that is not a file gets the SPA page, as the Workers asset server did; a missing file under `/assets/` is a 404, so an old page gets an error instead of HTML for a removed chunk. The build writes `.br` and `.gz` copies, and the server picks one from `Accept-Encoding`. Every response gets the security headers from `secured()`.
- **Public URL.** Traefik ends TLS, so Bun sees `http` and the container's host. The server gives the app each request at `BASE_URL`'s origin, as on Workers, because DPoP proofs sign the URL that the client used.
- **Hourly job.** `src/server/hourly.ts` runs `scheduled` at minute 7 of each hour (the Worker's cron, `7 * * * *`), one run at a time. A run that is still going when the next hour starts makes that hour skip. The job is safe to run twice: each occurrence is one SERIALIZABLE transaction.
- **Migrations.** The image sets `MIGRATIONS_DIR`, so each start applies new migrations before it takes requests, as the current app's container runs `prisma migrate deploy`.
- **Shutdown.** On SIGTERM the server stops taking new connections, lets running requests and the hourly job finish, closes the pool, and exits. Compose gives it 30 seconds; the server exits on its own after 25.
- **Image.** A build stage with the locked dependencies runs `bun run build`. The final stage is Bun's distroless image with only `dist/`: the server is one bundle, so it has no `node_modules`. It runs as the non-root user 65532. Both images are pinned by the digest of their multi-arch index. A Nix-built image would need Nix inside Coolify's Docker build or a registry and a separate push, so the deploy would stop being a plain build from the repository.

## Money

- Every amount is an integer count of minor units (`bigint`). The currency registry in `src/shared/currencies.ts` is generated from the current app's data, so the decimal places of each currency are the same.
- The API accepts and returns exact decimal strings. `parseMinor` rejects more decimals than the currency allows.
- Splits use the current app's rule, ported to integers in `src/shared/split.ts`: each part is floored, and the leftover units go first to the payer, then by largest remainder, then by position. Participants are ordered by ID with the JavaScript `<` comparison, as in the current app. An amount split whose parts do not add up to the total falls back to a proportional split, as in the current app.
- With multiple payers, the leftover unit goes to the payer who paid the most, then to the smallest ID. With one payer this is the current rule.
- `test/legacy/differential.test.ts` runs the current app's `getExpenseShares` and `getSuggestedReimbursements` on random expenses and requires identical results.

## Data model

- Each expense stores both the split input (mode and per-person weights, for editing) and the resolved parts in minor units (`expense_shares.amount`). Payers are rows in `expense_payers`, so one expense can have several payers.
- Deferred constraint triggers check at commit that, for every live expense, the payers and the shares each sum exactly to the amount, and that every participant belongs to the expense's group.
- History is append-only, as in the current app: `activities` rejects updates, deletes and truncation, expenses are never hard-deleted, and every expense revision must have a matching activity with its snapshot in the same transaction.
- `expenses.updated_at` is the time of the latest revision. It supports the "recently edited or added" ordering.
- Times are `timestamptz`. Expense dates are `date`. The local database runs in UTC, as production does.

## Auth and agents

- Better Auth keeps its current plugin set: Google sign-in, JWT, the MCP OAuth provider with dynamic client registration and CIMD, and API keys. The table columns stay compatible, so the importer copies users, accounts, sessions, API keys, OAuth clients, consents and refresh tokens unchanged.
- OAuth tokens are stored as `base64url(sha256(token))`, as in the current `hashOAuthToken`. v2 computes the same hash with WebCrypto, so existing refresh tokens keep working.
- The `Jwks` table holds the signing key, encrypted with `BETTER_AUTH_SECRET`. v2 must use the production secret.
- CIMD needs a metadata fetcher that refuses redirects and special-use addresses. The container can reach the database and Garage on its private network, so v2 uses the current app's Node fetcher from `@better-auth/cimd/node`: every DNS answer must be a public address, and the connection is pinned to the checked address. Bun honors the fetcher's `lookup` pin. v2 adds a refusal of redirects and limits on the response size and time.

## Findings from the current app

- The speed baseline is in [BASELINE.md](BASELINE.md). Opening an expense is a full page load, and each screen downloads its data again.
- Real data: 2 groups (both USD), 48 expenses (4 in JPY), no amount with more precision than its currency, no repayments. Three deleted expenses imported from Splitwise have even splits with share values other than 1; even splits ignore the values, so they do not change any balance.
