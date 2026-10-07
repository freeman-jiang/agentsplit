import { getGroup } from '@/lib/api'
import { requireWebGroup } from '@/lib/session'
import { cache } from 'react'

export const cached = {
  getGroup: cache(async (id: string) => {
    await requireWebGroup(id)
    return getGroup(id)
  }),
}
