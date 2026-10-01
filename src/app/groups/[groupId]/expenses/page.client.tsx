'use client'

import { ActiveUserModal } from '@/app/groups/[groupId]/expenses/active-user-modal'
import { CreateFromReceiptButton } from '@/app/groups/[groupId]/expenses/create-from-receipt-button'
import { ExpenseList } from '@/app/groups/[groupId]/expenses/expense-list'
import ExportButton from '@/app/groups/[groupId]/export-button'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrackPage } from '@/lib/analytics/track-page'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { useCurrentGroup } from '../current-group-context'

export default function GroupExpensesPageClient({
  enableReceiptExtract,
}: {
  enableReceiptExtract: boolean
}) {
  const t = useTranslations('Expenses')
  const { groupId } = useCurrentGroup()

  return (
    <>
      <TrackPage path={`/groups/${groupId}/expenses`} />
      <Card className="mb-4 border-0 bg-transparent">
        <div className="flex flex-1">
          <CardHeader className="flex-1 px-0 pt-0 pb-4">
            <CardTitle>{t('title')}</CardTitle>
          </CardHeader>
          <CardHeader className="flex flex-row flex-wrap items-start space-y-0 gap-2 p-0 pb-4">
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

        <CardContent className="p-0 pt-2 pb-4 sm:pb-6 flex flex-col gap-4 relative">
          <ExpenseList />
        </CardContent>
      </Card>

      <ActiveUserModal groupId={groupId} />
    </>
  )
}
