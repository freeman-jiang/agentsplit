import { LoginButton } from '@/components/login-button'
import { TrackPage } from '@/lib/analytics/track-page'
import { getWebSession } from '@/lib/session'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'

export default async function HomePage() {
  if (await getWebSession()) redirect('/groups')
  const t = await getTranslations()
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
          <LoginButton />
        </div>
      </section>
    </main>
  )
}
