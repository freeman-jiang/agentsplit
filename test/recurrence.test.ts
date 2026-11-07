import { expect, it } from 'vitest'
import { nextDate } from '~/server/recurring'

it('keeps the anchor day of a monthly series after a short month (P-RECUR-07)', () => {
  const dates = ['2026-01-31']
  for (let i = 0; i < 4; i++) dates.push(nextDate({ from: dates.at(-1) ?? '', rule: 'monthly', anchorDay: 31 }))
  expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'])
  expect(nextDate({ from: '2028-01-30', rule: 'monthly', anchorDay: 30 })).toBe('2028-02-29')
  expect(nextDate({ from: '2026-12-15', rule: 'monthly', anchorDay: 15 })).toBe('2027-01-15')
})

it('adds one day or seven days across month and year ends', () => {
  expect(nextDate({ from: '2026-12-31', rule: 'daily', anchorDay: 31 })).toBe('2027-01-01')
  expect(nextDate({ from: '2026-02-25', rule: 'weekly', anchorDay: 25 })).toBe('2026-03-04')
})
