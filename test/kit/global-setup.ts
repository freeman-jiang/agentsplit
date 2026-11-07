// Vitest's global setup: one migrated template database for the whole run.
import { dropCopies, migrateTemplate } from './database'

export default async function setup(): Promise<() => Promise<void>> {
  await migrateTemplate()
  return dropCopies
}
