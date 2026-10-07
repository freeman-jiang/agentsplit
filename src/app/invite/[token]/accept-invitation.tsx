'use client'

import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { trpc } from '@/trpc/client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function SwitchInvitationAccount({ token }: { token: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError('')
          try {
            const result = await authClient.signOut()
            if (result.error)
              throw new Error('Unable to sign out. Please try again.')
            window.location.assign(
              `/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`,
            )
          } catch {
            setPending(false)
            setError('Unable to sign out. Please try again.')
          }
        }}
      >
        {pending ? 'Signing out…' : 'Use a different Google account'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

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
