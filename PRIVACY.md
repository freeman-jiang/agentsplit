# AgentSplit privacy profile

The deployment uses one Next.js/React application, its tRPC endpoints, and a
PostgreSQL database accessed through Prisma. Coolify can build the Dockerfile and
route HTTPS to port 3000. Vercel, Spliit's public instance, OpenAI, and AWS are not
required. Group links grant access without accounts; keep them private.

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
- Receipt extraction, category inference, and expense uploads are disabled in
  server feature flags. The S3 upload endpoint returns 403 without calling S3.
  Leave OpenAI and S3 credentials unset.
- The browser content security policy allows connections and images only from
  this instance, plus local data/blob images. External links can still be opened
  intentionally.

OpenAI features previously sent receipt images or expense titles to a configured
AI provider. S3 previously stored expense attachments in AWS or compatible
storage. These are optional product features, rather than telemetry. Removing
them does not prevent normal expense entry, balances, or manual conversion.

## Verification boundary

This is a source/configuration audit of the checked-out fork, not a packet capture
of a running deployment or an audit of every transitive dependency. Container
builds still contact image registries, Alpine mirrors, npm, and Prisma engine
download servers to obtain software. The browser policy does not restrict server
egress. A deployment firewall allowing only the database would provide stronger
runtime enforcement; it has not been configured here.

The native iOS client, Coolify itself, the host, and any agent or model provider
connecting to a future MCP endpoint have separate privacy behavior and were not
covered by this application audit. Data intentionally supplied to a remote agent
is processed by that agent's provider.

This profile does not improve the upstream activity feed into an immutable audit
log, add account authentication, or make expense creation safe against duplicate
retries. Those are separate items to address when building authenticated MCP
write tools.
