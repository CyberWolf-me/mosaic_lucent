-- Enable Row Level Security (RLS) across all public tables
ALTER TABLE IF EXISTS "public"."_lucent_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."boards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."board_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."op_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."board_share_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."email_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."password_resets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."totp_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."org_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."account_deletions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."oauth_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."notification_prefs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."usage_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."board_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."presence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."stripe_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."team_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."scim_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."meeting_transcripts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."sso_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."domain_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."execution_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."integration_task_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."integration_webhook_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."integration_inbound_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."integration_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."ws_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "public"."rate_counters" ENABLE ROW LEVEL SECURITY;

-- Revoke direct PostgREST API access from anon and authenticated roles
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END $$;

-- Add primary key to scim_identities if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scim_identities_pkey'
  ) THEN
    ALTER TABLE "public"."scim_identities" ADD PRIMARY KEY ("idp", "external_id");
  END IF;
END $$;

DROP INDEX IF EXISTS "public"."scim_identities_idp_extid_uniq";

-- Create indexes for foreign keys
CREATE INDEX IF NOT EXISTS "memberships_org_idx" ON "public"."memberships" ("org_id");
CREATE INDEX IF NOT EXISTS "org_invites_invited_by_idx" ON "public"."org_invites" ("invited_by");
CREATE INDEX IF NOT EXISTS "notifications_org_idx" ON "public"."notifications" ("org_id");
CREATE INDEX IF NOT EXISTS "subscriptions_plan_idx" ON "public"."subscriptions" ("plan");
CREATE INDEX IF NOT EXISTS "presence_user_idx" ON "public"."presence" ("user_id");
CREATE INDEX IF NOT EXISTS "assets_created_by_idx" ON "public"."assets" ("created_by");
CREATE INDEX IF NOT EXISTS "team_templates_created_by_idx" ON "public"."team_templates" ("created_by");
CREATE INDEX IF NOT EXISTS "meeting_transcripts_org_idx" ON "public"."meeting_transcripts" ("org_id");
CREATE INDEX IF NOT EXISTS "meeting_transcripts_created_by_idx" ON "public"."meeting_transcripts" ("created_by");
CREATE INDEX IF NOT EXISTS "proposals_org_idx" ON "public"."proposals" ("org_id");
CREATE INDEX IF NOT EXISTS "proposals_created_by_idx" ON "public"."proposals" ("created_by");
CREATE INDEX IF NOT EXISTS "proposals_decided_by_idx" ON "public"."proposals" ("decided_by");
