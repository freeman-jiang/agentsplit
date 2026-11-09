import { ChartColumn, Download, History, type LucideIcon, Receipt, Repeat, Scale, SplitSquareHorizontal, UserRound, Users } from 'lucide-react'

// The landing page's list of what AgentSplit does. Each line must stay true of
// both the website and the MCP tools (src/server/mcp/tools), because the
// heading says an agent can do all of it.

type Feature = { readonly icon: LucideIcon; readonly title: string; readonly text: string }

const FEATURES = [
  { icon: Users, title: 'Groups', text: 'Private groups for a home, a trip or a couple. Invite people by their Google email.' },
  { icon: SplitSquareHorizontal, title: 'Any split', text: 'Evenly, by shares, by percent or by exact amounts. More than one person can pay.' },
  { icon: Scale, title: 'Balances and payments', text: 'See who owes whom in every currency, and the payments that settle it.' },
  { icon: Repeat, title: 'Recurring expenses', text: 'Rent and bills add themselves every day, week or month.' },
  { icon: Receipt, title: 'Receipts', text: 'Attach a photo of the receipt to any expense.' },
  { icon: History, title: 'Full history', text: 'Every change is kept: what changed, who made it, and whether a person or an agent did it.' },
  { icon: ChartColumn, title: 'Spending stats', text: 'Totals by person, category and month.' },
  { icon: Download, title: 'Export', text: 'Download a group as CSV or JSON at any time.' },
  { icon: UserRound, title: 'One-off splits', text: 'Split a single bill with anyone. No group needed.' },
] as const satisfies ReadonlyArray<Feature>

export function LandingFeatures() {
  return (
    <section aria-labelledby="features-heading" className="mx-auto w-full max-w-screen-lg px-4 pt-8 pb-16 sm:pb-24">
      <div className="mx-auto max-w-2xl text-center">
        <h2 id="features-heading" className="font-display text-3xl leading-tight text-balance sm:text-4xl">
          Everything you need to share costs.
          <span className="block text-muted-foreground">Your agent can do all of it.</span>
        </h2>
        <p className="mt-4 text-pretty text-muted-foreground sm:text-lg">
          Connect Claude, ChatGPT or any MCP client. It uses the same tools as the website, and you can give it read-only access.
        </p>
      </div>
      <ul className="mt-12 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <li key={title} className="flex gap-3">
            <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <div>
              <h3 className="font-medium">{title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{text}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-16 text-center text-sm text-muted-foreground">
        Free and open source. No ads and no paid plan.{' '}
        <a href="https://github.com/freeman-jiang/agentsplit" className="text-foreground underline underline-offset-4">
          See the code
        </a>
      </p>
    </section>
  )
}
