import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { usePageTitle } from '~/client/components/page-title'
import { authClient } from '~/client/auth-client'
import { errorMessage } from '~/client/queries/account'
import { meQuery } from '~/client/queries'
import { Button } from '~/client/ui/button'
import { isInvitationPath, safeNextPath } from '~/shared/account'

type Search = { next?: string }

export const Route = createFileRoute('/sign-in')({
  validateSearch: (search: Record<string, unknown>): Search => (typeof search['next'] === 'string' ? { next: search['next'] } : {}),
  beforeLoad: async ({ context, search }) => {
    // An agent's authorize request with prompt=login or select_account sends a
    // signed-in user here on purpose; that sign-in must happen.
    if (new URLSearchParams(window.location.search).has('sig')) return
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ href: safeNextPath(search.next) ?? '/' })
  },
  component: SignIn,
})

function SignIn() {
  usePageTitle('Sign in')
  const { next } = Route.useSearch()
  const destination = safeNextPath(next)
  const invitation = destination !== null && isInvitationPath(destination)
  return (
    <main className="mx-auto w-full max-w-lg space-y-6 px-4 py-16">
      <h1 className="font-display text-4xl">{invitation ? 'You’ve been invited to AgentSplit' : 'Welcome to AgentSplit'}</h1>
      <p className="text-muted-foreground">
        {invitation
          ? 'AgentSplit keeps shared expenses, payments and balances in one place. Sign in with the Google email your invitation was sent to.'
          : 'Log in with your Google account to access your expenses and groups.'}
      </p>
      {invitation && (
        <ol className="list-decimal space-y-3 ps-5 text-sm">
          <li>
            <strong>Sign in with Google.</strong> If you’re new, we’ll create your account automatically. No separate password is needed.
          </li>
          <li>
            <strong>Accept the invitation.</strong> You’ll return here to confirm the group and your name.
          </li>
          <li>
            <strong>Use your group.</strong> View expenses, record payments and check balances in your browser. Connecting an AI agent
            is optional.
          </li>
        </ol>
      )}
      <LoginButton label={invitation ? 'Continue with Google' : 'Log In'} selectAccount={invitation} callbackURL={destination ?? '/'} />
    </main>
  )
}

function LoginButton(props: { label: string; selectAccount: boolean; callbackURL: string }) {
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
      <Button disabled={pending} onClick={() => void start()}>
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
