import { Button } from '~/client/ui/button'

const REPOSITORY = 'https://github.com/freeman-jiang/agentsplit'
export const AUTHOR = { name: 'Freeman Jiang', url: 'https://freemanjiang.com' }

/** GitHub's mark (Octicons mark-github, MIT), in the button's text color. */
function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  )
}

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
          I did the math: one server on Google Cloud’s free tier can run AgentSplit for about 145,000 people. So it has no ads and no paid plan, and it never will. I don’t think anyone should ever have to pay for this kind of software.
        </p>
        <p className="mt-4 text-muted-foreground sm:text-lg sm:leading-8">The code is open source under the MIT license. Read it, change it, or run your own copy.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild className="gap-2">
            <a href={REPOSITORY}>
              <GitHubMark />
              See the code
            </a>
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
