'use client'

import { authClient } from '@/lib/auth-client'
import { useState } from 'react'
import { Button } from './ui/button'

export function LoginButton({
  label = 'Log In',
  selectAccount = false,
}: {
  label?: string
  selectAccount?: boolean
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="space-y-3">
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true)
          setError('')
          const next = new URLSearchParams(window.location.search).get('next')
          const callbackURL =
            next?.startsWith('/') && !next.startsWith('//') ? next : '/'
          try {
            const result = await authClient.signIn.social({
              provider: 'google',
              callbackURL,
              ...(selectAccount
                ? { additionalParams: { prompt: 'select_account' } }
                : {}),
            })
            if (result.error) {
              setError(
                result.error.message ?? 'Unable to log in. Please try again.',
              )
              setPending(false)
            }
          } catch {
            setError('Unable to log in. Please try again.')
            setPending(false)
          }
        }}
      >
        {pending ? 'Opening Google…' : label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
