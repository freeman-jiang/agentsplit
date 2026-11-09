# Deploying AgentSplit

AgentSplit runs at https://agentsplit.net on its own NixOS host: a GCE e2-micro in GCP's free tier, behind a Cloudflare Tunnel, with the receipts in Cloudflare R2. It has served production there since 2026-11-08. `deploy-host` deploys it, and the dev box pulls its backups. The previous Coolify stack on the Oracle host stays in maintenance mode, only for a rollback ("Previous hosting: Coolify (rollback only)" below). The v2 cutover of 2026-11-05 is recorded in [docs/history/v2/CUTOVER.md](docs/history/v2/CUTOVER.md).

## Production data preservation

AgentSplit holds real household data. Never reset, truncate, reseed, destructively migrate or delete production records as part of development, deployment or testing. Ask Freeman before every production write, deploy, or merge into `main`. Take a verified backup before each production step. Production checks write only in the group **AgentSplit test**, never in a household group.

Automated tests use disposable local databases and synthetic accounts. They never sign in with a real Google account.

## The host

The host is a GCE e2-micro (x86_64, 2 shared vCPUs at about a quarter of a core sustained, 1 GB of memory, a 30 GB pd-standard disk) in us-west1, in GCP's free tier, that runs NixOS from this flake. The VM runs only AgentSplit, so a compromised or overloaded AgentSplit touches no other app. The same flake builds the host for EC2 (`agentsplit-ec2`, a t4g.small) and installs on any cloud VM, so a move to another provider is a reinstall and a restore (below).

The dots repository creates the VM, its network, its tailnet access, the tunnel and the R2 bucket; this repository holds everything that runs on the host.

### What runs on the host

The host has no open inbound port. Cloudflare Tunnel brings the public traffic in, and Tailscale SSH is the only admin path.

| Unit | What it does |
| --- | --- |
| `agentsplit.service` | The server (`nix/package.nix`, the same build as the Dockerfile) on `127.0.0.1:3000`. It applies new migrations at start and runs the hourly job in-process at minute 7. A dynamic user `agentsplit`, a read-only file system, no capabilities, a pool of 5 database connections, 256 MB before reclaim, 320 MB at most, 1.5 CPUs, 128 tasks. It restarts on failure, at most 5 times in 10 minutes. |
| `postgresql.service` | PostgreSQL 18 from nixpkgs, on the Unix socket `/run/postgresql` only. The role `agentsplit` owns the database `agentsplit` and signs in by peer authentication. Tuned for 1 GB: 64 MB of shared buffers, 16 connections, no parallel queries; 256 MB at most. |
| `agentsplit-db-dump.timer` | A `pg_dump` at minute 37 of each hour into `/var/backup/agentsplit/`, checked with `pg_restore --list`, kept 3 days. `latest.dump` links to the newest one. |
| `agentsplit-tunnel.service` | `cloudflared` for a remotely managed tunnel. Cloudflare holds the tunnel's routes. 128 MB at most. |
| `tailscaled.service` | Tailscale with Tailscale SSH. The tailnet policy decides who reaches the host. |
| `agentsplit-tailscale-join.service` | On GCE: the first join to the tailnet, with the auth key from the instance metadata ("First install"). It stops once the node is logged in. |

The host does not update itself. An evaluation of the flake needs about 600 MB, which 1 GB cannot spare, so the dev box builds every change ("Weekly update").

The files: `nix/package.nix` (the build), `nix/module.nix` (`services.agentsplit`), `nix/host/default.nix` (the host), `nix/host/gce.nix` (the GCE hardware, the first join and the image), `nix/host/ec2.nix` (the EC2 hardware), `nix/host/disk.nix` (the disk layout for nixos-anywhere installs), `nix/vm-test.nix` (the VM test) and `nix/deploy-host.sh` (the deploy command). `flake.nix` puts the host and one hardware profile together (`mkHost`): `nixosConfigurations.agentsplit` is the GCE host, and `nixosConfigurations.agentsplit-ec2` is the EC2 host.

### Memory budget

The e2-micro has 1 GB, of which the kernel leaves about 940 MB. The VM test (`nix/vm-test.nix`) boots the host's modules in a VM of 1 GB and prints the use after the migrations, a dump and a restore.

