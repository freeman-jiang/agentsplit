CREATE TABLE "UngroupedExpense" (
  "groupId" TEXT NOT NULL PRIMARY KEY,
  "expenseId" TEXT NOT NULL UNIQUE,
  CONSTRAINT "UngroupedExpense_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UngroupedExpense_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "UngroupedPerson" (
  "participantId" TEXT NOT NULL PRIMARY KEY,
  "groupId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  CONSTRAINT "UngroupedPerson_participantId_groupId_key" UNIQUE ("participantId", "groupId"),
  CONSTRAINT "UngroupedPerson_groupId_email_key" UNIQUE ("groupId", "email"),
  CONSTRAINT "UngroupedPerson_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "UngroupedExpense"("groupId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "UngroupedPerson_participantId_groupId_fkey" FOREIGN KEY ("participantId", "groupId") REFERENCES "Participant"("id", "groupId") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "Expense_feed_order_idx" ON "Expense" ("expenseDate" DESC, "createdAt" DESC, "id" DESC);

CREATE FUNCTION protect_ungrouped_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Private expense participants and accounting context cannot be reassigned';
END;
$$;
CREATE TRIGGER protect_ungrouped_context BEFORE UPDATE OR DELETE ON "UngroupedExpense" FOR EACH ROW EXECUTE FUNCTION protect_ungrouped_context();
CREATE TRIGGER protect_ungrouped_people BEFORE UPDATE OR DELETE ON "UngroupedPerson" FOR EACH ROW EXECUTE FUNCTION protect_ungrouped_context();
