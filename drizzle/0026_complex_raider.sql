CREATE TABLE `tenantBranchSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`isEnabledOverride` boolean,
	`maxBranchesOverride` int,
	`disabledBehavior` enum('read_only','suspended') NOT NULL DEFAULT 'read_only',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantBranchSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_branch_settings_tenant_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
ALTER TABLE `sites` MODIFY COLUMN `status` enum('active','inactive','archived') NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE `tenantBranchSettings` ADD CONSTRAINT `tenantBranchSettings_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;