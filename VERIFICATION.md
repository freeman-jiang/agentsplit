# AgentSplit verification

Checked September 30, 2026. The live deployment was running commit `2a07b92`
on the Oracle server. Verification used only synthetic data in the existing
AgentSplit deployment test group.

## Verified on the live deployment

- Application, PostgreSQL 17.11, and Garage 2.4.1 containers report healthy.
- The public readiness endpoint confirms application/database connectivity.
- A synthetic PNG uploaded through the application to Garage, displayed as a
  thumbnail and full-size image, saved to an expense, and loaded after reopening.
  A direct object read returned exactly the uploaded bytes.
- Editing the test expense from $30 to $60 persisted. Balances recomputed to
  Alice +$40, Bob -$20, and Carol -$20. Statistics reflected the $60 total and
  $20 shares; the activity feed recorded the edits.
- JSON export returns a downloadable response containing the expected expense,
  participants, and activity entries. The CSV endpoint returns a downloadable
  response, but its payer balance calculation had the inherited upstream bug
  documented in `UPSTREAM_FOLLOWUPS.md`.
- Unsigned object upload and anonymous bucket listing returned HTTP 403. Upload
  CORS permits the application origin and does not grant an unrelated origin.
- Runtime environment disables Next.js/Prisma telemetry, analytics, and built-in
  AI features, while enabling receipt attachments. This verifies configuration,
  not an exhaustive network-egress audit.
- PostgreSQL and Garage data/metadata use persistent volumes; Garage's config
  mount is read-only. The PWA manifest and service-worker endpoints respond.
- No browser warnings/errors were captured during the verified flows, and recent
  application container logs contained no errors.

## Verified locally after the CSV correction

- TypeScript, formatting, production build, and diff checks passed.
- Jest: 442 tests passed in 38 suites across the two configured projects.
- Oxlint: zero errors and 20 inherited warnings.
- Four new route-level regressions cover payer credit, an excluded payer,
  minor-unit rounding, and reimbursements. They failed before the correction.

## Remaining boundaries

The CSV correction needs deployment and a live export recheck. A controlled
service restart, backup restore, JPEG/oversized-file checks, and an exhaustive
browser E2E suite have not been completed in this verification run. No remote
CI results were reported for the draft PR. Existing group-link sharing remains
Spliit's account-free bearer-link model; receipt URLs also grant read access.
