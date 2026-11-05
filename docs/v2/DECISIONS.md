# v2 decisions on the parity QUESTION items

[PARITY.md](PARITY.md) marks 105 items with `QUESTION:`: current behavior that looks like a bug or is doubtful. The plan allows no regressions, and a deliberate change needs Freeman's approval. This document groups the items, gives a recommendation for each group, and records the decision.

## Decisions (Freeman, 2026-11-05)

- Groups B, C, E and G: approved as recommended. Group D: keep as recommended.
- P-BAL-93, payments: **keep the server permissive.** Negative amounts stay allowed for expenses and payments, and a payment may involve several people. The ledger must model every money scenario: one person pays and the others owe them, or one person receives money (a refund or a reward) and everyone, possibly including them, shares it.
- Group F, translations: **English only.** v2 does not port the locale files.
- Hosting: **stay on Workers Free** and keep each request within the CPU budget.
- P-FEED-19 (lead, under the approval of group C): "involving me" defaults to true in the UI and in the API, so agents see what people see. The MCP tool description states the default.
- P-EXP-20 (Freeman, 2026-11-05): refetch on every visit, as the current app does, instead of a 30-second cache. A screen shows the data the tab already holds at once and replaces it with the fresh answer when it arrives.
- MCP group currency (Freeman, 2026-11-05): `create_group` and `update_group` refuse a currency symbol that several currencies use, such as "$", and ask the agent for `currencyCode`. A symbol that only one currency uses still works.
- MCP on the preview (Freeman, 2026-11-05): hold the MCP tools off the preview until receipt uploads are merged. The preview was rolled back from 5b9dfec8 to d5e6efaf, which serves the first 7 tools. The next preview deploy includes uploads.
- Production test group (Freeman, 2026-11-05): one persistent group, AgentSplit test, with only Freeman in it, for every production smoke check now and later. Checks never write in a household group.
- Workers Free CPU (Freeman, 2026-11-05): accept the current cost and cut over on Workers Free. Reads cost about 8 ms of CPU before their rows; pages of 30 expenses sit near 13 ms at p50 (BASELINE.md). After the cutover, watch the Worker's errors and CPU, and serve the hottest reads through plain JSON routes instead of Effect RPC only if errors appear.
- Payments store category 1 (Payment) on every path (P-BAL-92, approved in group C).
- Revision snapshots record the expense's receipts, so history shows them (history area question 1).
- Retries of a private-expense create or an invitation renewal return Conflict or `url: null` instead of a stored result, because the response holds a secret link that is never stored. An agent renews the invitation to get a new link.

## A. Decided by PLAN.md (no further approval needed)

The plan's invariants require these changes. v2 already implements most of them.

- Money and dates: integer minor units (P-DB-32), a complete conversion or none (P-DB-35), payer and share sums checked by the database (P-DB-36), precision fixed by the integer type (P-DB-37), `timestamptz` (P-DB-145), calendar `date` for recurrence (P-DB-66), a non-null recurrence (P-DB-46), a role limited to admin or member (P-DB-95), and UTC on every server (P-DB-144).
- History stays permanent; no migration disables history triggers (P-DB-131). Only the importer writes revision 0 rows (P-DB-15). An expense never moves between groups (P-DB-09; enforced by the revision trigger).
- The signing keys are imported with the production secret (P-DB-128).
- Stale tests and docs are corrected, not ported (P-MCP-173, P-MCP-174, P-MCP-175). `postinstall` no longer migrates (P-PWA-48).
- Authorize keeps redirecting only real browser navigations (P-MCP-118). Edits and deletes keep requiring `expectedRevision` (P-HIST-24).
- The MCP rate limiter must work across Worker isolates (P-MCP-85): v2 stores it in PostgreSQL, as Better Auth's own limiter does.

## B. Security and privacy fixes (recommended: fix)

| Item | Today | v2 |
| --- | --- | --- |
| P-AUTH-55 | The sign-in `next` check accepts `/\evil.example` | The server validates `next` as a same-origin path |
| P-PWA-28 | Readiness sends raw database errors to anyone | A generic message; the details go to the log |
| P-PWA-17 | CSP allows `unsafe-inline` and `unsafe-eval` scripts | No inline or eval scripts (the SPA does not need them) |
| P-PWA-56 | A bad locale cookie breaks every page | Unknown locales fall back to English |
| P-EXPORT-14, P-ACCESS-30 | The JSON export and the group log contain user IDs, connection IDs and invitee emails | Export names and roles only; the log says "Invitation created" without the email |
| P-MCP-41, P-TOOL-CREATEEXP-14 | An access denial or a reused expense ID is reported as an unknown outcome | Forbidden and Conflict, with a certain outcome |
| P-MCP-79 | Two different 401 challenge formats | Always the format with `resource_metadata` |

