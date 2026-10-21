CREATE TABLE `git_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`provider` text NOT NULL,
	`delivery_id` text NOT NULL,
	`event_type` text NOT NULL,
	`ref` text,
	`received_at` integer NOT NULL,
	`status` text NOT NULL,
	`job_id` text,
	FOREIGN KEY (`repository_id`) REFERENCES `git_repository_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_webhook_delivery_uq` ON `git_webhook_deliveries` (`repository_id`,`provider`,`delivery_id`);--> statement-breakpoint
CREATE INDEX `git_webhook_received_idx` ON `git_webhook_deliveries` (`repository_id`,`received_at`);