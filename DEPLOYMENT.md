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
| Compose file | `/compose.v2.coolify.yaml` |
| Domain | `https://agentsplit.freemanjiang.com`, on the `app` service |

The services of `compose.v2.coolify.yaml`:

- `app`: the v2 server, built from `v2/Dockerfile`. Bun's distroless image runs the server bundle as user 65532 on port 3000. Coolify's Traefik ends TLS and routes the domain to it.
- `db2`: PostgreSQL 18 with the volume `postgres18-data`. v2 stores everything here. Its network alias is `agentsplit-db2`.
- `garage`: Garage v2.4.1 with the volumes `garage-meta` and `garage-data`, bucket `agentsplit-receipts`. It is unchanged from the old app, so v2 reads the old receipts in place. Its network alias is `agentsplit-garage`. Its Traefik labels still route the authenticated S3 API at `agentsplit-receipts.freemanjiang.com`; v2 does not use that route, because the app reaches Garage on the internal network.
- `db`: the old app's PostgreSQL 17 with the volume `postgres-data`. v2 does not use it. It stays for a rollback.

The app sits on the stack's internal `backend` network and on Coolify's shared `coolify` network. On the shared network a plain service name can resolve to another stack, so the app reaches `db2` and Garage only by the unique aliases. Coolify keeps `/etc/garage.toml` as a file storage of this resource; a new resource would get a directory there, and Garage would not start.

All images are pinned by digest.

## Environment variables

Set these in the Coolify resource environment. Never commit, print or paste their values. `coolify.v2.env.example` lists them with comments.

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | The public origin. OAuth issuers, cookies and upload targets use it. |
| `DB2_PASSWORD` | The password of `db2`. The Compose file builds `DATABASE_URL` from it. |
| `POSTGRES_PASSWORD` | The password of the old `db`. Keep it for a rollback. |
| `BETTER_AUTH_SECRET` | Signs session cookies and decrypts the imported signing keys. It must stay the production value (AUTH.md). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google sign-in client. |
| `AUTH_BOOTSTRAP_EMAIL` | The owner email for the one-time bootstrap (AUTH.md). |
| `GARAGE_RPC_SECRET` | Garage's RPC secret. |
| `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET` | The Garage access key and secret. The same values as the old app. |
| `AGENTSPLIT_MAINTENANCE` | The maintenance switch (below). Empty in normal operation. |

v2 does not read `STORAGE_HOST`, `MCP_ACCESS_GRANTS`, `AUTH_BOOTSTRAP_LEGACY_USER_ID` or `BETTER_AUTH_TELEMETRY`. Keep them, because the old Compose file needs them for a rollback.

The Compose file and the image set the other settings of `v2/src/server/server.ts`: `DATABASE_URL`, `ENABLE_EXPENSE_DOCUMENTS=true`, `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_BUCKET`, `S3_UPLOAD_REGION`, `PORT`, `CLIENT_DIR` and `MIGRATIONS_DIR`. `DATABASE_POOL_SIZE` (default 10) and `HOST` (default `0.0.0.0`) are optional. A missing required setting stops the server at start with its name.

## Deploy

A push to `main` does not deploy by itself.

1. Get Freeman's approval for the deploy.
2. Take a verified backup (below).
3. Push the change to `main`.
4. Start a deploy of `6xpohwok1yiguyk3syzqgumj` in the Coolify dashboard, or through the Coolify API (`GET https://coolify.freemanjiang.com/api/v1/deploy?uuid=6xpohwok1yiguyk3syzqgumj`, with the Cloudflare Access headers and the API token), or with the `coolify_oracle` MCP server.
5. Watch the deployment to its end.
6. Check `https://agentsplit.freemanjiang.com/api/health` and the home page.

Coolify builds `v2/Dockerfile`. At each start, the container applies the new SQL migrations from `MIGRATIONS_DIR` before it takes requests. A failed migration stops the start. Then the health check (`/api/health`, which runs `SELECT 1`) must pass. `/api/health/liveness` answers without the database.

