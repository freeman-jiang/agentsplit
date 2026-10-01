'use client'

import { GroupTabs } from '@/app/groups/[groupId]/group-tabs'
import { ShareButton } from '@/app/groups/[groupId]/share-button'
import { Skeleton } from '@/components/ui/skeleton'
import Link from 'next/link'
import { useCurrentGroup } from './current-group-context'

export const GroupHeader = () => {
  const { isLoading, groupId, group } = useCurrentGroup()

  return (
    <div className="flex flex-col justify-between gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="min-w-0 text-base font-medium">
          <Link href={`/groups/${groupId}`}>
            {isLoading ? (
              <Skeleton className="mt-1.5 mb-1.5 h-5 w-32" />
            ) : (
              <span className="break-words">{group.name}</span>
            )}
          </Link>
        </h1>
        {group && <ShareButton group={group} />}
      </div>

      <div className="flex gap-2 justify-between">
        <GroupTabs groupId={groupId} />
      </div>
    </div>
  )
}
