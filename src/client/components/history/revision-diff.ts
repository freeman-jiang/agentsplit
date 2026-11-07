import type { RevisionField } from '~/shared/history'

/** Fields with one person per line. The order of the people carries no meaning, and saved revisions do not keep one order. */
const PEOPLE_FIELDS: ReadonlySet<RevisionField> = new Set(['payer', 'splits'])

const sortedLines = (text: string) => text.split('\n').sort().join('\n')

/**
 * Whether a field of the revision panel changed from the preceding revision.
 * People compare as a set of lines, so a notes-only edit does not mark
 * "Split between" as changed when the people come back in another order.
 */
export function fieldChanged(data: { field: RevisionField; previous: string; current: string }): boolean {
  if (data.previous === data.current) return false
  return !PEOPLE_FIELDS.has(data.field) || sortedLines(data.previous) !== sortedLines(data.current)
}
