import { revokeOAuthConnection } from '@/lib/oauth-connections'
import { sessionPrincipal } from '@/lib/session'
import { z } from 'zod'

export const runtime = 'nodejs'
export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store' }
  if (request.headers.get('origin') !== new URL(process.env.BASE_URL!).origin)
    return Response.json(
      { error: 'Origin not allowed' },
      { status: 403, headers },
    )
  const user = await sessionPrincipal(request.headers)
  if (!user)
    return Response.json(
      { error: 'Sign in required' },
      { status: 401, headers },
    )
  const input = z
    .strictObject({ clientId: z.string().min(1).max(2048) })
    .safeParse(await request.json().catch(() => null))
  if (!input.success)
    return Response.json(
      { error: 'Client identity is required' },
      { status: 400, headers },
    )
  await revokeOAuthConnection(user.userId, input.data.clientId)
  return Response.json({ revoked: true }, { headers })
}
