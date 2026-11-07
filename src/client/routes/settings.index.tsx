import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { CopyButton } from '~/client/components/copy-button'
import { StorageLimits } from '~/client/components/storage-limits'
import { authClient } from '~/client/auth-client'
import { accountQuery, errorMessage, readTheme, saveTheme, type Theme } from '~/client/queries/account'
import { storageUsageQuery } from '~/client/queries/storage'
import { rpc } from '~/client/rpc'
import { Button } from '~/client/ui/button'
import { Input } from '~/client/ui/input'
import { NativeSelect } from '~/client/ui/native-select'
import { API_KEY_NAME_MAX, PROFILE_NAME_MAX } from '~/shared/account'

export const Route = createFileRoute('/settings/')({
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(accountQuery), context.queryClient.ensureQueryData(storageUsageQuery)]),
  component: Settings,
})

function Settings() {
  const { data: account } = useSuspenseQuery(accountQuery)
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8">
      <h1 className="font-display text-4xl">Account &amp; agent keys</h1>
      <Link to="/settings/connections" className="block underline">
        Manage connected apps (ChatGPT and OAuth)
      </Link>
      <Profile name={account.profile.name} email={account.profile.email} />
      <Preferences />
      <ApiKeys keys={account.apiKeys} />
      <StorageLimits />
    </main>
  )
}

function Profile(props: { name: string; email: string }) {
  const queryClient = useQueryClient()
  const [displayName, setDisplayName] = useState(props.name)
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: (name: string) => rpc((api) => api('account.updateProfile', { name })),
    // The name shows in groups, expenses and the header: read everything again.
    onSuccess: async () => {
      await queryClient.invalidateQueries()
      setSaved(true)
    },
  })
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">{props.name}</h2>
      <p className="break-words text-muted-foreground">{props.email} · Verified by Google</p>
      <form
        className="max-w-lg space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(false)
          save.mutate(displayName)
        }}
      >
        <label htmlFor="account-display-name" className="block text-sm font-medium">
          Display name · used everywhere
        </label>
        <Input
          id="account-display-name"
          value={displayName}
          maxLength={PROFILE_NAME_MAX}
          required
          aria-describedby="account-name-help"
          onChange={(event) => {
            setDisplayName(event.target.value)
            setSaved(false)
          }}
        />
        <p id="account-name-help" className="text-sm text-muted-foreground">
          This is your one account name across all groups and expenses. Changing it updates current views and future entries. Past
          audit records keep the name recorded at the time.
        </p>
        <Button disabled={save.isPending || !displayName.trim()}>{save.isPending ? 'Saving…' : 'Save display name'}</Button>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(save.error, 'Could not save your display name.')}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm">
            Display name updated everywhere. Historical records are unchanged.
          </p>
        )}
      </form>
      <Button
        variant="outline"
        onClick={async () => {
          await authClient.signOut()
          localStorage.removeItem('recentGroups')
          window.location.assign('/sign-in')
        }}
      >
        Sign out
      </Button>
    </section>
  )
}

function Preferences() {
  const [mounted, setMounted] = useState(false)
  const [theme, setTheme] = useState<Theme>('system')
  useEffect(() => {
    setTheme(readTheme())
    setMounted(true)
  }, [])
  return (
    <section className="space-y-4 border-y py-6">
      <h2 className="text-xl font-medium">Preferences</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="appearance-theme" className="text-sm font-medium">
          Theme
        </label>
        <NativeSelect
          id="appearance-theme"
          wrapperClassName="w-40"
          value={theme}
          disabled={!mounted}
          onChange={(event) => {
            const next = event.target.value === 'light' || event.target.value === 'dark' ? event.target.value : 'system'
            setTheme(next)
            saveTheme(next)
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </NativeSelect>
      </div>
    </section>
  )
}

type Key = { id: string; name: string | null; start: string | null; createdAt: string }

function ApiKeys(props: { keys: readonly Key[] }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const reload = () => Promise.all([queryClient.invalidateQueries({ queryKey: accountQuery.queryKey }), queryClient.invalidateQueries({ queryKey: storageUsageQuery.queryKey })])
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-medium">Agent API keys</h2>
      <p className="text-sm text-muted-foreground">
        Each key acts as you and inherits your current group memberships and admin permissions. Create a separate key for each agent.
        Revoking a key stops its future requests.
      </p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setPending(true)
          setError('')
          try {
            // Better Auth creates the key: it owns the prefix, the hash and the rate limit.
            const result = await authClient.apiKey.create({ name: label })
            if (result.error) setError(errorMessage(result.error, 'Could not create key'))
            else {
              setSecret(result.data.key)
              setLabel('')
              await reload()
            }
          } catch {
            setError('Could not create key. Check your connection.')
          } finally {
            setPending(false)
          }
        }}
      >
        <label className="min-w-40 flex-1">
          <span className="sr-only">Key name</span>
          <Input
            aria-label="Key name"
            placeholder="e.g. My Codex"
            maxLength={API_KEY_NAME_MAX}
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <Button disabled={pending}>Create API key</Button>
      </form>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {secret && (
        <div className="space-y-3 rounded-2xl border bg-card p-4">
          <p className="font-medium">Copy your new key now. It is shown only once.</p>
          <p className="text-sm text-muted-foreground">
            Paste the key exactly as copied into your client’s API key or X-API-Key header field. No prefix is needed.
          </p>
          <div className="flex items-center gap-3">
            <code className="min-w-0 flex-1 break-all text-sm">{secret}</code>
            <CopyButton text={secret} title="Copy API key" />
          </div>
          <Button variant="outline" size="sm" onClick={() => setSecret('')}>
            I’ve saved it
          </Button>
        </div>
      )}
      <ul className="divide-y border-y">
        {props.keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
              <p className="break-words font-medium">{key.name ?? 'Agent key'}</p>
              <p className="text-xs text-muted-foreground">
                {key.start ? `${key.start}… · ` : ''}Created {new Date(key.createdAt).toLocaleDateString()}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                if (!window.confirm(`Revoke ${key.name ?? 'this key'}? Its agent will lose access.`)) return
                setError('')
                try {
                  await rpc((api) => api('account.revokeApiKey', { keyId: key.id }))
                } catch (cause) {
                  setError(errorMessage(cause, 'Unable to revoke key'))
                }
                await reload()
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
      {props.keys.length === 0 && <p className="text-sm text-muted-foreground">No agent keys yet.</p>}
      <Link to="/agents" className="inline-block underline underline-offset-4">
        Connect Codex, Claude Code, or another agent →
      </Link>
    </section>
  )
}
