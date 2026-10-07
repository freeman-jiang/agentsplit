import type { Prisma } from '@/generated/prisma/client'
import { TRPCError } from '@trpc/server'

export async function assertReceiptOwnership(
  tx: Prisma.TransactionClient,
  groupId: string,
  documents: { url: string }[],
) {
  for (const doc of documents)
    if (
      !(await tx.receiptObject.findUnique({
        where: { groupId_url: { groupId, url: doc.url } },
      }))
    )
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Attach only receipts uploaded to this group',
      })
}
