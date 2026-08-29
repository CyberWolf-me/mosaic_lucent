import { defineConfig } from "drizzle-kit";

/**
 * Drizzle-kit config. Migrations are emitted as plain SQL into ./migrations
 * and committed to the repo, so the boot path stays "git clone && run" and CI
 * never has to invoke a codegen step. The connection URL is only used by
 * `drizzle-kit generate`; applying migrations is db/migrate.ts's job, which
 * uses its own Pool and its own ledger table. Do not use `drizzle-kit migrate`
 * against a Lucent database - see the ledger note in db/migrate.ts for why.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.LUCENT_DATABASE_URL ?? "postgres://lucent:lucent@localhost:5432/lucent",
  },
  verbose: true,
  strict: true,
});
