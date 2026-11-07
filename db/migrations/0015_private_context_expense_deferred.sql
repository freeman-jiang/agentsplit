-- Ungrouped creation writes the private context and its people before the
-- expense, so the expense write checks the private rules as every later write
-- does (src/server/ungrouped.ts). The reference to the expense is checked at
-- commit instead of at the insert; it is still checked. No row changes.
ALTER TABLE "private_contexts" ALTER CONSTRAINT "private_contexts_expense_id_expenses_id_fk" DEFERRABLE INITIALLY DEFERRED;
