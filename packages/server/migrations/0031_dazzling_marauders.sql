-- docs/27 N1: meeting notes — one person's notes on one meeting (private).
-- Hand-trimmed from drizzle-kit's output: the generated file also re-created
-- indexes and a scim_identities key that 0031_supabase_security_hardening.sql
-- already applies by hand (outside the journal), which would fail on any
-- database that ran it. Only the new table belongs here.
CREATE TABLE "meeting_notes" (
	"meeting_id" text NOT NULL,
	"user_id" text NOT NULL,
	"board_id" text NOT NULL,
	"org_id" text NOT NULL,
	"template" text NOT NULL,
	"lines" jsonb NOT NULL,
	"enhanced" jsonb,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "meeting_notes_meeting_id_user_id_pk" PRIMARY KEY("meeting_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_meeting_id_meeting_transcripts_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting_transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_notes_user_idx" ON "meeting_notes" USING btree ("user_id");--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening):
-- RLS on, and no direct PostgREST access. A table created after that
-- migration would otherwise inherit Supabase's default grants to anon.
ALTER TABLE "public"."meeting_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."meeting_notes" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."meeting_notes" FROM authenticated;
  END IF;
END $$;
