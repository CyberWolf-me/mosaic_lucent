CREATE TABLE "board_snapshots" (
	"board_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"workspace" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "board_snapshots_board_id_seq_pk" PRIMARY KEY("board_id","seq")
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"board_id" text NOT NULL,
	"user_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"cursor" jsonb,
	"selection" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "presence_board_id_user_id_pk" PRIMARY KEY("board_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "presence_updated_idx" ON "presence" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "op_log_board_at_idx" ON "op_log" USING btree ("board_id","at");