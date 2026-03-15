CREATE TABLE compactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  old_cursor_ms INTEGER NOT NULL,
  new_cursor_ms INTEGER NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO compactions_new (chat_id, old_cursor_ms, new_cursor_ms, summary, created_at)
  SELECT chat_id, old_cursor_ms, new_cursor_ms, summary, created_at FROM compactions;
--> statement-breakpoint
DROP TABLE compactions;
--> statement-breakpoint
ALTER TABLE compactions_new RENAME TO compactions;
--> statement-breakpoint
CREATE INDEX compactions_chat_id_idx ON compactions (chat_id);
