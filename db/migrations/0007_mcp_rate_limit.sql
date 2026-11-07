-- The MCP request budget, one token bucket per user, shared by every API key
-- and OAuth connection of that user and by every Worker isolate. The current
-- app kept it in process memory (P-MCP-85); a Worker has no shared memory.
CREATE TABLE "mcp_rate_limits" (
  "user_id" text PRIMARY KEY NOT NULL,
  -- Fractional: the bucket refills continuously.
  "tokens" double precision NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  -- Whether the latest request took a token. RETURNING sees only the new row,
  -- so the statement records its decision here.
  "allowed" boolean NOT NULL
);
