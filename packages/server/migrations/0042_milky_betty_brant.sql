CREATE TABLE "board_team_grants" (
	"board_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "board_team_grants_board_id_team_id_pk" PRIMARY KEY("board_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_team_grants" ADD CONSTRAINT "board_team_grants_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_team_grants" ADD CONSTRAINT "board_team_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_org_idx" ON "teams" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_external_idx" ON "teams" USING btree ("org_id","external_id");--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening).
ALTER TABLE "public"."teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."board_team_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."teams", "public"."team_members", "public"."board_team_grants" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."teams", "public"."team_members", "public"."board_team_grants" FROM authenticated;
  END IF;
END $$;
