import { requireWebUser } from '@/lib/session'
import { Suspense, type ReactNode } from 'react'

export default async function ExpensesLayout({
  children,
}: {
  children: ReactNode
}) {
  await requireWebUser()
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
      <Suspense fallback={<p role="status">Loading…</p>}>{children}</Suspense>
    </main>
  )
}
