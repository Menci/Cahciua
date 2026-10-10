-- Requeue existing media-derived output once, including targets whose pending
-- obligations were already cleared by the previous hydration implementation.
-- Only History metadata is read; normal bounded consumption repairs output/FTS.
INSERT INTO history_source_changes(generation, change_json)
SELECT dependencies.generation, json_object(
  'sourceKind', 'image_alt_texts',
  'sourceKey', dependencies.cache_key,
  'chatId', NULL,
  'targetIds', json('[]'),
  'taskIds', json('[]')
)
FROM (
  SELECT DISTINCT d.generation, d.cache_key
  FROM history_media_dependencies d
  JOIN history_consumers c ON c.generation = d.generation
) AS dependencies
ORDER BY dependencies.generation, dependencies.cache_key;
