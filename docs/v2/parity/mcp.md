# Parity record: MCP endpoint, agent authentication and tools

This records the [PARITY.md](../PARITY.md) items of the MCP server (P-MCP) and of all 20 tools (P-TOOL) that this area covers, changes or leaves to another area. The first pass ported the endpoint, the authentication and 7 tools. The second pass ported the other 13 tools and the historical and ungrouped forms of the first 7. The third pass ported the receipt uploads. The code is in `v2/src/server/mcp/` and `v2/src/server/receipt-uploads.ts`. The tests are in `v2/test/db/mcp-tools.test.ts` (tools, first pass), `mcp-more-tools.test.ts` (more, second pass), `mcp-uploads.test.ts` (uploads), `mcp-auth.test.ts` (auth) and `mcp-oauth.test.ts` (oauth), and they run against a real database. `v2/e2e/agent-uploads.spec.ts` (e2e) runs the upload flow on the built Worker in workerd with its local R2.

Status words:

- **covered**: v2 behaves as the current app, and the named test proves it.
- **changed**: v2 behaves differently on purpose; the reason follows.
- **deferred**: another area or the second pass owns it; the owner follows.
- **code**: implemented as the current app, but no test proves it yet.

## Design

- `endpoint.ts` serves `/api/mcp` in this order: host and origin, authentication, the rate limit, the scope step-up, the protocol header, then the JSON-RPC call through `createMcpHandler` (stateless, `responseMode: 'json'`). It builds a new `McpServer` per request.
- `tools/registry.ts` has `defineTool`. Each area writes its tools in `tools/<area>.ts` and adds them to the one list in `tools/index.ts`. The arguments that several tools take are in `tools/inputs.ts`, built from the RPC contract and the limits; the shared output schemas and the one mapper from each service value to them are in `tools/wire.ts`. A tool file imports no other tool file. Inputs and outputs are Effect schemas. The JSON Schemas come from them once per isolate. Writes run in one SERIALIZABLE transaction, which rechecks OAuth write access. Errors map to the current `{error: {code, message, outcomeUnknown, recovery}}` body.
- Receipt uploads (third pass). A Worker cannot presign S3 URLs for R2 without R2 S3 credentials, so an upload target is a Worker URL, `<BASE_URL>/api/receipt-uploads/<secret>`, with 256 random bits that work once. `create_expense` and `update_expense` write one `receipt_uploads` row per requested file in the write's transaction: the uploadId, the SHA-256 of the secret, the user, the group, the expense, the final R2 key `receipts/<id>.jpg|png`, the declared type and size, and an expiry 300 seconds later. The PUT claims the row (`pending` to `writing`) in one UPDATE, checks that `Content-Type` and `Content-Length` equal the target's headers, and streams the body into R2. R2 reports the stored size; a short body frees the target again. `update_expense` with `attachUploadIds` locks the rows, checks the owner, the group, the expense, the state and the 24 hours, reads the first 256 KiB from R2 (all of it only when the JPEG frame header comes later), registers the image in `receipts`, deletes the row and adds the document, in one audited revision. The hourly cron deletes rows older than 25 hours and their objects. No JavaScript reads or hashes the body on the PUT.
- `GET /api/receipts` accepts the agent's API key or OAuth token (`X-API-Key` or `Authorization`), through the MCP `authenticate`, as in the current app. A bad agent credential answers 401 and does not fall back to the cookie.
- The expense tools call `listExpenses`, `getExpense`, `createExpense`, `patchExpense` and `deleteExpense` in `src/server/ledger.ts`. The services return the columns that the current wire shapes need (names, receipts and attribution events, through `ExpenseParts` in `expense-read.ts`), and `listExpenses` also pages by offset, as list_expenses does. list_groups calls `listGroupPage` and get_group calls `getGroupDetails` in `groups.ts`. No tool has its own SQL.
- Second pass: every tool calls the service that the web RPC uses, and only maps names (`EVENLY`, `isReimbursement`, `currencyCode`) and shapes. The services are `feed.ts` (list_all_expenses, get_expense_options, get_participant_balances), `ungrouped.ts` (ungrouped create_expense, renew_invitation), `account.ts` (update_profile), `groups.ts` (create_group, update_group, manage_group_access), `expenses.ts` (get_balances, get_reference_data), `history.ts` (list_activity, the asOf forms of list_expenses, get_expense and get_balances), `stats.ts`, `export.ts` and `recurring.ts`. Writes go through the same SERIALIZABLE path with the OAuth write recheck.
- list_activity reads the live `expense` beside a current entry with `loadExpenses`, a second statement over rows that the service has already checked. The historical get_expense reads the attribution up to that revision in the same statement as the revision (`getSavedExpense` with `attribution`).
- Small additive changes to the services: `accountBalances` takes an optional scope (groups, and another participant per group), `statsOverview` takes an optional `participantId`, `listActivities` returns actor IDs only with `withActors` (the Log stays without user and key IDs), and `readSnapshot` keeps the group that a revision saved. The web RPC output is unchanged.
- `tools/index.ts` lists the tools in the current app's order. `test/mcp-docs.test.ts` checks MCP.md's tool table and error codes against the code.
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
| P-MCP-06 | changed | The instructions text adds the v2 recording rules (PLAN.md "New features"): record the full payment with the payer's own share, include the payer in paidFor unless they paid only for others, and put the full calculation in notes. It adds the payment rules (DECISIONS.md, P-BAL-93): a payment may involve several people and may be negative, and money that one person receives and the group shares is a negative expense. It adds multiple payers. The rest of the current text stays. It still contains "decimal strings" and "global", and it does not contain "minor units" (same test). |
| P-MCP-07, 09 | covered | tools "serves modern … requests and checks the standard headers". |
| P-MCP-08 | covered | tools "requires MCP-Protocol-Version". |
| P-MCP-10 | covered | Asserted for 200, 400, 401, 403, 405 and 429. |
| P-MCP-11 | covered | All 20 tools, in the current order (tools "advertises the current names…"). |
| P-MCP-12, 13 | covered | tools "rejects an unknown tool and the removed month tool". |
| P-MCP-14 | changed | No tRPC registry. A tool is one `defineTool` value whose types connect its schema to its handler. The type check replaces the startup check. |

