import { useState } from 'react'
import { authCall, authClient } from '~/client/auth-client'

const FAILED = 'Could not start Google sign-in. Try again.'

/**
 * Google's standard "G" in its four colors, unchanged, as Google's own
 * rendered button draws it. The branding guidelines allow a button of the
 * app's own style around it, with an approved label such as "Continue with Google".
 */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-5 shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

/** Starts Google sign-in at once, as the current app's login button does (P-AUTH-59, P-AUTH-60). */
export function LoginButton(props: { selectAccount: boolean; callbackURL: string; errorCallbackURL: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function start() {
    setPending(true)
    setError('')
    // Better Auth checks the callback on the server too: only this origin's paths pass.
    const result = await authCall({
      run: () =>
        authClient.signIn.social({
          provider: 'google',
          callbackURL: props.callbackURL,
          errorCallbackURL: props.errorCallbackURL,
          ...(props.selectAccount ? { additionalParams: { prompt: 'select_account' } } : {}),
        }),
      refused: FAILED,
      failed: FAILED,
    })
    if ('error' in result) {
      setError(result.error)
      setPending(false)
    }
  }
  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-busy={pending}
        disabled={pending}
        onClick={() => void start()}
        className="inline-flex h-12 items-center gap-3 rounded-full border border-input bg-background px-6 text-[15px] font-medium transition-colors duration-150 ring-offset-background hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
      >
        <GoogleMark />
        Continue with Google
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
