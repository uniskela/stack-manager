CREATE TABLE `deployment_routing_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text NOT NULL,
	`source_delivery_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`binding_revision` text,
	`before_sha` text,
	`after_sha` text NOT NULL,
	`matched_paths` text NOT NULL,
	`decision` text NOT NULL,
	`reason_code` text NOT NULL,
	`explanation` text NOT NULL,
	`attempt_id` text,
	`created_at` integer NOT NULL,
	`processed_at` integer NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `git_repository_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_delivery_id`) REFERENCES `git_webhook_deliveries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`) REFERENCES `deployment_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_routing_source_stack_uq` ON `deployment_routing_decisions` (`source_delivery_id`,`stack_id`);--> statement-breakpoint
CREATE INDEX `deployment_routing_history_idx` ON `deployment_routing_decisions` (`stack_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `deployment_attempts` ADD `acknowledged_at` integer;--> statement-breakpoint
ALTER TABLE `deployment_bindings` ADD `routing_policy` text;--> statement-breakpoint
ALTER TABLE `deployment_bindings` ADD `routing_head_sha` text;--> statement-breakpoint
ALTER TABLE `deployment_bindings` ADD `routing_branch` text;--> statement-breakpoint
ALTER TABLE `deployment_bindings` ADD `automation_hold` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `git_webhook_deliveries` ADD `after_sha` text;--> statement-breakpoint
ALTER TABLE `git_webhook_deliveries` ADD `active_stack_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `git_webhook_deliveries` ADD `signing_credential_id` text;--> statement-breakpoint
ALTER TABLE `git_webhook_deliveries` ADD `signing_nonce` text;--> statement-breakpoint
ALTER TABLE `git_webhook_deliveries` ADD `processed_at` integer;