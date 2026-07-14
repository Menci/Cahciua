UPDATE `events`
SET `attachments` = (
  SELECT json_group_array(json(
    CASE
      WHEN json_extract(event_attachment.value, '$.type') = 'sticker'
        AND message_attachment.value IS NOT NULL
      THEN json_set(
        event_attachment.value,
        '$.format',
        CASE
          WHEN json_extract(message_attachment.value, '$.isAnimatedSticker') = 1 THEN 'animated'
          WHEN json_extract(message_attachment.value, '$.isVideoSticker') = 1 THEN 'video'
          ELSE 'static'
        END
      )
      ELSE event_attachment.value
    END
  ))
  FROM json_each(`events`.`attachments`) AS event_attachment
  LEFT JOIN `messages`
    ON `messages`.`chat_id` = `events`.`chat_id`
    AND `messages`.`message_id` = CAST(`events`.`message_id` AS INTEGER)
  LEFT JOIN json_each(`messages`.`attachments`) AS message_attachment
    ON message_attachment.key = event_attachment.key
)
WHERE `attachments` IS NOT NULL
  AND json_array_length(`attachments`) > 0;
