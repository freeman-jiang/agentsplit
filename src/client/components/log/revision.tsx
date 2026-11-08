// The saved-revision panel of a Log event, as in the current app's
// activity-revision.tsx: every field, the changes from the revision before,
// and links to saved attachments.
import { DisclosureSummary } from '~/client/ui/disclosure'
import type { Activity } from '~/shared/api'
import { describeRevision, isBaseline, REVISION_FIELDS } from '~/shared/history'
import { RECEIPT_URL_PREFIX, receiptDownloadPath } from '~/shared/paths'
import { tombstoneText } from '../receipt-files'
import { fieldChanged } from './revision-diff'

type ActivityItem = typeof Activity.Type

/** The URL schemes of stored receipts: the current app's storage URLs, and v2's own pointers. */
const RECEIPT_PROTOCOLS = ['http:', 'https:', new URL(RECEIPT_URL_PREFIX).protocol]

/**
 * Only a stored receipt's URL scheme becomes a link; a `javascript:` URL never
 * does (P-HIST-76). The link is always /api/receipts.
 */
function receiptLink(data: { groupId: string; url: string }) {
  try {
    const parsed = new URL(data.url)
    if (!RECEIPT_PROTOCOLS.includes(parsed.protocol)) return undefined
  } catch {
    return undefined
  }
  return receiptDownloadPath(data)
}

/** Who recorded the change, without user IDs (docs/history/v2/DECISIONS.md, P-HIST-75). */
function author(activity: ActivityItem) {
  if (isBaseline(activity)) return 'The log starts here. The expense existed before.'
  if (activity.source === 'system') return 'Created by the recurring schedule'
  if (activity.verified) return `Recorded by ${activity.actorName ?? 'an account'}${activity.agent ? ' through an agent' : ''}`
  return 'The author name is not verified.'
}

export function ActivityRevision({ activity, groupId }: { activity: ActivityItem; groupId: string }) {
  const state = activity.snapshot ?? activity.previousSnapshot
  // Opening a panel must not follow the event's link (P-HIST-79).
  const stop = (event: React.SyntheticEvent) => event.stopPropagation()
  if (!state) return <p className="mt-1 text-xs text-muted-foreground">No saved details for this change.</p>
  if (state._tag === 'group') {
    const g = state.group
    return (
      <details onClick={stop} className="mt-1 text-xs sm:border-l sm:border-border/60 sm:pl-3">
        <DisclosureSummary quiet>Show saved group settings</DisclosureSummary>
        <div className="mt-2 space-y-1 rounded-xl bg-muted/50 p-3">
          <p>
            {g.name} · {g.currency}
          </p>
          {g.information && <p className="whitespace-pre-wrap">{g.information}</p>}
          {g.slug && <p>/{g.slug}</p>}
          <p>{g.participants.map((p) => p.name).join(', ')}</p>
          {!activity.verified && <p className="text-muted-foreground">The author name is not verified.</p>}
        </div>
      </details>
    )
  }
  const saved = state.expense
  const current = describeRevision(saved)
  const previous = activity.snapshot?._tag === 'expense' && activity.previousSnapshot?._tag === 'expense' ? describeRevision(activity.previousSnapshot.expense) : undefined
  const deleted = activity.type === 'delete_expense'
  return (
    <details onClick={stop} className="mt-1 text-xs sm:border-l sm:border-border/60 sm:pl-3" data-testid="revision">
      <DisclosureSummary quiet>
        Show revision {saved.revision}
        {deleted ? ' · Deleted' : ''}
      </DisclosureSummary>
      <div className="mt-2 space-y-2 rounded-xl bg-muted/50 p-3">
        {deleted && <p>Deleted. The balances no longer include it. The log keeps this version.</p>}
        <p className="text-muted-foreground">{author(activity)}</p>
        {previous && <p className="font-medium">Changes from the previous revision</p>}
        <dl className="space-y-2">
          {REVISION_FIELDS.map(([key, label]) => {
            const changed = previous !== undefined && fieldChanged({ field: key, previous: previous[key], current: current[key] })
            return (
              <div key={key}>
                <dt className={changed ? 'font-semibold' : 'text-muted-foreground'}>
                  {label}
                  {changed ? ' *' : ''}
                </dt>
                <dd className="whitespace-pre-wrap break-words">
                  {changed && (
                    <>
                      <del className="text-muted-foreground">{previous[key] || '—'}</del>
                      {' → '}
                    </>
                  )}
                  {current[key] || '—'}
                </dd>
              </div>
            )
          })}
        </dl>
        {saved.documents.map((document, index) => {
          if (document.deleted)
            return (
              <p key={document.id} className="text-muted-foreground">
                {tombstoneText(document.deleted)}
              </p>
            )
          const href = receiptLink({ groupId, url: document.url })
          return href ? (
            <a key={document.id} href={href} target="_blank" rel="noopener noreferrer" className="block underline">
              Open receipt {index + 1}
            </a>
          ) : null
        })}
      </div>
    </details>
  )
}
