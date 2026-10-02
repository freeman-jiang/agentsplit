'use client'

import { authClient } from '@/lib/auth-client'
import Link from 'next/link'
import { Button } from './ui/button'

export function AccountMenu() {
  const { data: session, isPending } = authClient.useSession()
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={session ? '/settings' : '/sign-in'}>
        {isPending ? 'Account' : session ? 'Account & keys' : 'Sign in'}
      </Link>
    </Button>
  )
}
