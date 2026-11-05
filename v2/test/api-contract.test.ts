// Each area defines its procedures in its own file and they are merged into one
// group. Two areas defining the same tag would make one handler silently
// replace the other at runtime, so a duplicate fails here.
import { expect, it } from 'vitest'
import { AgentSplitApi } from '~/shared/api'
import * as account from '~/shared/api/account'
import * as core from '~/shared/api/core'
import * as expenses from '~/shared/api/expenses'
import * as feed from '~/shared/api/feed'
import * as groups from '~/shared/api/groups'

it('gives every procedure a unique tag across all areas', () => {
  const groupsOf = [core.CoreApi, groups.GroupsApi, feed.FeedApi, account.AccountApi, expenses.ExpensesApi]
  const tags = groupsOf.flatMap((group) => [...group.requests.keys()])
  const duplicates = tags.filter((tag, i) => tags.indexOf(tag) !== i)
  expect(duplicates).toEqual([])
  expect(AgentSplitApi.requests.size).toBe(tags.length)
})
