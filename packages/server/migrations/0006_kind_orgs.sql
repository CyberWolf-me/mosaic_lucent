-- M2.1 — every board lives in exactly one org.
--
-- The backfill is the delicate part: existing boards have no org_id, and
-- we can't ADD COLUMN ... NOT NULL without a value. The fix is to create
-- one org per distinct owner, attach the existing user-to-org memberships
-- (if any) to those orgs, and then point the boards at them.
--
-- The runner (src/db/migrate.ts) wraps every migration file in a single
-- transaction, so a half-applied backfill cannot land. This file must not open
-- its own: a nested BEGIN merely warns, but the inner COMMIT would close the
-- runner's transaction early and let the _lucent_migrations insert escape it.

ALTER TABLE "boards" ADD COLUMN "org_id" text;
--> statement-breakpoint

-- 1. Create a personal org per distinct owner who doesn't already have a row
--    that we can reuse. The org id is deterministic from the user id so a
--    re-run of the migration (e.g. on a partially-applied DB) is a no-op.
INSERT INTO "organizations" ("id", "name", "created_at")
SELECT
  'org_personal_' || "owner_id",
  COALESCE(NULLIF(u.name, ''), 'Personal') || '''s workspace',
  COALESCE(EXTRACT(EPOCH FROM NOW())::bigint * 1000, 0)
FROM (SELECT DISTINCT "owner_id" FROM "boards") b
LEFT JOIN "users" u ON u.id = b."owner_id"
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- 2. Make sure the personal-org owner has an owner membership. If the user
--    already belongs to some other org, that membership is unaffected; we
--    only insert the personal-org membership when it's missing.
INSERT INTO "memberships" ("user_id", "org_id", "role")
SELECT "owner_id", 'org_personal_' || "owner_id", 'owner'
FROM (SELECT DISTINCT "owner_id" FROM "boards") b
ON CONFLICT ("user_id", "org_id") DO NOTHING;
--> statement-breakpoint

-- 3. Point every board at its owner's personal org. Idempotent: a re-run
--    writes the same value.
UPDATE "boards" SET "org_id" = 'org_personal_' || "owner_id" WHERE "org_id" IS NULL;
--> statement-breakpoint

-- 4. Lock the column down: NOT NULL + FK + index. Errors here mean the
--    backfill above missed a row; the migration aborts rather than landing
--    in a half-state.
ALTER TABLE "boards" ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "boards_org_idx" ON "boards" USING btree ("org_id", "updated_at" DESC);
