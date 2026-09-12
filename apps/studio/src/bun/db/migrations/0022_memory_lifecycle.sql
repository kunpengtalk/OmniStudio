CREATE TABLE `memory_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`memory_id` integer,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `memory_events_memory_id_idx` ON `memory_events` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_events_action_idx` ON `memory_events` (`action`);--> statement-breakpoint
CREATE TABLE `memory_metrics` (
	`key` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `memories` ADD `importance` real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `scope` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `superseded_by` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_until` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `embedding` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `embedding_model` text;--> statement-breakpoint
CREATE INDEX `memories_status_idx` ON `memories` (`status`);--> statement-breakpoint
CREATE INDEX `memories_content_hash_idx` ON `memories` (`content_hash`);--> statement-breakpoint
CREATE INDEX `memories_scope_idx` ON `memories` (`scope`);