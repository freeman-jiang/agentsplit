ALTER TABLE "Group" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");
ALTER TABLE "Expense" ADD COLUMN "vendor" TEXT;
