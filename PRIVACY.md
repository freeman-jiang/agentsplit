# AgentSplit privacy profile

The deployment uses one Next.js/React application, its tRPC endpoints, and a
PostgreSQL database accessed through Prisma. Coolify can build the Dockerfile and
route HTTPS to port 3000. The Coolify stack adds Garage on the same server for
receipt image attachments. Vercel, Spliit's public instance, OpenAI, and AWS are
not required. Group links grant access without accounts; keep them private.

## Disabled paths

- Analytics configuration always returns no providers, regardless of environment
  settings. Plausible, Umami, and console tracking are not enabled by the app.
- `NEXT_TELEMETRY_DISABLED=1` disables Next.js telemetry in the Docker build,
  runtime, and package scripts. `CHECKPOINT_DISABLE=1` disables Prisma CLI
  checkpoint reporting during generation, installation scripts, and migrations.
  For direct CLI invocations outside these scripts, export both variables first.
- Currency labels no longer load country flags from `flagcdn.com`.
- Exchange-rate requests to Frankfurter are disabled. Cross-currency expenses
  use a manually entered conversion rate; the API toggle is hidden.
- Built-in receipt extraction and category inference remain disabled in server
  feature flags. Leave OpenAI credentials unset.
- The browser content security policy allows connections and images only from
  this instance and the configured storage origin, plus local data/blob images.
  External links can still be opened intentionally. The storage allowlist is
  baked into the image and requires a rebuild when its hostname changes.

OpenAI features previously sent receipt images or expense titles to a configured
AI provider. S3 storage is restored using the original upstream upload flow,
with a self-hosted Garage endpoint. It stores JPEG/PNG expense attachments,
without sending them to an AI provider or an external storage company.

## Receipt access

Uploads use presigned S3 requests; write credentials stay on the application
server. The Coolify proxy serves image reads from Garage's website endpoint.
Anyone with an image URL can view that image, just as anyone with a group link
can access that group. The website endpoint has no directory listing. Receipt
URLs should be treated as private sharing links, not account-authenticated files.
Garage's administration API and RPC ports are not published.

The attachment UI and upload implementation are unchanged from upstream. There
is no custom application storage proxy, SDK wrapper, or new npm dependency.

## Verification boundary

This is a source/configuration audit of the checked-out fork, not a packet capture
of a running deployment or an audit of every transitive dependency. Container
builds still contact image registries, Alpine mirrors, npm, and Prisma engine
download servers to obtain software. The browser policy does not restrict server
egress. A deployment firewall allowing only the database and storage would provide stronger
runtime enforcement; it has not been configured here.

The native iOS client, Coolify itself, the host, and any agent or model provider
connecting to a future MCP endpoint have separate privacy behavior and were not
covered by this application audit. Data intentionally supplied to a remote agent
is processed by that agent's provider.

This profile does not improve the upstream activity feed into an immutable audit
log, add account authentication, or make expense creation safe against duplicate
retries. Those are separate items to address when building authenticated MCP
write tools.
