import { TRPCError } from '@trpc/server'
import { withGroupWrite, type AuditActor } from './expense-history'
import { prisma } from './prisma'
import { randomId } from './random'

/** Persisted grants extend bootstrap access; explicit leave overrides it. */
export async function effectiveGroupIds(
  userId: string,
  bootstrap: string[],
): Promise<string[]> {
  const rows = await prisma.userGroupAccess.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { groupId: 'asc' }],
  })
  const removed = new Set(
    rows.filter((row) => !row.active).map((row) => row.groupId),
  )
  return [
    ...new Set([
      ...bootstrap,
      ...rows.filter((row) => row.active).map((row) => row.groupId),
    ]),
  ].filter((id) => !removed.has(id))
}

export async function changeGroupAccess(
  actor: AuditActor,
  input: { action: 'join' | 'leave'; shareUrl?: string; groupId?: string },
  baseUrl: string,
) {
  let groupId = input.groupId
  if (input.action === 'join') {
    let url: URL
    try {
      url = new URL(input.shareUrl ?? '')
    } catch {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Provide this app’s group share URL',
      })
    }
    const match = url.pathname.match(/^\/groups\/([A-Za-z0-9_-]{21})(?:\/.*)?$/)
    if (
      url.origin !== new URL(baseUrl).origin ||
      url.username ||
      url.password ||
      !match
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Provide this app’s group share URL',
      })
    groupId = match[1]
  }
  if (!groupId)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'groupId is required to leave',
    })
  const targetId = groupId
  return withGroupWrite(targetId, async (tx) => {
    const group = await tx.group.findUnique({
      where: { id: targetId },
      select: { id: true },
    })
    if (!group)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
    const prior = await tx.userGroupAccess.findUnique({
      where: { userId_groupId: { userId: actor.userId, groupId: targetId } },
    })
    const active = input.action === 'join'
    await tx.userGroupAccess.upsert({
      where: { userId_groupId: { userId: actor.userId, groupId: targetId } },
      create: { userId: actor.userId, groupId: targetId, active },
      update: { active },
    })
    if (!prior || prior.active !== active)
      await tx.activity.create({
        data: {
          id: randomId(),
          groupId: targetId,
          activityType: active ? 'JOIN_GROUP' : 'LEAVE_GROUP',
          actorUserId: actor.userId,
          actorName: actor.userId,
          agentKeyId: actor.connectionId,
          source: 'agent',
        },
      })
    return { groupId: targetId, joined: active }
  })
}
