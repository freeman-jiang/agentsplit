-- Running balances. Every balance summed all payer and share rows of its
-- group, so those tables had to stay in memory. balance_totals now holds the
-- sums per group, participant and currency, and triggers keep it in the same
-- transaction as each change of a payer or share row.
--
-- A row trigger sees only its own row, so each payer and share row keeps a
-- copy of its expense's currency and liveness. expense_state_fk keeps the copy
-- equal: a change of currency, a delete or a restore of the expense cascades
-- to its rows, and their trigger moves their amounts. This holds for every
-- write, whatever statements it uses (one statement may write the expense and
-- its rows together, as writeExpense in src/server/ledger.ts does).
--
-- Assumptions about the data: every payer and share row refers to an existing
-- expense of its group (expense_payers_expense_id_group_id_expenses_id_group_id_fk),
-- so the backfill gives each row a currency and liveness that its expense has.

ALTER TABLE "expenses" ADD COLUMN "live" boolean GENERATED ALWAYS AS (deleted_at IS NULL) STORED NOT NULL;
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_id_currency_live" UNIQUE("id","currency","live");
--> statement-breakpoint
ALTER TABLE "expense_payers" ADD COLUMN "currency" text;
--> statement-breakpoint
ALTER TABLE "expense_payers" ADD COLUMN "live" boolean;
--> statement-breakpoint
ALTER TABLE "expense_shares" ADD COLUMN "currency" text;
--> statement-breakpoint
ALTER TABLE "expense_shares" ADD COLUMN "live" boolean;
--> statement-breakpoint
-- The rule of 0001 that the rows of a deleted expense never change would refuse
-- the cascade of a delete, which sets "live" to false. It now lets through an
-- update that changes only "currency" and "live": expense_state_fk keeps them
-- equal to the expense, and the amounts, weights and people stay as they were.
CREATE OR REPLACE FUNCTION agentsplit_check_part_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."expense_id", OLD."group_id", OLD."participant_id", OLD."amount", OLD."weight")
    IS NOT DISTINCT FROM (NEW."expense_id", NEW."group_id", NEW."participant_id", NEW."amount", NEW."weight") THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM "expenses" WHERE "id" = OLD."expense_id" AND "deleted_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'A deleted expense cannot change' USING ERRCODE = '23514';
    END IF;
    PERFORM agentsplit_check_allocation(OLD."expense_id");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM agentsplit_check_allocation(NEW."expense_id");
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- The backfill updates every payer and share row, which queues the checks of
-- 0001 and 0005 that run at commit; ALTER TABLE refuses a table with queued
-- checks. So they run at the end of each statement here, then go back to the
-- end of the transaction (every deferrable rule is INITIALLY DEFERRED).
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
UPDATE "expense_payers" p SET "currency" = e."currency", "live" = e."live" FROM "expenses" e WHERE e."id" = p."expense_id";
--> statement-breakpoint
UPDATE "expense_shares" s SET "currency" = e."currency", "live" = e."live" FROM "expenses" e WHERE e."id" = s."expense_id";
--> statement-breakpoint
SET CONSTRAINTS ALL DEFERRED;
--> statement-breakpoint
ALTER TABLE "expense_payers" ALTER COLUMN "currency" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_payers" ALTER COLUMN "live" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_shares" ALTER COLUMN "currency" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_shares" ALTER COLUMN "live" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_expense_state_fk" FOREIGN KEY ("expense_id","currency","live") REFERENCES "public"."expenses"("id","currency","live") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_expense_state_fk" FOREIGN KEY ("expense_id","currency","live") REFERENCES "public"."expenses"("id","currency","live") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
CREATE TABLE "balance_totals" (
	"group_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"currency" text NOT NULL,
	"paid" bigint NOT NULL,
	"owed" bigint NOT NULL,
	"parts" integer NOT NULL,
	CONSTRAINT "balance_totals_group_id_participant_id_currency_pk" PRIMARY KEY("group_id","participant_id","currency"),
	CONSTRAINT "balance_totals_parts_positive" CHECK ("balance_totals"."parts" > 0)
);
--> statement-breakpoint

