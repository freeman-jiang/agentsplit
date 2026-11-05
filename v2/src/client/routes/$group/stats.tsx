// The Stats tab, ported from the current app's stats/ components. One request
// loads every card; the charts are plain elements, so the tab adds no chart
// library to the bundle.
import { keepPreviousData, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Banknote, Bus, ChartBarStacked, ChartColumnStacked, ChevronRight, FerrisWheel, HandHelping, Home, PlugZap, Utensils } from 'lucide-react'
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { localToday } from '~/client/components/local-today'
import { money } from '~/client/components/money'
import { groupQuery } from '~/client/queries'
import { statsQuery, type StatsScope } from '~/client/queries/history'
import { Button } from '~/client/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/client/ui/card'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import { Skeleton } from '~/client/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/client/ui/table'
import type { StatsOverview } from '~/shared/api'
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
import { minorOrNull } from '~/shared/minor'
import { divRound, regroupMonthly, type MonthlyCategory, type MonthlyGrouping, type MonthlyMonth, type MonthlySpending } from '~/shared/stats'

type Overview = typeof StatsOverview.Type

// ---------- periods (P-STATS-05 to P-STATS-10) ----------

const PERIODS = [
  ['all', 'All time'],
  ['thisMonth', 'This month'],
  ['last30', 'Last 30 days'],
  ['thisYear', 'This year'],
  ['custom', 'Custom range'],
] as const
type Period = (typeof PERIODS)[number][0]
type Range = { from?: string; to?: string }

