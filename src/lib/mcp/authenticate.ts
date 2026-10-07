import { readApiKey } from '@/lib/api-key-header'
import { getAuth } from '@/lib/auth'
import { effectiveGroupIds } from '@/lib/group-access'
import { oauthChallenge } from '@/lib/oauth-config'
import { prisma } from '@/lib/prisma'
import type { McpPrincipal } from './access'
import { authenticateOAuth } from './oauth-authenticate'

export async function authenticateMcp(
  request: Request,
): Promise<{ principal: McpPrincipal } | { response: Response }> {
  const deny = (status: number, message: string) => ({
    response: Response.json(
      { error: message },
      {
        status,
        headers: {
          'Cache-Control': 'no-store',
          ...(status === 401
            ? { 'WWW-Authenticate': 'Bearer realm="AgentSplit MCP"' }
            : {}),
        },
      },
    ),
  })
  const expected = new URL(process.env.BASE_URL || request.url)
  if (
    (request.headers.get('host') ?? new URL(request.url).host) !==
      expected.host ||
    (request.headers.get('origin') &&
      request.headers.get('origin') !== expected.origin)
  )
    return deny(403, 'Origin or host is not allowed')
  if (!process.env.BASE_URL)
    return deny(503, 'Authentication is not configured')
  const authorization = request.headers.get('authorization')
  if (
    !request.headers.has('x-api-key') &&
    /^DPoP [^\s,]{32,16384}$/i.test(authorization ?? '')
  ) {
    try {
      return await authenticateOAuth(request)
    } catch {
      return deny(503, 'Authentication is temporarily unavailable')
    }
  }
  const key = readApiKey(request.headers)
  if (!key || key.length < 32 || key.length > 4096)
    return { response: oauthChallenge() }
  try {
    // Issued API keys are opaque. OAuth access JWTs use the compact three-part form.
    if (!request.headers.has('x-api-key') && key.split('.').length === 3)
      return await authenticateOAuth(request)
    const verified = await getAuth().api.verifyApiKey({ body: { key } })
    if (!verified.valid || !verified.key) {
      if (request.headers.has('x-api-key'))
        return { response: oauthChallenge() }
      return await authenticateOAuth(request)
    }
    const user = await prisma.user.findUnique({
      where: { id: verified.key.referenceId },
    })
    if (!user?.emailVerified) return deny(401, 'Authentication required')
    return {
      principal: {
        id: verified.key.id,
        userId: user.id,
        name: user.name,
        groupIds: await effectiveGroupIds(user.id),
      },
    }
  } catch {
    return deny(503, 'Authentication is temporarily unavailable')
  }
}
