-- docs/27 N1: meeting notes — one person's notes on one meeting (private).
-- Hand-trimmed from drizzle-kit's output: the generated file also re-created
-- indexes and a scim_identities key that 0031_supabase_security_hardening.sql
-- already applies by hand (outside the journal), which would fail on any
-- database that ran it. Only the new table belongs here.
--
-- Renamed from 0031_dazzling_marauders (2026-09-27). Two files shared the id
-- "0031", and the runner keys its ledger by that id: a fresh database failed
-- on the second one, and a database that had run the Supabase hardening as
-- 0031 (production) would have skipped this file for good — no notes table.
-- "0031a" is its own id and still sorts between 0031 and 0032. Every
-- statement is idempotent, because a development database created on this
-- branch before the rename already has the table under the old id.
CREATE TABLE IF NOT EXISTS "meeting_notes" (
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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_meeting_id_meeting_transcripts_id_fk') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_meeting_id_meeting_transcripts_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meeting_transcripts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_user_id_users_id_fk') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_board_id_boards_id_fk') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'meeting_notes_org_id_organizations_id_fk') THEN
    ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meeting_notes_user_idx" ON "meeting_notes" USING btree ("user_id");--> statement-breakpoint
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
