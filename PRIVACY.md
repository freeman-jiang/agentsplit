# AgentSplit privacy profile

AgentSplit runs Next.js/React, shared tRPC/MCP procedures, PostgreSQL/Prisma and
Garage on the operator's infrastructure. Google is used only for account
sign-in (`openid`, `email`, `profile`). It does not receive expense data through
this integration. Account/session/provider records are stored in PostgreSQL.

## Disabled external features

Analytics, external flag images, automatic exchange-rate lookups, and built-in
OpenAI receipt/category extraction remain disabled. Money stays in its own
currency, with no conversion API. Next.js telemetry and Prisma checkpoint
reporting are disabled in build/runtime scripts. Better Auth telemetry is
explicitly disabled. No external email service is used: admins copy invitation
links and send them themselves.

The browser CSP restricts connections/images to the instance, configured
storage origin, and local data/blob images. Google sign-in uses navigation to
Google. Build-time package/image registry access remains necessary. This is a
source/configuration statement, not a packet-capture audit of all dependencies.

## Accounts and receipts

Every group read/write requires active membership. A share URL alone grants no
access. Google-verified email-bound invitations expire and can be revoked.
Agent keys are hashed, owned by users, and inherit live membership and roles.
Keys cannot establish browser sessions or create more keys. Web/API writes record
the authenticated actor, independent of payer and balance-view selections.

Garage is private. Browser receipts upload through the authenticated app;
MCP requests signed staging uploads through expense writes and finalizes them
after content validation. Permanent objects are not issued write URLs. Receipt
reads check membership through `/api/receipts`; the old anonymous website route
and unauthenticated upload-signing endpoint are disabled. The service worker
caches static application assets only, never private pages/API responses/receipts.

## Retention and limits

Expense create/edit/delete operations produce append-only revision snapshots.
Deletion hides an expense but keeps its history and receipt references. Membership
changes preserve bookkeeping identities and history. Database triggers protect
history against ordinary application updates/deletes, not a privileged database
administrator or loss of the host. PostgreSQL and Garage require off-host backups
for disaster recovery; this deployment does not provide those automatically.

Connected agent providers process the data you authorize them to retrieve. Keep
API keys in private client configuration, never in prompts or group notes.
The instance operator, Coolify, Google, and external agent providers have their
own administrative access and privacy boundaries. See [AUTH.md](AUTH.md) and the
public `/privacy` page for the account flow and current user-facing explanation.
