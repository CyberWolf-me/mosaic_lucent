DROP INDEX "jobs_dedupe_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'claimed');