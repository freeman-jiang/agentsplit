import { requireSignedIn } from '~/client/queries/account'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { ArrowLeftRight, BarChart3, ChevronDown, Info, Receipt, RefreshCw, Scale, ScrollText, Settings, Users } from 'lucide-react'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { groupQuery } from '~/client/queries'
import { balancesQuery } from '~/client/queries/expenses'
import { Button } from '~/client/ui/button'
import { Skeleton } from '~/client/ui/skeleton'
import type { CurrencyBalances } from '~/shared/api'
import { groupPath, groupRef } from '~/shared/groups'

export const Route = createFileRoute('/$group')({
  // A signed-out visitor returns here after sign-in (P-AUTH-49).
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  loader: async ({ context, params, location }) => {
    const g = await context.queryClient.ensureQueryData(groupQuery(params.group)).catch((error: unknown) => {
      // Not a member, or no such group: the directory explains (P-GROUP-21, P-GROUP-46).
      if (typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'Forbidden')
        throw redirect({ to: '/groups', search: { access: 'denied' }, replace: true })
      throw error
    })
    // A private context has no group pages: its expense page shows it (P-GROUP-47, P-UNGROUP-39).
    if (g.contextExpenseId) throw redirect({ to: '/expenses/$expenseId', params: { expenseId: g.contextExpenseId }, replace: true })
    // An ID, an old slug or another letter case moves to the group's current URL (P-GROUP-105, P-GROUP-106).
    const canonical = groupRef(g)
    if (params.group !== canonical) {
      context.queryClient.setQueryData(groupQuery(canonical).queryKey, g)
      const rest = location.pathname.split('/').slice(2).join('/')
      throw redirect({ href: `${groupPath(g)}${rest ? `/${rest}` : ''}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true })
    }
    return g
  },
  component: GroupLayout,
})

const TABS = [
  { to: '/$group/expenses', label: 'Expenses', Icon: Receipt },
  { to: '/$group/payments', label: 'Payments', Icon: ArrowLeftRight },
  { to: '/$group/balances', label: 'Balances', Icon: Scale },
  { to: '/$group/information', label: 'Information', Icon: Info },
  { to: '/$group/stats', label: 'Stats', Icon: BarChart3 },
  { to: '/$group/activity', label: 'Log', Icon: ScrollText },
  { to: '/$group/edit', label: 'Settings', Icon: Settings },
] as const

/**
 * Every group page shares this layout: tabs above, the tab's content on the
 * left, and a sticky net-balance rail on the right. The rail always describes
 * the whole group, whatever the tab filters; on mobile it becomes a compact
 * expandable summary above the content. Do not recreate it in a tab.
 */
function GroupLayout() {
  const { group } = Route.useParams()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  // On a phone the expense and payment forms need the whole screen; the rail stays on the tabs.
  const onForm = useRouterState({ select: (s) => s.matches.some((m) => FORM_ROUTES.has(m.routeId)) })
  // The Balances tab shows every balance itself, so the rail keeps only the viewer's summary there.
  const onBalances = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === '/$group/balances') })
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate font-display text-2xl sm:text-3xl">
          <Link to="/$group" params={{ group }}>
            {g.name}
          </Link>
        </h1>
        <Button variant="outline" size="sm" asChild>
          <Link to="/$group/edit" params={{ group }} hash="members">
            <Users className="mr-2 h-4 w-4" aria-hidden="true" />
            People
          </Link>
        </Button>
      </div>
      <div className="-mx-4 mb-4 border-b sm:mx-0">
        {/* On narrow screens the row scrolls; the fade at the right edge shows that more tabs follow. */}
        <nav
          aria-label="Group"
          className="flex gap-x-1 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] [scrollbar-width:none] sm:gap-x-4 sm:px-0 sm:[mask-image:none]"
        >
          {TABS.map(({ to, label, Icon }) => (
            <Link
              key={to}
              to={to}
              params={{ group }}
              className="inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-2 py-3 text-sm whitespace-nowrap text-muted-foreground"
              activeProps={{ className: 'border-primary! text-primary!' }}
            >
              <Icon className="hidden h-4 w-4 lg:block" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <BalanceRail group={group} hideOnMobile={onForm} summaryOnly={onBalances} />
        <div className="min-w-0 md:col-start-1 md:row-start-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

const FORM_ROUTES = new Set(['/$group/expenses/create', '/$group/expenses/$expenseId/edit', '/$group/payments/create', '/$group/payments/$expenseId/edit'])

type Entry = typeof CurrencyBalances.Type
type Person = { readonly id: string; readonly name: string }

const isZero = (amount: string) => !/[1-9]/.test(amount)
const abs = (amount: string) => (amount.startsWith('-') ? amount.slice(1) : amount)

function netLabel(amount: string, personal = false) {
  if (isZero(amount)) return 'Settled up'
  if (amount.startsWith('-')) return personal ? 'You owe' : 'owes'
  return personal ? 'You are owed' : 'gets back'
}

function amountClass(amount: string) {
  if (isZero(amount)) return 'text-muted-foreground'
  return amount.startsWith('-') ? 'text-owe' : 'text-owed'
}

/**
 * The net balances of the whole group, ported from the current app's
 * group-balance-summary.tsx. It reads its own balances query, so a failed load
 * stays in the rail. On narrow screens each currency is a closed <details>.
 */
function BalanceRail({ group, hideOnMobile, summaryOnly }: { group: string; hideOnMobile: boolean; summaryOnly: boolean }) {
  const { data: g } = useSuspenseQuery(groupQuery(group))
  // As in the current app: fresh balances on mount and on window focus (P-BAL-58).
  // The data is stale after one second, so the rail does not fetch again right
  // after a loader fetched the same balances.
  const { data, isPending, isError, isFetching, refetch } = useQuery({ ...balancesQuery(group), staleTime: 1000 })
  const participantId = g.participantId
  return (
    <aside
      aria-label="Group balances"
      data-testid="group-balance-summary"
      className={cn(
        'z-20 h-fit self-start border bg-card p-3 md:sticky md:p-4 md:top-24 md:col-start-2 md:row-start-1 md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto',
        hideOnMobile && 'max-md:hidden',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Group balances</h2>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh balances">
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden="true" />
        </Button>
      </div>
      <p className="mb-4 hidden text-xs text-muted-foreground md:block">Net across all group expenses</p>
      {isError ? (
        <p role="alert" className="text-sm">
          Could not load balances. Try refreshing.
        </p>
      ) : isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : data.currencies.length === 0 ? (
        <p className="text-sm text-muted-foreground">No outstanding balances.</p>
      ) : (
        <div className="space-y-5">
          {data.currencies.map((entry) => {
            const ownTotal = participantId === null ? null : (entry.balances.find((b) => b.participantId === participantId)?.net ?? '0')
            const summary = (
              <div className="min-w-0 max-md:flex max-md:items-baseline max-md:gap-2">
                <div className="text-xs text-muted-foreground">
                  {ownTotal === null ? 'Group net balances' : netLabel(ownTotal, true)} · {entry.currency}
                </div>
                {ownTotal !== null && (
                  <div className={cn('mt-1 text-lg font-semibold tabular-nums max-md:mt-0 md:text-xl', amountClass(ownTotal))} data-testid="summary-personal-net">
                    {money(abs(ownTotal), entry.currency)}
                  </div>
                )}
              </div>
            )
            const details = <BalanceDetails entry={entry} participants={g.participants} participantId={participantId} />
            return (
              <section key={entry.currency} aria-label={`${entry.currency} balances`}>
                <details className="group md:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                    {summary}
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      Details
                      <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
                    </span>
                  </summary>
                  <div className="mt-4 max-h-[55dvh] overflow-y-auto">{details}</div>
                </details>
                <div className="hidden space-y-4 md:block">
                  {summary}
                  {!summaryOnly && details}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {!summaryOnly && (
        <Link to="/$group/balances" params={{ group }} className="mt-4 hidden text-xs underline underline-offset-4 md:inline-block">
          Balance details
        </Link>
      )}
    </aside>
  )
}

function BalanceDetails(props: { entry: Entry; participants: ReadonlyArray<Person>; participantId: string | null }) {
  const { entry, participants, participantId } = props
  const currency = entry.currency
  const nets = new Map(entry.balances.map((b) => [b.participantId, b.net]))
  const personName = (id: string) => (id === participantId ? 'You' : (participants.find((p) => p.id === id)?.name ?? 'Unknown participant'))
  return (
    <div className="space-y-4">
      <ul className="space-y-3" aria-label={`${currency} participant balances`}>
        {participants.map((person) => {
          const total = nets.get(person.id) ?? '0'
          return (
            <li key={person.id} className="space-y-0.5" data-testid="summary-participant" data-participant={person.name}>
              <div className="text-sm font-medium break-words">
                {person.name}
                {person.id === participantId && <span className="font-normal text-muted-foreground"> (you)</span>}
              </div>
              <div className={cn('text-sm tabular-nums', amountClass(total))}>
                {netLabel(total)}
                {!isZero(total) && <> {money(abs(total), currency)}</>}
              </div>
            </li>
          )
        })}
      </ul>
      {entry.settlements.length > 0 && (
        <div className="border-t pt-4">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Suggested payments</h3>
          <ul className="space-y-3 text-sm">
            {entry.settlements.map((payment) => (
              <li key={`${payment.from}-${payment.to}`} data-testid="summary-payment">
                <span className="block break-words">
                  {personName(payment.from)} → {personName(payment.to)}
                </span>
                <strong className="tabular-nums">{money(payment.amount, currency)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
