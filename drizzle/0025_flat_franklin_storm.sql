CREATE TABLE `subscriptionUpgradeRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`requestedByUserId` int NOT NULL,
	`currentPlan` enum('starter','professional','enterprise') NOT NULL,
	`requestedPlan` enum('starter','professional','enterprise') NOT NULL,
	`reason` varchar(80) NOT NULL DEFAULT 'subscriber_limit_reached',
	`status` enum('pending','reviewing','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`note` text,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subscriptionUpgradeRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `subscriptionUpgradeRequests` ADD CONSTRAINT `subscriptionUpgradeRequests_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptionUpgradeRequests` ADD CONSTRAINT `subscriptionUpgradeRequests_requestedByUserId_users_id_fk` FOREIGN KEY (`requestedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptionUpgradeRequests` ADD CONSTRAINT `subscriptionUpgradeRequests_reviewedByUserId_users_id_fk` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `subscription_upgrade_request_tenant_status_idx` ON `subscriptionUpgradeRequests` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `subscription_upgrade_request_status_date_idx` ON `subscriptionUpgradeRequests` (`status`,`createdAt`);