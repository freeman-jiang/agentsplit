# Parity items owned by the lead

Items that areas deferred to the lead, with their source. Each is closed with the commit and the test that covers it.

| Item | What | From | Status |
| --- | --- | --- | --- |
| P-GROUP-24 | The default currency for a new group (the current app reads `DEFAULT_CURRENCY_CODE`) | groups | closed: production sets neither currency variable (Coolify env names, 2026-11-05), so its default is the code fallback USD; the v2 create form defaults to USD |
| P-GROUP-48 | Page titles per screen | groups | open |
| P-GROUP-53 | The error page inside a group | groups | open |
| — | Remaining MCP tools after each area merges (groups: `create_group`, `update_group`, `manage_group_access`, explicit IDs for `list_groups`; share, CSV and JSON links) | groups, mcp | open |
