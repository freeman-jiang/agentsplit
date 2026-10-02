# AgentSplit on Coolify

Use `compose.coolify.yaml` for a new deployment. It contains the application,
PostgreSQL, and Garage, each with persistent data where needed. The existing
`compose.yaml` remains the upstream local-development setup.

Google sign-in, private groups, and user-owned API keys are described in [AUTH.md](AUTH.md).
Web receipts upload through an authenticated app endpoint; MCP receipt writes
prepare signed S3 uploads. Both use private Garage storage and authenticated
receipt downloads. Storage credentials never reach the browser or agent.

## Configuration

1. Create a Docker Compose resource from this repository and branch in Coolify.
   Select `/compose.coolify.yaml` as the Compose file.
   Enable **Preserve Repository During Deployment** so the repository-backed
   Garage configuration is available for its read-only file mount.
2. Set the values listed in `coolify.env.example` in that resource's environment.
   `BASE_URL` must be the exact HTTPS app origin, without a trailing slash.
   `STORAGE_HOST` is a hostname only, such as `receipts.example.com`.
   Mark the referenced Compose variables as available at build time as well as
   runtime: Compose validates the full definition during the build. Credentials
   are not declared as Dockerfile build arguments or copied into the image.
3. Generate independent secrets with `openssl rand -hex 32` for
   `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, and `S3_UPLOAD_SECRET`. The access
   key is `GK` followed by the output of `openssl rand -hex 16`.
   Store these only in Coolify; do not commit them or change them casually after
   initialization.
4. Point both app and storage hostnames to this server. Assign the app's HTTPS
   domain to the `app` service, using internal port 3000. Leave `garage`'s
   automatic Domains field empty: its explicit Traefik labels handle routing.
   The labels use the production app/storage domains literally so Coolify label
   escaping can remain enabled; update those labels if deploying at other domains.
5. Configure Google and `BETTER_AUTH_SECRET` as described in `AUTH.md`, then deploy.
   Garage automatically initializes the single-node layout, bucket, and key.
   Do not enable or route anonymous website access to the receipt bucket.
6. Sign in with the configured bootstrap Google email. Verify existing groups,
   create a test expense, attach an image, and verify it after saving. A signed-out
   request to the receipt URL must fail. Test the same group with an agent key.

This configuration assumes Coolify's standard Traefik proxy, with entrypoint
`https`, certificate resolver `letsencrypt`, and external Docker network
`coolify`. Custom proxy installations need corresponding label/network changes.

## Why the storage proxy labels exist

Garage's S3 API is exposed on port 3900 behind HTTPS. Traefik preserves the Host
and path used by signed MCP uploads. CORS permits only the app origin. The public
website endpoint on port 3902 is not routed. `/api/receipts` checks current group
membership before retrieving an object, including old audit attachments.

## Persistence and verification

Back up `postgres-data`, `garage-meta`, and `garage-data`. Single-node Garage has
no replication; a persistent volume is not a backup. Back up Garage's metadata
and data together. This Compose file creates a fresh PostgreSQL 17 database; it
does not migrate an existing `postgres-data` directory from another deployment.

Garage is pinned to v2.4.1 and PostgreSQL to 17.11-alpine, both with immutable
image digests. Node is pinned to 26.10.0-bookworm with an immutable digest; that
image includes OpenSSL, avoiding a separate live OS-package installation. The
build installs only the npm lockfile with scripts disabled, generates the Prisma
client explicitly, and reuses those production dependencies for migrations.
Local dependency installation and application checks are recorded in
`INSTALL_REVIEW.md`. The deployed application and Garage PNG upload/save/reopen
flow were verified on September 30, 2026; see `VERIFICATION.md` for evidence and
remaining checks, including service-restart persistence.

Attachments are enabled in this deployment. Analytics, Next.js/Prisma telemetry,
built-in AI features, and automatic third-party exchange rates remain disabled.
Changing `STORAGE_HOST` requires rebuilding the app image because Next.js bakes
the storage image/CSP allowlist at build time. Keep the storage hostname stable
to preserve previously saved receipt URLs.

The standard AWS SDK setting `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED`
avoids signing a checksum for an empty body before the browser sends the receipt.
The application uses its existing upload library and does not proxy file uploads.
