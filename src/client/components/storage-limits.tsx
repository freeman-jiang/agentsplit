// Settings, Storage and limits: receipt storage against the fair-use quota,
// the other per-account limits, and the caller's receipts with permanent
// delete. The limits come from src/shared/limits.ts, the usage from the server.
import { useInfiniteQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { cn } from '~/client/cn'
import { formatMoment } from '~/client/dates'
import { afterWrite } from '~/client/queries/keys'
import { ownReceiptsQuery, storageUsageQuery, type ReceiptOrder } from '~/client/queries/storage'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { NativeSelect } from '~/client/ui/native-select'
import { FAIR_USE, LIMITS, megabytes } from '~/shared/limits'
import { DeleteDialog } from './delete-dialog'

export function StorageLimits() {
  const { data: usage } = useSuspenseQuery(storageUsageQuery)
  const { usedBytes, limitBytes, elsewhereBytes } = usage.receipts
  const percent = Math.min(100, (usedBytes / limitBytes) * 100)
  return (
    <section className="space-y-5 border-t pt-6" aria-labelledby="storage-heading">
      <div className="space-y-1">
        <h2 id="storage-heading" className="text-xl font-medium">
          Storage and limits
        </h2>
        <p className="text-sm text-muted-foreground">AgentSplit is free, with no paid plan. {FAIR_USE}</p>
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium">Receipt storage</span>
          <span className="tabular-nums">
            {megabytes(usedBytes)} of {megabytes(limitBytes)}
          </span>
        </div>
        <div
          role="meter"
          aria-label="Receipt storage used"
          aria-valuemin={0}
          aria-valuemax={limitBytes}
          aria-valuenow={usedBytes}
          aria-valuetext={`${megabytes(usedBytes)} of ${megabytes(limitBytes)}`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          {/* A sliver stays visible for a small nonzero use. */}
          <div
            className={cn('h-full rounded-full', percent >= 90 ? 'bg-destructive' : 'bg-primary')}
            style={{ width: `${percent}%`, minWidth: usedBytes > 0 ? '0.25rem' : 0 }}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Receipts you upload count here until you delete them. Download a group’s receipts from its Expenses tab, under Export.
        </p>
        {elsewhereBytes > 0 && (
          <p className="text-sm text-muted-foreground">
            {megabytes(elsewhereBytes)} of this is in groups you have left. An admin of such a group can delete those receipts.
          </p>
        )}
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Limit label="Groups you created" value={`${usage.groups.created} of ${usage.groups.limit}`} />
        <Limit label="API keys" value={`${usage.apiKeys.count} of ${usage.apiKeys.limit}`} />
        <Limit label="People in one group" value={`Up to ${LIMITS.participantsPerGroup}`} />
        <Limit label="Changes" value={`About ${LIMITS.writesPerMinute} a minute`} />
        <Limit label="One receipt image" value={`Up to ${megabytes(LIMITS.receiptBytes)}`} />
      </dl>
      <Receipts />
    </section>
  )
}

function Limit(props: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1.5">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="tabular-nums">{props.value}</dd>
    </div>
  )
}

function Receipts() {
  const queryClient = useQueryClient()
  const [order, setOrder] = useState<ReceiptOrder>('largest')
  const pages = useInfiniteQuery(ownReceiptsQuery(order))
  const receipts = pages.data?.pages.flatMap((page) => page.receipts) ?? []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Your receipts</h3>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Sort</span>
          <NativeSelect
            aria-label="Sort receipts"
            wrapperClassName="w-40"
            value={order}
            onChange={(event) => setOrder(event.target.value === 'oldest' ? 'oldest' : 'largest')}
          >
            <option value="largest">Largest first</option>
            <option value="oldest">Oldest first</option>
          </NativeSelect>
        </label>
      </div>
      {pages.isPending ? (
        <p className="text-sm text-muted-foreground">Loading receipts…</p>
      ) : pages.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load your receipts.
        </p>
      ) : receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">You have not uploaded any receipts.</p>
      ) : (
        <ul className="divide-y border-y">
          {receipts.map((receipt) => (
            <li key={receipt.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1 basis-56 text-sm">
                <p className="truncate font-medium">
                  {receipt.expense ? `${receipt.expense.deleted ? 'Deleted expense: ' : ''}${receipt.expense.title}` : 'Not on an expense'}
                </p>
                <p className="text-muted-foreground">
                  {receipt.groupName ?? 'Ungrouped expense'} · <span className="tabular-nums">{megabytes(receipt.bytes)}</span> · {formatMoment.date(receipt.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button asChild variant="outline" size="sm">
                  <a href={receipt.downloadUrl} target="_blank" rel="noopener noreferrer">
                    Open
                  </a>
                </Button>
                <DeleteDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      Delete
                    </Button>
                  }
                  title="Delete this receipt for good?"
                  description={`It frees ${megabytes(receipt.bytes)}. The image is removed for everyone in ${receipt.groupName ?? 'this expense'}, from the expense and from its history, which will show who deleted it and when. This cannot be undone.`}
                  onConfirm={async () => {
                    await rpc((api) => api('storage.deleteReceipts', { receiptIds: [receipt.id] }))
                    // The expense has a new revision too, in any group.
                    await afterWrite({ queryClient, scope: 'account' })
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage && (
        <Button variant="outline" size="sm" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {pages.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </div>
  )
}
