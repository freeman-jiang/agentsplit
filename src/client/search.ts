// Search-param parsing for route options. Route options stay in the main chunk,
// so they must not pull in a schema library (BUILDING.md, client bundle budget).
import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'

/** Reads one search param; undefined drops it. */
type Param<T> = (value: unknown) => T | undefined

/**
 * A route's `validateSearch`: each key read by its parser, and keys without a
 * value left out, so exact optional types hold.
 */
export function searchParams<const S extends Record<string, Param<unknown>>>(spec: S) {
  return (raw: Record<string, unknown>): { [K in keyof S]?: NonNullable<ReturnType<S[K]>> } => {
    const out: Record<string, unknown> = {}
    for (const [key, parse] of Object.entries(spec)) {
      const value = parse(raw[key])
      if (value !== undefined) out[key] = value
    }
    return out as { [K in keyof S]?: NonNullable<ReturnType<S[K]>> }
  }
}

/**
 * A param that is text to the app. The router parses `?amount=30` as the number
 * 30 and writes a string that looks like a number in quotes, so the value keeps
 * the router's type; read it with `text()`.
 */
export const textParam: Param<string | number> = (value) => (typeof value === 'string' || typeof value === 'number' ? value : undefined)

/** A text param as text. */
export const text = (value: string | number | undefined) => (value === undefined ? undefined : String(value))

/** A param that only a string fills, such as a path. */
export const stringParam: Param<string> = (value) => (typeof value === 'string' ? value : undefined)

/** A non-empty string. */
export const nonEmptyParam: Param<string> = (value) => (typeof value === 'string' && value ? value : undefined)

/** A number, from a number or numeric text. */
export const numberParam: Param<number> = (value) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** A positive whole number. */
export const positiveIntegerParam: Param<number> = (value) => {
  const n = numberParam(value)
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined
}

/** A currency code from the registry. */
export const currencyParam: Param<CurrencyCode> = (value) =>
  typeof value === 'string' && Object.hasOwn(CURRENCIES, value) ? (value as CurrencyCode) : undefined

/** One of the given strings. */
export const oneOf =
  <const T extends string>(values: readonly T[]): Param<T> =>
  (value) =>
    values.find((v) => v === value)

/** Filled by the suggested payments' "Record payment" links (P-BAL-49, P-BAL-71) and the repayment links (P-UNGROUP-72). */
export const paymentSearch = searchParams({ from: textParam, to: textParam, amount: textParam, currencyCode: currencyParam })

/** The payment form's prefill from those params. */
export function paymentPrefill(search: ReturnType<typeof paymentSearch>) {
  return {
    ...(search.from === undefined ? {} : { from: String(search.from) }),
    ...(search.to === undefined ? {} : { to: String(search.to) }),
    ...(search.amount === undefined ? {} : { amount: String(search.amount) }),
    ...(search.currencyCode === undefined ? {} : { currencyCode: search.currencyCode }),
  }
}
