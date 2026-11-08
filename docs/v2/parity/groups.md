# Groups and access: parity record

This file records how v2 covers the P-GROUP and P-ACCESS items of [PARITY.md](../PARITY.md). "Test" names a test in `v2/test/db/groups.test.ts` unless it says otherwise. "Browser" means a check in the T3 browser against a dev server with synthetic data (2026-11-05). "Deferred" names the area or person that must finish the item.

## Changes to the error shape

The shared `Conflict` error means "the revision changed" and carries `currentRevision`. Business-rule failures that the current app reports as CONFLICT or BAD_REQUEST (a slug in use, a reserved participant, a pending invitation, the last admin, a used invitation) are `Invalid` in v2, with the current app's message. A missing pending invitation or member is `NotFound` (`entity: 'invitation'` or `'member'`); the client maps it to the current message. The MCP area must map these errors to its tool results.

## Groups

### Group directory

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-01 | Done: the `/groups` routes redirect a signed-out visitor to `/sign-in` | Route guard; browser |
| P-GROUP-02 | Done: an unverified session gives no principal | `test/db/session.test.ts` |
| P-GROUP-03 | Done: heading "My groups" and a "Create" button. The browser title is deferred (see P-GROUP-48) | Browser |
| P-GROUP-04, -05, -06 | Done: active named memberships, newest first, ID as tiebreaker; private contexts excluded | "lists named groups newest first…" |
| P-GROUP-07 | Done: 100 groups per page with "More groups" and "Previous groups" | Code; no test with more than 100 groups |
| P-GROUP-08 | Changed (DECISIONS.md G): "You are not in any group yet. Create one or ask a group admin to invite you." | Code |
| P-GROUP-09, -10 | Done: "Loading recent groups…" while pending; "Could not load your groups. Try again." with "Retry" | Code |
| P-GROUP-11, -12 | Done: name link, participant count, medium date; the whole card opens the group | "lists named groups…" (count); browser |
| P-GROUP-13 to -17 | Done: `starredGroups` and `archivedGroups` in localStorage, same keys and format; star unarchives, archive unstars; corrupt values read as empty | Browser (star moves the group to "Starred groups") |
| P-GROUP-18, -19 | Done: "Your total balance" with the unbound-group note. The total covers every active membership, so it matches the home total (P-BAL-106 fix) | "lists named groups…" (USD 50.00, 1 unbound); browser |
| P-GROUP-20 | Not ported (DECISIONS.md E) | — |
| P-GROUP-21 | Fixed: `/groups?access=denied` explains that the group did not open | Browser |
| P-GROUP-22 | Not ported (DECISIONS.md E) | — |

### Create group

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-23 | Changed: no "Currency symbol" field. v2 has only registered currencies (PLAN.md invariant 1), so a custom symbol cannot exist | — |
| P-GROUP-24 | Deferred (lead): the form preselects USD. v2 has no `DEFAULT_CURRENCY_CODE` setting for the SPA yet | — |
| P-GROUP-25, -26 | Done: native select "Default currency"; "You (<name>) are added automatically…" and "Add participant" | Browser |
| P-GROUP-27 to -31 | Done | "adds the creator as the bound admin…", "names the creator Member…", "refuses duplicate participant names…" |
| P-GROUP-32 to -36 | Done in the contract: name 2–50 (trimmed), information up to 10,000, up to 99 other names of 1–50. Symbol and code rules are replaced by the currency registry | `GroupCreateInput` in `src/shared/api/groups.ts` |
| P-GROUP-37 | Not applicable: no symbol field | — |
| P-GROUP-38 | Done (`Invalid`, field `groupId`, current message) | "accepts a caller-chosen ID once" |
| P-GROUP-39, -40 | Done; `activities.group_revision` is 1 and the snapshot has `schemaVersion: 2, kind: 'group'` | "adds the creator as the bound admin…" |
| P-GROUP-41, -42, -43 | Done | Browser (slug error shown, then `/ski-cabin/expenses`) |
| P-GROUP-44 | Done: fields stack below 640 px, two columns from 640 px | Browser at 320 and 1280 px |

### Group shell

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-45 | Done: `/groups/<id>` and `/<group>` open the Expenses tab | Browser |
| P-GROUP-46 | Done: no membership or no group redirects to `/groups?access=denied` | Browser; "does not grant access through a slug" |
| P-GROUP-47 | Deferred (private expenses area): a private context's ID opens the group layout, not `/expenses/<id>` | — |
| P-GROUP-48 | Deferred (lead): v2 has no app-wide page title mechanism yet | — |
| P-GROUP-49 | Done: the header links the group name and a "People" button to `edit#members` (minimal change to `$group.tsx`) | Browser |
| P-GROUP-50, -51, -52 | Shared layout (lead) | — |
| P-GROUP-53 | Deferred (lead): a render error shows the root error page, not "Couldn't load this group" | — |
| P-GROUP-54 | Done: `groups.get` returns `role` and `participantId` | `test/db/ledger.test.ts` |
| P-GROUP-55 | Done: a bound, verified account's name replaces the placeholder in `groups.get` and `groups.details` | "names the creator Member…" (display name "Cara"); browser |

