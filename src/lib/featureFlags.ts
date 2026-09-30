'use server'

export async function getRuntimeFeatureFlags() {
  // Keep external storage and built-in AI calls disabled in AgentSplit.
  // Dictation and interpretation belong to the agent calling our MCP tools.
  return {
    enableExpenseDocuments: false,
    enableReceiptExtract: false,
    enableCategoryExtract: false,
  }
}

export type RuntimeFeatureFlags = Awaited<
  ReturnType<typeof getRuntimeFeatureFlags>
>
