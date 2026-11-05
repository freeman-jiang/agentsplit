# Parity record: MCP endpoint, agent authentication, first tools

This records the [PARITY.md](../PARITY.md) items of the MCP server (P-MCP) and the tools of this pass (P-TOOL) that this area covers, changes or leaves to another pass. The code is in `v2/src/server/mcp/`. The tests are in `v2/test/db/mcp-tools.test.ts` (tools), `mcp-auth.test.ts` (auth) and `mcp-oauth.test.ts` (oauth), and they run against a real database.

Status words:

- **covered**: v2 behaves as the current app, and the named test proves it.
- **changed**: v2 behaves differently on purpose; the reason follows.
- **deferred**: another area or the second pass owns it; the owner follows.
- **code**: implemented as the current app, but no test proves it yet.

## Design

- `endpoint.ts` serves `/api/mcp` in this order: host and origin, authentication, the rate limit, the scope step-up, the protocol header, then the JSON-RPC call through `createMcpHandler` (stateless, `responseMode: 'json'`). It builds a new `McpServer` per request.
- `registry.ts` has `defineTool`. Each area writes its tools in `tools/<area>.ts` and adds one line to `tools/index.ts`. Inputs and outputs are Effect schemas. The JSON Schemas come from them once per isolate. Writes run in one SERIALIZABLE transaction, which rechecks OAuth write access. Errors map to the current `{error: {code, message, outcomeUnknown, recovery}}` body.
- The writes call `createExpense`, `updateExpense`, `deleteExpense` and `getExpense` in `src/server/ledger.ts`. The reads are one SQL statement each in `tools/`, because the current wire shapes (offset pages, names, categories, attribution) need columns that the RPC reads do not return. Each read checks membership in the same statement.
- API keys: `api-key.ts` ports Better Auth's `validateApiKey` for the plugin settings in `auth-options.ts`. A differential test runs both on identical rows (13 states: disabled, expired, rate limited, window reset, quota, refill and others). The test requires the same answer and the same row changes.
- OAuth: `oauth.ts` runs Better Auth's own `verifyJwsAccessToken` and `enforceDpopBinding` (`better-auth/oauth2`). The key set comes from the `jwks` table, as `/api/auth/jwks` publishes it, because a Worker cannot fetch its own hostname. The DPoP replay store writes the same `verification` rows as Better Auth's `createDpopReplayStore`.
- The protected-resource metadata comes from `challenge.ts`, routed in `worker.ts`. Better Auth's MCP plugin removes `offline_access` from that document, and the fix needs it there.

## Transport and protocol

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-01 | covered | `/api/mcp` takes GET, POST and DELETE. GET and DELETE get the SDK's stateless 405 (tools "GET and DELETE"). |
| P-MCP-02 | covered | `responseMode: 'json'`. A legacy request whose Accept allows SSE gets one SSE event, as with the current SDK. |
| P-MCP-03 | covered | A new server per request (tools "isolates two concurrent users"). |
| P-MCP-04, 05 | covered | tools "initializes legacy 2025 clients" (2025-03-26 and 2025-06-18). |
| P-MCP-06 | changed | The instructions text adds the v2 recording rules (PLAN.md "New features") and multiple payers. The rest of the current text stays. It still contains "decimal strings" and "global", and it does not contain "minor units" (same test). |
| P-MCP-07, 09 | covered | tools "serves modern … requests and checks the standard headers". |
| P-MCP-08 | covered | tools "requires MCP-Protocol-Version". |
| P-MCP-10 | covered | Asserted for 200, 400, 401, 403, 405 and 429. |
| P-MCP-11 | deferred | This pass has 7 of the 20 tools. The other areas add the other 13 in the second pass (see below). |
| P-MCP-12, 13 | covered | tools "rejects an unknown tool and the removed month tool". |
| P-MCP-14 | changed | No tRPC registry. A tool is one `defineTool` value whose types connect its schema to its handler. The type check replaces the startup check. |

