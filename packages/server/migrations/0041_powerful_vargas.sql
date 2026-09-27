CREATE TABLE "integration_credentials" (
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" bigint,
	"scope" text,
	"obtained_by" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "integration_credentials_org_id_provider_pk" PRIMARY KEY("org_id","provider")
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The same hardening every other table got (0031_supabase_security_hardening):
-- RLS on, and no direct PostgREST access. These rows hold sealed OAuth
-- tokens; only the server's role reads them, and only to open them.
ALTER TABLE "public"."integration_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "public"."integration_credentials" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "public"."integration_credentials" FROM authenticated;
  END IF;
END $$;