On SIGTERM, the server stops taking connections, lets running requests and the hourly job finish, and exits within 25 seconds. Compose gives it 30 seconds. The hourly job runs at minute 7 of each hour: it creates due recurring expenses, deletes stale receipt uploads, and deletes expired DPoP replay rows.

## Maintenance switch

With `AGENTSPLIT_MAINTENANCE=1`, the server answers 503 with `Retry-After: 300` to every request except `/api/health`: a maintenance page for browsers, a JSON error for other clients. The hourly job pauses. The container still starts, migrates and passes its health check, so nothing writes to `db2`.

1. Set `AGENTSPLIT_MAINTENANCE=1` on the application.
2. Deploy.
3. Do the work.
4. Clear `AGENTSPLIT_MAINTENANCE`.
5. Deploy again.

The variable is read at start, so each change needs a deploy.

## Backups

The nightly job `agentsplit-backup` runs on the dev box from the dots flake (`devbox/bin/agentsplit-backup`, timer `agentsplit-backup.timer`). It writes a PostgreSQL dump and every receipt object to `~/backups/agentsplit/<UTC date>/`, restores the dump into a throwaway PostgreSQL to check it, and keeps 60 days. restic copies the home folder hourly. A failure writes an error to the log `agentsplit-backup`, and the alert "AgentSplit backup failed" watches it.

The job still dumps the old `db` and copies receipts with `node` inside the `app` container, which v2's image does not have. The dots thread is changing it to dump `db2` and copy receipts with Bun. Until that change is live, the job does not back up v2.

Back up `postgres18-data`, `garage-meta` and `garage-data`. Single-node Garage has no replication, and a volume is not a backup. Back up Garage's metadata and data together.

## Rollback

The old app runs on `db`, which the import only read. A rollback loses every write made in v2 after the cutover, because those writes are only in `db2`.

1. Get Freeman's approval.
2. Export the `activities` rows of `db2` since 2026-11-05 18:00:48 UTC, so that the writes made in v2 can be entered again by hand. Decide with Freeman what to do with them.
3. Set the application's Compose file to `/compose.coolify.yaml`.
4. Set the application's commit to `bb26b78`, the `main` commit before the cutover merge. Coolify otherwise deploys the head of `main`.
5. Set the post-deployment command back to the value below, with container `app`. The cutover cleared it, because it runs `node`, which the v2 image does not have.
6. Deploy.
7. Check the old app, its sign-in and the Maple group.

The old post-deployment command (it opens Garage's bucket for receipt reads; it contains no secret values):

```sh
node -e 'const {S3Client,PutBucketWebsiteCommand}=require("@aws-sdk/client-s3");new S3Client({endpoint:"http://garage:3900",region:process.env.S3_UPLOAD_REGION,forcePathStyle:true,credentials:{accessKeyId:process.env.S3_UPLOAD_KEY,secretAccessKey:process.env.S3_UPLOAD_SECRET}}).send(new PutBucketWebsiteCommand({Bucket:process.env.S3_UPLOAD_BUCKET,WebsiteConfiguration:{IndexDocument:{Suffix:"index.html"}}})).then(()=>console.log("Receipt reads enabled")).catch(e=>{console.error(e.name);process.exit(1)})'
```

Keep `db`, `postgres-data` and `compose.coolify.yaml` intact until Freeman says otherwise. Never delete a volume.

## Preview

The Coolify application `AgentSplit v2 preview` (`o4vyiomler6rstiocphgzwv6`) runs branch `v2` with `/compose.v2.preview.yaml` at https://agentsplit-v2-preview.freemanjiang.com. It holds synthetic data only (`v2/scripts/seed-synthetic.ts`), in its own PostgreSQL database `agentsplit_preview` and its own Garage. It has no `db` service and no Traefik labels, and it does not touch the production application. Remove it after the cutover unless Freeman keeps it.
