CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` text,
	`type` text NOT NULL,
	`timestamp` integer NOT NULL,
	`message_id` integer,
	`sender_id` text,
	`text` text,
	`message_ids` text,
	`sender` text,
	`entities` text,
	`attachments` text,
	`reply_to_message_id` integer,
	`forward_info` text
);
