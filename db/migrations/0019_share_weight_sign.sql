-- 0017 let a share weight carry a sign, so that a negative amount split by
-- amount stores each share's signed amount (DECISIONS.md, P-BAL-93). The CHECK
-- cannot see the expense, so it allowed a sign in every split mode. The
-- allocation check that runs at commit (0001) now also refuses a signed share
-- weight unless the expense is split by amount and its amount is negative.
-- Assumption about the data: before 0017 no share weight had a sign, and since
-- 0017 only validateExpense, which requires exactly this, writes one.
CREATE OR REPLACE FUNCTION agentsplit_check_allocation(target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e record;
  paid numeric;
  owed numeric;
  payer_count integer;
  share_count integer;
BEGIN
  SELECT "amount", "split_mode", "deleted_at" INTO e FROM "expenses" WHERE "id" = target;
  IF NOT FOUND OR e."deleted_at" IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(sum("amount"), 0), count(*) INTO paid, payer_count FROM "expense_payers" WHERE "expense_id" = target;
  SELECT coalesce(sum("amount"), 0), count(*) INTO owed, share_count FROM "expense_shares" WHERE "expense_id" = target;
  IF payer_count = 0 OR share_count = 0 OR paid <> e."amount" OR owed <> e."amount" THEN
    RAISE EXCEPTION 'Expense % must have payers and shares that each sum to its amount (amount %, paid %, owed %)', target, e."amount", paid, owed
      USING ERRCODE = '23514';
  END IF;
  IF NOT (e."split_mode" = 'amount' AND e."amount" < 0)
    AND EXISTS (SELECT 1 FROM "expense_shares" WHERE "expense_id" = target AND "weight" LIKE '-%') THEN
    RAISE EXCEPTION 'Expense % may have a signed share weight only when a negative amount is split by amount', target
      USING ERRCODE = '23514';
  END IF;
END;
$$;
