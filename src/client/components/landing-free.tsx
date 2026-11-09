import { Button } from '~/client/ui/button'

const REPOSITORY = 'https://github.com/freeman-jiang/agentsplit'

/** The landing page's promise: free forever, open source, and anyone can host a copy. */
export function LandingFree() {
  return (
    <section id="free" aria-labelledby="free-heading" className="border-t">
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:py-24">
        <h2 id="free-heading" className="font-display text-4xl leading-tight sm:text-5xl">
          Free forever.
          <span className="block text-muted-foreground">For everyone.</span>
        </h2>
        <p className="mt-6 text-muted-foreground sm:text-lg sm:leading-8">
          Splitting a bill should never cost money. AgentSplit has no ads and no paid plan, and it never will. It runs on one small free server, so no one has to pay for this software again.
        </p>
        <p className="mt-4 text-muted-foreground sm:text-lg sm:leading-8">The code is open source under the MIT license. Read it, change it, or run your own copy.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <a href={REPOSITORY}>See the code</a>
          </Button>
          <Button asChild variant="outline">
            <a href={`${REPOSITORY}/blob/main/DEPLOYMENT.md`}>Host it yourself</a>
          </Button>
        </div>
      </div>
    </section>
  )
}
