# AgentSplit MCP

The read-only MCP endpoint is `/api/mcp` in the existing Next.js application.
It runs in the same deployment and calls existing tRPC procedures in process.
There is no additional service, Redis, model call, or external telemetry.

`src/lib/mcp/registry.ts` is the tool catalog: names, descriptions, and typed
procedure paths. Its type admits queries only. The shared adapter derives the
existing input schemas and leaves validation and execution to tRPC. Adding a
tool does not require another implementation of its business logic.

Prefer fewer broad, composable tools: use options for date ranges and other
variations, and let agents compose the tools to solve tasks. The MCP catalog
does not need one tool for each web UI view or backend query.

The reviewed read-only tools are explicitly registered:

| Tool                       | Existing tRPC procedure         |
| -------------------------- | ------------------------------- |
| `list_groups`              | `groups.list`                   |
| `get_group`                | `groups.get`                    |
| `get_group_details`        | `groups.getDetails`             |
| `list_expenses`            | `groups.expenses.list`          |
| `get_expense`              | `groups.expenses.get`           |
| `get_balances`             | `groups.balances.list`          |
| `get_participant_balances` | `groups.balances.forUser`       |
| `list_activity`            | `groups.activities.list`        |
| `list_categories`          | `categories.list`               |
| `get_spending_stats`       | `groups.stats.overview`         |
| `list_category_expenses`   | `groups.stats.categoryExpenses` |

Expense, balance, and statistics reads skip recurrence materialization, including
the active-recurring-expense statistics loader. Activity now includes immutable
expense revision snapshots and deletion markers alongside legacy summaries.
Amounts are exact decimal strings at face value: `"6000"` means 6000 of the
expense's `currencyCode`, whether USD or JPY. Group currency is the default for
new expenses. Different currencies are never converted or added together.
`get_balances` returns `currencies: [{ currencyCode, balances, reimbursements }]`.
`list_expenses` and `get_balances` accept an optional `currencyCode` filter;
expense filtering happens before pagination. Spending statistics select one
currency and return `availableCurrencyCodes` for discovery.
Participant IDs select bookkeeping records, not authenticated identities.

`src/lib/mcp/output-schemas.ts` defines JSON output contracts, checked against
the tRPC return types at compile time. Dates serialize to ISO strings and
monetary values to decimal strings. Calculated splits prioritize the payer for
the first rounding remainder; explicit amounts are preserved. The adapter validates/filters successful
results before returning identical structured JSON and serialized text; invalid
results return a generic tool error without database or parser diagnostics.
All eleven tools advertise output schemas. No-argument tools accept only `{}`.
Titles, names, notes, and activity descriptions remain untrusted user content.

## Expense history and date filtering

`list_activity` is the audit/history surface. It accepts optional `expenseId`,
`activityType`, and inclusive `from`/`to` UTC event dates alongside pagination.
Each new create/edit event stores one complete snapshot, not two copies or a
patch chain. Deletion events preserve the preceding revision and remove the
expense from current reads/balances. Responses include a transient
`previousSnapshot` for comparison; it is not stored a second time. Legacy events
have no snapshot. `source: "baseline"` marks the first preserved state of an
older expense; it does not imply its creation happened then.

Snapshot attachment entries contain IDs/URLs/dimensions, not image bytes.
Historical participant names and currency stay frozen. Web participant labels
remain unverified; `actorUserId`/`agentKeyId` only come from trusted server
context. Group-link sharing is still the account-free honor system.
See `AUDIT.md` for enforcement and operational boundaries.

`list_expenses` covers all history when dates are omitted. Optional `from` and
`to` are inclusive expense dates in `YYYY-MM-DD` format; either boundary may be
omitted. The server rejects invalid dates or `from > to`. Date and title filters
are combined in the database before pagination, including reimbursements.
Results are newest first with an ID tie breaker. Pages contain up to 100 rows;
reuse the same filters and pass `nextCursor` while `hasMore` is true.
Pagination uses offsets; concurrent edits can shift subsequent pages.

For September 2026, for example:

```json
{
  "groupId": "GROUP_ID",
  "from": "2026-09-01",
  "to": "2026-09-30",
  "limit": 100
}
```

To review all groups, discover them with `list_groups` and paginate each group.
`list_month_expenses` is no longer exposed. The existing month-specific tRPC
query remains available to the web statistics page.

## HTTP safeguards and protocol support

