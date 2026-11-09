import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowDown } from 'lucide-react'
import { requireSignedIn } from '~/client/queries/session'
import { Button } from '~/client/ui/button'
import { CopyButton } from '~/client/ui/copy-button'
import { DisclosureSummary } from '~/client/ui/disclosure'
import { API_KEY_HEADER, MCP_PATH, type McpToolName } from '~/shared/mcp'

export const Route = createFileRoute('/agents')({
  beforeLoad: ({ context, location }) => requireSignedIn({ queryClient: context.queryClient, location }),
  component: AgentSetup,
})

const ENVIRONMENT =
  'For configuration-file examples, set AGENTSPLIT_API_KEY to your API key exactly as copied. The Codex app steps above do not need environment variables.'

function Configuration(props: { title: string; description: string; code: string; copyLabel: string }) {
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-medium">{props.title}</h3>
        <CopyButton text={props.code} title={props.copyLabel} />
      </div>
      <p className="text-sm text-muted-foreground">{props.description}</p>
      <pre className="whitespace-pre-wrap break-all rounded-2xl border bg-card p-4 text-xs leading-relaxed sm:text-sm">
        <code>{props.code}</code>
      </pre>
    </section>
  )
}

/** A tool name in the text, checked against the server's tools. */
const tool = (name: McpToolName) => name

