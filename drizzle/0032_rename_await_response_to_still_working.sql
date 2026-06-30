UPDATE `turn_responses`
SET `data` = (
  SELECT json_group_array(json(
    CASE
      WHEN `turn_responses`.`provider` = 'openai-chat'
        AND json_type(entry.value, '$.tool_calls') = 'array'
      THEN json_set(
        entry.value,
        '$.tool_calls',
        json((
          SELECT json_group_array(json(
            CASE
              WHEN json_extract(tool_call.value, '$.function.name') = 'send_message'
              THEN CASE
                WHEN json_valid(json_extract(tool_call.value, '$.function.arguments')) = 1
                THEN CASE
                  WHEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.await_response') IS NOT NULL
                  THEN json_set(
                    tool_call.value,
                    '$.function.arguments',
                    printf(
                      '%s',
                      CASE
                        WHEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.still_working') IS NULL
                        THEN json_set(
                          json_remove(json_extract(tool_call.value, '$.function.arguments'), '$.await_response'),
                          '$.still_working',
                          json_extract(tool_call.value, '$.function.arguments') -> '$.await_response'
                        )
                        ELSE json_remove(json_extract(tool_call.value, '$.function.arguments'), '$.await_response')
                      END
                    )
                  )
                  ELSE tool_call.value
                END
                WHEN instr(json_extract(tool_call.value, '$.function.arguments'), '"await_response":') > 0
                THEN json_set(
                  tool_call.value,
                  '$.function.arguments',
                  replace(
                    json_extract(tool_call.value, '$.function.arguments'),
                    '"await_response":',
                    '"still_working":'
                  )
                )
                ELSE tool_call.value
              END
              ELSE tool_call.value
            END
          ))
          FROM json_each(entry.value, '$.tool_calls') AS tool_call
        ))
      )
      WHEN `turn_responses`.`provider` = 'responses'
        AND json_extract(entry.value, '$.type') = 'function_call'
        AND json_extract(entry.value, '$.name') = 'send_message'
      THEN CASE
        WHEN json_valid(json_extract(entry.value, '$.arguments')) = 1
        THEN CASE
          WHEN json_type(json_extract(entry.value, '$.arguments'), '$.await_response') IS NOT NULL
          THEN json_set(
            entry.value,
            '$.arguments',
            printf(
              '%s',
              CASE
                WHEN json_type(json_extract(entry.value, '$.arguments'), '$.still_working') IS NULL
                THEN json_set(
                  json_remove(json_extract(entry.value, '$.arguments'), '$.await_response'),
                  '$.still_working',
                  json_extract(entry.value, '$.arguments') -> '$.await_response'
                )
                ELSE json_remove(json_extract(entry.value, '$.arguments'), '$.await_response')
              END
            )
          )
          ELSE entry.value
        END
        WHEN instr(json_extract(entry.value, '$.arguments'), '"await_response":') > 0
        THEN json_set(
          entry.value,
          '$.arguments',
          replace(
            json_extract(entry.value, '$.arguments'),
            '"await_response":',
            '"still_working":'
          )
        )
        ELSE entry.value
      END
      ELSE entry.value
    END
  ))
  FROM json_each(`turn_responses`.`data`) AS entry
)
WHERE (
  `provider` = 'openai-chat'
  AND EXISTS (
    SELECT 1
    FROM json_each(`turn_responses`.`data`) AS entry,
      json_each(
        CASE
          WHEN json_type(entry.value, '$.tool_calls') = 'array'
          THEN json_extract(entry.value, '$.tool_calls')
          ELSE '[]'
        END
      ) AS tool_call
    WHERE json_extract(tool_call.value, '$.function.name') = 'send_message'
      AND CASE
        WHEN json_valid(json_extract(tool_call.value, '$.function.arguments')) = 1
        THEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.await_response') IS NOT NULL
        ELSE instr(json_extract(tool_call.value, '$.function.arguments'), '"await_response":') > 0
      END
  )
)
OR (
  `provider` = 'responses'
  AND EXISTS (
    SELECT 1
    FROM json_each(`turn_responses`.`data`) AS entry
    WHERE json_extract(entry.value, '$.type') = 'function_call'
      AND json_extract(entry.value, '$.name') = 'send_message'
      AND CASE
        WHEN json_valid(json_extract(entry.value, '$.arguments')) = 1
        THEN json_type(json_extract(entry.value, '$.arguments'), '$.await_response') IS NOT NULL
        ELSE instr(json_extract(entry.value, '$.arguments'), '"await_response":') > 0
      END
  )
);
--> statement-breakpoint
UPDATE `probe_responses`
SET `data` = (
  SELECT json_group_array(json(
    CASE
      WHEN `probe_responses`.`provider` = 'openai-chat'
        AND json_type(entry.value, '$.tool_calls') = 'array'
      THEN json_set(
        entry.value,
        '$.tool_calls',
        json((
          SELECT json_group_array(json(
            CASE
              WHEN json_extract(tool_call.value, '$.function.name') = 'send_message'
              THEN CASE
                WHEN json_valid(json_extract(tool_call.value, '$.function.arguments')) = 1
                THEN CASE
                  WHEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.await_response') IS NOT NULL
                  THEN json_set(
                    tool_call.value,
                    '$.function.arguments',
                    printf(
                      '%s',
                      CASE
                        WHEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.still_working') IS NULL
                        THEN json_set(
                          json_remove(json_extract(tool_call.value, '$.function.arguments'), '$.await_response'),
                          '$.still_working',
                          json_extract(tool_call.value, '$.function.arguments') -> '$.await_response'
                        )
                        ELSE json_remove(json_extract(tool_call.value, '$.function.arguments'), '$.await_response')
                      END
                    )
                  )
                  ELSE tool_call.value
                END
                WHEN instr(json_extract(tool_call.value, '$.function.arguments'), '"await_response":') > 0
                THEN json_set(
                  tool_call.value,
                  '$.function.arguments',
                  replace(
                    json_extract(tool_call.value, '$.function.arguments'),
                    '"await_response":',
                    '"still_working":'
                  )
                )
                ELSE tool_call.value
              END
              ELSE tool_call.value
            END
          ))
          FROM json_each(entry.value, '$.tool_calls') AS tool_call
        ))
      )
      WHEN `probe_responses`.`provider` = 'responses'
        AND json_extract(entry.value, '$.type') = 'function_call'
        AND json_extract(entry.value, '$.name') = 'send_message'
      THEN CASE
        WHEN json_valid(json_extract(entry.value, '$.arguments')) = 1
        THEN CASE
          WHEN json_type(json_extract(entry.value, '$.arguments'), '$.await_response') IS NOT NULL
          THEN json_set(
            entry.value,
            '$.arguments',
            printf(
              '%s',
              CASE
                WHEN json_type(json_extract(entry.value, '$.arguments'), '$.still_working') IS NULL
                THEN json_set(
                  json_remove(json_extract(entry.value, '$.arguments'), '$.await_response'),
                  '$.still_working',
                  json_extract(entry.value, '$.arguments') -> '$.await_response'
                )
                ELSE json_remove(json_extract(entry.value, '$.arguments'), '$.await_response')
              END
            )
          )
          ELSE entry.value
        END
        WHEN instr(json_extract(entry.value, '$.arguments'), '"await_response":') > 0
        THEN json_set(
          entry.value,
          '$.arguments',
          replace(
            json_extract(entry.value, '$.arguments'),
            '"await_response":',
            '"still_working":'
          )
        )
        ELSE entry.value
      END
      ELSE entry.value
    END
  ))
  FROM json_each(`probe_responses`.`data`) AS entry
)
WHERE (
  `provider` = 'openai-chat'
  AND EXISTS (
    SELECT 1
    FROM json_each(`probe_responses`.`data`) AS entry,
      json_each(
        CASE
          WHEN json_type(entry.value, '$.tool_calls') = 'array'
          THEN json_extract(entry.value, '$.tool_calls')
          ELSE '[]'
        END
      ) AS tool_call
    WHERE json_extract(tool_call.value, '$.function.name') = 'send_message'
      AND CASE
        WHEN json_valid(json_extract(tool_call.value, '$.function.arguments')) = 1
        THEN json_type(json_extract(tool_call.value, '$.function.arguments'), '$.await_response') IS NOT NULL
        ELSE instr(json_extract(tool_call.value, '$.function.arguments'), '"await_response":') > 0
      END
  )
)
OR (
  `provider` = 'responses'
  AND EXISTS (
    SELECT 1
    FROM json_each(`probe_responses`.`data`) AS entry
    WHERE json_extract(entry.value, '$.type') = 'function_call'
      AND json_extract(entry.value, '$.name') = 'send_message'
      AND CASE
        WHEN json_valid(json_extract(entry.value, '$.arguments')) = 1
        THEN json_type(json_extract(entry.value, '$.arguments'), '$.await_response') IS NOT NULL
        ELSE instr(json_extract(entry.value, '$.arguments'), '"await_response":') > 0
      END
  )
);
--> statement-breakpoint
UPDATE `turn_responses_v2`
SET `entries` = json_set(
  `entries`,
  '$._',
  json((
    SELECT json_group_array(json(
      CASE
        WHEN json_type(entry.value, '$.parts') = 'array'
        THEN json_set(
          entry.value,
          '$.parts',
          json((
            SELECT json_group_array(json(
              CASE
                WHEN json_extract(part.value, '$.kind') = 'toolCall'
                  AND json_extract(part.value, '$.name') = 'send_message'
                THEN CASE
                  WHEN json_valid(json_extract(part.value, '$.args')) = 1
                  THEN CASE
                    WHEN json_type(json_extract(part.value, '$.args'), '$.await_response') IS NOT NULL
                    THEN json_set(
                      part.value,
                      '$.args',
                      printf(
                        '%s',
                        CASE
                          WHEN json_type(json_extract(part.value, '$.args'), '$.still_working') IS NULL
                          THEN json_set(
                            json_remove(json_extract(part.value, '$.args'), '$.await_response'),
                            '$.still_working',
                            json_extract(part.value, '$.args') -> '$.await_response'
                          )
                          ELSE json_remove(json_extract(part.value, '$.args'), '$.await_response')
                        END
                      )
                    )
                    ELSE part.value
                  END
                  WHEN instr(json_extract(part.value, '$.args'), '"await_response":') > 0
                  THEN json_set(
                    part.value,
                    '$.args',
                    replace(
                      json_extract(part.value, '$.args'),
                      '"await_response":',
                      '"still_working":'
                    )
                  )
                  ELSE part.value
                END
                ELSE part.value
              END
            ))
            FROM json_each(entry.value, '$.parts') AS part
          ))
        )
        ELSE entry.value
      END
    ))
    FROM json_each(`turn_responses_v2`.`entries`, '$._') AS entry
  ))
)
WHERE EXISTS (
  SELECT 1
  FROM json_each(`turn_responses_v2`.`entries`, '$._') AS entry,
    json_each(
      CASE
        WHEN json_type(entry.value, '$.parts') = 'array'
        THEN json_extract(entry.value, '$.parts')
        ELSE '[]'
      END
    ) AS part
  WHERE json_extract(part.value, '$.kind') = 'toolCall'
    AND json_extract(part.value, '$.name') = 'send_message'
    AND CASE
      WHEN json_valid(json_extract(part.value, '$.args')) = 1
      THEN json_type(json_extract(part.value, '$.args'), '$.await_response') IS NOT NULL
      ELSE instr(json_extract(part.value, '$.args'), '"await_response":') > 0
    END
);
--> statement-breakpoint
UPDATE `probe_responses_v2`
SET `entries` = json_set(
  `entries`,
  '$._',
  json((
    SELECT json_group_array(json(
      CASE
        WHEN json_type(entry.value, '$.parts') = 'array'
        THEN json_set(
          entry.value,
          '$.parts',
          json((
            SELECT json_group_array(json(
              CASE
                WHEN json_extract(part.value, '$.kind') = 'toolCall'
                  AND json_extract(part.value, '$.name') = 'send_message'
                THEN CASE
                  WHEN json_valid(json_extract(part.value, '$.args')) = 1
                  THEN CASE
                    WHEN json_type(json_extract(part.value, '$.args'), '$.await_response') IS NOT NULL
                    THEN json_set(
                      part.value,
                      '$.args',
                      printf(
                        '%s',
                        CASE
                          WHEN json_type(json_extract(part.value, '$.args'), '$.still_working') IS NULL
                          THEN json_set(
                            json_remove(json_extract(part.value, '$.args'), '$.await_response'),
                            '$.still_working',
                            json_extract(part.value, '$.args') -> '$.await_response'
                          )
                          ELSE json_remove(json_extract(part.value, '$.args'), '$.await_response')
                        END
                      )
                    )
                    ELSE part.value
                  END
                  WHEN instr(json_extract(part.value, '$.args'), '"await_response":') > 0
                  THEN json_set(
                    part.value,
                    '$.args',
                    replace(
                      json_extract(part.value, '$.args'),
                      '"await_response":',
                      '"still_working":'
                    )
                  )
                  ELSE part.value
                END
                ELSE part.value
              END
            ))
            FROM json_each(entry.value, '$.parts') AS part
          ))
        )
        ELSE entry.value
      END
    ))
    FROM json_each(`probe_responses_v2`.`entries`, '$._') AS entry
  ))
)
WHERE EXISTS (
  SELECT 1
  FROM json_each(`probe_responses_v2`.`entries`, '$._') AS entry,
    json_each(
      CASE
        WHEN json_type(entry.value, '$.parts') = 'array'
        THEN json_extract(entry.value, '$.parts')
        ELSE '[]'
      END
    ) AS part
  WHERE json_extract(part.value, '$.kind') = 'toolCall'
    AND json_extract(part.value, '$.name') = 'send_message'
    AND CASE
      WHEN json_valid(json_extract(part.value, '$.args')) = 1
      THEN json_type(json_extract(part.value, '$.args'), '$.await_response') IS NOT NULL
      ELSE instr(json_extract(part.value, '$.args'), '"await_response":') > 0
    END
);
