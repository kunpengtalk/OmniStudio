-- Agent 会话增强：权限规则、待办、产出物、自动化。
-- 注意：drizzle-kit 会在这里重复生成 benchmark_records（0025 是手写迁移，没有对应
-- snapshot），那份已由 0025 建过，这里必须去掉，否则老库升级会在建表处直接失败。
CREATE TABLE IF NOT EXISTS `agent_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`message_id` integer,
	`path` text NOT NULL,
	`abs_path` text NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`size` integer,
	`tool` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_artifacts_conversation_id_idx` ON `agent_artifacts` (`conversation_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_permissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_ref` text NOT NULL,
	`permission` text NOT NULL,
	`pattern` text NOT NULL,
	`action` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_permissions_scope_idx` ON `agent_permissions` (`scope`,`scope_ref`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agent_todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_todos_conversation_id_idx` ON `agent_todos` (`conversation_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` integer NOT NULL,
	`trigger` text DEFAULT 'scheduled' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`conversation_id` integer,
	`summary` text,
	`error` text,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `automation_runs_automation_id_idx` ON `automation_runs` (`automation_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `automations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`workspace` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`mode` text DEFAULT 'agent' NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `workspace` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `agent_events` ADD `subagent_id` text;
