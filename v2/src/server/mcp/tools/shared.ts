// Small pieces the MCP tool areas share: wire formats of the current app.
import { Schema } from 'effect'
import { sql, type SQL } from 'drizzle-orm'

/** A timestamp as the current app's JSON: ISO 8601 in UTC with milliseconds. */
export const isoSql = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/**
 * A participant's current name: a verified account bound to it names it,
 * else its own placeholder name (the current app's participantDisplayNames).
 */
export const participantNameSql = (participant: SQL) => sql`coalesce((
  SELECT nu.name FROM memberships nm JOIN "user" nu ON nu.id = nm.user_id AND nu.email_verified
  WHERE nm.participant_id = ${participant} LIMIT 1), (SELECT np.name FROM participants np WHERE np.id = ${participant}))`

/** The app origin, without a trailing slash, for links. */
export const origin = (baseUrl: string) => new URL(baseUrl).origin

export const Id = Schema.String
export const NullableString = Schema.NullOr(Schema.String)
/** An ISO timestamp in output. */
export const DateTime = Schema.String.annotate({ format: 'date-time' })
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Money in output: an exact decimal string in the stated currency. */
export const Money = Schema.String.annotate({ description: 'Exact decimal string in the stated currency, e.g. 12.34' })
