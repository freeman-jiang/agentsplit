import { useState } from 'react'
import { authClient } from '~/client/auth-client'
import { errorMessage } from '~/client/queries/account'
import { Button } from '~/client/ui/button'

/** Starts Google sign-in at once, as the current app's login button does (P-AUTH-59, P-AUTH-60). */
export function LoginButton(props: { label: string; selectAccount: boolean; callbackURL: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    setPending(true)
    setError('')
    try {
      // Better Auth checks the callback on the server too: only this origin's paths pass.
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: props.callbackURL,
        ...(props.selectAccount ? { additionalParams: { prompt: 'select_account' } } : {}),
      })
      if (result.error) {
        setError(errorMessage(result.error, 'Unable to log in. Please try again.'))
        setPending(false)
      }
    } catch {
      setError('Unable to log in. Please try again.')
      setPending(false)
    }
  }
  return (
    <div className="space-y-3">
      <Button size="lg" disabled={pending} onClick={() => void start()}>
        {pending ? 'Opening Google…' : props.label}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