## Tool advertisement

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-MCP-15, 16 | covered | tools "advertises the current names, annotations, scopes and input fields". The test compares field by field with `test/db/fixtures/current-mcp-tools.json`, the current app's real `tools/list` of all 20 tools (regenerated on 2026-11-05 from `createAgentSplitMcpServer`, without descriptions). It checks the order, closed objects, input fields, required fields and enums, and that every current output field is still there. |
| P-MCP-17 to 23 | covered | The same test requires equal `annotations`, `securitySchemes` and `_meta` for all 20 tools. |
| P-MCP-24, 26, 27, 28 | covered | The same test. Conversion fields and `saveDefaultSplittingOptions` are not in the schema, and the closed object refuses them (tools "refuses invalid money…", `originalAmount`). |
| P-MCP-25 | covered | `participantId` is not an input; a call with it fails validation (same test). |
| — | changed | `expense.payers` and `changes.payers` are new: multiple payers. `paidBy` is no longer required in the schema, because `payers` can replace it. A call needs exactly one of the two. The test allows exactly these differences. |
| — | changed | The create and update field descriptions carry the recording rules (tools "describes the recording rules"). |
| — | changed | `list_all_expenses.involvingMe` defaults to true, and its description says so (DECISIONS.md, P-FEED-19). The test does not compare defaults. |
| — | changed | Tool descriptions: create_expense and get_balances state the payment rules; create_group and update_group say that currencyCode must be a supported code; manage_group_access says that `joined` is true only after a join; list_activity says that agentKeyId is shown only for your own changes; list_all_expenses states the involvingMe default. |
| — | changed | Outputs: `payers` beside `paidBy` in list_all_expenses rows and in saved snapshots. In historical get_expense, `documents[].width` and `height` are optional, because a saved revision keeps only the receipt pointer. Snapshot unions are not compared by the test (it follows `properties` and `items` only). |
| — | changed | `get_balances.currencies[].balances` advertises its value schema (`additionalProperties`); `registry.ts` dropped it before. |

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
| P-TOOL-LISTGROUPS-01 | changed | Maps to `groups.listGroupPage`, the directory's page of named groups (newest first) with offset pages, not to `groups.list`. |
| 02 to 06, 08, 09 | covered | tools "lists named groups…", "fails the whole call…", "isolates two concurrent users". |
| 07 | changed | Same shape. `currency` is the symbol from the currency registry, because v2 stores only the code. An empty description is `null`, as the current app stores it. |