Host/Origin validation and per-request bearer authentication precede dispatch.
Both legacy 2025 Codex traffic and modern 2026-07-28 requests use the same
registry. Modern missing-version-header responses carry JSON-RPC
`HeaderMismatch` (`-32020`); the SDK validates other protocol headers.

An authenticated user's connections share a token bucket: capacity 120 requests,
refilled at two requests per second. Exhaustion returns HTTP 429 with
`Retry-After` and never dispatches a tool. Idle buckets expire after one minute.
The limit covers discovery and protocol requests as well as tool calls, and
does not affect ordinary web/tRPC traffic. It is in memory in the currently
deployed single Node process; process restarts reset the budget. Before scaling
to multiple replicas/workers, replace the store with a shared limiter.

Bearer keys implement the private Codex integration, not the MCP OAuth profile:
OAuth authorization-server discovery, Protected Resource Metadata, and OAuth
scope challenges are not implemented. Persistent identities and OAuth remain
the separately scoped design in `IDENTITY_DESIGN.md`.

## Identity and keys

Each key identifies an agent connection and belongs to a stable user ID.
Authorization comes from the user's access record; keys have no separate group
allowlist. All the user's keys inherit membership changes after the access
configuration is reloaded; keys do not need rotation.
The server does not trust an agent's claimed name or a `userId` in tool arguments.
The selected first release exposes read tools only, independently of future
write capabilities.

Original Spliit has no global user/login system: group URLs grant access, and
the active participant is a local preference. This first implementation uses
admin-provisioned user access records in Coolify's persistent configuration.
Self-service user/key creation, invite claims, account recovery, and OAuth are
the next design phase described in `IDENTITY_DESIGN.md`; there is no key-creation
UI or email delivery in this release.

## Provision a connection

Create a private credential file using the installed Bun runtime:

```sh
bun scripts/create-mcp-grant.ts --connection-id owner-codex --user-id owner --group-id GROUP_ID
```

The helper saves a random 256-bit key to
`.mcp-credentials/owner-codex.json` with mode 0600 in a private directory.
The directory is excluded from Git and the Docker build context. The helper
refuses overwrites, so deploys and restarts cannot silently rotate the key.
For another key belonging to an existing user, omit `--group-id`; reuse that
user's access record rather than creating another permission list.

Set `MCP_ACCESS_GRANTS` in Coolify to this JSON structure, using the generated
user/key records. Only the SHA-256 hash goes on the server:

```json
{
  "users": [{ "id": "owner", "groupIds": ["GROUP_ID"] }],
  "keys": [
    {
      "id": "owner-codex",
      "userId": "owner",
      "tokenSha256": "REPLACE_WITH_GENERATED_SHA256_HEX"
    }
  ]
}
```

Add keys to `keys`; membership changes go in `users`. Removing a key revokes
that connection without affecting the other keys. Back up this configuration
with the deployment. Blank configuration disables MCP; malformed configuration
fails closed. Server hashes do not authenticate as bearer keys.

## Connect Codex

Configure a remote server using an environment variable for its bearer key:

```toml
[mcp_servers.agentsplit]
url = "https://agentsplit.freemanjiang.com/api/mcp"
bearer_token_env_var = "AGENTSPLIT_MCP_TOKEN"
```

Provide `AGENTSPLIT_MCP_TOKEN` from the private credential file to the Codex
process that starts the connection. Never commit a literal bearer key or put
one in a prompt. Codex must open a fresh connection/session after configuration
changes. The same endpoint can support ChatGPT after an OAuth authorization
flow is added; ChatGPT cannot present this personal API-style key directly.

The configured local connection instead uses a static Authorization header in
the private, mode-0600 user configuration, so the desktop connection survives
restarts without depending on a shell environment variable. No literal key is
stored in this repository. Start a fresh Codex connection/chat to load its tools.

## Verification boundaries

Tests exercise actual SDK HTTP handling with mocked database reads: discovery,
initialization, schema validation, scoped reads, concurrent user isolation,
cross-group expense ownership, and denial of mutation tools. Separate tests
cover credentials, inherited permissions, recurrence suppression, shared user
rate budgets, output validation, expense-date filtering/pagination, and the CSV
correction. Discovery tests check the selected registry and rejected tools;
backend queries are not automatically exposed. Live deployment and an actual Codex-agent run are recorded in
`VERIFICATION.md` after completion.

When expanding the registry, audit each query's side effects and permission
checks. The query-only type is not by itself a database read-only guarantee;
this release explicitly suppresses recurrence for its selected read paths.