| Part | Measured (VM test) | Limit |
| --- | --- | --- |
| `agentsplit.service` | 90 MiB, 134 MiB at its peak | 256 MB before reclaim, 320 MB at most, 128 MB of swap |
| `postgresql.service` (with its page cache) | 115 MiB | 192 MB before reclaim, 256 MB at most |
| `systemd-journald.service` | 11 MiB | 16 MB kept from reclaim |
| `tailscaled.service` | 36 MiB (logged out) | 48 MB kept from reclaim |
| `agentsplit-tunnel.service` | not in the test (about 30 MB) | 128 MB at most |
| The whole VM | 307 MiB used, 631 MiB available of 939 MiB | |

The limits of the server, PostgreSQL and the connector add up to 704 MB, so the system, Tailscale, the page cache and a deploy keep at least 230 MB when all three are at their limits. zram adds compressed swap of up to half the memory for idle pages.

When memory runs out, the kernel stops processes in this order: a deploy's `nix-daemon` (`OOMScoreAdjust` 800), a dump (600), the server (500), the connector (300); then PostgreSQL (-500), `tailscaled` and `systemd-journald` (-900) last. systemd restarts the server and the connector. The server's pool of 5 connections, the dump, an admin session and PostgreSQL's 3 superuser slots fit in `max_connections` = 16; `nix/module.nix` refuses a pool that does not fit. Do not set `DATABASE_POOL_SIZE` in `agentsplit.env`: the module sets it.

### Secrets on the host

The secrets are root-only files in `/etc/agentsplit/`. They are never in the Nix store, in the image or in Git. systemd reads each file as root before it starts the service.

| File | Holds | Read by |
| --- | --- | --- |
| `agentsplit.env` | The server's settings ("Environment variables" below) | `agentsplit.service` |
| `cloudflared.env` | `TUNNEL_TOKEN=<the tunnel token>` | `agentsplit-tunnel.service` |
| `root-password-hash` | Optional. A `mkpasswd` hash for the provider's serial console, the way in when Tailscale fails | the root account |
| `tailscale-auth-key` | Only for a nixos-anywhere install (not GCE). A one-time auth key | `tailscaled-autoconnect.service`, only when the node is not logged in |

On GCE, the first join takes its auth key from the instance metadata, not from a file ("First install").

The source of each file is a sops file in the dots repository, which the dev box decrypts. The copy goes over Tailscale SSH, through stdin:

| File on the host | Source in dots |
| --- | --- |
| `agentsplit.env` | `secrets/agentsplit.env` |
| `cloudflared.env` | `secrets/agentsplit-cloudflared.env` |
| `root-password-hash` | the key `root_password_hash` in `secrets/agentsplit-host.yaml` |

```sh
sops -d secrets/agentsplit.env | ssh root@agentsplit 'install -D -m 0400 /dev/stdin /etc/agentsplit/agentsplit.env'
sops -d secrets/agentsplit-cloudflared.env | ssh root@agentsplit 'install -D -m 0400 /dev/stdin /etc/agentsplit/cloudflared.env'
sops -d --extract '["root_password_hash"]' secrets/agentsplit-host.yaml | ssh root@agentsplit 'install -D -m 0400 /dev/stdin /etc/agentsplit/root-password-hash'
ssh root@agentsplit systemctl restart agentsplit agentsplit-tunnel
```

We chose a copied file over sops-nix. sops-nix needs a decryption key on the host, a recipient for each host in dots, and a new flake input. A copied file needs none of these, works on every provider, and has the same exposure on the host: a root-only file on its disk. To change a secret, change it in dots, copy the file again, and restart the service.

### Network, DNS and time on GCE

The dots side gives the VM its own VPC with no ingress rule. Egress is open only on TCP 443, TCP and UDP 7844 (cloudflared), UDP 3478 and UDP 41641 (Tailscale). The GCE metadata server, `169.254.169.254`, is the DNS resolver that DHCP gives and the time server (`nix/host/gce.nix`); the VPC firewall does not filter traffic to it. The host keeps that resolver (`--accept-dns=false`): the firewall allows no DNS to the internet, so a resolver from the tailnet would break name lookups. The VM's service account has no roles: the host reads only its own metadata, which needs none. The instance metadata sets `serial-port-enable=TRUE` and `block-project-ssh-keys=TRUE`; the host runs no sshd and no guest agent, so no SSH key in the metadata opens a way in.

### Receipts on R2

