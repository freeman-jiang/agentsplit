// The collapsed "Expense log" under the Save button of the expense and payment
// editors (P-HIST-80 to P-HIST-87), as in the current app's expense-log.tsx.
import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { formatMoment } from '~/client/dates'
import { describeError } from '~/client/errors'
import { activitiesQuery } from '~/client/queries/history'
import { Button } from '~/client/ui/button'
import { DisclosureSummary } from '~/client/ui/disclosure'
import type { Activity } from '~/shared/api'
import { isBaseline } from '~/shared/history'
import { ActivityRevision } from './revision'

type Props = { groupId: string; expenseId: string }

export function ExpenseLog(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <details className="mt-6 border-t border-border/60 pt-3" onToggle={(event) => setOpen(event.currentTarget.open)} data-testid="expense-log">
      <DisclosureSummary quiet className="inline-flex min-h-9 gap-1.5 font-medium">
        Expense log
      </DisclosureSummary>
      {/* Nothing loads until the log is opened (P-HIST-81). */}
      {open && <Entries {...props} />}
    </details>
  )
}

function what(entry: typeof Activity.Type) {
  const action = isBaseline(entry) ? 'History started' : entry.type === 'create_expense' ? 'Added' : entry.type === 'delete_expense' ? 'Deleted' : 'Edited'
  return `${action} by ${entry.actorName ?? (entry.source === 'system' ? 'automatic schedule' : 'unknown author')}`
}

function Entries({ groupId, expenseId }: Props) {
  // Pages after the first reuse its boundary, and an open log does not read again on focus, so edits made while it is open do not shift it (P-HIST-83).
  const query = useInfiniteQuery({ ...activitiesQuery(groupId, { expenseId }), refetchOnWindowFocus: false })
  if (query.error && !query.data)
    return (
      <p role="alert" className="mt-3 text-sm">
        {describeError(query.error).message}
      </p>
    )
  if (!query.data)
    return (
      <p role="status" className="mt-3 text-sm">
        Loading log…
      </p>
    )
  const entries = query.data.pages.flatMap((p) => p.activities)
  if (entries.length === 0) return <p className="mt-3 text-sm text-muted-foreground">No recorded changes.</p>
  return (
    <div className="mt-3 space-y-3">
      <ol className="divide-y">
        {entries.map((entry) => (
          <li key={entry.id} className="py-3" data-testid="expense-log-entry">
            <p className="text-xs text-muted-foreground">
              <time dateTime={entry.time}>{formatMoment.dateTime(entry.time)}</time>
            </p>
            <p className="my-1 text-sm">{what(entry)}</p>
            <ActivityRevision activity={entry} groupId={groupId} />
          </li>
        ))}
      </ol>
      {query.error && (
        <p role="alert" className="text-sm">
          {describeError(query.error).message}
        </p>
      )}
      {query.hasNextPage && (
        <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading…' : 'Load older entries'}
        </Button>
      )}
    </div>
  )
}
