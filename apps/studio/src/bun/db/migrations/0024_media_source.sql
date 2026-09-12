ALTER TABLE `image_records` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `video_records` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_records` ADD `source` text DEFAULT 'manual' NOT NULL;