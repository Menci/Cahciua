CREATE TABLE `history_pending_media` (
	`generation` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_key` text NOT NULL,
	`chat_id` text,
	`retry_at_ms` integer NOT NULL,
	PRIMARY KEY(`generation`, `source_kind`, `source_key`)
);
--> statement-breakpoint
CREATE INDEX `history_pending_media_due_idx` ON `history_pending_media` (`generation`,`retry_at_ms`,`source_kind`,`source_key`);--> statement-breakpoint
ALTER TABLE `history_source_observations` DROP COLUMN `seen_cycle`;