UPDATE `users` SET `is_premium` = 0 WHERE `is_premium` IS NULL;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text,
	`username` text,
	`is_bot` integer NOT NULL,
	`is_premium` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "first_name", "last_name", "username", "is_bot", "is_premium", "updated_at") SELECT "id", "first_name", "last_name", "username", "is_bot", "is_premium", "updated_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;
