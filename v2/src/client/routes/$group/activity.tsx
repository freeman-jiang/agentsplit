import { useInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '~/client/cn'
import { AppLink, expenseHref } from '~/client/components/history/app-link'
import { ActivityRevision } from '~/client/components/history/revision'
import { groupQuery } from '~/client/queries'
import { activitiesQuery } from '~/client/queries/history'
import { Skeleton } from '~/client/ui/skeleton'
import type { Activity } from '~/shared/api'

type ActivityItem = typeof Activity.Type

export const Route = createFileRoute('/$group/activity')({
  loader: ({ context, params }) => context.queryClient.ensureInfiniteQueryData(activitiesQuery(params.group)),
  pendingComponent: LogLoading,
  component: LogTab,
})

// ---------- date groups (P-HIST-66) ----------

const DATE_GROUPS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['earlierThisWeek', 'Earlier this week'],
  ['lastWeek', 'Last week'],
  ['earlierThisMonth', 'Earlier this month'],
  ['lastMonth', 'Last month'],
  ['earlierThisYear', 'Earlier this year'],
  ['lastYear', 'Last year'],
  ['older', 'Older'],
] as const
type DateGroup = (typeof DATE_GROUPS)[number][0]

/** The first day of the week for the app's locale (en-US: Sunday), as Intl reports it; Monday if unknown. */
function weekStartsOn(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    if (firstDay) return firstDay % 7
  } catch {
    // Missing week information: use the default below.
  }
  return 1
}
const WEEK_START = weekStartsOn('en-US')

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
const startOfWeek = (d: Date) => addDays(startOfDay(d), -((d.getDay() - WEEK_START + 7) % 7))
const sameDay = (a: Date, b: Date) => startOfDay(a).getTime() === startOfDay(b).getTime()
const monthIndex = (d: Date) => d.getFullYear() * 12 + d.getMonth()

/** The current app's buckets, in local time. */
function dateGroup(date: Date, today: Date): DateGroup {
  if (sameDay(date, today)) return 'today'
  if (sameDay(date, addDays(today, -1))) return 'yesterday'
  if (sameDay(startOfWeek(date), startOfWeek(today))) return 'earlierThisWeek'
  if (sameDay(startOfWeek(date), startOfWeek(addDays(today, -7)))) return 'lastWeek'
  if (monthIndex(date) === monthIndex(today)) return 'earlierThisMonth'
  if (monthIndex(date) === monthIndex(today) - 1) return 'lastMonth'
  if (date.getFullYear() === today.getFullYear()) return 'earlierThisYear'
  if (date.getFullYear() === today.getFullYear() - 1) return 'lastYear'
  return 'older'
}

// ---------- summaries (P-HIST-68) ----------

// The server fills `data` with the title of the latest saved state (activityData in server/sql.ts).
function expenseTitle(activity: ActivityItem) {
  return activity.data ?? ''
}

function Summary({ activity }: { activity: ActivityItem }) {
  const name = activity.actorName ?? 'Someone'
  const who = <strong>{name}</strong>
  const title = <em>“{expenseTitle(activity)}”</em>
  if (activity.expenseRevision === 0 || activity.source === 'baseline')
    return (
      <>
        History begins here for an existing expense: <em>{expenseTitle(activity)}</em>
      </>
    )
  switch (activity.type) {
    case 'create_group':
      return <>{name} created the group</>
    case 'join_group':
      return <>{name} joined the group</>
    case 'leave_group':
      return <>{name} left the group</>
    case 'update_group':
      // Access changes say what changed, never whom (P-ACCESS-30).
      return activity.data ? (
        <>
          {activity.data} by {who}.
        </>
      ) : (
        <>Group settings were modified by {who}.</>
      )
    case 'create_expense':
      return (
        <>
          Expense {title} created by {who}.
        </>
      )
    case 'update_expense':
      return (
        <>
          Expense {title} updated by {who}.
        </>
      )
    case 'delete_expense':
      return (
        <>
          Expense {title} deleted by {who}.
        </>
      )
  }
}

// ---------- page ----------

function LogHeader({ children }: { children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-2xl leading-tight">Log</h2>
      <p className="mb-4 text-sm text-muted-foreground">Changes recorded in this group.</p>
      {children}
    </section>
  )
}

function Placeholder({ ref }: { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="flex flex-col gap-4" aria-label="Loading">
      <Skeleton className="mt-2 h-3 w-24" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex gap-2 p-2">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </div>
  )
}

function LogLoading() {
  return (
    <LogHeader>
      <Placeholder />
    </LogHeader>
  )
}

function LogTab() {
  const { group } = Route.useParams()
  const { data: g } = useSuspenseQuery(groupQuery(group))
  const query = useInfiniteQuery(activitiesQuery(group))
  const more = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query

  // The next page loads when its placeholder scrolls into view (P-HIST-65).
  useEffect(() => {
    const node = more.current
    if (!node || !hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  if (query.error) return <LogHeader><p role="alert" className="text-sm">{query.error instanceof Error ? query.error.message : 'The Log could not load.'}</p></LogHeader>
  if (!query.data) return <LogLoading />
  const activities = query.data.pages.flatMap((p) => p.activities)
  if (activities.length === 0)
    return (
      <LogHeader>
        <p className="py-6 text-sm">There is not yet any activity in your group.</p>
      </LogHeader>
    )
  const today = new Date()
  const byGroup = Map.groupBy(activities, (a) => dateGroup(new Date(a.time), today))
  return (
    <LogHeader>
      {DATE_GROUPS.map(([key, label]) => {
        const items = byGroup.get(key)
        if (!items?.length) return null
        return (
          <div key={key}>
            <h3 className="pb-2 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</h3>
            {items.map((activity) => (
              <LogItem key={activity.id} group={group} groupId={g.id} activity={activity} showDate={key !== 'today' && key !== 'yesterday'} />
            ))}
          </div>
        )
      })}
      {hasNextPage && <Placeholder ref={more} />}
    </LogHeader>
  )
}

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' })
const timeFormat = new Intl.DateTimeFormat('en-US', { timeStyle: 'short' })

function LogItem({ group, groupId, activity, showDate }: { group: string; groupId: string; activity: ActivityItem; showDate: boolean }) {
  const router = useRouter()
  const time = new Date(activity.time)
  // Only events of a live expense open it; deleted expenses are not clickable (P-HIST-70).
  const href = activity.expense && activity.expenseId ? expenseHref({ group, expenseId: activity.expenseId, kind: activity.expense.kind }) : undefined
  return (
    <div
      className={cn('flex items-stretch justify-between gap-1 px-2 py-2 text-sm hover:bg-accent sm:rounded-lg sm:pl-2 sm:pr-1', href && 'cursor-pointer')}
      onClick={href ? () => router.history.push(href) : undefined}
      data-testid="log-item"
    >
      <div className="flex flex-col items-start justify-between">
        {showDate && <time className="mt-1 text-xs/5 text-muted-foreground" dateTime={activity.time}>{dateFormat.format(time)}</time>}
        <time className="my-1 text-xs/5 text-muted-foreground" dateTime={activity.time}>
          {timeFormat.format(time)}
        </time>
      </div>
      <div className="min-w-0 flex-1">
        <div className="m-1">
          <Summary activity={activity} />
        </div>
        <ActivityRevision activity={activity} groupId={groupId} />
      </div>
      {href && (
        <AppLink href={href} onClick={(e) => e.stopPropagation()} aria-label="Open expense" className="hidden h-5 w-5 self-center text-primary sm:flex">
          <ChevronRight className="h-4 w-4" />
        </AppLink>
      )}
    </div>
  )
}
