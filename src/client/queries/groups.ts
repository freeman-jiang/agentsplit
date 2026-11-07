import { queryOptions, type QueryClient } from '@tanstack/react-query'
import type { Group } from '../../shared/api'
import { rpc } from '../rpc'
import { keys } from './keys'

/** The group as every group page reads it: name, people, the caller's role and participant. */
export const groupQuery = (groupId: string) =>
  queryOptions({ queryKey: keys.groupSummary(groupId), queryFn: () => rpc((api) => api('groups.get', { groupId })) })

export const groupDetailsQuery = (groupId: string) =>
  queryOptions({ queryKey: keys.groupDetails(groupId), queryFn: () => rpc((api) => api('groups.details', { groupId })) })

export const directoryQuery = (offset: number) =>
  queryOptions({ queryKey: keys.directory(offset), queryFn: () => rpc((api) => api('groups.directory', { offset })) })

export const invitationQuery = (token: string) =>
  queryOptions({ queryKey: keys.invitation(token), queryFn: () => rpc((api) => api('invitations.preview', { token })) })

/**
 * The group a URL segment names: its ID, its slug, an old slug or another
 * letter case. A group already in the cache under its ID or slug needs no
 * request; otherwise the server resolves the segment, and the answer is
 * cached under the group's ID.
 */
export async function resolveGroup(data: { queryClient: QueryClient; segment: string }): Promise<typeof Group.Type> {
  const { queryClient, segment } = data
  const cached = queryClient
    .getQueriesData<typeof Group.Type>({ queryKey: ['group'], predicate: (query) => query.queryKey[2] === 'summary' })
    .find(([, group]) => group !== undefined && (group.id === segment || group.slug === segment))?.[1]
  if (cached) return queryClient.ensureQueryData(groupQuery(cached.id))
  const group = await rpc((api) => api('groups.get', { groupId: segment }))
  queryClient.setQueryData(groupQuery(group.id).queryKey, group)
  return group
}
