// The account screens: profile, keys, connections and the OAuth consent client.
import { queryOptions } from '@tanstack/react-query'
import { rpc } from '../rpc'
import { keys } from './keys'

export const accountQuery = queryOptions({ queryKey: keys.account, queryFn: () => rpc((api) => api('account.get', undefined)) })

export const consentClientQuery = (clientId: string) =>
  queryOptions({ queryKey: keys.consentClient(clientId), queryFn: () => rpc((api) => api('account.consentClient', { clientId })) })
