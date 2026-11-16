CREATE TABLE `answer_sources` (
	`answer_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	PRIMARY KEY(`answer_id`, `path`),
	FOREIGN KEY (`answer_id`) REFERENCES `answers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `answers` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`repo_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`created_at` integer NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`author` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answers_id_unique` ON `answers` (`id`);--> statement-breakpoint
CREATE INDEX `answers_repo` ON `answers` (`repo_id`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`limit_amount` real NOT NULL,
	`period` text NOT NULL,
	PRIMARY KEY(`scope`, `key`, `period`)
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_name_unique` ON `clients` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `clients_token_hash_unique` ON `clients` (`token_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `events_session_ts` ON `events` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `file_summaries` (
	`repo_id` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `path`, `blob_hash`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text,
	`repo_root` text,
	`repo_id` text,
	`cwd` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`paused` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_repo` ON `sessions` (`repo_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` integer NOT NULL,
	`model` text,
	`input_tokens` integer,
	`cache_write_tokens` integer,
	`cache_read_tokens` integer,
	`output_tokens` integer,
	`cost` real,
	`status` integer
);
--> statement-breakpoint
CREATE INDEX `usage_session_ts` ON `usage` (`session_id`,`ts`);--> statement-breakpoint
CREATE INDEX `usage_ts` ON `usage` (`ts`);