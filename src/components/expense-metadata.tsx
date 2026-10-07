'use client'

import type { ExpenseAttribution } from '@/lib/expense-attribution'
import { useLocale } from 'next-intl'

export function ExpenseMetadata({
  createdAt,
  attribution,
}: {
  createdAt: Date
  attribution?: ExpenseAttribution
}) {
  const locale = useLocale()
  const stamp = ({ value }: { value: string }) => (
    <time dateTime={value} title={new Date(value).toLocaleString(locale)}>
      {new Date(value).toLocaleString(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })}
    </time>
  )
  return (
    <div
      className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground"
      data-testid="expense-metadata"
    >
      <p>
        Added{' '}
        {stamp({ value: attribution?.createdAt ?? createdAt.toISOString() })}
        {attribution?.createdBy
          ? ` by ${attribution.createdBy.name}`
          : ' · original author unavailable'}
      </p>
      {attribution?.updatedAt && (
        <p>
          Last edited {stamp({ value: attribution.updatedAt })}
          {attribution.updatedBy ? ` by ${attribution.updatedBy.name}` : ''}
        </p>
      )}
      {attribution?.lastEditedByYouAt && (
        <p>Your last edit {stamp({ value: attribution.lastEditedByYouAt })}</p>
      )}
    </div>
  )
}
