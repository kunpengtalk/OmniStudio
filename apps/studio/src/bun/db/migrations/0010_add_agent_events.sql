CREATE TABLE `agent_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer,
	`kind` text NOT NULL,
	`tool_name` text,
	`args` text,
	`output` text,
	`is_error` integer DEFAULT 0 NOT NULL,
	`created_at` integer
);
