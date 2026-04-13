CREATE TEMP TABLE _backfill_chat AS
SELECT tr.id,
  json_group_array(json(
    CASE
      WHEN json_extract(entry.value, '$.role') = 'tool'
           AND json_extract(entry.value, '$.requiresFollowUp') IS NULL
      THEN json_set(
        entry.value,
        '$.requiresFollowUp',
        CASE
          WHEN COALESCE(
            (SELECT json_extract(tc.value, '$.function.name')
             FROM json_each(COALESCE(json_extract(json_extract(tr.data, '$[0]'), '$.tool_calls'), '[]')) AS tc
             WHERE json_extract(tc.value, '$.id') = json_extract(entry.value, '$.tool_call_id')
            ), ''
          ) != 'send_message' THEN 1
          ELSE 0
        END
      )
      ELSE entry.value
    END
  )) AS new_data
FROM turn_responses AS tr,
     json_each(tr.data) AS entry
WHERE tr.provider = 'openai-chat'
  AND json_array_length(tr.data) > 1
  AND EXISTS (
    SELECT 1 FROM json_each(tr.data) AS e
    WHERE json_extract(e.value, '$.role') = 'tool'
      AND json_extract(e.value, '$.requiresFollowUp') IS NULL
  )
GROUP BY tr.id;
--> statement-breakpoint
UPDATE turn_responses
SET data = (SELECT new_data FROM _backfill_chat WHERE _backfill_chat.id = turn_responses.id)
WHERE id IN (SELECT id FROM _backfill_chat);
--> statement-breakpoint
DROP TABLE _backfill_chat;
--> statement-breakpoint
CREATE TEMP TABLE _backfill_resp AS
SELECT tr.id,
  json_group_array(json(
    CASE
      WHEN json_extract(entry.value, '$.type') = 'function_call_output'
           AND json_extract(entry.value, '$.requiresFollowUp') IS NULL
      THEN json_set(
        entry.value,
        '$.requiresFollowUp',
        CASE
          WHEN COALESCE(
            (SELECT json_extract(fc.value, '$.name')
             FROM json_each(tr.data) AS fc
             WHERE json_extract(fc.value, '$.type') = 'function_call'
               AND json_extract(fc.value, '$.call_id') = json_extract(entry.value, '$.call_id')
            ), ''
          ) != 'send_message' THEN 1
          ELSE 0
        END
      )
      ELSE entry.value
    END
  )) AS new_data
FROM turn_responses AS tr,
     json_each(tr.data) AS entry
WHERE tr.provider = 'responses'
  AND EXISTS (
    SELECT 1 FROM json_each(tr.data) AS e
    WHERE json_extract(e.value, '$.type') = 'function_call_output'
      AND json_extract(e.value, '$.requiresFollowUp') IS NULL
  )
GROUP BY tr.id;
--> statement-breakpoint
UPDATE turn_responses
SET data = (SELECT new_data FROM _backfill_resp WHERE _backfill_resp.id = turn_responses.id)
WHERE id IN (SELECT id FROM _backfill_resp);
--> statement-breakpoint
DROP TABLE _backfill_resp;
