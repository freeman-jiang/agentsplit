# Local dependency installation review

Reviewed September 29, 2026 (Pacific time). Installation is local to this checkout.
The exact resolved set is recorded in `package-lock.json`: 909 dependency entries,
860 distinct package versions. Oxlint is already an upstream dependency.

Core versions: Next.js 16.3.6, React 19.3.0, Prisma 7.10.0, TypeScript 7.0.2,
Oxlint 1.85.0, Jest 30.5.2, and Prettier 3.9.8.

Every resolved version's publication date was checked against the npm registry.
Three releases were slightly younger than the seven-day minimum, so the proposed
lockfile uses compatible older versions: Prettier 3.9.8 (September 17),
electron-to-chromium 1.5.436 (September 23, 02:04 UTC), and node-releases 2.0.56
(September 17). All proposed versions meet the minimum. Missing tarball and
integrity metadata was filled from the registry; existing hashes matched.

OSV reported URI handling advisories for fast-uri 3.1.5. The lockfile moves it to
3.1.8 (September 15), which fits its parent's declared range and has no additional
dependencies or reported OSV advisories at review time.

Three other inherited transitive versions have reported advisories:

- deepmerge-ts 7.1.5: recursive object merge can exhaust the stack. It is used by
  Prisma configuration; fixing it requires a major version change.
- mysql2 3.15.3: MySQL authentication and compressed response handling advisories.
  Prisma includes it, while AgentSplit uses PostgreSQL.
- uuid 8.3.2: buffer bounds in certain UUID APIs. Source inspection after install
  confirms next-s3-upload uses UUID v4, which is outside the affected APIs.

These findings are recorded rather than forcing major transitive overrides.
A clean search does not establish that software is safe.

The proposed install uses Bun with frozen versions and lifecycle scripts disabled.
In particular, the root postinstall will not run database migrations. Native
packages include Oxlint, SWC, Sharp, esbuild, Parcel watcher, and Prisma engines.
Most use reviewed platform packages. Prisma generation also fetched its official
schema engine for commit `0edf323efd1d98336f3f0a68684b56f689b900d3`. Its checksum
files were last modified July 27, 2026; the compressed SHA-256 is
`41bfd05725a9561043c3e2f78d8f00686fe116400f99e89fc9881394d632f261`.
No additional package versions were installed.

Installation used npm ci with scripts disabled because Bun refused the frozen
npm lockfile import. All 740 installed platform entries matched the reviewed
lockfile. Prisma generation, TypeScript, formatting, and the production build
passed. Jest passed 434 tests in 36 suites across two time zones. Oxlint passed
with zero errors and 20 inherited warnings.

Runtime verification used the generated standalone server and a disposable
PostgreSQL 18 database from an already-cached image. All 25 schema migrations
applied to that new test database. Browser verification created a group and a
$30 expense split evenly between three participants, confirmed the resulting
balances and activity entry, and found no browser errors in that flow. Existing
databases were not changed. Garage uploads and the Coolify deployment were not
tested. Next.js and Prisma telemetry remained disabled.

## Verification checkpoint

The privacy baseline is committed locally as `a599e5e`. Work continues on branch
`codex/mcp`. Nothing has been pushed or deployed.
The temporary standalone server and disposable database were stopped after the
smoke test; its synthetic group and expense were discarded with the database.
Dependencies remain installed in `node_modules`.

Next: verify Garage receipt uploads with the deployment stack and configure the
actual Coolify domains and credentials.
