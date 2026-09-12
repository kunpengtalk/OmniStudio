CREATE TABLE `knowledge_bases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`embedding_model` text DEFAULT '' NOT NULL,
	`embedding_base` text DEFAULT '' NOT NULL,
	`embedding_api_key` text DEFAULT '' NOT NULL,
	`embedding_dim` integer,
	`chunk_size` integer DEFAULT 800 NOT NULL,
	`chunk_overlap` integer DEFAULT 120 NOT NULL,
	`top_k` integer DEFAULT 6 NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `knowledge_chunks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kb_id` integer NOT NULL,
	`doc_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`content` text NOT NULL,
	`char_count` integer NOT NULL,
	`embedding` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `knowledge_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kb_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`source_path` text,
	`url` text,
	`content` text,
	`size_bytes` integer,
	`char_count` integer,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`embedded_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `messages` ADD `kb_ids` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `citations` text;