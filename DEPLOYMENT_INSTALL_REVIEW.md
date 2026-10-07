# AgentSplit deployment installation review

Scope: a new AgentSplit deployment on the Oracle ARM64 server, using
`agentsplit.freemanjiang.com` and `agentsplit-receipts.freemanjiang.com`.
Existing applications and their databases are outside this deployment.

Exact proposed immutable images:

| Image                 | Registry publication (UTC) | Index digest                                                            |
| --------------------- | -------------------------- | ----------------------------------------------------------------------- |
| node:26.10.0-bookworm | 2026-09-22 20:40           | sha256:2aaae6d91f99fee84cfc92da9b52c22a185752d247746052bbc3f961e44478c6 |
| postgres:17.11-alpine | 2026-09-21 04:08           | sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24 |
| dxflrs/garage:v2.4.1  | 2026-09-08 09:07           | sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020 |

Docker Hub metadata confirms ARM64 support and publication before the seven-day
cutoff. Their bundled dependency bytes are part of these immutable artifacts.
No floating OS-package install or separate unlocked Prisma install is proposed.

The application build reinstalls the previously reviewed npm lockfile (909
entries, 860 distinct package versions) on Linux ARM64 with lifecycle scripts
disabled. See `INSTALL_REVIEW.md` for publication evidence, integrity review,
the fast-uri patch, and the three inherited dependency advisories. No new npm
package versions are proposed.

Prisma 7.10.0 generation explicitly downloads the official Linux ARM64 schema
engine for commit `0edf323efd1d98336f3f0a68684b56f689b900d3`. Its checksum files
were last modified July 27, 2026. Compressed SHA-256:
`376866f79f883e778207191c4013518bd96d82abe181f5c37ced616698bc8d88`.
Decompressed SHA-256:
`cdc70069d4164ff0b8487c59d41786a050dd732bc4423bf672936add869a190f`.
Prisma generation, Next.js compilation, and the application entrypoint execute
reviewed dependency code. The entrypoint applies migrations only to the new
AgentSplit database before starting the server.

Official Node and PostgreSQL release/security information was checked. Node
26.10.0 follows the July security releases; PostgreSQL 17.11 incorporates the
August 13 security fixes. Garage's upstream documentation and pinned release
were checked. This is an upstream and artifact review, not a complete container
vulnerability scan or guarantee that no vulnerabilities exist.

Coolify currently has API access disabled and no API tokens. Programmatic setup
would temporarily enable API access restricted to loopback, create a short-lived
team-scoped read/write/deploy token, use it only inside the Coolify container,
then revoke it and restore the prior API settings. The token must remain in a
server-side private temporary file and never enter source control or logs.
