CREATE TABLE `messages` (
	`chat_id` text NOT NULL,
	`message_id` integer NOT NULL,
	`sender_id` text,
	`date` integer NOT NULL,
	`edit_date` integer,
	`text` text,
	`entities` text,
	`reply_to_message_id` integer,
	`reply_to_top_id` integer,
	`forward_info` text,
	`media_group_id` text,
	`via_bot_id` text,
	`attachments` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_chat_message_idx` ON `messages` (`chat_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text,
	`username` text,
	`is_bot` integer NOT NULL,
	`is_premium` integer,
	`updated_at` integer NOT NULL
);
