# AgentSplit on Coolify

AgentSplit v2 runs on Coolify on the Oracle host, at https://agentsplit.freemanjiang.com. It has served production since 2026-11-05 at 18:00:48 UTC. The cutover record and its checks are in [docs/v2/CUTOVER.md](docs/v2/CUTOVER.md).

## Production data preservation

AgentSplit holds real household data. Never reset, truncate, reseed, destructively migrate or delete production records as part of development, deployment or testing. Ask Freeman before every production write, deploy, or merge into `main`. Take a verified backup before each production step. Production checks write only in the group **AgentSplit test**, never in a household group.

Automated tests use disposable local databases and synthetic accounts. They never sign in with a real Google account.

## The application

| Setting | Value |
| --- | --- |
| Coolify application | `AgentSplit`, `6xpohwok1yiguyk3syzqgumj` |
| Repository and branch | `freeman-jiang/agentsplit`, `main` |
| Build pack | Docker Compose |
| Compose file | `/compose.coolify.yaml` |
| Domain | `https://agentsplit.freemanjiang.com`, on the `app` service |

The services of `compose.coolify.yaml`:

- `app`: the server, built from `Dockerfile` at the repository root. Bun's distroless image runs the server bundle as user 65532 on port 3000. Coolify's Traefik ends TLS and routes the domain to it.
- `db2`: PostgreSQL 18 with the volume `postgres18-data`. v2 stores everything here. Its network alias is `agentsplit-db2`.
- `garage`: Garage v2.4.1 with the volumes `garage-meta` and `garage-data`, bucket `agentsplit-receipts`. It is unchanged from the old app, so v2 reads the old receipts in place. Its network alias is `agentsplit-garage`. Its Traefik labels still route the authenticated S3 API at `agentsplit-receipts.freemanjiang.com`; v2 does not use that route, because the app reaches Garage on the internal network.
- `db`: the old app's PostgreSQL 17 with the volume `postgres-data`. v2 does not use it. Freeman approved removing the service on 2026-11-13; the volume `postgres-data` stays for a rollback.

The app sits on the stack's internal `backend` network and on Coolify's shared `coolify` network. On the shared network a plain service name can resolve to another stack, so the app reaches `db2` and Garage only by the unique aliases. Coolify keeps `/etc/garage.toml` as a file storage of this resource; a new resource would get a directory there, and Garage would not start.

All images are pinned by digest.

## Environment variables

Set these in the Coolify resource environment. Never commit, print or paste their values. `coolify.env.example` lists them with comments.

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | The public origin. OAuth issuers, cookies and upload targets use it. |
| `DB2_PASSWORD` | The password of `db2`. The Compose file builds `DATABASE_URL` from it. |
| `POSTGRES_PASSWORD` | The password of the old `db`. Keep it for a rollback. |
| `BETTER_AUTH_SECRET` | Signs session cookies and decrypts the imported signing keys. It must stay the production value (AUTH.md). It must have at least 32 characters, or the server does not start. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google sign-in client. |
| `AUTH_BOOTSTRAP_EMAIL` | The owner email for the one-time bootstrap (AUTH.md). |
| `GARAGE_RPC_SECRET` | Garage's RPC secret. |
| `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET` | The Garage access key and secret. The same values as the old app. |
| `AGENTSPLIT_MAINTENANCE` | The maintenance switch (below): `1`, `true`, `yes` or `on` turns it on. Empty in normal operation. |
| `SIGN_UP_DAILY_LIMIT` | Optional. New accounts per 24 hours, a whole number; empty means 200. Existing accounts always sign in (AUTH.md). |

v2 does not read `STORAGE_HOST`, `MCP_ACCESS_GRANTS`, `AUTH_BOOTSTRAP_LEGACY_USER_ID` or `BETTER_AUTH_TELEMETRY`. Keep them, because the old Compose file needs them for a rollback.

The Compose file and the image set the other settings: `DATABASE_URL`, `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_BUCKET`, `S3_UPLOAD_REGION`, `PORT`, `CLIENT_DIR` and `MIGRATIONS_DIR`. `DATABASE_POOL_SIZE` (default 10), `HOST` (default `0.0.0.0`) and `PERF_INSTRUMENTATION` are optional. `PERF_INSTRUMENTATION` (`1`, `true`, `yes` or `on`) adds the `x-perf-db-queries` and `server-timing` headers to every response (P-PWA-49); leave it empty in production. The server reads and checks every setting once at start (`src/server/core/config.ts`). A missing or malformed setting stops the start with its name, as does a `CLIENT_DIR` without a client build. At start the server also writes `BASE_URL`'s origin into the SPA page's `og:image`, `og:url` and `twitter:image`, which link previews need as absolute URLs.

## Deploy

A push to `main` does not deploy by itself.

