// Account tools: update_profile, with the current app's input and output
// (src/trpc/routers/profile.ts). The rules (trimmed 1 to 50 characters, a
// verified account only) are in src/server/account.ts.
import { Schema } from 'effect'
import { LIMITS } from '../../../shared/limits'
import * as account from '../../account'
import { defineTool } from '../registry'
import { Id } from './shared'

export const updateProfile = defineTool({
  name: 'update_profile',
  kind: 'write',
  destructive: false,
  idempotent: true,
  description:
    'Set your one global display name. Requires your verified account. The name appears across all current group and ungrouped expense views, including existing expenses, and in future audit entries. Historical audit names and snapshots remain unchanged. Only your own name can change; email, IDs, memberships, splits and money are unaffected. Discover your current name and account ID with get_expense_options.',
  input: Schema.Struct({
    name: Schema.String.check(Schema.isBetweenLength(1, LIMITS.nameMax)).annotate({
      description:
        'Your single global display name, used across all current groups, expenses and future entries. Historical audit names and snapshots are preserved. Updates only the authenticated account; never changes email, IDs, membership or money.',
    }),
  }),
  strict: [''],
  output: Schema.Struct({ profile: Schema.Struct({ id: Id, name: Schema.String, email: Schema.String, emailVerified: Schema.Boolean }) }),
  run: ({ db, principal }, { name }) => account.updateProfile(db, { principal, name }),
})

export const accountTools = [updateProfile]
