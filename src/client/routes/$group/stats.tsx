// The Stats tab, ported from the current app's stats/ components. One request
// loads every card; the charts are plain elements, so the tab adds no chart
// library to the bundle.
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChartBarStacked, ChartColumnStacked, ChevronRight } from 'lucide-react'
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { CategoryIcon } from '~/client/components/category-icon'
import { magnitude } from '~/client/components/balance/net'
import { money, unitsOf } from '~/client/components/money'
import { formatDay, formatMonth, localDate } from '~/client/dates'
import { describeError } from '~/client/errors'
import { statsQuery, type StatsScope } from '~/client/queries/history'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/client/ui/card'
import { Checkbox } from '~/client/ui/checkbox'
import { ChoiceSelect } from '~/client/ui/choice-select'
import { Input } from '~/client/ui/input'
import { Label } from '~/client/ui/label'
import { Segmented } from '~/client/ui/segmented'
import { Skeleton } from '~/client/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/client/ui/table'
import type { StatsOverview } from '~/shared/api'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { divRound, regroupMonthly, type MonthlyCategory, type MonthlyGrouping, type MonthlyMonth, type MonthlySpending } from '~/shared/stats'

type Overview = typeof StatsOverview.Type

// ---------- periods (P-STATS-05 to P-STATS-10) ----------

const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisYear', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
] as const
type Period = (typeof PERIODS)[number]['value']
type Range = { from?: string; to?: string }

/** A named period as an inclusive range of local calendar dates; a custom range with reversed bounds is swapped. */
function resolveRange(data: { period: Period; custom: Range; now: Date }): Range {
  const { now } = data
  switch (data.period) {
    case 'thisMonth':
      return { from: localDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: localDate(now) }
    case 'last30':
      return { from: localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: localDate(now) }
    case 'thisYear':
      return { from: localDate(new Date(now.getFullYear(), 0, 1)), to: localDate(now) }
    case 'custom': {
      const { from, to } = data.custom
      if (from && to && from > to) return { from: to, to: from }
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
    }
    case 'all':
      return {}
  }
}

const scopeOf = (data: { currency: CurrencyCode | undefined; range: Range }): StatsScope => ({
  ...(data.currency ? { currency: data.currency } : {}),
  ...(data.range.from ? { from: data.range.from } : {}),
  ...(data.range.to ? { to: data.range.to } : {}),
})

export const Route = createFileRoute('/$group/stats')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statsQuery(context.groupId, { today: localDate() })),
  component: StatsTab,
})

// ---------- formatting ----------

/** Chart amounts: whole units when "Round amounts" is on (P-STATS-40). */
function chartMoney(data: { amount: string; currency: CurrencyCode; round: boolean }) {
  if (!data.round) return money(data.amount, data.currency)
  const whole = divRound(unitsOf(data.amount, data.currency), 10n ** BigInt(CURRENCIES[data.currency].decimals))
  return money(whole.toString(), data.currency)
}
const ratio = (part: string, whole: string, currency: CurrencyCode) => {
  const w = unitsOf(whole, currency)
  return w <= 0n ? 0 : Number(unitsOf(part, currency)) / Number(w)
}
const isNegative = (amount: string) => amount.startsWith('-')
const chartColor = (index: number) => `hsl(var(--chart-${(index % 5) + 1}))`

// ---------- page ----------

