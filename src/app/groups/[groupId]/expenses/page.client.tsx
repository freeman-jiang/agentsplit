'use client'

import { CreateFromReceiptButton } from '@/app/groups/[groupId]/expenses/create-from-receipt-button'
import { ExpenseList } from '@/app/groups/[groupId]/expenses/expense-list'
import ExportButton from '@/app/groups/[groupId]/export-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrackPage } from '@/lib/analytics/track-page'
import { trpc } from '@/trpc/client'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useCurrentGroup } from '../current-group-context'
import { GroupBalanceSummary } from './group-balance-summary'

export default function GroupExpensesPageClient({
  enableReceiptExtract,
}: {
  enableReceiptExtract: boolean
}) {
  const t = useTranslations('Expenses')
  const { groupId } = useCurrentGroup()
  const { data } = trpc.groups.get.useQuery({ groupId })

  return (
    <>
      {data && !data.membership.participantId && (
        <p className="mb-4 border p-3 text-sm">
          Your account is not linked to a participant yet. An admin can link it
          once in{' '}
          <Link className="underline" href={`/groups/${groupId}/edit#members`}>
            group settings
          </Link>
          . Personal balances will appear after setup.
        </p>
      )}
      <TrackPage path={`/groups/${groupId}/expenses`} />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-8">
        <GroupBalanceSummary />
        <Card className="mb-4 min-w-0 border-0 bg-transparent lg:col-start-1 lg:row-start-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardHeader className="p-0">
              <CardTitle>{t('title')}</CardTitle>
            </CardHeader>
            <CardHeader className="flex flex-row flex-wrap items-center space-y-0 gap-2 p-0">
              <ExportButton groupId={groupId} />
              {enableReceiptExtract && <CreateFromReceiptButton />}
              <Button asChild>
                <Link
                  href={`/groups/${groupId}/expenses/create`}
                  title={t('create')}
                >
                  <Plus className="me-2 w-4 h-4" />
                  {t('create')}
                </Link>
              </Button>
            </CardHeader>
          </div>

          <CardContent className="relative flex flex-col gap-4 px-0 pt-6 pb-4 sm:pb-6">
            <ExpenseList />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
