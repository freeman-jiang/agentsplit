import { requireSignedIn } from '~/client/queries/account'
import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'
import { ArrowLeftRight, BarChart3, Info, Receipt, Scale, ScrollText, Settings, Users } from 'lucide-react'
import { useState } from 'react'
import { cn } from '~/client/cn'
import { money } from '~/client/components/money'
import { groupQuery } from '~/client/queries'
import { Button } from '~/client/ui/button'
import { groupRef } from '~/shared/groups'

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
    // An ID, an old slug or another letter case moves to the group's current URL (P-GROUP-105, P-GROUP-106).
    const canonical = groupRef(g)
    if (params.group !== canonical) {
      context.queryClient.setQueryData(groupQuery(canonical).queryKey, g)
      const rest = location.pathname.split('/').slice(2).join('/')
      throw redirect({ href: `/${encodeURIComponent(canonical)}/${rest}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`, replace: true })
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
  return (
    <div className="mx-auto w-full max-w-6xl px-3 py-6 sm:px-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate font-display text-2xl">
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
      <nav aria-label="Group" className="mb-4 flex flex-wrap gap-x-2 gap-y-1 border-b sm:gap-x-4">
        {TABS.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            params={{ group }}
            className="inline-flex min-h-11 items-center gap-2 border-b-2 border-transparent px-2 py-3 text-xs text-muted-foreground sm:text-sm"
            activeProps={{ className: 'border-primary! text-primary!' }}
          >
            <Icon className="hidden h-4 w-4 lg:block" aria-hidden="true" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="md:hidden">
          <BalanceSummary group={group} />
        </div>
        <div className="min-w-0">
          <Outlet />
        </div>
        <aside className="hidden h-fit md:sticky md:top-24 md:block" aria-label="Balances">
          <BalanceRail group={group} />
        </aside>
      </div>
    </div>
  )
}

function useNets(group: string) {
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const names = new Map(g.participants.map((p) => [p.id, p.name]))
  return g.balances.map((b) => ({ ...b, name: names.get(b.participantId) ?? 'Unknown' }))
}

function NetList({ group }: { group: string }) {
  const nets = useNets(group)
  if (nets.length === 0) return <p className="text-sm text-muted-foreground">No balances yet.</p>
  return (
    <ul className="space-y-1 text-sm">
      {nets.map((b) => (
        <li key={`${b.participantId}-${b.currency}`} className="flex justify-between gap-2">
          <span className="truncate">{b.name}</span>
          <span className={cn('tabular-nums', b.net.startsWith('-') ? 'text-destructive' : 'text-primary')}>{money(b.net, b.currency)}</span>
        </li>
      ))}
    </ul>
  )
}

function BalanceRail({ group }: { group: string }) {
  return (
    <section className="border bg-card p-4">
      <h2 className="mb-2 font-medium">Balances</h2>
      <NetList group={group} />
    </section>
  )
}

function BalanceSummary({ group }: { group: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="border bg-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
        Balances
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          <NetList group={group} />
        </div>
      )}
    </section>
  )
}
