// The account area: the signed-in user's profile, API keys and connected apps.
// API keys are created through Better Auth (/api/auth/api-key/create), which
// owns the key format and hash; listing and revoking them run here.
import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { LIMITS } from '../limits'
import { Id, NameInput, ReadError, WriteError } from './core'

export const Profile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  emailVerified: Schema.Boolean,
})

export const ApiKeySummary = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  /** The first characters of the key, for recognition; never the key. */
  start: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
})

export const ConnectedApp = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  /** The current consent still includes agentsplit:write. */
  canWrite: Schema.Boolean,
})

export const Account = Schema.Struct({
  profile: Profile,
  apiKeys: Schema.Array(ApiKeySummary),
  connections: Schema.Array(ConnectedApp),
})

const ClientId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(LIMITS.clientIdMax))

export const ConsentClient = Schema.Struct({ clientId: Schema.String, name: Schema.NullOr(Schema.String) })

export class AccountApi extends RpcGroup.make(
  Rpc.make('account.get', { success: Account, error: ReadError }),
  Rpc.make('account.updateProfile', {
    payload: { name: NameInput },
    success: Schema.Struct({ profile: Profile }),
    error: WriteError,
  }),
  Rpc.make('account.revokeApiKey', { payload: { keyId: Id }, success: Schema.Struct({ revoked: Schema.Literal(true) }), error: WriteError }),
  Rpc.make('account.revokeConnection', {
    payload: { clientId: ClientId },
    success: Schema.Struct({ revoked: Schema.Literal(true) }),
    error: WriteError,
  }),
  /** The client named on the consent page; null when it is unknown or disabled. */
  Rpc.make('account.consentClient', {
    payload: { clientId: ClientId },
    success: Schema.NullOr(ConsentClient),
    error: ReadError,
  }),
) {}