function StatsTab() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const [period, setPeriod] = useState<Period>('all')
  const [custom, setCustom] = useState<Range>({})
  const [currency, setCurrency] = useState<CurrencyCode | undefined>()
  const now = new Date()
  const range = resolveRange({ period, custom, now })
  const scope = scopeOf({ currency, range })
  // Each filter change is one new request (P-STATS-02); the previous figures stay until it answers.
  const { data, error } = useQuery({ ...statsQuery(groupId, { ...scope, today: localDate(now) }), placeholderData: keepPreviousData })
  const c = data?.currency
  const drill = { group, groupId, range }
  return (
    <section>
      <h2 className="sr-only">Stats</h2>
      <div className="mb-4 flex flex-wrap items-start gap-3" aria-label="Statistics filters">
        {data && data.currencies.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Currency
            <ChoiceSelect aria-label="Statistics currency" value={data.currency} options={data.currencies.map((code) => ({ value: code, label: code }))} onChange={setCurrency} wrapperClassName="w-28" />
          </label>
        )}
        <div className="flex max-w-full flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Period
            <ChoiceSelect aria-label="Period" data-testid="stats-period" value={period} options={PERIODS} onChange={setPeriod} wrapperClassName="w-44" />
          </label>
          {period === 'custom' && (
            <div className="flex max-w-full flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                From
                <Input type="date" aria-label="From" className="w-auto" max={custom.to} value={custom.from ?? ''} onChange={(e) => setCustom(({ from: _from, ...rest }) => (e.target.value ? { ...rest, from: e.target.value } : rest))} />
              </label>
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                To
                <Input type="date" aria-label="To" className="w-auto" min={custom.from} value={custom.to ?? ''} onChange={(e) => setCustom(({ to: _to, ...rest }) => (e.target.value ? { ...rest, to: e.target.value } : rest))} />
              </label>
            </div>
          )}
        </div>
        {/* The date range describes the selection, so it sits with the filters, not in a card. */}
        {data && data.summary.count > 0 && <span className="self-center text-sm tabular-nums text-muted-foreground sm:ml-auto">Expense dates · {activeSpan(data.summary)}</span>}
      </div>
      {error ? (
        <p role="alert" className="text-sm">
          {describeError(error).message}
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <SummaryCard data={data} />
          <StatsCard title="Totals" description="Spending of the whole group and your part of it.">
            {!data || !c ? <Lines rows={3} /> : <Totals data={data} currency={c} />}
          </StatsCard>
          <OverTimeCard data={data} drill={drill} />
          <MonthlyCard data={data} />
          <ParticipantsCard data={data} />
          <CategoriesCard data={data} drill={drill} />
          <RecurringCard data={data} />
        </div>
      )}
    </section>
  )
}