The host keeps the receipts in Cloudflare R2: off the VM, with 10 GB free and no charge for data out. Bun's S3 client signs with SigV4 and uses path-style URLs (`src/server/s3.ts`), which both R2 and the Garage of the Coolify stack accept. Only the settings differ:

| Setting | R2 (the host) | Garage (Coolify) |
| --- | --- | --- |
| `S3_UPLOAD_ENDPOINT` | `https://<account ID>.r2.cloudflarestorage.com` | `http://agentsplit-garage:3900` |
| `S3_UPLOAD_REGION` | `auto` | `garage` |
| `S3_UPLOAD_BUCKET` | `agentsplit-receipts` | `agentsplit-receipts` |
| `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET` | An R2 API token with Object Read and Write on this bucket only | The Garage key |
| `RECEIPT_DOWNLOADS` | `redirect` | empty (`stream`) |

With `redirect`, the app checks access and then sends the reader to a presigned R2 URL that works for 5 minutes, so the receipt bytes do not leave the VM, where data out over 1 GB a month is billed. The bucket needs no public access and no CORS rule: browsers load receipts only through `<img>` and links, which follow the redirect. The group ZIP download still streams through the server. `scripts/copy-receipts.ts` copies the objects between two buckets with their content types ("Roll back to Coolify" below).

## Environment variables

On the host, these settings are in `/etc/agentsplit/agentsplit.env` ("Secrets on the host"). Never commit, print or paste their values. `coolify.env.example` lists them with comments.

| Variable | Purpose |
| --- | --- |
| `BASE_URL` | The public origin. OAuth issuers, cookies and upload targets use it. |
| `BETTER_AUTH_SECRET` | Signs session cookies and decrypts the imported signing keys. It must stay the production value (AUTH.md). It must have at least 32 characters, or the server does not start. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google sign-in client. |
| `S3_UPLOAD_ENDPOINT`, `S3_UPLOAD_REGION`, `S3_UPLOAD_BUCKET` | The receipt bucket ("Receipts on R2"). |
| `S3_UPLOAD_KEY`, `S3_UPLOAD_SECRET` | The bucket's access key and secret. |
| `AUTH_BOOTSTRAP_EMAIL` | Optional. The owner email for the one-time bootstrap (AUTH.md). |
| `AGENTSPLIT_MAINTENANCE` | Optional. The maintenance switch (below): `1`, `true`, `yes` or `on` turns it on. Empty in normal operation. |
| `SIGN_UP_DAILY_LIMIT` | Optional. New accounts per 24 hours, a whole number; empty means 200. Existing accounts always sign in (AUTH.md). |
| `RECEIPT_DOWNLOADS` | Optional. `stream` (the default when empty) sends each receipt image through the app. `redirect` checks access the same way, then answers 307 to a presigned GET URL on storage that works for 5 minutes, so the image does not pass through the server. The page then allows images from the origin of `S3_UPLOAD_ENDPOINT`. The host sets `redirect`. |

Do not set `DATABASE_URL`, `DATABASE_POOL_SIZE`, `HOST` or `PORT` in `agentsplit.env`: `nix/module.nix` sets them, and the file would override them. The package sets `CLIENT_DIR` and `MIGRATIONS_DIR`. `PERF_INSTRUMENTATION` is optional: `1`, `true`, `yes` or `on` adds the `x-perf-db-queries` and `server-timing` headers to every response (P-PWA-49); leave it empty in production. Outside the module, `DATABASE_POOL_SIZE` defaults to 10 and `HOST` to `0.0.0.0`. The server reads and checks every setting once at start (`src/server/core/config.ts`). A missing or malformed setting stops the start with its name, as does a `CLIENT_DIR` without a client build. At start the server also writes `BASE_URL`'s origin into the SPA page's `og:image`, `og:url` and `twitter:image`, which link previews need as absolute URLs.

## Deploy

1. Get Freeman's approval for the deploy.
2. Take a verified backup ("Backups" below).
3. If the deploy adds migrations, rehearse them on the backup: restore its dump into a throwaway PostgreSQL 18 database on the dev box, run `DATABASE_URL=<throwaway database> bun db/migrate.ts`, check that it ends with `Migrations applied`, and drop the database. This is the only use of a production backup outside a restore.
4. Merge the change into `main` and push it.
5. In a clean checkout of `main` on the dev box, run `direnv exec . deploy-host`.

