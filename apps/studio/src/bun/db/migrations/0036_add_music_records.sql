CREATE TABLE `music_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`backend` text,
	`provider_id` text,
	`music_api` text,
	`local_base` text,
	`model` text,
	`task` text,
	`title` text,
	`caption` text,
	`lyrics` text,
	`instrumental` integer,
	`ref_audio_path` text,
	`response_format` text,
	`sample_rate` integer,
	`bit_rate` integer,
	`duration_ms` integer,
	`task_id` text,
	`audio_path` text,
	`rewritten_caption` text,
	`rewritten_lyrics` text,
	`error` text,
	`created_at` integer
);
--> statement-breakpoint
ALTER TABLE `cloud_providers` ADD `music_api` text DEFAULT '' NOT NULL;
