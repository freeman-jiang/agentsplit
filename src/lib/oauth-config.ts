/** OAuth grants are an additional ceiling; live membership/roles still apply. */
export const OAUTH_READ_SCOPE = 'agentsplit:read'
export const OAUTH_WRITE_SCOPE = 'agentsplit:write'
export const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  OAUTH_READ_SCOPE,
  OAUTH_WRITE_SCOPE,
]
export const OAUTH_CONNECTION_CLAIM = 'https://agentsplit.app/connection'
export function mcpResource() {
  return new URL('/api/mcp', process.env.BASE_URL!).href
}
export function oauthIssuer() {
  return new URL('/api/auth', process.env.BASE_URL!).href
}
export function oauthMetadataUrl() {
  return new URL(
    '/.well-known/oauth-protected-resource/api/mcp',
    process.env.BASE_URL!,
  ).href
}
export function oauthChallenge(
  status = 401,
  scopes: string[] = [OAUTH_READ_SCOPE],
  message = 'Authentication required',
) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'WWW-Authenticate': `Bearer resource_metadata="${oauthMetadataUrl()}", scope="${scopes.join(' ')}"${status === 403 ? ', error="insufficient_scope"' : ''}`,
      },
    },
  )
}

export function oauthWriteChallenge() {
  return `Bearer resource_metadata="${oauthMetadataUrl()}", scope="${OAUTH_READ_SCOPE} ${OAUTH_WRITE_SCOPE}", error="insufficient_scope", error_description="Write access requires your consent"`
}
