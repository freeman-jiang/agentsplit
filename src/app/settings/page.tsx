import { requireWebUser } from '@/lib/session'
import Link from 'next/link'
import { AccountSettings } from './settings-client'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Account & agent keys' }
export default async function SettingsPage() {
  const user = await requireWebUser()
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8 space-y-8">
      <h1 className="font-display text-4xl">Account & agent keys</h1>
      <Link href="/settings/connections" className="block underline">
        Manage connected apps (ChatGPT and OAuth)
      </Link>
      <AccountSettings name={user.name ?? ''} email={user.email} />
    </main>
  )
}
