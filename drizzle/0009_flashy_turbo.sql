CREATE TABLE `deployment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`actor_user_id` text,
	`trigger_type` text NOT NULL,
	`requested_at` integer NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`reason` text,
	`completed_at` integer,
	`binding_revision` text NOT NULL,
	`credential_nonce` text NOT NULL,
	`job_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `deployment_attempt_history_idx` ON `deployment_attempts` (`stack_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_attempt_active_uq` ON `deployment_attempts` (`stack_id`) WHERE "deployment_attempts"."status" IN ('queued','running');--> statement-breakpoint
CREATE TABLE `deployment_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`stack_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`credential_id` text NOT NULL,
	`managed_credential` integer DEFAULT false NOT NULL,
	`enabled` integer NOT NULL,
	`deploy_on_push` integer DEFAULT false NOT NULL,
	`revision` text NOT NULL,
	`last_attempt_at` integer,
	`last_accepted_at` integer,
	`last_failed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stack_id`) REFERENCES `stacks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `provider_credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_binding_stack_uq` ON `deployment_bindings` (`stack_id`);--> statement-breakpoint
-- Managed webhook credentials are removed only after the last binding/repository reference disappears.
CREATE TRIGGER deployment_binding_credential_delete AFTER DELETE ON deployment_bindings
WHEN OLD.managed_credential = 1
BEGIN
  DELETE FROM provider_credentials WHERE id = OLD.credential_id
    AND NOT EXISTS (SELECT 1 FROM deployment_bindings WHERE credential_id = OLD.credential_id)
    AND NOT EXISTS (SELECT 1 FROM git_repository_connections WHERE credential_id = OLD.credential_id OR webhook_credential_id = OLD.credential_id);
END;
--> statement-breakpoint
CREATE TRIGGER deployment_binding_credential_rotate AFTER UPDATE OF credential_id ON deployment_bindings
WHEN OLD.managed_credential = 1 AND OLD.credential_id != NEW.credential_id
BEGIN
  DELETE FROM provider_credentials WHERE id = OLD.credential_id
    AND NOT EXISTS (SELECT 1 FROM deployment_bindings WHERE credential_id = OLD.credential_id)
    AND NOT EXISTS (SELECT 1 FROM git_repository_connections WHERE credential_id = OLD.credential_id OR webhook_credential_id = OLD.credential_id);
END;
