import { expect, test } from '@playwright/test'
import { addExpense, draft, editExpense, seedHousehold, seedUnsluggedGroup } from './fixtures'

test('a group opens on its expenses, sorts by date or by last change, and keeps the rail', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-old`, draft(h, { title: 'Old groceries', amount: '30.00', date: '2026-10-01', vendor: 'Costco' }))
  await addExpense(h, `${h.groupId}-new`, draft(h, { title: 'New lamp', amount: '10.00', date: '2026-11-01', payer: 1 }))
  // Editing the older expense makes it the most recently changed one.
  await editExpense(h, `${h.groupId}-old`, 1, draft(h, { title: 'Old groceries (edited)', amount: '31.00', date: '2026-10-01', vendor: 'Costco' }))

  // The group's slug shows its expenses and stays in the address bar, as in v1 (P-GROUP-98).
  await page.goto(`/${h.slug}`)
  await expect(page.getByTestId('expense-list')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}$`))
  await expect(page.getByRole('link', { name: 'Expenses', exact: true })).toHaveAttribute('aria-current', 'page')
  // Titles name the page and the group, as in v1 (P-GROUP-48).
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
  const rail = page.getByRole('complementary', { name: 'Group balances' })
  await expect(rail).toContainText('Alice Example')
  const people = rail.getByTestId('summary-participant').filter({ visible: true })
  await expect(people).toHaveCount(3)
  const nets = await people.getByTestId('summary-net').allInnerTexts()
  const cents = nets.map((n) => (n.startsWith('owes') ? -1 : 1) * Math.round(Number(n.replace(/[^\d.]/g, '') || '0') * 100))
  expect(cents.reduce((a, b) => a + b, 0)).toBe(0)

  // Switching tabs is a client-side navigation: the document is not loaded again.
  await page.evaluate(() => Object.assign(window, { __e2eMarker: true }))
  await page.getByRole('link', { name: 'Balances', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/balances$`))
  await expect(page).toHaveTitle(/^Balances · .+ · AgentSplit$/)
  expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: boolean }).__e2eMarker)).toBe(true)
})

test('the rail tells the viewer what they owe, and refreshes to "Settled up" (P-BAL-53..56, P-BAL-58, P-BAL-62, P-BAL-63)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  const bob = h.people[1]
  await page.goto(`/${h.slug}/expenses`)
  const rail = page.getByRole('complementary', { name: 'Group balances' })
  await expect(rail).toContainText('No outstanding balances.')

  // Bob pays 30.00 for all three: Alice, the viewer, owes 10.00.
  await addExpense(h, `${h.groupId}-bob`, draft(h, { title: 'Groceries', amount: '30.00', date: '2026-11-01', payer: 1 }))
  await rail.getByRole('button', { name: 'Refresh balances' }).click()
  await expect(rail).toContainText('You owe · USD')
  await expect(rail.getByTestId('summary-personal-net').filter({ visible: true })).toHaveText('$10.00')
  const person = (name: string) => rail.getByTestId('summary-participant').filter({ hasText: name, visible: true })
  await expect(person('Alice Example')).toContainText('Alice Example (you)')
  await expect(person('Bob Example')).toContainText('gets back $20.00')
  await expect(person('Cara Example')).toContainText('owes $10.00')
  const payments = rail.getByTestId('summary-payment').filter({ visible: true })
  await expect(payments.filter({ hasText: 'You → Bob Example' })).toContainText('$10.00')
  await expect(payments.filter({ hasText: 'Cara Example → Bob Example' })).toContainText('$10.00')

  // Alice pays 10.00 for Bob alone, so she is settled up; Cara still owes Bob.
  await addExpense(h, `${h.groupId}-alice`, { ...draft(h, { title: 'Lamp', amount: '10.00', date: '2026-11-02' }), shares: [{ participantId: bob?.id ?? '', weight: '1' }] })
  await rail.getByRole('button', { name: 'Refresh balances' }).click()
  await expect(rail).toContainText('Settled up · USD')
  await expect(person('Alice Example')).toContainText('Settled up')
  await expect(payments).toHaveCount(1)
  await expect(payments).toContainText('Cara Example → Bob Example')

  // A failed load stays in the rail, without the exception text.
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postData()?.includes('"balances.list"')) await route.fulfill({ status: 500, body: 'secret internal detail' })
    else await route.continue()
  })
  await rail.getByRole('button', { name: 'Refresh balances' }).click()
  await expect(rail.getByRole('alert')).toHaveText('Could not load balances. Try refreshing.')
  await expect(page.getByRole('heading', { name: 'Expenses' })).toBeVisible()
  await page.unroute('**/api/rpc')

  // The rail ends with a link to the Balances tab.
  await rail.getByRole('link', { name: 'Balance details' }).click()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/balances$`))
})

test('a signed-out visitor returns to the page they asked for after sign-in (P-AUTH-49)', async ({ page }) => {
  await page.goto('/groups')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fgroups/)
  await page.goto('/home-xyz/expenses?sort=updated')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fhome-xyz%2Fexpenses%3Fsort%3Dupdated/)
  // The page is kept as the address bar showed it.
  await page.goto('/home-xyz')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fhome-xyz$/)
  await page.goto('/groups/AbCdEfGhIjKlMnOpQrS_1/balances')
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fgroups%2FAbCdEfGhIjKlMnOpQrS_1%2Fbalances$/)
})

