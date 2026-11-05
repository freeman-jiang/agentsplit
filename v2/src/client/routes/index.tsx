import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { groupsQuery, meQuery } from '../queries'

export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in' })
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(groupsQuery),
  component: Groups,
})

function Groups() {
  const { data: groups } = useSuspenseQuery(groupsQuery)
  return (
    <main>
      <h1 className="mb-4 text-xl font-semibold">Groups</h1>
      <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200">
        {groups.map((g) => (
          <li key={g.id}>
            <Link to="/$group" params={{ group: g.slug ?? g.id }} className="block px-4 py-3 hover:bg-stone-50">
              {g.name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
