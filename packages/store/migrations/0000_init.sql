CREATE TABLE `anchors` (
	`record_id` text NOT NULL,
	`kind` text NOT NULL,
	`repo_id` text,
	`ref` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`record_id`, `kind`, `ref`),
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`record_id` text NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`approved_at` integer NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`installed_path` text,
	`previous_hash` text,
	PRIMARY KEY(`record_id`, `kind`)
);
--> statement-breakpoint
CREATE TABLE `audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`client_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`record_ids` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_client_ts` ON `audit` (`client_id`,`ts`);--> statement-breakpoint
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
CREATE TABLE `history` (
	`id` integer PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`version` integer NOT NULL,
	`author` text NOT NULL,
	`device` text,
	`ts` integer NOT NULL,
	`snapshot` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_record_version` ON `history` (`record_id`,`version`);--> statement-breakpoint
CREATE TABLE `links` (
	`record_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	PRIMARY KEY(`record_id`, `kind`, `ref`),
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `links_ref` ON `links` (`kind`,`ref`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`record_id` text NOT NULL,
	`change` text NOT NULL,
	`base_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`refused` text
);
--> statement-breakpoint
CREATE TABLE `outcomes` (
	`session_id` text PRIMARY KEY NOT NULL,
	`written_lines` integer NOT NULL,
	`landed_lines` integer NOT NULL,
	`rediscovery` real NOT NULL,
	`issue_keys` text DEFAULT '[]' NOT NULL,
	`computed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `record_embeddings` (
	`record_id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`vector` blob NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `records`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `records` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`space` text NOT NULL,
	`type` text NOT NULL,
	`kind` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`author` text NOT NULL,
	`device` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_id_unique` ON `records` (`id`);--> statement-breakpoint
CREATE INDEX `records_space_type` ON `records` (`space`,`type`);--> statement-breakpoint
CREATE INDEX `records_updated` ON `records` (`updated_at`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`task_id` text,
	`version` integer NOT NULL,
	`session_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`actions` integer DEFAULT 0 NOT NULL,
	`result` text
);
--> statement-breakpoint
CREATE INDEX `runs_routine` ON `runs` (`routine_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text,
	`repo_root` text,
	`repo_id` text,
	`cwd` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`paused` integer DEFAULT false NOT NULL,
	`run_id` text
);
--> statement-breakpoint
CREATE INDEX `sessions_repo` ON `sessions` (`repo_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`repo_id` text,
	`root` text
);
--> statement-breakpoint
CREATE TABLE `state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
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
	`outcome` text,
	`line_hashes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `steps_call` ON `steps` (`session_id`,`call_id`,`part`);--> statement-breakpoint
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