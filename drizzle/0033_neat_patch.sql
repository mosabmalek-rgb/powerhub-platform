CREATE TABLE `accountTransactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`accountId` int NOT NULL,
	`transactionType` enum('deposit','withdrawal','transfer_in','transfer_out','collection') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`description` varchar(255) NOT NULL,
	`referenceNo` varchar(120),
	`relatedPaymentId` int,
	`relatedAccountId` int,
	`createdByUserId` int,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `accountTransactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `companyAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`accountType` enum('cash','jawwal_pay','palpay','bank_of_palestine','other') NOT NULL,
	`color` varchar(20) NOT NULL DEFAULT '#64748b',
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `companyAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `company_accounts_tenant_type_unique` UNIQUE(`tenantId`,`accountType`)
);
--> statement-breakpoint
ALTER TABLE `accountTransactions` ADD CONSTRAINT `accountTransactions_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountTransactions` ADD CONSTRAINT `accountTransactions_accountId_companyAccounts_id_fk` FOREIGN KEY (`accountId`) REFERENCES `companyAccounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountTransactions` ADD CONSTRAINT `accountTransactions_relatedPaymentId_payments_id_fk` FOREIGN KEY (`relatedPaymentId`) REFERENCES `payments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountTransactions` ADD CONSTRAINT `accountTransactions_relatedAccountId_companyAccounts_id_fk` FOREIGN KEY (`relatedAccountId`) REFERENCES `companyAccounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `accountTransactions` ADD CONSTRAINT `accountTransactions_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companyAccounts` ADD CONSTRAINT `companyAccounts_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `account_transactions_tenant_account_date_idx` ON `accountTransactions` (`tenantId`,`accountId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `company_accounts_tenant_idx` ON `companyAccounts` (`tenantId`);