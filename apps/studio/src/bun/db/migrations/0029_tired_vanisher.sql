ALTER TABLE `knowledge_bases` ADD `embed_image` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `embed_audio` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `embed_video` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `modality` text;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `media_path` text;--> statement-breakpoint
ALTER TABLE `knowledge_chunks` ADD `media_index` integer;