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
- `db`: the old app's PostgreSQL 17 with the volume `postgres-data`. v2 does not use it. Freeman approved the removal of the service for 2026-11-13, and the service stays until then. The volume `postgres-data` stays for a rollback.

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

## NixOS host

Freeman approved a move of AgentSplit from Coolify on the shared Oracle host to its own VM: a t4g.small (aarch64, 2 GB) in AWS us-west-2 that runs NixOS from this flake. The VM runs only AgentSplit, so a compromised or overloaded AgentSplit touches no other app. The same flake installs on any cloud VM, so a move to another provider is a reinstall and a restore (below).

The host is not live yet. Production stays on Coolify until the cutover below. The dots repository creates the VM, its tailnet access, the tunnel and the R2 bucket; this repository holds everything that runs on the host.

### What runs on the host

The host has no open inbound port. Cloudflare Tunnel brings the public traffic in, and Tailscale SSH is the only admin path.

| Unit | What it does |
| --- | --- |
| `agentsplit.service` | The server (`nix/package.nix`, the same build as the Dockerfile) on `127.0.0.1:3000`. It applies new migrations at start and runs the hourly job in-process at minute 7, as on Coolify. A dynamic user `agentsplit`, a read-only file system, no capabilities, 640 MB before reclaim, 768 MB at most, 1.5 CPUs, 256 tasks. It restarts on failure, at most 5 times in 10 minutes. |
| `postgresql.service` | PostgreSQL 18 from nixpkgs, on the Unix socket `/run/postgresql` only. The role `agentsplit` owns the database `agentsplit` and signs in by peer authentication. Tuned for 2 GB; 512 MB at most. |
| `agentsplit-db-dump.timer` | A `pg_dump` at minute 37 of each hour into `/var/backup/agentsplit/`, checked with `pg_restore --list`, kept 3 days. `latest.dump` links to the newest one. |
| `agentsplit-tunnel.service` | `cloudflared` for a remotely managed tunnel. Cloudflare holds the tunnel's routes. |
| `tailscaled.service` | Tailscale with Tailscale SSH. The tailnet policy decides who reaches the host. |
| `nixos-upgrade.timer` | The daily operating system upgrade at 09:20 UTC (below). |

The files: `nix/package.nix` (the build), `nix/module.nix` (`services.agentsplit`), `nix/host/default.nix` (the host), `nix/host/ec2.nix` (the EC2 hardware), `nix/host/disk.nix` (the disk layout for new installs), `nix/vm-test.nix` (the VM test) and `nix/deploy-host.sh` (the deploy command).

### Secrets on the host

The secrets are root-only files in `/etc/agentsplit/`. They are never in the Nix store or in Git. systemd reads each file as root before it starts the service.

| File | Holds | Read by |
| --- | --- | --- |
| `agentsplit.env` | The server's settings (below) | `agentsplit.service` |
| `cloudflared.env` | `TUNNEL_TOKEN=<the tunnel token>` | `agentsplit-tunnel.service` |
| `tailscale-auth-key` | Optional. A one-time auth key for a new install | `tailscaled-autoconnect.service`, only when the node is not logged in |
| `root-password-hash` | Optional. A `mkpasswd` hash for the provider's serial console, the way in when Tailscale fails | the root account |

`agentsplit.env` holds `BASE_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_REGION`, `S3_UPLOAD_BUCKET`, `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET`, and the optional `AUTH_BOOTSTRAP_EMAIL`, `AGENTSPLIT_MAINTENANCE` and `SIGN_UP_DAILY_LIMIT` ("Environment variables" above). Do not set `DATABASE_URL`, `HOST` or `PORT` in it: the module sets them, and the file would override them.

The source of each file is a sops file in the dots repository, which the dev box decrypts. The copy goes over Tailscale SSH, through stdin:

```sh
sops -d secrets/agentsplit.env | ssh root@agentsplit 'install -D -m 0400 /dev/stdin /etc/agentsplit/agentsplit.env'
ssh root@agentsplit systemctl restart agentsplit
```

We chose a copied file over sops-nix. sops-nix needs a decryption key on the host, a recipient for each host in dots, and a new flake input. A copied file needs none of these, works on every provider, and has the same exposure on the host: a root-only file on its disk. To change a secret, change it in dots, copy the file again, and restart the service.

### Receipts on R2

On the NixOS host the receipts move from Garage to Cloudflare R2: off the VM, with 10 GB free. The server needs no change. Bun's S3 client signs with SigV4 and uses path-style URLs (`src/server/s3.ts`), which both Garage and R2 accept. Only the settings differ:

