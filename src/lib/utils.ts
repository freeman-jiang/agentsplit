import { Category, Group } from '@/generated/prisma/browser'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { Currency, getCurrency } from './currency'
import { Decimal } from './money'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type DateTimeStyle = NonNullable<
  ConstructorParameters<typeof Intl.DateTimeFormat>[1]
>['dateStyle']
export function formatDate(
  date: Date,
  locale: string,
  options: { dateStyle?: DateTimeStyle; timeStyle?: DateTimeStyle } = {},
) {
  return date.toLocaleString(locale, {
    ...options,
  })
}

/**
 * Converts a date-only field to a date on its own calendar day.
 *
 * Fields stored as DATE type in the database (e.g., expenseDate) come back at
 * UTC midnight. Reading them in the local timezone would shift them to the
 * previous day west of UTC, so the calendar day is taken from the UTC
 * components and rebuilt as a local date.
 *
 * @param date - The date to convert (typically from a database DATE field, e.g., 2025-10-17T00:00:00.000Z)
 * @returns A date at local midnight on the calendar day the field stores
 */
export function dateOnlyToLocalDate(date: Date) {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/**
 * Formats a date-only field (without time) for display.
 * Use this for dates stored as DATE type in the database (e.g., expenseDate).
 *
 * @param date - The date to format (typically from a database DATE field, e.g., 2025-10-17T00:00:00.000Z)
 * @param locale - The locale string (e.g., 'en-US', 'fr-FR')
 * @param options - Formatting options (dateStyle, timeStyle)
 * @returns Formatted date string in the specified locale
 */
export function formatDateOnly(
  date: Date,
  locale: string,
  options: { dateStyle?: DateTimeStyle; timeStyle?: DateTimeStyle } = {},
) {
  return dateOnlyToLocalDate(date).toLocaleString(locale, {
    ...options,
  })
}

export function formatCategoryForAIPrompt(category: Category) {
  return `"${category.grouping}/${category.name}" (ID: ${category.id})`
}

/** Format exact face-value decimals. ECMA-402 accepts decimal strings. */
export function formatCurrency(
  currency: Currency,
  amount: string,
  locale: string,
) {
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: currency.decimal_digits,
    maximumFractionDigits: currency.decimal_digits,
    style: 'currency',
    currency: currency.code || 'EUR',
  })
  const text = formatDecimal(format, amount)
  return currency.code ? text : text.replace('€', currency.symbol)
}

// TypeScript's older Intl signature omits the standard's string input overload.
// https://tc39.es/ecma402/#sec-tointlmathematicalvalue
export function formatDecimal(
  format: Intl.NumberFormat,
  amount: string,
): string {
  return (format.format as (value: string) => string)(amount)
}

export function getCurrencyFromGroup(
  group: Pick<Group, 'currency' | 'currencyCode'>,
): Currency {
  if (!group.currencyCode) {
    return {
      name: 'Custom',
      symbol_native: group.currency,
      symbol: group.currency,
      code: '',
      name_plural: '',
      rounding: 0,
      decimal_digits: 2,
    }
  }
  return getCurrency(group.currencyCode)
}

/** Fixed-point text for CSV/display; never changes the stored denomination. */
export function formatAmountAsDecimal(amount: string, currency: Currency) {
  return new Decimal(amount).toFixed(currency.decimal_digits)
}

export function formatFileSize(size: number, locale: string) {
  const formatNumber = (num: number) =>
    num.toLocaleString(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })

  if (size > 1024 ** 3) return `${formatNumber(size / 1024 ** 3)} GB`
  if (size > 1024 ** 2) return `${formatNumber(size / 1024 ** 2)} MB`
  if (size > 1024) return `${formatNumber(size / 1024)} kB`
  return `${formatNumber(size)} B`
}

export function normalizeString(input: string): string {
  // Replaces special characters
  // Input: áäåèéę
  // Output: aaaeee
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}
