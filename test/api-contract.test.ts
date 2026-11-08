// Each area defines its procedures in its own file and they are merged into one
// group. Two areas defining the same tag would make one handler silently
// replace the other at runtime, so a duplicate fails here, and so does an area
// that the contract exports but AgentSplitApi does not merge.
import { expect, it } from 'vitest'
import * as api from '~/shared/api'

/** An RpcGroup: its procedures and merge (effect/rpc exports no guard). `unknown`: the barrel also exports schemas and errors. */
const isRpcGroup = (value: unknown): value is { readonly requests: ReadonlyMap<string, unknown> } =>
  typeof value === 'function' && 'requests' in value && value.requests instanceof Map && 'merge' in value && typeof value.merge === 'function'

it('gives every procedure a unique tag across all areas, and merges every area', () => {
  const areas = Object.values(api).filter((value) => value !== api.AgentSplitApi && isRpcGroup(value))
  expect(areas.length).toBeGreaterThanOrEqual(7)
  const tags = areas.flatMap((group) => (isRpcGroup(group) ? [...group.requests.keys()] : []))
  const duplicates = tags.filter((tag, i) => tags.indexOf(tag) !== i)
  expect(duplicates).toEqual([])
  expect(api.AgentSplitApi.requests.size).toBe(tags.length)
})
