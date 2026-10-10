import { LoginButton } from '@/components/login-button'

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const { next } = await searchParams
  const isInvitation =
    typeof next === 'string' && /^\/invite\/[A-Za-z0-9_-]{43}$/.test(next)
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 space-y-6">
      <h1 className="font-display text-4xl">
        {isInvitation
          ? 'You’ve been invited to AgentSplit'
          : 'Welcome to AgentSplit'}
      </h1>
      <p className="text-muted-foreground">
        {isInvitation
          ? 'AgentSplit keeps shared expenses, payments and balances in one place. Sign in with the Google email your invitation was sent to.'
          : 'Log in with your Google account to access your expenses and groups.'}
      </p>
      {isInvitation && (
        <ol className="list-decimal space-y-3 ps-5 text-sm">
          <li>
            <strong>Sign in with Google.</strong> If you’re new, we’ll create
            your account automatically. No separate password is needed.
          </li>
          <li>
            <strong>Accept the invitation.</strong> You’ll return here to
            confirm the group and your name.
          </li>
          <li>
            <strong>Use your group.</strong> View expenses, record payments and
            check balances in your browser. Connecting an AI agent is optional.
          </li>
        </ol>
      )}
      <LoginButton
        label={isInvitation ? 'Continue with Google' : 'Log In'}
        selectAccount={isInvitation}
      />
    </main>
  )
}
