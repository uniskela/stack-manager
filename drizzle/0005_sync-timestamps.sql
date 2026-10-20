ALTER TABLE `git_repository_connections` ADD `last_sync_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `git_repository_connections` ADD `last_sync_failed_at` integer;--> statement-breakpoint
ALTER TABLE `git_repository_connections` ADD `last_head_changed_at` integer;