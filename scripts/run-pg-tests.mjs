import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

function getDatabaseUrl() {
  for (const envPath of [".env", "packages/server/.env"]) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      const match = content.match(/^LUCENT_DATABASE_URL=(.+)$/m);
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return undefined;
}

const dbUrl = getDatabaseUrl();
if (!dbUrl) {
  console.error("LUCENT_DATABASE_URL not found in .env");
  process.exit(1);
}

console.log("Found PostgreSQL URL. Executing PostgreSQL-backed test suites with LUCENT_TEST_DATABASE_URL...");
const env = { ...process.env, LUCENT_TEST_DATABASE_URL: dbUrl };

try {
  execSync("npx vitest run test/pg-store.test.ts test/pg-bootstrap.test.ts test/pg-workspace-spine.test.ts test/canonical-commit-authority.test.ts test/proposal-policy-risk.test.ts test/fanout-multiworker-all-categories.test.ts --fileParallelism=false --testTimeout=60000 --hookTimeout=60000", {
    cwd: "packages/server",
    stdio: "inherit",
    env,
  });
  console.log("\nPostgreSQL-backed suite executed successfully!");
} catch (err) {
  console.error("\nPostgreSQL-backed test suite failed:", err.message);
  process.exit(err.status || 1);
}