`deploy-host` refuses a tree with uncommitted changes and a commit that is not on GitHub: the host records the deployed commit, and the weekly update rebuilds it. It builds the host on the dev box with `nixpkgs-host` at the head of `nixos-26.05`, copies it over Tailscale SSH, and activates it without making it the boot default. The host fetches what it can from the NixOS binary cache. When `agentsplit.service` runs and `/api/health` answers, it makes the new system the boot default. If the health check fails, a reboot or this command returns to the previous system:

```sh
ssh root@agentsplit /nix/var/nix/profiles/system/bin/switch-to-configuration switch
```

To go back after a completed deploy, use `nix-env --profile /nix/var/nix/profiles/system --rollback`, then the same command. A rollback does not undo migrations.

The GCE host is x86_64 and the dev box is aarch64. Nix builds the host under emulation (`boot.binfmt.emulatedSystems` in dots), and most paths come from the binary cache; the app's build is the slow part. Without emulation, `deploy-host` stops at once with the message `this machine cannot build x86_64-linux`. A new kernel takes effect at the next boot; `deploy-host` says so, and the weekly update reboots for it.

At each start, the server applies the new SQL migrations from `MIGRATIONS_DIR` before it takes requests, all of them in one transaction: a deploy that adds several migrations applies all or none, and holds their table locks until the commit. A failed migration stops the start, and so does a migration that waits more than 5 seconds for a lock (`lock_timeout`): stop the query that holds it, then start again. Then the health check (`/api/health`, which runs `SELECT 1`) must pass. `/api/health/liveness` answers without the database.

On SIGTERM, the server stops taking connections, lets running requests and the hourly job finish, and exits within 25 seconds. The hourly job runs at minute 7 of each hour: it creates due recurring expenses, deletes stale receipt uploads, removes from storage the receipts that were deleted for good when that failed at once, and deletes expired DPoP replay rows.

Every limit, the fair-use limits included, is a constant in `src/shared/limits.ts`. Only the daily sign-up cap has a setting.

Better Auth limits sign-in and client registration per IP address from `X-Forwarded-For`. It uses the address only when the header holds exactly one, as a proxy sends it when it does not trust incoming forwarding headers. With more than one address, Better Auth counts all such requests together, so the limits still hold, for everyone at once.

### Receipt sizes before migration 0012

Migration 0012 adds `receipts.bytes`. The receipts stored before it keep 0, so they count against no quota. The receipts trigger refuses every change to a receipt row, so their sizes are not filled in later.

## Maintenance switch

With `AGENTSPLIT_MAINTENANCE=1`, the server answers 503 with `Retry-After: 300` to every request except the health checks (`/api/health`, `/api/health/readiness` and `/api/health/liveness`): a maintenance page for browsers, a JSON error for other clients. The hourly job pauses. The server still starts, migrates and passes its health check, so nothing writes to the database.

1. Set `AGENTSPLIT_MAINTENANCE=1` in the host's `agentsplit.env` ("Secrets on the host").
2. Run `ssh root@agentsplit systemctl restart agentsplit`. The tunnel and the health checks stay up.
3. Do the work.
4. Clear `AGENTSPLIT_MAINTENANCE`, and restart the server again.

The variable is read at start, so each change needs a restart.

## Weekly update

The host's operating system follows `nixos-26.05`, a release branch that gets only backports and security fixes. The dev box updates it once a week:

```sh
direnv exec . deploy-host --update
```

`--update` reads the commit that the host runs (`nixos-version --configuration-revision`), and builds that commit with `nixpkgs-host` at the head of `nixos-26.05`. The app, its Bun and its dependencies come from the locked `nixpkgs` input, so they stay as deployed, and a commit on `main` that is not deployed does not go live. The update needs no approval, because it changes no app code. It activates the new system and checks the health as a deploy does. If the kernel changed, it reboots the host and waits up to 5 minutes for `/api/health`. If nothing changed, it stops.

The dots side runs it from a systemd timer on the dev box, once a week at a quiet time (for example Tuesday 09:20 UTC), in `~/projects/agentsplit`, and reports a failure. The checkout's own state does not matter: `--update` builds from Git.

NixOS 26.05 ends its support at the end of December 2026. Before then, move `hostNixpkgs` in `flake.nix` and the `nixpkgs-host` input to the next release, run the VM test, and deploy.

## Backups

The host dumps the database every hour into `/var/backup/agentsplit/` and keeps 3 days. The user `agentsplit-backup` can read the dumps and nothing else: it has no database role. It pulls the newest dump this way:

