import { getCurrency } from '@/lib/currency'
import { decimalStrings, subtract } from '@/lib/money'
import { prisma } from '@/lib/prisma'
import { getExpenseShares } from '@/lib/shares'
import { dateOnlyToLocalDate, formatAmountAsDecimal } from '@/lib/utils'
import { Parser } from '@json2csv/plainjs'
import { create as contentDisposition } from 'content-disposition'
import { NextResponse } from 'next/server'

const splitModeLabel = {
  EVENLY: 'Evenly',
  BY_SHARES: 'Unevenly – By shares',
  BY_PERCENTAGE: 'Unevenly – By percentage',
  BY_AMOUNT: 'Unevenly – By amount',
}

/**
 * Prevents CSV formula/command injection (CWE-1236): a cell beginning with
 * =, +, -, @, tab or carriage return can be executed as a formula by spreadsheet
 * applications (Excel, LibreOffice, Sheets). Expense titles, category and
 * participant names are user-controlled, so prefix such text cells with a single
 * quote to neutralize them.
 */
function escapeCsvFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/**
 * `expenseDate` is a DATE column carried at UTC midnight, so it is converted
 * with `dateOnlyToLocalDate` first: reading it through local getters directly
 * would export the previous day on a server west of UTC.
 */
function formatDate(dateOnly: Date): string {
  const date = dateOnlyToLocalDate(dateOnly)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0') // Months are zero-based
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}` // YYYY-MM-DD format
}

export async function exportCSV(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      id: true,
      name: true,
      currency: true,
      currencyCode: true,
      expenses: {
        where: { deletedAt: null },
        select: {
          id: true,
          expenseDate: true,
          title: true,
          category: { select: { name: true } },
          amount: true,
          currencyCode: true,
          originalAmount: true,
          originalCurrency: true,
          conversionRate: true,
          paidById: true,
          paidFor: { select: { participantId: true, shares: true } },
          isReimbursement: true,
          splitMode: true,
        },
      },
      participants: { select: { id: true, name: true } },
    },
  })

  if (!group) {
    return NextResponse.json({ error: 'Invalid group ID' }, { status: 404 })
  }

  /*

  CSV Columns:
  - Date: The date of the expense.
  - Description: A brief description of the expense.
  - Category: The category of the expense (e.g., Food, Travel, etc.).
  - Currency: The currency in which the expense is recorded.
  - Cost: The amount spent.
  - Original cost: The amount spent in the original currency.
  - Original currency: The currency the amount was originally spent in.
  - Conversion rate: The rate used to convert the amount.
  - Is Reimbursement: Whether the expense is a reimbursement or not.
  - Split mode: The method used to split the expense (e.g., Evenly, By shares, By percentage, By amount).
  - UserA, UserB: User-specific data or balances (e.g., amount owed or contributed by each user).

  Example Table:
  +------------+------------------+----------+----------+----------+---------------+-------------------+-----------------+------------------+----------------------+--------+-----------+
  | Date       | Description      | Category | Currency | Cost     | Original cost | Original currency | Conversion rate | Is reinbursement | Split mode           | User A | User B    |
  +------------+------------------+----------+----------+----------+---------------+-------------------+-----------------+------------------+----------------------+--------+-----------+
  | 2025-01-06 | Dinner with team | Food     | INR      | 5000     |               |                   |                 | No               | Evenly               | 2500   | -2500     |
  +------------+------------------+----------+----------+----------+---------------+-------------------+-----------------+------------------+----------------------+--------+-----------+
  | 2025-02-07 | Plane tickets    | Travel   | INR      | 97264.09 | 1000          | EUR               | 97.2641         | No               | Unevenly - By amount | -80000 | -17264.09 |
  +------------+------------------+----------+----------+----------+---------------+-------------------+-----------------+------------------+----------------------+--------+-----------+

  */

  const fields = [
    { label: 'Date', value: 'date' },
    { label: 'Description', value: 'title' },
    { label: 'Category', value: 'categoryName' },
    { label: 'Currency', value: 'currency' },
    { label: 'Cost', value: 'amount' },
    { label: 'Original cost', value: 'originalAmount' },
    { label: 'Original currency', value: 'originalCurrency' },
    { label: 'Conversion rate', value: 'conversionRate' },
    { label: 'Is Reimbursement', value: 'isReimbursement' },
    { label: 'Split mode', value: 'splitMode' },
    ...group.participants.map((participant) => ({
      label: escapeCsvFormula(participant.name),
      value: participant.name,
    })),
  ]

  const expenses = decimalStrings(group.expenses).map((expense) => {
    const currency = getCurrency(expense.currencyCode)
    const shares = getExpenseShares(expense)

    return {
      date: formatDate(expense.expenseDate),
      title: escapeCsvFormula(expense.title),
      categoryName: escapeCsvFormula(expense.category?.name || ''),
      currency: expense.currencyCode,
      amount: formatAmountAsDecimal(expense.amount, currency),
      originalAmount: expense.originalAmount
        ? formatAmountAsDecimal(
            expense.originalAmount,
            getCurrency(expense.originalCurrency),
          )
        : null,
      originalCurrency: expense.originalCurrency,
      conversionRate: expense.conversionRate
        ? expense.conversionRate.toString()
        : null,
      isReimbursement: expense.isReimbursement ? 'Yes' : 'No',
      splitMode: splitModeLabel[expense.splitMode],
      ...Object.fromEntries(
        group.participants.map((participant) => {
          const isPaidByParticipant = expense.paidById === participant.id
          // Export the same net balance change as the balances tab: credit
          // the amount paid, then subtract this participant's apportioned share.
          // Work in whole minor units so every row's balances sum to zero.
          const participantBalance = subtract(
            isPaidByParticipant ? expense.amount : '0',
            shares.get(participant.id) ?? '0',
          )

          return [
            participant.name,
            formatAmountAsDecimal(participantBalance, currency),
          ]
        }),
      ),
    }
  })

  const json2csvParser = new Parser({ fields })
  const csv = json2csvParser.parse(expenses)

  const date = new Date().toISOString().split('T')[0]

  // Create an ASCII-safe version of the group name for the 'filename' parameter
  const asciiSafeGroupName = group.name.replace(/[^\x00-\x7F]/g, '_') // Replace non-ASCII with underscore
  const asciiFilename = `AgentSplit Export - ${asciiSafeGroupName} - ${date}.csv`

  // Use the original group name for the 'filename*' parameter (UTF-8 encoded)
  const fullFilename = `AgentSplit Export - ${group.name} - ${date}.csv`

  // \uFEFF character is added at the beginning of the CSV content to ensure that it is interpreted as UTF-8 with BOM (Byte Order Mark), which helps some applications correctly interpret the encoding.
  return new NextResponse(`\uFEFF${csv}`, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition(fullFilename, {
        type: 'attachment',
        fallback: asciiFilename,
      }),
    },
  })
}
