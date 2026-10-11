ALTER TABLE `events` ADD `reply_quote_content` text;--> statement-breakpoint
CREATE INDEX `events_chat_received_idx` ON `events` (`chat_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `compactions_chat_created_idx` ON `compactions` (`chat_id`,`created_at`,`id`);