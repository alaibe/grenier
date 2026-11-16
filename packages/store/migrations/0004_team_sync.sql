CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `team_repos` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`root` text NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `answers` ADD `shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `file_summaries` ADD `shared` integer DEFAULT false NOT NULL;