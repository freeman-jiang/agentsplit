// Search-param parsing for route options. Route options stay in the main chunk,
// so they must not pull in a schema library (BUILDING.md, client bundle budget).
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'

/** Reads one search param; undefined drops it. */
type Param<T> = (value: unknown) => T | undefined

/**
 * A route's `validateSearch`: each key read by its parser. A rejected key is set
 * to undefined, not left out: the router spreads this result over the raw
 * search, so a key left out keeps its raw value (`?q=166` reached the server as
 * the number 166). The router drops undefined keys from the URL.
 */
export function searchParams<const S extends Record<string, Param<unknown>>>(spec: S) {
  return (raw: Record<string, unknown>): { [K in keyof S]?: NonNullable<ReturnType<S[K]>> } => {
    const out: Record<string, unknown> = {}
    for (const [key, parse] of Object.entries(spec)) out[key] = parse(raw[key])
    return out as { [K in keyof S]?: NonNullable<ReturnType<S[K]>> }
  }
}

/**
 * A param that is text to the app. The router parses `?amount=30` as the number
 * 30 and writes a string that looks like a number in quotes, so the value keeps
 * the router's type; read it with `text()`.
 */
export const textParam: Param<string | number> = (value) => (typeof value === 'string' || typeof value === 'number' ? value : undefined)

export const text = (value: string | number | undefined) => (value === undefined ? undefined : String(value))

/** A param that only a string fills, such as a path. */
export const stringParam: Param<string> = (value) => (typeof value === 'string' ? value : undefined)

/** Free text. The router parses `?q=166` as a number, so a number is read back as text. */
export const nonEmptyParam: Param<string> = (value) => {
  const s = typeof value === 'number' ? String(value) : value
  return typeof s === 'string' && s ? s : undefined
}

export const numberParam: Param<number> = (value) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

export const positiveIntegerParam: Param<number> = (value) => {
  const n = numberParam(value)
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined
}

export const currencyParam: Param<CurrencyCode> = (value) =>
  typeof value === 'string' && isCurrencyCode(value) ? value : undefined

export const oneOf =
  <const T extends string>(values: readonly T[]): Param<T> =>
  (value) =>
    values.find((v) => v === value)

/** Filled by the suggested payments' "Record payment" links (P-BAL-49, P-BAL-71) and the repayment links (P-UNGROUP-72). */
export const paymentSearch = searchParams({ from: textParam, to: textParam, amount: textParam, currencyCode: currencyParam })

export function paymentPrefill(search: ReturnType<typeof paymentSearch>) {
  return {
    ...(search.from === undefined ? {} : { from: String(search.from) }),
    ...(search.to === undefined ? {} : { to: String(search.to) }),
    ...(search.amount === undefined ? {} : { amount: String(search.amount) }),
    ...(search.currencyCode === undefined ? {} : { currencyCode: search.currencyCode }),
  }
}
