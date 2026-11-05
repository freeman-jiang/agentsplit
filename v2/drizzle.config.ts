import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./db/schema/app.ts', './db/schema/auth.ts'],
  out: './db/migrations',
  casing: 'snake_case',
  dbCredentials: { url: process.env['DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:5437/agentsplit_dev' },
})
