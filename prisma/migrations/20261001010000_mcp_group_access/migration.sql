ALTER TABLE "Group" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Group" ADD CONSTRAINT "Group_revision_nonnegative" CHECK ("revision" >= 0);
CREATE TABLE "UserGroupAccess" (
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserGroupAccess_pkey" PRIMARY KEY ("userId", "groupId"),
  CONSTRAINT "UserGroupAccess_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "UserGroupAccess_groupId_idx" ON "UserGroupAccess"("groupId");
ALTER TYPE "ActivityType" ADD VALUE 'CREATE_GROUP';
ALTER TYPE "ActivityType" ADD VALUE 'JOIN_GROUP';
ALTER TYPE "ActivityType" ADD VALUE 'LEAVE_GROUP';
