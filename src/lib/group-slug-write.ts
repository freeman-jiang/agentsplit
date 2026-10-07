import type { Prisma } from '@/generated/prisma/client'
import { TRPCError } from '@trpc/server'

export async function claimGroupSlug(
  tx: Prisma.TransactionClient,
  slug: string | null | undefined,
  groupId: string,
) {
  if (!slug) return
  // Serialize competing claims, including creates, before the unique-index write.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${slug}, 0))::text`
  const existing = await tx.group.findUnique({
    where: { slug },
    select: { id: true },
  })
  if (existing && existing.id !== groupId)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'This group URL is already in use.',
    })
}
