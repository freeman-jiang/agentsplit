'use client'

import { describeExpenseRevision } from '@/lib/expense-history-display'
import { receiptDownloadUrl } from '@/lib/receipt-url'
import { useLocale, useTranslations } from 'next-intl'
import type { Activity } from './activity-item'

const labels = {
  title: 'Title',
  amount: 'Amount',
  date: 'Expense date',
  payer: 'Paid by',
  splits: 'Split between',
  splitMode: 'Split rule',
  reimbursement: 'Reimbursement',
  category: 'Category',
  originalAmount: 'Original amount',
  conversionRate: 'Exchange rate',
  recurrence: 'Recurrence',
  notes: 'Notes',
  attachments: 'Attachment references',
}

function receiptLink(url: string) {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.href
      : undefined
  } catch {
    return undefined
  }
}

export function ActivityRevision({ activity }: { activity: Activity }) {
  const locale = useLocale()
  const t = useTranslations('Activity')
  const label = (key: string, fallback: string) =>
    t.has(`History.${key}`) ? t(`History.${key}`) : fallback
  const snapshot = activity.snapshot ?? activity.previousSnapshot
  if (!snapshot)
    return (
      <p className="mx-1 text-xs text-muted-foreground">
        {label('legacy', 'Older summary; a complete revision was not saved.')}
      </p>
    )
  if (snapshot.kind === 'group')
    return (
      <details
        onClick={(event) => event.stopPropagation()}
        className="m-1 text-xs"
      >
        <summary className="cursor-pointer">
          {label('group', 'View saved group settings')}
        </summary>
        <p>
          {snapshot.group.name} ·{' '}
          {snapshot.group.currencyCode ?? snapshot.group.currency}
        </p>
        <p className="whitespace-pre-wrap">{snapshot.group.information}</p>
        <p>
          {snapshot.group.participants.map((person) => person.name).join(', ')}
        </p>
        {!activity.actorUserId && (
          <p className="text-muted-foreground">
            {label(
              'unverified',
              'The participant name is an unverified label.',
            )}
          </p>
        )}
      </details>
    )
  const current = describeExpenseRevision(snapshot, locale)
  const previous =
    activity.previousSnapshot?.kind === 'expense' &&
    activity.snapshot?.kind === 'expense'
      ? describeExpenseRevision(activity.previousSnapshot, locale)
      : undefined
  const deleted = activity.activityType === 'DELETE_EXPENSE'
  return (
    <details
      onClick={(event) => event.stopPropagation()}
      className="m-1 text-xs"
    >
      <summary className="cursor-pointer font-medium">
        {label('view', 'View saved revision')} {snapshot.expense.revision}
        {deleted ? ` · ${label('deleted', 'Deleted')}` : ''}
      </summary>
      <div className="mt-2 space-y-2 rounded-none border p-3">
        {deleted && (
          <p>
            {label(
              'retained',
              'Removed from current balances. This saved version remains in history.',
            )}
          </p>
        )}
        <p className="text-muted-foreground">
          {activity.actorUserId
            ? `${label('user', 'User')}: ${activity.actorUserId}`
            : activity.source === 'system'
              ? label('system', 'Created by the recurring schedule')
              : activity.source === 'baseline'
                ? label(
                    'baseline',
                    'History begins here for an existing expense',
                  )
                : label(
                    'unverified',
                    'The participant name is an unverified label.',
                  )}
        </p>
        {previous && (
          <p className="font-medium">
            {label('changes', 'Changes from the preceding revision')}
          </p>
        )}
        <dl className="space-y-2">
          {(Object.keys(labels) as (keyof typeof labels)[]).map((key) => {
            const changed =
              previous !== undefined && previous[key] !== current[key]
            return (
              <div key={key}>
                <dt
                  className={
                    changed ? 'font-semibold' : 'text-muted-foreground'
                  }
                >
                  {label(key, labels[key])}
                  {changed ? ' *' : ''}
                </dt>
                <dd className="whitespace-pre-wrap break-words">
                  {changed ? (
                    <>
                      <del className="text-muted-foreground">
                        {previous[key] || '—'}
                      </del>
                      {' → '}
                    </>
                  ) : null}
                  {current[key] || '—'}
                </dd>
              </div>
            )
          })}
        </dl>
        {snapshot.expense.documents.map((document, index) => {
          const href = receiptLink(document.url)
            ? receiptDownloadUrl(snapshot.group.id, document.url)
            : undefined
          return href ? (
            <a
              key={document.id}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="block underline"
            >
              {label('receipt', 'Open saved attachment')} {index + 1}
            </a>
          ) : null
        })}
      </div>
    </details>
  )
}
