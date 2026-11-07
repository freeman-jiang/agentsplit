-- Group lookup and the group audit guarantee (P-GROUP-105, P-GROUP-106, P-DB-73).

-- A group reference in a URL or an API call: the group ID, its current slug
-- (case-insensitive), or a slug it used before. A current slug always wins
-- over an old one, because claiming a slug removes it from the history.
CREATE FUNCTION agentsplit_group_id(ref text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT "id" FROM "groups" WHERE "id" = ref),
    (SELECT "id" FROM "groups" WHERE "slug" = lower(ref)),
    (SELECT "group_id" FROM "group_slug_history" WHERE "slug" = lower(ref)))
$$;
--> statement-breakpoint

-- Every change to a group row is the next revision, and every revision has its
-- update_group activity with a snapshot in the same transaction, as expenses do.
CREATE FUNCTION agentsplit_check_group_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."name", NEW."slug", NEW."information", NEW."default_currency", NEW."kind", NEW."revision")
     IS NOT DISTINCT FROM (OLD."name", OLD."slug", OLD."information", OLD."default_currency", OLD."kind", OLD."revision") THEN
    RETURN NULL;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'Group edits require the next revision' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "activities" a WHERE a."group_id" = NEW."id" AND a."group_revision" = NEW."revision"
      AND a."type" = 'update_group' AND jsonb_typeof(a."snapshot") = 'object'
  ) THEN
    RAISE EXCEPTION 'Group revision must have an activity record in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "groups_revision_has_history" AFTER UPDATE ON "groups"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentsplit_check_group_revision();
