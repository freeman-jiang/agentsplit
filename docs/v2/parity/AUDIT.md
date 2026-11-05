# Parity audit of v2

This audit checks the Done criterion "The parity checklist passes in full" of [PLAN.md](../PLAN.md). It reads the 1,612 items of [PARITY.md](../PARITY.md), the seven area records in this folder and [DECISIONS.md](../DECISIONS.md). It checks the v2 code and tests at commit b83751d on branch `v2`. v2 went live on 2026-11-05.

## Result

The checklist does not pass in full. The code check finds 40 items that v2 does not implement or implements only in part. Branch `t3/v2-db-gaps` closes gaps 12 to 18 (15 items), with migration `0009_database_rules` and the performance headers. It is not merged, so the counts below still describe b83751d. The most visible gap is the group balance rail, which every group page shows. The most urgent gap is the nightly backup: it still dumps the old database, and its next run is on 2026-11-06 at 03:31 PST (P-DB-150).

The records also mark 167 items as changed. A decision approves most of them, but 101 items change with no decision. Most of them are invisible or small, but Freeman must approve each one or v2 must change back.

CI run 42078878350 on commit e576d71 passed 27 test files, 297 tests and 11 e2e tests. The v2 code at b83751d differs from e576d71 only in the privacy page text and one tool description. So every test that this audit names passed.

### Closed after the audit

Branch `t3/v2-server-gaps` closes gaps 2, 3, 7, 8, 9 and 10, and applies Freeman's agent-output decision (DECISIONS.md, "Parity audit, unapproved changes"). The counts above are from the audit and do not include these changes. Each row below names its test. The tests are in `v2/test/db/agent-output.test.ts`, `v2/test/db/mcp-oauth.test.ts` ("OAuth routes") and `v2/e2e/private-expenses.spec.ts`.

| Items | Change | Test |
| --- | --- | --- |
| P-HIST-03 | The history reader also reads the private-context `create_group` snapshot that v2 stored before the fix (`defaultCurrency`, no `currency`). The writer now stores the shape of `V2GroupSnapshot`. | agent-output "stores the create_group snapshot…", "reads the Log and list_activity of a context whose snapshot has the shape stored before the fix" |
| P-UNGROUP-39, P-GROUP-47, P-HIST-63 | `groups.get` returns `kind` and `contextExpenseId`. The group layout sends a private context to `/expenses/<expenseId>`. MCP `get_group` gives that page as the share link. | e2e "the ID of a private context opens its expense, not a group page"; agent-output "tells the client the kind and the expense…" |
| P-AUTH-45, P-AUTH-47, P-EXPORT-05, P-TOOL-EXPORT-06 | The export URLs accept an API key (`X-API-Key` or `Authorization: Bearer`) and an OAuth bearer with read scope, as `/api/receipts` does. An agent header makes the server ignore the cookie. A bad credential gets 401 "Sign in required". A token without read scope gets the MCP endpoint's 403. | agent-output "exports …"; mcp-oauth "exports accept the OAuth bearer of a member…" |
| P-MCP-137, P-MCP-138, P-MCP-139 | `v2/src/server/oauth-routes.ts` ports the current app's wrapper. A refresh-token revoke tombstones its connection. A deleted consent revokes the client's connections and tokens. UserInfo applies the MCP connection, consent and verified-user checks. | mcp-oauth "OAuth routes" |
| P-FEED-40 | A historical `get_expense` names the authors as recorded at that point. | agent-output "names the authors of a historical read as recorded then…" |
| P-EXP-107 | Every expense event stores "<vendor> — <title>". For v2 rows stored without it, `list_activity`, the Log and the JSON export take the text from the last saved snapshot at that event. | agent-output "stores … on every expense event, as the current app", "stores agent writes as `agent`…" |
| P-DB-79 | Agent writes store `source = 'agent'`. Rows stored as `mcp` show as `agent` in the Log, MCP, the feed and the JSON export. | agent-output "stores agent writes as `agent`…" |
| P-HIST-09, P-DB-16 | MCP attribution uses the feed's rule: a revision-0 event is a baseline, not an edit. | agent-output "does not count a v2 baseline as an edit" |
| P-TOOL-EXPORT-04, P-EXPORT-16, P-GROUP-78 | A missing group and a group of someone else get one message, "Group not found, or you are not a member": FORBIDDEN on MCP (every tool), 403 on the export and receipt URLs. These are the status codes of the current app's access check, which runs before its existence check. | agent-output "give one message for a missing group and a group of someone else"; mcp-tools "denies a group of someone else with a certain outcome" |
| P-TOOL-LISTEXP-11, P-TOOL-LISTALL-14, P-TOOL-CREATEEXP-15, P-TOOL-BALANCES-04, P-EXPORT-08, P-EXPORT-09, P-EXPORT-10, P-EXPORT-12, P-EXPORT-13, P-TOOL-UPDATEEXP-03, P-TOOL-CREATEEXP-08 | No change: Freeman approved full decimals and field-named errors. | — |

## Method

1. Parse every table row of the seven records, expand ranges such as `P-GROUP-27 to -31` and `04–08`, and map each row to the PARITY.md IDs.
2. Order the records by the first-parent merge on `v2` that last changed them: groups.md (6f9f232), account.md (0c477bd), history.md (6598036), feed.md and lead.md (273b8ae), expenses.md and mcp.md (5b0f4f4).
3. Give each ID the status of the latest record that gives a final status (covered, code, changed or open). A deferral or an "other area" pointer never replaces a final status, because it hands the item to that area. Inside one record, the narrower row wins.
4. Check every item that is missing, deferred or open against the v2 code and tests. Five read-only agents did the first pass. The auditor confirmed each gap in the code.
5. Check every changed item against DECISIONS.md and PLAN.md. A wording change or a bug fix counts as approved only when DECISIONS.md group B, C, E or G names it.

Two items keep a decided change although a later record closes them: P-AUTH-49 (lead.md) and P-TOOL-LISTALL-09 (mcp.md). 155 IDs appear in more than one record. Appendix A names the record that wins and the other records.

## Counts

### Status in the area records

| Status | Items | Meaning |
| --- | --- | --- |
| covered | 1049 | A test or a browser check proves the item. |
| code | 62 | v2 implements the item, but no test proves it. |
| changed | 167 | v2 differs on purpose. |
| deferred | 80 | The record gives the item to an owner. |
| deferred (other area) | 87 | The record says that another area owns the item, and that area never records it. |
| open | 3 | The record marks the item as partly done. |
| missing | 164 | No record names the item: all 150 P-DB items and all 14 P-PRIVACY items. P-DB-73 appears only in the prose of groups.md. |
| total | 1612 | |

### Code check of the missing, deferred and open items

| Record status | tested | untested | approved-change | unapproved-change | not-applicable | gap | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| missing | 43 | 61 | 18 | 21 | 5 | 16 | 164 |
| deferred | 35 | 28 | 1 | 0 | 4 | 12 | 80 |
| deferred (other area) | 48 | 17 | 1 | 6 | 3 | 12 | 87 |
| open | 1 | 2 | 0 | 0 | 0 | 0 | 3 |
| total | 127 | 108 | 20 | 27 | 12 | 40 | 334 |

So 235 of the 334 items are implemented now. Later merges did most of the deferred work, but the records were not updated.

### Changed items

Of the 167 changed items, a decision approves 105 and no decision approves 62. The code check adds 39 more unapproved changes: items that the records mark covered but that describe a change, and missing or deferred items that v2 changed. The total is 101.

## Gaps

Each gap is an item that v2 does not implement, or implements only in part. The list starts with the gaps that people see most.

Branch `t3/v2-client-gaps` closes gaps 1, 4, 5 and 6 after the audit. Appendix A and Appendix B show the new status and the tests. The counts above are from the audit.

### People in the browser

1. **P-BAL-53, P-BAL-54, P-BAL-55, P-BAL-56, P-BAL-58, P-BAL-62, P-BAL-63.** The group balance rail shows only names and signed net amounts. It has no "You are owed", "You owe" or "Settled up" line, no "Group net balances" heading, no "gets back" or "owes" text, no "(you)", no suggested payments, no "Refresh balances" button, no "Balance details" link and other empty and error texts. Evidence: `v2/src/client/routes/$group.tsx:97-125` (`NetList`, `BalanceRail`). expenses.md line 108 gives the rail to the lead, and lead.md does not track it. **Closed:** the rail is a port of the current app's `group-balance-summary.tsx` (`v2/src/client/routes/$group.tsx` `BalanceRail`); e2e `group-expenses.spec.ts` "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)".
2. **P-UNGROUP-39, P-GROUP-47, P-HIST-63.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). The ID of a private expense context opens the full group shell (tabs, Settings, Log) instead of `/expenses/<expenseId>`. MCP `get_group` gives `/groups/<contextId>` as the share link, so a person who follows it sees the wrong page. Evidence: `$group.tsx:12-30` and `getGroup` (`v2/src/server/ledger.ts:109`) never read `groups.kind`. The `Group` contract has no `kind` (`v2/src/shared/api/core.ts`).
3. **P-HIST-03.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). The Log and MCP `list_activity` fail on a private expense context. The private-context `create_group` snapshot has `defaultCurrency` and no `currency`, so the history reader throws `UnreadableSnapshot` for the whole page. Activities are permanent, so every private expense created since the cutover has this row. The fix must go in the reader. Evidence: Writer: `v2/src/server/ungrouped.ts:93,107`. Reader: `v2/src/shared/history.ts:142-153,311` and `v2/src/server/history.ts:198`. No test decodes this snapshot. The named-group writer is correct (`groups.ts:225`).
4. **P-EXP-22.** Expense cards show no category icon on wide screens. Evidence: No category icon component in `v2/src/client`. expenses.md line 48 defers it, with no owner. **Closed:** `v2/src/client/components/category-icon.tsx` maps the fixed category IDs to the current app's icons, on group and dashboard cards from 640 px. Checked in the browser.
5. **P-PWA-04.** iOS shows no splash image when the app opens from the home screen. It shows the background color. Evidence: `v2/index.html` has `apple-touch-icon` only. account.md line 73 defers it as low value. No decision approves the drop. **Closed:** `addAppleSplashImages` in `v2/src/client/pwa.ts` ports the current app's script. Checked in the browser with `navigator.standalone` set: two links, portrait and landscape.
6. **P-PWA-36.** The error page shows no error reference for the user to quote. The rest of the item is done and tested. Evidence: `v2/src/client/components/error-state.tsx:10-30`; e2e `group-expenses.spec.ts` "a tab that fails to load…". **Closed:** the page shows "Reference: <8 hex digits>" and logs the same reference with the error to the console. The server returns no request ID, so the client makes the reference. e2e `group-expenses.spec.ts` "a tab that fails to load shows the group error under the tabs, with a reference and without the exception text (P-GROUP-53, P-PWA-36)".

### Agents and scripts

7. **P-AUTH-45, P-AUTH-47, P-EXPORT-05, P-TOOL-EXPORT-06.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). The CSV and JSON export URLs accept only the session cookie. An API key or an OAuth bearer gets 401. MCP `get_group` still gives these URLs to agents (`mcp/tools/groups.ts:165`), and OAUTH.md promises a bearer works. MCP `export_group` works. Evidence: `v2/src/server/app.ts:116-131` (`exportGroup` calls `sessionPrincipal` only) and `app.ts:183-191`. Receipts take the key path (`receipts.ts` `receiptReader`).
8. **P-MCP-137, P-MCP-138, P-MCP-139.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). The current app's wrapper around three OAuth routes is not ported. An RFC 7009 revoke does not tombstone the connection, so the access token works for up to 300 seconds after the revoke. Delete-consent leaves the connection and the refresh tokens. UserInfo does not check the connection, the consent or a verified email. Evidence: `v2/src/server/app.ts:160` sends every `/api/auth/*` request to Better Auth. Compare `src/app/api/auth/[...all]/route.ts:13-70`. account.md line 107 gives these to the MCP area, and mcp.md line 130 gives them back.
9. **P-FEED-40.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). MCP `get_expense` with `revision`, `asOf` or `atActivityId` shows current account names in the attribution. The current app shows the names at that point. Evidence: `v2/src/server/mcp/tools/expenses.ts:437-445` (`attributionThrough` reads `user.name`).
10. **P-EXP-107.** Closed on branch `t3/v2-server-gaps` (see "Closed after the audit"). MCP `list_activity` returns `data: null` for v2 expense events. The current app stores "<vendor> — <title>". The web Log builds the text from the snapshot, but no test asserts it. Evidence: `v2/src/server/ledger.ts:587-595,677-685` write no `data`; `v2/src/client/routes/$group/activity.tsx:71-75`.

### Nobody can see these yet (data safety and database rules)

11. **P-DB-150, P-DB-148.** The nightly backup does not cover v2. The live `agentsplit-backup` dumps the old `db` container and runs `node` in the `app` container, which the v2 image does not have. The fix is on the unmerged dots branch `agentsplit-backup-v2` (6bb1a4d). The next run is on 2026-11-06 at 03:31 PST. Also, no step compares data after a v2 migration: `server.ts` migrates at every start. Evidence: dots `main` 773d448 `devbox/bin/agentsplit-backup:26-33`; CUTOVER.md "Follow-up". `verify-import.ts` compares only the old app with v2.
12. **P-DB-61, P-DB-65, P-DB-93, P-DB-117, P-DB-127.** DECISIONS.md group C approves foreign keys for these references, but no migration adds them: `activities.expense_id` and `participant_id`, `recurring_links.group_id`, `memberships.user_id`, `apikey.reference_id`, and `oauth_connections.user_id` and `client_id`. Evidence: `v2/db/migrations/0000_init.sql` (no `REFERENCES` for these columns). **Fixed on `t3/v2-db-gaps`:** `0009_database_rules.sql` adds `activities(expense_id, group_id)` and `activities(participant_id, group_id)` to the expense and the participant of the same group, `recurring_links(current_frame_expense_id, group_id)` to its expense, so the link's group is the expense's group, `memberships.user_id` (RESTRICT), and `apikey.reference_id` and both `oauth_connections` keys (CASCADE). Test: `v2/test/db/database-rules.test.ts`, "foreign keys".
13. **P-DB-95.** DECISIONS.md group A approves a role limited to admin or member, and PLAN.md wants each invariant in the database. The `role` column has no CHECK. Only TypeScript limits it. Evidence: `0000_init.sql:128`; `v2/db/schema/app.ts:76`. **Fixed on `t3/v2-db-gaps`:** CHECK `memberships_role`. Test: `database-rules.test.ts` "refuses a role other than admin or member".
14. **P-DB-70.** DECISIONS.md group G approves a trigger that keeps receipt rows. No migration adds it. The app never deletes receipt rows. Evidence: No trigger on `receipts` in `v2/db/migrations/*.sql`. **Fixed on `t3/v2-db-gaps`:** the triggers `receipts_immutable` and `receipts_no_truncate` refuse UPDATE, DELETE and TRUNCATE. Test: `database-rules.test.ts` "refuses to change, delete or truncate a receipt row".
15. **P-DB-42, P-DB-47, P-DB-77.** The database no longer limits `split_mode`, `recurrence` and the activity `type` to their values. The current app uses PostgreSQL enums. v2 checks them only in TypeScript. Evidence: `0000_init.sql:6,71,75` (plain `text`, no CHECK). **Fixed on `t3/v2-db-gaps`:** CHECKs `expenses_split_mode`, `expenses_recurrence` and `activities_type`. Tests: `database-rules.test.ts` "value lists".
16. **P-DB-115, P-DB-116, P-DB-121.** Three unique keys of the current schema are gone: `account(provider_id, account_id)`, `apikey.key` and `oauth_client_resource(client_id, resource_id)`. A race can then link one Google account to two users. Evidence: `0000_init.sql:186-200,301-307,451`; the generated auth schema (`v2/db/schema/auth.ts`) emits plain indexes. **Fixed on `t3/v2-db-gaps`:** the three unique keys. `scripts/gen-auth-schema.ts` now emits them, and the unique key on `apikey.key` replaces its plain index. Tests: `database-rules.test.ts` "unique keys".
17. **P-DB-49.** No index supports the per-currency balance query. This affects speed only. Evidence: No `(group_id, currency, deleted_at)` index in `v2/db/migrations`. **Fixed on `t3/v2-db-gaps`:** index `expenses_group_currency`.
18. **P-PWA-49.** The performance headers are not ported. They are off by default in the current app. Evidence: No `server-timing` or `x-perf-db-queries` in `v2/src`. **Fixed on `t3/v2-db-gaps`:** with `PERF_INSTRUMENTATION=1`, `secured()` adds `x-perf-db-queries` and `server-timing: db;dur=<ms>` to every response (`v2/src/server/perf.ts`). Test: `v2/test/db/perf.test.ts`.

### Items that are implemented, but have no test

108 of the checked items are implemented, but no test asserts them. They do not block parity as the records define it, because the records accept "code" for 62 other items. Appendix B names the file for each. The largest group is the OAuth server behavior that Better Auth provides (P-MCP-102 to P-MCP-128): no v2 test exercises PKCE failures, rejected registrations, confidential clients or refresh retries.

### Open items without a PARITY.md ID

- lead.md: the `/agents` instructions do not have the PLAN.md guidance yet (record the full payment, include the payer in paidFor, put the calculation in notes). The MCP server instructions have it (P-MCP-06). See `v2/src/client/routes/agents.tsx:38-42`.
- account.md line 110 (P-MCP-151): the consent page is checked at 1280 px only, not at 390 px.
- mcp.md open questions 1 and 2 on receipt uploads (no API key on the PUT, and the key fixed by the declared type) have no decision.

## Changes that no decision approves

Freeman must approve each change, or v2 must change back. In each group, the most visible changes come first.

### People in the browser can see these

- **P-AUTH-59, P-AUTH-60.** The landing page has a "Log In" link to `/sign-in`, not a button that opens Google. Sign-in takes a second click (`routes/index.tsx:50`). feed.md calls P-FEED-01 done and does not record the change.
- **P-EXP-11.** The expense list search also matches notes (`ledger.ts` `listExpenses`). The current app matches the title and the vendor only.
- **P-EXP-40, P-EXP-41, P-EXP-49.** Save, delete and Cancel always go to the expense list. v2 ignores `returnHref` and `cancelHref`. The record marks these items done.
- **P-RECEIPT-06.** A receipt thumbnail opens one image, not a carousel. The record marks the item done.
- **P-UNGROUP-15.** The private expense form hides "Save as default splitting options". The record marks the item done.
- **P-HIST-72.** The revision panel shows split weights at the currency's precision ("share 30.00", not "share 30").
- **P-GROUP-98, P-GROUP-100, P-PWA-21, P-PWA-23.** Group URLs: a group without a slug is at `/<id>`, not `/groups/<id>`. The client redirects `/groups/<id>/…`, so the server sends no 307 and no `private, no-store`. `/<slug>` moves to `/<slug>/expenses`, where the current app keeps the URL.
- **P-GROUP-101, P-GROUP-102, P-PWA-25, P-PWA-26.** Unknown paths: a path with a dot, a `/_next/` path or an unknown top-level path gets the SPA page and a group lookup, not a 404. A signed-in person who types a wrong URL lands on `/groups?access=denied`. groups.md calls P-GROUP-101 and P-GROUP-102 not applicable, which is wrong for these paths.

### Agents and scripts can see these

- **P-TOOL-LISTEXP-11, P-TOOL-LISTALL-14, P-TOOL-CREATEEXP-15, P-TOOL-BALANCES-04, P-EXPORT-08, P-EXPORT-09, P-EXPORT-10, P-EXPORT-12, P-EXPORT-13.** Approved (DECISIONS.md, agent output). Money strings have the currency's full decimals ("30.00", not "30") in MCP results and in the JSON export. The value is the same. The `payers` field beside them is approved (multiple payers). history.md marks the export items covered.
- **P-RECEIPT-17, P-RECEIPT-33, P-RECEIPT-35, P-RECEIPT-39, P-RECEIPT-40, P-RECEIPT-42, P-RECEIPT-43, P-RECEIPT-44, P-TOOL-CREATEEXP-30, P-TOOL-CREATEEXP-31, P-TOOL-UPDATEEXP-13, P-TOOL-UPDATEEXP-14.** Receipt uploads use a single-use server URL instead of a presigned S3 URL, check the type at the PUT, and store the pointer `r2://agentsplit-receipts/<key>` (`receipts.ts:25`). The reason was the Worker and R2. Since the move to Coolify, v2 stores receipts in Garage, so the reason no longer holds. Agents see the new URL and pointer.
- **P-HIST-09, P-DB-16.** Changed back on branch `t3/v2-server-gaps`. A v2 baseline is type `update_expense` with the caller's source, not `create_expense` with source `baseline`. The MCP attribution queries filter only `source <> 'baseline'` (`mcp/tools/expenses.ts:327,442`), so they count a v2 baseline as an edit. The feed also checks the revision (`feed.ts:51`).
- **P-DB-79.** Changed back on branch `t3/v2-server-gaps`. v2 writes `source = 'mcp'` for agent writes, where the current app writes `agent`. The JSON export shows the stored value, so it mixes both.
- **P-TOOL-ACTIVITY-06.** `list_activity` snapshots changed: `schemaVersion` is the stored format, documents have no size, and group snapshots have no revision. `payers` is approved.
- **P-TOOL-UPDATEEXP-03, P-TOOL-CREATEEXP-08.** Approved (DECISIONS.md, agent output). Error messages changed: a missing `expectedRevision` fails schema validation, and payer errors name the field (`payers.0: …`).
- **P-TOOL-EXPORT-04, P-EXPORT-16, P-GROUP-78.** Changed back on branch `t3/v2-server-gaps`. A missing group answers FORBIDDEN or 403, not NOT_FOUND or 404 "Invalid group ID".
- **P-TOOL-LISTALL-02, P-FEED-12.** The feed cursor takes `createdAt` with microseconds, so rows created in the same millisecond are not skipped. This fixes a current-app bug that group C does not name. The `involvingMe` default in P-TOOL-LISTALL-02 is approved.
- **P-TOOL-REF-03.** `get_reference_data` lists the 34 currencies in code order, not in the current list order.

### Features that are off in production, but that group E does not name

- **P-EXP-98, P-RECEIPT-45, P-RECEIPT-46, P-RECEIPT-47, P-RECEIPT-48, P-RECEIPT-49, P-RECEIPT-50, P-RECEIPT-52, P-RECEIPT-53, P-RECEIPT-54.** The AI receipt and category extraction is not ported. Group E names only P-EXP-02 and P-RECEIPT-51. The feature is off in production (P-RECEIPT-54, P-PRIVACY-12).
- **P-PWA-37, P-PWA-38, P-PWA-39, P-PWA-40, P-PWA-41, P-PWA-42, P-PWA-43, P-PWA-44, P-PWA-45, P-PWA-46, P-EXPORT-02.** The environment flags, analytics and exchange-rate lookups are not ported. They are off in production (P-PRIVACY-12).

### Nobody can see these (internal)

- **P-EXP-139, P-DB-87, P-DB-89, P-DB-143.** Writes run SERIALIZABLE with retries and lock the expense or link row, not the group row.
- **P-DB-90.** No 15-second transaction timeout. The pool waits 5 seconds for a connection, not 10.
- **P-MCP-39, P-MCP-44, P-MCP-51, P-MCP-86.** MCP internals: outputs are not decoded again at run time, the abort signal is not passed on, the API key check is a port of Better Auth's (a differential test proves equal answers), and memberships are not preloaded. The CPU reasons came from the Worker plan.
- **P-TOOL-PBAL-03, P-UNGROUP-52, P-UNGROUP-58, P-MONEY-101.** The same outcome by another path: the access check is in the read statement, the RPC uses `Invalid` where the current app used CONFLICT (the UI and MCP still show the same result), and the form keeps no dirty state.
- **P-PWA-18, P-PWA-19.** The CSP has no storage origin, because receipts come from this origin.
- **P-DB-20, P-DB-33, P-DB-34, P-DB-39, P-DB-41, P-DB-43, P-DB-45.** Column changes: a deleted series loses its link row, split weights are decimal text, the conversion rate is unchecked text, three defaults are gone, `isReimbursement` is `kind`, and `notes` is non-null.
- **P-DB-55, P-DB-58, P-DB-62, P-DB-64, P-DB-92, P-DB-103.** Foreign key actions: CASCADE or SET NULL became RESTRICT. Groups and expenses are never hard-deleted, so no path reaches them.
- **P-DB-138, P-DB-139.** Bootstrap no longer imports the legacy `MCP_ACCESS_GRANTS` keys. The importer copies the resulting rows. Group E names only the grant script (P-MCP-176).

### Approved changes

These changed items have a decision. The basis is in Appendix A.

| Basis | Items |
| --- | --- |
| DECISIONS.md group C | P-AUTH-49, P-AUTH-58, P-GROUP-21, P-GROUP-58, P-GROUP-76, P-GROUP-105, P-GROUP-106, P-EXP-51, P-EXP-52, P-EXP-53, P-EXP-61, P-EXP-102, P-EXP-103, P-MONEY-35, P-BAL-30, P-RECUR-07, P-RECUR-08, P-RECUR-20, P-RECUR-21, P-FEED-18, P-HIST-70, P-ACCESS-28, P-ACCESS-33, P-EXPORT-29, P-STATS-36, P-STATS-44, P-TOOL-LISTALL-08, P-TOOL-ACCESS-28, P-TOOL-STATS-04 |
| PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14) | P-EXP-129, P-EXP-134, P-EXP-136, P-FEED-34, P-PWA-20, P-MCP-14, P-MCP-89, P-MCP-129, P-MCP-130, P-MCP-131, P-MCP-132, P-MCP-133, P-TOOL-LISTALL-01, P-TOOL-LISTGROUPS-01 |
| DECISIONS.md group F (English only) | P-GROUP-91, P-FEED-23, P-SETTINGS-19, P-PWA-50, P-PWA-51, P-PWA-52, P-PWA-53, P-PWA-54, P-PWA-55, P-PWA-56, P-MCP-172 |
| DECISIONS.md group G | P-AUTH-03, P-AUTH-30, P-GROUP-08, P-EXP-97, P-HIST-68, P-HIST-75, P-EXPORT-15, P-PWA-31, P-MCP-56, P-MCP-158 |
| DECISIONS.md group B | P-AUTH-55, P-ACCESS-30, P-EXPORT-14, P-PWA-17, P-PWA-28, P-MCP-41, P-MCP-79, P-TOOL-CREATEEXP-14, P-TOOL-EXPORT-03 |
| DECISIONS.md group E | P-GROUP-20, P-GROUP-22, P-EXP-02, P-MONEY-33, P-RECEIPT-51, P-MCP-176 |
| DECISIONS.md group A | P-PWA-48, P-MCP-85, P-MCP-173, P-MCP-174, P-MCP-175 |
| PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md) | P-MCP-68, P-MCP-77, P-MCP-88, P-MCP-91, P-MCP-93 |
| PLAN.md invariant 1 and the DECISIONS.md "MCP group currency" bullet | P-GROUP-23, P-GROUP-37, P-TOOL-CREATEGROUP-02 |
| DECISIONS.md group C and the P-FEED-19 bullet | P-FEED-19, P-TOOL-LISTALL-09 |
| DECISIONS.md P-EXP-20 bullet. The code now refetches on every visit (`main.tsx:12`), so v2 matches the current app | P-EXP-20 |
| DECISIONS.md group B (the RPC form of P-TOOL-CREATEEXP-14) | P-EXP-124 |
| DECISIONS.md group C and the P-BAL-92 bullet | P-BAL-92 |
| DECISIONS.md group D and the P-BAL-93 bullet (keep) | P-BAL-93 |
| DECISIONS.md bullet on retries of a private-expense create | P-UNGROUP-26 |
| DECISIONS.md bullet "Revision snapshots record the expense's receipts". The code now stores them (`shared/history.ts:93`), so the record's gap is closed | P-HIST-76 |
| PLAN.md New features (agent instructions) and the P-BAL-93 bullet | P-MCP-06 |
| PLAN.md invariant 1 (registered currency codes only) | P-TOOL-LISTGROUPS-07 |
| No visible change: the current access check also answers FORBIDDEN first | P-TOOL-GETGROUP-03 |
| PLAN.md New features (multiple payers) | P-TOOL-CREATEEXP-03 |
| DECISIONS.md group B (the group log without connection IDs) | P-TOOL-ACTIVITY-08 |

## Record errors

The records are out of date in many places. Later merges did the work, but nobody updated the record. These rows are wrong now:

