# Accounts, API keys and OAuth

AgentSplit v2 uses self-hosted Better Auth with Google as the only identity provider. PostgreSQL (`db2`) stores accounts, sessions, memberships, invitations, hashed API keys and OAuth data. No hosted auth vendor or email service is used. Better Auth telemetry is off. The code is in `v2/src/server/auth.ts`, `auth-options.ts`, `session.ts`, `account.ts` and `mcp/`.

## Google sign-in

- Google sign-in asks only for `openid`, `email` and `profile`. Account linking is off.
- The Google client is a Google Auth Platform **Web application** client. Its redirect URI is `https://<app host>/api/auth/callback/google`. The domain did not change at the cutover, so the redirect URI did not change.
- The server needs `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `BETTER_AUTH_SECRET` (at least 32 characters). Without them, sign-in answers "Google sign-in is not configured". Set them only in Coolify (DEPLOYMENT.md).
- Only a verified Google email gives access. A session of an unverified account is refused.
- The sign-in page keeps the requested page in `next`. The server accepts only same-origin callback paths, so a link such as `/\evil.example` is refused.
- Better Auth rate-limits its own routes, with the counters in PostgreSQL.
- A daily cap limits new accounts: at most 200 created in 24 hours, or `SIGN_UP_DAILY_LIMIT` (DEPLOYMENT.md). It runs only when an account is created, so existing accounts always sign in. When the cap is reached, the sign-in page says so. Concurrent sign-ups at the cap can pass it by a few.

## Sessions

- A session lasts 7 days and is refreshed once a day. The cookie is `__Secure-better-auth.session_token` on HTTPS, signed with `BETTER_AUTH_SECRET`.
- The RPC, export and receipt routes check the signed cookie and read the session in one query (`session.ts`). Better Auth refreshes the session through `/api/auth/get-session`, which the app calls once per load.
- An RPC `POST` from another origin gets 403.
- Sign-out deletes the session row.

## Owner bootstrap

`AUTH_BOOTSTRAP_EMAIL` names the verified Google email that may claim the groups created before accounts existed (`legacy_group_claims`). When that person signs in, the server makes them admin of those groups, once. The `auth_bootstrap` row stops a second run, also after memberships are removed later. A bootstrap failure is logged and does not block sign-in.

Production ran the bootstrap in the old app. The import copied the `auth_bootstrap` row and the API keys that the old bootstrap made from `MCP_ACCESS_GRANTS`, so v2 does not run it again. v2 does not read `MCP_ACCESS_GRANTS` or `AUTH_BOOTSTRAP_LEGACY_USER_ID`.

## Groups and invitations

- The creator of a group becomes its admin and a participant with their account name.
- An admin invites a person by Google email for an existing participant. The link is single-use, expires after 7 days, and is stored as a hash. Only a session with that verified email can accept it. AgentSplit sends no email; the admin sends the link.
- Members read and change expenses and record payments. Admins also edit group settings, invite, revoke invitations, remove members and change roles.
- Each member is bound to one participant per group. Personal balances come from that binding. An admin binds an existing unbound member once, explicitly; names never decide a binding.
- A group URL alone grants no access. The server checks membership on every read and write, for the web app and for agents.

## API keys

- A signed-in user creates and revokes keys on `/settings` (Account & keys). The key starts with `agentsplit_`, has no expiry, and is shown once. The database stores only its hash.
- A key acts as its owner, with the owner's current memberships and roles. Removing a membership affects every key at once.
- A key cannot create another key and cannot open a browser session.
- A key allows 120 requests in 60 seconds. MCP also applies a per-user limit (MCP.md).
- A user can revoke only their own keys. A revoked key gets 401 at once.
- An account can have at most 10 keys, a fair-use limit. Revoke one to create another.

## OAuth for agents

Better Auth's OAuth provider issues tokens for the MCP endpoint (`/api/mcp`). The issuer is `<BASE_URL>/api/auth`.

- **Discovery.** `/.well-known/oauth-protected-resource/api/mcp` gives the protected-resource metadata, with `scopes_supported` `agentsplit:read agentsplit:write offline_access`. Better Auth serves the authorization-server metadata.
- **Client registration.** A client registers through its Client ID Metadata Document (CIMD), as Claude Code and ChatGPT do. The server fetches the document only from public addresses, refuses redirects, and limits it to 64 KiB and 5 seconds. Older clients can use dynamic client registration, without an account, at most 20 times per IP address per hour. Registration alone grants no access.
- **Authorization.** Authorization code with PKCE and refresh tokens. The consent page (`/settings/connections/consent`) shows the client and the scopes. Clearing **Allow changes** grants `agentsplit:read` only.
- **Tokens.** Access tokens are signed JWTs that live 300 seconds. With `offline_access`, the client gets a refresh token that lives 30 days and rotates. The database stores every token as `base64url(sha256(token))`. A token can be bound to a DPoP key; a DPoP proof works once and must match the request URL.
- **Connections.** Each authorization creates one connection, and each access token names it. Every request checks that the connection, the account, the client and the consent are still live.
- **Revocation.** `/settings/connections` lists the connected apps. Revoking one marks its connections revoked and deletes its access tokens, refresh tokens and consent. Old access tokens and racing refreshes then fail, and the client must connect again. API keys are not affected.

## Tokens issued before the cutover

The import copied users, Google accounts, sessions, hashed API keys, OAuth clients, consents, refresh tokens, connections and the `jwks` signing keys. The `jwks` keys are encrypted with `BETTER_AUTH_SECRET`, and v2 uses the same production secret. So session cookies, API keys and OAuth tokens issued before the cutover keep working, and agents did not need to connect again.

If `BETTER_AUTH_SECRET` changes, every session cookie and every issued token stops working, and the signing keys must be generated again.

## Limits

Google identity proves control of a Google account, not a legal identity. The operator has administrative access to the database and the receipts (PRIVACY.md).
