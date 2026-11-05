# Speed baseline of the current app

Measured on 2026-11-05 in the T3 browser, with a signed-in member of the largest real group. The current app ran as a production build (`tooling` branch, `next build` and the standalone server) on the dev box, against a local restore of the production dump. The network was loopback, so the times below are a lower bound: production adds about 100 ms per round trip to Oracle.

## Signed-in screens (cold page load)

| Screen | JS files | JS decoded | Requests | API calls | Last API response |
| --- | --- | --- | --- | --- | --- |
| Dashboard `/` | 14 | 1,342 KB | 37 | 1 batch (3 procedures) | 378 ms |
| Group expenses `/<slug>` | 21 | 1,794 KB | 50 | 1 batch (3 procedures) | 292 ms |
| Expense edit `/<slug>/expenses/<id>/edit` | 21 | 1,841 KB | 43 | 1 batch (4 procedures) | 239 ms |

Production serves 404 KB of compressed JS (16 files) for the signed-out pages alone.

## Findings

1. Opening an expense from the group list is a full page load, not a client-side navigation. The link goes to `/groups/<id>/expenses/<id>/edit` and the page ends at `/<slug>/expenses/<id>/edit`. Every open fetches the document again, renders on the server, and parses about 1.8 MB of JS from the cache.
2. Each screen loads the group and its full balances again, because no client cache is shared between screens.
3. The server is not the bottleneck. Signed-out pages and the health check answer in about 100 ms from Oracle, and the server has a load average of 0.4.

## Budgets for v2

| Measure | Budget |
| --- | --- |
| JS for the signed-in shell, compressed | 150 KB or less; other screens load as separate route chunks |
| Navigation inside the app | Client-side only: no document load after the first page |
| API calls per screen | 1 batched call, or 0 when the client cache already holds the data |
| Open an expense from a list | Form visible within 100 ms of the click on a warm cache (data prefetched on hover or from the list) |
| Worker CPU time per request | p95 under 10 ms (Workers Free limit) |

The v2 measurements repeat the same screens with the same data shape, and add a measurement against the preview Worker over the real network.

## v2 Worker CPU on Workers Free (preview, 2026-11-05)

Measured with `wrangler tail` on the preview Worker, which has 192 synthetic expenses, signed-in, after warm-up. Each request is tagged with `?op=` so the log attributes it exactly. Values are CPU milliseconds.

| Request | p50 | p90 |
| --- | --- | --- |
| `session.me` | 7 | 10 |
| `groups.list` | 10 | 31 |
| `groups.get` (group, people, balances) | 9 | 13 |
| `expenses.list`, 30 rows | 14 | 19 |

What changed the numbers, from the first deploy (75 to 146 ms):

1. One database connection per request instead of two, and the RPC server built once at module scope.
2. The session check without Better Auth: verify the signed cookie and read the session with one query.
3. A minified Worker; Better Auth loads only for `/api/auth/*`.
4. One statement per screen: PostgreSQL returns the group with its people and summed balances, or the expense page with each row's parts, as JSON, with the membership check in the same statement.
5. Output schemas without per-field pattern checks.

The floor is about 4 ms for connecting and one query, plus about 3 ms for Effect RPC. Each row of a list adds about 0.15 ms. Cold isolates still reach 30 to 50 ms. Freeman chose to stay on Workers Free (2026-11-05), so the next steps are fewer queries per request and a full profile once every screen exists.

## v2 client bundle (2026-11-05)

The JavaScript every page loads up front is 124.9 KB gzip (budget 150 KB): the entry chunk (93.4 KB, mostly React DOM) and the router and query chunk (30.9 KB). Effect does not ship to the browser; the client calls the Effect RPC endpoint with a small fetch client. Before that change the shell was about 180 KB, of which 85 KB was Effect's client runtime. CI enforces the budget with `scripts/check-bundle.ts`.

## v2 Worker CPU after the groups, feed and account merges (preview, 2026-11-05)

Same method as above (`wrangler tail`, `?op=` tags, after warm-up, 192 synthetic expenses). CPU milliseconds:

| Request | p50 | p90 |
| --- | --- | --- |
| `feed.list`, 30 rows | 13 | 20 |
| `feed.balances` | 10 | 16 |
| `groups.directory` | 9 | 14 |
| `groups.details` | 12 | 19 |
| `groups.get` | 10 | 17 |
| `expenses.list`, 30 rows | 14 | 29 |

Several reads are a few milliseconds over the 10 ms budget at p50. A final CPU pass follows once every area is merged.

## v2 MCP endpoint CPU (preview, 2026-11-05)

Same method, with an API key for the synthetic account. Each row stops at a later phase, so the differences show what each phase costs. CPU milliseconds:

| Request | p50 | p90 |
| --- | --- | --- |
| `/api/health`, no database | 3 | 4 |
| `/api/mcp` without credentials (401, the MCP module loads) | 4 | 5 |
| `ping`: connect, API key, rate limit, SDK | 12 | 19 |
| `tools/list` | 13 | 15 |
| `list_groups` | 17 | 22 |
| `list_expenses`, 20 rows | 21 | 43 |

All 69 requests answered `ok`, but 31 used more than 10 ms. Authentication makes five queries before a tool runs: the key lookup, two key updates, the user lookup and the MCP rate-limit upsert. Locally each phase takes under 1 ms once the JIT is warm, so the Workers cost comes from cold module and JIT work and from each query's pg and Drizzle work. The final CPU pass starts by folding those queries into fewer statements.

After folding the API-key queries (the user lookup joins the key lookup, and the rate-limit update sets `updatedAt`), a request makes three statements before the tool instead of five. The same requests, warm isolates:

| Request | p50 | p90 |
| --- | --- | --- |
| `ping` | 8 | 12 |
| `list_groups` | 9 | 15 |
| `list_expenses`, 20 rows | 13 | 18 |

`list_expenses` is still over the budget at p50. Its read is the next step of the CPU pass.
