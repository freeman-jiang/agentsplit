// IDs, secrets and their stored hashes. The client imports src/shared/ids.ts
// instead: this module uses node:crypto.
import { createHash, randomBytes } from 'node:crypto'

export { randomId } from '../../shared/ids'

/** SHA-256 of the UTF-8 text, as lowercase hex. */
export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** SHA-256 of the UTF-8 text, as base64url without padding. */
export const sha256Base64url = (text: string) => createHash('sha256').update(text).digest('base64url')

/** A secret of 32 random bytes, as base64url without padding: 43 characters. */
export const randomToken = () => randomBytes(32).toString('base64url')
