-- Fair-use limits (src/shared/limits.ts): receipt sizes for the storage
-- quota, permanent receipt deletion, and the per-user write budget. Adding a
-- column with a constant default rewrites no row and fires no trigger, so the
-- receipts and the history stay as they are. Receipts stored before this
-- migration keep bytes = 0 and count against no quota; they were about 10 MB
-- in production, and the receipts trigger (0009) stays as it is.
CREATE TABLE "deleted_receipts" (
	"receipt_id" text PRIMARY KEY NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "bytes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deleted_receipts" ADD CONSTRAINT "deleted_receipts_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_receipts" ADD CONSTRAINT "deleted_receipts_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipts_created_by_index" ON "receipts" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_bytes_nonnegative" CHECK ("receipts"."bytes" >= 0);
--> statement-breakpoint

-- A deletion is permanent: its object is gone, so the receipt can never come
-- back. Only the purge time may be set, once, when storage confirms the removal.
CREATE FUNCTION agentsplit_keep_receipt_deletions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."purged_at" IS NULL AND NEW."purged_at" IS NOT NULL
      AND (NEW."receipt_id", NEW."deleted_by", NEW."deleted_at") IS NOT DISTINCT FROM (OLD."receipt_id", OLD."deleted_by", OLD."deleted_at") THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'A receipt deletion is permanent' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "deleted_receipts_permanent" BEFORE UPDATE OR DELETE ON "deleted_receipts" FOR EACH ROW EXECUTE FUNCTION agentsplit_keep_receipt_deletions();
--> statement-breakpoint
CREATE TRIGGER "deleted_receipts_no_truncate" BEFORE TRUNCATE ON "deleted_receipts" FOR EACH STATEMENT EXECUTE FUNCTION agentsplit_keep_receipt_deletions();
--> statement-breakpoint

-- The write budget per user (LIMITS.writesPerMinute), shared by the web app
-- and every agent credential of that user: a token bucket in the shape of
-- mcp_rate_limits (0007), so restarts do not reset it.
CREATE TABLE "write_rate_limits" (
  "user_id" text PRIMARY KEY NOT NULL,
  "tokens" double precision NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "allowed" boolean NOT NULL
);