- expenses.md lines 54, 63, 64, 65, 68, 71, 72, 87, 103 to 105, 110 and 112 defer items that the history, MCP, ungrouped and groups merges implemented. Appendix B has the evidence for each.
- feed.md lines 121, 126 to 129, 147, 148, 165 and 167 defer items that are implemented. feed.md line 176 defers the other `list_all_expenses` items, which mcp.md covers.
- groups.md lines 81, 119, 121, 148 and 175 (P-GROUP-77, P-ACCESS-02, P-ACCESS-04, P-ACCESS-32, P-ACCESS-66) are deferred or partial, but the code and tests are in place.
- account.md line 60 (P-SETTINGS-12 to P-SETTINGS-14) defers account names in group views. `displayName` in `v2/src/server/sql.ts:27` does it, and tests assert it.
- mcp.md line 185 (P-TOOL-CREATEEXP-18) defers recurring links, and line 201 (P-TOOL-UPDATEEXP-08) says that the ledger keeps `original_*` columns. Both are wrong: the ledger creates the link, and `ledger.ts:655-663` clears the columns, with tests.
- history.md line 61 (P-HIST-76) records a gap that the receipts decision closed. Line 25 (P-HIST-03) is true for named groups only (gap 3).
- history.md line 70 (P-EXPORT-02) waits for an analytics client, but the current app never sends the event.
- expenses.md line 46 (P-EXP-20) still describes the 30-second cache. The code refetches on every visit.
- feed.md P-FEED-01 calls the landing page done and hides the change to the sign-in flow (P-AUTH-59, P-AUTH-60).
- groups.md P-GROUP-101 and P-GROUP-102 say "not applicable". That is wrong for dotted and unknown paths (P-PWA-25).
- Many records cite `worker.ts`, R2 and `wrangler.jsonc`. After the move to Coolify, the code is in `v2/src/server/app.ts`, `server.ts` and `bucket.ts`. Migration comments in `0007_mcp_rate_limit.sql` and `0008_receipt_uploads.sql`, and `v2/src/server/ungrouped.ts:6` (it cites migration 0003, which is 0005), are also stale.
- CUTOVER.md says the import verifier checks "the same IDs in every table". `v2/test/legacy/verify-import.ts:22-39` skips 11 tables, and it does not compare activity sequences or snapshots (P-DB-140).
- PARITY.md P-AUTH-46 gives the receipt 401 body as "Sign in required". Both apps answer "Authentication required". PARITY.md P-AUTH-71 describes a "Participant: <name>" text that the current app does not have.

## Appendix A: status of every item

Status is the record status after the rules in Method. Record is the winning record and line. Other records lists every other record that names the item. Check is the result of the code check, for the items that needed one.

