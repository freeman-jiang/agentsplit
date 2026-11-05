# Parity record: account, sign-in, settings, PWA and agent setup

This file records the [PARITY.md](../PARITY.md) items of the account area. `account.test` is `v2/test/db/account.test.ts`. `session.test` is `v2/test/db/session.test.ts`. "Browser" means a check on the dev server (port 5185) or on the production build under `vite preview`, on 2026-11-05, with a minted session on synthetic data. A browser check is manual, not an automated test.

## Status legend

- **Done**: implemented, with the proof named.
- **Changed**: implemented with an approved change from [DECISIONS.md](../DECISIONS.md).
- **Other area**: the item belongs to another area. The reason is given.
- **Deferred**: not implemented. The reason is given.

## Auth (P-AUTH)

| Item | Status | Proof or reason |
| --- | --- | --- |
| 01 Google only, openid/email/profile | Done | `auth.ts`; account.test "is checked by the server too" checks the scope set in the Google URL. Better Auth repeats the scopes, as the current app does. |
| 02 "Google sign-in is not configured" | Done | `createAuth`; account.test "refuses incomplete configuration" |
| 03 Auth exceptions return 503 | Changed (G) | The Worker returns 503 `{"error":"Sign-in is temporarily unavailable"}` with `no-store` only for real exceptions, and logs the cause. Better Auth answers client errors itself with 4xx. |
| 04–08 Telemetry off, trusted origin, no account linking, 7-day session with 1-day refresh, no cookie cache | Done | Unchanged `createAuth` options; session.test |
| 09 Rate limit stored in the database | Done | account.test checks that `rate_limit` rows appear after a sign-in start |
| 10 Unverified session is signed out | Done | session.test |
| 11 RPC without a principal fails | Done | Core `requirePrincipal` (`Unauthorized`) |
| 12 POST from another origin returns 403 | Done | `worker.ts`: `/api/rpc` POST needs `Origin` = `BASE_URL` origin. Browser: curl with `Origin: https://evil.example` got 403 `{"error":"Origin not allowed"}`. |
| 13 `Cache-Control: private, no-store` on RPC | Done | `worker.ts` |
| 14 RPC accepts only the browser session | Done | `session.ts` reads the cookie only |
| 15–20, 22, 72, 73 Group access, roles and audit actor | Other area | Groups and ledger areas (`requireMember`) |
| 21 OAuth scopes on RPC | Other area | MCP area: RPC has no OAuth principals |
| 23–27 Owner bootstrap | Done | `bootstrapOwner` runs from Better Auth's session-create hook, so once per sign-in and never on a session lookup. account.test "owner bootstrap" covers email rules, claimed groups only, the one-time marker, the advisory lock under concurrency, and a failure that does not block sign-in. |
| 28–29 Import of legacy `MCP_ACCESS_GRANTS` keys | Deferred | Production ran this import already. The importer copies the resulting `apikey` rows and the `auth_bootstrap` marker, so v2 never runs it. |
| 30 Bootstrap error breaks every page | Changed (G) | A bootstrap failure is logged and sign-in continues (account.test "never blocks sign-in when it fails"). |
| 31–33 Key prefix `agentsplit_`, no expiry, 120 per 60 s | Done | account.test "creates keys through Better Auth with the current prefix, rate limit and owner" |
| 34 A key cannot create a key | Done | account.test "refuses to create a key with a key instead of a session" |
| 35 A key is not a browser session | Done | Same test (`getSession` with `x-api-key` returns null) |
| 36 New key owned by the signed-in user | Done | account.test (`referenceId`) |
| 37 A user cannot revoke another user's key | Done | account.test "revokes only the caller's own key" |
| 38 A revoked key fails | Done | Same test (`verifyApiKey` false after revoke). The MCP 401 path is in the MCP area. |
| 39–47 Key header parsing and key use on MCP, exports and receipts | Other area | MCP, export and receipt areas |
| 48 Signed-out visits redirect to `/sign-in` | Done for `/settings/**` and `/agents` | Browser. `/groups` and group pages use their areas' guards; see open item 1. |
| 49 Sign-in keeps the destination | Changed (C) | `requireSignedIn` passes `next`; browser: `/settings` → `/sign-in?next=%2Fsettings` → back to `/settings` after sign-in. Other areas' guards must adopt it (open item 1). |
| 50 Non-member redirect | Other area | Groups area |
| 51 Public pages | Done | `/`, `/sign-in`, `/privacy` and `/api/health*` need no session. `/` belongs to the feed area. |
| 52–54 Sign-in texts, invitation variant, `prompt=select_account` | Done | Browser: both variants at 320 and 1280 px. |
| 55 `next` validation | Changed (B) | `safeNextPath` on the client, and a Better Auth `before` hook on the server that refuses unsafe `callbackURL`, `errorCallbackURL` and `newUserCallbackURL`. Better Auth 1.7.14 alone accepted `/\evil.example` (200); the hook makes it 403. account.test "keeps same-origin paths" and "is checked by the server too". |
| 56–57 Login error alert, "Opening Google…" | Done | `sign-in.tsx`. Browser: the button reached accounts.google.com, which refused the placeholder client as expected. |
| 58 Signed-in visit to `/sign-in` | Changed (C) | Redirects to `next` or `/`, except for an OAuth authorize resume (`sig` in the query). Browser. |
| 59–62 Signed-out landing page | Other area | Feed/dashboard area owns `/` |
| 63–66 Header, Workspace navigation, avatar initials | Done | Shared shell from the lead; browser shows "AE" for "Alice Q. Example". |
| 67–68 Sign out | Done | Browser: the session row is deleted, `recentGroups` is removed, and the page goes to `/sign-in`. |
| 69–71 Fixed identity in expenses and groups | Other area | Expenses and groups areas |

