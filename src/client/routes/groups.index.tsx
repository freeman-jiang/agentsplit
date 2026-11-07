import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router'
import { Calendar, Loader2, MoreHorizontal, Star, Users } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { requireSignedIn } from '~/client/auth-guard'
import { cn } from '~/client/cn'
import { isZero } from '~/client/components/balance/net'
import { TotalAmounts } from '~/client/components/balance/totals'
import { formatMoment } from '~/client/dates'
import { directoryQuery } from '~/client/queries/groups'
import { oneOf, positiveIntegerParam, searchParams } from '~/client/search'
import { Alert, AlertDescription } from '~/client/ui/alert'
import { Button } from '~/client/ui/button'
import { Card, CardDescription, CardTitle } from '~/client/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '~/client/ui/dropdown-menu'
import type { Directory } from '~/shared/api'
import { groupRef } from '~/shared/groups'
import { LIMITS } from '~/shared/limits'

const parseSearch = searchParams({ access: oneOf(['denied']), offset: positiveIntegerParam })

export const Route = createFileRoute('/groups/')({
  validateSearch: parseSearch,
  // A signed-out visitor returns here after sign-in (P-AUTH-49).
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  loaderDeps: ({ search }) => ({ offset: search.offset ?? 0 }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(directoryQuery(deps.offset)),
  pendingComponent: () => (
    <GroupsPage>
      <p role="status" className="text-sm">
        <Loader2 className="mr-2 inline w-4 animate-spin" aria-hidden="true" />
        Loading recent groups…
      </p>
    </GroupsPage>
  ),
  errorComponent: LoadError,
  component: Groups,
})

function LoadError() {
  const router = useRouter()
  return (
    <GroupsPage>
      <div className="space-y-2 text-sm">
        <p>Could not load your groups. Try again.</p>
        <Button variant="secondary" onClick={() => router.invalidate()}>
          Retry
        </Button>
      </div>
    </GroupsPage>
  )
}

// ---------- starred and archived groups, kept in this browser only ----------

const STARRED = 'starredGroups'
const ARCHIVED = 'archivedGroups'
const listeners = new Set<() => void>()

/** A stored list of group IDs; anything that is not a list of strings reads as empty (P-GROUP-17). */
function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : []
  } catch {
    return []
  }
}
function writeList(key: string, ids: string[]) {
  localStorage.setItem(key, JSON.stringify(ids))
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}
/** The stored lists as one string snapshot, so React re-renders only when they change. */
const snapshot = () => JSON.stringify([readList(STARRED), readList(ARCHIVED)])

function useGroupMarks() {
  const [starred, archived] = JSON.parse(useSyncExternalStore(subscribe, snapshot)) as [string[], string[]]
  return {
    starred,
    archived,
    toggleStar: (id: string) => {
      if (starred.includes(id)) return writeList(STARRED, starred.filter((g) => g !== id))
      writeList(STARRED, [...starred, id])
      writeList(ARCHIVED, archived.filter((g) => g !== id)) // starring also unarchives (P-GROUP-14)
    },
    toggleArchive: (id: string) => {
      if (archived.includes(id)) return writeList(ARCHIVED, archived.filter((g) => g !== id))
      writeList(ARCHIVED, [...archived, id])
      writeList(STARRED, starred.filter((g) => g !== id)) // archiving also unstars (P-GROUP-15)
    },
  }
}

// ---------- page ----------

function GroupsPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:space-y-6 sm:px-8 sm:py-8">
      <div className="flex items-start justify-between gap-2">
        <h1 className="flex-1 font-display text-3xl tracking-tight">
          <Link to="/groups">My groups</Link>
        </h1>
        <Button asChild>
          <Link to="/groups/create">Create group</Link>
        </Button>
      </div>
      {children}
    </main>
  )
}

type Group = (typeof Directory.Type)['groups'][number]

