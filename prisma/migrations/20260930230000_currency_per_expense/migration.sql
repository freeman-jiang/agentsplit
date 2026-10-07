BEGIN;
-- Authorized beta ledger reset. Preserve groups, participants and categories.
-- Attachment objects and credentials are not touched.
ALTER TABLE "Expense" DISABLE TRIGGER "Expense_no_truncate";
ALTER TABLE "Activity" DISABLE TRIGGER "Activity_no_truncate";
TRUNCATE TABLE "Expense", "Activity" CASCADE;
ALTER TABLE "Expense" ENABLE TRIGGER "Expense_no_truncate";
ALTER TABLE "Activity" ENABLE TRIGGER "Activity_no_truncate";
ALTER TABLE "Expense" ADD COLUMN "currencyCode" TEXT NOT NULL;
ALTER TABLE "Expense" ALTER COLUMN "amount" TYPE NUMERIC(30,12),
  ALTER COLUMN "originalAmount" TYPE NUMERIC(30,12);
ALTER TABLE "ExpensePaidFor" ALTER COLUMN "shares" TYPE NUMERIC(30,12);
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_currency_supported" CHECK ("currencyCode" IN ('USD','EUR','JPY','BGN','CZK','DKK','GBP','HUF','PLN','RON','SEK','CHF','ISK','NOK','TRY','AUD','BRL','CAD','CNY','HKD','IDR','ILS','INR','KRW','MKD','MXN','MYR','NZD','PHP','SGD','THB','VND','ZAR','COP'));
CREATE INDEX "Expense_groupId_currencyCode_deletedAt_idx" ON "Expense"("groupId", "currencyCode", "deletedAt");
COMMIT;
