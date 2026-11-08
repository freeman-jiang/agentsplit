import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { LoginButton } from '~/client/components/login-button'
import { attributionLine } from '~/client/components/expense-row/figures'
import { ExpenseRow } from '~/client/components/expense-row/row'
import { describeError } from '~/client/errors'
import { useDebounced } from '~/client/hooks'
import { meQuery } from '~/client/queries/session'
import { accountBalancesQuery, feedOptionsQuery, feedQuery } from '~/client/queries/feed'
import { currencyParam, oneOf, searchParams, text as textOf, textParam } from '~/client/search'
import { Button } from '~/client/ui/button'
import { CurrencySelect } from '~/client/ui/currency-select'
import { DisclosureSummary } from '~/client/ui/disclosure'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import type { FeedFilter, FeedItem, FeedScope } from '~/shared/api'
import { isCalendarDate } from '~/shared/dates'
import { LIMITS } from '~/shared/limits'
import { EXPENSE_KINDS } from '~/shared/vocabulary'
import { DashboardBalance } from './-dashboard-balance'

// Every filter stays as the URL has it, so a value the feed cannot use shows a message (toFilter).
const parseSearch = searchParams({
  q: textParam,
  group: textParam,
  view: textParam,
  person: textParam,
  payer: textParam,
  type: textParam,
  currency: textParam,
  category: textParam,
  from: textParam,
  to: textParam,
})
type SearchParams = ReturnType<typeof parseSearch>
type Key = keyof SearchParams

export const Route = createFileRoute('/')({
  validateSearch: parseSearch,
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(meQuery),
  loader: ({ context }) => {
    // Start the dashboard's reads together; the RPC client sends them in one request.
    if (!context.queryClient.getQueryData(meQuery.queryKey)) return
    void context.queryClient.prefetchQuery(accountBalancesQuery)
    void context.queryClient.prefetchQuery(feedOptionsQuery)
  },
  component: Home,
})

function Home() {
  const { data: me } = useQuery(meQuery)
  return me ? <Dashboard /> : <Landing />
}

function Landing() {
  return (
    <main className="flex flex-1 items-center">
      <section className="w-full py-16">
        <div className="mx-auto flex w-full max-w-screen-md flex-col items-center gap-6 px-4 text-center">
          <h1 className="py-2 font-display text-4xl leading-none! sm:text-5xl md:text-6xl">
            Split expenses <strong className="block font-semibold text-muted-foreground">with people and agents.</strong>
          </h1>
          <p className="max-w-lg leading-normal text-pretty text-muted-foreground sm:text-xl sm:leading-8">
            Record shared expenses and payments, and see who owes whom. Use the website or your AI agent.
          </p>
          <LoginButton label="Sign in with Google" selectAccount={false} callbackURL="/" errorCallbackURL="/sign-in" />
        </div>
      </section>
    </main>
  )
}

const text = (value: string | number | undefined) => textOf(value) ?? ''
/** The Group select's choices that are a scope rather than one group; 'all' filters nothing. */
const scopeParam = oneOf(['grouped', 'ungrouped'] as const satisfies ReadonlyArray<typeof FeedScope.Type>)
const kindParam = oneOf(EXPENSE_KINDS)

