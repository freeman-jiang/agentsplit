# Accounts and private groups

AgentSplit uses self-hosted Better Auth with Google as the identity provider.
Only `openid`, `email`, and `profile` are requested. PostgreSQL stores accounts,
sessions, membership, invitations and hashed API keys. No hosted auth vendor or
email-delivery service is required. Better Auth telemetry is explicitly disabled.

## Deployment

1. Create a Google Auth Platform **Web application** client in your personal
   project. Set its redirect URI to `https://YOUR_HOST/api/auth/callback/google`.
   Configure branding/homepage/privacy; publish to Production for general sign-in.
2. Set `BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a separately
   generated `BETTER_AUTH_SECRET` of at least 32 characters in Coolify. Never
   put secrets in Git, images, browser public environment variables, or chat.
3. Set `AUTH_BOOTSTRAP_EMAIL` to the verified Google email that should own the
   groups existing before the cutover. The migration captures those groups;
   groups created later by other users cannot be claimed by bootstrap.
4. Deploy the additive migrations and app together. The configured owner signs
   in once. Bootstrap grants admin membership and imports that owner's legacy
   `MCP_ACCESS_GRANTS` keys into Better Auth's hashed key table. With multiple
   legacy users, set `AUTH_BOOTSTRAP_LEGACY_USER_ID` explicitly. Unmapped keys
   stop working. Before the first owner login, legacy keys cannot authenticate.
5. Verify login and existing groups, then remove the legacy configuration and
   bootstrap email if desired. The one-time database marker prevents re-import,
   including after keys are revoked or memberships are removed.

The Coolify compose file no longer exposes Garage's anonymous website endpoint.
Only its authenticated S3 API is routed. Existing storage pointers remain valid
internally; receipts are downloaded through `/api/receipts` with a web session or
Bearer key. Existing current and historical receipt ownership is backfilled.
Do not add a public bucket policy or re-enable the public website router.

## User flow

- The signed-out landing page has a single **Log In** action that opens Google.
  Signed-in visits to `/` redirect to `/groups`, which lists database memberships
  on every device.
- Create a group: you become its admin. Participants are bookkeeping names and
  need not already have accounts.
- Open **Members** or group Settings. Admins enter a Google email and copy the
  invitation link to send themselves. Links expire after 7 days, are single-use,
  stored as hashes, and require a matching verified email to accept.
- Members can read and manage expenses and record repayments. Admins also edit
  group settings, invite/revoke, remove members, and change roles. The last admin
  cannot leave or be removed/demoted without promoting a replacement.
- The top-right initials avatar opens **Account & keys**, with theme/language
  preferences and controls to create and revoke one key per agent. A key is shown once,
  stored hashed, and inherits all current memberships/roles. A key cannot mint
  other keys or authenticate as a browser session.
- Payer/beneficiary selections and the selected balance view are bookkeeping
  controls. Audit identity always comes from the real session or key.

Membership changes are serialized under the group write lock. Ledger writes
recheck membership inside the transaction. Invitations and membership changes
are also recorded in the append-only activity log. Removing members never
removes their historical bookkeeping identity. Expense writes remain revision
checked and produce one immutable snapshot per revision.

## Verification

- `bun run test`, `bun run check-types`, `bun run lint`, `bun run check-formatting`.
- `bun scripts/test-private-accounts.ts` against a loopback test/e2e PostgreSQL
  database checks actual Better Auth sessions/keys plus the tRPC/MCP paths.
- Playwright's test fixture seeds synthetic verified accounts directly in a
  **local disposable database only**, then uses genuine signed session cookies.
  It does not add a test bypass to the application. Set the test database URL
  and the same test `BETTER_AUTH_SECRET` used by the local server.
- A real Google round trip must additionally be checked on the deployed origin.

## Operational limits

Google identity proves control of a Google account, not a legal identity.
Instance/database administrators can access the database and stored receipts.
The audit log is protected against ordinary application deletion but is not a
separate backup. Back up PostgreSQL and Garage off-host to survive host loss.
Google sign-in and invitations do not change that backup requirement.
