CREATE TABLE `customPermissionRoles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` varchar(255),
	`permissions` json NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customPermissionRoles_id` PRIMARY KEY(`id`),
	CONSTRAINT `custom_permission_role_tenant_name_unique` UNIQUE(`tenantId`,`name`)
);
--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD `customRoleId` int;--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD `permissions` json;--> statement-breakpoint
ALTER TABLE `customPermissionRoles` ADD CONSTRAINT `customPermissionRoles_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `customPermissionRoles` ADD CONSTRAINT `customPermissionRoles_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `custom_permission_role_tenant_active_idx` ON `customPermissionRoles` (`tenantId`,`isActive`);--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD CONSTRAINT `staffProfiles_customRoleId_customPermissionRoles_id_fk` FOREIGN KEY (`customRoleId`) REFERENCES `customPermissionRoles`(`id`) ON DELETE no action ON UPDATE no action;