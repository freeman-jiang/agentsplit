# AgentSplit privacy profile

AgentSplit v2 runs a Bun server, PostgreSQL and Garage on the operator's Coolify host. Google is used only for account sign-in (`openid`, `email`, `profile`). It does not receive expense data through this integration.

## What is stored

| Data | Contents |
| --- | --- |
| Accounts | Name, email, verified-email status and profile image from Google; the Google account link; sessions. |
| Groups | Name, slug, currency, participants, memberships with roles and participant bindings, and invitations (email, hashed token, expiry). |
| Expenses | Title, vendor, notes, amounts, payers, splits, category, dates, recurrence, and the receipt references. |
| Receipts | The JPEG and PNG images that people and agents attach. |
| Activity history | One immutable snapshot per expense revision, group changes, and the authenticated actor of each change: account, name, source (web or agent) and agent key or connection ID. |
| Agent connections | Hashed API keys; OAuth clients, consents, connections and hashed tokens; the JWT signing keys, encrypted with `BETTER_AUTH_SECRET`; rate-limit counters. |

## Where

- PostgreSQL 18 (`db2`) on the Oracle host holds everything except the receipt images.
- Garage on the same host holds the receipt images, in the bucket `agentsplit-receipts`.
- The old app's PostgreSQL (`db`) on the same host still holds the data as it was at the cutover on 2026-11-05, for a rollback.
- The nightly backup copies a database dump and every receipt object to the dev box (`~/backups/agentsplit/`), where restic backs it up. The job is being changed to dump `db2`; until then it does not back up v2 (DEPLOYMENT.md).

## Who can see what

- Every group read and write requires active membership. The server checks it for the web app and for agents. A share URL alone grants no access.
- Members can see the group's ledger, receipts, activity history, and the other members' names and email addresses. Admins also see pending invitations and manage membership.
- An ungrouped expense is private to its original participants. Only they can see the expense, its receipts, its history and its repayments. It does not appear in the group list.
- Invitations are bound to a Google-verified email, expire after 7 days, are single-use, and can be revoked. AgentSplit sends no email: admins copy invitation links and send them themselves.
- API keys are hashed, owned by users, and act with the owner's live memberships and roles. Keys cannot open browser sessions or create more keys.
- An OAuth connection gets only the scopes that the user allowed: `agentsplit:read` reads, `agentsplit:write` changes. The user can revoke a connection on `/settings/connections`.
- Web and agent writes record the authenticated actor, independent of the payer and of who the balance view is for.

## Receipts

- Garage is private. The anonymous website endpoint is not routed, and the old unauthenticated upload-signing endpoint (`/api/s3-upload`) answers 410.
- Receipts are served only through the authenticated `/api/receipts`. It checks membership before it reads storage, on every request. It accepts a browser session, an API key or an OAuth token.
- Browsers upload through the authenticated app, from the app's own origin only.
- Agents upload through a single-use target URL on the app that expires after 300 seconds. The server checks the real image format and size before it attaches the image. No URL can write over a stored receipt.
- Storage credentials never reach the browser or the agent.

## Retention

- No expense is ever hard-deleted. A deleted expense leaves current views and balances, but its revisions and receipt references stay in the history.
- The activity history is append-only. Database triggers reject updates and deletes of it. They protect against ordinary application changes, not against a privileged database administrator or the loss of the host.
- Leaving or removing a member keeps their bookkeeping identity and history.
- A revoked API key is deleted. A revoked OAuth connection keeps a revoked marker; its tokens and consent are deleted.
- Unattached agent uploads are deleted after 25 hours.
- v2 has no function to delete an account. Ask the operator about access, retention or deletion requests.
- Local backups are kept for 60 days; restic keeps older copies.

## External services and browser

- v2 has no analytics, no exchange-rate lookups and no AI receipt or category features. Money stays in its own currency, with no conversion API. Better Auth telemetry is off.
- The CSP allows scripts, styles, connections and images only from the instance, plus `data:` and `blob:` images. Google sign-in uses navigation to Google.
- A session cookie keeps people signed in. Local browser storage holds display preferences.
- The service worker caches static application assets only, never private pages, API responses or receipts.
- Building the image needs access to package and image registries. This document describes the source and the configuration. It is not a packet-capture audit of every dependency.

## Limits

Connected agent providers process the data that a user authorizes them to read. Keep API keys in private client configuration, never in prompts or group notes. The operator, Coolify, Google and agent providers each have their own administrative access and privacy rules. See [AUTH.md](AUTH.md) for the account flow.
