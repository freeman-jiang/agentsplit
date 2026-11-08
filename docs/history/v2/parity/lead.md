# Parity items owned by the lead

Items that areas deferred to the lead, with their source. Each is closed with the commit and the test that covers it.

| Item | What | From | Status |
| --- | --- | --- | --- |
| P-GROUP-24 | The default currency for a new group (the current app reads `DEFAULT_CURRENCY_CODE`) | groups | closed: production sets neither currency variable (Coolify env names, 2026-11-05), so its default is the code fallback USD; the v2 create form defaults to USD |
| P-GROUP-48 | Page titles per screen | groups | closed: one exhaustive route-to-title map in `components/page-title.ts`, read by the root layout; group pages read "<page> · <group> · AgentSplit"; e2e `a group opens on its expenses` checks two titles |
| P-GROUP-53 | The error page inside a group | groups | closed: `components/error-state.tsx` is the router's default error component, with the current wording; inside a group it renders under the tabs. It never shows the exception text (the old v2 root error page did); e2e `a tab that fails to load` |
| P-AUTH-49 | `/groups`, `/$group` and `/` keep the requested page when they send a signed-out visitor to sign-in (use `requireSignedIn` from `src/client/queries/account.ts`) | account | closed: both routes use `requireSignedIn`; e2e `a signed-out visitor returns to the page they asked for` |
| — | The `/agents` instructions: update them with the final MCP tool names and the PLAN.md guidance on full payments and notes | account, mcp | open |
| — | Replace the feed area's compact expense and payment forms (`routes/expenses/-*.tsx`) with the expenses area's forms after that merge | feed, expenses | closed: the `/expenses` pages use the full forms with a `page` target, and the compact forms are deleted; e2e `an ungrouped expense uses the full expense form with the private options, and its edit page opens the full form` and `a private create whose response is lost opens the saved expense instead of failing` |
| — | One shared expense column builder and row mapper for ledger.ts and feed.ts (the feed copies the ledger's columns, and they drifted once) | expenses, feed | closed: `expenseColumns`, `ExpenseRow` and `toExpense` live in `server/sql.ts`; the group lists add only their cursor keys |
| — | Make `shared/expense-rules.ts` and `shared/split.ts` Effect-free, so the expense form does not load Effect when it opens | expenses | closed: `validateExpense` returns a plain union, the form uses `minorOrNull`, and `SplitModeSchema` is in `shared/api/core.ts`. The form no longer loads the 25 KB (gzip) chunk that held Effect; no client chunk contains Effect |
| P-EXPORT-01, P-HIST-80..87 | The export menu on the Expenses tab and the expense log under both editors | history | closed: wired after the merges; e2e `expense-edit-export.spec.ts` |
| — | Group snapshots: the groups area wrote `defaultCurrency`, the history reader requires `currency`, so the Log failed after any group edit | groups, history | closed: writer fixed; `test/db/groups.test.ts` "group history" crosses both areas |
| — | Remaining MCP tools after each area merges (groups: `create_group`, `update_group`, `manage_group_access`, explicit IDs for `list_groups`; share, CSV and JSON links) | groups, mcp | open |
