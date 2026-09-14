CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"run_after" bigint NOT NULL,
	"claimed_by" text,
	"claimed_at" bigint,
	"result" jsonb,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"finished_at" bigint,
	"dedupe_key" text
);
--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("family","status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_idx" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_worker_idx" ON "jobs" USING btree ("claimed_by","status");