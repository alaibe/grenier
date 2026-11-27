DELETE FROM `records_fts` WHERE `id` IN (SELECT `id` FROM `records` WHERE `type` = 'Suggestion');
--> statement-breakpoint
DELETE FROM `history` WHERE `record_id` IN (SELECT `id` FROM `records` WHERE `type` = 'Suggestion');
--> statement-breakpoint
DELETE FROM `records` WHERE `type` = 'Suggestion';
