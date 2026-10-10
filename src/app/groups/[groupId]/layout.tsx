import { cached } from '@/app/cached-functions'
import { prisma } from '@/lib/prisma'
import { requireWebGroup } from '@/lib/session'
import { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { PropsWithChildren } from 'react'
import { GroupLayoutClient } from './layout.client'

type Props = {
  params: Promise<{
    groupId: string
  }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { groupId } = await params
  const group = await cached.getGroup(groupId)

  return {
    title: {
      default: group?.name ?? '',
      template: `%s · ${group?.name} · AgentSplit`,
    },
  }
}

export default async function GroupLayout({
  children,
  params,
}: PropsWithChildren<Props>) {
  const { groupId } = await params
  await requireWebGroup(groupId)
  const privateContext = await prisma.ungroupedExpense.findUnique({
    where: { groupId },
  })
  if (privateContext) redirect(`/expenses/${privateContext.expenseId}`)
  return <GroupLayoutClient groupId={groupId}>{children}</GroupLayoutClient>
}