function StatsCard({ title, description, children, actions, wide }: { title: string; description: string; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  return (
    <Card className={cn('min-w-0', wide && 'xl:col-span-2')}>
      <CardHeader>
        <div className="flex flex-col gap-4">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {actions}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Lines({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-2 w-full" />
        </div>
      ))}
    </div>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

// ---------- summary and totals ----------

function SummaryCard({ data }: { data: Overview | undefined }) {
  const c = data?.currency
  const s = data?.summary
  return (
    <StatsCard title="Summary" description="Key figures for the selected period.">
      {!s || !c ? (
        <Lines rows={2} />
      ) : s.count === 0 ? (
        <Empty>No expenses.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 xl:grid-cols-2">
          <Metric label="Expenses">{s.count}</Metric>
          <Metric label="Average expense">{money(s.average, c)}</Metric>
          <div className="col-span-2 sm:col-span-1 xl:col-span-2">
            <Metric label="Largest expense">
              {s.largest ? money(s.largest.amount, c) : '—'}
              {s.largest && <div className="mt-0.5 text-xs font-normal leading-snug text-muted-foreground">{s.largest.title}</div>}
            </Metric>
          </div>
        </div>
      )}
    </StatsCard>
  )
}

/** The selected period's first and last expense dates. */
const activeSpan = (s: Overview['summary']) =>
  !s.firstDate || !s.lastDate ? '—' : s.firstDate === s.lastDate ? formatDay(s.firstDate) : `${formatDay(s.firstDate)} – ${formatDay(s.lastDate)}`

function Metric({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-2xl font-medium tabular-nums', className)}>{children}</div>
    </div>
  )
}

function Totals({ data, currency }: { data: Overview; currency: CurrencyCode }) {
  const personal = (label: string, amount: string) => (
    // Negative personal amounts are earnings: green; spending is red (P-STATS-22).
    <Metric label={label} className={isNegative(amount) ? 'text-owed' : 'text-owe'}>
      {money(magnitude(amount), currency)}
    </Metric>
  )
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-3 xl:grid-cols-2">
      <Metric label={isNegative(data.total) ? 'Group income' : 'Group spending'}>{money(magnitude(data.total), currency)}</Metric>
      {data.yourPaid !== null && personal(isNegative(data.yourPaid) ? 'You received' : 'You paid', data.yourPaid)}
      {data.yourShare !== null && personal('Your share', data.yourShare)}
    </div>
  )
}

// ---------- bars with drill-down ----------

type Drill = { group: string; groupId: string; range: Range }

// The drill-down dialog and its library load on the first click, not with the tab.
const LazyDialog = lazy(() => import('./-stats-dialog'))
function ExpensesDialog(props: Parameters<typeof LazyDialog>[0]) {
  return (
    <Suspense fallback={null}>
      <LazyDialog {...props} />
    </Suspense>
  )
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(0, (value / max) * 100) : 0}%`, backgroundColor: color }} />
    </div>
  )
}

/** The three bar charts share these wide-screen columns: label, bar, amount, chevron. */
const BAR_COLUMNS = 'lg:grid-cols-[8rem_minmax(0,1fr)_9.5rem_1rem]'

/**
 * One drill-down row. On wide screens the label, bar and amount share one
 * line; `columns` sets that grid, so every row of a card starts its bar at the same place.
 */
function BarRow(props: { label: ReactNode; value: number; max: number; color: string; amount: string; onClick: () => void; aria: string; icon?: ReactNode; columns: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-label={props.aria}
      className={cn(
        'group -mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        props.columns,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {props.icon}
        <span className="truncate">{props.label}</span>
      </span>
      <span className="col-span-full row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
        <Bar value={props.value} max={props.max} color={props.color} />
      </span>
      <span className="text-right tabular-nums text-muted-foreground">{props.amount}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground" aria-hidden="true" />
    </button>
  )
}

function OverTimeCard({ data, drill }: { data: Overview | undefined; drill: Drill }) {
  // The last month stays set while the dialog closes, so it can play its exit animation.
  const [month, setMonth] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const c = data?.currency
  const max = data ? Math.max(0, ...data.months.map((m) => Number(m.total))) : 0
  return (
    <StatsCard wide title="Spending over time" description="Total group spending per month. Select a month to see its expenses.">
      {!data || !c ? (
        <Lines rows={4} />
      ) : data.months.length === 0 ? (
        <Empty>No expenses.</Empty>
      ) : (
        <div className="flex flex-col gap-0.5">
          {data.months.map((m) => (
            <BarRow
              key={m.month}
              columns={BAR_COLUMNS}
              label={formatMonth(m.month)}
              aria={`Show expenses for ${formatMonth(m.month)}`}
              value={Number(m.total)}
              max={max}
              // Lighter than the monthly chart below, so the two month lists read as different charts.
              color="hsl(var(--muted-foreground))"
              amount={money(m.total, c)}
              onClick={() => {
                setMonth(m.month)
                setOpen(true)
              }}
            />
          ))}
        </div>
      )}
      {c && month && (
        <ExpensesDialog
          drill={drill}
          scope={{ currency: c, month }}
          title={formatMonth(month)}
          description="Expenses in this month for the selected period."
          empty="No expenses in this month."
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </StatsCard>
  )
}

function CategoriesCard({ data, drill }: { data: Overview | undefined; drill: Drill }) {
  // The last category stays set while the dialog closes, so it can play its exit animation.
  const [selected, setSelected] = useState<Overview['categories'][number] | null>(null)
  const [open, setOpen] = useState(false)
  const c = data?.currency
  const max = data ? Math.max(0, ...data.categories.map((x) => Number(x.total))) : 0
  return (
    <StatsCard wide title="Spending by category" description="Total amount spent in each category. Select a category to see its expenses.">
      {!data || !c ? (
        <Lines rows={4} />
      ) : data.categories.length === 0 ? (
        <Empty>No expenses.</Empty>
      ) : (
        <div className="flex flex-col gap-0.5">
          {data.categories.map((x, i) => (
            <BarRow
              key={x.categoryId}
              columns={BAR_COLUMNS}
              label={x.name}
              icon={<CategoryIcon grouping={x.grouping} className="h-4 w-4 shrink-0 text-muted-foreground" />}
              aria={`Show expenses for ${x.name}`}
              value={Number(x.total)}
              max={max}
              color={chartColor(i)}
              amount={`${money(x.total, c)} (${x.percent}%)`}
              onClick={() => {
                setSelected(x)
                setOpen(true)
              }}
            />
          ))}
        </div>
      )}
      {c && selected && (
        <ExpensesDialog
          drill={drill}
          scope={{ currency: c, categoryId: selected.categoryId }}
          title={selected.name}
          description="Expenses in this category for the selected period."
          empty="No expenses in this category."
          open={open}
          onClose={() => setOpen(false)}
        />
      )}
    </StatsCard>
  )
}

// ---------- monthly spending (P-STATS-34 to P-STATS-40) ----------

const GROUPINGS = [
  { value: 'categoryGroup', label: 'Categories' },
  { value: 'category', label: 'Detailed' },
] as const satisfies ReadonlyArray<{ value: MonthlyGrouping; label: string }>

const CHART_TYPES = [
  { value: 'bars', label: 'Stacked bars', icon: ChartBarStacked },
  { value: 'columns', label: 'Stacked columns', icon: ChartColumnStacked },
] as const
type ChartType = (typeof CHART_TYPES)[number]['value']

function MonthlyCard({ data }: { data: Overview | undefined }) {
  const [grouping, setGrouping] = useState<MonthlyGrouping>('categoryGroup')
  const [chart, setChart] = useState<ChartType>('bars')
  const [round, setRound] = useState(true)
  const c = data?.currency
  // Regrouping uses the loaded data: no new request (P-STATS-35).
  const view = useMemo(() => (data && c ? regroupMonthly({ spending: data.monthly, grouping, currency: c }) : undefined), [data, c, grouping])
  const visible = useMemo(() => (view && c ? view.categories.filter((x) => unitsOf(x.expense, c) > 0n) : []), [view, c])
  const colors = useMemo(() => new Map(visible.map((x, i) => [x.key, chartColor(i)])), [visible])
  const years = new Set(view?.months.map((m) => m.key.slice(0, 4)))
  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex h-9 shrink-0 items-center gap-2 rounded-xl border border-input px-3 text-sm pointer-coarse:h-11">
        <Checkbox id="round-amounts" checked={round} onCheckedChange={(value) => setRound(value === true)} />
        <Label htmlFor="round-amounts" className="font-normal">
          Round amounts
        </Label>
      </div>
      <ChoiceSelect aria-label="Category grouping" value={grouping} options={GROUPINGS} onChange={setGrouping} wrapperClassName="w-36 sm:w-32" className="h-9 sm:text-sm pointer-coarse:h-11" />
      <Segmented label="Chart type" value={chart} options={CHART_TYPES} onChange={setChart} className="h-9 shrink-0 pointer-coarse:h-11" />
    </div>
  )
  return (
    <StatsCard wide title="Monthly spending" description="Spending by month and category for the selected period." actions={controls}>
      {!view || !c ? (
        <Lines rows={3} />
      ) : view.months.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No expenses.</p>
      ) : (
        <div className={cn('gap-4', chart === 'columns' && 'grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-end')}>
          <section className="space-y-3">
            <h4 className="sr-only">Monthly categories</h4>
            {chart === 'bars' ? <StackedBars view={view} visible={visible} colors={colors} currency={c} round={round} grouping={grouping} includeYear={years.size > 1} /> : <StackedColumns view={view} visible={visible} colors={colors} currency={c} round={round} grouping={grouping} includeYear={years.size > 1} />}
          </section>
          {/* The legend lists only categories with spending, in a cycle of five colours (P-STATS-39). */}
          <div className={cn('text-xs text-muted-foreground', chart === 'columns' ? 'mt-4 space-y-2 lg:mb-7 lg:mt-0' : 'mt-3 flex flex-wrap gap-x-4 gap-y-2')}>
            {visible.map((x) => (
              <div key={x.key} className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colors.get(x.key) }} />
                <span className="truncate">{x.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </StatsCard>
  )
}

type ChartProps = { view: MonthlySpending; visible: readonly MonthlyCategory[]; colors: Map<string, string>; currency: CurrencyCode; round: boolean; grouping: MonthlyGrouping; includeYear: boolean }


/** The month's segments in legend order, only those with spending. */
function segments(month: MonthlyMonth, visible: readonly MonthlyCategory[], currency: CurrencyCode) {
  const byKey = new Map(month.categories.map((x) => [x.key, x]))
  return visible.flatMap((v) => {
    const x = byKey.get(v.key)
    return x && unitsOf(x.expense, currency) > 0n ? [x] : []
  })
}
const hover = (data: { month: MonthlyMonth; category: MonthlyCategory; share: number; currency: CurrencyCode; round: boolean }) =>
  `${formatMonth(data.month.key, 'long')} - ${data.category.name}: ${chartMoney({ amount: data.category.expense, currency: data.currency, round: data.round })} (${Math.round(data.share * 100)}%)`

function StackedBars({ view, visible, colors, currency, round, includeYear }: ChartProps) {
  return (
    <div className="flex max-h-[32rem] flex-col gap-0.5 overflow-y-auto">
      {view.months.map((month) => {
        const share = ratio(month.expense, view.maxExpense, currency)
        const units = unitsOf(month.expense, currency) > 0n ? Math.max(share, 0.03) : 0
        return (
          // The same grammar as "Spending over time": label, a bar on a full-width track, then the amount in a fixed column.
          <div key={month.key} className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 py-1.5 text-sm', BAR_COLUMNS)}>
            <div>{formatMonth(month.key, includeYear ? 'shortYear' : 'short')}</div>
            <div className="h-2 min-w-0 overflow-hidden rounded-full bg-muted">
              <div className="flex h-full overflow-hidden rounded-full" style={{ width: `${units * 100}%` }}>
                {segments(month, visible, currency).map((x) => {
                  const part = ratio(x.expense, month.expense, currency)
                  const label = hover({ month, category: x, share: part, currency, round })
                  return <div key={x.key} aria-label={label} title={label} className="h-full min-w-[2px]" style={{ width: `${part * 100}%`, backgroundColor: colors.get(x.key) }} />
                })}
              </div>
            </div>
            <div className="text-right tabular-nums text-muted-foreground">{chartMoney({ amount: month.expense, currency, round })}</div>
            {/* The drill-down rows' chevron column, so the amounts share one right edge. */}
            <span aria-hidden="true" className="hidden lg:block" />
          </div>
        )
      })}
    </div>
  )
}

function StackedColumns({ view, visible, colors, currency, round, grouping, includeYear }: ChartProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const count = view.months.length
  // The latest months are on the right: start scrolled to them.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth
  }, [count])
  return (
    <div ref={scroller} className="overflow-x-auto pb-1" dir="ltr">
      <div className="grid items-end gap-1 sm:gap-2" style={{ gridTemplateColumns: `repeat(${count}, 3.25rem)` }}>
        {view.months.map((month) => {
          const height = ratio(month.expense, view.maxExpense, currency)
          const percent = height > 0 ? Math.max(height * 100, 3) : 0
          const total = chartMoney({ amount: month.expense, currency, round })
          return (
            <div key={month.key} className="flex min-w-0 flex-col items-center gap-2">
              <div className="flex h-56 w-full flex-col items-center justify-end">
                <div className="mb-1 max-w-full truncate px-0.5 text-center text-xs leading-none tabular-nums text-muted-foreground">{total}</div>
                <div className="flex w-full max-w-14 items-end rounded-md bg-muted" style={{ height: percent > 0 ? `calc(12rem * ${percent / 100})` : '0px' }} title={`${formatMonth(month.key, 'long')}: ${total}`}>
                  <div className="flex h-full w-full flex-col-reverse overflow-hidden rounded-md">
                    {segments(month, visible, currency).map((x) => {
                      const part = ratio(x.expense, month.expense, currency)
                      const label = hover({ month, category: x, share: part, currency, round })
                      return (
                        <div key={x.key} aria-label={label} title={label} className="flex min-h-[3px] items-center justify-center overflow-hidden px-0.5" style={{ height: `${part * 100}%`, backgroundColor: colors.get(x.key), color: 'hsl(var(--background))' }}>
                          {part >= 0.08 && <CategoryIcon grouping={grouping === 'categoryGroup' ? x.key : x.grouping} className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="w-full min-w-0 text-center text-xs leading-tight text-muted-foreground">
                <div className="truncate">{formatMonth(month.key, 'short')}</div>
                {includeYear && <div>{month.key.slice(0, 4)}</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- participants and recurring ----------

function ParticipantsCard({ data }: { data: Overview | undefined }) {
  const c = data?.currency
  return (
    <StatsCard wide title="Spending by person" description="What each person paid, and their share of the expenses.">
      {!data || !c ? (
        <Lines rows={3} />
      ) : data.participants.length === 0 ? (
        <Empty>No expenses.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-2 pl-0">Person</TableHead>
              <TableHead className="h-8 px-2 text-right">Paid</TableHead>
              <TableHead className="h-8 px-2 text-right">Count</TableHead>
              <TableHead className="h-8 px-2 pr-0 text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.participants.map((p) => (
              <TableRow key={p.participantId}>
                <TableCell className="p-2 pl-0 font-medium">{p.name}</TableCell>
                <TableCell className="p-2 text-right tabular-nums">{money(p.paid, c)}</TableCell>
                <TableCell className="p-2 text-right tabular-nums text-muted-foreground">{p.count}</TableCell>
                <TableCell className="p-2 pr-0 text-right tabular-nums text-muted-foreground">{money(p.share, c)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </StatsCard>
  )
}

const PERIOD_LABEL = { daily: ['daily expense', 'daily expenses'], weekly: ['weekly expense', 'weekly expenses'], monthly: ['monthly expense', 'monthly expenses'] } as const

function RecurringCard({ data }: { data: Overview | undefined }) {
  const c = data?.currency
  // Hidden for groups without active recurring expenses in this currency (P-STATS-41).
  if (data && data.recurring.count === 0) return null
  return (
    <StatsCard wide title="Recurring expenses" description="Estimated cost of the group's active recurring expenses.">
      {!data || !c ? (
        <Lines rows={2} />
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-muted-foreground">Estimated monthly cost</div>
            <div className="text-lg tabular-nums">{money(data.recurring.monthly, c)}</div>
            <div className="text-sm text-muted-foreground">{money(data.recurring.yearly, c)} per year</div>
          </div>
          <div className="flex flex-col gap-2">
            {data.recurring.byPeriod.map((p) => (
              <div key={p.period} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {p.count} {PERIOD_LABEL[p.period][p.count === 1 ? 0 : 1]}
                </span>
                <span className="tabular-nums">{money(p.total, c)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </StatsCard>
  )
}
