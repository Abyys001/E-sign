ALTER TABLE "contracts" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "contracts_search_trgm" ON "contracts" USING gin ("search_text" gin_trgm_ops);