import { createFileRoute, redirect } from '@tanstack/react-router'
import { meQuery } from '~/client/queries'

// Placeholder until the dashboard is ported (docs/v2/PARITY.md, P-FEED).
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in' })
    throw redirect({ to: '/groups' })
  },
})
