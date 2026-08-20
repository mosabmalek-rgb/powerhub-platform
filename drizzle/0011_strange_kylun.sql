CREATE TABLE `accessRecoveryRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`ownerUserId` int,
	`requestedByUserId` int NOT NULL,
	`method` enum('oauth_invite','manual_review') NOT NULL DEFAULT 'oauth_invite',
	`status` enum('pending','issued','completed','cancelled') NOT NULL DEFAULT 'pending',
	`note` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `accessRecoveryRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `complaints` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`subscriberId` int,
	`title` varchar(180) NOT NULL,
	`description` text NOT NULL,
	`priority` enum('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
	`status` enum('open','assigned','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
	`assignedUserId` int,
	`response` text,
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `complaints_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platformSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`settingKey` varchar(100) NOT NULL,
	`isEnabled` boolean NOT NULL DEFAULT false,
	`value` json,
	`message` text,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_setting_key_unique` UNIQUE(`settingKey`)
);
--> statement-breakpoint
CREATE TABLE `platformTariffPolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`minimumPricePerKwh` decimal(14,4) NOT NULL,
	`maximumPricePerKwh` decimal(14,4) NOT NULL,
	`effectiveFrom` timestamp NOT NULL,
	`notificationRequested` boolean NOT NULL DEFAULT false,
	`notes` text,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platformTariffPolicies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `accessRecoveryRequests` ADD CONSTRAINT `accessRecoveryRequests_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accessRecoveryRequests` ADD CONSTRAINT `accessRecoveryRequests_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accessRecoveryRequests` ADD CONSTRAINT `accessRecoveryRequests_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `complaints` ADD CONSTRAINT `complaints_assignedUserId_users_id_fk` FOREIGN KEY (`assignedUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformSettings` ADD CONSTRAINT `platformSettings_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformTariffPolicies` ADD CONSTRAINT `platformTariffPolicies_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `access_recovery_tenant_status_idx` ON `accessRecoveryRequests` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `complaints_tenant_site_status_idx` ON `complaints` (`tenantId`,`siteId`,`status`);--> statement-breakpoint
CREATE INDEX `complaints_assignee_status_idx` ON `complaints` (`assignedUserId`,`status`);--> statement-breakpoint
CREATE INDEX `platform_tariff_effective_idx` ON `platformTariffPolicies` (`effectiveFrom`);