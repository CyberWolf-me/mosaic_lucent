CREATE TABLE "plans" (
	"code" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"rank" bigint DEFAULT 0 NOT NULL,
	"limits" jsonb NOT NULL,
	"price_cents" bigint,
	"annual_price_cents" bigint,
	"currency" text DEFAULT 'usd' NOT NULL,
	"stripe_price_id" text,
	"stripe_annual_price_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"org_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"seats" bigint DEFAULT 1 NOT NULL,
	"period_start" bigint,
	"period_end" bigint,
	"cancel_at" bigint,
	"trial_ends_at" bigint,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" bigint DEFAULT 1 NOT NULL,
	"at" bigint NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "usage_rollups" (
	"org_id" text NOT NULL,
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" bigint NOT NULL,
	"events" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "usage_rollups_org_id_day_kind_pk" PRIMARY KEY("org_id","day","kind")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_plans_code_fk" FOREIGN KEY ("plan") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_idx" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status","period_end");--> statement-breakpoint
CREATE INDEX "usage_events_org_kind_at_idx" ON "usage_events" USING btree ("org_id","kind","at");--> statement-breakpoint
CREATE INDEX "usage_events_at_idx" ON "usage_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "usage_rollups_day_idx" ON "usage_rollups" USING btree ("day");