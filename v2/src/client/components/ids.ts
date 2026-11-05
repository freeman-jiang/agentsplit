/**
 * A search parameter that should stay text. The router parses `?amount=30` as
 * the number 30 and writes strings that look like numbers in quotes, so accept
 * both and read them back as text.
 */
export const searchText = (value: string | number | undefined) => (value === undefined ? undefined : String(value))
