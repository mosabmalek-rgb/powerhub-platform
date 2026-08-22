CREATE TABLE `financialSettlements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`periodStart` timestamp NOT NULL,
	`periodEnd` timestamp NOT NULL,
	`totalCollected` decimal(14,2) NOT NULL DEFAULT '0',
	`totalExpenses` decimal(14,2) NOT NULL DEFAULT '0',
	`bookProfit` decimal(14,2) NOT NULL DEFAULT '0',
	`actualCash` decimal(14,2),
	`difference` decimal(14,2),
	`notes` text,
	`status` enum('draft','submitted','approved','locked') NOT NULL DEFAULT 'draft',
	`createdByUserId` int NOT NULL,
	`approvedByUserId` int,
	`lockedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `financialSettlements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `financialSettlements` ADD CONSTRAINT `financialSettlements_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financialSettlements` ADD CONSTRAINT `financialSettlements_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financialSettlements` ADD CONSTRAINT `financialSettlements_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `financialSettlements` ADD CONSTRAINT `financialSettlements_approvedByUserId_users_id_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `financial_settlements_tenant_site_period_idx` ON `financialSettlements` (`tenantId`,`siteId`,`periodStart`,`periodEnd`);