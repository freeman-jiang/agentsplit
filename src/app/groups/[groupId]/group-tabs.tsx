'use client'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { groupPath } from '@/lib/group-slug'
import {
  Activity,
  BarChart3,
  Info,
  Receipt,
  Scale,
  Settings,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { usePathname, useRouter } from 'next/navigation'
import { ComponentType } from 'react'
import { useCurrentGroup } from './current-group-context'

type Props = {
  groupId: string
}

export function GroupTabs({ groupId }: Props) {
  const t = useTranslations()
  const pathname = usePathname()
  const { group } = useCurrentGroup()
  const basePath = groupPath(group ?? { id: groupId })
  const segments = pathname.split('/').filter(Boolean)
  const value =
    (segments[0] === 'groups' ? segments[2] : segments[1]) || 'expenses'
  const router = useRouter()

  const tabs: { value: string; label: string; Icon: ComponentType<any> }[] = [
    { value: 'expenses', label: t('Expenses.title'), Icon: Receipt },
    { value: 'balances', label: t('Balances.title'), Icon: Scale },
    { value: 'information', label: t('Information.title'), Icon: Info },
    { value: 'stats', label: t('Stats.title'), Icon: BarChart3 },
    { value: 'activity', label: t('Activity.title'), Icon: Activity },
    { value: 'edit', label: t('Settings.title'), Icon: Settings },
  ]

  return (
    <Tabs
      value={value}
      className="flex-1 min-w-0"
      onValueChange={(value) => {
        router.push(`${basePath}/${value}`)
      }}
    >
      <TabsList className="flex h-auto flex-wrap justify-start gap-x-2 gap-y-1 border-b bg-transparent p-0 sm:gap-x-4">
        {tabs.map(({ value, label, Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            title={label}
            aria-label={label}
            className="min-h-11 gap-2 border-b-2 border-transparent px-2 py-3 font-normal data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
          >
            <Icon className="hidden h-4 w-4 lg:block" />
            <span className="text-xs sm:text-sm">{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
