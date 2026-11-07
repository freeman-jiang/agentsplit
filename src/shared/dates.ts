// Calendar dates without Effect, for the client and the server alike.

/** Today's calendar date in UTC, YYYY-MM-DD: the server's clock for recurrences, stats and file names. */
export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10)

/** A calendar date as the current app's timestamp: UTC midnight, as its MCP results and JSON export give dates. */
export const legacyDateTime = (date: string) => `${date}T00:00:00.000Z`

/** Does the date text name a real day (2026-02-29 and 2026-09-31 do not)? It does not check the YYYY-MM-DD form. */
export const isRealDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
