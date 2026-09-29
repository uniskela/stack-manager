CREATE TABLE `source_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`base_blob_sha` text,
	`base_commit_sha` text NOT NULL,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `git_repository_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_drafts_repo_path_uq` ON `source_drafts` (`repository_id`,`path`);--> statement-breakpoint
CREATE TABLE `stacks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repository_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`root_path` text NOT NULL,
	`compose_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `git_repository_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `stacks_workspace_idx` ON `stacks` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stacks_repo_root_uq` ON `stacks` (`repository_id`,`root_path`);--> statement-breakpoint
CREATE UNIQUE INDEX `stacks_repo_slug_uq` ON `stacks` (`repository_id`,`slug`);