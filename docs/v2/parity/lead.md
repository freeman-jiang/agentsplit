# Parity items owned by the lead

Items that areas deferred to the lead, with their source. Each is closed with the commit and the test that covers it.

| Item | What | From | Status |
| --- | --- | --- | --- |
| P-GROUP-24 | The default currency for a new group (the current app reads `DEFAULT_CURRENCY_CODE`) | groups | closed: production sets neither currency variable (Coolify env names, 2026-11-05), so its default is the code fallback USD; the v2 create form defaults to USD |
| P-GROUP-48 | Page titles per screen | groups | open |
| P-GROUP-53 | The error page inside a group | groups | open |
| P-AUTH-49 | `/groups`, `/$group` and `/` keep the requested page when they send a signed-out visitor to sign-in (use `requireSignedIn` from `src/client/queries/account.ts`) | account | closed: both routes use `requireSignedIn`; e2e `a signed-out visitor returns to the page they asked for` |
| — | The `/agents` instructions: update them with the final MCP tool names and the PLAN.md guidance on full payments and notes | account, mcp | open |
| — | Replace the feed area's compact expense and payment forms (`routes/expenses/-*.tsx`) with the expenses area's forms after that merge | feed, expenses | open |
| — | One shared expense column builder and row mapper for ledger.ts and feed.ts (the feed copies the ledger's columns, and they drifted once) | expenses, feed | open |
| — | Make `shared/expense-rules.ts` and `shared/split.ts` Effect-free, so the expense form does not load Effect when it opens | expenses | open |
| — | Remaining MCP tools after each area merges (groups: `create_group`, `update_group`, `manage_group_access`, explicit IDs for `list_groups`; share, CSV and JSON links) | groups, mcp | open |
