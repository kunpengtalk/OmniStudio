CREATE TABLE `voice_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`model` text,
	`voice` text,
	`text` text,
	`audio_path` text,
	`ref_audio_path` text,
	`duration_ms` integer,
	`error` text,
	`created_at` integer NOT NULL
);
