import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { effectiveBaseUrl } from '@/lib/env'
import { requireWebUser } from '@/lib/session'
import { getTranslations } from 'next-intl/server'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('AgentSetup')
  return { title: t('title') }
}

function Configuration({
  title,
  description,
  code,
  copyLabel,
}: {
  title: string
  description: string
  code: string
  copyLabel: string
}) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium">{title}</h3>
        <CopyButton text={code} title={copyLabel} />
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      <pre className="whitespace-pre-wrap break-all border bg-card p-4 text-xs leading-relaxed sm:text-sm">
        <code>{code}</code>
      </pre>
    </section>
  )
}

export default async function AgentSetupPage() {
  await requireWebUser()
  const t = await getTranslations('AgentSetup')
  const endpoint = new URL('/api/mcp', effectiveBaseUrl).toString()
  const codex = `[mcp_servers.agentsplit]\nurl = ${JSON.stringify(endpoint)}\nenv_http_headers = { "X-API-Key" = "AGENTSPLIT_API_KEY" }`
  const claude = JSON.stringify(
    {
      mcpServers: {
        agentsplit: {
          type: 'http',
          url: endpoint,
          headers: { 'X-API-Key': '${AGENTSPLIT_API_KEY}' },
        },
      },
    },
    null,
    2,
  )
  const instructions = t('instructions', { endpoint })
  return (
    <main className="mx-auto w-full max-w-3xl space-y-10 px-4 py-8 sm:px-8 sm:py-12">
      <header className="space-y-4">
        <h1 className="font-display text-3xl tracking-tight sm:text-4xl">
          {t('title')}
        </h1>
        <p className="max-w-xl text-muted-foreground">{t('intro')}</p>
      </header>

      <section className="space-y-3" aria-labelledby="agent-key-title">
        <h2 id="agent-key-title" className="text-lg font-medium">
          {t('keyTitle')}
        </h2>
        <p className="text-sm">
          Create your own key in Account & keys. It gives your agent access to
          the same groups and permissions as your signed-in account.
        </p>
        <p className="border-s-2 border-primary bg-muted p-4 text-sm">
          <Button asChild>
            <Link href="/settings">Create an API key</Link>
          </Button>
        </p>
        <p className="text-sm text-muted-foreground">{t('keyPrivacy')}</p>
      </section>

      <section className="space-y-5" aria-labelledby="agent-connect-title">
        <h2 id="agent-connect-title" className="text-lg font-medium">
          {t('connectTitle')}
        </h2>
        <div className="flex items-center gap-3 border bg-card p-3">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted-foreground">
              {t('endpoint')}
            </p>
            <code className="break-all text-sm">{endpoint}</code>
          </div>
          <CopyButton text={endpoint} title={t('copyEndpoint')} />
        </div>
        <section className="space-y-4" aria-labelledby="codex-app-title">
          <h3 id="codex-app-title" className="text-lg font-medium">
            Codex app
          </h3>
          <ol className="list-decimal space-y-3 ps-5 text-sm leading-relaxed">
            <li>
              Open <strong>Plugins → MCPs</strong> in the Codex app. Add an HTTP
              MCP server, or edit your existing AgentSplit connection.
            </li>
            <li>
              Use <code>agentsplit</code> as the name and copy the MCP URL above
              into <strong>URL</strong>.
            </li>
            <li>
              Under <strong>Headers</strong>, set the header name to{' '}
              <code>X-API-Key</code> and paste your API key directly into its
              value.
            </li>
            <li>Save, then enable or reconnect AgentSplit if needed.</li>
          </ol>
          <div className="border bg-card p-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span>
                Header name: <code>X-API-Key</code>
              </span>
              <CopyButton text="X-API-Key" title="Copy header name" />
            </div>
            <p>
              Header value: <strong>your API key, exactly as copied</strong>
            </p>
            <p className="text-muted-foreground">
              No prefix, quotes, or extra formatting needed.
            </p>
          </div>
        </section>
        <details className="border-y py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Codex CLI and configuration files
          </summary>
          <div className="space-y-5 pt-4">
            <p className="text-sm text-muted-foreground">{t('environment')}</p>
            <Configuration
              title="Codex configuration"
              description={t('codexDescription')}
              code={codex}
              copyLabel={t('copyCodex')}
            />
          </div>
        </details>
        <details className="border-b pb-3">
          <summary className="cursor-pointer text-sm font-medium">
            Claude Code
          </summary>
          <div className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">{t('environment')}</p>
            <Configuration
              title="Claude Code configuration"
              description={t('claudeDescription')}
              code={claude}
              copyLabel={t('copyClaude')}
            />
          </div>
        </details>
        <details className="border-b pb-3">
          <summary className="cursor-pointer text-sm font-medium">
            {t('otherClients')}
          </summary>
          <div className="space-y-3 pt-3 text-sm text-muted-foreground">
            <p>{t('otherDescription')}</p>
            <code className="block break-all text-foreground">
              X-API-Key: YOUR_API_KEY
            </code>
            <p>{t('noOauth')}</p>
          </div>
        </details>
        <p className="text-xs text-muted-foreground">
          {t('references')}{' '}
          <a
            className="underline underline-offset-4"
            href="https://learn.chatgpt.com/docs/extend/mcp"
          >
            Codex
          </a>
          {' · '}
          <a
            className="underline underline-offset-4"
            href="https://code.claude.com/docs/en/mcp"
          >
            Claude Code
          </a>
        </p>
      </section>

      <section className="space-y-3" aria-labelledby="agent-use-title">
        <div className="flex items-center justify-between gap-4">
          <h2 id="agent-use-title" className="text-lg font-medium">
            {t('useTitle')}
          </h2>
          <CopyButton text={instructions} title={t('copyInstructions')} />
        </div>
        <p className="text-sm text-muted-foreground">{t('useDescription')}</p>
        <div className="whitespace-pre-wrap border bg-card p-4 text-sm leading-relaxed">
          {instructions}
        </div>
        <p className="text-sm text-muted-foreground">{t('capabilities')}</p>
      </section>
    </main>
  )
}
