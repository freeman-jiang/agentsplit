import { createFileRoute } from '@tanstack/react-router'

async function signIn() {
  const response = await fetch('/api/auth/sign-in/social', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  })
  const { url } = (await response.json()) as { url?: string }
  if (url) window.location.href = url
}

export const Route = createFileRoute('/sign-in')({
  component: () => (
    <main className="mx-auto mt-24 max-w-sm text-center">
      <h1 className="mb-6 text-2xl font-semibold">Sign in to AgentSplit</h1>
      <button type="button" onClick={signIn} className="rounded-lg bg-stone-900 px-4 py-2 text-white">
        Continue with Google
      </button>
    </main>
  ),
})
