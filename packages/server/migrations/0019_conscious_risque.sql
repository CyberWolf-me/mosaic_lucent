CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text NOT NULL,
	"meeting_id" text,
	"status" text NOT NULL,
	"operations" jsonb NOT NULL,
	"request" text NOT NULL,
	"explanation" text,
	"provenance" jsonb,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"applied_seq" bigint
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_board_pending_uniq" ON "proposals" USING btree ("board_id") WHERE "proposals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "proposals_board_idx" ON "proposals" USING btree ("board_id","created_at");