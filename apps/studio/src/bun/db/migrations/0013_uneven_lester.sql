CREATE TABLE `user_prompts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`summary` text,
	`ratio` text,
	`image` text,
	`source_key` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_prompts_source_key_unique` ON `user_prompts` (`source_key`);
