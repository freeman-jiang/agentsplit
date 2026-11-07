import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/client/cn'
import { groupByDate, weekStartsOn } from '~/client/components/date-groups'
import { localDate } from '~/client/components/local-date'
import { expenseRowFigures, type Figure } from '~/client/components/expense-row'
import { expenseRowClass, RowCategory, RowDate, RowFigure, RowMetadata, RowNarrowLine, RowTitle, RowVendor } from '~/client/components/expense-row-parts'
import { money } from '~/client/components/money'
import { expensesQuery, groupQuery } from '~/client/queries'
import { Button } from '~/client/ui/button'
import { ExportMenu } from '~/client/components/history/export-menu'
import { Input } from '~/client/ui/input'
import { Skeleton } from '~/client/ui/skeleton'
import type { Expense } from '~/shared/api'

type Search = { sort?: 'date' | 'updated'; q?: string }

/** Route options stay in the main chunk, so this parses search params without a schema library. */
const parseSearch = (raw: Record<string, unknown>): Search => ({
  ...(raw['sort'] === 'date' || raw['sort'] === 'updated' ? { sort: raw['sort'] } : {}),
  ...(typeof raw['q'] === 'string' && raw['q'] ? { q: raw['q'] } : {}),
})

export const Route = createFileRoute('/$group/expenses/')({
  validateSearch: parseSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    context.queryClient.ensureInfiniteQueryData(expensesQuery(params.group, { sort: deps.sort ?? 'date', ...(deps.q ? { search: deps.q } : {}) })),
  pendingComponent: ListSkeleton,
  component: ExpensesTab,
})

const SORTS = [
  ['date', 'By date'],
  ['updated', 'Recently changed'],
] as const

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
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const sort = search.sort ?? 'date'
  const q = search.q ?? ''
  const [text, setText] = useState(q)
  // Search waits 300 ms after typing stops (P-EXP-09).
  useEffect(() => {
    if (text === q) return
    const timer = setTimeout(() => navigate({ search: ({ q: _q, ...rest }) => (text ? { ...rest, q: text } : rest), replace: true }), 300)
    return () => clearTimeout(timer)
  }, [text, q, navigate])
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const expenses = useSuspenseInfiniteQuery(expensesQuery(group, { sort, ...(q ? { search: q } : {}) }))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  const rows = expenses.data.pages.flatMap((p) => p.expenses)
  const sections = sort === 'date' ? groupByDate({ expenses: rows, today: localDate(), weekStartsOn: weekStartsOn(navigator.language) }) : [{ key: 'all', label: '', expenses: rows }]

  // The next page loads when the end of the list scrolls into view (P-EXP-07).
  const end = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = expenses
  useEffect(() => {
    const target = end.current
    if (!target || !hasNextPage) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && !isFetchingNextPage && void fetchNextPage())
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl">Expenses</h2>
        <Button asChild>
          <Link to="/$group/expenses/create" params={{ group }}>
            Add expense
          </Link>
        </Button>
      </div>
      {!g.participantId && (
        <p className="mb-4 rounded-2xl border bg-card p-3 text-sm">
          Your account is not linked to a participant in this group, so amounts are not shown from your side.{' '}
          <Link to="/$group/edit" params={{ group }} hash="members" className="underline underline-offset-4">
            Choose your participant
          </Link>
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Sort expenses" className="inline-flex min-h-10 items-stretch rounded-xl border border-input p-1 text-sm max-sm:grid max-sm:w-full max-sm:grid-cols-2">
          {SORTS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={sort === value}
              onClick={() => navigate({ search: (s) => ({ ...s, sort: value }), replace: true })}
              className={cn('rounded-[0.5rem] px-3 transition-colors', sort === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search for an expense…"
            aria-label="Search expenses"
            maxLength={200}
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
            Your group doesn’t contain any expense yet.{' '}
            <Link to="/$group/expenses/create" params={{ group }} className="underline underline-offset-4">
              Create the first one
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
                  <ExpenseCard key={e.id} expense={e} group={group} viewer={g.participantId} names={names} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <div ref={end} />
      {hasNextPage && <ListSkeleton />}
    </section>
  )
}

const tones: Record<Figure['tone'], string> = { neutral: 'text-muted-foreground', positive: 'text-owed', negative: 'text-owe' }

function ExpenseCard(props: { expense: typeof Expense.Type; group: string; viewer: string | null; names: ReadonlyMap<string, string> }) {
  const { expense: e } = props
  const figures = expenseRowFigures({ expense: e, viewer: props.viewer, names: props.names })
  const author = e.editedBy ? `Last edited by ${e.editedBy}` : e.addedBy ? `Added by ${e.addedBy}` : 'Original author unavailable'
  const paid = money(figures.paid.amount ?? '0', e.currency)
  const link =
    e.kind === 'payment'
      ? ({ to: '/$group/payments/$expenseId/edit', params: { group: props.group, expenseId: e.id } } as const)
      : ({ to: '/$group/expenses/$expenseId/edit', params: { group: props.group, expenseId: e.id } } as const)
  return (
    <li>
      <Link {...link} className={expenseRowClass}>
        <RowDate date={e.expenseDate} />
        <RowCategory categoryId={e.categoryId} />
        <div className="min-w-0">
          <RowVendor vendor={e.vendor} />
          <RowTitle title={e.title} payment={e.kind === 'payment'} documentCount={e.documentCount} />
          <RowMetadata parts={[e.vendor && { key: 'vendor', node: e.vendor }, { key: 'author', node: author }]} />
        </div>
        <RowFigure className="max-sm:hidden" label={figures.paid.label} amount={paid} amountClass="text-sm text-muted-foreground" />
        <RowFigure
          label={figures.personal.label}
          amount={figures.personal.amount === null ? '—' : money(figures.personal.amount, e.currency)}
          labelClass={tones[figures.personal.tone]}
          amountClass={cn('font-semibold', tones[figures.personal.tone])}
        />
        {/* On narrow screens the paid figure sits under the title, so the right column holds only the viewer's figure. */}
        <RowNarrowLine>
          <span className="min-w-0 truncate">
            {figures.paid.label} <span className="tabular-nums">{paid}</span>
          </span>
        </RowNarrowLine>
      </Link>
    </li>
  )
}
