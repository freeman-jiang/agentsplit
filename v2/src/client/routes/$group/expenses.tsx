import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useDeferredValue } from 'react'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { expensesQuery, groupQuery } from '~/client/queries'
import { Input } from '~/client/ui/input'

type Search = { sort?: 'date' | 'updated'; q?: string }

/** Route options stay in the main chunk, so this parses search params without a schema library. */
const parseSearch = (raw: Record<string, unknown>): Search => ({
  ...(raw['sort'] === 'date' || raw['sort'] === 'updated' ? { sort: raw['sort'] } : {}),
  ...(typeof raw['q'] === 'string' && raw['q'] ? { q: raw['q'] } : {}),
})

export const Route = createFileRoute('/$group/expenses')({
  validateSearch: parseSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    context.queryClient.ensureInfiniteQueryData(expensesQuery(params.group, { sort: deps.sort ?? 'date', ...(deps.q ? { search: deps.q } : {}) })),
  component: ExpensesTab,
})

const SORTS = [
  ['date', 'By date'],
  ['updated', 'Recently changed'],
] as const

function ExpensesTab() {
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
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Sort expenses" className="inline-flex border p-0.5 text-sm">
          {SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={sort === value}
              onClick={() => navigate({ search: (s) => ({ ...s, sort: value }), replace: true })}
              className={cn('px-3 py-1', sort === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <Input
          type="search"
          placeholder="Search expenses"
          aria-label="Search expenses"
          defaultValue={search.q ?? ''}
          onChange={(e) => {
            const value = e.target.value
            navigate({ search: ({ q: _q, ...rest }) => (value ? { ...rest, q: value } : rest), replace: true })
          }}
          className="min-w-48 flex-1"
        />
      </div>
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{q ? 'No expenses match your search.' : 'No expenses yet.'}</p>
      ) : (
        <ul className="divide-y border" data-testid="expense-list">
          {rows.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                {e.vendor && <div className="text-xs text-muted-foreground">{e.vendor}</div>}
                <div className="truncate">{e.title}</div>
                <div className="text-xs text-muted-foreground">
                  {e.expenseDate} · paid by {e.payers.map((p) => names.get(p.participantId) ?? 'Unknown').join(', ')}
                </div>
              </div>
              <div className="shrink-0 tabular-nums">{money(e.amount, e.currency)}</div>
            </li>
          ))}
        </ul>
      )}
      {expenses.hasNextPage && (
        <button type="button" onClick={() => expenses.fetchNextPage()} className="mt-3 text-sm text-muted-foreground underline">
          Load more
        </button>
      )}
    </section>
  )
}
