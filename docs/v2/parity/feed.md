# Parity: dashboard feed and ungrouped expenses

This file records the v2 state of every item in the P-FEED and Ungrouped expenses sections of [PARITY.md](../PARITY.md), and of the related P-BAL and P-TOOL-LISTALL items.

Test files:

- `ungrouped` is `v2/test/db/ungrouped.test.ts`. It ports the 12 scenarios of `scripts/test-ungrouped-expenses.ts` and adds checks for the database triggers, the invitation renewal, deletion and contact linking.
- `feed` is `v2/test/db/feed.test.ts`. It covers filters, ordering, the cursor, attribution, current names, the output schemas and the balance rows.
- `browser` is a manual check on the dev server (port 5183, synthetic data) in the T3 browser on 2026-11-05. No Playwright spec exists yet.

Status values: **Done** (a test or a browser check proves it), **Code** (implemented, but no test or browser check exercised it), **Changed** (a deliberate change from DECISIONS.md or a v2 convention), **Deferred** (another area owns it, with the reason).

## Contract

The procedures are in `v2/src/shared/api/feed.ts`:

- `feed.list`: the feed (`expenses.list` in the current app).
- `feed.balances`: the account totals (`groups.balances.forUser` without `groups`).
- `feed.options`: the feed options (`expenses.options`). It also returns the categories.
- `expenses.context`: the expense page.
- `expenses.createUngrouped`: creates an ungrouped expense.
- `expenses.renewInvitation`: renews a private invitation.

The v2 field names follow the core contract, not the current app:

| Current app | v2 |
| --- | --- |
| `filter` | `search` |
| `personId` | `personUserId` |
| `paidByUserId` | `payerUserId` |
| `currencyCode` | `currency` |
| `isReimbursement` | `kind` |
| `paidBy`/`paidFor` | `payers`/`shares` plus `people` (current names) |

The MCP area maps the old tool names onto these fields.

