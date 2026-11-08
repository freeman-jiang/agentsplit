import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { RefreshCw, Users } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { requireSignedIn } from '~/client/queries/session'
import { cn } from '~/client/cn'
import { isZero, magnitude, NET_CLASS, netLabel, netTone } from '~/client/components/balance/net'
import { RailSettlements } from '~/client/components/balance/settlements'
import { money } from '~/client/components/money'
import { balancesQuery } from '~/client/queries/expenses'
import { groupQuery, resolveGroup } from '~/client/queries/groups'
import { rpcError } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { DisclosureSummary } from '~/client/ui/disclosure'
import type { FileRoutesById } from '~/client/routeTree.gen'
import { Skeleton } from '~/client/ui/skeleton'
import type { CurrencyBalances, Participant } from '~/shared/api'
import { groupPath, groupRef } from '~/shared/groups'

export const Route = createFileRoute('/$group')({
  /** Every group page reads the group by its ID, from `groupId` in the route context. */
  beforeLoad: async ({ context, params, location }) => {
    const { queryClient } = context
    // The group read starts beside the session read, so a first visit sends both in one request.
    const group = resolveGroup({ queryClient, segment: params.group })
    group.catch(() => undefined)
    // A signed-out visitor returns here after sign-in (P-AUTH-49).
    await requireSignedIn({ queryClient, location })
    const g = await group.catch((error: unknown) => {
      // Not a member, or no such group: the directory explains (P-GROUP-21, P-GROUP-46).
      if (rpcError(error)._tag === 'Forbidden') throw redirect({ to: '/groups', search: { access: 'denied' }, replace: true })
      throw error
    })
    // A private context has no group pages: its expense page shows it (P-GROUP-47, P-UNGROUP-39).
    if (g.contextExpenseId) throw redirect({ to: '/expenses/$expenseId', params: { expenseId: g.contextExpenseId }, replace: true })
    // An ID, an old slug or another letter case moves to the group's current URL (P-GROUP-105, P-GROUP-106).
    if (params.group !== groupRef(g)) {
      const rest = location.pathname.split('/').slice(2).join('/')
      throw redirect({ href: `${groupPath(g)}${rest ? `/${rest}` : ''}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true })
    }
    return { groupId: g.id }
  },
  // The page title reads the group's name from here (page-title.ts).
  loader: ({ context }) => context.queryClient.ensureQueryData(groupQuery(context.groupId)),
  component: GroupLayout,
})

const TABS = [
  { to: '/$group/expenses', label: 'Expenses' },
  { to: '/$group/payments', label: 'Payments' },
  { to: '/$group/balances', label: 'Balances' },
  { to: '/$group/information', label: 'Information' },
  { to: '/$group/stats', label: 'Stats' },
  { to: '/$group/activity', label: 'Log' },
  { to: '/$group/edit', label: 'Settings' },
] as const

/**
 * Every group page shares this layout: tabs above, the tab's content on the
 * left, and a sticky net-balance rail on the right. The rail always describes
 * the whole group, whatever the tab filters; on mobile it becomes a compact
 * expandable summary above the content. Do not recreate it in a tab.
 */
function GroupLayout() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  // On a phone the expense and payment forms need the whole screen; the rail stays on the tabs.
  const onForm = useRouterState({ select: (s) => s.matches.some((m) => FORM_ROUTES.has(m.routeId)) })
  // The Balances tab shows every balance itself, so the rail keeps only the viewer's summary there.
  const onBalances = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === '/$group/balances') })
  const tabs = useActiveTabInView()
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-3 sm:px-8 md:py-6">
      <div className="mb-2 flex items-center justify-between gap-3 md:mb-3">
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
        {/* On narrow screens the row scrolls; the fade at the right edge shows that more tabs follow.
            The end padding is as wide as the fade, so the last tab can scroll clear of it. */}
        <nav
          ref={tabs}
          aria-label="Group"
          className="flex gap-x-1 overflow-x-auto ps-4 pe-10 [mask-image:linear-gradient(to_right,#000_calc(100%-2.5rem),transparent)] [scrollbar-width:none] sm:gap-x-6 sm:px-0 sm:[mask-image:none]"
        >
          {TABS.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              params={{ group }}
              className="press inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-2 py-3 text-sm whitespace-nowrap text-muted-foreground sm:px-0"
              activeProps={{ className: 'border-primary! text-foreground! font-medium' }}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <BalanceRail groupId={groupId} group={group} hideOnMobile={onForm} summaryOnly={onBalances} />
        <div className="min-w-0 md:col-start-1 md:row-start-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}

/** The fade at the right edge of the tab row (its mask), which the active tab must clear. */
const TAB_FADE_PX = 40

/**
 * On narrow screens the tab row scrolls, so a page opened on Stats, Log or
 * Settings would start with its own tab out of view. After each navigation
 * this scrolls the row, without animation, until the active tab is in view.
 */
function useActiveTabInView() {
  const nav = useRef<HTMLElement>(null)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  useLayoutEffect(() => {
    const row = nav.current
    const active = row?.querySelector('[aria-current="page"]')
    if (!row || !active) return
    const box = row.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    const padding = parseFloat(getComputedStyle(row).paddingLeft)
    if (tab.left < box.left + padding) row.scrollLeft -= box.left + padding - tab.left
    else if (tab.right > box.right - TAB_FADE_PX) row.scrollLeft += tab.right - (box.right - TAB_FADE_PX)
  }, [pathname])
  return nav
}

const FORM_ROUTES: ReadonlySet<string> = new Set<keyof FileRoutesById>(['/$group/expenses/create', '/$group/expenses/$expenseId/edit', '/$group/payments/create', '/$group/payments/$expenseId/edit'])

type Entry = typeof CurrencyBalances.Type

/**
 * The net balances of the whole group, ported from the current app's
 * group-balance-summary.tsx. It reads its own balances query, so a failed load
 * stays in the rail. On narrow screens each currency is a closed <details>.
 */
function BalanceRail({ groupId, group, hideOnMobile, summaryOnly }: { groupId: string; group: string; hideOnMobile: boolean; summaryOnly: boolean }) {
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  // As in the current app: fresh balances on mount and on window focus (P-BAL-58).
  // The data is stale after one second, so a rail that mounts after the Balances
  // or Payments loader read the same balances does not read them again.
  const { data, isPending, isError, isFetching, refetch } = useQuery({ ...balancesQuery(groupId), staleTime: 1000 })
  const participantId = g.participantId
  return (
    <aside
      aria-label="Group balances"
      data-testid="group-balance-summary"
      className={cn(
        'relative z-20 h-fit self-start rounded-2xl border bg-card p-3 md:sticky md:p-6 md:top-24 md:col-start-2 md:row-start-1 md:max-h-[calc(100dvh-7rem)] md:overflow-y-auto',
        hideOnMobile && 'max-md:hidden',
      )}
    >
      {/* On narrow screens the heading is for screen readers and the refresh button sits in the summary row. */}
      <div className="flex items-center justify-between gap-2 max-md:absolute max-md:end-2 max-md:top-2.5">
        <h2 className="text-base font-semibold leading-tight max-md:sr-only">Group balances</h2>
        <Button variant="ghost" size="icon" className="hit-area relative h-7 w-7 md:-my-1.5" onClick={() => void refetch()} disabled={isFetching} aria-label="Refresh balances">
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1 mb-4 hidden text-xs text-muted-foreground md:block">Net balance of all group expenses</p>
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
                  {ownTotal === null ? 'Group balances' : netLabel(ownTotal, 'you')} · {entry.currency}
                </div>
                {ownTotal !== null && (
                  <div className={cn('mt-1 text-lg font-semibold tabular-nums max-md:mt-0 md:text-xl', NET_CLASS[netTone(ownTotal)])} data-testid="summary-personal-net">
                    {money(magnitude(ownTotal), entry.currency)}
                  </div>
                )}
              </div>
            )
            const details = <BalanceDetails entry={entry} participants={g.participants} participantId={participantId} />
            return (
              <section key={entry.currency} aria-label={`${entry.currency} balances`}>
                <details className="pe-9 md:hidden">
                  <DisclosureSummary hint="Details" className="min-h-7 gap-3 font-normal">
                    {summary}
                  </DisclosureSummary>
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

function BalanceDetails(props: { entry: Entry; participants: ReadonlyArray<typeof Participant.Type>; participantId: string | null }) {
  const { entry, participants, participantId } = props
  const currency = entry.currency
  const nets = new Map(entry.balances.map((b) => [b.participantId, b.net]))
  return (
    <div className="space-y-4">
      <ul className="space-y-3" aria-label={`${currency} balance of each person`}>
        {participants.map((person) => {
          const total = nets.get(person.id) ?? '0'
          return (
            <li key={person.id} className="space-y-0.5" data-testid="summary-participant" data-participant={person.name}>
              <div className="text-sm font-medium break-words">
                {person.name}
                {person.id === participantId && <span className="font-normal text-muted-foreground"> (you)</span>}
              </div>
              <div className={cn('text-sm tabular-nums', NET_CLASS[netTone(total)])} data-testid="summary-net">
                {netLabel(total, 'them')}
                {!isZero(total) && <> {money(magnitude(total), currency)}</>}
              </div>
            </li>
          )
        })}
      </ul>
      <RailSettlements currency={currency} settlements={entry.settlements} names={new Map(participants.map((p) => [p.id, p.name]))} viewer={participantId} />
    </div>
  )
}
