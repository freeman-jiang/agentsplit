import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Schema } from 'effect'
import { useDeferredValue } from 'react'
import { CURRENCIES } from '../../shared/currencies'
import { expensesQuery, groupQuery } from '../queries'

const Search = Schema.Struct({
  sort: Schema.optionalKey(Schema.Literals(['date', 'updated'])),
  q: Schema.optionalKey(Schema.String),
})

export const Route = createFileRoute('/$group')({
  validateSearch: Schema.toStandardSchemaV1(Search),
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(groupQuery(params.group)),
      context.queryClient.ensureInfiniteQueryData(expensesQuery(params.group, { sort: deps.sort ?? 'date', ...(deps.q ? { search: deps.q } : {}) })),
    ]),
  component: GroupPage,
})

const money = (amount: string, currency: keyof typeof CURRENCIES) => `${CURRENCIES[currency].symbol}${amount}`

function GroupPage() {
  const { group } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const sort = search.sort ?? 'date'
  const q = useDeferredValue(search.q ?? '')
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const expenses = useSuspenseInfiniteQuery(expensesQuery(group, { sort, ...(q ? { search: q } : {}) }))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  const rows = expenses.data.pages.flatMap((p) => p.expenses)

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_16rem]">
      <main>
        <h1 className="mb-4 text-xl font-semibold">{g.name}</h1>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Sort expenses" className="inline-flex rounded-lg border border-stone-200 p-0.5 text-sm">
            {(
              [
                ['date', 'By date'],
                ['updated', 'Recently changed'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={sort === value}
                onClick={() => navigate({ search: (s) => ({ ...s, sort: value }), replace: true })}
                className={`rounded-md px-3 py-1 ${sort === value ? 'bg-stone-900 text-white' : 'text-stone-600'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="Search expenses"
            defaultValue={search.q ?? ''}
            onChange={(e) => {
              const value = e.target.value
              navigate({ search: ({ q: _q, ...rest }) => (value ? { ...rest, q: value } : rest), replace: true })
            }}
            className="min-w-48 flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-sm"
          />
        </div>
        <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200" data-testid="expense-list">
          {rows.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                {e.vendor && <div className="text-xs text-stone-500">{e.vendor}</div>}
                <div className="truncate">{e.title}</div>
                <div className="text-xs text-stone-500">
                  {e.expenseDate} · paid by {e.payers.map((p) => names.get(p.participantId) ?? '?').join(', ')}
                </div>
              </div>
              <div className="shrink-0 tabular-nums">{money(e.amount, e.currency)}</div>
            </li>
          ))}
        </ul>
        {expenses.hasNextPage && (
          <button type="button" onClick={() => expenses.fetchNextPage()} className="mt-3 text-sm text-stone-600 underline">
            Load more
          </button>
        )}
      </main>
      <aside className="h-fit rounded-lg border border-stone-200 p-4 md:sticky md:top-6" aria-label="Balances">
        <h2 className="mb-2 font-medium">Balances</h2>
        <ul className="space-y-1 text-sm">
          {g.balances.map((b) => (
            <li key={`${b.participantId}-${b.currency}`} className="flex justify-between gap-2">
              <span>{names.get(b.participantId) ?? '?'}</span>
              <span className={`tabular-nums ${b.net.startsWith('-') ? 'text-red-700' : 'text-emerald-700'}`}>{money(b.net, b.currency)}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  )
}
