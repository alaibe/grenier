CREATE TABLE `audit` (
	`id` integer PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`client_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text NOT NULL,
	`item_ids` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_client_ts` ON `audit` (`client_id`,`ts`);--> statement-breakpoint
CREATE TABLE `items` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`people` text DEFAULT '[]' NOT NULL,
	`ts` integer NOT NULL,
	`content_hash` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_id_unique` ON `items` (`id`);--> statement-breakpoint
CREATE INDEX `items_source` ON `items` (`source_id`);--> statement-breakpoint
CREATE INDEX `items_ts` ON `items` (`ts`);--> statement-breakpoint
CREATE TABLE `review_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`text` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`ts` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`last_sync` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_unique` ON `sources` (`name`);