### get_group

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 05, 06, 09 | covered | tools "reads a group with access, names, members…". |
| 03 | changed | A missing group is FORBIDDEN, like a group of someone else. The current pre-check also answered this way before NOT_FOUND could happen. |
| 04 | covered | more "records repayments inside the private context…" (`{kind: 'ungrouped', expenseId}`). |
| 07 | code | Admins get pending invitations, private contexts with expired ones included. The access area tests it with real invitations. |
| 08 | covered | tools "lists the participants referenced by any expense". |

### list_expenses

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01 to 05, 07 to 09, 12, 13, 17 | covered | tools "lists with filters before offset pagination…", "refuses bad list bounds…". The arguments use the RPC contract's schemas, so `vendor` takes the contract's search text (at most 200 characters). |
| 06 | changed | `filter` matches the title, the vendor or the notes, as the web list does (`ledger.listExpenses`, and `filterSaved` for historical reads). The current app matched the title and the vendor only. |
| 10 | covered | `{expenses, hasMore, nextCursor}`. `history` comes with historical reads. |
| 11 | changed | Same fields, plus `payers` (every payer and amount). `paidBy` is the payer who paid the most. Money uses the currency's full decimals ("30.00", not "30"). |
| 14, 15 | covered | `history.listSavedExpenses` filters saved values, then pages (more "reads a saved revision and a historical list…"). Both selections at once answer BAD_REQUEST (tools "refuses bad list bounds…"); the message is the history area's "Choose asOf, atActivityId or revision, not more than one". |
| 16 | covered | `asOf` uses the RPC contract's RecordedTime: a time zone and at most milliseconds (more "reads balances as of…" refuses `.0001Z`). A future time answers "asOf cannot be in the future". |

### get_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 03, 04 | covered | tools "records the authenticated actor…", "accepts several payers…", "refuses bad list bounds…". Adds `payers`. |
| 05 | covered | uploads "uploads, attaches and downloads a receipt with the same API key": the document has the pointer, the measured width and height, and `downloadUrl`. |
| 02, 07, 09, 10 | covered | `history.getSavedExpense`; the history block carries the saved snapshot with its saved names; recurring links are null; attribution counts events up to that revision (more "reads a saved revision…"). |
| 08 | code | A deletion revision returns the prior snapshot, `deleted: true` and `deletedAt` (history area tests prove the service). |
| 06 | covered | The same test downloads the bytes with the agent's `X-API-Key`, and with another member's `Authorization: Bearer` key; a non-member gets 403 and an unknown key 401. e2e downloads with the key and no cookie. OAuth tokens go through the same `authenticate` as MCP; the DPoP proof must name the receipt URL. |