## Tool advertisement

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-15, 16 | covered | tools "advertises the current names, annotations, scopes and input fields". The test compares field by field with `test/db/fixtures/current-mcp-tools.json`, the current app's real `tools/list`. It checks closed objects, fields, required fields and enums. |
| P-MCP-17 to 23 | covered | The same test requires equal `annotations`, `securitySchemes` and `_meta` for all seven tools. |
| P-MCP-24, 26, 27, 28 | covered | The same test. Conversion fields and `saveDefaultSplittingOptions` are not in the schema, and the closed object refuses them (tools "refuses invalid money…", `originalAmount`). |
| P-MCP-25 | covered | `participantId` is not an input; a call with it fails validation (same test). |
| — | changed | `expense.payers` and `changes.payers` are new: multiple payers. `paidBy` is no longer required in the schema, because `payers` can replace it. A call needs exactly one of the two. The test allows exactly these differences. |
| — | changed | The create and update field descriptions carry the recording rules (tools "describes the recording rules"). |

## Tool call results and errors

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-29, 30 | covered | The text item equals `JSON.stringify(structuredContent)`. Dates are ISO strings and money is decimal text. Every tool result in the tests decodes with the tool's output schema. |
| P-MCP-31, 32 | covered | Unknown keys and invalid values fail before any read or write (tools "refuses invalid money…", which counts expenses before and after). |
| P-MCP-33 to 35, 37, 38 | covered | The error body, codes and recovery hints, asserted in tools. The internal message is fixed; details go to the log only. |
| P-MCP-36 | code | `outcomeUnknown: true` for an unexpected failure of a write. No test forces a database fault. |
| P-MCP-39 | changed | Outputs are typed at compile time and checked against the output schemas in the tests. The request path does not decode them again (CPU). |
| P-MCP-40 | covered | The same message, code FORBIDDEN (tools "denies a group of someone else", "fails the whole call…"). |
| P-MCP-41 | changed (DECISIONS.md B) | An access denial is FORBIDDEN with `outcomeUnknown: false` (tools "refuses a group outside the caller's memberships…"). |
| P-MCP-42 | covered | The activity row records the account, its name and the key ID or `oauth:<connection>` (tools "records the authenticated actor", oauth step 4). v2 stores `source: 'mcp'`. Attribution reports it as `agent`, the current value. |
| P-MCP-43 | covered | v2 reads never write; recurrence is a scheduled job (DECISIONS.md C). |
| P-MCP-44 | changed | The SDK's abort signal is not passed on: the ledger has no cancellation. A Worker's I/O ends with the request. |

## Authentication: API keys

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-45 to 49 | covered | auth "API key headers"; tools "API keys on the endpoint". |
| P-MCP-50 | covered | auth "stores the same hash…": prefix `agentsplit_`, no expiry. |
| P-MCP-51 | changed | Better Auth's check without building Better Auth, proven equal by auth "answers as Better Auth for …" (13 row states). |
| P-MCP-52 | covered | An unverified account's key gets 401 (tools "refuses conflicting, malformed…"). |
| P-MCP-53, 54 | covered | Each request reads current memberships (tools "applies a membership removal to every key"). |
| P-MCP-55 | covered | A deleted key gets 401 (same test). |
| P-MCP-56 | changed (DECISIONS.md G) | A key over its plugin limit gets 429 with `Retry-After`, not 401 (auth "says how long a rate-limited key waits"; endpoint code). |
| P-MCP-57 | deferred | Key minting and sessions belong to the account area; `enableSessionForAPIKeys: false` is unchanged. |

## Authentication: OAuth tokens

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-58, 59, 60 | covered | oauth flow; tools "refuses … unknown" (X-API-Key is never tried as OAuth). |
| P-MCP-61 to 63 | covered | oauth "DPoP-bound tokens": a Bearer use, a replay and a wrong URL get 401. |
| P-MCP-64 | covered | oauth "fail closed on a bad signature, an unknown key…" and step 6 (expiry). Issuer and audience go to jose's `verifyOptions`. No test uses a token from another issuer. |
| P-MCP-65 | code | Claims are checked as in the current app. No test forges a signed token without the claim. |
| P-MCP-66, 67, 71, 72 | covered | oauth "end with revocation", "follow the current consent", "see membership changes at once". |
| P-MCP-68 | changed | 403, same message; the challenge names the full scope set (below). |
| P-MCP-69, 73 | code | As in the current app; not tested. |
| P-MCP-70 | covered | oauth step 4 (`agent_key_id` is `oauth:…`). |

