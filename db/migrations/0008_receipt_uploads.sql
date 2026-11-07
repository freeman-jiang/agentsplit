-- Agent upload targets (P-RECEIPT-32 to 44). The Worker cannot presign S3 URLs
-- for R2 without S3 credentials, so an agent PUTs once to a Worker route with a
-- single-use secret, and update_expense attaches the stored image.
CREATE TABLE "receipt_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"expense_id" text NOT NULL,
	"key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_uploads_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "receipt_uploads_key_unique" UNIQUE("key"),
	CONSTRAINT "receipt_uploads_content_type" CHECK ("receipt_uploads"."content_type" IN ('image/jpeg', 'image/png')),
	CONSTRAINT "receipt_uploads_bytes" CHECK ("receipt_uploads"."bytes" BETWEEN 1 AND 5242880),
	CONSTRAINT "receipt_uploads_state" CHECK ("receipt_uploads"."state" IN ('pending', 'writing', 'stored') AND ("receipt_uploads"."state" = 'stored') = ("receipt_uploads"."uploaded_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "receipt_uploads" ADD CONSTRAINT "receipt_uploads_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_uploads" ADD CONSTRAINT "receipt_uploads_expense_id_expenses_id_fk" FOREIGN KEY ("expense_id") REFERENCES "public"."expenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_uploads_created_at_index" ON "receipt_uploads" USING btree ("created_at");