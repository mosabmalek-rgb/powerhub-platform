CREATE TABLE `platformSmsPlans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(80) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`includedMessages` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSmsPlans_id` PRIMARY KEY(`id`),
	CONSTRAINT `platformSmsPlans_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `smsPackageRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`requestedByUserId` int NOT NULL,
	`requestedMessages` int NOT NULL,
	`approvedMessages` int NOT NULL DEFAULT 0,
	`status` enum('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`note` text,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `smsPackageRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tenantSubscriptions` ADD `smsPlanId` int;--> statement-breakpoint
ALTER TABLE `smsPackageRequests` ADD CONSTRAINT `smsPackageRequests_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `smsPackageRequests` ADD CONSTRAINT `smsPackageRequests_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `smsPackageRequests` ADD CONSTRAINT `smsPackageRequests_reviewedByUserId_users_id_fk` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sms_package_requests_tenant_status_idx` ON `smsPackageRequests` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `sms_package_requests_status_date_idx` ON `smsPackageRequests` (`status`,`createdAt`);--> statement-breakpoint
ALTER TABLE `tenantSubscriptions` ADD CONSTRAINT `tenantSubscriptions_smsPlanId_platformSmsPlans_id_fk` FOREIGN KEY (`smsPlanId`) REFERENCES `platformSmsPlans`(`id`) ON DELETE no action ON UPDATE no action;