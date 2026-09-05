CREATE TABLE "execution_ledger" (
	"board_id" text NOT NULL,
	"provider" text NOT NULL,
	"request_id" text NOT NULL,
	"lucent_action_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text NOT NULL,
	"attempts" bigint NOT NULL,
	"error" text,
	"began_at" bigint NOT NULL,
	"applied_at" bigint,
	"external_id" text,
	CONSTRAINT "execution_ledger_board_id_provider_request_id_pk" PRIMARY KEY("board_id","provider","request_id")
);
--> statement-breakpoint
CREATE TABLE "integration_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text NOT NULL,
	"status" text NOT NULL,
	"items" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"applied_at" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text NOT NULL,
	"credential_ref" text NOT NULL,
	"config" jsonb,
	"scopes" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_task_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"board_id" text NOT NULL,
	"node_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"last_synced_status" text NOT NULL,
	"synced_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_actions" ADD CONSTRAINT "integration_actions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_task_links" ADD CONSTRAINT "integration_task_links_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_ledger_sweep_idx" ON "execution_ledger" USING btree ("status","began_at");--> statement-breakpoint
CREATE INDEX "integration_actions_pending_idx" ON "integration_actions" USING btree ("board_id","provider","status");--> statement-breakpoint
CREATE INDEX "integration_actions_board_idx" ON "integration_actions" USING btree ("board_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_org_provider_uniq" ON "integration_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_task_links_node_provider_uniq" ON "integration_task_links" USING btree ("board_id","node_id","provider");--> statement-breakpoint
CREATE INDEX "integration_task_links_board_idx" ON "integration_task_links" USING btree ("board_id");