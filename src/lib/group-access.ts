import { createHash, randomBytes } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { withGroupWrite, type AuditActor } from './expense-history'
import { prisma } from './prisma'
import { randomId } from './random'

export async function effectiveGroupIds(
  userId: string,
  _legacyBootstrap: string[] = [],
): Promise<string[]> {
  return (
    await prisma.userGroupAccess.findMany({
      where: { userId, active: true },
      orderBy: [{ createdAt: 'asc' }, { groupId: 'asc' }],
    })
  ).map((row) => row.groupId)
}
const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex')
export const groupAccessInput = z
  .strictObject({
    action: z.enum([
      'join',
      'leave',
      'invite',
      'revoke_invitation',
      'remove_member',
      'set_role',
    ]),
    groupId: z.string().min(1).max(64).optional(),
    shareUrl: z
      .url()
      .max(2000)
      .optional()
      .describe('For join: the email-bound invitation URL, not a group URL.'),
    email: z.email().max(254).optional(),
    invitationId: z.string().max(64).optional(),
    userId: z.string().max(128).optional(),
    role: z.enum(['admin', 'member']).optional(),
  })
  .superRefine((input, ctx) => {
    const required =
      input.action === 'join'
        ? ['shareUrl']
        : [
            'groupId',
            ...(input.action === 'invite'
              ? ['email']
              : input.action === 'revoke_invitation'
                ? ['invitationId']
                : input.action === 'remove_member'
                  ? ['userId']
                  : input.action === 'set_role'
                    ? ['userId', 'role']
                    : []),
          ]
    for (const field of required)
      if (!input[field as keyof typeof input])
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is required`,
        })
  })

export async function groupMembers(groupId: string, userId: string) {
  const access = await prisma.userGroupAccess.findUnique({
    where: { userId_groupId: { userId, groupId } },
  })
  if (!access?.active)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Group access denied' })
  const memberships = await prisma.userGroupAccess.findMany({
    where: { groupId, active: true },
  })
  const users = await prisma.user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
    select: { id: true, name: true, email: true },
  })
  const invitations =
    access.role === 'admin'
      ? await prisma.groupInvitation.findMany({
          where: {
            groupId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true, email: true, expiresAt: true },
        })
      : []
  return {
    role: access.role,
    members: memberships.flatMap((m) => {
      const u = users.find((u) => u.id === m.userId)
      return u ? [{ ...u, role: m.role }] : []
    }),
    invitations,
  }
}

export async function changeGroupAccess(
  actor: AuditActor,
  input: z.infer<typeof groupAccessInput>,
  baseUrl: string,
) {
  let groupId = input.groupId
  let token: string | undefined
  if (input.action === 'join') {
    const url = new URL(input.shareUrl!)
    const match = url.pathname.match(/^\/invite\/([A-Za-z0-9_-]{43})$/)
    if (
      url.origin !== new URL(baseUrl).origin ||
      url.username ||
      url.password ||
      !match
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Use an email-bound invitation link from this app. A group URL does not grant access.',
      })
    token = match[1]
    const invitation = await prisma.groupInvitation.findUnique({
      where: { tokenHash: tokenHash(token) },
    })
    if (!invitation)
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Invitation not found or no longer valid',
      })
    groupId = invitation.groupId
  }
  if (!groupId)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'groupId is required' })
  const targetId = groupId
  return withGroupWrite(targetId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: actor.userId } })
    if (!user?.emailVerified)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'A verified account is required',
      })
    const membership = await tx.userGroupAccess.findUnique({
      where: { userId_groupId: { userId: actor.userId, groupId: targetId } },
    })
    if (input.action === 'join') {
      const invitation = await tx.groupInvitation.findUnique({
        where: { tokenHash: tokenHash(token!) },
      })
      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.expiresAt <= new Date() ||
        invitation.email !== user.email.toLowerCase()
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'This invitation is expired, revoked, or addressed to a different email',
        })
      if (invitation.acceptedAt) {
        if (membership?.active) return { groupId: targetId, joined: true }
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Invitation already used',
        })
      }
      await tx.groupInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      })
      await tx.userGroupAccess.upsert({
        where: { userId_groupId: { userId: actor.userId, groupId: targetId } },
        create: { userId: actor.userId, groupId: targetId, role: 'member' },
        update: {
          active: true,
          role: membership?.active ? membership.role : 'member',
        },
      })
    } else {
      if (!membership?.active)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Group access denied',
        })
      if (input.action !== 'leave' && membership.role !== 'admin')
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only group admins can manage access',
        })
      if (input.action === 'invite') {
        const secret = randomBytes(32).toString('base64url')
        const invitation = await tx.groupInvitation.create({
          data: {
            id: randomId(),
            groupId: targetId,
            email: input.email!.trim().toLowerCase(),
            tokenHash: tokenHash(secret),
            createdBy: actor.userId,
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        })
        await log('Invitation created', invitation.email)
        return {
          groupId: targetId,
          joined: true,
          invitation: {
            id: invitation.id,
            email: invitation.email,
            expiresAt: invitation.expiresAt.toISOString(),
            url: new URL(`/invite/${secret}`, baseUrl).href,
          },
        }
      }
      if (input.action === 'revoke_invitation') {
        const result = await tx.groupInvitation.updateMany({
          where: {
            id: input.invitationId,
            groupId: targetId,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        })
        if (!result.count)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Pending invitation not found',
          })
      } else {
        const targetUser =
          input.action === 'leave' ? actor.userId : input.userId!
        const target = await tx.userGroupAccess.findUnique({
          where: { userId_groupId: { userId: targetUser, groupId: targetId } },
        })
        if (!target?.active)
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Member not found',
          })
        if (
          target.role === 'admin' &&
          (input.action !== 'set_role' || input.role !== 'admin')
        ) {
          if (
            (await tx.userGroupAccess.count({
              where: { groupId: targetId, active: true, role: 'admin' },
            })) <= 1
          )
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'Choose another admin before removing or demoting the last admin',
            })
        }
        await tx.userGroupAccess.update({
          where: { userId_groupId: { userId: targetUser, groupId: targetId } },
          data:
            input.action === 'set_role'
              ? { role: input.role }
              : { active: false },
        })
      }
    }
    await log(input.action, input.userId ?? actor.userId)
    return { groupId: targetId, joined: input.action !== 'leave' }
    async function log(action: string, target: string) {
      await tx.activity.create({
        data: {
          id: randomId(),
          groupId: targetId,
          activityType:
            input.action === 'join'
              ? 'JOIN_GROUP'
              : input.action === 'leave'
                ? 'LEAVE_GROUP'
                : 'UPDATE_GROUP',
          data: `${action}: ${target}`,
          actorUserId: actor.userId,
          actorName: user!.name,
          agentKeyId: actor.connectionId || null,
          source: actor.source ?? 'agent',
        },
      })
    }
  })
}
