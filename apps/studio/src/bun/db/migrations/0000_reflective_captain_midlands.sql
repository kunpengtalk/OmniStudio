CREATE TABLE `documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`status` text NOT NULL,
	`total_pages` integer,
	`processed_pages` integer,
	`images_dir` text,
	`error` text,
	`created_at` integer,
	`processing_started_at` integer,
	`completed_at` integer,
	`failed_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`page_number` integer NOT NULL,
	`markdown` text,
	`raw` text,
	`status` text NOT NULL,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`failed_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
