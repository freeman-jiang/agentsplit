CREATE TABLE "LegacyGroupClaim" ("groupId" TEXT NOT NULL PRIMARY KEY);
INSERT INTO "LegacyGroupClaim" ("groupId") SELECT "id" FROM "Group" WHERE NOT EXISTS (SELECT 1 FROM "UserGroupAccess" a JOIN "User" u ON u.id=a."userId" WHERE a."groupId"="Group".id AND a.active);
