const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/** A 21-character URL-safe random ID, the same format as the current app's nanoid() IDs. */
export function randomId(size = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  let id = ''
  for (const byte of bytes) id += ALPHABET[byte & 63]
  return id
}