/** A named period as an inclusive range of local calendar dates; a custom range with reversed bounds is swapped. */
function resolveRange(data: { period: Period; custom: Range; now: Date }): Range {
  const { now } = data
  switch (data.period) {
    case 'thisMonth':
      return { from: localToday(new Date(now.getFullYear(), now.getMonth(), 1)), to: localToday(now) }
    case 'last30':
      return { from: localToday(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: localToday(now) }
    case 'thisYear':
      return { from: localToday(new Date(now.getFullYear(), 0, 1)), to: localToday(now) }
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
  loader: ({ context, params }) => context.queryClient.ensureQueryData(statsQuery(params.group, { today: localToday(new Date()) })),
  component: StatsTab,
})

// ---------- formatting ----------

const dayFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' })
const formatDay = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`))
const monthFormat = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
const shortMonthYear = monthFormat({ month: 'short', year: 'numeric' })
const formatMonth = (key: string, format: Intl.DateTimeFormat = shortMonthYear) => format.format(new Date(`${key}-01T00:00:00Z`))
const toUnits = (amount: string, currency: CurrencyCode): bigint => {
  return minorOrNull({ amount, currency }) ?? 0n
}
/** Chart amounts: whole units when "Round amounts" is on (P-STATS-40). */
function chartMoney(data: { amount: string; currency: CurrencyCode; round: boolean }) {
  if (!data.round) return money(data.amount, data.currency)
  const whole = divRound(toUnits(data.amount, data.currency), 10n ** BigInt(CURRENCIES[data.currency].decimals))
  return money(whole.toString(), data.currency)
}
const ratio = (part: string, whole: string, currency: CurrencyCode) => {
  const w = toUnits(whole, currency)
  return w <= 0n ? 0 : Number(toUnits(part, currency)) / Number(w)
}
const isNegative = (amount: string) => amount.startsWith('-')
const abs = (amount: string) => (isNegative(amount) ? amount.slice(1) : amount)
const chartColor = (index: number) => `hsl(var(--chart-${(index % 5) + 1}))`

function GroupIcon({ grouping, className }: { grouping: string; className?: string }) {
  const Icon = { Entertainment: FerrisWheel, 'Food and Drink': Utensils, Home, Life: HandHelping, Transportation: Bus, Utilities: PlugZap }[grouping] ?? Banknote
  return <Icon className={className} aria-hidden="true" />
}

// ---------- page ----------

function StatsTab() {
  const { group } = Route.useParams()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const [period, setPeriod] = useState<Period>('all')
  const [custom, setCustom] = useState<Range>({})
  const [currency, setCurrency] = useState<CurrencyCode | undefined>()
  const now = new Date()
  const range = resolveRange({ period, custom, now })
  const scope = scopeOf({ currency, range })
  // Each filter change is one new request (P-STATS-02); the previous figures stay until it answers.
  const { data } = useQuery({ ...statsQuery(group, { ...scope, today: localToday(now) }), placeholderData: keepPreviousData })
  const c = data?.currency
  const drill = { group, groupId: g.id, range }
  return (
    <section>
      <h2 className="mb-4 font-display text-2xl leading-tight">Totals</h2>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4" aria-label="Statistics filters">
        {data && data.currencies.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Currency
            <NativeSelect aria-label="Statistics currency" value={data.currency} onChange={(e) => setCurrency(e.target.value as CurrencyCode)} wrapperClassName="w-28">
              {data.currencies.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <div className="flex max-w-full flex-col items-start gap-3 sm:items-end">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Period
            <NativeSelect aria-label="Period" data-testid="stats-period" value={period} onChange={(e) => setPeriod(e.target.value as Period)} wrapperClassName="w-44">
              {PERIODS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
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
      </div>
      <SummaryCard data={data} />
      <StatsCard title="Totals" description="Spending summary of the entire group.">
        {!data || !c ? <Lines rows={3} /> : <Totals data={data} currency={c} />}
      </StatsCard>
      <OverTimeCard data={data} drill={drill} />
      <MonthlyCard data={data} />
      <ParticipantsCard data={data} />
      <CategoriesCard data={data} drill={drill} />
      <RecurringCard data={data} />
    </section>
  )
}

function StatsCard({ title, description, children, actions }: { title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="shrink-0">
            <CardTitle className="text-xl">{title}</CardTitle>
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
  const span = !s?.firstDate || !s.lastDate ? '—' : s.firstDate === s.lastDate ? formatDay(s.firstDate) : `${formatDay(s.firstDate)} – ${formatDay(s.lastDate)}`
  return (
    <StatsCard title="Summary" description="Key figures for the selected period.">
      {!s || !c ? (
        <Lines rows={2} />
      ) : s.count === 0 ? (
        <Empty>There are no expenses yet.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-6">
          <Metric label="Expenses">{s.count}</Metric>
          <Metric label="Average expense">{money(s.average, c)}</Metric>
          <Metric label="Largest expense">
            {s.largest ? money(s.largest.amount, c) : '—'}
            {s.largest && <div className="truncate text-xs text-muted-foreground">{s.largest.title}</div>}
          </Metric>
          <Metric label="Active period">
            <span className="text-sm">{span}</span>
          </Metric>
        </div>
      )}
    </StatsCard>
  )
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium tabular-nums">{children}</div>
    </div>
  )
}

function Totals({ data, currency }: { data: Overview; currency: CurrencyCode }) {
  const personal = (label: string, amount: string) => (
    <div>
      <div className="text-muted-foreground">{label}</div>
      {/* Negative personal amounts are earnings: green; spending is red (P-STATS-22). */}
      <div className={cn('text-lg tabular-nums', isNegative(amount) ? 'text-green-600' : 'text-red-600')}>{money(abs(amount), currency)}</div>
    </div>
  )
  return (
    <div className="flex flex-col space-y-4">
      <div>
        <div className="text-muted-foreground">{isNegative(data.total) ? 'Total group earnings' : 'Total group spendings'}</div>
        <div className="text-lg tabular-nums">{money(abs(data.total), currency)}</div>
      </div>
      {data.yourPaid !== null && personal(isNegative(data.yourPaid) ? 'Your total earnings' : 'Your total spendings', data.yourPaid)}
      {data.yourShare !== null && personal('Your total share', data.yourShare)}
    </div>
  )
}

// ---------- bars with drill-down ----------

type Drill = { group: string; groupId: string; range: Range }

// The drill-down dialog and its library load on the first click, not with the tab.
const LazyDialog = lazy(() => import('~/client/components/history/stats-dialog'))
function ExpensesDialog(props: Parameters<typeof LazyDialog>[0]) {
  return (
    <Suspense fallback={null}>
      <LazyDialog {...props} />
    </Suspense>
  )
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full" style={{ width: `${max > 0 ? Math.max(0, (value / max) * 100) : 0}%`, backgroundColor: color }} />
    </div>
  )
}

function BarRow({ label, value, max, color, amount, onClick, aria, icon }: { label: ReactNode; value: number; max: number; color: string; amount: string; onClick: () => void; aria: string; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={aria}
      className="group -mx-2 flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate">{label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="tabular-nums text-muted-foreground">{amount}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground" aria-hidden="true" />
        </div>
      </div>
      <Bar value={value} max={max} color={color} />
    </button>
  )
}

function OverTimeCard({ data, drill }: { data: Overview | undefined; drill: Drill }) {
  const [month, setMonth] = useState<string | null>(null)
  const c = data?.currency
  const max = data ? Math.max(0, ...data.months.map((m) => Number(m.total))) : 0
  return (
    <StatsCard title="Spending over time" description="Total group spending per month. Select a month to see its expenses.">
      {!data || !c ? (
        <Lines rows={4} />
      ) : data.months.length === 0 ? (
        <Empty>There are no expenses yet.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.months.map((m) => (
            <BarRow key={m.month} label={formatMonth(m.month)} aria={`Show expenses for ${formatMonth(m.month)}`} value={Number(m.total)} max={max} color={chartColor(0)} amount={money(m.total, c)} onClick={() => setMonth(m.month)} />
          ))}
        </div>
      )}
      {c && month && (
        <ExpensesDialog
          drill={drill}
          scope={{ currency: c, month }}
          title={formatMonth(month)}
          description="Expenses in this month for the selected period."
          empty="There are no expenses in this month."
          onClose={() => setMonth(null)}
        />
      )}
    </StatsCard>
  )
}

function CategoriesCard({ data, drill }: { data: Overview | undefined; drill: Drill }) {
  const [selected, setSelected] = useState<Overview['categories'][number] | null>(null)
  const c = data?.currency
  const max = data ? Math.max(0, ...data.categories.map((x) => Number(x.total))) : 0
  return (
    <StatsCard title="Spending by category" description="Total amount spent in each category. Select a category to see its expenses.">
      {!data || !c ? (
        <Lines rows={4} />
      ) : data.categories.length === 0 ? (
        <Empty>There are no expenses yet.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          {data.categories.map((x, i) => (
            <BarRow
              key={x.categoryId}
              label={x.name}
              icon={<GroupIcon grouping={x.grouping} className="h-4 w-4 shrink-0 text-muted-foreground" />}
              aria={`Show expenses for ${x.name}`}
              value={Number(x.total)}
              max={max}
              color={chartColor(i)}
              amount={`${money(x.total, c)} (${x.percent}%)`}
              onClick={() => setSelected(x)}
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
          empty="There are no expenses in this category."
          onClose={() => setSelected(null)}
        />
      )}
    </StatsCard>
  )
}

// ---------- monthly spending (P-STATS-34 to P-STATS-40) ----------

type ChartType = 'bars' | 'columns'

function MonthlyCard({ data }: { data: Overview | undefined }) {
  const [grouping, setGrouping] = useState<MonthlyGrouping>('categoryGroup')
  const [chart, setChart] = useState<ChartType>('bars')
  const [round, setRound] = useState(true)
  const c = data?.currency
  // Regrouping uses the loaded data: no new request (P-STATS-35).
  const view = useMemo(() => (data && c ? regroupMonthly({ spending: data.monthly, grouping, currency: c }) : undefined), [data, c, grouping])
  const visible = useMemo(() => view?.categories.filter((x) => toUnits(x.expense, c ?? 'USD') > 0n) ?? [], [view, c])
  const colors = useMemo(() => new Map(visible.map((x, i) => [x.key, chartColor(i)])), [visible])
  const years = new Set(view?.months.map((m) => m.key.slice(0, 4)))
  const controls = (
    <div className="flex flex-wrap items-center gap-2 sm:min-w-0 sm:justify-end">
      <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-muted-foreground">
        <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={round} onChange={(e) => setRound(e.target.checked)} />
        Round amounts
      </label>
      <NativeSelect aria-label="Category grouping" value={grouping} onChange={(e) => setGrouping(e.target.value as MonthlyGrouping)} wrapperClassName="w-32" className="h-8">
        <option value="categoryGroup">Categories</option>
        <option value="category">Detailed</option>
      </NativeSelect>
      <div role="group" aria-label="Chart type" className="inline-flex h-8 shrink-0 rounded-md border border-input bg-background">
        {(
          [
            ['bars', 'Stacked bars', ChartBarStacked],
            ['columns', 'Stacked columns', ChartColumnStacked],
          ] as const
        ).map(([value, label, Icon]) => (
          <Button key={value} type="button" variant="ghost" title={label} aria-label={label} aria-pressed={chart === value} onClick={() => setChart(value)} className={cn('h-7 w-8 border-0 px-2', chart === value && 'bg-accent text-accent-foreground')}>
            <Icon className="h-4 w-4" />
          </Button>
        ))}
      </div>
    </div>
  )
  return (
    <StatsCard title="Monthly spending" description="Spending by month and category for the selected period." actions={controls}>
      {!view || !c ? (
        <Lines rows={3} />
      ) : view.months.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">No spending data yet.</p>
      ) : (
        <div className={cn('gap-4', chart === 'columns' && 'grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-end')}>
          <section className="space-y-3">
            <h4 className="text-sm font-semibold">Monthly categories</h4>
            {chart === 'bars' ? <StackedBars view={view} visible={visible} colors={colors} currency={c} round={round} grouping={grouping} includeYear={years.size > 1} /> : <StackedColumns view={view} visible={visible} colors={colors} currency={c} round={round} grouping={grouping} includeYear={years.size > 1} />}
          </section>
          {/* The legend lists only categories with spending, in a cycle of five colours (P-STATS-39). */}
          <div className={cn('text-xs text-muted-foreground', chart === 'columns' ? 'mt-4 space-y-2 lg:mb-7 lg:mt-0' : 'mt-3 flex flex-wrap gap-x-4 gap-y-2')}>
            {visible.map((x) => (
              <div key={x.key} className="flex min-w-0 items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border" style={{ backgroundColor: colors.get(x.key), color: 'hsl(var(--background))' }}>
                  <GroupIcon grouping={x.grouping} className="h-3.5 w-3.5" />
                </span>
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

const longMonth = monthFormat({ month: 'long', year: 'numeric' })
const shortMonth = monthFormat({ month: 'short' })

/** The month's segments in legend order, only those with spending. */
function segments(month: MonthlyMonth, visible: readonly MonthlyCategory[], currency: CurrencyCode) {
  const byKey = new Map(month.categories.map((x) => [x.key, x]))
  return visible.flatMap((v) => {
    const x = byKey.get(v.key)
    return x && toUnits(x.expense, currency) > 0n ? [x] : []
  })
}
const hover = (data: { month: MonthlyMonth; category: MonthlyCategory; share: number; currency: CurrencyCode; round: boolean }) =>
  `${formatMonth(data.month.key, longMonth)} - ${data.category.name}: ${chartMoney({ amount: data.category.expense, currency: data.currency, round: data.round })} (${Math.round(data.share * 100)}%)`

function StackedBars({ view, visible, colors, currency, round, grouping, includeYear }: ChartProps) {
  return (
    <div className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
      {view.months.map((month) => {
        const share = ratio(month.expense, view.maxExpense, currency)
        const units = toUnits(month.expense, currency) > 0n ? Math.max(share, 0.03) : 0
        return (
          <div key={month.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-sm sm:grid-cols-[6rem_minmax(0,1fr)]">
            <div className="text-muted-foreground">{formatMonth(month.key, includeYear ? shortMonthYear : shortMonth)}</div>
            <div className="grid items-center gap-2" style={{ gridTemplateColumns: `${units}fr max-content ${Math.max(0, 1 - units)}fr` }}>
              <div className="h-7 min-w-0 overflow-hidden rounded-md bg-muted">
                <div className="flex h-full">
                  {segments(month, visible, currency).map((x) => {
                    const part = ratio(x.expense, month.expense, currency)
                    const label = hover({ month, category: x, share: part, currency, round })
                    return (
                      <div key={x.key} aria-label={label} title={label} className="flex h-full min-w-[2px] items-center gap-1 overflow-hidden px-1.5" style={{ width: `${part * 100}%`, backgroundColor: colors.get(x.key), color: 'hsl(var(--background))' }}>
                        {part >= 0.06 && <GroupIcon grouping={grouping === 'categoryGroup' ? x.key : x.grouping} className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="text-left text-xs text-muted-foreground">{chartMoney({ amount: month.expense, currency, round })}</div>
            </div>
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
                <div className="mb-1 max-w-full truncate px-0.5 text-center text-[10px] leading-none text-muted-foreground">{total}</div>
                <div className="flex w-full max-w-14 items-end rounded-md bg-muted" style={{ height: percent > 0 ? `calc(12rem * ${percent / 100})` : '0px' }} title={`${formatMonth(month.key, longMonth)}: ${total}`}>
                  <div className="flex h-full w-full flex-col-reverse overflow-hidden rounded-md">
                    {segments(month, visible, currency).map((x) => {
                      const part = ratio(x.expense, month.expense, currency)
                      const label = hover({ month, category: x, share: part, currency, round })
                      return (
                        <div key={x.key} aria-label={label} title={label} className="flex min-h-[3px] items-center justify-center overflow-hidden px-0.5" style={{ height: `${part * 100}%`, backgroundColor: colors.get(x.key), color: 'hsl(var(--background))' }}>
                          {part >= 0.08 && <GroupIcon grouping={grouping === 'categoryGroup' ? x.key : x.grouping} className="h-3.5 w-3.5 shrink-0 opacity-80" />}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="w-full min-w-0 text-center text-[10px] leading-tight text-muted-foreground">
                <div className="truncate">{formatMonth(month.key, shortMonth)}</div>
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
    <StatsCard title="Spending by participant" description="How much each participant paid and their share of the expenses.">
      {!data || !c ? (
        <Lines rows={3} />
      ) : data.participants.length === 0 ? (
        <Empty>There are no expenses yet.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-2">Participant</TableHead>
              <TableHead className="h-8 px-2 text-right">Paid</TableHead>
              <TableHead className="h-8 px-2 text-right">Count</TableHead>
              <TableHead className="h-8 px-2 text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.participants.map((p) => (
              <TableRow key={p.participantId}>
                <TableCell className="p-2 font-medium">{p.name}</TableCell>
                <TableCell className="p-2 text-right tabular-nums">{money(p.paid, c)}</TableCell>
                <TableCell className="p-2 text-right tabular-nums text-muted-foreground">{p.count}</TableCell>
                <TableCell className="p-2 text-right tabular-nums text-muted-foreground">{money(p.share, c)}</TableCell>
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
    <StatsCard title="Recurring expenses" description="Estimated cost of the group's active recurring expenses.">
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
