import { Button } from '@/components/ui/button'
// lucide-react v1 dropped its brand icons, so the GitHub mark comes from Radix.
import { TrackPage } from '@/lib/analytics/track-page'
import { GitHubLogoIcon } from '@radix-ui/react-icons'
import { useTranslations } from 'next-intl'
import Link from 'next/link'

// FIX for https://github.com/vercel/next.js/issues/58615
// export const dynamic = 'force-dynamic'

export default function HomePage() {
  const t = useTranslations()
  return (
    <main>
      <TrackPage path="/" />
      <section className="py-16 md:py-24 lg:py-32">
        <div className="container flex max-w-screen-md flex-col items-center gap-6 text-center">
          <h1 className="!leading-none font-display font-normal text-4xl sm:text-5xl md:text-6xl landing-header py-2">
            {t.rich('Homepage.title', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </h1>
          <p className="max-w-lg leading-normal text-muted-foreground sm:text-xl sm:leading-8">
            {t.rich('Homepage.description', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link href="/groups">{t('Homepage.button.groups')}</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="https://github.com/freeman-jiang/agentsplit">
                <GitHubLogoIcon className="w-4 h-4 mr-2" />
                {t('Homepage.button.github')}
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  )
}
