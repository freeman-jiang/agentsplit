import { expect, test } from '@playwright/test'
import { addExpense, draft, editExpense, seedHousehold } from './fixtures'

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

test('a refetch keeps an open draft, and its save after another change shows the conflict (P-EXP-53)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  const id = `${h.groupId}-desk`
  await addExpense(h, id, draft(h, { title: 'Desk', amount: '80.00', date: '2026-11-03' }))
  await page.goto(`/${h.slug}/expenses/${id}/edit`)
  await page.getByLabel('Description').fill('Standing desk')
  await editExpense(h, id, 1, draft(h, { title: 'Desk (changed elsewhere)', amount: '80.00', date: '2026-11-03' }))
  // The window gets focus again until the editor's data is read again; a suspense query stays fresh for one second.
  await expect
    .poll(async () => {
      const read = page.waitForResponse((r) => r.url().endsWith('/api/rpc') && (r.request().postData() ?? '').includes('expenses.detail'), { timeout: 500 })
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
      return read.then(
        () => true,
        () => false,
      )
    })
    .toBe(true)
  await expect(page.getByLabel('Description')).toHaveValue('Standing desk')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Someone changed this after you opened it.')).toBeVisible()
  await page.getByRole('button', { name: 'Load the latest version' }).click()
  await expect(page.getByLabel('Description')).toHaveValue('Desk (changed elsewhere)')
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
