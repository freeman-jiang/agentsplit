'use server'

import { env } from './env'

export async function getRuntimeFeatureFlags() {
  // The Coolify deployment enables attachments through its storage settings.
  // Keep built-in AI calls disabled in AgentSplit.
  // Dictation and interpretation belong to the agent calling our MCP tools.
  return {
    enableExpenseDocuments:
      ['true', 'yes', '1', 'on'].includes(
        (process.env.ENABLE_EXPENSE_DOCUMENTS ?? '').trim().toLowerCase(),
      ) || env.NEXT_PUBLIC_ENABLE_EXPENSE_DOCUMENTS,
    enableReceiptExtract: false,
    enableCategoryExtract: false,
  }
}

export type RuntimeFeatureFlags = Awaited<
  ReturnType<typeof getRuntimeFeatureFlags>
>