| Setting | Garage (Coolify) | R2 (NixOS host) |
| --- | --- | --- |
| `S3_UPLOAD_ENDPOINT` | `http://agentsplit-garage:3900` | `https://<account ID>.r2.cloudflarestorage.com` |
| `S3_UPLOAD_REGION` | `garage` | `auto` |
| `S3_UPLOAD_BUCKET` | `agentsplit-receipts` | `agentsplit-receipts` |
| `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET` | The Garage key | An R2 API token with Object Read and Write on this bucket only |

The bucket needs no public access and no CORS rule: the app streams every receipt itself. `scripts/copy-receipts.ts` copies the objects from Garage with their content types (below).

### Operating system upgrades

`nixos-upgrade.timer` rebuilds the deployed commit from GitHub each day, with `nixpkgs-host` at the head of `nixos-26.05`. That release branch gets only backports and security fixes. The app, its Bun and its dependencies come from the locked `nixpkgs` input, so they stay as deployed; app changes reach the host only through `deploy-host`. When the upgrade brings a new kernel, the host reboots between 09:00 and 10:30 UTC. `deploy-host` builds the same way, so a deploy never takes the operating system back.

NixOS 26.05 ends its support at the end of December 2026. Before then, move `hostNixpkgs` in `flake.nix` and the `nixpkgs-host` input to the next release, run the VM test, and deploy.

### First install

The configuration mounts the file systems by the labels `nixos` and `ESP`, as the official NixOS EC2 image does. On EC2, start from that image, and the first deploy takes the instance over without a new install. On another provider, install with nixos-anywhere, which writes the same labels (`nix/host/disk.nix`).

On EC2 (the dots side creates the instance):

1. Create the instance from the official NixOS 26.05 aarch64 image, with no inbound rule, IMDSv2 only, and a 20 GB gp3 volume.
2. Join it to the tailnet as `agentsplit`, with Tailscale SSH on.
3. Check the access: `ssh root@agentsplit true`.
4. Copy `agentsplit.env` and `cloudflared.env` (above). Set `AGENTSPLIT_MAINTENANCE=1` until the cutover.
5. On the dev box, in a checkout of a pushed commit, run `direnv exec . deploy-host`.
6. Check that no unit failed: `ssh root@agentsplit systemctl --failed`.

The first deploy replaces the image's configuration: sshd, the SSM agent and the EC2 user-data service stop. Tailscale keeps its state in `/var/lib/tailscale`, so the node keeps its name and its address.

On another provider:

1. Write a hardware profile for the provider (a copy of `nix/host/ec2.nix` with its disk and network drivers and its console), and import it in `nix/host/default.nix` in place of `ec2.nix`. If its disk is not `/dev/nvme0n1`, set `disko.devices.disk.main.device` in the profile.
2. Create an aarch64 VM with UEFI, at least 2 GB of memory and a 20 GB disk, with any Linux and root SSH access from the dev box for the install only.
3. Put the secret files in a local folder at `etc/agentsplit/`, with a one-time Tailscale auth key from `infra/bin/tailscale-auth-key` in dots.
4. Run `nix run --inputs-from . nixpkgs#nixos-anywhere -- --flake .#agentsplit --extra-files <folder> root@<address>`.
5. Under Tailnet Lock, sign the new node key on the dev box: `sudo tailscale lock sign nodekey:<key>`.
6. Close the temporary SSH access, and delete `/etc/agentsplit/tailscale-auth-key` on the host.
7. Check that the modes of the files in `/etc/agentsplit/` are `0400`.

### Deploy

1. Get Freeman's approval for the deploy.
2. Take a verified backup (below).
3. Rehearse new migrations on the backup, as in "Deploy" above.
4. Merge the change into `main` and push it.
5. In a clean checkout of `main` on the dev box, run `direnv exec . deploy-host`.

`deploy-host` refuses a tree with uncommitted changes and a commit that is not on GitHub, because the daily upgrade fetches the deployed commit from there. It builds the host on the dev box, copies it over Tailscale SSH, and activates it without making it the boot default. When `agentsplit.service` runs and `/api/health` answers, it makes the new system the boot default. If the health check fails, a reboot or this command returns to the previous system:

```sh
ssh root@agentsplit /nix/var/nix/profiles/system/bin/switch-to-configuration switch
```

To go back after a completed deploy, use `nix-env --profile /nix/var/nix/profiles/system --rollback`, then the same command. A rollback does not undo migrations.

The maintenance switch on the host: set `AGENTSPLIT_MAINTENANCE=1` in `agentsplit.env` and run `systemctl restart agentsplit`. The tunnel and the health checks stay up.

### Backups of the host

The host dumps the database every hour into `/var/backup/agentsplit/` and keeps 3 days. The user `agentsplit-backup` can read the dumps and nothing else: it has no database role. The dev box pulls the newest dump as that user:

```sh
ssh agentsplit-backup@agentsplit agentsplit-latest-dump > agentsplit.dump
```

