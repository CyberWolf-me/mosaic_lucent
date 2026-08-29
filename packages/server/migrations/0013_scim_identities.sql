CREATE TABLE "scim_identities" (
	"idp" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scim_identities" ADD CONSTRAINT "scim_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scim_identities_idp_extid_uniq" ON "scim_identities" USING btree ("idp","external_id");--> statement-breakpoint
CREATE INDEX "scim_identities_user_idx" ON "scim_identities" USING btree ("user_id");
