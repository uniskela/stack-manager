ALTER TABLE `git_webhook_deliveries` ADD `body_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `git_webhook_body_uq` ON `git_webhook_deliveries` (`repository_id`,`provider`,`body_hash`);