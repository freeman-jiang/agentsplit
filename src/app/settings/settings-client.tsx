'use client'

import { AppearanceSettings } from '@/components/appearance-settings'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth-client'
import Link from 'next/link'
import { useEffect, useState } from 'react'

type Key = {
  id: string
  name: string | null
  start: string | null
  createdAt: Date
  expiresAt: Date | null
}
export function AccountSettings({
  name,
  email,
}: {
  name: string
  email: string
}) {
  const [keys, setKeys] = useState<Key[]>([]),
    [label, setLabel] = useState(''),
    [secret, setSecret] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false)
  async function load() {
    const result = await authClient.apiKey.list()
    if (result.error) setError(result.error.message ?? 'Unable to load keys')
    else setKeys(result.data.apiKeys)
  }
  useEffect(() => {
    void load()
  }, [])
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">{name}</h2>
        <p className="break-words text-muted-foreground">
          {email} · Verified by Google
        </p>
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
      <AppearanceSettings />
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Agent API keys</h2>
        <p className="text-sm text-muted-foreground">
          Each key acts as you and inherits your current group memberships and
          admin permissions. Create a separate key for each agent. Revoking a
          key stops its future requests.
        </p>
        <form
          className="flex flex-wrap gap-3"
          onSubmit={async (e) => {
            e.preventDefault()
            setPending(true)
            setError('')
            try {
              const result = await authClient.apiKey.create({ name: label })
              if (result.error)
                setError(result.error.message ?? 'Could not create key')
              else {
                setSecret(result.data.key)
                setLabel('')
                await load()
              }
            } catch {
              setError('Could not create key. Check your connection.')
            } finally {
              setPending(false)
            }
          }}
        >
          <label className="flex-1 min-w-40">
            <span className="sr-only">Key name</span>
            <Input
              aria-label="Key name"
              placeholder="e.g. My Codex"
              maxLength={32}
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
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
          <div className="border bg-card p-4 space-y-3">
            <p className="font-medium">
              Copy your new key now. It is shown only once.
            </p>
            <div className="flex items-center gap-3">
              <code className="min-w-0 break-all flex-1 text-sm">{secret}</code>
              <CopyButton text={secret} title="Copy API key" />
            </div>
            <Button variant="outline" size="sm" onClick={() => setSecret('')}>
              I’ve saved it
            </Button>
          </div>
        )}
        <ul className="divide-y border-y">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-4 py-4"
            >
              <div className="min-w-0">
                <p className="font-medium break-words">
                  {key.name ?? 'Agent key'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {key.start ? `${key.start}… · ` : ''}Created{' '}
                  {new Date(key.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Revoke ${key.name ?? 'this key'}? Its agent will lose access.`,
                    )
                  )
                    return
                  const result = await authClient.apiKey.delete({
                    keyId: key.id,
                  })
                  if (result.error)
                    setError(result.error.message ?? 'Unable to revoke key')
                  else await load()
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        {keys.length === 0 && (
          <p className="text-sm text-muted-foreground">No agent keys yet.</p>
        )}
        <Link
          href="/agents"
          className="inline-block underline underline-offset-4"
        >
          Connect Codex, Claude Code, or another agent →
        </Link>
      </section>
    </>
  )
}