function AgentSetup() {
  // The SPA is served only from BASE_URL, so this page's origin is the MCP origin.
  const endpoint = new URL(MCP_PATH, window.location.origin).href
  const codex = `[mcp_servers.agentsplit]\nurl = ${JSON.stringify(endpoint)}\nenv_http_headers = { ${JSON.stringify(API_KEY_HEADER)} = "AGENTSPLIT_API_KEY" }`
  const claude = JSON.stringify(
    { mcpServers: { agentsplit: { type: 'http', url: endpoint, headers: { [API_KEY_HEADER]: '${AGENTSPLIT_API_KEY}' } } } },
    null,
    2,
  )
  const instructions = `Use AgentSplit at ${endpoint} through MCP. Use the OAuth connection or API key already configured in my client.

Start with ${tool('list_groups')}. A group URL alone does not grant access. If I provide an invitation link addressed to my Google email, use ${tool('manage_group_access')} with action=join and shareUrl. Read ${tool('get_group')} for members, roles and participant IDs, and ${tool('get_reference_data')} for currencies, categories and split modes.

Use exact decimal strings for money and keep currencies separate. Read the current revision before editing or deleting. Record payments with ${tool('create_expense')} and isReimbursement=true. For private receipt downloadUrl values, use the same connection credentials: OAuth Authorization header or ${API_KEY_HEADER}. Only make changes I request, and confirm the committed result.`
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <div className="max-w-3xl space-y-10 lg:space-y-8">
        <header className="space-y-6">
          <div>
            <h1 className="font-display text-3xl">Connect an agent</h1>
            <p className="mt-2 text-sm text-muted-foreground">Choose one way to connect. Both act as you, with your group permissions.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <a href="#oauth" className="relative space-y-2 rounded-2xl border bg-card p-4 transition-colors hover:bg-accent">
              <h2 className="pe-6 font-medium">OAuth · Recommended</h2>
              <ArrowDown aria-hidden="true" className="absolute top-5 right-4 h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                For ChatGPT, Claude, and clients with browser sign-in. Sign in with Google and approve access.
              </p>
            </a>
            <a href="#api-key" className="relative space-y-2 rounded-2xl border bg-card p-4 transition-colors hover:bg-accent">
              <h2 className="pe-6 font-medium">API key</h2>
              <ArrowDown aria-hidden="true" className="absolute top-5 right-4 h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                For scripts, automation, or manual client setup. Create a key and paste it into your client’s settings.
              </p>
            </a>
          </div>
        </header>

        <div className="flex items-center gap-3 rounded-2xl border bg-card p-4">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted-foreground">MCP server URL · for both ways to connect</p>
            <code className="break-all text-sm">{endpoint}</code>
          </div>
          <CopyButton text={endpoint} title="Copy MCP server URL" />
        </div>

        <section id="oauth" className="scroll-mt-6 space-y-4" aria-labelledby="oauth-title">
          <div className="space-y-1.5">
            <h2 id="oauth-title" className="text-xl font-semibold tracking-tight">
              Connect with OAuth
            </h2>
            <p className="text-sm text-muted-foreground">No API key needed. You sign in with Google.</p>
          </div>
          <div className="divide-y border-y">
            <details className="py-1">
              <DisclosureSummary>ChatGPT</DisclosureSummary>
              <div className="space-y-4 pt-2 pb-4 text-sm leading-relaxed">
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
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-2xl border bg-card p-3">
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
                    In <strong>Advanced OAuth settings</strong>, keep the detected <strong>CIMD</strong> registration method. Set{' '}
                    <strong>Base scopes</strong> to <code>offline_access</code> to stay connected. Leave client ID, client secret and headers
                    empty.
                  </li>
                  <li>
                    Review the warning, confirm that you want to continue, then click <strong>Create as a plugin</strong>. When prompted, click{' '}
                    <strong>Connect</strong> and <strong>Continue to AgentSplit</strong>.
                  </li>
                  <li>
                    Sign in with Google. Review the permissions and click <strong>Allow access</strong>. Uncheck <strong>Allow changes</strong> if
                    you only want the agent to read.
                  </li>
                  <li>
                    Open AgentSplit in your personal plugins and install it with <strong>+</strong> if needed. Start a new <strong>Work</strong>{' '}
                    chat, type <strong>@</strong>, select <strong>AgentSplit</strong>, and ask it to show your groups.
                  </li>
                </ol>
                <a className="inline-block text-muted-foreground underline" href="https://developers.openai.com/plugins/quickstart">
                  Official ChatGPT setup guide
                </a>
              </div>
            </details>
            <details className="py-1">
              <DisclosureSummary>Claude</DisclosureSummary>
              <div className="space-y-4 pt-2 pb-4 text-sm leading-relaxed">
                <ol className="list-decimal space-y-3 ps-5">
                  <li>
                    Open <strong>Customize → Connectors → + Add → Add custom connector</strong>.
                  </li>
                  <li>
                    Enter <strong>AgentSplit</strong> for <strong>Name</strong> and paste the URL above into <strong>MCP server URL</strong>.
                    Click <strong>Continue</strong>.
                  </li>
                  <li>
                    Use these authentication settings, then click <strong>Add</strong>:
                    <dl className="mt-2 space-y-2 rounded-2xl border bg-card p-3">
                      <div>
                        <dt className="text-muted-foreground">Authentication</dt>
                        <dd>Sign in now</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">OAuth client</dt>
                        <dd>Use Claude’s published identity (Recommended)</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Client ID, client secret and request headers</dt>
                        <dd>Leave empty</dd>
                      </div>
                    </dl>
                  </li>
                  <li>
                    Click <strong>Connect</strong> if prompted. Sign in with Google, review the permissions, and click{' '}
                    <strong>Allow access</strong>. Uncheck <strong>Allow changes</strong> for read-only access.
                  </li>
                  <li>
                    In a chat, open <strong>+ → Connectors</strong> and enable <strong>AgentSplit</strong>. Ask it to show your groups.
                  </li>
                </ol>
                <p className="text-muted-foreground">
                  If you see the older one-page dialog, enter the name and URL, leave Advanced OAuth credentials empty, and click Add. For Team
                  or Enterprise, an owner first adds the connector in Organization settings → Connectors.
                </p>
                <a
                  className="inline-block text-muted-foreground underline"
                  href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
                >
                  Official Claude setup guide
                </a>
              </div>
            </details>
          </div>
          <p className="text-sm text-muted-foreground">
            Manage or revoke OAuth access in{' '}
            <Link to="/settings/connections" className="underline">
              Connected apps
            </Link>
            .
          </p>
        </section>

        <section id="api-key" className="scroll-mt-6 space-y-4" aria-labelledby="key-title">
          <div className="space-y-1.5">
            <h2 id="key-title" className="text-xl font-semibold tracking-tight">
              Connect with an API key
            </h2>
            <p className="text-sm text-muted-foreground">
              Use this when your client needs a fixed credential. Create one key per agent so you can revoke it separately.
            </p>
          </div>
          <Button asChild>
            <Link to="/settings">Create an API key</Link>
          </Button>
          <p className="text-sm">
            Add the MCP server URL above. Under <strong>Headers</strong>, enter:
          </p>
          <div className="space-y-3 rounded-2xl border bg-card p-4 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span>
                Header name: <code>{API_KEY_HEADER}</code>
              </span>
              <CopyButton text={API_KEY_HEADER} title="Copy header name" />
            </div>
            <p>
              Header value: <strong>your API key, exactly as copied</strong>
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            Keep the key in your client’s private settings or environment. Do not paste it into an agent conversation or a group note.
          </p>
          <div className="divide-y border-y">
            <details className="py-1">
              <DisclosureSummary>Codex app</DisclosureSummary>
              <ol className="list-decimal space-y-3 ps-5 pt-2 pb-4 text-sm leading-relaxed">
                <li>
                  Open <strong>Plugins → MCPs</strong> and add an HTTP MCP server.
                </li>
                <li>
                  Enter <strong>agentsplit</strong> as the name and paste the MCP server URL into <strong>URL</strong>.
                </li>
                <li>
                  Under <strong>Headers</strong>, add <code>{API_KEY_HEADER}</code> with your key as its value. No prefix, quotes, or environment
                  variable is needed.
                </li>
                <li>
                  Click <strong>Save</strong>, then enable or reconnect AgentSplit.
                </li>
              </ol>
            </details>
            <details className="py-1">
              <DisclosureSummary>Codex CLI and configuration files</DisclosureSummary>
              <div className="space-y-5 pt-2 pb-4">
                <p className="text-sm text-muted-foreground">{ENVIRONMENT}</p>
                <Configuration
                  title="Codex configuration"
                  description="Add this to your private ~/.codex/config.toml, then reconnect the MCP server or restart Codex."
                  code={codex}
                  copyLabel="Copy Codex configuration"
                />
              </div>
            </details>
            <details className="py-1">
              <DisclosureSummary>Claude Code with an API key</DisclosureSummary>
              <div className="space-y-4 pt-2 pb-4">
                <p className="text-sm text-muted-foreground">{ENVIRONMENT}</p>
                <Configuration
                  title="Claude Code configuration"
                  description="Save this MCP configuration privately and load it with claude --mcp-config /path/to/config.json."
                  code={claude}
                  copyLabel="Copy Claude Code configuration"
                />
              </div>
            </details>
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="start-title">
          <div className="space-y-1.5">
            <h2 id="start-title" className="text-xl font-semibold tracking-tight">
              Start with your groups
            </h2>
            <p className="text-sm text-muted-foreground">
              Ask: “Show my AgentSplit groups and balances.” Your agent can also create a group or accept an invitation link. An invitation
              works only for the Google email it was sent to.
            </p>
          </div>
          <div className="divide-y border-y">
            <details className="py-1">
              <DisclosureSummary>Agent instructions</DisclosureSummary>
              <div className="space-y-3 pt-2 pb-4">
                <CopyButton text={instructions} title="Copy agent instructions" />
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{instructions}</p>
              </div>
            </details>
          </div>
        </section>
      </div>
    </main>
  )
}
