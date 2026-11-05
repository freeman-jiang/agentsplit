# AgentSplit v2 design

This document records the design decisions for v2 and the reasons for them. The plan and the approval gates are in [PLAN.md](PLAN.md).

## Layout

- v2 lives in `v2/` until cutover. The current app stays in the repository root on the same branch, so that the importer and the parity tests can run the current code for comparison. At cutover, the current app is removed and v2 moves to the root.
- `v2/src/shared/`: the Effect Schema contract and the pure domain rules (money, splits, balances). The client and the server both import it.
- `v2/src/server/`: the Worker. One `fetch` handler serves `/api/rpc`, `/api/auth/*`, `/api/mcp`, `/api/receipts/*` and `/.well-known/*`. Static assets and the SPA come from the Workers assets binding.
- `v2/src/client/`: the React SPA with TanStack Router.
- `v2/db/`: the Drizzle schema, the SQL migrations, and the invariant triggers.
- `v2/test/legacy/`: tests that compare v2 with the current code in `../src`. They are excluded from the strict type check and are removed with the current app.

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
- CIMD needs a metadata fetcher that refuses redirects and special-use addresses. The current app uses the Node fetcher from `@better-auth/cimd/node`, which resolves DNS and pins the address. A Worker's `fetch` reaches only the public internet, so the v2 fetcher refuses redirects (`redirect: 'manual'`), rejects IP literals in RFC 6890 special-use ranges, and limits the response size and time.

## Findings from the current app

- The speed baseline is in [BASELINE.md](BASELINE.md). Opening an expense is a full page load, and each screen downloads its data again.
- Real data: 2 groups (both USD), 48 expenses (4 in JPY), no amount with more precision than its currency, no repayments. Three deleted expenses imported from Splitwise have even splits with share values other than 1; even splits ignore the values, so they do not change any balance.
