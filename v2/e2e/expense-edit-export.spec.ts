import { expect, test } from '@playwright/test'
import { addExpense, draft, seedHousehold } from './fixtures'

test('an expense opens from the list without a page load and shows its log', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-lamp`, draft(h, { title: 'Floor lamp', amount: '45.00', date: '2026-11-02', vendor: 'IKEA' }))
  await page.goto(`/${h.slug}/expenses`)
  await page.evaluate(() => Object.assign(window, { __e2eMarker: true }))
  await page.getByText('Floor lamp').click()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/expenses/${h.groupId}-lamp/edit$`))
  // The same document: opening an expense is a client-side navigation.
  expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: boolean }).__e2eMarker)).toBe(true)
  await expect(page.getByTestId('expense-log')).toBeVisible()
})

test('the Expenses tab exports the group as CSV, for members only', async ({ page, context, baseURL, request }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-rent`, draft(h, { title: 'Rent', amount: '1200.00', date: '2026-11-01' }))
  await page.goto(`/${h.slug}/expenses`)
  const csv = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' })
    return { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
  }, `/${h.slug}/expenses/export/csv`)
  expect(csv.status).toBe(200)
  expect(csv.type).toContain('text/csv')
  expect(csv.body).toContain('Rent')
  // Without the member's session, the export is refused.
  const anonymous = await request.get(`/${h.slug}/expenses/export/csv`)
  expect(anonymous.status()).toBe(401)
})
