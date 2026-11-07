// The Stats tab's drill-down list, loaded on demand so the tab itself stays small.
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { money } from '~/client/components/money'
import { formatDay } from '~/client/dates'
import { editorLink } from '~/client/editor-link'
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
  onClose: () => void
}

/** The drill-down list: loads when opened, newest first, each row opening its expense (P-STATS-27, P-STATS-31 to P-STATS-33). */
export default function ExpensesDialog(props: Props) {
  const { drill, scope } = props
  const { data, isLoading } = useQuery(statsExpensesQuery(drill.groupId, { ...scope, ...(drill.range.from ? { from: drill.range.from } : {}), ...(drill.range.to ? { to: drill.range.to } : {}) }))
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="max-h-[80vh] gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1.5 border-b p-6">
          <DialogTitle className="flex items-center gap-2">{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto">
          {isLoading || !data ? (
            <div className="flex flex-col gap-3 p-6">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-5 w-full" />
              ))}
            </div>
          ) : data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">{props.empty}</p>
          ) : (
            <ul className="divide-y">
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
