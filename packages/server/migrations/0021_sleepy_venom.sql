CREATE TABLE "integration_inbound_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text NOT NULL,
	"provider" text NOT NULL,
	"node_id" text NOT NULL,
	"external_id" text NOT NULL,
	"field" text NOT NULL,
	"external_value" text NOT NULL,
	"mapped_value" text,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"detected_at" bigint NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"applied_seq" bigint,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "integration_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"org_id" text,
	"external_id" text,
	"status" text NOT NULL,
	"attempts" bigint NOT NULL,
	"error" text,
	"claimed_at" bigint NOT NULL,
	"received_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_inbound_changes" ADD CONSTRAINT "integration_inbound_changes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_inbound_changes_board_idx" ON "integration_inbound_changes" USING btree ("board_id","status");--> statement-breakpoint
CREATE INDEX "integration_inbound_changes_pending_idx" ON "integration_inbound_changes" USING btree ("board_id","node_id","provider","field","status");--> statement-breakpoint
CREATE INDEX "integration_webhook_events_sweep_idx" ON "integration_webhook_events" USING btree ("status","claimed_at");