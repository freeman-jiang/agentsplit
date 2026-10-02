import { ApplePwaSplash } from '@/app/apple-pwa-splash'
import { AccountMenu } from '@/components/account-menu'
import { Brand } from '@/components/brand'
import { ProgressBar } from '@/components/progress-bar'
import { ServiceWorkerRegistration } from '@/components/service-worker-registration'
import { ThemeProvider } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/toaster'
import { Analytics } from '@/lib/analytics/analytics'
import { getAnalyticsConfig } from '@/lib/analytics/config'
import { effectiveBaseUrl } from '@/lib/env'
import { getWebSession } from '@/lib/session'
import { TRPCProvider } from '@/trpc/client'
import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider, useTranslations } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { Suspense } from 'react'
import './globals.css'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Homepage')
  return {
    metadataBase: new URL(effectiveBaseUrl),
    title: {
      default: t('metaTitle'),
      template: '%s · AgentSplit',
    },
    description:
      'Shared expenses for people and their agents. Keep track of costs, split fairly, and settle up.',
    openGraph: {
      title: t('metaTitle'),
      description:
        'Shared expenses for people and their agents. Keep track of costs, split fairly, and settle up.',
      images: `/banner.png`,
      type: 'website',
      url: '/',
    },
    twitter: {
      card: 'summary_large_image',
      images: `/banner.png`,
      title: t('metaTitle'),
      description:
        'Shared expenses for people and their agents. Keep track of costs, split fairly, and settle up.',
    },
    appleWebApp: {
      capable: true,
      title: 'AgentSplit',
    },
    applicationName: 'AgentSplit',
    icons: [
      {
        url: '/android-chrome-192x192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        url: '/android-chrome-512x512.png',
        sizes: '512x512',
        type: 'image/png',
      },
    ],
  }
}

export const viewport: Viewport = {
  themeColor: '#526044',
}

function Content({
  children,
  user,
}: {
  children: React.ReactNode
  user: { name: string } | null
}) {
  const t = useTranslations()
  return (
    <TRPCProvider>
      <header className="sticky top-0 z-50 border-b bg-background/95 px-3 py-3 backdrop-blur-sm sm:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <Link
            className="flex items-center gap-2"
            href={user ? '/groups' : '/'}
          >
            <Brand />
          </Link>
          {user && (
            <>
              <nav
                aria-label="Workspace"
                className="col-span-full row-start-2 flex flex-wrap gap-1 sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:justify-end"
              >
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/groups">{t('Header.groups')}</Link>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/agents">{t('Header.agentSetup')}</Link>
                </Button>
              </nav>
              <div className="col-start-2 row-start-1 flex justify-end sm:col-start-3">
                <AccountMenu name={user.name} />
              </div>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 flex flex-col">{children}</div>

      <footer className="mt-12 flex flex-col gap-4 border-t px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-end sm:justify-between sm:px-8">
        <div className="space-y-2">
          <Link href={user ? '/groups' : '/'} className="text-foreground">
            <Brand className="text-xl" />
          </Link>
          <p>{t('Footer.tagline')}</p>
          <Link href="/privacy" className="underline underline-offset-4">
            Privacy
          </Link>
        </div>
        <p>
          {t.rich('Footer.upstream', {
            source: (text) => <span>{text}</span>,
          })}
        </p>
      </footer>
      <Toaster />
    </TRPCProvider>
  )
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getWebSession()
  const locale = await getLocale()
  const messages = await getMessages()
  const analyticsConfig = await getAnalyticsConfig()
  return (
    <html
      lang={locale}
      dir={['ar', 'he'].includes(locale) ? 'rtl' : 'ltr'}
      suppressHydrationWarning
    >
      <ApplePwaSplash icon="/logo-with-text.png" color="#526044" />
      <body className="min-h-[100dvh] flex flex-col items-stretch bg-background">
        <NextIntlClientProvider messages={messages}>
          {/* Rendered inside the provider because it reads translations via
              `useTranslations`, which needs NextIntlClientProvider in its
              ancestor tree. */}
          <ServiceWorkerRegistration />
          <Analytics config={analyticsConfig}>
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <Suspense>
                <ProgressBar />
              </Suspense>
              <Content user={session ? { name: session.user.name } : null}>
                {children}
              </Content>
            </ThemeProvider>
          </Analytics>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
