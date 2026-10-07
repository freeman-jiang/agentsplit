import {
  addExpense,
  createGroup,
  expectBalance,
  openTab,
  reimbursementRow,
  uniqueSuffix,
} from './app'
import { expect, test } from './fixtures'

test('settles a debt through the Record payment shortcut', async ({ page }) => {
  const id = await createGroup(page, {
    name: `Payment shortcut ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, { title: 'Hotel', amount: '100', paidBy: 'Alice' })
  await openTab(page, 'Balances')
  await reimbursementRow(page, 'Bob', 'Alice')
    .getByRole('link', { name: 'Record payment' })
    .click()
  await page.waitForURL(/\/payments\/create\?/)
  await expect(
    page.getByLabel('From', { exact: true }).locator('option:checked'),
  ).toHaveText('Bob')
  await expect(
    page.getByLabel('To', { exact: true }).locator('option:checked'),
  ).toHaveText('Alice')
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('50')
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click()
  await expect(page.getByTestId('payment-row')).toContainText('Bob → Alice')
  await openTab(page, 'Balances')
  await expectBalance(page, 'Alice', 0)
  await expectBalance(page, 'Bob', 0)
  await expect(page.getByText('No payments needed.')).toBeVisible()
})
