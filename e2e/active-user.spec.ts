import { addExpense, createGroup, expenseCard, uniqueSuffix } from './app'
import { expect, test } from './fixtures'
import { money } from './ui'

test.use({ viewport: { width: 488, height: 950 } })

test('fixed identity ignores localStorage impersonation and uses simple personal figures', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `Fixed identity ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob', 'Carol'],
  })
  await addExpense(page, groupId, {
    title: 'Dinner',
    amount: '20',
    paidBy: 'Alice',
  })
  await page.evaluate((id) => {
    localStorage.setItem(`${id}-activeUser`, 'Bob')
    localStorage.setItem('newGroup-activeUser', 'Bob')
    localStorage.setItem(`${id}-newUser`, 'Bob')
  }, groupId)
  await page.reload()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const row = expenseCard(page, 'Dinner')
  await expect(row.getByTestId('expense-paid')).toContainText('you paid')
  await expect(row.getByTestId('expense-paid')).toContainText(money(20))
  await expect(row.getByTestId('expense-personal')).toContainText('you lent')
  await expect(row.getByTestId('expense-personal')).toContainText(money(13.33))
  await expect(row).toContainText('Added by Alice')
  for (const width of [320, 488, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await expect(row.getByTestId('expense-personal')).toBeVisible()
    await page.screenshot({
      path: `/private/tmp/agentsplit-expense-identity-${width}.png`,
      fullPage: true,
    })
  }
})

test('defaults payer to the fixed member but allows recording another payer', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `Payer identity ${uniqueSuffix()}`,
    participants: ['Alice', 'Bob'],
  })
  await page.goto(`/groups/${groupId}/expenses/create`)
  await expect(page.getByTestId('paid-by')).toContainText('Alice')
  await addExpense(page, groupId, {
    title: 'Bob bought lunch',
    amount: '40',
    paidBy: 'Bob',
  })
  const row = expenseCard(page, 'Bob bought lunch')
  await expect(row).toContainText('Bob paid')
  await expect(row).toContainText('Added by Alice')
  await expect(row.getByTestId('expense-personal')).toContainText(
    'you borrowed',
  )
  await expect(row.getByTestId('expense-personal')).toContainText(money(20))
  await page.goto(`/groups/${groupId}/edit`)
  await expect(page.getByText('Active user', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('Participant: Alice', { exact: true }),
  ).toBeVisible()
})
