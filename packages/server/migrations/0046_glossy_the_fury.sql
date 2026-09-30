ALTER TABLE "boards" ADD COLUMN "public_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_public_token_idx" ON "boards" USING btree ("public_token");