import { createHash, randomBytes } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  assertOAuthWriteAccess,
  withGroupWrite,
  type AuditActor,
} from './expense-history'
import { prisma } from './prisma'
import { randomId } from './random'
import { renewPrivateInvitation } from './ungrouped-expenses'

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
      'renew_invitation',
      'revoke_invitation',
      'remove_member',
      'set_role',
      'bind_member',
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
    participantId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'The existing participant to invite or bind. A membership identity cannot later be switched.',
      ),
    role: z.enum(['admin', 'member']).optional(),
  })
  .superRefine((input, ctx) => {
    const required =
      input.action === 'join'
        ? ['shareUrl']
        : [
            'groupId',
            ...(input.action === 'renew_invitation'
              ? ['participantId']
              : input.action === 'invite'
                ? ['email', 'participantId']
                : input.action === 'bind_member'
                  ? ['userId', 'email', 'participantId']
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
  const privateContext = await prisma.ungroupedExpense.findUnique({
    where: { groupId },
  })
  const invitations =
    access.role === 'admin'
      ? await prisma.groupInvitation.findMany({
          where: {
            groupId,
            acceptedAt: null,
            revokedAt: null,
            ...(privateContext ? {} : { expiresAt: { gt: new Date() } }),
          },
          select: {
            id: true,
            email: true,
            expiresAt: true,
            participantId: true,
            participantName: true,
          },
        })
      : []
  return {
    role: access.role,
    participantId: access.participantId,
    reservedParticipantIds: (
      await prisma.participant.findMany({
        where: {
          groupId,
          OR: [{ memberships: { some: {} } }, { invitations: { some: {} } }],
        },
        select: { id: true },
      })
    ).map((p) => p.id),
    members: memberships.flatMap((m) => {
      const u = users.find((u) => u.id === m.userId)
      return u ? [{ ...u, role: m.role, participantId: m.participantId }] : []
    }),
    invitations,
  }
}

export async function changeGroupAccess(
  actor: AuditActor,
  input: z.infer<typeof groupAccessInput>,
  baseUrl: string,
) {
  if (input.action === 'renew_invitation') {
    const invitation = await renewPrivateInvitation({
      actor,
      groupId: input.groupId!,
      participantId: input.participantId!,
      baseUrl,
    })
    return { groupId: input.groupId!, joined: true, invitation }
  }
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
    await assertOAuthWriteAccess(tx, actor)
    const user = await tx.user.findUnique({ where: { id: actor.userId } })
    if (!user?.emailVerified)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'A verified account is required',
      })
    const membership = await tx.userGroupAccess.findUnique({
      where: { userId_groupId: { userId: actor.userId, groupId: targetId } },
    })
    const privateContext = await tx.ungroupedExpense.findUnique({
      where: { groupId: targetId },
      include: { people: true },
    })
    if (privateContext && ['invite', 'bind_member'].includes(input.action)) {
      const person = privateContext.people.find(
        (p) => p.participantId === input.participantId,
      )
      if (!person || person.email !== input.email?.trim().toLowerCase()) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the original people may access this private expense.',
        })
      }
    }
    if (
      privateContext &&
      ['remove_member', 'set_role'].includes(input.action)
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Private expense membership cannot be reassigned.',
      })
    }
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
      if (!invitation.participantId)
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'This older invitation has no participant identity. Ask an admin to issue a new invitation.',
        })
      if (
        membership?.participantId &&
        membership.participantId !== invitation.participantId
      )
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'Your account is already tied to another participant in this group.',
        })
      const claimed = await tx.userGroupAccess.findFirst({
        where: {
          groupId: targetId,
          participantId: invitation.participantId,
          userId: { not: actor.userId },
        },
      })
      if (claimed)
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This participant is already tied to another account.',
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
        create: {
          userId: actor.userId,
          groupId: targetId,
          role: 'member',
          participantId: invitation.participantId,
        },
        update: {
          active: true,
          participantId: invitation.participantId,
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
      if (input.action === 'bind_member' || input.action === 'invite') {
        const participant = await tx.participant.findFirst({
          where: { id: input.participantId!, groupId: targetId },
        })
        if (!participant)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Choose a participant in this group.',
          })
        const email = input.email!.trim().toLowerCase()
        const targetUser = await tx.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
        })
        const targetAccess = targetUser
          ? await tx.userGroupAccess.findUnique({
              where: {
                userId_groupId: { userId: targetUser.id, groupId: targetId },
              },
            })
          : null
        if (
          targetAccess?.participantId &&
          targetAccess.participantId !== participant.id
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That account is already tied to a different participant.',
          })
        const claimed = await tx.userGroupAccess.findFirst({
          where: { groupId: targetId, participantId: participant.id },
        })
        if (claimed && claimed.userId !== targetUser?.id)
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'That participant is already tied to another account.',
          })
        const pending = await tx.groupInvitation.findFirst({
          where: {
            groupId: targetId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
            OR: [{ email }, { participantId: participant.id }],
          },
        })
        if (pending)
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'An invitation already reserves this email or participant. Revoke it before making another.',
          })
        if (input.action === 'bind_member') {
          if (
            !targetUser?.emailVerified ||
            targetUser.id !== input.userId ||
            !targetAccess?.active
          )
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'The verified email must match the existing member account.',
            })
          if (targetAccess.participantId)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'This member already has a fixed identity.',
            })
          await tx.userGroupAccess.update({
            where: {
              userId_groupId: { groupId: targetId, userId: targetUser.id },
            },
            data: { participantId: participant.id },
          })
          await log(
            'Member identity bound',
            `${targetUser.id} / ${email} / ${participant.id} / ${participant.name}`,
          )
          return { groupId: targetId, joined: true }
        }
        if (targetAccess?.active)
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'That account is already a member. Bind its identity in member settings if needed.',
          })
      }
      if (input.action === 'invite') {
        const participant = await tx.participant.findUniqueOrThrow({
          where: { id: input.participantId! },
        })
        const secret = randomBytes(32).toString('base64url')
        const invitation = await tx.groupInvitation.create({
          data: {
            id: randomId(),
            groupId: targetId,
            email: input.email!.trim().toLowerCase(),
            participantId: participant.id,
            participantName: participant.name,
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
            participantId: invitation.participantId!,
            participantName: invitation.participantName!,
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