| ID | Status | Record | Other records | Check |
| --- | --- | --- | --- | --- |
| P-AUTH-01 | covered | account.md:16 | — | — |
| P-AUTH-02 | covered | account.md:17 | — | — |
| P-AUTH-03 | changed (approved: DECISIONS.md group G) | account.md:18 | — | — |
| P-AUTH-04 | covered | account.md:19 | — | — |
| P-AUTH-05 | covered | account.md:19 | — | — |
| P-AUTH-06 | covered | account.md:19 | — | — |
| P-AUTH-07 | covered | account.md:19 | — | — |
| P-AUTH-08 | covered | account.md:19 | — | — |
| P-AUTH-09 | covered | account.md:20 | — | — |
| P-AUTH-10 | covered | account.md:21 | — | — |
| P-AUTH-11 | covered | account.md:22 | — | — |
| P-AUTH-12 | covered | account.md:23 | — | — |
| P-AUTH-13 | covered | account.md:24 | — | — |
| P-AUTH-14 | covered | account.md:25 | — | — |
| P-AUTH-15 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-16 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-17 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-18 | deferred (other area) | account.md:26 | — | not-applicable |
| P-AUTH-19 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-20 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-21 | deferred (other area) | account.md:27 | — | tested |
| P-AUTH-22 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-23 | covered | account.md:28 | — | — |
| P-AUTH-24 | covered | account.md:28 | — | — |
| P-AUTH-25 | covered | account.md:28 | — | — |
| P-AUTH-26 | covered | account.md:28 | — | — |
| P-AUTH-27 | covered | account.md:28 | — | — |
| P-AUTH-28 | deferred | account.md:29 | — | not-applicable |
| P-AUTH-29 | deferred | account.md:29 | — | not-applicable |
| P-AUTH-30 | changed (approved: DECISIONS.md group G) | account.md:30 | — | — |
| P-AUTH-31 | covered | account.md:31 | — | — |
| P-AUTH-32 | covered | account.md:31 | — | — |
| P-AUTH-33 | covered | account.md:31 | — | — |
| P-AUTH-34 | covered | account.md:32 | — | — |
| P-AUTH-35 | covered | account.md:33 | — | — |
| P-AUTH-36 | covered | account.md:34 | — | — |
| P-AUTH-37 | covered | account.md:35 | — | — |
| P-AUTH-38 | covered | account.md:36 | — | — |
| P-AUTH-39 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-40 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-41 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-42 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-43 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-44 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-45 | deferred (other area) | account.md:37 | — | closed (branch `t3/v2-server-gaps`) |
| P-AUTH-46 | deferred (other area) | account.md:37 | — | tested |
| P-AUTH-47 | deferred (other area) | account.md:37 | — | closed (branch `t3/v2-server-gaps`) |
| P-AUTH-48 | covered | account.md:38 | — | — |
| P-AUTH-49 | changed (approved: DECISIONS.md group C) | lead.md:10 | account.md:39 changed | — |
| P-AUTH-50 | deferred (other area) | account.md:40 | — | untested |
| P-AUTH-51 | covered | account.md:41 | — | — |
| P-AUTH-52 | covered | account.md:42 | — | — |
| P-AUTH-53 | covered | account.md:42 | — | — |
| P-AUTH-54 | covered | account.md:42 | — | — |
| P-AUTH-55 | changed (approved: DECISIONS.md group B) | account.md:43 | — | — |
| P-AUTH-56 | covered | account.md:44 | — | — |
| P-AUTH-57 | covered | account.md:44 | — | — |
| P-AUTH-58 | changed (approved: DECISIONS.md group C) | account.md:45 | — | — |
| P-AUTH-59 | deferred (other area) | account.md:46 | — | unapproved-change, change with no decision |
| P-AUTH-60 | deferred (other area) | account.md:46 | — | unapproved-change, change with no decision |
| P-AUTH-61 | deferred (other area) | account.md:46 | — | untested |
| P-AUTH-62 | deferred (other area) | account.md:46 | — | untested |
| P-AUTH-63 | covered | account.md:47 | — | — |
| P-AUTH-64 | covered | account.md:47 | — | — |
| P-AUTH-65 | covered | account.md:47 | — | — |
| P-AUTH-66 | covered | account.md:47 | — | — |
| P-AUTH-67 | covered | account.md:48 | — | — |
| P-AUTH-68 | covered | account.md:48 | — | — |
| P-AUTH-69 | deferred (other area) | account.md:49 | — | untested |
| P-AUTH-70 | deferred (other area) | account.md:49 | — | untested |
| P-AUTH-71 | deferred (other area) | account.md:49 | — | untested |
| P-AUTH-72 | deferred (other area) | account.md:26 | — | tested |
| P-AUTH-73 | deferred (other area) | account.md:26 | — | tested |
| P-GROUP-01 | covered | groups.md:15 | — | — |
| P-GROUP-02 | covered | groups.md:16 | — | — |
| P-GROUP-03 | covered | groups.md:17 | — | — |
| P-GROUP-04 | covered | groups.md:18 | — | — |
| P-GROUP-05 | covered | groups.md:18 | — | — |
| P-GROUP-06 | covered | groups.md:18 | — | — |
| P-GROUP-07 | covered | groups.md:19 | — | — |
| P-GROUP-08 | changed (approved: DECISIONS.md group G) | groups.md:20 | — | — |
| P-GROUP-09 | covered | groups.md:21 | — | — |
| P-GROUP-10 | covered | groups.md:21 | — | — |
| P-GROUP-11 | covered | groups.md:22 | — | — |
| P-GROUP-12 | covered | groups.md:22 | — | — |
| P-GROUP-13 | covered | groups.md:23 | — | — |
| P-GROUP-14 | covered | groups.md:23 | — | — |
| P-GROUP-15 | covered | groups.md:23 | — | — |
| P-GROUP-16 | covered | groups.md:23 | — | — |
| P-GROUP-17 | covered | groups.md:23 | — | — |
| P-GROUP-18 | covered | groups.md:24 | — | — |
| P-GROUP-19 | covered | groups.md:24 | — | — |
| P-GROUP-20 | changed (approved: DECISIONS.md group E) | groups.md:25 | — | — |
| P-GROUP-21 | changed (approved: DECISIONS.md group C) | groups.md:26 | — | — |
| P-GROUP-22 | changed (approved: DECISIONS.md group E) | groups.md:27 | — | — |
| P-GROUP-23 | changed (approved: PLAN.md invariant 1 and the DECISIONS.md "MCP group currency" bullet) | groups.md:33 | — | — |
| P-GROUP-24 | covered | lead.md:7 | groups.md:34 deferred | — |
| P-GROUP-25 | covered | groups.md:35 | — | — |
| P-GROUP-26 | covered | groups.md:35 | — | — |
| P-GROUP-27 | covered | groups.md:36 | — | — |
| P-GROUP-28 | covered | groups.md:36 | — | — |
| P-GROUP-29 | covered | groups.md:36 | — | — |
| P-GROUP-30 | covered | groups.md:36 | — | — |
| P-GROUP-31 | covered | groups.md:36 | — | — |
| P-GROUP-32 | covered | groups.md:37 | — | — |
| P-GROUP-33 | covered | groups.md:37 | — | — |
| P-GROUP-34 | covered | groups.md:37 | — | — |
| P-GROUP-35 | covered | groups.md:37 | — | — |
| P-GROUP-36 | covered | groups.md:37 | — | — |
| P-GROUP-37 | changed (approved: PLAN.md invariant 1 and the DECISIONS.md "MCP group currency" bullet) | groups.md:38 | — | — |
| P-GROUP-38 | covered | groups.md:39 | — | — |
| P-GROUP-39 | covered | groups.md:40 | — | — |
| P-GROUP-40 | covered | groups.md:40 | — | — |
| P-GROUP-41 | covered | groups.md:41 | — | — |
| P-GROUP-42 | covered | groups.md:41 | — | — |
| P-GROUP-43 | covered | groups.md:41 | — | — |
| P-GROUP-44 | covered | groups.md:42 | — | — |
| P-GROUP-45 | covered | groups.md:48 | — | — |
| P-GROUP-46 | covered | groups.md:49 | — | — |
| P-GROUP-47 | deferred | groups.md:50 | — | closed (branch `t3/v2-server-gaps`) |
| P-GROUP-48 | covered | lead.md:8 | groups.md:51 deferred | — |
| P-GROUP-49 | covered | groups.md:52 | — | — |
| P-GROUP-50 | deferred (other area) | groups.md:53 | — | untested |
| P-GROUP-51 | deferred (other area) | groups.md:53 | — | tested |
| P-GROUP-52 | deferred (other area) | groups.md:53 | — | tested |
| P-GROUP-53 | covered | lead.md:9 | groups.md:54 deferred | — |
| P-GROUP-54 | covered | groups.md:55 | — | — |
| P-GROUP-55 | covered | groups.md:56 | — | — |
| P-GROUP-56 | covered | groups.md:62 | — | — |
| P-GROUP-57 | covered | groups.md:62 | — | — |
| P-GROUP-58 | changed (approved: DECISIONS.md group C) | groups.md:63 | — | — |
| P-GROUP-59 | covered | groups.md:69 | — | — |
| P-GROUP-60 | covered | groups.md:69 | — | — |
| P-GROUP-61 | covered | groups.md:70 | — | — |
| P-GROUP-62 | covered | groups.md:70 | — | — |
| P-GROUP-63 | covered | groups.md:71 | — | — |
| P-GROUP-64 | covered | groups.md:72 | — | — |
| P-GROUP-65 | covered | groups.md:73 | — | — |
| P-GROUP-66 | covered | groups.md:74 | — | — |
| P-GROUP-67 | covered | groups.md:74 | — | — |
| P-GROUP-68 | covered | groups.md:74 | — | — |
| P-GROUP-69 | covered | groups.md:74 | — | — |
| P-GROUP-70 | covered | groups.md:75 | — | — |
| P-GROUP-71 | covered | groups.md:76 | — | — |
| P-GROUP-72 | covered | groups.md:75 | — | — |
| P-GROUP-73 | covered | groups.md:77 | — | — |
| P-GROUP-74 | covered | groups.md:78 | — | — |
| P-GROUP-75 | covered | groups.md:79 | — | — |
| P-GROUP-76 | changed (approved: DECISIONS.md group C) | groups.md:80 | — | — |
| P-GROUP-77 | open | groups.md:81 | — | tested |
| P-GROUP-78 | changed (no decision) | groups.md:82 | — | closed (branch `t3/v2-server-gaps`) |
| P-GROUP-79 | covered | groups.md:88 | — | — |
| P-GROUP-80 | covered | groups.md:88 | — | — |
| P-GROUP-81 | covered | groups.md:88 | — | — |
| P-GROUP-82 | covered | groups.md:89 | — | — |
| P-GROUP-83 | covered | groups.md:89 | — | — |
| P-GROUP-84 | covered | groups.md:89 | — | — |
| P-GROUP-85 | covered | groups.md:90 | — | — |
| P-GROUP-86 | covered | groups.md:91 | — | — |
| P-GROUP-87 | covered | groups.md:91 | — | — |
| P-GROUP-88 | covered | groups.md:92 | — | — |
| P-GROUP-89 | covered | groups.md:92 | — | — |
| P-GROUP-90 | covered | groups.md:93 | — | — |
| P-GROUP-91 | changed (approved: DECISIONS.md group F (English only)) | groups.md:94 | — | — |
| P-GROUP-92 | covered | groups.md:100 | — | — |
| P-GROUP-93 | covered | groups.md:100 | — | — |
| P-GROUP-94 | covered | groups.md:100 | — | — |
| P-GROUP-95 | covered | groups.md:100 | — | — |
| P-GROUP-96 | covered | groups.md:101 | — | — |
| P-GROUP-97 | covered | groups.md:102 | — | — |
| P-GROUP-98 | changed (no decision) | groups.md:103 | — | — |
| P-GROUP-99 | covered | groups.md:104 | — | — |
| P-GROUP-100 | changed (no decision) | groups.md:105 | — | — |
| P-GROUP-101 | changed (no decision) | groups.md:106 | — | — |
| P-GROUP-102 | changed (no decision) | groups.md:106 | — | — |
| P-GROUP-103 | covered | groups.md:107 | — | — |
| P-GROUP-104 | covered | groups.md:108 | — | — |
| P-GROUP-105 | changed (approved: DECISIONS.md group C) | groups.md:109 | — | — |
| P-GROUP-106 | changed (approved: DECISIONS.md group C) | groups.md:110 | — | — |
| P-EXP-01 | covered | expenses.md:37 | — | — |
| P-EXP-02 | changed (approved: DECISIONS.md group E) | expenses.md:30 | — | — |
| P-EXP-03 | covered | expenses.md:38 | — | — |
| P-EXP-04 | covered | expenses.md:39 | — | — |
| P-EXP-05 | covered | expenses.md:39 | — | — |
| P-EXP-06 | covered | expenses.md:40 | — | — |
| P-EXP-07 | covered | expenses.md:41 | — | — |
| P-EXP-08 | covered | expenses.md:39 | — | — |
| P-EXP-09 | covered | expenses.md:42 | — | — |
| P-EXP-10 | covered | expenses.md:39 | — | — |
| P-EXP-11 | changed (no decision) | expenses.md:43 | — | — |
| P-EXP-12 | covered | expenses.md:44 | — | — |
| P-EXP-13 | covered | expenses.md:44 | — | — |
| P-EXP-14 | covered | expenses.md:44 | — | — |
| P-EXP-15 | covered | expenses.md:44 | — | — |
| P-EXP-16 | covered | expenses.md:44 | — | — |
| P-EXP-17 | covered | expenses.md:44 | — | — |
| P-EXP-18 | covered | expenses.md:45 | — | — |
| P-EXP-19 | covered | expenses.md:45 | — | — |
| P-EXP-20 | changed (approved: DECISIONS.md P-EXP-20 bullet. The code now refetches on every visit (`main.tsx:12`), so v2 matches the current app) | expenses.md:46 | — | — |
| P-EXP-21 | covered | expenses.md:47 | — | — |
| P-EXP-22 | covered | AUDIT.md gap 4 | expenses.md:48 | browser check |
| P-EXP-23 | covered | expenses.md:47 | — | — |
| P-EXP-24 | covered | expenses.md:47 | — | — |
| P-EXP-25 | covered | expenses.md:47 | — | — |
| P-EXP-26 | covered | expenses.md:49 | — | — |
| P-EXP-27 | covered | expenses.md:50 | — | — |
| P-EXP-28 | covered | expenses.md:50 | — | — |
| P-EXP-29 | covered | expenses.md:50 | — | — |
| P-EXP-30 | covered | expenses.md:50 | — | — |
| P-EXP-31 | covered | expenses.md:50 | — | — |
| P-EXP-32 | covered | expenses.md:50 | — | — |
| P-EXP-33 | covered | expenses.md:50 | — | — |
| P-EXP-34 | covered | expenses.md:47 | — | — |
| P-EXP-35 | covered | expenses.md:47 | — | — |
| P-EXP-36 | covered | expenses.md:51 | — | — |
| P-EXP-37 | covered | expenses.md:51 | — | — |
| P-EXP-38 | covered | expenses.md:52 | — | — |
| P-EXP-39 | covered | expenses.md:52 | — | — |
| P-EXP-40 | covered | expenses.md:53 | — | change with no decision |
| P-EXP-41 | covered | expenses.md:53 | — | change with no decision |
| P-EXP-42 | covered | expenses.md:51 | — | — |
| P-EXP-43 | covered | expenses.md:51 | — | — |
| P-EXP-44 | covered | expenses.md:51 | — | — |
| P-EXP-45 | covered | expenses.md:51 | — | — |
| P-EXP-46 | covered | expenses.md:51 | — | — |
| P-EXP-47 | deferred | expenses.md:54 | — | tested |
| P-EXP-48 | covered | expenses.md:51 | — | — |
| P-EXP-49 | covered | expenses.md:53 | — | change with no decision |
| P-EXP-50 | covered | expenses.md:51 | — | — |
| P-EXP-51 | changed (approved: DECISIONS.md group C) | expenses.md:19 | — | — |
| P-EXP-52 | changed (approved: DECISIONS.md group C) | expenses.md:20 | — | — |
| P-EXP-53 | changed (approved: DECISIONS.md group C) | expenses.md:20 | — | — |
| P-EXP-54 | covered | expenses.md:55 | — | — |
| P-EXP-55 | covered | expenses.md:55 | — | — |
| P-EXP-56 | covered | expenses.md:55 | — | — |
| P-EXP-57 | covered | expenses.md:55 | — | — |
| P-EXP-58 | covered | expenses.md:55 | — | — |
| P-EXP-59 | covered | expenses.md:55 | — | — |
| P-EXP-60 | covered | expenses.md:55 | — | — |
| P-EXP-61 | changed (approved: DECISIONS.md group C) | expenses.md:21 | expenses.md:55 covered | — |
| P-EXP-62 | covered | expenses.md:55 | — | — |
| P-EXP-63 | covered | expenses.md:56 | — | — |
| P-EXP-64 | covered | expenses.md:56 | — | — |
| P-EXP-65 | covered | expenses.md:56 | — | — |
| P-EXP-66 | covered | expenses.md:56 | — | — |
| P-EXP-67 | covered | expenses.md:56 | — | — |
| P-EXP-68 | covered | expenses.md:56 | — | — |
| P-EXP-69 | covered | expenses.md:55 | — | — |
| P-EXP-70 | covered | expenses.md:56 | — | — |
| P-EXP-71 | covered | expenses.md:56 | — | — |
| P-EXP-72 | covered | expenses.md:56 | — | — |
| P-EXP-73 | covered | expenses.md:56 | — | — |
| P-EXP-74 | covered | expenses.md:56 | — | — |
| P-EXP-75 | covered | expenses.md:56 | — | — |
| P-EXP-76 | covered | expenses.md:56 | — | — |
| P-EXP-77 | covered | expenses.md:56 | — | — |
| P-EXP-78 | covered | expenses.md:55 | — | — |
| P-EXP-79 | covered | expenses.md:55 | — | — |
| P-EXP-80 | covered | expenses.md:55 | — | — |
| P-EXP-81 | covered | expenses.md:55 | — | — |
| P-EXP-82 | covered | expenses.md:55 | — | — |
| P-EXP-83 | covered | expenses.md:55 | — | — |
| P-EXP-84 | covered | expenses.md:57 | — | — |
| P-EXP-85 | covered | expenses.md:57 | — | — |
| P-EXP-86 | covered | expenses.md:57 | — | — |
| P-EXP-87 | covered | expenses.md:58 | — | — |
| P-EXP-88 | covered | expenses.md:58 | — | — |
| P-EXP-89 | covered | expenses.md:58 | — | — |
| P-EXP-90 | covered | expenses.md:58 | — | — |
| P-EXP-91 | covered | expenses.md:58 | — | — |
| P-EXP-92 | covered | expenses.md:58 | — | — |
| P-EXP-93 | covered | expenses.md:59 | — | — |
| P-EXP-94 | covered | expenses.md:59 | — | — |
| P-EXP-95 | covered | expenses.md:59 | — | — |
| P-EXP-96 | covered | expenses.md:60 | — | — |
| P-EXP-97 | changed (approved: DECISIONS.md group G) | expenses.md:31 | — | — |
| P-EXP-98 | changed (no decision) | expenses.md:30 | — | — |
| P-EXP-99 | covered | expenses.md:61 | — | — |
| P-EXP-100 | covered | expenses.md:61 | — | — |
| P-EXP-101 | covered | expenses.md:61 | — | — |
| P-EXP-102 | changed (approved: DECISIONS.md group C) | expenses.md:22 | — | — |
| P-EXP-103 | changed (approved: DECISIONS.md group C) | expenses.md:23 | — | — |
| P-EXP-104 | covered | expenses.md:62 | — | — |
| P-EXP-105 | deferred | expenses.md:63 | — | tested |
| P-EXP-106 | covered | expenses.md:62 | — | — |
| P-EXP-107 | deferred | expenses.md:64 | — | closed (branch `t3/v2-server-gaps`) |
| P-EXP-108 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-109 | covered | expenses.md:66 | — | — |
| P-EXP-110 | covered | expenses.md:66 | — | — |
| P-EXP-111 | deferred | expenses.md:67 | — | tested |
| P-EXP-112 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-113 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-114 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-115 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-116 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-117 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-118 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-119 | deferred (other area) | expenses.md:65 | — | tested |
| P-EXP-120 | covered | expenses.md:66 | — | — |
| P-EXP-121 | deferred | expenses.md:68 | — | tested |
| P-EXP-122 | covered | expenses.md:69 | — | — |
| P-EXP-123 | covered | expenses.md:70 | — | — |
| P-EXP-124 | changed (approved: DECISIONS.md group B (the RPC form of P-TOOL-CREATEEXP-14)) | expenses.md:24 | — | — |
| P-EXP-125 | covered | expenses.md:66 | — | — |
| P-EXP-126 | deferred | expenses.md:71 | — | tested |
| P-EXP-127 | deferred | expenses.md:71 | — | tested |
| P-EXP-128 | deferred | expenses.md:72 | — | untested |
| P-EXP-129 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | expenses.md:73 | — | — |
| P-EXP-130 | deferred | expenses.md:63 | — | tested |
| P-EXP-131 | covered | expenses.md:74 | — | — |
| P-EXP-132 | covered | expenses.md:66 | — | — |
| P-EXP-133 | covered | expenses.md:66 | — | — |
| P-EXP-134 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | expenses.md:73 | — | — |
| P-EXP-135 | covered | expenses.md:75 | — | — |
| P-EXP-136 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | expenses.md:73 | — | — |
| P-EXP-137 | covered | expenses.md:66 | — | — |
| P-EXP-138 | deferred | expenses.md:72 | — | tested |
| P-EXP-139 | changed (no decision) | expenses.md:76 | — | — |
| P-EXP-140 | covered | expenses.md:66 | — | — |
| P-EXP-141 | covered | expenses.md:66 | — | — |
| P-EXP-142 | covered | expenses.md:77 | — | — |
| P-EXP-143 | covered | expenses.md:78 | — | — |
| P-MONEY-01 | covered | expenses.md:84 | — | — |
| P-MONEY-02 | covered | expenses.md:84 | — | — |
| P-MONEY-03 | covered | expenses.md:84 | — | — |
| P-MONEY-04 | covered | expenses.md:84 | — | — |
| P-MONEY-05 | covered | expenses.md:84 | — | — |
| P-MONEY-06 | covered | expenses.md:84 | — | — |
| P-MONEY-07 | covered | expenses.md:84 | — | — |
| P-MONEY-08 | covered | expenses.md:84 | — | — |
| P-MONEY-09 | covered | expenses.md:84 | — | — |
| P-MONEY-10 | covered | expenses.md:84 | — | — |
| P-MONEY-11 | covered | expenses.md:84 | — | — |
| P-MONEY-12 | covered | expenses.md:84 | — | — |
| P-MONEY-13 | covered | expenses.md:84 | — | — |
| P-MONEY-14 | covered | expenses.md:84 | — | — |
| P-MONEY-15 | covered | expenses.md:84 | — | — |
| P-MONEY-16 | covered | expenses.md:84 | — | — |
| P-MONEY-17 | covered | expenses.md:84 | — | — |
| P-MONEY-18 | covered | expenses.md:85 | — | — |
| P-MONEY-19 | covered | expenses.md:85 | — | — |
| P-MONEY-20 | covered | expenses.md:84 | — | — |
| P-MONEY-21 | covered | expenses.md:84 | — | — |
| P-MONEY-22 | covered | expenses.md:86 | — | — |
| P-MONEY-23 | covered | expenses.md:86 | — | — |
| P-MONEY-24 | covered | expenses.md:86 | — | — |
| P-MONEY-25 | covered | expenses.md:86 | — | — |
| P-MONEY-26 | deferred | expenses.md:87 | — | tested |
| P-MONEY-27 | deferred | expenses.md:87 | — | untested |
| P-MONEY-28 | deferred | expenses.md:87 | — | not-applicable |
| P-MONEY-29 | covered | expenses.md:88 | — | — |
| P-MONEY-30 | covered | expenses.md:89 | — | — |
| P-MONEY-31 | deferred | expenses.md:87 | — | tested |
| P-MONEY-32 | covered | expenses.md:84 | — | — |
| P-MONEY-33 | changed (approved: DECISIONS.md group E) | expenses.md:90 | — | — |
| P-MONEY-34 | covered | expenses.md:84 | — | — |
| P-MONEY-35 | changed (approved: DECISIONS.md group C) | expenses.md:21 | expenses.md:84 covered | — |
| P-MONEY-36 | covered | expenses.md:84 | — | — |
| P-MONEY-37 | covered | expenses.md:84 | — | — |
| P-MONEY-38 | covered | expenses.md:84 | — | — |
| P-MONEY-39 | covered | expenses.md:84 | — | — |
| P-MONEY-40 | covered | expenses.md:84 | — | — |
| P-MONEY-41 | covered | expenses.md:84 | — | — |
| P-MONEY-42 | covered | expenses.md:84 | — | — |
| P-MONEY-43 | covered | expenses.md:84 | — | — |
| P-MONEY-44 | covered | expenses.md:84 | — | — |
| P-MONEY-45 | covered | expenses.md:84 | — | — |
| P-MONEY-46 | covered | expenses.md:84 | — | — |
| P-MONEY-47 | covered | expenses.md:84 | — | — |
| P-MONEY-48 | covered | expenses.md:84 | — | — |
| P-MONEY-49 | covered | expenses.md:84 | — | — |
| P-MONEY-50 | covered | expenses.md:84 | — | — |
| P-MONEY-51 | covered | expenses.md:84 | — | — |
| P-MONEY-52 | covered | expenses.md:84 | — | — |
| P-MONEY-53 | covered | expenses.md:84 | — | — |
| P-MONEY-54 | covered | expenses.md:84 | — | — |
| P-MONEY-55 | covered | expenses.md:84 | — | — |
| P-MONEY-56 | covered | expenses.md:84 | — | — |
| P-MONEY-57 | covered | expenses.md:84 | — | — |
| P-MONEY-58 | covered | expenses.md:84 | — | — |
| P-MONEY-59 | covered | expenses.md:84 | — | — |
| P-MONEY-60 | covered | expenses.md:84 | — | — |
| P-MONEY-61 | covered | expenses.md:84 | — | — |
| P-MONEY-62 | covered | expenses.md:84 | — | — |
| P-MONEY-63 | covered | expenses.md:84 | — | — |
| P-MONEY-64 | covered | expenses.md:84 | — | — |
| P-MONEY-65 | covered | expenses.md:84 | — | — |
| P-MONEY-66 | covered | expenses.md:84 | — | — |
| P-MONEY-67 | covered | expenses.md:84 | — | — |
| P-MONEY-68 | covered | expenses.md:84 | — | — |
| P-MONEY-69 | covered | expenses.md:84 | — | — |
| P-MONEY-70 | covered | expenses.md:84 | — | — |
| P-MONEY-71 | covered | expenses.md:84 | — | — |
| P-MONEY-72 | covered | expenses.md:84 | — | — |
| P-MONEY-73 | covered | expenses.md:84 | — | — |
| P-MONEY-74 | covered | expenses.md:84 | — | — |
| P-MONEY-75 | covered | expenses.md:84 | — | — |
| P-MONEY-76 | covered | expenses.md:84 | — | — |
| P-MONEY-77 | covered | expenses.md:84 | — | — |
| P-MONEY-78 | covered | expenses.md:84 | — | — |
| P-MONEY-79 | covered | expenses.md:84 | — | — |
| P-MONEY-80 | covered | expenses.md:91 | — | — |
| P-MONEY-81 | covered | expenses.md:91 | — | — |
| P-MONEY-82 | covered | expenses.md:91 | — | — |
| P-MONEY-83 | covered | expenses.md:91 | — | — |
| P-MONEY-84 | covered | expenses.md:91 | — | — |
| P-MONEY-85 | covered | expenses.md:91 | — | — |
| P-MONEY-86 | covered | expenses.md:91 | — | — |
| P-MONEY-87 | covered | expenses.md:91 | — | — |
| P-MONEY-88 | covered | expenses.md:91 | — | — |
| P-MONEY-89 | covered | expenses.md:91 | — | — |
| P-MONEY-90 | covered | expenses.md:91 | — | — |
| P-MONEY-91 | covered | expenses.md:92 | — | — |
| P-MONEY-92 | covered | expenses.md:92 | — | — |
| P-MONEY-93 | covered | expenses.md:92 | — | — |
| P-MONEY-94 | covered | expenses.md:92 | — | — |
| P-MONEY-95 | covered | expenses.md:91 | — | — |
| P-MONEY-100 | covered | expenses.md:94 | — | — |
| P-MONEY-101 | covered | expenses.md:95 | — | change with no decision |
| P-MONEY-96 | covered | expenses.md:93 | — | — |
| P-MONEY-97 | covered | expenses.md:93 | — | — |
| P-MONEY-98 | covered | expenses.md:93 | — | — |
| P-MONEY-99 | covered | expenses.md:93 | — | — |
| P-BAL-01 | covered | expenses.md:101 | — | — |
| P-BAL-02 | covered | expenses.md:101 | — | — |
| P-BAL-03 | covered | expenses.md:101 | — | — |
| P-BAL-04 | covered | expenses.md:101 | — | — |
| P-BAL-05 | covered | expenses.md:101 | — | — |
| P-BAL-06 | covered | expenses.md:101 | — | — |
| P-BAL-07 | covered | expenses.md:101 | — | — |
| P-BAL-08 | covered | expenses.md:101 | — | — |
| P-BAL-09 | covered | expenses.md:101 | — | — |
| P-BAL-10 | covered | expenses.md:101 | — | — |
| P-BAL-11 | covered | expenses.md:101 | — | — |
| P-BAL-12 | covered | expenses.md:101 | — | — |
| P-BAL-13 | covered | expenses.md:101 | — | — |
| P-BAL-14 | covered | expenses.md:101 | — | — |
| P-BAL-15 | covered | expenses.md:101 | — | — |
| P-BAL-16 | covered | expenses.md:101 | — | — |
| P-BAL-17 | covered | expenses.md:101 | — | — |
| P-BAL-18 | covered | expenses.md:101 | — | — |
| P-BAL-19 | covered | expenses.md:101 | — | — |
| P-BAL-20 | covered | expenses.md:101 | — | — |
| P-BAL-21 | covered | expenses.md:101 | — | — |
| P-BAL-22 | covered | expenses.md:101 | — | — |
| P-BAL-23 | covered | expenses.md:101 | — | — |
| P-BAL-24 | covered | expenses.md:102 | — | — |
| P-BAL-25 | deferred | expenses.md:103 | — | tested |
| P-BAL-26 | covered | expenses.md:102 | — | — |
| P-BAL-27 | deferred | expenses.md:104 | — | tested |
| P-BAL-28 | deferred | expenses.md:104 | — | tested |
| P-BAL-29 | deferred | expenses.md:104 | — | tested |
| P-BAL-30 | changed (approved: DECISIONS.md group C) | expenses.md:25 | — | — |
| P-BAL-31 | covered | expenses.md:102 | — | — |
| P-BAL-32 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-33 | deferred | expenses.md:105 | feed.md:167 deferred | tested |
| P-BAL-34 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-35 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-36 | deferred | expenses.md:105 | feed.md:167 deferred | tested |
| P-BAL-37 | deferred | expenses.md:105 | feed.md:167 deferred | tested |
| P-BAL-38 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-39 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-40 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-41 | covered | feed.md:166 | expenses.md:105 deferred | — |
| P-BAL-42 | deferred | expenses.md:105 | feed.md:167 deferred | tested |
| P-BAL-43 | covered | expenses.md:106 | — | — |
| P-BAL-44 | covered | expenses.md:106 | — | — |
| P-BAL-45 | covered | expenses.md:106 | — | — |
| P-BAL-46 | covered | expenses.md:106 | — | — |
| P-BAL-47 | covered | expenses.md:106 | — | — |
| P-BAL-48 | covered | expenses.md:106 | — | — |
| P-BAL-49 | covered | expenses.md:106 | — | — |
| P-BAL-50 | covered | expenses.md:106 | — | — |
| P-BAL-51 | covered | expenses.md:107 | — | — |
| P-BAL-52 | deferred (other area) | expenses.md:108 | — | tested |
| P-BAL-53 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-54 | covered | AUDIT.md gap 1 | expenses.md:108 | browser check |
| P-BAL-55 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-56 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-57 | deferred (other area) | expenses.md:108 | — | untested |
| P-BAL-58 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-59 | deferred (other area) | expenses.md:108 | — | untested |
| P-BAL-60 | covered | AUDIT.md gap 1 | expenses.md:108 | browser check |
| P-BAL-61 | deferred (other area) | expenses.md:108 | — | untested |
| P-BAL-62 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-63 | covered | AUDIT.md gap 1 | expenses.md:108 | tested |
| P-BAL-64 | deferred (other area) | expenses.md:108 | — | approved-change |
| P-BAL-65 | covered | expenses.md:109 | — | — |
| P-BAL-66 | covered | expenses.md:109 | — | — |
| P-BAL-67 | covered | expenses.md:109 | — | — |
| P-BAL-68 | covered | expenses.md:109 | — | — |
| P-BAL-69 | covered | expenses.md:109 | — | — |
| P-BAL-70 | covered | expenses.md:109 | — | — |
| P-BAL-71 | covered | expenses.md:109 | — | — |
| P-BAL-72 | covered | expenses.md:109 | — | — |
| P-BAL-73 | covered | expenses.md:109 | — | — |
| P-BAL-74 | covered | expenses.md:109 | — | — |
| P-BAL-75 | covered | expenses.md:109 | — | — |
| P-BAL-76 | covered | expenses.md:109 | — | — |
| P-BAL-77 | covered | expenses.md:109 | — | — |
| P-BAL-78 | covered | expenses.md:109 | — | — |
| P-BAL-79 | covered | expenses.md:109 | — | — |
| P-BAL-80 | covered | expenses.md:109 | — | — |
| P-BAL-81 | covered | expenses.md:109 | — | — |
| P-BAL-82 | covered | expenses.md:109 | — | — |
| P-BAL-83 | covered | expenses.md:109 | — | — |
| P-BAL-84 | covered | expenses.md:109 | — | — |
| P-BAL-85 | covered | expenses.md:109 | — | — |
| P-BAL-86 | covered | expenses.md:109 | — | — |
| P-BAL-87 | covered | expenses.md:109 | — | — |
| P-BAL-88 | covered | expenses.md:109 | — | — |
| P-BAL-89 | covered | expenses.md:109 | — | — |
| P-BAL-90 | deferred | expenses.md:110 | — | untested |
| P-BAL-91 | covered | expenses.md:109 | — | — |
| P-BAL-92 | changed (approved: DECISIONS.md group C and the P-BAL-92 bullet) | expenses.md:26 | feed.md:168 changed | — |
| P-BAL-93 | changed (approved: DECISIONS.md group D and the P-BAL-93 bullet (keep)) | expenses.md:27 | — | — |
| P-BAL-94 | covered | feed.md:163 | expenses.md:111 deferred | — |
| P-BAL-95 | covered | feed.md:163 | expenses.md:111 deferred | — |
| P-BAL-96 | covered | feed.md:163 | expenses.md:111 deferred | — |
| P-BAL-97 | covered | feed.md:163 | expenses.md:111 deferred | — |
| P-BAL-98 | covered | feed.md:164 | expenses.md:112 deferred | — |
| P-BAL-99 | covered | feed.md:164 | expenses.md:112 deferred | — |
| P-BAL-100 | covered | feed.md:164 | expenses.md:112 deferred | — |
| P-BAL-101 | covered | feed.md:164 | expenses.md:112 deferred | — |
| P-BAL-102 | deferred | expenses.md:112 | feed.md:165 deferred | tested |
| P-BAL-103 | deferred | expenses.md:112 | feed.md:165 deferred | untested |
| P-BAL-104 | deferred | expenses.md:112 | feed.md:165 deferred | untested |
| P-BAL-105 | deferred | expenses.md:112 | feed.md:165 deferred | untested |
| P-BAL-106 | deferred | expenses.md:112 | feed.md:165 deferred | approved-change |
| P-RECUR-01 | covered | expenses.md:118 | — | — |
| P-RECUR-02 | covered | expenses.md:118 | — | — |
| P-RECUR-03 | deferred | expenses.md:119 | — | tested |
| P-RECUR-04 | covered | expenses.md:118 | — | — |
| P-RECUR-05 | covered | expenses.md:118 | — | — |
| P-RECUR-06 | covered | expenses.md:120 | — | — |
| P-RECUR-07 | changed (approved: DECISIONS.md group C) | expenses.md:28 | — | — |
| P-RECUR-08 | changed (approved: DECISIONS.md group C) | expenses.md:25 | — | — |
| P-RECUR-09 | covered | expenses.md:120 | — | — |
| P-RECUR-10 | covered | expenses.md:121 | — | — |
| P-RECUR-11 | covered (approved: DECISIONS.md group C) | expenses.md:121 | expenses.md:25 changed | — |
| P-RECUR-12 | covered | expenses.md:122 | — | — |
| P-RECUR-13 | covered | expenses.md:120 | — | — |
| P-RECUR-14 | covered | expenses.md:122 | — | — |
| P-RECUR-15 | covered | expenses.md:120 | — | — |
| P-RECUR-16 | covered | expenses.md:120 | — | — |
| P-RECUR-17 | covered | expenses.md:120 | — | — |
| P-RECUR-18 | covered | expenses.md:120 | — | — |
| P-RECUR-19 | covered | expenses.md:120 | — | — |
| P-RECUR-20 | changed (approved: DECISIONS.md group C) | expenses.md:29 | — | — |
| P-RECUR-21 | changed (approved: DECISIONS.md group C) | expenses.md:29 | — | — |
| P-RECUR-22 | covered | expenses.md:120 | — | — |
| P-RECUR-23 | covered | expenses.md:120 | — | — |
| P-RECUR-24 | covered | expenses.md:123 | — | — |
| P-RECUR-25 | covered | expenses.md:124 | — | — |
| P-UNGROUP-01 | code | feed.md:89 | — | — |
| P-UNGROUP-02 | code | feed.md:90 | — | — |
| P-UNGROUP-03 | covered | feed.md:91 | — | — |
| P-UNGROUP-04 | code | feed.md:92 | — | — |
| P-UNGROUP-05 | covered | feed.md:93 | — | — |
| P-UNGROUP-06 | covered | feed.md:94 | — | — |
| P-UNGROUP-07 | covered | feed.md:95 | — | — |
| P-UNGROUP-08 | covered | feed.md:96 | — | — |
| P-UNGROUP-09 | code | feed.md:97 | — | — |
| P-UNGROUP-10 | covered | feed.md:98 | — | — |
| P-UNGROUP-11 | covered | feed.md:99 | — | — |
| P-UNGROUP-12 | covered | feed.md:100 | — | — |
| P-UNGROUP-13 | covered | feed.md:101 | — | — |
| P-UNGROUP-14 | covered | feed.md:102 | — | — |
| P-UNGROUP-15 | covered | feed.md:103 | — | change with no decision |
| P-UNGROUP-16 | code | feed.md:104 | — | — |
| P-UNGROUP-17 | covered | feed.md:105 | — | — |
| P-UNGROUP-18 | code | feed.md:106 | — | — |
| P-UNGROUP-19 | covered | feed.md:107 | — | — |
| P-UNGROUP-20 | covered | feed.md:108 | — | — |
| P-UNGROUP-21 | covered | feed.md:109 | — | — |
| P-UNGROUP-22 | covered | feed.md:110 | — | — |
| P-UNGROUP-23 | covered | feed.md:111 | — | — |
| P-UNGROUP-24 | covered | feed.md:112 | — | — |
| P-UNGROUP-25 | covered | feed.md:113 | — | — |
| P-UNGROUP-26 | changed (approved: DECISIONS.md bullet on retries of a private-expense create) | feed.md:114 | — | — |
| P-UNGROUP-27 | covered | feed.md:115 | — | — |
| P-UNGROUP-28 | covered | feed.md:116 | — | — |
| P-UNGROUP-29 | covered | feed.md:117 | — | — |
| P-UNGROUP-30 | covered | feed.md:118 | — | — |
| P-UNGROUP-31 | covered | feed.md:119 | — | — |
| P-UNGROUP-32 | covered | feed.md:120 | — | — |
| P-UNGROUP-33 | deferred | feed.md:121 | — | tested |
| P-UNGROUP-34 | deferred | feed.md:121 | — | tested |
| P-UNGROUP-35 | deferred | feed.md:121 | — | untested |
| P-UNGROUP-36 | deferred | feed.md:121 | — | untested |
| P-UNGROUP-37 | covered | feed.md:122 | — | — |
| P-UNGROUP-38 | covered | feed.md:123 | — | — |
| P-UNGROUP-39 | deferred | feed.md:124 | — | closed (branch `t3/v2-server-gaps`) |
| P-UNGROUP-40 | covered | feed.md:125 | — | — |
| P-UNGROUP-41 | deferred | feed.md:126 | — | tested |
| P-UNGROUP-42 | deferred | feed.md:127 | — | tested |
| P-UNGROUP-43 | deferred | feed.md:128 | — | untested |
| P-UNGROUP-44 | deferred | feed.md:129 | — | untested |
| P-UNGROUP-45 | covered | feed.md:130 | — | — |
| P-UNGROUP-46 | covered | feed.md:131 | — | — |
| P-UNGROUP-47 | covered | feed.md:132 | — | — |
| P-UNGROUP-48 | covered | feed.md:133 | — | — |
| P-UNGROUP-49 | covered | feed.md:134 | — | — |
| P-UNGROUP-50 | covered | feed.md:135 | — | — |
| P-UNGROUP-51 | covered | feed.md:136 | — | — |
| P-UNGROUP-52 | changed (no decision) | feed.md:137 | — | — |
| P-UNGROUP-53 | covered | feed.md:138 | — | — |
| P-UNGROUP-54 | covered | feed.md:139 | — | — |
| P-UNGROUP-55 | covered | feed.md:140 | — | — |
| P-UNGROUP-56 | covered | feed.md:141 | — | — |
| P-UNGROUP-57 | covered | feed.md:142 | — | — |
| P-UNGROUP-58 | changed (no decision) | feed.md:143 | — | — |
| P-UNGROUP-59 | covered | feed.md:144 | — | — |
| P-UNGROUP-60 | covered | feed.md:145 | — | — |
| P-UNGROUP-61 | covered | feed.md:146 | — | — |
| P-UNGROUP-62 | deferred | feed.md:147 | — | tested |
| P-UNGROUP-63 | deferred | feed.md:148 | — | untested |
| P-UNGROUP-64 | covered | feed.md:149 | — | — |
| P-UNGROUP-65 | covered | feed.md:150 | — | — |
| P-UNGROUP-66 | covered | feed.md:151 | — | — |
| P-UNGROUP-67 | covered | feed.md:152 | — | — |
| P-UNGROUP-68 | covered | feed.md:153 | — | — |
| P-UNGROUP-69 | covered | feed.md:154 | — | — |
| P-UNGROUP-70 | covered | feed.md:155 | — | — |
| P-UNGROUP-71 | covered | feed.md:156 | — | — |
| P-UNGROUP-72 | covered | feed.md:157 | — | — |
| P-FEED-01 | covered | feed.md:44 | — | — |
| P-FEED-02 | covered | feed.md:45 | — | — |
| P-FEED-03 | code | feed.md:46 | — | — |
| P-FEED-04 | covered | feed.md:47 | — | — |
| P-FEED-05 | covered | feed.md:48 | — | — |
| P-FEED-06 | covered | feed.md:49 | — | — |
| P-FEED-07 | covered | feed.md:50 | — | — |
| P-FEED-08 | covered | feed.md:51 | — | — |
| P-FEED-09 | code | feed.md:52 | — | — |
| P-FEED-10 | deferred | feed.md:53 | — | tested |
| P-FEED-11 | covered | feed.md:54 | — | — |
| P-FEED-12 | changed (no decision) | feed.md:55 | — | — |
| P-FEED-13 | covered | feed.md:56 | — | — |
| P-FEED-14 | code | feed.md:57 | — | — |
| P-FEED-15 | covered | feed.md:58 | — | — |
| P-FEED-16 | covered | feed.md:59 | — | — |
| P-FEED-17 | covered | feed.md:60 | — | — |
| P-FEED-18 | changed (approved: DECISIONS.md group C) | feed.md:61 | — | — |
| P-FEED-19 | changed (approved: DECISIONS.md group C and the P-FEED-19 bullet) | feed.md:62 | — | — |
| P-FEED-20 | covered | feed.md:63 | — | — |
| P-FEED-21 | covered | feed.md:64 | — | — |
| P-FEED-22 | covered | feed.md:65 | — | — |
| P-FEED-23 | changed (approved: DECISIONS.md group F (English only)) | feed.md:66 | — | — |
| P-FEED-24 | covered | feed.md:67 | — | — |
| P-FEED-25 | covered | feed.md:68 | — | — |
| P-FEED-26 | covered | feed.md:69 | — | — |
| P-FEED-27 | covered | feed.md:70 | — | — |
| P-FEED-28 | covered | feed.md:71 | — | — |
| P-FEED-29 | covered | feed.md:72 | — | — |
| P-FEED-30 | code | feed.md:73 | — | — |
| P-FEED-31 | covered | feed.md:74 | — | — |
| P-FEED-32 | covered | feed.md:75 | — | — |
| P-FEED-33 | covered | feed.md:76 | — | — |
| P-FEED-34 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | feed.md:77 | — | — |
| P-FEED-35 | covered | feed.md:78 | — | — |
| P-FEED-36 | covered | feed.md:79 | — | — |
| P-FEED-37 | covered | feed.md:80 | — | — |
| P-FEED-38 | covered | feed.md:81 | — | — |
| P-FEED-39 | covered | feed.md:82 | — | — |
| P-FEED-40 | deferred | feed.md:83 | — | closed (branch `t3/v2-server-gaps`) |
| P-HIST-01 | deferred (other area) | history.md:23 | — | tested |
| P-HIST-02 | covered | history.md:24 | — | — |
| P-HIST-03 | deferred (other area) | history.md:25 | — | closed (branch `t3/v2-server-gaps`) |
| P-HIST-04 | deferred (other area) | history.md:25 | — | tested |
| P-HIST-05 | deferred (other area) | history.md:23 | — | tested |
| P-HIST-06 | deferred (other area) | history.md:23 | — | tested |
| P-HIST-07 | covered | history.md:26 | — | — |
| P-HIST-08 | deferred (other area) | history.md:27 | — | tested |
| P-HIST-09 | changed (no decision) | history.md:28 | — | closed (branch `t3/v2-server-gaps`) |
| P-HIST-10 | deferred (other area) | history.md:23 | — | tested |
| P-HIST-11 | deferred (other area) | history.md:23 | — | untested |
| P-HIST-12 | deferred (other area) | history.md:23 | — | untested |
| P-HIST-13 | deferred (other area) | history.md:29 | — | tested |
| P-HIST-14 | deferred (other area) | history.md:23 | — | tested |
| P-HIST-15 | deferred (other area) | history.md:23 | — | untested |
| P-HIST-16 | deferred (other area) | history.md:29 | — | untested |
| P-HIST-17 | deferred (other area) | history.md:23 | — | untested |
| P-HIST-18 | deferred (other area) | history.md:30 | — | tested |
| P-HIST-19 | covered | history.md:31 | — | — |
| P-HIST-20 | covered | history.md:31 | — | — |
| P-HIST-21 | deferred (other area) | history.md:32 | — | tested |
| P-HIST-22 | deferred (other area) | history.md:32 | — | not-applicable |
| P-HIST-23 | deferred (other area) | history.md:27 | — | tested |
| P-HIST-24 | deferred (other area) | history.md:33 | — | tested |
| P-HIST-25 | deferred (other area) | history.md:33 | — | tested |
| P-HIST-26 | deferred (other area) | history.md:33 | — | tested |
| P-HIST-27 | deferred (other area) | history.md:33 | — | not-applicable |
| P-HIST-28 | covered | history.md:34 | — | — |
| P-HIST-29 | covered | history.md:35 | — | — |
| P-HIST-30 | covered | history.md:36 | — | — |
| P-HIST-31 | covered | history.md:37 | — | — |
| P-HIST-32 | covered | history.md:38 | — | — |
| P-HIST-33 | covered | history.md:39 | — | — |
| P-HIST-34 | covered | history.md:36 | — | — |
| P-HIST-35 | covered | history.md:40 | — | — |
| P-HIST-36 | covered | history.md:41 | — | — |
| P-HIST-37 | covered | history.md:42 | — | — |
| P-HIST-38 | covered | history.md:42 | — | — |
| P-HIST-39 | covered | history.md:43 | — | — |
| P-HIST-40 | covered | history.md:44 | — | — |
| P-HIST-41 | covered | history.md:45 | — | — |
| P-HIST-42 | covered | history.md:42 | — | — |
| P-HIST-43 | covered | history.md:45 | — | — |
| P-HIST-44 | covered | history.md:46 | — | — |
| P-HIST-45 | covered | history.md:46 | — | — |
| P-HIST-46 | covered | history.md:46 | — | — |
| P-HIST-47 | covered | history.md:46 | — | — |
| P-HIST-48 | covered | history.md:46 | — | — |
| P-HIST-49 | code | history.md:47 | — | — |
| P-HIST-50 | covered | history.md:48 | — | — |
| P-HIST-51 | covered | history.md:48 | — | — |
| P-HIST-52 | covered | history.md:48 | — | — |
| P-HIST-53 | covered | history.md:48 | — | — |
| P-HIST-54 | covered | history.md:48 | — | — |
| P-HIST-55 | covered | history.md:48 | — | — |
| P-HIST-56 | covered | history.md:48 | — | — |
| P-HIST-57 | covered | history.md:48 | — | — |
| P-HIST-58 | covered | history.md:48 | — | — |
| P-HIST-59 | covered | history.md:49 | — | — |
| P-HIST-60 | deferred (other area) | history.md:50 | — | tested |
| P-HIST-61 | deferred (other area) | history.md:50 | — | tested |
| P-HIST-62 | covered | history.md:51 | — | — |
| P-HIST-63 | deferred (other area) | history.md:52 | — | closed (branch `t3/v2-server-gaps`) |
| P-HIST-64 | covered | history.md:53 | — | — |
| P-HIST-65 | covered | history.md:54 | — | — |
| P-HIST-66 | covered | history.md:55 | — | — |
| P-HIST-67 | covered | history.md:55 | — | — |
| P-HIST-68 | changed (approved: DECISIONS.md group G) | history.md:56 | — | — |
| P-HIST-69 | covered | history.md:53 | — | — |
| P-HIST-70 | changed (approved: DECISIONS.md group C) | history.md:57 | — | — |
| P-HIST-71 | covered | history.md:58 | — | — |
| P-HIST-72 | changed (no decision) | history.md:59 | history.md:58 covered | — |
| P-HIST-73 | covered | history.md:58 | — | — |
| P-HIST-74 | covered | history.md:58 | — | — |
| P-HIST-75 | changed (approved: DECISIONS.md group G) | history.md:60 | — | — |
| P-HIST-76 | changed (approved: DECISIONS.md bullet "Revision snapshots record the expense's receipts". The code now stores them (`shared/history.ts:93`), so the record's gap is closed) | history.md:61 | history.md:58 covered | — |
| P-HIST-77 | covered | history.md:58 | — | — |
| P-HIST-78 | covered | history.md:58 | — | — |
| P-HIST-79 | covered | history.md:58 | — | — |
| P-HIST-80 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-81 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-82 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-83 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-84 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-85 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-86 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-87 | covered | lead.md:15 | history.md:62 deferred (other area) | — |
| P-HIST-88 | covered | history.md:63 | — | — |
| P-RECEIPT-01 | covered | expenses.md:130 | — | — |
| P-RECEIPT-02 | covered | expenses.md:131 | — | — |
| P-RECEIPT-03 | covered | expenses.md:131 | — | — |
| P-RECEIPT-04 | covered | expenses.md:131 | — | — |
| P-RECEIPT-05 | covered | expenses.md:131 | — | — |
| P-RECEIPT-06 | covered | expenses.md:132 | — | change with no decision |
| P-RECEIPT-07 | covered | expenses.md:131 | — | — |
| P-RECEIPT-08 | covered | expenses.md:133 | — | — |
| P-RECEIPT-09 | covered | expenses.md:134 | — | — |
| P-RECEIPT-10 | covered | expenses.md:134 | — | — |
| P-RECEIPT-11 | covered | expenses.md:134 | — | — |
| P-RECEIPT-12 | covered | expenses.md:134 | — | — |
| P-RECEIPT-13 | covered | expenses.md:134 | — | — |
| P-RECEIPT-14 | covered | expenses.md:134 | — | — |
| P-RECEIPT-15 | covered | expenses.md:135 | expenses.md:134 covered | — |
| P-RECEIPT-16 | covered | expenses.md:134 | — | — |
| P-RECEIPT-17 | changed (no decision) | expenses.md:136 | expenses.md:134 covered | — |
| P-RECEIPT-18 | covered | expenses.md:134 | — | — |
| P-RECEIPT-19 | covered | expenses.md:134 | — | — |
| P-RECEIPT-20 | covered | expenses.md:134 | — | — |
| P-RECEIPT-21 | covered | expenses.md:134 | — | — |
| P-RECEIPT-22 | covered | expenses.md:137 | — | — |
| P-RECEIPT-23 | covered | expenses.md:134 | — | — |
| P-RECEIPT-24 | covered | expenses.md:134 | — | — |
| P-RECEIPT-25 | covered | expenses.md:134 | — | — |
| P-RECEIPT-26 | covered | expenses.md:138 | — | — |
| P-RECEIPT-27 | covered | expenses.md:139 | — | — |
| P-RECEIPT-28 | covered | expenses.md:140 | — | — |
| P-RECEIPT-29 | covered | expenses.md:141 | — | — |
| P-RECEIPT-30 | covered | expenses.md:141 | — | — |
| P-RECEIPT-31 | covered | expenses.md:141 | — | — |
| P-RECEIPT-32 | covered | expenses.md:142 | — | — |
| P-RECEIPT-33 | changed (no decision) | expenses.md:143 | — | — |
| P-RECEIPT-34 | covered | expenses.md:142 | — | — |
| P-RECEIPT-35 | changed (no decision) | expenses.md:144 | — | — |
| P-RECEIPT-36 | covered | expenses.md:142 | — | — |
| P-RECEIPT-37 | covered | expenses.md:142 | — | — |
| P-RECEIPT-38 | covered | expenses.md:142 | — | — |
| P-RECEIPT-39 | changed (no decision) | expenses.md:145 | — | — |
| P-RECEIPT-40 | changed (no decision) | expenses.md:146 | — | — |
| P-RECEIPT-41 | covered | expenses.md:142 | — | — |
| P-RECEIPT-42 | changed (no decision) | expenses.md:147 | — | — |
| P-RECEIPT-43 | changed (no decision) | expenses.md:147 | — | — |
| P-RECEIPT-44 | changed (no decision) | expenses.md:148 | — | — |
| P-RECEIPT-45 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-46 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-47 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-48 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-49 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-50 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-51 | changed (approved: DECISIONS.md group E) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-52 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-53 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-RECEIPT-54 | changed (no decision) | expenses.md:149 | expenses.md:30 changed | — |
| P-ACCESS-01 | covered | groups.md:118 | — | — |
| P-ACCESS-02 | deferred | groups.md:119 | — | tested |
| P-ACCESS-03 | covered | groups.md:120 | — | — |
| P-ACCESS-04 | deferred | groups.md:121 | — | tested |
| P-ACCESS-05 | deferred (other area) | groups.md:122 | — | tested |
| P-ACCESS-06 | deferred (other area) | groups.md:122 | — | tested |
| P-ACCESS-07 | covered | groups.md:123 | — | — |
| P-ACCESS-08 | covered | groups.md:124 | — | — |
| P-ACCESS-09 | covered | groups.md:124 | — | — |
| P-ACCESS-10 | covered | groups.md:130 | — | — |
| P-ACCESS-11 | covered | groups.md:131 | — | — |
| P-ACCESS-12 | covered | groups.md:131 | — | — |
| P-ACCESS-13 | covered | groups.md:131 | — | — |
| P-ACCESS-14 | covered | groups.md:131 | — | — |
| P-ACCESS-15 | covered | groups.md:131 | — | — |
| P-ACCESS-16 | covered | groups.md:132 | — | — |
| P-ACCESS-17 | covered | groups.md:133 | — | — |
| P-ACCESS-18 | covered | groups.md:132 | — | — |
| P-ACCESS-19 | covered | groups.md:134 | — | — |
| P-ACCESS-20 | covered | groups.md:135 | — | — |
| P-ACCESS-21 | covered | groups.md:136 | — | — |
| P-ACCESS-22 | covered | groups.md:136 | — | — |
| P-ACCESS-23 | covered | groups.md:136 | — | — |
| P-ACCESS-24 | covered | groups.md:136 | — | — |
| P-ACCESS-25 | covered | groups.md:137 | — | — |
| P-ACCESS-26 | covered | groups.md:137 | — | — |
| P-ACCESS-27 | covered | groups.md:138 | — | — |
| P-ACCESS-28 | changed (approved: DECISIONS.md group C) | groups.md:139 | — | — |
| P-ACCESS-29 | covered | groups.md:140 | — | — |
| P-ACCESS-30 | changed (approved: DECISIONS.md group B) | groups.md:141 | — | — |
| P-ACCESS-31 | covered | groups.md:147 | — | — |
| P-ACCESS-32 | open | groups.md:148 | — | untested |
| P-ACCESS-33 | changed (approved: DECISIONS.md group C) | groups.md:149 | — | — |
| P-ACCESS-34 | covered | groups.md:150 | — | — |
| P-ACCESS-35 | covered | groups.md:150 | — | — |
| P-ACCESS-36 | covered | groups.md:150 | — | — |
| P-ACCESS-37 | covered | groups.md:151 | — | — |
| P-ACCESS-38 | covered | groups.md:152 | — | — |
| P-ACCESS-39 | covered | groups.md:153 | — | — |
| P-ACCESS-40 | covered | groups.md:154 | — | — |
| P-ACCESS-41 | covered | groups.md:154 | — | — |
| P-ACCESS-42 | covered | groups.md:160 | — | — |
| P-ACCESS-43 | covered | groups.md:160 | — | — |
| P-ACCESS-44 | covered | groups.md:161 | — | — |
| P-ACCESS-45 | covered | groups.md:162 | — | — |
| P-ACCESS-46 | covered | groups.md:162 | — | — |
| P-ACCESS-47 | covered | groups.md:163 | — | — |
| P-ACCESS-48 | covered | groups.md:163 | — | — |
| P-ACCESS-49 | covered | groups.md:164 | — | — |
| P-ACCESS-50 | covered | groups.md:164 | — | — |
| P-ACCESS-51 | covered | groups.md:164 | — | — |
| P-ACCESS-52 | covered | groups.md:165 | — | — |
| P-ACCESS-53 | covered | groups.md:171 | — | — |
| P-ACCESS-54 | covered | groups.md:171 | — | — |
| P-ACCESS-55 | covered | groups.md:171 | — | — |
| P-ACCESS-56 | covered | groups.md:171 | — | — |
| P-ACCESS-57 | covered | groups.md:171 | — | — |
| P-ACCESS-58 | covered | groups.md:172 | — | — |
| P-ACCESS-59 | covered | groups.md:172 | — | — |
| P-ACCESS-60 | covered | groups.md:173 | — | — |
| P-ACCESS-61 | covered | groups.md:173 | — | — |
| P-ACCESS-62 | covered | groups.md:173 | — | — |
| P-ACCESS-63 | covered | groups.md:173 | — | — |
| P-ACCESS-64 | covered | groups.md:173 | — | — |
| P-ACCESS-65 | covered | groups.md:174 | — | — |
| P-ACCESS-66 | deferred | groups.md:175 | — | tested |
| P-SETTINGS-01 | covered | account.md:55 | — | — |
| P-SETTINGS-02 | covered | account.md:55 | — | — |
| P-SETTINGS-03 | covered | account.md:55 | — | — |
| P-SETTINGS-04 | covered | account.md:56 | — | — |
| P-SETTINGS-05 | covered | account.md:56 | — | — |
| P-SETTINGS-06 | covered | account.md:56 | — | — |
| P-SETTINGS-07 | covered | account.md:56 | — | — |
| P-SETTINGS-08 | covered | account.md:57 | — | — |
| P-SETTINGS-09 | deferred (other area) | account.md:58 | — | tested |
| P-SETTINGS-10 | covered | account.md:59 | — | — |
| P-SETTINGS-11 | covered | account.md:59 | — | — |
| P-SETTINGS-12 | deferred | account.md:60 | — | tested |
| P-SETTINGS-13 | deferred | account.md:60 | — | tested |
| P-SETTINGS-14 | deferred | account.md:60 | — | untested |
| P-SETTINGS-15 | covered | account.md:61 | — | — |
| P-SETTINGS-16 | covered | account.md:62 | — | — |
| P-SETTINGS-17 | covered | account.md:62 | — | — |
| P-SETTINGS-18 | covered | account.md:62 | — | — |
| P-SETTINGS-19 | changed (approved: DECISIONS.md group F (English only)) | account.md:63 | — | — |
| P-SETTINGS-20 | covered | account.md:64 | — | — |
| P-SETTINGS-21 | covered | account.md:64 | — | — |
| P-SETTINGS-22 | covered | account.md:64 | — | — |
| P-SETTINGS-23 | covered | account.md:64 | — | — |
| P-SETTINGS-24 | covered | account.md:64 | — | — |
| P-SETTINGS-25 | covered | account.md:64 | — | — |
| P-SETTINGS-26 | covered | account.md:64 | — | — |
| P-SETTINGS-27 | covered | account.md:65 | — | — |
| P-EXPORT-01 | covered | lead.md:15 | history.md:69 deferred (other area) | — |
| P-EXPORT-02 | deferred | history.md:70 | — | not-applicable, change with no decision |
| P-EXPORT-03 | covered | history.md:71 | — | — |
| P-EXPORT-04 | covered | history.md:71 | — | — |
| P-EXPORT-05 | deferred | history.md:72 | — | closed (branch `t3/v2-server-gaps`) |
| P-EXPORT-06 | covered | history.md:73 | — | — |
| P-EXPORT-07 | covered | history.md:74 | — | — |
| P-EXPORT-08 | covered | history.md:75 | — | change approved (DECISIONS.md, agent output) |
| P-EXPORT-09 | covered | history.md:75 | — | change approved (DECISIONS.md, agent output) |
| P-EXPORT-10 | covered | history.md:75 | — | change approved (DECISIONS.md, agent output) |
| P-EXPORT-11 | covered | history.md:76 | — | — |
| P-EXPORT-12 | covered | history.md:75 | — | change approved (DECISIONS.md, agent output) |
| P-EXPORT-13 | covered | history.md:75 | — | change approved (DECISIONS.md, agent output) |
| P-EXPORT-14 | changed (approved: DECISIONS.md group B) | history.md:77 | — | — |
| P-EXPORT-15 | changed (approved: DECISIONS.md group G) | history.md:78 | — | — |
| P-EXPORT-16 | changed (no decision) | history.md:79 | — | closed (branch `t3/v2-server-gaps`) |
| P-EXPORT-17 | covered | history.md:74 | — | — |
| P-EXPORT-18 | covered | history.md:80 | — | — |
| P-EXPORT-19 | covered | history.md:80 | — | — |
| P-EXPORT-20 | covered | history.md:80 | — | — |
| P-EXPORT-21 | covered | history.md:80 | — | — |
| P-EXPORT-22 | covered | history.md:80 | — | — |
| P-EXPORT-23 | covered | history.md:80 | — | — |
| P-EXPORT-24 | covered | history.md:80 | — | — |
| P-EXPORT-25 | covered | history.md:80 | — | — |
| P-EXPORT-26 | covered | history.md:80 | — | — |
| P-EXPORT-27 | covered | history.md:80 | — | — |
| P-EXPORT-28 | covered | history.md:74 | — | — |
| P-EXPORT-29 | changed (approved: DECISIONS.md group C) | history.md:81 | — | — |
| P-EXPORT-30 | code | history.md:82 | — | — |
| P-STATS-01 | covered | history.md:88 | — | — |
| P-STATS-02 | covered | history.md:88 | — | — |
| P-STATS-03 | covered | history.md:89 | — | — |
| P-STATS-04 | covered | history.md:89 | — | — |
| P-STATS-05 | covered | history.md:90 | — | — |
| P-STATS-06 | covered | history.md:90 | — | — |
| P-STATS-07 | covered | history.md:90 | — | — |
| P-STATS-08 | covered | history.md:90 | — | — |
| P-STATS-09 | covered | history.md:90 | — | — |
| P-STATS-10 | covered | history.md:90 | — | — |
| P-STATS-11 | covered | history.md:91 | — | — |
| P-STATS-12 | covered | history.md:91 | — | — |
| P-STATS-13 | covered | history.md:92 | — | — |
| P-STATS-14 | covered | history.md:92 | — | — |
| P-STATS-15 | covered | history.md:92 | — | — |
| P-STATS-16 | covered | history.md:92 | — | — |
| P-STATS-17 | covered | history.md:93 | — | — |
| P-STATS-18 | covered | history.md:94 | — | — |
| P-STATS-19 | covered | history.md:94 | — | — |
| P-STATS-20 | covered | history.md:94 | — | — |
| P-STATS-21 | covered | history.md:94 | — | — |
| P-STATS-22 | covered | history.md:94 | — | — |
| P-STATS-23 | covered | history.md:94 | — | — |
| P-STATS-24 | covered | history.md:94 | — | — |
| P-STATS-25 | covered | history.md:95 | — | — |
| P-STATS-26 | covered | history.md:95 | — | — |
| P-STATS-27 | covered | history.md:95 | — | — |
| P-STATS-28 | covered | history.md:96 | — | — |
| P-STATS-29 | covered | history.md:96 | — | — |
| P-STATS-30 | covered | history.md:96 | — | — |
| P-STATS-31 | covered | history.md:96 | — | — |
| P-STATS-32 | covered | history.md:97 | — | — |
| P-STATS-33 | covered | history.md:97 | — | — |
| P-STATS-34 | covered | history.md:98 | — | — |
| P-STATS-35 | covered | history.md:98 | — | — |
| P-STATS-36 | changed (approved: DECISIONS.md group C) | history.md:99 | — | — |
| P-STATS-37 | covered | history.md:100 | — | — |
| P-STATS-38 | covered | history.md:98 | — | — |
| P-STATS-39 | covered | history.md:98 | — | — |
| P-STATS-40 | covered | history.md:98 | — | — |
| P-STATS-41 | covered | history.md:101 | — | — |
| P-STATS-42 | covered | history.md:101 | — | — |
| P-STATS-43 | covered | history.md:101 | — | — |
| P-STATS-44 | changed (approved: DECISIONS.md group C) | history.md:102 | — | — |
| P-STATS-45 | covered | history.md:103 | — | — |
| P-STATS-46 | code | history.md:104 | — | — |
| P-PWA-01 | covered | account.md:71 | — | — |
| P-PWA-02 | covered | account.md:71 | — | — |
| P-PWA-03 | covered | account.md:72 | — | — |
| P-PWA-04 | covered | AUDIT.md gap 5 | account.md:73 | browser check |
| P-PWA-05 | covered | account.md:74 | — | — |
| P-PWA-06 | covered | account.md:74 | — | — |
| P-PWA-07 | covered | account.md:74 | — | — |
| P-PWA-08 | covered | account.md:74 | — | — |
| P-PWA-09 | covered | account.md:74 | — | — |
| P-PWA-10 | covered | account.md:74 | — | — |
| P-PWA-11 | covered | account.md:74 | — | — |
| P-PWA-12 | covered | account.md:74 | — | — |
| P-PWA-13 | covered | account.md:75 | — | — |
| P-PWA-14 | covered | account.md:75 | — | — |
| P-PWA-15 | covered | account.md:75 | — | — |
| P-PWA-16 | covered | account.md:75 | — | — |
| P-PWA-17 | changed (approved: DECISIONS.md group B) | account.md:76 | — | — |
| P-PWA-18 | changed (no decision) | account.md:77 | — | — |
| P-PWA-19 | changed (no decision) | account.md:77 | — | — |
| P-PWA-20 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:78 | — | — |
| P-PWA-21 | deferred (other area) | account.md:79 | — | unapproved-change, change with no decision |
| P-PWA-22 | deferred (other area) | account.md:79 | — | untested |
| P-PWA-23 | deferred (other area) | account.md:79 | — | unapproved-change, change with no decision |
| P-PWA-24 | deferred (other area) | account.md:79 | — | tested |
| P-PWA-25 | deferred (other area) | account.md:79 | — | unapproved-change, change with no decision |
| P-PWA-26 | deferred (other area) | account.md:79 | — | unapproved-change, change with no decision |
| P-PWA-27 | covered | account.md:80 | — | — |
| P-PWA-28 | changed (approved: DECISIONS.md group B) | account.md:81 | — | — |
| P-PWA-29 | covered | account.md:80 | — | — |
| P-PWA-30 | covered | account.md:80 | — | — |
| P-PWA-31 | changed (approved: DECISIONS.md group G) | account.md:82 | — | — |
| P-PWA-32 | covered | account.md:83 | — | — |
| P-PWA-33 | covered | account.md:84 | — | — |
| P-PWA-34 | covered | account.md:85 | — | — |
| P-PWA-35 | covered | account.md:86 | — | — |
| P-PWA-36 | covered | AUDIT.md gap 6 | account.md:87 | tested |
| P-PWA-37 | changed (no decision) | account.md:88 | — | — |
| P-PWA-38 | changed (no decision) | account.md:88 | — | — |
| P-PWA-39 | changed (no decision) | account.md:88 | — | — |
| P-PWA-40 | changed (no decision) | account.md:88 | — | — |
| P-PWA-41 | changed (no decision) | account.md:88 | — | — |
| P-PWA-42 | changed (no decision) | account.md:88 | — | — |
| P-PWA-43 | changed (no decision) | account.md:88 | — | — |
| P-PWA-44 | changed (no decision) | account.md:88 | — | — |
| P-PWA-45 | changed (no decision) | account.md:89 | — | — |
| P-PWA-46 | changed (no decision) | account.md:88 | — | — |
| P-PWA-47 | covered | account.md:90 | — | — |
| P-PWA-48 | changed (approved: DECISIONS.md group A) | account.md:91 | — | — |
| P-PWA-49 | deferred | account.md:92 | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-PWA-50 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-51 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-52 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-53 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-54 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-55 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-PWA-56 | changed (approved: DECISIONS.md group F (English only)) | account.md:93 | — | — |
| P-MCP-01 | covered | mcp.md:31 | — | — |
| P-MCP-02 | covered | mcp.md:32 | — | — |
| P-MCP-03 | covered | mcp.md:33 | — | — |
| P-MCP-04 | covered | mcp.md:34 | — | — |
| P-MCP-05 | covered | mcp.md:34 | — | — |
| P-MCP-06 | changed (approved: PLAN.md New features (agent instructions) and the P-BAL-93 bullet) | mcp.md:35 | — | — |
| P-MCP-07 | covered | mcp.md:36 | — | — |
| P-MCP-08 | covered | mcp.md:37 | — | — |
| P-MCP-09 | covered | mcp.md:36 | — | — |
| P-MCP-10 | covered | mcp.md:38 | — | — |
| P-MCP-11 | covered | mcp.md:39 | — | — |
| P-MCP-12 | covered | mcp.md:40 | — | — |
| P-MCP-13 | covered | mcp.md:40 | — | — |
| P-MCP-14 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | mcp.md:41 | — | — |
| P-MCP-15 | covered | mcp.md:47 | — | — |
| P-MCP-16 | covered | mcp.md:47 | — | — |
| P-MCP-17 | covered | mcp.md:48 | — | — |
| P-MCP-18 | covered | mcp.md:48 | — | — |
| P-MCP-19 | covered | mcp.md:48 | — | — |
| P-MCP-20 | covered | mcp.md:48 | — | — |
| P-MCP-21 | covered | mcp.md:48 | — | — |
| P-MCP-22 | covered | mcp.md:48 | — | — |
| P-MCP-23 | covered | mcp.md:48 | — | — |
| P-MCP-24 | covered | mcp.md:49 | — | — |
| P-MCP-25 | covered | mcp.md:50 | — | — |
| P-MCP-26 | covered | mcp.md:49 | — | — |
| P-MCP-27 | covered | mcp.md:49 | — | — |
| P-MCP-28 | covered | mcp.md:49 | — | — |
| P-MCP-29 | covered | mcp.md:62 | — | — |
| P-MCP-30 | covered | mcp.md:62 | — | — |
| P-MCP-31 | covered | mcp.md:63 | — | — |
| P-MCP-32 | covered | mcp.md:63 | — | — |
| P-MCP-33 | covered | mcp.md:64 | — | — |
| P-MCP-34 | covered | mcp.md:64 | — | — |
| P-MCP-35 | covered | mcp.md:64 | — | — |
| P-MCP-36 | code | mcp.md:65 | — | — |
| P-MCP-37 | covered | mcp.md:64 | — | — |
| P-MCP-38 | covered | mcp.md:64 | — | — |
| P-MCP-39 | changed (no decision) | mcp.md:66 | — | — |
| P-MCP-40 | covered | mcp.md:67 | — | — |
| P-MCP-41 | changed (approved: DECISIONS.md group B) | mcp.md:68 | — | — |
| P-MCP-42 | covered | mcp.md:69 | — | — |
| P-MCP-43 | covered | mcp.md:70 | — | — |
| P-MCP-44 | changed (no decision) | mcp.md:71 | — | — |
| P-MCP-45 | covered | mcp.md:77 | account.md:100 deferred (other area) | — |
| P-MCP-46 | covered | mcp.md:77 | account.md:100 deferred (other area) | — |
| P-MCP-47 | covered | mcp.md:77 | account.md:100 deferred (other area) | — |
| P-MCP-48 | covered | mcp.md:77 | account.md:100 deferred (other area) | — |
| P-MCP-49 | covered | mcp.md:77 | account.md:100 deferred (other area) | — |
| P-MCP-50 | covered | mcp.md:78 | account.md:99 covered | — |
| P-MCP-51 | changed (no decision) | mcp.md:79 | account.md:100 deferred (other area) | — |
| P-MCP-52 | covered | mcp.md:80 | account.md:100 deferred (other area) | — |
| P-MCP-53 | covered | mcp.md:81 | account.md:100 deferred (other area) | — |
| P-MCP-54 | covered | mcp.md:81 | account.md:100 deferred (other area) | — |
| P-MCP-55 | covered | mcp.md:82 | account.md:99 covered | — |
| P-MCP-56 | changed (approved: DECISIONS.md group G) | mcp.md:83 | account.md:100 deferred (other area) | — |
| P-MCP-57 | covered | account.md:99 | mcp.md:84 deferred | — |
| P-MCP-58 | covered | mcp.md:90 | — | — |
| P-MCP-59 | covered | mcp.md:90 | — | — |
| P-MCP-60 | covered | mcp.md:90 | — | — |
| P-MCP-61 | covered | mcp.md:91 | — | — |
| P-MCP-62 | covered | mcp.md:91 | — | — |
| P-MCP-63 | covered | mcp.md:91 | — | — |
| P-MCP-64 | covered | mcp.md:92 | — | — |
| P-MCP-65 | code | mcp.md:93 | — | — |
| P-MCP-66 | covered | mcp.md:94 | — | — |
| P-MCP-67 | covered | mcp.md:94 | — | — |
| P-MCP-68 | changed (approved: PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md)) | mcp.md:95 | — | — |
| P-MCP-69 | code | mcp.md:96 | — | — |
| P-MCP-70 | covered | mcp.md:97 | — | — |
| P-MCP-71 | covered | mcp.md:94 | — | — |
| P-MCP-72 | covered | mcp.md:94 | — | — |
| P-MCP-73 | code | mcp.md:96 | — | — |
| P-MCP-74 | covered | mcp.md:103 | — | — |
| P-MCP-75 | covered | mcp.md:103 | — | — |
| P-MCP-76 | code | mcp.md:104 | — | — |
| P-MCP-77 | changed (approved: PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md)) | mcp.md:105 | — | — |
| P-MCP-78 | covered | mcp.md:106 | — | — |
| P-MCP-79 | changed (approved: DECISIONS.md group B) | mcp.md:107 | account.md:101 deferred (other area) | — |
| P-MCP-80 | covered | mcp.md:119 | — | — |
| P-MCP-81 | covered | mcp.md:119 | — | — |
| P-MCP-82 | covered | mcp.md:119 | — | — |
| P-MCP-83 | covered | mcp.md:119 | — | — |
| P-MCP-84 | covered | mcp.md:119 | — | — |
| P-MCP-85 | changed (approved: DECISIONS.md group A) | mcp.md:120 | — | — |
| P-MCP-86 | changed (no decision) | mcp.md:121 | — | — |
| P-MCP-87 | covered | mcp.md:111 | — | — |
| P-MCP-88 | changed (approved: PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md)) | mcp.md:108 | — | — |
| P-MCP-89 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | mcp.md:109 | — | — |
| P-MCP-90 | covered | mcp.md:110 | — | — |
| P-MCP-91 | changed (approved: PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md)) | mcp.md:108 | — | — |
| P-MCP-92 | covered | mcp.md:127 | account.md:102 covered | — |
| P-MCP-93 | changed (approved: PLAN.md New features (the Claude Code OAuth fix, OAUTH-CLAUDE-CODE.md)) | mcp.md:128 | account.md:102 covered | — |
| P-MCP-94 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-95 | covered | account.md:102 | mcp.md:130 deferred | — |
| P-MCP-96 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-97 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-98 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-99 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-100 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-101 | covered | account.md:103 | mcp.md:130 deferred | — |
| P-MCP-102 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-103 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-104 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-105 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-106 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-107 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-108 | deferred | mcp.md:130 | account.md:104 deferred (other area) | tested |
| P-MCP-109 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-110 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-111 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-112 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-113 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-114 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-115 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-116 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-117 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-118 | deferred | mcp.md:130 | account.md:104 deferred (other area) | tested |
| P-MCP-119 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-120 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-121 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-122 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-123 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-124 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-125 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-126 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-127 | covered | mcp.md:129 | account.md:104 deferred (other area) | — |
| P-MCP-128 | deferred | mcp.md:130 | account.md:104 deferred (other area) | untested |
| P-MCP-129 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:105 | mcp.md:130 deferred | — |
| P-MCP-130 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:105 | mcp.md:130 deferred | — |
| P-MCP-131 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:105 | mcp.md:130 deferred | — |
| P-MCP-132 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:105 | mcp.md:130 deferred | — |
| P-MCP-133 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | account.md:105 | mcp.md:130 deferred | — |
| P-MCP-134 | covered | mcp.md:129 | account.md:106 deferred (other area) | — |
| P-MCP-135 | covered | mcp.md:129 | account.md:106 deferred (other area) | — |
| P-MCP-136 | covered | mcp.md:129 | account.md:106 deferred (other area) | — |
| P-MCP-137 | deferred | mcp.md:130 | account.md:107 deferred (other area) | closed (branch `t3/v2-server-gaps`) |
| P-MCP-138 | deferred | mcp.md:130 | account.md:107 deferred (other area) | closed (branch `t3/v2-server-gaps`) |
| P-MCP-139 | deferred | mcp.md:130 | account.md:107 deferred (other area) | closed (branch `t3/v2-server-gaps`) |
| P-MCP-140 | covered | account.md:108 | mcp.md:130 deferred | — |
| P-MCP-141 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-142 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-143 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-144 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-145 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-146 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-147 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-148 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-149 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-150 | covered | account.md:109 | mcp.md:131 deferred | — |
| P-MCP-151 | open | account.md:110 | mcp.md:131 deferred | untested |
| P-MCP-152 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-153 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-154 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-155 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-156 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-157 | covered | account.md:111 | mcp.md:131 deferred | — |
| P-MCP-158 | changed (approved: DECISIONS.md group G) | account.md:112 | mcp.md:131 deferred | — |
| P-MCP-159 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-160 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-161 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-162 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-163 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-164 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-165 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-166 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-167 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-168 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-169 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-170 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-171 | covered | account.md:113 | mcp.md:131 deferred | — |
| P-MCP-172 | changed (approved: DECISIONS.md group F (English only)) | account.md:114 | mcp.md:131 deferred | — |
| P-MCP-173 | changed (approved: DECISIONS.md group A) | mcp.md:132 | — | — |
| P-MCP-174 | changed (approved: DECISIONS.md group A) | mcp.md:132 | — | — |
| P-MCP-175 | changed (approved: DECISIONS.md group A) | mcp.md:132 | — | — |
| P-MCP-176 | changed (approved: DECISIONS.md group E) | mcp.md:132 | — | — |
| P-TOOL-LISTALL-01 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | mcp.md:226 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-02 | changed (no decision) | mcp.md:227 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-03 | code | mcp.md:228 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-04 | covered | mcp.md:229 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-05 | covered | mcp.md:230 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-06 | covered | mcp.md:230 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-07 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-08 | changed (approved: DECISIONS.md group C) | mcp.md:232 | feed.md:174 changed | — |
| P-TOOL-LISTALL-09 | changed (approved: DECISIONS.md group C and the P-FEED-19 bullet) | mcp.md:229 | feed.md:175 changed | — |
| P-TOOL-LISTALL-10 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-11 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-12 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-13 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-14 | changed (approved: DECISIONS.md, agent output) | mcp.md:233 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-15 | covered | mcp.md:234 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-16 | code | mcp.md:231 | feed.md:176 deferred | — |
| P-TOOL-LISTALL-17 | covered | mcp.md:235 | feed.md:176 deferred | — |
| P-TOOL-OPTIONS-01 | covered | mcp.md:241 | — | — |
| P-TOOL-OPTIONS-02 | covered | mcp.md:241 | — | — |
| P-TOOL-OPTIONS-03 | covered | mcp.md:241 | — | — |
| P-TOOL-OPTIONS-04 | covered | mcp.md:241 | — | — |
| P-TOOL-OPTIONS-05 | covered | mcp.md:241 | — | — |
| P-TOOL-PROFILE-01 | covered | mcp.md:247 | — | — |
| P-TOOL-PROFILE-02 | covered | mcp.md:248 | account.md:115 covered | — |
| P-TOOL-PROFILE-03 | covered | mcp.md:248 | account.md:115 covered | — |
| P-TOOL-PROFILE-04 | covered | mcp.md:248 | — | — |
| P-TOOL-PROFILE-05 | code | mcp.md:249 | account.md:115 covered | — |
| P-TOOL-PROFILE-06 | covered | mcp.md:248 | account.md:115 covered | — |
| P-TOOL-PROFILE-07 | covered | mcp.md:248 | — | — |
| P-TOOL-PROFILE-08 | covered | mcp.md:248 | account.md:115 covered | — |
| P-TOOL-PROFILE-09 | code | mcp.md:250 | — | — |
| P-TOOL-LISTGROUPS-01 | changed (approved: PLAN.md Target stack (an SPA with Effect RPC replaces Next.js and tRPC; only the SPA calls the RPC, P-AUTH-14)) | mcp.md:140 | — | — |
| P-TOOL-LISTGROUPS-02 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-03 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-04 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-05 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-06 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-07 | changed (approved: PLAN.md invariant 1 (registered currency codes only)) | mcp.md:142 | — | — |
| P-TOOL-LISTGROUPS-08 | covered | mcp.md:141 | — | — |
| P-TOOL-LISTGROUPS-09 | covered | mcp.md:141 | — | — |
| P-TOOL-GETGROUP-01 | covered | mcp.md:148 | — | — |
| P-TOOL-GETGROUP-02 | covered | mcp.md:148 | — | — |
| P-TOOL-GETGROUP-03 | changed (approved: No visible change: the current access check also answers FORBIDDEN first) | mcp.md:149 | — | — |
| P-TOOL-GETGROUP-04 | covered | mcp.md:150 | — | — |
| P-TOOL-GETGROUP-05 | covered | mcp.md:148 | — | — |
| P-TOOL-GETGROUP-06 | covered | mcp.md:148 | — | — |
| P-TOOL-GETGROUP-07 | code | mcp.md:151 | — | — |
| P-TOOL-GETGROUP-08 | covered | mcp.md:152 | — | — |
| P-TOOL-GETGROUP-09 | covered | mcp.md:148 | — | — |
| P-TOOL-CREATEGROUP-01 | covered | mcp.md:256 | — | — |
| P-TOOL-CREATEGROUP-02 | changed (approved: PLAN.md invariant 1 and the DECISIONS.md "MCP group currency" bullet) | mcp.md:257 | — | — |
| P-TOOL-CREATEGROUP-03 | covered | mcp.md:256 | — | — |
| P-TOOL-CREATEGROUP-04 | covered | mcp.md:258 | — | — |
| P-TOOL-CREATEGROUP-05 | covered | mcp.md:256 | — | — |
| P-TOOL-CREATEGROUP-06 | code | mcp.md:259 | — | — |
| P-TOOL-CREATEGROUP-07 | code | mcp.md:260 | — | — |
| P-TOOL-CREATEGROUP-08 | code | mcp.md:259 | — | — |
| P-TOOL-CREATEGROUP-09 | covered | mcp.md:256 | — | — |
| P-TOOL-CREATEGROUP-10 | covered | mcp.md:256 | — | — |
| P-TOOL-UPDATEGROUP-01 | covered | mcp.md:266 | — | — |
| P-TOOL-UPDATEGROUP-02 | covered | mcp.md:266 | — | — |
| P-TOOL-UPDATEGROUP-03 | covered | mcp.md:266 | — | — |
| P-TOOL-UPDATEGROUP-04 | covered | mcp.md:266 | — | — |
| P-TOOL-UPDATEGROUP-05 | code | mcp.md:267 | — | — |
| P-TOOL-UPDATEGROUP-06 | code | mcp.md:267 | — | — |
| P-TOOL-UPDATEGROUP-07 | code | mcp.md:268 | — | — |
| P-TOOL-UPDATEGROUP-08 | code | mcp.md:267 | — | — |
| P-TOOL-UPDATEGROUP-09 | code | mcp.md:267 | — | — |
| P-TOOL-UPDATEGROUP-10 | code | mcp.md:267 | — | — |
| P-TOOL-UPDATEGROUP-11 | covered | mcp.md:266 | — | — |
| P-TOOL-UPDATEGROUP-12 | covered | mcp.md:266 | — | — |
| P-TOOL-ACCESS-01 | covered | mcp.md:274 | — | — |
| P-TOOL-ACCESS-02 | covered | mcp.md:274 | — | — |
| P-TOOL-ACCESS-03 | covered | mcp.md:274 | — | — |
| P-TOOL-ACCESS-04 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-05 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-06 | code | mcp.md:277 | — | — |
| P-TOOL-ACCESS-07 | code | mcp.md:278 | — | — |
| P-TOOL-ACCESS-08 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-09 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-10 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-11 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-12 | code | mcp.md:280 | — | — |
| P-TOOL-ACCESS-13 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-14 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-15 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-16 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-17 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-18 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-19 | covered | mcp.md:276 | — | — |
| P-TOOL-ACCESS-20 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-21 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-22 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-23 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-24 | code | mcp.md:275 | — | — |
| P-TOOL-ACCESS-25 | covered | mcp.md:281 | — | — |
| P-TOOL-ACCESS-26 | covered | mcp.md:279 | — | — |
| P-TOOL-ACCESS-27 | covered | mcp.md:281 | — | — |
| P-TOOL-ACCESS-28 | changed (approved: DECISIONS.md group C) | mcp.md:282 | — | — |
| P-TOOL-ACCESS-29 | code | mcp.md:275 | — | — |
| P-TOOL-LISTEXP-01 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-02 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-03 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-04 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-05 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-06 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-07 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-08 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-09 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-10 | covered | mcp.md:159 | — | — |
| P-TOOL-LISTEXP-11 | changed (approved: DECISIONS.md, agent output) | mcp.md:160 | — | — |
| P-TOOL-LISTEXP-12 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-13 | covered | mcp.md:158 | — | — |
| P-TOOL-LISTEXP-14 | covered | mcp.md:161 | — | — |
| P-TOOL-LISTEXP-15 | covered | mcp.md:161 | — | — |
| P-TOOL-LISTEXP-16 | covered | mcp.md:162 | — | — |
| P-TOOL-LISTEXP-17 | covered | mcp.md:158 | — | — |
| P-TOOL-GETEXP-01 | covered | mcp.md:168 | — | — |
| P-TOOL-GETEXP-02 | covered | mcp.md:170 | — | — |
| P-TOOL-GETEXP-03 | covered | mcp.md:168 | — | — |
| P-TOOL-GETEXP-04 | covered | mcp.md:168 | — | — |
| P-TOOL-GETEXP-05 | covered | mcp.md:169 | — | — |
| P-TOOL-GETEXP-06 | covered | mcp.md:172 | — | — |
| P-TOOL-GETEXP-07 | covered | mcp.md:170 | — | — |
| P-TOOL-GETEXP-08 | code | mcp.md:171 | — | — |
| P-TOOL-GETEXP-09 | covered | mcp.md:170 | — | — |
| P-TOOL-GETEXP-10 | covered | mcp.md:170 | — | — |
| P-TOOL-CREATEEXP-01 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-02 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-03 | changed (approved: PLAN.md New features (multiple payers)) | mcp.md:179 | — | — |
| P-TOOL-CREATEEXP-04 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-05 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-06 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-07 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-08 | changed (approved: DECISIONS.md, agent output) | mcp.md:180 | — | — |
| P-TOOL-CREATEEXP-09 | covered | mcp.md:181 | — | — |
| P-TOOL-CREATEEXP-10 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-11 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-12 | covered | mcp.md:181 | — | — |
| P-TOOL-CREATEEXP-13 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-14 | changed (approved: DECISIONS.md group B) | mcp.md:182 | — | — |
| P-TOOL-CREATEEXP-15 | changed (approved: DECISIONS.md, agent output) | mcp.md:183 | — | — |
| P-TOOL-CREATEEXP-16 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-17 | covered | mcp.md:184 | — | — |
| P-TOOL-CREATEEXP-18 | deferred | mcp.md:185 | — | tested |
| P-TOOL-CREATEEXP-19 | covered | mcp.md:186 | — | — |
| P-TOOL-CREATEEXP-20 | code | mcp.md:187 | — | — |
| P-TOOL-CREATEEXP-21 | code | mcp.md:187 | — | — |
| P-TOOL-CREATEEXP-22 | code | mcp.md:187 | — | — |
| P-TOOL-CREATEEXP-23 | covered | mcp.md:188 | — | — |
| P-TOOL-CREATEEXP-24 | covered | mcp.md:186 | — | — |
| P-TOOL-CREATEEXP-25 | covered | mcp.md:186 | — | — |
| P-TOOL-CREATEEXP-26 | code | mcp.md:187 | — | — |
| P-TOOL-CREATEEXP-27 | code | mcp.md:187 | — | — |
| P-TOOL-CREATEEXP-28 | covered | mcp.md:189 | — | — |
| P-TOOL-CREATEEXP-29 | covered | mcp.md:178 | — | — |
| P-TOOL-CREATEEXP-30 | changed (no decision) | mcp.md:190 | — | — |
| P-TOOL-CREATEEXP-31 | changed (no decision) | mcp.md:191 | — | — |
| P-TOOL-CREATEEXP-32 | covered | mcp.md:192 | — | — |
| P-TOOL-UPDATEEXP-01 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-02 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-03 | changed (approved: DECISIONS.md, agent output) | mcp.md:199 | — | — |
| P-TOOL-UPDATEEXP-04 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-05 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-06 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-07 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-08 | deferred | mcp.md:201 | — | tested |
| P-TOOL-UPDATEEXP-09 | covered | mcp.md:202 | — | — |
| P-TOOL-UPDATEEXP-10 | covered | mcp.md:202 | — | — |
| P-TOOL-UPDATEEXP-11 | covered | mcp.md:203 | — | — |
| P-TOOL-UPDATEEXP-12 | covered | mcp.md:204 | — | — |
| P-TOOL-UPDATEEXP-13 | changed (no decision) | mcp.md:205 | — | — |
| P-TOOL-UPDATEEXP-14 | changed (no decision) | mcp.md:206 | — | — |
| P-TOOL-UPDATEEXP-15 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-16 | covered | mcp.md:207 | — | — |
| P-TOOL-UPDATEEXP-17 | covered | mcp.md:198 | — | — |
| P-TOOL-UPDATEEXP-18 | covered | mcp.md:198 | — | — |
| P-TOOL-DELETEEXP-01 | covered | mcp.md:213 | — | — |
| P-TOOL-DELETEEXP-02 | covered | mcp.md:213 | — | — |
| P-TOOL-DELETEEXP-03 | covered | mcp.md:213 | — | — |
| P-TOOL-DELETEEXP-04 | covered | mcp.md:213 | — | — |
| P-TOOL-DELETEEXP-05 | covered | mcp.md:214 | — | — |
| P-TOOL-DELETEEXP-06 | code | mcp.md:215 | — | — |
| P-TOOL-DELETEEXP-07 | covered | mcp.md:216 | — | — |
| P-TOOL-DELETEEXP-08 | covered | mcp.md:213 | — | — |
| P-TOOL-BALANCES-01 | covered | mcp.md:288 | — | — |
| P-TOOL-BALANCES-02 | covered | mcp.md:288 | — | — |
| P-TOOL-BALANCES-03 | covered | mcp.md:288 | — | — |
| P-TOOL-BALANCES-04 | changed (approved: DECISIONS.md, agent output) | mcp.md:289 | — | — |
| P-TOOL-BALANCES-05 | covered | mcp.md:288 | — | — |
| P-TOOL-BALANCES-06 | covered | mcp.md:290 | — | — |
| P-TOOL-BALANCES-07 | code | mcp.md:291 | — | — |
| P-TOOL-BALANCES-08 | covered | mcp.md:292 | — | — |
| P-TOOL-BALANCES-09 | covered | mcp.md:292 | — | — |
| P-TOOL-BALANCES-10 | covered | mcp.md:293 | — | — |
| P-TOOL-PBAL-01 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-02 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-03 | changed (no decision) | mcp.md:300 | — | — |
| P-TOOL-PBAL-04 | code | mcp.md:301 | — | — |
| P-TOOL-PBAL-05 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-06 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-07 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-08 | covered | mcp.md:299 | — | — |
| P-TOOL-PBAL-09 | code | mcp.md:301 | — | — |
| P-TOOL-PBAL-10 | covered | mcp.md:302 | — | — |
| P-TOOL-STATS-01 | covered | mcp.md:308 | — | — |
| P-TOOL-STATS-02 | code | mcp.md:309 | — | — |
| P-TOOL-STATS-03 | covered | mcp.md:308 | — | — |
| P-TOOL-STATS-04 | changed (approved: DECISIONS.md group C) | mcp.md:310 | — | — |
| P-TOOL-STATS-05 | covered | mcp.md:308 | — | — |
| P-TOOL-STATS-06 | covered | mcp.md:308 | — | — |
| P-TOOL-STATS-07 | code | mcp.md:309 | — | — |
| P-TOOL-STATS-08 | covered | mcp.md:311 | — | — |
| P-TOOL-ACTIVITY-01 | covered | mcp.md:317 | — | — |
| P-TOOL-ACTIVITY-02 | covered | mcp.md:317 | — | — |
| P-TOOL-ACTIVITY-03 | code | mcp.md:318 | — | — |
| P-TOOL-ACTIVITY-04 | covered | mcp.md:319 | — | — |
| P-TOOL-ACTIVITY-05 | covered | mcp.md:317 | — | — |
| P-TOOL-ACTIVITY-06 | changed (no decision) | mcp.md:320 | — | — |
| P-TOOL-ACTIVITY-07 | covered | mcp.md:317 | — | — |
| P-TOOL-ACTIVITY-08 | changed (approved: DECISIONS.md group B (the group log without connection IDs)) | mcp.md:321 | — | — |
| P-TOOL-ACTIVITY-09 | covered | mcp.md:322 | — | — |
| P-TOOL-ACTIVITY-10 | code | mcp.md:318 | — | — |
| P-TOOL-RECUR-01 | covered | mcp.md:328 | — | — |
| P-TOOL-RECUR-02 | covered | mcp.md:328 | — | — |
| P-TOOL-RECUR-03 | covered | mcp.md:328 | — | — |
| P-TOOL-RECUR-04 | covered | mcp.md:328 | — | — |
| P-TOOL-RECUR-05 | covered | mcp.md:328 | — | — |
| P-TOOL-REF-01 | covered | mcp.md:335 | — | — |
| P-TOOL-REF-02 | covered | mcp.md:335 | — | — |
| P-TOOL-REF-03 | changed (no decision) | mcp.md:336 | — | — |
| P-TOOL-REF-04 | covered | mcp.md:335 | — | — |
| P-TOOL-REF-05 | covered | mcp.md:337 | — | — |
| P-TOOL-EXPORT-01 | covered | mcp.md:343 | — | — |
| P-TOOL-EXPORT-02 | covered | mcp.md:343 | — | — |
| P-TOOL-EXPORT-03 | changed (approved: DECISIONS.md group B) | mcp.md:344 | — | — |
| P-TOOL-EXPORT-04 | changed (no decision) | mcp.md:345 | — | closed (branch `t3/v2-server-gaps`) |
| P-TOOL-EXPORT-05 | covered | mcp.md:343 | — | — |
| P-TOOL-EXPORT-06 | deferred | mcp.md:346 | — | closed (branch `t3/v2-server-gaps`) |
| P-DB-01 | missing | — | — | tested |
| P-DB-02 | missing | — | — | tested |
| P-DB-03 | missing | — | — | tested |
| P-DB-04 | missing | — | — | tested |
| P-DB-05 | missing | — | — | untested |
| P-DB-06 | missing | — | — | untested |
| P-DB-07 | missing | — | — | tested |
| P-DB-08 | missing | — | — | tested |
| P-DB-09 | missing | — | — | untested |
| P-DB-10 | missing | — | — | tested |
| P-DB-11 | missing | — | — | tested |
| P-DB-12 | missing | — | — | untested |
| P-DB-13 | missing | — | — | untested |
| P-DB-14 | missing | — | — | untested |
| P-DB-15 | missing | — | — | approved-change |
| P-DB-16 | missing | — | — | closed (branch `t3/v2-server-gaps`) |
| P-DB-17 | missing | — | — | tested |
| P-DB-18 | missing | — | — | untested |
| P-DB-19 | missing | — | — | tested |
| P-DB-20 | missing | — | — | unapproved-change, change with no decision |
| P-DB-21 | missing | — | — | tested |
| P-DB-22 | missing | — | — | tested |
| P-DB-23 | missing | — | — | untested |
| P-DB-24 | missing | — | — | approved-change |
| P-DB-25 | missing | — | — | tested |
| P-DB-26 | missing | — | — | untested |
| P-DB-27 | missing | — | — | untested |
| P-DB-28 | missing | — | — | untested |
| P-DB-29 | missing | — | — | tested |
| P-DB-30 | missing | — | — | untested |
| P-DB-31 | missing | — | — | untested |
| P-DB-32 | missing | — | — | approved-change |
| P-DB-33 | missing | — | — | unapproved-change, change with no decision |
| P-DB-34 | missing | — | — | unapproved-change, change with no decision |
| P-DB-35 | missing | — | — | approved-change |
| P-DB-36 | missing | — | — | approved-change |
| P-DB-37 | missing | — | — | approved-change |
| P-DB-38 | missing | — | — | tested |
| P-DB-39 | missing | — | — | unapproved-change, change with no decision |
| P-DB-40 | missing | — | — | untested |
| P-DB-41 | missing | — | — | unapproved-change, change with no decision |
| P-DB-42 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-43 | missing | — | — | unapproved-change, change with no decision |
| P-DB-44 | missing | — | — | untested |
| P-DB-45 | missing | — | — | unapproved-change, change with no decision |
| P-DB-46 | missing | — | — | approved-change |
| P-DB-47 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-48 | missing | — | — | untested |
| P-DB-49 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-50 | missing | — | — | untested |
| P-DB-51 | missing | — | — | tested |
| P-DB-52 | missing | — | — | untested |
| P-DB-53 | missing | — | — | tested |
| P-DB-54 | missing | — | — | untested |
| P-DB-55 | missing | — | — | unapproved-change, change with no decision |
| P-DB-56 | missing | — | — | untested |
| P-DB-57 | missing | — | — | untested |
| P-DB-58 | missing | — | — | unapproved-change, change with no decision |
| P-DB-59 | missing | — | — | untested |
| P-DB-60 | missing | — | — | untested |
| P-DB-61 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-62 | missing | — | — | unapproved-change, change with no decision |
| P-DB-63 | missing | — | — | tested |
| P-DB-64 | missing | — | — | unapproved-change, change with no decision |
| P-DB-65 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-66 | missing | — | — | approved-change |
| P-DB-67 | missing | — | — | tested |
| P-DB-68 | missing | — | — | untested |
| P-DB-69 | missing | — | — | untested |
| P-DB-70 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-71 | missing | — | — | tested |
| P-DB-72 | missing | — | — | untested |
| P-DB-73 | missing | — | — | approved-change |
| P-DB-74 | missing | — | — | tested |
| P-DB-75 | missing | — | — | tested |
| P-DB-76 | missing | — | — | approved-change |
| P-DB-77 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-78 | missing | — | — | untested |
| P-DB-79 | missing | — | — | closed (branch `t3/v2-server-gaps`) |
| P-DB-80 | missing | — | — | tested |
| P-DB-81 | missing | — | — | not-applicable |
| P-DB-82 | missing | — | — | not-applicable |
| P-DB-83 | missing | — | — | not-applicable |
| P-DB-84 | missing | — | — | untested |
| P-DB-85 | missing | — | — | tested |
| P-DB-86 | missing | — | — | untested |
| P-DB-87 | missing | — | — | unapproved-change, change with no decision |
| P-DB-88 | missing | — | — | approved-change |
| P-DB-89 | missing | — | — | unapproved-change, change with no decision |
| P-DB-90 | missing | — | — | unapproved-change, change with no decision |
| P-DB-91 | missing | — | — | untested |
| P-DB-92 | missing | — | — | unapproved-change, change with no decision |
| P-DB-93 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-94 | missing | — | — | tested |
| P-DB-95 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-96 | missing | — | — | tested |
| P-DB-97 | missing | — | — | untested |
| P-DB-98 | missing | — | — | untested |
| P-DB-99 | missing | — | — | tested |
| P-DB-100 | missing | — | — | tested |
| P-DB-101 | missing | — | — | tested |
| P-DB-102 | missing | — | — | tested |
| P-DB-103 | missing | — | — | unapproved-change, change with no decision |
| P-DB-104 | missing | — | — | untested |
| P-DB-105 | missing | — | — | untested |
| P-DB-106 | missing | — | — | untested |
| P-DB-107 | missing | — | — | untested |
| P-DB-108 | missing | — | — | untested |
| P-DB-109 | missing | — | — | untested |
| P-DB-110 | missing | — | — | untested |
| P-DB-111 | missing | — | — | tested |
| P-DB-112 | missing | — | — | tested |
| P-DB-113 | missing | — | — | untested |
| P-DB-114 | missing | — | — | untested |
| P-DB-115 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-116 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-117 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-118 | missing | — | — | tested |
| P-DB-119 | missing | — | — | untested |
| P-DB-120 | missing | — | — | untested |
| P-DB-121 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-122 | missing | — | — | untested |
| P-DB-123 | missing | — | — | untested |
| P-DB-124 | missing | — | — | untested |
| P-DB-125 | missing | — | — | untested |
| P-DB-126 | missing | — | — | tested |
| P-DB-127 | missing | — | — | tested (fixed after the audit, `t3/v2-db-gaps`) |
| P-DB-128 | missing | — | — | untested |
| P-DB-129 | missing | — | — | not-applicable |
| P-DB-130 | missing | — | — | not-applicable |
| P-DB-131 | missing | — | — | approved-change |
| P-DB-132 | missing | — | — | approved-change |
| P-DB-133 | missing | — | — | untested |
| P-DB-134 | missing | — | — | tested |
| P-DB-135 | missing | — | — | tested |
| P-DB-136 | missing | — | — | tested |
| P-DB-137 | missing | — | — | tested |
| P-DB-138 | missing | — | — | unapproved-change, change with no decision |
| P-DB-139 | missing | — | — | unapproved-change, change with no decision |
| P-DB-140 | missing | — | — | untested |
| P-DB-141 | missing | — | — | untested |
| P-DB-142 | missing | — | — | approved-change |
| P-DB-143 | missing | — | — | unapproved-change, change with no decision |
| P-DB-144 | missing | — | — | approved-change |
| P-DB-145 | missing | — | — | approved-change |
| P-DB-146 | missing | — | — | approved-change |
| P-DB-147 | missing | — | — | untested |
| P-DB-148 | missing | — | — | gap |
| P-DB-149 | missing | — | — | untested |
| P-DB-150 | missing | — | — | gap |
| P-PRIVACY-01 | missing | — | — | untested |
| P-PRIVACY-02 | missing | — | — | untested |
| P-PRIVACY-03 | missing | — | — | untested |
| P-PRIVACY-04 | missing | — | — | untested |
| P-PRIVACY-05 | missing | — | — | tested |
| P-PRIVACY-06 | missing | — | — | tested |
| P-PRIVACY-07 | missing | — | — | untested |
| P-PRIVACY-08 | missing | — | — | tested |
| P-PRIVACY-09 | missing | — | — | tested |
| P-PRIVACY-10 | missing | — | — | untested |
| P-PRIVACY-11 | missing | — | — | untested |
| P-PRIVACY-12 | missing | — | — | untested |
| P-PRIVACY-13 | missing | — | — | tested |
| P-PRIVACY-14 | missing | — | — | approved-change |

