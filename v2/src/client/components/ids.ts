const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/** A 21-character URL-safe ID, the format the expense API accepts (P-EXP-123). */
export function randomExpenseId(): string {
  return [...crypto.getRandomValues(new Uint8Array(21))].map((b) => ALPHABET[b & 63]).join('')
}

/**
 * A search parameter that should stay text. The router parses `?amount=30` as
 * the number 30 and writes strings that look like numbers in quotes, so accept
 * both and read them back as text.
 */
export const searchText = (value: string | number | undefined) => (value === undefined ? undefined : String(value))
