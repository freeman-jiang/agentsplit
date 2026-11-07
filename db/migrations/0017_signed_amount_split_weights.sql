-- A negative amount split by amount (a refund or a reward that the group
-- shares) stores each share's amount as its weight, with the amount's sign
-- (DECISIONS.md, P-BAL-93; P-MONEY-52). The 0001 CHECK refused the sign, so
-- such a save failed although validateExpense accepts it. Payers keep the
-- unsigned rule. The new rule only adds a sign to the old one, so every stored
-- row passes it.
ALTER TABLE "expense_shares" DROP CONSTRAINT "expense_shares_weight_decimal";--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_weight_decimal" CHECK ("expense_shares"."weight" ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$');