### Information tab

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-56, -57 | Done | Browser |
| P-GROUP-58 | Fixed: only admins see the pencil | Code (`role === 'admin'`) |

### Settings tab

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-59, -60 | Done | Browser (member sees only People and "Leave group") |
| P-GROUP-61, -62 | Done | Browser |
| P-GROUP-63 | Done | "keeps existing expenses unchanged when the default currency changes" |
| P-GROUP-64 | Done | "lets only admins change settings" |
| P-GROUP-65 | Done: `expectedRevision` is a required field of `groups.update` | Contract |
| P-GROUP-66 to -69 | Done | "refuses a stale revision", "applies partial changes…", "leaves the revision alone…" |
| P-GROUP-70, -72 | Done | "refuses IDs from another group and new names that repeat" |
| P-GROUP-71 | Done | "refuses renaming or removing bound or invited people" |
| P-GROUP-73 | Done: 1 to 100 entries in `participants` | Contract |
| P-GROUP-74 | Done | "refuses settings edits of a private expense context" |
| P-GROUP-75 | Done, and enforced by the database: a groups row changes only as the next revision with its `update_group` activity (P-DB-73) | "applies partial changes…"; database-rules.test.ts "0004: group audit" |
| P-GROUP-76 | Fixed: "<name> is part of expenses, so they cannot be removed." | "refuses to remove a person in an expense…" |
| P-GROUP-77 | Partly: `groups.details` returns `kind`, the group, the caller's role and participant, people with status, emails, `inExpenses` and `reserved`, unbound members and invitations. Share, CSV and JSON links are deferred to the export and MCP areas; `groupRef` gives the path | — |
| P-GROUP-78 | Changed: a missing group is `Forbidden` "Group access denied", the same as a group the caller cannot see | "does not grant access through a slug" |

### People section

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-79 to -81 | Done | Browser |
| P-GROUP-82 to -84 | Done | "adds, renames and removes unreferenced people"; browser (Delete person hidden for Dana, who is in an expense) |
| P-GROUP-85 | Done | "binds a legacy member…" (`unboundMembers`) |
| P-GROUP-86, -87 | Done | Browser |
| P-GROUP-88, -89 | Done | Code |
| P-GROUP-90 | Done | Browser at 320 px with an open invitation panel and a long email: no horizontal scroll |
| P-GROUP-91 | English only (DECISIONS.md F) | — |

### Slugs and routing