```sh
ssh agentsplit-backup@agentsplit agentsplit-latest-dump > agentsplit.dump
```

`agentsplit-latest-dump` fails when the newest dump is older than 150 minutes, so a stopped timer fails the pull.

The nightly job `agentsplit-backup nixos` runs on the dev box from the dots flake (`devbox/bin/agentsplit-backup`, timer `agentsplit-backup.timer`). It pulls the newest dump from the host as `agentsplit-backup`, reads every receipt object from R2 with its own read-only R2 token, and writes both to `~/backups/agentsplit/<UTC date>/`. It restores the dump into a throwaway PostgreSQL to check it, and keeps 60 days. restic copies the home folder hourly. A failure writes an error to the log `agentsplit-backup`, and the alert "AgentSplit backup failed" watches it. A failed unit on the host writes a warning to the same log.

### Restore a dump on the host

1. Turn on the maintenance switch on the host.
2. Stop the server: `ssh root@agentsplit systemctl stop agentsplit`.
3. Make an empty database: `ssh root@agentsplit 'sudo -u postgres dropdb agentsplit && sudo -u postgres createdb --owner=agentsplit agentsplit'`. This deletes the host's data, so do it only with Freeman's approval and a verified backup.
4. Restore the dump into it as the server's role:

   ```sh
   ssh root@agentsplit 'sudo -u postgres pg_restore --no-owner --no-acl --role=agentsplit --exit-on-error --dbname=agentsplit' < ~/backups/agentsplit/<UTC date>/agentsplit.dump
   ```

5. Compare the counts of `groups`, `expenses`, `activities` and `expense_payers` on the host with the backup's log line.
6. Clear the maintenance switch, and start the server: `ssh root@agentsplit systemctl start agentsplit`.
7. Check `/api/health`, the home page, a sign-in, an old receipt, and an MCP write in the group **AgentSplit test**.

## First install

On GCE, the VM boots the host directly from an image of this flake, so nothing installs on the 1 GB machine. The image mounts the file systems by the labels `nixos` and `ESP`, as `nix/host/default.nix` does, and grows the root to the size of the boot disk at its first boot.

1. On the dev box, in a clean checkout of a pushed commit, build the image. The dev box needs x86_64 emulation (dots). The build VM runs the dev box's own QEMU (`agentsplit.imageBuildPackages` in `flake.nix`), so the image builds only on aarch64-linux, in about 3 minutes.

   ```sh
   direnv exec . nix build .#packages.x86_64-linux.agentsplit-gce-image
   ```

   The image is `result/agentsplit-gce.raw.tar.gz`: one sparse `disk.raw` of 8 GiB in a gzip tar, the form that `google_compute_image` (`raw_disk`) takes. It holds no secret.
2. The dots side uploads the file to a temporary GCS bucket, makes a custom image with the guest OS feature `UEFI_COMPATIBLE`, and creates the e2-micro from it: 30 GB pd-standard boot disk, Shielded VM with Secure Boot off (the GRUB of NixOS is not signed) and vTPM and integrity monitoring on, the network above, and a service account with no roles.
3. The dots side sets the instance metadata attribute `tailscale-auth-key` to a single-use auth key that is valid for ten minutes, from the dev box (`infra/bin/tailscale-auth-key`). Never put the key in OpenTofu, its state or a file.
4. At boot, `agentsplit-tailscale-join.service` sees that Tailscale needs a login, and reads `http://metadata.google.internal/computeMetadata/v1/instance/attributes/tailscale-auth-key` with the header `Metadata-Flavor: Google`. It polls with a growing pause up to 60 seconds until the attribute exists. Then it runs `tailscale up --auth-key=file:/dev/stdin --ssh --hostname=agentsplit --advertise-tags=tag:app --accept-dns=false` with the key on stdin. The key never goes to the disk or the journal. The unit stops once the node is logged in.
5. Under Tailnet Lock, sign the new node key on the dev box: `sudo tailscale lock sign nodekey:<key>`.
6. The dots side removes the `tailscale-auth-key` attribute. If the key expired before the join, set a new one; the unit still polls.
7. Check the access and record the host key once: `ssh -o StrictHostKeyChecking=accept-new root@agentsplit true`. Tailscale has already authenticated the machine, so the first key is safe to accept.
8. Copy `agentsplit.env`, `cloudflared.env` and `root-password-hash` ("Secrets on the host"). Set `AGENTSPLIT_MAINTENANCE=1` until the data is in. Then run `ssh root@agentsplit systemctl reset-failed agentsplit` and `ssh root@agentsplit systemctl restart agentsplit agentsplit-tunnel`. Without the files, the server failed five times at boot and hit its start limit (ten starts in ten minutes). The limit stays on purpose: it stops a crash loop on a quarter of a core and leaves a failed unit for the backup's check to report.
9. Run `direnv exec . deploy-host` ("Deploy"). It moves the host to the newest `nixos-26.05` and makes the commit the boot default.
10. Check that no unit failed: `ssh root@agentsplit systemctl --failed`.

