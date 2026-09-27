ALTER TABLE "meeting_transcripts" ADD COLUMN "scheduled_for" bigint;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "duration_min" bigint;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "invitees" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "cancelled_at" bigint;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;