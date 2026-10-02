BEGIN;
-- Preserve all historical contents. Assign ordering metadata to pre-existing rows
-- under an exclusive migration lock, then use a sequence for future events.
ALTER TABLE "Activity" ADD COLUMN "sequence" INTEGER;
ALTER TABLE "Activity" DISABLE TRIGGER "Activity_append_only";
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY time, "groupId", "expenseId" NULLS FIRST, "expenseRevision" NULLS FIRST, id)::INTEGER AS position FROM "Activity")
UPDATE "Activity" a SET "sequence" = ordered.position FROM ordered WHERE a.id = ordered.id;
ALTER TABLE "Activity" ENABLE TRIGGER "Activity_append_only";
CREATE SEQUENCE "Activity_sequence_seq" AS INTEGER OWNED BY "Activity"."sequence";
SELECT setval('"Activity_sequence_seq"', COALESCE((SELECT MAX("sequence") FROM "Activity"),1), EXISTS(SELECT 1 FROM "Activity"));
ALTER TABLE "Activity" ALTER COLUMN "sequence" SET DEFAULT nextval('"Activity_sequence_seq"');
ALTER TABLE "Activity" ALTER COLUMN "sequence" SET NOT NULL;
CREATE UNIQUE INDEX "Activity_sequence_key" ON "Activity"("sequence");
CREATE INDEX "Activity_groupId_sequence_idx" ON "Activity"("groupId", "sequence" DESC);
COMMIT;
