CREATE TABLE `history_chat_states` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`title` text,
	PRIMARY KEY(`generation`, `chat_id`)
);
--> statement-breakpoint
CREATE TABLE `history_checkpoints` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`upper_id` integer NOT NULL,
	`after_json` text,
	`scan_complete` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `source_kind`)
);
--> statement-breakpoint
CREATE TABLE `history_generations` (
	`generation` text PRIMARY KEY NOT NULL,
	`projection_version` integer NOT NULL,
	`archive_identity` text NOT NULL,
	`render_identity` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `history_message_revisions` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`source_json` text NOT NULL,
	`archive_revision` text NOT NULL,
	`parent_revision` text,
	`revision` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `message_id`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `history_message_states` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`message_id` text NOT NULL,
	`state_json` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `history_notices` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`event_id` integer NOT NULL,
	`notice_json` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `history_relations` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`from_key` text NOT NULL,
	`to_key` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `from_key`, `to_key`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `history_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`item_key` text NOT NULL,
	`kind` text NOT NULL,
	`time_ms` integer NOT NULL,
	`source_order` integer NOT NULL,
	`source_id` integer NOT NULL,
	`entry_index` integer NOT NULL,
	`part_index` integer NOT NULL,
	`item_json` text NOT NULL,
	`search_text` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_items_key` ON `history_items` (`generation`,`chat_id`,`item_key`);--> statement-breakpoint
CREATE INDEX `history_items_timeline` ON `history_items` (`generation`,`chat_id`,`time_ms`,`source_order`,`source_id`,`entry_index`,`part_index`);--> statement-breakpoint
CREATE TABLE `history_task_starts` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`task_id` integer NOT NULL,
	`tool_key` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `task_id`, `tool_key`)
);
--> statement-breakpoint
CREATE TABLE `history_user_states` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state_json` text NOT NULL,
	PRIMARY KEY(`generation`, `chat_id`, `user_id`)
);
--> statement-breakpoint
CREATE VIRTUAL TABLE history_fts USING fts5(search_text, content='history_items', content_rowid='id');
--> statement-breakpoint
CREATE TRIGGER history_items_ai AFTER INSERT ON history_items BEGIN
  INSERT INTO history_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER history_items_ad AFTER DELETE ON history_items BEGIN
  INSERT INTO history_fts(history_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
--> statement-breakpoint
CREATE TRIGGER history_items_au AFTER UPDATE ON history_items BEGIN
  INSERT INTO history_fts(history_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
  INSERT INTO history_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
