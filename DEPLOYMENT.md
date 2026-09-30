# AgentSplit on Coolify

Use `compose.coolify.yaml` for a new deployment. It contains the application,
PostgreSQL, and Garage, each with persistent data where needed. The existing
`compose.yaml` remains the upstream local-development setup.

The storage flow is unchanged from Spliit: the app signs an upload, the browser
sends a JPEG/PNG image directly to storage, and the expense saves its image URL.
Garage is S3-compatible. No additional application storage code is needed.

## Configuration

1. Create a Docker Compose resource from this repository and branch in Coolify.
   Select `/compose.coolify.yaml` as the Compose file.
2. Set the values listed in `coolify.env.example` in that resource's environment.
   `BASE_URL` must be the exact HTTPS app origin, without a trailing slash.
   `STORAGE_HOST` is a hostname only, such as `receipts.example.com`.
3. Generate independent secrets with `openssl rand -hex 32` for
   `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, and `S3_UPLOAD_SECRET`. The access
   key is `GK` followed by the output of `openssl rand -hex 16`.
   Store these only in Coolify; do not commit them or change them casually after
   initialization.
4. Point both app and storage hostnames to this server. Assign the app's HTTPS
   domain to the `app` service, using internal port 3000. Leave `garage`'s
   automatic Domains field empty: its explicit Traefik labels handle routing.
5. Build/deploy the stack. In the Garage service terminal, enable receipt reads:

   ```sh
   /garage bucket website --allow agentsplit-receipts
   ```

   Garage automatically initializes the single-node layout, bucket, and access
   key at startup. Website access is a separate, one-time configuration step.

6. Create a group and expense, attach a JPEG/PNG image, save it, and reopen it.
   Check that uploads succeed and the saved receipt URL still opens.

This configuration assumes Coolify's standard Traefik proxy, with entrypoint
`https`, certificate resolver `letsencrypt`, and external Docker network
`coolify`. Custom proxy installations need corresponding label/network changes.

## Why the storage proxy labels exist

Garage exposes authenticated S3 operations on port 3900 and anonymous image
reads through its website endpoint on port 3902. Spliit expects the durable
image URL to look like `https://storage-host/bucket/key`.

The labels preserve that URL: PUT/POST requests go unchanged to the S3 API;
GET/HEAD requests for receipt objects go to the website endpoint with the bucket
prefix removed and the bucket selected by Host. CORS permits the app's origin.
This is deployment configuration, not a custom application upload pipeline.

Receipt URLs grant read access to anyone who has the URL. Uploads still require
presigned requests, and directory listing is not enabled. Private,
account-authenticated receipts would require a different application read flow.

## Persistence and verification

Back up `postgres-data`, `garage-meta`, and `garage-data`. Single-node Garage has
no replication; a persistent volume is not a backup. Back up Garage's metadata
and data together. This Compose file creates a fresh PostgreSQL 17 database; it
does not migrate an existing `postgres-data` directory from another deployment.

Garage is pinned to v2.4.1 and PostgreSQL to 17.11-alpine, both with immutable
image digests. Container images have not been downloaded for this deployment.
Local dependency installation and application checks are recorded in
`INSTALL_REVIEW.md`. Compose configuration validation passed, but an actual
Garage upload/view/restart test on Coolify is still needed.

Attachments are enabled in this deployment. Analytics, Next.js/Prisma telemetry,
built-in AI features, and automatic third-party exchange rates remain disabled.
Changing `STORAGE_HOST` requires rebuilding the app image because Next.js bakes
the storage image/CSP allowlist at build time. Keep the storage hostname stable
to preserve previously saved receipt URLs.
