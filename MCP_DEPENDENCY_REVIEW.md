# MCP dependency review

Reviewed and approved local and AgentSplit-only deployment installation,
September 30, 2026. The two packages were installed with scripts disabled;
all 742 installed local platform entries matched the reviewed lockfile.

| Package                        | Exact version | npm publication (UTC)   |
| ------------------------------ | ------------- | ----------------------- |
| `@modelcontextprotocol/server` | 2.0.0         | July 27, 2026, 23:55:22 |
| `@modelcontextprotocol/core`   | 2.0.0         | July 27, 2026, 23:55:21 |

Both are official MCP TypeScript SDK packages and exceed the seven-day minimum.
Server depends on core 2.0.0 and Zod; core depends on Zod. The existing reviewed
Zod 4.6.5 satisfies both. No existing dependency version changes are proposed.
Tarball integrity hashes were checked against npm metadata during read-only
inspection and are recorded in `package-lock.json`. Neither new package has
installation lifecycle scripts or native build requirements.

The exact-version OSV query reported no advisories for these two versions.
Upstream issues include an onclose-chain leak when a server instance is reused,
missing modern protocol-header validation, and extension-method dispatch bugs.
Use a fresh server factory per request, enforce modern protocol headers at the
route boundary, and keep this endpoint to basic read-only tools. The reported
cross-client data-leak and DNS-rebinding advisories apply to older v1 SDK releases;
the implementation will still authenticate requests and reject foreign origins.
These checks are not a guarantee that no vulnerabilities exist.

The community `trpc-to-mcp` bridge was inspected but is not proposed for
installation: its compatible v2 release is younger than seven days and its
maintenance depends on one human contributor. A small registry adapter will use
the official SDK and tRPC's existing validation/dispatch.

Install only the reviewed lockfile with lifecycle scripts disabled, avoiding the
project's automatic database migration. The new SDK code will execute during
tests, production compilation, local MCP smoke tests, and the scoped Coolify
deployment. Existing reviewed Prisma generation/migration requirements remain
unchanged. No global CLI, inspector, new browser runtime, or OpenAI SDK is needed.
