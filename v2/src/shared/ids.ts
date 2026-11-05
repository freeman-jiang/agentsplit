// IDs without Node or Effect, for the client and the server alike.
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/** A 21-character URL-safe random ID, the same format as the current app's nanoid() IDs, and the format the expense API accepts (P-EXP-123). */
export function randomId(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  let id = ''
  for (const byte of bytes) id += ALPHABET[byte & 63]
  return id
}

/** The response header with the ID of an RPC request. The server logs failed calls with it, and the error page shows it. */
export const REQUEST_ID_RESPONSE_HEADER = 'X-Request-Id'
