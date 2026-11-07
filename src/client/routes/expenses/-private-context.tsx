// The parts of the /expenses pages that show where an expense lives.
import { Link } from '@tanstack/react-router'
import type { ExpenseContext } from '~/shared/api'
import { Input } from '~/client/ui/input'
import { groupRef } from '~/shared/groups'

/**
 * The line above an expense or a repayment: back to the dashboard, and the
 * group, or the people of a private expense. A repayment names what it repays.
 */
export function PrivateContextHeader({ data, repayment }: { data: typeof ExpenseContext.Type; repayment: boolean }) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/" className="underline">
          ← All expenses
        </Link>
        {data.context ? (
          <span className="text-muted-foreground">No group · Private to {data.participants.map((p) => p.name).join(', ')}</span>
        ) : (
          <Link to="/$group/expenses" params={{ group: groupRef(data.group) }} className="underline">
            {data.group.name}
          </Link>
        )}
      </div>
      {data.context && repayment && (
        <p className="text-sm">
          Repayment for{' '}
          <Link to="/expenses/$expenseId" params={{ expenseId: data.context.expenseId }} className="underline">
            {data.context.title}
          </Link>
        </p>
      )}
    </>
  )
}

/** A private invitation link, selected whole on focus so it is easy to copy. */
export function InvitationLink({ url }: { url: string }) {
  return <Input readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
}
