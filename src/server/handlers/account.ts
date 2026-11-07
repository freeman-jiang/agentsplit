import { Layer } from 'effect'
import * as account from '../account'
import { Api, read, write } from '../rpc'

export const AccountHandlers = Layer.mergeAll(
  Api.toLayerHandler('account.get', () => read((db, principal) => account.getAccount(db, { principal }))),
  Api.toLayerHandler('account.updateProfile', ({ name }) => write((db, principal) => account.updateProfile(db, { principal, name }))),
  Api.toLayerHandler('account.revokeApiKey', ({ keyId }) => write((db, principal) => account.revokeApiKey(db, { principal, keyId }))),
  Api.toLayerHandler('account.revokeConnection', ({ clientId }) =>
    write((db, principal) => account.revokeConnection(db, { principal, clientId })),
  ),
  Api.toLayerHandler('account.consentClient', ({ clientId }) => read((db) => account.consentClient(db, { clientId }))),
)
