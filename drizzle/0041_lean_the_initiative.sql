CREATE TABLE `employees` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int,
	`linkedUserId` int,
	`fullName` varchar(180) NOT NULL,
	`identityNo` varchar(80),
	`phone` varchar(40),
	`jobTitle` enum('accountant','collector','technician','worker','supervisor','other') NOT NULL,
	`employmentStatus` enum('active','suspended','ended') NOT NULL DEFAULT 'active',
	`contractType` enum('daily','monthly','collection_percentage') NOT NULL,
	`baseWage` decimal(12,2) NOT NULL,
	`hireDate` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employees_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employees` ADD CONSTRAINT `employees_linkedUserId_users_id_fk` FOREIGN KEY (`linkedUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `employees_tenant_status_idx` ON `employees` (`tenantId`,`employmentStatus`);--> statement-breakpoint
CREATE INDEX `employees_tenant_site_idx` ON `employees` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `employees_tenant_phone_idx` ON `employees` (`tenantId`,`phone`);