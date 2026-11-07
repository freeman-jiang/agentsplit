-- The payer weight CHECK of 0001 has the text '^(0|[1-9][0-9]*)(\.[0-9]+)?$',
-- and db/schema/app.ts declares it with WEIGHT from src/shared/split.ts,
-- '^(0|[1-9][0-9]*)(?:\.([0-9]+))?$'. Both accept the same values, so every
-- stored row passes; this gives the database the declared text, which
-- test/db/database-rules.test.ts compares with the shared regex.
ALTER TABLE "expense_payers" DROP CONSTRAINT "expense_payers_weight_decimal";--> statement-breakpoint
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_weight_decimal" CHECK ("expense_payers"."weight" ~ '^(0|[1-9][0-9]*)(?:\.([0-9]+))?$');