### create_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 04 to 07, 10, 11, 13, 16, 29 | covered | tools "creates with a stable ID…", "refuses invalid money…", "refuses a group outside…", "records the authenticated actor". |
| 03 | changed | `paidBy` or the new `payers`, exactly one. `documents` on a group create must name receipts of that group (uploads "keeps or removes receipts…"). |
| 08 | changed | Same check (ledger `validateExpense`); the message names the field, such as `payers.0: The payer is not in this group`. |
| 09, 12 | covered | `people` with `groupId` is refused; conversion fields are unknown keys. |
| 14 | changed (DECISIONS.md B) | A reused ID in another group is CONFLICT too. |
| 15 | changed | Same fields; money uses the currency's full decimals. |
| 17 | covered | `isReimbursement` records a payment (`kind: payment`); ledger tests prove balances. |
| 18 | deferred | The recurrence rule is saved. Recurring links and the scheduled job belong to the recurring area. |
| 19, 24, 25 | covered | `createUngroupedExpense`; the result maps labels to `<expenseId>_<label>` participants and returns invitation links (more "creates a private expense with people…"). A retried ID answers CONFLICT. |
| 20 to 22, 26, 27 | code | The ungrouped service's rules, proven in `ungrouped.test.ts`. |
| 23 | covered | Upload requests are refused before any write: "Save an ungrouped expense first, then attach its receipts."; `documents` get the current "Create the expense first, then attach receipts…" text; recurrence and payments are refused by the service. |
| 28 | covered | A repayment inside the context is allowed (more "records repayments inside the private context…"); a new purchase there is refused by the service. |
| 30 | changed | The same fields: `uploadId`, `filename`, `method: "PUT"`, `url`, `headers` with `Content-Type` and `Content-Length`, `expiresAt` 300 seconds later (uploads "uploads, attaches…"). `url` is a Worker URL with a single-use secret, not a presigned S3 URL. It works for one complete PUT only; a second PUT gets 403 (uploads "refuses a reused or expired upload URL…", e2e). |
| 31 | changed | The targets are written in the write's transaction, so a failure to write them fails the whole call with a certain outcome, never a half result. With receipts off, the expense is saved and the call answers `uploads: []` and the current `uploadError` text (tools "returns an upload error, not targets, while receipts are off…"). |
| 32 | covered | A target alone adds no document and no revision (uploads "uploads, attaches…" reads revision 1 after the request and after the PUT). |

### update_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01, 02, 04 to 07, 15, 17, 18 | covered | tools "edits only the given fields…", "keeps exact BY_AMOUNT shares…". |
| 03 | changed | A missing `expectedRevision` fails schema validation instead of the BAD_REQUEST message. |
| — | changed | Multiple payers: a changed amount on an expense with several payers needs `payers` again. With one payer, that payer's part follows the amount. |
| 08 | deferred | The ledger's update keeps `original_*` columns when the amount or currency changes. Fix in `ledger.ts` (expenses area). |
| 09, 10 | covered | `documents` replaces the list: `[]` removes the receipt in a new revision; a receipt of another group answers BAD_REQUEST "Attach only receipts uploaded to this group" (uploads "keeps or removes receipts…"). The ledger keeps a removed receipt in the earlier revision (expenses area tests). With `attachUploadIds`, the new receipts join `documents`, or the saved list when `documents` is omitted, as in the current app. |
| 11 | covered | Another user's upload for the same expense, and the caller's own upload for another expense, answer FORBIDDEN "This upload does not belong to this user and expense", before any storage read (uploads "refuses another principal's…"). |
| 12 | covered | An unknown uploadId, an upload without its PUT and an attached uploadId answer BAD_REQUEST "Receipt upload could not be finalized…"; the revision stays (same tests). A stale `expectedRevision` answers CONFLICT before any upload is checked. |
| 13 | changed | Over 24 hours answers "Upload is too large or expired" (uploads "refuses a stored upload after 24 hours…"). The size is checked at the PUT: `Content-Length` must equal the declared bytes (at most 5 MiB), and R2's stored size must equal it, else 400 "Upload is incomplete". The content must be a JPEG or PNG of its declared type, at most 40 million pixels (`imageInfo`, image tests): a JPEG declared as PNG is refused with "Receipts must be valid JPEG or PNG images". The current app accepted it and used the detected type, but v2 fixes the key and the stored type when it gives the target. |
| 14 | changed | The PUT writes the final key `receipts/<id>.jpg|png` directly; there is no copy, because the R2 binding has no copy call and a copy streams the bytes through the Worker again. No write URL exists for an attached receipt: the target is spent after its one PUT, and its row is deleted at attach. The pointer is `r2://agentsplit-receipts/receipts/<id>.<ext>`, with the measured width and height, in an audited revision. |
| 16 | covered | The ledger's private-context rules (more "records repayments inside…": a changed set of people answers BAD_REQUEST). |

### delete_expense

