CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`root` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `repos` (`id`, `name`, `root`) SELECT `repo_id`, `name`, `root` FROM `tops` WHERE `kind` = 'repo' AND `repo_id` IS NOT NULL AND `root` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `history` WHERE `record_id` IN (SELECT `id` FROM `records` WHERE `top` LIKE 'repo:%');
--> statement-breakpoint
DELETE FROM `records` WHERE `top` LIKE 'repo:%';
--> statement-breakpoint
DROP TABLE `tops`;
