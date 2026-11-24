ALTER TABLE `spaces` RENAME TO `tops`;--> statement-breakpoint
ALTER TABLE `records` RENAME COLUMN "space" TO "top";--> statement-breakpoint
DROP INDEX `records_space_type`;--> statement-breakpoint
CREATE INDEX `records_top_type` ON `records` (`top`,`type`);--> statement-breakpoint
-- Changes not sent yet name their top folder the new way, so a `me` record among them still leaves sealed.
UPDATE `outbox` SET `change` = json_set(json_remove(`change`, '$.record.space'), '$.record.top', json_extract(`change`, '$.record.space'), '$.changed', json(replace(json_extract(`change`, '$.changed'), '"space"', '"top"'))) WHERE json_extract(`change`, '$.record.space') IS NOT NULL;