## Settings/profile (P-SETTINGS)

| Item | Status | Proof or reason |
| --- | --- | --- |
| 01–03 Page, title, connected-apps link, name and email | Done | Browser |
| 04–07 Display name rules and output | Done | account.test "profile". The RPC payload is a plain struct: extra fields are ignored, and the server uses only the principal's user ID, so a forged `userId` changes nothing. MCP strictness (06) is in the MCP area. |
| 08 Unverified account refused | Done | account.test "refuses an unverified account" |
| 09 OAuth write scope for profile | Other area | MCP area |
| 10–11 Save status and error alert | Done | Browser (status text after save; all queries are read again) |
| 12–14 Account name replaces bound participant names | Deferred | The ledger reads show stored participant names. The read path in `ledger.ts` (groups/ledger area) must overlay `user.name` for verified bound members. See open item 2. |
| 15 Rename leaves history unchanged | Done | `updateProfile` writes only `user.name`; snapshots and activity rows are not touched. |
| 16–18 Theme select | Done | `public/theme.js` applies the theme before the first paint; browser: Dark persists across a reload. |
| 19 Language menu | Changed (F) | English only. |
| 20–26 API key form, shown-once key, list, revoke, empty state, errors, `/agents` link | Done | Browser: create shows the key once (prefix `agentsplit_`, 75 characters), the list shows "agents… · Created", revoke asks for confirmation, then "No agent keys yet." |
| 27 No overflow at 320/488/1280 | Done | Browser at 320 and 1280 px |

## PWA/misc (P-PWA, the parts that are not translation)

| Item | Status | Proof or reason |
| --- | --- | --- |
| 01–02 Manifest | Done | `public/manifest.webmanifest` |
| 03 Theme color, Apple web-app tags, icons | Done | `index.html`; the current app's favicon, SVG icon and Apple icon are copied to `public/`. |
| 04 Generated iOS splash images | Deferred | They need a client script that draws the splash images. iOS falls back to the background color. This is low value and can follow. |
| 05–12 Service worker | Done | `public/sw.js` now caches Vite's `/assets/` instead of `/_next/static/`, in `agentsplit-static-v4`. `src/client/pwa.ts` registers it in production builds, with the update toast and the hourly and on-focus update checks. Browser: the production build registers it and is controlled. The offline page's button script is now a file, for the CSP. |
| 13–16 Frame, nosniff, referrer and permissions headers | Done | `security.ts` on Worker responses and `public/_headers` on the SPA page and files. Browser: `vite preview` sends them on `/settings`. |
| 17 CSP | Changed (B) | `script-src 'self'`, no inline or eval. account.test checks that `_headers` and the Worker use the same policy. Browser: the production build runs with no CSP errors. |
| 18–19 Storage origin in the CSP | Changed | Receipts are served from this origin (`/api/receipts`, R2 behind the Worker), so the CSP needs no storage origin. |
| 20 Server actions | Changed | Not applicable: the SPA has no server actions. The RPC origin check (P-AUTH-12) covers the same risk. |
| 21–26 Legacy `/groups/<id>` redirects and slug routing | Other area | Groups area |
| 27, 29, 30 Health, readiness and liveness | Done | `worker.ts` and `security.ts`; account.test "reports a database failure without its cause"; browser curl. |
| 28 Readiness leaks database errors | Changed (B) | A generic body; the cause goes to the log. |
| 31 robots.txt | Changed (G) | Allows `/`, `/privacy` and `/sign-in` and disallows everything else, because top-level group slugs cannot be listed. Rendered by the Worker with `BASE_URL`. |
| 32 sitemap.xml | Done | Rendered by the Worker with `BASE_URL` |
| 33 Page titles | Done | `usePageTitle`, "%s · AgentSplit"; default "AgentSplit · Shared expenses, simply settled" |
| 34 Open Graph and Twitter tags | Done | `index.html` |
| 35 Footer | Done | Shared shell from the lead |
| 36 Error boundary | Other area | The shared root error component belongs to the lead |
| 37–44, 46 Environment flags, analytics and exchange rates | Changed | Not applicable to v2: the Worker has no such flags, and v2 has no analytics or rate lookups. |
| 45 Analytics path anonymization | Changed | Not applicable: no analytics |
| 47 Telemetry off | Done | Better Auth telemetry is off; v2 has no Next.js or Prisma. |
| 48 `postinstall` migrates | Changed (A) | v2 has no `postinstall`. |
| 49 Perf headers | Deferred | The perf suite is not ported yet. |
| 50–56 Translations | Changed (F) | English only |