1. Get Freeman's approval for the deploy.
2. Take a verified backup (below).
3. If the deploy adds migrations, rehearse them on the backup: restore its dump into a throwaway PostgreSQL 18 database on the dev box, run `DATABASE_URL=<throwaway database> bun db/migrate.ts`, check that it ends with `Migrations applied`, and drop the database. This is the only use of a production backup outside a restore.
4. Push the change to `main`.
5. Start a deploy of `6xpohwok1yiguyk3syzqgumj` in the Coolify dashboard, or through the Coolify API (`GET https://coolify.freemanjiang.com/api/v1/deploy?uuid=6xpohwok1yiguyk3syzqgumj`, with the Cloudflare Access headers and the API token), or with the `coolify_oracle` MCP server.
6. Watch the deployment to its end.
7. Check `https://agentsplit.freemanjiang.com/api/health` and the home page.

Coolify builds `Dockerfile`. At each start, the container applies the new SQL migrations from `MIGRATIONS_DIR` before it takes requests, all of them in one transaction: a deploy that adds several migrations applies all or none, and holds their table locks until the commit. A failed migration stops the start, and so does a migration that waits more than 5 seconds for a lock (`lock_timeout`): stop the query that holds it, then start again. Then the health check (`/api/health`, which runs `SELECT 1`) must pass. `/api/health/liveness` answers without the database.

On SIGTERM, the server stops taking connections, lets running requests and the hourly job finish, and exits within 25 seconds. Compose gives it 30 seconds. The hourly job runs at minute 7 of each hour: it creates due recurring expenses, deletes stale receipt uploads, removes from Garage the receipts that were deleted for good when that failed at once, and deletes expired DPoP replay rows.

Every limit, the fair-use limits included, is a constant in `src/shared/limits.ts`. Only the daily sign-up cap has a setting.

Better Auth limits sign-in and client registration per IP address from `X-Forwarded-For`. It uses the address only when the header holds exactly one, as Traefik sends it when it does not trust incoming forwarding headers. With more than one address, Better Auth counts all such requests together, so the limits still hold, for everyone at once.

### Receipt sizes before migration 0012

Migration 0012 adds `receipts.bytes`. The receipts stored before it keep 0, so they count against no quota. They were 13 objects, about 10 MB, in November 2026. The receipts trigger refuses every change to a receipt row, so their sizes are not filled in later.

## Maintenance switch

With `AGENTSPLIT_MAINTENANCE=1`, the server answers 503 with `Retry-After: 300` to every request except the health checks (`/api/health`, `/api/health/readiness` and `/api/health/liveness`): a maintenance page for browsers, a JSON error for other clients. The hourly job pauses. The container still starts, migrates and passes its health check, so nothing writes to `db2`.

1. Set `AGENTSPLIT_MAINTENANCE=1` on the application.
2. Deploy.
3. Do the work.
4. Clear `AGENTSPLIT_MAINTENANCE`.
5. Deploy again.

The variable is read at start, so each change needs a deploy.

## Backups

The nightly job `agentsplit-backup` runs on the dev box from the dots flake (`devbox/bin/agentsplit-backup`, timer `agentsplit-backup.timer`). It writes a PostgreSQL dump and every receipt object to `~/backups/agentsplit/<UTC date>/`, restores the dump into a throwaway PostgreSQL to check it, and keeps 60 days. restic copies the home folder hourly. A failure writes an error to the log `agentsplit-backup`, and the alert "AgentSplit backup failed" watches it.

Back up `postgres18-data`, `garage-meta` and `garage-data`. Single-node Garage has no replication, and a volume is not a backup. Back up Garage's metadata and data together.

## Rollback

The old app runs on `db`, which the import only read. A rollback loses every write made in v2 after the cutover, because those writes are only in `db2`.

1. Get Freeman's approval.
2. Export the `activities` rows of `db2` since 2026-11-05 18:00:48 UTC, so that the writes made in v2 can be entered again by hand. Decide with Freeman what to do with them.
3. Keep the application's Compose file at `/compose.coolify.yaml`. At `bb26b78` that path holds the old app's stack, with `db` on the `postgres-data` volume.
4. Set the application's commit to `bb26b78`, the `main` commit before the cutover merge. Coolify otherwise deploys the head of `main`.
5. Set the post-deployment command back to the value below, with container `app`. The cutover cleared it, because it runs `node`, which the v2 image does not have.
6. Deploy.
7. Check the old app, its sign-in and the Macademia group.

The old post-deployment command (it opens Garage's bucket for receipt reads; it contains no secret values):

```sh
node -e 'const {S3Client,PutBucketWebsiteCommand}=require("@aws-sdk/client-s3");new S3Client({endpoint:"http://garage:3900",region:process.env.S3_UPLOAD_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_UPLOAD_KEY,secretAccessKey:process.env.S3_UPLOAD_SECRET}}).send(new PutBucketWebsiteCommand({Bucket:process.env.S3_UPLOAD_BUCKET,WebsiteConfiguration:{IndexDocument:{Suffix:"index.html"}}})).then(()=>console.log("Receipt reads enabled")).catch(e=>{console.error(e.name);process.exit(1)})'
```

Keep the `postgres-data` volume until Freeman says otherwise. Never delete a volume.

## Preview

There is no preview deployment. Freeman approved removing the Coolify preview on 2026-11-07. Review changes on a local dev server with synthetic data ("Dev server" in [docs/v2/BUILDING.md](docs/v2/BUILDING.md)).
