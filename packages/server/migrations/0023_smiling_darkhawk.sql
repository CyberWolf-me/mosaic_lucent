CREATE TABLE "ws_tickets" (
	"ticket" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ws_tickets_expiry_idx" ON "ws_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ws_tickets_user_idx" ON "ws_tickets" USING btree ("user_id");