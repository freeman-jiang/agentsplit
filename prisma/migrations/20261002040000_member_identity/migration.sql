-- Existing accounts and invitations remain explicitly unbound; never infer identities.
ALTER TABLE "UserGroupAccess" ADD COLUMN "participantId" TEXT;
ALTER TABLE "GroupInvitation" ADD COLUMN "participantId" TEXT, ADD COLUMN "participantName" TEXT;
CREATE UNIQUE INDEX "Participant_id_groupId_key" ON "Participant"("id", "groupId");
CREATE UNIQUE INDEX "UserGroupAccess_groupId_participantId_key" ON "UserGroupAccess"("groupId", "participantId");
ALTER TABLE "UserGroupAccess" ADD CONSTRAINT "UserGroupAccess_participantId_groupId_fkey" FOREIGN KEY ("participantId", "groupId") REFERENCES "Participant"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupInvitation" ADD CONSTRAINT "GroupInvitation_participantId_groupId_fkey" FOREIGN KEY ("participantId", "groupId") REFERENCES "Participant"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A binding survives removal/rejoining and cannot be reassigned to impersonate someone.
CREATE FUNCTION preserve_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD."participantId" IS NOT NULL AND (NEW."participantId" IS DISTINCT FROM OLD."participantId" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."groupId" IS DISTINCT FROM OLD."groupId") THEN
  RAISE EXCEPTION 'Member identity cannot be reassigned';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_member_identity BEFORE UPDATE ON "UserGroupAccess" FOR EACH ROW EXECUTE FUNCTION preserve_member_identity();