## Feed/dashboard

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-FEED-01 | Done | browser: landing with one "Log In" link and no workspace navigation. The session check accepts verified accounts only (`test/db/session.test.ts`). |
| P-FEED-02 | Done | browser |
| P-FEED-03 | Code | "Loading expenses…" shows until the first page arrives. |
| P-FEED-04 | Done | browser |
| P-FEED-05 | Done | ungrouped "dashboard totals include private contexts…" (USD 80.00, then EUR 5.00 and USD 80.00) |
| P-FEED-06 | Done | browser: "You are owed · JPY" in green and "You owe · USD" in red. The "Net balance" branch is Code. |
| P-FEED-07 | Done | ungrouped (an outsider gets empty totals). The text is Code. |
| P-FEED-08 | Done | ungrouped (`unboundGroupIds: ['legacy']`, totals unchanged), browser |
| P-FEED-09 | Code | "Couldn’t load your balance." and "Try again" |
| P-FEED-10 | Deferred | The groups area owns `/groups`. Its card should read `feed.balances`, so that both cards show the same totals (DECISIONS.md, P-BAL-106). |
| P-FEED-11 | Done | feed "orders by expense date…", browser ("Newest expense date first") |
| P-FEED-12 | Changed | `limit` is 1 to 100, and the UI asks for 30 per page. `nextCursor` is `{date, createdAt, id}`. `date` is a calendar date, and `createdAt` has the database's microseconds, so that rows created in the same millisecond cannot be skipped. feed "returns a cursor with the exact creation time…" |
| P-FEED-13 | Done | ungrouped "stable newest-first pagination…" |
| P-FEED-14 | Code | "Load more expenses" and "Loading…". The button showed in the browser (43 rows), but I did not click it. |
| P-FEED-15 | Done | ungrouped privacy scenarios, deletion scenario |
| P-FEED-16 | Done | feed "filters by search on title or vendor…". LIKE characters match literally, and notes are not searched. The UI debounces by 250 ms and caps the text at 200 characters. |
| P-FEED-17 | Done | ungrouped "named group and no-group filters…", browser (`?group=ungrouped`) |
| P-FEED-18 | Changed | DECISIONS.md group C: a private context ID works as `groupId` for its own people. Non-participants still get no rows. ungrouped "non-participants cannot bypass privacy…" |
| P-FEED-19 | Changed | DECISIONS.md group C: one default. `involvingMe` defaults to true in the UI and in the API. ungrouped "involving-me is based on participation…". See the open questions. |
| P-FEED-20 | Done | ungrouped, feed |
| P-FEED-21 | Done | feed "person matches payer or beneficiary…" |
| P-FEED-22 | Done | feed "filters by type, category and currency" |
| P-FEED-23 | Changed | The list shows every currency in the registry, sorted by code (English only, DECISIONS.md group F). feed |
| P-FEED-24 | Done | feed |
| P-FEED-25 | Done | ungrouped (a one-day range) |
| P-FEED-26 | Done | ungrouped (server message), browser (alert instead of the list) |
| P-FEED-27 | Done | browser: "More filters" is open with `from` and `to` in the URL. |
| P-FEED-28 | Done | browser: `?view=all` replaces the URL. The router gets `replace` and `resetScroll: false`. |
| P-FEED-29 | Done | browser |
| P-FEED-30 | Code | server message as an alert. The empty state is "No expenses here yet". |
| P-FEED-31 | Done | browser: group badge, "No group", "Repayment for Concert tickets" |
| P-FEED-32 | Done | browser |
| P-FEED-33 | Done | browser ("you lent", "you received", "not involved"). `participantId` is in feed "shows current account names…". |
| P-FEED-34 | Changed | v2 names (see Contract). `group`, `contextExpenseId`, `contextExpenseTitle`, `participantId` and `attribution` are kept. Each item matches `FeedItem`, checked by encoding with the schema in feed. |
| P-FEED-35 | Done | feed (an account rename shows at once) |
| P-FEED-36 | Done | ungrouped "contact lookup…" (unverified accounts excluded), feed (schema). It also returns `categories`. |
| P-FEED-37 | Done | feed, browser |
| P-FEED-38 | Done | feed "attributes from create and update events…" (not the payer, baselines ignored, "Automatic recurrence"). Unverified accounts never lend their current name. |
| P-FEED-39 | Done | browser ("Added … by …" on `/expenses/<id>`). `lastEditedByYouAt` is in feed. |
| P-FEED-40 | Deferred | History area: names at a history boundary come from snapshot reads, which the feed does not do. Live reads use current names (feed). |