If the join fails, read the boot on the serial port (`gcloud compute instances get-serial-port-output`). Before step 8 root has no password, so the interactive serial console does not log in; delete the VM and create it again from the image, because it holds no data yet. After step 8, the way in when Tailscale fails is the serial console, as root with the password in `secrets/agentsplit-host.yaml`.

On EC2 (`nixosConfigurations.agentsplit-ec2`, aarch64):

1. Create the instance from the official NixOS 26.05 aarch64 image, which writes the same labels, with no inbound rule, IMDSv2 only, and a 20 GB gp3 volume.
2. Join it to the tailnet as `agentsplit` with `--advertise-tags=tag:app --hostname=agentsplit --ssh --accept-dns=false`.
3. Copy the files (above), and run `HOST_CONFIG=agentsplit-ec2 direnv exec . deploy-host`. The first deploy stops the image's sshd, SSM agent and user-data service. The EC2 serial console is then the way in when Tailscale fails. The security group allows the same egress as on GCE; DNS goes to the VPC resolver and time to `169.254.169.123` (`nix/host/ec2.nix`).

On another provider:

1. Write a hardware profile for the provider (a copy of `nix/host/gce.nix` or `nix/host/ec2.nix` with its disk and network drivers and its console), and add a configuration with it to `flake.nix` (`mkHost`). If its disk is not `/dev/nvme0n1`, set `disko.devices.disk.main.device` in the profile.
2. Create a VM with UEFI, at least 1 GB of memory and a 20 GB disk, with any Linux and root SSH access from the dev box for the install only. nixos-anywhere boots an installer with kexec, which needs about 1 GB free; on a smaller VM, use the provider's image path as on GCE.
3. Put the secret files in a local folder at `etc/agentsplit/`, with a one-time Tailscale auth key from `infra/bin/tailscale-auth-key` in dots as `tailscale-auth-key`.
4. Run `nix run --inputs-from . nixpkgs#nixos-anywhere -- --flake .#<configuration> --extra-files <folder> root@<address>`.
5. Under Tailnet Lock, sign the new node key on the dev box: `sudo tailscale lock sign nodekey:<key>`.
6. Close the temporary SSH access, and delete `/etc/agentsplit/tailscale-auth-key` on the host.
7. Check that the modes of the files in `/etc/agentsplit/` are `0400`.

## Move to another cloud

R2 holds the receipts, and the tunnel does not depend on an address, so a move copies only the database. It takes about an hour. EC2 is the documented alternative (`agentsplit-ec2`, "First install"). Keep `BASE_URL` at `https://agentsplit.net`: the OAuth issuer, every agent's tokens, the session cookies and the Google redirect URI depend on it. A change of domain is a separate step with its own plan, because every agent must connect again and every person must sign in again.

## Domain

`BASE_URL` is `https://agentsplit.net` since 2026-11-09. Before that it was `https://agentsplit.freemanjiang.com`, which now answers a 308 to the same path on agentsplit.net, and `www.agentsplit.net` answers a 301 to the apex. The change made every person sign in again, because session cookies belong to one host, and every OAuth agent connect again, because the token audience is `<BASE_URL>/api/mcp`. API keys kept working once the agent used the new URL. The tunnel, DNS and redirect rules are in `infra/cloudflare` in dots.

