ALTER TABLE "op_log" ADD COLUMN "actor_type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "op_log" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "op_log" ADD COLUMN "initiated_by" text;--> statement-breakpoint
ALTER TABLE "op_log" ADD COLUMN "approved_by" text;--> statement-breakpoint
--> statement-breakpoint
-- Backfill the actor model onto every pre-Stage-B row: each was a human edit
-- by whoever the `by` column already records (the connection's user, stamped
-- server-side since M0.4 — never a client claim), who also initiated it, and
-- nothing was review-gated. AI-authored history predates the model and reads
-- more honestly as the human who ran the meeting; no row claims `ai`.
UPDATE "op_log" SET "actor_id" = "by", "initiated_by" = "by" WHERE "actor_id" IS NULL;--> statement-breakpoint
ALTER TABLE "op_log" ALTER COLUMN "actor_id" SET NOT NULL;
