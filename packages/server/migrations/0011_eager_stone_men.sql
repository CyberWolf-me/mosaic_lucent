CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"storage_key" text NOT NULL,
	"thumb_key" text,
	"width" bigint,
	"height" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"org_id" text,
	"livemode" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"received_at" bigint NOT NULL,
	"processed_at" bigint
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_org_checksum_idx" ON "assets" USING btree ("org_id","checksum");--> statement-breakpoint
CREATE INDEX "assets_board_idx" ON "assets" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "assets_created_idx" ON "assets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stripe_events_status_idx" ON "stripe_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "stripe_events_org_idx" ON "stripe_events" USING btree ("org_id");