| Item | Status | Evidence or reason |
| --- | --- | --- |
| 01 to 04, 08 | covered | tools "soft-deletes with the current revision…". |
| 05 | covered | Excluded from reads; revisions 1 and 2 stay in `activities`. `list_activity` comes with the history area. |
| 06 | code | `stopRecurrence` in the ledger delete (recurring area tests). |
| 07 | covered | CONFLICT with the same message (more "records repayments inside…"). The ungrouped service throws Invalid with `reason: 'state'`, which the MCP error map answers as CONFLICT. |

## Tools of the second pass

The service that owns each behavior is named in the design section above. "code" means that the service's own tests prove the rule, and the tool only passes the arguments through.

### list_all_expenses (feed.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-LISTALL-01 | changed | A tool over `feed.listFeed`, not over tRPC `expenses.list`. |
| 02 | changed | The same inputs. `involvingMe` defaults to true (DECISIONS.md, P-FEED-19), and the description says so. `cursor.createdAt` takes up to microseconds, so rows created in the same millisecond are not skipped; `cursor.date` takes a date or the returned midnight timestamp. |
| 03 | code | The feed's "The start date must be on or before the end date." |
| 04, 09 | covered | more "lists only expenses involving the caller by default…". |
| 05, 06 | covered | more "pages with the returned cursor…". |
| 07, 10 to 13, 16 | code | `feed.test.ts` and `ungrouped.test.ts`. |
| 08 | changed | As P-FEED-18: a private context ID works as `groupId` for its own people. |
| 14 | changed | The same fields, plus `payers`; `paidBy` and `paidById` are the payer who paid the most. Money has the currency's full decimals. `attribution.*.source` is `agent` for MCP writes, as in the current app. |
| 15 | covered | more "renames only the caller…". |
| 17 | covered | Reads never write (P-MCP-43). |

### get_expense_options (feed.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-OPTIONS-01 to 05 | covered | more "lists the caller, shared verified people and named groups only" (also refuses an extra key). `feedOptions` also returns categories; the tool leaves them out, as in the current shape. |

### update_profile (account.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-PROFILE-01 | covered | tools "advertises…" (write, not destructive, idempotent). |
| 02 to 04, 06 to 08 | covered | more "renames only the caller, at once in current views, and keeps old audit names". A blank name answers BAD_REQUEST ("Display name must be 1 to 50 characters"). |
| 05 | code | `updateProfile` refuses an unverified account. An unverified account cannot reach a tool: its key gets 401 (P-MCP-52). |
| 09 | code | The write scope gate of every write tool (oauth step 5). |

### create_group (groups.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-CREATEGROUP-01, 03, 05, 09, 10 | covered | more "creates a group with the creator as admin…". The creator is the first participant. |
| 02 | changed | The same fields. v2 has registered currencies only (P-GROUP-23): `currencyCode`, else a `currency` that is a code or the symbol of exactly one currency, gives the group currency. Anything else answers BAD_REQUEST. Freeman confirmed this on 2026-11-05 (DECISIONS.md). Names are trimmed, as the RPC contract requires. |
| 04 | covered | A reused groupId answers CONFLICT with the current message (same test). |
| 06, 08 | code | `groups.test.ts`. The group starts at revision 1 (same test). |
| 07 | code | An unverified account cannot reach a tool (P-MCP-52). |

### update_group (groups.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-UPDATEGROUP-01 to 04, 11, 12 | covered | more "edits as admin with the current revision only". The stale-revision path is now proven (the current test sent a wrong key). |
| 05, 06, 08 to 10 | code | `groups.test.ts`. |
| 07 | code | CONFLICT with the same message: the groups service throws Invalid with `reason: 'state'`. |

### manage_group_access (groups.ts, ungrouped.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-ACCESS-01 to 03 | covered | tools "advertises…"; more "invites by email…" (`email is required`). |
| 04, 13, 17, 21 to 24, 29 | code | `groups.test.ts` and `ungrouped.test.ts`. The log has no emails (P-ACCESS-30). |
| 05, 09, 14, 16, 18, 19 | covered | more "invites by email, joins with the link…": a group URL is refused, the email is lowercased, the join binds the invited participant as a member, and NOT_FOUND has the current texts. |
| 06 | code | "Invitation not found or no longer valid" for an unknown token. |
| 07 | code | FORBIDDEN, as in the current app. |
| 08, 10, 11, 15, 20, 26 | covered | CONFLICT with the same messages: the services throw Invalid with `reason: 'state'`. more "invites by email…" checks 10 (a used invitation) and 20 (the last admin); the others share the same path. |
| 12 | code | An unverified account cannot reach a tool (P-MCP-52). |
| 25, 27 | covered | more "renews the original invitation of a private expense". |
| 28 | changed (DECISIONS.md group C) | `joined` is true only after a join. |

