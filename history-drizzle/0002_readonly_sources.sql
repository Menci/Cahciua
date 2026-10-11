CREATE TABLE `history_event_targets` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `message_id`, `received_at`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `history_observed_event_idx` ON `history_event_targets` (`generation`,`event_id`);--> statement-breakpoint
CREATE TABLE `history_source_changes` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation` text NOT NULL,
	`change_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `history_observed_changes_idx` ON `history_source_changes` (`generation`,`seq`);--> statement-breakpoint
CREATE TABLE `history_source_observations` (
	`generation` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_key` text NOT NULL,
	`source_id` integer,
	`chat_id` text,
	`revision` text NOT NULL,
	`observation_json` text NOT NULL,
	`seen_cycle` integer NOT NULL,
	`message_id` text,
	`reply_to_message_id` text,
	`task_id` integer,
	`time_ms` integer NOT NULL,
	PRIMARY KEY(`generation`, `source_kind`, `source_key`)
);
--> statement-breakpoint
CREATE INDEX `history_observed_time_idx` ON `history_source_observations` (`generation`,`source_kind`,`chat_id`,`time_ms`,`source_id`);--> statement-breakpoint
CREATE INDEX `history_observed_id_idx` ON `history_source_observations` (`generation`,`source_kind`,`chat_id`,`source_id`);--> statement-breakpoint
CREATE INDEX `history_observed_replies_idx` ON `history_source_observations` (`generation`,`chat_id`,`reply_to_message_id`,`time_ms`,`source_id`);--> statement-breakpoint
CREATE INDEX `history_observed_tasks_idx` ON `history_source_observations` (`generation`,`chat_id`,`task_id`,`time_ms`,`source_id`);--> statement-breakpoint
CREATE TABLE `history_source_scans` (
	`generation` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL
);
