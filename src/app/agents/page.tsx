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
        <p className="text-muted-foreground">
          Choose one way to connect. Both use your AgentSplit account and
          current group permissions.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <a href="#oauth" className="border bg-card p-4 space-y-2">
            <h2 className="font-medium">OAuth · Recommended</h2>
            <p className="text-sm text-muted-foreground">
              For ChatGPT, Claude, and clients with browser sign-in. Sign in
              with Google and approve access.
            </p>
          </a>
          <a href="#api-key" className="border bg-card p-4 space-y-2">
            <h2 className="font-medium">API key</h2>
            <p className="text-sm text-muted-foreground">
              For scripts, automation, or manual client setup. Create a key and
              paste it into your client’s settings.
            </p>
          </a>
        </div>
      </header>

      <div className="flex items-center gap-3 border bg-card p-4">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-xs text-muted-foreground">
            MCP server URL · Use this for either method
          </p>
          <code className="break-all text-sm">{endpoint}</code>
        </div>
        <CopyButton text={endpoint} title={t('copyEndpoint')} />
      </div>

      <section
        id="oauth"
        className="scroll-mt-6 space-y-4"
        aria-labelledby="oauth-title"
      >
        <h2 id="oauth-title" className="font-display text-2xl">
          Connect with OAuth
        </h2>
        <p className="text-sm text-muted-foreground">
          No API key needed. Your first Google sign-in creates your account
          automatically.
        </p>
        <details className="border-y py-4">
          <summary className="cursor-pointer font-medium">ChatGPT</summary>
          <div className="space-y-4 pt-4 text-sm leading-relaxed">
            <ol className="list-decimal space-y-3 ps-5">
              <li>
                On ChatGPT web, open{' '}
                <a href="https://chatgpt.com/plugins" className="underline">
                  Plugins
                </a>
                . Choose <strong>+ / Add → Add custom MCP server</strong>.
              </li>
              <li>
                Fill in these fields:
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border bg-card p-3">
                  <dt className="text-muted-foreground">Name</dt>
                  <dd>AgentSplit</dd>
                  <dt className="text-muted-foreground">Description</dt>
                  <dd>Shared expenses, payments and balances.</dd>
                  <dt className="text-muted-foreground">Server URL</dt>
                  <dd>The MCP server URL above</dd>
                  <dt className="text-muted-foreground">Authentication</dt>
                  <dd>OAuth</dd>
                </dl>
              </li>
              <li>
                In <strong>Advanced OAuth settings</strong>, keep the detected{' '}
                <strong>CIMD</strong> registration method. Set{' '}
                <strong>Base scopes</strong> to <code>offline_access</code> to
                stay connected. Leave client ID, client secret and headers
                empty.
              </li>
              <li>
                Review the warning, confirm that you want to continue, then
                click <strong>Create as a plugin</strong>. When prompted, click{' '}
                <strong>Connect</strong> and{' '}
                <strong>Continue to AgentSplit</strong>.
              </li>
              <li>
                Sign in with Google. Review the permissions and click{' '}
                <strong>Allow access</strong>. Uncheck{' '}
                <strong>Allow changes</strong> if you only want the agent to
                read.
              </li>
              <li>
                Open AgentSplit in your personal plugins and install it with{' '}
                <strong>+</strong> if needed. Start a new <strong>Work</strong>{' '}
                chat, type <strong>@</strong>, select{' '}
                <strong>AgentSplit</strong>, and ask it to show your groups.
              </li>
            </ol>
            <a
              className="inline-block underline text-muted-foreground"
              href="https://developers.openai.com/plugins/quickstart"
            >
              Official ChatGPT setup guide
            </a>
          </div>
        </details>
        <details className="border-b pb-4">
          <summary className="cursor-pointer font-medium">Claude</summary>
          <div className="space-y-4 pt-4 text-sm leading-relaxed">
            <ol className="list-decimal space-y-3 ps-5">
              <li>
                Open{' '}
                <strong>
                  Customize → Connectors → + Add → Add custom connector
                </strong>
                .
              </li>
              <li>
                Enter <strong>AgentSplit</strong> for <strong>Name</strong> and
                paste the URL above into <strong>MCP server URL</strong>. Click{' '}
                <strong>Continue</strong>.
              </li>
              <li>
                Use these authentication settings, then click{' '}
                <strong>Add</strong>:
                <dl className="mt-2 space-y-2 border bg-card p-3">
                  <div>
                    <dt className="text-muted-foreground">Authentication</dt>
                    <dd>Sign in now</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">OAuth client</dt>
                    <dd>Use Claude’s published identity (Recommended)</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      Client ID, client secret and request headers
                    </dt>
                    <dd>Leave empty</dd>
                  </div>
                </dl>
              </li>
              <li>
                Click <strong>Connect</strong> if prompted. Sign in with Google,
                review the permissions, and click <strong>Allow access</strong>.
                Uncheck <strong>Allow changes</strong> for read-only access.
              </li>
              <li>
                In a chat, open <strong>+ → Connectors</strong> and enable{' '}
                <strong>AgentSplit</strong>. Ask it to show your groups.
              </li>
            </ol>
            <p className="text-muted-foreground">
              If you see the older one-page dialog, enter the name and URL,
              leave Advanced OAuth credentials empty, and click Add. For Team or
              Enterprise, an owner first adds the connector in Organization
              settings → Connectors.
            </p>
            <a
              className="inline-block underline text-muted-foreground"
              href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
            >
              Official Claude setup guide
            </a>
          </div>
        </details>
        <p className="text-sm text-muted-foreground">
          Manage or revoke OAuth access in{' '}
          <Link href="/settings/connections" className="underline">
            Connected apps
          </Link>
          .
        </p>
      </section>

      <section
        id="api-key"
        className="scroll-mt-6 space-y-4"
        aria-labelledby="key-title"
      >
        <h2 id="key-title" className="font-display text-2xl">
          Connect with an API key
        </h2>
        <p className="text-sm text-muted-foreground">
          Use this when your client needs a fixed credential. Create one key per
          agent so you can revoke it separately.
        </p>
        <Button asChild>
          <Link href="/settings">Create an API key</Link>
        </Button>
        <p className="text-sm">
          Add the MCP server URL above. Under <strong>Headers</strong>, enter:
        </p>
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
        </div>
        <p className="text-sm text-muted-foreground">{t('keyPrivacy')}</p>
        <details className="border-y py-4">
          <summary className="cursor-pointer font-medium">Codex app</summary>
          <ol className="list-decimal space-y-3 ps-5 pt-4 text-sm leading-relaxed">
            <li>
              Open <strong>Plugins → MCPs</strong> and add an HTTP MCP server.
            </li>
            <li>
              Enter <strong>agentsplit</strong> as the name and paste the MCP
              server URL into <strong>URL</strong>.
            </li>
            <li>
              Under <strong>Headers</strong>, add <code>X-API-Key</code> with
              your key as its value. No prefix, quotes, or environment variable
              is needed.
            </li>
            <li>
              Click <strong>Save</strong>, then enable or reconnect AgentSplit.
            </li>
          </ol>
        </details>
        <details className="border-b pb-4">
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
        <details className="border-b pb-4">
          <summary className="cursor-pointer text-sm font-medium">
            Claude Code with an API key
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
      </section>

      <section className="space-y-4" aria-labelledby="start-title">
        <h2 id="start-title" className="font-display text-2xl">
          Start with your groups
        </h2>
        <p className="text-sm">
          Ask: “Show my AgentSplit groups and balances.” If you’re new, ask your
          agent to create a group or accept your invitation link. Invitations
          must match your Google email; you can accept before or after
          connecting.
        </p>
        <details className="border-y py-4">
          <summary className="cursor-pointer text-sm font-medium">
            Detailed agent instructions
          </summary>
          <div className="space-y-3 pt-4">
            <CopyButton text={instructions} title={t('copyInstructions')} />
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {instructions}
            </p>
          </div>
        </details>
      </section>
    </main>
  )
}
