// The collapsed "Expense log" under the Save button of the expense and payment
// editors (P-HIST-80 to P-HIST-87), as in the current app's expense-log.tsx.
// The editors belong to the expenses area: render <ExpenseLog> there.
import { useInfiniteQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { activitiesQuery } from '~/client/queries/history'
import { Button } from '~/client/ui/button'
import type { Activity } from '~/shared/api'
import { ActivityRevision } from './revision'

type Props = { group: string; groupId: string; expenseId: string }

export function ExpenseLog(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <details className="group/expense-log mt-6 border-t border-border/60 pt-3" onToggle={(event) => setOpen(event.currentTarget.open)} data-testid="expense-log">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open/expense-log:rotate-90" />
        Expense log
      </summary>
      {/* Nothing loads until the log is opened (P-HIST-81). */}
      {open && <Entries {...props} />}
    </details>
  )
}

const stamp = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })

function what(entry: typeof Activity.Type) {
  const action = entry.expenseRevision === 0 || entry.source === 'baseline' ? 'History started' : entry.type === 'create_expense' ? 'Added' : entry.type === 'delete_expense' ? 'Deleted' : 'Edited'
  return `${action} by ${entry.actorName ?? (entry.source === 'system' ? 'automatic schedule' : 'unknown author')}`
}

function Entries({ group, groupId, expenseId }: Props) {
  // Pages after the first reuse its boundary, so edits made while the log is open do not shift it (P-HIST-83).
  const query = useInfiniteQuery({ ...activitiesQuery(group, { expenseId }), staleTime: Infinity, refetchOnWindowFocus: false })
  if (query.error && !query.data)
    return (
      <p role="alert" className="mt-3 text-sm">
        {query.error instanceof Error ? query.error.message : 'The log could not load.'}
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
              <time dateTime={entry.time}>{stamp.format(new Date(entry.time))}</time>
            </p>
            <p className="my-1 text-sm">{what(entry)}</p>
            <ActivityRevision activity={entry} groupId={groupId} />
          </li>
        ))}
      </ol>
      {query.error && (
        <p role="alert" className="text-sm">
          {query.error instanceof Error ? query.error.message : 'Older entries could not load.'}
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
