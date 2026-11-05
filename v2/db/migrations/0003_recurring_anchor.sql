-- A monthly series keeps its original day of the month (docs/v2/DECISIONS.md, P-RECUR-07).
-- Imported links take the day of their current expense; the importer does not
-- know the column, so a trigger fills it on insert when it is missing.
ALTER TABLE "recurring_links" ADD COLUMN "anchor_day" smallint;--> statement-breakpoint
UPDATE "recurring_links" l SET "anchor_day" = extract(day FROM e."expense_date") FROM "expenses" e WHERE e."id" = l."current_frame_expense_id";--> statement-breakpoint
ALTER TABLE "recurring_links" ALTER COLUMN "anchor_day" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_links" ADD CONSTRAINT "recurring_links_anchor_day" CHECK ("recurring_links"."anchor_day" BETWEEN 1 AND 31);--> statement-breakpoint
CREATE FUNCTION agentsplit_recurring_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."anchor_day" IS NULL THEN
    SELECT extract(day FROM e."expense_date") INTO NEW."anchor_day" FROM "expenses" e WHERE e."id" = NEW."current_frame_expense_id";
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "recurring_links_anchor" BEFORE INSERT ON "recurring_links" FOR EACH ROW EXECUTE FUNCTION agentsplit_recurring_anchor();
