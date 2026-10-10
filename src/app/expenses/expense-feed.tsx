'use client'

import { ExpenseCard } from '@/app/groups/[groupId]/expenses/expense-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import type { Locale } from '@/i18n/request'
import { defaultCurrencyList, getCurrency } from '@/lib/currency'
import { expenseFeedInput } from '@/lib/expense-feed-input'
import { trpc } from '@/trpc/client'
import { useLocale } from 'next-intl'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useDebounce } from 'use-debounce'
import { DashboardBalance } from './dashboard-balance'

export function ExpenseFeed() {
  const params = useSearchParams()
  const router = useRouter()
  const locale = useLocale() as Locale
  const options = trpc.expenses.options.useQuery()
  const categories = trpc.categories.list.useQuery()
  const [search] = useDebounce(params.get('q') ?? '', 250)
  const group = params.get('group') ?? 'all'
  const parsed = expenseFeedInput.safeParse({
    filter: search,
    scope: ['all', 'grouped', 'ungrouped'].includes(group) ? group : 'all',
    groupId: ['all', 'grouped', 'ungrouped'].includes(group)
      ? undefined
      : group,
    involvingMe: params.get('view') !== 'all',
    personId: params.get('person') || undefined,
    paidByUserId: params.get('payer') || undefined,
    currencyCode: params.get('currency') || undefined,
    categoryId: params.get('category')
      ? Number(params.get('category'))
      : undefined,
    isReimbursement:
      params.get('type') === 'payment'
        ? true
        : params.get('type') === 'expense'
          ? false
          : undefined,
    from: params.get('from') || undefined,
    to: params.get('to') || undefined,
  })
  const feed = trpc.expenses.list.useInfiniteQuery(
    parsed.success ? parsed.data : { involvingMe: true },
    {
      enabled: parsed.success,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      staleTime: 0,
      refetchOnMount: 'always',
    },
  )
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    router.replace(next.size ? `/?${next}` : '/', { scroll: false })
  }
  const expenses = feed.data?.pages.flatMap((page) => page.expenses) ?? []
  const advanced = [
    'person',
    'payer',
    'currency',
    'category',
    'type',
    'from',
    'to',
  ].some((key) => params.has(key))
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl tracking-tight">Dashboard</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your balances and shared expenses, in one place.
          </p>
        </div>
        <Button asChild>
          <Link href="/expenses/create">Add expense</Link>
        </Button>
      </div>
      <DashboardBalance />
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-2xl">Expenses</h2>
        <p className="text-xs text-muted-foreground">
          Newest expense date first
        </p>
      </div>
      <section
        aria-label="Filter expenses"
        className="space-y-4 border bg-card p-4"
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="space-y-2 text-sm">
            <span>Search</span>
            <Input
              type="search"
              placeholder="Search descriptions or merchants"
              maxLength={200}
              value={params.get('q') ?? ''}
              onChange={(e) => update('q', e.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span>Group</span>
            <NativeSelect
              value={group}
              onChange={(e) => update('group', e.target.value)}
            >
              <option value="all">All groups and no group</option>
              <option value="ungrouped">No group</option>
              <option value="grouped">Any named group</option>
              {options.data?.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="space-y-2 text-sm">
            <span>Show</span>
            <NativeSelect
              value={params.get('view') === 'all' ? 'all' : 'mine'}
              onChange={(e) => update('view', e.target.value)}
            >
              <option value="mine">Involving me</option>
              <option value="all">All accessible expenses</option>
            </NativeSelect>
          </label>
        </div>
        <details open={advanced || undefined}>
          <summary className="cursor-pointer text-sm font-medium">
            More filters
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-2 text-sm">
              <span>Person involved</span>
              <NativeSelect
                value={params.get('person') ?? ''}
                onChange={(e) => update('person', e.target.value)}
              >
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
              <NativeSelect
                value={params.get('payer') ?? ''}
                onChange={(e) => update('payer', e.target.value)}
              >
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
              <NativeSelect
                value={params.get('type') ?? ''}
                onChange={(e) => update('type', e.target.value)}
              >
                <option value="">Expenses and payments</option>
                <option value="expense">Expenses</option>
                <option value="payment">Payments</option>
              </NativeSelect>
            </label>
            <label className="space-y-2 text-sm">
              <span>Currency</span>
              <NativeSelect
                value={params.get('currency') ?? ''}
                onChange={(e) => update('currency', e.target.value)}
              >
                <option value="">All currencies</option>
                {defaultCurrencyList(locale).map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="space-y-2 text-sm">
              <span>Category</span>
              <NativeSelect
                value={params.get('category') ?? ''}
                onChange={(e) => update('category', e.target.value)}
              >
                <option value="">All categories</option>
                {categories.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="space-y-2 text-sm">
              <span>From date</span>
              <Input
                type="date"
                value={params.get('from') ?? ''}
                onChange={(e) => update('from', e.target.value)}
              />
            </label>
            <label className="space-y-2 text-sm">
              <span>Through date</span>
              <Input
                type="date"
                value={params.get('to') ?? ''}
                onChange={(e) => update('to', e.target.value)}
              />
            </label>
          </div>
        </details>
        {params.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.replace('/', { scroll: false })}
          >
            Reset filters
          </Button>
        )}
      </section>
      {!parsed.success ? (
        <p role="alert">{parsed.error.issues[0]?.message}</p>
      ) : feed.error ? (
        <p role="alert">{feed.error.message}</p>
      ) : feed.isLoading ? (
        <p role="status">Loading expenses…</p>
      ) : expenses.length === 0 ? (
        <div className="border border-dashed px-6 py-12 text-center">
          <h2 className="font-display text-xl">No expenses here yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Add an expense or adjust your filters.
          </p>
        </div>
      ) : (
        <div aria-label="Expense history">
          {expenses.map((expense) => (
            <ExpenseCard
              key={expense.id}
              expense={expense}
              groupId={expense.groupId}
              participantCount={expense.paidFor.length}
              activeParticipantId={expense.participantId}
              currency={getCurrency(expense.currencyCode)}
              groupName={expense.group?.name}
              ungrouped={!expense.group}
              contextLabel={
                !expense.group &&
                expense.isReimbursement &&
                expense.contextExpenseTitle
                  ? `Repayment for ${expense.contextExpenseTitle}`
                  : undefined
              }
              href={`/expenses/${expense.id}`}
            />
          ))}
        </div>
      )}
      {feed.hasNextPage && (
        <Button
          variant="outline"
          disabled={feed.isFetchingNextPage}
          onClick={() => feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage ? 'Loading…' : 'Load more expenses'}
        </Button>
      )}
    </div>
  )
}
