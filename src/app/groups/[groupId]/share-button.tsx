import { Button } from '@/components/ui/button'
import { groupPath } from '@/lib/group-slug'
import { Users } from 'lucide-react'
import Link from 'next/link'

export function ShareButton({
  group,
}: {
  group: { id: string; slug?: string | null }
}) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href={`${groupPath(group)}/edit#members`}>
        <Users className="w-4 h-4 mr-2" />
        Members
      </Link>
    </Button>
  )
}
