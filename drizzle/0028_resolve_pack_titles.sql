-- Backfill resolved sticker pack titles for attachments persisted before
-- ingress-time resolution. Rows where stickerSetName === stickerSetId got
-- the fallback when ingress couldn't reach the pack; pull a real title from
-- any sibling row that did resolve. Anything still unresolved becomes
-- "unknown" since the new code path no longer falls back to the raw id.

CREATE TEMP TABLE _resolved_pack_titles AS
SELECT
  json_extract(att.value, '$.stickerSetId') AS set_id,
  json_extract(att.value, '$.stickerSetName') AS title
FROM events, json_each(events.attachments) AS att
WHERE json_extract(att.value, '$.stickerSetId') IS NOT NULL
  AND json_extract(att.value, '$.stickerSetName') IS NOT NULL
  AND json_extract(att.value, '$.stickerSetName') != json_extract(att.value, '$.stickerSetId')
GROUP BY set_id;
--> statement-breakpoint
CREATE INDEX _resolved_pack_titles_set_id ON _resolved_pack_titles (set_id);
--> statement-breakpoint
UPDATE events
SET attachments = (
  SELECT json_group_array(json(
    CASE
      WHEN json_extract(att.value, '$.stickerSetId') IS NOT NULL
        AND json_extract(att.value, '$.stickerSetName') = json_extract(att.value, '$.stickerSetId')
      THEN json_set(
        att.value,
        '$.stickerSetName',
        COALESCE(
          (SELECT title FROM _resolved_pack_titles WHERE set_id = json_extract(att.value, '$.stickerSetId')),
          'unknown'
        )
      )
      ELSE att.value
    END
  ))
  FROM json_each(events.attachments) AS att
)
WHERE attachments IS NOT NULL AND EXISTS (
  SELECT 1 FROM json_each(events.attachments) AS att
  WHERE json_extract(att.value, '$.stickerSetId') IS NOT NULL
    AND json_extract(att.value, '$.stickerSetName') = json_extract(att.value, '$.stickerSetId')
);
--> statement-breakpoint
DROP TABLE _resolved_pack_titles;