function Groups() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const offset = search.offset ?? 0
  const { data } = useSuspenseQuery(directoryQuery(offset))
  const marks = useGroupMarks()
  const denied = search.access === 'denied' && (
    <Alert variant="destructive">
      <AlertDescription>That group did not open. It may not exist, or your account is not a member. Ask an admin for an invitation.</AlertDescription>
    </Alert>
  )

  if (data.groups.length === 0 && offset === 0)
    return (
      <GroupsPage>
        {denied}
        <TotalBalance directory={data} />
        <div className="space-y-2 text-sm">
          <p>You are not in any group yet.</p>
          <p>
            <Link to="/groups/create" className="text-primary underline-offset-4 hover:underline">
              Create one
            </Link>{' '}
            or ask a group admin to invite you.
          </p>
        </div>
      </GroupsPage>
    )

  const starred = data.groups.filter((g) => marks.starred.includes(g.id))
  const archived = data.groups.filter((g) => marks.archived.includes(g.id) && !marks.starred.includes(g.id))
  const recent = data.groups.filter((g) => !starred.includes(g) && !archived.includes(g))
  const list = (groups: Group[]) => (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((g) => (
        <GroupCard key={g.id} group={g} starred={marks.starred.includes(g.id)} archived={marks.archived.includes(g.id)} marks={marks} />
      ))}
    </ul>
  )
  return (
    <GroupsPage>
      {denied}
      <TotalBalance directory={data} />
      {(offset > 0 || data.nextOffset !== null) && (
        <div className="flex gap-3">
          {offset > 0 && (
            <Button variant="outline" onClick={() => navigate({ search: (s) => ({ ...s, offset: Math.max(0, offset - LIMITS.directoryPage) }) })}>
              Previous groups
            </Button>
          )}
          {data.nextOffset !== null && (
            <Button variant="outline" onClick={() => navigate({ search: (s) => ({ ...s, offset: data.nextOffset ?? 0 }) })}>
              More groups
            </Button>
          )}
        </div>
      )}
      <div className="space-y-6 max-sm:pt-2">
        {starred.length > 0 && (
          <section>
            <h2 className="eyebrow">Starred groups</h2>
            {list(starred)}
          </section>
        )}
        {recent.length > 0 && (
          <section>
            <h2 className="eyebrow">Recent groups</h2>
            {list(recent)}
          </section>
        )}
        {archived.length > 0 && (
          <section className="opacity-50">
            <h2 className="eyebrow">Archived groups</h2>
            {list(archived)}
          </section>
        )}
      </div>
    </GroupsPage>
  )
}

function GroupCard({ group, starred, archived, marks }: { group: Group; starred: boolean; archived: boolean; marks: ReturnType<typeof useGroupMarks> }) {
  const navigate = useNavigate()
  const params = { group: groupRef(group) }
  return (
    <li>
      {/* The whole card opens the group; the name stays a real link for keyboards and new tabs. */}
      <div
        className="w-full cursor-pointer rounded-2xl border bg-card p-4 transition-colors hover:bg-accent"
        onClick={() => navigate({ to: '/$group', params })}
      >
        <div className="flex justify-between gap-2">
          {/* As in the current app, the card opens the group's own URL: /<slug>, or /groups/<id>, which opens its expenses. */}
          <Link to="/$group" params={params} className="min-w-0 flex-1 truncate font-medium" onClick={(e) => e.stopPropagation()}>
            {group.name}
          </Link>
          <span className="flex shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="-my-2 h-10 w-10"
              aria-label={starred ? `Unstar ${group.name}` : `Star ${group.name}`}
              aria-pressed={starred}
              onClick={(e) => {
                e.stopPropagation()
                marks.toggleStar(group.id)
              }}
            >
              <Star className={cn('h-4 w-4', starred ? 'fill-foreground text-foreground' : 'text-muted-foreground')} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="-my-2 -mr-3 h-10 w-10" aria-label={`More actions for ${group.name}`} onClick={(e) => e.stopPropagation()}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem onSelect={() => marks.toggleArchive(group.id)}>{archived ? 'Unarchive group' : 'Archive group'}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center">
            <Users className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
            <span aria-label={`${group.participantCount} participants`}>{group.participantCount}</span>
          </span>
          <span className="flex items-center">
            <Calendar className="mr-1.5 inline h-3.5 w-3.5" aria-hidden="true" />
            {formatMoment.date(group.createdAt)}
          </span>
        </div>
      </div>
    </li>
  )
}

/** The caller's balance across every membership, one amount per currency (P-BAL-102..105). */
function TotalBalance({ directory }: { directory: typeof Directory.Type }) {
  const now = directory
  const outstanding = now.totals.filter((t) => !isZero(t.net))
  // The same left-aligned stack as the dashboard balance.
  return (
    <Card className="p-4 sm:px-6 sm:py-5">
      <div className="flex items-baseline justify-between gap-4">
        <CardTitle className="text-sm">Your balance in groups</CardTitle>
        <CardDescription className="hidden text-xs sm:block">Your combined balance across all your groups. Ungrouped expenses are on the dashboard.</CardDescription>
      </div>
      {now.unboundGroupCount > 0 && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Link your participant identity in {now.unboundGroupCount} {now.unboundGroupCount === 1 ? 'group' : 'groups'} to see a complete total. Only linked
          groups are included below.
        </p>
      )}
      {outstanding.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {now.unboundGroupCount ? 'No outstanding balance in linked groups.' : 'You are all settled up across your groups.'}
        </p>
      ) : (
        <TotalAmounts totals={outstanding} />
      )}
    </Card>
  )
}
