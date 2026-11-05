import { expect, test } from '@playwright/test'
import { addExpense, draft, editExpense, seedHousehold } from './fixtures'

test('a group opens on its expenses, sorts by date or by last change, and keeps the rail', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-old`, draft(h, { title: 'Old groceries', amount: '30.00', date: '2026-10-01', vendor: 'Costco' }))
  await addExpense(h, `${h.groupId}-new`, draft(h, { title: 'New lamp', amount: '10.00', date: '2026-11-01', payer: 1 }))
  // Editing the older expense makes it the most recently changed one.
  await editExpense(h, `${h.groupId}-old`, 1, draft(h, { title: 'Old groceries (edited)', amount: '31.00', date: '2026-10-01', vendor: 'Costco' }))

  // The group root redirects to the Expenses tab, as in the current app.
  await page.goto(`/${h.slug}`)
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/expenses$`))
  const rows = page.getByTestId('expense-list').getByRole('listitem')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('New lamp')
  // The vendor is shown on its own line above the title.
  await expect(rows.nth(1)).toContainText('Costco')

  await page.getByRole('radio', { name: 'Recently changed' }).click()
  await expect(page).toHaveURL(/sort=updated/)
  await expect(rows.nth(0)).toContainText('Old groceries (edited)')

  // The rail covers the whole group: 31.00 + 10.00 split three ways, nets sum to zero.
  const rail = page.getByRole('complementary', { name: 'Balances' })
  await expect(rail).toContainText('Alice Example')
  const nets = await rail.locator('li span.tabular-nums').allInnerTexts()
  const cents = nets.map((n) => Math.round(Number(n.replace(/[$,]/g, '')) * 100))
  expect(cents.reduce((a, b) => a + b, 0)).toBe(0)

  // Switching tabs is a client-side navigation: the document is not loaded again.
  await page.evaluate(() => Object.assign(window, { __e2eMarker: true }))
  await page.getByRole('link', { name: 'Balances', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/balances$`))
  expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: boolean }).__e2eMarker)).toBe(true)
})

test('a signed-out visitor is sent to sign-in', async ({ page }) => {
  await page.goto('/groups')
  await expect(page).toHaveURL(/\/sign-in/)
})

test('a signed-out visitor returns to the page they asked for after sign-in (P-AUTH-49)', async ({ page }) => {
  await page.goto('/groups')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fgroups/)
  await page.goto('/home-xyz/expenses?sort=updated')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fhome-xyz%2Fexpenses%3Fsort%3Dupdated/)
})
