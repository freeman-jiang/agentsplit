import { ActivityList } from '@/app/groups/[groupId]/activity/activity-list'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useTranslations } from 'next-intl'

export function ActivityPageClient() {
  const t = useTranslations('Activity')

  return (
    <>
      <Card className="mb-4 border-0 bg-transparent">
        <CardHeader className="px-0 pt-0">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col space-y-4 px-0">
          <ActivityList />
        </CardContent>
      </Card>
    </>
  )
}
