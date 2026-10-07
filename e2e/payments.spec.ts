import { addExpense, createGroup, expectBalance, uniqueSuffix } from './app'
import { expect, test } from './fixtures'

test('records a partial payment by another person, edits it, and deletes it', async ({
  page,
}, testInfo) => {
  const id = await createGroup(page, {
    name: `Payments ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, { title: 'Dinner', amount: '60', paidBy: 'Alice' })
  await page.getByRole('tab', { name: 'Payments', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Payments', exact: true }),
  ).toBeVisible()
  await page
    .getByRole('link', { name: 'Record payment', exact: true })
    .last()
    .click()
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('30')
  await expect(page.getByLabel('From', { exact: true })).toContainText('Bob')
  await page.getByLabel('Amount', { exact: true }).fill('12.34')
  await page.getByLabel('Note (optional)').fill('Bank transfer')
  await page.screenshot({
    path: testInfo.outputPath('payment-form.png'),
    fullPage: true,
  })
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click()
  await expect(page.getByTestId('payment-row')).toContainText('Bob → Alice')
  await expect(page.getByTestId('payment-row')).toContainText('12.34')
  await expect(page.getByTestId('payment-row')).toContainText('Added')
  await expect(page.getByTestId('payment-row')).toContainText('by Alice')
  await page.getByTestId('payment-row').getByRole('link').click()
  await page.getByLabel('Amount', { exact: true }).fill('20')
  await page.getByRole('button', { name: 'Save payment', exact: true }).click()
  await expect(page.getByTestId('payment-row')).toContainText('20.00')
  await expect(page.getByTestId('payment-row')).toContainText('Your last edit')
  await page.screenshot({
    path: testInfo.outputPath('payment-history.png'),
    fullPage: true,
  })
  await page.getByRole('tab', { name: 'Balances', exact: true }).click()
  await expectBalance(page, 'Alice', 10)
  await expectBalance(page, 'Bob', -10)
  await page.getByRole('tab', { name: 'Payments', exact: true }).click()
  await page.getByTestId('payment-row').getByRole('link').click()
  page.once('dialog', (dialog) => dialog.accept())
  await page
    .getByRole('button', { name: 'Delete payment', exact: true })
    .click()
  await expect(page.getByText('No payments recorded yet.')).toBeVisible()
  await page.getByRole('tab', { name: 'Balances', exact: true }).click()
  await expectBalance(page, 'Alice', 30)
})

test('any pair and currency work without conversion; same-person and excess precision are rejected', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `Currency payments ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, id, { title: 'Hotel', amount: '90', paidBy: 'Alice' })
  await page.goto(`/groups/${id}/payments/create`)
  await page.getByLabel('From', { exact: true }).selectOption({ label: 'Bob' })
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Bob' })
  await page.getByLabel('Amount', { exact: true }).fill('10.01')
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click()
  await expect(page.locator('form').getByRole('alert')).toHaveText(
    'Sender and recipient must be different people.',
  )
  await page.getByLabel('To', { exact: true }).selectOption({ label: 'Carol' })
  await page.getByLabel('Currency', { exact: true }).selectOption('JPY')
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click()
  await expect(page.locator('form').getByRole('alert')).toContainText(
    'JPY amounts allow at most 0 decimal places',
  )
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('frankfurter')) requests.push(r.url())
  })
  await page.getByLabel('Currency', { exact: true }).selectOption('CAD')
  await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('10.01')
  await page
    .getByRole('button', { name: 'Record payment', exact: true })
    .click()
  await expect(page.getByTestId('payment-row')).toContainText('Bob → Carol')
  await expect(page.getByTestId('payment-row')).toContainText('10.01 CAD')
  expect(requests).toEqual([])
  await page.getByRole('tab', { name: 'Balances', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'USD', exact: true }).first(),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'CAD', exact: true }).first(),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Payments', exact: true }).click()
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  }
})

test('expense attribution shows actual audit dates on list and editor', async ({
  page,
}) => {
  const id = await createGroup(page, {
    name: `Expense dates ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await addExpense(page, id, {
    title: 'Shared towels',
    amount: '20',
    paidBy: 'Bob',
  })
  const card = page
    .getByTestId('expense-card')
    .filter({ hasText: 'Shared towels' })
  await expect(card.getByTestId('expense-metadata')).toContainText('by Alice')
  await expect(card.locator('time[datetime]').last()).toHaveAttribute(
    'datetime',
    /T/,
  )
  await card.click()
  await expect(page.getByTestId('expense-metadata')).toContainText('Added')
  await page.locator('input[name="title"]').fill('Shared towels updated')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByTestId('expense-metadata')).toContainText(
    'Last edited',
  )
  await expect(page.getByTestId('expense-metadata')).toContainText(
    'Your last edit',
  )
})
