CREATE TABLE `translation_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_lang` text NOT NULL,
	`target_lang` text NOT NULL,
	`text` text NOT NULL,
	`result` text,
	`model` text,
	`created_at` integer
);