## Appendix B: code check details

One row for each missing, deferred or open item. Evidence names the v2 file and the test. Paths are under `v2/` unless they say otherwise.

| ID | Check | Evidence | Note |
| --- | --- | --- | --- |
| P-AUTH-15 | tested | v2/src/server/ledger.ts:38 `requireMember`; test/db/groups.test.ts "does not grant access through a slug (P-GROUP-103, P-ACCESS-09)"; test/db/mcp-tools.test.ts "denies a group of someone else with a certain outcome"; test/db/stats-export.test.ts "refuses non-members (P-EXPORT-04)" | Every group read and write calls requireMember or an equivalent joined check (ledger.ts:124, groups.ts:157); `groups.create` and `groups.access` have their own checks. |
| P-AUTH-16 | tested | RPC `groups.list` takes no input and returns all active memberships (ledger.ts:52); MCP: test/db/mcp-tools.test.ts "fails the whole call when one requested group is not the caller’s" | The explicit-IDs form exists only on MCP `list_groups`, which is where the current app's callers used it. |
| P-AUTH-17 | tested | test/db/mcp-more-tools.test.ts "sums account balances per currency, restricts the scope, and refuses a foreign group or participant" | `{groups:[g1,g2]}` with g2 foreign fails FORBIDDEN as a whole. |
| P-AUTH-18 | not-applicable | v2/src/shared/api/groups.ts:144 and core payloads declare `groupId` as a required schema field | The tRPC middleware's generic "Group identifier is required" has no counterpart: a missing groupId fails schema decoding (MCP: BAD_REQUEST/VALIDATION). No decision covers the message change; nobody visible. |
| P-AUTH-19 | tested | `expenses.createUngrouped` (handlers/feed.ts:528) and MCP create_expense without groupId; test/db/ungrouped.test.ts "three-person ad hoc expense and email invitation are private and atomic"; test/db/mcp-more-tools.test.ts "creates a private expense with people and maps their labels to participants" | Ungrouped create skips the group check and builds its own private context. |
| P-AUTH-20 | tested | v2/src/server/groups.ts:290; test/db/groups.test.ts "lets only admins change settings (P-GROUP-64)" | Asserts Forbidden with the exact message "Only group admins can edit group settings". |
| P-AUTH-21 | tested | v2/src/server/mcp/oauth.ts:161 (no read -> 403), v2/src/server/mcp/endpoint.ts:33 (write step-up), v2/src/server/mcp/authenticate.ts:41 (in-transaction recheck); v2/test/db/mcp-oauth.test.ts "follow the current consent: write removed means step-up, read removed means 403" and "5. a read-only grant gets an HTTP 403 step-up challenge before the write runs, then re-authorizes" | RPC takes only session cookies (v2/src/server/rpc.ts:39), as the old tRPC context did; scoped principals exist only on MCP, where the rule is enforced and tested. |
| P-AUTH-22 | tested | test/db/groups.test.ts "removes access at once and keeps the participant and expenses (P-ACCESS-08, -54, -56)"; test/db/mcp-tools.test.ts "applies a membership removal to every key at the next request"; test/db/mcp-oauth.test.ts "see membership changes at once" | Web and agent principals carry no group list; membership is read per call. |
| P-AUTH-28 | not-applicable | v2/scripts/import-legacy.ts:67,70 copy `apikey` and `auth_bootstrap`; v2/test/legacy/verify-import.ts:30 checks the same apikey IDs | v2 never runs the bootstrap import; the imported rows carry over. Covered by PLAN.md Migration 3 ("Preserve users, Google accounts, hashed API keys"). |
| P-AUTH-29 | not-applicable | Same as P-AUTH-28 | Names and rate limits of the imported keys are copied as stored rows; no v2 code creates them. |
| P-AUTH-39 | tested | Principal is the key owner (mcp/authenticate.ts:95); test/db/mcp-tools.test.ts "applies a membership removal to every key at the next request"; test/db/mcp-more-tools.test.ts "edits as admin with the current revision only" | Membership and role are read per request. |
| P-AUTH-40 | tested | v2/src/server/mcp/authenticate.ts:25 `readApiKey`; test/db/mcp-auth.test.ts "reads the raw key from X-API-Key or Bearer, and refuses ambiguity"; test/db/mcp-tools.test.ts "accepts the raw key in X-API-Key or Bearer, or both when equal" | Covers `X-API-KEY` and `X-Api-Key` spellings. |
| P-AUTH-41 | tested | authenticate.ts:28 `/^Bearer ([^\s,]+)$/i`; test/db/mcp-auth.test.ts "reads the raw key from X-API-Key or Bearer, and refuses ambiguity" | Asserts `bearer <key>` is accepted. |
| P-AUTH-42 | tested | authenticate.ts:18 `validKey`; test/db/mcp-auth.test.ts "reads the raw key from X-API-Key or Bearer, and refuses ambiguity" | Asserts `short`, 4097 characters, a comma and trailing text are refused. |
| P-AUTH-43 | tested | authenticate.ts:32; test/db/mcp-auth.test.ts "reads the raw key from X-API-Key or Bearer, and refuses ambiguity"; test/db/mcp-tools.test.ts "refuses conflicting, malformed, unknown, revoked and unverified credentials with one challenge format" | Equal pair accepted, different pair 401. |
| P-AUTH-44 | tested | authenticate.ts:29; test/db/mcp-auth.test.ts "reads the raw key from X-API-Key or Bearer, and refuses ambiguity" (`Basic <key>` with a valid X-API-Key) | No fallback to the valid header. |
| P-AUTH-45 | closed (branch `t3/v2-server-gaps`) | Receipts: v2/src/server/receipts.ts:108 `receiptReader` takes the key path when either header is present. Exports: v2/src/server/app.ts:332 `exportGroup` reads only the session cookie | Exports ignore X-API-Key and Authorization entirely, and with a key header plus a cookie they use the cookie. An agent fetching the CSV/JSON export URL with its key gets 401. |
| P-AUTH-46 | tested | app.ts:333,337 (export 401 "Sign in required", 403 "Group access denied", Cache-Control `private, no-store`); receipts.ts:127-129; e2e/expense-edit-export.spec.ts "the Expenses tab exports the group as CSV, for members only" (401); test/db/stats-export.test.ts "refuses non-members (P-EXPORT-04)"; test/db/mcp-uploads.test.ts "uploads, attaches and downloads a receipt with the same API key" (403, 401) | Tests assert statuses only, not bodies or headers. The receipt 401 body is "Authentication required" in both apps; PARITY's wording is wrong for receipts. |
| P-AUTH-47 | closed (branch `t3/v2-server-gaps`) | MCP and receipts: test/db/mcp-uploads.test.ts "uploads, attaches and downloads a receipt with the same API key"; exports: app.ts:332 cookie only | The raw key does not authenticate `/<group>/expenses/export/{csv,json}`. MCP get_group still advertises those links (mcp/tools/groups.ts:165); `export_group` over MCP is the only agent path. An agent would notice. |
| P-AUTH-50 | untested | v2/src/client/routes/$group.tsx:19 redirects a Forbidden load to `/groups?access=denied` | Server refusal is tested ("does not grant access through a slug"); the client redirect has no e2e. |
| P-AUTH-59 | unapproved-change | v2/src/client/routes/index.tsx:50 `<Button asChild><Link to="/sign-in">Log In</Link></Button>` | The landing has a link in `main`, not a button; no nav, avatar or theme toggle (matches). No test. No decision covers the change. |
| P-AUTH-60 | unapproved-change | index.tsx:50 links to `/sign-in`; the Google call is in sign-in.tsx:68 | The current landing button calls `signIn.social({provider:'google', callbackURL:'/'})` directly; v2 adds a "Welcome to AgentSplit" page and a second Log In click. A person in the browser notices. |
| P-AUTH-61 | untested | v2/src/client/routes/index.tsx:33 `me ? <Dashboard /> : <Landing />` | No e2e opens `/` signed in. Group G covers only the stale AUTH.md text. |
| P-AUTH-62 | untested | index.tsx:39-55 (container, px-4) | No overflow test at 320/488/1280; not measured, so no-overflow is a prediction. |
| P-AUTH-69 | untested | No `activeUser`/`newUser` reads anywhere in v2/src/client; personal figures come from `memberships.participant_id` (ledger.ts:35, sql.ts) | No identity picker exists; no test sets the old localStorage keys. |
| P-AUTH-70 | untested | v2/src/client/components/expense-form-state.ts:303 `payer: data.viewer ?? ''`; expense-form.tsx:264 payer select | test/expense-form-state.test.ts builds state with a viewer but never asserts the default payer. |
| P-AUTH-71 | untested | v2/src/client/routes/$group/edit.tsx:184 shows "<name> (you)"; no "Active user" selector | The current app also renders "(you)" (src/app/groups/[groupId]/members.tsx:164); no "Participant: <name>" text exists in src/, so the PARITY text and the old e2e assertion are stale. v2 matches the current UI. |
| P-AUTH-72 | tested | ledger.ts:516 `actor`; test/db/mcp-tools.test.ts "records the authenticated actor and key, whoever paid"; test/db/feed.test.ts "attributes from create and update events, never the payer, and ignores baselines" | Web writes record source `web`, agentKeyId null (principal from session.ts:58). |
| P-AUTH-73 | tested | test/db/groups.test.ts "binds a legacy member without a participant, once (P-ACCESS-60..64)"; test/db/stats-export.test.ts "hides personal totals without a bound participant (P-STATS-21)" | Bind requires the matching verified email. |
| P-GROUP-47 | closed (branch `t3/v2-server-gaps`) | v2/src/client/routes/$group.tsx loader and ledger.ts:109 `getGroup` never check `groups.kind` | A private context ID opens the group layout (tabs, Settings) instead of `/expenses/<expenseId>`. MCP get_group gives `/groups/<contextId>` as the share link for a private context (mcp/tools/groups.ts:153), so a person following it sees the wrong page. |
| P-GROUP-50 | untested | v2/src/client/routes/$group.tsx:34-42 `TABS` in the required order | No test asserts the order. "Payments" is English, as group F/G allow. |
| P-GROUP-51 | tested | $group.tsx:72-82 `activeProps`; $group/index.tsx:4; e2e/group-expenses.spec.ts "a group opens on its expenses, sorts by date or by last change, and keeps the rail" | e2e checks the default Expenses tab and a tab click under the slug path; the active style is not asserted. |
| P-GROUP-52 | tested | $group.tsx:84-97 grid with `aside` rail; e2e/group-expenses.spec.ts "a group opens on its expenses, sorts by date or by last change, and keeps the rail" | The expense editor routes are children of `/$group`, so they share the layout. |
| P-GROUP-77 | tested | MCP get_group: v2/src/server/mcp/tools/groups.ts:154-166; test/db/mcp-tools.test.ts "reads a group with access, names, members, reserved IDs, expense participants and links" | RPC `groups.details` has no links, but the UI builds its own export URLs; the agent-facing procedure has context kind, access, participants and share/CSV/JSON links. |
| P-EXP-22 | browser check | v2/src/client/components/category-icon.tsx; v2/src/client/routes/$group/expenses.index.tsx, v2/src/client/routes/expenses/-feed-card.tsx | Closed after the audit. The map is keyed by the category IDs of db/migrations/0002_categories.sql, with the current app's icons. The icons are in their own 4.1 KB lazy chunk, not up front. |
| P-EXP-47 | tested | v2/e2e/expense-edit-export.spec.ts "an expense opens from the list without a page load and shows its log"; v2/src/client/routes/$group/expenses.$expenseId.edit.tsx:50 | ExpenseLog renders under the editor; record says deferred, but the history merge did it. |
| P-EXP-105 | tested | v2/test/db/mcp-tools.test.ts "edits only the given fields, checks the revision, and skips no-op revisions" (omitted vendor stays 'Nopa'; vendor: null clears) | The `vendor: ''` case is not asserted; v2/src/shared/expense-rules.ts:92 turns '' into null. |
| P-EXP-107 | closed (branch `t3/v2-server-gaps`) | Web: v2/src/client/routes/$group/activity.tsx:71-75 uses titleWithVendor (untested). MCP: v2/src/server/ledger.ts:587-595,677-685 write no `data`, so list_activity `data` is null (v2/src/server/mcp/tools/history.ts:316) | Agent over MCP: v2 expense events have data=null where the old app stored "<vendor> — <title>". The web Log matches but no test asserts it. |
| P-EXP-108 | tested | v2/test/db/mcp-tools.test.ts "lists with filters before offset pagination, newest expense date first" (vendor ' landlord ' finds 'Landlord'); v2/src/server/mcp/tools/expenses.ts:499-500 | Trim and case-insensitivity are asserted; a partial-match negative is not. |
| P-EXP-111 | tested | v2/src/server/mcp/endpoint.ts:33 refuses every `kind: 'write'` tool; v2/test/db/mcp-oauth.test.ts "5. a read-only grant gets an HTTP 403 step-up challenge..." (create_expense, count unchanged); v2/test/db/mcp-tools.test.ts "advertises the current names, annotations, scopes and input fields" pins update/delete as write | Only create is exercised directly; update and delete share the same kind check. The answer is now HTTP 403 insufficient_scope, not a tool FORBIDDEN (docs/v2/OAUTH-CLAUDE-CODE.md, not in DECISIONS.md). |
| P-EXP-112 | tested | v2/test/db/mcp-tools.test.ts "refuses bad list bounds and history selections before reading"; "advertises the current names, annotations, scopes and input fields" (fields match the current fixture); v2/src/server/mcp/tools/expenses.ts:452-467 | Default limit 10 (expenses.ts:472) and the 200-character filter cap are not asserted. |
| P-EXP-113 | tested | v2/test/db/mcp-tools.test.ts "lists with filters before offset pagination…" (hasMore true, nextCursor 2); v2/test/db/mcp-more-tools.test.ts "reads a saved revision and a historical list without live values" (history) | \| |
| P-EXP-114 | tested | v2/test/db/mcp-tools.test.ts "refuses bad list bounds and history selections before reading" ({from 2026-11-02, to 2026-11-01} → VALIDATION); v2/src/server/mcp/tools/expenses.ts:467 | The message text is not asserted. |
| P-EXP-115 | tested | v2/test/db/mcp-tools.test.ts "lists with filters before offset pagination…" (from=to=2026-10-01 returns that expense); v2/src/server/mcp/tools/expenses.ts:505-506 | \| |
| P-EXP-116 | tested | v2/test/db/feed.test.ts "person matches payer or beneficiary, payer matches payers only, and involving me uses the bound participant" (shared `involves`, v2/src/server/sql.ts); v2/src/server/mcp/tools/expenses.ts:508 | list_expenses itself only has a negative participantId check. |
| P-EXP-117 | tested | v2/test/db/mcp-tools.test.ts "lists with filters before offset pagination, newest expense date first"; v2/test/db/history.test.ts "filters saved values before paging"; v2/src/server/mcp/tools/expenses.ts:509-512 (WHERE before LIMIT/OFFSET) | The live-list test uses limit 100, so the SQL shape, not the test, proves the order for live rows. |
| P-EXP-118 | tested | v2/test/db/mcp-more-tools.test.ts "reads a saved revision and a historical list without live values"; v2/test/db/history.test.ts "filters saved values before paging" | \| |
| P-EXP-119 | tested | v2/test/db/mcp-tools.test.ts "lists with filters before offset pagination…" (paidBy {pb, 'Bob'} account name, not the placeholder); v2/test/db/mcp-more-tools.test.ts "renames only the caller, at once in current views…" (list_all_expenses) | A rename is asserted on list_all_expenses only; list_expenses uses the same displayName (mcp/tools/expenses.ts:311-312). |
| P-EXP-121 | tested | v2/test/db/history.test.ts "accepts only one selector and reports a missing revision"; v2/test/db/mcp-more-tools.test.ts "reads a saved revision and a historical list without live values" | Record (history area deferral) is out of date. |
| P-EXP-126 | tested | v2/test/db/mcp-tools.test.ts "refuses invalid money, dates, splits, people and unknown keys without writing" (expense({originalAmount:'5'})) | Create only. Update refuses through the closed `changes` object (mcp/tools/expenses.ts:729), untested. Refusal is VALIDATION "Unrecognized key", as the old strict MCP schema gave. |
| P-EXP-127 | tested | v2/test/db/mcp-tools.test.ts "refuses invalid money, dates, splits, people and unknown keys without writing"; "advertises the current names…" (closed objects match the fixture) | v2/src/server/mcp/registry.ts:136-148 rejects keys before decode. |
| P-EXP-128 | untested | v2/src/server/mcp/tools/expenses.ts:680 | The only test with groupId+people sends people: [], which fails the schema (VALIDATION) before this check. |
| P-EXP-130 | tested | v2/test/db/mcp-tools.test.ts "edits only the given fields, checks the revision, and skips no-op revisions"; "keeps exact BY_AMOUNT shares through a partial edit…" | mergedDraft (expenses.ts:620-650) then ledger re-validates the whole draft. |
| P-EXP-138 | tested | v2/test/db/mcp-more-tools.test.ts "records repayments inside the private context, and keeps its people fixed" (CONFLICT); v2/test/db/ungrouped.test.ts "repayment settles only the selected expense, preserving household balances" | v2/src/server/ungrouped.ts:220-221. |
| P-MONEY-26 | tested | v2/test/db/mcp-tools.test.ts "refuses invalid money, dates, splits, people and unknown keys without writing" | MCP refuses as an unknown key, like the old strict MCP schema. The quoted BAD_REQUEST text was tRPC-only; the v2 RPC contract has no such field. |
| P-MONEY-27 | untested | v2/src/server/mcp/tools/expenses.ts:118-122,729 (closed `changes`) | No test sends a conversion field to update_expense. Same message caveat as P-MONEY-26. |
| P-MONEY-28 | not-applicable | v2/src/server/mcp/tools/expenses.ts:62-98 (no originalCurrency input); v2/src/shared/api/core.ts ExpenseInput | No v2 input has the field. The old MCP schema already refused it as an unknown key; only the old tRPC form schema accepted ''. No decision. |
| P-MONEY-31 | tested | v2/test/db/mcp-tools.test.ts "advertises the current names, annotations, scopes and input fields" (only `payers` added) | \| |
| P-BAL-25 | tested | v2/test/db/mcp-more-tools.test.ts "derives public balances from the suggested repayments, per currency"; v2/src/server/mcp/tools/balances.ts:25-38 | DECISIONS.md group D keeps the meaning (P-BAL-25). |
| P-BAL-27 | tested | v2/test/db/mcp-tools.test.ts "refuses bad list bounds and history selections before reading" (asOf+atActivityId → BAD_REQUEST); v2/src/server/history.ts:43-45,266 | Message changed to "Choose asOf, atActivityId or revision, not more than one". get_balances shares checkBoundary but has no own test. |
| P-BAL-28 | tested | v2/test/db/history.test.ts "computes balances from the saved splits"; v2/test/db/mcp-more-tools.test.ts "reads balances as of an earlier recorded change" | \| |
| P-BAL-29 | tested | v2/test/db/history.test.ts "discloses expenses without saved state and refuses balances there" | Asserts the service message. The MCP PRECONDITION_FAILED code (balances.ts:87) is not asserted. |
| P-BAL-33 | tested | v2/test/db/mcp-more-tools.test.ts "sums account balances per currency, restricts the scope, and refuses a foreign group or participant" (duplicate message) | The 100-group cap (balances.ts:105) is not asserted. |
| P-BAL-36 | tested | v2/test/db/mcp-more-tools.test.ts "sums account balances per currency…" (bobView with participantId pb) | \| |
| P-BAL-37 | tested | v2/test/db/mcp-more-tools.test.ts "sums account balances per currency…" ('Participant does not belong to this group.'); v2/src/server/feed.ts:206-207 | An unknown group gives FORBIDDEN in v2. The old NOT_FOUND was unreachable too: src/trpc/init.ts:91 refuses it with FORBIDDEN first. |
| P-BAL-42 | tested | v2/test/db/mcp-more-tools.test.ts "sums account balances per currency…" (g2 → FORBIDDEN) | \| |
| P-BAL-52 | tested | v2/e2e/group-expenses.spec.ts "a group opens on its expenses, sorts by date or by last change, and keeps the rail"; v2/src/client/routes/$group.tsx:84-89,116 | Layout covers every tab and the editor. The label is "Group balances", as in the current app; only the Expenses tab is asserted. |
| P-BAL-53 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" ("You owe · USD", $10.00, then "Settled up · USD"); v2/src/client/routes/$group.tsx:145-156 | Closed after the audit. |
| P-BAL-54 | browser check | v2/src/client/routes/$group.tsx:149 | Closed after the audit. Checked in the browser for a member without a participant ("Group net balances · EUR"); no committed test. |
| P-BAL-55 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" ("Alice Example (you)", "gets back $20.00", "owes $10.00", "Settled up"); v2/src/client/routes/$group.tsx:187-207 | Closed after the audit. |
| P-BAL-56 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" ("You → Bob Example", "Cara Example → Bob Example"); v2/src/client/routes/$group.tsx:211-224 | Closed after the audit. The rail reads `balances.list`, as the Balances tab does. |
| P-BAL-57 | untested | v2/src/client/queries/expenses.ts:37-44 (invalidateMoney invalidates ['group', g]) | The e2e seeds through the API before the page loads, so no test watches the rail change. |
| P-BAL-58 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" (clicks "Refresh balances"); v2/src/client/routes/$group.tsx:119-127 | Closed after the audit. `refetchOnMount: 'always'` and `refetchOnWindowFocus`, as in the current app; the icon spins while it fetches. |
| P-BAL-59 | untested | v2/src/client/routes/$group.tsx:97-100 (rail reads unfiltered groupQuery) | No test searches and then reads the rail. |
| P-BAL-60 | browser check | v2/src/client/routes/$group.tsx:161-170 | Closed after the audit: each currency is a closed <details> below 768 px, with the summary in the closed state. Checked in the browser at 390 px (no horizontal overflow); no committed test. |
| P-BAL-61 | untested | v2/src/client/routes/$group.tsx:54,82 | No overflow test at 390 px or 1024 px. |
| P-BAL-62 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" ("No outstanding balances.", and "Could not load balances. Try refreshing." when `balances.list` fails); v2/src/client/routes/$group.tsx:133-141 | Closed after the audit. A failed load stays in the rail. |
| P-BAL-63 | tested | v2/e2e/group-expenses.spec.ts "the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)" (follows "Balance details" to the Balances tab); v2/src/client/routes/$group.tsx:180-182 | Closed after the audit. |
| P-BAL-64 | approved-change | DECISIONS.md group F: "Decision: option 2, English only." | Every v2 screen is English, so the QUESTION is settled. |
| P-BAL-90 | untested | v2/src/client/routes/$group/payments.$expenseId.edit.tsx:56 | ExpenseLog renders under the payment editor; no e2e opens a payment edit page. |
| P-BAL-102 | tested | v2/test/db/groups.test.ts "lists named groups newest first, with counts and the caller net per currency (P-GROUP-04, -05, -06, -11, P-BAL-102)"; v2/src/client/routes/groups.index.tsx:262-297 | Server sum asserted; the card UI is not. |
| P-BAL-103 | untested | v2/src/client/routes/groups.index.tsx:278-281 | \| |
| P-BAL-104 | untested | v2/src/client/routes/groups.index.tsx:262-297 (no identity selector) | \| |
| P-BAL-105 | untested | v2/src/client/routes/groups.index.tsx:263,272-281 | \| |
| P-BAL-106 | approved-change | DECISIONS.md group C: "The two balance totals can differ (P-BAL-106)"; v2/test/db/groups.test.ts "lists named groups newest first…" asserts directory totals equal accountBalances | Totals now match. Empty and partial texts still differ between the cards (groups.index.tsx:274,280 vs -dashboard-balance.tsx:32,36). |
| P-RECUR-03 | tested | v2/e2e/private-expenses.spec.ts "an ungrouped expense uses the full expense form with the private options… (P-UNGROUP-14, P-UNGROUP-15, P-UNGROUP-66, P-UNGROUP-67)" (Expense Recurrence toBeDisabled) | \| |
| P-UNGROUP-33 | tested | v2/test/db/mcp-more-tools.test.ts "creates a private expense with people and maps their labels to participants" | uploads: [] and uploadError: null come from expenses.ts:703-704 and the output schema; not asserted. |
| P-UNGROUP-34 | tested | v2/test/db/mcp-tools.test.ts "refuses a group outside the caller’s memberships as Forbidden, with a certain outcome" (exact message) | \| |
| P-UNGROUP-35 | untested | v2/src/server/mcp/tools/expenses.ts:688 | \| |
| P-UNGROUP-36 | untested | v2/src/server/mcp/tools/expenses.ts:680 | See P-EXP-128: the existing test fails the schema first. |
| P-UNGROUP-39 | closed (branch `t3/v2-server-gaps`) | v2/src/client/routes/$group.tsx:15-30, v2/src/server/ledger.ts:109-122 (getGroup has no kind filter), v2/src/shared/api/core.ts:76 (Group has no kind) | Person in the browser: /<contextId>/… and /groups/<contextId>/… open the full group shell (tabs, Settings) instead of /expenses/<expenseId>. |
| P-UNGROUP-41 | tested | v2/test/db/mcp-tools.test.ts "reads a group with access, names, members, reserved IDs, expense participants and links" (group/null); v2/test/db/mcp-more-tools.test.ts "records repayments inside the private context, and keeps its people fixed" (ungrouped) | \| |
| P-UNGROUP-42 | tested | v2/test/db/groups.test.ts "refuses settings edits of a private expense context (P-GROUP-74)" | v2/src/server/groups.ts:294-295. |
| P-UNGROUP-43 | untested | v2/src/server/groups.ts:431-436 | The app-level FORBIDDEN text is not asserted. The database trigger is: v2/test/db/ungrouped.test.ts "private access cannot be expanded or reclassified" (outsider invitation → 23514). |
| P-UNGROUP-44 | untested | v2/src/server/groups.ts:430 | Trigger backstop memberships_preserve_identity is tested separately. |
| P-UNGROUP-62 | tested | v2/test/db/ungrouped.test.ts "three-person ad hoc expense and email invitation are private and atomic" (guest NotFound before joining); v2/test/db/groups.test.ts "refuses the wrong email, revoked and expired invitations (P-ACCESS-38, -44)" | The wrong-email join is asserted on a named group; it is the same code (groups.ts:441-443). |
| P-UNGROUP-63 | untested | v2/src/client/routes/invite.$token.tsx:31,36,44-45 | Copy matches the current app; no test opens a private invitation page. |
| P-FEED-10 | tested | v2/test/db/groups.test.ts "lists named groups newest first, with counts and the caller net per currency (… P-BAL-102)" | Partial. The sum is asserted; the settled-up text and the card without an identity selector are not (groups.index.tsx:262-297). |
| P-FEED-40 | closed (branch `t3/v2-server-gaps`) | Live: v2/test/db/feed.test.ts "attributes from create and update events, never the payer, and ignores baselines". Boundary: v2/src/server/mcp/tools/expenses.ts:437-445 (attributionThrough reads the current u.name) | Agent over MCP: get_expense with revision/asOf/atActivityId shows current account names in attribution; the old app used the recorded names (src/lib/expense-attribution.ts:40-47). |
| P-HIST-01 | tested | v2/test/db/expenses.test.ts "records receipts in revision 1 and keeps them when an update omits them"; "creates every missed month on the anchor day, once, with copies of the receipts" (recurring) | Private creates go through ledger.createExpense (ungrouped.ts:112). |
| P-HIST-03 | closed (branch `t3/v2-server-gaps`) | v2/src/server/ungrouped.ts:94,107 writes group {…, defaultCurrency} with no `currency`; v2/src/shared/history.ts:142-153,311 require `currency` | Named groups are tested (groups.test.ts "lists a group edit in the Log with the snapshot the history reader accepts"). Each private-context create_group snapshot fails the reader with UnreadableSnapshot, so list_activity and the Log on a private context fail. Agent over MCP notices. Activities are append-only, so the fix must go in the reader. |
| P-HIST-04 | tested | v2/db/schema/app.ts:206 (enum); v2/test/db/ungrouped.test.ts "deletes the original after its repayments, and then refuses new repayments"; v2/test/db/groups.test.ts "creates an email-bound invitation…" (create/update/join_group) | \| |
| P-HIST-05 | tested | v2/test/db/expenses.test.ts "removing a receipt keeps it in the earlier revision, readable by members"; v2/test/db/history.test.ts "returns the values and names of a revision" | \| |
| P-HIST-06 | tested | v2/test/db/mcp-tools.test.ts "soft-deletes with the current revision and keeps the history"; v2/test/db/invariants.test.ts "freezes a deleted expense and its allocations" | Null snapshot is enforced by v2/db/migrations/0001_invariants.sql:56. |
| P-HIST-08 | tested | v2/test/db/expenses.test.ts "stops a series when its newest expense is set to none or deleted" | v2/src/server/ledger.ts:710. |
| P-HIST-10 | tested | v2/test/db/expenses.test.ts "adds no revision for an edit that changes nothing"; v2/test/db/mcp-tools.test.ts "edits only the given fields, checks the revision, and skips no-op revisions" | \| |
| P-HIST-11 | untested | v2/src/server/db.ts:56-60 (SERIALIZABLE, retried); v2/src/server/ledger.ts:374 (expense row FOR UPDATE) | v2 locks the expense row, not the group row. With expectedRevision, the second of two concurrent edits gets Conflict. Only a simulated retry is tested (mcp-tools.test.ts "retries a write after a serialization failure, as the RPC path does"). |
| P-HIST-12 | untested | v2/src/server/db.ts:56-60, v2/src/server/mcp/server.ts:85 (one transaction per write) | No test makes the activity insert fail. invariants.test.ts "refuses an edit without the next revision and its activity" is the closest. |
| P-HIST-13 | tested | v2/test/db/invariants.test.ts "refuses to change or remove an activity"; "refuses to hard-delete an expense" | TRUNCATE on expenses (0001_invariants.sql:29) is not asserted. |
| P-HIST-14 | tested | v2/test/db/invariants.test.ts "refuses an edit without the next revision and its activity"; "freezes a deleted expense and its allocations" | The baseline-before-first-edit rule (0001_invariants.sql:60-63) has no direct test. |
| P-HIST-15 | untested | v2/db/migrations/0000_init.sql:17 (UNIQUE expense_id, expense_revision) | \| |
| P-HIST-16 | untested | v2/db/migrations/0000_init.sql:2,16 (bigserial, unique); v2/scripts/import-legacy.ts:188-209 keeps sequence and resets the serial | Append-only part is tested (P-HIST-13). No test checks imported sequence order. |
| P-HIST-17 | untested | v2/db/migrations/0000_init.sql:5 (DEFAULT clock_timestamp()); ledger inserts never set time | \| |
| P-HIST-18 | tested | v2/test/db/groups.test.ts "refuses to remove a person in an expense with a friendly message (P-GROUP-76)"; v2/test/db/invariants.test.ts "refuses to delete a participant who is part of an expense" | A deleted expense keeps its share rows (FK RESTRICT), but no test removes a participant of a deleted expense. |
| P-HIST-21 | tested | v2/test/db/mcp-tools.test.ts "records the authenticated actor and key, whoever paid"; v2/test/db/mcp-more-tools.test.ts "shows agent writes with their actor, and the key ID only to its owner" | v2 stores source 'mcp' and the MCP output maps it to 'agent'. Every v2 write has an actor. |
| P-HIST-22 | not-applicable | v2/src/server/ledger.ts:24-31,516-521 (Principal always has userId) | v2 has no write without a signed-in principal. The old path was unreachable too: src/trpc/init.ts:45-47 refuses every call without one. No decision. |
| P-HIST-23 | tested | v2/test/db/expenses.test.ts "creates every missed month on the anchor day, once, with copies of the receipts" | Source 'system' shows as addedBy 'Automatic recurrence'; v2/src/server/recurring.ts:118-119,141. |
| P-HIST-24 | tested | v2/test/db/mcp-tools.test.ts "edits only the given fields, checks the revision, and skips no-op revisions" (stale → CONFLICT; missing → VALIDATION); v2/src/server/mcp/registry.ts:81 | DECISIONS.md group A keeps it. A missing revision is a schema VALIDATION error, as in the old MCP schema; the BAD_REQUEST text was tRPC-only. |
| P-HIST-25 | tested | v2/test/db/mcp-oauth.test.ts "refuses a write whose connection was revoked after authentication"; v2/src/server/mcp/authenticate.ts:41-51 | \| |
| P-HIST-26 | tested | v2/test/db/mcp-tools.test.ts "refuses a group outside the caller’s memberships as Forbidden, with a certain outcome"; "applies a membership removal to every key at the next request" | Checked in the write transaction by loadWriteContext (ledger.ts:401). |
| P-HIST-27 | not-applicable | v2/src/server/ledger.ts:37-45 (missing group = Forbidden); v2/test/db/mcp-tools.test.ts "denies a group of someone else with a certain outcome" ('missing-group') | v2 answers FORBIDDEN. The old NOT_FOUND sat behind src/trpc/init.ts:91, which already answered FORBIDDEN, and groups are never deleted. |
| P-HIST-60 | tested | v2/test/db/history.test.ts "keeps currencies separate and frozen after a currency edit (P-HIST-58)"; v2/test/db/groups.test.ts "keeps existing expenses unchanged when the default currency changes (P-GROUP-63)" | \| |
| P-HIST-61 | tested | v2/test/db/expenses.test.ts "removing a receipt keeps it in the earlier revision, readable by members" | The "another expense with the same file" half is untested; writeDocuments deletes only this expense's rows (ledger.ts:473). |
| P-HIST-63 | closed (branch `t3/v2-server-gaps`) | v2/src/client/routes/$group.tsx:14-19 (sign-in, then Forbidden → /groups?access=denied) | Access part done, untested. Missing: private contexts do not redirect to /expenses/<expenseId> (see P-UNGROUP-39). Person in the browser notices. |
| P-ACCESS-02 | tested | same as P-AUTH-21: v2/src/server/mcp/oauth.ts:161, endpoint.ts:33; v2/test/db/mcp-oauth.test.ts "follow the current consent: write removed means step-up, read removed means 403" | RPC has no OAuth principals (rpc.ts:39); MCP read refusal asserts 403 with `Read permission is no longer granted`. |
| P-ACCESS-04 | tested | test/db/mcp-tools.test.ts "fails the whole call when one requested group is not the caller’s" | The record's "Deferred (MCP area)" is stale. |
| P-ACCESS-05 | tested | test/db/mcp-more-tools.test.ts "sums account balances per currency, restricts the scope, and refuses a foreign group or participant" | With no groups it uses every membership; one foreign group fails the call. |
| P-ACCESS-06 | tested | Same as P-AUTH-19 | Duplicate of P-AUTH-19. |
| P-ACCESS-32 | untested | v2/src/client/routes/invite.$token.tsx:17 redirects to `/sign-in?next=/invite/<token>`; sign-in.tsx:28 shows "You’ve been invited to AgentSplit" for invitation paths | Implemented in both halves; no e2e covers the invite redirect or the invitation heading. The record's deferral is stale. |
| P-ACCESS-66 | tested | test/db/mcp-more-tools.test.ts "renews the original invitation of a private expense"; test/db/ungrouped.test.ts "three-person ad hoc expense and email invitation are private and atomic" (only the renewed invitation stays unrevoked) | RPC `expenses.renewInvitation` and MCP `renew_invitation` both exist. The record's deferral is stale. |
| P-SETTINGS-09 | tested | v2/src/server/mcp/tools/account.ts:11-12 (update_profile is `kind: 'write'`), endpoint.ts:33; v2/test/db/mcp-tools.test.ts "advertises the current names, annotations, scopes and input fields" (write securitySchemes); mcp-oauth.test.ts test 5 (the step-up path) | Indirect: no test calls update_profile with a read-only token, but the refusal is by tool kind and the kind is pinned. |
| P-SETTINGS-12 | tested | v2/src/server/sql.ts:27 `displayName`; test/db/mcp-tools.test.ts "reads a group with access, names, members, reserved IDs, expense participants and links" ("Alice"); test/db/feed.test.ts "shows current account names and the viewer participant"; test/db/mcp-more-tools.test.ts "renames only the caller, at once in current views, and keeps old audit names" | The record's "Deferred" is stale: ledger, groups, feed and MCP reads all use the overlay. |
| P-SETTINGS-13 | tested | sql.ts:30 coalesce to the stored name; test/db/mcp-tools.test.ts "reads a group with access, names, members, reserved IDs, expense participants and links" (`pc` keeps "Name pc") |  |
| P-SETTINGS-14 | untested | sql.ts:28 joins `"user"` only `AND bu.email_verified` | No test binds an unverified account to a participant and checks the name. |
| P-EXPORT-02 | not-applicable | src/lib/analytics/config.ts:9-11 returns `{ providers: [] }` always (P-PWA-44); v2 has no analytics client (grep finds none) | The current app's export event never leaves the browser, so nobody can observe its absence. No decision covers dropping the analytics layer. |
| P-EXPORT-05 | closed (branch `t3/v2-server-gaps`) | v2/src/server/app.ts:116-124 `exportGroup` calls only `sessionPrincipal`; app.ts:188 passes only the cookie | An agent that GETs `/<group>/expenses/export/csv` with `X-API-Key` gets 401 "Sign in required". Agents over MCP can use `export_group` (content inline), so only direct-HTTP scripts notice. |
| P-PWA-04 | browser check | v2/src/client/pwa.ts `addAppleSplashImages`; v2/src/client/main.tsx | Closed after the audit. The same algorithm, icon and color as the current app, with the same two media queries. It runs only where `navigator.standalone` exists (iOS), so other browsers skip the canvas work. |
| P-PWA-21 | unapproved-change | v2/src/client/routes/groups.$.tsx:5-10 (client redirect); v2/src/server/assets.ts:102 serves the SPA page with `no-cache` | No server 307 and no `Cache-Control: private, no-store`; a non-JS client gets 200 HTML. groups.md P-GROUP-100 records "Changed" but DECISIONS.md has no entry. Browser users see the same end URL. |
| P-PWA-22 | untested | v2/src/server/assets.ts:88 answers non-GET/HEAD with 405, never a redirect | No test for a POST to `/groups/<id>`. |
| P-PWA-23 | unapproved-change | v2/src/client/routes/$group/index.tsx:4 redirects `/<slug>` to `/<slug>/expenses`; e2e/group-expenses.spec.ts "a group opens on its expenses…" asserts the new URL | The current proxy rewrites `/<slug>` without a URL change (src/proxy.ts:38). `/<slug>/<rest>` matches. The e2e comment "as in the current app" is wrong. Cosmetic for a person. |
| P-PWA-24 | tested | test/db/groups.test.ts "does not grant access through a slug (P-GROUP-103, P-ACCESS-09)"; e2e/group-expenses.spec.ts "a signed-out visitor returns to the page they asked for after sign-in (P-AUTH-49)" | The non-member client redirect (P-AUTH-50) has no e2e. |
| P-PWA-25 | unapproved-change | app.ts:403 answers unknown `/api/*` with JSON 404 (matches); assets.ts:103 serves the SPA page for any other missing path, dotted or `/_next/`, and `/$group` then treats it as a group ref | A missing `/foo.png` gets 200 HTML and a group lookup instead of a 404. groups.md P-GROUP-102 calls this "Not applicable", which is wrong for dotted paths. Nobody visible except broken-asset debugging. |
| P-PWA-26 | unapproved-change | `/$group` catches every unmatched top-level path ($group.tsx:12-21) | A non-slug path such as `/foo` sends a signed-in person to `/groups?access=denied` (signed-out: `/sign-in?next=/foo`) instead of a 404 page. No decision covers it. A person typing a wrong URL notices. |
| P-PWA-36 | tested | v2/src/client/components/error-state.tsx; e2e/group-expenses.spec.ts "a tab that fails to load shows the group error under the tabs, with a reference and without the exception text (P-GROUP-53, P-PWA-36)" | Closed after the audit. The reference is made in the client and logged with the error, because the server returns no request ID. Only the browser console has the match, not the server logs. English-only title is approved (F). |
| P-PWA-49 | gap at b83751d; fixed on `t3/v2-db-gaps` | No `server-timing`, `x-perf-db-queries` or `PERF_INSTRUMENTATION` anywhere in v2/src | v2 never emits the perf headers, so the "only when enabled" half holds, but the instrumentation is not ported. Internal; nobody visible. |
| P-MCP-102 | untested | v2/src/server/auth-options.ts:35 `jwt()` plugin; v2/src/server/app.ts:160 routes /api/auth/* to Better Auth | No v2 test fetches /api/auth/jwks or checks for private fields. Better Auth's jwt plugin `getJwks` serves public keys; mcp/oauth.ts:33 rebuilds the same set from the jwks table. |
| P-MCP-105 | untested | @better-auth/mcp 1.7.14 dist/index.mjs:170 `refreshTokenReuseInterval = 30` default; v2/src/server/auth-options.ts:36-51 does not override it | No v2 test repeats a refresh. Provider replay logic: oauth-provider authorize-*.mjs:1899-1925. |
| P-MCP-106 | untested | oauth-provider 1.7.14 authorize-*.mjs:2324-2331 (refresh `invalid_scope` for a scope not in the refresh token); v2/src/server/auth.ts:37-47 (consent must cover scopes); mcp/oauth.ts:162 (token scopes within connection scopes) | No v2 test sends a refresh with a wider scope. |
| P-MCP-108 | tested | v2/src/server/auth-options.ts:20,45 `storeTokens: { hash: hashOAuthToken }`; v2/test/auth-hash.test.ts "hashes OAuth tokens exactly as the current app does"; v2/test/db/mcp-oauth.test.ts "6. after the access token expires, a refresh keeps the connection working" | Indirect for storage: auth.ts:33 finds the refresh row by its hash, and test 6 would fail with invalid_grant if the raw token were stored. No test reads the stored row. |
| P-MCP-109 | untested | oauth-provider 1.7.14 authorize-*.mjs:3643 `requirePKCE: true` default, 2165-2186 (verifier checks); v2 does not override | Every v2 test uses a correct S256 pair; no test sends a wrong verifier or omits code_challenge. |
| P-MCP-110 | untested | v2/src/server/auth.ts:24-25 | Ported verbatim; no v2 test issues a token for an unverified user or another grant type. |
| P-MCP-111 | untested | v2/src/server/auth.ts:37-47 | "end with revocation..." refreshes after `revokeOAuthConnection`, which deletes the refresh row, so Better Auth fails before this check; no test removes only the consent and then refreshes. |
| P-MCP-112 | untested | v2/src/server/auth.ts:28 (hashed code), 34 (refresh reuses `authorizationCodeId`), 48-52 (insert on conflict do nothing) | No test compares the connection claim before and after a refresh or counts oauth_connections rows per code. |
| P-MCP-114 | untested | v2/src/server/auth-options.ts:39 `loginPage: '/sign-in'`; oauth-provider authorize-*.mjs:8494-8503 (signed query on the login redirect) | Every v2 authorize call carries alice's cookie; the logged-out redirect with `sig` and `client_id` is not asserted. |
| P-MCP-116 | untested | v2/src/server/auth.ts:97-100 (Google provider, no account linking), 116-134 (bootstrap only for the bootstrap email) | No v2 test runs the Google callback; account.test.ts "is checked by the server too..." stops at the Google redirect URL. |
| P-MCP-118 | tested | v2/test/db/mcp-oauth.test.ts `authorize()` helper (line 79-80) sends `sec-fetch-mode: navigate` and asserts 302, used by "3. authorize, consent and token..."; DECISIONS.md group A: "Authorize keeps redirecting only real browser navigations (P-MCP-118)" | Answer to the QUESTION: Better Auth 1.7.14 (same as 1.7.6) returns JSON `{redirect, url}` only for `sec-fetch-mode: cors` or `Accept: application/json` (authorize-*.mjs:8075-8082); a request without the header still gets 302. The JSON branch is untested. |
| P-MCP-120 | untested | Better Auth registration (auth-options.ts:48-49); v2/test/db/mcp-oauth.test.ts "registers a public native client whose loopback callback works on any port" asserts no secret for `none` | Only the `none` half is tested; no test registers a client_secret_post or client_secret_basic client. |
| P-MCP-121 | untested | @better-auth/mcp index.mjs:176 `clientRegistrationDefaultResources` adds the MCP resource; oauth-provider authorize-*.mjs:596 (skip_consent refused), 4485-4487 (PKCE required) | The DCR test's token works at /api/mcp, so resource binding is exercised indirectly; it does not assert that consent was shown (the helper accepts either path) or that PKCE is required. |
| P-MCP-123 | untested | oauth-provider authorize-*.mjs:4354 (fragment), 4358-4368 (plain HTTP non-loopback), 596 (skip_consent), 4260-4266 and 4394 (client_credentials) | No v2 test of rejected registrations or of "no stored client". |
| P-MCP-124 | untested | oauth-provider authorize-*.mjs:7996-7999 (register 5 per 60 s); v2/src/server/auth.ts:102 `rateLimit: { enabled: true, storage: 'database' }` | No v2 test. Caveat: without `advanced.ipAddress.trustedProxies`, Better Auth keys only a single-value X-Forwarded-For; a multi-hop chain falls back to one shared bucket (better-auth dist/api/rate-limiter/index.mjs:236-248). Same in 1.7.6. |
| P-MCP-125 | untested | oauth-provider `validateClientCredentials` (authorize-*.mjs:1, used at token) | No v2 test of a confidential client at all. |
| P-MCP-126 | untested | oauth-provider `consumeClientAssertion` (authorize-*.mjs exports); account.test.ts "serves the authorization-server metadata" asserts only that private_key_jwt is advertised | No v2 test signs or replays a client assertion. |
| P-MCP-128 | untested | v2/src/server/auth.ts:69-75 `cimdFetch`; auth-options.ts:52 `cimd(... 'mcp-2026-07-28')` | mcp-oauth.test.ts covers Claude Code's CIMD document only (fetch stubbed); ChatGPT's document, its redirect and its private_key_jwt are not exercised. |
| P-MCP-137 | closed (branch `t3/v2-server-gaps`) | v2/src/server/app.ts:160 passes /api/auth/oauth2/revoke straight to Better Auth; oauth-provider authorize-*.mjs:6218-6268 only marks the refresh row revoked and deletes opaque access rows; mcp/oauth.ts:144-155 checks `oauth_connections.revoked_at`, which nothing sets | Missing: the current app's wrapper (src/app/api/auth/[...all]/route.ts:38-70) that tombstones the connection after a successful refresh revoke. An agent over MCP keeps a working access JWT for up to 300 s after it revokes. |
| P-MCP-138 | closed (branch `t3/v2-server-gaps`) | app.ts:160 passes /api/auth/oauth2/delete-consent straight to Better Auth; oauth-provider authorize-*.mjs:5727-5747 deletes only the consent row | Partly: MCP access and refresh stop at once (mcp/oauth.ts:137,154; auth.ts:47), but the connection is not tombstoned and refresh tokens remain, so a later re-consent revives the old refresh token and any unexpired JWT. Nobody visible: the v2 settings page uses account.revokeConnection (settings.connections.index.tsx:23), which tombstones. |
| P-MCP-139 | closed (branch `t3/v2-server-gaps`) | app.ts:160 passes /api/auth/oauth2/userinfo straight to Better Auth; oauth-provider authorize-*.mjs:1363-1410 checks only the JWT, `openid` scope and that the user exists | Missing: the current app's `authenticateOAuth` gate (route.ts:13-17). An OAuth client keeps reading name and email for up to 300 s after its connection is revoked, and an unverified account passes. |
| P-MCP-151 | untested | v2/src/client/routes/settings.connections.consent.tsx:68-142 (`max-w-lg px-4`, break-words/break-all on the title, client ID and host) | No e2e covers the consent page; the record checked 1280 px only. Line 101 "Signed in as {email}" has no break class, so a long email can overflow at 390 px. |
| P-TOOL-CREATEEXP-18 | tested | v2/test/db/mcp-more-tools.test.ts "creates due occurrences only in the given group, once" (create_expense DAILY, then 2 occurrences) | v2/src/server/ledger.ts:585 → recurring.ts:51-53. The mcp.md deferral is out of date. |
| P-TOOL-UPDATEEXP-08 | tested | v2/test/db/expenses.test.ts "drops a legacy conversion when the amount changes, and keeps it otherwise"; v2/src/server/ledger.ts:655-663 | A currency change also clears it (moneyChanged); only the amount case is asserted. |
| P-TOOL-EXPORT-06 | closed (branch `t3/v2-server-gaps`) | v2/src/server/app.ts:116-124 accepts only a session cookie | Missing: OAuth bearer (and API key) on the HTTP export routes, which OAUTH.md:48 promises. An agent fetching the export URL with its bearer gets 401. MCP `export_group` refuses another user's group (mcp-more-tools.test.ts line 351, FORBIDDEN), so MCP agents have a working path. |
| P-DB-01 | tested | v2/db/migrations/0001_invariants.sql:17-23 (activities_append_only, ERRCODE 23514); v2/test/db/invariants.test.ts "refuses to change or remove an activity" | Message text differs ("History is permanent; expenses are deleted only by setting deleted_at"); SQLSTATE is the same. |
| P-DB-02 | tested | 0001_invariants.sql:23 (BEFORE UPDATE OR DELETE); invariants.test.ts "refuses to change or remove an activity" (DELETE case) | Same trigger as P-DB-01. |
| P-DB-03 | tested | 0001_invariants.sql:25 activities_no_truncate (statement level); invariants.test.ts "refuses to change or remove an activity" (TRUNCATE activities CASCADE) | Parity. |
| P-DB-04 | tested | 0001_invariants.sql:27 expenses_no_hard_delete; invariants.test.ts "refuses to hard-delete an expense" | Parity. |
| P-DB-05 | untested | 0001_invariants.sql:29 expenses_no_truncate | No test runs TRUNCATE expenses (CASCADE or not). |
| P-DB-06 | untested | 0001_invariants.sql:17-23 (BEFORE trigger raises, so the statement aborts) | No test reads activities.data back after a refused mutation; true by PostgreSQL semantics. |
| P-DB-07 | tested | 0001_invariants.sql:69-70 expenses_revision_has_history DEFERRABLE INITIALLY DEFERRED; invariants.test.ts "accepts an edit with its activity, and moves updated_at" (update before activity insert commits) and "refuses an edit without the next revision and its activity" | Parity. |
| P-DB-08 | tested | 0001_invariants.sql:50; invariants.test.ts "refuses an edit without the next revision and its activity" (title edit without revision bump) | A jump of +2 is not tested, but the same condition covers it. |
| P-DB-09 | untested | 0001_invariants.sql:50 (NEW.id <> OLD.id OR NEW.group_id <> OLD.group_id) | DECISIONS.md A confirms "An expense never moves between groups (P-DB-09; enforced by the revision trigger)"; the QUESTION asked for a test and none exists. |
| P-DB-10 | tested | 0001_invariants.sql:50 (OLD.deleted_at IS NOT NULL); invariants.test.ts "freezes a deleted expense and its allocations" | v2 also freezes the deleted expense's payers and shares (0001:105-108). |
| P-DB-11 | tested | 0001_invariants.sql:53-59; invariants.test.ts "refuses an edit without the next revision and its activity" (revision = 2 without activity) | Parity. |
| P-DB-12 | untested | 0001_invariants.sql:55 (jsonb_typeof = 'object' AND type IN create_expense, update_expense) | No test commits a live revision with a wrong type or a non-object snapshot. |
| P-DB-13 | untested | 0001_invariants.sql:56 (delete_expense with NULL snapshot) | Only the accepting path is tested ("freezes a deleted expense..."); no test of a delete with a snapshot or a wrong type. |
| P-DB-14 | untested | 0001_invariants.sql:60-64; baseline writer v2/src/server/ledger.ts:608-624 | history.test.ts "counts a baseline only from its recording time" covers the success path; no test shows that a first edit without a baseline fails. |
| P-DB-15 | approved-change | DECISIONS.md A: "Only the importer writes revision 0 rows (P-DB-15)"; app inserts revision 1 only (ledger.ts:581, recurring.ts:108-110); importer v2/scripts/import-legacy.ts:152 | The rule is enforced only by app code: the DB still accepts a direct revision-0 INSERT with no activity (0001:53 skips revision 0). |
| P-DB-16 | closed (branch `t3/v2-server-gaps`) | ledger.ts:608-624 ensureBaseline writes type 'update_expense', source = principal source (web or mcp), revision 0 | Current app writes CREATE_EXPENSE with source 'baseline'. UI treats revision 0 as a baseline (revision.tsx:22, expense-log.tsx:31), but MCP attribution filters only source <> 'baseline' (v2/src/server/mcp/tools/expenses.ts:327, 442), so a v2 baseline counts as an update event; an agent reading at the baseline's atActivityId would get the editor as updatedBy. Rare, agent-visible. |
| P-DB-17 | tested | ledger.ts:568-597 (revision 1 plus create_expense in one transaction); v2/test/db/expenses.test.ts "records receipts in revision 1 and keeps them when an update omits them"; history.test.ts "returns the values and names of a revision" | Recurring copies also start at revision 1 with create_expense (recurring.ts:108-140). |
| P-DB-18 | untested | ledger.ts:568-597 inside one serializable transaction (rpc.ts:68, db.ts:60); deferred trigger 0001:69 | No test forces a failed activity insert and checks that the expense, its parts and its revision roll back. |
| P-DB-19 | tested | ledger.ts:708 (deleted_at, revision + 1; parts and documents untouched); v2/test/db/ledger.test.ts "deletes by tombstone and keeps balances consistent"; expenses.test.ts "serves a receipt that only a deleted expense refers to" | Parity. |
| P-DB-20 | unapproved-change | v2/src/server/recurring.ts:61-63 stopRecurrence deletes the open recurring_links row; expenses.test.ts "stops a series when its newest expense is set to none or deleted" | Current app keeps the link and sets nextExpenseCreatedAt to the delete time. Same effect (series stops), but the link row is gone. Nobody visible. |
| P-DB-21 | tested | ledger.ts:711 (delete_expense, no snapshot); history.test.ts "returns the deletion first, with the last saved state as the previous snapshot (P-HIST-39)" | Parity. |
| P-DB-22 | tested | ledger.ts:439-455 snapshot() takes names and group currency at write time; history.test.ts "returns the values and names of a revision" (Bob renamed before the read, snapshot keeps "Bob") | Group-currency freeze in the snapshot is not asserted directly; groups.test.ts "keeps existing expenses unchanged when the default currency changes (P-GROUP-63)" checks balances only. |
| P-DB-23 | untested | v2/src/server/sql.ts:71-74 (ORDER BY participant_id, amount::text formatted as decimal strings) | v2 snapshot has payers and shares lists, not paidFor; order uses the DB collation, not JS code-unit order. No test asserts the order. |
| P-DB-24 | approved-change | ledger.ts:448-453 schemaVersion: 2, kind = expense kind ('expense' or 'payment'); imported v1 snapshots keep schemaVersion 1 (import-legacy.ts:187-202) | The new shape follows from approved features: PLAN.md "Multiple payers per expense" and DECISIONS.md "Revision snapshots record the expense's receipts". No decision names schemaVersion 2 explicitly. history.test.ts "compares a v1 revision and the v2 revision after it field by field" covers both shapes. |
| P-DB-25 | tested | ledger.ts:483-505 writeExpense (delete stale parts, upsert changed ones), ledger.ts:465-476 writeDocuments (delete all, reinsert); expenses.test.ts "removing a receipt keeps it in the earlier revision, readable by members"; history.test.ts "shows the exact previous and current allocations of every revision" | v2 updates unchanged parts in place instead of rewriting them; the result is the same. |
| P-DB-26 | untested | v2/db/migrations/0000_init.sql:80 expenses_revision_nonnegative | No test inserts a negative revision. |
| P-DB-27 | untested | 0000_init.sql:18 activities_snapshot_revision | No test. |
| P-DB-28 | untested | 0000_init.sql:17 activities_expense_revision UNIQUE(expense_id, expense_revision); relied on by ledger.ts:623 onConflictDoNothing | No test inserts a duplicate revision activity. |
| P-DB-29 | tested | 0001_invariants.sql:4 (the same 34 codes); invariants.test.ts "refuses an unsupported currency" | v2 adds the same CHECK on original_currency (0001:6) and groups.default_currency (0001:8). |
| P-DB-30 | untested | 0001_invariants.sql:3-8 vs v2/src/shared/currencies.ts (34 codes, equal today) | No test compares the migration list with CURRENCIES; adding a currency still needs both. |
| P-DB-31 | untested | 0000_init.sql:69 currency NOT NULL | No test of a NULL currency. |
| P-DB-32 | approved-change | DECISIONS.md A: "integer minor units (P-DB-32)"; 0000_init.sql:70 amount bigint, :72 original_amount bigint; import-legacy.ts:42-46 stops on any lost decimal; v2/test/legacy/differential.test.ts "round-trips minor units through decimal strings", "rejects more decimals than the currency allows" | CUTOVER.md records the verifier passing every balance to the cent. |
| P-DB-33 | unapproved-change | 0000_init.sql:54-55 expense_shares.amount bigint plus weight text DEFAULT '1'; 0001_invariants.sql:10 weight decimal regex | Numeric(30,12) becomes exact decimal text without the 30/12 digit limits; the resolved share is minor units (covered by A, P-DB-32), but no decision covers the weight type. Nobody visible. |
| P-DB-34 | unapproved-change | 0000_init.sql:74 conversion_rate text, nullable, no format CHECK | NUMERIC(65,30) becomes unchecked text. The importer refuses any converted expense (import-legacy.ts:135-136) and no v2 write path sets a conversion, so only test rows hold one. Nobody visible today. |
| P-DB-35 | approved-change | DECISIONS.md A: "a complete conversion or none (P-DB-35)"; 0000_init.sql:81 expenses_conversion_complete | No test inserts a half-filled conversion. |
| P-DB-36 | approved-change | DECISIONS.md A: "payer and share sums checked by the database (P-DB-36)"; 0001_invariants.sql:73-125; invariants.test.ts "refuses shares that do not sum to the amount", "refuses payments that do not sum to the amount", "refuses a later change that unbalances an expense" | Implemented and tested. |
| P-DB-37 | approved-change | DECISIONS.md A: "precision fixed by the integer type (P-DB-37)"; bigint minor units; differential.test.ts "rejects more decimals than the currency allows" | Implemented. |
| P-DB-38 | tested | No sign CHECK on expenses.amount (0000_init.sql:70); DECISIONS.md D: "Negative amounts stay allowed (P-DB-38)"; expenses.test.ts "accepts a payment shared by several people, and a negative one (P-BAL-93)" | Kept on purpose; zero is also storable. |
| P-DB-39 | unapproved-change | 0000_init.sql:68 expense_date date NOT NULL, no DEFAULT | The CURRENT_DATE default is gone; every v2 writer sets the date. Nobody visible. |
| P-DB-40 | untested | 0000_init.sql:67 category_id NOT NULL DEFAULT 0, FK :409 | No test relies on the default. |
| P-DB-41 | unapproved-change | 0000_init.sql:71 split_mode text NOT NULL, no DEFAULT | The EVENLY default is gone; every v2 writer sets it. Nobody visible. |
| P-DB-42 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:71 split_mode text with no CHECK; values limited only by Drizzle text enum (v2/db/schema/app.ts:145) and app validation | The DB accepts any split_mode string, where the current app's enum refuses one. Internal: nobody visible unless a bad write slips past the app. Values map EVENLY, BY_SHARES, BY_PERCENTAGE, BY_AMOUNT to evenly, shares, percentage, amount. |
| P-DB-43 | unapproved-change | 0000_init.sql:63 kind text NOT NULL ('expense' or 'payment'), no DEFAULT, no CHECK; import-legacy.ts:153 | isReimbursement becomes kind without a default and without a DB value check. Nobody visible. |
| P-DB-44 | untested | 0000_init.sql:76 created_at DEFAULT now(); ledger.ts:581 does not set it | v2 relies on the default (transaction start time) instead of setting it explicitly; same result in practice. |
| P-DB-45 | unapproved-change | 0000_init.sql:64-66 title NOT NULL, vendor nullable, notes NOT NULL DEFAULT ''; import-legacy.ts:156 maps NULL to '' | notes changes from nullable to non-null ''; MCP maps '' back to null (mcp/tools/expenses.ts:384, 544), so agents see no change. Nobody visible. |
| P-DB-46 | approved-change | DECISIONS.md A: "a non-null recurrence (P-DB-46)"; 0000_init.sql:75 recurrence NOT NULL DEFAULT 'none'; import-legacy.ts:162 maps NULL to none | Implemented. |
| P-DB-47 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:75 recurrence text with no CHECK; only Drizzle enum (app.ts:150) and app validation | The DB accepts any recurrence string. Internal: nobody visible unless the app writes a bad value. |
| P-DB-48 | untested | 0000_init.sql:440 expenses_group_date (group_id, deleted_at, expense_date DESC, created_at DESC, id DESC) | Index exists and extends the current one; ordering behavior is tested in ledger.test.ts "orders by expense date or by last change, and filters". |
| P-DB-49 | gap at b83751d; fixed on `t3/v2-db-gaps` | No (group_id, currency, deleted_at) index in v2/db/migrations; balances (v2/src/server/sql.ts:39-50) also filter expense_payers and expense_shares by group_id, which have no group_id index | Performance only. expenses_group_date covers the group and deleted_at prefix. Nobody visible at today's size (48 expenses). |
| P-DB-50 | untested | 0000_init.sql:442 expenses_feed (expense_date DESC, created_at DESC, id DESC) | Index exists; ordering is tested by v2/test/db/feed.test.ts "orders by expense date, then creation time, then ID, newest first". |
| P-DB-51 | tested | 0000_init.sql:408 expenses group FK ON DELETE RESTRICT; 0001_invariants.sql:155 groups_no_delete; invariants.test.ts "refuses to delete a group" | v2 is stricter: no group can be deleted, even one without expenses. |
| P-DB-52 | untested | 0000_init.sql:405 expense_payers (participant_id, group_id) FK ON DELETE RESTRICT | The invariant test deletes a share participant (Bob), not a payer; no test deletes a payer. |
| P-DB-53 | tested | 0000_init.sql:407 expense_shares participant FK RESTRICT; invariants.test.ts "refuses to delete a participant who is part of an expense" (SQLSTATE 23001) | Parity. |
| P-DB-54 | untested | v2/src/server/groups.ts:333-366 replacePeople counts payers and shares of every expense, deleted included, and throws Invalid | groups.test.ts "refuses to remove a person in an expense with a friendly message (P-GROUP-76)" covers a live expense only; the soft-deleted case is not asserted. |
| P-DB-55 | unapproved-change | 0000_init.sql:404, 406 expense_payers and expense_shares to expenses ON DELETE RESTRICT | CASCADE becomes RESTRICT. Unreachable both ways, because hard expense deletes are blocked. Nobody visible. |
| P-DB-56 | untested | 0000_init.sql:47, 56 PRIMARY KEY (expense_id, participant_id) on expense_payers and expense_shares | No test inserts a duplicate participant. |
| P-DB-57 | untested | 0000_init.sql:409 category FK ON DELETE NO ACTION | NO ACTION, not RESTRICT; the only difference is check timing. No test. |
| P-DB-58 | unapproved-change | 0000_init.sql:35 expense_documents.expense_id NOT NULL, :403 ON DELETE RESTRICT; import-legacy.ts:215-217 stops on an orphan document | Nullable SET NULL becomes NOT NULL RESTRICT; unreachable in practice, and the production import found no orphans. Nobody visible. |
| P-DB-59 | untested | 0000_init.sql:37-38 width and height integer NOT NULL | No test. |
| P-DB-60 | untested | 0000_init.sql:402 activities group FK ON DELETE RESTRICT | groups_no_delete fires before the FK, so the FK itself is not exercised by "refuses to delete a group". |
| P-DB-61 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:1-19, 402: activities.expense_id and activities.participant_id still have no foreign keys | DECISIONS.md C approves the fix ("Several references have no foreign keys (P-DB-61, ...)"), but v2 does not add them. Internal: nobody visible. |
| P-DB-62 | unapproved-change | 0000_init.sql:414 participants group FK ON DELETE RESTRICT, plus groups_no_delete | CASCADE becomes RESTRICT; groups are never deleted in v2. Nobody visible. |
| P-DB-63 | tested | 0000_init.sql:152 participants_id_group; composite FKs at :405, :407, :411, :413, :418; invariants.test.ts "refuses a participant from another group" (23503) | Only the expense_shares composite FK is exercised by a DB test; membership, invitation and private-person FKs are untested at the DB. |
| P-DB-64 | unapproved-change | 0000_init.sql:183 unique current_frame_expense_id, :420 FK ON DELETE RESTRICT | CASCADE becomes RESTRICT; unreachable because expenses are never hard-deleted. Nobody visible. |
| P-DB-65 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:177-184, 420: recurring_links.group_id has no FK and no check that it matches the frame expense's group | DECISIONS.md C approves the fix ("P-DB-65"), not done. Expense.recurringExpenseLinkId no longer exists in v2, so that half is gone. Internal: nobody visible. |
| P-DB-66 | approved-change | DECISIONS.md A: "calendar date for recurrence (P-DB-66)"; 0000_init.sql:182 next_expense_date date NOT NULL | Importer copies timestamps into the date column under TZ=UTC (import-legacy.ts:17, 219). |
| P-DB-67 | tested | recurring.ts:86-120 (SELECT ... FOR UPDATE SKIP LOCKED on next_expense_created_at IS NULL, deterministic occurrence ID, SERIALIZABLE); expenses.test.ts "never duplicates when two runs race" | The mechanism differs (row lock plus deterministic ID, not a conditional UPDATE); the guarantee holds. |
| P-DB-68 | untested | 0000_init.sql:419 receipts group FK ON DELETE RESTRICT | No test. |
| P-DB-69 | untested | 0000_init.sql:174 receipts_group_url UNIQUE(group_id, url) | No test inserts a duplicate. |
| P-DB-70 | gap at b83751d; fixed on `t3/v2-db-gaps` | No trigger on receipts in v2/db/migrations/*.sql; the app never deletes receipts rows (no delete in v2/src) | DECISIONS.md G approves "P-DB-70 (receipt rows immutable by trigger)", not done. App behavior is tested by expenses.test.ts "removing a receipt keeps it in the earlier revision, readable by members". Internal: nobody visible. |
| P-DB-71 | tested | v2/db/migrations/0002_categories.sql (IDs 0-43); expenses.test.ts "lists categories in ID order" (44 rows, 43 = Life/Donation) | Parity. |
| P-DB-72 | untested | 0000_init.sql:91, 94 revision NOT NULL DEFAULT 0, groups_revision_nonnegative | No test of a negative group revision. |
| P-DB-73 | approved-change | DECISIONS.md C: "Group edits have no database audit guarantee (P-DB-73)"; 0004_group_audit.sql:14-36; groups.test.ts "refuses a group edit without its activity, at the database (P-DB-73)" | Implemented and tested. |
| P-DB-74 | tested | 0000_init.sql:87, 93 slug nullable UNIQUE; groups.test.ts "refuses a slug in use by another group (P-GROUP-95)" | The test hits the app check; the DB unique is the backstop. v2 stores lowercase slugs. |
| P-DB-75 | tested | groups.ts:205-206 pg_advisory_xact_lock(hashtextextended(slug, 0)); groups.test.ts "lets exactly one of two concurrent creates claim a slug (P-GROUP-96)" | Parity. |
| P-DB-76 | approved-change | v2/db/migrations/0000_init.sql:90 `default_currency text NOT NULL`; 0001_invariants.sql `groups_currency_supported`; import-legacy.ts:109 | v2 drops the symbol column and stores only a required, registry-checked code (PLAN invariant 1 "exhaustive currency registry"; DECISIONS "MCP group currency": ambiguous symbols refused); the importer fails a group with a NULL currencyCode. |
| P-DB-77 | gap at b83751d; fixed on `t3/v2-db-gaps` | v2/db/schema/app.ts:205 (TS enum only); 0000_init.sql:6 `"type" text NOT NULL`, no CHECK; import-legacy.ts:197 lowercases any value | The same 7 types exist in TypeScript, but the database no longer refuses another type, as the Postgres enum did. Internal: nobody notices. |
| P-DB-78 | untested | 0000_init.sql:5 `DEFAULT clock_timestamp()`; no activity insert sets `time` (ledger.ts:587,613,677,711) | No test asserts distinct times inside one transaction. |
| P-DB-79 | closed (branch `t3/v2-server-gaps`) | mcp/authenticate.ts:64,98 and ledger.ts:28 write `source = 'mcp'`, never `agent` or `baseline`; history.ts:168 reads both; export.ts:174 exports the raw value | NOT NULL default 'web' matches (0000_init.sql:12). New agent events say `mcp`, imported ones `agent`, so a JSON export mixes both values. No decision covers the rename. |
| P-DB-80 | tested | 0000_init.sql:2 bigserial + `activities_sequence_unique`; history.ts:66,159 order by sequence; v2/test/db/history.test.ts "keeps pages fixed at the returned boundary while events are added" | bigint instead of integer; harmless. |
| P-DB-81 | not-applicable | import-legacy.ts:188,193 copy `sequence` verbatim in sequence order | The backfill ran once on the old database before the import; v2 keeps its result and never reruns it. No decision needed. |
| P-DB-82 | not-applicable | import-legacy.ts:188-205 | Historical backfill; the importer copies the backfilled rows unchanged. No decision needed. |
| P-DB-83 | not-applicable | import-legacy.ts:193 | Historical backfill; v2 keeps the backfilled order. verify-import.ts does not compare `sequence` values, so this is preserved by code but not checked. |
| P-DB-84 | untested | import-legacy.ts:209 `setval(..., coalesce(max(sequence), 1))` (next = max + 1) | No importer test in CI, and verify-import.ts does not check the sequence; it ran once at the cutover. |
| P-DB-85 | tested | 0001_invariants.sql `activities_append_only`, `activities_no_truncate`; no DISABLE TRIGGER in v2/db or v2/scripts; v2/test/db/invariants.test.ts "refuses to change or remove an activity" | v2 never disables the trigger, so it is always active. |
| P-DB-86 | untested | 0000_init.sql:435-436 `activities_group_id_time_id_index`, `activities_group_id_sequence_index` | Both indexes exist; no test (none is expected for an index). |
| P-DB-87 | unapproved-change | db.ts:60 SERIALIZABLE with retries (db.ts:62); ledger.ts:374 locks the expense row FOR UPDATE, not the group row; groups.ts:273 `lockGroup` only for group and access edits | Expense writes no longer take the group row lock. SERIALIZABLE gives the safety instead, but no decision approves the change. Internal. |
| P-DB-88 | approved-change | ledger.ts:374 expense row FOR UPDATE + db.ts:60 SERIALIZABLE + revision trigger (0001_invariants.sql `expenses_revision_has_history`) | v2 requires expectedRevision on every edit (DECISIONS A: "Edits and deletes keep requiring expectedRevision (P-HIST-24)"), so the second of two concurrent edits gets Conflict instead of becoming revision N+2. No v2 test runs two concurrent expense updates. |
| P-DB-89 | unapproved-change | recurring.ts:93 locks the link row `FOR UPDATE SKIP LOCKED` in its own SERIALIZABLE transaction, with no group row lock; v2/test/db/expenses.test.ts "never duplicates when two runs race" | The outcome (no duplicates) is tested, but the lock order differs from edits, and no decision covers it. |
| P-DB-90 | unapproved-change | server.ts:40 `connectionTimeoutMillis: 5_000`; db.ts:58-63 4 retries; no transaction or statement timeout anywhere | v2 has no 15 s transaction cap and waits 5 s, not 10 s, for a connection. Internal: a stuck transaction can hold its locks indefinitely. |
| P-DB-91 | untested | 0000_init.sql:132 `memberships_user_id_group_id_pk` | Matches; no test asserts the key. |
| P-DB-92 | unapproved-change | 0000_init.sql:412 `memberships` → `groups` ON DELETE restrict; 0001_invariants.sql `groups_no_delete`; v2/test/db/invariants.test.ts "refuses to delete a group" | CASCADE becomes RESTRICT, and groups cannot be deleted. Neither app has a group delete path, so nobody notices, but no decision names it (PLAN invariant 5 comes closest). |
| P-DB-93 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:125-134 `memberships.user_id` has no FK to `user` | DECISIONS C approves the fix: "Several references have no foreign keys (P-DB-61, P-DB-65, P-DB-93, P-DB-117, P-DB-127)". v2 did not add the FK. Internal. |
| P-DB-94 | tested | 0000_init.sql `"active" boolean DEFAULT true`; groups.ts:572 leave sets active=false; v2/test/db/groups.test.ts "lets any member leave and rejoin as the same participant (P-ACCESS-19, -50, -57)" | Matches. |
| P-DB-95 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:128 `"role" text DEFAULT 'member' NOT NULL`, no CHECK; app.ts:76 TS enum only; import-legacy.ts:115 copies roles unchecked | DECISIONS A approves "a role limited to admin or member (P-DB-95)", and PLAN wants each invariant in the database too. v2 limits the role only in TypeScript. Internal. |
| P-DB-96 | tested | 0000_init.sql:130 nullable `participant_id`; import-legacy.ts:115 copies it unchanged; v2/test/db/groups.test.ts "binds a legacy member without a participant, once (P-ACCESS-60..64)" | Matches; nothing infers identities. |
| P-DB-97 | untested | 0000_init.sql:133 `memberships_group_participant` UNIQUE(group_id, participant_id) | The constraint matches. Tests check only the app message ("That participant is already tied to another account."); no test hits the database constraint, unlike TMI. |
| P-DB-98 | untested | 0000_init.sql:413 memberships (participant_id, group_id) → participants ON DELETE restrict | Matches. invariants.test.ts "refuses to delete a participant who is part of an expense" exercises the expense FK, not the membership FK. |
| P-DB-99 | tested | 0001_invariants.sql `agentsplit_preserve_member_identity` ("Member identity cannot be reassigned"); v2/test/db/invariants.test.ts "refuses to reassign a bound member" | Matches; renamed trigger `memberships_preserve_identity`. |
| P-DB-100 | tested | same trigger allows `active` and `role`; v2/test/db/groups.test.ts "lets any member leave and rejoin as the same participant (P-ACCESS-19, -50, -57)", "keeps the last admin (P-ACCESS-55) and lets roles change (P-ACCESS-53)" | Matches. |
| P-DB-101 | tested | groups.ts:358; v2/test/db/groups.test.ts "refuses renaming or removing bound or invited people (P-GROUP-71)" | Matches. |
| P-DB-102 | tested | 0000_init.sql:118 `invitations_tokenHash_unique`; v2/test/db/groups.test.ts "creates an email-bound invitation with a hashed 43-character token that expires in 7 days (P-ACCESS-11..15)" | The test asserts that only the hash is stored; uniqueness exists but is not asserted. |
| P-DB-103 | unapproved-change | 0000_init.sql:410 `invitations` → `groups` ON DELETE restrict; `groups_no_delete` | CASCADE becomes RESTRICT, as in P-DB-92. Not visible, because groups are never deleted, but no decision names it. |
| P-DB-104 | untested | 0000_init.sql:411 invitations (participant_id, group_id) → participants ON DELETE restrict | Matches. |
| P-DB-105 | untested | 0000_init.sql:107-117 email, created_by, expires_at NOT NULL; accepted_at, revoked_at nullable | Matches. |
| P-DB-106 | untested | 0000_init.sql:155-158 `private_contexts` PK group_id + `private_contexts_expenseId_unique` | Matches (table renamed from UngroupedExpense). |
| P-DB-107 | untested | 0000_init.sql:415-416 private_contexts → groups and → expenses ON DELETE restrict | Matches. |
| P-DB-108 | untested | 0000_init.sql:161-165 `private_people` PK participant_id + UNIQUE(group_id, email) | Matches. The PK on participant_id is stricter than (participantId, groupId). |
| P-DB-109 | untested | 0000_init.sql:417-418 both FKs ON DELETE restrict | Matches. |
| P-DB-110 | untested | 0001_invariants.sql `private_contexts_fixed` BEFORE UPDATE OR DELETE | Matches. No test updates or deletes a private_contexts row directly. |
| P-DB-111 | tested | 0001_invariants.sql `private_people_fixed`; v2/test/db/ungrouped.test.ts "private access cannot be expanded or reclassified" (DELETE FROM private_people refused 23514) | Matches; renamed from protect_ungrouped_people. |
| P-DB-112 | tested | ungrouped.ts:221; 0005_private_contexts.sql "Remove the repayments..."; v2/test/db/mcp-more-tools.test.ts "records repayments inside the private context, and keeps its people fixed" (CONFLICT); v2/test/db/ungrouped.test.ts "repayment settles only the selected expense, preserving household balances" | MCP answers CONFLICT. The domain error is Invalid with reason 'state', so the RPC tag differs from the old tRPC CONFLICT, but the message is the same. |
| P-DB-113 | untested | 0000_init.sql:390 `user_email_unique` | Matches. |
| P-DB-114 | untested | 0000_init.sql:379 `session_token_unique`, :434 ON DELETE cascade | Matches. |
| P-DB-115 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:186-200 `account` has only an index on user_id; the old `Account_providerId_accountId_key` UNIQUE is missing | Cascade matches (:421). Without the unique key, a race can link one Google account to two users. Internal. |
| P-DB-116 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:451 `apikey_key_index` is a plain index, not UNIQUE (old `Apikey_key_key`); hash: v2/test/db/mcp-auth.test.ts "refuses an unknown key and stores the same hash Better Auth stores" | The hash part is tested. The uniqueness is lost, so two rows can hold one key hash. Internal. |
| P-DB-117 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:202-224 `apikey.reference_id` has no FK | DECISIONS C approves the FK fix for P-DB-117. Not done. Internal. |
| P-DB-118 | tested | 0000_init.sql:204-216 defaults match; v2/test/db/account.test.ts "creates keys through Better Auth with the current prefix, rate limit and owner" | The test asserts rateLimitEnabled, 60 000 and 120. The defaults `enabled`, `requestCount` and `configId` match in SQL but are not asserted. |
| P-DB-119 | untested | 0000_init.sql:367 `rate_limit_key_unique` | Matches. |
| P-DB-120 | untested | 0000_init.sql:293 `oauth_client_clientId_unique`, :426 user FK cascade | Matches. |
| P-DB-121 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:301-307 `oauth_client_resource` has no UNIQUE(client_id, resource_id) (old `OauthClientResource_clientId_resourceId_key`); identifier unique :359 and both cascades :427-428 match | Duplicate client-resource rows become possible. Internal. |
| P-DB-122 | untested | 0000_init.sql:340 and :253 token UNIQUE | Matches. |
| P-DB-123 | untested | 0000_init.sql:422-433 client and user FKs cascade, session FKs SET NULL, on both token tables | Matches. |
| P-DB-124 | untested | 0000_init.sql:425 refresh_id → oauth_refresh_token ON DELETE cascade | Matches. |
| P-DB-125 | untested | 0000_init.sql:429-430 | Matches. |
| P-DB-126 | tested | 0000_init.sql:144 `oauth_connections_authorizationCodeId_unique`; v2/test/db/mcp-oauth.test.ts "6. after the access token expires, a refresh keeps the connection working"; v2/test/db/account.test.ts "revokes with a tombstone and deletes the tokens and consent" | Matches. |
| P-DB-127 | gap at b83751d; fixed on `t3/v2-db-gaps` | 0000_init.sql:136-145 no FK on user_id or client_id; `scopes text[] NOT NULL` (:141) | DECISIONS C approves the FK fix for P-DB-127; v2 fixed only the nullable scopes (the importer would fail a NULL row). The FKs are missing. Internal. |
| P-DB-128 | untested | 0000_init.sql:230 `private_key`; import-legacy.ts:59 copies Jwks; verify-import.ts:26 compares Jwks IDs | Implements DECISIONS A "The signing keys are imported with the production secret (P-DB-128)". It was verified once at the cutover (MCP 401 and OAuth worked), but no CI test covers it. |
| P-DB-129 | not-applicable | import-legacy.ts:136 refuses any row with originalAmount/originalCurrency/conversionRate | The backfill ran on the old database long ago, and v2 imports no converted rows at all. No decision covers it, and none is needed. |
| P-DB-130 | not-applicable | import-legacy.ts:136 | Same as P-DB-129: a historical backfill; v2 has nothing to rerun. |
| P-DB-131 | approved-change | 0001_invariants.sql `activities_no_truncate`, `expenses_no_truncate`; no DISABLE TRIGGER in v2; v2/test/db/invariants.test.ts "refuses to change or remove an activity" (TRUNCATE refused) | DECISIONS A: "History stays permanent; no migration disables history triggers (P-DB-131)". |
| P-DB-132 | approved-change | 0000_init.sql `"amount" bigint`; import-legacy.ts toMinor; verify-import.ts compares amounts per expense | v2 stores minor units of the expense's own currency (DECISIONS A: "integer minor units (P-DB-32)"). |
| P-DB-133 | untested | import-legacy.ts:211 copies ReceiptObject → receipts with their IDs; verify-import.ts:38 compares IDs; v2/test/db/expenses.test.ts "serves a receipt that only a deleted expense refers to" | The md5 backfill is historical; v2 keeps its rows. Checked once at the cutover, but no CI test covers the import. |
| P-DB-134 | tested | 0000_init.sql:121 `legacy_group_claims`; import-legacy.ts:71; v2/test/db/account.test.ts "runs on sign-in, once, and grants only the claimed groups" | Matches. |
| P-DB-135 | tested | account.ts:130-150; v2/test/db/account.test.ts "runs on sign-in, once, and grants only the claimed groups" | Matches, including the reactivation of an earlier membership as admin. |
| P-DB-136 | tested | account.ts:134; v2/test/db/account.test.ts "ignores other and unverified emails" | Matches. |
| P-DB-137 | tested | account.ts:118-119 `private-groups-v1`, 170031011; v2/test/db/account.test.ts "runs on sign-in, once, and grants only the claimed groups", "serializes concurrent runs" | Matches. The importer copies the AuthBootstrap row, so production never runs bootstrap again. |
| P-DB-138 | unapproved-change | account.ts:127-128 "The current app also imported legacy MCP_ACCESS_GRANTS keys here. Production ran that import already" | The legacy key import was removed. No decision covers it: group E drops only scripts/create-mcp-grant.ts (P-MCP-176). Nobody notices if the production AuthBootstrap row exists, but the audit did not check that. |
| P-DB-139 | unapproved-change | account.ts:127-128; no AUTH_BOOTSTRAP_LEGACY_USER_ID anywhere in v2 | The check went with the import (P-DB-138). No decision covers it. |
| P-DB-140 | untested | import-legacy.ts copies IDs, revisions, sequence (:193), snapshots (:201) and participant IDs verbatim; verify-import.ts compares IDs per table and expense fields | Partial check only. verify-import compares no activity `sequence`, `time`, revision or snapshot values, and no membership, invitation or participant fields beyond IDs. Snapshots also pass through JS JSON.parse/stringify, so a numeric JSON value with trailing zeros or above 2^53 would change. |
| P-DB-141 | untested | server.ts:46-51 applies migrations when MIGRATIONS_DIR is set; Dockerfile sets it | Matches. CUTOVER step 3 records "v2 migrated db2 (9 migrations)". No test. |
| P-DB-142 | approved-change | server.ts:38 one `DATABASE_URL` for the pool and migrations; db/migrate.ts | Prisma, its adapter and the pooled/non-pooled split are gone (PLAN "Target stack: Drizzle"; DECISIONS "Hosting changes to Coolify"). |
| P-DB-143 | unapproved-change | db.ts:60 `isolationLevel: 'serializable'` with retry on 40001/40P01 | v2 now sets SERIALIZABLE explicitly. It is stricter than READ COMMITTED, but no decision records the change. Bootstrap (account.ts:138) and Better Auth still use READ COMMITTED. |
| P-DB-144 | approved-change | Dockerfile:21 `TZ=UTC`; import-legacy.ts:17 refuses non-UTC; sql.ts:12, history.ts:151-152 use explicit `AT TIME ZONE 'UTC'`; v2/test/db/history.test.ts "filters by UTC recording day and type" | DECISIONS A: "UTC on every server (P-DB-144)". Results no longer depend on the session time zone. |
| P-DB-145 | approved-change | every timestamp in 0000_init.sql is `timestamp with time zone`; v2/test/db/history.test.ts "accepts only timestamps with a time zone and at most milliseconds (P-HIST-40)" | DECISIONS A: "`timestamptz` (P-DB-145)". |
| P-DB-146 | approved-change | no port of src/scripts/migrate.ts in v2/scripts | DECISIONS E: "the legacy Spliit import script (P-DB-146)" is not ported. |
| P-DB-147 | untested | setup.ts:9-10 refuses non-loopback and non-*test* databases; seed-synthetic.ts:17 refuses non-preview/test/dev; import-legacy.ts:233 refuses a non-empty target; history triggers and `groups_no_delete` | Guards exist; this is a process rule, and no test asserts it. |
| P-DB-148 | gap | /home/dev/dots/devbox/bin/agentsplit-backup:31 (live dots 773d448) still dumps `db`, not `db2`; the fix 6bb1a4d is on the unmerged dots branch agentsplit-backup-v2; server.ts:46-51 migrates at every start | No backup of v2's live database exists yet, so the next schema change will have no backup before it. Nothing compares data after a later v2 migration (verify-import only compares old against v2). Nobody sees this until a restore is needed. |
| P-DB-149 | untested | v2/test/db/setup.ts:9-10 "Refusing to reset ... tests need a loopback database named *test*" | Every DB test goes through the guard, but no test asserts the refusal. |
| P-DB-150 | gap | compose.v2.coolify.yaml volumes `postgres18-data`, `garage-meta`, `garage-data`; live agentsplit-backup:31-37 dumps the old `db` and runs `node` in the app container, which the v2 image lacks | The nightly backup no longer covers v2's data (`db2`/`postgres18-data`), and it will fail at the receipts step. The fix (dots 6bb1a4d) is not merged or applied, as CUTOVER "Follow-up" admits. Nobody sees it until the "AgentSplit backup failed" alert fires. |
| P-PRIVACY-01 | untested | v2/src/client/routes/privacy.tsx:5 (no guard); components/page-title.ts:21 `'/privacy': 'Privacy'` gives "Privacy · AgentSplit"; h1 "Privacy in AgentSplit"; robots.txt allows /privacy (security.ts:57) | No test opens /privacy. |
| P-PRIVACY-02 | untested | v2/src/client/routes/privacy.tsx (b83751d) | The page has the five sections. Commit b83751d removed the Google Cloud and Cloudflare text after the check. No test asserts the page. |
| P-PRIVACY-03 | untested | v2/src/server/auth.ts:98 `scope: ['openid', 'email', 'profile']`; auth.ts:95 telemetry off | No test asserts the scopes. |
| P-PRIVACY-04 | untested | No mail dependency in v2; v2/src/client/routes/$group/edit.tsx:302-312 "Copy invitation" and "Copy invitation message" | No e2e for the copy flow. |
| P-PRIVACY-05 | tested | test/db/groups.test.ts "does not grant access through a slug (P-GROUP-103, P-ACCESS-09)" |  |
| P-PRIVACY-06 | tested | test/db/mcp-auth.test.ts "refuses an unknown key and stores the same hash Better Auth stores"; test/db/account.test.ts "lists only the caller’s keys, newest first, without the key" | The raw key exists only in the create response (settings.index.tsx:199). |
| P-PRIVACY-07 | untested | v2/public/sw.js:8-11 caches only `/assets/*` and `/offline.html`; navigations go to the network | No PWA e2e in v2. |
| P-PRIVACY-08 | tested | receipts.ts:127-131 checks membership before `bucket.get`; test/db/mcp-uploads.test.ts "uploads, attaches and downloads a receipt with the same API key" (non-member 403) |  |
| P-PRIVACY-09 | tested | s3.ts and server.ts:55-59 keep the S3 keys on the server; test/db/mcp-uploads.test.ts "uploads, attaches and downloads a receipt with the same API key" asserts upload targets are `${BASE}/api/receipt-uploads/<43>` | The browser side is shown by code only: no `import.meta.env` config in v2/src/client besides PROD. |
| P-PRIVACY-10 | untested | v2/src/client/components/account-menu.tsx:4-17 initials only; CSP `img-src 'self' data: blob:` (security.ts:12) | No test. |
| P-PRIVACY-11 | untested | v2/src/server/security.ts:9-21: `img-src 'self' data: blob:`, `connect-src 'self'` | Stricter than the current app (no storage origin, as receipts come through /api/receipts). test/db/account.test.ts "allows no inline or eval scripts" asserts only `script-src`. |
| P-PRIVACY-12 | untested | No analytics, flag-image, exchange-rate or OpenAI calls in v2/src (grep); CSP connect-src 'self' | Implemented by absence; receipt extraction is dead code by group E. No test. |
| P-PRIVACY-13 | tested | Same as P-AUTH-72 |  |
| P-PRIVACY-14 | approved-change | queries/account.ts:30 theme; groups.index.tsx:61-75 starred/archived; expense-form-state.ts:181 split defaults; no locale cookie, no `recentGroups` writer | No locale (group F, English only) and no recent groups (group E, P-GROUP-20). Starred, archived and split defaults are in localStorage, as in the current app; the PARITY list is incomplete for both apps. Untested. |
