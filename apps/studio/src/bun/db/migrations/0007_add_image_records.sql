CREATE TABLE `image_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`backend` text,
	`model` text,
	`prompt` text,
	`negative_prompt` text,
	`width` integer,
	`height` integer,
	`seed` integer,
	`steps` integer,
	`image_path` text,
	`error` text,
	`created_at` integer
);
