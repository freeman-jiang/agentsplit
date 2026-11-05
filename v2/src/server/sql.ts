// SQL fragments shared by ledger.ts and feed.ts. A separate module, because the
// ledger and the feed import each other indirectly (ledger → ungrouped → feed).
import { sql } from 'drizzle-orm'

/** The name to show for the author of an activity row `a`. */
export const actorName = sql.raw(`CASE WHEN a.source = 'system' AND a.actor_name IS NULL THEN 'Automatic recurrence' ELSE a.actor_name END`)
