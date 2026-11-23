CREATE TABLE `wud_connections` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`credential_id` text NOT NULL,
	`revision` text NOT NULL,
	`observations` text NOT NULL,
	`last_success_at` integer NOT NULL,
	`last_attempt_at` integer NOT NULL,
	`last_error` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `wud_stack_bindings` (
	`stack_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`watcher` text NOT NULL,
	`project` text NOT NULL,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wud_stack_binding_workspace_target_uq` ON `wud_stack_bindings` (`workspace_id`,`watcher`,`project`);