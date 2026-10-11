CREATE TABLE `history_build_inputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_key` text NOT NULL,
	`after_id` integer DEFAULT 0 NOT NULL,
	`upper_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_build_inputs_key` ON `history_build_inputs` (`generation`,`source_kind`,`source_key`);--> statement-breakpoint
CREATE INDEX `history_build_inputs_order` ON `history_build_inputs` (`generation`,`id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_history_pending_media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_key` text NOT NULL,
	`chat_id` text,
	`scheduled_seq` integer
);
--> statement-breakpoint
INSERT INTO `__new_history_pending_media`("generation", "source_kind", "source_key", "chat_id") SELECT "generation", "source_kind", "source_key", "chat_id" FROM `history_pending_media`;--> statement-breakpoint
DROP TABLE `history_pending_media`;--> statement-breakpoint
ALTER TABLE `__new_history_pending_media` RENAME TO `history_pending_media`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `history_pending_media_key` ON `history_pending_media` (`generation`,`source_kind`,`source_key`);--> statement-breakpoint
CREATE INDEX `history_pending_media_recovery_idx` ON `history_pending_media` (`generation`,`id`);