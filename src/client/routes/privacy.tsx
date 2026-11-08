import { createFileRoute } from '@tanstack/react-router'

// Public: no sign-in check. The text matches the current app: v2 runs on the
// same operator's server, with the same storage.
export const Route = createFileRoute('/privacy')({
  component: Privacy,
})

function Privacy() {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-12">
      <h1 className="font-display text-4xl">Privacy</h1>
      <p>This page says what this AgentSplit server stores about you and who can see it.</p>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Your Google account</h2>
        <p>
          Google sign-in gives AgentSplit your account ID, name, email address, whether the email is verified, and your profile image.
          AgentSplit uses them to create your account and to check invitations. It does not ask for access to Gmail, Drive, Calendar or
          your contacts. Sign-in data and sessions are stored in the operator’s database.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Groups and agents</h2>
        <p>
          Only the members of a group can see it. Members see its expenses, payments, receipts, log, and the other members’ names and
          email addresses. Group admins manage invitations and members. A group URL alone does not give access. An API key or a
          connected agent acts with its owner’s group permissions. You can revoke it on the Account page.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Storage and history</h2>
        <p>
          Accounts, expenses and receipts are stored on the operator’s servers. The log keeps every edit and deletion of an expense,
          with who made it and which receipts it had. Deleting an expense or leaving a group does not erase the log. The operator has
          admin access to the stored data. Contact the operator to see, keep or delete your data.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">External services</h2>
        <p>
          Google handles sign-in under its own privacy policy. This server has no analytics and does not send receipts to an AI. If you
          connect an agent, its provider also gets the data you ask the agent to read. API keys are stored as hashes. A new key is shown
          only once.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-medium">Browser storage</h2>
        <p>
          AgentSplit uses a session cookie to keep you signed in, and browser storage for display settings. The service worker saves the
          app’s code files, not group pages or receipts.
        </p>
      </section>
    </main>
  )
}
