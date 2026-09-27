CREATE TABLE "project_boards" (
	"project_id" text NOT NULL,
	"board_id" text NOT NULL,
	"added_by" text,
	"added_at" bigint NOT NULL,
	CONSTRAINT "project_boards_project_id_board_id_pk" PRIMARY KEY("project_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"objective" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lead_id" text,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"archived_at" bigint
);
--> statement-breakpoint
CREATE TABLE "statement_index" (
	"board_id" text NOT NULL,
	"node_id" text NOT NULL,
	"org_id" text NOT NULL,
	"ord" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"label" text NOT NULL,
	"topic" text,
	"supersedes" jsonb,
	"assignee" text,
	"due_date" text,
	"execution_status" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"drives_actions" bigint,
	"meeting_id" text,
	"turn_start" bigint,
	"turn_end" bigint,
	CONSTRAINT "statement_index_board_id_node_id_pk" PRIMARY KEY("board_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "statement_index_state" (
	"board_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"source_at" bigint NOT NULL,
	"indexed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boards" ADD CONSTRAINT "project_boards_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_lead_id_users_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_index" ADD CONSTRAINT "statement_index_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_index_state" ADD CONSTRAINT "statement_index_state_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_boards_board_idx" ON "project_boards" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "projects_org_idx" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "statement_index_org_kind_idx" ON "statement_index" USING btree ("org_id","kind","status");--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening):
-- RLS on, and no direct PostgREST access, so these tables never inherit
-- Supabase's default grants to anon. Only the server's role reads them.
ALTER TABLE "public"."projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."project_boards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."statement_index" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."statement_index_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."projects", "public"."project_boards", "public"."statement_index", "public"."statement_index_state" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."projects", "public"."project_boards", "public"."statement_index", "public"."statement_index_state" FROM authenticated;
  END IF;
END $$;
