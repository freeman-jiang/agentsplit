import { Button } from '@/components/ui/button'
import { Users } from 'lucide-react'
import Link from 'next/link'

export function ShareButton({ group }: { group: { id: string } }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={`/groups/${group.id}/edit#members`}>
        <Users className="w-4 h-4 mr-2" />
        Members
      </Link>
    </Button>
  )
}
