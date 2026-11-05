# Browser-visible differences between the current app and v2

Each image puts the current app (`bb26b78`, run from the `tooling` build at `3409dde`, which has the same app code) on the left and v2 (`862a01a`) on the right. Both apps ran locally on 2026-11-05 with the same synthetic data: the current app's write functions created it, and `v2/scripts/import-legacy.ts` copied it into v2. No production data was used. The source is [AUDIT.md](../AUDIT.md), "People in the browser can see these".

- [1-landing-login.png](1-landing-login.png): P-AUTH-59, P-AUTH-60. Current "Log In" opens Google sign-in at once. v2 "Log In" goes to `/sign-in`, which needs a second click.
- [2-expense-cancel-from-dashboard.png](2-expense-cancel-from-dashboard.png), [2-current.mp4](2-current.mp4), [2-v2.mp4](2-v2.mp4): P-EXP-40, P-EXP-41, P-EXP-49. Not reproduced. In both apps, an expense opened from the dashboard returns to the dashboard on Cancel.
- [3-receipt-thumbnail.png](3-receipt-thumbnail.png): P-RECEIPT-06. Current opens a carousel over all receipts. v2 opens one image, and lists the receipts in the reverse order.
- [4-revision-share-weights.png](4-revision-share-weights.png): P-HIST-72. For a by-amount split, current shows "share 30" and v2 shows "share 30.00".
- [5-unknown-url.png](5-unknown-url.png): P-GROUP-101, P-GROUP-102, P-PWA-25, P-PWA-26. Current answers 404. v2 lands on `/groups?access=denied`.
- [6-group-urls.png](6-group-urls.png): P-GROUP-98, P-GROUP-100, P-PWA-21, P-PWA-23. A group without a slug is at `/groups/<id>/expenses` in current and `/<id>/expenses` in v2. `/household` stays in current and becomes `/household/expenses` in v2.
- [7a-search-matches-notes.png](7a-search-matches-notes.png): P-EXP-11. v2's expense search finds an expense by its notes. Current does not.
- [7b-private-form-default-split.png](7b-private-form-default-split.png): P-UNGROUP-15. Current's private expense form shows "Save as default splitting options". v2 hides it.
