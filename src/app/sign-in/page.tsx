import { LoginButton } from '@/components/login-button'

export default function SignInPage() {
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-16 space-y-6">
      <h1 className="font-display text-4xl">Welcome to AgentSplit</h1>
      <p className="text-muted-foreground">
        Log in with your Google account to access your groups.
      </p>
      <LoginButton />
    </main>
  )
}
