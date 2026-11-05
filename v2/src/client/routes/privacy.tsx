import { createFileRoute } from '@tanstack/react-router'

// Public: no sign-in check. The text matches the current app, except where v2
// runs on other infrastructure (Cloudflare and Google Cloud instead of one server).
export const Route = createFileRoute('/privacy')({
  component: Privacy,
})

function Privacy() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-12">
      <h1 className="font-display text-4xl">Privacy in AgentSplit</h1>
      <p>AgentSplit is a self-hosted shared-expense app. This page describes how this instance handles your information.</p>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Your Google account</h2>
        <p>
          Google sign-in provides your account identifier, name, email address, verified-email status, and profile image. AgentSplit uses
          this information to create your account and verify invitations. It does not request access to Gmail, Drive, Calendar, or your
          contacts. Sign-in credentials and sessions are stored in the instance operator’s database.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Groups and agents</h2>
        <p>
          Your groups are private to their members. Members can see the ledger, receipts, activity history, and other members’ names and
          email addresses. Group admins manage invitations and membership. A group URL alone does not grant access. Agent keys act with
          their owner’s current group permissions and can be revoked in Account &amp; keys.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Storage and history</h2>
        <p>
          Accounts and expenses are stored in the operator’s database on Google Cloud, and receipts in the operator’s Cloudflare storage.
          Expense edits and deletions retain an audit history, including the authenticated actor and receipt references. Removing an
          expense or leaving a group does not erase this history. The instance operator has administrative access to the stored data.
          Contact the operator about access, retention, or deletion requests.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">External services</h2>
        <p>
          Google processes sign-in under its own privacy policy. Cloudflare and Google Cloud host this instance for the operator. This
          deployment does not enable analytics or AI receipt processing. If you connect an external agent, the information you ask that
          agent to access is also handled by its provider. API keys are stored as hashes; newly created keys are shown once.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Browser storage</h2>
        <p>
          AgentSplit uses a session cookie to keep you signed in and local browser storage for display preferences. The service worker
          caches application assets, not private group pages or receipts.
        </p>
      </section>
    </main>
  )
}
