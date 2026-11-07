import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { GroupForm } from '~/client/components/group-form'
import { meQuery } from '~/client/queries'
import { errorMessage, newIdempotencyKey, refreshGroups } from '~/client/queries/groups'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '~/client/ui/card'
import { Input } from '~/client/ui/input'
import { groupRef } from '~/shared/groups'
import { LIMITS } from '~/shared/limits'

export const Route = createFileRoute('/groups/create')({
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(meQuery))) throw redirect({ to: '/sign-in' })
  },
  component: CreateGroup,
})

let nextRow = 0

function CreateGroup() {
  const { data: me } = useSuspenseQuery(meQuery)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [people, setPeople] = useState<{ key: number; name: string }[]>([])
  // One key per form: a resubmitted create after a lost response returns the same group.
  const [idempotencyKey] = useState(newIdempotencyKey)

  return (
    <main className="mx-auto w-full max-w-4xl px-3 py-6 sm:px-8">
      <GroupForm
        mode="create"
        initial={{ name: '', slug: '', information: '', defaultCurrency: 'USD' }}
        cancel={
          <Button variant="ghost" asChild>
            <Link to="/groups">Cancel</Link>
          </Button>
        }
        onSubmit={async (values) => {
          const participants = people.map((p) => p.name.trim()).filter(Boolean)
          const group = await rpc((api) =>
            api('groups.create', { groupId: null, idempotencyKey, group: { ...values, slug: values.slug.trim() || null, participants } }),
          ).catch((e: unknown) => {
            throw new Error(errorMessage(e))
          })
          await refreshGroups(queryClient)
          await navigate({ to: '/$group/expenses', params: { group: groupRef(group) } })
        }}
      >
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Participants</CardTitle>
            <CardDescription>Enter the name for each participant.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm" data-testid="creator-identity">
              You ({me?.name || 'signed-in account'}) are added automatically. Add other participants below, then invite them from Settings.
            </p>
            <ul className="flex flex-col gap-2">
              {people.map((person, index) => (
                <li key={person.key} className="flex gap-2">
                  <label className="sr-only" htmlFor={`participant-${person.key}`}>
                    Participant #{index + 1}
                  </label>
                  <Input
                    id={`participant-${person.key}`}
                    className="text-base"
                    placeholder="New"
                    maxLength={LIMITS.nameMax}
                    value={person.name}
                    onChange={(e) => setPeople((list) => list.map((p) => (p.key === person.key ? { ...p, name: e.target.value } : p)))}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive"
                    aria-label={`Remove participant #${index + 1}`}
                    onClick={() => setPeople((list) => list.filter((p) => p.key !== person.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
          <CardFooter>
            <Button type="button" variant="secondary" disabled={people.length >= LIMITS.participantsPerGroup - 1} onClick={() => setPeople((list) => [...list, { key: nextRow++, name: '' }])}>
              Add participant
            </Button>
          </CardFooter>
        </Card>
      </GroupForm>
    </main>
  )
}
