CREATE TABLE `employeeAdjustments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`siteId` int,
	`adjustmentType` enum('advance','deduction') NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`remainingAmount` decimal(12,2) NOT NULL,
	`reason` varchar(255) NOT NULL,
	`status` enum('open','settled','cancelled') NOT NULL DEFAULT 'open',
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeAdjustments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payrollItems` (
	`id` int AUTO_INCREMENT NOT NULL,
	`payrollRunId` int NOT NULL,
	`employeeId` int NOT NULL,
	`baseAmount` decimal(12,2) NOT NULL,
	`extraAmount` decimal(12,2) NOT NULL DEFAULT '0',
	`advanceDeduction` decimal(12,2) NOT NULL DEFAULT '0',
	`otherDeduction` decimal(12,2) NOT NULL DEFAULT '0',
	`netAmount` decimal(12,2) NOT NULL,
	`notes` text,
	CONSTRAINT `payrollItems_id` PRIMARY KEY(`id`),
	CONSTRAINT `payroll_items_run_employee_unique` UNIQUE(`payrollRunId`,`employeeId`)
);
--> statement-breakpoint
CREATE TABLE `payrollRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int,
	`period` varchar(7) NOT NULL,
	`status` enum('draft','approved','paid','cancelled') NOT NULL DEFAULT 'draft',
	`totalGross` decimal(14,2) NOT NULL DEFAULT '0',
	`totalDeductions` decimal(14,2) NOT NULL DEFAULT '0',
	`totalNet` decimal(14,2) NOT NULL DEFAULT '0',
	`paidFromAccountId` int,
	`approvedByUserId` int,
	`paidAt` timestamp,
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payrollRuns_id` PRIMARY KEY(`id`),
	CONSTRAINT `payroll_runs_tenant_site_period_unique` UNIQUE(`tenantId`,`siteId`,`period`)
);
--> statement-breakpoint
ALTER TABLE `employeeAdjustments` ADD CONSTRAINT `employeeAdjustments_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAdjustments` ADD CONSTRAINT `employeeAdjustments_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAdjustments` ADD CONSTRAINT `employeeAdjustments_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAdjustments` ADD CONSTRAINT `employeeAdjustments_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD CONSTRAINT `payrollItems_payrollRunId_payrollRuns_id_fk` FOREIGN KEY (`payrollRunId`) REFERENCES `payrollRuns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollItems` ADD CONSTRAINT `payrollItems_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_paidFromAccountId_companyAccounts_id_fk` FOREIGN KEY (`paidFromAccountId`) REFERENCES `companyAccounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_approvedByUserId_users_id_fk` FOREIGN KEY (`approvedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payrollRuns` ADD CONSTRAINT `payrollRuns_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `employee_adjustments_tenant_employee_idx` ON `employeeAdjustments` (`tenantId`,`employeeId`);--> statement-breakpoint
CREATE INDEX `employee_adjustments_tenant_status_idx` ON `employeeAdjustments` (`tenantId`,`status`);--> statement-breakpoint
CREATE INDEX `payroll_runs_tenant_status_idx` ON `payrollRuns` (`tenantId`,`status`);