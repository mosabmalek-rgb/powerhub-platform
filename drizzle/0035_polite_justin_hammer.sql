CREATE TABLE `companyAccountSites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`accountId` int NOT NULL,
	`siteId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `companyAccountSites_id` PRIMARY KEY(`id`),
	CONSTRAINT `company_account_sites_unique` UNIQUE(`accountId`,`siteId`)
);
--> statement-breakpoint
ALTER TABLE `companyAccounts` DROP INDEX `company_accounts_tenant_type_unique`;--> statement-breakpoint
ALTER TABLE `companyAccounts` ADD CONSTRAINT `company_accounts_tenant_type_phone_unique` UNIQUE(`tenantId`,`accountType`,`phoneNumber`);--> statement-breakpoint
ALTER TABLE `companyAccountSites` ADD CONSTRAINT `companyAccountSites_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companyAccountSites` ADD CONSTRAINT `companyAccountSites_accountId_companyAccounts_id_fk` FOREIGN KEY (`accountId`) REFERENCES `companyAccounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companyAccountSites` ADD CONSTRAINT `companyAccountSites_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `company_account_sites_tenant_idx` ON `companyAccountSites` (`tenantId`);