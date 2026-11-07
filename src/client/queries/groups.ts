import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { isNotFoundEntity, NOT_FOUND_MESSAGES } from '~/shared/errors'
import { rpc } from '../rpc'

export const directoryQuery = (offset: number) =>
  queryOptions({ queryKey: ['groups', 'directory', offset], queryFn: () => rpc((api) => api('groups.directory', { offset })) })

export const groupDetailsQuery = (group: string) =>
  queryOptions({ queryKey: ['group', group, 'details'], queryFn: () => rpc((api) => api('groups.details', { groupId: group })) })

export const invitationQuery = (token: string) =>
  queryOptions({ queryKey: ['invitation', token], queryFn: () => rpc((api) => api('invitations.preview', { token })) })

/** A fresh key for one user action; a retry of the same request reuses it. */
export const newIdempotencyKey = () => crypto.randomUUID()

/** After a group write, every screen that shows groups reads again. */
export const refreshGroups = (queryClient: QueryClient) =>
  Promise.all([queryClient.invalidateQueries({ queryKey: ['groups'] }), queryClient.invalidateQueries({ queryKey: ['group'] })])

/** The message to show for a failed call. A revision conflict asks the user to look again. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const e = error as { _tag: string; message?: unknown; entity?: unknown }
    switch (e._tag) {
      case 'Conflict':
        return 'Someone else changed this group while you were editing. The page now shows the latest version; check it and try again.'
      case 'NotFound':
        return isNotFoundEntity(e.entity) ? NOT_FOUND_MESSAGES[e.entity] : 'Not found.'
      case 'Unauthorized':
        return 'Sign in required'
    }
    if (typeof e.message === 'string' && e.message) return e.message
  }
  return error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.'
}
