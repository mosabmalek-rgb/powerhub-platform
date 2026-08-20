CREATE TABLE `platformRolePolicies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`role` enum('owner','manager','accountant','collector','technician','viewer') NOT NULL,
	`capability` enum('manageSubscribers','manageGenerators','recordReadings','approveReadings','manageTariffs','issueInvoices','collectPayments','manageExpenses','manageTeam','manageMessaging','viewAudit') NOT NULL,
	`isAllowed` boolean NOT NULL DEFAULT true,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformRolePolicies_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_role_capability_unique` UNIQUE(`role`,`capability`)
);
--> statement-breakpoint
ALTER TABLE `platformRolePolicies` ADD CONSTRAINT `platformRolePolicies_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_role_policy_role_idx` ON `platformRolePolicies` (`role`);