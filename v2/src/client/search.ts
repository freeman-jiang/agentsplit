import { CURRENCIES, type CurrencyCode } from '~/shared/currencies'
// Search-param parsing for route options. Route options stay in the main chunk,
// so they must not pull in a schema library (BUILDING.md, client bundle budget).

/** Keeps the given keys whose values are strings or numbers; the router parses `?category=18` as a number. */
export function pickSearch<const K extends string>(keys: readonly K[]) {
  return (raw: Record<string, unknown>): { [P in K]?: string | number } => {
    const out: { [P in K]?: string | number } = {}
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string' || typeof value === 'number') out[key] = value
    }
    return out
  }
}

/** A numeric search param, or undefined. */
export const numberParam = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** A currency code from the registry, or undefined. */
export const currencyParam = (value: unknown): CurrencyCode | undefined =>
  typeof value === 'string' && value in CURRENCIES ? (value as CurrencyCode) : undefined
