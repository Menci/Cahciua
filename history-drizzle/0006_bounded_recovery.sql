ALTER TABLE `history_build_inputs` ADD `after_key` text;--> statement-breakpoint
ALTER TABLE `history_build_inputs` ADD `upper_key` text;
--> statement-breakpoint
-- Preserve in-flight recovery and repair completed dependencies on upgrade.
INSERT INTO history_build_inputs(generation, source_kind, source_key)
SELECT generation, 'dependencies', '' FROM history_consumers
WHERE 1 ON CONFLICT(generation, source_kind, source_key) DO NOTHING;
