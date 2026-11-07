-- No change to the database. The rate-limit tables (0007, 0012) and the
-- currency and weight CHECKs (0001) were written in SQL only; db/schema/app.ts
-- now declares them, and this migration records them in drizzle-kit's
-- snapshot, so drizzle-kit generate compares the whole schema. A database at
-- 0015 already has every object exactly as declared.
SELECT 1;
