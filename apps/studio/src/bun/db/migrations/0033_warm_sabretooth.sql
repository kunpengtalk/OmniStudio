ALTER TABLE `knowledge_bases` ADD `embedding_provider_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `rerank_provider_id` text DEFAULT '' NOT NULL;