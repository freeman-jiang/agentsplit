'use client'

import { GroupForm } from '@/components/group-form'
import { groupPath } from '@/lib/group-slug'
import { trpc } from '@/trpc/client'
import { useRouter } from 'next/navigation'
import { useCurrentGroup } from '../current-group-context'
import { GroupMembers } from '../members'

export const EditGroup = () => {
  const { groupId } = useCurrentGroup()
  const { data, isLoading } = trpc.groups.getDetails.useQuery({ groupId })
  const { mutateAsync } = trpc.groups.update.useMutation()
  const utils = trpc.useUtils()
  const router = useRouter()

  if (isLoading) return <></>

  return (
    <div className="space-y-8">
      {data?.access.role === 'admin' && (
        <GroupForm
          group={data?.group}
          showParticipants={false}
          onSubmit={async (groupFormValues, participantId) => {
            const result = await mutateAsync({
              groupId,
              participantId,
              groupFormValues: {
                name: groupFormValues.name,
                slug: groupFormValues.slug,
                information: groupFormValues.information,
                currency: groupFormValues.currency,
                currencyCode: groupFormValues.currencyCode,
              },
              expectedRevision: data?.group.revision,
            })
            await utils.groups.invalidate()
            router.replace(`${groupPath(result.group)}/edit`)
          }}
          fixedParticipantIds={data?.access.reservedParticipantIds}
          protectedParticipantIds={[
            ...(data?.participantsWithExpenses ?? []),
            ...(data?.access.reservedParticipantIds ?? []),
          ]}
        />
      )}
      <GroupMembers groupId={groupId} />
    </div>
  )
}
