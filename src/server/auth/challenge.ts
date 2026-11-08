// OAuth discovery and challenges for the MCP resource: the protected-resource
// metadata and the 401 and 403 WWW-Authenticate challenges.
import { MCP_PATH } from '../../shared/mcp'
import { jsonError } from '../core/errors'
import { OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE } from '../../shared/account'
import { mcpResource, oauthIssuer } from './constants'

/**
 * The scopes every challenge asks for. MCP clients take the scope from the
 * challenge first. The current app asked for read only and never for
 * offline_access, so Claude Code got a read-only token that died after five
 * minutes (docs/history/v2/OAUTH-CLAUDE-CODE.md). The consent page still lets the user
 * refuse write access.
 */
const CHALLENGE_SCOPES = [OAUTH_READ_SCOPE, OAUTH_WRITE_SCOPE, 'offline_access'] as const

/** Better Auth's DPOP_SIGNING_ALGORITHMS, copied so this route loads no auth code (test/db/mcp-auth.test.ts pins it). */
export const DPOP_ALGORITHMS = ['EdDSA', 'ES256', 'ES512', 'PS256', 'RS256'] as const

const METADATA_PATH = '/.well-known/oauth-protected-resource'

const metadataUrl = (baseUrl: string) => new URL(`${METADATA_PATH}${MCP_PATH}`, baseUrl).href

/** The two RFC 9728 paths: the root form and the form with the resource path. */
export const METADATA_PATHS = new Set([METADATA_PATH, `${METADATA_PATH}${MCP_PATH}`])

/**
 * RFC 9728 protected-resource metadata, as Better Auth's MCP plugin builds it,
 * plus offline_access in scopes_supported. The plugin filters offline_access
 * out of this document, so the server serves it instead.
 */
export function protectedResourceMetadata(request: Request, baseUrl: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  const body = JSON.stringify({
    resource: mcpResource(baseUrl),
    authorization_servers: [oauthIssuer(baseUrl)],
    bearer_methods_supported: ['header'],
    dpop_signing_alg_values_supported: [...DPOP_ALGORITHMS],
    scopes_supported: [...CHALLENGE_SCOPES],
  })
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400' }
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
}

/**
 * The 401 challenge (no or bad credentials) and the 403 step-up challenge
 * (a valid token without a scope the call needs). Both name the metadata URL,
 * so every challenge has one format (docs/history/v2/DECISIONS.md, P-MCP-79).
 */
export function challenge(data: { baseUrl: string; status?: 401 | 403; message?: string }): Response {
  const status = data.status ?? 401
  const value = `Bearer resource_metadata="${metadataUrl(data.baseUrl)}", scope="${CHALLENGE_SCOPES.join(' ')}"${status === 403 ? ', error="insufficient_scope"' : ''}`
  return jsonError({
    status,
    message: data.message ?? (status === 403 ? 'Write access requires your consent' : 'Authentication required'),
    headers: { 'WWW-Authenticate': value },
  })
}
