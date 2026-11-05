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