| Item | Status | Proof |
| --- | --- | --- |
| P-GROUP-92 to -95 | Done; changed: `assets` is reserved too (DECISIONS.md) | "normalizes, validates and reserves slugs", "refuses a slug in use…" |
| P-GROUP-96 | Done: an advisory lock plus SERIALIZABLE retries; needed the retry fix in `src/server/db.ts` | "lets exactly one of two concurrent creates claim a slug" (runs through the server's `transaction()`) |
| P-GROUP-97 | Done | "resolves slugs case-insensitively…" |
| P-GROUP-98 | Changed: the canonical path is `/<slug>`, else `/<id>` (the v2 router's `$group` segment) | — |
| P-GROUP-99 | Done | Browser |
| P-GROUP-100 | Changed: the SPA redirects `/groups/<id>/<tab>` to `/<id>/<tab>` and then to `/<slug>/<tab>`, keeping the query and hash. It is a client redirect, not a 307: the Worker serves the SPA for every non-API path | Browser (`/groups/<id>/information?x=1` → `/maple/information?x=1`) |
| P-GROUP-101, -102 | Not applicable: the Worker handles `/api/*` before the SPA, and the SPA has no POST pages | — |
| P-GROUP-103 | Done | "does not grant access through a slug" |
| P-GROUP-104 | Done | Browser (`/ski-cabin/edit` → `/cabin/edit`) |
| P-GROUP-105 | Fixed: slugs match in any case and the URL moves to the lowercase slug | "resolves slugs case-insensitively…"; browser (`/Maple/edit`) |
| P-GROUP-106 | Fixed: `group_slug_history` keeps old slugs; an old slug opens the group and the URL moves to the current slug. A slug that another group claims later goes to that group | "resolves slugs case-insensitively…"; browser (`/ski-cabin/information` → `/cabin/information`) |

## Invitations and access

### Membership checks

| Item | Status | Proof |
| --- | --- | --- |
| P-ACCESS-01 | Done: `read` and `write` require a principal | `src/server/rpc.ts` |
| P-ACCESS-02 | Deferred (MCP area): OAuth scopes | — |
| P-ACCESS-03 | Done: every groups procedure checks membership itself | "does not grant access…", "removes access at once…" |
| P-ACCESS-04 | Deferred (MCP area): `list_groups` with explicit IDs | — |
| P-ACCESS-05, -06 | Other areas (balances, expenses) | — |
| P-ACCESS-07 | Done: the group ID is a required field | Contract |
| P-ACCESS-08, -09 | Done | "removes access at once…", "does not grant access through a slug" |

### Invitations (admin side)

| Item | Status | Proof |
| --- | --- | --- |
| P-ACCESS-10 | Done | "lets only admins invite" |
| P-ACCESS-11 to -15 | Done. The token hash stays hex SHA-256, so imported invitations keep working. The URL is never stored, not even in the idempotency record; a retried invite returns `url: null` | "creates an email-bound invitation…", "returns the invitation without its URL to a retried request" |
| P-ACCESS-16, -18 | Done | "refuses a second pending invitation…" |
| P-ACCESS-17 | Done | "lets one of two simultaneous invitations…" |
| P-ACCESS-19 | Done | "lets any member leave and rejoin as the same participant" |
| P-ACCESS-20 | Done | "binds a legacy member…" (last assertion) |
| P-ACCESS-21 to -24 | Done | Browser |
| P-ACCESS-25, -26 | Done | "lists pending invitations for admins…" |
| P-ACCESS-27 | Done: "<email> · Old invitation needs reissuing" with "Revoke invitation" | Code; no fixture |
| P-ACCESS-28 | Fixed: expired invitations are hidden in every context | "lists pending invitations for admins…" |
| P-ACCESS-29 | Done | "binds the joiner…" |
| P-ACCESS-30 | Fixed: the log says "Invitation created for <participant>", without the email. Other access entries name people, never emails or user IDs | "creates an email-bound invitation…"; dev database log |

### Invite page

| Item | Status | Proof |
| --- | --- | --- |
| P-ACCESS-31 | Done | Route guard |
| P-ACCESS-32 | Partly: redirects to `/sign-in?next=/invite/<token>`. Deferred (auth area): the sign-in page must honor `next` and show "You've been invited to AgentSplit" | Route guard |
| P-ACCESS-33 | Fixed: an unverified session counts as signed out, so it also keeps `next` | Route guard |
| P-ACCESS-34 to -36 | Done | Browser |
| P-ACCESS-37 | Done: "View a private expense" for a private context | Code; the private expenses area must test it |
| P-ACCESS-38 | Done: the preview reveals nothing about an unavailable invitation | "refuses the wrong email, revoked and expired invitations"; browser |
| P-ACCESS-39 | Done: signs out through `/api/auth/sign-out`, then opens `/sign-in?next=…`; a failure shows "Unable to sign out. Please try again." | Code; not run in the browser, because it ends the dev session |
| P-ACCESS-40, -41 | Done | Browser (Cara joined as Eli and landed on `/maple/expenses`); "binds the joiner…" |

### Join rules

| Item | Status | Proof |
| --- | --- | --- |
| P-ACCESS-42, -43 | Done | "refuses links that are not invitations from this app, and unknown tokens" |
| P-ACCESS-44 | Done | "refuses the wrong email, revoked and expired invitations" |
| P-ACCESS-45, -46 | Done (`Invalid` with the current messages) | Code |
| P-ACCESS-47, -48 | Done | "accepts a retry while still a member…" |
| P-ACCESS-49 to -51 | Done | "binds the joiner…", "lets any member leave and rejoin…", "creates an email-bound invitation…" (activity types) |
| P-ACCESS-52 | Done for the web: only verified accounts get a principal. Deferred (MCP area): the OAuth write grant | `test/db/session.test.ts` |

### Roles, removal, leaving and identity binding

| Item | Status | Proof |
| --- | --- | --- |
| P-ACCESS-53 to -57 | Done | "keeps the last admin…", "removes access at once…", "lets any member leave…"; browser |
| P-ACCESS-58, -59 | Done in `changeAccess` | Code; the private expenses area must test them |
| P-ACCESS-60 to -64 | Done | "binds a legacy member without a participant, once" |
| P-ACCESS-65 | Done: `AccessRequest` is a union with the required fields of each action | Contract |
| P-ACCESS-66 | Deferred (private expenses area): `renew_invitation` is not in `AccessRequest` | — |

## DECISIONS.md items in this area

P-GROUP-08, -21, -58, -76, -105, -106, P-ACCESS-28, -30, -33 and P-DB-73 are fixed as listed above. P-GROUP-20 and -22 are not ported. P-GROUP-91 is English only. P-TOOL-ACCESS-28 (`joined: true` for non-join actions) is unchanged in the service output, for the MCP area to decide.

## Access changes and the group revision

As in the current app, settings and people changes bump `groups.revision` and require `expectedRevision`. Membership changes (invite, join, revoke, roles, removal, leaving, binding) write their activity but do not bump the revision, so a pending settings edit does not conflict with an invitation.
