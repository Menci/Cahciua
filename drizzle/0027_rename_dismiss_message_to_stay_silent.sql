UPDATE turn_responses_v2
SET entries = REPLACE(entries, '"name":"dismiss_message"', '"name":"stay_silent"')
WHERE entries LIKE '%"name":"dismiss_message"%';
--> statement-breakpoint
UPDATE probe_responses_v2
SET entries = REPLACE(entries, '"name":"dismiss_message"', '"name":"stay_silent"')
WHERE entries LIKE '%"name":"dismiss_message"%';
