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
