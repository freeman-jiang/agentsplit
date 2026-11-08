// Dates in the client: the viewer's "today", the app's formatters and the
// first day of the week. The app formats in English (en-US), as the current
// app does. Route loaders in the main chunk import this module, so it stays small.

/** The calendar date of `when` where the viewer is; today by default (P-BAL-73, the stats periods). */
export function localDate(when = new Date()) {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
}

const LOCALE = 'en-US'
/** A calendar date is the same day everywhere, so it formats in UTC (P-EXP-17). */
const calendar = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: 'UTC' })
const calendarDay = (date: string) => new Date(`${date}T00:00:00Z`)

const dayFormat = calendar({ dateStyle: 'medium' })
/** "Nov 7, 2026" for a calendar date, YYYY-MM-DD. */
export const formatDay = (date: string) => dayFormat.format(calendarDay(date))

const MONTH_FORMATS = {
  short: calendar({ month: 'short' }),
  shortYear: calendar({ month: 'short', year: 'numeric' }),
  long: calendar({ month: 'long', year: 'numeric' }),
}
/** "Nov", "Nov 2026" or "November 2026" for a month, YYYY-MM or YYYY-MM-DD. */
export const formatMonth = (month: string, style: keyof typeof MONTH_FORMATS = 'shortYear') => MONTH_FORMATS[style].format(calendarDay(`${month.slice(0, 7)}-01`))

/** The parts of a calendar date's tile: "NOV", 7, 2026. */
export function dayParts(date: string) {
  const day = calendarDay(date)
  return { month: MONTH_FORMATS.short.format(day), day: day.getUTCDate(), year: day.getUTCFullYear() }
}

const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' })
const numericDateFormat = new Intl.DateTimeFormat(LOCALE)
const timeFormat = new Intl.DateTimeFormat(LOCALE, { timeStyle: 'short' })
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' })
const fullFormat = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })

/** A moment (ISO 8601) in the viewer's time zone. */
export const formatMoment = {
  /** "Nov 7, 2026" */
  date: (iso: string) => dateFormat.format(new Date(iso)),
  /** "11/7/2026" */
  numericDate: (iso: string) => numericDateFormat.format(new Date(iso)),
  /** "3:04 PM" */
  time: (iso: string) => timeFormat.format(new Date(iso)),
  /** "Nov 7, 2026, 3:04 PM" */
  dateTime: (iso: string) => dateTimeFormat.format(new Date(iso)),
  /** "11/7/2026, 3:04:05 PM" */
  full: (iso: string) => fullFormat.format(new Date(iso)),
}

/** The first day of the week (0 = Sunday): the app's en-US week, as in the current app (P-EXP-15, P-HIST-66). */
export const WEEK_STARTS_ON = 0
