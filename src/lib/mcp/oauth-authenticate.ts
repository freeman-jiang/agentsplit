import { getAuth } from '@/lib/auth'
import { effectiveGroupIds } from '@/lib/group-access'
import {
  mcpResource,
  OAUTH_CONNECTION_CLAIM,
  OAUTH_READ_SCOPE,
  oauthChallenge,
  oauthIssuer,
} from '@/lib/oauth-config'
import { prisma } from '@/lib/prisma'
import { requireMcpAuth } from '@better-auth/mcp'
import type { McpPrincipal } from './access'

export async function authenticateOAuth(
  request: Request,
): Promise<{ principal: McpPrincipal } | { response: Response }> {
  let principal: McpPrincipal | undefined
  const response = await requireMcpAuth(
    getAuth(),
    async (_request, claims) => {
      const connectionId = claims[OAUTH_CONNECTION_CLAIM]
      if (
        typeof connectionId !== 'string' ||
        typeof claims.sub !== 'string' ||
        typeof claims.client_id !== 'string' ||
        typeof claims.scope !== 'string'
      )
        return oauthChallenge()
      const [connection, user, client, consent] = await Promise.all([
        prisma.oauthConnection.findUnique({ where: { id: connectionId } }),
        prisma.user.findUnique({ where: { id: claims.sub } }),
        prisma.oauthClient.findUnique({
          where: { clientId: claims.client_id },
        }),
        prisma.oauthConsent.findFirst({
          where: { userId: claims.sub, clientId: claims.client_id },
        }),
      ])
      if (
        !connection ||
        connection.revokedAt ||
        connection.userId !== claims.sub ||
        connection.clientId !== claims.client_id ||
        !user?.emailVerified ||
        !client ||
        client.disabled ||
        !consent
      )
        return oauthChallenge()
      const scopes = claims.scope
        .split(' ')
        .filter((s) => s && consent.scopes.includes(s))
      if (!scopes.includes(OAUTH_READ_SCOPE))
        return oauthChallenge(
          403,
          [OAUTH_READ_SCOPE],
          'Read permission is no longer granted',
        )
      if (!scopes.every((s) => connection.scopes.includes(s)))
        return oauthChallenge()
      principal = {
        id: `oauth:${connection.id}`,
        oauthConnectionId: connection.id,
        userId: user.id,
        name: user.name,
        scopes,
        groupIds: await effectiveGroupIds(user.id),
      }
      return new Response(null, { status: 204 })
    },
    {
      resource: mcpResource(),
      issuer: oauthIssuer(),
      requiredScopes: [OAUTH_READ_SCOPE],
    },
  )(request)
  response.headers.set('Cache-Control', 'no-store')
  return principal ? { principal } : { response }
}
