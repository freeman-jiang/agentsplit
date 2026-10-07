import { PaymentEditor } from '../../payment-form'

export const metadata = { title: 'Edit payment' }
export default async function EditPaymentPage({
  params,
}: {
  params: Promise<{ paymentId: string }>
}) {
  const { paymentId } = await params
  return <PaymentEditor paymentId={paymentId} />
}
