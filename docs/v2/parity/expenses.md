# Parity record: expenses, money, balances, recurring, receipts

This record covers the sections P-EXP, P-MONEY, P-BAL, P-RECUR and P-RECEIPT of [PARITY.md](../PARITY.md). Each item is done (with its proof), changed on purpose (with the decision), or deferred (with the reason and the owner).

Proofs:

- `db`: `v2/test/db/expenses.test.ts` (services against PostgreSQL).
- `ledger`: `v2/test/db/ledger.test.ts`.
- `form`: `v2/test/expense-form-state.test.ts` (form rules).
- `list`: `v2/test/legacy/expense-list.test.ts` (differential against the current app's `expense-row.ts` and `date-groups.ts`).
- `rules`: `v2/test/legacy/expense-rules.test.ts` and `differential.test.ts` (the lead's tests of `src/shared`).
- `recur`: `v2/test/recurrence.test.ts`. `image`: `v2/test/receipt-image.test.ts`.
- `browser`: checked on the dev server (port 5182, synthetic data) on 2026-11-05.

## Decided changes (DECISIONS.md) in this area

| Item | v2 |
| --- | --- |
| P-EXP-51 | The delete dialog says the expense leaves the list and the balances, and the log keeps its history. It no longer says "irreversible". |
| P-EXP-52, P-EXP-53 | A failed save or delete shows a message. A Conflict says that someone changed the expense and offers "Load the latest version". |
| P-EXP-61, P-MONEY-35 | The message says "at most 10,000,000". The limit is unchanged. |
| P-EXP-102 | `categories.list` orders by ID. |
| P-EXP-103 | An unknown category is `Invalid` (field `categoryId`), not a 500. Proof: `db` "refuses a reused expense ID with Conflict and an unknown category with Invalid". |
| P-EXP-124 | A reused expense ID is `Conflict`, a certain outcome (group B). |
| P-BAL-30, P-RECUR-08, P-RECUR-11 | Reads never create recurring expenses. A Workers Cron Trigger (`7 * * * *`) runs `materializeDue`. Proof: `db` "creates every missed month…" checks that list and group reads create nothing. |
| P-BAL-92 | Both payment paths store category 1 (Payment). |
| P-BAL-93 | The server keeps accepting payments with several people or a negative amount. Proof: `db` "accepts a payment shared by several people, and a negative one". |
| P-RECUR-07 | A monthly series keeps its day of the month (Jan 31, Feb 28, Mar 31). New column `recurring_links.anchor_day`. Proof: `recur`, `db`. |
| P-RECUR-20, P-RECUR-21 | A rule or date edit counts from the date being saved. Setting None removes the open link in one step. Proof: `db` "counts an edited rule or date from the saved date…". |
| P-EXP-02, P-EXP-98, P-RECEIPT-45..54 | Not ported: the AI features are off in this deployment (group E, P-RECEIPT-54). |
| P-EXP-97 | Not ported: the legacy `?reimbursement=1` prefill. Every "Record payment" link goes to `/payments/create` (group G). |

## Expenses (P-EXP)

| Items | Status | Proof or reason |
| --- | --- | --- |
| 01 | Done, except the Export button | The Export button belongs to the export area. |
| 03 | Done | Notice with a link to `/$group/edit#members`. `browser` |
| 04, 05, 08, 10 | Done | `browser` |
| 06 | Done | Three skeleton rows while the first page loads (`pendingComponent`). |
| 07 | Done, 30 per page | The list uses the shared `expensesQuery` (30 per page, as before this area). The next page loads when the end of the list scrolls into view. |
| 09 | Done | 300 ms debounce before the search reaches the URL and the query. |
| 11 | Changed (lead's core) | The v2 search also matches notes (`ledger.ts listExpenses`). |
| 12–17 | Done | `list` "date headings" (3,000 random dates and week starts). |
| 18, 19 | Done | `ledger` |
| 20 | Changed | v2 caches lists for 30 s and drops every money query after each write (`invalidateMoney`), instead of refetching on every visit. This keeps screens fast; a write by another person shows after 30 s or a refresh. |
| 21, 23–25, 34, 35 | Done | `browser` |
| 22 | Deferred | The category icon set is not ported yet. |
| 26 | Done | `addedBy`/`editedBy` in the list statement. `db` "names who added and who last edited". |
| 27–33 | Done | `list` "card figures" (2,000 random expenses and payments). v2 also names several payers. |
| 36, 37, 42–46, 48, 50 | Done | `browser` (create, edit, income headings, attribution lines, prefilled edit) |
| 38, 39 | Done | The ID is minted once per visit. A Conflict on create opens the saved expense. |
| 40, 41, 49 | Done, without `returnHref`/`cancelHref` | Save and Cancel go to the expense list. No v2 screen links with a return address yet (the feed area will). |
| 47 | Deferred | The revision log under the form belongs to the history area. |
| 54–62, 69, 78–83 | Done | `validateExpense` with the current app's messages. `form`, `rules`, `browser` |
| 63–68, 70–77 | Done | `browser`, `form`. 70: the payer select, or "Several people paid" for one amount per payer. |
| 84–86 | Done | `form` "auto-fills untyped amounts…" |
| 87–92 | Done | `browser` |
| 93–95 | Done | Same localStorage key and format as the current app, so saved defaults carry over. `form` |
| 96 | Done | `title`, `vendor`, `date`, `amount`, `categoryId`, `currencyCode`. The image parameters are not read, because only the AI receipt flow used them. |
| 99–101 | Done | `db` "lists categories in ID order"; native select grouped by `grouping`. |
| 104, 106 | Done | `validateExpense` trims the vendor; snapshots keep each revision's vendor. |
| 105, 130 | Deferred (MCP area) | Partial edits are an MCP tool feature; the v2 RPC update takes the whole expense. |
| 107 | Deferred (history area) | Log summaries. |
| 108, 112–119 | Lead's core `expenses.list` | The v2 contract has its own filters and cursors; `asOf`/`atActivityId` belong to the history area. |
| 109, 110, 120, 125, 132, 133, 137, 140, 141 | Done | `requireMember` on every call, `Conflict` on a stale revision, one transaction per write. `db`, `ledger` |
| 111 | Deferred (MCP area) | Connection scopes. |
| 121 | Deferred (history area) | Reads of a saved revision. |
| 122 | Done | `expenses.detail` returns each document's `downloadUrl` as a path (`/api/receipts?groupId=&url=`); the MCP area adds the base URL. |
| 123 | Done | The form mints 21-character IDs; the server accepts any ID of 1 to 64 characters (core contract). |
| 126, 127 | Deferred (MCP area) | The v2 input has no conversion fields; the MCP input schema must refuse them and unknown keys. |
| 128, 138 | Deferred (ungrouped area) | Private contexts. |
| 129, 134, 136 | Changed (core contract) | Writes return the whole expense; delete returns `{ revision }`. |
| 131 | Done | `db` "adds no revision for an edit that changes nothing" |
| 135 | Done | `db` "drops a legacy conversion when the amount changes" |
| 139 | Changed (lead's core) | Writes lock the expense row and run SERIALIZABLE with retries, instead of locking the group row. |
| 142 | Done | `expenses.context`. `db` "finds an expense from any accessible group" |
| 143 | Done | `reference.get` |

## Splits and money (P-MONEY)

| Items | Status | Proof or reason |
| --- | --- | --- |
| 01–17, 20, 21, 32, 34–79 | Done in `src/shared` (lead) | `rules`; this area only uses `parseMinor`, `formatMinor`, `apportion`, `resolveShares` and `validateExpense`. |
| 18, 19 | Done | Message "<CODE> amounts allow at most <n> decimal places". |
| 22–25 | Done | Currency select with Common and Other groups; changing the currency keeps the typed face value. `browser` |
| 26–28, 31 | Deferred (MCP area) | The v2 RPC input has no conversion fields. |
| 29 | Done | Legacy conversion columns stay stored. |
| 30 | Done | `db` "drops a legacy conversion…" |
| 33 | Not ported | Dead code (group E). |
| 80–90, 95 | Done | `form`, `browser`. The preview also shows before the title is typed, and while several payer amounts do not add up yet. |
| 91–94 | Done | `form` "reads and writes the current app's saved split defaults" |
| 96–99 | Done in `src/client/components/money.ts` (lead) | Display uses the exact decimal text. |
| 100 | Done | The split-sum message shows under the list. `browser` |
| 101 | Done differently | The form keeps no dirty state; an unchanged save adds no revision on the server. |

## Balances and settlement (P-BAL)

| Items | Status | Proof or reason |
| --- | --- | --- |
| 01–23 | Done | `listBalances` with `computeBalances` and `suggestSettlements`. `db` "suggests settlements per currency…", "keeps currencies apart…", `rules` |
| 24, 26, 31 | Done | `balances.list` returns `{ currencies: [{ currency, balances, settlements }] }`, with an optional currency. |
| 25 | Deferred (MCP area) | `balances.list` reports real `paid` and `owed`. DECISIONS.md group D keeps the old `paid`/`paidFor` meaning for agents, so the MCP tool must map the settlement flows. |
| 27–29 | Deferred (history area) | Historical balances need revision replay. |
| 32–42 | Deferred | Account-wide totals (`forUser`) feed the dashboard and the groups page, which other areas own. |
| 43–50 | Done | `browser` (Balances and Suggested payments cards, per-currency sections, "Record payment" prefill). |
| 51 | Done | Three skeleton rows, not sized to the participant count. |
| 52–64 | Lead's shared layout (`routes/$group.tsx`) | The rail is outside this area's files. It shows net balances only; the rail texts, suggestions and refresh button are not built yet. |
| 65–89, 91 | Done | `browser`: tab, suggestions, history with "Load more payments", form fields, prefill from plain and router URLs, suggested amount, currency note, lost-response recovery, edit, delete, "This entry uses the expense editor." No horizontal overflow at 375 px. |
| 90 | Deferred (history area) | Change log under the payment form. |
| 94–97 | Deferred (ungrouped area) | Repayments of ungrouped expenses. |
| 98–106 | Deferred (dashboard and groups areas) | Account-wide balance cards. |

## Recurring (P-RECUR)

| Items | Status | Proof or reason |
| --- | --- | --- |
| 01, 02, 04, 05 | Done | `browser`, `db` |
| 03 | Deferred (ungrouped area) | Private expenses. |
| 06, 09, 13, 15–19, 22, 23 | Done | `db` "creates every missed month…", "never duplicates when two runs race", "stops a series…", "counts an edited rule…". Each occurrence gets a deterministic ID from its link, so a duplicate fails on the primary key even if the lock were bypassed. Cron checked on the dev server: two runs created three weekly copies once. |
| 10, 11 | Done | No read path writes. |
| 12, 14 | Done | `recurring.process`. `db` "lets a member process one group only, and records them". Write scope belongs to the MCP area. |
| 24 | Done | The scheduled job logs a failed occurrence and stops that run; `recurring.process` fails the call. |
| 25 | Done | `recurring.list` (open series, non-payments, largest amount first). |

## Receipts (P-RECEIPT)

| Items | Status | Proof or reason |
| --- | --- | --- |
| 01 | Done | `ENABLE_EXPENSE_DOCUMENTS` (true, yes, 1 or on), set to `true` in `wrangler.jsonc`, and reported by `reference.get`. |
| 02–05, 07 | Done | `browser` (upload of a synthetic PNG, thumbnail through `/api/receipts`). |
| 06 | Done, without a carousel | A thumbnail opens one image with "Delete document" and "Close". |
| 08 | Done | `DocumentInput` in the core contract. |
| 09–21, 23–25 | Done | `db` "checks the reference, the session and the membership before reading storage", "uploads to R2…"; also curl on the dev server (401, 403 for another origin, 200 with the safe headers). |
| 15 | Done | v2 reads the JPEG or PNG header itself, as `sharp(...).metadata()` did. `image` |
| 17 | Changed | New objects get the key `receipts/<id>.jpg|png` in R2 and the pointer `r2://agentsplit-receipts/receipts/<id>.<ext>`. Imported URLs keep working: the key is the URL's `receipts/…` suffix. |
| 22 | Deferred (MCP area) | API-key authentication on `/api/receipts` waits for the MCP area's key check. |
| 26 | Done | `image` "derives the storage key and refuses unsafe pointers" |
| 27 | Done | `db` "serves a receipt that only a deleted expense refers to" |
| 28 | Done | `POST /api/s3-upload` answers 410. |
| 29–31 | Done | `db` "records receipts in revision 1…", "removing a receipt keeps it in the earlier revision…", "refuses a receipt that was not uploaded to the group" |
| 32–44 | Deferred (MCP area) | Agent uploads through staged targets. The current app presigns S3 PUT URLs. With R2 bound to the Worker, the simplest equivalent is an authenticated Worker `PUT` for a staged upload ID, finalized by `update_expense`. |
| 45–54 | Not ported | The AI features are off (group E). |
