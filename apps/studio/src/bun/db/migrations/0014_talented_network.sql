CREATE TABLE `preset_skill_tools` (
	`preset_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`tool` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`updated_at` integer,
	PRIMARY KEY(`preset_id`, `skill_id`, `tool`)
);
--> statement-breakpoint
CREATE TABLE `preset_skills` (
	`preset_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`added_at` integer,
	PRIMARY KEY(`preset_id`, `skill_id`)
);
--> statement-breakpoint
CREATE TABLE `skill_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `skill_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `skill_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `skill_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`skill_id` text NOT NULL,
	`tool` text NOT NULL,
	`mode` text NOT NULL,
	`source_hash` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_targets_skill_id_tool_unique` ON `skill_targets` (`skill_id`,`tool`);--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`source_type` text DEFAULT 'manual' NOT NULL,
	`source_ref` text,
	`source_subpath` text,
	`source_revision` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `skillssh_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer
);
