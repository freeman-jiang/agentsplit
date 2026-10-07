import { addExpense, createGroup, openTab, uniqueSuffix } from './app'
import { seedAccount } from './auth'
import { expect, test } from './fixtures'
import { fillStable } from './ui'

test('optional vendor survives edits and custom URLs preserve navigation and access checks', async ({
  page,
  browser,
  baseURL,
}) => {
  const groupId = await createGroup(page, {
    name: `Slug house ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, groupId, {
    title: 'Hangers and sponges',
    amount: '30',
    paidBy: 'Alice',
  })
  await page
    .getByRole('link')
    .filter({ hasText: 'Hangers and sponges' })
    .click()
  await fillStable(page.getByLabel('Vendor (optional)'), 'Costco')
  await page.screenshot({
    path: '/tmp/agentsplit-vendor-form.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(
    page.getByText('Costco — Hangers and sponges', { exact: true }),
  ).toBeVisible()

  const slug = `house-${uniqueSuffix()}`
  await openTab(page, 'Settings')
  await fillStable(page.getByLabel('Custom URL (optional)'), slug)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/edit$`))
  await page.goto(`/${slug}`)
  await expect(page).toHaveURL(new RegExp(`/${slug}$`))
  await expect(
    page.getByText('Costco — Hangers and sponges', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('tab', { name: 'Expenses', exact: true }),
  ).toHaveAttribute('data-state', 'active')
  await page.screenshot({
    path: '/tmp/agentsplit-slug-expenses.png',
    fullPage: true,
  })
  await page.getByRole('tab', { name: 'Balances', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/balances$`))
  await page.goto(`/groups/${groupId}/expenses?filter=Costco`)
  await expect(page).toHaveURL(new RegExp(`/${slug}/expenses\\?filter=Costco$`))
  const exported = await page.request.get(`/${slug}/expenses/export/json`)
  expect(exported.status()).toBe(200)
  const body = await exported.json()
  expect(body.slug).toBe(slug)
  expect(body.expenses[0]).toMatchObject({
    title: 'Hangers and sponges',
    vendor: 'Costco',
    amount: '30',
  })

  const stranger = await browser.newContext()
  const strangerPage = await stranger.newPage()
  await strangerPage.goto(`${baseURL}/${slug}`)
  await expect(strangerPage).toHaveURL(/\/sign-in$/)
  await seedAccount(stranger, baseURL!)
  await strangerPage.goto(`${baseURL}/${slug}`)
  await expect(strangerPage).toHaveURL(/\/groups\?access=denied$/)
  expect(
    (
      await stranger.request.get(`${baseURL}/${slug}/expenses/export/json`)
    ).status(),
  ).toBe(403)
  await stranger.close()

  await page
    .getByRole('link')
    .filter({ hasText: 'Costco — Hangers and sponges' })
    .click()
  await expect(page.getByLabel('Vendor (optional)')).toHaveValue('Costco')
  await fillStable(page.getByLabel('Vendor (optional)'), '')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(
    page.getByText('Hangers and sponges', { exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Activity', exact: true }).click()
  await expect(
    page.getByText(/Costco — Hangers and sponges/).first(),
  ).toBeVisible()

  await page.getByRole('tab', { name: 'Settings', exact: true }).click()
  await fillStable(page.getByLabel('Custom URL (optional)'), `${slug}-new`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${slug}-new/edit$`))
  await fillStable(page.getByLabel('Custom URL (optional)'), '')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/groups/${groupId}/edit$`))
  await page.goto(`/groups/${groupId}/expenses`)
  await expect(
    page.getByText('Hangers and sponges', { exact: true }),
  ).toBeVisible()
})

test('group creation accepts a slug and settings show duplicate and reserved URL errors', async ({
  page,
}) => {
  const slug = `new-house-${uniqueSuffix()}`
  await page.goto('/groups/create')
  await fillStable(page.locator('input[name="name"]'), 'Custom URL house')
  await fillStable(page.getByLabel('Custom URL (optional)'), slug)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/${slug}$`))
  await createGroup(page, {
    name: 'Other house',
    participants: ['Alice', 'Bob'],
  })
  await openTab(page, 'Settings')
  await fillStable(page.getByLabel('Custom URL (optional)'), slug)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'already in use' }),
  ).toHaveCount(1)
  await fillStable(page.getByLabel('Custom URL (optional)'), 'api')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByText('This URL is reserved.', { exact: true }),
  ).toBeVisible()
})
