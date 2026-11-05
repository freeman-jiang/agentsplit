import { useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Paperclip, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '~/client/cn'
import { groupByDate, localToday, weekStartsOn } from '~/client/components/date-groups'
import { expenseRowFigures, type Figure } from '~/client/components/expense-row'
import { money } from '~/client/components/money'
import { expensesQuery, groupQuery } from '~/client/queries'
import { Button } from '~/client/ui/button'
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
  const sections = sort === 'date' ? groupByDate({ expenses: rows, today: localToday(), weekStartsOn: weekStartsOn(navigator.language) }) : [{ key: 'all', label: '', expenses: rows }]

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
            Create expense
          </Link>
        </Button>
      </div>
      {!g.participantId && (
        <p className="mb-4 border bg-card p-3 text-sm">
          Your account is not linked to a participant in this group, so amounts are not shown from your side.{' '}
          <Link to="/$group/edit" params={{ group }} hash="members" className="underline underline-offset-4">
            Choose your participant
          </Link>
        </p>
      )}
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
        <div className="relative min-w-48 flex-1">
          <Input
            type="search"
            placeholder="Search for an expense…"
            aria-label="Search expenses"
            maxLength={200}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="pe-9"
          />
          {text && (
            <button type="button" aria-label="Clear search" onClick={() => setText('')} className="absolute inset-y-0 end-2 flex items-center text-muted-foreground">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
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
        <div data-testid="expense-list" className="space-y-4">
          {sections.map((section) => (
            <div key={section.key}>
              {section.label && <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.label}</h3>}
              <ul className="divide-y border">
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

const tones: Record<Figure['tone'], string> = { neutral: 'text-muted-foreground', positive: 'text-primary', negative: 'text-destructive' }

function ExpenseCard(props: { expense: typeof Expense.Type; group: string; viewer: string | null; names: ReadonlyMap<string, string> }) {
  const { expense: e } = props
  const figures = expenseRowFigures({ expense: e, viewer: props.viewer, names: props.names })
  const [year, month, day] = e.expenseDate.split('-')
  const monthName = new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
  const author = e.editedBy ? `Last edited by ${e.editedBy}` : e.addedBy ? `Added by ${e.addedBy}` : 'Original author unavailable'
  const link =
    e.kind === 'payment'
      ? ({ to: '/$group/payments/$expenseId/edit', params: { group: props.group, expenseId: e.id } } as const)
      : ({ to: '/$group/expenses/$expenseId/edit', params: { group: props.group, expenseId: e.id } } as const)
  return (
    <li>
      <Link {...link} className="flex items-start gap-3 px-3 py-3 hover:bg-accent/50 sm:px-4">
        <div className="w-10 shrink-0 text-center leading-tight">
          <div className="text-xs uppercase text-muted-foreground">{monthName}</div>
          <div className="text-lg tabular-nums">{Number(day)}</div>
          <span className="sr-only">{year}</span>
        </div>
        <div className="min-w-0 flex-1">
          {e.vendor && <div className="truncate text-xs text-muted-foreground">{e.vendor}</div>}
          <div className={cn('flex items-center gap-1.5', e.kind === 'payment' && 'italic')}>
            <span className="truncate">{e.title}</span>
            {e.documentCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground" aria-label={`${e.documentCount} documents`}>
                <Paperclip className="h-3 w-3" aria-hidden="true" />
                {e.documentCount}
              </span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{author}</div>
        </div>
        <div className="shrink-0 text-right text-sm">
          <div className="text-xs text-muted-foreground">{figures.paid.label}</div>
          <div className="tabular-nums">{money(figures.paid.amount ?? '0', e.currency)}</div>
          {/* On narrow screens the viewer's figure sits under the paid figure. */}
          <div className={cn('mt-1 text-xs sm:hidden', tones[figures.personal.tone])}>
            {figures.personal.label} {figures.personal.amount === null ? '—' : money(figures.personal.amount, e.currency)}
          </div>
        </div>
        <div className="hidden w-28 shrink-0 text-right text-sm sm:block">
          <div className={cn('text-xs', tones[figures.personal.tone])}>{figures.personal.label}</div>
          <div className={cn('tabular-nums', tones[figures.personal.tone])}>{figures.personal.amount === null ? '—' : money(figures.personal.amount, e.currency)}</div>
        </div>
      </Link>
    </li>
  )
}
