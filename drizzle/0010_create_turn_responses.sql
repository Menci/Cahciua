CREATE TABLE `turn_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`provider` text NOT NULL,
	`data` text NOT NULL,
	`session_meta` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`response_envelope` text
);
--> statement-breakpoint
CREATE INDEX `turn_responses_chat_requested_idx` ON `turn_responses` (`chat_id`,`requested_at`);
