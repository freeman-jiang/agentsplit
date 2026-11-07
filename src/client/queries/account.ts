// The signed-in account. Route guards import meQuery and are not code-split, so
// this module stays small: the Better Auth client is in src/client/auth-client.ts,
// which only screen components import.
import { queryOptions } from '@tanstack/react-query'
import { rpc } from '../rpc'
import { keys } from './keys'

export const meQuery = queryOptions({ queryKey: keys.me, queryFn: () => rpc((api) => api('session.me', undefined)) })

export const accountQuery = queryOptions({ queryKey: keys.account, queryFn: () => rpc((api) => api('account.get', undefined)) })

export const consentClientQuery = (clientId: string) =>
  queryOptions({ queryKey: keys.consentClient(clientId), queryFn: () => rpc((api) => api('account.consentClient', { clientId })) })
