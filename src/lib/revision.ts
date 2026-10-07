import { TRPCError } from '@trpc/server'
import type { AuditActor } from './expense-history'

/** Check under the existing group lock, before changing any data or receipts. */
export function assertRevision(
  actual: number,
  expected: number | undefined,
  actor?: AuditActor,
) {
  if (actor && expected === undefined)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'expectedRevision is required; read the current record first',
    })
  if (expected !== undefined && expected !== actual)
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'The record changed. Read its current revision and retry your intended changes.',
    })
}