## Ungrouped expenses

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-UNGROUP-01 | Code | `/expenses` redirects to `/sign-in` without a verified session. |
| P-UNGROUP-02 | Code | "Loading people and groups…" and the server message as an alert |
| P-UNGROUP-03 | Done | browser: "No group" is the default, followed by named groups sorted by name. ungrouped (no private contexts in `groups`). |
| P-UNGROUP-04 | Deferred | v2 has no `/$group/expenses/create` route yet, so the button opens `/$group/expenses`. The expenses area should change the target when it adds the create route. |
| P-UNGROUP-05 | Done | browser |
| P-UNGROUP-06 | Done | browser ("Remove Bob Example", "Remove Dana Guest") |
| P-UNGROUP-07 | Done | ungrouped (contacts), browser (chosen people are hidden) |
| P-UNGROUP-08 | Done | ungrouped (server: "Enter a name and a valid email address."). The client checks the same rules. |
| P-UNGROUP-09 | Code | "That person is already included." |
| P-UNGROUP-10 | Done | ungrouped "links an invited email that belongs to a contact…" |
| P-UNGROUP-11 | Done | browser |
| P-UNGROUP-12 | Done | browser |
| P-UNGROUP-13 | Done | browser (disabled with one person, enabled with three) |
| P-UNGROUP-14 | Done | browser |
| P-UNGROUP-15 | Done | browser: no receipt or extraction controls, a disabled "Repeat" select, no payment toggle. |
| P-UNGROUP-16 | Code | Cancel links to `/`. |
| P-UNGROUP-17 | Done | browser ("Expense saved", one link field, "View expense") |
| P-UNGROUP-18 | Code | |
| P-UNGROUP-19 | Code | One expense ID and one idempotency key per form. After a failed save, the page opens the expense if it exists. |
| P-UNGROUP-20 | Done | contract pattern `^[A-Za-z0-9_-]{21}$` |
| P-UNGROUP-21 | Done | contract (2 to 100 people, local ID up to 42 characters, user ID up to 128). The server trims names (1 to 50) and trims and lowercases emails (ungrouped three-person scenario). |
| P-UNGROUP-22 | Done | ungrouped "forged account IDs…" |
| P-UNGROUP-23 | Done | ungrouped (missing payer or sharer, caller not included, duplicate email) |
| P-UNGROUP-24 | Done | ungrouped (payment, recurrence). Documents cannot be part of the input. |
| P-UNGROUP-25 | Done | ungrouped (an unverified caller gets `Unauthorized`) |
| P-UNGROUP-26 | Changed | `Conflict` (`entity: 'expense'`, the current revision) instead of a message, and the expense count does not change (ungrouped). The expense ID makes the create safe to retry. The response is not stored for the idempotency key, because it holds invitation secrets. |
| P-UNGROUP-27 | Done | ungrouped (`groupId` equals the expense ID). The name is the title and the currency is the expense currency (code). |
| P-UNGROUP-28 | Done | ungrouped (`<expenseId>_<localId>`) |
| P-UNGROUP-29 | Done | ungrouped: Bob is a member, so he cannot renew; Alice is the admin. |
| P-UNGROUP-30 | Done | ungrouped deletion scenario: the log starts with `create_group` ("Private expense", with a snapshot) and then `create_expense`. |
| P-UNGROUP-31 | Done | ungrouped: 7 days, only `sha256(secret)` stored, URL `<baseUrl>/invite/<secret>` |
| P-UNGROUP-32 | Done | ungrouped |
| P-UNGROUP-33 to 36 | Deferred | MCP area: `create_expense` without `groupId` must call `createUngroupedExpense` and add the four messages. `expenses.createUngrouped` is the service it calls. |
| P-UNGROUP-37 | Done | ungrouped |
| P-UNGROUP-38 | Done | ungrouped (`listGroups`) |
| P-UNGROUP-39 | Deferred | The shared layout `routes/$group.tsx` needs the group kind to redirect. The `Group` contract (core) has no `kind`. The lead or the groups area should add it. |
| P-UNGROUP-40 | Done | ungrouped: `expenses.context` gives NotFound, and `expenses.get` and `expenses.list` give Forbidden "Group access denied". The activities list belongs to the history area. |
| P-UNGROUP-41 | Deferred | Groups area (`get_group`). `expenses.context` already returns `group.kind` and `context`. |
| P-UNGROUP-42 | Deferred | Groups area (group update). The database refuses a change of `groups.kind` (ungrouped). |
| P-UNGROUP-43 | Deferred | Groups and invitations area. The new triggers refuse an invitation or a membership in a private context for anyone other than an original person with that person's email (ungrouped). |
| P-UNGROUP-44 | Deferred | Groups area. The existing `memberships_preserve_identity` trigger and the new private-context trigger refuse reassignment. |
| P-UNGROUP-45 | Done | ungrouped |
| P-UNGROUP-46 | Done | ungrouped |
| P-UNGROUP-47 | Done | ungrouped |
| P-UNGROUP-48 | Done | ungrouped |
| P-UNGROUP-49 | Done | ungrouped (Bob edits; a stale revision gives Conflict) |
| P-UNGROUP-50 | Done | ungrouped (household balances unchanged), browser |
| P-UNGROUP-51 | Done | ungrouped |
| P-UNGROUP-52 | Changed | `Invalid` with the same message, because v2's `Conflict` means a stale revision. ungrouped, browser. The database refuses it too. |
| P-UNGROUP-53 | Done | ungrouped (log ends with two `delete_expense` rows) |
| P-UNGROUP-54 | Done | existing triggers; ungrouped (DELETE on `private_people` refused) |
| P-UNGROUP-55 | Done | ungrouped (expired invitation listed for the creator only). Named groups belong to the invitations area. |
| P-UNGROUP-56 | Done | ungrouped (Forbidden "Group access denied") |
| P-UNGROUP-57 | Done | ungrouped |
| P-UNGROUP-58 | Changed | `Invalid` "This person has already joined." (v2's `Conflict` means a stale revision). ungrouped |
| P-UNGROUP-59 | Done | ungrouped (earlier invitations revoked). Accepting the new link belongs to the invitations area. |
| P-UNGROUP-60 | Done | ungrouped (shape). 7 days, as in the create. |
| P-UNGROUP-61 | Done | ungrouped |
| P-UNGROUP-62 | Deferred | Invitations area (join). ungrouped proves that the guest cannot read the context before joining. |
| P-UNGROUP-63 | Deferred | Invitations area (`/invite/<token>` page) |
| P-UNGROUP-64 | Done | ungrouped (NotFound), mapped to "Expense not found." in the UI. "Loading expense…" is Code. |
| P-UNGROUP-65 | Done | browser |
| P-UNGROUP-66 | Code | `/expenses/<id>` opens the compact expense form or the payment editor. Both return to `/` for named groups. |
| P-UNGROUP-67 | Done | browser |
| P-UNGROUP-68 | Done | browser |
| P-UNGROUP-69 | Done | ungrouped (settlements), browser (prefilled `from`, `to`, `amount`, `currencyCode`) |
| P-UNGROUP-70 | Done | browser ("Bob Example paid Alice Example · $30.00"). 30 per page through `expenses.list` with `kind: 'payment'`. |
| P-UNGROUP-71 | Done | browser (a new link in a read-only field) |
| P-UNGROUP-72 | Done | browser (the save returned to the original expense) |

## Related balance items

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-BAL-94 to 97 | Done | as P-UNGROUP-68 to 72, 50 and 52 |
| P-BAL-98 to 101 | Done | as P-FEED-04 to 09. The card refetches on every mount. |
| P-BAL-102 to 106 | Deferred | Groups area (`/groups` card). It should use `feed.balances` (P-BAL-106). |
| P-BAL-32, 34, 35, 38 to 41 | Done | `feed.balances` is the no-argument form of `forUser` (ungrouped, feed). It never writes. |
| P-BAL-33, 36, 37, 42 | Deferred | The explicit `groups` and `participantId` arguments of `forUser` belong to the balances area. |
| P-BAL-92 | Changed | The repayment form always stores category 1 ("Payment"). |

## list_all_expenses

| Item | Status | Proof or reason |
| --- | --- | --- |
| P-TOOL-LISTALL-08 | Changed | as P-FEED-18 |
| P-TOOL-LISTALL-09 | Changed | as P-FEED-19 (default true) |
| other items | Deferred | MCP area: the tool maps to `feed.list`. Each behavior behind items 03 to 17 has a test in ungrouped or feed. Item 02's input names and item 14's output names need the mapping in the Contract section. |

## Database

`v2/db/migrations/0003_private_contexts.sql` adds deferred triggers. A private group must have its context. Its participants, members and invitations must be its original people, with the original emails. Its original expense must be a one-off expense shared by exactly those people, and every other expense must be a repayment. The original can be deleted only after its repayments. A group cannot change kind. The triggers run on every write to these tables. For a named group, the check stops after one primary-key lookup.
