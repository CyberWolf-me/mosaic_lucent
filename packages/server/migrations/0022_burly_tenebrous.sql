ALTER TABLE "integration_actions" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "integration_actions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "integration_actions" ADD COLUMN "source_seq" bigint;