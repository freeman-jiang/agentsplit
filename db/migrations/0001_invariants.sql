-- Ledger invariants that span rows. Every rule raises SQLSTATE 23514 (check_violation).

-- Only currencies in src/shared/currencies.ts.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_currency_supported" CHECK ("currency" IN ('AUD','BGN','BRL','CAD','CHF','CNY','COP','CZK','DKK','EUR','GBP','HKD','HUF','IDR','ILS','INR','ISK','JPY','KRW','MKD','MXN','MYR','NOK','NZD','PHP','PLN','RON','SEK','SGD','THB','TRY','USD','VND','ZAR'));
--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_original_currency_supported" CHECK ("original_currency" IS NULL OR "original_currency" IN ('AUD','BGN','BRL','CAD','CHF','CNY','COP','CZK','DKK','EUR','GBP','HKD','HUF','IDR','ILS','INR','ISK','JPY','KRW','MKD','MXN','MYR','NOK','NZD','PHP','PLN','RON','SEK','SGD','THB','TRY','USD','VND','ZAR'));
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_currency_supported" CHECK ("default_currency" IN ('AUD','BGN','BRL','CAD','CHF','CNY','COP','CZK','DKK','EUR','GBP','HKD','HUF','IDR','ILS','INR','ISK','JPY','KRW','MKD','MXN','MYR','NOK','NZD','PHP','PLN','RON','SEK','SGD','THB','TRY','USD','VND','ZAR'));
--> statement-breakpoint
ALTER TABLE "expense_shares" ADD CONSTRAINT "expense_shares_weight_decimal" CHECK ("weight" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$');
--> statement-breakpoint
ALTER TABLE "expense_payers" ADD CONSTRAINT "expense_payers_weight_decimal" CHECK ("weight" ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$');
--> statement-breakpoint

-- History is permanent: activities are append-only, and expenses are deleted
-- only by tombstone (deleted_at).
CREATE FUNCTION agentsplit_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'History is permanent; expenses are deleted only by setting deleted_at' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "activities_append_only" BEFORE UPDATE OR DELETE ON "activities" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_history();
--> statement-breakpoint
CREATE TRIGGER "activities_no_truncate" BEFORE TRUNCATE ON "activities" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_history();
--> statement-breakpoint
CREATE TRIGGER "expenses_no_hard_delete" BEFORE DELETE ON "expenses" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_history();
--> statement-breakpoint
CREATE TRIGGER "expenses_no_truncate" BEFORE TRUNCATE ON "expenses" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_history();
--> statement-breakpoint

-- A revision bump also moves updated_at, which orders "recently edited or added".
CREATE FUNCTION agentsplit_touch_expense() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revision" <> OLD."revision" THEN
    NEW."updated_at" := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expenses_touch" BEFORE UPDATE ON "expenses" FOR EACH ROW EXECUTE FUNCTION agentsplit_touch_expense();
--> statement-breakpoint

-- Each edit is the next revision, a deleted expense cannot change, and every
-- revision has its activity (with a snapshot, or a null snapshot for a delete)
-- in the same transaction. Ported from the current app.
CREATE FUNCTION agentsplit_check_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD."deleted_at" IS NOT NULL OR NEW."revision" <> OLD."revision" + 1 OR NEW."id" <> OLD."id" OR NEW."group_id" <> OLD."group_id") THEN
    RAISE EXCEPTION 'Expense edits require the next revision and cannot edit deleted expenses' USING ERRCODE = '23514';
  END IF;
  IF NEW."revision" > 0 AND NOT EXISTS (
    SELECT 1 FROM "activities" a WHERE a."group_id" = NEW."group_id" AND a."expense_id" = NEW."id" AND a."expense_revision" = NEW."revision"
      AND ((NEW."deleted_at" IS NULL AND jsonb_typeof(a."snapshot") = 'object' AND a."type" IN ('create_expense', 'update_expense'))
        OR (NEW."deleted_at" IS NOT NULL AND a."snapshot" IS NULL AND a."type" = 'delete_expense'))
  ) THEN
    RAISE EXCEPTION 'Expense revision must have an activity record in the same transaction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."revision" = 0 AND NOT EXISTS (
    SELECT 1 FROM "activities" a WHERE a."expense_id" = NEW."id" AND a."expense_revision" = 0 AND a."snapshot" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Existing expense must have a baseline before its first edit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expenses_revision_has_history" AFTER INSERT OR UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_revision();
--> statement-breakpoint

-- At commit, a live expense has at least one payer and one share, and both
-- sum exactly to its amount. A deleted expense's allocations cannot change.
CREATE FUNCTION agentsplit_check_allocation(target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  e record;
  paid numeric;
  owed numeric;
  payer_count integer;
  share_count integer;
BEGIN
  SELECT "amount", "deleted_at" INTO e FROM "expenses" WHERE "id" = target;
  IF NOT FOUND OR e."deleted_at" IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(sum("amount"), 0), count(*) INTO paid, payer_count FROM "expense_payers" WHERE "expense_id" = target;
  SELECT coalesce(sum("amount"), 0), count(*) INTO owed, share_count FROM "expense_shares" WHERE "expense_id" = target;
  IF payer_count = 0 OR share_count = 0 OR paid <> e."amount" OR owed <> e."amount" THEN
    RAISE EXCEPTION 'Expense % must have payers and shares that each sum to its amount (amount %, paid %, owed %)', target, e."amount", paid, owed
      USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION agentsplit_check_expense_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM agentsplit_check_allocation(NEW."id");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION agentsplit_check_part_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
CREATE CONSTRAINT TRIGGER "expenses_allocation_balanced" AFTER INSERT OR UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_expense_allocation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expense_payers_balanced" AFTER INSERT OR UPDATE OR DELETE ON "expense_payers"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_part_allocation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expense_shares_balanced" AFTER INSERT OR UPDATE OR DELETE ON "expense_shares"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_part_allocation();
--> statement-breakpoint

-- A bound member keeps their participant, user and group. Ported from the current app.
CREATE FUNCTION agentsplit_preserve_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."participant_id" IS NOT NULL AND (NEW."participant_id" IS DISTINCT FROM OLD."participant_id" OR NEW."user_id" IS DISTINCT FROM OLD."user_id" OR NEW."group_id" IS DISTINCT FROM OLD."group_id") THEN
    RAISE EXCEPTION 'Member identity cannot be reassigned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "memberships_preserve_identity" BEFORE UPDATE ON "memberships" FOR EACH ROW EXECUTE FUNCTION agentsplit_preserve_member_identity();
--> statement-breakpoint

-- The people of a private expense are fixed. Ported from the current app.
CREATE FUNCTION agentsplit_protect_private_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Private expense participants and accounting context cannot be reassigned' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "private_contexts_fixed" BEFORE UPDATE OR DELETE ON "private_contexts" FOR EACH ROW EXECUTE FUNCTION agentsplit_protect_private_context();
--> statement-breakpoint
CREATE TRIGGER "private_people_fixed" BEFORE UPDATE OR DELETE ON "private_people" FOR EACH ROW EXECUTE FUNCTION agentsplit_protect_private_context();
--> statement-breakpoint

-- Participants are never deleted while anything refers to them; the foreign
-- keys above use ON DELETE RESTRICT. Groups are never deleted.
CREATE TRIGGER "groups_no_delete" BEFORE DELETE ON "groups" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_history();
