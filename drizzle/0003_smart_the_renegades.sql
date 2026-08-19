CREATE TABLE `tenantMembers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','admin','member') NOT NULL DEFAULT 'member',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantMembers_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_member_unique` UNIQUE(`tenantId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `tenantMessagingConfigurations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`channel` enum('whatsapp','sms') NOT NULL,
	`provider` varchar(80) NOT NULL,
	`senderId` varchar(120),
	`phoneNumberId` varchar(120),
	`templateName` varchar(120),
	`credentialCiphertext` text,
	`credentialIv` varchar(64),
	`credentialKeyVersion` int NOT NULL DEFAULT 1,
	`webhookVerifyTokenHash` varchar(128),
	`isActive` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantMessagingConfigurations_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_channel_unique` UNIQUE(`tenantId`,`channel`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`status` enum('active','suspended','archived') NOT NULL DEFAULT 'active',
	`plan` enum('starter','professional','enterprise') NOT NULL DEFAULT 'starter',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenants_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `notificationMessages` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `sites` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD CONSTRAINT `tenantMembers_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantMembers` ADD CONSTRAINT `tenantMembers_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantMessagingConfigurations` ADD CONSTRAINT `tenantMessagingConfigurations_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tenant_member_user_idx` ON `tenantMembers` (`userId`,`isActive`);--> statement-breakpoint
ALTER TABLE `notificationMessages` ADD CONSTRAINT `notificationMessages_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sites` ADD CONSTRAINT `sites_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;