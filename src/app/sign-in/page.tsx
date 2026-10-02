'use client'

import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'
import { useState } from 'react'

export default function SignInPage() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 space-y-6">
      <h1 className="font-display text-4xl">Welcome to AgentSplit</h1>
      <p className="text-muted-foreground">
        Sign in to access your private groups and connect your agents. We only
        use Google to verify your identity.
      </p>
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError('')
          const next = new URLSearchParams(window.location.search).get('next')
          const callbackURL =
            next?.startsWith('/') && !next.startsWith('//') ? next : '/groups'
          try {
            const result = await authClient.signIn.social({
              provider: 'google',
              callbackURL,
            })
            if (result.error) {
              setError(result.error.message ?? 'Sign-in failed')
              setPending(false)
            }
          } catch {
            setError('Unable to start sign-in. Please try again.')
            setPending(false)
          }
        }}
      >
        {pending ? 'Opening Google…' : 'Continue with Google'}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </main>
  )
}
