// The hourly job's recurring run, for one group.
import type { Db } from '../../src/server/core/db'
import { materializeDue } from '../../src/server/recurring'

/** The scheduled run for `groupId`. A link that fails throws here, so "created nothing" never hides a failure. */
export async function scheduledRun(db: Db, data: { today: string; groupId: string }): Promise<string[]> {
  const failed: unknown[] = []
  const created = await materializeDue(db, { ...data, onError: (error) => failed.push(error) })
  if (failed.length) throw new AggregateError(failed, `The scheduled run failed for ${failed.length} link(s)`)
  return created
}
