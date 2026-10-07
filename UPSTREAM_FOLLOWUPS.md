# Spliit upstream follow-ups

## CSV payer balance correction

Deferred: prepare a standalone reproduction and fix PR for `spliit-app/spliit`.
The bug was confirmed in the fork base `936adbc` and current upstream `main` on
September 30, 2026. AgentSplit's original CSV route matched upstream unchanged.

Reproduction:

1. Create a USD group with Alice, Bob, and Carol.
2. Record a $60 expense paid by Alice and split evenly between all three.
3. The balances page correctly shows Alice +$40, Bob -$20, and Carol -$20.
4. Export CSV. Upstream exports Alice +$20, Bob -$20, and Carol -$20.

Cause: the export gives the payer their own share as positive instead of crediting
the amount paid minus that share. When the payer is excluded from the split,
their payment is omitted entirely.

The AgentSplit correction computes each participant's net change in minor units:
`(amount paid by participant) - (participant's apportioned share)`.

Keep the upstream PR limited to the CSV route and its regression tests. Cover
three-way splits, payers excluded from the split, minor-unit rounding, and
reimbursements. The tests demonstrated the failures before the correction and
pass afterward. AgentSplit-specific deployment and privacy changes are separate.
