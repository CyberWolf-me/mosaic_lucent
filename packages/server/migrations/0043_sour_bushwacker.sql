CREATE TABLE "board_trash" (
	"board_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trash_items" (
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text,
	"name" text NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" bigint NOT NULL,
	CONSTRAINT "trash_items_kind_item_id_pk" PRIMARY KEY("kind","item_id")
);
--> statement-breakpoint
ALTER TABLE "board_trash" ADD CONSTRAINT "board_trash_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_items" ADD CONSTRAINT "trash_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_trash_org_idx" ON "board_trash" USING btree ("org_id","deleted_at");--> statement-breakpoint
CREATE INDEX "trash_items_org_idx" ON "trash_items" USING btree ("org_id","deleted_at");--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening).
ALTER TABLE "public"."board_trash" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "public"."trash_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."board_trash", "public"."trash_items" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."board_trash", "public"."trash_items" FROM authenticated;
  END IF;
END $$;
