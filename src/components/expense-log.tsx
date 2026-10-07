'use client'

import { ActivityRevision } from '@/app/groups/[groupId]/activity/activity-revision'
import { Button } from '@/components/ui/button'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@/trpc/routers/_app'
import { ChevronRight } from 'lucide-react'
import { useLocale } from 'next-intl'
import { useState } from 'react'

type Props = { groupId: string; expenseId: string }
type Page = AppRouterOutput['groups']['activities']['list']

export function ExpenseLog({ groupId, expenseId }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="group/expense-log mt-6 border-t border-border/60 pt-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="expense-log"
    >
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="h-3.5 w-3.5 transition-transform group-open/expense-log:rotate-90"
        />
        Expense log
      </summary>
      {open && <LogSnapshot groupId={groupId} expenseId={expenseId} />}
    </details>
  )
}

function LogSnapshot({ groupId, expenseId }: Props) {
  const query = trpc.groups.activities.list.useQuery(
    { groupId, expenseId, limit: 20 },
    { refetchOnWindowFocus: false },
  )
  if (query.error)
    return (
      <p role="alert" className="mt-3 text-sm">
        {query.error.message}
      </p>
    )
  if (!query.data)
    return (
      <p role="status" className="mt-3 text-sm">
        Loading log…
      </p>
    )
  if (!query.data.activities.length)
    return (
      <p className="mt-3 text-sm text-muted-foreground">No recorded changes.</p>
    )
  return (
    <LogEntries
      key={query.data.atActivityId}
      groupId={groupId}
      expenseId={expenseId}
      firstPage={query.data}
    />
  )
}

function LogEntries({
  groupId,
  expenseId,
  firstPage,
}: Props & { firstPage: Page }) {
  const locale = useLocale()
  const query = trpc.groups.activities.list.useInfiniteQuery(
    {
      groupId,
      expenseId,
      limit: 20,
      atActivityId: firstPage.atActivityId ?? undefined,
    },
    {
      initialData: { pages: [firstPage], pageParams: [0] },
      staleTime: Infinity,
      getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    },
  )
  const entries = query.data.pages.flatMap((page) => page.activities)
  return (
    <div className="mt-3 space-y-3">
      <ol className="divide-y">
        {entries.map((entry) => (
          <li key={entry.id} className="py-3" data-testid="expense-log-entry">
            <p className="text-xs text-muted-foreground">
              <time dateTime={entry.time.toISOString()}>
                {entry.time.toLocaleString(locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </time>
            </p>
            <p className="my-1 text-sm">
              {entry.source === 'baseline'
                ? 'History started'
                : entry.activityType === 'CREATE_EXPENSE'
                  ? 'Added'
                  : entry.activityType === 'DELETE_EXPENSE'
                    ? 'Deleted'
                    : 'Edited'}
              {' by '}
              {entry.actorName ??
                (entry.source === 'system'
                  ? 'automatic schedule'
                  : 'unknown author')}
            </p>
            <ActivityRevision activity={entry} />
          </li>
        ))}
      </ol>
      {query.error && (
        <p role="alert" className="text-sm">
          {query.error.message}
        </p>
      )}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
        </Button>
      )}
    </div>
  )
}
