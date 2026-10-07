'use server'

import type { AnalyticsConfig } from '@/lib/analytics/types'

/**
 * AgentSplit disables analytics even if upstream provider variables are set.
 * No provider scripts or tracking hooks are mounted by the root layout.
 */
export async function getAnalyticsConfig(): Promise<AnalyticsConfig> {
  return { providers: [] }
}
