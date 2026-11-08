// The Stats tab's drill-down list, loaded on demand so the tab itself stays small.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { money } from '~/client/components/money'
import { formatDay } from '~/client/dates'
import { editorLink } from '~/client/editor-link'
import { describeError } from '~/client/errors'
import { statsExpensesQuery } from '~/client/queries/history'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '~/client/ui/dialog'
import { Skeleton } from '~/client/ui/skeleton'
import type { CurrencyCode } from '~/shared/currencies'

type Props = {
  drill: { group: string; groupId: string; range: { from?: string; to?: string } }
  scope: { currency: CurrencyCode; month?: string; categoryId?: number }
  title: string
  description: string
  empty: string
  open: boolean
  onClose: () => void
}

/** The drill-down list: loads when opened, newest first, each row opening its expense (P-STATS-27, P-STATS-31 to P-STATS-33). */
export default function ExpensesDialog(props: Props) {
  const { drill, scope } = props
  const { data, error } = useQuery(statsExpensesQuery(drill.groupId, { ...scope, ...(drill.range.from ? { from: drill.range.from } : {}), ...(drill.range.to ? { to: drill.range.to } : {}) }))
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      {/* The top edge stays at 10% of the screen, so the header does not move when the rows arrive.
          The list's row is bounded by the dialog's height, so the list scrolls. */}
      <DialogContent className="top-[10dvh] max-h-[80dvh] translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1.5 border-b p-6">
          <DialogTitle className="flex items-center gap-2">{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto">
          {error ? (
            <p role="alert" className="p-6 text-sm">
              {describeError(error).message}
            </p>
          ) : !data ? (
            // Rows of the same size as the real ones, so a full list does not change the dialog's height.
            <ul aria-hidden="true" className="divide-y">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <li key={i} className="flex items-center justify-between gap-2 px-6 py-3">
                  <div className="flex flex-col gap-1">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-5 w-40" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="h-5 w-16" />
                </li>
              ))}
            </ul>
          ) : data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{props.empty}</p>
          ) : (
            <ul className="animate-fade-in divide-y">
              {data.map((e) => (
                <li key={e.id}>
                  <Link {...editorLink({ group: drill.group, expenseId: e.id, kind: e.kind })} className="flex items-center justify-between gap-2 px-6 py-3 text-sm hover:bg-accent">
                    <div className="min-w-0">
                      {e.vendor && <div className="mb-1 truncate text-xs text-muted-foreground">{e.vendor}</div>}
                      <div className="truncate">{e.title}</div>
                      <div className="text-xs text-muted-foreground">{formatDay(e.expenseDate)}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="font-bold tabular-nums">{money(e.amount, e.currency)}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
