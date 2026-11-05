# Parity: history, stats and export

This file records the v2 status of every P-HIST, P-STATS and P-EXPORT item in [PARITY.md](../PARITY.md). Test files are under `v2/test/`:

- `db/history.test.ts`: history reads against PostgreSQL. The scenarios port `scripts/test-history-queries.ts` and `scripts/test-expense-history.ts`.
- `legacy/history.test.ts`: random v1 snapshots read through v2, compared with the current app's `describeExpenseRevision` and `getExpenseShares`.
- `db/stats-export.test.ts`: the Stats service and both exports against PostgreSQL.
- `legacy/stats.test.ts`: random expenses through `src/shared/stats.ts`, compared with the current app's `totals.ts` and `monthly-spending.ts`.
- Browser: the Log, the Stats tab and the export routes on a dev server with synthetic data (2026-11-05).

Statuses: **covered** (a v2 test proves it), **browser** (checked in a browser only), **other area** (another area writes or renders it), **changed** (a DECISIONS.md change), **deferred** (not done, with the reason).

## Snapshot formats

History rows keep the format that wrote them. Imported rows have `schemaVersion: 1`, and v2 writes `schemaVersion: 2`. `src/shared/history.ts` reads both formats into one `SavedExpense`. The Log, historical reads, historical balances and the revision panel all use it. v1 allocations come from the current app's rule: an exact amount split is taken as it is, else the amount is apportioned by weight and the payer gets the first leftover unit. `legacy/history.test.ts` proves this on 500 random snapshots in every currency and split mode. Stored snapshots are never changed. The JSON export writes them exactly as stored.

`V2GroupSnapshot` in `src/shared/history.ts` is the group snapshot format that the reader expects from v2 group writes. The groups area must write that format.

