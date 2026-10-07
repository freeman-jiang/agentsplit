'use client'

import { Button } from '@/components/ui/button'
import { trpc } from '@/trpc/client'
import { useRouter } from 'next/navigation'

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter()
  const join = trpc.groups.access.useMutation({
    onSuccess: (result) => router.push(`/groups/${result.groupId}`),
  })
  return (
    <div className="space-y-4">
      <Button
        disabled={join.isPending}
        onClick={() =>
          join.mutate({
            action: 'join',
            shareUrl: new URL(`/invite/${token}`, window.location.origin).href,
          })
        }
      >
        {join.isPending ? 'Joining…' : 'Accept invitation'}
      </Button>
      {join.error && (
        <p role="alert" className="text-destructive">
          {join.error.message}
        </p>
      )}
    </div>
  )
}
