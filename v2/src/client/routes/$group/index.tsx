import { createFileRoute, redirect } from '@tanstack/react-router'

// As in the current app, /groups/<id> opens /groups/<id>/expenses. /<slug> alone
// never gets here: the router reads it as /<slug>/expenses (src/client/group-urls.ts).
export const Route = createFileRoute('/$group/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/$group/expenses', params, replace: true })
  },
})
