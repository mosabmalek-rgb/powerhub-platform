CREATE TABLE `accessInvitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int,
	`email` varchar(320) NOT NULL,
	`tenantRole` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`siteRole` enum('owner','manager','accountant','collector','technician','viewer'),
	`tokenHash` varchar(128) NOT NULL,
	`status` enum('invited','accepted','suspended','revoked','expired') NOT NULL DEFAULT 'invited',
	`invitedByUserId` int NOT NULL,
	`acceptedByUserId` int,
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accessInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `accessInvitations_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `auditLogs` ADD `actorPlatformRole` enum('platform_owner','platform_admin','finance_admin');--> statement-breakpoint
ALTER TABLE `auditLogs` ADD `actorTenantRole` varchar(32);--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD `membershipStatus` enum('invited','active','suspended','revoked') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD `invitedByUserId` int;--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD `expiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `users` ADD `platformRole` enum('platform_owner','platform_admin','finance_admin');--> statement-breakpoint
ALTER TABLE `users` ADD `accountStatus` enum('active','locked','disabled') DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `accessInvitations` ADD CONSTRAINT `accessInvitations_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accessInvitations` ADD CONSTRAINT `accessInvitations_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accessInvitations` ADD CONSTRAINT `accessInvitations_invitedByUserId_users_id_fk` FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accessInvitations` ADD CONSTRAINT `accessInvitations_acceptedByUserId_users_id_fk` FOREIGN KEY (`acceptedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `access_invitation_tenant_email_status_idx` ON `accessInvitations` (`tenantId`,`email`,`status`);--> statement-breakpoint
CREATE INDEX `access_invitation_email_status_idx` ON `accessInvitations` (`email`,`status`);--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD CONSTRAINT `tenantMembers_invitedByUserId_users_id_fk` FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;