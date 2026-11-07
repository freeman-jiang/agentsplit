import { useInfiniteQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '~/client/cn'
import { ActivityRevision } from '~/client/components/log/revision'
import { formatMoment } from '~/client/dates'
import { editorLink } from '~/client/editor-link'
import { describeError } from '~/client/errors'
import { useInfiniteScroll } from '~/client/hooks'
import { activitiesQuery } from '~/client/queries/history'
import { Skeleton } from '~/client/ui/skeleton'
import type { Activity } from '~/shared/api'
import { isBaseline } from '~/shared/history'

type ActivityItem = typeof Activity.Type

export const Route = createFileRoute('/$group/activity')({
  loader: ({ context }) => context.queryClient.ensureInfiniteQueryData(activitiesQuery(context.groupId)),
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

/** The Log's weeks start as the app's locale (en-US) starts them: on Sunday. */
const WEEK_START = 0

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


function Summary({ activity }: { activity: ActivityItem }) {
  const name = activity.actorName ?? 'Someone'
  // One weight for the people and expenses in a line, instead of bold and italic.
  const who = <span className="font-medium text-foreground">{name}</span>
  // The server fills an expense event's `data` with the title of its latest saved state (activityText in server/activity.ts).
  const expenseTitle = activity.data ?? ''
  const title = <span className="font-medium text-foreground">“{expenseTitle}”</span>
  if (isBaseline(activity))
    return (
      <>
        History begins here for an existing expense: <span className="font-medium text-foreground">{expenseTitle}</span>
      </>
    )
  switch (activity.type) {
    case 'create_group':
      return <>{who} created the group</>
    case 'join_group':
      return <>{who} joined the group</>
    case 'leave_group':
      return <>{who} left the group</>
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
      <h2 className="font-display text-xl">Log</h2>
      <p className="mb-6 text-sm text-muted-foreground">Changes recorded in this group.</p>
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
  const { groupId } = Route.useRouteContext()
  const query = useInfiniteQuery(activitiesQuery(groupId))
  // The next page loads when its placeholder scrolls into view (P-HIST-65).
  const more = useInfiniteScroll<HTMLDivElement>(query)

  if (query.error)
    return (
      <LogHeader>
        <p role="alert" className="text-sm">
          {describeError(query.error).message}
        </p>
      </LogHeader>
    )
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
      <div className="space-y-6">
        {DATE_GROUPS.map(([key, label]) => {
          const items = byGroup.get(key)
          if (!items?.length) return null
          return (
            <div key={key}>
              <h3 className="eyebrow">{label}</h3>
              {/* Faint lines tie each event to its revision line. */}
              <div className="divide-y divide-border/50">
                {items.map((activity) => (
                  <LogItem key={activity.id} group={group} groupId={groupId} activity={activity} showDate={key !== 'today' && key !== 'yesterday'} />
                ))}
              </div>
            </div>
          )
        })}
        {query.hasNextPage && <Placeholder ref={more} />}
      </div>
    </LogHeader>
  )
}

function LogItem({ group, groupId, activity, showDate }: { group: string; groupId: string; activity: ActivityItem; showDate: boolean }) {
  const navigate = useNavigate()
  // Only events of a live expense open it; deleted expenses are not clickable (P-HIST-70).
  const link = activity.expense && activity.expenseId ? editorLink({ group, expenseId: activity.expenseId, kind: activity.expense.kind }) : undefined
  return (
    // -mx-2: the text lines up with the headings, and the hover surface reaches past it.
    <div
      className={cn('group -mx-2 flex items-start gap-3 px-2 py-2 text-sm hover:bg-accent sm:py-2.5', link && 'cursor-pointer')}
      onClick={link ? () => void navigate(link) : undefined}
      data-testid="log-item"
    >
      <div className={cn('shrink-0 text-xs/5 tabular-nums text-muted-foreground', showDate ? 'w-24' : 'w-16')}>
        {showDate && (
          <time className="block" dateTime={activity.time}>
            {formatMoment.date(activity.time)}
          </time>
        )}
        <time className="block" dateTime={activity.time}>
          {formatMoment.time(activity.time)}
        </time>
      </div>
      <div className="min-w-0 flex-1">
        {/* The connecting words are muted; names and titles stay in ink. */}
        <div className="leading-5 text-muted-foreground">
          <Summary activity={activity} />
        </div>
        <ActivityRevision activity={activity} groupId={groupId} />
      </div>
      {link && (
        <Link {...link} onClick={(e) => e.stopPropagation()} aria-label="Open expense" className="hidden h-5 w-5 shrink-0 self-center text-muted-foreground/40 group-hover:text-foreground sm:flex">
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  )
}
