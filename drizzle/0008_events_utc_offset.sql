-- Add UTC offset column for timezone-aware timestamp rendering.
-- Backfill with +08:00 (480 minutes) — the bot's timezone during initial operation.
ALTER TABLE `events` ADD COLUMN `utc_offset_min` INTEGER NOT NULL DEFAULT 480;
