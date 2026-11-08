// Secrets and stored hashes, with node:crypto. Random IDs are in src/shared/ids.ts.
import { createHash, randomBytes } from 'node:crypto'

/** SHA-256 of the UTF-8 text, as lowercase hex. */
export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** SHA-256 of the UTF-8 text, as base64url without padding. */
export const sha256Base64url = (text: string) => createHash('sha256').update(text).digest('base64url')

/** A secret of 32 random bytes, as base64url without padding: 43 characters. */
export const randomToken = () => randomBytes(32).toString('base64url')
