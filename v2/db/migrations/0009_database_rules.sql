-- Database rules that the parity audit found missing (docs/v2/parity/AUDIT.md,
-- "Nobody can see these yet"). The production data obeys every rule, so no row
-- changes. The migrator applies all new migrations in one transaction, so
-- NOT VALID followed by VALIDATE would not shorten a lock. These tables are
-- small, and the scans take milliseconds.

-- References without foreign keys (DECISIONS.md group C: P-DB-61, P-DB-65,
-- P-DB-93, P-DB-117, P-DB-127). Activities are append-only, so a referenced
-- expense or participant cannot be removed (RESTRICT). Ledger rows keep their
-- user (RESTRICT). Credentials end with their user or client (CASCADE), as
-- Better Auth's own session and token rows do.
ALTER TABLE "activities" ADD CONSTRAINT "activities_expense_fk" FOREIGN KEY ("expense_id","group_id") REFERENCES "public"."expenses"("id","group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_participant_fk" FOREIGN KEY ("participant_id","group_id") REFERENCES "public"."participants"("id","group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_links" ADD CONSTRAINT "recurring_links_expense_group_fk" FOREIGN KEY ("current_frame_expense_id","group_id") REFERENCES "public"."expenses"("id","group_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_connections" ADD CONSTRAINT "oauth_connections_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Value lists. The current app uses PostgreSQL enums (P-DB-42, P-DB-47,
-- P-DB-77). A role is admin or member (DECISIONS.md group A, P-DB-95).
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_split_mode" CHECK ("expenses"."split_mode" IN ('evenly', 'shares', 'percentage', 'amount'));--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurrence" CHECK ("expenses"."recurrence" IN ('none', 'daily', 'weekly', 'monthly'));--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_type" CHECK ("activities"."type" IN ('create_group', 'join_group', 'leave_group', 'update_group', 'create_expense', 'update_expense', 'delete_expense'));--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role" CHECK ("memberships"."role" IN ('admin', 'member'));--> statement-breakpoint

-- Unique keys of the current schema (P-DB-115, P-DB-116, P-DB-121). Without
-- the first, a race can link one Google account to two users. The unique key
-- on apikey.key replaces its plain index.
ALTER TABLE "account" ADD CONSTRAINT "account_providerId_accountId_unique" UNIQUE("provider_id","account_id");--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_key_unique" UNIQUE("key");--> statement-breakpoint
DROP INDEX "apikey_key_index";--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_clientId_resourceId_unique" UNIQUE("client_id","resource_id");--> statement-breakpoint

-- Balances and expense lists for one currency (P-DB-49).
CREATE INDEX "expenses_group_currency" ON "expenses" USING btree ("group_id","currency","deleted_at");--> statement-breakpoint

-- Receipts are permanent: history shows a receipt after its removal from an
-- expense (DECISIONS.md group G, P-DB-70). The app only inserts receipt rows.
CREATE FUNCTION agentsplit_keep_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Receipts are permanent; history refers to them' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "receipts_immutable" BEFORE UPDATE OR DELETE ON "receipts" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_receipts();
--> statement-breakpoint
CREATE TRIGGER "receipts_no_truncate" BEFORE TRUNCATE ON "receipts" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_receipts();
