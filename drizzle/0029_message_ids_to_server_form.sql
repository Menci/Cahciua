-- Switch canonical message-id form from TDLib internal (server_id << 20) to
-- raw MTProto server id. After the tdl refactor (a03d178) ingress started
-- writing internal ids; older rows still hold server ids. Detect tdlib-form
-- by id % 1048576 == 0 (server messages have all-zero low 20 bits in TDLib's
-- encoding) and divide. False-positive risk: a true server id that's
-- coincidentally a multiple of 2^20 — ~1 in 10^6, negligible for our chats.

UPDATE messages
SET message_id = message_id / 1048576
WHERE message_id > 0 AND message_id % 1048576 = 0;
--> statement-breakpoint
UPDATE messages
SET reply_to_message_id = reply_to_message_id / 1048576
WHERE reply_to_message_id IS NOT NULL
  AND reply_to_message_id > 0
  AND reply_to_message_id % 1048576 = 0;
--> statement-breakpoint
UPDATE messages
SET reply_to_top_id = reply_to_top_id / 1048576
WHERE reply_to_top_id IS NOT NULL
  AND reply_to_top_id > 0
  AND reply_to_top_id % 1048576 = 0;
--> statement-breakpoint
UPDATE messages
SET forward_info = json_set(
  forward_info,
  '$.fromMessageId',
  CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) / 1048576
)
WHERE forward_info IS NOT NULL
  AND json_extract(forward_info, '$.fromMessageId') IS NOT NULL
  AND CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) > 0
  AND CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) % 1048576 = 0;
--> statement-breakpoint
UPDATE events
SET message_id = CAST(CAST(message_id AS INTEGER) / 1048576 AS TEXT)
WHERE message_id IS NOT NULL
  AND CAST(message_id AS INTEGER) > 0
  AND CAST(message_id AS INTEGER) % 1048576 = 0;
--> statement-breakpoint
UPDATE events
SET reply_to_message_id = CAST(CAST(reply_to_message_id AS INTEGER) / 1048576 AS TEXT)
WHERE reply_to_message_id IS NOT NULL
  AND CAST(reply_to_message_id AS INTEGER) > 0
  AND CAST(reply_to_message_id AS INTEGER) % 1048576 = 0;
--> statement-breakpoint
UPDATE events
SET message_ids = (
  SELECT json_group_array(
    CASE
      WHEN CAST(value AS INTEGER) > 0 AND CAST(value AS INTEGER) % 1048576 = 0
      THEN CAST(CAST(value AS INTEGER) / 1048576 AS TEXT)
      ELSE value
    END
  )
  FROM json_each(message_ids)
)
WHERE message_ids IS NOT NULL AND EXISTS (
  SELECT 1 FROM json_each(message_ids)
  WHERE CAST(value AS INTEGER) > 0 AND CAST(value AS INTEGER) % 1048576 = 0
);
--> statement-breakpoint
UPDATE events
SET forward_info = json_set(
  forward_info,
  '$.fromMessageId',
  CAST(CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) / 1048576 AS TEXT)
)
WHERE forward_info IS NOT NULL
  AND json_extract(forward_info, '$.fromMessageId') IS NOT NULL
  AND CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) > 0
  AND CAST(json_extract(forward_info, '$.fromMessageId') AS INTEGER) % 1048576 = 0;
--> statement-breakpoint
UPDATE events
SET service_action = json_set(
  service_action,
  '$.messageId',
  CAST(CAST(json_extract(service_action, '$.messageId') AS INTEGER) / 1048576 AS TEXT)
)
WHERE service_action IS NOT NULL
  AND json_extract(service_action, '$.messageId') IS NOT NULL
  AND CAST(json_extract(service_action, '$.messageId') AS INTEGER) > 0
  AND CAST(json_extract(service_action, '$.messageId') AS INTEGER) % 1048576 = 0;
