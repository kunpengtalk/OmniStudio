CREATE TABLE `miniapp_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`day` text NOT NULL,
	`images` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `miniapp_notes_day_idx` ON `miniapp_notes` (`day`);--> statement-breakpoint
CREATE INDEX `miniapp_notes_updated_idx` ON `miniapp_notes` (`updated_at`);
