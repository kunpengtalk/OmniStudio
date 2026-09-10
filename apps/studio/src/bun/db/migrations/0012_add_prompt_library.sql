CREATE TABLE `prompt_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`intro` text,
	`sort` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`category` text NOT NULL,
	`subcategory` text,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`summary` text,
	`ratio` text,
	`image` text,
	`video` text,
	`mode` text,
	`duration` integer,
	`play_url` text,
	`play_label` text,
	`source` text,
	`source_url` text,
	`source_label` text,
	`featured` integer DEFAULT 0 NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_key_unique` ON `prompts` (`key`);
