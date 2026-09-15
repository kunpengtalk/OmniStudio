CREATE TABLE `agent_goals` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`objective` text NOT NULL,
	`acceptance` text,
	`status` text DEFAULT 'active' NOT NULL,
	`token_budget` integer,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`seconds_used` integer DEFAULT 0 NOT NULL,
	`continuations` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `agent_plans` (
	`conversation_id` integer PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`message_id` integer,
	`file_path` text,
	`approved_at` integer,
	`created_at` integer,
	`updated_at` integer
);
