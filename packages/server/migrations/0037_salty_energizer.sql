CREATE TABLE "ai_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text,
	"initiated_by" text,
	"surface" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"context_scope" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_hash" text,
	"op_count" bigint DEFAULT 0 NOT NULL,
	"proposal_id" text,
	"op_seqs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" text,
	"created_at" bigint NOT NULL,
	"decided_at" bigint
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "statement_index" ADD COLUMN "trust" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_org_idx" ON "ai_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_board_idx" ON "ai_runs" USING btree ("board_id","created_at");--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening):
-- RLS on, and no direct PostgREST access. Only the server's role reads it.
ALTER TABLE "public"."ai_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."ai_runs" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."ai_runs" FROM authenticated;
  END IF;
END $$;
