-- The value lists of src/shared/vocabulary.ts for the three columns that had no CHECK.
-- It assumes every stored row holds a listed value: groups and expenses were only ever
-- written as named/private and expense/payment, and activity sources by the current app
-- (web, agent, system, baseline) or by early v2 (mcp). A row with another value stops the
-- migration, so the server does not start; nothing is changed then.
ALTER TABLE "activities" ADD CONSTRAINT "activities_source" CHECK ("activities"."source" IN ('web', 'agent', 'system', 'baseline', 'mcp'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_kind" CHECK ("expenses"."kind" IN ('expense', 'payment'));--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_kind" CHECK ("groups"."kind" IN ('named', 'private'));