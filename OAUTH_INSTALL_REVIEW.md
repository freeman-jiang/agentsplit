# AgentSplit MCP OAuth dependency review — 2026-10-07

Proposed additions, all pinned exactly to **1.7.6** to match the installed Better Auth release:

| Package                       | Purpose                                                                   | npm publication (UTC) |
| ----------------------------- | ------------------------------------------------------------------------- | --------------------- |
| `@better-auth/mcp`            | Official MCP OAuth provider, discovery and token-verification helpers     | 2026-09-24 15:59:31   |
| `@better-auth/cimd`           | Client metadata discovery with the official SSRF-resistant Node transport | 2026-09-24 15:59:29   |
| `@better-auth/oauth-provider` | MCP's underlying OAuth implementation and browser client plugin           | 2026-09-24 16:01:37   |

All three are older than seven days. The proposed lockfile changes exactly these three package records; no existing dependency version changes. Existing jose 6.2.12, zod 4.6.5, better-call 1.4.0, Better Auth/core 1.7.6 and other required peers already satisfy their ranges. There are no further new transitive packages. No lifecycle install/prepare scripts or native compilation are declared by these additions. Install with lifecycle scripts disabled, then run the existing Prisma generator explicitly after reviewing the additive schema.

Review artifacts (no credentials): `/private/tmp/agentsplit-oauth-review/package-lock.json`, `reviewed-packages.json`, `audit.json` and `baseline-audit.json`. Package tarballs were fetched only for source inspection; their SHA-512 digests match the authoritative npm registry integrity metadata. Their repository metadata points to the Better Auth monorepo. No downloaded package code has been executed or installed during this review.

Security searches used built-in web search and Exa plus the npm registry/advisory audit. No new audit findings are introduced by these three additions. The full current dependency tree reports 29 inherited affected package entries (23 moderate, 6 high; propagation means this is not 29 distinct advisories), including Prisma dependencies, sharp, source-map-js and build/test tooling. These are not claimed resolved by the OAuth work.

Two recent Better Auth 1.7.6 advisories were reviewed separately because registry audits can lag: GHSA-965c-763c-88jm requires the Magic Link plugin alongside social login; GHSA-r4xp-prcw-77qf requires the OAuth Proxy plugin with particular secret/state/linking settings. AgentSplit enables neither Magic Link nor OAuth Proxy, and this integration will not add them. This conditional exposure assessment is not a claim that 1.7.6 is universally vulnerability-free.

Sources:

- https://registry.npmjs.org/@better-auth%2fmcp
- https://registry.npmjs.org/@better-auth%2fcimd
- https://registry.npmjs.org/@better-auth%2foauth-provider
- https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm
- https://github.com/better-auth/better-auth/security/advisories/GHSA-r4xp-prcw-77qf
- https://better-auth.com/docs/plugins/mcp
- https://better-auth.com/docs/plugins/cimd

Installation is local to this repository. Use its existing npm lockfile to avoid unrelated resolution changes; retain Bun for repository scripts and tests. No global installation, new hosted auth service, API-key rotation or production data reset is needed.
