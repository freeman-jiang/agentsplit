import DecimalJs from 'decimal.js'
import { z } from 'zod'

// Isolated configuration: another library cannot change accounting precision.
export const Decimal = DecimalJs.clone({ precision: 64 })

// Require the entire string to match, including rejecting a trailing newline.
export const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$(?![\s\S])/

/** Exact base-ten text, bounded to fit NUMERIC(30,12) without DB rounding. */
export const decimalTextSchema = z
  .string()
  .max(32)
  .regex(DECIMAL_PATTERN, 'Enter a decimal amount such as 12.34')
  .refine((value) => {
    if (!DECIMAL_PATTERN.test(value)) return true
    const unsigned = value.replace(/^-/, '')
    const [whole, fraction = ''] = unsigned.split('.')
    return whole.length <= 18 && fraction.length <= 12
  }, 'Decimal exceeds the supported precision')

export const decimalStringSchema = decimalTextSchema.transform((value) =>
  new Decimal(value).toFixed(),
)

export function add(a: DecimalJs.Value, b: DecimalJs.Value): string {
  return new Decimal(a).plus(b).toFixed()
}

export function subtract(a: DecimalJs.Value, b: DecimalJs.Value): string {
  return new Decimal(a).minus(b).toFixed()
}

export type DecimalStrings<T> = T extends DecimalJs
  ? string
  : T extends Date
    ? T
    : T extends readonly (infer V)[]
      ? DecimalStrings<V>[]
      : T extends object
        ? { [K in keyof T]: DecimalStrings<T[K]> }
        : T

/** Preserve dates for tRPC, but never expose Prisma Decimal instances. */
export function decimalStrings<T>(value: T): DecimalStrings<T> {
  if (DecimalJs.isDecimal(value)) return value.toFixed() as DecimalStrings<T>
  if (value instanceof Date || value === null || typeof value !== 'object')
    return value as DecimalStrings<T>
  if (Array.isArray(value))
    return value.map(decimalStrings) as DecimalStrings<T>
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decimalStrings(item)]),
  ) as DecimalStrings<T>
}
