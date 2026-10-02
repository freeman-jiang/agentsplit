'use client'

import { GroupForm } from '@/components/group-form'
import { trpc } from '@/trpc/client'
import { useCurrentGroup } from '../current-group-context'
import { GroupMembers } from '../members'

export const EditGroup = () => {
  const { groupId } = useCurrentGroup()
  const { data, isLoading } = trpc.groups.getDetails.useQuery({ groupId })
  const { mutateAsync } = trpc.groups.update.useMutation()
  const utils = trpc.useUtils()

  if (isLoading) return <></>

  return (
    <div className="space-y-8">
      {data?.access.role === 'admin' && (
        <GroupForm
          group={data?.group}
          onSubmit={async (groupFormValues, participantId) => {
            await mutateAsync({
              groupId,
              participantId,
              groupFormValues,
              expectedRevision: data?.group.revision,
            })
            await utils.groups.invalidate()
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
