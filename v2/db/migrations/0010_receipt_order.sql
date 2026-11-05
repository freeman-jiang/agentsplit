-- An expense lists its receipts in the order they were attached, as in the
-- current app. Existing rows take the table's physical order: the current app
-- reads its receipts in that order, and the importer and v2 inserted them in it.
ALTER TABLE "expense_documents" ADD COLUMN "position" integer;--> statement-breakpoint
UPDATE "expense_documents" d SET "position" = o."position"
  FROM (SELECT ctid, (row_number() OVER (PARTITION BY "expense_id" ORDER BY ctid) - 1)::integer AS "position" FROM "expense_documents") o
  WHERE d.ctid = o.ctid;--> statement-breakpoint
ALTER TABLE "expense_documents" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "expense_documents" ADD CONSTRAINT "expense_documents_expense_position" UNIQUE("expense_id","position");
