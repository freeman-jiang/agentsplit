// SQL helpers that belong to no one area.
import { sql, type SQL } from 'drizzle-orm'

/** A timestamp as ISO 8601 text in UTC, with milliseconds. */
export const iso = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

/** A timestamp as ISO 8601 text in UTC, with PostgreSQL's full microseconds, for a page cursor. */
export const isoMicro = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** A LIKE pattern that matches `text` anywhere, with its \, % and _ taken literally. */
export const escapeLike = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** A list of text values for `IN (...)`. */
export const textList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `)
