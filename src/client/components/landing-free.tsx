import { Button } from '~/client/ui/button'

const REPOSITORY = 'https://github.com/freeman-jiang/agentsplit'
export const AUTHOR = { name: 'Freeman Jiang', url: 'https://freemanjiang.com' }

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
          I did the math: one server on Google Cloud’s free tier can run AgentSplit for about 145,000 people. So it has no ads and no paid plan, and it never will. I don’t think anyone should ever pay for this.
        </p>
        <p className="mt-4 text-muted-foreground sm:text-lg sm:leading-8">The code is open source under the MIT license. Read it, change it, or run your own copy.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <a href={REPOSITORY}>See the code</a>
          </Button>
          <Button asChild variant="outline">
            <a href={`${REPOSITORY}/blob/main/DEPLOYMENT.md`}>Host it yourself</a>
          </Button>
          <Button asChild variant="ghost">
            <a href={`${REPOSITORY}/blob/main/docs/CAPACITY.md`}>See the math</a>
          </Button>
        </div>
        <p className="mt-10 text-sm text-muted-foreground">
          Created by{' '}
          <a href={AUTHOR.url} className="text-foreground underline underline-offset-4">
            {AUTHOR.name}
          </a>
        </p>
      </div>
    </section>
  )
}
