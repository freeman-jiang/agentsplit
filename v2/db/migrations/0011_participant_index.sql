-- Deleting a participant makes the RESTRICT foreign key of 0009 look for its
-- activities. This index finds them without a scan of the activities table.
-- The unique key of 0010 on (expense_id, position) also finds the receipts of
-- an expense, so the index on expense_id alone is not necessary.
DROP INDEX "expense_documents_expense_id_index";--> statement-breakpoint
CREATE INDEX "activities_participant_id_group_id_index" ON "activities" USING btree ("participant_id","group_id") WHERE "activities"."participant_id" IS NOT NULL;