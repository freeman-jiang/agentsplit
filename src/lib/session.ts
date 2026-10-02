import { TRPCError } from '@trpc/server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { getAuth } from './auth'
import { bootstrapOwner } from './auth-bootstrap'
import type { AuditActor } from './expense-history'
import { effectiveGroupIds } from './group-access'
import { prisma } from './prisma'

export async function sessionPrincipal(
  requestHeaders: Headers,
): Promise<(AuditActor & { groupIds: string[]; email: string }) | undefined> {
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session?.user.emailVerified) return undefined
  await bootstrapOwner(session.user)
  return {
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    connectionId: '',
    source: 'web',
    groupIds: await effectiveGroupIds(session.user.id),
  }
}
export async function requireWebUser() {
  const principal = await sessionPrincipal(await headers())
  if (!principal) redirect('/sign-in')
  return principal
}
export async function requireWebGroup(groupId: string, admin = false) {
  const principal = await requireWebUser()
  const membership = await prisma.userGroupAccess.findUnique({
    where: { userId_groupId: { userId: principal.userId, groupId } },
  })
  if (!membership?.active || (admin && membership.role !== 'admin'))
    redirect('/groups?access=denied')
  return principal
}
export async function authorizeGroupRequest(request: Request, groupId: string) {
  const principal = request.headers.has('authorization')
    ? await (
        await import('./mcp/authenticate')
      )
        .authenticateMcp(request)
        .then((result) =>
          'principal' in result ? result.principal : undefined,
        )
    : await sessionPrincipal(request.headers)
  if (!principal)
    return Response.json(
      { error: 'Sign in required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  if (!principal.groupIds.includes(groupId))
    return Response.json(
      { error: 'Group access denied' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    )
  return principal
}
export function requirePrincipal<T extends AuditActor>(
  principal: T | undefined,
): T {
  if (!principal)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required' })
  return principal
}

/** Request-scoped session for server-rendered public/account navigation. */
export const getWebSession = cache(async () => {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  return session?.user.emailVerified ? session : null
})
