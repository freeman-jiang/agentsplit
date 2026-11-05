import { createFileRoute, redirect } from '@tanstack/react-router'

// As in the current app, a group's root opens its expenses.
export const Route = createFileRoute('/$group/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/$group/expenses', params, replace: true })
  },
})
