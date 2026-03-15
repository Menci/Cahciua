ALTER TABLE compactions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE compactions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
