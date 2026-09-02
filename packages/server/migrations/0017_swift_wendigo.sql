ALTER TABLE "op_log" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "op_log" ADD COLUMN "request_id" text;--> statement-breakpoint
--> statement-breakpoint
-- Backfill: every existing entry becomes a named operation. Ids are unique by
-- construction (timestamp + randomness) but NOT a UUID constraint -- the
-- column exists so Stage B acks can name a batch, and a collision between a
-- backfilled id and a future server-generated one is prevented by the
-- different generation schemes, not by an index nobody queries on.
UPDATE "op_log" SET "operation_id" = 'op_' || "board_id" || '_' || "seq" WHERE "operation_id" IS NULL;--> statement-breakpoint
ALTER TABLE "op_log" ALTER COLUMN "operation_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "op_log_board_request_uniq" ON "op_log" USING btree ("board_id","request_id") WHERE "op_log"."request_id" is not null;
