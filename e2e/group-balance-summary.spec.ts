import {
  addExpense,
  createGroup,
  openExpense,
  openTab,
  uniqueSuffix,
} from './app'
import { expect, test } from './fixtures'
import { fillStable } from './ui'

test('expense sidebar shows net balances, refreshes after edits and keeps totals when searching', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `Balance panel ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, groupId, {
    title: 'House supplies',
    amount: '90',
    paidBy: 'Alice',
  })
  const panel = page.getByRole('complementary', { name: 'Group balances' })
  await expect(panel).toContainText('You are owed')
  await expect(
    panel.getByTestId('summary-personal-net').filter({ visible: true }),
  ).toHaveText('$60.00')
  await expect(
    panel
      .getByTestId('summary-participant')
      .filter({ hasText: 'Bob', visible: true }),
  ).toContainText('owes $30.00')
  await expect(
    panel
      .getByTestId('summary-payment')
      .filter({ hasText: 'Bob → You', visible: true }),
  ).toContainText('$30.00')
  await addExpense(page, groupId, {
    title: 'Kitchen supplies',
    amount: '30',
    paidBy: 'Bob',
  })
  await expect(
    panel.getByTestId('summary-personal-net').filter({ visible: true }),
  ).toHaveText('$50.00')
  await openExpense(page, 'House supplies')
  await expect(page.getByLabel('Vendor (optional)')).toHaveAttribute(
    'placeholder',
    'eg. Costco',
  )
  await fillStable(page.locator('input[name="amount"]'), '60')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(
    panel.getByTestId('summary-personal-net').filter({ visible: true }),
  ).toHaveText('$30.00')
  await expect(
    panel
      .getByTestId('summary-participant')
      .filter({ hasText: 'Bob', visible: true }),
  ).toContainText('Settled up')
  await page
    .getByRole('textbox', { name: 'Search expenses' })
    .fill('No matching expense')
  await expect(page.getByTestId('expense-card')).toHaveCount(0)
  await expect(
    panel.getByTestId('summary-personal-net').filter({ visible: true }),
  ).toHaveText('$30.00')
  await page.getByRole('textbox', { name: 'Search expenses' }).fill('')
  await expect(page.getByTestId('expense-card')).toHaveCount(2)
  await page.screenshot({
    path: '/tmp/agentsplit-balance-sidebar-desktop.png',
    fullPage: true,
  })

  await page.setViewportSize({ width: 390, height: 700 })
  await expect(
    panel.getByTestId('summary-personal-net').filter({ visible: true }),
  ).toHaveText('$30.00')
  const mobileDetails = panel.locator('details')
  await expect(mobileDetails).not.toHaveAttribute('open')
  await mobileDetails.locator('summary').click()
  await expect(
    panel
      .getByTestId('summary-participant')
      .filter({ hasText: 'Carol', visible: true }),
  ).toContainText('owes $30.00')
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
  await page.screenshot({
    path: '/tmp/agentsplit-balance-sidebar-mobile.png',
    fullPage: true,
  })
})

test('balance rail stays beside every group tab and expense editor', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `Shared rail ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, groupId, {
    title: 'Shared groceries',
    amount: '30',
    paidBy: 'Alice',
  })
  const panel = page.getByRole('complementary', { name: 'Group balances' })
  for (const name of [
    'Expenses',
    'Balances',
    'Information',
    'Stats',
    'Log',
    'Settings',
  ] as const) {
    await openTab(page, name)
    await expect(panel).toHaveCount(1)
    await expect(
      panel.getByTestId('summary-personal-net').filter({ visible: true }),
    ).toHaveText('$15.00')
    const rail = await panel.boundingBox()
    const content = await page.getByTestId('group-tab-content').boundingBox()
    expect(rail && content && rail.x >= content.x + content.width).toBeTruthy()
  }
  await page.screenshot({
    path: '/tmp/agentsplit-shared-rail-settings.png',
    fullPage: true,
  })
  await page.goto(`/groups/${groupId}/expenses/create`)
  await expect(page.getByLabel('Vendor (optional)')).toBeVisible()
  await expect(panel).toBeVisible()
  await page.setViewportSize({ width: 1024, height: 800 })
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 1024)
  await page.screenshot({
    path: '/tmp/agentsplit-shared-rail-editor.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 700 })
  for (const name of [
    'Balances',
    'Information',
    'Stats',
    'Log',
    'Settings',
  ] as const) {
    await openTab(page, name)
    await expect(panel).toBeVisible()
    await expect(
      panel.getByTestId('summary-personal-net').filter({ visible: true }),
    ).toHaveText('$15.00')
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
  }
})
