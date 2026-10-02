import { cached } from '@/app/cached-functions'
import { requireWebGroup } from '@/lib/session'
import { Metadata } from 'next'
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
  return <GroupLayoutClient groupId={groupId}>{children}</GroupLayoutClient>
}
