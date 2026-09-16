CREATE TABLE `gateway_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `gateway_keys_created_at_idx` ON `gateway_keys` (`created_at`);