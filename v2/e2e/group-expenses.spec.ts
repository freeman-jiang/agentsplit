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
  // Titles name the page and the group, as in the current app (P-GROUP-48).
  await expect(page).toHaveTitle(/^Expenses · .+ · AgentSplit$/)
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
  await expect(page).toHaveTitle(/^Balances · .+ · AgentSplit$/)
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

test('a tab that fails to load shows the group error under the tabs, without the exception text (P-GROUP-53)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await page.goto(`/${h.slug}/expenses`)
  await expect(page.getByRole('navigation', { name: 'Group' })).toBeVisible()
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postData()?.includes('"stats.')) await route.fulfill({ status: 500, body: 'secret internal detail' })
    else await route.continue()
  })
  await page.getByRole('link', { name: 'Stats', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Couldn’t load this group' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Group' })).toBeVisible()
  await expect(page.getByText(/secret internal detail|answered 500/)).toHaveCount(0)
  // Retry loads again once the server answers.
  await page.unroute('**/api/rpc')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Couldn’t load this group' })).toHaveCount(0)
})

test('returning to a tab shows a change made elsewhere (P-EXP-20)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-first`, draft(h, { title: 'First lamp', amount: '10.00', date: '2026-11-01' }))
  await page.goto(`/${h.slug}/expenses`)
  await expect(page.getByTestId('expense-list')).toContainText('First lamp')
  // Another tab or person writes while this page is open.
  await addExpense(h, `${h.groupId}-second`, draft(h, { title: 'Second lamp', amount: '12.00', date: '2026-11-02' }))
  await page.getByRole('link', { name: 'Balances', exact: true }).click()
  // TanStack Query treats suspense data as fresh for its first second, so wait past it, as a person would.
  await page.waitForTimeout(1_100)
  await page.getByRole('link', { name: 'Expenses', exact: true }).click()
  await expect(page.getByTestId('expense-list')).toContainText('Second lamp')
})
