// Calendar dates without Effect, for the client and the server alike.

/** Today's calendar date in UTC, YYYY-MM-DD: the server's clock for recurrences, stats and file names. */
export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10)

/** A calendar date as the current app's timestamp: UTC midnight, as its MCP results and JSON export give dates. */
export const legacyDateTime = (date: string) => `${date}T00:00:00.000Z`

/** The form of a calendar date, YYYY-MM-DD. */
export const CALENDAR_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** Does the date text name a real day (2026-02-29 and 2026-09-31 do not)? It does not check the YYYY-MM-DD form. */
export const isRealDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** A real calendar date in the YYYY-MM-DD form. */
export const isCalendarDate = (value: string) => CALENDAR_DATE.test(value) && isRealDate(value)

/** A UTC time as the server writes it for a page cursor: YYYY-MM-DDTHH:MM:SS, up to microseconds, and Z. */
export const UTC_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?Z$/

/** A UTC time in that form on a real day. */
export const isUtcTime = (value: string) => UTC_TIME.test(value) && isRealDate(value.slice(0, 10))
