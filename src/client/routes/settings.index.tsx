import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { authCall, authClient } from '~/client/auth-client'
import { signOut } from '~/client/queries/session'
import { DeleteDialog } from '~/client/components/delete-dialog'
import { StorageLimits } from '~/client/components/storage-limits'
import { formatMoment } from '~/client/dates'
import { describeError } from '~/client/errors'
import { accountQuery } from '~/client/queries/account'
import { afterWrite } from '~/client/queries/keys'
import { storageUsageQuery } from '~/client/queries/storage'
import { rpc } from '~/client/rpc'
import { readTheme, saveTheme, type Theme } from '~/client/theme'
import { Button } from '~/client/ui/button'
import { CopyButton } from '~/client/ui/copy-button'
import { Input } from '~/client/ui/input'
import { ChoiceSelect } from '~/client/ui/choice-select'
import { LIMITS } from '~/shared/limits'
import type { ApiKeySummary } from '~/shared/api'
import { API_KEY_HEADER } from '~/shared/mcp'

export const Route = createFileRoute('/settings/')({
  loader: ({ context }) => Promise.all([context.queryClient.ensureQueryData(accountQuery), context.queryClient.ensureQueryData(storageUsageQuery)]),
  component: Settings,
})

function Settings() {
  const { data: account } = useSuspenseQuery(accountQuery)
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-8">
      <h1 className="font-display text-4xl">Account</h1>
      <Link to="/settings/connections" className="block underline">
        Connected apps
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
    // The name shows in groups, expenses and the header.
    onSuccess: async () => {
      await afterWrite({ queryClient, scope: 'account' })
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
          Display name
        </label>
        <Input
          id="account-display-name"
          value={displayName}
          maxLength={LIMITS.nameMax}
          required
          aria-describedby="account-name-help"
          onChange={(event) => {
            setDisplayName(event.target.value)
            setSaved(false)
          }}
        />
        <p id="account-name-help" className="text-sm text-muted-foreground">
          Your name in all groups and expenses. The log keeps the old name on past changes.
        </p>
        <Button disabled={save.isPending || !displayName.trim()}>{save.isPending ? 'Saving…' : 'Save name'}</Button>
        {save.error && (
          <p role="alert" className="text-sm text-destructive">
            {describeError(save.error, 'Could not save your name.').message}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm">
            Name saved.
          </p>
        )}
      </form>
      <Button variant="outline" onClick={() => void signOut().catch((cause: unknown) => toast.error(describeError(cause).message))}>
        Sign out
      </Button>
    </section>
  )
}

const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const satisfies ReadonlyArray<{ value: Theme; label: string }>

function Preferences() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  return (
    <section className="space-y-4 border-y py-6">
      <h2 className="text-xl font-medium">Preferences</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label htmlFor="appearance-theme" className="text-sm font-medium">
          Theme
        </label>
        <ChoiceSelect
          id="appearance-theme"
          wrapperClassName="w-40"
          value={theme}
          options={THEMES}
          onChange={(next) => {
            setTheme(next)
            saveTheme(next)
          }}
        />
      </div>
    </section>
  )
}

function ApiKeys(props: { keys: ReadonlyArray<typeof ApiKeySummary.Type> }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const reload = () => afterWrite({ queryClient, scope: 'account' })
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-medium">API keys</h2>
      <p className="text-sm text-muted-foreground">
        A key acts as you, with your groups and your admin rights. Create one key for each agent. A revoked key stops working.
      </p>
      <form
        className="flex flex-wrap gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setPending(true)
          setError('')
          // Better Auth creates the key: it owns the prefix, the hash and the rate limit.
          const result = await authCall({ run: () => authClient.apiKey.create({ name: label }), refused: 'Could not create the key.', failed: 'Could not create the key. Check your connection and try again.' })
          setPending(false)
          if ('error' in result) return setError(result.error)
          setSecret(result.data.key)
          setLabel('')
          await reload()
        }}
      >
        <label className="min-w-40 flex-1">
          <span className="sr-only">Key name</span>
          <Input
            aria-label="Key name"
            placeholder="My Codex"
            maxLength={LIMITS.apiKeyNameMax}
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
          <p className="font-medium">Copy the key now. You cannot see it again.</p>
          <p className="text-sm text-muted-foreground">
            Paste the key exactly as copied into your client’s API key or {API_KEY_HEADER} header field. No prefix is needed.
          </p>
          <div className="flex items-center gap-3">
            <code className="min-w-0 flex-1 break-all text-sm">{secret}</code>
            <CopyButton text={secret} title="Copy API key" />
          </div>
          <Button variant="outline" size="sm" onClick={() => setSecret('')}>
            Done
          </Button>
        </div>
      )}
      <ul className="divide-y border-y">
        {props.keys.map((key) => (
          <li key={key.id} className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
              <p className="break-words font-medium">{key.name ?? 'API key'}</p>
              <p className="text-xs text-muted-foreground">
                {key.start ? `${key.start}… · ` : ''}Created {formatMoment.numericDate(key.createdAt)}
              </p>
            </div>
            <DeleteDialog
              trigger={
                <Button variant="outline" size="sm">
                  Revoke
                </Button>
              }
              title={`Revoke ${key.name ?? 'this key'}?`}
              description="Agents that use it lose access."
              confirm="Revoke"
              pending="Revoking…"
              onConfirm={async () => {
                setError('')
                await rpc((api) => api('account.revokeApiKey', { keyId: key.id })).finally(reload)
              }}
            />
          </li>
        ))}
      </ul>
      {props.keys.length === 0 && <p className="text-sm text-muted-foreground">No API keys.</p>}
      <Link to="/agents" className="inline-block underline underline-offset-4">
        How to connect an agent →
      </Link>
    </section>
  )
}
