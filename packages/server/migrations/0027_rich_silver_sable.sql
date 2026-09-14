CREATE TABLE "rate_counters" (
	"key" text NOT NULL,
	"window_start" bigint NOT NULL,
	"hits" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_counters_window_idx" ON "rate_counters" USING btree ("window_start");