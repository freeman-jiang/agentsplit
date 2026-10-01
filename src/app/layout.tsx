import { ApplePwaSplash } from '@/app/apple-pwa-splash'
import { Brand } from '@/components/brand'
import { LocaleSwitcher } from '@/components/locale-switcher'
import { ProgressBar } from '@/components/progress-bar'
import { ServiceWorkerRegistration } from '@/components/service-worker-registration'
import { ThemeProvider } from '@/components/theme-provider'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/toaster'
import { Analytics } from '@/lib/analytics/analytics'
import { getAnalyticsConfig } from '@/lib/analytics/config'
import { effectiveBaseUrl } from '@/lib/env'
import { TRPCProvider } from '@/trpc/client'
import { PanelsTopLeft } from 'lucide-react'
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

function Content({ children }: { children: React.ReactNode }) {
  const t = useTranslations()
  return (
    <TRPCProvider>
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between gap-2 border-b bg-background/95 px-3 backdrop-blur-sm sm:px-8">
        <Link className="flex items-center gap-2" href="/">
          <Brand />
        </Link>
        <div role="navigation" aria-label="Menu" className="flex">
          <ul className="flex items-center text-sm">
            <li>
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="-my-3 w-11 px-2 text-primary sm:w-auto sm:px-3"
              >
                <Link href="/groups" aria-label={t('Header.groups')}>
                  <PanelsTopLeft
                    className="h-4 w-4 sm:hidden"
                    aria-hidden="true"
                  />
                  <span className="hidden sm:inline">{t('Header.groups')}</span>
                </Link>
              </Button>
            </li>
            <li>
              <LocaleSwitcher />
            </li>
            <li>
              <ThemeToggle />
            </li>
          </ul>
        </div>
      </header>

      <div className="flex-1 flex flex-col">{children}</div>

      <footer className="mt-12 flex flex-col gap-4 border-t px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-end sm:justify-between sm:px-8">
        <div className="space-y-2">
          <Link href="/" className="text-foreground">
            <Brand className="text-xl" />
          </Link>
          <p>{t('Footer.tagline')}</p>
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
              <Content>{children}</Content>
            </ThemeProvider>
          </Analytics>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
