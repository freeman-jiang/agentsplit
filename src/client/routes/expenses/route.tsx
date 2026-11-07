import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSignedIn } from '~/client/auth-guard'

// Every /expenses page needs a signed-in, verified account (the session check only accepts verified ones).
export const Route = createFileRoute('/expenses')({
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  component: () => (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <Outlet />
    </main>
  ),
})
