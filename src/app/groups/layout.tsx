import { requireWebUser } from '@/lib/session'
import { PropsWithChildren, Suspense } from 'react'

export default async function GroupsLayout({
  children,
}: PropsWithChildren<{}>) {
  await requireWebUser()
  return (
    <Suspense>
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-6 sm:px-8 sm:py-8 flex flex-col gap-6">
        {children}
      </main>
    </Suspense>
  )
}
