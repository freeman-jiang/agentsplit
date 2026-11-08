import { createFileRoute, redirect } from '@tanstack/react-router'
import { LoginButton } from '~/client/components/login-button'
import { meQuery } from '~/client/queries/session'
import { searchParams, stringParam } from '~/client/search'
import { isInvitationPath, safeNextPath } from '~/shared/account'
import { SIGN_UP_LIMIT_CODE, signUpLimitMessage } from '~/shared/limits'

/** `error` is the code Better Auth adds when Google sign-in fails and returns here. */
const parseSearch = searchParams({ next: stringParam, error: stringParam })

export const Route = createFileRoute('/sign-in')({
  validateSearch: parseSearch,
  beforeLoad: async ({ context, search }) => {
    // An agent's authorize request with prompt=login or select_account sends a
    // signed-in user here on purpose; that sign-in must happen.
    if (new URLSearchParams(window.location.search).has('sig')) return
    if (await context.queryClient.ensureQueryData(meQuery)) throw redirect({ href: safeNextPath(search.next) ?? '/' })
  },
  component: SignIn,
})

/** This page without the error of the last attempt: Better Auth comes back here, with the code, when sign-in fails. */
function errorReturnPath() {
  const here = new URL(window.location.href)
  here.searchParams.delete('error')
  here.searchParams.delete('error_description')
  return here.pathname + here.search
}

function SignIn() {
  const { next, error } = Route.useSearch()
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
      {error && (
        <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          {error === SIGN_UP_LIMIT_CODE ? signUpLimitMessage : `Sign-in did not finish (${error}). Please try again.`}
        </p>
      )}
      <LoginButton
        label={invitation ? 'Continue with Google' : 'Sign in with Google'}
        selectAccount={invitation}
        callbackURL={destination ?? '/'}
        errorCallbackURL={errorReturnPath()}
      />
    </main>
  )
}
