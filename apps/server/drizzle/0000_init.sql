CREATE TABLE `applied` (
	`change_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `claims` (
	`task_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`leased_until` integer NOT NULL,
	`offered_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `counter` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `declines` (
	`task_id` text NOT NULL,
	`device_id` text NOT NULL,
	`at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `device_id`)
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen` integer,
	`state` text DEFAULT 'offline' NOT NULL,
	`room` real DEFAULT 0 NOT NULL,
	`agents` text DEFAULT '[]' NOT NULL,
	`state_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `history` (
	`record_id` text NOT NULL,
	`version` integer NOT NULL,
	`author` text NOT NULL,
	`device` text,
	`ts` integer NOT NULL,
	`snapshot` text NOT NULL,
	PRIMARY KEY(`record_id`, `version`)
);
--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`member_name` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_name` text,
	`device_hash` text,
	`nonce` text,
	`asked_at` integer
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_name_unique` ON `members` (`name`);--> statement-breakpoint
CREATE TABLE `records` (
	`id` text PRIMARY KEY NOT NULL,
	`top` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`fields` text NOT NULL,
	`author` text NOT NULL,
	`device` text,
	`session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	`version` integer NOT NULL,
	`anchors` text NOT NULL,
	`links` text NOT NULL,
	`sealed` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_version_unique` ON `records` (`version`);--> statement-breakpoint
CREATE INDEX `records_top` ON `records` (`top`,`type`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`task_id` text,
	`device_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`actions` integer NOT NULL,
	`cost` real NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`routine_id` text PRIMARY KEY NOT NULL,
	`next_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`device_id` text NOT NULL,
	`day` text NOT NULL,
	`repo` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost` real NOT NULL,
	`routine_minutes` real DEFAULT 0 NOT NULL,
	PRIMARY KEY(`device_id`, `day`, `repo`)
);
--> statement-breakpoint
CREATE TABLE `weblinks` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer
);
