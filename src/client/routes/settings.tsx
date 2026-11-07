import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSignedIn } from '~/client/queries/session'

// Every settings screen, including OAuth consent, needs a signed-in web user.
export const Route = createFileRoute('/settings')({
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  component: Outlet,
})
