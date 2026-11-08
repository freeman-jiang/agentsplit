import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./db/schema/app.ts', './db/schema/auth.ts'],
  out: './db/migrations',
  casing: 'snake_case',
  // generate reads no database. The commands that do use DATABASE_URL, and never default to the maintainer's agentsplit_dev (docs/BUILDING.md).
  ...(process.env['DATABASE_URL'] ? { dbCredentials: { url: process.env['DATABASE_URL'] } } : {}),
})
