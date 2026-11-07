// IDs without Node or Effect, for the client and the server alike.
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/** An ID in the alphabet of randomId, one character per byte. */
export const idOfBytes = (bytes: Uint8Array) => Array.from(bytes, (byte) => ALPHABET[byte & 63]).join('')

/** A 21-character URL-safe random ID, the same format as the current app's nanoid() IDs, and the format the expense API accepts (P-EXP-123). */
export const randomId = (size = 21): string => idOfBytes(crypto.getRandomValues(new Uint8Array(size)))

/** The one order of IDs and codes: by UTF-16 code unit (`a < b`), as the current app sorts participant IDs. */
export const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A 21-character ID, the format of randomId() and of the current app's nanoid() IDs. */
export const GROUP_ID = /^[A-Za-z0-9_-]{21}$/

/** The response header with the ID of an RPC request. The server logs failed calls with it, and the error page shows it. */
export const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id'
