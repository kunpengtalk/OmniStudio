CREATE TABLE IF NOT EXISTS `benchmark_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`server_mode` text,
	`engine` text,
	`params` text,
	`rows` text,
	`summary` text,
	`status` text NOT NULL,
	`duration_ms` integer,
	`error` text,
	`created_at` integer
);