## Host, origin, challenges and the Claude Code fix

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-74, 75 | covered | tools "refuses another host or origin". |
| P-MCP-76 | code | 503 without BASE_URL. |
| P-MCP-77 | changed (OAUTH-CLAUDE-CODE.md) | The 401 asks for `scope="agentsplit:read agentsplit:write offline_access"` (oauth step 1, tools). |
| P-MCP-78 | covered | `{error}` bodies. |
| P-MCP-79 | changed (DECISIONS.md B) | One challenge format, always with `resource_metadata`. |
| P-MCP-88, 91 | changed (OAUTH-CLAUDE-CODE.md) | A write call with a token without write scope gets HTTP 403 `WWW-Authenticate: Bearer resource_metadata="…", scope="agentsplit:read agentsplit:write offline_access", error="insufficient_scope"`. The JSON-RPC call does not run (oauth step 5 checks that no expense is written). The consent step stays: the user can still refuse changes (step 5 grants read only first). |
| P-MCP-89 | changed | No tRPC layer. The in-transaction recheck (P-MCP-90) is the second guard. |
| P-MCP-90 | covered | oauth "write recheck". |
| P-MCP-87 | covered | API keys have no scope ceiling. |

The Claude Code emulation (oauth "Claude Code flow emulation") follows the reproduction step by step. It uses Claude Code's real CIMD document from 2026-11-05 and a random loopback port. The steps are: the 401 challenge, discovery, authorize, consent, a token with a refresh token, reads and writes, the read-only grant and its 403 step-up, re-authorization, and a refresh after the 300-second token has expired. The real-client check against the preview Worker stays with the lead (PLAN.md).

## Rate limiting

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-80 to 84 | covered | tools "shares one bucket per user…", "does not spend a bucket on unauthenticated requests". |
| P-MCP-85 | changed (DECISIONS.md A) | The bucket is a PostgreSQL row (`mcp_rate_limits`, migration 0003), taken in one statement with the database clock, so all isolates share it. |
| P-MCP-86 | changed | No membership preload; every query checks membership. A database failure gives 503 ("MCP is temporarily unavailable") or the internal tool error. |

## OAuth authorization server, registration, revocation and pages

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-92 | covered | Both metadata paths are routed in `worker.ts` (auth "protected-resource metadata"; workerd dev-server check). |
| P-MCP-93 | changed | `scopes_supported` adds `offline_access`. Otherwise the document equals Better Auth's own (auth "differs from Better Auth's own document only by offline_access"). |
| P-MCP-103, 104, 107, 113, 115, 117, 119, 122, 127, 134 to 136 | covered | Exercised by the oauth tests through Better Auth's real handler. The CIMD fetch is stubbed to answer Claude Code's document. |
| P-MCP-94 to 102, 105, 106, 108 to 112, 114, 116, 118, 120, 121, 123 to 126, 128 to 133, 137 to 140 | deferred | The authorization-server routes in `worker.ts` (well-known AS metadata, revoke and delete-consent hooks, UserInfo) belong to the account/auth area. Its integration suite should port `scripts/test-mcp-oauth.ts` for these. |
| P-MCP-141 to 172 | deferred | Consent, connected-apps and agent setup pages belong to the account/settings area. |
| P-MCP-173 to 176 | changed (DECISIONS.md A, E) | Stale docs, stale tests and the legacy grant script are not ported. |

## Tools of this pass

### list_groups

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-LISTGROUPS-01 | changed | Maps to an MCP read in `tools/groups.ts`, not to `groups.list`. |
| 02 to 06, 08, 09 | covered | tools "lists named groups…", "fails the whole call…", "isolates two concurrent users". |
| 07 | changed | Same shape. `currency` is the symbol from the currency registry, because v2 stores only the code. An empty description is `null`, as the current app stores it. |

### get_group

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 05, 06, 09 | covered | tools "reads a group with access, names, members…". |
| 03 | changed | A missing group is FORBIDDEN, like a group of someone else. The current pre-check also answered this way before NOT_FOUND could happen. |
| 04 | code | `ungrouped` when a `private_contexts` row exists; tested with the ungrouped area. |
| 07 | code | Admins get pending invitations, private contexts with expired ones included. The access area tests it with real invitations. |
| 08 | covered | tools "lists the participants referenced by any expense". |

### list_expenses

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01 to 09, 12, 13, 17 | covered | tools "lists with filters before offset pagination…", "refuses bad list bounds…". `filter` matches title or vendor, not notes, as in the current app. |
| 10 | covered | `{expenses, hasMore, nextCursor}`. `history` comes with historical reads. |
| 11 | changed | Same fields, plus `payers` (every payer and amount). `paidBy` is the payer who paid the most. Money uses the currency's full decimals ("30.00", not "30"). |
| 14 to 16 | deferred | Historical reads (`asOf`, `atActivityId`) belong to the history area. The fields are in the schema; a call with them answers BAD_REQUEST until then. |

