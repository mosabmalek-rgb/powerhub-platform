CREATE TABLE `tenantOwnerProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`ownerUserId` int,
	`fullName` varchar(180) NOT NULL,
	`phone` varchar(30) NOT NULL,
	`email` varchar(320),
	`companyName` varchar(180),
	`invitedAt` timestamp,
	`claimedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantOwnerProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_owner_profile_tenant_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
CREATE TABLE `tenantSubscriptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`plan` enum('starter','professional','enterprise') NOT NULL DEFAULT 'starter',
	`status` enum('trial','active','overdue','suspended','cancelled') NOT NULL DEFAULT 'trial',
	`billingCycle` enum('monthly','yearly') NOT NULL DEFAULT 'monthly',
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`endsAt` timestamp NOT NULL,
	`autoRenew` boolean NOT NULL DEFAULT false,
	`renewalCount` int NOT NULL DEFAULT 0,
	`lastRenewedAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantSubscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_subscription_tenant_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD CONSTRAINT `tenantOwnerProfiles_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD CONSTRAINT `tenantOwnerProfiles_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantSubscriptions` ADD CONSTRAINT `tenantSubscriptions_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tenant_owner_profile_user_idx` ON `tenantOwnerProfiles` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `tenant_subscription_status_end_idx` ON `tenantSubscriptions` (`status`,`endsAt`);