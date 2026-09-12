CREATE TABLE `cloud_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`vendor` text DEFAULT '' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`api_key` text DEFAULT '' NOT NULL,
	`models` text DEFAULT '[]' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
