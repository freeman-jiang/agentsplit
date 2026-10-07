# Persistent identities and delegated agent access

Historical design notes. Implemented behavior is now documented in `AUTH.md` and `MCP.md`: Google sign-in, private groups, admin/member roles, email-bound invitations and self-service API keys. Earlier alternatives below are not the deployed contract.

## Distinct identities

- **Person:** stable internal user ID, independent of display names and email.
- **Group membership:** connects a person to an existing Spliit group and its
  participant record, with the group's permissions.
- **Agent key:** an opaque random secret, stored as a hash, belonging to a person.
  Each key inherits that person's permissions. Keys can be independently revoked.
- **Session:** a browser's authenticated connection to a person, using a secure,
  HTTP-only cookie; changing devices should reconnect to the same identity.

The payer/beneficiaries on an expense are bookkeeping facts. The authenticated
person who submitted it is the actor. An agent may record that Bob paid, while
the audit actor remains the person who authorized the agent. Agent/user identity
must not come from the model's claimed name or a freely supplied participant ID.

## Inviting and recovery

Prefer a single-use, expiring invite link whose token is stored hashed. It
grants a group membership when claimed and is consumed transactionally. The
recipient may claim it using an existing person identity or create one. The
inviter can copy/share the link through their chosen channel; email is optional.
Email delivery should not introduce a mandatory external service.

For repeatable identity across devices, choose a recovery/sign-in mechanism
before building the invitation UI: passkeys, verified email, or a carefully
designed recovery secret. A display name or the existing "Who are you?" picker
is not proof of identity. An honor system can govern names and expense editing
without treating unverified labels as authenticated audit actors.

Users should create/revoke their own agent keys from an authenticated session.
The server sets the owner ID from the session, never from a key-creation form.
Membership changes apply to all keys; no per-agent group whitelist is required.

## OAuth and compatibility

ChatGPT's OAuth linking would authenticate a person and delegate that person's
existing permissions. It should use the same membership checks as API-style
agent keys. Use an established self-hostable authentication implementation
rather than a new handwritten OAuth server. The exact account/recovery UX and
library need review before this phase.

Keep legacy group-link access clearly marked as unverified where necessary.
Authenticated operations must enforce group membership and derive the actor
server-side. Decide which legacy editing capabilities remain available before
claiming verified-identity protection for the entire web application.

## Persistence

Store people, memberships, sessions, invite hashes, key hashes, revocations,
and future actor references in PostgreSQL. Do not use mutable participant names
or device-only localStorage as the identity source. The initial MCP configuration
uses the same separation of user access and keys, but is admin-provisioned in
Coolify rather than a finished user-account system.
