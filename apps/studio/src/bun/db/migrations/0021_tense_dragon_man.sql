CREATE INDEX `agent_events_conversation_id_idx` ON `agent_events` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `knowledge_chunks_kb_id_idx` ON `knowledge_chunks` (`kb_id`);--> statement-breakpoint
CREATE INDEX `knowledge_chunks_doc_id_idx` ON `knowledge_chunks` (`doc_id`);--> statement-breakpoint
CREATE INDEX `knowledge_docs_kb_id_idx` ON `knowledge_docs` (`kb_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_id_idx` ON `messages` (`conversation_id`);