## C. Bugs and broken interactions (recommended: fix)

- Sign-in loses the requested page, including invitations (P-AUTH-49, P-ACCESS-33). A signed-in visit to `/sign-in` shows the login form (P-AUTH-58).
- Access denied gives no message (P-GROUP-21). Non-admins see an edit button with no form (P-GROUP-58). Removing a participant who is in an expense gives a raw database error to API callers (P-GROUP-76).
- `/Maple` does not resolve, and an old slug breaks at once after a rename (P-GROUP-105, P-GROUP-106). v2 matches slugs case-insensitively and redirects old slugs.
- A failed save or delete shows no message, and a revision conflict looks like any other failure (P-EXP-52, P-EXP-53). The delete dialog says "irreversible" for a soft delete (P-EXP-51).
- The amount limit message says "lower than 10,000,000" but accepts 10,000,000 (P-EXP-61, P-MONEY-35): fix the message, keep the limit.
- Lists without a defined order: categories and CSV export (P-EXP-102, P-EXPORT-29). An unknown category gives a 500 (P-EXP-103).
- Reading balances or expense lists creates due recurring expenses in every group (P-BAL-30, P-RECUR-08). v2 creates them from a scheduled job, and reads never write.
- Monthly recurrence drifts after a short month (P-RECUR-07): keep the original day of the month. Recurrence edits use the old date and can conflict (P-RECUR-20, P-RECUR-21).
- The feed's "involving me" default differs between the UI and MCP (P-FEED-19). A private context ID as a filter returns nothing (P-FEED-18, P-TOOL-LISTALL-08).
- Payments open the expense form from the log (P-HIST-70). Two paths store different categories for payments (P-BAL-92). Expired private invitations stay listed (P-ACCESS-28). The two balance totals can differ (P-BAL-106). The two spending charts use different month ranges (P-STATS-36).
- `joined: true` is returned for actions that are not joins (P-TOOL-ACCESS-28). Group edits have no database audit guarantee (P-DB-73). Several references have no foreign keys (P-DB-61, P-DB-65, P-DB-93, P-DB-117, P-DB-127).

## D. Behavior to keep (recommended: keep, for parity)

- HUF, IDR and COP keep 0 decimals, and CHF keeps 0.01 rounding (P-MONEY-14, P-MONEY-17). Changing either changes how amounts are entered, and no real data uses them.
- The payer receives the leftover cent, whatever their weight (P-MONEY-66).
- Negative amounts stay allowed: real data has a -150.00 reward (P-DB-38). An even split with zero total weight exists only in legacy rows (P-MONEY-57).
- The `paid`/`paidFor` meaning in balance outputs stays as it is, because agents already depend on it (P-BAL-25, P-TOOL-BALANCES-05).
- Payments with several people or a negative amount stay allowed on the server (P-BAL-93; decided above).

## E. Dead code (recommended: do not port)

The recent-groups list in localStorage (P-GROUP-20), the hidden share-URL and QR features (P-GROUP-22), the receipt extraction button that is always refused (P-EXP-02, P-RECEIPT-51), the unused float currency conversion (P-MONEY-33), the legacy grant script (P-MCP-176), and the legacy Spliit import script (P-DB-146).

## F. Translations (needs a decision)

The current app has 35 message files, offers 24 locales, and leaves many screens in English only (P-PWA-50, P-PWA-55, P-GROUP-07, P-GROUP-91, P-EXP-03, P-EXP-05, P-EXP-54, P-BAL-64, P-MCP-172). Options:

1. Keep the 24 selectable locales where the current app translates them, and leave the English-only screens in English (parity).
2. English only (a regression for any user on another locale).
3. Translate every screen into the 24 locales (more than parity; machine translation needs review).

Decision: option 2, English only.

## G. Minor wording and leftovers (recommended: fix as part of the rewrite)

P-AUTH-03 (client errors reported as 503), P-AUTH-30 (bootstrap errors on every session lookup), P-AUTH-61 (stale AUTH.md), P-GROUP-07 and P-GROUP-08 (copy), P-GROUP-19 (link prompt), P-GROUP-50 (untranslated tab label), P-EXP-97 (prefill link), P-HIST-68 and P-HIST-75 (log wording), P-EXPORT-15 (export file name), P-PWA-31 (robots.txt), P-MCP-56 (rate-limit answer is 401 instead of 429), P-MCP-158 (connection order), P-DB-70 (receipt rows immutable by trigger).
