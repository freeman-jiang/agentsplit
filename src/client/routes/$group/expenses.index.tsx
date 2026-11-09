import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { attributionLine } from '~/client/components/expense-row/figures'
import { ExpenseRow } from '~/client/components/expense-row/row'
import { localDate } from '~/client/dates'
import { editorLink } from '~/client/editor-link'
import { useDebounced, useInfiniteScroll } from '~/client/hooks'
import { expensesQuery } from '~/client/queries/expenses'
import { groupQuery } from '~/client/queries/groups'
import { nonEmptyParam, oneOf, searchParams } from '~/client/search'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { Segmented } from '~/client/ui/segmented'
import { Skeleton } from '~/client/ui/skeleton'
import { LIMITS } from '~/shared/limits'
import { ExportMenu } from './-export-menu'
import { groupByDate } from './-date-groups'

const SORTS = [
  { value: 'date', label: 'By date' },
  { value: 'updated', label: 'Recently changed' },
] as const

const parseSearch = searchParams({ sort: oneOf(SORTS.map((s) => s.value)), q: nonEmptyParam })

/** The list's filter, from its search params; the loader and the page must read the same query. */
const filterOf = (search: ReturnType<typeof parseSearch>) => ({ sort: search.sort ?? 'date', ...(search.q ? { search: search.q } : {}) })

export const Route = createFileRoute('/$group/expenses/')({
  validateSearch: parseSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureInfiniteQueryData(expensesQuery(context.groupId, filterOf(deps))),
  pendingComponent: ListSkeleton,
  component: ExpensesTab,
})

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  )
}

function ExpensesTab() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const filter = filterOf(search)
  const { sort } = filter
  const q = search.q ?? ''
  const [text, setText] = useState(q)
  // Search waits 300 ms after typing stops (P-EXP-09).
  const typed = useDebounced(text, 300)
  useEffect(() => {
    if (typed !== q) void navigate({ search: ({ q: _q, ...rest }) => (typed ? { ...rest, q: typed } : rest), replace: true })
  }, [typed, q, navigate])
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  const expenses = useSuspenseInfiniteQuery(expensesQuery(groupId, filter))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  const rows = expenses.data.pages.flatMap((p) => p.expenses)
  const sections = sort === 'date' ? groupByDate({ expenses: rows, today: localDate() }) : [{ key: 'all', label: '', expenses: rows }]
  // The next page loads when the end of the list scrolls into view (P-EXP-07).
  const end = useInfiniteScroll<HTMLDivElement>(expenses)

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Expenses</h2>
        <Button asChild>
          <Link to="/$group/expenses/create" params={{ group }}>
            Add expense
          </Link>
        </Button>
      </div>
      {!g.participantId && (
        <p className="mb-4 rounded-2xl border bg-card p-3 text-sm">
          Your account is not linked to a person in this group, so your share is not shown.{' '}
          <Link to="/$group/edit" params={{ group }} hash="members" className="underline underline-offset-4">
            See People
          </Link>
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Sort expenses"
          value={sort}
          options={SORTS}
          onChange={(value) => void navigate({ search: (s) => ({ ...s, sort: value }), replace: true })}
          className="min-h-10 text-sm max-sm:grid max-sm:w-full max-sm:grid-cols-2 pointer-coarse:min-h-11"
        />
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search expenses"
            aria-label="Search expenses"
            maxLength={LIMITS.searchMax}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="ps-9 pe-9"
          />
          {text && (
            <button type="button" aria-label="Clear search" onClick={() => setText('')} className="absolute inset-y-0 end-2 flex items-center text-muted-foreground">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* CSV and JSON exports of the whole group, as in the current app (P-EXPORT-01). */}
        <ExportMenu group={group} />
      </div>
      {rows.length === 0 ? (
        q ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No expenses match your search.</p>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No expenses yet.{' '}
            <Link to="/$group/expenses/create" params={{ group }} className="underline underline-offset-4">
              Add an expense
            </Link>
          </p>
        )
      ) : (
        <div data-testid="expense-list" className="space-y-6">
          {sections.map((section) => (
            <div key={section.key}>
              {section.label && <h3 className="eyebrow">{section.label}</h3>}
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
                {section.expenses.map((e) => (
                  <li key={e.id}>
                    <ExpenseRow
                      expense={e}
                      link={editorLink({ group, expenseId: e.id, kind: e.kind })}
                      viewer={g.participantId}
                      names={names}
                      attribution={attributionLine(e)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div ref={end} />
      {expenses.hasNextPage && <ListSkeleton />}
    </section>
  )
}
