-- Backfill content column for events persisted before content parsing was implemented.
-- These rows have text but no content; synthesize a single text ContentNode.
UPDATE `events`
SET `content` = json_array(json_object('type', 'text', 'text', `text`))
WHERE `content` IS NULL AND `text` IS NOT NULL;
