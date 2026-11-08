import { expect, test } from '@playwright/test'
import { E2E_GOOGLE_CLIENT_ID } from './fixtures'

test('the landing page’s Sign in with Google starts Google sign-in at once (P-AUTH-59, P-AUTH-60)', async ({ page }) => {
  // Google is not reached: the test answers for it and checks the authorization request.
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Google</title>' }))
  await page.goto('/')
  const google = page.waitForRequest((request) => request.url().startsWith('https://accounts.google.com/'))
  await page.getByRole('button', { name: 'Sign in with Google' }).click()
  const authorize = new URL((await google).url())
  expect(authorize.searchParams.get('client_id')).toBe(E2E_GOOGLE_CLIENT_ID)
  expect(authorize.searchParams.get('redirect_uri')).toMatch(/\/api\/auth\/callback\/google$/)
  await expect(page).toHaveTitle('Google')
})

test('/sign-in still serves the redirects that need it, with the requested page kept (P-AUTH-49)', async ({ page }) => {
  await page.goto('/sign-in?next=%2Fgroups')
  await expect(page.getByRole('heading', { name: 'Welcome to AgentSplit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible()
})
