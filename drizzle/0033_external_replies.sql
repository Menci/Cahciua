ALTER TABLE `events` ADD `reply_quote_content` text;--> statement-breakpoint
ALTER TABLE `events` ADD `external_reply` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `reply_quote` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `external_reply` text;