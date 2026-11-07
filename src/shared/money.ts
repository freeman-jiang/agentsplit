// The Effect Schemas of money values. The arithmetic is in minor.ts, which the client uses.
import { Schema } from 'effect'
import { CURRENCIES, type CurrencyCode } from './currencies'
import { DECIMAL } from './minor'

export const CurrencyCodeSchema = Schema.Literals(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]])

/** An exact decimal amount as text, such as "12.30" or "-5". Never a float. */
export const DecimalString = Schema.String.check(Schema.isPattern(DECIMAL)).pipe(Schema.brand('DecimalString'))

/**
 * The same brand without the pattern check, for values the server produces with
 * formatMinor. Encoding a response then runs no regular expression per amount,
 * which keeps large lists fast. Inputs use DecimalString.
 */
export const DecimalOutput = Schema.String.pipe(Schema.brand('DecimalString'))
