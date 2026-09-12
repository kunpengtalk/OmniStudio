CREATE TABLE `mcp_servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'stdio' NOT NULL,
	`command` text DEFAULT '' NOT NULL,
	`args` text DEFAULT '[]' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
