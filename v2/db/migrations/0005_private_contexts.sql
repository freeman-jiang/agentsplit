-- Private contexts (ungrouped expenses) keep their people fixed. The app checks
-- the same rules with clear messages (src/server/ungrouped.ts); these triggers
-- are the last line of defense. Every rule raises SQLSTATE 23514.

-- A group never changes between named and private.
CREATE FUNCTION agentsplit_keep_group_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'A group cannot change between named and private' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "groups_keep_kind" BEFORE UPDATE ON "groups" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_group_kind();
--> statement-breakpoint

-- At commit, a private group has its context, and its participants, members
-- and invitations are exactly its original people. Its original expense is a
-- one-off expense shared by all of them, every other expense is a repayment,
-- and the original is deleted only after its repayments.
CREATE FUNCTION agentsplit_check_private_context(target text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  original text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "groups" WHERE "id" = target AND "kind" = 'private') THEN
    RETURN;
  END IF;
  SELECT "expense_id" INTO original FROM "private_contexts" WHERE "group_id" = target;
  IF original IS NULL THEN
    RAISE EXCEPTION 'Private group % has no private context', target USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "participants" p WHERE p."group_id" = target
      AND NOT EXISTS (SELECT 1 FROM "private_people" pp WHERE pp."group_id" = target AND pp."participant_id" = p."id"))
    OR EXISTS (SELECT 1 FROM "memberships" m WHERE m."group_id" = target
      AND NOT EXISTS (SELECT 1 FROM "private_people" pp WHERE pp."group_id" = target AND pp."participant_id" = m."participant_id"))
    OR EXISTS (SELECT 1 FROM "invitations" i WHERE i."group_id" = target
      AND NOT EXISTS (SELECT 1 FROM "private_people" pp WHERE pp."group_id" = target AND pp."participant_id" = i."participant_id" AND pp."email" = lower(i."email")))
  THEN
    RAISE EXCEPTION 'Private expense participants and accounting context cannot be reassigned' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "expenses" e WHERE e."group_id" = target AND e."deleted_at" IS NULL
      AND (e."recurrence" <> 'none' OR (e."id" = original) <> (e."kind" = 'expense')))
  THEN
    RAISE EXCEPTION 'A private context holds one one-off expense and its repayments' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "expenses" e WHERE e."id" = original AND e."deleted_at" IS NULL)
    AND (
      EXISTS (SELECT 1 FROM "private_people" pp WHERE pp."group_id" = target
        AND NOT EXISTS (SELECT 1 FROM "expense_payers" x WHERE x."expense_id" = original AND x."participant_id" = pp."participant_id")
        AND NOT EXISTS (SELECT 1 FROM "expense_shares" x WHERE x."expense_id" = original AND x."participant_id" = pp."participant_id"))
      OR EXISTS (SELECT 1 FROM (SELECT "participant_id" FROM "expense_payers" WHERE "expense_id" = original
          UNION SELECT "participant_id" FROM "expense_shares" WHERE "expense_id" = original) x
        WHERE NOT EXISTS (SELECT 1 FROM "private_people" pp WHERE pp."group_id" = target AND pp."participant_id" = x."participant_id")))
  THEN
    RAISE EXCEPTION 'The people of a private expense cannot change' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM "expenses" e WHERE e."id" = original AND e."deleted_at" IS NOT NULL)
    AND EXISTS (SELECT 1 FROM "expenses" e WHERE e."group_id" = target AND e."id" <> original AND e."deleted_at" IS NULL)
  THEN
    RAISE EXCEPTION 'Remove the repayments of a private expense before deleting it' USING ERRCODE = '23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION agentsplit_check_private_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM agentsplit_check_private_context(OLD."group_id");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM agentsplit_check_private_context(NEW."group_id");
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION agentsplit_check_private_group() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM agentsplit_check_private_context(NEW."id");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "groups_private_context" AFTER INSERT OR UPDATE ON "groups"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_group();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "participants_private_context" AFTER INSERT OR UPDATE ON "participants"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "memberships_private_context" AFTER INSERT OR UPDATE ON "memberships"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "invitations_private_context" AFTER INSERT OR UPDATE ON "invitations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expenses_private_context" AFTER INSERT OR UPDATE ON "expenses"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expense_payers_private_context" AFTER INSERT OR UPDATE OR DELETE ON "expense_payers"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "expense_shares_private_context" AFTER INSERT OR UPDATE OR DELETE ON "expense_shares"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "private_people_private_context" AFTER INSERT ON "private_people"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_private_row();
