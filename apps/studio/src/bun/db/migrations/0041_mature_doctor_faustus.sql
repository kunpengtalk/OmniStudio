CREATE TABLE `canvas_docs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`nodes` text DEFAULT '[]' NOT NULL,
	`connections` text DEFAULT '[]' NOT NULL,
	`viewport` text DEFAULT '{"x":0,"y":0,"k":1}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
