CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"idp_entity_id" text NOT NULL,
	"acs_url" text NOT NULL,
	"x509_cert_pem" text NOT NULL,
	"name_id_format" text DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_connections_org_idp_uniq" ON "sso_connections" USING btree ("org_id","idp_entity_id");--> statement-breakpoint
CREATE TABLE "domain_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_claims_domain_uniq" ON "domain_claims" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "domain_claims_org_idx" ON "domain_claims" USING btree ("org_id");
