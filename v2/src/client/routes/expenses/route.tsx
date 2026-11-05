import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { meQuery } from '~/client/queries'

// Every /expenses page needs a signed-in, verified account (the session check only accepts verified ones).
export const Route = createFileRoute('/expenses')({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in' })
  },
  component: () => (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <Outlet />
    </main>
  ),
})
