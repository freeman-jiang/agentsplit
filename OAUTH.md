# MCP OAuth connections

AgentSplit remains a self-hosted Better Auth application with Google login. It now also acts as an OAuth authorization server for clients such as ChatGPT. Google authenticates the person; AgentSplit issues its own resource-bound tokens. Google access tokens, refresh tokens and passwords are never forwarded to the agent.

## Connect ChatGPT

1. On ChatGPT web, open **Plugins → Add → Add custom MCP server**.
2. Name it **AgentSplit**, use `https://agentsplit.freemanjiang.com/api/mcp`, and select **OAuth**. Discovery supplies the endpoints and client identity; do not paste an AgentSplit API key or a Google secret.
3. Connect, sign in to AgentSplit through Google if needed, and review the consent screen. Leave changes enabled for read/write tools, or uncheck changes for read-only access.
4. Use the same ChatGPT account on other supported ChatGPT surfaces. A cloud-linked personal MCP connection is different from a desktop-only local MCP configuration. Actual availability on web, desktop and mobile must be verified in those clients; server OAuth support alone does not prove every client surface works.
5. Revoke the connection in AgentSplit **Account settings → Connected apps**. API keys remain independent and continue to work for Codex, scripts and automation.

ChatGPT's public client metadata currently uses `https://chatgpt.com/oauth/client.json`, signed `private_key_jwt` client authentication and `https://chatgpt.com/connector_platform_oauth_redirect`. Let discovery determine the actual client identity and callback mode; do not hardcode a transient builder callback ID.

## Contracts

- Protected resource: `<BASE_URL>/api/mcp`.
- Issuer: `<BASE_URL>/api/auth`.
- Protected resource metadata: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`.
- Authorization-server metadata: `/.well-known/oauth-authorization-server/api/auth`; OpenID discovery is also handled by the provider at its issuer path.
- Authorization, token and revocation: `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke`.
- JWKS: `/api/auth/jwks`; signing keys persist encrypted in PostgreSQL through the official JWT plugin.
- Authorization code + S256 PKCE; refresh tokens rotate. Access tokens last five minutes; refresh tokens default to 30 days. The MCP provider permits an identical refresh retry for 30 seconds to recover a lost rotation response.
- DPoP-bound tokens are also verified by the official helper, including proof binding and replay protection.
- CIMD uses Better Auth's Node transport with public-address validation, DNS pinning and no redirects. Dynamic client registration and machine-to-machine/client-credentials grants are disabled. Managed/predefined clients and public or signed clients remain supported by the provider.
- `agentsplit:read` is required for private ledger reads, exports and receipt reads. Mutations additionally require `agentsplit:write`. `openid`, `profile`, `email` and `offline_access` have their standard meanings and are explained on consent.
- Scopes are a ceiling on existing live user memberships and roles, not an alternative permission system. They do not grant access to another user's groups. API keys retain their existing permissions and require no rotation.
- Tool declarations advertise OAuth scopes in `securitySchemes` and the compatibility `_meta` mirror. A tool denied write scope returns `isError` with `_meta["mcp/www_authenticate"]`; endpoint-wide missing/invalid credentials return an HTTP challenge. Existing legacy and modern MCP transports remain supported.

## Revocation and attribution

Better Auth owns protocol validation, codes, token issuance, refresh, client authentication and signing. Its JWT verifier checks issuer, audience, signature, expiry and token scopes. AgentSplit additionally checks the current verified account, client status, active connection, current consent and current memberships. This also applies to UserInfo and private download/export routes.

`OauthConnection` records the provider's original hashed authorization-code identifier. Refresh rotation preserves that identifier, so the connection is stable across refreshes. Revocation retains a tombstone and removes the provider's consent/refresh records; reconnecting cannot revive an old access token. Settings revocation and provider consent deletion revoke the user's client connections. A successful standard refresh-token revocation also invalidates its corresponding access-token grant. The provider itself does not support revoking self-contained JWT values through RFC 7009; use the refresh token or Connected apps.

OAuth calls map to the same stable User ID as Google sessions and API keys. Audit source remains `agent`; the existing `agentKeyId` field records `oauth:<connection-id>` for OAuth calls. Claimed payers and beneficiaries remain distinct from authenticated creators/editors. Financial writes recheck delegated write permission in the shared backend.

Receipt download URLs and HTTP JSON/CSV exports accept the same OAuth bearer token as MCP. MCP upload/finalization stays part of expense writes and requires write access. No receipt becomes public. A client fetching a private receipt must forward its authorization header to the AgentSplit download URL; ChatGPT-specific automatic image fetching is not assumed to do this. `export_group` returns authorized content directly through MCP.

## Deployment and testing

The reviewed additions are `@better-auth/mcp`, `@better-auth/cimd`, and `@better-auth/oauth-provider` 1.7.6. See `OAUTH_INSTALL_REVIEW.md`. No new hosted service, Google OAuth client, public ledger route or API-key migration is required. Existing Google callback, Better Auth secret and BASE_URL are reused.

The migration adds provider tables, persistent signing keys and connection records only. It does not rewrite ledger, identity, receipt, invitation or audit records. Back up the scoped production database and compare those existing tables after rollout.

`bun scripts/test-mcp-oauth.ts` runs a fresh mock agent against real local HTTP routes and a disposable PostgreSQL database. It tests discovery, sign-in context, consent/denial, PKCE, public and signed client authentication, token constraints, refresh, scope ceilings, membership changes, revocation, exports and API-key compatibility. Google upstream responses are mocked only inside the test process for a complete callback-to-consent handoff; no production bypass is added.

`e2e/mcp-oauth.spec.ts` exercises the actual consent and connection-management UI, then exchanges the returned code as a mock agent and calls MCP with its tokens. Existing Payments, People, revision-log, custom-URL and API-key tests remain regression coverage. All automated accounts and mutations are isolated from production ledger data.

Sources: [Better Auth MCP](https://better-auth.com/docs/plugins/mcp), [OAuth provider](https://better-auth.com/docs/plugins/oauth-provider), [CIMD](https://better-auth.com/docs/plugins/cimd), [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth).
