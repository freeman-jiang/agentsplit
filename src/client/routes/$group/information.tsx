import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Pencil } from 'lucide-react'
import { groupQuery } from '~/client/queries/groups'
import { Button } from '~/client/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/client/ui/card'

export const Route = createFileRoute('/$group/information')({
  component: Information,
})

function Information() {
  const { group } = Route.useParams()
  const { groupId } = Route.useRouteContext()
  const { data: g } = useSuspenseQuery(groupQuery(groupId))
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="flex justify-between gap-2">
          <span>Information</span>
          {/* Only admins can edit, so only admins get the pencil (P-GROUP-58). */}
          {g.role === 'admin' && (
            <Button size="icon" asChild className="-mb-12">
              <Link to="/$group/edit" params={{ group }} aria-label="Edit group information">
                <Pencil className="h-4 w-4" />
              </Link>
            </Button>
          )}
        </CardTitle>
        <CardDescription className="mr-12">Notes for everyone in the group.</CardDescription>
      </CardHeader>
      <CardContent className="prose prose-sm max-w-full whitespace-break-spaces sm:prose-base">
        {g.information ? <p className="text-foreground">{g.information}</p> : <p className="text-sm text-muted-foreground">No information yet.</p>}
      </CardContent>
    </Card>
  )
}
