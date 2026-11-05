import { Effect, Layer } from 'effect'
import * as groups from '../groups'
import { Api, AppConfig, read, write } from '../rpc'

export const GroupsHandlers = Layer.mergeAll(
  Api.toLayerHandler('groups.directory', ({ offset }) => read((db, principal) => groups.listDirectory(db, { principal, offset }))),
  Api.toLayerHandler('groups.details', ({ groupId }) => read((db, principal) => groups.getGroupDetails(db, { principal, group: groupId }))),
  Api.toLayerHandler('groups.create', ({ groupId, idempotencyKey, group }) =>
    write((db, principal) => groups.createGroup(db, { principal, groupId, idempotencyKey, group })),
  ),
  Api.toLayerHandler('groups.update', ({ groupId, expectedRevision, idempotencyKey, changes }) =>
    write((db, principal) => groups.updateGroup(db, { principal, group: groupId, expectedRevision, idempotencyKey, changes })),
  ),
  Api.toLayerHandler('groups.access', ({ idempotencyKey, request }) =>
    Effect.gen(function* () {
      const { baseUrl } = yield* AppConfig
      return yield* write((db, principal) => groups.changeAccess(db, { principal, baseUrl, idempotencyKey, request }))
    }),
  ),
  Api.toLayerHandler('invitations.preview', ({ token }) => read((db, principal) => groups.previewInvitation(db, { principal, token }))),
)
