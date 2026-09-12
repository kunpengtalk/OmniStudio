ALTER TABLE `knowledge_bases` ADD `rerank_model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `rerank_base` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `rerank_api_key` text DEFAULT '' NOT NULL;