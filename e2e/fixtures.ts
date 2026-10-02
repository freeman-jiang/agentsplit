import { test as base, expect } from '@playwright/test'
import { seedAccount } from './auth'

/** Authenticated disposable account; English locale and offline third-party services. */
type Options = {
  authenticated: boolean
  /**
   * Rate returned for every api.frankfurter.dev request, so currency
   * conversion is deterministic and offline. Null (the default) aborts the
   * request instead, which is what every non-currency spec wants.
   */
  exchangeRate: number | null
}

export const test = base.extend<Options>({
  authenticated: [true, { option: true }],
  exchangeRate: [null, { option: true }],

  // The second argument is Playwright's `use` callback, renamed because
  // eslint-plugin-react-hooks would otherwise read `use(...)` as React's hook.
  page: async ({ page, baseURL, exchangeRate, authenticated }, runTest) => {
    if (baseURL) {
      if (authenticated) await seedAccount(page.context(), baseURL)
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'en-US', url: baseURL }])
    }

    // The suite must never depend on a third-party API. useCurrencyRate calls
    // this only when the expense currency differs from the group currency.
    await page.route('https://api.frankfurter.dev/**', (route) => {
      if (exchangeRate === null) return route.abort()

      // Request shape: /v1/<YYYY-MM-DD>?base=<CODE>. The hook turns the
      // response into a RangeError unless `date` echoes the requested date
      // exactly, so mirror it back rather than inventing one.
      const url = new URL(route.request().url())
      const date = url.pathname.split('/').pop() ?? ''
      const base = url.searchParams.get('base') ?? ''

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          base,
          date,
          rates: { USD: exchangeRate, EUR: exchangeRate, GBP: exchangeRate },
        }),
      })
    })

    // Currency and category pickers render flag images from a CDN. Nothing is
    // asserted on them and they only add latency, so keep the run hermetic.
    await page.route('https://flagcdn.com/**', (route) => route.abort())

    await runTest(page)
  },
})

export { expect }
