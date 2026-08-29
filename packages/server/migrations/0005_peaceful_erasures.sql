CREATE TABLE "account_deletions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"requested_at" bigint NOT NULL,
	"executes_at" bigint NOT NULL,
	"cancelled_at" bigint
);
--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;