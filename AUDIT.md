# Preserved expense revisions

AgentSplit uses the existing Expense and Activity tables. Expense stores the
current state plus `revision` and `deletedAt`. Activity stores one complete,
schema-versioned JSON snapshot for each create/edit revision. Deletion adds a
marker without duplicating the last snapshot. No diff library, event replay,
new service, or additional table is needed.

## One backend write path

The form and tRPC collect/validate inputs; authoritative validation, group
membership of payers/beneficiaries, writes, and auditing live in `src/lib/api.ts`.
These functions validate the same schemas even when called outside tRPC.
`withGroupWrite` in `src/lib/expense-history.ts` acquires a PostgreSQL group lock
inside a transaction, then runs the write. Small-scale group writes serialize
so an edit, deletion, rename, or recurring job cannot race the captured state.
All ordinary and recurring creation uses `createExpenseRevision`; creation and
editing use the same `recordExpenseSnapshot` serializer. Deletion and group
updates also write their events inside their transactions. All web and MCP write
tools call these functions.

Snapshots preserve the actual persisted amount, payer, beneficiary IDs/names,
shares, split rule, dates, category, original amount/currency/exchange rate,
recurrence, notes, and receipt references, plus the group's name/currency.
The history UI compares adjacent snapshots using the existing exact split
calculator; current balances continue using current, non-deleted expenses.

## Deletion and retention

- Expense deletion sets `deletedAt`, advances the revision, and writes an event.
  It stops that frame's future recurrence and hides it from normal reads,
  statistics, balances, and exports. Its row and previous snapshots remain.
- PostgreSQL triggers block Activity updates/deletions/truncation and hard
  Expense deletion/truncation. A deferred constraint requires every nonzero
  expense revision to have its event in the same transaction. Updates must
  advance the revision; deleted expenses cannot be silently edited/restored.
- Restrictive foreign keys prevent removing a referenced participant/group
  from cascading away expense rows or history. Participant/group renames remain
  possible and cannot rewrite historical JSON names/currency.
- Existing expenses start at revision zero. Before their first edit/delete,
  the transaction records their current state as a baseline. Old summaries
  cannot recover changes made before this protection existed. Revision-zero
  manual imports retain that same legacy/baseline behavior.

Receipt snapshots store pointers, not copies of image files. Recurring frames
copy small document-reference rows while sharing the same underlying URLs.
Keep the Garage objects and storage-host URLs stable, back them up, and make any
future garbage collector respect references in historical snapshots. A saved
URL does not independently guarantee the object survives storage loss.

## Identity and administration

Historical anonymous participant labels remain unverified. New web writes take
actor identity from the verified account session; MCP writes take it from the
user-owned key. Participant selections cannot override the authenticated actor. Automated
recurring creations are marked `source: "system"`. Baselines are marked
`source: "baseline"` so their timestamps cannot be mistaken for creation dates.

This protects normal application operations, not a PostgreSQL administrator who
can disable triggers or rewrite the database. Keep independent backups. Schema
maintenance must preserve history; normal reset/delete commands will now fail
instead of erasing records. The activity feed is available through the web UI,
filtered/paginated `list_activity`, and the JSON export.

## Verification

`scripts/test-expense-history.ts` exercises real PostgreSQL transactions and
refuses non-loopback databases or names not ending in `_audit_test`. Use an
isolated disposable database, apply migrations, then provide its URL as
`POSTGRES_PRISMA_URL` when invoking the script with Bun. The runner creates only
synthetic records; cleanup is by discarding the test database/container, since
the history guards correctly prohibit deleting individual test records.

## Historical queries

`get_expense` can select a saved revision or recorded-time boundary.
`list_expenses` and `get_balances` can reconstruct state at that boundary.
`list_activity` supports precise recorded-time filters and chronological order.
Reuse returned activity boundaries for stable pagination while other users write.
See `MCP.md` for input/output contracts and legacy-coverage limits.

Activity now carries an internal monotonic integer for deterministic boundaries,
including events sharing a timestamp. The additive migration assigns ordering
metadata to existing events without changing their snapshots, actors or timestamps.
Application history update/delete protections remain enabled after migration.
No history read materializes recurrence or writes any state.
