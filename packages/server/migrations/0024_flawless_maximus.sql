CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"board_id" text,
	"org_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"dispatched_at" bigint,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_board_idx" ON "outbox_events" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_events_type_idx" ON "outbox_events" USING btree ("type","created_at");