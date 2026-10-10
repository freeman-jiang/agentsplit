import { getRuntimeFeatureFlags } from '@/lib/featureFlags'
import { ExpenseWorkspace } from './workspace'

export const metadata = { title: 'Expense' }
export default async function ExpensePage({
  params,
}: {
  params: Promise<{ expenseId: string }>
}) {
  return (
    <ExpenseWorkspace
      expenseId={(await params).expenseId}
      runtimeFeatureFlags={await getRuntimeFeatureFlags()}
    />
  )
}
