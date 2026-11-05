# The Claude Code OAuth bug

Krish reported that connecting Claude Code to AgentSplit with OAuth does not work. This document records the reproduction, the causes, and the fix that v2 must make.

## Reproduction (2026-11-05)

The flow ran against a local copy of the current app (a restore of the 2026-11-05 production dump, `next build` standalone server), emulating Claude Code 2.1.314 step by step. Claude Code uses its Client ID Metadata Document, `https://claude.ai/oauth/claude-code-client-metadata`, which registers `http://localhost/callback` and `http://127.0.0.1/callback`. It listens on a random loopback port, uses PKCE with S256, and sends the resource indicator. Discovery on production was also checked with read-only requests and matches the local copy.

| Step | Result |
| --- | --- |
| Unauthenticated `POST /api/mcp` | 401, `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp", scope="agentsplit:read"` |
| Discovery | Protected-resource metadata and authorization-server metadata (RFC 8414 path) answer; CIMD is supported |
| Authorize, consent, token | Work: the CIMD client loads, the loopback port matches, and consent returns a code |
| Token, with the challenge's scope | `scope: "agentsplit:read"`, `expires_in: 300`, **no refresh token** |
| A write tool with that token | HTTP **200** with the step-up challenge inside the JSON-RPC result (`_meta["mcp/www_authenticate"]`) |
| Token, with the metadata's `scopes_supported` | `scope: "agentsplit:read agentsplit:write"`; writes work, but still no refresh token |

## Causes

1. **The 401 challenge asks for read only, and never for `offline_access`.** MCP clients take the scope from the challenge first. Claude Code therefore gets a read-only access token that expires after 5 minutes with no refresh token, so the connection stops working after 5 minutes. `scopes_supported` in the protected-resource metadata also omits `offline_access`.
2. **Write step-up is not an HTTP response.** A write with a read-only token answers HTTP 200 and puts the `insufficient_scope` challenge in the JSON-RPC result metadata. MCP clients re-authorize only on an HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, so Claude Code never asks for write access.

## Fix for v2

1. The 401 challenge asks for `agentsplit:read agentsplit:write offline_access`, and the protected-resource metadata lists `offline_access` in `scopes_supported`. The consent page still shows what the agent asks for, and the user still decides.
2. A request that needs a scope the token lacks answers HTTP 403 with `WWW-Authenticate: Bearer resource_metadata="…", scope="agentsplit:read agentsplit:write offline_access", error="insufficient_scope"`, before the JSON-RPC call runs.
3. Refresh tokens stay hashed (`hashOAuthToken`) and rotate as today.
4. Verify with a real Claude Code client against the preview Worker: connect, read, write, and keep working after the access token expires (more than 5 minutes later, through a refresh).
