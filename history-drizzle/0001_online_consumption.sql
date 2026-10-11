CREATE TABLE `history_consume_tasks` (
	`generation` text NOT NULL,
	`task_key` text NOT NULL,
	`chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`source_key` text NOT NULL,
	PRIMARY KEY(`generation`, `task_key`)
);
--> statement-breakpoint
CREATE TABLE `history_consumers` (
	`generation` text PRIMARY KEY NOT NULL,
	`baseline_seq` integer NOT NULL,
	`reconcile_seq` integer,
	`consume_seq` integer NOT NULL,
	`pending_seq` integer,
	`baseline_complete` integer DEFAULT false NOT NULL,
	`status_json` text
);
--> statement-breakpoint
CREATE TABLE `history_media_dependencies` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`cache_key` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `message_id`, `cache_key`)
);
--> statement-breakpoint
CREATE INDEX `history_media_cache_idx` ON `history_media_dependencies` (`generation`,`cache_key`,`chat_id`,`message_id`);
--> statement-breakpoint
CREATE INDEX history_tasks_pending_idx ON history_consume_tasks(generation, done, task_key);
