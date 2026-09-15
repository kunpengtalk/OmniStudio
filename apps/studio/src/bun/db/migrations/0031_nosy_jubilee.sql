CREATE TABLE `usage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`day` text NOT NULL,
	`channel` text NOT NULL,
	`upstream` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 1 NOT NULL,
	`estimated` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_records_day_idx` ON `usage_records` (`day`);--> statement-breakpoint
CREATE INDEX `usage_records_model_idx` ON `usage_records` (`model`);