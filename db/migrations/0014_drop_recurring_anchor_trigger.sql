-- 0006 filled recurring_links.anchor_day on insert for the one-time importer,
-- which did not know the column. The importer is gone and the app always sets
-- the day, so the trigger and its function go. The column stays NOT NULL.
DROP TRIGGER "recurring_links_anchor" ON "recurring_links";--> statement-breakpoint
DROP FUNCTION agentsplit_recurring_anchor();
