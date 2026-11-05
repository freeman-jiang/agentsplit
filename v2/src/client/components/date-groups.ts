// The expense list's date headings, ported from the current app's
// src/lib/date-groups.ts. Dates are calendar days (YYYY-MM-DD), compared as
// days, so the stored day is used in every time zone (P-EXP-17).

export const DATE_GROUPS = [
  ['upcoming', 'Upcoming'],
  ['thisWeek', 'This week'],
  ['earlierThisMonth', 'Earlier this month'],
  ['lastMonth', 'Last month'],
  ['earlierThisYear', 'Earlier this year'],
  ['lastYear', 'Last year'],
  ['older', 'Older'],
] as const
export type DateGroup = (typeof DATE_GROUPS)[number][0]

/** The locale's first day of the week (0 = Sunday), with Monday as the fallback (P-EXP-15). */
export function weekStartsOn(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    if (firstDay) return firstDay % 7
  } catch {
    // An unsupported locale or no week data: use the fallback.
  }
  return 1
}

const parts = (date: string) => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  return { y, m, d, day: Date.UTC(y, m - 1, d) / 86_400_000 }
}

export function dateGroup(data: { date: string; today: string; weekStartsOn: number }): DateGroup {
  const date = parts(data.date)
  const today = parts(data.today)
  if (date.day > today.day) return 'upcoming'
  // Day 0 of the epoch was a Thursday (weekday 4).
  const weekStart = (day: number) => day - ((((day + 4) % 7) - data.weekStartsOn + 7) % 7)
  // The week check runs before the month check (P-EXP-16).
  if (weekStart(date.day) === weekStart(today.day)) return 'thisWeek'
  if (date.y === today.y && date.m === today.m) return 'earlierThisMonth'
  const lastMonth = today.m === 1 ? { y: today.y - 1, m: 12 } : { y: today.y, m: today.m - 1 }
  if (date.y === lastMonth.y && date.m === lastMonth.m) return 'lastMonth'
  if (date.y === today.y) return 'earlierThisYear'
  if (date.y === today.y - 1) return 'lastYear'
  return 'older'
}

/** Expenses under their headings, in heading order; empty headings are left out (P-EXP-13). */
export function groupByDate<T extends { expenseDate: string }>(data: { expenses: readonly T[]; today: string; weekStartsOn: number }) {
  const buckets = new Map<DateGroup, T[]>()
  for (const expense of data.expenses) {
    const group = dateGroup({ date: expense.expenseDate, today: data.today, weekStartsOn: data.weekStartsOn })
    buckets.set(group, [...(buckets.get(group) ?? []), expense])
  }
  return DATE_GROUPS.flatMap(([key, label]) => {
    const expenses = buckets.get(key)
    return expenses ? [{ key, label, expenses }] : []
  })
}