## MCP items in this area (P-MCP)

| Item | Status | Proof or reason |
| --- | --- | --- |
| 50, 55, 57 Key prefix, revocation, no minting | Done | See P-AUTH-31 to 38 |
| 45–49, 51–54, 56 Key verification on MCP | Other area | MCP area |
| 79 One 401 challenge format | Other area | MCP area: the challenge is built by the MCP endpoint |
| 92, 93, 95 Protected-resource metadata, GET and HEAD | Done | `worker.ts` routes `/.well-known/*` to Better Auth; account.test "OAuth discovery"; browser curl |
| 94, 96–101 Authorization-server metadata | Done | account.test "serves the authorization-server metadata" |
| 102–128 Token, refresh, PKCE, DCR and CIMD behavior | Other area | MCP area. Browser: DCR of a native loopback client, authorize, consent and the redirect to the client worked end to end. |
| 129–133 Connection revocation | Changed | The SPA calls the RPC procedure `account.revokeConnection` instead of `POST /api/connections/revoke`. The RPC path keeps the origin check (P-AUTH-12) and the session check. account.test "revokes with a tombstone and deletes the tokens and consent". |
| 134–136 Revoked tokens fail; API keys stay; no revival | Other area | MCP area (token checks). account.test shows the API keys stay. |
| 137–139 RFC 7009 revoke, delete-consent and UserInfo wrapping | Other area | MCP area. The current app wraps these in its auth route; the MCP task must add them in `worker.ts` around Better Auth. |
| 140 Auth exception 503 | Done | See P-AUTH-03 |
| 141–150 Consent page | Done | `settings.connections.consent.tsx`. Browser: a real authorize request opened "Connect Probe Agent to AgentSplit" with the signed query intact. With "Allow changes" unchecked, the stored consent had no `agentsplit:write`, and the browser went to the client's redirect URI. |
| 151 No overflow at 390 and 1280 px | Partly checked | Browser at 1280 px only; 390 px is not checked yet |
| 152–157 Connected apps page | Done | account.test "lists unrevoked, consented clients once"; browser: list, "Read and manage your groups", revoke with confirmation, then "No connected apps yet." |
| 158 Connection order | Changed (G) | Newest connection first, then client ID (account.test) |
| 159–171 `/agents` | Done | Browser: title, endpoint, five copy buttons, snippets hidden until opened, no overflow at 320 px. The text is the current app's English text. |
| 172 Localization | Changed (F) | English only |
| P-TOOL-PROFILE-02, 03, 05, 06, 08 | Done (domain) | `updateProfile`, which the `update_profile` tool must call. Tool advertisement and scope checks are in the MCP area. |

## Open items

1. **Destination after sign-in in other areas.** `/groups`, `/$group` and `/` still redirect to `/sign-in` without `next`. They must use `requireSignedIn` from `src/client/queries/account.ts`.
2. **Account names in group views (P-SETTINGS-12 to 14).** The ledger read queries must show `user.name` for a participant bound to a verified account.
3. **Agent instructions.** `/agents` keeps the current instructions text. When the MCP task changes tool names or adds the PLAN.md guidance (record the full payment, include the payer in paidFor, put the calculation in notes), it must update the text in `agents.tsx`.
4. **Localhost cookies in development.** Browsers share cookies across ports on `localhost`. Another local app's `better-auth.session_token` made Better Auth and `session.ts` choose different cookies in the default browser profile. Use a private window for dev checks. Production uses one host and the `__Secure-` name.
