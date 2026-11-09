import { useState } from 'react'
import { authCall, authClient } from '~/client/auth-client'

const FAILED = 'Could not start Google sign-in. Try again.'

/**
 * Google's own button artwork (public/google), unchanged, as its branding
 * guidelines require: the neutral pill on the light theme, the dark pill on
 * the dark theme. The guidelines allow a larger button when the aspect ratio
 * stays, so it is 48 px high, scaled from the 2x and 4x images (360 and 720 px wide).
 */
const artwork = (theme: 'neutral' | 'dark') => ({
  src: `/google/sign-in-${theme}@2x.png`,
  srcSet: `/google/sign-in-${theme}@2x.png 360w, /google/sign-in-${theme}@4x.png 720w`,
  sizes: '216px',
})

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
        aria-label="Sign in with Google"
        aria-busy={pending}
        disabled={pending}
        onClick={() => void start()}
        className="block rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:opacity-60"
      >
        <img {...artwork('neutral')} alt="" width={216} height={48} className="dark:hidden" />
        <img {...artwork('dark')} alt="" width={216} height={48} className="hidden dark:block" />
      </button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
