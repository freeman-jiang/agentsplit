// The arguments that several MCP tools take, under the current app's names,
// built from the shared contract (src/shared/api/) and the limits
// (src/shared/limits.ts). A tool decodes its arguments once, against the same
// rules that the web app's call meets.
import { Schema, SchemaTransformation } from 'effect'
import { CalendarDate as ContractDate, Id, PageLimit as ContractPageLimit } from '../../../shared/api'
import { optional, RecordedTime } from './wire'

/** A tool without arguments: an object that closes to `{}`. An empty Struct would allow any value. */
export const NoArguments = Schema.Record(Schema.String, Schema.Never)

/** A real calendar date, YYYY-MM-DD (2026-02-29 and 2026-09-31 are refused). */
export const CalendarDate = ContractDate.annotate({ format: 'date' })

/** A page size, with the tool's default when it is left out. */
export const PageLimit = (fallback: number) => ContractPageLimit.annotate({ default: fallback })

/**
 * Text that the current app trimmed (z.string().trim()): the raw text within
 * `length`, then the contract's schema `to` checks the trimmed text.
 */
export const trimmed = <S extends Schema.Codec<string, string>>(to: S, length: { min: number; max: number }) =>
  Schema.String.check(Schema.isBetweenLength(length.min, length.max)).pipe(Schema.decodeTo(to, SchemaTransformation.trim()))

/** The history boundary of a historical read (src/server/history.ts). */
export const HistoryFields = {
  asOf: optional(RecordedTime),
  atActivityId: optional(Id.annotate({ description: 'Exact inclusive history boundary from this group. Reuse the returned boundary for stable pagination.' })),
}

/** The boundary as the history services take it: only the keys that were given. */
export const boundaryOf = (input: { asOf?: string; atActivityId?: string }) => ({
  ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
  ...(input.atActivityId === undefined ? {} : { atActivityId: input.atActivityId }),
})
