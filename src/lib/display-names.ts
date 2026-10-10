import type { Prisma } from '@/generated/prisma/client'
import { prisma } from './prisma'

type NameReader = Pick<Prisma.TransactionClient, 'user' | 'userGroupAccess'>

export async function accountDisplayNames({
  userIds,
  db = prisma,
}: {
  userIds: string[]
  db?: NameReader
}) {
  if (!userIds.length) return new Map<string, string>()
  const users = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] }, emailVerified: true },
    select: { id: true, name: true },
  })
  return new Map(users.map((user) => [user.id, user.name]))
}

/** User.name is canonical after verification; Participant.name is a guest placeholder. */
export async function participantDisplayNames({
  participantIds,
  db = prisma,
}: {
  participantIds: string[]
  db?: NameReader
}) {
  if (!participantIds.length) return new Map<string, string>()
  const bindings = await db.userGroupAccess.findMany({
    where: { participantId: { in: [...new Set(participantIds)] } },
    select: { participantId: true, userId: true },
  })
  const names = await accountDisplayNames({
    userIds: bindings.map((binding) => binding.userId),
    db,
  })
  return new Map(
    bindings.flatMap((binding) => {
      const name = names.get(binding.userId)
      return binding.participantId && name !== undefined
        ? [[binding.participantId, name] as const]
        : []
    }),
  )
}

export async function currentParticipants<
  T extends { id: string; name: string },
>({ people, db = prisma }: { people: T[]; db?: NameReader }): Promise<T[]> {
  const names = await participantDisplayNames({
    participantIds: people.map((person) => person.id),
    db,
  })
  return people.map((person) => ({
    ...person,
    name: names.get(person.id) ?? person.name,
  }))
}
