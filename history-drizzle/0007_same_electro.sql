CREATE TABLE `history_executions` (
	`generation` text NOT NULL,
	`chat_id` text NOT NULL,
	`source_id` integer NOT NULL,
	`time_ms` integer NOT NULL,
	`model_name` text NOT NULL,
	`usage_json` text,
	PRIMARY KEY(`generation`, `chat_id`, `source_id`)
);
--> statement-breakpoint
DROP TABLE history_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE history_fts USING fts5(search_text, content='history_items', content_rowid='id', tokenize='trigram');
--> statement-breakpoint
INSERT INTO history_fts(history_fts) VALUES ('rebuild');
--> statement-breakpoint
-- Metadata was present in the archive but absent from the old projection.
-- Online generations revisit turns/summaries through the existing bounded consumer.
INSERT INTO history_source_changes(generation, change_json)
SELECT generation, json_object('sourceKind', source_kind, 'sourceKey', source_key, 'chatId', chat_id, 'targetIds', json('[]'), 'taskIds', json('[]'))
FROM history_source_observations WHERE source_kind IN ('turn_responses_v2', 'compactions');
