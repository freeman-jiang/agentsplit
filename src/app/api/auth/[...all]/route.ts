import { getAuth } from '@/lib/auth'
import { authenticateOAuth } from '@/lib/mcp/oauth-authenticate'
import { hashOAuthToken, revokeOAuthConnection } from '@/lib/oauth-connections'
import { prisma } from '@/lib/prisma'
import { sessionPrincipal } from '@/lib/session'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request) {
  try {
    const path = new URL(request.url).pathname
    // UserInfo shares the same revocation boundary as the private MCP resource.
    if (path.endsWith('/oauth2/userinfo')) {
      const result = await authenticateOAuth(request)
      if ('response' in result) return result.response
    }
    let consentOwner: { userId: string; clientId: string } | undefined
    if (request.method === 'POST' && path.endsWith('/oauth2/delete-consent')) {
      const input = z.object({ id: z.string() }).safeParse(
        await request
          .clone()
          .json()
          .catch(() => null),
      )
      const user = input.success
        ? await sessionPrincipal(request.headers)
        : undefined
      const consent =
        input.success && user
          ? await prisma.oauthConsent.findFirst({
              where: { id: input.data.id, userId: user.userId },
            })
          : null
      if (consent?.userId)
        consentOwner = { userId: consent.userId, clientId: consent.clientId }
    }
    // The provider authenticates and performs RFC 7009 revocation first. Only
    // an actual active-to-revoked transition invalidates the corresponding JWT grant.
    const token =
      request.method === 'POST' && path.endsWith('/oauth2/revoke')
        ? new URLSearchParams(await request.clone().text()).get('token')
        : null
    const refresh = token
      ? await prisma.oauthRefreshToken.findUnique({
          where: { token: hashOAuthToken(token) },
        })
      : null
    const response = await getAuth().handler(request)
    if (response.ok && consentOwner)
      await revokeOAuthConnection(consentOwner.userId, consentOwner.clientId)
    if (
      response.ok &&
      refresh &&
      !refresh.revoked &&
      refresh.authorizationCodeId
    ) {
      const after = await prisma.oauthRefreshToken.findUnique({
        where: { id: refresh.id },
      })
      if (after?.revoked)
        await prisma.oauthConnection.updateMany({
          where: {
            authorizationCodeId: refresh.authorizationCodeId,
            userId: refresh.userId,
            clientId: refresh.clientId,
          },
          data: { revokedAt: new Date() },
        })
    }
    return response
  } catch {
    return Response.json(
      { error: 'Sign-in is temporarily unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
export { handle as GET, handle as POST }
