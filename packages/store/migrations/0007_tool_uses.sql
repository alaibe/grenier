CREATE TABLE `tool_uses` (
	`day` text NOT NULL,
	`agent` text NOT NULL,
	`project` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`tool` text NOT NULL,
	`calls` integer NOT NULL,
	`errors` integer NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`day`, `agent`, `project`, `kind`, `subject`, `tool`)
);
--> statement-breakpoint
CREATE INDEX `tool_uses_subject` ON `tool_uses` (`kind`,`subject`);--> statement-breakpoint
CREATE TABLE `transcripts` (
	`path` text PRIMARY KEY NOT NULL,
	`offset` integer NOT NULL
);
