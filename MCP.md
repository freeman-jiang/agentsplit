# AgentSplit MCP

The read-only MCP endpoint is `/api/mcp` in the existing Next.js application.
It runs in the same deployment and calls existing tRPC procedures in process.
There is no additional service, Redis, model call, or external telemetry.

`src/lib/mcp/registry.ts` is the tool catalog: names, descriptions, and typed
procedure paths. Its type admits queries only. The shared adapter derives the
existing input schemas and leaves validation and execution to tRPC. Adding a
tool does not require another implementation of its business logic.

Tools: `list_groups`, `get_group`, `list_expenses`, `get_expense`, `get_balances`,
`list_activity`, and `list_categories`. Expense and balance reads skip recurrence
materialization. Activity is Spliit's existing paginated feed, not an immutable
before/after event ledger. Amounts use the group's currency minor units.

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
cover credentials, inherited permissions, recurrence suppression, and the CSV
correction. Live deployment and an actual Codex-agent run are recorded in
`VERIFICATION.md` after completion.

When expanding the registry, audit each query's side effects and permission
checks. The query-only type is not by itself a database read-only guarantee;
this release explicitly suppresses recurrence for its selected read paths.