### get_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 03, 04 | covered | tools "records the authenticated actor…", "accepts several payers…", "refuses bad list bounds…". Adds `payers`. |
| 05 | code | `downloadUrl` is built as in the current app; documents arrive with the receipts area. |
| 02, 07 to 10 | deferred | History area (`revision`, `asOf`, `atActivityId` answer BAD_REQUEST until then). |
| 06 | deferred | Receipts area (`/api/receipts`). |

### create_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 04 to 07, 10, 11, 13, 16, 29 | covered | tools "creates with a stable ID…", "refuses invalid money…", "refuses a group outside…", "records the authenticated actor". |
| 03 | changed | `paidBy` or the new `payers`, exactly one. |
| 08 | changed | Same check (ledger `validateExpense`); the message names the field, such as `payers.0: The payer is not in this group`. |
| 09, 12 | covered | `people` with `groupId` is refused; conversion fields are unknown keys. |
| 14 | changed (DECISIONS.md B) | A reused ID in another group is CONFLICT too. |
| 15 | changed | Same fields; money uses the currency's full decimals. |
| 17 | covered | `isReimbursement` records a payment (`kind: payment`); ledger tests prove balances. |
| 18 | deferred | The recurrence rule is saved. Recurring links and the scheduled job belong to the recurring area. |
| 19 to 28 | deferred | Ungrouped expenses belong to the feed/ungrouped area. The `people` input is in the schema; without `groupId` the call answers BAD_REQUEST until then. |
| 30 to 32 | deferred | Receipts area. Upload requests return `uploads: []` and the current `uploadError` text (tools "returns an upload error…"); `documents` must be empty. |

### update_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 04 to 07, 15, 17, 18 | covered | tools "edits only the given fields…", "keeps exact BY_AMOUNT shares…". |
| 03 | changed | A missing `expectedRevision` fails schema validation instead of the BAD_REQUEST message. |
| — | changed | Multiple payers: a changed amount on an expense with several payers needs `payers` again. With one payer, that payer's part follows the amount. |
| 08 | deferred | The ledger's update keeps `original_*` columns when the amount or currency changes. Fix in `ledger.ts` (expenses area). |
| 09 to 14 | deferred | Receipts area; `documents` and `attachUploadIds` answer BAD_REQUEST until then. |
| 16 | deferred | Ungrouped area. |

### delete_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01 to 04, 08 | covered | tools "soft-deletes with the current revision…". |
| 05 | covered | Excluded from reads; revisions 1 and 2 stay in `activities`. `list_activity` comes with the history area. |
| 06, 07 | deferred | Recurring area and ungrouped area. |

## The other 13 tools (second pass)

| Tool | Owner |
| --- | --- |
| `list_all_expenses`, `get_expense_options` | feed and ungrouped expenses |
| `create_group`, `update_group`, `manage_group_access` | groups and access |
| `get_balances`, `get_participant_balances`, `process_recurring_expenses` | expenses, payments and recurring |
| `list_activity`, `get_spending_stats`, `export_group` | history, stats and export |
| `update_profile` | account and settings |
| `get_reference_data` | expenses (categories, currencies) |

Each adds `tools/<area>.ts` and one line in `tools/index.ts`. Then `tools/list` order and count match the fixture of all 20 tools.

## Cost

Measured on 2026-11-05 on the dev box, with V8 (Node 24) and the built Worker chunks. These are local measurements and predictions for workerd, not preview `wrangler tail` numbers.

| What | CPU |
| --- | --- |
| First MCP request on a new isolate: load the endpoint chunk (MCP SDK and its Zod protocol schemas, about 90 % of it) | about 60 ms, once per isolate |
| First OAuth request on an isolate: load `better-auth/oauth2` verification | about 5 ms more, once |
| Warm request, API key, `tools/list` | p50 2.5 ms, p90 5.1 ms |
| Warm request, API key, `list_expenses` (10 or 30 rows), `get_group` | p50 0.5 to 0.6 ms, p90 1 to 2.3 ms |
| Warm request, OAuth bearer, `tools/list` or `list_expenses` | p50 0.7 ms, p90 1.2 ms |
| The alternative: build Better Auth and call `verifyApiKey` per request | p50 3.0 ms, p90 15 ms, plus about 55 ms to load its chunk on a new isolate |