### get_balances (expenses.ts, history.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-BALANCES-01 to 03, 05 | covered | more "derives public balances from the suggested repayments, per currency". `balances` comes from the suggested repayments, as in the current app (DECISIONS.md group D). |
| 04 | changed | Money has the currency's full decimals ("15.00", JPY "1500"). |
| 06 | covered | more "records a repayment with several people…". |
| 07 | code | PRECONDITION_FAILED with the current text when `historicalLedger` is incomplete. No MCP test creates a legacy expense without a snapshot; `history.test.ts` proves the detection. |
| 08, 09 | covered | more "reads balances as of an earlier recorded change". |
| 10 | covered | Reads never write (P-MCP-43). |

### get_participant_balances (feed.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-PBAL-01, 02, 05 to 08 | covered | more "sums account balances per currency, restricts the scope…". |
| 03 | changed | FORBIDDEN for the whole call, checked in the same statement as the read instead of before it. No data is returned. |
| 04, 09 | code | `feed.test.ts` (unbound groups, no memberships). |
| 10 | covered | Reads never write (P-MCP-43). |

### get_spending_stats (stats.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-STATS-01, 03, 05, 06 | covered | more "reports stats in one currency, for a chosen participant". |
| 02, 07 | code | `stats-export.test.ts`. |
| 04 | changed | The same fields. `monthlyCategorySpending` covers the same months as `months` (DECISIONS.md, P-STATS-36). Payments are not spending. |
| 08 | covered | Reads never write (P-MCP-43). |

### list_activity (history.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-ACTIVITY-01, 02, 05, 07 | covered | more "shows agent writes…", "keeps pages fixed at the returned boundary…". |
| 03, 10 | code | `history.test.ts`. |
| 04 | covered | NOT_FOUND "History boundary not found in this group" (same test). |
| 06 | changed | The same fields. Snapshots are the saved state in the current field names, read from either stored format: `schemaVersion` is the stored format (1 or 2), expense snapshots add `payers`, documents have no size, and group snapshots have no revision. `expense` (current reads only) is the live expense row. |
| 08 | changed (DECISIONS.md group B) | `source` is `agent` and `actorUserId` is the account. `agentKeyId` is shown only for the caller's own changes: other people's key and connection IDs stay private (more "shows agent writes with their actor, and the key ID only to its owner"). |
| 09 | covered | Reads never write (P-MCP-43). |

### process_recurring_expenses (recurring.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-RECUR-01 to 05 | covered | more "creates due occurrences only in the given group, once". |
| — | changed | All occurrences of one call commit in the tool's one SERIALIZABLE transaction (at most 50 per call). The scheduled job also creates them each day (DECISIONS.md group C). |

### get_reference_data (expenses.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-REF-01, 02, 04 | covered | more "lists reference data in the current names". |
| 03 | changed | The same 34 currencies, in code order instead of the current list order. |
| 05 | changed | `attachments.enabled` is always true (receipts are always on), with `image/jpeg`, `image/png` and 5242880 bytes (uploads "reports attachments as enabled…"). |

### export_group (export.ts)

| Item | Status | Evidence or reason |
| --- | --- | --- |
| P-TOOL-EXPORT-01, 02, 05 | covered | more "exports the group as the export RPC does". The file is the export RPC's file. |
| 03 | changed (DECISIONS.md group B) | JSON with `id` and the preserved history, without user IDs, connection IDs or emails (P-EXPORT-14). |
| 04 | changed | A group outside the caller's access answers FORBIDDEN, like get_group (same test). |
| 06 | deferred | The HTTP export routes with an OAuth bearer belong to the export and auth areas. |

