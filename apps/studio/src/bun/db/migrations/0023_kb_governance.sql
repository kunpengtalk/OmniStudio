CREATE TABLE `kb_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kb_id` integer,
	`doc_id` integer,
	`action` text NOT NULL,
	`detail` text,
	`actor` text DEFAULT 'ui' NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `kb_events_kb_id_idx` ON `kb_events` (`kb_id`);--> statement-breakpoint
CREATE INDEX `kb_events_action_idx` ON `kb_events` (`action`);--> statement-breakpoint
CREATE TABLE `kb_ingest_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kb_id` integer NOT NULL,
	`doc_id` integer NOT NULL,
	`kind` text DEFAULT 'ingest' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`next_run_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`locked_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `kb_ingest_jobs_doc_id_idx` ON `kb_ingest_jobs` (`doc_id`);--> statement-breakpoint
CREATE INDEX `kb_ingest_jobs_state_next_run_at_idx` ON `kb_ingest_jobs` (`state`,`next_run_at`);--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `min_score` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `expand_neighbors` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `mcp_exposed` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `heading_path` text;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `char_start` integer;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `char_end` integer;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `knowledge_docs` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `knowledge_docs` ADD `source_mtime` integer;--> statement-breakpoint
ALTER TABLE `knowledge_docs` ADD `indexed_at` integer;--> statement-breakpoint
CREATE INDEX `knowledge_docs_source_path_idx` ON `knowledge_docs` (`kb_id`,`source_path`);