CREATE TABLE `steps` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`call_id` text NOT NULL,
	`part` integer DEFAULT 0 NOT NULL,
	`ts` integer NOT NULL,
	`tool` text NOT NULL,
	`kind` text NOT NULL,
	`path` text,
	`start_line` integer,
	`end_line` integer,
	`label` text,
	`outcome` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_call` ON `steps` (`session_id`,`call_id`,`part`);