1. Install the new VM as in "First install", with `AGENTSPLIT_MAINTENANCE=1`. Tailscale names it `agentsplit-1` while the old host exists, so give that name to each command, for example `HOST_CONFIG=agentsplit-ec2 deploy-host root@agentsplit-1`.
2. Get Freeman's approval, and turn on the maintenance switch on the old host.
3. Run `systemctl start agentsplit-db-dump` on the old host, and pull the dump.
4. Restore it on the new host, as in steps 2 to 5 of "Restore a dump on the host".
5. Stop the tunnel on the old host: `systemctl stop agentsplit-tunnel`. Two connectors of one tunnel share the traffic, so both hosts must never serve at the same time.
6. Clear the maintenance switch on the new host, and start its server.
7. Check the app as in step 7 of "Restore a dump on the host".
8. Delete the old VM after Freeman's approval, and rename the new node to `agentsplit` in Tailscale.

## Preview

There is no preview deployment. Freeman approved removing the Coolify preview on 2026-11-07. Review changes on a local dev server with synthetic data ("Dev server" in [docs/BUILDING.md](docs/BUILDING.md)).

## Previous hosting: Coolify (rollback only)

From 2026-11-05 to 2026-11-08, production ran on Coolify on the shared Oracle host, built from `compose.coolify.yaml` with the Docker Compose build pack. The stack stays in maintenance mode with its volumes until Freeman says otherwise, only for a rollback. Never delete a volume. The Coolify application ID and API address are in the maintainer's private infrastructure repository. Deploy it from the Coolify dashboard or the `coolify_oracle` MCP server.

The services of `compose.coolify.yaml`:

- `app`: the server, built from `Dockerfile`. Bun's distroless image runs the server bundle as user 65532 on port 3000. Coolify's Traefik ends TLS and routes the domain to it.
- `db2`: PostgreSQL 18 with the volume `postgres18-data`, network alias `agentsplit-db2`.
- `garage`: Garage v2.4.1 with the volumes `garage-meta` and `garage-data`, bucket `agentsplit-receipts`, network alias `agentsplit-garage`. Its Traefik labels route the authenticated S3 API at `agentsplit-receipts.freemanjiang.com`, which `scripts/copy-receipts.ts` uses.
- `db`: the PostgreSQL 17 of the app before v2, with the volume `postgres-data`. Freeman approved the removal of the service for 2026-11-13. The volume stays.

The app reaches `db2` and Garage only by the unique aliases, because on Coolify's shared `coolify` network a plain service name can resolve to another stack. Coolify keeps `/etc/garage.toml` as a file storage of this resource; a new resource would get a directory there, and Garage would not start. All images are pinned by digest.

On Coolify, the Compose file builds `DATABASE_URL` from `DB2_PASSWORD`, and sets the receipt bucket to Garage ("Receipts on R2" above). Leave `RECEIPT_DOWNLOADS` empty there, because browsers cannot reach Garage. `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `STORAGE_HOST`, `MCP_ACCESS_GRANTS`, `AUTH_BOOTSTRAP_LEGACY_USER_ID` and `BETTER_AUTH_TELEMETRY` stay in the Coolify resource for the stack and for older rollbacks; the app does not read the last four.

### Roll back to Coolify

1. Get Freeman's approval.
2. Turn on the maintenance switch on the host.
3. If the host took writes, carry them back: run `systemctl start agentsplit-db-dump` on the host, pull `agentsplit-latest-dump`, restore it into `db2` on Coolify with `pg_restore --clean --if-exists --no-owner --no-acl`, and run `scripts/copy-receipts.ts` from R2 to Garage. Give it the keys as the environment variables `SOURCE_S3_KEY`, `SOURCE_S3_SECRET`, `TARGET_S3_KEY` and `TARGET_S3_SECRET`, for example with `sops exec-env`. Never type them on a command line.

   ```sh
   SOURCE_S3_ENDPOINT=https://<account ID>.r2.cloudflarestorage.com SOURCE_S3_REGION=auto SOURCE_S3_BUCKET=agentsplit-receipts \
   TARGET_S3_ENDPOINT=https://agentsplit-receipts.freemanjiang.com TARGET_S3_REGION=garage TARGET_S3_BUCKET=agentsplit-receipts \
   bun scripts/copy-receipts.ts
   ```

   Then run it again with `--check`. It must report every object.
4. Point the production hostname back at Oracle (the dots side).
5. Clear `AGENTSPLIT_MAINTENANCE` on the Coolify application, and deploy.
6. Check `/api/health`, the home page, a sign-in, an old receipt, and an MCP write in the group **AgentSplit test**.

A rollback past v2, to the app before 2026-11-05, is in the Git history of this file (before the move to the NixOS host).