-- Adds one payer or share row to the totals (sign 1) or takes it away (sign -1).
-- Taking away a row that the totals do not hold is an error: the totals are out
-- of step, and the write must fail instead of storing a wrong balance.
CREATE FUNCTION agentsplit_move_balance(g text, p text, c text, d_paid bigint, d_owed bigint, sign integer) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF sign = 1 THEN
    INSERT INTO "balance_totals" AS t ("group_id", "participant_id", "currency", "paid", "owed", "parts") VALUES (g, p, c, d_paid, d_owed, 1)
    ON CONFLICT ("group_id", "participant_id", "currency")
    DO UPDATE SET "paid" = t."paid" + excluded."paid", "owed" = t."owed" + excluded."owed", "parts" = t."parts" + 1;
    RETURN;
  END IF;
  UPDATE "balance_totals" SET "paid" = "paid" - d_paid, "owed" = "owed" - d_owed, "parts" = "parts" - 1
  WHERE "group_id" = g AND "participant_id" = p AND "currency" = c AND "parts" > 1;
  IF FOUND THEN
    RETURN;
  END IF;
  -- The last row of this participant and currency: what is left must be exactly this row.
  DELETE FROM "balance_totals" WHERE "group_id" = g AND "participant_id" = p AND "currency" = c AND "parts" = 1 AND "paid" = d_paid AND "owed" = d_owed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance_totals is out of step with the payers and shares of group % (participant %, currency %)', g, p, c;
  END IF;
END;
$$;
--> statement-breakpoint

-- The row trigger of expense_payers (TG_ARGV[0] = 'paid') and expense_shares ('owed').
CREATE FUNCTION agentsplit_count_balance_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payer boolean := TG_ARGV[0] = 'paid';
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."live" AND NEW."live"
    AND (OLD."group_id", OLD."participant_id", OLD."currency") = (NEW."group_id", NEW."participant_id", NEW."currency") THEN
    IF NEW."amount" <> OLD."amount" THEN
      UPDATE "balance_totals"
      SET "paid" = "paid" + CASE WHEN payer THEN NEW."amount" - OLD."amount" ELSE 0 END,
          "owed" = "owed" + CASE WHEN payer THEN 0 ELSE NEW."amount" - OLD."amount" END
      WHERE "group_id" = NEW."group_id" AND "participant_id" = NEW."participant_id" AND "currency" = NEW."currency";
      IF NOT FOUND THEN
        RAISE EXCEPTION 'balance_totals is out of step with the payers and shares of group % (participant %, currency %)', NEW."group_id", NEW."participant_id", NEW."currency";
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD."live" THEN
    PERFORM agentsplit_move_balance(OLD."group_id", OLD."participant_id", OLD."currency",
      CASE WHEN payer THEN OLD."amount" ELSE 0 END, CASE WHEN payer THEN 0 ELSE OLD."amount" END, -1);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."live" THEN
    PERFORM agentsplit_move_balance(NEW."group_id", NEW."participant_id", NEW."currency",
      CASE WHEN payer THEN NEW."amount" ELSE 0 END, CASE WHEN payer THEN 0 ELSE NEW."amount" END, 1);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expense_payers_balance" AFTER INSERT OR DELETE OR UPDATE OF "group_id", "participant_id", "amount", "currency", "live" ON "expense_payers"
  FOR EACH ROW EXECUTE FUNCTION agentsplit_count_balance_part('paid');
--> statement-breakpoint
CREATE TRIGGER "expense_shares_balance" AFTER INSERT OR DELETE OR UPDATE OF "group_id", "participant_id", "amount", "currency", "live" ON "expense_shares"
  FOR EACH ROW EXECUTE FUNCTION agentsplit_count_balance_part('owed');
--> statement-breakpoint

-- TRUNCATE fires no row trigger, so it would leave the totals behind.
CREATE FUNCTION agentsplit_keep_balance_parts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payers, shares and balance_totals are never truncated: the running balances count every row' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expense_payers_no_truncate" BEFORE TRUNCATE ON "expense_payers" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_balance_parts();
--> statement-breakpoint
CREATE TRIGGER "expense_shares_no_truncate" BEFORE TRUNCATE ON "expense_shares" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_balance_parts();
--> statement-breakpoint
CREATE TRIGGER "balance_totals_no_truncate" BEFORE TRUNCATE ON "balance_totals" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_balance_parts();
--> statement-breakpoint

-- The totals of the rows that exist now: what ledgerParts in src/server/balances.ts summed before.
INSERT INTO "balance_totals" ("group_id", "participant_id", "currency", "paid", "owed", "parts")
SELECT "group_id", "participant_id", "currency", sum("paid"), sum("owed"), count(*)
FROM (
  SELECT "group_id", "participant_id", "currency", "amount" AS "paid", 0::bigint AS "owed" FROM "expense_payers" WHERE "live"
  UNION ALL
  SELECT "group_id", "participant_id", "currency", 0::bigint, "amount" FROM "expense_shares" WHERE "live"
) parts
GROUP BY "group_id", "participant_id", "currency";