## History/audit

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-HIST-01, -05, -06, -10 to -12, -14, -15, -17 | other area | The ledger and its triggers write these (`src/server/ledger.ts`, `db/migrations/0001_invariants.sql`, `test/db/invariants.test.ts`). The history tests read the rows that the ledger writes. |
| P-HIST-02 | covered | The v1 format is read field by field: `legacy/history.test.ts`. v2 writes its own format (`schemaVersion: 2`). |
| P-HIST-03, -04 | other area | The groups area writes group activities. The reader shows v1 and v2 group snapshots: `db/history.test.ts` "shows group snapshots". |
| P-HIST-07 | covered | `db/history.test.ts` "keeps hiding a deleted expense", "shows the expense before its deletion and not after". |
| P-HIST-08, -23 | other area | Recurring schedule (recurring area). The Log shows source `system` as "Created by the recurring schedule". |
| P-HIST-09 | changed | v2 writes the baseline as revision 0 with type `update_expense` and the caller's source, not `baseline` (`ensureBaseline` in ledger.ts). The reader treats every revision 0 event as a baseline, so imported and v2 baselines show the same way: `db/history.test.ts` "counts a baseline only from its recording time". |
| P-HIST-13, -16 | other area | `test/db/invariants.test.ts`; the importer keeps `sequence`. |
| P-HIST-18 | other area | Groups area (participant removal). |
| P-HIST-19, -20 | covered | `db/history.test.ts` "returns the values and names of a revision" (a rename after the write does not change the saved names). |
| P-HIST-21, -22 | other area, covered for reads | The ledger writes the actor. The Log reports `actorName`, `verified` and `agent`, with no user or connection IDs: `db/history.test.ts` "reports who made each change without user IDs". |
| P-HIST-24 to -27 | other area | Write paths (ledger, MCP). |
| P-HIST-28 | covered | `history.activities` takes the same inputs; `type` replaces `activityType`. `db/history.test.ts` "the Log" tests. |
| P-HIST-29 | covered | Same output fields. The MCP schema match is the MCP area's work. |
| P-HIST-30, -34 | covered | "keeps pages fixed at the returned boundary while events are added". |
| P-HIST-31 | covered | "returns the deletion first, with the last saved state as the previous snapshot"; v1 to v2 predecessors: "shows the exact previous and current allocations of every revision". |
| P-HIST-32 | covered | "filters by UTC recording day and type". |
| P-HIST-33 | covered | "filters by recording time in either order and caps at asOf". |
| P-HIST-35 | covered | Same test. Times compare in whole milliseconds, because v2 stores microseconds and returns milliseconds. Without this, an event's own `time` given as `asOf` would exclude that event. |
| P-HIST-36 | covered | "never attaches live expense state to a historical read". |
| P-HIST-37, -38, -42 | covered | "returns nothing for an expense of another group", "rejects bad boundaries", "blocks every history read after access is revoked". |
| P-HIST-39 | covered | "returns the deletion first…". The MCP tool wrapper is the MCP area's work. |
| P-HIST-40 | covered | "accepts only timestamps with a time zone and at most milliseconds" (`RecordedTime` schema). |
| P-HIST-41, -43 | covered | "rejects bad boundaries". |
| P-HIST-44 to -48 | covered | "saved revisions" tests (`history.expense`). |
| P-HIST-49 | covered by code | `getSavedExpense` fails with Invalid "This older revision has no complete saved snapshot". No synthetic row can reach this path without bypassing the triggers. |
| P-HIST-50 to -58 | covered | "the ledger at a boundary" and "legacy gaps" tests (`history.expenses`, `history.balances`). A latest event without a snapshot (pre-snapshot legacy rows) marks the expense unavailable instead of failing the read. |
| P-HIST-59 | covered | "creates no events, rows or revisions". |
| P-HIST-60, -61 | other area | Write paths (ledger, receipts). "keeps currencies separate and frozen after a currency edit" covers the read side. |
| P-HIST-62 | covered | `db/stats-export.test.ts` "writes the JSON…" and "leaves deleted expenses out of both files". |
| P-HIST-63 | other area | The shared group layout checks access. Private contexts redirect in the dashboard and private-expenses area. |
| P-HIST-64, -69 | browser | Title "Log", description and empty text in `routes/$group/activity.tsx`. |
| P-HIST-65 | browser | 20 per page; scrolling loaded 20, 40, 60, then 65 events. |
| P-HIST-66, -67 | browser | en-US week start (Sunday), as the current app's en-US locale. Today shows the time only; older groups also show the date. |
| P-HIST-68 | changed | Same strings. Access changes read "<action> by <name>." (for example "Invitation created by Alice."), never the email or the user ID (P-ACCESS-30). |
| P-HIST-70 | changed, browser | Payments link to `/<group>/payments/<id>/edit`, expenses to `/<group>/expenses/<id>/edit`, under the group path in use. Deleted expenses do not link. Those editor routes belong to the expenses area. |
| P-HIST-71 to -74, -76 to -79 | covered, browser | The fields and values: `legacy/history.test.ts` (all fields equal the current app's panel). Browser: the change markers, the deletion text, the group panel, a `javascript:` pointer that is not a link, and opening a panel without navigation. |
| P-HIST-72 | changed (minor) | Amount-split weights show at the currency's precision ("share 30.00", not "share 30"). A v1 revision and the v2 revision after it then compare equal when nothing changed. |
| P-HIST-75 | changed | "Recorded by <name>", plus "through an agent connection" for agents, instead of "User: <user ID>". |
| P-HIST-76 | changed (gap) | v2 snapshots store only the document count, so v2 revisions show "<n> attachments" with no links. v1 revisions keep their links. See the open questions. |
| P-HIST-80 to -87 | other area | `components/history/expense-log.tsx` implements the log: closed by default, nothing loads until it is opened, 20 per page, a pinned boundary, the same labels and states. The expense editor (expenses area) must render it. It is not checked in a browser yet, because no editor exists on this branch. |
| P-HIST-88 | covered | `getExpense` fails with NotFound for a deleted expense (ledger.ts): "keeps hiding a deleted expense". |

## Export

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-EXPORT-01 | other area | `components/history/export-menu.tsx` is ready. The Expenses tab (expenses area) must render it. |
| P-EXPORT-02 | deferred | v2 has no analytics client yet. |
| P-EXPORT-03, -04 | browser | 401 `{"error":"Sign in required"}` and 403 `{"error":"Group access denied"}` from the dev server. Service: "refuses non-members". |
| P-EXPORT-05 | deferred | v2 has no API key verification yet (auth area). `exportGroup` in `worker.ts` resolves the caller in one place, so a key check fits there. |
| P-EXPORT-06 | browser | `/synthetic/expenses/export/csv` and `/groups/syn-household/expenses/export/json` both answer. `wrangler.jsonc` routes `/*/expenses/export/*` to the Worker first. |
| P-EXPORT-07, -17, -28 | covered, browser | Headers checked on the dev server; `contentDisposition` test. |
| P-EXPORT-08, -09, -10, -12, -13 | covered | `db/stats-export.test.ts`. JSON amounts are at the currency's precision ("30.00"), where the current app wrote minimal decimals ("30"). Both forms are exact. |
| P-EXPORT-11 | covered | Same fields and enum names. Additions for multiple payers: `payers` (each payer's part), and `amount` on each `paidFor` row. `paidById` is the payer who paid most. |
| P-EXPORT-14 | changed | Activities have no `actorUserId` or `agentKeyId`, and access-change `data` keeps only the action ("Invitation created"). |
| P-EXPORT-15 | changed | "AgentSplit Export - <group> - YYYY-MM-DD.json", as the CSV name. |
| P-EXPORT-16 | changed | A missing group and a group without access both answer 403, so the response does not reveal which groups exist. |
| P-EXPORT-18 to -27 | covered | The CSV test checks every cell of six rows: formula escapes, a payment, a negative amount, JPY, an imported expense, and each row summing to zero. Participant columns follow the group's name order. |
| P-EXPORT-29 | changed | Rows are ordered by expense date, creation time and ID. |
| P-EXPORT-30 | covered by code | RPC `export.group` returns `{filename: "agentsplit-<groupId>.<format>", contentType, content}` from the same functions. |

## Stats

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-STATS-01, -02 | browser | The cards are in the current app's order. One `stats.overview` request per filter. The page heading is "Totals"; the document title is not set (no route sets one yet). |
| P-STATS-03, -04 | covered | "defaults to the group currency…", "shows one currency at a time". |
| P-STATS-05 to -10 | browser, covered | Period select and custom range in the browser. Reversed bounds: "scopes to a range…". |
| P-STATS-11, -12 | covered | `legacy/stats.test.ts`, "leaves payments out of every figure…". |
| P-STATS-13 to -16 | covered | `legacy/stats.test.ts` (summary equals the current app's), browser for the span text. |
| P-STATS-17 | browser | Same empty texts. |
| P-STATS-18 to -24 | covered | `db/stats-export.test.ts` and `legacy/stats.test.ts`. With several payers, "Your total spendings" is the caller's own part. |
| P-STATS-25 to -27 | covered | "shows the same months in both charts…", "drills down…"; month labels in the browser. |
| P-STATS-28 to -31 | covered | Same tests. "Count" is the number of expenses where the person is a payer. |
| P-STATS-32, -33 | browser | Vendor above title, date, amount, and a link to the editor. |
| P-STATS-34, -35, -38 to -40 | covered, browser | `legacy/stats.test.ts` compares both groupings with the current app's code. Round amounts, grouping and chart type checked in the browser. Detailed categories use their category group's icon, because the category icon set belongs to the expenses area. |
| P-STATS-36 | changed | Both charts use the same months: from the From date or the first expense, to the To date or the current month. `legacy/stats.test.ts` checks that every month total still equals the current app's. |
| P-STATS-37 | covered | `legacy/stats.test.ts` with explicit From and To dates. |
| P-STATS-41 to -43 | covered | "scopes to a range, but not the recurring card"; `legacy/stats.test.ts` compares the estimates on 300 random cases. |
| P-STATS-44 | changed | Stats never create recurring expenses (P-BAL-30, P-RECUR-08): "refuses non-members and writes nothing". |
| P-STATS-45 | browser | Each card shows a skeleton before the first answer. Later filter changes keep the previous figures until the new answer arrives. |
| P-STATS-46 | covered by code | `CalendarDate` and the `YYYY-MM` pattern in `src/shared/api/history.ts`. |

## Open questions

1. v2 snapshots (`snapshot` in `ledger.ts`) store the document count, not the document pointers or the original amount and rate. The revision panel cannot link the attachments of v2 revisions. Add `documents` to the v2 snapshot when receipts land?
2. The editor routes are assumed to be `/<group>/expenses/<id>/edit` and `/<group>/payments/<id>/edit` (`expenseHref` in `components/history/app-link.tsx`). The expenses area must use them, or change that one helper.
3. `scripts/seed-synthetic.ts` refuses `agentsplit_dev_<area>` names, which BUILDING.md tells areas to use.
