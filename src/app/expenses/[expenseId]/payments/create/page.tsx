import { getRuntimeFeatureFlags } from '@/lib/featureFlags'
import { ExpenseWorkspace } from '../../workspace'

export const metadata = { title: 'Record payment' }
export default async function PaymentPage({
  params,
}: {
  params: Promise<{ expenseId: string }>
}) {
  return (
    <ExpenseWorkspace
      expenseId={(await params).expenseId}
      recordingPayment
      runtimeFeatureFlags={await getRuntimeFeatureFlags()}
    />
  )
}
