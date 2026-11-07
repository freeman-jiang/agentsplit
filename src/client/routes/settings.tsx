import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSignedIn } from '~/client/auth-guard'

// Every settings screen, including OAuth consent, needs a signed-in web user.
export const Route = createFileRoute('/settings')({
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  component: Outlet,
})
