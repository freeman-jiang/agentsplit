# MCP OAuth connections

AgentSplit remains a self-hosted Better Auth application with Google login. It now also acts as an OAuth authorization server for clients such as ChatGPT. Google authenticates the person; AgentSplit issues its own resource-bound tokens. Google access tokens, refresh tokens and passwords are never forwarded to the agent.

## Connect ChatGPT

1. On ChatGPT web, open **Plugins → Add → Add custom MCP server**.
2. Name it **AgentSplit**, use `https://agentsplit.freemanjiang.com/api/mcp`, and select **OAuth**. In Advanced OAuth settings, use the discovered **CIMD** registration method and set **Base scopes** to `offline_access` so the connection can refresh. Discovery supplies the endpoints and client identity; do not paste an AgentSplit API key or a Google secret.
3. Connect, sign in to AgentSplit through Google if needed, and review the consent screen. Leave changes enabled for read/write tools, or uncheck changes for read-only access.
4. Use the same ChatGPT account on other supported ChatGPT surfaces. A cloud-linked personal MCP connection is different from a desktop-only local MCP configuration. Actual availability on web, desktop and mobile must be verified in those clients; server OAuth support alone does not prove every client surface works.
5. Revoke the connection in AgentSplit **Account settings → Connected apps**. API keys remain independent and continue to work for Codex, scripts and automation.

ChatGPT's public client metadata currently uses `https://chatgpt.com/oauth/client.json`, signed `private_key_jwt` client authentication and `https://chatgpt.com/connector_platform_oauth_redirect`. Let discovery determine the actual client identity and callback mode; do not hardcode a transient builder callback ID.

## Claude and other MCP clients

Add `https://agentsplit.freemanjiang.com/api/mcp` as a remote MCP server and choose OAuth. For Claude, choose its published identity when offered; CIMD is preferred, and automatic registration (DCR) is also available. There is no need to create a Google OAuth client or manually provision a client ID for these paths. Clients that explicitly require preconfigured credentials can use an RFC 7591 registration to obtain a client ID and, for confidential clients, a secret; keep that secret in the client's private configuration.

Claude selects CIMD when discovery advertises both `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`. AgentSplit advertises both. Native clients can register localhost or IP-loopback callbacks with `application_type: native`; the provider accepts ephemeral callback ports. Web clients use HTTPS callbacks.

You can start by connecting an agent: first Google sign-in creates the AgentSplit account, then consent authorizes the connection. Accept an email-bound group invitation before or after connecting; current memberships take effect without reconnecting. The agent can also accept the invitation through `manage_group_access` with the user's authorization.

Compatibility targets the standard MCP authorization-code/PKCE and refresh flows. This does not promise obsolete implicit/password grants or every vendor-specific OAuth extension. Mock-agent tests cover public and confidential DCR clients, native loopback callbacks, predefined clients and signed assertions. A real Claude account consent/token exchange is still unverified.

## Contracts

- Protected resource: `<BASE_URL>/api/mcp`.
- Issuer: `<BASE_URL>/api/auth`.
- Protected resource metadata: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/api/mcp`.
- Authorization-server metadata: `/.well-known/oauth-authorization-server/api/auth`; OpenID discovery is also handled by the provider at its issuer path.
- Authorization, token and revocation: `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`, `/api/auth/oauth2/revoke`.
- JWKS: `/api/auth/jwks`; signing keys persist encrypted in PostgreSQL through the official JWT plugin.
- Authorization code + S256 PKCE; refresh tokens rotate. Access tokens last five minutes; refresh tokens default to 30 days. The MCP provider permits an identical refresh retry for 30 seconds to recover a lost rotation response.
- DPoP-bound tokens are also verified by the official helper, including proof binding and replay protection.
- CIMD uses Better Auth's Node transport with public-address validation, DNS pinning and no redirects. Dynamic client registration is also enabled at `/api/auth/oauth2/register` for clients without CIMD, with the provider's default limit of five registration requests per minute per IP. Registration accepts standard RFC 7591 metadata and automatically binds clients to the MCP resource; no proprietary `resources` field is required. Public (`none`), confidential (`client_secret_basic` and `client_secret_post`), and signed (`private_key_jwt`) clients are supported. User consent and S256 PKCE remain required; registration alone grants no user access. Machine-to-machine/client-credentials grants remain disabled.
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

Client references: [Claude connector authentication](https://claude.com/docs/connectors/building/authentication), [Claude connection setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