test('group URLs are v1’s: /groups/<id>/… without a slug, /<slug>/… with one (P-GROUP-98, P-GROUP-100, P-PWA-21, P-PWA-23)', async ({ page, context, baseURL, request }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  const tripId = await seedUnsluggedGroup(h)
  // A group without a slug opens on its expenses at /groups/<id>/expenses.
  await page.goto(`/groups/${tripId}`)
  await expect(page).toHaveURL(new RegExp(`/groups/${tripId}/expenses$`))
  await expect(page.getByRole('heading', { name: `Trip ${tripId}` })).toBeVisible()
  // Tabs and the group's name link under /groups/<id>, without a page load.
  await page.evaluate(() => Object.assign(window, { __e2eMarker: true }))
  await page.getByRole('link', { name: 'Balances', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/groups/${tripId}/balances$`))
  await expect(page.getByRole('link', { name: 'Stats', exact: true })).toHaveAttribute('href', `/groups/${tripId}/stats`)
  await expect(page.getByRole('link', { name: `Trip ${tripId}` })).toHaveAttribute('href', `/groups/${tripId}`)
  expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: boolean }).__e2eMarker)).toBe(true)
  // The groups page links each group at its URL.
  await page.goto('/groups')
  await expect(page.locator(`a[href="/groups/${tripId}"]`).first()).toBeVisible()
  await expect(page.locator(`a[href="/${h.slug}"]`).first()).toBeVisible()
  await page.locator(`a[href="/${h.slug}"]`).first().click()
  await expect(page).toHaveURL(new RegExp(`/${h.slug}$`))
  await expect(page.getByRole('link', { name: 'Expenses', exact: true })).toHaveAttribute('aria-current', 'page')
  // v2's first URL for a group without a slug moves to v1's URL with a 307.
  const moved = await request.get(`/${tripId}/stats?x=1`, { maxRedirects: 0 })
  expect(moved.status()).toBe(307)
  expect(moved.headers()['location']).toBe(`/groups/${tripId}/stats?x=1`)
  expect(moved.headers()['cache-control']).toBe('private, no-store')
  await page.goto(`/${tripId}/stats`)
  await expect(page).toHaveURL(new RegExp(`/groups/${tripId}/stats$`))
  // Letter case and the ID path of a group with a slug move to the slug.
  await page.goto(`/${h.slug.toUpperCase()}/balances`)
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/balances$`))
  await page.goto(`/groups/${h.groupId}/information`)
  await expect(page).toHaveURL(new RegExp(`/${h.slug}/information$`))
  // The export links of the Expenses tab use the same URLs.
  await page.goto(`/groups/${tripId}/expenses`)
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('menuitem', { name: 'Export to CSV' })).toHaveAttribute('href', `/groups/${tripId}/expenses/export/csv`)
})

test('a tab that fails to load shows the group error under the tabs, with a reference and without the exception text (P-GROUP-53, P-PWA-36)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await page.goto(`/${h.slug}/expenses`)
  await expect(page.getByRole('navigation', { name: 'Group' })).toBeVisible()
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postData()?.includes('"stats.')) await route.fulfill({ status: 500, body: 'secret internal detail' })
    else await route.continue()
  })
  const logged: string[] = []
  page.on('console', (message) => void (message.type() === 'error' && logged.push(message.text())))
  await page.getByRole('link', { name: 'Stats', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Couldn’t load this group' })).toBeVisible()
  // A short reference to quote, which the console line with the error repeats (P-PWA-36).
  const reference = (await page.getByTestId('error-reference').innerText()).replace('Reference: ', '')
  expect(reference).toMatch(/^[0-9a-f]{8}$/)
  expect(logged.some((line) => line.includes(`Error reference ${reference}`))).toBe(true)
  await expect(page.getByRole('navigation', { name: 'Group' })).toBeVisible()
  await expect(page.getByText(/secret internal detail|answered 500/)).toHaveCount(0)
  // Retry loads again once the server answers.
  await page.unroute('**/api/rpc')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Couldn’t load this group' })).toHaveCount(0)
})

test('a failure the server answered shows the server’s request ID as the reference (P-PWA-36)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/rpc') && (response.request().postData() ?? '').includes('"expenses.detail"'))
  await page.goto(`/${h.slug}/expenses/${h.groupId}-missing/edit`)
  await expect(page.getByRole('heading', { name: 'Couldn’t load this group' })).toBeVisible()
  const requestId = (await answered).headers()['x-request-id'] ?? ''
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  await expect(page.getByTestId('error-reference')).toHaveText(`Reference: ${requestId}`)
})

test('returning to a tab shows a change made elsewhere (P-EXP-20)', async ({ page, context, baseURL }) => {
  const h = await seedHousehold(context, baseURL ?? '')
  await addExpense(h, `${h.groupId}-first`, draft(h, { title: 'First lamp', amount: '10.00', date: '2026-11-01' }))
  // The page's clock: TanStack Query keeps suspense data fresh for its first second, and a person comes back later than that.
  await page.clock.install()
  await page.goto(`/${h.slug}/expenses`)
  await expect(page.getByTestId('expense-list')).toContainText('First lamp')
  // Another tab or person writes while this page is open.
  await addExpense(h, `${h.groupId}-second`, draft(h, { title: 'Second lamp', amount: '12.00', date: '2026-11-02' }))
  await page.getByRole('link', { name: 'Balances', exact: true }).click()
  await page.clock.fastForward(1_100)
  await page.getByRole('link', { name: 'Expenses', exact: true }).click()
  await expect(page.getByTestId('expense-list')).toContainText('Second lamp')
})
