UPDATE probe_responses_v2
SET entries = REPLACE(entries, '"should_act":true', '"should_act":"send_message"')
WHERE entries LIKE '%"should_act":true%';
--> statement-breakpoint
UPDATE probe_responses_v2
SET entries = REPLACE(entries, '"should_act":false', '"should_act":"no_action"')
WHERE entries LIKE '%"should_act":false%';
