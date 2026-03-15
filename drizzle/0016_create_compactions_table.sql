CREATE TABLE `compactions` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`old_cursor_ms` integer NOT NULL,
	`new_cursor_ms` integer NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL
);
