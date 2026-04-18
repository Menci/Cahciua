CREATE TABLE `turn_responses_v2` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_id` text NOT NULL,
  `requested_at` integer NOT NULL,
  `entries` text NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  `model_name` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_responses_v2_chat_requested_idx`
  ON `turn_responses_v2` (`chat_id`, `requested_at`);
--> statement-breakpoint
CREATE TABLE `probe_responses_v2` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `chat_id` text NOT NULL,
  `requested_at` integer NOT NULL,
  `entries` text NOT NULL,
  `input_tokens` integer NOT NULL,
  `output_tokens` integer NOT NULL,
  `model_name` text DEFAULT '' NOT NULL,
  `is_activated` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `probe_responses_v2_chat_idx`
  ON `probe_responses_v2` (`chat_id`);