## Open questions (second pass)

1. Resolved by the lead: state conflicts (P-TOOL-ACCESS-08, 10, 11, 15, 20, 26, P-TOOL-UPDATEGROUP-07, P-TOOL-DELETEEXP-07) answer CONFLICT again, through `Invalid.reason = 'state'`.
2. `create_group` and `update_group` refuse a custom currency symbol. An agent that sends only `currency: "$"` gets BAD_REQUEST, because several currencies use that symbol.
3. Resolved in the third pass: `get_reference_data.attachments.enabled` follows the web. Since 2026-11-07 receipts are always on, so it is always true.

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

### Second pass

Measured on 2026-11-05 on the dev box: warm requests with an API key, through the in-process endpoint and the pg driver, 30 expenses in two currencies. These numbers include the test client and the driver, so they are higher than the server-only numbers above. Compare the tools with each other: the first-pass tools in the same run are the reference. These are predictions for workerd, not preview `wrangler tail` numbers.

| Request | p50 | p90 |
| --- | --- | --- |
| list_expenses (30 rows), first pass | 3.0 ms | 5.7 ms |
| get_group, first pass | 2.0 ms | 4.6 ms |
| list_all_expenses (30 rows, 2 statements) | 3.3 ms | 9.1 ms |
| list_activity (30 events, 2 statements) | 3.6 ms | 7.0 ms |
| export_group (JSON) | 3.2 ms | 4.1 ms |
| get_spending_stats | 1.9 ms | 3.0 ms |
| get_balances, get_participant_balances, get_expense_options, get_reference_data | 1.6 to 1.7 ms | 2.3 to 3.4 ms |
| tools/list (20 tools) | 2.4 ms | 2.9 ms |

The tools load no new libraries: the services they call are already in the Worker for the web RPC.

A new isolate imports the endpoint chunk on its first MCP request. Measured with Node and the built chunks (CPU, 3 runs each):

| Build | Import of the endpoint chunk |
| --- | --- |
| v2 before this pass (7 tools) | about 92 ms |
| 20 tools, JSON Schemas built at definition | about 110 ms |
| 20 tools, JSON Schemas built on first use (this pass) | about 84 ms |

`defineTool` now builds a tool's JSON Schemas on first use, and `server.ts` builds the tools/list answer on the first tools/list. A first tools/call builds only that tool's input schema. The first tools/list on an isolate pays the rest, about 26 ms once (the difference above).

## Receipt uploads (third pass)

### Intended differences from the current app

1. `url` is `<BASE_URL>/api/receipt-uploads/<secret>`, not a presigned S3 URL. The agent sends the same PUT with the same two headers and no API key. A second PUT, or a PUT after `expiresAt`, gets 403 `{"error": "This upload URL is not valid, was used, or has expired"}`. Wrong headers get 400 and leave the target usable. With receipts off, the PUT gets 403 "Receipts are disabled".
2. The bytes go to their final key at once, and there is no staging copy (P-TOOL-UPDATEEXP-14).
3. The content must match the declared type (P-TOOL-UPDATEEXP-13).
4. Size and completeness are checked at the PUT, not at attach (P-TOOL-UPDATEEXP-13).
5. Targets that were never attached are deleted with their objects 25 hours after they were made. The current app left `pending-receipts/` objects in the bucket.
6. A failure to write the targets fails the whole call (P-TOOL-CREATEEXP-31).

### Open questions

1. Should the PUT route also require the agent's API key? The current contract sends none, so v2 does not. The secret in the URL is the only credential, as with a presigned URL. It can appear in logs that record full URLs (Cloudflare request logs, agent transcripts) for at most 300 seconds, and only until its one PUT.
2. The final key is fixed by the declared type. An agent that declares the wrong type must request a new target. The alternative is a copy at attach, which costs a second R2 write per receipt.
3. Workers Free counts CPU per request. The PUT does one SHA-256 of 43 bytes and two short UPDATE statements, and workerd streams the body. Attach reads at most 256 KiB per receipt (all of a JPEG whose frame header comes later, at most 5 MiB). These are predictions, not `wrangler tail` numbers from the preview Worker.
