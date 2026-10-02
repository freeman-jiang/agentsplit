BEGIN;

ALTER TABLE "Expense" ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Activity"
  ADD COLUMN "expenseRevision" INTEGER,
  ADD COLUMN "snapshot" JSONB,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN "actorName" TEXT,
  ADD COLUMN "actorUserId" TEXT,
  ADD COLUMN "agentKeyId" TEXT;
ALTER TABLE "Activity" ALTER COLUMN "time" SET DEFAULT clock_timestamp();

ALTER TABLE "Expense" DROP CONSTRAINT "Expense_groupId_fkey", DROP CONSTRAINT "Expense_paidById_fkey";
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpensePaidFor" DROP CONSTRAINT "ExpensePaidFor_participantId_fkey";
ALTER TABLE "ExpensePaidFor" ADD CONSTRAINT "ExpensePaidFor_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_groupId_fkey";
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Activity_expenseId_expenseRevision_key" ON "Activity"("expenseId", "expenseRevision");
CREATE INDEX "Activity_groupId_time_id_idx" ON "Activity"("groupId", "time" DESC, "id" DESC);
CREATE INDEX "Expense_groupId_deletedAt_expenseDate_idx" ON "Expense"("groupId", "deletedAt", "expenseDate" DESC);
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_revision_nonnegative" CHECK ("revision" >= 0);
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_snapshot_revision" CHECK (
  "expenseRevision" IS NULL OR ("expenseId" IS NOT NULL AND "expenseRevision" >= 0)
);

CREATE FUNCTION agentsplit_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Expense history is permanent; use soft deletion for expenses' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "Activity_append_only" BEFORE UPDATE OR DELETE ON "Activity" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_history();
CREATE TRIGGER "Activity_no_truncate" BEFORE TRUNCATE ON "Activity" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_history();
CREATE TRIGGER "Expense_no_hard_delete" BEFORE DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_history();
CREATE TRIGGER "Expense_no_truncate" BEFORE TRUNCATE ON "Expense" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_history();

CREATE FUNCTION agentsplit_check_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."deletedAt" IS NOT NULL OR NEW."revision" <> OLD."revision" + 1 OR NEW."id" <> OLD."id" OR NEW."groupId" <> OLD."groupId") THEN
    RAISE EXCEPTION 'Expense edits require the next revision and cannot edit deleted expenses' USING ERRCODE = '23514';
  END IF;
  -- Revision zero imports/old records are baselined before their first mutation.
  IF NEW."revision" > 0 AND NOT EXISTS (
    SELECT 1 FROM "Activity" a WHERE a."groupId" = NEW."groupId" AND a."expenseId" = NEW."id" AND a."expenseRevision" = NEW."revision"
      AND ((NEW."deletedAt" IS NULL AND jsonb_typeof(a."snapshot") = 'object' AND a."activityType" IN ('CREATE_EXPENSE', 'UPDATE_EXPENSE'))
        OR (NEW."deletedAt" IS NOT NULL AND a."snapshot" IS NULL AND a."activityType" = 'DELETE_EXPENSE'))
  ) THEN
    RAISE EXCEPTION 'Expense revision must have an activity record in the same transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."revision" = 0 AND NOT EXISTS (
    SELECT 1 FROM "Activity" a WHERE a."expenseId" = NEW."id" AND a."expenseRevision" = 0 AND a."snapshot" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Existing expense must have a baseline before its first edit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Expense_revision_has_history" AFTER INSERT OR UPDATE ON "Expense"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_revision();

COMMIT;