/** The URL's filters as a feed filter, or the message to show instead of the list. */
function toFilter(s: SearchParams, search: string): { filter: typeof FeedFilter.Type } | { error: string } {
  const group = text(s.group) || 'all'
  const currency = text(s.currency)
  const currencyCode = currencyParam(currency)
  const category = text(s.category)
  const kind = kindParam(text(s.type))
  const scope = scopeParam(group)
  const [from, to] = [text(s.from), text(s.to)]
  if (currency && !currencyCode) return { error: 'Choose a supported currency.' }
  if (category && !/^\d+$/.test(category)) return { error: 'Choose a category from the list.' }
  if ((from && !isCalendarDate(from)) || (to && !isCalendarDate(to))) return { error: 'Use a calendar date, YYYY-MM-DD.' }
  if (from && to && from > to) return { error: 'The start date must be on or before the end date.' }
  return {
    filter: {
      involvingMe: text(s.view) !== 'all',
      ...(scope ? { scope } : group !== 'all' ? { groupId: group } : {}),
      ...(search.trim() ? { search: search.trim().slice(0, LIMITS.searchMax) } : {}),
      ...(text(s.person) ? { personUserId: text(s.person) } : {}),
      ...(text(s.payer) ? { payerUserId: text(s.payer) } : {}),
      ...(currencyCode ? { currency: currencyCode } : {}),
      ...(category ? { categoryId: Number(category) } : {}),
      ...(kind ? { kind } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
  }
}

const ADVANCED: Key[] = ['person', 'payer', 'currency', 'category', 'type', 'from', 'to']

function Dashboard() {
  const params = Route.useSearch()
  const navigate = Route.useNavigate()
  const options = useQuery(feedOptionsQuery)
  const search = useDebounced(text(params.q), 250)
  const parsed = toFilter(params, search)
  const feed = useInfiniteQuery({ ...feedQuery('filter' in parsed ? parsed.filter : {}), enabled: 'filter' in parsed })
  const update = (key: Key, value: string) =>
    navigate({
      to: '/',
      search: (prev) => {
        const { [key]: _old, ...rest } = prev
        return value ? { ...rest, [key]: value } : rest
      },
      replace: true,
      resetScroll: false,
    })
  const expenses = feed.data?.pages.flatMap((page) => page.expenses) ?? []
  const advanced = ADVANCED.some((key) => params[key] !== undefined)
  const select = (key: Key) => ({ value: text(params[key]), onChange: (e: { target: { value: string } }) => update(key, e.target.value) })
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <div className="space-y-4 sm:space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl">Dashboard</h1>
            <p className="mt-2 hidden text-sm text-muted-foreground sm:block">Your balances and shared expenses, in one place.</p>
          </div>
          <Button asChild>
            <Link to="/expenses/create">Add expense</Link>
          </Button>
        </div>
        <DashboardBalance />
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-xl">Expenses</h2>
          <p className="text-xs text-muted-foreground">Newest expense date first</p>
        </div>
        <section aria-label="Filter expenses" className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <label className="relative col-span-2 text-sm sm:col-span-1">
              <span className="sr-only">Search</span>
              <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" className="ps-9" placeholder="Search descriptions or merchants" maxLength={LIMITS.searchMax} {...select('q')} />
            </label>
            <label className="text-sm">
              <span className="sr-only">Group</span>
              <NativeSelect value={text(params.group) || 'all'} onChange={(e) => update('group', e.target.value === 'all' ? '' : e.target.value)}>
                <option value="all">All expenses</option>
                <option value="ungrouped">No group</option>
                <option value="grouped">Any named group</option>
                {options.data?.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="text-sm">
              <span className="sr-only">Show</span>
              <NativeSelect value={text(params.view) === 'all' ? 'all' : 'mine'} onChange={(e) => update('view', e.target.value === 'all' ? 'all' : '')}>
                <option value="mine">Involving me</option>
                <option value="all">All accessible expenses</option>
              </NativeSelect>
            </label>
          </div>
          <details open={advanced || undefined}>
            <DisclosureSummary className="min-h-0 justify-start gap-1 font-normal text-muted-foreground">More filters</DisclosureSummary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-2 text-sm">
                <span>Person involved</span>
                <NativeSelect {...select('person')}>
                  <option value="">Anyone</option>
                  {options.data?.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-2 text-sm">
                <span>Paid by</span>
                <NativeSelect {...select('payer')}>
                  <option value="">Anyone</option>
                  {options.data?.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-2 text-sm">
                <span>Type</span>
                <NativeSelect {...select('type')}>
                  <option value="">Expenses and payments</option>
                  <option value="expense">Expenses</option>
                  <option value="payment">Payments</option>
                </NativeSelect>
              </label>
              <label className="space-y-2 text-sm">
                <span>Currency</span>
                <CurrencySelect any="All currencies" compact value={currencyParam(params.currency) ?? ''} onChange={(currency) => update('currency', currency)} />
              </label>
              <label className="space-y-2 text-sm">
                <span>Category</span>
                <NativeSelect {...select('category')}>
                  <option value="">All categories</option>
                  {options.data?.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-2 text-sm">
                <span>From date</span>
                <Input type="date" {...select('from')} />
              </label>
              <label className="space-y-2 text-sm">
                <span>Through date</span>
                <Input type="date" {...select('to')} />
              </label>
            </div>
          </details>
          {Object.keys(params).length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/', search: {}, replace: true, resetScroll: false })}>
              Reset filters
            </Button>
          )}
        </section>
        {'error' in parsed ? (
          <p role="alert">{parsed.error}</p>
        ) : feed.error ? (
          <p role="alert">{describeError(feed.error).message}</p>
        ) : !feed.data ? (
          <p role="status">Loading expenses…</p>
        ) : expenses.length === 0 ? (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
            <h2 className="font-display text-xl">No expenses here yet</h2>
            <p className="mt-2 text-sm text-muted-foreground">Add an expense or adjust your filters.</p>
          </div>
        ) : (
          <div aria-label="Expense history" className="divide-y overflow-hidden rounded-2xl border bg-card">
            {expenses.map((expense) => (
              <FeedRow key={expense.id} expense={expense} />
            ))}
          </div>
        )}
        {feed.hasNextPage && (
          <Button variant="outline" disabled={feed.isFetchingNextPage} onClick={() => feed.fetchNextPage()}>
            {feed.isFetchingNextPage ? 'Loading…' : 'Load more expenses'}
          </Button>
        )}
      </div>
    </main>
  )
}

/** A feed item in the shared row: its own people, and its group, or "No group". */
function FeedRow({ expense: e }: { expense: typeof FeedItem.Type }) {
  const { attribution } = e
  return (
    <ExpenseRow
      expense={e}
      link={{ to: '/expenses/$expenseId', params: { expenseId: e.id } }}
      viewer={e.participantId}
      names={new Map(e.people.map((p) => [p.id, p.name]))}
      attribution={attributionLine({ addedBy: attribution.createdBy?.name ?? null, editedBy: attribution.updatedBy?.name ?? null })}
      place={e.group}
      context={!e.group && e.kind === 'payment' && e.contextExpenseTitle ? `Payment for ${e.contextExpenseTitle}` : null}
    />
  )
}
