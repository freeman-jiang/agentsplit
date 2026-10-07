import { addExpense, createGroup, openTab, uniqueSuffix } from './app'
import { expect, test } from './fixtures'
import { cardByTitle, money } from './ui'

const PARTICIPANTS = ['Alice', 'Bob', 'Carol']

test('shows group totals, and personal totals for the signed-in member', async ({
  page,
}) => {
  const groupId = await createGroup(page, {
    name: `E2E Stats ${uniqueSuffix()}`,
    participants: PARTICIPANTS,
  })

  await addExpense(page, groupId, {
    title: 'Dinner',
    amount: '90',
    paidBy: 'Alice',
  })
  await addExpense(page, groupId, {
    title: 'Taxi',
    amount: '30',
    paidBy: 'Bob',
  })

  await openTab(page, 'Stats')
  const totals = cardByTitle(page, 'Totals')

  await expect(totals).toContainText('Total group spendings')
  await expect(totals).toContainText(money(120))

  await openTab(page, 'Stats')
  const personalised = cardByTitle(page, 'Totals')
  await expect(personalised).toContainText('Your total spendings')
  // Alice paid for Dinner only; her share of both expenses is 40.
  await expect(personalised).toContainText(money(90))
  await expect(personalised).toContainText('Your total share')
  await expect(personalised).toContainText(money(40))
})