`agentsplit-latest-dump` fails when the newest dump is older than 150 minutes, so a stopped timer fails the pull. The receipts are in R2; the dev box reads them with its own read-only R2 token. The test restore stays on the dev box, as in "Backups" above.

### Move the data from Oracle

Keep `BASE_URL` at `https://agentsplit.freemanjiang.com` for the move. The OAuth issuer, every agent's tokens, the session cookies and the Google redirect URI depend on it. A change of domain (for example to `agentsplit.net`) is a separate step with its own plan: every agent must connect again, and every person must sign in again.

Before the window:

1. Install and deploy the host with `AGENTSPLIT_MAINTENANCE=1` and the R2 settings.
2. Copy the receipts once while Coolify serves (the first copy takes the longest). Run it on the dev box. Give it the Garage key from Coolify and the R2 key as the environment variables `SOURCE_S3_KEY`, `SOURCE_S3_SECRET`, `TARGET_S3_KEY` and `TARGET_S3_SECRET`, for example with `sops exec-env`. Never type them on a command line.

   ```sh
   SOURCE_S3_ENDPOINT=https://agentsplit-receipts.freemanjiang.com SOURCE_S3_REGION=garage SOURCE_S3_BUCKET=agentsplit-receipts \
   TARGET_S3_ENDPOINT=https://<account ID>.r2.cloudflarestorage.com TARGET_S3_REGION=auto TARGET_S3_BUCKET=agentsplit-receipts \
   bun scripts/copy-receipts.ts
   ```

3. Route a test hostname through the tunnel, and check `/api/health` on it.

In the window:

1. Get Freeman's approval.
2. Turn on the maintenance switch on Coolify ("Maintenance switch" above). Nothing writes from now on.
3. Run the dev box backup (`systemctl --user start agentsplit-backup.service`) and check that it passed.
4. Run `scripts/copy-receipts.ts` again, then with `--check`. It must report every object.
5. Stop the server on the host: `ssh root@agentsplit systemctl stop agentsplit`.
6. Make an empty database on the host. It holds no production data yet: `ssh root@agentsplit 'sudo -u postgres dropdb agentsplit && sudo -u postgres createdb --owner=agentsplit agentsplit'`.
7. Restore the backup's dump into it as the server's role:

   ```sh
   ssh root@agentsplit 'sudo -u postgres pg_restore --no-owner --no-acl --role=agentsplit --exit-on-error --dbname=agentsplit' < ~/backups/agentsplit/<UTC date>/agentsplit.dump
   ```

8. Compare the counts of `groups`, `expenses`, `activities` and `expense_payers` on the host with the backup's log line.
9. Clear `AGENTSPLIT_MAINTENANCE` in the host's `agentsplit.env`, and start the server: `ssh root@agentsplit systemctl start agentsplit`.
10. Point the production hostname at the tunnel (the dots side: a proxied CNAME to `<tunnel ID>.cfargotunnel.com` and the tunnel's route to `http://127.0.0.1:3000`).
11. Check `/api/health`, the home page, a sign-in, an old receipt, and an MCP write in the group **AgentSplit test**.
12. Move the dev box backup to the host (the dots side).

Keep the Coolify stack in maintenance and keep its volumes until Freeman says otherwise.

### Roll back to Coolify

1. Get Freeman's approval.
2. Turn on the maintenance switch on the host.
3. If the host took writes, carry them back: run `systemctl start agentsplit-db-dump` on the host, pull `agentsplit-latest-dump`, restore it into `db2` on Coolify with `pg_restore --clean --if-exists --no-owner --no-acl`, and run `scripts/copy-receipts.ts` from R2 to Garage (SOURCE and TARGET swapped).
4. Point the production hostname back at Oracle.
5. Turn off the maintenance switch on Coolify and deploy.
6. Check the app as in "Deploy" above.

### Move to another cloud

R2 holds the receipts, and the tunnel does not depend on an address, so a move copies only the database. It takes about an hour.

1. Install the new VM as in "First install" (on another provider), with `AGENTSPLIT_MAINTENANCE=1`. Tailscale names it `agentsplit-1` while the old host exists, so give that name to each command, for example `deploy-host root@agentsplit-1`.
2. Get Freeman's approval, and turn on the maintenance switch on the old host.
3. Run `systemctl start agentsplit-db-dump` on the old host, and pull the dump.
4. Restore it on the new host, as in steps 5 to 8 of the window above.
5. Stop the tunnel on the old host: `systemctl stop agentsplit-tunnel`. Two connectors of one tunnel share the traffic, so both hosts must never serve at the same time.
6. Clear the maintenance switch on the new host, and start its server.
7. Check the app as in step 11 of the window above.
8. Delete the old VM after Freeman's approval, and rename the new node to `agentsplit` in Tailscale.
