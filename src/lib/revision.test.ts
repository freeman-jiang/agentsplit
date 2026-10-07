import { assertRevision } from './revision'
import { expenseChangesSchema } from './schemas'

describe('optimistic mutation revisions', () => {
  const actor = { userId: 'owner', connectionId: 'codex' }
  it('requires a current revision for authenticated agent edits', () => {
    expect(() => assertRevision(2, undefined, actor)).toThrow(
      'expectedRevision is required',
    )
    expect(() => assertRevision(2, 1, actor)).toThrow('record changed')
    expect(() => assertRevision(2, 2, actor)).not.toThrow()
  })
  it('checks supplied human revisions too', () => {
    expect(() => assertRevision(2, 1)).toThrow('record changed')
    expect(() => assertRevision(2, 2)).not.toThrow()
  })
  it('does not add defaults to partial edits', () => {
    expect(expenseChangesSchema.parse({ title: 'Changed title' })).toEqual({
      title: 'Changed title',
    })
  })
})
