import { readApiKey } from '@/lib/api-key-header'
import { getAuth } from '@/lib/auth'
import { effectiveGroupIds } from '@/lib/group-access'
import { prisma } from '@/lib/prisma'
import type { McpPrincipal } from './access'

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
  const key = readApiKey(request.headers)
  if (!key || key.length < 32 || key.length > 4096)
    return deny(401, 'Authentication required')
  try {
    const verified = await getAuth().api.verifyApiKey({ body: { key } })
    if (!verified.valid || !verified.key)
      return deny(401, 'Authentication required')
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
