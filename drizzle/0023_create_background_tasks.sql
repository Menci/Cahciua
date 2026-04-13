ALTER TABLE `events` ADD `runtime_data` text;
--> statement-breakpoint
CREATE TABLE `background_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`type_name` text NOT NULL,
	`intention` text,
	`timeout_ms` integer NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`params` text NOT NULL,
	`checkpoint` text,
	`started_ms` integer NOT NULL,
	`last_updated_ms` integer NOT NULL,
	`final_summary` text,
	`full_output_path` text
);
--> statement-breakpoint
CREATE INDEX `background_tasks_session_idx` ON `background_tasks` (`session_id`);
--> statement-breakpoint
CREATE INDEX `background_tasks_completed_idx` ON `background_tasks` (`completed`);
