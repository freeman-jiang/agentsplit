import { formatMoment } from '~/client/dates'
import type { Attribution } from '~/shared/api'

const stamp = (value: string) => (
  <time dateTime={value} title={formatMoment.full(value)}>
    {formatMoment.dateTime(value)}
  </time>
)

/**
 * Who added and last edited an entry, above its edit form, as the current
 * app's expense-metadata.tsx shows it (P-EXP-45, P-FEED-39). `createdAt` is
 * the entry's own time, for an entry whose history does not say when it was added.
 */
export function EntryAttribution(props: { attribution: typeof Attribution.Type; createdAt: string }) {
  const a = props.attribution
  return (
    <div className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground" data-testid="expense-metadata">
      <p>
        Added {stamp(a.createdAt ?? props.createdAt)}
        {a.createdBy ? ` by ${a.createdBy.name}` : ' · author unknown'}
      </p>
      {a.updatedAt && (
        <p>
          Last edited {stamp(a.updatedAt)}
          {a.updatedBy ? ` by ${a.updatedBy.name}` : ''}
        </p>
      )}
      {a.lastEditedByYouAt && <p>Your last edit {stamp(a.lastEditedByYouAt)}</p>}
    </div>
  )
}
