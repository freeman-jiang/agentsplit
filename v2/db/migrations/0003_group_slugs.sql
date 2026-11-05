CREATE TABLE "group_slug_history" (
	"slug" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "group_revision" integer;--> statement-breakpoint
ALTER TABLE "group_slug_history" ADD CONSTRAINT "group_slug_history_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_slug_history_group_id_index" ON "group_slug_history" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_group_revision" UNIQUE("group_id","group_revision");